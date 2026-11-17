# OpenAI SDK (TypeScript) tracing example

The travel assistant on the OpenAI Node SDK (`openai`, Chat Completions with tools), traced
with the OpenSearch GenAI observability SDK. The model calls two tools, `get_weather` and
`find_events`, over the static data in [`../../shared/`](../../shared/), then writes a
short trip plan.

The spans come from two places:

- `@opentelemetry/instrumentation-openai` turns each `chat.completions.create` call into a
  `chat <model>` span with the model, token usage and finish reason. `register()` turns it
  on by itself when it is installed (`autoInstrument`, the default), in `otel.ts`.
- The agent loop is plain code, so the SDK's `withObserve` makes the
  `invoke_agent travel_assistant` span (with the question and the final answer, via
  `enrich`) and `observe` an `execute_tool <name>` span per tool call, with
  `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`.

```
invoke_agent travel_assistant      gen_ai.agent.name = travel_assistant
  chat <model>                     from the OpenAI instrumentation
  execute_tool get_weather         from observe()
  chat <model>
  execute_tool find_events
  chat <model>
```

## Run

Needs Node.js 20+ and an OTLP endpoint (the observability stack listens on
`http://localhost:4318`).

```bash
npm install

# OpenAI
OPENAI_API_KEY=<key> npx tsx --import ./otel.ts agent.ts "Plan a one-day trip to Paris."

# No OpenAI key: Amazon Bedrock's OpenAI-compatible endpoint
AWS_PROFILE=<profile> AWS_REGION=us-west-2 \
  npx tsx --import ./otel.ts agent.ts "Plan a one-day trip to Paris."
```

The instrumentation patches the OpenAI SDK when it is loaded, so `register()` must finish
before `openai` is imported. `--import ./otel.ts` runs `otel.ts` first: it registers the
`@opentelemetry/instrumentation/hook.mjs` loader hook (ES modules only) and calls
`register()`. `agent.ts` then imports `openai` as usual, and `provider` from `./otel.js` to
flush it. Without `--import ./otel.ts` the `chat` spans are missing. This is the
[load order](https://github.com/opensearch-project/genai-observability-sdk-ts/blob/main/docs/configuration.md#load-order)
in the SDK docs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | unset | Use OpenAI. When unset, the example uses Bedrock |
| `MODEL_ID` | `gpt-4.1-mini` (OpenAI) / `openai.gpt-oss-120b` (Bedrock) | Model |
| `AWS_PROFILE` / `AWS_REGION` | default chain / `us-west-2` | Bedrock credentials and region |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Where `register()` sends spans |

Bedrock path: the OpenAI client points at `https://bedrock-mantle.<region>.api.aws/v1`
with a short-term Bedrock API key that `@aws/bedrock-token-generator` makes from your AWS
credentials. Claude models are not served on Bedrock's Chat Completions API, so the default
Bedrock model is `openai.gpt-oss-120b`.

## Check the trace

Open Agent Traces (`http://localhost:5601/app/agentTraces`) and pick service
`travel-assistant-openai`, or query the span index:

```bash
curl -sk -u admin:<password> "https://localhost:9200/otel-v1-apm-span-*/_search" \
  -H 'Content-Type: application/json' -d '{
  "query": {"term": {"serviceName": "travel-assistant-openai"}},
  "aggs": {"ops": {"terms": {"field": "attributes.gen_ai.operation.name"}}}, "size": 0}'
```

## Notes

- For Chat Completions, `@opentelemetry/instrumentation-openai` sends prompts and
  completions (when enabled) as log events (`gen_ai.user.message`, `gen_ai.choice`, ...), not as span
  attributes, so the `chat` spans have no `gen_ai.input.messages` / `gen_ai.output.messages`
  and Agent Traces shows no messages on them. The agent span carries the question and the
  answer.
- `register()` installs an `AsyncLocalStorageContextManager` on Node, so the chat and tool spans
  nest under the agent span across `await`; there is no context manager to set up.
- Prompts and completions are not recorded by default. Set
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` to have the instrumentation send
  them (as log events). To configure the instrumentation in code, pass
  `register({ autoInstrument: { openai: false } })` and register `OpenAIInstrumentation`
  yourself with `tracerProvider: provider` (as [tracing/bedrock](../bedrock/otel.ts) does
  for the AWS SDK), else every call is traced twice.
- `@opentelemetry/instrumentation-openai` is pinned to `~0.21.0`: later releases need
  `@opentelemetry/api` 1.10, and the SDK is on OpenTelemetry JS 1.x (`@opentelemetry/api` 1.9).
