/** D-335 slice H — a screenshot in real Chrome.
 *
 *  Chrome captures a tab only for an extension holding `<all_urls>` or
 *  `activeTab`. The owner's ruling (2026-11-01) amends invariant I-9 (D-148
 *  § A.3.4): `<all_urls>` is an optional grant the owner turns on with "Allow
 *  screenshots" in the side panel. So:
 *   - with `<all_urls>`, a tab behind the owner's is brought forward, pictured,
 *     cut to the element, and the owner's tab is put back in front;
 *   - with only the every-site pattern that "Allow every site" grants, the
 *     Bridge refuses before any tab moves, naming the switch.
 *  The shipped Bridge's executor and capture run in Chrome
 *  (`d-261-browser-fixture.ts`); only the extension's manifest is the test's. */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BRIDGE_INSPECT_OUTPUT_KEYS,
  BRIDGE_SCREENSHOT_MAX_EDGE,
  BRIDGE_SCREENSHOT_OUTPUT_KEYS,
  BRIDGE_SCROLL_OUTPUT_KEYS,
  BRIDGE_TABS_OUTPUT_KEYS,
  type BridgeAction,
  type BridgeCommand,
  type BridgeIngredientRef,
} from '@recued/contracts';
import { createReviewedBrowserFixture } from './d-261-browser-fixture.js';

const OWNER = '<!doctype html><html><head><title>Owner</title></head><body><p>The owner\'s own work</p></body></html>';
/** Two boxes of known colours, one far below the fold. */
const PICTURE = `<!doctype html><html><head><title>Picture</title></head><body style="margin:0;background:#ffffff">
<div id="box" style="position:absolute;left:40px;top:60px;width:200px;height:100px;background:rgb(0,0,255)"></div>
<div id="far" style="position:absolute;left:40px;top:3000px;width:120px;height:120px;background:rgb(255,0,0)"></div>
</body></html>`;

/** D-335 slice R — a frame from this site 10px inside its border, holding a green button and one
 *  wider than the frame; a frame from the other site; and a closed web component's magenta button. */
const FRAMED = (other: string) => `<!doctype html><html><head><title>Framed</title></head><body style="margin:0;background:#ffffff">
<iframe title="Same" src="/inner" style="position:absolute;left:300px;top:200px;width:300px;height:200px;border:10px solid #ffffff"></iframe>
<iframe title="Away" src="${other}/inner" style="position:absolute;left:300px;top:450px;width:300px;height:200px;border:0"></iframe>
<shaded-box style="position:absolute;left:40px;top:60px;display:block"></shaded-box>
<script>
customElements.define('shaded-box', class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'closed' }).innerHTML
      = '<button style="display:block;width:160px;height:80px;border:0;background:rgb(255,0,255)">Shaded</button>';
  }
});
</script>
</body></html>`;
const INNER = `<!doctype html><html><head><title>Inner</title></head><body style="margin:0;background:#ffffff;width:600px">
<button style="position:absolute;left:30px;top:20px;width:200px;height:100px;border:0;background:rgb(0,160,0)">Inner</button>
<button style="position:absolute;left:30px;top:140px;width:400px;height:50px;border:0;background:rgb(0,0,255)">Wide</button>
</body></html>`;

/** D-335 slice S — bands of eight colours a picture's centre tells apart (each channel high or low),
 *  and pages made of them: the page itself scrolling, a panel scrolling in a page that does not,
 *  and two elements, one scrolling its content and one taller than the window. */
const BANDS = ['rgb(255,0,0)', 'rgb(0,255,0)', 'rgb(0,0,255)', 'rgb(255,255,0)', 'rgb(255,0,255)', 'rgb(0,255,255)',
  'rgb(0,0,0)', 'rgb(255,255,255)'];
const bands = (height: number) => BANDS.map(colour => `<div style="height:${height}px;background:${colour}"></div>`).join('');
const TALL = `<!doctype html><html><head><title>Tall</title></head><body style="margin:0">${bands(600)}</body></html>`;
const PANEL = `<!doctype html><html><head><title>Panel</title></head><body style="margin:0;height:100vh;overflow:hidden">
<div id="list" style="position:absolute;inset:0;overflow-y:auto">${bands(600)}</div></body></html>`;
const BOXES = `<!doctype html><html><head><title>Boxes</title></head><body style="margin:0">
<div id="log" style="width:400px;height:300px;overflow-y:auto">${bands(200)}</div>
<div style="height:200px"></div>
<div id="article" style="width:600px">${bands(500).split('</div>').slice(0, 6).join('</div>')}</div></div>
<div style="height:400px"></div></body></html>`;

