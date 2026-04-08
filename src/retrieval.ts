// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

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
  index?: string;
  auth?: { username: string; password: string } | 'awsSigV4';
  verifyCerts?: boolean;
}

export class OpenSearchTraceRetriever {
  private _clientPromise: Promise<unknown>;
  private _index: string;

  constructor(options?: OpenSearchTraceRetrieverOptions) {
    const host = options?.host ?? 'https://localhost:9200';
    this._index = options?.index ?? 'otel-v1-apm-span-*';

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

  async getTraces(
    identifier: string,
    maxSpans?: number,
  ): Promise<SessionRecord> {
    const client = (await this._clientPromise) as Record<string, unknown>;
    const search = client['search'] as (
      opts: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const size = maxSpans ?? 1000;

    // Try conversation_id first
    let response = await search.call(client, {
      index: this._index,
      body: {
        query: {
          bool: {
            should: [
              {
                term: {
                  'attributes.conversation_id': identifier,
                },
              },
              {
                term: {
                  'attributes.gen_ai.conversation_id': identifier,
                },
              },
            ],
            minimum_should_match: 1,
          },
        },
        size,
        sort: [{ startTime: { order: 'asc' } }],
      },
    });

    let body = (response['body'] as Record<string, unknown>) ?? response;
    let hits = body['hits'] as Record<string, unknown> | undefined;
    let hitList = (hits?.['hits'] as Record<string, unknown>[]) ?? [];

    // Fall back to traceId
    if (hitList.length === 0) {
      response = await search.call(client, {
        index: this._index,
        body: {
          query: { term: { traceId: identifier } },
          size,
          sort: [{ startTime: { order: 'asc' } }],
        },
      });
      body = (response['body'] as Record<string, unknown>) ?? response;
      hits = body['hits'] as Record<string, unknown> | undefined;
      hitList = (hits?.['hits'] as Record<string, unknown>[]) ?? [];
    }

    // Group spans by traceId
    const traceMap = new Map<string, SpanRecord[]>();
    for (const hit of hitList) {
      const source =
        (hit['_source'] as Record<string, unknown>) ?? hit;
      const span = mapSpanDoc(source);
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

    const totalHits =
      typeof hits?.['total'] === 'object'
        ? ((hits['total'] as Record<string, unknown>)['value'] as number)
        : (hits?.['total'] as number) ?? 0;

    return {
      sessionId: identifier,
      traces,
      truncated: totalHits > size,
    };
  }

  async listRootSpans(options?: {
    services?: string[];
    since?: Date;
    maxResults?: number;
  }): Promise<SpanRecord[]> {
    const client = (await this._clientPromise) as Record<string, unknown>;
    const search = client['search'] as (
      opts: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const size = options?.maxResults ?? 50;

    const filters: Record<string, unknown>[] = [
      { term: { parentSpanId: '' } },
    ];

    if (options?.services && options.services.length > 0) {
      filters.push({
        terms: { 'resource.service.name': options.services },
      });
    }

    if (options?.since) {
      filters.push({
        range: { startTime: { gte: options.since.toISOString() } },
      });
    }

    const response = await search.call(client, {
      index: this._index,
      body: {
        query: { bool: { filter: filters } },
        size,
        sort: [{ startTime: { order: 'desc' } }],
      },
    });

    const body =
      (response['body'] as Record<string, unknown>) ?? response;
    const hits = body['hits'] as Record<string, unknown> | undefined;
    const hitList = (hits?.['hits'] as Record<string, unknown>[]) ?? [];

    return hitList.map((hit) => {
      const source =
        (hit['_source'] as Record<string, unknown>) ?? hit;
      return mapSpanDoc(source);
    });
  }

  async findEvaluatedTraceIds(traceIds: string[]): Promise<Set<string>> {
    if (traceIds.length === 0) return new Set();

    const client = (await this._clientPromise) as Record<string, unknown>;
    const search = client['search'] as (
      opts: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const response = await search.call(client, {
      index: this._index,
      body: {
        query: {
          bool: {
            filter: [
              { terms: { traceId: traceIds } },
              { exists: { field: 'attributes.test.suite.name' } },
            ],
          },
        },
        size: 0,
        aggs: {
          evaluated_traces: {
            terms: {
              field: 'traceId',
              size: traceIds.length,
            },
          },
        },
      },
    });

    const body =
      (response['body'] as Record<string, unknown>) ?? response;
    const aggs = body['aggregations'] as
      | Record<string, unknown>
      | undefined;
    const evaluated = aggs?.['evaluated_traces'] as
      | Record<string, unknown>
      | undefined;
    const buckets =
      (evaluated?.['buckets'] as Record<string, unknown>[]) ?? [];

    return new Set(buckets.map((b) => String(b['key'])));
  }
}
