/** D-335 slice F — the store for passes on Browser Toolkit writes, and what their approvals
 *  teach (`storage/browser-pass-store.ts`): a session pass covers its conversation until it
 *  ends, an always pass every conversation until it is ended; three approvals on three
 *  occasions in 30 days with no refusal suggest always allowing a key, listing what they were
 *  for; ending an always pass or dismissing a suggestion ends that key's suggestions, never
 *  the ask's own "Always allow". */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_PASS_SESSION_TTL_MS,
  browserPassKeyHash,
  type BrowserPassKey,
} from '@recued/contracts';

import { BrowserPassError, createBrowserPassStore } from '../storage/browser-pass-store.js';

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;
const CLICKS: BrowserPassKey = { principal: { kind: 'owner_chat' }, recipe: 'click-web-element', site: 'https://github.com' };
const TYPING: BrowserPassKey = { ...CLICKS, recipe: 'type-into-web-page' };
const APP_CLICKS: BrowserPassKey = { ...CLICKS, principal: { kind: 'ai_app', contract_id: 'ct-claude' } };

const fresh = () => {
  let n = 0;
  return createBrowserPassStore(new Database(':memory:'), { newId: () => `pass-${(n += 1)}` });
};

/** An approval (or refusal) of one held write, on its own run. */
let run = 0;
const answer = (
  store: ReturnType<typeof fresh>,
  key: BrowserPassKey,
  occasion: string,
  at: number,
  outcome: 'approved' | 'refused' = 'approved',
  element = 'button “Merge”',
) => store.recordAnswer({ run_id: `run-${(run += 1)}`, key, host: 'github.com', outcome, occasion, element, at });

describe('D-335 slice F — passes', () => {
  it('a session pass covers its own conversation, for 8 hours, and nothing else', () => {
    const store = fresh();
    store.mint({ key: CLICKS, host: 'github.com', kind: 'session', channel_session_id: 'chat:a', now: NOW });
    expect(store.use(CLICKS, 'chat:a', NOW + 1)).toMatchObject({ kind: 'session', uses: 1 });
    expect(store.use(CLICKS, 'chat:b', NOW + 1)).toBeUndefined();
    expect(store.use(CLICKS, undefined, NOW + 1)).toBeUndefined();
    expect(store.use(TYPING, 'chat:a', NOW + 1)).toBeUndefined();
    expect(store.use(APP_CLICKS, 'chat:a', NOW + 1)).toBeUndefined();
    expect(store.use({ ...CLICKS, site: 'https://gist.github.com' }, 'chat:a', NOW + 1)).toBeUndefined();
    expect(store.use(CLICKS, 'chat:a', NOW + BROWSER_PASS_SESSION_TTL_MS - 1)).toMatchObject({ uses: 2 });
    expect(store.use(CLICKS, 'chat:a', NOW + BROWSER_PASS_SESSION_TTL_MS)).toBeUndefined();
    expect(store.listPasses(NOW + BROWSER_PASS_SESSION_TTL_MS)).toEqual([]);
  });

  it('an always pass covers every conversation, has no end and no use limit, until it is ended', () => {
    const store = fresh();
    const pass = store.mint({ key: CLICKS, host: 'github.com', kind: 'always', now: NOW });
    expect(pass).toMatchObject({ kind: 'always', uses: 0 });
    expect(pass.expires_at).toBeUndefined();
    for (let i = 0; i < 150; i += 1) expect(store.use(CLICKS, `chat:${i}`, NOW + 400 * DAY)).toBeDefined();
    expect(store.listPasses(NOW + 400 * DAY)).toEqual([expect.objectContaining({ pass_id: pass.pass_id, uses: 150 })]);
    store.revoke(pass.pass_id, NOW + 401 * DAY);
    expect(store.use(CLICKS, 'chat:a', NOW + 401 * DAY)).toBeUndefined();
    expect(store.listPasses(NOW + 401 * DAY)).toEqual([]);
  });

  it('a second answer for a live pass returns it rather than a twin', () => {
    const store = fresh();
    const always = store.mint({ key: CLICKS, host: 'github.com', kind: 'always', now: NOW });
    expect(store.mint({ key: CLICKS, host: 'github.com', kind: 'always', now: NOW + 1 }).pass_id).toBe(always.pass_id);
    const session = store.mint({ key: TYPING, host: 'github.com', kind: 'session', channel_session_id: 'chat:a', now: NOW });
    expect(store.mint({ key: TYPING, host: 'github.com', kind: 'session', channel_session_id: 'chat:a', now: NOW + 1 })
      .pass_id).toBe(session.pass_id);
    expect(store.mint({ key: TYPING, host: 'github.com', kind: 'session', channel_session_id: 'chat:b', now: NOW + 1 })
      .pass_id).not.toBe(session.pass_id);
    expect(() => store.mint({ key: TYPING, host: 'github.com', kind: 'session', now: NOW }))
      .toThrow(BrowserPassError);
  });

  it('keeps its passes across a restart', () => {
    const db = new Database(':memory:');
    createBrowserPassStore(db).mint({ key: CLICKS, host: 'github.com', kind: 'always', now: NOW });
    expect(createBrowserPassStore(db).use(CLICKS, 'chat:a', NOW + 1)).toMatchObject({ kind: 'always' });
  });
});

