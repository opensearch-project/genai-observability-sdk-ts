// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Online evaluation: sample recent agent traces from OpenSearch, judge them, post results back.
 *
 *   npx tsx onlineEval.ts                        # one pass over the last 60 minutes
 *   npx tsx onlineEval.ts --sample-rate 0.25 --minutes 30
 *   npx tsx onlineEval.ts --interval 300         # loop every 5 minutes
 *
 * For each sampled trace that has no evaluation result yet:
 *
 * - `answer_quality`: the LLM judge (1 to 5, pass at 4), with the judge's model, prompt
 *   name / version and description recorded on the result.
 * - `known_services`: a cheap deterministic check. Every service the answer names
 *   must exist in the span index, and an answer about services or errors must name at
 *   least one (or say there is no data).
 *
 * Results are posted with `score({ traceId, spanId, ... })` on the agent's root span,
 * so they show next to the trace and on the agent's Evaluations page as online
 * results (no test.suite.run.id).
 */

import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { OpenSearchTraceRetriever, register, score } from '@opensearch-project/genai-observability-sdk-ts';
import {
  AGENT_NAME,
  EVALUATION_INDEX,
  SERVICE_NAME,
  SPAN_INDEX,
  judgeModelId,
  opensearchAuth,
  opensearchUrl,
  verifyCerts,
} from './config.js';
import { JUDGE_DESCRIPTION, JUDGE_NAME, JUDGE_PROMPT_NAME, JUDGE_PROMPT_VERSION, judge } from './judge.js';
import * as queries from './queries.js';

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const provider = await register({ serviceName: `${SERVICE_NAME}-evaluator` });

const retriever = new OpenSearchTraceRetriever({
  host: opensearchUrl(),
  index: SPAN_INDEX,
  evaluationIndex: EVALUATION_INDEX,
  auth: opensearchAuth(),
  verifyCerts: verifyCerts(),
});

const SERVICE_TOKEN = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g;
const NO_DATA = ['no error', 'no services', 'no spans', 'no data', 'none', 'zero'];

/** `[verdict, why]`; verdict `undefined` when the check does not apply. */
export function knownServicesCheck(question: string, answer: string, live: Set<string>): [boolean | undefined, string] {
  const tokens = answer.match(SERVICE_TOKEN) ?? [];
  const named = [...new Set(tokens.filter((t) => live.has(t)))].sort();
  const unknown = [
    ...new Set(
      tokens.filter(
        (t) => !live.has(t) && (t.includes('-prod') || t.includes('-service') || t.endsWith('-ci') || t.endsWith('-evals')),
      ),
    ),
  ].sort();
  const aboutServices = ['service', 'error'].some((w) => question.toLowerCase().includes(w));
  if (!aboutServices && !named.length && !unknown.length) return [undefined, 'not about services'];
  if (unknown.length) return [false, `names services that do not exist: ${JSON.stringify(unknown)}`];
  if (aboutServices && !named.length && !NO_DATA.some((w) => answer.toLowerCase().includes(w))) {
    return [false, 'names no existing service'];
  }
  return [true, named.length ? `names existing services: ${JSON.stringify(named)}` : 'says there is no data'];
}

async function onePass(minutes: number, sampleRate: number, maxTraces: number): Promise<number> {
  const since = new Date(Date.now() - minutes * 60_000);
  const all = await retriever.listRootSpans({ services: [SERVICE_NAME], since, maxResults: 200 });
  // This agent's runs only, and not the offline eval runs (their root spans carry
  // test.suite.run.id, and they are scored by offlineEval.ts).
  const attrsOf = (r: (typeof all)[number]) => (r.raw.attributes ?? {}) as Record<string, unknown>;
  const roots = all.filter((r) => r.agentName === AGENT_NAME && !('test.suite.run.id' in attrsOf(r)));
  const done = await retriever.findEvaluatedTraceIds(roots.map((r) => r.traceId));
  const todo = roots.filter((r) => !done.has(r.traceId));
  // Math.random is fine for sampling (not security relevant).
  const sampled = todo.filter(() => Math.random() < sampleRate).slice(0, maxTraces);
  console.log(
    `${roots.length} agent traces in the last ${minutes} min, ${done.size} already evaluated, ${sampled.length} sampled`,
  );
  const live = new Set(await queries.services(Math.max(minutes, 10080)));
  for (const root of sampled) {
    const question = root.inputMessages[0]?.content ?? '';
    const answer = root.outputMessages.at(-1)?.content ?? '';
    const version = attrsOf(root)['gen_ai.agent.version'];
    if (!question || !answer) {
      console.log(`  ${root.traceId}: no input / output messages, skipped`);
      continue;
    }
    const common = {
      traceId: root.traceId,
      spanId: root.spanId,
      agentName: AGENT_NAME,
      agentVersion: version === undefined ? undefined : String(version),
    };
    let verdict;
    try {
      verdict = await judge(question, answer);
    } catch (e) {
      // The judge failed: record an evaluator error.
      const errorType = e instanceof Error ? e.constructor.name : typeof e;
      score({ name: 'answer_quality', errorType, evaluator: JUDGE_NAME, evaluatorType: 'llm_judge', ...common });
      console.log(`  ${root.traceId}: judge failed (${errorType})`);
      continue;
    }
    score({
      name: 'answer_quality',
      value: verdict.score,
      explanation: verdict.reason,
      threshold: 4,
      scoreMin: 1,
      scoreMax: 5,
      evaluator: JUDGE_NAME,
      evaluatorVersion: JUDGE_PROMPT_VERSION,
      evaluatorType: 'llm_judge',
      evaluatorDescription: JUDGE_DESCRIPTION,
      judgeModel: judgeModelId(),
      judgePromptName: JUDGE_PROMPT_NAME,
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      judgeTraceId: verdict.judgeTraceId,
      ...common,
    });
    const [ok, why] = knownServicesCheck(question, answer, live);
    if (ok !== undefined) {
      score({
        name: 'known_services',
        value: ok ? 1 : 0,
        label: ok ? 'pass' : 'fail',
        explanation: why,
        evaluator: 'known_services_check',
        evaluatorType: 'code',
        evaluatorDescription: 'Every service the answer names exists in the span index',
        ...common,
      });
    }
    console.log(`  ${root.traceId}: answer_quality=${verdict.score} known_services=${ok}`);
  }
  await provider.forceFlush();
  return sampled.length;
}

const { values: args } = parseArgs({
  options: {
    minutes: { type: 'string', default: '60' },
    'sample-rate': { type: 'string', default: '0.5' },
    'max-traces': { type: 'string', default: '20' },
    interval: { type: 'string', default: '0' },
  },
});
const interval = Number(args.interval);
for (;;) {
  await onePass(Number(args.minutes), Number(args['sample-rate']), Number(args['max-traces']));
  if (!interval) break;
  await sleep(interval * 1000);
}
await provider.shutdown();
