import { expect, test } from '@playwright/test';
import { HARNESS_URL, LIST_PREVIEW, SHARED_REFERENCE_ID, installFullAppHooks } from './helpers/full-app.js';

/** Packs browser journeys against the deterministic full-app harness. */
const PACKS_ADD_INPUT = 'data-recued-packs-surface-add-input';
const PACKS_INSTALLED_ONLY = 'data-recued-packs-surface-installed-only';
const LIST_PREVIEW_CLOSE = 'data-recued-list-preview-close';
const LIST_PREVIEW_OPEN = 'data-recued-list-preview-open';

installFullAppHooks();

test('Packs Add preserves a slug while its IME composition is active', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#packs'));

  const input = page.locator(`[${PACKS_ADD_INPUT}]`);
  await input.fill('日本語パック');
  await input.focus();
  const composingEnter = await input.evaluate((field) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    const dispatched = field.dispatchEvent(event);
    return { dispatched, defaultPrevented: event.defaultPrevented };
  });
  expect(composingEnter).toEqual({
    dispatched: true,
    defaultPrevented: false,
  });
  await expect(page).toHaveURL(/#packs$/);
  await expect(input).toHaveValue('日本語パック');

  await page.keyboard.press('Enter');
  await expect.poll(
    () => page.evaluate(() => location.hash),
  ).toBe(`#packs/${encodeURIComponent('日本語パック')}`);
  await expect(input).toHaveValue('');
});

test('Packs keeps the Installed only source toggle keyboard-owned', async ({ page }) => {
  let releaseCatalogSearch!: () => void;
  const catalogSearch = new Promise<void>((resolve) => { releaseCatalogSearch = resolve; });
  let catalogSearchCalls = 0;
  await page.route('https://recued.com/catalog/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/catalog/versions')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ versions: { 'installed-mail': 1 } }),
      });
      return;
    }
    if (url.pathname.endsWith('/catalog/search')) {
      catalogSearchCalls += 1;
      await catalogSearch;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rows: [
            {
              slug: 'installed-mail',
              publisher_id: 'recued-core',
              name: 'Installed Mail',
              description: 'An installed mail workflow pack.',
              version: 1,
              pack_kind: 'capability',
              service_kind: 'workflow',
              tags: ['mail'],
              download_count: 12,
              item_count: 1,
              recipe_refs: [],
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              slug: 'available-crm',
              publisher_id: 'acme',
              name: 'Available CRM',
              description: 'A marketplace CRM pack.',
              version: 2,
              pack_kind: 'capability',
              service_kind: 'entity_platform',
              tags: ['crm'],
              download_count: 8,
              item_count: 2,
              recipe_refs: [],
              created_at: '2026-02-01T00:00:00.000Z',
            },
          ],
          total: 2,
          totalPages: 1,
          page: 1,
          facets: {},
        }),
      });
      return;
    }
    await route.abort();
  });
  await page.goto(`${HARNESS_URL}?packs=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#packs'));

  const toggle = page.locator(`[${PACKS_INSTALLED_ONLY}]`);
  await expect(page.getByText('Installed Mail', { exact: true })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Available CRM', { exact: true })).toHaveCount(0);
  expect(catalogSearchCalls).toBe(0);
  const restingStyle = await toggle.evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      height: button.getBoundingClientRect().height,
      radius: Number.parseFloat(style.borderRadius),
      cursor: style.cursor,
    };
  });
  expect(restingStyle.height).toBeGreaterThanOrEqual(35.5);
  expect(restingStyle.radius).toBeGreaterThanOrEqual(17);
  expect(restingStyle.cursor).toBe('pointer');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveCSS('cursor', 'progress');
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => catalogSearchCalls).toBe(1);

  releaseCatalogSearch();
  await expect(page.getByText('Available CRM', { exact: true })).toBeVisible();
  await expect(toggle).not.toHaveAttribute('aria-disabled');
  await expect(toggle).not.toHaveAttribute('aria-busy');
  await expect(toggle).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Installed Mail', { exact: true })).toBeVisible();
  await expect(page.getByText('Available CRM', { exact: true })).toHaveCount(0);
  await expect(toggle).not.toHaveAttribute('aria-disabled');
  await expect(toggle).not.toHaveAttribute('aria-busy');
  await expect(toggle).toBeFocused();
  expect(catalogSearchCalls).toBe(1);
});

test('Packs previews a row in place and restores it before full detail', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?packs=installed#packs`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const card = page.locator(
    '[data-recued-discover-card][data-id="installed-mail"]',
  );
  await expect(card).toBeVisible();
  await card.click();

  const preview = page.locator(`[${LIST_PREVIEW}]`);
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Installed Mail' }))
    .toBeVisible();
  await expect(page).toHaveURL(/#packs$/);
  await expect(preview.locator(`[${LIST_PREVIEW_CLOSE}]`)).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(card).toBeFocused();

  await page.keyboard.press('Space');
  await expect(preview).toBeVisible();
  await preview.locator(`[${LIST_PREVIEW_OPEN}]`).click();
  await expect(page).toHaveURL(/#packs\/installed-mail$/);
  await expect(page.locator('[data-recued-packs-detail-back]'))
    .toBeVisible();
});

test('Packs keeps a failed detail Retry focused and single-flight', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?packs=installed&packs_response=detail-fail-once-slow-retry#packs/installed-mail`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const retry = page.locator('[data-recued-packs-retry]');
  await expect(retry).toBeVisible();
  await retry.focus();
  await page.keyboard.press('Enter');

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.dispatchEvent('click');
  await retry.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('packs.list')),
  ).toBe(3);

  const back = page.locator('[data-recued-packs-detail-back]');
  await expect(back).toBeVisible();
  await expect(back).toBeFocused();
  await expect(retry).toHaveCount(0);
});

