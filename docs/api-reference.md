# API reference

Every public API of `@opensearch-project/genai-observability-sdk-ts`. For endpoints, environment variables and auto-instrumentation, see [Configuration](configuration.md). For what an evaluation result contains and how it is stored, see [Agent evaluations](agent-evaluations.md).

- [`register()`](#register)
- [`observe()`](#observe)
- [`withObserve()`](#withobserve)
- [`Op`](#op)
- [`enrich()`](#enrich)
- [`markAgentRoot()`](#markagentroot)
- [`score()`](#score)
- [`evaluate()`](#evaluate)
- [`Benchmark`](#benchmark)
- [`OpenSearchTraceRetriever`](#opensearchtraceretriever)
- [`AWSSigV4OTLPExporter`](#awssigv4otlpexporter)

## `register()`

Configures the OTel tracing pipeline and the logs pipeline that carries evaluation events from `score()`. Call once at startup.

```typescript
await register({
  endpoint: "http://my-collector:4318",  // base URL for traces and logs, or use env vars
  serviceName: "my-app",
  batch: true,            // BatchSpanProcessor (true) or Simple (false)
  autoInstrument: true,   // turn on the installed OpenAI instrumentation ({ awsSdk: true } adds the AWS SDK)
  agentName: "travel_planner", // optional: the agent this process evaluates
  agentVersion: "v3",          // optional: its version
});
```

### Agent identity

`agentName` / `agentVersion` are stamped as `gen_ai.agent.name` and `gen_ai.agent.version` on every `gen_ai.evaluation.result` event the SDK emits. OpenSearch Dashboards uses them to scope the Evaluations page to one agent and to compare runs version to version. Both are OpenTelemetry GenAI attributes (`gen_ai.agent.name`, `gen_ai.agent.version`).

Per field, the SDK uses the first of:

1. the explicit option (`score({ agentName, agentVersion })`, `evaluate({...})`, `new Benchmark(name, {...})`);
2. the evaluated span's own attribute: the active span for inline `score()`, the agent root span for `evaluate()`;
3. the `register()` default.

An unknown agent is left out, never invented. `evaluate()` also stamps the agent on the agent root spans where the span names none itself, so traces can be filtered by agent version.

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `endpoint` | `string` | `http://localhost:4318` (see [Endpoints](configuration.md#endpoints-traces-and-evaluation-logs)) | OTLP base URL for all signals, port included (same as `OTEL_EXPORTER_OTLP_ENDPOINT`). A path ending in `/v1/traces` or `/v1/logs` throws |
| `tracesEndpoint` | `string` | none | Full traces URL, used as-is. Pass with `logsEndpoint` (or `logExporter`) |
| `logsEndpoint` | `string` | none | Full logs URL for evaluation events, used as-is. Pass with `tracesEndpoint` (or `exporter`) |
| `protocol` | `"http" \| "http/protobuf" \| "grpc"` | Auto-detected per signal | Export protocol for all signals. HTTP is always protobuf; `"http/json"` throws |
| `compression` | `"none" \| "gzip"` | `OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION`, else `OTEL_EXPORTER_OTLP_COMPRESSION`, else `"none"` | Request compression for every exporter (OTLP/HTTP, SigV4, gRPC). Must match the pipeline's `compression` |
| `timeoutMillis` | `number` | `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT`, else `OTEL_EXPORTER_OTLP_TIMEOUT`, else `10000` | Timeout of each export request |
| `sigv4` | `{ service?, region? }` | none | Sign traces and logs with AWS SigV4 (OTLP/HTTP protobuf only) |
| `serviceName` | `string` | `"unknown_service"` | `service.name` resource attribute |
| `serviceVersion` | `string` | none | `service.version` resource attribute |
| `batch` | `boolean` | `true` | Use BatchSpanProcessor when true |
| `autoInstrument` | `boolean \| { openai?: boolean; awsSdk?: boolean }` | `true` (OpenAI on, AWS SDK off) | Turn on the installed instrumentations listed in [Auto-instrumentation](configuration.md#auto-instrumentation), with this provider. `{ awsSdk: true }` adds the AWS SDK instrumentation; `false` turns on none |
| `exporter` | `SpanExporter` | none | Custom span exporter, used as given (traces only). Without a logs destination, no logs pipeline is set up (see [Endpoints](configuration.md#endpoints-traces-and-evaluation-logs)) |
| `headers` | `Record<string, string>` | none | Headers for every export (traces and logs). Over gRPC they are sent as gRPC metadata with lowercased keys (gRPC rejects uppercase keys) |
| `logs` | `boolean` | `true` | Set up a LoggerProvider for evaluation events |
| `logExporter` | `LogRecordExporter` | none | Custom log exporter, used as given (logs only) |
| `setGlobal` | `boolean` | `true` | Register the tracer provider and LoggerProvider as the OTel globals and, on Node, install `AsyncLocalStorageContextManager` when no context manager is set. With `false`, `score()` still emits through this `register()`'s LoggerProvider |
| `agentName` | `string` | none | Default `gen_ai.agent.name` of evaluation results (see [Agent identity](#agent-identity)) |
| `agentVersion` | `string` | none | Default `gen_ai.agent.version` of evaluation results |

**Logs pipeline.** `register()` also creates a `LoggerProvider` with a batch processor (simple when `batch: false`) and a log exporter for evaluation events, over the same protocol rules as traces. `provider.forceFlush()` and `provider.shutdown()` flush and shut down both pipelines. If a global `LoggerProvider` is already registered (for example by `NodeSDK`), `register()` (with `setGlobal`, the default) leaves it in place, creates none, and `score()` emits through it.

**Endpoints and auto-instrumentation.** Where traces and evaluation logs go (endpoint and protocol resolution, errors, compression, SigV4) is in [Endpoints: traces and evaluation logs](configuration.md#endpoints-traces-and-evaluation-logs). Which libraries `autoInstrument` turns on, their supported versions and the ESM load order are in [Auto-instrumentation](configuration.md#auto-instrumentation).

## `observe()`

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
| `op` | `string` | none | `gen_ai.operation.name` value. Use `Op` constants or any custom string |
| `kind` | `SpanKind` | `INTERNAL` | OTel span kind |
| `nameFrom` | `string` | none | Resolve span name dynamically from a function parameter, else from that property of an object first argument (own or inherited, such as a class getter; never an `Object.prototype` key) |

**Span naming:** When `op` is a well-known value, the span name is `"{op} {name}"` (e.g. `"invoke_agent planner"`).

**Attributes set automatically:**

| Attribute | When set |
|---|---|
| `gen_ai.operation.name` | When `op` is provided |
| `gen_ai.agent.name` | `op` is `invoke_agent` or `create_agent` only (a `chat` span, such as a traced LLM judge call, is not an agent) |
| `gen_ai.tool.name` | When `op=Op.EXECUTE_TOOL` |
| `gen_ai.tool.type` | When `op=Op.EXECUTE_TOOL` (set to `"function"`) |
| `gen_ai.input.messages` / `gen_ai.output.messages` | All ops except `execute_tool` |
| `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` | When `op=Op.EXECUTE_TOOL` |

**Changed in 0.2.0.** Without `op`, `observe()` / `withObserve()` set no GenAI attributes (no `gen_ai.operation.name`, no `gen_ai.agent.name`), as in the Python SDK, and only `invoke_agent` / `create_agent` name an agent. So a root span from `observe(fn)` no longer names the agent that `evaluate()` and inline `score()` group results under, and `listRootSpans()` does not list it. Trace the agent's entry point with `op: Op.INVOKE_AGENT`, call `markAgentRoot()` in it, or pass `agentName` to `evaluate()` / `score()` / `register()`.

Inputs are recorded as an object keyed by the function's parameter names (read from its source, so arrows compiled by tsx/esbuild such as `city=>...` work too); destructured or extra arguments are keyed `arg0`, `arg1`, ... (`_arg1` if a parameter is itself named `arg1`). The return value becomes `gen_ai.output.messages` (or `gen_ai.tool.call.result`) only when the function did not set it itself: messages set with `enrich({ outputMessages })` inside the function are kept.

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

## `withObserve()`

Block-level tracing: the TypeScript equivalent of Python's `with observe(...)` context manager. Gives direct access to the span.

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

## `Op`

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

## `enrich()`

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

## `markAgentRoot()`

Mark the active span as its trace's agent root. OpenSearch Agent Traces lists a trace by the span marked with `derived.gen_ai.is_root`. Data Prepper marks the outermost GenAI span of each trace for you (the root when it is a GenAI span, or the agent span below an HTTP handler), so you only need this to choose the span yourself. A span marked at the source wins.

```typescript
const plan = observe({ name: "planner", op: Op.INVOKE_AGENT }, async (query: string) => {
  markAgentRoot();
  // ...
});
```

Without the SDK, set the span attribute `derived.gen_ai.is_root` to `true` on the agent's span.

## `score()`

Records one evaluation result as an OTel log event with event name `gen_ai.evaluation.result`, following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/). The event carries the trace and span id of the **evaluated** span, so it joins to the trace without adding spans to it. It is exported over OTLP logs (`/v1/logs`). Data Prepper routes these events to the `otel-v1-genai-evaluation` index.

```typescript
// Inline: the evaluated span is the active span. Needs an OTel context
// manager (register() installs one on Node); otherwise pass traceId and spanId.
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

**Scores are doubles.** `gen_ai.evaluation.score.value` is a double in the OTel semantic conventions, but OTel JS encodes any whole JS number (for example `1`) as an OTLP `intValue`, and the logs API has no way to request a double. The log exporters `register()` uses re-encode whole-number `gen_ai.evaluation.score.value`, `opensearch.gen_ai.evaluation.score.min` / `.max` / `.threshold` as `doubleValue`: the OTLP/HTTP and gRPC exporters it creates, `AWSSigV4OTLPLogExporter`, and an OpenTelemetry OTLP exporter (protobuf or gRPC) you pass as `logExporter`. An OTLP/HTTP JSON exporter (`@opentelemetry/exporter-logs-otlp-http`) is left as is. With a global `LoggerProvider` you configured yourself, call `sendScoresAsDouble(exporter)` on its OTLP log exporter; otherwise whole numbers are sent as `intValue`, and an index that maps the score dynamically can store it as an integer.

```typescript
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { sendScoresAsDouble } from "@opensearch-project/genai-observability-sdk-ts";

const exporter = new OTLPLogExporter({ url: "http://localhost:4317" });
sendScoresAsDouble(exporter); // returns false, and changes nothing, for a JSON or custom exporter
```

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
| `evaluatorDescription` | `string` | `opensearch.gen_ai.evaluation.evaluator.description` | What the evaluator checks (criteria or rubric summary). Truncated to 1024 characters |
| `judgeModel` | `string` | `gen_ai.request.model` | Model used by the LLM judge |
| `judgePromptName` | `string` | `gen_ai.prompt.name` | Name of the judge prompt template |
| `judgePromptVersion` | `string` | `gen_ai.prompt.version` | Version of the judge prompt |
| `attributes` | `Record<string, unknown>` | | Extra string, number, or boolean attributes. SDK keys (`gen_ai.evaluation.*`, `opensearch.gen_ai.evaluation.*`, `error.type`, `gen_ai.response.id`, `gen_ai.conversation.id`, `gen_ai.agent.*`, `gen_ai.system_instructions`) are dropped, with one warning per key per process; the options win. The judge keys `gen_ai.request.model` and `gen_ai.prompt.*` pass through; `judgeModel` / `judgePrompt*` win over them |

`opensearch.gen_ai.evaluation.*` attributes are OpenSearch extensions for fields that are still proposals in the GenAI semantic conventions. They will move to `gen_ai.*` names when those proposals merge.

A trace-level score (only `traceId`) is never attached to a span id derived from the trace id. The OTel JS SDK only takes a trace id from a valid span context, so `register()` adds `TraceOnlyContextProcessor` to its LoggerProvider to set it; if you configure your own LoggerProvider, add `new TraceOnlyContextProcessor()` to its processors (the SDK warns once when it is missing).

**Verdicts.** OpenSearch Dashboards shows pass/fail only for a declared rule; a result without one is neutral ("Scored"). Declare the rule with `label: "pass"` / `"fail"` (explicit verdict) or `threshold` (+ `direction`). The verdict is `gen_ai.evaluation.score.label` = `pass` / `fail`, as in OTel's own examples. When `value` and `threshold` are given without a `label`, the SDK computes it: `pass` if `value >= threshold` (`maximize`) or `value <= threshold` (`minimize`), else `fail`. A `"pass"` / `"fail"` `label` wins over a computed verdict and is stored lowercase. Any other `label` (for example `"relevant"`) is stored as the label only when there is no verdict; with a threshold verdict the verdict is the label and your label is kept as `opensearch.gen_ai.evaluation.judge_label`, with a warning.

```typescript
score({ name: "answer_quality", value: 3, threshold: 4, scoreMin: 1, scoreMax: 5 }); // label=fail
score({ name: "latency_s", value: 9.2, threshold: 12, direction: "minimize" });      // label=pass
score({ name: "tool_selection", value: 1, label: "pass" });
```

## `evaluate()`

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

**Async agents and judges.** `task` and the scorers may be async. Once a task or scorer call returns a Promise (an async function, an `observe()`-wrapped one, or any function returning a thenable), `evaluate()` awaits it and returns a `Promise<BenchmarkResult>`; when all calls return plain values it returns the result directly, as above. `await evaluate(...)` works either way. Cases still run one at a time, and the scorers of a case run in order after its task.

```typescript
const judge = defineScorer(
  { name: "answer_quality", threshold: 4, scoreMin: 1, scoreMax: 5, evaluatorType: "llm_judge" },
  async (input, output): Promise<EvalScore> => {
    const { score, reason } = await callJudgeModel(input, output); // its own trace, not stamped
    return { name: "answer_quality", value: score, explanation: reason };
  },
);

const result = await evaluate({
  name: "rag-agent",
  task: async (input) => myAsyncAgent(String(input)), // e.g. withObserve(..., { op: Op.INVOKE_AGENT }, async () => ...)
  data: [{ input: "What is Python?", expected: "programming language" }],
  scores: [accuracy, judge], // sync and async mixed
});
```

A task or judge that rejects is handled like one that throws (below). The return type follows the types of `task` and `scores`: `BenchmarkResult` when all are typed synchronous, else `BenchmarkResult | Promise<BenchmarkResult>` (also for an async task, since with no data or a task that throws before it awaits there is nothing to await); `await` it, or type synchronous scorers as `SyncScorerFn`. Invalid options (an empty `runId`) throw synchronously.

Produces:
```
trace (one per case)                        the agent run, unchanged
└── root span                               + test.suite.name, test.suite.run.id, test.case.id, test.case.name
    (event) gen_ai.evaluation.result        one per score, parented to the root span, test.* ids copied
```

Each `gen_ai.evaluation.result` carries `test.suite.name`, `test.suite.run.id`, `test.case.id`, `test.case.name`, `gen_ai.agent.name` / `gen_ai.agent.version` when known, `opensearch.test.case.expected` when the case has an `expected`, and the run `metadata` (reserved keys are dropped; the score's own `metadata` and the SDK attributes win). Pass/fail/error counts are not sent: readers derive them from the results of a run. The summary `evaluate()` returns is computed locally.

**Expected output.** When a case has `expected`, every result of the case (including error results) carries it as `opensearch.test.case.expected`, cut at 8192 characters. Pass `recordExpected: false` to `evaluate()` or `new Benchmark()` to leave it out. Encoding, truncation and request size are in [Expected output](agent-evaluations.md#expected-output).

`test.suite.run.id` and `test.case.id` are proposed OTel attributes ([semantic-conventions#1262](https://github.com/open-telemetry/semantic-conventions/issues/1262), [semantic-conventions-genai#79](https://github.com/open-telemetry/semantic-conventions-genai/issues/79)); the other `test.*` names are OTel's.

**CI/CD.** Inside CI, every evaluation result (and, with `evaluate()`, the agent root spans it starts) carries the OTel `cicd.pipeline.name`, `cicd.pipeline.run.id` and `cicd.pipeline.run.url.full`, read from GitHub Actions, GitLab CI or Jenkins. Pass `ciPipeline` to set or override them. The variables read per CI system are in [CI pipeline attributes](agent-evaluations.md#ci-pipeline-attributes).

A case whose task throws (or rejects) is not scored: each declared scorer emits one error result instead, named after the scorer (its `defineScorer()` `name`, else the function name), with `error.type` set to the exception class name, no score value and no label (the exception message is not sent). The run continues. When the task creates no span, the results have no trace context. All events go to the OTLP logs endpoint; Data Prepper routes them to `otel-v1-genai-evaluation-*`, distinguished by `eventName`.

**How root spans are found.** `evaluate()` runs each task in an OTel context that carries the current case, so with a context manager (`register()` installs `AsyncLocalStorageContextManager` on Node) the case follows the task across `await`, and overlapping `evaluate()` runs stay apart. A span started in a context without a case (an in-process HTTP handler under `propagation.extract(ROOT_CONTEXT, headers)`, `context.with(ROOT_CONTEXT, ...)`, a stream or queue callback bound before the case) is attached to the case only while exactly one case runs and only when it has no local parent (no parent, or a remote one): then it is stamped and can be the case root. With overlapping runs the SDK does not guess, so start the agent inside the task's context. A background span with no parent that starts while a lone case runs (a timer) is stamped too, but a root started in the task's context wins the case trace, and children of a local span (a poller under its own span) are never stamped. When no context manager is set (for example with `setGlobal: false` and your own setup), `evaluate()` installs `AsyncLocalStorageContextManager` on Node; where none can be installed, every span is parentless, so the same rule stamps a lone run and stamps nothing for overlapping runs. `TestCaseSpanProcessor` reads the case in `onStart`: every span of the case without a parent from the same case (no parent, or a remote parent) is stamped with the `test.*` ids, and the first one becomes the trace context for that case's events. Spans started by scorers (LLM judges) are outside the case and are not stamped. `register()` adds the processor to its provider, and `evaluate()` adds it to a global OTel JS 1.x `BasicTracerProvider` if missing. With a provider that only takes processors at construction (OTel JS 2.x), add it yourself:

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
| `task` | `(input: unknown) => unknown` | Function that takes input and returns output, or a Promise of it (then `evaluate()` returns a Promise) |
| `data` | `Array<{ input, expected?, caseId?, caseName? }>` | Test cases |
| `scores` | `Array<ScorerFn \| Scorer>` | Scorer functions: `(input, output, expected)` returning, or resolving to, `EvalScore`, `EvalScore[]`, a finite `number`, or `boolean`. Anything else logs a warning and emits an error result. Sync and async scorers can be mixed. Optionally wrapped with `defineScorer()` |
| `metadata` | `Record<string, unknown>` | Copied to every `gen_ai.evaluation.result` of the run. Reserved keys are filtered, with one warning per key per process. The judge keys `gen_ai.request.model` and `gen_ai.prompt.*` are allowed; `defineScorer()` judge fields win over them |
| `runName` | `string` | `opensearch.test.suite.run.name` on every result: a readable run name, for example `"v5 with shorter prompt"`. Also a `new Benchmark()` option |
| `runDescription` | `string` | `opensearch.test.suite.run.description` on every result (cut at 1024 characters). Also a `new Benchmark()` option |
| `runId` | `string` | `test.suite.run.id` (default: generated). Use the same id from every CI shard so they report into one run, or an existing run's id to re-score it (send new results with the same run id). Empty or whitespace-only throws |
| `ciPipeline` | `Record<string, string>` | Set or override `cicd.pipeline.name` / `.run.id` / `.run.url.full` (read from the CI environment by default; nothing outside CI) |
| `recordExpected` | `boolean` | Export each case's `expected` as `opensearch.test.case.expected` (default `true`). Pass `false` if test sets hold sensitive data. Also a `new Benchmark()` option |
| `agentName` / `agentVersion` | `string` | The agent under test (`gen_ai.agent.name` / `.version`), on every result and on the agent root spans that name none. When omitted: the agent each case's root span names, else `register({ agentName, agentVersion })`. Also `new Benchmark()` options (without root spans: the `register()` default) |

Each `TestCaseResult` has `status` (`pass`, or `fail` when the case errored or failed a verdict), `resultStatus` (`pass` | `fail` | `error`), `errorType`, `durationMs`, `verdicts` (evaluation name to verdict), and the `traceId` / `spanId` of the agent root span when the task created one.

**Declaring rules.** Wrap a scorer with `defineScorer(spec, fn)` to declare its evaluation name and pass rule up front. A scorer may also return a `boolean` (a verdict) or an `EvalScore` with `label` (`"pass"` / `"fail"`), `passed`, `threshold`, `direction`, `scoreMin`, `scoreMax`, `judgeTraceId` (the LLM judge's own trace, sent as `opensearch.gen_ai.evaluation.judge.trace_id`); fields set on the `EvalScore` win over the declaration. The declaration applies only to the scorer's own results: an `EvalScore` whose `evaluator` is unset or equals the declared `evaluator`, or whose `name` is the scorer's evaluation name (`name`, else the function name). Results of other evaluators (for example `{ name: "faith", evaluator: "deepeval.faithfulness" }`) keep their own type, pass rule and judge, whether or not the scorer declares an `evaluator` (see [Judge context](agent-evaluations.md#judge-context)). `defineScorer()` and `EvalScore` also take the judge context of `score()`: `evaluatorDescription`, `judgeModel`, `judgePromptName` and `judgePromptVersion`.

**Judge prompt.** Results identify the judge prompt by `gen_ai.prompt.name` + `gen_ai.prompt.version` (`name@version`) and link the judge's run by `judgeTraceId`. The full prompt text is never put on a result event: it belongs on the judge's own LLM span as `gen_ai.system_instructions`, recorded by the judge's instrumentation or by `enrich({ systemInstructions })` inside a `withObserve()` / `observe()` judge call. See [Judge prompt](agent-evaluations.md#judge-prompt).

**Case identity.** Across runs a case is `test.suite.name` + `test.case.id`. The default case id is a hash of the input, so pass `caseId` for a stable identity. See [Data model](agent-evaluations.md#data-model) for the full suite, run, case and evaluator tree.

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

`ScorerSpec` fields: `name` (evaluation name of number/boolean results and of the error grade; default the function name), `threshold`, `direction` (default `maximize` with a threshold), `scoreMin` / `scoreMax`, `evaluator` (`opensearch.gen_ai.evaluation.evaluator.name`), `evaluatorType`. A scorer that throws or rejects, or returns (or resolves to) something other than a finite number, a boolean, an `EvalScore` or an `EvalScore[]` (for example `undefined`, `null`, `NaN` or an object without a `name`, with a warning and `error.type` = `TypeError`), emits a grade with `error.type` and no value, label or explanation under the declared `name` (else the function name), so it lands on the same evaluation as its successful results. The exception message stays in the local `scorerErrors`.

**Case status** (local `resultStatus`, not sent): `error` if the task threw or rejected, or any result errored; else `fail` if any score of the case has a `fail` verdict (a `pass` / `fail` `label`, `passed`, or `threshold` + `direction`); else `pass`. Scores with no declared rule never fail a case. The summary keeps `passCount`, `failCount` and `errorCount`.

## `Benchmark`

Upload pre-computed evaluation results from any framework. Each `log()` emits one `gen_ai.evaluation.result` event per score, parented to the evaluated agent span when `traceId` and `spanId` are given. With only `traceId`, scores are trace-level; with neither, the events have no trace context. Each result carries the `test.*` ids, the agent, `cicd.pipeline.*` in CI, and the run `metadata` plus the case `metadata` passed to `log()` (reserved keys are dropped; the score's own `metadata` and the SDK attributes win). `scores` is `{ name: value }` or an `EvalScore[]` (to declare `label` / `threshold` / bounds / `judgeTraceId`, the `evaluator` / `evaluatorType`, and the judge context: `evaluatorDescription`, `judgeModel`, `judgePromptName`, `judgePromptVersion`). `log({ evaluator, evaluatorType })` sets the default evaluator (`opensearch.gen_ai.evaluation.evaluator.name` / `.type`) for every score of the call; an `EvalScore` that sets its own wins. Scores are checked like the scores a scorer returns in `evaluate()` (`null` fields count as unset): an invalid score, `evaluator` or `evaluatorType` throws a `TypeError` and nothing of the call is emitted. With `errorType` (an errored case, for example a metric that timed out) the values are not sent, so `value`, `label` and `passed` are not checked: `log({ errorType: "TimeoutError", scores: { faithfulness: NaN } })` logs the error result. `Benchmark` stamps `test.*` and `cicd.pipeline.*` on the results only, not on agent spans. `expected` is sent on every result of the case as `opensearch.test.case.expected` (see [Expected output](agent-evaluations.md#expected-output)).

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

## `OpenSearchTraceRetriever`

Retrieves GenAI trace spans from OpenSearch. Requires `@opensearch-project/opensearch` package.

```typescript
import { OpenSearchTraceRetriever } from "@opensearch-project/genai-observability-sdk-ts";

const retriever = new OpenSearchTraceRetriever({
  host: "https://localhost:9200",
  auth: { username: "admin", password: "admin" },
  verifyCerts: false,
});

// Retrieve all spans of a conversation's traces (or of one trace, by trace ID)
const session = await retriever.getTraces("my-conversation-id");
for (const trace of session.traces) {
  for (const span of trace.spans) {
    console.log(`${span.operationName}: ${span.name} (${span.model})`);
  }
}

// List the agent roots of recent traces (for discovering traces to evaluate)
const roots = await retriever.listRootSpans({
  services: ["my-agent"],
  maxResults: 10,
});
for (const root of roots) console.log(root.traceId, root.agentName, root.agentVersion);

// Check which traces already have evaluation results
const evaluated = await retriever.findEvaluatedTraceIds(["trace-id-1", "trace-id-2"]);
// ... only results of one evaluator (and/or one evaluation name)
const mine = await retriever.findEvaluatedTraceIds(["trace-id-1"], { evaluator: "answer_quality_judge" });
```

- `getTraces(identifier, maxSpans = 1000, { maxTraces = 1000 })`: by conversation ID, every span of each trace in the conversation (the traces whose spans carry `gen_ai.conversation.id`, earliest first); otherwise by trace ID, every span of that trace. `truncated` is `true` when a limit was reached.
- `listRootSpans({ services, since, maxResults })`: the agent roots of recent traces, newest first, one per trace (up to `maxResults` traces). A root is the span marked `derived.gen_ai.is_root` (for example the agent span below an HTTP server span), or a trace root (no parent) whose `gen_ai.operation.name` is `invoke_agent` or `create_agent`; a judge's own parentless `chat` span is not listed. A trace with no parentless agent root is listed by its earliest marked span. When nothing matches, the rule is logged once (`console.info`). Indices where the marker is not mapped yet are fine.
- Each `SpanRecord` carries `agentName` and `agentVersion` (`gen_ai.agent.name`, `gen_ai.agent.version`). Pass both to `score()` when you post a result for a retrieved trace, or the result is grouped under "(no version)" on the agent page.

`findEvaluatedTraceIds()` returns the trace ids that already have a `gen_ai.evaluation.result` event in the evaluation index. Without a filter, a result from any evaluator counts; `{ evaluator }` / `{ evaluationName }` count only that evaluator's (`opensearch.gen_ai.evaluation.evaluator.name`) or that evaluation's (`gen_ai.evaluation.name`) results. A missing evaluation index (nothing sent yet) returns an empty set; any other error (auth, connection, mapping) is thrown, so a failed lookup never looks like "nothing evaluated" and never makes you re-run judges and write duplicate results.

**Constructor:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `host` | `string` | `"https://localhost:9200"` | OpenSearch endpoint |
| `index` | `string` | `"otel-v1-apm-span-*"` | Index pattern for span data |
| `evaluationIndex` | `string` | `"otel-v1-genai-evaluation*"` | Index pattern for evaluation results, used by `findEvaluatedTraceIds()` |
| `auth` | `{ username, password } \| "awsSigV4"` | none | Authentication method |
| `verifyCerts` | `boolean` | `true` | Verify TLS certificates |

## `AWSSigV4OTLPExporter`

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
