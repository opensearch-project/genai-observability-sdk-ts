# Agent evaluations with the OpenSearch GenAI SDK for TypeScript

This guide covers the full path of an evaluation result: what the SDK sends, how to score agents online and offline, how to ingest the results into OpenSearch with Data Prepper or Amazon OpenSearch Ingestion, and how to check that they arrived.

- [Data model](#data-model)
- [What gets stored](#what-gets-stored)
- [Setup](#setup)
- [Online evaluation](#online-evaluation)
- [Offline evaluation](#offline-evaluation)
- [Ingestion](#ingestion)
- [Verify](#verify)
- [Troubleshooting](#troubleshooting)

New to agent evaluations? Start with [Getting started with agent evaluations](getting-started-evaluations.md).

Agent evaluations are experimental. Attribute names and index mappings may change before a stable release.

## Data model

Offline results are organized as suite, run and case. Each evaluator produces one `gen_ai.evaluation.result` event per case; the agent's input and output stay in the agent's own trace.

```
Test suite  "travel-planner-golden"                 test.suite.name
 └─ Run      run_20261105_215438_5df57445           test.suite.run.id  (one execution of the suite)
     └─ Case  "Plan a trip to Lisbon"               test.case.id / test.case.name
         ├─ Input      "Plan 3 days in Lisbon under $1,000"   → the agent's trace
         ├─ Expected   "Itinerary with flights + hotel ≤ $1,000"  → opensearch.test.case.expected
         ├─ Output     the agent's actual answer                  → the agent's trace
         └─ Evaluators run on (input, output, expected, trace):
              ├─ answer_quality   score 4/5, pass   → 1 result event
              ├─ budget_respected pass               → 1 result event
              └─ safety           pass               → 1 result event
```

Where each part is stored:

- Suite, run and case ids, the expected output and the scores are attributes of every result event of the case, in the evaluation index (`otel-v1-genai-evaluation`).
- Input and output are never put on result events. They are in the agent's trace (span index), which the result links to by `traceId` / `spanId`.
- The judge's own LLM call is a separate trace, linked by `opensearch.gen_ai.evaluation.judge.trace_id`. Its full prompt is on that judge span, not on the result (see [Judge prompt](#judge-prompt)).

Case identity:

- Across runs, a case is `test.suite.name` + `test.case.id`. Within a run, it is `test.suite.run.id` + `test.case.id`.
- The default `test.case.id` is the first 16 hex characters of the SHA-256 of the JSON-encoded input. Editing the input therefore makes a new case. Pass `caseId` (an `evaluate()` data item field or `Benchmark.log({ caseId })`) to keep a case's identity stable when you edit its input.
- Online results (`score()` on live traffic) have no suite, run or case.

## What gets stored

Each score is one OpenTelemetry log event named `gen_ai.evaluation.result`, as defined by the [OTel GenAI events conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/). The SDK creates no spans for evaluations. The event is a LogRecord sent over OTLP logs (`/v1/logs`) with:

- `eventName` = `gen_ai.evaluation.result`, severity INFO, no body, all data in attributes.
- The trace context of the evaluated span (`traceId` + `spanId`), or only the `traceId` for a trace-level result, or no trace context for a session-level result or a case whose task started no span.
- Instrumentation scope `opensearch-genai-observability-sdk-ts` with the SDK version.

Attributes (each is set only when it has a value):

| Attribute | Status | Set by | Meaning |
|---|---|---|---|
| `gen_ai.evaluation.name` | OTel | all | Metric name, for example `relevance` |
| `gen_ai.evaluation.score.value` | OTel | all | Numeric score |
| `gen_ai.evaluation.score.label` | OTel | all | Label. `pass` / `fail` (lowercase) is the verdict and always wins |
| `opensearch.gen_ai.evaluation.judge_label` | OpenSearch | all | The judge's own label (for example `relevant`) when the result also has a verdict |
| `gen_ai.evaluation.explanation` | OTel | all | Evaluator rationale, up to 500 characters |
| `error.type` | OTel | all | The evaluator or the task failed; no value or label |
| `gen_ai.agent.name` | OTel | all | Agent under evaluation |
| `gen_ai.agent.version` | OTel | all | Its version |
| `gen_ai.conversation.id` | OTel | `score()` | Evaluated session |
| `gen_ai.response.id` | OTel | `score()` | Evaluated completion |
| `test.suite.name` | OTel | offline | Benchmark name, stable across runs |
| `test.suite.run.id` | proposed OTel | offline | One run of the benchmark |
| `test.case.id` | proposed OTel | offline | One case of the dataset |
| `test.case.name` | OTel | offline | Readable case name |
| `cicd.pipeline.name` | OTel | offline, in CI | CI workflow or job |
| `cicd.pipeline.run.id` | OTel | offline, in CI | CI run id |
| `cicd.pipeline.run.url.full` | OTel | offline, in CI | Link to the CI run |
| `opensearch.gen_ai.evaluation.level` | OpenSearch | all | `span`, `trace`, `session` or `tool_call` |
| `opensearch.gen_ai.evaluation.evaluator.name` | OpenSearch | `score()`, `evaluate()` | Evaluator name |
| `opensearch.gen_ai.evaluation.evaluator.version` | OpenSearch | `score()` | Evaluator version |
| `opensearch.gen_ai.evaluation.evaluator.type` | OpenSearch | `score()`, `evaluate()` | `llm_judge`, `code`, `human` or `external` |
| `opensearch.gen_ai.evaluation.score.min` | OpenSearch | all | Lower bound of the scale |
| `opensearch.gen_ai.evaluation.score.max` | OpenSearch | all | Upper bound of the scale |
| `opensearch.gen_ai.evaluation.score.threshold` | OpenSearch | all | Pass threshold |
| `opensearch.gen_ai.evaluation.score.direction` | OpenSearch | all | `maximize` or `minimize` |
| `opensearch.gen_ai.evaluation.judge.trace_id` | OpenSearch | all | Trace of the judge's own run |
| `opensearch.gen_ai.evaluation.evaluator.description` | OpenSearch | all | What the evaluator checks (criteria or rubric summary) |
| `gen_ai.request.model` | OTel | all | Model used by the LLM judge |
| `gen_ai.prompt.name` | OTel | all | Name of the judge prompt template |
| `gen_ai.prompt.version` | OTel | all | Version of the judge prompt (`name@version` identifies the prompt) |
| `opensearch.test.suite.run.name` | OpenSearch | offline | Human-readable run name, for example `v5 with shorter prompt` |
| `opensearch.test.suite.run.description` | OpenSearch | offline | Free text about the run, up to 1024 characters |
| `opensearch.test.case.expected` | OpenSearch | offline | Expected output of the case, up to 32768 characters |
| `opensearch.test.case.expected_truncated` | OpenSearch | offline | `true` when the expected output was cut |

- Result events never carry the judge's system prompt (`gen_ai.system_instructions`): it goes on the judge's own LLM span. See [Judge prompt](#judge-prompt).
- "OTel" names are in the OTel semantic conventions registry. `test.suite.run.id` and `test.case.id` are proposed in [semantic-conventions#1262](https://github.com/open-telemetry/semantic-conventions/issues/1262) and [semantic-conventions-genai#79](https://github.com/open-telemetry/semantic-conventions-genai/issues/79).
- `opensearch.gen_ai.evaluation.*` names mirror the OTel `gen_ai.evaluation.*` names for fields OTel does not define yet.
- "offline" means `evaluate()` and `Benchmark.log()`. `score()` sets the `test.*` and `opensearch.test.case.*` keys only if you pass them in `attributes`.
- Run and case metadata you pass are added to the events too. Metadata cannot set `test.suite.*`, `test.case.*`, `cicd.pipeline.*`, `error.type`, `opensearch.test.case.*` or `opensearch.test.suite.run.*`: those keys are dropped with a warning.

## Setup

```bash
npm install "@opensearch-project/genai-observability-sdk-ts@>=0.2.0"
```

This guide needs `@opensearch-project/genai-observability-sdk-ts@>=0.2.0`. Earlier releases record scores as span events instead of `gen_ai.evaluation.result` log events, and have no `logsEndpoint`, `tracesEndpoint` or `sigv4` options. Until 0.2.0 is on npm, build the package from source.

Call `register()` once at startup. It sets up the OTLP traces pipeline and the OTLP logs pipeline that carries the evaluation events. `agentName` and `agentVersion` become `gen_ai.agent.name` and `gen_ai.agent.version` on every result, unless a call names another agent or the evaluated span names its own.

```typescript
import { register } from "@opensearch-project/genai-observability-sdk-ts";

const provider = await register({
  endpoint: "http://localhost:4318", // OTLP base URL for traces and logs (the default)
  serviceName: "travel-agent",
  agentName: "travel_planner",
  agentVersion: "v3",
});

// Short scripts: flush before the process exits, or the last batch is lost.
await provider.forceFlush();
```

Endpoints: each signal (traces, and logs for the evaluation events) is resolved the same way, following the OTel exporter spec. See the [README](../README.md#endpoints-traces-and-evaluation-logs) for details. There are no port options: the port is part of each URL.

- Endpoint (code options always win over env vars): `tracesEndpoint` / `logsEndpoint` (full URL), else `endpoint` (base URL) + `/v1/traces` or `/v1/logs` over HTTP, as-is over gRPC, else `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (full URL), else `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL, same rule), else `http://localhost:4318` (`http://localhost:4317` over gRPC). For example `register({ endpoint: "http://collector:4318" })` sends logs to `http://collector:4318/v1/logs` even when `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set.
- `endpoint` is always a base URL: a path ending in `/v1/traces` or `/v1/logs` throws. `tracesEndpoint` and `logsEndpoint` must be passed together (`logExporter` stands in for `logsEndpoint`), else `register()` throws.
- Protocol: `protocol`, else a `grpc://` / `grpcs://` scheme on a URL passed in code, else `OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL`, else `OTEL_EXPORTER_OTLP_PROTOCOL`, else the URL scheme. Over gRPC, logs go to the same host and port as traces, and `headers` are sent as gRPC metadata with lowercased keys. OTLP/HTTP is always binary protobuf (`application/x-protobuf`): OTLP/JSON hex ids are corrupted by Data Prepper and OSIS, so `protocol: "http/json"` throws. gRPC is for a local OTel Collector (default `localhost:4317`) or a self-hosted Data Prepper, whose OTLP sources accept framed gRPC natively; OSIS does not support it.
- Compression: `compression: "none" | "gzip"`, else `OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION`, else `OTEL_EXPORTER_OTLP_COMPRESSION`, else none. It must match the pipeline: OSIS accepts only none or gzip and the client must use the pipeline's `compression`.
- Request size: OSIS `otel_*` sources cap requests at 1 MB to 4 MB (1 MB by default with the persistent buffer). For large GenAI spans, lower `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`.

Pick the setup that matches your ingestion (see [Ingestion](#ingestion) for the pipelines):

(a) Local OTel Collector or the observability stack: nothing to set, or `endpoint: "http://localhost:4318"`.

```typescript
await register({ serviceName: "travel-agent", agentName: "travel_planner" });
```

(b) One OSIS or Data Prepper `otlp` source serving `/<pipeline>/v1/traces` and `/<pipeline>/v1/logs`: pass the base, path prefix included. For OSIS, sign with SigV4 service `osis`:

```typescript
await register({
  endpoint: "https://<host>/<pipeline>",
  sigv4: { service: "osis", region: "us-east-1" }, // OSIS only
  agentName: "travel_planner",
  agentVersion: "v3",
});
```

(c) Separate `otel_trace_source` and `otel_logs_source` pipelines: pass both full URLs. On Data Prepper the default ports are 21890 (traces) and 21892 (logs); set `path:` on each source and `unframed_requests: true`, and `ssl: false` for `http://` or a CA your process trusts (`NODE_EXTRA_CA_CERTS`) for `https://`. On OSIS, add `sigv4: { service: "osis", region }`.

```typescript
await register({
  tracesEndpoint: "http://data-prepper:21890/v1/traces",
  logsEndpoint: "http://data-prepper:21892/v1/logs",
  agentName: "travel_planner",
  agentVersion: "v3",
});
```

If you configure OpenTelemetry yourself instead of calling `register()`, set a global `LoggerProvider` with an OTLP log exporter and add `TraceOnlyContextProcessor` to it, or the events are dropped (and trace-level results lose their trace id).

## Online evaluation

Use `score()` to grade live traffic: a judge, a code check or user feedback, run in your service or in a separate job.

### Levels

```typescript
import { score, withObserve, Op } from "@opensearch-project/genai-observability-sdk-ts";

// Span level: pass the ids of the evaluated span (works after the span ended).
const ids = withObserve("travel_planner", { op: Op.INVOKE_AGENT }, (span) => span.spanContext());
score({
  name: "relevance",
  value: 0.92,
  traceId: ids.traceId,
  spanId: ids.spanId,
  evaluator: "relevance_judge",
  evaluatorType: "llm_judge",
});

// Trace level: only the trace id. No span id is derived.
score({ name: "helpfulness", value: 4, scoreMin: 1, scoreMax: 5, traceId: ids.traceId });

// Session level: gen_ai.conversation.id, with level "session".
score({ name: "goal_completed", value: 1, label: "pass", conversationId: "session-456", level: "session", evaluatorType: "human" });
```

The level defaults to `trace` with only `traceId`. Pass `level` to set it (`span`, `trace`, `session`, `tool_call`).

Without `traceId`, `score()` evaluates the active span. `register()` installs no OTel context manager, so there is no active span unless you install one (for example `AsyncLocalStorageContextManager` from `@opentelemetry/context-async-hooks`). Passing the ids works either way.

### Pass rules and who decides

The verdict is `gen_ai.evaluation.score.label` = `pass` or `fail`. Your code decides it; OpenSearch Dashboards shows the stored label and never computes one. Two ways:

```typescript
import { score } from "@opensearch-project/genai-observability-sdk-ts";

const traceId = "6ebb9835f43af1552f2cebb9f5165e39";

// 1. A threshold: the SDK writes the label. direction defaults to "maximize".
score({ name: "answer_quality", value: 3, threshold: 4, scoreMin: 1, scoreMax: 5, traceId }); // label = fail
score({ name: "latency_s", value: 9.2, threshold: 12, direction: "minimize", traceId }); // label = pass

// 2. The judge's own verdict. A pass / fail label (any case) wins over the threshold.
score({ name: "faithfulness", value: 0.4, label: "fail", explanation: "Claims a hotel the tool did not return", traceId });
```

A result with neither a `pass` / `fail` label nor a threshold is neutral: Dashboards shows it as "Scored". Other labels (for example `relevant`) are not verdicts:

- Without a verdict, the label is stored as `gen_ai.evaluation.score.label`.
- With a verdict (a threshold, or `passed` on an offline `EvalScore`), the verdict wins: `gen_ai.evaluation.score.label` is `pass` / `fail` and the judge's label moves to `opensearch.gen_ai.evaluation.judge_label`. The SDK logs a warning once per evaluation name.

So the stored label always matches the local case status of `evaluate()` and `Benchmark`.

### Scales and evaluators

- `scoreMin` / `scoreMax` record the scale (`opensearch.gen_ai.evaluation.score.min` / `.max`), so a 1 to 5 judge and a 0 to 1 check can be read side by side.
- `evaluator`, `evaluatorVersion` and `evaluatorType` name the evaluator (`opensearch.gen_ai.evaluation.evaluator.*`). The instrumentation scope is always the SDK.
- `attributes` adds your own keys. Keys the SDK sets (`gen_ai.evaluation.*`, `opensearch.gen_ai.evaluation.*`, `error.type`, `gen_ai.response.id`, `gen_ai.conversation.id`, `gen_ai.agent.*`, `gen_ai.request.model`, `gen_ai.prompt.name` / `.version`, `gen_ai.system_instructions`) are dropped with a warning; use the `score()` options for them.

### Judge context

Record how an LLM judge graded, so a reader can tell two judge setups apart:

| Option | Attribute |
|---|---|
| `evaluatorDescription` | `opensearch.gen_ai.evaluation.evaluator.description`: what the evaluator checks |
| `judgeModel` | `gen_ai.request.model`: the judge model |
| `judgePromptName` | `gen_ai.prompt.name`: the judge prompt template |
| `judgePromptVersion` | `gen_ai.prompt.version`: its version |

They are `score()` options and `defineScorer()` fields (also `EvalScore` fields, which win over the declaration). There is no option for the judge's full system prompt: see [Judge prompt](#judge-prompt).

```typescript
import { score } from "@opensearch-project/genai-observability-sdk-ts";

score({
  name: "helpfulness",
  value: 4,
  scoreMin: 1,
  scoreMax: 5,
  threshold: 4,
  traceId: "6ebb9835f43af1552f2cebb9f5165e39",
  evaluator: "helpfulness_judge",
  evaluatorType: "llm_judge",
  evaluatorDescription: "Rates whether the answer is grounded in the tool results",
  judgeModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  judgePromptName: "helpfulness_judge",
  judgePromptVersion: "2",
});
```

### Judge prompt

Results identify the judge prompt by name and version: `gen_ai.prompt.name` and `gen_ai.prompt.version` (shown as `name@version`). Bump the version whenever the prompt text changes, so two prompt versions are never mixed under one label.

The full prompt text is never put on a result event. It belongs on the judge's own LLM call span as `gen_ai.system_instructions`, its OTel location, so it is stored once per judge call, next to the judge's input and output. The SDK does not create the judge's LLM span: the judge's instrumentation records it there (most GenAI instrumentations do, often behind a content-capture opt-in, because a prompt may hold sensitive data). If you trace the judge yourself, set it with `enrich({ systemInstructions })` inside the judge call, and pass the judge's trace id to the result: The judge span is a `chat` span: it carries no `gen_ai.agent.name`, so Agent Traces does not list the judge as an agent.

```typescript
import { Op, enrich, score, withObserve } from "@opensearch-project/genai-observability-sdk-ts";

const JUDGE_PROMPT = "You grade answers of a travel agent. Score 1 to 5. Reply with JSON.";

const { value, judgeTraceId } = withObserve("answer_quality_judge", { op: Op.CHAT }, (span) => {
  enrich({ model: "claude-haiku-4-5", systemInstructions: JUDGE_PROMPT }); // on the judge span
  const value = 4; // call your judge model with JUDGE_PROMPT here
  return { value, judgeTraceId: span.spanContext().traceId };
});

score({
  name: "answer_quality",
  value,
  traceId: "6ebb9835f43af1552f2cebb9f5165e39",
  threshold: 4,
  scoreMin: 1,
  scoreMax: 5,
  evaluatorType: "llm_judge",
  judgeModel: "claude-haiku-4-5",
  judgePromptName: "answer-quality",
  judgePromptVersion: "v2",
  judgeTraceId,
});
```

### Judge trace and errors

If the judge itself is traced, pass its trace id so the result links to the judge's run:

```typescript
import { score, withObserve, Op } from "@opensearch-project/genai-observability-sdk-ts";

const judge = withObserve("judge relevance", { op: Op.CHAT }, (span) => ({
  value: 0.8, // call your judge model here
  traceId: span.spanContext().traceId,
}));

score({
  name: "relevance",
  value: judge.value,
  traceId: "6ebb9835f43af1552f2cebb9f5165e39",
  spanId: "89829115c2128845",
  judgeTraceId: judge.traceId,
  evaluator: "relevance_judge",
  evaluatorType: "llm_judge",
});
```

If the evaluator fails, record an error result: `error.type` set, no value and no label.

```typescript
import { score } from "@opensearch-project/genai-observability-sdk-ts";

score({
  name: "relevance",
  traceId: "6ebb9835f43af1552f2cebb9f5165e39",
  spanId: "89829115c2128845",
  errorType: "TimeoutError",
  evaluator: "relevance_judge",
});
```

## Offline evaluation

Offline evaluation runs a dataset through the agent (`evaluate()`) or uploads results you already have (`Benchmark`). Each case gets `test.suite.name`, `test.suite.run.id`, `test.case.id`, `test.case.name` and, when given, the expected output.

### evaluate()

`evaluate()` calls your task once per case. Each call is its own trace, like production; the SDK adds no span around it and stamps the `test.*` ids on the root span the task starts. Each scorer result becomes one `gen_ai.evaluation.result` parented to that root span.

```typescript
import { evaluate, defineScorer, observe, register, withObserve, Op, type EvalScore } from "@opensearch-project/genai-observability-sdk-ts";

const provider = await register({ serviceName: "travel-agent", agentName: "travel_planner", agentVersion: "v3" });

const travelPlanner = observe({ name: "travel_planner", op: Op.INVOKE_AGENT }, (question: string) =>
  question.includes("France") ? "Paris" : "I do not know",
);

const exactMatch = defineScorer(
  { name: "exact_match", threshold: 1, scoreMin: 0, scoreMax: 1, evaluatorType: "code" },
  (_input, output, expected) => (output === expected ? 1 : 0),
);

const quality = defineScorer({ name: "answer_quality", evaluatorType: "llm_judge" }, (): EvalScore =>
  withObserve("judge answer_quality", { op: Op.CHAT }, (span) => ({
    name: "answer_quality",
    value: 4, // call your judge model here
    threshold: 4,
    scoreMin: 1,
    scoreMax: 5,
    explanation: "Correct and concise",
    judgeTraceId: span.spanContext().traceId,
  })),
);

const result = evaluate({
  name: "travel-capitals",
  task: (input) => travelPlanner(String(input)),
  data: [
    { input: "Capital of France?", expected: "Paris", caseId: "fr", caseName: "France" },
    { input: "Capital of Peru?", expected: "Lima", caseId: "pe", caseName: "Peru" },
  ],
  scores: [exactMatch, quality],
  metadata: { "app.variant": "v3-prompt-b" },
});

await provider.forceFlush();
if (result.summary.failCount || result.summary.errorCount) process.exitCode = 1;
```

- A scorer receives `(input, output, expected)` and synchronously returns a finite number, a boolean (a verdict), an `EvalScore` or an `EvalScore[]`. Anything else (`undefined`, `null`, `NaN`, a Promise, an object without a `name`) logs a warning and emits an error result with `error.type` = `TypeError`.
- `defineScorer(spec, fn)` declares the evaluation name, `threshold`, `direction`, `scoreMin`, `scoreMax`, `evaluator` and `evaluatorType`. Fields set on a returned `EvalScore` win.
- `EvalScore.judgeTraceId` sets `opensearch.gen_ai.evaluation.judge.trace_id`, in `evaluate()` and in `Benchmark.log()`.
- Scorers run outside the agent trace, so a traced judge gets its own trace.
- The task must be synchronous and cases run one at a time: the TypeScript SDK installs no context manager. An async task is reported as an error. See [How root spans are found](../README.md#evaluate).

### Benchmark

Use `Benchmark` to upload results from another harness (RAGAS, DeepEval, Vitest, your own). Pass `traceId` and `spanId` of the agent run to link each result to its trace.

```typescript
import { Benchmark } from "@opensearch-project/genai-observability-sdk-ts";

const b = new Benchmark("travel-capitals", { agentName: "travel_planner", agentVersion: "v3" });
b.log({
  input: "Capital of France?",
  output: "Paris",
  expected: "Paris",
  caseId: "fr",
  caseName: "France",
  scores: [
    { name: "exact_match", value: 1, threshold: 1, scoreMin: 0, scoreMax: 1 },
    { name: "answer_quality", value: 3, threshold: 4, scoreMin: 1, scoreMax: 5 },
  ],
  traceId: "6ebb9835f43af1552f2cebb9f5165e39",
  spanId: "89829115c2128845",
});
b.log({ input: "Capital of Peru?", expected: { city: "Lima" }, scores: { exact_match: 0 } });
const summary = b.close();
```

`scores` is `{ name: value }` or an `EvalScore[]`. `Benchmark` creates no spans, and it stamps the `test.*` and `cicd.pipeline.*` ids only on the results, not on the agent's spans (only `evaluate()` stamps the spans it starts).

Name the evaluator of each score with `evaluator` / `evaluatorType` on the `EvalScore` (`opensearch.gen_ai.evaluation.evaluator.name` / `.type`, the same keys `evaluate()` and `defineScorer()` write), or pass `evaluator` / `evaluatorType` to `Benchmark.log()` as the default for every score of that call; an `EvalScore` that sets its own wins. Without either, the result has no evaluator name, as before.

```typescript
b.log({
  input: question,
  output: answer,
  scores: [{ name: "answer_relevancy", value: 0.9, threshold: 0.7 }],
  evaluator: "deepeval.answer_relevancy",
  evaluatorType: "llm_judge",
  traceId, // from ask() below
  spanId,
});
```

To link each result to its agent run, run the agent inside `withObserve()` with `Op.INVOKE_AGENT` and return the span ids with the answer. Without `traceId` and `spanId` the results are not linked to a trace, so the run page has no trace link and the result shows no agent input or output.

```typescript
import { Op, withObserve } from "@opensearch-project/genai-observability-sdk-ts";

async function ask(question: string) {
  return withObserve("my_agent", { op: Op.INVOKE_AGENT }, async (span) => {
    const answer = await myAgent(question); // your agent call
    const { traceId, spanId } = span.spanContext();
    return { answer, traceId, spanId };
  });
}

const { answer, traceId, spanId } = await ask("Capital of France?");
```

### Expected output

The `expected` value of an `evaluate()` case, or `Benchmark.log({ expected })`, is set on every `gen_ai.evaluation.result` of that case (error results included) as `opensearch.test.case.expected`:

- Strings are kept as-is. Other values are JSON-encoded with `JSON.stringify` (compact, non-ASCII kept), for example `{"city":"Lima"}`.
- Values longer than 32768 characters are cut to 32768 and `opensearch.test.case.expected_truncated` is set to `true`. The index stores the whole value and shows it on the result; only values up to 256 characters are indexed for filters (see [Evaluation index](#evaluation-index)).
- `undefined` and `null` send neither key.
- It is not put on the agent's spans, and online `score()` never sets it.
- It is exported by default. If your test sets hold sensitive data, pass `recordExpected: false` to `evaluate()` or `new Benchmark()`: neither `opensearch.test.case.expected` nor `opensearch.test.case.expected_truncated` is then written. The value is still on the local result.

### Run ids

`runId` sets `test.suite.run.id` and is used exactly as given. Without it the SDK generates one (`run_<timestamp>_<random>`). Empty or whitespace-only values throw.

- CI shards: pass the same `runId` from every shard so they report into one run.
- Re-scoring: send new results with an existing run's id to add them to that run. Earlier results stay (see [Re-imports](#d-re-imports-duplicate-results)).

```typescript
import { Benchmark } from "@opensearch-project/genai-observability-sdk-ts";

const runId = `travel-capitals-${process.env.GITHUB_RUN_ID ?? "local"}`;
const b = new Benchmark("travel-capitals", { runId });
```

### Run names

`runName` sets `opensearch.test.suite.run.name` and `runDescription` sets `opensearch.test.suite.run.description` on every result of the run, in `evaluate()` and `new Benchmark()`. Both are optional: without a name, readers show the short run id. The description is cut at 1024 characters.

```typescript
const b = new Benchmark("observability-assistant", {
  runName: "v5 with shorter prompt",
  runDescription: "Shorter system prompt, same tools and model",
});
```

### CI pipeline attributes

Inside CI, every result gets `cicd.pipeline.name`, `cicd.pipeline.run.id` and `cicd.pipeline.run.url.full`, and `evaluate()` also stamps them on the agent root spans it starts (`Benchmark` only on results). Outside CI nothing is added.

| CI system | Detected by | `cicd.pipeline.name` | `cicd.pipeline.run.id` | `cicd.pipeline.run.url.full` |
|---|---|---|---|---|
| GitHub Actions | `GITHUB_ACTIONS=true` | `GITHUB_WORKFLOW` | `GITHUB_RUN_ID` | `GITHUB_SERVER_URL/GITHUB_REPOSITORY/actions/runs/GITHUB_RUN_ID` |
| GitLab CI | `GITLAB_CI=true` | `CI_PIPELINE_NAME` | `CI_PIPELINE_ID` | `CI_PIPELINE_URL` |
| Jenkins | `JENKINS_URL` and `BUILD_ID` | `JOB_NAME` | `BUILD_ID` | `BUILD_URL` |

For another CI system pass `ciPipeline: { "cicd.pipeline.run.id": "...", ... }` to `evaluate()` or `new Benchmark()`.

### Errors

- The task throws (`evaluate()`): the case is not scored. Each scorer emits one error result under its evaluation name with `error.type` = the exception class name, no value, no label and no explanation. The run continues.
- A scorer throws: one error result with `error.type` = the exception class name, no value, no label and no explanation. The message can carry URLs, keys or request bodies, so it stays in the local `scorerErrors`.
- `Benchmark.log({ errorType: "TimeoutError", scores: [...] })`: every listed score is sent as an error result.

### Local summary

The summary is computed in your process and is not sent. `evaluate()` prints it and returns a `BenchmarkResult`; `Benchmark.close()` prints and returns the `BenchmarkSummary`.

- `BenchmarkSummary`: `benchmarkName`, `runId`, `runName` (when given), `totalCases`, `passCount`, `failCount`, `errorCount`, `durationMs`, and `scores` (per name: `avg`, `min`, `max`, `count`).
- `TestCaseResult` (`result.cases`): `caseId`, `caseName`, `input`, `output`, `expected`, `scores`, `verdicts`, `resultStatus`, `status`, `error`, `errorType`, `scorerErrors`, `durationMs`, and `traceId` / `spanId` of the agent root span.
- Case `resultStatus`: `error` if the task or a scorer threw; else `fail` if any score has a `fail` verdict; else `pass`.

## Ingestion

Evaluation events arrive on the OTLP logs path, mixed with your application logs. Route by the OTLP event name: only events with `eventName == "gen_ai.evaluation.result"` go to the evaluation index, and only there (the logs route excludes them, so a result is never stored twice). Routing matches the event name field, not an `event.name` attribute; matching that attribute is a documented follow-up. OpenSearch Dashboards finds the results through the index pattern `otel-v1-genai-evaluation*`.

### Evaluation index

Results are written to the alias `otel-v1-genai-evaluation`. Create the index template, the ISM policy and the first index once per cluster, for example in Dashboards Dev Tools, before the first result arrives. The automatic option, the experimental Data Prepper [`index_type: genai-evaluation-plain`](#automatic-option-index_type-genai-evaluation-plain), creates all of this itself; the manual steps here are for Data Prepper versions without it and for other pipelines.

1. The index template. A composable template, `"version": 1`, priority 100, for the indices `otel-v1-genai-evaluation-*`. Installs from this guide and from Data Prepper use the same name and version, so they converge: Data Prepper does not overwrite an existing template with the same name and version.

<details>
<summary>otel-v1-genai-evaluation-index-template</summary>

```json
PUT _index_template/otel-v1-genai-evaluation-index-template
{
  "version": 1,
  "index_patterns": [
    "otel-v1-genai-evaluation-*"
  ],
  "priority": 100,
  "template": {
    "settings": {
      "plugins.index_state_management.rollover_alias": "otel-v1-genai-evaluation"
    },
    "mappings": {
      "date_detection": false,
      "_source": {
        "enabled": true
      },
      "dynamic_templates": [
        {
          "long_resource_attributes": {
            "mapping": {
              "type": "long"
            },
            "path_match": "resource.attributes.*",
            "match_mapping_type": "long"
          }
        },
        {
          "double_resource_attributes": {
            "mapping": {
              "type": "double"
            },
            "path_match": "resource.attributes.*",
            "match_mapping_type": "double"
          }
        },
        {
          "string_resource_attributes": {
            "mapping": {
              "type": "keyword",
              "ignore_above": 256
            },
            "path_match": "resource.attributes.*",
            "match_mapping_type": "string"
          }
        },
        {
          "long_scope_attributes": {
            "mapping": {
              "type": "long"
            },
            "path_match": "instrumentationScope.attributes.*",
            "match_mapping_type": "long"
          }
        },
        {
          "double_scope_attributes": {
            "mapping": {
              "type": "double"
            },
            "path_match": "instrumentationScope.attributes.*",
            "match_mapping_type": "double"
          }
        },
        {
          "string_scope_attributes": {
            "mapping": {
              "type": "keyword",
              "ignore_above": 256
            },
            "path_match": "instrumentationScope.attributes.*",
            "match_mapping_type": "string"
          }
        },
        {
          "long_attributes": {
            "mapping": {
              "type": "long"
            },
            "path_match": "attributes.*",
            "match_mapping_type": "long"
          }
        },
        {
          "double_attributes": {
            "mapping": {
              "type": "double"
            },
            "path_match": "attributes.*",
            "match_mapping_type": "double"
          }
        },
        {
          "string_attributes": {
            "mapping": {
              "type": "keyword",
              "ignore_above": 256
            },
            "path_match": "attributes.*",
            "match_mapping_type": "string"
          }
        }
      ],
      "properties": {
        "droppedAttributesCount": {
          "type": "integer"
        },
        "instrumentationScope": {
          "properties": {
            "droppedAttributesCount": {
              "type": "integer"
            },
            "schemaUrl": {
              "type": "keyword",
              "ignore_above": 256
            },
            "name": {
              "type": "keyword",
              "ignore_above": 128
            },
            "version": {
              "type": "keyword",
              "ignore_above": 64
            }
          }
        },
        "resource": {
          "properties": {
            "droppedAttributesCount": {
              "type": "integer"
            },
            "schemaUrl": {
              "type": "keyword",
              "ignore_above": 256
            }
          }
        },
        "severity": {
          "properties": {
            "number": {
              "type": "integer"
            },
            "text": {
              "type": "keyword",
              "ignore_above": 32
            }
          }
        },
        "body": {
          "type": "text"
        },
        "@timestamp": {
          "type": "date_nanos"
        },
        "time": {
          "type": "date_nanos"
        },
        "observedTime": {
          "type": "date_nanos"
        },
        "traceId": {
          "type": "keyword",
          "ignore_above": 32
        },
        "spanId": {
          "type": "keyword",
          "ignore_above": 16
        },
        "flags": {
          "type": "long"
        },
        "attributes": {
          "properties": {
            "gen_ai": {
              "properties": {
                "evaluation": {
                  "properties": {
                    "score": {
                      "properties": {
                        "value": {
                          "type": "double"
                        }
                      }
                    },
                    "explanation": {
                      "type": "text"
                    }
                  }
                },
                "agent": {
                  "properties": {
                    "version": {
                      "type": "keyword",
                      "ignore_above": 256
                    }
                  }
                },
                "prompt": {
                  "properties": {
                    "version": {
                      "type": "keyword",
                      "ignore_above": 256
                    }
                  }
                }
              }
            },
            "opensearch": {
              "properties": {
                "gen_ai": {
                  "properties": {
                    "evaluation": {
                      "properties": {
                        "score": {
                          "properties": {
                            "min": {
                              "type": "double"
                            },
                            "max": {
                              "type": "double"
                            },
                            "threshold": {
                              "type": "double"
                            }
                          }
                        },
                        "evaluator": {
                          "properties": {
                            "version": {
                              "type": "keyword",
                              "ignore_above": 256
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            "test": {
              "properties": {
                "case": {
                  "properties": {
                    "id": {
                      "type": "keyword",
                      "ignore_above": 256
                    }
                  }
                },
                "suite": {
                  "properties": {
                    "run": {
                      "properties": {
                        "id": {
                          "type": "keyword",
                          "ignore_above": 256
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

</details>

2. The ISM policy: roll over at 50 GB or after 24 hours, never delete (add a delete state if you want retention). Its `ism_template` attaches it to every new `otel-v1-genai-evaluation-*` index.

```json
PUT _plugins/_ism/policies/otel-v1-genai-evaluation-policy
{
  "policy": {
    "description": "Rollover for GenAI evaluation results",
    "default_state": "current_write_index",
    "states": [
      {
        "name": "current_write_index",
        "actions": [
          {
            "rollover": {
              "min_size": "50gb",
              "min_index_age": "24h"
            }
          }
        ]
      }
    ],
    "ism_template": {
      "index_patterns": [
        "otel-v1-genai-evaluation-*"
      ]
    }
  }
}
```

3. The first index, with the write alias:

```json
PUT otel-v1-genai-evaluation-000001
{
  "aliases": {
    "otel-v1-genai-evaluation": {"is_write_index": true}
  }
}
```

On a backend without ISM or aliases (for example OpenSearch Serverless), skip steps 2 and 3. Install a variant of the template with the same mappings, `"index_patterns": ["otel-v1-genai-evaluation"]` and no `plugins.index_state_management.rollover_alias` setting, then create the single index `otel-v1-genai-evaluation` (`PUT otel-v1-genai-evaluation`). A manual install on serverless must use this `["otel-v1-genai-evaluation"]` pattern variant: Data Prepper skips a template with the same name and version, so it would keep a `-*` pattern template that never matches the serverless index.

How the template maps the result attributes:

- `double`: `gen_ai.evaluation.score.value`, `opensearch.gen_ai.evaluation.score.min`, `.max` and `.threshold`. Other numbers map dynamically (`long` or `double`).
- `text`: `gen_ai.evaluation.explanation` (searchable, not aggregatable).
- `keyword` (`ignore_above` 256), pinned so the first value cannot pick a numeric type: `test.case.id`, `test.suite.run.id`, `gen_ai.agent.version`, `opensearch.gen_ai.evaluation.evaluator.version`, `gen_ai.prompt.version`.
- Every other string attribute, including `opensearch.test.case.expected`, the evaluator description, the case name and the CI URL, maps to `keyword` with `ignore_above` 256: the full value is stored and shown, never rejected, and only values up to 256 characters are indexed for filters and aggregations.
- `date_detection` is off, so a date-like string stays a string.

The index keeps the default limit of 1000 fields. If your own `attributes` and metadata add many keys, raise it in the template (`"index.mapping.total_fields.limit": 2000` under `template.settings`) and on the current write index (`PUT otel-v1-genai-evaluation-000001/_settings` with the same setting).

### a) Self-managed Data Prepper

Route `gen_ai.evaluation.result` log events from the OTLP source to their own sub-pipeline and copy `time` to `@timestamp`. `unframed_requests: true` with `traces_path` and `logs_path` lets the source take plain OTLP/HTTP requests, so the SDK can send to it directly with `register({ endpoint: "http://data-prepper:21890" })` (setup (b) with an empty prefix). `ssl: false` serves plain `http://`; with TLS, make the SDK process trust the certificate (`NODE_EXTRA_CA_CERTS=/path/to/ca.pem`). The source's `compression` (default none) must match `register({ compression })`:

```yaml
otlp-pipeline:
  source:
    otlp:
      port: 21890
      ssl: false
      unframed_requests: true
      traces_path: "/v1/traces"
      logs_path: "/v1/logs"
  route:
    - evaluations: 'getEventType() == "LOG" and /eventName == "gen_ai.evaluation.result"'
    - logs: 'getEventType() == "LOG" and /eventName != "gen_ai.evaluation.result"'
    - traces: 'getEventType() == "TRACE"'
  sink:
    - pipeline:
        name: "otel-logs-pipeline"
        routes: ["logs"]
    - pipeline:
        name: "genai-evaluation-pipeline"
        routes: ["evaluations"]
    - pipeline:
        name: "otel-traces-pipeline"
        routes: ["traces"]

genai-evaluation-pipeline:
  source:
    pipeline:
      name: "otlp-pipeline"
  processor:
    - copy_values:
        entries:
          - from_key: "time"
            to_key: "@timestamp"
  sink:
    - opensearch:
        hosts: ["https://opensearch:9200"]
        username: "admin"
        password: "<password>"
        index: "otel-v1-genai-evaluation"  # the write alias (see Evaluation index)
```

`otel-logs-pipeline` and `otel-traces-pipeline` are your existing logs and traces pipelines. The sink writes to the alias, so create the [evaluation index](#evaluation-index) first; do not set `template_file` or an ISM policy on the sink.

#### Automatic option: `index_type: genai-evaluation-plain`

Experimental, not yet in a Data Prepper release: the index type is added by [opensearch-project/data-prepper#7243](https://github.com/opensearch-project/data-prepper/pull/7243) and its mappings may change. Until you run a release with it, use the manual [Evaluation index](#evaluation-index) setup above.

With `index_type: genai-evaluation-plain` the sink creates everything itself (`template_type` defaults to `index-template`):

- On backends with ISM: the composable index template `otel-v1-genai-evaluation-index-template` (version 1, priority 100, pattern `otel-v1-genai-evaluation-*`, with the rollover alias setting), the ISM policy `otel-v1-genai-evaluation-policy` (rollover at 50 GB or 24 hours), and the first index `otel-v1-genai-evaluation-000001` as the write index of the alias `otel-v1-genai-evaluation`.
- On serverless (`aws.serverless: true`): the template with the pattern `["otel-v1-genai-evaluation"]` and no ISM setting, and a plain index `otel-v1-genai-evaluation`, with no policy and no alias.
- It does not overwrite an existing template with the same name and version, so it keeps a template you installed from this guide.

The source must be `otel_logs_source` with `output_format: otel`. With the default `opensearch` output format, attributes are stored under `log.attributes.*` and the evaluation mappings do not apply. A tested pipeline:

```yaml
genai-evaluation-otlp-pipeline:
  source:
    otel_logs_source:
      port: 21892
      ssl: false
      http_path: /v1/logs
      output_format: otel
  route:
    - genai-evaluation: '/eventName == "gen_ai.evaluation.result"'
    - logs: '/eventName != "gen_ai.evaluation.result"'
  sink:
    - opensearch:
        hosts: ["https://OPENSEARCH_HOST:9200"]
        username: OPENSEARCH_USERNAME
        password: OPENSEARCH_PASSWORD
        index_type: genai-evaluation-plain
        routes: [genai-evaluation]
    - opensearch:
        hosts: ["https://OPENSEARCH_HOST:9200"]
        username: OPENSEARCH_USERNAME
        password: OPENSEARCH_PASSWORD
        index_type: log-analytics-plain
        routes: [logs]
```

This is a logs-only pipeline, so send traces to your traces pipeline and the logs here, with one full URL per signal (setup (c)): `register({ tracesEndpoint: "http://<traces-pipeline-host>:21890/v1/traces", logsEndpoint: "http://<data-prepper-host>:21892/v1/logs" })`.

### b) Amazon OpenSearch Ingestion (OSI)

OSI does not have the evaluation index type yet. Use the same routing in an OSI pipeline and create the [evaluation index](#evaluation-index) (template, ISM policy, first index with the write alias) once before ingesting.

OSI accepts OTLP/HTTP only (protobuf), signed with SigV4 service `osis`; gRPC is not supported. Use `https://` endpoints with `sigv4`. `register()` throws if `sigv4` is set and a signal resolves to gRPC (a `grpc://` / `grpcs://` URL, `protocol: "grpc"`, or a gRPC protocol env var).

1. Create the [evaluation index](#evaluation-index) on the domain: steps 1 to 3.

2. Create an OSI pipeline with an OTLP logs source. Point `register({ tracesEndpoint, logsEndpoint })` at your traces pipeline URL and this pipeline's `/v1/logs` URL (setup (c)).

```yaml
version: "2"
otel-logs-pipeline:
  source:
    otel_logs_source:
      path: "/v1/logs"
  processor:
    - copy_values:
        entries:
          - from_key: "time"
            to_key: "@timestamp"
  route:
    - evaluations: '/eventName == "gen_ai.evaluation.result"'
    - logs: '/eventName != "gen_ai.evaluation.result"'
  sink:
    - opensearch:
        hosts: ["https://search-my-domain-abc123.us-east-1.es.amazonaws.com"]
        aws:
          sts_role_arn: "arn:aws:iam::111122223333:role/osi-pipeline-role"
          region: "us-east-1"
        index: "otel-v1-genai-evaluation"  # the write alias
        routes: ["evaluations"]
    - opensearch:
        hosts: ["https://search-my-domain-abc123.us-east-1.es.amazonaws.com"]
        aws:
          sts_role_arn: "arn:aws:iam::111122223333:role/osi-pipeline-role"
          region: "us-east-1"
        index: "logs-otel-v1-%{yyyy.MM.dd}"
        routes: ["logs"]
```

Replace the host, role and region with yours. The pipeline role needs write access to the `otel-v1-genai-evaluation` alias and the logs index pattern. Routing on `eventName` needs a Data Prepper version that maps the OTLP `event_name` field to `eventName` ([opensearch-project/data-prepper#7148](https://github.com/opensearch-project/data-prepper/pull/7148)); with an older version every event goes to the `logs` route.

### c) Optional mappings you add yourself

These processors are not part of the default pipeline. Add them to `genai-evaluation-pipeline` (or the OSI pipeline) after `copy_values` if you ingest results from other producers.

**A pass/fail label for a numeric score.** For a producer that sends only `gen_ai.evaluation.score.value`, write the label from a threshold you choose, only when `gen_ai.evaluation.score.label` is absent. This example passes `helpfulness` at 0.7 or more and records the rule:

```yaml
    - add_entries:
        entries:
          - key: "/attributes/gen_ai.evaluation.score.label"
            value: "pass"
            add_when: '/attributes/gen_ai.evaluation.name == "helpfulness" and /attributes/gen_ai.evaluation.score.label == null and /attributes/gen_ai.evaluation.score.value != null and /attributes/gen_ai.evaluation.score.value >= 0.7'
          - key: "/attributes/gen_ai.evaluation.score.label"
            value: "fail"
            add_when: '/attributes/gen_ai.evaluation.name == "helpfulness" and /attributes/gen_ai.evaluation.score.label == null and /attributes/gen_ai.evaluation.score.value != null and /attributes/gen_ai.evaluation.score.value < 0.7'
          - key: "/attributes/opensearch.gen_ai.evaluation.score.threshold"
            value: 0.7
            add_when: '/attributes/gen_ai.evaluation.name == "helpfulness" and /attributes/opensearch.gen_ai.evaluation.score.threshold == null'
          - key: "/attributes/opensearch.gen_ai.evaluation.score.direction"
            value: "maximize"
            add_when: '/attributes/gen_ai.evaluation.name == "helpfulness" and /attributes/opensearch.gen_ai.evaluation.score.direction == null'
```

### d) Re-imports duplicate results

Documents get ids generated by OpenSearch; there is no dedupe key. Sending the same results twice (a retried upload, a re-run import of the same time range) stores them twice. Import each range once, and use a new `runId` for a full re-run.

## Verify

Count results per evaluation and verdict (Query Workbench or Discover, PPL):

```
source = otel-v1-genai-evaluation*
| where eventName = 'gen_ai.evaluation.result'
| stats count() by `attributes.gen_ai.evaluation.name`, `attributes.gen_ai.evaluation.score.label`
```

Results of one run:

```
source = otel-v1-genai-evaluation*
| where `attributes.test.suite.run.id` = 'travel-capitals-local'
| fields `@timestamp`, `attributes.test.case.id`, `attributes.gen_ai.evaluation.name`, `attributes.gen_ai.evaluation.score.value`, `attributes.gen_ai.evaluation.score.label`, `attributes.error.type`, `attributes.opensearch.test.case.expected`
```

In OpenSearch Dashboards, open **Agent Traces > Evaluations**. The page is behind feature flags; set both in `opensearch_dashboards.yml`:

```yaml
explore.agentTraces.enabled: true
explore.agentTraces.evaluations.enabled: true
```

## Troubleshooting

- **No events at all.** `register()` was not called, or your own OTel setup has no global `LoggerProvider`. Short scripts: `await provider.forceFlush()` before the process exits.
- **Traces arrive, results do not.** The logs endpoint points somewhere that does not accept OTLP logs (for example `endpoint` is a traces-only pipeline). Use setup (c): pass `tracesEndpoint` and `logsEndpoint`. With OSI, the logs pipeline must be a separate pipeline with an OTLP logs source. With a custom `exporter` and no logs destination, `register()` sets up no logs pipeline and warns once; pass `logsEndpoint` or `logExporter`.
- **Results have no trace link.** Pass `traceId` (and `spanId`) to `score()`; inline scoring needs an OTel context manager. In `evaluate()`, the task must start a span (for example with `observe()`) and be synchronous.
- **Results land in the logs index.** The route did not match `eventName`. Check that the route uses `/eventName == "gen_ai.evaluation.result"` and that your Data Prepper version maps the OTLP `event_name` field to `eventName` (added in opensearch-project/data-prepper#7148).
- **Field types look wrong** (strings as `text` with `.keyword` sub-fields, `time` not a date). The index was created before the index template, or the sink wrote to a plain index named `otel-v1-genai-evaluation` because the alias did not exist. Create the [evaluation index](#evaluation-index) (template, policy, first index with the alias); for an existing write index, roll it over (`POST otel-v1-genai-evaluation/_rollover`) or reindex.
- **A long `opensearch.test.case.expected` does not match a filter.** Expected: string attributes are `keyword` with `ignore_above` 256, so longer values are stored and shown but not indexed. Filter on the case id instead.
- **Mapping fails with "Limit of total fields [1000] has been exceeded".** Raise `index.mapping.total_fields.limit` as shown in [Evaluation index](#evaluation-index).
- **A run shows twice the results.** The same results were sent twice; see [Re-imports](#d-re-imports-duplicate-results).
- **No pass/fail shown.** The result has no `pass` / `fail` label. Pass `label` or `threshold`, or add the label mapping in [(c)](#c-optional-mappings-you-add-yourself).
- **Evaluations page missing.** Turn on both feature flags in [Verify](#verify).
- **Whole-number scores.** OTel JS encodes whole numbers as integers. The OTLP/HTTP log exporter that `register()` creates and `AWSSigV4OTLPLogExporter` re-encode score fields as doubles; the gRPC log exporter and your own `logExporter` send them as `intValue`. The template maps them as `double` either way.
