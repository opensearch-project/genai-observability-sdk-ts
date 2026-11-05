// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace, ROOT_CONTEXT, TraceFlags } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
} from '@opentelemetry/sdk-logs';
import { createRequire } from 'module';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import aws4 from 'aws4';
import {
  AWSSigV4OTLPExporter,
  AWSSigV4OTLPLogExporter,
  forceDoubleAttributes,
  sendScoresAsDouble,
  OTLP_PROTOBUF_CONTENT_TYPE,
} from '../src/exporters.js';

// Independent decoder for the tests: the protobufjs root generated in the
// otlp-transformer that @opentelemetry/exporter-trace-otlp-proto uses.
const transformerRequire = createRequire(
  createRequire(import.meta.url).resolve('@opentelemetry/exporter-trace-otlp-proto'),
);
const otlpRoot = transformerRequire('@opentelemetry/otlp-transformer/build/src/generated/root') as {
  opentelemetry: { proto: { collector: Record<'trace' | 'logs', { v1: Record<string, ProtoType> }> } };
};
interface ProtoType {
  decode(buf: Uint8Array): unknown;
  toObject(msg: unknown, opts: Record<string, unknown>): Record<string, unknown>;
}
type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function decode(kind: 'trace' | 'logs', body: Uint8Array): AnyRecord {
  const type = otlpRoot.opentelemetry.proto.collector[kind].v1[
    kind === 'trace' ? 'ExportTraceServiceRequest' : 'ExportLogsServiceRequest'
  ];
  return type.toObject(type.decode(body), { longs: Number, bytes: String, defaults: false });
}
/** protobufjs toObject renders bytes as base64; ids are compared as hex. */
const hex = (b64: string) => Buffer.from(b64, 'base64').toString('hex');
function attrsOf(record: AnyRecord): Record<string, Record<string, unknown>> {
  return Object.fromEntries((record.attributes as AnyRecord[]).map(kv => [kv.key, kv.value]));
}
const TRACE_ID = 'b109337ec7745e8429515abede895c61';
const SPAN_ID = '1234567890abcdef';
const credentialsMock = () =>
  vi.doMock('@aws-sdk/credential-providers', () => ({
    fromNodeProviderChain: () => async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }),
  }));

describe('AWSSigV4OTLPExporter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates exporter with explicit region', () => {
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.us-east-1.osis.amazonaws.com/v1/traces',
      region: 'us-east-1',
    });
    expect(exporter).toBeDefined();
  });

  it('creates exporter with AWS_REGION env var', () => {
    process.env.AWS_REGION = 'eu-west-1';
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.eu-west-1.osis.amazonaws.com/v1/traces',
    });
    expect(exporter).toBeDefined();
  });

  it('creates exporter with AWS_DEFAULT_REGION env var', () => {
    process.env.AWS_DEFAULT_REGION = 'ap-southeast-1';
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.ap-southeast-1.osis.amazonaws.com/v1/traces',
    });
    expect(exporter).toBeDefined();
  });

  it('throws when no region is available', () => {
    expect(
      () =>
        new AWSSigV4OTLPExporter({
          endpoint: 'https://pipeline.osis.amazonaws.com/v1/traces',
        }),
    ).toThrow(/region/i);
  });

  it('uses default service "osis"', () => {
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.osis.amazonaws.com/v1/traces',
      region: 'us-east-1',
    });
    expect(exporter).toBeDefined();
  });

  it('accepts custom service', () => {
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://custom.example.com/v1/traces',
      region: 'us-east-1',
      service: 'custom-service',
    });
    expect(exporter).toBeDefined();
  });

  it('has shutdown and forceFlush methods', async () => {
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.osis.amazonaws.com/v1/traces',
      region: 'us-east-1',
    });
    await exporter.shutdown();
    await exporter.forceFlush();
  });
});

