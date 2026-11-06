// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { logs } from '@opentelemetry/api-logs';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  InMemoryLogRecordExporter,
} from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPLogExporter as GrpcLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPTraceExporter as HttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPTraceExporter as GrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import {
  register,
  createLogExporter,
  createSpanExporter,
  resolveSignalEndpoint,
  grpcMetadata,
  resetRegisterWarnings,
  DEFAULT_BASE_ENDPOINT,
  DEFAULT_GRPC_ENDPOINT,
  DEFAULT_ENDPOINT,
  DEFAULT_LOGS_ENDPOINT,
} from '../src/register.js';
import { score } from '../src/score.js';
import { getSdkLoggerProvider, setSdkLoggerProvider } from '../src/logs.js';
import { AWSSigV4OTLPExporter, AWSSigV4OTLPLogExporter } from '../src/exporters.js';
import { createRequire } from 'module';

// Independent OTLP decoder (as in exporters.test.ts): the protobufjs root of the otlp-transformer.
const otlpRoot = createRequire(createRequire(import.meta.url).resolve('@opentelemetry/exporter-trace-otlp-proto'))(
  '@opentelemetry/otlp-transformer/build/src/generated/root',
) as {
  opentelemetry: { proto: { collector: { logs: { v1: { ExportLogsServiceRequest: {
    decode(buf: Uint8Array): unknown;
    toObject(msg: unknown, opts: Record<string, unknown>): Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  } } } } } };
};
const decodeLogs = (body: Uint8Array) => {
  const type = otlpRoot.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest;
  return type.toObject(type.decode(body), { longs: Number, bytes: String, defaults: false });
};

describe('default endpoints', () => {
  it('are the OTel standard localhost:4318 (HTTP) and localhost:4317 (gRPC)', () => {
    expect(DEFAULT_BASE_ENDPOINT).toBe('http://localhost:4318');
    expect(DEFAULT_ENDPOINT).toBe('http://localhost:4318/v1/traces');
    expect(DEFAULT_LOGS_ENDPOINT).toBe('http://localhost:4318/v1/logs');
    expect(DEFAULT_GRPC_ENDPOINT).toBe('http://localhost:4317');
  });
});

const OTLP_ENV = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_COMPRESSION',
  'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION',
  'OTEL_EXPORTER_OTLP_LOGS_COMPRESSION',
  'OTEL_EXPORTER_OTLP_TIMEOUT',
  'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT',
  'OTEL_EXPORTER_OTLP_LOGS_TIMEOUT',
];

/** Transport parameters of an OTel JS exporter (HTTP: wrapped once more than gRPC). */
function transportParams(exporter: unknown): Record<string, unknown> {
  const t = (exporter as { _delegate: { _transport: Record<string, any> } })._delegate._transport; // eslint-disable-line @typescript-eslint/no-explicit-any
  return t._transport?._parameters ?? t._parameters;
}

describe('register', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_SERVICE_VERSION;
    delete process.env.OPENSEARCH_PROJECT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns a BasicTracerProvider', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(provider).toBeDefined();
    expect(typeof provider.getTracer).toBe('function');
    await provider.shutdown();
  });

  it('uses custom exporter', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      exporter,
      batch: false,
      setGlobal: false,
      autoInstrument: false,
    });

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span');
    span.end();

    // Force flush to ensure spans are exported
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect(spans[0].name).toBe('test-span');
    await provider.shutdown();
  });

  it('sets service name from options', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      serviceName: 'my-service',
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test');
    span.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(1);
    const resource = spans[0].resource;
    expect(resource.attributes['service.name']).toBe('my-service');
    await provider.shutdown();
  });

  it('falls back to projectName for service name', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      projectName: 'my-project',
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test');
    span.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const resource = spans[0].resource;
    expect(resource.attributes['service.name']).toBe('my-project');
    await provider.shutdown();
  });

  it('sets service version from options', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      serviceName: 'svc',
      serviceVersion: '1.2.3',
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test');
    span.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const resource = spans[0].resource;
    expect(resource.attributes['service.version']).toBe('1.2.3');
    await provider.shutdown();
  });

  it('uses SimpleSpanProcessor when batch=false', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      exporter,
      batch: false,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(provider).toBeDefined();
    await provider.shutdown();
  });

  it('uses BatchSpanProcessor by default', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(provider).toBeDefined();
    await provider.shutdown();
  });
});

