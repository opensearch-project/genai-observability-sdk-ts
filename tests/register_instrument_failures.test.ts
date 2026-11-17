// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

// No tests/setup.ts: register() itself sets the globals and the instrumentations.
// Own file: instrumentations are process-wide, so the other register tests do not see these.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, type BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { OpenAIInstrumentation } from '@opentelemetry/instrumentation-openai';
import { register, autoInstrument } from '../src/register.js';

let provider: BasicTracerProvider | undefined;

afterEach(async () => {
  await provider?.shutdown();
  provider = undefined;
  vi.restoreAllMocks();
});

describe('register() instrumentation failures', () => {
  it('resolves when an instrumentation fails to enable, warning once with the package name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(OpenAIInstrumentation.prototype, 'enable').mockImplementation(() => {
      throw new Error('patch failed');
    });
    const exporter = new InMemorySpanExporter();
    provider = await register({ exporter, batch: false, logs: false });
    // The globals are set and usable.
    trace.getTracer('t').startSpan('after').end();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain('after');
    const warnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('instrumentation-openai'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('patch failed');

    // A second register() does not warn again.
    await provider.shutdown();
    provider = await register({ exporter, batch: false, logs: false });
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('instrumentation-openai'))).toHaveLength(1);
  });

  it('autoInstrument() skips one whose setTracerProvider throws and enables the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    provider = await register({ exporter: new InMemorySpanExporter(), logs: false, setGlobal: false, autoInstrument: false });
    const enabled = await autoInstrument(provider, [
      { packageName: new URL('./fixtures/throwing-instrumentation.mjs', import.meta.url).href, exportName: 'Throwing', supported: '*' },
    ]);
    expect(enabled).toEqual([]);
  });
});
