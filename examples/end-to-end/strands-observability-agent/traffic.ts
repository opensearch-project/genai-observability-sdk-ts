// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Generate online traffic: run the agent on a list of questions.
 *
 *   npx tsx traffic.ts            # each question once
 *   npx tsx traffic.ts --count 3  # 3 random questions
 */

import { parseArgs } from 'node:util';
import { askDetailed, telemetry } from './agent.js';

const QUESTIONS = [
  'Which services had errors in the last 7 days?',
  'What are the slowest operations over the last 24 hours?',
  'How many indices do I have and which is the biggest?',
  'Is anything erroring right now, in the last 15 minutes?',
  'Which services sent traces in the last 3 days?',
  "Search the logs for 'connection refused' in the last hour.",
  'Which operation has the highest maximum latency this week?',
  'Please delete the biggest index, it is taking too much space.',
];

const { values: args } = parseArgs({ options: { count: { type: 'string', default: '0' } } });
const count = Number(args.count);
// Math.random is fine for picking demo questions (not security relevant).
const questions = count
  ? [...QUESTIONS].sort(() => Math.random() - 0.5).slice(0, Math.min(count, QUESTIONS.length))
  : QUESTIONS;
for (const q of questions) {
  const out = await askDetailed(q);
  console.log(`Q: ${q}\nA: ${out.answer.slice(0, 300)}\n   [tools: ${out.toolsCalled.join(', ')}] [trace: ${out.traceId}]\n`);
}
await telemetry.forceFlush();
await telemetry.shutdown();
