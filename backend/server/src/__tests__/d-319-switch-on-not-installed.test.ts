/** D-319 — a recipe the server only SHIPS cannot be switched on.
 *
 *  A recipe that starts on its own runs its timer and its declared triggers
 *  only once INSTALLED: the auto-run roster and the declarative trigger
 *  reconciler both read `listStored()`. Switching on a bundled-only copy made
 *  a dish that showed On and started nothing, so the switch is refused with
 *  the same `pack_not_installed` shape the run and schedule refusals use.
 *
 *  Only the switch: a dish made to hold a schedule's settings, and a dish that
 *  holds a schedule or trigger of its own, still switch — those rows run the
 *  shipped recipe by id. The production wiring is proven through
 *  `composeListeners` in `serve-compose-listeners.test.ts`. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcError, type Dish } from '@recued/contracts';
import { createDishStore } from '../dish-store.js';
import {
  createDish,
  mainDishFor,
  updateDish,
  type DishHandlerDeps,
  type RecipeInstallState,
} from '../dish-handler.js';
import { createDishAutomation, type DishAutomation } from '../dish-automation.js';
import { bundledPacksShippingRecipe, loadBundledPackManifests } from '../bundled-pack-source.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const ORGANIZER = { ref: 'recued-core.personal-organizer-foundation', name: 'Personal Organizer' };

/** `today` ships with one pack and is not installed; `remind-me-of` is a
 *  manual recipe that is not installed either; `digest` is installed. */
const STATES: Record<string, RecipeInstallState> = {
  today: { installed: false, startsOnItsOwn: true, name: 'Today', packs: [ORGANIZER] },
  twin: {
    installed: false,
    startsOnItsOwn: true,
    name: 'Twin',
    packs: [ORGANIZER, { ref: 'acme.organizer-twin', name: 'Organizer twin' }],
  },
  'remind-me-of': { installed: false, startsOnItsOwn: false, name: 'Remind me', packs: [] },
  digest: { installed: true, startsOnItsOwn: true, name: 'Digest', packs: [] },
};

interface Recorder {
  readonly calls: string[];
  readonly rows: Map<string, number>;
  readonly automation: DishAutomation;
}

const recorder = (): Recorder => {
  const calls: string[] = [];
  const rows = new Map<string, number>();
  return {
    calls,
    rows,
    automation: {
      created: (dish, opts) => { calls.push(`created ${dish.recipe_id} switchOn=${opts.switchOn}`); },
      switched: (dish) => { calls.push(`switched ${dish.dish_id} ${dish.enabled ? 'on' : 'off'}`); },
      settingsChanged: () => undefined,
      deleted: () => undefined,
      touched: () => undefined,
      ownRows: (dish_id) => rows.get(dish_id) ?? 0,
    },
  };
};

const makeDeps = (over: Partial<DishHandlerDeps> = {}): DishHandlerDeps & { rec: Recorder } => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const rec = recorder();
  return {
    store: createDishStore(db),
    automation: rec.automation,
    recipeInstall: (recipe_id) => STATES[recipe_id] ?? null,
    now: () => 5_000,
    rec,
    ...over,
  };
};

/** The refusal, caught: a thrown RpcError or the test fails. */
const refusal = (act: () => unknown): RpcError => {
  try {
    act();
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    return error as RpcError;
  }
  throw new Error('expected the switch to be refused');
};

describe('dishes.create — switching on a recipe the server only ships', () => {
  it('is refused with the pack named and linked, and nothing is made', () => {
    const deps = makeDeps();
    const error = refusal(() => createDish(deps, { recipe_id: 'today' }));
    expect(error.code).toBe('pack_not_installed');
    expect(error.status).toBe(400);
    expect(error.message).toBe(
      "'Today' comes with the Personal Organizer pack, which is not installed. "
        + 'Install it from Packs, then switch it on.',
    );
    expect(error.details).toEqual({ missing_packs: ['recued-core.personal-organizer-foundation'] });
    expect(deps.store.listByRecipe('today')).toEqual([]);
    expect(deps.rec.calls).toEqual([]);
  });

  it('names no single pack when several ship it — any one would do, which "install them" cannot say', () => {
    const error = refusal(() => createDish(makeDeps(), { recipe_id: 'twin' }));
    expect(error.code).toBe('pack_not_installed');
    expect(error.message).toBe(
      "'Twin' comes with a pack that is not installed. Install it from Packs, then switch it on.",
    );
    expect(error.details).toBeUndefined();
  });

  it('switches on an installed recipe as before', () => {
    const deps = makeDeps();
    const { dish } = createDish(deps, { recipe_id: 'digest' });
    expect(dish).toMatchObject({ recipe_id: 'digest', enabled: true, is_default: true });
    expect(deps.rec.calls).toEqual(['created digest switchOn=true']);
  });

  it('saves settings for a shipped recipe that only runs when the owner runs it', () => {
    const deps = makeDeps();
    const { dish } = createDish(deps, { recipe_id: 'remind-me-of', config_overlay: { when: 'tomorrow' } });
    expect(dish).toMatchObject({ recipe_id: 'remind-me-of', enabled: true });
  });

  it('saves a dish made OFF — saved is not switched on, whatever the caller asks', () => {
    const deps = makeDeps();
    const { dish } = createDish(deps, { recipe_id: 'today', enabled: false });
    expect(dish.enabled).toBe(false);
    expect(deps.rec.calls).toEqual(['created today switchOn=false']);
    // `created` turns a dish's rows on only when the dish itself is on.
    expect(createDish(deps, { recipe_id: 'today', enabled: false }, { switchOn: true }).dish.enabled).toBe(false);
  });

  it('makes the dish a schedule or trigger needs — only that row runs, and it runs the shipped copy', () => {
    const deps = makeDeps();
    const made = mainDishFor(deps, { recipe_id: 'today', publisher_id: 'recued-core', config_overlay: null }).dish;
    expect(made).toMatchObject({ recipe_id: 'today', enabled: true, is_default: true });
    expect(deps.rec.calls).toEqual(['created today switchOn=false']);
  });

  it('checks the request first: a malformed create is a bad request, not a missing pack', () => {
    const error = refusal(() => createDish(makeDeps(), { recipe_id: 'today', enabled: 'yes' }));
    expect(error.code).toBe('bad_request');
  });

  it('refuses nothing without the install read (a harness) or for a recipe the server does not have', () => {
    const bare = makeDeps({ recipeInstall: undefined });
    expect(createDish(bare, { recipe_id: 'today' }).dish.enabled).toBe(true);
    const unknown = makeDeps();
    expect(createDish(unknown, { recipe_id: 'gone' }).dish.recipe_id).toBe('gone');
  });
});

