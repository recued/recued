import { test, expect, type Page } from '@playwright/test';
const open = async (page: Page, width: number, scenario = '', extra = '&seed=1') => {
  await page.setViewportSize({ width, height: 900 }); await page.goto('/permission-regression-harness.html?scenario=' + scenario + extra);
};
const fixture = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('permission-regression-fixture')!));
const runAndReview = async (page: Page) => {
  await page.getByRole('button', { name: 'Test saved grant draft', exact: true }).click();
  await page.getByRole('button', { name: 'Review grant activation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review exact grant changes' })).toBeVisible();
};
for (const width of [280, 1280]) {
  test(`authors a case and grant change before explicit reviewed activation at ${width}px`, async ({ page }) => {
    await open(page, width, '', '');
    await page.getByText('Add permission example', { exact: true }).click(); await page.getByLabel('Example name', { exact: true }).fill('Tasks visible');
    await page.getByLabel('Credential', { exact: true }).selectOption({ label: 'Original assistant' });
    await page.getByLabel('Check', { exact: true }).selectOption('collection');
    await page.getByLabel('Operation or read grant', { exact: true }).selectOption({ label: 'Task collection' });
    await page.getByLabel('Expected result', { exact: true }).selectOption('allow'); await page.getByRole('button', { name: 'Add example', exact: true }).click();
    await page.getByLabel('Permission to change').selectOption('data.task'); await page.getByLabel('Proposed value').selectOption('null');
    await page.getByRole('button', { name: 'Add grant change', exact: true }).click();
    await page.getByRole('button', { name: 'Save test version', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Saved test version 1');
    expect((await fixture(page)).view.grants).toEqual([{ entry_key: 'data.task', granted: false }]);
    await runAndReview(page); expect((await fixture(page)).applied).toBe(0);
    await page.getByRole('button', { name: 'Activate reviewed grants', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Activated permission revision 2');
    expect((await fixture(page)).applied).toBe(1); expect((await fixture(page)).calls.every((item: { method: string }) => item.method.startsWith('contract.regression.'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`failing cases and unsaved edits cannot use a previous passing result at ${width}px`, async ({ page }) => {
    await open(page, width, 'failed'); await page.getByRole('button', { name: 'Test saved grant draft' }).click();
    await expect(page.getByRole('status')).toContainText('1 failed'); await expect(page.getByRole('button', { name: 'Review grant activation' })).toHaveCount(0);
    await page.getByLabel('Test suite title').fill('Unfinished title'); await expect(page.getByRole('button', { name: 'Test saved grant draft' })).toBeDisabled();
    await page.evaluate(() => dispatchEvent(new Event('query-permission-work'))); await expect(page.locator('body')).toHaveAttribute('data-unsaved', 'true');
  });
  test(`lost activation replies recover one recorded change with the same request id at ${width}px`, async ({ page }) => {
    await open(page, width, 'lost-activation'); await runAndReview(page); await page.getByRole('button', { name: 'Activate reviewed grants' }).click();
    await expect(page.getByRole('alert')).toContainText('Activation reply lost'); await page.getByRole('button', { name: 'Activate reviewed grants' }).click();
    await expect(page.getByRole('status')).toContainText('Activated permission revision 2');
    const state = await fixture(page), calls = state.calls.filter((item: { method: string }) => item.method === 'contract.regression.activate');
    expect(state.applied).toBe(1); expect(calls).toHaveLength(2); expect(calls[0].args).toEqual(calls[1].args);
    await page.reload(); await expect(page.getByRole('button', { name: 'Test saved grant draft' })).toBeDisabled();
  });
  test(`preserves working edits made during save and keeps them guarded at ${width}px`, async ({ page }) => {
    await open(page, width, 'slow-save'); await page.getByLabel('Test suite title').fill('Title being saved'); await page.getByRole('button', { name: 'Save test version' }).click();
    await page.getByLabel('Test suite title').fill('Newer working edits'); await page.evaluate(() => dispatchEvent(new Event('finish-permission')));
    await expect(page.getByLabel('Test suite title')).toHaveValue('Newer working edits'); await expect(page.getByRole('button', { name: 'Save test version' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Test saved grant draft' })).toBeDisabled();
    expect((await fixture(page)).view.draft.document.title).toBe('Title being saved');
  });
  test(`guards a pending check and respects outside focus at ${width}px`, async ({ page }) => {
    await open(page, width, 'slow-test'); await page.getByRole('button', { name: 'Test saved grant draft' }).click();
    await page.evaluate(() => dispatchEvent(new Event('query-permission-work'))); await expect(page.locator('body')).toHaveAttribute('data-busy', 'true');
    await page.locator('#outside').focus(); await page.evaluate(() => dispatchEvent(new Event('finish-permission')));
    await expect(page.getByRole('button', { name: 'Review grant activation' })).toBeVisible(); await expect(page.locator('#outside')).toBeFocused();
  });
  test(`recovers a lost save while preserving edits made during that save at ${width}px`, async ({ page }) => {
    await open(page, width, 'lost-slow-save'); await page.getByLabel('Test suite title').fill('First saved title');
    await page.getByRole('button', { name: 'Save test version', exact: true }).click();
    await page.getByLabel('Test suite title').fill('Newer working title'); await page.evaluate(() => dispatchEvent(new Event('finish-permission')));
    await expect(page.getByRole('alert')).toContainText('Save reply lost');
    await page.getByRole('button', { name: 'Save test version', exact: true }).click();
    await expect(page.getByRole('alert')).toBeEmpty(); await expect(page.getByLabel('Test suite title')).toHaveValue('Newer working title');
    await expect(page.getByRole('button', { name: 'Test saved grant draft', exact: true })).toBeDisabled();
    const recovered = await fixture(page), calls = recovered.calls.filter((item: { method: string }) => item.method === 'contract.regression.save');
    expect(calls).toHaveLength(2); expect(calls[0].args).toEqual(calls[1].args); expect(recovered.view.draft.document.title).toBe('First saved title');
    await page.getByRole('button', { name: 'Save test version', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved test version 3'); expect((await fixture(page)).view.draft.document.title).toBe('Newer working title');
  });
  test(`stale policy prevents review and cannot activate grants at ${width}px`, async ({ page }) => {
    await open(page, width, 'stale'); await page.getByRole('button', { name: 'Test saved grant draft' }).click(); await page.getByRole('button', { name: 'Review grant activation' }).click();
    await expect(page.getByRole('alert')).toContainText('Live policy changed'); await expect(page.getByRole('button', { name: 'Activate reviewed grants' })).toHaveCount(0); expect((await fixture(page)).applied).toBe(0);
  });
  test(`restores a historical revision as an unqualified draft at ${width}px`, async ({ page }) => {
    await open(page, width); await runAndReview(page); await page.getByRole('button', { name: 'Activate reviewed grants' }).click();
    await page.getByText('Permission revision history', { exact: true }).click(); await page.getByRole('button', { name: 'Restore revision 1 as draft' }).click();
    await expect(page.getByRole('status')).toContainText('Restored as a draft'); await expect(page.getByRole('button', { name: 'Review grant activation' })).toHaveCount(0);
    expect((await fixture(page)).applied).toBe(1); expect((await fixture(page)).view.draft.document.changes).toEqual([{ entry_key: 'data.task', granted: false }]);
  });
  test(`loads retained cases as a guarded working copy at ${width}px`, async ({ page }) => {
    await open(page, width); await page.getByLabel('Test suite title').fill('Latest saved cases'); await page.getByRole('button', { name: 'Save test version' }).click();
    await expect(page.getByRole('status')).toContainText('Saved test version 2');
    await page.getByLabel('Saved test version', { exact: true }).selectOption('1'); await page.getByRole('button', { name: 'Load selected test version' }).click();
    await expect(page.getByLabel('Test suite title')).toHaveValue('Saved permission cases'); await expect(page.getByRole('button', { name: 'Test saved grant draft' })).toBeDisabled();
    expect((await fixture(page)).view.draft.document.title).toBe('Latest saved cases');
  });
  test(`rejects forged advanced fields without making a save call at ${width}px`, async ({ page }) => {
    await open(page, width); await page.getByText('Advanced test document', { exact: true }).click();
    const value = { ...(await fixture(page)).view.draft.document, source: { actor: 'user_self' } };
    await page.getByLabel('Permission test document (JSON)', { exact: true }).fill(JSON.stringify(value)); await page.getByRole('button', { name: 'Save test version' }).click();
    await expect(page.getByRole('alert')).toContainText('Invalid permission test fields');
    expect((await fixture(page)).calls.filter((item: { method: string }) => item.method === 'contract.regression.save')).toHaveLength(0);
  });
  test(`preserves keyboard focus when a check finishes at ${width}px`, async ({ page }) => {
    await open(page, width); const button = page.getByRole('button', { name: 'Test saved grant draft' }); await button.focus(); await button.press('Enter');
    await expect(page.getByRole('button', { name: 'Review grant activation' })).toBeVisible(); await expect(button).toBeFocused();
  });
  test(`keeps malformed advanced cases editable and releases pending work at ${width}px`, async ({ page }) => {
    await open(page, width); await page.getByText('Advanced test document', { exact: true }).click();
    const valid = (await fixture(page)).view.draft.document;
    for (const broken of [{ ...valid, cases: [{ ...valid.cases[0], target: null }] }, { ...valid, changes: [null] }]) {
      const text = JSON.stringify(broken);
      await page.getByLabel('Permission test document (JSON)', { exact: true }).fill(text);
      await page.getByRole('button', { name: 'Save test version', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Invalid permission test fields');
      await expect(page.getByLabel('Permission test document (JSON)', { exact: true })).toHaveValue(text);
      await expect(page.getByRole('button', { name: 'Save test version', exact: true })).toBeEnabled();
      await page.evaluate(() => dispatchEvent(new Event('query-permission-work')));
      await expect(page.locator('body')).toHaveAttribute('data-leases', '0');
    }
    expect((await fixture(page)).calls.filter((item: { method: string }) => item.method === 'contract.regression.save')).toHaveLength(0);
    await page.getByLabel('Permission test document (JSON)', { exact: true }).fill(JSON.stringify(valid));
    await page.getByRole('button', { name: 'Save test version', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved test version 2');
  });
  test(`keeps dispatched work tracked after its route is disposed at ${width}px`, async ({ page }) => {
    await open(page, width, 'slow-test'); await page.getByRole('button', { name: 'Test saved grant draft' }).click();
    await page.evaluate(() => { dispatchEvent(new Event('dispose-permission')); dispatchEvent(new Event('query-permission-work')); });
    await expect(page.locator('body')).toHaveAttribute('data-leases', '1');
    await page.evaluate(() => dispatchEvent(new Event('finish-permission')));
    await expect.poll(async () => page.evaluate(() => { dispatchEvent(new Event('query-permission-work')); return document.body.dataset.leases; })).toBe('0');
  });
  test(`allows private-history cleanup for an inactive agreement at ${width}px`, async ({ page }) => {
    await open(page, width, 'unsupported'); await expect(page.getByText('This agreement is inactive.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save test version' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Delete saved tests and history' }).click(); await page.getByRole('button', { name: 'Confirm delete saved tests' }).click();
    await expect(page.getByRole('status')).toContainText('Deleted saved tests and history');
    await expect(page.getByRole('status')).toBeFocused();
    expect((await fixture(page)).view.grants).toEqual([{ entry_key: 'data.task', granted: false }]); expect((await fixture(page)).applied).toBe(0);
  });
  test(`opens from the actual Contracts detail and keeps its editor across tabs at ${width}px`, async ({ page }) => {
    await open(page, width, '', '&seed=1&route=contracts');
    await page.locator('summary').filter({ hasText: /^Permission tests and reviewed grants$/ }).click();
    await page.getByLabel('Test suite title').fill('Kept while switching tabs');
    await page.getByRole('tab', { name: 'Entities', exact: true }).click(); await page.getByRole('tab', { name: 'Ops', exact: true }).click();
    await expect(page.getByLabel('Test suite title')).toHaveValue('Kept while switching tabs');
    await page.evaluate(() => dispatchEvent(new Event('query-permission-work'))); await expect(page.locator('body')).toHaveAttribute('data-busy', 'true');
  });
}
