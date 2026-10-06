/** Reactive-substrate slice 1 — Automation route tests.
 *
 *  The cross-pack governance view is now three tabbed sections. This
 *  suite mirrors the runs-route harness style: fake document, caller
 *  fakes, whenLoaded barrier, and delegated events driven through the
 *  route-root listeners with synthetic closest() targets.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  AutoRunStatusEntry,
  Dish,
  EventTrigger,
  RecipeDefinition,
  ServerRecipeListEntry,
  ServerSchedule,
  WatchSourceStatusEntry,
  WatchStatusEntry,
} from '@recued/contracts';
import {
  encodeMcpResourceUri,
  MCP_RESOURCE_POLL_SOURCE_ID,
} from '@recued/contracts';

// The Add picker mounts inert on the fake document, so its search is read off
// the real `wireRefPicker` call. Pass-through: every export is the real one.
const addPicker = vi.hoisted(() => ({
  searches: [] as Array<(query: string) => Promise<ReadonlyArray<{ id: string }>>>,
}));
vi.mock('@recued/ui-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/ui-shared')>();
  return {
    ...actual,
    RefPicker: {
      ...actual.RefPicker,
      wireRefPicker: (...args: Parameters<typeof actual.RefPicker.wireRefPicker>) => {
        addPicker.searches.push(args[1].search as (typeof addPicker.searches)[number]);
        return actual.RefPicker.wireRefPicker(...args);
      },
    },
  };
});

import {
  AUTOMATION_ROUTE_ADD_ATTR,
  AUTOMATION_ROUTE_ADD_ERROR_ATTR,
  AUTOMATION_ROUTE_ADD_RETRY_ATTR,
  AUTOMATION_ROUTE_EMPTY_ATTR,
  AUTOMATION_ROUTE_ERROR_ATTR,
  AUTOMATION_ROUTE_HOST_ATTR,
  AUTOMATION_ROUTE_ORIGIN_FILTER_ATTR,
  AUTOMATION_ROUTE_POLL_ATTR,
  AUTOMATION_ROUTE_PREAPPROVAL_ATTR,
  AUTOMATION_ROUTE_RETRY_ATTR,
  AUTOMATION_ROUTE_ROW_ATTR,
  AUTOMATION_ROUTE_SECTION_ATTR,
  AUTOMATION_ROUTE_STATUS_FILTER_ATTR,
  AUTOMATION_ROUTE_STYLES_MARKER,
  AUTOMATION_ROUTE_SUBNAV_ATTR,
  AUTOMATION_ROUTE_SECTION_PANEL_ATTR,
  bootstrapAutomationRoute,
  type AutoRunListCaller,
  type AutoRunUpdateCaller,
  type BootstrapAutomationRouteOptions,
  type SchedulesDeleteCaller,
  type SchedulesListCaller,
  type SchedulesUpdateCaller,
  type TriggersDeleteCaller,
  type TriggersListCaller,
  type TriggersUpdateCaller,
  type WatchListCaller,
} from '../automation/bootstrap-automation-route.js';

type Subscribe = NonNullable<BootstrapAutomationRouteOptions['subscribe']>;
type RenderedSection = 'schedule' | 'event_trigger' | 'auto_run';

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
  /** An editor removes itself when it closes. */
  remove(): void;
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
    remove() {
      el.parent?.removeChild(el);
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

/** Drive the route's delegated click handler with a synthetic target
 *  carrying the action + rule-id attributes. */
const clickAction = (host: FakeEl, action: string, ruleId: string): void => {
  const target = {
    closest: (selector: string) =>
      selector.includes('data-recued-automation-action')
        ? {
            getAttribute: (name: string) => {
              if (name === 'data-recued-automation-action') return action;
              if (name === 'data-rule-id') return ruleId;
              return null;
            },
          }
        : null,
  };
  for (const fn of host.listeners.get('click') ?? []) {
    fn({ target } as unknown as Event);
  }
};

const clickSubnav = (
  host: FakeEl,
  token: 'auto-run' | 'triggers' | 'schedules',
): void => {
  const target = {
    closest: (selector: string) =>
      selector.includes(AUTOMATION_ROUTE_SUBNAV_ATTR)
        ? {
            getAttribute: (name: string) =>
              name === AUTOMATION_ROUTE_SUBNAV_ATTR ? token : null,
          }
        : null,
  };
  for (const fn of host.listeners.get('click') ?? []) {
    fn({ target } as unknown as Event);
  }
};

const clickRetry = (
  host: FakeEl,
  token: 'all' | 'auto-run' | 'triggers' | 'schedules' | 'dishes',
): void => {
  const target = {
    closest: (selector: string) =>
      selector.includes(AUTOMATION_ROUTE_RETRY_ATTR)
        ? {
            getAttribute: (name: string) =>
              name === AUTOMATION_ROUTE_RETRY_ATTR ? token : null,
          }
        : null,
  };
  for (const fn of host.listeners.get('click') ?? []) {
    fn({ target } as unknown as Event);
  }
};

const clickAdd = (host: FakeEl, section: 'triggers' | 'schedules' | 'dishes'): void => {
  const target = {
    closest: (selector: string) =>
      selector === `[${AUTOMATION_ROUTE_ADD_ATTR}]`
        ? {
            getAttribute: (name: string) =>
              name === AUTOMATION_ROUTE_ADD_ATTR ? section : null,
          }
        : null,
  };
  for (const fn of host.listeners.get('click') ?? []) {
    fn({ target } as unknown as Event);
  }
};

const clickAddRetry = (
  host: FakeEl,
  section: 'triggers' | 'schedules' | 'dishes',
): void => {
  const target = {
    closest: (selector: string) =>
      selector === `[${AUTOMATION_ROUTE_ADD_RETRY_ATTR}]`
        ? {
            getAttribute: (name: string) =>
              name === AUTOMATION_ROUTE_ADD_RETRY_ATTR ? section : null,
          }
        : null,
  };
  for (const fn of host.listeners.get('click') ?? []) {
    fn({ target } as unknown as Event);
  }
};

const clickBack = (host: FakeEl): void => {
  const target = {
    closest: (selector: string) =>
      selector.includes('data-recued-automation-back') ? {} : null,
  };
  for (const fn of host.listeners.get('click') ?? []) {
    fn({ target } as unknown as Event);
  }
};

const changeSelect = (host: FakeEl, attr: string, value: string): void => {
  const target = {
    value,
    hasAttribute: (name: string) => name === attr,
  };
  for (const fn of host.listeners.get('change') ?? []) {
    fn({ target } as unknown as Event);
  }
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const expectOnlySection = (html: string, active: RenderedSection): void => {
  for (const section of ['schedule', 'event_trigger', 'auto_run'] as const) {
    const marker = `${AUTOMATION_ROUTE_SECTION_ATTR}="${section}"`;
    if (section === active) expect(html).toContain(marker);
    else expect(html).not.toContain(marker);
  }
};

// ── Fixtures ────────────────────────────────────────────────────

const NOW = 1_750_000_000_000;

const schedule = (overrides: Partial<ServerSchedule> = {}): ServerSchedule => ({
  schedule_id: 'sch_1',
  recipe_id: 'daily-brief',
  publisher_id: 'recued-core',
  cron_expression: '0 9 * * *',
  enabled: true,
  created_at: NOW - 10_000,
  last_run_at: NOW - 5_000,
  next_run_at: NOW + 5_000,
  last_status: 'success',
  last_error: null,
  ...overrides,
});

const trigger = (overrides: Partial<EventTrigger> = {}): EventTrigger => ({
  trigger_id: 't-1',
  recipe_id: 'deal-watch',
  publisher_id: 'recued-core',
  pattern: 'data.mail.**',
  enabled: true,
  origin: 'user',
  created_at: NOW - 10_000,
  last_fired_at: NOW - 2_000,
  last_error: null,
  ...overrides,
});

const watchEntry = (
  overrides: Partial<WatchStatusEntry> = {},
): WatchStatusEntry => ({
  watch_key: 'hubspot/deal/main-crm',
  source_id: 'connection-api',
  connection_name: 'main-crm',
  vendor: 'hubspot',
  entity: 'deal',
  enabled: true,
  active: true,
  deferred_to: null,
  effective_interval_ms: 900_000,
  subscriber_recipe_ids: ['deal-watch'],
  last_poll_at: NOW - 60_000,
  last_status: 'ok',
  last_error: null,
  baselined: true,
  consecutive_failures: 0,
  ...overrides,
});

const sourceEntry = (): WatchSourceStatusEntry => ({
  source_key: 'webhook/hubspot/main-crm',
  mechanism: 'webhook',
  label: 'hubspot webhook — main-crm',
  emits: ['data.connection.api.hubspot.deal.main-crm.**'],
  active: true,
  inactive_reason: null,
  last_event_at: NOW - 30_000,
});

const autoRunEntry = (
  overrides: Partial<AutoRunStatusEntry> = {},
): AutoRunStatusEntry => ({
  recipe_id: 'ticker',
  publisher_id: 'recued-core',
  dish_id: null,
  dish_name: null,
  recipe_name: 'Ticker recipe',
  interval_ms: 300_000,
  dynamic: false,
  enabled: true,
  auto_disabled: false,
  consecutive_failures: 0,
  last_failure_at: null,
  last_failure_reason: null,
  next_run_at: NOW + 60_000,
  last_started_at: NOW - 60_000,
  last_finished_at: NOW - 59_000,
  config_overlay: {},
  variables: {},
  ...overrides,
});

const recipeDefinition = (
  recipe_id: string,
  name: string,
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 0,
  metadata: {
    name,
    description: '',
    author: 'recued-core',
    supported_platforms: [],
    tags: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  requires: ['read_memory'],
});

const recipeEntry = (
  recipe_id = 'daily-brief',
  name = 'Daily brief',
): ServerRecipeListEntry => ({
  recipe_id,
  publisher_id: 'recued-core',
  version: 1,
  recipe_hash: `hash-${recipe_id}`,
  recipe: recipeDefinition(recipe_id, name),
  source: 'pair-sync',
  installed_at: 1_700_000_000_000,
});

const mountRoute = (overrides: Partial<BootstrapAutomationRouteOptions> = {}) => {
  const doc = makeFakeDocument();
  const root = makeFakeEl('div');
  const schedulesListCaller =
    overrides.schedulesListCaller
    ?? vi.fn<SchedulesListCaller>(async () => ({ schedules: [schedule()] }));
  const triggersListCaller =
    overrides.triggersListCaller
    ?? vi.fn<TriggersListCaller>(async () => ({ triggers: [trigger()] }));
  const autoRunListCaller =
    overrides.autoRunListCaller
    ?? vi.fn<AutoRunListCaller>(async () => ({ entries: [autoRunEntry()] }));
  const watchListCaller =
    overrides.watchListCaller
    ?? vi.fn<WatchListCaller>(async () => ({ watches: [] }));

  const route = bootstrapAutomationRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    schedulesListCaller,
    triggersListCaller,
    autoRunListCaller,
    watchListCaller,
    now: () => NOW,
    ...overrides,
  });
  const host = root.children[0]!;
  return { doc, root, host, route };
};

// ── Tests ───────────────────────────────────────────────────────

