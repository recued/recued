/** 2026-11-20 (the owner: "go ahead", the animated modal) — a read asked to settle, in real Chrome. A modal that fades out
 *  changes no content, only a class and then a style, so only the browser's own list of running animations
 *  (`document.getAnimations()`, read by the injected `pageSettleProbe`) shows it is still going. The read waits for the
 *  fade to end, and an endless spinner on the same page does not hold it. chrome.scripting serializes the probe into the
 *  page as the shipped Bridge does. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS, type BridgeAction, type BridgeCommand, type BridgeIngredientRef } from '@recued/contracts';
import { createReviewedBrowserFixture } from './d-261-browser-fixture.js';

const HTML = `<!doctype html><title>Settle</title><style>
#modal { transition: opacity 1.5s linear; } #modal.closing { opacity: 0; }
.spinner { width: 12px; height: 12px; background: #888; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style><main><div class="spinner"></div><h1>Notes</h1>
<div id="modal" role="dialog"><p>Saving your note</p><button id="close">Close</button></div></main>
<script>document.querySelector('#close').addEventListener('click', () => { const modal = document.querySelector('#modal');
modal.classList.add('closing'); modal.addEventListener('transitionend', () => { modal.style.display = 'none'; }, { once: true }); });</script>`;

// 2026-11-20 (the owner: "go ahead", a wait at the Bridge) — a click that shows a spinner and "Loading", then the rows.
const LOADING = `<!doctype html><title>Load</title><style>
.spinner { width: 12px; height: 12px; background: #888; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style><main><h1>Orders</h1><button id="load">Load</button><div id="rows"></div></main>
<script>document.querySelector('#load').addEventListener('click', () => { const rows = document.querySelector('#rows');
rows.innerHTML = '<div class="spinner"></div><p>Loading</p>';
setTimeout(() => { rows.innerHTML = '<p>Rows loaded: 3 orders</p>'; }, 1500); });</script>`;

let pattern: string;
const ingredient: BridgeIngredientRef = { publisher_id: 'fixture', slug: 'settle', version: '1',
  surface_kind: 'reading', domain_allowlist: [], domain_allowlist_signature: '' };
const READ_KEYS = ['page', 'url', 'title', 'html', 'truncated'];

describe('a settled read in real Chrome', () => {
  let server: Server;
  let base: string;
  let fixture: Awaited<ReturnType<typeof createReviewedBrowserFixture>>;
  beforeAll(async () => {
    server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(req.url?.startsWith('/load') ? LOADING : HTML); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    pattern = `${base}/*`;
    ingredient.domain_allowlist = [pattern];
    fixture = await createReviewedBrowserFixture('about:blank');
    await fixture.grant(ingredient);
  }, 240_000);
  afterAll(async () => {
    await fixture?.close();
    await new Promise<void>(resolve => server?.close(() => resolve()));
  }, 120_000);
  const send = async (action: BridgeAction, args: Record<string, unknown>, keys: string[]) => {
    const command: BridgeCommand = { command_id: randomUUID(), recipe_run_id: 'settle', step_id: action,
      ingredient, action, target_domain_pattern: pattern, args, expects_output_keys: keys, timeout_ms: BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS,
      idempotency_key: randomUUID() };
    return (await fixture.ordinaryCommand(command)).result;
  };

  it('waits for a modal to fade out, and not for an endless spinner', async () => {
    await fixture.reset(base);
    await fixture.grant(ingredient);
    const first = await send('inspect', {}, READ_KEYS);
    expect(first.status).toBe('ok');
    const page = first.outputs!.page;
    expect(String(first.outputs!.html)).toContain('Saving your note');
    expect(await send('click', { page, selector: '#close' }, ['clicked'])).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    // Read at once, the modal is mid-fade, and still shown.
    expect(String((await send('inspect', { page }, READ_KEYS)).outputs!.html)).toContain('Saving your note');
    // Asked to settle, the read waits for the fade, though the spinner never stops.
    const started = Date.now();
    const settled = await send('inspect', { page, settle_ms: 3_000 }, [...READ_KEYS, 'settled']);
    expect(settled).toMatchObject({ status: 'ok', outputs: { settled: true } });
    expect(String(settled.outputs!.html)).not.toContain('Saving your note');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await fixture.page.locator('#modal').isVisible()).toBe(false);
  }, 90_000);

  it('waits for a change since its last read, holding while a spinner that came with it runs, and says when nothing changed', async () => {
    await fixture.reset(`${base}/load`);
    await fixture.grant(ingredient);
    // A read settles, and leaves the mark a wait counts from, by its page handle.
    const page = (await send('inspect', {}, READ_KEYS)).outputs!.page;
    expect(await send('inspect', { page, settle_ms: 3_000 }, [...READ_KEYS, 'settled'])).toMatchObject({ status: 'ok', outputs: { settled: true } });
    expect(await send('click', { page, selector: '#load' }, ['clicked'])).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    const started = Date.now();
    const waited = await send('reread', { page, wait_change_ms: 6_000 }, [...READ_KEYS, 'settled', 'changed']);
    const took = Date.now() - started;
    expect(waited).toMatchObject({ status: 'ok', outputs: { changed: true, settled: true } });
    expect(String(waited.outputs!.html)).toContain('Rows loaded');
    expect(String(waited.outputs!.html)).not.toContain('Loading');
    expect(took).toBeLessThan(4_000);
    // Nothing changes after that read: the next wait runs to its end, and says so.
    const again = Date.now();
    const still = await send('reread', { page, wait_change_ms: 1_200 }, [...READ_KEYS, 'settled', 'changed']);
    expect(still).toMatchObject({ status: 'ok', outputs: { changed: false, settled: false } });
    expect(Date.now() - again).toBeGreaterThanOrEqual(1_100);
    expect(String(still.outputs!.html)).toContain('Rows loaded');
  }, 90_000);
});
