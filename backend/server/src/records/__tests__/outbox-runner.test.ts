import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RecipeDefinition, RecordsExecutionBinding, RecordsSchemaSnapshot } from '@recued/contracts';

import { composeRecordsOutbox } from '../../composition/bin/wire-records-outbox.js';
import { drainRecordsOutboxOnce } from '../outbox-runner.js';
import { deriveRecordsSubscriberBindings } from '../subscribers.js';
import { recordsSubscriberGrantSnapshotMatches } from '../subscribers.js';
import { createRecordsStore, type RecordsStore } from '../store.js';

const OWNER = { publisher: 'publisher-a', pack_slug: 'watch-pack' } as const;
const STORAGE = 'a'.repeat(64);
const DECLARATION = 'b'.repeat(64);
const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    job: {
      kind: 'job',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'title', slot: 's1', kind: 'string', required: true },
      ],
    },
  },
};
const create: RecordsExecutionBinding = {
  kind: 'core.records',
  action: 'create',
  entity: 'job',
  owner: OWNER,
  pack_version: 1,
  storage_schema_hash: STORAGE,
  declaration_hash: DECLARATION,
  operation_digest: 'create-digest',
};
const watcher = {
  recipe_id: 'watch-created-job',
  version: 1,
  ttl: 0,
  metadata: { name: 'Watch', description: 'Watch', author: OWNER.publisher, supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  event_triggers: [{ event: 'record.created', filter: { kind: 'job' } }],
  steps: [],
  output: { render: [] },
  chat_exposed: false,
} as unknown as RecipeDefinition;

describe('D-221 durable Records watcher delivery', () => {
  let db: Database.Database;
  let store: RecordsStore;
  const subscribers = deriveRecordsSubscriberBindings(OWNER, [{
    recipe: watcher,
    publisher_id: OWNER.publisher,
  }]);

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    store = createRecordsStore(db, { now: (() => { let time = 1_000; return () => time++; })() });
    store.installNamespace({
      owner: OWNER,
      version: 1,
      storage_schema_hash: STORAGE,
      declaration_hash: DECLARATION,
      artifact_digest: 'artifact',
      schema,
      bindings: { create },
      subscriber_digest: subscribers.digest,
      subscribers: subscribers.bindings,
    });
  });

  afterEach(() => db.close());

  it('retries with one stable event id and acknowledges only after the awaited sink succeeds', async () => {
    store.execute({ binding: create, args: { id: 'a', values: { title: 'A' } }, principal: 'owner' });
    const seen: string[] = [];
    let fail = true;
    const runtime = {
      admit: () => true,
      deliver: async ({ event }: { event: { event_id: string } }) => {
        seen.push(event.event_id);
        if (fail) throw new Error('temporary sink failure');
      },
    };
    expect(await drainRecordsOutboxOnce(store, runtime, { max_retries: 3 }))
      .toMatchObject({ attempted: 1, delivered: 0, retried: 1 });
    expect(store.getNamespace(OWNER)?.quota.outbox_count).toBe(1);
    fail = false;
    expect(await drainRecordsOutboxOnce(store, runtime, { max_retries: 3 }))
      .toMatchObject({ attempted: 1, delivered: 1, retried: 0 });
    expect(new Set(seen).size).toBe(1);
    expect(store.listOutbox(OWNER, 'delivered')).toHaveLength(1);
    expect(store.getNamespace(OWNER)?.quota.outbox_count).toBe(0);
  });

  it('threads an unforgeable causal root and dead-letters direct watcher recursion', async () => {
    store.execute({ binding: create, args: { id: 'a', values: { title: 'A' } }, principal: 'owner' });
    const dispatches: Array<{ root_event_id: string; causal_depth: number; watcher_digest: string }> = [];
    await drainRecordsOutboxOnce(store, {
      admit: () => true,
      deliver: async ({ mutation_context }) => {
        dispatches.push(mutation_context);
        store.execute({
          binding: create,
          args: { id: 'b', values: { title: 'B' } },
          principal: 'watcher',
          ...mutation_context,
        });
      },
    });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ causal_depth: 1 });
    expect(await drainRecordsOutboxOnce(store, { admit: () => true, deliver: async () => {} }))
      .toMatchObject({ attempted: 1, delivered: 0, dead_lettered: 1 });
    expect(store.listOutbox(OWNER, 'dead_letter')).toHaveLength(1);
    expect(store.getNamespace(OWNER)?.quota.outbox_count).toBe(0);
  });

  it('explicitly retires a queued old activation during an identical reinstall', async () => {
    store.execute({ binding: create, args: { id: 'a', values: { title: 'A' } }, principal: 'owner' });
    store.installNamespace({
      owner: OWNER,
      version: 1,
      storage_schema_hash: STORAGE,
      declaration_hash: DECLARATION,
      artifact_digest: 'artifact',
      schema,
      bindings: { create },
      subscriber_digest: subscribers.digest,
      subscribers: subscribers.bindings,
      expected_state_generation: store.getNamespace(OWNER)!.state_generation,
    });
    expect(store.listOutbox(OWNER, 'pending')).toEqual([]);
    expect(store.listOutbox(OWNER, 'dead_letter')).toHaveLength(1);
    let crossed = false;
    expect(await drainRecordsOutboxOnce(store, {
      admit: () => true,
      deliver: async () => { crossed = true; },
    })).toMatchObject({ attempted: 0, dead_lettered: 0 });
    expect(crossed).toBe(false);
  });

  it('binds pending delivery to an exact grant set and refuses mutable watcher config', () => {
    const snapshot = {
      installed_pack_id: 'records-pack',
      ingredient_id: 'records-catalog',
      connection_name: 'records-catalog',
      group_ids: ['read', 'write'],
    };
    expect(recordsSubscriberGrantSnapshotMatches(snapshot, [
      { segments: ['records-pack', 'records-catalog', 'records-catalog', 'write'], value: { allowed: true } },
      { segments: ['records-pack', 'records-catalog', 'records-catalog', 'read'], value: { allowed: true } },
    ])).toBe(true);
    expect(recordsSubscriberGrantSnapshotMatches(snapshot, [
      { segments: ['records-pack', 'records-catalog', 'records-catalog', 'read'], value: { allowed: true } },
    ])).toBe(false);
    expect(recordsSubscriberGrantSnapshotMatches(snapshot, [
      { segments: ['records-pack', 'records-catalog', 'records-catalog', 'read'], value: { allowed: true } },
      { segments: ['records-pack', 'records-catalog', 'records-catalog', 'write'], value: { allowed: true } },
      { segments: ['records-pack', 'records-catalog', 'records-catalog', 'admin'], value: { allowed: true } },
    ])).toBe(false);

    expect(() => deriveRecordsSubscriberBindings(OWNER, [{
      recipe: { ...watcher, variables: { destination: 'mutable' } },
      publisher_id: OWNER.publisher,
    }], snapshot)).toThrow(/mutable dish\/install config/);
  });

  it('does not start the drain grant-blind, because a refused admission destroys the event', () => {
    // `admit` returns false without a grant store, and a refused admission
    // dead-letters on the FIRST attempt. Grant-blind, that empties the whole
    // queue on tick one — so the composition declines to run instead.
    const registered: string[] = [];
    const services = {
      registerInterval: (entry: { name: string }) => { registered.push(entry.name); },
    } as unknown as Parameters<typeof composeRecordsOutbox>[0]['backgroundServices'];
    const base = {
      recordsStore: store,
      recipeStore: { getStored: () => null, get: () => null } as never,
      executeDeps: {} as never,
      backgroundServices: services,
    };

    composeRecordsOutbox(base);
    expect(registered).toEqual([]);

    // The permitting case: with a grant store it DOES arm, so the guard above
    // is about the missing store and not a disabled drain.
    composeRecordsOutbox({ ...base, contractStore: { scan: () => [] } as never });
    expect(registered).toEqual(['records-outbox']);
  });
});
