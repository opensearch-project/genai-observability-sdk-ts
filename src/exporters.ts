// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { createRequire } from 'module';
import { gzipSync } from 'zlib';
import {
  resolveCompression,
  resolveHeaders,
  resolveTimeoutMillis,
  type OtlpCompression,
  type OtlpSignal,
} from './otlp-env.js';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';

/** Inline ExportResultCode to avoid depending on @opentelemetry/core directly. */
const ExportResultCode = { SUCCESS: 0, FAILED: 1 } as const;
type ExportResult =
  | { code: typeof ExportResultCode.SUCCESS }
  | { code: typeof ExportResultCode.FAILED; error?: Error };

/** Options of AWSSigV4OTLPExporter and AWSSigV4OTLPLogExporter. */
export interface SigV4ExporterOptions {
  /** Full OTLP/HTTP URL of the signal, port included, used as-is. */
  endpoint: string;
  /** AWS service name to sign for. Default `"osis"`. */
  service?: string;
  /** AWS region. Default: AWS_DEFAULT_REGION, else AWS_REGION. */
  region?: string;
  /**
   * `"none"` or `"gzip"`. Default: OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION,
   * else OTEL_EXPORTER_OTLP_COMPRESSION, else `"none"`. Must match the
   * pipeline's `compression`. With gzip the body is compressed first, sent
   * with `Content-Encoding: gzip`, and the signature covers the gzip bytes.
   */
  compression?: OtlpCompression;
  /**
   * Extra request headers, merged over OTEL_EXPORTER_OTLP_HEADERS and
   * OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS. They are signed too. Content-Type,
   * Content-Encoding and Host are set by the exporter.
   */
  headers?: Record<string, string>;
  /**
   * Timeout of each request attempt, in milliseconds. Default:
   * OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT, else OTEL_EXPORTER_OTLP_TIMEOUT,
   * else 10000.
   */
  timeoutMillis?: number;
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

/** At most this many attempts per export (the first try plus two retries). */
export const MAX_EXPORT_ATTEMPTS = 3;

/** Backoff between attempts. Mutable for tests only. */
export const RETRY_BACKOFF = { initialMillis: 1000, maxMillis: 5000 };

/** Transient statuses retried with backoff (OTLP/HTTP spec, plus 507). */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function backoffMillis(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_BACKOFF.maxMillis);
  const base = RETRY_BACKOFF.initialMillis * 2 ** (attempt - 1);
  // +/-20% jitter so that shards do not retry in lockstep.
  return Math.min(base * (0.8 + Math.random() * 0.4), RETRY_BACKOFF.maxMillis);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Everything a signed export needs, resolved once per exporter. */
class SignedPost {
  readonly endpoint: string;
  readonly service: string;
  readonly region: string;
  readonly compression: OtlpCompression;
  readonly headers: Record<string, string>;
  readonly timeoutMillis: number;

  constructor(signal: OtlpSignal, options: SigV4ExporterOptions) {
    this.endpoint = options.endpoint;
    this.service = options.service ?? 'osis';
    this.region = resolveRegion(options.region);
    this.compression = resolveCompression(signal, options.compression);
    this.headers = resolveHeaders(signal, options.headers);
    this.timeoutMillis = resolveTimeoutMillis(signal, options.timeoutMillis);
  }

