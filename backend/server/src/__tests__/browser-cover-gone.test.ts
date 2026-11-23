/** 2026-11-22 (the owner: "do the two followups") — after a page the model was shown covered ("Something covers this
 *  page"), the first answer with the cover gone says so (`PAGE_COVER_GONE_NOTE`), once: on bench task ZX a turn closed
 *  the cover, was shown the page as it was, and kept pressing the Close button that had gone. And under Google's
 *  vignette ad, its own note names the cover alone, with no second note beside it. */
import { expect, it, vi } from 'vitest';
import { createBridgeDomAdapter, PAGE_COVER_GONE_NOTE, PAGE_COVERED_BY_AD_NOTE } from '../bridges/dom-adapter.js';
import { createPageReadStore, PAGE_COVER_NOTE_START } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

const page = 'bridge:work:7:TRAIL', url = 'https://trail.example/3';
const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'work', attempts: 1,
  result: { command_id: 'c', status: 'ok', bridge_version: '0.0.14', duration_ms: 1, idempotency_key_seen: false, outputs } });
// What a Bridge that reads covers sends for the page under one, and for it once the cover has gone.
const covered = { page, url: `${url}#offer`, title: 'Trail', loading: false, truncated: false,
  html: '<div data-recued-cover><p>Advertisement</p><button ref="e9">Close</button></div>' };
const uncovered = { page, url, title: 'Trail', loading: false, truncated: false,
  html: '<main><h1>Trail, page 3 of 6</h1><a ref="e5" href="/4">Linnet</a></main>' };
const setup = (answer: (request: DispatchRequest) => DispatchOutcome) => {
  const dispatch = vi.fn(async (request: DispatchRequest) => answer(request));
  const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(),
    manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
  const meta = (step: string) => ({ run_id: 'cover', recipe_id: step, step_id: step });
  const read = async () => String((await adapter({ slug: 'dom-inspect', risk_tier: 'read', input: { target: '*://*/*', page, form: 'outline' },
    output: {}, stepMeta: meta('inspect-web-page') }) as Record<string, unknown>).outline);
  const click = (ref: string) => adapter({ slug: 'dom-click', risk_tier: 'write', input: { target: '*://*/*', page, ref }, output: {},
    stepMeta: meta('click-web-element') }) as Promise<Record<string, unknown>>;
  const act = (steps: unknown[]) => adapter({ slug: 'dom-act', risk_tier: 'write', input: { target: '*://*/*', page, steps }, output: {},
    stepMeta: meta('act-on-web-page') }) as Promise<Record<string, unknown>>;
  return { read, click, act };
};
const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const closes = () => {
  let closed = false;
  return (request: DispatchRequest) => request.action === 'click'
    ? (closed = true, ok({ page, url, title: 'Trail', clicked: true })) : ok(closed ? uncovered : covered);
};

it('a page read covered, then read with the cover gone, says it has gone, once', async () => {
  let gone = false;
  const { read } = setup(() => ok(gone ? uncovered : covered));
  expect((await read()).startsWith(PAGE_COVER_NOTE_START)).toBe(true);
  gone = true;
  const after = await read();
  expect(after.startsWith(PAGE_COVER_GONE_NOTE)).toBe(true);
  expect(after).toContain('Linnet');
  expect(await read()).not.toContain(PAGE_COVER_GONE_NOTE);
});

it('a click that closes the cover says it has gone, in what it changed', async () => {
  const { read, click } = setup(closes());
  await read();
  expect(String((await click('e9')).changes)).toContain(PAGE_COVER_GONE_NOTE);
  expect(await read()).not.toContain(PAGE_COVER_GONE_NOTE);
});

it('a batch that closes the cover, waits and reads says it has gone, though its wait read the page first', async () => {
  const { read, act } = setup(closes());
  await read();
  const result = await act([{ do: 'click', ref: 'e9' }, { do: 'wait', seconds: 1 }, { do: 'read' }]);
  expect(strings(result).some(text => text.includes(PAGE_COVER_GONE_NOTE))).toBe(true);
  expect(await read()).not.toContain(PAGE_COVER_GONE_NOTE);
});

it('under Google\'s vignette ad its own note names the cover alone, and nothing is said gone when it closes', async () => {
  let back = false;
  const { read } = setup(() => ok(back ? uncovered : { ...covered, url: `${url}#google_vignette` }));
  const first = await read();
  expect(first.startsWith(PAGE_COVERED_BY_AD_NOTE)).toBe(true);
  expect(first).not.toContain(PAGE_COVER_NOTE_START);
  expect(first).toContain('Advertisement');
  back = true;
  expect(await read()).not.toContain(PAGE_COVER_GONE_NOTE);
});
