# Runbook: evaluate an agent

Offline eval runs, online scoring of real traces, and results from other eval tools, all as `gen_ai.evaluation.result` events in OpenSearch, with the TypeScript SDK. Each step names the example that shows it. The full guide, with the hierarchy (agent, test suite, test case, eval run), scorer recipes and deep links, is [docs/getting-started-evaluations.md](../../docs/getting-started-evaluations.md) (steps 1, 6 to 9); the attribute reference is [docs/agent-evaluations.md](../../docs/agent-evaluations.md).

Before you start: the agent is traced ([runbooks/tracing.md](tracing.md)) and the stack routes evaluation events to the `otel-v1-genai-evaluation` alias (the observability stack does). `register()` sends the results over OTLP logs (`/v1/logs`) next to the traces; pass `agentName` and `agentVersion` to it so every result names the agent. Online evals also need `npm install @opensearch-project/opensearch`. Commands assume `OPENSEARCH_PASSWORD` is exported.

## 1. Write the test suite

One case per line, with a stable case id (Compare matches cases by it) and an expected output. The travel assistant's suite is [`shared/test_suite.jsonl`](../shared/test_suite.jsonl); the observability assistant's are [`end-to-end/strands-observability-agent/test_suite.jsonl`](../end-to-end/strands-observability-agent/test_suite.jsonl) and `safety_suite.jsonl`.

## 2. Write scorers

A scorer is `(input, output, expected) => ...` returning a `boolean` (a verdict), a number or an `EvalScore`, or a Promise of one (an async LLM judge). Declare the rule with `defineScorer({ name, threshold, direction }, fn)` so Dashboards shows pass / fail; without one a result is only "Scored".

- Deterministic checks first (`evaluatorType: "code"`): tool called, data used, latency, tokens. Compute the truth when you score, not by hand: [end-to-end/.../offlineEval.ts](../end-to-end/strands-observability-agent/offlineEval.ts).
- One LLM judge (`evaluatorType: "llm_judge"`) with `judgeModel`, `judgePromptName`, `judgePromptVersion` and `evaluatorDescription`, the judge's reason in `explanation`. The judge prompt is not stored on the result: trace the judge call in its own trace as a `chat` span (so it is not listed as an agent), record the prompt there with `enrich({ systemInstructions })`, and link it with `judgeTraceId`: [end-to-end/.../judge.ts](../end-to-end/strands-observability-agent/judge.ts), [evals/native](../evals/native/).

## 3. Run an offline eval: `evaluate()`

```typescript
import { Op, defineScorer, evaluate, register, withObserve } from "@opensearch-project/genai-observability-sdk-ts";

const provider = await register({ serviceName: "travel-assistant-evals-native", agentName: "travel_assistant", agentVersion: "1.0.0" });

const mentionsCity = defineScorer(
  { name: "mentions_city", evaluatorType: "code", evaluatorDescription: "The plan names the city" },
  (input, output) => String(output).includes(String(input).split(" ").at(-1)!.replace(".", "")),
);

// An async LLM judge: evaluate() awaits it. It runs after the agent, as its own trace.
const planQuality = defineScorer(
  { name: "plan_quality", threshold: 4, scoreMin: 1, scoreMax: 5, evaluatorType: "llm_judge", judgeModel: JUDGE_MODEL_ID },
  async (input, output, expected) => judgePlan(String(input), String(expected), String(output)), // returns an EvalScore
);

const result = await evaluate({
  name: "travel-assistant",              // test suite (test.suite.name), stable across runs
  task: (input) => withObserve("travel_assistant", { op: Op.INVOKE_AGENT }, () => plan(String(input))), // async agent
  data: cases.map((c) => ({ input: c.input, expected: c.expected, caseId: c.id, caseName: c.name })),
  scores: [mentionsCity, planQuality],
  runName: "v1 prompt",                  // shown in place of the run id
  runDescription: "Claude Haiku 4.5, default prompt",
});
console.log(result.summary.runId);
await provider.shutdown();
```

Each case's agent run is its own trace with `test.suite.*` and `test.case.*` on the root span; each score is one result parented to it. Trace the task (as above): an untraced task records results with no trace to link to. Change one thing (prompt, model, tool) and run again with a new `runName` to have two runs to compare.

The task and the scorers may be sync or async. With an async one, `evaluate()` returns a Promise: `await` it. A scorer that throws records an evaluator error result for that case (no value, no label); the other scorers still run.

Results computed somewhere else (a run that already happened, another tool) go up with `Benchmark`, passing the agent span's ids:

```typescript
import { Benchmark } from "@opensearch-project/genai-observability-sdk-ts";

const bench = new Benchmark("travel-assistant", { runName: "v1 prompt", runDescription: "Claude Haiku 4.5" });
for (const r of pastRuns) {
  bench.log({
    caseId: r.caseId,
    input: r.input,
    output: r.answer,
    traceId: r.traceId, // the ids of the agent's invoke_agent span
    spanId: r.spanId,
    scores: r.scores, // EvalScore[] (or { name: value })
  });
}
bench.close(); // prints the summary
await provider.forceFlush();
```

