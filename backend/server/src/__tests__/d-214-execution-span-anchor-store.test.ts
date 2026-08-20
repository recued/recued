/** D-214 S0 — the durable root-request edge (build plan §0 R1, spec §4.2).
 *
 *  The tests that matter here are the ones about what the store REFUSES:
 *  re-rooting an anchored turn (§8.2.2) and moving a sealed prompt between
 *  roots. Both fail *open* if unenforced — they manufacture a wrong span
 *  rather than losing one — so neither is visible in a happy-path assertion.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SpanAnchorVaultLockedError,
  createExecutionSpanAnchorStore,
  type ExecutionSpanAnchorStore,
  type SpanAnchorKeyProvider,
} from '../storage/execution-span-anchor-store.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const makeStore = (
  getKey?: SpanAnchorKeyProvider,
): { db: Database.Database; store: ExecutionSpanAnchorStore } => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  return { db, store: createExecutionSpanAnchorStore(db, getKey) };
};

/** A deterministic 32-byte key. Real enough to exercise the AEAD path — the
 *  base64 fallback would hide every binding property under test. */
const testKey = (): SpanAnchorKeyProvider => {
  const key = new Uint8Array(32);
  for (let i = 0; i < key.length; i += 1) key[i] = (i * 7 + 3) & 0xff;
  return () => key;
};

const openSpan = async (
  store: ExecutionSpanAnchorStore,
  over: Partial<Parameters<ExecutionSpanAnchorStore['openSpan']>[0]> = {},
): Promise<void> =>
  store.openSpan({
    root_request_id: 'root-1',
    session_id: 'sess-1',
    surface: 'chat',
    root_request: 'email Alice the Q3 report',
    turn_id: 'turn-1',
    now: 1_000,
    ...over,
  });

describe('D-214 root-request edge — the span closure', () => {
  it('anchors the opening turn and resolves it back to its root', async () => {
    const { store } = makeStore(testKey());
    await openSpan(store);

    expect(store.resolveRoot('sess-1', 'turn-1')).toBe('root-1');
    expect(store.getAnchor('sess-1', 'turn-1')).toMatchObject({
      session_id: 'sess-1',
      turn_id: 'turn-1',
      root_request_id: 'root-1',
    });
    // The opening turn continues from nothing.
    expect(store.getAnchor('sess-1', 'turn-1')?.origin_turn_id).toBeUndefined();
  });

  /** §4.2 — "a span is a conversation, not a prompt". An approved plan
   *  re-issues on the user's NEXT message, so a span containing an approval
   *  spans several turns by construction. All of them must reach one root. */
  it('anchors continuation turns to the SAME root across an approval resume', async () => {
    const { store } = makeStore(testKey());
    await openSpan(store);

    expect(
      store.anchorTurn({
        session_id: 'sess-1',
        turn_id: 'turn-2',
        root_request_id: 'root-1',
        origin_turn_id: 'turn-1',
        now: 2_000,
      }),
    ).toBe(true);
    expect(
      store.anchorTurn({
        session_id: 'sess-1',
        turn_id: 'turn-3',
        root_request_id: 'root-1',
        origin_turn_id: 'turn-2',
        now: 3_000,
      }),
    ).toBe(true);

    expect(store.resolveRoot('sess-1', 'turn-3')).toBe('root-1');
    expect(store.listAnchors('root-1').map((a) => a.turn_id)).toEqual([
      'turn-1',
      'turn-2',
      'turn-3',
    ]);
    // Lineage is retained, not just membership — "which turn resumed which"
    // is not recoverable from the root alone once turns share it.
    expect(store.listAnchors('root-1').map((a) => a.origin_turn_id)).toEqual([
      undefined,
      'turn-1',
      'turn-2',
    ]);
  });

  it('re-opening the same root is idempotent — a retried stream cannot fork a second root', async () => {
    const { db, store } = makeStore(testKey());
    await openSpan(store);
    await openSpan(store);

    const roots = db
      .prepare('SELECT COUNT(*) AS n FROM execution_span_roots')
      .get() as { n: number };
    const anchors = db
      .prepare('SELECT COUNT(*) AS n FROM execution_span_anchors')
      .get() as { n: number };
    expect(roots.n).toBe(1);
    expect(anchors.n).toBe(1);
  });
});

