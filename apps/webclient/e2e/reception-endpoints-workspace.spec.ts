import { expect, test, type Page } from '@playwright/test';
import { CONSULTATION, endpointPage, endpointRow, endpointPrompt, endpointCount, failEndpoint, holdEndpoint,
  releaseEndpoint, installEndpointPage, goEndpoints, loadedEndpoints } from './helpers/reception-endpoints.js';

test.beforeEach(async ({ page }) => installEndpointPage(page));
const action = (page: Page, name: string, id = CONSULTATION) => endpointRow(page, id).locator(`[data-action="reception-${name}"]`);
const refresh = (page: Page) => endpointPage(page).getByRole('button', { name: 'Refresh', exact: true });
const promptSubmit = (page: Page) => endpointPrompt(page).locator('[data-action="reception-prompt-submit"]');
const pending = (page: Page, method: string) => expect.poll(() => page.evaluate(method => (window as any).__endpoints.pending(method), method)).toBe(1);
const visitorPreview = (page: Page) => endpointPage(page).locator('.reception-vav');
const visitorFrame = (page: Page) => visitorPreview(page).getByTitle('Reception visitor preview');
const visitorFields = (page: Page) => visitorPreview(page).getByRole('heading', { name: /^Visitor sees/ });
const closeVisitorPreview = (page: Page) => visitorPreview(page).getByRole('button', { name: '← Back to Reception', exact: true });
async function focusAccount(page: Page) {
  await page.locator('[data-recued-account-menu-trigger]').click();
  const close = page.locator('[data-recued-account-menu-close]'); await close.focus(); return close;
}

test('a failed initial inventory read recovers without an unhandled rejection', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await goEndpoints(page, 'endpoints_fail=reception.endpoints.list');
  await expect(endpointPage(page).getByRole('alert')).toBeVisible(); await failEndpoint(page);
  await endpointPage(page).getByRole('button', { name: 'Load Reception', exact: true }).click();
  await expect(endpointRow(page)).toBeVisible(); expect(errors).toEqual([]);
});

test('inventory refresh stays single-flight and restores keyboard focus', async ({ page }) => {
  await loadedEndpoints(page); const before = await endpointCount(page, 'reception.endpoints.list');
  await holdEndpoint(page, 'reception.endpoints.list'); await refresh(page).focus(); await page.keyboard.press('Enter');
  await pending(page, 'reception.endpoints.list'); await expect(refresh(page)).toBeDisabled();
  await releaseEndpoint(page, 'reception.endpoints.list'); await expect(refresh(page)).toBeEnabled();
  await expect(refresh(page)).toBeFocused(); expect(await endpointCount(page, 'reception.endpoints.list')).toBe(before + 1);
});

test('refresh does not replace later Account focus', async ({ page }) => {
  await loadedEndpoints(page); await holdEndpoint(page, 'reception.endpoints.list'); await refresh(page).click();
  await pending(page, 'reception.endpoints.list'); const close = await focusAccount(page);
  await releaseEndpoint(page, 'reception.endpoints.list'); await expect(refresh(page)).toBeEnabled(); await expect(close).toBeFocused();
});

for (const [operation, id, counterpart] of [['disable', CONSULTATION, 'enable'], ['enable', 'customer-intake', 'disable']] as const) {
  test(`keyboard ${operation} returns focus to the same endpoint's ${counterpart} control`, async ({ page }) => {
    await loadedEndpoints(page); await action(page, operation, id).focus(); await page.keyboard.press('Enter');
    await expect(action(page, counterpart, id)).toBeVisible(); await expect(action(page, counterpart, id)).toBeFocused();
    expect(await endpointCount(page, `reception.endpoint.${operation}`)).toBe(1);
    expect(await page.evaluate(method => (window as any).__endpoints.calls.find((c: any) => c.method === method)?.args, `reception.endpoint.${operation}`)).toEqual({ endpoint_id: id });
  });
}

test('a rejected disable restores its exact endpoint control and permits retry', async ({ page }) => {
  await loadedEndpoints(page); await failEndpoint(page, 'reception.endpoint.disable');
  await action(page, 'disable').focus(); await page.keyboard.press('Enter');
  await expect(endpointPage(page).getByRole('alert')).toBeVisible(); await expect(action(page, 'disable')).toBeFocused();
  await failEndpoint(page); await page.keyboard.press('Enter'); await expect(action(page, 'enable')).toBeFocused();
  expect(await endpointCount(page, 'reception.endpoint.disable')).toBe(2);
});

