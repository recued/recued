import { expect, test } from '@playwright/test';

const BASE = 'http://127.0.0.1:4319/full-app-harness.html?preapproval=1';
for (const [route, activation, approveButton] of [
  ['recipes/autorun-live-1', { kind: 'next_auto_run', recipe_id: 'autorun-live-1', publisher_id: 'recued-core', expected_revision: 7 }, 'Approve and arm'],
  ['automation/auto-run/autorun-live-1', { kind: 'next_auto_run', recipe_id: 'autorun-live-1', publisher_id: 'recued-core', expected_revision: 7 }, 'Approve and arm'],
  ['automation/triggers/browser-trigger', { kind: 'next_trigger', trigger_id: 'browser-trigger', expected_revision: 7 }, 'Approve and arm'],
  ['automation/schedules/browser-schedule', { kind: 'next_schedule', schedule_id: 'browser-schedule', expected_revision: 7 }, 'Approve and schedule'],
] as const) {
  test(`manual review from ${route} retains its request on response loss`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${BASE}&recipes=installed&automation=rules&run_palette=autorun&preapproval_automation=1&preapproval_prepare_reply=lost#${route}`);
    await expect(page.locator('html')).toHaveAttribute('data-recued-owner-surface', '');
    await page.getByRole('button', { name: 'Review next run', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Review next execution' });
    await expect(dialog).toContainText('next qualifying execution');
    await dialog.getByRole('button', { name: 'Review execution', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Preparation response was lost');
    await dialog.getByRole('button', { name: 'Review execution', exact: true }).click();
    const review = page.locator('[data-recued-preapproval-route]');
    await expect(review.getByRole('button', { name: approveButton })).toBeEnabled();
    await expect(review).toContainText('next eligible execution only');
    expect(await page.evaluate(() => window.__app.rpcCallCount('auto_run.update'))).toBe(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
    const attempts = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-preapproval-prepare-attempts')!));
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]).toMatchObject({ subject: { recipe_id: 'autorun-live-1', config: {} }, activation });
    if (activation.kind === 'next_schedule') expect(attempts[0].dispatch_deadline).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    await review.getByRole('button', { name: approveButton }).click();
    await expect(review).toContainText('Execution: active');
    await page.goto(`${BASE}&recipes=installed&automation=rules&run_palette=autorun&preapproval_automation=1#${route}`);
    await page.getByRole('link', { name: 'Review approval', exact: true }).click();
    await expect(review).toContainText('Execution: active');
    await review.getByRole('button', { name: 'Revoke unused approval' }).click();
    await expect(review).toContainText('Execution: cancelled');
    expect(errors).toEqual([]);
  });
}
test('a saved mail draft reopens, updates and schedules through the same owner review', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${BASE}&mail_drafts=1#mail`);
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New mail' });
  await dialog.locator('[data-form-array-add="to"]').click();
  await dialog.locator('[data-form-array-item="to"]').fill('alex@example.test');
  await dialog.locator('[data-form-field="subject"]').fill('Saved <img src=x> report');
  await dialog.locator('[data-form-field="body"]').fill('The complete reviewed message.');
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog.locator('[data-mail-draft-status]')).toHaveText('Draft saved.');
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.prepare'))).toBe(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Saved <img src=x> report', exact: true }).click();
  await expect(dialog.locator('[data-form-field="body"]')).toHaveValue('The complete reviewed message.');
  await dialog.locator('[data-form-field="body"]').fill('The revised message.');
  await dialog.getByRole('button', { name: 'Schedule…', exact: true }).click();
  await dialog.locator('[data-mail-draft-time]').fill('2030-01-02T09:30');
  await dialog.getByRole('button', { name: 'Review scheduled send', exact: true }).click();
  const review = page.locator('[data-recued-preapproval-route]');
  await expect(review).toContainText('The revised message.');
  await expect(review).toContainText('Saved <img src=x> report');
  await expect(review.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('mail.drafts.update'))).toBe(1);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('schedules.create'))).toBe(0);
  await review.getByRole('button', { name: 'Approve and schedule' }).click();
  await expect(review).toContainText('Execution: active');
  expect(errors).toEqual([]);
});

