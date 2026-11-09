// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { Benchmark, evaluate, defineScorer } from '../src/benchmark.js';
import { score } from '../src/score.js';
import { withObserve } from '../src/observe.js';
import { enrich } from '../src/enrich.js';
import { getFinishedLogRecords, getFinishedSpans, clearSpans } from './setup.js';

const TRACE_ID = 'abcdef1234567890abcdef1234567890';
const SPAN_ID = '1234567890abcdef';

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearSpans();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  clearSpans();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

function tracedTask(input: unknown): string {
  const tracer = trace.getTracer('test');
  return tracer.startActiveSpan('invoke_agent', (span) => {
    span.end();
    return `answer:${String(input)}`;
  });
}

describe('run name and description', () => {
  it('evaluate() stamps runName / runDescription on every result', () => {
    const result = evaluate({
      name: 'suite',
      runName: 'v5 with shorter prompt',
      runDescription: 'Shorter system prompt, same tools',
      task: tracedTask,
      data: [{ input: 'a' }, { input: 'b' }],
      scores: [function one() { return 1; }, function two() { return 0; }],
    });
    const records = getFinishedLogRecords();
    expect(records).toHaveLength(4);
    for (const r of records) {
      expect(r.attributes['opensearch.test.suite.run.name']).toBe('v5 with shorter prompt');
      expect(r.attributes['opensearch.test.suite.run.description']).toBe('Shorter system prompt, same tools');
      expect(r.attributes['test.suite.run.id']).toBe(result.summary.runId);
    }
    expect(result.summary.runName).toBe('v5 with shorter prompt');
  });

  it('evaluate() stamps them on error results too', () => {
    evaluate({
      name: 'suite',
      runName: 'r1',
      task: () => { throw new Error('boom'); },
      data: [{ input: 'a' }],
      scores: [function one() { return 1; }],
    });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['error.type']).toBe('Error');
    expect(r.attributes['opensearch.test.suite.run.name']).toBe('r1');
  });

  it('are absent when not given', () => {
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [() => 1] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['opensearch.test.suite.run.name']).toBeUndefined();
    expect(r.attributes['opensearch.test.suite.run.description']).toBeUndefined();
    expect(result.summary.runName).toBeUndefined();
  });

  it('truncates the description to 1024 characters', () => {
    const bm = new Benchmark('suite', { runName: 'n', runDescription: 'é'.repeat(2000) });
    bm.log({ scores: { a: 1 }, traceId: TRACE_ID, spanId: SPAN_ID });
    bm.close();
    const [r] = getFinishedLogRecords();
    expect(Array.from(r.attributes['opensearch.test.suite.run.description'] as string)).toHaveLength(1024);
  });

  it('Benchmark stamps them on every result and exposes runName', () => {
    const bm = new Benchmark('suite', { runName: 'nightly', runDescription: 'desc' });
    expect(bm.runName).toBe('nightly');
    bm.log({ scores: { a: 1, b: 0 }, traceId: TRACE_ID, spanId: SPAN_ID });
    const summary = bm.close();
    expect(summary.runName).toBe('nightly');
    const records = getFinishedLogRecords();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.attributes['opensearch.test.suite.run.name']).toBe('nightly');
      expect(r.attributes['opensearch.test.suite.run.description']).toBe('desc');
    }
  });

  it('cannot be overridden by run metadata', () => {
    const bm = new Benchmark('suite', {
      runName: 'real',
      metadata: { 'opensearch.test.suite.run.name': 'fake' },
    });
    bm.log({ scores: { a: 1 } });
    bm.close();
    expect(getFinishedLogRecords()[0].attributes['opensearch.test.suite.run.name']).toBe('real');
  });

  it('rejects a non-string runName', () => {
    expect(() => new Benchmark('suite', { runName: 5 as unknown as string })).toThrow(/runName/);
  });
});

