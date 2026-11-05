// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { Resource } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { logs } from "@opentelemetry/api-logs";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
  type LoggerProviderConfig,
} from "@opentelemetry/sdk-logs";
import { AWSSigV4OTLPExporter, AWSSigV4OTLPLogExporter, sendScoresAsDouble } from "./exporters.js";
import { installTestCaseProcessor } from "./testcase.js";
import { setAgentDefaults } from "./internal.js";
import {
  hasGlobalLoggerProvider,
  getSdkLoggerProvider,
  setSdkLoggerProvider,
  TraceOnlyContextProcessor,
} from "./logs.js";

/** Data Prepper OTLP base URL, used when no endpoint is configured. */
export const DEFAULT_BASE_ENDPOINT = "http://localhost:21890/opentelemetry";

/** Default OTLP/HTTP traces URL: DEFAULT_BASE_ENDPOINT + `/v1/traces`. */
export const DEFAULT_ENDPOINT = `${DEFAULT_BASE_ENDPOINT}/v1/traces`;

/** Default OTLP/HTTP logs URL: DEFAULT_BASE_ENDPOINT + `/v1/logs`. */
export const DEFAULT_LOGS_ENDPOINT = `${DEFAULT_BASE_ENDPOINT}/v1/logs`;

export type OtlpProtocol = "http" | "grpc";

/** An OTLP signal the SDK exports: spans, and evaluation events as logs. */
export type OtlpSignal = "traces" | "logs";

/** Sign OTLP/HTTP requests with AWS SigV4 (for example an OSIS pipeline). */
export interface SigV4Options {
  /** AWS service name to sign for. Default `"osis"`. */
  service?: string;
  /** AWS region. Default: AWS_DEFAULT_REGION, else AWS_REGION. */
  region?: string;
}

export interface RegisterOptions {
  /**
   * OTLP base URL for all signals (same meaning as OTEL_EXPORTER_OTLP_ENDPOINT).
   * Over HTTP the SDK appends `/v1/traces` and `/v1/logs`; over gRPC the URL is
   * used as-is for both. Deprecated form, accepted for one release with a
   * warning: a full traces URL, whose path ends in `traces` (for example
   * `http://c:4318/v1/traces` or `https://gw/otlp/traces`). Over HTTP it is then
   * used as-is for traces, and logs go to the same URL with that last segment
   * replaced by `logs`.
   */
  endpoint?: string;
  /**
   * Full OTLP traces URL, used as-is. Overrides `endpoint` and every
   * OTEL_EXPORTER_OTLP_* endpoint env var for traces.
   */
  tracesEndpoint?: string;
  /**
   * Full OTLP logs URL for evaluation events, used as-is. Overrides `endpoint`
   * and every OTEL_EXPORTER_OTLP_* endpoint env var for logs.
   */
  logsEndpoint?: string;
  /**
   * Protocol for every signal. Default per signal: a `grpc://` / `grpcs://`
   * scheme on the URL passed in code, else OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL,
   * else OTEL_EXPORTER_OTLP_PROTOCOL, else the URL scheme, else HTTP.
   */
  protocol?: OtlpProtocol;
  /**
   * Sign both signals with AWS SigV4: register() creates an
   * AWSSigV4OTLPExporter for traces and an AWSSigV4OTLPLogExporter for logs.
   * OTLP/HTTP (JSON) only.
   */
  sigv4?: SigV4Options;
  projectName?: string;
  serviceName?: string;
  serviceVersion?: string;
  batch?: boolean;
  autoInstrument?: boolean;
  /**
   * Custom span exporter. Replaces the traces endpoint, protocol and sigv4 for
   * traces only. With `exporter` and no logs destination (`logExporter`,
   * `logsEndpoint`, `endpoint`, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT or
   * OTEL_EXPORTER_OTLP_ENDPOINT), register() does not set up the logs pipeline
   * and warns once: evaluation events then go to the global LoggerProvider
   * (a no-op unless you registered one).
   */
  exporter?: SpanExporter;
  setGlobal?: boolean;
  /**
   * Headers sent with every export (traces and logs). Over gRPC they are sent
   * as gRPC metadata, with lowercased keys (gRPC rejects uppercase keys).
   */
  headers?: Record<string, string>;
  /**
   * Set up a LoggerProvider for `gen_ai.evaluation.result` events emitted by
   * score(). Default true. Skipped when a global LoggerProvider is already
   * registered (it is never replaced; score() then uses it).
   */
  logs?: boolean;
  /** Custom log exporter. Replaces the logs endpoint, protocol and sigv4 for logs only. */
  logExporter?: LogRecordExporter;
  /**
   * Name of the agent this process evaluates. Stamped as `gen_ai.agent.name` on
   * every evaluation result event the SDK emits, unless a
   * call names its own agent or the evaluated span carries one.
   */
  agentName?: string;
  /** Version of that agent (`gen_ai.agent.version`), stamped the same way. */
  agentVersion?: string;
}

