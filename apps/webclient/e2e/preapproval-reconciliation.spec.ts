import { test, expect, type Page } from '@playwright/test';
const open = async (page: Page, width: number, scenario = '') => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/preapproval-reconciliation-harness.html?preapproval=continuation-uncertain&scenario=' + scenario);
};
const state = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('provider-proof-fixture')!));
for (const width of [280, 1280]) {
  test(`does not offer verification when the server has no supported proof at ${width}px`, async ({ page }) => {
    await open(page, width, 'legacy');await expect(page.getByText('Reviewed email: in doubt', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verify mail outcome' })).toHaveCount(0);
    expect((await state(page)).calls.map((item: { method: string }) => item.method)).toEqual(['preapproval.get']);
  });
  test(`verifies mail without approving or resuming work at ${width}px`, async ({ page }) => {
    await open(page, width);await page.getByRole('button', { name: 'Verify mail outcome' }).click();
    await expect(page.getByText('The original mail attempt is verified as sent.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Prepare continuation review' })).toBeVisible();
    const calls = (await state(page)).calls;expect(calls.map((item: { method: string }) => item.method)).toEqual(['preapproval.get', 'preapproval.reconcile', 'preapproval.get']);
    expect(Object.keys(calls[1].args).sort()).toEqual(['member_id', 'proposal_id']);
    await expect(page.locator('[data-preapproval-verify-status]')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  for (const scenario of ['missing', 'ambiguous']) test(`retains ${scenario} uncertainty at ${width}px`, async ({ page }) => {
    await open(page, width, scenario);await page.getByRole('button', { name: 'Verify mail outcome' }).click();
    await expect(page.locator('[data-preapproval-verify-status]')).toContainText('remains uncertain');
    await expect(page.getByRole('button', { name: 'Prepare continuation review' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Verify mail outcome' })).toBeEnabled();
  });
  test(`recovers a lost verification reply after refresh and reload at ${width}px`, async ({ page }) => {
    await open(page, width, 'lost');await page.getByRole('button', { name: 'Verify mail outcome' }).click();
    await expect(page.getByRole('alert')).toContainText('Verification reply lost');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Verify mail outcome' })).toHaveCount(0);
    await page.reload();await expect(page.getByRole('button', { name: 'Prepare continuation review' })).toBeVisible();
    expect((await state(page)).calls.filter((item: { method: string }) => item.method === 'preapproval.reconcile')).toHaveLength(1);
  });
  test(`retries an unavailable check without dispatching mail at ${width}px`, async ({ page }) => {
    await open(page, width, 'error');await page.getByRole('button', { name: 'Verify mail outcome' }).click();
    await expect(page.getByRole('alert')).toContainText('Provider check unavailable');await page.getByRole('button', { name: 'Verify mail outcome' }).click();
    await expect(page.getByText('The original mail attempt is verified as sent.')).toBeVisible();
    expect((await state(page)).calls.filter((item: { method: string }) => !['preapproval.get', 'preapproval.reconcile'].includes(item.method))).toHaveLength(0);
  });
  test(`shows current progress while retrying an unknown check at ${width}px`, async ({ page }) => {
    await open(page, width, 'retry-slow');await page.getByRole('button', { name: 'Verify mail outcome' }).click();
    await expect(page.locator('[data-preapproval-verify-status]')).toContainText('remains uncertain');
    await page.getByRole('button', { name: 'Verify mail outcome' }).click();
    await expect(page.locator('[data-preapproval-verify-status]')).toHaveText('Checking the original attempt…');
    await page.evaluate(() => dispatchEvent(new Event('finish-proof')));
    await expect(page.locator('[data-preapproval-verify-status]')).toHaveText('The original mail attempt is verified as sent.');
  });
  test(`guards pending verification and preserves outside focus at ${width}px`, async ({ page }) => {
    await open(page, width, 'slow');await page.getByRole('button', { name: 'Verify mail outcome' }).click();
    await page.evaluate(() => dispatchEvent(new Event('query-proof-work')));await expect(page.locator('body')).toHaveAttribute('data-busy', 'true');
    await expect(page.getByRole('button', { name: 'Verify mail outcome' })).toBeDisabled();await page.locator('#outside').focus();
    await page.evaluate(() => dispatchEvent(new Event('finish-proof')));await expect(page.getByText('The original mail attempt is verified as sent.')).toBeVisible();
    await expect(page.locator('#outside')).toBeFocused();
  });
}
