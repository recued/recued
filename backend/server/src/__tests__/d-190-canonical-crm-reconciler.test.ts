/** D-190 (generic reconciler MS4) — buildCanonicalCrmReconciler tests.
 *
 *  The generic CRM reconciler: listUpdatedSince = one canonical poll → SlimRecord
 *  per projected record; toMeta = the canonical record IS the meta; hashOf =
 *  generic FNV-1a. Verified directly AND end-to-end through the REAL
 *  `buildVendorReconciliationTask` harness + a REAL `CrmRecordMirrorStore` — so a
 *  pack CRM (Pipedrive here) mirrors EXACTLY like the bespoke hb/sf reconcilers. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';
import { composeVendorEntityScope, type ConnectionRecord, type EnrichmentScope } from '@recued/contracts';

import {
  buildCanonicalCrmReconciler,
  stableStringify,
  type CanonicalCrmSlimRecord,
  type CanonicalPollRunner,
} from '../data/canonical-crm-reconciler.js';
import type { CanonicalPollDeps, CanonicalPollOutcome } from '../watch/canonical-poll.js';
import { buildVendorReconciliationTask } from '../housekeeping/reconciliation/vendor-reconciler.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
  type CrmRecordMirrorStore,
} from '../storage/crm-record-mirror-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const PIPEDRIVE_DEAL_SCOPE = composeVendorEntityScope('pipedrive', 'deal'); // connection.api.pipedrive.deal

// A canonical projected deal record (what runCanonicalWatchPoll yields, keyed by id).
const canonicalDeal = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: `Deal ${id}`,
  stage: 'open',
  amount: 5_000,
  close_state: 'open',
  key_dates: { close_date: 1_700_000_000_000 },
  ...over,
});

const okPoll = (records: Record<string, unknown>[]): CanonicalPollOutcome => ({
  ok: true,
  records: new Map(records.map((r) => [String(r.id), r])),
  truncated: false,
  complete: true,
  skipped_no_id: 0,
});

const stubRunner = (outcome: CanonicalPollOutcome): CanonicalPollRunner => async () => outcome;

const FAKE_POLL_DEPS = {} as unknown as CanonicalPollDeps;

/** Default `getPriorHashes` for the direct tests — a cold mirror (yields all). */
const noPriorHashes = (): Map<string, string> => new Map<string, string>();

const pipedriveConn = (name = 'acme-pipedrive'): ConnectionRecord => ({
  name,
  kind: 'api',
  display_name: name,
  config: { vendor: 'pipedrive', base_url: 'https://acme.pipedrive.com' },
  auth: { type: 'bearer', token: 't' },
  enrolled_at: 1,
  updated_at: 1,
});

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

// ────────────────────────────────────────────────────────────────
// Direct unit tests
// ────────────────────────────────────────────────────────────────

