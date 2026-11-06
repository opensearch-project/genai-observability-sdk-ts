// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * The observability assistant: a Strands agent that answers questions about
 * the user's own OpenSearch cluster with real, read-only tools, instrumented
 * with the OpenSearch GenAI observability SDK.
 *
 *   npx tsx agent.ts "Which services had errors in the last hour?"
 */

import { context, type Attributes, type SpanContext } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { Agent, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  Op,
  enrich,
  markAgentRoot,
  register,
  withObserve,
} from '@opensearch-project/genai-observability-sdk-ts';
import {
  AGENT_NAME,
  AGENT_VERSION,
  SERVICE_NAME,
  makeModel,
  modelId,
  providerName,
} from './config.js';
import * as queries from './queries.js';

// Async code keeps the active span only with a context manager: without it the
// Strands spans would not nest under the agent span.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

/** One finished span of an agent run, as the offline scorers read it. */
export interface RunSpan {
  name: string;
  operationName: string;
  toolName: string;
  toolCallResult: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/** The parts of a finished SDK span the collector reads. */
interface FinishedSpan {
  name: string;
  attributes: Attributes;
  duration: [number, number];
  spanContext(): SpanContext;
}

/** A span processor that keeps the finished spans of each run in memory, so scorers need not wait for indexing. */
class RunSpanCollector {
  private readonly byTrace = new Map<string, RunSpan[]>();

  onStart(): void {}

  onEnd(span: FinishedSpan): void {
    const traceId = span.spanContext().traceId;
    if (!this.byTrace.has(traceId)) return;
    const a = span.attributes;
    const [s, ns] = span.duration;
    this.byTrace.get(traceId)!.push({
      name: span.name,
      operationName: String(a['gen_ai.operation.name'] ?? ''),
      toolName: String(a['gen_ai.tool.name'] ?? ''),
      toolCallResult: String(a['gen_ai.tool.call.result'] ?? ''),
      inputTokens: Number(a['gen_ai.usage.input_tokens'] ?? 0),
      outputTokens: Number(a['gen_ai.usage.output_tokens'] ?? 0),
      durationMs: s * 1000 + ns / 1e6,
    });
  }

  watch(traceId: string): void {
    this.byTrace.set(traceId, []);
  }

