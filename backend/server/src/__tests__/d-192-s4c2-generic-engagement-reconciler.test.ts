/** D-192 S4c2 — generic `delta_cursor` engagement reconciler tests.
 *
 *  Proves the reusable de-hardcode against a FAKE delta engagement vendor (no
 *  Dynamics code): the drain → flat-meta projection → `ingestEngagementWithEdges`
 *  write, the delete tombstone (drained-only), the opaque-cursor lifecycle through
 *  the harness `delta` hook (cold / warm / hold-on-partial), and reset recovery.
 *
 *  Spec: D-192 (S4c2). */

import { describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';
import type {
  ConnectionRecord,
  ConnectionVendorEntity,
  EngagementRow,
} from '@recued/contracts';

import {
  buildGenericEngagementReconciler,
  projectFlatMeta,
  readDottedPath,
  type GenericEngagementLeaf,
  type GenericEngagementSlimRecord,
} from '../data/generic-engagement-reconciler.js';
import type { EngagementStore, UpsertEdgeInput } from '../storage/engagement-store.js';
import {
  buildVendorReconciliationTask,
  type ConnectionLookup,
} from '../housekeeping/reconciliation/vendor-reconciler.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// Fakes — a FAKE delta engagement vendor ('acme', entity 'email')
// ────────────────────────────────────────────────────────────────

const FIXED_NOW = 1_700_000_000_000;

type FakeItem =
  | { op: 'file'; id: string; subject?: string; who?: string; modified_at?: number }
  | { op: 'deleted'; id: string };
interface FakePage {
  items: FakeItem[];
  nextRef?: string;
  watermark?: string;
}

/** The declared engagement entity (as the live registry would carry it after the
 *  S4a pack-lift): a `delta_cursor` engagement facet + `source_path` meta_fields. */
const acmeEmailEntity: ConnectionVendorEntity = {
  vendor: 'acme',
  entity: 'email',
  scope: 'connection.api.acme.email',
  display_name: 'acme email',
  meta_fields: [
    { key: 'subject', type: 'string', description: 'Subject', source_path: 'subject' },
    // A DERIVED field (no source_path) — must be skipped by the flat projection.
    { key: 'lifecycle', type: 'string', description: 'Derived lifecycle' },
  ],
  engagement: { capability: 'always', sync_kind: 'delta_cursor' },
} as ConnectionVendorEntity;

interface FakeLeafOptions {
  pages: Record<string, FakePage>;
  coldRef?: string;
  /** Refs whose fetch throws a reset error (expired deltaLink). */
  resetRefs?: Set<string>;
  onProject?: (row: EngagementRow) => void;
}

const fakeLeaf = (opts: FakeLeafOptions): GenericEngagementLeaf => ({
  buildDelta: () => ({
    fetchPage: async (ref: string): Promise<unknown> => {
      if (opts.resetRefs?.has(ref)) throw { reset: true, ref };
      return opts.pages[ref] ?? { items: [] }; // unknown ref ⇒ empty undrained page
    },
    parsePage: (raw: unknown): { items: unknown[]; nextRef?: string; watermark?: string } =>
      raw as FakePage,
    classify: (item: unknown) => {
      const it = item as FakeItem;
      if (it.op === 'file') return { kind: 'file' as const, id: it.id, row: it as unknown as Record<string, unknown> };
      return { kind: 'deleted' as const, id: it.id };
    },
  }),
  coldStartRef: () => opts.coldRef ?? 'cold',
  composeTargetId: (nativeId: string) => `acme_email_${nativeId}`,
  readNativeId: (raw) => {
    const id = (raw as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  },
  readModifiedAt: (raw) => (raw as { modified_at?: number }).modified_at ?? 1000,
  project: ({ connection_id, raw, target_id, meta, now }): EngagementRow => {
    const row: EngagementRow = {
      connection_id,
      target_id,
      vendor: 'acme',
      entity: 'email',
      meta,
      mirror_blob_hash: null,
      authorship: 'user',
      direction: 'outbound',
      dedupe_confidence: 'none',
      lifecycle_state: 'point_in_time',
      event_at: (raw as { modified_at?: number }).modified_at ?? now,
      vendor_created_at: now,
      vendor_modified_at: (raw as { modified_at?: number }).modified_at ?? now,
      ingested_at: now,
      body_state: 'none',
    };
    opts.onProject?.(row);
    return row;
  },
  mapEdges: ({ connection_id, raw, target_id, now }): UpsertEdgeInput[] => {
    const who = (raw as { who?: string }).who;
    if (who === undefined) return [];
    return [
      {
        connection_id,
        engagement_target_id: target_id,
        edge_type: 'owner',
        target_kind: 'user',
        target_id: `acme_user:${who}`,
        vendor: 'acme',
        created_at: now,
      },
    ];
  },
  isResetError: (err) => Boolean((err as { reset?: boolean } | null)?.reset),
});

interface StoreSpy {
  store: EngagementStore;
  ingests: Array<{ row: EngagementRow; edges: ReadonlyArray<UpsertEdgeInput> }>;
  tombstones: Array<{ connection_id: string; target_id: string }>;
}

const fakeEngagementStore = (): StoreSpy => {
  const ingests: StoreSpy['ingests'] = [];
  const tombstones: StoreSpy['tombstones'] = [];
  const store = {
    ingestEngagementWithEdges: (input: { row: EngagementRow; edges: ReadonlyArray<UpsertEdgeInput> }) => {
      ingests.push({ row: input.row, edges: input.edges });
      return {
        row: input.row,
        edges_upserted: input.edges.length,
        edges_tombstoned: 0,
        dedupe_candidates_upserted: 0,
        stale_modstamp: false,
      };
    },
    tombstone: (input: { connection_id: string; target_id: string }) => {
      tombstones.push({ connection_id: input.connection_id, target_id: input.target_id });
      return true;
    },
  } as unknown as EngagementStore;
  return { store, ingests, tombstones };
};

const conn = (name = 'acme-1'): ConnectionRecord => ({
  name,
  kind: 'api',
  display_name: name,
  config: {},
  auth: { type: 'bearer', token: 't' },
  enrolled_at: 1,
  updated_at: 1,
});

/** Drive the reconciler the way the harness does: loadStartRef → walk (collect
 *  yielded slims) → selfIngest each → takeWatermark. Returns what the harness
 *  would persist + observe. */
const driveOnce = async (
  reconciler: ReturnType<typeof buildGenericEngagementReconciler>,
  connection: ConnectionRecord,
  priorToken: string,
): Promise<{ watermark: string | null; ingestedIds: string[] }> => {
  reconciler.delta!.loadStartRef(connection.name, priorToken);
  const slims: GenericEngagementSlimRecord[] = [];
  for await (const slim of reconciler.listUpdatedSince(connection, 0, 100)) {
    slims.push(slim as GenericEngagementSlimRecord);
  }
  for (const slim of slims) reconciler.selfIngest!(connection, connection.name, slim);
  return {
    watermark: reconciler.delta!.takeWatermark(connection.name),
    ingestedIds: slims.map((s) => s.id),
  };
};

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

describe('D-192 S4c2 — readDottedPath', () => {
  it('reads a top-level + nested path, null-safe on a missing segment', () => {
    expect(readDottedPath({ a: 1 }, 'a')).toBe(1);
    expect(readDottedPath({ a: { b: { c: 'x' } } }, 'a.b.c')).toBe('x');
    expect(readDottedPath({ a: {} }, 'a.b.c')).toBeUndefined();
    expect(readDottedPath(null, 'a')).toBeUndefined();
    expect(readDottedPath({ a: 5 }, 'a.b')).toBeUndefined(); // non-object mid-path
  });
});

describe('D-192 S4c2 — projectFlatMeta', () => {
  it('projects only source_path fields, skips derived, omits absent', () => {
    const meta = projectFlatMeta({ subject: 'Hi', extra: 'x' }, acmeEmailEntity);
    expect(meta).toEqual({ subject: 'Hi' }); // `lifecycle` (derived) skipped; `extra` not declared
  });

  it('omits a null / undefined source value (present-fields-only snapshot)', () => {
    expect(projectFlatMeta({ subject: null }, acmeEmailEntity)).toEqual({});
    expect(projectFlatMeta({}, acmeEmailEntity)).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────
// Factory — construction guard
// ────────────────────────────────────────────────────────────────

describe('D-192 S4c2 — buildGenericEngagementReconciler construction', () => {
  it('throws on a non-delta_cursor entity (poll / stream / non-engagement)', () => {
    const { store } = fakeEngagementStore();
    const pollEntity = {
      ...acmeEmailEntity,
      engagement: { capability: 'always', sync_kind: 'poll' },
    } as ConnectionVendorEntity;
    expect(() =>
      buildGenericEngagementReconciler({ entity: pollEntity, engagementStore: store, leaf: fakeLeaf({ pages: {} }) }),
    ).toThrow(/not a delta_cursor engagement entity/);

    const plainEntity = { ...acmeEmailEntity, engagement: undefined } as ConnectionVendorEntity;
    expect(() =>
      buildGenericEngagementReconciler({ entity: plainEntity, engagementStore: store, leaf: fakeLeaf({ pages: {} }) }),
    ).toThrow(/not a delta_cursor engagement entity/);
  });

  it('exposes vendor / entity / delta hook / selfIngest (no hashOf/toMeta)', () => {
    const { store } = fakeEngagementStore();
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: store, leaf: fakeLeaf({ pages: {} }) });
    expect(r.vendor).toBe('acme');
    expect(r.entity).toBe('email');
    expect(r.delta).toBeDefined();
    expect(r.selfIngest).toBeDefined();
    expect(r.hashOf).toBeUndefined();
    expect(r.toMeta).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Factory — the drain → ingest → tombstone → watermark cycle
// ────────────────────────────────────────────────────────────────

describe('D-192 S4c2 — reconcile cycle (drain / ingest / tombstone / cursor)', () => {
  it('cold start: drains from coldStartRef, ingests files with flat meta + edges, tombstones deletes, returns the watermark', async () => {
    const spy = fakeEngagementStore();
    const leaf = fakeLeaf({
      pages: {
        cold: {
          items: [
            { op: 'file', id: 'A', subject: 'Hello', who: 'u1', modified_at: 500 },
            { op: 'file', id: 'B', subject: 'World' },
            { op: 'deleted', id: 'C' },
          ],
          watermark: 'w1',
        },
      },
    });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });

    const out = await driveOnce(r, conn(), '' /* cold */);

    // Upserts A + B ingested with declarative flat meta; C tombstoned (not ingested).
    expect(spy.ingests.map((i) => i.row.target_id)).toEqual(['acme_email_A', 'acme_email_B']);
    expect(spy.ingests[0].row.meta).toEqual({ subject: 'Hello' });
    expect(spy.ingests[0].edges).toHaveLength(1); // owner edge from `who`
    expect(spy.ingests[0].edges[0].target_id).toBe('acme_user:u1');
    expect(spy.ingests[1].edges).toHaveLength(0); // B has no `who`
    expect(spy.tombstones).toEqual([{ connection_id: 'acme-1', target_id: 'acme_email_C' }]);
    // The terminal watermark is what the harness would persist.
    expect(out.watermark).toBe('w1');
    expect(out.ingestedIds).toEqual(['acme_email_A', 'acme_email_B']);
  });

  it('warm cycle: drains from the prior token, not coldStartRef', async () => {
    const spy = fakeEngagementStore();
    const leaf = fakeLeaf({
      pages: {
        cold: { items: [{ op: 'file', id: 'A' }], watermark: 'w1' },
        w1: { items: [{ op: 'file', id: 'D', subject: 'Delta' }], watermark: 'w2' },
      },
    });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });

    const out = await driveOnce(r, conn(), 'w1' /* warm */);
    expect(spy.ingests.map((i) => i.row.target_id)).toEqual(['acme_email_D']);
    expect(out.watermark).toBe('w2');
  });

  it('last-occurrence-wins: an id that ends deleted tombstones (never ingests), even seen as a file first', async () => {
    const spy = fakeEngagementStore();
    const leaf = fakeLeaf({
      pages: {
        cold: {
          items: [
            { op: 'file', id: 'X', subject: 'first' },
            { op: 'deleted', id: 'X' }, // later occurrence wins
          ],
          watermark: 'w1',
        },
      },
    });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });

    await driveOnce(r, conn(), '');
    expect(spy.ingests).toHaveLength(0);
    expect(spy.tombstones).toEqual([{ connection_id: 'acme-1', target_id: 'acme_email_X' }]);
  });

  it('undrained final page: suppresses tombstones + returns null watermark (harness holds prior token)', async () => {
    const spy = fakeEngagementStore();
    const leaf = fakeLeaf({
      pages: {
        // No watermark, no nextRef ⇒ undrained (malformed final page).
        cold: { items: [{ op: 'file', id: 'A', subject: 'a' }, { op: 'deleted', id: 'Z' }] },
      },
    });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });

    const out = await driveOnce(r, conn(), '');
    // Upserts still apply (real records seen), but the delete is suppressed as
    // untrustworthy and the cursor is NOT advanced.
    expect(spy.ingests.map((i) => i.row.target_id)).toEqual(['acme_email_A']);
    expect(spy.tombstones).toHaveLength(0);
    expect(out.watermark).toBeNull();
  });

  it('reset recovery: a WARM walk whose token 410s re-drains once from coldStartRef', async () => {
    const spy = fakeEngagementStore();
    const leaf = fakeLeaf({
      pages: {
        cold: { items: [{ op: 'file', id: 'FRESH', subject: 'rebuilt' }], watermark: 'w-new' },
      },
      resetRefs: new Set(['stale-token']),
    });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });

    const out = await driveOnce(r, conn(), 'stale-token' /* warm, expired */);
    expect(spy.ingests.map((i) => i.row.target_id)).toEqual(['acme_email_FRESH']);
    expect(out.watermark).toBe('w-new');
  });

  it('reset on a COLD walk is a real failure (propagates, no recovery)', async () => {
    const spy = fakeEngagementStore();
    const leaf = fakeLeaf({ pages: {}, coldRef: 'cold', resetRefs: new Set(['cold']) });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });

    await expect(driveOnce(r, conn(), '')).rejects.toMatchObject({ reset: true });
  });

  it('multi-page drain follows nextRef then folds all pages', async () => {
    const spy = fakeEngagementStore();
    const leaf = fakeLeaf({
      pages: {
        cold: { items: [{ op: 'file', id: 'P1' }], nextRef: 'page2' },
        page2: { items: [{ op: 'file', id: 'P2' }], watermark: 'w-final' },
      },
    });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });

    const out = await driveOnce(r, conn(), '');
    expect(spy.ingests.map((i) => i.row.target_id)).toEqual(['acme_email_P1', 'acme_email_P2']);
    expect(out.watermark).toBe('w-final');
  });

  it('apiCallsFor charges the REAL fetched page count, not the ceil(processed/batch) estimate', async () => {
    const spy = fakeEngagementStore();
    // 3 pages, but only 1 processed record (the other two pages are pure tombstones).
    const leaf = fakeLeaf({
      pages: {
        cold: { items: [{ op: 'deleted', id: 'C1' }], nextRef: 'p2' },
        p2: { items: [{ op: 'deleted', id: 'C2' }], nextRef: 'p3' },
        p3: { items: [{ op: 'file', id: 'A', subject: 'a' }], watermark: 'w' },
      },
    });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });
    await driveOnce(r, conn(), ''); // populates the per-connection fetch count (3)

    // Harness estimate would be ceil(1/batch) = 1; the real cost is 3 fetches.
    expect(r.apiCallsFor!(1, 1, 'acme-1')).toBe(3);
    // No per-connection count (different / absent connection) ⇒ fall back to the estimate.
    expect(r.apiCallsFor!(1, 2, 'other')).toBe(2);
    expect(r.apiCallsFor!(1, 5)).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────
