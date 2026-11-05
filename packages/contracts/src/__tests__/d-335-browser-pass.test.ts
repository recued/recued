/** D-335 slice F — the pure vocabulary of passes for Browser Toolkit writes
 *  (`browser-pass.ts`): the key is who × recipe × site, the site an http(s) origin and
 *  nothing else, an offer read back defensively, and what a suggestion lists. */

import { describe, expect, it } from 'vitest';

import {
  BROWSER_PASS_ALWAYS_OPTION_ID,
  BROWSER_PASS_SESSION_OPTION_ID,
  browserPassElementOf,
  browserPassKeyHash,
  browserPassOccasionOf,
  browserPassSiteOf,
  browserPassActsOf,
  describeBrowserPass,
  isBrowserPassLive,
  readBrowserPassOffer,
  type BrowserPassKey,
  type BrowserPassRow,
} from '../browser-pass.js';

const KEY: BrowserPassKey = { principal: { kind: 'owner_chat' }, recipe: 'click-web-element', site: 'https://github.com' };

describe('D-335 slice F — a pass key', () => {
  it('is who × recipe × site: changing any one is another key', () => {
    const hashes = new Set([
      browserPassKeyHash(KEY),
      browserPassKeyHash({ ...KEY, recipe: 'type-into-web-page' }),
      browserPassKeyHash({ ...KEY, site: 'https://gist.github.com' }),
      browserPassKeyHash({ ...KEY, principal: { kind: 'ai_app', contract_id: 'ct-1' } }),
      browserPassKeyHash({ ...KEY, principal: { kind: 'ai_app', contract_id: 'ct-2' } }),
    ]);
    expect(hashes.size).toBe(5);
    // Stable, and blind to anything else a stored key carries.
    expect(browserPassKeyHash({ ...KEY, extra: 1 } as BrowserPassKey)).toBe(browserPassKeyHash(KEY));
  });

  it('names a site by its http(s) origin, nothing else', () => {
    expect(browserPassSiteOf('https://github.com/owner/repo/pull/1?tab=files#top')).toBe('https://github.com');
    expect(browserPassSiteOf('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080');
    for (const other of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'github.com', '', 7, undefined]) {
      expect(browserPassSiteOf(other), String(other)).toBeUndefined();
    }
  });

  it('describes what a pass lets happen', () => {
    expect(describeBrowserPass(KEY)).toBe('Click on github.com');
    expect(describeBrowserPass({ ...KEY, recipe: 'type-into-web-page' })).toBe('Type into pages on github.com');
    expect(describeBrowserPass({ ...KEY, recipe: 'open-web-page', site: 'http://127.0.0.1:8080' }))
      .toBe('Open pages on 127.0.0.1:8080');
    expect(describeBrowserPass({ ...KEY, recipe: 'post-to-linkedin' })).toBe('Run post-to-linkedin on github.com');
    // Slice J — a sequence's pass, as Contracts lists it and as the ask says what it covers.
    expect(describeBrowserPass({ ...KEY, recipe: 'act-on-web-page' })).toBe('Act on pages on github.com');
    expect(browserPassActsOf({ ...KEY, recipe: 'act-on-web-page' })).toBe('sequences of steps on github.com');
  });

  it('keeps its answers\' ids within Telegram\'s callback room', () => {
    for (const id of [BROWSER_PASS_SESSION_OPTION_ID, BROWSER_PASS_ALWAYS_OPTION_ID]) {
      expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(23);
    }
  });
});

describe('D-335 slice F — an offer read back', () => {
  const offer = { key: KEY, host: 'github.com', channel_session_id: 'chat:s' };
  it('reads a whole offer, and only its fields', () => {
    expect(readBrowserPassOffer({ ...offer, extra: true })).toEqual(offer);
    expect(readBrowserPassOffer({ ...offer, key: { ...KEY, principal: { kind: 'ai_app', contract_id: 'ct-1', x: 1 } } }))
      .toEqual({ ...offer, key: { ...KEY, principal: { kind: 'ai_app', contract_id: 'ct-1' } } });
  });

  it('reads nothing from an offer this version cannot trust', () => {
    for (const bad of [
      undefined, null, [], 'offer',
      { ...offer, key: { ...KEY, site: 'https://github.com/owner' } },
      { ...offer, key: { ...KEY, site: 'file:///x' } },
      { ...offer, key: { ...KEY, recipe: '' } },
      { ...offer, key: { ...KEY, principal: { kind: 'ai_app' } } },
      { ...offer, key: { ...KEY, principal: { kind: 'everyone' } } },
      { ...offer, host: '' },
      { key: KEY, host: 'github.com' },
    ]) {
      expect(readBrowserPassOffer(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('counts an answer on its conversation and UTC day', () => {
    expect(browserPassOccasionOf(offer, Date.parse('2026-11-04T23:59:59Z')))
      .toBe(`chat:s|${Math.floor(Date.parse('2026-11-04T00:00:00Z') / 86_400_000)}`);
  });
});

describe('D-335 slice F — what an approval was for', () => {
  it('an element as the page named it', () => {
    expect(browserPassElementOf({ site: 'github.com', title: 'PR', role: 'button', label: 'Merge', protected: false }, undefined))
      .toBe('button “Merge”');
    expect(browserPassElementOf({ site: 'github.com', title: 'PR', role: 'button', label: '', protected: false }, undefined))
      .toBe('button');
    expect(browserPassElementOf({ site: 'github.com', unread: 'no Browser Bridge is connected' }, undefined)).toBeUndefined();
  });

  it('an opened address without its query or fragment, which can carry the owner\'s data', () => {
    expect(browserPassElementOf(undefined, 'https://github.com/search?q=salary+ada#top')).toBe('https://github.com/search');
    expect(browserPassElementOf(undefined, 'mailto:ada@example.com')).toBeUndefined();
  });
});

describe('D-335 slice F — a live pass', () => {
  const base: BrowserPassRow = { pass_id: 'p', key_hash: 'h', key: KEY, host: 'github.com', kind: 'session',
    channel_session_id: 'chat:s', created_at: 0, expires_at: 100, uses: 0 };
  it('a session pass: its conversation, before it ends; an always pass: until ended', () => {
    expect(isBrowserPassLive(base, 99, 'chat:s')).toBe(true);
    expect(isBrowserPassLive(base, 100, 'chat:s')).toBe(false);
    expect(isBrowserPassLive(base, 1, 'chat:t')).toBe(false);
    expect(isBrowserPassLive(base, 1, undefined)).toBe(false);
    const always = { ...base, kind: 'always' as const, channel_session_id: undefined, expires_at: undefined };
    expect(isBrowserPassLive(always, 1e15, 'chat:t')).toBe(true);
    expect(isBrowserPassLive({ ...always, revoked_at: 5 }, 6, 'chat:t')).toBe(false);
  });
});
