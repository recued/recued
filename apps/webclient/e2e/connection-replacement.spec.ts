import { test, expect, type Page } from '@playwright/test';
const state = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('connection-replacement-fixture')!));
const control = (page: Page, key: string) => page.locator('[data-replacement-focus=' + JSON.stringify(key) + ']');
// Opening the card reads the connections; choosing both reads what uses the first.
const openCard = (page: Page) => page.getByText('Replace a connection', { exact: true }).click();
const open = async (page: Page, width: number, scenario = '') => {
  await page.setViewportSize({ width, height: 900 });await page.goto('/connection-replacement-harness.html?scenario=' + scenario);
  await openCard(page);await expect(control(page, 'from')).toBeEnabled();
};
const select = async (page: Page) => {
  await control(page, 'from').selectOption('old-account');await control(page, 'to').selectOption('new-account');
  await control(page, 'pack:' + JSON.stringify(['hubspot', 'hubspot'])).check();await control(page, 'dish:dsh_fixture').check();await control(page, 'review').click();
};
const history = async (page: Page) => { await page.locator('.replacement-history > summary').click(); };
for (const width of [280, 1280]) {
  test(`reviews account identities, shared sign-ins and automation at ${width}px`, async ({ page }) => {
    await open(page, width);await select(page);await expect(page.locator('[data-connection-replacement]')).toContainText('fixture-new-lineage');
    await expect(page.locator('[data-connection-replacement]')).toContainText('2 schedules, 1 trigger, 1 timer affected');
    await expect(control(page, 'confirm')).toBeDisabled();expect((await state(page)).writes).toBe(0);await control(page, 'ack').check();await control(page, 'confirm').click();
    await expect(page.locator('[data-connection-replacement]')).toContainText('Replacement completed');expect((await state(page)).writes).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`holds account-bound settings at ${width}px`, async ({ page }) => {
    await open(page, width, 'blocked');await select(page);await expect(control(page, 'ack')).toBeDisabled();await expect(control(page, 'confirm')).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('account-bound record IDs');expect((await state(page)).writes).toBe(0);
  });
  test(`recovers a lost review using its exact request at ${width}px`, async ({ page }) => {
    await open(page, width, 'lost-review');await select(page);await expect(page.getByRole('alert')).toContainText('Review reply lost');await control(page, 'retry-review').click();
    await control(page, 'ack').check();await control(page, 'confirm').click();expect(Object.keys((await state(page)).reviews)).toHaveLength(1);expect((await state(page)).writes).toBe(1);
  });
  test(`recovers a lost apply reply without repeating effects at ${width}px`, async ({ page }) => {
    await open(page, width, 'lost');await select(page);await control(page, 'ack').check();await control(page, 'confirm').click();await expect(page.getByRole('alert')).toContainText('Completion reply lost');
    await control(page, 'recover').click();await expect(page.locator('[data-connection-replacement]')).toContainText('Replacement completed');const saved = await state(page);expect(saved.writes).toBe(1);expect(saved.applies).toHaveLength(2);expect(saved.applies[1]).toEqual(saved.applies[0]);
  });
  test(`recovers history after reload and offers a separately reviewed rollback at ${width}px`, async ({ page }) => {
    await open(page, width);await select(page);await control(page, 'ack').check();await control(page, 'confirm').click();await expect(page.locator('[data-connection-replacement]')).toContainText('Replacement completed');
    await page.reload();await openCard(page);await history(page);
    await page.getByRole('button', { name: 'Show result of Old team → New team replacement', exact: true }).click();await expect(page.locator('[data-connection-replacement]')).toContainText('Replacement completed');
    await control(page, 'undo').click();await expect(page.locator('.replacement-step-title')).toContainText(['Review the undo']);await expect(control(page, 'ack')).not.toBeChecked();await expect(control(page, 'confirm')).toBeDisabled();
    expect((await state(page)).writes).toBe(1);await control(page, 'ack').check();await control(page, 'confirm').click();await expect(page.locator('[data-connection-replacement]')).toContainText('Undo completed');expect((await state(page)).writes).toBe(2);
  });
  test(`drift requires fresh evidence and acknowledgement at ${width}px`, async ({ page }) => {
    await open(page, width, 'drift');await select(page);await control(page, 'ack').check();await control(page, 'confirm').click();await expect(page.getByRole('alert')).toContainText('References changed');
    expect((await state(page)).writes).toBe(0);await control(page, 'fresh').click();await control(page, 'pack:' + JSON.stringify(['hubspot', 'hubspot'])).check();await control(page, 'dish:dsh_fixture').check();await control(page, 'review').click();await expect(control(page, 'ack')).not.toBeChecked();
    await control(page, 'ack').check();await control(page, 'confirm').click();expect((await state(page)).writes).toBe(1);
  });
  test(`expiry disables confirmation at ${width}px`, async ({ page }) => {
    await open(page, width, 'expiry');await select(page);await control(page, 'ack').check();await expect(control(page, 'confirm')).toBeDisabled({ timeout: 3000 });expect((await state(page)).writes).toBe(0);
  });
  test(`route work guards and keyboard focus survive pending apply at ${width}px`, async ({ page }) => {
    await open(page, width, 'slow');await select(page);await control(page, 'ack').check();await control(page, 'confirm').focus();await page.keyboard.press('Enter');
    await page.evaluate(() => dispatchEvent(new Event('query-replacement-work')));await expect(page.locator('body')).toHaveAttribute('data-busy', 'true');await expect(control(page, 'status')).toBeFocused();
    await page.evaluate(() => dispatchEvent(new Event('finish-replacement')));await expect(page.locator('[data-connection-replacement]')).toContainText('Replacement completed');await expect(control(page, 'status')).toBeFocused();
  });
  test(`asynchronous completion respects outside focus at ${width}px`, async ({ page }) => {
    await open(page, width, 'slow');await select(page);await control(page, 'ack').check();await control(page, 'confirm').click();await page.locator('#outside').focus();
    await page.evaluate(() => dispatchEvent(new Event('finish-replacement')));await expect(page.locator('[data-connection-replacement]')).toContainText('Replacement completed');await expect(page.locator('#outside')).toBeFocused();
  });
  test(`inspection errors are retryable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });await page.goto('/connection-replacement-harness.html?scenario=inspect-error');await openCard(page);
    await expect(page.getByRole('alert')).toContainText('Inspection unavailable');await control(page, 'inspect').click();await select(page);await expect(control(page, 'confirm')).toBeDisabled();
  });
  test(`evicted receipt recovery can start a fresh inspection at ${width}px`, async ({ page }) => {
    await open(page, width, 'evicted');await select(page);await control(page, 'ack').check();await control(page, 'confirm').click();await page.reload();await openCard(page);await history(page);
    await page.getByRole('button', { name: 'Show result of Old team → New team replacement', exact: true }).click();await expect(page.getByRole('alert')).toContainText('retained receipt is unavailable');
    await control(page, 'fresh').click();await expect(control(page, 'from')).toBeEnabled();expect((await state(page)).writes).toBe(1);
  });
  test(`reconciliation retries use the completed attempt at ${width}px`, async ({ page }) => {
    await open(page, width, 'reconcile');await select(page);await control(page, 'ack').check();await control(page, 'confirm').click();await control(page, 'reconcile').click();
    await expect(control(page, 'reconcile')).toHaveCount(0);const saved = await state(page);expect(saved.writes).toBe(1);expect(saved.applies[1]).toEqual(saved.applies[0]);
  });
  test(`receipt completion survives unavailable current evidence at ${width}px`, async ({ page }) => {
    await open(page, width, 'current-unavailable');await select(page);await control(page, 'ack').check();await control(page, 'confirm').click();await expect(page.locator('[data-connection-replacement]')).toContainText('Recued could not read your connections again');expect((await state(page)).writes).toBe(1);
  });
}
