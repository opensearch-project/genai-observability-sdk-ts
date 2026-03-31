/**
 * End-to-end SDK test — exercises every public API feature
 * as a real user would, importing from the built package.
 *
 * Run: npx tsx e2e-test.ts
 */
import { Resource } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

// Import from the built dist — exactly how a user imports from the package
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
} from "./dist/index.js";

// ── In-memory provider for testing ──────────────────────────────────
const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();

const memExporter = new InMemorySpanExporter();
const testProvider = new BasicTracerProvider({
  resource: new Resource({ "service.name": "e2e-test" }),
});
testProvider.addSpanProcessor(new SimpleSpanProcessor(memExporter));
testProvider.register({ contextManager });

let passed = 0;
let failed = 0;

function check(ok: boolean, label: string) {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else    { failed++; console.log(`  FAIL  ${label}`); }
}

function reset() { memExporter.reset(); }
function spans() { return memExporter.getFinishedSpans(); }

// =====================================================================
// 1. observe() — wrap a sync function like a real agent
// =====================================================================
console.log("\n--- 1. observe() sync agent ---");
reset();

const weatherAgent = observe(
  { name: "weather", op: Op.INVOKE_AGENT },
  (city: string) => {
    enrich({ model: "gpt-4.1", provider: "openai", inputTokens: 50, outputTokens: 30 });
    return `Sunny in ${city}`;
  },
);

const weather = weatherAgent("Seattle");
check(weather === "Sunny in Seattle", "returns correct value");
check(spans().length === 1, "created 1 span");
check(spans()[0].name === "invoke_agent weather", "span name");
check(spans()[0].attributes["gen_ai.agent.name"] === "weather", "agent name attr");
check(spans()[0].attributes["gen_ai.request.model"] === "gpt-4.1", "enriched model");
check(spans()[0].attributes["gen_ai.usage.input_tokens"] === 50, "enriched input tokens");

// =====================================================================
// 2. observe() — async function
// =====================================================================
console.log("\n--- 2. observe() async ---");
reset();

const asyncChat = observe(
  { name: "async-chat", op: Op.CHAT },
  async (msg: string) => {
    await new Promise(r => setTimeout(r, 10));
    return `Reply: ${msg}`;
  },
);

const reply = await asyncChat("hello");
check(reply === "Reply: hello", "async returns value");
check(spans()[0].name === "chat async-chat", "async span name");

// =====================================================================
// 3. observe() — tool execution
// =====================================================================
console.log("\n--- 3. observe() tool ---");
reset();

const calcTool = observe(
  { name: "calculator", op: Op.EXECUTE_TOOL },
  (a: number, b: number) => a + b,
);

check(calcTool(3, 4) === 7, "tool returns 7");
check(spans()[0].attributes["gen_ai.tool.name"] === "calculator", "tool name attr");
check(spans()[0].attributes["gen_ai.tool.type"] === "function", "tool type attr");
check(spans()[0].attributes["gen_ai.tool.call.result"] !== undefined, "tool result captured");

// =====================================================================
// 4. observe() — error handling
// =====================================================================
console.log("\n--- 4. observe() error ---");
reset();

const failing = observe({ name: "boom", op: Op.INVOKE_AGENT }, () => {
  throw new Error("kaboom");
});

let errCaught = false;
try { failing(); } catch (e: any) { errCaught = e.message === "kaboom"; }
check(errCaught, "error re-thrown");
check(spans()[0].status.code === 2, "span status ERROR");
check(spans()[0].events.some(e => e.name === "exception"), "exception event");

// =====================================================================
// 5. Parent-child nesting (context propagation)
// =====================================================================
console.log("\n--- 5. parent-child nesting ---");
reset();

const childTool = observe({ name: "search", op: Op.EXECUTE_TOOL }, (q: string) => `found: ${q}`);
const parentAgent = observe({ name: "orchestrator", op: Op.INVOKE_AGENT }, (q: string) => {
  return childTool(q);
});

parentAgent("opensearch");
const parentS = spans().find(s => s.name.includes("orchestrator"))!;
const childS = spans().find(s => s.name.includes("search"))!;
check(spans().length === 2, "2 spans");
check(childS.parentSpanId === parentS.spanContext().spanId, "child -> parent");
check(childS.spanContext().traceId === parentS.spanContext().traceId, "same trace");

// =====================================================================
// 6. withObserve() — block-level tracing
// =====================================================================
console.log("\n--- 6. withObserve() ---");
reset();

