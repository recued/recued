/** D-149 P9 § A.5.6 — production status_link entity-source reader.
 *
 *  Phase-1 of "wire the engine half": closes the reachable 503 the
 *  status_link visitor GET emitted for every enabled endpoint (the
 *  reader was intentionally omitted until now). Covers:
 *    - project / commitment_summary / custom projection mapping over a
 *      REAL `WorkEntityStore` (the live `readByKind` + `listCommitments`
 *      path), including the derived `open_commitment_count` +
 *      `due_at_relative` + redacted counterparty.
 *    - store-less source kinds (event / itinerary / packing_list),
 *      missing / deleted / tombstoned / orphaned entities, unknown
 *      source kinds, empty id → null (handler degrades to placeholder).
 *    - end-to-end: reader wired into the real reception dispatcher →
 *      enabled status_link GET returns 200 with the projection (NOT the
 *      503 stub), and no out-of-ceiling source field leaks. */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  RECUED_BUILTIN_SOURCE_ID,
  type StatusLinkConfig,
  type WorkEntity,
} from '@recued/contracts';
import {
  createWarehouseStatusEntitySourceReader,
  type StatusReaderContactNameSource,
  type StatusReaderWorkEntitySource,
} from '../ports/reception/status-entity-source-reader.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionStatusProjectionStore } from '../storage/reception-status-projection-store.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import {
  computeBearerHmac,
  deriveReceptionPepper,
} from '../ports/reception/server-secret-pepper.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

// ────────────────────────────────────────────────────────────────
// Real work-entity store helper — writes go through the production
// store so the reader exercises the live `readByKind` / `listCommitments`.
// ────────────────────────────────────────────────────────────────

const buildWorkStore = (): WorkEntityStore => {
  const db = new Database(':memory:');
  ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db);
  autoRegisterRecuedBuiltinSources(store, NOW);
  return store;
};

const reader = (store: StatusReaderWorkEntitySource, contactStore?: StatusReaderContactNameSource) =>
  createWarehouseStatusEntitySourceReader({
    workEntityStore: store,
    ...(contactStore ? { contactStore } : {}),
    now: () => NOW,
  });

// ────────────────────────────────────────────────────────────────
// Projection mapping over the real store
// ────────────────────────────────────────────────────────────────

describe('warehouse status reader — project projection', () => {
  let store: WorkEntityStore;
  beforeEach(() => {
    store = buildWorkStore();
  });

  it('maps a project + counts only pending commitments that block it', () => {
    store.writeProject(
      {
        id: 'proj-42',
        title: 'Q3 Launch',
        state: 'active',
        description: 'internal-only roadmap detail',
        last_activity_at: NOW - 2 * DAY,
        source_id: RECUED_BUILTIN_SOURCE_ID('project'),
      },
      NOW - 3 * DAY,
    );
    // Two pending commitments block proj-42; one fulfilled (excluded);
    // one pending blocks a different project (excluded).
    store.writeCommitment(
      { direction: 'outbound', statement: 'a', derivation: 'user_declared', lifecycle_state: 'pending', blocks_project_ids: ['proj-42'], source_id: RECUED_BUILTIN_SOURCE_ID('commitment') },
      NOW,
    );
    store.writeCommitment(
      { direction: 'outbound', statement: 'b', derivation: 'user_declared', lifecycle_state: 'pending', blocks_project_ids: ['proj-42'], source_id: RECUED_BUILTIN_SOURCE_ID('commitment') },
      NOW,
    );
    store.writeCommitment(
      { direction: 'outbound', statement: 'c', derivation: 'user_declared', lifecycle_state: 'fulfilled', blocks_project_ids: ['proj-42'], source_id: RECUED_BUILTIN_SOURCE_ID('commitment') },
      NOW,
    );
    store.writeCommitment(
      { direction: 'outbound', statement: 'd', derivation: 'user_declared', lifecycle_state: 'pending', blocks_project_ids: ['proj-99'], source_id: RECUED_BUILTIN_SOURCE_ID('commitment') },
      NOW,
    );

    const out = reader(store).read({
      projection_kind: 'project',
      source_entity_kind: 'data.project',
      source_entity_id: 'proj-42',
    });

    expect(out).not.toBeNull();
    expect(out!.row).toEqual({
      title: 'Q3 Launch',
      state: 'active',
      open_commitment_count: 2,
      last_activity_at_relative: '2d ago',
    });
    // No out-of-ceiling field (e.g. description) leaks into the row.
    expect(out!.row).not.toHaveProperty('description');
    expect(out!.last_updated_at).toBe(NOW - 2 * DAY);
  });

  it('falls back to updated_at when last_activity_at is unset (0)', () => {
    store.writeProject(
      { id: 'p2', title: 'P2', state: 'paused', last_activity_at: 0, source_id: RECUED_BUILTIN_SOURCE_ID('project') },
      NOW - 5 * DAY,
    );
    const out = reader(store).read({
      projection_kind: 'project',
      source_entity_kind: 'data.project',
      source_entity_id: 'p2',
    });
    expect(out!.last_updated_at).toBe(NOW - 5 * DAY);
    expect(out!.row.last_activity_at_relative).toBe('5d ago');
  });
});