test('Packs recovers its Use roster without retrying or losing focus on its own', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&packs_recipe_response=fail-once-slow-retry#packs/installed-mail`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const status = page.locator('[data-recued-packs-detail-recipes-status]');
  await expect(status).toHaveText('Loading what this Pack can do…');

  const error = page.locator('[data-recued-packs-detail-recipes-error]');
  await expect(error).toHaveText(
    'Recued could not load what this Pack can do. Pack actions are temporarily unavailable.',
  );
  await expect(status).toHaveCount(0);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('recipe.list')),
  ).toBe(1);
  // The old failure finalizer repainted and immediately started recipe.list
  // again. Give it enough time to prove the error is stable and user-owned.
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__app.rpcCallCount('recipe.list'))).toBe(1);

  const retry = page.locator('[data-recued-packs-detail-recipes-retry]');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.dispatchEvent('click');
  await retry.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('recipe.list')),
  ).toBe(2);

  const use = page.locator(
    '[data-recued-packs-detail-tab-group="primary"][data-recued-packs-detail-tab="use"]',
  );
  await expect(use).toBeVisible();
  await expect(use).toBeFocused();
  await expect(retry).toHaveCount(0);
  await expect(error).toHaveCount(0);
  await expect(
    page.locator('[data-recued-packs-detail-tab-panel="use"]'),
  ).toBeVisible();
});

