/** FLEET MONEY MODEL — three-role drive of the audit-folded revision.
 *
 *  Spec: internal design notes. This replaces the legacy tiers drive, which
 *  exercised the earlier decimal/percentage schema and the two-phase seal.
 *
 *  What is different, and why the drive had to be rewritten:
 *    - money is safe-integer minor units with BASIS POINTS, not decimals;
 *    - a release is bounded to 49 combined sources so settlement + per-source
 *      item/CAS + the worker fence is exactly 100 ops — ONE atomic batch, so the
 *      two-phase resume state is gone entirely;
 *    - `settlement_item` freezes per-source terms, so a later edit to a job
 *      cannot destroy the evidence an adjustment is computed against;
 *    - `worker.last_settlement_ref` is a concurrency fence;
 *    - currency is guarded, never inferred.
 *
 *  Drives the real `createRecordsStore` over SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type {
  RecordsExecutionBinding,
  RecordsSchemaSnapshot,
} from '@recued/contracts';
import { createRecordsStore, type RecordsStore } from '../store.js';

const OWNER = { publisher: 'acme-cleaning', pack_slug: 'fleet-dispatch' };
const PACK = { version: 1 };
const SH = 'sh-fleet-rev1';
const DH = 'dh-fleet-rev1';

/** § 5 bounds. */
const MAX_PRICE_MINOR = 900_000_000_000;
const MAX_BPS = 10_000;
/** § 7 — 1 settlement + 49*(item+source) + 1 worker fence = 100 exactly. */
const MAX_SOURCES = 49;

const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    worker: { kind: 'worker', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'last_settlement_ref', slot: 'r1', kind: 'ref', required: false },
      { key: 'name', slot: 's1', kind: 'string', required: true },
      { key: 'email', slot: 's2', kind: 'string', required: true },
      { key: 'currency', slot: 's3', kind: 'string', required: true },
      { key: 'default_bps', slot: 'n1', kind: 'number', required: true },
      { key: 'hold_days', slot: 'n2', kind: 'number', required: true },
      { key: 'stuck_minutes', slot: 'n3', kind: 'number', required: true },
    ] },
    job: { kind: 'job', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'assignee_ref', slot: 'r1', kind: 'ref', required: false },
      { key: 'settlement_ref', slot: 'r2', kind: 'ref', required: false },
      { key: 'state', slot: 's1', kind: 'string', required: true },
      { key: 'money_state', slot: 's2', kind: 'string', required: true },
      { key: 'payout_reason', slot: 's3', kind: 'string', required: false },
      { key: 'customer', slot: 's4', kind: 'string', required: true },
      { key: 'collected_by', slot: 's5', kind: 'string', required: false },
      { key: 'currency', slot: 's6', kind: 'string', required: true },
      { key: 'completed_at', slot: 'dt1', kind: 'datetime', required: false },
      { key: 'received_at', slot: 'dt2', kind: 'datetime', required: false },
      { key: 'release_at', slot: 'dt3', kind: 'datetime', required: false },
      { key: 'price_minor', slot: 'n1', kind: 'number', required: true },
      { key: 'payout_bps', slot: 'n2', kind: 'number', required: true },
      { key: 'payout_minor', slot: 'n3', kind: 'number', required: false },
      { key: 'collected_minor', slot: 'n4', kind: 'number', required: false },
      { key: 'balance_minor', slot: 'n5', kind: 'number', required: false },
      { key: 'duration_minutes', slot: 'n6', kind: 'number', required: false },
      // ⛔ FIX 1 — a NUMBER, not a string. Range predicates are refused on
      // string slots (`store.ts:2190`) and the job has no free datetime slot,
      // so an arrival on `s7` would make the stuck view impossible.
      { key: 'checkin_at_ms', slot: 'n7', kind: 'number', required: false },
    ] },
    settlement: { kind: 'settlement', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'assignee_ref', slot: 'r1', kind: 'ref', required: true },
      { key: 'status', slot: 's1', kind: 'string', required: true },
      { key: 'currency', slot: 's2', kind: 'string', required: true },
      { key: 'cutoff_at', slot: 'dt1', kind: 'datetime', required: true },
      { key: 'settled_at', slot: 'dt2', kind: 'datetime', required: true },
      { key: 'net_minor', slot: 'n1', kind: 'number', required: true },
      { key: 'gross_minor', slot: 'n2', kind: 'number', required: true },
      { key: 'adjustment_net_minor', slot: 'n3', kind: 'number', required: true },
      { key: 'job_count', slot: 'n4', kind: 'number', required: true },
      { key: 'adjustment_count', slot: 'n5', kind: 'number', required: true },
      { key: 'total_minutes', slot: 'n6', kind: 'number', required: true },
    ] },
    settlement_item: { kind: 'settlement_item', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'settlement_ref', slot: 'r1', kind: 'ref', required: true },
      { key: 'job_ref', slot: 'r2', kind: 'ref', required: false },
      { key: 'adjustment_ref', slot: 'r3', kind: 'ref', required: false },
      { key: 'source_kind', slot: 's1', kind: 'string', required: true },
      { key: 'currency', slot: 's2', kind: 'string', required: true },
      { key: 'price_minor', slot: 'n1', kind: 'number', required: true },
      { key: 'payout_bps', slot: 'n2', kind: 'number', required: true },
      { key: 'payout_minor', slot: 'n3', kind: 'number', required: true },
      { key: 'collected_minor', slot: 'n4', kind: 'number', required: true },
      { key: 'balance_minor', slot: 'n5', kind: 'number', required: true },
      { key: 'duration_minutes', slot: 'n6', kind: 'number', required: true },
    ] },
    adjustment: { kind: 'adjustment', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'assignee_ref', slot: 'r1', kind: 'ref', required: true },
      { key: 'job_ref', slot: 'r2', kind: 'ref', required: true },
      { key: 'corrects_item_ref', slot: 'r3', kind: 'ref', required: true },
      { key: 'settlement_ref', slot: 'r4', kind: 'ref', required: false },
      { key: 'reason', slot: 's1', kind: 'string', required: true },
      { key: 'status', slot: 's2', kind: 'string', required: true },
      { key: 'currency', slot: 's3', kind: 'string', required: true },
      { key: 'target_collected_by', slot: 's4', kind: 'string', required: true },
      { key: 'eligible_at', slot: 'dt1', kind: 'datetime', required: true },
      { key: 'delta_minor', slot: 'n1', kind: 'number', required: true },
      { key: 'target_price_minor', slot: 'n2', kind: 'number', required: true },
      { key: 'target_bps', slot: 'n3', kind: 'number', required: true },
    ] },
  },
};

