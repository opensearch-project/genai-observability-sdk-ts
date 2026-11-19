// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Travel assistant on the Amazon Bedrock Converse API (AWS SDK for JavaScript v3),
 * traced with the OpenSearch GenAI observability SDK.
 *
 * There is no agent framework here: the agent loop and the tools are plain code,
 * so the SDK's `withObserve` / `observe` create the invoke_agent and execute_tool
 * spans. The chat spans come from @opentelemetry/instrumentation-aws-sdk
 * (set up in otel.ts).
 *
 *   npx tsx --import ./otel.ts agent.ts "Plan a one-day trip to Paris."
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
// Already run by `--import ./otel.ts`, before the AWS SDK was loaded; imported for its provider.
import { provider } from './otel.js';

// ------------------------------------------------------------ shared data + tools

interface City {
  name: string;
  weather: { condition: string; high_c: number; low_c: number };
  events: { name: string; time: string }[];
}
const DATA = JSON.parse(
  readFileSync(new URL('../../shared/travel_data.json', import.meta.url), 'utf8'),
) as { system_prompt: string; cities: Record<string, City> };

// observe() records each call as an `execute_tool <name>` span with its arguments and result.
const getWeather = observe({ name: 'get_weather', op: Op.EXECUTE_TOOL }, (city: string) => {
  const c = DATA.cities[city.trim().toLowerCase()];
  return c ? { city: c.name, ...c.weather } : { error: `no data for ${city}` };
});

const findEvents = observe({ name: 'find_events', op: Op.EXECUTE_TOOL }, (city: string) => {
  const c = DATA.cities[city.trim().toLowerCase()];
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

// ------------------------------------------------------------------- the agent

const MODEL_ID = process.env.MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-west-2' });

async function travelAssistant(question: string): Promise<string> {
  return withObserve('travel_assistant', { op: Op.INVOKE_AGENT }, async () => {
    enrich({
      model: MODEL_ID,
      provider: 'aws.bedrock',
      systemInstructions: DATA.system_prompt,
      inputMessages: [{ role: 'user', parts: [{ type: 'text', content: question }] }],
    });
    const messages: Message[] = [{ role: 'user', content: [{ text: question }] }];
    for (let turn = 0; turn < 5; turn++) {
      const response = await client.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          system: [{ text: DATA.system_prompt }],
          messages,
          toolConfig: TOOL_CONFIG,
          inferenceConfig: { maxTokens: 1024 },
        }),
      );
      const reply = response.output?.message ?? { role: 'assistant', content: [] };
      messages.push(reply);
      if (response.stopReason !== 'tool_use') {
        const answer = (reply.content ?? []).map((b) => b.text ?? '').join('').trim();
        enrich({ outputMessages: [{ role: 'assistant', parts: [{ type: 'text', content: answer }] }] });
        return answer;
      }
      const results: ContentBlock[] = [];
      for (const block of reply.content ?? []) {
        if (!block.toolUse) continue;
        const { toolUseId, name, input } = block.toolUse;
        const fn = TOOLS[name ?? ''];
        const output = fn ? fn((input as { city?: string })?.city ?? '') : { error: `unknown tool ${name}` };
        results.push({ toolResult: { toolUseId, content: [{ json: output as Record<string, never> }] } });
      }
      messages.push({ role: 'user', content: results });
    }
    return 'Sorry, I could not finish the plan.';
  });
}

const question = process.argv.slice(2).join(' ') || 'Plan a one-day trip to Paris.';
console.log(await travelAssistant(question));

// Flush the spans before the process exits.
await provider.shutdown();
