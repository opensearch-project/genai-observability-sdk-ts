// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { Benchmark, evaluate, defineScorer, type EvalScore } from '../src/benchmark.js';
import { score } from '../src/score.js';
import { withObserve } from '../src/observe.js';
import { enrich } from '../src/enrich.js';
import { getFinishedLogRecords, getFinishedSpans, clearSpans } from './setup.js';
import { resetWarnedKeys } from '../src/internal.js';

const TRACE_ID = 'abcdef1234567890abcdef1234567890';
const SPAN_ID = '1234567890abcdef';

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearSpans();
  resetWarnedKeys();
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

  it('lets attributes set the judge keys, drops the system prompt; explicit options win', () => {
    score({
      name: 'x',
      value: 1,
      attributes: { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.prompt.name': 'p', 'gen_ai.system_instructions': 'leak', keep: 'yes' },
    });
    score({
      name: 'y',
      value: 1,
      judgeModel: 'judge-model',
      attributes: { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.system_instructions': 'leak' },
    });
    const [x, y] = getFinishedLogRecords();
    expect(x.attributes['gen_ai.request.model']).toBe('gpt-4o');
    expect(x.attributes['gen_ai.prompt.name']).toBe('p');
    expect(x.attributes['gen_ai.system_instructions']).toBeUndefined();
    expect(x.attributes.keep).toBe('yes');
    expect(y.attributes['gen_ai.request.model']).toBe('judge-model');
    expect(y.attributes['gen_ai.system_instructions']).toBeUndefined();
    // One warning for the dropped key, not one per score.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('gen_ai.system_instructions');
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

  it('a returned EvalScore evaluator wins over the declaration, without its type or judge', () => {
    // Named like the scorer's evaluation: the name does not make another evaluator's result its own.
    const s = defineScorer(
      {
        name: 'q',
        evaluator: 'declared',
        evaluatorType: 'code',
        judgeModel: 'gpt-x',
        evaluatorDescription: 'desc',
        threshold: 2,
      },
      function q() { return { name: 'q', value: 1, evaluator: 'actual' }; },
    );
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('actual');
    // Another evaluator's result: the declaration describes "declared", not "actual".
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBeUndefined();
    expect(r.attributes['gen_ai.request.model']).toBeUndefined();
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.description']).toBeUndefined();
    expect(r.attributes['opensearch.gen_ai.evaluation.score.threshold']).toBeUndefined();
    expect(result.cases[0].resultStatus).toBe('pass');
  });

  it("a scorer named like another evaluator's metric does not claim its result", () => {
    const s = defineScorer({ evaluator: 'wrapper', threshold: 4, scoreMax: 5 }, function faithfulness() {
      return [
        { name: 'quality', value: 4.5, evaluator: 'wrapper' },
        { name: 'faithfulness', value: 0.9, evaluator: 'deepeval.faithfulness' },
      ];
    });
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const byName = Object.fromEntries(
      getFinishedLogRecords().map(r => [r.attributes['gen_ai.evaluation.name'], r.attributes]),
    );
    expect(byName.faithfulness['opensearch.gen_ai.evaluation.score.threshold']).toBeUndefined();
    expect(byName.faithfulness['opensearch.gen_ai.evaluation.score.max']).toBeUndefined();
    expect(byName.faithfulness['gen_ai.evaluation.score.label']).toBeUndefined();
    expect(byName.quality['gen_ai.evaluation.score.label']).toBe('pass');
    expect(result.cases[0].resultStatus).toBe('pass');
  });

  it("a scorer with no evaluator named like another evaluator's metric does not claim it", () => {
    const s = defineScorer({ threshold: 0.7 }, function faithfulness() {
      return [{ name: 'faithfulness', value: 0.2, evaluator: 'deepeval.faithfulness' }];
    });
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['opensearch.gen_ai.evaluation.score.threshold']).toBeUndefined();
    expect(result.cases[0].resultStatus).toBe('pass');
  });

  it('an anonymous scorer does not claim a RAGAS result through the "score" fallback name', () => {
    const s = defineScorer({ threshold: 0.7 }, () => [{ name: 'score', value: 0.2, evaluator: 'ragas' }]);
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('ragas');
    expect(r.attributes['opensearch.gen_ai.evaluation.score.threshold']).toBeUndefined();
    expect(result.cases[0].resultStatus).toBe('pass');
  });

  it('a score with evaluator "" is the scorer\'s own', () => {
    const s = defineScorer(
      { name: 'rel', evaluator: 'my-judge', threshold: 0.7 },
      function rel() { return { name: 'relevance', value: 0.1, evaluator: '' }; },
    );
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('my-judge');
    expect(r.attributes['opensearch.gen_ai.evaluation.score.threshold']).toBe(0.7);
    expect(r.attributes['gen_ai.evaluation.score.label']).toBe('fail');
    expect(result.cases[0].resultStatus).toBe('fail');
  });

  it("with no declared evaluator, a score naming the function's name is the scorer's own", () => {
    const s = defineScorer({ name: 'quality', threshold: 0.7 }, function judge() {
      return [
        { name: 'q2', value: 0.1, evaluator: 'judge' },
        { name: 'q3', value: 0.9 },
      ];
    });
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const byName = Object.fromEntries(
      getFinishedLogRecords().map(r => [r.attributes['gen_ai.evaluation.name'], r.attributes]),
    );
    expect(byName.q2['gen_ai.evaluation.score.label']).toBe('fail');
    // The function name decides ownership only: it is not sent as an evaluator name.
    expect(byName.q3['opensearch.gen_ai.evaluation.evaluator.name']).toBeUndefined();
    expect(byName.q3['gen_ai.evaluation.score.label']).toBe('pass');
    expect(result.cases[0].resultStatus).toBe('fail');
  });

  it('warns once per scorer when its declared rule applies to no result', () => {
    const s = defineScorer({ threshold: 0.7 }, function deepevalWrap() {
      return [{ name: 'faithfulness', value: 0.2, evaluator: 'deepeval.faithfulness' }];
    });
    const own = defineScorer({ name: 'mine', threshold: 0.7 }, function mine() { return 0.9; });
    const data = [{ input: 'a' }, { input: 'b' }];
    const result = evaluate({ name: 'suite', task: tracedTask, data, scores: [s, own] });
    evaluate({ name: 'suite', task: tracedTask, data, scores: [s, own] });
    const warnings = warnSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes('applied to no result'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"deepevalWrap"');
    expect(warnings[0]).toContain('every result it returned names another evaluator');
    expect(result.cases[0].resultStatus).toBe('pass');
  });

  it("a scorer with no evaluator keeps its declaration off other evaluators' scores", () => {
    const s = defineScorer(
      {
        name: 'quality',
        threshold: 4,
        scoreMin: 1,
        scoreMax: 5,
        evaluatorType: 'llm_judge',
        evaluatorDescription: 'rubric',
        judgeModel: 'gpt-x',
        judgePromptName: 'quality-prompt',
        judgePromptVersion: '3',
      },
      function quality() {
        return [
          { name: 'quality', value: 4.5 },
          { name: 'faith', value: 0.9, evaluator: 'deepeval.faithfulness' },
        ];
      },
    );
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const byName = Object.fromEntries(
      getFinishedLogRecords().map(r => [r.attributes['gen_ai.evaluation.name'], r.attributes]),
    );
    for (const key of ['threshold', 'min', 'max', 'direction']) {
      expect(byName.faith[`opensearch.gen_ai.evaluation.score.${key}`]).toBeUndefined();
    }
    for (const key of [
      'opensearch.gen_ai.evaluation.evaluator.type',
      'opensearch.gen_ai.evaluation.evaluator.description',
      'gen_ai.request.model',
      'gen_ai.prompt.name',
      'gen_ai.prompt.version',
    ]) {
      expect(byName.faith[key]).toBeUndefined();
      expect(byName.quality[key]).toBeDefined();
    }
    expect(byName.quality['gen_ai.evaluation.score.label']).toBe('pass');
    expect(result.cases[0].resultStatus).toBe('pass');
  });

  it('another evaluator does not inherit the scorer direction', () => {
    const s = defineScorer(
      { name: 'latency', direction: 'minimize', threshold: 12 },
      function latency() {
        return [
          { name: 'latency', value: 3 },
          { name: 'faith', value: 0.9, threshold: 0.7, evaluator: 'deepeval.faithfulness' },
        ];
      },
    );
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const faith = getFinishedLogRecords().find(r => r.attributes['gen_ai.evaluation.name'] === 'faith')!;
    expect(faith.attributes['gen_ai.evaluation.score.label']).toBe('pass');
    expect(result.cases[0].resultStatus).toBe('pass');
  });

  it('Benchmark.log() evaluator defaults apply to scores of that evaluator; an EvalScore wins', () => {
    const bm = new Benchmark('suite');
    bm.log({
      scores: [
        { name: 'a', value: 1 },
        { name: 'b', value: 1, evaluator: 'own', evaluatorType: 'code' },
      ],
      evaluator: 'ragas',
      evaluatorType: 'llm_judge',
    });
    bm.log({ input: 'q2', scores: { c: 0.5 }, evaluator: 'ragas' });
    bm.close();
    const [a, own, c] = getFinishedLogRecords();
    expect(a.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('ragas');
    expect(a.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBe('llm_judge');
    expect(own.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('own');
    expect(own.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBe('code');
    expect(c.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('ragas');
    expect(c.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBeUndefined();
  });

  it('Benchmark.log() gives no default type to a score naming a different evaluator', () => {
    const bm = new Benchmark('suite');
    bm.log({
      evaluator: 'ragas',
      evaluatorType: 'llm_judge',
      scores: [
        { name: 'b', value: 1, evaluator: 'own' },
        { name: 'c', value: 1, evaluator: 'ragas' },
        { name: 'd', value: 1, evaluator: '' },
      ],
    });
    bm.log({ input: 'q2', evaluatorType: 'code', scores: [{ name: 'e', value: 1, evaluator: 'own' }] });
    bm.close();
    const [b, c, d, e] = getFinishedLogRecords();
    expect(b.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('own');
    expect(b.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBeUndefined();
    expect(c.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBe('llm_judge');
    expect(d.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('ragas');
    expect(d.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBe('llm_judge');
    expect(e.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBeUndefined();
  });

  it('Benchmark.log() error results keep the evaluator', () => {
    const bm = new Benchmark('suite');
    bm.log({ scores: [{ name: 'a', evaluator: 'judge_x' }], errorType: 'TimeoutError' });
    bm.close();
    const [r] = getFinishedLogRecords();
    expect(r.attributes['error.type']).toBe('TimeoutError');
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('judge_x');
  });
});

describe('judge context keys in metadata', () => {
  it('Benchmark run, case and EvalScore metadata can set them, warning-free', () => {
    const bm = new Benchmark('suite', { metadata: { 'gen_ai.request.model': 'gpt-4o' } });
    bm.log({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      metadata: { 'gen_ai.prompt.name': 'faithfulness' },
      scores: [
        { name: 'a', value: 1, metadata: { 'gen_ai.prompt.version': '2' } },
        { name: 'b', value: 1, judgeModel: 'explicit', metadata: { 'gen_ai.request.model': 'meta' } },
      ],
    });
    bm.close();
    const [a, b] = getFinishedLogRecords();
    expect(a.attributes['gen_ai.request.model']).toBe('gpt-4o');
    expect(a.attributes['gen_ai.prompt.name']).toBe('faithfulness');
    expect(a.attributes['gen_ai.prompt.version']).toBe('2');
    // The explicit judge field wins over metadata.
    expect(b.attributes['gen_ai.request.model']).toBe('explicit');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('evaluate() metadata can set them; a defineScorer() judge wins', () => {
    const judged = defineScorer({ name: 'j', judgeModel: 'declared' }, function j() { return 1; });
    evaluate({
      name: 'suite',
      task: tracedTask,
      data: [{ input: 'a' }],
      scores: [judged, function plain() { return 1; }],
      metadata: { 'gen_ai.request.model': 'from-metadata' },
    });
    const [j, plain] = getFinishedLogRecords();
    expect(j.attributes['gen_ai.request.model']).toBe('declared');
    expect(plain.attributes['gen_ai.request.model']).toBe('from-metadata');
  });

  it('a reserved-key warning does not silence the score() dropped-key hint for the same key', () => {
    new Benchmark('suite', { metadata: { 'error.type': 'x' } }).close();
    score({ name: 'a', value: 1, attributes: { 'error.type': 'y' } });
    const messages = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('error.type'));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('reserved');
    expect(messages[1]).toContain('use the score() options');
  });

  it('a dropped key is warned about once, not once per score', () => {
    const bm = new Benchmark('suite');
    for (let i = 0; i < 5; i++) {
      bm.log({ input: i, scores: [{ name: 'a', value: 1, metadata: { 'gen_ai.evaluation.name': 'x' } }] });
    }
    bm.close();
    const dropped = warnSpy.mock.calls.filter((c) => String(c[0]).includes('gen_ai.evaluation.name'));
    expect(dropped).toHaveLength(1);
  });
});

describe('scorer judge fields apply only to its own evaluator', () => {
  const multi = defineScorer(
    { name: 'judge', evaluator: 'my_judge', judgeModel: 'my-model', evaluatorDescription: 'mine', judgePromptName: 'p' },
    function judge() {
      return [
        { name: 'own', value: 1 },
        { name: 'same', value: 1, evaluator: 'my_judge' },
        { name: 'other', value: 1, evaluator: 'deepeval.faithfulness' },
      ];
    },
  );

  it('stamps them on unset or matching evaluators only', () => {
    evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [multi] });
    const byName = Object.fromEntries(getFinishedLogRecords().map((r) => [r.attributes['gen_ai.evaluation.name'], r]));
    for (const n of ['own', 'same']) {
      expect(byName[n].attributes['gen_ai.request.model']).toBe('my-model');
      expect(byName[n].attributes['opensearch.gen_ai.evaluation.evaluator.description']).toBe('mine');
      expect(byName[n].attributes['gen_ai.prompt.name']).toBe('p');
    }
    const other = byName['other'].attributes;
    expect(other['opensearch.gen_ai.evaluation.evaluator.name']).toBe('deepeval.faithfulness');
    expect(other['gen_ai.request.model']).toBeUndefined();
    expect(other['opensearch.gen_ai.evaluation.evaluator.description']).toBeUndefined();
    expect(other['gen_ai.prompt.name']).toBeUndefined();
  });
});

describe('a scorer declaration applies only to its own evaluator', () => {
  it('keeps evaluatorType, threshold, direction and bounds off another evaluator\'s results', () => {
    const wrapper = defineScorer(
      { name: 'wrapper', evaluator: 'wrapper', evaluatorType: 'code', threshold: 0.8, scoreMin: 0, scoreMax: 1 },
      () => [
        { name: 'faithfulness', value: 0.7, evaluator: 'deepeval.faithfulness' },
        { name: 'own', value: 0.7 },
      ],
    );
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [wrapper] });
    const byName = Object.fromEntries(getFinishedLogRecords().map((r) => [r.attributes['gen_ai.evaluation.name'], r]));
    const other = byName['faithfulness'].attributes;
    expect(other['opensearch.gen_ai.evaluation.evaluator.name']).toBe('deepeval.faithfulness');
    expect(other['opensearch.gen_ai.evaluation.evaluator.type']).toBeUndefined();
    expect(other['opensearch.gen_ai.evaluation.score.threshold']).toBeUndefined();
    expect(other['gen_ai.evaluation.score.label']).toBeUndefined();
    const own = byName['own'].attributes;
    expect(own['opensearch.gen_ai.evaluation.evaluator.name']).toBe('wrapper');
    expect(own['opensearch.gen_ai.evaluation.evaluator.type']).toBe('code');
    expect(own['gen_ai.evaluation.score.label']).toBe('fail');
    expect(result.cases[0].verdicts).toEqual({ own: 'fail' });
  });
});

describe('a scorer that declares no evaluator', () => {
  it('applies its threshold to a score with no evaluator, so a low score fails the case', () => {
    const rel = defineScorer({ name: 'rel', threshold: 0.7 }, () => ({ name: 'rel', value: 0.1 }));
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [rel] });
    expect(result.cases[0].resultStatus).toBe('fail');
    expect(result.cases[0].verdicts).toEqual({ rel: 'fail' });
    const [record] = getFinishedLogRecords();
    expect(record.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBeUndefined();
    expect(record.attributes['opensearch.gen_ai.evaluation.score.threshold']).toBe(0.7);
    expect(record.attributes['gen_ai.evaluation.score.label']).toBe('fail');
  });

  it('does not apply it to a score that names an evaluator, whatever its name', () => {
    const rel = defineScorer({ name: 'rel', threshold: 0.7 }, () => ({ name: 'rel', value: 0.1, evaluator: 'my-judge' }));
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [rel] });
    expect(result.cases[0].resultStatus).toBe('pass');
    const [record] = getFinishedLogRecords();
    expect(record.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('my-judge');
    expect(record.attributes['opensearch.gen_ai.evaluation.score.threshold']).toBeUndefined();
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('applied to no result'))).toBe(true);
  });
});

describe('returned EvalScore fields are validated like defineScorer()', () => {
  for (const [field, bad] of [
    ['evaluatorType', 'llm-judge'],
    ['judgeModel', 123],
    ['judgePromptName', {}],
    ['judgePromptVersion', 2],
    ['evaluatorDescription', false],
    ['direction', 'up'],
    ['threshold', Number.NaN],
  ] as const) {
    it(`rejects ${field}: ${String(bad)}`, () => {
      const s = function q() { return { name: 'q', value: 1, [field]: bad }; };
      const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s as never] });
      const [r] = getFinishedLogRecords();
      expect(r.attributes['error.type']).toBe('TypeError');
      expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBeUndefined();
      expect(r.attributes['gen_ai.request.model']).toBeUndefined();
      expect(result.cases[0].scorerErrors?.[0]).toContain(field);
    });
  }
});

describe('Benchmark.log() validates scores like evaluate()', () => {
  for (const [label, options] of [
    ['log evaluatorType', { evaluatorType: 'llm-judge', scores: [{ name: 'x', value: 1 }] }],
    ['log evaluator', { evaluator: 5, scores: [{ name: 'x', value: 1 }] }],
    ['EvalScore judgeModel', { scores: [{ name: 'x', value: 1, judgeModel: 5 }] }],
    ['EvalScore evaluatorType', { scores: [{ name: 'x', value: 1, evaluatorType: 'llm-judge' }] }],
    ['EvalScore threshold', { scores: [{ name: 'x', value: 1, threshold: Number.NaN }] }],
    ['EvalScore value', { scores: [{ name: 'x', value: 'high' }] }],
  ] as const) {
    it(`throws a TypeError for an invalid ${label} and emits nothing`, () => {
      const bm = new Benchmark('suite');
      expect(() => bm.log(options as never)).toThrow(TypeError);
      expect(getFinishedLogRecords()).toHaveLength(0);
    });
  }

  it('with errorType, skips the value checks and logs the error result (a timed-out metric)', () => {
    const bm = new Benchmark('suite');
    bm.log({ errorType: 'TimeoutError', scores: { faithfulness: Number.NaN } });
    bm.log({ errorType: 'TimeoutError', scores: [{ name: 'relevance', value: Number.NaN, label: 5 as never, passed: 'no' as never }] });
    const records = getFinishedLogRecords();
    expect(records.map((r) => r.attributes['gen_ai.evaluation.name'])).toEqual(['faithfulness', 'relevance']);
    for (const r of records) {
      expect(r.attributes['error.type']).toBe('TimeoutError');
      expect(r.attributes['gen_ai.evaluation.score.value']).toBeUndefined();
      expect(r.attributes['gen_ai.evaluation.score.label']).toBeUndefined();
    }
    expect(bm.close().errorCount).toBe(2);
  });

  it('with errorType, still needs a score name', () => {
    const bm = new Benchmark('suite');
    expect(() => bm.log({ errorType: 'TimeoutError', scores: [{ value: 1 } as never] })).toThrow(TypeError);
    expect(getFinishedLogRecords()).toHaveLength(0);
  });

  it('treats null EvalScore fields as unset', () => {
    const bm = new Benchmark('suite');
    bm.log({ scores: [JSON.parse('{"name":"rel","value":0.9,"explanation":null,"threshold":null}') as EvalScore] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['gen_ai.evaluation.score.value']).toBe(0.9);
    expect(bm.close().passCount).toBe(1);
  });
});

describe('an EvalScore that is a class instance', () => {
  /** A judge result whose fields are prototype getters, like a framework's score class. */
  class JudgeScore {
    constructor(private readonly raw: { metric: string; score: number; reason: string }) {}
    get name(): string { return this.raw.metric; }
    get value(): number { return this.raw.score; }
    get explanation(): string { return this.raw.reason; }
    get threshold(): number { return 0.5; }
  }

  it('is read through its getters in evaluate()', () => {
    const judge = function rel() { return new JudgeScore({ metric: 'rel', score: 0.9, reason: 'on topic' }) as unknown as EvalScore; };
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [judge] });
    expect(result.cases[0].resultStatus).toBe('pass');
    expect(result.cases[0].scores).toEqual({ rel: 0.9 });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['error.type']).toBeUndefined();
    expect(r.attributes['gen_ai.evaluation.explanation']).toBe('on topic');
    expect(r.attributes['gen_ai.evaluation.score.label']).toBe('pass');
  });

  it('is read through its getters in Benchmark.log()', () => {
    const bm = new Benchmark('suite');
    bm.log({ scores: [new JudgeScore({ metric: 'rel', score: 0.2, reason: 'off topic' }) as unknown as EvalScore] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['gen_ai.evaluation.name']).toBe('rel');
    expect(r.attributes['gen_ai.evaluation.score.value']).toBe(0.2);
    expect(r.attributes['gen_ai.evaluation.score.label']).toBe('fail');
    expect(bm.close().failCount).toBe(1);
  });
});

describe('null optional EvalScore fields are unset', () => {
  it('keeps a JSON judge score whose explanation, label and bounds are null', () => {
    const judge = function rel() {
      return JSON.parse(
        '{"name":"rel","value":0.9,"explanation":null,"label":null,"threshold":null,"scoreMin":null,' +
          '"scoreMax":null,"direction":null,"evaluatorType":null,"judgeModel":null,"metadata":null}',
      ) as EvalScore;
    };
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [judge] });
    expect(result.cases[0].resultStatus).toBe('pass');
    expect(result.cases[0].scores).toEqual({ rel: 0.9 });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['error.type']).toBeUndefined();
    expect(r.attributes['gen_ai.evaluation.score.value']).toBe(0.9);
    expect(r.attributes['gen_ai.evaluation.explanation']).toBeUndefined();
  });

  it('treats a null value as no value (a label-only score)', () => {
    const judge = function verdict() {
      return JSON.parse('{"name":"verdict","value":null,"label":"pass"}') as EvalScore;
    };
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [judge] });
    expect(result.cases[0].resultStatus).toBe('pass');
    expect(result.cases[0].scores).toEqual({});
    const [r] = getFinishedLogRecords();
    expect(r.attributes['gen_ai.evaluation.score.label']).toBe('pass');
    expect(r.attributes['gen_ai.evaluation.score.value']).toBeUndefined();
  });
});

