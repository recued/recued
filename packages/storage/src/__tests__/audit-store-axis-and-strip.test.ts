/** D-153 P1 / D-120 — the event axis, the write-time strip, and the trim edge.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18). 23 mutations of the store in
 *  `packages/storage/src/audit.ts`; nine survived. The largest cluster was the
 *  ENTIRE event-axis ordering — `eventAxisTs`, its descending comparator, and
 *  the axis selector could each be deleted with every suite green.
 *
 *  ⛔ THAT AXIS IS THE D-153 "Codex adversarial-review finding #4" FIX. Its
 *  whole purpose, in the store's own words, is that "backfilled rows whose
 *  `event_at` predates ingestion still surface in real-world chronology". A
 *  backfill is precisely the case where the two axes DISAGREE — and every
 *  existing fixture sets only `now`, so the two agreed on every row and the
 *  distinction was untestable by construction. */

import { describe, expect, it } from 'vitest';

import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditEntryInput,
  type AuditLogStore,
} from '../index.js';

const mkLog = (opts?: Parameters<typeof createAuditLogStore>[2]): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
    opts,
  );

const base = (over: Partial<AuditEntryInput> = {}): AuditEntryInput => ({
  recipe_id: 'r',
  recipe_hash: 'h',
  commit_status: 'succeeded',
  duration_ms: 0,
  errors: [],
  ...over,
});

/** A row whose EVENT time differs from its INGESTION time — the backfill
 *  shape, and the only shape where the two axes disagree. */
const backfilled = async (
  log: AuditLogStore,
  run_id: string,
  ingestedAt: number,
  eventAt: number,
): Promise<void> => {
  const e = buildAuditEntry(base({ run_id, correlation_id: 'c-1', now: ingestedAt }));
  await log.append({ ...e, event_at: eventAt } as AuditEntry);
};

describe('the event axis orders by when it HAPPENED, not when we heard', () => {
  it('⛔⛔ a backfilled row sorts by event_at on the event axis', async () => {
    const log = mkLog();
    // Ingested LAST, happened FIRST — the backfill catching up.
    await backfilled(log, 'live', 1_000, 1_000);
    await backfilled(log, 'backfill', 9_000, 500);

    const byEvent = await log.listByCorrelation('c-1', 10, 'event');
    expect(
      byEvent.map((e) => e.run_id),
      'the event axis did not order by event_at',
    ).toEqual(['live', 'backfill']);
  });

  it('⛔ and the INGESTION axis still orders by started_at', async () => {
    // The complement: without it, "the event axis works" could be satisfied by
    // an implementation that ignores the axis argument entirely.
    const log = mkLog();
    await backfilled(log, 'live', 1_000, 1_000);
    await backfilled(log, 'backfill', 9_000, 500);

    const byIngestion = await log.listByCorrelation('c-1', 10, 'ingestion');
    expect(
      byIngestion.map((e) => e.run_id),
      'the two axes returned the same order — one of them is not being applied',
    ).toEqual(['backfill', 'live']);
  });

  it('⛔ an event_at of ZERO is a real event time, not a missing one', async () => {
    // ⚠ `event_at ?? started_at`, never `||`. The unix epoch is a legitimate
    // (if odd) event time, and a truthiness fallback would silently re-date the
    // row to its ingestion time — which is exactly the conflation the axis
    // exists to undo.
    const log = mkLog();
    await backfilled(log, 'epoch-event', 5_000, 0);
    await backfilled(log, 'later-event', 1_000, 2_000);

    const byEvent = await log.listByCorrelation('c-1', 10, 'event');
    expect(
      byEvent.map((e) => e.run_id),
      'an event_at of 0 was treated as absent and fell back to started_at',
    ).toEqual(['later-event', 'epoch-event']);
  });

  it('⚠ a row with NO event_at falls back to started_at', async () => {
    const log = mkLog();
    await log.append(buildAuditEntry(base({ run_id: 'no-event', correlation_id: 'c-1', now: 7_000 })));
    await backfilled(log, 'has-event', 1_000, 1_000);
    const byEvent = await log.listByCorrelation('c-1', 10, 'event');
    expect(byEvent.map((e) => e.run_id)).toEqual(['no-event', 'has-event']);
  });
});

describe('the write-time strip removes EMPTY, never merely falsy', () => {
  it('⛔⛔ an empty-string trigger_url is KEPT — it is a real value', async () => {
    // The store's own comment: "`false` and `0` are NOT empty… a `trigger_url:
    // ''` would be a real (if odd) value and is kept." A truthiness check would
    // strip it, and the reader cannot tell a stripped field from one that was
    // never set.
    const log = mkLog();
    await log.append(buildAuditEntry(base({ run_id: 'empty-url', trigger_url: '' })));
    const got = await log.get('empty-url');
    expect('trigger_url' in (got ?? {}), 'an empty-string trigger_url was stripped').toBe(true);
    expect(got?.trigger_url).toBe('');
  });

  it('⛔ a NON-EMPTY errors array is kept', async () => {
    const log = mkLog();
    const e = buildAuditEntry(base({ run_id: 'has-errors' }));
    await log.append({
      ...e,
      errors: [{ code: 'boom' }] as unknown as AuditEntry['errors'],
    });
    const got = await log.get('has-errors');
    expect(got?.errors, 'a populated errors array was stripped').toHaveLength(1);
  });

  it('⚠ and the two genuinely-empty cases are still stripped', async () => {
    const log = mkLog();
    await log.append(buildAuditEntry(base({ run_id: 'empty' })));
    const got = await log.get('empty');
    expect('trigger_url' in (got ?? {})).toBe(false);
    expect('errors' in (got ?? {})).toBe(false);
  });
});

