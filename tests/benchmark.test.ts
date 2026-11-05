// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { Benchmark, evaluate, defineScorer, type EvalScore } from '../src/benchmark.js';
import { score } from '../src/score.js';
import { TestCaseSpanProcessor, installTestCaseProcessor } from '../src/testcase.js';
import { getFinishedSpans, getFinishedLogRecords, clearSpans } from './setup.js';

const scoreRecords = () =>
  getFinishedLogRecords().filter(r => r.eventName === 'gen_ai.evaluation.result');

beforeEach(() => clearSpans());
afterEach(() => clearSpans());

describe('Benchmark class', () => {
  it('creates no spans of its own', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('test-suite');
    bm.log({ input: 'q1', output: 'a1', scores: { accuracy: 1 } });
    bm.close();
    expect(getFinishedSpans()).toHaveLength(0);
    logSpy.mockRestore();
  });

  it('has name and runId getters', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('my-bench');
    expect(bm.name).toBe('my-bench');
    expect(typeof bm.runId).toBe('string');
    expect(bm.runId.startsWith('run_')).toBe(true);
    bm.close();
    logSpy.mockRestore();
  });

  it('log emits one score event per score with the suite and case identity', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({
      input: 'q1',
      output: 'a1',
      caseId: 'case_001',
      caseName: 'greeting',
      scores: { accuracy: 0.9, fluency: 0.8 },
    });
    bm.close();

    const records = scoreRecords();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.attributes['test.suite.name']).toBe('suite');
      expect(r.attributes['test.suite.run.id']).toBe(bm.runId);
      expect(r.attributes['test.case.id']).toBe('case_001');
      expect(r.attributes['test.case.name']).toBe('greeting');
    }
    expect(records.map(r => r.attributes['gen_ai.evaluation.name'])).toEqual(['accuracy', 'fluency']);
    expect(records[0].attributes['gen_ai.evaluation.score.value']).toBe(0.9);
    logSpy.mockRestore();
  });

  it('log with traceId only scores at trace level', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: 'q', scores: { accuracy: 1 }, traceId: 'abcdef1234567890abcdef1234567890' });
    bm.close();

    const [record] = scoreRecords();
    expect(record.spanContext?.traceId).toBe('abcdef1234567890abcdef1234567890');
    expect(record.spanContext?.spanId).toBe('');
    expect(record.attributes['opensearch.gen_ai.evaluation.level']).toBe('trace');
    logSpy.mockRestore();
  });

  it('close returns summary with score statistics', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: 'q1', output: 'a1', scores: { accuracy: 0.8 } });
    bm.log({ input: 'q2', output: 'a2', scores: { accuracy: 1.0 } });
    const summary = bm.close();

    expect(summary.benchmarkName).toBe('suite');
    expect(summary.totalCases).toBe(2);
    expect(summary.errorCount).toBe(0);
    expect(summary.scores['accuracy'].avg).toBe(0.9);
    expect(summary.scores['accuracy'].min).toBe(0.8);
    expect(summary.scores['accuracy'].max).toBe(1.0);
    expect(summary.scores['accuracy'].count).toBe(2);
    logSpy.mockRestore();
  });

  it('throws when logging after close', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.close();
    expect(() => bm.log({ input: 'q' })).toThrow('already closed');
    logSpy.mockRestore();
  });

  it('throws when closing twice', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.close();
    expect(() => bm.close()).toThrow('already closed');
    logSpy.mockRestore();
  });

  it('filters reserved keys from metadata', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite', {
      metadata: { 'custom.key': 'val', 'test.suite.name': 'override' },
    });
    bm.log({ input: 'q', scores: { accuracy: 1 } });
    bm.close();

    const [r] = scoreRecords();
    expect(r.attributes['custom.key']).toBe('val');
    expect(r.attributes['test.suite.name']).toBe('suite');
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('auto-generates caseId from input hash', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: { query: 'test' }, scores: { accuracy: 1 } });
    bm.close();

    const caseId = scoreRecords()[0].attributes['test.case.id'] as string;
    expect(caseId.length).toBe(16); // sha256 hex prefix
    logSpy.mockRestore();
  });

  it('uses custom caseId when provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: 'q', caseId: 'my-case-id', scores: { accuracy: 1 } });
    bm.close();

    expect(scoreRecords()[0].attributes['test.case.id']).toBe('my-case-id');
    logSpy.mockRestore();
  });
});

describe('evaluate', () => {
  it('runs task and scorers, returns result', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'eval-test',
      task: (input) => `answer:${input}`,
      data: [
        { input: 'q1', expected: 'answer:q1' },
        { input: 'q2', expected: 'answer:q2' },
      ],
      scores: [
        function accuracy(input, output, expected) {
          return { name: 'accuracy', value: output === expected ? 1.0 : 0.0 };
        },
      ],
    });

    expect(result.summary.benchmarkName).toBe('eval-test');
    expect(result.summary.totalCases).toBe(2);
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0].scores['accuracy']).toBe(1.0);
    expect(result.cases[1].scores['accuracy']).toBe(1.0);
    logSpy.mockRestore();
  });

  it('rejects async task functions with a clear error', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'async-task-test',
      task: async (input) => `answer: ${input}`,
      data: [{ input: 'q1' }],
      scores: [],
    });

    expect(result.cases[0].status).toBe('fail');
    expect(result.cases[0].error).toContain('does not support async task functions');
    expect(result.summary.errorCount).toBe(1);
    logSpy.mockRestore();
  });

  it('handles task errors', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'error-test',
      task: () => { throw new Error('task-failed'); },
      data: [{ input: 'q1' }],
      scores: [],
    });

    expect(result.cases[0].status).toBe('fail');
    expect(result.cases[0].error).toBeDefined();
    expect(result.summary.errorCount).toBe(1);
    logSpy.mockRestore();
  });

  it('handles scorer returning number', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'num-scorer',
      task: (input) => input,
      data: [{ input: 'q1' }],
      scores: [
        function myScore(_i: unknown, _o: unknown, _e: unknown) { return 0.75; },
      ],
    });

    expect(result.cases[0].scores['myScore']).toBe(0.75);
    logSpy.mockRestore();
  });

  it('handles scorer returning array of EvalScore', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'array-scorer',
      task: (input) => input,
      data: [{ input: 'q1' }],
      scores: [
        function (_i: unknown, _o: unknown, _e: unknown) {
          return [
            { name: 'a', value: 0.8 },
            { name: 'b', value: 0.9 },
          ];
        },
      ],
    });

    expect(result.cases[0].scores['a']).toBe(0.8);
    expect(result.cases[0].scores['b']).toBe(0.9);
    logSpy.mockRestore();
  });

  it('records scorer errors', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'scorer-error',
      task: (input) => input,
      data: [{ input: 'q1' }],
      scores: [
        function badScorer() { throw new Error('scorer-boom'); },
      ],
    });

    expect(result.cases[0].scorerErrors!.length).toBeGreaterThan(0);
    logSpy.mockRestore();
  });

  it('emits score log events with label, explanation and suite identity', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'events-test',
      task: (input) => `echo ${input}`,
      data: [{ input: 'hi', caseId: 'c1', caseName: 'hello case' }],
      scores: [
        () => ({ name: 'judge', value: 0.5, label: 'partial', explanation: 'half right', metadata: { 'judge.model': 'm1' } }),
      ],
    });

    const records = scoreRecords();
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.attributes['gen_ai.evaluation.score.label']).toBe('partial');
    expect(r.attributes['gen_ai.evaluation.explanation']).toBe('half right');
    expect(r.attributes['judge.model']).toBe('m1');
    expect(r.attributes['test.suite.name']).toBe('events-test');
    expect(r.attributes['test.suite.run.id']).toBe(result.summary.runId);
    expect(r.attributes['test.case.id']).toBe('c1');
    expect(r.attributes['test.case.name']).toBe('hello case');
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Default shape: test cases as log events (contract section 6)
// ---------------------------------------------------------------------------

