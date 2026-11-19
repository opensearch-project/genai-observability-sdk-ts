# OpenAI Agents SDK (TypeScript) tracing example

The travel assistant on the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)
(`@openai/agents`), traced with the OpenSearch GenAI observability SDK. The agent calls two
tools, `get_weather` and `find_events`, over the static data in
[`../../shared/`](../../shared/), then writes a short trip plan.

The Agents SDK traces every run itself, but sends the traces only to the OpenAI tracing
backend; it has no OpenTelemetry export. `agent.ts` registers a small trace processor,
`OTelBridge`, that turns the Agents SDK spans into OpenTelemetry GenAI spans and replaces
the default OpenAI exporter:

| Agents SDK span | OpenTelemetry span | Attributes |
| --- | --- | --- |
| `agent` | `invoke_agent travel_assistant` | `gen_ai.agent.name`, `gen_ai.input.messages` (the first model call's input), `gen_ai.output.messages` (the last model call's output) |
| `generation` | `chat <model>` | model, `gen_ai.input.messages`, `gen_ai.output.messages`, token usage |
| `function` | `execute_tool <tool>` | `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` |
| `task`, `turn`, others | not exported | their children attach to the nearest exported span |

`register({ autoInstrument: false })`: the bridge already emits one `chat` span per model call. The SDK's default OpenAI instrumentation would trace the Agents SDK's OpenAI client call a second time on the OpenAI path.

## Run

Needs Node.js 20+ and an OTLP endpoint (the observability stack listens on
`http://localhost:4318`).

```bash
npm install

# OpenAI
OPENAI_API_KEY=<key> npx tsx agent.ts "Plan a one-day trip to Paris."

# No OpenAI key: Claude on Amazon Bedrock
AWS_PROFILE=<profile> AWS_REGION=us-west-2 npx tsx agent.ts "Plan a one-day trip to Paris."
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | unset | Use OpenAI. When unset, the example uses Bedrock |
| `MODEL_ID` | `gpt-4.1-mini` (OpenAI) / `us.anthropic.claude-haiku-4-5-20251001-v1:0` (Bedrock) | Model |
| `AWS_PROFILE` / `AWS_REGION` | default chain / `us-west-2` | Bedrock credentials and region |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Where `register()` sends spans |

Bedrock path: the agent's model is `aisdk(bedrock(<model id>))`, the Agents SDK adapter for
AI SDK models (`@openai/agents-extensions`) over `@ai-sdk/amazon-bedrock`, with credentials
from the AWS default chain.

## Check the trace

Open Agent Traces (`http://localhost:5601/app/agentTraces`) and pick service
`travel-assistant-openai-agents-ts`, or query the span index:

```bash
curl -sk -u admin:<password> "https://localhost:9200/otel-v1-apm-span-*/_search" \
  -H 'Content-Type: application/json' -d '{
  "query": {"term": {"serviceName": "travel-assistant-openai-agents-ts"}},
  "aggs": {"ops": {"terms": {"field": "attributes.gen_ai.operation.name"}}}, "size": 0}'
```

## Notes

- `setTraceProcessors([new OTelBridge()])` replaces the default processor. To also keep
  sending traces to OpenAI, use `addTraceProcessor(new OTelBridge())` instead.
- The bridge sets the parent of each span explicitly, so no OpenTelemetry context manager
  is needed.
- Agents SDK spans carry the model name the adapter reports, for example
  `amazon-bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0`.
