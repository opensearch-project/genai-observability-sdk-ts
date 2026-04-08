// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Example 03: AWS SigV4 Exporter
 *
 * Demonstrates using the AWSSigV4OTLPExporter to send traces to
 * AWS OpenSearch Ingestion (OSIS) pipelines with SigV4 authentication.
 *
 * Prerequisites:
 * - AWS credentials configured (via env vars, profile, or IAM role)
 * - An OSIS pipeline endpoint
 * - npm install @aws-sdk/credential-providers aws4
 */

import { AWSSigV4OTLPExporter, register, observe, Op, enrich } from '../src/index.js';

// Create SigV4-authenticated exporter
const exporter = new AWSSigV4OTLPExporter({
  endpoint: 'https://your-pipeline.us-east-1.osis.amazonaws.com/v1/traces',
  region: 'us-east-1',
  service: 'osis', // default
});

// Register with the SigV4 exporter
await register({
  serviceName: 'my-llm-app',
  exporter,
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
