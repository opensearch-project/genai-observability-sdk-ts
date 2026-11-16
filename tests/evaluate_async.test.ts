// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  type Context,
  type TextMapPropagator,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { evaluate, defineScorer, type EvalScore } from '../src/benchmark.js';
import { observe, withObserve, Op } from '../src/observe.js';
import { getFinishedSpans, getFinishedLogRecords, clearSpans } from './setup.js';

const scoreRecords = () => getFinishedLogRecords().filter(r => r.eventName === 'gen_ai.evaluation.result');
const tick = () => new Promise(resolve => setTimeout(resolve, 1));

/** An async agent: an invoke_agent span with a chat span under it, both after awaits. */
const agent = (question: unknown) =>
  withObserve('travel_agent', { op: Op.INVOKE_AGENT }, async () => {
    await tick();
    await withObserve('model', { op: Op.CHAT }, async () => {
      await tick();
    });
    return `answer: ${String(question)}`;
  });

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearSpans();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  clearSpans();
});

describe('evaluate() with an async task', () => {
  it('returns a Promise, and each case is its own trace with test.* ids on the agent root span', async () => {
    const pending = evaluate({
      name: 'async-suite',
      runId: 'run_async_1',
      // The agent starts only after an await: the case must still own its spans.
      task: async q => {
        await tick();
        return agent(q);
      },
      data: [
        { input: 'Paris', caseId: 'c1' },
        { input: 'Rome', caseId: 'c2' },
      ],
      scores: [function has_answer(_i: unknown, output: unknown) { return String(output).startsWith('answer:'); }],
    });
    expect(pending).toBeInstanceOf(Promise);
    const result = await pending;

    expect(result.cases.map(c => c.output)).toEqual(['answer: Paris', 'answer: Rome']);
    expect(result.cases.map(c => c.status)).toEqual(['pass', 'pass']);

    const spans = getFinishedSpans();
    const roots = spans.filter(s => s.name === 'invoke_agent travel_agent');
    const chats = spans.filter(s => s.name === 'chat model');
    expect(roots).toHaveLength(2);
    expect(new Set(roots.map(s => s.spanContext().traceId)).size).toBe(2);
    expect(roots.map(s => s.attributes['test.case.id'])).toEqual(['c1', 'c2']);
    for (const root of roots) {
      expect(root.attributes['test.suite.name']).toBe('async-suite');
      expect(root.attributes['test.suite.run.id']).toBe('run_async_1');
    }
    // The chat span stays a child in the agent's trace and is not stamped.
    for (const chat of chats) {
      const root = roots.find(r => r.spanContext().traceId === chat.spanContext().traceId);
      expect(root).toBeDefined();
      expect(chat.attributes['test.case.id']).toBeUndefined();
    }
    // Results are parented to each case's root span.
    expect(result.cases.map(c => c.spanId)).toEqual(roots.map(r => r.spanContext().spanId));
    const records = scoreRecords();
    expect(records).toHaveLength(2);
    expect(records.map(r => r.spanContext?.spanId)).toEqual(roots.map(r => r.spanContext().spanId));
  });

  it('a rejected task gives every scorer an error result and does not call the scorers', async () => {
    const scorer = vi.fn(() => 1);
    const result = await evaluate({
      name: 'async-reject',
      task: async () => {
        await tick();
        throw new RangeError('agent crashed');
      },
      data: [{ input: 'q' }],
      scores: [defineScorer({ name: 'quality' }, scorer)],
    });
    expect(scorer).not.toHaveBeenCalled();
    expect(result.cases[0].resultStatus).toBe('error');
    expect(result.cases[0].error).toBe('agent crashed');
    const [record] = scoreRecords();
    expect(record.attributes['gen_ai.evaluation.name']).toBe('quality');
    expect(record.attributes['error.type']).toBe('RangeError');
  });

  it('awaits a Promise returned by a non-async task', async () => {
    const result = await evaluate({
      name: 'promise-task',
      task: (q: unknown) => Promise.resolve(`a:${String(q)}`),
      data: [{ input: 'x' }],
      scores: [],
    });
    expect(result.cases[0].output).toBe('a:x');
    expect(result.cases[0].resultStatus).toBe('pass');
  });

  it('returns a Promise for an observe()-wrapped async task (a plain function)', async () => {
    const task = observe({ op: Op.INVOKE_AGENT }, async (q: unknown) => {
      await tick();
      return q;
    });
    const pending = evaluate({ name: 'observed', task, data: [{ input: 'q' }], scores: [] });
    expect(pending).toBeInstanceOf(Promise);
    expect((await pending).cases[0].output).toBe('q');
  });

  it('with no case run, returns the result directly; await works either way', async () => {
    const result = evaluate({ name: 'empty', task: async (q: unknown) => q, data: [], scores: [] });
    expect(result).not.toBeInstanceOf(Promise);
    expect((await result).summary.totalCases).toBe(0);
  });

  it('throws invalid options synchronously, also for an async task', () => {
    expect(() => evaluate({ name: 'bad', runId: '', task: async (q: unknown) => q, data: [], scores: [] })).toThrow(
      'runId must be a non-empty string',
    );
  });
});

