// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Read-only queries against the user's OpenSearch cluster. The agent's tools
 * call them, and the offline scorers call them again at scoring time to
 * compute the live ground truth.
 */

import { LOG_INDEX, SPAN_INDEX, opensearchClient } from './config.js';

const STATUS_ERROR = 2;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Body = Record<string, any>;

async function search(index: string, body: Body): Promise<Body> {
  const resp = await opensearchClient().search({
    index,
    body,
    ignore_unavailable: true,
    allow_no_indices: true,
  } as any);
  return resp.body as Body;
}

function since(minutes: number): Body {
  return { range: { startTime: { gte: `now-${Math.trunc(minutes)}m` } } };
}

export interface IndexRow {
  index: string;
  docs: number;
  status?: string;
  health?: string;
}

/** Non-system indices with their document counts, largest first. */
export async function listIndices(): Promise<IndexRow[]> {
  const resp = await opensearchClient().cat.indices({ format: 'json', h: 'index,docs.count,status,health' } as any);
  const rows = resp.body as unknown as Array<Record<string, string>>;
  return rows
    .filter((r) => !r.index.startsWith('.'))
    .map((r) => ({ index: r.index, docs: Number(r['docs.count'] ?? 0), status: r.status, health: r.health }))
    .sort((a, b) => b.docs - a.docs || a.index.localeCompare(b.index));
}

/** Service names that sent spans in the window. */
export async function services(minutes: number): Promise<string[]> {
  const body = await search(SPAN_INDEX, {
    size: 0,
    query: since(minutes),
    aggs: { svc: { terms: { field: 'serviceName', size: 100 } } },
  });
  return (body.aggregations?.svc?.buckets ?? []).map((b: Body) => String(b.key));
}

/** Errored spans (status.code = 2) per service in the last `minutes`. */
export async function errorCountsByService(minutes: number): Promise<Record<string, number>> {
  const body = await search(SPAN_INDEX, {
    size: 0,
    query: { bool: { filter: [since(minutes), { term: { 'status.code': STATUS_ERROR } }] } },
    aggs: { svc: { terms: { field: 'serviceName', size: 100 } } },
  });
  const out: Record<string, number> = {};
  for (const b of body.aggregations?.svc?.buckets ?? []) out[String(b.key)] = Number(b.doc_count);
  return out;
}

export async function spanCount(minutes: number): Promise<number> {
  const resp = await opensearchClient().count({ index: SPAN_INDEX, body: { query: since(minutes) } } as any);
  return Number((resp.body as Body).count ?? 0);
}

export interface SlowOperation {
  operation: string;
  count: number;
  avgMs: number;
  maxMs: number;
  services: string[];
}

/** Operations (span names) by average duration, slowest first. */
export async function topSlowOperations(minutes: number, limit = 5): Promise<SlowOperation[]> {
  const body = await search(SPAN_INDEX, {
    size: 0,
    query: since(minutes),
    aggs: {
      op: {
        terms: { field: 'name', size: Math.trunc(limit), order: { avg_ns: 'desc' } },
        aggs: {
          avg_ns: { avg: { field: 'durationInNanos' } },
          max_ns: { max: { field: 'durationInNanos' } },
          svc: { terms: { field: 'serviceName', size: 3 } },
        },
      },
    },
  });
  return (body.aggregations?.op?.buckets ?? []).map((b: Body) => ({
    operation: String(b.key),
    count: Number(b.doc_count),
    avgMs: Math.round((b.avg_ns.value ?? 0) / 1e5) / 10,
    maxMs: Math.round((b.max_ns.value ?? 0) / 1e5) / 10,
    services: (b.svc.buckets ?? []).map((s: Body) => String(s.key)),
  }));
}

export interface TraceSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  service: string;
  start: string;
  durationMs: number;
  error: boolean;
}

/** The spans of one trace, in start order. */
export async function getTrace(traceId: string, maxSpans = 200): Promise<TraceSpan[]> {
  const body = await search(SPAN_INDEX, {
    size: Math.trunc(maxSpans),
    query: { term: { traceId } },
    sort: [{ startTime: 'asc' }],
    _source: ['spanId', 'parentSpanId', 'name', 'serviceName', 'startTime', 'durationInNanos', 'status.code'],
  });
  return (body.hits?.hits ?? []).map((hit: Body) => {
    const s = hit._source;
    return {
      spanId: s.spanId,
      parentSpanId: s.parentSpanId || null,
      name: s.name,
      service: s.serviceName,
      start: s.startTime,
      durationMs: Math.round((s.durationInNanos ?? 0) / 1e5) / 10,
      error: s.status?.code === STATUS_ERROR,
    };
  });
}

/** The most recent root span (any service except `excludeService`). */
export async function latestRootTrace(
  excludeService?: string,
): Promise<{ traceId: string; name: string; serviceName: string } | undefined> {
  const body = await search(SPAN_INDEX, {
    size: 1,
    query: {
      bool: {
        filter: [{ term: { parentSpanId: '' } }],
        must_not: excludeService ? [{ term: { serviceName: excludeService } }] : [],
      },
    },
    sort: [{ startTime: 'desc' }],
    _source: ['traceId', 'name', 'serviceName'],
  });
  return body.hits?.hits?.[0]?._source;
}

export interface LogSearch {
  total: number;
  logs: Array<{ time?: string; severity?: string; service?: string; body: string }>;
}

/** Log records matching `query` (Lucene syntax) in the last `minutes`. */
export async function searchLogs(query: string, minutes: number, limit = 20): Promise<LogSearch> {
  const body = await search(LOG_INDEX, {
    size: Math.trunc(limit),
    track_total_hits: true,
    query: {
      bool: {
        filter: [{ range: { time: { gte: `now-${Math.trunc(minutes)}m` } } }],
        must: [{ query_string: { query: query || '*', default_field: 'body' } }],
      },
    },
    sort: [{ time: 'desc' }],
  });
  const total = body.hits?.total;
  return {
    total: Number(typeof total === 'object' ? total?.value ?? 0 : total ?? 0),
    logs: (body.hits?.hits ?? []).map((hit: Body) => {
      const s = hit._source;
      return {
        time: s.time,
        severity: s.severityText,
        service: s.serviceName ?? s.resource?.attributes?.['service.name'],
        body: String(s.body).slice(0, 500),
      };
    }),
  };
}

export async function indexExists(index: string): Promise<boolean> {
  const resp = await opensearchClient().indices.exists({ index });
  return Boolean(resp.body);
}