describe('warehouse status reader — commitment_summary projection', () => {
  let store: WorkEntityStore;
  beforeEach(() => {
    store = buildWorkStore();
  });

  it('maps statement/state + future deadline ("due in") + redacted counterparty', () => {
    store.writeCommitment(
      {
        id: 'c1',
        direction: 'inbound',
        statement: 'Ship the thing',
        derivation: 'user_declared',
        lifecycle_state: 'pending',
        promised_for_at: NOW + 3 * DAY,
        counterparty_contact_id: 'contact-1',
        source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
      },
      NOW - DAY,
    );
    const contacts: StatusReaderContactNameSource = {
      getByContactId: (id) =>
        id === 'contact-1' ? ({ name: 'Mary Smith' } as never) : null,
    };
    const out = reader(store, contacts).read({
      projection_kind: 'commitment_summary',
      source_entity_kind: 'data.commitment',
      source_entity_id: 'c1',
    });
    expect(out!.row).toEqual({
      title: 'Ship the thing',
      state: 'pending',
      due_at_relative: 'due in 3d',
      counterparty_first_name_initial: 'Mary S.',
    });
    expect(out!.last_updated_at).toBe(NOW - DAY);
  });

  it('renders a past deadline as overdue + omits counterparty with no contact store', () => {
    store.writeCommitment(
      {
        id: 'c2',
        direction: 'outbound',
        statement: 'Late thing',
        derivation: 'user_declared',
        lifecycle_state: 'pending',
        promised_for_at: NOW - 5 * DAY,
        counterparty_contact_id: 'contact-x',
        source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
      },
      NOW,
    );
    const out = reader(store).read({
      projection_kind: 'commitment_summary',
      source_entity_kind: 'data.commitment',
      source_entity_id: 'c2',
    });
    expect(out!.row.due_at_relative).toBe('5d overdue');
    expect(out!.row).not.toHaveProperty('counterparty_first_name_initial');
  });

  it('omits due_at_relative when the commitment has no deadline', () => {
    store.writeCommitment(
      { id: 'c3', direction: 'outbound', statement: 'No deadline', derivation: 'user_declared', lifecycle_state: 'pending', source_id: RECUED_BUILTIN_SOURCE_ID('commitment') },
      NOW,
    );
    const out = reader(store).read({
      projection_kind: 'commitment_summary',
      source_entity_kind: 'data.commitment',
      source_entity_id: 'c3',
    });
    expect(out!.row).not.toHaveProperty('due_at_relative');
  });
});

describe('warehouse status reader — custom projection', () => {
  let store: WorkEntityStore;
  beforeEach(() => {
    store = buildWorkStore();
  });

  it('maps a task to title + truncated summary + updated_at_relative', () => {
    const longBody = 'x'.repeat(400);
    store.writeTask(
      { id: 't1', title: 'A task', body: longBody, source_id: RECUED_BUILTIN_SOURCE_ID('task') },
      NOW - 3600_000,
    );
    const out = reader(store).read({
      projection_kind: 'custom',
      source_entity_kind: 'data.task',
      source_entity_id: 't1',
    });
    expect(out!.row.title).toBe('A task');
    expect(out!.row.updated_at_relative).toBe('1h ago');
    expect((out!.row.summary as string).length).toBe(280);
    expect((out!.row.summary as string).endsWith('…')).toBe(true);
  });

  it('uses an untitled-note fallback + no summary for an empty body', () => {
    store.writeNote(
      { id: 'n1', body: '   ', source_id: RECUED_BUILTIN_SOURCE_ID('note') },
      NOW - DAY,
    );
    const out = reader(store).read({
      projection_kind: 'custom',
      source_entity_kind: 'data.note',
      source_entity_id: 'n1',
    });
    expect(out!.row.title).toBe('(untitled note)');
    expect(out!.row).not.toHaveProperty('summary');
  });
});