const INSTRUMENTOR_PACKAGES = [
  "@opentelemetry/instrumentation-openai",
];

/** Traces and logs URLs of an `endpoint` option written as a full traces URL (deprecated form). */
interface LegacyTracesEndpoint {
  traces: string;
  logs: string;
  /** The base URL, when the path ends in `/v1/traces`. */
  base?: string;
}

/**
 * Parse the deprecated form of `endpoint`: a full traces URL, whose path's last
 * segment is `traces`. Null for a base URL.
 */
function legacyTracesEndpoint(endpoint: string): LegacyTracesEndpoint | null {
  const traces = endpoint.trim();
  let url: URL;
  try {
    url = new URL(traces);
  } catch {
    return null;
  }
  const segments = url.pathname.replace(/\/+$/, "").split("/");
  if (segments[segments.length - 1] !== "traces") return null;
  const parent = segments.slice(0, -1);
  url.pathname = [...parent, "logs"].join("/");
  const logsUrl = url.toString();
  let base: string | undefined;
  if (parent[parent.length - 1] === "v1") {
    url.pathname = parent.slice(0, -1).join("/");
    base = url.toString().replace(/\/+$/, "");
  }
  return { traces, logs: logsUrl, base };
}

function parseProtocol(value: string | undefined, source: string): OtlpProtocol | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "grpc") return "grpc";
  if (v === "http" || v === "http/protobuf" || v === "http/json") return "http";
  console.warn(
    `[opensearch-genai-observability-sdk-ts] register(): ignoring ${source}="${value}" ` +
      `(expected grpc, http/protobuf or http/json)`,
  );
  return undefined;
}

function schemeProtocol(url: string): OtlpProtocol {
  return /^grpcs?:\/\//i.test(url.trim()) ? "grpc" : "http";
}

/**
 * Protocol of one signal. Code options win over env vars:
 *
 * 1. `protocol` option
 * 2. a `grpc://` / `grpcs://` scheme on `url`, when `url` came from code
 *    (`fromCode`)
 * 3. OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL, then OTEL_EXPORTER_OTLP_PROTOCOL
 * 4. the scheme of `url` (`grpc://` / `grpcs://` mean gRPC), else HTTP
 *
 * An http:// or https:// scheme does not select HTTP over the env vars: the
 * OTel JS gRPC exporters take http(s):// URLs too.
 */
export function resolveSignalProtocol(
  signal: OtlpSignal,
  options: Pick<RegisterOptions, "protocol">,
  url: string,
  fromCode = false,
): OtlpProtocol {
  if (options.protocol) return options.protocol;
  if (fromCode && schemeProtocol(url) === "grpc") return "grpc";
  const signalEnv = `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_PROTOCOL`;
  return (
    parseProtocol(process.env[signalEnv], signalEnv) ??
    parseProtocol(process.env.OTEL_EXPORTER_OTLP_PROTOCOL, "OTEL_EXPORTER_OTLP_PROTOCOL") ??
    schemeProtocol(url)
  );
}

/** Endpoint and protocol of one signal. */
export interface SignalEndpoint {
  url: string;
  protocol: OtlpProtocol;
}

/**
 * Endpoint and protocol of one signal (traces or logs). Code options always
 * win over env vars, as in the OTel SDK exporters:
 *
 * 1. `tracesEndpoint` / `logsEndpoint` (full URL, used as-is)
 * 2. `endpoint` (base URL) + `/v1/<signal>` over HTTP, as-is over gRPC. The
 *    deprecated traces URL form of `endpoint` takes this place too.
 * 3. OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT (full URL, used as-is)
 * 4. OTEL_EXPORTER_OTLP_ENDPOINT (base URL, same rule as `endpoint`)
 * 5. DEFAULT_BASE_ENDPOINT (base URL, same rule)
 *
 * The protocol comes from resolveSignalProtocol() on the chosen URL. The
 * returned URL has an http:// or https:// scheme (`grpc://` and `grpcs://`
 * only select the protocol).
 */
