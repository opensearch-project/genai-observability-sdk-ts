// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * The travel assistant under evaluation: the Amazon Bedrock Converse API with two
 * tools over the shared data, traced with the SDK (invoke_agent, chat and
 * execute_tool spans). Shared by offline.ts, traffic.ts and online.ts.
 */

import { readFileSync } from 'node:fs';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import { Op, enrich, observe, withObserve } from '@opensearch-project/genai-observability-sdk-ts';

export const AGENT_NAME = 'travel_assistant';
export const SERVICE_NAME = 'travel-assistant-evals-native-ts';
export const MODEL_ID = process.env.MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
export const REGION = process.env.AWS_REGION ?? 'us-west-2';
export const bedrock = new BedrockRuntimeClient({ region: REGION });

// ------------------------------------------------------------------ shared data

export interface City {
  name: string;
  weather: { condition: string; high_c: number; low_c: number };
  events: { name: string; time: string }[];
}
const SHARED = new URL('../../shared/', import.meta.url);
const DATA = JSON.parse(readFileSync(new URL('travel_data.json', SHARED), 'utf8')) as {
  system_prompt: string;
  cities: Record<string, City>;
};
export const SYSTEM_PROMPT = DATA.system_prompt;
export const CITIES = DATA.cities;

export interface TestCase {
  id: string;
  name: string;
  input: string;
  expected: string;
}

export function loadTestSuite(): TestCase[] {
  return readFileSync(new URL('test_suite.jsonl', SHARED), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TestCase);
}

// ------------------------------------------------------------------------ tools

const getWeather = observe({ name: 'get_weather', op: Op.EXECUTE_TOOL }, (city: string) => {
  const c = CITIES[city.trim().toLowerCase()];
  return c ? { city: c.name, ...c.weather } : { error: `no data for ${city}` };
});

const findEvents = observe({ name: 'find_events', op: Op.EXECUTE_TOOL }, (city: string) => {
  const c = CITIES[city.trim().toLowerCase()];
  return c ? { city: c.name, events: c.events } : { error: `no data for ${city}` };
});

const TOOLS: Record<string, (city: string) => unknown> = { get_weather: getWeather, find_events: findEvents };

const cityTool = (name: string, description: string): Tool => ({
  toolSpec: {
    name,
    description,
    inputSchema: {
      json: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name, for example "Paris"' } },
        required: ['city'],
      },
    },
  },
});
const TOOL_CONFIG = {
  tools: [
    cityTool('get_weather', 'Get the weather forecast for a city.'),
    cityTool('find_events', 'Find upcoming events in a city.'),
  ],
};

const text = (role: string, content: string) => [{ role, parts: [{ type: 'text', content }] }];

/** Bedrock Converse messages in the GenAI semantic convention shape. */
function toGenAI(messages: Message[]) {
  return messages.map((m) => ({
    role: m.role,
    parts: (m.content ?? []).map((b) => {
      if (b.text !== undefined) return { type: 'text', content: b.text };
      if (b.toolUse) return { type: 'tool_call', id: b.toolUse.toolUseId, name: b.toolUse.name, arguments: b.toolUse.input };
      if (b.toolResult) return { type: 'tool_call_response', id: b.toolResult.toolUseId, response: b.toolResult.content };
      return { type: 'unknown' };
    }),
  }));
}

/** One model call as a `chat <model>` span (no Bedrock instrumentation needed). */
function chat(system: string, messages: Message[]) {
  return withObserve(MODEL_ID, { op: Op.CHAT }, async () => {
    const response = await bedrock.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: system }],
        messages,
        toolConfig: TOOL_CONFIG,
        inferenceConfig: { maxTokens: 1024 },
      }),
    );
    const reply = response.output?.message ?? { role: 'assistant', content: [] };
    enrich({
      model: MODEL_ID,
      provider: 'aws.bedrock',
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      finishReason: response.stopReason,
      systemInstructions: system,
      inputMessages: toGenAI(messages),
      outputMessages: toGenAI([reply]),
    });
    return { reply, stopReason: response.stopReason };
  });
}

// ------------------------------------------------------------------------ agent

export interface AgentRun {
  answer: string;
  toolsCalled: string[];
  traceId: string;
  spanId: string;
}

/** Run the agent on one question, as its own trace. */
export function runAgent(
  question: string,
  options: { systemPrompt?: string; version?: string } = {},
): Promise<AgentRun> {
  const system = options.systemPrompt ?? SYSTEM_PROMPT;
  return withObserve(AGENT_NAME, { op: Op.INVOKE_AGENT }, async (span) => {
    span.setAttribute('gen_ai.agent.version', options.version ?? 'v1');
    enrich({ model: MODEL_ID, provider: 'aws.bedrock', systemInstructions: system, inputMessages: text('user', question) });
    const { traceId, spanId } = span.spanContext();
    const toolsCalled: string[] = [];
    const messages: Message[] = [{ role: 'user', content: [{ text: question }] }];
    let answer = 'Sorry, I could not finish the plan.';
    for (let turn = 0; turn < 5; turn++) {
      const { reply, stopReason } = await chat(system, messages);
      messages.push(reply);
      if (stopReason !== 'tool_use') {
        answer = (reply.content ?? []).map((b) => b.text ?? '').join('').trim();
        break;
      }
      const results: ContentBlock[] = [];
      for (const block of reply.content ?? []) {
        if (!block.toolUse) continue;
        const { toolUseId, name = '', input } = block.toolUse;
        toolsCalled.push(name);
        const output = TOOLS[name]?.((input as { city?: string })?.city ?? '') ?? { error: `unknown tool ${name}` };
        results.push({ toolResult: { toolUseId, content: [{ json: output as Record<string, never> }] } });
      }
      messages.push({ role: 'user', content: results });
    }
    enrich({ outputMessages: text('assistant', answer) });
    return { answer, toolsCalled, traceId, spanId };
  });
}