const agentTracer = () => trace.getTracer('test-agent');
const eventsNamed = (name: string) => getFinishedLogRecords().filter(r => r.eventName === name);
const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {});

/** Mock agent: a root span with one child, both ended before returning. */
function tracedTask(input: unknown): string {
  return agentTracer().startActiveSpan('invoke_agent mock', root => {
    agentTracer().startActiveSpan('chat mock-model', child => child.end());
    root.end();
    return `answer:${input}`;
  });
}

function exact(_i: unknown, output: unknown, expected: unknown) {
  return { name: 'exact', value: output === expected ? 1 : 0 };
}

describe('evaluate (default: events, no harness spans)', () => {
  it('creates no spans of its own and one trace per case', () => {
    const spy = quiet();
    evaluate({
      name: 'shape',
      task: tracedTask,
      data: [{ input: 'a', expected: 'answer:a' }, { input: 'b', expected: 'answer:b' }],
      scores: [exact],
    });
    const spans = getFinishedSpans();
    const roots = spans.filter(s => s.name === 'invoke_agent mock');
    expect(roots).toHaveLength(2);
    expect(spans).toHaveLength(4);
    expect(roots[0].spanContext().traceId).not.toBe(roots[1].spanContext().traceId);
    for (const r of roots) expect(r.parentSpanId).toBeUndefined();
    spy.mockRestore();
  });

  it('stamps test.* ids on the agent root span only', () => {
    const spy = quiet();
    const result = evaluate({
      name: 'stamp',
      task: tracedTask,
      data: [{ input: 'a', caseId: 'c1', caseName: 'first' }],
      scores: [],
    });
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent mock')!;
    expect(root.attributes['test.suite.name']).toBe('stamp');
    expect(root.attributes['test.suite.run.id']).toBe(result.summary.runId);
    expect(root.attributes['test.case.id']).toBe('c1');
    expect(root.attributes['test.case.name']).toBe('first');
    const child = getFinishedSpans().find(s => s.name === 'chat mock-model')!;
    expect(child.attributes['test.case.id']).toBeUndefined();
    expect(result.cases[0].traceId).toBe(root.spanContext().traceId);
    expect(result.cases[0].spanId).toBe(root.spanContext().spanId);
    spy.mockRestore();
  });

  it('does not adopt the caller active span as parent', () => {
    const spy = quiet();
    agentTracer().startActiveSpan('caller', caller => {
      evaluate({ name: 'iso', task: tracedTask, data: [{ input: 'a' }], scores: [] });
      caller.end();
    });
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent mock')!;
    expect(root.parentSpanId).toBeUndefined();
    spy.mockRestore();
  });

  it('parents score events to the agent root span with test.* copied', () => {
    const spy = quiet();
    const result = evaluate({
      name: 'scores',
      task: tracedTask,
      data: [{ input: 'a', expected: 'answer:a', caseId: 'c1', caseName: 'first' }],
      scores: [exact],
    });
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent mock')!;
    const [r] = eventsNamed('gen_ai.evaluation.result');
    expect(r.spanContext?.traceId).toBe(root.spanContext().traceId);
    expect(r.spanContext?.spanId).toBe(root.spanContext().spanId);
    expect(r.attributes['gen_ai.evaluation.score.value']).toBe(1);
    expect(r.attributes['test.suite.name']).toBe('scores');
    expect(r.attributes['test.suite.run.id']).toBe(result.summary.runId);
    expect(r.attributes['test.case.id']).toBe('c1');
    expect(r.attributes['test.case.name']).toBe('first');
    spy.mockRestore();
  });

  it('stamps run metadata on every evaluation result, with the SDK scope', () => {
    const spy = quiet();
    const result = evaluate({
      name: 'cases',
      task: tracedTask,
      data: [{ input: 'a', expected: 'answer:a', caseId: 'c1', caseName: 'first' }, { input: 'b' }],
      scores: [exact],
      metadata: { 'model.version': 'v1' },
    });
    const events = eventsNamed('gen_ai.evaluation.result');
    expect(events).toHaveLength(2);
    const roots = getFinishedSpans().filter(s => s.name === 'invoke_agent mock');
    const e = events[0];
    expect(e.spanContext?.spanId).toBe(roots[0].spanContext().spanId);
    expect(e.spanContext?.traceId).toBe(roots[0].spanContext().traceId);
    expect(e.severityNumber).toBe(9);
    expect(e.instrumentationScope.name).toBe('opensearch-genai-observability-sdk-ts');
    expect(e.attributes['test.suite.name']).toBe('cases');
    expect(e.attributes['test.suite.run.id']).toBe(result.summary.runId);
    expect(e.attributes['test.case.id']).toBe('c1');
    expect(e.attributes['test.case.name']).toBe('first');
    expect(e.attributes['error.type']).toBeUndefined();
    for (const ev of events) expect(ev.attributes['model.version']).toBe('v1');
    spy.mockRestore();
  });

  it('a crashing case gets one error result per scorer and the run continues', () => {
    const spy = quiet();
    const quality = defineScorer(
      { name: 'answer_quality', threshold: 4, scoreMin: 1, scoreMax: 5, evaluator: 'judge', evaluatorType: 'llm_judge' },
      () => 5,
    );
    const result = evaluate({
      name: 'crash',
      task: (input) => {
        if (input === 'boom') {
          agentTracer().startActiveSpan('invoke_agent crashing', s => {
            s.end();
          });
          throw new TypeError('agent exploded');
        }
        return tracedTask(input);
      },
      data: [{ input: 'boom', caseId: 'bad' }, { input: 'ok', caseId: 'good' }],
      scores: [exact, quality],
      agentName: 'crasher',
      metadata: { 'model.version': 'v1' },
    });
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0].resultStatus).toBe('error');
    expect(result.cases[0].status).toBe('fail');
    expect(result.cases[0].errorType).toBe('TypeError');
    expect(result.cases[0].scores).toEqual({});
    expect(result.cases[1].resultStatus).toBe('pass');

    const events = eventsNamed('gen_ai.evaluation.result');
    expect(events).toHaveLength(4);
    const bad = events.filter(e => e.attributes['test.case.id'] === 'bad');
    expect(bad.map(e => e.attributes['gen_ai.evaluation.name'])).toEqual(['exact', 'answer_quality']);
    const crashingRoot = getFinishedSpans().find(s => s.name === 'invoke_agent crashing')!;
    for (const e of bad) {
      expect(e.attributes['error.type']).toBe('TypeError');
      expect(e.attributes['gen_ai.evaluation.score.value']).toBeUndefined();
      expect(e.attributes['gen_ai.evaluation.score.label']).toBeUndefined();
      expect(e.attributes['gen_ai.evaluation.explanation']).toBeUndefined();
      expect(e.attributes['test.suite.name']).toBe('crash');
      expect(e.attributes['test.suite.run.id']).toBe(result.summary.runId);
      expect(e.attributes['gen_ai.agent.name']).toBe('crasher');
      expect(e.attributes['model.version']).toBe('v1');
      expect(e.spanContext?.spanId).toBe(crashingRoot.spanContext().spanId);
    }
    const q = bad[1].attributes;
    expect(q['opensearch.gen_ai.evaluation.evaluator.name']).toBe('judge');
    expect(q['opensearch.gen_ai.evaluation.evaluator.type']).toBe('llm_judge');
    expect(q['opensearch.gen_ai.evaluation.score.threshold']).toBe(4);
    expect(q['opensearch.gen_ai.evaluation.score.direction']).toBe('maximize');
    expect(q['opensearch.gen_ai.evaluation.score.min']).toBe(1);
    expect(q['opensearch.gen_ai.evaluation.score.max']).toBe(5);
    spy.mockRestore();
  });

  it('a crashing task without a span emits error results without trace context', () => {
    const spy = quiet();
    evaluate({
      name: 'crash-untraced',
      task: () => { throw new RangeError('no agent'); },
      data: [{ input: 'q' }],
      scores: [function relevance() { return 1; }],
    });
    const events = getFinishedLogRecords();
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('gen_ai.evaluation.result');
    expect(events[0].attributes['gen_ai.evaluation.name']).toBe('relevance');
    expect(events[0].attributes['error.type']).toBe('RangeError');
    expect(events[0].spanContext).toBeUndefined();
    spy.mockRestore();
  });

  it('a raising scorer marks the case as error', () => {
    const spy = quiet();
    const result = evaluate({
      name: 'scorer-raise',
      task: tracedTask,
      data: [{ input: 'a' }],
      scores: [function bad() { throw new RangeError('judge down'); }],
    });
    expect(result.cases[0].resultStatus).toBe('error');
    expect(result.cases[0].errorType).toBe('RangeError');
    const [e] = eventsNamed('gen_ai.evaluation.result');
    expect(e.attributes['error.type']).toBe('RangeError');
    expect(e.attributes['gen_ai.evaluation.score.value']).toBeUndefined();
    spy.mockRestore();
  });

  it('a task that creates no span emits events without trace context', () => {
    const spy = quiet();
    const result = evaluate({
      name: 'untraced',
      task: (input) => `answer:${input}`,
      data: [{ input: 'a', expected: 'answer:a' }],
      scores: [exact],
    });
    expect(result.cases[0].resultStatus).toBe('pass');
    const [s] = eventsNamed('gen_ai.evaluation.result');
    expect(s.spanContext).toBeUndefined();
    expect(result.cases[0].traceId).toBeUndefined();
    spy.mockRestore();
  });

  it('emits only gen_ai.evaluation.result events', () => {
    const spy = quiet();
    evaluate({
      name: 'only-results',
      task: (input) => {
        if (input === 'x') throw new Error('nope');
        return tracedTask(input);
      },
      data: [{ input: 'a' }, { input: 'x' }],
      scores: [exact, function bad() { throw new Error('judge down'); }],
    });
    const records = getFinishedLogRecords();
    expect(records).toHaveLength(4);
    expect(new Set(records.map(r => r.eventName))).toEqual(new Set(['gen_ai.evaluation.result']));
    spy.mockRestore();
  });

  it('computes the local case status: error, else fail, else pass', () => {
    const spy = quiet();
    const quality = defineScorer({ name: 'quality', threshold: 4 }, (input) => {
      if (input === 'judge-error') throw new Error('judge down');
      return input === 'good' ? 5 : 2;
    });
    const result = evaluate({
      name: 'statuses',
      task: (input) => {
        if (input === 'task-error') throw new Error('nope');
        return input;
      },
      data: [{ input: 'good' }, { input: 'bad' }, { input: 'task-error' }, { input: 'judge-error' }],
      scores: [quality],
    });
    expect(result.cases.map(c => c.resultStatus)).toEqual(['pass', 'fail', 'error', 'error']);
    expect(result.cases.map(c => c.status)).toEqual(['pass', 'fail', 'fail', 'fail']);
    expect(result.summary.passCount).toBe(1);
    expect(result.summary.failCount).toBe(1);
    expect(result.summary.errorCount).toBe(2);
    spy.mockRestore();
  });

  it('uses the given runId', () => {
    const spy = quiet();
    const result = evaluate({ name: 'rid', runId: 'ci-run-42', task: tracedTask, data: [{ input: 'a' }], scores: [exact] });
    expect(result.summary.runId).toBe('ci-run-42');
    expect(eventsNamed('gen_ai.evaluation.result')[0].attributes['test.suite.run.id']).toBe('ci-run-42');
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent mock')!;
    expect(root.attributes['test.suite.run.id']).toBe('ci-run-42');
    spy.mockRestore();
  });

  it('rejects an empty or whitespace-only runId', () => {
    for (const runId of ['', '   ']) {
      expect(() => evaluate({ name: 'rid', runId, task: x => x, data: [{ input: 'a' }], scores: [] })).toThrow(
        'runId must be a non-empty string',
      );
    }
    expect(getFinishedLogRecords()).toHaveLength(0);
  });

  it('stamps and parents correctly without a global context manager', () => {
    const spy = quiet();
    context.disable();
    try {
      evaluate({
        name: 'no-cm',
        task: (input) => {
          const root = agentTracer().startSpan('invoke_agent manual');
          const child = agentTracer().startSpan('chat manual', {}, trace.setSpan(context.active(), root));
          child.end();
          root.end();
          return input;
        },
        data: [{ input: 'a', caseId: 'c1' }],
        scores: [() => 1],
      });
    } finally {
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    }
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent manual')!;
    const child = getFinishedSpans().find(s => s.name === 'chat manual')!;
    expect(root.attributes['test.case.id']).toBe('c1');
    expect(child.attributes['test.case.id']).toBeUndefined();
    expect(eventsNamed('gen_ai.evaluation.result')[0].spanContext?.spanId).toBe(root.spanContext().spanId);
    spy.mockRestore();
  });

  it('online score() and spans outside evaluate() are unaffected', () => {
    const spy = quiet();
    evaluate({ name: 'before', task: tracedTask, data: [{ input: 'a' }], scores: [] });
    clearSpans();
    agentTracer().startActiveSpan('invoke_agent online', span => {
      score({ name: 'relevance', value: 0.7 });
      span.end();
    });
    const online = getFinishedSpans().find(s => s.name === 'invoke_agent online')!;
    expect(Object.keys(online.attributes).filter(k => k.startsWith('test.'))).toHaveLength(0);
    const records = getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0].eventName).toBe('gen_ai.evaluation.result');
    expect(records[0].spanContext?.spanId).toBe(online.spanContext().spanId);
    expect(Object.keys(records[0].attributes).filter(k => k.startsWith('test.'))).toHaveLength(0);
    spy.mockRestore();
  });
});

