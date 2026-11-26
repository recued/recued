import { expect, test } from '@playwright/test';
import {
  CONNECTION_BANNER, CREATE_OVERLAY, DRAWER_LINK, DRAWER_OPEN, DRAWER_TOGGLE, HARNESS_URL,
  SETTINGS_NAV_ITEM, SHELL_CONTENT, SHELL_HOST, SHELL_TOPBAR, installFullAppHooks,
} from './helpers/full-app.js';

/** Navigation drawer browser journeys against the deterministic full-app harness. */
const DRAWER = 'data-recued-webclient-drawer';

installFullAppHooks();

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

test('the navigation drawer opens on the current route', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page.locator('[data-recued-data-route]')).toBeVisible();

  await page.locator(`[${DRAWER_TOGGLE}]`).click();

  const current = page.locator(`[${DRAWER_LINK}="data"]`);
  const close = page.getByRole('navigation', {
    name: 'Primary navigation',
  }).getByRole('button', { name: 'Close navigation' });
  // Both ends of the drawer are a finger's size on a phone. ⛔ They were
  // 36px and 38px.
  const closeTarget = await close.boundingBox();
  expect(closeTarget?.width).toBeGreaterThanOrEqual(44);
  expect(closeTarget?.height).toBeGreaterThanOrEqual(44);
  const toggleTarget = await page.locator(`[${DRAWER_TOGGLE}]`).boundingBox();
  expect(toggleTarget?.width).toBeGreaterThanOrEqual(44);
  expect(toggleTarget?.height).toBeGreaterThanOrEqual(44);
  await expect(current).toHaveAttribute('aria-current', 'page');
  await expect(current).toBeFocused();
});

test('the navigation drawer stays inside a short narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 480 });
  // Short of room, the top bar keeps its menu button whole and inside the
  // screen. ⛔ At 280px it gave way to a 16px sliver.
  const toggle = await page.locator(`[${DRAWER_TOGGLE}]`).boundingBox();
  expect(toggle?.width).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(280);
  await page.locator(`[${DRAWER_TOGGLE}]`).click();

  const drawer = page.locator(`[${DRAWER}]`);
  await expect(drawer).toHaveCSS(
    'transform',
    'matrix(1, 0, 0, 1, 0, 0)',
  );
  const drawerBounds = await drawer.boundingBox();
  expect(drawerBounds?.width).toBeLessThanOrEqual(280);
  expect(drawerBounds?.height).toBeLessThanOrEqual(480);

  const accountBounds = await drawer.evaluate((node, linkAttr) => {
    node.scrollTop = node.scrollHeight;
    const account = node.querySelector(
      `[${linkAttr}="account"]`,
    );
    if (account === null) throw new Error('Account drawer seat is missing');
    const bounds = account.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      bottom: bounds.bottom,
    };
  }, DRAWER_LINK);
  expect(accountBounds.left).toBeGreaterThanOrEqual(-0.5);
  expect(accountBounds.right).toBeLessThanOrEqual(280.5);
  expect(accountBounds.bottom).toBeLessThanOrEqual(480.5);
});

test('the navigation drawer Account seat opens Account settings directly', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`[${DRAWER_TOGGLE}]`).click();

  const accountSeat = page.locator(`[${DRAWER_LINK}="account"]`);
  await accountSeat.click();

  await expect(page).toHaveURL(/#settings\/account$/);
  await expect(accountSeat).toHaveAttribute('aria-current', 'page');
  await expect(page.locator(`[${DRAWER_LINK}="settings"]`))
    .not.toHaveAttribute('aria-current', 'page');
  const account = page.locator(`[${SETTINGS_NAV_ITEM}="account"]`);
  await expect(account).toHaveAttribute('aria-current', 'page');
  await expect(account).toHaveAttribute('data-active', 'true');
  await expect(page.locator('[data-recued-account-binding-panel]')).toBeVisible();

  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await expect(accountSeat).toBeFocused();
});

