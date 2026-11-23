/** 2026-11-21 (the owner: "fix all") — a Google vignette ad over a page: its address gains `#google_vignette`, the
 *  page's body is marked aria-hidden, and a read keeps nothing. Every read of such a page says so and how to close it
 *  (`PAGE_COVERED_BY_AD_NOTE`), rather than answering an empty page as complete. Bench task P lost 33 of 37 covered runs
 *  to empty reads the model could do nothing with. */
import { expect, it, vi } from 'vitest';
import { createBridgeDomAdapter, PAGE_COVERED_BY_AD_NOTE, PAGE_END_NOTE, pageCoveredByAd } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

const page = 'bridge:work:7:NOTES', app = 'https://practice.example/notes/app', covered = `${app}#google_vignette`;
const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'work', attempts: 1,
  result: { command_id: 'c', status: 'ok', bridge_version: '0.0.12', duration_ms: 1, idempotency_key_seen: false, outputs } });
// What the Bridge sends for a page whose body is aria-hidden: nothing it may read.
const hidden = { page, url: covered, title: 'Notes', html: '', loading: false, truncated: false };
const shown = { page, url: app, title: 'Notes', html: '<main><h1>My notes</h1><button ref="e1">Edit</button></main>', loading: false, truncated: false };
const setup = (answer: (request: DispatchRequest) => DispatchOutcome) => {
  const dispatch = vi.fn(async (request: DispatchRequest) => answer(request));
  const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(),
    manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
  const read = (form: 'outline' | 'text') => adapter({ slug: 'dom-inspect', risk_tier: 'read', input: { target: '*://*/*', page, form },
    output: {}, stepMeta: { run_id: 'ad', recipe_id: 'inspect-web-page', step_id: 'inspect' } }) as Promise<Record<string, unknown>>;
  const act = (steps: unknown[]) => adapter({ slug: 'dom-act', risk_tier: 'write', input: { target: '*://*/*', page, steps }, output: {},
    stepMeta: { run_id: 'ad', recipe_id: 'act-on-web-page', step_id: 'act' } }) as Promise<Record<string, unknown>>;
  const click = () => adapter({ slug: 'dom-click', risk_tier: 'write', input: { target: '*://*/*', page, ref: 'e1' }, output: {},
    stepMeta: { run_id: 'ad', recipe_id: 'click-web-element', step_id: 'click' } }) as Promise<Record<string, unknown>>;
  return { read, act, click, dispatch };
};

it('knows a vignette by its address, and nothing else by it', () => {
  expect(pageCoveredByAd(covered)).toBe(true);
  expect(pageCoveredByAd(app)).toBe(false);
  expect(pageCoveredByAd(`${app}#google_vignette_2`)).toBe(false);
  expect(pageCoveredByAd(`${app}?next=%23google_vignette`)).toBe(false);
  expect(pageCoveredByAd('not an address')).toBe(false);
});

it('a covered page reads as covered, with how to close the ad, in its outline and in its text', async () => {
  const { read } = setup(() => ok(hidden));
  const outline = await read('outline');
  expect(outline.outline).toBe(`${PAGE_COVERED_BY_AD_NOTE}\n${PAGE_END_NOTE}`);
  expect(PAGE_COVERED_BY_AD_NOTE).toContain('{"do":"back"}');
  const text = await read('text');
  expect(String(text.text).startsWith(PAGE_COVERED_BY_AD_NOTE)).toBe(true);
});

it('a page with no ad over it reads as before', async () => {
  const { read } = setup(() => ok(shown));
  const outline = await read('outline');
  expect(String(outline.outline)).not.toContain(PAGE_COVERED_BY_AD_NOTE);
  expect(String(outline.outline)).toContain('My notes');
});

it('a batch whose click brings up the ad reads the page as covered', async () => {
  let clicked = false;
  const { read, act } = setup(request => request.action === 'click' ? ok({ page, url: covered, title: 'Notes', clicked: true })
    : ok(clicked ? hidden : shown));
  await read('outline');
  clicked = true;
  const result = await act([{ do: 'click', ref: 'e1' }, { do: 'read' }]);
  // The batch's own read of the page, as its outline.
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(result);
  expect(strings.some(text => text.startsWith(PAGE_COVERED_BY_AD_NOTE))).toBe(true);
});

it('a click alone that brings up the ad says so: in the view a batch reads, and in what a single click changed', async () => {
  const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
    : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  let clicked = false;
  const same = setup(request => request.action === 'click' ? (clicked = true, ok({ page, url: covered, title: 'Notes', clicked: true }))
    : ok(clicked ? hidden : shown));
  await same.read('outline');
  const batch = await same.act([{ do: 'click', ref: 'e1' }]);
  expect(strings(batch).some(text => text.startsWith(PAGE_COVERED_BY_AD_NOTE))).toBe(true);
  // Click a web element on the page it was on: the click brings the ad up, and one more click leaves it there.
  let up = false;
  const fresh = setup(request => request.action === 'click' ? (up = true, ok({ page, url: covered, title: 'Notes', clicked: true }))
    : ok(up ? hidden : shown));
  await fresh.read('outline');
  const onIt = await fresh.click();
  expect(String(onIt.changes).startsWith(PAGE_COVERED_BY_AD_NOTE)).toBe(true);
  const again = await fresh.click();
  expect(again.changes).toBe(`${PAGE_COVERED_BY_AD_NOTE}\n(Nothing on the page changed.)`);
  const next = 'bridge:work:7:NEXT';
  let moved = false;
  const loaded = setup(request => request.action === 'click' ? (moved = true, ok({ page: next, url: covered, title: 'Notes', clicked: true, moved: true }))
    : ok(moved && request.args.page === next ? { ...hidden, page: next } : shown));
  await loaded.read('outline');
  const onNext = await loaded.click();
  expect(String(onNext.changes).startsWith(PAGE_COVERED_BY_AD_NOTE)).toBe(true);
});
