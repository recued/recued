/** D-266 — the missed-run card mounted on the Automation route.
 *
 *  The card is the whole point of the `Ask me` policy: without a place
 *  that asks, choosing it means the schedule quietly stops running and
 *  nobody is ever told. So the properties that matter here are that it
 *  APPEARS, that answering it reaches the server, and that a failure to
 *  read it never makes a still-outstanding question disappear.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ServerSchedule } from '@recued/contracts';
import { MISSED_RUNS_ACTION_ATTR } from '@recued/ui-shared';
import {
  AUTOMATION_ROUTE_STATUS_FILTER_ATTR,
  bootstrapAutomationRoute,
  type BootstrapAutomationRouteOptions,
  type SchedulesAnswerMissedCaller,
  type SchedulesMissedCaller,
} from '../automation/bootstrap-automation-route.js';

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

interface FakeEl {
  tagName: string;
  innerHTML: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  removeEventListener(): void;
  querySelector(): null;
  querySelectorAll(): never[];
  remove(): void;
  focus(): void;
  hasAttribute(name: string): boolean;
  closest(): null;
  isConnected: boolean;
  textContent: string;
}

const makeFakeEl = (tagName: string): FakeEl => {
  const el: FakeEl = {
    tagName,
    innerHTML: '',
    textContent: '',
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    isConnected: true,
    setAttribute(name, value) { this.attrs.set(name, value); },
    getAttribute(name) { return this.attrs.get(name) ?? null; },
    hasAttribute(name) { return this.attrs.has(name); },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    },
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    remove() {},
    focus() {},
    closest() { return null; },
  };
  return el;
};

const makeFakeDocument = () => ({
  body: makeFakeEl('body'),
  activeElement: null,
  head: { querySelector: () => null, appendChild: (el: unknown) => el },
  createElement: (tag: string) => makeFakeEl(tag),
  addEventListener: () => {},
  removeEventListener: () => {},
});

const schedule = (over: Partial<ServerSchedule> = {}): ServerSchedule => ({
  schedule_id: 'sch_1',
  recipe_id: 'daily-brief',
  publisher_id: 'recued-core',
  cron_expression: '0 9 * * *',
  enabled: true,
  created_at: NOW - 10_000,
  last_run_at: NOW - 4 * DAY,
  next_run_at: NOW + 5_000,
  last_status: 'success',
  last_error: null,
  missed_policy: 'ask',
  ...over,
});

const waitingReport = () => ({
  outage_from: NOW - 4 * DAY,
  outage_to: NOW,
  entries: [{
    recipe_id: 'daily-brief',
    recipe_name: 'Daily brief',
    schedule_ids: ['sch_1'],
    missed_cycles: 3 as number | 'unknown',
    last_run_at: NOW - 4 * DAY,
  }],
});

const emptyReport = () => ({ outage_from: null, outage_to: NOW, entries: [] });

const mountRoute = (overrides: Partial<BootstrapAutomationRouteOptions> = {}) => {
  const doc = makeFakeDocument();
  const root = makeFakeEl('div');
  const route = bootstrapAutomationRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    schedulesListCaller: async () => ({ schedules: [schedule()] }),
    triggersListCaller: async () => ({ triggers: [] }),
    autoRunListCaller: async () => ({ entries: [] }),
    watchListCaller: async () => ({ watches: [] }),
    initialSection: 'schedules',
    now: () => NOW,
    ...overrides,
  });
  return { doc, root, host: root.children[0]!, route };
};

const clickCardAction = (host: FakeEl, value: string): void => {
  const target = {
    closest: (selector: string) =>
      selector === `[${MISSED_RUNS_ACTION_ATTR}]`
        ? { getAttribute: (n: string) => (n === MISSED_RUNS_ACTION_ATTR ? value : null) }
        : null,
  };
  for (const fn of host.listeners.get('click') ?? []) fn({ target } as unknown as Event);
};

describe('D-266 — the schedule ROW, not just the card', () => {
  it('⛔ a waiting schedule reads "Waiting on you", not "On"', async () => {
    // It is `enabled: true`, so before this it rendered identically to a
    // schedule running fine. The card says SOMETHING is waiting; only the
    // row says WHICH, and that is the whole question in a long list.
    const rig = mountRoute({
      schedulesMissedCaller: async () => waitingReport(),
    });
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).toContain('Waiting on you');
    expect(rig.host.innerHTML).toContain('data-armed="waiting"');
  });

  it('a schedule with nothing waiting still reads "On"', async () => {
    const rig = mountRoute({ schedulesMissedCaller: async () => emptyReport() });
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).not.toContain('data-armed="waiting"');
    expect(rig.host.innerHTML).toContain('data-armed="on"');
  });

  it('⛔ the mark comes from the SAME report as the card — they cannot disagree', async () => {
    // Both read `missedRuns`; a second source would let the card say
    // "Morning brief is waiting" beside a row that says it is fine.
    const rig = mountRoute({ schedulesMissedCaller: async () => waitingReport() });
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).toContain('While I was off');
    expect(rig.host.innerHTML).toContain('data-armed="waiting"');
  });

  it('⛔ an overdue row says what was DUE and how late — never "next <future date>"', async () => {
    // `next_run_at` in the past IS the missed slot. Rendering it under
    // the word "next" reads as healthy, which is the one thing an
    // overdue row must not do.
    const rig = mountRoute({
      schedulesListCaller: async () => ({
        schedules: [schedule({ next_run_at: NOW - 29 * 60_000 })],
      }),
      schedulesMissedCaller: async () => emptyReport(),
    });
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).toContain('29 min late');
    expect(rig.host.innerHTML).toContain('due ');
    expect(rig.host.innerHTML).not.toMatch(/next [A-Z0-9]/);
  });

  it('a PAUSED schedule is not called late', async () => {
    const rig = mountRoute({
      schedulesListCaller: async () => ({
        schedules: [schedule({ enabled: false, next_run_at: NOW - 3 * 86_400_000 })],
      }),
      schedulesMissedCaller: async () => emptyReport(),
    });
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).not.toContain('late');
  });
});

describe('D-319 §5.4 — what is waiting is findable', () => {
  it('⛔ the "Waiting on you" filter keeps the waiting row (it matched none)', async () => {
    // The filter tested `enabled` before the row worked out it was
    // waiting, so the one state it exists to find was never shown.
    const rig = mountRoute({
      schedulesListCaller: async () => ({
        schedules: [schedule(), schedule({ schedule_id: 'sch_2', recipe_id: 'other' })],
      }),
      schedulesMissedCaller: async () => waitingReport(),
    });
    await rig.route.whenLoaded();
    for (const fn of rig.host.listeners.get('change') ?? []) {
      fn({
        target: { value: 'waiting', hasAttribute: (name: string) => name === AUTOMATION_ROUTE_STATUS_FILTER_ATTR },
      });
    }
    expect(rig.host.innerHTML).toContain('data-recued-automation-row="schedule:sch_1"');
    expect(rig.host.innerHTML).not.toContain('data-recued-automation-row="schedule:sch_2"');
  });

  it('on the one list, a waiting schedule puts its dish under Needs you', async () => {
    const rig = mountRoute({
      initialSection: 'all',
      schedulesListCaller: async () => ({ schedules: [schedule({ dish_id: 'dsh_main' })] }),
      dishesListCaller: async () => ({
        dishes: [{
          dish_id: 'dsh_main', recipe_id: 'daily-brief', publisher_id: 'recued-core', name: '',
          is_default: true, config_overlay: {}, enabled: true, created_at: 1,
        }],
      }),
      schedulesMissedCaller: async () => waitingReport(),
    });
    await rig.route.whenLoaded();
    const html = rig.host.innerHTML;
    // The card heads the list: it is what the owner answers.
    expect(html).toContain('While I was off');
    expect(html.indexOf('While I was off')).toBeLessThan(html.indexOf('data-recued-automation-dish="dsh_main"'));
    expect(html).toMatch(/data-recued-automation-chip="needs-you"[^>]*>Needs you <span class="automation-chip-count">1<\/span>/);
    expect(html).toContain('automation-dish-status--needs-you">Needs you</span>');
  });
});

describe('D-266 — the schedule DETAIL panel', () => {
  const openDetail = async (over: Partial<ServerSchedule>) => {
    const rig = mountRoute({
      schedulesListCaller: async () => ({ schedules: [schedule(over)] }),
      schedulesMissedCaller: async () => emptyReport(),
      initialSection: 'schedules',
      initialDetailId: 'sch_1',
    });
    await rig.route.whenLoaded();
    return rig;
  };

  it('⛔ shows the FORENSIC PAIR — when it stopped, and whether it was fine before', async () => {
    // `Last run` alone cannot answer the question you actually have in
    // front of a broken schedule: was this working yesterday, or has it
    // never worked? That needs the run before it.
    const rig = await openDetail({
      last_run_at: NOW - 30 * DAY,
      prev_run_at: NOW - 31 * DAY,
      next_run_at: NOW - 29 * DAY,
      missed_cycles: 29,
    });
    expect(rig.host.innerHTML).toContain('Before that');
    expect(rig.host.innerHTML).toContain('Missed since');
    expect(rig.host.innerHTML).toContain('30 runs');
  });

  it('says "—" for a schedule that has only ever run once, rather than hiding the row', async () => {
    // Absence is itself the answer; a missing row reads as "not measured".
    const rig = await openDetail({ last_run_at: NOW - DAY, prev_run_at: null });
    expect(rig.host.innerHTML).toContain('Before that');
  });

  it('⛔ an overdue detail says DUE, never a future-looking "Next run"', async () => {
    const rig = await openDetail({ next_run_at: NOW - 29 * 60_000 });
    expect(rig.host.innerHTML).toContain('29 min late');
    expect(rig.host.innerHTML).not.toContain('Next run');
  });

  it('omits the missed count when the server did not send one', async () => {
    const rig = await openDetail({ next_run_at: NOW + DAY });
    expect(rig.host.innerHTML).not.toContain('Missed since');
  });
});

describe('D-266 — the card on the Automation route', () => {
  it('renders above the Schedules list when something is waiting', async () => {
    const rig = mountRoute({
      schedulesMissedCaller: vi.fn<SchedulesMissedCaller>(async () => waitingReport()),
    });
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).toContain('While I was off');
    expect(rig.host.innerHTML).toContain('Daily brief');
    // The count is the record of the outage: 3 full cycles beyond the one
    // catch-up on offer is four missed runs.
    expect(rig.host.innerHTML).toContain('missed 4');
  });

  it('⛔ carries the CAPPED flag through the rpc to the card — not declared-but-unwired', async () => {
    // The server stops counting at a bound and sets `missed_cycles_capped`.
    // The card renders "N+" off it. Both halves are tested where they
    // live; this is the JOIN — the route passes the report through
    // whole, and a field added to the wire type but dropped somewhere in
    // between would leave the card stating a precise figure it does not
    // have, with every other test still green.
    const rig = mountRoute({
      schedulesMissedCaller: async () => ({
        ...waitingReport(),
        entries: [{ ...waitingReport().entries[0]!, missed_cycles_capped: true }],
      }),
    });
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).toContain('missed 4+');
  });

  it('renders nothing when nothing is waiting', async () => {
    const rig = mountRoute({
      schedulesMissedCaller: vi.fn<SchedulesMissedCaller>(async () => emptyReport()),
    });
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).not.toContain('While I was off');
  });

  it('⛔ a host that never wired the caller is not a failure — no card, no load error', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).not.toContain('While I was off');
    expect(rig.route.getLoadErrors()).toEqual({});
  });

  it('⛔ a FAILED read leaves the PRIOR card standing and adds no load error', async () => {
    let reads = 0;
    const rig = mountRoute({
      schedulesMissedCaller: async () => {
        if (reads++ === 0) return waitingReport();
        throw new Error('server said no');
      },
    });
    await rig.route.whenLoaded();
    expect(rig.host.innerHTML).toContain('While I was off');

    await rig.route.refresh();
    // The misses it names are STILL outstanding — a read that failed says
    // nothing about whether they were answered. Blanking the card would
    // make the question disappear without anyone answering it.
    expect(rig.host.innerHTML).toContain('While I was off');
    expect(rig.host.innerHTML).toContain('Daily brief');
    expect(rig.route.getLoadErrors()).toEqual({});
  });

  it('[Run them] answers every entry and re-reads the report', async () => {
    const answer = vi.fn<SchedulesAnswerMissedCaller>(async () => ({ ran: ['sch_1'], skipped: [] }));
    let reads = 0;
    const rig = mountRoute({
      schedulesMissedCaller: async () => (reads++ === 0 ? waitingReport() : emptyReport()),
      schedulesAnswerMissedCaller: answer,
    });
    await rig.route.whenLoaded();

    clickCardAction(rig.host, 'run');
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    expect(answer.mock.calls[0]![0]).toEqual({ answer: 'run' });
    // Re-read, not a local clear: the server is what knows whether a regular
    // cycle resolved some of this between the render and the click.
    await vi.waitFor(() => expect(rig.host.innerHTML).not.toContain('While I was off'));
  });

  it('a per-line [Skip] scopes the answer to that recipe alone', async () => {
    const answer = vi.fn<SchedulesAnswerMissedCaller>(async () => ({ ran: [], skipped: ['sch_1'] }));
    const rig = mountRoute({
      schedulesMissedCaller: async () => waitingReport(),
      schedulesAnswerMissedCaller: answer,
    });
    await rig.route.whenLoaded();

    clickCardAction(rig.host, 'skip:daily-brief');
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    expect(answer.mock.calls[0]![0]).toEqual({ answer: 'skip', recipe_ids: ['daily-brief'] });
  });

  it('surfaces a failed ANSWER on the card rather than swallowing it', async () => {
    const rig = mountRoute({
      schedulesMissedCaller: async () => waitingReport(),
      schedulesAnswerMissedCaller: async () => { throw new Error('could not reach the server'); },
    });
    await rig.route.whenLoaded();

    clickCardAction(rig.host, 'run');
    await vi.waitFor(() =>
      expect(rig.host.innerHTML).toContain('could not reach the server'));
    // Still standing, so the owner can try again.
    expect(rig.host.innerHTML).toContain('While I was off');
  });

  it('ignores a click while an answer is already in flight', async () => {
    const gate: { release: () => void } = { release: () => {} };
    const answer = vi.fn<SchedulesAnswerMissedCaller>(() =>
      new Promise((r) => { gate.release = () => r({ ran: [], skipped: [] }); }));
    const rig = mountRoute({
      schedulesMissedCaller: async () => waitingReport(),
      schedulesAnswerMissedCaller: answer,
    });
    await rig.route.whenLoaded();

    clickCardAction(rig.host, 'run');
    clickCardAction(rig.host, 'skip');
    expect(answer).toHaveBeenCalledTimes(1);
    gate.release();
  });
});
