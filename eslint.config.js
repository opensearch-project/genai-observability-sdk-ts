// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "**/node_modules/**", "**/dist/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "examples/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
