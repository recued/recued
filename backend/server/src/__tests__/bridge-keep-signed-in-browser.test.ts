/** D-347 follow-up 19 — Keep signed in's two functions in a real page (`apps/bridge/src/keep-signed-in.ts`): the
 *  request that keeps a session its server keeps alive, and the look for something typed and not sent that
 *  keeps a page from being reloaded. The tick that runs them is driven over fakes
 *  (`apps/bridge/src/__tests__/keep-signed-in.test.ts`).
 *
 *  The site here signs a session out after 1.5 s without a request, as a console does after minutes. Follow-up 28: some
 *  of its pages, once loaded, have their site answer a request elsewhere: at its sign-in page, at another of its pages,
 *  at another site's, or not at all. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keepSessionAlive, pageHasUnsentInput } from '../../../../apps/bridge/src/keep-signed-in.js';
import { createReviewedBrowserFixture } from './d-261-browser-fixture.js';

const IDLE_MS = 1_500;
const CONSOLE = `<!doctype html><html><head><meta charset="utf-8"><title>Console</title></head><body>
<form><input id="note" value=""><textarea id="body"></textarea><input type="checkbox" id="agree">
<select id="plan"><option value="a" selected>A</option><option value="b">B</option></select></form>
<div id="editor" contenteditable="true">A note</div>
</body></html>`;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('D-347 follow-up 19 — Keep signed in, in real Chrome', () => {
  let server: Server | undefined;
  let base = '';
  let browser: Awaited<ReturnType<typeof createReviewedBrowserFixture>> | undefined;
  /** Each session, by its cookie, and when its last request came. */
  const sessions = new Map<string, number>();

  // ⚠ 240s: the fixture bounds Chrome's MV3 worker start at 180s with a named error.
  beforeAll(async () => {
    server = createServer((request, response) => {
      // Follow-up 28 — loaded, each of these pages has its request answered elsewhere.
      if (request.headers['sec-fetch-mode'] !== 'navigate') {
        const port = (server!.address() as { port: number }).port;
        const sentOn = { '/to-sign-in': '/login?next=%2Fto-sign-in', '/moves-on': '/console',
          '/to-another-site': `http://localhost:${String(port)}/signin?continue=%2Fto-another-site` }[request.url ?? ''];
        if (sentOn !== undefined) {
          response.writeHead(302, { location: sentOn }).end();
          return;
        }
        if (request.url === '/drops') {
          request.socket.destroy();
          return;
        }
      }
      const sid = /(?:^|;\s*)sid=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
      const live = sid !== undefined && sessions.has(sid) && Date.now() - sessions.get(sid)! < IDLE_MS;
      if (request.url === '/alive') {
        // Asked from the page, it is no activity of the session's.
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ alive: live }));
        return;
      }
      if (live) {
        sessions.set(sid, Date.now());
        response.writeHead(200, { 'content-type': 'text/html' });
      } else {
        const fresh = randomUUID();
        sessions.set(fresh, Date.now());
        response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `sid=${fresh}; Path=/; HttpOnly; SameSite=Lax` });
      }
      response.end(CONSOLE);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no page server port');
    base = `http://127.0.0.1:${address.port}`;
    browser = await createReviewedBrowserFixture('about:blank');
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise(resolve => server ? server.close(resolve) : resolve(undefined));
  }, 120_000);

  const alive = () => browser!.page.evaluate(() => fetch('/alive').then(r => r.json()).then((j: { alive: boolean }) => j.alive));

  it('the request from the page keeps a session its server keeps alive; without it, the session ends', async () => {
    await browser!.reset(`${base}/console`);
    for (let i = 0; i < 3; i += 1) {
      await wait(1_000);
      expect(await browser!.page.evaluate(keepSessionAlive)).toEqual({ status: 200 });
    }
    // 3 s on, twice its idle time: still signed in.
    expect(await alive()).toBe(true);
    await wait(2_000);
    expect(await alive()).toBe(false);
  }, 60_000);

  it('follow-up 28 — the request says where its site sent it: to its sign-in page, to another of its pages, or on to another site', async () => {
    await browser!.reset(`${base}/to-sign-in`);
    expect(await browser!.page.evaluate(keepSessionAlive)).toEqual({ status: 200, redirected_to: `${base}/login?next=%2Fto-sign-in` });
    await browser!.reset(`${base}/moves-on`);
    expect(await browser!.page.evaluate(keepSessionAlive)).toEqual({ status: 200, redirected_to: `${base}/console` });
    // Another site does not let the page read its answer, so the request fails: asked again without following, it was sent on.
    await browser!.reset(`${base}/to-another-site`);
    expect(await browser!.page.evaluate(keepSessionAlive)).toEqual({ elsewhere: true });
    // One that fails for another reason is no such thing.
    await browser!.reset(`${base}/drops`);
    expect(await browser!.page.evaluate(keepSessionAlive)).toEqual({ failed: expect.any(String) });
    // A page whose site answers it there, as before.
    await browser!.reset(`${base}/console`);
    expect(await browser!.page.evaluate(keepSessionAlive)).toEqual({ status: 200 });
  }, 60_000);

  it('something typed and not sent is told, in a field, a box or an editor; the page as it loaded is not', async () => {
    // A reset opens the page anew: each is read after it.
    const fresh = async () => { await browser!.reset(`${base}/console`); return browser!.page; };
    let page = await fresh();
    expect(await page.evaluate(pageHasUnsentInput)).toBe(false);
    await page.fill('#note', 'a draft');
    expect(await page.evaluate(pageHasUnsentInput)).toBe(true);
    page = await fresh();
    await page.check('#agree');
    expect(await page.evaluate(pageHasUnsentInput)).toBe(true);
    page = await fresh();
    await page.selectOption('#plan', 'b');
    expect(await page.evaluate(pageHasUnsentInput)).toBe(true);
    page = await fresh();
    await page.focus('#editor');
    expect(await page.evaluate(pageHasUnsentInput)).toBe(true);
  }, 60_000);
});
