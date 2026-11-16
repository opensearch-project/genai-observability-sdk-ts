// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

// Compiled by tests/evaluate_types.test.ts (not run): each line checks what
// evaluate() is declared to return. It returns a Promise only when a task or
// scorer call returned one, so anything that may be async is a union.
import { evaluate, defineScorer, type BenchmarkResult } from '../../src/benchmark.js';
import { observe, Op } from '../../src/observe.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type Either = BenchmarkResult | Promise<BenchmarkResult>;

const _asyncTask = evaluate({ name: 'a', task: async (q: unknown) => q, data: [], scores: [] });
const _observedTask = evaluate({
  name: 'o',
  task: observe({ op: Op.INVOKE_AGENT }, async (q: unknown) => q),
  data: [],
  scores: [],
});
const _asyncScorer = evaluate({
  name: 's',
  task: (q: unknown) => String(q),
  data: [],
  scores: [defineScorer({ name: 'judge' }, async () => 1)],
});
const _syncRun = evaluate({
  name: 'sync',
  task: (q: unknown) => String(q),
  data: [],
  scores: [function ok(): number { return 1; }],
});

export type Checks = [
  Expect<Equal<typeof _asyncTask, Either>>,
  Expect<Equal<typeof _observedTask, Either>>,
  Expect<Equal<typeof _asyncScorer, Either>>,
  Expect<Equal<typeof _syncRun, BenchmarkResult>>,
];
