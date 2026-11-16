// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Travel assistant on the OpenAI Node SDK (Chat Completions with tools), traced
 * with the OpenSearch GenAI observability SDK.
 *
 * The chat spans come from @opentelemetry/instrumentation-openai (set up in
 * instrumentation.ts). The agent loop and the tools are plain code, so the SDK's
 * `withObserve` / `observe` create the invoke_agent and execute_tool spans.
 *
 *   npx tsx --import ./instrumentation.ts agent.ts "Plan a one-day trip to Paris."
 *
 * With OPENAI_API_KEY set it calls OpenAI. Without it, it calls the
 * OpenAI-compatible endpoint of Amazon Bedrock with a short-term Bedrock API key
 * made from your AWS credentials.
 */

import { readFileSync } from 'node:fs';
import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import OpenAI from 'openai';
import { Op, enrich, observe, register, withObserve } from '@opensearch-project/genai-observability-sdk-ts';

// Async code keeps the active span only with a context manager. Without it the
// chat and execute_tool spans would not nest under the agent span.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const provider = await register({ serviceName: 'travel-assistant-openai' });

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

const cityTool = (name: string, description: string): OpenAI.ChatCompletionTool => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name, for example "Paris"' } },
      required: ['city'],
    },
  },
});
const TOOL_DEFS = [
  cityTool('get_weather', 'Get the weather forecast for a city.'),
  cityTool('find_events', 'Find upcoming events in a city.'),
];

// ------------------------------------------------------------------- the client

async function makeClient(): Promise<{ client: OpenAI; model: string }> {
  if (process.env.OPENAI_API_KEY) {
    return { client: new OpenAI(), model: process.env.MODEL_ID ?? 'gpt-4.1-mini' };
  }
  // Amazon Bedrock's OpenAI-compatible endpoint, with a short-term Bedrock API key.
  const { getTokenProvider } = await import('@aws/bedrock-token-generator');
  const region = process.env.AWS_REGION ?? 'us-west-2';
  return {
    client: new OpenAI({
      baseURL: `https://bedrock-mantle.${region}.api.aws/v1`,
      apiKey: await getTokenProvider({ region })(),
    }),
    model: process.env.MODEL_ID ?? 'openai.gpt-oss-120b',
  };
}
const { client, model: MODEL } = await makeClient();

// -------------------------------------------------------------------- the agent

async function travelAssistant(question: string): Promise<string> {
  return withObserve('travel_assistant', { op: Op.INVOKE_AGENT }, async () => {
    enrich({
      model: MODEL,
      provider: 'openai',
      systemInstructions: DATA.system_prompt,
      inputMessages: [{ role: 'user', parts: [{ type: 'text', content: question }] }],
    });
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: DATA.system_prompt },
      { role: 'user', content: question },
    ];
    for (let turn = 0; turn < 5; turn++) {
      const response = await client.chat.completions.create({
        model: MODEL,
        max_tokens: 1024,
        messages,
        tools: TOOL_DEFS,
      });
      const reply = response.choices[0].message;
      messages.push(reply);
      const calls = (reply.tool_calls ?? []).filter((c) => c.type === 'function');
      if (calls.length === 0) {
        const answer = (reply.content ?? '').trim();
        enrich({ outputMessages: [{ role: 'assistant', parts: [{ type: 'text', content: answer }] }] });
        return answer;
      }
      for (const call of calls) {
        const fn = TOOLS[call.function.name];
        const args = JSON.parse(call.function.arguments || '{}') as { city?: string };
        const output = fn ? fn(args.city ?? '') : { error: `unknown tool ${call.function.name}` };
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
      }
    }
    return 'Sorry, I could not finish the plan.';
  });
}

const question = process.argv.slice(2).join(' ') || 'Plan a one-day trip to Paris.';
console.log(await travelAssistant(question));

// Flush the spans before the process exits.
await provider.shutdown();