test('the open navigation drawer contains keyboard focus and inerts the page', async ({ page }) => {
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await expect(page.locator(`[${SHELL_HOST}][${DRAWER_OPEN}]`)).toHaveCount(1);
  await expect(page.locator(`[${SHELL_TOPBAR}]`)).toHaveAttribute('inert', '');
  expect(await page.evaluate((contentAttr) =>
    document.querySelector(`[${contentAttr}]`)?.parentElement?.hasAttribute('inert'),
  SHELL_CONTENT)).toBe(true);

  for (let step = 0; step < 20; step += 1) {
    expect(await page.evaluate((drawerAttr) => {
      const drawer = document.querySelector(`[${drawerAttr}]`);
      return drawer?.contains(document.activeElement) === true;
    }, DRAWER)).toBe(true);
    await page.keyboard.press('Tab');
  }

  await page.keyboard.press('Escape');
  await expect(page.locator(`[${SHELL_HOST}][${DRAWER_OPEN}]`)).toHaveCount(0);
  await expect(page.locator(`[${SHELL_TOPBAR}]`)).not.toHaveAttribute('inert', '');
  await expect(page.locator(`[${DRAWER_TOGGLE}]`)).toBeFocused();
});

test('pinned desktop navigation stays beside the workspace across page switches and reloads', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.goto(`${HARNESS_URL}?data=contacts-paged#today`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  const toggle = page.locator(`[${DRAWER_TOGGLE}]`);
  const content = page.locator(`[${SHELL_CONTENT}]`);
  await expect(nav).toBeHidden();
  await toggle.click();
  await nav.getByRole('button', { name: 'Pin navigation', exact: true }).press('Enter');
  const unpin = nav.getByRole('button', { name: 'Unpin navigation', exact: true });
  await expect(unpin).toBeFocused();
  await expect(page.locator(`[${SHELL_TOPBAR}]`)).not.toHaveAttribute('inert', '');
  expect(await content.evaluate(node => node.closest('[inert]') === null)).toBe(true);
  expect(await content.evaluate(node => node.clientWidth)).toBeGreaterThanOrEqual(1280);
  const navBounds = (await nav.boundingBox())!;
  expect(navBounds.x + navBounds.width).toBeLessThanOrEqual((await content.boundingBox())!.x);

  // The sidebar belongs to normal keyboard traversal, so Tab can leave it.
  await nav.getByRole('link', { name: 'Account', exact: true }).focus();
  await page.keyboard.press('Tab');
  expect(await nav.evaluate(node => node.contains(document.activeElement))).toBe(false);
  for (const [label, hash] of [['Tasks', '#data/task'], ['Contacts', '#data/contact'], ['Chats', '#chat']] as const) {
    const link = nav.getByRole('link', { name: label, exact: true });
    await link.click();
    await expect.poll(() => new URL(page.url()).hash).toBe(hash);
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expect(unpin).toBeVisible();
  }
  await page.reload();
  await expect(unpin).toBeVisible();
  await page.getByRole('button', { name: 'Hide navigation', exact: true }).click();
  await expect(nav).toBeHidden();
  await toggle.click();
  await expect(unpin).toBeVisible();
  await unpin.press('Enter');
  await expect(toggle).toBeFocused();
  await page.reload();
  await expect(nav).toBeHidden();
  await toggle.click();
  await expect(nav.getByRole('button', { name: 'Pin navigation', exact: true })).toBeVisible();
});

test('resizing a pinned sidebar restores the drawer and keeps a visible focus target for Create', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 900 });
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  const toggle = page.locator(`[${DRAWER_TOGGLE}]`);
  await toggle.click();
  await nav.getByRole('button', { name: 'Pin navigation', exact: true }).click();
  const unpin = nav.getByRole('button', { name: 'Unpin navigation', exact: true });
  await unpin.focus();
  await page.setViewportSize({ width: 1535, height: 900 });
  await expect(toggle).toBeFocused();
  await expect(nav).toBeHidden();
  await toggle.click();
  await expect(nav.getByRole('button', { name: 'Pin navigation', exact: true })).toBeHidden();
  await expect(page.locator(`[${SHELL_TOPBAR}]`)).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 1536, height: 900 });
  await expect(unpin).toBeVisible();
  await nav.getByRole('button', { name: 'Create', exact: true }).click();
  const create = page.locator(`[${CREATE_OVERLAY}]`);
  await expect(create).toBeVisible();
  await expect(unpin).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await expect(create).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(nav).toBeHidden();
});

