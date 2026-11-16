// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Loaded with `--import` before agent.ts, so the AWS SDK is patched before it is
 * imported. Converse calls become `chat <model>` spans (model, token usage, finish
 * reason). The instrumentation records no messages, so the hooks below add them as
 * gen_ai.input.messages / gen_ai.output.messages, which Agent Traces reads.
 */

import { register as registerLoader } from 'node:module';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';

// ESM: let the instrumentation hook `import` statements.
registerLoader('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

interface ContentBlock {
  text?: string;
  toolUse?: { toolUseId?: string; name?: string; input?: unknown };
  toolResult?: { toolUseId?: string; content?: unknown };
}
interface BedrockMessage {
  role?: string;
  content?: ContentBlock[];
}

/** Bedrock Converse messages in the GenAI semantic convention shape. */
function toGenAI(messages: BedrockMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    parts: (m.content ?? []).map((b) => {
      if (b.text !== undefined) return { type: 'text', content: b.text };
      if (b.toolUse) {
        return { type: 'tool_call', id: b.toolUse.toolUseId, name: b.toolUse.name, arguments: b.toolUse.input };
      }
      if (b.toolResult) return { type: 'tool_call_response', id: b.toolResult.toolUseId, response: b.toolResult.content };
      return { type: 'unknown' };
    }),
  }));
}

registerInstrumentations({
  instrumentations: [
    new AwsInstrumentation({
      preRequestHook: (span, { request }) => {
        if (request.commandName !== 'Converse') return;
        const input = request.commandInput as { messages?: BedrockMessage[]; system?: { text?: string }[] };
        span.setAttribute('gen_ai.provider.name', 'aws.bedrock');
        span.setAttribute('gen_ai.input.messages', JSON.stringify(toGenAI(input.messages ?? [])));
        const system = (input.system ?? []).filter((s) => s.text).map((s) => ({ type: 'text', content: s.text }));
        if (system.length) span.setAttribute('gen_ai.system_instructions', JSON.stringify(system));
      },
      responseHook: (span, { response }) => {
        if (response.request.commandName !== 'Converse') return;
        const message = response.data?.output?.message as BedrockMessage | undefined;
        if (message) span.setAttribute('gen_ai.output.messages', JSON.stringify(toGenAI([message])));
      },
    }),
  ],
});