describe('evaluate() with async scorers', () => {
  it('awaits an async LLM judge; its spans are its own trace and not stamped', async () => {
    const judge = defineScorer(
      { name: 'plan_quality', evaluator: 'travel_plan_judge', evaluatorType: 'llm_judge', threshold: 0.5 },
      async (_input, output): Promise<EvalScore> =>
        withObserve('judge', { op: Op.CHAT }, async () => {
          await tick();
          return { name: 'plan_quality', value: String(output).length > 3 ? 0.9 : 0.1, explanation: 'ok' };
        }),
    );
    const pending = evaluate({
      name: 'judge-suite',
      task: (q: unknown) => withObserve('agent', { op: Op.INVOKE_AGENT }, () => `answer: ${String(q)}`),
      data: [{ input: 'q', caseId: 'c1' }],
      scores: [judge],
    });
    expect(pending).toBeInstanceOf(Promise);
    const result = await pending;

    expect(result.cases[0].scores).toEqual({ plan_quality: 0.9 });
    expect(result.cases[0].verdicts).toEqual({ plan_quality: 'pass' });
    const [record] = scoreRecords();
    expect(record.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('travel_plan_judge');
    expect(record.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBe('llm_judge');

    const spans = getFinishedSpans();
    const agentSpan = spans.find(s => s.name === 'invoke_agent agent')!;
    const judgeSpan = spans.find(s => s.name === 'chat judge')!;
    expect(agentSpan.attributes['test.case.id']).toBe('c1');
    expect(judgeSpan.attributes['test.case.id']).toBeUndefined();
    expect(judgeSpan.spanContext().traceId).not.toBe(agentSpan.spanContext().traceId);
    expect(record.spanContext?.spanId).toBe(agentSpan.spanContext().spanId);
  });

  it('runs judges as their own trace, also when evaluate() runs inside a span', async () => {
    const judge = defineScorer({ name: 'q', evaluatorType: 'llm_judge' }, async (): Promise<EvalScore> =>
      withObserve('judge', { op: Op.CHAT }, async (span) => {
        await tick();
        return { name: 'q', value: 1, judgeTraceId: span.spanContext().traceId };
      }),
    );
    const sync = function sync_judge() {
      return withObserve('sync judge', { op: Op.CHAT }, () => 1);
    };
    await withObserve('ci-run', async () =>
      evaluate({ name: 'nested', task: (q: unknown) => q, data: [{ input: 'q' }], scores: [judge, sync] }),
    );
    const spans = getFinishedSpans();
    const ci = spans.find(s => s.name === 'ci-run')!;
    for (const name of ['chat judge', 'chat sync judge']) {
      const judgeSpan = spans.find(s => s.name === name)!;
      expect(judgeSpan.spanContext().traceId).not.toBe(ci.spanContext().traceId);
      expect(judgeSpan.parentSpanId).toBeUndefined();
    }
  });

  it('an async judge that throws becomes an error result', async () => {
    const judge = defineScorer({ name: 'faithfulness', evaluatorType: 'llm_judge' }, async () => {
      await tick();
      throw new TypeError('judge returned malformed JSON');
    });
    const result = await evaluate({ name: 'judge-throws', task: (q: unknown) => q, data: [{ input: 'q' }], scores: [judge] });

    expect(result.cases[0].resultStatus).toBe('error');
    expect(result.cases[0].errorType).toBe('TypeError');
    expect(result.cases[0].scorerErrors).toEqual(['judge returned malformed JSON']);
    const records = scoreRecords();
    expect(records).toHaveLength(1);
    expect(records[0].attributes['gen_ai.evaluation.name']).toBe('faithfulness');
    expect(records[0].attributes['error.type']).toBe('TypeError');
    expect(records[0].attributes['gen_ai.evaluation.score.value']).toBeUndefined();
    // The message stays local.
    expect(JSON.stringify(records[0].attributes)).not.toContain('malformed');
  });

  it('an async scorer resolving to an unusable value is an error result', async () => {
    const result = await evaluate({
      name: 'async-bad-value',
      task: (q: unknown) => q,
      data: [{ input: 'q' }],
      scores: [defineScorer({ name: 'judge' }, (async () => undefined) as never)],
    });
    expect(result.cases[0].resultStatus).toBe('error');
    expect(scoreRecords()[0].attributes['error.type']).toBe('TypeError');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/scorer "judge" returned/));
  });

  it('mixes sync and async scorers and an async task, keeping scorer order', async () => {
    const result = await evaluate({
      name: 'mixed',
      task: async (q: unknown) => {
        await tick();
        return `answer: ${String(q)}`;
      },
      data: [{ input: 'a' }, { input: 'b' }],
      scores: [
        function length(_i: unknown, output: unknown) { return String(output).length; },
        async function judged(_i: unknown, output: unknown) {
          await tick();
          return { name: 'judged', value: 1, label: String(output).endsWith('a') ? 'pass' : 'fail' };
        },
        function exact(_i: unknown, output: unknown, expected: unknown) { return output === expected ? 1 : 0; },
      ],
    });
    expect(result.cases.map(c => c.status)).toEqual(['pass', 'fail']);
    expect(result.cases[0].scores).toEqual({ length: 9, judged: 1, exact: 0 });
    expect(scoreRecords().map(r => r.attributes['gen_ai.evaluation.name'])).toEqual([
      'length', 'judged', 'exact', 'length', 'judged', 'exact',
    ]);
  });
});

