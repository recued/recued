/** D-145 PA4 — Housekeeping task wrapper tests.
 *
 *  Verifies the `work-entity-due-status-sweep` `kind: 'core'` task
 *  shape — meta fields, step return shape, and the round-trip
 *  through a fresh-housekeeping-context (the registry singleton is
 *  not engaged here; the test calls `step()` directly with a
 *  minimal `HousekeepingContext`). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RECUED_BUILTIN_SOURCE_ID,
  WORK_ENTITY_DUE_SOON_WINDOW_MS,
  WORK_ENTITY_KINDS,
} from '@recued/contracts';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
  type WarehouseEventBus,
} from '@recued/warehouse-events';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { buildWorkEntityDueStatusSweepTask } from '../housekeeping/tasks/work-entity-due-status-sweep.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let bus: WarehouseEventBus;
let events: WarehouseEvent[];

const NOW = 1_700_000_000_000;

const registerBuiltins = (s: WorkEntityStore): void => {
  for (const kind of WORK_ENTITY_KINDS) {
    s.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID(kind),
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: 'Recued built-in',
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
  }
};

const buildContext = (): HousekeepingContext => ({
  db,
  bus,
  enrichmentStore: {} as unknown as HousekeepingContext['enrichmentStore'],
  recipeStore: {} as unknown as HousekeepingContext['recipeStore'],
  now: () => NOW,
  emitAuditRow: () => {},
} as unknown as HousekeepingContext);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd145-pa4-housekeeping-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  registerBuiltins(store);
  bus = createWarehouseEventBus();
  events = [];
  bus.subscribe('**', (ev) => {
    events.push(ev);
  });
});

afterEach(() => {
  bus.dispose();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('buildWorkEntityDueStatusSweepTask — meta', () => {
  const task = buildWorkEntityDueStatusSweepTask({
    deps: { store: {} as unknown as WorkEntityStore },
  });

  it('declares the canonical task id', () => {
    expect(task.meta.id).toBe('work-entity-due-status-sweep');
  });

  it('declares kind: core', () => {
    expect(task.meta.kind).toBe('core');
  });

  it('declares interruptible: true', () => {
    expect(task.meta.interruptible).toBe(true);
  });

  it('carries domain:work + surface:deterministic + kind:core tags', () => {
    expect(task.meta.tags).toContain('kind:core');
    expect(task.meta.tags).toContain('domain:work');
    expect(task.meta.tags).toContain('surface:deterministic');
  });

  it('declares no topic (core task — no enrichment topic)', () => {
    expect(task.topic).toBeUndefined();
  });

  it('declares no is_ai_surface flag (core task — trust gate is no-op)', () => {
    expect(task.is_ai_surface).toBeUndefined();
  });

  it('does NOT declare onInvalidate (deadline crossings are time-driven)', () => {
    expect(task.onInvalidate).toBeUndefined();
  });
});

describe('buildWorkEntityDueStatusSweepTask — step()', () => {
  it('returns status: complete with cursor: complete', async () => {
    const task = buildWorkEntityDueStatusSweepTask({ deps: { store, bus } });
    const result = await task.step(buildContext(), { kind: 'complete' }, 1_000);
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'complete' });
  });

  it('runs the sweep (visible by emitted events on a pending overdue commitment)', async () => {
    store.writeCommitment(
      {
        direction: 'inbound',
        statement: 'Bob to deliver',
        derivation: 'user_declared',
        source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
        promised_for_at: NOW - 1000,
      },
      NOW - 100_000,
    );
    const task = buildWorkEntityDueStatusSweepTask({ deps: { store, bus } });
    await task.step(buildContext(), { kind: 'complete' }, 1_000);
    const fired = events.filter(
      (e) => e.event_kind === 'overdue' && e.platform === 'work' && e.slug === 'commitment',
    );
    expect(fired).toHaveLength(1);
  });

  it('honors ctx.now over deps.now', async () => {
    // Set a far-future ctx.now so the sweep sees the deadline as past.
    const customNow = NOW + 30 * 24 * WORK_ENTITY_DUE_SOON_WINDOW_MS;
    store.writeCommitment(
      {
        direction: 'inbound',
        statement: 'late delivery',
        derivation: 'user_declared',
        source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
        promised_for_at: NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS,
      },
      NOW - 1000,
    );
    const task = buildWorkEntityDueStatusSweepTask({
      // deps.now would say "not_due"; ctx.now says "overdue".
      deps: { store, bus, now: () => NOW },
    });
    const ctx = { ...buildContext(), now: () => customNow };
    await task.step(ctx, { kind: 'complete' }, 1_000);
    const fired = events.filter(
      (e) => e.event_kind === 'overdue' && e.platform === 'work' && e.slug === 'commitment',
    );
    expect(fired).toHaveLength(1);
  });
});
