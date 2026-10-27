import { expect, test, type Page } from '@playwright/test';

const open = async (page: Page, scenario = '', refreshDraft = false) => {
  await page.goto(`/yours-writer-setup-harness.html${scenario ? `?scenario=${scenario}` : ''}`);
  await page.getByRole('button', { name: 'Automatic updates', exact: true }).click();
  await page.getByLabel('Home Assistant connection', { exact: true }).selectOption('house');
  await page.getByLabel('Device or sensor', { exact: true }).selectOption('sensor.hall_alarm_battery');
  await page.getByLabel('Unavailable', { exact: true }).uncheck();
  if (refreshDraft) {
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await expect(page.getByLabel('Device or sensor', { exact: true })).toHaveValue('sensor.hall_alarm_battery', { timeout: 5000 });
    await expect(page.getByLabel('Battery', { exact: true })).toBeChecked();
    await expect(page.getByLabel('Unavailable', { exact: true })).not.toBeChecked();
  }
  await page.getByRole('button', { name: 'Review setup', exact: true }).click();
};
const changes = (page: Page) => page.evaluate(() => window.__writerSetup.state.changes);

test('Yours reviews the source and field scope before creating updates, then controls the same automation', async ({ page }) => {
  await open(page, '', true);
  await expect(page.locator('[data-writer-review]')).toContainText('84%');
  expect(await changes(page)).toEqual([]);
  await page.getByRole('button', { name: 'Approve and start updates', exact: true }).click();
  const status = page.locator('[data-writer-setup]');
  await expect(status).toContainText('Scheduled');
  await expect(status).toContainText('Kept your manual entry');
  await expect(status).toContainText('Last accepted:');
  const submitted = (await changes(page))[0]!;
  expect(submitted.action).toBe('configure');
  if (submitted.action !== 'configure') throw new Error('Expected explicit configuration approval');
  expect(submitted.review.selection.fields).toEqual(['readings.battery']);
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(status).toContainText('Paused');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(status).toContainText('Scheduled');
  expect((await changes(page)).map(input => input.action)).toEqual(['configure', 'run', 'pause', 'resume']);
  expect(await page.evaluate(() => window.__writerSetup.state.writes)).toBe(1);
});

test('a lost approval response retains the same request for a safe retry', async ({ page }) => {
  await open(page, 'lost');
  await page.getByRole('button', { name: 'Approve and start updates', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('reply was lost');
  await page.getByRole('button', { name: 'Approve and start updates', exact: true }).click();
  await expect(page.locator('[data-writer-setup]')).toContainText('Scheduled');
  const calls = await changes(page);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(await page.evaluate(() => window.__writerSetup.state.writes)).toBe(1);
});

test('a preview completing after navigation creates no automation or detached review', async ({ page }) => {
  await open(page, 'delayed');
  await page.getByRole('button', { name: 'Leave Yours', exact: true }).click();
  await page.evaluate(() => window.__writerSetup.releasePreview());
  await expect(page.locator('[data-recued-yours]')).toHaveCount(0);
  expect(await changes(page)).toEqual([]);
});

test('a replaced connection can be selected again without reopening Yours or adopting it silently', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Back to source selection', exact: true }).click();
  await page.evaluate(() => window.__writerSetup.replaceConnection());
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByLabel('Home Assistant connection', { exact: true })).toHaveValue('');
  await expect(page.getByRole('alert')).toContainText('connection changed');
  await page.getByLabel('Home Assistant connection', { exact: true }).selectOption('house');
  await page.getByLabel('Device or sensor', { exact: true }).selectOption('sensor.hall_alarm_battery');
  await page.getByRole('button', { name: 'Review setup', exact: true }).click();
  await expect(page.locator('[data-writer-review]')).toContainText('Replacement home');
  expect(await changes(page)).toEqual([]);
});

test('refresh recovers a saved edit after a lost reply and clears the already-saved review', async ({ page }) => {
  await open(page, 'lost-update');
  await page.getByRole('button', { name: 'Approve and start updates', exact: true }).click();
  await expect(page.locator('[data-writer-setup]')).toContainText('Scheduled');
  await page.getByRole('button', { name: 'Review setup', exact: true }).click();
  await page.getByLabel('Check frequency', { exact: true }).selectOption('30');
  await page.locator('form').getByRole('button', { name: 'Review setup', exact: true }).click();
  await page.getByRole('button', { name: 'Approve and start updates', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('reply was lost');
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.locator('[data-writer-review]')).toHaveCount(0);
  await expect(page.locator('[data-writer-setup]')).toContainText('Every 30 minutes');
  expect(await page.evaluate(() => window.__writerSetup.state.writes)).toBe(2);
});
