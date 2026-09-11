/** D-174 #22 — `work_entity.{list,get,upsert,delete}` pair-RPC handler
 *  tests.
 *
 *  Covers, per the dispatch GATE:
 *    - list / get / upsert / delete round-trip per own-it kind,
 *    - upsert + delete fire the canonical `emitWorkEntityEvent` (the
 *      reactive/trigger semantics invariant) — including the two
 *      RPC-only delete dispatchers (commitment / project),
 *    - error surfaces (unknown kind, missing id, update of a
 *      non-existent row),
 *    - the slice self-gates on absent deps + claims exactly its four
 *      methods.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RECUED_BUILTIN_SOURCE_ID,
  RpcError,
  WORK_ENTITY_KINDS,
} from '@recued/contracts';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
} from '@recued/warehouse-events';

import type { WsClient } from '../ws-server.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import type {
  WorkEntitySourceWriteExecutor,
  WorkEntityVendorWritePrepared,
} from '../work-entity-write-executor.js';
import {
  handleWorkEntityDelete,
  handleWorkEntityGet,
  handleWorkEntityList,
  handleWorkEntityUpsert,
  makeWorkEntityCrudHandlers,
  type WorkEntityCrudRpcDeps,
} from '../work-entity-crud-handler.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let deps: WorkEntityCrudRpcDeps;
let events: WarehouseEvent[];

const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd174-crud-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  for (const kind of WORK_ENTITY_KINDS) {
    store.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID(kind),
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: 'Recued built-in',
      write_capable: true,
      registered_at: NOW,
    });
  }
  const bus = createWarehouseEventBus();
  events = [];
  bus.subscribe('**', (ev) => {
    events.push(ev);
  });
  const resolver = createWorkEntityResolver(store);
  const dispatchers = createWorkEntityDispatchers({
    store,
    resolver,
    bus,
    now: () => NOW,
  });
  deps = { store, resolver, dispatchers };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Drain the captured events for a kind + event_kind. */
const eventsFor = (slug: string, kind: string): WarehouseEvent[] =>
  events.filter((e) => e.slug === slug && e.event_kind === kind);

describe('D-174 work_entity.upsert — create per kind (emits created)', () => {
  it('task create round-trips + emits created', async () => {
    const out = await handleWorkEntityUpsert(deps, { kind: 'task', title: 'Buy milk' });
    expect(out.entity._kind).toBe('task');
    expect((out.entity as { title: string }).title).toBe('Buy milk');
    // Persisted + readable through the resolver.
    const got = await handleWorkEntityGet(deps, { kind: 'task', id: out.entity.id });
    expect(got.entity?.id).toBe(out.entity.id);
    expect(eventsFor('task', 'created')).toHaveLength(1);
    expect(eventsFor('task', 'created')[0]!.record_id).toBe(out.entity.id);
  });

  it('note create round-trips + emits created', async () => {
    const out = await handleWorkEntityUpsert(deps, { kind: 'note', body: 'a thought' });
    expect(out.entity._kind).toBe('note');
    expect(eventsFor('note', 'created')).toHaveLength(1);
  });

  it('commitment create round-trips + emits created', async () => {
    const out = await handleWorkEntityUpsert(deps, {
      kind: 'commitment',
      direction: 'outbound',
      statement: 'pay invoice',
      derivation: 'user_declared',
    });
    expect(out.entity._kind).toBe('commitment');
    expect(eventsFor('commitment', 'created')).toHaveLength(1);
  });

  it('project create round-trips + emits created', async () => {
    const out = await handleWorkEntityUpsert(deps, { kind: 'project', title: 'Q3 launch' });
    expect(out.entity._kind).toBe('project');
    expect(eventsFor('project', 'created')).toHaveLength(1);
  });
});