export function resolveSignalEndpoint(
  signal: OtlpSignal,
  options: Pick<RegisterOptions, "endpoint" | "tracesEndpoint" | "logsEndpoint" | "protocol">,
): SignalEndpoint {
  const own = signal === "traces" ? options.tracesEndpoint : options.logsEndpoint;
  if (own) return fullUrl(signal, options, own, true);

  if (options.endpoint) {
    const protocol = resolveSignalProtocol(signal, options, options.endpoint, true);
    // Deprecated: `endpoint` written as a full traces URL (see RegisterOptions.endpoint).
    const legacy = protocol === "http" ? legacyTracesEndpoint(options.endpoint) : null;
    if (legacy) return { url: httpScheme(signal === "traces" ? legacy.traces : legacy.logs), protocol };
    return baseUrl(signal, options.endpoint, protocol);
  }

  const envFull = process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`];
  if (envFull) return fullUrl(signal, options, envFull, false);

  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_BASE_ENDPOINT;
  return baseUrl(signal, base, resolveSignalProtocol(signal, options, base));
}

/** A full signal URL, used as-is. */
function fullUrl(
  signal: OtlpSignal,
  options: Pick<RegisterOptions, "protocol">,
  url: string,
  fromCode: boolean,
): SignalEndpoint {
  return { url: httpScheme(url), protocol: resolveSignalProtocol(signal, options, url, fromCode) };
}

/** A base URL: `/v1/<signal>` appended over HTTP, as-is over gRPC. */
function baseUrl(signal: OtlpSignal, base: string, protocol: OtlpProtocol): SignalEndpoint {
  if (protocol === "grpc") return { url: httpScheme(base), protocol };
  return { url: `${httpScheme(base).replace(/\/+$/, "")}/v1/${signal}`, protocol };
}

/**
 * True when a logs destination is configured, that is when
 * resolveSignalEndpoint("logs") would not fall back to the Data Prepper
 * default: `logsEndpoint`, `endpoint`, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT or
 * OTEL_EXPORTER_OTLP_ENDPOINT (same order).
 */
function hasLogsDestination(options: RegisterOptions): boolean {
  return Boolean(
    options.logsEndpoint ||
      options.endpoint ||
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  );
}

let warnedNoLogsDestination = false;

function warnNoLogsDestinationOnce(): void {
  if (warnedNoLogsDestination) return;
  warnedNoLogsDestination = true;
  console.warn(
    "[opensearch-genai-observability-sdk-ts] register(): a custom exporter was passed and no " +
      "logs destination is configured, so the SDK does not set up a logs pipeline and " +
      "evaluation events go to the global LoggerProvider (a no-op unless you registered one). " +
      "To export them, pass logsEndpoint or logExporter (or endpoint, or set " +
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).",
  );
}

/** Test hook: let the next register() warn again about a missing logs destination. */
export function resetRegisterWarnings(): void {
  warnedNoLogsDestination = false;
}

/**
 * The OTel JS exporters take http(s):// URLs (gRPC included): map grpc:// to
 * http:// and grpcs:// to https:// once the protocol is known.
 */
function httpScheme(url: string): string {
  return url.trim().replace(/^grpc:\/\//i, "http://").replace(/^grpcs:\/\//i, "https://");
}

/**
 * gRPC metadata from `headers`. Keys are lowercased: gRPC rejects uppercase
 * metadata keys. Undefined when there are no headers.
 */
export async function grpcMetadata(
  headers: Record<string, string> | undefined,
): Promise<import("@grpc/grpc-js").Metadata | undefined> {
  const entries = Object.entries(headers ?? {});
  if (entries.length === 0) return undefined;
  const { Metadata } = await import("@grpc/grpc-js");
  const metadata = new Metadata();
  for (const [key, value] of entries) metadata.set(key.toLowerCase(), value);
  return metadata;
}

function requireHttpForSigV4(signal: OtlpSignal, endpoint: SignalEndpoint): void {
  if (endpoint.protocol === "grpc") {
    throw new Error(
      `register(): sigv4 signs OTLP/HTTP requests, but ${signal} resolved to gRPC ` +
        `(${endpoint.url}). Use an https:// endpoint or protocol: "http".`,
    );
  }
}

