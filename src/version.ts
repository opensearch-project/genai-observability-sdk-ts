// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Instrumentation scope name of every event the SDK emits: getEventLogger()
 * always gets its Logger with this name and SDK_VERSION, whatever the
 * evaluator. The evaluator is recorded as event attributes instead.
 */
export const SDK_SCOPE_NAME = "opensearch-genai-observability-sdk-ts";

/** SDK version. Kept in sync with package.json (asserted by tests/version.test.ts). */
export const SDK_VERSION = "0.1.1";
