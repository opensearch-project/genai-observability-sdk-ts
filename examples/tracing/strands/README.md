# Strands Agents (TypeScript) tracing example

The travel assistant on [Strands Agents](https://strandsagents.com) (`@strands-agents/sdk`),
traced with the OpenSearch GenAI observability SDK. The agent calls two tools,
`get_weather` and `find_events`, over the static data in [`../../shared/`](../../shared/),
then writes a short trip plan.

Strands has built-in OpenTelemetry instrumentation, so the example only calls `register()`.
The spans of one run:

```
invoke_agent travel_assistant      gen_ai.agent.name = travel_assistant
  execute_agent_loop_cycle
    chat                           one per model call, with messages and token usage
    execute_tool get_weather       gen_ai.tool.call.arguments / gen_ai.tool.call.result
    execute_tool find_events
  execute_agent_loop_cycle
    chat
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
| `OTEL_SEMCONV_STABILITY_OPT_IN` | `gen_ai_latest_experimental,gen_ai_span_attributes_only` | Strands span conventions (set in code when unset) |

To use another model provider, swap `BedrockModel` for a Strands `OpenAIModel` or
`AnthropicModel` (`@strands-agents/sdk/models/openai`, `.../anthropic`).

## Check the trace

Open Agent Traces (`http://localhost:5601/app/agentTraces`) and pick service
`travel-assistant-strands`, or query the span index:

```bash
curl -sk -u admin:<password> "https://localhost:9200/otel-v1-apm-span-*/_search" \
  -H 'Content-Type: application/json' -d '{
  "query": {"term": {"serviceName": "travel-assistant-strands"}},
  "aggs": {"ops": {"terms": {"field": "attributes.gen_ai.operation.name"}}}, "size": 0}'
```

## Notes

- `OTEL_SEMCONV_STABILITY_OPT_IN` with `gen_ai_span_attributes_only` puts the messages on
  span attributes (`gen_ai.input.messages`, `gen_ai.output.messages`), which is where
  Agent Traces reads them.
- `.npmrc` sets `legacy-peer-deps`: the SDK is on OpenTelemetry JS 1.x and Strands declares
  optional peers on 2.x (used only by Strands' own exporter setup, which this example does
  not call). With that flag npm does not install peers, so `package.json` lists the required
  ones (`@opentelemetry/api`, `@modelcontextprotocol/client`, `zod`).
