// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveCompression, resolveHeaders, resolveTimeoutMillis } from '../src/otlp-env.js';

const KEYS = [
  'OTEL_EXPORTER_OTLP_COMPRESSION',
  'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION',
  'OTEL_EXPORTER_OTLP_LOGS_COMPRESSION',
  'OTEL_EXPORTER_OTLP_TIMEOUT',
  'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT',
  'OTEL_EXPORTER_OTLP_LOGS_TIMEOUT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
];

describe('OTLP env settings', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of KEYS) delete process.env[key];
  });
  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('compression: option, then per-signal env, then general env, then none', () => {
    expect(resolveCompression('traces')).toBe('none');
    process.env.OTEL_EXPORTER_OTLP_COMPRESSION = 'gzip';
    expect(resolveCompression('traces')).toBe('gzip');
    process.env.OTEL_EXPORTER_OTLP_LOGS_COMPRESSION = 'none';
    expect(resolveCompression('logs')).toBe('none');
    expect(resolveCompression('traces')).toBe('gzip');
    expect(resolveCompression('traces', 'none')).toBe('none');
    expect(resolveCompression('logs', 'gzip')).toBe('gzip');
  });

  it('compression: an invalid option throws, an invalid env value warns and is ignored', () => {
    expect(() => resolveCompression('traces', 'br')).toThrow(/"none" or "gzip"/);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION = 'deflate';
    expect(resolveCompression('traces')).toBe('none');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OTEL_EXPORTER_OTLP_TRACES_COMPRESSION="deflate"'));
  });

  it('timeout: option, then per-signal env, then general env, then 10000', () => {
    expect(resolveTimeoutMillis('logs')).toBe(10000);
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '3000';
    process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = '2000';
    expect(resolveTimeoutMillis('logs')).toBe(3000);
    expect(resolveTimeoutMillis('traces')).toBe(2000);
    expect(resolveTimeoutMillis('traces', 500)).toBe(500);
    expect(() => resolveTimeoutMillis('traces', 0)).toThrow(/positive/);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT = 'soon';
    expect(resolveTimeoutMillis('logs')).toBe(10000);
    expect(warn).toHaveBeenCalled();
  });

  it('headers: general env, then per-signal env, then code, per key', () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-tenant=env,x-scope=all%20signals, bad ,=nokey';
    process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'x-tenant=logs-env';
    expect(resolveHeaders('traces')).toEqual({ 'x-tenant': 'env', 'x-scope': 'all signals' });
    expect(resolveHeaders('logs', { 'x-code': '1' })).toEqual({
      'x-tenant': 'logs-env',
      'x-scope': 'all signals',
      'x-code': '1',
    });
    expect(resolveHeaders('logs', { 'x-tenant': 'code' })['x-tenant']).toBe('code');
  });
});
