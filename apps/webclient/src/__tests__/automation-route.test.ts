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
  token: 'auto-run' | 'triggers' | 'schedules' | 'dishes',
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

const clickAdd = (host: FakeEl, section: 'triggers' | 'schedules'): void => {
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

const expectSubnavCounts = (
  html: string,
  counts: { autoRun: number; triggers: number; schedules: number },
): void => {
  expect(html).toContain(
    `Auto-run <span class="automation-subnav-count">${counts.autoRun}</span>`,
  );
  expect(html).toContain(
    `Triggers <span class="automation-subnav-count">${counts.triggers}</span>`,
  );
  expect(html).toContain(
    `Schedules <span class="automation-subnav-count">${counts.schedules}</span>`,
  );
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
    expect(rig.route.getActiveSection()).toBe('auto-run');
    expect(rig.host.innerHTML).toMatch(
      /data-recued-automation-subnav="auto-run"[\s\S]*?aria-selected="true"[\s\S]*?tabindex="0"/,
    );
    expect(rig.host.innerHTML).toContain(
      'aria-controls="recued-automation-section-panel"',
    );
    expect(rig.host.innerHTML).toMatch(
      new RegExp(
        `${AUTOMATION_ROUTE_SECTION_PANEL_ATTR}[\\s\\S]*?role="tabpanel"`
          + '[\\s\\S]*?aria-labelledby="recued-automation-section-tab-auto-run"',
      ),
    );
    for (const token of ['triggers', 'schedules', 'dishes']) {
      expect(rig.host.innerHTML).toMatch(
        new RegExp(
          `data-recued-automation-subnav="${token}"[\\s\\S]*?`
          + 'aria-selected="false"[\\s\\S]*?tabindex="-1"',
        ),
      );
    }
    expectOnlySection(rig.host.innerHTML, 'auto_run');
    expectSubnavCounts(rig.host.innerHTML, {
      autoRun: 1,
      triggers: 2,
      schedules: 1,
    });
    expect(rig.host.innerHTML).toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="auto_run:ticker"`);
    expect(rig.host.innerHTML).not.toContain(`${AUTOMATION_ROUTE_ROW_ATTR}="schedule:sch_1"`);

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

  it('legacy recipe deep-link auto-pick lands on schedules for a schedule-only recipe', async () => {
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
    expect(rig.route.getActiveSection()).toBe('schedules');
    expectOnlySection(rig.host.innerHTML, 'schedule');
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
        `${AUTOMATION_ROUTE_SUBNAV_ATTR}="triggers"[\\s\\S]*?`
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
    expect(rig.route.getActiveSection()).toBe('triggers');
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
    expect(html).toContain(`${AUTOMATION_ROUTE_SECTION_ATTR}="auto_run"`);
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
