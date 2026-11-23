import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { expect, test, type Page } from '@playwright/test';
import { installConnectionsUxFixture } from './fixtures/connections-ux.js';
import { clickActionGlyph } from './helpers/action-glyph.js';
import { installOAuthMaintenanceFixture } from './fixtures/oauth-maintenance.js';

const origin = process.env.CONNECTIONS_UX_ORIGIN ?? HARNESS_ORIGIN;
const route = (page: Page) => page.locator('[data-recued-connections-route]');
const go = async (page: Page, hash: string) => {
  await page.goto(origin + '/full-app-harness.html?settle_reads=1&oauth=ready&connection=webhooks' + hash);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const pageErrors = new WeakMap<Page, Error[]>();
test.beforeEach(async ({ page }) => {
  const errors: Error[] = []; pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error));
  await page.addInitScript(installConnectionsUxFixture);
  await page.setViewportSize({ width: 390, height: 844 });
});
test.afterEach(async ({ page }) => {
  const errors = pageErrors.get(page) ?? [];
  expect(errors, errors.map(error => error.message).join(' | ')).toHaveLength(0);
});

test('saved app usage keeps keyboard selection and returns to its app action on close', async ({ page }) => {
  await go(page, '#chat'); await page.evaluate(installOAuthMaintenanceFixture);
  await page.evaluate(() => window.__app.setHash('#connections/others/oauth-apps'));
  const manager = page.locator('[data-saved-oauth-app-manager]');
  await manager.locator('[data-oauth-app-row="google:default"] > details > summary').click();
  const opener = manager.locator('[data-oauth-app-action="usage"][data-oauth-app-id="google:default"]');
  await opener.focus(); await opener.press('Enter');
  const review = manager.getByRole('region', { name: 'Saved app usage and secret rotation' });
  await expect(review.locator('[data-app-usage-heading]')).toBeFocused();
  const north = review.locator('[data-app-usage-copy="reporting-north"]');
  await north.focus(); await north.press('Space');
  await expect(north).not.toBeChecked(); await expect(north).toBeFocused();
  await expect(review.locator('[data-app-usage-copy="reporting-south"]')).not.toBeChecked();
  await north.press('Space'); await expect(north).toBeChecked(); await expect(north).toBeFocused();
  await review.locator('[data-app-usage-secret]').fill('synthetic-unsaved-secret');
  const close = review.getByRole('button', { name: 'Close review', exact: true });
  await close.focus(); await close.press('Enter');
  await expect(review).toHaveCount(0); await expect(opener).toBeFocused();
  await opener.press('Enter'); await expect(review.locator('[data-app-usage-secret]')).toHaveValue('');
  expect(await page.evaluate(() => window.__oauthMaintenance.requests)).not.toContain('rotate_secret');
});

test('a saved app usage read respects focus moved outside the pending review', async ({ page }) => {
  await go(page, '#chat'); await page.evaluate(installOAuthMaintenanceFixture);
  await page.evaluate(() => { window.__oauthMaintenance.holdUsage(); window.__app.setHash('#connections/others/oauth-apps'); });
  const manager = page.locator('[data-saved-oauth-app-manager]');
  await manager.locator('[data-oauth-app-row="google:default"] > details > summary').click();
  await manager.locator('[data-oauth-app-action="usage"][data-oauth-app-id="google:default"]').click();
  const review = manager.getByRole('region', { name: 'Saved app usage and secret rotation' });
  await expect(review.getByRole('status')).toHaveText('Reading local app usage…');
  const outside = route(page).getByRole('searchbox', { name: 'Search connections', exact: true });
  await outside.focus(); await page.evaluate(() => window.__oauthMaintenance.releaseUsage());
  await expect(review.locator('[data-app-usage-copy]')).toHaveCount(3);
  await expect(outside).toBeFocused();
  expect(await page.evaluate(() => window.__oauthMaintenance.requests)).not.toContain('rotate_secret');
});

