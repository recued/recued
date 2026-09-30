/** D-215 slice 3 — the `#automation/dishes` section.
 *
 *  The cross-recipe dish aggregate: a fourth section token beside auto-run
 *  / triggers / schedules, inheriting the sub-nav, the recipe filter, and
 *  the deep-link plumbing for free.
 *
 *  Two rulings are load-bearing here and both are pinned below:
 *
 *   (a) MANAGED dishes are VISIBLE and BADGED with their owner. Hiding
 *       them was right while the dish was an implementation detail behind
 *       a schedule row; once the dish is the object, a hidden dish firing
 *       hourly is exactly the invisible automation the control-plane
 *       framing exists to prevent. Their mutations still belong to the
 *       owning row — slice 3 renders no actions at all.
 *
 *   (b) `last_runs` OMITS a dish that never ran. "never run" and "ran, no
 *       status" are different statements, and a surface that conflates
 *       them renders a fresh dish as failed.
 *
 *  Spec: D-215 § 3, § 4.1, § 4.3.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Dish, DishLastRun, DishRunRow } from '@recued/contracts';
import {
  bootstrapAutomationRoute,
  AUTOMATION_SECTION_TOKENS,
  type BootstrapAutomationRouteOptions,
  type DishesListCaller,
} from '../automation/bootstrap-automation-route.js';

// ── Fake DOM ────────────────────────────────────────────────────
// Copied from `automation-route.test.ts`: the webclient tests run in a
// node env by deliberate discipline (no jsdom), and each file carries
// its own createElement fake rather than sharing one.

// ── Fake DOM (runs-route idiom) ─────────────────────────────────

interface FakeEl {
  tagName: string;
  innerHTML: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: Event) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev: Event) => void): void;
  removeEventListener(type: string, fn: (ev: Event) => void): void;
}

const makeFakeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    innerHTML: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const idx = el.children.indexOf(c);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      c.parent = null;
      return c;
    },
    addEventListener(type, fn) {
      const arr = el.listeners.get(type) ?? [];
      arr.push(fn);
      el.listeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      const arr = el.listeners.get(type);
      if (arr === undefined) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
  };
  return el;
};

const makeFakeDocument = () => {
  const styleElements: FakeEl[] = [];
  const body = makeFakeEl('body');
  return {
    styleElements,
    body,
    head: {
      querySelector(sel: string) {
        const m = sel.match(/^style\[([\w-]+)\]$/);
        if (m?.[1] === undefined) return null;
        return styleElements.find((style) => style.attrs.has(m[1]!)) ?? null;
      },
      appendChild(el: FakeEl) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag: string) => makeFakeEl(tag),
  };
};

const NOW = 1_700_000_000_000;

const dish = (over: Partial<Dish> = {}): Dish => ({
  dish_id: 'dsh_a',
  recipe_id: 'daily-brief',
  publisher_id: 'recued-core',
  name: 'Tuesday post',
  is_default: false,
  config_overlay: { text: 'hello' },
  enabled: true,
  created_at: NOW - 10_000,
  ...over,
});

const lastRun = (over: Partial<DishLastRun> = {}): DishLastRun => ({
  run_id: 'run-1',
  started_at: NOW - 60_000,
  commit_status: 'succeeded',
  ...over,
});

const mount = (overrides: Partial<BootstrapAutomationRouteOptions> = {}) => {
  const doc = makeFakeDocument();
  const root = makeFakeEl('div');
  const route = bootstrapAutomationRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    schedulesListCaller: async () => ({ schedules: [] }),
    triggersListCaller: async () => ({ triggers: [] }),
    autoRunListCaller: async () => ({ entries: [] }),
    watchListCaller: async () => ({ watches: [] }),
    now: () => NOW,
    initialSection: 'dishes',
    ...overrides,
  });
  return { doc, root, host: root.children[0]!, route };
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('D-215 slice 3 — the dishes section exists as a fourth token', () => {
  it('is registered in AUTOMATION_SECTION_TOKENS after the original three', () => {
    // The deep-link vocabulary. D-319 §5.4 put the page's two views first:
    // the lists by kind are no longer tabs, but their links still land.
    expect(AUTOMATION_SECTION_TOKENS).toEqual([
      'all', 'coming-up', 'auto-run', 'triggers', 'schedules', 'dishes',
    ]);
  });
});

describe('D-215 slice 3 — dish rows', () => {
  it('renders a dish with its name, origin badge, and last outcome', async () => {
    const rig = mount({
      dishesListCaller: async () => ({
        dishes: [dish()],
        last_runs: { dsh_a: lastRun({ commit_status: 'failed' }) },
      }),
    });
    await settle();
    const html = rig.host.innerHTML;

    expect(html).toContain('Tuesday post');
    expect(html).toContain('data-dish-origin="assigned"');
    expect(html).toContain('Assigned');
    expect(html).toContain('failed');
  });

  it.each([
    // D-319 — a schedule or trigger mints no dish; the main dish is badged.
    [{ is_default: true }, 'main', 'Main'],
    [{ is_default: false }, 'assigned', 'Assigned'],
  ] as const)('badges a dish with where it came from (%j)', async (patch, badge, label) => {
    const rig = mount({
      dishesListCaller: async () => ({ dishes: [dish(patch)] }),
    });
    await settle();
    const html = rig.host.innerHTML;

    // Ruling (a): visible, and the owner is named — not hidden, not bare.
    expect(html).toContain(`data-dish-origin="${badge}"`);
    expect(html).toContain(label);
  });

  it('renders "never run" for a dish absent from last_runs', async () => {
    const rig = mount({
      dishesListCaller: async () => ({ dishes: [dish()], last_runs: {} }),
    });
    await settle();
    expect(rig.host.innerHTML).toContain('never run');
  });

  it('treats an OMITTED last_runs map the same as an empty one', async () => {
    // The server omits the field entirely when no audit store is wired.
    // "no map" and "not in the map" must render identically, or a whole
    // server configuration renders as universal failure.
    const rig = mount({
      dishesListCaller: async () => ({ dishes: [dish()] }),
    });
    await settle();
    expect(rig.host.innerHTML).toContain('never run');
  });

  it('shows the DEFAULT dish under its recipe name, never a blank label', async () => {
    // D-179 fork (c): the default dish carries `name: ''`.
    const rig = mount({
      dishesListCaller: async () => ({ dishes: [dish({ name: '', is_default: true })] }),
      recipeNamesCaller: async () => ({
        recipes: [{ recipe_id: 'daily-brief', name: 'Daily brief' }],
      }),
    });
    await settle();
    expect(rig.host.innerHTML).toContain('Daily brief');
  });

  it('distinguishes a config-carrying dish from one on recipe defaults', async () => {
    const rig = mount({
      dishesListCaller: async () => ({
        dishes: [dish({ dish_id: 'dsh_cfg' }), dish({ dish_id: 'dsh_bare', config_overlay: {} })],
      }),
    });
    await settle();
    const html = rig.host.innerHTML;
    expect(html).toContain('1 config value(s)');
    expect(html).toContain('recipe defaults');
  });

  it('renders NO row actions without the dish callers — slice 3 is read-only', async () => {
    const rig = mount({
      dishesListCaller: async () => ({ dishes: [dish()] }),
    });
    await settle();
    const html = rig.host.innerHTML;
    // Positive anchor first — an empty render would satisfy the absences.
    expect(html).toContain('Tuesday post');
    expect(html).not.toContain('delete:dish');
    expect(html).not.toContain('toggle:dish');
  });

  it('surfaces a dishes.list failure on its own section, not the page', async () => {
    const rig = mount({
      dishesListCaller: async () => { throw new Error('boom'); },
    });
    await settle();
    // The other sections' callers all resolved; the route must still mount.
    expect(rig.root.children.length).toBeGreaterThan(0);
  });

  it('an ABSENT caller is soft: no load error, and no "no dishes" claim', async () => {
    // Unlike the four core lists, `dishes.list` is additive — a host that
    // has not opted in is not a failure. Two things must hold together:
    // `getLoadErrors()` stays clean (every existing host asserts on it, and
    // an extra key broke two of them during this build), AND the section
    // must not claim emptiness it cannot know.
    const rig = mount({});
    await settle();
    expect(rig.route.getLoadErrors().dishes).toBeUndefined();
    expect(rig.host.innerHTML).toContain('This server does not do dishes yet');
    expect(rig.host.innerHTML).not.toContain('No dishes yet');
  });

  it('a FAILING caller is not soft — that is a real error on its own section', async () => {
    const rig = mount({ dishesListCaller: async () => { throw new Error('boom'); } });
    await settle();
    expect(rig.route.getLoadErrors().dishes).toBeTruthy();
  });

  it('narrows to one recipe under the recipe filter', async () => {
    const dishesListCaller = vi.fn<DishesListCaller>(async () => ({
      dishes: [
        dish({ dish_id: 'dsh_a', recipe_id: 'daily-brief', name: 'Keep me' }),
        dish({ dish_id: 'dsh_b', recipe_id: 'other-recipe', name: 'Drop me' }),
      ],
    }));
    const rig = mount({ dishesListCaller, initialRecipeFilter: 'daily-brief' });
    await settle();
    const html = rig.host.innerHTML;
    expect(html).toContain('Keep me');
    expect(html).not.toContain('Drop me');
  });
});

// ── Recipe-detail Dishes section ────────────────────────────────
//
// The SAME data, mounted where D-215 § 4.1 makes it primary: inside the
// recipe the dish belongs to. `renderDishesSection` is exercised through
// the real route so the null/[] distinction is tested where it renders.

describe('D-215 slice 3 / D-319 — the recipe detail lists its own dishes ("Running as")', () => {
  const recipeEntry = (recipe: Record<string, unknown> = {}) => ({
    recipe_id: 'daily-brief',
    publisher_id: 'recued-core',
    version: 1,
    recipe_hash: 'hash-daily-brief',
    recipe: {
      recipe_id: 'daily-brief',
      version: 1,
      ttl: 60,
      metadata: {
        name: 'Daily brief', description: 'd', author: 'a', supported_platforms: [],
      },
      variables: {},
      prefetch_steps: [],
      steps: [],
      output: { sidebar: [] },
      ...recipe,
    },
    source: 'pair-sync' as const,
    installed_at: NOW - 1_000,
  });

  const mountRecipes = async (
    dishesListCaller?: DishesListCaller,
    recipe: Record<string, unknown> = {},
  ): Promise<{ host: { innerHTML: string } }> => {
    const { bootstrapRecipesRoute } = await import('../recipes/bootstrap-recipes-route.js');
    const doc = makeFakeDocument();
    const root = makeFakeEl('div');
    bootstrapRecipesRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      recipesListCaller: async () => ({ recipes: [recipeEntry(recipe)] }),
      toolCatalogCaller: async () => ({ catalog: [] }),
      ...(dishesListCaller !== undefined ? { dishesListCaller } : {}),
      initialRecipeId: 'daily-brief',
      now: () => NOW,
    } as never);
    await settle();
    await settle();
    return { host: root.children[0] as unknown as { innerHTML: string } };
  };

  it('renders a Dishes section listing only THIS recipe\'s dishes', async () => {
    const { host } = await mountRecipes(async () => ({
      dishes: [
        dish({ dish_id: 'dsh_mine', recipe_id: 'daily-brief', name: 'Mine' }),
        dish({ dish_id: 'dsh_other', recipe_id: 'other', name: 'Theirs' }),
      ],
      last_runs: { dsh_mine: lastRun() },
    }));
    expect(host.innerHTML).toContain('Mine');
    expect(host.innerHTML).not.toContain('Theirs');
  });

  it('says so when the recipe has no dishes — [] is a real answer', async () => {
    const { host } = await mountRecipes(async () => ({ dishes: [] }), {
      event_triggers: [{ event: 'data.mail.**.created' }],
    });
    expect(host.innerHTML).toContain('Not switched on');
  });

  it('a recipe run only by hand, with no settings and no dish, has nothing to say', async () => {
    const { host } = await mountRecipes(async () => ({ dishes: [] }));
    // Positive anchor first — an empty render would satisfy the absence.
    expect(host.innerHTML).toContain('Daily brief');
    expect(host.innerHTML).not.toContain('data-recued-running-as=');
  });

  it('HIDES the section entirely when no caller is wired', async () => {
    // A soft enhancement must never turn into an empty-state CLAIM: with no
    // caller there is no answer, and "No dishes yet" would be a lie.
    const { host } = await mountRecipes();
    // ⚠ POSITIVE ANCHOR FIRST. Without it this test is green-when-dead:
    // dropping the `dishes === null` guard makes `.filter` throw on null,
    // the detail never renders, and two pure-absence assertions both pass
    // on the wreckage. Verified — that mutation survived until this line.
    expect(host.innerHTML).toContain('Daily brief');
    expect(host.innerHTML).not.toContain('Not switched on');
    expect(host.innerHTML).not.toContain('data-recued-running-as=');
  });

  it('a dish switched off says Off', async () => {
    const { host } = await mountRecipes(async () => ({
      dishes: [dish({
        dish_id: 'dsh_m', recipe_id: 'daily-brief', name: 'Second', enabled: false,
      })],
    }));
    expect(host.innerHTML).toContain('data-recued-running-as-status="off"');
    expect(host.innerHTML).toContain('<span class="running-as-state">Off</span>');
  });
});

// ── Slice 4: the write surface ──────────────────────────────────
//
// The whole slice turned on ONE question per row — where does this dish's
// write GO? D-215 had three answers (its own `dishes.*`; a one-shot's
// `schedules.*`; a link to the owning rule). D-319 retired the managed
// dishes, so every dish writes through its own `dishes.*`.
//
// A test that only checks "a button exists" cannot tell which rpc a row
// calls. These check WHICH rpc fires.

const schedule = (over: Record<string, unknown> = {}) => ({
  schedule_id: 'sch_9', recipe_id: 'daily-brief', publisher_id: 'recued-core',
  cron_expression: '0 9 * * *', enabled: true, created_at: NOW - 1_000,
  last_run_at: null, next_run_at: NOW + 1_000, last_status: null, last_error: null,
  ...over,
});

describe('D-215 slice 4 — a dish write goes where its lifecycle lives', () => {
  it('D-319 — a one-shot schedule is a row of its dish, never a dish of its own', async () => {
    const rig = mount({
      initialSection: 'schedules',
      dishesListCaller: async () => ({ dishes: [dish({ dish_id: 'dsh_main', is_default: true })] }),
      schedulesListCaller: async () => ({
        schedules: [schedule({ mode: 'one_shot', run_at: NOW + 5_000, dish_id: 'dsh_main', cron_expression: '17 4 9 12 *' })],
      }),
    });
    await settle();
    expect(rig.host.innerHTML).toContain('data-recued-automation-row="schedule:sch_9"');

    // The one list: one line for the dish, the one-shot under it.
    const list = mount({
      initialSection: 'all',
      dishesListCaller: async () => ({ dishes: [dish({ dish_id: 'dsh_main', is_default: true })] }),
      schedulesListCaller: async () => ({
        schedules: [schedule({ mode: 'one_shot', run_at: NOW + 5_000, dish_id: 'dsh_main', cron_expression: '17 4 9 12 *' })],
      }),
    });
    await settle();
    const html = list.host.innerHTML;
    expect(html.match(/data-recued-automation-dish="/g)).toHaveLength(1);
    expect(html).toMatch(/data-recued-automation-dish="dsh_main"[\s\S]*data-recued-automation-row="schedule:sch_9"/);
  });

  it('an ASSIGNED dish offers inline actions', async () => {
    const rig = mount({
      dishesListCaller: async () => ({ dishes: [dish({ dish_id: 'dsh_own' })] }),
      dishesUpdateCaller: async () => ({ dish: dish() }),
      dishesDeleteCaller: async () => ({ deleted: true as const }),
    });
    await settle();
    const html = rig.host.innerHTML;
    expect(html).toContain('toggle:dish');
    expect(html).toContain('delete:dish');
    expect(html).not.toContain('data-recued-dish-owner-link');
  });

  it('stays READ-ONLY when the mutation callers are absent', async () => {
    // A host that has not opted in must render no dead buttons.
    const rig = mount({
      dishesListCaller: async () => ({ dishes: [dish()] }),
    });
    await settle();
    // Positive anchor first — an empty render would satisfy the absences.
    expect(rig.host.innerHTML).toContain('Tuesday post');
    expect(rig.host.innerHTML).not.toContain('toggle:dish');
    expect(rig.host.innerHTML).not.toContain('delete:dish');
  });
});

/** Drive the route's delegated click handler (copied idiom from
 *  `automation-route.test.ts`). Markup tests above prove which BUTTONS
 *  render; these prove which RPC actually fires — the mutation that
 *  matters is a row calling the wrong one, and markup cannot see it. */
