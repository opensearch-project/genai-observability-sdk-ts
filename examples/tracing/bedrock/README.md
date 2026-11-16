# Amazon Bedrock Converse (AWS SDK v3) tracing example

The travel assistant on the Amazon Bedrock Converse API with the AWS SDK for JavaScript v3
(`@aws-sdk/client-bedrock-runtime`), traced with the OpenSearch GenAI observability SDK.
The model calls two tools, `get_weather` and `find_events`, over the static data in
[`../../shared/`](../../shared/), then writes a short trip plan.

There is no agent framework, so the spans come from two places:

- `@opentelemetry/instrumentation-aws-sdk` (set up in `otel.ts`) turns each Converse call
  into a `chat <model>` span with the model, token usage and finish reason.
- The SDK's `withObserve` makes the `invoke_agent travel_assistant` span around the agent
  loop, and `observe` makes an `execute_tool <name>` span per tool call, with
  `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`.

```
invoke_agent travel_assistant      gen_ai.agent.name = travel_assistant
  chat <model>                     from the AWS SDK instrumentation
  execute_tool get_weather         from observe()
  execute_tool find_events
  chat <model>
```

## Run

Needs Node.js 20+, an OTLP endpoint (the observability stack listens on
`http://localhost:4318`) and access to the model on Amazon Bedrock.

```bash
npm install
AWS_PROFILE=<profile> AWS_REGION=us-west-2 \
  npx tsx --import ./otel.ts agent.ts "Plan a one-day trip to Paris."
```

The instrumentation patches the AWS SDK when it is loaded, so it must be set up before the
AWS SDK is imported. `--import ./otel.ts` runs `otel.ts` first: it registers the
`@opentelemetry/instrumentation/hook.mjs` loader hook (ES modules only), calls `register()`
and registers the instrumentation. `agent.ts` imports `provider` from `./otel.js` to flush
it. Without `--import ./otel.ts` the `chat` spans are missing.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AWS_PROFILE` / `AWS_REGION` | default chain / `us-west-2` | Bedrock credentials and region |
| `MODEL_ID` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Bedrock model or inference profile |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Where `register()` sends spans |

## Check the trace

Open Agent Traces (`http://localhost:5601/app/agentTraces`) and pick service
`travel-assistant-bedrock`, or query the span index:

```bash
curl -sk -u admin:<password> "https://localhost:9200/otel-v1-apm-span-*/_search" \
  -H 'Content-Type: application/json' -d '{
  "query": {"term": {"serviceName": "travel-assistant-bedrock"}},
  "aggs": {"ops": {"terms": {"field": "attributes.gen_ai.operation.name"}}}, "size": 0}'
```

## Notes

- `register()` turns on `@opentelemetry/instrumentation-aws-sdk` by itself when it is
  installed (`autoInstrument`), but with no hooks. `otel.ts` needs the hooks, so it passes
  `autoInstrument: false` and registers `AwsInstrumentation` with `tracerProvider: provider`.
  With both, every Converse call would be traced twice. Without the hooks, drop the
  `registerInstrumentations()` call and the `autoInstrument: false`.
- The AWS SDK instrumentation records no messages. The `preRequestHook` / `responseHook`
  in `otel.ts` add `gen_ai.input.messages`, `gen_ai.output.messages` and
  `gen_ai.system_instructions` to the chat spans, which is where Agent Traces reads them.
- `register()` installs an `AsyncLocalStorageContextManager` on Node, so the chat and tool spans
  nest under the agent span across `await`; there is no context manager to set up.
- `@opentelemetry/instrumentation-aws-sdk` is pinned to `~0.78.0`: later releases need
  `@opentelemetry/api` 1.10, and the SDK is on OpenTelemetry JS 1.x (`@opentelemetry/api` 1.9).
