# Architecture

How spans and evaluation events flow from your application through the SDK and an OTLP pipeline into OpenSearch.

```
┌──────────────────────────────────────────────────────┐
│                   Your Application                    │
│                                                       │
│  observe(opts, fn)   withObserve()   enrich()         │
│  score()   evaluate()   Benchmark                     │
│                     │                                 │
│      opensearch-genai-observability-sdk-ts            │
├──────────────────────────────────────────────────────┤
│  register()                                           │
│  ┌──────────────────────────────────────────────┐    │
│  │  TracerProvider                               │    │
│  │  ├── Resource (service.name)                  │    │
│  │  ├── TestCaseSpanProcessor (evaluate())       │    │
│  │  ├── BatchSpanProcessor                       │    │
│  │  │   └── OTLPSpanExporter (HTTP or gRPC)      │    │
│  │  │       └── SigV4 signing (AWS endpoints)    │    │
│  │  └── Auto-instrumentation                     │    │
│  │  LoggerProvider (evaluation and test events)  │    │
│  │  └── BatchLogRecordProcessor                  │    │
│  │      └── OTLPLogExporter (HTTP, /v1/logs)     │    │
│  └──────────────────────────────────────────────┘    │
└───────────────────────┬──────────────────────────────┘
                        │ OTLP (HTTP/gRPC)
                        ▼
               ┌─────────────────┐
               │  Data Prepper /  │
               │  OTel Collector  │
               └────────┬────────┘
                        │
                        ▼
          ┌───────────────────────────────┐
          │   OpenSearch                  │
          │  ├── otel-v1-apm-span-*       │
          │  └── otel-v1-genai-evaluation │
          └───────────────────────────────┘
```

## Spans

`register()` sets up a `TracerProvider` with a `BatchSpanProcessor` (simple with `batch: false`) and an OTLP span exporter (HTTP or gRPC, optionally SigV4-signed), and turns on the installed auto-instrumentations. `observe()`, `withObserve()` and the instrumentations create standard OTel spans with GenAI semantic convention attributes, and `enrich()` adds attributes to the active span. Spans are exported to `/v1/traces`, and Data Prepper writes them to `otel-v1-apm-span-*`.

For example, this code:

```typescript
import { register, observe, Op, enrich, score } from "@opensearch-project/genai-observability-sdk-ts";

// 1. Initialize tracing (one line)
await register({ serviceName: "research-app", agentName: "research_agent" }); // OTLP/HTTP to http://localhost:4318

// 2. Trace your functions
const search = observe(
  { name: "web_search", op: Op.EXECUTE_TOOL },
  (query: string) => {
    return [{ title: `Result for: ${query}` }];
  },
);

const research = observe(
  { name: "research_agent", op: Op.INVOKE_AGENT },
  (query: string) => {
    const results = search(query);
    enrich({ model: "gpt-4.1", provider: "openai", inputTokens: 150, outputTokens: 50 });
    return `Summary of: ${JSON.stringify(results)}`;
  },
);

// 3. Use it
const result = research("What is OpenSearch?");

// 4. Submit scores (after workflow completes): pass the evaluated span's ids
score({ name: "relevance", value: 0.95, traceId: "...", spanId: "..." });
```

This produces the following span tree:

```
invoke_agent research_agent
└── execute_tool web_search
```

Data Prepper marks the outermost GenAI span of each trace with `derived.gen_ai.is_root`, which OpenSearch Agent Traces uses to list the trace. `markAgentRoot()` marks a span at the source instead (see [`markAgentRoot()`](api-reference.md#markagentroot)).

## Evaluation events

`score()`, `evaluate()` and `Benchmark` emit each result as an OTel log event named `gen_ai.evaluation.result`. `register()` sets up a `LoggerProvider` with a `BatchLogRecordProcessor` and an OTLP log exporter for them. The event carries the trace context of the evaluated span, so it joins that trace without adding a span. It is exported to `/v1/logs`, and Data Prepper routes it (`eventName == "gen_ai.evaluation.result"`) to the `otel-v1-genai-evaluation` alias.

`evaluate()` creates no spans of its own: each case's agent run is its own trace, and `TestCaseSpanProcessor` stamps the `test.*` ids on its root span. What each event holds is in [What gets stored](agent-evaluations.md#what-gets-stored); the pipelines are in [Ingestion](agent-evaluations.md#ingestion).

## Endpoints

Both signals go to one OTLP base URL by default (`http://localhost:4318`), or to one full URL each. The rules are in [Endpoints: traces and evaluation logs](configuration.md#endpoints-traces-and-evaluation-logs).