test('detail navigation moves focus to its heading and returns to the source endpoint', async ({ page }) => {
  await loadedEndpoints(page); await action(page, 'open-detail').focus(); await page.keyboard.press('Enter');
  await expect(endpointPage(page).locator('.reception-detail-title')).toBeFocused();
  await endpointPage(page).locator('[data-action="reception-close-detail"]').click();
  await expect(action(page, 'open-detail')).toBeFocused(); await expect(page).toHaveURL(/#reception\/endpoints$/);
});

test('a failed detail read retries the same endpoint rather than only refreshing the list', async ({ page }) => {
  await goEndpoints(page, 'endpoints_fail=reception.endpoint.access_log', CONSULTATION);
  await expect(endpointPage(page).getByRole('alert')).toBeVisible(); await failEndpoint(page);
  await refresh(page).click(); await expect(endpointPage(page).locator('.reception-detail-title')).toHaveText(CONSULTATION);
  expect(await page.evaluate(() => (window as any).__endpoints.calls.filter((c: any) => c.method === 'reception.endpoint.access_log').map((c: any) => c.args))).toEqual([{ endpoint_id: CONSULTATION }, { endpoint_id: CONSULTATION }]);
});

test('desktop visitor review shows the page beside its field checklist and returns to the same endpoint', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 768 });
  await loadedEndpoints(page);
  const opener = action(page, 'preview-as-visitor');
  const scroller = page.locator('[data-recued-webclient-content]');
  await opener.scrollIntoViewIfNeeded();
  const scrollTop = () => scroller.evaluate(element => element.scrollTop);
  const originalScroll = await scrollTop();
  expect(originalScroll).toBeGreaterThan(0);
  await opener.press('Enter');

  const heading = visitorPreview(page).getByRole('heading', { name: 'View as visitor', exact: true });
  await expect(heading).toBeFocused();
  await expect(closeVisitorPreview(page)).toBeInViewport();
  await expect(visitorPreview(page).getByText(/^Preview good for/)).toBeInViewport();
  await expect(visitorFields(page)).toBeInViewport();
  await expect(visitorFrame(page)).toHaveAttribute('sandbox', '');
  await expect(visitorFrame(page).contentFrame().getByRole('heading', { name: 'Customer consultation' })).toBeVisible();
  const frameBox = (await visitorFrame(page).boundingBox())!;
  const fieldsBox = (await visitorFields(page).boundingBox())!;
  expect(frameBox.x + frameBox.width).toBeLessThan(fieldsBox.x);
  expect(fieldsBox.y).toBeLessThan(frameBox.y + frameBox.height);

  await page.keyboard.press(browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab');
  await expect(closeVisitorPreview(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(visitorPreview(page)).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(opener).toBeInViewport();
  await expect.poll(async () => Math.abs(await scrollTop() - originalScroll)).toBeLessThan(3);
});

test.describe('visitor review on touch screens', () => {
  test.use({ hasTouch: true, viewport: { width: 1440, height: 800 } });

  test('stacks the checklist below the frame on wide touch and phones and returns to detail', async ({ page }) => {
    await goEndpoints(page, '', CONSULTATION);
    const opener = endpointPage(page).locator('.reception-detail [data-action="reception-preview-as-visitor"]');
    await opener.tap();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(visitorFrame(page)).toBeVisible();
      const frameBox = (await visitorFrame(page).boundingBox())!;
      const fieldsBox = (await visitorFields(page).boundingBox())!;
      expect(frameBox.y + frameBox.height).toBeLessThan(fieldsBox.y);
    }
    await closeVisitorPreview(page).tap();
    await expect(opener).toBeFocused();
    await expect(endpointPage(page).locator('.reception-detail-title')).toHaveText(CONSULTATION);
  });
});

