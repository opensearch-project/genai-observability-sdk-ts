// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import {
  createContextKey,
  ROOT_CONTEXT,
  TraceFlags,
  type Context,
} from "@opentelemetry/api";
import { logs, type Logger, type LoggerProvider } from "@opentelemetry/api-logs";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import { SDK_SCOPE_NAME, SDK_VERSION } from "./version.js";

/**
 * LoggerProvider created by register(). score() prefers it over the global
 * provider so that register({ setGlobal: false }) still exports evaluation
 * events. When register() finds a user-configured global LoggerProvider it
 * does not create one, and score() uses the global provider.
 */
let sdkLoggerProvider: LoggerProvider | undefined;

export function setSdkLoggerProvider(provider: LoggerProvider | undefined): void {
  sdkLoggerProvider = provider;
}

export function getSdkLoggerProvider(): LoggerProvider | undefined {
  return sdkLoggerProvider;
}

/** The provider score() emits through: the one from register(), else the global one. */
export function resolveLoggerProvider(): LoggerProvider {
  return sdkLoggerProvider ?? logs.getLoggerProvider();
}

const GLOBAL_LOGS_API_KEY = Symbol.for("io.opentelemetry.js.api.logs");

/** True when any OTel JS logs API version has registered a global LoggerProvider. */
export function hasGlobalLoggerProvider(): boolean {
  return (globalThis as Record<symbol, unknown>)[GLOBAL_LOGS_API_KEY] !== undefined;
}

/**
 * Logger for SDK events. The instrumentation scope is the library that emitted
 * the event: always the SDK name and version, with no scope attributes. The
 * evaluator is an attribute of the result (`opensearch.gen_ai.evaluation.evaluator.*`).
 */
export function getEventLogger(): Logger {
  return resolveLoggerProvider().getLogger(SDK_SCOPE_NAME, SDK_VERSION);
}

const TRACE_ONLY_KEY = createContextKey("opensearch-genai-observability-sdk-ts.trace_only_id");

/** Context of a trace-level event: the evaluated trace, no span. */
export function traceOnlyContext(traceId: string): Context {
  return ROOT_CONTEXT.setValue(TRACE_ONLY_KEY, traceId);
}

let traceOnlyHandled = false;

/** True (once) when a TraceOnlyContextProcessor set the trace id of the last trace-level event. */
export function takeTraceOnlyHandled(): boolean {
  const handled = traceOnlyHandled;
  traceOnlyHandled = false;
  return handled;
}

/**
 * Sets the log record's own trace id, with no span id, for trace-level events
 * (`score({ traceId })` without `spanId`). The OTel JS SDK only takes a trace
 * context from a valid span context, so the SDK needs this to record the trace
 * id without inventing a span id. `register()` installs it; add it to your own
 * LoggerProvider's processors if you configure one yourself.
 */
export class TraceOnlyContextProcessor implements LogRecordProcessor {
  onEmit(logRecord: SdkLogRecord, context?: Context): void {
    const traceId = context?.getValue(TRACE_ONLY_KEY);
    if (typeof traceId !== "string" || logRecord.spanContext) return;
    logRecord.spanContext = { traceId, spanId: "", traceFlags: TraceFlags.NONE };
    traceOnlyHandled = true;
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