const blockResult = withObserve("processing", { op: Op.CHAT }, (span) => {
  span.setAttribute("step", "transform");
  return [1, 2, 3].map(x => x * 2);
});

check(JSON.stringify(blockResult) === "[2,4,6]", "returns value");
check(spans()[0].attributes["step"] === "transform", "custom attr set");

// =====================================================================
// 7. withObserve() — async
// =====================================================================
console.log("\n--- 7. withObserve() async ---");
reset();

const asyncBlock = await withObserve("fetch-data", async (_span) => {
  await new Promise(r => setTimeout(r, 5));
  return { status: "ok" };
});

check(asyncBlock.status === "ok", "async block returns value");
check(spans().length === 1, "1 span from async withObserve");

// =====================================================================
// 8. enrich() — all attributes
// =====================================================================
console.log("\n--- 8. enrich() full ---");
reset();

const enrichedFn = observe({ name: "enriched", op: Op.INVOKE_AGENT }, () => {
  enrich({
    model: "claude-sonnet-4",
    provider: "anthropic",
    inputTokens: 500,
    outputTokens: 200,
    totalTokens: 700,
    responseId: "resp-001",
    finishReason: "end_turn",
    temperature: 0.5,
    maxTokens: 2048,
    sessionId: "sess-001",
    agentId: "agent-001",
    agentDescription: "Helpful assistant",
    systemInstructions: "Be concise.",
  });
  return "done";
});
enrichedFn();

const s = spans()[0];
check(s.attributes["gen_ai.request.model"] === "claude-sonnet-4", "model");
check(s.attributes["gen_ai.provider.name"] === "anthropic", "provider");
check(s.attributes["gen_ai.usage.input_tokens"] === 500, "input tokens");
check(s.attributes["gen_ai.usage.output_tokens"] === 200, "output tokens");
check(s.attributes["gen_ai.usage.total_tokens"] === 700, "total tokens");
check(s.attributes["gen_ai.response.id"] === "resp-001", "response id");
check(s.attributes["gen_ai.request.temperature"] === 0.5, "temperature");
check(s.attributes["gen_ai.request.max_tokens"] === 2048, "max tokens");
check(s.attributes["gen_ai.conversation.id"] === "sess-001", "session id");
check(s.attributes["gen_ai.agent.id"] === "agent-001", "agent id");
check(s.attributes["gen_ai.agent.description"] === "Helpful assistant", "agent description");
check(s.attributes["gen_ai.system_instructions"] === "Be concise.", "system instructions");
const fr = s.attributes["gen_ai.response.finish_reasons"];
check(Array.isArray(fr) && fr[0] === "end_turn", "finish reasons array");

// =====================================================================
// 9. score() — standalone, span-level, trace-level
// =====================================================================
console.log("\n--- 9. score() ---");
reset();

score({ name: "relevance", value: 0.92, label: "High", explanation: "Good answer" });
check(spans().length === 1, "standalone score span");
check(spans()[0].attributes["gen_ai.evaluation.score.value"] === 0.92, "score value");
check(spans()[0].attributes["gen_ai.evaluation.score.label"] === "High", "score label");
check(spans()[0].events[0].name === "gen_ai.evaluation.result", "score event");

reset();
const TID = "abcdef1234567890abcdef1234567890";
const SID = "1234567890abcdef";
score({ name: "accuracy", value: 0.95, traceId: TID, spanId: SID });
check(spans()[0].spanContext().traceId === TID, "span-level trace id");
check(spans()[0].parentSpanId === SID, "span-level parent span id");

reset();
score({ name: "fluency", value: 0.88, traceId: TID });
check(spans()[0].parentSpanId === TID.slice(16), "trace-level derived parent");

// =====================================================================
// 10. Benchmark class
// =====================================================================
console.log("\n--- 10. Benchmark ---");
reset();

const bench = new Benchmark("qa-eval", { recordIo: true, metadata: { version: "1.0" } });
bench.log({ input: "q1", output: "a1", scores: { accuracy: 1.0 }, caseName: "case-1" });
bench.log({ input: "q2", output: "a2", scores: { accuracy: 0.7 }, caseName: "case-2" });
bench.log({ input: "q3", error: "timeout", caseName: "case-3" });
const summary = bench.close();

check(summary.benchmarkName === "qa-eval", "bench name");
check(summary.totalCases === 3, "3 cases");
check(summary.errorCount === 1, "1 error");
check(summary.scores["accuracy"].avg === 0.85, "avg accuracy 0.85");
check(summary.runId.startsWith("run_"), "run id");

