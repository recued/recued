import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { ATOMIC_SOURCE, ATOMIC_SET, ATOMIC_UNDO } from './harness/local-change-sets.js';
installFullAppHooks();
for (const width of [280,1280]) {
  test(`a pending run becomes an atomic review without approval at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 850 });
    await page.goto(HARNESS_URL + `?preapproval=1&local_changes=1#approvals/preapproval/${ATOMIC_SOURCE}`);
    const prepare = page.getByRole('button',{ name: 'Review as one atomic change set',exact: true });
    await prepare.focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(ATOMIC_SET + '$'));
    const host = page.locator('[data-local-change-sets-route]');
    await expect(host).toContainText('Original assistant');
    await expect(host).toContainText('Original note'); await expect(host).toContainText('Original meeting');
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
    await host.getByRole('button',{ name: 'Approve changes together',exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(host).toContainText('All 2 local changes are confirmed.');
    await expect(host.locator('[data-local-change-receipts]')).toContainText('lmr_30000000');
    await expect(host.getByRole('status')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`grouped undo needs a separate explicit decision at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 850 });
    await page.goto(HARNESS_URL + `?local_changes=direct#approvals/local-changes/${ATOMIC_SET}`);
    const host = page.locator('[data-local-change-sets-route]');
    await host.getByRole('button',{ name: 'Approve changes together',exact: true }).click();
    await host.getByRole('button',{ name: 'Review undo together',exact: true }).click();
    await expect(page).toHaveURL(new RegExp(ATOMIC_UNDO + '$'));
    await expect(host).toContainText('Undo local change set'); await expect(host).toContainText('Original note');
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(1);
    await host.getByRole('button',{ name: 'Approve undo together',exact: true }).click();
    await expect(host).toContainText('All 2 local changes are confirmed.');
    await expect(host.locator('[data-local-change-receipts]')).toContainText('lmr_40000000');
    await page.reload(); await expect(host).toContainText('All 2 local changes are confirmed.');
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(0);
  });
  test(`a lost response recovers by reading after reload at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 850 });
    await page.goto(HARNESS_URL + `?local_changes=direct&atomic=lost#approvals/local-changes/${ATOMIC_SET}`);
    const host = page.locator('[data-local-change-sets-route]');
    await host.getByRole('button',{ name: 'Approve changes together',exact: true }).click();
    await expect(host).toContainText('The decision response was lost.');
    await host.getByRole('button',{ name: 'Check result',exact: true }).click();
    await expect(host).toContainText('All 2 local changes are confirmed.');
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(1);
    await page.reload(); await expect(host).toContainText('All 2 local changes are confirmed.');
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(0);
  });
  test(`declining preserves the unchanged set at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 850 });
    await page.goto(HARNESS_URL + `?local_changes=direct#approvals/local-changes/${ATOMIC_SET}`);
    const host = page.locator('[data-local-change-sets-route]');
    await host.getByRole('button',{ name: 'Decline changes',exact: true }).click();
    await expect(host).toContainText('Local changes declined. Nothing was applied.');
    await expect(host.locator('[data-local-change-receipts]')).toHaveCount(0);
  });
  test(`a late conflict has no partial confirmation at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 850 });
    await page.goto(HARNESS_URL + `?local_changes=direct&atomic=conflict#approvals/local-changes/${ATOMIC_SET}`);
    const host = page.locator('[data-local-change-sets-route]');
    await host.getByRole('button',{ name: 'Approve changes together',exact: true }).click();
    await expect(host).toContainText('The entire transaction rolled back.');
    await host.getByRole('button',{ name: 'Check result',exact: true }).click();
    await expect(host).toContainText('The change set failed.'); await expect(host.locator('[data-local-change-receipts]')).toHaveCount(0);
  });
  test(`an unknown outcome never resends the decision at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 850 });
    await page.goto(HARNESS_URL + `?local_changes=direct&atomic=unknown#approvals/local-changes/${ATOMIC_SET}`);
    const host = page.locator('[data-local-change-sets-route]');
    await host.getByRole('button',{ name: 'Approve changes together',exact: true }).click();
    await expect(host).toContainText('The outcome is unknown.');
    await host.getByRole('button',{ name: 'Check result',exact: true }).click();
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(1);
    await expect(host.getByRole('button',{ name: 'Approve changes together',exact: true })).toHaveCount(0);
  });
  test(`an undelivered decision needs another human action at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 850 });
    await page.goto(HARNESS_URL + `?local_changes=direct&atomic=not_received#approvals/local-changes/${ATOMIC_SET}`);
    const host = page.locator('[data-local-change-sets-route]');
    await host.getByRole('button',{ name: 'Approve changes together',exact: true }).click();
    await expect(host).toContainText('The decision request was not delivered.');
    await host.getByRole('button',{ name: 'Check result',exact: true }).click();
    await expect(host).toContainText('No decision has been recorded.');
    await expect(host.getByRole('button',{ name: 'Approve changes together',exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(1);
  });
  test(`expired reviews cannot approve at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 850 });
    await page.goto(HARNESS_URL + `?local_changes=direct&atomic=expired#approvals/local-changes/${ATOMIC_SET}`);
    const host = page.locator('[data-local-change-sets-route]');
    await expect(host).toContainText('This review expired.');
    await expect(host.getByRole('button',{ name: 'Approve changes together',exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(0);
  });
}
