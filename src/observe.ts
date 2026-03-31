// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";

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

const NAME_ATTR: Record<string, string> = {
  [Op.EXECUTE_TOOL]: "gen_ai.tool.name",
};
const DEFAULT_NAME_ATTR = "gen_ai.agent.name";

export interface ObserveOptions {
  name?: string;
  op?: string;
  kind?: SpanKind;
  nameFrom?: string;
}

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

function setInputAttributes(
  span: Span,
  args: unknown[],
  op: string | undefined,
): void {
  if (args.length === 0) return;
  const serialized = truncate(safeStringify(args.length === 1 ? args[0] : args));
  if (op === Op.EXECUTE_TOOL) {
    span.setAttribute("gen_ai.tool.call.arguments", serialized);
  } else {
    span.setAttribute("gen_ai.input.messages", serialized);
  }
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
  const serialized = truncate(safeStringify(result));
  span.setAttribute(attrKey, serialized);
}

function setNameAttributes(
  span: Span,
  name: string,
  op: string | undefined,
): void {
  const nameAttr = op ? (NAME_ATTR[op] ?? DEFAULT_NAME_ATTR) : DEFAULT_NAME_ATTR;
  span.setAttribute(nameAttr, name);
  if (op === Op.EXECUTE_TOOL) {
    span.setAttribute("gen_ai.tool.type", "function");
  }
  if (op) {
    span.setAttribute("gen_ai.operation.name", op);
  }
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

function resolveNameFromArgs(
  nameFrom: string,
  fn: Function,
  args: unknown[],
): string | undefined {
  // Try to get parameter names from function source
  const source = fn.toString();
  const match = source.match(/\(([^)]*)\)/);
  if (match) {
    const params = match[1].split(",").map((p) => p.trim().replace(/\s*=.*$/, "").replace(/\.{3}/, ""));
    const index = params.indexOf(nameFrom);
    if (index >= 0 && index < args.length) {
      const val = args[index];
      return typeof val === "string" ? val : undefined;
    }
  }
  // Fallback: check if first arg is an object with the key
  if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
    const val = (args[0] as Record<string, unknown>)[nameFrom];
    return typeof val === "string" ? val : undefined;
  }
  return undefined;
}

function wrapFunction<F extends (...args: any[]) => any>(
  fn: F,
  options: ObserveOptions,
): F {
  const baseName = options.name ?? fn.name ?? "anonymous";
  const op = options.op;
  const kind = options.kind ?? SpanKind.INTERNAL;
  const nameFrom = options.nameFrom;

  if (isAsyncGeneratorFunction(fn)) {
    const wrapped = function (this: any, ...args: any[]) {
      const resolvedName = nameFrom
        ? resolveNameFromArgs(nameFrom, fn, args) ?? baseName
        : baseName;
      const spanName = resolveSpanName(resolvedName, op);
      const tracer = getTracer();

      return tracer.startActiveSpan(spanName, { kind }, (span: Span) => {
        setNameAttributes(span, resolvedName, op);
        setInputAttributes(span, args, op);

        const gen = fn.apply(this, args) as AsyncGenerator;
        const collected: unknown[] = [];

        const wrapper: AsyncGenerator = {
          async next(...nextArgs: any[]) {
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
          async return(value: any) {
            setOutputAttributes(span, collected, op);
            span.end();
            return gen.return(value);
          },
          async throw(error: any) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
            span.recordException(error as Error);
            span.end();
            return gen.throw(error);
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };

        return wrapper as any;
      });
    };
    Object.defineProperty(wrapped, "name", { value: fn.name });
    return wrapped as unknown as F;
  }

  if (isGeneratorFunction(fn)) {
    const wrapped = function (this: any, ...args: any[]) {
      const resolvedName = nameFrom
        ? resolveNameFromArgs(nameFrom, fn, args) ?? baseName
        : baseName;
      const spanName = resolveSpanName(resolvedName, op);
      const tracer = getTracer();

      return tracer.startActiveSpan(spanName, { kind }, (span: Span) => {
        setNameAttributes(span, resolvedName, op);
        setInputAttributes(span, args, op);

        const gen = fn.apply(this, args) as Generator;
        const collected: unknown[] = [];

        const wrapper: Generator = {
          next(...nextArgs: any[]) {
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
          return(value: any) {
            setOutputAttributes(span, collected, op);
            span.end();
            return gen.return(value);
          },
          throw(error: any) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
            span.recordException(error as Error);
            span.end();
            return gen.throw(error);
          },
          [Symbol.iterator]() {
            return this;
          },
        };

        return wrapper as any;
      });
    };
    Object.defineProperty(wrapped, "name", { value: fn.name });
    return wrapped as unknown as F;
  }

  const wrapped = function (this: any, ...args: any[]) {
    const resolvedName = nameFrom
      ? resolveNameFromArgs(nameFrom, fn, args) ?? baseName
      : baseName;
    const spanName = resolveSpanName(resolvedName, op);
    const tracer = getTracer();

    return tracer.startActiveSpan(spanName, { kind }, (span: Span) => {
      setNameAttributes(span, resolvedName, op);
      setInputAttributes(span, args, op);

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
            }) as any;
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

// Overload signatures
export function observe<F extends (...args: any[]) => any>(fn: F): F;
export function observe<F extends (...args: any[]) => any>(
  options: ObserveOptions,
  fn: F,
): F;
export function observe(
  options: ObserveOptions,
): <F extends (...args: any[]) => any>(fn: F) => F;

// Implementation
export function observe(
  fnOrOptions: ((...args: any[]) => any) | ObserveOptions,
  maybeFn?: (...args: any[]) => any,
): any {
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
  return <F extends (...args: any[]) => any>(fn: F): F => {
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
