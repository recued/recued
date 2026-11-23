/** D-402 slice B2 — a selector worked out on the server from the read that showed a ref (§4, rule 3):
 *  what a site is least likely to change, checked to match that one element in the read, never a
 *  place among siblings; and the plan keeping each read's HTML within its own budget. */
import { describe, expect, it } from 'vitest';
import { BROWSER_PLAN_MAX_READ_BYTES, createBrowserFlowRecorder, type BrowserPlanCallWithSteps } from '../bridges/browser-flow-record.js';
import { countShowing, selectorForRef, textForRef } from '../bridges/html-selector.js';
import { compilePlan } from '../plan-compiler.js';

const PAGE = `<header id="mw-head"><form id="searchform" action="/w/index.php"><input id="searchInput" name="search" ref="e4" placeholder="Search Wikipedia">
<button class="cdx-button search-button" ref="e5" type="submit">Search</button></form></header>
<main><div id="ember1234567"><input name="email" ref="e6"></div>
<button class="action" aria-label="Save draft" ref="e7">Save</button><button class="action" aria-label="Send now" ref="e8">Send</button>
<nav id="sidebar"><a class="nav" href="/one" ref="e9">One</a></nav><nav class="footer-links"><a class="nav" href="/one" ref="e10">One</a></nav>
<ul><li><a href="#" ref="e11">More</a></li><li><a href="#" ref="e12">More</a></li></ul>
<input id="ember98765432" name="phone" ref="e13"></main>`;

describe('D-402 slice B2 — a selector from what was read', () => {
  it('names an element by what lasts: an id written by hand, a field\'s name, its label, a class', () => {
    expect(selectorForRef(PAGE, 'e4')).toBe('#searchInput');
    expect(selectorForRef(PAGE, 'e5')).toBe('button.cdx-button');
    // An id a framework counted out is passed over for the field's name, on the element or around it.
    expect(selectorForRef(PAGE, 'e6')).toBe('input[name="email"]');
    expect(selectorForRef(PAGE, 'e13')).toBe('input[name="phone"]');
    // Two buttons alike but for their labels.
    expect(selectorForRef(PAGE, 'e7')).toBe('button[aria-label="Save draft"]');
    expect(selectorForRef(PAGE, 'e8')).toBe('button[aria-label="Send now"]');
  });

  it('scopes to an ancestor a selector finds alone, and never names an element by its place', () => {
    expect(selectorForRef(PAGE, 'e9')).toBe('#sidebar a[href="/one"]');
    expect(selectorForRef(PAGE, 'e10')).toBe('nav.footer-links a[href="/one"]');
    // Two links alike in one list: no lasting name finds either alone.
    expect(selectorForRef(PAGE, 'e11')).toBeUndefined();
    expect(textForRef(PAGE, 'e11')).toBe('More');
    expect(selectorForRef(PAGE, 'e99')).toBeUndefined();
  });

  it('the compiler names a ref\'s element by the read before the call when the Bridge recorded no selector', () => {
    const MAIN = 'https://en.wikipedia.org/wiki/Main_Page';
    const page = 'bridge:work:3:D1';
    const calls: BrowserPlanCallWithSteps[] = [
      { run_id: 'r1', recipe_id: 'inspect-web-page', args: { page }, started_at: 1, finished_at: 1, outcome: 'done', bridge_ids: ['work'],
        acted: [], results: [{ step_id: 'inspect', result: { page, url: MAIN } }], reads: [{ page, url: MAIN, html: PAGE }] },
      { run_id: 'r2', recipe_id: 'read-web-element', args: { page, ref: 'e8' }, started_at: 2, finished_at: 2, outcome: 'done',
        bridge_ids: ['work'], acted: [], results: [{ step_id: 'read', result: { page, url: MAIN } }] },
      { run_id: 'r3', recipe_id: 'save-web-file', args: { page, ref: 'e11' }, started_at: 3, finished_at: 3, outcome: 'done',
        bridge_ids: ['work'], acted: [], results: [{ step_id: 'save', result: { page, url: MAIN } }] },
    ];
    const { recipe, notes } = compilePlan({ calls, by: 'chat' });
    expect((recipe.steps[0] as unknown as { args: { steps: unknown[] } }).args.steps).toEqual([
      { url: MAIN, do: 'read', selector: 'button[aria-label="Send now"]' },
      { do: 'download', text: 'More' },
    ]);
    // Slice B3 (rule 3): a download's link is named by its text, which another day's file keeps.
    expect(notes).toEqual([]);
  });

  it('the compiler names a clicked element by the read when the Bridge described it without a selector', () => {
    const MAIN = 'https://en.wikipedia.org/wiki/Main_Page';
    const page = 'bridge:work:3:D1';
    const { recipe, notes } = compilePlan({ by: 'chat', calls: [
      { run_id: 'r1', recipe_id: 'inspect-web-page', args: { page }, started_at: 1, finished_at: 1, outcome: 'done', bridge_ids: ['work'],
        acted: [], results: [{ step_id: 'inspect', result: { page, url: MAIN } }], reads: [{ page, url: MAIN, html: PAGE }] },
      { run_id: 'r2', recipe_id: 'click-web-element', args: { page, ref: 'e7' }, started_at: 2, finished_at: 2, outcome: 'done',
        bridge_ids: ['work'], acted: [{ do: 'click', url: MAIN, title: 'Main', element: { role: 'button', label: 'Save' }, at: 2, position: 1 }],
        results: [{ step_id: 'click', result: { page, url: MAIN } }] },
    ] });
    expect((recipe.steps[0] as unknown as { args: { steps: unknown[] } }).args.steps).toEqual([
      { url: MAIN, do: 'click', selector: 'button[aria-label="Save draft"]' }]);
    expect(notes).toEqual([]);
  });
});