describe('Benchmark (default: events, no harness spans)', () => {
  it('log emits score events parented to the evaluated span with run and case metadata', () => {
    const spy = quiet();
    const bm = new Benchmark('upload', { metadata: { 'model.version': 'v1', shared: 'run' } });
    bm.log({
      input: 'q',
      output: 'a',
      expected: 'a',
      scores: [
        { name: 'accuracy', value: 1 },
        { name: 'judge', value: 0.5, metadata: { shared: 'score' } },
      ],
      caseId: 'c1',
      caseName: 'first',
      traceId: 'abcdef1234567890abcdef1234567890',
      spanId: '1234567890abcdef',
      metadata: { 'case.tag': 'x', shared: 'case' },
    });
    bm.close();
    expect(getFinishedSpans()).toHaveLength(0);

    const [s, j] = eventsNamed('gen_ai.evaluation.result');
    expect(s.spanContext?.traceId).toBe('abcdef1234567890abcdef1234567890');
    expect(s.spanContext?.spanId).toBe('1234567890abcdef');
    expect(s.attributes['test.case.id']).toBe('c1');
    expect(s.attributes['test.case.name']).toBe('first');
    expect(s.attributes['model.version']).toBe('v1');
    expect(s.attributes['case.tag']).toBe('x');
    // case metadata over run metadata, score metadata over both
    expect(s.attributes['shared']).toBe('case');
    expect(j.attributes['shared']).toBe('score');
    spy.mockRestore();
  });

  it('SDK attributes win over user metadata', () => {
    const spy = quiet();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bm = new Benchmark('upload', { metadata: { 'gen_ai.evaluation.name': 'run-meta' } });
    bm.log({ input: 'q', caseId: 'c1', scores: { accuracy: 1 }, metadata: { 'test.case.id': 'spoofed' } });
    bm.close();
    const [s] = eventsNamed('gen_ai.evaluation.result');
    expect(s.attributes['gen_ai.evaluation.name']).toBe('accuracy');
    expect(s.attributes['test.case.id']).toBe('c1');
    warn.mockRestore();
    spy.mockRestore();
  });

  it('log without trace ids emits events without trace context', () => {
    const spy = quiet();
    const bm = new Benchmark('upload');
    bm.log({ input: 'q', scores: { accuracy: 1 } });
    bm.close();
    expect(eventsNamed('gen_ai.evaluation.result')[0].spanContext).toBeUndefined();
    spy.mockRestore();
  });

  it('computes the local case status and sends nothing for cases without scores', () => {
    const spy = quiet();
    const bm = new Benchmark('upload');
    bm.log({ input: 'q1', caseId: 'bad', error: 'timeout', errorType: 'TimeoutError' });
    bm.log({ input: 'q2', caseId: 'nocls', error: 'oops' });
    bm.log({ input: 'q3', caseId: 'good' });
    bm.log({ input: 'q4', caseId: 'wrong', status: 'fail' });
    const summary = bm.close();
    expect(getFinishedLogRecords()).toHaveLength(0);
    expect(summary.totalCases).toBe(4);
    expect(summary.errorCount).toBe(2);
    expect(summary.passCount).toBe(1);
    expect(summary.failCount).toBe(1);
    spy.mockRestore();
  });

  it('marks a case logged with errorType alone as failed and errored, like evaluate()', () => {
    const spy = quiet();
    const bm = new Benchmark('upload');
    bm.log({ input: 'q1', caseId: 'typed', scores: [{ name: 'accuracy' }], errorType: 'TimeoutError' });
    bm.log({ input: 'q2', caseId: 'typed-no-scores', errorType: 'TimeoutError' });
    bm.log({ input: 'q3', caseId: 'explicit', status: 'error' });
    const cases = bm['_cases'];
    const summary = bm.close();
    expect(cases.map(c => [c.status, c.resultStatus])).toEqual([
      ['fail', 'error'],
      ['fail', 'error'],
      ['fail', 'error'],
    ]);
    expect(summary.errorCount).toBe(3);
    expect(summary.passCount).toBe(0);
    spy.mockRestore();
  });

  it('emits only gen_ai.evaluation.result events', () => {
    const spy = quiet();
    const bm = new Benchmark('upload');
    bm.log({ input: 'q1', scores: { accuracy: 1 } });
    bm.log({ input: 'q2', scores: [{ name: 'accuracy' }], errorType: 'TimeoutError' });
    bm.log({ input: 'q3', error: 'oops' });
    bm.close();
    const records = getFinishedLogRecords();
    expect(records).toHaveLength(2);
    expect(records.every(r => r.eventName === 'gen_ai.evaluation.result')).toBe(true);
    spy.mockRestore();
  });

  it('log with errorType emits every score as an evaluator error result', () => {
    const spy = quiet();
    const bm = new Benchmark('upload', { agentName: 'agent-x' });
    bm.log({
      input: 'q',
      caseId: 'c1',
      scores: [
        { name: 'answer_quality', value: 3, threshold: 4, scoreMin: 1, scoreMax: 5 },
        { name: 'tool_selection', value: 1, label: 'pass' },
      ],
      error: 'judge timed out',
      errorType: 'TimeoutError',
      traceId: 'abcdef1234567890abcdef1234567890',
      spanId: '1234567890abcdef',
    });
    const summary = bm.close();
    const events = eventsNamed('gen_ai.evaluation.result');
    expect(events.map(e => e.attributes['gen_ai.evaluation.name'])).toEqual(['answer_quality', 'tool_selection']);
    for (const e of events) {
      expect(e.attributes['error.type']).toBe('TimeoutError');
      expect(e.attributes['gen_ai.evaluation.score.value']).toBeUndefined();
      expect(e.attributes['gen_ai.evaluation.score.label']).toBeUndefined();
      expect(e.attributes['test.case.id']).toBe('c1');
      expect(e.attributes['gen_ai.agent.name']).toBe('agent-x');
      expect(e.spanContext?.spanId).toBe('1234567890abcdef');
    }
    expect(events[0].attributes['opensearch.gen_ai.evaluation.score.threshold']).toBe(4);
    expect(summary.errorCount).toBe(1);
    expect(summary.scores).toEqual({});
    spy.mockRestore();
  });

  it('uses the given runId', () => {
    const spy = quiet();
    const bm = new Benchmark('upload', { runId: 'ci-run-42' });
    expect(bm.runId).toBe('ci-run-42');
    bm.log({ input: 'q', scores: { accuracy: 1 } });
    expect(bm.close().runId).toBe('ci-run-42');
    expect(eventsNamed('gen_ai.evaluation.result')[0].attributes['test.suite.run.id']).toBe('ci-run-42');
    spy.mockRestore();
  });

  it('rejects an empty or whitespace-only runId', () => {
    expect(() => new Benchmark('upload', { runId: '' })).toThrow('runId must be a non-empty string');
    expect(() => new Benchmark('upload', { runId: ' \t ' })).toThrow('runId must be a non-empty string');
  });

  it('rejects an unknown status', () => {
    const spy = quiet();
    const bm = new Benchmark('upload');
    expect(() => bm.log({ input: 'q', status: 'bogus' as never })).toThrow('status must be one of');
    bm.close();
    spy.mockRestore();
  });
});