describe('D-192 6c.2c — the vendor-write admission flag is engine-set only (forgery strip)', () => {
  it('strips a forged work_entity_write_preadmitted from the upsert rpc → never reaches the executor', async () => {
    // A connection Source routes the create through the write executor. A wire
    // client passing `work_entity_write_preadmitted: true` must NOT be able to
    // self-admit the vendor create past its `'ask'` gate — the crud handler
    // strips the engine-set-only flag before dispatch.
    store.registerSource({
      id: 'asana.acme.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'Asana tasks (acme)',
      write_capable: true,
      registered_at: NOW,
    });
    let capturedPreadmitted: unknown = 'UNSET';
    const executor: WorkEntitySourceWriteExecutor = {
      resolveCreateDependencies: async () => ({ ok: true, createArgs: {}, plannedCreates: [] }),
      prepare: (input) => {
        capturedPreadmitted = (input as { preadmitted?: boolean }).preadmitted;
        return {
          ok: true,
          vendor_relevant: true,
          prepared: {
            source_id: input.source_id, kind: input.kind, operation: input.operation, patch: input.patch,
          } as unknown as WorkEntityVendorWritePrepared,
        };
      },
      dispatch: async () => ({ ok: true, operation: 'create', source_record_id: 'a-1' }),
      executeCreatePlan: async () => ({ ok: false, reason: 'n/a' }),
      tryFastTrackCreatePlan: async () => ({ ok: false, kind: 'not_granted' }),
    };
    const resolver = createWorkEntityResolver(store);
    const forgeryDeps: WorkEntityCrudRpcDeps = {
      store,
      resolver,
      dispatchers: createWorkEntityDispatchers({
        store, resolver, getWriteExecutor: () => executor, now: () => NOW,
      }),
    };
    await handleWorkEntityUpsert(forgeryDeps, {
      kind: 'task',
      title: 'malicious create',
      source_id: 'asana.acme.task',
      // The forged flag — must be stripped before it reaches the executor.
      work_entity_write_preadmitted: true,
    } as never);
    expect(capturedPreadmitted).toBeUndefined();
  });

  it('the RAW handler with no callerSource strips a forged origin_execution_source (defense-in-depth)', async () => {
    // A wire client passing a privileged `origin_execution_source` (e.g. spoofing the
    // owner) must NOT drive the actor-aware contract-grant admission. Called WITHOUT a
    // server-derived callerSource (the slice arrow supplies that): the forged value is
    // stripped, so the executor sees no source — the raw handler never trusts wire input.
    store.registerSource({
      id: 'asana.acme.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'Asana tasks (acme)',
      write_capable: true,
      registered_at: NOW,
    });
    let capturedSource: unknown = 'UNSET';
    const executor: WorkEntitySourceWriteExecutor = {
      resolveCreateDependencies: async () => ({ ok: true, createArgs: {}, plannedCreates: [] }),
      prepare: (input) => {
        capturedSource = (input as { execution_source?: unknown }).execution_source;
        return {
          ok: true,
          vendor_relevant: true,
          prepared: {
            source_id: input.source_id, kind: input.kind, operation: input.operation, patch: input.patch,
          } as unknown as WorkEntityVendorWritePrepared,
        };
      },
      dispatch: async () => ({ ok: true, operation: 'create', source_record_id: 'a-2' }),
      executeCreatePlan: async () => ({ ok: false, reason: 'n/a' }),
      tryFastTrackCreatePlan: async () => ({ ok: false, kind: 'not_granted' }),
    };
    const resolver = createWorkEntityResolver(store);
    const forgeryDeps: WorkEntityCrudRpcDeps = {
      store,
      resolver,
      dispatchers: createWorkEntityDispatchers({
        store, resolver, getWriteExecutor: () => executor, now: () => NOW,
      }),
    };
    await handleWorkEntityUpsert(forgeryDeps, {
      kind: 'task',
      title: 'spoofed owner create',
      source_id: 'asana.acme.task',
      // The forged owner identity — must be stripped before it reaches the executor.
      origin_execution_source: {
        channel: 'user', actor: 'user_self', user_id: 'attacker', client_token_id: 'ct',
      },
    } as never);
    expect(capturedSource).toBeUndefined();
  });
});

