// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Offline evaluation runs: `evaluate()` and `Benchmark`.
 *
 * Shape of a run:
 *
 * ```
 * trace (one per test case)       the agent run, exactly like production
 *   root span                     + test.suite.name, test.suite.run.id, test.case.id, test.case.name
 *   LogRecord gen_ai.evaluation.result   one per score, parented to the root span, test.* copied,
 *                                        opensearch.test.case.expected when the case has one
 *                                        (unless recordExpected: false)
 * ```
 *
 * The SDK creates no spans of its own for a run.
 */

import {
  context as otelContext,
  ROOT_CONTEXT,
  TraceFlags,
  type SpanContext,
  type Attributes,
} from '@opentelemetry/api';
import { createHash, randomUUID } from 'crypto';
import {
  AGENT_NAME_KEY,
  AGENT_VERSION_KEY,
  RESERVED_KEYS,
  expectedAttributes,
  firstWarnings,
  normalizeSpanId,
  normalizeTraceId,
  resolveAgent,
  runAttributes,
  TEST_SUITE_RUN_NAME_KEY,
  validateMetadataKeys,
} from './internal.js';
import { ciPipelineAttributes } from './cicd.js';
import {
  emitScore,
  labelVerdict,
  type JudgeContext,
  thresholdVerdict,
  type Verdict,
  type EvaluatorType,
  type ScoreDirection,
} from './score.js';
import {
  ensureGlobalTestCaseProcessor,
  enterEvaluateRun,
  enterTestCase,
  TEST_CASE_KEY,
  type ActiveTestCase,
} from './testcase.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * One score from a scorer (or passed to `Benchmark.log({ scores: [...] })`).
 *
 * Verdict fields are optional; on the scorer's own results (see `defineScorer`)
 * unset ones fall back to its declaration. A `"pass"` / `"fail"` `label` (or
 * `passed`) is an explicit verdict and wins; otherwise `threshold` +
 * `direction` is applied to `value`.
 */
export interface EvalScore {
  name: string;
  /** Numeric score. May be omitted for a verdict-only result. */
  value?: number;
  /**
   * `"pass"` / `"fail"` (any case) is the verdict and wins over `passed`. Any
   * other label is the judge's own category: stored as
   * `gen_ai.evaluation.score.label` when the score has no verdict, else as
   * `opensearch.gen_ai.evaluation.judge_label` (the verdict is the label).
   */
  label?: string;
  explanation?: string;
  metadata?: Record<string, unknown>;
  /** Explicit verdict as a boolean. */
  passed?: boolean;
  /** `opensearch.gen_ai.evaluation.score.threshold`. */
  threshold?: number;
  /** `opensearch.gen_ai.evaluation.score.direction` (default `maximize` with a threshold). */
  direction?: ScoreDirection;
  scoreMin?: number;
  scoreMax?: number;
  /** `opensearch.gen_ai.evaluation.judge.trace_id`: the trace of the LLM judge call that produced this score. */
  judgeTraceId?: string;
  /**
   * `opensearch.gen_ai.evaluation.evaluator.name` of this score (for example
   * in `Benchmark.log()`). Unset (or `""`): the score is the scorer's own and
   * gets the declared `evaluator`, if any. A different evaluator marks another
   * evaluator's result, which gets nothing from the declaration.
   */
  evaluator?: string;
  /**
   * `opensearch.gen_ai.evaluation.evaluator.type` of this score. Default, on
   * the scorer's own results only: the declared `evaluatorType`.
   */
  evaluatorType?: EvaluatorType;
  /**
   * Judge / evaluator context (`evaluatorDescription`, `judgeModel`,
   * `judgePromptName`, `judgePromptVersion`): on the scorer's own results,
   * unset fields fall back to its `defineScorer()` declaration.
   */
  /**
   * `opensearch.gen_ai.evaluation.evaluator.description`: what the evaluator
   * checks (its criteria or rubric summary). Truncated to 1024 characters.
   */
  evaluatorDescription?: string;
  /** `gen_ai.request.model`: the model used by the LLM judge. */
  judgeModel?: string;
  /** `gen_ai.prompt.name`: the name of the judge prompt template. */
  judgePromptName?: string;
  /** `gen_ai.prompt.version`: the version of the judge prompt. */
  judgePromptVersion?: string;
}

/** What a scorer declares about the evaluation it produces (see `defineScorer`). */
export interface ScorerSpec {
  /**
   * `gen_ai.evaluation.name` of number/boolean results and of the error grade
   * emitted when the scorer throws. Default: the function name.
   */
  name?: string;
  /** Default `maximize` when `threshold` is set. */
  direction?: ScoreDirection;
  threshold?: number;
  scoreMin?: number;
  scoreMax?: number;
  /**
   * `opensearch.gen_ai.evaluation.evaluator.name` of the scorer's own results,
   * and what makes a result its own: a returned `EvalScore` whose `evaluator`
   * is unset (or `""`) or equals this. Default for ownership only: the
   * function name (no evaluator name is sent unless declared).
   */
  evaluator?: string;
  evaluatorType?: EvaluatorType;
  /**
   * `opensearch.gen_ai.evaluation.evaluator.description`: what the evaluator
   * checks (its criteria or rubric summary). Truncated to 1024 characters.
   */
  evaluatorDescription?: string;
  /** `gen_ai.request.model`: the model used by the LLM judge. */
  judgeModel?: string;
  /** `gen_ai.prompt.name`: the name of the judge prompt template. */
  judgePromptName?: string;
  /** `gen_ai.prompt.version`: the version of the judge prompt. */
  judgePromptVersion?: string;
}

/** What a scorer returns: a finite number, a boolean (a verdict), an EvalScore or an EvalScore[]. */
export type ScorerResult = EvalScore | EvalScore[] | number | boolean;

/**
 * A scorer: `(input, output, expected)` returning a ScorerResult, or a Promise
 * of one (an async LLM judge).
 */
export type ScorerFn = (
  input: unknown,
  output: unknown,
  expected: unknown,
) => ScorerResult | PromiseLike<ScorerResult>;

/** A synchronous scorer: typing scorers with it keeps `evaluate()`'s result a plain `BenchmarkResult`. */
export type SyncScorerFn = (input: unknown, output: unknown, expected: unknown) => ScorerResult;

/** A scorer function with its declared name and rule attached. */
export type Scorer<F extends ScorerFn = ScorerFn> = F & { readonly scorerSpec: ScorerSpec };

const DIRECTIONS: readonly ScoreDirection[] = ['maximize', 'minimize'];
const EVALUATOR_TYPES: readonly EvaluatorType[] = ['llm_judge', 'code', 'human', 'external'];

/**
 * Declare a scorer's evaluation name and pass rule for `evaluate()`.
 *
 * ```ts
 * const quality = defineScorer(
 *   { name: 'answer_quality', threshold: 4, scoreMin: 1, scoreMax: 5, evaluatorType: 'llm_judge' },
 *   (input, output) => judge(input, output),
 * );
 * ```
 *
 * `fn` may be async (an LLM judge): `evaluate()` awaits it. The returned
 * scorer has the same signature as `fn`, so `evaluate()`'s result type
 * follows it (see `EvaluateResult`).
 *
 * The declaration (rule fields, `evaluatorType`, description and judge
 * fields) fills unset fields of the scorer's own results only: a returned
 * `EvalScore` whose `evaluator` is unset (or `""`) or equals the scorer's
 * evaluator (the declared `evaluator`, else the function name). A result
 * naming another evaluator (for example `deepeval.faithfulness`) gets none of
 * it. Fields set on a returned `EvalScore` win. When the scorer declares any
 * of those fields and returns results in an `evaluate()` run but none of them,
 * in any case, are its own, `evaluate()` warns once per scorer per process at
 * the end of the run, listing the fields declared (a `direction` defaulted
 * from `threshold` is not listed). A scorer with an own result in any case of
 * the run does not warn. Run and case `metadata` is not part of the declaration and
 * goes on every result. The `evaluator` is trimmed (blank is unset); a
 * non-string `evaluator` throws.
 * Throws on an unknown `direction` / `evaluatorType` or a non-finite
 * `threshold` / `scoreMin` / `scoreMax`.
 */
