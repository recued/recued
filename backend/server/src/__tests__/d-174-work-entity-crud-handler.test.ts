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
 *    - the slice self-gates on absent deps + claims its CRUD and completion
 *      methods.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { handleWorkEntitySearch } from '../work-entity-search.js';
import { handleWorkEntityProjectItems } from '../work-entity-project-items.js';
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
  handleWorkEntityTaskMarkDone,
  handleWorkEntityCommitmentClose,
  handleWorkEntityUpsert,
  makeWorkEntityCrudHandlers,
  type WorkEntityCrudRpcDeps,
} from '../work-entity-crud-handler.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let deps: WorkEntityCrudRpcDeps;
let events: WarehouseEvent[];
let writeTime: number;

const NOW = 1_700_000_000_000;

beforeEach(() => {
  writeTime = NOW;
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
    now: () => writeTime,
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

  it('project create and description clearing round-trip through the emitting write path', async () => {
    const out = await handleWorkEntityUpsert(deps, { kind: 'project', title: 'Q3 launch', description: 'Original brief' });
    expect(out.entity._kind).toBe('project');
    expect(eventsFor('project', 'created')).toHaveLength(1);
    const cleared = await handleWorkEntityUpsert(deps, { kind: 'project', id: out.entity.id, description: '' });
    expect(cleared.entity._kind === 'project' && cleared.entity.description).toBe('');
    expect(eventsFor('project', 'updated')).toHaveLength(1);
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
  it('preserves omitted/null assigned contacts, rejects a contradictory clear, and removes only the explicit assignment', async () => {
    const task = store.writeTask({ id: 'assigned-task', source_id: 'recued.task', title: 'Review', body: 'Keep this text',
      done: true, completed_at: NOW - 10, due_at: NOW + 1000, priority: 'high', assigned_contact_id: 'person@example.test',
      parent_project_id: 'launch', parent_calendar_event_id: 'event', linked_mail_thread_id: 'thread', blocks_task_ids: ['dependency'] }, NOW);
    await handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, assigned_contact_id: null } as never);
    await handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, title: 'Review launch' });
    const before = store.readTask(task.id)!;
    expect(before.assigned_contact_id).toBe('person@example.test');
    const eventsBefore = events.length;
    await expect(handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, clear_assigned_contact: true, assigned_contact_id: 'another@example.test' })).rejects.toThrow('not both');
    expect(store.readTask(task.id)).toEqual(before); expect(events).toHaveLength(eventsBefore);
    const saved = await handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, clear_assigned_contact: true });
    expect(saved.entity).not.toHaveProperty('assigned_contact_id');
    const { assigned_contact_id: _removed, ...other } = before;
    expect(store.readTask(task.id)).toEqual(other);
    expect((await handleWorkEntityGet(deps, { kind: 'task', id: task.id })).entity).not.toHaveProperty('assigned_contact_id');
    expect(eventsFor('task', 'updated')).toHaveLength(3);
    await handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, assigned_contact_id: 'another@example.test' });
    expect(store.readTask(task.id)?.assigned_contact_id).toBe('another@example.test');
  });

  it('preserves an omitted project link, rejects a contradictory clear, and explicitly removes only that link', async () => {
    store.writeProject({ id: 'project-link', title: 'Launch', source_id: 'recued.project' }, NOW);
    const task = store.writeTask({ id: 'linked-task', source_id: 'recued.task', title: 'Review', body: 'Keep this text',
      done: true, completed_at: NOW - 10, due_at: NOW + 1000, priority: 'high', assigned_contact_id: 'person@example.test',
      parent_project_id: 'project-link' }, NOW);
    await handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, title: 'Review launch' });
    const before = store.readTask(task.id)!;
    expect(before.parent_project_id).toBe('project-link');
    await expect(handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, clear_parent_project: true, parent_project_id: 'project-link' })).rejects.toThrow('not both');
    expect(store.readTask(task.id)).toEqual(before);
    const saved = await handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, clear_parent_project: true });
    expect(saved.entity).not.toHaveProperty('parent_project_id');
    const { parent_project_id: _removed, ...other } = before;
    expect(store.readTask(task.id)).toEqual(other);
    expect((await handleWorkEntityGet(deps, { kind: 'task', id: task.id })).entity).not.toHaveProperty('parent_project_id');
  });

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

