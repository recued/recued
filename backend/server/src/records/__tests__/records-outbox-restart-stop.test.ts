/** Records outbox — what a restart drain needs from the watcher drain.
 *
 *  A pass runs watcher recipes one after another (up to a hundred) off a 1 s
 *  timer that used to be stopped only late in the restart, by a stop that
 *  waited for the whole pass — while new passes kept starting runs the draining
 *  server refused, each refusal counting toward the delivery's retry cap. These
 *  pin that no pass starts while the server is stopping, that `stop()` returns
 *  within `STOP_GRACE_MS` while a watcher run never finishes, and that a pass a
 *  stop cuts short leaves every delivery it did not reach pending — never
 *  dead-lettered — for the next boot.
 *
 *  Only the recipe run is replaced (`handleExecute`); the store, the runner and
 *  the admission checks are the real ones, so `admit` genuinely passes. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalHash, recordsCatalogSlug } from '@recued/ingredient-authoring';
import { RpcError, type RecipeDefinition, type RecordsExecutionBinding, type RecordsSchemaSnapshot } from '@recued/contracts';

import { composeRecordsOutbox } from '../../composition/bin/wire-records-outbox.js';
import type { BackgroundServiceRegistry } from '../../composition/bin/wire-background-services.js';
import { deriveRecordsSubscriberBindings } from '../subscribers.js';
import { createRecordsStore, type RecordsStore } from '../store.js';
import { STOP_GRACE_MS } from '../../lifecycle/settle-within.js';

const run = vi.hoisted(() => ({
  impl: async (..._args: unknown[]): Promise<unknown> => ({ success: true, errors: [] }),
  calls: 0,
}));
vi.mock('../../execute-handler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../execute-handler.js')>()),
  handleExecute: (...args: unknown[]) => {
    run.calls += 1;
    return run.impl(...args);
  },
}));

const OWNER = { publisher: 'publisher-a', pack_slug: 'watch-pack' } as const;
const STORAGE = 'a'.repeat(64);
const DECLARATION = 'b'.repeat(64);
const GRANT = {
  installed_pack_id: 'records-pack',
  ingredient_id: 'records-catalog',
  connection_name: 'records-catalog',
  group_ids: ['read'],
};
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

const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

describe('records outbox during a restart drain', () => {
  let db: Database.Database;
  let store: RecordsStore;
  let stops: Array<() => Promise<void> | void>;

  beforeEach(async () => {
    run.impl = async () => ({ success: true, errors: [] });
    run.calls = 0;
    stops = [];
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    store = createRecordsStore(db, { now: (() => { let time = 1_000; return () => time++; })() });
    const subscribers = deriveRecordsSubscriberBindings(OWNER, [{
      recipe: watcher,
      publisher_id: OWNER.publisher,
      recipe_digest: await canonicalHash(watcher),
    }], GRANT);
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

  afterEach(async () => {
    await Promise.all(stops.map((stop) => stop()));
    db.close();
  });

  const compose = async (extra: { isStopping?: () => boolean; isDraining?: () => boolean } = {}) => {
    const packSlug = await recordsCatalogSlug(OWNER);
    composeRecordsOutbox({
      recordsStore: store,
      recipeStore: {
        getStored: () => ({
          recipe_id: watcher.recipe_id,
          publisher_id: OWNER.publisher,
          recipe_json: JSON.stringify(watcher),
          pack_slug: packSlug,
        }),
        get: () => watcher,
      } as never,
      contractStore: {
        scan: () => [{
          segments: [GRANT.installed_pack_id, GRANT.ingredient_id, GRANT.connection_name, 'read'],
          value: { allowed: true },
        }],
      } as never,
      executeDeps: { ...(extra.isDraining ? { isDraining: extra.isDraining } : {}) } as never,
      backgroundServices: {
        register: (entry: { stop: () => Promise<void> | void }) => { stops.push(entry.stop); },
      } as unknown as BackgroundServiceRegistry,
      intervalMs: 60_000,
      ...(extra.isStopping ? { isStopping: extra.isStopping } : {}),
    });
  };

  const job = (id: string): void => {
    store.execute({ binding: create, args: { id, values: { title: id } }, principal: 'owner' });
  };

  it('starts no pass while the server is stopping: every delivery stays pending', async () => {
    job('a');
    // No pass at all — not one that `admit` then ends: a pass's first read
    // already finishes events and dead-letters bindings that are not current.
    const listed = vi.spyOn(store, 'listPendingDeliveries');
    await compose({ isStopping: () => true });
    await flush();
    await flush();
    expect(listed).not.toHaveBeenCalled();
    listed.mockRestore();
    expect(run.calls).toBe(0);
    expect(store.listOutbox(OWNER, 'pending')).toHaveLength(1);
    expect(store.listPendingDeliveries()[0]!.retry_count).toBe(0);
  });

  it('reads the execute path\'s drain signal when nothing else is wired', async () => {
    job('a');
    let isDraining = true;
    await compose({ isDraining: () => isDraining });
    await flush();
    await flush();
    expect(run.calls).toBe(0);
    expect(store.listOutbox(OWNER, 'pending')).toHaveLength(1);

    // The permitting case: the same drain delivers once not draining, so the
    // hold above was the drain and not an admission that never passes.
    isDraining = false;
    const second = stops.length;
    await compose({ isDraining: () => isDraining });
    await vi.waitFor(() => expect(store.listOutbox(OWNER, 'delivered')).toHaveLength(1));
    expect(run.calls).toBe(1);
    expect(stops).toHaveLength(second + 1);
  });

  it('stop() returns within the grace while a watcher run never finishes; the rest stay pending', async () => {
    job('a');
    job('b');
    let release!: () => void;
    const hung = new Promise<void>((resolve) => { release = resolve; });
    run.impl = async () => {
      await hung;
      return { success: true, errors: [] };
    };
    await compose();
    await vi.waitFor(() => expect(run.calls).toBe(1));

    const started = Date.now();
    await stops[0]!();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(STOP_GRACE_MS - 50);
    expect(elapsed).toBeLessThan(STOP_GRACE_MS + 500);

    // The hung run ends after the stop: its delivery is booked, and the pass
    // reaches no further one — that stays pending for the next boot.
    release();
    await vi.waitFor(() => expect(store.listOutbox(OWNER, 'delivered')).toHaveLength(1));
    await flush();
    expect(run.calls).toBe(1);
    expect(store.listOutbox(OWNER, 'pending')).toHaveLength(1);
    expect(store.listOutbox(OWNER, 'dead_letter')).toHaveLength(0);
    expect(store.listPendingDeliveries()[0]!.retry_count).toBe(0);
  });

  // `admit` reads the drain signal an instant before the run: a drain that
  // begins between the two used to count a retry, so ten restarts at the wrong
  // moment dead-lettered the event.
  it('a watcher run the draining server refused leaves its delivery pending, with no retry counted', async () => {
    job('a');
    run.impl = async () => {
      throw new RpcError('draining', 'The server is restarting; try again in a moment.', 503);
    };
    await compose();
    await vi.waitFor(() => expect(run.calls).toBe(1));
    await flush();
    expect(store.listOutbox(OWNER, 'pending')).toHaveLength(1);
    expect(store.listOutbox(OWNER, 'dead_letter')).toHaveLength(0);
    expect(store.listPendingDeliveries()[0]!.retry_count).toBe(0);
  });

  it('a watcher run the restart stopped leaves its delivery pending, with no retry counted', async () => {
    job('a');
    let draining = false;
    run.impl = async () => {
      // The drain begins while the run is going, and kills it.
      draining = true;
      return { success: false, run_terminated: 'killed', errors: [{ code: 'run_killed', message: 'The run was stopped.' }] };
    };
    await compose({ isDraining: () => draining });
    await vi.waitFor(() => expect(run.calls).toBe(1));
    await flush();
    expect(store.listOutbox(OWNER, 'pending')).toHaveLength(1);
    expect(store.listPendingDeliveries()[0]!.retry_count).toBe(0);
  });

  it('an owner\'s kill outside a restart still counts as a failed delivery', async () => {
    job('a');
    run.impl = async () => ({ success: false, run_terminated: 'killed', errors: [{ code: 'run_killed', message: 'The run was stopped.' }] });
    await compose({ isDraining: () => false });
    await vi.waitFor(() => expect(store.listPendingDeliveries()[0]?.retry_count).toBe(1));
  });
});
