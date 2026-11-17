// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { createContextKey, trace, type Context, type SpanContext } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AGENT_NAME_KEY, AGENT_VERSION_KEY, ensureContextManager, spanAttributes } from './internal.js';

/**
 * The test case evaluate() is running right now.
 *
 * The case is put in the OTel context the task runs in (TEST_CASE_KEY). With a
 * context manager (register() installs one on Node) it follows the task across
 * `await`, and spans started in that context belong to the case. A span
 * started in a context without a case (an HTTP handler's
 * `propagation.extract(ROOT_CONTEXT, headers)`, `context.with(ROOT_CONTEXT, ...)`,
 * a callback bound before the case) is attached to the case only when exactly
 * one case is running and the span has no local parent (no parent, or a
 * remote one). With overlapping evaluate() runs such a span is not guessed at:
 * the agent must then start inside the task's context. evaluate() installs
 * `AsyncLocalStorageContextManager` on Node when no context manager is set.
 * Where none can be installed the context is lost at once, so every span is
 * parentless and the same rule applies: a lone case is stamped, overlapping
 * cases are not.
 */
export interface ActiveTestCase {
  attributes: Record<string, string>;
  /** First root span started while the case ran: the agent run's root span. */
  root?: SpanContext;
  /** That root span itself: its final attributes name the agent that ran. */
  rootSpan?: Span;
  /**
   * The root was attached as the only running case, not found in the task's context: a root
   * started in the task's context later replaces it.
   */
  rootAttached?: boolean;
  /** Span ids started while the case ran, to tell roots from their children. */
  readonly seen: Set<string>;
}

/** Cases running right now (see ActiveTestCase). */
const runningCases = new Set<ActiveTestCase>();

const AGENT_KEYS: ReadonlySet<string> = new Set([AGENT_NAME_KEY, AGENT_VERSION_KEY]);

/** @internal Context key of the case a task runs in. */
export const TEST_CASE_KEY = createContextKey('opensearch-genai-observability-sdk.testCase');

/**
 * @internal Mark `testCase` as running. Returns a function that ends it; call
 * it once the task has settled.
 */
export function enterTestCase(testCase: ActiveTestCase): () => void {
  runningCases.add(testCase);
  return () => {
    runningCases.delete(testCase);
  };
}

/** The only running case, when exactly one runs. */
function onlyRunningCase(): ActiveTestCase | undefined {
  if (runningCases.size !== 1) return undefined;
  return runningCases.values().next().value;
}

function parentSpanId(span: Span): string | undefined {
  const s = span as unknown as { parentSpanId?: string; parentSpanContext?: SpanContext };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

/** Whether a span with parent span id `parent` has a parent in this process (not a remote one). */
function hasLocalParent(parent: string | undefined, parentContext: Context | undefined): boolean {
  if (!parent) return false;
  return parentContext ? trace.getSpanContext(parentContext)?.isRemote !== true : true;
}

/**
 * Span processor that stamps `test.suite.name`, `test.suite.run.id`,
 * `test.case.id` and `test.case.name` on the root span(s) of each test case
 * while evaluate() runs it, and remembers the first root span so the case's
 * score events are parented to it.
 *
 * A span belongs to a case when it starts in the task's context, or, when
 * exactly one case is running, when it starts in a context without a case and
 * has no local parent (no parent, or a remote parent such as one read from
 * incoming request headers). It is a case root when it has no parent, or when
 * its parent was not started inside the same case (a remote parent). A root
 * started in the task's context wins the case trace over one attached as the
 * only running case. Without a context manager (none could be installed)
 * every span is a root, so a lone case stamps all of them and uses the first
 * one as the trace context.
 *
 * register() installs it. evaluate() also adds it to the global
 * BasicTracerProvider (OTel JS 1.x) when missing. With a provider that cannot
 * take processors after construction (OTel JS 2.x), pass it yourself:
 * `new BasicTracerProvider({ spanProcessors: [new TestCaseSpanProcessor(), ...] })`.
 */
export class TestCaseSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const parent = parentSpanId(span);
    const fromContext = parentContext?.getValue(TEST_CASE_KEY) as ActiveTestCase | undefined;
    const testCase = fromContext ?? (hasLocalParent(parent, parentContext) ? undefined : onlyRunningCase());
    if (!testCase) return;

    const ctx = span.spanContext();
    const isRoot = !parent || !testCase.seen.has(parent);
    testCase.seen.add(ctx.spanId);
    if (!isRoot) return;

    const existing = spanAttributes(span) ?? {};
    for (const [key, value] of Object.entries(testCase.attributes)) {
      // The agent's own identity on its span wins over the declared one.
      if (AGENT_KEYS.has(key) && existing[key] !== undefined) continue;
      span.setAttribute(key, value);
    }
    if (!testCase.root || (testCase.rootAttached && fromContext)) {
      testCase.root = { traceId: ctx.traceId, spanId: ctx.spanId, traceFlags: ctx.traceFlags };
      testCase.rootSpan = span;
      testCase.rootAttached = !fromContext;
    }
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const instrumented = new WeakSet<object>();
let missingWarned = false;

interface ProcessorHost {
  addSpanProcessor(processor: SpanProcessor): void;
  _registeredSpanProcessors?: SpanProcessor[];
}

/** @internal Add a TestCaseSpanProcessor to `provider` once. Returns false if it cannot. */
export function installTestCaseProcessor(provider: unknown): boolean {
  if (!provider || typeof provider !== 'object') return false;
  if (instrumented.has(provider)) return true;
  const host = provider as Partial<ProcessorHost>;
  if (host._registeredSpanProcessors?.some(p => p instanceof TestCaseSpanProcessor)) {
    instrumented.add(provider);
    return true;
  }
  if (typeof host.addSpanProcessor !== 'function') return false;
  host.addSpanProcessor(new TestCaseSpanProcessor());
  instrumented.add(provider);
  return true;
}

/**
 * @internal Make sure the global tracer provider stamps test case root spans, and (on Node) that
 * a context manager carries the case across `await`.
 */
export function ensureGlobalTestCaseProcessor(): void {
  ensureContextManager();
  const global = trace.getTracerProvider() as unknown as { getDelegate?: () => unknown };
  const delegate = typeof global.getDelegate === 'function' ? global.getDelegate() : global;
  if (instrumented.has(delegate as object)) return;
  if (installTestCaseProcessor(delegate)) return;
  // No SDK provider registered: there are no spans to stamp.
  if ((delegate as object | undefined)?.constructor?.name === 'NoopTracerProvider') return;
  if (missingWarned) return;
  missingWarned = true;
  console.warn(
    "[opensearch-genai-observability-sdk-ts] evaluate(): could not add TestCaseSpanProcessor to " +
      "the global tracer provider, so agent root spans are not stamped with test.* attributes " +
      "and score events have no trace context. Add new TestCaseSpanProcessor() to your provider.",
  );
}
