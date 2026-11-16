// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

// No tests/setup.ts here: evaluate() itself must give the task an async context.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { evaluate } from '../src/benchmark.js';
import { withObserve, Op } from '../src/observe.js';
import { TestCaseSpanProcessor } from '../src/testcase.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 1));
const contextManager = () => (context as unknown as { _getContextManager(): unknown })._getContextManager();

function setup(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new TestCaseSpanProcessor());
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();
  return exporter;
}

// Each test starts from no global context manager or tracer provider, in any order.
afterEach(() => {
  context.disable();
  trace.disable();
  vi.restoreAllMocks();
});

describe('evaluate() context manager', () => {
  it('installs one on Node when none is set, so an async agent keeps its span tree', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exporter = setup();
    const result = await evaluate({
      name: 'no-cm',
      task: (q: unknown) =>
        withObserve('agent', { op: Op.INVOKE_AGENT }, async () => {
          await tick();
          await withObserve('model', { op: Op.CHAT }, async () => tick());
          return q;
        }),
      data: [{ input: 'q', caseId: 'c1' }],
      scores: [],
    });
    const spans = exporter.getFinishedSpans();
    const root = spans.find(s => s.name === 'invoke_agent agent')!;
    const chat = spans.find(s => s.name === 'chat model')!;
    expect(chat.parentSpanId).toBe(root.spanContext().spanId);
    expect(root.attributes['test.case.id']).toBe('c1');
    expect(chat.attributes['test.case.id']).toBeUndefined();
    expect(result.cases[0].traceId).toBe(root.spanContext().traceId);
  });

  it('keeps a context manager that is already set', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setup();
    const mine = new AsyncLocalStorageContextManager().enable();
    expect(context.setGlobalContextManager(mine)).toBe(true);
    evaluate({ name: 'mine', task: (q: unknown) => q, data: [{ input: 'q' }], scores: [] });
    expect(contextManager()).toBe(mine);
  });
});
