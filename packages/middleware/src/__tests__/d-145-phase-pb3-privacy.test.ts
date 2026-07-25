/** D-145 PB3 — privacy ratchet (Codex P1 + P2 fold).
 *
 *  Per § B.2.3 + § B.5.1. The audit-safe error / detail projections
 *  are the substrate gate that PB3's catch paths route through. Pin
 *  the closed character set + the constructor-name fallback. */

import { describe, it, expect } from 'vitest';

import {
  projectAdapterDetailForAudit,
  projectErrorClass,
} from '../primitives/index.js';

describe('projectErrorClass (Codex P1 fold — privacy)', () => {
  it('returns Error.constructor.name for plain Error', () => {
    expect(projectErrorClass(new Error('contains user content'))).toBe('Error');
  });

  it('returns subclass.constructor.name for custom Error subclasses', () => {
    class TimeoutError extends Error {}
    class ValidationError extends Error {}
    expect(projectErrorClass(new TimeoutError('payload here'))).toBe('TimeoutError');
    expect(projectErrorClass(new ValidationError('payload here'))).toBe('ValidationError');
  });

  it('returns standard Error subclass names', () => {
    expect(projectErrorClass(new TypeError('x'))).toBe('TypeError');
    expect(projectErrorClass(new RangeError('x'))).toBe('RangeError');
    expect(projectErrorClass(new SyntaxError('x'))).toBe('SyntaxError');
  });

  it('returns "unknown_error" for non-Error throwables', () => {
    expect(projectErrorClass('string throw')).toBe('unknown_error');
    expect(projectErrorClass({ message: 'object throw' })).toBe('unknown_error');
    expect(projectErrorClass(null)).toBe('unknown_error');
    expect(projectErrorClass(undefined)).toBe('unknown_error');
    expect(projectErrorClass(42)).toBe('unknown_error');
  });

  it('NEVER returns Error.message contents', () => {
    const userText = 'sensitive@email.com posted: "leaked content"';
    const errClass = projectErrorClass(new Error(userText));
    expect(errClass).not.toContain('sensitive');
    expect(errClass).not.toContain('email');
    expect(errClass).not.toContain('leaked');
  });
});

describe('projectAdapterDetailForAudit (Codex P2 fold — privacy)', () => {
  it('returns undefined for undefined / empty', () => {
    expect(projectAdapterDetailForAudit(undefined)).toBeUndefined();
    expect(projectAdapterDetailForAudit('')).toBeUndefined();
  });

  it('passes through audit-safe character set', () => {
    expect(projectAdapterDetailForAudit('rows=42 status=ok')).toBe('rows=42 status=ok');
    expect(projectAdapterDetailForAudit('preview_no_op')).toBe('preview_no_op');
    expect(projectAdapterDetailForAudit('cap-3.4 ratio=0.85')).toBe('cap-3.4 ratio=0.85');
  });

  it('redacts when string contains unsafe characters (DOM selector chars)', () => {
    expect(projectAdapterDetailForAudit('div[data-id="secret"]')).toBe('<detail-redacted>');
    expect(projectAdapterDetailForAudit('contains/slash')).toBe('<detail-redacted>');
    expect(projectAdapterDetailForAudit('has "quotes"')).toBe('<detail-redacted>');
    expect(projectAdapterDetailForAudit('has\nnewline')).toBe('<detail-redacted>');
  });

  it('redacts JSON-shaped strings (raw payload risk)', () => {
    expect(projectAdapterDetailForAudit('{"email": "user@example.com"}')).toBe(
      '<detail-redacted>',
    );
  });

  it('clips to 64 chars before validating (prevents long detail leak)', () => {
    const long = 'a'.repeat(80) + ' contains-content';
    const projected = projectAdapterDetailForAudit(long);
    // First 64 chars are all 'a' → audit-safe → returns clipped.
    expect(projected).toBe('a'.repeat(64));
    expect(projected!.length).toBe(64);
  });

  it('NEVER passes through email-like strings (dot is allowed but @ is not)', () => {
    expect(projectAdapterDetailForAudit('user@example.com posted')).toBe('<detail-redacted>');
  });
});
