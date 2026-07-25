/** D-214 S0 — span-anchor substrate composer.
 *
 *  Two properties worth pinning, and neither is a happy path: that a dbless
 *  compose yields nothing (so "not wired" stays a working state, which §0 R4
 *  requires of an unproven feature), and that the store is constructed ONCE
 *  rather than per turn.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { composeSpanAnchor } from '../composition/bin/wire-span-anchor.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const makeDb = (): Database.Database => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  return db;
};

const testKey = (): (() => Uint8Array) => {
  const key = new Uint8Array(32);
  for (let i = 0; i < key.length; i += 1) key[i] = (i * 11 + 5) & 0xff;
  return () => key;
};

describe('D-214 span-anchor composer', () => {
  it('installs the schema and returns a usable dep bundle', async () => {
    const db = makeDb();
    const getDeps = composeSpanAnchor({
      db,
      chatKeyProvider: testKey(),
      newRootRequestId: () => 'root-1',
    });

    expect(getDeps).toBeDefined();
    const deps = getDeps!();
    await deps.store.openSpan({
      root_request_id: deps.mintRootRequestId(),
      session_id: 'sess-1',
      surface: 'chat',
      root_request: 'email Alice the Q3 report',
      turn_id: 'turn-1',
      now: 1_000,
    });

    expect(deps.store.resolveRoot('sess-1', 'turn-1')).toBe('root-1');
    expect(await deps.store.readRootRequest('root-1')).toBe(
      'email Alice the Q3 report',
    );
  });

  /** ⛔ "Not wired" is D-214's DEFAULT posture, not a degenerate case. The
   *  feature is unproven and §13 Slice 5 gates it behind a bounded experiment
   *  before default-on, so a compose that yields nothing must stay a working
   *  state — the caller passes no dep and the hook is never registered. */
  it('returns undefined with no db, so the hook is never built', () => {
    expect(
      composeSpanAnchor({ db: undefined, chatKeyProvider: testKey() }),
    ).toBeUndefined();
  });

  /** The hook calls `getDeps` once per turn. Late binding is about resolution
   *  timing, not deferred construction — the store prepares statements and
   *  installs schema in its constructor, so a per-call build would re-prepare
   *  on every message. */
  it('constructs the store once and returns the same bundle every call', () => {
    const getDeps = composeSpanAnchor({
      db: makeDb(),
      chatKeyProvider: testKey(),
    });

    const first = getDeps!();
    const second = getDeps!();
    expect(second).toBe(first);
    expect(second.store).toBe(first.store);
  });

  /** ⛔ Cross-stream continuation is deliberately UNRESOLVED in V1. Wiring a
   *  predictive resolver here would silently reverse §8.2.2's ruling: at
   *  before-turn time nothing durable separates "resumes the pending plan"
   *  from "asks something new", and guessing "continue" fails OPEN. If this
   *  ever becomes defined, it must be because a DURABLE correlation source
   *  landed — not because it looked like a gap. */
  it('wires no continuation resolver', () => {
    const getDeps = composeSpanAnchor({
      db: makeDb(),
      chatKeyProvider: testKey(),
    });

    expect(getDeps!().resolveContinuation).toBeUndefined();
  });

  it('mints distinct root ids by default', () => {
    const getDeps = composeSpanAnchor({
      db: makeDb(),
      chatKeyProvider: testKey(),
    });
    const { mintRootRequestId } = getDeps!();

    const ids = new Set([
      mintRootRequestId(),
      mintRootRequestId(),
      mintRootRequestId(),
    ]);
    expect(ids.size).toBe(3);
  });

  /** The base64 fallback exists for dbless harnesses and the pre-KeyManager
   *  boot window. It must not throw — but it is emphatically not encryption,
   *  which is why the composer's doc says so out loud. */
  it('degrades to base64 with no key provider rather than throwing', async () => {
    const getDeps = composeSpanAnchor({
      db: makeDb(),
      chatKeyProvider: undefined,
      newRootRequestId: () => 'root-1',
    });
    const deps = getDeps!();

    await deps.store.openSpan({
      root_request_id: 'root-1',
      session_id: 'sess-1',
      surface: 'chat',
      root_request: 'plaintext-ish',
      turn_id: 'turn-1',
      now: 1_000,
    });
    expect(await deps.store.readRootRequest('root-1')).toBe('plaintext-ish');
  });
});
