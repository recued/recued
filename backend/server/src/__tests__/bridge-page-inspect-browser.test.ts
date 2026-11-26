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
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest';
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
  parseBrowserCollectSpec,
} from '@recued/contracts';
import { collectBrowserPages } from '../bridges/browser-collect.js';
import { outlinePage, PAGE_COVER_NOTE_TAIL } from '../bridges/page-outline.js';
import { createReviewedBrowserFixture } from './d-261-browser-fixture.js';

const STRUCTURE = `<!doctype html><html><head><title>Sibling positions</title></head><body>
<main id="rows">
<div hidden data-secret="hidden row"><input value="hidden input"><span>Hidden subtree</span></div>
<div class="row" id="first"><span hidden data-secret="hidden cell">Hidden text</span><b>Label</b>
<script>/* secret script */</script><span>Ada</span><span aria-hidden="true">Hidden aria</span><span>CA</span></div>
<style>.unused { color: red }</style>
<div class="row" id="second"><span hidden>Hidden text</span><b>Label</b>
<template><input value="secret template"></template><span>Grace</span><span hidden>Hidden cell</span><span>NY</span></div>
</main><input type="hidden" value="secret token" name="private">
<p data-recued-structural-only>Visible marker text</p>
<select id="choices"><option hidden value="secret option">Hidden option</option><option>Ada</option></select>
<table id="table"><tbody><tr hidden><td>Secret</td></tr><tr><td hidden>Secret</td><td>Ada</td><td>CA</td></tr></tbody></table>
</body></html>`;

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

const TOOLTIPS = `<!doctype html><html><head><title>Shortcut tooltips</title></head><body>
<form id="search" action="/second"><input id="q" type="search" name="search" accesskey="f"
  aria-label="Search Wikipedia" title="Search Wikipedia [f]"></form>
<ul><li><span id="owner">Ada</span> <a id="view" accesskey="g" title="View [g]" href="/one">View</a></li></ul>
<script>window.clicks = [];document.querySelector('#view').addEventListener('click', event => {
  event.preventDefault();window.clicks.push('view');
});</script></body></html>`;

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
/** 2026-11-21 (D-402, task P) — notes in cards, as task P's notes app draws them: no list item or table row holds
 *  a note, so a step names its Edit by the card it sits in (`within_card`). */
const CARDS = `<!doctype html><html><head><title>Notes</title></head><body><main><h1>MyNotes</h1><div class="row">
<div class="col"><div data-testid="note-card" class="card"><div class="card-header" id="title-a">Bench stock review</div>
<div class="card-footer"><input id="qty-a" aria-label="Quantity"><button id="edit-a" type="button">Edit</button></div></div></div>
<div class="col"><div data-testid="note-card" class="card"><div class="card-header" id="title-b">Grocery list</div>
<div class="card-footer"><input id="qty-b" aria-label="Quantity"><button id="edit-b" type="button">Edit</button></div></div></div>
</div></main><script>
window.clicks = [];
for (const id of ['edit-a', 'edit-b']) document.getElementById(id).addEventListener('click', () => window.clicks.push(id));
</script></body></html>`;

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

/** 2026-11-22 — cnn.com's "Legal Terms and Privacy", as it is built: a modal dialog inside a wrapper marked
 *  aria-hidden, in a see-through layer over the whole page. The wrapper also holds words and a paragraph of
 *  its own, and the dialog a mark it hides; Agree takes the layer away. */
const HIDDEN_DIALOG = `<!doctype html><html><head><title>Hidden dialog</title></head><body style="margin:0">
<main><h1>Morning news</h1><a id="story" href="#story">Read the story</a></main>
<div id="shell" aria-hidden="true">Hidden wrapper words<p>Hidden sibling text</p>
<div id="layer" style="position:fixed;inset:0;z-index:1000">
<div id="terms" role="dialog" aria-modal="true" aria-labelledby="terms-title"
 style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:520px;padding:24px;background:#fff;border:1px solid #000">
<h2 id="terms-title">Legal Terms and Privacy</h2><p>By clicking "Agree", you agree to the Terms of Use.</p>
<span aria-hidden="true">Decorative mark</span><button id="agree">Agree</button></div></div></div>
<script>window.clicks = [];
document.getElementById('story').addEventListener('click', event => { event.preventDefault(); window.clicks.push('story'); });
document.getElementById('agree').addEventListener('click', () => { window.clicks.push('agree'); document.getElementById('layer').remove(); });
</script></body></html>`;
/** A dialog marked aria-hidden that something else covers: not on top, so not read. */
const HIDDEN_BEHIND = `<!doctype html><html><head><title>Hidden behind</title></head><body style="margin:0">
<main><h1>Front page</h1></main>
<div aria-hidden="true"><div role="dialog" aria-modal="true" style="position:fixed;inset:0;z-index:1;background:#eee">
<h2>Old notice</h2><button id="dismiss">Dismiss</button></div></div>
<div style="position:fixed;inset:0;z-index:2;background:#fff"><p>Cover text</p></div></body></html>`;
/** A whole page marked aria-hidden under an overlay that is not a dialog (as Google's vignette ad does): since
 *  2026-11-22 the overlay is read as what covers the page, and the page behind it is not. */
const HIDDEN_PAGE = `<!doctype html><html><head><title>Hidden page</title></head><body aria-hidden="true" style="margin:0">
<main><h1>Article</h1><p>Article text</p></main>
<ins style="display:block;position:fixed;inset:0;z-index:2147483647;background:#333"><span>Advertisement</span>
<button>Close ad</button></ins></body></html>`;
/** A modal dialog the page does not hide, with the page behind it marked aria-hidden: as before, the
 *  dialog is read and what is behind it is not. */
const BACKGROUND_HIDDEN = `<!doctype html><html><head><title>Background hidden</title></head><body style="margin:0">
<div id="app" aria-hidden="true"><h1>App</h1><button id="behind">Behind</button></div>
<div style="position:fixed;inset:0;z-index:5;background:rgba(0,0,0,0.4)"></div>
<div role="dialog" aria-modal="true" aria-label="Sign up"
 style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:400px;padding:24px;background:#fff;z-index:10">
<p>Join us</p><button id="close">Close</button></div></body></html>`;
/** A dialog marked aria-hidden inside a closed web component, on top. */
const HIDDEN_IN_COMPONENT = `<!doctype html><html><head><title>Hidden in a component</title></head><body style="margin:0">
<main><h1>Shop</h1></main><consent-box></consent-box>
<script>customElements.define('consent-box', class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'closed' }).innerHTML = '<div aria-hidden="true"><div role="dialog" aria-modal="true" aria-label="Cookies"'
      + ' style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:400px;padding:24px;background:#fff;z-index:10">'
      + '<p>We use cookies</p><button id="accept">Accept</button></div></div>';
  }
});</script></body></html>`;

/** 2026-11-22 (the owner: "build the 'show the blocker' version") — a page that marks itself hidden under an ad's layer
 *  with a countdown, whose Close button shows once it ends and takes the layer away. */
