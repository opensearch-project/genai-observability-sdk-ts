// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

// No tests/setup.ts. Own file: instrumentations are process-wide, and openai must be loaded
// only after both instrumentations are registered.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { OpenAIInstrumentation } from '@opentelemetry/instrumentation-openai';
import { register } from '../src/register.js';
import { chatWithOpenAI } from './fixtures/openai-chat.js';

const require = createRequire(import.meta.url);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('register() and an OpenAIInstrumentation the app registers itself', () => {
  it('registered before register(): register() keeps the app\'s patch, with one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const appExporter = new InMemorySpanExporter();
    const appProvider = new BasicTracerProvider();
    appProvider.addSpanProcessor(new SimpleSpanProcessor(appExporter));
    registerInstrumentations({ instrumentations: [new OpenAIInstrumentation()], tracerProvider: appProvider });

    const ours = new InMemorySpanExporter();
    const provider = await register({ exporter: ours, batch: false, logs: false, setGlobal: false });
    await chatWithOpenAI(require);

    const chats = [...ours.getFinishedSpans(), ...appExporter.getFinishedSpans()].filter(
      (s) => s.attributes['gen_ai.operation.name'] === 'chat',
    );
    // The app's instrumentation (its provider, its config) keeps the patch.
    expect(chats).toHaveLength(1);
    expect(appExporter.getFinishedSpans()).toHaveLength(1);
    const warnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('already instrumented'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('openai: false');
    await provider.shutdown();
  });
});
