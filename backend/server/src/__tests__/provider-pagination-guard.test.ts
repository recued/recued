import { describe, expect, it } from 'vitest';

import {
  assertProviderPageUrl,
  ProviderPaginationGuard,
  readProviderStringContinuation,
} from '../provider-pagination-guard.js';

describe('provider pagination guard', () => {
  it('accepts distinct refs and rejects a cycle before the repeated fetch', () => {
    const guard = new ProviderPaginationGuard('stub', { maxPages: 3 });
    expect(guard.claim('first')).toBe('first');
    expect(guard.claim('second')).toBe('second');
    expect(() => guard.claim('second')).toThrow(
      'stub pagination repeated a page reference',
    );
  });

  it('bounds a stream of distinct refs', () => {
    const guard = new ProviderPaginationGuard('stub', { maxPages: 2 });
    guard.claim('first');
    guard.claim('second');
    expect(() => guard.claim('third')).toThrow(
      'stub pagination exceeded 2 pages',
    );
  });

  it('pins absolute page URLs to the trusted API origin', () => {
    const trusted = 'https://graph.microsoft.com/v1.0';
    const safe = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc';
    expect(assertProviderPageUrl(safe, trusted, 'Graph')).toBe(safe);
    expect(() => assertProviderPageUrl(
      'https://attacker.invalid/collect',
      trusted,
      'Graph',
    )).toThrow('Graph pagination refused an off-origin URL');
    expect(() => assertProviderPageUrl('/relative', trusted, 'Graph')).toThrow(
      'Graph pagination returned a malformed absolute URL',
    );
  });

  it('refuses embedded URL credentials and runtime non-string refs', () => {
    expect(() => assertProviderPageUrl(
      'https://user:secret@graph.microsoft.com/v1.0/me/messages',
      'https://graph.microsoft.com/v1.0',
      'Graph',
    )).toThrow('Graph pagination returned a URL containing credentials');
    const guard = new ProviderPaginationGuard('stub');
    expect(() => guard.claim(7 as unknown as string)).toThrow(
      'stub pagination returned a non-string page reference',
    );
  });

  it('distinguishes exhaustion from a malformed scalar continuation', () => {
    expect(readProviderStringContinuation(undefined, 'stub')).toBeUndefined();
    expect(readProviderStringContinuation(null, 'stub')).toBeUndefined();
    expect(readProviderStringContinuation('', 'stub')).toBeUndefined();
    expect(readProviderStringContinuation('next', 'stub')).toBe('next');
    expect(() => readProviderStringContinuation(0, 'stub')).toThrow(
      'stub pagination returned a non-string continuation',
    );
    expect(() => readProviderStringContinuation(false, 'stub')).toThrow(
      'stub pagination returned a non-string continuation',
    );
  });
});
