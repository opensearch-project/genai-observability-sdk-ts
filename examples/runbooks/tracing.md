# Runbook: trace an agent

From nothing to an agent trace in Agent Traces, with the TypeScript SDK. Each step names the example that shows it. The full guide, with the reasoning behind each step, is [docs/getting-started-evaluations.md](../../docs/getting-started-evaluations.md) (steps 2 to 5).

Commands assume the local stack and `OPENSEARCH_PASSWORD` exported from its `.env`. Quote URLs that contain `?` (zsh treats it as a glob).

## 1. Stand up the stack

```bash
git clone https://github.com/opensearch-project/observability-stack
cd observability-stack && docker compose up -d
curl -sk -u admin:"$OPENSEARCH_PASSWORD" 'https://localhost:9200/_cluster/health?pretty'
```

It runs an OTel Collector (`localhost:4318` OTLP/HTTP, `localhost:4317` OTLP/gRPC), Data Prepper, OpenSearch (`https://localhost:9200`, user `admin`) and OpenSearch Dashboards (`http://localhost:5601`). Spans land in `otel-v1-apm-span-*`, evaluation results in the `otel-v1-genai-evaluation` alias.

## 2. Install and call `register()`

Node.js 18.19+ or 20.6+.

```bash
npm install @opensearch-project/genai-observability-sdk-ts @opentelemetry/api
```

```typescript
import { register } from "@opensearch-project/genai-observability-sdk-ts";

const provider = await register({ serviceName: "travel-assistant-strands-ts" });
```

Call it once, before the framework creates its first agent or client. It sends traces to `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`; `endpoint: "grpc://localhost:4317"` for gRPC). On Node it also installs an `AsyncLocalStorageContextManager` (unless one is set), so async code keeps the active span. Pass `agentName` and `agentVersion` too if this process also emits evaluation results. In a short script, `await provider.shutdown()` before exit, or the last batch of spans is lost.