for (const outsideFocus of [false, true]) for (const [lane, method, retryName, readySelector] of [
  ['mail', 'collection.mail.list', 'Refresh mailboxes', '.accounts-row'],
  ['others', 'collection.connection.list', 'Refresh connections', '.connections-row'],
] as const) test(`${lane} inventory retry ${outsideFocus ? 'respects outside focus' : 'keeps keyboard focus and one read'}`, async ({ page }) => {
    await go(page, '#chat');
    await page.evaluate(method => {
      const hook = window as Window & { __connectionsFixture: (method: string, args: unknown) => Promise<{
        result?: unknown; error?: { code: string; message: string };
      } | undefined> };
      const previous = hook.__connectionsFixture; let failed = false;
      hook.__connectionsFixture = async (name, args) => {
        if (name === method && !failed) { failed = true; return { error: { code: 'UNAVAILABLE', message: 'The connection inventory could not be read.' } }; }
        return previous(name, args);
      };
    }, method);
    await page.evaluate(lane => window.__app.setHash('#connections/' + lane), lane);
    await expect(route(page).getByRole('alert').filter({ hasText: 'The connection inventory could not be read.' })).toBeVisible();
    await expect(route(page).locator(readySelector)).toHaveCount(0);
    const before = await page.evaluate(method => { window.__app.holdRpcResponses?.(method); return window.__app.rpcCallCount(method); }, method);
    const retry = route(page).getByRole('button', { name: retryName, exact: true });
    await expect(retry).toBeVisible();
    await retry.focus(); await retry.press('Enter');
    await expect(retry).toHaveAttribute('aria-disabled', 'true'); await expect(retry).toBeFocused();
    await retry.press('Enter');
    expect(await page.evaluate(method => window.__app.rpcCallCount(method), method)).toBe(before + 1);
    const outside = route(page).getByRole('link', { name: 'Calendar', exact: true });
    if (outsideFocus) await outside.focus();
    await expect.poll(() => page.evaluate(method => window.__app.releaseRpcResponses?.(method), method)).toBe(1);
    await expect(route(page).locator(readySelector).first()).toBeVisible();
    await expect(retry).toHaveCount(0);
    if (outsideFocus) await expect(outside).toBeFocused();
    else await expect(route(page).locator(lane === 'mail' ? '[data-action="accounts-open-detail"]' : '[data-action="connections-open-add"]').first()).toBeFocused();
});

