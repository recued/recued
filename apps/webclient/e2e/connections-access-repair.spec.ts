import { expect, test, type Locator, type Page } from '@playwright/test';
import { installConnectionsUxFixture } from './fixtures/connections-ux.js';
import { ACCESS_REPAIR_IDS as ids, installAccessRepairFixture } from './fixtures/connections-access-repair.js';

const origin = process.env.CONNECTIONS_UX_ORIGIN ?? 'http://127.0.0.1:4319';
const route = (page: Page) => page.locator('[data-recued-connections-route]');
const activate = async (control: Locator) => { await control.focus(); await expect(control).toBeFocused(); await control.press('Enter'); };
const shortcuts = (page: Page) => route(page).locator('[data-access-repair-shortcut]').filter({ visible: true });
const requests = (page: Page) => page.evaluate(() => window.__accessRepairFixture.requests.filter(r => r.method === 'collection.connection.managedOAuth').map(r => r.args));
const go = async (page: Page, source: 'summary' | 'history' | 'bulk', { expand = true, native = false } = {}) => {
  await page.goto(origin + '/full-app-harness.html?settle_reads=1&oauth=ready&connection=webhooks#chat');
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(installAccessRepairFixture, ids);
  if (native) await page.evaluate(() => window.__accessRepairFixture.nativeAccounts());
  await page.evaluate(hash => window.__app.setHash(hash), source === 'history' ? '#connections/others/incident-history' : '#connections/others');
  if (source !== 'history') {
    const summary = route(page).locator('[data-authentication-repairs-summary]');
    await expect(summary).not.toHaveText('Reading authentication status…');
    if (expand) await activate(summary);
  }
  if (source === 'bulk') {
    await activate(route(page).locator('[data-reconnect-worklist-action="bulk-access"]'));
    const panel = route(page).locator('[data-bulk-access]');
    await expect(panel.getByRole('searchbox')).toBeFocused();
    const account = panel.locator('[data-bulk-access-account="' + ids.group + '"]');
    await account.focus(); await account.press('Space');
    await activate(panel.locator('[data-bulk-access-action="review"]'));
    await expect(panel.locator('[data-bulk-access-action="run"]')).toBeFocused();
    await activate(panel.locator('[data-bulk-access-action="run"]'));
    await expect(panel).toHaveAttribute('data-bulk-access', 'finished');
    await expect(panel.locator('[data-access-repair-shortcut]')).toHaveCount(native ? 2 : 4);
  } else if (expand) await expect(shortcuts(page)).toHaveCount(native ? 2 : 4);
};

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    test.beforeEach(async ({ page }) => { await page.addInitScript(installConnectionsUxFixture); });
    test.afterEach(async ({ page }) => {
      const errors = await page.pageErrors(); expect(errors, errors.map(error => error.message).join(' | ')).toHaveLength(0);
    });

    for (const destination of [
      { kind: 'api', label: 'Review API authentication', hash: '#connections/others/review-access/api/sheets-work' },
      { kind: 'mail', label: 'Review Mail authentication', hash: '#connections/mail/work/manage-authentication' },
      { kind: 'calendar', label: 'Review Calendar authentication', hash: '#connections/calendar/work/manage-authentication' },
      { kind: 'file', label: 'Review file authentication', hash: '#connections/others/switch-file-authentication/api/drive-work' },
    ] as const) test(`${destination.kind} repair reads fresh saved status and opens the exact authentication destination`, async ({ page }) => {
      await go(page, 'history');
      const before = (await requests(page)).length;
      const saved = await page.evaluate(() => window.__accessRepairFixture.receipt());
      await activate(route(page).getByRole('button', { name: destination.label, exact: true }));
      // An additive return reference must identify this exact saved resource.
      await expect.poll(() => page.evaluate(() => location.hash)).toMatch(new RegExp('^' + destination.hash
        + '(?:/from-access/' + saved.id + '/' + ids[destination.kind] + ')?$'));
      if (destination.kind === 'api') {
        const heading = route(page).locator('[data-connection-dialog-heading]');
        await expect(heading).toHaveText('Manage authentication for Work spreadsheets'); await expect(heading).toBeFocused();
        expect((await requests(page)).filter(r => r.action === 'reauthorization_context')).toContainEqual(
          expect.objectContaining({ name: 'sheets-work', expected_updated_at: 1 }),
        );
      } else if (destination.kind === 'file') {
        const picker = route(page).locator('[data-file-download-picker]');
        await expect(picker.getByRole('searchbox')).toBeFocused(); await expect(picker).toContainText('Report.pdf');
        expect((await requests(page)).filter(r => r.action === 'file_authentication_files')).toEqual([
          expect.objectContaining({ name: 'drive-work', expected_updated_at: 7 }),
        ]);
        await expect(page).not.toHaveURL(/old-drive|opaque-source/);
      } else {
        const heading = route(page).locator('[data-oauth-app-switch-heading]');
        await expect(heading).toBeFocused(); await expect(heading).toContainText('work');
        await expect(route(page)).toContainText(destination.kind === 'mail' ? 'person@example.test' : 'calendar@example.test');
        expect((await requests(page)).filter(r => r.action === 'collection_authentication_app_context')).toEqual([
          expect.objectContaining({ platform: destination.kind, slug: 'work', intent: 'reauthorize' }),
        ]);
      }
      const calls = (await requests(page)).slice(before);
      expect(calls[0]).toEqual({ action: 'authentication_access_status', id: 'verify-12345678-1234-4123-8123-123456789abc' });
      const reads = new Set(['authentication_access_status', 'authentication_history', 'authentication_worklist', 'reauthorization_context',
        'collection_authentication_app_context', 'file_authentication_files', 'profiles']);
      expect(calls.filter(call => !reads.has(String(call.action)))).toEqual([]);
      expect(page.context().pages()).toHaveLength(1);
    });

    for (const account of [
      { platform: 'mail', provider: 'IMAP', slug: 'work-imap', label: 'Review Mail authentication', target: ids.mail },
      { platform: 'calendar', provider: 'CalDAV', slug: 'work-caldav', label: 'Review Calendar authentication', target: ids.calendar },
    ] as const) {
      for (const source of ['history', 'summary', 'bulk'] as const) test(`${account.provider} repair from ${source} opens its credential editor without a provider request`, async ({ page }) => {
        await go(page, source, { native: true });
        const saved = await page.evaluate(() => window.__accessRepairFixture.receipt());
        const before = await page.evaluate(() => window.__accessRepairFixture.requests.length);
        const view = source === 'bulk' ? route(page).locator('[data-bulk-access]') : route(page);
        await activate(view.getByRole('button', { name: account.label, exact: true }));
        const hash = '#connections/' + account.platform + '/' + account.slug + '/manage-authentication/from-access/' + saved.id + '/' + account.target;
        await expect.poll(() => page.evaluate(() => location.hash)).toBe(hash);
        await expect(route(page).locator('[data-account-password-heading]')).toHaveText('Update credentials for ' + account.slug);
        await expect(route(page).locator('[data-account-password-heading]')).toBeFocused();
        await expect(route(page).locator('[data-account-password-field="password"]')).toHaveValue('');
        await expect(route(page).locator('[data-account-password-field="smtp"]')).toHaveCount(account.platform === 'mail' ? 1 : 0);
        await expect(route(page).getByRole('button', { name: 'Verify and save credentials', exact: true })).toBeDisabled();
        await expect(route(page).locator('[data-oauth-app-switch-heading],[data-manage-authentication-heading]')).toHaveCount(0);
        const returnAddress = new URL(page.url()); returnAddress.hash = '#connections/others/access-result/' + saved.id + '/' + account.target;
        await expect(route(page).locator('[data-access-repair-return]')).toHaveAttribute('href', returnAddress.href);
        const calls = await page.evaluate(start => window.__accessRepairFixture.requests.slice(start), before);
        expect(calls[0]).toEqual({ method: 'collection.connection.managedOAuth', args: { action: 'authentication_access_status', id: saved.id } });
        // `yours.read`: the Source spheres panel (D-325) reads each source's default when Connections opens.
        const localReads = new Set(['collection.mail.list', 'collection.calendar.list', 'collection.connection.list', 'server.getOAuthAppConfig', 'yours.read']);
        expect(calls.filter(call => !localReads.has(call.method)
          && !(call.method === 'packs.reconnect_later' && call.args.action === 'list')
          && !(call.method === 'collection.connection.managedOAuth' && (
            ['authentication_access_status', 'authentication_worklist', 'profiles'].includes(String(call.args.action))
            || source === 'bulk' && call.args.action === 'authentication_access_retire' && call.args.review_id === 'p'.repeat(43))))).toEqual([]);
        expect(page.context().pages()).toHaveLength(1);
        await activate(route(page).locator('[data-account-password-action="close"]'));
        await expect(route(page).getByRole('button', { name: 'Update credentials', exact: true })).toBeFocused();
      });

      test(`${account.provider} repair retains its draft on cancelled navigation, retries verification and returns to the saved read`, async ({ page }) => {
        await go(page, 'summary', { native: true });
        const saved = await page.evaluate(() => window.__accessRepairFixture.receipt());
        await activate(route(page).getByRole('button', { name: account.label, exact: true }));
        const field = route(page).locator('[data-account-password-field="password"]');
        await expect(route(page).locator('[data-account-password-heading]')).toBeFocused(); await field.fill('invalid');
        const returnLink = route(page).locator('[data-access-repair-return]');
        const dialogs: string[] = [];
        page.once('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
        await activate(returnLink);
        await expect.poll(() => dialogs).toEqual([expect.stringContaining('replacement password')]);
        await expect(field).toHaveValue('invalid');
        await expect(page).toHaveURL(new RegExp('#connections/' + account.platform + '/' + account.slug + '/manage-authentication/'));
        const updates = () => page.evaluate(() => window.__accessRepairFixture.requests.filter(r => r.method.endsWith('.updateCredentials')));
        expect(await updates()).toEqual([]);
        await activate(route(page).getByRole('button', { name: 'Verify and save credentials', exact: true }));
        await expect(route(page).getByRole('alert')).toContainText('Saved credentials were kept');
        await expect(field).toHaveValue('invalid'); await expect(route(page).locator('[data-account-password-heading]')).toBeFocused();
        await field.fill('fixture-replacement');
        if (account.platform === 'mail') await route(page).locator('[data-account-password-field="smtp"]').fill('fixture-smtp-new-pass');
        await activate(route(page).getByRole('button', { name: 'Verify and save credentials', exact: true }));
        await expect(route(page).getByRole('status')).toContainText('Credentials verified and saved.');
        await expect(field).toHaveValue(''); await expect(route(page).locator('[data-accounts-detail-heading]')).toHaveText(account.slug);
        expect(await updates()).toEqual([
          { method: 'collection.' + account.platform + '.updateCredentials', args: { slug: account.slug, password: 'invalid' } },
          { method: 'collection.' + account.platform + '.updateCredentials', args: { slug: account.slug, password: 'fixture-replacement',
            ...(account.platform === 'mail' ? { smtp_password: 'fixture-smtp-new-pass' } : {}) } },
        ]);
        const beforeReturn = (await requests(page)).length;
        await activate(returnLink);
        const result = route(page).getByRole('region', { name: 'Saved access check', exact: true });
        await expect(result).toContainText('Opening this result does not confirm that a repair succeeded.');
        await expect(result.locator('[data-authentication-access-result]')).toHaveAttribute('data-authentication-access-result', saved.id);
        await expect(result.getByRole('button', { name: 'Review current access for this resource', exact: true })).toBeFocused();
        expect((await requests(page)).slice(beforeReturn)).toEqual([{ action: 'authentication_access_status', id: saved.id }]);
      });

      test(`a removed ${account.provider} account cannot open another account's credential editor`, async ({ page }) => {
        await go(page, 'history', { native: true });
        await page.evaluate(platform => window.__accessRepairFixture.removeNativeAccount(platform), account.platform);
        await activate(route(page).getByRole('button', { name: account.label, exact: true }));
        await expect(route(page).getByRole('alert')).toContainText('Account not found');
        await expect(route(page).locator('[data-account-password-heading],[data-oauth-app-switch-heading]')).toHaveCount(0);
        expect((await requests(page)).filter(r => r.action === 'collection_authentication_app_context')).toEqual([]);
        expect(await page.evaluate(() => window.__accessRepairFixture.requests.filter(r => r.method.endsWith('.updateCredentials')))).toEqual([]);
      });
    }

    test('a stale latest-result shortcut keeps its error and keyboard focus until an explicit retry', async ({ page }) => {
      await go(page, 'summary');
      const source = route(page).locator('[data-latest-access-target="' + ids.api + '"]');
      const button = () => source.getByRole('button', { name: 'Review API authentication', exact: true });
      await page.evaluate(() => window.__accessRepairFixture.status('stale'));
      const before = (await requests(page)).length;
      await activate(button());
      await expect(source.getByRole('alert')).toContainText('The saved check or its authentication changed');
      await expect(button()).toBeFocused(); await expect(page).toHaveURL(/#connections\/others$/);
      expect((await requests(page)).slice(before)).toEqual([{ action: 'authentication_access_status', id: 'verify-12345678-1234-4123-8123-123456789abc' }]);
      await page.evaluate(() => window.__accessRepairFixture.status('current'));
      await activate(button());
      await expect(route(page).locator('[data-connection-dialog-heading]')).toHaveText('Manage authentication for Work spreadsheets');
      await expect(route(page).locator('[data-connection-dialog-heading]')).toBeFocused();
    });

    test('a shortcut render preserves an opened disclosure before its queued native toggle event', async ({ page }) => {
      await go(page, 'summary', { expand: false });
      await expect(route(page).locator('[data-latest-access-target]')).toHaveCount(4);
      await page.evaluate(() => window.__accessRepairFixture.status('stale'));
      await page.evaluate(() => {
        const details = document.querySelector<HTMLDetailsElement>('.reconnect-worklist-disclosure')!;
        details.querySelector<HTMLElement>('summary')!.click();
        // Both native DOM actions run before the asynchronous toggle notification.
        const button = details.querySelector<HTMLButtonElement>('[data-access-repair-shortcut]')!;
        button.focus(); button.click();
      });
      await expect(route(page).locator('.reconnect-worklist-disclosure')).toHaveAttribute('open', '');
      const source = route(page).locator('[data-latest-access-target="' + ids.api + '"]');
      await expect(source.getByRole('alert')).toContainText('The saved check or its authentication changed');
      await expect(source.getByRole('button', { name: 'Review API authentication', exact: true })).toBeFocused();
    });

    test('a failed bulk-result lookup restores its shortcut focus and supports an explicit retry', async ({ page }) => {
      await go(page, 'bulk');
      const panel = route(page).locator('[data-bulk-access]');
      const button = () => panel.getByRole('button', { name: 'Review API authentication', exact: true });
      await page.evaluate(() => { window.__accessRepairFixture.status('unavailable'); window.__accessRepairFixture.holdStatus(); });
      const before = (await requests(page)).length;
      await activate(button());
      await expect.poll(() => page.evaluate(() => window.__accessRepairFixture.pendingStatus())).toBe(1);
      await expect(panel.getByRole('button', { name: 'Reading saved authentication…', exact: true })).toBeDisabled();
      await page.keyboard.press('Enter');
      expect((await requests(page)).slice(before)).toHaveLength(1);
      await page.evaluate(() => window.__accessRepairFixture.releaseStatus());
      await expect(panel.getByRole('alert')).toContainText('The saved check could not be read.');
      await expect(panel).not.toContainText('private-token'); await expect(button()).toBeFocused();
      await expect(panel).toHaveAttribute('data-bulk-access', 'finished');
      await page.evaluate(() => window.__accessRepairFixture.status('current'));
      await activate(button());
      await expect(route(page).locator('[data-connection-dialog-heading]')).toBeFocused();
    });

    for (const source of ['history', 'bulk'] as const) test(`a delayed ${source} refusal preserves focus moved outside the results`, async ({ page }) => {
      await go(page, source);
      const view = source === 'bulk' ? route(page).locator('[data-bulk-access]') : route(page).getByRole('region', { name: 'Connection incident history', exact: true });
      await page.evaluate(() => { window.__accessRepairFixture.status('stale'); window.__accessRepairFixture.holdStatus(); });
      await activate(view.getByRole('button', { name: 'Review Mail authentication', exact: true }));
      await expect.poll(() => page.evaluate(() => window.__accessRepairFixture.pendingStatus())).toBe(1);
      const outside = route(page).getByRole('link', { name: 'Calendar', exact: true });
      await outside.focus(); await expect(outside).toBeFocused();
      await page.evaluate(() => window.__accessRepairFixture.releaseStatus());
      await expect(view.getByRole('alert')).toContainText('The saved check or its authentication changed');
      await expect(outside).toBeFocused();
      await expect.poll(() => page.evaluate(() => location.hash)).toBe(source === 'history' ? '#connections/others/incident-history' : '#connections/others');
    });

    test('closing a bulk result during a shortcut lookup prevents late navigation into authentication', async ({ page }) => {
      await go(page, 'bulk');
      const panel = route(page).locator('[data-bulk-access]');
      await page.evaluate(() => window.__accessRepairFixture.holdStatus());
      await activate(panel.getByRole('button', { name: 'Review Calendar authentication', exact: true }));
      await expect.poll(() => page.evaluate(() => window.__accessRepairFixture.pendingStatus())).toBe(1);
      await activate(panel.locator('[data-bulk-access-action="close"]'));
      const trigger = route(page).locator('[data-reconnect-worklist-action="bulk-access"]');
      await expect(panel).toHaveCount(0); await expect(trigger).toBeFocused();
      await page.evaluate(() => window.__accessRepairFixture.releaseStatus());
      await expect(page).toHaveURL(/#connections\/others$/); await expect(trigger).toBeFocused();
      await expect(route(page).locator('[data-manage-authentication]')).toHaveCount(0);
    });
  });
}