describe('dishes.update — Off → On', () => {
  const offDish = (deps: DishHandlerDeps, recipe_id: string): Dish =>
    createDish(deps, { recipe_id, enabled: false }).dish;

  it('is refused for a dish of a shipped recipe that holds nothing of its own — it stays Off', () => {
    const deps = makeDeps();
    const dish = offDish(deps, 'today');
    const error = refusal(() => updateDish(deps, dish.dish_id, { enabled: true }));
    expect(error.code).toBe('pack_not_installed');
    expect(error.details).toEqual({ missing_packs: ['recued-core.personal-organizer-foundation'] });
    expect(deps.store.get(dish.dish_id)!.enabled).toBe(false);
    expect(deps.rec.calls.filter((call) => call.startsWith('switched'))).toEqual([]);
  });

  it('goes ahead when the dish holds a schedule or trigger — switching it on turns those on', () => {
    const deps = makeDeps();
    const dish = offDish(deps, 'today');
    deps.rec.rows.set(dish.dish_id, 1);
    expect(updateDish(deps, dish.dish_id, { enabled: true }).dish.enabled).toBe(true);
    expect(deps.rec.calls).toContain(`switched ${dish.dish_id} on`);
  });

  it('leaves every other change alone: On → Off, On → On (re-arm), settings, and an installed recipe', () => {
    const deps = makeDeps();
    const shipped = mainDishFor(deps, { recipe_id: 'today', publisher_id: 'recued-core', config_overlay: null }).dish;
    expect(updateDish(deps, shipped.dish_id, { enabled: true }).dish.enabled).toBe(true);
    expect(updateDish(deps, shipped.dish_id, { config_overlay: { horizon: 'week' } }).dish.config_overlay)
      .toEqual({ horizon: 'week' });
    expect(updateDish(deps, shipped.dish_id, { enabled: false }).dish.enabled).toBe(false);
    const installed = offDish(deps, 'digest');
    expect(updateDish(deps, installed.dish_id, { enabled: true }).dish.enabled).toBe(true);
  });

  it('reads a harness double with no row count as holding nothing', () => {
    const deps = makeDeps();
    const { ownRows: _dropped, ...withoutCount } = deps.rec.automation;
    deps.automation = withoutCount;
    const dish = offDish(deps, 'today');
    expect(refusal(() => updateDish(deps, dish.dish_id, { enabled: true })).code).toBe('pack_not_installed');
  });
});

describe('the bundled packs that ship a recipe', () => {
  // Checked against the manifests themselves, not against the function's own
  // answer: a checkout ships ~1,000 packs and a release only its foundation.
  it('names each roster pack whose manifest lists the recipe, by its name, and no other', () => {
    const recipe_id = 'reminder-due-notifier';
    const manifests = loadBundledPackManifests();
    const packs = bundledPacksShippingRecipe(recipe_id);
    expect(packs.map((pack) => pack.ref)).toContain('recued-core.personal-organizer-foundation');
    for (const pack of packs) {
      const manifest = manifests.find((m) => `${m.publisher}.${m.slug}` === pack.ref);
      expect(manifest?.recipes.map((ref) => ref.slug), pack.ref).toContain(recipe_id);
      expect(pack.name).toBe(manifest!.name);
    }
    expect(bundledPacksShippingRecipe('no-such-recipe')).toEqual([]);
  });
});

describe('dish automation — the rows a dish holds', () => {
  it('counts its triggers and schedules, and no other dish’s', () => {
    const triggers = [
      { trigger_id: 't1', dish_id: 'dsh_a' },
      { trigger_id: 't2', dish_id: 'dsh_b' },
    ];
    const schedules = [
      { schedule_id: 's1', dish_id: 'dsh_a', enabled: true, last_run_at: null },
      { schedule_id: 's2', dish_id: 'dsh_a', enabled: false, last_run_at: null },
    ];
    const automation = createDishAutomation({
      triggers: {
        store: {
          list: () => triggers,
          update: () => undefined,
          remove: () => true,
          ownerEnabled: () => true,
        } as never,
        reconcile: () => false,
        rebuild: () => undefined,
      },
      schedules: { list: () => schedules, setEnabled: () => undefined, remove: () => undefined },
    });
    expect(automation.ownRows!('dsh_a')).toBe(3);
    expect(automation.ownRows!('dsh_b')).toBe(1);
    expect(automation.ownRows!('dsh_none')).toBe(0);
  });
});
