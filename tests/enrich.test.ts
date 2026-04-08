// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { observe } from '../src/observe.js';
import { enrich } from '../src/enrich.js';
import { getFinishedSpans, clearSpans } from './setup.js';

beforeEach(() => clearSpans());
afterEach(() => clearSpans());

function callWithinSpan(fn: () => void): void {
  const wrapped = observe({ name: 'test-span' }, fn);
  wrapped();
}

describe('enrich', () => {
  it('sets model attribute', () => {
    callWithinSpan(() => enrich({ model: 'gpt-4' }));

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    expect(span.attributes['gen_ai.request.model']).toBe('gpt-4');
  });

  it('sets provider attribute', () => {
    callWithinSpan(() => enrich({ provider: 'openai' }));

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    expect(span.attributes['gen_ai.provider.name']).toBe('openai');
  });

  it('sets token usage attributes', () => {
    callWithinSpan(() =>
      enrich({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
    );

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(100);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(50);
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(150);
  });

  it('sets response id', () => {
    callWithinSpan(() => enrich({ responseId: 'resp-123' }));

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    expect(span.attributes['gen_ai.response.id']).toBe('resp-123');
  });

  it('sets finish reason as array', () => {
    callWithinSpan(() => enrich({ finishReason: 'stop' }));

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    const reasons = span.attributes['gen_ai.response.finish_reasons'];
    expect(reasons).toEqual(['stop']);
  });

  it('sets temperature and maxTokens', () => {
    callWithinSpan(() => enrich({ temperature: 0.7, maxTokens: 1024 }));

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    expect(span.attributes['gen_ai.request.temperature']).toBe(0.7);
    expect(span.attributes['gen_ai.request.max_tokens']).toBe(1024);
  });

  it('sets session and agent attributes', () => {
    callWithinSpan(() =>
      enrich({
        sessionId: 'sess-1',
        agentId: 'agent-1',
        agentDescription: 'A helpful agent',
      }),
    );

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    expect(span.attributes['gen_ai.conversation.id']).toBe('sess-1');
    expect(span.attributes['gen_ai.agent.id']).toBe('agent-1');
    expect(span.attributes['gen_ai.agent.description']).toBe('A helpful agent');
  });

  it('sets tool definitions as JSON', () => {
    const tools = [{ name: 'search', description: 'Search the web' }];
    callWithinSpan(() => enrich({ toolDefinitions: tools }));

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    const defs = span.attributes['gen_ai.tool.definitions'];
    expect(typeof defs).toBe('string');
    expect(JSON.parse(defs as string)).toEqual(tools);
  });

  it('sets system instructions', () => {
    callWithinSpan(() =>
      enrich({ systemInstructions: 'You are a helpful assistant.' }),
    );

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    expect(span.attributes['gen_ai.system_instructions']).toBe(
      'You are a helpful assistant.',
    );
  });

  it('sets input and output messages as JSON', () => {
    const inputMsgs = [{ role: 'user', content: 'Hello' }];
    const outputMsgs = [{ role: 'assistant', content: 'Hi there!' }];
    callWithinSpan(() =>
      enrich({ inputMessages: inputMsgs, outputMessages: outputMsgs }),
    );

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    expect(JSON.parse(span.attributes['gen_ai.input.messages'] as string)).toEqual(inputMsgs);
    expect(JSON.parse(span.attributes['gen_ai.output.messages'] as string)).toEqual(outputMsgs);
  });

  it('passes extra kwargs as attributes', () => {
    callWithinSpan(() =>
      enrich({ model: 'gpt-4', 'custom.metric': 0.95 }),
    );

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    expect(span.attributes['gen_ai.request.model']).toBe('gpt-4');
    expect(span.attributes['custom.metric']).toBe(0.95);
  });

  it('skips undefined and null values', () => {
    callWithinSpan(() =>
      // Pass null via index signature to test runtime null handling
      enrich({ model: undefined, provider: null as unknown as string }),
    );

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    expect(span.attributes['gen_ai.request.model']).toBeUndefined();
    expect(span.attributes['gen_ai.provider.name']).toBeUndefined();
  });

  it('no-ops when there is no active span', () => {
    // Should not throw
    enrich({ model: 'gpt-4' });
    // No spans should be created by enrich itself
    const spans = getFinishedSpans();
    expect(spans).toHaveLength(0);
  });

  it('sets all attributes in a single call', () => {
    callWithinSpan(() =>
      enrich({
        model: 'claude-3',
        provider: 'anthropic',
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        responseId: 'resp-456',
        finishReason: 'end_turn',
        temperature: 0.5,
        maxTokens: 2048,
        sessionId: 'sess-2',
        agentId: 'agent-2',
        agentDescription: 'Smart agent',
        systemInstructions: 'Be concise',
      }),
    );

    const spans = getFinishedSpans();
    const span = spans.find(s => s.name === 'test-span')!;
    expect(span.attributes['gen_ai.request.model']).toBe('claude-3');
    expect(span.attributes['gen_ai.provider.name']).toBe('anthropic');
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(200);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(100);
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(300);
    expect(span.attributes['gen_ai.response.id']).toBe('resp-456');
    expect(span.attributes['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
    expect(span.attributes['gen_ai.request.temperature']).toBe(0.5);
    expect(span.attributes['gen_ai.request.max_tokens']).toBe(2048);
    expect(span.attributes['gen_ai.conversation.id']).toBe('sess-2');
    expect(span.attributes['gen_ai.agent.id']).toBe('agent-2');
    expect(span.attributes['gen_ai.agent.description']).toBe('Smart agent');
    expect(span.attributes['gen_ai.system_instructions']).toBe('Be concise');
  });
});
