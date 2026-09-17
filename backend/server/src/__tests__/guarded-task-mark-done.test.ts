/** The task-completion guard — the one the rpc had and the other two surfaces
 *  did not.
 *
 *  ⛔ THREE SURFACES COMPLETE A TASK: the webclient's Today toggle (rpc →
 *  `handleWorkEntityTaskMarkDone`), the chat Tier-1 `work.update` tool, and the
 *  kernel `task-mark-done` ingredient — the path EVERY recipe takes. When the
 *  mark-done rpc shipped it brought a per-task lock and a completion-time
 *  idempotence check with it; the other two predate that handler and kept
 *  holding `dispatchers.taskMarkDone` raw. Nothing went red, because an
 *  unguarded caller needs no deps it does not already have.
 *
 *  🔑 THE ASSERTIONS BELOW ARE PAIRED — raw vs guarded on the SAME store. A test
 *  that only exercised the guarded path would pass just as well if the guard
 *  were a no-op, so each guarantee first shows the raw dispatcher failing it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RECUED_BUILTIN_SOURCE_ID } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import {
  guardTaskMarkDone,
  handleWorkEntityTaskMarkDone,
  withGuardedTaskMarkDone,
} from '../work-entity-crud-handler.js';

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let clock: number;
let deps: Parameters<typeof guardTaskMarkDone>[0];
let crud: Parameters<typeof handleWorkEntityTaskMarkDone>[0];

const TASK_SOURCE = RECUED_BUILTIN_SOURCE_ID('task');

beforeEach(() => {
  clock = NOW;
  dir = mkdtempSync(join(tmpdir(), 'guarded-mark-done-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  store.registerSource({
    id: TASK_SOURCE,
    top_tier_kind: 'task',
    source_kind: 'builtin',
    source_label: 'Recued built-in',
    write_capable: true,
    registered_at: NOW,
  });
  const resolver = createWorkEntityResolver(store);
  const dispatchers = createWorkEntityDispatchers({
    store,
    resolver,
    bus: createWarehouseEventBus(),
    now: () => clock,
  });
  deps = { store, dispatchers };
  crud = { store, resolver, dispatchers };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const seedOpenTask = (id: string): void => {
  store.writeTask({ id, title: 'x', source_id: TASK_SOURCE }, NOW);
};

describe('a repeat completion must not move the completion time', () => {
  it('the RAW dispatcher re-stamps `completed_at` — the defect', async () => {
    seedOpenTask('raw');
    const first = await deps.dispatchers.taskMarkDone({ id: 'raw' });
    clock = NOW + 60_000;
    const second = await deps.dispatchers.taskMarkDone({ id: 'raw' });
    expect(first.task.completed_at).toBe(NOW);
    // The owner said "done" twice and the task's completion moved an hour.
    expect(second.task.completed_at).toBe(NOW + 60_000);
  });

  it('the GUARD keeps the original time and skips the write entirely', async () => {
    seedOpenTask('guarded');
    const first = await guardTaskMarkDone(deps, { id: 'guarded' });
    clock = NOW + 60_000;
    const second = await guardTaskMarkDone(deps, { id: 'guarded' });
    expect(first.task.completed_at).toBe(NOW);
    expect(second.task.completed_at).toBe(NOW);
    expect(store.readTask('guarded')?.completed_at).toBe(NOW);
  });

  it('still re-dispatches when the state actually changes', async () => {
    // The skip is state-based, not a blanket "already called once" cache — a
    // reopen after a completion is a real transition and must reach the write.
    seedOpenTask('flip');
    await guardTaskMarkDone(deps, { id: 'flip' });
    const reopened = await guardTaskMarkDone(deps, { id: 'flip', done: false });
    expect(reopened.task.done).toBe(false);
    expect(store.readTask('flip')?.done).toBe(false);
  });
});

describe('the shipped `task-mark-done` ingredient contract still holds', () => {
  // ⛔ WHY THE GUARD IS NOT `handleWorkEntityTaskMarkDone`. The rpc door accepts
  // only `{id, done}` with a BOOLEAN done. `kernel-manifests.ts` declares the
  // ingredient wider — "Defaults to done: true with completed_at: now" — and
  // recipes call it with an id alone. Routing recipes at the door would refuse
  // every one of them, so the door's policy stays at the door.
  it('an id alone completes the task, as the manifest documents', async () => {
    seedOpenTask('bare');
    const out = await guardTaskMarkDone(deps, { id: 'bare' });
    expect(out.task.done).toBe(true);
    expect(store.readTask('bare')?.done).toBe(true);
  });

  it('a caller-supplied `completed_at` is honoured', async () => {
    seedOpenTask('stamped');
    const out = await guardTaskMarkDone(deps, { id: 'stamped', completed_at: 42 });
    expect(out.task.completed_at).toBe(42);
  });

  it('and the rpc door still refuses both of those shapes', async () => {
    // The pin that says this change WIDENED nothing: the guard is additive on
    // the two surfaces that lacked it, and the wire contract is untouched.
    seedOpenTask('door');
    await expect(
      handleWorkEntityTaskMarkDone(crud, { id: 'door' } as never),
    ).rejects.toThrow(/provide only id and a boolean done value/);
    await expect(
      handleWorkEntityTaskMarkDone(crud, { id: 'door', done: true, completed_at: 42 } as never),
    ).rejects.toThrow(/provide only id and a boolean done value/);
  });
});

describe('the kernel seam — what every recipe reaches', () => {
  it('`withGuardedTaskMarkDone` swaps in the guard and leaves the rest alone', async () => {
    seedOpenTask('kernel');
    const wrapped = withGuardedTaskMarkDone(deps.dispatchers, store)!;
    // Same object identity for a dispatcher it does not guard — the wrapper is
    // a swap of one slot, not a re-derivation of the set.
    expect(wrapped.taskCreate).toBe(deps.dispatchers.taskCreate);
    expect(wrapped.taskMarkDone).not.toBe(deps.dispatchers.taskMarkDone);

    await wrapped.taskMarkDone({ id: 'kernel' });
    clock = NOW + 60_000;
    await wrapped.taskMarkDone({ id: 'kernel' });
    expect(store.readTask('kernel')?.completed_at).toBe(NOW);
  });

  it('passes the set through untouched when there is no store', () => {
    // The dbless harness wires dispatchers without a store; wrapping must be a
    // no-op there rather than a crash at composition time.
    expect(withGuardedTaskMarkDone(deps.dispatchers, undefined)).toBe(deps.dispatchers);
    expect(withGuardedTaskMarkDone(undefined, store)).toBeUndefined();
  });
});

describe('serialisation across surfaces', () => {
  it('a second completion waits for the first to finish its read/write cycle', async () => {
    // 🔑 THE LOCK IS A WeakMap KEYED ON THE STORE, which is what makes a chat
    // completion serialise against the webclient's toggle. Two calls through
    // ONE store must not interleave, or the later read restores older fields.
    seedOpenTask('race');
    const order: string[] = [];
    let entered = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // ⚠ THE DOUBLE DELIBERATELY DOES NOT WRITE, so the row stays open and BOTH
    // calls are real transitions. A double that left the state unchanged while
    // the calls asked for different states would make the second a legitimate
    // idempotent skip, and the test would pass without the lock existing.
    const slow = vi.fn(async (input: { id: string; done?: boolean }) => {
      const n = ++entered;
      order.push(`enter:${n}`);
      await gate;
      order.push(`exit:${n}`);
      return { task: store.readTask(input.id)! };
    });
    const racing = { store, dispatchers: { ...deps.dispatchers, taskMarkDone: slow } as never };

    const first = guardTaskMarkDone(racing, { id: 'race', done: true });
    const second = guardTaskMarkDone(racing, { id: 'race', done: true });
    await Promise.resolve();
    await Promise.resolve();
    // The second has not entered the dispatcher while the first is in flight.
    expect(order).toEqual(['enter:1']);
    release!();
    await Promise.all([first, second]);
    expect(order).toEqual(['enter:1', 'exit:1', 'enter:2', 'exit:2']);
  });
});

describe('a row that does not live locally', () => {
  it('goes straight to the dispatcher rather than being refused', async () => {
    // A qualified id names a read-through Source: the dispatcher projects the
    // write onto the vendor and there is no local row to lock or compare. This
    // is the documented `work.search` → complete flow, so the guard must not
    // stand in front of it.
    // ⚠ PARAMETERS DECLARED ON PURPOSE. An argless `vi.fn(async () => …)` infers
    // a 0-tuple for `mock.calls`, so `calls[0]![0]` below is a typecheck error
    // that vitest runs green — the shape that has shipped from here before.
    const passthrough = vi.fn(
      async (_input: { id: string; done?: boolean; completed_at?: number }) =>
        ({ task: { id: 'remote' } }) as never,
    );
    const remote = { store, dispatchers: { ...deps.dispatchers, taskMarkDone: passthrough } as never };
    await guardTaskMarkDone(remote, { id: 'asana.acme.task:REMOTE-1', done: true });
    expect(passthrough).toHaveBeenCalledTimes(1);
    expect(passthrough.mock.calls[0]![0]).toMatchObject({ id: 'asana.acme.task:REMOTE-1' });
  });
});