/**
 * What is wrong with the rule fields of a `defineScorer()` spec or a returned
 * `EvalScore`: an unknown `direction` / `evaluatorType`, or a non-finite
 * `threshold` / `scoreMin` / `scoreMax`. Undefined when they are valid.
 */
function ruleError(rule: {
  direction?: unknown;
  evaluatorType?: unknown;
  threshold?: unknown;
  scoreMin?: unknown;
  scoreMax?: unknown;
}): string | undefined {
  if (rule.direction !== undefined && !DIRECTIONS.includes(rule.direction as ScoreDirection)) {
    return `direction must be one of ${DIRECTIONS.join(', ')}; got ${JSON.stringify(rule.direction)}`;
  }
  if (rule.evaluatorType !== undefined && !EVALUATOR_TYPES.includes(rule.evaluatorType as EvaluatorType)) {
    return `evaluatorType must be one of ${EVALUATOR_TYPES.join(', ')}; got ${JSON.stringify(rule.evaluatorType)}`;
  }
  for (const key of ['threshold', 'scoreMin', 'scoreMax'] as const) {
    const v = rule[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
      return `${key} must be a finite number; got ${JSON.stringify(v)}`;
    }
  }
  return undefined;
}

export function defineScorer<F extends ScorerFn>(spec: ScorerSpec, fn: F): Scorer<F> {
  const invalid = ruleError(spec);
  if (invalid) throw new Error(invalid);
  for (const field of ['evaluator', ...JUDGE_FIELDS] as const) {
    const v = spec[field];
    if (v !== undefined && typeof v !== 'string') {
      throw new Error(`${field} must be a string; got ${describeValue(v)}`);
    }
  }
  const resolved: ScorerSpec = {
    ...spec,
    // Trimmed; blank is unset (see evaluatorName).
    evaluator: evaluatorName(spec.evaluator),
    direction: spec.direction ?? (spec.threshold !== undefined ? 'maximize' : undefined),
  };
  const scorer = ((input: unknown, output: unknown, expected: unknown) =>
    fn(input, output, expected)) as unknown as Scorer<F>;
  Object.defineProperty(scorer, 'name', { value: fn.name || spec.name || 'score' });
  Object.defineProperty(scorer, 'scorerSpec', { value: Object.freeze(resolved), enumerable: true });
  // A nested defineScorer() carries the inner scorer's owner, not its wrapper name.
  ownEvaluators.set(scorer, resolved.evaluator ?? keyEvaluatorOf(fn));
  // As given, before defaults: a direction implied by threshold is not the user's.
  explicitFields.set(scorer, declaredFields(spec));
  return scorer;
}

/** The judge context fields of a declaration: strings when set. */
const JUDGE_FIELDS = ['evaluatorDescription', 'judgeModel', 'judgePromptName', 'judgePromptVersion'] as const;

function specOf(fn: ScorerFn): ScorerSpec | undefined {
  return (fn as Partial<Scorer>).scorerSpec;
}

/**
 * The evaluator that owns a `defineScorer()` scorer's results: the declared `evaluator`, else
 * the wrapped function's own name (not the wrapper's `name`, which falls back to the spec name
 * or `"score"`). Used for ownership only; nothing is sent from it.
 */
const ownEvaluators = new WeakMap<ScorerFn, string | undefined>();

/**
 * The declared fields of a `defineScorer()` scorer as the user gave them (see
 * `declaredFields`), without the `direction` that defaults to `maximize` with a
 * `threshold`: the unused-declaration warning lists only these.
 */
const explicitFields = new WeakMap<ScorerFn, string[]>();

/**
 * An evaluator name, trimmed. Unset (undefined) when it is not a string, or is `""` or
 * whitespace only, so `"judge "` and `"judge"` name the same evaluator.
 */
