/** ⛔⛔⛔ THE OWNER'S APPROVAL QUEUE WAS A BOUNDED SCAN OVER A SHARED WINDOW, SO
 *  ORDINARY TRAFFIC COULD PUSH A HELD APPROVAL OUT OF IT. **FIXED 2026-08-21**;
 *  this file is now the regression pin. The defect, kept because it is the
 *  reason the fix has the shape it does:
 *
 *  `queryReceptionInboxHeldOps` is how the owner sees reception actions waiting
 *  on them. The audit store had no "list by `commit_status`" query, so the
 *  enumeration was an APP-SIDE FILTER over `listRecent(scanLimit)`,
 *  `DEFAULT_SCAN_LIMIT = 1000`. And `listRecent` with no `origin_actors` is
 *  GLOBAL: `audit.ts` sorts EVERY audit entry newest-first and slices the top N.
 *  Every run of every kind wrote into that one window — including read-only
 *  renders, which write a `succeeded` anchor gated by nothing
 *  (`execute-handler.ts`, written whenever `deps.auditLog &&
 *  !result.trigger_skipped`).
 *
 *  ⇒ A held approval did not expire, get denied, or error. It stopped being
 *  ENUMERATED, silently, because 1000 newer rows arrived. Nothing reported it:
 *  the query succeeded and returned a shorter list.
 *
 *  🔑 THIS WAS NEVER A QUOTA STORY. Audit eviction is a separate, documented
 *  mechanism with a reserve floor. This fired long before any prune, at full
 *  retention, with the row still present and readable — which is exactly why
 *  reading the retention code would not surface it.
 *
 *  ⚠ MAGNITUDE, so nobody over- or under-reacts. 1000 rows is a lot of
 *  interactive clicking. It is NOT a lot of polling: a 30-second auto-refresh on
 *  one open tab is ~120 anchors/hour and cleared the window in about eight hours.
 *
 *  ── THE FIX ──────────────────────────────────────────────────────────────
 *  `AuditLogStore.listByCommitStatus(status, limit)` — the query the store
 *  lacked — and the queue now reads `('awaiting_approval', scanLimit)`. The
 *  window is scoped to the STATUS, so only other rows in the same state
 *  compete.
 *
 *  ⛔ NOT "raise the limit". A bigger shared window postpones the identical
 *  silent eviction and makes the arithmetic harder to reason about; "1000
 *  simultaneous PENDING APPROVALS" is a situation the owner can actually see,
 *  where "1000 recent runs of any kind" is not. Indexed via `ensureFieldIndexes
 *  (['commit_status'])` where the backing supports it, so the read is bounded
 *  by matches rather than table size.
 *
 *  ⚠ THREE OF THE FIVE ORIGINAL CASES WENT VACUOUS THE MOMENT IT WAS FIXED —
 *  they pinned the arithmetic of the eviction (the exact boundary, and that a
 *  wider scan brings the row back), and with no eviction they pass for a reason
 *  they no longer describe. They are rewritten below rather than left green: a
 *  test that survives its own defect's removal without changing is measuring
 *  nothing, which is the failure this file was written to catch elsewhere.
 */import { describe, expect, it } from 'vitest';

import type { Checkpoint, ExecutionSource } from '@recued/contracts';
import {
  createAuditLogStore,
  createCheckpointStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';

import {
  defaultIsReceptionOriginAnchor,
  queryReceptionInboxHeldOps,
  type ReceptionInboxDeps,
  type ResolvedInboxSource,
} from '../reception-inbox-handler.js';

const NOW = 1_700_000_000_000;

/** The real production default, pinned. If this constant moves, the arithmetic
 *  in this file's header is wrong and the test should be re-read, not re-tuned. */
const PRODUCTION_SCAN_LIMIT = 1000;

const receptionSource: ExecutionSource = {
  channel: 'reactive',
  actor: 'system',
  event_kind: 'reception.intake_form.submitted',
  source_recipe: 'recued-core/reception-intake-incoming',
};

/** An owner opening a list on their own machine — the REAL shape, copied from
 *  `buildRpcUserExecutionSource` (`execute-handler.ts`), which is what a
 *  webclient rpc dispatch actually carries. `succeeded`, contract-free,
 *  first-person: the least remarkable row the system can write, which is the
 *  point — it is not misbehaviour that buries the approval, it is normal use.
 *
 *  ⚠ The channel is `'user'`, NOT `'webclient'`. There is no `'webclient'`
 *  member of `Channel`; `records-pack-harness.ts` defaults to that string and
 *  only survives because it casts through `as never as ExecutionContext`. Typing
 *  this fixture honestly is what caught it — copy from the producer, not from
 *  another test's fixture. */
const renderSource: ExecutionSource = {
  channel: 'user', actor: 'user_self',
  user_id: 'local-owner', client_token_id: 'client-1',
};

const anchor = (o: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: 'run-held', recipe_id: 'recued-core/reception-intake-incoming',
  recipe_hash: 'hash-1', started_at: NOW, finished_at: NOW, duration_ms: 0,
  commit_status: 'awaiting_approval', config_snapshot: {}, errors: [],
  trigger_url: null, trigger_source: 'reactive', instance_id: null,
  execution_source: receptionSource, ask_id: 'ask-1', checkpoint_id: 'cp-1', ...o,
});

