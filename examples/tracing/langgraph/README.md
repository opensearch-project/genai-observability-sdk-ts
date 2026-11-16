# LangGraph.js tracing example

The travel assistant on [LangGraph.js](https://langchain-ai.github.io/langgraphjs/)
(`@langchain/langgraph`) with Claude on Amazon Bedrock (`@langchain/aws`), traced with the
OpenSearch GenAI observability SDK. The graph has a model node and a tools node; the model
calls `get_weather` and `find_events` over the static data in
[`../../shared/`](../../shared/), then writes a short trip plan.

LangGraph.js and LangChain.js have no OpenTelemetry GenAI instrumentation, so the SDK makes
the spans:

- `withObserve('travel_assistant', { op: Op.INVOKE_AGENT })` around `graph.invoke()`.
- `withObserve(<model id>, { op: Op.CHAT })` inside the model node, with `enrich()` for the
  messages (`gen_ai.input.messages`, `gen_ai.output.messages`) and token usage.
- `observe({ op: Op.EXECUTE_TOOL })` around the tool functions, which records
  `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`.

```
invoke_agent travel_assistant      gen_ai.agent.name = travel_assistant
  chat <model>                     model node
  execute_tool get_weather         tools node
  execute_tool find_events
  chat <model>
```

## Run

Needs Node.js 20+, an OTLP endpoint (the observability stack listens on
`http://localhost:4318`) and access to the model on Amazon Bedrock.

```bash
npm install
AWS_PROFILE=<profile> AWS_REGION=us-west-2 npx tsx agent.ts "Plan a one-day trip to Paris."
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `AWS_PROFILE` / `AWS_REGION` | default chain / `us-west-2` | Bedrock credentials and region |
| `MODEL_ID` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Bedrock model or inference profile |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Where `register()` sends spans |

For another model provider, swap `ChatBedrockConverse` for `ChatOpenAI` (`@langchain/openai`,
reads `OPENAI_API_KEY`) or `ChatAnthropic` (`@langchain/anthropic`) and set `provider` in
the `enrich()` call.

## Check the trace

Open Agent Traces (`http://localhost:5601/app/agentTraces`) and pick service
`travel-assistant-langgraph`, or query the span index:

```bash
curl -sk -u admin:<password> "https://localhost:9200/otel-v1-apm-span-*/_search" \
  -H 'Content-Type: application/json' -d '{
  "query": {"term": {"serviceName": "travel-assistant-langgraph"}},
  "aggs": {"ops": {"terms": {"field": "attributes.gen_ai.operation.name"}}}, "size": 0}'
```

## Notes

- The graph runs async, so `agent.ts` installs an `AsyncLocalStorageContextManager`.
  `register()` does not install one, and without it the tool and chat spans become
  separate traces.
- With `createReactAgent` the model call happens inside the prebuilt agent, so there is no
  place to put the chat span. This example builds the same loop with `StateGraph` to keep
  one chat span per model call.
