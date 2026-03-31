// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Example 04: Async Tracing
 *
 * Demonstrates tracing async functions, generators, and nested
 * async operations with the OpenSearch GenAI Observability SDK.
 */

import { observe, withObserve, Op, enrich, register } from '../src/index.js';

await register({
  serviceName: 'async-tracing-example',
  batch: false,
  autoInstrument: false,
});

// 1. Async function tracing
const fetchData = observe(async function fetchData(url: string) {
  // Simulate async work
  await new Promise(resolve => setTimeout(resolve, 10));
  return { data: `Response from ${url}`, status: 200 };
});

const data = await fetchData('https://api.example.com/data');
console.log('Fetched:', data);

// 2. Async generator tracing (streaming)
const streamTokens = observe(
  { name: 'token-stream', op: Op.CHAT },
  async function* streamTokens(prompt: string) {
    const tokens = prompt.split(' ');
    for (const token of tokens) {
      await new Promise(resolve => setTimeout(resolve, 5));
      yield token;
    }
  },
);

process.stdout.write('Streaming: ');
for await (const token of streamTokens('Hello world from streaming')) {
  process.stdout.write(token + ' ');
}
console.log();

// 3. Nested async operations
const processQuery = observe(
  { name: 'query-processor', op: Op.INVOKE_AGENT },
  async function processQuery(query: string) {
    // The retrieve step is a child span
    const retrieveDoc = observe(
      { name: 'retriever', op: Op.RETRIEVAL },
      async function (q: string) {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { doc: `Document about ${q}` };
      },
    );

    const generateAnswer = observe(
      { name: 'generator', op: Op.GENERATE_CONTENT },
      async function (context: string) {
        enrich({ model: 'gpt-4', inputTokens: 50, outputTokens: 100 });
        await new Promise(resolve => setTimeout(resolve, 10));
        return `Answer based on: ${context}`;
      },
    );

    const doc = await retrieveDoc(query);
    const answer = await generateAnswer(doc.doc);
    return answer;
  },
);

const answer = await processQuery('What is OpenTelemetry?');
console.log('Answer:', answer);

// 4. Async withObserve
const asyncResult = await withObserve('async-pipeline', async (span) => {
  span.setAttribute('pipeline.stage', 'processing');
  await new Promise(resolve => setTimeout(resolve, 10));
  return 42;
});

console.log('Async pipeline result:', asyncResult);

console.log('Done! All async traces have been created.');