describe('resolveSignalEndpoint', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of OTLP_ENV) delete process.env[key];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses http://localhost:4318 for both signals when nothing is configured', () => {
    expect(resolveSignalEndpoint('traces', {})).toEqual({ url: 'http://localhost:4318/v1/traces', protocol: 'http' });
    expect(resolveSignalEndpoint('logs', {})).toEqual({ url: 'http://localhost:4318/v1/logs', protocol: 'http' });
  });

  it('uses http://localhost:4317 as-is when nothing is configured and the protocol is gRPC', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    expect(resolveSignalEndpoint('traces', {})).toEqual({ url: 'http://localhost:4317', protocol: 'grpc' });
    expect(resolveSignalEndpoint('logs', { protocol: 'grpc' })).toEqual({ url: 'http://localhost:4317', protocol: 'grpc' });
  });

  it('a base URL with a pipeline path gets /v1/<signal> appended (one OSIS or Data Prepper otlp source)', () => {
    const options = { endpoint: 'https://pipe.example.com/my-pipeline/' };
    expect(resolveSignalEndpoint('traces', options).url).toBe('https://pipe.example.com/my-pipeline/v1/traces');
    expect(resolveSignalEndpoint('logs', options).url).toBe('https://pipe.example.com/my-pipeline/v1/logs');
  });

  it.each([
    ['http://c:4318/v1/traces', 'traces'],
    ['http://c:4318/v1/traces/', 'traces'],
    ['https://gw/pipe/v1/logs', 'logs'],
    ['http://c:4318/v1/traces?x=1', 'traces'],
    ['grpc://c:4317/v1/traces', 'traces'],
  ])('endpoint %s throws with a migration message', (endpoint, signal) => {
    for (const s of ['traces', 'logs'] as const) {
      expect(() => resolveSignalEndpoint(s, { endpoint })).toThrow(
        `endpoint is the OTLP base URL (e.g. http://host:4318). Remove '/v1/${signal}', or pass tracesEndpoint and logsEndpoint.`,
      );
    }
  });

  it('OTEL_EXPORTER_OTLP_ENDPOINT ending in /v1/traces throws too', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://env:4318/v1/traces';
    expect(() => resolveSignalEndpoint('traces', {})).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT .*Remove '\/v1\/traces'/);
  });

  it('a path that ends in traces without /v1, or has /v1/traces in the middle, is a base URL', () => {
    expect(resolveSignalEndpoint('logs', { endpoint: 'https://gw/otlp/traces' }).url).toBe('https://gw/otlp/traces/v1/logs');
    expect(resolveSignalEndpoint('logs', { endpoint: 'https://gw/v1/traces/x' }).url).toBe('https://gw/v1/traces/x/v1/logs');
  });

  it('endpoint is the base for all signals over HTTP', () => {
    const options = { endpoint: 'http://collector:4318/' };
    expect(resolveSignalEndpoint('traces', options).url).toBe('http://collector:4318/v1/traces');
    expect(resolveSignalEndpoint('logs', options).url).toBe('http://collector:4318/v1/logs');
  });

  it('OTEL_EXPORTER_OTLP_ENDPOINT is the base when endpoint is not set', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://env-base:4318';
    expect(resolveSignalEndpoint('traces', {}).url).toBe('http://env-base:4318/v1/traces');
    expect(resolveSignalEndpoint('logs', {}).url).toBe('http://env-base:4318/v1/logs');
    expect(resolveSignalEndpoint('logs', { endpoint: 'http://opt:4318' }).url).toBe('http://opt:4318/v1/logs');
  });

  it('per-signal option, then per-signal env var, are full URLs used as-is', () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://env-traces/ingest';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://env-logs/ingest';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://env-base:4318';
    expect(resolveSignalEndpoint('traces', {}).url).toBe('http://env-traces/ingest');
    expect(resolveSignalEndpoint('logs', {}).url).toBe('http://env-logs/ingest');
    const own = { tracesEndpoint: 'http://t/x', logsEndpoint: 'http://l/y' };
    expect(resolveSignalEndpoint('traces', own).url).toBe('http://t/x');
    expect(resolveSignalEndpoint('logs', own).url).toBe('http://l/y');
  });

  it('endpoint beats OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://env-traces/ingest';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://env-logs/ingest';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://env-base:4318';
    const options = { endpoint: 'http://base:4318' };
    expect(resolveSignalEndpoint('traces', options)).toEqual({ url: 'http://base:4318/v1/traces', protocol: 'http' });
    expect(resolveSignalEndpoint('logs', options)).toEqual({ url: 'http://base:4318/v1/logs', protocol: 'http' });
  });

  it('endpoint over gRPC beats the per-signal env vars too', () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://env-traces:4317';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://env-logs:4317';
    const options = { endpoint: 'grpc://base:4317' };
    expect(resolveSignalEndpoint('traces', options)).toEqual({ url: 'http://base:4317', protocol: 'grpc' });
    expect(resolveSignalEndpoint('logs', options)).toEqual({ url: 'http://base:4317', protocol: 'grpc' });
  });

  it('a per-signal env var beats OTEL_EXPORTER_OTLP_ENDPOINT, which beats the default', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://env-base:4318';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://env-logs/ingest';
    expect(resolveSignalEndpoint('traces', {}).url).toBe('http://env-base:4318/v1/traces');
    expect(resolveSignalEndpoint('logs', {}).url).toBe('http://env-logs/ingest');
  });

  it('a per-signal URL for one signal leaves the other on the base', () => {
    const options = { endpoint: 'http://base:4318', logsEndpoint: 'https://logs-pipe/v1/logs' };
    expect(resolveSignalEndpoint('traces', options).url).toBe('http://base:4318/v1/traces');
    expect(resolveSignalEndpoint('logs', options).url).toBe('https://logs-pipe/v1/logs');
  });

  it('uses the base as-is for both signals over gRPC', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4317';
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    expect(resolveSignalEndpoint('traces', {})).toEqual({ url: 'http://collector:4317', protocol: 'grpc' });
    expect(resolveSignalEndpoint('logs', {})).toEqual({ url: 'http://collector:4317', protocol: 'grpc' });
  });

  it('a grpc:// scheme selects gRPC and is mapped to http://', () => {
    expect(resolveSignalEndpoint('logs', { endpoint: 'grpc://collector:4317' })).toEqual({
      url: 'http://collector:4317',
      protocol: 'grpc',
    });
    expect(resolveSignalEndpoint('traces', { endpoint: 'grpcs://collector:4317' })).toEqual({
      url: 'https://collector:4317',
      protocol: 'grpc',
    });
  });

  it('protocol: option, then per-signal env, then general env, then scheme', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/protobuf';
    const options = { endpoint: 'http://c:4317' };
    expect(resolveSignalEndpoint('traces', options).protocol).toBe('grpc');
    expect(resolveSignalEndpoint('logs', options)).toEqual({ url: 'http://c:4317/v1/logs', protocol: 'http' });
    expect(resolveSignalEndpoint('logs', { ...options, protocol: 'grpc' }).protocol).toBe('grpc');
  });

  it('a grpc:// scheme passed in code beats the protocol env vars', () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/protobuf';
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
    const options = { endpoint: 'grpc://c:4317' };
    expect(resolveSignalEndpoint('traces', options).protocol).toBe('grpc');
    expect(resolveSignalEndpoint('logs', options)).toEqual({ url: 'http://c:4317', protocol: 'grpc' });
    expect(resolveSignalEndpoint('logs', { logsEndpoint: 'grpc://l:4317' }).protocol).toBe('grpc');
    // The protocol option still wins over the scheme.
    expect(resolveSignalEndpoint('logs', { ...options, protocol: 'http' })).toEqual({
      url: 'http://c:4317/v1/logs',
      protocol: 'http',
    });
  });

  it('a grpc:// scheme from an env var does not beat the protocol env vars', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'grpc://c:4317';
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/protobuf';
    expect(resolveSignalEndpoint('traces', {}).protocol).toBe('grpc');
    expect(resolveSignalEndpoint('logs', {})).toEqual({ url: 'http://c:4317/v1/logs', protocol: 'http' });
  });

  it('warns on an unknown protocol value and falls through', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'carrier-pigeon';
    expect(resolveSignalEndpoint('traces', {}).protocol).toBe('http');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/OTEL_EXPORTER_OTLP_TRACES_PROTOCOL/));
    warnSpy.mockRestore();
  });

});

