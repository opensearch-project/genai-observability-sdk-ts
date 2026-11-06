# OpenSearch GenAI Observability SDK for TypeScript

[![CI](https://github.com/opensearch-project/genai-observability-sdk-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/opensearch-project/genai-observability-sdk-ts/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@opensearch-project/genai-observability-sdk-ts.svg)](https://www.npmjs.com/package/@opensearch-project/genai-observability-sdk-ts)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

OTel-native tracing and scoring for LLM applications. Instrument your AI workflows with standard OpenTelemetry spans and submit evaluation scores — all routed to OpenSearch through a single OTLP pipeline.

## Features

- **One-line setup** — `register()` configures the full OTel pipeline (TracerProvider, exporter, auto-instrumentation)
- **`observe()`** — function wrapper that creates OTel spans with [GenAI semantic convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/) attributes
- **`withObserve()`** — block-level tracing (TypeScript equivalent of Python's context manager)
- **`enrich()`** — add model, token usage, and other GenAI attributes to the active span from anywhere in your code
- **`markAgentRoot()`** — mark the agent's span as the trace's agent root in OpenSearch Agent Traces
- **Auto-instrumentation** — automatically discovers and activates installed instrumentor packages (OpenAI, etc.)
- **Scoring**: `score()` emits each evaluation result as an OTel `gen_ai.evaluation.result` log event, parented to the evaluated span
- **Benchmarks**: `evaluate()` runs your agent against a dataset with scorers; `Benchmark` uploads results from any eval framework. Each case is its own agent trace plus one `gen_ai.evaluation.result` log event per score
- **Agent evaluations onboarding**: [docs/agent-evaluations-onboarding.md](docs/agent-evaluations-onboarding.md) walks through the online path (sample traces, judge them, post results back) and the offline path (test suites and runs), with Dashboards deep links and copyable LLM prompts
- **Agent evaluations guide**: [docs/agent-evaluations.md](docs/agent-evaluations.md) covers what gets stored, online and offline evaluation, ingestion (Data Prepper and Amazon OpenSearch Ingestion), verification and troubleshooting
- **AWS SigV4** — built-in SigV4 signing for AWS-hosted OpenSearch and Data Prepper endpoints
- **Streaming** — full support for sync/async functions, generators, and async generators
- **Zero lock-in** — remove a wrapper and your code still works; everything is standard OTel

## Requirements

- **Node.js**: ^18.19.0 or >= 20.6.0 (required by `@opentelemetry/sdk-logs`)
- **OpenTelemetry API**: ^1.9.0

## Installation

```bash
npm install @opensearch-project/genai-observability-sdk-ts
# or
pnpm add @opensearch-project/genai-observability-sdk-ts
# or
yarn add @opensearch-project/genai-observability-sdk-ts
```

Retrieval (`@opensearch-project/opensearch`) and SigV4 signing (`@aws-sdk/credential-providers`, `aws4`) use optional dependencies, which npm, pnpm and yarn install by default. If you install with `--omit=optional` (or `--no-optional`), add the ones you need:

```bash
# OpenSearch trace retrieval
npm install @opensearch-project/opensearch

# AWS SigV4 authentication
npm install @aws-sdk/credential-providers aws4
```

## Quick Start

```typescript
import { register, observe, Op, enrich, score } from "@opensearch-project/genai-observability-sdk-ts";

// 1. Initialize tracing (one line)
await register(); // OTLP/HTTP to http://localhost:4318 (local OTel Collector)

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

// 4. Submit scores (after workflow completes): pass the evaluated span's ids
score({ name: "relevance", value: 0.95, traceId: "...", spanId: "..." });
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
│  │  ├── TestCaseSpanProcessor (evaluate())       │    │
│  │  ├── BatchSpanProcessor                       │    │
│  │  │   └── OTLPSpanExporter (HTTP or gRPC)      │    │
│  │  │       └── SigV4 signing (AWS endpoints)    │    │
│  │  └── Auto-instrumentation                     │    │
│  │  LoggerProvider (evaluation and test events)  │    │
│  │  └── BatchLogRecordProcessor                  │    │
│  │      └── OTLPLogExporter (HTTP, /v1/logs)     │    │
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
          ┌───────────────────────────────┐
          │   OpenSearch                  │
          │  ├── otel-v1-apm-span-*       │
          │  └── otel-v1-genai-evaluation │
          └───────────────────────────────┘
```

## API Reference

### `register()`

Configures the OTel tracing pipeline and the logs pipeline that carries evaluation events from `score()`. Call once at startup.

```typescript
await register({
  endpoint: "http://my-collector:4318",  // base URL for traces and logs, or use env vars
  serviceName: "my-app",
  batch: true,            // BatchSpanProcessor (true) or Simple (false)
  autoInstrument: true,   // discover installed instrumentor packages
  agentName: "travel_planner", // optional: the agent this process evaluates
  agentVersion: "v3",          // optional: its version
});
```

#### Agent identity

`agentName` / `agentVersion` are stamped as `gen_ai.agent.name` and `gen_ai.agent.version` on every `gen_ai.evaluation.result` event the SDK emits. OpenSearch Dashboards uses them to scope the Evaluations page to one agent and to compare runs version to version. Both are OpenTelemetry GenAI attributes (`gen_ai.agent.name`, `gen_ai.agent.version`).

Per field, the SDK uses the first of:

1. the explicit option (`score({ agentName, agentVersion })`, `evaluate({...})`, `new Benchmark(name, {...})`);
2. the evaluated span's own attribute: the active span for inline `score()`, the agent root span for `evaluate()`;
3. the `register()` default.

An unknown agent is left out, never invented. `evaluate()` also stamps the agent on the agent root spans where the span names none itself, so traces can be filtered by agent version.

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `endpoint` | `string` | `http://localhost:4318` (see [Endpoints](#endpoints-traces-and-evaluation-logs)) | OTLP base URL for all signals, port included (same as `OTEL_EXPORTER_OTLP_ENDPOINT`). A path ending in `/v1/traces` or `/v1/logs` throws |
| `tracesEndpoint` | `string` | none | Full traces URL, used as-is. Pass with `logsEndpoint` (or `logExporter`) |
| `logsEndpoint` | `string` | none | Full logs URL for evaluation events, used as-is. Pass with `tracesEndpoint` (or `exporter`) |
| `protocol` | `"http" \| "http/protobuf" \| "grpc"` | Auto-detected per signal | Export protocol for all signals. HTTP is always protobuf; `"http/json"` throws |
| `compression` | `"none" \| "gzip"` | `OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION`, else `OTEL_EXPORTER_OTLP_COMPRESSION`, else `"none"` | Request compression for every exporter (OTLP/HTTP, SigV4, gRPC). Must match the pipeline's `compression` |
| `timeoutMillis` | `number` | `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT`, else `OTEL_EXPORTER_OTLP_TIMEOUT`, else `10000` | Timeout of each export request |
| `sigv4` | `{ service?, region? }` | none | Sign traces and logs with AWS SigV4 (OTLP/HTTP protobuf only) |
| `serviceName` | `string` | `"unknown_service"` | `service.name` resource attribute |
| `serviceVersion` | `string` | none | `service.version` resource attribute |
| `batch` | `boolean` | `true` | Use BatchSpanProcessor when true |
| `autoInstrument` | `boolean` | `true` | Discover and activate instrumentor packages |
| `exporter` | `SpanExporter` | none | Custom span exporter, used as given (traces only). Without a logs destination, no logs pipeline is set up (see [Endpoints](#endpoints-traces-and-evaluation-logs)) |
| `headers` | `Record<string, string>` | none | Headers for every export (traces and logs). Over gRPC they are sent as gRPC metadata with lowercased keys (gRPC rejects uppercase keys) |
| `logs` | `boolean` | `true` | Set up a LoggerProvider for evaluation events |
| `logExporter` | `LogRecordExporter` | none | Custom log exporter, used as given (logs only) |

**Logs pipeline.** `register()` also creates a `LoggerProvider` with a batch processor (simple when `batch: false`) and a log exporter for evaluation events, over the same protocol rules as traces. `provider.forceFlush()` and `provider.shutdown()` flush and shut down both pipelines. If a global `LoggerProvider` is already registered (for example by `NodeSDK`), `register()` leaves it in place and `score()` emits through it.

#### Endpoints: traces and evaluation logs

Spans and evaluation events (`gen_ai.evaluation.result`) are separate OTLP signals. `register()` resolves each one with the same rule, following the [OTel exporter spec](https://opentelemetry.io/docs/specs/otel/protocol/exporter/). Options passed in code always win over env vars, as in the OTel SDK exporters.

There are no port options: the port is part of each URL (`endpoint`, `tracesEndpoint`, `logsEndpoint`).

**Pick one of three setups:**

**(a) Local OTel Collector or the observability stack.** Nothing to set: the default base is the OTel standard `http://localhost:4318` (`DEFAULT_BASE_ENDPOINT`), so traces go to `/v1/traces` and logs to `/v1/logs`. Over gRPC the default is `http://localhost:4317`.

```typescript
await register({ serviceName: "my-app" });
// the same, explicitly:
await register({ endpoint: "http://localhost:4318", serviceName: "my-app" });
// gRPC: traces and logs both go to localhost:4317
await register({ endpoint: "grpc://localhost:4317", serviceName: "my-app" });
```

or with env vars only: `export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.

**(b) One OSIS or Data Prepper `otlp` source** that serves both signals at `/<pipeline>/v1/traces` and `/<pipeline>/v1/logs`. Pass the base, path prefix included. For OSIS, sign with SigV4 service `osis`: OSIS accepts OTLP/HTTP only (protobuf), signed with SigV4, and does not support gRPC.

```typescript
await register({
  endpoint: "https://<host>/<pipeline>", // -> /<pipeline>/v1/traces and /<pipeline>/v1/logs
  sigv4: { service: "osis", region: "us-east-1" }, // OSIS only
});
```

**(c) Separate trace and logs pipelines** (`otel_trace_source` and `otel_logs_source`). Pass both full URLs; each is used as-is. On Data Prepper the default ports are 21890 (traces) and 21892 (logs); set `path:` on each source (for example `/v1/traces` and `/v1/logs`) and `unframed_requests: true` so plain OTLP/HTTP requests are accepted. On OSIS, add `sigv4`.

```typescript
await register({
  tracesEndpoint: "http://data-prepper:21890/v1/traces",
  logsEndpoint: "http://data-prepper:21892/v1/logs",
});
```

**Endpoint resolution, per signal (traces and logs), first match wins:**

1. `tracesEndpoint` / `logsEndpoint` parameter: full URL, used as-is
2. `endpoint` parameter: base URL, with `/v1/traces` or `/v1/logs` appended over HTTP, as-is over gRPC
3. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`: full URL, used as-is
4. `OTEL_EXPORTER_OTLP_ENDPOINT`: base URL, same rule as `endpoint`
5. Nothing configured: `http://localhost:4318` (`http://localhost:4317` over gRPC), same rule

For example, with `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://env-logs:4318/v1/logs` set:

```typescript
await register({ endpoint: "http://collector:4318" });
// traces -> http://collector:4318/v1/traces
// logs   -> http://collector:4318/v1/logs   (endpoint beats the env var)
```

**Errors.** `register()` throws:

- when `endpoint` (or `OTEL_EXPORTER_OTLP_ENDPOINT`) has a path ending in `/v1/traces` or `/v1/logs`: it is the OTLP base URL. Remove the suffix (`http://host:4318`), or pass `tracesEndpoint` and `logsEndpoint`.
- when only one of `tracesEndpoint` / `logsEndpoint` is passed. `logExporter` (or `logs: false`) stands in for `logsEndpoint`, and `exporter` for `tracesEndpoint`.
- when `sigv4` is set and a signal resolves to gRPC (a `grpc://` / `grpcs://` URL, `protocol: "grpc"`, or a gRPC protocol env var): SigV4 signs OTLP/HTTP only. Use an `https://` endpoint or `protocol: "http"`. A signal with its own `exporter` / `logExporter` is not checked.

**Protocol per signal (priority order):**

1. `protocol` parameter: `"http"` or `"grpc"`
2. A `grpc://` or `grpcs://` scheme on the URL passed in code (`tracesEndpoint` / `logsEndpoint` / `endpoint`)
3. `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` / `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`
4. `OTEL_EXPORTER_OTLP_PROTOCOL`
5. URL scheme of that signal's endpoint (`grpc://` or `grpcs://` mean gRPC), else HTTP

Use gRPC with a local OTel Collector (default `localhost:4317`) or a self-hosted Data Prepper, whose OTLP sources accept framed gRPC natively. OSIS does not support gRPC: use `https://` with `sigv4`.

**OTLP/HTTP is binary protobuf** (`Content-Type: application/x-protobuf`), for every exporter `register()` builds, signed or not. The SDK never sends OTLP/JSON: Data Prepper and OSIS read OTLP/JSON hex trace and span ids as base64, which corrupts them so spans and evaluation results no longer match their traces. `protocol: "http/json"` (or `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`) therefore throws; `http/protobuf` is the same as `http`.

**Compression.** `compression: "gzip"` (or `OTEL_EXPORTER_OTLP_COMPRESSION=gzip`) compresses every export, gRPC included. It must match the receiving pipeline: OSIS accepts only `none` or `gzip`, and the client must use the pipeline source's `compression` setting. A Data Prepper source with `compression: none` rejects gzip bodies.

**Request size.** OSIS `otel_*` sources cap each request at 1 MB to 4 MB (1 MB by default with the persistent buffer), and Data Prepper sources at their `max_request_length`. Large GenAI spans (prompts, completions) can exceed that: lower the batch size with `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`. A rejected request gets a 413, which `AWSSigV4OTLPExporter` logs with this hint.

**Self-hosted Data Prepper.** For OTLP/HTTP straight from the SDK, set `unframed_requests: true` and the source paths (`traces_path` / `logs_path` on `otlp`, `path` on `otel_trace_source` / `otel_logs_source`). Use `ssl: false` for plain `http://`, or a certificate your process trusts: for `https://`, add your CA with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

`grpc://` and `grpcs://` are mapped to `http://` / `https://` once the protocol is known. An `http://` or `https://` scheme does not select HTTP over the env vars (the OTel JS gRPC exporters take `http(s)://` URLs too).

`exporter` and `logExporter` are escape hatches: each replaces one signal's exporter and nothing is derived from it. Without `exporter`, every signal has an endpoint (the default at worst). With `exporter` and no logs destination (`logExporter`, or any of steps 1 to 4 above for logs: `logsEndpoint`, `endpoint`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT`), `register()` does not set up a logs pipeline: it warns once, and evaluation events go to the global `LoggerProvider` (a no-op unless you registered one). Pass `logsEndpoint` or `logExporter` to export them.

**Migrating from a traces URL in `endpoint`.** Before this release `endpoint` was the full traces URL and the default was `http://localhost:21890/opentelemetry/v1/traces`. `endpoint` is now always the base URL, and a value ending in `/v1/traces` throws. Pass the base (`http://host:4318`), or `tracesEndpoint` and `logsEndpoint`. To keep sending to a Data Prepper `otlp` source on its old default, pass `endpoint: "http://localhost:21890"` and set `traces_path` / `logs_path` and `unframed_requests: true` on the source (see the [guide](docs/agent-evaluations.md#ingestion)).

**Scores over gRPC.** The OTLP/HTTP log exporters send whole-number scores as `doubleValue` (see [Scores are doubles](#score)); the gRPC log exporter sends them as `intValue`. The evaluation index maps them as `double` either way.

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

### `markAgentRoot()`

Mark the active span as its trace's agent root. OpenSearch Agent Traces lists a trace by the span marked with `derived.gen_ai.is_root`. Data Prepper marks the outermost GenAI span of each trace for you (the root when it is a GenAI span, or the agent span below an HTTP handler), so you only need this to choose the span yourself. A span marked at the source wins.

```typescript
const plan = observe({ name: "planner", op: Op.INVOKE_AGENT }, async (query: string) => {
  markAgentRoot();
  // ...
});
```

Without the SDK, set the span attribute `derived.gen_ai.is_root` to `true` on the agent's span.

### `score()`

Records one evaluation result as an OTel log event with event name `gen_ai.evaluation.result`, following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/). The event carries the trace and span id of the **evaluated** span, so it joins to the trace without adding spans to it. It is exported over OTLP logs (`/v1/logs`). Data Prepper routes these events to the `otel-v1-genai-evaluation` index.

```typescript
// Inline: the evaluated span is the active span. Needs an OTel context
// manager (register() installs none); otherwise pass traceId and spanId.
withObserve("answer", { op: Op.CHAT }, () => {
  score({ name: "relevance", value: 0.92, label: "relevant", evaluator: "relevance_judge" });
});

// Offline: score a stored span by id
score({
  name: "accuracy",
  value: 0.95,
  traceId: "6ebb9835f43af1552f2cebb9f5165e39",
  spanId: "89829115c2128845",
  explanation: "Weather data matches ground truth",
  evaluator: "accuracy_judge",
  evaluatorVersion: "1.2.0",
  evaluatorType: "llm_judge",
  direction: "maximize",
  scoreMin: 0,
  scoreMax: 1,
});

// Trace-level: only a trace id is known. The event carries it as its own trace
// id, with no span id, and opensearch.gen_ai.evaluation.level=trace.
score({ name: "task_success", value: 1, traceId: "6ebb9835f43af1552f2cebb9f5165e39" });
```

The instrumentation scope is the library that emitted the event: every SDK event (`gen_ai.evaluation.result`) has scope `opensearch-genai-observability-sdk-ts` with the SDK version, and no scope attributes. The evaluator is data about the result and goes in `opensearch.gen_ai.evaluation.evaluator.*`. The timestamp is the time `score()` is called.

**Scores are doubles.** `gen_ai.evaluation.score.value` is a double in the OTel semantic conventions, but OTel JS encodes any whole JS number (for example `1`) as an OTLP `intValue`, and the logs API has no way to request a double. The SDK's own log exporters (the OTLP/HTTP exporter `register()` creates, and `AWSSigV4OTLPLogExporter`; not the gRPC one) re-encode whole-number `gen_ai.evaluation.score.value`, `opensearch.gen_ai.evaluation.score.min` / `.max` / `.threshold` as `doubleValue`. With your own `logExporter` or a global `LoggerProvider` you configured, whole numbers are sent as `intValue`. The OpenSearch evaluation index maps the field as `double`, so stored values are the same either way.

**Parameters:**

| Parameter | Type | Attribute | Description |
|---|---|---|---|
| `name` | `string` | `gen_ai.evaluation.name` | Metric name (required) |
| `value` | `number` | `gen_ai.evaluation.score.value` | Numeric score |
| `label` | `string` | `gen_ai.evaluation.score.label` | Low-cardinality label (`"relevant"`). `"pass"` / `"fail"` (any case, stored lowercase) is the verdict. A non-verdict label with a threshold verdict goes to `opensearch.gen_ai.evaluation.judge_label` |
| `explanation` | `string` | `gen_ai.evaluation.explanation` | Evaluator rationale (truncated to 500 chars) |
| `responseId` | `string` | `gen_ai.response.id` | Evaluated completion id, if known |
| `traceId` | `string` | event trace id | Trace of the evaluated span |
| `spanId` | `string` | event span id | Evaluated span (requires `traceId`) |
| `level` | `"span" \| "trace" \| "session" \| "tool_call"` | `opensearch.gen_ai.evaluation.level` | Defaults to `"trace"` for trace-level scores |
| `evaluator` | `string` | `opensearch.gen_ai.evaluation.evaluator.name` | Evaluator identity |
| `evaluatorVersion` | `string` | `opensearch.gen_ai.evaluation.evaluator.version` | Evaluator version |
| `evaluatorType` | `"llm_judge" \| "code" \| "human" \| "external"` | `opensearch.gen_ai.evaluation.evaluator.type` | Kind of evaluator |
| `direction` | `"maximize" \| "minimize"` | `opensearch.gen_ai.evaluation.score.direction` | Whether higher is better |
| `scoreMin` / `scoreMax` | `number` | `opensearch.gen_ai.evaluation.score.min` / `.max` | Scale bounds |
| `threshold` | `number` | `opensearch.gen_ai.evaluation.score.threshold` | Pass threshold. `direction` defaults to `maximize` (recorded) |
| `conversationId` | `string` | `gen_ai.conversation.id` | Session id for session-scoped evaluations |
| `agentName` | `string` | `gen_ai.agent.name` | Evaluated agent. Default: the active span's, else `register({ agentName })` |
| `agentVersion` | `string` | `gen_ai.agent.version` | Its version. Default: the active span's, else `register({ agentVersion })` |
| `errorType` | `string` | `error.type` | Set when the evaluator failed |
| `judgeTraceId` | `string` | `opensearch.gen_ai.evaluation.judge.trace_id` | The judge's own trace |
| `evaluatorDescription` | `string` | `opensearch.gen_ai.evaluation.evaluator.description` | What the evaluator checks (criteria or rubric summary) |
| `judgeModel` | `string` | `gen_ai.request.model` | Model used by the LLM judge |
| `judgePromptName` | `string` | `gen_ai.prompt.name` | Name of the judge prompt template |
| `judgePromptVersion` | `string` | `gen_ai.prompt.version` | Version of the judge prompt |
| `judgeSystemInstructions` | `unknown` | `gen_ai.system_instructions` | The judge's system prompt. Opt-in (may hold sensitive data); text as is, other values `JSON.stringify`'d; cut at 8192 characters with `opensearch.gen_ai.evaluation.system_instructions_truncated = true` |
| `attributes` | `Record<string, unknown>` | | Extra string, number, or boolean attributes. SDK keys (`gen_ai.evaluation.*`, `opensearch.gen_ai.evaluation.*`, `error.type`, `gen_ai.response.id`, `gen_ai.conversation.id`, `gen_ai.agent.*`, `gen_ai.request.model`, `gen_ai.prompt.*`, `gen_ai.system_instructions`) are dropped with a warning; the options win |

`opensearch.gen_ai.evaluation.*` attributes are OpenSearch extensions for fields that are still proposals in the GenAI semantic conventions. They will move to `gen_ai.*` names when those proposals merge.

A trace-level score (only `traceId`) is never attached to a span id derived from the trace id. The OTel JS SDK only takes a trace id from a valid span context, so `register()` adds `TraceOnlyContextProcessor` to its LoggerProvider to set it; if you configure your own LoggerProvider, add `new TraceOnlyContextProcessor()` to its processors (the SDK warns once when it is missing).

**Verdicts.** OpenSearch Dashboards shows pass/fail only for a declared rule; a result without one is neutral ("Scored"). Declare the rule with `label: "pass"` / `"fail"` (explicit verdict) or `threshold` (+ `direction`). The verdict is `gen_ai.evaluation.score.label` = `pass` / `fail`, as in OTel's own examples. When `value` and `threshold` are given without a `label`, the SDK computes it: `pass` if `value >= threshold` (`maximize`) or `value <= threshold` (`minimize`), else `fail`. A `"pass"` / `"fail"` `label` wins over a computed verdict and is stored lowercase. Any other `label` (for example `"relevant"`) is stored as the label only when there is no verdict; with a threshold verdict the verdict is the label and your label is kept as `opensearch.gen_ai.evaluation.judge_label`, with a warning.

```typescript
score({ name: "answer_quality", value: 3, threshold: 4, scoreMin: 1, scoreMax: 5 }); // label=fail
score({ name: "latency_s", value: 9.2, threshold: 12, direction: "minimize" });      // label=pass
score({ name: "tool_selection", value: 1, label: "pass" });
```

### `evaluate()`

Run a task against a dataset, score outputs, and record each score as an OTel `gen_ai.evaluation.result` log event. The SDK creates no spans of its own: each case's agent run is its own trace, exactly like production.

```typescript
import { evaluate } from "@opensearch-project/genai-observability-sdk-ts";
import type { EvalScore } from "@opensearch-project/genai-observability-sdk-ts";

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
  metadata: { "app.variant": "v2" },
});

console.log(result.summary); // { totalCases: 2, passCount: 2, errorCount: 0, scores: { accuracy: { avg: 1.0 } } }
```

Produces:
```
trace (one per case)                        the agent run, unchanged
└── root span                               + test.suite.name, test.suite.run.id, test.case.id, test.case.name
    (event) gen_ai.evaluation.result        one per score, parented to the root span, test.* ids copied
```

Each `gen_ai.evaluation.result` carries `test.suite.name`, `test.suite.run.id`, `test.case.id`, `test.case.name`, `gen_ai.agent.name` / `gen_ai.agent.version` when known, `opensearch.test.case.expected` when the case has an `expected`, and the run `metadata` (reserved keys are dropped; the score's own `metadata` and the SDK attributes win). Pass/fail/error counts are not sent: readers derive them from the results of a run. The summary `evaluate()` returns is computed locally.

**Expected output.** When a case has `expected`, every result of the case (including error results) carries it as `opensearch.test.case.expected`: strings as is, other values `JSON.stringify`'d. It is truncated to 4096 characters; a truncated value also sets `opensearch.test.case.expected_truncated = true`. It is not put on the agent spans. Online `score()` never sets it; pass it in `attributes` if you want it there. It is exported by default; if your test sets hold sensitive data, pass `recordExpected: false` to `evaluate()` or `new Benchmark()`, and neither attribute is written.

`test.suite.run.id` and `test.case.id` are proposed OTel attributes ([semantic-conventions#1262](https://github.com/open-telemetry/semantic-conventions/issues/1262), [semantic-conventions-genai#79](https://github.com/open-telemetry/semantic-conventions-genai/issues/79)); the other `test.*` names are OTel's.

**CI/CD.** Inside CI, every evaluation result and the agent root spans also carry the OTel `cicd.pipeline.name`, `cicd.pipeline.run.id` and `cicd.pipeline.run.url.full`, read from GitHub Actions (`GITHUB_WORKFLOW`, `GITHUB_RUN_ID`, run URL), GitLab CI (`CI_PIPELINE_NAME`, `CI_PIPELINE_ID`, `CI_PIPELINE_URL`) or Jenkins (`JOB_NAME`, `BUILD_ID`, `BUILD_URL`). Pass `ciPipeline: { "cicd.pipeline.run.id": ... }` to `evaluate()` / `new Benchmark()` to set or override them. Outside CI nothing is added.

A case whose task throws is not scored: each declared scorer emits one error result instead, named after the scorer (its `defineScorer()` `name`, else the function name), with `error.type` set to the exception class name, no score value and no label (the exception message is not sent). The run continues. When the task creates no span, the results have no trace context. All events go to the OTLP logs endpoint; Data Prepper routes them to `otel-v1-genai-evaluation-*`, distinguished by `eventName`.

**How root spans are found.** The TypeScript SDK installs no context manager, so `evaluate()` cannot rely on the active OTel context. Cases run one at a time and `task` is synchronous, so the SDK keeps a module-level "current case" while each task runs. `TestCaseSpanProcessor` reads it in `onStart`: every span started during the case without a parent from the same case (no parent, or a remote parent) is stamped with the `test.*` ids, and the first one becomes the trace context for that case's events. Spans started by scorers (LLM judges) are outside the case and are not stamped. `register()` adds the processor to its provider, and `evaluate()` adds it to a global OTel JS 1.x `BasicTracerProvider` if missing. With a provider that only takes processors at construction (OTel JS 2.x), add it yourself:

```typescript
import { TestCaseSpanProcessor } from "@opensearch-project/genai-observability-sdk-ts";

const provider = new BasicTracerProvider({
  spanProcessors: [new TestCaseSpanProcessor(), new BatchSpanProcessor(exporter)],
});
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `name` | `string` | Benchmark name (`test.suite.name`). Stable across runs |
| `task` | `(input: unknown) => unknown` | Synchronous function that takes input and returns output |
| `data` | `Array<{ input, expected?, caseId?, caseName? }>` | Test cases |
| `scores` | `Array<ScorerFn \| Scorer>` | Scorer functions: `(input, output, expected)` returning, synchronously, `EvalScore`, `EvalScore[]`, a finite `number`, or `boolean`. Anything else logs a warning and emits an error result. Optionally wrapped with `defineScorer()` |
| `metadata` | `Record<string, unknown>` | Copied to every `gen_ai.evaluation.result` of the run. Reserved keys are filtered |
| `runName` | `string` | `opensearch.test.suite.run.name` on every result: a readable run name, for example `"v5 with shorter prompt"`. Also a `new Benchmark()` option |
| `runDescription` | `string` | `opensearch.test.suite.run.description` on every result (cut at 1024 characters). Also a `new Benchmark()` option |
| `runId` | `string` | `test.suite.run.id` (default: generated). Use the same id from every CI shard so they report into one run, or an existing run's id to re-score it (send new results with the same run id). Empty or whitespace-only throws |
| `ciPipeline` | `Record<string, string>` | Set or override `cicd.pipeline.name` / `.run.id` / `.run.url.full` (read from the CI environment by default; nothing outside CI) |
| `recordExpected` | `boolean` | Export each case's `expected` as `opensearch.test.case.expected` (default `true`). Pass `false` if test sets hold sensitive data. Also a `new Benchmark()` option |

Each `TestCaseResult` has `status` (`pass`, or `fail` when the case errored or failed a verdict), `resultStatus` (`pass` | `fail` | `error`), `errorType`, `durationMs`, `verdicts` (evaluation name to verdict), and the `traceId` / `spanId` of the agent root span when the task created one.

**Declaring rules.** Wrap a scorer with `defineScorer(spec, fn)` to declare its evaluation name and pass rule up front. A scorer may also return a `boolean` (a verdict) or an `EvalScore` with `label` (`"pass"` / `"fail"`), `passed`, `threshold`, `direction`, `scoreMin`, `scoreMax`, `judgeTraceId` (the LLM judge's own trace, sent as `opensearch.gen_ai.evaluation.judge.trace_id`); fields set on the `EvalScore` win over the declaration. `defineScorer()` and `EvalScore` also take the judge context of `score()`: `evaluatorDescription`, `judgeModel`, `judgePromptName`, `judgePromptVersion` and the opt-in `judgeSystemInstructions`.

```typescript
import { defineScorer } from "@opensearch-project/genai-observability-sdk-ts";

const quality = defineScorer(
  { name: "answer_quality", threshold: 4, scoreMin: 1, scoreMax: 5, evaluatorType: "llm_judge" },
  (input, output) => judge(input, output), // number: named "answer_quality", verdict from threshold
);
const latency = defineScorer(
  { name: "latency_budget", direction: "minimize", threshold: 12 },
  () => secondsTaken, // pass when <= 12
);
const tools = defineScorer({ name: "tool_selection" }, () => ({
  name: "tool_selection", value: hitRate, passed: hitRate === 1,
}));
```

`ScorerSpec` fields: `name` (evaluation name of number/boolean results and of the error grade; default the function name), `threshold`, `direction` (default `maximize` with a threshold), `scoreMin` / `scoreMax`, `evaluator` (`opensearch.gen_ai.evaluation.evaluator.name`), `evaluatorType`. A scorer that throws, or returns something other than a finite number, a boolean, an `EvalScore` or an `EvalScore[]` (for example `undefined`, `NaN` or a Promise, with a warning), emits a grade with `error.type` and no value, label or explanation under the declared `name` (else the function name), so it lands on the same evaluation as its successful results. The exception message stays in the local `scorerErrors`.

**Case status** (local `resultStatus`, not sent): `error` if the task threw or any result errored; else `fail` if any score of the case has a `fail` verdict (a `pass` / `fail` `label`, `passed`, or `threshold` + `direction`); else `pass`. Scores with no declared rule never fail a case. The summary keeps `passCount`, `failCount` and `errorCount`.

### `Benchmark`

Upload pre-computed evaluation results from any framework. Each `log()` emits one `gen_ai.evaluation.result` event per score, parented to the evaluated agent span when `traceId` and `spanId` are given. With only `traceId`, scores are trace-level; with neither, the events have no trace context. Each result carries the `test.*` ids, the agent, `cicd.pipeline.*` in CI, and the run `metadata` plus the case `metadata` passed to `log()` (reserved keys are dropped; the score's own `metadata` and the SDK attributes win). `scores` is `{ name: value }` or an `EvalScore[]` (to declare `label` / `threshold` / bounds / `judgeTraceId`). `expected` is sent on every result of the case as `opensearch.test.case.expected` (see [Expected output](#evaluate)).

`error`, `errorType` and `status` set the local result: `error` or `errorType` marks the case `error`; otherwise a `fail` verdict marks it `fail`; `status` sets `pass`, `fail` or `error` explicitly. With `errorType`, every score in `scores` is emitted as an evaluator error result: `error.type` = `errorType`, no score value and no label. `close()` returns the local summary and sends nothing. No spans are created.

Pass `runId` to set `test.suite.run.id` (default: generated): use the same id from every CI shard so they report into one run, or an existing run's id to re-score it (send the new results with the same run id). An empty or whitespace-only `runId` throws.

```typescript
import { Benchmark } from "@opensearch-project/genai-observability-sdk-ts";

const bench = new Benchmark("nightly-eval", {
  metadata: { model: "gpt-4" },
  agentName: "travel_planner",
  agentVersion: "v3",
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

// The evaluator failed: each score is sent as an error result (error.type, no value)
bench.log({
  input: "query",
  scores: [{ name: "answer_quality" }],
  errorType: "TimeoutError",
});

// Declare verdicts: the case fails because answer_quality is below its threshold
bench.log({
  input: "query",
  output: "answer",
  scores: [
    { name: "answer_quality", value: 3, threshold: 4, scoreMin: 1, scoreMax: 5 },
    { name: "tool_selection", value: 1, label: "pass" },
  ],
});

const summary = bench.close();
```

### `OpenSearchTraceRetriever`

Retrieves GenAI trace spans from OpenSearch. Requires `@opensearch-project/opensearch` package.

```typescript
import { OpenSearchTraceRetriever } from "@opensearch-project/genai-observability-sdk-ts";

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

// Check which traces already have evaluation results
const evaluated = await retriever.findEvaluatedTraceIds(["trace-id-1", "trace-id-2"]);
```

`findEvaluatedTraceIds()` returns the trace ids that already have a `gen_ai.evaluation.result` event in the evaluation index. A missing evaluation index (nothing sent yet) returns an empty set; any other error (auth, connection, mapping) is thrown, so a failed lookup never looks like "nothing evaluated" and never makes you re-run judges and write duplicate results.

**Constructor:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `host` | `string` | `"https://localhost:9200"` | OpenSearch endpoint |
| `index` | `string` | `"otel-v1-apm-span-*"` | Index pattern for span data |
| `evaluationIndex` | `string` | `"otel-v1-genai-evaluation*"` | Index pattern for evaluation results, used by `findEvaluatedTraceIds()` |
| `auth` | `{ username, password } \| "awsSigV4"` | — | Authentication method |
| `verifyCerts` | `boolean` | `true` | Verify TLS certificates |

### `AWSSigV4OTLPExporter`

OTLP trace exporter with AWS SigV4 request signing. Use with `register()` for AWS-hosted endpoints.

```typescript
import { AWSSigV4OTLPExporter } from "@opensearch-project/genai-observability-sdk-ts";

const exporter = new AWSSigV4OTLPExporter({
  endpoint: "https://pipeline.us-east-1.osis.amazonaws.com/v1/traces",
  service: "osis",       // "osis" for OSIS pipelines, "es" for OpenSearch Service
  region: "us-east-1",   // or set AWS_DEFAULT_REGION / AWS_REGION
});
```

`AWSSigV4OTLPLogExporter` takes the same options and signs OTLP/HTTP protobuf log exports (evaluation events). Both send `Content-Type: application/x-protobuf` and sign exactly the bytes sent. Other options:

- `compression`: `"none"` or `"gzip"` (default from `OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION` / `OTEL_EXPORTER_OTLP_COMPRESSION`, else none). With gzip the protobuf body is gzipped first, sent with `Content-Encoding: gzip`, and the signature's payload hash is the SHA-256 of the gzip bytes. Match the pipeline's `compression`.
- `headers`: merged over `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS` and signed. `Content-Type`, `Content-Encoding`, `Host`, `Authorization` and `X-Amz-*` are set by the exporter.
- `timeoutMillis`: per attempt (default `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT` / `OTEL_EXPORTER_OTLP_TIMEOUT`, else 10 s).
- Retries: 408, 429 and 5xx (507 included), network errors and timeouts are retried with exponential backoff (honoring `Retry-After`), up to 3 attempts. 400, 401, 403, 413 and 415 are not retried; a 413 logs a hint about the pipeline's `max_request_length`. `register({ sigv4 })` creates both for you; construct them yourself only to pass as `exporter` / `logExporter`.

Requires `@aws-sdk/credential-providers` and `aws4` packages.

## Configuration

| Environment Variable | Description | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP URL for all signals (`/v1/traces` and `/v1/logs` appended over HTTP, as-is over gRPC). `endpoint` wins over it | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full OTLP traces URL. `tracesEndpoint` and `endpoint` win over it | none |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Full OTLP logs URL for evaluation events. `logsEndpoint` and `endpoint` win over it | none |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Protocol for all signals (`grpc` or `http/protobuf`; `http/json` throws). `protocol` wins over it | none |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | Protocol for traces | none |
| `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL` | Protocol for evaluation logs | none |
| `OTEL_EXPORTER_OTLP_COMPRESSION` / `OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION` | `none` or `gzip`. `compression` wins over them | `none` |
| `OTEL_EXPORTER_OTLP_TIMEOUT` / `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT` | Timeout of each export request, in milliseconds. `timeoutMillis` wins over them | `10000` |
| `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS` | Extra headers (`key=value,key2=value2`). `headers` wins per key; the SigV4 exporters sign them | none |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | Spans per export batch. Lower it when large GenAI spans exceed a pipeline's request limit | `512` |
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
