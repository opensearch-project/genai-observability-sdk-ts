// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import {
  trace,
  context as otelContext,
  ROOT_CONTEXT,
  TraceFlags,
  type Context,
  type Attributes,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import {
  AGENT_NAME_KEY,
  AGENT_VERSION_KEY,
  normalizeSpanId,
  normalizeTraceId,
  resolveAgent,
} from './internal.js';
import { getEventLogger, takeTraceOnlyHandled, traceOnlyContext } from './logs.js';

/** OTel event name of an evaluation result (semantic-conventions-genai). */
export const EVALUATION_RESULT_EVENT = "gen_ai.evaluation.result";

const EXPLANATION_LIMIT = 500;

export type EvaluationLevel = "span" | "trace" | "session" | "tool_call";
export type EvaluatorType = "llm_judge" | "code" | "human" | "external";
export type ScoreDirection = "maximize" | "minimize";
/** A verdict, recorded as `gen_ai.evaluation.score.label`. */
export type Verdict = "pass" | "fail";
const VERDICTS: readonly Verdict[] = ["pass", "fail"];

export interface ScoreOptions {
  /** `gen_ai.evaluation.name` (required), for example `"relevance"`. */
  name: string;
  /**
   * `gen_ai.evaluation.score.value` (a double in OTel semconv). The SDK's OTLP
   * log exporters send whole numbers as `doubleValue` too; see README.
   */
  value?: number;
  /** Trace of the evaluated span. Without `spanId` the score is trace-level. */
  traceId?: string;
  /** Evaluated span. Requires `traceId`. */
  spanId?: string;
  /**
   * `gen_ai.evaluation.score.label`, low cardinality. `"pass"` / `"fail"` (any
   * case) is the verdict; without a label, `value` plus `threshold` records one.
   */
  label?: string;
  /** `gen_ai.evaluation.explanation` (truncated to 500 chars). */
  explanation?: string;
  /** `gen_ai.response.id` of the evaluated response, only if known. */
  responseId?: string;
  /** `opensearch.evaluation.level`. Defaults to `"trace"` for trace-level scores. */
  level?: EvaluationLevel;
  /**
   * Evaluator identity: instrumentation scope name of the event and
   * `opensearch.evaluation.evaluator.name`. Without it the scope is the SDK
   * scope (`opensearch-genai-observability-sdk-ts` + SDK version).
   */
  evaluator?: string;
  /** Instrumentation scope version (with `evaluator`) and `opensearch.evaluation.evaluator.version`. */
  evaluatorVersion?: string;
  /** `opensearch.evaluation.evaluator.type`. */
  evaluatorType?: EvaluatorType;
  /** `opensearch.evaluation.score.direction`. */
  direction?: ScoreDirection;
  /** `opensearch.evaluation.score.min`. */
  scoreMin?: number;
  /** `opensearch.evaluation.score.max`. */
  scoreMax?: number;
  /**
   * `opensearch.evaluation.score.threshold`: pass when `value >= threshold`
   * (`direction` `"maximize"`, the default with a threshold and recorded) or
   * `value <= threshold` (`"minimize"`).
   */
  threshold?: number;
  /** `gen_ai.conversation.id` (session-scoped evaluations). */
  conversationId?: string;
  /**
   * `gen_ai.agent.name` of the evaluated agent. Default: the active span's own
   * `gen_ai.agent.name` (inline scoring), else `register({ agentName })`.
   */
  agentName?: string;
  /** `gen_ai.agent.version` of the evaluated agent, resolved the same way. */
  agentVersion?: string;
  /** `error.type` when the evaluator failed. */
  errorType?: string;
  /** `opensearch.evaluation.judge.trace_id`: the judge's own trace. */
  judgeTraceId?: string;
  /** Extra attributes (string, number, boolean). Explicit options take precedence. */
  attributes?: Record<string, unknown>;
}

interface Target {
  /** Context to parent the result to. */
  context: Context;
  /** Trace id for trace-level scores without a span id. */
  traceOnlyId?: string;
}

function resolveTarget(traceId?: string, spanId?: string): Target {
  if (spanId && !traceId) {
    throw new Error('score(): spanId requires traceId');
  }
  if (!traceId) {
    // Inline evaluation: the evaluated span is the active span (if any).
    return { context: otelContext.active() };
  }

  const cleanTraceId = normalizeTraceId(traceId);
  if (!cleanTraceId) {
    console.warn(`score(): ignoring invalid traceId "${traceId}"`);
    return { context: ROOT_CONTEXT };
  }
  if (!spanId) {
    // Trace-level score: no span context. Never derive a span id from the trace id.
    return { context: traceOnlyContext(cleanTraceId), traceOnlyId: cleanTraceId };
  }

  const cleanSpanId = normalizeSpanId(spanId);
  if (!cleanSpanId) {
    console.warn(`score(): ignoring invalid spanId "${spanId}", scoring at trace level`);
    return { context: traceOnlyContext(cleanTraceId), traceOnlyId: cleanTraceId };
  }

  return {
    context: trace.setSpanContext(otelContext.active(), {
      traceId: cleanTraceId,
      spanId: cleanSpanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    }),
  };
}