function evaluatorName(evaluator: unknown): string | undefined {
  if (typeof evaluator !== 'string') return undefined;
  const trimmed = evaluator.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** An evaluator that names no evaluator: unset, `""` or whitespace only. */
function isUnsetEvaluator(evaluator: string | undefined): boolean {
  return evaluatorName(evaluator) === undefined;
}

/** A function's own name as an evaluator, when it has a usable one. */
function fnEvaluator(fn: ScorerFn): string | undefined {
  return evaluatorName(fn.name);
}

function ownEvaluatorOf(fn: ScorerFn): string | undefined {
  return ownEvaluators.get(fn);
}

/**
 * The evaluator a scorer's results are keyed by locally when they name none: its owner for a
 * `defineScorer()` scorer, else the plain function's own name.
 */
function keyEvaluatorOf(fn: ScorerFn): string | undefined {
  return ownEvaluators.has(fn) ? ownEvaluators.get(fn) : fnEvaluator(fn);
}

/**
 * Whether a score belongs to `owner` (a scorer's evaluator, or a `Benchmark.log()` default):
 * its `evaluator` is unset (or `""`) or equals `owner`. A score that names a different
 * evaluator is another evaluator's result, whatever its `name`.
 */
function ownsScore(s: EvalScore, owner: string | undefined): boolean {
  const evaluator = evaluatorName(s.evaluator);
  return evaluator === undefined || evaluator === owner;
}

/**
 * Fill unset fields of a score from its scorer's declaration, for the scorer's own scores only
 * (see `ownsScore`; `owner` is the scorer's evaluator). One check decides the evaluator,
 * evaluator type, rule, bounds, description and judge fields, so they always describe the
 * same evaluator: a scorer that returns DeepEval or RAGAS scores stamps none of them on those.
 */
function applySpec(s: EvalScore, spec: ScorerSpec | undefined, owner: string | undefined): EvalScore {
  if (!spec) return s;
  if (!ownsScore(s, owner)) return s;
  return {
    ...s,
    evaluator: evaluatorName(s.evaluator) ?? spec.evaluator,
    evaluatorType: s.evaluatorType ?? spec.evaluatorType,
    threshold: s.threshold ?? spec.threshold,
    direction: s.direction ?? spec.direction,
    scoreMin: s.scoreMin ?? spec.scoreMin,
    scoreMax: s.scoreMax ?? spec.scoreMax,
    evaluatorDescription: s.evaluatorDescription ?? spec.evaluatorDescription,
    judgeModel: s.judgeModel ?? spec.judgeModel,
    judgePromptName: s.judgePromptName ?? spec.judgePromptName,
    judgePromptVersion: s.judgePromptVersion ?? spec.judgePromptVersion,
  };
}

/** The `defineScorer()` fields that fill a scorer's own results (rule, type, description, judge). */
const DECLARED_FIELDS = [
  'threshold',
  'direction',
  'scoreMin',
  'scoreMax',
  'evaluatorType',
  'evaluatorDescription',
  'judgeModel',
  'judgePromptName',
  'judgePromptVersion',
] as const;

/** The fields a declaration sets for its scorer's own results. */
function declaredFields(spec: ScorerSpec): string[] {
  return DECLARED_FIELDS.filter(f => spec[f] !== undefined);
}

/** The fields the user declared for a scorer (see `explicitFields`). */
function userDeclaredFields(scorer: ScorerFn, spec: ScorerSpec): string[] {
  return explicitFields.get(scorer) ?? declaredFields(spec);
}

/** Whether a scorer's declaration reached any result it returned in one `evaluate()` run. */
interface DeclarationUse {
  scorer: ScorerFn;
  spec: ScorerSpec;
  evalName: string;
  owner: string | undefined;
  /** Some returned result of the run was the scorer's own. */
  reached: boolean;
  /** Evaluators named by the results it returned (none of them its own so far). */
  named: Set<string>;
}

/** Per `Benchmark.log()` evaluator and type default: whether it reached any score of the run. */
interface TypeDefaultUse {
  evaluator: string | undefined;
  evaluatorType: EvaluatorType;
  reached: boolean;
  named: Set<string>;
}

/** Add the evaluator names a set of scores names to `into`. */
function addEvaluatorsNamed(into: Set<string>, scores: EvalScore[]): void {
  for (const e of evaluatorsNamed(scores)) into.add(e);
}

/** The distinct evaluator names a set of scores names, sorted. */
function evaluatorsNamed(scores: EvalScore[]): string[] {
  return [...new Set(scores.map(s => evaluatorName(s.evaluator)).filter((e): e is string => !!e))].sort();
}

/**
 * The once-per-scorer key of a scorer: its evaluation name and evaluator, so scorers rebuilt
 * per test or request with the same name and evaluator warn once per process.
 */
function scorerKey(evalName: string, owner: string | undefined): string {
  return JSON.stringify([evalName, owner ?? null]);
}

/**
 * Warn, once per scorer per process, that a scorer's declaration applied to no result of an
 * `evaluate()` run: it returned results, and every one names another evaluator, so none is
 * its own (see `ownsScore`). Called at the end of the run. Keyed by evaluation name and
 * evaluator (see `scorerKey`).
 */
function warnDeclarationAppliesToNoResult(use: DeclarationUse): void {
  const { scorer, spec, evalName, owner } = use;
  if (firstWarnings('scorer-declaration-unused', [scorerKey(evalName, owner)]).length === 0) return;
  const ownerText =
    owner === undefined
      ? 'none'
      : `"${owner}" (${spec.evaluator !== undefined ? 'declared' : 'the function name'})`;
  console.warn(
    `[opensearch-genai-observability-sdk-ts] evaluate(): scorer "${evalName}" (evaluator ${ownerText}) ` +
      `declares ${userDeclaredFields(scorer, spec).join(', ')}, which applied to no result of the ` +
      `run, because every result it returned names another evaluator: ` +
      `${JSON.stringify([...use.named].sort())}. A result is the ` +
      `scorer's own when its evaluator is unset or equals the scorer's evaluator. Declare the ` +
      `scorer's evaluator to match its results, or set these fields on the returned EvalScore.`,
  );
}

/**
 * Warn, once per evaluator and type per process, that a `Benchmark.log()` `evaluatorType`
 * default reached no score of the run: every score logged with it names another evaluator.
 * Called from `close()`.
 */
function warnLogTypeAppliesToNoScore(use: TypeDefaultUse): void {
  const { evaluator, evaluatorType } = use;
  if (firstWarnings('log-type-unused', [typeDefaultKey(evaluator, evaluatorType)]).length === 0) return;
  console.warn(
    `[opensearch-genai-observability-sdk-ts] Benchmark.log(): evaluatorType "${evaluatorType}" ` +
      `(evaluator ${evaluator === undefined ? 'unset' : `"${evaluator}"`}) applied to no score of ` +
      `the run, because every score logged with it names another evaluator: ` +
      `${JSON.stringify([...use.named].sort())}. The defaults go only on scores whose evaluator ` +
      `is unset or equals the log-level evaluator. Set evaluatorType on the EvalScore.`,
  );
}

/** The key of a `Benchmark.log()` evaluator and type default. */
function typeDefaultKey(evaluator: string | undefined, evaluatorType: EvaluatorType): string {
  return `${evaluator ?? ''}\u0000${evaluatorType}`;
}

function judgeContextOf(s: EvalScore): JudgeContext {
  return {
    evaluatorDescription: s.evaluatorDescription,
    judgeModel: s.judgeModel,
    judgePromptName: s.judgePromptName,
    judgePromptVersion: s.judgePromptVersion,
  };
}

/** Verdict of a score: a `pass` / `fail` label, else `passed`, else the threshold rule. */
function verdictOf(s: EvalScore): Verdict | undefined {
  const fromLabel = labelVerdict(s.label);
  if (fromLabel) return fromLabel;
  if (s.passed !== undefined) return s.passed ? 'pass' : 'fail';
  return thresholdVerdict({ value: s.value, threshold: s.threshold, direction: s.direction });
}

/**
 * Keys of the local results of one run (`TestCaseResult.scores` / `.verdicts` and the summary).
 * In `evaluate()`, each scorer first claims its evaluation name for its own evaluator (see
 * `claim`), so a scorer's own results keep the plain name whatever the order of results or
 * errors. Otherwise the first evaluator to report an evaluation name in the run keeps the plain
 * name; a result of another evaluator with the same name is keyed `"<name> (<evaluator>)"`
 * (`"<name> (no evaluator)"` when it names none). A key already taken by another name and
 * evaluator (a real evaluation named `"f (b)"`, say) gets `" (2)"`, `" (3)"`, ... appended, so
 * results of different evaluators never overwrite each other. Results of one evaluator with the
 * same name share a key: a `fail` verdict is never replaced, and the value of a failing result is
 * kept over the value of a later passing one, so the case fails when any of them fails and the
 * value shown is the failing one.
 */
class LocalResultKeys {
  /** Per evaluation name: the evaluator that owns the plain name. */
  private readonly first = new Map<string, string | undefined>();
  /** Per name and evaluator pair: its key. */
  private readonly keys = new Map<string, string>();
  /** Keys in use. */
  private readonly taken = new Set<string>();

  /** Reserve the plain `name` for `evaluator`, unless another evaluator already has it. */
  claim(name: string, evaluator: string | undefined): void {
    if (!this.first.has(name)) this.first.set(name, evaluator);
  }

  key(name: string, evaluator: string | undefined): string {
    const pair = JSON.stringify([name, evaluator ?? null]);
    const known = this.keys.get(pair);
    if (known !== undefined) return known;
    this.claim(name, evaluator);
    const base = this.first.get(name) === evaluator ? name : `${name} (${evaluator ?? 'no evaluator'})`;
    let key = base;
    for (let n = 2; this.taken.has(key); n++) key = `${base} (${n})`;
    this.keys.set(pair, key);
    this.taken.add(key);
    return key;
  }

  /**
   * Add `scores` to a case's values and verdicts. `evaluator` is the evaluator of the scores
   * that name none (the scorer's, or the `log()` default). A score with no value and no verdict
   * records nothing and claims no key.
   */
  record(
    scores: EvalScore[],
    evaluator: string | undefined,
    values: Record<string, number>,
    verdicts: Record<string, Verdict>,
  ): void {
    for (const s of scores) {
      const v = verdictOf(s);
      if (s.value === undefined && v === undefined) continue;
      const key = this.key(s.name, evaluatorName(s.evaluator) ?? evaluator);
      const failedBefore = Object.prototype.hasOwnProperty.call(verdicts, key) && verdicts[key] === 'fail';
      // A failing result's value is kept over a later passing one (see the class comment).
      if (s.value !== undefined && (!failedBefore || v === 'fail')) setOwn(values, key, s.value);
      if (v && !failedBefore) setOwn(verdicts, key, v);
    }
  }
}

/** Set an own property, also for names like `__proto__` that plain assignment would drop. */
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function hasFailVerdict(verdicts: Record<string, Verdict>): boolean {
  return Object.values(verdicts).includes('fail');
}

export interface ScoreSummary {
  name: string;
  avg: number;
  min: number;
  max: number;
  count: number;
}

/**
 * Local status of a test case: `error` if the task raised or a result errored,
 * else `fail` if a result has a `fail` verdict, else `pass`.
 */
export type TestCaseStatus = "pass" | "fail" | "error";
const CASE_STATUSES: readonly TestCaseStatus[] = ["pass", "fail", "error"];

export interface BenchmarkSummary {
  benchmarkName: string;
  runId: string;
  /** `opensearch.test.suite.run.name` of the run, when given. */
  runName?: string;
  totalCases: number;
  /** Cases whose task raised or a result errored (status `error`). */
  errorCount: number;
  passCount: number;
  failCount: number;
  durationMs: number;
  scores: Record<string, ScoreSummary>;
}

export interface TestCaseResult {
  caseId: string;
  caseName?: string;
  input: unknown;
  output: unknown;
  expected: unknown;
  /** Result key (see `verdicts`) to score value. */
  scores: Record<string, number>;
  error?: string;
  /** `"pass"`, or `"fail"` when the case errored or a score failed its verdict. */
  status: string;
  /** `pass` | `fail` | `error` (see `TestCaseStatus`). */
  resultStatus: TestCaseStatus;
  /** `error.type` (exception class name) when the case errored. */
  errorType?: string;
  durationMs?: number;
  /** Trace and span id of the agent run's root span, when the task created one. */
  traceId?: string;
  spanId?: string;
  scorerErrors?: string[];
  /**
   * Result key to declared verdict, for scores that have one. The key is the evaluation name;
   * when results of different evaluators share a name in a run, the first evaluator keeps the
   * plain name and the others are keyed `"<name> (<evaluator>)"` (same keys as `scores`).
   */
  verdicts?: Record<string, Verdict>;
}

export interface BenchmarkResult {
  summary: BenchmarkSummary;
  cases: TestCaseResult[];
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function makeRunId(runId?: string): string {
  if (runId !== undefined) {
    if (typeof runId !== 'string' || runId.trim() === '') {
      throw new Error('runId must be a non-empty string');
    }
    return runId;
  }
  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '_',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const short = randomUUID().replace(/-/g, '').slice(0, 8);
  return `run_${ts}_${short}`;
}

function makeCaseId(input: unknown): string {
  const serialized = JSON.stringify(input ?? '');
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}

function toAttributes(record: Record<string, unknown>): Attributes {
  const attrs: Attributes = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attrs[key] = value;
    }
  }
  return attrs;
}

