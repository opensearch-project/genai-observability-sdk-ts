// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Travel assistant on the OpenAI Agents SDK (TypeScript), traced with the
 * OpenSearch GenAI observability SDK.
 *
 * The Agents SDK has its own tracing (agent, generation and function spans), but
 * no OpenTelemetry export. `OTelBridge` below is an Agents SDK trace processor that
 * turns those spans into OpenTelemetry GenAI spans:
 *
 *   agent       -> invoke_agent <agent name>
 *   generation  -> chat <model>          (messages, token usage)
 *   function    -> execute_tool <tool>   (arguments, result)
 *
 *   npx tsx agent.ts "Plan a one-day trip to Paris."
 *
 * With OPENAI_API_KEY set it uses OpenAI. Without it, it runs Claude on Amazon
 * Bedrock through the AI SDK adapter (`aisdk()`).
 */

import { readFileSync } from 'node:fs';
import { SpanStatusCode, context, trace, type Context, type Span as OTelSpan } from '@opentelemetry/api';
import { Agent, run, setTraceProcessors, tool, type Model } from '@openai/agents';
import type { Span, SpanData, TracingProcessor } from '@openai/agents';
import { z } from 'zod';
import { register } from '@opensearch-project/genai-observability-sdk-ts';

const provider = await register({ serviceName: 'travel-assistant-openai-agents' });

// ---------------------------------------------------- Agents SDK -> OpenTelemetry

type Part = Record<string, unknown>;

/** Agents SDK / AI SDK message items in the GenAI semantic convention shape. */
function toGenAI(items: unknown): unknown[] {
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const item = raw as Record<string, unknown>;
    if (item.type === 'function_call') {
      return { role: 'assistant', parts: [{ type: 'tool_call', id: item.callId, name: item.name, arguments: item.arguments }] };
    }
    const content = typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : (item.content as Part[]) ?? [];
    const parts = content.map((p) => {
      if (typeof p.text === 'string') return { type: 'text', content: p.text };
      if (p.type === 'tool-call') return { type: 'tool_call', id: p.toolCallId, name: p.toolName, arguments: p.input };
      if (p.type === 'tool-result') return { type: 'tool_call_response', id: p.toolCallId, response: p.output };
      return { type: String(p.type ?? 'unknown') };
    });
    return { role: item.role ?? 'assistant', parts };
  });
}

/** OpenTelemetry name and attributes of an Agents SDK span, or undefined to skip it. */
function describe(data: SpanData): { name: string; attributes: Record<string, string | number> } | undefined {
  switch (data.type) {
    case 'agent':
      return { name: `invoke_agent ${data.name}`, attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': data.name } };
    case 'generation': {
      const model = String(data.model ?? '');
      const usage = (data.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      return {
        name: `chat ${model}`,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.request.model': model,
          'gen_ai.input.messages': JSON.stringify(toGenAI(data.input)),
          'gen_ai.output.messages': JSON.stringify(toGenAI(data.output)),
          ...(usage.input_tokens !== undefined ? { 'gen_ai.usage.input_tokens': usage.input_tokens } : {}),
          ...(usage.output_tokens !== undefined ? { 'gen_ai.usage.output_tokens': usage.output_tokens } : {}),
        },
      };
    }
    case 'function':
      return {
        name: `execute_tool ${data.name}`,
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': data.name,
          'gen_ai.tool.type': 'function',
          'gen_ai.tool.call.arguments': data.input,
          'gen_ai.tool.call.result': data.output,
        },
      };
    default:
      return undefined; // task, turn, ...: their children attach to the nearest exported ancestor
  }
}

class OTelBridge implements TracingProcessor {
  private readonly tracer = trace.getTracer('openai-agents-otel-bridge');
  private readonly spans = new Map<string, { parentId: string | null; otel?: OTelSpan }>();

  private parentContext(parentId: string | null): Context {
    for (let id = parentId; id; id = this.spans.get(id)?.parentId ?? null) {
      const otel = this.spans.get(id)?.otel;
      if (otel) return trace.setSpan(context.active(), otel);
    }
    return context.active();
  }

  async onTraceStart(): Promise<void> {}
  async onTraceEnd(): Promise<void> {}

  async onSpanStart(span: Span<SpanData>): Promise<void> {
    const d = describe(span.spanData);
    const otel = d
      ? this.tracer.startSpan(d.name, { startTime: new Date(span.startedAt ?? Date.now()) }, this.parentContext(span.parentId))
      : undefined;
    this.spans.set(span.spanId, { parentId: span.parentId, otel });
  }

  async onSpanEnd(span: Span<SpanData>): Promise<void> {
    const otel = this.spans.get(span.spanId)?.otel;
    if (otel) {
      const d = describe(span.spanData);
      // The model is known only at the end of a generation span.
      if (d) otel.updateName(d.name).setAttributes(d.attributes);
      if (span.error) otel.setStatus({ code: SpanStatusCode.ERROR, message: span.error.message });
      otel.end(new Date(span.endedAt ?? Date.now()));
    }
    // Keep the entry while children may still look up their parent; drop it at the end of the run.
    if (!span.parentId) this.spans.clear();
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

// Replaces the default processor, which exports to the OpenAI tracing backend.
setTraceProcessors([new OTelBridge()]);

// ------------------------------------------------------------ shared data + tools

interface City {
  name: string;
  weather: { condition: string; high_c: number; low_c: number };
  events: { name: string; time: string }[];
}
const DATA = JSON.parse(
  readFileSync(new URL('../../shared/travel_data.json', import.meta.url), 'utf8'),
) as { system_prompt: string; cities: Record<string, City> };

const cityInput = z.object({ city: z.string().describe('City name, for example "Paris"') });

const tools = [
  tool({
    name: 'get_weather',
    description: 'Get the weather forecast for a city.',
    parameters: cityInput,
    execute: async ({ city }) => {
      const c = DATA.cities[city.trim().toLowerCase()];
      return c ? { city: c.name, ...c.weather } : { error: `no data for ${city}` };
    },
  }),
  tool({
    name: 'find_events',
    description: 'Find upcoming events in a city.',
    parameters: cityInput,
    execute: async ({ city }) => {
      const c = DATA.cities[city.trim().toLowerCase()];
      return c ? { city: c.name, events: c.events } : { error: `no data for ${city}` };
    },
  }),
];

// ------------------------------------------------------------------- the agent

async function makeModel(): Promise<string | Model> {
  if (process.env.OPENAI_API_KEY) return process.env.MODEL_ID ?? 'gpt-4.1-mini';
  // No OpenAI key: Claude on Amazon Bedrock through the AI SDK adapter.
  const { aisdk } = await import('@openai/agents-extensions/ai-sdk');
  const { createAmazonBedrock } = await import('@ai-sdk/amazon-bedrock');
  const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
  const bedrock = createAmazonBedrock({
    region: process.env.AWS_REGION ?? 'us-west-2',
    credentialProvider: fromNodeProviderChain(),
  });
  return aisdk(bedrock(process.env.MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0'));
}

const agent = new Agent({
  name: 'travel_assistant',
  instructions: DATA.system_prompt,
  tools,
  model: await makeModel(),
});

const question = process.argv.slice(2).join(' ') || 'Plan a one-day trip to Paris.';
const result = await run(agent, question);
console.log(String(result.finalOutput ?? '').trim());

// Flush the spans before the process exits.
await provider.shutdown();