describe('evaluation result scope', () => {
  it('uses the SDK scope with no scope attributes', () => {
    const spy = quiet();
    const bm = new Benchmark('scope');
    bm.log({ input: 'q', scores: { accuracy: 1 } });
    bm.close();
    const records = scoreRecords();
    expect(records).toHaveLength(1);
    for (const r of records) {
      expect(r.instrumentationScope.name).toBe('opensearch-genai-observability-sdk-ts');
      expect(r.instrumentationScope.attributes ?? {}).toEqual({});
    }
    spy.mockRestore();
  });
});

describe('TestCaseSpanProcessor installation', () => {
  it('register() installs it once on its provider', async () => {
    const { register } = await import('../src/register.js');
    const { InMemorySpanExporter } = await import('@opentelemetry/sdk-trace-base');
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      setGlobal: false,
      logs: false,
      autoInstrument: false,
    });
    const processors = (provider as unknown as { _registeredSpanProcessors: unknown[] })._registeredSpanProcessors;
    expect(processors.filter(p => p instanceof TestCaseSpanProcessor)).toHaveLength(1);
    expect(installTestCaseProcessor(provider)).toBe(true);
    expect(processors.filter(p => p instanceof TestCaseSpanProcessor)).toHaveLength(1);
    await provider.shutdown();
  });

  it('does not stamp spans when no case is running', () => {
    const processor = new TestCaseSpanProcessor();
    const setAttributes = vi.fn();
    processor.onStart(
      { spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }), setAttributes } as never,
      context.active(),
    );
    expect(setAttributes).not.toHaveBeenCalled();
  });
});

