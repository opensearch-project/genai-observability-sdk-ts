// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

/** Inline ExportResultCode to avoid depending on @opentelemetry/core directly. */
const ExportResultCode = { SUCCESS: 0, FAILED: 1 } as const;
type ExportResult =
  | { code: typeof ExportResultCode.SUCCESS }
  | { code: typeof ExportResultCode.FAILED; error?: Error };

/**
 * An OTLP trace exporter that signs HTTP requests with AWS SigV4.
 * Uses JSON serialization and sends traces to an AWS endpoint (e.g., OSIS pipeline).
 */
export class AWSSigV4OTLPExporter implements SpanExporter {
  private _endpoint: string;
  private _service: string;
  private _region: string;

  constructor(options: {
    endpoint: string;
    service?: string;
    region?: string;
  }) {
    this._endpoint = options.endpoint;
    this._service = options.service ?? 'osis';
    this._region =
      options.region ??
      process.env.AWS_DEFAULT_REGION ??
      process.env.AWS_REGION ??
      '';

    if (!this._region) {
      throw new Error(
        "No AWS region found. Set via 'region' parameter, " +
          'AWS_DEFAULT_REGION, or AWS_REGION environment variable.',
      );
    }
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this._export(spans).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error: unknown) =>
        resultCallback({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
    );
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}

  private async _export(spans: ReadableSpan[]): Promise<void> {
    // @opentelemetry/otlp-transformer is a transitive dep of
    // @opentelemetry/exporter-trace-otlp-http, available at runtime.
    // @ts-expect-error — not in direct deps but guaranteed present
    const transformer: { JsonTraceSerializer: { serializeRequest(spans: ReadableSpan[]): Uint8Array | undefined } } = await import('@opentelemetry/otlp-transformer');
    const serialized = transformer.JsonTraceSerializer.serializeRequest(spans);
    if (!serialized) {
      throw new Error('Failed to serialize spans');
    }
    const body = Buffer.from(serialized);

    const url = new URL(this._endpoint);

    const { fromNodeProviderChain } = await import(
      '@aws-sdk/credential-providers'
    );
    const credentials = await fromNodeProviderChain()();

    const aws4 = await import('aws4');
    const signed = aws4.sign(
      {
        service: this._service,
        region: this._region,
        method: 'POST',
        path: url.pathname + url.search,
        host: url.host,
        headers: {
          'Content-Type': 'application/json',
          Host: url.host,
        },
        body,
      },
      {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    );

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: signed.headers as Record<string, string>,
      body,
    });

    if (!response.ok) {
      throw new Error(
        `Export failed: ${response.status} ${response.statusText}`,
      );
    }
  }
}