test('Packs detail tabs name, own, and expose full mobile targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?packs=installed#packs/installed-mail`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const use = page.locator(
    '[data-recued-packs-detail-tab-group="primary"]'
      + '[data-recued-packs-detail-tab="use"]',
  );
  const manage = page.locator(
    '[data-recued-packs-detail-tab-group="primary"]'
      + '[data-recued-packs-detail-tab="detail"]',
  );
  const panel = page.locator('[data-recued-packs-detail-tab-panel]');
  await expect(use).toHaveAttribute(
    'aria-controls',
    'recued-packs-detail-tab-panel',
  );
  await expect(panel).toHaveAttribute(
    'aria-labelledby',
    'recued-packs-detail-primary-use-tab',
  );
  await expect(page.getByRole('tabpanel', { name: 'Use' })).toBeVisible();

  await use.focus();
  await page.keyboard.press('ArrowRight');
  await expect(manage).toHaveAttribute('aria-selected', 'true');
  await expect(manage).toBeFocused();
  const detail = page.locator(
    '[data-recued-packs-detail-tab-group="manage"]'
      + '[data-recued-packs-detail-tab="detail"]',
  );
  const permissions = page.locator(
    '[data-recued-packs-detail-tab-group="manage"]'
      + '[data-recued-packs-detail-tab="permissions"]',
  );
  await expect(detail).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toHaveAttribute(
    'aria-labelledby',
    'recued-packs-detail-primary-detail-tab '
      + 'recued-packs-detail-manage-detail-tab',
  );
  await expect(page.getByRole('tabpanel', { name: 'Manage Detail' })).toBeVisible();

  await detail.focus();
  await page.keyboard.press('ArrowRight');
  await expect(permissions).toHaveAttribute('aria-selected', 'true');
  await expect(permissions).toBeFocused();
  await expect(panel).toHaveAttribute(
    'aria-labelledby',
    'recued-packs-detail-primary-detail-tab '
      + 'recued-packs-detail-manage-permissions-tab',
  );
  await expect(page.getByRole('tabpanel', {
    name: 'Manage Permissions',
  })).toBeVisible();

  const visibleTabs = page.locator('[data-recued-packs-detail-tab]:visible');
  await expect(visibleTabs).toHaveCount(5);
  const tabHeights = await visibleTabs.evaluateAll((tabs) =>
    tabs.map((tab) => tab.getBoundingClientRect().height)
  );
  expect(Math.min(...tabHeights)).toBeGreaterThanOrEqual(44);

  await page.keyboard.press('ArrowRight');
  const contractsHandoff = page.getByRole('link', { name: 'Open Contracts →' });
  await expect(contractsHandoff).toHaveAttribute('href', '#contracts');
  expect((await contractsHandoff.boundingBox())?.height)
    .toBeGreaterThanOrEqual(44);
  await contractsHandoff.focus();
  await expect(contractsHandoff).toBeFocused();
});

test('Packs contains long installed identity throughout its narrow detail', async ({ page }) => {
  const slug = `pack-${'identity'.repeat(7)}`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&connection_text=long#packs/${slug}`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-packs-route]');
  const surface = route.locator('[data-recued-packs-surface]');
  const panel = surface.locator('[data-recued-packs-panel]');
  const facts = panel.locator('.packs-detail-facts');
  await expect(facts).toContainText(slug);
  const owners = panel.locator(
    ':scope, [data-recued-packs-detail-section="identity"], '
    + '.packs-detail-header, .packs-detail-name, .packs-detail-facts, '
    + '[data-recued-packs-detail-tab-panel], .packs-detail-section',
  );
  expect(await owners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  expect(await surface.evaluate(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  )).toBe(true);
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  )).toBe(true);
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
  const tabs = panel.locator('[data-recued-packs-detail-tabs]').first();
  const tabBounds = await tabs.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const owner = element.closest('[data-recued-packs-panel]')
      ?.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      ownerLeft: owner?.left ?? Number.NEGATIVE_INFINITY,
      ownerRight: owner?.right ?? Number.POSITIVE_INFINITY,
    };
  });
  expect(tabBounds.left).toBeGreaterThanOrEqual(tabBounds.ownerLeft - 1);
  expect(tabBounds.right).toBeLessThanOrEqual(tabBounds.ownerRight + 1);
  expect((await panel.locator('[data-recued-packs-detail-back]').boundingBox())?.height)
    .toBeGreaterThanOrEqual(36);
});

