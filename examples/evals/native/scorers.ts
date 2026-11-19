// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Checks shared by the offline and the online evaluation.
 *
 * - usesToolData: deterministic. The plan names the city's weather and one of its
 *   events, or, for a city with no data, says so.
 * - judgePlan: an LLM judge on Amazon Bedrock that grades the plan 1 to 5 against the
 *   expected behavior. It runs as its own trace, so each result can link to it.
 */

import { ROOT_CONTEXT, context } from '@opentelemetry/api';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { Op, enrich, withObserve } from '@opensearch-project/genai-observability-sdk-ts';
import { CITIES, bedrock } from './agent.js';

export const JUDGE_MODEL_ID = process.env.JUDGE_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
export const JUDGE_NAME = 'travel_plan_judge';
export const JUDGE_PROMPT_NAME = 'travel-plan-quality';
export const JUDGE_PROMPT_VERSION = 'v1'; // bump when JUDGE_PROMPT changes
export const JUDGE_DESCRIPTION = 'Plan is grounded in the tool data and meets the expected behavior';
const JUDGE_PROMPT =
  "You grade a travel assistant. Given the user's request, the expected behavior, the " +
  "tool results (when given) and the assistant's answer, score the answer from 1 (wrong " +
  'or invented) to 5 (correct, grounded, short). Reply with JSON only: ' +
  '{"score": <1-5>, "reason": "<one sentence>"}';

/** Whether the plan uses the tool data, checked against the static travel data. */
export function usesToolData(question: string, answer: string): { passed: boolean; why: string } {
  const text = answer.toLowerCase();
  const city = Object.keys(CITIES).find((c) => question.toLowerCase().includes(c));
  if (!city) {
    // A city the tools have no data for.
    const passed = ['no data', "don't have", 'do not have'].some((p) => text.includes(p));
    return { passed, why: passed ? 'says there is no data' : 'does not say there is no data' };
  }
  const data = CITIES[city];
  const weather = text.includes(data.weather.condition);
  const events = data.events.filter((e) => text.includes(e.name.split(' ')[0].toLowerCase())).map((e) => e.name);
  return {
    passed: weather && events.length > 0,
    why: `weather ${weather ? 'named' : 'missing'}, events named: ${events.join(', ') || 'none'}`,
  };
}

/** The first JSON object in a reply; the model may add text or a second object after it. */
export function firstJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  if (start < 0) return {};
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }
  }
  return {};
}

export interface JudgeVerdict {
  score: number;
  reason: string;
  /** Trace of the judge call, for `judgeTraceId`. */
  traceId: string;
}

/** Grade one answer from 1 to 5, in its own trace (never inside the agent's trace). */
export function judgePlan(question: string, expected: string, answer: string, toolResults = ''): Promise<JudgeVerdict> {
  return context.with(ROOT_CONTEXT, () =>
    withObserve(JUDGE_MODEL_ID, { op: Op.CHAT }, async (span) => {
      const extra = toolResults ? `\nTool results: ${toolResults}` : '';
      const prompt = `Request: ${question}\nExpected: ${expected}${extra}\nAnswer: ${answer}`;
      const response = await bedrock.send(
        new ConverseCommand({
          modelId: JUDGE_MODEL_ID,
          system: [{ text: JUDGE_PROMPT }],
          messages: [{ role: 'user', content: [{ text: prompt }] }],
          inferenceConfig: { maxTokens: 200, temperature: 0 },
        }),
      );
      const reply = response.output?.message?.content?.[0]?.text ?? '';
      enrich({
        model: JUDGE_MODEL_ID,
        provider: 'aws.bedrock',
        systemInstructions: JUDGE_PROMPT,
        inputMessages: [{ role: 'user', parts: [{ type: 'text', content: prompt }] }],
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        outputMessages: [{ role: 'assistant', parts: [{ type: 'text', content: reply }] }],
      });
      const verdict = firstJsonObject(reply) as { score?: unknown; reason?: unknown };
      const score = Number(verdict.score);
      if (!(score >= 1 && score <= 5)) throw new RangeError(`judge returned no score in 1..5: ${reply.slice(0, 200)}`);
      return { score, reason: String(verdict.reason ?? ''), traceId: span.spanContext().traceId };
    }),
  );
}
