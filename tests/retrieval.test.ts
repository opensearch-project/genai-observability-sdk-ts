// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect } from 'vitest';
import {
  parseMessages,
  extractMessagesFromDoc,
  mapSpanDoc,
  dropShadowedAiRoots,
  OpenSearchTraceRetriever,
} from '../src/retrieval.js';

describe('parseMessages', () => {
  it('returns empty array for null', () => {
    expect(parseMessages(null)).toEqual([]);
  });

  it('returns empty array for undefined-like null', () => {
    expect(parseMessages(null)).toEqual([]);
  });

  it('parses JSON string of messages', () => {
    const raw = JSON.stringify([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);
    const messages = parseMessages(raw);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('Hi!');
  });

  it('parses array of message objects directly', () => {
    const raw = [
      { role: 'user', content: 'test' },
    ];
    const messages = parseMessages(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('test');
  });

  it('handles invalid JSON string', () => {
    const result = parseMessages('not valid json');
    // Invalid JSON returns empty array
    expect(result).toHaveLength(0);
  });

  it('handles single object JSON string', () => {
    const raw = JSON.stringify({ role: 'system', content: 'You are helpful' });
    const messages = parseMessages(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
  });

  it('handles empty array', () => {
    expect(parseMessages([])).toEqual([]);
  });

  it('skips null items in array', () => {
    const raw = [null, { role: 'user', content: 'test' }, null];
    const messages = parseMessages(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('defaults role to unknown when missing', () => {
    const raw = [{ content: 'no role' }];
    const messages = parseMessages(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('unknown');
  });

  it('skips items with no content or parts', () => {
    const raw = [{ role: 'user' }];
    const messages = parseMessages(raw);
    // Items with neither parts nor content are skipped
    expect(messages).toHaveLength(0);
  });
});

describe('extractMessagesFromDoc', () => {
  it('extracts messages from events', () => {
    const doc = {
      attributes: {},
      events: [
        {
          attributes: {
            'gen_ai.input.messages': JSON.stringify([{ role: 'user', content: 'hi' }]),
          },
        },
        {
          attributes: {
            'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', content: 'hello' }]),
          },
        },
      ],
    };

    const result = extractMessagesFromDoc(doc);
    expect(result.inputMessages).toHaveLength(1);
    expect(result.inputMessages[0].content).toBe('hi');
    expect(result.outputMessages).toHaveLength(1);
    expect(result.outputMessages[0].content).toBe('hello');
  });

  it('falls back to span attributes when no events', () => {
    const doc = {
      attributes: {
        'gen_ai.input.messages': JSON.stringify([{ role: 'user', content: 'from attr' }]),
        'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', content: 'response' }]),
      },
    };

    const result = extractMessagesFromDoc(doc);
    expect(result.inputMessages).toHaveLength(1);
    expect(result.inputMessages[0].content).toBe('from attr');
    expect(result.outputMessages).toHaveLength(1);
    expect(result.outputMessages[0].content).toBe('response');
  });

  it('returns empty arrays when no messages found', () => {
    const result = extractMessagesFromDoc({});
    expect(result.inputMessages).toEqual([]);
    expect(result.outputMessages).toEqual([]);
  });

  it('handles doc with no events array', () => {
    const doc = { attributes: {} };
    const result = extractMessagesFromDoc(doc);
    expect(result.inputMessages).toEqual([]);
    expect(result.outputMessages).toEqual([]);
  });
});

describe('mapSpanDoc', () => {
  it('maps a full span document', () => {
    const doc = {
      traceId: 'trace-1',
      spanId: 'span-1',
      parentSpanId: 'parent-1',
      name: 'chat gpt',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:01Z',
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.request.model': 'gpt-4',
        'gen_ai.tool.name': 'search',
        'gen_ai.tool.call.arguments': '{"q":"test"}',
        'gen_ai.tool.call.result': 'found it',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 50,
      },
    };

    const span = mapSpanDoc(doc);
    expect(span.traceId).toBe('trace-1');
    expect(span.spanId).toBe('span-1');
    expect(span.parentSpanId).toBe('parent-1');
    expect(span.name).toBe('chat gpt');
    expect(span.operationName).toBe('chat');
    expect(span.agentName).toBe('my-agent');
    expect(span.model).toBe('gpt-4');
    expect(span.toolName).toBe('search');
    expect(span.toolCallArguments).toBe('{"q":"test"}');
    expect(span.toolCallResult).toBe('found it');
    expect(span.inputTokens).toBe(100);
    expect(span.outputTokens).toBe(50);
    expect(span.raw).toBe(doc);
  });

  it('handles missing attributes gracefully', () => {
    const doc = {};
    const span = mapSpanDoc(doc);
    expect(span.traceId).toBe('');
    expect(span.spanId).toBe('');
    expect(span.parentSpanId).toBe('');
    expect(span.name).toBe('');
    expect(span.operationName).toBe('');
    expect(span.agentName).toBe('');
    expect(span.model).toBe('');
    expect(span.toolName).toBe('');
    expect(span.inputTokens).toBe(0);
    expect(span.outputTokens).toBe(0);
  });

  it('prefers response model over request model', () => {
    const doc = {
      attributes: {
        'gen_ai.request.model': 'gpt-4',
        'gen_ai.response.model': 'gpt-4-turbo',
      },
    };
    const span = mapSpanDoc(doc);
    expect(span.model).toBe('gpt-4-turbo');
  });

  it('supports snake_case field names', () => {
    const doc = {
      trace_id: 'trace-2',
      span_id: 'span-2',
      parent_span_id: 'parent-2',
      start_time: '2024-01-01T00:00:00Z',
      end_time: '2024-01-01T00:00:01Z',
    };
    const span = mapSpanDoc(doc);
    expect(span.traceId).toBe('trace-2');
    expect(span.spanId).toBe('span-2');
    expect(span.parentSpanId).toBe('parent-2');
  });

  it('includes raw document reference', () => {
    const doc = { traceId: 'test', custom: 'data' };
    const span = mapSpanDoc(doc);
    expect(span.raw).toBe(doc);
  });
});

