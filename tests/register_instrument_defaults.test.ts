// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

// No tests/setup.ts. Own file: instrumentations are process-wide, and this one
// must load the AWS SDK before any test turns its instrumentation on.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { InMemorySpanExporter, type BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { register } from '../src/register.js';

const require = createRequire(import.meta.url);

let provider: BasicTracerProvider | undefined;

afterEach(async () => {
  await provider?.shutdown();
  provider = undefined;
});

async function converse(): Promise<void> {
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
          body: Readable.from([
            Buffer.from(JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: 'Hi' }] } }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 } })),
          ]),
        },
      }),
    },
  });
  await client.send(new ConverseCommand({ modelId: 'test-model', messages: [{ role: 'user', content: [{ text: 'Hello' }] }] }));
}

describe('register() AWS SDK instrumentation', () => {
  it('is off by default: an AWS SDK call makes no span', async () => {
    const exporter = new InMemorySpanExporter();
    provider = await register({ exporter, batch: false, logs: false, setGlobal: false });
    await converse();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
