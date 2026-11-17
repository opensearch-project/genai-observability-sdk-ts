// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import {
  trace,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { spanAttributes } from "./internal.js";

const TRACER_NAME = "opensearch-genai-observability-sdk-ts";
const MAX_ATTR_LENGTH = 10_000;
const TRUNCATION_SUFFIX = "...(truncated)";

export class Op {
  static readonly CHAT = "chat";
  static readonly CREATE_AGENT = "create_agent";
  static readonly INVOKE_AGENT = "invoke_agent";
  static readonly EXECUTE_TOOL = "execute_tool";
  static readonly RETRIEVAL = "retrieval";
  static readonly EMBEDDINGS = "embeddings";
  static readonly GENERATE_CONTENT = "generate_content";
  static readonly TEXT_COMPLETION = "text_completion";
}

const PREFIXED_OPS = new Set([
  Op.INVOKE_AGENT,
  Op.CREATE_AGENT,
  Op.EXECUTE_TOOL,
  Op.CHAT,
  Op.RETRIEVAL,
  Op.EMBEDDINGS,
  Op.GENERATE_CONTENT,
  Op.TEXT_COMPLETION,
]);

// Name attribute per op. Only agent operations name an agent: a chat, retrieval or embeddings
// span (for example a traced LLM judge call) must not carry gen_ai.agent.name, or Agent Traces
// would list it as an agent. Set it explicitly (span.setAttribute("gen_ai.agent.name", ...)) if
// a span needs it.
const NAME_ATTR: Record<string, string> = {
  [Op.INVOKE_AGENT]: "gen_ai.agent.name",
  [Op.CREATE_AGENT]: "gen_ai.agent.name",
  [Op.EXECUTE_TOOL]: "gen_ai.tool.name",
};

export interface ObserveOptions {
  name?: string;
  op?: string;
  kind?: SpanKind;
  nameFrom?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => any;

function truncate(value: string): string {
  if (value.length <= MAX_ATTR_LENGTH) return value;
  return value.slice(0, MAX_ATTR_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

function resolveSpanName(
  baseName: string,
  op: string | undefined,
): string {
  if (op && PREFIXED_OPS.has(op)) {
    return `${op} ${baseName}`;
  }
  return baseName;
}

// A JavaScript identifier, Unicode letters included (`café`, `ünits`).
const IDENTIFIER_SOURCE = "[\\p{ID_Start}$_][\\p{ID_Continue}$\\u200c\\u200d]*";
const IDENTIFIER = new RegExp(`^${IDENTIFIER_SOURCE}`, "u");
// Arrow function with a single unparenthesized parameter: `x => ...` / `async x => ...`.
const BARE_ARROW = new RegExp(`^(?:async\\s+)?(${IDENTIFIER_SOURCE})\\s*=>`, "u");

/** One declared parameter: its name (empty when it has none, e.g. destructuring) and rest flag. */
interface ParamInfo {
  name: string;
  rest: boolean;
}

/** A piece of source code: a whole string or template literal, or one other character. */
interface SourceToken {
  text: string;
  /** True for a string or template literal. */
  quoted: boolean;
  /** Bracket depth around the token: an opening bracket is at the depth before it, a closing one after it. */
  depth: number;
}

/**
 * The tokens of `source` from `start`, skipping comments; returns false when a block comment is
 * not closed. Nested brackets are tracked by depth, and a string or template literal is one
 * token, so brackets and commas inside it do not count.
 */
function* sourceTokens(source: string, start = 0): Generator<SourceToken, boolean> {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === '"' || c === "`") {
      const from = i;
      for (i++; i < source.length && source[i] !== c; i++) {
        if (source[i] === "\\") i++;
      }
      yield { text: source.slice(from, i + 1), quoted: true, depth };
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) return false;
      i = end + 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      yield { text: c, quoted: false, depth: depth++ };
    } else if (c === ")" || c === "]" || c === "}") {
      yield { text: c, quoted: false, depth: --depth };
    } else {
      yield { text: c, quoted: false, depth };
    }
  }
  return true;
}

/**
 * The text between the parameter list's parentheses, starting at `open` (a "("), with comments
 * removed, or undefined when the parentheses are unbalanced. Skips nested brackets, strings and
 * template literals, so default values like `(a = f(1), b = ")")` are kept whole.
 */