describe('owner project work', () => {
  it('searches linked text before paging and status counts, with literal Unicode matches and bounded matching passages', () => {
    const project = store.writeProject({ id: 'search-project', source_id: 'recued.project', title: 'Search project' }, NOW);
    const text = 'Earlier context. '.repeat(40) + 'ÉCOLE_100% <img src=x> release decision. ' + 'Later context. '.repeat(30);
    const statement = 'Earlier context. '.repeat(15) + 'ÉCOLE_100% <img src=x> release decision. ' + 'Later context. '.repeat(5);
    for (let index = 0; index < 35; index++) {
      const id = String(index).padStart(2, '0');
      store.writeTask({ id: `match-${id}`, source_id: 'recued.task', title: `Task ${id}`, body: text, done: index >= 25, parent_project_id: project.id }, NOW);
      store.writeNote({ id: `match-${id}`, source_id: 'recued.note', title: `Note ${id}`, body: text, related_project_ids: [project.id, project.id] }, NOW);
      store.writeCommitment({ id: `match-${id}`, source_id: 'recued.commitment', statement, direction: 'inbound', derivation: 'user_declared',
        blocks_project_ids: [project.id, project.id], lifecycle_state: index >= 25 ? 'fulfilled' : 'pending' }, NOW);
    }
    for (let index = 0; index < 50; index++) {
      store.writeTask({ id: `a-${index}`, source_id: 'recued.task', title: 'Nonmatching task', parent_project_id: project.id }, NOW + 1);
      store.writeNote({ source_id: 'recued.note', body: 'Nonmatching recent note', related_project_ids: [project.id] }, NOW + index + 1);
    }
    store.writeTask({ source_id: 'recued.task', title: 'Other matching task', body: text, parent_project_id: project.id + '-other' }, NOW);
    store.writeNote({ source_id: 'recued.note', body: text, related_project_ids: [project.id + '-other'] }, NOW);
    store.writeNote({ source_id: 'recued.note', body: 'ÉCOLEX10000 wildcard decoy', related_project_ids: [project.id] }, NOW);
    store.writeNote({ source_id: 'recued.note', body: text, related_project_ids: [project.id], sync_state: 'orphaned' }, NOW);
    store.registerSource({ id: 'peer.note', top_tier_kind: 'note', source_kind: 'connection', source_label: 'Remote notes',
      write_capable: false, sync_posture: 'read_through', registered_at: NOW });
    store.writeNote({ source_id: 'peer.note', body: text, related_project_ids: [project.id] }, NOW);
    for (const kind of ['task', 'note', 'commitment'] as const) {
      const request = { project_id: project.id, kind, query: '  école_100%  ', commitment_status: kind === 'commitment' ? 'all' as const : undefined };
      const first = handleWorkEntityProjectItems(deps, { ...request, limit: 10 });
      const tail = handleWorkEntityProjectItems(deps, { ...request, offset: 30, limit: 10 });
      expect(first).toMatchObject({ query: 'école_100%', total: 35, offset: 0 });
      expect(first.items).toHaveLength(10); expect(tail.items).toHaveLength(5);
      expect(first.items.every(item => item.id.startsWith('match-'))).toBe(true);
      expect(new Set([...first.items, ...tail.items].map(item => item.id)).size).toBe(15);
      const passage = kind === 'commitment' ? first.items[0]!.title : first.items[0]!.excerpt;
      expect(passage).toContain('ÉCOLE_100%'); expect(passage.length).toBeLessThanOrEqual(202);
      expect(first.items[0]!.excerpt.length).toBeLessThanOrEqual(182);
    }
    expect(handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'task', query: 'école_100%', task_completion: 'completed' }))
      .toMatchObject({ total: 10, total_tasks: 35, open_tasks: 25, task_completion: 'completed' });
    expect(handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'commitment', query: 'école_100%' })).toMatchObject({ total: 25 });
    expect(handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'note', query: 'missing phrase' })).toMatchObject({ total: 0, items: [] });
  });

  it('rejects invalid search text and echoes an empty query for compatible browsing', () => {
    const project = store.writeProject({ source_id: 'recued.project', title: 'Project' }, NOW);
    for (const query of [null, 12, 'x'.repeat(201), 'bad\u0000text', 'bad\ntext']) {
      expect(() => handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'note', query } as never)).toThrow(RpcError);
    }
    expect(handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'note', query: '   ' })).toMatchObject({ query: '', total: 0 });
  });

  it('pages blocking commitments with exact membership, closed-state scope and merged contact display', async () => {
    const project = store.writeProject({ id: 'launch', source_id: 'recued.project', title: 'Launch' }, NOW);
    const base = { source_id: 'recued.commitment', direction: 'inbound' as const, derivation: 'user_declared' as const };
    for (let index = 0; index < 12; index++) store.writeCommitment({ ...base, statement: `Unrelated ${index}`, promised_for_at: NOW - index }, NOW);
    store.writeCommitment({ ...base, id: 'first', statement: 'Client approval', counterparty_contact_id: 'merged-loser',
      promised_for_at: NOW - 2, due_status: 'overdue', blocks_project_ids: [project.id, project.id], sync_state: 'stale_unreachable' }, NOW);
    store.writeCommitment({ ...base, id: 'second', statement: 'Our deliverable', direction: 'outbound', promised_for_at: NOW - 1,
      blocks_project_ids: ['another-project', project.id] }, NOW);
    store.writeCommitment({ ...base, id: 'undated', statement: 'No date yet', direction: 'internal', blocks_project_ids: [project.id] }, NOW);
    store.writeCommitment({ ...base, id: 'closed', statement: 'Approval already received', lifecycle_state: 'fulfilled', promised_for_at: NOW,
      blocks_project_ids: [project.id] }, NOW);
    store.writeCommitment({ ...base, statement: 'Prefix does not match', blocks_project_ids: [project.id + '-other'] }, NOW);
    store.writeCommitment({ ...base, statement: 'Orphaned link', blocks_project_ids: [project.id], sync_state: 'orphaned' }, NOW);
    const deleted = store.writeCommitment({ ...base, statement: 'Deleted link', blocks_project_ids: [project.id] }, NOW);
    await handleWorkEntityDelete(deps, { kind: 'commitment', id: deleted.id });
    store.registerSource({ id: 'peer.commitment', top_tier_kind: 'commitment', source_kind: 'connection', source_label: 'Peer promises',
      write_capable: false, registered_at: NOW, sync_posture: 'read_through' });
    store.writeCommitment({ ...base, source_id: 'peer.commitment', statement: 'Migration residue', blocks_project_ids: [project.id] }, NOW);
    deps.contactDisplay = { getByContactIdResolved: vi.fn(() => ({ name: 'Current contact', email: 'current@example.test', contact_id: 'survivor' })) };
    const first = handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'commitment', limit: 2 });
    expect(first).toMatchObject({ total: 3, commitment_status: 'open', provider_only_sources: ['Peer promises'], items: [
      { id: 'first', title: 'Client approval', stale: true, commitment: { direction: 'inbound', due_status: 'overdue', counterparty_label: 'Current contact' } },
      { id: 'second', commitment: { direction: 'outbound' } },
    ] });
    expect(handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'commitment', offset: 2, limit: 2 }))
      .toMatchObject({ total: 3, items: [{ id: 'undated' }] });
    expect(handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'commitment', commitment_status: 'all' }))
      .toMatchObject({ total: 4, commitment_status: 'all', items: [{ id: 'first' }, { id: 'second' }, { id: 'undated' }, { id: 'closed' }] });
    expect(store.readCommitment('first')?.counterparty_contact_id).toBe('merged-loser');
  });

  it('pages exact project links over the complete visible dataset, with matching task counts', async () => {
    const project = store.writeProject({ id: 'project-one', source_id: 'recued.project', title: 'Launch' }, NOW);
    for (let index = 0; index < 1_005; index++) store.writeNote({ source_id: 'recued.note', body: `Unrelated ${index}` }, NOW + index);
    for (let index = 0; index < 6; index++) {
      store.writeTask({ id: `linked-${index}`, source_id: 'recued.task', title: `Task ${index}`, parent_project_id: project.id, done: index >= 4 }, NOW);
      store.writeNote({ id: `linked-${index}`, source_id: 'recued.note', body: `Note ${index}`, related_project_ids: [project.id, project.id],
        ...(index === 0 ? { sync_state: 'stale_unreachable' as const } : {}) }, NOW - 10);
    }
    store.writeNote({ source_id: 'recued.note', body: 'Prefix is not membership', related_project_ids: [`${project.id}-other`] }, NOW);
    const deleted = store.writeNote({ source_id: 'recued.note', body: 'Deleted link', related_project_ids: [project.id] }, NOW);
    await handleWorkEntityDelete(deps, { kind: 'note', id: deleted.id });
    store.writeNote({ source_id: 'recued.note', body: 'Orphan', related_project_ids: [project.id], sync_state: 'orphaned' }, NOW);
    store.registerSource({ id: 'peer.note', top_tier_kind: 'note', source_kind: 'connection', source_label: 'Peer notes', write_capable: false,
      registered_at: NOW, sync_posture: 'read_through' });
    store.writeNote({ source_id: 'peer.note', body: 'Migration residue', related_project_ids: [project.id] }, NOW + 1);
    const pages = [0, 2, 4].map(offset => handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'note', limit: 2, offset }));
    expect(pages.map(page => page.items.map(item => item.id))).toEqual([['linked-0', 'linked-1'], ['linked-2', 'linked-3'], ['linked-4', 'linked-5']]);
    expect(pages.map(page => page.total)).toEqual([6, 6, 6]);
    expect(pages[0]).toMatchObject({ provider_only_sources: ['Peer notes'], items: [{ stale: true }, {}] });
    const tasks = await makeWorkEntityCrudHandlers(deps)!.handlers['work_entity.project.items'](
      { project_id: project.id, kind: 'task', limit: 2, offset: 2 }, { instance_id: 'owner' } as WsClient);
    expect(tasks).toMatchObject({ total: 6, open_tasks: 4, offset: 2, items: [{ id: 'linked-2', done: false }, { id: 'linked-3', done: false }] });
    store.registerSource({ id: 'peer.task', top_tier_kind: 'task', source_kind: 'connection', source_label: 'Peer tasks', write_capable: false,
      registered_at: NOW, sync_posture: 'read_through' });
    store.writeTask({ source_id: 'peer.task', title: 'Provider-only residue', parent_project_id: project.id, done: false }, NOW);
    store.writeTask({ source_id: 'recued.task', title: 'Another project', parent_project_id: `${project.id}-other`, done: false }, NOW);
    const open = handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'task', task_completion: 'open', offset: 2, limit: 2 });
    expect(open).toMatchObject({ total: 4, total_tasks: 6, open_tasks: 4, task_completion: 'open', provider_only_sources: ['Peer tasks'],
      items: [{ id: 'linked-2', done: false, created_at: NOW }, { id: 'linked-3', done: false }] });
    const completed = handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'task', task_completion: 'completed', offset: 1, limit: 1 });
    expect(completed).toMatchObject({ total: 2, total_tasks: 6, open_tasks: 4, task_completion: 'completed', items: [{ id: 'linked-5', done: true }] });
    store.writeTask({ id: 'linked-2', source_id: 'recued.task', title: 'Task 2', parent_project_id: project.id, done: true }, NOW + 1);
    expect(handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'task' }).open_tasks).toBe(3);
  });

  it('rejects unavailable project identities and invalid page scopes before listing children', async () => {
    const spy = vi.spyOn(deps.resolver, 'listByKind');
    expect(() => handleWorkEntityProjectItems(deps, { project_id: 'missing', kind: 'note' })).toThrow('no longer available');
    expect(() => handleWorkEntityProjectItems(deps, { project_id: 'missing', kind: 'project' as never })).toThrow('tasks, notes or commitments');
    expect(() => handleWorkEntityProjectItems(deps, { project_id: 'missing', kind: 'task', commitment_status: 'all' })).toThrow('outstanding or all');
    expect(() => handleWorkEntityProjectItems(deps, { project_id: 'missing', kind: 'task', limit: 0 })).toThrow('limit of 1');
    expect(() => handleWorkEntityProjectItems(deps, { project_id: 'missing', kind: 'task', task_completion: 'closed' as never })).toThrow('open, completed or all');
    expect(() => handleWorkEntityProjectItems(deps, { project_id: 'missing', kind: 'note', task_completion: 'open' })).toThrow('open, completed or all');
    const project = store.writeProject({ source_id: 'recued.project', title: 'Removed project' }, NOW);
    await handleWorkEntityDelete(deps, { kind: 'project', id: project.id });
    expect(() => handleWorkEntityProjectItems(deps, { project_id: project.id, kind: 'task' })).toThrow('no longer available');
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
  });
});

