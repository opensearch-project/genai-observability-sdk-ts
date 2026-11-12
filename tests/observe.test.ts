// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { observe, withObserve, Op, namedArguments, parseParams } from '../src/observe.js';
import { enrich } from '../src/enrich.js';
import { getFinishedSpans, clearSpans } from './setup.js';

beforeEach(() => clearSpans());
afterEach(() => clearSpans());

describe('Op constants', () => {
  it('has all expected operation types', () => {
    expect(Op.CHAT).toBe('chat');
    expect(Op.CREATE_AGENT).toBe('create_agent');
    expect(Op.INVOKE_AGENT).toBe('invoke_agent');
    expect(Op.EXECUTE_TOOL).toBe('execute_tool');
    expect(Op.RETRIEVAL).toBe('retrieval');
    expect(Op.EMBEDDINGS).toBe('embeddings');
    expect(Op.GENERATE_CONTENT).toBe('generate_content');
    expect(Op.TEXT_COMPLETION).toBe('text_completion');
  });
});

describe('observe - sync functions', () => {
  it('wraps a named function and creates a span', () => {
    function greet(name: string) { return `Hello ${name}`; }
    const wrapped = observe(greet);

    const result = wrapped('world');
    expect(result).toBe('Hello world');

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('greet');
  });

  it('captures output in span attributes', () => {
    function add(a: number, b: number) { return a + b; }
    const wrapped = observe(add);

    const result = wrapped(2, 3);
    expect(result).toBe(5);

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    const attrs = spans[0].attributes;
    expect(attrs['gen_ai.output.messages']).toBeDefined();
    expect(String(attrs['gen_ai.output.messages'])).toContain('5');
  });

  it('captures input in span attributes', () => {
    function echo(msg: string) { return msg; }
    const wrapped = observe(echo);
    wrapped('test-input');

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    const attrs = spans[0].attributes;
    expect(attrs['gen_ai.input.messages']).toBeDefined();
    expect(String(attrs['gen_ai.input.messages'])).toContain('test-input');
  });

  it('records errors on span', () => {
    function failing() { throw new Error('boom'); }
    const wrapped = observe(failing);

    expect(() => wrapped()).toThrow('boom');

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].events.length).toBeGreaterThanOrEqual(1);
  });

  it('observe(fn) preserves function name', () => {
    function myFunc() { return 42; }
    const wrapped = observe(myFunc);
    expect(wrapped.name).toBe('myFunc');
  });
});

describe('observe - with options', () => {
  it('observe(options, fn) sets custom name', () => {
    const wrapped = observe({ name: 'custom-span' }, function () { return 1; });
    wrapped();

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('custom-span');
  });

  it('observe(options) returns a decorator', () => {
    const decorator = observe({ name: 'decorated' });
    const wrapped = decorator(function () { return 'ok'; });
    const result = wrapped();
    expect(result).toBe('ok');

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('decorated');
  });

  it('op prefixes span name for known operations', () => {
    const wrapped = observe({ name: 'myAgent', op: Op.INVOKE_AGENT }, function () { return 'ok'; });
    wrapped();

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('invoke_agent myAgent');
  });

  it('sets gen_ai.operation.name attribute for op', () => {
    const wrapped = observe({ name: 'myChat', op: Op.CHAT }, function () { return 'ok'; });
    wrapped();

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes['gen_ai.operation.name']).toBe('chat');
  });

  it('sets gen_ai.agent.name for non-tool ops', () => {
    const wrapped = observe({ name: 'agent1', op: Op.INVOKE_AGENT }, function () { return 'ok'; });
    wrapped();

    const spans = getFinishedSpans();
    expect(spans[0].attributes['gen_ai.agent.name']).toBe('agent1');
  });

  it('sets gen_ai.tool.name and gen_ai.tool.type for execute_tool', () => {
    const wrapped = observe(
      { name: 'myTool', op: Op.EXECUTE_TOOL },
      function () { return 'result'; },
    );
    wrapped();

    const spans = getFinishedSpans();
    expect(spans[0].attributes['gen_ai.tool.name']).toBe('myTool');
    expect(spans[0].attributes['gen_ai.tool.type']).toBe('function');
  });

  it('uses tool-specific input/output attribute keys for execute_tool', () => {
    const wrapped = observe(
      { name: 'tool1', op: Op.EXECUTE_TOOL },
      function (arg: string) { return `result:${arg}`; },
    );
    wrapped('input1');

    const spans = getFinishedSpans();
    const attrs = spans[0].attributes;
    expect(attrs['gen_ai.tool.call.arguments']).toBeDefined();
    expect(attrs['gen_ai.tool.call.result']).toBeDefined();
  });

  it('respects custom SpanKind', () => {
    const wrapped = observe(
      { name: 'server', kind: SpanKind.SERVER },
      function () { return 'ok'; },
    );
    wrapped();

    const spans = getFinishedSpans();
    expect(spans[0].kind).toBe(SpanKind.SERVER);
  });
});

