// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { createRequire } from 'module';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';

/** Inline ExportResultCode to avoid depending on @opentelemetry/core directly. */
const ExportResultCode = { SUCCESS: 0, FAILED: 1 } as const;
type ExportResult =
  | { code: typeof ExportResultCode.SUCCESS }
  | { code: typeof ExportResultCode.FAILED; error?: Error };

interface SigV4Options {
  endpoint: string;
  service?: string;
  region?: string;
}

function resolveRegion(region?: string): string {
  const resolved =
    region ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? '';
  if (!resolved) {
    throw new Error(
      "No AWS region found. Set via 'region' parameter, " +
        'AWS_DEFAULT_REGION, or AWS_REGION environment variable.',
    );
  }
  return resolved;
}

/** Content type of every OTLP/HTTP request the SDK sends: binary protobuf. */
export const OTLP_PROTOBUF_CONTENT_TYPE = 'application/x-protobuf';

/**
 * POST an OTLP protobuf body to `endpoint`, signed with AWS SigV4. The
 * signature covers exactly the bytes sent.
 */
async function signAndPost(
  endpoint: string,
  service: string,
  region: string,
  serialized: Uint8Array,
): Promise<void> {
  const body = Buffer.from(serialized);
  const url = new URL(endpoint);

  const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
  const credentials = await fromNodeProviderChain()();

  const aws4Module = await import('aws4');
  const aws4 = aws4Module.default ?? aws4Module;
  const signed = aws4.sign(
    {
      service,
      region,
      method: 'POST',
      path: url.pathname + url.search,
      host: url.host,
      headers: {
        'Content-Type': OTLP_PROTOBUF_CONTENT_TYPE,
        Host: url.host,
      },
      body,
    },
    {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  );

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body,
  });

  if (!response.ok) {
    throw new Error(`Export failed: ${response.status} ${response.statusText}`);
  }
}

function toCallback(
  promise: Promise<void>,
  resultCallback: (result: ExportResult) => void,
  pending: Set<Promise<void>>,
): void {
  const tracked = promise.then(
    () => resultCallback({ code: ExportResultCode.SUCCESS }),
    (error: unknown) =>
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
  );
  pending.add(tracked);
  void tracked.finally(() => pending.delete(tracked));
}

/** Wait for in-flight exports (used by forceFlush and shutdown). */
async function drain(pending: Set<Promise<void>>): Promise<void> {
  await Promise.all(Array.from(pending));
}

/**
 * An OTLP/HTTP trace exporter that signs requests with AWS SigV4. Sends
 * binary protobuf (`application/x-protobuf`), so trace and span ids arrive as
 * raw bytes, to an AWS endpoint (for example an OSIS pipeline).
 */
export class AWSSigV4OTLPExporter implements SpanExporter {
  private _endpoint: string;
  private _service: string;
  private _region: string;
  private _pending = new Set<Promise<void>>();

  constructor(options: SigV4Options) {
    this._endpoint = options.endpoint;
    this._service = options.service ?? 'osis';
    this._region = resolveRegion(options.region);
  }

  get endpoint(): string {
    return this._endpoint;
  }

  get service(): string {
    return this._service;
  }

  get region(): string {
    return this._region;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    toCallback(this._export(spans), resultCallback, this._pending);
  }

  async shutdown(): Promise<void> {
    await drain(this._pending);
  }

  async forceFlush(): Promise<void> {
    await drain(this._pending);
  }

  private async _export(spans: ReadableSpan[]): Promise<void> {
    const serialized = loadTraceSerializer().serializeRequest(spans);
    if (!serialized) {
      throw new Error('Failed to serialize spans');
    }
    await signAndPost(this._endpoint, this._service, this._region, serialized);
  }
}

interface Serializer<T> {
  serializeRequest(items: T[]): Uint8Array | undefined;
}
type LogsSerializer = Serializer<ReadableLogRecord>;

/**
 * Load a serializer from the otlp-transformer that `exporterPackage` depends
 * on. Traces and logs are on different OTel JS lines with their own
 * otlp-transformer (the traces one does not serialize LogRecord.eventName),
 * so resolve relative to the matching protobuf exporter.
 */