describe('run labels stay off agent spans', () => {
  it('evaluate() runName / runDescription are on results, not on the agent root span', () => {
    evaluate({
      name: 'suite',
      runName: 'nightly',
      runDescription: 'desc',
      task: (q) => withObserve('agent', { op: 'invoke_agent' }, () => `a:${String(q)}`),
      data: [{ input: 'a' }],
      scores: [function one() { return 1; }],
    });
    const root = getFinishedSpans().find((sp) => sp.name === 'invoke_agent agent');
    expect(root).toBeDefined();
    expect(root!.attributes['test.suite.run.id']).toBeDefined();
    expect(root!.attributes['opensearch.test.suite.run.name']).toBeUndefined();
    expect(root!.attributes['opensearch.test.suite.run.description']).toBeUndefined();
    const [r] = getFinishedLogRecords();
    expect(r.attributes['opensearch.test.suite.run.name']).toBe('nightly');
  });
});

describe('local results are keyed by evaluator, so a fail is never hidden', () => {
  it("a foreign pass does not hide the scorer's own fail", () => {
    const s = defineScorer({ name: 'faithfulness', threshold: 0.7 }, function faith() {
      return [
        { name: 'faithfulness', value: 0.2 },
        { name: 'faithfulness', value: 0.95, evaluator: 'deepeval.faithfulness', passed: true },
      ];
    });
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const c = result.cases[0];
    expect(c.resultStatus).toBe('fail');
    expect(c.verdicts).toEqual({ faithfulness: 'fail', 'faithfulness (deepeval.faithfulness)': 'pass' });
    expect(c.scores).toEqual({ faithfulness: 0.2, 'faithfulness (deepeval.faithfulness)': 0.95 });
    expect(result.summary.scores.faithfulness.avg).toBeCloseTo(0.2);
    expect(result.summary.scores['faithfulness (deepeval.faithfulness)'].avg).toBeCloseTo(0.95);
    expect(result.summary.failCount).toBe(1);
  });

  it("a scorer's own results keep the plain key, whatever the order of results", () => {
    const s = defineScorer({ name: 'faithfulness', threshold: 0.7 }, function faith() {
      return [
        { name: 'faithfulness', value: 0.95, evaluator: 'deepeval', passed: true },
        { name: 'faithfulness', value: 0.2 },
      ];
    });
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }, { input: 'b' }], scores: [s] });
    for (const c of result.cases) {
      expect(c.resultStatus).toBe('fail');
      expect(c.scores).toEqual({ faithfulness: 0.2, 'faithfulness (deepeval)': 0.95 });
    }
    expect(result.summary.scores.faithfulness.count).toBe(2);
  });

  it("a scorer's own results keep the plain key when it throws in the first case", () => {
    let call = 0;
    const own = defineScorer({ name: 'faithfulness', threshold: 0.7 }, function faith() {
      call += 1;
      if (call === 1) throw new Error('judge down');
      return 0.2;
    });
    const deepeval = () => ({ name: 'faithfulness', value: 0.95, evaluator: 'deepeval', passed: true });
    const data = [{ input: 'a' }, { input: 'b' }, { input: 'c' }];
    const result = evaluate({ name: 'suite', task: tracedTask, data, scores: [own, deepeval] });
    expect(result.summary.scores.faithfulness.avg).toBeCloseTo(0.2);
    expect(result.summary.scores['faithfulness (deepeval)'].avg).toBeCloseTo(0.95);
    expect(result.cases[1].verdicts).toEqual({ faithfulness: 'fail', 'faithfulness (deepeval)': 'pass' });
  });

  it('a synthetic key never collides with a real evaluation name', () => {
    const b = new Benchmark('b');
    b.log({
      input: 'q',
      scores: [
        { name: 'f', value: 0.9, evaluator: 'a' },
        { name: 'f', value: 0.1, evaluator: 'b', passed: false },
        { name: 'f (b)', value: 0.95, evaluator: 'c' },
      ],
    });
    const summary = b.close();
    expect(summary.scores['f (b)'].avg).toBeCloseTo(0.1);
    expect(summary.scores['f (b) (2)'].avg).toBeCloseTo(0.95);
  });

  it('a result with no value and no verdict claims no key', () => {
    const b = new Benchmark('b');
    b.log({ input: 'q', scores: [{ name: 'f', label: 'good', evaluator: 'x' }, { name: 'f', value: 0.5, evaluator: 'y' }] });
    expect(b.close().scores.f.avg).toBeCloseTo(0.5);
  });

  it('keeps the value of a failing result of one evaluator over a later pass', () => {
    const s = defineScorer({ name: 'judge', threshold: 0.5 }, function judge() {
      return [{ name: 'judge', value: 0.1 }, { name: 'judge', value: 0.9 }];
    });
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    expect(result.cases[0].scores).toEqual({ judge: 0.1 });
    expect(result.cases[0].verdicts).toEqual({ judge: 'fail' });
  });

  it('records an evaluation named __proto__, with its fail verdict', () => {
    const b = new Benchmark('b');
    b.log({ input: 'q', scores: [{ name: '__proto__', value: 0.1, passed: false }] });
    const summary = b.close();
    expect(summary.failCount).toBe(1);
    expect(Object.keys(summary.scores)).toEqual(['__proto__']);
  });

  it('a Benchmark.log() call that throws claims no key', () => {
    const b = new Benchmark('b');
    expect(() =>
      b.log({ input: 'q', traceId: 5 as unknown as string, spanId: SPAN_ID, scores: [{ name: 'f', value: 0.1, evaluator: 'x' }] }),
    ).toThrow();
    b.log({ input: 'q', scores: [{ name: 'f', value: 0.5, evaluator: 'y' }] });
    expect(b.close().scores.f.avg).toBeCloseTo(0.5);
  });

  it('two scorers with the same evaluation name', () => {
    const strictScorer = defineScorer({ name: 'quality', threshold: 0.5 }, function strict() { return 0.1; });
    const lenientScorer = defineScorer({ name: 'quality', threshold: 0.05 }, function lenient() { return 0.1; });
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [strictScorer, lenientScorer] });
    expect(result.cases[0].resultStatus).toBe('fail');
    expect(result.cases[0].verdicts).toEqual({ quality: 'fail', 'quality (lenient)': 'pass' });
  });

  it('results of one evaluator with the same name keep a fail', () => {
    const s = defineScorer({ name: 'judge' }, function judge() {
      return [
        { name: 'judge', value: 0.1, passed: false },
        { name: 'judge', value: 0.9, passed: true },
      ];
    });
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    expect(result.cases[0].resultStatus).toBe('fail');
    expect(result.cases[0].verdicts).toEqual({ judge: 'fail' });
  });

  it('Benchmark.log() keys by evaluator too', () => {
    const b = new Benchmark('b');
    b.log({
      input: 'q',
      scores: [
        { name: 'f', value: 0.2, passed: false, evaluator: 'own' },
        { name: 'f', value: 0.9, passed: true, evaluator: 'ragas' },
        { name: 'f', value: 0.5, passed: true },
      ],
    });
    b.log({ input: 'q2', scores: [{ name: 'f', value: 0.4, evaluator: 'ragas' }] });
    b.log({
      input: 'q3',
      evaluator: 'own',
      scores: [{ name: 'f', value: 0.1, passed: false }, { name: 'f', value: 0.9, passed: true, evaluator: 'own' }],
    });
    const summary = b.close();
    expect(summary.failCount).toBe(2);
    expect(summary.scores['f (ragas)'].count).toBe(2);
    expect(summary.scores['f (no evaluator)'].count).toBe(1);
    expect(summary.scores.f.count).toBe(2);
  });
});

