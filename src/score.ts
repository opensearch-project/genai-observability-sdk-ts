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

/**
 * A judge's own non-verdict label (for example `"relevant"`) when the result
 * also has a verdict: `gen_ai.evaluation.score.label` then carries the verdict.
 */
export const JUDGE_LABEL_KEY = "opensearch.gen_ai.evaluation.judge_label";

/** What the evaluator checks (its criteria or rubric summary). */
export const EVALUATOR_DESCRIPTION_KEY = "opensearch.gen_ai.evaluation.evaluator.description";
/** Model used by the LLM judge (standard GenAI semconv name). */
export const JUDGE_MODEL_KEY = "gen_ai.request.model";
/** Name of the judge prompt template (standard GenAI semconv name). */
export const JUDGE_PROMPT_NAME_KEY = "gen_ai.prompt.name";
/** Version of the judge prompt (standard GenAI semconv name). */
export const JUDGE_PROMPT_VERSION_KEY = "gen_ai.prompt.version";
/** The judge's system prompt (standard GenAI semconv name). Opt-in only. */
export const JUDGE_SYSTEM_INSTRUCTIONS_KEY = "gen_ai.system_instructions";
/** `true` when `gen_ai.system_instructions` was truncated. */
export const SYSTEM_INSTRUCTIONS_TRUNCATED_KEY =
  "opensearch.gen_ai.evaluation.system_instructions_truncated";
/** Maximum length of `gen_ai.system_instructions`, in characters. */
export const SYSTEM_INSTRUCTIONS_LIMIT = 8192;

/** Exact attribute keys score() owns; `attributes` cannot set them. */
const SDK_OWNED_KEYS: ReadonlySet<string> = new Set([
  "error.type",
  "gen_ai.response.id",
  "gen_ai.conversation.id",
  AGENT_NAME_KEY,
  AGENT_VERSION_KEY,
  JUDGE_MODEL_KEY,
  JUDGE_PROMPT_NAME_KEY,
  JUDGE_PROMPT_VERSION_KEY,
  JUDGE_SYSTEM_INSTRUCTIONS_KEY,
]);
/** Attribute namespaces score() owns: `gen_ai.evaluation.*` and `opensearch.gen_ai.evaluation.*`. */
const SDK_OWNED_PREFIXES = ["gen_ai.evaluation.", "opensearch.gen_ai.evaluation."];

