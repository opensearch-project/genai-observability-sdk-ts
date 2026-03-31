// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Example 01: Tracing Basics
 *
 * Demonstrates using observe() and withObserve() to trace function calls
 * and create spans with the OpenSearch GenAI Observability SDK.
 */

import { observe, withObserve, Op, enrich, register } from '../src/index.js';

// Register the SDK (uses default endpoint)
await register({
  serviceName: 'tracing-basics-example',
  batch: false,
  autoInstrument: false,
});

// 1. Simple function wrapping with observe()
const greet = observe(function greet(name: string) {
  return `Hello, ${name}!`;
});

console.log(greet('World'));

// 2. Wrapping with options (operation type, custom name)
const chat = observe({ name: 'my-chatbot', op: Op.CHAT }, function (prompt: string) {
  // Inside an observed function, you can enrich the span with metadata
  enrich({
    model: 'gpt-4',
    provider: 'openai',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  });
  return `Response to: ${prompt}`;
});

console.log(chat('What is the capital of France?'));

// 3. Using observe as a decorator factory
const withTracing = observe({ op: Op.INVOKE_AGENT });

const agent = withTracing(function myAgent(query: string) {
  return `Agent processed: ${query}`;
});

console.log(agent('Find me the weather'));

// 4. Using withObserve for block-level tracing
const result = withObserve('data-processing', (span) => {
  span.setAttribute('custom.step', 'transform');
  const data = [1, 2, 3].map(x => x * 2);
  return data;
});

console.log('Processed data:', result);

// 5. Tool execution tracing
const searchTool = observe(
  { name: 'web-search', op: Op.EXECUTE_TOOL },
  function (query: string) {
    return { results: [`Result for: ${query}`], count: 1 };
  },
);

console.log(searchTool('TypeScript observability'));

console.log('Done! Traces have been created.');
