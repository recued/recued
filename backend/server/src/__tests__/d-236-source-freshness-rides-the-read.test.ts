/** D-236 — a recipe can see how current the source it just read actually is.
 *
 *  WHY THIS EXISTS. `last_synced_at` has been stored per collection instance
 *  since D-110 and `CollectionHealth` has aggregated it since Phase D — and in
 *  2,200 recipes NOTHING consumed either. The fact was never missing; it was
 *  being DROPPED in transit, by a one-line narrowing in the executor-config
 *  closure (`return { records: res.records }`). So a recipe inferring
 *  non-occurrence from a bounded window — "no renewal notice", "no reply in 3
 *  days" — could not distinguish *it did not happen* from *it has not arrived*,
 *  and reported success either way.
 *
 *  Driven and reproduced end-to-end before this fix:
 *  `backend/server/src/dev/so1-absence-under-lag-drive.ts`. Two arms differing
 *  ONLY in what had synced produced different owner-facing decisions with both
 *  runs green, and `audit-subscriptions-from-mail` kept firing an identical
 *  notification while silently dropping the larger of two subscriptions.
 *
 *  ⛔ THE JOIN IS THE POINT. Three of these tests could pass while a recipe
 *  still sees nothing: the derivation is pure, the handler is one layer, the
 *  kernel is another. The test that matters is the LAST one, which runs the
 *  real kernel adapter over the real handler and asserts the field arrives at
 *  the shape a recipe step actually reads.
 *  ⇒ [[feedback_two_suites_stubbing_the_same_boundary_cover_everything_but_the_join]]
 */

import { describe, expect, it } from 'vitest';
import {
  COLLECTION_SOURCE_STALE_AFTER_MS,
  collectionSourceFreshnessOf,
  deriveCollectionSourceFreshness,
} from '@recued/contracts';
import type {
  CollectionHealth,
  CollectionPlatform,
  CollectionRecord,
  CollectionSourceFreshness,
} from '@recued/contracts';
import type { StorageGate } from '@recued/storage-gate';
import { createKernelAdapter, type KernelDispatchers } from '@recued/ingredients';

import { createCollectionRegistry } from '../collections/registry.js';
import type { Collection, CollectionSyncAdapter } from '../collections/types.js';
import {
  handleCollectionGet,
  handleCollectionList,
  handleCollectionSearch,
} from '../collections/collection-handler.js';
import {
  handleCalendarGet,
  handleCalendarList,
  handleCalendarSearch,
} from '../collections/calendar/calendar-dispatcher.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

/** The kernel's `ResolvedCall` shape, matching `file-kernel.test.ts`'s helper.
 *  ⛔ Built rather than cast: an `as ResolvedCall` on a partial object compiles
 *  under vitest and FAILS `npm run typecheck:tests`, which is a separate CI
 *  member from the suite. */
const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

const health = (over: Partial<CollectionHealth> = {}): CollectionHealth => ({
  platform: 'mail',
  slug: 'primary',
  last_indexed_at: NOW - 5 * MIN,
  pending_queue_size: 0,
  error_count_24h: 0,
  state: 'idle',
  ...over,
});

// ────────────────────────────────────────────────────────────────
// 1. The pure derivation
// ────────────────────────────────────────────────────────────────