describe('AWSSigV4OTLPLogExporter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requires a region', () => {
    const saved = { d: process.env.AWS_DEFAULT_REGION, r: process.env.AWS_REGION };
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
    expect(() => new AWSSigV4OTLPLogExporter({ endpoint: 'https://x/v1/logs' })).toThrow(/region/i);
    if (saved.d !== undefined) process.env.AWS_DEFAULT_REGION = saved.d;
    if (saved.r !== undefined) process.env.AWS_REGION = saved.r;
  });

  it('signs and posts protobuf logs with the eventName and the hex ids intact', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    credentialsMock();

    const exporter = new AWSSigV4OTLPLogExporter({
      endpoint: 'https://pipe.us-east-1.osis.amazonaws.com/v1/logs',
      region: 'us-east-1',
    });
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    const ctx = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    provider.getLogger('judge', '1.0.0').emit({
      eventName: 'gen_ai.evaluation.result',
      severityNumber: SeverityNumber.INFO,
      attributes: { 'gen_ai.evaluation.name': 'relevance' },
      context: ctx,
    });
    // SimpleLogRecordProcessor does not await exports; the exporter drains them.
    await exporter.forceFlush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://pipe.us-east-1.osis.amazonaws.com/v1/logs');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-protobuf');
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 .*\/us-east-1\/osis\/aws4_request/);
    const raw = init.body as Uint8Array;
    const body = decode('logs', raw);
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(body.resourceLogs[0].scopeLogs[0].scope.name).toBe('judge');
    expect(hex(record.traceId)).toBe(TRACE_ID);
    expect(hex(record.spanId)).toBe(SPAN_ID);
    // LogRecord.event_name is field 12 (tag 0x62); the decoder's schema predates it.
    const name = Buffer.from('gen_ai.evaluation.result');
    expect(Buffer.from(raw).includes(Buffer.concat([Buffer.from([0x62, name.length]), name]))).toBe(true);
    await provider.shutdown();
  });
});

describe('AWSSigV4OTLPExporter over protobuf', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('posts protobuf with the hex ids intact and signs exactly the bytes sent', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    credentialsMock();
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipe.us-east-1.osis.amazonaws.com/my-pipe/v1/traces',
      region: 'us-east-1',
    });
    const provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: TRACE_ID,
      spanId: 'aaaaaaaaaaaaaaaa',
      traceFlags: TraceFlags.SAMPLED,
    });
    provider.getTracer('t').startSpan('invoke_agent a', {}, parent).end();
    await exporter.forceFlush();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe(OTLP_PROTOBUF_CONTENT_TYPE);
    const raw = init.body as Uint8Array;
    const span = decode('trace', raw).resourceSpans[0].scopeSpans[0].spans[0];
    expect(hex(span.traceId)).toBe(TRACE_ID);
    expect(hex(span.parentSpanId)).toBe('aaaaaaaaaaaaaaaa');
    expect(hex(span.spanId)).toMatch(/^[0-9a-f]{16}$/);

    // Re-sign the sent body with the sent date: same signature. A changed body is not.
    const u = new URL(url);
    const resign = (body: Uint8Array) =>
      aws4.sign(
        {
          service: 'osis',
          region: 'us-east-1',
          method: 'POST',
          host: u.host,
          path: u.pathname,
          headers: { 'Content-Type': headers['Content-Type'], Host: u.host, 'X-Amz-Date': headers['X-Amz-Date'] },
          body: Buffer.from(body),
        },
        { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      ).headers!.Authorization;
    expect(resign(raw)).toBe(headers.Authorization);
    expect(resign(new Uint8Array([...raw, 0]))).not.toBe(headers.Authorization);
    await provider.shutdown();
  });
});

