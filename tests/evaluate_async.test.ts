// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { evaluate, defineScorer, type EvalScore } from '../src/benchmark.js';
import { withObserve, Op } from '../src/observe.js';
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

  it('returns a Promise for an async task even with no data', async () => {
    const pending = evaluate({ name: 'empty', task: async (q: unknown) => q, data: [], scores: [] });
    expect(pending).toBeInstanceOf(Promise);
    expect((await pending).summary.totalCases).toBe(0);
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

  it('does not stamp a background span started while the task awaits', async () => {
    let fire!: () => void;
    const fired = new Promise<void>(resolve => (fire = resolve));
    // Scheduled outside the case, like a poller or another request.
    const timer = setTimeout(() => {
      trace.getTracer('background').startSpan('background').end();
      fire();
    }, 1);
    const result = await evaluate({
      name: 'bg',
      task: async (q: unknown) => {
        await fired; // the background span starts during this await
        return agent(q);
      },
      data: [{ input: 'q', caseId: 'c1' }],
      scores: [],
    });
    clearTimeout(timer);

    expect(stamped('background')).toHaveLength(0);
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