describe('findEvaluatedTraceIds', () => {
  function withClient(search: (opts: Record<string, unknown>) => Promise<unknown>, evaluationIndex?: string) {
    const retriever = new OpenSearchTraceRetriever({ evaluationIndex });
    // Swap the real client (an optional dependency) for a stub.
    (retriever as unknown as { _clientPromise: Promise<unknown> })._clientPromise = Promise.resolve({ search });
    return retriever;
  }

  it('looks up gen_ai.evaluation.result events in the evaluation index', async () => {
    const calls: Record<string, unknown>[] = [];
    const retriever = withClient(async (opts) => {
      calls.push(opts);
      return { body: { aggregations: { by_trace: { buckets: [{ key: 't1' }, { key: 'other' }] } } } };
    });
    const found = await retriever.findEvaluatedTraceIds(['t1', 't2']);
    expect([...found]).toEqual(['t1']);
    expect(calls).toHaveLength(1);
    expect(calls[0].index).toBe('otel-v1-genai-evaluation*');
    expect(calls[0].ignore_unavailable).toBe(true);
    expect(calls[0].allow_no_indices).toBe(true);
    const filter = (calls[0].body as { query: { bool: { filter: unknown[] } } }).query.bool.filter;
    expect(filter).toContainEqual({ term: { eventName: 'gen_ai.evaluation.result' } });
    expect(filter).toContainEqual({ terms: { traceId: ['t1', 't2'] } });
  });

  it('uses a custom evaluation index', async () => {
    let index: unknown;
    const retriever = withClient(async (opts) => {
      index = opts.index;
      return { body: {} };
    }, 'my-evals-*');
    expect((await retriever.findEvaluatedTraceIds(['t1'])).size).toBe(0);
    expect(index).toBe('my-evals-*');
  });

  it('propagates search errors instead of reporting nothing evaluated', async () => {
    const retriever = withClient(async () => {
      throw new Error('security_exception: no permissions');
    });
    await expect(retriever.findEvaluatedTraceIds(['t1'])).rejects.toThrow(/security_exception/);
  });

  it('returns an empty set without querying for no trace ids', async () => {
    let called = false;
    const retriever = withClient(async () => {
      called = true;
      return {};
    });
    expect((await retriever.findEvaluatedTraceIds([])).size).toBe(0);
    expect(called).toBe(false);
  });
});