describe('double-typed attributes over OTLP protobuf', () => {
  function emitTo(exporter: LogRecordExporter, value: number) {
    const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
    provider.getLogger('judge').emit({
      eventName: 'gen_ai.evaluation.result',
      attributes: {
        'gen_ai.evaluation.name': 'acc',
        'gen_ai.evaluation.score.value': value,
        'opensearch.gen_ai.evaluation.score.threshold': 4,
        'other.count': 3,
      },
      context: trace.setSpanContext(ROOT_CONTEXT, { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }),
    });
    return provider;
  }

  function serializedOf(exporter: OTLPLogExporter) {
    return (exporter as unknown as {
      _delegate: { _serializer: { serializeRequest(l: unknown[]): Uint8Array } };
    })._delegate._serializer;
  }

  function firstRecord(body: Uint8Array) {
    return decode('logs', body).resourceLogs[0].scopeLogs[0].logRecords[0];
  }

  it('the plain protobuf serializer sends whole numbers as intValue', async () => {
    const memory = new InMemoryLogRecordExporter();
    const provider = emitTo(memory, 1);
    const plain = serializedOf(new OTLPLogExporter({ url: 'http://localhost:1/v1/logs' }));
    const attrs = attrsOf(firstRecord(plain.serializeRequest(memory.getFinishedLogRecords())));
    expect(attrs['gen_ai.evaluation.score.value']).toEqual({ intValue: 1 });
    await provider.shutdown();
  });

  it('forceDoubleAttributes re-encodes whole-number score fields only and keeps the rest', async () => {
    const memory = new InMemoryLogRecordExporter();
    const provider = emitTo(memory, -2);
    const plain = serializedOf(new OTLPLogExporter({ url: 'http://localhost:1/v1/logs' }));
    const before = plain.serializeRequest(memory.getFinishedLogRecords());
    const after = forceDoubleAttributes(before);
    const [b, a] = [firstRecord(before), firstRecord(after)];
    expect(attrsOf(a)['gen_ai.evaluation.score.value']).toEqual({ doubleValue: -2 });
    expect(attrsOf(a)['opensearch.gen_ai.evaluation.score.threshold']).toEqual({ doubleValue: 4 });
    expect(attrsOf(a)['other.count']).toEqual({ intValue: 3 });
    expect(attrsOf(a)['gen_ai.evaluation.name']).toEqual({ stringValue: 'acc' });
    expect(hex(a.traceId)).toBe(TRACE_ID);
    expect({ ...a, attributes: undefined }).toEqual({ ...b, attributes: undefined });
    // Nothing to change: the same buffer comes back.
    expect(forceDoubleAttributes(after)).toBe(after);
    await provider.shutdown();
  });

  it('a non-integer score stays a double', async () => {
    const memory = new InMemoryLogRecordExporter();
    const provider = emitTo(memory, 0.5);
    const plain = serializedOf(new OTLPLogExporter({ url: 'http://localhost:1/v1/logs' }));
    const attrs = attrsOf(firstRecord(forceDoubleAttributes(plain.serializeRequest(memory.getFinishedLogRecords()))));
    expect(attrs['gen_ai.evaluation.score.value']).toEqual({ doubleValue: 0.5 });
    await provider.shutdown();
  });

  it('OTLPLogExporter (protobuf) sends a score of 1 as doubleValue after sendScoresAsDouble', async () => {
    const exporter = new OTLPLogExporter({ url: 'http://localhost:1/v1/logs' });
    expect(sendScoresAsDouble(exporter)).toBe(true);
    const memory = new InMemoryLogRecordExporter();
    const provider = emitTo(memory, 1);
    const record = firstRecord(serializedOf(exporter).serializeRequest(memory.getFinishedLogRecords()));
    expect(attrsOf(record)['gen_ai.evaluation.score.value']).toEqual({ doubleValue: 1 });
    expect(attrsOf(record)['other.count']).toEqual({ intValue: 3 });
    expect(hex(record.traceId)).toBe(TRACE_ID);
    expect(hex(record.spanId)).toBe(SPAN_ID);
    await provider.shutdown();
    await exporter.shutdown();
  });

  it('AWSSigV4OTLPLogExporter sends a score of 1 as doubleValue', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    credentialsMock();
    const exporter = new AWSSigV4OTLPLogExporter({
      endpoint: 'https://pipe.us-east-1.osis.amazonaws.com/v1/logs',
      region: 'us-east-1',
    });
    const provider = emitTo(exporter, 1);
    await exporter.forceFlush();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(attrsOf(firstRecord(init.body as Uint8Array))['gen_ai.evaluation.score.value']).toEqual({ doubleValue: 1 });
    await provider.shutdown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
