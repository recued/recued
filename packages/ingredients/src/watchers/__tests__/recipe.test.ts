/** D-115 Phase 6 — recipe-watcher handler tests. Moved from
 *  backend/server/src/watchers/__tests__/ in Phase 6D. */

import { describe, it, expect } from 'vitest';
import type { AuditEntry, AuditLogStore } from '@recued/storage';

import { IngredientError } from '../../types.js';
import { evaluateRecipeWatcher } from '../recipe.js';

const mkEntry = (
  overrides: Partial<AuditEntry> & Pick<AuditEntry, 'run_id' | 'commit_status' | 'finished_at'>,
): AuditEntry => ({
  run_id: overrides.run_id,
  recipe_id: overrides.recipe_id ?? 'target',
  recipe_hash: 'h',
  started_at: overrides.started_at ?? overrides.finished_at - 1000,
  finished_at: overrides.finished_at,
  duration_ms: overrides.duration_ms ?? 1000,
  commit_status: overrides.commit_status,
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: overrides.trigger_source ?? 'manual',
  instance_id: null,
});

/** Minimal AuditLogStore stub — only listByRecipe is called. Other
 *  methods throw so an unintended dependency surfaces loudly. */
const mkAuditLog = (entriesByRecipe: Record<string, AuditEntry[]>): AuditLogStore => {
  const notUsed = (): never => {
    throw new Error('not used in recipe-watcher');
  };
  return {
    append: notUsed,
    listWindow: notUsed,
    listByCommitStatus: notUsed,
    listPendingExchangeRefs: notUsed,
    listInboundContractIds: notUsed,
    listRecent: notUsed,
    listByRecipe: async (recipe_id: string, _limit?: number) =>
      (entriesByRecipe[recipe_id] ?? []).slice().sort((a, b) => b.started_at - a.started_at),
    // D-153 P1.B — recipe-watcher does not consume the three tier-scope
    // lookups; the watcher fires off recipe_id only.
    listByChannelSession: notUsed,
    listByCognitionSession: notUsed,
    listByCorrelation: notUsed,
    listByExchangeRef: () => { throw new Error("unused"); },
    listByPeerContract: () => { throw new Error("unused"); },
    listByDish: () => { throw new Error("unused"); },
    latestByDishes: () => { throw new Error("unused"); },
    get: notUsed,
    clearOlderThan: notUsed,
    clearByRecipe: notUsed,
    exportAll: notUsed,
    size: notUsed,
    clearAll: notUsed,
    logActivity: notUsed,
    listActivities: notUsed,
    exportActivities: notUsed,
    clearOldestActivities: notUsed,
    clearOldestEntries: notUsed,
    countReserveEntries: notUsed,
    countReserveActivities: notUsed,
    lastSuccessfulBridgeDispatch: notUsed,
  };
};

describe('evaluateRecipeWatcher — succeeded_since', () => {
  it('returns runs with commit_status=succeeded finished after cursor', async () => {
    const auditLog = mkAuditLog({
      target: [
        mkEntry({ run_id: 'a', commit_status: 'succeeded', finished_at: 1000 }),
        mkEntry({ run_id: 'b', commit_status: 'succeeded', finished_at: 2000 }),
        mkEntry({ run_id: 'c', commit_status: 'succeeded', finished_at: 3000 }),
      ],
    });
    const r = await evaluateRecipeWatcher(
      { kind: 'succeeded_since', recipe_id: 'target', since_ms: 1500 },
      { auditLog },
    );
    expect(r.should_run).toBe(true);
    expect(r.runs.map((x) => x.run_id)).toEqual(['b', 'c']);
  });

  it('returns runs sorted ascending by finished_at', async () => {
    const auditLog = mkAuditLog({
      target: [
        mkEntry({ run_id: 'late', commit_status: 'succeeded', finished_at: 5000 }),
        mkEntry({ run_id: 'mid', commit_status: 'succeeded', finished_at: 3000 }),
        mkEntry({ run_id: 'early', commit_status: 'succeeded', finished_at: 2000 }),
      ],
    });
    const r = await evaluateRecipeWatcher(
      { kind: 'succeeded_since', recipe_id: 'target', since_ms: 0 },
      { auditLog },
    );
    expect(r.runs.map((x) => x.run_id)).toEqual(['early', 'mid', 'late']);
  });

  it('excludes runs at exact cursor (strict >)', async () => {
    const auditLog = mkAuditLog({
      target: [mkEntry({ run_id: 'at', commit_status: 'succeeded', finished_at: 2000 })],
    });
    const r = await evaluateRecipeWatcher(
      { kind: 'succeeded_since', recipe_id: 'target', since_ms: 2000 },
      { auditLog },
    );
    expect(r.should_run).toBe(false);
    expect(r.runs).toHaveLength(0);
  });

  it('excludes failures from succeeded_since', async () => {
    const auditLog = mkAuditLog({
      target: [
        mkEntry({ run_id: 'ok', commit_status: 'succeeded', finished_at: 2000 }),
        mkEntry({ run_id: 'fail', commit_status: 'failed', finished_at: 2500 }),
      ],
    });
    const r = await evaluateRecipeWatcher(
      { kind: 'succeeded_since', recipe_id: 'target', since_ms: 1000 },
      { auditLog },
    );
    expect(r.runs.map((x) => x.run_id)).toEqual(['ok']);
  });

  it('returns should_run=false + empty runs when no matches', async () => {
    const auditLog = mkAuditLog({ target: [] });
    const r = await evaluateRecipeWatcher(
      { kind: 'succeeded_since', recipe_id: 'target', since_ms: 0 },
      { auditLog },
    );
    expect(r.should_run).toBe(false);
    expect(r.runs).toHaveLength(0);
  });
});

