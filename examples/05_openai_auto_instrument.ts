// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Example 05: OpenAI Auto-Instrumentation
 *
 * register() turns on @opentelemetry/instrumentation-openai when it is
 * installed, so every `chat.completions.create()` call becomes a
 * `chat <model>` span (model, token usage, finish reason) under your own
 * spans.
 *
 * The instrumentation patches `openai` when it is loaded, so the order matters:
 *
 * 1. ES modules only: register the `@opentelemetry/instrumentation/hook.mjs`
 *    loader hook, so `import` statements can be patched.
 * 2. `await register()`.
 * 3. Load `openai`. Here with a dynamic `import()`; a static `import OpenAI
 *    from 'openai'` at the top of this file would run before register(). In a
 *    larger app, put steps 1 and 2 in their own file and start the app with
 *    `node --import ./otel.js app.js` (see the README, "Auto-instrumentation").
 *
 * Prerequisites:
 * - npm install openai @opentelemetry/instrumentation-openai@~0.21.0 @opentelemetry/instrumentation@~0.223.0
 *   (instrumentation-openai 0.22+ needs @opentelemetry/api 1.10; this SDK is on 1.9)
 * - OPENAI_API_KEY for a real call. Without it the example answers from a stub,
 *   and the chat span is still recorded.
 *
 * Run: npx tsx examples/05_openai_auto_instrument.ts
 */

import { register as registerHooks } from 'node:module';
import { register, observe, Op, enrich } from '../src/index.js';

// 1. ESM: let the instrumentation patch `import` statements.
registerHooks('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

// 2. Turns on the installed instrumentations (autoInstrument defaults to true).
const provider = await register({ serviceName: 'openai-app' });

// 3. Load openai only now, so it is patched.
const { default: OpenAI } = await import('openai');

const stubFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4.1-mini',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OpenSearch is a search and analytics suite.' } }],
      usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

const client = process.env.OPENAI_API_KEY
  ? new OpenAI()
  : new OpenAI({ apiKey: 'stub', baseURL: 'http://127.0.0.1:9/v1', fetch: stubFetch });

// Your own agent span; the instrumented chat call nests under it.
const assistant = observe({ name: 'assistant', op: Op.INVOKE_AGENT }, async (question: string) => {
  const response = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'user', content: question }],
  });
  enrich({ sessionId: 'session-123' });
  return response.choices[0].message.content ?? '';
});

console.log('Response:', await assistant('What is OpenSearch?'));
console.log('Spans: invoke_agent assistant > chat gpt-4.1-mini');

await provider.shutdown();
