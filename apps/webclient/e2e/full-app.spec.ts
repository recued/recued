import { expect, test } from '@playwright/test';
import {
  CREATE_OVERLAY, DRAWER_ACTION, DRAWER_TOGGLE, HARNESS_URL,
  SHELL_CONTENT, SHELL_HOST, SHELL_SEARCH_TRIGGER, SHELL_TOPBAR,
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
// webclient-bootstrap.test.ts asserts). Kitchen is listed twice: its bare hash is
// the Kitchen home (D-333) and `#kitchen/pack` is the pack builder; the rest are
// their bare surface hash.
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
  { hash: '#kitchen', route: 'kitchen', marker: 'data-recued-kitchen-route' },
  { hash: '#kitchen/pack', route: 'kitchen', marker: 'data-recued-kitchen-route' },
];

installFullAppHooks();

test('shell Search reaches the existing input and restores its query, focus and visibility across phone and desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`${HARNESS_URL}#settings`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const launcher = page.locator(`[${SHELL_SEARCH_TRIGGER}]`);
  await launcher.click();
  await expect(page).toHaveURL(/#data\/search$/);
  const search = page.getByRole('searchbox', { name: 'Search everything' });
  await expect(search).toBeFocused();
  await search.fill('keep this query');

  // Supply scroll room independently of asynchronous result providers.
  const content = page.locator(`[${SHELL_CONTENT}]`);
  await content.evaluate(node => {
    const spacer = document.createElement('div');
    spacer.style.height = '2000px';
    node.appendChild(spacer);
    node.scrollTop = node.scrollHeight;
  });
  await expect(search).not.toBeInViewport();
  await launcher.click();
  await expect(search).toHaveValue('keep this query');
  await expect(search).toBeFocused();
  await expect(search).toBeInViewport();

  await page.setViewportSize({ width: 1280, height: 900 });
  await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await launcher.click();
  await expect(search).toHaveValue('keep this query');
  await expect(search).toBeFocused();
  await expect(search).toBeInViewport();
  await content.focus();
  await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.keyboard.press('Control+/');
  await expect(search).toBeFocused();
  await expect(search).toBeInViewport();
  await expect(search).toHaveValue('keep this query');
});

test('shell Search respects the capture modal before navigating', async ({ page }) => {
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_ACTION}="create"]`).click();
  const capture = page.locator(`[${CREATE_OVERLAY}]`);
  await expect(capture).toBeVisible();
  const draft = capture.locator('[data-recued-compose-capture]');
  await draft.fill('Keep this unsaved capture');
  const address = page.url();
  // Pointer events are shielded by the modal; an invoked launcher must also
  // honor the shared guard rather than bypass it with a direct hash write.
  await page.locator(`[${SHELL_SEARCH_TRIGGER}]`).evaluate(node => {
    (node as HTMLButtonElement).click();
  });
  await page.keyboard.press('Control+/');
  await expect(page).toHaveURL(address);
  await expect(capture).toBeVisible();
  await expect(draft).toHaveValue('Keep this unsaved capture');
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
    await page.screenshot({ path: test.info().outputPath(`full-app-${route}.png`), fullPage: false });
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
