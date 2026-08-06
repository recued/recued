/** Fire-time PACK gate — a schedule whose recipe's pack was uninstalled.
 *
 *  ⛔ THE FAILURE THIS PREVENTS IS A CRON THAT FAILS FOREVER. `depends_on` names
 *  a pack that is no longer installed ⇒ `lowerSequentialStep` throws
 *  `CanonicalOpResolutionError` for "a two-tier id that resolves to nothing"
 *  BEFORE step 1. Dispatching anyway turns one uninstall into a failed run every
 *  minute, indefinitely — and nobody is watching a schedule at 03:00, so a loud
 *  error there is functionally silent.
 *
 *  Two properties the gate must hold together, and they pull in opposite
 *  directions:
 *
 *   1. **Still armed.** Runnability is recoverable by design — "uninstalling a
 *      provider NEVER deletes a recipe, it only MOVES the recipe's runnability".
 *      Reinstalling the pack must resume the schedule on its own, so the gate may
 *      not retire or disable it.
 *   2. **Not silent.** The sibling dish gate skips silently, which is right for a
 *      state the OWNER CHOSE (they disabled the dish) and wrong for one they did
 *      not. An uninstall elsewhere is exactly the case where nobody knows this
 *      schedule stopped, so `last_error` has to name the missing pack.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createScheduleStore } from '../schedule-store.js';
import { createScheduler } from '../scheduler.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

const CRON = '0 9 * * *';
/** Tue 2026-04-14 09:00 local — built in local time so `cronMatchesAt` aligns. */
const FIRE_AT = new Date(2026, 3, 14, 9, 0, 0).getTime();

let db: Database.Database;
let store: ReturnType<typeof createScheduleStore>;

beforeEach(() => {
  db = new Database(':memory:');
  store = createScheduleStore(db);
  store.set({
    schedule_id: 's1',
    recipe_id: 'parse-a-pdf',
    cron_expression: CRON,
    enabled: true,
    next_run_at: FIRE_AT,
  } as never);
});
afterEach(() => { db.close(); });

/** An installed-pack inventory row in the shape `buildPackOpResolution` reads:
 *  `segments[0]` is the pack slug, `value.publisher` qualifies the ref, and each
 *  `ingredient_ids` entry must resolve to a manifest declaring operations. */
const installedRow = (packSlug: string) => ({
  segments: [packSlug],
  value: { publisher: 'recued-core', ingredient_ids: [packSlug] },
});

const mkDeps = (opts: {
  dependsOn?: string[];
  installed?: string[];
  contractScan?: boolean;
  fired: string[];
}): ExecuteHandlerDeps => ({
  recipeStore: {
    get: (id: string) => ({
      recipe_id: id,
      version: 1,
      steps: [],
      ...(opts.dependsOn ? { depends_on: opts.dependsOn } : {}),
    }),
    size: () => 1,
  },
  executorConfig: {
    manifests: {
      get: (slug: string) => ((opts.installed ?? []).includes(slug)
        ? { slug, operations: { 'document.to_markdown': {} } }
        : undefined),
      size: () => (opts.installed ?? []).length,
    },
    vault: {},
  },
  baseVault: {},
  instanceId: 'server-test-1',
  ...(opts.contractScan === false ? {} : {
    contractScan: () => (opts.installed ?? []).map(installedRow),
  }),
} as unknown as ExecuteHandlerDeps);

/** A scheduler whose execute seam RECORDS dispatches — the gate's whole job is
 *  to keep this empty, so a stub that silently succeeded would prove nothing. */
const schedulerWith = (deps: ExecuteHandlerDeps, fired: string[]) => createScheduler({
  store,
  executeDeps: deps,
  now: () => FIRE_AT,
  execute: (async (_d: unknown, req: { recipe_id: string }) => {
    fired.push(req.recipe_id);
    return { success: true, steps: [], errors: [] };
  }) as never,
});