test('a pending visitor preview runs once, restores its failed opener and respects later Account focus', async ({ page }) => {
  await loadedEndpoints(page);
  const method = 'reception.endpoint.preview_draft';
  const opener = action(page, 'preview-as-visitor');
  await holdEndpoint(page, method);
  await opener.press('Enter');
  await pending(page, method);
  await expect(opener).toHaveAttribute('aria-busy', 'true');
  await expect(opener).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await endpointCount(page, method)).toBe(1);
  await releaseEndpoint(page, method, true);
  await expect(endpointPage(page).getByRole('alert')).toBeVisible();
  await expect(opener).toBeFocused();
  await expect(opener).not.toHaveAttribute('aria-busy');

  await holdEndpoint(page, method);
  await opener.press('Enter');
  await pending(page, method);
  const accountClose = await focusAccount(page);
  await releaseEndpoint(page, method);
  await expect(visitorFrame(page)).toBeVisible();
  await expect(accountClose).toBeFocused();
});

test('a late visitor preview leaves the selected endpoint detail in view', async ({ page }) => {
  await loadedEndpoints(page);
  const method = 'reception.endpoint.preview_draft';
  await holdEndpoint(page, method);
  await action(page, 'preview-as-visitor').press('Enter');
  await pending(page, method);
  await action(page, 'open-detail').click();
  await expect(endpointPage(page).locator('.reception-detail-title')).toHaveText(CONSULTATION);
  await releaseEndpoint(page, method);
  await expect(endpointPage(page).getByRole('status', { name: 'Working…' })).toHaveCount(0);
  await expect(visitorPreview(page)).toHaveCount(0);
  await expect(endpointPage(page).locator('.reception-detail-title')).toHaveText(CONSULTATION);
});

test('lifecycle prompts announce their purpose, cycle Tab and return focus on Escape', async ({ page }) => {
  await loadedEndpoints(page); await action(page, 'rotate-token').focus(); await page.keyboard.press('Enter');
  const dialog = endpointPrompt(page).getByRole('dialog', { name: 'Swap the secret', exact: true });
  await expect(dialog).toBeFocused(); await promptSubmit(page).focus(); await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Rotation reason')).toBeFocused(); await page.keyboard.press('Shift+Tab');
  await expect(promptSubmit(page)).toBeFocused(); await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(action(page, 'rotate-token')).toBeFocused();
  expect(await endpointCount(page, 'reception.endpoint.rotate_token')).toBe(0);
});

test('a pending revoke submits once and retains its reason and retry focus on failure', async ({ page }) => {
  await loadedEndpoints(page); await action(page, 'revoke').click();
  await endpointPrompt(page).getByLabel('Revocation reason').fill('Updated project scope');
  const method = 'reception.endpoint.revoke'; await holdEndpoint(page, method); await promptSubmit(page).click(); await pending(page, method);
  await expect(promptSubmit(page)).toBeDisabled(); const rect = await promptSubmit(page).boundingBox();
  await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2); expect(await endpointCount(page, method)).toBe(1);
  await releaseEndpoint(page, method, true); await expect(promptSubmit(page)).toBeEnabled(); await expect(promptSubmit(page)).toBeFocused();
  await expect(endpointPrompt(page).getByLabel('Revocation reason')).toHaveValue('Updated project scope');
  await promptSubmit(page).click(); await expect(endpointPrompt(page).locator('.rx-panel')).toHaveCount(0);
  expect(await endpointCount(page, method)).toBe(2);
  expect(await page.evaluate(() => (window as any).__endpoints.calls.filter((c: any) => c.method === 'reception.endpoint.revoke').map((c: any) => c.args))).toEqual([
    { endpoint_id: CONSULTATION, reason: 'Updated project scope' }, { endpoint_id: CONSULTATION, reason: 'Updated project scope' },
  ]);
});