test('retrying a lost draft save retains one draft and does not prepare a send', async ({ page }) => {
  await page.goto(`${BASE}&mail_drafts=1&draft_reply=lost#mail`);
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New mail' });
  await dialog.locator('[data-form-array-add="to"]').click();
  await dialog.locator('[data-form-array-item="to"]').fill('alex@example.test');
  await dialog.locator('[data-form-field="subject"]').fill('Retried draft');
  await dialog.locator('[data-form-field="body"]').fill('Retained body.');
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Draft response was lost');
  await expect(dialog.locator('[data-form-field="body"]')).toHaveValue('Retained body.');
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog.locator('[data-mail-draft-status]')).toHaveText('Draft saved.');
  await expect(page.locator('[data-mail-draft-id]')).toHaveCount(1);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.prepare'))).toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
});
test('manual recipe scheduling prepares one review before any activation or approval', async ({ page }) => {
  await page.goto(`${BASE}&recipes=installed#recipes`);
  await page.locator('[data-recued-recipes-run-button]').first().click();
  const dialog = page.getByRole('dialog', { name: 'Run a recipe' });
  await dialog.getByRole('tab', { name: 'Schedule' }).click();
  await dialog.getByRole('checkbox', { name: 'Repeat' }).uncheck();
  await dialog.getByRole('textbox', { name: 'Run once at' }).fill('2030-01-02T09:30');
  await dialog.getByRole('button', { name: 'Review and pre-approve' }).click();
  const review = page.locator('[data-recued-preapproval-route]');
  await expect(review.getByRole('button', { name: 'Approve and schedule' })).toBeEnabled();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.prepare'))).toBe(1);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('schedules.create'))).toBe(0);
  await page.goBack(); await expect(page.locator('[data-recued-recipes-route]')).toBeVisible();
  await page.goForward(); await expect(review).toBeVisible();
});
test('expired review content retains its outcome without reopening an approval', async ({ page }) => {
  await page.goto(`${BASE}&preapproval_retired=1#approvals/preapproval/pap_browser`);
  const review = page.locator('[data-recued-preapproval-route]');
  await expect(review).toContainText('Execution: expired');
  await expect(review).toContainText('Review content expired');
  await expect(review).toContainText('decision and operation outcomes remain available');
  await expect(review.getByRole('checkbox')).toHaveCount(0);
  await expect(review.getByRole('button', { name: /Approve|Schedule|Revoke/ })).toHaveCount(0);
});

test('one protected ask opens the complete review, schedules once, survives reload and revokes unused approval', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${BASE}#approvals`);
  const card = page.locator('[data-recued-preapproval-ask]');
  await expect(card).toBeVisible(); await expect(card.getByRole('button')).toHaveCount(0);
  await card.getByRole('link', { name: 'Review execution' }).click();
  const review = page.locator('[data-recued-preapproval-route]');
  await expect(review).toContainText('Scheduling assistant');
  await expect(review).toContainText('Office MCP client');
  await expect(review).toContainText('Reviewed <img src=x onerror=alert(1)> content');
  await expect(review.locator('img')).toHaveCount(0);
  await expect(review).toContainText('report.pdf'); await expect(review).toContainText('test/crm.record');
  for (const [op, riskText] of [
    ['core.mail.send', 'Writes data.'],
    ['core.storage.data-file-read', 'Reads only.'],
    ['test/crm.record', 'Writes data.'],
  ]) {
    await expect(review.locator('article').filter({ hasText: op }).locator('[data-preapproval-risk]'))
      .toHaveText(riskText);
  }
  await expect(review.getByRole('checkbox')).toHaveCount(2);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
  await review.getByRole('button', { name: 'Approve and schedule' }).evaluate(button => {
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await expect(review).toContainText('Execution: active');
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(1);
  expect(await page.evaluate(() => window.__app.rpcCallCount('notification.submitAnswer'))).toBe(0);
  await page.reload(); await expect(review).toContainText('Execution: active');
  await expect(review).toContainText('Quarterly report'); await expect(review).toContainText('report.pdf');
  await expect(review.getByRole('button', { name: 'Approve and schedule' })).toHaveCount(0);
  await review.getByRole('button', { name: 'Revoke unused approval' }).click();
  await expect(review).toContainText('Execution: cancelled');
  expect(errors).toEqual([]);
});

test('changing scope requires a refreshed review and retains the required child', async ({ page }) => {
  await page.goto(`${BASE}#approvals/preapproval/pap_browser`);
  const review = page.locator('[data-recued-preapproval-route]');
  await review.getByRole('checkbox', { name: 'Record delivery' }).uncheck();
  await expect(review.getByRole('button', { name: 'Approve and schedule' })).toBeDisabled();
  await review.getByRole('button', { name: 'Update review' }).click();
  await expect(review).toContainText('Partial coverage');
  await expect(review.getByRole('checkbox', { name: 'Send reviewed email' })).toBeChecked();
  await expect(review).toContainText('Required read or sub-operation: report.pdf');
  await expect(review.getByRole('button', { name: 'Approve and schedule' })).toBeEnabled();
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
});

test('a lost decision response can be reconciled without another approval', async ({ page }) => {
  await page.goto(`${BASE}&preapproval_reply=lost#approvals/preapproval/pap_browser`);
  const review = page.locator('[data-recued-preapproval-route]');
  await review.getByRole('button', { name: 'Approve and schedule' }).click();
  await expect(review.getByRole('alert')).toContainText('Decision response was lost');
  await review.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(review).toContainText('Execution: active');
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.decide'))).toBe(1);
});
