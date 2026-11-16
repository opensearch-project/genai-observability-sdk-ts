# SDK basics

Small, self-contained scripts that show one SDK feature each. They import the SDK from `../../src`, so run them from a clone of this repo.

| Example | What it shows |
|---|---|
| [`01_tracing_basics.ts`](01_tracing_basics.ts) | `observe()`, `withObserve()`, `enrich()` |
| [`02_scoring.ts`](02_scoring.ts) | `score()` on a span, a trace, and standalone |
| [`03_aws_sigv4.ts`](03_aws_sigv4.ts) | SigV4 export to OpenSearch Ingestion pipelines |
| [`04_async_tracing.ts`](04_async_tracing.ts) | Async functions, async generators, nested spans |
| [`05_openai_auto_instrument.ts`](05_openai_auto_instrument.ts) | `register()` auto-instrumentation |
| [`06_retrieval_and_eval.ts`](06_retrieval_and_eval.ts) | `evaluate()` and `OpenSearchTraceRetriever` |
| [`07_benchmarks.ts`](07_benchmarks.ts) | `Benchmark` and `evaluate()` with scorers |

## Run

```bash
pnpm install
# start a local stack first: see ../runbooks/tracing.md
npx tsx examples/basics/01_tracing_basics.ts
```

`register()` sends to `http://localhost:4318` by default. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to point somewhere else. `03_aws_sigv4.ts` needs AWS credentials and two OpenSearch Ingestion pipeline URLs.

Type-check the basics with `pnpm typecheck:examples`.