function balancedParams(source: string, open: number): string | undefined {
  let out = "";
  let first = true;
  for (const token of sourceTokens(source, open)) {
    if (first) {
      first = false;
      continue; // the "(" at `open`
    }
    if (!token.quoted && token.depth === 0) return token.text === ")" ? out : undefined;
    out += token.text;
  }
  return undefined;
}

/** Split a parameter list at top-level commas. */
function splitTopLevel(params: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const token of sourceTokens(params)) {
    if (!token.quoted && token.text === "," && token.depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += token.text;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * The declared parameters of `fn`, read from its source. Handles `function` expressions and
 * declarations, methods, arrows with and without parentheses (`x => ...`, `async x => ...`, as
 * tsx/esbuild emit for one-parameter arrows), default values and rest parameters. A
 * destructured parameter has no name (`name: ""`). Returns undefined when the source cannot be
 * parsed (for example native or bound functions), so callers fall back to positional names.
 * Known limit: a regular expression literal containing `)` in a default value
 * (`(a = /\)/, b) => ...`) ends the list early, so later parameters get positional names.
 */
export function parseParams(fn: AnyFunction): ParamInfo[] | undefined {
  let source: string;
  try {
    source = Function.prototype.toString.call(fn).trim();
  } catch {
    return undefined;
  }
  if (/\{\s*\[native code\]\s*\}\s*$/.test(source)) return undefined;

  const bare = source.match(BARE_ARROW);
  if (bare) return [{ name: bare[1], rest: false }];

  const open = source.indexOf("(");
  if (open < 0) return undefined;
  const params = balancedParams(source, open);
  if (params === undefined) return undefined;
  return splitTopLevel(params).map((param) => {
    const rest = param.startsWith("...");
    const body = rest ? param.slice(3).trim() : param;
    const name = body.match(IDENTIFIER)?.[0] ?? "";
    return { name, rest };
  });
}

/**
 * The input object recorded for a call: declared parameter names as keys, a rest parameter
 * collects the remaining arguments, and arguments without a usable name (destructured, extra
 * or unparseable) are keyed by position (`arg0`, `arg1`, ...). A positional key never replaces
 * a declared name: if `arg1` is taken it becomes `_arg1`. Pass `params` (from `parseParams`) to
 * skip parsing the source again.
 */
export function namedArguments(
  fn: AnyFunction,
  args: unknown[],
  params: ParamInfo[] | undefined = parseParams(fn),
): Record<string, unknown> {
  const declared = new Set((params ?? []).map((p) => p.name).filter(Boolean));
  const obj: Record<string, unknown> = {};
  const positional = (i: number): string => {
    let key = `arg${i}`;
    while (declared.has(key) || Object.hasOwn(obj, key)) key = `_${key}`;
    return key;
  };
  for (let i = 0; i < args.length; i++) {
    const param = params?.[i];
    if (param?.rest) {
      obj[param.name && !Object.hasOwn(obj, param.name) ? param.name : positional(i)] = args.slice(i);
      break;
    }
    const key = param?.name && !Object.hasOwn(obj, param.name) ? param.name : positional(i);
    obj[key] = args[i];
  }
  return obj;
}

function setInputAttributes(
  span: Span,
  args: unknown[],
  op: string | undefined,
  fn: AnyFunction,
  params: ParamInfo[] | undefined,
): void {
  if (args.length === 0) return;
  try {
    const serialized = truncate(safeStringify(namedArguments(fn, args, params ?? [])));
    if (op === Op.EXECUTE_TOOL) {
      span.setAttribute("gen_ai.tool.call.arguments", serialized);
    } else {
      span.setAttribute("gen_ai.input.messages", serialized);
    }
  } catch { /* ignore */ }
}

function setOutputAttributes(
  span: Span,
  result: unknown,
  op: string | undefined,
): void {
  if (result === undefined || result === null) return;
  const attrKey =
    op === Op.EXECUTE_TOOL
      ? "gen_ai.tool.call.result"
      : "gen_ai.output.messages";
  // Keep a value set inside the function (enrich({ outputMessages }), or setAttribute), as the
  // Python SDK does: the return value is recorded only when nothing was set.
  if (spanAttributes(span)?.[attrKey] !== undefined) return;
  const serialized = truncate(safeStringify(result));
  span.setAttribute(attrKey, serialized);
}

function setNameAttributes(
  span: Span,
  name: string,
  op: string | undefined,
): void {
  if (!op) return; // as in the Python SDK: no op, no GenAI attributes
  const nameAttr = NAME_ATTR[op];
  if (nameAttr) span.setAttribute(nameAttr, name);
  if (op === Op.EXECUTE_TOOL) {
    span.setAttribute("gen_ai.tool.type", "function");
  }
  span.setAttribute("gen_ai.operation.name", op);
}

function isAsyncGeneratorFunction(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    fn.constructor?.name === "AsyncGeneratorFunction"
  );
}

function isGeneratorFunction(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    fn.constructor?.name === "GeneratorFunction"
  );
}