describe('declared scorer rules and verdicts', () => {
  const LABEL = 'gen_ai.evaluation.score.label';
  const THRESHOLD = 'opensearch.gen_ai.evaluation.score.threshold';
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
  const grades = () =>
    Object.fromEntries(scoreRecords().map(r => [r.attributes['gen_ai.evaluation.name'], r]));

  it('defineScorer keeps the function and attaches the spec', () => {
    const exactScorer = defineScorer({ threshold: 4 }, function exactMatch() { return 4; });
    expect(exactScorer.name).toBe('exactMatch');
    expect(exactScorer('q', 'a', undefined)).toBe(4);
    expect(exactScorer.scorerSpec.direction).toBe('maximize');
  });

  it('defineScorer validates its spec', () => {
    expect(() => defineScorer({ direction: 'up' as 'maximize' }, () => 1)).toThrow(/direction/);
    expect(() => defineScorer({ evaluatorType: 'robot' as 'code' }, () => 1)).toThrow(/evaluatorType/);
    expect(() => defineScorer({ threshold: Number.NaN }, () => 1)).toThrow(/threshold/);
  });

  it('names number results after the declaration and applies its rule', () => {
    const quality = defineScorer(
      { name: 'answer_quality', threshold: 4, scoreMin: 1, scoreMax: 5, evaluator: 'quality_judge', evaluatorType: 'llm_judge' },
      function quality() { return 3; },
    );
    const result = evaluate({ name: 'decl', task: x => x, data: [{ input: 'q' }], scores: [quality] });
    const r = grades()['answer_quality'];
    expect(r.attributes['gen_ai.evaluation.score.value']).toBe(3);
    expect(r.attributes[THRESHOLD]).toBe(4);
    expect(r.attributes['opensearch.gen_ai.evaluation.score.direction']).toBe('maximize');
    expect(r.attributes['opensearch.gen_ai.evaluation.score.min']).toBe(1);
    expect(r.attributes['opensearch.gen_ai.evaluation.score.max']).toBe(5);
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('quality_judge');
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBe('llm_judge');
    expect(r.attributes[LABEL]).toBe('fail');
    expect(r.instrumentationScope.name).toBe('opensearch-genai-observability-sdk-ts');
    expect(result.cases[0].scores).toEqual({ answer_quality: 3 });
    expect(result.cases[0].verdicts).toEqual({ answer_quality: 'fail' });
  });

  it('lets EvalScore fields override the declaration', () => {
    const latency = defineScorer(
      { name: 'latency_budget', direction: 'minimize', threshold: 12 },
      () => ({ name: 'latency_budget', value: 13, threshold: 15 }),
    );
    evaluate({ name: 'override', task: x => x, data: [{ input: 'q' }], scores: [latency] });
    const a = grades()['latency_budget'].attributes;
    expect(a[THRESHOLD]).toBe(15);
    expect(a['opensearch.gen_ai.evaluation.score.direction']).toBe('minimize');
    expect(a[LABEL]).toBe('pass');
  });

  it('propagates passed / label from returned scores', () => {
    const checks = (): EvalScore[] => [
      { name: 'a', value: 0.5, passed: true },
      { name: 'b', value: 0.5, label: 'fail' },
      { name: 'c', label: 'pass' },
      { name: 'd', value: 0.5, label: 'pass', passed: false },
    ];
    const result = evaluate({ name: 'explicit', task: x => x, data: [{ input: 'q' }], scores: [checks] });
    const g = grades();
    expect(g['a'].attributes[LABEL]).toBe('pass');
    expect(g['b'].attributes[LABEL]).toBe('fail');
    expect(g['c'].attributes[LABEL]).toBe('pass');
    expect(g['c'].attributes['gen_ai.evaluation.score.value']).toBeUndefined();
    expect(g['d'].attributes[LABEL]).toBe('pass');
    expect(result.cases[0].scores).toEqual({ a: 0.5, b: 0.5, d: 0.5 });
  });

  it('treats a boolean result as a verdict', () => {
    const tools = defineScorer({ name: 'tool_selection' }, () => false);
    evaluate({ name: 'bool', task: x => x, data: [{ input: 'q' }], scores: [tools] });
    const a = grades()['tool_selection'].attributes;
    expect(a['gen_ai.evaluation.score.value']).toBe(0);
    expect(a[LABEL]).toBe('fail');
  });

  it('keeps case status pass when nothing is declared', () => {
    const result = evaluate({ name: 'no-rules', task: x => x, data: [{ input: 'q' }], scores: [() => 0] });
    expect(result.cases[0].status).toBe('pass');
    expect(result.cases[0].verdicts).toBeUndefined();
    expect(result.cases[0].resultStatus).toBe('pass');
    expect(scoreRecords()[0].attributes[LABEL]).toBeUndefined();
  });

  it('fails a case on a fail verdict', () => {
    const quality = defineScorer({ name: 'answer_quality', threshold: 4 }, (input) => (input === 'good' ? 5 : 2));
    const result = evaluate({
      name: 'verdicts',
      task: x => x,
      data: [{ input: 'good', caseId: 'g' }, { input: 'bad', caseId: 'b' }],
      scores: [quality],
    });
    expect(result.cases.map(c => c.status)).toEqual(['pass', 'fail']);
    expect(result.cases.map(c => c.resultStatus)).toEqual(['pass', 'fail']);
    expect(result.summary.passCount).toBe(1);
    expect(result.summary.failCount).toBe(1);
    expect(result.summary.errorCount).toBe(0);
  });

  it('error beats a fail verdict', () => {
    const bad = () => { throw new Error('judge down'); };
    const result = evaluate({
      name: 'err-first',
      task: x => x,
      data: [{ input: 'q' }],
      scores: [() => ({ name: 'x', value: 0, passed: false }), bad],
    });
    expect(result.cases[0].resultStatus).toBe('error');
  });

  it('names the error grade after the declared evaluation name', () => {
    const quality = defineScorer(
      { name: 'answer_quality', threshold: 4, scoreMin: 1, scoreMax: 5 },
      function quality(): number { throw new TypeError('judge down'); },
    );
    evaluate({ name: 'err-name', task: x => x, data: [{ input: 'q' }], scores: [quality] });
    const g = grades();
    expect(Object.keys(g)).toEqual(['answer_quality']);
    const a = g['answer_quality'].attributes;
    expect(a['error.type']).toBe('TypeError');
    expect(a[THRESHOLD]).toBe(4);
    expect(a[LABEL]).toBeUndefined();
    expect(a['gen_ai.evaluation.score.value']).toBeUndefined();
  });

  it('falls back to the function name for an undeclared scorer that throws', () => {
    function quality(): number { throw new Error('judge down'); }
    evaluate({ name: 'err-fn', task: x => x, data: [{ input: 'q' }], scores: [quality] });
    const g = grades();
    expect(Object.keys(g)).toEqual(['quality']);
    expect(g['quality'].attributes['error.type']).toBe('Error');
  });

  it('Benchmark.log accepts EvalScore[] with verdicts', () => {
    const bm = new Benchmark('bench-verdicts');
    bm.log({
      input: 'q',
      caseId: 'c1',
      scores: [
        { name: 'answer_quality', value: 3, threshold: 4, scoreMin: 1, scoreMax: 5 },
        { name: 'tool_selection', value: 1, label: 'pass' },
      ],
    });
    const summary = bm.close();
    const g = grades();
    expect(g['answer_quality'].attributes[LABEL]).toBe('fail');
    expect(g['answer_quality'].attributes['opensearch.gen_ai.evaluation.score.max']).toBe(5);
    expect(g['tool_selection'].attributes[LABEL]).toBe('pass');
    expect(summary.failCount).toBe(1);
  });

  it('Benchmark.log keeps dict scores neutral and explicit status wins', () => {
    const bm = new Benchmark('bench-dict');
    bm.log({ input: 'q', caseId: 'a', scores: { accuracy: 0 } });
    bm.log({ input: 'q', caseId: 'b', scores: [{ name: 'x', value: 0, passed: false }], status: 'pass' });
    const summary = bm.close();
    expect(summary.passCount).toBe(2);
    expect(scoreRecords()[0].attributes[LABEL]).toBeUndefined();
  });
});

