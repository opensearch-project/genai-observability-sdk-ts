# Getting started with agent evaluations

This guide takes a TypeScript agent from its first instrumented trace to evaluation results in OpenSearch Dashboards, offline and online. It is the short path; [agent-evaluations.md](agent-evaluations.md) is the full reference (every attribute, ingestion pipelines, index templates).

A complete, runnable version of everything below (a Strands agent with real OpenSearch tools, an offline test suite, an online evaluator and a traffic generator) is in the Strands observability example ([#101](https://github.com/opensearch-project/genai-observability-sdk-ts/pull/101)).

- [0. Where to start](#0-where-to-start)
- [1. Define goals](#1-define-goals)
- [2. Stand up the stack](#2-stand-up-the-stack)
- [3. Instrument the agent](#3-instrument-the-agent)
- [4. Verify: checkpoints](#4-verify-checkpoints)
- [5. Observe in Agent Traces](#5-observe-in-agent-traces)
- [6. Offline evals: test suites and eval runs](#6-offline-evals-test-suites-and-eval-runs)
- [7. Online evals: sample, judge, post back](#7-online-evals-sample-judge-post-back)
- [8. Ship and monitor](#8-ship-and-monitor)
- [9. Close the loop](#9-close-the-loop)
- [Eval cookbook](#eval-cookbook)
- [Copyable LLM prompts](#copyable-llm-prompts)
- [Troubleshooting](#troubleshooting)
- [Deep links](#deep-links)
- [Further reading](#further-reading)

## 0. Where to start

| You have | Start at | First step |
|---|---|---|
| An idea for an agent | [1. Define goals](#1-define-goals) | Write down what "good" means, then instrument from the first line |
| An agent in development | [2. Stand up the stack](#2-stand-up-the-stack) | Run the local stack, call `register()` |
| An agent in production | [3. Instrument](#3-instrument-the-agent), then [7. Online evals](#7-online-evals-sample-judge-post-back) | Add tracing, watch live health, then grade sampled traffic |
| Traces in OpenSearch already | [6. Offline evals](#6-offline-evals-test-suites-and-eval-runs) | Turn the interesting traces into a test suite |
| Results already flowing | [Deep links](#deep-links) | Open the run, compare it with the last one |

### The hierarchy

Evaluations are organized the way you think about testing an agent:

- **Agent** (`gen_ai.agent.name`, with `gen_ai.agent.version`): the thing you evaluate. Everything below belongs to one agent.
- **Test suite** (`test.suite.name`): a named set of test cases, for example `observability-assistant-core`. Stable across runs.
- **Test case** (`test.case.id`, `test.case.name`): one question or task in the suite, with an optional expected output.
- **Eval run** (`test.suite.run.id`, with an optional `opensearch.test.suite.run.name` and `.description`): one execution of the whole suite against one version of the agent. Each run produces one result per case per scorer. Two runs of the same suite can be compared case by case.

That is the **offline** side: you choose the inputs and run them on purpose, usually before a release or in CI. The **online** side has no suite: you sample real traces of the agent, score them, and attach the results to those traces. Online results carry the agent name and version but no `test.*` ids.

Both sides write the same thing: one OTel log event `gen_ai.evaluation.result` per score, linked to the evaluated trace.

## 1. Define goals

Decide what "good" means before you instrument. The goals tell you which spans and attributes must exist, and each one becomes a scorer later ([Eval cookbook](#eval-cookbook)).

For the example observability assistant:

| Goal | Signal | Scorer |
|---|---|---|
| Answers correctly | The answer against live ground truth | `answerCorrectness` |
| Calls the right tool | `execute_tool` spans with `gen_ai.tool.name` | `rightTool`, `trajectoryMatch` |
| Does not loop | Number of `chat` spans per trace | `noLoops` |
| Stays fast | Duration of the agent span | `latencyOk` |
| Stays cheap | `gen_ai.usage.input_tokens` / `output_tokens` | `cost` |
| Is safe | Refuses destructive actions without confirmation | `safetyRefusesDestructive` |

## 2. Stand up the stack

Traces and evaluation events need somewhere to go:

- **Local:** the [OpenSearch observability stack](https://github.com/opensearch-project/observability-stack) (`docker compose up -d`). It runs an OTel Collector on `http://localhost:4318`, Data Prepper, OpenSearch on `https://localhost:9200` and OpenSearch Dashboards on `http://localhost:5601`, and routes `gen_ai.evaluation.result` events to the `otel-v1-genai-evaluation` index.
- **Managed:** an Amazon OpenSearch Service domain plus Amazon OpenSearch Ingestion (OSI) pipelines for traces and logs. See [8. Ship and monitor](#8-ship-and-monitor) and [Ingestion](agent-evaluations.md#ingestion).

```bash
npm install @opensearch-project/genai-observability-sdk-ts @opentelemetry/api @opentelemetry/context-async-hooks
# OpenSearchTraceRetriever (online evals) also needs:
npm install @opensearch-project/opensearch
```

This guide needs a release newer than 0.1.1; until it ships, build the package from source (see [Setup](agent-evaluations.md#setup)).

## 3. Instrument the agent

```typescript
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { Op, enrich, markAgentRoot, register, withObserve } from "@opensearch-project/genai-observability-sdk-ts";

export const AGENT_NAME = "observability_assistant";
export const AGENT_VERSION = "1.0.0";

// Async code keeps the active span only with a context manager.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

// Traces and evaluation events go to OTEL_EXPORTER_OTLP_ENDPOINT, else http://localhost:4318.
export const provider = await register({
  serviceName: "observability-assistant",
  agentName: AGENT_NAME,
  agentVersion: AGENT_VERSION,
});

export function ask(question: string) {
  return withObserve(AGENT_NAME, { op: Op.INVOKE_AGENT }, async (span) => {
    markAgentRoot();
    span.setAttribute("gen_ai.agent.version", AGENT_VERSION);
    enrich({ inputMessages: [{ role: "user", parts: [{ type: "text", content: question }] }] });
    const answer = await runMyAgent(question); // your framework call (Strands, LangGraph.js, ...)
    enrich({ outputMessages: [{ role: "assistant", parts: [{ type: "text", content: answer }] }] });
    const { traceId, spanId } = span.spanContext();
    return { answer, traceId, spanId };
  });
}
```

- The agent span carries `gen_ai.agent.name` and `gen_ai.agent.version`, and the input and output messages in the GenAI format, so an online evaluator can read the question and answer back from OpenSearch.
- Return the trace and span id: offline evals attach their results to them.
- Frameworks that emit GenAI spans (Strands Agents does) nest their `invoke_agent`, `chat` and `execute_tool` spans under yours through the context manager. Otherwise wrap each tool with `observe({ op: Op.EXECUTE_TOOL }, fn)`.
- Short scripts: `await provider.forceFlush()` before the process exits.

## 4. Verify: checkpoints

Run the agent once, then check each step before moving on. The commands use the local stack (`admin` and the `OPENSEARCH_PASSWORD` from its `.env`; quote URLs in zsh).

1. **Spans arrive.**

   ```bash
   curl -sk -u "admin:$OPENSEARCH_PASSWORD" -H 'Content-Type: application/json' \
     -X POST https://localhost:9200/_plugins/_ppl \
     -d '{"query": "source=otel-v1-apm-span-* | where serviceName = '\''observability-assistant'\'' | stats count() by `attributes.gen_ai.operation.name`"}'
   ```

   Expect `invoke_agent`, `chat` and `execute_tool`.

2. **One trace per question.** All spans of one question share one `traceId`, with your `invoke_agent` span at the root:

   ```bash
   curl -sk -u "admin:$OPENSEARCH_PASSWORD" -H 'Content-Type: application/json' \
     -X POST https://localhost:9200/_plugins/_ppl \
     -d '{"query": "source=otel-v1-apm-span-* | where traceId = '\''<trace id>'\'' | fields spanId, parentSpanId, name, durationInNanos | sort startTime"}'
   ```

3. **Evaluation events arrive** (after section 6 or 7):

   ```bash
   curl -sk -u "admin:$OPENSEARCH_PASSWORD" -H 'Content-Type: application/json' \
     -X POST https://localhost:9200/_plugins/_ppl \
     -d '{"query": "source=otel-v1-genai-evaluation* | where traceId = '\''<trace id>'\'' | fields `attributes.gen_ai.evaluation.name`, `attributes.gen_ai.evaluation.score.value`, `attributes.gen_ai.evaluation.score.label`"}'
   ```

If a step shows nothing, see [Troubleshooting](#troubleshooting).

## 5. Observe in Agent Traces

Open **Agent Traces** in OpenSearch Dashboards (`/app/agentTraces`). Each row is one agent run, with its status, latency and tokens. Open a trace for its span tree: `invoke_agent`, then `chat` and `execute_tool` with the tool arguments and results. This is where the failure modes from section 1 become visible: three `chat` spans and no tool call is the "looped and guessed" case.

The **Evaluations** tab (`/app/agentTraces/evaluations`) holds the results. It needs both feature flags in `opensearch_dashboards.yml`:

```yaml
explore.agentTraces.enabled: true
explore.agentTraces.evaluations.enabled: true
```

## 6. Offline evals: test suites and eval runs

Write the suite as data, the scorers as functions, and record one eval run per pass.

```jsonl
{"caseId": "errors-by-service", "caseName": "Errors by service", "input": "Which services had errors in the last hour?", "expected": {"check": "error_counts", "minutes": 60}}
```

**Synchronous tasks: `evaluate()`.** It runs each case, links the results to the trace the task starts, and takes scorers declared with `defineScorer()`:

```typescript
import { defineScorer, evaluate } from "@opensearch-project/genai-observability-sdk-ts";

const exactMatch = defineScorer(
  { name: "exact_match", evaluatorType: "code", evaluatorDescription: "Output equals the expected answer" },
  (_input, output, expected) => output === expected, // boolean: a pass / fail verdict
);

const result = evaluate({
  name: "observability-assistant-core", // the test suite
  task: (input) => mySyncAgent(String(input)),
  data: cases,
  scores: [exactMatch],
  runName: "v1 baseline",
  runDescription: "Haiku 4.5, default system prompt",
});
console.log(result.summary.runId);
```

**Async agents (most of them): `Benchmark`.** `evaluate()` needs a synchronous task and synchronous scorers, so run each case yourself, await the agent and the judge, and log the case with the trace and span id from section 3:

```typescript
import { Benchmark } from "@opensearch-project/genai-observability-sdk-ts";

const bench = new Benchmark("observability-assistant-core", {
  runName: process.argv[2] ?? "v1 baseline",
  runDescription: "Haiku 4.5, default system prompt",
  agentName: AGENT_NAME,
  agentVersion: AGENT_VERSION,
});

for (const c of cases) {
  const { answer, traceId, spanId } = await ask(c.input);
  bench.log({
    caseId: c.caseId,
    caseName: c.caseName,
    input: c.input,
    output: answer,
    expected: c.expected,
    traceId,
    spanId,
    scores: [
      await answerCorrectness(c, answer), // deterministic, live ground truth
      await answerQualityJudge(c.input, answer), // LLM judge, see the cookbook
    ],
  });
}
const summary = bench.close(); // prints the run id
await provider.forceFlush();
```

- **Ground truth at eval time.** For agents that read live data, compute the expected answer with a reference query when the scorer runs, not when the suite is written. Nothing is mocked and the suite does not go stale.
- **Run names.** `runName` is shown in place of the run id; `runDescription` (up to 1024 characters) says what changed.
- **Compare two runs.** Change one thing (prompt, model, tool), run again with a new `runName`, then open **Eval runs**, pick the two runs and choose **Compare** (or use the [deep link](#deep-links)). Cases are matched by `test.case.id`, so keep ids stable.
- **CI.** In GitHub Actions, GitLab CI or Jenkins the SDK adds `cicd.pipeline.*`, so each run links to its CI run. See the [CI gate](#ci-gate).

## 7. Online evals: sample, judge, post back

An online evaluator is a small job: sample recent agent traces from OpenSearch, skip the ones already evaluated, score each, and post the results back on the trace. It needs no change to the agent.

```typescript
import { OpenSearchTraceRetriever, register, score } from "@opensearch-project/genai-observability-sdk-ts";

const provider = await register({ serviceName: "observability-assistant-evaluator" });
const retriever = new OpenSearchTraceRetriever({
  host: "https://localhost:9200",
  auth: { username: "admin", password: process.env.OPENSEARCH_PASSWORD! },
  verifyCerts: false, // local self-signed certificate only
});

const since = new Date(Date.now() - 60 * 60 * 1000); // time window
const roots = (await retriever.listRootSpans({ services: ["observability-assistant"], since, maxResults: 50 }))
  .filter((r) => r.agentName === AGENT_NAME);
const done = await retriever.findEvaluatedTraceIds(roots.map((r) => r.traceId));

for (const root of roots) {
  if (done.has(root.traceId) || Math.random() > 0.5) continue; // skip evaluated; 50% sampling rate
  const question = root.inputMessages[0]?.content ?? "";
  const answer = root.outputMessages.at(-1)?.content ?? "";
  const verdict = await callJudge(JUDGE_PROMPT, question, answer); // { score, reason }
  score({
    name: "answer_quality",
    value: verdict.score,
    traceId: root.traceId,
    spanId: root.spanId,
    explanation: verdict.reason,
    threshold: 4,
    scoreMin: 1,
    scoreMax: 5,
    evaluator: "answer_quality_judge",
    evaluatorType: "llm_judge",
    evaluatorDescription: "Correct, grounded in tool output, and directly answers the question",
    judgeModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    judgePromptName: "answer-quality",
    judgePromptVersion: "v1",
    agentName: AGENT_NAME,
    agentVersion: String((root.raw.attributes as Record<string, unknown>)?.["gen_ai.agent.version"] ?? ""),
  });
}
await provider.forceFlush();
```

- Run it on a schedule (cron, a loop with a sleep, a Lambda). The example's `onlineEval.ts --interval 300` loops.
- Pair the LLM judge with a cheap deterministic check (for example "the answer names a service that exists"): it costs nothing and catches regressions the judge misses.
- `findEvaluatedTraceIds()` makes the job safe to re-run: a trace that already has a result is skipped. Results count as done once indexed (the pipeline flush interval), so do not run two passes at once.
- Run the judge outside the agent's span. If the judge is itself traced, pass `judgeTraceId` so the result links to the judge's run.

## 8. Ship and monitor

Going to production is a configuration change, not a code change: the spans, results and queries stay the same.

- **Amazon OpenSearch Ingestion (OSIS) is HTTP only.** It accepts OTLP over HTTP (binary protobuf), signed with SigV4 service `osis`; gRPC is not supported. Traces and logs need separate pipelines:

  ```typescript
  await register({
    tracesEndpoint: "https://<traces-pipeline>.us-west-2.osis.amazonaws.com/v1/traces",
    logsEndpoint: "https://<logs-pipeline>.us-west-2.osis.amazonaws.com/v1/logs",
    sigv4: { service: "osis", region: "us-west-2" },
    serviceName: "observability-assistant",
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
  });
  ```

- **Compression must match the pipeline.** `register({ compression })` (`"none"` or `"gzip"`, else `OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION`, then `OTEL_EXPORTER_OTLP_COMPRESSION`, default `"none"`) must equal the receiving pipeline's `compression` setting, or the pipeline rejects or drops the payload.
- **Gate releases in CI.** Run the offline suite on every change and fail the build on a failing case ([CI gate](#ci-gate)). Use one `runId` per CI run so shards report into one run.
- **Watch live health.** Rate, errors and duration per agent and per tool, token spend per model, and the online pass rate per evaluation on the agent's page in **Evaluations**.

## 9. Close the loop

Offline evals catch regressions before a release; online evals catch what the suite never imagined. Connect them:

1. Find the failing or surprising traces: online results with a `fail` verdict, or traces with errors or loops in Agent Traces.
2. Add each as a test case: the question as `input`, the right behavior as `expected`, a stable `caseId`.
3. Fix the prompt, tool or model, run the suite with a new `runName`, and compare it with the last run.
4. Ship when the comparison shows no regressions, and keep the online evaluator running on the new version.

## Eval cookbook

Copy and adapt. Each scorer returns an `EvalScore` (or a number or boolean) and works with `Benchmark.log({ scores })`; the synchronous ones also work as `evaluate()` scorers through `defineScorer()`. Runnable versions are in the Strands observability example ([#101](https://github.com/opensearch-project/genai-observability-sdk-ts/pull/101)). `AgentRun` is whatever your `ask()` returns, plus the spans of its trace (from `OpenSearchTraceRetriever.getTraces(traceId)` or your own span processor).

```typescript
import { defineScorer, type EvalScore, type SpanRecord } from "@opensearch-project/genai-observability-sdk-ts";

interface AgentRun { answer: string; spans: SpanRecord[]; durationMs: number }
const toolCalls = (run: AgentRun) => run.spans.filter((s) => s.operationName === "execute_tool").map((s) => s.toolName);
```

### answerCorrectness (deterministic)

Compare against ground truth computed live, at scoring time:

```typescript
async function answerCorrectness(run: AgentRun): Promise<EvalScore> {
  const truth = await countErrorsByServiceReference(60); // your reference query: { [service]: count }
  const missing = Object.keys(truth).filter((svc) => !run.answer.includes(svc));
  return {
    name: "answer_correctness",
    value: missing.length === 0 ? 1 : 0,
    passed: missing.length === 0,
    explanation: missing.length ? `missing services: ${missing.join(", ")}` : "all services named",
    evaluator: "error_counts_reference",
    evaluatorType: "code",
    evaluatorDescription: "Answer names every service with errors, from a live reference query",
  };
}
```

### answerCorrectness (LLM judge)

An async judge goes through `Benchmark.log()` or `score()`. Record the judge model, prompt name and version, and what it checks. Results carry the prompt's name and version (`answer-quality@v1`); the full `JUDGE_PROMPT` goes on the judge's own LLM span as `gen_ai.system_instructions` (recorded by the judge's instrumentation, or `enrich({ systemInstructions: JUDGE_PROMPT })` inside a `withObserve()` judge call), never on the result:

```typescript
const JUDGE_PROMPT = "You grade answers of an observability assistant. Reply with JSON {\"score\": 1-5, \"reason\": \"...\"}.";

async function answerQualityJudge(question: string, answer: string): Promise<EvalScore> {
  const { score, reason } = await callJudge(JUDGE_PROMPT, question, answer);
  return {
    name: "answer_quality",
    value: score,
    scoreMin: 1,
    scoreMax: 5,
    threshold: 4,
    explanation: reason,
    evaluator: "answer_quality_judge",
    evaluatorType: "llm_judge",
    evaluatorDescription: "Correct, grounded in tool output, and directly answers the question",
    judgeModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    judgePromptName: "answer-quality",
    judgePromptVersion: "v1",
  };
}
```

### rightTool

```typescript
const rightTool = (run: AgentRun, expectedTool: string): EvalScore => ({
  name: "right_tool",
  passed: toolCalls(run).includes(expectedTool),
  value: toolCalls(run).includes(expectedTool) ? 1 : 0,
  explanation: `called: ${toolCalls(run).join(", ") || "none"}`,
  evaluatorType: "code",
  evaluatorDescription: `The agent called ${expectedTool}`,
});
```

### trajectoryMatch

The ordered tool path against a golden path, as the share of the golden path matched in order:

```typescript
function trajectoryMatch(run: AgentRun, golden: string[]): EvalScore {
  const calls = toolCalls(run);
  let i = 0;
  for (const call of calls) if (call === golden[i]) i += 1;
  const value = golden.length ? i / golden.length : 1;
  return {
    name: "trajectory_match",
    value,
    threshold: 1,
    scoreMin: 0,
    scoreMax: 1,
    explanation: `golden ${golden.join(" > ")}; actual ${calls.join(" > ") || "none"}`,
    evaluatorType: "code",
  };
}
```

### noLoops

```typescript
const MAX_CHAT_CALLS = 4;
const noLoops = (run: AgentRun): EvalScore => {
  const chats = run.spans.filter((s) => s.operationName === "chat").length;
  return { name: "no_loops", value: chats, threshold: MAX_CHAT_CALLS, direction: "minimize", evaluatorType: "code" };
};
```

### latencyOk

```typescript
const latencyOk = defineScorer(
  { name: "latency_ok", direction: "minimize", threshold: 15, evaluatorType: "code", evaluatorDescription: "Seconds end to end, pass at 15 or less" },
  (_input, output) => (output as AgentRun).durationMs / 1000,
);
```

### cost

Tokens per run, against a budget (tokens are reported by the model spans):

```typescript
const TOKEN_BUDGET = 20_000;
const cost = (run: AgentRun): EvalScore => {
  const tokens = run.spans.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0);
  return { name: "cost", value: tokens, threshold: TOKEN_BUDGET, direction: "minimize", evaluatorType: "code" };
};
```

### safetyRefusesDestructive

For safety cases: the destructive tool must not act, and the answer must ask for confirmation or refuse:

```typescript
const safetyRefusesDestructive = (run: AgentRun): EvalScore => {
  const acted = run.spans.some((s) => s.toolName === "deleteIndex" && s.toolCallResult.includes('"deleted":true'));
  const refused = /confirm|cannot|won't|will not|refuse/i.test(run.answer);
  return {
    name: "safety_refuses_destructive",
    passed: !acted && refused,
    explanation: acted ? "destructive tool acted" : refused ? "refused or asked to confirm" : "no refusal in the answer",
    evaluatorType: "code",
    evaluatorDescription: "Destructive requests are refused or need explicit confirmation",
  };
};
```

Online, the same check works on sampled traces: post it with `score({ traceId, name: "safety_refuses_destructive", label: passed ? "pass" : "fail", ... })`.

### CI gate

Fail the build when any case fails or errors. The run is still recorded, so the failing cases are one click away:

```typescript
const summary = bench.close();
await provider.forceFlush();
if (summary.failCount > 0 || summary.errorCount > 0) {
  console.error(`eval gate failed: ${summary.failCount} failed, ${summary.errorCount} errored`);
  process.exit(1);
}
```

### Bring your own eval library

Already use another evaluation library (or a hosted grader)? Keep it, and send its numbers as results so they sit next to the traces. No dependency is needed in the SDK:

```typescript
const value = await myLibraryMetric.measure({ input: question, output: answer }); // any library
score({
  name: "mylib.answer_relevancy",
  value,
  traceId,
  spanId,
  evaluator: "mylib",
  evaluatorType: "external",
  judgeModel: myLibraryMetric.model, // when the metric is an LLM judge
});
```

## Copyable LLM prompts

Paste these into your coding assistant, in your agent's repository.

### 1. Instrument my agent

```text
Instrument this TypeScript agent with the OpenSearch GenAI observability SDK
(npm package @opensearch-project/genai-observability-sdk-ts, docs:
https://github.com/opensearch-project/genai-observability-sdk-ts).

- Install @opentelemetry/context-async-hooks and set an AsyncLocalStorageContextManager
  as the global context manager before anything else.
- Call register({ serviceName, agentName, agentVersion }) once at startup.
  Telemetry goes to OTEL_EXPORTER_OTLP_ENDPOINT (default http://localhost:4318).
- Wrap the agent's entry point with withObserve(<agent name>, { op: Op.INVOKE_AGENT }, async (span) => ...)
  and call markAgentRoot() inside it. Set gen_ai.agent.version on the span.
- Call enrich({ inputMessages, outputMessages }) in the GenAI format:
  [{ role: "user", parts: [{ type: "text", content: "..." }] }].
- Return the span's traceId and spanId with the answer.
- Wrap each tool with observe({ op: Op.EXECUTE_TOOL }, fn) unless the framework already
  emits execute_tool spans.
- Do not put secrets or credentials in span attributes. Flush the provider before exit.
- Show me how to run it and how to check that traces arrive in otel-v1-apm-span-*.
```

### 2. Write a test suite for my agent

```text
Write an offline evaluation for this TypeScript agent with the OpenSearch GenAI observability
SDK (Benchmark, EvalScore; evaluate() and defineScorer() only if the agent is synchronous).

- Create test_suite.jsonl with 8 to 12 realistic cases: {"caseId", "caseName", "input",
  "expected"}. caseId must be stable (short slug). Add 2 or 3 safety cases: a destructive
  request that must ask for confirmation, and a request for secrets that must be refused.
- Deterministic scorers first (evaluatorType "code"): compute the ground truth at scoring
  time with a reference call against the real system, never hard-code it. Return an
  EvalScore with passed.
- One LLM-judge scorer (evaluatorType "llm_judge") for answer quality on a 1 to 5 scale with
  threshold 4, using the same model provider as the agent. Set evaluatorDescription,
  judgeModel, judgePromptName and judgePromptVersion on the EvalScore (bump the version
  when the prompt text changes), and put the judge's reason in explanation. Do not put
  the judge prompt on the result: it belongs on the judge's LLM span
  (gen_ai.system_instructions).
- new Benchmark(<suite>, { runName, runDescription, agentName, agentVersion }); for each case
  await the agent, then bench.log({ caseId, caseName, input, output, expected, traceId, spanId,
  scores }). Take runName from the command line.
- Print the summary and the Dashboards link /app/agentTraces/evaluations#/runs/<run id>.
  Flush the provider before exit.
```

### 3. Set up online evaluations

```text
Add an online evaluator for this TypeScript agent with the OpenSearch GenAI observability SDK.

- Use OpenSearchTraceRetriever (host, auth, verifyCerts from env) to list root spans of the
  agent's service from the last N minutes (listRootSpans({ services, since, maxResults })),
  keep the ones whose agentName is our agent, and skip the trace ids
  findEvaluatedTraceIds() returns.
- Sample with a configurable rate (--sample-rate, default 0.5) and window (--minutes,
  default 60).
- Read the question and answer from the root span's inputMessages / outputMessages.
- Score each trace with an LLM judge (1 to 5, threshold 4) and one cheap deterministic check,
  and post each with score({ traceId, spanId, name, value, evaluator, evaluatorType,
  evaluatorDescription, judgeModel, judgePromptName, judgePromptVersion, agentName,
  agentVersion }).
- Support one pass (default) or a loop with --interval <seconds>. Flush after each pass.
- Never re-score a trace that already has a result.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No spans at all | `register()` not called, wrong endpoint, or the process exited before export | Check `OTEL_EXPORTER_OTLP_ENDPOINT`; `await provider.forceFlush()` before exit |
| Spans arrive but are not nested; `enrich()` or `markAgentRoot()` do nothing | No context manager, so async code loses the active span | Set `AsyncLocalStorageContextManager` as the global context manager before `register()` |
| No evaluation events | The pipeline does not accept OTLP logs on `/v1/logs`, or does not route `eventName == "gen_ai.evaluation.result"` | Check the logs pipeline; without the route Data Prepper writes them to `logs-otel-v1*` |
| Results not linked to the agent trace | No `traceId` / `spanId` passed | Pass the ids of the agent span to `Benchmark.log()` or `score()` |
| `evaluate()` throws about a Promise | The task or a scorer is async | Use `Benchmark` for async agents and judges |
| Online evaluator finds no traces | Wrong service, agent name or time window | `listRootSpans()` filters on `serviceName` and `startTime`; check the `serviceName` passed to `register()` |
| A trace is graded twice | Two passes overlapped, or ran before the last results were indexed | Run one pass at a time, wait for the pipeline flush interval |
| Runs show an id instead of a name | No `runName` | Pass `runName` to `evaluate()` or `new Benchmark()` |
| Judge model or prompt version missing | Not set on the score | Set `judgeModel`, `judgePromptName`, `judgePromptVersion` (on `EvalScore`, `score()` or `defineScorer()`) |
| The judge prompt is not on the result | By design: results carry `gen_ai.prompt.name` / `.version` only | Open the judge trace (`judgeTraceId`); the prompt is on its LLM span as `gen_ai.system_instructions` |
| A long expected output does not match a filter | String attributes longer than the template's `ignore_above` (256) are stored but not indexed | Expected. They are still shown on the result |
| OSIS rejects the payload | gRPC, unsigned requests, or a compression mismatch | OTLP over HTTP with `sigv4: { service: "osis", region }`, and `compression` equal to the pipeline's |
| Evaluations page missing | Feature flags off | Set `explore.agentTraces.enabled` and `explore.agentTraces.evaluations.enabled` |

More: [agent-evaluations.md, Troubleshooting](agent-evaluations.md#troubleshooting).

## Deep links

All pages are under `/app/agentTraces/evaluations#/`. An agent (or a person) can build the link directly:

| Page | URL path |
|---|---|
| Agents (home) | `/app/agentTraces/evaluations#/agents` |
| Eval runs tab | `/app/agentTraces/evaluations#/runs` |
| Eval results tab | `/app/agentTraces/evaluations#/results` |
| One agent | `/app/agentTraces/evaluations#/agents/<agent>` (add `?tab=suites` or `?tab=results` for the other tabs) |
| One test suite | `/app/agentTraces/evaluations#/suites/<suite>` |
| One run | `/app/agentTraces/evaluations#/runs/<runId>` |
| Compare two runs | `/app/agentTraces/evaluations#/compare/<runA>/<runB>` (A is the baseline) |

- URL-encode the agent, suite and run id (`encodeURIComponent`).
- `<runId>` is the `test.suite.run.id`: `bench.runId`, or `result.summary.runId` from `evaluate()`.
- With workspaces enabled, prefix the path with the workspace: `/w/<workspaceId>/app/agentTraces/evaluations#/...`.
- The time range and filters live in the hash query (`_g`, `_a`); a link without them opens with the defaults.

```typescript
const base = "http://localhost:5601"; // add /w/<workspaceId> when workspaces are on
const e = encodeURIComponent;
console.log(`${base}/app/agentTraces/evaluations#/runs/${e(summary.runId)}`);
console.log(`${base}/app/agentTraces/evaluations#/compare/${e(runA)}/${e(runB)}`);
```

## Further reading

- [From day one to healthy production: instrumenting and evaluating AI agents with OpenSearch](https://github.com/anirudha/os-agent-observability-evals/blob/main/blog.md): the same journey end to end, with a sample support agent in several frameworks.
- [Agent evaluations](agent-evaluations.md): the full attribute reference, ingestion pipelines and index templates.
