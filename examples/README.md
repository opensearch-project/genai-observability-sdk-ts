# Examples

Examples for the OpenSearch GenAI observability SDK for TypeScript: tracing an agent with `register()`, and evaluating it offline (`evaluate()`, `Benchmark`) and online (`score()` on traces read back with `OpenSearchTraceRetriever`).

New here? Follow the runbooks:

- [`runbooks/tracing.md`](runbooks/tracing.md): stand up the stack, `register()`, instrument, check the spans, open Agent Traces.
- [`runbooks/evals.md`](runbooks/evals.md): offline evals, online evals, checking the results.

## The example agents

**Travel assistant** (the framework examples). A small agent that writes a short trip plan for a city. It has two tools, `get_weather(city)` and `find_events(city)`, which return fixed data from [`shared/travel_data.json`](shared/travel_data.json), so the only external call is the model. Every framework example uses the same tools, system prompt and test cases ([`shared/test_suite.jsonl`](shared/test_suite.jsonl)), so traces and scores are comparable across frameworks. Each example registers as service `travel-assistant-<framework>` and its agent is named `travel_assistant`.

**Observability assistant** (the end-to-end example). A Strands agent that answers questions about your own OpenSearch cluster (indices, errors, slow operations, traces, logs) with read-only tools. It shows the full lifecycle: tracing, two offline test suites whose ground truth is queried live, an LLM judge, online evals over sampled traces, and comparing runs in OpenSearch Dashboards.

**SDK basics.** Small scripts that show one SDK feature each, with no framework and no model calls.

## Framework and library matrix

| Framework or library | Tracing | Evals |
|---|---|---|
| Strands Agents (`@strands-agents/sdk`) | [`tracing/strands`](tracing/strands/) | [`end-to-end/strands-observability-agent`](end-to-end/strands-observability-agent/) (offline and online), [`evals/native`](evals/native/) |
| LangGraph.js (`@langchain/langgraph`) | [`tracing/langgraph`](tracing/langgraph/) | [`evals/native`](evals/native/) |
| OpenAI Agents SDK (`@openai/agents`) | [`tracing/openai-agents`](tracing/openai-agents/) | [`evals/native`](evals/native/) |
| Amazon Bedrock (AWS SDK v3 Converse) | [`tracing/bedrock`](tracing/bedrock/) | [`evals/native`](evals/native/) |
| OpenAI (`openai`) | [`tracing/openai`](tracing/openai/) | [`evals/native`](evals/native/) |
| Anthropic (`@anthropic-ai/sdk`) | [`tracing/anthropic`](tracing/anthropic/) | [`evals/native`](evals/native/) |
| No framework (SDK only) | [`basics`](basics/) (`observe()`, `enrich()`, async) | [`basics`](basics/) (`score()`, `evaluate()`, `Benchmark`), [`evals/native`](evals/native/) |

[`evals/native`](evals/native/) uses only this SDK: offline `evaluate()` over the shared test suite with an async agent and an async LLM judge, one run name per prompt version, and online `score()` on traces it reads back from OpenSearch. The approach works the same for any of the agents above.

Eval-library integrations (DeepEval, RAGAS, MLflow, pytest) are Python libraries, so they live in the [Python SDK examples](https://github.com/opensearch-project/genai-observability-sdk-py/tree/main/examples). Their results land in the same index and show up in the same Dashboards pages as the results from this SDK.

## Layout

```
examples/
  README.md        this file
  runbooks/        step-by-step guides: tracing.md, evals.md
  basics/          numbered SDK basics (01_ to 07_)
  shared/          travel_data.json and test_suite.jsonl for the travel assistant
  tracing/<name>/  one travel assistant per framework: README.md, agent.ts, package.json
  evals/native/    offline and online evals with this SDK only
  end-to-end/strands-observability-agent/   full lifecycle example
```

## Prerequisites

- Node.js 18.19+ or 20.6+.
- A place to send telemetry. Locally, the [OpenSearch observability stack](https://github.com/opensearch-project/observability-stack) (`docker compose up -d`): OTel Collector on `localhost:4318` (HTTP) and `4317` (gRPC), Data Prepper, OpenSearch on `https://localhost:9200` (user `admin`, password `OPENSEARCH_PASSWORD` from its `.env`) and OpenSearch Dashboards on `http://localhost:5601`. Spans land in `otel-v1-apm-span-*`, evaluation results in the `otel-v1-genai-evaluation` alias. See [`runbooks/tracing.md`](runbooks/tracing.md#1-stand-up-the-stack).
- Model access for the framework examples. They default to Amazon Bedrock (`AWS_PROFILE`, `AWS_REGION`, model `us.anthropic.claude-haiku-4-5-20251001-v1:0`, override with `MODEL_ID`). The OpenAI and Anthropic examples also show their own API key setup. Each README lists its env vars.

## How to run

Each folder is self-contained: it has a `README.md`, its code and a `package.json` that depends on `@opensearch-project/genai-observability-sdk-ts@^0.2.0`.

```bash
cd examples/tracing/strands          # or any other example folder
npm install
npx tsx agent.ts                     # the folder's README has the exact command
```

The Strands folders ship an `.npmrc` with `legacy-peer-deps=true`: Strands declares optional OpenTelemetry JS 2.x peers and the SDK is on 1.x, so a plain `npm install` fails with `ERESOLVE` without it.

To run against the SDK in this checkout instead of the npm release, build and pack it (`pnpm install && pnpm build && npm pack` in the repository root) and run `npm install --no-save <path to the .tgz>` in the example folder (it installs the other dependencies too).

The basics import the SDK from `../../src`, so run them from a clone of this repository: `pnpm install`, then `npx tsx examples/basics/01_tracing_basics.ts`.

Then open Agent Traces at `http://localhost:5601/app/agentTraces`, and evaluations at `http://localhost:5601/app/agentTraces/evaluations`. The runbooks show the OpenSearch queries that check the data arrived.
