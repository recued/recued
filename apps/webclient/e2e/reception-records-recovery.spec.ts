import { expect, test } from '@playwright/test';
import { installFullAppHooks } from './helpers/full-app.js';
import { HOLD_A, HOLD_B, INBOX_APPROVE, INBOX_LIST, INBOX_REJECT, RECORD_A, RECORD_B, RECORD_LIST, RECORD_OPEN,
  inboxDecision, inboxRow, openReceptionReview, receptionWrites, recordDetails, recordRetry, recordRow, recordToggle, reviewInboxItem } from './helpers/reception-review-fixture.js';

installFullAppHooks();
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 390, height: 850 }); });

test('Reception request list stays redacted until the owner opens an exact record and renders answers as text', async ({ page }) => {
  await openReceptionReview(page);
  await expect(page.getByText('Morgan Lake', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__receptionReview.calls.filter(call => call.method === 'reception.record.open'))).toEqual([]);
  await page.evaluate(id => { window.__receptionReview.opened[id] = { ...window.__receptionReview.opened[id]!, answers: [{ label: 'Project brief', value: '<img src=x onerror="window.__injected=true">' }] }; }, RECORD_B);
  await recordToggle(page, RECORD_B).focus();
  await page.keyboard.press('Enter');
  await expect(recordDetails(page, RECORD_B)).toContainText('<img src=x onerror="window.__injected=true">');
  await expect(recordDetails(page, RECORD_B).locator('img')).toHaveCount(0);
  await expect(recordDetails(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__receptionReview.calls.filter(call => call.method === 'reception.record.open'))).toEqual([
    { method: RECORD_OPEN, args: { record_id: RECORD_B } },
  ]);
  expect(await receptionWrites(page)).toEqual([]);
});

test('Reception request detail retry keeps keyboard ownership through held failure, retry and success', async ({ page }) => {
  await openReceptionReview(page, { failing: [RECORD_OPEN] });
  await recordToggle(page).focus(); await page.keyboard.press('Enter');
  await expect(recordRetry(page)).toBeVisible();
  await page.evaluate(method => { window.__receptionReview.failing = []; window.__receptionReview.held.push(method); }, RECORD_OPEN);
  await recordRetry(page).focus(); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(method => window.__receptionReview.pending(method), RECORD_OPEN)).toBe(1);
  await expect(recordRetry(page)).toBeFocused();
  await expect(recordRetry(page)).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Enter'); await page.keyboard.press('Space');
  expect(await page.evaluate(() => window.__receptionReview.calls.filter(call => call.method === 'reception.record.open'))).toHaveLength(2);
  await page.evaluate(method => window.__receptionReview.release(method, true), RECORD_OPEN);
  await expect(recordRetry(page)).toBeFocused();
  await expect(recordRetry(page)).not.toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(method => window.__receptionReview.pending(method), RECORD_OPEN)).toBe(1);
  await page.evaluate(method => window.__receptionReview.release(method), RECORD_OPEN);
  await expect(recordDetails(page)).toContainText('Morgan Lake');
  await expect(recordToggle(page)).toBeFocused();
});

for (const owner of ['toggle', 'reply'] as const) test(`Reception request background detail result preserves another record's ${owner} focus`, async ({ page }) => {
  await openReceptionReview(page);
  if (owner === 'reply') {
    await recordToggle(page, RECORD_B).click();
    await expect(recordDetails(page, RECORD_B)).toContainText('Morgan Lake');
  }
  await page.evaluate(method => window.__receptionReview.held.push(method), RECORD_OPEN);
  await recordToggle(page).click();
  await expect.poll(() => page.evaluate(method => window.__receptionReview.pending(method), RECORD_OPEN)).toBe(1);
  const control = owner === 'reply' ? recordDetails(page, RECORD_B).getByRole('link', { name: 'Write to morgan@example.test' }) : recordToggle(page, RECORD_B);
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  await expect(control).toBeInViewport();
  await page.evaluate(method => window.__receptionReview.release(method), RECORD_OPEN);
  await expect(recordDetails(page)).toContainText('Morgan Lake');
  await expect(control).toBeFocused();
  await expect(control).toBeInViewport();
});

