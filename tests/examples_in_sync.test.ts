// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * The examples keep their own copy of shared helpers, so each folder runs on its own.
 * These tests keep the copies from drifting apart.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const examples = fileURLToPath(new URL('../examples/', import.meta.url));
const COPIES = ['evals/native/scorers.ts', 'end-to-end/strands-observability-agent/judge.ts'];

/** The source of a top-level `export function <name>`, with its doc comment, up to its closing brace. */
function functionSource(file: string, name: string): string {
  const text = readFileSync(examples + file, 'utf8');
  const start = text.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${file} has no export function ${name}`);
  const doc = text.lastIndexOf('/**', start);
  const end = text.indexOf('\n}\n', start);
  return text.slice(doc >= 0 && text.slice(doc, start).includes('*/') ? doc : start, end + 2);
}

describe.skipIf(!COPIES.every((f) => existsSync(examples + f)))('example copies', () => {
  it('firstJsonObject is the same judge-reply parser in every example', () => {
    const [first, ...rest] = COPIES.map((f) => functionSource(f, 'firstJsonObject'));
    for (const other of rest) expect(other).toBe(first);
  });
});