function safeMetadata(
  metadata: Record<string, unknown> | undefined,
  context?: string,
): Record<string, unknown> {
  if (!metadata) return {};
  validateMetadataKeys(metadata, context);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!RESERVED_KEYS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function errorTypeOf(e: unknown): string {
  if (e instanceof Error) return e.constructor?.name || e.name || 'Error';
  return typeof e;
}

/** Elapsed milliseconds, kept fractional so OTLP encodes it as a double. */
function elapsedMs(start: number): number {
  return performance.now() - start;
}

function spanContextFrom(traceIdHex?: string, spanIdHex?: string): SpanContext | null {
  // Needs a real span id. Never derive one from the trace id.
  if (!traceIdHex || !spanIdHex) return null;
  const traceId = normalizeTraceId(traceIdHex);
  const spanId = normalizeSpanId(spanIdHex);
  if (!traceId || !spanId) return null;
  return { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true };
}

interface CaseIdentity {
  suiteName: string;
  runId: string;
  caseId: string;
  caseName?: string;
  /** `gen_ai.agent.name` / `gen_ai.agent.version` of the agent under test, when known. */
  agent?: Record<string, string>;
  /** OTel `cicd.pipeline.*` of the CI run, when in CI. */
  ci?: Record<string, string>;
  /** `opensearch.test.case.expected` (+ `_truncated`), when the case has an expected output. */
  expected?: Record<string, string | boolean>;
  /** `opensearch.test.suite.run.name` / `.description`, when given. */
  run?: Record<string, string>;
}

function identityAttributes(identity: CaseIdentity): Record<string, string> {
  const attrs: Record<string, string> = {
    "test.suite.name": identity.suiteName,
    "test.suite.run.id": identity.runId,
    "test.case.id": identity.caseId,
  };
  if (identity.caseName) attrs["test.case.name"] = identity.caseName;
  return { ...attrs, ...(identity.ci ?? {}), ...(identity.agent ?? {}) };
}

/**
 * Emit one gen_ai.evaluation.result event per score, with the suite and case
 * identity and the run / case `metadata` copied. `target` is the evaluated
 * span (the agent run's root span or a caller-supplied span). With only a
 * trace id the score is trace-level; with neither the event has no trace
 * context. With `extra.errorType` every score is an evaluator error result:
 * `error.type`, no value and no label.
 */
function emitCaseScores(
  scores: EvalScore[],
  identity: CaseIdentity,
  target: { traceId?: string; spanId?: string },
  metadata: Attributes,
  extra: { evaluator?: string; evaluatorType?: EvaluatorType; errorType?: string } = {},
): void {
  // The expected output goes on results only, never on the agent's spans. The
  // agent identity is passed as score() options, not as extra attributes.
  const { [AGENT_NAME_KEY]: _name, [AGENT_VERSION_KEY]: _version, ...identityAttrs } =
    identityAttributes(identity);
  const testAttrs = { ...identityAttrs, ...(identity.run ?? {}), ...(identity.expected ?? {}) };
  const errored = extra.errorType !== undefined;
  for (const s of scores) {
    // The log-level evaluator defaults go only on scores of that evaluator (see ownsScore).
    const own = ownsScore(s, extra.evaluator);
    const scoreMeta = s.metadata ? toAttributes(safeMetadata(s.metadata, `score:${s.name}`)) : {};
    const options = {
      name: s.name,
      value: errored ? undefined : s.value,
      label: errored ? undefined : s.label,
      explanation: s.explanation,
      direction: s.direction,
      scoreMin: s.scoreMin,
      scoreMax: s.scoreMax,
      threshold: s.threshold,
      evaluator: own && isUnsetEvaluator(s.evaluator) ? extra.evaluator : evaluatorName(s.evaluator),
      evaluatorType: own ? s.evaluatorType ?? extra.evaluatorType : s.evaluatorType,
      errorType: extra.errorType,
      judgeTraceId: s.judgeTraceId,
      ...judgeContextOf(s),
      agentName: identity.agent?.[AGENT_NAME_KEY],
      agentVersion: identity.agent?.[AGENT_VERSION_KEY],
      attributes: { ...metadata, ...scoreMeta, ...testAttrs },
      traceId: target.traceId,
      spanId: target.traceId ? target.spanId : undefined,
    };
    // The verdict that set the local case status is the stored label.
    const verdict = errored ? undefined : verdictOf(s);
    // No target: do not pick up whatever span the caller has active.
    otelContext.with(ROOT_CONTEXT, () => emitScore(options, verdict));
  }
}

function computeSummary(
  name: string,
  runId: string,
  cases: TestCaseResult[],
  durationMs: number,
  runName?: string,
): BenchmarkSummary {
  const scoreAcc = new Map<string, { sum: number; min: number; max: number; count: number }>();
  for (const c of cases) {
    for (const [scoreName, scoreValue] of Object.entries(c.scores)) {
      const acc = scoreAcc.get(scoreName);
      if (!acc) {
        scoreAcc.set(scoreName, { sum: scoreValue, min: scoreValue, max: scoreValue, count: 1 });
      } else {
        acc.sum += scoreValue;
        acc.min = Math.min(acc.min, scoreValue);
        acc.max = Math.max(acc.max, scoreValue);
        acc.count += 1;
      }
    }
  }

  const scores: Record<string, ScoreSummary> = {};
  for (const [scoreName, acc] of scoreAcc) {
    setOwn(scores, scoreName, {
      name: scoreName,
      avg: acc.count > 0 ? acc.sum / acc.count : 0,
      min: acc.min,
      max: acc.max,
      count: acc.count,
    });
  }

  return {
    benchmarkName: name,
    runId,
    ...(runName ? { runName } : {}),
    totalCases: cases.length,
    errorCount: cases.filter(c => c.resultStatus === 'error').length,
    passCount: cases.filter(c => c.resultStatus === 'pass').length,
    failCount: cases.filter(c => c.resultStatus === 'fail').length,
    durationMs,
    scores,
  };
}

function formatSummary(summary: BenchmarkSummary): string {
  const lines: string[] = [];
  lines.push(`Benchmark: ${summary.benchmarkName}`);
  lines.push(`Run ID:    ${summary.runId}`);
  if (summary.runName) lines.push(`Run name:  ${summary.runName}`);
  lines.push(`Cases:     ${summary.totalCases} (${summary.errorCount} errors)`);
  lines.push(`Duration:  ${Math.round(summary.durationMs)}ms`);

  const scoreNames = Object.keys(summary.scores);
  if (scoreNames.length > 0) {
    lines.push('Scores:');
    for (const name of scoreNames) {
      const s = summary.scores[name];
      lines.push(`  ${name}: avg=${s.avg.toFixed(3)} min=${s.min.toFixed(3)} max=${s.max.toFixed(3)} (n=${s.count})`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Benchmark class
// ---------------------------------------------------------------------------


export interface BenchmarkOptions {
  /**
   * Run metadata, stamped on every `gen_ai.evaluation.result` event of the run
   * (reserved keys are dropped; the score's own metadata and the SDK
   * attributes win).
   */
  metadata?: Record<string, unknown>;
  /**
   * `test.suite.run.id` of the run. Default: a generated id. Pass the same id
   * from every CI shard so they report into one run, or the id of an existing
   * run to re-score it (send the new results with the same run id). Must not
   * be empty or whitespace.
   */
  runId?: string;
  /**
   * `opensearch.test.suite.run.name`: a human-readable name for the run, for
   * example `"v5 with shorter prompt"`, on every result of the run. Optional;
   * readers fall back to the short run id.
   */
  runName?: string;
  /**
   * `opensearch.test.suite.run.description`: free text about the run, on every
   * result of the run. Optional; truncated to 1024 characters.
   */
  runDescription?: string;
  /** `gen_ai.agent.name` of the agent under test. Default: `register({ agentName })`. */
  agentName?: string;
  /** `gen_ai.agent.version` of the agent under test. Default: `register({ agentVersion })`. */
  agentVersion?: string;
  /**
   * Sets or overrides the OTel `cicd.pipeline.name` / `.run.id` / `.run.url.full`
   * read from GitHub Actions, GitLab CI or Jenkins. Nothing is added outside CI.
   */
  ciPipeline?: Record<string, string>;
  /**
   * Export each case's `expected` as `opensearch.test.case.expected` (and
   * `opensearch.test.case.expected_truncated` when cut) on its results.
   * Default true. Pass false if your test sets hold sensitive data: neither
   * attribute is then written (the value is still kept on the local result).
   */
  recordExpected?: boolean;
}

/**
 * Upload results of cases you ran yourself. Each `log()` emits one
 * `gen_ai.evaluation.result` event per score, parented to the evaluated span
 * when `traceId` + `spanId` are given. `close()` returns the local summary.
 * `log()` checks scores like evaluate() checks a scorer's result and throws a
 * TypeError, emitting nothing, for an invalid one.
 */
export class Benchmark {
  private _name: string;
  private _metadata: Record<string, unknown>;
  private _runId: string;
  private _start: number;
  private _cases: TestCaseResult[] = [];
  private _resultKeys = new LocalResultKeys();
  /** `log()` evaluator and type defaults of the run; decided, and warned about, in `close()`. */
  private _typeDefaults = new Map<string, TypeDefaultUse>();
  private _closed = false;
  private _agent: Record<string, string>;
  private _ci: Record<string, string>;
  private _recordExpected: boolean;
  private _run: Record<string, string>;

  constructor(name: string, options?: BenchmarkOptions) {
    this._name = name;
    this._runId = makeRunId(options?.runId);
    this._run = runAttributes(options?.runName, options?.runDescription);
    // Declared agent, else the register() default (never invented).
    this._agent = resolveAgent(options?.agentName, options?.agentVersion);
    this._metadata = safeMetadata(options?.metadata, `benchmark:${name}`);
    this._ci = ciPipelineAttributes(options?.ciPipeline);
    this._recordExpected = options?.recordExpected ?? true;
    this._start = performance.now();
  }

  get name(): string {
    return this._name;
  }

  get runId(): string {
    return this._runId;
  }

  /** `opensearch.test.suite.run.name` of the run, when given. */
  get runName(): string | undefined {
    return this._run[TEST_SUITE_RUN_NAME_KEY];
  }

  log(options: {
    input?: unknown;
    output?: unknown;
    /**
     * Expected output. Sent on every result of the case as
     * `opensearch.test.case.expected` (strings as is, other values
     * JSON.stringify'd, truncated to 8192 characters), unless the Benchmark
     * was created with `recordExpected: false`.
     */
    expected?: unknown;
    /** `{ name: value }`, or `EvalScore[]` to declare verdicts (label / threshold) and bounds. */
    scores?: Record<string, number> | EvalScore[];
    /**
     * Case metadata, stamped on the case's `gen_ai.evaluation.result` events
     * (over the run metadata; reserved keys are dropped).
     */
    metadata?: Record<string, unknown>;
    /** Error message, kept on the local result. The local status becomes `error`. */
    error?: string;
    /**
     * `error.type` for an errored case (exception class name or similar). Every
     * score in `scores` is then emitted as an evaluator error result: `error.type`
     * set, no score value and no label. Its `value`, `label` and `passed` are
     * then not checked (a timed-out metric may report NaN); its name still is.
     */
    errorType?: string;
    /**
     * Explicit local case status. Default `error` when `error` or `errorType` is
     * given, else `fail` when a score has a `fail` verdict, else `pass`.
     */
    status?: TestCaseStatus;
    caseId?: string;
    caseName?: string;
    traceId?: string;
    spanId?: string;
    /**
     * Default `opensearch.gen_ai.evaluation.evaluator.name` for the scores of
     * this call whose `evaluator` is unset (or `""`), for example `"deepeval"`.
     * An `EvalScore` that names a different evaluator keeps it and gets no
     * default `evaluatorType`. Trimmed; blank is unset.
     */
    evaluator?: string;
    /**
     * Default `opensearch.gen_ai.evaluation.evaluator.type` for the scores of
     * this call whose `evaluator` is unset or equals `evaluator`. An
     * `EvalScore` that sets its own `evaluatorType` wins. When every score
     * logged with this `evaluator` and `evaluatorType` during the run names
     * another evaluator it applies to none, and `close()` warns once per
     * evaluator and type per process.
     */
    evaluatorType?: EvaluatorType;
  }): void {
    if (this._closed) {
      throw new Error('Benchmark is already closed');
    }

    if (options.spanId && !options.traceId) {
      throw new Error('spanId requires traceId');
    }

    const caseId = options.caseId ?? makeCaseId(options.input);
    const identity: CaseIdentity = {
      suiteName: this._name,
      runId: this._runId,
      caseId,
      caseName: options.caseName,
      agent: this._agent,
      ci: this._ci,
      expected: this._recordExpected ? expectedAttributes(options.expected) : undefined,
      run: this._run,
    };
    if (options.status !== undefined && !CASE_STATUSES.includes(options.status)) {
      throw new Error(`status must be one of ${CASE_STATUSES.join(', ')}; got "${options.status}"`);
    }
    const evalScores = validLogScores(options);
    // Trimmed; blank is unset (see evaluatorName).
    const evaluator = evaluatorName(options.evaluator);
    const errorType = options.errorType;
    const caseMeta = toAttributes(safeMetadata(options.metadata, `case:${caseId}`));
    // Last step that can throw: an invalid call records nothing locally (no key claimed).
    const evaluated = spanContextFrom(options.traceId, options.spanId);
    if (options.evaluatorType && evalScores.length > 0) {
      const key = typeDefaultKey(evaluator, options.evaluatorType);
      let use = this._typeDefaults.get(key);
      if (!use) {
        use = { evaluator, evaluatorType: options.evaluatorType, reached: false, named: new Set() };
        this._typeDefaults.set(key, use);
      }
      if (evalScores.some(s => ownsScore(s, evaluator))) use.reached = true;
      else if (!use.reached) addEvaluatorsNamed(use.named, evalScores);
    }
    const values: Record<string, number> = {};
    const verdicts: Record<string, Verdict> = {};
    if (!errorType) this._resultKeys.record(evalScores, evaluator, values, verdicts);
    const failed = hasFailVerdict(verdicts);
    const hasError = options.error !== undefined;
    const resultStatus: TestCaseStatus =
      options.status ?? (hasError || errorType ? 'error' : failed ? 'fail' : 'pass');
    // Same rule as evaluate(): only a passing case has status `pass`.
    const status = resultStatus === 'pass' ? 'pass' : 'fail';

    if (evalScores.length > 0) {
      emitCaseScores(
        evalScores,
        identity,
        { traceId: options.traceId, spanId: options.spanId },
        { ...toAttributes(this._metadata), ...caseMeta },
        { errorType, evaluator, evaluatorType: options.evaluatorType },
      );
    }

    this._cases.push({
      caseId,
      caseName: options.caseName,
      input: options.input,
      output: options.output,
      expected: options.expected,
      scores: values,
      error: options.error,
      status,
      resultStatus,
      errorType,
      traceId: evaluated?.traceId,
      spanId: evaluated?.spanId,
      verdicts: Object.keys(verdicts).length > 0 ? verdicts : undefined,
    });
  }

  close(): BenchmarkSummary {
    if (this._closed) {
      throw new Error('Benchmark is already closed');
    }
    this._closed = true;

    // A log() type default that reached no score of the run warns, once per evaluator and type.
    for (const use of this._typeDefaults.values()) {
      if (!use.reached) warnLogTypeAppliesToNoScore(use);
    }

    const summary = computeSummary(
      this._name,
      this._runId,
      this._cases,
      elapsedMs(this._start),
      this.runName,
    );
    console.log(formatSummary(summary));
    return summary;
  }
}

/** The fields an error result does not send (see emitCaseScores): they are not checked either. */
const ERROR_DROPPED_FIELDS = ['value', 'label', 'passed'] as const;

/**
 * The scores of a `Benchmark.log()` call, checked like the scores a scorer returns in
 * evaluate() (null fields count as unset). With `errorType` the case errored and its values
 * are not sent, so `value`, `label` and `passed` are dropped unchecked (a timed-out metric
 * may report NaN). Throws a TypeError, before anything is emitted, for an invalid score or an
 * invalid `evaluator` / `evaluatorType` default.
 */
function validLogScores(options: {
  scores?: Record<string, number> | EvalScore[];
  evaluator?: unknown;
  evaluatorType?: unknown;
  errorType?: string;
}): EvalScore[] {
  if (options.evaluator !== undefined && typeof options.evaluator !== 'string') {
    throw new TypeError(`Benchmark.log(): evaluator must be a string; got ${describeValue(options.evaluator)}`);
  }
  const invalidDefault = ruleError({ evaluatorType: options.evaluatorType });
  if (invalidDefault) throw new TypeError(`Benchmark.log(): ${invalidDefault}`);
  const items: unknown[] = Array.isArray(options.scores)
    ? options.scores
    : Object.entries(options.scores ?? {}).map(([name, value]) => ({ name, value }));
  return items.map(item => {
    const read = readEvalScore(item);
    if (read && options.errorType !== undefined) {
      for (const key of ERROR_DROPPED_FIELDS) delete read[key];
    }
    const score = read ? checkedEvalScore(read) : describeValue(item);
    if (typeof score === 'string') throw new TypeError(`Benchmark.log(): scores has ${score}`);
    return score;
  });
}

// ---------------------------------------------------------------------------
// evaluate() function
// ---------------------------------------------------------------------------

/** `error.type` of the error result for a scorer that returned an unusable value. */
const INVALID_SCORER_RESULT = 'TypeError';

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Run a generator that yields the Promises it waits for: synchronously while
 * nothing is pending, so a fully synchronous run returns its value directly;
 * from the first yielded Promise on, asynchronously, returning a Promise.
 * A rejected Promise is thrown into the generator at its `yield`.
 */
function runMaybeAsync<T>(gen: Generator<PromiseLike<unknown>, T, unknown>): T | Promise<T> {
  const step = gen.next();
  return step.done ? step.value : continueAsync(gen, step.value);
}

async function continueAsync<T>(
  gen: Generator<PromiseLike<unknown>, T, unknown>,
  pending: PromiseLike<unknown>,
): Promise<T> {
  for (;;) {
    let value: unknown;
    let rejected = false;
    let reason: unknown;
    try {
      value = await pending;
    } catch (e) {
      rejected = true;
      reason = e;
    }
    const step = rejected ? gen.throw(reason) : gen.next(value);
    if (step.done) return step.value;
    pending = step.value;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number') return String(value);
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** Every EvalScore field: the keys read from a returned score (the Record makes the list complete). */
const EVAL_SCORE_FIELDS: Record<keyof EvalScore, true> = {
  name: true,
  value: true,
  label: true,
  explanation: true,
  metadata: true,
  passed: true,
  threshold: true,
  direction: true,
  scoreMin: true,
  scoreMax: true,
  judgeTraceId: true,
  evaluator: true,
  evaluatorType: true,
  evaluatorDescription: true,
  judgeModel: true,
  judgePromptName: true,
  judgePromptVersion: true,
};
const EVAL_SCORE_KEYS = Object.keys(EVAL_SCORE_FIELDS) as (keyof EvalScore)[];

/**
 * The EvalScore fields of `value`, read by name, so a class instance with prototype getters
 * works; null and undefined fields are left out (a JSON judge's `"explanation": null` means "not
 * set", like a missing key). Undefined when `value` is not an object.
 */
function readEvalScore(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of EVAL_SCORE_KEYS) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== null && v !== undefined) out[key] = v;
  }
  return out;
}

/** The EvalScore read by readEvalScore(), or why it is not a usable one. */
function checkedEvalScore(s: Record<string, unknown>): EvalScore | string {
  const reason = invalidReadScore(s);
  return reason ?? (s as unknown as EvalScore);
}

/** Why the fields read by readEvalScore() are not a usable EvalScore, or undefined when they are. */
function invalidReadScore(s: Record<string, unknown>): string | undefined {
  if (typeof s.name !== 'string' || s.name === '') return 'an object without a string name';
  if (s.value !== undefined && (typeof s.value !== 'number' || !Number.isFinite(s.value))) {
    return `an EvalScore "${s.name}" whose value is ${describeValue(s.value)}`;
  }
  if (s.passed !== undefined && typeof s.passed !== 'boolean') {
    return `an EvalScore "${s.name}" whose passed is not a boolean`;
  }
  if (s.label !== undefined && typeof s.label !== 'string') {
    return `an EvalScore "${s.name}" whose label is not a string`;
  }
  // The defineScorer() checks, so a returned EvalScore cannot write values it would reject.
  const invalidRule = ruleError(s);
  if (invalidRule) return `an EvalScore "${s.name}" whose ${invalidRule}`;
  for (const key of [
    'evaluator',
    'evaluatorDescription',
    'judgeModel',
    'judgePromptName',
    'judgePromptVersion',
    'judgeTraceId',
    'explanation',
  ] as const) {
    if (s[key] !== undefined && typeof s[key] !== 'string') {
      return `an EvalScore "${s.name}" whose ${key} is not a string`;
    }
  }
  return undefined;
}

/**
 * The scores a scorer returned (after awaiting it), or why the value cannot
 * be used: a finite number, a boolean (a verdict), an EvalScore or an
 * EvalScore[] is used; anything else (undefined, null, NaN, a bigint, a
 * malformed object) is not.
 */
function scorerResultScores(result: unknown, evalName: string): EvalScore[] | string {
  if (typeof result === 'boolean') return [{ name: evalName, value: result ? 1 : 0, passed: result }];
  if (typeof result === 'number') {
    return Number.isFinite(result) ? [{ name: evalName, value: result }] : `returned ${result}`;
  }
  const items: unknown[] = Array.isArray(result) ? result : [result];
  const scores: EvalScore[] = [];
  for (const item of items) {
    const read = readEvalScore(item);
    const score = read ? checkedEvalScore(read) : describeValue(item);
    if (typeof score === 'string') return `returned ${score}`;
    scores.push(score);
  }
  return scores;
}

export interface EvaluateOptions {
  name: string;
  /**
   * The agent under test: takes a case's input and returns its output, or a
   * Promise of it (an async agent; evaluate() then returns a Promise).
   */
  task: (input: unknown) => unknown;
  data: Array<{ input: unknown; expected?: unknown; caseId?: string; caseName?: string }>;
  /**
   * Scorer functions, sync or async, optionally wrapped with `defineScorer()`
   * to declare name and rule.
   */
  scores: Array<ScorerFn | Scorer>;
  /**
   * Run metadata, stamped on every `gen_ai.evaluation.result` event of the run
   * (reserved keys are dropped; the score's own metadata and the SDK
   * attributes win).
   */
  metadata?: Record<string, unknown>;
  /**
   * `test.suite.run.id` of the run. Default: a generated id. Pass the same id
   * from every CI shard so they report into one run, or the id of an existing
   * run to re-score it (send the new results with the same run id). Must not
   * be empty or whitespace.
   */
  runId?: string;
  /**
   * `opensearch.test.suite.run.name`: a human-readable name for the run, for
   * example `"v5 with shorter prompt"`, on every result of the run. Optional;
   * readers fall back to the short run id.
   */
  runName?: string;
  /**
   * `opensearch.test.suite.run.description`: free text about the run, on every
   * result of the run. Optional; truncated to 1024 characters.
   */
  runDescription?: string;
  /**
   * `gen_ai.agent.name` of the agent under test. Stamped on the agent root spans
   * that name none themselves and on every evaluation result.
   * When omitted, each case uses the agent its root span names, else
   * `register({ agentName })`.
   */
  agentName?: string;
  /** `gen_ai.agent.version` of the agent under test, resolved the same way. */
  agentVersion?: string;
  /**
   * Sets or overrides the OTel `cicd.pipeline.name` / `.run.id` / `.run.url.full`
   * read from GitHub Actions, GitLab CI or Jenkins. In CI they go on the
   * evaluation results and the agent root spans; nothing is added outside CI.
   */
  ciPipeline?: Record<string, string>;
  /**
   * Export each case's `expected` as `opensearch.test.case.expected` (and
   * `opensearch.test.case.expected_truncated` when cut) on its results.
   * Default true. Pass false if your test sets hold sensitive data: neither
   * attribute is then written (the value is still kept on the local result).
   */
  recordExpected?: boolean;
}

/**
 * The options of an `evaluate()` call with task `T` and scorers `S`. Only the task and scorer
 * types are inferred, so a misspelled option (`recordExpectd`) or data item field is still a
 * compile error.
 */
export type EvaluateOptionsOf<T extends EvaluateOptions['task'], S extends ScorerFn> = Omit<
  EvaluateOptions,
  'task' | 'scores'
> & { task: T; scores: S[] };

type CallKind<F> = F extends (...args: never[]) => infer R
  ? unknown extends R
    ? 'maybe'
    : [Extract<R, PromiseLike<unknown>>] extends [never]
      ? 'sync'
      : [Exclude<R, PromiseLike<unknown>>] extends [never]
        ? 'async'
        : 'maybe'
  : 'maybe';

type CallKinds<O extends EvaluateOptions> = CallKind<O['task']> | CallKind<O['scores'][number]>;

/**
 * What `evaluate(options)` returns: `BenchmarkResult` when the task and every
 * scorer are typed synchronous, else `BenchmarkResult | Promise<BenchmarkResult>`
 * (`await` it). evaluate() returns a Promise only once a task or scorer call
 * has returned one, so with no data, or when every task throws before it
 * awaits, even an async task gives the result directly.
 */
export type EvaluateResult<O extends EvaluateOptions = EvaluateOptions> =
  [Exclude<CallKinds<O>, 'sync'>] extends [never] ? BenchmarkResult : BenchmarkResult | Promise<BenchmarkResult>;

/**
 * Run `task` on each data item, score it and record the results.
 *
 * `task` and the scorers may be synchronous or async. When all are
 * synchronous, evaluate() returns the result directly, as before. Once a task
 * or scorer call returns a Promise (an async function, an `observe()`-wrapped
 * one, or any function returning a thenable), evaluate() awaits it and returns
 * a `Promise<BenchmarkResult>`; `await evaluate(...)` works either way. Invalid
 * options (an empty `runId`) throw synchronously.
 *
 * Cases run one at a time, in order, and so do the scorers of a case. Each
 * case's task call is its own trace. While a case runs (until the task's
 * Promise settles), the SDK's TestCaseSpanProcessor stamps `test.*` ids on the
 * root span(s) the task starts and remembers the first one, so score events
 * are parented to the agent run's own trace. The case rides in the OTel context
 * of the task (across `await` with a context manager, which register()
 * installs on Node), so overlapping evaluate() runs are kept apart. A span
 * started in a context without a case (`propagation.extract(ROOT_CONTEXT,
 * headers)`, `context.with(ROOT_CONTEXT, ...)`) is attached to the case only
 * while exactly one case runs and when it has no local parent; with
 * overlapping runs, start the agent inside the task's context. On Node,
 * evaluate() installs `AsyncLocalStorageContextManager` when no context
 * manager is set; where none can be installed every span is parentless, so
 * the same rule stamps a lone run and nothing for overlapping runs. Scorers run after the task, outside
 * the case and in an empty context: an LLM judge's spans are their own trace
 * (also when evaluate() runs inside a span) and are not stamped.
 *
 * A scorer returns (or resolves to) a finite number, a boolean (a verdict),
 * an `EvalScore` or an `EvalScore[]`; a `null` field of an EvalScore (as in
 * parsed judge JSON) counts as unset. A scorer that throws or rejects, or
 * returns anything else (undefined, null, NaN, a malformed object; with a
 * warning), emits an evaluator error result (`error.type`, no value, no label,
 * no explanation) named after its declared `name` (else the function name).
 * The exception message is kept only in the local `scorerErrors`. When the
 * task throws or rejects, the scorers are not run and every scorer emits such
 * an error result with the task's `error.type`.
 *
 * Local case status: `error` if the task threw or a result errored; else
 * `fail` if any score has a `fail` verdict (a `pass` / `fail` `label` /
 * `passed`, or `threshold` + `direction` from the score or its `defineScorer()`
 * declaration); else `pass`. Scores without a declared rule never fail a case.
 */
export function evaluate<T extends EvaluateOptions['task'], S extends ScorerFn>(
  options: EvaluateOptionsOf<T, S>,
): EvaluateResult<EvaluateOptionsOf<T, S>> {
  return runMaybeAsync(evaluateSteps(options)) as EvaluateResult<EvaluateOptionsOf<T, S>>;
}

/** evaluate()'s run, yielding each Promise it has to wait for (see runMaybeAsync). */
function* evaluateSteps(options: EvaluateOptions): Generator<PromiseLike<unknown>, BenchmarkResult, unknown> {
  const runId = makeRunId(options.runId);
  const run = runAttributes(options.runName, options.runDescription);
  const filteredMetadata = toAttributes(safeMetadata(options.metadata, `evaluate:${options.name}`));
  const runStart = performance.now();
  const cases: TestCaseResult[] = [];
  const resultKeys = new LocalResultKeys();
  // Per scorer: did its declaration reach any result it returned in this run? Decided, and
  // warned about, at the end of the run.
  const declarationUses = new Map<ScorerFn, DeclarationUse>();
  const declaredAgent = resolveAgent(options.agentName, options.agentVersion);
  const ci = ciPipelineAttributes(options.ciPipeline);
  const recordExpected = options.recordExpected ?? true;

  // Each scorer's own results keep the plain evaluation name, in scorer order, whatever the
  // order of results or errors in the run (see LocalResultKeys).
  for (const scorer of options.scores) {
    resultKeys.claim(specOf(scorer)?.name || scorer.name || 'score', keyEvaluatorOf(scorer));
  }

  ensureGlobalTestCaseProcessor();
  const leaveRun = enterEvaluateRun();
  try {

    for (const item of options.data) {
      const caseStart = performance.now();
      const identity: CaseIdentity = {
        suiteName: options.name,
        runId,
        caseId: item.caseId ?? makeCaseId(item.input),
        caseName: item.caseName,
        ci,
        run,
      };
      const expected = item.expected;
      const expectedAttrs = recordExpected ? expectedAttributes(expected) : undefined;

      let output: unknown;
      let error: string | undefined;
      let errorType: string | undefined;
      const caseScores: Record<string, number> = {};
      const verdicts: Record<string, Verdict> = {};
      const scoreGroups: Array<{ scores: EvalScore[]; spec?: ScorerSpec; errorType?: string }> = [];
      const scorerErrors: string[] = [];

      // Root spans get the declared agent (where they name none themselves).
      const active: ActiveTestCase = {
        attributes: { ...identityAttributes(identity), ...declaredAgent },
        seen: new Set(),
      };

      // Run the task as its own trace (ROOT_CONTEXT), carrying the case in its context.
      const leaveCase = enterTestCase(active);
      try {
        const caseContext = ROOT_CONTEXT.setValue(TEST_CASE_KEY, active);
        let out = otelContext.with(caseContext, () => options.task(item.input));
        if (isThenable(out)) out = yield out;
        output = out;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        errorType = errorTypeOf(e);
      } finally {
        leaveCase();
      }

      // The agent that ran: declared, else named on its root span, else the
      // register() default.
      identity.agent = resolveAgent(options.agentName, options.agentVersion, active.rootSpan);
      identity.expected = expectedAttrs;

      // Run scorers (outside the case: judge spans are not the agent run)
      for (const scorer of options.scores) {
        const spec = specOf(scorer);
        const owner = ownEvaluatorOf(scorer);
        // Evaluation name of number/boolean results and of the error result.
        const evalName = spec?.name || scorer.name || 'score';
        if (error !== undefined) {
          // The task threw: one error result per scorer, without the exception message.
          scoreGroups.push({ scores: [applySpec({ name: evalName }, spec, owner)], spec, errorType });
          continue;
        }
        // Error result (error.type, no value, no explanation) under the evaluation
        // name the scorer would have produced, so it is not a separate evaluation.
        // The message stays local (scorerErrors): it can carry URLs, keys or bodies.
        const scorerError = (message: string, type: string) => {
          scorerErrors.push(message);
          errorType ??= type;
          scoreGroups.push({ scores: [applySpec({ name: evalName }, spec, owner)], spec, errorType: type });
        };
        let result: unknown;
        try {
          // Its own trace (ROOT_CONTEXT), not a child of whatever span wraps evaluate().
          result = otelContext.with(ROOT_CONTEXT, () => scorer(item.input, output, expected));
          if (isThenable(result)) result = yield result;
        } catch (e) {
          scorerError(e instanceof Error ? e.message : String(e), errorTypeOf(e));
          continue;
        }
        const produced = scorerResultScores(result, evalName);
        if (typeof produced === 'string') {
          console.warn(
            `[opensearch-genai-observability-sdk-ts] evaluate(): scorer "${evalName}" ${produced}. ` +
              `A scorer returns a finite number, a boolean, an EvalScore or an EvalScore[]; ` +
              `recording an error result.`,
          );
          scorerError(`scorer "${evalName}" ${produced}`, INVALID_SCORER_RESULT);
          continue;
        }
        if (spec && produced.length > 0) {
          let use = declarationUses.get(scorer);
          if (!use) {
            use = { scorer, spec, evalName, owner, reached: false, named: new Set() };
            declarationUses.set(scorer, use);
          }
          if (produced.some(s => ownsScore(s, owner))) use.reached = true;
          else if (!use.reached) addEvaluatorsNamed(use.named, produced);
        }
        const withSpec = produced.map(s => applySpec(s, spec, owner));
        resultKeys.record(withSpec, keyEvaluatorOf(scorer), caseScores, verdicts);
        scoreGroups.push({ scores: withSpec, spec });
      }

      const failed = hasFailVerdict(verdicts);
      const resultStatus: TestCaseStatus = errorType ? 'error' : failed ? 'fail' : 'pass';
      const status = resultStatus === 'pass' ? 'pass' : 'fail';
      const root = active.root;
      for (const group of scoreGroups) {
        emitCaseScores(
          group.scores,
          identity,
          { traceId: root?.traceId, spanId: root?.spanId },
          filteredMetadata,
          // applySpec() filled the declared evaluator (not on another evaluator's scores).
          { errorType: group.errorType },
        );
      }

      cases.push({
        caseId: identity.caseId,
        caseName: identity.caseName,
        input: item.input,
        output,
        expected,
        scores: caseScores,
        error,
        status,
        resultStatus,
        errorType,
        durationMs: elapsedMs(caseStart),
        traceId: root?.traceId,
        spanId: root?.spanId,
        scorerErrors: scorerErrors.length > 0 ? scorerErrors : undefined,
        verdicts: Object.keys(verdicts).length > 0 ? verdicts : undefined,
      });
    }

    // A declaration that reached none of the results its scorer returned in the run (each
    // named another evaluator) warns, once per scorer.
    for (const use of declarationUses.values()) {
      if (!use.reached && userDeclaredFields(use.scorer, use.spec).length > 0) {
        warnDeclarationAppliesToNoResult(use);
      }
    }

    const summary = computeSummary(
      options.name,
      runId,
      cases,
      elapsedMs(runStart),
      run[TEST_SUITE_RUN_NAME_KEY],
    );
    console.log(formatSummary(summary));

    return { summary, cases };
  } finally {
    leaveRun();
  }
}