`register()` turns on `@opentelemetry/instrumentation-openai` when it is installed (`autoInstrument`, the default), and `@opentelemetry/instrumentation-aws-sdk` only when asked (`autoInstrument: { awsSdk: true }`, because it traces every AWS SDK client call, not only Bedrock). Pin them to `~0.21.0` / `~0.78.0`. They patch their library when it is loaded, so `register()` must finish before `openai` or the AWS SDK is imported: in an ES module app, call it in a file loaded with `node --import` (or `tsx --import`), after registering the `@opentelemetry/instrumentation/hook.mjs` loader hook. [tracing/openai](../tracing/openai/) shows this; [Auto-instrumentation](../../docs/configuration.md#auto-instrumentation) has the details. To configure an instrumentation yourself (hooks, message capture), leave it off in `register()` and register it with `tracerProvider: provider`, as [tracing/bedrock](../tracing/bedrock/) does, else every call is traced twice.

Keep one copy of `@opentelemetry/api` in the process: with two, the SDK cannot register its tracer provider and spans are dropped silently (the trace id is all zeros). If `npm ls @opentelemetry/api` shows two versions, add `"overrides": { "@opentelemetry/api": "$@opentelemetry/api" }` to `package.json`.

Shown in: [`basics/01_tracing_basics.ts`](../basics/01_tracing_basics.ts), every [`tracing/<framework>/`](../README.md#framework-and-library-matrix) example. Remote or AWS-hosted pipelines: [`basics/03_aws_sigv4.ts`](../basics/03_aws_sigv4.ts).

## 3. Instrument the agent

Pick the row for your stack:

| Your agent uses | What produces the spans | Example |
|---|---|---|
| A framework with built-in OTel (Strands) | The framework, through the global tracer provider `register()` sets | [tracing/strands](../tracing/strands/) |
| A framework without OTel GenAI instrumentation (LangGraph.js, OpenAI Agents SDK) | `observe()` / `withObserve()` around the model and tool calls, or a bridge from the framework's own tracing | [tracing/langgraph](../tracing/langgraph/), [tracing/openai-agents](../tracing/openai-agents/) |
| A model SDK (OpenAI, Anthropic, Bedrock Converse) | `chat` spans from the OpenAI instrumentation `register()` turns on, the AWS SDK instrumentation (opt-in) or the SDK itself (Anthropic); `observe()` for the agent and tools | [tracing/openai](../tracing/openai/), [tracing/anthropic](../tracing/anthropic/), [tracing/bedrock](../tracing/bedrock/) |
| Your own code | `observe()` / `withObserve()` and `enrich()` | [basics/01_tracing_basics.ts](../basics/01_tracing_basics.ts), [basics/04_async_tracing.ts](../basics/04_async_tracing.ts) |

```typescript
import { Op, enrich, observe, withObserve } from "@opensearch-project/genai-observability-sdk-ts";

const getWeather = observe({ name: "get_weather", op: Op.EXECUTE_TOOL }, (city: string) => lookUp(city));

const answer = await withObserve("travel_assistant", { op: Op.INVOKE_AGENT }, async () => {
  enrich({ inputMessages: [{ role: "user", parts: [{ type: "text", content: question }] }] });
  const text = await callModelAndTools(question); // wrap the model call with Op.CHAT
  enrich({ outputMessages: [{ role: "assistant", parts: [{ type: "text", content: text }] }] });
  return text;
});
```

Rules that make Agent Traces show the run correctly:

- The agent run is one `invoke_agent` span: `withObserve("travel_assistant", { op: Op.INVOKE_AGENT }, fn)`. Only `invoke_agent` and `create_agent` spans carry `gen_ai.agent.name`; a `chat` span never names an agent (so an LLM judge traced as `chat` is not listed as an agent).
- When the agent span is not the trace root (for example below an HTTP handler), call `markAgentRoot()` inside it.
- Record the question and answer on the agent span as GenAI messages (`enrich({ inputMessages, outputMessages })`), so evaluators can read them back.
- Tools are `execute_tool` spans with `gen_ai.tool.name` and their arguments and result (`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`). Wrap a tool with `observe({ op: Op.EXECUTE_TOOL }, fn)` if the framework does not.
- Agent Traces reads messages and tool payloads from span attributes. Strands writes span events by default and needs `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental,gen_ai_span_attributes_only` (see [end-to-end/strands-observability-agent/agent.ts](../end-to-end/strands-observability-agent/agent.ts)).
- With `setGlobal: false` or your own OTel setup, install a context manager yourself, else async children start new traces instead of nesting.
- Never put secrets in span attributes.

## 4. Run it and verify the spans

Run the agent once, then check the operations recorded for your service:

```bash
curl -sk -u admin:"$OPENSEARCH_PASSWORD" -X POST https://localhost:9200/_plugins/_ppl \
  -H 'Content-Type: application/json' \
  -d '{"query": "source=otel-v1-apm-span-* | where serviceName = '\''travel-assistant-strands-ts'\'' | stats count() by `attributes.gen_ai.operation.name`"}'
```

Expect `invoke_agent`, `chat` and `execute_tool` (frameworks add their own spans, such as Strands' event loop cycles). Then check one trace:

```bash
curl -sk -u admin:"$OPENSEARCH_PASSWORD" -X POST https://localhost:9200/_plugins/_ppl \
  -H 'Content-Type: application/json' \
  -d '{"query": "source=otel-v1-apm-span-* | where serviceName = '\''travel-assistant-strands-ts'\'' | fields traceId, name, `attributes.gen_ai.agent.name`, `attributes.gen_ai.tool.name`, `attributes.gen_ai.tool.call.arguments` | head 20"}'
```

Look for: one `traceId` per run, `gen_ai.agent.name` = `travel_assistant` on the `invoke_agent` span only, and each `execute_tool` span with its tool name and arguments.

Nothing arrived? Check the endpoint, that `register()` ran before the framework started (and before `openai` / the AWS SDK was imported, for their `chat` spans), that the process flushed before exit, and the collector counters:

```bash
curl -s http://localhost:8888/metrics | grep -E 'otelcol_(receiver_accepted|exporter_send_failed)_spans'
```

`npm install` fails with `ERESOLVE` on OpenTelemetry peers? Some frameworks (Strands) declare optional OpenTelemetry JS 2.x peers while the SDK is on 1.x: set `legacy-peer-deps=true` in `.npmrc` and list the peers the framework needs in `package.json`, as [tracing/strands](../tracing/strands/) does.

## 5. View it in Agent Traces

Open `http://localhost:5601/app/agentTraces` (add `/w/<workspaceId>` before `/app` when workspaces are on). Each agent run is one row with its status, latency and tokens. Open it to see the tree: `invoke_agent travel_assistant`, then each `chat` (model call) and `execute_tool get_weather` / `execute_tool find_events` with arguments and result.

Questions to ask of a trace: did it call a tool before answering? How many model calls did it take? Where did the time go?

## Next

Score these traces: [runbooks/evals.md](evals.md).