/** The verdict a label carries: `"pass"` / `"fail"` (any case, trimmed), else undefined. */
export function labelVerdict(label: string | undefined): Verdict | undefined {
  const normalized = label?.trim().toLowerCase();
  return normalized && (VERDICTS as readonly string[]).includes(normalized)
    ? (normalized as Verdict)
    : undefined;
}

/**
 * Verdict of a threshold rule: with both `value` and `threshold`, `pass` when
 * `value >= threshold` (`maximize`, the default) or `value <= threshold`
 * (`minimize`), else `fail`; else undefined (no declared rule: readers show
 * the result as neutral).
 */
export function thresholdVerdict(options: {
  value?: number;
  threshold?: number;
  direction?: ScoreDirection;
}): Verdict | undefined {
  if (options.value === undefined || options.threshold === undefined) return undefined;
  if (options.direction === 'minimize') return options.value <= options.threshold ? 'pass' : 'fail';
  return options.value >= options.threshold ? 'pass' : 'fail';
}

function buildAttributes(options: ScoreOptions, target: Target): Attributes {
  const attrs: Attributes = {};
  if (options.attributes) {
    for (const [k, v] of Object.entries(options.attributes)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        attrs[k] = v;
      }
    }
  }

  attrs["gen_ai.evaluation.name"] = options.name;
  if (options.value !== undefined) attrs["gen_ai.evaluation.score.value"] = options.value;
  if (options.explanation) {
    attrs["gen_ai.evaluation.explanation"] = options.explanation.slice(0, EXPLANATION_LIMIT);
  }
  if (options.responseId) attrs["gen_ai.response.id"] = options.responseId;
  if (options.errorType) attrs["error.type"] = options.errorType;
  if (options.conversationId) attrs["gen_ai.conversation.id"] = options.conversationId;
  if (options.agentName) attrs[AGENT_NAME_KEY] = options.agentName;
  if (options.agentVersion) attrs[AGENT_VERSION_KEY] = options.agentVersion;

  const level = options.level ?? (target.traceOnlyId ? "trace" : undefined);
  if (level) attrs["opensearch.evaluation.level"] = level;
  if (options.evaluator) attrs["opensearch.evaluation.evaluator.name"] = options.evaluator;
  if (options.evaluatorVersion) {
    attrs["opensearch.evaluation.evaluator.version"] = options.evaluatorVersion;
  }
  if (options.evaluatorType) attrs["opensearch.evaluation.evaluator.type"] = options.evaluatorType;
  const direction =
    options.direction ?? (options.threshold !== undefined ? 'maximize' : undefined);
  if (direction) attrs["opensearch.evaluation.score.direction"] = direction;
  if (options.scoreMin !== undefined) attrs["opensearch.evaluation.score.min"] = options.scoreMin;
  if (options.scoreMax !== undefined) attrs["opensearch.evaluation.score.max"] = options.scoreMax;
  if (options.threshold !== undefined) {
    attrs["opensearch.evaluation.score.threshold"] = options.threshold;
  }
  // The verdict is the label (OTel examples "pass" / "fail"). A label you set is
  // kept; without one, a threshold rule records its computed verdict.
  const label =
    options.label ||
    thresholdVerdict({ value: options.value, threshold: options.threshold, direction });
  if (label) attrs["gen_ai.evaluation.score.label"] = label;
  if (options.judgeTraceId) attrs["opensearch.evaluation.judge.trace_id"] = options.judgeTraceId;
  return attrs;
}

function emitEvent(options: ScoreOptions, target: Target, attributes: Attributes): void {
  // The scope is the SDK (the instrumentation library); the evaluator is an attribute.
  getEventLogger().emit({
    eventName: EVALUATION_RESULT_EVENT,
    timestamp: Date.now(),
    severityNumber: SeverityNumber.INFO,
    attributes,
    context: target.context,
  });
  if (target.traceOnlyId && !takeTraceOnlyHandled() && !warnedTraceOnly) {
    warnedTraceOnly = true;
    console.warn(
      "score(): a trace-level result was emitted without its trace id: add " +
        "TraceOnlyContextProcessor to your LoggerProvider (register() does this)",
    );
  }
}

let warnedTraceOnly = false;

/**
 * Record an evaluation result as an OTel `gen_ai.evaluation.result` log event,
 * parented to the evaluated span.
 *
 * - Inline: call while the evaluated span is active.
 * - Offline: pass `traceId` + `spanId` of the evaluated span.
 * - Trace-level: pass only `traceId`. The event carries it as its own trace id,
 *   with no span id, and `opensearch.evaluation.level=trace`.
 *
 * Verdict: readers show pass/fail only for a declared rule. Pass
 * `label: "pass" | "fail"` (explicit) or `threshold` (+ `direction`); with
 * `value` and `threshold` and no `label` the SDK records the computed verdict
 * as `gen_ai.evaluation.score.label`.
 */
export function score(options: ScoreOptions): void {
  const target = resolveTarget(options.traceId, options.spanId);
  // Inline scoring reads the agent from the active span itself; a stored span
  // (traceId + spanId) is not looked up.
  const activeSpan = options.traceId ? undefined : trace.getSpan(target.context);
  const agent = resolveAgent(options.agentName, options.agentVersion, activeSpan);
  const resolved: ScoreOptions = {
    ...options,
    agentName: agent[AGENT_NAME_KEY],
    agentVersion: agent[AGENT_VERSION_KEY],
  };
  emitEvent(resolved, target, buildAttributes(resolved, target));
}