test('Packs contains long Manage readiness throughout its narrow detail', async ({ page }) => {
  const slug = `pack-${'identity'.repeat(7)}`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&connection_text=long#packs/${slug}`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-packs-route]');
  const surface = route.locator('[data-recued-packs-surface]');
  const panel = surface.locator('[data-recued-packs-panel]');
  await panel.locator(
    '[data-recued-packs-detail-tab-group="primary"]'
    + '[data-recued-packs-detail-tab="detail"]',
  ).click();
  const readiness = panel.locator('[data-recued-connections-readiness]');
  await expect(readiness).toContainText('crm.objects.deals.write');
  const owners = panel.locator(
    ':scope, [data-recued-packs-detail-tab-panel], .packs-detail-section, '
    + '[data-recued-connections-readiness], .packs-connection-row, '
    + '.packs-connection-status',
  );
  expect(await owners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  for (const owner of [surface, route]) {
    expect(await owner.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    )).toBe(true);
  }
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
  const recovery = readiness.getByRole('link', { name: 'Re-authorize →' });
  expect((await recovery.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  const recoveryBounds = await recovery.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const owner = element.closest('[data-recued-packs-panel]')
      ?.getBoundingClientRect();
    return { right: rect.right, ownerRight: owner?.right ?? 0 };
  });
  expect(recoveryBounds.right).toBeLessThanOrEqual(recoveryBounds.ownerRight + 1);
});

test('Pack app views form one keyboard stop and retain focus through load', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?packs=installed&recipe_result=paged-filter`
      + '&packs_app_views=multi#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const app = page.locator('[data-recued-pack-app="installed-mail"]');
  const tabs = app.locator('[data-recued-pack-app-view]');
  const digest = app.locator(
    '[data-recued-pack-app-view="installed-mail-digest"]',
  );
  const archive = app.locator(
    '[data-recued-pack-app-view="installed-mail-archive"]',
  );
  const panel = app.locator('[data-recued-pack-app-view-panel]');
  const busy = app.locator('[data-recued-pack-app-status="busy"]');

  await expect(tabs).toHaveCount(2);
  await expect(app.getByRole('tablist', {
    name: 'Installed Mail views',
  })).toBeVisible();
  await expect(busy).toHaveCount(0);
  await expect(app.getByText('page-one-row', { exact: true })).toBeVisible();
  await expect(app.locator(
    '[data-recued-pack-app-view][tabindex="0"]',
  )).toHaveCount(1);
  await expect(digest).toHaveAttribute('aria-selected', 'true');
  await expect(digest).toHaveAttribute('tabindex', '0');
  await expect(archive).toHaveAttribute('tabindex', '-1');
  await expect(panel).toHaveAttribute(
    'aria-labelledby',
    'recued-pack-app-view-tab-installed-mail-digest',
  );
  await expect(page.getByRole('tabpanel', { name: 'Mail digest' })).toBeVisible();

  const desktopTabHeights = await tabs.evaluateAll((items) =>
    items.map((tab) => tab.getBoundingClientRect().height)
  );
  expect(Math.min(...desktopTabHeights)).toBeGreaterThanOrEqual(36);
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneTabHeights = await tabs.evaluateAll((items) =>
    items.map((tab) => tab.getBoundingClientRect().height)
  );
  expect(Math.min(...phoneTabHeights)).toBeGreaterThanOrEqual(44);

  await digest.focus();
  await page.keyboard.press('ArrowRight');
  await expect(archive).toHaveAttribute('aria-selected', 'true');
  await expect(archive).toHaveAttribute('tabindex', '0');
  await expect(digest).toHaveAttribute('tabindex', '-1');
  await expect(archive).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('execute')),
  ).toBe(2);
  await expect(busy).toHaveCount(0);
  await expect(archive).toBeFocused();
  await expect(panel).toHaveAttribute(
    'aria-labelledby',
    'recued-pack-app-view-tab-installed-mail-archive',
  );
  await expect(page.getByRole('tabpanel', { name: 'Mail archive' })).toBeVisible();

  await page.keyboard.press('Home');
  await expect(digest).toHaveAttribute('aria-selected', 'true');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('execute')),
  ).toBe(3);
  await expect(busy).toHaveCount(0);
  await expect(digest).toBeFocused();
  await expect(app.locator(
    '[data-recued-pack-app-view][tabindex="0"]',
  )).toHaveCount(1);

  await page.setViewportSize({ width: 280, height: 720 });
  const narrowTabs = await app.getByRole('tablist', {
    name: 'Installed Mail views',
  }).evaluate((tablist) => ({
    contained: tablist.scrollWidth <= tablist.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(narrowTabs.contained).toBe(true);
  expect(narrowTabs.documentWidth).toBeLessThanOrEqual(narrowTabs.viewportWidth);
});

test('Pack Use manages trigger recipes without running them outside their precondition', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?packs=installed&packs_recipe_reactive=1`
      + '#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const app = page.locator('[data-recued-pack-app="installed-mail"]');
  const manage = app.locator(
    '[data-recued-pack-app-automation="installed-mail-digest"]',
  );
  await expect(app.locator('[data-recued-pack-app-view]')).toHaveCount(0);
  await expect(app.locator(
    '[data-recued-pack-app-operation="installed-mail-digest"]',
  )).toHaveCount(0);
  await expect(manage).toHaveText('Manage');
  await expect(manage).toHaveAttribute(
    SHARED_REFERENCE_ID,
    'installed-mail-digest',
  );
  await expect(manage).toHaveAttribute(
    'href',
    '#automation/installed-mail-digest',
  );
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(0);

  await manage.click();
  await expect(page).toHaveURL(/#automation\/installed-mail-digest$/);
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(0);
});