const clickAction = (host: FakeEl, action: string, ruleId: string): void => {
  const target = {
    closest: (selector: string) =>
      selector.includes('data-recued-automation-action')
        ? {
            getAttribute: (name: string) =>
              name === 'data-recued-automation-action' ? action
                : name === 'data-rule-id' ? ruleId : null,
          }
        : null,
  };
  for (const fn of host.listeners.get('click') ?? []) {
    fn({ target } as unknown as Event);
  }
};

const clickDishHistoryRetry = (host: FakeEl, dishId: string): void => {
  const target = {
    closest: (selector: string) =>
      selector.includes('data-recued-dish-history-retry')
        ? {
            getAttribute: (name: string) =>
              name === 'data-recued-dish-history-retry' ? dishId : null,
          }
        : null,
  };
  for (const fn of host.listeners.get('click') ?? []) {
    fn({ target } as unknown as Event);
  }
};

describe('D-215 slice 4 — the write lands on the RIGHT rpc', () => {
  const rig4 = async (patch: Partial<Dish>, sched?: Record<string, unknown>) => {
    const calls: string[] = [];
    const rig = mount({
      dishesListCaller: async () => ({ dishes: [dish({ dish_id: 'dsh_t', ...patch })] }),
      schedulesListCaller: async () => ({ schedules: sched ? [schedule(sched)] : [] }),
      dishesUpdateCaller: async (a) => { calls.push(`dishes.update:${a.dish_id}`); return { dish: dish() }; },
      dishesDeleteCaller: async (a) => { calls.push(`dishes.delete:${a.dish_id}`); return { deleted: true as const }; },
      schedulesUpdateCaller: async (a) => { calls.push(`schedules.update:${a.schedule_id}`); return { schedule: schedule() }; },
      schedulesDeleteCaller: async (a) => { calls.push(`schedules.delete:${a.schedule_id}`); return { deleted: true as const }; },
    });
    await settle();
    return { rig, calls };
  };

  it('an ASSIGNED dish toggles and removes through dishes.*', async () => {
    const { rig, calls } = await rig4({});
    clickAction(rig.root.children[0] as FakeEl, 'toggle:dish:off', 'dsh_t');
    await settle();
    expect(calls).toEqual(['dishes.update:dsh_t']);
  });

  it('an ASSIGNED dish removes through dishes.delete', async () => {
    const { rig, calls } = await rig4({});
    clickAction(rig.root.children[0] as FakeEl, 'delete:dish', 'dsh_t');
    expect(calls).toEqual([]);
    clickAction(rig.root.children[0] as FakeEl, 'delete-confirm:dish', 'dsh_t');
    await settle();
    expect(calls).toEqual(['dishes.delete:dsh_t']);
  });

  it('an unknown dish id fires nothing', async () => {
    const { rig, calls } = await rig4({});
    clickAction(rig.root.children[0] as FakeEl, 'toggle:dish:off', 'dsh_ghost');
    await settle();
    expect(calls).toEqual([]);
  });
});