function spanDoc(o: {
  traceId?: string; spanId?: string; parentSpanId?: string; name?: string; op?: string;
  agent?: string; version?: string; marked?: boolean;
} = {}): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    'gen_ai.operation.name': o.op ?? 'invoke_agent',
    'gen_ai.agent.name': o.agent ?? 'TestAgent',
    'gen_ai.agent.version': o.version ?? 'v1',
    'gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }]),
  };
  if (o.marked) attributes['derived.gen_ai.is_root'] = true;
  return {
    traceId: o.traceId ?? 't1',
    spanId: o.spanId ?? 's1',
    parentSpanId: o.parentSpanId ?? '',
    name: o.name ?? 'invoke_agent TestAgent',
    startTime: '2026-01-01T00:00:00Z',
    attributes,
  };
}

const hits = (docs: Record<string, unknown>[]) => ({ body: { hits: { hits: docs.map((d) => ({ _source: d })) } } });
const traceBuckets = (ids: string[], other = 0) => ({
  body: { aggregations: { by_trace: { sum_other_doc_count: other, buckets: ids.map((key) => ({ key })) } } },
});

function stub(...responses: unknown[]) {
  const retriever = new OpenSearchTraceRetriever();
  const search = vi.fn();
  for (const r of responses) search.mockResolvedValueOnce(r);
  (retriever as unknown as { _clientPromise: Promise<unknown> })._clientPromise = Promise.resolve({ search });
  return { retriever, search };
}

describe('mapSpanDoc agent identity', () => {
  it('carries agent name and version', () => {
    const span = mapSpanDoc({ attributes: { 'gen_ai.agent.name': 'Weather', 'gen_ai.agent.version': 'v2' } });
    expect(span.agentName).toBe('Weather');
    expect(span.agentVersion).toBe('v2');
    expect(mapSpanDoc({ attributes: {} }).agentVersion).toBe('');
  });
});