test('Reception request reopened while an old read waits accepts only its current opening', async ({ page }) => {
  await openReceptionReview(page, { held: [RECORD_OPEN] });
  await page.evaluate(id => { window.__receptionReview.opened[id] = { ...window.__receptionReview.opened[id]!, answers: [{ label: 'Project brief', value: 'First read' }] }; }, RECORD_A);
  await recordToggle(page).click();
  await expect.poll(() => page.evaluate(method => window.__receptionReview.pending(method), RECORD_OPEN)).toBe(1);
  await recordToggle(page).click();
  await expect(recordDetails(page)).toHaveCount(0);
  await page.evaluate(id => { window.__receptionReview.opened[id] = { ...window.__receptionReview.opened[id]!, answers: [{ label: 'Project brief', value: 'Latest read' }] }; }, RECORD_A);
  await recordToggle(page).click();
  await expect.poll(() => page.evaluate(method => window.__receptionReview.pending(method), RECORD_OPEN)).toBe(2);
  await page.evaluate(method => window.__receptionReview.release(method), RECORD_OPEN);
  await expect(recordDetails(page)).toContainText('Opening');
  await expect(recordDetails(page)).not.toContainText('First read');
  await page.evaluate(method => window.__receptionReview.release(method), RECORD_OPEN);
  await expect(recordDetails(page)).toContainText('Latest read');
});

test('Reception request filters keep the newest answer when an earlier filter finishes later', async ({ page }) => {
  await openReceptionReview(page);
  await page.evaluate(method => window.__receptionReview.held.push(method), RECORD_LIST);
  await page.getByRole('button', { name: 'Bookings', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(method => window.__receptionReview.pending(method), RECORD_LIST)).toBe(1);
  const intake = page.getByRole('button', { name: 'Intake forms', exact: true });
  await intake.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(method => window.__receptionReview.pending(method), RECORD_LIST)).toBe(2);
  await page.evaluate(method => window.__receptionReview.release(method, false, 1), RECORD_LIST);
  await expect(recordRow(page, RECORD_B)).toBeVisible();
  await page.evaluate(method => window.__receptionReview.release(method), RECORD_LIST);
  await expect(recordRow(page)).toHaveCount(0);
  await expect(intake).toBeFocused();
  await expect(intake).toHaveAttribute('aria-pressed', 'true');
});

for (const action of ['approve', 'approve-allow', 'reject'] as const) test(`Reception detached ${action} controls cannot decide a previously selected hold`, async ({ page }) => {
  const first = reviewInboxItem();
  await openReceptionReview(page, { section: 'inbox', items: [first, reviewInboxItem({ hold_id: HOLD_B, args: first.args,
    preview: { title: 'Prepare the customer project brief', subtitle: 'Partner intake' } })] });
  const oldButton = await inboxDecision(page, action).elementHandle();
  const oldForm = await page.getByRole('form', { name: 'Review customer billing request' }).elementHandle();
  await inboxRow(page, HOLD_B).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Prepare the customer project brief', exact: true })).toBeFocused();
  await oldButton!.evaluate(node => (node as HTMLButtonElement).click());
  if (action === 'approve') await oldForm!.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(await receptionWrites(page)).toEqual([]);
  await expect(inboxRow(page, HOLD_A)).toBeVisible();
  await expect(inboxRow(page, HOLD_B)).toHaveAttribute('aria-selected', 'true');
});

test('Reception pending decision guards departure and does not relist after accepted departure', async ({ page }) => {
  await openReceptionReview(page, { section: 'inbox', held: [INBOX_REJECT] });
  await inboxDecision(page, 'reject').focus(); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(method => window.__receptionReview.pending(method), INBOX_REJECT)).toBe(1);
  const decline = page.waitForEvent('dialog').then(dialog => dialog.dismiss());
  await page.evaluate(() => window.__app.setHash('#settings')); await decline;
  await expect(inboxRow(page)).toBeVisible();
  const accept = page.waitForEvent('dialog').then(dialog => dialog.accept());
  await page.evaluate(() => window.__app.setHash('#settings')); await accept;
  await expect(inboxRow(page)).toHaveCount(0);
  const reads = await page.evaluate(method => window.__receptionReview.calls.filter(call => call.method === method).length, INBOX_LIST);
  await page.evaluate(method => window.__receptionReview.release(method), INBOX_REJECT);
  await page.getByRole('searchbox', { name: 'Find a setting', exact: true }).fill('privacy');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect(await page.evaluate(method => window.__receptionReview.calls.filter(call => call.method === method).length, INBOX_LIST)).toBe(reads);
});

