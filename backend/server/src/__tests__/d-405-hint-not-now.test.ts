/** D-405 slice 3 — "Not now" on a hint under a chat answer: the store, and the three methods the app
 *  calls (`chat.hints.list` / `not_now` / `restore`). What each offering place does with it is pinned on
 *  the real chat wire (`d-404-thing-steps-composition.test.ts`) and in the offer sources' own tests. */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { CHAT_HINT_NOT_NOW_MS, RpcError } from '@recued/contracts';

import { handleHintNotNow, handleHintRestore, handleHintsList, type ChatRpcDeps } from '../chat-handler.js';
import { createChatHintStore } from '../storage/chat-hint-store.js';

const DAY = 86_400_000;

const setup = () => {
  const db = new Database(':memory:');
  const hints = createChatHintStore(db);
  let at = 1_000_000;
  const logActivity = vi.fn(async () => undefined);
  const deps = { store: {} as never, hints, now: () => at, auditLog: { logActivity } } as unknown as ChatRpcDeps;
  return { db, hints, deps, logActivity, later: (ms: number) => { at += ms; }, now: () => at };
};

describe('the store of hints set aside', () => {
  it('hides a hint until its time, then not; again, the later time holds', () => {
    const { hints } = setup();
    hints.notNow({ key: 'feature:mail', label: 'Connect your mail', until: 100, at: 10 });
    expect(hints.hides('feature:mail', 99)).toBe(true);
    expect(hints.hides('feature:mail', 100)).toBe(false);
    expect(hints.hides('feature:calendar', 50)).toBe(false);
    hints.notNow({ key: 'feature:mail', label: 'Connect your mail', until: 300, at: 20 });
    expect(hints.hides('feature:mail', 200)).toBe(true);
    expect(hints.list(150, 10)).toEqual([{ key: 'feature:mail', label: 'Connect your mail', until: 300 }]);
  });

  it('lists the ones set aside now, the latest first, and brings one back at once', () => {
    const { hints } = setup();
    hints.notNow({ key: 'thing:passport', label: 'Add a Passport', until: 500, at: 1 });
    hints.notNow({ key: 'offer:pack:rental-book', label: 'Get Rental Book', until: 500, at: 2 });
    hints.notNow({ key: 'feature:file', label: 'Connect your files', until: 40, at: 3 });
    expect(hints.list(50, 10).map((row) => row.key)).toEqual(['offer:pack:rental-book', 'thing:passport']);
    expect(hints.restore('thing:passport')).toBe(true);
    expect(hints.restore('thing:passport')).toBe(false);
    expect(hints.hides('thing:passport', 50)).toBe(false);
    expect(hints.list(50, 1).map((row) => row.key)).toEqual(['offer:pack:rental-book']);
  });

  it('keeps it across a restart of the server', () => {
    const { db, hints } = setup();
    hints.notNow({ key: 'feature:mail', label: 'Connect your mail', until: 900, at: 1 });
    expect(createChatHintStore(db).hides('feature:mail', 500)).toBe(true);
  });
});

describe('chat.hints.*', () => {
  it('"Not now" holds for the days it says, from now, and is audited; the list says so', () => {
    const { deps, logActivity, now } = setup();
    const set = handleHintNotNow(deps, { key: 'feature:mail', label: '  Connect your mail ' });
    expect(set).toEqual({ key: 'feature:mail', label: 'Connect your mail', until: now() + CHAT_HINT_NOT_NOW_MS });
    expect(handleHintsList(deps)).toEqual({ not_now: [set] });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'chat_hint_not_now' }));
  });

  it('a hint set aside comes back on its own after 30 days, or at once with "Show it again"', () => {
    const { deps, later, logActivity } = setup();
    handleHintNotNow(deps, { key: 'thing:passport', label: 'Add a Passport' });
    later(29 * DAY);
    expect(handleHintsList(deps).not_now.map((row) => row.key)).toEqual(['thing:passport']);
    later(2 * DAY);
    expect(handleHintsList(deps).not_now).toEqual([]);
    handleHintNotNow(deps, { key: 'thing:passport', label: 'Add a Passport' });
    expect(handleHintRestore(deps, { key: 'thing:passport' })).toEqual({ restored: true });
    expect(handleHintsList(deps).not_now).toEqual([]);
    expect(handleHintRestore(deps, { key: 'thing:passport' })).toEqual({ restored: false });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'chat_hint_restored' }));
  });

  it('⛔ refuses a key no hint has (a switch, a run\'s need) and a label that says nothing', () => {
    const { deps, hints } = setup();
    for (const args of [{ key: 'switch:data.task', label: 'x' }, { key: 'feature:contacts', label: 'x' }, { key: 'feature:mail', label: '  ' },
      { key: 'feature:mail' }, null, 'feature:mail']) {
      expect(() => handleHintNotNow(deps, args)).toThrow(RpcError);
    }
    expect(() => handleHintRestore(deps, { key: '../x' })).toThrow(RpcError);
    expect(hints.list(0, 10)).toEqual([]);
  });

  it('says when the server is not wired for it', () => {
    const deps = { store: {} as never } as unknown as ChatRpcDeps;
    expect(() => handleHintsList(deps)).toThrow(/not wired/u);
    expect(() => handleHintNotNow(deps, { key: 'feature:mail', label: 'x' })).toThrow(/not wired/u);
    expect(() => handleHintRestore(deps, { key: 'feature:mail' })).toThrow(/not wired/u);
  });
});
