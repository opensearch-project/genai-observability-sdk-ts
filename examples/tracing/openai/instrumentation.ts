// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Loaded with `--import` before agent.ts, so the OpenAI SDK is patched before it
 * is imported. Each chat.completions.create call becomes a `chat <model>` span
 * (model, token usage, finish reason).
 */

import { register as registerLoader } from 'node:module';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { OpenAIInstrumentation } from '@opentelemetry/instrumentation-openai';

// ESM: let the instrumentation hook `import` statements.
registerLoader('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

registerInstrumentations({
  // captureMessageContent: also send prompts and completions (as log events).
  instrumentations: [new OpenAIInstrumentation({ captureMessageContent: true })],
});
