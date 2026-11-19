// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Simulated production traffic for the online evaluation: a few agent runs, not
 * part of any test suite.
 *
 *   npx tsx traffic.ts
 */

import { register } from '@opensearch-project/genai-observability-sdk-ts';
import { PROMPTS, SERVICE_NAME, runAgent } from './agent.js';

const QUESTIONS = [
  'What should I do in New York this weekend?',
  'Plan a day in Sydney for me.',
  'Is it a good weekend for a trip to Paris?',
];

const provider = await register({ serviceName: SERVICE_NAME });

for (const question of QUESTIONS) {
  // The v2 prompt, so results filed under version v2 belong to v2 answers
  const run = await runAgent(question, { systemPrompt: PROMPTS.v2, version: 'v2' });
  console.log(`trace ${run.traceId}  ${question}`);
}

await provider.shutdown();