const checkpoint = (o: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'cp-1', run_id: 'run-held',
  recipe_id: 'recued-core/reception-intake-incoming', recipe_hash: 'hash-1',
  gated_step_id: 'create', step_state: {}, created_at: NOW,
  ...o,
} as Checkpoint);

const source: ResolvedInboxSource = {
  source: { kind: 'form_response', id: 'sub-1' },
  preview: { fields: [] },
} as never as ResolvedInboxSource;

const makeDeps = (scanLimit?: number) => {
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );
  const checkpointStore = createCheckpointStore(createInMemoryCollection<Checkpoint>());
  const deps = {
    auditLog, checkpointStore,
    resolveArgEditSchema: async () => ({ editable: [] }),
    resolveSource: async () => source,
    isReceptionOrigin: defaultIsReceptionOriginAnchor,
    submitAnswer: async () => undefined,
    subviewStore: { get: async () => undefined, put: async () => undefined,
      delete: async () => undefined },
    broadcast: () => {},
    now: () => NOW,
    ...(scanLimit === undefined ? {} : { scanLimit }),
  } as never as ReceptionInboxDeps;
  return { deps, auditLog, checkpointStore };
};

/** N ordinary successful runs, each NEWER than the held approval. */
const flood = async (
  auditLog: ReturnType<typeof makeDeps>['auditLog'], n: number,
): Promise<void> => {
  for (let i = 1; i <= n; i += 1) {
    await auditLog.append(anchor({
      run_id: `render-${i}`,
      recipe_id: 'recued-core/list-jobs',
      commit_status: 'succeeded',
      execution_source: renderSource,
      started_at: NOW + i,
      finished_at: NOW + i,
      ask_id: undefined,
      checkpoint_id: undefined,
    }));
  }
};

