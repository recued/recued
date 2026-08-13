/** D-157 N.8 — stale-checkpoint retention sweep.
 *
 *  Pins the two halves of `createCheckpointRetention` (the days-scale
 *  staleness guard for `awaiting_approval` runs + the fixed-grace
 *  garbage collection of orphaned / terminal / superseded rows), the
 *  never-drop-a-decision invariants (answered ask defers forever; a
 *  batch-registered hold is never expired through its member pointer —
 *  the codex BLOCKER 1 fold), the crash-convergence branches, and the
 *  zombie-prompt-close scoping (terminal anchors only — a superseded
 *  awaiting anchor's `ask_id` belongs to the live newer pause). */

import type { Checkpoint } from '@recued/contracts';
import {
  buildAuditEntry,
  createAuditLogStore,
  createCheckpointStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type Collection,
} from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';

import {
  createCheckpointRetention,
  GARBAGE_GRACE_MS,
  type CheckpointRetentionAskHooks,
} from '../checkpoint-retention.js';

const NOW = Date.parse('2026-06-10T18:00:00.000Z');
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;

const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'cp-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: 'gated_step',
  step_state: { earlier: 'output' },
  created_at: NOW - (WINDOW_DAYS + 1) * DAY_MS,
  ...overrides,
});

const anchor = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  ...buildAuditEntry({
    recipe_id: 'recipe-1',
    recipe_hash: 'hash-1',
    commit_status: 'awaiting_approval',
    duration_ms: 50,
    errors: [],
    config_snapshot: { threshold: 7 },
    trigger_url: null,
    trigger_source: 'manual',
    instance_id: 'server-1',
    run_id: 'run-1',
    now: NOW - (WINDOW_DAYS + 1) * DAY_MS,
    checkpoint_id: 'cp-1',
    ask_id: 'ask-1',
  }),
  ...overrides,
});

interface Harness {
  retention: ReturnType<typeof createCheckpointRetention>;
  checkpointStore: ReturnType<typeof createCheckpointStore>;
  auditLog: ReturnType<typeof createAuditLogStore>;
  activities: Collection<ActivityEntry>;
  getAsk: ReturnType<typeof vi.fn>;
  cancelAsk: ReturnType<typeof vi.fn>;
  anchorGetSpy: ReturnType<typeof vi.fn>;
}

const harness = (opts: {
  ask?: { status: 'open' | 'answered' | 'handled'; handler_payload?: Record<string, unknown> } | null;
  cancelOutcome?: 'cancelled' | 'not_open';
  askHooks?: CheckpointRetentionAskHooks | 'absent';
  staleAfterDays?: number | null;
  onExpired?: (entry: AuditEntry) => Promise<void> | void;
} = {}): Harness => {
  const entries = createInMemoryCollection<AuditEntry>();
  const activities = createInMemoryCollection<ActivityEntry>();
  const auditLog = createAuditLogStore(entries, activities);
  const anchorGetSpy = vi.fn(auditLog.get.bind(auditLog));
  const spiedAuditLog = { ...auditLog, get: anchorGetSpy };
  const checkpointStore = createCheckpointStore(
    createInMemoryCollection<Checkpoint>(),
  );
  const getAsk = vi.fn().mockResolvedValue(
    opts.ask === undefined
      ? { status: 'open', handler_payload: {} }
      : opts.ask,
  );
  const cancelAsk = vi.fn().mockResolvedValue(opts.cancelOutcome ?? 'cancelled');
  const askHooks: CheckpointRetentionAskHooks | undefined =
    opts.askHooks === 'absent'
      ? undefined
      : opts.askHooks ?? { getAsk, cancelAsk };
  const retention = createCheckpointRetention({
    checkpointStore,
    auditLog: spiedAuditLog,
    ...(askHooks !== undefined ? { askHooks } : {}),
    now: () => NOW,
    config: () => ({
      staleAfterDays:
        opts.staleAfterDays === undefined ? WINDOW_DAYS : opts.staleAfterDays,
    }),
    ...(opts.onExpired ? { onExpired: opts.onExpired } : {}),
  });
  return {
    retention,
    checkpointStore,
    auditLog: spiedAuditLog,
    activities,
    getAsk,
    cancelAsk,
    anchorGetSpy,
  };
};