describe('Automation route — rendering', () => {
  it('renders one active tabbed section at a time and keeps count badges updated', async () => {
    const rig = mountRoute({
      triggersListCaller: async () => ({
        triggers: [
          trigger(),
          trigger({ trigger_id: 't-2', recipe_id: 'invoice-watch' }),
        ],
      }),
      recipeNamesCaller: async () => ({
        recipes: [
          { recipe_id: 'daily-brief', name: 'Daily brief' },
          { recipe_id: 'deal-watch', name: 'Deal watch' },
        ],
      }),
    });
    await rig.route.whenLoaded();

    expect(rig.host.attrs.has(AUTOMATION_ROUTE_HOST_ATTR)).toBe(true);
    expect(rig.doc.styleElements[0]?.attrs.has(AUTOMATION_ROUTE_STYLES_MARKER)).toBe(true);
    const routeStyles = (rig.doc.styleElements[0] as unknown as { textContent?: string })
      .textContent ?? '';
    expect(routeStyles).toContain('.automation-filter > .ref-picker');
    expect(routeStyles).toContain('flex-wrap: wrap');
    expect(routeStyles).toContain('min-width: 220px');
    expect(routeStyles).toContain('.automation-row-title a {');
    expect(routeStyles).toContain('.automation-row-actions a {');
    expect(routeStyles).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/s,
    );
    expect(routeStyles).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.automation-row-actions\s*\{[^}]*flex-wrap:\s*wrap/s,
    );
    expect(routeStyles).toMatch(
      /\.automation-subnav-tab\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(routeStyles).toMatch(
      /\.automation-subnav\s*\{[^}]*overflow-x:\s*auto/s,
    );
    expect(routeStyles).toMatch(
      /\.automation-subnav-tab\s*\{[^}]*flex:\s*0 0 auto[^}]*white-space:\s*nowrap/s,
    );
    expect(routeStyles).toMatch(
      /\.automation-row-meta > \*\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(routeStyles).toMatch(
      /\.automation-detail-facts\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\)/s,
    );
    expect(routeStyles).toMatch(
      /@media \(max-width: 360px\)[\s\S]*?\.automation-detail-facts\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s,
    );
    expect(routeStyles).toMatch(
      /\.automation-detail-facts dd\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(routeStyles).toMatch(
      /\.automation-add-picker\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*max-width:\s*360px/s,
    );
    expect(routeStyles).toMatch(
      /\.automation-load-error > span\s*\{[^}]*flex:\s*1 1 180px[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(routeStyles).toMatch(
      /\.automation-poll > span\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(routeStyles).toMatch(
      /\.automation-poll > button\s*\{[^}]*flex:\s*0 0 auto/s,
    );
    expect(routeStyles).toMatch(
      new RegExp(`\\[${AUTOMATION_ROUTE_ERROR_ATTR}\\][\\s\\S]*?overflow-wrap:\\s*anywhere`),
    );
    expect(routeStyles).toContain(`[${AUTOMATION_ROUTE_HOST_ATTR}] a {`);
    expect(routeStyles).toContain('min-width: 36px');
    expect(routeStyles).toContain('min-height: 36px');
    expect(rig.host.innerHTML).toContain(
      '<a href="#logs">Logs<span aria-hidden="true">.</span></a>',
    );
    expect(rig.host.innerHTML).not.toContain('Logs</a>.');
    // D-319 §5.4 — the page is one list, grouped by recipe; its nav is the
    // two views. The lists by kind stay reachable (a rule's Details, links).
    expect(rig.route.getActiveSection()).toBe('all');
    expect(rig.host.innerHTML).toMatch(
      /data-recued-automation-subnav="all"[\s\S]*?aria-selected="true"[\s\S]*?tabindex="0"/,
    );
    expect(rig.host.innerHTML).toMatch(
      /data-recued-automation-subnav="coming-up"[\s\S]*?aria-selected="false"[\s\S]*?tabindex="-1"/,
    );
    expect(rig.host.innerHTML).toContain(
      'aria-controls="recued-automation-section-panel"',
    );
    expect(rig.host.innerHTML).toMatch(
      new RegExp(
        `${AUTOMATION_ROUTE_SECTION_PANEL_ATTR}[\\s\\S]*?role="tabpanel"`
          + '[\\s\\S]*?aria-labelledby="recued-automation-section-tab-all"',
      ),
    );
    for (const token of ['auto-run', 'triggers', 'schedules', 'dishes']) {
      expect(rig.host.innerHTML).not.toContain(`data-recued-automation-subnav="${token}"`);
    }
    // Every recipe with automation is a group; rows made before D-319 (no
    // dish) sit under their recipe; a recipe on a timer nobody switched on
    // says so.
    expect(rig.host.innerHTML).toContain('data-recued-automation-recipe="daily-brief"');
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="schedule:sch_1"`);
    expect(rig.host.innerHTML).toContain('Not switched on. It runs every 5 minutes.');
    expect(rig.host.innerHTML).toContain('By recipe <span class="automation-subnav-count">1</span>');

    clickSubnav(rig.host, 'auto-run');
    expect(rig.route.getActiveSection()).toBe('auto-run');
    expectOnlySection(rig.host.innerHTML, 'auto_run');
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="auto_run:ticker"`);
    expect(rig.host.innerHTML).not.toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="schedule:sch_1"`);
    // Another list by kind leaves the nav reachable by keyboard.
    expect(rig.host.innerHTML).toMatch(
      /data-recued-automation-subnav="all"[\s\S]*?aria-selected="false"[\s\S]*?tabindex="0"/,
    );

    clickSubnav(rig.host, 'triggers');
    expect(rig.route.getActiveSection()).toBe('triggers');
    expectOnlySection(rig.host.innerHTML, 'event_trigger');
    expect(rig.host.innerHTML).toContain('Deal watch');
    expect(rig.host.innerHTML).toContain('data.mail.**');
    expect(rig.host.innerHTML).not.toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="auto_run:ticker"`);

    clickSubnav(rig.host, 'schedules');
    expect(rig.route.getActiveSection()).toBe('schedules');
    expectOnlySection(rig.host.innerHTML, 'schedule');
    expect(rig.host.innerHTML).toContain('Daily at 9:00 AM');
    expect(rig.host.innerHTML).toContain('Daily brief');
    expect(rig.host.innerHTML).toContain(
      'aria-label="Pause Daily brief (sch_1)"',
    );
    expect(rig.host.innerHTML).toContain(
      'aria-label="Details Daily brief (sch_1)"',
    );
  });

  it('honors the initialSection option', async () => {
    const rig = mountRoute({ initialSection: 'schedules' });
    await rig.route.whenLoaded();

    expect(rig.route.getActiveSection()).toBe('schedules');
    expectOnlySection(rig.host.innerHTML, 'schedule');
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="schedule:sch_1"`);
  });

  it('renders a one-shot as one instant, never as its compatibility cron', async () => {
    const rig = mountRoute({
      initialSection: 'schedules',
      schedulesListCaller: async () => ({
        schedules: [schedule({
          mode: 'one_shot',
          run_at: NOW + 60_000,
          cron_expression: '17 4 9 12 *',
        })],
      }),
    });
    await rig.route.whenLoaded();

    expect(rig.host.innerHTML).toContain('Once —');
    expect(rig.host.innerHTML).not.toContain('17 4 9 12 *');

    clickAction(rig.host, 'detail:schedule', 'sch_1');
    expect(rig.host.innerHTML).toContain('Once —');
    expect(rig.host.innerHTML).not.toContain('17 4 9 12 *');
  });

  it('labels disarmed and tripped states distinctly inside their active tabs', async () => {
    const rig = mountRoute({
      initialSection: 'auto-run',
      schedulesListCaller: async () => ({
        schedules: [schedule({ enabled: false })],
      }),
      triggersListCaller: async () => ({
        triggers: [trigger({ enabled: false, last_error: 'errors_24h=10' })],
      }),
      autoRunListCaller: async () => ({
        entries: [
          autoRunEntry({
            auto_disabled: true,
            consecutive_failures: 5,
            last_failure_reason: 'boom',
          }),
        ],
      }),
    });
    await rig.route.whenLoaded();

    expect(rig.host.innerHTML).toContain('Tripped (5 failures)');
    expect(rig.host.innerHTML).toContain('Re-arm');
    expect(rig.host.innerHTML).toContain('data-armed="tripped"');

    clickSubnav(rig.host, 'schedules');
    expect(rig.host.innerHTML).toContain('Paused');

    clickSubnav(rig.host, 'triggers');
    expect(rig.host.innerHTML).toContain('Auto-disabled');
    expect(rig.host.innerHTML).toContain('errors_24h=10');
  });

  it('D-268 — a schedule the SERVER stopped reads differently from one the owner paused', async () => {
    // ⛔ THE TWO RENDERED IDENTICALLY, AND THE ONE NEEDING ACTION WAS THE ONE
    // THAT LOOKED HANDLED. The test directly above pins the owner-paused row as
    // "Paused" and must keep passing — the whole point is that these two states
    // stop sharing a label. An owner arm/disarm clears `consecutive_failures`
    // in both directions, so a non-zero counter on a disabled row is only ever
    // the server's doing.
    const rig = mountRoute({
      schedulesListCaller: async () => ({
        schedules: [schedule({
          enabled: false,
          consecutive_failures: 5,
          last_status: 'error',
          last_error: 'A token refresh failed.',
        })],
      }),
    });
    await rig.route.whenLoaded();
    clickSubnav(rig.host, 'schedules');

    expect(rig.host.innerHTML).toContain('data-armed="tripped"');
    expect(rig.host.innerHTML).toContain('Auto-disabled');
    expect(rig.host.innerHTML).toContain('A token refresh failed.');
  });

  it('D-268 — a disabled schedule with no failures is still just Paused', async () => {
    // The negative half, with its cause named: it reads "Paused" BECAUSE the
    // counter is zero, not because the row happens to lack a field.
    const rig = mountRoute({
      schedulesListCaller: async () => ({
        schedules: [schedule({ enabled: false, consecutive_failures: 0 })],
      }),
    });
    await rig.route.whenLoaded();
    clickSubnav(rig.host, 'schedules');
    expect(rig.host.innerHTML).toContain('Paused');
    expect(rig.host.innerHTML).not.toContain('data-armed="tripped"');
  });

  it('degrades per section: one failing caller shows that tab error while others render', async () => {
    const rig = mountRoute({
      initialSection: 'auto-run',
      triggersListCaller: async () => {
        throw new Error('trigger backend down');
      },
    });
    await rig.route.whenLoaded();

    expect(rig.route.getLoadErrors()).toEqual({ triggers: 'trigger backend down' });
    expectOnlySection(rig.host.innerHTML, 'auto_run');
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="auto_run:ticker"`);

    clickSubnav(rig.host, 'triggers');
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ERROR_ATTR}="event_trigger"`);
    expect(rig.host.innerHTML).toContain('role="alert"');
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_RETRY_ATTR}="triggers"`);
    expect(rig.host.innerHTML).toContain('trigger backend down');

    clickSubnav(rig.host, 'schedules');
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="schedule:sch_1"`);
  });

  it('keeps an explicit section load Retry single-flight and recoverable', async () => {
    const retry = deferred<{ schedules: ServerSchedule[] }>();
    const schedulesListCaller = vi.fn<SchedulesListCaller>()
      .mockRejectedValueOnce(new Error('schedule backend down'))
      .mockImplementationOnce(() => retry.promise);
    const rig = mountRoute({ schedulesListCaller });
    await rig.route.whenLoaded();

    clickSubnav(rig.host, 'schedules');
    expect(rig.host.innerHTML).toContain('role="alert"');
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_RETRY_ATTR}="schedules"`);
    expect(rig.host.innerHTML).toContain('Retry');

    clickRetry(rig.host, 'schedules');
    clickRetry(rig.host, 'schedules');
    expect(schedulesListCaller).toHaveBeenCalledTimes(2);
    expect(rig.host.innerHTML).toContain('role="status"');
    expect(rig.host.innerHTML).toContain('aria-disabled="true" aria-busy="true"');
    expect(rig.host.innerHTML).toContain('Retrying…');

    retry.resolve({ schedules: [schedule()] });
    await flush();
    expect(rig.host.innerHTML).not.toContain(AUTOMATION_ROUTE_ERROR_ATTR);
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="schedule:sch_1"`);
  });

  it('a missing caller renders the not-wired note for the active section only', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeEl('div');
    const route = bootstrapAutomationRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      schedulesListCaller: async () => ({ schedules: [] }),
      triggersListCaller: async () => ({ triggers: [] }),
      watchListCaller: async () => ({ watches: [] }),
      // autoRunListCaller deliberately absent.
      initialSection: 'auto-run',
    });
    await route.whenLoaded();

    expect(route.getLoadErrors().auto_run).toContain('Recued cannot list');
    const host = root.children[0]!;
    expect(host.innerHTML).toContain(`${AUTOMATION_ROUTE_ERROR_ATTR}="auto_run"`);
    expect(host.innerHTML).not.toContain(`${AUTOMATION_ROUTE_EMPTY_ATTR}="schedule"`);

    clickSubnav(host, 'schedules');
    expect(host.innerHTML).toContain(`${AUTOMATION_ROUTE_EMPTY_ATTR}="schedule"`);
    route.dispose();
  });
});

describe('Automation route — hash and tab state', () => {
  it('syncs the serialized hash after tab and detail changes when replaceState exists', async () => {
    type HistoryLike = {
      replaceState: (data: unknown, title: string, url: string) => void;
    };
    const globalWithHistory = globalThis as unknown as { history?: HistoryLike };
    const previousHistory = globalWithHistory.history;
    const replaceState = vi.fn<HistoryLike['replaceState']>();
    const onHashSync = vi.fn<(hash: string) => void>();
    globalWithHistory.history = { replaceState };

    try {
      const rig = mountRoute({ onHashSync });
      await rig.route.whenLoaded();

      clickSubnav(rig.host, 'triggers');
      expect(replaceState).toHaveBeenLastCalledWith(null, '', '#automation/triggers');
      expect(onHashSync).toHaveBeenLastCalledWith('#automation/triggers');

      clickAction(rig.host, 'detail:event_trigger', 't-1');
      expect(rig.route.getDetailId()).toBe('t-1');
      expect(replaceState).toHaveBeenLastCalledWith(null, '', '#automation/triggers/t-1');
      expect(onHashSync).toHaveBeenLastCalledWith('#automation/triggers/t-1');
    } finally {
      if (previousHistory === undefined) delete globalWithHistory.history;
      else globalWithHistory.history = previousHistory;
    }
  });

  it('pushes section-to-detail navigation while section changes replace', async () => {
    type HistoryLike = {
      replaceState: (data: unknown, title: string, url: string) => void;
      pushState: (data: unknown, title: string, url: string) => void;
    };
    const globalWithHistory = globalThis as unknown as { history?: HistoryLike };
    const previousHistory = globalWithHistory.history;
    const calls: string[] = [];
    globalWithHistory.history = {
      replaceState: (_data, _title, url) => { calls.push(`replace ${url}`); },
      pushState: (_data, _title, url) => { calls.push(`push ${url}`); },
    };

    try {
      const rig = mountRoute();
      await rig.route.whenLoaded();

      clickSubnav(rig.host, 'triggers');
      clickAction(rig.host, 'detail:event_trigger', 't-1');

      expect(calls).toEqual([
        'replace #automation/triggers',
        'push #automation/triggers/t-1',
      ]);
      rig.route.dispose();
    } finally {
      if (previousHistory === undefined) delete globalWithHistory.history;
      else globalWithHistory.history = previousHistory;
    }
  });

  it('D-319 — a recipe link lands on the one list, narrowed to the recipe: its schedule is there', async () => {
    const rig = mountRoute({
      initialRecipeFilter: 'schedule-only',
      schedulesListCaller: async () => ({
        schedules: [schedule({ recipe_id: 'schedule-only' })],
      }),
      triggersListCaller: async () => ({ triggers: [] }),
      autoRunListCaller: async () => ({ entries: [] }),
    });
    await rig.route.whenLoaded();

    expect(rig.route.getRecipeFilter()).toBe('schedule-only');
    expect(rig.route.getActiveSection()).toBe('all');
    expect(rig.host.innerHTML).toContain('data-recued-automation-recipe="schedule-only"');
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="schedule:sch_1"`);
  });

  it('legacy recipe auto-pick is cancelled when the user clicks a tab before load completes', async () => {
    const schedulesLoad = deferred<{ schedules: ServerSchedule[] }>();
    const rig = mountRoute({
      initialRecipeFilter: 'schedule-only',
      schedulesListCaller: vi.fn<SchedulesListCaller>(() => schedulesLoad.promise),
      triggersListCaller: async () => ({ triggers: [] }),
      autoRunListCaller: async () => ({ entries: [] }),
    });

    clickSubnav(rig.host, 'triggers');
    expect(rig.route.getActiveSection()).toBe('triggers');
    schedulesLoad.resolve({
      schedules: [schedule({ recipe_id: 'schedule-only' })],
    });
    await rig.route.whenLoaded();

    expect(rig.route.getActiveSection()).toBe('triggers');
    expectOnlySection(rig.host.innerHTML, 'event_trigger');
    expect(rig.host.innerHTML).toContain('Nothing sets this Recipe off.');
  });
});

