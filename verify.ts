/**
 * Comprehensive SDK verification script.
 * Exercises every public API feature and checks the resulting spans.
 */
import { trace } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

// Import everything from the SDK source
import {
  register,
  DEFAULT_ENDPOINT,
  observe,
  withObserve,
  Op,
  enrich,
  score,
  Benchmark,
  evaluate,
  AWSSigV4OTLPExporter,
  OpenSearchTraceRetriever,
} from "./src/index.js";
import { parseHex, RESERVED_KEYS, validateMetadataKeys } from "./src/internal.js";
import { parseMessages, extractMessagesFromDoc, mapSpanDoc } from "./src/retrieval.js";

// ── Setup test provider ─────────────────────────────────────────────
const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  resource: new Resource({ "service.name": "verify-sdk" }),
});
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register({ contextManager });

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${label}`);
  }
}

function clear() {
  exporter.reset();
}

// ── 1. Internal utilities ───────────────────────────────────────────
console.log("\n=== 1. Internal utilities ===");

assert(parseHex("ff") === 255, "parseHex('ff') === 255");
assert(parseHex("0xff") === 255, "parseHex('0xff') === 255");
assert(parseHex("not-hex") === null, "parseHex invalid returns null");
assert(parseHex("") === 0, "parseHex empty string returns 0");
assert(RESERVED_KEYS.has("test.suite.name"), "RESERVED_KEYS contains test.suite.name");
assert(RESERVED_KEYS.has("gen_ai.operation.name"), "RESERVED_KEYS contains gen_ai.operation.name");
assert(!RESERVED_KEYS.has("custom.key"), "RESERVED_KEYS does not contain custom.key");

// ── 2. Op constants ─────────────────────────────────────────────────
console.log("\n=== 2. Op constants ===");

assert(Op.CHAT === "chat", "Op.CHAT");
assert(Op.INVOKE_AGENT === "invoke_agent", "Op.INVOKE_AGENT");
assert(Op.EXECUTE_TOOL === "execute_tool", "Op.EXECUTE_TOOL");
assert(Op.CREATE_AGENT === "create_agent", "Op.CREATE_AGENT");
assert(Op.RETRIEVAL === "retrieval", "Op.RETRIEVAL");
assert(Op.EMBEDDINGS === "embeddings", "Op.EMBEDDINGS");
assert(Op.GENERATE_CONTENT === "generate_content", "Op.GENERATE_CONTENT");
assert(Op.TEXT_COMPLETION === "text_completion", "Op.TEXT_COMPLETION");

// ── 3. observe() — sync function ────────────────────────────────────
console.log("\n=== 3. observe() — sync ===");
clear();

const syncAgent = observe({ name: "planner", op: Op.INVOKE_AGENT }, (query: string) => {
  return `plan for: ${query}`;
});

const result3 = syncAgent("build SDK");
assert(result3 === "plan for: build SDK", "sync function returns correct value");

let spans = exporter.getFinishedSpans();
assert(spans.length === 1, "one span created");
assert(spans[0].name === "invoke_agent planner", "span name = 'invoke_agent planner'");
assert(spans[0].attributes["gen_ai.operation.name"] === "invoke_agent", "gen_ai.operation.name set");
assert(spans[0].attributes["gen_ai.agent.name"] === "planner", "gen_ai.agent.name set");

// Check input capture — param name extraction is best-effort;
// the value itself must be present regardless of key naming
const input3raw = spans[0].attributes["gen_ai.input.messages"] as string;
const input3 = JSON.parse(input3raw);
const input3ok = input3.query === "build SDK" || input3 === "build SDK";
assert(input3ok, "input captured correctly");

// Check output capture
const output3 = JSON.parse(spans[0].attributes["gen_ai.output.messages"] as string);
assert(output3 === "plan for: build SDK", "output captured correctly");

// ── 4. observe() — async function ───────────────────────────────────
console.log("\n=== 4. observe() — async ===");
clear();

const asyncAgent = observe({ name: "async-planner", op: Op.INVOKE_AGENT }, async (query: string) => {
  return `async plan for: ${query}`;
});

const result4 = await asyncAgent("test async");
assert(result4 === "async plan for: test async", "async function returns correct value");
spans = exporter.getFinishedSpans();
assert(spans.length === 1, "one span created for async");
assert(spans[0].name === "invoke_agent async-planner", "async span name correct");

// ── 5. observe() — bare usage ────────────────────────────────────────
console.log("\n=== 5. observe() — bare ===");
clear();

const bareFn = observe(function myFunc(x: number) { return x * 2; });
const result5 = bareFn(21);
assert(result5 === 42, "bare observe returns correct value");
spans = exporter.getFinishedSpans();
assert(spans[0].name === "myFunc", "bare observe uses function name");

// ── 6. observe() — execute_tool ──────────────────────────────────────
console.log("\n=== 6. observe() — execute_tool ===");
clear();

const myTool = observe({ name: "calculator", op: Op.EXECUTE_TOOL }, (a: number, b: number) => a + b);
const result6 = myTool(3, 4);
assert(result6 === 7, "tool returns correct value");
spans = exporter.getFinishedSpans();
assert(spans[0].name === "execute_tool calculator", "tool span name");
assert(spans[0].attributes["gen_ai.tool.name"] === "calculator", "gen_ai.tool.name set");
assert(spans[0].attributes["gen_ai.tool.type"] === "function", "gen_ai.tool.type = function");
assert(spans[0].attributes["gen_ai.tool.call.arguments"] !== undefined, "tool args captured as gen_ai.tool.call.arguments");
assert(spans[0].attributes["gen_ai.tool.call.result"] !== undefined, "tool result captured as gen_ai.tool.call.result");

// ── 7. observe() — error handling ────────────────────────────────────
console.log("\n=== 7. observe() — error handling ===");
clear();

const errorFn = observe({ name: "fail", op: Op.INVOKE_AGENT }, () => {
  throw new Error("intentional error");
});

let caught = false;
try {
  errorFn();
} catch (e: any) {
  caught = true;
  assert(e.message === "intentional error", "error is re-thrown");
}
assert(caught, "error was caught");
spans = exporter.getFinishedSpans();
assert(spans[0].status.code === 2, "span status is ERROR (code 2)");
assert(spans[0].events.some(e => e.name === "exception"), "exception event recorded");

// ── 8. observe() — parent-child nesting ──────────────────────────────
console.log("\n=== 8. observe() — parent-child ===");
clear();

const child = observe({ name: "child-tool", op: Op.EXECUTE_TOOL }, (msg: string) => msg.toUpperCase());
const parent = observe({ name: "parent-agent", op: Op.INVOKE_AGENT }, (msg: string) => child(msg));
parent("hello");

spans = exporter.getFinishedSpans();
assert(spans.length === 2, "two spans created (parent + child)");
const childSpan = spans.find(s => s.name.includes("child-tool"))!;
const parentSpan = spans.find(s => s.name.includes("parent-agent"))!;
assert(childSpan.parentSpanId === parentSpan.spanContext().spanId, "child's parent is the parent span");
assert(childSpan.spanContext().traceId === parentSpan.spanContext().traceId, "same trace ID");

// ── 9. observe() — nameFrom dynamic naming ──────────────────────────
console.log("\n=== 9. observe() — nameFrom ===");
clear();

const dispatcher = observe(
  { op: Op.EXECUTE_TOOL, nameFrom: "toolName" },
  (toolName: string, args: Record<string, unknown>) => "done"
);
dispatcher("web_search", { q: "hello" });
spans = exporter.getFinishedSpans();
assert(spans[0].name === "execute_tool web_search", "dynamic name from parameter");
assert(spans[0].attributes["gen_ai.tool.name"] === "web_search", "dynamic name in attribute");

// ── 10. withObserve() — context manager replacement ──────────────────
console.log("\n=== 10. withObserve() ===");
clear();

const result10 = withObserve("thinking", { op: Op.CHAT }, (span) => {
  span.setAttribute("custom.attr", "hello");
  return 42;
});
assert(result10 === 42, "withObserve returns callback result");
spans = exporter.getFinishedSpans();
assert(spans[0].name === "chat thinking", "withObserve span name");
assert(spans[0].attributes["custom.attr"] === "hello", "custom attribute set in withObserve");

// ── 11. withObserve() — async ────────────────────────────────────────
console.log("\n=== 11. withObserve() — async ===");
clear();

const result11 = await withObserve("async-block", { op: Op.INVOKE_AGENT }, async (span) => {
  return "async result";
});
assert(result11 === "async result", "async withObserve returns value");
spans = exporter.getFinishedSpans();
assert(spans[0].name === "invoke_agent async-block", "async withObserve span name");

// ── 12. enrich() ─────────────────────────────────────────────────────
console.log("\n=== 12. enrich() ===");
clear();

const enriched = observe({ name: "enriched-agent", op: Op.INVOKE_AGENT }, () => {
  enrich({
    model: "gpt-4.1",
    provider: "openai",
    inputTokens: 1500,
    outputTokens: 200,
    totalTokens: 1700,
    responseId: "chatcmpl-123",
    finishReason: "stop",
    temperature: 0.7,
    maxTokens: 1024,
    sessionId: "conv-001",
    agentId: "agent-001",
    agentDescription: "A helpful agent",
    systemInstructions: "You are helpful.",
  });
  return "ok";
});
enriched();

spans = exporter.getFinishedSpans();
const s12 = spans[0];
assert(s12.attributes["gen_ai.request.model"] === "gpt-4.1", "enrich: model");
assert(s12.attributes["gen_ai.provider.name"] === "openai", "enrich: provider");
assert(s12.attributes["gen_ai.usage.input_tokens"] === 1500, "enrich: input_tokens");
assert(s12.attributes["gen_ai.usage.output_tokens"] === 200, "enrich: output_tokens");
assert(s12.attributes["gen_ai.usage.total_tokens"] === 1700, "enrich: total_tokens");
assert(s12.attributes["gen_ai.response.id"] === "chatcmpl-123", "enrich: response_id");
assert(s12.attributes["gen_ai.request.temperature"] === 0.7, "enrich: temperature");
assert(s12.attributes["gen_ai.request.max_tokens"] === 1024, "enrich: max_tokens");
assert(s12.attributes["gen_ai.conversation.id"] === "conv-001", "enrich: session_id");
assert(s12.attributes["gen_ai.agent.id"] === "agent-001", "enrich: agent_id");
assert(s12.attributes["gen_ai.agent.description"] === "A helpful agent", "enrich: agent_description");
assert(s12.attributes["gen_ai.system_instructions"] === "You are helpful.", "enrich: system_instructions");

// Check finish_reasons is an array
const finishReasons = s12.attributes["gen_ai.response.finish_reasons"];
assert(Array.isArray(finishReasons) && finishReasons[0] === "stop", "enrich: finish_reasons is array ['stop']");

// ── 13. enrich() — extra kwargs ──────────────────────────────────────
console.log("\n=== 13. enrich() — extra kwargs ===");
clear();

const extraEnrich = observe({ name: "extra", op: Op.INVOKE_AGENT }, () => {
  enrich({ model: "gpt-4", destination: "Paris", tier: "premium" } as any);
  return "ok";
});
extraEnrich();
spans = exporter.getFinishedSpans();
assert(spans[0].attributes["destination"] === "Paris", "enrich: extra kwarg 'destination'");
assert(spans[0].attributes["tier"] === "premium", "enrich: extra kwarg 'tier'");

// ── 14. enrich() — no span (no-op) ──────────────────────────────────
console.log("\n=== 14. enrich() — no span ===");
clear();

enrich({ model: "gpt-4" }); // Should not throw
assert(exporter.getFinishedSpans().length === 0, "enrich outside span is no-op");

// ── 15. score() — standalone ─────────────────────────────────────────
console.log("\n=== 15. score() — standalone ===");
clear();

score({ name: "relevance", value: 0.9 });
spans = exporter.getFinishedSpans();
assert(spans.length === 1, "score creates one span");
assert(spans[0].name === "evaluation relevance", "score span name");
assert(spans[0].attributes["gen_ai.operation.name"] === "evaluation", "score: operation.name");
assert(spans[0].attributes["gen_ai.evaluation.name"] === "relevance", "score: evaluation.name");
assert(spans[0].attributes["gen_ai.evaluation.score.value"] === 0.9, "score: value");
assert(spans[0].events[0].name === "gen_ai.evaluation.result", "score: event emitted");

// ── 16. score() — with label, explanation, responseId ────────────────
console.log("\n=== 16. score() — full attributes ===");
clear();

score({
  name: "helpfulness",
  value: 0.83,
  label: "Very helpful",
  explanation: "Good response",
  responseId: "resp_123",
  attributes: { "test.suite.run.id": "run_001" },
});
spans = exporter.getFinishedSpans();
assert(spans[0].attributes["gen_ai.evaluation.score.label"] === "Very helpful", "score: label");
assert(spans[0].attributes["gen_ai.evaluation.explanation"] === "Good response", "score: explanation");
assert(spans[0].attributes["gen_ai.response.id"] === "resp_123", "score: responseId");
assert(spans[0].attributes["test.suite.run.id"] === "run_001", "score: passthrough attributes");

// ── 17. score() — span-level (traceId + spanId) ─────────────────────
console.log("\n=== 17. score() — span-level ===");
clear();

const TRACE_ID = "6ebb9835f43af1552f2cebb9f5165e39";
const SPAN_ID = "89829115c2128845";
score({ name: "accuracy", value: 0.95, traceId: TRACE_ID, spanId: SPAN_ID });
spans = exporter.getFinishedSpans();
assert(spans[0].spanContext().traceId === TRACE_ID, "score: joins evaluated trace");
assert(spans[0].parentSpanId === SPAN_ID, "score: parent is evaluated span");

// ── 18. score() — trace-level (traceId only) ─────────────────────────
console.log("\n=== 18. score() — trace-level ===");
clear();

score({ name: "relevance", value: 0.92, traceId: TRACE_ID });
spans = exporter.getFinishedSpans();
assert(spans[0].spanContext().traceId === TRACE_ID, "score: joins trace");
const expectedSpanId = TRACE_ID.slice(16); // lower 64 bits
assert(spans[0].parentSpanId === expectedSpanId, "score: parent derived from trace_id lower 64 bits");

// ── 19. Benchmark — basic usage ──────────────────────────────────────
console.log("\n=== 19. Benchmark ===");
clear();

const bench = new Benchmark("rag-v2", { metadata: { model: "gpt-4" } });
bench.log({ input: "What is Python?", output: "A language", scores: { accuracy: 1.0 } });
bench.log({ input: "What is JS?", output: "A language", scores: { accuracy: 0.8 } });
const summary = bench.close();

assert(summary.benchmarkName === "rag-v2", "benchmark: name");
assert(summary.totalCases === 2, "benchmark: totalCases");
assert(summary.errorCount === 0, "benchmark: no errors");
assert(summary.scores["accuracy"].avg === 0.9, "benchmark: accuracy avg = 0.9");
assert(summary.scores["accuracy"].min === 0.8, "benchmark: accuracy min = 0.8");
assert(summary.scores["accuracy"].max === 1.0, "benchmark: accuracy max = 1.0");
assert(summary.runId.startsWith("run_"), "benchmark: runId starts with run_");

spans = exporter.getFinishedSpans();
const rootSpan = spans.find(s => s.name.includes("test_suite_run"))!;
const caseSpans = spans.filter(s => s.name === "test_case");
assert(rootSpan !== undefined, "benchmark: root span exists");
assert(rootSpan.attributes["test.suite.name"] === "rag-v2", "benchmark: root suite name");
assert(rootSpan.attributes["model"] === "gpt-4", "benchmark: metadata on root span");
assert(caseSpans.length === 2, "benchmark: 2 case spans");
assert(caseSpans.every(s => s.parentSpanId === rootSpan.spanContext().spanId), "benchmark: cases are children of root");

// ── 20. Benchmark — error case ───────────────────────────────────────
console.log("\n=== 20. Benchmark — error ===");
clear();

const bench2 = new Benchmark("err-bench");
bench2.log({ input: "q1", error: "boom" });
const sum2 = bench2.close();
assert(sum2.errorCount === 1, "benchmark: error counted");
spans = exporter.getFinishedSpans();
const rootSpan2 = spans.find(s => s.name.includes("test_suite_run"))!;
assert(rootSpan2.attributes["test.suite.run.status"] === "fail", "benchmark: root status fail");

// ── 21. evaluate() ───────────────────────────────────────────────────
console.log("\n=== 21. evaluate() ===");
clear();

function myTask(input: unknown): string {
  return `answer to ${input}`;
}

function accuracy(input: unknown, output: unknown, expected: unknown) {
  return { name: "accuracy", value: String(output).includes(String(expected)) ? 1.0 : 0.0 };
}

const evalResult = evaluate({
  name: "eval-test",
  task: myTask,
  data: [
    { input: "q1", expected: "q1" },
    { input: "q2", expected: "q2" },
  ],
  scores: [accuracy],
});

assert(evalResult.summary.totalCases === 2, "evaluate: 2 cases");
assert(evalResult.summary.scores["accuracy"].avg === 1.0, "evaluate: accuracy avg = 1.0");
assert(evalResult.cases.length === 2, "evaluate: 2 case results");
assert(evalResult.cases.every(c => c.status === "pass"), "evaluate: all cases pass");

// ── 22. evaluate() — task error ──────────────────────────────────────
console.log("\n=== 22. evaluate() — task error ===");
clear();

const evalResult2 = evaluate({
  name: "err-eval",
  task: () => { throw new Error("task failed"); },
  data: [{ input: "q1" }],
  scores: [],
});
assert(evalResult2.summary.errorCount === 1, "evaluate: error counted");
assert(evalResult2.cases[0].status === "fail", "evaluate: case failed");
assert(evalResult2.cases[0].error === "task failed", "evaluate: error message captured");

// ── 23. register() — default endpoint ────────────────────────────────
console.log("\n=== 23. register() ===");

assert(DEFAULT_ENDPOINT === "http://localhost:21890/opentelemetry/v1/traces", "DEFAULT_ENDPOINT value");

// ── 24. Retrieval — parseMessages ────────────────────────────────────
console.log("\n=== 24. Retrieval — parseMessages ===");

const msgs = parseMessages(JSON.stringify([
  { role: "user", parts: [{ type: "text", content: "hello" }] },
  { role: "assistant", parts: [{ type: "text", content: "hi there" }] },
]));
assert(msgs.length === 2, "parseMessages: 2 messages");
assert(msgs[0].role === "user", "parseMessages: user role");
assert(msgs[0].content === "hello", "parseMessages: user content");
assert(msgs[1].role === "assistant", "parseMessages: assistant role");

assert(parseMessages(null).length === 0, "parseMessages: null returns []");
assert(parseMessages("").length === 0, "parseMessages: empty string returns []");
assert(parseMessages("invalid json").length === 0, "parseMessages: invalid JSON returns []");

// ── 25. Retrieval — mapSpanDoc ───────────────────────────────────────
console.log("\n=== 25. Retrieval — mapSpanDoc ===");

const spanDoc = mapSpanDoc({
  traceId: "abc123",
  spanId: "span1",
  parentSpanId: "parent1",
  name: "invoke_agent Weather",
  startTime: "2026-01-01T00:00:00Z",
  endTime: "2026-01-01T00:00:01Z",
  attributes: {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "Weather",
    "gen_ai.request.model": "claude-sonnet-4",
    "gen_ai.usage.input_tokens": 100,
    "gen_ai.usage.output_tokens": 50,
  },
});
assert(spanDoc.traceId === "abc123", "mapSpanDoc: traceId");
assert(spanDoc.operationName === "invoke_agent", "mapSpanDoc: operationName");
assert(spanDoc.agentName === "Weather", "mapSpanDoc: agentName");
assert(spanDoc.model === "claude-sonnet-4", "mapSpanDoc: model");
assert(spanDoc.inputTokens === 100, "mapSpanDoc: inputTokens");
assert(spanDoc.outputTokens === 50, "mapSpanDoc: outputTokens");

// ── 26. Retrieval — extractMessagesFromDoc ───────────────────────────
console.log("\n=== 26. Retrieval — extractMessagesFromDoc ===");

const doc26 = {
  attributes: {
    "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: "q" }] }]),
    "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: "a" }] }]),
  },
};
const { inputMessages: in26, outputMessages: out26 } = extractMessagesFromDoc(doc26);
assert(in26[0].content === "q", "extractMessages: input from attrs");
assert(out26[0].content === "a", "extractMessages: output from attrs");

// ── 27. AWSSigV4OTLPExporter — init ──────────────────────────────────
console.log("\n=== 27. AWSSigV4OTLPExporter ===");

let sigv4Error = false;
try {
  new AWSSigV4OTLPExporter({ endpoint: "https://pipeline.us-east-1.osis.amazonaws.com/v1/traces" });
  // If no region env var, should throw
} catch (e: any) {
  sigv4Error = e.message.includes("No AWS region");
}
// It should throw if no region is set
assert(sigv4Error || process.env.AWS_DEFAULT_REGION !== undefined || process.env.AWS_REGION !== undefined, "AWSSigV4OTLPExporter: throws without region or has region env var");

// With explicit region, should construct
const sigv4 = new AWSSigV4OTLPExporter({
  endpoint: "https://pipeline.us-east-1.osis.amazonaws.com/v1/traces",
  region: "us-east-1",
  service: "osis",
});
assert(sigv4 !== null, "AWSSigV4OTLPExporter: constructs with explicit region");

// ── Summary ──────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log(`  VERIFICATION COMPLETE: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  process.exit(1);
}