for (const outcome of ['failed', 'saved', 'saved-read-failed'] as const) test(`Reception ${outcome} decision preserves later shell focus`, async ({ page }) => {
  await openReceptionReview(page, { section: 'inbox', held: [INBOX_APPROVE] });
  await inboxDecision(page, 'approve').focus(); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(method => window.__receptionReview.pending(method), INBOX_APPROVE)).toBe(1);
  if (outcome === 'saved-read-failed') await page.evaluate(method => window.__receptionReview.failing.push(method), INBOX_LIST);
  const account = page.locator('[data-recued-account-menu-trigger]');
  await account.focus();
  await page.evaluate(({ method, failed }) => window.__receptionReview.release(method, failed), { method: INBOX_APPROVE, failed: outcome === 'failed' });
  if (outcome === 'failed') await expect(page.locator('.reception-inbox-error')).toContainText('temporarily unavailable');
  else await expect(inboxRow(page)).toHaveCount(0);
  if (outcome === 'saved-read-failed') await expect(page.locator('.reception-inbox-error')).toContainText('Saved.');
  await expect(account).toBeFocused();
});

test('Reception attachment acknowledgment preserves keyboard focus and applies only to its selected hold', async ({ page }) => {
  await openReceptionReview(page, { section: 'inbox', held: [INBOX_APPROVE], items: [reviewInboxItem({
    attachment: { file_id: 'review-file', filename: 'Customer brief.pdf', mime_type: 'application/pdf', size: 1200, scan_status: 'unscanned' },
  }), reviewInboxItem({ hold_id: HOLD_B, preview: { title: 'Second attachment' },
    attachment: { file_id: 'review-file-2', filename: 'Second brief.pdf', mime_type: 'application/pdf', size: 2400, scan_status: 'unscanned' } })] });
  const acknowledge = page.getByRole('checkbox', { name: 'I have looked at this file. Attach it anyway' });
  await expect(inboxDecision(page, 'approve')).toBeDisabled();
  await acknowledge.focus(); await page.keyboard.press('Space');
  await expect(acknowledge).toBeChecked(); await expect(acknowledge).toBeFocused();
  await expect(inboxDecision(page, 'approve')).toBeEnabled();
  await inboxRow(page, HOLD_B).focus(); await page.keyboard.press('Enter');
  await expect(acknowledge).not.toBeChecked();
  await expect(inboxDecision(page, 'approve')).toBeDisabled();
  expect(await receptionWrites(page)).toEqual([]);
});

test('Reception initial inbox read failure never claims no requests are waiting and can refresh', async ({ page }) => {
  await openReceptionReview(page, { section: 'inbox', failing: [INBOX_LIST] });
  await expect(page.locator('.reception-inbox-error')).toContainText('temporarily unavailable');
  await expect(page.getByText('Nothing is waiting for you.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Pick something from your inbox.', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.__receptionReview.failing = []; });
  await page.locator('[data-recued-reception-inbox-refresh]').focus(); await page.keyboard.press('Enter');
  await expect(inboxRow(page)).toBeVisible();
  await expect(page.locator('.reception-inbox-error')).toHaveCount(0);
  expect(await receptionWrites(page)).toEqual([]);
});

test('Reception checkbox label and cleared optional field reach the exact approval as false and null', async ({ page }) => {
  const item = reviewInboxItem();
  await openReceptionReview(page, { section: 'inbox', held: [INBOX_APPROVE], items: [reviewInboxItem({
    args: { ...item.args, confirmed: true }, arg_schema: { fields: [...item.arg_schema.fields,
      { key: 'confirmed', type: 'boolean', label: 'Confirmed', required: false }] },
  })] });
  await page.getByText('Confirmed', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Confirmed', exact: true })).not.toBeChecked();
  await page.getByRole('textbox', { name: 'Note', exact: true }).fill('');
  await inboxDecision(page, 'approve').focus(); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(method => window.__receptionReview.pending(method), INBOX_APPROVE)).toBe(1);
  expect(await receptionWrites(page)).toEqual([{ method: INBOX_APPROVE,
    args: { hold_id: HOLD_A, edits: { note: null, confirmed: false } } }]);
  await page.evaluate(method => window.__receptionReview.release(method), INBOX_APPROVE);
  await expect(inboxRow(page)).toHaveCount(0);
});
