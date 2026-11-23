/** Controlled subresource barriers prove DOM-ready reads work in real Chrome without
 * relying on elapsed-time thresholds or putting the opt-in watch into the benchmark. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS, type BridgeAction, type BridgeCommand, type BridgeIngredientRef } from '@recued/contracts';
import { createReviewedBrowserFixture } from './d-261-browser-fixture.js';

let pattern: string;
const ingredient: BridgeIngredientRef = { publisher_id: 'fixture', slug: 'readiness', version: '1',
  surface_kind: 'reading', domain_allowlist: [], domain_allowlist_signature: '' };
const HTML = '<!doctype html><title>Ready</title><main><h1>Available now</h1>'
  + '<button id="show" onclick="document.querySelector(\'#results\').hidden=false">Show</button>'
  + '<div id="results" hidden>Result ready</div></main>';

describe('Bridge readiness in real Chrome', () => {
  let server: Server;
  let base: string;
  let fixture: Awaited<ReturnType<typeof createReviewedBrowserFixture>>;
  const held = new Map<string, ServerResponse>();
  beforeAll(async () => {
    server = createServer((req, res) => {
      const address = new URL(req.url!, 'http://fixture');
      if (address.pathname.startsWith('/asset/')) {
        held.set(address.pathname.slice('/asset/'.length), res);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML + (address.searchParams.has('slow') ? `<img src="/asset/${address.searchParams.get('slow')}">` : ''));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    pattern = `${base}/*`;
    ingredient.domain_allowlist = [pattern];
    fixture = await createReviewedBrowserFixture('about:blank');
    await fixture.grant(ingredient);
  }, 240_000);
  afterAll(async () => {
    for (const response of held.values()) response.end();
    await fixture?.close();
    await new Promise<void>(resolve => server?.close(() => resolve()));
  }, 120_000);
  const release = (id: string) => { held.get(id)?.end(); held.delete(id); };
  const send = async (action: BridgeAction, args: Record<string, unknown>, keys: string[]) => {
    const command: BridgeCommand = { command_id: randomUUID(), recipe_run_id: 'readiness', step_id: action,
      ingredient, action, target_domain_pattern: pattern, args, expects_output_keys: keys, timeout_ms: BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS,
      idempotency_key: randomUUID() };
    const result = (await fixture.ordinaryCommand(command)).result;
    if (result.status === 'timeout' || result.error?.code === 'unknown') console.error('readiness command diagnostics', { action, result, pages: fixture.browser.pages().map(page => page.url()), held_images: [...held.keys()] });
    return result;
  };

  it('opens and inspects an interactive document while its image is still pending, then refreshes after load', async () => {
    try {
      const opened = await send('open_tab', { url: `${base}/?slow=dom`, dom_ready: true }, ['page', 'url', 'title', 'loading']);
      expect(opened.error).toBeUndefined();
      expect(opened).toMatchObject({ status: 'ok', outputs: { loading: true } });
      expect(held.has('dom')).toBe(true);
      const page = opened.outputs!.page;
      const partial = await send('inspect', { page, dom_ready: true }, ['page', 'url', 'title', 'html', 'truncated', 'loading']);
      expect(partial).toMatchObject({ status: 'ok', outputs: { page, loading: true } });
      expect(partial.outputs!.html).toContain('Available now');
      release('dom');
      const tab = fixture.browser.pages().find(p => p.url() === `${base}/?slow=dom`)!;
      await tab.waitForLoadState('load');
      const loaded = await send('reread', { page, dom_ready: true }, ['page', 'url', 'title', 'html', 'truncated', 'loading']);
      expect(loaded).toMatchObject({ status: 'ok', outputs: { page } });
      expect(loaded.outputs!.loading).toBe(false);
    } finally { release('dom'); }
  }, 90_000);

  it('retains full-load behavior when the server omits the readiness arguments', async () => {
    let settled = false;
    const url = `${base}/?slow=legacy`;
    const opened = send('open_tab', { url }, ['page', 'url', 'title']).then(result => {
      settled = true;
      return result;
    });
    try {
      // The held request proves the document is committed without racing
      // Playwright's separate tab event. The pending image is the barrier.
      await expect.poll(() => held.has('legacy'), { timeout: BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS }).toBe(true);
      expect(settled).toBe(false);
      release('legacy');
      expect(await opened).toMatchObject({ status: 'ok' });
    } finally { release('legacy'); await opened; }
  }, 90_000);

  it('executes an explicitly opted-in predicate click and preserves document/ref fencing', async () => {
    await fixture.reset(base);
    await fixture.grant(ingredient);
    const read = await send('inspect', {}, ['page', 'url', 'title', 'html', 'truncated']);
    expect(read.error).toBeUndefined();
    expect(read.status).toBe('ok');
    const page = read.outputs!.page;
    const clicked = await send('click', { page, selector: '#show', dom_ready: true,
      ready_check: { selector: '#results', until: 'shown', text: 'Result ready' } }, ['clicked', 'page', 'url', 'title', 'moved', 'loading']);
    expect(clicked).toMatchObject({ status: 'ok', outputs: { page, clicked: true, moved: false } });
    expect(await fixture.page.locator('#results').isVisible()).toBe(true);
    await fixture.page.reload();
    const stale = await send('click', { page, selector: '#show', dom_ready: true }, ['clicked', 'page']);
    expect(stale).toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
    expect(await fixture.page.locator('#results').isVisible()).toBe(false);
  }, 90_000);
});
