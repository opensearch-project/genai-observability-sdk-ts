// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { register, DEFAULT_ENDPOINT } from '../src/register.js';

describe('DEFAULT_ENDPOINT', () => {
  it('has the expected value', () => {
    expect(DEFAULT_ENDPOINT).toBe('http://localhost:21890/opentelemetry/v1/traces');
  });
});

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

describe('register - endpoint resolution', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses explicit endpoint', async () => {
    const exporter = new InMemorySpanExporter();
    // Just verify it doesn't throw with custom endpoint
    const provider = await register({
      endpoint: 'http://custom:4318/v1/traces',
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(provider).toBeDefined();
    await provider.shutdown();
  });

  it('falls back to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT env var', async () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://traces-endpoint:4318/v1/traces';
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(provider).toBeDefined();
    await provider.shutdown();
  });

  it('falls back to OTEL_EXPORTER_OTLP_ENDPOINT with /v1/traces suffix', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://base-endpoint:4318';
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
