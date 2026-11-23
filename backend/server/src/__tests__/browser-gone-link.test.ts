/** 2026-11-22 (the owner: "do 2 & 4") — a click on a link of a page its tab has since left. On the long-turn suite's ZD
 *  every failed turn clicked a link to a closed branch, then named the link the closed page sent it back for, on the
 *  page it had left, by that page's handle and ref; the Bridge refused, and the turn repeated it until its rounds ran
 *  out. Nothing was clicked, so the link is followed by its address in the same tab, from the read the model was shown.
 *  Only a link, on the same site, in a tab the browser still shows. */
import { expect, it, vi } from 'vitest';
import { BRIDGE_PAGE_GONE_MESSAGE, type BridgeResult } from '@recued/contracts';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

const site = 'https://trail.example';
const twelve = 'bridge:work:7:PAGE12', closed = 'bridge:work:7:CLOSED', thirteen = 'bridge:work:7:PAGE13';
const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'work', attempts: 1,
  result: { command_id: 'c', status: 'ok', bridge_version: '0.0.14', duration_ms: 1, idempotency_key_seen: false, outputs } });
const gone = (): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'work', attempts: 1,
  result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.14', idempotency_key_seen: false, status: 'error',
    error: { code: 'selector_not_found', message: BRIDGE_PAGE_GONE_MESSAGE } } as BridgeResult });
const read = (page: string, url: string, title: string, html: string) => ({ page, url, title, html, loading: false, truncated: false });
const PAGE12 = (puffin: string) => read(twelve, `${site}/12`, 'Trail, page 12 of 15', `<main><h1>Trail, page 12 of 15</h1>`
  + `<p>The trail goes on at the link labelled “Shrew”.</p><a ref="e4" href="${site}/closed">Shrew</a>${puffin}</main>`);
const CLOSED = read(closed, `${site}/closed`, 'This part of the trail is closed', '<main><h1>This part of the trail is closed</h1>'
  + `<p>The trail goes on from the page before, at the link labelled “Puffin” instead.</p><a ref="e1" href="${site}/12">Back to the trail</a></main>`);
const PAGE13 = read(thirteen, `${site}/13`, 'Trail, page 13 of 15', '<main><h1>Trail, page 13 of 15</h1></main>');

/** A browser whose tab 7 shows page 12, then the closed page once Shrew is clicked, then wherever it is sent. */
const setup = (puffin: string, tabs?: () => unknown[]) => {
  let here = twelve, hereUrl = `${site}/12`;
  const listed = () => tabs?.() ?? [{ page: here, url: hereUrl, title: 'Closed' }];
  const views: Record<string, ReturnType<typeof read>> = { [twelve]: PAGE12(puffin), [closed]: CLOSED, [thirteen]: PAGE13 };
  const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
    const args = request.args as Record<string, unknown>;
    if (request.action === 'list_tabs') return ok({ tabs: listed(), truncated: false });
    if (args.page !== undefined && args.page !== here) return gone();
    if (request.action === 'click' && args.ref === 'e4') { here = closed; hereUrl = `${site}/closed`; return ok({ page: closed, url: hereUrl, title: 'Closed', clicked: true, moved: true }); }
    if (request.action === 'navigate') { here = thirteen; hereUrl = String(args.url); return ok({ page: thirteen, url: hereUrl, title: 'Trail, page 13 of 15' }); }
    if (request.action === 'click') return ok({ page: here, url: hereUrl, title: '', clicked: true });
    return ok(views[here]!);
  });
  const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(),
    manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
  const meta = (step: string) => ({ run_id: 'gone-link', recipe_id: step, step_id: step });
  const inspect = () => adapter({ slug: 'dom-inspect', risk_tier: 'read', input: { target: '*://*/*', page: twelve, form: 'outline' },
    output: {}, stepMeta: meta('inspect-web-page') });
  const act = (page: string, steps: unknown[]) => adapter({ slug: 'dom-act', risk_tier: 'write', input: { target: '*://*/*', page, steps },
    output: {}, stepMeta: meta('act-on-web-page') }) as Promise<Record<string, unknown>>;
  return { inspect, act, dispatch };
};
const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const navigations = (dispatch: ReturnType<typeof setup>['dispatch']) => dispatch.mock.calls.map(([request]) => request)
  .filter((request) => request.action === 'navigate').map((request) => request.args);
/** ZD's turn: page 12 read, Shrew clicked onto the closed page, then Puffin named on page 12, which the tab has left. */
const zd = async (puffin: string, tabs?: () => unknown[]) => {
  const browser = setup(puffin, tabs);
  await browser.inspect();
  await browser.act(twelve, [{ do: 'click', ref: 'e4' }]);
  const settled = await browser.act(twelve, [{ do: 'click', ref: 'e7' }, { do: 'read' }]).then(
    (answer) => ({ answer }), (error: unknown) => ({ error }));
  return { ...browser, settled };
};

it('a link on a page its tab has left is followed by its address, in that tab, and said so', async () => {
  const { dispatch, settled } = await zd(`<a ref="e7" href="${site}/13">Puffin</a>`);
  expect('error' in settled ? String((settled.error as Error).message) : '').toBe('');
  expect(navigations(dispatch)).toEqual([{ page: closed, url: `${site}/13` }]);
  const said = strings('answer' in settled ? settled.answer : '');
  expect(said.some((text) => text.includes(`to ${site}/13, since the page it was read on had left the tab`))).toBe(true);
  expect(said.some((text) => text.includes('Trail, page 13 of 15'))).toBe(true);
});

it('nothing is followed for a button, a link to another site, or a tab the browser no longer shows', async () => {
  for (const [puffin, tabs] of [
    ['<button ref="e7">Puffin</button>', undefined],
    ['<a ref="e7" href="https://elsewhere.example/13">Puffin</a>', undefined],
    [`<a ref="e7" href="${site}/13">Puffin</a>`, () => []],
  ] as const) {
    const { dispatch, settled } = await zd(puffin, tabs);
    expect(navigations(dispatch)).toEqual([]);
    expect('error' in settled ? String((settled.error as Error).message) : '').toContain('list the tabs for its current page handle');
  }
});