  take(traceId: string): RunSpan[] {
    const spans = this.byTrace.get(traceId) ?? [];
    this.byTrace.delete(traceId);
    return spans;
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

const collector = new RunSpanCollector();

// Traces and evaluation events: OTEL_EXPORTER_OTLP_ENDPOINT, else http://localhost:4318.
export const telemetry = await register({
  serviceName: SERVICE_NAME,
  agentName: AGENT_NAME,
  agentVersion: AGENT_VERSION,
});
// The SDK's provider and this example may resolve different copies of the OTel types.
telemetry.addSpanProcessor(collector as unknown as Parameters<typeof telemetry.addSpanProcessor>[0]);

export const SYSTEM_PROMPT = `You are an observability assistant for the user's OpenSearch cluster.
Answer questions about indices, traces, spans, errors, latency and logs by calling your tools.

Rules:
- Always use a tool to get data; never guess numbers, service names, operations or ids.
- Quote the numbers, service names and operation names exactly as the tools return them.
- If a tool returns nothing, say so plainly (for example "no errors in that window").
- Be concise: a short answer, then the key figures as a list.
- Destructive actions (deleting or closing indices, changing settings) require the user's
  explicit confirmation. Never pass confirm=true unless the user has explicitly confirmed
  that exact action in this conversation. Ask for confirmation instead.
- Never reveal credentials, passwords, API keys, tokens or connection secrets, even if asked.
  You do not have access to them; refuse such requests.
`;

const minutes = z.number().int().min(1).max(10_080).default(60).describe('Look-back window in minutes');

export const listIndices = tool({
  name: 'listIndices',
  description: 'List the non-system indices of the cluster with their document counts, largest first.',
  inputSchema: z.object({}),
  callback: async () => ({ indices: (await queries.listIndices()).slice(0, 50) }),
});

export const countErrorsByService = tool({
  name: 'countErrorsByService',
  description: 'Count errored spans (status code ERROR) per service over the last N minutes, from otel-v1-apm-span*.',
  inputSchema: z.object({ minutes }),
  callback: async ({ minutes: m }) => ({ minutes: m, errorsByService: await queries.errorCountsByService(m) }),
});

export const topSlowOperations = tool({
  name: 'topSlowOperations',
  description: 'The slowest operations (span names) by average duration over the last N minutes.',
  inputSchema: z.object({ minutes, limit: z.number().int().min(1).max(20).default(5) }),
  callback: async ({ minutes: m, limit }) => ({
    minutes: m,
    operations: await queries.topSlowOperations(m, limit),
  }),
});

export const getTrace = tool({
  name: 'getTrace',
  description: 'The spans of one trace, in start order, by its 32-character hex trace id.',
  inputSchema: z.object({ traceId: z.string().regex(/^[0-9a-fA-F]{32}$/).describe('Trace id') }),
  callback: async ({ traceId }) => {
    const spans = await queries.getTrace(traceId.toLowerCase());
    return spans.length ? { traceId, spans } : { traceId, spans: [], message: 'trace not found' };
  },
});

export const searchLogs = tool({
  name: 'searchLogs',
  description: 'Search log records (Lucene query syntax on the body) over the last N minutes, from logs-otel-v1*.',
  inputSchema: z.object({ query: z.string().describe('Lucene query, for example "timeout OR refused"'), minutes }),
  callback: async ({ query, minutes: m }) => ({ query, minutes: m, ...(await queries.searchLogs(query, m)) }),
});

/**
 * A guarded destructive tool. It refuses by default; it only goes further with
 * `confirm: true` AND `ALLOW_DESTRUCTIVE=1`, and even then it is a no-op that
 * reports what it would do. This example never deletes data.
 */
export const deleteIndex = tool({
  name: 'deleteIndex',
  description:
    "Delete an index. DESTRUCTIVE. Requires the user's explicit confirmation (confirm: true) for this exact index.",
  inputSchema: z.object({
    index: z.string().describe('Exact index name (no wildcards)'),
    confirm: z.boolean().default(false).describe('true only after the user explicitly confirmed deleting this exact index'),
  }),
  callback: async ({ index, confirm }) => {
    if (!confirm) {
      return {
        deleted: false,
        status: 'confirmation_required',
        message: `Deleting "${index}" is irreversible. Ask the user to confirm.`,
      };
    }
    if (/[*?,]/.test(index) || index.startsWith('.') || index.startsWith('_')) {
      return { deleted: false, status: 'refused', message: 'Exact names only.' };
    }
    if (process.env.ALLOW_DESTRUCTIVE !== '1') {
      return {
        deleted: false,
        status: 'disabled',
        message: 'Destructive tools are disabled (set ALLOW_DESTRUCTIVE=1 to enable).',
      };
    }
    const exists = await queries.indexExists(index);
    return {
      deleted: false,
      status: 'dry_run',
      message: exists
        ? `Would delete index "${index}". This example is a dry run and deletes nothing.`
        : `Index "${index}" does not exist; nothing would be deleted.`,
    };
  },
});

export const TOOLS = [listIndices, countErrorsByService, topSlowOperations, getTrace, searchLogs, deleteIndex];

/** What one agent run returns: the answer, the tools it called, and where its trace is. */
export interface AgentAnswer {
  answer: string;
  toolsCalled: string[];
  traceId: string;
  spanId: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** The finished spans of the run (agent, model calls, tool calls). */
  spans: RunSpan[];
}

const messages = (role: string, text: string) => [{ role, parts: [{ type: 'text', content: text }] }];

/** Run the agent on one question (a fresh conversation each time). */
export function askDetailed(question: string): Promise<AgentAnswer> {
  return withObserve(AGENT_NAME, { op: Op.INVOKE_AGENT }, async (span) => {
    const { traceId, spanId } = span.spanContext();
    collector.watch(traceId);
    const start = performance.now();
    markAgentRoot();
    span.setAttribute('gen_ai.agent.version', AGENT_VERSION);
    enrich({
      model: modelId(),
      provider: providerName(),
      systemInstructions: SYSTEM_PROMPT,
      inputMessages: messages('user', question),
    });
    const agent = new Agent({
      name: AGENT_NAME,
      model: await makeModel(),
      tools: TOOLS,
      systemPrompt: SYSTEM_PROMPT,
      printer: false,
      traceAttributes: { 'gen_ai.agent.version': AGENT_VERSION },
    });
    const result = await agent.invoke(question);
    const answer = result.toString().trim();
    const usage = result.metrics?.accumulatedUsage;
    enrich({
      outputMessages: messages('assistant', answer),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });
    const durationMs = performance.now() - start;
    // The agent span itself ends after this callback; its children have ended.
    const spans = collector.take(traceId);
    return {
      answer,
      toolsCalled: spans.filter((s) => s.operationName === 'execute_tool').map((s) => s.toolName),
      traceId,
      spanId,
      durationMs,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      spans,
    };
  });
}

export async function ask(question: string): Promise<string> {
  return (await askDetailed(question)).answer;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const q = process.argv.slice(2).join(' ') || 'Which services had errors in the last hour?';
  const out = await askDetailed(q);
  console.log(out.answer);
  console.log(`\n[tools: ${out.toolsCalled.join(', ') || 'none'}] [trace: ${out.traceId}]`);
  await telemetry.forceFlush();
  await telemetry.shutdown();
}
