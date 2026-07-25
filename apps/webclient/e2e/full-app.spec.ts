import { expect, test } from '@playwright/test';

/**
 * Path B — the WHOLE webclient app booted in a real Chromium off the
 * deterministic fakes (full-app-harness.ts), every IA route driven by hash.
 *
 * Why this exists: every surface dispatches INSIDE the paired `bootstrapWebclient`
 * (after the WS handshake), so a cold staging load with no paired server only ever
 * reaches the pair-form (staging-smoke.spec covers that). The REAL populated
 * end-to-end — a booted recued-server + the pair→WS handshake + seeded data — is
 * `recued-substrate-bench/review-render/render.mjs`. THIS spec is the repeatable,
 * server-free regression twin: it boots the same app the bootstrap dispatches
 * against the fakes the `webclient-bootstrap.test.ts` suite already proves boot the
 * full shell, then drives each route hash and asserts it MOUNTS + RENDERS in a real
 * browser without throwing.
 *
 * Scope, honestly: the fake transport's `send` is a no-op (the unit suite's shape),
 * so route rpcs never resolve — each route renders its real shell + chrome +
 * loading placeholders, NOT populated data (that is render.mjs's job). The
 * route-root marker (`data-recued-<route>-route`) is stamped synchronously by every
 * route the instant it mounts, before any rpc, so it is the durable "this route
 * mounted in a real browser" signal — the same existence contract the unit suite
 * asserts, here proven against real CSS + layout + a `pageerror` gate.
 *
 * Prereq: `node e2e/harness/build-harness.mjs` (the npm script runs it first).
 */

const HARNESS_ORIGIN = 'http://127.0.0.1:4319';
const HARNESS_URL = `${HARNESS_ORIGIN}/full-app-harness.html`;
const ARTIFACTS = 'apps/webclient/e2e/.playwright-artifacts';

const SHELL_HOST = 'data-recued-webclient-shell';
const SHELL_CONTENT = 'data-recued-webclient-content';
const DRAWER_TOGGLE = 'data-recued-webclient-drawer-toggle';
const DRAWER_OPEN = 'data-recued-webclient-drawer-open';
const DRAWER_LINK = 'data-recued-webclient-drawer-link';

// Every IA route + its synchronously-stamped route-root marker (the same markers
// webclient-bootstrap.test.ts asserts). Kitchen is reached via a deep link
// (`#kitchen/pack`, the pack builder the bare `#kitchen` canonicalizes into);
// the rest are their bare surface hash.
const ROUTES: ReadonlyArray<{ hash: string; route: string; marker: string }> = [
  { hash: '#chat', route: 'chat', marker: 'data-recued-chat-route' },
  { hash: '#data', route: 'data', marker: 'data-recued-data-route' },
  { hash: '#recipes', route: 'recipes', marker: 'data-recued-recipes-route' },
  { hash: '#packs', route: 'packs', marker: 'data-recued-packs-route' },
  { hash: '#automation', route: 'automation', marker: 'data-recued-automation-route' },
  { hash: '#connections', route: 'connections', marker: 'data-recued-connections-route' },
  { hash: '#contracts', route: 'contracts', marker: 'data-recued-contracts-route' },
  { hash: '#reception', route: 'reception', marker: 'data-recued-reception-route' },
  { hash: '#approvals', route: 'approvals', marker: 'data-recued-approvals-route' },
  { hash: '#logs', route: 'logs', marker: 'data-recued-logs-route' },
  { hash: '#settings', route: 'settings', marker: 'data-recued-settings-route' },
  { hash: '#kitchen/pack', route: 'kitchen', marker: 'data-recued-kitchen-route' },
];

const pageErrors: Error[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on('pageerror', (err) => pageErrors.push(err));
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => window.__app?.ready === true);
});
test.afterEach(() => {
  expect(
    pageErrors,
    `uncaught page errors: ${pageErrors.map((e) => e.message).join(' | ')}`,
  ).toHaveLength(0);
});

test('boots the full app + mounts the persistent shell on the chat home', async ({ page }) => {
  // The persistent shell owns the app root; the content slot + drawer are chrome.
  await expect(page.locator(`[${SHELL_HOST}]`)).toBeVisible();
  await expect(page.locator(`[${SHELL_CONTENT}]`)).toBeVisible();
  await expect(page.locator(`[${DRAWER_TOGGLE}]`)).toBeVisible();
  // Fixed default landing = the chat home (hashSource seeds `#chat`).
  expect(await page.evaluate(() => window.__app.activeRoute())).toBe('chat');
  await expect(page.locator('[data-recued-chat-route]')).toBeVisible();
});

for (const { hash, route, marker } of ROUTES) {
  test(`route ${hash} mounts + renders in a real browser`, async ({ page }) => {
    await page.evaluate((h) => window.__app.setHash(h), hash);
    // The route-root marker appears the instant the route mounts (pre-rpc);
    // toBeVisible proves it rendered into the live shell with real layout.
    await expect(page.locator(`[${marker}]`)).toBeVisible();
    // The bootstrap's tracked active route matches what mounted.
    expect(await page.evaluate(() => window.__app.activeRoute())).toBe(route);
    // The persistent shell survived the content swap (chrome is not re-mounted).
    await expect(page.locator(`[${SHELL_HOST}]`)).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS}/full-app-${route}.png`, fullPage: false });
  });
}

test('the §D.L2 drawer opens via the ☰ toggle and a nav link drives the route', async ({ page }) => {
  const host = page.locator(`[${SHELL_HOST}]`);
  const openHost = page.locator(`[${SHELL_HOST}][${DRAWER_OPEN}]`);

  // Drawer defaults closed.
  await expect(openHost).toHaveCount(0);

  // ☰ opens it (the host carries the open-state attr the CSS slide-in keys off).
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await expect(openHost).toHaveCount(1);

  // A drawer nav link drives the route (and closes the drawer on navigate).
  await page.locator(`[${DRAWER_LINK}="data"]`).click();
  await expect(page.locator('[data-recued-data-route]')).toBeVisible();
  expect(await page.evaluate(() => window.__app.activeRoute())).toBe('data');
  await expect(host).toBeVisible();
});