/** The span exporter register() uses: `exporter`, else one built from the traces endpoint. */
export async function createSpanExporter(options: RegisterOptions): Promise<SpanExporter> {
  if (options.exporter) return options.exporter;
  const endpoint = resolveSignalEndpoint("traces", options);
  if (options.sigv4) {
    requireHttpForSigV4("traces", endpoint);
    return new AWSSigV4OTLPExporter({ endpoint: endpoint.url, ...options.sigv4 });
  }
  if (endpoint.protocol === "grpc") {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
    return new OTLPTraceExporter({ url: endpoint.url, metadata: await grpcMetadata(options.headers) });
  }
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  return new OTLPTraceExporter({ url: endpoint.url, headers: options.headers });
}

/**
 * The log exporter for evaluation events: `logExporter`, else one built from
 * the logs endpoint (resolved like traces, so it always has an endpoint).
 * register() does not call it when `exporter` is set and no logs destination
 * is configured.
 */
export async function createLogExporter(options: RegisterOptions): Promise<LogRecordExporter> {
  if (options.logExporter) return options.logExporter;
  const endpoint = resolveSignalEndpoint("logs", options);
  if (options.sigv4) {
    requireHttpForSigV4("logs", endpoint);
    return new AWSSigV4OTLPLogExporter({ endpoint: endpoint.url, ...options.sigv4 });
  }
  if (endpoint.protocol === "grpc") {
    const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-grpc");
    return new OTLPLogExporter({ url: endpoint.url, metadata: await grpcMetadata(options.headers) });
  }
  const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-http");
  const exporter = new OTLPLogExporter({ url: endpoint.url, headers: options.headers });
  sendScoresAsDouble(exporter);
  return exporter;
}

type LogsResource = NonNullable<LoggerProviderConfig["resource"]>;

/**
 * Minimal Resource for the logs SDK. The logs SDK is on the OTel JS 2.x line
 * while traces use @opentelemetry/resources 1.x, so a 1.x Resource cannot be
 * passed directly. Same attributes as the trace resource.
 */
function logsResource(attributes: Record<string, string>): LogsResource {
  const resource: LogsResource = {
    attributes,
    getRawAttributes: () => Object.entries(attributes),
    merge: (other) =>
      other ? logsResource({ ...attributes, ...(other.attributes as Record<string, string>) }) : resource,
  };
  return resource;
}

async function setupLogs(
  options: RegisterOptions,
  resourceAttrs: Record<string, string>,
  setGlobal: boolean,
): Promise<LoggerProvider | null> {
  if (options.logs === false) return null;
  const previous = getSdkLoggerProvider();
  const globalIsOurs = previous !== undefined && logs.getLoggerProvider() === previous;
  if (setGlobal && hasGlobalLoggerProvider() && !globalIsOurs) {
    // Respect a user-configured global LoggerProvider; score() emits through it.
    return null;
  }

  if (options.exporter && !options.logExporter && !hasLogsDestination(options)) {
    // Do not export evaluation events to the default localhost URL behind a
    // custom span exporter. Drop a provider left over from a previous register().
    warnNoLogsDestinationOnce();
    if (previous instanceof LoggerProvider) {
      await previous.shutdown().catch(() => {});
    }
    if (globalIsOurs) logs.disable();
    setSdkLoggerProvider(undefined);
    return null;
  }

  const exporter = await createLogExporter(options);
  const processor =
    options.batch === false
      ? new SimpleLogRecordProcessor({ exporter })
      : new BatchLogRecordProcessor({ exporter });
  const loggerProvider = new LoggerProvider({
    resource: logsResource(resourceAttrs),
    // TraceOnlyContextProcessor first: trace-level events carry their trace id.
    processors: [new TraceOnlyContextProcessor(), processor],
  });

  // Replace a provider left over from a previous register() call.
  if (previous instanceof LoggerProvider) {
    await previous.shutdown().catch(() => {});
  }
  if (globalIsOurs) logs.disable();
  setSdkLoggerProvider(loggerProvider);
  if (setGlobal) {
    logs.setGlobalLoggerProvider(loggerProvider);
  }
  return loggerProvider;
}

