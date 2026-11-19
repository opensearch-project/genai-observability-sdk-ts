# Documentation

Reference and concepts for the OpenSearch GenAI Observability SDK for TypeScript. For step-by-step guides that you run against example agents, see [`examples/`](../examples/README.md).

| Document | What it covers |
|---|---|
| [API reference](api-reference.md) | Every public API: `register()`, `observe()`, `withObserve()`, `Op`, `enrich()`, `markAgentRoot()`, `score()`, `evaluate()`, `Benchmark`, `OpenSearchTraceRetriever`, `AWSSigV4OTLPExporter` |
| [Configuration](configuration.md) | Environment variables, endpoint and protocol resolution, AWS SigV4, optional dependencies, auto-instrumented libraries and the ESM load order |
| [Architecture](architecture.md) | How spans and evaluation events flow from the SDK through a collector or Data Prepper to OpenSearch |
| [Agent evaluations](agent-evaluations.md) | Evaluation concepts and reference: data model, attributes, what gets stored, index template, ingestion, verification, troubleshooting |
| [Getting started with agent evaluations](getting-started-evaluations.md) | Guided walkthrough from instrumenting an agent to offline and online evals, with an eval cookbook and copyable LLM prompts |

Runbooks (step by step):

- [Tracing runbook](../examples/runbooks/tracing.md): stand up the stack, `register()`, instrument, check the spans, open Agent Traces.
- [Evals runbook](../examples/runbooks/evals.md): offline evals, online evals, checking the results.

## Examples

[`examples/README.md`](../examples/README.md) lists every example. The basic examples in [`examples/basics/`](../examples/basics/), one SDK feature each:

| Example | Description |
|---|---|
| [`01_tracing_basics.ts`](../examples/basics/01_tracing_basics.ts) | `observe()` wrapper, `withObserve()`, `enrich()` |
| [`02_scoring.ts`](../examples/basics/02_scoring.ts) | Span-level, trace-level, and standalone scoring |
| [`03_aws_sigv4.ts`](../examples/basics/03_aws_sigv4.ts) | AWS SigV4 authentication with `AWSSigV4OTLPExporter` |
| [`04_async_tracing.ts`](../examples/basics/04_async_tracing.ts) | Async function and generator tracing |
| [`05_openai_auto_instrument.ts`](../examples/basics/05_openai_auto_instrument.ts) | OpenAI auto-instrumentation via `register()`, with the ESM load order |
| [`06_retrieval_and_eval.ts`](../examples/basics/06_retrieval_and_eval.ts) | Retrieve traces from OpenSearch, evaluate, write scores back |
| [`07_benchmarks.ts`](../examples/basics/07_benchmarks.ts) | `evaluate()` with scorers, `Benchmark` with manual logging |