test('a drawer seat renders the height it declares, not that plus its padding', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(`[${DRAWER_TOGGLE}]`).click();

  const measured = await page.locator(`[${DRAWER_LINK}]`).evaluateAll((seats) =>
    seats.map((seat) => {
      const style = getComputedStyle(seat);
      return {
        rendered: Math.round(seat.getBoundingClientRect().height),
        declared: parseFloat(style.minHeight),
        boxSizing: style.boxSizing,
      };
    }));
  expect(measured.length).toBeGreaterThanOrEqual(10);

  // ⛔ THE RULE, NOT A HEIGHT. These seats were `content-box`, so
  // `min-height: 40px` reserved 40px of CONTENT and the 8px+8px padding sat on
  // top — every seat rendered 56px for a label needing 16px. Across 19 seats
  // that was 304px, which is why the menu was 1,235px tall, overflowed every
  // viewport, and had no room for the seats the owner asked for. Pinning the
  // RULE survives adding seats; pinning a total height would not.
  for (const seat of measured) {
    expect(seat.boxSizing).toBe('border-box');
    expect(seat.rendered).toBe(seat.declared);
    // And it is still a usable target — the floor this suite asserts elsewhere.
    expect(seat.rendered).toBeGreaterThanOrEqual(36);
  }

  // The consequence worth keeping: the foot of the menu is reachable without
  // hunting. Account is the last seat, and on a desktop viewport the config
  // tier is no longer hundreds of pixels below the fold. The allowance was
  // 120px; the menu has gained seats since, and 21 seats put Account 178px
  // below a 900px window (2026-11-03). A quarter of the window keeps it a
  // short scroll away, with room for one more seat.
  const foot = await page.locator(`[${DRAWER}]`).evaluate((node) => {
    const account = node.querySelector('[data-recued-webclient-drawer-link="account"]')!;
    return Math.round(account.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom);
  });
  expect(foot).toBeLessThan(page.viewportSize()!.height / 4);
});

test('the drawer foot clears the real connection banner, not a stubbed height', async ({ page }) => {
  // ⛔⛔ THE JOIN, WHICH NOTHING DROVE. The writer has unit tests (publishes 0
  // while hidden, the measured height once up, 0 again when it retires) and
  // there is a ratchet that the drawer's padding is expressed as
  // `calc(... + var(--wc-connection-banner-h, 0px))` rather than a literal.
  // Both halves, separately — and a CSS string containing a var name is a
  // DEFINITION check, not evidence that the value ever arrives. This raises the
  // real banner and measures the real last seat.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.__app.setServerAvailable(false);
    window.__app.fireState('closed');
  });
  // ⚠ The offline state is behind a grace window on purpose — `reconnecting`
  // and `stalled` stay quiet because they self-heal. Wait for the state, do not
  // guess a delay.
  const banner = page.locator(`[${CONNECTION_BANNER}][data-state="offline"]`);
  await expect(banner).toBeVisible();

  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  const geometry = await page.locator(`[${DRAWER}]`).evaluate((drawer, bannerAttr) => {
    drawer.scrollTop = drawer.scrollHeight;            // the foot of the menu
    const account = drawer.querySelector(
      '[data-recued-webclient-drawer-link="account"]',
    )!.getBoundingClientRect();
    const bar = document.querySelector(`[${bannerAttr}]`)!.getBoundingClientRect();
    return {
      bannerHeight: Math.round(bar.height),
      clearance: Math.round(bar.top - account.bottom),
      published: getComputedStyle(drawer)
        .getPropertyValue('--wc-connection-banner-h').trim(),
    };
  }, CONNECTION_BANNER);

  // ⚠ At this width the banner wraps to two lines — which is the case its own
  // resize listener exists for, and the worst one to get wrong.
  expect(geometry.bannerHeight).toBeGreaterThan(40);
  expect(geometry.published).toBe(`${geometry.bannerHeight}px`);
  // The last seat ends ABOVE the banner, not underneath it.
  expect(geometry.clearance).toBeGreaterThanOrEqual(0);
});
