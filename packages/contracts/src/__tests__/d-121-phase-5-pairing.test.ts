/** D-121 Phase 5 — direct pairing contracts tests.
 *
 *  Covers the direct `/auth/pair` code constants shared by the CLI,
 *  server, and webclient. The former cloud pair-blob relay contracts
 *  were retired by D-156 and deleted in 2026-06. */

import { describe, expect, it } from 'vitest';
import {
  PAIRING_CODE_CHARSET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_REGEX,
} from '../pairing.js';

describe('pairing-code charset', () => {
  it('excludes ambiguous glyphs 0/O, 1/l/I', () => {
    expect(PAIRING_CODE_CHARSET).not.toMatch(/[0Oo1lI]/);
  });

  it('is URL-safe and contains only printable ASCII', () => {
    for (const ch of PAIRING_CODE_CHARSET) {
      expect(ch.charCodeAt(0)).toBeGreaterThanOrEqual(0x21);
      expect(ch.charCodeAt(0)).toBeLessThanOrEqual(0x7e);
      // No reserved URL chars
      expect(ch).not.toMatch(/[?&=#%/\\]/);
    }
  });

  it('contains both digits and letters with adequate entropy', () => {
    expect(PAIRING_CODE_CHARSET).toMatch(/[0-9]/);
    expect(PAIRING_CODE_CHARSET).toMatch(/[A-Z]/);
    expect(PAIRING_CODE_CHARSET).toMatch(/[a-z]/);
    // 8 chars * log2(56) ≈ 46.4 bits — comfortably above the spec floor.
    expect(PAIRING_CODE_CHARSET.length).toBeGreaterThanOrEqual(50);
  });

  it('PAIRING_CODE_REGEX accepts every charset member at every position', () => {
    const code = PAIRING_CODE_CHARSET.slice(0, 8);
    expect(PAIRING_CODE_REGEX.test(code)).toBe(true);
  });

  it('PAIRING_CODE_REGEX rejects ambiguous glyphs', () => {
    expect(PAIRING_CODE_REGEX.test('0OoIIIII')).toBe(false);
    expect(PAIRING_CODE_REGEX.test('1lIabcde')).toBe(false);
  });

  it('PAIRING_CODE_REGEX rejects wrong length', () => {
    expect(PAIRING_CODE_REGEX.test('ABCDEFG')).toBe(false);   // 7
    expect(PAIRING_CODE_REGEX.test('ABCDEFGHI')).toBe(false); // 9
    expect(PAIRING_CODE_REGEX.test('')).toBe(false);
  });
});

describe('PAIRING_CODE_LENGTH', () => {
  it('is fixed at 8', () => {
    expect(PAIRING_CODE_LENGTH).toBe(8);
  });

  it('matches the regex length', () => {
    const sample = 'A'.repeat(PAIRING_CODE_LENGTH).replace(/A/g, '2');
    expect(PAIRING_CODE_REGEX.test(sample)).toBe(true);
  });
});
