/** D-335 slices A, B and C — the Bridge's page read (`apps/bridge/src/actions/page-inspect.ts`),
 *  typing and clicking by the refs it marks (`page-fields.ts`), and the open
 *  tabs and a newly opened one (`page-tabs.ts`, ordinary executor only), in
 *  real Chrome, through BOTH executors the extension runs: the ordinary one,
 *  which finds the tab by pattern, and the reviewed one, bound to a Chrome
 *  documentId. chrome.scripting serializes `inspectPage` into the page exactly
 *  as the shipped Bridge does, so a function that leaned on anything outside
 *  itself fails here, and so does a ref map that did not survive between two
 *  injections, which no unit test can show.
 *
 *  The pages are built for this test from the rules in D-335
 *  §3.2, not copied from any site. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BRIDGE_DESCRIBE_OUTPUT_KEYS,
  BRIDGE_INSPECT_MAX_CHARS,
  BRIDGE_INSPECT_OUTPUT_KEYS,
  BRIDGE_OPEN_OUTPUT_KEYS,
  BRIDGE_PAGE_CHANGED_MESSAGE,
  BRIDGE_PRESS_OUTPUT_KEYS,
  BRIDGE_TABS_OUTPUT_KEYS,
  BRIDGE_NAVIGATE_OUTPUT_KEYS,
  BRIDGE_CLOSE_OUTPUT_KEYS,
  BRIDGE_HOVER_OUTPUT_KEYS,
  type BridgeCommand,
  type BridgeDocumentIdentity,
  type BridgeIngredientRef,
  type BridgeResult,
} from '@recued/contracts';
import { createReviewedBrowserFixture } from './d-261-browser-fixture.js';

const PAGE = `<!doctype html><html><head><title>Inspect fixture</title>
<style>.gone { display: none }</style><link rel="stylesheet" href="/missing.css"></head>
<body class="ab x1y2 hover:bg [mask] layout-root page-body extra-name fourth-name" data-tracking="t1" onclick="void 0">
<!-- a comment the read drops -->
<header style="color: red"><h1 title="Heading title">Inspect fixture</h1></header>
<nav><a href="/next" id="next" target="_blank" rel="noopener" aria-label="Next page" data-x="1">Next</a>
<a name="anchor-only">No link</a></nav>
<main id="main">
<p>Visible text <b>bold</b></p>
<p style="display:none">display none text</p>
<p class="gone">class hidden text</p>
<p style="visibility:hidden">visibility hidden text</p>
<p aria-hidden="true">aria hidden text</p>
<p hidden>hidden attribute text</p>
<div style="display:contents"><span>inside display contents</span></div>
<script>window.scriptRan = 'script text';</script>
<noscript>noscript text</noscript>
<template><p>template text</p></template>
<iframe srcdoc="<p>frame text</p>"></iframe>
<svg role="img" aria-label="Icon" viewBox="0 0 10 10"><title>Icon title</title><path d="M0 0L10 10"/></svg>
<button id="save" type="submit" disabled>Save</button>
<div role="button" id="custom">Custom button</div>
<span tabindex="0" id="focusable">Focusable</span>
<span tabindex="-1" id="unfocusable">Not focusable</span>
<div id="plain">Plain div</div>
<label for="name">Name</label><input id="name" name="name" placeholder="Your name" value="Ada">
<input type="checkbox" id="agree" checked><input type="radio" name="tier" id="gold">
<input type="password" id="pw" value="hunter2">
<input id="code" autocomplete="one-time-code" value="123456">
<input id="card" autocomplete="cc-number" value="4111111111111111">
<input type="hidden" id="csrf" value="token-123">
<textarea id="notes">initial</textarea>
<select id="stage"><option value="">Choose</option><option value="won" selected>Closed won</option><option>Lost</option></select>
<div contenteditable="true" id="editor"><p>Draft</p></div>
<section id="panel" tabindex="0"><a href="/a" id="panel-link">Panel link</a><button id="panel-button">Go</button></section>
<pre id="block">line one
  indented</pre>
<p id="long">${'x'.repeat(5_000)}</p>
<input id="long-value" value="${'y'.repeat(5_000)}">
<div ref="e1" id="planted">Planted ref attribute</div>
</main>
<script>document.querySelector('#notes').value = 'typed later';
window.clicks = [];
for (const id of ['custom', 'plain', 'planted']) {
  document.getElementById(id).addEventListener('click', () => window.clicks.push(id));
}</script>
</body></html>`;

const BIG = `<!doctype html><html><head><title>Big</title></head><body><main>${
  Array.from({ length: 3_000 }, (_, i) => `<p>Paragraph ${i + 1} of the long page.</p>`).join('')}</main></body></html>`;

// D-335 slice U — keys: a search form Enter sends, a chat box that sends on Enter itself, a text
// area, two fields Tab moves between, a checkbox, a dialog Escape closes, an element whose own
// handler records shortcuts, and a disabled field.
const KEYS = `<!doctype html><html><head><title>Keys</title></head><body>
<form id="search" action="/second" method="get"><input id="q" name="q" value="Ada" aria-label="Search"><button type="submit">Search</button></form>
<textarea id="chat" aria-label="Message"></textarea><ul id="sent"></ul>
<textarea id="notes" aria-label="Notes"></textarea>
<input id="first" aria-label="First"><input id="second" aria-label="Second">
<input id="agree" type="checkbox" aria-label="Agree">
<button id="open" type="button">Open dialog</button>
<dialog id="box"><p>A dialog</p><button id="inside" type="button">Inside</button></dialog>
<div id="shortcut" tabindex="0" aria-label="Shortcuts">Shortcuts</div>
<input id="off" aria-label="Off" disabled>
<script>
window.keys = [];
document.getElementById('chat').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  const item = document.createElement('li');
  item.textContent = event.target.value;
  document.getElementById('sent').append(item);
  event.target.value = '';
});
document.getElementById('shortcut').addEventListener('keydown', (event) => window.keys.push(
  [event.key, event.code, event.keyCode, event.ctrlKey, event.metaKey, event.shiftKey].join('|')));
document.getElementById('open').addEventListener('click', () => document.getElementById('box').showModal());
</script></body></html>`;

// D-335 slice W — elements of every kind a selector finds one by: an id, a generated id, a test hook, a
// name, nothing but a place among its siblings, and a button inside a web component.
const SELECTORS = `<!doctype html><html><head><title>Selectors</title></head><body><main>
<button id="save" type="button">Save</button>
<section><button id=":r1:" type="button">Generated</button></section>
<button data-testid="publish" type="button">Publish</button>
<input name="email" aria-label="Email">
<ul><li><a href="/one">One</a></li><li><a href="/two">Two</a></li></ul>
<boxed-action></boxed-action>
<script>
customElements.define('boxed-action', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button id="inner" type="button">Inner</button>'; }
});
</script></main></body></html>`;

// D-335 slice X — a menu that opens when the pointer enters its item, as many site menus do.
/** D-347 follow-up 18 — a banner shown in turn (three offers in one place, one on top) and a notice over the
 *  whole page that new mail has come; `turn` and `notice` bring them in `ms` from now, as the page's own
 *  timer would. Each click is logged. */
