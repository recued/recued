import { expect, test, type Page } from '@playwright/test';
import { OPENER_RELAY_MESSAGE_KIND } from '@recued/contracts';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { installConnectionsUxFixture } from './fixtures/connections-ux.js';
import { installConnectionsAccountsFixture } from './fixtures/connections-accounts.js';

const errors = new WeakMap<Page, Error[]>();
const activate = async (button: ReturnType<Page['locator']>) => { await button.focus(); await button.press('Enter'); };
test.beforeEach(async ({ page }) => {
  const failures: Error[] = []; errors.set(page, failures);
  page.on('pageerror', error => failures.push(error));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(installConnectionsUxFixture);
  await page.goto(HARNESS_ORIGIN + '/full-app-harness.html?settle_reads=1&oauth=ready&connection=webhooks#chat');
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(installConnectionsAccountsFixture, { relayKind: OPENER_RELAY_MESSAGE_KIND });
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page) ?? []).toEqual([]);
});

test('saved-app switching reviews every shared collection before one explicit apply', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#connections/mail/work'));
  await activate(page.getByRole('button', { name: 'Manage authentication', exact: true }));
  const choice = page.locator('.auth-management [data-choice="app"]');
  await expect(choice).toBeEnabled(); await activate(choice);
  const panel = page.locator('.accounts-oauth-app-switch');
  const select = panel.locator('[data-oauth-app-switch-choice]');
  await select.selectOption('app-' + '1'.repeat(32));
  await expect(select).toBeFocused();
  await expect(panel).toContainText('mail work');
  await expect(panel).toContainText('calendar work');
  await expect(panel).toContainText('Keep selection: INBOX');
  await expect(panel).toContainText('Keep selection: Team calendar');
  await expect(panel.locator('[data-oauth-app-switch-action="apply"]')).toHaveCount(0);
  await activate(panel.locator('[data-oauth-app-switch-action="authorize"]'));
  await page.waitForFunction(() => window.__connectionsAccounts.popupUrl().startsWith('https:'));
  await page.evaluate(() => window.__connectionsAccounts.finishOAuth());
  await expect(panel).toContainText('Same vendor account verified for every affected collection');
  expect(await page.evaluate(() => window.__connectionsAccounts.requests.filter(item => item.action === 'collection_authentication_app_apply').length)).toBe(0);
  await page.evaluate(() => window.__connectionsAccounts.hold());
  await activate(panel.locator('[data-oauth-app-switch-action="apply"]'));
  await expect(panel.locator('[data-oauth-app-switch-action="close"]')).toBeDisabled();
  await expect(panel.locator('[data-oauth-app-switch-action="status"]')).toBeDisabled();
  await page.evaluate(() => window.__connectionsAccounts.release());
  await expect(panel.getByRole('status')).toContainText('OAuth app switched.');
  await expect(panel.getByRole('status')).toContainText('collection names, selections and sync state were kept');
  expect(await page.evaluate(() => window.__connectionsAccounts.requests.filter(item => item.action === 'collection_authentication_app_apply').length)).toBe(1);
  await expect(panel.locator('[data-oauth-app-switch-action="close"]')).toBeEnabled();
});

test('credential replacement stays pending until verification and clears the secret after save', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#connections/others'));
  const row = page.locator('.connections-row[data-conn-key="api/rotation-key"]');
  await activate(row.getByRole('button', { name: 'Edit', exact: true }));
  const dialog = page.locator('.connections-dialog');
  await dialog.locator('[data-conn-field="auth.token"]').fill('fixture-replacement-token');
  await page.evaluate(() => window.__connectionsAccounts.hold());
  await activate(dialog.locator('[data-action="connections-submit-form"]'));
  await expect(dialog.locator('[data-action="connections-submit-form"]')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await expect(dialog.locator('[data-credential-rotation]')).toContainText('Verifying replacement credentials');
  expect(await page.evaluate(() => window.__connectionsAccounts.requests.filter(item => item.method === 'collection.connection.rotateCredentials').length)).toBe(1);
  await page.evaluate(() => window.__connectionsAccounts.release());
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(1);
  await activate(row.getByRole('button', { name: 'Edit', exact: true }));
  await expect(dialog.locator('[data-conn-field="auth.token"]')).toHaveValue('');
  await expect(dialog.locator('[data-credential-rotation]')).toContainText('Current credentials stay active');
  expect(await page.evaluate(() => window.__connectionsAccounts.requests.filter(item => item.method === 'collection.connection.rotateCredentials').length)).toBe(1);
});
