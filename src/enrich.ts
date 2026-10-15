// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { trace, context } from "@opentelemetry/api";

export interface EnrichOptions {
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  responseId?: string;
  finishReason?: string;
  temperature?: number;
  maxTokens?: number;
  sessionId?: string;
  agentId?: string;
  agentDescription?: string;
  toolDefinitions?: unknown[];
  systemInstructions?: string;
  inputMessages?: unknown;
  outputMessages?: unknown;
  [extra: string]: unknown;
}

const KNOWN_KEYS: Record<string, string> = {
  model: "gen_ai.request.model",
  provider: "gen_ai.provider.name",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  totalTokens: "gen_ai.usage.total_tokens",
  responseId: "gen_ai.response.id",
  temperature: "gen_ai.request.temperature",
  maxTokens: "gen_ai.request.max_tokens",
  sessionId: "gen_ai.conversation.id",
  agentId: "gen_ai.agent.id",
  agentDescription: "gen_ai.agent.description",
  systemInstructions: "gen_ai.system_instructions",
};

const JSON_KEYS: Record<string, string> = {
  toolDefinitions: "gen_ai.tool.definitions",
  inputMessages: "gen_ai.input.messages",
  outputMessages: "gen_ai.output.messages",
};

export function enrich(options: EnrichOptions): void {
  const span = trace.getSpan(context.active());
  if (!span || !span.isRecording()) return;

  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;

    if (key in KNOWN_KEYS) {
      span.setAttribute(KNOWN_KEYS[key], value as string | number);
    } else if (key === "finishReason") {
      span.setAttribute("gen_ai.response.finish_reasons", [value as string]);
    } else if (key in JSON_KEYS) {
      span.setAttribute(JSON_KEYS[key], JSON.stringify(value));
    } else {
      span.setAttribute(key, value as string | number | boolean);
    }
  }
}

/** Marks the span that OpenSearch Agent Traces lists as a trace's agent root. */
export const AGENT_ROOT_ATTRIBUTE = "derived.gen_ai.is_root";

/**
 * Mark the active span as the agent root of its trace.
 *
 * OpenSearch Agent Traces lists a trace by the span marked with `derived.gen_ai.is_root`. Data
 * Prepper marks the outermost GenAI span of each trace for you: the root when it is a GenAI span,
 * or the agent span below it (for example when an HTTP handler runs the agent). Call this to
 * choose the span yourself. A span marked at the source wins, and Data Prepper then marks nothing
 * else in that part of the trace.
 *
 * @example
 * const plan = observe({ name: "planner", op: Op.INVOKE_AGENT }, async (query: string) => {
 *   markAgentRoot();
 *   // ...
 * });
 */
export function markAgentRoot(): void {
  const span = trace.getSpan(context.active());
  if (!span || !span.isRecording()) return;
  span.setAttribute(AGENT_ROOT_ATTRIBUTE, true);
}