describe('evaluator names are trimmed and checked', () => {
  it('a trailing space on a score still makes it the scorer\'s own, and is sent trimmed', () => {
    const s = defineScorer({ evaluator: 'judge', threshold: 0.5 }, function j() {
      return { name: 'j', value: 0.1, evaluator: 'judge ' };
    });
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('judge');
    expect(r.attributes['opensearch.gen_ai.evaluation.score.threshold']).toBe(0.5);
    expect(result.cases[0].resultStatus).toBe('fail');
  });

  it('defineScorer() and Benchmark.log() evaluators are trimmed; blank is unset', () => {
    const paddedScorer = defineScorer({ evaluator: ' ragas ' }, function padded() { return 0.9; });
    const blankScorer = defineScorer({ evaluator: '   ', threshold: 0.5 }, function blank() {
      return { name: 'b', value: 0.1, evaluator: 'blank' };
    });
    expect(paddedScorer.scorerSpec.evaluator).toBe('ragas');
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [paddedScorer, blankScorer] });
    const b = new Benchmark('b');
    b.log({ input: 'q', scores: { x: 1 }, evaluator: ' deepeval ' });
    b.log({ input: 'q', scores: { y: 1 }, evaluator: '  ' });
    b.close();
    const names = getFinishedLogRecords().map(r => r.attributes['opensearch.gen_ai.evaluation.evaluator.name']);
    // `blank` falls back to its function name for ownership, so its threshold applies.
    expect(names).toEqual(['ragas', 'blank', 'deepeval', undefined]);
    expect(result.cases[0].resultStatus).toBe('fail');
  });

  it('defineScorer() rejects non-string judge fields, like a returned EvalScore', () => {
    for (const field of ['evaluatorDescription', 'judgeModel', 'judgePromptName', 'judgePromptVersion']) {
      expect(() => defineScorer({ [field]: 5 } as never, () => 1)).toThrow(`${field} must be a string`);
    }
  });

  it('a nested defineScorer() keeps the inner scorer\'s evaluator as owner', () => {
    const inner = defineScorer({ evaluator: 'deepeval' }, function wrap() {
      return { name: 'f', value: 0.1, evaluator: 'deepeval' };
    });
    const outer = defineScorer({ threshold: 0.5 }, inner);
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [outer] });
    expect(result.cases[0].resultStatus).toBe('fail');
    expect(warnSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes('applied to no result'))).toEqual([]);
  });

  it('defineScorer() rejects a non-string evaluator with a clear error', () => {
    expect(() => defineScorer({ evaluator: 123 as unknown as string }, () => 1)).toThrow(
      'evaluator must be a string',
    );
  });
});

