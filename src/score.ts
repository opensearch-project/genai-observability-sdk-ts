// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import {
  trace,
  context as otelContext,
  TraceFlags,
  type SpanContext,
  type Context,
  type Attributes,
} from '@opentelemetry/api';

const TRACER_NAME = "opensearch-genai-observability-sdk-ts-scores";

export interface ScoreOptions {
  name: string;
  value?: number;
  traceId?: string;
  spanId?: string;
  label?: string;
  explanation?: string;
  responseId?: string;
  attributes?: Record<string, unknown>;
}

export function score(options: ScoreOptions): void {
  const tracer = trace.getTracer(TRACER_NAME);

  // Build span attributes
  const spanAttrs: Attributes = {
    "gen_ai.operation.name": "evaluation",
    "gen_ai.evaluation.name": options.name,
  };
  if (options.value !== undefined) spanAttrs["gen_ai.evaluation.score.value"] = options.value;
  if (options.label) spanAttrs["gen_ai.evaluation.score.label"] = options.label;
  if (options.explanation) spanAttrs["gen_ai.evaluation.explanation"] = options.explanation.slice(0, 500);
  if (options.responseId) spanAttrs["gen_ai.response.id"] = options.responseId;
  if (options.attributes) {
    for (const [k, v] of Object.entries(options.attributes)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        spanAttrs[k] = v;
      }
    }
  }

  // Build event attributes (gen_ai.evaluation.result event)
  const eventAttrs: Attributes = { "gen_ai.evaluation.name": options.name };
  if (options.value !== undefined) eventAttrs["gen_ai.evaluation.score.value"] = options.value;
  if (options.label) eventAttrs["gen_ai.evaluation.score.label"] = options.label;
  if (options.explanation) eventAttrs["gen_ai.evaluation.explanation"] = options.explanation.slice(0, 500);
  if (options.responseId) eventAttrs["gen_ai.response.id"] = options.responseId;

  // Build parent context
  const ctx = buildParentContext(options.traceId, options.spanId);

  const span = tracer.startSpan(
    `evaluation ${options.name}`,
    { attributes: spanAttrs },
    ctx ?? undefined,
  );
  span.addEvent("gen_ai.evaluation.result", eventAttrs);
  span.end();
}

function buildParentContext(traceId?: string, spanId?: string): Context | null {
  if (!traceId) return null;

  // Validate traceId is valid hex
  const cleanTraceId = traceId.replace(/^0[xX]/, '').padStart(32, '0').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(cleanTraceId)) return null;

  let cleanSpanId: string;
  if (spanId) {
    cleanSpanId = spanId.replace(/^0[xX]/, '').padStart(16, '0').toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(cleanSpanId)) return null;
  } else {
    // Trace-level scoring: derive root span_id from lower 64 bits of trace_id
    cleanSpanId = cleanTraceId.slice(16);
  }

  const parentSpanContext: SpanContext = {
    traceId: cleanTraceId,
    spanId: cleanSpanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };

  return trace.setSpan(
    otelContext.active(),
    trace.wrapSpanContext(parentSpanContext),
  );
}