describe('Automation route — filters', () => {
  it('filters auto-run rows by tripped and armed status', async () => {
    const rig = mountRoute({
      initialSection: 'auto-run',
      autoRunListCaller: async () => ({
        entries: [
          autoRunEntry({
            auto_disabled: true,
            consecutive_failures: 2,
            last_failure_reason: 'circuit open',
          }),
        ],
      }),
    });
    await rig.route.whenLoaded();

    changeSelect(rig.host, AUTOMATION_ROUTE_STATUS_FILTER_ATTR, 'tripped');
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="auto_run:ticker"`);
    expect(rig.host.innerHTML).toContain('circuit open');

    changeSelect(rig.host, AUTOMATION_ROUTE_STATUS_FILTER_ATTR, 'on');
    expect(rig.host.innerHTML).not.toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="auto_run:ticker"`);
    expect(rig.host.innerHTML).toContain('You have no Recipes that run on their own.');
  });

  it('filters trigger rows by origin', async () => {
    const rig = mountRoute({
      initialSection: 'triggers',
      triggersListCaller: async () => ({
        triggers: [
          trigger({
            trigger_id: 't-recipe',
            origin: 'recipe',
            recipe_id: 'recipe-owned',
          }),
        ],
      }),
    });
    await rig.route.whenLoaded();

    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="event_trigger:t-recipe"`);
    expect(rig.host.innerHTML).toContain('from recipe');

    changeSelect(rig.host, AUTOMATION_ROUTE_ORIGIN_FILTER_ATTR, 'user');
    expect(rig.host.innerHTML).not.toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="event_trigger:t-recipe"`);
    expect(rig.host.innerHTML).toContain('Nothing sets a Recipe off yet.');
  });

  it('does not let a filtered-out paused trigger claim its tripped backing watch', async () => {
    const rig = mountRoute({
      initialSection: 'triggers',
      triggersListCaller: async () => ({
        triggers: [
          trigger({
            trigger_id: 't-paused',
            recipe_id: 'deal-watch',
            pattern: 'data.hubspot.deal.**',
            enabled: false,
            last_error: null,
          }),
        ],
      }),
      watchListCaller: vi.fn<WatchListCaller>(async () => ({
        watches: [
          watchEntry({
            watch_key: 'hubspot/deal/main-crm',
            subscriber_recipe_ids: ['deal-watch'],
            enabled: false,
            active: false,
            consecutive_failures: 3,
            last_status: 'error',
            last_error: 'poll failed',
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    changeSelect(rig.host, AUTOMATION_ROUTE_STATUS_FILTER_ATTR, 'tripped');
    expect(rig.host.innerHTML).not.toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="event_trigger:t-paused"`);
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="watch:hubspot/deal/main-crm"`);
    expect(rig.host.innerHTML).toContain('Tripped (3 failures)');
    expect(rig.host.innerHTML).toContain('poll failed');
  });
});

describe('Automation route — D-319: one auto-run timer per dish', () => {
  const dishRow = (over: Partial<Dish> = {}): Dish => ({
    dish_id: 'dsh_work',
    recipe_id: 'ticker',
    publisher_id: 'recued-core',
    name: '',
    is_default: true,
    config_overlay: {},
    enabled: true,
    created_at: 1,
    ...over,
  });

  it('two dishes of one recipe are two timers: each row is its dish, and its switch names it', async () => {
    const autoRunUpdateCaller = vi.fn<AutoRunUpdateCaller>(async (args) => ({
      entry: autoRunEntry({ dish_id: args.dish_id ?? null, enabled: args.enabled ?? true }),
    }));
    const rig = mountRoute({
      initialSection: 'auto-run',
      autoRunListCaller: async () => ({
        entries: [
          autoRunEntry({ dish_id: 'dsh_work', dish_name: '', variables: { topic: 'news' } }),
          autoRunEntry({ dish_id: 'dsh_home', dish_name: 'Home', enabled: false, variables: { topic: 'news' } }),
        ],
      }),
      autoRunUpdateCaller,
    });
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="auto_run:dsh_work"`);
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="auto_run:dsh_home"`);
    expect(rig.host.innerHTML).toContain('Ticker recipe — Home');

    // A dish's timer switches alone: its settings are the dish's, so no form.
    clickAction(rig.host, 'toggle:auto_run:on', 'dsh_home');
    await flush();
    expect(autoRunUpdateCaller).toHaveBeenLastCalledWith({ dish_id: 'dsh_home', enabled: true });
    clickAction(rig.host, 'toggle:auto_run:off', 'dsh_work');
    await flush();
    expect(autoRunUpdateCaller).toHaveBeenLastCalledWith({ dish_id: 'dsh_work', enabled: false });
  });

  it('Configure on a dish’s timer opens the DISH’s settings and saves them to the dish, never to the timer', async () => {
    const dishesUpdateCaller = vi.fn(async (args: { dish_id: string; config_overlay?: Record<string, unknown> }) => ({
      dish: dishRow({ config_overlay: args.config_overlay ?? {} }),
    }));
    const autoRunUpdateCaller = vi.fn<AutoRunUpdateCaller>();
    const withTopic = recipeEntry('ticker', 'Ticker recipe');
    withTopic.recipe.variables = { topic: { label: 'Topic', type: 'text', default: 'news' } } as never;
    const rig = mountRoute({
      initialSection: 'auto-run',
      autoRunListCaller: async () => ({
        entries: [autoRunEntry({ dish_id: 'dsh_work', dish_name: '', variables: withTopic.recipe.variables ?? {} })],
      }),
      dishesListCaller: async () => ({ dishes: [dishRow({ config_overlay: { topic: 'sports' } })] }),
      dishesUpdateCaller: dishesUpdateCaller as never,
      recipeEntriesCaller: async () => ({ recipes: [withTopic] }),
      autoRunUpdateCaller,
    });
    await rig.route.whenLoaded();
    await flush();
    await flush();
    const before = rig.doc.body.children.length;

    clickAction(rig.host, 'configure:auto_run', 'dsh_work');

    const editor = rig.doc.body.children[before];
    expect(editor, 'the dish’s settings editor opened').toBeDefined();
    expect(editor!.innerHTML).toContain('sports');
    for (const fn of editor!.listeners.get('click') ?? []) {
      fn({ target: { closest: () => ({ getAttribute: () => 'confirm' }) } } as unknown as Event);
    }
    await flush();
    expect(dishesUpdateCaller).toHaveBeenCalledWith({ dish_id: 'dsh_work', config_overlay: { topic: 'sports' } });
    expect(autoRunUpdateCaller).not.toHaveBeenCalled();
  });

  it('a dish’s Settings offer its mail template — the template is the dish’s (§3.7), not the recipe’s alone', async () => {
    const withTemplate = recipeEntry('ticker', 'Ticker recipe');
    withTemplate.recipe.variables = {
      template: { label: 'Mail template', type: 'mail_template' },
      topic: { label: 'Topic', type: 'text', default: 'news' },
    } as never;
    const rig = mountRoute({
      initialSection: 'auto-run',
      autoRunListCaller: async () => ({
        entries: [autoRunEntry({ dish_id: 'dsh_work', dish_name: '', variables: withTemplate.recipe.variables ?? {} })],
      }),
      dishesListCaller: async () => ({ dishes: [dishRow({ config_overlay: { template: 'mtpl_a' } })] }),
      dishesUpdateCaller: vi.fn(async () => ({ dish: dishRow() })) as never,
      recipeEntriesCaller: async () => ({ recipes: [withTemplate] }),
    });
    await rig.route.whenLoaded();
    await flush();
    await flush();
    const before = rig.doc.body.children.length;

    clickAction(rig.host, 'configure:auto_run', 'dsh_work');

    const editor = rig.doc.body.children[before];
    expect(editor).toBeDefined();
    expect(editor!.innerHTML).toContain('data-var-key="template"');
    expect(editor!.innerHTML).toContain('data-var-key="topic"');
  });

  it('a recipe nobody switched on has no next run to look at: a forged click opens nothing', async () => {
    const preapprovalPrepareCaller = vi.fn();
    const rig = mountRoute({
      initialSection: 'auto-run',
      autoRunListCaller: async () => ({
        entries: [autoRunEntry({ dish_id: null, enabled: false, lifecycle_revision: 1 })],
      }),
      preapprovalPrepareCaller: preapprovalPrepareCaller as never,
      onPreapprovalPrepared: () => {},
    });
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).not.toContain('preapprove:auto_run');
    const before = rig.doc.body.children.length;

    expect(() => clickAction(rig.host, 'preapprove:auto_run', 'ticker')).not.toThrow();

    expect(rig.doc.body.children.length).toBe(before);
    expect(preapprovalPrepareCaller).not.toHaveBeenCalled();
  });
});

describe('Automation route — D-319 §5.4: one list, by recipe then dish', () => {
  const dishOf = (over: Partial<Dish> = {}): Dish => ({
    dish_id: 'dsh_work',
    recipe_id: 'parcels',
    publisher_id: 'recued-core',
    name: '',
    is_default: true,
    config_overlay: {},
    enabled: true,
    created_at: 1,
    ...over,
  });

  const clickChip = (host: FakeEl, chip: string): void => {
    const target = {
      closest: (selector: string) =>
        selector.includes('data-recued-automation-chip')
          ? { getAttribute: (name: string) => (name === 'data-recued-automation-chip' ? chip : null) }
          : null,
    };
    for (const fn of host.listeners.get('click') ?? []) fn({ target } as unknown as Event);
  };

  /** Confirm an open settings form. */
  const confirmForm = (form: FakeEl): void => {
    for (const fn of form.listeners.get('click') ?? []) {
      fn({ target: { closest: () => ({ getAttribute: () => 'confirm' }) } } as unknown as Event);
    }
  };

  /** One dish's line: from its marker to the next line or its group's end. */
  const lineOf = (html: string, dish_id: string): string => {
    const start = html.indexOf(`data-recued-automation-dish="${dish_id}"`);
    expect(start, `the line of ${dish_id}`).toBeGreaterThanOrEqual(0);
    const ends = [
      html.indexOf('data-recued-automation-dish="', start + 1),
      html.indexOf('</section>', start),
    ].filter((at) => at >= 0);
    return html.slice(start, Math.min(...ends));
  };

  /** The page names recipes from its names read, as the app wires it. */
  const recipeNamesCaller = async () => ({
    recipes: [
      { recipe_id: 'parcels', name: 'Shop parcels watch' },
      { recipe_id: 'invoices', name: 'Invoice intake' },
      { recipe_id: 'ticker', name: 'Ticker recipe' },
    ],
  });

  const chipCount = (html: string, chip: string, label: string, count: number): void => {
    expect(html).toMatch(new RegExp(
      `data-recued-automation-chip="${chip}"[^>]*>${label} <span class="automation-chip-count">${count}</span>`,
    ));
  };

  it('groups by recipe, then by dish: each dish its line, its rows under it', async () => {
    const rig = mountRoute({
      dishesListCaller: async () => ({
        dishes: [
          dishOf({ dish_id: 'dsh_home', name: 'Home mailbox', is_default: false, enabled: false, created_at: 2 }),
          // Made the main one after Home was made: the main one still leads.
          dishOf({ dish_id: 'dsh_work', name: 'Work mailbox', created_at: 3 }),
          dishOf({ dish_id: 'dsh_inv', recipe_id: 'invoices' }),
        ],
      }),
      recipeEntriesCaller: async () => ({
        recipes: [recipeEntry('parcels', 'Shop parcels watch'), recipeEntry('invoices', 'Invoice intake')],
      }),
      recipeNamesCaller,
      schedulesListCaller: async () => ({
        schedules: [
          schedule({ schedule_id: 'sch_work', recipe_id: 'parcels', dish_id: 'dsh_work' }),
          schedule({ schedule_id: 'sch_inv', recipe_id: 'invoices', dish_id: 'dsh_inv' }),
        ],
      }),
      triggersListCaller: async () => ({
        triggers: [trigger({ trigger_id: 't-home', recipe_id: 'parcels', dish_id: 'dsh_home', enabled: false })],
      }),
      autoRunListCaller: async () => ({ entries: [] }),
    });
    await rig.route.whenLoaded();
    await flush();
    const html = rig.host.innerHTML;

    // Recipes by name; within one, the main dish first.
    expect(html.indexOf('data-recued-automation-recipe="invoices"'))
      .toBeLessThan(html.indexOf('data-recued-automation-recipe="parcels"'));
    expect(html.indexOf('data-recued-automation-dish="dsh_work"'))
      .toBeLessThan(html.indexOf('data-recued-automation-dish="dsh_home"'));
    expect(html).toContain('Shop parcels watch</a> <span class="automation-recipe-summary">· 1 on · 1 off</span>');

    const work = lineOf(html, 'dsh_work');
    expect(work).toContain('<span class="automation-dish-name">Work mailbox</span>');
    expect(work).toContain('<span class="automation-dish-main">Main</span>');
    expect(work).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="schedule:sch_work"`);
    expect(work).not.toContain('event_trigger:t-home');
    expect(lineOf(html, 'dsh_home')).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="event_trigger:t-home"`);
    // A recipe's only dish has no name to invent: its dot (and switch) say On.
    const invoices = lineOf(html, 'dsh_inv');
    expect(invoices).not.toContain('automation-dish-name');
    expect(invoices).toContain('automation-dish-dot--on');
    expect(invoices).not.toContain('automation-dish-main');
    expect(html).toContain('>Invoice intake</a></h3>');
  });

  it('a dish’s switch on the list is the dish’s own: it writes the dish', async () => {
    const dishesUpdateCaller = vi.fn(async (args: { dish_id: string; enabled?: boolean }) => ({
      dish: dishOf({ enabled: args.enabled ?? true }),
    }));
    const rig = mountRoute({
      dishesListCaller: async () => ({ dishes: [dishOf()] }),
      dishesUpdateCaller: dishesUpdateCaller as never,
      recipeEntriesCaller: async () => ({ recipes: [recipeEntry('parcels', 'Shop parcels watch')] }),
      recipeNamesCaller,
      autoRunListCaller: async () => ({ entries: [] }),
    });
    await rig.route.whenLoaded();
    await flush();
    const line = lineOf(rig.host.innerHTML, 'dsh_work');
    expect(line).toMatch(
      /toggle:dish:off"\s+data-rule-id="dsh_work" role="switch" aria-checked="true" aria-label="Shop parcels watch">On</,
    );
    // Its only dish has no name to invent; the switch says On.
    expect(line).not.toContain('automation-dish-name');

    clickAction(rig.host, 'toggle:dish:off', 'dsh_work');
    await flush();
    expect(dishesUpdateCaller).toHaveBeenCalledWith({ dish_id: 'dsh_work', enabled: false });
  });

  it('a dish the server stopped a row of offers Start again: switching it on again restarts it', async () => {
    const dishesUpdateCaller = vi.fn(async (args: { dish_id: string; enabled?: boolean }) => ({
      dish: dishOf({ enabled: args.enabled ?? true }),
    }));
    const rig = mountRoute({
      dishesListCaller: async () => ({ dishes: [dishOf(), dishOf({ dish_id: 'dsh_bad', name: 'Home', is_default: false, created_at: 2 })] }),
      dishesUpdateCaller: dishesUpdateCaller as never,
      triggersListCaller: async () => ({
        triggers: [
          // Off with an error: the server stopped it.
          trigger({ trigger_id: 't-stopped', recipe_id: 'parcels', dish_id: 'dsh_work', enabled: false, last_error: 'Slack refused' }),
          // On with an error: its last fire failed, nothing is stopped.
          trigger({ trigger_id: 't-failed', recipe_id: 'parcels', dish_id: 'dsh_bad', last_error: 'Slack refused' }),
        ],
      }),
      schedulesListCaller: async () => ({ schedules: [] }),
      autoRunListCaller: async () => ({ entries: [] }),
    });
    await rig.route.whenLoaded();
    await flush();
    expect(lineOf(rig.host.innerHTML, 'dsh_work')).toMatch(
      /<p class="automation-dish-reason">Slack refused <button[^>]*"toggle:dish:on"\s+data-rule-id="dsh_work" aria-label="Start Main again">Start again<\/button>/,
    );
    expect(lineOf(rig.host.innerHTML, 'dsh_bad')).not.toContain('Start again');

    clickAction(rig.host, 'toggle:dish:on', 'dsh_work');
    await flush();
    expect(dishesUpdateCaller).toHaveBeenCalledWith({ dish_id: 'dsh_work', enabled: true });
  });

  it('filters: On, Off, Needs you, Failing — each line answers to one; a second press clears', async () => {
    const rig = mountRoute({
      dishesListCaller: async () => ({
        dishes: [
          dishOf({ dish_id: 'dsh_ok', recipe_id: 'a' }),
          dishOf({ dish_id: 'dsh_off', recipe_id: 'b', enabled: false }),
          dishOf({ dish_id: 'dsh_bad', recipe_id: 'c' }),
          dishOf({ dish_id: 'dsh_wait', recipe_id: 'd' }),
        ],
        last_runs: { dsh_wait: { run_id: 'r1', started_at: NOW - 1_000, commit_status: 'awaiting_approval' } },
      }),
      triggersListCaller: async () => ({
        triggers: [trigger({ trigger_id: 't-bad', recipe_id: 'c', dish_id: 'dsh_bad', last_error: 'Slack refused the connection' })],
      }),
      schedulesListCaller: async () => ({ schedules: [] }),
      // A recipe on a timer that nobody switched on: it counts as Off.
      autoRunListCaller: async () => ({ entries: [autoRunEntry({ recipe_id: 'e', dish_id: null, enabled: false })] }),
    });
    await rig.route.whenLoaded();
    await flush();
    let html = rig.host.innerHTML;
    chipCount(html, 'on', 'On', 1);
    chipCount(html, 'off', 'Off', 2);
    chipCount(html, 'needs-you', 'Needs you', 1);
    chipCount(html, 'failing', 'Failing', 1);
    expect(lineOf(html, 'dsh_bad')).toContain('<p class="automation-dish-reason">Slack refused the connection</p>');
    expect(lineOf(html, 'dsh_wait')).toContain('automation-dish-status--needs-you">Needs you</span>');

    clickChip(rig.host, 'failing');
    html = rig.host.innerHTML;
    expect(html).toMatch(/data-recued-automation-chip="failing"\s+aria-pressed="true"/);
    expect(html).toContain('data-recued-automation-dish="dsh_bad"');
    for (const other of ['dsh_ok', 'dsh_off', 'dsh_wait']) {
      expect(html).not.toContain(`data-recued-automation-dish="${other}"`);
    }
    expect(html).not.toContain('Not switched on');

    clickChip(rig.host, 'off');
    html = rig.host.innerHTML;
    expect(html).toContain('data-recued-automation-dish="dsh_off"');
    expect(html).toContain('Not switched on');
    expect(html).not.toContain('data-recued-automation-dish="dsh_bad"');

    clickChip(rig.host, 'off');
    html = rig.host.innerHTML;
    for (const every of ['dsh_ok', 'dsh_off', 'dsh_bad', 'dsh_wait']) {
      expect(html).toContain(`data-recued-automation-dish="${every}"`);
    }
  });

  it('a recipe that starts on its own and has no dish says so; Switch on asks its settings, from what the install chose', async () => {
    const ticker = recipeEntry('ticker', 'Ticker recipe');
    ticker.recipe.auto_run = { interval_ms: 300_000 };
    ticker.recipe.variables = { topic: { label: 'Topic', type: 'text', default: 'news' } } as never;
    const dishesDefaultsCaller = vi.fn(async () => ({ config_overlay: { topic: 'install-pick' } }));
    const dishesCreateCaller = vi.fn(async (args: { recipe_id: string; config_overlay?: Record<string, unknown> }) => ({
      dish: dishOf({ recipe_id: args.recipe_id, config_overlay: args.config_overlay ?? {} }),
    }));
    const dishesListCaller = vi.fn(async () => ({ dishes: [] as Dish[] }));
    const rig = mountRoute({
      autoRunListCaller: async () => ({ entries: [] }),
      schedulesListCaller: async () => ({ schedules: [] }),
      triggersListCaller: async () => ({ triggers: [] }),
      dishesListCaller,
      dishesCreateCaller: dishesCreateCaller as never,
      dishesDefaultsCaller,
      recipeEntriesCaller: async () => ({ recipes: [ticker] }),
    });
    await rig.route.whenLoaded();
    await flush();
    await flush();
    expect(rig.host.innerHTML).toContain('data-recued-automation-recipe="ticker"');
    expect(rig.host.innerHTML).toContain('Not switched on. It runs every 5 minutes.');
    expect(rig.host.innerHTML).toMatch(/switch-on:recipe"\s+data-rule-id="ticker"[^>]*>Switch on</);

    const before = rig.doc.body.children.length;
    clickAction(rig.host, 'switch-on:recipe', 'ticker');
    await flush();
    await flush();
    expect(dishesDefaultsCaller).toHaveBeenCalledWith({ recipe_id: 'ticker' });
    const form = rig.doc.body.children[before];
    expect(form, 'the switch-on form opened').toBeDefined();
    expect(form!.innerHTML).toContain('Switch on “Ticker recipe”');
    expect(form!.innerHTML).toContain('install-pick');

    const reads = dishesListCaller.mock.calls.length;
    confirmForm(form!);
    await flush();
    await flush();
    expect(dishesCreateCaller).toHaveBeenCalledWith({
      recipe_id: 'ticker',
      publisher_id: 'recued-core',
      config_overlay: { topic: 'install-pick' },
    });
    expect(dishesListCaller.mock.calls.length, 'the list re-read').toBeGreaterThan(reads);
  });

  it('a recipe the server only ships is not offered to switch on — its timer would never run', async () => {
    const shipped = recipeEntry('today', 'Today');
    shipped.source = 'bundled';
    shipped.recipe.auto_run = { interval_ms: 300_000 };
    const ticker = recipeEntry('ticker', 'Ticker recipe');
    ticker.recipe.auto_run = { interval_ms: 300_000 };
    const dishesCreateCaller = vi.fn(async () => ({ dish: dishOf() }));
    const dishesDefaultsCaller = vi.fn(async () => ({ config_overlay: {} }));
    const rig = mountRoute({
      autoRunListCaller: async () => ({ entries: [] }),
      schedulesListCaller: async () => ({ schedules: [] }),
      triggersListCaller: async () => ({ triggers: [] }),
      dishesListCaller: async () => ({ dishes: [] }),
      dishesCreateCaller: dishesCreateCaller as never,
      dishesDefaultsCaller,
      recipeEntriesCaller: async () => ({ recipes: [shipped, ticker] }),
    });
    await rig.route.whenLoaded();
    await flush();
    await flush();
    const html = rig.host.innerHTML;
    expect(html).toContain('data-recued-automation-recipe="ticker"');
    expect(html).not.toContain('data-recued-automation-recipe="today"');
    // Off counts the one recipe nobody switched on, not the uninstalled one.
    chipCount(html, 'off', 'Off', 1);

    // A control painted before the list said so asks nothing and says why.
    const before = rig.doc.body.children.length;
    clickAction(rig.host, 'switch-on:recipe', 'today');
    await flush();
    await flush();
    expect(rig.doc.body.children.length, 'no form opened').toBe(before);
    expect(dishesCreateCaller).not.toHaveBeenCalled();
    expect(rig.host.innerHTML).toContain('Its pack is not installed, so it does not start on its own.');
  });

  it('a dish of a recipe the server only ships keeps its line, with its pack named as the reason and no Switch on', async () => {
    const shipped = recipeEntry('today', 'Today');
    shipped.source = 'bundled';
    shipped.recipe.auto_run = { interval_ms: 300_000 };
    const rig = mountRoute({
      autoRunListCaller: async () => ({ entries: [] }),
      schedulesListCaller: async () => ({ schedules: [] }),
      triggersListCaller: async () => ({ triggers: [] }),
      dishesListCaller: async () => ({ dishes: [dishOf({ dish_id: 'dsh_early', recipe_id: 'today' })] }),
      dishesCreateCaller: vi.fn() as never,
      dishesDefaultsCaller: async () => ({ config_overlay: {} }),
      recipeEntriesCaller: async () => ({ recipes: [shipped] }),
    });
    await rig.route.whenLoaded();
    await flush();
    await flush();
    const html = rig.host.innerHTML;
    expect(html).toContain('data-recued-automation-dish="dsh_early"');
    expect(html).toContain('data-recued-automation-not-installed="today"');
    expect(html).toContain('<a href="#packs">Install it from Packs</a> to switch it on.');
    expect(html).not.toContain('Not switched on');
    expect(html).not.toContain('switch-on:recipe');
  });

  it('a recipe the server only ships, listed for a row with no dish, is not "Not switched on"', async () => {
    const shipped = recipeEntry('today', 'Today');
    shipped.source = 'bundled';
    shipped.recipe.auto_run = { interval_ms: 300_000 };
    const rig = mountRoute({
      autoRunListCaller: async () => ({ entries: [] }),
      // A schedule made before D-319 belongs to no dish.
      schedulesListCaller: async () => ({ schedules: [schedule({ schedule_id: 'sch_today', recipe_id: 'today' })] }),
      triggersListCaller: async () => ({ triggers: [] }),
      dishesListCaller: async () => ({ dishes: [] }),
      dishesCreateCaller: vi.fn() as never,
      dishesDefaultsCaller: async () => ({ config_overlay: {} }),
      recipeEntriesCaller: async () => ({ recipes: [shipped] }),
    });
    await rig.route.whenLoaded();
    await flush();
    await flush();
    const html = rig.host.innerHTML;
    expect(html).toContain('data-recued-automation-recipe="today"');
    expect(html).toContain('data-recued-automation-not-installed="today"');
    expect(html).not.toContain('Not switched on');
    chipCount(html, 'off', 'Off', 0);
  });

  it('the Dishes section’s Add lists no recipe the server only ships that starts on its own; Add schedule still does', async () => {
    const shippedTimer = recipeEntry('today', 'Today');
    shippedTimer.source = 'bundled';
    shippedTimer.recipe.auto_run = { interval_ms: 300_000 };
    const shippedManual = recipeEntry('remind-me-of', 'Remind me');
    shippedManual.source = 'bundled';
    const ticker = recipeEntry('ticker', 'Ticker recipe');
    ticker.recipe.auto_run = { interval_ms: 300_000 };
    const options = async (section: 'dishes' | 'schedules'): Promise<string[]> => {
      addPicker.searches.length = 0;
      const rig = mountRoute({
        initialSection: section,
        dishesListCaller: async () => ({ dishes: [] }),
        dishesCreateCaller: vi.fn() as never,
        schedulesCreateCaller: vi.fn() as never,
        recipeEntriesCaller: async () => ({ recipes: [shippedTimer, shippedManual, ticker] }),
      });
      await rig.route.whenLoaded();
      clickAdd(rig.host, section);
      await flush();
      await flush();
      const search = addPicker.searches.at(-1);
      expect(search, `the ${section} picker mounted`).toBeDefined();
      const found = (await search!('')).map((option) => option.id).sort();
      rig.route.dispose();
      return found;
    };
    expect(await options('dishes')).toEqual(['remind-me-of', 'ticker']);
    expect(await options('schedules')).toEqual(['remind-me-of', 'ticker', 'today']);
  });

  it('the settings form picks a mail template as on the recipe page, when the host wires the picker', async () => {
    const ticker = recipeEntry('ticker', 'Ticker recipe');
    ticker.recipe.auto_run = { interval_ms: 300_000 };
    ticker.recipe.variables = { template: { label: 'Mail template', type: 'mail_template' } } as never;
    const mount = (withPicker: boolean) => mountRoute({
      autoRunListCaller: async () => ({ entries: [] }),
      dishesListCaller: async () => ({ dishes: [] }),
      dishesCreateCaller: vi.fn(async () => ({ dish: dishOf() })) as never,
      dishesDefaultsCaller: async () => ({ config_overlay: {} }),
      recipeEntriesCaller: async () => ({ recipes: [ticker] }),
      ...(withPicker ? { mailTemplateCallers: { list: async () => [] } as never } : {}),
    });
    for (const withPicker of [true, false]) {
      const rig = mount(withPicker);
      await rig.route.whenLoaded();
      await flush();
      await flush();
      const before = rig.doc.body.children.length;
      clickAction(rig.host, 'switch-on:recipe', 'ticker');
      await flush();
      await flush();
      const form = rig.doc.body.children[before];
      expect(form, 'the switch-on form opened').toBeDefined();
      if (withPicker) expect(form!.innerHTML).toContain('data-recued-mail-template-variable="template"');
      else expect(form!.innerHTML).not.toContain('data-recued-mail-template-variable');
      rig.route.dispose();
    }
  });

  it('another dish of a recipe starts from its main dish’s settings and asks a name; a manual recipe’s first is saved, not switched on', async () => {
    const parcels = recipeEntry('parcels', 'Shop parcels watch');
    parcels.recipe.event_triggers = [{ pattern: 'data.mail.**' }] as never;
    parcels.recipe.variables = { topic: { label: 'Topic', type: 'text', default: 'news' } } as never;
    const brief = recipeEntry('daily-brief', 'Daily brief');
    brief.recipe.variables = { topic: { label: 'Topic', type: 'text', default: 'news' } } as never;
    const dishesDefaultsCaller = vi.fn(async () => ({ config_overlay: {} }));
    const rig = mountRoute({
      autoRunListCaller: async () => ({ entries: [] }),
      dishesListCaller: async () => ({ dishes: [dishOf({ config_overlay: { topic: 'work' } })] }),
      dishesCreateCaller: vi.fn(async () => ({ dish: dishOf() })) as never,
      dishesDefaultsCaller,
      recipeEntriesCaller: async () => ({ recipes: [parcels, brief] }),
    });
    await rig.route.whenLoaded();
    await flush();
    await flush();
    // It starts on its own and has a dish: it is switched on.
    expect(rig.host.innerHTML).toContain('data-recued-automation-dish="dsh_work"');
    expect(rig.host.innerHTML).not.toContain('Not switched on');

    // The Dishes section's Add dish and "Not switched on" share one path.
    let before = rig.doc.body.children.length;
    clickAction(rig.host, 'switch-on:recipe', 'parcels');
    await flush();
    await flush();
    const another = rig.doc.body.children[before];
    expect(another).toBeDefined();
    expect(another!.innerHTML).toContain('Add another “Shop parcels watch”');
    expect(another!.innerHTML).toContain('work');
    expect(dishesDefaultsCaller, 'another dish needs no install read').not.toHaveBeenCalled();
    another!.remove();
    // The form's own close hook never ran here; a fresh mount opens the next.

    const rig2 = mountRoute({
      autoRunListCaller: async () => ({ entries: [] }),
      dishesListCaller: async () => ({ dishes: [] }),
      dishesCreateCaller: vi.fn(async () => ({ dish: dishOf() })) as never,
      dishesDefaultsCaller,
      recipeEntriesCaller: async () => ({ recipes: [parcels, brief] }),
    });
    await rig2.route.whenLoaded();
    await flush();
    await flush();
    before = rig2.doc.body.children.length;
    clickAction(rig2.host, 'switch-on:recipe', 'daily-brief');
    await flush();
    await flush();
    const first = rig2.doc.body.children[before];
    expect(first).toBeDefined();
    expect(first!.innerHTML).toContain('Settings for “Daily brief”');
    expect(first!.innerHTML).not.toContain('Switch on');
  });

  it('a dish’s Details open in its own section; Back returns to the list', async () => {
    const rig = mountRoute({
      dishesListCaller: async () => ({ dishes: [dishOf({ name: 'Work mailbox' })] }),
      autoRunListCaller: async () => ({ entries: [] }),
    });
    await rig.route.whenLoaded();
    await flush();
    expect(lineOf(rig.host.innerHTML, 'dsh_work')).toContain('aria-label="Details of Work mailbox"');

    clickAction(rig.host, 'detail:dish', 'dsh_work');
    expect(rig.route.getActiveSection()).toBe('dishes');
    expect(rig.host.innerHTML).toContain('Back to By recipe');

    clickBack(rig.host);
    expect(rig.route.getActiveSection()).toBe('all');
    expect(rig.host.innerHTML).toContain('data-recued-automation-dish="dsh_work"');
  });

  it('Coming up: the next runs of dishes that are on, soonest first', async () => {
    const rig = mountRoute({
      initialSection: 'coming-up',
      dishesListCaller: async () => ({
        dishes: [
          dishOf({ dish_id: 'dsh_work', name: 'Work mailbox' }),
          dishOf({ dish_id: 'dsh_home', name: 'Home mailbox', is_default: false, created_at: 2 }),
          dishOf({ dish_id: 'dsh_off', recipe_id: 'quiet', enabled: false }),
        ],
      }),
      schedulesListCaller: async () => ({
        schedules: [
          schedule({ schedule_id: 'sch_late', recipe_id: 'parcels', dish_id: 'dsh_work', next_run_at: NOW + 90_000 }),
          schedule({ schedule_id: 'sch_paused', recipe_id: 'parcels', dish_id: 'dsh_home', enabled: false, next_run_at: NOW + 10_000 }),
          schedule({ schedule_id: 'sch_off', recipe_id: 'quiet', dish_id: 'dsh_off', next_run_at: NOW + 20_000 }),
        ],
      }),
      autoRunListCaller: async () => ({
        entries: [
          autoRunEntry({ recipe_id: 'parcels', dish_id: 'dsh_home', next_run_at: NOW + 30_000 }),
          // Nobody switched this one on: nothing of it is coming up.
          autoRunEntry({ recipe_id: 'ticker', dish_id: null, next_run_at: NOW + 5_000 }),
        ],
      }),
      recipeEntriesCaller: async () => ({ recipes: [recipeEntry('parcels', 'Shop parcels watch')] }),
      recipeNamesCaller,
    });
    await rig.route.whenLoaded();
    await flush();
    const html = rig.host.innerHTML;
    const list = html.slice(html.indexOf('data-recued-automation-coming-up'));
    expect(list.match(/<li>/g)).toHaveLength(2);
    expect(list.indexOf('Home mailbox')).toBeGreaterThan(0);
    expect(list.indexOf('Home mailbox')).toBeLessThan(list.indexOf('Work mailbox'));
    expect(list).toContain('Every 5 minutes');
    expect(list).toContain('Daily at 9:00 AM');
    expect(list).not.toContain('Ticker recipe');
    expect(html).toContain('Coming up <span class="automation-subnav-count">2</span>');
  });

  it('a timer with a time window says when it REALLY runs, and comes up at its first check inside it', async () => {
    // Owner (2026-10-05) on "Runs every 10 minutes and weekdays at 8:00 AM":
    // "is a wrong time use a real time in the message". The shipped Today
    // recipe: checked every 10 minutes, open weekdays 8-9 (its defaults).
    const today = recipeEntry('today', 'Today');
    Object.assign(today.recipe, {
      auto_run: { interval_ms: 600_000 },
      trigger_steps: [{ id: 'morning', op: 'core.watch.time', args: {
        weekdays: '{{config.weekdays}}', start_hour: '{{config.start_hour}}', end_hour: '{{config.end_hour}}',
      } }],
      variables: {
        start_hour: { label: 'Window start hour', type: 'number', default: 8 },
        end_hour: { label: 'Window end hour', type: 'number', default: 9 },
        weekdays: { label: 'Active weekdays', type: 'array', default: [1, 2, 3, 4, 5] },
      },
    });
    // Monday 04:02 in Los Angeles is its next CHECK; nothing runs before 08:02.
    const nextCheck = Date.parse('2026-10-05T04:02:00-07:00');
    const sixAm = Date.parse('2026-10-05T06:00:00-07:00');
    const mount = (section: 'all' | 'coming-up') => mountRoute({
      initialSection: section,
      serverTimeZone: () => 'America/Los_Angeles',
      dishesListCaller: async () => ({ dishes: [
        dishOf({ dish_id: 'dsh_today', recipe_id: 'today' }),
        dishOf({ dish_id: 'dsh_work', name: 'Work mailbox' }),
      ] }),
      schedulesListCaller: async () => ({ schedules: [
        schedule({ schedule_id: 'sch_six', recipe_id: 'parcels', dish_id: 'dsh_work', next_run_at: sixAm }),
      ] }),
      autoRunListCaller: async () => ({ entries: [
        autoRunEntry({ recipe_id: 'today', dish_id: 'dsh_today', recipe_name: 'Today', interval_ms: 600_000, next_run_at: nextCheck }),
      ] }),
      recipeEntriesCaller: async () => ({ recipes: [today, recipeEntry('parcels', 'Shop parcels watch')] }),
      recipeNamesCaller,
    });

    const all = mount('all');
    await all.route.whenLoaded();
    await flush();
    expect(all.host.innerHTML).toContain('Runs every 10 minutes from 8:00 to 9:00 AM on weekdays');
    expect(all.host.innerHTML).toContain('every 10 minutes from 8:00 to 9:00 AM on weekdays');
    expect(all.host.innerHTML).not.toContain('Runs every 10 minutes<');

    const coming = mount('coming-up');
    await coming.route.whenLoaded();
    await flush();
    const html = coming.host.innerHTML;
    const list = html.slice(html.indexOf('data-recued-automation-coming-up'));
    expect(list).toContain('Every 10 minutes from 8:00 to 9:00 AM on weekdays');
    // The 06:00 schedule comes BEFORE Today: Today's next run is 08:02, not
    // its 04:02 check. Instants, so this holds in any test machine's zone.
    expect(list.indexOf('Work mailbox')).toBeGreaterThan(0);
    expect(list.indexOf('#recipes/today')).toBeGreaterThan(0);
    expect(list.indexOf('Work mailbox')).toBeLessThan(list.indexOf('#recipes/today'));
  });

  it('a timer that waits for data says what it waits for, shows its next CHECK, and is not coming up', async () => {
    // Owner: "do the event wording for the 14 data-gated timers too". Its
    // next check runs it only if the page has changed: no time is its next run.
    const urgent = recipeEntry('urgent-mail', 'Urgent mail');
    Object.assign(urgent.recipe, {
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 'page', op: 'core.watch.http', args: { target_url: '{{config.url}}' } }],
      variables: { url: { label: 'Page', type: 'url', default: 'https://acme.com/pricing' } },
    });
    const mount = (section: 'all' | 'coming-up') => mountRoute({
      initialSection: section,
      dishesListCaller: async () => ({ dishes: [dishOf({ dish_id: 'dsh_urgent', recipe_id: 'urgent-mail' })] }),
      schedulesListCaller: async () => ({ schedules: [] }),
      autoRunListCaller: async () => ({ entries: [
        autoRunEntry({ recipe_id: 'urgent-mail', dish_id: 'dsh_urgent', recipe_name: 'Urgent mail', interval_ms: 60_000, next_run_at: NOW + 60_000 }),
      ] }),
      recipeEntriesCaller: async () => ({ recipes: [urgent] }),
      recipeNamesCaller,
    });

    const all = mount('all');
    await all.route.whenLoaded();
    await flush();
    expect(all.host.innerHTML).toContain('Runs when the page at acme.com/pricing changes, checking every minute');
    expect(all.host.innerHTML).toContain('next check ');

    const coming = mount('coming-up');
    await coming.route.whenLoaded();
    await flush();
    const html = coming.host.innerHTML;
    expect(html.slice(html.indexOf('data-recued-automation-coming-up'))).not.toContain('#recipes/urgent-mail');
  });

  it('a re-read keeps the list on screen; it does not blank to Loading…', async () => {
    const second = deferred<{ dishes: Dish[] }>();
    const dishesListCaller = vi.fn()
      .mockResolvedValueOnce({ dishes: [dishOf()] })
      .mockImplementationOnce(() => second.promise);
    const rig = mountRoute({
      dishesListCaller: dishesListCaller as never,
      dishesUpdateCaller: vi.fn(async () => ({ dish: dishOf({ enabled: false }) })) as never,
      autoRunListCaller: async () => ({ entries: [] }),
    });
    await rig.route.whenLoaded();
    await flush();

    clickAction(rig.host, 'toggle:dish:off', 'dsh_work');
    await flush();
    await flush();
    expect(dishesListCaller).toHaveBeenCalledTimes(2);
    expect(rig.host.innerHTML).toContain('data-recued-automation-dish="dsh_work"');
    expect(rig.host.innerHTML).not.toContain('Loading…');

    second.resolve({ dishes: [dishOf({ enabled: false })] });
    await rig.route.whenLoaded();
    await flush();
    expect(lineOf(rig.host.innerHTML, 'dsh_work')).toContain('aria-checked="false"');
  });

  it('a failed read on the list says so, with a Retry that reads again', async () => {
    const dishesListCaller = vi.fn()
      .mockRejectedValueOnce(new Error('dishes down'))
      .mockResolvedValue({ dishes: [dishOf()] });
    const rig = mountRoute({
      dishesListCaller: dishesListCaller as never,
      autoRunListCaller: async () => ({ entries: [] }),
    });
    await rig.route.whenLoaded();
    await flush();
    expect(rig.host.innerHTML).toMatch(
      /data-recued-automation-error="all" role="alert">\s*<span>dishes down<\/span>[\s\S]*?data-recued-automation-retry="all"/,
    );

    clickRetry(rig.host, 'all');
    await rig.route.whenLoaded();
    await flush();
    expect(dishesListCaller).toHaveBeenCalledTimes(2);
    expect(rig.host.innerHTML).not.toContain('data-recued-automation-error="all"');
    expect(rig.host.innerHTML).toContain('data-recued-automation-dish="dsh_work"');
  });

  it('Coming up keeps its entries on screen while it re-reads', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const subscribe: Subscribe = ((kind: string, fn: (event: never) => void) => {
      listeners.set(kind, fn as (event: unknown) => void);
      return () => { listeners.delete(kind); };
    }) as unknown as Subscribe;
    const second = deferred<{ schedules: ServerSchedule[] }>();
    const schedulesListCaller = vi.fn<SchedulesListCaller>()
      .mockResolvedValueOnce({ schedules: [schedule({ dish_id: 'dsh_work', recipe_id: 'parcels' })] })
      .mockImplementationOnce(() => second.promise);
    const rig = mountRoute({
      initialSection: 'coming-up',
      subscribe,
      schedulesListCaller,
      dishesListCaller: async () => ({ dishes: [dishOf()] }),
      autoRunListCaller: async () => ({ entries: [] }),
      recipeNamesCaller,
    });
    await rig.route.whenLoaded();
    await flush();
    expect(rig.host.innerHTML).toContain('Shop parcels watch</a>');

    listeners.get('automation_rule_changed')!({ kind: 'automation_rule_changed', mechanism: 'schedule', cursor: 1 });
    await flush();
    expect(schedulesListCaller).toHaveBeenCalledTimes(2);
    expect(rig.host.innerHTML).toContain('Shop parcels watch</a>');
    expect(rig.host.innerHTML).not.toContain('Loading…');
    second.resolve({ schedules: [] });
    await rig.route.whenLoaded();
  });

  it('keeps the create path the tabs held: Add schedule and Add trigger', async () => {
    const rig = mountRoute({
      recipeEntriesCaller: async () => ({ recipes: [recipeEntry()] }),
      schedulesCreateCaller: vi.fn() as never,
      triggersCreateCaller: vi.fn() as never,
    });
    await rig.route.whenLoaded();
    expect(rig.route.getActiveSection()).toBe('all');
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ADD_ATTR}="schedules"`);
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ADD_ATTR}="triggers"`);

    clickAdd(rig.host, 'schedules');
    await flush();
    expect(rig.host.innerHTML).toContain('data-ref-picker="automation-add-recipe"');
  });
});

