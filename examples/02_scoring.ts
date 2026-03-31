// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Example 02: Scoring
 *
 * Demonstrates using score() to evaluate LLM outputs and attach
 * evaluation metadata to traces.
 */

import { score, observe, Op, register } from '../src/index.js';

await register({
  serviceName: 'scoring-example',
  batch: false,
  autoInstrument: false,
});

// 1. Simple standalone score
score({ name: 'accuracy', value: 0.95 });

// 2. Score with label and explanation
score({
  name: 'quality',
  value: 1.0,
  label: 'excellent',
  explanation: 'The response was accurate, complete, and well-formatted.',
});

// 3. Score linked to a specific trace
// In a real app, you'd get the traceId from an observed function
const traceId = 'abcdef1234567890abcdef1234567890';
const spanId = 'abcdef1234567890';

score({
  name: 'relevance',
  value: 0.85,
  traceId,
  spanId,
  responseId: 'resp-123',
});

// 4. Trace-level scoring (no spanId, just traceId)
score({
  name: 'overall-satisfaction',
  value: 0.9,
  traceId,
});

// 5. Score with custom attributes
score({
  name: 'latency-score',
  value: 0.7,
  attributes: {
    'eval.method': 'automated',
    'eval.version': '2.0',
  },
});

// 6. Multiple scores for the same trace
const scores = [
  { name: 'accuracy', value: 0.95 },
  { name: 'fluency', value: 0.88 },
  { name: 'relevance', value: 0.92 },
];

for (const s of scores) {
  score({ ...s, traceId });
}

console.log('Scores have been recorded as spans!');
