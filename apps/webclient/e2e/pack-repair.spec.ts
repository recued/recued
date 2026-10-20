import { test, expect, type Page } from '@playwright/test';
const state = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-repair-fixture')!));
const confirm = (page: Page) => page.locator('[data-pack-repair-confirm]');
const ack = (page: Page) => page.locator('[data-pack-repair-focus="ack"]');
for (const width of [280, 1280]) {
  const open = async (page: Page, scenario = '') => {
    await page.setViewportSize({ width, height: 900 });await page.goto('/pack-repair-harness.html?scenario=' + scenario);
    const panel = page.locator('[data-pack-repair-panel]');await panel.getByText('Installation health and repair', { exact: true }).click();
    await panel.getByRole('button', { name: 'Inspect local installations', exact: true }).click();return panel;
  };
  const review = async (page: Page, scenario = '') => {
    const panel = await open(page, scenario);await panel.getByRole('button', { name: 'Review local cleanup', exact: true }).click();return panel;
  };
  test(`orphan cleanup is inspectable without a catalog and requires approval at ${width}px`, async ({ page }) => {
    const panel = await review(page);await expect(panel).toContainText('Connection credentials stay enrolled');await expect(confirm(page)).toBeDisabled();
    expect((await state(page)).writes).toBe(0);await ack(page).check();await confirm(page).click();await expect(panel).toContainText('Local cleanup completed; receipt');
    expect((await state(page)).writes).toBe(1);expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`ambiguous evidence holds repair at ${width}px`, async ({ page }) => {
    const panel = await review(page, 'blocked');await expect(panel.getByRole('alert')).toContainText('conflicting publisher');await ack(page).check();await expect(confirm(page)).toBeDisabled();expect((await state(page)).apply_calls).toBe(0);
  });
  test(`unknown dependencies need a separate acknowledgement at ${width}px`, async ({ page }) => {
    await review(page, 'unknown');await ack(page).check();await expect(confirm(page)).toBeDisabled();await page.locator('[data-pack-repair-focus="unknown"]').check();await expect(confirm(page)).toBeEnabled();await confirm(page).click();expect((await state(page)).writes).toBe(1);
  });
  test(`lost review reads reuse their request identity at ${width}px`, async ({ page }) => {
    const panel = await review(page, 'lost-review');await expect(panel.getByRole('alert')).toContainText('reply lost');await panel.getByRole('button', { name: 'Retry loading this repair review' }).click();
    await ack(page).check();expect(Object.keys((await state(page)).reviews)).toHaveLength(1);await confirm(page).click();await expect(panel).toContainText('Local cleanup completed');
  });
  test(`drift requires a fresh reviewed state and acknowledgement at ${width}px`, async ({ page }) => {
    const panel = await review(page, 'drift');await ack(page).check();await confirm(page).click();await expect(panel.getByRole('alert')).toContainText('state changed');
    await panel.getByRole('button', { name: 'Review current state again' }).click();await expect(ack(page)).not.toBeChecked();await expect(confirm(page)).toBeDisabled();
    await ack(page).check();await confirm(page).click();expect((await state(page)).writes).toBe(1);
  });
  for (const scenario of ['lost', 'lost-reinstalled']) test(`lost completion ${scenario} survives list refresh and recovers once at ${width}px`, async ({ page }) => {
    let panel = await review(page, scenario);await ack(page).check();await confirm(page).click();await expect(panel.getByRole('alert')).toContainText('Completion is unconfirmed');
    await page.evaluate(() => window.dispatchEvent(new Event('refresh-repair-list')));panel = page.locator('[data-pack-repair-panel]');
    await panel.getByRole('button', { name: 'Recover repair receipt', exact: true }).click();await expect(panel).toContainText('Local cleanup completed');
    if (scenario === 'lost-reinstalled') await expect(panel).toContainText('A current installation remains');
    const result = await state(page);expect(result.writes).toBe(1);expect(result.applies[1]).toEqual(result.applies[0]);
  });
  test(`retained receipts are discoverable after a page reload at ${width}px`, async ({ page }) => {
    const panel = await review(page, 'lost');await ack(page).check();await confirm(page).click();await expect(panel.getByRole('alert')).toContainText('reply lost');
    await page.reload();const restored = page.locator('[data-pack-repair-panel]');await restored.getByText('Installation health and repair', { exact: true }).click();
    await restored.getByRole('button', { name: 'Inspect local installations', exact: true }).click();await restored.getByRole('button', { name: 'Recover receipt for orphan-fixture' }).click();
    await expect(restored).toContainText('Local cleanup completed');expect((await state(page)).writes).toBe(1);
  });
  test(`expiry holds confirmation at ${width}px`, async ({ page }) => {
    await page.clock.install();const panel = await review(page, 'expiry');await ack(page).check();await page.clock.fastForward(1000);await expect(confirm(page)).toBeDisabled();await expect(panel).toContainText('repair review expired');
  });
  test(`local reconciliation retries the same completed request at ${width}px`, async ({ page }) => {
    const panel = await review(page, 'reconcile');await ack(page).check();await confirm(page).click();await expect(panel).toContainText('reconciliation is pending');
    await panel.getByRole('button', { name: 'Retry local reconciliation' }).click();await expect(panel).not.toContainText('reconciliation is pending');
    const result = await state(page);expect(result.writes).toBe(1);expect(result.applies[1]).toEqual(result.applies[0]);
  });
  test(`inspection errors remain retryable at ${width}px`, async ({ page }) => {
    const panel = await open(page, 'scan-error');await expect(panel.getByRole('alert')).toContainText('inspection unavailable');await panel.getByRole('button', { name: 'Inspect local installations', exact: true }).click();await expect(panel).toContainText('1 local pack identities inspected');
  });
  test(`in-flight repair is guarded and does not steal focus from another control at ${width}px`, async ({ page }) => {
    const panel = await review(page, 'slow');await ack(page).check();await confirm(page).click();await expect(confirm(page)).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event('query-repair-work')));await expect(page.locator('body')).toHaveAttribute('data-busy', 'true');
    await page.locator('#outside').click();await page.evaluate(() => window.dispatchEvent(new Event('finish-repair')));await expect(panel).toContainText('Local cleanup completed');await expect(page.locator('#outside')).toBeFocused();expect((await state(page)).writes).toBe(1);
  });
  test(`keyboard inspection keeps a focusable result after reading at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });await page.goto('/pack-repair-harness.html');
    const panel = page.locator('[data-pack-repair-panel]');await panel.getByText('Installation health and repair', { exact: true }).click();
    const inspect = panel.getByRole('button', { name: 'Inspect local installations', exact: true });await inspect.focus();await inspect.press('Enter');
    await expect(panel).toContainText('1 local pack identities inspected');await expect(panel.locator('[data-pack-repair-status]')).toBeFocused();
  });
  test(`an unavailable history receipt can be replaced with a fresh local review at ${width}px`, async ({ page }) => {
    let panel = await review(page, 'evicted');await ack(page).check();await confirm(page).click();await expect(panel).toContainText('Local cleanup completed');
    await page.reload();panel = page.locator('[data-pack-repair-panel]');await panel.getByText('Installation health and repair', { exact: true }).click();
    await panel.getByRole('button', { name: 'Inspect local installations', exact: true }).click();await panel.getByRole('button', { name: 'Recover receipt for orphan-fixture' }).click();
    await expect(panel.getByRole('alert')).toContainText('no longer retained');await panel.getByRole('button', { name: 'Review current state again', exact: true }).click();
    await expect(panel).toContainText('No supported local cleanup is proven.');await expect(confirm(page)).toBeDisabled();expect((await state(page)).writes).toBe(1);
  });
  test(`receipt recovery reports a later active Records namespace at ${width}px`, async ({ page }) => {
    const panel = await review(page, 'lost-records');await ack(page).check();await confirm(page).click();await expect(panel.getByRole('alert')).toContainText('reply lost');
    await panel.getByRole('button', { name: 'Recover repair receipt', exact: true }).click();await expect(panel).toContainText('A current installation remains');
    expect((await state(page)).writes).toBe(1);
  });

}