test('refreshing migration results retains keyboard focus and the completed outcome', async ({ page }) => {
  await go(page, '#connections/others');
  const tool = route(page).locator('[data-recued-connections-tool="bulk-migration"]');
  await tool.locator(':scope > summary').click();
  await tool.locator('[data-recued-bulk-authentication]').click();
  const panel = tool.locator('.connections-bulk-migration');
  await panel.locator('[data-bulk-resume]').click();
  await expect(panel).toContainText('Migration: completed. 1 switched, 0 ready.');
  await expect(panel.locator('[data-bulk-action="apply"]')).toBeDisabled();
  const refresh = panel.getByRole('button', { name: 'Refresh results', exact: true });
  await refresh.focus(); await refresh.press('Enter');
  await expect(panel).toContainText('Fixture observation 2');
  await expect(refresh).toBeFocused();
  await expect(panel).toContainText('Migration: completed. 1 switched, 0 ready.');
  await expect(panel).toContainText('Kept saved authentication (HTTP 403)');
  await expect(panel.locator('[data-bulk-action="apply"]')).toBeDisabled();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('connections and Add lead the page while the repair summary and administration stay compact', async ({ page }) => {
  await go(page, '#connections/others');
  const add = route(page).getByRole('button', { name: '+ Add Connection', exact: true }); await expect(add).toBeVisible();
  expect((await add.boundingBox())!.y).toBeLessThan(600);
  await expect(route(page).locator('.reconnect-worklist-disclosure')).not.toHaveAttribute('open', '');
  await expect(route(page).locator('[data-recued-connections-advanced]')).toBeVisible();
  await expect(route(page).locator('[data-recued-connections-tool][open]')).toHaveCount(0);
  expect((await route(page).locator('[data-recued-connections-advanced]').boundingBox())!.y).toBeGreaterThan((await add.boundingBox())!.y);
  await expect(route(page).getByRole('button', { name: 'Manage OAuth brokers', exact: true })).not.toBeVisible();
  await route(page).getByRole('searchbox', { name: 'Search connections' }).fill('no-such-connection');
  await expect(route(page)).toContainText('No connections match these filters.');
  await expect(route(page).getByRole('searchbox')).toBeFocused();
  await route(page).getByRole('searchbox').fill('Work spreadsheets');
  await expect(route(page).locator('.connections-row')).toHaveCount(1);
  await expect(route(page).locator('.connections-row-name')).toHaveText('Work spreadsheets');
});

test('mail broker setup carries its provider and required permissions and returns without losing choices', async ({ page }) => {
  await go(page, '#connections/mail'); await route(page).getByRole('button', { name: '+ Connect mailbox', exact: true }).click();
  await route(page).locator('[data-provider="gmail"]').click();
  await expect(route(page).locator('[data-acct-field="auth_method"]')).toHaveValue('direct');
  await route(page).locator('[data-acct-field="name"]').fill('personal-mail');
  await route(page).locator('[data-acct-field="send_enabled"]').selectOption('true');
  await route(page).locator('[data-acct-field="auth_method"]').selectOption('managed_oauth');
  await route(page).getByRole('button', { name: 'Set up broker connection', exact: true }).click();
  await expect(page).toHaveURL(/#connections\/others\/enroll\/google$/);
  await expect(route(page).locator('[data-conn-field="config.base_url"]')).toHaveValue('https://gmail.googleapis.com');
  await expect(route(page).locator('[data-conn-field="auth.scopes"]')).toHaveValue(/gmail\.readonly/);
  await expect(route(page).locator('[data-conn-field="auth.scopes"]')).toHaveValue(/gmail\.send/);
  await route(page).getByRole('button', { name: 'Return to mailbox setup', exact: true }).click();
  await expect(page).toHaveURL(/#connections\/mail$/);
  await expect(route(page).locator('[data-acct-field="name"]')).toHaveValue('personal-mail');
  await expect(route(page).locator('[data-acct-field="send_enabled"]')).toHaveValue('true');
  await expect(route(page).locator('[data-acct-field="auth_method"]')).toHaveValue('managed_oauth');
});

test('native setup warns before leaving an unfinished form and opens the saved-app manager on purpose', async ({ page }) => {
  await go(page, '#connections/mail'); await route(page).getByRole('button', { name: '+ Connect mailbox', exact: true }).click(); await route(page).locator('[data-provider="gmail"]').click();
  await route(page).locator('[data-acct-field="name"]').fill('personal-mail');
  await route(page).getByRole('button', { name: 'Manage saved apps', exact: true }).click();
  await expect(page).toHaveURL(/#connections\/others\/oauth-apps$/);
  await expect(route(page).getByRole('button', { name: 'Add OAuth app', exact: true })).toBeVisible();
  await route(page).getByRole('button', { name: 'Return to mailbox setup', exact: true }).click();
  await expect(route(page).locator('[data-acct-field="name"]')).toHaveValue('personal-mail');
  const dialog = page.waitForEvent('dialog').then(async prompt => { expect(prompt.message()).toContain('Discard this account setup'); await prompt.dismiss(); });
  await route(page).getByRole('link', { name: 'Calendar', exact: true }).click(); await dialog;
  await expect(route(page).locator('[data-acct-field="name"]')).toHaveValue('personal-mail');
});

for (const provider of ['gcal', 'graph']) test(`calendar ${provider} broker setup retains its name and derives the required service scopes`, async ({ page }) => {
  await go(page, '#connections/calendar'); await route(page).getByRole('button', { name: '+ Connect calendar', exact: true }).click();
  await route(page).locator(`[data-provider="${provider}"]`).click();
  await route(page).locator('[data-acct-field="name"]').fill('personal-calendar');
  await route(page).locator('[data-acct-field="auth_method"]').selectOption('managed_oauth');
  await route(page).locator('[data-acct-field="write_enabled"]').selectOption('false');
  await route(page).getByRole('button', { name: 'Set up broker connection', exact: true }).click();
  await expect(route(page).locator('[data-conn-field="config.base_url"]')).toHaveValue(provider === 'gcal' ? 'https://www.googleapis.com/calendar/v3' : 'https://graph.microsoft.com/v1.0');
  await expect(route(page).locator('[data-conn-field="auth.scopes"]')).toHaveValue(provider === 'gcal' ? 'https://www.googleapis.com/auth/calendar.readonly' : 'Calendars.Read User.Read offline_access');
  await route(page).getByRole('button', { name: 'Return to calendar setup', exact: true }).click();
  await expect(route(page).locator('[data-acct-field="name"]')).toHaveValue('personal-calendar');
  await expect(route(page).locator('[data-acct-field="write_enabled"]')).toHaveValue('false');
});

test('IMAP credentials can fail verification, retry and save while retaining the account', async ({ page }) => {
  await go(page, '#connections/mail/work-imap');
  await route(page).getByRole('button', { name: 'Update credentials', exact: true }).click();
  await expect(route(page).locator('[data-account-password-heading]')).toBeFocused();
  const field = route(page).locator('[data-account-password-field="password"]'); await field.fill('invalid');
  await route(page).getByRole('button', { name: 'Verify and save credentials', exact: true }).click();
  await expect(route(page).getByRole('alert')).toContainText('Saved credentials were kept');
  await expect(field).toHaveValue('invalid'); await field.fill('fixture-new-password');
  await route(page).getByRole('button', { name: 'Verify and save credentials', exact: true }).click();
  await expect(route(page)).toContainText('Credentials verified and saved.'); await expect(field).toHaveValue('');
  await expect(route(page).locator('[data-authentication-repairs-summary]')).toHaveText('Needs attention (1)');
  await expect(route(page).locator('[data-accounts-detail-heading]')).toHaveText('work-imap');
  await route(page).locator('[data-account-password-action="close"]').click();
  await expect(route(page).getByRole('button', { name: 'Update credentials', exact: true })).toBeFocused();
});

test('CalDAV credential repair retains its calendar and hides SMTP fields', async ({ page }) => {
  await go(page, '#connections/calendar/work-caldav'); await route(page).getByRole('button', { name: 'Update credentials', exact: true }).click();
  await expect(route(page).locator('[data-account-password-field="smtp"]')).toHaveCount(0);
  await route(page).locator('[data-account-password-field="password"]').fill('fixture-new-password');
  await route(page).getByRole('button', { name: 'Verify and save credentials', exact: true }).click();
  await expect(route(page)).toContainText('Credentials verified and saved.'); await expect(route(page).locator('[data-accounts-detail-heading]')).toHaveText('work-caldav');
});

test('API authentication is a row action and HTTP errors never look like successful access checks', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await go(page, '#connections/others');
  const row = route(page).locator('[data-conn-key="api/sheets-work"]').first();
  await row.getByRole('button', { name: 'Manage authentication', exact: true }).click();
  await expect(route(page).locator('[data-manage-authentication]')).toBeVisible();
  await expect(route(page).locator('[data-connection-dialog-heading]')).toBeFocused();
  await expect(route(page).locator('[data-connection-dialog-heading]')).toHaveText('Manage authentication for Work spreadsheets');
  expect(await route(page).evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  await expect(route(page)).toContainText('Re-authorize current sign-in');
  await go(page, '#connections/mail'); await go(page, '#connections/others');
  await route(page).locator('[data-action="connections-probe"][data-name="sheets-work"]').click();
  await expect(route(page)).toContainText('Service responded with HTTP 500. Access was not verified.');
  await expect(route(page).locator('[data-action="connections-probe"][data-name="sheets-work"]')).toBeFocused();
});

test('Files lists local and cloud sources with direct browse and authentication actions', async ({ page }) => {
  await go(page, '#connections/file');
  await expect(route(page)).toContainText('documents'); await expect(route(page)).toContainText('Work Drive'); await expect(route(page)).toContainText('Archive bucket');
  await expect(route(page).getByRole('link', { name: 'Browse files', exact: true }).first()).toHaveAttribute('href', '#data/files/remote%3Adrive-work');
  await expect(route(page).getByRole('link', { name: 'Manage authentication', exact: true }).first()).toHaveAttribute('href', '#connections/others/switch-file-authentication/api/drive-work');
  await expect(route(page).getByRole('link', { name: 'Manage authentication', exact: true }).last()).toHaveAttribute('href', '#connections/others/review-access/api/s3-archive');
  await route(page).locator('.accounts-cloud-connect>summary').click();
  await expect(route(page).getByRole('link', { name: 'Amazon S3', exact: true })).toHaveAttribute('href', '#connections/others/enroll/s3');
  await route(page).getByRole('searchbox').fill('Work Drive'); await expect(route(page).locator('.accounts-row')).toHaveCount(1);
  await expect(route(page).getByRole('searchbox')).toBeFocused();
});

test('saving a connection retains the HTTP result of its follow-up check', async ({ page }) => {
  await go(page, '#connections/others'); await route(page).getByRole('button', { name: '+ Add Connection', exact: true }).click();
  await route(page).locator('[data-action="connections-pick-kind"][data-kind="api"]').click();
  await route(page).locator('[data-conn-field="name"]').fill('example-api');
  await route(page).locator('[data-conn-field="display_name"]').fill('Example service');
  await route(page).locator('[data-conn-field="config.base_url"]').fill('https://api.example.test');
  await route(page).locator('[data-conn-field="auth.token"]').fill('fixture-api-token');
  await clickActionGlyph(page, route(page).getByRole('button', { name: 'Save and test', exact: true }));
  await expect(route(page)).toContainText('Service responded with HTTP 500. Access was not verified.');
  await expect(route(page).locator('.connections-row-name')).toContainText(['Example service']);
});

test('saved app and API editor transitions retain keyboard focus', async ({ page }) => {
  await go(page, '#connections/others/oauth-apps'); await expect(route(page).getByRole('button', { name: 'Add OAuth app', exact: true })).toBeInViewport();
  await route(page).getByRole('button', { name: 'Add OAuth app', exact: true }).click();
  const issuer = route(page).locator('[data-oauth-app-field="issuer"]'); await issuer.focus(); await issuer.selectOption('microsoft'); await expect(issuer).toBeFocused();
  await route(page).locator('[data-oauth-app-action="cancel-edit"]').click(); await expect(route(page).getByRole('button', { name: 'Add OAuth app', exact: true })).toBeFocused();
  await route(page).getByRole('button', { name: '+ Add Connection', exact: true }).click(); await expect(route(page).locator('[data-connection-dialog-heading]')).toBeFocused();
  await route(page).locator('[data-action="connections-pick-kind"][data-kind="api"]').click(); await expect(route(page).locator('[data-connection-dialog-heading]')).toBeFocused();
  await expect(route(page).locator('[data-action="connections-choose-auth"][data-auth-type="oauth2_refresh"]')).toContainText('Recued direct OAuth');
  await route(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  const edit = route(page).locator('.connections-row[data-conn-key="api/sheets-work"]')
    .getByRole('button', { name: 'Edit', exact: true });
  await clickActionGlyph(page, edit);
  await expect(route(page).locator('[data-connection-dialog-heading]')).toBeFocused();
  await expect(route(page).locator('[data-conn-field="name"]')).toHaveValue('sheets-work');
  await route(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(route(page).locator('[data-connection-dialog-heading]')).toHaveCount(0);
  await edit.focus();
  await page.keyboard.press('Enter');
  await expect(route(page).locator('[data-connection-dialog-heading]')).toBeFocused();
  await route(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(edit).toBeFocused();
});

test('cloud sources remain usable when the independent local-folder inventory fails', async ({ page }) => {
  await page.goto(origin + '/full-app-harness.html?settle_reads=1&oauth=ready&local_files=failed#connections/file');
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(route(page)).toContainText('Local folders could not be loaded.');
  await expect(route(page)).toContainText('Work Drive');
  await expect(route(page).getByRole('link', { name: 'Browse files', exact: true }).first()).toBeVisible();
  await expect(route(page)).not.toContainText('Add your first file source');
});

test('webhook configuration stays secondary and New webhook fits a narrow header', async ({ page }) => {
  await go(page, '#connections/webhooks');
  const button = route(page).getByRole('button', { name: 'New webhook', exact: true }); await expect(button).toBeVisible();
  const box = (await button.boundingBox())!; expect(box.width).toBeGreaterThan(90); expect(box.height).toBeLessThan(50);
  await expect(route(page).getByText('Configuration and delivery rules', { exact: true })).toBeVisible();
  await expect(route(page).locator('[data-recued-webhooks-endpoint]')).not.toBeVisible();
  await route(page).getByRole('searchbox', { name: 'Search webhooks', exact: true }).fill('no-such-webhook');
  await expect(route(page)).toContainText('No webhooks match these filters.'); await expect(route(page).getByRole('searchbox')).toBeFocused();
});

for (const setup of ['profile', 'integration'] as const) test(`broker ${setup} Cancel restores its opener and clears credential fields`, async ({ page }) => {
  await go(page, '#connections/others');
  const card = route(page).locator('[data-recued-connections-tool="managed-sign-in"]');
  await card.locator(':scope > summary').click();
  await card.getByRole('button', { name: 'Manage OAuth brokers', exact: true }).click();
  const panel = card.locator('.connections-managed-oauth');
  if (setup === 'integration') await panel.locator('[data-managed-field="profile"]').selectOption('nango-work');
  const opener = panel.locator(`[data-managed-action="${setup === 'profile' ? 'add' : 'add-integration'}"]`);
  await opener.focus(); await opener.press('Enter');
  const editor = panel.locator('.managed-oauth-editor');
  if (setup === 'profile') {
    await editor.locator('[data-managed-field="label"]').fill('Trial broker');
    await editor.locator('[data-managed-field="key"]').fill('fixture-only-key');
  } else {
    await editor.locator('[data-managed-field="app"]').selectOption('custom');
    await editor.locator('[data-managed-field="client-id"]').fill('fixture-only-client');
    await editor.locator('[data-managed-field="client-secret"]').fill('fixture-only-secret');
  }
  const discard = page.waitForEvent('dialog').then(async prompt => {
    expect(prompt.message()).toContain('Discard this'); await prompt.accept();
  });
  const cancel = editor.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.focus(); await cancel.press('Enter'); await discard;
  await expect(editor).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.press('Enter');
  await expect(editor).toBeVisible();
  if (setup === 'profile') await expect(editor.locator('[data-managed-field="key"]')).toHaveValue('');
  else {
    await expect(editor.locator('[data-managed-field="app"]')).toHaveValue('shared');
    await expect(editor.locator('[data-managed-field="client-secret"]')).toHaveCount(0);
  }
});