/** True for a key score() sets itself; such keys are dropped from `attributes`. */
export function isScoreReservedKey(key: string): boolean {
  return SDK_OWNED_KEYS.has(key) || SDK_OWNED_PREFIXES.some((p) => key.startsWith(p));
}

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
   * `gen_ai.evaluation.score.value` (a double in OTel semconv). The OTLP/HTTP
   * log exporter register() creates and AWSSigV4OTLPLogExporter send whole
   * numbers as `doubleValue` too; the gRPC log exporter and your own exporters
   * send them as `intValue`. See README.
   */
  value?: number;
  /** Trace of the evaluated span. Without `spanId` the score is trace-level. */
  traceId?: string;
  /** Evaluated span. Requires `traceId`. */
  spanId?: string;
  /**
   * Low-cardinality label. `"pass"` / `"fail"` (any case) is the verdict and is
   * stored lowercase as `gen_ai.evaluation.score.label`. Any other label (for
   * example `"relevant"`) is stored there only when there is no verdict; with a
   * `threshold` verdict the verdict wins and the label goes to
   * `opensearch.gen_ai.evaluation.judge_label` (with a warning).
   */
  label?: string;
  /** `gen_ai.evaluation.explanation` (truncated to 500 chars). */
  explanation?: string;
  /** `gen_ai.response.id` of the evaluated response, only if known. */
  responseId?: string;
  /** `opensearch.gen_ai.evaluation.level`. Defaults to `"trace"` for trace-level scores. */
  level?: EvaluationLevel;
  /** `opensearch.gen_ai.evaluation.evaluator.name`, for example `"relevance_judge"`. */
  evaluator?: string;
  /** `opensearch.gen_ai.evaluation.evaluator.version`. */
  evaluatorVersion?: string;
  /** `opensearch.gen_ai.evaluation.evaluator.type`. */
  evaluatorType?: EvaluatorType;
  /**
   * `opensearch.gen_ai.evaluation.evaluator.description`: what the evaluator
   * checks (its criteria or rubric summary).
   */
  evaluatorDescription?: string;
  /** `gen_ai.request.model`: the model used by the LLM judge. */
  judgeModel?: string;
  /** `gen_ai.prompt.name`: the name of the judge prompt template. */
  judgePromptName?: string;
  /** `gen_ai.prompt.version`: the version of the judge prompt. */
  judgePromptVersion?: string;
  /**
   * `gen_ai.system_instructions`: the judge's system prompt (text, or a value
   * that is JSON.stringify'd). It may contain sensitive data, so it is only
   * recorded when passed. Truncated to 8192 characters, with
   * `opensearch.gen_ai.evaluation.system_instructions_truncated=true` when cut.
   */
  judgeSystemInstructions?: unknown;
  /** `opensearch.gen_ai.evaluation.score.direction`. */
  direction?: ScoreDirection;
  /** `opensearch.gen_ai.evaluation.score.min`. */
  scoreMin?: number;
  /** `opensearch.gen_ai.evaluation.score.max`. */
  scoreMax?: number;
  /**
   * `opensearch.gen_ai.evaluation.score.threshold`: pass when `value >= threshold`
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
  /** `opensearch.gen_ai.evaluation.judge.trace_id`: the judge's own trace. */
  judgeTraceId?: string;
  /**
   * Extra attributes (string, number, boolean), for example `test.*` grouping
   * keys. Keys the SDK sets itself (`gen_ai.evaluation.*`,
   * `opensearch.gen_ai.evaluation.*`, `error.type`, `gen_ai.response.id`,
   * `gen_ai.conversation.id`, `gen_ai.agent.*`, `gen_ai.request.model`,
   * `gen_ai.prompt.name` / `.version`, `gen_ai.system_instructions`) are dropped with a warning:
   * use the options instead.
   */
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

const warnedJudgeLabel = new Set<string>();

function extraAttributes(attributes: Record<string, unknown> | undefined): Attributes {
  const attrs: Attributes = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(attributes ?? {})) {
    if (isScoreReservedKey(k)) {
      dropped.push(k);
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      attrs[k] = v;
    }
  }
  if (dropped.length > 0) {
    console.warn(
      `score(): dropped attributes the SDK sets itself (${dropped.map((k) => `"${k}"`).join(', ')}); ` +
        `use the score() options instead`,
    );
  }
  return attrs;
}

/**
 * `gen_ai.evaluation.score.label` and `opensearch.gen_ai.evaluation.judge_label`.
 * The verdict always wins the label: a `pass` / `fail` label (normalized), else
 * `verdict`. A non-verdict label is the label only when there is no verdict;
 * otherwise it is kept as the judge label, with a warning.
 */
function labelAttributes(name: string, label: string | undefined, verdict: Verdict | undefined): Attributes {
  const fromLabel = labelVerdict(label);
  if (fromLabel) return { "gen_ai.evaluation.score.label": fromLabel };
  if (!verdict) return label ? { "gen_ai.evaluation.score.label": label } : {};
  if (!label) return { "gen_ai.evaluation.score.label": verdict };
  if (!warnedJudgeLabel.has(name)) {
    warnedJudgeLabel.add(name);
    console.warn(
      `score(): "${name}" has label "${label}" and a "${verdict}" verdict. ` +
        `gen_ai.evaluation.score.label is the verdict; the label is kept as ${JUDGE_LABEL_KEY}`,
    );
  }
  return { "gen_ai.evaluation.score.label": verdict, [JUDGE_LABEL_KEY]: label };
}

