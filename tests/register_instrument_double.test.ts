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
  it('registered after register(): OpenAI is instrumented once (the app\'s replaces ours)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ours = new InMemorySpanExporter();
    const provider = await register({ exporter: ours, batch: false, logs: false, setGlobal: false });

    // The 0.1.x workaround for the old no-op autoInstrument.
    const appExporter = new InMemorySpanExporter();
    const appProvider = new BasicTracerProvider();
    appProvider.addSpanProcessor(new SimpleSpanProcessor(appExporter));
    registerInstrumentations({ instrumentations: [new OpenAIInstrumentation()], tracerProvider: appProvider });

    await chatWithOpenAI(require);
    await chatWithOpenAI(require);
    const chats = [...ours.getFinishedSpans(), ...appExporter.getFinishedSpans()].filter(
      (s) => s.attributes['gen_ai.operation.name'] === 'chat',
    );
    // One chat span per call, not two nested ones: InstrumentationBase unwraps a wrapped
    // function before it wraps it, so the instrumentation enabled last owns the patch.
    expect(chats).toHaveLength(2);
    expect(chats.every((s) => s.parentSpanId === undefined)).toBe(true);
    expect(appExporter.getFinishedSpans()).toHaveLength(2);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('already instrumented'))).toEqual([]);
    await provider.shutdown();
  });
});
