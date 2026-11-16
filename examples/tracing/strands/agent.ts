// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Travel assistant on Strands Agents (TypeScript), traced with the OpenSearch
 * GenAI observability SDK.
 *
 * Strands emits the GenAI spans itself: invoke_agent travel_assistant, chat
 * (one per model call) and execute_tool (one per tool call). register() sends
 * them to the OTLP endpoint (default http://localhost:4318).
 *
 *   npx tsx agent.ts "Plan a one-day trip to Paris."
 */

import { readFileSync } from 'node:fs';
import { register } from '@opensearch-project/genai-observability-sdk-ts';
import { Agent, tool } from '@strands-agents/sdk';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import { z } from 'zod';

// Latest GenAI semantic conventions, with messages as span attributes (what Agent Traces reads).
process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'gen_ai_latest_experimental,gen_ai_span_attributes_only';

const provider = await register({ serviceName: 'travel-assistant-strands' });

// ------------------------------------------------------------ shared data + tools

interface City {
  name: string;
  weather: { condition: string; high_c: number; low_c: number };
  events: { name: string; time: string }[];
}
const DATA = JSON.parse(
  readFileSync(new URL('../../shared/travel_data.json', import.meta.url), 'utf8'),
) as { system_prompt: string; cities: Record<string, City> };

function getWeather(city: string) {
  const c = DATA.cities[city.trim().toLowerCase()];
  return c ? { city: c.name, ...c.weather } : { error: `no data for ${city}` };
}

function findEvents(city: string) {
  const c = DATA.cities[city.trim().toLowerCase()];
  return c ? { city: c.name, events: c.events } : { error: `no data for ${city}` };
}

const cityInput = z.object({ city: z.string().describe('City name, for example "Paris"') });

const tools = [
  tool({
    name: 'get_weather',
    description: 'Get the weather forecast for a city.',
    inputSchema: cityInput,
    callback: ({ city }) => getWeather(city),
  }),
  tool({
    name: 'find_events',
    description: 'Find upcoming events in a city.',
    inputSchema: cityInput,
    callback: ({ city }) => findEvents(city),
  }),
];

// ------------------------------------------------------------------- the agent

const MODEL_ID = process.env.MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const REGION = process.env.AWS_REGION ?? 'us-west-2';

const agent = new Agent({
  name: 'travel_assistant',
  model: new BedrockModel({ modelId: MODEL_ID, region: REGION, maxTokens: 1024 }),
  systemPrompt: DATA.system_prompt,
  tools,
  printer: false,
});

const question = process.argv.slice(2).join(' ') || 'Plan a one-day trip to Paris.';
const result = await agent.invoke(question);
console.log(result.toString().trim());

// Flush the spans before the process exits.
await provider.shutdown();