describe('evaluate() stays synchronous for sync callers', () => {
  it('returns the result directly when the task and scorers are synchronous', () => {
    const result = evaluate({
      name: 'sync',
      task: (q: unknown) => `answer: ${String(q)}`,
      data: [{ input: 'q' }],
      scores: [function ok() { return true; }],
    });
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.cases[0].status).toBe('pass');
  });
});

describe('evaluate() keeps each case to its own spans with async tasks', () => {
  const stamped = (name: string) =>
    getFinishedSpans().filter(s => s.name === name && s.attributes['test.case.id'] !== undefined);

  it('does not leave a case active after overlapping runs', async () => {
    const slow = async (q: unknown) => {
      await tick();
      return agent(q);
    };
    await Promise.all([
      evaluate({ name: 'A', task: slow, data: [{ input: 'a1' }, { input: 'a2' }], scores: [] }),
      evaluate({ name: 'B', task: slow, data: [{ input: 'b1' }], scores: [] }),
    ]);
    const roots = getFinishedSpans().filter(s => s.name === 'invoke_agent travel_agent');
    expect(roots.map(s => s.attributes['test.suite.name']).sort()).toEqual(['A', 'A', 'B']);

    // A span started after both runs belongs to no case.
    trace.getTracer('later').startSpan('unrelated').end();
    expect(stamped('unrelated')).toHaveLength(0);
  });

  it('keeps the agent trace when a background span starts while the task awaits', async () => {
    let fire!: () => void;
    const fired = new Promise<void>(resolve => (fire = resolve));
    const tracer = trace.getTracer('background');
    // A poller span started before the case: its children have a local parent.
    const poller = tracer.startSpan('poller');
    // Scheduled outside the case, like a poller or another request.
    const timer = setTimeout(() => {
      tracer.startSpan('background').end();
      context.with(trace.setSpan(ROOT_CONTEXT, poller), () => tracer.startSpan('poll').end());
      fire();
    }, 1);
    const result = await evaluate({
      name: 'bg',
      task: async (q: unknown) => {
        await fired; // the background spans start during this await
        return agent(q);
      },
      data: [{ input: 'q', caseId: 'c1' }],
      scores: [],
    });
    clearTimeout(timer);
    poller.end();

    // A parentless span is attached to the only running case (it cannot be told
    // from an agent root started in a fresh context), but the case trace is the
    // root started in the task's context, and a child of a local span is not stamped.
    expect(stamped('background')).toHaveLength(1);
    expect(stamped('poll')).toHaveLength(0);
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent travel_agent')!;
    expect(root.attributes['test.case.id']).toBe('c1');
    expect(result.cases[0].traceId).toBe(root.spanContext().traceId);
  });

  it('without a context manager, stamps a lone run and leaves nothing active after overlapping runs', async () => {
    context.disable();
    try {
      const manual = (q: unknown) => {
        trace.getTracer('manual').startSpan('invoke_agent manual').end();
        return q;
      };
      // One run at a time: the module-level fallback stamps the case's spans.
      await evaluate({ name: 'solo', task: manual, data: [{ input: 's', caseId: 's1' }], scores: [] });
      expect(stamped('invoke_agent manual').map(s => s.attributes['test.case.id'])).toEqual(['s1']);
      clearSpans();

      const slow = async (q: unknown) => {
        await tick();
        return manual(q);
      };
      await Promise.all([
        evaluate({ name: 'A', task: slow, data: [{ input: 'a1' }, { input: 'a2' }], scores: [] }),
        evaluate({ name: 'B', task: slow, data: [{ input: 'b1' }], scores: [] }),
      ]);
      trace.getTracer('later').startSpan('unrelated').end();
      expect(stamped('unrelated')).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('test cases overlap'));
    } finally {
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    }
  });
});

