/** D-145 § A.7.8 (Amended 2026-05-26) — end-to-end producer integration.
 *
 *  Validates the pilot end-to-end:
 *    - Producer reads `stall_window_days` from `ctx.tunableParams`.
 *    - Tuning the value changes the `stalled` boolean for the same
 *      source data.
 *    - `resolveProjectStallSignalProducerVersionHash(ctx)` flips when
 *      the user tunes; same shape across reads with no override.
 *    - Producer output carries the resolved hash so persisted rows
 *      match the next cycle's skip check.
 *    - Backward compat: a producer with no `tunableParams` accessor on
 *      ctx falls back to the declaration default (14d) — existing
 *      tests assert this implicitly via the un-tuned 64-case suite.
 *
 *  The integration here is harness-free — we call `produce()` directly
 *  with a stubbed context that wires the real `TunableParamsAccessor`
 *  against an in-memory SQLite db. The harness-level skip rule lives
 *  in a separate fixture (d-145-phase-9-tunable-params-harness-skip)
 *  if/when one lands; the pilot scope is the producer-side wiring. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Project, ProjectStallSignalValue } from '@recued/contracts';

import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import {
  PROJECT_STALL_SIGNAL_DEFAULT_WINDOW_DAYS,
  createTunableParamsAccessor,
  createTunableParamsStore,
  projectStallSignalProducer,
  resolveProjectStallSignalProducerVersionHash,
} from '../housekeeping/index.js';
import {
  COMMITMENT_TABLE,
  NOTE_TABLE,
  TASK_TABLE,
} from '../storage/work-entity-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';

// ────────────────────────────────────────────────────────────────
// Fixture infra
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const ONE_DAY = 86_400_000;
const TOPIC = 'project_stall_signal';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-tunable-integration-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  ensureHousekeepingSchema(db);
  // Minimal work-entity schemas — the producer reads these directly.
  db.exec(`
    CREATE TABLE ${TASK_TABLE} (
      id                 TEXT PRIMARY KEY,
      parent_project_id  TEXT,
      updated_at         INTEGER NOT NULL,
      sync_state         TEXT NOT NULL DEFAULT 'live',
      deleted_at         INTEGER
    );
    CREATE TABLE ${COMMITMENT_TABLE} (
      id                  TEXT PRIMARY KEY,
      blocks_project_ids  TEXT NOT NULL DEFAULT '[]',
      state_changed_at    INTEGER NOT NULL,
      sync_state          TEXT NOT NULL DEFAULT 'live',
      deleted_at          INTEGER
    );
    CREATE TABLE ${NOTE_TABLE} (
      id                   TEXT PRIMARY KEY,
      related_project_ids  TEXT NOT NULL DEFAULT '[]',
      last_user_action_at  INTEGER NOT NULL,
      sync_state           TEXT NOT NULL DEFAULT 'live',
      deleted_at           INTEGER
    );
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const buildCtx = (
  overrides: { tunableParamsAccessor?: ReturnType<typeof createTunableParamsAccessor> } = {},
): HousekeepingContext => {
  const accessor = overrides.tunableParamsAccessor;
  return {
    db,
    bus: {
      emit: () => undefined,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    } as never,
    enrichmentStore: {} as never,
    recipeStore: {} as never,
    now: () => NOW,
    emitAuditRow: () => undefined,
    ...(accessor !== undefined ? { tunableParams: accessor } : {}),
  };
};

const fakeProject = (overrides: Partial<Project> & { id: string }): Project => ({
  id: overrides.id,
  title: overrides.title ?? `Project ${overrides.id}`,
  state: overrides.state ?? 'active',
  created_at: overrides.created_at ?? NOW - 30 * ONE_DAY,
  updated_at: overrides.updated_at ?? NOW - ONE_DAY,
  last_activity_at: overrides.last_activity_at ?? NOW - ONE_DAY,
  related_contact_ids: overrides.related_contact_ids ?? [],
  source_id: overrides.source_id ?? 'src_recued',
  source_record_id: overrides.source_record_id ?? overrides.id,
  source_updated_at: overrides.source_updated_at ?? NOW - ONE_DAY,
  last_seen_at: overrides.last_seen_at ?? NOW - ONE_DAY,
  sync_state: overrides.sync_state ?? 'live',
  conflict_policy: overrides.conflict_policy ?? 'source_wins',
  source_record_hash: overrides.source_record_hash ?? 'h_proj',
});

const sourceFor = (project: Project): SourceRecord<Project> => ({
  target_id: project.id,
  data: project,
  cursor_token: project.id,
});

const produceFor = async (
  ctx: HousekeepingContext,
  project: Project,
): Promise<ProjectStallSignalValue> => {
  const out = await projectStallSignalProducer.produce(ctx, sourceFor(project));
  if (!out) throw new Error(`expected output for ${project.id}`);
  return out.value as ProjectStallSignalValue;
};

// ────────────────────────────────────────────────────────────────
// User tunes stall window → stalled boolean changes
// ────────────────────────────────────────────────────────────────

describe('project_stall_signal — user-tunable stall_window_days end-to-end', () => {
  it('falls back to declaration default (14d) when ctx.tunableParams unwired', async () => {
    const ctx = buildCtx();
    // Project activity at 30d ago → stalled at default 14d window.
    const project = fakeProject({
      id: 'proj_a',
      last_activity_at: NOW - 30 * ONE_DAY,
    });
    const v = await produceFor(ctx, project);
    expect(v.stalled).toBe(true);
  });

  it('uses declaration default (14d) when accessor wired but no override row', async () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    const ctx = buildCtx({ tunableParamsAccessor: accessor });
    const project = fakeProject({
      id: 'proj_a',
      last_activity_at: NOW - 30 * ONE_DAY,
    });
    const v = await produceFor(ctx, project);
    expect(v.stalled).toBe(true);
  });

  it('flips stalled to false when user tunes window to 90 days for a 30d-old project', async () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    const ctx = buildCtx({ tunableParamsAccessor: accessor });

    const project = fakeProject({
      id: 'proj_a',
      last_activity_at: NOW - 30 * ONE_DAY,
    });

    // Baseline at default 14d → stalled.
    expect((await produceFor(ctx, project)).stalled).toBe(true);

    // User tunes to 90d → no longer stalled.
    store.writeParam(TOPIC, 'stall_window_days', 90, NOW);
    expect((await produceFor(ctx, project)).stalled).toBe(false);
  });

  it('flips stalled to true when user tunes window to 7 days for a 10d-old project', async () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    const ctx = buildCtx({ tunableParamsAccessor: accessor });

    const project = fakeProject({
      id: 'proj_a',
      last_activity_at: NOW - 10 * ONE_DAY,
    });

    // Baseline at default 14d → not stalled (10d < 14d).
    expect((await produceFor(ctx, project)).stalled).toBe(false);

    // SaaS user tunes to 7d → stalled (10d > 7d).
    store.writeParam(TOPIC, 'stall_window_days', 7, NOW);
    expect((await produceFor(ctx, project)).stalled).toBe(true);
  });

  it('reverts to default after resetParam', async () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    const ctx = buildCtx({ tunableParamsAccessor: accessor });

    const project = fakeProject({
      id: 'proj_a',
      last_activity_at: NOW - 30 * ONE_DAY,
    });

    store.writeParam(TOPIC, 'stall_window_days', 90, NOW);
    expect((await produceFor(ctx, project)).stalled).toBe(false);

    store.resetParam(TOPIC, 'stall_window_days');
    expect((await produceFor(ctx, project)).stalled).toBe(true);
  });

  it('honors industry-cadence tuning (365d for construction)', async () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    const ctx = buildCtx({ tunableParamsAccessor: accessor });

    const project = fakeProject({
      id: 'proj_a',
      last_activity_at: NOW - 180 * ONE_DAY,
    });

    // Default 14d → stalled. Construction tune 365d → not stalled.
    expect((await produceFor(ctx, project)).stalled).toBe(true);
    store.writeParam(TOPIC, 'stall_window_days', 365, NOW);
    expect((await produceFor(ctx, project)).stalled).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// resolveProducerVersionHash — invalidation primitive
// ────────────────────────────────────────────────────────────────

describe('resolveProjectStallSignalProducerVersionHash', () => {
  it('returns the canonical fnv1a:<8-hex> shape', () => {
    const ctx = buildCtx();
    expect(resolveProjectStallSignalProducerVersionHash(ctx)).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('is stable across calls with no override', () => {
    const ctx = buildCtx();
    const a = resolveProjectStallSignalProducerVersionHash(ctx);
    const b = resolveProjectStallSignalProducerVersionHash(ctx);
    expect(a).toBe(b);
  });

  it('matches between accessor-wired-no-override and accessor-unwired (both compute from default)', () => {
    const store = createTunableParamsStore(db);
    const wired = buildCtx({ tunableParamsAccessor: createTunableParamsAccessor(store) });
    const unwired = buildCtx();
    expect(resolveProjectStallSignalProducerVersionHash(wired)).toBe(
      resolveProjectStallSignalProducerVersionHash(unwired),
    );
  });

  it('flips when the user tunes stall_window_days', () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    const ctx = buildCtx({ tunableParamsAccessor: accessor });

    const baseline = resolveProjectStallSignalProducerVersionHash(ctx);
    store.writeParam(TOPIC, 'stall_window_days', 90, NOW);
    const tuned = resolveProjectStallSignalProducerVersionHash(ctx);
    expect(tuned).not.toBe(baseline);
  });

  it('returns to baseline after the override is reset', () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    const ctx = buildCtx({ tunableParamsAccessor: accessor });

    const baseline = resolveProjectStallSignalProducerVersionHash(ctx);
    store.writeParam(TOPIC, 'stall_window_days', 90, NOW);
    expect(resolveProjectStallSignalProducerVersionHash(ctx)).not.toBe(baseline);
    store.resetParam(TOPIC, 'stall_window_days');
    expect(resolveProjectStallSignalProducerVersionHash(ctx)).toBe(baseline);
  });

  it('default constant matches the declaration default of 14 days', () => {
    expect(PROJECT_STALL_SIGNAL_DEFAULT_WINDOW_DAYS).toBe(14);
  });
});

// ────────────────────────────────────────────────────────────────
// producer.produce() output threads the resolved hash
// ────────────────────────────────────────────────────────────────

describe('producer output carries the resolved producer_version_hash', () => {
  it('default state — output hash matches resolveProducerVersionHash on the same ctx', async () => {
    const ctx = buildCtx();
    const project = fakeProject({ id: 'proj_a' });
    const out = await projectStallSignalProducer.produce(ctx, sourceFor(project));
    expect(out?.producer_version_hash).toBe(
      resolveProjectStallSignalProducerVersionHash(ctx),
    );
  });

  it('tuned state — output hash matches the tuned-ctx resolution', async () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    const ctx = buildCtx({ tunableParamsAccessor: accessor });

    store.writeParam(TOPIC, 'stall_window_days', 60, NOW);
    const project = fakeProject({ id: 'proj_a' });
    const out = await projectStallSignalProducer.produce(ctx, sourceFor(project));
    expect(out?.producer_version_hash).toBe(
      resolveProjectStallSignalProducerVersionHash(ctx),
    );
  });

  it('tuned vs default output hashes differ for the same project', async () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    const ctxDefault = buildCtx({ tunableParamsAccessor: accessor });

    const project = fakeProject({ id: 'proj_a' });
    const baseOut = await projectStallSignalProducer.produce(ctxDefault, sourceFor(project));
    store.writeParam(TOPIC, 'stall_window_days', 60, NOW);
    const tunedOut = await projectStallSignalProducer.produce(ctxDefault, sourceFor(project));
    expect(tunedOut?.producer_version_hash).not.toBe(baseOut?.producer_version_hash);
  });
});

// ────────────────────────────────────────────────────────────────
// Producer surface: callable producer_version_hash slot
// ────────────────────────────────────────────────────────────────

describe('producer surface — callable producer_version_hash', () => {
  it('producer.producer_version_hash is a function (D-145 § A.7.8 widening)', () => {
    expect(typeof projectStallSignalProducer.producer_version_hash).toBe('function');
  });

  it('invoking the function with a ctx returns a stable fnv1a hash', () => {
    const fn = projectStallSignalProducer.producer_version_hash;
    expect(typeof fn).toBe('function');
    if (typeof fn === 'function') {
      const ctx = buildCtx();
      expect(fn(ctx)).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    }
  });
});
