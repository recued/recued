/** D-335 slice G — where the Bridge may act: the kernel's grant is Chrome's own,
 *  and the owner's list of sites Recued must never use. */

import { describe, expect, it, vi } from 'vitest';
import { isCommandWithinIngredientGrant, type BridgeIngredientRef } from '@recued/contracts';
import { buildGrant, createInMemoryBridgeGrantStore } from '../permissions/grants.js';
import {
  BLOCKED_SITES_KEY,
  EVERY_SITE,
  createKernelSiteGrantStore,
  isOnBlockedSite,
  normalizeBlockedSite,
  readBlockedSites,
} from '../permissions/site-grants.js';

const kernel = (slug: string, target: string): BridgeIngredientRef => ({ publisher_id: 'recued', slug, version: '1',
  surface_kind: 'reading', domain_allowlist: [target], domain_allowlist_signature: '' });

describe('a kernel DOM step runs on the sites Chrome has granted the extension', () => {
  it('reads Chrome on every lookup, so a grant taken back in Chrome is gone at once', async () => {
    let origins: string[] = [EVERY_SITE];
    const store = createKernelSiteGrantStore({ grantedOrigins: async () => origins, fallback: createInMemoryBridgeGrantStore() });
    const grant = await store.get('recued', 'dom-inspect', '1');
    expect(grant).toMatchObject({ publisher_id: 'recued', slug: 'dom-inspect', version: '1', granted_origins: [EVERY_SITE] });
    expect(isCommandWithinIngredientGrant(EVERY_SITE, kernel('dom-inspect', EVERY_SITE), grant!)).toBe(true);
    expect(isCommandWithinIngredientGrant('*://mail.google.com/*', kernel('dom-read', '*://mail.google.com/*'),
      (await store.get('recued', 'dom-read', '1'))!)).toBe(true);
    origins = [];
    expect(await store.get('recued', 'dom-inspect', '1')).toBeNull();
  });

  it('a grant on some sites covers them, and never every site', async () => {
    const store = createKernelSiteGrantStore({ grantedOrigins: async () => ['*://*.example.com/*'],
      fallback: createInMemoryBridgeGrantStore() });
    const grant = (await store.get('recued', 'dom-tabs', '1'))!;
    expect(isCommandWithinIngredientGrant('*://app.example.com/*', kernel('dom-tabs', '*://app.example.com/*'), grant)).toBe(true);
    expect(isCommandWithinIngredientGrant(EVERY_SITE, kernel('dom-tabs', EVERY_SITE), grant)).toBe(false);
  });

  it('Chrome failing to answer grants nothing', async () => {
    const store = createKernelSiteGrantStore({ grantedOrigins: async () => { throw new Error('no permissions API'); },
      fallback: createInMemoryBridgeGrantStore() });
    expect(await store.get('recued', 'dom-inspect', '1')).toBeNull();
  });

  it('another publisher\'s ingredient needs its own grant, which Chrome\'s grant does not give', async () => {
    const grantedOrigins = vi.fn(async () => [EVERY_SITE]);
    const fallback = createInMemoryBridgeGrantStore();
    const store = createKernelSiteGrantStore({ grantedOrigins, fallback });
    expect(await store.get('acme', 'deal-reader', '1')).toBeNull();
    await store.put(buildGrant({ publisher_id: 'acme', slug: 'deal-reader', version: '1' }, ['*://acme.example/*'], 1));
    expect(await store.get('acme', 'deal-reader', '1')).toMatchObject({ granted_origins: ['*://acme.example/*'] });
    expect(grantedOrigins).not.toHaveBeenCalled();
    expect(await fallback.list()).toHaveLength(1);
  });
});

describe('the owner\'s list of sites Recued must never use', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  Example.COM  ', 'example.com'],
    ['https://Mail.Example.com/inbox?x=1', 'mail.example.com'],
    ['mail.example.com/inbox', 'mail.example.com'],
    ['http://localhost:3000', 'localhost'],
    ['example.com.', 'example.com'],
    ['127.0.0.1', '127.0.0.1'],
  ])('keeps %j as %j', (typed, kept) => {
    expect(normalizeBlockedSite(typed)).toBe(kept);
  });

  it.each(['', '   ', 'two words.com', 'ftp://example.com', 'file:///etc', 'https://'])('names no site: %j', typed => {
    expect(normalizeBlockedSite(typed)).toBeNull();
  });

  it('covers the site and every page under it, and no other site', () => {
    const list = ['example.com'];
    expect(isOnBlockedSite('https://example.com/a', list)).toBe(true);
    expect(isOnBlockedSite('http://www.example.com:8080/b', list)).toBe(true);
    expect(isOnBlockedSite('https://a.b.EXAMPLE.com/', list)).toBe(true);
    expect(isOnBlockedSite('https://notexample.com/', list)).toBe(false);
    expect(isOnBlockedSite('https://example.com.evil.test/', list)).toBe(false);
    expect(isOnBlockedSite('about:blank', list)).toBe(false);
    expect(isOnBlockedSite('not a url', list)).toBe(false);
    expect(isOnBlockedSite('https://www.example.com/', ['www.example.com'])).toBe(true);
    expect(isOnBlockedSite('https://example.com/', ['www.example.com'])).toBe(false);
  });

  it('reads the kept list; none kept is none, and anything else kept is not read as none', async () => {
    const storage = (value: unknown) => ({ get: async () => (value === undefined ? {} : { [BLOCKED_SITES_KEY]: value }) });
    expect(await readBlockedSites(storage(undefined))).toEqual([]);
    expect(await readBlockedSites(storage(['Example.com', 'mail.test']))).toEqual(['example.com', 'mail.test']);
    await expect(readBlockedSites(storage('example.com'))).rejects.toThrow();
    await expect(readBlockedSites(storage(['example.com', 7]))).rejects.toThrow();
    await expect(readBlockedSites(storage(['ftp://x.test']))).rejects.toThrow();
  });
});