describe('D-192 baseline-admission (S2b follow-on) — the paired-client OWNER HID source admits a direct-UI create', () => {
  /** Deps whose connection-Source create routes through a fake executor that captures
   *  the prepare input's `execution_source`. */
  const connectionSourceDeps = (capture: (src: unknown) => void): WorkEntityCrudRpcDeps => {
    store.registerSource({
      id: 'asana.acme.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'Asana tasks (acme)',
      write_capable: true,
      registered_at: NOW,
    });
    const executor: WorkEntitySourceWriteExecutor = {
      resolveCreateDependencies: async () => ({ ok: true, createArgs: {}, plannedCreates: [] }),
      prepare: (input) => {
        capture((input as { execution_source?: unknown }).execution_source);
        return {
          ok: true,
          vendor_relevant: true,
          prepared: {
            source_id: input.source_id, kind: input.kind, operation: input.operation, patch: input.patch,
          } as unknown as WorkEntityVendorWritePrepared,
        };
      },
      dispatch: async () => ({ ok: true, operation: 'create', source_record_id: 'a-owner' }),
      executeCreatePlan: async () => ({ ok: false, reason: 'n/a' }),
      tryFastTrackCreatePlan: async () => ({ ok: false, kind: 'not_granted' }),
    };
    const resolver = createWorkEntityResolver(store);
    return {
      store,
      resolver,
      dispatchers: createWorkEntityDispatchers({
        store, resolver, getWriteExecutor: () => executor, now: () => NOW,
      }),
    };
  };

  /** A registered paired client (the owner's device) — `instance_id` clears the
   *  registered-client gate; `client_token_id` names the device in the derived source. */
  const pairedClient = (): WsClient =>
    ({ instance_id: 'inst-1', client_token_id: 'ctok-1' } as unknown as WsClient);

  it('the slice arrow builds the OWNER (user, user_self) HID source from the client → the executor sees it', async () => {
    let captured: unknown = 'UNSET';
    const handlers = makeWorkEntityCrudHandlers(connectionSourceDeps((s) => { captured = s; }))!.handlers;
    await handlers['work_entity.upsert'](
      { kind: 'task', title: 'owner create', source_id: 'asana.acme.task' } as never,
      pairedClient(),
    );
    // `(user, user_self)` HID — contract-free → the S2 admission admits under full owner
    // permission; the client's token names the device, user_id falls back to 'local'.
    expect(captured).toMatchObject({
      channel: 'user', actor: 'user_self', user_id: 'local', client_token_id: 'ctok-1',
    });
  });

  it('strip-then-set is forgery-safe: a forged origin_execution_source is REPLACED by the trusted owner source', async () => {
    let captured: unknown = 'UNSET';
    const handlers = makeWorkEntityCrudHandlers(connectionSourceDeps((s) => { captured = s; }))!.handlers;
    await handlers['work_entity.upsert'](
      {
        kind: 'task', title: 'spoof', source_id: 'asana.acme.task',
        // A forged privileged door + admission flag — both must be dropped, the trusted
        // owner HID set in their place.
        origin_execution_source: {
          channel: 'mcp', actor: 'contracted_user',
          agent_id: 'x', tool_call_id: 'y', mcp_token_id: 'z', contract_id: 'attacker-door',
        },
        work_entity_write_preadmitted: true,
      } as never,
      pairedClient(),
    );
    expect(captured).toMatchObject({ channel: 'user', actor: 'user_self' });
    // The forged door's contract_id must NOT survive (else it would govern the admission).
    expect((captured as { contract_id?: unknown }).contract_id).toBeUndefined();
  });
});

describe('D-174 work_entity.upsert — update (id present) emits updated', () => {
  it('task update mutates + emits updated', async () => {
    const created = await handleWorkEntityUpsert(deps, { kind: 'task', title: 'draft' });
    const updated = await handleWorkEntityUpsert(deps, {
      kind: 'task',
      id: created.entity.id,
      title: 'final',
    });
    expect((updated.entity as { title: string }).title).toBe('final');
    expect(updated.entity.id).toBe(created.entity.id);
    expect(eventsFor('task', 'updated')).toHaveLength(1);
  });

  it('commitment update routes to the metadata-only update path', async () => {
    const created = await handleWorkEntityUpsert(deps, {
      kind: 'commitment',
      direction: 'inbound',
      statement: 'deliver report',
      derivation: 'user_declared',
    });
    const updated = await handleWorkEntityUpsert(deps, {
      kind: 'commitment',
      id: created.entity.id,
      statement: 'deliver report v2',
    });
    expect((updated.entity as { statement: string }).statement).toBe('deliver report v2');
    expect(eventsFor('commitment', 'updated')).toHaveLength(1);
  });

  it('update of a non-existent row → not_found', async () => {
    await expect(
      handleWorkEntityUpsert(deps, { kind: 'task', id: 'nope', title: 'x' }),
    ).rejects.toMatchObject({ name: 'RpcError', code: 'not_found' });
  });
});

