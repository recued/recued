/** D-192 — silent-staleness observability.
 *
 *  The failure being made visible: a declared field path that does not exist on
 *  the vendor's records resolves to `undefined` SILENTLY. If every
 *  `remote.hash_fields` path is such a phantom, the record hash is a constant,
 *  every row reads "unchanged", and the mirror is FROZEN forever — a Source that
 *  syncs cleanly, reports no error, and never updates again.
 *
 *  These tests prove the signal FIRES on that, and — just as important — that it
 *  stays QUIET on the two things that look similar but are fine: a legitimately
 *  sparse field, and a Source that simply has not been touched. */

import { describe, expect, it } from 'vitest';

import {
  FIELD_HEALTH_MIN_ROWS,
  declaredLoadBearingPaths,
  describeStalenessSignal,
  mergeFieldHealth,
  stalenessSignal,
  tallyCycleFieldHealth,
  type WorkEntitySourceFieldHealth,
} from '../work-entity-source-field-health.js';

const decl = (over: Record<string, unknown> = {}) => ({
  remote: {
    entity: 'task',
    id: 'id',
    version: { kind: 'updated_at' as const, field: 'updatedAt' },
    hash_fields: ['title', 'status', 'updatedAt'],
    ...(over.remote as Record<string, unknown> ?? {}),
  },
  sync: { mode: 'read_only', depth: 'meta', tombstones: 'none', stale_after_ms: 1, ...(over.sync as Record<string, unknown> ?? {}) },
} as unknown as Parameters<typeof declaredLoadBearingPaths>[0]);

const rows = (n: number, make: (i: number) => Record<string, unknown>) =>
  Array.from({ length: n }, (_, i) => make(i));

const tallyOver = (
  d: Parameters<typeof declaredLoadBearingPaths>[0],
  rs: ReadonlyArray<Record<string, unknown>>,
): WorkEntitySourceFieldHealth =>
  mergeFieldHealth(null, tallyCycleFieldHealth(declaredLoadBearingPaths(d), rs));

describe('declaredLoadBearingPaths', () => {
  it('takes version + hash + native tombstone, and dedupes the version/hash overlap', () => {
    const paths = declaredLoadBearingPaths(decl({
      remote: {
        entity: 'task', id: 'id',
        version: { kind: 'updated_at', field: 'updatedAt' },
        hash_fields: ['title', 'updatedAt'], // updatedAt is BOTH — conventionally
      },
      sync: { mode: 'read_only', depth: 'meta', tombstones: 'native', tombstone_field: 'deleted', stale_after_ms: 1 },
    }));
    expect(paths).toEqual([
      { path: 'updatedAt', role: 'version' }, // version outranks hash — the stronger reading
      { path: 'title', role: 'hash' },
      { path: 'deleted', role: 'tombstone' },
    ]);
  });

  it('omits a tombstone_field the Source does not actually use', () => {
    // tombstones: 'none' — the field is inert, so its silence means nothing.
    const paths = declaredLoadBearingPaths(decl({
      remote: {
        entity: 'task', id: 'id',
        version: { kind: 'updated_at', field: 'updatedAt' },
        hash_fields: ['title'],
      },
      // tombstones: 'none' (the default fixture) — the field is inert.
      sync: { mode: 'read_only', depth: 'meta', tombstones: 'none', tombstone_field: 'deleted', stale_after_ms: 1 },
    }));
    expect(paths.map((p) => p.path)).toEqual(['updatedAt', 'title']);
  });
});

