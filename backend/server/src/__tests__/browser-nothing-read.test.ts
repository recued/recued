/** 2026-11-22 (the owner: "go ahead", for a fallback when nothing else names why) — a whole page read complete with
 *  nothing in it says so (`PAGE_NOTHING_READ_NOTE`), unless its address names Google's vignette ad over it
 *  (`PAGE_COVERED_BY_AD_NOTE`). Alone, "(End of the page.)" read as a page that is there and empty: on bench task ZV,
 *  with no note, the model gave it as the answer 15 times in 15. A page with anything in it reads as before. */
import { expect, it, vi } from 'vitest';
import {
  createBridgeDomAdapter, PAGE_COVERED_BY_AD_NOTE, PAGE_END_NOTE, PAGE_NOTHING_READ_NOTE,
} from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

const page = 'bridge:work:7:SHOP', url = 'https://shop.example/offers';
const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'work', attempts: 1,
  result: { command_id: 'c', status: 'ok', bridge_version: '0.0.14', duration_ms: 1, idempotency_key_seen: false, outputs } });
const answered = (html: string, more: Record<string, unknown> = {}) => ({ page, url, title: 'Offers', html, loading: false,
  truncated: false, ...more });
// What the Bridge sends for a page it can keep nothing of: a body marked aria-hidden under an overlay, a canvas.
const blank = answered('');
const shown = answered('<main><h1>Offers</h1><button ref="e1">Next</button></main>');
const setup = (answer: (request: DispatchRequest) => DispatchOutcome) => {
  const dispatch = vi.fn(async (request: DispatchRequest) => answer(request));
  const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(),
    manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
  const read = (form: 'outline' | 'text', more: Record<string, unknown> = {}) => adapter({ slug: 'dom-inspect', risk_tier: 'read',
    input: { target: '*://*/*', page, form, ...more }, output: {},
    stepMeta: { run_id: 'blank', recipe_id: 'inspect-web-page', step_id: 'inspect' } }) as Promise<Record<string, unknown>>;
  const click = () => adapter({ slug: 'dom-click', risk_tier: 'write', input: { target: '*://*/*', page, ref: 'e1' }, output: {},
    stepMeta: { run_id: 'blank', recipe_id: 'click-web-element', step_id: 'click' } }) as Promise<Record<string, unknown>>;
  return { read, click, dispatch };
};
const said = (answer: Record<string, unknown>) => String(answer.outline ?? answer.text ?? '');

it('a whole page with nothing in it says so, in its outline and in its text', async () => {
  const { read } = setup(() => ok(blank));
  expect((await read('outline')).outline).toBe(`${PAGE_NOTHING_READ_NOTE}\n${PAGE_END_NOTE}`);
  expect(String((await read('text')).text).startsWith(PAGE_NOTHING_READ_NOTE)).toBe(true);
  // It names no cause it cannot know, and no way out of it.
  expect(PAGE_NOTHING_READ_NOTE).not.toMatch(/\{"do"|go back|close it/i);
});

it('a page under Google\'s vignette ad gets that note, not this one', async () => {
  const { read } = setup(() => ok({ ...blank, url: `${url}#google_vignette` }));
  expect((await read('outline')).outline).toBe(`${PAGE_COVERED_BY_AD_NOTE}\n${PAGE_END_NOTE}`);
});

it('a page with anything in it reads as before', async () => {
  const { read } = setup(() => ok(shown));
  for (const form of ['outline', 'text'] as const) {
    const answer = said(await read(form));
    expect(answer).not.toContain(PAGE_NOTHING_READ_NOTE);
    expect(answer).toContain('Offers');
  }
});

it('a page with only a control that has no words, or with an empty main content, is not called empty in either form', async () => {
  // Its text is empty, but a text part is numbered on the outline's lines, and the outline shows the control.
  const bare = setup(() => ok(answered('<div><button ref="e1"></button></div>')));
  expect(said(await bare.read('outline'))).not.toContain(PAGE_NOTHING_READ_NOTE);
  expect(said(await bare.read('text'))).not.toContain(PAGE_NOTHING_READ_NOTE);
  const menu = setup(() => ok(answered('<nav><a ref="e1" href="/home">Home</a></nav><main></main>')));
  expect(said(await menu.read('text'))).not.toContain(PAGE_NOTHING_READ_NOTE);
  expect(said(await menu.read('outline'))).not.toContain(PAGE_NOTHING_READ_NOTE);
});

it('a page still loading, or one the Bridge cut, is not called empty; nor is a part of a page', async () => {
  expect(said(await setup(() => ok(answered('', { loading: true }))).read('outline'))).not.toContain(PAGE_NOTHING_READ_NOTE);
  expect(said(await setup(() => ok(answered('', { truncated: true }))).read('outline'))).not.toContain(PAGE_NOTHING_READ_NOTE);
  const part = await setup(() => ok(answered(''))).read('outline', { selector: '#offers' });
  expect(JSON.stringify(part)).not.toContain(PAGE_NOTHING_READ_NOTE);
});

it('a click that leaves the page empty says so, and so does the next one; so does one that loads an empty page', async () => {
  let clicked = false;
  const same = setup(request => request.action === 'click' ? (clicked = true, ok({ page, url, title: 'Offers', clicked: true }))
    : ok(clicked ? blank : shown));
  await same.read('outline');
  expect(String((await same.click()).changes).startsWith(PAGE_NOTHING_READ_NOTE)).toBe(true);
  expect((await same.click()).changes).toBe(`${PAGE_NOTHING_READ_NOTE}\n(Nothing on the page changed.)`);
  const next = 'bridge:work:7:NEXT';
  let moved = false;
  const loaded = setup(request => request.action === 'click'
    ? (moved = true, ok({ page: next, url: `${url}/2`, title: 'Offers', clicked: true, moved: true }))
    : ok(moved && request.args.page === next ? { ...blank, page: next, url: `${url}/2` } : shown));
  await loaded.read('outline');
  const changes = String((await loaded.click()).changes);
  expect(changes.startsWith(PAGE_NOTHING_READ_NOTE)).toBe(true);
  expect(changes).toContain('(The page now, as Inspect a web page answers it: lines 1 to 0 of 0.)');
});