describe('getTraces', () => {
  it('returns every span of the conversation\'s traces', async () => {
    const docs = [
      spanDoc({ traceId: 't1', spanId: 'root1' }),
      spanDoc({ traceId: 't1', spanId: 'chat1', parentSpanId: 'root1', op: 'chat' }),
      spanDoc({ traceId: 't1', spanId: 'tool1', parentSpanId: 'root1', op: 'execute_tool' }),
      spanDoc({ traceId: 't2', spanId: 'root2' }),
      spanDoc({ traceId: 't2', spanId: 'chat2', parentSpanId: 'root2', op: 'chat' }),
    ];
    const { retriever, search } = stub(traceBuckets(['t1', 't2']), hits(docs));
    const session = await retriever.getTraces('conv-1');
    expect(session.sessionId).toBe('conv-1');
    expect(session.traces.map((t) => t.traceId)).toEqual(['t1', 't2']);
    expect(session.traces.map((t) => t.spans.length)).toEqual([3, 2]);
    expect(session.traces[0].spans[0].agentVersion).toBe('v1');
    expect(session.truncated).toBe(false);

    const lookup = search.mock.calls[0][0].body;
    expect(lookup.size).toBe(0);
    expect(lookup.query.bool.should[0]).toEqual({ term: { 'attributes.gen_ai.conversation.id': 'conv-1' } });
    expect(lookup.query.bool.minimum_should_match).toBe(1);
    expect(lookup.aggs.by_trace.terms).toEqual({
      field: 'traceId', size: 1000, order: { first_start: 'asc' },
    });
    expect(lookup.aggs.by_trace.aggs.first_start).toEqual({ min: { field: 'startTime' } });
    const fetch = search.mock.calls[1][0].body;
    expect(fetch.query).toEqual({ terms: { traceId: ['t1', 't2'] } });
    expect(fetch.sort).toEqual([{ startTime: { order: 'asc' } }]);
  });

  it('bounds the conversation lookup and reports truncation', async () => {
    const { retriever, search } = stub(traceBuckets(['t1', 't2'], 5), hits([spanDoc(), spanDoc({ traceId: 't2' })]));
    const session = await retriever.getTraces('conv-1', undefined, { maxTraces: 2 });
    expect(search.mock.calls[0][0].body.aggs.by_trace.terms.size).toBe(2);
    expect(session.truncated).toBe(true);
  });

  it('is truncated when maxSpans is reached', async () => {
    const { retriever } = stub(traceBuckets(['t1']), hits([spanDoc(), spanDoc({ spanId: 's2' })]));
    expect((await retriever.getTraces('conv-1', 2)).truncated).toBe(true);
  });

  it('falls back to a trace id and gives the same TraceRecord', async () => {
    const docs = [spanDoc({ spanId: 'root' }), spanDoc({ spanId: 'chat', parentSpanId: 'root', op: 'chat' })];
    const { retriever, search } = stub(
      traceBuckets(['t1']), hits(docs),
      { body: { aggregations: { by_trace: { buckets: [] } } } }, hits(docs),
    );
    const byConversation = await retriever.getTraces('conv-1');
    const byTrace = await retriever.getTraces('t1');
    expect(search.mock.calls[3][0].body.query).toEqual({ term: { traceId: 't1' } });
    expect(byConversation.traces).toEqual(byTrace.traces);
  });

  it('returns no traces when nothing matches', async () => {
    const { retriever } = stub({ body: {} }, hits([]));
    const session = await retriever.getTraces('missing');
    expect(session.traces).toEqual([]);
    expect(session.truncated).toBe(false);
  });
});

describe('listRootSpans', () => {
  it('uses the Agent Traces AI-root rule and filters services on serviceName', async () => {
    const { retriever, search } = stub(hits([]));
    const since = new Date('2026-01-01T00:00:00Z');
    await retriever.listRootSpans({ services: ['observability-assistant'], since, maxResults: 5 });
    const body = search.mock.calls[0][0].body;
    expect(body.size).toBe(10);
    expect(body.query.bool.filter).toEqual([
      {
        bool: {
          should: [
            {
              bool: {
                filter: [
                  { term: { parentSpanId: '' } },
                  { exists: { field: 'attributes.gen_ai.operation.name' } },
                ],
              },
            },
            { term: { 'attributes.derived.gen_ai.is_root': true } },
          ],
          minimum_should_match: 1,
        },
      },
      { terms: { serviceName: ['observability-assistant'] } },
      { range: { startTime: { gte: since.toISOString() } } },
    ]);
    expect(body.query.bool.filter).not.toContainEqual({ term: { parentSpanId: '' } });
  });

  it('returns the marked agent span behind an HTTP root, with agent and messages', async () => {
    const agent = spanDoc({ spanId: 'agent', parentSpanId: 'http', name: 'invoke_agent travel_planner', agent: 'travel_planner', marked: true });
    const { retriever } = stub(hits([agent]));
    const [root] = await retriever.listRootSpans();
    expect(root.spanId).toBe('agent');
    expect(root.agentName).toBe('travel_planner');
    expect(root.agentVersion).toBe('v1');
    expect(root.inputMessages[0].content).toBe('hello');
  });

  it('drops a marked span shadowed by its trace\'s GenAI root', async () => {
    const docs = [
      spanDoc({ traceId: 't1', spanId: 'nested', parentSpanId: 'root', marked: true }),
      spanDoc({ traceId: 't1', spanId: 'root' }),
      spanDoc({ traceId: 't2', spanId: 'agent2', parentSpanId: 'http2', marked: true }),
    ];
    const { retriever } = stub(hits(docs));
    expect((await retriever.listRootSpans()).map((r) => r.spanId)).toEqual(['root', 'agent2']);
  });

  it('lists parallel marked agents of one trace each', async () => {
    const docs = [
      spanDoc({ spanId: 'a', parentSpanId: 'http', marked: true }),
      spanDoc({ spanId: 'b', parentSpanId: 'http', marked: true }),
    ];
    const { retriever } = stub(hits(docs));
    expect((await retriever.listRootSpans()).map((r) => r.spanId)).toEqual(['a', 'b']);
  });

  it('keeps maxResults after dropping shadowed spans', async () => {
    const docs = [
      spanDoc({ traceId: 't1', spanId: 'n1', parentSpanId: 'r1', marked: true }),
      spanDoc({ traceId: 't1', spanId: 'r1' }),
      spanDoc({ traceId: 't2', spanId: 'r2' }),
      spanDoc({ traceId: 't3', spanId: 'r3' }),
    ];
    const { retriever } = stub(hits(docs));
    expect((await retriever.listRootSpans({ maxResults: 2 })).map((r) => r.spanId)).toEqual(['r1', 'r2']);
  });
});

