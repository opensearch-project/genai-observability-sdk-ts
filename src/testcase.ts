// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { createContextKey, trace, type Context, type SpanContext } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AGENT_NAME_KEY, AGENT_VERSION_KEY, hasContextManager } from './internal.js';

/**
 * The test case evaluate() is running right now.
 *
 * The case is put in the OTel context the task runs in (TEST_CASE_KEY). With a
 * context manager (register() installs one on Node) it follows the task across
 * `await`, and only spans started in that context belong to the case: a timer,
 * poller or another request started outside it is never stamped. Without a
 * context manager the context is lost at once, so evaluate() then also keeps
 * a module-level "current case" until the task settles. That fallback is used
 * only while exactly one case is running: with overlapping evaluate() runs and
 * no context manager no span can be told apart, so none is stamped.
 */
export interface ActiveTestCase {
  attributes: Record<string, string>;
  /** First root span started while the case ran: the agent run's root span. */
  root?: SpanContext;
  /** That root span itself: its final attributes name the agent that ran. */
  rootSpan?: Span;
  /** Span ids started while the case ran, to tell roots from their children. */
  readonly seen: Set<string>;
}

/** Cases running without a context manager (see ActiveTestCase). */
const fallbackCases = new Set<ActiveTestCase>();
let overlapWarned = false;

const AGENT_KEYS: ReadonlySet<string> = new Set([AGENT_NAME_KEY, AGENT_VERSION_KEY]);

/** @internal Context key of the case a task runs in. */
export const TEST_CASE_KEY = createContextKey('opensearch-genai-observability-sdk.testCase');

/**
 * @internal Make `testCase` the current case. Returns a function that restores
 * the previous one; call it once the task has settled.
 */
export function enterTestCase(testCase: ActiveTestCase): () => void {
  // With a context manager the case rides in the task's context only.
  if (hasContextManager()) return () => {};
  fallbackCases.add(testCase);
  if (fallbackCases.size > 1 && !overlapWarned) {
    overlapWarned = true;
    console.warn(
      "[opensearch-genai-observability-sdk-ts] evaluate(): test cases overlap and no OTel context " +
        "manager is set, so their spans cannot be told apart and are not stamped with test.* " +
        "attributes. Call register() (it installs one on Node) or run one evaluate() at a time.",
    );
  }
  return () => {
    fallbackCases.delete(testCase);
  };
}

/** The fallback case, when exactly one case runs without a context manager. */
function fallbackCase(): ActiveTestCase | undefined {
  if (fallbackCases.size !== 1) return undefined;
  return fallbackCases.values().next().value;
}

function parentSpanId(span: Span): string | undefined {
  const s = span as unknown as { parentSpanId?: string; parentSpanContext?: SpanContext };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

/**
 * Span processor that stamps `test.suite.name`, `test.suite.run.id`,
 * `test.case.id` and `test.case.name` on the root span(s) of each test case
 * while evaluate() runs it, and remembers the first root span so the case's
 * score events are parented to it.
 *
 * A span is a case root when it has no parent, or when its parent was not
 * started inside the same case (for example a remote parent). Without a context manager every span is a root,
 * so all of them are stamped and the first one is used as the trace context.
 *
 * register() installs it. evaluate() also adds it to the global
 * BasicTracerProvider (OTel JS 1.x) when missing. With a provider that cannot
 * take processors after construction (OTel JS 2.x), pass it yourself:
 * `new BasicTracerProvider({ spanProcessors: [new TestCaseSpanProcessor(), ...] })`.
 */
export class TestCaseSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const testCase = (parentContext?.getValue(TEST_CASE_KEY) as ActiveTestCase | undefined) ?? fallbackCase();
    if (!testCase) return;

    const ctx = span.spanContext();
    const parent = parentSpanId(span);
    const isRoot = !parent || !testCase.seen.has(parent);
    testCase.seen.add(ctx.spanId);
    if (!isRoot) return;

    const existing = (span as unknown as { attributes?: Record<string, unknown> }).attributes ?? {};
    for (const [key, value] of Object.entries(testCase.attributes)) {
      // The agent's own identity on its span wins over the declared one.
      if (AGENT_KEYS.has(key) && existing[key] !== undefined) continue;
      span.setAttribute(key, value);
    }
    if (!testCase.root) {
      testCase.root = { traceId: ctx.traceId, spanId: ctx.spanId, traceFlags: ctx.traceFlags };
      testCase.rootSpan = span;
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

/** @internal Make sure the global tracer provider stamps test case root spans. */
export function ensureGlobalTestCaseProcessor(): void {
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
