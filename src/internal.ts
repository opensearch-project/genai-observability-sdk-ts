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
  "gen_ai.operation.name",
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