const COUNTDOWN_COVER = `<!doctype html><html><head><title>Countdown cover</title></head><body style="margin:0">
<main><h1>Recipe</h1><p>Recipe text</p><a id="next" href="#next">Next step</a></main>
<script>window.clicks = [];
document.getElementById('next').addEventListener('click', event => { event.preventDefault(); window.clicks.push('next'); });
document.body.setAttribute('aria-hidden', 'true');
const cover = document.createElement('div'); cover.id = 'cover';
cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff';
cover.innerHTML = '<p>Advertisement</p><p id="count">You can close this ad in 2 seconds.</p>';
document.body.appendChild(cover);
setTimeout(() => {
  document.getElementById('count').textContent = 'You can close this ad now.';
  const close = document.createElement('button'); close.id = 'close'; close.textContent = 'Close';
  close.addEventListener('click', () => { window.clicks.push('close'); cover.remove(); document.body.removeAttribute('aria-hidden'); });
  cover.appendChild(close);
}, 2000);
</script></body></html>`;
/** A fixed panel marked aria-hidden away from the screen's centre, on a page that is not hidden: not read. */
const HIDDEN_CORNER = `<!doctype html><html><head><title>Hidden corner</title></head><body style="margin:0">
<main><h1>Front page</h1><p>Front text</p></main>
<div aria-hidden="true" style="position:fixed;right:0;bottom:0;width:40vw;height:40vh;background:#eee"><p>Corner panel</p></div>
</body></html>`;
/** A small modal dialog the page does not hide, away from the centre, and the page behind it fixed over the
 *  screen and marked hidden: what is at the centre is that page, hidden on purpose, so it is not read. */
