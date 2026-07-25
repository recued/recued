/** D-123 Phase 6 — Cascade-engine invalidation hook tests.
 *
 *  Two layers:
 *
 *    1. `createHousekeepingInvalidator` — walks the registered task
 *       list, calls `task.onInvalidate?(ctx, hint)` per task that
 *       opts in, and flips matching state rows from `'complete'` →
 *       `'pending'` so the next idle cycle re-steps them.
 *
 *    2. End-to-end via `createEnrichmentCascade(store, notifier)` —
 *       cascade events propagate through to the housekeeping state
 *       store with the right hint shape per cascade reason.
 *
 *  Spec: `docs/d-123-spec.md` §6. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HousekeepingCursor } from '@recued/contracts';

import {
  createHousekeepingInvalidator,
} from '../housekeeping/invalidation.js';
import {
  createHousekeepingRegistry,
  type HousekeepingContext,
  type HousekeepingInvalidateHint,
  type HousekeepingTaskInstance,
} from '../housekeeping/registry.js';
import {
  createHousekeepingStateStore,
  type HousekeepingStateStore,
} from '../housekeeping/state-store.js';
import {
  createEnrichmentCascade,
  type CascadeInvalidationHint,
} from '../storage/enrichment-cascade.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';

let dir: string;
let db: Database.Database;
let state: HousekeepingStateStore;
let store: EnrichmentStore;

const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-p6-invalidation-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  state = createHousekeepingStateStore(db);
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const stubCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => NOW,
  emitAuditRow: () => undefined,
});

const stubTask = (
  id: string,
  opts: { onInvalidate?: HousekeepingTaskInstance['onInvalidate'] } = {},
): HousekeepingTaskInstance => ({
  meta: { id, description: id, interruptible: true, kind: 'core' },
  step: async (_ctx, _cursor: HousekeepingCursor) => ({
    status: 'complete',
    cursor: { kind: 'complete' },
  }),
  ...(opts.onInvalidate ? { onInvalidate: opts.onInvalidate } : {}),
});

const seedComplete = (task_id: string): void => {
  state.set({
    task_id,
    cursor: { kind: 'complete' },
    last_status: 'complete',
    last_run_at: NOW,
  });
};

describe('createHousekeepingInvalidator — registry walk', () => {
  it('calls onInvalidate on every opted-in task with the hint', () => {
    const registry = createHousekeepingRegistry();
    const spyA = vi.fn();
    const spyB = vi.fn();
    registry.register(stubTask('alpha', { onInvalidate: spyA }));
    registry.register(stubTask('beta', { onInvalidate: spyB }));

    const notify = createHousekeepingInvalidator({
      registry: () => registry.list(),
      state,
      context: stubCtx,
    });
    const hint: HousekeepingInvalidateHint = {
      reason: 'source_update',
      scope: 'mail',
      source_id: 'msg-1',
    };
    notify(hint);

    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyA).toHaveBeenCalledWith(expect.any(Object), hint);
    expect(spyB).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledWith(expect.any(Object), hint);
  });

  it('skips tasks without onInvalidate (audit-compaction shape)', () => {
    const registry = createHousekeepingRegistry();
    const optedInSpy = vi.fn();
    registry.register(stubTask('audit-compaction')); // no onInvalidate
    registry.register(stubTask('opted-in', { onInvalidate: optedInSpy }));
    seedComplete('audit-compaction');
    seedComplete('opted-in');

    const notify = createHousekeepingInvalidator({
      registry: () => registry.list(),
      state,
      context: stubCtx,
    });
    notify({ reason: 'source_update' });

    // Opt-in task fired + flipped; non-opt-in task untouched.
    expect(optedInSpy).toHaveBeenCalledTimes(1);
    expect(state.get('audit-compaction')?.last_status).toBe('complete');
    expect(state.get('opted-in')?.last_status).toBe('pending');
  });

  it("flips opted-in task's last_status from 'complete' → 'pending'", () => {
    const registry = createHousekeepingRegistry();
    registry.register(stubTask('producer', { onInvalidate: () => {} }));
    seedComplete('producer');

    const notify = createHousekeepingInvalidator({
      registry: () => registry.list(),
      state,
      context: stubCtx,
    });
    notify({ reason: 'source_update', scope: 'mail' });

    expect(state.get('producer')?.last_status).toBe('pending');
  });

  it("leaves 'error' / 'in_progress' / unseen state untouched", () => {
    const registry = createHousekeepingRegistry();
    registry.register(stubTask('errored', { onInvalidate: () => {} }));
    registry.register(stubTask('running', { onInvalidate: () => {} }));
    registry.register(stubTask('unseen', { onInvalidate: () => {} })); // no row

    state.set({
      task_id: 'errored',
      cursor: { kind: 'complete' },
      last_status: 'error',
      consecutive_errors: 3,
      last_error: 'boom',
    });
    state.set({
      task_id: 'running',
      cursor: { kind: 'complete' },
      last_status: 'in_progress',
    });

    const notify = createHousekeepingInvalidator({
      registry: () => registry.list(),
      state,
      context: stubCtx,
    });
    notify({ reason: 'source_update' });

    expect(state.get('errored')?.last_status).toBe('error');
    expect(state.get('running')?.last_status).toBe('in_progress');
    expect(state.get('unseen')).toBeNull();
  });

  it('swallows exceptions from a task onInvalidate and continues to subsequent tasks', () => {
    const registry = createHousekeepingRegistry();
    const goodSpy = vi.fn();
    registry.register(
      stubTask('boom', {
        onInvalidate: () => {
          throw new Error('downstream failure');
        },
      }),
    );
    registry.register(stubTask('good', { onInvalidate: goodSpy }));
    seedComplete('boom');
    seedComplete('good');

    const notify = createHousekeepingInvalidator({
      registry: () => registry.list(),
      state,
      context: stubCtx,
    });
    expect(() => notify({ reason: 'source_update' })).not.toThrow();
    // Both tasks still flipped; later task's spy still ran.
    expect(goodSpy).toHaveBeenCalledTimes(1);
    expect(state.get('boom')?.last_status).toBe('pending');
    expect(state.get('good')?.last_status).toBe('pending');
  });
});

describe('createEnrichmentCascade — invalidator wiring', () => {
  it('cascadeForSourceUpdate fires the notifier with reason source_update', () => {
    const hints: CascadeInvalidationHint[] = [];
    const cascade = createEnrichmentCascade(store, (h) => hints.push(h));
    cascade.cascadeForSourceUpdate('mail', 'msg-1');
    expect(hints).toEqual([
      { scope: 'mail', source_id: 'msg-1', reason: 'source_update' },
    ]);
  });

  it('cascadeForSourceDelete fires the notifier with reason source_delete', () => {
    const hints: CascadeInvalidationHint[] = [];
    const cascade = createEnrichmentCascade(store, (h) => hints.push(h));
    cascade.cascadeForSourceDelete('contact', 'bob@x.com');
    expect(hints).toEqual([
      { scope: 'contact', source_id: 'bob@x.com', reason: 'source_delete' },
    ]);
  });

  it('cascadeForRecipeUpgrade fires the notifier with source_id=recipe_id', () => {
    const hints: CascadeInvalidationHint[] = [];
    const cascade = createEnrichmentCascade(store, (h) => hints.push(h));
    cascade.cascadeForRecipeUpgrade('recued-core/refresh-foo');
    expect(hints).toEqual([
      { source_id: 'recued-core/refresh-foo', reason: 'recipe_upgrade' },
    ]);
  });

  it('end-to-end: cascadeForSourceUpdate flips opted-in task last_status complete → pending', () => {
    const registry = createHousekeepingRegistry();
    const onInvalidateSpy = vi.fn();
    registry.register(
      stubTask('producer', { onInvalidate: onInvalidateSpy }),
    );
    seedComplete('producer');

    const notify = createHousekeepingInvalidator({
      registry: () => registry.list(),
      state,
      context: stubCtx,
    });
    const cascade = createEnrichmentCascade(store, notify);

    cascade.cascadeForSourceUpdate('mail', 'msg-99');

    expect(onInvalidateSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        reason: 'source_update',
        scope: 'mail',
        source_id: 'msg-99',
      }),
    );
    expect(state.get('producer')?.last_status).toBe('pending');
  });

  it('end-to-end: cascade exceptions in notifier do not abort the cascade caller', () => {
    const cascade = createEnrichmentCascade(store, () => {
      throw new Error('notifier blew up');
    });
    expect(() => cascade.cascadeForRecipeUpgrade('recipe.x')).not.toThrow();
  });
});