/** D-335 slice U — a feed that loads twenty more items each time it is scrolled to its end, up to sixty. */
const FEED_MORE = `<!doctype html><html><head><title>Feed</title></head><body style="margin:0"><div id="items">${
  Array.from({ length: 20 }, (_, i) => `<div style="height:100px">Item ${String(i + 1)}</div>`).join('')}</div>
<script>
let count = 20;
addEventListener('scroll', () => {
  if (innerHeight + scrollY < document.documentElement.scrollHeight - 50 || count >= 60) return;
  const from = count;
  count += 20;
  setTimeout(() => {
    for (let n = from + 1; n <= from + 20; n += 1) {
      const item = document.createElement('div');
      item.style.height = '100px';
      item.textContent = 'Item ' + n;
      document.getElementById('items').append(item);
    }
  }, 200);
});
</script></body></html>`;

type Fixture = Awaited<ReturnType<typeof createReviewedBrowserFixture>>;

let server: Server | undefined;
let elsewhere: Server | undefined;
let base = '';
let other = '';
let allUrls: Fixture | undefined;
let everySite: Fixture | undefined;

beforeAll(async () => {
  const listen = async (created: Server) => {
    await new Promise<void>(resolve => created.listen(0, '127.0.0.1', resolve));
    const address = created.address();
    if (!address || typeof address === 'string') throw new Error('no page server port');
    return `http://127.0.0.1:${address.port}`;
  };
  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const pages: Record<string, string> = { '/picture': PICTURE, '/framed': FRAMED(other), '/inner': INNER, '/tall': TALL,
      '/panel': PANEL, '/boxes': BOXES, '/feed-more': FEED_MORE };
    response.end(pages[path] ?? OWNER);
  });
  base = await listen(server);
  // Another origin on the same host, for a frame from another site.
  elsewhere = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(INNER);
  });
  other = await listen(elsewhere);
  // ⚠ 240s each: the fixture bounds Chrome's MV3 worker start at 180s with a
  // named error, which an outer bound below it would hide.
  allUrls = await createReviewedBrowserFixture(`${base}/owner`, { hostPermissions: ['<all_urls>'] });
  everySite = await createReviewedBrowserFixture(`${base}/owner`, { hostPermissions: ['*://*/*'] });
}, 480_000);

afterAll(async () => {
  await allUrls?.close();
  await everySite?.close();
  for (const created of [server, elsewhere]) {
    await new Promise(resolve => (created ? created.close(resolve) : resolve(undefined)));
  }
}, 120_000);

/** The owner's tab in front and the picture page behind it, in one window,
 *  granted; and a way to send the Bridge a command there. */
const setUp = async (fixture: Fixture) => {
  const target = `${base}/*`;
  const ingredient: BridgeIngredientRef = { publisher_id: 'recued', slug: 'dom-screenshot', version: '1',
    surface_kind: 'reading', domain_allowlist: [target], domain_allowlist_signature: '' };
  await fixture.reset(`${base}/owner`);
  await fixture.grant(ingredient);
  await fixture.openBackground(`${base}/picture`);
  await fixture.discovered(`${base}/picture`);
  const send = async (action: BridgeAction, args: Record<string, unknown>, expects: readonly string[]) => {
    const command: BridgeCommand = { command_id: randomUUID(), recipe_run_id: 'page-capture', step_id: action, ingredient,
      // Full-suite scheduling can delay Chrome's first real capture. This fixture checks pixels,
      // permissions and restoration; retain a bounded command without making 30 s a latency gate.
      action, target_domain_pattern: target, args, expects_output_keys: [...expects],
      timeout_ms: action === 'screenshot_page' ? 60_000 : 30_000,
      idempotency_key: randomUUID() };
    return (await fixture.ordinaryCommand(command)).result;
  };
  const listed = await send('list_tabs', {}, BRIDGE_TABS_OUTPUT_KEYS);
  const page = (listed.outputs?.tabs as Array<{ page: string; url: string }>).find(tab => tab.url === `${base}/picture`)!.page;
  const front = async () => (await fixture.tabs()).filter(tab => tab.active).map(tab => tab.url);
  const shoot = (args: Record<string, unknown>) => send('screenshot_page', { page, ...args }, BRIDGE_SCREENSHOT_OUTPUT_KEYS);
  return { page, front, shoot };
};

