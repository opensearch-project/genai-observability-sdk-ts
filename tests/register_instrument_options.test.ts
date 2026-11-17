// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

// No tests/setup.ts. Own file: instrumentations are process-wide.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemorySpanExporter, type BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import {
  register,
  instrumentationsFor,
  isNotInstalled,
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

describe('isNotInstalled()', () => {
  const PKG = '@opentelemetry/instrumentation-openai';
  const err = (code: string, message: string) => Object.assign(new Error(message), { code });

  it('reads Node CJS and ESM resolver errors', () => {
    expect(isNotInstalled(err('MODULE_NOT_FOUND', `Cannot find module '${PKG}'\nRequire stack:\n- /app/x.js`), PKG)).toBe(true);
    expect(isNotInstalled(err('ERR_MODULE_NOT_FOUND', `Cannot find package '${PKG}' imported from /app/x.mjs`), PKG)).toBe(true);
  });

  it('reads a Yarn PnP error, which does not quote the package name', () => {
    const pnp =
      `@opensearch-project/genai-observability-sdk-ts tried to access ${PKG} (a peer dependency) but it ` +
      `isn't provided by your application; this makes the require call ambiguous and unsound.`;
    expect(isNotInstalled(err('MODULE_NOT_FOUND', pnp), PKG)).toBe(true);
  });

  it('a missing dependency of the installed package is not "not installed"', () => {
    const nested = `Cannot find module '@opentelemetry/semantic-conventions' imported from /app/node_modules/${PKG}/build/src/index.js`;
    expect(isNotInstalled(err('ERR_MODULE_NOT_FOUND', nested), PKG)).toBe(false);
  });

  it('another error code is not "not installed"', () => {
    expect(isNotInstalled(err('ERR_REQUIRE_ESM', `require() of ES Module ${PKG} not supported`), PKG)).toBe(false);
    expect(isNotInstalled(new Error(`Cannot find module '${PKG}'`), PKG)).toBe(false);
  });
});
