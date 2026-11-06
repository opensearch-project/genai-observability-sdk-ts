// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Shared configuration: the OpenSearch client and the Strands model, from env vars.
 *
 * OpenSearch (the cluster the agent answers questions about, and where the
 * traces and evaluation results land):
 *
 *   OPENSEARCH_URL          default https://localhost:9200
 *   OPENSEARCH_USERNAME     basic auth user (default admin when a password is set)
 *   OPENSEARCH_PASSWORD     basic auth password
 *   OPENSEARCH_VERIFY_CERTS default false for https://localhost, else true
 *   AWS_REGION              region for Bedrock (default us-west-2)
 *
 * Model (Strands model providers):
 *
 *   MODEL_PROVIDER   bedrock (default), openai or anthropic
 *   MODEL_ID         model id; defaults per provider below
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY for the API providers
 *   JUDGE_MODEL_ID   model id of the LLM judge (default: MODEL_ID)
 */

import { Client } from '@opensearch-project/opensearch';
import type { Model, BaseModelConfig } from '@strands-agents/sdk';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';

export const AGENT_NAME = 'observability_assistant';
export const AGENT_VERSION = process.env.AGENT_VERSION ?? '1.0.0';
export const SERVICE_NAME = 'observability-assistant';

export const SPAN_INDEX = process.env.SPAN_INDEX ?? 'otel-v1-apm-span*';
export const LOG_INDEX = process.env.LOG_INDEX ?? 'logs-otel-v1*';
export const EVALUATION_INDEX = process.env.EVALUATION_INDEX ?? 'otel-v1-genai-evaluation*';

export type Provider = 'bedrock' | 'openai' | 'anthropic';

export const DEFAULT_MODEL_IDS: Record<Provider, string> = {
  // A cross-region inference profile; list yours with
  // aws bedrock list-inference-profiles --region us-west-2
  bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-haiku-4-5',
};

export function region(): string {
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2';
}

export function opensearchUrl(): string {
  return process.env.OPENSEARCH_URL ?? 'https://localhost:9200';
}

export function verifyCerts(): boolean {
  const raw = process.env.OPENSEARCH_VERIFY_CERTS;
  if (raw !== undefined) return ['1', 'true', 'yes'].includes(raw.toLowerCase());
  const host = new URL(opensearchUrl()).hostname;
  return !['localhost', '127.0.0.1'].includes(host);
}

/** Basic auth from env, or undefined. */
export function opensearchAuth(): { username: string; password: string } | undefined {
  const password = process.env.OPENSEARCH_PASSWORD;
  if (!password) return undefined;
  return { username: process.env.OPENSEARCH_USERNAME ?? 'admin', password };
}

let client: Client | undefined;

/** An @opensearch-project/opensearch client for the user's cluster. */
export function opensearchClient(): Client {
  if (!client) {
    const auth = opensearchAuth();
    client = new Client({
      node: opensearchUrl(),
      ...(auth ? { auth } : {}),
      // Local stack with a self-signed certificate.
      ssl: { rejectUnauthorized: verifyCerts() },
      requestTimeout: 30_000,
    });
  }
  return client;
}

export function provider(): Provider {
  const p = (process.env.MODEL_PROVIDER ?? 'bedrock').toLowerCase();
  if (p !== 'bedrock' && p !== 'openai' && p !== 'anthropic') {
    throw new Error(`MODEL_PROVIDER must be bedrock, openai or anthropic; got "${p}"`);
  }
  return p;
}

export function modelId(): string {
  return process.env.MODEL_ID || DEFAULT_MODEL_IDS[provider()];
}

export function judgeModelId(): string {
  return process.env.JUDGE_MODEL_ID || modelId();
}

/** `gen_ai.provider.name` of the model provider. */
export function providerName(): string {
  return provider() === 'bedrock' ? 'aws.bedrock' : provider();
}

/** A Strands model for MODEL_PROVIDER (bedrock, openai or anthropic). */
export async function makeModel(
  model?: string,
  { maxTokens = 1024 }: { maxTokens?: number } = {},
): Promise<Model<BaseModelConfig>> {
  const name = model ?? modelId();
  switch (provider()) {
    case 'bedrock':
      return new BedrockModel({ modelId: name, region: region(), maxTokens });
    case 'openai': {
      // npm install openai
      const { OpenAIModel } = await import('@strands-agents/sdk/models/openai');
      return new OpenAIModel({ api: 'chat', modelId: name, apiKey: requireEnv('OPENAI_API_KEY'), params: { max_tokens: maxTokens } });
    }
    case 'anthropic': {
      // npm install @anthropic-ai/sdk
      const { AnthropicModel } = await import('@strands-agents/sdk/models/anthropic');
      return new AnthropicModel({ modelId: name, apiKey: requireEnv('ANTHROPIC_API_KEY'), maxTokens });
    }
  }
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required for MODEL_PROVIDER=${provider()}`);
  return value;
}
