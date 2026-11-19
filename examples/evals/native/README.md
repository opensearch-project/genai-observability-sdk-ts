# Native evals: offline evaluate() runs and online score()

Evaluate the travel assistant with the OpenSearch GenAI observability SDK alone, no eval
library. The agent (`agent.ts`) is the Amazon Bedrock Converse loop with the two tools over
[`../../shared/`](../../shared/), traced with the SDK.

| File | What it does |
| --- | --- |
| `agent.ts` | The agent under test. Each run is one trace: `invoke_agent travel_assistant` > `chat` / `execute_tool` |
| `scorers.ts` | `usesToolData` (deterministic) and `judgePlan` (LLM judge on Bedrock, traced as its own trace) |
| `offline.ts` | Runs the shared test suite twice with `evaluate()` (prompt `v1` and `v2`), one run name each |
| `traffic.ts` | A few agent runs outside any suite, as stand-in production traffic |
| `online.ts` | Lists recent agent traces from OpenSearch, judges the new ones, writes the scores back with `score()` |

## Offline: two runs of the suite

```bash
npm install
AWS_PROFILE=<profile> AWS_REGION=us-west-2 npx tsx offline.ts
```

Suite `travel-assistant-suite`, runs `v1 prompt` and `v2 prompt` (the v2 system prompt adds
"Reply in at most two sentences."). Each of the 5 cases gets three scores:

| Score | Evaluator | Type | Rule |
| --- | --- | --- | --- |
| `uses_tool_data` | `uses_tool_data` | `code` | names the city's weather and an event, or says there is no data (`passed`) |
| `answer_length` | `answer_length` | `code` | characters, `threshold: 500`, `direction: 'minimize'` |
| `plan_quality` | `travel_plan_judge` | `llm_judge` | 1 to 5, `threshold: 4`, with judge model, prompt name / version, description and `judgeTraceId` |

Every case is its own agent trace. Its root span carries `test.suite.name`,
`test.suite.run.id`, `test.case.id` and `test.case.name`, and each score is one
`gen_ai.evaluation.result` event parented to that span, with `opensearch.test.suite.run.name`
and the case's `expected` text.

Compare the runs in OpenSearch Dashboards: Evaluations
(`http://localhost:5601/app/agentTraces/evaluations`) > `travel-assistant-suite` > select
both runs > Compare.

### Async agent and judge

The agent and the LLM judge are async. `evaluate()` awaits an async `task` and async
scorers and then returns a Promise, so `offline.ts` is one `await evaluate({ ... })` per
prompt version, with the three scorers declared by `defineScorer()`. A judge that throws
records an evaluator error result for that case; the other scores are still sent.

For results that were scored somewhere else (a cached run, another tool), upload them
with `Benchmark.log({ traceId, spanId, scores })` instead.

## Online: judge recent traces

```bash
AWS_PROFILE=<profile> npx tsx traffic.ts
OPENSEARCH_PASSWORD=<password> AWS_PROFILE=<profile> npx tsx online.ts
```

`online.ts` uses `OpenSearchTraceRetriever`:

1. `listRootSpans({ services, since })`: agent root spans of the last hour, with their
   input and output messages.
2. `findEvaluatedTraceIds(ids, { evaluator: 'travel_plan_judge' })`: skip traces this judge
   already scored (offline cases are scored already, so only new traffic is judged).
3. `getTraces(traceId)`: the tool spans, passed to the judge as ground truth.
4. `score({ traceId, spanId, ... })`: `plan_quality` and `uses_tool_data` on the agent's root
   span. Online results have no `test.suite.run.id`; they show on the trace in Agent Traces.

The judge's own spans go to service `travel-assistant-evals-native-ts-judge`, so the next
online run does not list them.

## Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `AWS_PROFILE` / `AWS_REGION` | default chain / `us-west-2` | Bedrock credentials and region |
| `MODEL_ID` / `JUDGE_MODEL_ID` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Agent and judge models |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Where `register()` sends spans and results |
| `OPENSEARCH_URL` | `https://localhost:9200` | Cluster `online.ts` reads traces from |
| `OPENSEARCH_USER` / `OPENSEARCH_PASSWORD` | `admin` / none | Basic auth for `online.ts` |
| `OPENSEARCH_VERIFY_CERTS` | `false` | Set `true` for a cluster with a trusted certificate |

## Check the results

```bash
curl -sk -u admin:<password> "https://localhost:9200/otel-v1-genai-evaluation/_search" \
  -H 'Content-Type: application/json' -d '{
  "size": 0, "query": {"term": {"attributes.test.suite.name": "travel-assistant-suite"}},
  "aggs": {"runs": {"terms": {"field": "attributes.opensearch.test.suite.run.name"},
    "aggs": {"evals": {"terms": {"field": "attributes.gen_ai.evaluation.name"}}}}}}'
```

## Notes

- `register()` installs an `AsyncLocalStorageContextManager` on Node, so the chat and
  tool spans nest under the agent span across `await`.
- In the offline run the judge's spans are in the agent's service, as their own traces
  (one `chat` span each), so each `plan_quality` result can link to its judge call through
  `opensearch.gen_ai.evaluation.judge.trace_id`.
