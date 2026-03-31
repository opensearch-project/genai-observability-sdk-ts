// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { Benchmark, evaluate } from '../src/benchmark.js';
import { getFinishedSpans, clearSpans } from './setup.js';

beforeEach(() => clearSpans());
afterEach(() => clearSpans());

describe('Benchmark class', () => {
  it('creates a root span on construction', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('test-suite');
    bm.close();

    const spans = getFinishedSpans();
    const rootSpan = spans.find(s => s.name.startsWith('test_suite_run'));
    expect(rootSpan).toBeDefined();
    expect(rootSpan!.attributes['test.suite.name']).toBe('test-suite');
    expect(rootSpan!.attributes['gen_ai.operation.name']).toBe('evaluation');
    expect(rootSpan!.attributes['test.suite.run.id']).toBeDefined();
    logSpy.mockRestore();
  });

  it('has name and runId getters', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('my-bench');
    expect(bm.name).toBe('my-bench');
    expect(bm.runId).toBeDefined();
    expect(typeof bm.runId).toBe('string');
    expect(bm.runId.startsWith('run_')).toBe(true);
    bm.close();
    logSpy.mockRestore();
  });

  it('log creates child spans', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: 'q1', output: 'a1', expected: 'a1', scores: { accuracy: 1.0 } });
    bm.log({ input: 'q2', output: 'a2', expected: 'a2', scores: { accuracy: 0.8 } });
    bm.close();

    const spans = getFinishedSpans();
    const caseSpans = spans.filter(s => s.name.startsWith('test_case'));
    expect(caseSpans).toHaveLength(2);

    // Case spans should be children of root
    const rootSpan = spans.find(s => s.name.startsWith('test_suite_run'))!;
    for (const cs of caseSpans) {
      expect(cs.parentSpanId).toBe(rootSpan.spanContext().spanId);
    }
    logSpy.mockRestore();
  });

  it('log records score events on case spans', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({
      input: 'q1',
      output: 'a1',
      scores: { accuracy: 0.9, fluency: 0.8 },
    });
    bm.close();

    const spans = getFinishedSpans();
    const caseSpan = spans.find(s => s.name.startsWith('test_case'))!;
    const evalEvents = caseSpan.events.filter(e => e.name === 'gen_ai.evaluation.result');
    expect(evalEvents).toHaveLength(2);
    logSpy.mockRestore();
  });

  it('log records I/O when recordIo is true (default)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: { query: 'hello' }, output: 'world', expected: 'world' });
    bm.close();

    const spans = getFinishedSpans();
    const caseSpan = spans.find(s => s.name.startsWith('test_case'))!;
    expect(caseSpan.attributes['test.case.input']).toBeDefined();
    expect(caseSpan.attributes['test.case.output']).toBeDefined();
    expect(caseSpan.attributes['test.case.expected']).toBeDefined();
    logSpy.mockRestore();
  });

  it('log does not record I/O when recordIo is false', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite', { recordIo: false });
    bm.log({ input: 'q', output: 'a', expected: 'a' });
    bm.close();

    const spans = getFinishedSpans();
    const caseSpan = spans.find(s => s.name.startsWith('test_case'))!;
    expect(caseSpan.attributes['test.case.input']).toBeUndefined();
    expect(caseSpan.attributes['test.case.output']).toBeUndefined();
    expect(caseSpan.attributes['test.case.expected']).toBeUndefined();
    logSpy.mockRestore();
  });

  it('log records error status on case span', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: 'q', error: 'something went wrong' });
    bm.close();

    const spans = getFinishedSpans();
    const caseSpan = spans.find(s => s.name.startsWith('test_case'))!;
    expect(caseSpan.attributes['test.case.result.status']).toBe('error');
    expect(caseSpan.attributes['test.case.error']).toBe('something went wrong');
    expect(caseSpan.status.code).toBe(SpanStatusCode.ERROR);
    logSpy.mockRestore();
  });

  it('log creates span links when traceId and spanId provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({
      input: 'q',
      output: 'a',
      traceId: 'abcdef1234567890abcdef1234567890',
      spanId: '1234567890abcdef',
    });
    bm.close();

    const spans = getFinishedSpans();
    const caseSpan = spans.find(s => s.name.startsWith('test_case'))!;
    expect(caseSpan.links.length).toBeGreaterThanOrEqual(1);
    expect(caseSpan.links[0].context.traceId).toBe('abcdef1234567890abcdef1234567890');
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
    expect(summary.scores['accuracy']).toBeDefined();
    expect(summary.scores['accuracy'].avg).toBe(0.9);
    expect(summary.scores['accuracy'].min).toBe(0.8);
    expect(summary.scores['accuracy'].max).toBe(1.0);
    expect(summary.scores['accuracy'].count).toBe(2);
    logSpy.mockRestore();
  });

  it('close sets test.suite.run.status to pass when no errors', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: 'q', output: 'a' });
    bm.close();

    const spans = getFinishedSpans();
    const rootSpan = spans.find(s => s.name.startsWith('test_suite_run'))!;
    expect(rootSpan.attributes['test.suite.run.status']).toBe('pass');
    logSpy.mockRestore();
  });

  it('close sets test.suite.run.status to fail when errors exist', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: 'q', error: 'oops' });
    bm.close();

    const spans = getFinishedSpans();
    const rootSpan = spans.find(s => s.name.startsWith('test_suite_run'))!;
    expect(rootSpan.attributes['test.suite.run.status']).toBe('fail');
    expect(rootSpan.status.code).toBe(SpanStatusCode.ERROR);
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
    bm.close();

    const spans = getFinishedSpans();
    const rootSpan = spans.find(s => s.name.startsWith('test_suite_run'))!;
    expect(rootSpan.attributes['custom.key']).toBe('val');
    // test.suite.name should be 'suite' not 'override' since reserved keys are filtered
    expect(rootSpan.attributes['test.suite.name']).toBe('suite');
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('auto-generates caseId from input hash', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: { query: 'test' } });
    bm.close();

    const spans = getFinishedSpans();
    const caseSpan = spans.find(s => s.name.startsWith('test_case'))!;
    const caseId = caseSpan.attributes['test.case.id'] as string;
    expect(caseId).toBeDefined();
    expect(caseId.length).toBe(16); // sha256 hex prefix
    logSpy.mockRestore();
  });

  it('uses custom caseId when provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: 'q', caseId: 'my-case-id' });
    bm.close();

    const spans = getFinishedSpans();
    const caseSpan = spans.find(s => s.name.startsWith('test_case'))!;
    expect(caseSpan.attributes['test.case.id']).toBe('my-case-id');
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

    const spans = getFinishedSpans();
    const rootSpan = spans.find(s => s.name.startsWith('test_suite_run'));
    expect(rootSpan).toBeDefined();
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

    expect(result.cases[0].status).toBe('error');
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

    expect(result.cases[0].scorerErrors).toBeDefined();
    expect(result.cases[0].scorerErrors!.length).toBeGreaterThan(0);
    logSpy.mockRestore();
  });

  it('creates proper span hierarchy', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    evaluate({
      name: 'hierarchy',
      task: (input) => input,
      data: [
        { input: 'q1', caseName: 'case1' },
        { input: 'q2', caseName: 'case2' },
      ],
      scores: [],
    });

    const spans = getFinishedSpans();
    const rootSpan = spans.find(s => s.name.startsWith('test_suite_run'))!;
    const caseSpans = spans.filter(s => s.name.startsWith('test_case'));
    expect(caseSpans).toHaveLength(2);

    for (const cs of caseSpans) {
      expect(cs.parentSpanId).toBe(rootSpan.spanContext().spanId);
    }
    logSpy.mockRestore();
  });

  it('records I/O on case spans by default', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    evaluate({
      name: 'io-test',
      task: () => 'output',
      data: [{ input: 'input', expected: 'output' }],
      scores: [],
    });

    const spans = getFinishedSpans();
    const caseSpan = spans.find(s => s.name.startsWith('test_case'))!;
    expect(caseSpan.attributes['test.case.input']).toBeDefined();
    expect(caseSpan.attributes['test.case.output']).toBeDefined();
    logSpy.mockRestore();
  });

  it('does not record I/O when recordIo is false', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    evaluate({
      name: 'no-io-test',
      task: () => 'output',
      data: [{ input: 'input', expected: 'output' }],
      scores: [],
      recordIo: false,
    });

    const spans = getFinishedSpans();
    const caseSpan = spans.find(s => s.name.startsWith('test_case'))!;
    expect(caseSpan.attributes['test.case.input']).toBeUndefined();
    expect(caseSpan.attributes['test.case.output']).toBeUndefined();
    logSpy.mockRestore();
  });
});