describe('the unused-declaration warning', () => {
  const foreign = (name: string): EvalScore => ({ name, value: 0.2, evaluator: `deepeval.${name}` });
  const unused = () => warnSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes('applied to no result'));

  it('warns once per evaluation name and evaluator; other names each warn', () => {
    const make = (name: string, metric: string) => defineScorer({ name, threshold: 0.7 }, () => [foreign(metric)]);
    const data = [{ input: 'a' }, { input: 'b' }];
    evaluate({ name: 'suite', task: tracedTask, data, scores: [make('faith', 'faith'), make('relevancy', 'relevancy')] });
    expect(unused()).toHaveLength(2);
    evaluate({ name: 'suite', task: tracedTask, data, scores: [make('faith', 'faith'), make('faith', 'other')] });
    expect(unused()).toHaveLength(2);
  });

  it('a scorer rebuilt per run with the same name and evaluator warns once per process', () => {
    const make = () => defineScorer({ name: 'faith', evaluator: 'wrap', threshold: 0.7 }, () => [foreign('faith')]);
    for (let i = 0; i < 3; i++) {
      evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [make()] });
    }
    expect(unused()).toHaveLength(1);
  });

  it('non-rule declarations warn too, with the evaluators involved', () => {
    const s = defineScorer(
      { evaluatorType: 'llm_judge', judgeModel: 'gpt-4o', evaluatorDescription: 'checks X' },
      function faithfulnessV2() { return [{ name: 'faithfulness', value: 0.2, evaluator: 'faithfulness' }]; },
    );
    evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const [w] = unused();
    expect(w).toContain('evaluatorType, evaluatorDescription, judgeModel');
    expect(w).toContain('evaluator "faithfulnessV2" (the function name)');
    expect(w).toContain('"faithfulness"');
  });

  it("does not warn when the scorer's own result appears in only one case of the run", () => {
    let call = 0;
    const s = defineScorer({ threshold: 0.7 }, function judge() {
      call += 1;
      return call === 2 ? [{ name: 'judge', value: 0.9 }] : [foreign('faith')];
    });
    const data = [{ input: 'a' }, { input: 'b' }, { input: 'c' }];
    evaluate({ name: 'suite', task: tracedTask, data, scores: [s] });
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('to no result'))).toBe(false);
  });

  it('warns once, at the end of the run, when no case has an own result', () => {
    const s = defineScorer({ threshold: 0.7 }, function judge() { return [foreign('faith')]; });
    const recordsAtWarning: number[] = [];
    warnSpy.mockImplementation((m: unknown) => {
      if (String(m).includes('to no result')) recordsAtWarning.push(getFinishedLogRecords().length);
    });
    const data = [{ input: 'a' }, { input: 'b' }, { input: 'c' }];
    evaluate({ name: 'suite', task: tracedTask, data, scores: [s] });
    // Decided once, after every case of the run was scored.
    expect(recordsAtWarning).toEqual([3]);
    expect(unused()).toHaveLength(1);
    expect(unused()[0]).toContain('["deepeval.faith"]');
  });

  it('a threshold-only declaration does not list the defaulted direction', () => {
    const s = defineScorer({ threshold: 0.7 }, function judge() { return [foreign('faith')]; });
    expect(s.scorerSpec.direction).toBe('maximize');
    evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const [w] = unused();
    expect(w).toContain('declares threshold, which');
    expect(w).not.toContain('direction');
  });

  it('an explicitly declared direction is listed', () => {
    const s = defineScorer({ threshold: 0.7, direction: 'maximize' }, function judge() {
      return [foreign('faith')];
    });
    evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    expect(unused()[0]).toContain('declares threshold, direction, which');
  });

  it("Benchmark.log() does not warn when its evaluatorType reaches a score in one call of the run", () => {
    const b = new Benchmark('b');
    for (const input of ['q1', 'q2', 'q3']) {
      const scores = input === 'q2' ? [{ name: 'f', value: 1 }] : [foreign('faith')];
      b.log({ input, scores, evaluator: 'deepeval', evaluatorType: 'llm_judge' });
    }
    b.close();
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('to no score'))).toBe(false);
  });

  it('Benchmark.log() decides its evaluatorType warning at close()', () => {
    const b = new Benchmark('b');
    b.log({ input: 'q', scores: [foreign('faith')], evaluator: 'deepeval', evaluatorType: 'llm_judge' });
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('to no score'))).toBe(false);
    b.close();
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('applied to no score'))).toHaveLength(1);
  });

  it('Benchmark.log() warns once when its evaluatorType reaches no score', () => {
    const b = new Benchmark('b');
    for (const input of ['q1', 'q2']) {
      b.log({ input, scores: [foreign('faith')], evaluator: 'deepeval', evaluatorType: 'llm_judge' });
    }
    b.log({ input: 'q3', scores: [{ name: 'g', value: 1 }], evaluator: 'ragas', evaluatorType: 'llm_judge' });
    b.close();
    const w = warnSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes('applied to no score'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"deepeval.faith"');
  });
});

describe('run metadata judge keys are run-level', () => {
  it("go on other evaluators' results; defineScorer() judge fields win on its own", () => {
    const s = defineScorer({ judgeModel: 'own-model' }, function judge() {
      return [{ name: 'own', value: 1 }, { name: 'faith', value: 1, evaluator: 'deepeval' }];
    });
    evaluate({
      name: 'suite',
      task: tracedTask,
      data: [{ input: 'a' }],
      scores: [s],
      metadata: { 'gen_ai.request.model': 'run-model' },
    });
    const models = Object.fromEntries(
      getFinishedLogRecords().map(r => [r.attributes['gen_ai.evaluation.name'], r.attributes['gen_ai.request.model']]),
    );
    expect(models).toEqual({ own: 'own-model', faith: 'run-model' });
  });
});
