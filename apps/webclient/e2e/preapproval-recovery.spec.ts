import { test, expect } from '@playwright/test';
import { approveReview, openPreapproval, preapproval, refreshReview } from './helpers/preapproval-recovery-fixture.js';
const unloadGuarded = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented;
});
let pageErrors: string[];
test.beforeEach(({ page }) => { pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message)); });
test.afterEach(() => { expect(pageErrors).toEqual([]); });

test('refresh preserves a scope draft until its reviewed context changes', async ({ page }) => {
  await openPreapproval(page);
  const http = preapproval(page).locator('[data-preapproval-member="pam_http"]'); await http.uncheck();
  await refreshReview(page).click(); await expect(http).not.toBeChecked(); await expect(approveReview(page)).toBeDisabled();
  expect(await unloadGuarded(page)).toBe(true);
  const dialogs: string[] = []; page.once('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.evaluate(() => window.__app.setHash('#yours')); await expect.poll(() => dialogs.length).toBe(1);
  await expect(page).toHaveURL(/#approvals\/preapproval\/pap_browser$/u);
  await page.evaluate(() => {
    const state = JSON.parse(sessionStorage.getItem('recued-test-preapproval')!);
    state.review.revision++; state.review.review_digest = 'changed-review'; state.review.members[0].arguments.subject = 'Changed quarterly report';
    sessionStorage.setItem('recued-test-preapproval', JSON.stringify(state));
  });
  await refreshReview(page).click(); await expect(http).toBeChecked(); await expect(preapproval(page)).toContainText('Changed quarterly report');
  expect(await unloadGuarded(page)).toBe(false); await http.uncheck();
  await preapproval(page).getByRole('button', { name: 'Bring this up to date', exact: true }).click();
  await expect(approveReview(page)).toBeEnabled(); expect(await unloadGuarded(page)).toBe(false);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
});

test('a pending decision guards departure and keeps the exact retry without stealing later shell focus', async ({ page }) => {
  await openPreapproval(page, { held: ['preapproval.decide'] });
  await approveReview(page).focus(); await approveReview(page).press('Enter');
  await expect(preapproval(page).locator('[data-preapproval-progress]')).toBeFocused();
  expect(await unloadGuarded(page)).toBe(true);
  const dialogs: string[] = []; page.once('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.evaluate(() => window.__app.setHash('#yours')); await expect.poll(() => dialogs.length).toBe(1);
  await expect(page).toHaveURL(/#approvals\/preapproval\/pap_browser$/u);
  const outside = page.locator('[data-recued-account-menu-trigger]'); await outside.focus();
  await page.evaluate(() => window.__preapprovalRecovery.release('preapproval.decide', true));
  await expect(preapproval(page).getByRole('alert')).toContainText('Review request unavailable'); await expect(outside).toBeFocused();
  await page.evaluate(() => { window.__preapprovalRecovery.held = []; }); await approveReview(page).click();
  await expect(preapproval(page)).toContainText('Execution: active');
  const requests = await page.evaluate(() => window.__preapprovalRecovery.calls.filter(call => call.method === 'preapproval.decide'));
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(await unloadGuarded(page)).toBe(false);
});

test('a saved decision followed by a failed read offers status recovery without another decision', async ({ page }) => {
  await openPreapproval(page, { failAfterDecision: true }); await approveReview(page).click();
  await expect(preapproval(page).getByRole('alert')).toContainText('Current status unavailable.');
  await expect(preapproval(page)).toContainText('Your decision was saved. Refresh to load its current status.');
  await expect(approveReview(page)).toBeDisabled(); await expect(refreshReview(page)).toBeFocused();
  await page.evaluate(() => { window.__preapprovalRecovery.failAfterDecision = false; });
  await refreshReview(page).press('Enter'); await expect(preapproval(page)).toContainText('Execution: active');
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(1);
});

test('an empty continuation date stays connected and remains a draft across refresh', async ({ page }) => {
  await openPreapproval(page, { continuation: true });
  const date = preapproval(page).locator('[data-preapproval-continuation-time]'); const original = await date.elementHandle();
  await date.fill(''); await refreshReview(page).click(); await expect(date).toHaveValue('');
  expect(await original!.evaluate(input => input.isConnected)).toBe(true); expect(await unloadGuarded(page)).toBe(true);
  await page.evaluate(() => { window.__preapprovalRecovery.held = ['preapproval.get']; });
  await date.focus(); await refreshReview(page).evaluate(button => (button as HTMLButtonElement).click());
  await expect.poll(() => page.evaluate(() => window.__preapprovalRecovery.pending('preapproval.get'))).toBe(1);
  await expect(date).toBeEnabled(); await expect(date).toBeFocused();
  await page.evaluate(() => window.__preapprovalRecovery.release('preapproval.get'));
  await expect(refreshReview(page)).toHaveText('Refresh'); await expect(date).toBeFocused(); await expect(date).toHaveValue('');
  expect(await original!.evaluate(input => input.isConnected)).toBe(true);
  await preapproval(page).getByRole('button', { name: 'Prepare continuation review', exact: true }).click();
  await expect(date).toBeFocused(); expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.continue'))).toBe(0);
});

test('departing a pending read does not start the next review read or steal focus', async ({ page }) => {
  await openPreapproval(page, { held: ['preapproval.get'] });
  await expect.poll(() => page.evaluate(() => window.__preapprovalRecovery.pending('preapproval.get'))).toBe(1);
  expect(await unloadGuarded(page)).toBe(false); await page.evaluate(() => window.__app.setHash('#yours'));
  await expect(page).toHaveURL(/#yours$/u);
  await page.evaluate(() => window.__preapprovalRecovery.release('preapproval.get'));
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('preapproval.get'))).toBe(1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.review'))).toBe(0);
  await expect(preapproval(page)).toHaveCount(0);
});

test('manual activation keeps its date, pending focus and exact request through a failed reply', async ({ page }) => {
  await openPreapproval(page, { activation: true, held: ['preapproval.prepare'] });
  await page.getByRole('button', { name: 'Look at the next run', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Look at the next run', exact: true });
  const date = dialog.locator('input[type="datetime-local"]'); const original = await date.elementHandle(); const value = await date.inputValue();
  const submit = dialog.getByRole('button', { name: 'Look at this run', exact: true });
  await submit.focus(); await submit.press('Enter'); await expect(dialog.getByRole('status')).toBeFocused();
  await expect(date).toBeDisabled(); await expect.poll(() => page.evaluate(() => window.__preapprovalRecovery.pending('preapproval.prepare'))).toBe(1);
  await page.evaluate(() => window.__preapprovalRecovery.release('preapproval.prepare', true));
  await expect(dialog.getByRole('alert')).toContainText('Review request unavailable'); await expect(submit).toBeFocused();
  await expect(date).toHaveValue(value); expect(await original!.evaluate(input => input.isConnected)).toBe(true);
  await page.evaluate(() => { window.__preapprovalRecovery.held = []; }); await submit.press('Enter');
  await expect(preapproval(page)).toContainText('yes to the next run only');
  const requests = await page.evaluate(() => window.__preapprovalRecovery.calls.filter(call => call.method === 'preapproval.prepare'));
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
});

test('closing a pending activation fences its late reply and does not approve a run', async ({ page }) => {
  await openPreapproval(page, { activation: true, held: ['preapproval.prepare'] });
  const opener = page.getByRole('button', { name: 'Look at the next run', exact: true }); await opener.focus(); await opener.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Look at the next run', exact: true });
  await dialog.getByRole('button', { name: 'Look at this run', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__preapprovalRecovery.pending('preapproval.prepare'))).toBe(1);
  await dialog.getByRole('button', { name: 'Close', exact: true }).press('Escape'); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  await page.evaluate(() => window.__preapprovalRecovery.release('preapproval.prepare'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page).toHaveURL(/#automation\/auto-run\/dsh_autorun-live-1$/u); await expect(preapproval(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
});


test('a detached decision control cannot approve a changed local selection', async ({ page }) => {
  await openPreapproval(page); const oldApprove = await approveReview(page).elementHandle();
  await preapproval(page).locator('[data-preapproval-member="pam_http"]').uncheck();
  expect(await oldApprove!.evaluate(button => button.isConnected)).toBe(false);
  await oldApprove!.evaluate(button => (button as HTMLButtonElement).click());
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
  await expect(approveReview(page)).toBeDisabled();
});

test('refresh retains the reading position and focus inside a long resource review', async ({ page }) => {
  await openPreapproval(page, { resources: true });
  const region = preapproval(page).getByRole('region', { name: 'Reviewed changes for Change reviewed Records', exact: true });
  await region.focus(); await region.press('End');
  await expect.poll(() => region.evaluate(element => element.scrollTop >= element.scrollHeight - element.clientHeight - 1)).toBe(true);
  const top = await region.evaluate(element => element.scrollTop); expect(top).toBeGreaterThan(0);
  await refreshReview(page).evaluate(button => (button as HTMLButtonElement).click());
  await expect(refreshReview(page)).toHaveText('Refresh'); await expect(region).toBeFocused();
  expect(await region.evaluate(element => element.scrollTop)).toBe(top);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
});

test('an accepted departure retains the pending decision in server-switch review and fences late reads', async ({ page }) => {
  await openPreapproval(page, { held: ['preapproval.decide'], serverProfiles: true });
  await approveReview(page).click(); await expect.poll(() => page.evaluate(() => window.__preapprovalRecovery.pending('preapproval.decide'))).toBe(1);
  page.once('dialog', dialog => dialog.accept()); await page.evaluate(() => window.__app.setHash('#yours'));
  await expect(preapproval(page)).toHaveCount(0);
  await page.locator('[data-recued-account-menu-trigger]').click();
  const menu = page.locator('[data-recued-account-menu-popover]');
  await menu.locator('[data-recued-server-switcher-item]').filter({ hasText: 'Office server' }).click();
  const confirm = menu.locator('[data-recued-server-switcher-switch-confirm]'); await expect(confirm).toContainText('Resolving an approval');
  await confirm.locator('[data-recued-server-switcher-switch-cancel]').click(); await page.locator('[data-recued-account-menu-trigger]').click();
  const reads = await page.evaluate(() => window.__app.rpcCallCount('preapproval.get'));
  await page.evaluate(() => window.__preapprovalRecovery.release('preapproval.decide'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.get'))).toBe(reads);
  await expect(preapproval(page)).toHaveCount(0); await expect(page).toHaveURL(/#yours$/u);
  await page.evaluate(() => window.__app.setHash('#approvals/preapproval/pap_browser'));
  await expect(preapproval(page)).toContainText('Execution: active'); expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(1);
});

test('review-list pagination retains keyboard ownership through an error and the final page', async ({ page }) => {
  await openPreapproval(page);
  await page.evaluate(() => {
    const { review } = JSON.parse(sessionStorage.getItem('recued-test-preapproval')!);
    let cursorAttempts = 0;
    Object.assign(window, { __connectionsFixture: async (method: string, args: Record<string, unknown>) => {
      if (method !== 'preapproval.list') return undefined;
      window.__preapprovalRecovery.calls.push({ method, args });
      if (args.cursor && ++cursorAttempts === 1) return { error: { code: 'UNAVAILABLE', message: 'Next reviewed runs unavailable. Try again.' } };
      const next = !!args.cursor;
      const { challenge: _challenge, challenge_expires_at: _expires, ...reviewed } = review;
      const result: import('@recued/contracts').PreapprovalInspection = {
        proposal_id: next ? 'pap_second' : 'pap_first', future_execution_ref: 'paf_browser', revision: 1,
        status: 'awaiting_owner', execution_status: 'prepared', coverage: 'complete', eligible_members: 1, uncovered_calls: 0,
        status_reason: null, grant: null, decision: null, reviewed,
        members: [{ member_id: next ? 'pam_second' : 'pam_first', parent_member_id: null, op_id: 'core.mail.send',
          label: next ? 'Second reviewed run' : 'First reviewed run', status: 'available', action_ref: null, commit_id: null,
          status_message: null, reconciled_outcome: null }], created_at: Date.now(), updated_at: Date.now(),
      };
      return { result: { proposals: [result], next_cursor: next ? null : 'review-next' } };
    } });
    window.__app.setHash('#approvals/preapproval');
  });
  const more = preapproval(page).getByRole('button', { name: 'Load more', exact: true });
  await more.focus(); await more.press('Enter');
  await expect(preapproval(page).getByRole('alert')).toContainText('Next reviewed runs unavailable'); await expect(more).toBeFocused();
  await more.press('Enter');
  const second = preapproval(page).getByRole('link', { name: 'Second reviewed run · 1 operations', exact: true });
  await expect(second).toBeFocused(); await expect(more).toHaveCount(0);
  await expect(preapproval(page).getByRole('link', { name: 'First reviewed run · 1 operations', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__preapprovalRecovery.calls.filter(call => call.method === 'preapproval.list').map(call => call.args)))
    .toEqual([{}, { cursor: 'review-next' }, { cursor: 'review-next' }]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
});