  /**
   * POST an OTLP protobuf body, gzipped first when compression is gzip, and
   * signed with AWS SigV4 over exactly the bytes sent. Retries 408, 429 and
   * 5xx (and network errors or timeouts) with backoff, up to
   * MAX_EXPORT_ATTEMPTS attempts; any other failure is final.
   */
  async send(serialized: Uint8Array): Promise<void> {
    const body = this.compression === 'gzip' ? gzipSync(serialized) : Buffer.from(serialized);
    const url = new URL(this.endpoint);

    const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
    const credentials = await fromNodeProviderChain()();
    const aws4Module = await import('aws4');
    const aws4 = aws4Module.default ?? aws4Module;

    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = { ...withoutReserved(this.headers) };
      headers['Content-Type'] = OTLP_PROTOBUF_CONTENT_TYPE;
      if (this.compression === 'gzip') headers['Content-Encoding'] = 'gzip';
      headers.Host = url.host;
      // Sign each attempt: the signature carries the request time.
      const signed = aws4.sign(
        {
          service: this.service,
          region: this.region,
          method: 'POST',
          path: url.pathname + url.search,
          host: url.host,
          headers,
          body,
        },
        {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
        },
      );

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: 'POST',
          headers: signed.headers as Record<string, string>,
          body,
          signal: AbortSignal.timeout(this.timeoutMillis),
        });
      } catch (error) {
        if (attempt < MAX_EXPORT_ATTEMPTS) {
          await sleep(backoffMillis(attempt, null));
          continue;
        }
        throw error instanceof Error ? error : new Error(String(error));
      }

      if (response.ok) return;
      if (isRetryableStatus(response.status) && attempt < MAX_EXPORT_ATTEMPTS) {
        await sleep(backoffMillis(attempt, response.headers.get('retry-after')));
        continue;
      }
      if (response.status === 413) {
        console.warn(
          `[opensearch-genai-observability-sdk-ts] export to ${this.endpoint} was rejected as too ` +
            `large (413). Raise the pipeline source's max_request_length, or lower the batch size ` +
            `(OTEL_BSP_MAX_EXPORT_BATCH_SIZE for spans).`,
        );
      }
      throw new Error(`Export failed: ${response.status} ${response.statusText}`);
    }
  }
}

const RESERVED_HEADERS = new Set(['content-type', 'content-encoding', 'host', 'content-length', 'authorization']);

/** User headers minus the ones the exporter sets or signing produces. */
function withoutReserved(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !RESERVED_HEADERS.has(key.toLowerCase()) && !/^x-amz-/i.test(key)),
  );
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
  private _post: SignedPost;
  private _pending = new Set<Promise<void>>();

  constructor(options: SigV4ExporterOptions) {
    this._post = new SignedPost('traces', options);
  }

  get endpoint(): string {
    return this._post.endpoint;
  }

  get service(): string {
    return this._post.service;
  }

  get region(): string {
    return this._post.region;
  }

  get compression(): OtlpCompression {
    return this._post.compression;
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
    await this._post.send(serialized);
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
 * Make an OpenTelemetry OTLP log exporter (`@opentelemetry/exporter-logs-otlp-proto`
 * or `@opentelemetry/exporter-logs-otlp-grpc`) send double-typed attributes (for
 * example `gen_ai.evaluation.score.value`) as `double_value` even when the value
 * is a whole number. Wraps the exporter's protobuf serializer; returns false (and
 * changes nothing) when the exporter does not have the expected internals, such as
 * the OTLP/HTTP JSON exporter or a custom exporter. Calling it twice is harmless.
 */
const SCORES_AS_DOUBLE = Symbol.for("opensearch-genai-observability-sdk.scoresAsDouble");

export function sendScoresAsDouble(exporter: unknown): boolean {
  const delegate = (exporter as { _delegate?: { _serializer?: LogsSerializer & { deserializeResponse?: unknown } } })
    ?._delegate;
  const serializer = delegate?._serializer as (LogsSerializer & { [SCORES_AS_DOUBLE]?: true }) | undefined;
  if (!delegate || typeof serializer?.serializeRequest !== "function") return false;
  // Already wrapped (register() and the caller both applied it): keep one wrapper.
  if (serializer[SCORES_AS_DOUBLE]) return true;
  const wrapped: LogsSerializer & { [SCORES_AS_DOUBLE]?: true } = {
    ...serializer,
    ...doubleAttributesSerializer(serializer),
    [SCORES_AS_DOUBLE]: true,
  };
  delegate._serializer = wrapped;
  return true;
}

/**
 * An OTLP/HTTP log exporter that signs requests with AWS SigV4. Sends binary
 * protobuf (`application/x-protobuf`), with whole-number scores as
 * `double_value`. Used for `gen_ai.evaluation.result` events sent to an AWS
 * endpoint (for example an OSIS logs pipeline).
 */
export class AWSSigV4OTLPLogExporter implements LogRecordExporter {
  private _post: SignedPost;
  private _pending = new Set<Promise<void>>();

  constructor(options: SigV4ExporterOptions) {
    this._post = new SignedPost('logs', options);
  }

  get endpoint(): string {
    return this._post.endpoint;
  }

  get compression(): OtlpCompression {
    return this._post.compression;
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
    await this._post.send(serialized);
  }
}