describe('D-190 MS4 — buildCanonicalCrmReconciler (direct)', () => {
  it('yields a SlimRecord per polled record carrying the canonical _record', async () => {
    const recon = buildCanonicalCrmReconciler({
      vendor: 'pipedrive',
      entity: 'deal',
      pollDeps: FAKE_POLL_DEPS, getPriorHashes: noPriorHashes,
      now: () => 9_000,
      runPoll: stubRunner(okPoll([canonicalDeal('1'), canonicalDeal('2')])),
    });
    const slims = (await collect(recon.listUpdatedSince!(pipedriveConn(), 0, 200))) as CanonicalCrmSlimRecord[];
    // listUpdatedSince composes the per-connection target_id <vendor>_<entity>_<connection>_<native>
    // from the poll's RAW native id ('1'/'2') + the connection name ('acme-pipedrive').
    expect(slims.map((s) => s.id)).toEqual(['pipedrive_deal_acme-pipedrive_1', 'pipedrive_deal_acme-pipedrive_2']);
    expect(slims.every((s) => s.modified_at === 9_000)).toBe(true);
    expect(slims[0]!._record.name).toBe('Deal 1');
  });

  it('FULL walk — ignores the cursor (re-yields every record regardless)', async () => {
    const recon = buildCanonicalCrmReconciler({
      vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS, getPriorHashes: noPriorHashes,
      runPoll: stubRunner(okPoll([canonicalDeal('d1'), canonicalDeal('d2')])),
    });
    // A high cursor would suppress everything in an incremental reconciler; the
    // canonical poll is match-all, so all records still come back.
    const slims = await collect(recon.listUpdatedSince!(pipedriveConn(), 9_999_999_999_999, 200));
    expect(slims).toHaveLength(2);
  });

  it('self-filters against prior hashes — an unchanged record is skipped, a new one yields', async () => {
    const unchanged = canonicalDeal('d_same');
    const fresh = canonicalDeal('d_new');
    // Compute the canonical hash the way the reconciler does, then pretend the
    // mirror already holds it for `d_same` (but not `d_new`).
    const probe = buildCanonicalCrmReconciler({
      vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS, getPriorHashes: noPriorHashes,
      runPoll: stubRunner(okPoll([])),
    });
    const probeSlim: CanonicalCrmSlimRecord = { id: 'd_same', modified_at: 1, _record: unchanged };
    const priorHash = probe.hashOf!(probeSlim);
    const recon = buildCanonicalCrmReconciler({
      vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS,
      // The prior-hash map is keyed on the STORED (connection-qualified) target_id —
      // mirror.listSnapshotHashes returns composed ids — so the self-filter is per-connection.
      getPriorHashes: () => new Map([['pipedrive_deal_acme-pipedrive_d_same', priorHash]]),
      runPoll: stubRunner(okPoll([unchanged, fresh])),
    });
    const slims = await collect(recon.listUpdatedSince!(pipedriveConn(), 0, 200));
    expect(slims.map((s) => s.id)).toEqual(['pipedrive_deal_acme-pipedrive_d_new']); // d_same skipped (hash match)
  });

  it('toMeta = the canonical record (minus id) + the two stamping fields', () => {
    const recon = buildCanonicalCrmReconciler({
      vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS, getPriorHashes: noPriorHashes, now: () => 1_234,
      runPoll: stubRunner(okPoll([])),
    });
    const slim: CanonicalCrmSlimRecord = {
      id: 'd1', modified_at: 1, _record: canonicalDeal('d1', { name: 'Acme', amount: 42 }),
    };
    const meta = recon.toMeta!(slim);
    expect(meta.snapshot_at).toBe(1_234);
    expect(typeof meta.snapshot_hash).toBe('string');
    expect(meta.snapshot_hash).toMatch(/^fnv1a:/);
    expect(meta.name).toBe('Acme');
    expect(meta.amount).toBe(42);
    expect(meta.close_state).toBe('open');
    expect(meta.key_dates).toEqual({ close_date: 1_700_000_000_000 });
    // id is the row key, NOT a meta field (matches hb/sf projectDealMeta).
    expect(meta).not.toHaveProperty('id');
  });

  it('stamps snapshot_at/snapshot_hash LAST — a pack field named snapshot_hash can NOT shadow the computed one', () => {
    const recon = buildCanonicalCrmReconciler({
      vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS, getPriorHashes: noPriorHashes, now: () => 1_234,
      runPoll: stubRunner(okPoll([])),
    });
    // A pathological pack projects canonical fields literally named like the
    // reconciler's stamping fields (non-canonical maps_to is an install warning).
    const slim: CanonicalCrmSlimRecord = {
      id: 'd1', modified_at: 1,
      _record: { id: 'd1', name: 'Acme', snapshot_hash: 'vendor-junk', snapshot_at: 999 },
    };
    const meta = recon.toMeta!(slim);
    // The COMPUTED values win (else the self-filter compares fnv1a vs 'vendor-junk'
    // forever and storms).
    expect(meta.snapshot_hash).toMatch(/^fnv1a:/);
    expect(meta.snapshot_hash).not.toBe('vendor-junk');
    expect(meta.snapshot_at).toBe(1_234);
  });

  it('hashOf is deterministic, order-insensitive, and changes on a field change', () => {
    const recon = buildCanonicalCrmReconciler({
      vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS, getPriorHashes: noPriorHashes, runPoll: stubRunner(okPoll([])),
    });
    const a: CanonicalCrmSlimRecord = { id: 'd1', modified_at: 1, _record: { id: 'd1', name: 'Acme', stage: 'open' } };
    // Same fields, different key order + different id → SAME hash (id excluded).
    const b: CanonicalCrmSlimRecord = { id: 'd1-OTHER', modified_at: 99, _record: { stage: 'open', name: 'Acme', id: 'd1' } };
    expect(recon.hashOf!(a)).toBe(recon.hashOf!(b));
    // A changed semantic field → different hash.
    const c: CanonicalCrmSlimRecord = { id: 'd1', modified_at: 1, _record: { id: 'd1', name: 'Acme', stage: 'won' } };
    expect(recon.hashOf!(a)).not.toBe(recon.hashOf!(c));
  });

  it('a failed poll yields NOTHING (skip-this-cycle, not a throw)', async () => {
    const recon = buildCanonicalCrmReconciler({
      vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS, getPriorHashes: noPriorHashes,
      runPoll: stubRunner({ ok: false, kind: 'config', reason: 'no profile' }),
    });
    expect(await collect(recon.listUpdatedSince!(pipedriveConn(), 0, 200))).toEqual([]);
  });

  it('stableStringify sorts keys recursively (the hash determinism primitive)', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(stableStringify(undefined)).toBe('null');
  });
});