const rootBench = spans().find(s => s.name.includes("test_suite_run"))!;
const caseSpans = spans().filter(s => s.name === "test_case");
check(rootBench !== undefined, "root span exists");
check(rootBench.attributes["test.suite.run.status"] === "fail", "suite status fail");
check(caseSpans.length === 3, "3 case spans");
check(caseSpans.every(cs => cs.parentSpanId === rootBench.spanContext().spanId), "cases are children");

// recordIo: true means IO is captured
const ioSpan = caseSpans.find(cs => cs.attributes["test.case.name"] === "case-1")!;
check(ioSpan.attributes["test.case.input"] !== undefined, "IO recorded when recordIo=true");

// =====================================================================
// 11. Benchmark — recordIo default is false
// =====================================================================
console.log("\n--- 11. Benchmark recordIo default ---");
reset();

const bench2 = new Benchmark("no-io");
bench2.log({ input: "q", output: "a" });
bench2.close();

const noIoSpan = spans().find(s => s.name === "test_case")!;
check(noIoSpan.attributes["test.case.input"] === undefined, "IO NOT recorded by default");

// =====================================================================
// 12. evaluate()
// =====================================================================
console.log("\n--- 12. evaluate() ---");
reset();

const evalResult = evaluate({
  name: "my-eval",
  task: (input) => `answer: ${input}`,
  data: [
    { input: "q1", expected: "answer: q1" },
    { input: "q2", expected: "answer: q2" },
  ],
  scores: [
    function exactMatch(_i: unknown, output: unknown, expected: unknown) {
      return { name: "exact", value: output === expected ? 1.0 : 0.0 };
    },
  ],
  recordIo: true,
});

check(evalResult.summary.totalCases === 2, "eval 2 cases");
check(evalResult.summary.scores["exact"].avg === 1.0, "eval perfect scores");
check(evalResult.cases.every(c => c.status === "pass"), "all pass");

// =====================================================================
// 13. evaluate() — task error
// =====================================================================
console.log("\n--- 13. evaluate() error ---");
reset();

const errEval = evaluate({
  name: "err-eval",
  task: () => { throw new Error("broken"); },
  data: [{ input: "x" }],
  scores: [],
});

check(errEval.cases[0].status === "fail", "failed case status");
check(errEval.cases[0].error === "broken", "error message");
check(errEval.summary.errorCount === 1, "error counted");

// =====================================================================
// 14. register() — default endpoint
// =====================================================================
console.log("\n--- 14. register() ---");
check(DEFAULT_ENDPOINT === "http://localhost:21890/opentelemetry/v1/traces", "default endpoint");

// =====================================================================
// 15. AWSSigV4OTLPExporter
// =====================================================================
console.log("\n--- 15. AWSSigV4OTLPExporter ---");

const sigv4 = new AWSSigV4OTLPExporter({
  endpoint: "https://pipeline.us-east-1.osis.amazonaws.com/v1/traces",
  region: "us-east-1",
  service: "osis",
});
check(sigv4 !== null, "constructs with explicit region");
check(typeof sigv4.export === "function", "has export method");
check(typeof sigv4.shutdown === "function", "has shutdown method");

// =====================================================================
// 16. OpenSearchTraceRetriever — constructor
// =====================================================================
console.log("\n--- 16. OpenSearchTraceRetriever ---");

let retrieverOk = false;
try {
  const _r = new OpenSearchTraceRetriever({ host: "https://localhost:9200" });
  retrieverOk = true;
} catch (e: any) {
  // Expected: opensearch package may not be available
  retrieverOk = e.message.includes("required for OpenSearchTraceRetriever");
}
check(retrieverOk, "retriever constructs or gives helpful error");

// =====================================================================
// 17. Async generator support
// =====================================================================
console.log("\n--- 17. async generator ---");
reset();

const streamingAgent = observe(
  { name: "streamer", op: Op.CHAT },
  async function* (prompt: string) {
    yield "chunk1";
    yield "chunk2";
    yield "chunk3";
  },
);

const chunks: string[] = [];
for await (const chunk of streamingAgent("test")) {
  chunks.push(chunk);
}
check(chunks.length === 3, "3 chunks yielded");
check(chunks.join(",") === "chunk1,chunk2,chunk3", "correct chunk values");
check(spans().length === 1, "1 span for generator");
check(spans()[0].name === "chat streamer", "generator span name");

// =====================================================================
// Summary
// =====================================================================
console.log("\n" + "=".repeat(60));
console.log(`  E2E TEST COMPLETE: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) process.exit(1);
