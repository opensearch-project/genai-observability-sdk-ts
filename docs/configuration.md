# Configuration

How `register()` finds its endpoints, the environment variables it reads, AWS SigV4 signing, ingestion pipelines, optional dependencies and auto-instrumentation. The `register()` options themselves are in the [API reference](api-reference.md#register).

- [Environment variables](#environment-variables)
- [Endpoints: traces and evaluation logs](#endpoints-traces-and-evaluation-logs)
- [AWS SigV4](#aws-sigv4)
- [Ingestion pipelines](#ingestion-pipelines)
- [Optional dependencies](#optional-dependencies)
- [Auto-instrumentation](#auto-instrumentation)

## Environment variables

| Environment Variable | Description | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP URL for all signals (`/v1/traces` and `/v1/logs` appended over HTTP, as-is over gRPC). `endpoint` wins over it | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full OTLP traces URL. `tracesEndpoint` and `endpoint` win over it | none |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Full OTLP logs URL for evaluation events. `logsEndpoint` and `endpoint` win over it | none |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Protocol for all signals (`grpc` or `http/protobuf`; `http/json` throws). `protocol` wins over it | none |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | Protocol for traces | none |
| `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL` | Protocol for evaluation logs | none |
| `OTEL_EXPORTER_OTLP_COMPRESSION` / `OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION` | `none` or `gzip`. `compression` wins over them | `none` |
| `OTEL_EXPORTER_OTLP_TIMEOUT` / `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT` | Timeout of each export request, in milliseconds. `timeoutMillis` wins over them | `10000` |
| `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS` | Extra headers (`key=value,key2=value2`). `headers` wins per key; the SigV4 exporters sign them | none |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | Spans per export batch. Lower it when large GenAI spans exceed a pipeline's request limit | `512` |
| `AWS_DEFAULT_REGION` | AWS region for SigV4 signing | — |
| `AWS_REGION` | AWS region for SigV4 signing (fallback) | — |

## Endpoints: traces and evaluation logs

Spans and evaluation events (`gen_ai.evaluation.result`) are separate OTLP signals. `register()` resolves each one with the same rule, following the [OTel exporter spec](https://opentelemetry.io/docs/specs/otel/protocol/exporter/). Options passed in code always win over env vars, as in the OTel SDK exporters.

There are no port options: the port is part of each URL (`endpoint`, `tracesEndpoint`, `logsEndpoint`).

### Three setups

**(a) Local OTel Collector or the observability stack.** Nothing to set: the default base is the OTel standard `http://localhost:4318` (`DEFAULT_BASE_ENDPOINT`), so traces go to `/v1/traces` and logs to `/v1/logs`. Over gRPC the default is `http://localhost:4317`.

```typescript
await register({ serviceName: "my-app" });
// the same, explicitly:
await register({ endpoint: "http://localhost:4318", serviceName: "my-app" });
// gRPC: traces and logs both go to localhost:4317
await register({ endpoint: "grpc://localhost:4317", serviceName: "my-app" });
```

or with env vars only: `export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.

**(b) One OSIS or Data Prepper `otlp` source** that serves both signals at `/<pipeline>/v1/traces` and `/<pipeline>/v1/logs`. Pass the base, path prefix included. For OSIS, sign with SigV4 service `osis`: OSIS accepts OTLP/HTTP only (protobuf), signed with SigV4, and does not support gRPC.

```typescript
await register({
  endpoint: "https://<host>/<pipeline>", // -> /<pipeline>/v1/traces and /<pipeline>/v1/logs
  sigv4: { service: "osis", region: "us-east-1" }, // OSIS only
});
```

**(c) Separate trace and logs pipelines** (`otel_trace_source` and `otel_logs_source`). Pass both full URLs; each is used as-is. On Data Prepper the default ports are 21890 (traces) and 21892 (logs); set `path:` on each source (for example `/v1/traces` and `/v1/logs`) and `unframed_requests: true` so plain OTLP/HTTP requests are accepted. On OSIS, add `sigv4`.

```typescript
await register({
  tracesEndpoint: "http://data-prepper:21890/v1/traces",
  logsEndpoint: "http://data-prepper:21892/v1/logs",
});
```

### Endpoint resolution

Per signal (traces and logs), first match wins:

1. `tracesEndpoint` / `logsEndpoint` parameter: full URL, used as-is
2. `endpoint` parameter: base URL, with `/v1/traces` or `/v1/logs` appended over HTTP, as-is over gRPC
3. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`: full URL, used as-is
4. `OTEL_EXPORTER_OTLP_ENDPOINT`: base URL, same rule as `endpoint`
5. Nothing configured: `http://localhost:4318` (`http://localhost:4317` over gRPC), same rule

For example, with `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://env-logs:4318/v1/logs` set:

```typescript
await register({ endpoint: "http://collector:4318" });
// traces -> http://collector:4318/v1/traces
// logs   -> http://collector:4318/v1/logs   (endpoint beats the env var)
```

### Errors

`register()` throws:

- when `endpoint` (or `OTEL_EXPORTER_OTLP_ENDPOINT`) has a path ending in `/v1/traces` or `/v1/logs`: it is the OTLP base URL. Remove the suffix (`http://host:4318`), or pass `tracesEndpoint` and `logsEndpoint`.
- when only one of `tracesEndpoint` / `logsEndpoint` is passed. `logExporter` (or `logs: false`) stands in for `logsEndpoint`, and `exporter` for `tracesEndpoint`.
- when `sigv4` is set and a signal resolves to gRPC (a `grpc://` / `grpcs://` URL, `protocol: "grpc"`, or a gRPC protocol env var): SigV4 signs OTLP/HTTP only. Use an `https://` endpoint or `protocol: "http"`. A signal with its own `exporter` / `logExporter` is not checked.

### Protocol and URL schemes

Protocol per signal, in priority order:

1. `protocol` parameter: `"http"` or `"grpc"`
2. A `grpc://` or `grpcs://` scheme on the URL passed in code (`tracesEndpoint` / `logsEndpoint` / `endpoint`)
3. `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` / `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`
4. `OTEL_EXPORTER_OTLP_PROTOCOL`
5. URL scheme of that signal's endpoint (`grpc://` or `grpcs://` mean gRPC), else HTTP

Use gRPC with a local OTel Collector (default `localhost:4317`) or a self-hosted Data Prepper, whose OTLP sources accept framed gRPC natively. OSIS does not support gRPC: use `https://` with `sigv4`.

**OTLP/HTTP is binary protobuf** (`Content-Type: application/x-protobuf`), for every exporter `register()` builds, signed or not. The SDK never sends OTLP/JSON: Data Prepper and OSIS read OTLP/JSON hex trace and span ids as base64, which corrupts them so spans and evaluation results no longer match their traces. `protocol: "http/json"` (or `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`) therefore throws; `http/protobuf` is the same as `http`.

`grpc://` and `grpcs://` are mapped to `http://` / `https://` once the protocol is known. An `http://` or `https://` scheme does not select HTTP over the env vars (the OTel JS gRPC exporters take `http(s)://` URLs too).

**Scores over gRPC.** The gRPC log exporter, like the OTLP/HTTP ones, sends whole-number scores as `doubleValue` (see [Scores are doubles](api-reference.md#score)).

### Compression

`compression: "gzip"` (or `OTEL_EXPORTER_OTLP_COMPRESSION=gzip`) compresses every export, gRPC included. It must match the receiving pipeline: OSIS accepts only `none` or `gzip`, and the client must use the pipeline source's `compression` setting. A Data Prepper source with `compression: none` rejects gzip bodies.

### Request size

OSIS `otel_*` sources cap each request at 1 MB to 4 MB (1 MB by default with the persistent buffer), and Data Prepper sources at their `max_request_length`. Large GenAI spans (prompts, completions) can exceed that: lower the batch size with `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`. A rejected request gets a 413, which `AWSSigV4OTLPExporter` logs with this hint.

### Headers

`headers` apply to every export `register()` builds (traces and logs), merged over `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS` (`headers` wins per key). Over gRPC they are sent as gRPC metadata with lowercased keys (gRPC rejects uppercase keys). The SigV4 exporters sign them.

### Custom exporters

`exporter` and `logExporter` are escape hatches: each replaces one signal's exporter and nothing is derived from it. Without `exporter`, every signal has an endpoint (the default at worst). With `exporter` and no logs destination (`logExporter`, or any of steps 1 to 4 above for logs: `logsEndpoint`, `endpoint`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT`), `register()` does not set up a logs pipeline: it warns once, and evaluation events go to the global `LoggerProvider` (a no-op unless you registered one). Pass `logsEndpoint` or `logExporter` to export them.

### Upgrading to 0.2.0

Before 0.2.0 (`@opensearch-project/genai-observability-sdk-ts@>=0.2.0`), `endpoint` was the full traces URL and the default was `http://localhost:21890/opentelemetry/v1/traces`. `endpoint` is now always the base URL, and a value ending in `/v1/traces` throws. Pass the base (`http://host:4318`), or `tracesEndpoint` and `logsEndpoint`. To keep sending to a Data Prepper `otlp` source on its old default, pass `endpoint: "http://localhost:21890"` and set `traces_path` / `logs_path` and `unframed_requests: true` on the source (see the [guide](agent-evaluations.md#ingestion)).

## AWS SigV4

`register({ sigv4: { service, region } })` signs traces and logs with AWS SigV4, for Amazon OpenSearch Ingestion (OSIS, service `osis`, the default) and Amazon OpenSearch Service (service `es`). It works over OTLP/HTTP protobuf only; a signal that resolves to gRPC throws (see [Errors](#errors)). The region comes from `sigv4.region`, else `AWS_DEFAULT_REGION`, else `AWS_REGION`. Signing needs the optional dependencies `@aws-sdk/credential-providers` and `aws4` (see [Optional dependencies](#optional-dependencies)).

`register({ sigv4 })` creates the signing exporters for you. To build them yourself and pass them as `exporter` / `logExporter`, see [`AWSSigV4OTLPExporter`](api-reference.md#awssigv4otlpexporter). For the receiving side, see [Ingestion pipelines](#ingestion-pipelines).

## Ingestion pipelines

**Self-hosted Data Prepper.** For OTLP/HTTP straight from the SDK, set `unframed_requests: true` and the source paths (`traces_path` / `logs_path` on `otlp`, `path` on `otel_trace_source` / `otel_logs_source`). Use `ssl: false` for plain `http://`, or a certificate your process trusts: for `https://`, add your CA with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. The source settings per setup are in [Three setups](#three-setups).

The full Data Prepper and Amazon OpenSearch Ingestion pipelines for evaluation events, the evaluation index template and how to verify results are in [Ingestion](agent-evaluations.md#ingestion).

## Optional dependencies

Retrieval (`@opensearch-project/opensearch`) and SigV4 signing (`@aws-sdk/credential-providers`, `aws4`) use optional dependencies, which npm, pnpm and yarn install by default. If you install with `--omit=optional` (or `--no-optional`), add the ones you need:

```bash
# OpenSearch trace retrieval
npm install @opensearch-project/opensearch

# AWS SigV4 authentication
npm install @aws-sdk/credential-providers aws4
```

The auto-instrumentation packages are optional peer dependencies: install the ones you want (see [Auto-instrumentation](#auto-instrumentation)).

## Auto-instrumentation

With `autoInstrument` (the default), `register()` turns on each of these packages that is installed, with its own provider (also with `setGlobal: false`). It needs nothing else from you: no `registerInstrumentations()` call.

### Supported libraries

| Package | Instruments | Supported versions (tested) |
|---|---|---|
| `@opentelemetry/instrumentation-openai` | `openai` >= 4.19 < 7: Chat Completions, Responses, Embeddings become `chat <model>` / `embeddings <model>` spans | >= 0.14 < 0.22 (0.21) |
| `@opentelemetry/instrumentation-aws-sdk` | AWS SDK for JavaScript v3; Bedrock Runtime `Converse` / `InvokeModel` become `chat <model>` spans | >= 0.50 < 0.79 (0.78) |

### Versions

This SDK is on OpenTelemetry JS 1.x (`@opentelemetry/api` 1.9). `@opentelemetry/instrumentation-openai` 0.22+ and `@opentelemetry/instrumentation-aws-sdk` 0.79+ are built on `@opentelemetry/instrumentation` 0.300, which needs `@opentelemetry/api` 1.10, so pin `~0.21.0` / `~0.78.0`. Both packages are optional peer dependencies with these ranges. An installed package that fails to load logs a warning naming the supported versions; one that is not installed is skipped silently.

### Load order

An instrumentation patches its library when the library is loaded, so `register()` must finish before `openai` or the AWS SDK is imported. Static `import`s run before the code of the module, so in the module that imports the library, calling `register()` is too late. In an ES module app:

```typescript
// otel.ts: loaded with `node --import ./otel.js app.js` (or `tsx --import ./otel.ts app.ts`)
import { register as registerHooks } from "node:module";
import { register } from "@opensearch-project/genai-observability-sdk-ts";

// Let the instrumentations patch `import` statements (ESM only).
registerHooks("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

export const provider = await register({ serviceName: "my-agent" });
```

`@opentelemetry/instrumentation` must be resolvable from that file: install it, `~0.223.0`, the same line the instrumentations use. `app.ts` imports `openai` as usual and can import `provider` from `./otel.js` to flush it. In a single file, load the library after `register()` with `await import("openai")` (see [`05_openai_auto_instrument.ts`](../examples/05_openai_auto_instrument.ts)). In CommonJS, `require()` the library after `await register()` resolves; no loader hook is needed.

### Your own setup

To configure an instrumentation (for example `captureMessageContent`, or `preRequestHook` / `responseHook` on `AwsInstrumentation`), pass `autoInstrument: false` and register it yourself, else every call is traced twice:

```typescript
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { OpenAIInstrumentation } from "@opentelemetry/instrumentation-openai";

const provider = await register({ serviceName: "my-agent", autoInstrument: false });
registerInstrumentations({
  instrumentations: [new OpenAIInstrumentation({ captureMessageContent: true })],
  tracerProvider: provider,
});
```

The OpenAI instrumentation records prompts and completions as log events (`gen_ai.user.message`, `gen_ai.choice`), not span attributes, and only with `captureMessageContent: true` (or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`). To show messages on the span, add them with `enrich({ inputMessages, outputMessages })` in your own `observe()` span.

### Other libraries

The Anthropic SDK (1.x) emits OpenTelemetry spans itself through the global tracer provider, so it needs no instrumentation package. LangChain.js / LangGraph.js and the OpenAI Agents SDK have no OpenTelemetry GenAI instrumentation in OpenTelemetry JS: trace their model and tool calls with `observe()` / `withObserve()`. Any other OpenTelemetry JS instrumentation works with `registerInstrumentations({ instrumentations, tracerProvider: provider })` as above, if it supports `@opentelemetry/api` 1.9.