// ────────────────────────────────────────────────────────────────
// End-to-end through the real harness + real mirror store
// ────────────────────────────────────────────────────────────────

describe('D-190 MS4 — generic reconciler mirrors via the real harness (like hb/sf)', () => {
  let dir: string;
  let db: Database.Database;
  let enrichmentStore: EnrichmentStore;
  let mirror: CrmRecordMirrorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd190-ms4-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    enrichmentStore = createEnrichmentStore(db);
    ensureCrmRecordMirrorSchema(db);
    mirror = createCrmRecordMirrorStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeCtx = (bus = createWarehouseEventBus()): HousekeepingContext => ({
    db,
    bus,
    enrichmentStore,
    recipeStore: {} as unknown as HousekeepingContext['recipeStore'],
    now: () => 2_000_000_000_000,
    emitAuditRow: () => {},
    crmRecordMirror: mirror,
  });

  /** Capture every warehouse event a step emits — the anti-storm probe. */
  const captureBus = (): { bus: ReturnType<typeof createWarehouseEventBus>; events: unknown[] } => {
    const events: unknown[] = [];
    const bus = createWarehouseEventBus();
    bus.subscribe('**', (ev) => events.push(ev));
    return { bus, events };
  };

  /** The real mirror as the incremental seam (what the boot wires). */
  const priorFromMirror = (s: EnrichmentScope): Map<string, string> => mirror.listSnapshotHashes(s);

  it('a bound Pipedrive connection mirrors EVERY polled deal — no bespoke code', async () => {
    const reconciler = buildCanonicalCrmReconciler({
      vendor: 'pipedrive',
      entity: 'deal',
      pollDeps: FAKE_POLL_DEPS, getPriorHashes: noPriorHashes,
      now: () => 7_000,
      runPoll: stubRunner(okPoll([
        canonicalDeal('1', { name: 'Northwind renewal', close_state: 'open' }),
        canonicalDeal('2', { name: 'Globex expansion', close_state: 'won' }),
      ])),
    });
    const task = buildVendorReconciliationTask({
      reconciler,
      connection_name: 'acme-pipedrive',
      lookupConnection: () => pipedriveConn('acme-pipedrive'),
    });

    const result = await task.step(makeCtx(), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(result.status).toBe('complete');

    const rows = mirror.list(PIPEDRIVE_DEAL_SCOPE);
    expect(rows.map((r) => r.target_id).sort()).toEqual(['pipedrive_deal_acme-pipedrive_1', 'pipedrive_deal_acme-pipedrive_2']);
    const won = rows.find((r) => r.target_id === 'pipedrive_deal_acme-pipedrive_2')!;
    expect(won.meta.name).toBe('Globex expansion');
    expect(won.meta.close_state).toBe('won');
    // No enrichment row needed — the mirror alone makes them visible to deal.search.
    expect(enrichmentStore.listByTarget(PIPEDRIVE_DEAL_SCOPE, 'pipedrive_deal_acme-pipedrive_1')).toHaveLength(0);
  });

  it('canonical close_state filter on the mirrored Pipedrive deals works (MS3 read path)', async () => {
    const reconciler = buildCanonicalCrmReconciler({
      vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS, getPriorHashes: noPriorHashes, now: () => 7_000,
      runPoll: stubRunner(okPoll([
        canonicalDeal('pd_open', { name: 'Open one', close_state: 'open' }),
        canonicalDeal('pd_won', { name: 'Won one', close_state: 'won' }),
      ])),
    });
    await buildVendorReconciliationTask({
      reconciler, connection_name: 'acme-pipedrive', lookupConnection: () => pipedriveConn('acme-pipedrive'),
    }).step(makeCtx(), { kind: 'time', last_seen_at: 0 }, 60_000);

    const wonRows = mirror.list(PIPEDRIVE_DEAL_SCOPE, {
      meta_equals: [{ path: '$.close_state', value: 'won' }],
    });
    expect(wonRows.map((r) => r.target_id)).toEqual(['pipedrive_deal_acme-pipedrive_pd_won']);
  });

  it('a failed poll mirrors nothing + the harness still completes', async () => {
    const reconciler = buildCanonicalCrmReconciler({
      vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS, getPriorHashes: noPriorHashes,
      runPoll: stubRunner({ ok: false, kind: 'policy', reason: 'ask' }),
    });
    const result = await buildVendorReconciliationTask({
      reconciler, connection_name: 'acme-pipedrive', lookupConnection: () => pipedriveConn('acme-pipedrive'),
    }).step(makeCtx(), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(result.status).toBe('complete');
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE)).toEqual([]);
  });

  it('is incremental across cycles — re-polling UNCHANGED records emits NOTHING (no bus/cascade storm)', async () => {
    // The full-walk poll returns the SAME two deals every cycle. Wired to the REAL
    // mirror as the incremental seam (what the boot does), the reconciler must NOT
    // re-fire a warehouse event for an unchanged record on every cycle.
    const records = [canonicalDeal('pipedrive_deal_1'), canonicalDeal('pipedrive_deal_2')];
    const task = buildVendorReconciliationTask({
      reconciler: buildCanonicalCrmReconciler({
        vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS, now: () => 7_000,
        getPriorHashes: priorFromMirror, // the real mirror — populated after cycle 1
        runPoll: stubRunner(okPoll(records)),
      }),
      connection_name: 'acme-pipedrive',
      lookupConnection: () => pipedriveConn('acme-pipedrive'),
    });

    // Cycle 1 — cold mirror: both deals mirror + emit (the backfill).
    const c1 = captureBus();
    await task.step(makeCtx(c1.bus), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE)).toHaveLength(2);
    expect(c1.events).toHaveLength(2);

    // Cycle 2 — unchanged: the mirror now carries the hashes, so the reconciler
    // skips BOTH → ZERO new warehouse events (no cascade / producer / audit churn).
    const c2 = captureBus();
    await task.step(makeCtx(c2.bus), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(c2.events).toHaveLength(0);
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE)).toHaveLength(2); // still mirrored
  });

  // ── D-128 per-connection scoping (the reason the connection segment exists) ──

  const oneDealTask = (connection_name: string, dealName: string) =>
    buildVendorReconciliationTask({
      reconciler: buildCanonicalCrmReconciler({
        vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS,
        getPriorHashes: priorFromMirror, now: () => 7_000,
        // BOTH connections have a deal with the SAME native id '47291' — Pipedrive
        // ids are portal-scoped, so two portals overlap. Different content per portal.
        runPoll: stubRunner(okPoll([canonicalDeal('47291', { name: dealName })])),
      }),
      connection_name,
      lookupConnection: () => pipedriveConn(connection_name),
    });

  it('two connections of the SAME vendor with the SAME native id do NOT collide', async () => {
    // Pre-D-190 both wrote `pipedrive_deal_47291` → ONE row, last-writer-wins
    // (silent data loss). The connection segment keeps them distinct.
    await oneDealTask('acme-pipedrive', 'Acme deal').step(makeCtx(), { kind: 'time', last_seen_at: 0 }, 60_000);
    await oneDealTask('personal-pipedrive', 'Personal deal').step(makeCtx(), { kind: 'time', last_seen_at: 0 }, 60_000);

    const rows = mirror.list(PIPEDRIVE_DEAL_SCOPE);
    expect(rows.map((r) => r.target_id).sort()).toEqual([
      'pipedrive_deal_acme-pipedrive_47291',
      'pipedrive_deal_personal-pipedrive_47291',
    ]);
    // Each portal's content survives — neither clobbered the other.
    expect(rows.find((r) => r.target_id === 'pipedrive_deal_acme-pipedrive_47291')!.meta.name).toBe('Acme deal');
    expect(rows.find((r) => r.target_id === 'pipedrive_deal_personal-pipedrive_47291')!.meta.name).toBe('Personal deal');
  });

  it('NO cross-connection ping-pong — re-polling one connection skips its own row + never touches the other', async () => {
    const acme = oneDealTask('acme-pipedrive', 'Acme deal');
    const personal = oneDealTask('personal-pipedrive', 'Personal deal');

    // Cycle 1 — each backfills its own row (1 event each).
    const a1 = captureBus(); await acme.step(makeCtx(a1.bus), { kind: 'time', last_seen_at: 0 }, 60_000);
    const p1 = captureBus(); await personal.step(makeCtx(p1.bus), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(a1.events).toHaveLength(1);
    expect(p1.events).toHaveLength(1);
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE)).toHaveLength(2);

    // Cycle 2 — re-poll acme. The mirror's per-scope snapshot now holds BOTH
    // connections' rows for native id 47291. Pre-D-190 acme would see personal's
    // `pipedrive_deal_47291` (different hash) and re-yield it EVERY cycle (storm:
    // cascade + AI producers + audit). Now acme only looks up its OWN composed id
    // → hash match → ZERO events, and personal's row is untouched.
    const a2 = captureBus(); await acme.step(makeCtx(a2.bus), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(a2.events).toHaveLength(0);
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE)).toHaveLength(2);
  });

  // ── S2 — delete detection (full-walk diff) ──

  /** A reconciliation task whose poll returns `records` with controllable completeness
   *  signals — `complete` (the delete-detection gate: the gateway provably walked the
   *  full set) defaults true; `truncated` defaults false. */
  const pollTask = (
    connection_name: string,
    records: Record<string, unknown>[],
    opts: { truncated?: boolean; complete?: boolean } = {},
  ) =>
    buildVendorReconciliationTask({
      reconciler: buildCanonicalCrmReconciler({
        vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS,
        getPriorHashes: priorFromMirror, now: () => 7_000,
        runPoll: stubRunner({
          ok: true,
          records: new Map(records.map((r) => [String(r.id), r])),
          truncated: opts.truncated ?? false,
          complete: opts.complete ?? true,
          skipped_no_id: 0,
        }),
      }),
      connection_name,
      lookupConnection: () => pipedriveConn(connection_name),
    });

  const step = (task: ReturnType<typeof pollTask>, bus = createWarehouseEventBus()) =>
    task.step(makeCtx(bus), { kind: 'time', last_seen_at: 0 }, 60_000);

  it('S2 — a deal absent from a COMPLETE poll is deleted from the mirror + emits a deleted event', async () => {
    await step(pollTask('acme-pipedrive', [canonicalDeal('1'), canonicalDeal('2'), canonicalDeal('3')]));
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE)).toHaveLength(3);

    const c2 = captureBus();
    await step(pollTask('acme-pipedrive', [canonicalDeal('1'), canonicalDeal('3')]), c2.bus);
    // Deal 2 dropped from the mirror; 1 + 3 remain.
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE).map((r) => r.target_id).sort()).toEqual([
      'pipedrive_deal_acme-pipedrive_1',
      'pipedrive_deal_acme-pipedrive_3',
    ]);
    expect(
      c2.events.some(
        (e) => (e as { event_kind?: string }).event_kind === 'deleted'
          && (e as { record_id?: string }).record_id === 'pipedrive_deal_acme-pipedrive_2',
      ),
    ).toBe(true);
  });

  it('S2 — a TRUNCATED poll does NOT delete (incomplete walk → no false delete)', async () => {
    await step(pollTask('acme-pipedrive', [canonicalDeal('1'), canonicalDeal('2')]));
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE)).toHaveLength(2);
    // Deal 2 missing from the poll, BUT the poll was truncated (incomplete) → keep it.
    await step(pollTask('acme-pipedrive', [canonicalDeal('1')], { truncated: true, complete: false }));
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE)).toHaveLength(2);
  });

  it('S2 — a NON-PAGINATING poll (truncated:false but complete:false) does NOT delete (codex fold)', async () => {
    // A catalog with a search_style but no pagination_style returns the FIRST page with
    // truncated:false — `!truncated` alone would false-delete everything beyond page 1.
    // The `complete` gate fail-closes: an incomplete-but-not-truncated poll deletes nothing.
    await step(pollTask('acme-pipedrive', [canonicalDeal('1'), canonicalDeal('2')]));
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE)).toHaveLength(2);
    const c = captureBus();
    await step(pollTask('acme-pipedrive', [canonicalDeal('1')], { truncated: false, complete: false }), c.bus);
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE)).toHaveLength(2); // deal 2 NOT deleted
    expect(c.events.some((e) => (e as { event_kind?: string }).event_kind === 'deleted')).toBe(false);
  });

  it('S2 — deletes ONLY this connection\'s rows (per-connection isolation in a shared scope)', async () => {
    // Both connections mirror a deal with the SAME native id 1 — D-128 de-collides them
    // into distinct rows under the one per-vendor scope.
    await step(pollTask('acme-pipedrive', [canonicalDeal('1')]));
    await step(pollTask('personal-pipedrive', [canonicalDeal('1')]));
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE)).toHaveLength(2);
    // acme's deal 1 disappears (empty poll). personal's deal 1 — same scope — must survive
    // (the prefix filter scopes the diff to acme's own target_ids).
    await step(pollTask('acme-pipedrive', []));
    expect(mirror.list(PIPEDRIVE_DEAL_SCOPE).map((r) => r.target_id)).toEqual([
      'pipedrive_deal_personal-pipedrive_1',
    ]);
  });

  it('S2 — listDeletedSince with no preceding poll yields nothing (fail-safe)', async () => {
    const recon = buildCanonicalCrmReconciler({
      vendor: 'pipedrive', entity: 'deal', pollDeps: FAKE_POLL_DEPS,
      getPriorHashes: priorFromMirror, runPoll: stubRunner(okPoll([])),
    });
    expect(await collect(recon.listDeletedSince!(pipedriveConn(), 0))).toEqual([]);
  });
});