describe('D-215 slice 4b — rename, create, config', () => {
  const recipeEntry = {
    recipe_id: 'daily-brief', publisher_id: 'recued-core', version: 1,
    recipe_hash: 'h', source: 'pair-sync' as const, installed_at: NOW - 1_000,
    recipe: {
      recipe_id: 'daily-brief', version: 1, ttl: 60,
      metadata: { name: 'Daily brief', description: 'd', author: 'a', supported_platforms: [] },
      variables: { text: { label: 'Text', type: 'string', default: '' } },
      prefetch_steps: [], steps: [], output: { sidebar: [] },
    },
  };

  const rigB = async (over: Partial<BootstrapAutomationRouteOptions> = {}) => {
    const calls: string[] = [];
    const rig = mount({
      dishesListCaller: async () => ({ dishes: [dish({ dish_id: 'dsh_t' })] }),
      dishesUpdateCaller: async (a) => {
        calls.push(`dishes.update:${JSON.stringify(a)}`); return { dish: dish() };
      },
      dishesDeleteCaller: async () => ({ deleted: true as const }),
      dishesCreateCaller: async (a) => {
        calls.push(`dishes.create:${a.recipe_id}:${a.name ?? ''}`); return { dish: dish() };
      },
      recipeEntriesCaller: async () => ({ recipes: [recipeEntry] } as never),
      ...over,
    });
    await settle();
    await settle();
    return { rig, calls };
  };

  it('offers Rename on an ASSIGNED dish', async () => {
    const { rig } = await rigB();
    expect(rig.host.innerHTML).toContain('rename:dish');
    expect(rig.host.innerHTML).toContain(
      'aria-label="Rename Tuesday post (dsh_t)"',
    );
  });

  // ⚠ The rename SAVE round-trip is browser-verified, not unit-tested.
  // The route reads the typed value via `routeRoot.querySelector`, and this
  // suite's fake DOM has no `querySelector`. Stubbing one breaks the shared
  // RefPicker, which calls `shellEl.querySelector` on the same node — the
  // stub returns a plain object and the picker dies. A harness hack that
  // breaks unrelated components is worse than an honest gap, so the save,
  // the empty-name refusal and the unchanged-name no-op are asserted in
  // Chrome (real DOM) in the slice-4b verify instead.

  it('cancel leaves the name alone', async () => {
    const { rig, calls } = await rigB();
    const host = rig.root.children[0] as FakeEl;
    clickAction(host, 'rename:dish', 'dsh_t');
    clickAction(host, 'rename-cancel:dish', 'dsh_t');
    await settle();
    expect(calls).toEqual([]);
  });

  it('offers "Add dish" only when a create caller is wired', async () => {
    const withCreate = await rigB();
    expect(withCreate.rig.host.innerHTML).toContain('Add dish');
    const rig2 = mount({
      dishesListCaller: async () => ({ dishes: [dish()] }),
      recipeEntriesCaller: async () => ({ recipes: [recipeEntry] } as never),
    });
    await settle();
    // Positive anchor — an empty render would satisfy the absence.
    expect(rig2.host.innerHTML).toContain('Tuesday post');
    expect(rig2.host.innerHTML).not.toContain('Add dish');
  });

  it('offers Config only when the recipe declares variables', async () => {
    const { rig } = await rigB();
    expect(rig.host.innerHTML).toContain('configure:dish');
    expect(rig.host.innerHTML).toContain(
      'aria-label="Config Tuesday post (dsh_t)"',
    );

    const bare = { ...recipeEntry, recipe: { ...recipeEntry.recipe, variables: {} } };
    const rig2 = mount({
      dishesListCaller: async () => ({ dishes: [dish()] }),
      dishesUpdateCaller: async () => ({ dish: dish() }),
      recipeEntriesCaller: async () => ({ recipes: [bare] } as never),
    });
    await settle();
    await settle();
    expect(rig2.host.innerHTML).toContain('Tuesday post');
    expect(rig2.host.innerHTML).not.toContain('configure:dish');
  });
});