describe('dropShadowedAiRoots', () => {
  it('keeps parentless hits and marked spans of traces without one', () => {
    const docs = [
      { traceId: 't1', parentSpanId: 'p' },
      { traceId: 't1', parentSpanId: '' },
      { traceId: 't2', parentSpanId: 'p' },
    ];
    expect(dropShadowedAiRoots(docs)).toEqual([docs[1], docs[2]]);
  });
});

describe('findEvaluatedTraceIds filters', () => {
  const filterOf = (search: ReturnType<typeof vi.fn>) => search.mock.calls[0][0].body.query.bool.filter;

  it('counts any evaluator without a filter', async () => {
    const { retriever, search } = stub({ body: {} });
    await retriever.findEvaluatedTraceIds(['t1']);
    expect(filterOf(search)).toEqual([
      { term: { eventName: 'gen_ai.evaluation.result' } },
      { terms: { traceId: ['t1'] } },
    ]);
  });

  it('filters on the evaluator name', async () => {
    const { retriever, search } = stub({ body: { aggregations: { by_trace: { buckets: [{ key: 't1' }] } } } });
    const found = await retriever.findEvaluatedTraceIds(['t1', 't2'], { evaluator: 'answer_quality_judge' });
    expect([...found]).toEqual(['t1']);
    expect(filterOf(search)).toContainEqual({
      term: { 'attributes.opensearch.gen_ai.evaluation.evaluator.name': 'answer_quality_judge' },
    });
    expect(JSON.stringify(filterOf(search))).not.toContain('attributes.gen_ai.evaluation.name');
  });

  it('filters on the evaluation name, or both', async () => {
    const { retriever, search } = stub({ body: {} }, { body: {} });
    await retriever.findEvaluatedTraceIds(['t1'], { evaluationName: 'answer_quality' });
    expect(filterOf(search)).toContainEqual({ term: { 'attributes.gen_ai.evaluation.name': 'answer_quality' } });
    expect(JSON.stringify(filterOf(search))).not.toContain('evaluator.name');
    await retriever.findEvaluatedTraceIds(['t1'], { evaluator: 'j', evaluationName: 'q' });
    const both = search.mock.calls[1][0].body.query.bool.filter;
    expect(both).toContainEqual({ term: { 'attributes.opensearch.gen_ai.evaluation.evaluator.name': 'j' } });
    expect(both).toContainEqual({ term: { 'attributes.gen_ai.evaluation.name': 'q' } });
  });
});