/** The colour at a JPEG's centre, decoded by Chrome. */
const colourAt = (fixture: Fixture, image: string) => fixture.page.evaluate(async src => {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const context = canvas.getContext('2d')!;
  context.drawImage(img, 0, 0);
  return [...context.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data].slice(0, 3);
}, `data:image/jpeg;base64,${image}`);

describe('D-335 slice H — a screenshot, in real Chrome', () => {
  it('with <all_urls>: pictures a tab behind the owner\'s, cut to the element, and puts the owner\'s tab back', async () => {
    const fixture = allUrls!;
    const { page, front, shoot } = await setUp(fixture);
    expect(await front()).toEqual([`${base}/owner`]);

    const box = await shoot({ selector: '#box' });
    expect(box.status, JSON.stringify(box.error)).toBe('ok');
    const outputs = box.outputs as { page: string; url: string; title: string; image: string; mime_type: string;
      width: number; height: number };
    expect(outputs).toMatchObject({ page, url: `${base}/picture`, title: 'Picture', mime_type: 'image/jpeg' });
    // A JPEG, of the element's own shape and colour.
    expect(outputs.image.startsWith('/9j/')).toBe(true);
    expect(outputs.width / outputs.height).toBeCloseTo(2, 1);
    const [r, g, b] = await colourAt(fixture, outputs.image);
    expect([r! < 80, g! < 80, b! > 180]).toEqual([true, true, true]);
    // The owner's tab is back in front.
    expect(await front()).toEqual([`${base}/owner`]);

    // An element below the fold is scrolled into view to be pictured.
    const far = await shoot({ selector: '#far' });
    expect(far.status, JSON.stringify(far.error)).toBe('ok');
    const [r2, g2, b2] = await colourAt(fixture, (far.outputs as { image: string }).image);
    expect([r2! > 180, g2! < 80, b2! < 80]).toEqual([true, true, true]);

    // The visible page: no bigger than a model reads at full detail.
    const whole = await shoot({});
    expect(whole.status, JSON.stringify(whole.error)).toBe('ok');
    const all = whole.outputs as { width: number; height: number };
    expect(Math.max(all.width, all.height)).toBeLessThanOrEqual(BRIDGE_SCREENSHOT_MAX_EDGE);
    expect(all.width).toBeGreaterThan(outputs.width);
    expect(await front()).toEqual([`${base}/owner`]);
  }, 120_000);

  it('with only every site, before "Allow screenshots": refused before any tab moves, naming the switch', async () => {
    const fixture = everySite!;
    const { front, shoot } = await setUp(fixture);
    const before = await fixture.tabs();
    const refused = await shoot({ selector: '#box' });
    expect(refused).toMatchObject({ status: 'error', error: { code: 'capacity_gap_permission_missing',
      message: 'Screenshots are off: turn on “Allow screenshots” in the Browser Bridge\'s side panel in Chrome.' } });
    expect(await fixture.tabs()).toEqual(before);
    expect(await front()).toEqual([`${base}/owner`]);
  }, 120_000);
});