/**
 * The span name taken from the argument of the parameter called `nameFrom`, or from that key of
 * an object first argument. Uses the same parameter parsing as the recorded input, so arrows
 * without parentheses and default values with commas or parentheses resolve correctly.
 */
export function resolveNameFromArgs(
  nameFrom: string,
  args: unknown[],
  params: ParamInfo[] | undefined,
): string | undefined {
  const index = params?.findIndex((p) => !p.rest && p.name === nameFrom) ?? -1;
  if (index >= 0 && index < args.length) {
    const val = args[index];
    return typeof val === "string" ? val : undefined;
  }
  // Fallback: an object first argument with that key.
  if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
    const first = args[0] as Record<string, unknown>;
    // Own or inherited (a class getter), but never a key from Object.prototype.
    const val = nameFrom in first && !(nameFrom in Object.prototype) ? first[nameFrom] : undefined;
    return typeof val === "string" ? val : undefined;
  }
  return undefined;
}

function wrapFunction<F extends AnyFunction>(
  fn: F,
  options: ObserveOptions,
): F {
  const baseName = options.name ?? fn.name ?? "anonymous";
  const op = options.op;
  const kind = options.kind ?? SpanKind.INTERNAL;
  const nameFrom = options.nameFrom;
  // The parameter list of fn never changes: parse it once, not on every call.
  const params = parseParams(fn);

  if (isAsyncGeneratorFunction(fn)) {
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const resolvedName = nameFrom
        ? resolveNameFromArgs(nameFrom, args, params) ?? baseName
        : baseName;
      const spanName = resolveSpanName(resolvedName, op);
      const tracer = getTracer();

      return tracer.startActiveSpan(spanName, { kind }, (span: Span) => {
        setNameAttributes(span, resolvedName, op);
        setInputAttributes(span, args, op, fn, params);

        const gen = fn.apply(this, args) as AsyncGenerator;
        const collected: unknown[] = [];

        const wrapper: AsyncGenerator = {
          async next(...nextArgs: [] | [unknown]) {
            try {
              const result = await gen.next(...nextArgs);
              if (!result.done) {
                collected.push(result.value);
              } else {
                setOutputAttributes(span, collected, op);
                span.end();
              }
              return result;
            } catch (error) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
              span.recordException(error as Error);
              span.end();
              throw error;
            }
          },
          async return(value: unknown) {
            setOutputAttributes(span, collected, op);
            span.end();
            return gen.return(value);
          },
          async throw(error: unknown) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
            span.recordException(error as Error);
            span.end();
            return gen.throw(error);
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };

        return wrapper as ReturnType<F>;
      });
    };
    Object.defineProperty(wrapped, "name", { value: fn.name });
    return wrapped as unknown as F;
  }

  if (isGeneratorFunction(fn)) {
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const resolvedName = nameFrom
        ? resolveNameFromArgs(nameFrom, args, params) ?? baseName
        : baseName;
      const spanName = resolveSpanName(resolvedName, op);
      const tracer = getTracer();

      return tracer.startActiveSpan(spanName, { kind }, (span: Span) => {
        setNameAttributes(span, resolvedName, op);
        setInputAttributes(span, args, op, fn, params);

        const gen = fn.apply(this, args) as Generator;
        const collected: unknown[] = [];

        const wrapper: Generator = {
          next(...nextArgs: [] | [unknown]) {
            try {
              const result = gen.next(...nextArgs);
              if (!result.done) {
                collected.push(result.value);
              } else {
                setOutputAttributes(span, collected, op);
                span.end();
              }
              return result;
            } catch (error) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
              span.recordException(error as Error);
              span.end();
              throw error;
            }
          },
          return(value: unknown) {
            setOutputAttributes(span, collected, op);
            span.end();
            return gen.return(value);
          },
          throw(error: unknown) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
            span.recordException(error as Error);
            span.end();
            return gen.throw(error);
          },
          [Symbol.iterator]() {
            return this;
          },
        };

        return wrapper as ReturnType<F>;
      });
    };
    Object.defineProperty(wrapped, "name", { value: fn.name });
    return wrapped as unknown as F;
  }

  const wrapped = function (this: unknown, ...args: unknown[]) {
    const resolvedName = nameFrom
      ? resolveNameFromArgs(nameFrom, args, params) ?? baseName
      : baseName;
    const spanName = resolveSpanName(resolvedName, op);
    const tracer = getTracer();

    return tracer.startActiveSpan(spanName, { kind }, (span: Span) => {
      setNameAttributes(span, resolvedName, op);
      setInputAttributes(span, args, op, fn, params);

      try {
        const result = fn.apply(this, args);

        if (result instanceof Promise) {
          return result
            .then((resolved: unknown) => {
              setOutputAttributes(span, resolved, op);
              span.end();
              return resolved;
            })
            .catch((error: unknown) => {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: String(error),
              });
              span.recordException(error as Error);
              span.end();
              throw error;
            }) as ReturnType<F>;
        }

        setOutputAttributes(span, result, op);
        span.end();
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: String(error),
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    });
  };
  Object.defineProperty(wrapped, "name", { value: fn.name });
  return wrapped as unknown as F;
}

