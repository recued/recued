/** Display mode's refresh rule, isolated from the route's DOM.
 *
 *  ⛔ WHAT MATTERS HERE IS THE GUARD, NOT THE SUBSCRIBE. A refresh run emits its
 *  own `execution` events, so a handler that reacts to everything re-triggers
 *  itself into a loop that never settles. The rule falls out of what a display
 *  board IS — all-Records reads (internal design notes § 3) — so a run
 *  that cannot write cannot be the cause of its own staleness, and its own
 *  events are definitionally irrelevant.
 *
 *  ⚠ Deliberately NOT a debounce. A timer would slow the loop while making the
 *  screen laggy: the wrong fix for a self-trigger, and one that still loops.
 */
import { describe, expect, it } from 'vitest';
import { shouldRefreshDisplayedBoard as shouldRefresh } from '../recipes/bootstrap-recipes-route.js';
import {
  RESULT_DISPLAY_MODE_ATTR,
  createResultActionRegistry,
  renderRecipeResultPanel,
  type RecipesResultPanelSnapshot,
} from '../recipes/recipe-result-panel.js';


const base = {
  displayMode: true, busy: false, shown: 'list-job-board',
  // P4 — the board's last run was audit-exempt, so refreshing it is free.
  lastRunAuditExempt: true as boolean | undefined,
};

describe('display mode — when a board refreshes', () => {
  it('refreshes when a DIFFERENT recipe completes', () => {
    // The clerk calls the next number on another device; the board is stale
    // until it re-reads.
    expect(shouldRefresh({ ...base, event: { op: 'complete', recipe_id: 'call-next-in-queue', audit_exempt: false } }))
      .toBe(true);
  });

  it('IGNORES the displayed board completing — that is its own refresh', () => {
    // ⛔ THE LOOP GUARD. Without this the board's own run re-triggers the
    // handler, which runs the board, which completes, forever.
    expect(shouldRefresh({ ...base, event: { op: 'complete', recipe_id: 'list-job-board', audit_exempt: false } }))
      .toBe(false);
  });

  it('ignores start and progress — the data is not settled until the writer commits', () => {
    for (const op of ['start', 'progress', 'queued', 'slot_acquired']) {
      expect(shouldRefresh({ ...base, event: { op, recipe_id: 'call-next-in-queue', audit_exempt: false } }))
        .toBe(false);
    }
  });

  it('does nothing while display mode is off', () => {
    expect(shouldRefresh({
      ...base, displayMode: false, event: { op: 'complete', recipe_id: 'call-next-in-queue', audit_exempt: false },
    })).toBe(false);
  });

  it('does not stack refreshes while one is in flight', () => {
    expect(shouldRefresh({
      ...base, busy: true, event: { op: 'complete', recipe_id: 'call-next-in-queue', audit_exempt: false },
    })).toBe(false);
  });

  it('does nothing with no board on screen', () => {
    expect(shouldRefresh({
      ...base, shown: undefined, event: { op: 'complete', recipe_id: 'call-next-in-queue', audit_exempt: false },
    })).toBe(false);
  });

  it('REFUSES a board whose last run was not audit-exempt', () => {
    // ⛔ The board grew a non-Records step — a vendor read, a notification, an
    // `ai-*` call — so each tick would now write an audit anchor, and the
    // retention pruner pays for those by evicting the OLDEST rows: the real
    // history. A screen that stops refreshing is the cheaper failure.
    expect(shouldRefresh({
      ...base, lastRunAuditExempt: false,
      event: { op: 'complete', recipe_id: 'call-next-in-queue', audit_exempt: false },
    })).toBe(false);
  });

  it('treats an UNKNOWN exemption as no, never as yes', () => {
    // A server too old to send the field, or a board that has not run yet. The
    // fail-safe reading is that the run DID audit: being wrong costs a screen
    // that does not refresh, against a log that quietly fills.
    expect(shouldRefresh({
      ...base, lastRunAuditExempt: undefined,
      event: { op: 'complete', recipe_id: 'call-next-in-queue', audit_exempt: false },
    })).toBe(false);
  });

  it('IGNORES a read completing — including another display refreshing', () => {
    // ⛔⛔ THE LOOP. Two clients in display mode showing DIFFERENT boards
    // triggered each other forever: A's refresh read to B as a real change and
    // B's read the same to A. A live two-client drive measured ~135 runs/second
    // with symmetric counts. A read changed nothing, so it is never a reason to
    // re-read — not just my own read, ANY read.
    expect(shouldRefresh({
      ...base, event: { op: 'complete', recipe_id: 'list-reclaimable-jobs', audit_exempt: true },
    })).toBe(false);
  });

  it('treats an event with no exemption answer as DO NOT REFRESH', () => {
    // ⚠ The opposite fail-safe to `lastRunAuditExempt`, deliberately. There the
    // question is "may I run at all" so unknown refuses; here it is "did
    // something change", where a stale screen is cheap and the loop is not.
    expect(shouldRefresh({
      ...base, event: { op: 'complete', recipe_id: 'call-next-in-queue' },
    })).toBe(false);
  });

  it('treats a malformed event as not-a-reason', () => {
    // A negative must name its cause: absent op, absent recipe, wrong types —
    // none of them is evidence that something changed.
    for (const event of [{}, { op: 'complete' }, { recipe_id: 'x' }, { op: 7, recipe_id: 9 }]) {
      expect(shouldRefresh({ ...base, event })).toBe(false);
    }
  });
});

describe('display mode — the screen scale (P5)', () => {
  const REGISTRY = createResultActionRegistry([], new Map(), false, new Set(), new Map(), new Set());
  const panel = {
    route_recipe_id: 'list-job-board',
    source_recipe_id: null,
    render_recipe_id: 'list-job-board',
    origin: 'run',
    result: {
      recipe_id: 'list-job-board', recipe_hash: 'h', success: true, duration_ms: 1,
      steps: [], errors: [],
      output: { render: [{ type: 'table', source: 'step.t', data: {
        columns: [{ field: 'code', label: 'Code' }], rows: [{ code: 'J-1' }],
      } }], sidebar: [] },
    },
  } as unknown as RecipesResultPanelSnapshot;

  const render = (display: boolean | undefined): string =>
    renderRecipeResultPanel(panel, [], REGISTRY, new Map(), new Map(), false,
      display === undefined ? {} : { display_mode: display });

  it('stamps the screen state on the host, so the scale has something to key on', () => {
    expect(render(true)).toContain(RESULT_DISPLAY_MODE_ATTR);
  });

  it('leaves an ordinary pane unstamped — including when the host wired no prefs rpc', () => {
    // ⛔ Three states, and only one of them is a screen: `true` is a screen,
    // `false` is a wired pane, `undefined` is a host with no prefs rpc at all.
    // The last two must render identically; a pane that picked up the scale
    // because the control was merely absent would be a very visible bug.
    expect(render(false)).not.toContain(RESULT_DISPLAY_MODE_ATTR);
    expect(render(undefined)).not.toContain(RESULT_DISPLAY_MODE_ATTR);
  });
});
