// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Offline evaluation: run the shared test suite twice, once per prompt version.
 *
 *   npx tsx offline.ts
 *
 * Each run is one evaluate() call with its own run name, so the two runs can be
 * compared in OpenSearch Dashboards (Evaluations > the suite > Compare). Every case
 * is its own agent trace; each scorer result is one gen_ai.evaluation.result event
 * linked to the agent's root span. The agent and the LLM judge are async:
 * evaluate() awaits them and returns a Promise.
 */

import { defineScorer, evaluate, register, type EvalScore } from '@opensearch-project/genai-observability-sdk-ts';
import { AGENT_NAME, PROMPTS, SERVICE_NAME, loadTestSuite, runAgent } from './agent.js';
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
const provider = await register({ serviceName: SERVICE_NAME, agentName: AGENT_NAME });

const toolData = defineScorer(
  {
    name: 'uses_tool_data',
    evaluator: 'uses_tool_data',
    evaluatorType: 'code',
    evaluatorDescription: "Names the city's weather and one of its events, or says there is no data",
  },
  (input, output): EvalScore => {
    const { passed, why } = usesToolData(String(input), String(output));
    return { name: 'uses_tool_data', value: passed ? 1 : 0, passed, explanation: why };
  },
);

const answerLength = defineScorer(
  {
    name: 'answer_length',
    threshold: 500,
    direction: 'minimize',
    evaluator: 'answer_length',
    evaluatorType: 'code',
    evaluatorDescription: 'Answer length in characters, at most 500',
  },
  (_input, output) => String(output).length,
);

// The LLM judge, with its context (model, prompt name and version, description).
// It runs after the agent, as its own trace; judgeTraceId links the result to it.
const planQuality = defineScorer(
  {
    name: 'plan_quality',
    threshold: 4,
    scoreMin: 1,
    scoreMax: 5,
    evaluator: JUDGE_NAME,
    evaluatorType: 'llm_judge',
    evaluatorDescription: JUDGE_DESCRIPTION,
    judgeModel: JUDGE_MODEL_ID,
    judgePromptName: JUDGE_PROMPT_NAME,
    judgePromptVersion: JUDGE_PROMPT_VERSION,
  },
  async (input, output, expected): Promise<EvalScore> => {
    const verdict = await judgePlan(String(input), String(expected), String(output));
    return { name: 'plan_quality', value: verdict.score, explanation: verdict.reason, judgeTraceId: verdict.traceId };
  },
);

const data = loadTestSuite().map((tc) => ({ input: tc.input, expected: tc.expected, caseId: tc.id, caseName: tc.name }));

for (const [version, prompt] of Object.entries(PROMPTS)) {
  const result = await evaluate({
    name: SUITE,
    task: async (question) => (await runAgent(String(question), { systemPrompt: prompt, version })).answer,
    data,
    scores: [toolData, answerLength, planQuality],
    agentVersion: version,
    runName: `${version} prompt`,
    runDescription: `System prompt ${version}: ${prompt}`,
  });
  console.log(`${result.summary.runName}: ${result.summary.passCount} pass, ${result.summary.failCount} fail`);
  for (const c of result.cases) {
    console.log(`  ${c.caseId.padEnd(14)} ${c.resultStatus.padEnd(5)} ${JSON.stringify(c.scores)}  trace ${c.traceId}`);
  }
}

// Flush the spans and the evaluation results.
await provider.shutdown();