test('Pack Use keeps editable result Save focused through its repaint', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?packs=installed&recipe_result=editable-grid`
    + '&recipe_execute_delay_ms=2500#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const app = page.locator('[data-recued-pack-app="installed-mail"]');
  const amount = app.locator(
    '[data-recued-recipes-result-grid-cell="0:amount"]',
  );
  const status = app.locator('.recipes-result-grid-status');
  const save = app.locator(
    '[data-recued-recipes-action="result-grid-submit"]',
  );
  await expect(amount).toBeVisible();
  await amount.fill('125.00');
  await expect(status).toHaveText('1 row · Unsaved changes');

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    document.querySelector<HTMLElement>('[data-recued-packs-detail-back]')?.click();
  });
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'You have changes you have not saved. Leave anyway?',
  );
  await expect(page).toHaveURL(
    /#packs\/installed-mail\/use\/installed-mail-digest$/,
  );
  await expect(amount).toHaveValue('125.00');
  await expect(amount).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'This pack result has unsaved table changes. Leave Packs anyway?',
  );
  await expect(page).toHaveURL(
    /#packs\/installed-mail\/use\/installed-mail-digest$/,
  );
  await expect(amount).toHaveValue('125.00');
  await expect(amount).toBeFocused();

  const executeCallsBeforeSave = await page.evaluate(
    () => window.__app.rpcCallCount('execute'),
  );
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(status).toHaveText('1 row · Saving changes…');
  await expect(save).toHaveText('Saving…');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  await save.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('execute')),
  ).toBe(executeCallsBeforeSave + 1);

  await expect(status).toHaveText('1 row · No changes yet');
  await expect(amount).toHaveValue('125.00');
  await expect(save).toBeDisabled();
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toHaveAttribute('tabindex', '-1');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(app).toHaveCount(0);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '2');
});

test('Pack Use keeps result paging owned across its repaint', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?packs=installed&recipe_result=paged-filter`
    + '&recipe_execute_delay_ms=2000#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const app = page.locator('[data-recued-pack-app="installed-mail"]');
  const next = app.locator(
    '[data-recued-recipes-result-filter-page="next"]',
  );
  const refresh = app.locator('[data-recued-pack-app-refresh]');
  await expect(next).toBeVisible();
  await expect(refresh).toBeVisible();
  const executeCallsBeforePage = await page.evaluate(
    () => window.__app.rpcCallCount('execute'),
  );
  await next.focus();
  await page.keyboard.press('Enter');

  await expect(next).toHaveText('Loading next page…');
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await expect(next).toHaveAttribute('aria-busy', 'true');
  await expect(next).not.toHaveAttribute('disabled');
  await expect(next).toBeFocused();
  await expect(refresh).toBeDisabled();
  await next.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await refresh.dispatchEvent('click');
  await refresh.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('execute')),
  ).toBe(executeCallsBeforePage + 1);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    document.querySelector<HTMLElement>('[data-recued-packs-detail-back]')?.click();
  });
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening. Leave anyway?',
  );
  await expect(page).toHaveURL(
    /#packs\/installed-mail\/use\/installed-mail-digest$/,
  );
  await expect(next).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A pack action is still in progress. Leave Packs anyway?',
  );
  await expect(page).toHaveURL(
    /#packs\/installed-mail\/use\/installed-mail-digest$/,
  );
  await expect(next).toBeFocused();

  await expect(app.getByText('page-two-row', { exact: true })).toBeVisible();
  const previous = app.locator(
    '[data-recued-recipes-result-filter-page="previous"]',
  );
  await expect(previous).toBeFocused();
  await expect(refresh).toBeEnabled();

  const executeCallsBeforeRefresh = await page.evaluate(
    () => window.__app.rpcCallCount('execute'),
  );
  await refresh.focus();
  await page.keyboard.press('Enter');
  await expect(refresh).toHaveText('Refreshing…');
  await expect(refresh).toHaveAttribute('aria-disabled', 'true');
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
  await expect(refresh).not.toHaveAttribute('disabled');
  await expect(refresh).toBeFocused();
  await refresh.dispatchEvent('click');
  await refresh.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('execute')),
  ).toBe(executeCallsBeforeRefresh + 1);
  await expect(app.getByText('page-one-row', { exact: true })).toBeVisible();
  await expect(refresh).toHaveText('Refresh');
  await expect(refresh).not.toHaveAttribute('aria-disabled');
  await expect(refresh).not.toHaveAttribute('aria-busy');
  await expect(refresh).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(app).toHaveCount(0);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '2');
});

