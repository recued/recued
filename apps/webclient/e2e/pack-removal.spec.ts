import { expect,test,type Page } from '@playwright/test';
const state = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-removal-fixture')!));
const confirm = (page: Page) => page.locator('[data-recued-packs-row-delete-confirm="removal-fixture"]');
for (const width of [280,1280]) {
  const open = async (page: Page,scenario = '') => {
    await page.setViewportSize({ width,height: 900 });await page.goto('/pack-removal-harness.html?scenario='+scenario);
    if (['missing-manifest','withdrawn','lost-refresh-withdrawn'].includes(scenario)) await expect(page.getByRole('alert')).toContainText('Catalog unavailable');
    await page.locator('[data-recued-packs-row-delete="removal-fixture"]').click();
    return page.locator('[data-pack-removal-review]');
  };
  test(`reviewed removal shows dependencies and shared resources before one explicit deletion at ${width}px`,async ({ page }) => {
    const panel = await open(page);await expect(panel).toContainText('Also removes 2 schedules');await expect(confirm(page)).toBeDisabled();
    await panel.getByText('Dependency packs that stay installed (1)',{ exact: true }).click();await expect(panel).toContainText('shared-provider');
    await panel.getByText('Shared ingredients that stay installed (1)',{ exact: true }).click();await expect(panel).toContainText('shared-catalog');
    expect((await state(page)).writes).toBe(0);await panel.locator('[data-pack-removal-ack]').check();await confirm(page).click();
    await expect(page.locator('[data-pack-removal-completed]')).toContainText('Removal completed');expect((await state(page)).writes).toBe(1);expect((await state(page)).legacy_calls).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`known dependants hold deletion even after acknowledgement at ${width}px`,async ({ page }) => {
    const panel = await open(page,'blocked');await expect(panel.getByRole('alert')).toContainText('dependent packs first');
    await panel.locator('[data-pack-removal-ack]').check();await expect(confirm(page)).toBeDisabled();expect((await state(page)).apply_calls).toBe(0);
  });
  test(`unknown dependencies require their own acknowledgement at ${width}px`,async ({ page }) => {
    const panel = await open(page,'unknown');await panel.locator('[data-pack-removal-ack]').check();await expect(confirm(page)).toBeDisabled();
    await panel.locator('[data-pack-removal-unknown]').check();await expect(confirm(page)).toBeEnabled();await confirm(page).click();await expect(page.locator('[data-pack-removal-completed]')).toBeVisible();
  });
  test(`a stale removal requires a fresh review and acknowledgement at ${width}px`,async ({ page }) => {
    const panel = await open(page,'drift');await panel.locator('[data-pack-removal-ack]').check();await confirm(page).click();await expect(panel.getByRole('alert')).toContainText('changed');
    expect((await state(page)).writes).toBe(0);await panel.getByRole('button',{ name: 'Review current installation',exact: true }).click();
    await expect(panel.locator('[data-pack-removal-ack]')).not.toBeChecked();await expect(confirm(page)).toBeDisabled();
    await panel.locator('[data-pack-removal-ack]').check();await confirm(page).click();await expect(page.locator('[data-pack-removal-completed]')).toBeVisible();expect((await state(page)).writes).toBe(1);
  });
  test(`a lost completion survives close and recovers the same receipt without another deletion at ${width}px`,async ({ page }) => {
    let panel = await open(page,'lost');await panel.locator('[data-pack-removal-ack]').check();await confirm(page).click();await expect(panel.getByRole('alert')).toContainText('reply lost');
    await page.locator('[data-recued-packs-row-delete-cancel]').click();await page.locator('[data-recued-packs-row-delete="removal-fixture"]').click();panel = page.locator('[data-pack-removal-review]');
    await panel.getByRole('button',{ name: 'Recover removal receipt',exact: true }).click();await expect(page.locator('[data-pack-removal-completed]')).toBeVisible();
    const result = await state(page);expect(result.writes).toBe(1);expect(result.apply_requests[1]).toEqual(result.apply_requests[0]);
  });
  test(`a lost read retries its stable review identity at ${width}px`,async ({ page }) => {
    const panel = await open(page,'lost-review');await expect(panel.getByRole('alert')).toContainText('reply lost');
    await panel.getByRole('button',{ name: 'Retry loading removal review',exact: true }).click();await panel.locator('[data-pack-removal-ack]').check();
    expect(Object.keys((await state(page)).requests)).toHaveLength(1);await confirm(page).click();await expect(page.locator('[data-pack-removal-completed]')).toBeVisible();
  });
  test(`an expired review holds deletion at ${width}px`,async ({ page }) => {
    await page.clock.install();const panel = await open(page,'expiry');await panel.locator('[data-pack-removal-ack]').check();
    await page.clock.fastForward(1000);await expect(confirm(page)).toBeDisabled();await expect(panel.locator('[data-pack-removal-status]')).toContainText('expired');expect((await state(page)).writes).toBe(0);
  });
  test(`an unconfirmed prior attempt requires inspection before a new deletion at ${width}px`,async ({ page }) => {
    const panel = await open(page,'unconfirmed');await panel.locator('[data-pack-removal-ack]').check();await expect(confirm(page)).toBeDisabled();
    await panel.locator('[data-pack-removal-incomplete]').check();await confirm(page).click();await expect(page.locator('[data-pack-removal-completed]')).toBeVisible();
  });
  test(`in-flight removal holds cancel and another confirmation at ${width}px`,async ({ page }) => {
    const panel = await open(page,'slow');await panel.locator('[data-pack-removal-ack]').check();await confirm(page).click();
    await expect(confirm(page)).toHaveAttribute('aria-disabled','true');await expect(page.locator('[data-recued-packs-row-delete-cancel]')).toHaveAttribute('aria-disabled','true');
    await page.locator('[data-recued-packs-row-delete-cancel]').click({ force: true });await expect(panel).toBeVisible();await confirm(page).click({ force: true });
    await page.evaluate(() => window.dispatchEvent(new Event('finish-removal')));
    await expect(page.locator('[data-pack-removal-completed]')).toBeVisible();expect((await state(page)).writes).toBe(1);expect((await state(page)).apply_calls).toBe(1);
  });
  test(`partial cleanup stays inspectable without repeating the failed request at ${width}px`,async ({ page }) => {
    const panel = await open(page,'partial');await panel.locator('[data-pack-removal-ack]').check();await confirm(page).click();
    await expect(panel.locator('[data-pack-removal-status]')).toContainText('remaining installation');await expect(confirm(page)).toBeDisabled();expect((await state(page)).writes).toBe(1);
  });
  test(`closing and reopening requires fresh acknowledgement at ${width}px`,async ({ page }) => {
    let panel = await open(page);await panel.locator('[data-pack-removal-ack]').check();await page.locator('[data-recued-packs-row-delete-cancel]').click();
    await page.locator('[data-recued-packs-row-delete="removal-fixture"]').click();panel = page.locator('[data-pack-removal-review]');
    await expect(panel.locator('[data-pack-removal-ack]')).not.toBeChecked();await expect(confirm(page)).toBeDisabled();
  });
  for (const scenario of ['missing-manifest','withdrawn','older']) test(`local removal remains available for ${scenario} packs at ${width}px`,async ({ page }) => {
    const panel = await open(page,scenario);await panel.locator('[data-pack-removal-ack]').check();await confirm(page).click();await expect(page.locator('[data-pack-removal-completed]')).toBeVisible();
    expect((await state(page)).writes).toBe(1);expect((await state(page)).legacy_calls).toBe(0);
  });
  test(`an unavailable review holds the destructive action at ${width}px`,async ({ page }) => {
    const panel = await open(page,'unavailable');await expect(panel.getByRole('alert')).toContainText('unavailable');await expect(confirm(page)).toBeDisabled();expect((await state(page)).legacy_calls).toBe(0);
  });
  test(`keyboard acknowledgement keeps focus and reaches the reviewed confirmation at ${width}px`,async ({ page }) => {
    const panel = await open(page);await expect(panel.locator('[data-pack-removal-status]')).toBeFocused();
    const ack = panel.locator('[data-pack-removal-ack]');await ack.focus();await page.keyboard.press('Space');await expect(ack).toBeFocused();
    await page.keyboard.press('Tab');await expect(confirm(page)).toBeFocused();await page.keyboard.press('Enter');
    await expect(page.locator('[data-pack-removal-completed]')).toBeVisible();expect((await state(page)).writes).toBe(1);
  });
  test(`same-name installs require choosing an installed publisher at ${width}px`,async ({ page }) => {
    const panel = await open(page,'publishers');await panel.locator('[data-pack-removal-ack]').check();await expect(confirm(page)).toBeDisabled();
    await panel.locator('[data-pack-removal-publisher]').selectOption('publisher-two');await expect(panel).toContainText('publisher-two');
    await expect(panel.locator('[data-pack-removal-ack]')).not.toBeChecked();await panel.locator('[data-pack-removal-ack]').check();await confirm(page).click();
    await expect(page.locator('[data-pack-removal-completed]')).toBeVisible();expect((await state(page)).writes).toBe(1);
  });
  test(`recovering an older receipt keeps a later installation and reports it at ${width}px`,async ({ page }) => {
    const panel = await open(page,'lost-reinstalled');await panel.locator('[data-pack-removal-ack]').check();await confirm(page).click();
    await expect(panel.getByRole('alert')).toContainText('reply lost');await panel.getByRole('button',{ name: 'Recover removal receipt',exact: true }).click();
    await expect(page.locator('[data-pack-removal-completed]')).toContainText('current installation remains');expect((await state(page)).writes).toBe(1);expect((await state(page)).installed).toBe(true);
  });
  for (const scenario of ['lost-refresh','lost-refresh-withdrawn']) test(`receipt recovery survives an inventory refresh for ${scenario} at ${width}px`,async ({ page }) => {
    let panel = await open(page,scenario);await panel.locator('[data-pack-removal-ack]').check();await confirm(page).click();
    await expect(panel.getByRole('alert')).toContainText('reply lost');
    await page.evaluate(() => window.dispatchEvent(new Event('refresh-removal-list')));
    await expect(panel.getByRole('button',{ name: 'Recover removal receipt',exact: true })).toBeVisible();
    await page.locator('[data-recued-packs-row-delete-cancel]').click();
    const recover = page.locator('[data-recued-packs-row-delete="removal-fixture"]');await expect(recover).toHaveText('Recover removal receipt');await recover.click();
    panel = page.locator('[data-pack-removal-review]');await panel.getByRole('button',{ name: 'Recover removal receipt',exact: true }).click();
    await expect(page.locator('[data-pack-removal-completed]')).toContainText('Removal completed');
    const result = await state(page);expect(result.writes).toBe(1);expect(result.apply_requests[1]).toEqual(result.apply_requests[0]);
  });
}
