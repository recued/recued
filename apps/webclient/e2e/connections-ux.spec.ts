import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { expect, test, type Page } from '@playwright/test';
import { installConnectionsUxFixture } from './fixtures/connections-ux.js';

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

test('connections and Add lead the page while the repair summary and administration stay compact', async ({ page }) => {
  await go(page, '#connections/others');
  const add = route(page).getByRole('button', { name: '+ Add Connection', exact: true }); await expect(add).toBeVisible();
  expect((await add.boundingBox())!.y).toBeLessThan(600);
  await expect(route(page).locator('.reconnect-worklist-disclosure')).not.toHaveAttribute('open', '');
  await expect(route(page).locator('.connections-authentication-settings')).not.toHaveAttribute('open', '');
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
  await route(page).getByRole('button', { name: 'Save and test', exact: true }).click();
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
  await expect(route(page).locator('[data-conn-field="auth.type"]')).toContainText('Recued direct OAuth');
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