function buildAttributes(options: ScoreOptions, target: Target, verdict?: Verdict): Attributes {
  // SDK fields are written after the extra attributes, which cannot hold SDK keys.
  const attrs: Attributes = extraAttributes(options.attributes);

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
  if (level) attrs["opensearch.gen_ai.evaluation.level"] = level;
  if (options.evaluator) attrs["opensearch.gen_ai.evaluation.evaluator.name"] = options.evaluator;
  if (options.evaluatorVersion) {
    attrs["opensearch.gen_ai.evaluation.evaluator.version"] = options.evaluatorVersion;
  }
  if (options.evaluatorType) attrs["opensearch.gen_ai.evaluation.evaluator.type"] = options.evaluatorType;
  const direction =
    options.direction ?? (options.threshold !== undefined ? 'maximize' : undefined);
  if (direction) attrs["opensearch.gen_ai.evaluation.score.direction"] = direction;
  if (options.scoreMin !== undefined) attrs["opensearch.gen_ai.evaluation.score.min"] = options.scoreMin;
  if (options.scoreMax !== undefined) attrs["opensearch.gen_ai.evaluation.score.max"] = options.scoreMax;
  if (options.threshold !== undefined) {
    attrs["opensearch.gen_ai.evaluation.score.threshold"] = options.threshold;
  }
  // The verdict is the label (OTel examples "pass" / "fail").
  Object.assign(
    attrs,
    labelAttributes(
      options.name,
      options.label,
      verdict ?? thresholdVerdict({ value: options.value, threshold: options.threshold, direction }),
    ),
  );
  if (options.judgeTraceId) attrs["opensearch.gen_ai.evaluation.judge.trace_id"] = options.judgeTraceId;
  Object.assign(attrs, judgeAttributes(options));
  return attrs;
}

/** Judge / evaluator context fields of a score, as event attributes (only those set). */
export interface JudgeContext {
  evaluatorDescription?: string;
  judgeModel?: string;
  judgePromptName?: string;
  judgePromptVersion?: string;
  judgeSystemInstructions?: unknown;
}

function instructionsText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * @internal The judge / evaluator context attributes: evaluator description,
 * judge model, prompt name and version, and (opt-in) the judge's system
 * instructions, truncated to 8192 characters with the `_truncated` flag.
 */
export function judgeAttributes(ctx: JudgeContext): Attributes {
  const attrs: Attributes = {};
  if (ctx.evaluatorDescription) attrs[EVALUATOR_DESCRIPTION_KEY] = ctx.evaluatorDescription;
  if (ctx.judgeModel) attrs[JUDGE_MODEL_KEY] = ctx.judgeModel;
  if (ctx.judgePromptName) attrs[JUDGE_PROMPT_NAME_KEY] = ctx.judgePromptName;
  if (ctx.judgePromptVersion) attrs[JUDGE_PROMPT_VERSION_KEY] = ctx.judgePromptVersion;
  const text = instructionsText(ctx.judgeSystemInstructions);
  if (text) {
    // Count characters (code points), not UTF-16 units.
    const chars = Array.from(text);
    if (chars.length <= SYSTEM_INSTRUCTIONS_LIMIT) {
      attrs[JUDGE_SYSTEM_INSTRUCTIONS_KEY] = text;
    } else {
      attrs[JUDGE_SYSTEM_INSTRUCTIONS_KEY] = chars.slice(0, SYSTEM_INSTRUCTIONS_LIMIT).join("");
      attrs[SYSTEM_INSTRUCTIONS_TRUNCATED_KEY] = true;
    }
  }
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
 *   with no span id, and `opensearch.gen_ai.evaluation.level=trace`.
 *
 * Verdict: readers show pass/fail only for a declared rule. Pass
 * `label: "pass" | "fail"` (explicit, any case, stored lowercase) or
 * `threshold` (+ `direction`); with `value` and `threshold` the SDK records the
 * computed verdict as `gen_ai.evaluation.score.label`. A non-verdict `label`
 * with a threshold verdict moves to `opensearch.gen_ai.evaluation.judge_label`.
 */
export function score(options: ScoreOptions): void {
  emitScore(options);
}

/**
 * @internal score() with the verdict decided by the caller (Benchmark /
 * evaluate(): a `passed` flag, a declared rule), so the stored label always
 * matches the local case status. A `pass` / `fail` label still wins.
 */
export function emitScore(options: ScoreOptions, verdict?: Verdict): void {
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
  emitEvent(resolved, target, buildAttributes(resolved, target, verdict));
}
