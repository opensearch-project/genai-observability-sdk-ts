// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Travel assistant on LangGraph.js, traced with the OpenSearch GenAI
 * observability SDK.
 *
 * LangGraph.js and LangChain.js have no OpenTelemetry GenAI instrumentation, so the
 * SDK makes the spans: `withObserve` around the graph run (invoke_agent) and the
 * model node (chat), and `observe` around the tool functions (execute_tool).
 *
 *   npx tsx agent.ts "Plan a one-day trip to Paris."
 */

import { readFileSync } from 'node:fs';
import { ChatBedrockConverse } from '@langchain/aws';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { Op, enrich, observe, register, withObserve } from '@opensearch-project/genai-observability-sdk-ts';

const provider = await register({ serviceName: 'travel-assistant-langgraph' });

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

const cityInput = z.object({ city: z.string().describe('City name, for example "Paris"') });
const tools = [
  tool(({ city }) => JSON.stringify(getWeather(city)), {
    name: 'get_weather',
    description: 'Get the weather forecast for a city.',
    schema: cityInput,
  }),
  tool(({ city }) => JSON.stringify(findEvents(city)), {
    name: 'find_events',
    description: 'Find upcoming events in a city.',
    schema: cityInput,
  }),
];

// ------------------------------------------------------------------- the graph

const MODEL_ID = process.env.MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const model = new ChatBedrockConverse({
  model: MODEL_ID,
  region: process.env.AWS_REGION ?? 'us-west-2',
  maxTokens: 1024,
}).bindTools(tools);

/** LangChain messages in the GenAI semantic convention shape. */
function toGenAI(messages: BaseMessage[]) {
  return messages.map((m) => {
    const parts: Record<string, unknown>[] = [];
    if (m.text) parts.push({ type: 'text', content: m.text });
    for (const call of (m as AIMessage).tool_calls ?? []) {
      parts.push({ type: 'tool_call', id: call.id, name: call.name, arguments: call.args });
    }
    if (m.getType() === 'tool') {
      return { role: 'tool', parts: [{ type: 'tool_call_response', id: (m as { tool_call_id?: string }).tool_call_id, response: m.text }] };
    }
    return { role: { human: 'user', ai: 'assistant' }[m.getType() as string] ?? m.getType(), parts };
  });
}

// The model node: one `chat <model>` span per call, with messages and token usage.
async function callModel(state: typeof MessagesAnnotation.State) {
  return withObserve(MODEL_ID, { op: Op.CHAT }, async () => {
    const input = state.messages;
    const reply = (await model.invoke([{ role: 'system', content: DATA.system_prompt }, ...input])) as AIMessage;
    enrich({
      model: MODEL_ID,
      provider: 'aws.bedrock',
      systemInstructions: DATA.system_prompt,
      inputMessages: toGenAI(input),
      outputMessages: toGenAI([reply]),
      inputTokens: reply.usage_metadata?.input_tokens,
      outputTokens: reply.usage_metadata?.output_tokens,
    });
    return { messages: [reply] };
  });
}

function nextStep(state: typeof MessagesAnnotation.State) {
  const last = state.messages.at(-1) as AIMessage;
  return last.tool_calls?.length ? 'tools' : END;
}

const graph = new StateGraph(MessagesAnnotation)
  .addNode('model', callModel)
  .addNode('tools', new ToolNode(tools))
  .addEdge(START, 'model')
  .addConditionalEdges('model', nextStep, ['tools', END])
  .addEdge('tools', 'model')
  .compile();

// ------------------------------------------------------------------- run

async function travelAssistant(question: string): Promise<string> {
  return withObserve('travel_assistant', { op: Op.INVOKE_AGENT }, async () => {
    enrich({ inputMessages: [{ role: 'user', parts: [{ type: 'text', content: question }] }] });
    const state = await graph.invoke({ messages: [{ role: 'user', content: question }] }, { recursionLimit: 10 });
    const answer = state.messages.at(-1)?.text.trim() ?? '';
    enrich({ outputMessages: [{ role: 'assistant', parts: [{ type: 'text', content: answer }] }] });
    return answer;
  });
}

const question = process.argv.slice(2).join(' ') || 'Plan a one-day trip to Paris.';
console.log(await travelAssistant(question));

// Flush the spans before the process exits.
await provider.shutdown();
