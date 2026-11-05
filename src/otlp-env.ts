// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * OTLP exporter settings read from the OTel env vars, shared by register()
 * and the SigV4 exporters. Values passed in code always win over env vars.
 */

/** An OTLP signal the SDK exports: spans, and evaluation events as logs. */
export type OtlpSignal = "traces" | "logs";

/** OTLP request compression. OSIS accepts only these two. */
export type OtlpCompression = "none" | "gzip";

/** Default per-request export timeout, as in the OTel exporter spec. */
export const DEFAULT_TIMEOUT_MILLIS = 10_000;

const PREFIX = "[opensearch-genai-observability-sdk-ts]";

/** OTEL_EXPORTER_OTLP_<SIGNAL>_<NAME>, then OTEL_EXPORTER_OTLP_<NAME>, with the name that was set. */
function envValue(signal: OtlpSignal, name: string): [string, string] | undefined {
  for (const key of [`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_${name}`, `OTEL_EXPORTER_OTLP_${name}`]) {
    const value = process.env[key]?.trim();
    if (value) return [key, value];
  }
  return undefined;
}

function parseCompression(value: string): OtlpCompression | undefined {
  const v = value.trim().toLowerCase();
  return v === "gzip" || v === "none" ? v : undefined;
}

/**
 * Compression of one signal: `compression` option, else
 * OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION, else OTEL_EXPORTER_OTLP_COMPRESSION,
 * else `"none"`. An invalid option throws; an invalid env value warns and is
 * ignored.
 */
export function resolveCompression(signal: OtlpSignal, compression?: string): OtlpCompression {
  if (compression !== undefined) {
    const parsed = parseCompression(compression);
    if (!parsed) throw new Error(`compression must be "none" or "gzip"; got "${compression}"`);
    return parsed;
  }
  const env = envValue(signal, "COMPRESSION");
  if (!env) return "none";
  const parsed = parseCompression(env[1]);
  if (parsed) return parsed;
  console.warn(`${PREFIX} ignoring ${env[0]}="${env[1]}" (expected none or gzip)`);
  return "none";
}

/**
 * Per-request export timeout of one signal: `timeoutMillis` option, else
 * OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT, else OTEL_EXPORTER_OTLP_TIMEOUT (both
 * in milliseconds), else 10000. An invalid option throws; an invalid env value
 * warns and is ignored.
 */
export function resolveTimeoutMillis(signal: OtlpSignal, timeoutMillis?: number): number {
  if (timeoutMillis !== undefined) {
    if (!Number.isFinite(timeoutMillis) || timeoutMillis <= 0) {
      throw new Error(`timeoutMillis must be a positive number; got ${timeoutMillis}`);
    }
    return timeoutMillis;
  }
  const env = envValue(signal, "TIMEOUT");
  if (!env) return DEFAULT_TIMEOUT_MILLIS;
  const parsed = Number(env[1]);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`${PREFIX} ignoring ${env[0]}="${env[1]}" (expected a positive number of milliseconds)`);
  return DEFAULT_TIMEOUT_MILLIS;
}

/** Parse an OTel headers env value: `key1=value1,key2=value2`, values URL-encoded. */
function parseHeaders(value: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of (value ?? "").split(",")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    const raw = entry.slice(eq + 1).trim();
    if (!key) continue;
    try {
      headers[key] = decodeURIComponent(raw);
    } catch {
      headers[key] = raw;
    }
  }
  return headers;
}

/**
 * Headers of one signal: OTEL_EXPORTER_OTLP_HEADERS, overridden by
 * OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS, overridden by `headers` from code.
 */
export function resolveHeaders(signal: OtlpSignal, headers?: Record<string, string>): Record<string, string> {
  return {
    ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseHeaders(process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`]),
    ...(headers ?? {}),
  };
}
