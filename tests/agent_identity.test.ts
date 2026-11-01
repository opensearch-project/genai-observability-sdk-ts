// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { Benchmark, evaluate } from '../src/benchmark.js';
import { score } from '../src/score.js';
import { agentDefaults, resolveAgent, setAgentDefaults } from '../src/internal.js';
import { getFinishedSpans, getFinishedLogRecords, clearSpans } from './setup.js';

const NAME = 'gen_ai.agent.name';
const VERSION = 'agent.version';
const events = (name: string) =>
  getFinishedLogRecords()
    .filter(r => r.eventName === name)
    .map(r => r.attributes);
const EVAL = 'gen_ai.evaluation.result';
const CASE = 'opensearch.test_case.result';
const RUN = 'opensearch.test_suite_run.result';

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  clearSpans();
  setAgentDefaults(undefined, undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  clearSpans();
  setAgentDefaults(undefined, undefined);
  logSpy.mockRestore();
});

describe('resolveAgent', () => {
  it('leaves an unknown agent out', () => {
    expect(resolveAgent()).toEqual({});
  });

  it('uses the register() defaults', () => {
    setAgentDefaults('travel_planner', 'v3');
    expect(agentDefaults()).toEqual(['travel_planner', 'v3']);
    expect(resolveAgent()).toEqual({ [NAME]: 'travel_planner', [VERSION]: 'v3' });
  });

  it('prefers explicit, then the span, then the default', () => {
    setAgentDefaults('default_agent', 'v1');
    const tracer = trace.getTracer('t');
    tracer.startActiveSpan('invoke_agent', { attributes: { [NAME]: 'span_agent' } }, span => {
      expect(resolveAgent(undefined, undefined, span)).toEqual({ [NAME]: 'span_agent', [VERSION]: 'v1' });
      expect(resolveAgent('explicit', 'v9', span)).toEqual({ [NAME]: 'explicit', [VERSION]: 'v9' });
      span.end();
    });
  });
});

describe('score()', () => {
  it('stamps the register() default', () => {
    setAgentDefaults('travel_planner', 'v2');
    score({ name: 'helpfulness', value: 0.8, traceId: '6ebb9835f43af1552f2cebb9f5165e39' });
    expect(events(EVAL)[0][NAME]).toBe('travel_planner');
    expect(events(EVAL)[0][VERSION]).toBe('v2');
  });

  it('reads the agent from the active span when inline', () => {
    setAgentDefaults('default_agent');
    const tracer = trace.getTracer('t');
    tracer.startActiveSpan(
      'invoke_agent',
      { attributes: { [NAME]: 'support_bot', [VERSION]: 'v4' } },
      span => {
        score({ name: 'helpfulness', value: 0.8 });
        span.end();
      },
    );
    expect(events(EVAL)[0][NAME]).toBe('support_bot');
    expect(events(EVAL)[0][VERSION]).toBe('v4');
  });

  it('takes an explicit agent', () => {
    setAgentDefaults('default_agent', 'v1');
    score({ name: 'helpfulness', value: 0.8, agentName: 'rag_faq', agentVersion: 'v7' });
    expect(events(EVAL)[0][NAME]).toBe('rag_faq');
    expect(events(EVAL)[0][VERSION]).toBe('v7');
  });

  it('leaves an unknown agent out', () => {
    score({ name: 'helpfulness', value: 0.8 });
    expect(events(EVAL)[0][NAME]).toBeUndefined();
    expect(events(EVAL)[0][VERSION]).toBeUndefined();
  });
});

describe('Benchmark', () => {
  it('stamps the declared agent on score, case and run events', () => {
    const bm = new Benchmark('suite', { agentName: 'travel_planner', agentVersion: 'v3' });
    bm.log({ input: 'q', output: 'a', scores: { accuracy: 1 } });
    bm.close();
    for (const name of [EVAL, CASE, RUN]) {
      expect(events(name)[0][NAME], name).toBe('travel_planner');
      expect(events(name)[0][VERSION], name).toBe('v3');
    }
  });

  it('uses the register() default', () => {
    setAgentDefaults('support_bot', 'v1');
    const bm = new Benchmark('suite');
    bm.log({ input: 'q', output: 'a' });
    bm.close();
    expect(events(RUN)[0][NAME]).toBe('support_bot');
    expect(events(CASE)[0][VERSION]).toBe('v1');
  });

  it('declared version beats a metadata agent.version', () => {
    const bm = new Benchmark('suite', { metadata: { [VERSION]: 'meta' }, agentVersion: 'v5' });
    bm.close();
    expect(events(RUN)[0][VERSION]).toBe('v5');
  });
});

describe('evaluate()', () => {
  const agent = (attributes: Record<string, string> = {}) => {
    const tracer = trace.getTracer('agent');
    return (input: unknown) => {
      const span = tracer.startSpan('invoke_agent', { attributes });
      span.end();
      return `answer to ${String(input)}`;
    };
  };

  it('stamps the declared agent on root spans and every event', () => {
    evaluate({
      name: 'suite',
      task: agent(),
      data: [{ input: 'q1' }, { input: 'q2' }],
      scores: [() => 1],
      agentName: 'travel_planner',
      agentVersion: 'v3',
    });
    const roots = getFinishedSpans().filter(s => s.name === 'invoke_agent');
    expect(roots).toHaveLength(2);
    for (const span of roots) {
      expect(span.attributes[NAME]).toBe('travel_planner');
      expect(span.attributes[VERSION]).toBe('v3');
      expect(span.attributes['test.suite.name']).toBe('suite');
    }
    for (const name of [EVAL, CASE, RUN]) {
      for (const a of events(name)) {
        expect(a[NAME], name).toBe('travel_planner');
        expect(a[VERSION], name).toBe('v3');
      }
    }
  });

  it("keeps the root span's own agent over the default", () => {
    setAgentDefaults('default_agent', 'v1');
    evaluate({ name: 'suite', task: agent({ [NAME]: 'support_bot' }), data: [{ input: 'q' }], scores: [() => 1] });
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent');
    expect(root?.attributes[NAME]).toBe('support_bot');
    expect(root?.attributes[VERSION]).toBe('v1');
    expect(events(CASE)[0][NAME]).toBe('support_bot');
    expect(events(EVAL)[0][NAME]).toBe('support_bot');
    expect(events(RUN)[0][NAME]).toBe('support_bot');
  });

  it('names no run agent when cases disagree', () => {
    const tracer = trace.getTracer('agent');
    const names = ['a1', 'a2'];
    let i = 0;
    evaluate({
      name: 'suite',
      task: input => {
        tracer.startSpan('invoke_agent', { attributes: { [NAME]: names[i++] } }).end();
        return input;
      },
      data: [{ input: 'x' }, { input: 'y' }],
      scores: [],
    });
    expect(new Set(events(CASE).map(a => a[NAME]))).toEqual(new Set(['a1', 'a2']));
    expect(events(RUN)[0][NAME]).toBeUndefined();
  });

  it('leaves an unknown agent out', () => {
    evaluate({ name: 'suite', task: q => q, data: [{ input: 'x' }], scores: [() => 1] });
    for (const name of [EVAL, CASE, RUN]) expect(events(name)[0][NAME]).toBeUndefined();
  });
});
