import { describe, expect, it } from 'vitest';

import { deriveWatchUrlPattern } from '../url-pattern.js';

describe('D-169 brick 3 — deriveWatchUrlPattern', () => {
  it('wildcards the leaf path segment (the handover example)', () => {
    expect(deriveWatchUrlPattern('https://app.hubspot.com/contacts/123')).toBe(
      'https://app.hubspot.com/contacts/*',
    );
  });

  it('keeps the deeper path, wildcarding only the leaf', () => {
    expect(deriveWatchUrlPattern('https://example.com/a/b/c')).toBe(
      'https://example.com/a/b/*',
    );
  });

  it('ignores query + fragment', () => {
    expect(deriveWatchUrlPattern('https://h.com/a/b?x=1&y=2#frag')).toBe(
      'https://h.com/a/*',
    );
  });

  it('collapses a 0- or 1-segment path to the whole origin', () => {
    expect(deriveWatchUrlPattern('https://example.com/')).toBe('https://example.com/*');
    expect(deriveWatchUrlPattern('https://example.com')).toBe('https://example.com/*');
    expect(deriveWatchUrlPattern('https://example.com/page')).toBe('https://example.com/*');
  });

  it('preserves an explicit port in the host', () => {
    expect(deriveWatchUrlPattern('http://localhost:3000/x/y')).toBe(
      'http://localhost:3000/x/*',
    );
  });

  it('returns null for non-web schemes and unparseable input', () => {
    expect(deriveWatchUrlPattern('chrome://extensions/')).toBeNull();
    expect(deriveWatchUrlPattern('file:///etc/passwd')).toBeNull();
    expect(deriveWatchUrlPattern('chrome-extension://abc/page.html')).toBeNull();
    expect(deriveWatchUrlPattern('not a url')).toBeNull();
    expect(deriveWatchUrlPattern('')).toBeNull();
  });

  it('never emits a whitespace-bearing pattern', () => {
    // A space in the path is percent-encoded by URL parsing, so the derived
    // pattern stays whitespace-free (the rpc rejects whitespace).
    const pattern = deriveWatchUrlPattern('https://example.com/a b/c');
    expect(pattern).not.toBeNull();
    expect(pattern!).not.toContain(' ');
  });
});
