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
   * used as-is for both. A URL ending in `/v1/traces` is still accepted as the
   * traces URL (its base is used for logs), with a deprecation warning.
   */
  endpoint?: string;
  /** Full OTLP traces URL, used as-is. Overrides `endpoint` for traces. */
  tracesEndpoint?: string;
  /** Full OTLP logs URL for evaluation events, used as-is. Overrides `endpoint` for logs. */
  logsEndpoint?: string;
  /**
   * Protocol for every signal. Default per signal:
   * OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL, else OTEL_EXPORTER_OTLP_PROTOCOL,
   * else the URL scheme (`grpc://` / `grpcs://` mean gRPC), else HTTP.
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
  /** Custom span exporter. Replaces the traces endpoint, protocol and sigv4 for traces only. */
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

const LEGACY_TRACES_SUFFIX_RE = /\/v1\/traces\/?$/;

/** The base URL of an `endpoint` option written as a full traces URL (deprecated form). */
function legacyBase(endpoint: string): string | null {
  return LEGACY_TRACES_SUFFIX_RE.test(endpoint) ? endpoint.replace(LEGACY_TRACES_SUFFIX_RE, "") : null;
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
 * Protocol of one signal: `protocol` option, else
 * OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL, else OTEL_EXPORTER_OTLP_PROTOCOL, else
 * the scheme of `url` (`grpc://` / `grpcs://` mean gRPC), else HTTP.
 */
export function resolveSignalProtocol(
  signal: OtlpSignal,
  options: Pick<RegisterOptions, "protocol">,
  url: string,
): OtlpProtocol {
  if (options.protocol) return options.protocol;
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
 * Endpoint and protocol of one signal, following the OTel exporter spec:
 *
 * 1. `tracesEndpoint` / `logsEndpoint` (full URL, used as-is)
 * 2. OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT (full URL, used as-is)
 * 3. Base URL (`endpoint`, else OTEL_EXPORTER_OTLP_ENDPOINT, else
 *    DEFAULT_BASE_ENDPOINT) + `/v1/<signal>` over HTTP, as-is over gRPC
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
  const explicit = own || process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`];
  if (explicit) {
    return { url: httpScheme(explicit), protocol: resolveSignalProtocol(signal, options, explicit) };
  }

  const base =
    (options.endpoint && (legacyBase(options.endpoint) ?? options.endpoint)) ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    DEFAULT_BASE_ENDPOINT;
  const protocol = resolveSignalProtocol(signal, options, base);
  if (protocol === "grpc") return { url: httpScheme(base), protocol };
  return { url: `${httpScheme(base).replace(/\/+$/, "")}/v1/${signal}`, protocol };
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

export async function register(
  options: RegisterOptions = {},
): Promise<BasicTracerProvider> {
  setAgentDefaults(options.agentName, options.agentVersion);
  if (options.endpoint && legacyBase(options.endpoint) !== null) {
    console.warn(
      `[opensearch-genai-observability-sdk-ts] register(): endpoint "${options.endpoint}" is a ` +
        `traces URL. endpoint is now the OTLP base URL for all signals; pass the base ` +
        `("${legacyBase(options.endpoint)}") or tracesEndpoint. This form is removed in a future release.`,
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
