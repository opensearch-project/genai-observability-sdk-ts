// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { score } from '../src/score.js';
import { getFinishedSpans, clearSpans } from './setup.js';

beforeEach(() => clearSpans());
afterEach(() => clearSpans());

describe('score', () => {
  it('creates a span with evaluation attributes', () => {
    score({ name: 'accuracy', value: 0.95 });

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.name).toBe('evaluation accuracy');
    expect(span.attributes['gen_ai.operation.name']).toBe('evaluation');
    expect(span.attributes['gen_ai.evaluation.name']).toBe('accuracy');
    expect(span.attributes['gen_ai.evaluation.score.value']).toBe(0.95);
  });

  it('creates an evaluation result event', () => {
    score({ name: 'relevance', value: 0.8 });

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);

    const events = spans[0].events;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const evalEvent = events.find(e => e.name === 'gen_ai.evaluation.result');
    expect(evalEvent).toBeDefined();
    expect(evalEvent!.attributes!['gen_ai.evaluation.name']).toBe('relevance');
    expect(evalEvent!.attributes!['gen_ai.evaluation.score.value']).toBe(0.8);
  });

  it('sets label attribute', () => {
    score({ name: 'quality', value: 1.0, label: 'good' });

    const spans = getFinishedSpans();
    expect(spans[0].attributes['gen_ai.evaluation.score.label']).toBe('good');

    const evalEvent = spans[0].events.find(e => e.name === 'gen_ai.evaluation.result');
    expect(evalEvent!.attributes!['gen_ai.evaluation.score.label']).toBe('good');
  });

  it('sets explanation attribute (truncated to 500)', () => {
    const longExplanation = 'x'.repeat(600);
    score({ name: 'test', value: 0.5, explanation: longExplanation });

    const spans = getFinishedSpans();
    const explanation = spans[0].attributes['gen_ai.evaluation.explanation'] as string;
    expect(explanation.length).toBe(500);
  });

  it('sets explanation attribute when short', () => {
    score({ name: 'test', value: 0.5, explanation: 'Good answer' });

    const spans = getFinishedSpans();
    expect(spans[0].attributes['gen_ai.evaluation.explanation']).toBe('Good answer');
  });

  it('sets response id', () => {
    score({ name: 'test', value: 0.5, responseId: 'resp-xyz' });

    const spans = getFinishedSpans();
    expect(spans[0].attributes['gen_ai.response.id']).toBe('resp-xyz');
  });

  it('sets custom attributes', () => {
    score({
      name: 'test',
      value: 0.5,
      attributes: { 'custom.key': 'value', 'custom.num': 42 },
    });

    const spans = getFinishedSpans();
    expect(spans[0].attributes['custom.key']).toBe('value');
    expect(spans[0].attributes['custom.num']).toBe(42);
  });

  it('links to parent trace when traceId and spanId provided', () => {
    const traceId = 'abcdef1234567890abcdef1234567890';
    const spanId = 'abcdef1234567890';
    score({ name: 'test', value: 1.0, traceId, spanId });

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    // The span should be a child of the provided parent context
    expect(spans[0].spanContext().traceId).toBe(traceId);
  });

  it('handles trace-level scoring (traceId only, no spanId)', () => {
    const traceId = 'abcdef1234567890abcdef1234567890';
    score({ name: 'test', value: 0.9, traceId });

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].spanContext().traceId).toBe(traceId);
  });

  it('works standalone (no traceId)', () => {
    score({ name: 'standalone', value: 0.7 });

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('evaluation standalone');
  });

  it('multiple scores create multiple spans', () => {
    score({ name: 'accuracy', value: 0.95 });
    score({ name: 'relevance', value: 0.8 });
    score({ name: 'fluency', value: 0.9 });

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(3);
    expect(spans.map(s => s.name)).toEqual([
      'evaluation accuracy',
      'evaluation relevance',
      'evaluation fluency',
    ]);
  });

  it('handles score without value', () => {
    score({ name: 'binary', label: 'pass' });

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes['gen_ai.evaluation.score.value']).toBeUndefined();
    expect(spans[0].attributes['gen_ai.evaluation.score.label']).toBe('pass');
  });

  it('handles hex traceId with 0x prefix', () => {
    const traceId = '0xabcdef1234567890abcdef1234567890';
    const spanId = '0xabcdef1234567890';
    score({ name: 'test', value: 1.0, traceId, spanId });

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].spanContext().traceId).toBe('abcdef1234567890abcdef1234567890');
  });
});
