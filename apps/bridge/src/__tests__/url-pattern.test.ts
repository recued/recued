/** D-169 P2 brick 3 — regression coverage for the "Watch this element"
 *  URL → Chrome match-pattern derivation (`picker/url-pattern.ts`).
 *
 *  Locks in the Fork-4 rule: keep the path up to the leaf and wildcard the
 *  leaf; a 0/1-segment path collapses to the whole origin; only http/https
 *  derive a pattern (a dom-watch can't poll chrome://, file://, extension
 *  pages); everything else fails closed to null. */

import { describe, it, expect } from 'vitest';
import { deriveWatchUrlPattern } from '../picker/url-pattern.js';

describe('deriveWatchUrlPattern — leaf-wildcard derivation', () => {
  it('drops the leaf segment and wildcards it', () => {
    expect(deriveWatchUrlPattern('https://app.hubspot.com/contacts/123')).toBe(
      'https://app.hubspot.com/contacts/*',
    );
    expect(deriveWatchUrlPattern('https://app.hubspot.com/a/b/c/d')).toBe(
      'https://app.hubspot.com/a/b/c/*',
    );
  });

  it('collapses a 0/1-segment path to the whole origin', () => {
    expect(deriveWatchUrlPattern('https://app.hubspot.com')).toBe('https://app.hubspot.com/*');
    expect(deriveWatchUrlPattern('https://app.hubspot.com/')).toBe('https://app.hubspot.com/*');
    // Single segment → leaf drop leaves nothing → whole origin.
    expect(deriveWatchUrlPattern('https://app.hubspot.com/contacts')).toBe(
      'https://app.hubspot.com/*',
    );
  });

  it('ignores query + fragment (only the pathname drives the pattern)', () => {
    expect(
      deriveWatchUrlPattern('https://app.hubspot.com/contacts/123?tab=notes#top'),
    ).toBe('https://app.hubspot.com/contacts/*');
  });

  it('keeps an explicit port on the host', () => {
    expect(deriveWatchUrlPattern('http://localhost:3001/deals/42')).toBe(
      'http://localhost:3001/deals/*',
    );
  });

  it('derives from http as well as https', () => {
    expect(deriveWatchUrlPattern('http://example.com/x/y')).toBe('http://example.com/x/*');
  });

  it('fails closed to null for a non-web scheme', () => {
    expect(deriveWatchUrlPattern('chrome://extensions')).toBeNull();
    expect(deriveWatchUrlPattern('file:///etc/hosts')).toBeNull();
    expect(deriveWatchUrlPattern('ftp://host/file')).toBeNull();
  });

  it('fails closed to null for an unparseable URL', () => {
    expect(deriveWatchUrlPattern('not a url')).toBeNull();
    expect(deriveWatchUrlPattern('')).toBeNull();
  });
});