test('Packs hands a failed post-uninstall relist to Retry', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?packs=installed&packs_response=uninstall-relist-fail-once#packs/installed-mail`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const remove = page.locator(
    '[data-recued-packs-row-delete="installed-mail"]',
  );
  await expect(remove).toBeVisible();
  await remove.focus();
  await page.keyboard.press('Enter');

  const confirm = page.locator(
    '[data-recued-packs-row-delete-confirm="installed-mail"]',
  );
  await expect(confirm).toHaveText('Confirm delete');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Deleting…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();

  const retry = page.locator('[data-recued-packs-retry]');
  await expect(retry).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(
    'Pack inventory is temporarily unavailable after uninstall.',
  );
  await expect(retry).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('packs.uninstall')),
  ).toBe(1);

  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toBeFocused();
  await expect(
    page.locator('[data-recued-packs-row-install="installed-mail"]'),
  ).toBeVisible();
  await expect(retry).toHaveCount(0);
  await expect(
    page.locator('[data-recued-packs-detail-back]'),
  ).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('packs.list')),
  ).toBe(4);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('recipe.list')),
  ).toBe(2);
  await expect(
    page.locator('[data-recued-packs-detail-tab="use"]'),
  ).toHaveCount(0);
});

test('Packs install keeps account customization touch-sized and keyboard-owned', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&packs_installed=0&settle_reads=1`
      + '&packs_install_connection=reuse#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const install = page.locator(
    '[data-recued-packs-row-install="installed-mail"]',
  );
  await expect(install).toBeVisible();
  await install.focus();
  await page.keyboard.press('Enter');

  const customize = page.locator(
    '[data-recued-install-connect-customize]',
  );
  await expect(customize).toBeVisible();
  const box = await customize.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(36);

  await customize.focus();
  await page.keyboard.press('Enter');
  const candidate = page.locator(
    '[data-recued-install-connect-candidate="work-onedrive"]',
  );
  await expect(candidate).toBeVisible();
  await expect(candidate).toBeChecked();
  await expect(candidate).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(320);
});

test('Packs contains long install consent throughout its narrow detail', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&packs_installed=0&pack_text=long`
    + '&packs_install_connection=reuse&settle_reads=1#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const panel = page.locator('[data-recued-packs-panel]');
  await expect(panel.locator('.packs-detail-name')).toContainText('PackNN');
  await panel.locator('[data-recued-packs-row-install="installed-mail"]').click();
  const dialog = panel.locator('[data-recued-packs-dialog]');
  await expect(dialog.locator('.packs-dialog-heading')).toContainText('PackNN');
  await expect(dialog.locator('.packs-dialog-list > li')).toContainText(
    'recipe-identity',
  );
  await expect(dialog.locator('.packs-dialog-perm-label', {
    hasText: 'permission-identity',
  })).toBeVisible();
  await expect(dialog.locator('[data-recued-install-connect]')).toBeVisible();
  await dialog.locator('[data-recued-install-connect-customize]').click();
  await expect(dialog.locator(
    '[data-recued-install-connect-candidate="work-onedrive"]',
  )).toBeChecked();
  const owners = dialog.locator(
    ':scope, :scope > *, .packs-dialog-list, .packs-dialog-list > li, '
    + '.packs-dialog-perm-list, .packs-dialog-perm-row, '
    + '.packs-dialog-perm-row label, .packs-dialog-perm-label, '
    + '[data-recued-install-grant-picker], .igp-access-list, '
    + '.igp-access-row, .igp-scope-list, .igp-scope-row, '
    + '[data-recued-install-connect], .packs-dialog-connect-list, '
    + '.packs-dialog-connect-row, .packs-dialog-connect-row label, '
    + '.packs-dialog-actions',
  );
  expect(await owners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  expect(await panel.evaluate(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  )).toBe(true);
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
  const actions = dialog.locator('.packs-dialog-actions .rx-btn');
  const actionSizes = await actions.evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  expect(actionSizes).toHaveLength(2);
  expect(Math.min(...actionSizes.map(({ width }) => width)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.min(...actionSizes.map(({ height }) => height)))
    .toBeGreaterThanOrEqual(40);
});

test('Packs contains long removal disclosure and retains keyboard ownership', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&pack_text=long#packs/installed-mail`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-packs-route]');
  const surface = route.locator('[data-recued-packs-surface]');
  const panel = surface.locator('[data-recued-packs-panel]');
  await panel.locator('[data-recued-packs-row-delete="installed-mail"]').click();
  const footer = panel.locator('.packs-row-footer');
  expect(await footer.evaluate(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  )).toBe(true);
  const confirmActions = footer.getByRole('button');
  const confirmSizes = await confirmActions.evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    })
  );
  expect(confirmSizes).toHaveLength(2);
  expect(Math.min(...confirmSizes.map(({ width }) => width)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.min(...confirmSizes.map(({ height }) => height)))
    .toBeGreaterThanOrEqual(40);

  await panel.locator(
    '[data-recued-packs-row-delete-confirm="installed-mail"]',
  ).click();
  const notice = panel.locator('[data-recued-packs-disclosure]');
  await expect(notice).toBeVisible();
  await expect(notice.locator('.packs-disclosure-title')).toContainText('PackNN');
  await expect(notice.locator('[data-recued-packs-disclosure-block]'))
    .toHaveCount(2);
  await expect(notice.locator('[data-recued-packs-disclosure-item]').first())
    .toContainText('dependent-identity');
  await expect(notice.locator('[data-recued-packs-disclosure-item]').last())
    .toContainText('optional-capability');

  const owners = notice.locator(
    ':scope, :scope > *, .packs-disclosure-head, .packs-disclosure-title, '
    + '.packs-disclosure-block, .packs-disclosure-headline, '
    + '.packs-disclosure-list, .packs-disclosure-list > li',
  );
  expect(await owners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  for (const owner of [panel, surface, route]) {
    expect(await owner.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    )).toBe(true);
  }
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);

  const dismiss = notice.locator('[data-recued-packs-disclosure-dismiss]');
  const dismissSize = await dismiss.boundingBox();
  expect(dismissSize?.width).toBeGreaterThanOrEqual(36);
  expect(dismissSize?.height).toBeGreaterThanOrEqual(44);
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(notice).toHaveCount(0);
  await expect(panel.locator(
    '[data-recued-packs-row-install="installed-mail"]',
  )).toBeFocused();
});

