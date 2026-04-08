// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Example 05: OpenAI Auto-Instrumentation
 *
 * Demonstrates how to use the SDK with auto-instrumentation for OpenAI.
 * When @opentelemetry/instrumentation-openai is installed, the SDK will
 * automatically trace OpenAI API calls.
 *
 * Prerequisites:
 * - npm install openai
 * - npm install @opentelemetry/instrumentation-openai
 * - Set OPENAI_API_KEY environment variable
 */

import { register, observe, Op, enrich } from '../src/index.js';

// Register with auto-instrumentation enabled (default)
// This will automatically detect and enable any installed instrumentors
await register({
  serviceName: 'openai-app',
  // autoInstrument: true (default) — will look for
  // @opentelemetry/instrumentation-openai and enable it
});

// With auto-instrumentation, OpenAI calls are automatically traced.
// You can still add your own wrapping for custom logic:
const chatWithOpenAI = observe(
  { name: 'openai-chat', op: Op.CHAT },
  async function (userMessage: string) {
    // The OpenAI client call would be auto-instrumented here
    // import OpenAI from 'openai';
    // const openai = new OpenAI();
    // const response = await openai.chat.completions.create({
    //   model: 'gpt-4',
    //   messages: [{ role: 'user', content: userMessage }],
    // });

    // Enrich with additional metadata
    enrich({
      model: 'gpt-4',
      provider: 'openai',
      sessionId: 'session-123',
    });

    // Simulated response for this example
    return `Simulated response to: ${userMessage}`;
  },
);

const response = await chatWithOpenAI('What is OpenSearch?');
console.log('Response:', response);
console.log('Trace includes both SDK spans and auto-instrumented OpenAI spans!');