describe('stored label agrees with the local case status', () => {
  const LABEL = 'gen_ai.evaluation.score.label';
  const JUDGE = 'opensearch.gen_ai.evaluation.judge_label';
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
  const grades = () =>
    Object.fromEntries(scoreRecords().map(r => [r.attributes['gen_ai.evaluation.name'], r.attributes]));

  it('a judge label with passed: false stores fail and keeps the label as judge_label', () => {
    const bm = new Benchmark('labels-passed');
    bm.log({ input: 'q', caseId: 'c', scores: [{ name: 'relevance_passed', value: 0.4, label: 'relevant', passed: false }] });
    const summary = bm.close();
    const a = grades()['relevance_passed'];
    expect(a[LABEL]).toBe('fail');
    expect(a[JUDGE]).toBe('relevant');
    expect(summary.failCount).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/"relevance_passed" has label "relevant"/));
  });

  it('a judge label with a failing threshold stores fail', () => {
    const judge = defineScorer({ name: 'relevance_threshold', threshold: 0.5 }, () => ({
      name: 'relevance_threshold',
      value: 0.2,
      label: 'partially_relevant',
    }));
    const result = evaluate({ name: 'labels-threshold', task: x => x, data: [{ input: 'q' }], scores: [judge] });
    const a = grades()['relevance_threshold'];
    expect(result.cases[0].resultStatus).toBe('fail');
    expect(a[LABEL]).toBe('fail');
    expect(a[JUDGE]).toBe('partially_relevant');
  });

  it('a verdict label in any case is stored lowercase', () => {
    const result = evaluate({
      name: 'labels-case',
      task: x => x,
      data: [{ input: 'q' }],
      scores: [() => ({ name: 'upper', value: 1, label: 'PASS' }), () => ({ name: 'lower_fail', label: 'Fail' })],
    });
    expect(grades()['upper'][LABEL]).toBe('pass');
    expect(grades()['lower_fail'][LABEL]).toBe('fail');
    expect(result.cases[0].verdicts).toEqual({ upper: 'pass', lower_fail: 'fail' });
  });

  it('a judge label without a verdict stays the label', () => {
    evaluate({ name: 'labels-neutral', task: x => x, data: [{ input: 'q' }], scores: [() => ({ name: 'tone', value: 3, label: 'friendly' })] });
    expect(grades()['tone'][LABEL]).toBe('friendly');
    expect(grades()['tone'][JUDGE]).toBeUndefined();
  });
});