describe('D-335 slice R — a screenshot in a frame and in a web component, in real Chrome', () => {
  it('pictures an element where the page shows it, through a frame from this site and a closed component', async () => {
    const fixture = allUrls!;
    // Every site, as the toolkit's grant is: the frame from the other site is on another origin.
    const ingredient: BridgeIngredientRef = { publisher_id: 'recued', slug: 'dom-screenshot', version: '1',
      surface_kind: 'reading', domain_allowlist: ['*://*/*'], domain_allowlist_signature: '' };
    await fixture.reset(`${base}/owner`);
    await fixture.grant(ingredient);
    await fixture.openBackground(`${base}/framed`);
    await fixture.discovered(`${base}/framed`);
    const send = async (action: BridgeAction, args: Record<string, unknown>, expects: readonly string[]) => (await fixture.ordinaryCommand({
      command_id: randomUUID(), recipe_run_id: 'page-capture', step_id: action, ingredient, action,
      target_domain_pattern: '*://*/*', args, expects_output_keys: [...expects], timeout_ms: 30_000,
      idempotency_key: randomUUID() })).result;
    const listed = await send('list_tabs', {}, BRIDGE_TABS_OUTPUT_KEYS);
    const page = (listed.outputs?.tabs as Array<{ page: string; url: string }>).find(tab => tab.url === `${base}/framed`)!.page;
    const read = await send('inspect', { page }, BRIDGE_INSPECT_OUTPUT_KEYS);
    expect(read.status, JSON.stringify(read.error)).toBe('ok');
    const html = String(read.outputs!.html);
    const refOf = (label: string) => new RegExp(`ref="(e\\d+)"[^>]*>${label}</button>`).exec(html)?.[1];
    const away = /title="Away" page="(\d+:[A-Za-z0-9]+)"/.exec(html)?.[1];
    expect([refOf('Inner'), refOf('Wide'), refOf('Shaded'), away].every(found => found !== undefined), html).toBe(true);
    const front = async () => (await fixture.tabs()).filter(tab => tab.active).map(tab => tab.url);
    const shot = async (args: Record<string, unknown>) => {
      const out = await send('screenshot_page', { page, ...args }, BRIDGE_SCREENSHOT_OUTPUT_KEYS);
      expect(out.status, JSON.stringify(out.error)).toBe('ok');
      const outputs = out.outputs as { image: string; width: number; height: number };
      return { ratio: outputs.width / outputs.height, colour: await colourAt(fixture, outputs.image) };
    };

    // In the frame: offset by where the frame is and its border, so its centre is the button's.
    const inner = await shot({ ref: refOf('Inner') });
    expect(inner.ratio).toBeCloseTo(2, 1);
    expect(inner.colour.map(channel => channel > 120)).toEqual([false, true, false]);
    // Wider than its frame: pictured as far as the frame shows it, 300 of its 400 pixels.
    const wide = await shot({ ref: refOf('Wide') });
    expect(wide.ratio).toBeCloseTo(6, 0);
    expect(wide.colour.map(channel => channel > 120)).toEqual([false, false, true]);
    // In a closed web component.
    const shaded = await shot({ ref: refOf('Shaded') });
    expect(shaded.ratio).toBeCloseTo(2, 1);
    expect(shaded.colour.map(channel => channel > 120)).toEqual([true, false, true]);

    // The frame from the other site is a page of its own, which Chrome cannot picture apart from
    // its tab: refused before any tab moves, naming the page to picture instead.
    const before = await fixture.tabs();
    expect(await send('screenshot_page', { page: away }, BRIDGE_SCREENSHOT_OUTPUT_KEYS)).toMatchObject({ status: 'error',
      error: { code: 'tab_navigation_blocked', message: 'This page is a frame inside another page and cannot be pictured '
        + 'on its own: take the screenshot of the page that shows it, which pictures the frame as shown.' } });
    expect(await fixture.tabs()).toEqual(before);
    expect(await front()).toEqual([`${base}/owner`]);
  }, 120_000);
});