describe('scheduler fire-time pack gate', () => {
  it('skips the fire when a declared pack is not installed', async () => {
    const fired: string[] = [];
    const sched = schedulerWith(
      mkDeps({ dependsOn: ['recued-core.docling'], installed: [], fired }),
      fired,
    );
    await sched.tick();

    // ⛔ The property: the run never happened. Without the gate this dispatches
    // and dies in lowering, every single tick.
    expect(fired).toEqual([]);

    const after = store.get('s1')!;
    expect(after.last_status).toBe('skipped');
    // Not silent — the owner has to be able to see WHY it stopped.
    expect(after.last_error).toMatch(/recued-core\.docling/);
    expect(after.last_error).toMatch(/reinstall/i);
    // Still armed and still ticking forward: reinstalling must resume it.
    expect(after.enabled).toBe(true);
    expect(after.next_run_at).not.toBeNull();
    expect(after.next_run_at! > FIRE_AT).toBe(true);
  });

  it('fires normally once the pack IS installed', async () => {
    const fired: string[] = [];
    const sched = schedulerWith(
      mkDeps({ dependsOn: ['recued-core.docling'], installed: ['docling'], fired }),
      fired,
    );
    await sched.tick();
    expect(fired).toEqual(['parse-a-pdf']);
    expect(store.get('s1')!.last_status).not.toBe('skipped');
  });

  it('names EVERY missing pack, not just the first', async () => {
    // The install offer this feeds has to list them all — a user who installs
    // one and re-runs, only to be told about the next, learns nothing useful.
    const fired: string[] = [];
    const sched = schedulerWith(
      mkDeps({
        dependsOn: ['recued-core.docling', 'recued-core.whisper'],
        installed: ['docling'],
        fired,
      }),
      fired,
    );
    await sched.tick();
    const err = store.get('s1')!.last_error ?? '';
    expect(err).toMatch(/recued-core\.whisper/);
    expect(err).not.toMatch(/recued-core\.docling/); // that one IS installed
  });

  it('does not gate a recipe that declares no packs', async () => {
    const fired: string[] = [];
    const sched = schedulerWith(mkDeps({ installed: [], fired }), fired);
    await sched.tick();
    expect(fired).toEqual(['parse-a-pdf']);
  });

  it('is inert without a contract store rather than blocking every fire', async () => {
    // ⚠ Fail-OPEN here, deliberately, and only here. A dbless / pre-contract
    // boot cannot enumerate installed packs, so treating "cannot tell" as
    // "missing" would silence every schedule on the server. The run path still
    // fails closed on its own if the pack really is absent.
    const fired: string[] = [];
    const sched = schedulerWith(
      mkDeps({ dependsOn: ['recued-core.docling'], installed: [], contractScan: false, fired }),
      fired,
    );
    await sched.tick();
    expect(fired).toEqual(['parse-a-pdf']);
  });

  // ⚠ The gate resolves the inventory through a PER-TICK memo (one scan serves
  // every schedule due that minute). A memo that outlived its tick would gate
  // forever on the inventory as it stood the first time the server ticked — so
  // the uninstall this feature exists to catch would be the thing it missed.
  it('sees an uninstall that lands between two ticks', async () => {
    const fired: string[] = [];
    const installed = ['docling'];
    const deps = {
      recipeStore: {
        get: (id: string) => ({
          recipe_id: id, version: 1, steps: [], depends_on: ['recued-core.docling'],
        }),
        size: () => 1,
      },
      executorConfig: {
        manifests: {
          get: (slug: string) => (installed.includes(slug)
            ? { slug, operations: { 'document.to_markdown': {} } }
            : undefined),
          size: () => installed.length,
        },
        vault: {},
      },
      baseVault: {},
      instanceId: 'server-test-1',
      contractScan: () => installed.map(installedRow),
    } as unknown as ExecuteHandlerDeps;

    const sched = schedulerWith(deps, fired);
    await sched.tick();
    expect(fired).toEqual(['parse-a-pdf']);

    // The owner uninstalls it, and the schedule comes due again next minute.
    installed.length = 0;
    store.updateRun('s1', {
      last_run_at: null, next_run_at: FIRE_AT, last_status: null, last_error: null,
    } as never);
    await sched.tick();

    expect(fired).toEqual(['parse-a-pdf']); // no second dispatch
    expect(store.get('s1')!.last_status).toBe('skipped');
    expect(store.get('s1')!.last_error).toMatch(/recued-core\.docling/);
  });
});
