// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { AGENT_ROOT_ATTRIBUTE } from './enrich.js';
import { EVALUATION_RESULT_EVENT } from './score.js';

/**
 * `listRootSpans()` lists a trace by its agent root: a span marked `derived.gen_ai.is_root` (by
 * Data Prepper, an SDK or the user), for example the agent span below an HTTP server span, or a
 * trace root (no parent) that is an agent operation. A judge's own parentless chat span is not an
 * agent root.
 */
const AI_ROOT_FIELD = `attributes.${AGENT_ROOT_ATTRIBUTE}`;
const OPERATION_FIELD = 'attributes.gen_ai.operation.name';
const AGENT_OPERATIONS = ['invoke_agent', 'create_agent'];
const CONVERSATION_FIELD = 'attributes.gen_ai.conversation.id';
const EVALUATOR_NAME_FIELD = 'attributes.opensearch.gen_ai.evaluation.evaluator.name';
const EVALUATION_NAME_FIELD = 'attributes.gen_ai.evaluation.name';
const TRACE_ID_FIELD = 'traceId';

/** Logged once per process when `listRootSpans()` finds nothing. */
export const ROOT_RULE_HINT =
  'listRootSpans() found no agent roots. A root is a span marked derived.gen_ai.is_root, ' +
  'or a span without a parent whose gen_ai.operation.name is invoke_agent or create_agent. ' +
  "Call markAgentRoot() in the agent's span, or trace the agent with observe({ op: Op.INVOKE_AGENT }).";
let rootHintLogged = false;

function logRootHintOnce(): void {
  if (rootHintLogged) return;
  rootHintLogged = true;
  console.info(ROOT_RULE_HINT);
}

/** For tests: log the no-roots hint again. */
export function resetRootHint(): void {
  rootHintLogged = false;
}

/** A marked span, or a parentless span of an agent operation. */
function agentRootQuery(): Record<string, unknown> {
  return {
    bool: {
      should: [
        { term: { [AI_ROOT_FIELD]: true } },
        {
          bool: {
            filter: [
              { term: { parentSpanId: '' } },
              { terms: { [OPERATION_FIELD]: AGENT_OPERATIONS } },
            ],
          },
        },
      ],
      minimum_should_match: 1,
    },
  };
}

/** Upper bound on the traces `getTraces()` collects for one conversation. */
export const DEFAULT_MAX_CONVERSATION_TRACES = 1000;

type SearchFn = (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;

function responseBody(response: Record<string, unknown>): Record<string, unknown> {
  return (response['body'] as Record<string, unknown>) ?? response;
}

function sourcesOf(response: Record<string, unknown>): Record<string, unknown>[] {
  const hits = responseBody(response)['hits'] as Record<string, unknown> | undefined;
  const hitList = (hits?.['hits'] as Record<string, unknown>[]) ?? [];
  return hitList.map((hit) => (hit['_source'] as Record<string, unknown>) ?? hit);
}

export interface Message {
  role: string;
  content: string;
}

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  startTime: string;
  endTime: string;
  operationName: string;
  agentName: string;
  /** `gen_ai.agent.version`; empty when the span has none. */
  agentVersion: string;
  model: string;
  inputMessages: Message[];
  outputMessages: Message[];
  toolName: string;
  toolCallArguments: string;
  toolCallResult: string;
  inputTokens: number;
  outputTokens: number;
  raw: Record<string, unknown>;
}

export interface TraceRecord {
  traceId: string;
  spans: SpanRecord[];
}

export interface SessionRecord {
  sessionId: string;
  traces: TraceRecord[];
  truncated: boolean;
}

/**
 * Parse GenAI semantic convention message format.
 * Handles JSON strings, arrays of message objects, or null.
 */
