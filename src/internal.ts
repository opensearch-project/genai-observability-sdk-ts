// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "test.suite.name",
  "test.suite.run.id",
  "test.suite.run.status",
  "test.case.id",
  "test.case.name",
  "test.case.result.status",
  "test.case.error",
  "test.case.input",
  "test.case.output",
  "test.case.expected",
  "opensearch.test_case.input",
  "opensearch.test_case.output",
  "opensearch.test_case.expected",
  "opensearch.test_case.error",
  "opensearch.test_case.duration_ms",
  "opensearch.test_suite_run.case_count",
  "opensearch.test_suite_run.pass_count",
  "opensearch.test_suite_run.fail_count",
  "opensearch.test_suite_run.error_count",
  "opensearch.test_suite_run.duration_ms",
  "error.type",
  "gen_ai.operation.name",
  "cicd.pipeline.name",
  "cicd.pipeline.run.id",
  "cicd.pipeline.run.url.full",
]);

export function parseHex(value: string): number | null {
  if (value === "") return 0;
  const stripped = value.replace(/^0[xX]/, "");
  const parsed = parseInt(stripped, 16);
  return Number.isNaN(parsed) ? null : parsed;
}

export function validateMetadataKeys(
  metadata: Record<string, unknown>,
  context?: string,
): void {
  for (const key of Object.keys(metadata)) {
    if (RESERVED_KEYS.has(key)) {
      const prefix = context ? `[${context}] ` : "";
      console.warn(
        `${prefix}Key "${key}" is reserved and may be overwritten by the SDK.`,
      );
    }
  }
}

/** Normalize a hex trace id (optional 0x prefix, left-padded). Returns null if invalid. */
export function normalizeTraceId(value: string): string | null {
  const clean = value.replace(/^0[xX]/, "").padStart(32, "0").toLowerCase();
  return /^[0-9a-f]{32}$/.test(clean) && !/^0+$/.test(clean) ? clean : null;
}

/** Normalize a hex span id (optional 0x prefix, left-padded). Returns null if invalid. */
export function normalizeSpanId(value: string): string | null {
  const clean = value.replace(/^0[xX]/, "").padStart(16, "0").toLowerCase();
  return /^[0-9a-f]{16}$/.test(clean) && !/^0+$/.test(clean) ? clean : null;
}

// ---------------------------------------------------------------------------
// Agent identity on evaluation, test case and test suite run events
// ---------------------------------------------------------------------------

export const AGENT_NAME_KEY = "gen_ai.agent.name";
/** Our extension until OTel defines an agent version attribute. */
export const AGENT_VERSION_KEY = "gen_ai.agent.version";

let agentDefaultName: string | undefined;
let agentDefaultVersion: string | undefined;

/** @internal Process-wide agent identity, set by `register({ agentName, agentVersion })`. */
export function setAgentDefaults(name?: string, version?: string): void {
  agentDefaultName = name || undefined;
  agentDefaultVersion = version || undefined;
}

/** @internal The process-wide `[agent name, agent version]`. */
export function agentDefaults(): [string | undefined, string | undefined] {
  return [agentDefaultName, agentDefaultVersion];
}

/**
 * @internal `[gen_ai.agent.name, gen_ai.agent.version]` read from an SDK span (best
 * effort: only spans that expose their attributes are read).
 */
export function spanAgent(span: unknown): [string | undefined, string | undefined] {
  const attrs = (span as { attributes?: Record<string, unknown> } | undefined)?.attributes;
  if (!attrs) return [undefined, undefined];
  const name = attrs[AGENT_NAME_KEY];
  const version = attrs[AGENT_VERSION_KEY];
  return [name ? String(name) : undefined, version ? String(version) : undefined];
}

/**
 * @internal Agent identity attributes for an SDK event (only the keys known).
 * Per field: the explicit argument, then the evaluated span's own attribute
 * (the agent that actually ran), then the register() default. Never invented.
 */
export function resolveAgent(
  name?: string,
  version?: string,
  span?: unknown,
): Record<string, string> {
  const [spanName, spanVersion] = span ? spanAgent(span) : [undefined, undefined];
  const resolvedName = name || spanName || agentDefaultName;
  const resolvedVersion = version || spanVersion || agentDefaultVersion;
  const out: Record<string, string> = {};
  if (resolvedName) out[AGENT_NAME_KEY] = resolvedName;
  if (resolvedVersion) out[AGENT_VERSION_KEY] = resolvedVersion;
  return out;
}