const MODAL_ASIDE = `<!doctype html><html><head><title>Modal aside</title></head><body style="margin:0">
<div aria-hidden="true" style="position:fixed;inset:0;z-index:1;background:#fff"><h1>App behind</h1><button id="behind">Behind</button></div>
<div role="dialog" aria-modal="true" aria-label="Notice"
 style="position:fixed;left:0;top:0;width:300px;height:150px;z-index:10;background:#fff"><p>Small notice</p><button id="ok">OK</button></div>
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
  // Legacy content assertions describe the cleaned page; internal stability
  // metadata has its own raw-snapshot test below.
  return (result.outputs!.html as string).replace(/ data-recued-field-context="[^"]*"/g, '');
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
      '/keys': KEYS, '/selectors': SELECTORS, '/menu': MENU, '/rotating': ROTATING, '/tooltips': TOOLTIPS, '/structure': STRUCTURE, '/cards': CARDS,
      '/hidden-dialog': HIDDEN_DIALOG, '/hidden-behind': HIDDEN_BEHIND, '/hidden-page': HIDDEN_PAGE,
      '/background-hidden': BACKGROUND_HIDDEN, '/hidden-in-component': HIDDEN_IN_COMPONENT, '/countdown-cover': COUNTDOWN_COVER,
      '/hidden-corner': HIDDEN_CORNER, '/modal-aside': MODAL_ASIDE },
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

  beforeEach(() => {
    onTestFailed(() => { console.error('[d261] page inspection fixture', browser?.diagnostics()); });
  });

  /** A fresh page, granted, and a way to inspect it through one executor.
   *  `reset` clears grants too, so grant after it. */
  const open = async (path: Path, at = '/page', pattern = target) => {
    const fixture = browser!;
    await fixture.reset(base + at);
    // A pattern other than this site's (slice R: both test sites, for a frame from the other).
    const granted: BridgeIngredientRef = pattern === target ? ingredient : { ...ingredient, domain_allowlist: [pattern] };
    await fixture.grant(granted);
    // Once the Bridge has found the page, which its load does not promise (the fixture's `discovered`).
    // The owner's Recued client is never in its inventory, so it is not waited for.
    const found = at === '/owner' ? undefined : await fixture.discovered(base + at);
    const reviewed: BridgeDocumentIdentity | undefined = path === 'reviewed' ? found : undefined;
    if (path === 'reviewed' && !reviewed) throw new Error(`the bridge did not inventory ${at}`);
    const send = async (action: 'inspect' | 'reread' | 'describe' | 'fill' | 'click' | 'press' | 'list_tabs' | 'open_tab'
      | 'navigate' | 'go_back' | 'reload_page' | 'close_tab' | 'hover' | 'wait_for_element',
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

  it('preserves live choice semantics and popup ownership without exposing hidden options', async () => {
    const { fixture, inspect } = await open('ordinary');
    await fixture.page.evaluate(() => {
      document.body.innerHTML = '<label>Category<select multiple id="category"><option value="home" selected>Home</option>'
        + '<option value="work" selected>Work</option><option hidden>private-hidden-choice</option>'
        + '<optgroup disabled><option>Locked</option></optgroup></select></label>'
        + '<div role="dialog" aria-modal="true"><button role="combobox" aria-label="Custom category" aria-controls="popup" aria-expanded="true">Home</button></div>'
        + '<div role="listbox" id="popup"><div role="option" aria-selected="false">Work</div></div>'
        + '<input type="checkbox" id="mixed">';
      (document.getElementById('mixed') as HTMLInputElement).indeterminate = true;
    });
    const html = htmlOf(await inspect({}));
    expect(html).toContain(' multiple');
    expect(html).toContain('aria-controls="popup"');
    expect(html).toContain('aria-checked="mixed"');
    expect(html).toContain('<option disabled>Locked</option>');
    expect(html).not.toContain('private-hidden-choice');
  }, 60_000);

  it.each(['ordinary', 'reviewed'] as const)('%s: positional collection agrees with native CSS without hidden data', async path => {
    const { fixture, send } = await open(path, '/structure');
    const normal = await send('inspect', {});
    const snapshot = await send('inspect', { preserve_structure: true },
      [...BRIDGE_INSPECT_OUTPUT_KEYS, 'structure_complete', 'structure_root']);
    expect(snapshot.status).toBe('ok');
    const output = snapshot.outputs!;
    expect(output).toMatchObject({ structure_complete: true, structure_root: '2,2,1,1', truncated: false });
    const html = String(output.html);
    expect(html).toContain('<span data-recued-structural-only></span>');
    expect(html).toContain('<script data-recued-structural-only></script>');
    expect(html).toContain('<template data-recued-structural-only></template>');
    expect(html).toContain('<input data-recued-structural-only>');
    expect(html).toContain('<option data-recued-structural-only></option>');
    expect(html).toContain('<p>Visible marker text</p>');
    expect(html).not.toMatch(/Hidden|hidden row|hidden cell|hidden input|secret|private|Secret/);
    const withoutChoices = (text: string) => text.replace(/<select[^>]*>[\s\S]*?<\/select>/g, '');
    expect(outlinePage(withoutChoices(html), { url: `${base}/structure` }))
      .toEqual(outlinePage(withoutChoices(String(normal.outputs!.html)), { url: `${base}/structure` }));
    for (const selector of ['span:nth-child(4)', 'span:nth-of-type(2)', 'span:nth-last-child(1)',
      'span:nth-last-of-type(3)', ':scope:nth-of-type(2)', 'span:nth-child(2n)', 'span:nth-child(-n+4)',
      'span:nth-child(odd)', 'b:only-of-type', 'span:last-of-type', 'span:first-child']) {
      const parsed = parseBrowserCollectSpec({ items: '#rows > .row', fields: { id: { selector: ':scope', attribute: 'id' }, value: { selector, many: true, required: false } }, max_pages: 1 });
      if (!parsed.ok) throw new Error(parsed.error);
      const result = await collectBrowserPages({ spec: parsed.spec, assertActive() {},
        read: async () => ({ page: String(output.page), url: String(output.url), title: String(output.title), html,
          truncated: false, structure_complete: true, structure_root: String(output.structure_root) }),
        navigate: async () => { throw new Error('single page must not navigate'); } });
      const expected = await fixture.page.evaluate(selector => [...document.querySelectorAll('#rows > .row')].map(row =>
        (selector.startsWith(':scope') ? [row].filter(element => element.matches(selector.slice(6))) : [...row.querySelectorAll(selector)])
          .filter(element => element.getAttribute('aria-hidden') !== 'true' && element.checkVisibility({ checkVisibilityCSS: true }))
          .map(element => (element.textContent ?? '').replace(/\s+/g, ' ').trim())), selector);
      expect(result.complete, selector).toBe(true);
      // :scope's joined text excludes hidden descendants; compare scalar fields
      // to native CSS, and its identity separately through the visible row text.
      if (!selector.startsWith(':scope')) expect(result.records.map(record => record.values.value), selector).toEqual(expected);
      else expect(result.records.map(record => record.values.value)).toEqual([['Label Ada CA'], []]);
    }
    const tableSpec = parseBrowserCollectSpec({ items: '#table tr:nth-child(2)', fields: { name: 'td:nth-child(2)' }, max_pages: 1 });
    if (!tableSpec.ok) throw new Error(tableSpec.error);
    expect(await collectBrowserPages({ spec: tableSpec.spec, assertActive() {},
      read: async () => ({ page: String(output.page), url: String(output.url), title: '', html,
        truncated: false, structure_complete: true, structure_root: String(output.structure_root) }), navigate: async () => ({}) }))
      .toMatchObject({ complete: true, records: [{ values: { name: 'Ada' } }] });
    const cut = await send('inspect', { preserve_structure: true, max_chars: 100 },
      [...BRIDGE_INSPECT_OUTPUT_KEYS, 'structure_complete', 'structure_root']);
    expect(cut.outputs).toMatchObject({ truncated: true, structure_complete: false });
    expect(String(cut.outputs!.html).length).toBeLessThanOrEqual(100);
  });

  it.each(['ordinary', 'reviewed'] as const)('%s: extracts through an unrelated covering iframe while its click stays blocked', async path => {
    const { fixture, send } = await open(path, '/structure');
    await fixture.page.evaluate(other => {
      const ad = document.createElement('iframe');
      ad.src = `${other}/frame-inner`;
      ad.title = 'Advertisement';
      ad.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:9999;border:0';
      document.body.prepend(ad);
      const button = document.createElement('button');
      button.id = 'under-ad'; button.textContent = 'Under ad';
      const state = window as unknown as { underAdClicks: number };
      state.underAdClicks = 0;
      button.onclick = () => { state.underAdClicks++; };
      document.body.append(button);
      const owner = document.createElement('iframe');
      owner.id = 'owner-embed'; owner.src = `${location.origin}/owner`;
      document.body.append(owner);
      // Page-authored markers must not become Bridge structural authority.
      document.querySelector('#table')!.setAttribute('data-recued-structure-incomplete', '');
    }, other);
    // Wait for the DOM marker, independently of whether Chrome paints this covered page.
    await fixture.page.frameLocator('#owner-embed').locator('html[data-recued-owner-surface]')
      .waitFor({ state: 'attached' });
    const snapshot = await send(path === 'reviewed' ? 'inspect' : 'reread', { preserve_structure: true, structure_scoped: true },
      [...BRIDGE_INSPECT_OUTPUT_KEYS, 'structure_complete', 'structure_root', 'structure_scoped']);
    expect(snapshot, JSON.stringify(snapshot.error)).toMatchObject({ status: 'ok', outputs: { structure_complete: false, structure_scoped: true, truncated: false } });
    const output = snapshot.outputs!;
    expect(String(output.html)).not.toMatch(/pending review|owner-embed|\/owner/);
    const parsed = parseBrowserCollectSpec({ items: '#table tbody tr', fields: { name: 'td:nth-child(2)', state: 'td:nth-child(3)' }, max_pages: 1 });
    if (!parsed.ok) throw new Error(parsed.error);
    const result = await collectBrowserPages({ spec: parsed.spec, assertActive() {},
      read: async () => ({ page: String(output.page), url: String(output.url), title: String(output.title), html: String(output.html),
        truncated: false, structure_complete: false, structure_scoped: output.structure_scoped === true, structure_root: String(output.structure_root) }),
      navigate: async () => { throw new Error('single page must not navigate'); } });
    expect(result).toMatchObject({ count: 1, complete: true, records: [{ values: { name: 'Ada', state: 'CA' } }] });
    expect(await send('click', { selector: '#under-ad' })).toMatchObject({ status: 'error', error: { code: 'value_not_applied',
      obstruction: { operation: 'click', executed: false, reason: 'target_occluded', source: 'hit_test',
        target: { tag: 'button' }, blocker: { tag: 'iframe', label: 'Advertisement' }, waited_ms: expect.any(Number) } } });
    expect(await fixture.page.evaluate(() => (window as unknown as { underAdClicks: number }).underAdClicks)).toBe(0);
  }, 60_000);

  it('refuses scoped field extraction inside a projected shadow tree', async () => {
    const { send } = await open('ordinary', '/components');
    const result = await send('reread', { preserve_structure: true, structure_scoped: true },
      [...BRIDGE_INSPECT_OUTPUT_KEYS, 'structure_complete', 'structure_root', 'structure_scoped']);
    expect(result.outputs).toMatchObject({ structure_complete: false, structure_scoped: true });
    const output = result.outputs!;
    const parsed = parseBrowserCollectSpec({ items: 'open-card', fields: { text: { selector: 'button:nth-child(3)', required: false } }, max_pages: 1 });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(await collectBrowserPages({ spec: parsed.spec, assertActive() {},
      read: async () => ({ page: String(output.page), url: String(output.url), title: String(output.title), html: String(output.html),
        truncated: false, structure_complete: false, structure_scoped: output.structure_scoped === true, structure_root: String(output.structure_root) }),
      navigate: async () => { throw new Error('single page must not navigate'); } }))
      .toMatchObject({ count: 0, complete: false, stop_reason: 'structural_snapshot_required' });
  });

  it.each(['ordinary', 'reviewed'] as const)('%s: a guarded link clicks once and excludes forms, changed state and rebuilt nodes', async path => {
    for (const mode of ['stable', 'href', 'form', 'rebuilt', 'row', 'hover'] as const) {
      const { fixture, inspect, send } = await open(path);
      await fixture.page.evaluate(() => {
        document.body.innerHTML = '<main><p id="context">Page 2</p><a id="guard-next" href="/second">Next</a></main>';
        const state = window as unknown as { guardedClicks: number };
        state.guardedClicks = 0;
        document.getElementById('guard-next')!.addEventListener('click', event => { event.preventDefault(); state.guardedClicks++; });
      });
      const read = await inspect({});
      const ref = /<a ref="(e\d+)" id="guard-next"/.exec(htmlOf(read))?.[1];
      expect(ref).toBeDefined();
      await fixture.page.evaluate(mode => {
        const link = document.getElementById('guard-next')!;
        if (mode === 'href') link.setAttribute('href', '/different');
        if (mode === 'form') { const form = document.createElement('form'); form.method = 'post'; link.after(form); form.append(link); }
        if (mode === 'rebuilt') link.replaceWith(link.cloneNode(true));
        if (mode === 'row') link.textContent = 'Delete';
        if (mode === 'hover') link.addEventListener('mouseover', () => link.setAttribute('href', '/changed-during-hover'));
      }, mode);
      const out = await send('click', { page: read.outputs!.page, ref,
        navigation_guard: { before_url: `${base}/page`, after_url: `${base}/second` } }, ['clicked']);
      const count = await fixture.page.evaluate(() => (window as unknown as { guardedClicks: number }).guardedClicks);
      expect(count, mode).toBe(mode === 'stable' ? 1 : 0);
      expect(out.status, `${mode}: ${JSON.stringify(out.error)}`).toBe(mode === 'stable' ? 'ok' : 'error');
      if (mode === 'hover') expect(out.error?.code).toBe('delivery_uncertain');
      expect(fixture.page.url()).toBe(`${base}/page`);
    }
  }, 60_000);

  it('loading-field identity survives unrelated changes but changes with its form owner, destination and field state', async () => {
    const { fixture, inspect } = await open('ordinary');
    await fixture.page.evaluate(() => {
      document.body.innerHTML = '<main><form id="login" method="post" action="/login"><label for="pw">Password</label>'
        + '<input id="pw" type="password" value="PRIVATE_PASSWORD"><input id="email" value="PRIVATE_EMAIL"></form>'
        + '<form id="other" method="post" action="/other"></form><aside id="ad">First ad</aside></main>';
    });
    const identity = async () => {
      const read = await inspect({ max_value_chars: 2_000 });
      expect(read.status, JSON.stringify(read.error)).toBe('ok');
      const html = String(read.outputs!.html);
      expect(html).not.toContain('PRIVATE_PASSWORD');
      expect(html.match(/ data-recued-field-context="[^"]*"/g)?.join('')).not.toContain('PRIVATE_EMAIL');
      const field = outlinePage(html, { url: `${base}/page` }).controls.find(control => control.names.includes('Password'))!;
      expect(field.field_identity).toMatch(/^[a-f0-9]{64}$/);
      return field.field_identity;
    };
    const first = await identity();
    await fixture.page.evaluate(() => {
      document.getElementById('ad')!.textContent = 'Another ad';
      (document.getElementById('email') as HTMLInputElement).value = 'changed sibling';
    });
    expect(await identity()).toBe(first);
    await fixture.page.evaluate(() => { (document.getElementById('login') as HTMLFormElement).action = '/changed'; });
    const destination = await identity();
    expect(destination).not.toBe(first);
    await fixture.page.evaluate(() => { document.getElementById('pw')!.setAttribute('form', 'other'); });
    const owner = await identity();
    expect(owner).not.toBe(destination);
    await fixture.page.evaluate(() => { (document.getElementById('pw') as HTMLInputElement).readOnly = true; });
    expect(await identity()).not.toBe(owner);
  });

  it('ordinary: failed waits distinguish absent selectors, hidden controls and text mismatches without field values', async () => {
    const { fixture, inspect, send } = await open('ordinary');
    await fixture.page.evaluate(() => {
      document.body.innerHTML = '<main><label for="email">Email</label><input id="email" type="text" value="PRIVATE_EMAIL">'
        + '<input id="hidden" hidden><button id="save">Save</button></main>';
    });
    const read = await inspect({});
    for (const [selector, text, expected] of [
      ['input[type="email"]', undefined, { matched: 0, visible: 0, text_matched: 0 }],
      ['#hidden', undefined, { matched: 1, visible: 0, text_matched: 0 }],
      ['#save', 'Missing', { matched: 1, visible: 1, text_matched: 0 }],
    ] as const) {
      const result = await send('wait_for_element', { page: read.outputs!.page, selector, ...(text ? { text } : {}), timeout_ms: 50 },
        ['page', 'url', 'title', 'found', 'waited_ms', 'match_counts']);
      expect(result).toMatchObject({ status: 'ok', outputs: { found: false, match_counts: expected } });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_EMAIL');
    }
  });

  it('ordinary: a delayed region is tested and read in the same injection, with protected fields excluded', async () => {
    const { fixture, inspect, send } = await open('ordinary');
    await fixture.page.evaluate(() => {
      document.body.innerHTML = '<section id="result" hidden><h1>.name Grandfathered</h1><input type="password" value="SECRET_PASSWORD"></section>';
    });
    const read = await inspect({});
    const afterReadText = 'Changed after capture';
    await fixture.armWaitCapture('#result', afterReadText);
    // Allow real Chrome to schedule the injections. Exact deadline behavior is
    // covered by the controlled-clock cases in browser-handoff-read.test.ts.
    const out = await send('wait_for_element', { page: read.outputs!.page, selector: '#result', timeout_ms: 10_000,
      capture_read: { expected_url: `${base}/page`, max_chars: 4_000, max_value_chars: 200 } },
    ['page', 'url', 'title', 'found', 'waited_ms', 'html', 'truncated', 'loading', 'selector_matches', 'selected_index']);
    expect(out, JSON.stringify(out.error)).toMatchObject({ status: 'ok', outputs: { page: read.outputs!.page,
      url: `${base}/page`, found: true, html: expect.stringContaining('.name Grandfathered'), truncated: false } });
    expect(JSON.stringify(out.outputs)).not.toContain('SECRET_PASSWORD');
    expect(out.outputs!.html).toContain('type="password"');
    expect(out.outputs!.html).not.toContain('Inspect fixture');
    expect(out.outputs!.html).not.toContain(afterReadText);
    expect(await fixture.page.locator('#result').textContent()).toContain(afterReadText);
    expect(await fixture.waitCaptureProbe()).toEqual({ hidden_reads: 1, captures: 1 });
  });

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

  // 120 s, as each test that opens a background tab: the fixture gives the tab 30 s to load and
  // names a load that runs past that, which the default 30 s test limit would cut off first.
  it('ordinary: closes a tab by its handle, which then lists no more', async () => {
    const { send, fixture } = await open('ordinary', '/menu');
    await fixture.openBackground(`${base}/keys`);
    await fixture.discovered(`${base}/keys`);
    const listed = await send('list_tabs', {});
    const keys = (listed.outputs!.tabs as Array<{ page: string; url: string }>).find((tab) => tab.url === `${base}/keys`)!;
    expect(await send('close_tab', { page: keys.page }, [...BRIDGE_CLOSE_OUTPUT_KEYS])).toMatchObject({ status: 'ok', outputs: { closed: true } });
    const after = await send('list_tabs', {});
    expect((after.outputs!.tabs as Array<{ url: string }>).map((tab) => tab.url)).not.toContain(`${base}/keys`);
  }, 120_000);

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

  it('ordinary: Space on a link scrolls its panel and Enter follows it', async () => {
    const { inspect, send, fixture } = await open('ordinary', '/keys');
    await fixture.page.evaluate(() => {
      document.body.innerHTML = `<main>
        <div id="panel" style="height:160px;overflow:auto">
          <a id="terms" href="/second">Terminology</a><div style="height:700px">Terms</div>
        </div>
        <div style="height:900px">Other content</div>
      </main>`;
    });
    const read = await inspect({});
    const page = String(read.outputs!.page);
    const ref = refFor(htmlOf(read), 'terms')!;
    const panelTop = () => fixture.page.locator('#panel').evaluate(panel => panel.scrollTop);
    expect(await send('press', { page, ref, key: 'Space' })).toMatchObject({ status: 'ok' });
    expect(await panelTop()).toBeGreaterThan(0);
    expect(await fixture.page.evaluate(() => ({ focus: document.activeElement?.id, top: scrollY }))).toEqual({ focus: 'terms', top: 0 });
    expect(await send('press', { page, ref, key: 'Shift+Space' })).toMatchObject({ status: 'ok' });
    expect(await panelTop()).toBe(0);
    await fixture.page.locator('#terms').evaluate(link => link.addEventListener('keydown', event => event.preventDefault(), { once: true }));
    await send('press', { page, ref, key: 'Space' });
    expect(await panelTop()).toBe(0);
    expect(await send('press', { page, ref, key: 'Enter' })).toMatchObject({ status: 'ok' });
    await fixture.page.waitForURL(/\/second$/);
  }, 120_000);

  it('ordinary: Home and End move or extend native text selection with the saved anchor', async () => {
    const { inspect, send, fixture } = await open('ordinary', '/keys');
    await fixture.page.evaluate(() => {
      document.body.innerHTML = '<input id="handoff" value="Check the existing route.">'
        + '<textarea id="wrapped-note" style="width:12ch">First line wraps.\nSecond line.</textarea>';
    });
    const read = await inspect({});
    const page = String(read.outputs!.page);
    const html = htmlOf(read);
    const place = (id: string, start: number, end = start, direction: 'none' | 'backward' = 'none') =>
      fixture.page.locator('#' + id).evaluate((field: HTMLInputElement | HTMLTextAreaElement, position) => {
        field.focus();
        field.setSelectionRange(position.start, position.end, position.direction);
      }, { start, end, direction });
    const selection = (id: string) => fixture.page.locator('#' + id).evaluate((field: HTMLInputElement | HTMLTextAreaElement) => ({
      start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection, value: field.value,
    }));
    for (const [id, key, start, end, direction] of [
      ['handoff', 'Shift+End', 5, 5, 'none'], ['handoff', 'Shift+Home', 5, 10, 'backward'],
      ['handoff', 'Home', 5, 10, 'backward'], ['handoff', 'End', 5, 5, 'none'],
      ['wrapped-note', 'Shift+End', 3, 3, 'none'],
    ] as const) {
      await place(id, start, end, direction);
      await fixture.page.keyboard.press(key);
      const native = await selection(id);
      await place(id, start, end, direction);
      expect(await send('press', { page, ref: refFor(html, id)!, key })).toMatchObject({ status: 'ok' });
      expect(await selection(id)).toEqual(native);
    }
    await place('handoff', 5);
    await fixture.page.locator('#handoff').evaluate(field =>
      field.addEventListener('keydown', event => event.preventDefault(), { once: true }));
    const before = await selection('handoff');
    expect(await send('press', { page, ref: refFor(html, 'handoff')!, key: 'Shift+End' })).toMatchObject({ status: 'ok' });
    expect(await selection('handoff')).toEqual(before);
  }, 120_000);

  it('ordinary: Tab and Shift+Tab respect positive tab order and preserve ties', async () => {
    const { inspect, send, fixture } = await open('ordinary', '/keys');
    await fixture.page.evaluate(() => {
      document.body.innerHTML = `<main>
        <input id="default-a">
        <input id="third" tabindex="3">
        <input id="start" tabindex="1">
        <input id="disabled" tabindex="2" disabled>
        <input id="tie-a" tabindex="2">
        <input id="negative" tabindex="-1">
        <input id="tie-b" tabindex="2">
        <input id="default-b" tabindex="0">
      </main>`;
    });
    const read = await inspect({});
    const page = String(read.outputs!.page);
    const html = htmlOf(read);
    for (const [from, key, to] of [
      ['start', 'Tab', 'tie-a'], ['tie-a', 'Tab', 'tie-b'], ['tie-b', 'Shift+Tab', 'tie-a'],
      ['tie-b', 'Tab', 'third'], ['third', 'Tab', 'default-a'], ['default-a', 'Tab', 'default-b'],
    ]) {
      expect(await send('press', { page, ref: refFor(html, from!)!, key })).toMatchObject({ status: 'ok', outputs: { pressed: key } });
      expect(await fixture.page.evaluate(() => document.activeElement?.id)).toBe(to);
    }
  }, 120_000);

  it('ordinary: Tab uses the checked radio in each form or tree and preserves the choice', async () => {
    const { inspect, send, fixture } = await open('ordinary', '/keys');
    await fixture.page.evaluate(() => {
      document.body.innerHTML = `<input id="before">
        <form><input id="walkup" type="radio" name="intake" checked>
          <input id="scheduled" type="radio" name="intake"><input id="vehicle"></form>
        <form><input id="archive-first" type="radio" name="intake">
          <input id="archive-checked" type="radio" name="intake" checked></form>
        <input id="outside-checked" type="radio" name="intake" checked>
        <input id="outside-other" type="radio" name="intake"><div id="component"></div><input id="after">`;
      const shadow = document.querySelector('#component')!.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<input id="closed-choice" type="radio" name="intake" checked disabled>
        <input id="inner-first" type="radio" name="intake"><input id="inner-other" type="radio" name="intake">`;
    });
    const read = await inspect({});
    const page = String(read.outputs!.page);
    const html = htmlOf(read);
    const focused = () => fixture.page.evaluate(() => {
      const node = document.activeElement;
      return node?.shadowRoot?.activeElement?.id ?? node?.id;
    });
    for (const [from, key, to] of [
      ['before', 'Tab', 'walkup'], ['walkup', 'Tab', 'vehicle'], ['vehicle', 'Shift+Tab', 'walkup'],
      ['scheduled', 'Shift+Tab', 'walkup'], ['vehicle', 'Tab', 'archive-checked'],
      ['archive-checked', 'Tab', 'outside-checked'], ['outside-checked', 'Tab', 'inner-first'],
      ['inner-first', 'Tab', 'after'],
    ] as const) {
      await fixture.page.locator('#' + from).focus();
      await fixture.page.keyboard.press(key);
      expect(await focused()).toBe(to);
      await fixture.page.locator('#' + from).focus();
      expect(await send('press', { page, ref: refFor(html, from)!, key })).toMatchObject({ status: 'ok' });
      expect(await focused()).toBe(to);
    }
    const checked = await fixture.page.locator('input:checked').evaluateAll(inputs => inputs.map(input => input.id));
    expect(checked.sort()).toEqual(['archive-checked', 'closed-choice', 'outside-checked', 'walkup']);
  }, 120_000);

  it('ordinary: Tab follows native focus across closed shadow roots, slots, and delegated focus', async () => {
    const { inspect, send, fixture } = await open('ordinary', '/keys');
    await fixture.page.evaluate(() => {
      document.body.innerHTML = `<button id="outside">Background</button><dialog>
        <input id="start"><div id="component" style="display:contents">
          <button id="assigned" slot="extra" tabindex="1">Assigned</button><button id="unused">Unassigned</button>
        </div><input id="finish"></dialog>`;
      const root = document.querySelector('#component')!.attachShadow({ mode: 'closed' });
      root.innerHTML = `<div inert><button>Inactive</button></div><input id="first-shadow">
        <slot name="extra"><button>Replaced fallback</button></slot><div id="delegates" tabindex="0"></div>
        <slot name="vacant"><button id="fallback">Fallback</button></slot>`;
      const delegated = root.querySelector('#delegates')!.attachShadow({ mode: 'open', delegatesFocus: true });
      delegated.innerHTML = '<input id="delegated-input">';
      for (const scope of [document, root, delegated]) {
        for (const control of scope.querySelectorAll('button, input')) {
          control.addEventListener('focus', () => { document.body.dataset.focusedControl = control.id; });
        }
      }
      root.querySelector('#first-shadow')!.addEventListener('keydown', event => {
        if (document.body.hasAttribute('data-cancel-tab')) event.preventDefault();
      });
      document.querySelector('dialog')!.showModal();
      document.querySelector<HTMLInputElement>('#start')!.focus();
    });
    const path = [
      ['start', 'Tab', 'first-shadow'], ['first-shadow', 'Tab', 'assigned'], ['assigned', 'Tab', 'delegated-input'],
      ['delegated-input', 'Tab', 'fallback'], ['fallback', 'Tab', 'finish'], ['finish', 'Shift+Tab', 'fallback'],
      ['fallback', 'Shift+Tab', 'delegated-input'], ['delegated-input', 'Shift+Tab', 'assigned'],
      ['assigned', 'Shift+Tab', 'first-shadow'], ['first-shadow', 'Shift+Tab', 'start'],
    ] as const;
    const focused = () => fixture.page.evaluate(() => document.body.dataset.focusedControl);
    for (const [, key, to] of path) {
      await fixture.page.keyboard.press(key);
      expect(await focused()).toBe(to);
    }
    const read = await inspect({});
    const page = String(read.outputs!.page);
    const html = htmlOf(read);
    for (const [from, key, to] of path) {
      expect(await send('press', { page, ref: refFor(html, from)!, key })).toMatchObject({ status: 'ok' });
      expect(await focused()).toBe(to);
    }
    await fixture.page.evaluate(() => document.body.setAttribute('data-cancel-tab', ''));
    expect(await send('press', { page, ref: refFor(html, 'first-shadow')!, key: 'Tab' })).toMatchObject({ status: 'ok' });
    expect(await focused()).toBe('first-shadow');
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

  it.each([false, true])('ordinary: clicks an exposed point and rechecks it after hover (%s)', async coverOnHover => {
    const { inspect, send, fixture } = await open('ordinary', '/page');
    await fixture.page.evaluate(coverOnHover => {
      document.body.innerHTML = `<main>
        <div style="position:relative;width:280px">
          <button id="save-draft" type="button" style="width:100%;height:48px">Save draft</button>
          <span id="badge" style="position:absolute;inset:10px 100px;background:white">Ready</span>
        </div>
        <output id="clicked"></output>
      </main>`;
      const target = document.querySelector<HTMLButtonElement>('#save-draft')!;
      const badge = document.querySelector<HTMLElement>('#badge')!;
      const receipt = document.querySelector('#clicked')!;
      target.addEventListener('click', event => {
        receipt.append(document.elementFromPoint(event.clientX, event.clientY)?.id ?? 'outside');
      });
      badge.addEventListener('click', () => receipt.append('badge'));
      if (coverOnHover) target.addEventListener('pointermove', () => { badge.style.inset = '0'; }, { once: true });
    }, coverOnHover);
    const read = await inspect({});
    const actual = await send('click', { page: read.outputs!.page, ref: refFor(htmlOf(read), 'save-draft')! });
    expect(actual).toMatchObject(coverOnHover ? { status: 'error', error: { code: 'delivery_uncertain' } }
      : { status: 'ok', outputs: { clicked: true } });
    expect(await fixture.page.locator('#clicked').textContent()).toBe(coverOnHover ? '' : 'save-draft');
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

  // 2026-11-21 (D-402, task P) — a step named by the card it sits in (`within_card`, `card_rows`): the nearest element
  // of the card's kind above it, checked at the step as a row is.
  it('ordinary: a click and typing named by the card they sit in act while it shows their texts, and refuse once it does not', async () => {
    const { inspect, send, clicks, fixture } = await open('ordinary', '/cards');
    const read = await inspect({});
    const page = read.outputs!.page;
    const html = htmlOf(read);
    const card = 'div[data-testid="note-card"]';
    const [edit, quantity] = [refFor(html, 'edit-a')!, refFor(html, 'qty-a')!];
    expect(await send('click', { page, ref: edit, within: ['Bench stock review'], within_card: card }))
      .toMatchObject({ status: 'ok', outputs: { clicked: true } });
    expect(await send('fill', { page, ref: quantity, value: '2', within: ['Bench stock review'], within_card: card }))
      .toMatchObject({ status: 'ok', outputs: { filled: true } });
    // The card shows another note now: neither acts.
    await fixture.page.evaluate(() => { document.getElementById('title-a')!.textContent = 'Weekly plan'; });
    expect(await send('click', { page, ref: edit, within: ['Bench stock review'], within_card: card })).toMatchObject({ status: 'error',
      error: { message: 'the card it sits in no longer shows “Bench stock review”, so nothing was clicked' } });
    expect(await send('fill', { page, ref: quantity, value: '3', within: ['Bench stock review'], within_card: card })).toMatchObject({ status: 'error',
      error: { message: 'the card it sits in no longer shows “Bench stock review”, so nothing was typed' } });
    // By no card, a row: none holds it, so it is refused as before.
    expect(await send('click', { page, ref: edit, within: ['Weekly plan'] })).toMatchObject({ status: 'error',
      error: { message: 'the row it sits in no longer shows “Weekly plan”, so nothing was clicked' } });
    expect(await clicks()).toEqual(['edit-a']);
    expect(await fixture.page.evaluate(() => (document.getElementById('qty-a') as HTMLInputElement).value)).toBe('2');
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
    const document = await fixture.discovered(`${other}/page`);
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

  it('ordinary: shortcut-only tooltip changes keep the same inspected control', async () => {
    for (const [before, after] of [['Search Wikipedia [f]', 'Search Wikipedia [ctrl-option-f]'],
      ['Search Wikipedia [ctrl-option-f]', 'Search Wikipedia [f]'], ['Search Wikipedia', 'Search Wikipedia [Alt+Shift+F]']]) {
      const { fixture, inspect, send } = await open('ordinary', '/tooltips');
      await fixture.page.locator('#q').evaluate((element, title) => element.setAttribute('title', title), before!);
      const read = await inspect({});
      const ref = refFor(htmlOf(read), 'q')!;
      await fixture.page.locator('#q').evaluate((element, title) => element.setAttribute('title', title), after!);
      expect(await send('fill', { page: read.outputs!.page, ref, value: 'Ada' })).toMatchObject({ status: 'ok' });
      expect(await fixture.page.inputValue('#q')).toBe('Ada');
      // The read keeps the literal tooltip; only the private identity comparison normalizes it.
      expect(htmlOf(await inspect({}))).toContain(`title="${after}"`);
    }
  }, 60_000);

  it('ordinary: shortcut-only tooltip changes rebind a rebuilt control, while two matches remain ambiguous', async () => {
    for (const twins of [false, true]) {
      const { fixture, inspect, send } = await open('ordinary', '/tooltips');
      const read = await inspect({});
      const ref = refFor(htmlOf(read), 'q')!;
      await fixture.page.evaluate(twins => {
        const old = document.querySelector('#search')!;
        const next = old.cloneNode(true) as HTMLFormElement;
        next.querySelector('input')!.title = 'Search Wikipedia [ctrl-option-f]';
        if (twins) next.append(next.querySelector('input')!.cloneNode(true));
        old.replaceWith(next);
      }, twins);
      const result = await send('fill', { page: read.outputs!.page, ref, value: 'Ada' });
      if (twins) {
        expect(result).toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
        expect(await fixture.page.locator('#q').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value))).toEqual(['', '']);
      } else {
        expect(result).toMatchObject({ status: 'ok' });
        expect(await fixture.page.inputValue('#q')).toBe('Ada');
      }
    }
  }, 60_000);

  it.each(['semantic title', 'no accesskey', 'changed accesskey', 'wrong hint key', 'unknown modifier',
    'changed label', 'changed form', 'changed row', 'changed destination'])(
    'ordinary: shortcut hints do not hide %s', async change => {
      const { fixture, inspect, send, clicks } = await open('ordinary', '/tooltips');
      if (change === 'no accesskey') await fixture.page.locator('#q').evaluate(element => element.removeAttribute('accesskey'));
      const read = await inspect({});
      const link = change === 'changed row' || change === 'changed destination';
      const ref = refFor(htmlOf(read), link ? 'view' : 'q')!;
      await fixture.page.evaluate(change => {
        const input = document.querySelector<HTMLInputElement>('#q')!;
        input.title = 'Search Wikipedia [ctrl-option-f]';
        if (change === 'semantic title') input.title = 'Search private records [ctrl-option-f]';
        if (change === 'changed accesskey') { input.accessKey = 'g'; input.title = 'Search Wikipedia [ctrl-option-g]'; }
        if (change === 'wrong hint key') input.title = 'Search Wikipedia [ctrl-option-g]';
        if (change === 'unknown modifier') input.title = 'Search Wikipedia [help-f]';
        if (change === 'changed label') input.setAttribute('aria-label', 'Search private records');
        if (change === 'changed form') document.querySelector('form')!.setAttribute('action', '/elsewhere');
        if (change === 'changed row' || change === 'changed destination') {
          document.querySelector('#view')!.setAttribute('title', 'View [ctrl-option-g]');
          if (change === 'changed row') document.querySelector('#owner')!.textContent = 'Bob';
          else document.querySelector('#view')!.setAttribute('href', '/elsewhere');
        }
      }, change);
      expect(await send(link ? 'click' : 'fill', { page: read.outputs!.page, ref, ...(link ? {} : { value: 'Ada' }) }))
        .toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
      expect(await fixture.page.inputValue('#q')).toBe('');
      expect(await clicks()).toEqual([]);
    }, 60_000,
  );

  it('ordinary: a changed access key before rebuilding cannot overwrite the inspected identity', async () => {
    const { fixture, inspect, send } = await open('ordinary', '/tooltips');
    const read = await inspect({});
    const ref = refFor(htmlOf(read), 'q')!;
    await fixture.page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#q')!;
      input.accessKey = 'g';
      input.title = 'Search Wikipedia [ctrl-option-g]';
      const form = document.querySelector('form')!;
      form.replaceWith(form.cloneNode(true));
    });
    expect(await send('fill', { page: read.outputs!.page, ref, value: 'Ada' }))
      .toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
    expect(await fixture.page.inputValue('#q')).toBe('');
  }, 60_000);

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
    // D-402 slice G — what a protected field takes is answered only when the describe asks for it: a
    // server that does not would refuse the answer's keys.
    const password = await send('describe', { page, ref: 'e8' });
    expect(password).toMatchObject({ status: 'ok', outputs: { role: 'password field', protected: true } });
    expect(password.outputs).not.toHaveProperty('protected_kind');
    expect(await send('describe', { page, selector: '#card' })).toMatchObject({ outputs: { protected: true } });
    const kinds = [...BRIDGE_DESCRIBE_OUTPUT_KEYS, 'protected_kind'];
    expect((await send('describe', { page, ref: 'e8' }, kinds)).outputs).toMatchObject({ protected: true, protected_kind: 'password' });
    expect((await send('describe', { page, selector: '#card' }, kinds)).outputs).toMatchObject({ protected: true, protected_kind: 'card' });
    expect((await send('describe', { page, ref: 'e5' }, kinds)).outputs).not.toHaveProperty('protected_kind');
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
    const document = await fixture.discovered(`${other}/page`);
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
  it('ordinary: lists a committed document while a subresource keeps it loading', async () => {
    const { send, fixture } = await open('ordinary');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await fixture.page.route('**/held-image', async route => {
      await held;
      await route.fulfill({ status: 204 });
    });
    await fixture.page.route('**/loading-page', route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><title>Loading metadata</title><body><h1>Ready text</h1><img src="/held-image"></body>' }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await fixture.page.goto(`${base}/loading-page`, { waitUntil: 'domcontentloaded' });
      expect(await fixture.page.evaluate(() => document.readyState)).not.toBe('complete');
      await fixture.discovered(`${base}/loading-page`);
      const result = await Promise.race([send('list_tabs', {}), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Tab listing waited for the held page load')), 3_000);
      })]);
      expect(result).toMatchObject({ status: 'ok', outputs: { tabs: [
        { url: `${base}/loading-page`, title: 'Loading metadata', page: expect.stringMatching(/^\d+:.+$/), loading: true },
      ] } });
      expect(await fixture.page.evaluate(() => document.readyState)).not.toBe('complete');
    } finally {
      clearTimeout(timer); release();
      await fixture.page.unrouteAll({ behavior: 'wait' });
    }
  }, 60_000);

  const listed = async (send: Awaited<ReturnType<typeof open>>['send']) => {
    const result = await send('list_tabs', {});
    expect(result, JSON.stringify(result.error)).toMatchObject({ status: 'ok', outputs: { truncated: false } });
    return result.outputs!.tabs as Listed[];
  };

  it('ordinary: the open tabs on the site are listed with their pages, never the owner client or another site', async () => {
    const { send, fixture } = await open('ordinary');
    for (const url of [`${base}/big`, `${base}/owner`, `${other}/page`]) await (await fixture.browser.newPage()).goto(url);
    // The pages it could list are ones the Bridge has found (the owner's client is never in its inventory).
    await fixture.discovered(`${base}/big`);
    await fixture.discovered(`${other}/page`);
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

  // 2026-11-22 — cnn.com's "Legal Terms and Privacy": a dialog the page marks aria-hidden while a person
  // sees it on top of the page. Read as any dialog, it can be answered; before, the read showed the page as
  // if it were not there, and every click on the page was refused with nothing to answer it by.
  it('ordinary: a dialog the page marks hidden is read while it is on top, and can be answered', async () => {
    const { inspect, send, clicks } = await open('ordinary', '/hidden-dialog');
    const read = await inspect({});
    const page = String(read.outputs!.page);
    const html = htmlOf(read);
    expect(html).toMatch(/<div id="terms" role="dialog"[^>]* aria-modal="true"/);
    expect(html).toContain('Legal Terms and Privacy');
    expect(html).toContain('Morning news');
    // What is marked hidden inside the dialog, and what is around it, stays out.
    expect(html).not.toContain('Decorative mark');
    expect(html).not.toContain('Hidden sibling text');
    expect(html).not.toContain('Hidden wrapper words');
    expect(outlinePage(html, { url: `${base}/hidden-dialog` }).shown[0])
      .toMatch(/^\(A dialog is open at line \d+: “Legal Terms and Privacy”\. Answer it or close it first/);
    const agree = refFor(html, 'agree');
    const story = refFor(html, 'story')!;
    expect(agree).toBeDefined();
    // A wait sees what the read sees, and leaves out what it leaves out.
    const waited = (selector: string) => send('wait_for_element', { page, selector, timeout_ms: 50 },
      ['page', 'url', 'title', 'found', 'waited_ms', 'match_counts']);
    expect(await waited('#agree')).toMatchObject({ status: 'ok',
      outputs: { found: true, match_counts: { matched: 1, visible: 1, text_matched: 1 } } });
    expect(await waited('#shell > p')).toMatchObject({ status: 'ok',
      outputs: { found: false, match_counts: { matched: 1, visible: 0, text_matched: 0 } } });
    // The page behind it still cannot be clicked …
    expect(await send('click', { page, ref: story })).toMatchObject({ status: 'error', error: { code: 'value_not_applied',
      obstruction: { reason: 'target_occluded', executed: false } } });
    // … until it is answered.
    expect(await send('click', { page, ref: agree! })).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    const after = htmlOf(await inspect({ page }));
    expect(after).not.toContain('Legal Terms and Privacy');
    expect(outlinePage(after, { url: `${base}/hidden-dialog` }).shown[0]).not.toMatch(/^\(A dialog is open/);
    expect(await send('click', { page, ref: story })).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    expect(await clicks()).toEqual(['agree', 'story']);
  }, 90_000);

  it('ordinary: only what is on top is read: not a hidden dialog something covers, and a hidden page reads as its cover', async () => {
    const behind = htmlOf(await (await open('ordinary', '/hidden-behind')).inspect({}));
    expect(behind).toContain('Cover text');
    expect(behind).not.toContain('Old notice');
    expect(refFor(behind, 'dismiss')).toBeUndefined();
    // Google's vignette ad marks the page's body hidden under an overlay that is no dialog: since 2026-11-22 the
    // overlay is read as what covers the page (`data-recued-cover`), and the page behind it is not.
    const hiddenPage = htmlOf(await (await open('ordinary', '/hidden-page')).inspect({}));
    expect(hiddenPage).toMatch(/<ins data-recued-cover>/);
    expect(hiddenPage).toMatch(/Advertisement[\s\S]*Close ad/);
    expect(hiddenPage).not.toContain('Article text');
    // A modal dialog the page does not hide is read, and the page it marks hidden behind it is not.
    const background = htmlOf(await (await open('ordinary', '/background-hidden')).inspect({}));
    expect(background).toContain('Join us');
    expect(refFor(background, 'close')).toBeDefined();
    expect(background).not.toMatch(/>App<|Behind/);
    // In a closed web component, as on the page itself.
    const component = htmlOf(await (await open('ordinary', '/hidden-in-component')).inspect({}));
    expect(component).toContain('We use cookies');
    expect(refFor(component, 'accept')).toBeDefined();
    expect(outlinePage(component, { url: `${base}/hidden-in-component` }).shown[0])
      .toMatch(/^\(A dialog is open at line \d+: “Cookies”/);
  }, 120_000);

  // 2026-11-22 (the owner: "build the 'show the blocker' version") — what covers a page that marks itself hidden is
  // read as covering it, with its countdown, until its Close button shows and can be pressed.
  it('ordinary: what covers a page that marks itself hidden is read, its countdown, then its Close button', async () => {
    const { inspect, send, clicks } = await open('ordinary', '/countdown-cover');
    const read = await inspect({});
    const page = String(read.outputs!.page);
    const first = htmlOf(read);
    expect(first).toMatch(/<div id="cover" data-recued-cover>/);
    expect(first).toContain('You can close this ad in 2 seconds.');
    expect(first).not.toContain('Recipe text');
    expect(refFor(first, 'close')).toBeUndefined();
    expect(outlinePage(first, { url: `${base}/countdown-cover` }).shown[0])
      .toBe(`(Something covers this page at line 2: “Advertisement”. ${PAGE_COVER_NOTE_TAIL})`);
    // A wait sees what the read sees: its Close button, once the countdown ends.
    expect(await send('wait_for_element', { page, selector: '#close', timeout_ms: 5_000 },
      ['page', 'url', 'title', 'found', 'waited_ms', 'match_counts'])).toMatchObject({ status: 'ok', outputs: { found: true } });
    const later = htmlOf(await inspect({ page }));
    expect(later).toContain('You can close this ad now.');
    const close = refFor(later, 'close');
    expect(close).toBeDefined();
    expect(await send('click', { page, ref: close! })).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    const after = htmlOf(await inspect({ page }));
    expect(after).toContain('Recipe text');
    expect(after).not.toContain('data-recued-cover');
    expect(await send('click', { page, ref: refFor(after, 'next')! })).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    expect(await clicks()).toEqual(['close', 'next']);
  }, 90_000);

  it('ordinary: a hidden panel away from the centre is not read, nor a page a small modal hides behind it', async () => {
    const corner = htmlOf(await (await open('ordinary', '/hidden-corner')).inspect({}));
    expect(corner).toContain('Front text');
    expect(corner).not.toMatch(/Corner panel|data-recued-cover/);
    const aside = htmlOf(await (await open('ordinary', '/modal-aside')).inspect({}));
    expect(aside).toContain('Small notice');
    expect(aside).not.toMatch(/App behind|data-recued-cover/);
  }, 90_000);
});