const bind = (
  action: string, entity: string, extra: Partial<RecordsExecutionBinding> = {}, tag = '',
): RecordsExecutionBinding => ({
  kind: 'core.records', action: action as never, entity, owner: OWNER,
  pack_version: PACK.version, storage_schema_hash: SH, declaration_hash: DH,
  operation_digest: `d:${action}:${entity}${tag}`, ...extra,
});

const B = {
  workerCreate: bind('create', 'worker'),
  workerGet: bind('get', 'worker'),
  workerUpdate: bind('update', 'worker'),
  jobCreate: bind('create', 'job'),
  jobGet: bind('get', 'job'),
  jobUpdate: bind('update', 'job'),
  jobSearch: bind('search', 'job', {
    filter_fields: [
      'assignee_ref', 'state', 'money_state', 'customer', 'settlement_ref',
      'release_at', 'currency', 'checkin_at_ms',
    ],
    sort_fields: ['release_at', '_record.updated_at'],
  }),
  settlementCreate: bind('create', 'settlement'),
  settlementGet: bind('get', 'settlement'),
  settlementSearch: bind('search', 'settlement', {
    filter_fields: ['assignee_ref', 'status', 'currency'],
  }),
  itemCreate: bind('create', 'settlement_item'),
  itemSearch: bind('search', 'settlement_item', {
    filter_fields: ['settlement_ref', 'job_ref', 'adjustment_ref', 'source_kind'],
  }),
  adjustmentCreate: bind('create', 'adjustment'),
  adjustmentGet: bind('get', 'adjustment'),
  adjustmentSearch: bind('search', 'adjustment', {
    filter_fields: ['assignee_ref', 'job_ref', 'status', 'eligible_at', 'currency'],
    sort_fields: ['eligible_at', '_record.updated_at'],
  }),
  /** § 7 — post-settlement correction: job CAS + adjustment create, atomically. */
  correctionPost: bind('batch', 'adjustment', { allow: [
    { entity: 'job', action: 'update' as const },
    { entity: 'adjustment', action: 'create' as const },
  ] }, ':correct'),
  /** § 7 — the one bounded atomic release. */
  releasePost: bind('batch', 'settlement', { allow: [
    { entity: 'settlement', action: 'create' as const },
    { entity: 'settlement_item', action: 'create' as const },
    { entity: 'job', action: 'update' as const },
    { entity: 'adjustment', action: 'update' as const },
    { entity: 'worker', action: 'update' as const },
  ] }, ':release'),
};

