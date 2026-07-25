/** D-112 C1 — engine lock constant + wildcard helper tests. */

import { describe, expect, it } from 'vitest';
import {
  ENGINE_LOCKED_INPUT_KEYS,
  isLockedInputKey,
  isWildcardMarker,
  matchesWildcard,
  wildcardPrefix,
} from '../locked-input-keys.js';

describe('ENGINE_LOCKED_INPUT_KEYS (D-112 C1)', () => {
  it('contains the five D-112 protocol-level locks plus the D-116 llm.delimiter', () => {
    expect([...ENGINE_LOCKED_INPUT_KEYS].sort()).toEqual([
      'header.authorization',
      'header.cookie',
      'header.host',
      'llm.delimiter',
      'method',
      'url',
    ]);
  });

  it('isLockedInputKey is case-sensitive — locks stored lowercase', () => {
    expect(isLockedInputKey('url')).toBe(true);
    expect(isLockedInputKey('URL')).toBe(false);
    expect(isLockedInputKey('header.authorization')).toBe(true);
    expect(isLockedInputKey('Header.Authorization')).toBe(false);
  });

  it('isLockedInputKey returns false for related-but-unlocked keys', () => {
    // Protocol-level only — API-specific auth headers stay recipe-
    // overridable by design (spec non-goal #7).
    expect(isLockedInputKey('header.x-api-key')).toBe(false);
    expect(isLockedInputKey('header.content-type')).toBe(false);
    expect(isLockedInputKey('body.url')).toBe(false);
    expect(isLockedInputKey('query.method')).toBe(false);
  });
});

describe('wildcard helpers (D-112 C1)', () => {
  it('isWildcardMarker recognises `prefix.*` with null value', () => {
    expect(isWildcardMarker('body.properties.*', null)).toBe(true);
    expect(isWildcardMarker('header.*', null)).toBe(true);
    expect(isWildcardMarker('body.properties.*', 'default')).toBe(false);
    expect(isWildcardMarker('body.properties.name', null)).toBe(false);
    expect(isWildcardMarker('*', null)).toBe(false); // no prefix
  });

  it('wildcardPrefix strips the `.*` suffix', () => {
    expect(wildcardPrefix('body.properties.*')).toBe('body.properties');
    expect(wildcardPrefix('header.*')).toBe('header');
  });

  it('matchesWildcard admits single-level children, rejects nested keys', () => {
    const prefixes = new Set(['body.properties', 'header']);
    // Happy cases
    expect(matchesWildcard('body.properties.dealname', prefixes)).toBe(true);
    expect(matchesWildcard('body.properties.amount', prefixes)).toBe(true);
    expect(matchesWildcard('header.x-api-key', prefixes)).toBe(true);
    // Nested → single-level only, reject.
    expect(matchesWildcard('body.properties.nested.deep', prefixes)).toBe(false);
    // Empty tail.
    expect(matchesWildcard('body.properties.', prefixes)).toBe(false);
    // Unknown prefix.
    expect(matchesWildcard('query.foo', prefixes)).toBe(false);
    // Prefix alone (no trailing segment) — rejected.
    expect(matchesWildcard('body.properties', prefixes)).toBe(false);
    // Characters outside [A-Za-z0-9_-] rejected.
    expect(matchesWildcard('body.properties.has space', prefixes)).toBe(false);
    expect(matchesWildcard('body.properties.😀', prefixes)).toBe(false);
    // Underscores + hyphens OK.
    expect(matchesWildcard('body.properties.snake_case', prefixes)).toBe(true);
    expect(matchesWildcard('body.properties.kebab-case', prefixes)).toBe(true);
  });

  it('matchesWildcard returns false for an empty prefix set', () => {
    expect(matchesWildcard('body.properties.x', new Set())).toBe(false);
  });
});
