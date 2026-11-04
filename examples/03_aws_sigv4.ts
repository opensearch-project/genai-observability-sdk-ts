// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Example 03: AWS SigV4
 *
 * Sends traces and evaluation events to AWS OpenSearch Ingestion (OSIS)
 * pipelines with SigV4 authentication. OSIS has one pipeline per signal, so
 * pass the traces and the logs pipeline URL; `sigv4` makes register() build a
 * signed exporter for each.
 *
 * Prerequisites:
 * - AWS credentials configured (via env vars, profile, or IAM role)
 * - An OSIS traces pipeline and an OSIS logs pipeline
 * - `@aws-sdk/credential-providers` and `aws4` (optional dependencies of this
 *   package, installed by default unless you omit optional dependencies)
 */

import { register, observe, Op, enrich } from '../src/index.js';

await register({
  serviceName: 'my-llm-app',
  tracesEndpoint: 'https://your-traces-pipeline.us-east-1.osis.amazonaws.com/v1/traces',
  logsEndpoint: 'https://your-logs-pipeline.us-east-1.osis.amazonaws.com/v1/logs',
  sigv4: { service: 'osis', region: 'us-east-1' },
  autoInstrument: false,
});

// Now all traced functions will send spans to AWS OSIS
const chat = observe({ name: 'bedrock-chat', op: Op.CHAT }, function (prompt: string) {
  enrich({
    model: 'anthropic.claude-v2',
    provider: 'aws-bedrock',
    inputTokens: 50,
    outputTokens: 100,
  });
  return `Response to: ${prompt}`;
});

console.log(chat('Tell me about OpenSearch'));
console.log('Trace sent to AWS OSIS pipeline with SigV4 auth!');
