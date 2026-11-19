// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Online evaluation: judge recent production traces and write the scores back.
 *
 *   OPENSEARCH_PASSWORD=<password> npx tsx online.ts
 *
 * Lists the agent root spans of the last hour with OpenSearchTraceRetriever, skips
 * traces the judge already scored, reads each trace's tool spans, then sends
 * score() results parented to the agent's root span. Online results have no
 * test.suite.run.id. Run `npx tsx traffic.ts` first to have traces to judge.
 */

import { OpenSearchTraceRetriever, register, score } from '@opensearch-project/genai-observability-sdk-ts';
import { AGENT_NAME, SERVICE_NAME } from './agent.js';
import {
  JUDGE_DESCRIPTION,
  JUDGE_MODEL_ID,
  JUDGE_NAME,
  JUDGE_PROMPT_NAME,
  JUDGE_PROMPT_VERSION,
  judgePlan,
  usesToolData,
} from './scorers.js';

const EXPECTED =
  "A short plan that uses only the tool data: the city's weather and at least one event, " +
  'or says there is no data for the city.';

// The judge's own spans go to a separate service, so they are not judged next time.
const provider = await register({ serviceName: `${SERVICE_NAME}-judge` });

const url = process.env.OPENSEARCH_URL ?? 'https://localhost:9200';
const password = process.env.OPENSEARCH_PASSWORD;
if (!password) throw new Error('Set OPENSEARCH_PASSWORD (and OPENSEARCH_USER, default admin)');
const retriever = new OpenSearchTraceRetriever({
  host: url,
  auth: { username: process.env.OPENSEARCH_USER ?? 'admin', password },
  // Off by default for the local stack's self-signed certificate; set it for a real cluster
  verifyCerts: ['1', 'true', 'yes'].includes((process.env.OPENSEARCH_VERIFY_CERTS ?? '').toLowerCase()),
});

// The filters run on the client, after maxResults: keep the page large, or offline runs
// (agent cases and judge calls) can push real traffic out of it.
const roots = (
  await retriever.listRootSpans({
    services: [SERVICE_NAME],
    since: new Date(Date.now() - 60 * 60 * 1000),
    maxResults: 500,
  })
).filter(
  // This agent's online runs only: not the judge's own chat traces, not the offline cases
  (r) => r.agentName === AGENT_NAME && !('test.suite.run.id' in ((r.raw.attributes ?? {}) as object)),
);
const done = await retriever.findEvaluatedTraceIds(
  roots.map((r) => r.traceId),
  { evaluator: JUDGE_NAME },
);
const todo = roots.filter((r) => !done.has(r.traceId) && r.inputMessages.length && r.outputMessages.length);
console.log(`${roots.length} recent traces, ${done.size} already judged, ${todo.length} to judge`);

for (const root of todo) {
  const question = root.inputMessages.at(-1)!.content;
  const answer = root.outputMessages.at(-1)!.content;
  const spans = (await retriever.getTraces(root.traceId)).traces[0]?.spans ?? [];
  const toolSpans = spans.filter((s) => s.operationName === 'execute_tool');
  const tools = [...new Set(toolSpans.map((s) => s.toolName))].sort();
  const toolResults = toolSpans.map((s) => `${s.toolName}: ${s.toolCallResult}`).join('; ');
  const target = {
    traceId: root.traceId,
    spanId: root.spanId, // the agent's root span
    agentName: root.agentName || undefined,
    agentVersion: root.agentVersion || undefined,
  };

  const judgeContext = {
    evaluator: JUDGE_NAME,
    evaluatorType: 'llm_judge' as const,
    evaluatorDescription: JUDGE_DESCRIPTION,
    judgeModel: JUDGE_MODEL_ID,
    judgePromptName: JUDGE_PROMPT_NAME,
    judgePromptVersion: JUDGE_PROMPT_VERSION,
  };
  let verdict: Awaited<ReturnType<typeof judgePlan>> | undefined;
  try {
    verdict = await judgePlan(question, EXPECTED, answer, toolResults);
  } catch (e) {
    // The judge failed: record an evaluator error and go on with the other traces
    const errorType = e instanceof Error ? e.name : 'Error';
    score({ name: 'plan_quality', ...target, errorType, ...judgeContext });
    console.log(`  ${root.traceId}  plan_quality: judge failed (${errorType})`);
  }
  if (verdict) {
    score({
      name: 'plan_quality',
      value: verdict.score,
      ...target,
      explanation: verdict.reason,
      threshold: 4,
      scoreMin: 1,
      scoreMax: 5,
      judgeTraceId: verdict.traceId,
      ...judgeContext,
    });
  }

  const toolData = usesToolData(question, answer);
  score({
    name: 'uses_tool_data',
    value: toolData.passed ? 1 : 0,
    ...target,
    label: toolData.passed ? 'pass' : 'fail',
    explanation: `${toolData.why}; tools called: ${tools.join(', ') || 'none'}`,
    evaluator: 'uses_tool_data',
    evaluatorType: 'code',
  });
  console.log(`  ${root.traceId}  plan_quality=${verdict?.score} (${verdict?.reason})  uses_tool_data=${toolData.passed}`);
}

// Flush the judge spans and the evaluation results.
await provider.shutdown();