describe('register - exporters', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of OTLP_ENV) delete process.env[key];
  });

  afterEach(() => {
    process.env = originalEnv;
    logs.disable();
    setSdkLoggerProvider(undefined);
  });

  it('builds OTLP/HTTP exporters by default', async () => {
    expect(await createSpanExporter({})).toBeInstanceOf(HttpTraceExporter);
    expect(await createLogExporter({})).toBeInstanceOf(OTLPLogExporter);
  });

  it('builds gRPC exporters for both signals over gRPC', async () => {
    const options = { endpoint: 'http://c:4317', protocol: 'grpc' as const };
    const spans = await createSpanExporter(options);
    const logExporter = await createLogExporter(options);
    expect(spans).toBeInstanceOf(GrpcTraceExporter);
    expect(logExporter).toBeInstanceOf(GrpcLogExporter);
    await spans.shutdown();
    await logExporter.shutdown();
  });

  it('the gRPC and custom OTLP log exporters send whole-number scores as doubleValue', async () => {
    const memory = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: memory })] });
    provider.getLogger('judge').emit({
      eventName: 'gen_ai.evaluation.result',
      attributes: { 'gen_ai.evaluation.name': 'acc', 'gen_ai.evaluation.score.value': 4 },
    });
    const scoreOf = (exporter: unknown) => {
      const body = (exporter as { _delegate: { _serializer: { serializeRequest(l: unknown[]): Uint8Array } } })
        ._delegate._serializer.serializeRequest(memory.getFinishedLogRecords());
      const record = decodeLogs(body).resourceLogs[0].scopeLogs[0].logRecords[0];
      return record.attributes.find((a: { key: string }) => a.key === 'gen_ai.evaluation.score.value').value;
    };
    const grpc = await createLogExporter({ endpoint: 'grpc://c:4317' });
    expect(grpc).toBeInstanceOf(GrpcLogExporter);
    expect(scoreOf(grpc)).toEqual({ doubleValue: 4 });
    const custom = new OTLPLogExporter({ url: 'http://c:4318/v1/logs' });
    expect(await createLogExporter({ logExporter: custom })).toBe(custom);
    expect(scoreOf(custom)).toEqual({ doubleValue: 4 });
    await provider.shutdown();
    await grpc.shutdown();
    await custom.shutdown();
  });

  it('grpcMetadata lowercases header keys and is undefined without headers', async () => {
    expect(await grpcMetadata(undefined)).toBeUndefined();
    expect(await grpcMetadata({})).toBeUndefined();
    const md = await grpcMetadata({ Authorization: 'Basic abc', 'X-Tenant': 't1' });
    expect(md?.getMap()).toEqual({ authorization: 'Basic abc', 'x-tenant': 't1' });
  });

  it('gRPC: sends headers as metadata (lowercased) on both signals', async () => {
    const options = {
      endpoint: 'grpc://c:4317',
      headers: { Authorization: 'Bearer token', 'X-Scope': 'evals' },
    };
    // Metadata the OTel JS gRPC transport sends with each export.
    const sentMetadata = (exporter: unknown) =>
      (
        exporter as { _delegate: { _transport: { _parameters: { metadata: () => { getMap(): unknown } } } } }
      )._delegate._transport._parameters.metadata().getMap();
    const spans = await createSpanExporter(options);
    const logExporter = await createLogExporter(options);
    const expected = { authorization: 'Bearer token', 'x-scope': 'evals' };
    expect(sentMetadata(spans)).toMatchObject(expected);
    expect(sentMetadata(logExporter)).toMatchObject(expected);
    await spans.shutdown();
    await logExporter.shutdown();
  });

  it('gRPC: register() keeps the evaluation logs pipeline', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = await register({
      endpoint: 'grpc://collector:4317',
      setGlobal: false,
      autoInstrument: false,
    });
    expect(getSdkLoggerProvider()).toBeDefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    await provider.shutdown();
  });

  it('sigv4 builds signed exporters for both signals', async () => {
    const options = {
      tracesEndpoint: 'https://traces-pipe.us-east-1.osis.amazonaws.com/v1/traces',
      logsEndpoint: 'https://logs-pipe.us-east-1.osis.amazonaws.com/v1/logs',
      sigv4: { region: 'us-east-1' },
    };
    const spans = await createSpanExporter(options);
    const logExporter = await createLogExporter(options);
    expect(spans).toBeInstanceOf(AWSSigV4OTLPExporter);
    expect((spans as AWSSigV4OTLPExporter).endpoint).toBe(options.tracesEndpoint);
    expect((spans as AWSSigV4OTLPExporter).service).toBe('osis');
    expect(logExporter).toBeInstanceOf(AWSSigV4OTLPLogExporter);
    expect((logExporter as AWSSigV4OTLPLogExporter).endpoint).toBe(options.logsEndpoint);
  });

  it('sigv4 with one base signs both signals at base + /v1/<signal>', async () => {
    const options = { endpoint: 'https://pipe.example.com', sigv4: { service: 'osis', region: 'us-west-2' } };
    expect(((await createSpanExporter(options)) as AWSSigV4OTLPExporter).endpoint).toBe(
      'https://pipe.example.com/v1/traces',
    );
    expect(((await createLogExporter(options)) as AWSSigV4OTLPLogExporter).endpoint).toBe(
      'https://pipe.example.com/v1/logs',
    );
  });

  it('OTLP/HTTP exporters are the protobuf ones (application/x-protobuf)', async () => {
    const spans = await createSpanExporter({});
    const logExporter = await createLogExporter({});
    for (const e of [spans, logExporter]) {
      const headers = await (transportParams(e).headers as () => Record<string, string> | Promise<Record<string, string>>)();
      expect(headers['Content-Type']).toBe('application/x-protobuf');
    }
  });

  it('compression and timeoutMillis reach the OTLP/HTTP, gRPC and SigV4 exporters', async () => {
    const http = { endpoint: 'http://c:4318', compression: 'gzip' as const, timeoutMillis: 1234 };
    const grpc = { endpoint: 'grpc://c:4317', compression: 'gzip' as const, timeoutMillis: 1234 };
    for (const e of [
      await createSpanExporter(http),
      await createLogExporter(http),
      await createSpanExporter(grpc),
      await createLogExporter(grpc),
    ]) {
      expect(transportParams(e).compression).toBe('gzip');
      await e.shutdown();
    }
    const httpParams = transportParams(await createSpanExporter(http));
    expect(httpParams.timeoutMillis).toBe(1234);
    const sigv4 = { endpoint: 'https://pipe.example.com/p', sigv4: { region: 'us-east-1' }, compression: 'gzip' as const };
    expect(((await createSpanExporter(sigv4)) as AWSSigV4OTLPExporter).compression).toBe('gzip');
    expect(((await createLogExporter(sigv4)) as AWSSigV4OTLPLogExporter).compression).toBe('gzip');
  });

  it('compression: code beats OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION, which beats the general one; default none', async () => {
    expect(transportParams(await createSpanExporter({})).compression).toBe('none');
    process.env.OTEL_EXPORTER_OTLP_COMPRESSION = 'gzip';
    process.env.OTEL_EXPORTER_OTLP_LOGS_COMPRESSION = 'none';
    expect(transportParams(await createSpanExporter({})).compression).toBe('gzip');
    expect(transportParams(await createLogExporter({})).compression).toBe('none');
    expect(transportParams(await createSpanExporter({ compression: 'none' })).compression).toBe('none');
    expect(transportParams(await createLogExporter({ compression: 'gzip' })).compression).toBe('gzip');
  });

  it('an invalid compression option throws', async () => {
    await expect(createSpanExporter({ compression: 'br' as never })).rejects.toThrow(/"none" or "gzip"/);
  });

  it('protocol "http/protobuf" means OTLP/HTTP protobuf', () => {
    expect(resolveSignalEndpoint('traces', { protocol: 'http/protobuf' })).toEqual({
      url: 'http://localhost:4318/v1/traces',
      protocol: 'http',
    });
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
    expect(resolveSignalEndpoint('logs', {}).protocol).toBe('http');
  });

  it('protocol "http/json" is rejected, as an option or env value', () => {
    expect(() => resolveSignalEndpoint('traces', { protocol: 'http/json' as never })).toThrow(
      /protocol="http\/json" is not supported.*corrupting/,
    );
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/json';
    expect(() => resolveSignalEndpoint('logs', {})).toThrow(/OTEL_EXPORTER_OTLP_LOGS_PROTOCOL="http\/json"/);
  });

  it('register() rejects protocol "http/json"', async () => {
    await expect(register({ protocol: 'http/json' as never, autoInstrument: false, setGlobal: false })).rejects.toThrow(
      /http\/json/,
    );
  });

  it('an unknown protocol option throws', () => {
    expect(() => resolveSignalEndpoint('traces', { protocol: 'carrier-pigeon' as never })).toThrow(/protocol must be/);
  });

  it('sigv4 over gRPC throws', async () => {
    await expect(
      createLogExporter({ endpoint: 'grpc://c:4317', sigv4: { region: 'us-east-1' } }),
    ).rejects.toThrow(/sigv4 signs OTLP\/HTTP/);
  });

  it('exporter and logExporter are used as given, with no derivation', async () => {
    const spans = new InMemorySpanExporter();
    const logExporter = new InMemoryLogRecordExporter();
    expect(await createSpanExporter({ exporter: spans, sigv4: { region: 'us-east-1' } })).toBe(spans);
    expect(await createLogExporter({ logExporter, sigv4: { region: 'us-east-1' } })).toBe(logExporter);
  });

  it('a custom span exporter does not stop the logs pipeline', async () => {
    const logExporter = await createLogExporter({
      exporter: new InMemorySpanExporter(),
      endpoint: 'http://c:4318',
    });
    expect(logExporter).toBeInstanceOf(OTLPLogExporter);
  });

  it('register() throws on an endpoint ending in /v1/traces, before setting anything up', async () => {
    await expect(
      register({ endpoint: 'http://custom:4318/v1/traces', exporter: new InMemorySpanExporter(), logExporter: new InMemoryLogRecordExporter(), autoInstrument: false }),
    ).rejects.toThrow("endpoint is the OTLP base URL (e.g. http://host:4318). Remove '/v1/traces', or pass tracesEndpoint and logsEndpoint.");
    expect(getSdkLoggerProvider()).toBeUndefined();
  });

  it('tracesEndpoint without logsEndpoint throws', async () => {
    await expect(
      register({ tracesEndpoint: 'http://c:4318/v1/traces', autoInstrument: false }),
    ).rejects.toThrow(/tracesEndpoint was passed without logsEndpoint.*must be passed together/);
  });

  it('logsEndpoint without tracesEndpoint throws', async () => {
    await expect(
      register({ logsEndpoint: 'http://c:4318/v1/logs', endpoint: 'http://c:4318', autoInstrument: false }),
    ).rejects.toThrow(/logsEndpoint was passed without tracesEndpoint/);
  });

  it.each([
    ['tracesEndpoint + logsEndpoint', { tracesEndpoint: 'http://t:21890/v1/traces', logsEndpoint: 'http://l:21892/v1/logs' }],
    ['tracesEndpoint + logExporter', { tracesEndpoint: 'http://t:21890/v1/traces', logExporter: new InMemoryLogRecordExporter() }],
    ['tracesEndpoint + logs: false', { tracesEndpoint: 'http://t:21890/v1/traces', logs: false }],
    ['exporter + logsEndpoint', { exporter: new InMemorySpanExporter(), logsEndpoint: 'http://l:21892/v1/logs' }],
  ])('%s is accepted', async (_name, extra) => {
    const provider = await register({ setGlobal: false, autoInstrument: false, ...extra });
    expect(provider).toBeDefined();
    await provider.shutdown();
  });

  it('separate pipelines: both full URLs are used as-is', async () => {
    const options = { tracesEndpoint: 'http://dp:21890/v1/traces', logsEndpoint: 'http://dp:21892/v1/logs' };
    expect(resolveSignalEndpoint('traces', options).url).toBe('http://dp:21890/v1/traces');
    expect(resolveSignalEndpoint('logs', options).url).toBe('http://dp:21892/v1/logs');
  });

  it('does not warn for a base URL', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = await register({
      endpoint: 'http://collector:4318',
      logExporter: new InMemoryLogRecordExporter(),
      setGlobal: false,
      autoInstrument: false,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    await provider.shutdown();
  });
});

