// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

// No tests/setup.ts. Own file: instrumentations are process-wide.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemorySpanExporter, type BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import {
  register,
  instrumentationsFor,
  OPENAI_INSTRUMENTATION,
  AWS_SDK_INSTRUMENTATION,
  type RegisterOptions,
} from '../src/register.js';

let provider: BasicTracerProvider | undefined;

afterEach(async () => {
  await provider?.shutdown();
  provider = undefined;
});

describe('register({ autoInstrument }) values from JS callers', () => {
  it('undefined is the default (OpenAI on), true too', () => {
    expect(instrumentationsFor(undefined)).toEqual([OPENAI_INSTRUMENTATION]);
    expect(instrumentationsFor(true)).toEqual([OPENAI_INSTRUMENTATION]);
  });

  it('any other falsy value turns all off, as on main', () => {
    for (const off of [false, null, 0, '', Number.NaN]) {
      expect(instrumentationsFor(off as RegisterOptions['autoInstrument'])).toEqual([]);
    }
  });

  it('an object is the option object', () => {
    expect(instrumentationsFor({})).toEqual([OPENAI_INSTRUMENTATION]);
    expect(instrumentationsFor({ openai: false, awsSdk: true })).toEqual([AWS_SDK_INSTRUMENTATION]);
  });

  it('any other truthy value is the default and never crashes', () => {
    for (const on of [1, 'yes']) {
      expect(instrumentationsFor(on as RegisterOptions['autoInstrument'])).toEqual([OPENAI_INSTRUMENTATION]);
    }
  });

  it('register({ autoInstrument: null }) (a JSON config) resolves', async () => {
    provider = await register({
      exporter: new InMemorySpanExporter(),
      logs: false,
      setGlobal: false,
      autoInstrument: null as never,
    });
    expect(provider).toBeDefined();
  });
});
