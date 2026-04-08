# OpenSearch GenAI Observability SDK for TypeScript

[![CI](https://github.com/opensearch-project/genai-observability-sdk-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/opensearch-project/genai-observability-sdk-ts/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opensearch-genai-observability-sdk-ts.svg)](https://www.npmjs.com/package/opensearch-genai-observability-sdk-ts)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

OTel-native tracing and scoring for LLM applications. Instrument your AI workflows with standard OpenTelemetry spans and submit evaluation scores — all routed to OpenSearch through a single OTLP pipeline.

## Features

- **One-line setup** — `register()` configures the full OTel pipeline (TracerProvider, exporter, auto-instrumentation)
- **`observe()`** — function wrapper that creates OTel spans with [GenAI semantic convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/) attributes
- **`withObserve()`** — block-level tracing (TypeScript equivalent of Python's context manager)
- **`enrich()`** — add model, token usage, and other GenAI attributes to the active span from anywhere in your code
- **Auto-instrumentation** — automatically discovers and activates installed instrumentor packages (OpenAI, etc.)
- **Scoring** — `score()` emits evaluation metrics as OTel spans at span, trace, or standalone level
- **Benchmarks** — `evaluate()` runs your agent against a dataset with scorers; `Benchmark` uploads results from any eval framework
- **AWS SigV4** — built-in SigV4 signing for AWS-hosted OpenSearch and Data Prepper endpoints
- **Streaming** — full support for sync/async functions, generators, and async generators
- **Zero lock-in** — remove a wrapper and your code still works; everything is standard OTel

## Requirements

- **Node.js**: >= 18
- **OpenTelemetry API**: ^1.9.0

## Installation

```bash
npm install opensearch-genai-observability-sdk-ts
# or
pnpm add opensearch-genai-observability-sdk-ts
# or
yarn add opensearch-genai-observability-sdk-ts
```

Optional peer dependencies for specific features:

```bash
# OpenSearch trace retrieval
npm install @opensearch-project/opensearch

# AWS SigV4 authentication
npm install @aws-sdk/credential-providers aws4
```

## Quick Start

```typescript
import { register, observe, Op, enrich, score } from "opensearch-genai-observability-sdk-ts";

// 1. Initialize tracing (one line)
await register({ endpoint: "http://localhost:21890/opentelemetry/v1/traces" });

// 2. Trace your functions
const search = observe(
  { name: "web_search", op: Op.EXECUTE_TOOL },
  (query: string) => {
    return [{ title: `Result for: ${query}` }];
  },
);

const research = observe(
  { name: "research_agent", op: Op.INVOKE_AGENT },
  (query: string) => {
    const results = search(query);
    enrich({ model: "gpt-4.1", provider: "openai", inputTokens: 150, outputTokens: 50 });
    return `Summary of: ${JSON.stringify(results)}`;
  },
);

// 3. Use it
const result = research("What is OpenSearch?");

// 4. Submit scores (after workflow completes)
score({ name: "relevance", value: 0.95, traceId: "..." });
```

This produces the following span tree:

```
invoke_agent research_agent
└── execute_tool web_search
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Your Application                    │
│                                                       │
│  observe(opts, fn)   withObserve()   enrich()         │
│  score()   evaluate()   Benchmark                     │
│                     │                                 │
│      opensearch-genai-observability-sdk-ts            │
├──────────────────────────────────────────────────────┤
│  register()                                           │
│  ┌──────────────────────────────────────────────┐    │
│  │  TracerProvider                               │    │
│  │  ├── Resource (service.name)                  │    │
│  │  ├── BatchSpanProcessor                       │    │
│  │  │   └── OTLPSpanExporter (HTTP or gRPC)      │    │
│  │  │       └── SigV4 signing (AWS endpoints)    │    │
│  │  └── Auto-instrumentation                     │    │
│  └──────────────────────────────────────────────┘    │
└───────────────────────┬──────────────────────────────┘
                        │ OTLP (HTTP/gRPC)
                        ▼
               ┌─────────────────┐
               │  Data Prepper /  │
               │  OTel Collector  │
               └────────┬────────┘
                        │
                        ▼
               ┌─────────────────┐
               │   OpenSearch     │
               │  ├── traces      │
               │  └── scores      │
               └─────────────────┘
```

## API Reference

### `register()`

Configures the OTel tracing pipeline. Call once at startup.

```typescript
await register({
  endpoint: "http://my-collector:4318/v1/traces",  // or use env vars
  serviceName: "my-app",
  batch: true,            // BatchSpanProcessor (true) or Simple (false)
  autoInstrument: true,   // discover installed instrumentor packages
});
```

**Endpoint resolution (priority order):**

1. `endpoint` parameter — full URL, used as-is
2. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` env var — full URL, used as-is
3. `OTEL_EXPORTER_OTLP_ENDPOINT` env var — base URL, `/v1/traces` appended automatically
4. `http://localhost:21890/opentelemetry/v1/traces` — Data Prepper default

**Protocol resolution (priority order):**

1. `protocol` parameter — `"http"` or `"grpc"`
2. `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` env var
3. `OTEL_EXPORTER_OTLP_PROTOCOL` env var
4. Inferred from URL scheme (`grpc://` or `grpcs://` → gRPC, otherwise HTTP)

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `endpoint` | `string` | See resolution above | OTLP traces endpoint URL |
| `protocol` | `"http" \| "grpc"` | Auto-detected | Export protocol |
| `serviceName` | `string` | `"unknown_service"` | `service.name` resource attribute |
| `serviceVersion` | `string` | — | `service.version` resource attribute |
| `batch` | `boolean` | `true` | Use BatchSpanProcessor when true |
| `autoInstrument` | `boolean` | `true` | Discover and activate instrumentor packages |
| `exporter` | `SpanExporter` | — | Custom exporter (overrides endpoint/protocol) |
| `headers` | `Record<string, string>` | — | Headers for OTLP exporter |

**Authenticated endpoints (e.g. AWS OSIS):** pass a custom exporter:

```typescript
import { register, AWSSigV4OTLPExporter } from "opensearch-genai-observability-sdk-ts";

await register({
  exporter: new AWSSigV4OTLPExporter({
    endpoint: "https://pipeline.us-east-1.osis.amazonaws.com/v1/traces",
    service: "osis",
  }),
});
```

### `observe()`

Function wrapper that creates OTel spans with GenAI semantic convention attributes. Supports three calling styles:

```typescript
// 1. Bare — uses function name, no op
const fn = observe(function myFunc(x: number) { return x * 2; });

// 2. With options and function
const agent = observe(
  { name: "planner", op: Op.INVOKE_AGENT },
  (query: string) => {
    enrich({ model: "gpt-4.1" });
    return callLlm(query);
  },
);

// 3. Options only — returns a wrapper (decorator factory pattern)
const withTracing = observe({ op: Op.INVOKE_AGENT });
const tracedAgent = withTracing(myAgentFunction);
```

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | Function name | Span name |
| `op` | `string` | — | `gen_ai.operation.name` value. Use `Op` constants or any custom string |
| `kind` | `SpanKind` | `INTERNAL` | OTel span kind |
| `nameFrom` | `string` | — | Resolve span name dynamically from a function parameter |

**Span naming:** When `op` is a well-known value, the span name is `"{op} {name}"` (e.g. `"invoke_agent planner"`).

**Attributes set automatically:**

| Attribute | When set |
|---|---|
| `gen_ai.operation.name` | When `op` is provided |
| `gen_ai.agent.name` | All ops except `execute_tool` |
| `gen_ai.tool.name` | When `op=Op.EXECUTE_TOOL` |
| `gen_ai.tool.type` | When `op=Op.EXECUTE_TOOL` (set to `"function"`) |
| `gen_ai.input.messages` / `gen_ai.output.messages` | All ops except `execute_tool` |
| `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` | When `op=Op.EXECUTE_TOOL` |

**Dynamic naming with `nameFrom`:**

```typescript
const dispatch = observe(
  { op: Op.EXECUTE_TOOL, nameFrom: "toolName" },
  (toolName: string, args: Record<string, unknown>) => { /* ... */ },
);

dispatch("web_search", { q: "hello" });
// Creates span: "execute_tool web_search"
```

**Supported function types:** sync, async, generators, async generators. Errors are captured as span status + exception events and re-thrown.

### `withObserve()`

Block-level tracing — the TypeScript equivalent of Python's `with observe(...)` context manager. Gives direct access to the span.

```typescript
const result = withObserve("thinking", { op: Op.CHAT }, (span) => {
  span.setAttribute("custom.step", "reasoning");
  enrich({ model: "gpt-4.1", inputTokens: 1500 });
  return callLlm(prompt);
});

// Async version
const data = await withObserve("fetch-data", async (span) => {
  return await fetchFromApi();
});
```

### `Op`

Constants for well-known `gen_ai.operation.name` values. Any custom string is also accepted.

| Constant | Value | Use for |
|---|---|---|
| `Op.CHAT` | `"chat"` | LLM chat completions |
| `Op.INVOKE_AGENT` | `"invoke_agent"` | Agent invocations |
| `Op.CREATE_AGENT` | `"create_agent"` | Agent creation/setup |
| `Op.EXECUTE_TOOL` | `"execute_tool"` | Tool/function calls |
| `Op.RETRIEVAL` | `"retrieval"` | RAG retrieval steps |
| `Op.EMBEDDINGS` | `"embeddings"` | Embedding generation |
| `Op.GENERATE_CONTENT` | `"generate_content"` | Content generation |
| `Op.TEXT_COMPLETION` | `"text_completion"` | Text completions |

### `enrich()`

Add GenAI semantic convention attributes to the currently active span. Call from inside an `observe()`-wrapped function or a `withObserve()` block.

```typescript
const chat = observe({ name: "chat", op: Op.CHAT }, (prompt: string) => {
  const result = callLlm(prompt);
  enrich({
    model: "gpt-4.1",
    provider: "openai",
    inputTokens: 150,
    outputTokens: 50,
    temperature: 0.7,
  });
  return result;
});
```

**Parameters:**

| Parameter | Attribute | Description |
|---|---|---|
| `model` | `gen_ai.request.model` | Model name |
| `provider` | `gen_ai.provider.name` | Provider name (openai, anthropic, etc.) |
| `inputTokens` | `gen_ai.usage.input_tokens` | Input token count |
| `outputTokens` | `gen_ai.usage.output_tokens` | Output token count |
| `totalTokens` | `gen_ai.usage.total_tokens` | Total token count |
| `responseId` | `gen_ai.response.id` | Response/completion ID |
| `finishReason` | `gen_ai.response.finish_reasons` | Finish reason(s) |
| `temperature` | `gen_ai.request.temperature` | Temperature setting |
| `maxTokens` | `gen_ai.request.max_tokens` | Max tokens setting |
| `sessionId` | `gen_ai.conversation.id` | Session/conversation ID |
| `agentId` | `gen_ai.agent.id` | Agent ID |
| `agentDescription` | `gen_ai.agent.description` | Agent description |
| `systemInstructions` | `gen_ai.system_instructions` | System prompt |
| `[extra: string]` | As provided | Any additional key-value attributes |

### `score()`

Submits evaluation scores as OTel spans. The score span is attached to the evaluated trace so it appears in the same trace waterfall.

```typescript
// Span-level: score a specific span
score({
  name: "accuracy",
  value: 0.95,
  traceId: "6ebb9835f43af1552f2cebb9f5165e39",
  spanId: "89829115c2128845",
  explanation: "Weather data matches ground truth",
});

// Trace-level: score the entire trace (attaches to root span)
score({
  name: "relevance",
  value: 0.92,
  traceId: "6ebb9835f43af1552f2cebb9f5165e39",
  explanation: "Response addresses the user's query",
  attributes: { "test.suite.name": "nightly_eval" },
});

// Standalone: no trace linkage
score({ name: "fluency", value: 0.88 });
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `name` | `string` | Metric name (e.g., `"relevance"`, `"factuality"`) |
| `value` | `number` | Numeric score |
| `traceId` | `string` | Hex trace ID of the trace being scored |
| `spanId` | `string` | Hex span ID for span-level scoring. When omitted, attaches to root span |
| `label` | `string` | Human-readable label (`"pass"`, `"relevant"`) |
| `explanation` | `string` | Evaluator justification (truncated to 500 chars) |
| `responseId` | `string` | LLM completion ID for correlation |
| `attributes` | `Record<string, unknown>` | Additional span attributes |

### `evaluate()`

Run a task against a dataset, score outputs, and record results as OTel spans.

```typescript
import { evaluate } from "opensearch-genai-observability-sdk-ts";
import type { EvalScore } from "opensearch-genai-observability-sdk-ts";

function accuracy(input: unknown, output: unknown, expected: unknown): EvalScore {
  return {
    name: "accuracy",
    value: String(output).includes(String(expected)) ? 1.0 : 0.0,
  };
}

const result = evaluate({
  name: "rag-agent",
  task: (input) => callMyAgent(input),
  data: [
    { input: "What is Python?", expected: "programming language" },
    { input: "What causes rain?", expected: "water vapor" },
  ],
  scores: [accuracy],
  metadata: { agentVersion: "v2" },
  recordIo: true,
});

console.log(result.summary); // { totalCases: 2, errorCount: 0, scores: { accuracy: { avg: 1.0 } } }
```

Produces:
```
test_suite_run rag-agent
├── test_case
└── test_case
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `name` | `string` | Benchmark name (`test.suite.name`). Stable across runs |
| `task` | `(input: unknown) => unknown` | Function that takes input and returns output |
| `data` | `Array<{ input, expected?, caseId?, caseName? }>` | Test cases |
| `scores` | `ScorerFn[]` | Scorer functions: `(input, output, expected)` returning `EvalScore`, `EvalScore[]`, or `number` |
| `metadata` | `Record<string, unknown>` | Attached to root span. Reserved keys are filtered |
| `recordIo` | `boolean` | Record input/output/expected as span attributes (default `false`) |

### `Benchmark`

Upload pre-computed evaluation results from any framework as OTel spans.

```typescript
import { Benchmark } from "opensearch-genai-observability-sdk-ts";

const bench = new Benchmark("nightly-eval", {
  metadata: { model: "gpt-4" },
  recordIo: true,
});

bench.log({
  input: "What is Python?",
  output: "A language",
  scores: { accuracy: 1.0 },
});

// Link to existing agent traces
bench.log({
  input: "query",
  output: "answer",
  scores: { accuracy: 0.9 },
  traceId: "6ebb9835f43af1552f2cebb9f5165e39",
  spanId: "89829115c2128845",
});

const summary = bench.close();
```

### `OpenSearchTraceRetriever`

Retrieves GenAI trace spans from OpenSearch. Requires `@opensearch-project/opensearch` package.

```typescript
import { OpenSearchTraceRetriever } from "opensearch-genai-observability-sdk-ts";

const retriever = new OpenSearchTraceRetriever({
  host: "https://localhost:9200",
  auth: { username: "admin", password: "admin" },
  verifyCerts: false,
});

// Retrieve all spans for a session or trace
const session = await retriever.getTraces("my-conversation-id");
for (const trace of session.traces) {
  for (const span of trace.spans) {
    console.log(`${span.operationName}: ${span.name} (${span.model})`);
  }
}

// List recent root spans
const roots = await retriever.listRootSpans({
  services: ["my-agent"],
  maxResults: 10,
});

// Check which traces already have evaluation spans
const evaluated = await retriever.findEvaluatedTraceIds(["trace-id-1", "trace-id-2"]);
```

**Constructor:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `host` | `string` | `"https://localhost:9200"` | OpenSearch endpoint |
| `index` | `string` | `"otel-v1-apm-span-*"` | Index pattern for span data |
| `auth` | `{ username, password } \| "awsSigV4"` | — | Authentication method |
| `verifyCerts` | `boolean` | `true` | Verify TLS certificates |

### `AWSSigV4OTLPExporter`

OTLP trace exporter with AWS SigV4 request signing. Use with `register()` for AWS-hosted endpoints.

```typescript
import { AWSSigV4OTLPExporter } from "opensearch-genai-observability-sdk-ts";

const exporter = new AWSSigV4OTLPExporter({
  endpoint: "https://pipeline.us-east-1.osis.amazonaws.com/v1/traces",
  service: "osis",       // "osis" for OSIS pipelines, "es" for OpenSearch Service
  region: "us-east-1",   // or set AWS_DEFAULT_REGION / AWS_REGION
});
```

Requires `@aws-sdk/credential-providers` and `aws4` packages.

## Configuration

| Environment Variable | Description | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full OTLP traces endpoint URL | — |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP endpoint URL (`/v1/traces` appended) | — |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | Protocol for traces (`http/protobuf`, `grpc`) | — |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Protocol for all signals (`http/protobuf`, `grpc`) | — |
| `AWS_DEFAULT_REGION` | AWS region for SigV4 signing | — |
| `AWS_REGION` | AWS region for SigV4 signing (fallback) | — |

## Examples

See the [`examples/`](examples/) directory:

| Example | Description |
|---|---|
| [`01_tracing_basics.ts`](examples/01_tracing_basics.ts) | `observe()` wrapper, `withObserve()`, `enrich()` |
| [`02_scoring.ts`](examples/02_scoring.ts) | Span-level, trace-level, and standalone scoring |
| [`03_aws_sigv4.ts`](examples/03_aws_sigv4.ts) | AWS SigV4 authentication with `AWSSigV4OTLPExporter` |
| [`04_async_tracing.ts`](examples/04_async_tracing.ts) | Async function and generator tracing |
| [`05_openai_auto_instrument.ts`](examples/05_openai_auto_instrument.ts) | OpenAI auto-instrumentation via `register()` |
| [`06_retrieval_and_eval.ts`](examples/06_retrieval_and_eval.ts) | Retrieve traces from OpenSearch, evaluate, write scores back |
| [`07_benchmarks.ts`](examples/07_benchmarks.ts) | `evaluate()` with scorers, `Benchmark` with manual logging |

## Python SDK

Looking for the Python version? See [opensearch-genai-observability-sdk-py](https://github.com/opensearch-project/genai-observability-sdk-py).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Developer Guide

```bash
# Install dependencies
pnpm install

# Build (ESM + CJS + type declarations)
pnpm build

# Run tests
pnpm test

# Type-check
pnpm typecheck

# Lint
pnpm lint
```

## Security

If you discover a potential security issue in this project we ask that you notify the OpenSearch Security Team via [opensearch-security@amazon.com](mailto:opensearch-security@amazon.com). Please do **not** create a public GitHub issue.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

## Copyright

Copyright OpenSearch Contributors. See [NOTICE](NOTICE) for details.