/** Make provider.forceFlush()/shutdown() also flush/shut down the logs pipeline. */
function chainLoggerProvider(
  provider: BasicTracerProvider,
  loggerProvider: LoggerProvider,
): void {
  const flushTraces = provider.forceFlush.bind(provider);
  const shutdownTraces = provider.shutdown.bind(provider);

  provider.forceFlush = async () => {
    await Promise.all([flushTraces(), loggerProvider.forceFlush()]);
  };
  provider.shutdown = async () => {
    try {
      await Promise.all([shutdownTraces(), loggerProvider.shutdown()]);
    } finally {
      if (getSdkLoggerProvider() === loggerProvider) setSdkLoggerProvider(undefined);
      if (logs.getLoggerProvider() === loggerProvider) logs.disable();
    }
  };
}

async function tryAutoInstrument(): Promise<void> {
  for (const pkg of INSTRUMENTOR_PACKAGES) {
    try {
      const mod = await import(pkg);
      if (typeof mod?.register === "function") {
        mod.register();
      } else if (typeof mod?.default?.register === "function") {
        mod.default.register();
      }
    } catch {
      // Package not installed, skip
    }
  }
}

/**
 * Set up the OTel traces pipeline and the logs pipeline that carries
 * evaluation events (`gen_ai.evaluation.result`).
 *
 * Endpoint resolution, per signal (traces and logs). Code options always win
 * over env vars, as in the OTel SDK exporters:
 *
 * 1. `tracesEndpoint` / `logsEndpoint`: full URL, used as-is
 * 2. `endpoint`: base URL, `/v1/<signal>` appended over HTTP, as-is over gRPC
 *    (the deprecated traces URL form of `endpoint` takes this place)
 * 3. OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:
 *    full URL, used as-is
 * 4. OTEL_EXPORTER_OTLP_ENDPOINT: base URL, same rule as `endpoint`
 * 5. the Data Prepper base DEFAULT_BASE_ENDPOINT, same rule
 *
 * Protocol, per signal: `protocol`, else a `grpc://` / `grpcs://` scheme on a
 * URL passed in code, else OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL, else
 * OTEL_EXPORTER_OTLP_PROTOCOL, else the URL scheme, else HTTP.
 *
 * @example
 * // OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://env-logs:4318/v1/logs is set.
 * await register({ endpoint: "http://collector:4318" });
 * // traces -> http://collector:4318/v1/traces
 * // logs   -> http://collector:4318/v1/logs (endpoint beats the env var)
 */
export async function register(
  options: RegisterOptions = {},
): Promise<BasicTracerProvider> {
  setAgentDefaults(options.agentName, options.agentVersion);
  const legacy = options.endpoint ? legacyTracesEndpoint(options.endpoint) : null;
  if (legacy) {
    const fix = legacy.base
      ? `pass the base ("${legacy.base}"), or tracesEndpoint and logsEndpoint`
      : `pass tracesEndpoint ("${legacy.traces}") and logsEndpoint`;
    console.warn(
      `[opensearch-genai-observability-sdk-ts] register(): endpoint "${options.endpoint}" is a ` +
        `traces URL. endpoint is now the OTLP base URL for all signals. For this release it is ` +
        `still used as the traces URL over HTTP, with logs sent to "${legacy.logs}"; ${fix}. ` +
        `This form is removed in a future release.`,
    );
  }

  const serviceName =
    options.serviceName ?? options.projectName ?? "unknown_service";
  const resourceAttrs: Record<string, string> = {
    "service.name": serviceName,
  };
  if (options.serviceVersion) {
    resourceAttrs["service.version"] = options.serviceVersion;
  }

  const resource = new Resource(resourceAttrs);
  const provider = new BasicTracerProvider({ resource });

  const exporter = await createSpanExporter(options);

  const processor =
    options.batch === false
      ? new SimpleSpanProcessor(exporter)
      : new BatchSpanProcessor(exporter);
  // Stamps test.* ids on agent root spans while evaluate() runs a test case.
  installTestCaseProcessor(provider);
  provider.addSpanProcessor(processor);

  const setGlobal = options.setGlobal ?? true;
  if (setGlobal) {
    provider.register();
  }

  const loggerProvider = await setupLogs(
    options,
    resourceAttrs,
    setGlobal,
  );
  if (loggerProvider) {
    chainLoggerProvider(provider, loggerProvider);
  }

  const autoInstrument = options.autoInstrument ?? true;
  if (autoInstrument) {
    tryAutoInstrument().catch(() => {});
  }

  return provider;
}
