// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Offline evaluation: run the shared test suite twice, once per prompt version.
 *
 *   npx tsx offline.ts
 *
 * Each prompt version is one run of the suite with its own run name, so the two runs
 * can be compared in OpenSearch Dashboards (Evaluations > the suite > Compare). Every
 * case is its own agent trace; each score is one gen_ai.evaluation.result event
 * linked to the agent's root span.
 *
 * Why Benchmark and not evaluate(): in TypeScript the agent and the LLM judge are
 * async, and evaluate() takes a synchronous task and synchronous scorers. So each
 * case is run and scored here, and uploaded with Benchmark.log(), linked to the
 * agent span (traceId + spanId). The agent span gets the same test.* ids that
 * evaluate() would stamp on it.
 */

import { Benchmark, register, type EvalScore } from '@opensearch-project/genai-observability-sdk-ts';
import { AGENT_NAME, SERVICE_NAME, SYSTEM_PROMPT, loadTestSuite, runAgent } from './agent.js';
import {
  JUDGE_DESCRIPTION,
  JUDGE_MODEL_ID,
  JUDGE_NAME,
  JUDGE_PROMPT_NAME,
  JUDGE_PROMPT_VERSION,
  judgePlan,
  usesToolData,
} from './scorers.js';

const SUITE = 'travel-assistant-suite';
const PROMPTS: Record<string, string> = {
  v1: SYSTEM_PROMPT,
  v2: `${SYSTEM_PROMPT} Reply in at most two sentences.`,
};

const provider = await register({ serviceName: SERVICE_NAME, agentName: AGENT_NAME });

for (const [version, prompt] of Object.entries(PROMPTS)) {
  const bench = new Benchmark(SUITE, {
    runName: `${version} prompt`,
    runDescription: `System prompt ${version}: ${prompt}`,
    agentName: AGENT_NAME,
    agentVersion: version,
  });

  for (const tc of loadTestSuite()) {
    // The agent run, with the test.* ids of the case on its root span.
    const run = await runAgent(tc.input, {
      systemPrompt: prompt,
      version,
      attributes: {
        'test.suite.name': SUITE,
        'test.suite.run.id': bench.runId,
        'test.case.id': tc.id,
        'test.case.name': tc.name,
      },
    });

    // Deterministic scorers.
    const toolData = usesToolData(tc.input, run.answer);
    const scores: EvalScore[] = [
      {
        name: 'uses_tool_data',
        value: toolData.passed ? 1 : 0,
        passed: toolData.passed,
        explanation: `${toolData.why}; tools called: ${run.toolsCalled.join(', ') || 'none'}`,
        evaluator: 'uses_tool_data',
        evaluatorType: 'code',
        evaluatorDescription: "Names the city's weather and one of its events, or says there is no data",
      },
      {
        name: 'answer_length',
        value: run.answer.length,
        threshold: 500,
        direction: 'minimize',
        evaluator: 'answer_length',
        evaluatorType: 'code',
        evaluatorDescription: 'Answer length in characters, at most 500',
      },
    ];

    // The LLM judge, with its context (model, prompt name and version, description).
    try {
      const verdict = await judgePlan(tc.input, tc.expected, run.answer);
      scores.push({
        name: 'plan_quality',
        value: verdict.score,
        explanation: verdict.reason,
        threshold: 4,
        scoreMin: 1,
        scoreMax: 5,
        evaluator: JUDGE_NAME,
        evaluatorType: 'llm_judge',
        evaluatorDescription: JUDGE_DESCRIPTION,
        judgeModel: JUDGE_MODEL_ID,
        judgePromptName: JUDGE_PROMPT_NAME,
        judgePromptVersion: JUDGE_PROMPT_VERSION,
        judgeTraceId: verdict.traceId,
      });
    } catch (e) {
      console.warn(`  ${tc.id}: judge failed, no plan_quality score: ${(e as Error).message}`);
    }

    bench.log({
      input: tc.input,
      output: run.answer,
      expected: tc.expected,
      scores,
      caseId: tc.id,
      caseName: tc.name,
      traceId: run.traceId,
      spanId: run.spanId,
    });
    const values = Object.fromEntries(scores.map((s) => [s.name, s.value]));
    console.log(`  ${tc.id.padEnd(14)} ${JSON.stringify(values)}  trace ${run.traceId}`);
  }

  bench.close(); // prints the run summary
}

// Flush the spans and the evaluation results.
await provider.shutdown();
