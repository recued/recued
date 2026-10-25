import { test, expect, type Page } from '@playwright/test';
const open = async (page: Page, width: number, scenario = '', extra = '&seed=1') => {
  await page.setViewportSize({ width, height: 900 }); await page.goto('/automation-rehearsal-harness.html?scenario=' + scenario + extra);
};
const fixture = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('automation-rehearsal-fixture')!));
const runAndReview = async (page: Page) => {
  await page.getByRole('button', { name: 'Test saved configuration', exact: true }).click();
  await page.getByRole('button', { name: 'Review configuration activation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review exact configuration', exact: true })).toBeVisible();
};
for (const width of [280, 1280]) {
  test(`distinguishes saved proof from working and unadded scenario edits at ${width}px`, async ({ page }) => {
    await open(page, width);
    const working = page.locator('[data-rehearsal-working-state]');
    const tested = page.locator('[data-rehearsal-test-state]');
    const reviewed = page.locator('[data-rehearsal-review-state]');
    await expect(working).toHaveText('Saved version 1');
    await expect(tested).toHaveText('Not tested');
    await runAndReview(page);
    await expect(tested).toHaveText('1 passed · version 1');
    await expect(reviewed).toHaveText('Ready to activate');

    await page.getByLabel('Rehearsal title').fill('Changed after review');
    await expect(working).toHaveText('Unsaved changes');
    await expect(tested).toHaveText('Save before testing');
    await expect(reviewed).toHaveText('Save and test changes');
    await expect(page.getByRole('region', { name: 'Activation review', exact: true, includeHidden: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Activate reviewed configuration', includeHidden: true })).toBeDisabled();
    expect((await fixture(page)).applied).toBe(0);

    await page.getByRole('button', { name: 'Save scenario version', exact: true }).click();
    await expect(working).toHaveText('Saved version 2');
    await expect(tested).toHaveText('Not tested');
    await page.getByRole('button', { name: 'Test saved configuration', exact: true }).click();
    await expect(tested).toHaveText('1 passed · version 2');
    await page.getByText('Add scenario', { exact: true }).click();
    await page.getByLabel('Scenario name', { exact: true }).fill('Not added yet');
    await expect(page.locator('[data-rehearsal-builder-status]')).toBeVisible();
    await expect(working).toHaveText('Saved version 2');
    await expect(tested).toHaveText('1 passed · version 2');
    expect((await fixture(page)).view.draft.document.cases).toHaveLength(1);
  });
  test(`expires displayed proof and review without moving field focus at ${width}px`, async ({ page }) => {
    await open(page, width); await runAndReview(page);
    const title = page.getByLabel('Rehearsal title'); await title.focus();
    await page.evaluate(() => { const instant = Date.now() + 16 * 60_000; Date.now = () => instant; });
    await expect(page.locator('[data-rehearsal-test-state]')).toHaveText('Test expired');
    await expect(page.locator('[data-rehearsal-review-state]')).toHaveText('Review expired');
    await expect(page.getByRole('button', { name: 'Review configuration activation' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Activate reviewed configuration' })).toBeDisabled();
    await expect(title).toBeFocused(); expect((await fixture(page)).applied).toBe(0);
  });
  test(`cancels private cleanup without deleting scenarios or invalidating review at ${width}px`, async ({ page }) => {
    await open(page, width); await runAndReview(page);
    const before = (await fixture(page)).view.draft;
    await page.getByRole('button', { name: 'Delete saved rehearsal and history', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel deletion', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Deletion canceled. Saved rehearsal is unchanged.');
    await expect(page.getByRole('button', { name: 'Confirm delete rehearsal' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Activate reviewed configuration' })).toBeEnabled();
    const state = await fixture(page);
    expect(state.view.draft).toEqual(before); expect(state.applied).toBe(0);
    expect(state.calls.filter((item: { method: string }) => item.method === 'automation.rehearsal.delete')).toHaveLength(0);
  });
  test(`keeps dispatched cleanup recoverable after a lost reply at ${width}px`, async ({ page }) => {
    await open(page, width, 'lost-delete');
    await page.getByRole('button', { name: 'Delete saved rehearsal and history', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm delete rehearsal', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Delete reply lost');
    await expect(page.getByRole('button', { name: 'Cancel deletion', exact: true })).toHaveCount(0);
    await expect(page.locator('[data-rehearsal-working-state]')).toHaveText('Cleanup reply pending');
    await expect(page.locator('[data-rehearsal-review-state]')).toHaveText('Cleanup reply pending');
    const committed = (await fixture(page)).view.revision;
    await page.getByRole('button', { name: 'Confirm delete rehearsal', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Deleted saved rehearsal');
    const state = await fixture(page), calls = state.calls.filter((item: { method: string }) => item.method === 'automation.rehearsal.delete');
    expect(calls).toHaveLength(2); expect(calls[0].args).toEqual(calls[1].args);
    expect(state.view.revision).toBe(committed); expect(state.view.draft).toBeNull(); expect(state.applied).toBe(0);
  });
  test(`authors event scenarios before explicit reviewed activation at ${width}px`, async ({ page }) => {
    await open(page, width, '', ''); await page.getByLabel('Automation enabled after activation').check();
    await page.getByText('Add scenario', { exact: true }).click(); await page.getByLabel('Scenario name', { exact: true }).fill('Ready task event');
    await page.getByLabel('Current record (JSON)', { exact: true }).fill('{"status":"ready"}');
    await page.getByRole('button', { name: 'Add scenario to rehearsal', exact: true }).click();
    await page.getByRole('button', { name: 'Save scenario version', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved scenario version 1'); expect((await fixture(page)).view.current.enabled).toBe(false);
    await runAndReview(page); expect((await fixture(page)).applied).toBe(0);
    await page.getByRole('button', { name: 'Activate reviewed configuration', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Committed configuration revision 1'); expect((await fixture(page)).applied).toBe(1);
    expect((await fixture(page)).calls.every((item: { method: string }) => item.method.startsWith('automation.rehearsal.'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`compares and activates recurring clock scenarios at ${width}px`, async ({ page }) => {
    await open(page, width, '', '&seed=1&kind=schedule'); await runAndReview(page);
    await expect(page.getByText(/Selected event or clock: skip → start/)).toBeVisible();
    await page.getByRole('button', { name: 'Activate reviewed configuration' }).click();
    await expect(page.getByRole('status')).toContainText('Committed configuration revision 1'); expect((await fixture(page)).view.current.cron_expression).toBe('*/5 * * * *');
  });
  test(`requires an explicit timer circuit reset in the tested proposal at ${width}px`, async ({ page }) => {
    await open(page, width, 'circuit', '&seed=1&kind=timer'); await page.getByRole('button', { name: 'Test saved configuration' }).click();
    await expect(page.getByRole('status')).toContainText('1 failed');
    await page.getByLabel('Reset a tripped timer circuit on activation').check(); await page.getByRole('button', { name: 'Save scenario version' }).click();
    await runAndReview(page); expect((await fixture(page)).applied).toBe(0); await page.getByRole('button', { name: 'Activate reviewed configuration' }).click();
    await expect(page.getByRole('status')).toContainText('Committed configuration revision 1'); expect((await fixture(page)).view.current.reset_circuit).toBe(false);
    await page.getByText('Configuration activation history', { exact: true }).click(); await expect(page.getByText('Timer circuit reset on activation.', { exact: true })).toBeVisible();
  });
  test(`failing cases and unsaved edits cannot reuse passing proof at ${width}px`, async ({ page }) => {
    await open(page, width, 'failed'); await page.getByRole('button', { name: 'Test saved configuration' }).click();
    await expect(page.getByRole('status')).toContainText('1 failed'); await expect(page.getByRole('button', { name: 'Review configuration activation' })).toHaveCount(0);
    await page.getByLabel('Rehearsal title').fill('Unfinished edits'); await expect(page.getByRole('button', { name: 'Test saved configuration' })).toBeDisabled();
    await page.evaluate(() => dispatchEvent(new Event('query-rehearsal-work'))); await expect(page.locator('body')).toHaveAttribute('data-unsaved', 'true');
  });
  test(`recovers a lost activation reply without applying twice at ${width}px`, async ({ page }) => {
    await open(page, width, 'lost-activation'); await runAndReview(page); await page.getByRole('button', { name: 'Activate reviewed configuration' }).click();
    await expect(page.getByRole('alert')).toContainText('Activation reply lost'); await page.getByRole('button', { name: 'Activate reviewed configuration' }).click();
    await expect(page.getByRole('status')).toContainText('Committed configuration revision 1'); const state = await fixture(page);
    const calls = state.calls.filter((item: { method: string }) => item.method === 'automation.rehearsal.activate');
    expect(state.applied).toBe(1); expect(calls).toHaveLength(2); expect(calls[0].args).toEqual(calls[1].args);
    await page.reload(); await expect(page.getByRole('button', { name: 'Test saved configuration' })).toBeDisabled();
  });
  test(`recovers a lost save while retaining newer working edits at ${width}px`, async ({ page }) => {
    await open(page, width, 'lost-save'); await page.getByLabel('Rehearsal title').fill('Saved title'); await page.getByRole('button', { name: 'Save scenario version' }).click();
    await page.getByLabel('Rehearsal title').fill('Newer working title'); await page.evaluate(() => dispatchEvent(new Event('finish-rehearsal')));
    await expect(page.getByRole('alert')).toContainText('Save reply lost'); await page.getByRole('button', { name: 'Save scenario version' }).click();
    await expect(page.getByRole('alert')).toBeEmpty(); await expect(page.getByLabel('Rehearsal title')).toHaveValue('Newer working title');
    await expect(page.getByRole('button', { name: 'Test saved configuration' })).toBeDisabled();
    const state = await fixture(page), calls = state.calls.filter((item: { method: string }) => item.method === 'automation.rehearsal.save');
    expect(calls).toHaveLength(2); expect(calls[0].args).toEqual(calls[1].args); expect(state.view.draft.document.title).toBe('Saved title');
    await page.getByRole('button', { name: 'Save scenario version' }).click(); await expect(page.getByRole('status')).toContainText('Saved scenario version 3');
    expect((await fixture(page)).view.draft.document.title).toBe('Newer working title');
  });
  test(`retains ownership of pending work without stealing outside focus at ${width}px`, async ({ page }) => {
    await open(page, width, 'slow-test'); await page.getByRole('button', { name: 'Test saved configuration' }).click();
    await page.evaluate(() => dispatchEvent(new Event('query-rehearsal-work'))); await expect(page.locator('body')).toHaveAttribute('data-busy', 'true');
    await page.locator('#outside').focus(); await page.evaluate(() => dispatchEvent(new Event('finish-rehearsal')));
    await expect(page.getByRole('button', { name: 'Review configuration activation' })).toBeVisible(); await expect(page.locator('#outside')).toBeFocused();
  });
  test(`restores keyboard focus after a scenario test at ${width}px`, async ({ page }) => {
    await open(page, width); const button = page.getByRole('button', { name: 'Test saved configuration' }); await button.focus(); await button.press('Enter');
    await expect(page.getByRole('button', { name: 'Review configuration activation' })).toBeVisible(); await expect(button).toBeFocused();
  });
  test(`holds stale configuration before activation review at ${width}px`, async ({ page }) => {
    await open(page, width, 'stale'); await page.getByRole('button', { name: 'Test saved configuration' }).click(); await page.getByRole('button', { name: 'Review configuration activation' }).click();
    await expect(page.getByRole('alert')).toContainText('Automation configuration changed'); await expect(page.getByRole('button', { name: 'Activate reviewed configuration' })).toHaveCount(0);
    expect((await fixture(page)).applied).toBe(0);
  });
  test(`loads retained cases as a guarded working copy at ${width}px`, async ({ page }) => {
    await open(page, width); await page.getByLabel('Rehearsal title').fill('Latest saved scenarios'); await page.getByRole('button', { name: 'Save scenario version' }).click();
    await expect(page.getByRole('status')).toContainText('Saved scenario version 2'); await page.getByLabel('Saved scenario version', { exact: true }).selectOption('1');
    await page.getByRole('button', { name: 'Load selected scenario version' }).click(); await expect(page.getByLabel('Rehearsal title')).toHaveValue('Saved automation scenarios');
    await expect(page.getByRole('button', { name: 'Test saved configuration' })).toBeDisabled(); expect((await fixture(page)).view.draft.document.title).toBe('Latest saved scenarios');
  });
  test(`rejects malformed or forged advanced documents and releases its lease at ${width}px`, async ({ page }) => {
    await open(page, width); await page.getByText('Advanced rehearsal document', { exact: true }).click(); const valid = (await fixture(page)).view.draft.document;
    for (const broken of [{ ...valid, source: 'owner' }, { ...valid, candidate: null }, { ...valid, cases: [null] }]) {
      const text = JSON.stringify(broken); await page.getByLabel('Rehearsal document (JSON)', { exact: true }).fill(text);
      await page.getByRole('button', { name: 'Save scenario version', exact: true }).click(); await expect(page.getByRole('alert')).not.toBeEmpty();
      await expect(page.getByLabel('Rehearsal document (JSON)', { exact: true })).toHaveValue(text); await expect(page.getByRole('button', { name: 'Save scenario version' })).toBeEnabled();
      await page.evaluate(() => dispatchEvent(new Event('query-rehearsal-work'))); await expect(page.locator('body')).toHaveAttribute('data-leases', '0');
    }
    expect((await fixture(page)).calls.filter((item: { method: string }) => item.method === 'automation.rehearsal.save')).toHaveLength(0);
  });
  test(`keeps partial filter JSON editable until a valid save at ${width}px`, async ({ page }) => {
    await open(page, width); const field = page.getByLabel('Payload filter (JSON or null)', { exact: true });
    await field.fill('{'); await page.getByRole('button', { name: 'Save scenario version' }).click(); await expect(page.getByRole('alert')).not.toBeEmpty(); await expect(field).toHaveValue('{');
    await field.fill('{"record.status":"ready"}'); await page.getByRole('button', { name: 'Save scenario version' }).click();
    await expect(page.getByRole('status')).toContainText('Saved scenario version 2'); await expect(page.getByRole('button', { name: 'Test saved configuration' })).toBeEnabled();
  });
  test(`allows replacing temporarily empty title and cron fields at ${width}px`, async ({ page }) => {
    await open(page, width, '', '&seed=1&kind=schedule'); await page.getByLabel('Rehearsal title').fill(''); await page.getByLabel('Rehearsal title').fill('New clock cases');
    await page.getByLabel('Cron expression').fill(''); await page.getByLabel('Cron expression').fill('*/10 * * * *'); await page.getByRole('button', { name: 'Save scenario version' }).click();
    await expect(page.getByRole('status')).toContainText('Saved scenario version 2'); expect((await fixture(page)).view.draft.document.candidate.cron_expression).toBe('*/10 * * * *');
  });
  test(`keeps dispatched work tracked after the editor is disposed at ${width}px`, async ({ page }) => {
    await open(page, width, 'slow-test'); await page.getByRole('button', { name: 'Test saved configuration' }).click();
    await page.evaluate(() => { dispatchEvent(new Event('dispose-rehearsal')); dispatchEvent(new Event('query-rehearsal-work')); });
    await expect(page.locator('body')).toHaveAttribute('data-leases', '1'); await page.evaluate(() => dispatchEvent(new Event('finish-rehearsal')));
    await expect.poll(async () => page.evaluate(() => { dispatchEvent(new Event('query-rehearsal-work')); return document.body.dataset.leases; })).toBe('0');
  });
  test(`allows private cleanup when the automation no longer exists at ${width}px`, async ({ page }) => {
    await open(page, width, 'unsupported'); await expect(page.getByText('This automation is no longer available.')).toBeVisible();
    await page.getByRole('button', { name: 'Delete saved rehearsal and history' }).click(); await page.getByRole('button', { name: 'Confirm delete rehearsal' }).click();
    await expect(page.getByRole('status')).toContainText('Deleted saved rehearsal'); await expect(page.getByRole('status')).toBeFocused(); expect((await fixture(page)).applied).toBe(0);
  });
  test(`keeps structured filter changes when editing the advanced document at ${width}px`, async ({ page }) => {
    await open(page, width); await page.getByLabel('Payload filter (JSON or null)', { exact: true }).fill('{"record.status":"blocked"}');
    await page.getByText('Advanced rehearsal document', { exact: true }).click(); const editor = page.getByLabel('Rehearsal document (JSON)', { exact: true });
    const document = JSON.parse(await editor.inputValue()); expect(document.candidate.filter).toEqual({ 'record.status': 'blocked' });
    await editor.fill(JSON.stringify({ ...document, title: 'Advanced title keeps filter' })); await page.getByRole('button', { name: 'Save scenario version' }).click();
    await expect(page.getByRole('status')).toContainText('Saved scenario version 2'); expect((await fixture(page)).view.draft.document.candidate.filter).toEqual({ 'record.status': 'blocked' });
  });
  test(`deleting saved history keeps an unsaved working proposal at ${width}px`, async ({ page }) => {
    await open(page, width); await page.getByLabel('Rehearsal title').fill('Unsaved proposal to keep');
    await page.getByRole('button', { name: 'Delete saved rehearsal and history' }).click(); await page.getByRole('button', { name: 'Confirm delete rehearsal' }).click();
    await expect(page.getByLabel('Rehearsal title')).toHaveValue('Unsaved proposal to keep'); await expect(page.getByRole('button', { name: 'Test saved configuration' })).toBeDisabled();
    expect((await fixture(page)).view.draft).toBeNull(); await page.getByRole('button', { name: 'Save scenario version' }).click(); await expect(page.getByRole('status')).toContainText('Saved scenario version 3');
  });
  test(`reload can discard an unfinished scenario form and release its navigation guard at ${width}px`, async ({ page }) => {
    await open(page, width); await page.getByText('Add scenario', { exact: true }).click(); await page.getByLabel('Scenario name', { exact: true }).fill('Unfinished scenario');
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Reload saved rehearsal' }).click();
    await page.evaluate(() => dispatchEvent(new Event('query-rehearsal-work'))); await expect(page.locator('body')).toHaveAttribute('data-unsaved', 'false');
    await expect(page.getByLabel('Scenario name', { exact: true })).toHaveValue('');
  });
  test(`protects partial filter text from replacement by the advanced editor at ${width}px`, async ({ page }) => {
    await open(page, width); await page.getByLabel('Payload filter (JSON or null)', { exact: true }).fill('{');
    await page.getByText('Advanced rehearsal document', { exact: true }).click(); const editor = page.getByLabel('Rehearsal document (JSON)', { exact: true });
    await expect(editor).toHaveAttribute('readonly', ''); await expect(page.getByText('Complete the payload filter before replacing the advanced document.')).toBeVisible();
    await page.getByLabel('Payload filter (JSON or null)', { exact: true }).fill('null'); await expect(editor).not.toHaveAttribute('readonly', '');
  });
  test(`preserves scenario form edits typed during reload at ${width}px`, async ({ page }) => {
    await open(page, width, 'slow-reload'); await page.getByRole('button', { name: 'Reload saved rehearsal' }).click();
    await page.getByText('Add scenario', { exact: true }).click(); await page.getByLabel('Current record (JSON)', { exact: true }).fill('{"status":"pending"}');
    await page.evaluate(() => dispatchEvent(new Event('finish-rehearsal'))); await expect(page.getByLabel('Current record (JSON)', { exact: true })).toHaveValue('{"status":"pending"}');
    await page.evaluate(() => dispatchEvent(new Event('query-rehearsal-work'))); await expect(page.locator('body')).toHaveAttribute('data-unsaved', 'true');
    await page.getByRole('button', { name: 'Clear scenario form' }).click(); await page.evaluate(() => dispatchEvent(new Event('query-rehearsal-work')));
    await expect(page.locator('body')).toHaveAttribute('data-unsaved', 'false');
  });
  for (const kind of ['trigger', 'schedule', 'timer']) test(`keeps the actual ${kind} editor across Automation navigation and refresh at ${width}px`, async ({ page }) => {
    await open(page, width, '', '&seed=1&route=1&kind=' + kind); await page.locator('summary').filter({ hasText: /^Rehearsal and reviewed activation$/ }).click();
    const title = page.getByLabel('Rehearsal title'); await title.fill('Kept across Automation navigation');
    await page.evaluate(() => dispatchEvent(new Event('refresh-automation'))); await expect(title).toBeFocused(); await expect(title).toHaveValue('Kept across Automation navigation');
    await page.getByRole('button', { name: /^Back to / }).click(); await page.getByRole('button', { name: /^Details Fixture recipe / }).click();
    await expect(title).toHaveValue('Kept across Automation navigation'); await page.evaluate(() => dispatchEvent(new Event('query-rehearsal-work')));
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'true');
  });
}
