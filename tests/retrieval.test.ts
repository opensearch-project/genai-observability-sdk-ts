// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect } from 'vitest';
import { parseMessages, extractMessagesFromDoc, mapSpanDoc } from '../src/retrieval.js';

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
    // Should return the raw string as a message with role 'unknown'
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('unknown');
    expect(result[0].content).toBe('not valid json');
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

  it('defaults content to empty string when missing', () => {
    const raw = [{ role: 'user' }];
    const messages = parseMessages(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('');
  });
});

describe('extractMessagesFromDoc', () => {
  it('extracts messages from events', () => {
    const doc = {
      attributes: {},
      events: [
        {
          name: 'gen_ai.content.prompt',
          attributes: {
            'gen_ai.prompt': JSON.stringify([{ role: 'user', content: 'hi' }]),
          },
        },
        {
          name: 'gen_ai.content.completion',
          attributes: {
            'gen_ai.completion': JSON.stringify([{ role: 'assistant', content: 'hello' }]),
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
        'gen_ai.prompt': JSON.stringify([{ role: 'user', content: 'from attr' }]),
        'gen_ai.completion': JSON.stringify([{ role: 'assistant', content: 'response' }]),
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