describe('the silent-staleness alarm', () => {
  it('🔴 FIRES when every hash field is a phantom — the mirror is frozen', () => {
    // The declaration names paths the vendor does not return. Every hash input is
    // undefined ⇒ the record hash is a constant ⇒ nothing can ever be detected as
    // changed. The Source syncs "successfully" forever and never updates.
    const phantom = decl({
      remote: {
        entity: 'task', id: 'id',
        version: { kind: 'updated_at', field: 'updated_at' }, // vendor sends updatedAt
        hash_fields: ['fields.title', 'fields.status'],       // vendor has no `fields`
      },
    });
    const health = tallyOver(phantom, rows(40, (i) => ({
      id: `t${i}`, title: `Task ${i}`, status: 'open', updatedAt: '2026-07-14T00:00:00Z',
    })));

    const signal = stalenessSignal(health);
    expect(signal.change_detection_dead).toBe(true);
    expect(signal.never_valued.map((n) => n.path).sort())
      .toEqual(['fields.status', 'fields.title', 'updated_at']);

    const msg = describeStalenessSignal('vendor.acme.task', signal);
    expect(msg).toContain('FROZEN');
    expect(msg).toContain('silently stale');
    expect(msg).toContain("'fields.title' (hash) — a value on 0 of 40 rows");
  });

  it('stays QUIET on a healthy Source, however boring its data', () => {
    const health = tallyOver(decl(), rows(40, (i) => ({
      id: `t${i}`, title: `Task ${i}`, status: 'open', updatedAt: '2026-07-14T00:00:00Z',
    })));
    expect(stalenessSignal(health)).toEqual({ never_valued: [], change_detection_dead: false });
    expect(describeStalenessSignal('s', stalenessSignal(health))).toBeNull();
  });

  it('does NOT fire on a Source nobody has touched — the confounder the naive signal fails on', () => {
    // "Never observed a change" would flag this Source. It is perfectly healthy:
    // every declared path carries a value; the user simply has not edited a task.
    // This is exactly why the direct signal beats the statistical one.
    const health = tallyOver(decl(), rows(200, (i) => ({
      id: `t${i}`, title: `Task ${i}`, status: 'open', updatedAt: '2020-01-01T00:00:00Z',
    })));
    expect(stalenessSignal(health).change_detection_dead).toBe(false);
    expect(stalenessSignal(health).never_valued).toEqual([]);
  });

  it('does not raise the ALARM for ONE dead hash field — change detection still works', () => {
    // `body` is legitimately empty on every task. It contributes nothing to the
    // hash, which is worth SAYING — but the other hash fields still move, so the
    // Source is not frozen. Report the fact; do not cry frozen.
    const d = decl({
      remote: {
        entity: 'task', id: 'id',
        version: { kind: 'updated_at', field: 'updatedAt' },
        hash_fields: ['title', 'body'],
      },
    });
    const health = tallyOver(d, rows(40, (i) => ({
      id: `t${i}`, title: `Task ${i}`, updatedAt: '2026-07-14T00:00:00Z',
    })));
    const signal = stalenessSignal(health);
    expect(signal.change_detection_dead).toBe(false);           // NOT the alarm
    expect(signal.never_valued.map((n) => n.path)).toEqual(['body']); // but do say it
    expect(describeStalenessSignal('s', signal)).not.toContain('FROZEN');
  });

  it('counts PRESENCE, not truthiness — `false` and `0` are values', () => {
    // A tombstone flag is normally present and `false`. Counting truthiness would
    // report every healthy Source as having a phantom tombstone field.
    const d = decl({
      remote: {
        entity: 'task', id: 'id',
        version: { kind: 'updated_at', field: 'updatedAt' },
        hash_fields: ['count'],
      },
      sync: { mode: 'read_only', depth: 'meta', tombstones: 'native', tombstone_field: 'deleted', stale_after_ms: 1 },
    });
    const health = tallyOver(d, rows(40, () => ({
      updatedAt: 'x', count: 0, deleted: false,
    })));
    expect(stalenessSignal(health).never_valued).toEqual([]);
  });

  it('says NOTHING below the row floor — too little evidence to accuse a path', () => {
    const phantom = decl({
      remote: { entity: 'task', id: 'id', version: { kind: 'updated_at', field: 'nope' }, hash_fields: ['also.nope'] },
    });
    const thin = tallyOver(phantom, rows(FIELD_HEALTH_MIN_ROWS - 1, () => ({ id: 'x' })));
    expect(stalenessSignal(thin)).toEqual({ never_valued: [], change_detection_dead: false });

    // …and speaks the moment there IS enough.
    const enough = mergeFieldHealth(
      thin,
      tallyCycleFieldHealth(declaredLoadBearingPaths(phantom), rows(1, () => ({ id: 'x' }))),
    );
    expect(stalenessSignal(enough).change_detection_dead).toBe(true);
  });
});

describe('mergeFieldHealth — the tally accumulates across cycles', () => {
  it('adds rows and values cycle over cycle', () => {
    const d = decl();
    const c1 = tallyCycleFieldHealth(declaredLoadBearingPaths(d), rows(10, (i) => ({
      title: `t${i}`, status: 'open', updatedAt: 'x',
    })));
    const c2 = tallyCycleFieldHealth(declaredLoadBearingPaths(d), rows(15, (i) => ({
      title: `t${i}`, status: 'open', updatedAt: 'x',
    })));
    const merged = mergeFieldHealth(mergeFieldHealth(null, c1), c2);
    expect(merged.rows_seen).toBe(25);
    expect(merged.paths.title.with_value).toBe(25);
  });

  it('DROPS evidence for a path the declaration no longer names, and starts a new path at zero', () => {
    // Otherwise a re-authored declaration inherits the old one's evidence — and
    // would either exonerate a freshly-introduced phantom, or keep accusing a
    // path that no longer exists.
    const before = tallyOver(decl(), rows(30, () => ({ title: 't', status: 'open', updatedAt: 'x' })));
    expect(before.paths.status.with_value).toBe(30);

    const reAuthored = decl({
      remote: {
        entity: 'task', id: 'id',
        version: { kind: 'updated_at', field: 'updatedAt' },
        hash_fields: ['title', 'state'], // `status` dropped; `state` is NEW (and phantom)
      },
    });
    const after = mergeFieldHealth(
      before,
      tallyCycleFieldHealth(declaredLoadBearingPaths(reAuthored), rows(30, () => ({
        title: 't', status: 'open', updatedAt: 'x',
      }))),
    );
    expect(after.paths.status).toBeUndefined();       // gone with its declaration
    expect(after.paths.state.with_value).toBe(0);     // new path, no inherited credit
    expect(after.paths.title.with_value).toBe(60);    // surviving path keeps its evidence
    expect(stalenessSignal(after).never_valued.map((n) => n.path)).toEqual(['state']);
  });
});