export function parseMessages(raw: string | unknown[] | null): Message[] {
  if (raw == null) return [];

  if (typeof raw === 'string' && raw.length === 0) return [];

  let items: unknown[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      items = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  } else {
    items = raw;
  }

  const messages: Message[] = [];
  for (const item of items) {
    if (item == null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const role = String(obj['role'] ?? 'unknown');

    // GenAI semconv format: { role, parts: [{ type: "text", content: "..." }] }
    const parts = obj['parts'];
    if (Array.isArray(parts)) {
      const textParts = parts
        .filter((p: unknown) => p && typeof p === 'object' && (p as Record<string, unknown>)['type'] === 'text')
        .map((p: unknown) => String((p as Record<string, unknown>)['content'] ?? ''));
      if (textParts.length > 0) {
        messages.push({ role, content: textParts.join('\n') });
      }
    } else if (obj['content'] !== undefined) {
      // Simple format: { role, content }
      messages.push({ role, content: String(obj['content']) });
    }
  }
  return messages;
}

/**
 * Extract input/output messages from an OpenSearch span document.
 * Tries span events first (gen_ai.content.prompt / gen_ai.content.completion),
 * then falls back to span attributes.
 */
export function extractMessagesFromDoc(doc: Record<string, unknown>): {
  inputMessages: Message[];
  outputMessages: Message[];
} {
  const attrs =
    (doc['attributes'] as Record<string, unknown> | undefined) ?? {};
  const events = (doc['events'] as unknown[] | undefined) ?? [];

  let inputMessages: Message[] = [];
  let outputMessages: Message[] = [];

  // Try events first (latest GenAI conventions)
  for (const evt of events) {
    if (evt == null || typeof evt !== 'object') continue;
    const event = evt as Record<string, unknown>;
    const eventAttrs =
      (event['attributes'] as Record<string, unknown> | undefined) ?? {};

    if (inputMessages.length === 0 && eventAttrs['gen_ai.input.messages']) {
      inputMessages = parseMessages(eventAttrs['gen_ai.input.messages'] as string | unknown[] | null);
    }
    if (outputMessages.length === 0 && eventAttrs['gen_ai.output.messages']) {
      outputMessages = parseMessages(eventAttrs['gen_ai.output.messages'] as string | unknown[] | null);
    }
  }

  // Fall back to span attributes
  if (inputMessages.length === 0) {
    inputMessages = parseMessages(attrs['gen_ai.input.messages'] as string | unknown[] | null);
  }
  if (outputMessages.length === 0) {
    outputMessages = parseMessages(attrs['gen_ai.output.messages'] as string | unknown[] | null);
  }

  return { inputMessages, outputMessages };
}

/**
 * Convert a raw OpenSearch span document into a SpanRecord.
 */
export function mapSpanDoc(doc: Record<string, unknown>): SpanRecord {
  const attrs =
    (doc['attributes'] as Record<string, unknown> | undefined) ?? {};
  const { inputMessages, outputMessages } = extractMessagesFromDoc(doc);

  return {
    traceId: String(doc['traceId'] ?? doc['trace_id'] ?? ''),
    spanId: String(doc['spanId'] ?? doc['span_id'] ?? ''),
    parentSpanId: String(
      doc['parentSpanId'] ?? doc['parent_span_id'] ?? '',
    ),
    name: String(doc['name'] ?? ''),
    startTime: String(doc['startTime'] ?? doc['start_time'] ?? ''),
    endTime: String(doc['endTime'] ?? doc['end_time'] ?? ''),
    operationName: String(attrs['gen_ai.operation.name'] ?? ''),
    agentName: String(attrs['gen_ai.agent.name'] ?? ''),
    agentVersion: String(attrs['gen_ai.agent.version'] ?? ''),
    model: String(
      attrs['gen_ai.response.model'] ??
        attrs['gen_ai.request.model'] ??
        '',
    ),
    inputMessages,
    outputMessages,
    toolName: String(attrs['gen_ai.tool.name'] ?? ''),
    toolCallArguments: String(attrs['gen_ai.tool.call.arguments'] ?? ''),
    toolCallResult: String(attrs['gen_ai.tool.call.result'] ?? ''),
    inputTokens: Number(attrs['gen_ai.usage.input_tokens'] ?? 0),
    outputTokens: Number(attrs['gen_ai.usage.output_tokens'] ?? 0),
    raw: doc,
  };
}

export interface OpenSearchTraceRetrieverOptions {
  host?: string;
  /** Index pattern for span data. Default `otel-v1-apm-span-*`. */
  index?: string;
  /**
   * Index pattern for evaluation results (`gen_ai.evaluation.result` events
   * routed by Data Prepper). Default `otel-v1-genai-evaluation*`.
   */
  evaluationIndex?: string;
  auth?: { username: string; password: string } | 'awsSigV4';
  verifyCerts?: boolean;
}

export class OpenSearchTraceRetriever {
  private _clientPromise: Promise<unknown>;
  private _index: string;
  private _evaluationIndex: string;

  constructor(options?: OpenSearchTraceRetrieverOptions) {
    const host = options?.host ?? 'https://localhost:9200';
    this._index = options?.index ?? 'otel-v1-apm-span-*';
    this._evaluationIndex = options?.evaluationIndex ?? 'otel-v1-genai-evaluation*';

    this._clientPromise = this._createClient(host, options);
  }

  private async _createClient(
    host: string,
    options?: OpenSearchTraceRetrieverOptions,
  ): Promise<unknown> {
    let Client: new (opts: Record<string, unknown>) => unknown;
    try {
      const mod = await import('@opensearch-project/opensearch');
      Client = (mod as Record<string, unknown>)['Client'] as typeof Client;
    } catch {
      throw new Error(
        "Package '@opensearch-project/opensearch' is required for OpenSearchTraceRetriever. " +
          'Install it with: npm install @opensearch-project/opensearch',
      );
    }

    const clientOpts: Record<string, unknown> = { node: host };

    if (options?.auth === 'awsSigV4') {
      // AWS SigV4 auth would be configured via opensearch connection class
      // For now, pass node only — users should use the AwsSigv4Signer from
      // @opensearch-project/opensearch/aws
    } else if (
      options?.auth &&
      typeof options.auth === 'object' &&
      'username' in options.auth
    ) {
      clientOpts['auth'] = {
        username: options.auth.username,
        password: options.auth.password,
      };
    }

    if (options?.verifyCerts === false) {
      clientOpts['ssl'] = { rejectUnauthorized: false };
    }

    return new Client(clientOpts);
  }

  private async _search(): Promise<{ client: Record<string, unknown>; search: SearchFn }> {
    const client = (await this._clientPromise) as Record<string, unknown>;
    return { client, search: client['search'] as SearchFn };
  }

  /**
   * All spans of a conversation's traces, or of one trace, grouped by trace.
   *
   * Looks up the traces whose spans carry `gen_ai.conversation.id` = `identifier` (earliest
   * first, at most `maxTraces`), then fetches every span of those traces, so each `TraceRecord`
   * holds the whole trace (model calls, tools and the agent span) exactly as
   * `getTraces(traceId)` does. If no span has that conversation id, `identifier` is treated as a
   * `traceId`. `truncated` is `true` when `maxSpans` or `maxTraces` was reached.
   */
  async getTraces(
    identifier: string,
    maxSpans?: number,
    options?: { maxTraces?: number },
  ): Promise<SessionRecord> {
    const { client, search } = await this._search();
    const size = maxSpans ?? 1000;
    const maxTraces = options?.maxTraces ?? DEFAULT_MAX_CONVERSATION_TRACES;

    const lookup = await search.call(client, {
      index: this._index,
      body: {
        size: 0,
        query: {
          bool: {
            should: [
              { term: { [CONVERSATION_FIELD]: identifier } },
              // Attribute names written by older SDK versions.
              { term: { 'attributes.conversation_id': identifier } },
              { term: { 'attributes.gen_ai.conversation_id': identifier } },
            ],
            minimum_should_match: 1,
          },
        },
        aggs: {
          by_trace: {
            terms: { field: 'traceId', size: maxTraces, order: { first_start: 'asc' } },
            aggs: { first_start: { min: { field: 'startTime' } } },
          },
        },
      },
    });
    const aggs = responseBody(lookup)['aggregations'] as Record<string, unknown> | undefined;
    const byTrace = aggs?.['by_trace'] as Record<string, unknown> | undefined;
    const traceIds = ((byTrace?.['buckets'] as Record<string, unknown>[]) ?? []).map((b) =>
      String(b['key']),
    );
    const moreTraces = Number(byTrace?.['sum_other_doc_count'] ?? 0) > 0;

    const response = await search.call(client, {
      index: this._index,
      body: {
        query: traceIds.length > 0
          ? { terms: { traceId: traceIds } }
          : { term: { traceId: identifier } },
        size,
        sort: [{ startTime: { order: 'asc' } }],
      },
    });
    const docs = sourcesOf(response);

    // Group spans by traceId, traces in order of their first span.
    const traceMap = new Map<string, SpanRecord[]>();
    for (const doc of docs) {
      const span = mapSpanDoc(doc);
      const existing = traceMap.get(span.traceId);
      if (existing) {
        existing.push(span);
      } else {
        traceMap.set(span.traceId, [span]);
      }
    }
    const traces: TraceRecord[] = [];
    for (const [traceId, spans] of traceMap) {
      traces.push({ traceId, spans });
    }

    const hits = responseBody(response)['hits'] as Record<string, unknown> | undefined;
    const totalHits =
      typeof hits?.['total'] === 'object'
        ? Number((hits['total'] as Record<string, unknown>)['value'] ?? 0)
        : Number(hits?.['total'] ?? 0);

    return {
      sessionId: identifier,
      traces,
      truncated: docs.length > 0 && (moreTraces || totalHits > size),
    };
  }

  /**
   * The agent roots of recent traces, newest first, one per trace.
   *
   * A span is an agent root when it is marked `derived.gen_ai.is_root` (by Data Prepper,
   * `markAgentRoot()` or the user), or when it has no parent and its `gen_ai.operation.name` is
   * `invoke_agent` or `create_agent`. Other parentless GenAI spans, such as a traced LLM judge's
   * own `chat` span, are not listed. For an agent behind an HTTP handler this returns the marked
   * agent span (with its messages and agent name), not the HTTP server span.
   *
   * Each trace is listed once: by its parentless agent root when it has one, else by its
   * earliest marked span (for example when the agents of several services in one trace are
   * marked). Traces are picked by their newest matching span since `since`; the returned root may
   * have started earlier.
   *
   * When nothing matches, one `console.info` line per process names this rule. Indices where the
   * marker is not mapped yet (no marked span so far) are fine: the marker condition matches
   * nothing there.
   */
  async listRootSpans(options?: {
    /** Only spans of these services (the span index's `serviceName`). */
    services?: string[];
    /** Only traces with an agent root started at or after this time. */
    since?: Date;
    /** Maximum number of traces (root spans) to return. Default 50. */
    maxResults?: number;
  }): Promise<SpanRecord[]> {
    const maxResults = options?.maxResults ?? 50;
    if (maxResults <= 0) return [];
    const { client, search } = await this._search();

    const serviceFilter: Record<string, unknown>[] =
      options?.services && options.services.length > 0
        ? [{ terms: { serviceName: options.services } }]
        : [];
    const sinceFilter: Record<string, unknown>[] = options?.since
      ? [{ range: { startTime: { gte: options.since.toISOString() } } }]
      : [];

    // 1. Up to maxResults distinct traces with an agent root (since `since`), newest first.
    const tracesResponse = await search.call(client, {
      index: this._index,
      body: {
        size: Math.min(maxResults, 10000),
        _source: [TRACE_ID_FIELD],
        sort: [{ startTime: { order: 'desc' } }],
        collapse: { field: TRACE_ID_FIELD },
        query: { bool: { filter: [agentRootQuery(), ...sinceFilter, ...serviceFilter] } },
      },
    });
    const traceIds = [
      ...new Set(sourcesOf(tracesResponse).map((d) => String(d[TRACE_ID_FIELD] ?? ''))),
    ].filter(Boolean);
    if (traceIds.length === 0) {
      logRootHintOnce();
      return [];
    }

    // 2. The root of each of those traces, at any time: the parentless agent root (scores 1)
    // first, else the earliest marked span.
    const rootsResponse = await search.call(client, {
      index: this._index,
      body: {
        size: traceIds.length,
        sort: [{ _score: { order: 'desc' } }, { startTime: { order: 'asc' } }],
        collapse: { field: TRACE_ID_FIELD },
        query: {
          bool: {
            filter: [agentRootQuery(), { terms: { [TRACE_ID_FIELD]: traceIds } }, ...serviceFilter],
            should: [{ constant_score: { filter: { term: { parentSpanId: '' } } } }],
          },
        },
      },
    });
    const byTrace = new Map(sourcesOf(rootsResponse).map((d) => [String(d[TRACE_ID_FIELD] ?? ''), d]));
    return traceIds.filter((id) => byTrace.has(id)).map((id) => mapSpanDoc(byTrace.get(id)!));
  }

  /**
   * The subset of `traceIds` that already has an evaluation result: a
   * `gen_ai.evaluation.result` event with that `traceId` in the evaluation
   * index. A missing evaluation index means none are evaluated; any other
   * error (auth, connection, mapping) is thrown, so callers do not re-run
   * judges and write duplicate results.
   *
   * Without a filter, a result from any evaluator counts. Pass `evaluator`
   * and/or `evaluationName` so a job skips only the traces it scored itself.
   */
  async findEvaluatedTraceIds(
    traceIds: string[],
    options?: {
      /**
       * Only count results of this evaluator (`opensearch.gen_ai.evaluation.evaluator.name`,
       * the `evaluator` of `score()`).
       */
      evaluator?: string;
      /** Only count results with this name (`gen_ai.evaluation.name`, the `score()` name). */
      evaluationName?: string;
    },
  ): Promise<Set<string>> {
    if (traceIds.length === 0) return new Set();

    const { client, search } = await this._search();
    const filter: Record<string, unknown>[] = [
      { term: { eventName: EVALUATION_RESULT_EVENT } },
      { terms: { traceId: traceIds } },
    ];
    if (options?.evaluator) filter.push({ term: { [EVALUATOR_NAME_FIELD]: options.evaluator } });
    if (options?.evaluationName) {
      filter.push({ term: { [EVALUATION_NAME_FIELD]: options.evaluationName } });
    }

    const response = await search.call(client, {
      index: this._evaluationIndex,
      // A missing index (no results sent yet) is an empty answer, not an error.
      ignore_unavailable: true,
      allow_no_indices: true,
      body: {
        size: 0,
        query: { bool: { filter } },
        aggs: {
          by_trace: { terms: { field: 'traceId', size: traceIds.length } },
        },
      },
    });

    const aggs = responseBody(response)['aggregations'] as Record<string, unknown> | undefined;
    const byTrace = aggs?.['by_trace'] as Record<string, unknown> | undefined;
    const buckets = (byTrace?.['buckets'] as Record<string, unknown>[]) ?? [];
    const wanted = new Set(traceIds);
    return new Set(buckets.map((b) => String(b['key'])).filter((id) => wanted.has(id)));
  }
}