describe('D-236 — deriveCollectionSourceFreshness', () => {
  it('a recently-synced healthy instance is fresh, and reports its age', () => {
    const f = deriveCollectionSourceFreshness(health(), NOW);
    expect(f).toEqual<CollectionSourceFreshness>({
      last_success_at: NOW - 5 * MIN,
      age_ms: 5 * MIN,
      degraded: false,
      pending: 0,
      stale: false,
    });
  });

  it('a never-synced instance reads never + stale, NOT age 0', () => {
    // ⛔ `last_indexed_at: 0` is documented as "before the first successful
    //    sync". Reporting that as `age_ms: NOW` (or worse, 0 = "just synced")
    //    would make an instance that has never run look like the freshest one
    //    in the system. It must read `null` and fail toward stale.
    const f = deriveCollectionSourceFreshness(health({ last_indexed_at: 0 }), NOW);
    expect(f.last_success_at).toBeNull();
    expect(f.age_ms).toBeNull();
    expect(f.stale).toBe(true);
  });

  it('a missing instance (null health) fails toward stale, never toward fresh', () => {
    // The only safe direction for a fact whose whole purpose is to qualify an
    // absence: "I could not tell you" must never render as "it is current".
    const f = deriveCollectionSourceFreshness(null, NOW);
    expect(f).toEqual<CollectionSourceFreshness>({
      last_success_at: null, age_ms: null, degraded: false, pending: 0, stale: true,
    });
  });

  it('a backlog makes a JUST-SYNCED instance stale — no timestamp can say this', () => {
    // The strongest available "this read is incomplete" signal, and the only
    // one that does not depend on a threshold: the adapter itself reports
    // records still outstanding.
    const f = deriveCollectionSourceFreshness(
      health({ last_indexed_at: NOW, pending_queue_size: 12 }),
      NOW,
    );
    expect(f.age_ms).toBe(0);
    expect(f.pending).toBe(12);
    expect(f.stale).toBe(true);
  });

  it.each<[string, Partial<CollectionHealth>]>([
    ['auth expired', { auth_state: 'expired' }],
    ['auth unauthorized', { auth_state: 'unauthorized' }],
    ['auth degraded', { auth_state: 'degraded' }],
    ['adapter in error', { state: 'error' }],
    ['errors in the last 24h', { error_count_24h: 3 }],
  ])('%s ⇒ degraded + stale even when the timestamp is recent', (_label, over) => {
    const f = deriveCollectionSourceFreshness(health(over), NOW);
    expect(f.degraded).toBe(true);
    expect(f.stale).toBe(true);
  });

  it('healthy auth_state does not degrade, and absent auth_state is not a fault', () => {
    expect(deriveCollectionSourceFreshness(health({ auth_state: 'healthy' }), NOW).degraded)
      .toBe(false);
    // Phase D collections that have not been re-emitted carry no auth_state at
    // all (contracts documents this). Absent must not read as unhealthy.
    expect(deriveCollectionSourceFreshness(health(), NOW).degraded).toBe(false);
  });

  it('crosses to stale exactly at the threshold, and honours a caller override', () => {
    const at = deriveCollectionSourceFreshness(
      health({ last_indexed_at: NOW - COLLECTION_SOURCE_STALE_AFTER_MS }), NOW,
    );
    expect(at.stale).toBe(false); // `>` not `>=` — exactly at the bound is still fresh
    const past = deriveCollectionSourceFreshness(
      health({ last_indexed_at: NOW - COLLECTION_SOURCE_STALE_AFTER_MS - 1 }), NOW,
    );
    expect(past.stale).toBe(true);
    // A recipe whose decision window is tighter than the default can pass its own.
    expect(deriveCollectionSourceFreshness(health(), NOW, 60_000).stale).toBe(true);
  });

  it('never reports a negative age when a clock skews backwards', () => {
    const f = deriveCollectionSourceFreshness(health({ last_indexed_at: NOW + 10 * MIN }), NOW);
    expect(f.age_ms).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. The handler returns it, derived from the collection's own health()
// ────────────────────────────────────────────────────────────────

const RECORD: CollectionRecord = {
  record_id: 'm1',
  collection: 'mail',
  hot_fields: { subject: 'hello' },
} as unknown as CollectionRecord;

const stub = (
  over: { health?: () => CollectionHealth; platform?: CollectionPlatform } = {},
): Collection => {
  const sync: CollectionSyncAdapter = { start: async () => {}, stop: async () => {} };
  return {
    platform: over.platform ?? 'mail',
    slug: 'primary',
    gate: {} as StorageGate,
    sync,
    upsert: () => {},
    delete: () => true,
    get: () => RECORD,
    list: () => [RECORD],
    search: () => [],
    health: over.health ?? (() => health()),
    runRetention: async () => ({ scanned: 0, pruned: 0, bytes_reclaimed: 0 }),
  } as unknown as Collection;
};

const listVia = async (collection: Collection): Promise<{
  records: CollectionRecord[];
  source_freshness: CollectionSourceFreshness;
}> => {
  const registry = createCollectionRegistry();
  registry.register(collection);
  return handleCollectionList({ registry, now: () => NOW }, { platform: 'mail', slug: 'primary' });
};

describe('D-236 — handleCollectionList carries the verdict out with the records', () => {
  it('derives the verdict from the collection instance it just read', async () => {
    const res = await listVia(stub({ health: () => health({ pending_queue_size: 4 }) }));
    expect(res.records).toHaveLength(1);
    expect(res.source_freshness.pending).toBe(4);
    expect(res.source_freshness.stale).toBe(true);
    expect(res.source_freshness.last_success_at).toBeGreaterThan(0);
  });

  it('a throwing health() degrades to stale WITHOUT failing the read', async () => {
    // ⛔ The read the caller actually asked for must survive a misbehaving
    //    adapter — same policy handleCollectionListEndpoints already applies.
    //    But the verdict must not silently read "fine".
    const res = await listVia(stub({
      health: () => { throw new Error('adapter exploded'); },
    }));
    expect(res.records).toHaveLength(1);
    expect(res.source_freshness.stale).toBe(true);
    expect(res.source_freshness.last_success_at).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 3. THE JOIN — the real kernel over the real handler, at the shape a
//    recipe step reads. This is the test the other three cannot replace.
// ────────────────────────────────────────────────────────────────

describe('D-236 — the verdict survives the whole path to a recipe step', () => {
  const kernelOver = async (collection: Collection): Promise<Record<string, unknown>> => {
    const registry = createCollectionRegistry();
    registry.register(collection);
    const dispatchers: KernelDispatchers = {
      // Byte-for-byte the production closure in wire-executor-config.ts.
      collectionList: async (input) => {
        const res = await handleCollectionList({ registry, now: () => NOW }, input);
        return { records: res.records, source_freshness: res.source_freshness };
      },
    };
    const adapter = createKernelAdapter(dispatchers);
    return await adapter(mkCall('email-list', { slug: 'primary' })) as Record<string, unknown>;
  };

  it('`{{step.<id>.source_freshness.age_ms}}` is reachable from the step that read the data', async () => {
    const out = await kernelOver(stub({ health: () => health({ last_indexed_at: NOW - 90 * MIN }) }));

    // The records still arrive exactly as before — this is additive.
    expect(Array.isArray(out.records)).toBe(true);
    expect((out.records as unknown[]).length).toBe(1);

    // …and the verdict rides with them, at the path a recipe references.
    const f = out.source_freshness as CollectionSourceFreshness;
    expect(f).toBeDefined();
    expect(typeof f.age_ms).toBe('number');
    expect(f.last_success_at).toBe(NOW - 90 * MIN);
    // A recipe compares `age_ms` against ITS OWN window rather than trusting
    // the default threshold — 90 min is fine for "this year", fatal for
    // "anything in the last hour".
    expect(f.age_ms!).toBeGreaterThan(60 * MIN);
    expect(f.stale).toBe(false); // under the 6h default
  });

  it('a dispatcher that does not supply it leaves the key ABSENT, not null', async () => {
    // Recipes are null-safe end-to-end, and `is_null` must read the same for
    // "no verdict available" whether the dispatcher is old or the instance is
    // unknown. Absent — not an explicit null that a `default` transform would
    // treat as a real value.
    const adapter = createKernelAdapter({
      collectionList: async () => ({ records: [] }),
    } as KernelDispatchers);
    const out = await adapter(mkCall('email-list', { slug: 'primary' })) as Record<string, unknown>;
    expect(Object.hasOwn(out, 'source_freshness')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. D-236 EXTENSION — get / search carry it too, because a null record
//    and zero matches are absences with the same ambiguity as an empty list.
// ────────────────────────────────────────────────────────────────

describe('D-236 — collection.get / .search carry the verdict', () => {
  const via = async (
    fn: typeof handleCollectionGet | typeof handleCollectionSearch,
    args: Record<string, unknown>,
    collection: Collection,
  ): Promise<{ source_freshness: CollectionSourceFreshness }> => {
    const registry = createCollectionRegistry();
    registry.register(collection);
    return (await (fn as (d: unknown, a: unknown) => Promise<{
      source_freshness: CollectionSourceFreshness;
    }>)({ registry, now: () => NOW }, args));
  };

  it('get carries it when the record EXISTS', async () => {
    const r = await via(handleCollectionGet,
      { platform: 'mail', slug: 'primary', record_id: 'm1' }, stub());
    expect(r.source_freshness.stale).toBe(false);
  });

  it('⛔ get carries it when the record is NULL — the case that needs it most', async () => {
    // An unknown id and a not-yet-synced record are the same observation. If the
    // verdict were dropped on exactly the absent branch, it would be missing
    // from the only outcome the caller has to interpret.
    const missing = { ...stub(), get: () => null } as unknown as Collection;
    const r = await via(handleCollectionGet,
      { platform: 'mail', slug: 'primary', record_id: 'nope' }, missing);
    expect(r.source_freshness).toBeDefined();
    expect(r.source_freshness.last_success_at).toBe(NOW - 5 * MIN);
  });

  it('⛔ search carries it on ZERO matches', async () => {
    const empty = { ...stub(), search: () => [] } as unknown as Collection;
    const r = await via(handleCollectionSearch,
      { platform: 'mail', slug: 'primary', query: 'nothing' }, empty);
    expect(r.source_freshness).toBeDefined();
    expect(r.source_freshness.age_ms).toBe(5 * MIN);
  });

  it('search on a stale source reports stale', async () => {
    const stale = {
      ...stub(),
      health: () => health({ last_indexed_at: NOW - 48 * 60 * MIN }),
    } as unknown as Collection;
    const r = await via(handleCollectionSearch,
      { platform: 'mail', slug: 'primary', query: 'x' }, stale);
    expect(r.source_freshness.stale).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// 5. The shared helper — written once so six call sites cannot diverge
// ────────────────────────────────────────────────────────────────

describe('D-236 — collectionSourceFreshnessOf', () => {
  it('agrees with the raw derivation on a healthy instance', () => {
    expect(collectionSourceFreshnessOf(() => health(), NOW))
      .toEqual(deriveCollectionSourceFreshness(health(), NOW));
  });

  it('⛔ a throwing health() fails toward STALE, never toward fresh', () => {
    // The one direction that would turn this fact back into the bug it exists
    // to fix. Six call sites share this helper precisely so no copy of the
    // try/catch can quietly default the other way.
    const f = collectionSourceFreshnessOf(() => { throw new Error('boom'); }, NOW);
    expect(f.stale).toBe(true);
    expect(f.last_success_at).toBeNull();
  });

  it('honours a caller-supplied threshold', () => {
    expect(collectionSourceFreshnessOf(() => health(), NOW, 60_000).stale).toBe(true);
    expect(collectionSourceFreshnessOf(() => health(), NOW, 60 * MIN).stale).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 6. D-236 EXTENSION — CALENDAR.
//
// ⛔ Calendar does NOT ride the collection.list path. It has its own kernel
//    ingredients and its own dispatcher, and its Collection surface documents
//    that `collection.list` against a calendar slug returns empty. So the
//    original D-236 slice never reached it — the claim "calendar gets it
//    through the same handler" was wrong, and only reading the routing showed
//    that. These tests pin the separate path.
// ────────────────────────────────────────────────────────────────

describe('D-236 — calendar carries the verdict on its OWN dispatcher', () => {
  const calDeps = (over: { health?: () => CollectionHealth } = {}) => ({
    now: () => NOW,
    instances: {
      get: (_p: string, slug: string) => ({
        platform: 'calendar', slug, adapter_type: 'caldav',
        auth_state: 'healthy',
        caps: {
          read: 'yes', list_calendars: 'yes', create_event: 'no',
          update_event: 'no', delete_event: 'no', rsvp: 'no', search: 'fts',
        },
      }),
    },
    getCollection: () => ({
      health: over.health ?? (() => health({ platform: 'calendar' })),
      table: {
        list: () => [],
        get: () => null,
        search: () => [],
      },
    }),
  }) as unknown as Parameters<typeof handleCalendarList>[0];

  it('calendar-list carries it — on an EMPTY result, which is the absence case', async () => {
    const r = await handleCalendarList(calDeps(), { slug: 'work' });
    expect(r.records).toEqual([]);
    expect(r.source_freshness.age_ms).toBe(5 * MIN);
    expect(r.source_freshness.stale).toBe(false);
  });

  it('calendar-get carries it on a NULL record', async () => {
    const r = await handleCalendarGet(calDeps(), { slug: 'work', source_id: 'nope' });
    expect(r.record).toBeNull();
    expect(r.source_freshness).toBeDefined();
  });

  it('calendar-search carries it on ZERO matches', async () => {
    const r = await handleCalendarSearch(calDeps(), { slug: 'work', query: 'nothing' });
    expect(r.matches).toEqual([]);
    expect(r.source_freshness).toBeDefined();
  });

  it('a backlogged calendar reads stale — pending_queue_size includes series expansions', async () => {
    const r = await handleCalendarList(
      calDeps({ health: () => health({ platform: 'calendar', pending_queue_size: 7 }) }),
      { slug: 'work' },
    );
    expect(r.source_freshness.pending).toBe(7);
    expect(r.source_freshness.stale).toBe(true);
  });
});