describe('D-174 work_entity.upsert — source extension blob persistence', () => {
  it('task upserts replace caller-supplied source extension blobs and preserve absence/lifecycle updates', async () => {
    const created = await handleWorkEntityUpsert(deps, {
      kind: 'task',
      title: 'extension task',
      source_extension_blob: { a: 1, b: false },
    });

    expect(store.readTask(created.entity.id)?.source_extension_blob).toEqual({ a: 1, b: false });

    await handleWorkEntityUpsert(deps, {
      kind: 'task',
      id: created.entity.id,
      title: 'extension task v2',
      source_extension_blob: { a: 2 },
    });

    expect(store.readTask(created.entity.id)?.source_extension_blob).toEqual({ a: 2 });

    await handleWorkEntityUpsert(deps, {
      kind: 'task',
      id: created.entity.id,
      title: 'extension task v3',
    });

    expect(store.readTask(created.entity.id)?.source_extension_blob).toEqual({ a: 2 });

    await deps.dispatchers.taskMarkDone({ id: created.entity.id });

    expect(store.readTask(created.entity.id)?.source_extension_blob).toEqual({ a: 2 });
  });

  it('commitment upserts replace caller-supplied source extension blobs and preserve absent updates', async () => {
    const created = await handleWorkEntityUpsert(deps, {
      kind: 'commitment',
      direction: 'outbound',
      statement: 'send invoice',
      derivation: 'user_declared',
      source_extension_blob: { a: 1, b: false },
    });

    expect(store.readCommitment(created.entity.id)?.source_extension_blob).toEqual({ a: 1, b: false });

    await handleWorkEntityUpsert(deps, {
      kind: 'commitment',
      id: created.entity.id,
      statement: 'send invoice v2',
      source_extension_blob: { a: 2 },
    });

    expect(store.readCommitment(created.entity.id)?.source_extension_blob).toEqual({ a: 2 });

    await handleWorkEntityUpsert(deps, {
      kind: 'commitment',
      id: created.entity.id,
      statement: 'send invoice v3',
    });

    expect(store.readCommitment(created.entity.id)?.source_extension_blob).toEqual({ a: 2 });
  });
});

describe('D-174 work_entity.delete — per kind (emits deleted, incl. RPC-only dispatchers)', () => {
  it('task delete tombstones + emits deleted', async () => {
    const created = await handleWorkEntityUpsert(deps, { kind: 'task', title: 't' });
    const out = await handleWorkEntityDelete(deps, { kind: 'task', id: created.entity.id });
    expect(out).toMatchObject({ ok: true, id: created.entity.id, tombstoned: true });
    expect(eventsFor('task', 'deleted')).toHaveLength(1);
    // Tombstoned rows drop out of get.
    const got = await handleWorkEntityGet(deps, { kind: 'task', id: created.entity.id });
    expect(got.entity).toBeNull();
  });

  it('note delete tombstones + emits deleted', async () => {
    const created = await handleWorkEntityUpsert(deps, { kind: 'note', body: 'n' });
    const out = await handleWorkEntityDelete(deps, { kind: 'note', id: created.entity.id });
    expect(out.tombstoned).toBe(true);
    expect(eventsFor('note', 'deleted')).toHaveLength(1);
  });

  it('commitment delete (RPC-only dispatcher) tombstones + emits deleted', async () => {
    const created = await handleWorkEntityUpsert(deps, {
      kind: 'commitment',
      direction: 'outbound',
      statement: 's',
      derivation: 'user_declared',
    });
    const out = await handleWorkEntityDelete(deps, { kind: 'commitment', id: created.entity.id });
    expect(out).toMatchObject({ ok: true, tombstoned: true });
    expect(eventsFor('commitment', 'deleted')).toHaveLength(1);
  });

  it('project delete (RPC-only dispatcher) tombstones + emits deleted', async () => {
    const created = await handleWorkEntityUpsert(deps, { kind: 'project', title: 'p' });
    const out = await handleWorkEntityDelete(deps, { kind: 'project', id: created.entity.id });
    expect(out).toMatchObject({ ok: true, tombstoned: true });
    expect(eventsFor('project', 'deleted')).toHaveLength(1);
  });

  it('hard delete (tombstone:false) reports tombstoned:false', async () => {
    const created = await handleWorkEntityUpsert(deps, { kind: 'task', title: 't' });
    const out = await handleWorkEntityDelete(deps, {
      kind: 'task',
      id: created.entity.id,
      tombstone: false,
    });
    expect(out.tombstoned).toBe(false);
  });

  it('delete of a non-existent row → not_found', async () => {
    await expect(
      handleWorkEntityDelete(deps, { kind: 'project', id: 'ghost' }),
    ).rejects.toMatchObject({ name: 'RpcError', code: 'not_found' });
  });
});

