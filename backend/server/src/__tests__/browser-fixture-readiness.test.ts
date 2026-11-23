import { createServer, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createReviewedBrowserFixture } from './d-261-browser-fixture.js';

let slowResponse: ServerResponse | undefined;
let requested: () => void;
const slowRequested = new Promise<void>(resolve => { requested = resolve; });
const server = createServer((request, response) => {
  if (request.url === '/slow') { slowResponse = response; requested(); return; }
  response.end('<!doctype html><title>Owner</title><p>The active page</p>');
});
let fixture: Awaited<ReturnType<typeof createReviewedBrowserFixture>> | undefined;
let origin: string;

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fixture = await createReviewedBrowserFixture(origin + '/owner');
}, 240_000);

afterAll(async () => {
  slowResponse?.end();
  await fixture?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}, 120_000);

it('waits for a background page that loads beyond five seconds without moving the active tab', async () => {
  let settled = false;
  // Attach both branches immediately so the old fixture's early rejection is
  // observed while the HTTP response is deliberately held.
  const loading = fixture!.openBackground(origin + '/slow').then(
    () => { settled = true; return { ok: true } as const; },
    error => { settled = true; return { ok: false, error } as const; });
  try {
    await slowRequested;
    await new Promise(resolve => setTimeout(resolve, 6_000));
    expect(settled).toBe(false);
  } finally {
    slowResponse!.end('<!doctype html><title>Loaded</title><p>The background page</p>');
  }
  const outcome = await loading;
  expect(outcome.ok, outcome.ok ? undefined : String(outcome.error)).toBe(true);
  expect(await fixture!.tabs()).toEqual(expect.arrayContaining([
    expect.objectContaining({ url: origin + '/owner', active: true }),
    expect.objectContaining({ url: origin + '/slow', active: false }),
  ]));
}, 45_000);
