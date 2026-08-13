/** D-234 § 234.4n — a hold whose dish is gone.
 *
 *  ⚠ THE PROPERTY IS "THE HOLD ENDS AND THE RECIPE DOES NOT CONTINUE". Both
 *  halves matter: a sweep that only closed outbox rows would leave the anchor
 *  `awaiting_peer` forever, and one that resumed would run the rest of a deleted
 *  dish's recipe. The assertions below are about the ANCHOR and about `resume`
 *  never being reachable, not about row counts.
 */
import type { AuditEntry } from '@recued/storage';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { abandonOrphanedPeerHolds, isOrphanedHold } from '../peer-hold-abandoner.js';
import { createPeerAskOutboxStore } from '../storage/peer-ask-outbox-store.js';

const NOW = 1_700_000_000_000;

const anchorOf = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: 'run_1',
  recipe_id: 'ask-a-peer',
  recipe_hash: 'h'.repeat(8),
  commit_status: 'awaiting_peer',
  started_at: NOW - 60_000,
  duration_ms: 12,
  errors: [],
  config_snapshot: { peer_connection: 'peer-bob' },
  dish_id: 'dish_gone',
  ...over,
} as AuditEntry);

const harness = (opts: {
  rows?: { ref: string; run_id: string }[];
  anchors?: Record<string, AuditEntry | null>;
  liveDishes?: string[];
  noticeThrows?: boolean;
} = {}) => {
  const db = new Database(':memory:');
  const outbox = createPeerAskOutboxStore(db);
  for (const r of opts.rows ?? [{ ref: 'ref_1', run_id: 'run_1' }]) {
    outbox.open({
      exchange_ref: r.ref,
      run_id: r.run_id,
      gated_step_id: 'verdict',
      connection: 'peer-bob',
      label: 'review:contract',
      offered: ['yes', 'no'],
      created_at: NOW - 60_000,
    });
  }
  const appended: AuditEntry[] = [];
  const live = new Set(opts.liveDishes ?? []);
  const notifyWithdrawn = vi.fn(async () => {
    if (opts.noticeThrows === true) throw new Error('peer unreachable');
  });
  return {
    outbox,
    appended,
    notifyWithdrawn,
    auditLog: {
      get: async (run_id: string) =>
        (opts.anchors ?? { run_1: anchorOf() })[run_id] ?? null,
      append: async (e: AuditEntry) => { appended.push(e); },
    },
    dishes: { get: (id: string) => (live.has(id) ? ({ dish_id: id } as never) : null) },
    now: () => NOW,
  };
};

describe('§ 234.4n — which holds are orphaned', () => {
  const dishes = { get: (id: string) => (id === 'dish_live' ? ({} as never) : null) };

  it('⛔ NO ANCHOR ⇒ NOT A DECISION. We cannot tell whose hold it is', () => {
    expect(isOrphanedHold(null, dishes)).toBe(false);
  });

  it('⛔⛔ NO `dish_id` ⇒ NEVER ORPHANED — this is the one that would abandon everything', () => {
    // An ad-hoc run (inline recipe, chat invocation, a drive) never had a dish.
    // Reading "no dish" as "dish gone" would abandon every dishless hold on the
    // server the first time this tick ran.
    expect(isOrphanedHold(anchorOf({ dish_id: undefined }), dishes)).toBe(false);
    expect(isOrphanedHold(anchorOf({ dish_id: '' }), dishes)).toBe(false);
  });

  it('⛔⛔⛔ AN EPHEMERAL DISH ID IS NEVER ORPHANED — it was never a row', () => {
    // A manual `execute` mints `dsh:eph:<run_id>` for audit attribution only.
    // It is real, well-formed and attributable, and `dishes.get` will never find
    // it — so a sweep that asks only "is it in the store" abandons every
    // ordinary manual run's hold seconds after it is raised.
    // ⚠ THIS IS THE STATE UNIT TESTS DID NOT MODEL. The first cut had two:
    // present and absent. A live drive found the third by reddening two sections
    // that never mention dishes.
    expect(isOrphanedHold(anchorOf({ dish_id: 'dsh:eph:run_1' }), dishes)).toBe(false);
  });

  it('a live dish is not orphaned; a deleted one is', () => {
    expect(isOrphanedHold(anchorOf({ dish_id: 'dish_live' }), dishes)).toBe(false);
    expect(isOrphanedHold(anchorOf({ dish_id: 'dish_deleted' }), dishes)).toBe(true);
  });
});

