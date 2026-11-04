# Agent evaluations with the OpenSearch GenAI SDK for TypeScript

This guide covers the full path of an evaluation result: what the SDK sends, how to score agents online and offline, how to ingest the results into OpenSearch with Data Prepper or Amazon OpenSearch Ingestion, and how to check that they arrived.

- [What gets stored](#what-gets-stored)
- [Setup](#setup)
- [Online evaluation](#online-evaluation)
- [Offline evaluation](#offline-evaluation)
- [Ingestion](#ingestion)
- [Verify](#verify)
- [Troubleshooting](#troubleshooting)

Agent evaluations are experimental. Attribute names and index mappings may change before a stable release.

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
| `gen_ai.evaluation.score.label` | OTel | all | Label. `pass` / `fail` is the verdict |
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
| `opensearch.test.case.expected` | OpenSearch | offline | Expected output of the case, up to 4096 characters |
| `opensearch.test.case.expected_truncated` | OpenSearch | offline | `true` when the expected output was cut |

- "OTel" names are in the OTel semantic conventions registry. `test.suite.run.id` and `test.case.id` are proposed in [semantic-conventions#1262](https://github.com/open-telemetry/semantic-conventions/issues/1262) and [semantic-conventions-genai#79](https://github.com/open-telemetry/semantic-conventions-genai/issues/79).
- `opensearch.gen_ai.evaluation.*` names mirror the OTel `gen_ai.evaluation.*` names for fields OTel does not define yet.
- "offline" means `evaluate()` and `Benchmark.log()`. `score()` sets the `test.*` and `opensearch.test.case.*` keys only if you pass them in `attributes`.
- Run and case metadata you pass are added to the events too. Metadata cannot set `test.suite.*`, `test.case.*`, `cicd.pipeline.*`, `error.type` or `opensearch.test.case.*`: those keys are dropped with a warning.

## Setup

```bash
npm install opensearch-genai-observability-sdk-ts
```

Call `register()` once at startup. It sets up the OTLP traces pipeline and the OTLP logs pipeline that carries the evaluation events. `agentName` and `agentVersion` become `gen_ai.agent.name` and `gen_ai.agent.version` on every result, unless a call names another agent or the evaluated span names its own.

```typescript
import { register } from "opensearch-genai-observability-sdk-ts";

const provider = await register({
  endpoint: "http://localhost:21890/opentelemetry/v1/traces",
  serviceName: "travel-agent",
  agentName: "travel_planner",
  agentVersion: "v3",
});

// Short scripts: flush before the process exits, or the last batch is lost.
await provider.forceFlush();
```

Endpoints:

- Traces: `endpoint`, else `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, else `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces`, else `http://localhost:21890/opentelemetry/v1/traces` (local Data Prepper).
- Logs (evaluation events): `logsEndpoint`, else `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, else the traces endpoint with `/v1/traces` replaced by `/v1/logs`. When none applies, `register()` warns and skips logs. See the [README](../README.md#endpoints-traces-and-evaluation-logs) for the full order.
- Amazon OpenSearch Ingestion has one pipeline per signal, so give the logs pipeline URL explicitly. The log exporter signs with SigV4 like the trace exporter:

```typescript
import { register, AWSSigV4OTLPExporter } from "opensearch-genai-observability-sdk-ts";

await register({
  exporter: new AWSSigV4OTLPExporter({
    endpoint: "https://traces-pipe-abc.us-east-1.osis.amazonaws.com/v1/traces",
    service: "osis",
  }),
  logsEndpoint: "https://logs-pipe-def.us-east-1.osis.amazonaws.com/v1/logs",
  agentName: "travel_planner",
  agentVersion: "v3",
});
```

If you configure OpenTelemetry yourself instead of calling `register()`, set a global `LoggerProvider` with an OTLP log exporter and add `TraceOnlyContextProcessor` to it, or the events are dropped (and trace-level results lose their trace id).

## Online evaluation

Use `score()` to grade live traffic: a judge, a code check or user feedback, run in your service or in a separate job.

### Levels

```typescript
import { score, withObserve, Op } from "opensearch-genai-observability-sdk-ts";

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
import { score } from "opensearch-genai-observability-sdk-ts";

const traceId = "6ebb9835f43af1552f2cebb9f5165e39";

// 1. A threshold: the SDK writes the label. direction defaults to "maximize".
score({ name: "answer_quality", value: 3, threshold: 4, scoreMin: 1, scoreMax: 5, traceId }); // label = fail
score({ name: "latency_s", value: 9.2, threshold: 12, direction: "minimize", traceId }); // label = pass

// 2. The judge's own label. A label you pass wins over the threshold.
score({ name: "faithfulness", value: 0.4, label: "fail", explanation: "Claims a hotel the tool did not return", traceId });
```

A result with neither a `pass` / `fail` label nor a threshold is neutral: Dashboards shows it as "Scored". Other labels (for example `relevant`) are kept as-is and are not verdicts.

### Scales and evaluators

- `scoreMin` / `scoreMax` record the scale (`opensearch.gen_ai.evaluation.score.min` / `.max`), so a 1 to 5 judge and a 0 to 1 check can be read side by side.
- `evaluator`, `evaluatorVersion` and `evaluatorType` name the evaluator (`opensearch.gen_ai.evaluation.evaluator.*`). The instrumentation scope is always the SDK.

### Judge trace and errors

If the judge itself is traced, pass its trace id so the result links to the judge's run:

```typescript
import { score, withObserve, Op } from "opensearch-genai-observability-sdk-ts";

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
import { score } from "opensearch-genai-observability-sdk-ts";

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
import { evaluate, defineScorer, observe, register, withObserve, Op, type EvalScore } from "opensearch-genai-observability-sdk-ts";

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

- A scorer receives `(input, output, expected)` and returns a number, a boolean (a verdict), an `EvalScore` or an `EvalScore[]`.
- `defineScorer(spec, fn)` declares the evaluation name, `threshold`, `direction`, `scoreMin`, `scoreMax`, `evaluator` and `evaluatorType`. Fields set on a returned `EvalScore` win.
- `EvalScore.judgeTraceId` sets `opensearch.gen_ai.evaluation.judge.trace_id`, in `evaluate()` and in `Benchmark.log()`.
- Scorers run outside the agent trace, so a traced judge gets its own trace.
- The task must be synchronous and cases run one at a time: the TypeScript SDK installs no context manager. An async task is reported as an error. See [How root spans are found](../README.md#evaluate).

### Benchmark

Use `Benchmark` to upload results from another harness (RAGAS, DeepEval, Vitest, your own). Pass `traceId` and `spanId` of the agent run to link each result to its trace.

```typescript
import { Benchmark } from "opensearch-genai-observability-sdk-ts";

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

`scores` is `{ name: value }` or an `EvalScore[]`. `Benchmark` creates no spans.

### Expected output

The `expected` value of an `evaluate()` case, or `Benchmark.log({ expected })`, is set on every `gen_ai.evaluation.result` of that case (error results included) as `opensearch.test.case.expected`:

- Strings are kept as-is. Other values are JSON-encoded with `JSON.stringify` (compact, non-ASCII kept), for example `{"city":"Lima"}`.
- Values longer than 4096 characters are cut to 4096 and `opensearch.test.case.expected_truncated` is set to `true`.
- `undefined` and `null` send neither key.
- It is not put on the agent's spans, and online `score()` never sets it.

### Run ids

`runId` sets `test.suite.run.id` and is used exactly as given. Without it the SDK generates one (`run_<timestamp>_<random>`). Empty or whitespace-only values throw.

- CI shards: pass the same `runId` from every shard so they report into one run.
- Re-scoring: send new results with an existing run's id to add them to that run. Earlier results stay (see [Re-imports](#d-re-imports-duplicate-results)).

```typescript
import { Benchmark } from "opensearch-genai-observability-sdk-ts";

const runId = `travel-capitals-${process.env.GITHUB_RUN_ID ?? "local"}`;
const b = new Benchmark("travel-capitals", { runId });
```

### CI pipeline attributes

Inside CI, results and agent root spans also get `cicd.pipeline.name`, `cicd.pipeline.run.id` and `cicd.pipeline.run.url.full`. Outside CI nothing is added.

| CI system | Detected by | `cicd.pipeline.name` | `cicd.pipeline.run.id` | `cicd.pipeline.run.url.full` |
|---|---|---|---|---|
| GitHub Actions | `GITHUB_ACTIONS=true` | `GITHUB_WORKFLOW` | `GITHUB_RUN_ID` | `GITHUB_SERVER_URL/GITHUB_REPOSITORY/actions/runs/GITHUB_RUN_ID` |
| GitLab CI | `GITLAB_CI=true` | `CI_PIPELINE_NAME` | `CI_PIPELINE_ID` | `CI_PIPELINE_URL` |
| Jenkins | `JENKINS_URL` and `BUILD_ID` | `JOB_NAME` | `BUILD_ID` | `BUILD_URL` |

For another CI system pass `ciPipeline: { "cicd.pipeline.run.id": "...", ... }` to `evaluate()` or `new Benchmark()`.

### Errors

- The task throws (`evaluate()`): the case is not scored. Each scorer emits one error result under its evaluation name with `error.type` = the exception class name, no value, no label and no explanation. The run continues.
- A scorer throws: one error result with `error.type` and the exception message as the explanation.
- `Benchmark.log({ errorType: "TimeoutError", scores: [...] })`: every listed score is sent as an error result.

### Local summary

The summary is computed in your process and is not sent. `evaluate()` prints it and returns a `BenchmarkResult`; `Benchmark.close()` prints and returns the `BenchmarkSummary`.

- `BenchmarkSummary`: `benchmarkName`, `runId`, `totalCases`, `passCount`, `failCount`, `errorCount`, `durationMs`, and `scores` (per name: `avg`, `min`, `max`, `count`).
- `TestCaseResult` (`result.cases`): `caseId`, `caseName`, `input`, `output`, `expected`, `scores`, `verdicts`, `resultStatus`, `status`, `error`, `errorType`, `scorerErrors`, `durationMs`, and `traceId` / `spanId` of the agent root span.
- Case `resultStatus`: `error` if the task or a scorer threw; else `fail` if any score has a `fail` verdict; else `pass`.

## Ingestion

Evaluation events arrive on the OTLP logs path. Route them to their own index so they do not mix with application logs. Agent Traces in OpenSearch Dashboards reads `otel-v1-genai-evaluation*` by default.

### a) Self-managed Data Prepper

Route `gen_ai.evaluation.result` log events from the OTLP source to their own sub-pipeline and copy `time` to `@timestamp`:

```yaml
otlp-pipeline:
  source:
    otlp:
      port: 21890
      ssl: false
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
        index: "otel-v1-genai-evaluation-%{yyyy.MM.dd}"
        template_type: index-template
        template_file: /usr/share/data-prepper/templates/genai-evaluation-index-template.json
```

`otel-logs-pipeline` and `otel-traces-pipeline` are your existing logs and traces pipelines. Then pick one of these sinks for `genai-evaluation-pipeline`:

1. **Works today: a daily index with your template** (shown above). Save the [index template JSON](#index-template) as the `template_file`. Instead of `template_type` and `template_file`, you can also create the template once with `PUT _index_template/otel-v1-genai-evaluation`, as in (b).
2. **Experimental: `index_type: genai-evaluation-plain`.** The Data Prepper draft [opensearch-project/data-prepper#7243](https://github.com/opensearch-project/data-prepper/pull/7243) adds this index type to the OpenSearch sink. It is not in a Data Prepper release and its mappings may change. The sink manages the template, so drop `index`, `template_type` and `template_file`:

```yaml
  sink:
    - opensearch:
        hosts: ["https://opensearch:9200"]
        username: "admin"
        password: "<password>"
        index_type: genai-evaluation-plain  # experimental
```

`genai-evaluation-plain` keeps attribute keys dotted, as `log-analytics-plain` does, has no ISM policy, and writes to one index named `otel-v1-genai-evaluation` with the sink-managed template `otel-v1-genai-evaluation-index-template`. Do not combine it with your own template that matches `otel-v1-genai-evaluation`.

### b) Amazon OpenSearch Ingestion (OSI)

OSI does not have the evaluation index type yet. Use the same pipeline shape in an OSI pipeline and create the index template once before ingesting.

1. Create the index template on the domain, for example in Dashboards Dev Tools:

```
PUT _index_template/otel-v1-genai-evaluation
<the index template JSON below>
```

2. Create an OSI pipeline with an OTLP logs source. Point `register({ logsEndpoint })` at its `/v1/logs` URL.

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
        index: "otel-v1-genai-evaluation-%{yyyy.MM.dd}"
        routes: ["evaluations"]
    - opensearch:
        hosts: ["https://search-my-domain-abc123.us-east-1.es.amazonaws.com"]
        aws:
          sts_role_arn: "arn:aws:iam::111122223333:role/osi-pipeline-role"
          region: "us-east-1"
        index: "logs-otel-v1-%{yyyy.MM.dd}"
        routes: ["logs"]
```

Replace the host, role and region with yours. The pipeline role needs write access to both index patterns. Routing on `eventName` needs a Data Prepper version that maps the OTLP `event_name` field to `eventName` ([opensearch-project/data-prepper#7148](https://github.com/opensearch-project/data-prepper/pull/7148)); with an older version every event goes to the `logs` route.

#### Index template

Used by the `template_file` in (a) and the `PUT _index_template/otel-v1-genai-evaluation` in (b). The score fields are `double`, `gen_ai.evaluation.explanation` is `text` with a `keyword` sub-field, and `opensearch.test.case.expected` is `text` without a `keyword` sub-field: searchable, not aggregatable. Other unknown string attributes map to `keyword`, other numbers to `double`. Create it before the first result arrives; an index created earlier keeps its dynamic mappings.

<details>
<summary>otel-v1-genai-evaluation index template</summary>

```json
{
  "index_patterns": ["otel-v1-genai-evaluation-*"],
  "priority": 100,
  "version": 1,
  "template": {
    "mappings": {
      "date_detection": false,
      "_source": {"enabled": true},
      "dynamic_templates": [
        {
          "long_attributes": {
            "mapping": {"type": "double"},
            "path_match": "attributes.*",
            "match_mapping_type": "long"
          }
        },
        {
          "double_attributes": {
            "mapping": {"type": "double"},
            "path_match": "attributes.*",
            "match_mapping_type": "double"
          }
        },
        {
          "string_attributes": {
            "mapping": {"type": "keyword", "ignore_above": 1024},
            "path_match": "attributes.*",
            "match_mapping_type": "string"
          }
        },
        {
          "long_resource_attributes": {
            "mapping": {"type": "long"},
            "path_match": "resource.attributes.*",
            "match_mapping_type": "long"
          }
        },
        {
          "double_resource_attributes": {
            "mapping": {"type": "double"},
            "path_match": "resource.attributes.*",
            "match_mapping_type": "double"
          }
        },
        {
          "string_resource_attributes": {
            "mapping": {"type": "keyword", "ignore_above": 256},
            "path_match": "resource.attributes.*",
            "match_mapping_type": "string"
          }
        },
        {
          "long_scope_attributes": {
            "mapping": {"type": "long"},
            "path_match": "instrumentationScope.attributes.*",
            "match_mapping_type": "long"
          }
        },
        {
          "double_scope_attributes": {
            "mapping": {"type": "double"},
            "path_match": "instrumentationScope.attributes.*",
            "match_mapping_type": "double"
          }
        },
        {
          "string_scope_attributes": {
            "mapping": {"type": "keyword", "ignore_above": 256},
            "path_match": "instrumentationScope.attributes.*",
            "match_mapping_type": "string"
          }
        }
      ],
      "properties": {
        "@timestamp": {"type": "date_nanos"},
        "time": {"type": "date_nanos"},
        "observedTimestamp": {"type": "date_nanos"},
        "traceId": {"type": "keyword", "ignore_above": 256},
        "spanId": {"type": "keyword", "ignore_above": 256},
        "flags": {"type": "long"},
        "eventName": {"type": "keyword", "ignore_above": 256},
        "severityNumber": {"type": "integer"},
        "severityText": {"type": "keyword"},
        "body": {"type": "text"},
        "serviceName": {"type": "keyword"},
        "schemaUrl": {"type": "keyword"},
        "droppedAttributesCount": {"type": "integer"},
        "instrumentationScope": {
          "properties": {
            "name": {"type": "keyword"},
            "version": {"type": "keyword"},
            "schemaUrl": {"type": "keyword"},
            "droppedAttributesCount": {"type": "integer"}
          }
        },
        "resource": {
          "properties": {"schemaUrl": {"type": "keyword"}, "droppedAttributesCount": {"type": "integer"}}
        },
        "attributes": {
          "properties": {
            "gen_ai": {
              "properties": {
                "evaluation": {
                  "properties": {
                    "name": {"type": "keyword"},
                    "explanation": {
                      "type": "text",
                      "fields": {"keyword": {"type": "keyword", "ignore_above": 256}}
                    },
                    "score": {"properties": {"value": {"type": "double"}, "label": {"type": "keyword"}}}
                  }
                },
                "conversation": {"properties": {"id": {"type": "keyword"}}},
                "agent": {"properties": {"name": {"type": "keyword"}}},
                "response": {"properties": {"id": {"type": "keyword"}}}
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
                            "min": {"type": "double"},
                            "max": {"type": "double"},
                            "threshold": {"type": "double"},
                            "direction": {"type": "keyword"}
                          }
                        },
                        "evaluator": {
                          "properties": {
                            "name": {"type": "keyword"},
                            "version": {"type": "keyword"},
                            "type": {"type": "keyword"}
                          }
                        },
                        "level": {"type": "keyword"},
                        "judge": {"properties": {"trace_id": {"type": "keyword"}}}
                      }
                    }
                  }
                },
                "test": {
                  "properties": {
                    "case": {
                      "properties": {"expected": {"type": "text"}, "expected_truncated": {"type": "boolean"}}
                    }
                  }
                }
              }
            },
            "test": {
              "properties": {
                "suite": {
                  "properties": {
                    "name": {"type": "keyword"},
                    "run": {"properties": {"id": {"type": "keyword"}}}
                  }
                },
                "case": {"properties": {"id": {"type": "keyword"}, "name": {"type": "keyword"}}}
              }
            },
            "session": {"properties": {"id": {"type": "keyword"}}},
            "error": {"properties": {"type": {"type": "keyword"}}},
            "aws": {
              "properties": {
                "bedrock_agentcore": {
                  "properties": {
                    "evaluation_level": {"type": "keyword"},
                    "online_evaluation_config": {"properties": {"name": {"type": "keyword"}, "arn": {"type": "keyword"}}},
                    "evaluator": {
                      "properties": {"arn": {"type": "keyword"}, "rating_scale": {"type": "keyword"}}
                    }
                  }
                }
              }
            },
            "cicd": {
              "properties": {
                "pipeline": {
                  "properties": {
                    "name": {"type": "keyword"},
                    "run": {
                      "properties": {
                        "id": {"type": "keyword"},
                        "url": {"properties": {"full": {"type": "keyword"}}}
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

### c) Optional mappings you add yourself

These processors are not part of the default pipeline. Add them to `genai-evaluation-pipeline` (or the OSI pipeline) after `copy_values` if you ingest results from other producers.

**AgentCore results.** Copy AgentCore's evaluation level (lowercased) to `opensearch.gen_ai.evaluation.level` and its `session.id` to `gen_ai.conversation.id`, only when those are absent. The original attributes stay.

```yaml
    - add_entries:
        entries:
          - key: "/attributes/evl_agentcore_level"
            value_expression: "/attributes/aws.bedrock_agentcore.evaluation_level"
            add_when: "/attributes/opensearch.gen_ai.evaluation.level == null and /attributes/aws.bedrock_agentcore.evaluation_level != null"
    - lowercase_string:
        with_keys: ["/attributes/evl_agentcore_level"]
    - add_entries:
        entries:
          - key: "/attributes/opensearch.gen_ai.evaluation.level"
            value_expression: "/attributes/evl_agentcore_level"
            add_when: "/attributes/evl_agentcore_level != null"
          - key: "/attributes/gen_ai.conversation.id"
            value_expression: "/attributes/session.id"
            add_when: "/attributes/gen_ai.conversation.id == null and /attributes/session.id != null"
    - delete_entries:
        with_keys: ["/attributes/evl_agentcore_level"]
```

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
- **Traces arrive, results do not.** The logs endpoint is wrong or not derived (a traces URL that does not end in `/v1/traces`, gRPC traces, a custom exporter). `register()` prints "evaluation logs are NOT exported". Set `logsEndpoint` or `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`. With OSI, the logs pipeline must be a separate pipeline with an OTLP logs source.
- **Results have no trace link.** Pass `traceId` (and `spanId`) to `score()`; inline scoring needs an OTel context manager. In `evaluate()`, the task must start a span (for example with `observe()`) and be synchronous.
- **Results land in the logs index.** The route did not match `eventName`. Check that the route uses `/eventName == "gen_ai.evaluation.result"` and that your Data Prepper version maps the OTLP `event_name` field to `eventName` (added in opensearch-project/data-prepper#7148).
- **Field types look wrong** (strings as `text` with `.keyword` sub-fields, `time` not a date). The index was created before the index template. Create the template, then wait for the next daily index or reindex.
- **`opensearch.test.case.expected` cannot be aggregated.** Expected: it is `text`. Filter or search on it instead.
- **A run shows twice the results.** The same results were sent twice; see [Re-imports](#d-re-imports-duplicate-results).
- **No pass/fail shown.** The result has no `pass` / `fail` label. Pass `label` or `threshold`, or add the label mapping in [(c)](#c-optional-mappings-you-add-yourself).
- **Evaluations page missing.** Turn on both feature flags in [Verify](#verify).
- **Whole-number scores.** OTel JS encodes whole numbers as integers. The SDK's own log exporters re-encode score fields as doubles, and the template maps them as `double` either way.
