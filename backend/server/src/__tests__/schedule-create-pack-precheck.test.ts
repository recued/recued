/** Schedule-creation pack refusal.
 *
 *  ⛔ NEVER ARM WHAT CANNOT RUN. A recipe whose declared pack is not installed
 *  cannot lower — `lowerSequentialStep` throws before step 1 — so a cron created
 *  against it fails every firing, forever. The fire-time gate skips those loudly
 *  and keeps them armed for recovery, which is right for a pack uninstalled
 *  AFTER the fact. But at creation time the answer is already known, and
 *  refusing beats explaining later on a surface nobody revisits.
 *
 *  Refuse, not warn: a warning attached to a cron the owner will not look at
 *  again is indistinguishable from silence, and this verdict is unambiguous —
 *  no input makes a recipe that cannot lower run.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';

import { createSchedule } from '../schedule-handler.js';
import { createScheduleStore } from '../schedule-store.js';

const mkDeps = (missing: Record<string, readonly string[]> | null) => ({
  store: createScheduleStore(new Database(':memory:')),
  instanceId: 'i-1',
  ...(missing === null
    ? {}
    : { missingPackDepsForRecipe: (recipe_id: string) => missing[recipe_id] ?? [] }),
});

const create = (deps: ReturnType<typeof mkDeps>, recipe_id: string) =>
  createSchedule(deps as never, { recipe_id, cron_expression: '0 9 * * *' } as never);

describe('schedules.create — missing pack refusal', () => {
  it('refuses a recipe whose pack is not installed', () => {
    const deps = mkDeps({ 'parse-a-pdf': ['recued-core.docling'] });
    let thrown: RpcError | null = null;
    try {
      create(deps, 'parse-a-pdf');
    } catch (e) {
      thrown = e as RpcError;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.code).toBe('pack_not_installed');
    // The SAME typed shape the run path throws, so a surface renders the same
    // install offer here without a second error contract to learn.
    expect((thrown!.details as { missing_packs?: string[] }).missing_packs)
      .toEqual(['recued-core.docling']);
  });

  it('leaves NO schedule behind when it refuses', () => {
    // ⛔ The property a "validate then insert" ordering bug would break: a
    // refusal that still armed the cron is worse than no check, because the
    // owner is told it failed while it fires forever.
    const deps = mkDeps({ 'parse-a-pdf': ['recued-core.docling'] });
    expect(() => create(deps, 'parse-a-pdf')).toThrow();
    expect(deps.store.list()).toEqual([]);
  });

  it('names every missing pack, not just the first', () => {
    const deps = mkDeps({ multi: ['recued-core.docling', 'recued-core.whisper'] });
    try {
      create(deps, 'multi');
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as RpcError).details as { missing_packs?: string[] })
        .toMatchObject({ missing_packs: ['recued-core.docling', 'recued-core.whisper'] });
    }
  });

  it('creates normally when every declared pack is installed', () => {
    const deps = mkDeps({ 'parse-a-pdf': [] });
    const { schedule } = create(deps, 'parse-a-pdf');
    expect(schedule.recipe_id).toBe('parse-a-pdf');
    expect(deps.store.list()).toHaveLength(1);
  });

  // ⚠ Fail-OPEN when unwired — a dbless / pre-contract boot cannot enumerate
  // installed packs, and reading "cannot tell" as "missing" would make the
  // server refuse every schedule anyone tried to create.
  it('creates normally when the dep is absent', () => {
    const deps = mkDeps(null);
    const { schedule } = create(deps, 'parse-a-pdf');
    expect(schedule.recipe_id).toBe('parse-a-pdf');
  });

  // ⚠ The existence check above this one stays DORMANT on the UI path — its
  // absence there is documented as deliberate ("legacy UI path leaves this
  // absent for backward compatibility"). Adding the pack refusal must not
  // switch it on as a side effect: that is a separate decision, on its own
  // evidence. An unknown recipe still creates when only the pack dep is wired.
  it('does not switch on the dormant recipe-existence check', () => {
    const deps = mkDeps({});
    const { schedule } = create(deps, 'a-recipe-this-server-has-never-heard-of');
    expect(schedule.recipe_id).toBe('a-recipe-this-server-has-never-heard-of');
  });
});