describe('register - custom span exporter without a logs destination', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of OTLP_ENV) delete process.env[key];
    resetRegisterWarnings();
  });

  afterEach(() => {
    process.env = originalEnv;
    logs.disable();
    setSdkLoggerProvider(undefined);
  });

  const NO_LOGS_WARNING = /no logs destination is configured.*pass logsEndpoint or logExporter/;

  it('skips the logs pipeline and warns once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await register({ exporter: new InMemorySpanExporter(), autoInstrument: false });
    expect(getSdkLoggerProvider()).toBeUndefined();
    const second = await register({ exporter: new InMemorySpanExporter(), setGlobal: false, autoInstrument: false });
    expect(getSdkLoggerProvider()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(NO_LOGS_WARNING));
    warnSpy.mockRestore();
    await first.shutdown();
    await second.shutdown();
  });

  it('score() events then go to the global LoggerProvider', async () => {
    const userExporter = new InMemoryLogRecordExporter();
    const userProvider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter: userExporter })],
    });
    logs.setGlobalLoggerProvider(userProvider);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = await register({ exporter: new InMemorySpanExporter(), setGlobal: false, autoInstrument: false });
    expect(getSdkLoggerProvider()).toBeUndefined();
    score({ name: 'x', value: 1 });
    expect(userExporter.getFinishedLogRecords()).toHaveLength(1);
    warnSpy.mockRestore();
    await provider.shutdown();
    await userProvider.shutdown();
  });

  it('drops the LoggerProvider of a previous register()', async () => {
    const earlier = new InMemoryLogRecordExporter();
    await register({ exporter: new InMemorySpanExporter(), logExporter: earlier, batch: false, autoInstrument: false });
    const sdkProvider = getSdkLoggerProvider();
    expect(logs.getLoggerProvider()).toBe(sdkProvider);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = await register({ exporter: new InMemorySpanExporter(), batch: false, autoInstrument: false });
    expect(getSdkLoggerProvider()).toBeUndefined();
    expect(logs.getLoggerProvider()).not.toBe(sdkProvider);
    score({ name: 'x', value: 1 });
    expect(earlier.getFinishedLogRecords()).toHaveLength(0);
    warnSpy.mockRestore();
    await provider.shutdown();
  });

  it.each([
    ['logExporter', { logExporter: new InMemoryLogRecordExporter() }, {}],
    ['logsEndpoint', { logsEndpoint: 'http://c:4318/v1/logs' }, {}],
    ['endpoint', { endpoint: 'http://c:4318' }, {}],
    ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', {}, { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://c:4318/v1/logs' }],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', {}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }],
  ])('keeps the logs pipeline with %s', async (_name, extra, env) => {
    Object.assign(process.env, env);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      setGlobal: false,
      autoInstrument: false,
      ...extra,
    });
    expect(getSdkLoggerProvider()).toBeDefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    await provider.shutdown();
  });

  it('without a custom exporter, keeps the default logs pipeline', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = await register({ setGlobal: false, autoInstrument: false });
    expect(getSdkLoggerProvider()).toBeDefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    await provider.shutdown();
  });
});

