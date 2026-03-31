// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { trace } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

export const DEFAULT_ENDPOINT =
  "http://localhost:21890/opentelemetry/v1/traces";

export interface RegisterOptions {
  endpoint?: string;
  protocol?: "http" | "grpc";
  projectName?: string;
  serviceName?: string;
  serviceVersion?: string;
  batch?: boolean;
  autoInstrument?: boolean;
  exporter?: SpanExporter;
  setGlobal?: boolean;
  headers?: Record<string, string>;
}

const INSTRUMENTOR_PACKAGES = [
  "@opentelemetry/instrumentation-openai",
];

function resolveEndpoint(options: RegisterOptions): string {
  if (options.endpoint) return options.endpoint;

  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (tracesEndpoint) return tracesEndpoint;

  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (baseEndpoint) {
    const base = baseEndpoint.replace(/\/+$/, "");
    return `${base}/v1/traces`;
  }

  return DEFAULT_ENDPOINT;
}

function resolveProtocol(
  options: RegisterOptions,
  endpoint: string,
): "http" | "grpc" {
  if (options.protocol) return options.protocol;

  const tracesProtocol = process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
  if (tracesProtocol === "grpc") return "grpc";
  if (tracesProtocol) return "http";

  const protocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol === "grpc") return "grpc";
  if (protocol) return "http";

  // Infer from URL scheme
  try {
    const url = new URL(endpoint);
    if (url.protocol === "grpc:" || url.protocol === "grpcs:") return "grpc";
  } catch {
    // ignore
  }

  return "http";
}

async function createExporter(
  protocol: "http" | "grpc",
  endpoint: string,
  headers?: Record<string, string>,
): Promise<SpanExporter> {
  if (protocol === "grpc") {
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-grpc"
    );
    return new OTLPTraceExporter({ url: endpoint, headers });
  }
  const { OTLPTraceExporter } = await import(
    "@opentelemetry/exporter-trace-otlp-http"
  );
  return new OTLPTraceExporter({ url: endpoint, headers });
}

function tryAutoInstrument(): void {
  for (const pkg of INSTRUMENTOR_PACKAGES) {
    try {
      const mod = require(pkg);
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
  const endpoint = resolveEndpoint(options);
  const protocol = resolveProtocol(options, endpoint);

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

  const exporter =
    options.exporter ?? (await createExporter(protocol, endpoint, options.headers));

  const processor =
    options.batch === false
      ? new SimpleSpanProcessor(exporter)
      : new BatchSpanProcessor(exporter);
  provider.addSpanProcessor(processor);

  const setGlobal = options.setGlobal ?? true;
  if (setGlobal) {
    provider.register();
  }

  const autoInstrument = options.autoInstrument ?? true;
  if (autoInstrument) {
    tryAutoInstrument();
  }

  return provider;
}
