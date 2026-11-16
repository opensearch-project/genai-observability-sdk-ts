// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Travel assistant on the Anthropic TypeScript SDK (Claude on Amazon Bedrock),
 * traced with the OpenSearch GenAI observability SDK.
 *
 * The Anthropic SDK emits a `chat` span per Messages API call by itself, with
 * messages when `contentMode: 'content'` is set. The agent loop and the tools are
 * plain code, so the SDK's `withObserve` / `observe` create the invoke_agent and
 * execute_tool spans.
 *
 *   npx tsx agent.ts "Plan a one-day trip to Paris."
 */

import { readFileSync } from 'node:fs';
import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { Op, enrich, observe, register, withObserve } from '@opensearch-project/genai-observability-sdk-ts';

// Async code keeps the active span only with a context manager. Without it the
// chat and execute_tool spans would not nest under the agent span.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const provider = await register({ serviceName: 'travel-assistant-anthropic' });

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

const cityTool = (name: string, description: string): Anthropic.Tool => ({
  name,
  description,
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name, for example "Paris"' } },
    required: ['city'],
  },
});
const TOOL_DEFS = [
  cityTool('get_weather', 'Get the weather forecast for a city.'),
  cityTool('find_events', 'Find upcoming events in a city.'),
];

// ------------------------------------------------------------------- the agent

const MODEL = process.env.MODEL_ID ?? 'anthropic.claude-haiku-4-5';
// For the Claude API instead of Bedrock: `new Anthropic({ openTelemetry: ... })` from
// '@anthropic-ai/sdk' (reads ANTHROPIC_API_KEY) and MODEL_ID=claude-haiku-4-5.
const client = new AnthropicBedrockMantle({
  awsRegion: process.env.AWS_REGION ?? 'us-west-2',
  // Put prompts and responses on the chat spans (default: metadata only).
  openTelemetry: { traces: { contentMode: 'content' } },
});

async function travelAssistant(question: string): Promise<string> {
  return withObserve('travel_assistant', { op: Op.INVOKE_AGENT }, async () => {
    enrich({
      model: MODEL,
      provider: 'anthropic',
      systemInstructions: DATA.system_prompt,
      inputMessages: [{ role: 'user', parts: [{ type: 'text', content: question }] }],
    });
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
    for (let turn = 0; turn < 5; turn++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: DATA.system_prompt,
        tools: TOOL_DEFS,
        messages,
      });
      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason !== 'tool_use') {
        const answer = response.content
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('')
          .trim();
        enrich({ outputMessages: [{ role: 'assistant', parts: [{ type: 'text', content: answer }] }] });
        return answer;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const fn = TOOLS[block.name];
        const output = fn ? fn((block.input as { city?: string }).city ?? '') : { error: `unknown tool ${block.name}` };
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(output) });
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
