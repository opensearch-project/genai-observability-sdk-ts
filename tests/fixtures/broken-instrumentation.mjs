// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

// Fails at import, as an instrumentation built for @opentelemetry/api 1.10 does on 1.9.
throw new SyntaxError("The requested module '@opentelemetry/api' does not provide an export named 'logs'");
