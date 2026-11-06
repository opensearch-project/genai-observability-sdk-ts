// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "test.suite.name",
  "test.suite.run.id",
  "test.case.id",
  "test.case.name",
  "test.case.error",
  "test.case.input",
  "test.case.output",
  "test.case.expected",
  "opensearch.test.case.expected",
  "opensearch.test.case.expected_truncated",
  "opensearch.test.suite.run.name",
  "opensearch.test.suite.run.description",
  "error.type",
  "gen_ai.operation.name",
  "cicd.pipeline.name",
  "cicd.pipeline.run.id",
  "cicd.pipeline.run.url.full",
]);

/** Human-readable name of an offline run. */
export const TEST_SUITE_RUN_NAME_KEY = "opensearch.test.suite.run.name";
/** Free-text description of an offline run (truncated to 1024 characters). */
export const TEST_SUITE_RUN_DESCRIPTION_KEY = "opensearch.test.suite.run.description";
/** Maximum length of `opensearch.test.suite.run.description`, in characters. */
export const RUN_DESCRIPTION_LIMIT = 1024;

/**
 * @internal `opensearch.test.suite.run.name` / `.description` of a run (only
 * those given; the description is truncated to 1024 characters). Throws when
 * either is not a string.
 */
export function runAttributes(runName?: string, runDescription?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of [["runName", runName], ["runDescription", runDescription]] as const) {
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`${key} must be a string; got ${typeof value}`);
    }
  }
  if (runName && runName.trim() !== "") out[TEST_SUITE_RUN_NAME_KEY] = runName;
  if (runDescription && runDescription.trim() !== "") {
    out[TEST_SUITE_RUN_DESCRIPTION_KEY] = Array.from(runDescription).slice(0, RUN_DESCRIPTION_LIMIT).join("");
  }
  return out;
}

/** Expected output of an offline test case, on each of its evaluation results. */
export const TEST_CASE_EXPECTED_KEY = "opensearch.test.case.expected";
/** `true` when `opensearch.test.case.expected` was truncated. */
export const TEST_CASE_EXPECTED_TRUNCATED_KEY = "opensearch.test.case.expected_truncated";
/** Maximum length of `opensearch.test.case.expected`, in characters. */
export const EXPECTED_LIMIT = 4096;

/**
 * @internal `opensearch.test.case.expected` (and `_truncated` when cut) for a
 * case's expected output. Strings are kept, other values are JSON.stringify'd.
 * Empty when `expected` is undefined or null.
 */
export function expectedAttributes(expected: unknown): Record<string, string | boolean> {
  if (expected === undefined || expected === null) return {};
  let text: string;
  if (typeof expected === "string") {
    text = expected;
  } else {
    try {
      text = JSON.stringify(expected) ?? String(expected);
    } catch {
      text = String(expected);
    }
  }
  // Count characters (code points), not UTF-16 units.
  const chars = Array.from(text);
  if (chars.length <= EXPECTED_LIMIT) return { [TEST_CASE_EXPECTED_KEY]: text };
  return {
    [TEST_CASE_EXPECTED_KEY]: chars.slice(0, EXPECTED_LIMIT).join(""),
    [TEST_CASE_EXPECTED_TRUNCATED_KEY]: true,
  };
}

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
// Agent identity on evaluation result events
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
