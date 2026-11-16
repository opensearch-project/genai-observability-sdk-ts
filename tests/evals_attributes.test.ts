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

  it('a returned EvalScore evaluator wins over the declaration, without its type', () => {
    const s = defineScorer(
      { name: 'q', evaluator: 'declared', evaluatorType: 'code' },
      function q() { return { name: 'q', value: 1, evaluator: 'actual' }; },
    );
    evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [s] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('actual');
    // Another evaluator's result: the declared type describes "declared", not "actual".
    expect(r.attributes['opensearch.gen_ai.evaluation.evaluator.type']).toBeUndefined();
  });

  it('Benchmark.log() evaluator defaults apply to every score; an EvalScore wins', () => {
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
  it('applies its threshold to a score that names an evaluator, so a low score fails the case', () => {
    const rel = defineScorer({ name: 'rel', threshold: 0.7 }, () => ({ name: 'rel', value: 0.1, evaluator: 'my-judge' }));
    const result = evaluate({ name: 'suite', task: tracedTask, data: [{ input: 'a' }], scores: [rel] });
    expect(result.cases[0].resultStatus).toBe('fail');
    expect(result.cases[0].verdicts).toEqual({ rel: 'fail' });
    const [record] = getFinishedLogRecords();
    expect(record.attributes['opensearch.gen_ai.evaluation.evaluator.name']).toBe('my-judge');
    expect(record.attributes['opensearch.gen_ai.evaluation.score.threshold']).toBe(0.7);
    expect(record.attributes['gen_ai.evaluation.score.label']).toBe('fail');
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

  it('treats null EvalScore fields as unset', () => {
    const bm = new Benchmark('suite');
    bm.log({ scores: [JSON.parse('{"name":"rel","value":0.9,"explanation":null,"threshold":null}') as EvalScore] });
    const [r] = getFinishedLogRecords();
    expect(r.attributes['gen_ai.evaluation.score.value']).toBe(0.9);
    expect(bm.close().passCount).toBe(1);
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