function loadSerializer<T>(exporterPackage: string, name: string): Serializer<T> {
  const localRequire = createRequire(import.meta.url);
  const exporterPath = localRequire.resolve(exporterPackage);
  const transformer = createRequire(exporterPath)('@opentelemetry/otlp-transformer') as Record<
    string,
    Serializer<T>
  >;
  return transformer[name];
}

let traceSerializer: Serializer<ReadableSpan> | undefined;
let logsSerializer: LogsSerializer | undefined;

/** ProtobufTraceSerializer of @opentelemetry/exporter-trace-otlp-proto. */
function loadTraceSerializer(): Serializer<ReadableSpan> {
  traceSerializer ??= loadSerializer<ReadableSpan>('@opentelemetry/exporter-trace-otlp-proto', 'ProtobufTraceSerializer');
  return traceSerializer;
}

/** ProtobufLogsSerializer of @opentelemetry/exporter-logs-otlp-proto. */
function loadLogsSerializer(): LogsSerializer {
  logsSerializer ??= loadSerializer<ReadableLogRecord>('@opentelemetry/exporter-logs-otlp-proto', 'ProtobufLogsSerializer');
  return logsSerializer;
}

/** Attributes that OTel semconv types as double. */
const DOUBLE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "gen_ai.evaluation.score.value",
  "opensearch.gen_ai.evaluation.score.min",
  "opensearch.gen_ai.evaluation.score.max",
  "opensearch.gen_ai.evaluation.score.threshold",
]);

// Minimal protobuf reading and writing, enough to rewrite attribute values of
// an ExportLogsServiceRequest. Field numbers from opentelemetry-proto:
//   ExportLogsServiceRequest.resource_logs = 1, ResourceLogs.scope_logs = 2,
//   ScopeLogs.log_records = 2, LogRecord.attributes = 6,
//   KeyValue.key = 1, KeyValue.value = 2,
//   AnyValue.int_value = 3 (varint), AnyValue.double_value = 4 (fixed64).

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

interface Field {
  field: number;
  wire: number;
  /** Start of the tag. */
  start: number;
  /** End of the field. */
  end: number;
  /** Payload of a length-delimited field, or the varint value. */
  payloadStart: number;
  varint?: bigint;
}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated protobuf varint');
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
}

