import { expect, test, type Page } from '@playwright/test';
import { clickActionGlyph } from './helpers/action-glyph.js';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
const calls = (page: Page, method: string) => page.evaluate(method => window.__app.rpcCallCount(method), method);
const hold = (page: Page, method: string) => page.evaluate(method => window.__app.holdRpcResponses?.(method), method);
const release = (page: Page, method: string) => page.evaluate(method => window.__app.releaseRpcResponses?.(method), method);
const open = async (page: Page, query: string, hash = '#reception') => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?${query}&settle_reads=1${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const responses = async (page: Page) => {
  await page.locator('[data-recued-reception-records-lens="responses"]').click();
};

test('Inbox Refresh glyph keeps the read single-flight and sends no decision', async ({ page }) => {
  await open(page, 'reception=pending');
  const refresh = page.locator('[data-recued-reception-inbox-refresh]');
  await expect(refresh).toHaveText('Refresh');
  const before = await calls(page, 'reception.inbox.list');
  await hold(page, 'reception.inbox.list');
  await clickActionGlyph(page, refresh);
  await expect(refresh).toBeDisabled();
  await clickActionGlyph(page, refresh);
  expect(await calls(page, 'reception.inbox.list')).toBe(before + 1);
  expect(await release(page, 'reception.inbox.list')).toBe(1);
  await expect(refresh).toHaveText('Refresh');
  await expect(refresh).toBeEnabled();
  expect(await calls(page, 'reception.inbox.approve')).toBe(0);
  expect(await calls(page, 'reception.inbox.reject')).toBe(0);
});

for (const action of ['approve', 'reject'] as const) {
  test(`Inbox ${action} glyph submits once for the selected item`, async ({ page }) => {
    await open(page, 'reception=pending');
    const row = page.locator('[data-recued-reception-inbox-row="hold-reception-1"]');
    await expect(row).toBeVisible();
    const button = page.locator(`[data-recued-reception-inbox-decision="${action}"]`);
    await expect(button).toHaveText(action === 'approve' ? 'Approve' : 'Reject');
    await hold(page, `reception.inbox.${action}`);
    await clickActionGlyph(page, button);
    await expect(button).toHaveText(action === 'approve' ? 'Approving…' : 'Rejecting…');
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await clickActionGlyph(page, button);
    expect(await calls(page, `reception.inbox.${action}`)).toBe(1);
    expect(await calls(page, `reception.inbox.${action === 'approve' ? 'reject' : 'approve'}`)).toBe(0);
    expect(await release(page, `reception.inbox.${action}`)).toBe(1);
    await expect(row).toHaveCount(0);
    await expect(page.locator('[data-recued-reception-inbox-row="hold-reception-2"]')).toBeVisible();
  });
}

test('destination Retry glyph recovers the inventory without changing the selected destination', async ({ page }) => {
  await open(page, 'reception=pending&reception_destination_response=fail-once-slow-retry&hold_rpc=work_entity.source.list');
  const picker = page.getByRole('combobox', { name: 'Destination' });
  await expect(picker).toBeVisible();
  const selectedDestination = await picker.inputValue();
  expect(await release(page, 'work_entity.source.list')).toBe(1);
  const retry = page.locator('[data-recued-reception-inbox-destination-retry="source_id"]');
  await expect(retry).toHaveText('Retry');
  const before = await calls(page, 'work_entity.source.list');
  await clickActionGlyph(page, retry);
  await expect(retry).toHaveText('Retrying…');
  await clickActionGlyph(page, retry);
  expect(await calls(page, 'work_entity.source.list')).toBe(before + 1);
  expect(await release(page, 'work_entity.source.list')).toBe(1);
  await expect(picker).toHaveValue(selectedDestination);
  expect(await calls(page, 'reception.inbox.approve')).toBe(0);
});

test('Records Retry glyph reaches the delegated button and retries only its read', async ({ page }) => {
  await open(page, 'reception_records_response=fail-once-slow-retry', '#reception/records');
  const retry = page.locator('[data-recued-reception-records-retry]');
  await expect(retry).toHaveText('Retry');
  const before = await calls(page, 'reception.record.list');
  await hold(page, 'reception.record.list');
  await clickActionGlyph(page, retry);
  await expect(retry).toHaveText('Retrying…');
  await clickActionGlyph(page, retry);
  expect(await calls(page, 'reception.record.list')).toBe(before + 1);
  expect(await release(page, 'reception.record.list')).toBe(1);
  await expect(page.locator('[data-recued-reception-records-error]')).toHaveCount(0);
  expect(await calls(page, 'reception.record.open')).toBe(0);
});

for (const target of ['list', 'detail'] as const) {
  test(`Responses ${target} Retry glyph recovers the same response without a write`, async ({ page }) => {
    await open(page, `data=form-responses-paged&${target === 'list' ? 'reception_responses_response' : 'reception_response_detail'}=fail-once-slow-retry`, '#reception/records');
    await responses(page);
    if (target === 'detail') await page.locator('[data-recued-reception-response-row="submission-0"] button').click();
    const retry = page.locator(target === 'list' ? '[data-recued-reception-response-retry]' : '[data-recued-reception-response-detail-retry]');
    await expect(retry).toHaveText('Retry');
    const method = target === 'list' ? 'form_response.list' : 'form_response.get';
    const before = await calls(page, method);
    await hold(page, method);
    await clickActionGlyph(page, retry);
    await expect(retry).toHaveText('Retrying…');
    await clickActionGlyph(page, retry);
    expect(await calls(page, method)).toBe(before + 1);
    expect(await release(page, method)).toBe(1);
    if (target === 'list') await expect(page.locator('[data-recued-reception-response-row="submission-0"]')).toBeVisible();
    else await expect(page.locator('[data-recued-reception-response-detail="submission-0"] h2')).toHaveText('visitor-0@example.test');
    expect(await calls(page, 'execute')).toBe(0);
  });
}

test('Response automation glyphs discover once and open the chosen review without executing', async ({ page }) => {
  await open(page, 'data=form-responses-paged', '#reception/records');
  await responses(page);
  await page.locator('[data-recued-reception-response-row="submission-0"] button').click();
  const discover = page.locator('.reception-responses-automation-actions [data-recued-reception-response-action="discover"]');
  const before = await calls(page, 'recipe.list');
  await hold(page, 'recipe.list');
  await clickActionGlyph(page, discover);
  await expect(discover).toHaveText('Looking for things that can run…');
  await clickActionGlyph(page, discover);
  expect(await calls(page, 'recipe.list')).toBe(before + 1);
  expect(await release(page, 'recipe.list')).toBe(1);
  const review = page.getByRole('button', { name: 'Look at it and run Review project intake (project-intake-review)', exact: true });
  await clickActionGlyph(page, review);
  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog).toContainText('Review project intake');
  expect(await calls(page, 'execute')).toBe(0);
});
