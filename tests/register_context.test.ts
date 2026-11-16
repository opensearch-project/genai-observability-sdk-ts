// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

// No tests/setup.ts here: this file proves register() alone gives enrich() an active span.
import { describe, it, expect } from 'vitest';
import { context, createContextKey, ROOT_CONTEXT } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { register } from '../src/register.js';
import { withObserve, Op } from '../src/observe.js';
import { enrich } from '../src/enrich.js';

describe('register() context manager', () => {
  it('installs one on Node, so enrich() works across await', async () => {
    const key = createContextKey('probe');
    const probe = ROOT_CONTEXT.setValue(key, 1);
    // Nothing installed yet: the no-op context manager.
    expect(context.with(probe, () => context.active().getValue(key))).toBeUndefined();

    const exporter = new InMemorySpanExporter();
    const provider = await register({ exporter, batch: false, logs: false, autoInstrument: false });
    try {
      await withObserve('judge', { op: Op.CHAT }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        enrich({ model: 'judge-model', systemInstructions: 'You are a strict grader.' });
      });
      const [span] = exporter.getFinishedSpans();
      expect(span.attributes['gen_ai.request.model']).toBe('judge-model');
      expect(span.attributes['gen_ai.system_instructions']).toBe('You are a strict grader.');
    } finally {
      await provider.shutdown();
    }
  });

  it('keeps a context manager that is already set', async () => {
    const before = (context as unknown as { _getContextManager(): unknown })._getContextManager();
    const provider = await register({ exporter: new InMemorySpanExporter(), logs: false, autoInstrument: false });
    expect((context as unknown as { _getContextManager(): unknown })._getContextManager()).toBe(before);
    await provider.shutdown();
  });
});