// Harness integration — the opaque `{ kind: 'delta' }` cursor path
// ────────────────────────────────────────────────────────────────

const makeDeltaContext = (): HousekeepingContext =>
  ({
    bus: createWarehouseEventBus(),
    now: (): number => FIXED_NOW,
    emitAuditRow: () => {},
    // The selfIngest path never reads enrichmentStore / recipeStore / db — the
    // reconciler owns its engagement store — so a minimal cast ctx is sound.
    enrichmentStore: {} as unknown as HousekeepingContext['enrichmentStore'],
    recipeStore: {} as unknown as HousekeepingContext['recipeStore'],
    db: {} as unknown as HousekeepingContext['db'],
  }) as unknown as HousekeepingContext;

describe('D-192 S4c2 — harness delta cursor lifecycle', () => {
  const lookup: ConnectionLookup = (name) => conn(name);

  it('cold `{ kind: complete }` cursor → walks from scratch + persists `{ kind: delta, token }`', async () => {
    const spy = fakeEngagementStore();
    const leaf = fakeLeaf({ pages: { cold: { items: [{ op: 'file', id: 'A', subject: 'a' }], watermark: 'w1' } } });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });
    const task = buildVendorReconciliationTask({ reconciler: r, connection_name: 'acme-1', lookupConnection: lookup });

    const result = await task.step(makeDeltaContext(), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'delta', token: 'w1' });
    expect(spy.ingests.map((i) => i.row.target_id)).toEqual(['acme_email_A']);
  });

  it('warm `{ kind: delta, token }` cursor → drains from that token', async () => {
    const spy = fakeEngagementStore();
    const leaf = fakeLeaf({
      pages: {
        cold: { items: [{ op: 'file', id: 'OLD' }], watermark: 'w1' },
        w1: { items: [{ op: 'file', id: 'NEW', subject: 'n' }], watermark: 'w2' },
      },
    });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });
    const task = buildVendorReconciliationTask({ reconciler: r, connection_name: 'acme-1', lookupConnection: lookup });

    const result = await task.step(makeDeltaContext(), { kind: 'delta', token: 'w1' }, 60_000);
    expect(result.cursor).toEqual({ kind: 'delta', token: 'w2' });
    expect(spy.ingests.map((i) => i.row.target_id)).toEqual(['acme_email_NEW']);
  });

  it('undrained walk that fully ingests within budget still HOLDS the prior token (complete-branch null watermark)', async () => {
    const spy = fakeEngagementStore();
    // Warm token `w1` → a page with NO watermark + NO nextRef ⇒ undrained. Rows
    // ingest fully within budget, so the harness reaches the `complete` branch —
    // where `takeWatermark()` is null and the cursor falls back to the prior token.
    const leaf = fakeLeaf({ pages: { w1: { items: [{ op: 'file', id: 'A', subject: 'a' }] } } });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });
    const task = buildVendorReconciliationTask({ reconciler: r, connection_name: 'acme-1', lookupConnection: lookup });

    const result = await task.step(makeDeltaContext(), { kind: 'delta', token: 'w1' }, 60_000);
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'delta', token: 'w1' }); // held, not advanced
    expect(spy.ingests.map((i) => i.row.target_id)).toEqual(['acme_email_A']);
  });

  it('no_work (connection unenrolled) HOLDS the prior delta token', async () => {
    const spy = fakeEngagementStore();
    const leaf = fakeLeaf({ pages: {} });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });
    const task = buildVendorReconciliationTask({ reconciler: r, connection_name: 'gone', lookupConnection: () => null });

    const result = await task.step(makeDeltaContext(), { kind: 'delta', token: 'held' }, 60_000);
    expect(result.status).toBe('yield');
    expect(result.cursor).toEqual({ kind: 'delta', token: 'held' });
  });

  it('over-budget wall-clock does NOT abandon a drained delta batch — ingests all + advances (no wedge)', async () => {
    // A delta drain is atomic + only advances the token on a FULL ingest, so the
    // harness must NOT budget-yield mid-ingest (that would drop already-fetched rows
    // AND hold the token → re-drain forever = wedge). Even with the wall-clock blown
    // past budget after the first record, BOTH records ingest and the token advances.
    const spy = fakeEngagementStore();
    const leaf = fakeLeaf({
      pages: {
        w1: { items: [{ op: 'file', id: 'A' }, { op: 'file', id: 'B' }], watermark: 'w2' },
      },
    });
    const r = buildGenericEngagementReconciler({ entity: acmeEmailEntity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });
    const task = buildVendorReconciliationTask({ reconciler: r, connection_name: 'acme-1', lookupConnection: lookup });

    let calls = 0;
    const ctx = {
      ...makeDeltaContext(),
      now: (): number => {
        calls += 1;
        return calls === 1 ? FIXED_NOW : FIXED_NOW + 10_000; // every check after startedAt is way past the 60ms budget
      },
    } as unknown as HousekeepingContext;

    const result = await task.step(ctx, { kind: 'delta', token: 'w1' }, 60);
    expect(result.status).toBe('complete');
    expect(spy.ingests.map((i) => i.row.target_id)).toEqual(['acme_email_A', 'acme_email_B']);
    expect(result.cursor).toEqual({ kind: 'delta', token: 'w2' }); // advanced — the drain completed
  });

  it('a numeric-time (non-delta) reconciler is unchanged — still persists `{ kind: time }`', async () => {
    const { bus } = { bus: createWarehouseEventBus() };
    // A minimal default-write reconciler (no `delta`): the regression guard that the
    // opaque-cursor branch never touches the numeric path.
    const r = {
      vendor: 'plain',
      entity: 'deal',
      default_cadence: '6h' as const,
      async *listUpdatedSince() {
        /* no records */
      },
      hashOf: () => 'h',
      toMeta: () => ({ snapshot_at: FIXED_NOW, snapshot_hash: 'h' }),
    };
    const task = buildVendorReconciliationTask({ reconciler: r, connection_name: 'p-1', lookupConnection: lookup });
    const ctx = { ...makeDeltaContext(), bus } as unknown as HousekeepingContext;

    const result = await task.step(ctx, { kind: 'time', last_seen_at: 42 }, 60_000);
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'time', last_seen_at: 42 });
  });
});
