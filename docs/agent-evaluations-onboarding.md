# Onboarding: evaluate your agent with OpenSearch

This guide takes you from an instrumented agent to evaluation results you can read in OpenSearch Dashboards. It covers two paths:

- **Online**: sample the traces your agent already produces, judge them, and post the results back onto those traces.
- **Offline**: run a fixed test suite through the agent, score every case, and compare runs.

For the full attribute reference, ingestion pipelines and API details, see [Agent evaluations](agent-evaluations.md). For a complete, runnable agent with both paths, see [`examples/strands-observability-agent`](../examples/strands-observability-agent/).

- [How results are organized](#how-results-are-organized)
- [Before you start](#before-you-start)
- [Online path: sample, evaluate, post back](#online-path-sample-evaluate-post-back)
- [Offline path: test suites and runs](#offline-path-test-suites-and-runs)
- [Where to look in Dashboards](#where-to-look-in-dashboards)
- [Copyable LLM prompts](#copyable-llm-prompts)
- [Troubleshooting](#troubleshooting)

## How results are organized

In plain words:

- An **agent** is the thing you evaluate. It is named by `gen_ai.agent.name` and versioned by `gen_ai.agent.version` (set them once with `register({ agentName, agentVersion })`).
- A **test suite** is a fixed set of questions for that agent, for example "observability-assistant". It is `test.suite.name` and stays the same across runs.
- A **run** is one pass of the suite through one version of the agent. It has an id (`test.suite.run.id`), and optionally a readable name (`runName`, for example "v5 with shorter prompt") and a description (`runDescription`).
- A **case** is one question of the suite (`test.case.id`, `test.case.name`). Each case produces one agent trace.
- A **result** is one score on one trace: a `gen_ai.evaluation.result` event with a name (`helpfulness`), a value, and a verdict (`pass` / `fail`) when you declared a rule.

So: agents have suites, suites have runs, runs have cases, and cases have results. Online results skip the middle: they hang directly off production traces of an agent, with no suite or run.

Every result records who graded it: the evaluator name and type, and for an LLM judge the model (`judgeModel`), the prompt name and version (`judgePromptName`, `judgePromptVersion`) and what it checks (`evaluatorDescription`). The judge's system prompt is recorded only if you pass `judgeSystemInstructions`.

## Before you start

1. Send traces and logs to OpenSearch. The evaluation results are OTLP log events, so your pipeline needs both signals. The [observability stack](https://github.com/opensearch-project/observability-stack) does this out of the box on `http://localhost:4318`.
2. Install the SDK and register it at startup:

```typescript
import { register } from "@opensearch-project/genai-observability-sdk-ts";

const provider = await register({
  endpoint: "http://localhost:4318",
  serviceName: "observability-assistant",
  agentName: "observability-assistant",
  agentVersion: "v1",
});
```

3. Make sure each agent invocation is one trace with a GenAI root span (`invoke_agent ...`). Frameworks such as Strands Agents do this for you. Otherwise wrap the invocation with `observe()` / `withObserve()` and `Op.INVOKE_AGENT`.
4. Short scripts: call `await provider.forceFlush()` before exiting.

## Online path: sample, evaluate, post back

The online path grades real traffic after the fact. It needs no change to the agent.

1. **Sample.** List recent agent root spans with `OpenSearchTraceRetriever.listRootSpans({ since, maxResults })`, keep those of your agent, and drop the traces that already have a result with `findEvaluatedTraceIds()`. That makes the job safe to run on a schedule.
2. **Evaluate.** Load each trace with `getTraces(traceId)`, take the user question and the final answer from the root span (and the tool calls from its child spans), and ask a judge to grade it.
3. **Post back.** Call `score({ traceId, ... })` with the judge's verdict. With only `traceId` the result is trace-level; add `spanId` to attach it to one span.

```typescript
import { OpenSearchTraceRetriever, score } from "@opensearch-project/genai-observability-sdk-ts";

const retriever = new OpenSearchTraceRetriever({
  host: "https://localhost:9200",
  auth: { username: "admin", password: process.env.OPENSEARCH_PASSWORD! },
  verifyCerts: false,
});

const since = new Date(Date.now() - 60 * 60 * 1000);
const roots = (await retriever.listRootSpans({ since, maxResults: 50 }))
  .filter((s) => s.agentName === "observability-assistant");
const done = await retriever.findEvaluatedTraceIds(roots.map((s) => s.traceId));

for (const root of roots.filter((s) => !done.has(s.traceId))) {
  const verdict = await judge(root); // your LLM judge: { value, explanation }
  score({
    name: "helpfulness",
    value: verdict.value,
    scoreMin: 1,
    scoreMax: 5,
    threshold: 4,
    explanation: verdict.explanation,
    traceId: root.traceId,
    spanId: root.spanId,
    evaluator: "helpfulness_judge",
    evaluatorType: "llm_judge",
    evaluatorDescription: "Is the answer correct, grounded in the tool results, and useful?",
    judgeModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    judgePromptName: "helpfulness_judge",
    judgePromptVersion: "1",
  });
}
await provider.forceFlush();
```

Tips:

- Run it once from cron, or in a loop with a sleep. The skip check means a second pass only grades new traces.
- `findEvaluatedTraceIds()` reads the evaluation index, so results take a few seconds (the pipeline flush interval) to count as done. Do not run two passes at the same time.
- Keep the judge's own calls out of the agent's traces: run the judge outside the agent's span, and pass `judgeTraceId` if you trace the judge.

## Offline path: test suites and runs

The offline path runs a fixed suite before you ship, so you can compare versions.

1. **Write the suite** as data: one question per line in a JSONL file, with an id, a name, and what a good answer looks like. Add a few safety cases (requests the agent must refuse).
2. **Pick scorers.** Prefer deterministic checks where you can compute the truth (for example, count the errors yourself and compare with the agent's answer), and add an LLM judge for what code cannot check (helpfulness, tone, refusals).
3. **Run it** with a run name and description, then compare runs.

`evaluate()` takes a synchronous task. Agents are usually async, so run each case yourself and upload with `Benchmark`, passing the trace and span id of the agent's root span:

```typescript
import { Benchmark } from "@opensearch-project/genai-observability-sdk-ts";

const bench = new Benchmark("observability-assistant", {
  runName: "v1 baseline",
  runDescription: "Haiku, default system prompt, 6 read-only tools",
});

for (const c of cases) {
  const { answer, traceId, spanId } = await runAgent(c.input);
  const verdict = await judge(c.input, answer);
  bench.log({
    caseId: c.id,
    caseName: c.name,
    input: c.input,
    output: answer,
    expected: c.expected,
    traceId,
    spanId,
    scores: [
      { name: "error_count_correct", value: exactCount(answer) ? 1 : 0, passed: exactCount(answer) },
      {
        name: "helpfulness",
        value: verdict.value,
        scoreMin: 1,
        scoreMax: 5,
        threshold: 4,
        explanation: verdict.explanation,
        judgeModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        judgePromptName: "helpfulness_judge",
        judgePromptVersion: "1",
        evaluatorDescription: "Is the answer correct, grounded in the tool results, and useful?",
      },
    ],
  });
}
bench.close();
await provider.forceFlush();
```

For a synchronous task, `evaluate()` does the same in one call; declare the judge context once with `defineScorer({ name, threshold, judgeModel, judgePromptName, judgePromptVersion, evaluatorDescription }, fn)`.

Run the suite again after a change, with a new `runName`. Each run gets its own `test.suite.run.id`, and the two runs can be compared side by side.

## Where to look in Dashboards

Agent Evaluations lives at `/app/agentTraces/evaluations` in OpenSearch Dashboards. With workspaces, prefix the path with the workspace: `/w/<workspaceId>/app/agentTraces/evaluations`. The screens are addressed by the URL hash:

| Screen | URL |
|---|---|
| Agents (home, default tab) | `<dashboards>/app/agentTraces/evaluations#/agents` |
| Eval runs (every suite run) | `<dashboards>/app/agentTraces/evaluations#/runs` |
| Eval results (across agents) | `<dashboards>/app/agentTraces/evaluations#/results` |
| One agent | `<dashboards>/app/agentTraces/evaluations#/agents/<agent name>` (add `?tab=suites` or `?tab=results` for the other tabs) |
| One suite's runs | `<dashboards>/app/agentTraces/evaluations#/suites/<suite name>` |
| One run's cases | `<dashboards>/app/agentTraces/evaluations#/runs/<run id>` |
| Compare two runs | `<dashboards>/app/agentTraces/evaluations#/compare/<run A id>/<run B id>` (A is the baseline) |

URL-encode the names and ids. Filters (`_a`) and the time range (`_g`) go in the hash query, next to `tab`. For example, with workspace `abc123` and run id `run_20261105_211500_1a2b3c4d`:

```
http://localhost:5601/w/abc123/app/agentTraces/evaluations#/runs/run_20261105_211500_1a2b3c4d
```

The run id is printed by `Benchmark.close()` and `evaluate()` (`Run ID:`), and is `bench.runId`.

## Copyable LLM prompts

Paste these into your coding assistant, filling in the parts in angle brackets.

**Instrument an agent.**

```
Instrument my TypeScript agent in <file> with @opensearch-project/genai-observability-sdk-ts.
Call register() once at startup with endpoint <OTLP base URL, e.g. http://localhost:4318>,
serviceName "<service>", agentName "<agent>" and agentVersion "<version>". Make sure each user
request is one trace whose root span is an invoke_agent span (use the framework's own spans if it
emits GenAI spans, else withObserve() with Op.INVOKE_AGENT). Call provider.forceFlush() before the
process exits. Do not change the agent's behavior.
```

**Write an offline test suite.**

```
Write an offline evaluation for my agent <agent> in <file>, using the Benchmark class of
@opensearch-project/genai-observability-sdk-ts. Put 8 to 12 realistic test cases plus 2 or 3
safety cases (requests it must refuse) in a JSONL file with id, name, input and expected fields.
For each case run the agent, capture the trace id and span id of its invoke_agent root span, and
log the case with bench.log({ caseId, caseName, input, output, expected, traceId, spanId, scores }).
Use deterministic scorers that compute the ground truth live from <data source> where possible,
and one LLM judge score with judgeModel, judgePromptName, judgePromptVersion and
evaluatorDescription set. Create the Benchmark with runName and runDescription from command-line
arguments. Print the run id at the end and flush the provider.
```

**Write an online evaluator.**

```
Write an online evaluation job for my agent <agent> using @opensearch-project/genai-observability-sdk-ts.
Use OpenSearchTraceRetriever (host <OpenSearch URL>, basic auth from env) to list root spans of the
last <N> minutes, keep the ones whose agentName is "<agent>", and skip traces that
findEvaluatedTraceIds() reports as already evaluated. For each remaining trace, load it with
getTraces(traceId), extract the user question, the final answer and the tool calls, ask an LLM
judge for a 1 to 5 helpfulness score with a short explanation, and post it with
score({ traceId, spanId, name: "helpfulness", value, threshold: 4, scoreMin: 1, scoreMax: 5,
evaluator, evaluatorType: "llm_judge", judgeModel, judgePromptName, judgePromptVersion,
evaluatorDescription, explanation }). Support a single pass and a --interval <seconds> loop.
Flush after each pass.
```

**Find a run in Dashboards.**

```
Given the run id <run id> printed by my offline evaluation and my OpenSearch Dashboards URL
<dashboards URL> (workspace <workspace id, or none>), give me the Agent Evaluations links for the
run, its suite <suite name>, and a comparison with the previous run <other run id>, following
/w/<workspaceId>/app/agentTraces/evaluations#/runs/<run id>, #/suites/<suite>, #/compare/<A>/<B>.
```

## Troubleshooting

- **No results in OpenSearch.** The process exited before the batch was sent: `await provider.forceFlush()`. Or the pipeline does not accept OTLP logs on the logs endpoint; see [Agent evaluations: Troubleshooting](agent-evaluations.md#troubleshooting).
- **Results are not linked to the agent's trace.** Pass the trace id and span id of the agent's root span. Read them from the span the framework creates (for example with a span processor that remembers the `invoke_agent` root span), not from a span you start around it.
- **The online job grades the same trace twice.** It ran before the previous results were indexed, or two passes overlapped. Wait for the pipeline flush interval between passes.
- **The online job finds no traces.** Check the time window, the agent name filter, and the span index pattern (`otel-v1-apm-span-*` by default).
- **Runs show the short id instead of a name.** Pass `runName` to `new Benchmark()` or `evaluate()`.
- **The judge model or prompt version is missing.** Pass `judgeModel`, `judgePromptName` and `judgePromptVersion` on each score, or declare them once with `defineScorer()`.
- **The judge's system prompt is not stored.** It is opt-in: pass `judgeSystemInstructions`. Prompts over 8192 characters are cut and flagged with `opensearch.gen_ai.evaluation.system_instructions_truncated`.
- **The Evaluations page is missing.** Turn on `explore.agentTraces.enabled` and `explore.agentTraces.evaluations.enabled` in `opensearch_dashboards.yml`.
