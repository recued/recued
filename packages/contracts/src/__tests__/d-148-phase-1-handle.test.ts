/** D-148 P1 — handle validator + Unicode-confusable detection.
 *
 *  Acceptance per spec § P1: `validateHandle('admin')` rejects;
 *  `validateHandle('alice')` accepts; `validateHandle('alicé')`
 *  rejects when 'alice' exists in the comparison set.
 */

import { describe, it, expect } from 'vitest';
import {
  validateHandle,
  computeHandleSkeleton,
  canonicalizeHandle,
  findConfusableHandle,
  D148_RESERVED_HANDLES,
  D148_HANDLE_REGEX,
  D148_HANDLE_MIN_LENGTH,
  D148_HANDLE_MAX_LENGTH,
} from '../handle.js';

describe('D-148 P1 — handle constants', () => {
  it('reserves DDNS-zone names', () => {
    expect(D148_RESERVED_HANDLES.has('admin')).toBe(true);
    expect(D148_RESERVED_HANDLES.has('api')).toBe(true);
    expect(D148_RESERVED_HANDLES.has('mcp')).toBe(true);
    expect(D148_RESERVED_HANDLES.has('webhooks')).toBe(true);
    expect(D148_RESERVED_HANDLES.has('reception')).toBe(true);
    expect(D148_RESERVED_HANDLES.has('recued')).toBe(true);
    expect(D148_RESERVED_HANDLES.has('recued-core')).toBe(true);
  });

  it('reserves single-letter handles', () => {
    for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
      expect(D148_RESERVED_HANDLES.has(ch)).toBe(true);
    }
  });

  it('does not reserve user-typical names', () => {
    expect(D148_RESERVED_HANDLES.has('alice')).toBe(false);
    expect(D148_RESERVED_HANDLES.has('bob')).toBe(false);
    expect(D148_RESERVED_HANDLES.has('alice-the-greater')).toBe(false);
  });

  it('regex enforces ASCII-letter-digit-hyphen format', () => {
    expect(D148_HANDLE_REGEX.test('alice')).toBe(true);
    expect(D148_HANDLE_REGEX.test('alice-the-greater')).toBe(true);
    expect(D148_HANDLE_REGEX.test('alice123')).toBe(true);
    expect(D148_HANDLE_REGEX.test('1alice')).toBe(false);
    expect(D148_HANDLE_REGEX.test('-alice')).toBe(false);
    expect(D148_HANDLE_REGEX.test('alice-')).toBe(false);
    expect(D148_HANDLE_REGEX.test('alicé')).toBe(false);
    expect(D148_HANDLE_REGEX.test('Alice')).toBe(false);
  });

  it('length bounds reasonable (2..40)', () => {
    expect(D148_HANDLE_MIN_LENGTH).toBe(2);
    expect(D148_HANDLE_MAX_LENGTH).toBe(40);
  });
});

describe('D-148 P1 — canonicalizeHandle', () => {
  it('lowercases + trims + NFKC-normalizes', () => {
    expect(canonicalizeHandle('Alice')).toBe('alice');
    expect(canonicalizeHandle('  alice  ')).toBe('alice');
    // Fullwidth Latin small a 'ａ' NFKC-folds to 'a'.
    expect(canonicalizeHandle('ａlice')).toBe('alice');
  });
});

describe('D-148 P1 — computeHandleSkeleton (Unicode confusable folding)', () => {
  it('folds Latin diacritics to base letters', () => {
    expect(computeHandleSkeleton('alicé')).toBe('alice');
    expect(computeHandleSkeleton('alíce')).toBe('alice');
    expect(computeHandleSkeleton('alïce')).toBe('alice');
  });

  it('folds Cyrillic look-alikes', () => {
    // Cyrillic 'а', 'е' look like Latin a, e.
    expect(computeHandleSkeleton('аlice')).toBe('alice');
    expect(computeHandleSkeleton('alicе')).toBe('alice');
  });

  it('strips invisible code points (zero-width characters)', () => {
    expect(computeHandleSkeleton('al​ice')).toBe('alice');
    expect(computeHandleSkeleton('‌alice')).toBe('alice');
  });

  it('drops hyphens (recue-d ↔ recued)', () => {
    expect(computeHandleSkeleton('recue-d')).toBe('recued');
    expect(computeHandleSkeleton('recued')).toBe('recued');
  });

  it('handles nfkc fullwidth folding', () => {
    expect(computeHandleSkeleton('ａlice')).toBe('alice');
  });

  it('digit/letter swaps fold', () => {
    expect(computeHandleSkeleton('a1ice')).toBe('alice');
    expect(computeHandleSkeleton('al0ce')).toBe('aloce');
  });
});