describe('Automation route — mutations', () => {
  it('toggle clicks invoke the matching caller with exact args, then re-list', async () => {
    const schedulesUpdateCaller = vi.fn<SchedulesUpdateCaller>(async (args) => ({
      schedule: schedule({ enabled: args.enabled ?? true }),
    }));
    const triggersUpdateCaller = vi.fn<TriggersUpdateCaller>(async (args) => ({
      trigger: trigger({ enabled: args.enabled ?? true }),
    }));
    const autoRunUpdateCaller = vi.fn<AutoRunUpdateCaller>(async (args) => ({
      entry: autoRunEntry({ enabled: args.enabled }),
    }));
    const schedulesListCaller = vi.fn<SchedulesListCaller>(async () => ({
      schedules: [schedule()],
    }));
    const rig = mountRoute({
      schedulesListCaller,
      schedulesUpdateCaller,
      triggersUpdateCaller,
      autoRunUpdateCaller,
    });
    await rig.route.whenLoaded();
    const listCallsBefore = schedulesListCaller.mock.calls.length;

    clickAction(rig.host, 'toggle:schedule:off', 'sch_1');
    await flush();
    expect(schedulesUpdateCaller).toHaveBeenCalledWith({
      schedule_id: 'sch_1',
      enabled: false,
    });

    clickAction(rig.host, 'toggle:event_trigger:on', 't-1');
    await flush();
    expect(triggersUpdateCaller).toHaveBeenCalledWith({
      trigger_id: 't-1',
      enabled: true,
    });

    clickAction(rig.host, 'toggle:auto_run:on', 'ticker');
    await flush();
    expect(autoRunUpdateCaller).toHaveBeenCalledWith({
      recipe_id: 'ticker',
      enabled: true,
    });

    // Each mutation re-listed.
    expect(schedulesListCaller.mock.calls.length).toBe(listCallsBefore + 3);
  });

  it('D-179 — resuming a recipe WITH config variables opens the editor; without, it toggles directly', async () => {
    const autoRunUpdateCaller = vi.fn<AutoRunUpdateCaller>(async (args) => ({
      entry: autoRunEntry({ enabled: args.enabled ?? true }),
    }));
    const rig = mountRoute({
      autoRunListCaller: async () => ({
        entries: [
          autoRunEntry({ recipe_id: 'with-vars', enabled: false, variables: { topic: 'news' } }),
          autoRunEntry({ recipe_id: 'no-vars', enabled: false, variables: {} }),
        ],
      }),
      autoRunUpdateCaller,
    });
    await rig.route.whenLoaded();

    // With variables → the config editor intercepts; the caller isn't
    // invoked on the bare Resume click (config is captured first).
    clickAction(rig.host, 'toggle:auto_run:on', 'with-vars');
    await flush();
    expect(autoRunUpdateCaller).not.toHaveBeenCalled();

    // No variables → a plain resume calls the caller directly (unchanged).
    clickAction(rig.host, 'toggle:auto_run:on', 'no-vars');
    await flush();
    expect(autoRunUpdateCaller).toHaveBeenCalledWith({ recipe_id: 'no-vars', enabled: true });
  });

  it('D-319 — where the host makes dishes, switching on a timer nobody switched on is the switch-on form', async () => {
    const ticker = recipeEntry('ticker', 'Ticker recipe');
    ticker.recipe.auto_run = { interval_ms: 300_000 };
    ticker.recipe.variables = { topic: { label: 'Topic', type: 'text', default: 'news' } } as never;
    // Resume and Configure on the row both ask for its settings first.
    for (const action of ['toggle:auto_run:on', 'configure:auto_run']) {
      const autoRunUpdateCaller = vi.fn<AutoRunUpdateCaller>();
      const dishesDefaultsCaller = vi.fn(async () => ({ config_overlay: { topic: 'install-pick' } }));
      const rig = mountRoute({
        initialSection: 'auto-run',
        autoRunListCaller: async () => ({
          entries: [autoRunEntry({ dish_id: null, enabled: false, variables: ticker.recipe.variables ?? {} })],
        }),
        autoRunUpdateCaller,
        dishesListCaller: async () => ({ dishes: [] }),
        dishesCreateCaller: vi.fn(async () => ({ dish: {} as Dish })) as never,
        dishesDefaultsCaller,
        recipeEntriesCaller: async () => ({ recipes: [ticker] }),
      });
      await rig.route.whenLoaded();
      await flush();
      await flush();
      const before = rig.doc.body.children.length;
      clickAction(rig.host, action, 'ticker');
      await flush();
      await flush();
      const form = rig.doc.body.children[before];
      expect(form, `${action} opened the switch-on form`).toBeDefined();
      expect(form!.innerHTML).toContain('Switch on “Ticker recipe”');
      expect(form!.innerHTML).toContain('install-pick');
      expect(dishesDefaultsCaller).toHaveBeenCalledWith({ recipe_id: 'ticker' });
      expect(autoRunUpdateCaller).not.toHaveBeenCalled();
      rig.route.dispose();
    }
  });

  it('delete clicks require confirmation before invoking schedule and trigger callers', async () => {
    const schedulesDeleteCaller = vi.fn<SchedulesDeleteCaller>(async () => ({
      deleted: true as const,
    }));
    const triggersDeleteCaller = vi.fn<TriggersDeleteCaller>(async () => ({
      ok: true as const,
    }));
    const rig = mountRoute({
      initialSection: 'schedules',
      schedulesDeleteCaller,
      triggersDeleteCaller,
    });
    await rig.route.whenLoaded();

    clickAction(rig.host, 'delete:schedule', 'sch_1');
    expect(schedulesDeleteCaller).not.toHaveBeenCalled();
    expect(rig.host.innerHTML).toContain('Confirm remove');
    clickAction(rig.host, 'delete-cancel:schedule', 'sch_1');
    expect(schedulesDeleteCaller).not.toHaveBeenCalled();
    expect(rig.host.innerHTML).not.toContain('Confirm remove');

    clickAction(rig.host, 'delete:schedule', 'sch_1');
    clickAction(rig.host, 'delete-confirm:schedule', 'sch_1');
    await flush();
    expect(schedulesDeleteCaller).toHaveBeenCalledWith({ schedule_id: 'sch_1' });

    clickSubnav(rig.host, 'triggers');
    clickAction(rig.host, 'delete:event_trigger', 't-1');
    expect(triggersDeleteCaller).not.toHaveBeenCalled();
    clickAction(rig.host, 'delete-confirm:event_trigger', 't-1');
    await flush();
    expect(triggersDeleteCaller).toHaveBeenCalledWith({ trigger_id: 't-1' });
  });

  it('a failed mutation survives the follow-up re-list and clears on the next success', async () => {
    let fail = true;
    const schedulesUpdateCaller = vi.fn<SchedulesUpdateCaller>(async (args) => {
      if (fail) throw new Error('pause rejected');
      return { schedule: schedule({ enabled: args.enabled ?? true }) };
    });
    const schedulesListCaller = vi.fn<SchedulesListCaller>(async () => ({
      schedules: [schedule()],
    }));
    const rig = mountRoute({
      initialSection: 'schedules',
      schedulesListCaller,
      schedulesUpdateCaller,
    });
    await rig.route.whenLoaded();

    clickAction(rig.host, 'toggle:schedule:off', 'sch_1');
    await flush();
    // The re-list succeeded, but the mutation failure must remain
    // visible (codex MEDIUM fold: separate maps).
    expect(rig.route.getMutationErrors()).toEqual({ schedules: 'pause rejected' });
    expect(rig.route.getLoadErrors()).toEqual({});
    expect(rig.host.innerHTML).toContain('pause rejected');
    expect(rig.host.innerHTML).toContain(
      `${AUTOMATION_ROUTE_ERROR_ATTR}="schedule:mutation" role="alert"`,
    );
    // Rows still render alongside the mutation error.
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="schedule:sch_1"`);

    fail = false;
    clickAction(rig.host, 'toggle:schedule:off', 'sch_1');
    await flush();
    expect(rig.route.getMutationErrors()).toEqual({});
  });

  it('ignores clicks on a rule whose mutation is already in flight', async () => {
    let resolveUpdate: (() => void) | undefined;
    const schedulesUpdateCaller = vi.fn<SchedulesUpdateCaller>(
      () =>
        new Promise((resolve) => {
          resolveUpdate = () => resolve({ schedule: schedule() });
        }),
    );
    const rig = mountRoute({
      initialSection: 'schedules',
      schedulesUpdateCaller,
    });
    await rig.route.whenLoaded();

    clickAction(rig.host, 'toggle:schedule:off', 'sch_1');
    clickAction(rig.host, 'toggle:schedule:off', 'sch_1');
    expect(schedulesUpdateCaller).toHaveBeenCalledTimes(1);
    expect(rig.host.innerHTML).toContain('Pausing…');
    expect(rig.host.innerHTML).toContain('aria-disabled="true"');
    expect(rig.host.innerHTML).toContain('aria-busy="true"');
    expect(rig.host.innerHTML).not.toContain('data-rule-id="sch_1" disabled');
    expect(rig.host.innerHTML).toMatch(
      new RegExp(
        `${AUTOMATION_ROUTE_SUBNAV_ATTR}="coming-up"[\\s\\S]*?`
          + 'aria-selected="false"[\\s\\S]*?tabindex="-1"[\\s\\S]*?'
          + 'aria-disabled="true"',
      ),
    );
    expect(rig.host.innerHTML).toContain(
      'class="automation-filter" inert aria-disabled="true"',
    );
    expect(rig.route.hasInFlightWork()).toBe(true);
    expect(rig.route.inFlightWorkPrompt()).toBe(
      'Something is still happening here. Leave anyway?',
    );

    // Internal tabs and filters bypass the shell-level work tracker. They
    // must not repaint the pending row out from under its progress owner.
    clickSubnav(rig.host, 'triggers');
    changeSelect(rig.host, AUTOMATION_ROUTE_STATUS_FILTER_ATTR, 'off');
    expect(rig.route.getActiveSection()).toBe('schedules');
    expect(rig.host.innerHTML).toContain(
      `${AUTOMATION_ROUTE_ROW_ATTR}="schedule:sch_1"`,
    );

    resolveUpdate?.();
    await flush();
    expect(rig.host.innerHTML).not.toContain(
      'class="automation-filter" inert aria-disabled="true"',
    );
    expect(rig.route.hasInFlightWork()).toBe(false);
    expect(rig.route.inFlightWorkPrompt()).toBeNull();
    clickSubnav(rig.host, 'triggers');
    expect(rig.route.getActiveSection()).toBe('triggers');
  });
});

describe('Automation route — detail view', () => {
  it('opens details, backs out, mutates from detail, and falls back after the rule disappears', async () => {
    let currentSchedules: ServerSchedule[] = [schedule()];
    const schedulesListCaller = vi.fn<SchedulesListCaller>(async () => ({
      schedules: currentSchedules,
    }));
    const schedulesUpdateCaller = vi.fn<SchedulesUpdateCaller>(async (args) => {
      currentSchedules = [];
      return {
        schedule: schedule({ enabled: args.enabled ?? true }),
      };
    });
    const rig = mountRoute({
      initialSection: 'schedules',
      schedulesListCaller,
      schedulesUpdateCaller,
      recipeNamesCaller: async () => ({
        recipes: [{ recipe_id: 'daily-brief', name: 'Daily brief' }],
      }),
    });
    await rig.route.whenLoaded();

    clickAction(rig.host, 'detail:schedule', 'sch_1');
    expect(rig.route.getDetailId()).toBe('sch_1');
    expect(rig.host.innerHTML).toContain('data-recued-automation-detail="sch_1"');
    expect(rig.host.innerHTML).toContain('Daily brief');
    expect(rig.host.innerHTML).toContain('Cadence');
    expect(rig.host.innerHTML).toContain('Daily at 9:00 AM');
    expect(rig.host.innerHTML).toContain(
      '<a href="#logs">Logs<span aria-hidden="true">.</span></a>',
    );

    clickBack(rig.host);
    expect(rig.route.getDetailId()).toBeNull();
    expectOnlySection(rig.host.innerHTML, 'schedule');

    clickAction(rig.host, 'detail:schedule', 'sch_1');
    clickAction(rig.host, 'toggle:schedule:off', 'sch_1');
    await flush();
    expect(schedulesUpdateCaller).toHaveBeenCalledWith({
      schedule_id: 'sch_1',
      enabled: false,
    });
    expect(rig.route.getDetailId()).toBe('sch_1');
    expect(rig.host.innerHTML).toContain('This rule no longer exists');
  });

  it('allows Details clicks while the row is busy', async () => {
    let resolveUpdate: (() => void) | undefined;
    const schedulesUpdateCaller = vi.fn<SchedulesUpdateCaller>(
      () =>
        new Promise((resolve) => {
          resolveUpdate = () => resolve({ schedule: schedule() });
        }),
    );
    const rig = mountRoute({
      initialSection: 'schedules',
      schedulesUpdateCaller,
    });
    await rig.route.whenLoaded();

    clickAction(rig.host, 'toggle:schedule:off', 'sch_1');
    expect(schedulesUpdateCaller).toHaveBeenCalledTimes(1);

    clickAction(rig.host, 'detail:schedule', 'sch_1');
    expect(rig.route.getDetailId()).toBe('sch_1');
    expect(rig.host.innerHTML).toContain('data-recued-automation-detail="sch_1"');

    resolveUpdate?.();
    await flush();
  });
});

describe('Automation route — live refresh + dispose', () => {
  it('subscribes to exactly the three automation kinds and re-lists on each', async () => {
    const kinds: string[] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const subscribe: Subscribe = ((kind: string, fn: (event: never) => void) => {
      kinds.push(kind);
      listeners.set(kind, fn as (event: unknown) => void);
      return () => {
        listeners.delete(kind);
      };
    }) as unknown as Subscribe;
    const schedulesListCaller = vi.fn<SchedulesListCaller>(async () => ({
      schedules: [schedule()],
    }));
    const rig = mountRoute({ schedulesListCaller, subscribe });
    await rig.route.whenLoaded();
    expect(kinds).toEqual(['schedule', 'automation_rule_changed', 'reactive_fire']);

    const before = schedulesListCaller.mock.calls.length;
    listeners.get('automation_rule_changed')!({
      kind: 'automation_rule_changed',
      mechanism: 'auto_run',
      cursor: 1,
    });
    await flush();
    expect(schedulesListCaller.mock.calls.length).toBe(before + 1);

    rig.route.dispose();
    expect(listeners.size).toBe(0);
  });

  it('dispose detaches the host and is idempotent', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    rig.route.dispose();
    expect(rig.root.children).toHaveLength(0);
    rig.route.dispose();
  });
});

describe('Automation route — dissolved watches', () => {
  it('tolerates a watch list response with sources while ignoring push-source rows', async () => {
    const rig = mountRoute({
      initialSection: 'triggers',
      triggersListCaller: async () => ({ triggers: [] }),
      watchListCaller: vi.fn<WatchListCaller>(async () => ({
        watches: [watchEntry()],
        sources: [sourceEntry()],
      })),
    });
    await rig.route.whenLoaded();

    expect(rig.route.getWatches()).toHaveLength(1);
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="watch:hubspot/deal/main-crm"`);
    expect(rig.host.innerHTML).toContain('hubspot deal — main-crm');
    expect(rig.host.innerHTML).not.toContain('hubspot webhook — main-crm');
  });

  it('decodes an mcp-resource inline poll label to a readable uri', async () => {
    const uri = 'file:///notes/todo.md';
    const encoded = encodeMcpResourceUri(uri);
    const watchKey = `mcp-resource/${encoded}/my-server`;
    const rig = mountRoute({
      initialSection: 'triggers',
      triggersListCaller: async () => ({
        triggers: [
          trigger({
            trigger_id: 't-mcp',
            recipe_id: 'watch-todo',
            pattern: `data.${MCP_RESOURCE_POLL_SOURCE_ID}.${encoded}.**`,
          }),
        ],
      }),
      watchListCaller: vi.fn<WatchListCaller>(async () => ({
        watches: [
          watchEntry({
            watch_key: watchKey,
            source_id: MCP_RESOURCE_POLL_SOURCE_ID,
            connection_name: 'my-server',
            vendor: MCP_RESOURCE_POLL_SOURCE_ID,
            entity: encoded,
            subscriber_recipe_ids: ['watch-todo'],
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_POLL_ATTR}="${watchKey}"`);
    expect(rig.host.innerHTML).toContain(`MCP resource ${uri} — my-server`);
    expect(rig.host.innerHTML).not.toContain(`${MCP_RESOURCE_POLL_SOURCE_ID} ${encoded} — my-server`);
  });
});

describe('Automation route — recipe-focus deep-link', () => {
  const filteredRig = () =>
    mountRoute({
      initialRecipeFilter: 'deal-watch',
      schedulesListCaller: async () => ({
        schedules: [
          schedule({ schedule_id: 'sch_keep', recipe_id: 'deal-watch' }),
          schedule({ schedule_id: 'sch_other', recipe_id: 'daily-brief' }),
        ],
      }),
      triggersListCaller: async () => ({
        triggers: [
          trigger({ trigger_id: 't_keep', recipe_id: 'deal-watch' }),
          trigger({ trigger_id: 't_other', recipe_id: 'unrelated' }),
        ],
      }),
      autoRunListCaller: async () => ({
        entries: [autoRunEntry({ recipe_id: 'someone-else' })],
      }),
      watchListCaller: vi.fn<WatchListCaller>(async () => ({
        watches: [
          watchEntry(),
          watchEntry({
            watch_key: 'hubspot/contact/main-crm',
            entity: 'contact',
            subscriber_recipe_ids: ['daily-brief'],
          }),
        ],
        sources: [sourceEntry()],
      })),
      recipeNamesCaller: async () => ({
        recipes: [{ recipe_id: 'deal-watch', name: 'Deal watch' }],
      }),
    });

  it('renders the recipe-filter combobox seeded with the resolved recipe name', async () => {
    const rig = filteredRig();
    await rig.route.whenLoaded();
    const html = rig.host.innerHTML;

    expect(rig.route.getRecipeFilter()).toBe('deal-watch');
    expect(rig.route.getActiveSection()).toBe('all');
    // The ref-picker shell renders, its input showing the resolved name
    // once recipe.list has loaded.
    expect(html).toContain('data-ref-picker="automation-recipe-filter"');
    expect(html).toContain('value="Deal watch"');
  });

  it('narrows recipe-bound tabs to the focused recipe', async () => {
    const rig = filteredRig();
    await rig.route.whenLoaded();

    expect(rig.host.innerHTML).toContain('event_trigger:t_keep');
    expect(rig.host.innerHTML).not.toContain('event_trigger:t_other');
    expect(rig.host.innerHTML).toContain('data-rule-id="hubspot/deal/main-crm"');
    expect(rig.host.innerHTML).not.toContain('hubspot/contact/main-crm');
    expect(rig.host.innerHTML).not.toContain('hubspot webhook — main-crm');

    clickSubnav(rig.host, 'schedules');
    expect(rig.host.innerHTML).toContain('schedule:sch_keep');
    expect(rig.host.innerHTML).not.toContain('schedule:sch_other');

    clickSubnav(rig.host, 'auto-run');
    expect(rig.host.innerHTML).toContain('This Recipe does not run on its own.');
    expect(rig.host.innerHTML).not.toContain('someone-else');
  });

  it('shows the full view with an empty filter combobox when no filter is set', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    expect(rig.route.getRecipeFilter()).toBeNull();
    const html = rig.host.innerHTML;
    // The combobox is present but empty, so its clear button stays hidden.
    expect(html).toContain('data-ref-picker="automation-recipe-filter"');
    expect(html).toMatch(/ref-picker-clear[^>]*hidden/);
    // D-319 — the full view is the one list, with its filters.
    expect(html).toContain('data-recued-automation-chip="on"');
  });
});

describe('Automation route — create path', () => {
  it('renders Add disclosure only with recipe entries plus a section create caller', async () => {
    const triggerOnlyCreate = mountRoute({
      initialSection: 'schedules',
      schedulesCreateCaller: async (args) => ({
        schedule: schedule({
          recipe_id: args.recipe_id,
          publisher_id: args.publisher_id ?? 'recued-core',
          cron_expression: args.cron_expression,
        }),
      }),
    });
    await triggerOnlyCreate.route.whenLoaded();
    expect(triggerOnlyCreate.host.innerHTML).not.toContain(AUTOMATION_ROUTE_ADD_ATTR);
    triggerOnlyCreate.route.dispose();

    const recipeEntriesCaller = vi.fn(async () => ({
      recipes: [recipeEntry('daily-brief', 'Daily brief')],
    }));
    const schedulesCreateCaller = vi.fn<
      NonNullable<BootstrapAutomationRouteOptions['schedulesCreateCaller']>
    >(async (args) => ({
      schedule: schedule({
        recipe_id: args.recipe_id,
        publisher_id: args.publisher_id ?? 'recued-core',
        cron_expression: args.cron_expression,
      }),
    }));
    const rig = mountRoute({
      initialSection: 'schedules',
      recipeEntriesCaller,
      schedulesCreateCaller,
    });
    await rig.route.whenLoaded();

    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ADD_ATTR}="schedules"`);
    expect(rig.host.innerHTML).not.toContain('data-ref-picker="automation-add-recipe"');

    clickAdd(rig.host, 'schedules');
    await flush();
    expect(recipeEntriesCaller).toHaveBeenCalledTimes(1);
    expect(rig.host.innerHTML).toContain('data-ref-picker="automation-add-recipe"');
  });

  it('keeps a failed Add recipe inventory explicit, single-flight, and recoverable', async () => {
    const retry = deferred<{ recipes: ServerRecipeListEntry[] }>();
    const recipeEntriesCaller = vi.fn<
      NonNullable<BootstrapAutomationRouteOptions['recipeEntriesCaller']>
    >()
      .mockRejectedValueOnce(new Error('recipe catalog down'))
      .mockImplementationOnce(() => retry.promise);
    const rig = mountRoute({
      initialSection: 'schedules',
      recipeEntriesCaller,
      schedulesCreateCaller: async (args) => ({
        schedule: schedule({ recipe_id: args.recipe_id }),
      }),
    });
    await rig.route.whenLoaded();

    clickAdd(rig.host, 'schedules');
    await flush();
    expect(recipeEntriesCaller).toHaveBeenCalledTimes(1);
    expect(rig.host.innerHTML).toContain(
      `${AUTOMATION_ROUTE_ADD_ERROR_ATTR}="schedules"`,
    );
    expect(rig.host.innerHTML).toContain('role="alert"');
    expect(rig.host.innerHTML).toContain('recipe catalog down');
    expect(rig.host.innerHTML).toContain(
      `${AUTOMATION_ROUTE_ADD_RETRY_ATTR}="schedules"`,
    );
    expect(rig.host.innerHTML).not.toContain('No installed recipes match.');

    clickAddRetry(rig.host, 'schedules');
    clickAddRetry(rig.host, 'schedules');
    expect(recipeEntriesCaller).toHaveBeenCalledTimes(2);
    expect(rig.host.innerHTML).toContain('role="status"');
    expect(rig.host.innerHTML).toContain(
      'aria-disabled="true" aria-busy="true"',
    );
    expect(rig.host.innerHTML).toContain('Retrying…');

    retry.resolve({ recipes: [recipeEntry('daily-brief', 'Daily brief')] });
    await flush();
    expect(rig.host.innerHTML).not.toContain(AUTOMATION_ROUTE_ADD_ERROR_ATTR);
    expect(rig.host.innerHTML).toContain('data-ref-picker="automation-add-recipe"');
  });

  it('surfaces the shared inventory failure on Dishes without a create caller', async () => {
    const retry = deferred<{ recipes: ServerRecipeListEntry[] }>();
    const recipeEntriesCaller = vi.fn<
      NonNullable<BootstrapAutomationRouteOptions['recipeEntriesCaller']>
    >()
      .mockRejectedValueOnce(new Error('recipe definitions unavailable'))
      .mockImplementationOnce(() => retry.promise);
    const rig = mountRoute({
      initialSection: 'dishes',
      dishesListCaller: async () => ({ dishes: [] }),
      recipeEntriesCaller,
    });
    await rig.route.whenLoaded();
    await flush();

    expect(rig.host.innerHTML).not.toContain(
      `${AUTOMATION_ROUTE_ADD_ATTR}="dishes"`,
    );
    expect(rig.host.innerHTML).toContain(
      `${AUTOMATION_ROUTE_ADD_ERROR_ATTR}="dishes"`,
    );
    expect(rig.host.innerHTML).toContain('recipe definitions unavailable');

    clickAddRetry(rig.host, 'dishes');
    clickAddRetry(rig.host, 'dishes');
    expect(recipeEntriesCaller).toHaveBeenCalledTimes(2);
    retry.resolve({ recipes: [recipeEntry()] });
    await flush();
    expect(rig.host.innerHTML).not.toContain(AUTOMATION_ROUTE_ADD_ERROR_ATTR);
  });
});

// ── D-261 — removing an approval from the rule it was armed on ──────────────
//
// Before this, a pre-approved rule offered only a LINK to the review page, so
// undoing an approval meant navigating away from the surface that armed it.

const preapproved = { proposal_id: 'pap_1', future_execution_ref: 'fx_1',
  execution_status: 'active' as const };

// ── D-261 §6.2 — the client asks what the server can actually pre-approve ────
//
// The server computed this on every boot and no client ever asked, so the offer
// was gated on `lifecycle_revision` alone — which proves the repository composed
// and nothing about what can be frozen.
describe('Automation route — activation-kind capability gate', () => {
  const armable = (over: Partial<BootstrapAutomationRouteOptions> = {}) => mountRoute({
    initialSection: 'schedules',
    schedulesListCaller: async () => ({
      schedules: [{ ...schedule(), lifecycle_revision: 3 }],
    }) as never,
    preapprovalPrepareCaller: (async () => ({})) as never,
    onPreapprovalPrepared: () => {},
    ...over,
  });
  const caps = (kinds: string[]) => async () => ({
    protocol_version: 1, activation_kinds: kinds, bindings: [],
    child_calls: [], decision_channels: ['webclient'], limits: {},
  }) as never;

  it('offers the review when the server advertises that activation kind', async () => {
    const rig = armable({ preapprovalCapabilitiesCaller: caps(['next_schedule', 'next_auto_run']) });
    await rig.route.whenLoaded();
    // The offer lives on the rule's DETAIL view. Without opening it the
    // NEGATIVE case below would pass for the wrong reason.
    clickAction(rig.host, 'detail:schedule', 'sch_1');
    expect(rig.host.innerHTML).toContain('Look at the next run');
  });

  /** ⛔ THE POINT. A server that cannot freeze this kind used to get a button
   *  that led straight to a refusal. */
  it('withdraws the offer when the server does not advertise it', async () => {
    const rig = armable({ preapprovalCapabilitiesCaller: caps(['next_auto_run']) });
    await rig.route.whenLoaded();
    // The offer lives on the rule's DETAIL view. Without opening it the
    // NEGATIVE case below would pass for the wrong reason.
    clickAction(rig.host, 'detail:schedule', 'sch_1');
    expect(rig.host.innerHTML).not.toContain('Look at the next run');
  });

  /** ⚠ MONOTONE: an unanswered capability set must not withdraw a feature the
   *  server does support — a transient rpc failure is not a capability answer. */
  it('keeps the prior behaviour when the capability call fails', async () => {
    const rig = armable({ preapprovalCapabilitiesCaller: async () => { throw new Error('offline'); } });
    await rig.route.whenLoaded();
    // The offer lives on the rule's DETAIL view. Without opening it the
    // NEGATIVE case below would pass for the wrong reason.
    clickAction(rig.host, 'detail:schedule', 'sch_1');
    expect(rig.host.innerHTML).toContain('Look at the next run');
  });

  it('keeps the prior behaviour when the host wires no capability caller', async () => {
    const rig = armable();
    await rig.route.whenLoaded();
    // The offer lives on the rule's DETAIL view. Without opening it the
    // NEGATIVE case below would pass for the wrong reason.
    clickAction(rig.host, 'detail:schedule', 'sch_1');
    expect(rig.host.innerHTML).toContain('Look at the next run');
  });
});

describe('Automation route — pre-approved marker on the list row', () => {
  const listed = (execution_status: string) => mountRoute({
    initialSection: 'schedules',
    schedulesListCaller: async () => ({
      schedules: [{ ...schedule(), lifecycle_revision: 3,
        preapproval: { ...preapproved, execution_status } }],
    }) as never,
  });

  it('marks an armed rule in the list, so "what runs tonight without asking me" is answerable here', async () => {
    const rig = listed('active');
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).toContain(AUTOMATION_ROUTE_PREAPPROVAL_ATTR);
    expect(rig.host.innerHTML).toContain('Pre-approved');
  });

  it('leaves an ordinary rule unmarked', async () => {
    const rig = mountRoute({ initialSection: 'schedules' });
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).not.toContain(AUTOMATION_ROUTE_PREAPPROVAL_ATTR);
  });

  /** ⛔ THE ONE THE MARKER IS REALLY FOR. A reviewed run that paused on an
   *  UNCOVERED call is waiting for an answer the owner does not know is owed —
   *  the schedule looks armed and on, and nothing is moving. */
  it('flags a held run for attention rather than reading as calmly approved', async () => {
    const rig = listed('held');
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).toContain('Already said yes · still needs you');
    expect(rig.host.innerHTML).toMatch(/data-recued-automation-preapproval[^>]*data-attention="yes"/);
  });

  it('flags an unconfirmed run the same way', async () => {
    const rig = listed('in_doubt');
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).toContain('Pre-approved · unconfirmed');
    expect(rig.host.innerHTML).toMatch(/data-recued-automation-preapproval[^>]*data-attention="yes"/);
  });

  /** A spent approval must not keep claiming it covers the next run. */
  it('says a terminal approval is over, not that it still covers the next run', async () => {
    const rig = listed('expired');
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).toContain('Pre-approval expired');
    expect(rig.host.innerHTML).not.toMatch(/>Pre-approved</);
  });
});