// Overload signatures — `any` required here for TypeScript generic variance:
// users pass functions with arbitrary signatures, and `unknown` would break callability.
export function observe<F extends AnyFunction>(fn: F): F;
export function observe<F extends AnyFunction>(
  options: ObserveOptions,
  fn: F,
): F;
export function observe(
  options: ObserveOptions,
): <F extends AnyFunction>(fn: F) => F;

// Implementation
export function observe(
  fnOrOptions: AnyFunction | ObserveOptions,
  maybeFn?: AnyFunction,
): unknown {
  // observe(fn)
  if (typeof fnOrOptions === "function") {
    return wrapFunction(fnOrOptions, {});
  }

  const options = fnOrOptions;

  // observe(options, fn)
  if (typeof maybeFn === "function") {
    return wrapFunction(maybeFn, options);
  }

  // observe(options) → wrapper
  return <F extends AnyFunction>(fn: F): F => {
    return wrapFunction(fn, options);
  };
}

// withObserve overloads
export function withObserve<T>(name: string, fn: (span: Span) => T): T;
export function withObserve<T>(
  name: string,
  options: { op?: string; kind?: SpanKind },
  fn: (span: Span) => T,
): T;

export function withObserve<T>(
  name: string,
  optionsOrFn: { op?: string; kind?: SpanKind } | ((span: Span) => T),
  maybeFn?: (span: Span) => T,
): T {
  let options: { op?: string; kind?: SpanKind } = {};
  let fn: (span: Span) => T;

  if (typeof optionsOrFn === "function") {
    fn = optionsOrFn;
  } else {
    options = optionsOrFn;
    fn = maybeFn!;
  }

  const op = options.op;
  const kind = options.kind ?? SpanKind.INTERNAL;
  const spanName = resolveSpanName(name, op);
  const tracer = getTracer();

  return tracer.startActiveSpan(spanName, { kind }, (span: Span) => {
    setNameAttributes(span, name, op);

    try {
      const result = fn(span);

      if (result instanceof Promise) {
        return (result as Promise<unknown>)
          .then((resolved) => {
            span.end();
            return resolved;
          })
          .catch((error) => {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(error),
            });
            span.recordException(error as Error);
            span.end();
            throw error;
          }) as unknown as T;
      }

      span.end();
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: String(error),
      });
      span.recordException(error as Error);
      span.end();
      throw error;
    }
  });
}