describe('judge / evaluator context on score()', () => {
  it('maps the options to their attributes', () => {
    score({
      name: 'helpfulness',
      value: 4,
      traceId: TRACE_ID,
      evaluatorDescription: 'Rates how well the answer uses tool results',
      judgeModel: 'us.anthropic.claude-sonnet',
      judgePromptName: 'helpfulness_judge',
      judgePromptVersion: '2',
    });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.description']).toBe(
      'Rates how well the answer uses tool results',
    );
    expect(r.attributes['gen_ai.request.model']).toBe('us.anthropic.claude-sonnet');
    expect(r.attributes['gen_ai.prompt.name']).toBe('helpfulness_judge');
    expect(r.attributes['gen_ai.prompt.version']).toBe('2');
    // The judge's system prompt is never on a result event.
    expect(r.attributes['gen_ai.system_instructions']).toBeUndefined();
    expect(r.attributes['opensearch.gen_ai.evaluation.system_instructions_truncated']).toBeUndefined();
  });

  it('ignores a judgeSystemInstructions option: the prompt is not on results', () => {
    // Not part of ScoreOptions; a JS caller passing it gets nothing recorded.
    score({ name: 'x', value: 1, judgeSystemInstructions: 'You are a strict grader.' } as never);
    const [r] = getFinishedLogRecords();
    expect(r.attributes['gen_ai.system_instructions']).toBeUndefined();
    expect(r.attributes['opensearch.gen_ai.evaluation.system_instructions_truncated']).toBeUndefined();
  });

  it('keeps the full prompt on the judge span and name@version on the result', () => {
    const judgeTraceId = withObserve('answer_quality_judge', { op: 'chat' }, (span) => {
      enrich({ model: 'judge-model', systemInstructions: 'You are a strict grader.' });
      return span.spanContext().traceId;
    });
    score({
      name: 'answer_quality',
      value: 4,
      traceId: TRACE_ID,
      judgeTraceId,
      judgePromptName: 'strict-grader',
      judgePromptVersion: 'v3',
    });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['gen_ai.prompt.name']).toBe('strict-grader');
    expect(r.attributes['gen_ai.prompt.version']).toBe('v3');
    expect(r.attributes['opensearch.gen_ai.evaluation.judge.trace_id']).toBe(judgeTraceId);
    expect(r.attributes['gen_ai.system_instructions']).toBeUndefined();
    const judgeSpan = getFinishedSpans().find((sp) => sp.name.includes('answer_quality_judge'));
    expect(judgeSpan?.attributes['gen_ai.system_instructions']).toBe('You are a strict grader.');
  });

  it('drops the judge keys from extra attributes', () => {
    score({
      name: 'x',
      value: 1,
      attributes: { 'gen_ai.request.model': 'fake', 'gen_ai.system_instructions': 'leak', keep: 'yes' },
    });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['gen_ai.request.model']).toBeUndefined();
    expect(r.attributes['gen_ai.system_instructions']).toBeUndefined();
    expect(r.attributes.keep).toBe('yes');
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('judge / evaluator context on defineScorer()', () => {
  const judge = defineScorer(
    {
      name: 'helpfulness',
      threshold: 4,
      evaluator: 'helpfulness_judge',
      evaluatorType: 'llm_judge',
      evaluatorDescription: 'Is the answer grounded in the tool output?',
      judgeModel: 'judge-model',
      judgePromptName: 'helpfulness',
      judgePromptVersion: '3',
    },
    function helpfulness() { return 5; },
  );

  it('flows the declaration to every result of evaluate()', () => {
    evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }, { input: 'b' }], scores: [judge] });
    const records = getFinishedLogRecords();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.description']).toBe(
        'Is the answer grounded in the tool output?',
      );
      expect(r.attributes['gen_ai.request.model']).toBe('judge-model');
      expect(r.attributes['gen_ai.prompt.name']).toBe('helpfulness');
      expect(r.attributes['gen_ai.prompt.version']).toBe('3');
      expect(r.attributes['gen_ai.system_instructions']).toBeUndefined();
      expect(r.attributes['opensearch.gen_ai.evaluation.system_instructions_truncated']).toBeUndefined();
    }
  });

  it('keeps the declaration on the error result of a scorer that throws', () => {
    const failing = defineScorer(
      { name: 'q', judgeModel: 'judge-model', evaluatorDescription: 'desc' },
      function q(): number { throw new Error('judge down'); },
    );
    evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [failing] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['error.type']).toBe('Error');
    expect(r.attributes['gen_ai.request.model']).toBe('judge-model');
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.description']).toBe('desc');
  });

  it('a returned EvalScore overrides the declaration', () => {
    const s = defineScorer(
      { name: 'q', judgeModel: 'declared', judgePromptVersion: '1' },
      function q() { return { name: 'q', value: 1, judgeModel: 'actual' }; },
    );
    evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['gen_ai.request.model']).toBe('actual');
    expect(r.attributes['gen_ai.prompt.version']).toBe('1');
  });

  it('Benchmark.log() carries judge fields on EvalScore', () => {
    const bm = new Benchmark('suite', { runName: 'r' });
    bm.log({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      scores: [{ name: 'q', value: 1, judgeModel: 'm', judgePromptName: 'p', evaluatorDescription: 'd' }],
    });
    bm.close();
    const [r] = getFinishedLogRecords();
    expect(r.attributes['gen_ai.request.model']).toBe('m');
    expect(r.attributes['gen_ai.prompt.name']).toBe('p');
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.description']).toBe('d');
    expect(r.attributes['opensearch.test.suite.run.name']).toBe('r');
  });
});

describe('evaluator on EvalScore', () => {
  it('Benchmark.log() records evaluator name and type per score', () => {
    const bm = new Benchmark('suite');
    bm.log({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      scores: [
        { name: 'q', value: 4, evaluator: 'answer_quality_judge', evaluatorType: 'llm_judge' },
        { name: 'c', value: 1 },
      ],
    });
    bm.close();
    const [q, c] = getFinishedLogRecords();
    expect(q.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('answer_quality_judge');
    expect(q.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBe('llm_judge');
    expect(c.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBeUndefined();
  });

  it('a returned EvalScore evaluator wins over the declaration', () => {
    const s = defineScorer(
      { name: 'q', evaluator: 'declared', evaluatorType: 'code' },
      function q() { return { name: 'q', value: 1, evaluator: 'actual' }; },
    );
    evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('actual');
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBe('code');
  });
});