describe('the approval queue is scoped to the status, not to a shared window', () => {
  it('⚠ CONTROL: the held approval is enumerated when the window is quiet', async () => {
    // PROVE THE SIGNAL BEFORE THE CANDIDATE. Without this, "the queue is empty"
    // below could mean the fixture never produced a visible hold at all, and the
    // test would pass while demonstrating nothing.
    const { deps, auditLog, checkpointStore } = makeDeps();
    await auditLog.append(anchor());
    await checkpointStore.write(checkpoint());

    const held = await queryReceptionInboxHeldOps(deps);
    expect(held.map((h) => h.anchor.run_id)).toEqual(['run-held']);
  });

  it('🏁 THE FIX: it SURVIVES a full production window of ordinary runs', async () => {
    // The inverted assertion. This read `expect(held).toEqual([])` until
    // 2026-08-21 — the defect, driven at the REAL default rather than a
    // shrunken one, because a weakened limit proves the arithmetic and hides
    // whether the shipped number is reachable.
    const { deps, auditLog, checkpointStore } = makeDeps();
    await auditLog.append(anchor());
    await checkpointStore.write(checkpoint());
    await flood(auditLog, PRODUCTION_SCAN_LIMIT);

    const held = await queryReceptionInboxHeldOps(deps);
    expect(held.map((h) => h.anchor.run_id)).toEqual(['run-held']);
  });

  it('🔑 and at FIVE TIMES the window — the pressure no longer has a boundary', async () => {
    // Replaces the old "the boundary is EXACT — one row short and it survives"
    // case, which pinned the eviction arithmetic and became vacuous when the
    // eviction went (post-fix it survives at any flood, so it passed for a
    // reason it no longer described).
    //
    // ⛔ The point is not "a bigger number also works". It is that the result
    // is now INDEPENDENT of unrelated traffic, so there is no window threshold
    // left to pin — the difference between a raised limit and a scoped query.
    //
    // ⚠ FIVE times, not ten, and the ceiling is NOT arbitrary: at 10× this
    // flood crosses `DEFAULT_MAX_AUDIT_ENTRIES` (10_000) and the store's
    // auto-trim deletes the held anchor outright — a DIFFERENT mechanism, and
    // the one the case below pins. Writing 10× here reported "the fix does not
    // hold at scale" when what had actually happened was that a second
    // mechanism took the row. Keep this flood under the entry cap so it
    // measures the window and nothing else.
    const { deps, auditLog, checkpointStore } = makeDeps();
    await auditLog.append(anchor());
    await checkpointStore.write(checkpoint());
    await flood(auditLog, PRODUCTION_SCAN_LIMIT * 5);

    const held = await queryReceptionInboxHeldOps(deps);
    expect(held.map((h) => h.anchor.run_id)).toEqual(['run-held']);
  });

  it('🏁 and past the OLD 10k entry cap — the anchor is no longer trimmed away',
    async () => {
    // ⛔⛔ THIS CASE FOUND A SECOND, WORSE DEFECT, AND THEN CLOSED IT.
    //
    // Written first as "SEPARATE, UNFIXED": the store auto-trimmed to
    // `DEFAULT_MAX_AUDIT_ENTRIES = 10_000`, dropping the oldest non-`reserve`
    // rows — and a held run's `awaiting_approval` anchor is NOT written
    // reserve. So a hold older than the newest 10 000 entries was DELETED, not
    // merely unenumerated: strictly worse than the crowding above, because
    // crowding left the row readable (a wider scan recovered it) while this
    // removed it, orphaning the checkpoint for `checkpoint-retention` to
    // collect 24 h later.
    //
    // 🔑 THE CAP WAS ALSO MAKING THE REAL POLICY UNREACHABLE. `audit.quota.
    // bytes` defaults to 5 GB; audit rows are ~698 B; 10 000 rows is ~7 MB. The
    // count cap bound roughly 700× earlier than the quota, so the size pruner —
    // configurable, oldest-first, reserve-floor-respecting — could never fire.
    // Two retention mechanisms, and the crude one silently pre-empted the
    // designed one. The default is gone; `maxEntries` is now opt-in.
    //
    // ⚠ 12 000 is deliberately PAST the old cap. Under the old default this
    // assertion is exactly inverted, which is what makes it a regression pin
    // rather than a restatement.
    const { deps, auditLog, checkpointStore } = makeDeps();
    await auditLog.append(anchor());
    await checkpointStore.write(checkpoint());
    await flood(auditLog, 12_000);

    expect((await auditLog.listByCommitStatus('awaiting_approval', 10))
      .map((a) => a.run_id)).toEqual(['run-held']);
    const held = await queryReceptionInboxHeldOps(deps);
    expect(held.map((h) => h.anchor.run_id)).toEqual(['run-held']);
  });

  it('🔑 the result no longer depends on `scanLimit` at all', async () => {
    // Replaces "the ROW IS STILL THERE — widening the scan brings it back",
    // whose discriminator (widen the window, recover the row) only means
    // something while the window is what loses it.
    //
    // `scanLimit` is now a PAGE SIZE over matching rows, not a filter over the
    // whole log: a tiny limit and a huge one agree, because one held approval
    // is one matching row either way.
    for (const scanLimit of [1, PRODUCTION_SCAN_LIMIT * 10]) {
      const { deps, auditLog, checkpointStore } = makeDeps(scanLimit);
      await auditLog.append(anchor());
      await checkpointStore.write(checkpoint());
      await flood(auditLog, PRODUCTION_SCAN_LIMIT);

      const held = await queryReceptionInboxHeldOps(deps);
      expect(held.map((h) => h.anchor.run_id), `scanLimit=${scanLimit}`)
        .toEqual(['run-held']);
    }
  });

  it('⛔ the status scope still FILTERS — a settled run is not enumerated', async () => {
    // The other direction, and the one a scoped query could plausibly get
    // wrong. Narrowing the read to `awaiting_approval` must not widen what
    // MATCHES: a reception-origin run that already succeeded is not a pending
    // decision and must stay out of the owner's queue. Without this, a query
    // that returned every reception anchor regardless of status would pass
    // every assertion above.
    const { deps, auditLog, checkpointStore } = makeDeps();
    await auditLog.append(anchor({
      run_id: 'run-settled', commit_status: 'succeeded',
    }));
    await checkpointStore.write(checkpoint({ run_id: 'run-settled' }));

    const held = await queryReceptionInboxHeldOps(deps);
    expect(held).toEqual([]);
  });

  it('⚠ the burying rows are FIRST-PERSON READS — no misbehaviour required',
    async () => {
    // Kept verbatim from the original: it documents WHY the pressure existed at
    // all, which the fix does not make untrue. Every burying row is
    // `succeeded`, contract-free, `webclient`/`user_self` — an owner opening a
    // list. If this ever needs relaxing, the story changed.
    const { auditLog } = makeDeps();
    await flood(auditLog, 3);
    const rows = await auditLog.listRecent(10);
    expect(rows.every((r) => r.commit_status === 'succeeded'
      && r.execution_source?.channel === 'user'
      && r.execution_source?.actor === 'user_self')).toBe(true);
  });
});