describe('Automation route — remove pre-approval', () => {
  const armed = (overrides: Partial<BootstrapAutomationRouteOptions> = {}) =>
    mountRoute({
      initialSection: 'schedules',
      schedulesListCaller: async () => ({
        schedules: [{ ...schedule(), lifecycle_revision: 3, preapproval: preapproved }],
      }),
      ...overrides,
    });

  it('offers Remove pre-approval on an armed rule, and only after confirming does it revoke', async () => {
    const remove = vi.fn(async (_proposalId: string, _requestId: string) => {});
    const rig = armed({ preapprovalRemoveCaller: remove });
    await rig.route.whenLoaded();

    // ⚠ The pre-approval controls live on the rule's DETAIL view, not the list
    // row — that is where `Review approval` already was, and putting Remove
    // anywhere else would split one decision across two surfaces.
    clickAction(rig.host, 'detail:schedule', 'sch_1');

    // The review link stays — removing is the second, destructive option.
    expect(rig.host.innerHTML).toContain('Look at this run');
    expect(rig.host.innerHTML).toContain('Remove pre-approval');

    // ⛔ ONE PRESS IS NOT A REVOCATION. It only arms the confirm, exactly like
    // the row's own Remove. An owner who mis-clicks loses nothing.
    clickAction(rig.host, 'preapproval-remove:schedule', 'sch_1');
    expect(remove).not.toHaveBeenCalled();
    expect(rig.host.innerHTML).toContain('Yes, take back this approval');

    clickAction(rig.host, 'preapproval-remove-confirm:schedule', 'sch_1');
    await flush();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]![0]).toBe('pap_1');
  });

  it('Keep backs out without revoking', async () => {
    const remove = vi.fn(async (_proposalId: string, _requestId: string) => {});
    const rig = armed({ preapprovalRemoveCaller: remove });
    await rig.route.whenLoaded();
    clickAction(rig.host, 'detail:schedule', 'sch_1');

    clickAction(rig.host, 'preapproval-remove:schedule', 'sch_1');
    clickAction(rig.host, 'preapproval-remove-cancel:schedule', 'sch_1');
    expect(remove).not.toHaveBeenCalled();
    expect(rig.host.innerHTML).toContain('Remove pre-approval');
    expect(rig.host.innerHTML).not.toContain('Yes, take back this approval');
  });

  /** ⚠ The repository dedupes revocations on `(request_id, responder_key)` and
   *  REFUSES a reused key carrying different input. So a retry after a lost
   *  response must replay the SAME id — a fresh uuid per press would turn one
   *  owner intent into two revocation attempts. */
  it('replays the same request id when the first attempt fails', async () => {
    const remove = vi.fn(async (_proposalId: string, _requestId: string) => { throw new Error('connection lost'); });
    const rig = armed({ preapprovalRemoveCaller: remove });
    await rig.route.whenLoaded();
    clickAction(rig.host, 'detail:schedule', 'sch_1');

    clickAction(rig.host, 'preapproval-remove:schedule', 'sch_1');
    clickAction(rig.host, 'preapproval-remove-confirm:schedule', 'sch_1');
    await rig.route.whenLoaded(); await flush(); await rig.route.whenLoaded();

    clickAction(rig.host, 'preapproval-remove:schedule', 'sch_1');
    clickAction(rig.host, 'preapproval-remove-confirm:schedule', 'sch_1');
    await rig.route.whenLoaded(); await flush(); await rig.route.whenLoaded();

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls[1]![1]).toBe(remove.mock.calls[0]![1]);
  });

  /** Absent caller ⇒ the row degrades to what it was: review-page only. */
  it('renders no remove button when the host wires no caller', async () => {
    const rig = armed();
    await rig.route.whenLoaded();
    clickAction(rig.host, 'detail:schedule', 'sch_1');
    expect(rig.host.innerHTML).toContain('Look at this run');
    expect(rig.host.innerHTML).not.toContain('Remove pre-approval');
  });
});