describe('indexed owner work search', () => {
  it('pages only visible retained bookings and isolates a booking index failure from other kinds', () => {
    store.registerSource({ id: 'peer.booking', top_tier_kind: 'booking', source_kind: 'connection', source_label: 'Peer', write_capable: false, sync_posture: 'read_through' });
    store.writeBooking({ id: 'provider-only', source_id: 'peer.booking', title: 'Bookingpage residue', lifecycle_state: 'confirmed' }, NOW);
    store.writeBooking({ id: 'orphan', source_id: 'recued.booking', title: 'Bookingpage orphan', lifecycle_state: 'confirmed', sync_state: 'orphaned' }, NOW);
    const removed = store.writeBooking({ id: 'removed', source_id: 'recued.booking', title: 'Bookingpage removed', lifecycle_state: 'confirmed' }, NOW);
    store.deleteBooking(removed.id, { tombstone: true, now: NOW + 1 });
    for (let i = 0; i < 5; i++) store.writeBooking({ id: 'page-' + i, source_id: 'recued.booking', title: 'Bookingpage visible', lifecycle_state: 'confirmed' }, NOW);
    const pages = [0, 2, 4].map(offset => handleWorkEntitySearch(deps, { query: 'Bookingpage', kind: 'booking', limit: 2, offset }).groups[0]!);
    expect(pages.map(page => page.more)).toEqual([true, true, false]); expect(new Set(pages.flatMap(page => page.matches.map(row => row.id))).size).toBe(5);
    expect(pages.flatMap(page => page.matches).every(row => row.id.startsWith('page-'))).toBe(true);
    store.writeNote({ source_id: 'recued.note', body: 'Bookingpage note' }, NOW);
    const search = store.searchPageByText.bind(store), spy = vi.spyOn(store, 'searchPageByText').mockImplementation((kind, query, options) => {
      if (kind === 'booking') throw new Error('Booking index unavailable'); return search(kind, query, options);
    });
    try { const groups = handleWorkEntitySearch(deps, { query: 'Bookingpage' }).groups;
      expect(groups.find(group => group.kind === 'booking')).toMatchObject({ matches: [], error: 'Bookings could not be searched. Try again.' });
      expect(groups.find(group => group.kind === 'note')?.matches).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it('previews later passages with all query terms in notes, task bodies and project descriptions without changing their source text', async () => {
    const body = 'Renewal background. '.repeat(30) + 'The RENEWAL deadline is 30 November. '
      + '<img src=x onerror=alert(1)> ' + 'Closing background. '.repeat(30);
    const entities = [
      { kind: 'note', entity: store.writeNote({ source_id: 'recued.note', title: 'Account notes', body }, NOW) },
      { kind: 'task', entity: store.writeTask({ source_id: 'recued.task', title: 'Account task', body }, NOW) },
      { kind: 'project', entity: store.writeProject({ source_id: 'recued.project', title: 'Account project', description: body }, NOW) },
    ] as const;
    const groups = handleWorkEntitySearch(deps, { query: 'renewal deadline' }).groups;
    for (const { kind, entity } of entities) {
      const result = groups.find(group => group.kind === kind)?.matches[0];
      expect(result?.id).toBe(entity.id);
      expect(result?.excerpt).toContain('The RENEWAL deadline is 30 November.');
      expect(result?.excerpt).toContain('<img src=x onerror=alert(1)>');
      expect(result?.excerpt).not.toContain('<mark>');
      expect(result?.excerpt.startsWith('…')).toBe(true);
      expect(result?.excerpt.endsWith('…')).toBe(true);
      expect(result?.excerpt.length).toBeLessThanOrEqual(182);
      const fetched = await handleWorkEntityGet(deps, { kind, id: entity.id });
      expect(fetched.entity).toEqual({ _kind: kind, ...entity });
    }
  });

  it('preserves Unicode in excerpts and keeps title-only and stemmed matches as plain opening passages', () => {
    store.writeNote({ id: 'accent', source_id: 'recued.note', title: 'Account notes',
      body: 'Opening details. '.repeat(30) + 'Cafe\u0301 renewal 🧾 deadline.' + ' Closing details.'.repeat(30) }, NOW);
    expect(handleWorkEntitySearch(deps, { query: 'cafe deadline', kind: 'note' }).groups[0]?.matches[0]?.excerpt)
      .toContain('Cafe\u0301 renewal 🧾 deadline.');
    store.writeNote({ id: 'title-only', source_id: 'recued.note', title: 'Renewal checklist', body: 'Opening details. '.repeat(30) }, NOW);
    const titleOnly = handleWorkEntitySearch(deps, { query: 'renewal', kind: 'note' }).groups[0]?.matches.find(match => match.id === 'title-only');
    expect(titleOnly?.excerpt).toMatch(/^Opening details\./);
    expect(titleOnly?.excerpt).not.toContain('renewal');
    store.writeNote({ id: 'stem', source_id: 'recued.note', title: 'Checklist', body: 'We are running the account review.' }, NOW);
    expect(handleWorkEntitySearch(deps, { query: 'runs', kind: 'note' }).groups[0]?.matches)
      .toEqual([expect.objectContaining({ id: 'stem', excerpt: 'We are running the account review.' })]);
  });

  it('finds all five kinds through the existing index, including notes beyond the loaded-list window', async () => {
    store.writeNote({ id: 'shared-id', source_id: 'recued.note', body: 'An older needleproof note.' }, NOW - 31_536_000_000);
    for (let index = 0; index < 1_005; index++) {
      store.writeNote({ source_id: 'recued.note', body: `Recent unrelated entry ${index}` }, NOW + index);
    }
    store.writeTask({ id: 'shared-id', source_id: 'recued.task', title: 'Needleproof task' }, NOW);
    await handleWorkEntityUpsert(deps, { kind: 'project', title: 'Project', description: 'Needleproof in the description.' });
    await handleWorkEntityUpsert(deps, { kind: 'commitment', direction: 'outbound', derivation: 'user_declared', statement: 'Needleproof promise' });
    store.writeBooking({ id: 'shared-id', source_id: 'recued.booking', title: 'Needleproof booking', lifecycle_state: 'confirmed' }, NOW);
    const groups = handleWorkEntitySearch(deps, { query: 'needleproof' }).groups;
    expect(groups.map(group => [group.kind, group.matches.length, group.more])).toEqual([
      ['task', 1, false], ['note', 1, false], ['project', 1, false], ['commitment', 1, false], ['booking', 1, false],
    ]);
    expect(groups[1]?.matches[0]).toMatchObject({ id: 'shared-id', title: 'Note', excerpt: 'An older needleproof note.',
      source_label: 'Recued built-in', stale: false, pending_write: false });
    expect(handleWorkEntitySearch(deps, { query: 'needleproof absentword', kind: 'note' }).groups[0]?.matches).toEqual([]);
  });

  it('filters invisible and read-through residue before stable paging, and labels stale matches', async () => {
    for (let index = 0; index < 12; index++) {
      const note = store.writeNote({ source_id: 'recued.note', body: 'Pageproof deleted' }, NOW + index);
      await handleWorkEntityDelete(deps, { kind: 'note', id: note.id });
    }
    store.writeNote({ source_id: 'recued.note', body: 'Pageproof orphan', sync_state: 'orphaned' }, NOW + 100);
    store.registerSource({ id: 'peer.note', top_tier_kind: 'note', source_kind: 'connection', source_label: 'Peer',
      write_capable: false, registered_at: NOW, sync_posture: 'read_through' });
    store.writeNote({ source_id: 'peer.note', body: 'Pageproof migration residue' }, NOW + 200);
    for (let index = 0; index < 6; index++) store.writeNote({ id: `page-${index}`, source_id: 'recued.note', body: 'Pageproof visible',
      ...(index === 0 ? { sync_state: 'stale_unreachable' as const } : {}) }, NOW);
    const pages = [0, 2, 4].map(offset => handleWorkEntitySearch(deps, { query: 'pageproof', kind: 'note', limit: 2, offset }).groups[0]!);
    expect(pages.map(page => page.matches.map(match => match.id))).toEqual([['page-0', 'page-1'], ['page-2', 'page-3'], ['page-4', 'page-5']]);
    expect(pages.map(page => page.more)).toEqual([true, true, false]);
    expect(pages[0]?.matches[0]?.stale).toBe(true);
  });

  it('keeps other kinds available on a failed kind and rejects unsupported or invalid pages', () => {
    store.writeNote({ source_id: 'recued.note', body: 'Survivor match' }, NOW);
    const search = store.searchPageByText.bind(store);
    const spy = vi.spyOn(store, 'searchPageByText').mockImplementation((kind, query, options) => {
      if (kind === 'task') throw new Error('unavailable');
      return search(kind, query, options);
    });
    const groups = handleWorkEntitySearch(deps, { query: 'survivor' }).groups;
    expect(groups[0]).toMatchObject({ kind: 'task', error: expect.stringContaining('could not be searched') });
    expect(groups[1]?.matches).toHaveLength(1);
    expect(groups.slice(1).every(group => group.error === undefined)).toBe(true);
    spy.mockRestore();
    expect(() => handleWorkEntitySearch(deps, { query: 'x', kind: 'asset' as 'task' })).toThrow(RpcError);
    expect(() => handleWorkEntitySearch(deps, { query: 'x', limit: 51 })).toThrow(RpcError);
    expect(() => handleWorkEntitySearch(deps, { query: 'x', offset: 1 })).toThrow(RpcError);
    expect(handleWorkEntitySearch(deps, { query: '   ' })).toEqual({ groups: [] });
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

describe('work_entity.task.mark_done — Today task actions', () => {
  it('completes the original task with one completion event, preserving its other fields', async () => {
    const original = store.writeTask({ source_id: 'recued.task', title: 'Send proposal',
      body: 'Keep these notes', due_at: NOW + 60_000, priority: 'medium', blocks_task_ids: [] }, NOW);
    const result = await handleWorkEntityTaskMarkDone(deps, { id: original.id, done: true });
    expect(result.entity).toMatchObject({ ...original, _kind: 'task', done: true, completed_at: NOW });
    expect(store.readTask(original.id)?.done).toBe(true);
    expect(eventsFor('task', 'completed')).toHaveLength(1);
    expect(eventsFor('task', 'completed')[0]?.record_id).toBe(original.id);
    writeTime += 1000;
    await handleWorkEntityTaskMarkDone(deps, { id: original.id, done: true });
    expect(eventsFor('task', 'completed')).toHaveLength(1);
    expect(eventsFor('task', 'updated')).toHaveLength(1);
    expect(store.readTask(original.id)?.completed_at).toBe(NOW);
    await handleWorkEntityTaskMarkDone(deps, { id: original.id, done: false });
    expect(store.readTask(original.id)).toMatchObject({ done: false, body: original.body, due_at: original.due_at });
    expect(eventsFor('task', 'completed')).toHaveLength(1);
  });

  it('reschedules through upsert without changing completion, title, notes or task identity', async () => {
    const original = store.writeTask({ source_id: 'recued.task', title: 'Prepare demo',
      body: 'Keep these notes', due_at: NOW, priority: 'high' }, NOW);
    const result = await handleWorkEntityUpsert(deps, { kind: 'task', id: original.id, due_at: NOW + 86_400_000 });
    expect(result.entity).toMatchObject({ ...original, _kind: 'task', due_at: NOW + 86_400_000 });
    expect(eventsFor('task', 'updated')).toHaveLength(1);
    expect(eventsFor('task', 'completed')).toHaveLength(0);
    expect(store.listTasks({})).toHaveLength(1);
  });

  it('serializes overlapping completion and rescheduling without restoring an old field or repeating completion', async () => {
    const task = store.writeTask({ source_id: 'recued.task', title: 'Concurrent edits', body: 'Keep notes', due_at: NOW }, NOW);
    await Promise.all([
      handleWorkEntityTaskMarkDone(deps, { id: task.id, done: true }),
      handleWorkEntityTaskMarkDone(deps, { id: task.id, done: true }),
      handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, due_at: NOW + 86_400_000 }),
    ]);
    expect(store.readTask(task.id)).toMatchObject({ done: true, due_at: NOW + 86_400_000, body: 'Keep notes' });
    expect(eventsFor('task', 'completed')).toHaveLength(1);
    expect(eventsFor('task', 'updated')).toHaveLength(2);
  });

  it('releases a failed mutation so a subsequent correction can succeed', async () => {
    const task = store.writeTask({ source_id: 'recued.task', title: 'Retry', due_at: NOW }, NOW);
    await expect(handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, due_at: NaN })).rejects.toThrow();
    await handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, due_at: NOW + 60_000 });
    expect(store.readTask(task.id)?.due_at).toBe(NOW + 60_000);
  });

  it('orders a concurrent delete after the submitted task edit and refuses later stale edits', async () => {
    const task = store.writeTask({ source_id: 'recued.task', title: 'Remove after edit', due_at: NOW }, NOW);
    await Promise.all([
      handleWorkEntityTaskMarkDone(deps, { id: task.id, done: true }),
      handleWorkEntityDelete(deps, { kind: 'task', id: task.id }),
    ]);
    expect(store.readTask(task.id)).toMatchObject({ sync_state: 'tombstoned', deleted_at: NOW });
    await expect(handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, due_at: NOW + 60_000 }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not mistake a pending local completion for a confirmed duplicate', async () => {
    const task = store.writeTask({ source_id: 'recued.task', title: 'Still pending', done: true }, NOW);
    const pending = { staged_at: NOW, operation: 'complete', dirty_fields: ['done'], state: 'awaiting_verify' } as const;
    store.stagePendingWrite('task', task.id, { ...pending, dirty_fields: [...pending.dirty_fields] });
    const result = await handleWorkEntityTaskMarkDone(deps, { id: task.id, done: true });
    // The dispatcher is still invoked for a pending write; its state must
    // remain visible to the caller until the source executor clears it.
    expect(eventsFor('task', 'updated')).toHaveLength(1);
    expect(result.entity.pending_write).toEqual(pending);
  });

  it.each(['readonly', 'read_through', 'stale', 'deleted', 'unregistered'] as const)(
    'refuses a %s task without changing it or emitting completion', async (posture) => {
      store.registerSource({ id: 'other.task', top_tier_kind: 'task', source_kind: 'builtin',
        source_label: 'Other', write_capable: posture !== 'readonly',
        ...(posture === 'read_through' ? { sync_posture: 'read_through' } : {}) });
      const task = store.writeTask({ source_id: 'other.task', title: 'Unavailable',
        ...(posture === 'stale' ? { sync_state: 'stale_unreachable' } : {}) }, NOW);
      if (posture === 'deleted') store.deleteTask(task.id, { tombstone: true, now: NOW });
      if (posture === 'unregistered') store.unregisterSource('other.task');
      await expect(handleWorkEntityTaskMarkDone(deps, { id: task.id, done: true })).rejects.toThrow(RpcError);
      await expect(handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, due_at: NOW + 60_000 })).rejects.toThrow(RpcError);
      await expect(handleWorkEntityUpsert(deps, { kind: 'task', id: task.id, clear_assigned_contact: true })).rejects.toThrow(RpcError);
      expect(store.readTask(task.id)?.done).toBe(false);
      expect(store.readTask(task.id)?.due_at).toBeUndefined();
      expect(eventsFor('task', 'completed')).toHaveLength(0);
      expect(eventsFor('task', 'updated')).toHaveLength(0);
    },
  );

  it('rejects missing tasks, malformed completion and caller-supplied authority', async () => {
    await expect(handleWorkEntityTaskMarkDone(deps, { id: 'missing', done: true }))
      .rejects.toMatchObject({ code: 'not_found' });
    for (const args of [undefined, { id: '', done: true }, { id: 'x', done: 'true' },
      { id: 'x', done: true, work_entity_write_preadmitted: true }]) {
      await expect(handleWorkEntityTaskMarkDone(deps, args as never)).rejects.toMatchObject({ code: 'bad_request' });
    }
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
    await expect(slice.handlers['work_entity.project.items']({ project_id: 'private', kind: 'task' }, unreg))
      .rejects.toMatchObject({ code: 'unauthorized' });
    await expect(slice.handlers['work_entity.search']({ query: 'private' }, unreg))
      .rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      slice.handlers['work_entity.upsert']({ kind: 'task', title: 'x' }, unreg),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      slice.handlers['work_entity.delete']({ kind: 'task', id: 'x' }, unreg),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      slice.handlers['work_entity.task.mark_done']({ id: 'x', done: true }, unreg),
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
    const found = await slice.handlers['work_entity.search']({ query: 'real' }, ctx('dev-1'));
    expect(found).toMatchObject({ groups: expect.arrayContaining([
      expect.objectContaining({ kind: 'task', matches: expect.arrayContaining([expect.objectContaining({ title: 'real' })]) }),
    ]) });
  });
});