describe('the reserve flag and the trim edge', () => {
  it("⛔ an entry's OWN reserve flag is honoured with no per-append option", async () => {
    // The per-append override has tests; the entry-level default did not, so
    // dropping the fallback was invisible.
    const log = mkLog({ maxEntries: 1 });
    await log.append({
      ...buildAuditEntry(base({ run_id: 'reserved', now: 1_000 })),
      reserve: true,
    } as AuditEntry);
    await log.append(buildAuditEntry(base({ run_id: 'ordinary-1', now: 2_000 })));
    await log.append(buildAuditEntry(base({ run_id: 'ordinary-2', now: 3_000 })));
    expect(
      await log.get('reserved'),
      'a reserve row was trimmed — reserve rows never count toward the trim budget',
    ).toBeDefined();
  });

  it('⛔ the trim fires only ABOVE maxEntries, not at it', async () => {
    // `<=` not `<`. Off by one and the store keeps one row fewer than the
    // caller asked for, permanently.
    const log = mkLog({ maxEntries: 2 });
    await log.append(buildAuditEntry(base({ run_id: 'a', now: 1_000 })));
    await log.append(buildAuditEntry(base({ run_id: 'b', now: 2_000 })));
    expect(await log.get('a'), 'a row was trimmed at exactly maxEntries').toBeDefined();
    expect(await log.get('b')).toBeDefined();
  });
});

/** ⚠ The byte counter feeds `audit.quota.bytes`, and NOTHING reconciles it
 *  against the disk. Every over- or under-count is permanent: the quota either
 *  starts evicting a log that is smaller than it thinks, or never fires on one
 *  that is larger. The store's own comment makes the claim — "the gate and the
 *  trigger-maintained counter must both agree with what actually landed on
 *  disk" — but no test read the delta, so both halves of the arithmetic (the
 *  STRIPPED size, and the SUBTRACTION of the previous row) were free.
 *
 *  ⛔ Assert against the ROUND-TRIPPED row, never against a hand-computed
 *  number: a literal would pin today's field list and re-break on every schema
 *  change, and — worse — it could agree with the code while both disagree with
 *  the disk. The row that comes back out IS what landed. */
describe('the byte counter agrees with what landed on disk', () => {
  const sizeOf = (v: unknown): number => JSON.stringify(v).length;

  const withMeter = (): { log: AuditLogStore; deltas: number[] } => {
    const deltas: number[] = [];
    const log = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
      { onBytesChanged: (d) => deltas.push(d) },
    );
    return { log, deltas };
  };

  it('⛔⛔ a new row is sized STRIPPED, not as it arrived', async () => {
    // `buildAuditEntry` always emits `trigger_url: null`, and the fixture
    // always emits `errors: []` — so every ordinary row is stripped, and
    // sizing the input instead of the output over-reports on ALL of them.
    const { log, deltas } = withMeter();
    await log.append(buildAuditEntry(base({ run_id: 'sized', trigger_url: null })));

    const landed = await log.get('sized');
    expect(deltas).toHaveLength(1);
    expect(
      deltas[0],
      'the reported delta does not match the row that actually landed',
    ).toBe(sizeOf(landed));
  });

  it('⛔⛔ an OVERWRITE reports the DIFFERENCE, not the whole new row', async () => {
    const { log, deltas } = withMeter();
    await log.append(buildAuditEntry(base({ run_id: 'twice', recipe_id: 'r' })));
    const first = sizeOf(await log.get('twice'));

    // Same run_id, materially longer payload — a re-write, as a retry or a
    // late status flip produces.
    await log.append(
      buildAuditEntry(base({ run_id: 'twice', recipe_id: 'r'.repeat(64) })),
    );
    const second = sizeOf(await log.get('twice'));

    expect(second).toBeGreaterThan(first);
    expect(deltas).toHaveLength(2);
    expect(
      deltas[1],
      'an overwrite double-counted — the previous row was never subtracted',
    ).toBe(second - first);
    expect(
      deltas[0] + deltas[1],
      'the running total drifted from the on-disk size',
    ).toBe(second);
  });

  it('⛔ a no-op re-write reports NOTHING at all', async () => {
    // Zero is not a small delta, it is an absence. Reporting it wakes the
    // quota trigger on a write that changed nothing.
    const { log, deltas } = withMeter();
    const row = buildAuditEntry(base({ run_id: 'idempotent', now: 1_000 }));
    await log.append(row);
    await log.append(row);
    expect(deltas, 'a zero delta was reported to the quota trigger').toHaveLength(1);
  });
});