describe('D-335 slice S — a screen of a long page, in real Chrome', () => {
  /** A page opened behind the owner's, its handle, and its Playwright page to look at it directly. */
  const openPage = async (path: string) => {
    const fixture = allUrls!;
    const ingredient: BridgeIngredientRef = { publisher_id: 'recued', slug: 'dom-screenshot', version: '1',
      surface_kind: 'reading', domain_allowlist: [`${base}/*`], domain_allowlist_signature: '' };
    await fixture.reset(`${base}/owner`);
    await fixture.grant(ingredient);
    await fixture.openBackground(`${base}${path}`);
    await fixture.discovered(`${base}${path}`);
    const send = async (action: BridgeAction, args: Record<string, unknown>, expects: readonly string[]) => (await fixture.ordinaryCommand({
      command_id: randomUUID(), recipe_run_id: 'page-capture', step_id: action, ingredient, action,
      target_domain_pattern: `${base}/*`, args, expects_output_keys: [...expects], timeout_ms: 30_000,
      idempotency_key: randomUUID() })).result;
    const listed = await send('list_tabs', {}, BRIDGE_TABS_OUTPUT_KEYS);
    const page = (listed.outputs?.tabs as Array<{ page: string; url: string }>).find(tab => tab.url === `${base}${path}`)!.page;
    const behind = fixture.browser.pages().find(open => open.url() === `${base}${path}`)!;
    /** One screenshot: which screen of how many, and which band its centre shows. */
    const shot = async (args: Record<string, unknown>) => {
      const out = await send('screenshot_page', { page, ...args }, BRIDGE_SCREENSHOT_OUTPUT_KEYS);
      expect(out.status, JSON.stringify(out.error)).toBe('ok');
      const outputs = out.outputs as { image: string; screen: number; screens: number };
      const [r, g, b] = await colourAt(fixture, outputs.image);
      const band = BANDS.findIndex(colour => {
        const [cr, cg, cb] = colour.slice(4, -1).split(',').map(Number);
        return (cr! > 120) === (r! > 120) && (cg! > 120) === (g! > 120) && (cb! > 120) === (b! > 120);
      });
      return { screen: outputs.screen, screens: outputs.screens, band };
    };
    return { behind, shot, send, page, fixture };
  };
  const STEP = 0.875;

  it('the page itself: each screen Page Down further, the last at its end, and the page left where it was', async () => {
    const { behind, shot } = await openPage('/tall');
    const { shown, inner, height } = await behind.evaluate(() => ({ shown: document.documentElement.clientHeight,
      inner: innerHeight, height: document.documentElement.scrollHeight }));
    const pace = Math.floor(shown * STEP);
    const screens = 1 + Math.ceil((height - shown) / pace);
    const bandOf = (n: number) => Math.floor((Math.min((n - 1) * pace, height - shown) + inner / 2) / 600);
    await behind.evaluate(() => scrollTo(0, 1000));
    // The page as shown: the screen it begins in, and nothing scrolled.
    expect(await shot({})).toEqual({ screen: Math.floor(1000 / pace) + 1, screens, band: Math.floor((1000 + inner / 2) / 600) });
    for (const n of [1, 2, 5, screens]) {
      expect(await shot({ screen: n }), `screen ${n}`).toEqual({ screen: n, screens, band: bandOf(n) });
      expect(await behind.evaluate(() => scrollY)).toBe(1000);
    }
    // Past the last screen: the last, and it says so.
    expect(await shot({ screen: screens + 5 })).toEqual({ screen: screens, screens, band: bandOf(screens) });
  }, 180_000);

  it('a page that scrolls a panel instead (a mail list, a chat): the panel\'s screens', async () => {
    const { behind, shot } = await openPage('/panel');
    const { shown, height, inner } = await behind.evaluate(() => {
      const list = document.querySelector('#list')!;
      list.scrollTop = 700;
      return { shown: Math.min(list.clientHeight, innerHeight), height: list.scrollHeight, inner: innerHeight };
    });
    const pace = Math.floor(shown * STEP);
    const screens = 1 + Math.ceil((height - shown) / pace);
    expect(screens).toBeGreaterThan(1);
    expect(await shot({ screen: 4 })).toEqual({ screen: 4, screens, band: Math.floor((3 * pace + inner / 2) / 600) });
    expect(await behind.evaluate(() => [scrollY, document.querySelector('#list')!.scrollTop])).toEqual([0, 700]);
  }, 180_000);

  it('an element that scrolls its content, and one taller than the window: their own screens, cut to the element', async () => {
    const { behind, shot } = await openPage('/boxes');
    const log = await behind.evaluate(() => {
      const box = document.querySelector('#log')!;
      return { shown: box.clientHeight, height: box.scrollHeight };
    });
    const logPace = Math.floor(log.shown * STEP);
    const logScreens = 1 + Math.ceil((log.height - log.shown) / logPace);
    for (const n of [1, 3, logScreens]) {
      const top = Math.min((n - 1) * logPace, log.height - log.shown);
      expect(await shot({ selector: '#log', screen: n }), `log ${n}`)
        .toEqual({ screen: n, screens: logScreens, band: Math.floor((top + log.shown / 2) / 200) });
    }
    expect(await behind.evaluate(() => document.querySelector('#log')!.scrollTop)).toBe(0);
    // Taller than the window: its screens, each cut to the element.
    const inner = await behind.evaluate(() => innerHeight);
    const articlePace = Math.floor(inner * STEP);
    const articleScreens = 1 + Math.ceil((3000 - inner) / articlePace);
    for (const n of [2, articleScreens]) {
      const top = Math.min((n - 1) * articlePace, 3000 - inner);
      expect(await shot({ selector: '#article', screen: n }), `article ${n}`)
        .toEqual({ screen: n, screens: articleScreens, band: Math.floor((top + inner / 2) / 500) });
    }
    expect(await behind.evaluate(() => scrollY)).toBe(0);
  }, 180_000);
});

