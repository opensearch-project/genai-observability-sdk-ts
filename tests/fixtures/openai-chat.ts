// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

const CHAT_COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'test-model',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hi' } }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

/**
 * One Chat Completions call against a fake fetch. `require` is the test file's CommonJS
 * require: the instrumentations patch through require-in-the-middle, which hooks require().
 */
export async function chatWithOpenAI(require: NodeRequire): Promise<void> {
  const { OpenAI } = require('openai') as typeof import('openai');
  const client = new OpenAI({
    apiKey: 'test',
    baseURL: 'http://127.0.0.1:9/v1',
    fetch: async () =>
      new Response(JSON.stringify(CHAT_COMPLETION), { headers: { 'content-type': 'application/json' } }),
  });
  await client.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'Hello' }] });
}