describe('§ 234.4n — what abandoning does', () => {
  it('✅ retires the anchor TERMINAL and closes the row', async () => {
    const h = harness();
    const r = await abandonOrphanedPeerHolds({ ...h, log: () => {} });

    expect(r).toMatchObject({ examined: 1, orphaned: 1, abandoned: 1 });
    expect(h.outbox.get('ref_1')).toBeNull();

    // ⛔ SAME `run_id` — that is what rewrites the `awaiting_peer` row rather
    // than appending a second anchor beside it and leaving the hold standing.
    const [entry] = h.appended;
    expect(entry?.run_id).toBe('run_1');
    expect(entry?.commit_status).toBe('failed');
    expect(entry?.errors?.[0]?.code).toBe('RECIPE_HOLD_ABANDONED');
    // The trail must still say which dish and which conversation.
    expect(entry?.dish_id).toBe('dish_gone');
    expect(entry?.errors?.[0]?.details).toMatchObject({ exchange_ref: 'ref_1' });
    // Provenance is preserved: this is the same run, retired — not a new one.
    expect(entry?.recipe_id).toBe('ask-a-peer');
    expect(entry?.recipe_hash).toBe('h'.repeat(8));
  });

  it('⛔⛔ LEAVES A LIVE DISH\'S HOLD ENTIRELY ALONE', async () => {
    const h = harness({ liveDishes: ['dish_gone'] });
    const r = await abandonOrphanedPeerHolds({ ...h, log: () => {} });

    expect(r).toMatchObject({ orphaned: 0, abandoned: 0 });
    expect(h.appended).toHaveLength(0);
    expect(h.outbox.get('ref_1')).not.toBeNull();
    expect(h.notifyWithdrawn).not.toHaveBeenCalled();
  });

  it('⛔ AND A DISHLESS HOLD, which is every ad-hoc run on the server', async () => {
    const h = harness({ anchors: { run_1: anchorOf({ dish_id: undefined }) } });
    const r = await abandonOrphanedPeerHolds({ ...h, log: () => {} });

    expect(r).toMatchObject({ orphaned: 0 });
    expect(h.outbox.get('ref_1')).not.toBeNull();
  });

  it('sends the courtesy notice for the row it abandoned', async () => {
    const h = harness();
    const r = await abandonOrphanedPeerHolds({ ...h, log: () => {} });

    expect(r.noticed).toBe(1);
    expect(h.notifyWithdrawn).toHaveBeenCalledTimes(1);
    expect((h.notifyWithdrawn.mock.calls[0] as unknown[])[0])
      .toMatchObject({ exchange_ref: 'ref_1', connection: 'peer-bob' });
  });

  it('⛔⛔ AN UNREACHABLE PEER DOES NOT RESURRECT THE HOLD', async () => {
    // The whole point of ordering the local termination first. If a failed
    // notice could keep the hold open, the politeness added to stop accumulation
    // would become a new way to accumulate — a peer that is down forever means a
    // hold that is held forever.
    const h = harness({ noticeThrows: true });
    const r = await abandonOrphanedPeerHolds({ ...h, log: () => {} });

    expect(r).toMatchObject({ abandoned: 1, noticed: 0, noticeFailed: 1 });
    expect(h.outbox.get('ref_1')).toBeNull();
    expect(h.appended[0]?.commit_status).toBe('failed');
  });

  it('⚠ works with NO notifier at all — the local half is not optional', async () => {
    const h = harness();
    const r = await abandonOrphanedPeerHolds({
      outbox: h.outbox, auditLog: h.auditLog, dishes: h.dishes, now: h.now, log: () => {},
    });

    expect(r).toMatchObject({ abandoned: 1, noticed: 0, noticeFailed: 0 });
    expect(h.outbox.get('ref_1')).toBeNull();
  });

  it('one orphan does not stop the others', async () => {
    const h = harness({
      rows: [{ ref: 'ref_a', run_id: 'run_a' }, { ref: 'ref_b', run_id: 'run_b' }],
      anchors: {
        run_a: anchorOf({ run_id: 'run_a' }),
        run_b: anchorOf({ run_id: 'run_b' }),
      },
      noticeThrows: true,
    });
    const r = await abandonOrphanedPeerHolds({ ...h, log: () => {} });

    expect(r).toMatchObject({ examined: 2, orphaned: 2, abandoned: 2, noticeFailed: 2 });
    expect(h.appended.map((e) => e.run_id).sort()).toEqual(['run_a', 'run_b']);
  });

  it('names the abandonment in the activity log', async () => {
    const h = harness();
    const rows: { action: string; target: string; detail: string }[] = [];
    await abandonOrphanedPeerHolds({ ...h, logActivity: (x) => rows.push(x), log: () => {} });

    expect(rows.map((x) => x.action)).toEqual(['peer_ask_abandoned']);
    expect(rows[0]!.target).toBe('peer-bob/review:contract');
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({ dish_id: 'dish_gone' });
  });
});
