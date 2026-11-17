// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

// No tests/setup.ts: register() itself must wire the instrumentations to its provider.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { InMemorySpanExporter, type BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { register, autoInstrument } from '../src/register.js';

// CommonJS require: the instrumentations patch through require-in-the-middle, which
// hooks require(). (ESM apps need the loader hook; see README "Auto-instrumentation".)
const require = createRequire(import.meta.url);

const CHAT_COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'test-model',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hi' } }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

const CONVERSE = {
  output: { message: { role: 'assistant', content: [{ text: 'Hi' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
  metrics: { latencyMs: 1 },
};

let provider: BasicTracerProvider | undefined;

afterEach(async () => {
  await provider?.shutdown();
  provider = undefined;
  vi.restoreAllMocks();
});

async function chatWithOpenAI(): Promise<void> {
  const { OpenAI } = require('openai') as typeof import('openai');
  const client = new OpenAI({
    apiKey: 'test',
    baseURL: 'http://127.0.0.1:9/v1',
    fetch: async () =>
      new Response(JSON.stringify(CHAT_COMPLETION), { headers: { 'content-type': 'application/json' } }),
  });
  await client.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'Hello' }] });
}

describe('register() auto-instrumentation', () => {
  it('patches the OpenAI client: a chat call becomes a chat span on its provider', async () => {
    const exporter = new InMemorySpanExporter();
    // setGlobal: false proves the instrumentation uses register()'s provider, not the global one.
    provider = await register({ exporter, batch: false, logs: false, setGlobal: false });
    await chatWithOpenAI();

    const chat = exporter.getFinishedSpans().filter((s) => s.attributes['gen_ai.operation.name'] === 'chat');
    expect(chat).toHaveLength(1);
    expect(chat[0].name).toBe('chat test-model');
    expect(chat[0].attributes['gen_ai.request.model']).toBe('test-model');
    expect(chat[0].attributes['gen_ai.usage.input_tokens']).toBe(3);
  });

  it('does not patch twice when register() runs again, and follows the newest global provider', async () => {
    const first = new InMemorySpanExporter();
    const second = new InMemorySpanExporter();
    const p1 = await register({ exporter: first, batch: false, logs: false, setGlobal: false });
    provider = await register({ exporter: second, batch: false, logs: false });
    await chatWithOpenAI();
    await p1.shutdown();

    expect(first.getFinishedSpans()).toHaveLength(0);
    expect(second.getFinishedSpans().filter((s) => s.attributes['gen_ai.operation.name'] === 'chat')).toHaveLength(1);
  });

  it('a side pipeline (setGlobal: false) does not take the instrumentation from the primary one', async () => {
    const primary = new InMemorySpanExporter();
    const debug = new InMemorySpanExporter();
    provider = await register({ exporter: primary, batch: false, logs: false });
    const side = await register({ exporter: debug, batch: false, logs: false, setGlobal: false });
    try {
      await chatWithOpenAI();
    } finally {
      await side.shutdown();
    }
    expect(debug.getFinishedSpans()).toHaveLength(0);
    expect(primary.getFinishedSpans().filter((s) => s.attributes['gen_ai.operation.name'] === 'chat')).toHaveLength(1);
  });

  it('patches the AWS SDK with autoInstrument: { awsSdk: true }: a Bedrock Converse call becomes a span', async () => {
    const exporter = new InMemorySpanExporter();
    provider = await register({ exporter, batch: false, logs: false, setGlobal: false, autoInstrument: { awsSdk: true } });
    const { BedrockRuntimeClient, ConverseCommand } = require(
      '@aws-sdk/client-bedrock-runtime',
    ) as typeof import('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({
      region: 'us-west-2',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: {
        handle: async () => ({
          response: {
            statusCode: 200,
            reason: 'OK',
            headers: { 'content-type': 'application/json' },
            body: Readable.from([Buffer.from(JSON.stringify(CONVERSE))]),
          },
        }),
      },
    });
    await client.send(
      new ConverseCommand({ modelId: 'test-model', messages: [{ role: 'user', content: [{ text: 'Hello' }] }] }),
    );

    const spans = exporter.getFinishedSpans();
    const converse = spans.find((s) => s.attributes['gen_ai.request.model'] === 'test-model');
    expect(converse, spans.map((s) => s.name).join(', ')).toBeDefined();
    expect(converse!.attributes['gen_ai.operation.name']).toBe('chat');
    expect(converse!.attributes['gen_ai.usage.input_tokens']).toBe(3);
  });
});

describe('autoInstrument()', () => {
  it('skips an instrumentation package that is not installed, silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exporter = new InMemorySpanExporter();
    provider = await register({ exporter, batch: false, logs: false, setGlobal: false, autoInstrument: false });
    const enabled = await autoInstrument(provider, [
      { packageName: '@opentelemetry/instrumentation-does-not-exist', exportName: 'X', supported: '<1' },
    ]);
    expect(enabled).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns, naming the package and the supported versions, when one fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exporter = new InMemorySpanExporter();
    provider = await register({ exporter, batch: false, logs: false, setGlobal: false, autoInstrument: false });
    const enabled = await autoInstrument(provider, [
      { packageName: new URL('./fixtures/broken-instrumentation.mjs', import.meta.url).href, exportName: 'X', supported: '~0.1.0' },
      { packageName: '@opentelemetry/instrumentation-openai', exportName: 'NoSuchExport', supported: '~0.21.0' },
    ]);
    expect(enabled).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('broken-instrumentation.mjs');
    expect(warn.mock.calls[0][0]).toContain('~0.1.0');
    expect(warn.mock.calls[0][0]).toContain('does not provide an export');
    expect(warn.mock.calls[1][0]).toContain('NoSuchExport');
  });
});