describe('scorer return values', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const bad: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['bigint', BigInt(1)],
    ['string', '0.9'],
    ['object without name', { value: 1 }],
    ['non-finite EvalScore value', { name: 'x', value: Number.NaN }],
    ['string EvalScore value', { name: 'x', value: '1' }],
    ['array with a bad item', [{ name: 'ok', value: 1 }, null]],
  ];

  for (const [label, value] of bad) {
    it(`${label}: warns and emits an error result`, () => {
      const scorer = defineScorer({ name: 'judge' }, (() => value) as never);
      const result = evaluate({ name: `bad-${label}`, task: x => x, data: [{ input: 'q' }], scores: [scorer] });
      const records = scoreRecords();
      expect(records).toHaveLength(1);
      const a = records[0].attributes;
      expect(a['gen_ai.evaluation.name']).toBe('judge');
      expect(a['error.type']).toBe('TypeError');
      expect(a['gen_ai.evaluation.score.value']).toBeUndefined();
      expect(a['gen_ai.evaluation.score.label']).toBeUndefined();
      expect(result.cases[0].resultStatus).toBe('error');
      expect(result.cases[0].scorerErrors).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/scorer "judge" returned/));
    });
  }

  it('an un-awaited Promise warns, emits an error result and is not left unhandled', async () => {
    const asyncScorer = defineScorer({ name: 'async_judge' }, (async () => { throw new Error('later'); }) as never);
    const result = evaluate({ name: 'bad-promise', task: x => x, data: [{ input: 'q' }], scores: [asyncScorer] });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(scoreRecords()[0].attributes['error.type']).toBe('TypeError');
    expect(result.cases[0].resultStatus).toBe('error');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/returned a Promise/));
  });

  it('accepts finite numbers, booleans, EvalScore and EvalScore[]', () => {
    const result = evaluate({
      name: 'good-results',
      task: x => x,
      data: [{ input: 'q' }],
      scores: [
        function num() { return 0; },
        function bool() { return true; },
        function one(): EvalScore { return { name: 'one', value: 0.5 }; },
        function many(): EvalScore[] { return [{ name: 'm1', value: 1 }, { name: 'm2', label: 'pass' }]; },
      ],
    });
    expect(result.cases[0].resultStatus).toBe('pass');
    expect(scoreRecords().every(r => r.attributes['error.type'] === undefined)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('never sends the scorer exception message as the explanation', () => {
    const leaky = defineScorer({ name: 'leaky' }, () => {
      throw new Error('POST https://judge.example.com?key=secret failed');
    });
    const result = evaluate({ name: 'no-leak', task: x => x, data: [{ input: 'q' }], scores: [leaky] });
    const a = scoreRecords()[0].attributes;
    expect(a['error.type']).toBe('Error');
    expect(a['gen_ai.evaluation.explanation']).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain('secret');
    expect(result.cases[0].scorerErrors).toEqual(['POST https://judge.example.com?key=secret failed']);
  });
});

describe('expected output on evaluation results', () => {
  const EXPECTED = 'opensearch.test.case.expected';
  const TRUNCATED = 'opensearch.test.case.expected_truncated';
  const silence = () => vi.spyOn(console, 'log').mockImplementation(() => {});
  const two = [function a() { return 1; }, function b() { return 0; }];

  it('evaluate() puts a string expected on every result of the case', () => {
    const spy = silence();
    evaluate({
      name: 'exp',
      task: (input) => `answer:${input}`,
      data: [{ input: 'q', expected: 'answer:q', caseId: 'c1' }],
      scores: two,
    });
    const records = scoreRecords();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.attributes[EXPECTED]).toBe('answer:q');
      expect(r.attributes[TRUNCATED]).toBeUndefined();
    }
    spy.mockRestore();
  });

  it('JSON.stringifies a non-string expected', () => {
    const spy = silence();
    const bm = new Benchmark('exp');
    bm.log({ input: 'q', expected: { city: 'Paris', n: [1, 2] }, scores: { accuracy: 1 } });
    bm.log({ input: 'r', expected: 42, scores: { accuracy: 1 } });
    bm.close();
    const [obj, num] = scoreRecords();
    expect(obj.attributes[EXPECTED]).toBe('{"city":"Paris","n":[1,2]}');
    expect(num.attributes[EXPECTED]).toBe('42');
    spy.mockRestore();
  });

  it('truncates to 4096 characters and flags it', () => {
    const spy = silence();
    const bm = new Benchmark('exp');
    bm.log({ input: 'q', expected: 'x'.repeat(5000), scores: { accuracy: 1 } });
    bm.log({ input: 'r', expected: 'y'.repeat(4096), scores: { accuracy: 1 } });
    bm.close();
    const [long, exact] = scoreRecords();
    expect(long.attributes[EXPECTED]).toBe('x'.repeat(4096));
    expect(long.attributes[TRUNCATED]).toBe(true);
    expect(exact.attributes[EXPECTED]).toBe('y'.repeat(4096));
    expect(exact.attributes[TRUNCATED]).toBeUndefined();
    spy.mockRestore();
  });

  it('is absent when the case has no expected output', () => {
    const spy = silence();
    evaluate({ name: 'exp', task: (i) => i, data: [{ input: 'q' }], scores: two });
    const bm = new Benchmark('exp');
    bm.log({ input: 'q', scores: { accuracy: 1 } });
    bm.close();
    const records = scoreRecords();
    expect(records).toHaveLength(3);
    for (const r of records) {
      expect(r.attributes[EXPECTED]).toBeUndefined();
      expect(r.attributes[TRUNCATED]).toBeUndefined();
    }
    spy.mockRestore();
  });

  it('is on the error results of a case whose task throws', () => {
    const spy = silence();
    evaluate({
      name: 'exp',
      task: () => { throw new Error('boom'); },
      data: [{ input: 'q', expected: 'gold' }],
      scores: two,
    });
    const records = scoreRecords();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.attributes['error.type']).toBe('Error');
      expect(r.attributes[EXPECTED]).toBe('gold');
    }
    spy.mockRestore();
  });

  it('is not on the agent spans', () => {
    const spy = silence();
    evaluate({
      name: 'exp',
      task: (input) =>
        trace.getTracer('agent').startActiveSpan('invoke_agent a', (s) => {
          s.end();
          return input;
        }),
      data: [{ input: 'q', expected: 'gold' }],
      scores: two,
    });
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent a')!;
    expect(root.attributes['test.suite.name']).toBe('exp');
    expect(root.attributes[EXPECTED]).toBeUndefined();
    spy.mockRestore();
  });

  it('metadata cannot set it', () => {
    const spy = silence();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bm = new Benchmark('exp', { metadata: { [EXPECTED]: 'meta', [TRUNCATED]: true } });
    bm.log({ input: 'q', scores: { accuracy: 1 } });
    bm.close();
    const [r] = scoreRecords();
    expect(r.attributes[EXPECTED]).toBeUndefined();
    expect(r.attributes[TRUNCATED]).toBeUndefined();
    spy.mockRestore();
    warn.mockRestore();
  });

  it('is recorded by default, with recordExpected: true the same', () => {
    const spy = silence();
    evaluate({ name: 'exp', task: (i) => i, data: [{ input: 'q', expected: 'gold' }], scores: two, recordExpected: true });
    const bm = new Benchmark('exp', { recordExpected: true });
    bm.log({ input: 'q', expected: 'gold', scores: { accuracy: 1 } });
    bm.close();
    const records = scoreRecords();
    expect(records).toHaveLength(3);
    for (const r of records) expect(r.attributes[EXPECTED]).toBe('gold');
    spy.mockRestore();
  });

  it('recordExpected: false writes neither attribute, on scores and error results', () => {
    const spy = silence();
    const long = 'x'.repeat(5000);
    const result = evaluate({
      name: 'exp',
      task: (i) => i,
      data: [{ input: 'q', expected: long }],
      scores: two,
      recordExpected: false,
    });
    evaluate({
      name: 'exp',
      task: () => { throw new Error('boom'); },
      data: [{ input: 'q', expected: long }],
      scores: two,
      recordExpected: false,
    });
    const bm = new Benchmark('exp', { recordExpected: false });
    bm.log({ input: 'q', expected: long, scores: { accuracy: 1 } });
    bm.log({ input: 'r', expected: long, scores: [{ name: 'accuracy' }], errorType: 'TimeoutError' });
    bm.close();
    const records = scoreRecords();
    expect(records).toHaveLength(6);
    for (const r of records) {
      expect(r.attributes[EXPECTED]).toBeUndefined();
      expect(r.attributes[TRUNCATED]).toBeUndefined();
    }
    // The local result still has it.
    expect(result.cases[0].expected).toBe(long);
    spy.mockRestore();
  });

  it('online score() sets it only when passed in attributes', () => {
    score({ name: 'relevance', value: 1 });
    score({ name: 'relevance', value: 1, attributes: { [EXPECTED]: 'gold' } });
    const [plain, explicit] = scoreRecords();
    expect(plain.attributes[EXPECTED]).toBeUndefined();
    expect(explicit.attributes[EXPECTED]).toBe('gold');
  });
});

describe('judge trace id from offline scorers', () => {
  const JUDGE = 'opensearch.gen_ai.evaluation.judge.trace_id';

  it('evaluate() and Benchmark.log send EvalScore.judgeTraceId', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    evaluate({
      name: 'judge',
      task: (i) => i,
      data: [{ input: 'q' }],
      scores: [() => ({ name: 'quality', value: 4, judgeTraceId: 'ab'.repeat(16) })],
    });
    const bm = new Benchmark('judge');
    bm.log({ input: 'q', scores: [{ name: 'quality', value: 4, judgeTraceId: 'cd'.repeat(16) }] });
    bm.log({ input: 'r', scores: { quality: 4 } });
    bm.close();
    const [fromEvaluate, fromLog, none] = scoreRecords();
    expect(fromEvaluate.attributes[JUDGE]).toBe('ab'.repeat(16));
    expect(fromLog.attributes[JUDGE]).toBe('cd'.repeat(16));
    expect(none.attributes[JUDGE]).toBeUndefined();
    spy.mockRestore();
  });
});