describe('observe - async functions', () => {
  it('wraps async function and creates span', async () => {
    async function asyncGreet(name: string) { return `Hello ${name}`; }
    const wrapped = observe(asyncGreet);

    const result = await wrapped('async');
    expect(result).toBe('Hello async');

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('asyncGreet');
  });

  it('records async errors on span', async () => {
    async function asyncFail() { throw new Error('async-boom'); }
    const wrapped = observe(asyncFail);

    await expect(wrapped()).rejects.toThrow('async-boom');

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('captures async output', async () => {
    async function asyncCompute() { return { value: 42 }; }
    const wrapped = observe(asyncCompute);

    const result = await wrapped();
    expect(result).toEqual({ value: 42 });

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    const output = spans[0].attributes['gen_ai.output.messages'];
    expect(output).toBeDefined();
    expect(String(output)).toContain('42');
  });
});

describe('observe - generators', () => {
  it('wraps sync generator and collects output', () => {
    function* genNumbers() {
      yield 1;
      yield 2;
      yield 3;
    }
    const wrapped = observe(genNumbers);
    const gen = wrapped();

    const values: number[] = [];
    for (const v of gen) {
      values.push(v);
    }
    expect(values).toEqual([1, 2, 3]);

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    const output = spans[0].attributes['gen_ai.output.messages'];
    expect(output).toBeDefined();
    expect(String(output)).toContain('[1,2,3]');
  });

  it('wraps async generator and collects output', async () => {
    async function* asyncGen() {
      yield 'a';
      yield 'b';
    }
    const wrapped = observe(asyncGen);
    const gen = wrapped();

    const values: string[] = [];
    for await (const v of gen) {
      values.push(v);
    }
    expect(values).toEqual(['a', 'b']);

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    const output = spans[0].attributes['gen_ai.output.messages'];
    expect(output).toBeDefined();
  });

  it('records error on generator throw', () => {
    function* genError() {
      yield 1;
      throw new Error('gen-boom');
    }
    const wrapped = observe(genError);
    const gen = wrapped();

    expect(gen.next()).toEqual({ value: 1, done: false });
    expect(() => gen.next()).toThrow('gen-boom');

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('observe - nameFrom', () => {
  it('resolves name from function argument', () => {
    function processAgent(agentName: string, data: number) { return data; }
    const wrapped = observe({ nameFrom: 'agentName', op: Op.INVOKE_AGENT }, processAgent);

    wrapped('myDynamicAgent', 42);

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('invoke_agent myDynamicAgent');
    expect(spans[0].attributes['gen_ai.agent.name']).toBe('myDynamicAgent');
  });

  it('falls back to static name if nameFrom param not found', () => {
    function processAgent(agentName: string) { return agentName; }
    const wrapped = observe({ name: 'fallback', nameFrom: 'missing', op: Op.CHAT }, processAgent);

    wrapped('test');

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('chat fallback');
  });
});

describe('observe - parent-child spans', () => {
  it('creates nested spans', () => {
    const inner = observe({ name: 'child' }, function () { return 'inner'; });
    const outer = observe({ name: 'parent' }, function () { return inner(); });

    outer();

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(2);

    const childSpan = spans.find(s => s.name === 'child')!;
    const parentSpan = spans.find(s => s.name === 'parent')!;
    expect(childSpan).toBeDefined();
    expect(parentSpan).toBeDefined();
    expect(childSpan.parentSpanId).toBe(parentSpan.spanContext().spanId);
  });
});

describe('observe - edge cases', () => {
  it('handles function returning null', () => {
    const wrapped = observe(function nullFn() { return null; });
    const result = wrapped();
    expect(result).toBeNull();

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    // null output should not be recorded
    expect(spans[0].attributes['gen_ai.output.messages']).toBeUndefined();
  });

  it('handles function returning undefined', () => {
    const wrapped = observe(function voidFn() { /* no return */ });
    const result = wrapped();
    expect(result).toBeUndefined();

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
  });

  it('handles function with no arguments', () => {
    const wrapped = observe(function noArgs() { return 'ok'; });
    const result = wrapped();
    expect(result).toBe('ok');

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
  });

  it('no op means no prefix on span name', () => {
    const wrapped = observe({ name: 'plain' }, function () { return 'ok'; });
    wrapped();

    const spans = getFinishedSpans();
    expect(spans[0].name).toBe('plain');
  });

  it('preserves this context', () => {
    const obj = {
      value: 42,
      method: observe(function method(this: { value: number }) {
        return this.value;
      }),
    };
    const result = obj.method();
    expect(result).toBe(42);
  });
});

describe('withObserve', () => {
  it('creates a span around sync callback', () => {
    const result = withObserve('my-block', (span) => {
      expect(span).toBeDefined();
      return 42;
    });
    expect(result).toBe(42);

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('my-block');
  });

  it('creates a span around async callback', async () => {
    const result = await withObserve('async-block', async (span) => {
      expect(span).toBeDefined();
      return 'async-result';
    });
    expect(result).toBe('async-result');

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('async-block');
  });

  it('records error on sync throw', () => {
    expect(() =>
      withObserve('error-block', () => {
        throw new Error('block-boom');
      }),
    ).toThrow('block-boom');

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('records error on async rejection', async () => {
    await expect(
      withObserve('async-error', async () => {
        throw new Error('async-block-boom');
      }),
    ).rejects.toThrow('async-block-boom');

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('accepts options with op', () => {
    withObserve('myAgent', { op: Op.INVOKE_AGENT }, (_span) => {
      return 'ok';
    });

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('invoke_agent myAgent');
    expect(spans[0].attributes['gen_ai.operation.name']).toBe('invoke_agent');
  });

  it('accepts options with custom kind', () => {
    withObserve('server-block', { kind: SpanKind.SERVER }, (_span) => {
      return 'ok';
    });

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe(SpanKind.SERVER);
  });
});

describe('observe - keeps output set inside the function', () => {
  const text = (role: string, content: string) => [{ role, parts: [{ type: 'text', content }] }];

  it('keeps gen_ai.output.messages set by enrich() (sync)', () => {
    const agent = observe({ name: 'agent', op: Op.INVOKE_AGENT }, function agent(q: string) {
      enrich({ outputMessages: text('assistant', `answer to ${q}`) });
      return 'raw return value';
    });
    expect(agent('q1')).toBe('raw return value');
    const out = String(getFinishedSpans()[0].attributes['gen_ai.output.messages']);
    expect(JSON.parse(out)).toEqual(text('assistant', 'answer to q1'));
  });

  it('keeps gen_ai.output.messages set by enrich() (async)', async () => {
    const agent = observe({ name: 'agent', op: Op.INVOKE_AGENT }, async (q: string) => {
      await Promise.resolve();
      enrich({ outputMessages: text('assistant', `async ${q}`) });
      return 'raw';
    });
    await agent('q2');
    const out = String(getFinishedSpans()[0].attributes['gen_ai.output.messages']);
    expect(JSON.parse(out)).toEqual(text('assistant', 'async q2'));
  });

  it('records the return value when nothing was set', () => {
    observe({ name: 'agent', op: Op.INVOKE_AGENT }, () => 'sunny, 22C')();
    expect(getFinishedSpans()[0].attributes['gen_ai.output.messages']).toBe('"sunny, 22C"');
  });

  it('keeps a tool result set inside the tool', () => {
    const tool = observe({ name: 't', op: Op.EXECUTE_TOOL }, function t(city: string) {
      trace.getActiveSpan()!.setAttribute('gen_ai.tool.call.result', 'custom');
      return { city };
    });
    tool('Paris');
    expect(getFinishedSpans()[0].attributes['gen_ai.tool.call.result']).toBe('custom');
  });

  it('withObserve() keeps enrich() output and does not auto-record', () => {
    withObserve('agent', { op: Op.INVOKE_AGENT }, () => {
      enrich({ outputMessages: text('assistant', 'kept') });
      return 'raw';
    });
    const out = String(getFinishedSpans()[0].attributes['gen_ai.output.messages']);
    expect(JSON.parse(out)).toEqual(text('assistant', 'kept'));
  });
});

// Sources exactly as tsx 4.23 (esbuild) compiles these TypeScript functions, captured with
// `tsx probe.ts` printing String(fn). Rebuilt with `new Function` so the SDK sees that text.
const TSX_COMPILED = {
  oneParam: 'city=>({city,temp:22})', // (city: string) => ({ city, temp: 22 })
  asyncOne: 'async city=>({city})', // async (city: string) => ({ city })
  defaults: '(city="Paris",units={c:true})=>`${city}${units}`',
  destructured: '({city,units},[first])=>city+units+first',
  rest: '(first,...others)=>[first,...others]',
  twoParams: '(a,b)=>a+b',
};
const compiled = (src: string) => new Function(`return (${src});`)() as (...a: unknown[]) => unknown;

describe('argument names', () => {
  it('one-parameter arrow without parentheses (tsx/esbuild output)', () => {
    const fn = compiled(TSX_COMPILED.oneParam);
    expect(String(fn)).toBe('city=>({city,temp:22})');
    expect(namedArguments(fn, ['Paris'])).toEqual({ city: 'Paris' });
  });

  it('records {"city":"Paris"} as tool arguments for a tsx-compiled arrow tool', () => {
    const tool = observe({ name: 'get_weather', op: Op.EXECUTE_TOOL }, compiled(TSX_COMPILED.oneParam));
    tool('Paris');
    expect(getFinishedSpans()[0].attributes['gen_ai.tool.call.arguments']).toBe('{"city":"Paris"}');
  });

  it('async arrow without parentheses', () => {
    expect(namedArguments(compiled(TSX_COMPILED.asyncOne), ['Rome'])).toEqual({ city: 'Rome' });
    expect(namedArguments(async (x: number) => x, [1])).toEqual({ x: 1 });
  });

  it('default parameters, including ones with parentheses and commas', () => {
    expect(namedArguments(compiled(TSX_COMPILED.defaults), ['Oslo', 'f'])).toEqual({
      city: 'Oslo',
      units: 'f',
    });
    const fn = compiled('(a = Math.max(1, 2), b = ")", c = [1, 2]) => a');
    expect(parseParams(fn)).toEqual([
      { name: 'a', rest: false },
      { name: 'b', rest: false },
      { name: 'c', rest: false },
    ]);
  });

  it('destructured parameters fall back to positional names', () => {
    const fn = compiled(TSX_COMPILED.destructured);
    expect(namedArguments(fn, [{ city: 'Lima', units: 'c' }, ['x']])).toEqual({
      arg0: { city: 'Lima', units: 'c' },
      arg1: ['x'],
    });
  });

  it('rest parameter collects the remaining arguments', () => {
    expect(namedArguments(compiled(TSX_COMPILED.rest), [1, 2, 3])).toEqual({ first: 1, others: [2, 3] });
  });

  it('plain parameter lists, function expressions and methods', () => {
    expect(namedArguments(compiled(TSX_COMPILED.twoParams), [1, 2])).toEqual({ a: 1, b: 2 });
    expect(namedArguments(function add(a: number, b: number) { return a + b; }, [1, 2])).toEqual({ a: 1, b: 2 });
    const obj = { greet(name: string) { return name; } };
    expect(namedArguments(obj.greet, ['Ann'])).toEqual({ name: 'Ann' });
    expect(namedArguments(compiled('async function f(x, /* c, d */ y) { return (x); }'), [1, 2])).toEqual({ x: 1, y: 2 });
  });

  it('extra arguments get positional names', () => {
    expect(namedArguments(compiled('(a) => a'), [1, 2])).toEqual({ a: 1, arg1: 2 });
    expect(namedArguments(compiled('() => 1'), ['x'])).toEqual({ arg0: 'x' });
  });

  it('unparseable sources (native, bound) fall back to positional names', () => {
    expect(parseParams(Math.max)).toBeUndefined();
    const bound = function f(a: number) { return a; }.bind(null);
    expect(parseParams(bound)).toBeUndefined();
    expect(namedArguments(bound, [5, 6])).toEqual({ arg0: 5, arg1: 6 });
  });

  it('never produces keys with brackets or braces', () => {
    for (const src of Object.values(TSX_COMPILED)) {
      const keys = Object.keys(namedArguments(compiled(src), [1, 2, 3]));
      for (const k of keys) expect(k).toMatch(/^[A-Za-z_$][\w$]*$/);
    }
  });
});

describe('gen_ai.agent.name only for agent operations', () => {
  for (const op of [Op.INVOKE_AGENT, Op.CREATE_AGENT]) {
    it(`${op} names the agent`, () => {
      withObserve('planner', { op }, () => 'ok');
      expect(getFinishedSpans()[0].attributes['gen_ai.agent.name']).toBe('planner');
    });
  }

  for (const op of [Op.CHAT, Op.RETRIEVAL, Op.EMBEDDINGS, Op.GENERATE_CONTENT, Op.TEXT_COMPLETION]) {
    it(`${op} does not (withObserve and observe)`, () => {
      withObserve('judge', { op }, () => 'ok');
      observe({ name: 'judge2', op }, () => 'ok')();
      for (const span of getFinishedSpans()) {
        expect(span.attributes['gen_ai.operation.name']).toBe(op);
        expect(span.attributes['gen_ai.agent.name']).toBeUndefined();
      }
    });
  }

  it('execute_tool names the tool, not an agent', () => {
    withObserve('lookup', { op: Op.EXECUTE_TOOL }, () => 'ok');
    const attrs = getFinishedSpans()[0].attributes;
    expect(attrs['gen_ai.tool.name']).toBe('lookup');
    expect(attrs['gen_ai.agent.name']).toBeUndefined();
  });

  it('no op sets no GenAI attributes, as in Python', () => {
    withObserve('plain', () => 'ok');
    observe(function plainFn() { return 'ok'; })();
    for (const span of getFinishedSpans()) {
      expect(span.attributes['gen_ai.agent.name']).toBeUndefined();
      expect(span.attributes['gen_ai.operation.name']).toBeUndefined();
    }
  });

  it('keeps an agent name set explicitly on a chat span', () => {
    withObserve('judge', { op: Op.CHAT }, (span) => {
      span.setAttribute('gen_ai.agent.name', 'judge_agent');
    });
    expect(getFinishedSpans()[0].attributes['gen_ai.agent.name']).toBe('judge_agent');
  });
});