describe('D-214 §8.2.2 — re-rooting is refused', () => {
  /** ⛔ The security-relevant one. Re-rooting is a FAILURE-LAUNDERING channel:
   *  "let me approach this differently" is a natural conversational move, and
   *  if it could repoint an anchored turn it would erase the negative for the
   *  flow that just failed. Re-keying fails OPEN (a wrong root manufactures a
   *  wrong case); suppression fails SAFE (a case is merely lost). */
  it('does not repoint a turn already anchored to a different root', async () => {
    const { store } = makeStore(testKey());
    await openSpan(store);
    await openSpan(store, {
      root_request_id: 'root-2',
      root_request: 'let me approach this differently',
      turn_id: 'turn-9',
      now: 5_000,
    });

    const repointed = store.anchorTurn({
      session_id: 'sess-1',
      turn_id: 'turn-1',
      root_request_id: 'root-2',
      now: 6_000,
    });

    expect(repointed).toBe(false);
    expect(store.resolveRoot('sess-1', 'turn-1')).toBe('root-1');
    expect(store.listAnchors('root-2').map((a) => a.turn_id)).toEqual([
      'turn-9',
    ]);
  });

  /** The same refusal seen from the opening path — `openSpan` on a turn that
   *  is already anchored must not silently move it either. */
  it('does not repoint an anchored turn via openSpan', async () => {
    const { store } = makeStore(testKey());
    await openSpan(store);
    await openSpan(store, {
      root_request_id: 'root-3',
      root_request: 'different ask entirely',
      turn_id: 'turn-1',
      now: 7_000,
    });

    expect(store.resolveRoot('sess-1', 'turn-1')).toBe('root-1');
  });
});

describe('D-214 root request sealing', () => {
  it('round-trips the prompt through the AEAD path', async () => {
    const { store } = makeStore(testKey());
    await openSpan(store);
    expect(await store.readRootRequest('root-1')).toBe(
      'email Alice the Q3 report',
    );
  });

  it('does not store the prompt in plaintext', async () => {
    const { db, store } = makeStore(testKey());
    await openSpan(store);
    const row = db
      .prepare(
        'SELECT root_request_encrypted FROM execution_span_roots WHERE root_request_id = ?',
      )
      .get('root-1') as { root_request_encrypted: string };
    expect(row.root_request_encrypted).not.toContain('Alice');
    // ⛔ 'Q3 report', not 'Q3'. The stored value is base64 over RANDOM
    // ciphertext, and a 2-char canary over a 64-char alphabet collides by
    // chance: measured at 1.65% per run over 200k samples, which is a red on
    // roughly one full sweep in sixty and reads as a plaintext leak. It caught
    // one on 2026-08-19 (`…aevQ3K2lErr…`). The longer fragment carries a space,
    // which base64 never emits, so it is collision-PROOF while still failing
    // the moment the plaintext is what got stored.
    expect(row.root_request_encrypted).not.toContain('Q3 report');
  });

  /** The AAD binds `(session_id, root_request_id)`. Moving a sealed prompt
   *  onto another root must fail to open — otherwise an attacker who reorders
   *  rows in the SQLite file could silently re-root a span, which is the same
   *  outcome §8.2.2 forbids, reached through storage instead of conversation. */
  it('refuses a sealed prompt moved to a different root', async () => {
    const { db, store } = makeStore(testKey());
    await openSpan(store);
    await openSpan(store, {
      root_request_id: 'root-2',
      root_request: 'unrelated',
      turn_id: 'turn-2',
      now: 2_000,
    });

    const stolen = db
      .prepare(
        'SELECT root_request_encrypted FROM execution_span_roots WHERE root_request_id = ?',
      )
      .get('root-1') as { root_request_encrypted: string };
    db.prepare(
      'UPDATE execution_span_roots SET root_request_encrypted = ? WHERE root_request_id = ?',
    ).run(stolen.root_request_encrypted, 'root-2');

    await expect(store.readRootRequest('root-2')).rejects.toThrow();
  });

  it('throws a typed locked error when the vault is locked', async () => {
    const { store } = makeStore(() => null);
    await expect(openSpan(store)).rejects.toBeInstanceOf(
      SpanAnchorVaultLockedError,
    );
  });

  /** No provider at all is the dbless-harness / pre-KeyManager window, and it
   *  must degrade rather than throw — the same discipline `chat-store` uses. */
  it('falls back to base64 when no key provider is wired', async () => {
    const { store } = makeStore();
    await openSpan(store);
    expect(await store.readRootRequest('root-1')).toBe(
      'email Alice the Q3 report',
    );
  });
});

describe('D-214 §0 R4 — removal is a DROP', () => {
  /** The additive-and-removable invariant is a BUILD CONSTRAINT, not a
   *  nicety: §13 Slice 5 gates D-214 behind a bounded experiment, and that
   *  experiment is only worth running if it is reversible. If this ever
   *  fails, someone put the edge on `chat_messages`. */
  it('owns its tables and modifies no chat table', () => {
    const { db } = makeStore(testKey());
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    expect(tables.sort()).toEqual([
      'execution_span_anchors',
      'execution_span_roots',
    ]);
  });

  it('cascades anchors away with their root', async () => {
    const { db, store } = makeStore(testKey());
    db.pragma('foreign_keys = ON');
    await openSpan(store);
    store.anchorTurn({
      session_id: 'sess-1',
      turn_id: 'turn-2',
      root_request_id: 'root-1',
      origin_turn_id: 'turn-1',
      now: 2_000,
    });

    db.prepare('DELETE FROM execution_span_roots WHERE root_request_id = ?').run(
      'root-1',
    );
    expect(store.listAnchors('root-1')).toEqual([]);
  });
});
