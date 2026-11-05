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
await register({ endpoint: "http://localhost:21890/opentelemetry" });

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
| `endpoint` | `string` | See [Endpoints](#endpoints-traces-and-evaluation-logs) | OTLP base URL for all signals (same as `OTEL_EXPORTER_OTLP_ENDPOINT`) |
| `tracesEndpoint` | `string` | none | Full traces URL, used as-is |
| `logsEndpoint` | `string` | none | Full logs URL for evaluation events, used as-is |
| `protocol` | `"http" \| "grpc"` | Auto-detected per signal | Export protocol for all signals |
| `sigv4` | `{ service?, region? }` | none | Sign traces and logs with AWS SigV4 (OTLP/HTTP only) |
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

Spans and evaluation events (`gen_ai.evaluation.result`) are separate OTLP signals. `register()` resolves each one with the same rule, following the [OTel exporter spec](https://opentelemetry.io/docs/specs/otel/protocol/exporter/).

**Endpoint per signal (priority order):**

1. `tracesEndpoint` / `logsEndpoint` parameter: full URL, used as-is
2. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`: full URL, used as-is
3. Base URL (`endpoint`, else `OTEL_EXPORTER_OTLP_ENDPOINT`): over HTTP `/v1/traces` or `/v1/logs` is appended; over gRPC the base is used as-is for both signals
4. Nothing configured: the Data Prepper base `http://localhost:21890/opentelemetry` (`DEFAULT_BASE_ENDPOINT`), so `/v1/traces` and `/v1/logs`

**Protocol per signal (priority order):**

1. `protocol` parameter: `"http"` or `"grpc"`
2. `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` / `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`
3. `OTEL_EXPORTER_OTLP_PROTOCOL`
4. URL scheme of that signal's endpoint (`grpc://` or `grpcs://` mean gRPC, mapped to `http://` / `https://`), else HTTP

`exporter` and `logExporter` are escape hatches: each replaces one signal's exporter and nothing is derived from it. Without `exporter`, every signal has an endpoint (the Data Prepper default at worst). With `exporter` and no logs destination (`logExporter`, `logsEndpoint`, `endpoint`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`), `register()` does not set up a logs pipeline: it warns once, and evaluation events go to the global `LoggerProvider` (a no-op unless you registered one). Pass `logsEndpoint` or `logExporter` to export them.

**Local OTel Collector or Data Prepper.** One base URL serves both signals:

```typescript
// traces -> http://localhost:4318/v1/traces, logs -> http://localhost:4318/v1/logs
await register({ endpoint: "http://localhost:4318", serviceName: "my-app" });

// gRPC: traces and logs both go to localhost:4317
await register({ endpoint: "grpc://localhost:4317", serviceName: "my-app" });
```

or with env vars only:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

**AWS OSIS: one pipeline per signal.** An OpenSearch Ingestion traces pipeline does not accept logs. Create a separate logs pipeline (OTel logs source, routed to `otel-v1-genai-evaluation`) and pass both URLs. With `sigv4`, `register()` builds an `AWSSigV4OTLPExporter` and an `AWSSigV4OTLPLogExporter` with the same service and region:

```typescript
import { register } from "@opensearch-project/genai-observability-sdk-ts";

await register({
  tracesEndpoint: "https://traces-pipeline.us-east-1.osis.amazonaws.com/v1/traces",
  logsEndpoint: "https://logs-pipeline.us-east-1.osis.amazonaws.com/v1/logs",
  sigv4: { service: "osis", region: "us-east-1" },
});
```

**Migrating from a traces URL in `endpoint`.** Before this release `endpoint` was the full traces URL. An `endpoint` whose path ends in `traces` (for example `http://c:4318/v1/traces` or `https://gw/otlp/traces`) is still accepted for one release: over HTTP traces go to it as-is, logs go to the same URL with that last segment replaced by `logs` (`/v1/logs`, `/otlp/logs`), and `register()` prints a deprecation warning. Pass the base URL, or `tracesEndpoint` and `logsEndpoint`, instead.

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
| `attributes` | `Record<string, unknown>` | | Extra string, number, or boolean attributes. SDK keys (`gen_ai.evaluation.*`, `opensearch.gen_ai.evaluation.*`, `error.type`, `gen_ai.response.id`, `gen_ai.conversation.id`, `gen_ai.agent.*`) are dropped with a warning; the options win |

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
| `runId` | `string` | `test.suite.run.id` (default: generated). Use the same id from every CI shard so they report into one run, or an existing run's id to re-score it (send new results with the same run id). Empty or whitespace-only throws |
| `ciPipeline` | `Record<string, string>` | Set or override `cicd.pipeline.name` / `.run.id` / `.run.url.full` (read from the CI environment by default; nothing outside CI) |
| `recordExpected` | `boolean` | Export each case's `expected` as `opensearch.test.case.expected` (default `true`). Pass `false` if test sets hold sensitive data. Also a `new Benchmark()` option |

Each `TestCaseResult` has `status` (`pass`, or `fail` when the case errored or failed a verdict), `resultStatus` (`pass` | `fail` | `error`), `errorType`, `durationMs`, `verdicts` (evaluation name to verdict), and the `traceId` / `spanId` of the agent root span when the task created one.

**Declaring rules.** Wrap a scorer with `defineScorer(spec, fn)` to declare its evaluation name and pass rule up front. A scorer may also return a `boolean` (a verdict) or an `EvalScore` with `label` (`"pass"` / `"fail"`), `passed`, `threshold`, `direction`, `scoreMin`, `scoreMax`, `judgeTraceId` (the LLM judge's own trace, sent as `opensearch.gen_ai.evaluation.judge.trace_id`); fields set on the `EvalScore` win over the declaration.

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

`AWSSigV4OTLPLogExporter` takes the same options and signs OTLP/JSON log exports (evaluation events). `register({ sigv4 })` creates both for you; construct them yourself only to pass as `exporter` / `logExporter`.

Requires `@aws-sdk/credential-providers` and `aws4` packages.

## Configuration

| Environment Variable | Description | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP URL for all signals (`/v1/traces` and `/v1/logs` appended over HTTP, as-is over gRPC) | Data Prepper base |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full OTLP traces URL | none |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Full OTLP logs URL for evaluation events | none |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Protocol for all signals (`grpc`, `http/protobuf`, `http/json`) | none |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | Protocol for traces | none |
| `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL` | Protocol for evaluation logs | none |
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
