import { beforeEach, describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';
import type {
  CollectionHealth,
  CollectionPlatform,
  CollectionRecord,
  CollectionSearchMatch,
} from '@recued/contracts';
import type { StorageGate } from '@recued/storage-gate';

import {
  createCollectionRegistry,
  type CollectionRegistry,
} from '../collections/registry.js';
import type {
  Collection,
  CollectionPruneResult,
  CollectionSyncAdapter,
} from '../collections/types.js';
import {
  handleCollectionGet,
  handleCollectionList,
  handleCollectionListEndpoints,
  handleCollectionRunRetention,
  handleCollectionSearch,
  makeCollectionHandlers,
} from '../collections/collection-handler.js';

// ────────────────────────────────────────────────────────────────
// Stub collection
// ────────────────────────────────────────────────────────────────

interface StubOverrides {
  records?: CollectionRecord[];
  searchMatches?: CollectionSearchMatch[];
  health?: CollectionHealth;
  runRetention?: () => Promise<CollectionPruneResult>;
}

const stubCollection = (
  platform: CollectionPlatform,
  slug: string,
  overrides: StubOverrides = {},
): Collection => {
  const records = overrides.records ?? [];
  const byId = new Map(records.map((r) => [r.record_id, r] as const));
  const sync: CollectionSyncAdapter = {
    start: async () => {},
    stop: async () => {},
  };
  const health: CollectionHealth = overrides.health ?? {
    platform,
    slug,
    last_indexed_at: 0,
    pending_queue_size: 0,
    error_count_24h: 0,
    state: 'idle',
  };
  return {
    platform,
    slug,
    gate: {} as StorageGate,
    sync,
    upsert: () => {},
    delete: () => true,
    get: (id) => byId.get(id) ?? null,
    list: () => records,
    search: () => overrides.searchMatches ?? [],
    health: () => health,
    runRetention: overrides.runRetention ?? (async () => ({
      pruned_count: 0,
      bytes_freed: 0,
      blob_hashes_freed: [],
      duration_ms: 0,
    })),
    close: async () => {},
  };
};

const mkRecord = (id: string, overrides: Partial<CollectionRecord> = {}): CollectionRecord => ({
  record_id: id,
  received_at: 1_700_000_000_000,
  modified_at: 1_700_000_000_000,
  hot_fields: {},
  size_bytes: 42,
  source_id: `<${id}>`,
  body_inline: 'body',
  ...overrides,
});

let registry: CollectionRegistry;
let deps: { registry: CollectionRegistry };

beforeEach(() => {
  registry = createCollectionRegistry();
  deps = { registry };
});

// ────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────

describe('platform / slug validation', () => {
  it('rejects a missing or unserved platform', async () => {
    // `service` is a real CollectionPlatform type but NOT served by the generic
    // collection rpc (it has its own `collection.service.*` family) — the gate
    // rejects it. (`calendar` used to be the example here; D-198 promoted it to
    // a served platform, so it moved to the positive test below.)
    await expect(
      handleCollectionList(deps, { platform: 'service', slug: 'work' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      handleCollectionList(deps, { platform: undefined, slug: 'work' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects an empty or non-string slug', async () => {
    await expect(
      handleCollectionList(deps, { platform: 'mail', slug: '' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      handleCollectionList(deps, { platform: 'mail', slug: 42 }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('maps unknown (platform, slug) pair to COLLECTION_NOT_FOUND', async () => {
    registry.register(stubCollection('mail', 'work'));
    const err = await handleCollectionList(deps, { platform: 'mail', slug: 'personal' })
      .catch((e) => e as RpcError);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe('not_found');
    expect((err as RpcError).message).toMatch(/COLLECTION_NOT_FOUND/);
  });
});

// ────────────────────────────────────────────────────────────────
// collection.list
// ────────────────────────────────────────────────────────────────

describe('handleCollectionList', () => {
  it.each([
    { calendar_window: null }, { calendar_window: { from: 5, before: 5 } },
    { calendar_window: { from: 10, before: 5 } }, { calendar_window: { from: NaN, before: 5 } },
    { calendar_window: { from: 1, before: Infinity } }, { calendar_window: { from: 1, before: 5, ignored: true } },
    { offset: -1 }, { offset: 1.5 }, { offset: '10' },
    { filters: { is_all_day: 'true' } }, { filters: { is_all_day: 1 } },
  ])('rejects malformed calendar pagination and time bounds: %j', async (query) => {
    registry.register(stubCollection('calendar', 'work'));
    await expect(handleCollectionList(deps, { platform: 'calendar', slug: 'work', ...query })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects calendar-only bounds and pagination on other collections', async () => {
    for (const query of [{ calendar_window: { from: 1, before: 5 } }, { offset: 0 }]) {
      await expect(handleCollectionList(deps, { platform: 'mail', slug: 'work', ...query })).rejects.toThrow();
    }
  });
  beforeEach(() => {
    registry.register(stubCollection('mail', 'work', {
      records: [mkRecord('r1'), mkRecord('r2')],
    }));
  });

  it('returns the stub records for a registered collection', async () => {
    const res = await handleCollectionList(deps, { platform: 'mail', slug: 'work' });
    expect(res.records.map((r) => r.record_id)).toEqual(['r1', 'r2']);
  });

  it('serves the calendar platform through the gate (D-198 — was rejected before)', async () => {
    // The gate is real (not mocked); only the collection IO is a stub. Proves
    // `requirePlatform` now admits `calendar` + delegates to its `list`.
    registry.register(stubCollection('calendar', 'work', {
      records: [mkRecord('cal:abc', { hot_fields: { summary: 'Standup', start_at: 1 } })],
    }));
    const res = await handleCollectionList(deps, { platform: 'calendar', slug: 'work' });
    expect(res.records.map((r) => r.record_id)).toEqual(['cal:abc']);
    expect(res.records[0]!.hot_fields.summary).toBe('Standup');
  });

  it('forwards filters / since / until / limit to the collection', async () => {
    // Record the query the stub actually received.
    let captured: unknown;
    registry = createCollectionRegistry();
    registry.register({
      ...stubCollection('mail', 'captured'),
      list: (q) => { captured = q; return []; },
    });
    deps = { registry };
    await handleCollectionList(deps, {
      platform: 'mail', slug: 'captured',
      filters: { thread_id: 'T1' },
      since: 10, until: 20, limit: 5,
    });
    expect(captured).toEqual({
      platform: 'mail', slug: 'captured',
      filters: { thread_id: 'T1' },
      since: 10, until: 20, limit: 5,
    });
  });

  it('rejects a non-object filters', async () => {
    await expect(
      handleCollectionList(deps, { platform: 'mail', slug: 'work', filters: 'no' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects a non-number since / until / limit', async () => {
    await expect(
      handleCollectionList(deps, { platform: 'mail', slug: 'work', since: 'oops' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      handleCollectionList(deps, { platform: 'mail', slug: 'work', limit: 0 }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

// ────────────────────────────────────────────────────────────────
// collection.search
// ────────────────────────────────────────────────────────────────

describe('handleCollectionSearch', () => {
  it('returns matches from the collection and forwards limit', async () => {
    let capturedLimit: number | undefined;
    registry.register({
      ...stubCollection('mail', 'work'),
      search: (q) => {
        capturedLimit = q.limit;
        return [{ record_id: 'a', hot_fields: {}, rank: -1, snippet: '…' }];
      },
    });
    const res = await handleCollectionSearch(deps, {
      platform: 'mail', slug: 'work',
      query: 'hello', limit: 5,
    });
    expect(res.matches).toEqual([{ record_id: 'a', hot_fields: {}, rank: -1, snippet: '…' }]);
    expect(capturedLimit).toBe(5);
  });

  it('requires a non-empty query', async () => {
    registry.register(stubCollection('mail', 'work'));
    await expect(
      handleCollectionSearch(deps, { platform: 'mail', slug: 'work', query: '' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

// ────────────────────────────────────────────────────────────────
// collection.get
// ────────────────────────────────────────────────────────────────

describe('handleCollectionGet', () => {
  beforeEach(() => {
    registry.register(stubCollection('mail', 'work', {
      records: [mkRecord('r1', { body_inline: 'hi' })],
    }));
  });

  it('returns the found record', async () => {
    const res = await handleCollectionGet(deps, {
      platform: 'mail', slug: 'work', record_id: 'r1',
    });
    expect(res.record?.record_id).toBe('r1');
  });

  it('returns { record: null } for an unknown record_id', async () => {
    const res = await handleCollectionGet(deps, {
      platform: 'mail', slug: 'work', record_id: 'missing',
    });
    expect(res.record).toBeNull();
  });

  it('requires a record_id', async () => {
    await expect(
      handleCollectionGet(deps, { platform: 'mail', slug: 'work' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

// ────────────────────────────────────────────────────────────────
// collection.runRetention
// ────────────────────────────────────────────────────────────────

describe('handleCollectionRunRetention', () => {
  it('narrows the CollectionPruneResult to the wire shape', async () => {
    registry.register(stubCollection('mail', 'work', {
      runRetention: async () => ({
        pruned_count: 3,
        bytes_freed: 12_345,
        blob_hashes_freed: ['a', 'b'],
        duration_ms: 10,
        skipped_reason: undefined,
      }),
    }));
    const res = await handleCollectionRunRetention(deps, {
      platform: 'mail', slug: 'work',
    });
    // Wire shape per contracts: { pruned, bytes_freed }.
    expect(res).toEqual({ pruned: 3, bytes_freed: 12_345 });
  });

  it('reports a zero response when retention is disabled', async () => {
    registry.register(stubCollection('file', 'downloads', {
      runRetention: async () => ({
        pruned_count: 0,
        bytes_freed: 0,
        blob_hashes_freed: [],
        duration_ms: 1,
        skipped_reason: 'retention_disabled',
      }),
    }));
    const res = await handleCollectionRunRetention(deps, {
      platform: 'file', slug: 'downloads',
    });
    expect(res).toEqual({ pruned: 0, bytes_freed: 0 });
  });

  it('surfaces COLLECTION_NOT_FOUND when the pair is unregistered', async () => {
    await expect(
      handleCollectionRunRetention(deps, { platform: 'mail', slug: 'nope' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ────────────────────────────────────────────────────────────────
// collection.listEndpoints
// ────────────────────────────────────────────────────────────────

describe('handleCollectionListEndpoints', () => {
  it('returns the health snapshot for every registered collection', async () => {
    registry.register(stubCollection('mail', 'work', {
      health: {
        platform: 'mail', slug: 'work',
        last_indexed_at: 111, pending_queue_size: 2, error_count_24h: 0,
        state: 'connected',
      },
    }));
    registry.register(stubCollection('file', 'downloads', {
      health: {
        platform: 'file', slug: 'downloads',
        last_indexed_at: 222, pending_queue_size: 0, error_count_24h: 1,
        state: 'error',
      },
    }));
    const res = await handleCollectionListEndpoints(deps);
    expect(res.endpoints.map((e) => `${e.platform}:${e.slug}`)).toEqual([
      'mail:work', 'file:downloads',
    ]);
    expect(res.endpoints[0].state).toBe('connected');
    expect(res.endpoints[1].error_count_24h).toBe(1);
  });

  it('returns an empty list when no collections are registered', async () => {
    const res = await handleCollectionListEndpoints(deps);
    expect(res.endpoints).toEqual([]);
  });

  it('skips adapters whose health() throws', async () => {
    registry.register(stubCollection('mail', 'work'));
    registry.register({
      ...stubCollection('file', 'broken'),
      health: () => { throw new Error('sensor down'); },
    });
    registry.register(stubCollection('webhook', 'github'));
    const res = await handleCollectionListEndpoints(deps);
    expect(res.endpoints.map((e) => `${e.platform}:${e.slug}`)).toEqual([
      'mail:work', 'webhook:github',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// makeCollectionHandlers slice
// ────────────────────────────────────────────────────────────────

describe('makeCollectionHandlers', () => {
  it('returns undefined when deps are missing', () => {
    expect(makeCollectionHandlers(undefined)).toBeUndefined();
  });

  it('declares every method name (D-118 Phase 10 follow-up adds listTemplates + lifecycle)', () => {
    const slice = makeCollectionHandlers(deps);
    expect(slice?.methods.slice().sort()).toEqual([
      // D-118 mail-setup "Also connect Calendar" (5c3f8c832) — adopts the
      // existing Microsoft Graph grant from an enrolled mail account instead of
      // re-consenting, so one consent covers both lanes.
      //
      // ⚠ This is the THIRD place the rpc surface is enumerated: the typed
      // `ServerRpcRegistry`, the runtime `SERVER_RPC_METHODS`, and this slice's
      // own `methods`. That method shipped missing from the runtime list —
      // green across the suite, dead on boot — which is what
      // `server-rpc-registry-method-list-ratchet.test.ts` now closes at
      // typecheck time. It stayed missing HERE too; this list is hand-kept and
      // nothing derives it.
      'collection.calendar.attachGraphGrant',
      'collection.calendar.delete',
      'collection.calendar.enrollBasic',
      'collection.calendar.enrollOAuth',
      'collection.calendar.list',
      'collection.calendar.reauth',
      'collection.calendar.resync',
      'collection.calendar.update',
      'collection.deleteRecord',
      'collection.file.delete',
      'collection.file.enroll',
      'collection.file.resync',
      'collection.file.update',
      'collection.get',
      'collection.list',
      'collection.listEndpoints',
      'collection.listInstances',
      'collection.mail.delete',
      'collection.mail.enrollImap',
      'collection.mail.enrollOAuth',
      'collection.mail.list',
      // D-177 N.12 — `collection.mail.send` is intentionally NOT wired
      // (gateway internal executor only); see the d-177-n12 ratchet test.
      'collection.resync',
      'collection.runRetention',
      'collection.search',
      // 2026-08-28 — universal search: one query fanned across every registered
      // collection, GROUPED and never globally ranked (BM25 is per-index, so
      // cross-store ranks are not comparable). The owner's non-AI path to their
      // own warehouse — until this, searching across it meant asking the AI.
      'collection.searchAll',
      'collection.service.clear_crash',
      'collection.service.delete',
      'collection.service.enroll',
      'collection.service.install',
      'collection.service.list',
      'collection.service.listTemplates',
      'collection.service.restart',
      'collection.service.start',
      'collection.service.stop',
      'collection.service.uninstall',
      'collection.service.update',
      'collection.service.upgrade',
      // sorts after every `collection.*` (d > c). Added by `ae6277f1` but the
      // expected list was not updated — this suite had been red since.
      'data.mirror.search',
    ]);
  });

  it('handlers route to the underlying functions', async () => {
    registry.register(stubCollection('mail', 'work', {
      records: [mkRecord('r1')],
    }));
    const slice = makeCollectionHandlers(deps)!;
    const res = await slice.handlers['collection.get'](
      { platform: 'mail', slug: 'work', record_id: 'r1' },
      {} as never,
    );
    expect((res as { record: CollectionRecord }).record.record_id).toBe('r1');
  });
});