Shown in: [evals/native](../evals/native/) (runs over the shared suite), [end-to-end/strands-observability-agent](../end-to-end/strands-observability-agent/) (`offlineEval.ts --run-name ...`), [basics/06_retrieval_and_eval.ts](../basics/06_retrieval_and_eval.ts), [basics/07_benchmarks.ts](../basics/07_benchmarks.ts).

## 4. Score production traffic online: `score()` with retrieval

```typescript
import { OpenSearchTraceRetriever, register, score } from "@opensearch-project/genai-observability-sdk-ts";

const provider = await register({ serviceName: "travel-assistant-evaluator" });
const retriever = new OpenSearchTraceRetriever({
  host: "https://localhost:9200",
  auth: { username: "admin", password: process.env.OPENSEARCH_PASSWORD! },
  verifyCerts: false, // local self-signed certificate only
});

const since = new Date(Date.now() - 60 * 60 * 1000);
const roots = (await retriever.listRootSpans({ services: ["travel-assistant-evals-native"], since, maxResults: 50 }))
  .filter((r) => !("test.suite.run.id" in ((r.raw.attributes ?? {}) as Record<string, unknown>))); // skip offline runs
const done = await retriever.findEvaluatedTraceIds(roots.map((r) => r.traceId), { evaluator: "travel_plan_judge" });

for (const root of roots.filter((r) => !done.has(r.traceId))) {
  const verdict = await judge(root.inputMessages[0]?.content ?? "", root.outputMessages.at(-1)?.content ?? "");
  score({
    name: "plan_quality",
    value: verdict.score,
    explanation: verdict.reason,
    threshold: 4, scoreMin: 1, scoreMax: 5,
    evaluator: "travel_plan_judge",
    evaluatorType: "llm_judge",
    judgeTraceId: verdict.judgeTraceId,
    traceId: root.traceId,
    spanId: root.spanId,
    agentName: root.agentName,
    agentVersion: root.agentVersion || undefined,
  });
}
await provider.shutdown();
```

- `listRootSpans()` returns each trace's agent root, the row Agent Traces lists, with its GenAI messages, `agentName` and `agentVersion`. Pass both to `score()`, or the result is grouped under "(no version)".
- `findEvaluatedTraceIds(ids, { evaluator })` makes the job safe to re-run. A result counts once it is indexed, so do not run two passes at once.
- Skip the offline runs (root spans with `test.suite.run.id`) and sample the rest. Run the evaluator as its own service, so its judge spans stay apart from the agent's.

Shown in: [evals/native](../evals/native/), [end-to-end/strands-observability-agent](../end-to-end/strands-observability-agent/) (`traffic.ts`, then `onlineEval.ts`), [basics/02_scoring.ts](../basics/02_scoring.ts) (span, trace and standalone results).

## 5. Bring results from an eval library

Keep your tool and send its numbers: return them from an `evaluate()` scorer (results get the suite, case and run ids), log them with `new Benchmark(...).log(...)` when the run already happened, or `score()` them onto a trace:

```typescript
score({
  name: "mylib.answer_relevancy",
  value: await myLibraryMetric.measure({ input: question, output: answer }),
  evaluator: "mylib",
  evaluatorType: "external",
  traceId,
  spanId,
});
```

The eval-library integrations (DeepEval, RAGAS, MLflow, pytest) are Python libraries: see the [Python SDK examples](https://github.com/opensearch-project/genai-observability-sdk-py/tree/main/examples). Their results land in the same index as this SDK's and show up on the same pages. Pre-computed results without a library: [basics/07_benchmarks.ts](../basics/07_benchmarks.ts).

## 6. Verify the results

Results by evaluation and run name for your agent:

```bash
curl -sk -u admin:"$OPENSEARCH_PASSWORD" -X POST https://localhost:9200/_plugins/_ppl \
  -H 'Content-Type: application/json' \
  -d '{"query": "source=otel-v1-genai-evaluation | where `attributes.gen_ai.agent.name` = '\''travel_assistant'\'' | stats count() by `attributes.gen_ai.evaluation.name`, `attributes.opensearch.test.suite.run.name`"}'
```

Look for one row per evaluation and run; online results have no run name (null). If nothing arrived but spans did, the logs path is missing: check the collector's `otelcol_receiver_accepted_log_records` counter on `http://localhost:8888/metrics`, and that results did not land in `logs-otel-v1-*` instead (the Data Prepper route on `eventName`). Results with an empty `traceId` came from an untraced task or a `score()` without ids.

Then open **Evaluations** at `http://localhost:5601/app/agentTraces/evaluations` (it needs `explore.agentTraces.evaluations.enabled: true`):

- **Agents**: `travel_assistant` with its versions; its page shows online and offline results over time and its test suites.
- **Eval runs**: your runs by name. Open one for each case's expected value, scores and judge explanation, and click through to the agent trace. **Compare with run before** shows two runs case by case.
- **Eval results**: every result, filterable by evaluation, version and verdict. The **Online** source filter shows the `score()` results.

Direct links: `#/runs/<runId>` (`result.summary.runId` or `bench.runId`), `#/compare/<runA>/<runB>`, `#/agents/<agent>`; see [Deep links](../../docs/getting-started-evaluations.md#deep-links).

## 7. Close the loop

When an online result fails, open its trace, add the question as a new case with a stable case id, fix the agent, and run the suite again with a new `runName`. Compare: the new case should pass and nothing else should regress.