describe('evaluateRecipeWatcher — failed_since', () => {
  it('returns runs with commit_status=failed finished after cursor', async () => {
    const auditLog = mkAuditLog({
      target: [
        mkEntry({ run_id: 'a', commit_status: 'failed', finished_at: 1000 }),
        mkEntry({ run_id: 'b', commit_status: 'failed', finished_at: 2000 }),
        mkEntry({ run_id: 'c', commit_status: 'succeeded', finished_at: 3000 }),
      ],
    });
    const r = await evaluateRecipeWatcher(
      { kind: 'failed_since', recipe_id: 'target', since_ms: 500 },
      { auditLog },
    );
    expect(r.should_run).toBe(true);
    expect(r.runs.map((x) => x.run_id)).toEqual(['a', 'b']);
  });
});

describe('evaluateRecipeWatcher — stopped_since (deferred)', () => {
  it('rejects with explicit message about audit-schema gap', async () => {
    const auditLog = mkAuditLog({ target: [] });
    await expect(
      evaluateRecipeWatcher(
        { kind: 'stopped_since', recipe_id: 'target', since_ms: 0 },
        { auditLog },
      ),
    ).rejects.toThrow(/stopped_since is not supported yet/);
  });
});

describe('evaluateRecipeWatcher — validation', () => {
  it('rejects unknown kind', async () => {
    const auditLog = mkAuditLog({});
    await expect(
      evaluateRecipeWatcher(
        { kind: 'bogus' as never, recipe_id: 'target', since_ms: 0 },
        { auditLog },
      ),
    ).rejects.toThrow(IngredientError);
  });
  it('rejects missing recipe_id', async () => {
    const auditLog = mkAuditLog({});
    await expect(
      evaluateRecipeWatcher(
        { kind: 'succeeded_since', recipe_id: '', since_ms: 0 },
        { auditLog },
      ),
    ).rejects.toThrow(/recipe_id/);
  });
  it('rejects negative since_ms', async () => {
    const auditLog = mkAuditLog({});
    await expect(
      evaluateRecipeWatcher(
        { kind: 'succeeded_since', recipe_id: 'target', since_ms: -1 },
        { auditLog },
      ),
    ).rejects.toThrow(/since_ms/);
  });
  it('rejects non-finite since_ms', async () => {
    const auditLog = mkAuditLog({});
    await expect(
      evaluateRecipeWatcher(
        { kind: 'succeeded_since', recipe_id: 'target', since_ms: NaN },
        { auditLog },
      ),
    ).rejects.toThrow(IngredientError);
  });
});

describe('evaluateRecipeWatcher — output shape', () => {
  it('returns RecipeWatcherRunSummary fields, strips config_snapshot + errors', async () => {
    const auditLog = mkAuditLog({
      target: [
        {
          run_id: 'a',
          recipe_id: 'target',
          recipe_hash: 'h',
          started_at: 1000,
          finished_at: 2000,
          duration_ms: 1000,
          commit_status: 'succeeded',
          config_snapshot: { secret: 'do-not-leak' },
          errors: [],
          trigger_url: null,
          trigger_source: 'schedule',
          instance_id: 'i-1',
        },
      ],
    });
    const r = await evaluateRecipeWatcher(
      { kind: 'succeeded_since', recipe_id: 'target', since_ms: 0 },
      { auditLog },
    );
    expect(r.runs).toEqual([
      {
        run_id: 'a',
        recipe_id: 'target',
        started_at: 1000,
        finished_at: 2000,
        duration_ms: 1000,
        trigger_source: 'schedule',
      },
    ]);
    // Sanity: no leaking fields.
    const first = r.runs[0] as unknown as Record<string, unknown>;
    expect(first.config_snapshot).toBeUndefined();
    expect(first.errors).toBeUndefined();
  });
});
