# OpenSearch GenAI Observability SDK for TypeScript

[![CI](https://github.com/opensearch-project/genai-observability-sdk-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/opensearch-project/genai-observability-sdk-ts/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@opensearch-project/genai-observability-sdk-ts.svg)](https://www.npmjs.com/package/@opensearch-project/genai-observability-sdk-ts)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

OTel-native tracing and evaluation for LLM applications and agents. Instrument your AI workflows with standard OpenTelemetry spans, score them online or offline, and send both to OpenSearch through one OTLP pipeline.

## Features

- **One-line setup**: `register()` configures the OTel traces and logs pipelines, the exporters and auto-instrumentation.
- **Tracing**: `observe()` and `withObserve()` create spans with [GenAI semantic convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/) attributes; `enrich()` adds model, token usage and other attributes; `markAgentRoot()` picks the agent root shown in OpenSearch Agent Traces.
- **Auto-instrumentation** for the OpenAI SDK when its OpenTelemetry instrumentation is installed, and for the AWS SDK (Bedrock) on request (`autoInstrument: { awsSdk: true }`).
- **Scoring**: `score()` emits each evaluation result as an OTel `gen_ai.evaluation.result` log event, parented to the evaluated span.
- **Benchmarks**: `evaluate()` runs your agent over a dataset with scorers; `Benchmark` uploads results from any eval framework.
- **Trace retrieval**: `OpenSearchTraceRetriever` reads traces back for online evaluation.
- **AWS SigV4** signing for AWS-hosted OpenSearch and Data Prepper endpoints.
- **Streaming**: sync and async functions, generators and async generators.
- **Zero lock-in**: remove a wrapper and your code still works; everything is standard OTel.

## Requirements

- **Node.js**: ^18.19.0 or >= 20.6.0 (required by `@opentelemetry/sdk-logs`)
- **OpenTelemetry API**: ^1.9.0

## Installation

```bash
npm install @opensearch-project/genai-observability-sdk-ts
# or: pnpm add / yarn add @opensearch-project/genai-observability-sdk-ts
```

Some features use optional dependencies, which npm, pnpm and yarn install by default. With `--omit=optional` (or `--no-optional`), add the ones you need:

| Feature | Packages |
|---|---|
| Trace retrieval (`OpenSearchTraceRetriever`) | `@opensearch-project/opensearch` |
| AWS SigV4 signing | `@aws-sdk/credential-providers`, `aws4` |

Auto-instrumentation uses optional peer dependencies: `npm install @opentelemetry/instrumentation-openai@~0.21.0 @opentelemetry/instrumentation-aws-sdk@~0.78.0`. See [Auto-instrumentation](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/docs/configuration.md#auto-instrumentation) for supported versions and the ESM load order.

## Quick start

### Tracing

```typescript
import { register, observe, enrich, Op } from "@opensearch-project/genai-observability-sdk-ts";

await register({ serviceName: "research-app" }); // OTLP/HTTP to http://localhost:4318

const research = observe({ name: "research_agent", op: Op.INVOKE_AGENT }, (query: string) => {
  enrich({ model: "gpt-4.1", provider: "openai", inputTokens: 150, outputTokens: 50 });
  return `Summary of: ${query}`;
});

research("What is OpenSearch?");
```

This produces the span `invoke_agent research_agent`. A longer example and the span tree are in [Architecture](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/docs/architecture.md#spans).

### Evaluations

```typescript
import { register, evaluate, defineScorer } from "@opensearch-project/genai-observability-sdk-ts";

const provider = await register({ serviceName: "capitals-app", agentName: "capitals_agent" });
const exactMatch = defineScorer({ name: "exact_match" }, (_input, output, expected) => output === expected);

const result = await evaluate({
  name: "capitals",
  task: (input) => myAgent(String(input)), // your agent, traced with observe()
  data: [{ input: "Capital of France?", expected: "Paris" }],
  scores: [exactMatch],
});
console.log(result.summary);
await provider.forceFlush();
```

Each case is its own agent trace, and each score is one `gen_ai.evaluation.result` event. To score live traffic, call `score({ name, value, traceId, spanId })`: see [`score()`](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/docs/api-reference.md#score) and [Getting started with agent evaluations](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/docs/getting-started-evaluations.md).

## Documentation

| Document | What it covers |
|---|---|
| [docs/api-reference.md](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/docs/api-reference.md) | Every public API: `register()`, `observe()`, `withObserve()`, `Op`, `enrich()`, `markAgentRoot()`, `score()`, `evaluate()`, `Benchmark`, `OpenSearchTraceRetriever`, `AWSSigV4OTLPExporter` |
| [docs/configuration.md](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/docs/configuration.md) | Environment variables, endpoints, AWS SigV4, ingestion pipelines, optional dependencies, auto-instrumentation |
| [docs/architecture.md](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/docs/architecture.md) | How spans and evaluation events flow to OpenSearch |
| [docs/agent-evaluations.md](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/docs/agent-evaluations.md) | Data model, attributes, what gets stored, index template, ingestion, verify, troubleshooting |
| [docs/getting-started-evaluations.md](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/docs/getting-started-evaluations.md) | Guided walkthrough from instrumenting an agent to offline and online evals |
| [examples/README.md](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/examples/README.md) | Every runnable example: basics, framework tracing, native evals, an end-to-end agent |
| [examples/runbooks/tracing.md](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/examples/runbooks/tracing.md) | Step by step: stand up the stack, instrument, check the spans, open Agent Traces |
| [examples/runbooks/evals.md](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/examples/runbooks/evals.md) | Step by step: offline evals, online evals, checking the results |

The docs index is [docs/README.md](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/docs/README.md).

## Python SDK

Looking for the Python version? See [opensearch-genai-observability-sdk-py](https://github.com/opensearch-project/genai-observability-sdk-py).

## Contributing

See [CONTRIBUTING.md](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/CONTRIBUTING.md) for setup, development commands (`pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`) and the pull request process.

## Security

If you discover a potential security issue in this project we ask that you notify the OpenSearch Security Team via [opensearch-security@amazon.com](mailto:opensearch-security@amazon.com). Please do **not** create a public GitHub issue.

## License

This project is licensed under the [Apache License 2.0](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/LICENSE).

## Copyright

Copyright OpenSearch Contributors. See [NOTICE](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/NOTICE) for details.