describe('D-402 slice B2 — the plan keeps each read', () => {
  it('beside its call, within a budget of its own, and without what went into a protected field', () => {
    const flows = createBrowserFlowRecorder({ now: () => 5 });
    flows.bindRun('run-1', { session_id: 's', turn_id: 't' });
    flows.startCall('run-1', { recipe_id: 'act-on-web-page', browser: true, args: { page: 'p', steps: [{ do: 'type', ref: 'e1', value: 's3cret!' }] } });
    flows.recordRead('run-1', { page: 'p', url: 'https://example.com/', html: '<input value="s3cret!" ref="e1">' });
    flows.finishCall('run-1', { outcome: 'done', steps: [] });
    expect(flows.planFor('s', () => true)[0]!.reads).toEqual([{ page: 'p', url: 'https://example.com/', html: '<input value="[typed]" ref="e1">' }]);
    const big = 'x'.repeat(BROWSER_PLAN_MAX_READ_BYTES / 2 + 10);
    for (const run of ['run-2', 'run-3', 'run-4']) {
      flows.bindRun(run, { session_id: 's', turn_id: 't' });
      flows.startCall(run, { recipe_id: 'inspect-web-page', browser: true, args: { page: 'p' } });
      flows.recordRead(run, { page: 'p', url: 'https://example.com/', html: big });
    }
    const plan = flows.planFor('s', () => true);
    expect(plan.map((call) => call.reads === undefined ? 'dropped' : 'kept')).toEqual(['dropped', 'dropped', 'dropped', 'kept']);
    expect(plan[1]!.reads_dropped).toBe(true);
  });

  it('how many elements a read shows under a name: by text, or a field by its name or label; the innermost (slice B4)', () => {
    const html = '<ul><li><button ref="e1">Delete</button></li><li><button ref="e2">Delete</button></li></ul>'
      + '<input type="checkbox" name="checkboxes[]"><input type="checkbox" name="checkboxes[]"><input aria-label="Search">';
    expect(countShowing(html, 'Delete')).toBe(2);
    expect(countShowing(html, 'checkboxes[]')).toBe(2);
    expect(countShowing(html, 'Search')).toBe(1);
    expect(countShowing(html, 'Archive')).toBe(0);
  });
});

