import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { BULK_ACCESS_IDS as ids, installBulkAccessFixture } from './fixtures/connections-bulk-access.js';

const origin = process.env.CONNECTIONS_UX_ORIGIN ?? HARNESS_ORIGIN;
const panel = (page: Page) => page.locator('[data-bulk-access]');
const action = (page: Page, name: string) => panel(page).locator(`[data-bulk-access-action="${name}"]`);
const account = (page: Page, id: string) => panel(page).locator(`[data-bulk-access-account="${id}"]`);
const apiUrl = (page: Page) => panel(page).locator(`[data-bulk-access-url="${ids.api}"]`);
const activate = async (control: Locator) => { await control.focus(); await expect(control).toBeFocused(); await control.press('Enter'); };
const toggle = async (control: Locator) => { await control.focus(); await control.press('Space'); await expect(control).toBeFocused(); };
const runs = (page: Page) => page.evaluate(() => window.__bulkAccessFixture.requests.filter(r => r.action === 'authentication_access_run'));
const previews = (page: Page) => page.evaluate(() => window.__bulkAccessFixture.requests.filter(r => r.action === 'authentication_access_preview'));
const statuses = (page: Page) => page.evaluate(() => window.__bulkAccessFixture.requests.filter(r => r.action === 'authentication_access_status'));
const row = (page: Page, id: string) => panel(page).locator(`[data-bulk-access-row="${id}"]`);
const trigger = (page: Page) => page.locator('[data-reconnect-worklist-action="bulk-access"]');
const close = async (page: Page) => {
  await activate(action(page, 'close')); await expect(panel(page)).toHaveCount(0); await expect(trigger(page)).toBeFocused();
};
const reopen = async (page: Page) => {
  await activate(trigger(page)); await expect(action(page, 'search')).toBeFocused();
  await expect(panel(page)).toHaveAttribute('data-bulk-access', 'idle');
  await expect(panel(page).locator('[data-bulk-access-account]:checked')).toHaveCount(0);
};
const stop = async (page: Page) => {
  await activate(action(page, 'stop')); await expect(panel(page)).toHaveAttribute('data-bulk-access', 'stopped');
  await expect(panel(page)).toBeFocused(); await expect(action(page, 'close')).toBeEnabled();
  await expect(action(page, 'stop')).toHaveCount(0); await expect(row(page, ids.files)).toContainText('Stopped before starting.');
};
const open = async (page: Page) => {
  await page.goto(origin + '/full-app-harness.html?settle_reads=1&oauth=ready&connection=webhooks#connections/others');
  await page.waitForFunction(() => window.__app?.ready === true);
  const summary = page.locator('[data-authentication-repairs-summary]');
  await expect(summary).not.toHaveText('Reading authentication status…');
  await activate(summary);
  const trigger = page.locator('[data-reconnect-worklist-action="bulk-access"]');
  await expect(trigger).toBeEnabled(); await activate(trigger);
  await expect(action(page, 'search')).toBeFocused();
};
const reviewBoth = async (page: Page, browserName: string) => {
  // WebKit's native full-control traversal uses Option-Tab on macOS.
  const next = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  await expect(action(page, 'search')).toBeFocused();
  for (const id of [ids.google, ids.files]) {
    await page.keyboard.press(next); await expect(account(page, id)).toBeFocused();
    await page.keyboard.press('Space'); await expect(account(page, id)).toBeChecked();
  }
  await page.keyboard.press(next); await expect(action(page, 'review')).toBeFocused();
  await page.keyboard.press('Enter'); await expect(panel(page)).toHaveAttribute('data-bulk-access', 'review');
  await expect(action(page, 'run')).toBeFocused();
};

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(installBulkAccessFixture, ids);
    });
    test.afterEach(async ({ page }) => {
      const errors = await page.pageErrors();
      expect(errors, errors.map(error => error.message).join(' | ')).toHaveLength(0);
    });

    test('mixed results recheck only non-passing reads with fresh resources and keep keyboard focus', async ({ page, browserName }) => {
      await open(page);
      await expect(account(page, ids.app)).toHaveCount(0);
      expect(await previews(page)).toHaveLength(0); expect(await runs(page)).toHaveLength(0);
      await reviewBoth(page, browserName);
      expect(await previews(page)).toHaveLength(2); expect(await runs(page)).toHaveLength(0);
      await apiUrl(page).fill('https://sheets.googleapis.com/v4/spreadsheets/first');
      await page.evaluate(() => window.__bulkAccessFixture.hold('authentication_access_run'));
      await activate(action(page, 'run'));
      await expect(panel(page)).toHaveAttribute('data-bulk-access', 'running');
      await expect(panel(page)).toHaveAttribute('aria-busy', 'true');
      await expect(panel(page)).toBeFocused();
      await expect(action(page, 'close')).toBeDisabled(); await expect(action(page, 'stop')).toBeEnabled();
      await expect(apiUrl(page)).toBeDisabled();
      expect(await runs(page)).toHaveLength(1);
      await page.evaluate(() => window.__bulkAccessFixture.release('authentication_access_run'));
      await expect(panel(page)).toHaveAttribute('data-bulk-access', 'finished');
      await expect(panel(page)).toBeFocused();
      const original = await page.evaluate(() => window.__bulkAccessFixture.receipts());
      expect(original).toHaveLength(2);
      const google = panel(page).locator(`[data-bulk-access-row="${ids.google}"]`);
      const files = panel(page).locator(`[data-bulk-access-row="${ids.files}"]`);
      await expect(google).toContainText('Protected API read: Failed');
      await expect(google).toContainText('Account and selected folders/calendars: Passed');
      await expect(files).toContainText('File metadata: Passed');
      await expect(files).toContainText('Chosen file download/export: Unconfirmed');
      await expect(google).toContainText('Sending, editing and other writes: Unconfirmed');

      await activate(action(page, 'recheck-results'));
      await expect(panel(page)).toHaveAttribute('data-bulk-access-mode', 'rechecks');
      await expect(action(page, 'search')).toBeFocused();
      await expect(panel(page).locator('[data-bulk-access-account]:checked')).toHaveCount(2);
      await activate(action(page, 'review')); await expect(action(page, 'run')).toBeFocused();
      expect((await previews(page)).slice(2).map(r => r.selection)).toEqual(original.map(job => ({ kind: 'verification', id: job.id })));
      await expect(apiUrl(page)).toHaveValue('');
      await expect(panel(page).locator('h5')).toHaveText(['Work spreadsheets', 'Work Drive']);
      await expect(action(page, 'file-' + ids.file)).toHaveText('Choose a file');
      await apiUrl(page).fill('https://sheets.googleapis.com/v4/spreadsheets/recheck');
      await activate(action(page, 'file-' + ids.file));
      const picker = panel(page).locator('[data-file-download-picker]');
      await expect(picker.getByRole('searchbox')).toBeFocused();
      const file = picker.locator('[data-file-download-picker-choice="chosen-report"]');
      await toggle(file);
      await activate(picker.locator('[data-file-download-picker-action="verify"]'));
      await expect(action(page, 'file-' + ids.file)).toBeFocused();
      await activate(action(page, 'run'));
      await expect(panel(page)).toHaveAttribute('data-bulk-access', 'finished');
      const requests = await runs(page);
      expect(requests.slice(2).map(r => r.target_ids)).toEqual([[ids.api], [ids.file]]);
      expect(requests.slice(2).map(r => r.choices)).toEqual([
        [{ target_id: ids.api, url: 'https://sheets.googleapis.com/v4/spreadsheets/recheck' }],
        [{ target_id: ids.file, file_id: 'chosen-report' }],
      ]);
      expect(new Set(requests.map(r => r.attempt_id)).size).toBe(4);
      expect(await page.evaluate(() => window.__bulkAccessFixture.receipts().slice(0, 2))).toEqual(original);
      await expect(panel(page).locator('[data-authentication-access-result]').filter({ visible: true })).toContainText([
        'Protected API read: Passed', 'Chosen file download/export: Passed',
      ]);
      await expect(action(page, 'recheck-results')).toHaveCount(0);
      expect(await panel(page).evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      await activate(action(page, 'close'));
      await expect(panel(page)).toHaveCount(0);
      await expect(page.locator('[data-reconnect-worklist-action="bulk-access"]')).toBeFocused();
    });

    test('changed latest results retain eligible selections and require a fresh explicit review', async ({ page }) => {
      await open(page);
      await page.evaluate(() => window.__bulkAccessFixture.seedMixedResults());
      await activate(action(page, 'mode'));
      const originals = await page.evaluate(() => window.__bulkAccessFixture.receipts());
      await toggle(account(page, originals[0]!.id)); await toggle(account(page, originals[1]!.id));
      await page.evaluate(() => window.__bulkAccessFixture.completeApiRead());
      await activate(action(page, 'review'));
      await expect(panel(page).getByRole('alert')).toHaveText('Saved results changed. Review the updated selections, then choose Review selected reads again.');
      await expect(account(page, originals[0]!.id)).toHaveCount(0);
      await expect(account(page, originals[1]!.id)).toBeChecked();
      await expect(action(page, 'review')).toBeFocused();
      expect(await previews(page)).toHaveLength(0); expect(await runs(page)).toHaveLength(0);
      await activate(action(page, 'review')); await expect(action(page, 'run')).toBeFocused();
      expect((await previews(page)).map(r => r.selection)).toEqual([{ kind: 'verification', id: originals[1]!.id }]);
      await expect(apiUrl(page)).toHaveCount(0);
      await expect(panel(page).locator('h5')).toHaveText(['Work Drive']);
      expect(await runs(page)).toHaveLength(0);
    });

    test('search and refresh retain selected accounts without stealing focus and reset resource choices', async ({ page }) => {
      await open(page);
      await toggle(account(page, ids.google)); await toggle(account(page, ids.files));
      await action(page, 'search').fill('Work Google');
      await expect(action(page, 'search')).toBeFocused();
      await expect(panel(page).locator('[data-bulk-access-account]')).toHaveCount(1);
      await expect(account(page, ids.google)).toBeChecked();
      await page.evaluate(() => window.__bulkAccessFixture.hold('authentication_worklist'));
      await activate(action(page, 'load'));
      await expect(panel(page)).toHaveAttribute('aria-busy', 'true');
      const outside = page.locator('[data-recued-connections-route]').getByRole('link', { name: 'Calendar', exact: true });
      await outside.focus(); await expect(outside).toBeFocused();
      await page.evaluate(() => window.__bulkAccessFixture.release('authentication_worklist'));
      await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
      await expect(outside).toBeFocused(); await expect(action(page, 'search')).toHaveValue('Work Google');
      await action(page, 'search').fill('');
      await expect(account(page, ids.google)).toBeChecked(); await expect(account(page, ids.files)).toBeChecked();
      await activate(action(page, 'review')); await expect(action(page, 'run')).toBeFocused();
      await apiUrl(page).fill('https://sheets.googleapis.com/v4/spreadsheets/discarded');
      await activate(action(page, 'again')); await expect(action(page, 'search')).toBeFocused();
      await expect(account(page, ids.google)).toBeChecked(); await expect(account(page, ids.files)).toBeChecked();
      await activate(action(page, 'review')); await expect(action(page, 'run')).toBeFocused();
      await expect(apiUrl(page)).toHaveValue('');
      expect(await runs(page)).toHaveLength(0);
    });

    test('an uncertain start pauses the queue and recovery reuses the reviewed request', async ({ page, browserName }) => {
      await open(page); await reviewBoth(page, browserName);
      await page.evaluate(() => window.__bulkAccessFixture.loseNextStartReply());
      await activate(action(page, 'run'));
      await expect(panel(page)).toHaveAttribute('data-bulk-access', 'paused');
      await expect(panel(page)).toBeFocused();
      await expect(panel(page).getByRole('alert')).toContainText('The queue is paused');
      const first = await runs(page); expect(first).toHaveLength(1);
      await expect(panel(page).locator(`[data-bulk-access-row="${ids.files}"]`)).toContainText('Waiting to start');
      await activate(action(page, 'recover'));
      await expect(panel(page)).toHaveAttribute('data-bulk-access', 'finished');
      await expect(panel(page)).toBeFocused();
      const recovered = await runs(page);
      expect(recovered).toHaveLength(3); expect(recovered[1]).toEqual(first[0]);
      expect(recovered[2]!.target_ids).toEqual([ids.file]);
      expect(await page.evaluate(() => window.__bulkAccessFixture.receipts())).toHaveLength(2);
    });

    test('Stop cancels polling and refreshes only the already-started job', async ({ page, browserName }) => {
      await open(page); await page.clock.install(); await reviewBoth(page, browserName);
      await page.evaluate(() => window.__bulkAccessFixture.startNextInBackground());
      await activate(action(page, 'run'));
      await expect(row(page, ids.google)).toContainText('Access checks are running in the background.');
      await expect(row(page, ids.files)).toContainText('Waiting to start');
      const [saved] = await page.evaluate(() => window.__bulkAccessFixture.receipts());
      expect(saved!.status).toBe('checking');
      await stop(page); await page.clock.fastForward(30_000);
      expect(await runs(page)).toHaveLength(1); expect(await statuses(page)).toHaveLength(0);
      expect(await page.evaluate(() => window.__bulkAccessFixture.receipts())).toEqual([saved]);
      await page.evaluate(id => window.__bulkAccessFixture.complete(id), saved!.id);
      await activate(action(page, 'status'));
      await expect(row(page, ids.google)).toContainText('Saved check finished');
      await expect(row(page, ids.files)).toContainText('Stopped before starting.');
      await expect(panel(page)).toHaveAttribute('data-bulk-access', 'stopped'); await expect(panel(page)).toBeFocused();
      expect(await statuses(page)).toEqual([{ action: 'authentication_access_status', id: saved!.id }]);
      expect(await runs(page)).toHaveLength(1);
      await close(page);
    });

    test('a late start receipt stays in a stopped review without moving outside focus or starting queued accounts', async ({ page, browserName }) => {
      await open(page); await page.clock.install(); await reviewBoth(page, browserName);
      await page.evaluate(() => window.__bulkAccessFixture.holdReply('authentication_access_run'));
      await activate(action(page, 'run'));
      await expect.poll(() => page.evaluate(() => window.__bulkAccessFixture.pendingReplies('authentication_access_run'))).toBe(1);
      const [saved] = await page.evaluate(() => window.__bulkAccessFixture.receipts());
      await expect(row(page, ids.google)).toContainText('Starting check');
      await stop(page);
      const outside = page.locator('[data-recued-connections-route]').getByRole('link', { name: 'Calendar', exact: true });
      await outside.focus(); await expect(outside).toBeFocused();
      await page.evaluate(() => window.__bulkAccessFixture.releaseReply('authentication_access_run'));
      await expect(row(page, ids.google).locator('[data-authentication-access-result]')).toHaveAttribute('data-authentication-access-result', saved!.id);
      await expect(panel(page)).toHaveAttribute('data-bulk-access', 'stopped'); await expect(outside).toBeFocused();
      await expect(row(page, ids.files)).toContainText('Stopped before starting.');
      await page.clock.fastForward(30_000);
      expect(await runs(page)).toHaveLength(1); expect(await statuses(page)).toHaveLength(0);
      expect(await page.evaluate(() => window.__bulkAccessFixture.receipts())).toEqual([saved]);
      await close(page);
    });

    test('a late start from a closed batch cannot replace or advance a newer running batch', async ({ page, browserName }) => {
      await open(page); await reviewBoth(page, browserName);
      await page.evaluate(() => window.__bulkAccessFixture.holdReply('authentication_access_run'));
      await activate(action(page, 'run'));
      await expect.poll(() => page.evaluate(() => window.__bulkAccessFixture.pendingReplies('authentication_access_run'))).toBe(1);
      const [earlier] = await page.evaluate(() => window.__bulkAccessFixture.receipts());
      await stop(page); await close(page); await reopen(page); await reviewBoth(page, browserName);
      await apiUrl(page).fill('https://sheets.googleapis.com/v4/spreadsheets/new-batch');
      await activate(action(page, 'run'));
      await expect.poll(() => page.evaluate(() => window.__bulkAccessFixture.pendingReplies('authentication_access_run'))).toBe(2);
      const [, current] = await page.evaluate(() => window.__bulkAccessFixture.receipts());
      await action(page, 'stop').focus();
      await page.evaluate(() => window.__bulkAccessFixture.releaseReply('authentication_access_run', 0));
      await expect(action(page, 'stop')).toBeFocused();
      await expect(panel(page)).toHaveAttribute('data-bulk-access', 'running'); await expect(panel(page)).toHaveAttribute('aria-busy', 'true');
      await expect(action(page, 'close')).toBeDisabled();
      await expect(row(page, ids.google)).toContainText('Starting check'); await expect(row(page, ids.files)).toContainText('Waiting to start');
      await expect(panel(page).locator('[data-authentication-access-result]')).toHaveCount(0);
      expect(await runs(page)).toHaveLength(2);
      await page.evaluate(() => window.__bulkAccessFixture.releaseReply('authentication_access_run'));
      await expect(panel(page)).toHaveAttribute('data-bulk-access', 'finished'); await expect(panel(page)).toBeFocused();
      await expect(row(page, ids.google).locator('[data-authentication-access-result]')).toHaveAttribute('data-authentication-access-result', current!.id);
      await expect(panel(page).locator(`[data-authentication-access-result="${earlier!.id}"]`)).toHaveCount(0);
      const requests = await runs(page);
      expect(requests.map(r => r.target_ids)).toEqual([[ids.api, ids.mail], [ids.api, ids.mail], [ids.file]]);
      expect(requests[1]!.attempt_id).not.toBe(requests[0]!.attempt_id);
      expect(requests[1]!.choices).toEqual([{ target_id: ids.api, url: 'https://sheets.googleapis.com/v4/spreadsheets/new-batch' }]);
      expect(await page.evaluate(() => window.__bulkAccessFixture.receipts())).toHaveLength(3);
      await close(page);
    });

    test('a late status from a closed batch cannot change the reopened account picker or its focus', async ({ page, browserName }) => {
      await open(page); await page.clock.install(); await reviewBoth(page, browserName);
      await page.evaluate(() => window.__bulkAccessFixture.startNextInBackground());
      await activate(action(page, 'run'));
      await expect(row(page, ids.google)).toContainText('Access checks are running in the background.');
      const [saved] = await page.evaluate(() => window.__bulkAccessFixture.receipts());
      await page.evaluate(id => {
        window.__bulkAccessFixture.complete(id); window.__bulkAccessFixture.holdReply('authentication_access_status');
      }, saved!.id);
      await page.clock.fastForward(1500);
      await expect.poll(() => page.evaluate(() => window.__bulkAccessFixture.pendingReplies('authentication_access_status'))).toBe(1);
      await stop(page); await close(page); await reopen(page);
      await action(page, 'search').fill('Work'); await toggle(account(page, ids.files));
      await action(page, 'search').focus();
      await page.evaluate(() => window.__bulkAccessFixture.releaseReply('authentication_access_status'));
      await expect(panel(page)).toHaveAttribute('data-bulk-access', 'idle'); await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
      await expect(action(page, 'search')).toBeFocused(); await expect(action(page, 'search')).toHaveValue('Work');
      await expect(account(page, ids.files)).toBeChecked(); await expect(account(page, ids.google)).not.toBeChecked();
      await expect(panel(page).locator('[data-bulk-access-row]')).toHaveCount(0);
      await page.clock.fastForward(30_000);
      expect(await runs(page)).toHaveLength(1); expect(await statuses(page)).toHaveLength(1); expect(await previews(page)).toHaveLength(2);
      expect(await page.evaluate(() => window.__bulkAccessFixture.receipts())).toHaveLength(1);
      await close(page);
    });
  });
}
