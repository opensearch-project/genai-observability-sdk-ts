// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { ciPipelineAttributes } from '../src/cicd.js';
import { evaluate, Benchmark } from '../src/benchmark.js';
import { getFinishedLogRecords, getFinishedSpans, clearSpans } from './setup.js';

const GITHUB = {
  GITHUB_ACTIONS: 'true',
  GITHUB_WORKFLOW: 'agent-evals',
  GITHUB_RUN_ID: '120912',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'acme/agents',
};
const CI_ENV_KEYS = ['GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL', ...Object.keys(GITHUB)];

describe('ciPipelineAttributes', () => {
  it('is empty outside CI', () => {
    expect(ciPipelineAttributes(undefined, {})).toEqual({});
  });

  it('reads GitHub Actions', () => {
    expect(ciPipelineAttributes(undefined, GITHUB)).toEqual({
      'cicd.pipeline.name': 'agent-evals',
      'cicd.pipeline.run.id': '120912',
      'cicd.pipeline.run.url.full': 'https://github.com/acme/agents/actions/runs/120912',
    });
  });

  it('reads GitLab CI', () => {
    const env = { GITLAB_CI: 'true', CI_PIPELINE_NAME: 'evals', CI_PIPELINE_ID: '7', CI_PIPELINE_URL: 'https://gl/p/7' };
    expect(ciPipelineAttributes(undefined, env)).toEqual({
      'cicd.pipeline.name': 'evals',
      'cicd.pipeline.run.id': '7',
      'cicd.pipeline.run.url.full': 'https://gl/p/7',
    });
  });

  it('reads Jenkins', () => {
    const env = { JENKINS_URL: 'https://ci', BUILD_ID: '42', JOB_NAME: 'evals', BUILD_URL: 'https://ci/job/evals/42/' };
    expect(ciPipelineAttributes(undefined, env)['cicd.pipeline.run.id']).toBe('42');
  });

  it('applies overrides and drops unknown keys with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(ciPipelineAttributes({ 'cicd.pipeline.run.id': 'x1', 'cicd.bogus': 'y' }, {})).toEqual({
      'cicd.pipeline.run.id': 'x1',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cicd.bogus'));
    warn.mockRestore();
  });
});

describe('cicd on evaluation runs', () => {
  const saved: Record<string, string | undefined> = {};
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearSpans();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const k of CI_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of CI_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    logSpy.mockRestore();
    clearSpans();
  });

  const agent = (input: unknown) =>
    trace.getTracer('test-agent').startActiveSpan('invoke_agent ci', span => {
      span.end();
      return input;
    });

  it('stamps the evaluation results and the root span in CI', () => {
    Object.assign(process.env, GITHUB);
    evaluate({ name: 'ci', task: agent, data: [{ input: 'q1' }], scores: [() => 1] });
    const records = getFinishedLogRecords();
    expect(records.map(r => r.eventName)).toEqual(['gen_ai.evaluation.result']);
    for (const r of records) {
      expect(r.attributes['cicd.pipeline.run.id']).toBe('120912');
      expect(r.attributes['cicd.pipeline.name']).toBe('agent-evals');
    }
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent ci');
    expect(root?.attributes['cicd.pipeline.run.url.full']).toBe(
      'https://github.com/acme/agents/actions/runs/120912',
    );
  });

  it('adds nothing outside CI', () => {
    evaluate({ name: 'local', task: agent, data: [{ input: 'q1' }], scores: [() => 1] });
    for (const r of getFinishedLogRecords()) {
      expect(Object.keys(r.attributes).filter(k => k.startsWith('cicd.'))).toEqual([]);
    }
  });

  it('Benchmark takes an explicit ciPipeline', () => {
    const bm = new Benchmark('b', { ciPipeline: { 'cicd.pipeline.run.id': 'manual-1' } });
    bm.log({ input: 'q', scores: { a: 1 } });
    bm.close();
    for (const r of getFinishedLogRecords()) {
      expect(r.attributes['cicd.pipeline.run.id']).toBe('manual-1');
    }
  });
});