test('Packs keeps long uninstall failures readable and retry-owned', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&pack_text=long`
    + '&packs_uninstall_response=cleanup-required#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-packs-route]');
  const surface = route.locator('[data-recued-packs-surface]');
  const panel = surface.locator('[data-recued-packs-panel]');
  await panel.locator('[data-recued-packs-row-delete="installed-mail"]').click();
  const confirm = panel.locator(
    '[data-recued-packs-row-delete-confirm="installed-mail"]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');

  const footer = panel.locator('.packs-row-footer');
  const error = panel.locator('[data-recued-packs-row-delete-error]');
  await expect(error).toContainText('has to stay so it can tidy up');
  await expect(error).toContainText('no proof that has happened');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(confirm).toBeFocused();
  expect(await footer.evaluate(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  )).toBe(true);
  const footerGeometry = await footer.evaluate((element) => {
    const errorElement = element.querySelector<HTMLElement>(
      '[data-recued-packs-row-delete-error]',
    );
    const footerRect = element.getBoundingClientRect();
    const errorRect = errorElement?.getBoundingClientRect();
    return {
      footerWidth: footerRect.width,
      errorWidth: errorRect?.width ?? 0,
    };
  });
  expect(footerGeometry.errorWidth).toBeGreaterThanOrEqual(
    footerGeometry.footerWidth - 1,
  );
  const actionSizes = await footer.getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    })
  );
  expect(actionSizes).toHaveLength(2);
  expect(Math.min(...actionSizes.map(({ width }) => width)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.min(...actionSizes.map(({ height }) => height)))
    .toBeGreaterThanOrEqual(40);
  expect(Math.max(...actionSizes.map(({ height }) => height)))
    .toBeLessThanOrEqual(44);
  for (const owner of [error, panel, surface, route]) {
    expect(await owner.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    )).toBe(true);
  }

  await page.keyboard.press('Enter');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('packs.uninstall')),
  ).toBe(2);
  await expect(error).toBeVisible();
  await expect(confirm).toBeFocused();
});

test('Packs contains marketplace resolve retry and preserves keyboard ownership', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&pack_text=long`
    + '&packs_resolve_response=fail-once-slow-retry#packs',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const slug = `market-${'identity'.repeat(30)}`;
  const route = page.locator('[data-recued-packs-route]');
  const surface = route.locator('[data-recued-packs-surface]');
  const input = surface.locator('[data-recued-packs-surface-add-input]');
  await input.fill(slug);
  await input.focus();
  await page.keyboard.press('Enter');

  const panel = surface.locator('[data-recued-packs-panel]');
  const error = panel.locator('[data-recued-packs-detail-resolve-error]');
  await expect(error).toContainText(
    'Marketplace pack resolution is temporarily unavailable',
  );
  expect(await error.evaluate(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  )).toBe(true);
  const retry = panel.locator('[data-recued-packs-detail-resolve-retry]');
  expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('packs.resolveBySlug')),
  ).toBe(1);

  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.dispatchEvent('click');
  await retry.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('packs.resolveBySlug')),
  ).toBe(2);

  const install = panel.locator(
    `[data-recued-packs-row-install="${slug}"]`,
  );
  await expect(install).toBeVisible();
  await expect(install).toBeFocused();
  await expect(retry).toHaveCount(0);
  await expect(panel.locator('.packs-detail-name')).toContainText('PackNN');
  for (const owner of [panel, surface, route]) {
    expect(await owner.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    )).toBe(true);
  }
});