describe('D-174 makeWorkEntityCrudHandlers slice', () => {
  it('returns undefined when deps absent (→ not_configured)', () => {
    expect(makeWorkEntityCrudHandlers(undefined)).toBeUndefined();
  });

  it('claims the CRUD methods and the separate task-completion operation', () => {
    const slice = makeWorkEntityCrudHandlers(deps);
    expect(slice).toBeDefined();
    expect(slice!.methods).toEqual([
      'work_entity.project.attention',
      'work_entity.project.items',
      'work_entity.linked_from',
      'work_entity.search',
      'work_entity.list',
      'work_entity.get',
      'work_entity.upsert',
      'work_entity.task.mark_done',
      'work_entity.commitment.fulfill',
      'work_entity.commitment.cancel',
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


describe('D-325 — the owner can close a commitment', () => {
  const create = async (expiry_policy: 'strict_expire' | 'escalate_overdue' = 'escalate_overdue') =>
    (await handleWorkEntityUpsert(deps, { kind: 'commitment', direction: 'internal', statement: 'Renew passport', derivation: 'user_declared', expiry_policy })).entity.id;

  it('fulfills through the semantic dispatcher and retains the time on concurrent retries', async () => {
    const id = await create();
    writeTime += 5000;
    const replies = await Promise.all([handleWorkEntityCommitmentClose(deps, { id }, 'fulfilled'), handleWorkEntityCommitmentClose(deps, { id }, 'fulfilled')]);
    expect(replies[0]).toEqual(replies[1]);
    expect(replies[0]!.entity).toMatchObject({ _kind: 'commitment', lifecycle_state: 'fulfilled', lifecycle_changed_at: writeTime });
    expect(eventsFor('commitment', 'state_changed')).toHaveLength(1);
    writeTime += 5000;
    expect((await handleWorkEntityCommitmentClose(deps, { id }, 'fulfilled')).entity.lifecycle_changed_at).toBe(writeTime - 5000);
  });

  it('cancels this occurrence, rejects a conflicting close and refuses client timestamps', async () => {
    const id = await create();
    expect((await handleWorkEntityCommitmentClose(deps, { id }, 'cancelled')).entity.lifecycle_state).toBe('cancelled');
    await expect(handleWorkEntityCommitmentClose(deps, { id }, 'fulfilled')).rejects.toBeInstanceOf(RpcError);
    await expect(handleWorkEntityCommitmentClose(deps, { id, fulfilled_at: 1 } as never, 'fulfilled')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('requires the paired webclient at the RPC boundary', async () => {
    const id = await create();
    const slice = makeWorkEntityCrudHandlers(deps)!;
    for (const client of [{}, { instance_id: 'bridge', client_kind: 'bridge' }]) {
      await expect(slice.handlers['work_entity.commitment.fulfill']({ id }, client as WsClient)).rejects.toMatchObject({ code: 'unauthorized' });
    }
    const out = await slice.handlers['work_entity.commitment.fulfill']({ id }, { instance_id: 'owner', client_kind: 'webclient' } as WsClient);
    expect(out.entity.lifecycle_state).toBe('fulfilled');
  });
});
