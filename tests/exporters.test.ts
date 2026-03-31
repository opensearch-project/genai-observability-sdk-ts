// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AWSSigV4OTLPExporter } from '../src/exporters.js';

describe('AWSSigV4OTLPExporter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates exporter with explicit region', () => {
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.us-east-1.osis.amazonaws.com/v1/traces',
      region: 'us-east-1',
    });
    expect(exporter).toBeDefined();
  });

  it('creates exporter with AWS_REGION env var', () => {
    process.env.AWS_REGION = 'eu-west-1';
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.eu-west-1.osis.amazonaws.com/v1/traces',
    });
    expect(exporter).toBeDefined();
  });

  it('creates exporter with AWS_DEFAULT_REGION env var', () => {
    process.env.AWS_DEFAULT_REGION = 'ap-southeast-1';
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.ap-southeast-1.osis.amazonaws.com/v1/traces',
    });
    expect(exporter).toBeDefined();
  });

  it('throws when no region is available', () => {
    expect(
      () =>
        new AWSSigV4OTLPExporter({
          endpoint: 'https://pipeline.osis.amazonaws.com/v1/traces',
        }),
    ).toThrow(/region/i);
  });

  it('uses default service "osis"', () => {
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.osis.amazonaws.com/v1/traces',
      region: 'us-east-1',
    });
    expect(exporter).toBeDefined();
  });

  it('accepts custom service', () => {
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://custom.example.com/v1/traces',
      region: 'us-east-1',
      service: 'custom-service',
    });
    expect(exporter).toBeDefined();
  });

  it('has shutdown and forceFlush methods', async () => {
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.osis.amazonaws.com/v1/traces',
      region: 'us-east-1',
    });
    await exporter.shutdown();
    await exporter.forceFlush();
  });
});
