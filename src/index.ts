// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

export { register, DEFAULT_ENDPOINT } from './register.js';
export type { RegisterOptions } from './register.js';
export { observe, withObserve, Op } from './observe.js';
export type { ObserveOptions } from './observe.js';
export { enrich } from './enrich.js';
export type { EnrichOptions } from './enrich.js';
export { score } from './score.js';
export type { ScoreOptions } from './score.js';
export { Benchmark, evaluate } from './benchmark.js';
export type {
  EvalScore,
  BenchmarkResult,
  BenchmarkSummary,
  ScoreSummary,
  TestCaseResult,
} from './benchmark.js';
export { OpenSearchTraceRetriever } from './retrieval.js';
export type {
  Message,
  SpanRecord,
  TraceRecord,
  SessionRecord,
} from './retrieval.js';
export { AWSSigV4OTLPExporter } from './exporters.js';