describe('Automation route — a trigger on facts read from mail (D-315)', () => {
  const wine = {
    id: 'custom_wine_club_box' as const,
    name: 'Wine club box',
    description: '',
    variables: [{ name: 'club', kind: 'text' as const, required: true }],
    states: ['shipped'],
    notices: [],
    identity: [],
  };
  const factTriggers = async () => ({
    triggers: [
      trigger({
        pattern: 'data.mail_fact.*.thing.*',
        fields: ['state'],
        filter: { 'record.state': 'delivered', 'record.template': 'mtpl_1' },
      }),
      trigger({ trigger_id: 't-2', pattern: 'data.mail_fact.custom_wine_club_box.thing.*' }),
    ],
  });

  it('says it in words in the list and the detail, naming its template and the owner’s kind', async () => {
    const mailFactTemplatesCaller = vi.fn(async () => ({
      templates: [{ template_id: 'mtpl_1', name: 'UPS notices', type: 'shipment' }],
    }));
    const rig = mountRoute({
      initialSection: 'triggers',
      triggersListCaller: factTriggers,
      mailFactTemplatesCaller,
      mailFactTypesCaller: async () => ({ types: [wine] }),
    });
    await rig.route.whenLoaded();
    await vi.waitFor(() => expect(rig.host.innerHTML).toContain('read by “UPS notices”'));
    const html = rig.host.innerHTML;
    expect(html).toContain('on a fact read from mail, when state changes, only when state is delivered, read by “UPS notices”');
    expect(html).toContain('on a wine club box read from mail, on every change');
    // Not the pattern and the compiled filter it was said as before.
    expect(html).not.toContain('<code>data.mail_fact');
    expect(html).not.toContain('record.template = mtpl_1');
    expect(html).not.toContain('when state changes</span>');

    clickAction(rig.host, 'detail:event_trigger', 't-1');
    const detail = rig.host.innerHTML;
    expect(detail).toContain('<dt>Starts on</dt><dd>a fact read from mail, when state changes, only when state is delivered, read by “UPS notices”</dd>');
    expect(detail).not.toContain('<dt>Pattern</dt>');
    expect(detail).not.toContain('<dt>Fields</dt>');
  });

  it('reads no templates for triggers that are not on facts', async () => {
    const mailFactTemplatesCaller = vi.fn(async () => ({ templates: [] }));
    const rig = mountRoute({ initialSection: 'triggers', mailFactTemplatesCaller });
    await rig.route.whenLoaded();
    expect(mailFactTemplatesCaller).not.toHaveBeenCalled();
    expect(rig.host.innerHTML).toContain('on <code>data.mail.**</code>');
  });

  it('says “one template”, never a deleted one, when the templates could not be read', async () => {
    const rig = mountRoute({
      initialSection: 'triggers',
      triggersListCaller: factTriggers,
      mailFactTemplatesCaller: vi.fn(async () => { throw new Error('The server did not answer'); }),
    });
    await rig.route.whenLoaded();
    await flush();
    expect(rig.host.innerHTML).toContain('only when state is delivered, read by one template');
    expect(rig.host.innerHTML).not.toContain('deleted');
  });
});