/** § 5 — the shared accrual formula. In the pack this is the byte-identical
 *  block both `record-collection` and `complete-job` carry, parity-checked at
 *  build time. Here it exists once so the drive can assert both orders agree. */
const deriveMoney = (
  priceMinor: number, bps: number, collectedBy: string | null,
): { payout_minor: number; collected_minor: number; balance_minor: number } => {
  const payout = Math.round((priceMinor * bps) / 10_000);
  const collected = collectedBy === 'worker' ? priceMinor : 0;
  return { payout_minor: payout, collected_minor: collected, balance_minor: payout - collected };
};

const DAY = 86_400_000;

describe('fleet money model — revision drive (customer · worker · runner)', () => {
  let db: Database.Database;
  let store: RecordsStore;
  let clock = 1_700_000_000_000;
  const NOW = () => new Date(clock).toISOString();

  const run = (b: RecordsExecutionBinding, args: Record<string, unknown>): any =>
    store.execute({ binding: b, principal: 'owner', args }) as any;
  const jobRow = (id: string): any => run(B.jobGet, { id }).record;
  const workerRow = (id: string): any => run(B.workerGet, { id }).record;

  const setJob = (id: string, set: Record<string, unknown>): any => {
    const cur = jobRow(id);
    return run(B.jobUpdate, {
      id, expected_version: PACK.version, expected_revision: cur._record.revision,
      set, unset: [],
    }).record;
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    store = createRecordsStore(db, { now: () => clock++ });
    store.installNamespace({
      owner: OWNER, version: PACK.version, storage_schema_hash: SH,
      declaration_hash: DH, artifact_digest: 'x', schema, bindings: B,
    });
    run(B.workerCreate, { id: 'w_maria', values: {
      name: 'Maria', email: 'maria@example.com', currency: 'USD',
      default_bps: 5000, hold_days: 3, stuck_minutes: 480,
    } });
  });
  afterEach(() => db.close());

  // ─────────────── CUSTOMER ───────────────

  const bookJob = (id: string, priceMinor: number, worker = 'w_maria'): any => {
    const w = workerRow(worker);
    return run(B.jobCreate, { id, values: {
      state: 'offered', money_state: 'awaiting_payment', customer: 'C. Alvarez',
      assignee_ref: `worker/${worker}`, currency: w.currency,
      price_minor: priceMinor, payout_bps: w.default_bps,
    } }).record;
  };

  /** Collection-first or completion-first: whichever lands second accrues. */
  const recordCollection = (id: string, by: 'runner' | 'worker'): any => {
    const j = jobRow(id);
    const both = j.completed_at !== null;
    const money = both ? deriveMoney(j.price_minor, j.payout_bps, by) : null;
    return setJob(id, {
      collected_by: by, received_at: NOW(),
      money_state: both ? 'accrued' : 'received',
      ...(money ?? {}),
    });
  };

  const completeJob = (id: string): any => {
    const j = jobRow(id);
    const both = j.received_at !== null;
    const money = both ? deriveMoney(j.price_minor, j.payout_bps, j.collected_by) : null;
    const duration = j.checkin_at_ms !== null
      ? Math.round((clock - j.checkin_at_ms) / 60_000) : null;
    return setJob(id, {
      state: 'completed', completed_at: NOW(),
      ...(duration !== null ? { duration_minutes: duration } : {}),
      money_state: both ? 'accrued' : 'awaiting_payment',
      ...(money ?? {}),
    });
  };

  it('CUSTOMER → a booked job copies worker currency and seeds basis points', () => {
    const j = bookJob('j1', 12_000);
    expect(j.money_state).toBe('awaiting_payment');
    expect(j.currency).toBe('USD');
    expect(j.payout_bps).toBe(5000);
    expect(j.payout_minor).toBeNull();
  });

  it('CUSTOMER → collection alone moves money to received, not accrued', () => {
    bookJob('j1', 12_000);
    const j = recordCollection('j1', 'runner');
    expect(j.money_state).toBe('received');
    expect(j.balance_minor).toBeNull();       // work has not happened yet
  });

  // ─────────────── WORKER ───────────────

  const checkIn = (id: string): any =>
    setJob(id, { state: 'on_site', checkin_at_ms: clock });

  it('WORKER → accept, arrive, complete: duration derives from the arrival stamp', () => {
    bookJob('j1', 12_000);
    setJob('j1', { state: 'accepted' });
    checkIn('j1');
    clock += 150 * 60_000;
    recordCollection('j1', 'runner');
    const done = completeJob('j1');
    expect(done.state).toBe('completed');
    expect(done.duration_minutes).toBe(150);
    expect(done.money_state).toBe('accrued');
    expect(done.payout_minor).toBe(6_000);    // 5000bps of 12000
    expect(done.balance_minor).toBe(6_000);
  });

  it('WORKER → a worker-collected job accrues a NEGATIVE balance', () => {
    bookJob('j1', 12_000);
    recordCollection('j1', 'worker');
    const done = completeJob('j1');
    expect(done.collected_minor).toBe(12_000);
    expect(done.balance_minor).toBe(-6_000);  // owes the runner back
  });

  it('§10 → BOTH ORDERS reach a byte-identical derived result', () => {
    // The property the § 5 parity gate exists to keep. Collection-first and
    // completion-first must agree on every derived field.
    bookJob('a', 12_345);
    recordCollection('a', 'runner');
    completeJob('a');

    bookJob('b', 12_345);
    completeJob('b');
    recordCollection('b', 'runner');

    const pick = (j: any) => ({
      money_state: j.money_state, payout_minor: j.payout_minor,
      collected_minor: j.collected_minor, balance_minor: j.balance_minor,
    });
    expect(pick(jobRow('a'))).toEqual(pick(jobRow('b')));
    expect(jobRow('a').money_state).toBe('accrued');
  });

  it('§10 → rounding is half-up at the half-minor-unit boundary', () => {
    bookJob('r1', 12_345);                    // 12345 * 5000 / 10000 = 6172.5
    recordCollection('r1', 'runner');
    expect(completeJob('r1').payout_minor).toBe(6_173);
  });

  it('§10 → safe-integer endpoints hold at the declared bounds', () => {
    bookJob('big', MAX_PRICE_MINOR);
    setJob('big', { payout_bps: MAX_BPS });
    recordCollection('big', 'runner');
    const done = completeJob('big');
    expect(done.payout_minor).toBe(MAX_PRICE_MINOR);
    expect(Number.isSafeInteger(MAX_PRICE_MINOR * MAX_BPS)).toBe(true);
  });

  it('🔑 FIX 1 → the stuck view is a real store-side range query on a NUMBER', () => {
    bookJob('j1', 12_000); setJob('j1', { state: 'accepted' }); checkIn('j1');
    bookJob('j2', 9_000);  setJob('j2', { state: 'accepted' });
    clock += 9 * 60 * 60_000;
    checkIn('j2');                                     // arrived just now

    const cutoff = clock - 480 * 60_000;               // worker.stuck_minutes
    const stuck = run(B.jobSearch, { filters: {
      assignee_ref: 'worker/w_maria', state: 'on_site',
      checkin_at_ms: { op: 'lte', value: cutoff },
    }, limit: 50 }).records;

    expect(stuck.map((j: any) => j.id)).toEqual(['j1']);
  });

  it('⛔ FIX 1 control → the same predicate on a STRING slot is refused by the store', () => {
    // Why arrival is a number. If it lived on `s6` (currency, a string) the
    // stuck view could not be expressed at all.
    expect(() => run(B.jobSearch, {
      filters: { currency: { op: 'lte', value: 'USD' } }, limit: 5,
    })).toThrow(/range predicate is not admitted on string/);
  });

  // ─────────────── RUNNER ───────────────

  const startHold = (id: string): any => {
    const j = jobRow(id);
    expect(j.money_state).toBe('accrued');
    const base = Math.max(Date.parse(j.received_at), Date.parse(j.completed_at));
    const w = workerRow('w_maria');
    return setJob(id, {
      money_state: 'held',
      release_at: new Date(base + w.hold_days * DAY).toISOString(),
    });
  };

  const readyJob = (id: string, price: number, by: 'runner' | 'worker' = 'runner') => {
    bookJob(id, price);
    recordCollection(id, by);
    completeJob(id);
    return startHold(id);
  };

  /** § 7 — the whole release as ONE atomic batch. */
  const release = (
    workerId: string, releaseId: string, opts: { staleWorkerRev?: number } = {},
  ) => {
    const w = workerRow(workerId);
    const workerRef = `worker/${workerId}`;
    const cutoff = NOW();

    const prior = (() => {
      try { return run(B.settlementGet, { id: releaseId }).record; } catch { return null; }
    })();
    if (prior) return { replayed: true, settlement: prior, count: prior.job_count + prior.adjustment_count };

    const adjustments = run(B.adjustmentSearch, { filters: {
      assignee_ref: workerRef, status: 'pending', currency: w.currency,
      eligible_at: { op: 'lte', value: cutoff },
    }, sort: 'eligible_at', limit: MAX_SOURCES }).records;

    const remaining = MAX_SOURCES - adjustments.length;
    const jobs = remaining > 0 ? run(B.jobSearch, { filters: {
      assignee_ref: workerRef, money_state: 'held', currency: w.currency,
      settlement_ref: { op: 'is_null', value: true },
      release_at: { op: 'lte', value: cutoff },
    }, sort: 'release_at', limit: remaining }).records : [];

    if (adjustments.length + jobs.length === 0) return { nothingDue: true, count: 0 };

    // Currency guard — never inferred.
    for (const s of [...jobs, ...adjustments]) {
      if (s.currency !== w.currency) throw new Error(`currency mismatch on ${s.id}`);
    }

    const totals = {
      net: [...jobs.map((j: any) => j.balance_minor), ...adjustments.map((a: any) => a.delta_minor)]
        .reduce((n: number, v: number) => n + v, 0),
      gross: jobs.reduce((n: number, j: any) => n + j.price_minor, 0),
      adjNet: adjustments.reduce((n: number, a: any) => n + a.delta_minor, 0),
      minutes: jobs.reduce((n: number, j: any) => n + (j.duration_minutes ?? 0), 0),
    };

    const ops: unknown[] = [
      { entity: 'settlement', action: 'create', args: { id: releaseId, values: {
        assignee_ref: workerRef, status: 'settled', currency: w.currency,
        cutoff_at: cutoff, settled_at: cutoff,
        net_minor: totals.net, gross_minor: totals.gross,
        adjustment_net_minor: totals.adjNet,
        job_count: jobs.length, adjustment_count: adjustments.length,
        total_minutes: totals.minutes,
      } } },
    ];
    for (const j of jobs) {
      ops.push({ entity: 'settlement_item', action: 'create', args: {
        id: `${releaseId}-job-${j.id}`, values: {
          settlement_ref: `settlement/${releaseId}`, job_ref: `job/${j.id}`,
          source_kind: 'job', currency: j.currency,
          price_minor: j.price_minor, payout_bps: j.payout_bps,
          payout_minor: j.payout_minor, collected_minor: j.collected_minor,
          balance_minor: j.balance_minor, duration_minutes: j.duration_minutes ?? 0,
        } } });
      ops.push({ entity: 'job', action: 'update', args: {
        id: j.id, expected_version: PACK.version, expected_revision: j._record.revision,
        set: { settlement_ref: `settlement/${releaseId}`, money_state: 'settled' }, unset: [],
      } });
    }
    for (const a of adjustments) {
      ops.push({ entity: 'settlement_item', action: 'create', args: {
        id: `${releaseId}-adj-${a.id}`, values: {
          settlement_ref: `settlement/${releaseId}`, adjustment_ref: `adjustment/${a.id}`,
          source_kind: 'adjustment', currency: a.currency,
          price_minor: 0, payout_bps: 0, payout_minor: 0, collected_minor: 0,
          balance_minor: a.delta_minor, duration_minutes: 0,
        } } });
      ops.push({ entity: 'adjustment', action: 'update', args: {
        id: a.id, expected_version: PACK.version, expected_revision: a._record.revision,
        set: { settlement_ref: `settlement/${releaseId}`, status: 'applied' }, unset: [],
      } });
    }
    ops.push({ entity: 'worker', action: 'update', args: {
      id: workerId, expected_version: PACK.version,
      expected_revision: opts.staleWorkerRev ?? w._record.revision,
      set: { last_settlement_ref: `settlement/${releaseId}` }, unset: [],
    } });

    run(B.releasePost, { ops });
    return { opCount: ops.length, count: jobs.length + adjustments.length, totals };
  };

  it('RUNNER → hold derives release_at from the later of the two facts', () => {
    bookJob('j1', 12_000);
    recordCollection('j1', 'runner');
    clock += 2 * DAY;
    completeJob('j1');
    const held = startHold('j1');
    expect(held.money_state).toBe('held');
    expect(Date.parse(held.release_at))
      .toBe(Date.parse(held.completed_at) + 3 * DAY);   // completion was later
  });

  it('RUNNER → a release writes settlement, items, stamps and the worker fence atomically', () => {
    readyJob('j1', 12_000);
    readyJob('j2', 8_000, 'worker');
    clock += 4 * DAY;
    const out = release('w_maria', 'rel_1');

    expect(out.count).toBe(2);
    const s = run(B.settlementGet, { id: 'rel_1' }).record;
    expect(s.status).toBe('settled');
    expect(s.net_minor).toBe(6_000 + (4_000 - 8_000));   // mixed directions net
    expect(s.gross_minor).toBe(20_000);
    expect(s.job_count).toBe(2);

    const items = run(B.itemSearch, { filters: { settlement_ref: 'settlement/rel_1' }, limit: 50 }).records;
    expect(items).toHaveLength(2);
    expect(jobRow('j1').money_state).toBe('settled');
    expect(workerRow('w_maria').last_settlement_ref).toBe('settlement/rel_1');
  });

  it('§10 → a full 49-source release is EXACTLY 100 ops and commits', () => {
    for (let i = 0; i < MAX_SOURCES; i++) readyJob(`j${i}`, 1_000);
    clock += 4 * DAY;
    const out = release('w_maria', 'rel_full');
    expect(out.count).toBe(MAX_SOURCES);
    expect(out.opCount, '1 + 49*2 + 1').toBe(100);
    expect(run(B.settlementGet, { id: 'rel_full' }).record.job_count).toBe(49);
  });

  it('⛔ §10 → a 50-source batch is refused by the store, which is why 49 is the bound', () => {
    for (let i = 0; i < 50; i++) readyJob(`j${i}`, 1_000);
    clock += 4 * DAY;
    const w = workerRow('w_maria');
    const jobs = run(B.jobSearch, { filters: {
      assignee_ref: 'worker/w_maria', money_state: 'held',
    }, limit: 60 }).records;
    expect(jobs).toHaveLength(50);

    const ops: unknown[] = [{ entity: 'settlement', action: 'create', args: { id: 'too_big', values: {
      assignee_ref: 'worker/w_maria', status: 'settled', currency: 'USD',
      cutoff_at: NOW(), settled_at: NOW(), net_minor: 0, gross_minor: 0,
      adjustment_net_minor: 0, job_count: 50, adjustment_count: 0, total_minutes: 0,
    } } }];
    for (const j of jobs) {
      ops.push({ entity: 'settlement_item', action: 'create', args: { id: `too_big-job-${j.id}`, values: {
        settlement_ref: 'settlement/too_big', job_ref: `job/${j.id}`, source_kind: 'job',
        currency: 'USD', price_minor: j.price_minor, payout_bps: j.payout_bps,
        payout_minor: j.payout_minor, collected_minor: j.collected_minor,
        balance_minor: j.balance_minor, duration_minutes: 0,
      } } });
      ops.push({ entity: 'job', action: 'update', args: {
        id: j.id, expected_version: PACK.version, expected_revision: j._record.revision,
        set: { settlement_ref: 'settlement/too_big', money_state: 'settled' }, unset: [],
      } });
    }
    ops.push({ entity: 'worker', action: 'update', args: {
      id: 'w_maria', expected_version: PACK.version, expected_revision: w._record.revision,
      set: { last_settlement_ref: 'settlement/too_big' }, unset: [],
    } });
    expect(ops).toHaveLength(102);
    expect(() => run(B.releasePost, { ops })).toThrow(/at most 100 ops/);
    expect(jobRow('j0').money_state, 'nothing partial').toBe('held');
  });

  it('§10 → nothing due skips the batch entirely (an empty op list is refused)', () => {
    const out = release('w_maria', 'rel_empty');
    expect(out.nothingDue).toBe(true);
    expect(() => run(B.releasePost, { ops: [] })).toThrow(/non-empty ops array/);
  });

  it('§10 → replay after a lost response returns the prior settlement, writes nothing', () => {
    readyJob('j1', 12_000);
    clock += 4 * DAY;
    const first = release('w_maria', 'rel_1');
    const revAfter = workerRow('w_maria')._record.revision;

    const second = release('w_maria', 'rel_1');
    expect(second.replayed).toBe(true);
    expect(second.count).toBe(first.count);
    expect(workerRow('w_maria')._record.revision, 'replay is not a second write').toBe(revAfter);
  });

  it('⛔ §10 → the worker fence stops two concurrent releases with DISJOINT sources', () => {
    // j1 is due now; j2 becomes due later, so the two releases select DISJOINT
    // sources and no source CAS can collide. Only the worker fence is left.
    readyJob('j1', 12_000);
    clock += 4 * DAY;
    readyJob('j2', 8_000);                                    // release_at is +3d
    const staleRev = workerRow('w_maria')._record.revision;   // both releases read this

    release('w_maria', 'rel_a');                              // takes j1 only
    expect(run(B.settlementGet, { id: 'rel_a' }).record.job_count).toBe(1);

    clock += 4 * DAY;                                         // now j2 is due
    expect(() => release('w_maria', 'rel_b', { staleWorkerRev: staleRev }))
      .toThrow();
    expect(run(B.settlementSearch, { filters: { assignee_ref: 'worker/w_maria' }, limit: 10 })
      .records.map((s: any) => s.id)).toEqual(['rel_a']);
  });

  it('⛔ §10 → a stale source rolls the whole release back', () => {
    readyJob('j1', 12_000);
    clock += 4 * DAY;
    const w = workerRow('w_maria');
    const j = jobRow('j1');
    setJob('j1', { payout_reason: 'touched after selection' });   // bumps revision

    expect(() => run(B.releasePost, { ops: [
      { entity: 'settlement', action: 'create', args: { id: 'rel_stale', values: {
        assignee_ref: 'worker/w_maria', status: 'settled', currency: 'USD',
        cutoff_at: NOW(), settled_at: NOW(), net_minor: 6000, gross_minor: 12000,
        adjustment_net_minor: 0, job_count: 1, adjustment_count: 0, total_minutes: 0,
      } } },
      { entity: 'job', action: 'update', args: {
        id: 'j1', expected_version: PACK.version, expected_revision: j._record.revision,
        set: { settlement_ref: 'settlement/rel_stale', money_state: 'settled' }, unset: [],
      } },
      { entity: 'worker', action: 'update', args: {
        id: 'w_maria', expected_version: PACK.version, expected_revision: w._record.revision,
        set: { last_settlement_ref: 'settlement/rel_stale' }, unset: [],
      } },
    ] })).toThrow();

    expect(run(B.settlementSearch, { filters: { assignee_ref: 'worker/w_maria' }, limit: 10 })
      .records, 'no settlement survives a stale source').toEqual([]);
    expect(jobRow('j1').money_state).toBe('held');
    expect(workerRow('w_maria').last_settlement_ref).toBeNull();
  });

  it('⛔ RUNNER → cross-currency sources are refused, never netted', () => {
    run(B.workerCreate, { id: 'w_eu', values: {
      name: 'Eva', email: 'eva@example.com', currency: 'EUR',
      default_bps: 5000, hold_days: 3, stuck_minutes: 480,
    } });
    readyJob('j1', 12_000);
    // A job whose currency was tampered to another code must not be swept in.
    setJob('j1', { currency: 'EUR' });
    clock += 4 * DAY;
    // ⚠ Assert the REASON, not just the absence: "no settlement" would also be
    // true if the release had failed for something unrelated.
    expect(release('w_maria', 'rel_x').nothingDue,
      'the mismatched job is filtered out, leaving nothing due').toBe(true);
    expect(run(B.settlementSearch, { filters: { assignee_ref: 'worker/w_maria' }, limit: 5 })
      .records).toEqual([]);
    expect(jobRow('j1').money_state).toBe('held');

    // Positive control: the same job with the worker's own currency IS selected.
    setJob('j1', { currency: 'USD' });
    expect(release('w_maria', 'rel_y').count).toBe(1);
  });

  // ─────────────── RUNNER · corrections ───────────────

  it('RUNNER → a pre-settlement correction is one CAS update and mints no adjustment', () => {
    readyJob('j1', 12_000);
    const j = jobRow('j1');
    const money = deriveMoney(j.price_minor, 1000, j.collected_by);
    setJob('j1', { payout_bps: 1000, payout_reason: 'complaint — rework', ...money });

    expect(jobRow('j1').payout_minor).toBe(1_200);
    expect(jobRow('j1').balance_minor).toBe(1_200);
    expect(run(B.adjustmentSearch, { filters: { assignee_ref: 'worker/w_maria' }, limit: 10 })
      .records, 'inside the hold, a correction is a plain edit').toEqual([]);
  });

  it('⛔⛔ RUNNER → a post-settlement correction is ONE batch: job CAS + adjustment create', () => {
    readyJob('j1', 12_000);
    clock += 4 * DAY;
    release('w_maria', 'rel_1');
    const settledNet = run(B.settlementGet, { id: 'rel_1' }).record.net_minor;

    // The frozen per-source terms are what the delta is computed against.
    const item = run(B.itemSearch, { filters: { job_ref: 'job/j1', source_kind: 'job' }, limit: 5 })
      .records[0];
    expect(item.payout_minor).toBe(6_000);

    const j = jobRow('j1');
    const next = deriveMoney(j.price_minor, 1000, j.collected_by);
    const delta = next.balance_minor - item.balance_minor;

    run(B.correctionPost, { ops: [
      { entity: 'job', action: 'update', args: {
        id: 'j1', expected_version: PACK.version, expected_revision: j._record.revision,
        set: { payout_bps: 1000, payout_reason: 'late complaint', ...next }, unset: [],
      } },
      { entity: 'adjustment', action: 'create', args: { id: 'corr_1', values: {
        assignee_ref: 'worker/w_maria', job_ref: 'job/j1',
        corrects_item_ref: `settlement_item/${item.id}`,
        reason: 'late complaint', status: 'pending', currency: 'USD',
        target_collected_by: j.collected_by, eligible_at: NOW(),
        delta_minor: delta, target_price_minor: j.price_minor, target_bps: j.payout_bps,
      } } },
    ] });

    expect(delta).toBe(-4_800);
    expect(run(B.settlementGet, { id: 'rel_1' }).record.net_minor,
      'the frozen obligation is untouched').toBe(settledNet);
    expect(jobRow('j1').payout_minor).toBe(1_200);
  });

  it('RUNNER → the pending adjustment is applied by the NEXT release', () => {
    readyJob('j1', 12_000);
    clock += 4 * DAY;
    release('w_maria', 'rel_1');
    const item = run(B.itemSearch, { filters: { job_ref: 'job/j1' }, limit: 5 }).records[0];
    const j = jobRow('j1');
    run(B.correctionPost, { ops: [
      { entity: 'job', action: 'update', args: {
        id: 'j1', expected_version: PACK.version, expected_revision: j._record.revision,
        set: { payout_bps: 1000, payout_reason: 'late', ...deriveMoney(12_000, 1000, 'runner') },
        unset: [],
      } },
      { entity: 'adjustment', action: 'create', args: { id: 'corr_1', values: {
        assignee_ref: 'worker/w_maria', job_ref: 'job/j1',
        corrects_item_ref: `settlement_item/${item.id}`, reason: 'late', status: 'pending',
        currency: 'USD', target_collected_by: 'runner', eligible_at: NOW(),
        delta_minor: -4_800, target_price_minor: 12_000, target_bps: 5000,
      } } },
    ] });

    readyJob('j2', 10_000);                    // new work in the next period
    clock += 4 * DAY;
    const out = release('w_maria', 'rel_2');

    expect(out.count).toBe(2);                 // one job + one adjustment
    const s = run(B.settlementGet, { id: 'rel_2' }).record;
    expect(s.job_count).toBe(1);
    expect(s.adjustment_count).toBe(1);
    expect(s.adjustment_net_minor).toBe(-4_800);
    expect(s.net_minor, '5000 new work minus the 4800 clawback').toBe(200);
    expect(run(B.adjustmentGet, { id: 'corr_1' }).record.status).toBe('applied');
  });

  it('§6 → the store claims this design leans on: 200-page cap and no-op refusal', () => {
    // Carried over from the retired legacy drive. The release deliberately asks
    // for at most 49, so the cap is never hit in the happy path — but § 6 states
    // it, and a future unbounded query would silently truncate.
    expect(() => run(B.jobSearch, { filters: { assignee_ref: 'worker/w_maria' }, limit: 500 }))
      .toThrow(/limit must be an integer in 1\.\.200/);

    // An update that changes nothing is refused, which is why any status flip in
    // a recovery path must read first and write only on a real transition.
    bookJob('j1', 12_000);
    const j = jobRow('j1');
    expect(() => run(B.jobUpdate, {
      id: 'j1', expected_version: PACK.version, expected_revision: j._record.revision,
      set: { customer: j.customer }, unset: [],
    })).toThrow(/no effective change/);
  });

  it('§10 → the correction replay key refuses a different target under the same ID', () => {
    readyJob('j1', 12_000);
    clock += 4 * DAY;
    release('w_maria', 'rel_1');
    const item = run(B.itemSearch, { filters: { job_ref: 'job/j1' }, limit: 5 }).records[0];
    // ⛔ THE REPLAY KEY ONLY WORKS IF EVERY FIELD IS STABLE ACROSS THE RETRY.
    // `eligible_at` is frozen here on purpose: reading the clock per call makes
    // a "same content" retry differ by a millisecond, and replay-safe `create`
    // then reports a CONFLICT instead of a replay. A recipe must derive this
    // stamp from its stable inputs, never from `now` at each attempt.
    const eligibleAt = NOW();
    const mk = (targetBps: number) => ({
      assignee_ref: 'worker/w_maria', job_ref: 'job/j1',
      corrects_item_ref: `settlement_item/${item.id}`, reason: 'late', status: 'pending',
      currency: 'USD', target_collected_by: 'runner', eligible_at: eligibleAt,
      delta_minor: -4_800, target_price_minor: 12_000, target_bps: targetBps,
    });
    run(B.adjustmentCreate, { id: 'corr_1', values: mk(5000) });
    // Same ID + same content replays; different target content conflicts.
    expect(() => run(B.adjustmentCreate, { id: 'corr_1', values: mk(5000) })).not.toThrow();
    expect(() => run(B.adjustmentCreate, { id: 'corr_1', values: mk(2500) })).toThrow();
  });
});