describe('D-174 work_entity.list / get', () => {
  it('list returns rows + total for the kind, scoped by polymorphic read', async () => {
    await handleWorkEntityUpsert(deps, { kind: 'task', title: 'a' });
    await handleWorkEntityUpsert(deps, { kind: 'task', title: 'b' });
    await handleWorkEntityUpsert(deps, { kind: 'note', body: 'unrelated' });
    const out = await handleWorkEntityList(deps, { kind: 'task' });
    expect(out.entities).toHaveLength(2);
    expect(out.total).toBe(2);
    expect(out.entities.every((e) => e._kind === 'task')).toBe(true);
  });

  it('list total ignores limit/offset (pagination-safe count)', async () => {
    for (let i = 0; i < 3; i++) {
      await handleWorkEntityUpsert(deps, { kind: 'task', title: `t${i}` });
    }
    const out = await handleWorkEntityList(deps, { kind: 'task', limit: 1 });
    expect(out.entities).toHaveLength(1);
    expect(out.total).toBe(3);
  });

  it('get returns null for an unknown id', async () => {
    const out = await handleWorkEntityGet(deps, { kind: 'task', id: 'missing' });
    expect(out.entity).toBeNull();
  });

  it('applies booking search/lifecycle filters before pagination and keeps total honest', async () => {
    store.writeBooking({
      id: 'booking-match-1', source_id: RECUED_BUILTIN_SOURCE_ID('booking'),
      title: 'Discovery call', lifecycle_state: 'completed',
      counterparty_contact_id: 'contact-needle',
    }, NOW);
    store.writeBooking({
      id: 'booking-match-2', source_id: RECUED_BUILTIN_SOURCE_ID('booking'),
      title: 'Needle review', lifecycle_state: 'completed',
    }, NOW + 1);
    store.writeBooking({
      id: 'booking-open', source_id: RECUED_BUILTIN_SOURCE_ID('booking'),
      title: 'Needle pending', lifecycle_state: 'confirmed',
    }, NOW + 2);

    const page = await handleWorkEntityList(deps, {
      kind: 'booking',
      search: 'needle',
      booking_lifecycle_states: ['completed'],
      limit: 1,
    });
    expect(page.entities).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.entities[0]?._kind).toBe('booking');
  });

  it('rejects search on unsupported kinds and booking lifecycle on other kinds', async () => {
    await expect(handleWorkEntityList(deps, { kind: 'note', search: 'x' }))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleWorkEntityList(deps, {
      kind: 'note',
      booking_lifecycle_states: ['completed'],
    })).rejects.toMatchObject({ code: 'bad_request' });
  });

});