const seed = async (
  h: Harness,
  checkpoints: Checkpoint[],
  anchors: AuditEntry[],
): Promise<void> => {
  for (const cp of checkpoints) await h.checkpointStore.write(cp);
  for (const a of anchors) await h.auditLog.append(a);
};

describe('checkpoint-retention — staleness guard', () => {
  it('notifies an additive observer only after the terminal row and checkpoint deletion', async () => {
    let h: Harness;
    const onExpired = vi.fn(async (entry: AuditEntry) => {
      expect(entry.commit_status).toBe('failed');
      expect(entry.errors?.[0]?.code).toBe('RECIPE_APPROVAL_TIMEOUT');
      expect(await h.checkpointStore.get('cp-1')).toBeNull();
      expect((await h.auditLog.get('run-1'))?.commit_status).toBe('failed');
    });
    h = harness({ onExpired });
    await seed(h, [checkpoint()], [anchor()]);

    await expect(h.retention.run()).resolves.toMatchObject({ expired: 1 });
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('expires a stale awaiting run: cancels the ask, retires the anchor, deletes the checkpoint, logs one reserve activity', async () => {
    const h = harness();
    const original = anchor();
    await seed(h, [checkpoint()], [original]);

    const result = await h.retention.run();

    expect(result).toMatchObject({
      inspected: 1,
      expired: 1,
      garbage_collected: 0,
      deferred: 0,
      failed: 0,
    });
    expect(h.cancelAsk).toHaveBeenCalledTimes(1);
    expect(h.cancelAsk).toHaveBeenCalledWith('ask-1');
    expect(await h.checkpointStore.get('cp-1')).toBeNull();

    const retired = await h.auditLog.get('run-1');
    expect(retired?.commit_status).toBe('failed');
    expect(retired?.errors?.[0]?.code).toBe('RECIPE_APPROVAL_TIMEOUT');
    expect(retired?.errors?.[0]?.retryable).toBe(false);
    expect(retired?.errors?.[0]?.details).toMatchObject({
      checkpoint_id: 'cp-1',
      ask_id: 'ask-1',
      stale_after_days: WINDOW_DAYS,
    });
    // duration spans original start → expiry, so `buildAuditEntry`
    // reproduces the original started_at exactly (the deny-row shape).
    expect(retired?.started_at).toBe(original.started_at);
    expect(retired?.finished_at).toBe(NOW);
    // Terminal row drops the pause pointers, mirroring denyRun.
    expect(retired?.checkpoint_id).toBeUndefined();
    expect(retired?.ask_id).toBeUndefined();
    expect(retired?.recipe_hash).toBe(original.recipe_hash);
    expect(retired?.config_snapshot).toEqual(original.config_snapshot);

    const acts = await h.activities.list();
    expect(acts).toHaveLength(1);
    expect(acts[0]?.action).toBe('checkpoint_retention_prune');
    expect(acts[0]?.detail).toContain('expired=1');
  });

  it('NEVER expires an answered ask, regardless of age — the answer path owns the checkpoint', async () => {
    const h = harness({ ask: { status: 'answered', handler_payload: {} } });
    await seed(
      h,
      [checkpoint({ created_at: NOW - 400 * DAY_MS })],
      [anchor()],
    );

    const result = await h.retention.run();

    expect(result.deferred).toBe(1);
    expect(result.expired).toBe(0);
    expect(h.cancelAsk).not.toHaveBeenCalled();
    expect(await h.checkpointStore.get('cp-1')).not.toBeNull();
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe(
      'awaiting_approval',
    );
    expect(await h.activities.list()).toHaveLength(0);
  });

  it('defers when an answer wins the cancel race (cancelAsk → not_open)', async () => {
    const h = harness({ cancelOutcome: 'not_open' });
    await seed(h, [checkpoint()], [anchor()]);

    const result = await h.retention.run();

    expect(result.deferred).toBe(1);
    expect(result.expired).toBe(0);
    expect(await h.checkpointStore.get('cp-1')).not.toBeNull();
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe(
      'awaiting_approval',
    );
  });

  it('proceeds past a handled ask (crash-after-cancel convergence)', async () => {
    const h = harness({ ask: { status: 'handled', handler_payload: {} } });
    await seed(h, [checkpoint()], [anchor()]);

    const result = await h.retention.run();

    expect(result.expired).toBe(1);
    expect(h.cancelAsk).not.toHaveBeenCalled();
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe('failed');
  });

  it('proceeds when the ask row is missing (no live answer path can start)', async () => {
    const h = harness({ ask: null });
    await seed(h, [checkpoint()], [anchor()]);

    const result = await h.retention.run();

    expect(result.expired).toBe(1);
    expect(h.cancelAsk).not.toHaveBeenCalled();
  });

  it('codex BLOCKER 1 fold — a batch-registered hold is deferred unconditionally, never expired through its member pointer', async () => {
    // A join re-render leaves older members pointing at the superseded
    // (cancelled → handled) ask while the LIVE batch ask still covers
    // them — `handled` here proves nothing about the live prompt.
    const h = harness({
      ask: {
        status: 'handled',
        handler_payload: { batch_id: 'batch-1', payload_version: 2 },
      },
    });
    await seed(h, [checkpoint({ created_at: NOW - 400 * DAY_MS })], [anchor()]);

    const result = await h.retention.run();

    expect(result.deferred).toBe(1);
    expect(result.expired).toBe(0);
    expect(h.cancelAsk).not.toHaveBeenCalled();
    expect(await h.checkpointStore.get('cp-1')).not.toBeNull();
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe(
      'awaiting_approval',
    );
  });

  it('expires without ask bookkeeping when the anchor carries no ask_id (raise failed)', async () => {
    const base = buildAuditEntry({
      recipe_id: 'recipe-1',
      recipe_hash: 'hash-1',
      commit_status: 'awaiting_approval',
      duration_ms: 50,
      errors: [],
      config_snapshot: {},
      trigger_url: null,
      trigger_source: 'manual',
      instance_id: 'server-1',
      run_id: 'run-1',
      now: NOW - (WINDOW_DAYS + 1) * DAY_MS,
      checkpoint_id: 'cp-1',
      // no ask_id
    });
    const h = harness();
    await seed(h, [checkpoint()], [base]);

    const result = await h.retention.run();

    expect(result.expired).toBe(1);
    expect(h.getAsk).not.toHaveBeenCalled();
    expect(h.cancelAsk).not.toHaveBeenCalled();
    const retired = await h.auditLog.get('run-1');
    expect(retired?.commit_status).toBe('failed');
    // `errors` is optional since 2026-08-05 (the write path omits it when
    // empty), so assert the retirement error EXISTS before asserting what its
    // details lack — a bare `?.details` would satisfy `.not.toHaveProperty`
    // against `undefined` and pass with no error recorded at all.
    expect(retired?.errors?.[0]).toBeDefined();
    expect(retired?.errors?.[0]?.details).not.toHaveProperty('ask_id');
  });

  it('D-210 Phase C — a PARTY-OWNED (notify-mode reception) hold expires the same way', async () => {
    // ⚠ WHY THIS EXISTS. The sibling test above pins the same behavior under the
    // reason "(raise failed)" — i.e. ask-less anchors were understood as DAMAGE.
    // Phase C added a SECOND, DELIBERATE producer of them: with
    // `inbox_fanout_mode: 'notify'` a reception hold is never given a durable
    // ask, and the webclient inbox owns its lifecycle instead. Without this
    // test the suite reads as if the deliberate case were never considered, and
    // the next reader would take an expiring reception hold for a bug.
    //
    // ⛔ AND EXPIRING IT IS CORRECT, deliberately:
    //   - the deferral checks above all protect ASK bookkeeping (a batch's
    //     member lifecycle, an answered-but-undispatched ask, an open-cancel
    //     race). An ask-less hold has none of that to protect, so there is
    //     nothing to defer TO.
    //   - staleness is ORIGIN-INDEPENDENT product policy, not a technical
    //     timeout: `preflight.stale_after_days` is documented as the guard
    //     against "an approval clicked months later firing into a changed
    //     world". A reception submission is exactly that risk, not an exception
    //     to it — it comes from a stranger.
    //   - the owner already controls it: `stale_after_days = 0` means wait
    //     forever. Hard-coding a never-expire rule for one party would REMOVE
    //     that choice, and would grow checkpoints holding visitor PII without
    //     bound (the Reception inbox implements no expiry of its own —
    //     `purgeReceptionInboxSubview` purges post-decision subview rows and
    //     has no production caller).
    const base = buildAuditEntry({
      recipe_id: 'recued-core/reception-intake-review-then-approve-intake-materialize-1',
      recipe_hash: 'hash-1',
      commit_status: 'awaiting_approval',
      duration_ms: 50,
      errors: [],
      config_snapshot: {},
      trigger_url: null,
      trigger_source: 'reactive',
      instance_id: 'server-1',
      run_id: 'run-1',
      now: NOW - (WINDOW_DAYS + 1) * DAY_MS,
      checkpoint_id: 'cp-1',
      // Reception origin — the party that owns this hold's lifecycle.
      execution_source: {
        channel: 'reactive',
        actor: 'system',
        event_kind: 'composition.reception_form_submission',
        source_recipe:
          'recued-core/reception-intake-review-then-approve-intake-materialize-1',
      },
      // No ask_id — DELIBERATE here, not a failed raise.
    });
    const h = harness();
    await seed(h, [checkpoint()], [base]);

    const result = await h.retention.run();

    expect(result.expired).toBe(1);
    expect(result.deferred).toBe(0);
    // No ask existed, so no ask bookkeeping is touched on the way out.
    expect(h.getAsk).not.toHaveBeenCalled();
    expect(h.cancelAsk).not.toHaveBeenCalled();
    // The run reaches a terminal status — which is what lets audit-retention
    // ever prune it (awaiting anchors are exempt from both of its passes).
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe('failed');
  });

  it('D-210 Phase C — stale_after_days = 0 keeps a party-owned hold waiting forever', async () => {
    // The owner's actual control over the above. If this ever stops holding,
    // the "just set it to 0" answer to "my reception holds expire" is a lie.
    const base = buildAuditEntry({
      recipe_id: 'recued-core/reception-intake-review-then-approve-intake-materialize-1',
      recipe_hash: 'hash-1',
      commit_status: 'awaiting_approval',
      duration_ms: 50,
      errors: [],
      config_snapshot: {},
      trigger_url: null,
      trigger_source: 'reactive',
      instance_id: 'server-1',
      run_id: 'run-1',
      now: NOW - (WINDOW_DAYS + 1000) * DAY_MS,
      checkpoint_id: 'cp-1',
    });
    // `0` collapses to `null` at the composer (`wire-retention-pruners.ts`).
    const h = harness({ staleAfterDays: null });
    await seed(h, [checkpoint()], [base]);

    const result = await h.retention.run();

    expect(result.expired).toBe(0);
    expect(await h.checkpointStore.get('cp-1')).not.toBeNull();
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe(
      'awaiting_approval',
    );
  });

  it('expires when askHooks are absent entirely (db-less posture — no answer path exists)', async () => {
    const h = harness({ askHooks: 'absent' });
    await seed(h, [checkpoint()], [anchor()]);

    const result = await h.retention.run();

    expect(result.expired).toBe(1);
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe('failed');
  });

  it('TOCTOU re-check: a checkpoint consumed between the anchor read and the append defers — no expiry row over a finished run', async () => {
    const h = harness();
    await seed(h, [checkpoint()], [anchor()]);
    // The answer path completes while the sweep is between reads: by
    // the time getAsk resolves, the checkpoint is consumed.
    h.getAsk.mockImplementation(async () => {
      await h.checkpointStore.delete('cp-1');
      return { status: 'handled', handler_payload: {} };
    });

    const result = await h.retention.run();

    expect(result.deferred).toBe(1);
    expect(result.expired).toBe(0);
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe(
      'awaiting_approval',
    );
  });

  it('treats an awaiting anchor with checkpoint_id undefined as current (expiry eligible)', async () => {
    const base = anchor();
    delete (base as { checkpoint_id?: string }).checkpoint_id;
    const h = harness();
    await seed(h, [checkpoint()], [base]);

    const result = await h.retention.run();

    expect(result.expired).toBe(1);
  });

  it('guard off (staleAfterDays null): stale awaiting rows untouched at any age', async () => {
    const h = harness({ staleAfterDays: null });
    await seed(h, [checkpoint({ created_at: NOW - 400 * DAY_MS })], [anchor()]);

    const result = await h.retention.run();

    expect(result).toMatchObject({ inspected: 1, expired: 0, deferred: 0 });
    expect(await h.checkpointStore.get('cp-1')).not.toBeNull();
  });
});

describe('checkpoint-retention — garbage collection', () => {
  const GARBAGE_AGE = GARBAGE_GRACE_MS + 3_600_000; // 25h

  it('deletes an orphaned checkpoint (no anchor) past the grace', async () => {
    const h = harness();
    await seed(h, [checkpoint({ created_at: NOW - GARBAGE_AGE })], []);

    const result = await h.retention.run();

    expect(result.garbage_collected).toBe(1);
    expect(h.cancelAsk).not.toHaveBeenCalled();
    expect(await h.checkpointStore.get('cp-1')).toBeNull();
  });

  it('⛔⛔ NEVER SWEEPS A RUN HELD FOR A PEER — D-234 § 234.4', async () => {
    // THE LANDMINE THIS SECTION SHIPPED WITH, HAD IT NOT BEEN CAUGHT. The garbage
    // branch classified any anchor whose status was not literally
    // `'awaiting_approval'` as crash residue and deleted its checkpoint. A run
    // suspended waiting on a PEER'S owner is held, not residue — and a peer
    // review legitimately outlives the 24h grace many times over. Left alone
    // this deleted the checkpoint and destroyed the run, silently, and no
    // existing fixture writes the status so nothing would have gone red.
    //
    // ⚠ The age is deliberately WELL past the garbage grace: the whole point is
    // that a peer hold is allowed to be old.
    const h = harness();
    await seed(
      h,
      [checkpoint({ created_at: NOW - GARBAGE_AGE })],
      [anchor({ commit_status: 'awaiting_peer' })],
    );

    const result = await h.retention.run();

    expect(result.garbage_collected).toBe(0);
    // And its prompt is untouched — the ask is live on ANOTHER server.
    expect(h.cancelAsk).not.toHaveBeenCalled();
    expect(await h.checkpointStore.get('cp-1')).not.toBeNull();
  });

  it('deletes a terminal-anchor checkpoint past the grace and closes its zombie prompt', async () => {
    const h = harness();
    await seed(
      h,
      [checkpoint({ created_at: NOW - GARBAGE_AGE })],
      [anchor({ commit_status: 'succeeded' })],
    );

    const result = await h.retention.run();

    expect(result.garbage_collected).toBe(1);
    expect(h.cancelAsk).toHaveBeenCalledTimes(1);
    expect(h.cancelAsk).toHaveBeenCalledWith('ask-1');
    expect(await h.checkpointStore.get('cp-1')).toBeNull();
  });

  it('deletes a SUPERSEDED checkpoint without touching the ask — the anchor ask_id belongs to the live newer pause', async () => {
    const h = harness();
    await seed(
      h,
      [checkpoint({ created_at: NOW - GARBAGE_AGE })],
      [anchor({ checkpoint_id: 'cp-NEWER', ask_id: 'ask-live' })],
    );

    const result = await h.retention.run();

    expect(result.garbage_collected).toBe(1);
    expect(h.cancelAsk).not.toHaveBeenCalled();
    expect(await h.checkpointStore.get('cp-1')).toBeNull();
    // The live pause's anchor is untouched.
    expect((await h.auditLog.get('run-1'))?.commit_status).toBe(
      'awaiting_approval',
    );
  });

  it('leaves all garbage classes alone inside the grace window', async () => {
    const FRESH = NOW - 2 * 3_600_000; // 2h
    const h = harness();
    await seed(
      h,
      [
        checkpoint({ checkpoint_id: 'cp-orphan', run_id: 'run-orphan', created_at: FRESH }),
        checkpoint({ checkpoint_id: 'cp-term', run_id: 'run-term', created_at: FRESH }),
      ],
      [
        anchor({
          run_id: 'run-term',
          commit_status: 'succeeded',
          checkpoint_id: 'cp-term',
        }),
      ],
    );

    const result = await h.retention.run();

    expect(result.garbage_collected).toBe(0);
    expect(await h.checkpointStore.get('cp-orphan')).not.toBeNull();
    expect(await h.checkpointStore.get('cp-term')).not.toBeNull();
  });

  it('garbage collection runs even with the staleness guard off', async () => {
    const h = harness({ staleAfterDays: null });
    await seed(
      h,
      [checkpoint({ created_at: NOW - GARBAGE_AGE })],
      [anchor({ commit_status: 'failed' })],
    );

    const result = await h.retention.run();

    expect(result.garbage_collected).toBe(1);
    expect(await h.checkpointStore.get('cp-1')).toBeNull();
  });
});

describe('checkpoint-retention — pass mechanics', () => {
  it('fast path: a fresh checkpoint below every threshold (under the grace) never reads its anchor', async () => {
    const h = harness();
    await seed(h, [checkpoint({ created_at: NOW - 2 * 3_600_000 })], [anchor()]);

    const result = await h.retention.run();

    expect(result).toMatchObject({ inspected: 1, expired: 0, deferred: 0 });
    expect(h.anchorGetSpy).not.toHaveBeenCalled();
  });

  it('coalesces concurrent run() calls into one in-flight pass', async () => {
    const h = harness();
    await seed(h, [checkpoint()], [anchor()]);

    const [r1, r2] = await Promise.all([h.retention.run(), h.retention.run()]);

    expect(r1).toBe(r2);
    expect(r1.expired).toBe(1);
    // One pass, one activity row.
    expect(await h.activities.list()).toHaveLength(1);
  });

  it('a list() failure resolves to an empty result instead of throwing', async () => {
    const h = harness();
    const broken = createCheckpointRetention({
      checkpointStore: {
        ...h.checkpointStore,
        list: () => Promise.reject(new Error('disk gone')),
      },
      auditLog: h.auditLog,
      now: () => NOW,
      config: () => ({ staleAfterDays: WINDOW_DAYS }),
    });

    const result = await broken.run();

    expect(result).toMatchObject({ inspected: 0, expired: 0, failed: 0 });
  });

  it('runSafe returns null and logs an error activity when the pass itself throws', async () => {
    const h = harness();
    const broken = createCheckpointRetention({
      checkpointStore: h.checkpointStore,
      auditLog: h.auditLog,
      now: () => NOW,
      config: () => {
        throw new Error('config store gone');
      },
    });

    expect(await broken.runSafe()).toBeNull();
    const acts = await h.activities.list();
    expect(acts).toHaveLength(1);
    expect(acts[0]?.action).toBe('checkpoint_retention_prune');
    expect(acts[0]?.detail).toContain('error:');
  });

  it('a per-row failure is counted and the pass continues to the next row', async () => {
    const h = harness();
    await seed(
      h,
      [
        checkpoint({ checkpoint_id: 'cp-bad', run_id: 'run-bad' }),
        checkpoint({ checkpoint_id: 'cp-good', run_id: 'run-good' }),
      ],
      [
        anchor({ run_id: 'run-bad', checkpoint_id: 'cp-bad' }),
        anchor({ run_id: 'run-good', checkpoint_id: 'cp-good' }),
      ],
    );
    h.cancelAsk
      .mockRejectedValueOnce(new Error('channel exploded'))
      .mockResolvedValueOnce('cancelled');

    const result = await h.retention.run();

    expect(result.failed).toBe(1);
    expect(result.expired).toBe(1);
    expect(await h.checkpointStore.get('cp-bad')).not.toBeNull();
    expect(await h.checkpointStore.get('cp-good')).toBeNull();
  });
});