test('a rotated one-shot URL survives closing the pending prompt without replacing a newer prompt', async ({ page }) => {
  await loadedEndpoints(page); await action(page, 'rotate-token').click(); await holdEndpoint(page, 'reception.endpoint.rotate_token');
  await promptSubmit(page).click(); await pending(page, 'reception.endpoint.rotate_token');
  await endpointPrompt(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await action(page, 'revoke', 'customer-intake').click(); await releaseEndpoint(page, 'reception.endpoint.rotate_token');
  await expect.poll(() => endpointCount(page, 'reception.endpoints.list')).toBeGreaterThan(1);
  await expect(endpointPrompt(page)).toContainText('Take this link back');
  await endpointPrompt(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await action(page, 'open-detail').click(); await expect(endpointPage(page).locator('.reception-share-snippet').first()).toContainText('rotated-fixture-token');
  expect(await endpointCount(page, 'reception.endpoint.rotate_token')).toBe(1);
});

test('rotating from detail shows the new URL even when its post-write refresh fails', async ({ page }) => {
  await goEndpoints(page, '', CONSULTATION); await expect(endpointPage(page).locator('.reception-detail-title')).toHaveText(CONSULTATION);
  await failEndpoint(page, 'reception.endpoints.list');
  await endpointPage(page).locator('.reception-detail > .rx-action-bar [data-action="reception-rotate-token"]').click();
  await promptSubmit(page).click(); await expect(endpointPrompt(page).locator('.rx-panel')).toHaveCount(0);
  await expect(endpointPage(page).getByRole('alert')).toBeVisible();
  await expect(endpointPage(page).locator('.reception-share-snippet').first()).toContainText('rotated-fixture-token');
  expect(await endpointCount(page, 'reception.endpoint.rotate_token')).toBe(1);
});

test('the access log can be scrolled with the keyboard on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 850 }); await goEndpoints(page, '', CONSULTATION);
  const log = endpointPage(page).getByRole('region', { name: 'Endpoint access log', exact: true });
  await expect(log).toBeVisible(); await log.scrollIntoViewIfNeeded();
  await endpointPage(page).locator('.reception-detail-section [data-action="reception-rotate-token"]').focus();
  await page.keyboard.press('Tab'); await expect(log).toBeFocused();
  // WebKit can discard scrolling for a key released in the same instant.
  // Hold the real arrow key briefly, as a physical keyboard press would.
  await page.keyboard.press('ArrowRight', { delay: 80 });
  await expect.poll(() => log.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  await expect(log).toContainText('/reception/book/consultation?t=[redacted]');
});

for (const operation of ['enable', 'disable', 'extend', 'revoke', 'rotate_token', 'emergency_disable_all'] as const) {
  test(`pending ${operation} remains owned after leaving Endpoints`, async ({ page }) => {
    await loadedEndpoints(page); const method = operation === 'emergency_disable_all' ? 'reception.emergency_disable_all' : 'reception.endpoint.' + operation;
    await holdEndpoint(page, method);
    if (operation === 'emergency_disable_all') {
      await endpointPage(page).locator('[data-action="reception-emergency-disable-all"]').click();
      await endpointPrompt(page).getByLabel('Confirmation phrase').fill('TURN EVERYTHING OFF NOW');
    } else await action(page, operation === 'rotate_token' ? 'rotate-token' : operation, operation === 'enable' ? 'customer-intake' : CONSULTATION).click();
    if (!['enable', 'disable'].includes(operation)) await promptSubmit(page).click();
    await pending(page, method);
    if (await endpointPrompt(page).getByRole('button', { name: 'Cancel', exact: true }).isVisible()) await endpointPrompt(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('link', { name: 'Records', exact: true }).click();
    await expect(endpointPage(page)).toHaveCount(0); await page.locator('[data-recued-account-menu-trigger]').click();
    const account = page.locator('[data-recued-account-menu-popover]'); const office = account.locator('[data-recued-server-switcher-item]').filter({ hasText: 'Office server' });
    await office.click(); const review = account.locator('[data-recued-server-switcher-switch-confirm]');
    await expect(review).toContainText('Work is still finishing on');
    await expect(review.locator('[data-recued-server-switcher-switch-commit]')).toHaveText('Switch, and check later');
    await releaseEndpoint(page, method); await review.locator('[data-recued-server-switcher-switch-cancel]').click(); await office.click();
    await expect(review.locator('[data-recued-server-switcher-switch-commit]')).toHaveText('Switch server'); expect(await endpointCount(page, method)).toBe(1);
  });
}

test('singleton, revoked and unavailable endpoints keep their capability boundaries', async ({ page }) => {
  await loadedEndpoints(page);
  expect(await endpointRow(page, '__reception_page__').locator('[data-action]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-action')))).toEqual(['reception-edit-page', 'reception-open-detail']);
  await expect(endpointRow(page, 'project-approval').locator('[data-action="reception-revoke"]')).toHaveCount(0);
  await expect(endpointRow(page, 'legacy-status').locator('[data-action="reception-preview-as-visitor"]')).toHaveCount(0);
  await expect(endpointPage(page).locator('[data-action="reception-new-endpoint"][data-kind="status_link"]')).toHaveCount(0);
  expect(await endpointCount(page, 'execute')).toBe(0); expect(await endpointCount(page, 'reception.endpoint.create')).toBe(0);
});