const ROTATING = `<!doctype html><html><head><title>Offers</title><style>
#offers { position: relative; width: 300px; height: 120px }
#offers a { position: absolute; inset: 0; display: block; background: #eee; z-index: 0 }
#offers a.on { z-index: 1 }
</style></head><body>
<div id="offers"><a id="offer-a" class="on" href="#a">Offer A</a><a id="offer-b" href="#b">Offer B</a><a id="offer-c" href="#c">Offer C</a></div>
<button id="refresh" type="button">Refresh</button>
<div id="notice" role="status" hidden style="position: fixed; inset: 0; background: white; z-index: 9">New mail</div>
<script>
window.clicks = [];
for (const offer of document.querySelectorAll('#offers a')) {
  offer.addEventListener('click', (event) => { event.preventDefault(); window.clicks.push(offer.id); });
}
document.querySelector('#refresh').addEventListener('click', () => window.clicks.push('refresh'));
window.turn = (id, ms) => setTimeout(() => {
  for (const offer of document.querySelectorAll('#offers a')) offer.classList.toggle('on', offer.id === id);
}, ms);
window.notice = (ms) => {
  document.querySelector('#notice').hidden = false;
  if (ms > 0) setTimeout(() => { document.querySelector('#notice').hidden = true; }, ms);
};
</script></body></html>`;
const MENU = `<!doctype html><html><head><title>Menu</title></head><body>
<nav><ul><li id="products"><a href="/menu#products" id="products-link">Products</a><ul id="submenu" hidden><li>Widgets</li></ul></li></ul></nav>
<script>document.getElementById('products').addEventListener('mouseenter', () => { document.getElementById('submenu').hidden = false; });</script>
</body></html>`;

// D-335 slice R — web components: an open one whose slots show the page's own content (one slot
// filled, one showing its fallback), and a closed one, each with a button that records its click.
const COMPONENTS = `<!doctype html><html><head><title>Components</title></head><body>
<p>Before the components.</p>
<open-card><span slot="title">Slotted title</span><span>Unslotted light text</span></open-card>
<closed-card></closed-card>
<covered-card></covered-card>
<script>
window.clicks = [];
customElements.define('open-card', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<h2><slot name="title">Fallback title</slot></h2><p>Inside an open card.</p>'
      + '<button id="open-button" type="button">Open action</button><input id="open-field" aria-label="Open field">'
      + '<p style="display:none">Hidden in the card</p><slot name="missing">Fallback shown</slot>';
    root.querySelector('#open-button').addEventListener('click', () => window.clicks.push('open-button'));
  }
});
// A dialog inside the component over its own button: a person's click lands on the dialog.
customElements.define('covered-card', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<div style="position:relative"><button id="covered-button" type="button">Covered action</button>'
      + '<div role="dialog" aria-label="Cookie choice" style="position:absolute;inset:-4px;background:white">Choose</div></div>';
    root.querySelector('#covered-button').addEventListener('click', () => window.clicks.push('covered-button'));
  }
});
customElements.define('closed-card', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<p>Inside a closed card.</p><button type="button">Closed action</button>';
    root.querySelector('button').addEventListener('click', () => window.clicks.push('closed-button'));
  }
});
</script></body></html>`;

// D-335 slice R — frames: one from this site, an editor's blank frame, and one from the other
// site, whose address the page takes from its own query (the other site's port is known late).
const FRAME_INNER = `<!doctype html><html><head><title>Inner</title></head><body><p>Inside the frame.</p>
<button type="button" id="inner-button">Inner action</button>
<script>window.clicks = []; document.querySelector('#inner-button').addEventListener('click', () => window.clicks.push('inner'));</script>
</body></html>`;
const FRAMES = `<!doctype html><html><head><title>Frames</title></head><body>
<p>Top text.</p>
<iframe id="same" title="Same site" src="/frame-inner"></iframe>
<iframe id="editor" title="Editor" srcdoc="<html><body contenteditable='true'><p>Draft text</p></body></html>"></iframe>
<iframe id="other" title="Other site"></iframe>
<script>document.querySelector('#other').src = new URLSearchParams(location.search).get('other') + '/frame-inner';</script>
</body></html>`;

const OWNER = '<!doctype html><html data-recued-owner-surface><body><p>pending review</p></body></html>';

const PATHS = ['ordinary', 'reviewed'] as const;
type Path = typeof PATHS[number];