/** Reads a W3C `traceparent` header into a remote span context, like the W3C propagator. */
const traceparentPropagator: TextMapPropagator = {
  inject() {},
  extract(ctx: Context, carrier: unknown) {
    const header = (carrier as Record<string, string>).traceparent;
    const [, traceId, spanId, flags] = header.split('-');
    return trace.setSpanContext(ctx, { traceId, spanId, traceFlags: parseInt(flags, 16), isRemote: true });
  },
  fields: () => ['traceparent'],
};

describe('evaluate() links an agent root started in a fresh context to the only running case', () => {
  const stampedIds = (name: string) =>
    getFinishedSpans()
      .filter(s => s.name === name)
      .map(s => s.attributes['test.case.id']);

  it('stamps a root started under context.with(ROOT_CONTEXT) and takes it as the case trace', async () => {
    const tracer = trace.getTracer('server');
    const result = await evaluate({
      name: 'fresh',
      task: async (q: unknown) => {
        await tick();
        return context.with(ROOT_CONTEXT, () =>
          tracer.startActiveSpan('server', async span => {
            await tick();
            tracer.startSpan('db').end(); // a child of server: not a root
            span.end();
            return q;
          }),
        );
      },
      data: [{ input: 'q', caseId: 'c1' }],
      scores: [() => 1],
    });
    const server = getFinishedSpans().find(s => s.name === 'server')!;
    expect(server.attributes['test.case.id']).toBe('c1');
    expect(stampedIds('db')).toEqual([undefined]);
    expect(result.cases[0].traceId).toBe(server.spanContext().traceId);
    expect(scoreRecords()[0].spanContext?.traceId).toBe(server.spanContext().traceId);
  });

  it('stamps a root whose parent was extracted from incoming headers (a remote parent)', async () => {
    propagation.setGlobalPropagator(traceparentPropagator);
    try {
      const remoteTrace = '4bf92f3577b34da6a3ce929d0e0e4736';
      const headers = { traceparent: `00-${remoteTrace}-00f067aa0ba902b7-01` };
      const result = await evaluate({
        name: 'remote',
        task: async (q: unknown) => {
          await tick();
          const incoming = propagation.extract(ROOT_CONTEXT, headers);
          trace.getTracer('http').startSpan('POST /agent', {}, incoming).end();
          return q;
        },
        data: [{ input: 'q', caseId: 'r1' }],
        scores: [],
      });
      const handler = getFinishedSpans().find(s => s.name === 'POST /agent')!;
      expect(handler.attributes['test.case.id']).toBe('r1');
      expect(result.cases[0].traceId).toBe(remoteTrace);
      expect(result.cases[0].spanId).toBe(handler.spanContext().spanId);
    } finally {
      propagation.disable();
    }
  });

  it('prefers a root started in the task context over one attached as the only running case', async () => {
    const tracer = trace.getTracer('mixed');
    const result = await evaluate({
      name: 'prefer',
      task: async (q: unknown) => {
        context.with(ROOT_CONTEXT, () => tracer.startSpan('library').end());
        return agent(q);
      },
      data: [{ input: 'q', caseId: 'p1' }],
      scores: [],
    });
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent travel_agent')!;
    expect(result.cases[0].traceId).toBe(root.spanContext().traceId);
  });

  it('does not guess with overlapping cases: a fresh-context root is not stamped', async () => {
    const tracer = trace.getTracer('overlap');
    const fresh = async (q: unknown) => {
      await tick();
      context.with(ROOT_CONTEXT, () => tracer.startSpan('detached').end());
      return agent(q);
    };
    const [a, b] = await Promise.all([
      evaluate({ name: 'A', task: fresh, data: [{ input: 'a' }], scores: [] }),
      evaluate({ name: 'B', task: fresh, data: [{ input: 'b' }], scores: [] }),
    ]);
    expect(stampedIds('detached')).toEqual([undefined, undefined]);
    // Each case still has the root it started in its own context.
    const roots = getFinishedSpans().filter(s => s.name === 'invoke_agent travel_agent');
    expect([a.cases[0].traceId, b.cases[0].traceId].sort()).toEqual(roots.map(r => r.spanContext().traceId).sort());
  });
});