describe('register - logs pipeline for evaluation events', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
  });

  afterEach(() => {
    process.env = originalEnv;
    logs.disable();
    setSdkLoggerProvider(undefined);
  });

  it('exports score() events through the configured log exporter', async () => {
    const logExporter = new InMemoryLogRecordExporter();
    const provider = await register({
      serviceName: 'eval-svc',
      exporter: new InMemorySpanExporter(),
      logExporter,
      batch: false,
      setGlobal: false,
      autoInstrument: false,
    });

    score({ name: 'relevance', value: 0.9, traceId: 'abcdef1234567890abcdef1234567890', spanId: '1234567890abcdef' });
    await provider.forceFlush();

    const records = logExporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0].eventName).toBe('gen_ai.evaluation.result');
    expect(records[0].spanContext?.spanId).toBe('1234567890abcdef');
    expect(records[0].resource.attributes['service.name']).toBe('eval-svc');
    await provider.shutdown();
  });

  it('provider.forceFlush() flushes batched log events', async () => {
    const logExporter = new InMemoryLogRecordExporter();
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      logExporter,
      setGlobal: false,
      autoInstrument: false,
    });
    score({ name: 'x', value: 1 });
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
    await provider.forceFlush();
    expect(logExporter.getFinishedLogRecords()).toHaveLength(1);
    await provider.shutdown();
  });

  it('provider.shutdown() also shuts down the logs pipeline', async () => {
    const logExporter = new InMemoryLogRecordExporter();
    const shutdownSpy = vi.spyOn(logExporter, 'shutdown');
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      logExporter,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(getSdkLoggerProvider()).toBeDefined();
    await provider.shutdown();
    expect(shutdownSpy).toHaveBeenCalled();
    expect(getSdkLoggerProvider()).toBeUndefined();
  });

  it('registers the LoggerProvider globally when setGlobal is true', async () => {
    const logExporter = new InMemoryLogRecordExporter();
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      logExporter,
      autoInstrument: false,
    });
    const sdkProvider = getSdkLoggerProvider();
    expect(sdkProvider).toBeDefined();
    expect(logs.getLoggerProvider()).toBe(sdkProvider);
    await provider.shutdown();
    // our global is removed on shutdown so a later register() can install a new one
    expect(logs.getLoggerProvider()).not.toBe(sdkProvider);
  });

  it('does not clobber a user-configured global LoggerProvider', async () => {
    const userExporter = new InMemoryLogRecordExporter();
    const userProvider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter: userExporter })],
    });
    logs.setGlobalLoggerProvider(userProvider);

    const sdkExporter = new InMemoryLogRecordExporter();
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      logExporter: sdkExporter,
      autoInstrument: false,
    });

    expect(logs.getLoggerProvider()).toBe(userProvider);
    expect(getSdkLoggerProvider()).toBeUndefined();
    score({ name: 'x', value: 1 });
    expect(userExporter.getFinishedLogRecords()).toHaveLength(1);
    expect(sdkExporter.getFinishedLogRecords()).toHaveLength(0);
    await provider.shutdown();
    expect(logs.getLoggerProvider()).toBe(userProvider);
    await userProvider.shutdown();
  });

  it('a second register() replaces the SDK LoggerProvider', async () => {
    const first = new InMemoryLogRecordExporter();
    const second = new InMemoryLogRecordExporter();
    await register({ exporter: new InMemorySpanExporter(), logExporter: first, batch: false, autoInstrument: false });
    const provider = await register({ exporter: new InMemorySpanExporter(), logExporter: second, batch: false, autoInstrument: false });
    score({ name: 'x', value: 1 });
    expect(first.getFinishedLogRecords()).toHaveLength(0);
    expect(second.getFinishedLogRecords()).toHaveLength(1);
    await provider.shutdown();
  });

  it('logs: false skips the logs pipeline', async () => {
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      logExporter: new InMemoryLogRecordExporter(),
      logs: false,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(getSdkLoggerProvider()).toBeUndefined();
    await provider.shutdown();
  });
});