describe('D-148 P1 — findConfusableHandle', () => {
  it('finds visually-confusable existing handle', () => {
    const existing = new Set(['alice', 'bob']);
    expect(findConfusableHandle('alicé', existing)).toBe('alice');
    expect(findConfusableHandle('alíce', existing)).toBe('alice');
    expect(findConfusableHandle('a1ice', existing)).toBe('alice');
  });

  it('returns undefined when no confusable found', () => {
    const existing = new Set(['alice', 'bob']);
    expect(findConfusableHandle('charlie', existing)).toBeUndefined();
  });

  it('does not flag the handle as confusable to itself', () => {
    const existing = new Set(['alice']);
    expect(findConfusableHandle('alice', existing)).toBeUndefined();
  });

  it('empty existing set returns undefined', () => {
    expect(findConfusableHandle('alice', new Set())).toBeUndefined();
  });
});

describe('D-148 P1 — validateHandle', () => {
  it('accepts a valid handle', () => {
    const result = validateHandle('alice');
    expect(result.ok).toBe(true);
    expect(result.canonical).toBe('alice');
    expect(result.issues).toHaveLength(0);
  });

  it('canonicalizes uppercase + whitespace input', () => {
    const result = validateHandle('  Alice  ');
    expect(result.canonical).toBe('alice');
    expect(result.ok).toBe(true);
  });

  it('rejects empty input', () => {
    const result = validateHandle('');
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe('handle_empty');
  });

  it('rejects single-letter handles via reservation', () => {
    const result = validateHandle('a');
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('handle_reserved');
  });

  it('rejects DDNS-zone-reserved names', () => {
    const reserved = ['admin', 'api', 'mcp', 'webhooks', 'reception', 'recued'];
    for (const r of reserved) {
      const result = validateHandle(r);
      expect(result.ok).toBe(false);
      expect(result.issues.map((i) => i.code)).toContain('handle_reserved');
    }
  });

  it('rejects too-long handles', () => {
    const result = validateHandle('a'.repeat(41));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('handle_too_long');
  });

  it('rejects format violations: starts with digit', () => {
    const result = validateHandle('1alice');
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('handle_format');
  });

  it('rejects format violations: ends with hyphen', () => {
    const result = validateHandle('alice-');
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('handle_format');
  });

  it('rejects diacritic forms (ASCII-only handles)', () => {
    const result = validateHandle('alicé');
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('handle_format');
  });

  it('rejects confusable to existing handle (alicé vs alice)', () => {
    // The format rule will reject alicé; this test asserts the
    // confusable check fires AS WELL when an existing comparison
    // set is supplied — the spec acceptance test calls out the
    // case explicitly.
    const result = validateHandle('alicé', {
      existing_handles: new Set(['alice']),
    });
    expect(result.ok).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('handle_confusable_to_existing');
  });

  it('rejects Cyrillic confusable when existing handle present', () => {
    const result = validateHandle('аlice', {
      existing_handles: new Set(['alice']),
    });
    expect(result.ok).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('handle_confusable_to_existing');
  });

  it('does not flag handle as confusable to itself', () => {
    const result = validateHandle('alice', {
      existing_handles: new Set(['alice']),
    });
    // Confusable to self is not flagged; identity match emits
    // `handle_taken` (Codex P2 #2 fold) instead.
    expect(result.issues.map((i) => i.code)).not.toContain('handle_confusable_to_existing');
  });

  it('Codex P2 #2 — emits handle_taken on case-insensitive match', () => {
    const result = validateHandle('Alice', {
      existing_handles: new Set(['alice']),
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('handle_taken');
  });

  it('Codex P2 #2 — does not double-flag taken + confusable', () => {
    const result = validateHandle('alice', {
      existing_handles: new Set(['alice']),
    });
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('handle_taken');
    expect(codes).not.toContain('handle_confusable_to_existing');
  });

  it('Codex P2 #2 — confusable still fires when not exact match', () => {
    const result = validateHandle('alicé', {
      existing_handles: new Set(['alice']),
    });
    expect(result.ok).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('handle_confusable_to_existing');
    expect(codes).not.toContain('handle_taken');
  });

  it('Codex P2 #2 — canonicalizes the comparison set on every call', () => {
    // Caller passes an uppercase handle in the existing set; the
    // validator canonicalizes before comparing. `Alice` ↔ `alice`
    // collision is detected.
    const result = validateHandle('alice', {
      existing_handles: new Set(['Alice']),
    });
    expect(result.issues.map((i) => i.code)).toContain('handle_taken');
  });
});