// ────────────────────────────────────────────────────────────────
// Null / degrade paths
// ────────────────────────────────────────────────────────────────

describe('warehouse status reader — null/degrade paths', () => {
  it('returns null for store-less source kinds (event / itinerary / packing_list)', () => {
    const store = buildWorkStore();
    const r = reader(store);
    for (const [projection_kind, source_entity_kind] of [
      ['event_plan', 'data.event'],
      ['itinerary', 'data.itinerary'],
      ['packing_list', 'data.packing_list'],
    ] as const) {
      expect(r.read({ projection_kind, source_entity_kind, source_entity_id: 'x' })).toBeNull();
    }
  });

  it('returns null for unknown source kind, empty id, and missing entity', () => {
    const store = buildWorkStore();
    const r = reader(store);
    expect(r.read({ projection_kind: 'custom', source_entity_kind: 'data.nope', source_entity_id: 'x' })).toBeNull();
    expect(r.read({ projection_kind: 'project', source_entity_kind: 'data.project', source_entity_id: '' })).toBeNull();
    expect(r.read({ projection_kind: 'project', source_entity_kind: 'data.project', source_entity_id: 'ghost' })).toBeNull();
  });

  it('returns null for deleted / tombstoned / orphaned entities (fake store)', () => {
    const base = {
      _kind: 'task' as const,
      id: 't',
      title: 'T',
      body: undefined,
      done: false,
      created_at: NOW,
      updated_at: NOW,
      blocks_task_ids: [],
      source_id: 's',
      last_seen_at: NOW,
      conflict_policy: 'source_wins' as const,
    };
    const cases: WorkEntity[] = [
      { ...base, sync_state: 'live', deleted_at: NOW } as WorkEntity,
      { ...base, sync_state: 'tombstoned' } as WorkEntity,
      { ...base, sync_state: 'orphaned' } as WorkEntity,
    ];
    for (const entity of cases) {
      const fake: StatusReaderWorkEntitySource = {
        readByKind: () => entity,
        listCommitments: () => [],
        // Unreached — the deleted/tombstoned/orphaned checks precede the
        // Source lookup; present only to satisfy the slice type.
        getSource: () => null,
      };
      expect(
        reader(fake).read({ projection_kind: 'custom', source_entity_kind: 'data.task', source_entity_id: 't' }),
      ).toBeNull();
    }
  });

  it('returns null when the entity kind cannot satisfy the projection', () => {
    const store = buildWorkStore();
    store.writeTask({ id: 't9', title: 'T9', source_id: RECUED_BUILTIN_SOURCE_ID('task') }, NOW);
    // A 'project' projection over a task row → null (misconfig guard).
    expect(
      reader(store).read({ projection_kind: 'project', source_entity_kind: 'data.task', source_entity_id: 't9' }),
    ).toBeNull();
  });

});

// ────────────────────────────────────────────────────────────────
// End-to-end through the real reception dispatcher (503 → 200)
// ────────────────────────────────────────────────────────────────

const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xc4));

const fakeReq = (method: string, url: string): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.9' });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  return req;
};

const fakeRes = () => {
  const chunks: Array<string | Buffer> = [];
  const res = {
    statusCode: 200,
    setHeader() {},
    getHeader() {
      return undefined;
    },
    end(b?: string | Buffer) {
      if (b !== undefined) chunks.push(b);
    },
    write(b: string | Buffer) {
      chunks.push(b);
    },
    get body(): string {
      return chunks.map((c) => (typeof c === 'string' ? c : c.toString('utf8'))).join('');
    },
    get status(): number {
      return res.statusCode;
    },
  } as unknown as ServerResponse & { status: number; body: string };
  return res;
};