function writeVarint(value: bigint): number[] {
  const out: number[] = [];
  let v = BigInt.asUintN(64, value);
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

function fieldsOf(buf: Uint8Array): Field[] {
  const fields: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    const [tag, afterTag] = readVarint(buf, pos);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    pos = afterTag;
    if (wire === WIRE_VARINT) {
      const [value, next] = readVarint(buf, pos);
      fields.push({ field, wire, start, end: next, payloadStart: pos, varint: value });
      pos = next;
    } else if (wire === WIRE_FIXED64 || wire === WIRE_FIXED32) {
      const end = pos + (wire === WIRE_FIXED64 ? 8 : 4);
      fields.push({ field, wire, start, end, payloadStart: pos });
      pos = end;
    } else if (wire === WIRE_LEN) {
      const [length, payloadStart] = readVarint(buf, pos);
      const end = payloadStart + Number(length);
      fields.push({ field, wire, start, end, payloadStart });
      pos = end;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
    if (pos > buf.length) throw new Error('truncated protobuf message');
  }
  return fields;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Rewrite the length-delimited fields numbered `field` of a message with
 * `child`, copying every other byte as is. Returns `buf` itself when nothing
 * changed.
 */
function rewriteChildren(
  buf: Uint8Array,
  field: number,
  child: (payload: Uint8Array) => Uint8Array,
): Uint8Array {
  let changed = false;
  const parts: Uint8Array[] = [];
  for (const f of fieldsOf(buf)) {
    if (f.field !== field || f.wire !== WIRE_LEN) {
      parts.push(buf.subarray(f.start, f.end));
      continue;
    }
    const payload = buf.subarray(f.payloadStart, f.end);
    const rewritten = child(payload);
    if (rewritten === payload) {
      parts.push(buf.subarray(f.start, f.end));
      continue;
    }
    changed = true;
    parts.push(
      new Uint8Array([...writeVarint(BigInt((field << 3) | WIRE_LEN)), ...writeVarint(BigInt(rewritten.length))]),
      rewritten,
    );
  }
  return changed ? concat(parts) : buf;
}

/** AnyValue with int_value -> the same value as double_value. */
function intToDouble(anyValue: Uint8Array): Uint8Array {
  const fields = fieldsOf(anyValue);
  const int = fields.find(f => f.field === 3 && f.wire === WIRE_VARINT);
  if (!int || fields.length !== 1) return anyValue;
  const out = new Uint8Array(9);
  out[0] = (4 << 3) | WIRE_FIXED64;
  new DataView(out.buffer).setFloat64(1, Number(BigInt.asIntN(64, int.varint!)), true);
  return out;
}

function rewriteKeyValue(kv: Uint8Array): Uint8Array {
  const keyField = fieldsOf(kv).find(f => f.field === 1 && f.wire === WIRE_LEN);
  if (!keyField) return kv;
  const key = Buffer.from(kv.subarray(keyField.payloadStart, keyField.end)).toString('utf8');
  if (!DOUBLE_ATTRIBUTES.has(key)) return kv;
  return rewriteChildren(kv, 2, intToDouble);
}

/**
 * Re-encode whole-number values of double-typed attributes (for example
 * `gen_ai.evaluation.score.value`) in a protobuf ExportLogsServiceRequest as
 * `double_value`. OTel JS encodes any integral JS number as `int_value`, and
 * the logs API has no way to ask for a double, so a score of `1` would
 * otherwise arrive as an int64. Every other byte is copied as is.
 */
export function forceDoubleAttributes(serialized: Uint8Array): Uint8Array {
  return rewriteChildren(serialized, 1, (resourceLogs) =>
    rewriteChildren(resourceLogs, 2, (scopeLogs) =>
      rewriteChildren(scopeLogs, 2, (logRecord) => rewriteChildren(logRecord, 6, rewriteKeyValue)),
    ),
  );
}

function doubleAttributesSerializer(base: LogsSerializer): LogsSerializer {
  return {
    serializeRequest(logs: ReadableLogRecord[]): Uint8Array | undefined {
      const serialized = base.serializeRequest(logs);
      return serialized ? forceDoubleAttributes(serialized) : serialized;
    },
  };
}

/**
 * Make an `@opentelemetry/exporter-logs-otlp-proto` OTLPLogExporter send
 * double-typed attributes (for example `gen_ai.evaluation.score.value`) as
 * `double_value` even when the value is a whole number. Wraps the exporter's
 * protobuf serializer; returns false (and changes nothing) when the exporter
 * does not have the expected internals.
 */
export function sendScoresAsDouble(exporter: unknown): boolean {
  const delegate = (exporter as { _delegate?: { _serializer?: LogsSerializer & { deserializeResponse?: unknown } } })
    ?._delegate;
  const serializer = delegate?._serializer;
  if (!delegate || typeof serializer?.serializeRequest !== "function") return false;
  delegate._serializer = { ...serializer, ...doubleAttributesSerializer(serializer) };
  return true;
}

/**
 * An OTLP/HTTP log exporter that signs requests with AWS SigV4. Sends binary
 * protobuf (`application/x-protobuf`), with whole-number scores as
 * `double_value`. Used for `gen_ai.evaluation.result` events sent to an AWS
 * endpoint (for example an OSIS logs pipeline).
 */
export class AWSSigV4OTLPLogExporter implements LogRecordExporter {
  private _endpoint: string;
  private _service: string;
  private _region: string;
  private _pending = new Set<Promise<void>>();

  constructor(options: SigV4Options) {
    this._endpoint = options.endpoint;
    this._service = options.service ?? 'osis';
    this._region = resolveRegion(options.region);
  }

  get endpoint(): string {
    return this._endpoint;
  }

  export(
    logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    toCallback(this._export(logs), resultCallback, this._pending);
  }

  async shutdown(): Promise<void> {
    await drain(this._pending);
  }

  async forceFlush(): Promise<void> {
    await drain(this._pending);
  }

  private async _export(logs: ReadableLogRecord[]): Promise<void> {
    const serialized = doubleAttributesSerializer(loadLogsSerializer()).serializeRequest(logs);
    if (!serialized) {
      throw new Error('Failed to serialize log records');
    }
    await signAndPost(this._endpoint, this._service, this._region, serialized);
  }
}
