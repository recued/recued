import { expect, test } from '@playwright/test';
import {
  ARTIFACTS, DRAWER_TOGGLE, SHELL_CONTENT, SHELL_HOST, SHELL_TOPBAR,
  installFullAppHooks,
} from './helpers/full-app.js';

/**
 * Path B — the WHOLE webclient app booted in a real Chromium off the
 * deterministic fakes (full-app-harness.ts), every IA route driven by hash.
 *
 * Why this exists: every surface dispatches INSIDE the paired `bootstrapWebclient`
 * (after the WS handshake), so a cold staging load with no paired server only ever
 * reaches the pair-form (staging-smoke.spec covers that). The REAL populated
 * end-to-end — a booted recued-server + the pair→WS handshake + seeded data — is
 * internal benchmarks. THIS spec is the repeatable,
 * server-free regression twin: it boots the same app the bootstrap dispatches
 * against the fakes the `webclient-bootstrap.test.ts` suite already proves boot the
 * full shell, then drives each route hash and asserts it MOUNTS + RENDERS in a real
 * browser without throwing.
 *
 * Scope, honestly: the fake transport answers the deterministic first-run
 * reads, empty recipe handoff, and one populated run → record verification
 * journey; other route rpcs remain pending, so those routes render their real
 * shell + chrome + loading placeholders. The broad populated pass remains
 * render.mjs's job. The route-root marker
 * (`data-recued-<route>-route`) is
 * stamped synchronously by every route the instant it mounts, before any rpc,
 * so it is the durable "this route mounted in a real browser" signal — the same
 * existence contract the unit suite asserts, here proven against real CSS +
 * layout + a `pageerror` gate.
 *
 * Prereq: `node e2e/harness/build-harness.mjs` (the npm script runs it first).
 */

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

installFullAppHooks();

test('boots the full app + mounts the persistent shell on the chat home', async ({ page }) => {
  // The persistent shell owns the app root; the content slot + drawer are chrome.
  await expect(page.locator(`[${SHELL_HOST}]`)).toBeVisible();
  await expect(page.locator(`[${SHELL_CONTENT}]`)).toBeVisible();
  await expect(page.locator(`[${DRAWER_TOGGLE}]`)).toBeVisible();
  // Fixed default landing = the chat home (hashSource seeds `#chat`).
  expect(await page.evaluate(() => window.__app.activeRoute())).toBe('chat');
  await expect(page.locator('[data-recued-chat-route]')).toBeVisible();
});

test('persistent brand exposes a full mobile home target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const brand = page.locator('.webclient-shell-brand');
  await expect(brand).toHaveAttribute('href', '#chat');
  const bounds = await brand.boundingBox();
  expect(bounds?.height).toBeGreaterThanOrEqual(38);

  await brand.focus();
  await expect(brand).toBeFocused();
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

test('the mobile shell stays within the viewport after a live heartbeat', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_heartbeat',
      payload: {
        server_id: 'sha256:mobile-layout',
        last_seen_at: Date.now(),
        lifecycle_state: 'running',
        uptime_s: 43_200,
      },
    });
  });

  const layout = await page.evaluate(({ topbarAttr, contentAttr }) => {
    const topbar = document.querySelector(`[${topbarAttr}]`)!.getBoundingClientRect();
    const content = document.querySelector(`[${contentAttr}]`)!.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      topbarLeft: topbar.left,
      topbarRight: topbar.right,
      contentLeft: content.left,
      contentRight: content.right,
    };
  }, { topbarAttr: SHELL_TOPBAR, contentAttr: SHELL_CONTENT });
  expect(layout.topbarLeft).toBeGreaterThanOrEqual(-0.5);
  expect(layout.contentLeft).toBeGreaterThanOrEqual(-0.5);
  expect(layout.topbarRight).toBeLessThanOrEqual(layout.viewport + 0.5);
  expect(layout.contentRight).toBeLessThanOrEqual(layout.viewport + 0.5);
});
