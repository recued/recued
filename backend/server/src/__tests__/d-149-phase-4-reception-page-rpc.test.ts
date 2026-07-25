/** D-149 P4 § A.5.1 — `reception.page.get` + `reception.page.upsert`
 *  rpc acceptance.
 *
 *  Covers:
 *    - Admin-token gate: every rpc rejects unregistered callers.
 *    - Fresh-install: `get` returns `{ config: null, last_updated_at: null }`.
 *    - Upsert round-trip: `created: true` on first call, `created: false`
 *      on second; `get` reads back the stored config.
 *    - Validator integration: bad config (javascript: avatar_url)
 *      throws `reception_page_config_invalid` with `issues` details.
 *    - Audit emission: each upsert appends a `reception_page.config_updated`
 *      activity row.
 *    - Broadcast emission: each upsert fires a `reception.endpoint_changed`
 *      event with the singleton endpoint_id. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import {
  RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
  RpcError,
  type ReceptionPageConfig,
} from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import {
  createPreviewHashStore,
  type PreviewHashStore,
} from '../ports/reception/preview-hash.js';
import { deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import {
  handleReceptionPageGet,
  handleReceptionPageUpsert,
  type ReceptionBroadcastEvent,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';

const NOW = 1_700_000_000_000;

const buildAuditLog = (): { auditLog: AuditLogStore; rows: ActivityEntry[] } => {
  const rows: ActivityEntry[] = [];
  const auditLog = {
    append: async () => {},
    listRecent: async () => [],
    listByRecipe: async () => [],
    get: async () => null,
    clearOlderThan: async () => 0,
    clearByRecipe: async () => 0,
    exportAll: async () => ({ entries: [], activities: [] }),
    size: async () => 0,
    clearAll: async () => {},
    listActivities: async () => rows.slice(),
    exportActivities: async () => rows.slice(),
    clearOldestActivities: async () => 0,
    clearOldestEntries: async () => 0,
    countReserveEntries: async () => 0,
    countReserveActivities: async () => 0,
    logActivity: async (entry: ActivityEntry) => {
      rows.push(entry);
    },
  } as unknown as AuditLogStore;
  return { auditLog, rows };
};

const buildDeps = (): {
  deps: ReceptionRpcDeps;
  store: PublicEndpointRegistryStore;
  previewStore: PreviewHashStore;
  broadcasts: ReceptionBroadcastEvent[];
  rows: ActivityEntry[];
} => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const previewStore = createPreviewHashStore();
  const { auditLog, rows } = buildAuditLog();
  const broadcasts: ReceptionBroadcastEvent[] = [];
  const deps: ReceptionRpcDeps = {
    getStore: () => store,
    getPreviewStore: () => previewStore,
    getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 0xAB)),
    getShareBaseUrl: () => 'https://alice.recued.cloud',
    auditLog,
    broadcast: (event) => {
      broadcasts.push(event);
    },
    now: () => NOW,
  };
  return { deps, store, previewStore, broadcasts, rows };
};

const validConfig = (): ReceptionPageConfig => ({
  display_overrides: {
    display_name: 'Mary',
    tagline: 'On call this week',
    tz_label: 'America/Los_Angeles',
    preferred_contact_methods: ['email'],
  },
  sections_enabled: {
    contact_card: true,
    contact_methods: true,
    availability_cta: false,
    intake_cta: false,
    drop_cta: false,
    custom_links: false,
    link_buttons: true,
  },
  linked_endpoints: {},
  link_buttons: [{
    label: 'Subscribe',
    url: 'https://buy.stripe.com/example',
    description: 'Choose a plan.',
  }],
});

describe('D-149 P4 § A.5.1 — admin-token gate (Must Hold I-3)', () => {
  it('reception.page.get rejects unregistered caller', async () => {
    const { deps } = buildDeps();
    await expect(handleReceptionPageGet(deps, undefined, undefined)).rejects.toThrow(
      /requires a paired client/,
    );
  });

  it('reception.page.upsert rejects unregistered caller', async () => {
    const { deps } = buildDeps();
    await expect(
      handleReceptionPageUpsert(deps, { config: validConfig() }, undefined),
    ).rejects.toThrow(/requires a paired client/);
  });
});

describe('D-149 P4 § A.5.1 — fresh-install state', () => {
  it('reception.page.get returns null on fresh install', async () => {
    const { deps } = buildDeps();
    const result = await handleReceptionPageGet(deps, undefined, { instance_id: 'mary' });
    expect(result.config).toBeNull();
    expect(result.last_updated_at).toBeNull();
  });
});

describe('D-149 P4 § A.5.1 — upsert round-trip', () => {
  it('first upsert returns created=true; second returns created=false', async () => {
    const { deps } = buildDeps();
    const r1 = await handleReceptionPageUpsert(
      deps,
      { config: validConfig() },
      { instance_id: 'mary' },
    );
    expect(r1.ok).toBe(true);
    expect(r1.created).toBe(true);
    expect(r1.last_updated_at).toBe(NOW);
    const r2 = await handleReceptionPageUpsert(
      deps,
      { config: validConfig() },
      { instance_id: 'mary' },
    );
    expect(r2.created).toBe(false);
    expect(r2.last_updated_at).toBe(NOW);
  });

  it('get after upsert reads back the stored config', async () => {
    const { deps } = buildDeps();
    const cfg = validConfig();
    await handleReceptionPageUpsert(deps, { config: cfg }, { instance_id: 'mary' });
    const result = await handleReceptionPageGet(deps, undefined, { instance_id: 'mary' });
    expect(result.config).not.toBeNull();
    expect(result.config?.display_overrides.display_name).toBe('Mary');
    expect(result.config?.link_buttons).toEqual([{
      label: 'Subscribe',
      url: 'https://buy.stripe.com/example',
      description: 'Choose a plan.',
    }]);
    expect(result.last_updated_at).toBe(NOW);
  });
});

describe('D-149 P4 § A.5.1 — validator integration', () => {
  it('rejects config with javascript: avatar_url', async () => {
    const { deps } = buildDeps();
    const bad: ReceptionPageConfig = {
      ...validConfig(),
      display_overrides: {
        ...validConfig().display_overrides,
        avatar_url: 'javascript:alert(1)',
      },
    };
    await expect(
      handleReceptionPageUpsert(deps, { config: bad }, { instance_id: 'mary' }),
    ).rejects.toMatchObject({
      code: 'reception_page_config_invalid',
    });
  });

  it('rejects config when args is not an object', async () => {
    const { deps } = buildDeps();
    await expect(
      handleReceptionPageUpsert(deps, null as never, { instance_id: 'mary' }),
    ).rejects.toThrow(/args must be an object/);
  });

  it('attaches `issues` to RpcError.details for inline rendering', async () => {
    const { deps } = buildDeps();
    const bad: ReceptionPageConfig = {
      ...validConfig(),
      display_overrides: {
        ...validConfig().display_overrides,
        display_name: '',
      },
    };
    try {
      await handleReceptionPageUpsert(deps, { config: bad }, { instance_id: 'mary' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      const err = e as RpcError;
      expect(err.code).toBe('reception_page_config_invalid');
      expect(err.details?.issues).toBeDefined();
      expect(Array.isArray(err.details?.issues)).toBe(true);
    }
  });
});

describe('D-149 P4 § A.5.1 — audit + broadcast emission', () => {
  it('upsert emits reception_page.config_updated activity row', async () => {
    const { deps, rows } = buildDeps();
    await handleReceptionPageUpsert(
      deps,
      { config: validConfig() },
      { instance_id: 'mary' },
    );
    const upsertRows = rows.filter((r) => r.action === 'reception_page.config_updated');
    expect(upsertRows.length).toBe(1);
    expect(upsertRows[0]?.target).toBe('reception_page');
    expect(upsertRows[0]?.reserve).toBe(true);
  });

  it('upsert emits reception.endpoint_changed broadcast for the singleton id', async () => {
    const { deps, broadcasts } = buildDeps();
    await handleReceptionPageUpsert(
      deps,
      { config: validConfig() },
      { instance_id: 'mary' },
    );
    const events = broadcasts.filter((b) => b.kind === 'reception.endpoint_changed');
    expect(events.length).toBe(1);
    const event = events[0];
    if (event && event.kind === 'reception.endpoint_changed') {
      expect(event.endpoint_id).toBe(RECEPTION_PAGE_SINGLETON_ENDPOINT_ID);
      expect(event.op).toBe('create');
    } else {
      throw new Error('expected reception.endpoint_changed event');
    }
  });

  it('second upsert emits broadcast with op=extend (not create)', async () => {
    const { deps, broadcasts } = buildDeps();
    await handleReceptionPageUpsert(
      deps,
      { config: validConfig() },
      { instance_id: 'mary' },
    );
    await handleReceptionPageUpsert(
      deps,
      { config: validConfig() },
      { instance_id: 'mary' },
    );
    const events = broadcasts.filter((b) => b.kind === 'reception.endpoint_changed');
    expect(events.length).toBe(2);
    const second = events[1];
    if (second && second.kind === 'reception.endpoint_changed') {
      expect(second.op).toBe('extend');
    }
  });
});