describe('D-335 slice F — what approvals teach', () => {
  it('three approvals on three occasions in 30 days suggest always allowing, once, listing what they were for', () => {
    const store = fresh();
    expect(answer(store, CLICKS, 'chat:a|1', NOW).suggested).toBe(false);
    // The same occasion twice counts once.
    expect(answer(store, CLICKS, 'chat:a|1', NOW + 1, 'approved', 'link “Files”').suggested).toBe(false);
    expect(answer(store, CLICKS, 'chat:b|1', NOW + 2).suggested).toBe(false);
    expect(store.listSuggestions(NOW + 2)).toEqual([]);
    expect(answer(store, CLICKS, 'chat:c|2', NOW + DAY, 'approved', 'button “Close”').suggested).toBe(true);
    expect(answer(store, CLICKS, 'chat:d|3', NOW + 2 * DAY).suggested).toBe(false);
    expect(store.listSuggestions(NOW + 2 * DAY)).toEqual([expect.objectContaining({
      key_hash: browserPassKeyHash(CLICKS), key: CLICKS, host: 'github.com', approvals: 5, occasions: 4,
      // Newest first, each once.
      elements: ['button “Merge”', 'button “Close”', 'link “Files”'],
    })]);
  });

  it('one key per caller, recipe and site: approvals of another do not add up', () => {
    const store = fresh();
    answer(store, CLICKS, 'chat:a|1', NOW);
    answer(store, TYPING, 'chat:b|1', NOW);
    answer(store, APP_CLICKS, 'mcp:t|1', NOW);
    expect(answer(store, { ...CLICKS, site: 'https://gitlab.com' }, 'chat:c|1', NOW).suggested).toBe(false);
  });

  it('a refusal in the window holds the suggestion back, and withdraws an open one', () => {
    const store = fresh();
    answer(store, CLICKS, 'chat:a|1', NOW, 'refused');
    for (const occasion of ['chat:a|2', 'chat:b|2', 'chat:c|2']) {
      expect(answer(store, CLICKS, occasion, NOW + DAY).suggested).toBe(false);
    }
    // Once the refusal is 30 days old, the approvals after it can suggest.
    expect(answer(store, CLICKS, 'chat:d|40', NOW + 31 * DAY).suggested).toBe(true);
    answer(store, CLICKS, 'chat:e|40', NOW + 31 * DAY + 1, 'refused');
    expect(store.listSuggestions(NOW + 31 * DAY + 1)).toEqual([]);
  });

  it('approvals older than 30 days are not counted', () => {
    const store = fresh();
    answer(store, CLICKS, 'chat:a|1', NOW);
    answer(store, CLICKS, 'chat:b|1', NOW);
    expect(answer(store, CLICKS, 'chat:c|40', NOW + 31 * DAY).suggested).toBe(false);
  });

  it('an answer told twice is kept once', () => {
    const store = fresh();
    for (const occasion of ['chat:a|1', 'chat:b|1']) answer(store, CLICKS, occasion, NOW);
    const again = { run_id: 'run-same', key: CLICKS, host: 'github.com', outcome: 'approved' as const,
      occasion: 'chat:c|1', at: NOW };
    expect(store.recordAnswer(again).suggested).toBe(true);
    expect(store.recordAnswer({ ...again, occasion: 'chat:z|9' }).suggested).toBe(false);
    expect(store.listSuggestions(NOW)[0]).toMatchObject({ approvals: 3, occasions: 3 });
  });

  it('accepting a suggestion mints the same always pass as the ask, and a retry returns it', () => {
    const store = fresh();
    for (const occasion of ['chat:a|1', 'chat:b|1', 'chat:c|1']) answer(store, CLICKS, occasion, NOW);
    const key_hash = browserPassKeyHash(CLICKS);
    const { pass, suggestion } = store.accept(key_hash, NOW + 1);
    expect(pass).toMatchObject({ kind: 'always', key: CLICKS, key_hash });
    expect(suggestion).toMatchObject({ approvals: 3 });
    expect(store.listSuggestions(NOW + 1)).toEqual([]);
    expect(store.accept(key_hash, NOW + 2).pass.pass_id).toBe(pass.pass_id);
    // An approval asked before the pass existed teaches nothing more.
    expect(answer(store, CLICKS, 'chat:d|1', NOW + 3).suggested).toBe(false);
    expect(() => store.dismiss(key_hash, NOW + 4)).toThrow(/end the pass instead/);
  });

  it('dismissing ends the suggestions for good, but "Always allow" on an ask still mints', () => {
    const store = fresh();
    for (const occasion of ['chat:a|1', 'chat:b|1', 'chat:c|1']) answer(store, CLICKS, occasion, NOW);
    const key_hash = browserPassKeyHash(CLICKS);
    store.dismiss(key_hash, NOW + 1);
    expect(store.listSuggestions(NOW + 1)).toEqual([]);
    expect(answer(store, CLICKS, 'chat:d|2', NOW + DAY).suggested).toBe(false);
    expect(() => store.accept(key_hash, NOW + DAY)).toThrow(/dismissed for good/);
    expect(store.mint({ key: CLICKS, host: 'github.com', kind: 'always', now: NOW + DAY })).toMatchObject({ kind: 'always' });
    expect(store.use(CLICKS, 'chat:e', NOW + DAY + 1)).toBeDefined();
  });

  it('ending an always pass ends its key\'s suggestions; ending a session pass does not', () => {
    const store = fresh();
    const always = store.mint({ key: CLICKS, host: 'github.com', kind: 'always', now: NOW });
    store.revoke(always.pass_id, NOW + 1);
    for (const occasion of ['chat:a|2', 'chat:b|2', 'chat:c|2']) {
      expect(answer(store, CLICKS, occasion, NOW + DAY).suggested).toBe(false);
    }
    const session = store.mint({ key: TYPING, host: 'github.com', kind: 'session', channel_session_id: 'chat:a', now: NOW });
    store.revoke(session.pass_id, NOW + 1);
    const suggested = ['chat:a|2', 'chat:b|2', 'chat:c|2'].map((occasion) => answer(store, TYPING, occasion, NOW + DAY).suggested);
    expect(suggested).toEqual([false, false, true]);
  });

  it('refuses an unknown pass or suggestion as not found', () => {
    const store = fresh();
    expect(() => store.revoke('nope', NOW)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => store.accept('nope', NOW)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => store.dismiss('nope', NOW)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});