/** Each element with a ref, in order; every one in PAGE has an id, written right after its ref. */
const refsIn = (html: string) => [...html.matchAll(/<\w+ ref="(e\d+)"(?: id="([^"]*)")?/g)]
  .map(match => ({ ref: match[1]!, id: match[2] }));
const refFor = (html: string, id: string) => refsIn(html).find(row => row.id === id)?.ref;
const htmlOf = (result: BridgeResult) => {
  expect(result, JSON.stringify(result.error)).toMatchObject({ status: 'ok' });
  return result.outputs!.html as string;
};
const PAGE_CHANGED = { status: 'error', error: { code: 'selector_not_found',
  message: 'The page changed since it was inspected: inspect it again.' } };
/** A handle whose document has gone: inspecting it again would fail again. */
const PAGE_GONE = { status: 'error', error: { code: 'selector_not_found',
  message: 'The page has reloaded, gone to another address or closed since it was read: '
    + 'list the tabs for its current page handle, then inspect it.' } };

describe('D-335 slice A — the Bridge reads a page for an AI, in real Chrome', () => {
  let server: Server | undefined;
  let elsewhere: Server | undefined;
  let base = '';
  let other = '';
  let target = '';
  let ingredient: BridgeIngredientRef;
  let browser: Awaited<ReturnType<typeof createReviewedBrowserFixture>> | undefined;

  /** Pages each origin served, by path: an opened tab that redirected must
   *  have reached the other origin for "its tab was closed" to mean anything. */
  const hits: Record<string, number> = {};
  const serve = async (pages: Record<string, string>, redirects: Record<string, () => string> = {}) => {
    const created = createServer((request, response) => {
      const path = request.url ?? '';
      const port = (created.address() as { port: number }).port;
      hits[`${port}${path}`] = (hits[`${port}${path}`] ?? 0) + 1;
      if (redirects[path]) {
        response.writeHead(302, { location: redirects[path]!() });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      // A page's query is its own: `/frames?other=…` is `/frames`.
      response.end(pages[path] ?? pages[path.split('?')[0]!] ?? PAGE);
    });
    await new Promise<void>(resolve => created.listen(0, '127.0.0.1', resolve));
    const address = created.address();
    if (!address || typeof address === 'string') throw new Error('no page server port');
    return { created, origin: `http://127.0.0.1:${address.port}` };
  };

  // ⚠ 240s: the fixture bounds Chrome's MV3 worker start at 180s with a named
  // error, and an outer bound below that would hide it (see the fixture).
  beforeAll(async () => {
    const main = await serve({ '/big': BIG, '/owner': OWNER, '/components': COMPONENTS, '/frames': FRAMES, '/frame-inner': FRAME_INNER,
      '/keys': KEYS, '/selectors': SELECTORS, '/menu': MENU, '/rotating': ROTATING },
      { '/away': () => `${other}/page` });
    server = main.created;
    base = main.origin;
    // Another origin on the same host: the extension may script it, but a
    // command granted for `base` may not read it.
    const second = await serve({ '/frame-inner': FRAME_INNER });
    elsewhere = second.created;
    other = second.origin;
    target = `${base}/*`;
    ingredient = { publisher_id: 'fixture', slug: 'page-inspect', version: '1', surface_kind: 'reading',
      domain_allowlist: [target], domain_allowlist_signature: '' };
    browser = await createReviewedBrowserFixture('about:blank');
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    for (const created of [server, elsewhere]) {
      await new Promise(resolve => created ? created.close(resolve) : resolve(undefined));
    }
  }, 120_000);

  /** A fresh page, granted, and a way to inspect it through one executor.
   *  `reset` clears grants too, so grant after it. */
  const open = async (path: Path, at = '/page', pattern = target) => {
    const fixture = browser!;
    await fixture.reset(base + at);
    // A pattern other than this site's (slice R: both test sites, for a frame from the other).
    const granted: BridgeIngredientRef = pattern === target ? ingredient : { ...ingredient, domain_allowlist: [pattern] };
    await fixture.grant(granted);
    const reviewed: BridgeDocumentIdentity | undefined = path === 'reviewed'
      ? (await fixture.documents()).find(document => document.url === base + at)
      : undefined;
    if (path === 'reviewed' && !reviewed) throw new Error(`the bridge did not inventory ${at}`);
    const send = async (action: 'inspect' | 'reread' | 'describe' | 'fill' | 'click' | 'press' | 'list_tabs' | 'open_tab'
      | 'navigate' | 'go_back' | 'reload_page' | 'close_tab' | 'hover',
      args: Record<string, unknown>, expects?: readonly string[]) => {
      const command: BridgeCommand = { command_id: randomUUID(), recipe_run_id: 'page-inspect', step_id: action,
        ingredient: granted, action, target_domain_pattern: pattern, args,
        expects_output_keys: expects !== undefined ? [...expects] : action === 'inspect' || action === 'reread' ? [...BRIDGE_INSPECT_OUTPUT_KEYS]
          : action === 'describe' ? [...BRIDGE_DESCRIBE_OUTPUT_KEYS]
            : action === 'list_tabs' ? [...BRIDGE_TABS_OUTPUT_KEYS]
              : action === 'open_tab' ? [...BRIDGE_OPEN_OUTPUT_KEYS]
                : action === 'press' ? [...BRIDGE_PRESS_OUTPUT_KEYS] : [action === 'fill' ? 'filled' : 'clicked'],
        timeout_ms: 30_000, idempotency_key: randomUUID(), ...(reviewed ? { reviewed_document: reviewed } : {}) };
      return (path === 'reviewed' ? await fixture.command(command) : await fixture.ordinaryCommand(command)).result;
    };
    const inspect = (args: Record<string, unknown>) => send('inspect', args);
    const clicks = () => fixture.page.evaluate(() => (window as unknown as { clicks: string[] }).clicks);
    return { fixture, inspect, send, clicks, reviewed };
  };

  // D-335 slice X — a tab moved by its handle (an address, back, a reload), closed, and an element
  // pointed at, in real Chrome.
  it('ordinary: points at a menu item, and a menu that opens when the pointer enters it opens', async () => {
    const { inspect, send, fixture } = await open('ordinary', '/menu');
    const page = String((await inspect({})).outputs!.page);
    expect(await fixture.page.evaluate(() => (document.getElementById('submenu') as HTMLElement).hidden)).toBe(true);
    expect(await send('hover', { page, selector: '#products-link' }, [...BRIDGE_HOVER_OUTPUT_KEYS])).toMatchObject({ status: 'ok',
      outputs: { hovered: true, page, url: `${base}/menu`, title: 'Menu' } });
    // The item around the link heard the pointer enter, as a real pointer arriving makes it.
    expect(await fixture.page.evaluate(() => (document.getElementById('submenu') as HTMLElement).hidden)).toBe(false);
    expect(await send('hover', { page, selector: '#nowhere' }, [...BRIDGE_HOVER_OUTPUT_KEYS])).toMatchObject({ status: 'error',
      error: { code: 'selector_not_found' } });
  });

  it('ordinary: loads an address in the tab, goes back, reloads, each answering the page it then shows', async () => {
    const { inspect, send, fixture } = await open('ordinary', '/menu');
    const first = String((await inspect({})).outputs!.page);
    const went = await send('navigate', { page: first, url: `${base}/keys` }, [...BRIDGE_NAVIGATE_OUTPUT_KEYS]);
    expect(went).toMatchObject({ status: 'ok', outputs: { url: `${base}/keys`, title: 'Keys' } });
    const there = String(went.outputs!.page);
    // The same tab, a new page in it.
    expect(there.split(':')[0]).toBe(first.split(':')[0]);
    expect(there).not.toBe(first);
    expect(fixture.page.url()).toBe(`${base}/keys`);
    const back = await send('go_back', { page: there }, [...BRIDGE_NAVIGATE_OUTPUT_KEYS]);
    expect(back, JSON.stringify(back.error)).toMatchObject({ status: 'ok', outputs: { url: `${base}/menu`, title: 'Menu' } });
    const again = await send('reload_page', { page: String(back.outputs!.page) }, [...BRIDGE_NAVIGATE_OUTPUT_KEYS]);
    expect(again).toMatchObject({ status: 'ok', outputs: { url: `${base}/menu`, title: 'Menu' } });
    // A reload loads a new document: the handle before it names a page that has gone.
    expect(again.outputs!.page).not.toBe(back.outputs!.page);
    // An address off the command's site is refused before the tab moves.
    expect(await send('navigate', { page: String(again.outputs!.page), url: `${other}/page` }, [...BRIDGE_NAVIGATE_OUTPUT_KEYS]))
      .toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
    expect(fixture.page.url()).toBe(`${base}/menu`);
  });

  it('ordinary: closes a tab by its handle, which then lists no more', async () => {
    const { send, fixture } = await open('ordinary', '/menu');
    await fixture.openBackground(`${base}/keys`);
    const listed = await send('list_tabs', {});
    const keys = (listed.outputs!.tabs as Array<{ page: string; url: string }>).find((tab) => tab.url === `${base}/keys`)!;
    expect(await send('close_tab', { page: keys.page }, [...BRIDGE_CLOSE_OUTPUT_KEYS])).toMatchObject({ status: 'ok', outputs: { closed: true } });
    const after = await send('list_tabs', {});
    expect((after.outputs!.tabs as Array<{ url: string }>).map((tab) => tab.url)).not.toContain(`${base}/keys`);
  });

  // D-335 slice U — a key pressed in an element: the page's own handlers hear it, and what the
  // browser does for the key is done too, since a script's key events make it do nothing.
  it('ordinary: Enter sends a field\'s form; a chat box that sends on Enter itself does, with no new line', async () => {
    const { inspect, send, fixture } = await open('ordinary', '/keys');
    const read = await inspect({});
    const page = String(read.outputs!.page);
    const html = htmlOf(read);
    expect(await send('press', { page, ref: refFor(html, 'chat')!, key: 'Enter' })).toMatchObject({ status: 'ok',
      outputs: { pressed: 'Enter' } });
    await send('fill', { page, ref: refFor(html, 'chat')!, value: 'Hello' });
    expect(await send('press', { page, ref: refFor(html, 'chat')!, key: 'Enter' })).toMatchObject({ status: 'ok' });
    expect(await fixture.page.evaluate(() => [[...document.querySelectorAll('#sent li')].map((li) => li.textContent),
      (document.getElementById('chat') as HTMLTextAreaElement).value])).toEqual([['', 'Hello'], '']);
    // The search field's form, sent by its button as pressing Enter there does.
    expect(await send('press', { page, ref: refFor(html, 'q')!, key: 'Enter' })).toMatchObject({ status: 'ok',
      outputs: { pressed: 'Enter', sent: true } });
    await fixture.page.waitForURL(/\/second\?q=Ada$/);
  }, 120_000);

  it('ordinary: Shift+Enter starts a new line, Tab moves on, Space ticks, Escape closes a dialog, a shortcut is heard', async () => {
    const { inspect, send, fixture } = await open('ordinary', '/keys');
    const read = await inspect({});
    const page = String(read.outputs!.page);
    const html = htmlOf(read);
    await send('fill', { page, ref: refFor(html, 'notes')!, value: 'Line one' });
    expect(await send('press', { page, ref: refFor(html, 'notes')!, key: 'Shift+Enter' })).toMatchObject({ status: 'ok',
      outputs: { pressed: 'Shift+Enter' } });
    expect(await fixture.page.evaluate(() => (document.getElementById('notes') as HTMLTextAreaElement).value)).toBe('Line one\n');
    await send('press', { page, ref: refFor(html, 'first')!, key: 'Tab' });
    expect(await fixture.page.evaluate(() => document.activeElement?.id)).toBe('second');
    await send('press', { page, ref: refFor(html, 'agree')!, key: 'Space' });
    expect(await fixture.page.evaluate(() => (document.getElementById('agree') as HTMLInputElement).checked)).toBe(true);
    await send('click', { page, ref: refFor(html, 'open')! });
    expect(await fixture.page.evaluate(() => (document.getElementById('box') as HTMLDialogElement).open)).toBe(true);
    const opened = htmlOf(await inspect({ page }));
    // Shown as a modal one, the dialog says so (slice U).
    expect(opened).toMatch(/<dialog[^>]* modal[ >]/);
    const inside = refFor(opened, 'inside')!;
    expect(await send('press', { page, ref: inside, key: 'Escape' })).toMatchObject({ status: 'ok', outputs: { pressed: 'Escape' } });
    expect(await fixture.page.evaluate(() => (document.getElementById('box') as HTMLDialogElement).open)).toBe(false);
    await send('press', { page, ref: refFor(html, 'shortcut')!, key: 'Control+k' });
    expect(await fixture.page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual(['k|KeyK|75|true|false|false']);
    // A disabled field takes no key, and says so.
    expect(await send('press', { page, ref: refFor(html, 'off')!, key: 'Enter' })).toMatchObject({ status: 'error',
      error: { code: 'value_not_applied', message: 'It is disabled, so no key was pressed in it.' } });
  }, 120_000);

  // D-335 slice W — before it acts on an element, the Bridge works out what finds it again another
  // day, by the picker's rules, and answers it with the element as an ask names it, to a server that asks.
  it('ordinary: an id, past a generated one, a test hook, a name, a place; none inside a component', async () => {
    const { inspect, send, fixture } = await open('ordinary', '/selectors');
    const read = await inspect({});
    const page = String(read.outputs!.page);
    const html = htmlOf(read);
    const refOf = (pattern: RegExp) => pattern.exec(html)?.[1];
    // F2, pressed in each: it reads the element as any action does, and does nothing there.
    const acted = async (ref: string) => {
      const out = await send('press', { page, ref, key: 'F2' }, ['pressed', 'acted_on']);
      expect(out.status, JSON.stringify(out.error)).toBe('ok');
      return (out.outputs as { acted_on: { selector?: string; role: string; label: string; url: string } }).acted_on;
    };
    const cases: Array<[RegExp, string | undefined]> = [
      [/<button ref="(e\d+)"[^>]*id="save"/, '#save'],
      [/<button ref="(e\d+)"[^>]*id=":r1:"/, 'button[type="button"]'],
      [/<button ref="(e\d+)"[^>]*>Publish/, 'button[data-testid="publish"]'],
      [/<input ref="(e\d+)"[^>]*name="email"/, 'input[name="email"]'],
      [/<a ref="(e\d+)"[^>]*href="[^"]*\/two"/, undefined],
    ];
    for (const [pattern, expected] of cases) {
      const ref = refOf(pattern);
      expect(ref, String(pattern)).toBeDefined();
      const found = await acted(ref!);
      expect(found.url).toBe(`${base}/selectors`);
      if (expected !== undefined && !expected.startsWith('button[type')) expect(found.selector).toBe(expected);
      // Whatever it is, it finds that element and no other.
      const matches = await fixture.page.evaluate((selector) => [...document.querySelectorAll(selector)].map((el) => el.textContent),
        found.selector!);
      expect(matches, `${String(pattern)} → ${String(found.selector)}`).toHaveLength(1);
    }
    // A generated id is never the selector, and a link with nothing of its own is found by its place.
    expect((await acted(refOf(/<button ref="(e\d+)"[^>]*id=":r1:"/)!)).selector).not.toContain(':r1:');
    expect((await acted(refOf(/<a ref="(e\d+)"[^>]*href="[^"]*\/two"/)!)).selector).toMatch(/li:nth-of-type\(2\) > a/);
    // Inside a web component a selector reaches nothing: the element is named, with no selector.
    const inner = refOf(/<button ref="(e\d+)"[^>]*id="inner"/);
    expect(inner).toBeDefined();
    expect(await acted(inner!)).toEqual({ url: `${base}/selectors`, title: 'Selectors', role: 'button', label: 'Inner', protected: false });
  }, 120_000);

  // D-335 slice T — the read the server makes after an action keeps the refs of elements the page
  // removed, so a ref read before it still finds the control the page drew anew (slice M); an
  // inspection drops them, as it always has.
  it.each([['reread', true], ['inspect', false]] as const)('ordinary: a %s after the page redraws a button keeps its old ref: %s',
    async (action, kept) => {
      const { inspect, send, fixture } = await open('ordinary');
      const first = await inspect({});
      const page = String(first.outputs!.page);
      const go = refFor(htmlOf(first), 'panel-button')!;
      await fixture.page.evaluate(() => {
        const button = document.getElementById('panel-button')!;
        const drawn = button.cloneNode(true) as HTMLElement;
        drawn.addEventListener('click', () => (window as unknown as { clicks: string[] }).clicks.push('drawn anew'));
        button.replaceWith(drawn);
      });
      expect(await send(action, { page })).toMatchObject({ status: 'ok' });
      const clicked = await send('click', { page, ref: go });
      if (kept) {
        expect(clicked, JSON.stringify(clicked.error)).toMatchObject({ status: 'ok' });
        expect(await fixture.page.evaluate(() => (window as unknown as { clicks: string[] }).clicks)).toEqual(['drawn anew']);
      } else {
        expect(clicked).toMatchObject({ status: 'error', error: { code: 'selector_not_found', message: BRIDGE_PAGE_CHANGED_MESSAGE } });
      }
    }, 120_000);

  it.each(PATHS)('%s: hidden, decorative and executable content is gone, styles included', async path => {
    const { inspect } = await open(path);
    const result = await inspect({});
    const html = htmlOf(result);
    expect(result.outputs).toMatchObject({ url: `${base}/page`, title: 'Inspect fixture', truncated: false });
    expect(result.outputs!.page).toMatch(/^\d+:[A-Za-z0-9]+$/);
    for (const gone of ['display none text', 'class hidden text', 'visibility hidden text', 'aria hidden text',
      'hidden attribute text', 'script text', 'noscript text', 'template text', 'Icon title',
      'a comment the read drops', '<style', '<link', '<script', '<noscript', '<template', '<path',
      '<!--', 'color: red', 'style=', 'missing.css']) {
      expect(html, gone).not.toContain(gone);
    }
    // D-335 slice R — a frame from this site is read in place, as a person sees it; it was dropped.
    expect(html).toContain('<iframe><body><p>frame text</p></body></iframe>');
    // The drawing goes and the picture's label stays.
    expect(html).toContain('<svg role="img" aria-label="Icon"></svg>');
    // `display: contents` draws no box of its own, but what is inside it is shown.
    expect(html).toContain('<div><span>inside display contents</span></div>');
    expect(html).toContain('<p>Visible text <b>bold</b></p>');
    expect(html).toContain('<pre id="block">line one\n  indented</pre>');
  }, 60_000);

  it.each(PATHS)('%s: only the listed attributes and three readable class names are kept', async path => {
    const { inspect } = await open(path);
    const html = htmlOf(await inspect({}));
    expect(html.startsWith('<body class="layout-root page-body extra-name">')).toBe(true);
    expect(html).toContain('<a ref="e1" id="next" href="/next" aria-label="Next page">Next</a>');
    expect(html).toContain('<header><h1 title="Heading title">Inspect fixture</h1></header>');
    for (const gone of ['data-tracking', 'onclick', 'target=', 'rel=', 'data-x', 'tabindex', 'autocomplete',
      'fourth-name', 'hover:bg', '[mask]', 'x1y2', '"ab']) {
      expect(html, gone).not.toContain(gone);
    }
    // The page's own `ref` attribute is not one the read keeps.
    expect(html).toContain('<div id="planted">Planted ref attribute</div>');
  }, 60_000);

  it.each(PATHS)('%s: every element a person can act on carries a ref, in document order', async path => {
    const { inspect } = await open(path);
    const html = htmlOf(await inspect({}));
    const refs = refsIn(html);
    expect(refs.map(row => row.id)).toEqual(['next', 'save', 'custom', 'focusable', 'name', 'agree', 'gold', 'pw',
      'code', 'card', 'notes', 'stage', 'editor', 'panel', 'panel-link', 'panel-button', 'long-value']);
    expect(refs.map(row => row.ref)).toEqual(refs.map((_, index) => `e${index + 1}`));
    for (const plain of ['<a name="anchor-only">', '<span id="unfocusable">', '<div id="plain">', '<label for="name">']) {
      expect(html, plain).toContain(plain);
    }
    // An editor takes one ref; its own paragraphs are part of it.
    expect(html).toContain('<div ref="e13" id="editor" contenteditable="true"><p>Draft</p></div>');
  }, 60_000);

  it.each(PATHS)('%s: fields show what they hold now, and protected ones keep no value', async path => {
    const { inspect } = await open(path);
    const html = htmlOf(await inspect({}));
    expect(html).toContain('<input ref="e5" id="name" name="name" placeholder="Your name" value="Ada">');
    expect(html).toContain('<input ref="e6" id="agree" type="checkbox" checked>');
    expect(html).toContain('<input ref="e7" id="gold" name="tier" type="radio">');
    expect(html).toContain('<button ref="e2" id="save" type="submit" disabled>Save</button>');
    // What was typed after load, not the markup.
    expect(html).toContain('<textarea ref="e11" id="notes">typed later</textarea>');
    expect(html).toContain('<select ref="e12" id="stage"><option value="">Choose</option>'
      + '<option value="won" selected>Closed won</option><option>Lost</option></select>');
    expect(html).toContain('<input ref="e8" id="pw" type="password">');
    expect(html).toContain('<input ref="e9" id="code">');
    expect(html).toContain('<input ref="e10" id="card">');
    for (const secret of ['hunter2', '123456', '4111111111111111', 'token-123', 'csrf']) {
      expect(html, secret).not.toContain(secret);
    }
  }, 60_000);

  it.each(PATHS)('%s: a long text or value is cut to 2,000 characters and an ellipsis', async path => {
    const { inspect } = await open(path);
    const html = htmlOf(await inspect({}));
    expect(html).toContain(`<p id="long">${'x'.repeat(2_000)}…</p>`);
    expect(html).toContain(`<input ref="e17" id="long-value" value="${'y'.repeat(2_000)}…">`);
  }, 60_000);

  it.each(PATHS)('%s: a page past the cap is cut at an element, still closed, and says so', async path => {
    const { inspect } = await open(path, '/big');
    const result = await inspect({});
    const html = htmlOf(result);
    expect(result.outputs!.truncated).toBe(true);
    expect(html.length).toBeLessThanOrEqual(BRIDGE_INSPECT_MAX_CHARS);
    expect(html.length).toBeGreaterThan(BRIDGE_INSPECT_MAX_CHARS - 100);
    expect(html.startsWith('<body><main><p>Paragraph 1 of the long page.</p>')).toBe(true);
    expect(html.endsWith('.</p></main></body>')).toBe(true);
    expect(html.match(/<p>/g)!.length).toBe(html.match(/<\/p>/g)!.length);
    expect(html).not.toContain('Paragraph 3000 ');
  }, 60_000);

  // D-335 slice P — the server names the size: a whole page past 40,000, and a text past 2,000.
  it.each(PATHS)('%s: a read as large as the server names takes the whole page, and a long text whole', async path => {
    const big = await open(path, '/big');
    const whole = await big.inspect({ max_chars: 200_000 });
    const html = htmlOf(whole);
    expect(whole.outputs!.truncated).toBe(false);
    expect(html.length).toBeGreaterThan(BRIDGE_INSPECT_MAX_CHARS * 2);
    expect(html.endsWith('<p>Paragraph 3000 of the long page.</p></main></body>')).toBe(true);
    // A size below the page's cuts it there, at an element, as the 40,000 did.
    const part = await big.inspect({ max_chars: 1_000 });
    expect(part.outputs!.truncated).toBe(true);
    expect(htmlOf(part).length).toBeLessThanOrEqual(1_000);
    const { inspect } = await open(path);
    expect(htmlOf(await inspect({ max_value_chars: 6_000 }))).toContain(`<p id="long">${'x'.repeat(5_000)}</p>`);
  }, 60_000);

  // D-335 slice R — what a person sees in a web component, open or closed, read in place, and its
  // controls acted on by ref like any other.
  it.each(PATHS)('%s: a web component\'s content is read as it is shown, slots and all, and its controls act by ref', async path => {
    const { inspect, send, clicks, fixture } = await open(path, '/components');
    const read = await inspect({});
    const html = htmlOf(read);
    for (const shown of ['Before the components.', 'Slotted title', 'Inside an open card.', 'Open action', 'Fallback shown',
      'Inside a closed card.', 'Closed action']) expect(html, shown).toContain(shown);
    // Not slotted, so not drawn; a filled slot's fallback; hidden in the card; the slot itself.
    for (const gone of ['Unslotted light text', 'Fallback title', 'Hidden in the card', '<slot']) expect(html, gone).not.toContain(gone);
    const openButton = /<button ref="(e\d+)" id="open-button"/.exec(html)?.[1];
    const closedButton = /<button ref="(e\d+)" type="button">Closed action/.exec(html)?.[1];
    const openField = /<input ref="(e\d+)" id="open-field"/.exec(html)?.[1];
    expect([openButton, closedButton, openField].every(ref => ref !== undefined)).toBe(true);
    const page = read.outputs!.page;
    // A click inside a component is not "covered" by the component around it.
    expect(await send('click', { page, ref: openButton })).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    expect(await send('click', { page, ref: closedButton })).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    expect(await clicks()).toEqual(['open-button', 'closed-button']);
    // What covers a control inside its own component is seen, as a person's click would meet it.
    const coveredButton = /<button ref="(e\d+)" id="covered-button"/.exec(html)?.[1];
    expect(await send('click', { page, ref: coveredButton })).toMatchObject({ status: 'error', error: { code: 'value_not_applied',
      message: expect.stringContaining('Something else on the page covers it (“Cookie choice”)') } });
    expect(await clicks()).toEqual(['open-button', 'closed-button']);
    expect(await send('fill', { page, ref: openField, value: 'typed in a card' })).toMatchObject({ status: 'ok', outputs: { filled: true } });
    expect(await fixture.page.evaluate(() => (document.querySelector('open-card')!.shadowRoot!.querySelector('#open-field') as HTMLInputElement).value))
      .toBe('typed in a card');
  }, 60_000);

  // D-347 follow-up 18 (2026-11-08) — a click waits for what covers its element to go: the banner it names
  // comes round, a notice that new mail has come goes. One that stays is answered after the wait.
  it('ordinary: a banner shown in turn is clicked once it shows, by the ref read while another showed', async () => {
    const { inspect, send, clicks, fixture } = await open('ordinary', '/rotating');
    const read = await inspect({});
    const page = read.outputs!.page;
    const offer = refFor(htmlOf(read), 'offer-c')!;
    await fixture.page.evaluate(() => (window as unknown as { turn: (id: string, ms: number) => void }).turn('offer-c', 700));
    expect(await send('click', { page, ref: offer })).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    expect(await clicks()).toEqual(['offer-c']);
  }, 60_000);

  it('ordinary: a button a passing notice covers is clicked once it has gone; one it stays over is refused after the wait', async () => {
    const { inspect, send, clicks, fixture } = await open('ordinary', '/rotating');
    const read = await inspect({});
    const page = read.outputs!.page;
    const refresh = refFor(htmlOf(read), 'refresh')!;
    const notice = (ms: number) => fixture.page.evaluate((shown) => (window as unknown as { notice: (ms: number) => void }).notice(shown), ms);
    await notice(700);
    expect(await send('click', { page, ref: refresh })).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    await notice(0);
    expect(await send('click', { page, ref: refresh })).toMatchObject({ status: 'error', error: { code: 'value_not_applied',
      message: 'Something else on the page covers it (“New mail”), and still did after 8 s, so it was not clicked. '
        + 'Close or answer that first.' } });
    expect(await clicks()).toEqual(['refresh']);
  }, 60_000);

  // D-335 slice R — a frame from this site (and an editor's blank frame) read in place and acted on
  // through the page's own handle; a frame from another site named as a page of its own.
  it('ordinary: a frame from this site is read in place, another site\'s is a page of its own, and each acts', async () => {
    const at = `/frames?other=${encodeURIComponent(other)}`;
    // Every site, as the toolkit's grant is: the frame from the other test site is read under it too.
    const { inspect, send, fixture } = await open('ordinary', at, '*://*/*');
    await fixture.page.waitForFunction(() => document.querySelectorAll('iframe').length === 3
      && [...document.querySelectorAll('iframe')].every(frame => frame.src === '' || frame.contentDocument === null
        || frame.contentDocument.readyState === 'complete'));
    await fixture.page.waitForTimeout(300);
    const read = await inspect({});
    const html = htmlOf(read);
    const page = read.outputs!.page as string;
    expect(html).toContain(`<iframe src="${base}/frame-inner" title="Same site"><body><p>Inside the frame.</p>`);
    const innerButton = new RegExp(`<iframe src="${base}/frame-inner" title="Same site">.*?<button ref="(e\\d+)"`).exec(html)?.[1];
    expect(innerButton).toBeDefined();
    const editor = /<iframe title="Editor"><body ref="(e\d+)" contenteditable="true"><p>Draft text<\/p><\/body><\/iframe>/.exec(html)?.[1];
    expect(editor).toBeDefined();
    const named = new RegExp(`<iframe src="${other}/frame-inner" title="Other site" page="(\\d+:[\\w-]+)"></iframe>`).exec(html);
    expect(named).not.toBeNull();
    const framePage = named![1]!;
    expect(framePage).not.toBe(page);
    expect(html).not.toContain('data-recued-frame');

    // In place: the same-site frame's button by the page's own handle, and the editor typed into.
    expect(await send('click', { page, ref: innerButton })).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    const sameFrame = fixture.page.frames().find(frame => frame.url() === `${base}/frame-inner`)!;
    expect(await sameFrame.evaluate(() => (window as unknown as { clicks: string[] }).clicks)).toEqual(['inner']);
    expect(await send('fill', { page, ref: editor, value: 'Typed into the editor' })).toMatchObject({ status: 'ok', outputs: { filled: true } });
    const editorFrame = fixture.page.frames().find(frame => frame.url() === 'about:srcdoc')!;
    expect(await editorFrame.evaluate(() => document.body.innerText.trim())).toBe('Typed into the editor');

    // The other site's frame, read and acted on as its own page.
    const inner = await inspect({ page: framePage });
    const innerHtml = htmlOf(inner);
    expect(inner.outputs).toMatchObject({ page: framePage, url: `${other}/frame-inner`, title: 'Inner', truncated: false });
    const otherButton = /<button ref="(e\d+)" id="inner-button"/.exec(innerHtml)?.[1];
    expect(otherButton).toBeDefined();
    const clickedThere = await send('click', { page: framePage, ref: otherButton });
    expect(clickedThere, JSON.stringify(clickedThere.error)).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    const otherFrame = fixture.page.frames().find(frame => frame.url() === `${other}/frame-inner`)!;
    expect(await otherFrame.evaluate(() => (window as unknown as { clicks: string[] }).clicks)).toEqual(['inner']);
  }, 60_000);

  it('reviewed: a frame from this site is read in place; another site\'s, a document of its own, is named as one it cannot read', async () => {
    const at = `/frames?other=${encodeURIComponent(other)}`;
    const { inspect, fixture } = await open('reviewed', at);
    await fixture.page.waitForTimeout(500);
    const html = htmlOf(await inspect({}));
    expect(html).toContain('<p>Inside the frame.</p>');
    expect(html).toContain(`<iframe src="${other}/frame-inner" title="Other site" unread=""></iframe>`);
    expect(html).not.toContain(' page="');
  }, 60_000);

  it.each(PATHS)('%s: a ref reads its region in a later command, with the same refs', async path => {
    const { inspect } = await open(path);
    const whole = await inspect({});
    const page = whole.outputs!.page;
    const panel = refFor(htmlOf(whole), 'panel');
    expect(panel).toBe('e14');
    const region = await inspect({ page, ref: panel });
    expect(region.outputs!.page).toBe(page);
    expect(htmlOf(region)).toBe('<section ref="e14" id="panel"><a ref="e15" id="panel-link" href="/a">Panel link</a>'
      + '<button ref="e16" id="panel-button">Go</button></section>');
    // A selector reads a region too, and a second whole read numbers nothing anew.
    expect(htmlOf(await inspect({ selector: '#stage' }))).toMatch(/^<select ref="e12" id="stage">/);
    expect(htmlOf(await inspect({}))).toBe(htmlOf(whole));
  }, 60_000);

  it.each(PATHS)('%s: a ref resolves only through the Bridge, never through the page', async path => {
    const { inspect, fixture } = await open(path);
    const page = (await inspect({})).outputs!.page;
    // The page marked another element `ref="e1"`; e1 is still the link.
    expect(htmlOf(await inspect({ page, ref: 'e1' }))).toBe(
      '<a ref="e1" id="next" href="/next" aria-label="Next page">Next</a>');
    // And the page's own scripts cannot see the map.
    expect(await fixture.page.evaluate(() => 'recuedPageRefs' in window)).toBe(false);
  }, 60_000);

  it.each(PATHS)('%s: a ref whose element the page replaced fails, and the new one gets a new ref', async path => {
    const { inspect, fixture } = await open(path);
    const page = (await inspect({})).outputs!.page;
    await fixture.page.evaluate(() => {
      const fresh = document.createElement('section');
      fresh.id = 'panel';
      fresh.setAttribute('tabindex', '0');
      fresh.textContent = 'Replaced';
      document.querySelector('#panel')!.replaceWith(fresh);
    });
    expect(await inspect({ page, ref: 'e14' })).toMatchObject(PAGE_CHANGED);
    expect(refFor(htmlOf(await inspect({})), 'panel')).toBe('e18');
  }, 60_000);

  it('ordinary: after a reload, the page handle and its refs fail rather than read the new page', async () => {
    const { inspect, fixture } = await open('ordinary');
    const page = (await inspect({})).outputs!.page;
    await fixture.page.reload();
    expect(await inspect({ page, ref: 'e14' })).toMatchObject(PAGE_GONE);
    expect(await inspect({ page })).toMatchObject(PAGE_GONE);
    // Read afresh, the new page numbers its refs from the start.
    const again = await inspect({});
    expect(again.outputs!.page).not.toBe(page);
    expect(refFor(htmlOf(again), 'panel')).toBe('e14');
  }, 60_000);

  it('reviewed: after a reload, the reviewed document is gone and nothing is read', async () => {
    const { inspect, fixture } = await open('reviewed');
    expect(htmlOf(await inspect({}))).toContain('ref="e14"');
    await fixture.page.reload();
    expect(await inspect({})).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
  }, 60_000);

  it.each(PATHS)('%s: a selector that matches nothing, or is not CSS, is reported', async path => {
    const { inspect } = await open(path);
    expect(await inspect({ selector: '#absent' })).toMatchObject({ status: 'error', error: {
      code: 'selector_not_found', message: 'No element on the page matches the selector.' } });
    expect(await inspect({ selector: 'p[' })).toMatchObject({ status: 'error', error: {
      code: 'selector_not_found', message: 'The selector is not valid CSS.' } });
  }, 60_000);

  it('ordinary: a page handle cannot read a site outside the command\'s grant', async () => {
    const { inspect, fixture } = await open('ordinary');
    const away = await fixture.browser.newPage();
    await away.goto(`${other}/page`);
    const document = (await fixture.documents()).find(row => row.url === `${other}/page`);
    if (!document) throw new Error('the bridge did not inventory the other origin');
    const result = await inspect({ page: `${document.tab_id}:${document.document_id}` });
    expect(result).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked',
      message: 'The page is no longer on a site this step may read.' } });
    expect(result.outputs).toBeUndefined();
  }, 60_000);

  it('ordinary: a ref without its page is refused before anything is read', async () => {
    const { inspect } = await open('ordinary');
    expect(await inspect({ ref: 'e1' })).toMatchObject({ status: 'error',
      error: { code: 'unknown', message: 'bridge: A ref needs the page it came from.' } });
  }, 60_000);

  // The reviewed inventory never lists the owner client (`describeOpenBridgeDocuments`).
  it('ordinary: the owner client is never read', async () => {
    const { inspect } = await open('ordinary', '/owner');
    const result = await inspect({});
    expect(result).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
    expect(JSON.stringify(result)).not.toContain('pending review');
  }, 60_000);

  // ── D-335 slice B — typing and clicking by the refs inspect marks, and an
  //    element described as a person would name it.

  it.each(PATHS)('%s: a ref types into the field and clicks the element inspect marked', async path => {
    const { inspect, send, clicks, fixture } = await open(path);
    const page = (await inspect({})).outputs!.page;
    expect(await send('fill', { page, ref: 'e5', value: 'Grace' })).toMatchObject({ status: 'ok', outputs: { filled: true } });
    expect(await fixture.page.locator('#name').inputValue()).toBe('Grace');
    expect(await send('click', { page, ref: 'e3' })).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    // A page handle with a selector is bound to that page too, and carries no ref.
    expect(await send('fill', { page, selector: '#notes', value: 'by selector' })).toMatchObject({ status: 'ok' });
    expect(await fixture.page.locator('#notes').inputValue()).toBe('by selector');
    expect(await clicks()).toEqual(['custom']);
  }, 60_000);

  it.each(PATHS)('%s: an element is described as a person would name it', async path => {
    const { inspect, send } = await open(path);
    const page = (await inspect({})).outputs!.page;
    const named = await send('describe', { page, ref: 'e5' });
    expect(named).toMatchObject({ status: 'ok' });
    expect(named.outputs).toEqual({ page, url: `${base}/page`, title: 'Inspect fixture', role: 'text field', label: 'Name',
      protected: false });
    expect(await send('describe', { page, ref: 'e1' })).toMatchObject({ outputs: { role: 'link', label: 'Next page' } });
    expect(await send('describe', { page, ref: 'e3' })).toMatchObject({ outputs: { role: 'button', label: 'Custom button' } });
    expect(await send('describe', { page, ref: 'e13' })).toMatchObject({ outputs: { role: 'text editor' } });
    expect(await send('describe', { page, ref: 'e8' })).toMatchObject({ outputs: { role: 'password field', protected: true } });
    expect(await send('describe', { page, selector: '#card' })).toMatchObject({ outputs: { protected: true } });
  }, 60_000);

  it.each(PATHS)('%s: a ref whose element the page replaced types and clicks nothing', async path => {
    const { inspect, send, fixture } = await open(path);
    const page = (await inspect({})).outputs!.page;
    await fixture.page.evaluate(() => {
      const fresh = document.createElement('input');
      fresh.id = 'name';
      document.querySelector('#name')!.replaceWith(fresh);
    });
    expect(await send('fill', { page, ref: 'e5', value: 'Grace' })).toMatchObject(PAGE_CHANGED);
    expect(await send('click', { page, ref: 'e5' })).toMatchObject(PAGE_CHANGED);
    expect(await fixture.page.locator('#name').inputValue()).toBe('');
  }, 60_000);

  it.each(PATHS)('%s: a ref clicks the element the Bridge marked, not one the page labelled with it', async path => {
    const { inspect, send, clicks, fixture } = await open(path);
    const page = (await inspect({})).outputs!.page;
    await fixture.page.evaluate(() => document.querySelector('#plain')!.setAttribute('ref', 'e3'));
    expect(await send('click', { page, ref: 'e3' })).toMatchObject({ status: 'ok' });
    expect(await clicks()).toEqual(['custom']);
  }, 60_000);

  it('ordinary: after a reload, a write by ref types and clicks nothing', async () => {
    const { inspect, send, clicks, fixture } = await open('ordinary');
    const page = (await inspect({})).outputs!.page;
    await fixture.page.reload();
    expect(await send('fill', { page, ref: 'e5', value: 'Grace' })).toMatchObject(PAGE_GONE);
    expect(await send('click', { page, ref: 'e3' })).toMatchObject(PAGE_GONE);
    expect(await fixture.page.locator('#name').inputValue()).toBe('Ada');
    expect(await clicks()).toEqual([]);
  }, 60_000);

  it('ordinary: a write by page handle cannot reach a site outside the command\'s grant', async () => {
    const { inspect, send, fixture } = await open('ordinary');
    const away = await fixture.browser.newPage();
    await away.goto(`${other}/page`);
    const document = (await fixture.documents()).find(row => row.url === `${other}/page`);
    if (!document) throw new Error('the bridge did not inventory the other origin');
    const handle = `${document.tab_id}:${document.document_id}`;
    // The refused read still marks that page's refs, so the write has one to try.
    await inspect({ page: handle });
    expect(await send('fill', { page: handle, ref: 'e5', value: 'Grace' })).toMatchObject({ status: 'error',
      error: { code: 'tab_navigation_blocked', message: 'The page is no longer on a site this step may read.' } });
    expect(await away.locator('#name').inputValue()).toBe('Ada');
  }, 60_000);

  it('ordinary: a click by selector, with no page, still clicks in the matched tab', async () => {
    const { send, clicks } = await open('ordinary');
    expect(await send('click', { selector: '#custom' })).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    expect(await clicks()).toEqual(['custom']);
  }, 60_000);

  it('ordinary: the owner client is never described', async () => {
    const { send } = await open('ordinary', '/owner');
    expect(await send('describe', { selector: 'p' })).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
  }, 60_000);

  // ── D-335 slice C — the open tabs, and a page opened in a new tab. The
  //    reviewed executor runs neither: a reviewed step is bound to one page.

  type Listed = { page: string; url: string; title: string };
  const listed = async (send: Awaited<ReturnType<typeof open>>['send']) => {
    const result = await send('list_tabs', {});
    expect(result, JSON.stringify(result.error)).toMatchObject({ status: 'ok', outputs: { truncated: false } });
    return result.outputs!.tabs as Listed[];
  };

  it('ordinary: the open tabs on the site are listed with their pages, never the owner client or another site', async () => {
    const { send, fixture } = await open('ordinary');
    for (const url of [`${base}/big`, `${base}/owner`, `${other}/page`]) await (await fixture.browser.newPage()).goto(url);
    const tabs = await listed(send);
    expect(tabs.map(tab => [tab.url, tab.title]).sort()).toEqual([[`${base}/big`, 'Big'], [`${base}/page`, 'Inspect fixture']]);
    // A listed page is one the next step can read.
    const big = tabs.find(tab => tab.url === `${base}/big`)!;
    expect(await send('inspect', { page: big.page, selector: 'main p' }))
      .toMatchObject({ status: 'ok', outputs: { page: big.page, html: '<p>Paragraph 1 of the long page.</p>' } });
  }, 60_000);

  it('ordinary: a page opens in a new tab, leaves the open one alone, and answers its page', async () => {
    const { send, fixture } = await open('ordinary');
    const before = (await listed(send)).length;
    const opened = await send('open_tab', { url: `${base}/big` });
    expect(opened).toMatchObject({ status: 'ok', outputs: { url: `${base}/big`, title: 'Big' } });
    expect((await listed(send)).length).toBe(before + 1);
    expect(fixture.page.url()).toBe(`${base}/page`);
    expect(await send('inspect', { page: opened.outputs!.page, selector: 'main p' })).toMatchObject({ status: 'ok' });
  }, 60_000);

  it('ordinary: only an http or https address on the site opens; anything else opens nothing', async () => {
    const { send, fixture } = await open('ordinary');
    const before = (await fixture.documents()).length;
    const refused = (message: string) => ({ status: 'error', error: { code: 'tab_navigation_blocked', message } });
    const notWeb = 'Only an http or https address, without a user name or password, can be opened.';
    expect(await send('open_tab', { url: 'javascript:alert(1)' })).toMatchObject(refused(notWeb));
    expect(await send('open_tab', { url: 'file:///etc/hosts' })).toMatchObject(refused(notWeb));
    expect(await send('open_tab', { url: `http://user:secret@${base.slice('http://'.length)}/page` })).toMatchObject(refused(notWeb));
    expect(await send('open_tab', { url: 'not an address' })).toMatchObject(refused('The address is not a web address.'));
    expect(await send('open_tab', { url: `${other}/page` })).toMatchObject(refused('The address is not on a site this step may open.'));
    expect((await fixture.documents()).length).toBe(before);
  }, 60_000);

  it('ordinary: a page that goes on to another site, or the owner client, has its tab closed', async () => {
    const { send, fixture } = await open('ordinary');
    const otherPort = new URL(other).port;
    const reached = hits[`${otherPort}/page`] ?? 0;
    expect(await send('open_tab', { url: `${base}/away` })).toMatchObject({ status: 'error', error: {
      code: 'tab_navigation_blocked', message: 'The page went on to a site this step may not open, so its tab was closed.' } });
    // It did reach the other site, and no tab is left there.
    expect(hits[`${otherPort}/page`]).toBe(reached + 1);
    expect((await fixture.documents()).map(row => row.url)).not.toContain(`${other}/page`);
    // The page list sees a tab the extension opens (or "closed" below would prove nothing) …
    expect(await send('open_tab', { url: `${base}/big` })).toMatchObject({ status: 'ok' });
    expect(fixture.browser.pages().map(page => page.url())).toContain(`${base}/big`);
    // … and the owner client's is gone.
    expect(await send('open_tab', { url: `${base}/owner` })).toMatchObject({ status: 'error', error: {
      code: 'tab_navigation_blocked', message: 'The owner client cannot be automated, so its tab was closed.' } });
    expect(fixture.browser.pages().map(page => page.url())).not.toContain(`${base}/owner`);
  }, 60_000);
});

