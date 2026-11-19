# Anthropic SDK (TypeScript) tracing example

The travel assistant on the Anthropic TypeScript SDK (`@anthropic-ai/sdk`), traced with
the OpenSearch GenAI observability SDK. Claude calls two tools, `get_weather` and
`find_events`, over the static data in [`../../shared/`](../../shared/), then writes a
short trip plan. The example runs Claude on Amazon Bedrock through
`@anthropic-ai/bedrock-sdk`; the Claude API works the same way (see below).

The spans come from two places:

- The Anthropic SDK has built-in OpenTelemetry tracing: each Messages API call is an
  `anthropic.messages.create` span with `gen_ai.operation.name = chat`, the model and token
  usage. With `openTelemetry: { traces: { contentMode: 'content' } }` it also records the
  messages.
- The agent loop is plain code, so the SDK's `withObserve` makes the
  `invoke_agent travel_assistant` span and `observe` an `execute_tool <name>` span per tool
  call, with `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`.

```
invoke_agent travel_assistant      gen_ai.agent.name = travel_assistant
  anthropic.messages.create        chat, from the Anthropic SDK
  execute_tool get_weather         from observe()
  execute_tool find_events
  anthropic.messages.create
```

## Run

Needs Node.js 20+, an OTLP endpoint (the observability stack listens on
`http://localhost:4318`) and access to Claude on Amazon Bedrock.

```bash
npm install
AWS_PROFILE=<profile> AWS_REGION=us-west-2 npx tsx agent.ts "Plan a one-day trip to Paris."
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `AWS_PROFILE` / `AWS_REGION` | default chain / `us-west-2` | Bedrock credentials and region |
| `MODEL_ID` | `anthropic.claude-haiku-4-5` | Model id (Bedrock Messages API ids have no `us.` prefix or date) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Where `register()` sends spans |

### Claude API instead of Bedrock

Replace the client with the first-party one and set `ANTHROPIC_API_KEY`:

```ts
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ openTelemetry: { traces: { contentMode: 'content' } } });
```

```bash
ANTHROPIC_API_KEY=<key> MODEL_ID=claude-haiku-4-5 npx tsx agent.ts
```

## Check the trace

Open Agent Traces (`http://localhost:5601/app/agentTraces`) and pick service
`travel-assistant-anthropic-ts`, or query the span index:

```bash
curl -sk -u admin:<password> "https://localhost:9200/otel-v1-apm-span-*/_search" \
  -H 'Content-Type: application/json' -d '{
  "query": {"term": {"serviceName": "travel-assistant-anthropic-ts"}},
  "aggs": {"ops": {"terms": {"field": "attributes.gen_ai.operation.name"}}}, "size": 0}'
```

## Notes

- The Anthropic SDK's tool runner (`client.beta.messages.toolRunner`) also traces tool calls,
  but opens its own `invoke_agent` span (`anthropic.messages.tool_runner`) without an agent
  name. This example keeps a manual loop so the agent span is named `travel_assistant`.
- `register()` installs an `AsyncLocalStorageContextManager` on Node, so the chat and tool spans
  nest under the agent span across `await`; there is no context manager to set up.
- The Anthropic SDK records messages only with `contentMode: 'content'` (or
  `ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE=content`). Prompts and responses then go to
  your trace backend: check that its access and retention settings fit your data.