describe('warehouse status reader — end-to-end dispatcher', () => {
  it('serves 200 + the live project projection (not the 503 stub) and leaks no out-of-ceiling field', async () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    ensureWorkEntitySchema(db);
    const workStore = createWorkEntityStore(db);
    autoRegisterRecuedBuiltinSources(workStore, NOW);
    workStore.writeProject(
      {
        id: 'proj-live',
        title: 'Launch Tracker',
        state: 'active',
        description: 'SECRET-ROADMAP-DETAIL',
        last_activity_at: NOW - 3600_000,
        source_id: RECUED_BUILTIN_SOURCE_ID('project'),
      },
      NOW - DAY,
    );

    const registry = createPublicEndpointRegistryStore(db);
    const projectionStore = createReceptionStatusProjectionStore(db);
    const cache = createReceptionRegistryCache();
    const limiter = createReceptionRateLimiter({ db });

    const config: StatusLinkConfig = {
      display_name: 'Mary',
      projection_kind: 'project',
      source_ref: { kind: 'data.project', project_id: 'proj-live' },
      refresh_policy: { auto_refresh_enabled: false },
      comments_enabled: false,
      shows_update_history: true,
      expiry_days: 30,
    };
    registry.create({
      endpoint_id: 'ep-1',
      kind: 'status_link',
      packet_declaration: {
        packet_kind: 'status_link_packet',
        source_query_ref: { kind: 'data.project', project_id: 'proj-live' },
      },
      bearer_secret_hmac: computeBearerHmac('tok', PEPPER),
      created_at: NOW - DAY,
      created_by_client_id: 'inst-1',
      expires_at: null,
      long_lived_acknowledged_at: NOW - DAY,
      metadata: config as unknown as Record<string, unknown>,
    });
    registry.enable('ep-1', NOW);
    projectionStore.create({
      projection_id: 'ep-1',
      endpoint_id: 'ep-1',
      projection_kind: 'project',
      source_entity_kind: 'data.project',
      source_entity_id: 'proj-live',
      refresh_policy: config.refresh_policy,
      comments_enabled: false,
      shows_update_history: true,
    });

    const handler = createReceptionPortHandler({
      getStore: () => registry,
      getCache: () => cache,
      getRateLimiter: () => limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      getStatusProjectionStore: () => projectionStore,
      getStatusEntitySourceReader: () =>
        createWarehouseStatusEntitySourceReader({ workEntityStore: workStore, now: () => NOW }),
    });

    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/status/ep-1?t=tok'), res);

    expect(res.status).toBe(200);
    expect(res.body).toContain('Launch Tracker');
    expect(res.body).not.toContain('not_implemented');
    expect(res.body).not.toContain('SECRET-ROADMAP-DETAIL');
  });

  it('degrades to the placeholder for a store-less source kind (itinerary)', async () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    ensureWorkEntitySchema(db);
    const workStore = createWorkEntityStore(db);
    autoRegisterRecuedBuiltinSources(workStore, NOW);

    const registry = createPublicEndpointRegistryStore(db);
    const projectionStore = createReceptionStatusProjectionStore(db);
    const cache = createReceptionRegistryCache();
    const limiter = createReceptionRateLimiter({ db });

    const config: StatusLinkConfig = {
      display_name: 'Mary',
      projection_kind: 'itinerary',
      source_ref: { kind: 'data.itinerary', itinerary_id: 'it-1' },
      refresh_policy: { auto_refresh_enabled: false },
      comments_enabled: false,
      shows_update_history: true,
      expiry_days: 30,
    };
    registry.create({
      endpoint_id: 'ep-2',
      kind: 'status_link',
      packet_declaration: {
        packet_kind: 'status_link_packet',
        source_query_ref: { kind: 'data.itinerary', itinerary_id: 'it-1' },
      },
      bearer_secret_hmac: computeBearerHmac('tok', PEPPER),
      created_at: NOW - DAY,
      created_by_client_id: 'inst-1',
      expires_at: null,
      long_lived_acknowledged_at: NOW - DAY,
      metadata: config as unknown as Record<string, unknown>,
    });
    registry.enable('ep-2', NOW);
    projectionStore.create({
      projection_id: 'ep-2',
      endpoint_id: 'ep-2',
      projection_kind: 'itinerary',
      source_entity_kind: 'data.itinerary',
      source_entity_id: 'it-1',
      refresh_policy: config.refresh_policy,
      comments_enabled: false,
      shows_update_history: true,
    });

    const handler = createReceptionPortHandler({
      getStore: () => registry,
      getCache: () => cache,
      getRateLimiter: () => limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      getStatusProjectionStore: () => projectionStore,
      getStatusEntitySourceReader: () =>
        createWarehouseStatusEntitySourceReader({ workEntityStore: workStore, now: () => NOW }),
    });

    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/status/ep-2?t=tok'), res);
    // Placeholder page (entity not available) rather than a crash/stub.
    expect(res.status).toBe(503);
    expect(res.body).not.toContain('Launch Tracker');
  });
});
