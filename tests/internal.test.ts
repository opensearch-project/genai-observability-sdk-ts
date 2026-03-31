// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, vi } from 'vitest';
import { parseHex, validateMetadataKeys, RESERVED_KEYS } from '../src/internal.js';

describe('RESERVED_KEYS', () => {
  it('contains expected keys', () => {
    expect(RESERVED_KEYS.has('test.suite.name')).toBe(true);
    expect(RESERVED_KEYS.has('test.suite.run.id')).toBe(true);
    expect(RESERVED_KEYS.has('test.suite.run.status')).toBe(true);
    expect(RESERVED_KEYS.has('test.case.id')).toBe(true);
    expect(RESERVED_KEYS.has('test.case.name')).toBe(true);
    expect(RESERVED_KEYS.has('test.case.result.status')).toBe(true);
    expect(RESERVED_KEYS.has('test.case.error')).toBe(true);
    expect(RESERVED_KEYS.has('test.case.input')).toBe(true);
    expect(RESERVED_KEYS.has('test.case.output')).toBe(true);
    expect(RESERVED_KEYS.has('test.case.expected')).toBe(true);
    expect(RESERVED_KEYS.has('gen_ai.operation.name')).toBe(true);
  });

  it('does not contain arbitrary keys', () => {
    expect(RESERVED_KEYS.has('custom.key')).toBe(false);
    expect(RESERVED_KEYS.has('foo')).toBe(false);
  });
});

describe('parseHex', () => {
  it('parses simple hex values', () => {
    expect(parseHex('ff')).toBe(255);
    expect(parseHex('0')).toBe(0);
    expect(parseHex('10')).toBe(16);
    expect(parseHex('abc')).toBe(0xabc);
  });

  it('parses hex with 0x prefix', () => {
    expect(parseHex('0xff')).toBe(255);
    expect(parseHex('0xFF')).toBe(255);
    expect(parseHex('0x0')).toBe(0);
    expect(parseHex('0x10')).toBe(16);
  });

  it('returns 0 for empty string', () => {
    expect(parseHex('')).toBe(0);
  });

  it('returns null for invalid hex', () => {
    expect(parseHex('xyz')).toBe(null);
    expect(parseHex('gg')).toBe(null);
  });

  it('handles large hex values', () => {
    expect(parseHex('ffffffff')).toBe(0xffffffff);
  });
});

describe('validateMetadataKeys', () => {
  it('warns for reserved keys', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateMetadataKeys({ 'test.suite.name': 'foo' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('test.suite.name');
    warnSpy.mockRestore();
  });

  it('does not warn for non-reserved keys', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateMetadataKeys({ 'custom.key': 'value', 'another': 42 });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('includes context in warning message', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateMetadataKeys({ 'gen_ai.operation.name': 'foo' }, 'TestContext');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('TestContext');
    warnSpy.mockRestore();
  });

  it('warns for multiple reserved keys', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateMetadataKeys({
      'test.suite.name': 'a',
      'test.case.id': 'b',
      'custom': 'c',
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('handles empty metadata', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateMetadataKeys({});
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
