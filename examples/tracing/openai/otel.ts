// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Loaded with `--import` before agent.ts. register() turns on
 * @opentelemetry/instrumentation-openai (autoInstrument, the default), which
 * patches the OpenAI SDK when it is loaded. So this file runs first: then each
 * chat.completions.create call in agent.ts becomes a `chat <model>` span
 * (model, token usage, finish reason).
 */

import { register as registerHooks } from 'node:module';
import { register } from '@opensearch-project/genai-observability-sdk-ts';

// ESM: let the instrumentation patch `import` statements.
registerHooks('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

export const provider = await register({ serviceName: 'travel-assistant-openai' });