describe('D-215 slice 5 — the dish detail, and the RETIRED case', () => {
  const runRow = (over: Partial<DishRunRow> = {}): DishRunRow => ({
    run_id: 'r1', started_at: NOW - 60_000, duration_ms: 120,
    commit_status: 'succeeded', trigger_source: 'schedule', error: null, config: null,
    ...over,
  });

  const openDetail = async (
    over: Partial<BootstrapAutomationRouteOptions>,
    dishId = 'dsh_a',
  ) => {
    const rig = mount({
      dishesListCaller: async () => ({ dishes: [dish()] }),
      dishesHistoryCaller: async () => ({ runs: [runRow()] }),
      ...over,
    });
    await settle();
    clickAction(rig.root.children[0] as FakeEl, 'detail:dish', dishId);
    await settle();
    await settle();
    return rig;
  };

  it('shows a live dish with its origin, state, and run history', async () => {
    const rig = await openDetail({});
    const html = rig.host.innerHTML;
    expect(html).toContain('Tuesday post');
    expect(html).toContain('History');
    expect(html).toContain('data-recued-dish-history="dsh_a"');
    expect(html).toContain('succeeded');
    expect(html).not.toContain('Retired dish');
  });

  it('⛔ a RETIRED dish reads as retired, with its history intact', async () => {
    // Reachable without a stale bookmark: a one-shot retires itself the
    // moment it succeeds, so an OPEN detail becomes this on the very next
    // refresh. Not an error, and emphatically not an empty state — the
    // history below it is real.
    const rig = await openDetail({
      dishesListCaller: async () => ({ dishes: [] }),
      dishesHistoryCaller: async () => ({ runs: [runRow({ run_id: 'gone-1' })] }),
    });
    const html = rig.host.innerHTML;
    expect(html).toContain('Retired dish');
    expect(html).toContain('data-recued-dish-retired="dsh_a"');
    // The history is the whole reason the view still renders.
    expect(html).toContain('data-recued-dish-history="dsh_a"');
    expect(html).toContain('succeeded');
  });

  it('distinguishes a retired dish from one that simply never ran', async () => {
    const rig = await openDetail({
      dishesListCaller: async () => ({ dishes: [] }),
      dishesHistoryCaller: async () => ({ runs: [] }),
    });
    const html = rig.host.innerHTML;
    expect(html).toContain('Retired dish');
    expect(html).toContain('No runs recorded');
  });

  it('surfaces a failed run\'s error in the history', async () => {
    const rig = await openDetail({
      dishesHistoryCaller: async () => ({
        runs: [runRow({ commit_status: 'failed', error: 'it broke' })],
      }),
    });
    expect(rig.host.innerHTML).toContain('it broke');
    expect(rig.host.innerHTML).toContain('failed');
  });

  it('distinguishes a history read failure from a dish with no runs', async () => {
    const rig = await openDetail({
      dishesHistoryCaller: async () => { throw new Error('history unavailable'); },
    });
    const html = rig.host.innerHTML;
    expect(html).toContain('role="alert"');
    expect(html).toContain('history unavailable');
    expect(html).toContain('data-recued-dish-history-retry="dsh_a"');
    expect(html).not.toContain('No runs recorded');
  });

  it('keeps a history retry visible, single-flight, and reconciles its success', async () => {
    const pending: { resolve?: (v: { runs: DishRunRow[] }) => void } = {};
    let calls = 0;
    const rig = await openDetail({
      dishesHistoryCaller: async () => {
        calls += 1;
        if (calls === 1) throw new Error('history unavailable');
        return new Promise<{ runs: DishRunRow[] }>((resolve) => {
          pending.resolve = resolve;
        });
      },
    });
    const host = rig.root.children[0] as FakeEl;
    clickDishHistoryRetry(host, 'dsh_a');
    clickDishHistoryRetry(host, 'dsh_a');

    expect(calls).toBe(2);
    expect(rig.host.innerHTML).toContain('Retrying…');
    expect(rig.host.innerHTML).toContain('aria-disabled="true"');
    expect(rig.host.innerHTML).toContain('aria-busy="true"');
    expect(rig.host.innerHTML).toContain('history unavailable');

    pending.resolve?.({ runs: [runRow({ error: 'RECOVERED-HISTORY' })] });
    await settle();
    await settle();
    expect(rig.host.innerHTML).toContain('RECOVERED-HISTORY');
    expect(rig.host.innerHTML).not.toContain('history unavailable');
    expect(rig.host.innerHTML).not.toContain('data-recued-dish-history-retry');
  });

  it('loads history when mounted directly at a dish detail URL', async () => {
    const history = vi.fn(async () => ({
      runs: [runRow({ error: 'DEEPLINK-HISTORY' })],
    }));
    const rig = mount({
      initialDetailId: 'dsh_a',
      dishesListCaller: async () => ({ dishes: [dish()] }),
      dishesHistoryCaller: history,
    });
    await rig.route.whenLoaded();
    await settle();
    await settle();

    expect(history).toHaveBeenCalledOnce();
    expect(rig.host.innerHTML).toContain('DEEPLINK-HISTORY');
    expect(rig.host.innerHTML).not.toContain('Loading history');
  });

  it('omits the history block entirely when no caller is wired', async () => {
    const rig = await openDetail({ dishesHistoryCaller: undefined });
    // Positive anchor — an empty render would satisfy the absences.
    expect(rig.host.innerHTML).toContain('Tuesday post');
    expect(rig.host.innerHTML).not.toContain('No runs recorded');
    expect(rig.host.innerHTML).not.toContain('data-recued-dish-history');
  });

  it('a stale history response never paints into a DIFFERENT dish', async () => {
    // The detail can change while a fetch is in flight; the response is
    // keyed by dish_id and dropped when it no longer matches.
    // Held in an object: a bare `let` assigned only inside the closure is
    // narrowed to `null` by control-flow analysis and stops being callable.
    const pending: { resolve?: (v: { runs: DishRunRow[] }) => void } = {};
    const rig = mount({
      dishesListCaller: async () => ({
        dishes: [dish({ dish_id: 'dsh_a' }), dish({ dish_id: 'dsh_b', name: 'Second' })],
      }),
      // ⚠ Distinguish them by a RENDERED field. `run_id` is NOT rendered
      // (the row shows time / status / duration / source / error), so an
      // assertion on it is vacuous — verified: the key-check mutation
      // survived until this used `error` instead.
      dishesHistoryCaller: (args) =>
        args.dish_id === 'dsh_a'
          ? new Promise<{ runs: DishRunRow[] }>((r) => { pending.resolve = r; })
          : Promise.resolve({ runs: [runRow({ error: 'B-DISH-MARKER' })] }),
    });
    await settle();
    const host = rig.root.children[0] as FakeEl;
    clickAction(host, 'detail:dish', 'dsh_a');
    await settle();
    clickAction(host, 'detail:dish', 'dsh_b');
    await settle();
    await settle();
    // The first request lands LATE, for a dish that is no longer open.
    pending.resolve?.({ runs: [runRow({ error: 'A-DISH-LATE-MARKER' })] });
    await settle();
    await settle();
    // The open detail is dsh_b; its history must survive intact and the
    // late dsh_a response must be dropped rather than painted over it.
    expect(rig.host.innerHTML).toContain('B-DISH-MARKER');
    expect(rig.host.innerHTML).not.toContain('A-DISH-LATE-MARKER');
  });
});