describe('D-335 slice U — a page scrolled a screen at a time, and left there, in real Chrome', () => {
  /** A page opened behind the owner's, its handle, a way to scroll it, and its Playwright page. */
  const opened = async (path: string) => {
    const fixture = allUrls!;
    const ingredient: BridgeIngredientRef = { publisher_id: 'recued', slug: 'dom-scroll', version: '1',
      surface_kind: 'reading', domain_allowlist: [`${base}/*`], domain_allowlist_signature: '' };
    await fixture.reset(`${base}/owner`);
    await fixture.grant(ingredient);
    await fixture.openBackground(`${base}${path}`);
    await fixture.discovered(`${base}${path}`);
    const send = async (action: BridgeAction, args: Record<string, unknown>, expects: readonly string[]) => (await fixture.ordinaryCommand({
      command_id: randomUUID(), recipe_run_id: 'page-scroll', step_id: action, ingredient, action,
      target_domain_pattern: `${base}/*`, args, expects_output_keys: [...expects], timeout_ms: 30_000,
      idempotency_key: randomUUID() })).result;
    const listed = await send('list_tabs', {}, BRIDGE_TABS_OUTPUT_KEYS);
    const page = (listed.outputs?.tabs as Array<{ page: string; url: string }>).find(tab => tab.url === `${base}${path}`)!.page;
    const behind = fixture.browser.pages().find(open => open.url() === `${base}${path}`)!;
    const scroll = async (args: Record<string, unknown>) => {
      const out = await send('scroll', { page, ...args }, BRIDGE_SCROLL_OUTPUT_KEYS);
      expect(out.status, JSON.stringify(out.error)).toBe('ok');
      // The page it scrolled, as it is then, and which screen of how many.
      const { screen, screens, ...rest } = out.outputs as { screen: number; screens: number };
      expect(rest).toEqual({ page, url: `${base}${path}`, title: expect.any(String) });
      return { screen, screens };
    };
    return { behind, scroll };
  };

  it('the page: one screen on, to the end, back to the top, to a screen named; and it stays there', async () => {
    const { behind, scroll } = await opened('/tall');
    const { shown, height } = await behind.evaluate(() => ({ shown: document.documentElement.clientHeight,
      height: document.documentElement.scrollHeight }));
    const pace = Math.floor(shown * 0.875);
    const screens = 1 + Math.ceil((height - shown) / pace);
    expect(await scroll({})).toEqual({ screen: 2, screens });
    expect(await behind.evaluate(() => scrollY)).toBe(pace);
    expect(await scroll({ to: 'bottom' })).toEqual({ screen: screens, screens });
    expect(await behind.evaluate(() => scrollY)).toBe(height - shown);
    expect(await scroll({ to: 'top' })).toEqual({ screen: 1, screens });
    expect(await scroll({ screen: 4 })).toEqual({ screen: 4, screens });
    expect(await behind.evaluate(() => scrollY)).toBe(3 * pace);
  }, 180_000);

  it('a page that scrolls a panel instead: the panel moves', async () => {
    const { behind, scroll } = await opened('/panel');
    expect((await scroll({ to: 'next' })).screen).toBe(2);
    const [page, panel, shown] = await behind.evaluate(() => [scrollY, document.querySelector('#list')!.scrollTop,
      Math.min(document.querySelector('#list')!.clientHeight, innerHeight)]);
    expect([page, panel]).toEqual([0, Math.floor(shown! * 0.875)]);
  }, 180_000);

  it('a feed that loads more at its end: scrolled there, it is given the moment to draw them, and says it has more', async () => {
    const { behind, scroll } = await opened('/feed-more');
    const first = await scroll({ to: 'bottom' });
    expect(await behind.evaluate(() => document.querySelectorAll('#items > div').length)).toBe(40);
    // Answered once the twenty more were drawn: it now has more screens, and is no longer at its end.
    expect(first.screens).toBeGreaterThan(first.screen);
    expect((await scroll({ to: 'bottom' })).screens).toBeGreaterThan(first.screens);
  }, 180_000);
});