describe('D-174 work_entity.* — validation surfaces', () => {
  it('unknown kind → bad_request on every method', async () => {
    const bad = { kind: 'memo' } as unknown as { kind: 'task' };
    await expect(handleWorkEntityList(deps, bad)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      handleWorkEntityGet(deps, { ...bad, id: 'x' } as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleWorkEntityUpsert(deps, bad as never)).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(
      handleWorkEntityDelete(deps, { ...bad, id: 'x' } as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('missing id → bad_request on get + delete', async () => {
    await expect(
      handleWorkEntityGet(deps, { kind: 'task', id: '' }),
    ).rejects.toThrow(RpcError);
    await expect(
      handleWorkEntityDelete(deps, { kind: 'task', id: '' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('create with a missing required field → bad_request (store validation mapped)', async () => {
    // task create requires `title`; omit it.
    await expect(
      handleWorkEntityUpsert(deps, { kind: 'task' } as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('upsert with a malformed id (empty string / wrong type) → bad_request, NOT a silent create', async () => {
    const before = (await handleWorkEntityList(deps, { kind: 'task' })).total;
    await expect(
      handleWorkEntityUpsert(deps, { kind: 'task', id: '', title: 'x' } as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      handleWorkEntityUpsert(deps, { kind: 'task', id: 123, title: 'x' } as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
    // No row was created by the malformed-update attempts.
    const after = (await handleWorkEntityList(deps, { kind: 'task' })).total;
    expect(after).toBe(before);
  });

  it('upsert with id null/undefined → create (ergonomic "no id")', async () => {
    const a = await handleWorkEntityUpsert(deps, { kind: 'task', id: null, title: 'n' } as never);
    expect(a.entity._kind).toBe('task');
    expect(eventsFor('task', 'created').length).toBeGreaterThanOrEqual(1);
  });
});

/** Minimal WsClient fake — only `instance_id` matters for the gate. */
const ctx = (instance_id: string | null): WsClient =>
  ({
    ws: null,
    realm: 'recued',
    instance_id,
    display_name: 'c',
    connected_at: 0,
    user_id: 'u',
  }) as unknown as WsClient;

describe('D-174 work_entity.* — registered-client gate (slice arrows)', () => {
  it('rejects an UNREGISTERED caller (instance_id null) on every method', async () => {
    const slice = makeWorkEntityCrudHandlers(deps)!;
    const unreg = ctx(null);
    await expect(
      slice.handlers['work_entity.list']({ kind: 'task' }, unreg),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      slice.handlers['work_entity.get']({ kind: 'task', id: 'x' }, unreg),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      slice.handlers['work_entity.upsert']({ kind: 'task', title: 'x' }, unreg),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      slice.handlers['work_entity.delete']({ kind: 'task', id: 'x' }, unreg),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('an unregistered upsert never reaches the store (no write, no event)', async () => {
    const slice = makeWorkEntityCrudHandlers(deps)!;
    await expect(
      slice.handlers['work_entity.upsert']({ kind: 'task', title: 'ghost' }, ctx(null)),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await handleWorkEntityList(deps, { kind: 'task' })).total).toBe(0);
    expect(eventsFor('task', 'created')).toHaveLength(0);
  });

  it('allows a REGISTERED caller through to the write', async () => {
    const slice = makeWorkEntityCrudHandlers(deps)!;
    const out = await slice.handlers['work_entity.upsert'](
      { kind: 'task', title: 'real' },
      ctx('dev-1'),
    );
    expect((out as { entity: { _kind: string } }).entity._kind).toBe('task');
  });
});

describe('D-174 makeWorkEntityCrudHandlers slice', () => {
  it('returns undefined when deps absent (→ not_configured)', () => {
    expect(makeWorkEntityCrudHandlers(undefined)).toBeUndefined();
  });

  it('claims exactly the four CRUD methods', () => {
    const slice = makeWorkEntityCrudHandlers(deps);
    expect(slice).toBeDefined();
    expect(slice!.methods).toEqual([
      'work_entity.list',
      'work_entity.get',
      'work_entity.upsert',
      'work_entity.delete',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// The rpc that backs the webclient's Work Entities surface reads the
// canonical tables. A read_through Source keeps none, yet `sourceFreshness`
// still reports it (state `'read_through'`) — so an unguarded list showed the
// Source as present while listing none of its records, and any row an
// interrupted posture migration left behind would have been served as real.
// ────────────────────────────────────────────────────────────────

describe('work_entity.list vs a read_through Source', () => {
  const PEER_SOURCE = 'recued-peer.hq.task';

  beforeEach(() => {
    store.registerSource({
      id: PEER_SOURCE,
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'Federated peer (task)',
      write_capable: true,
      sync_posture: 'read_through',
      registered_at: NOW,
    });
  });

  it('refuses a read_through source_id rather than answering with an empty list', async () => {
    await expect(
      handleWorkEntityList(deps, { kind: 'task', source_id: PEER_SOURCE }),
    ).rejects.toThrow(/read_through/);
  });

  it('drops rows an interrupted posture migration left in the canonical table', async () => {
    store.writeTask({ source_id: PEER_SOURCE, title: 'migration residue' }, NOW);
    const listed = await handleWorkEntityList(deps, { kind: 'task' });

    expect(listed.entities.map((entity) => entity.source_id)).not.toContain(PEER_SOURCE);
    expect(listed.total).toBe(listed.entities.length);
  });
});
