import { expect, test, type Page } from '@playwright/test';
import { installAuthoringPage, goAuthoring, fillAuthoring, authoringRoot, authoringField, authoringAction } from './helpers/reception-authoring.js';
import { endpointPage, endpointCount, holdEndpoint, releaseEndpoint, failEndpoint } from './helpers/reception-endpoints.js';
test.beforeEach(async ({ page }) => installAuthoringPage(page));
const pending = (page: Page, method: string) => expect.poll(() => page.evaluate(method => (window as any).__endpoints.pending(method), method)).toBe(1);
async function readyForm(page: Page, kind: 'scheduling_link' | 'intake_form' | 'drop_link' | 'approval_link' = 'scheduling_link') {
  await goAuthoring(page, kind); await fillAuthoring(page, kind);
  if (kind === 'approval_link') await authoringField(page, 'context_raw.summary').fill('Three drawings, followed by a planning call.');
}
async function accountFocus(page: Page) { await page.locator('[data-recued-account-menu-trigger]').click(); const close = page.locator('[data-recued-account-menu-close]'); await close.focus(); return close; }

for (const kind of ['scheduling_link', 'intake_form', 'drop_link', 'approval_link'] as const) test(`${kind} creates the reviewed configuration and opens its one-shot share cards`, async ({ page }) => {
  await readyForm(page, kind); await authoringAction(page, 'submit').click();
  await expect(endpointPage(page).locator('.reception-detail-title')).toHaveText('created-1');
  await expect(endpointPage(page).locator('.reception-share-snippet').first()).toContainText('created-once');
  const calls = await page.evaluate(() => (window as any).__endpoints.calls);
  const preview = calls.find((c: any) => c.method === 'reception.endpoint.preview_draft')!.args;
  const create = calls.find((c: any) => c.method === 'reception.endpoint.create')!.args;
  expect(create.kind).toBe(kind); expect(create.metadata).toEqual(preview.metadata); expect(create.packet_declaration).toEqual(preview.packet_declaration);
  expect(await endpointCount(page, 'reception.endpoint.create')).toBe(1); expect(await endpointCount(page, 'execute')).toBe(0);
});

test('the page editor saves its existing profile and links without a preview or endpoint create', async ({ page }) => {
  await goAuthoring(page, 'reception_page', '', true); await expect(authoringField(page, 'display_name')).toHaveValue('Morgan Studio');
  await authoringField(page, 'tagline').fill('Planning for thoughtful projects'); await authoringAction(page, 'submit').click();
  await expect(authoringRoot(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__authoring.saves[0])).toMatchObject({ display_overrides: { display_name: 'Morgan Studio', tagline: 'Planning for thoughtful projects', tz_label: 'Pacific Time' },
    custom_links: [{ label: 'Portfolio', url: 'https://example.test/portfolio' }], link_buttons: [{ label: 'Project guide', url: 'https://example.test/project', description: 'How we work together' }] });
  expect(await endpointCount(page, 'reception.endpoint.preview_draft')).toBe(0); expect(await endpointCount(page, 'reception.endpoint.create')).toBe(0);
});

test('validation is announced and editing its first invalid field retains focus and selection', async ({ page }) => {
  await goAuthoring(page); await authoringAction(page, 'submit').click();
  const alert = authoringRoot(page).getByRole('alert'); await expect(alert).toBeFocused();
  const name = authoringField(page, 'display_name'); await name.fill('Customer project'); await expect(name).toBeFocused();
  await name.evaluate(n => (n as HTMLInputElement).setSelectionRange(2, 8, 'backward'));
  await page.keyboard.insertText('studio'); await expect(name).toHaveValue('Custudio project');
  expect(await endpointCount(page, 'reception.endpoint.create')).toBe(0);
});

test('Preview shows the sandboxed visitor result and returns to its source control', async ({ page }) => {
  await readyForm(page); await authoringAction(page, 'preview').click();
  const preview = authoringRoot(page).getByRole('region', { name: 'Visitor preview', exact: true }); await expect(preview).toBeFocused();
  await expect(preview.locator('iframe')).toHaveAttribute('sandbox', ''); await expect(preview).toContainText('Stripped at the boundary');
  await authoringAction(page, 'close-preview').click(); await expect(preview).toHaveCount(0); await expect(authoringAction(page, 'preview')).toBeFocused();
  expect(await endpointCount(page, 'reception.endpoint.create')).toBe(0);
});

test('editing after a preview retires the old result', async ({ page }) => {
  await readyForm(page); await authoringAction(page, 'preview').click();
  await expect(authoringRoot(page).getByRole('region', { name: 'Visitor preview', exact: true })).toBeVisible();
  await authoringField(page, 'display_name').fill('Updated project');
  await expect(authoringRoot(page).getByRole('region', { name: 'Visitor preview', exact: true })).toHaveCount(0);
  await expect(authoringField(page, 'display_name')).toBeFocused(); expect(await endpointCount(page, 'reception.endpoint.create')).toBe(0);
});

test('a delayed preview preserves later Account focus', async ({ page }) => {
  await readyForm(page); await holdEndpoint(page, 'reception.endpoint.preview_draft'); await authoringAction(page, 'preview').click();
  await pending(page, 'reception.endpoint.preview_draft'); const close = await accountFocus(page); await releaseEndpoint(page, 'reception.endpoint.preview_draft');
  await expect(authoringRoot(page).getByRole('region', { name: 'Visitor preview', exact: true })).toBeVisible(); await expect(close).toBeFocused();
});

for (const phase of ['preview_draft', 'create'] as const) test(`a rejected ${phase} stays on the draft with a working retry`, async ({ page }) => {
  await readyForm(page); await failEndpoint(page, 'reception.endpoint.' + phase);
  await authoringAction(page, phase === 'preview_draft' ? 'preview' : 'submit').click();
  await expect(authoringRoot(page).getByRole('alert')).toBeVisible(); await expect(authoringField(page, 'display_name')).toHaveValue('Customer project');
  await failEndpoint(page); await authoringAction(page, phase === 'preview_draft' ? 'preview' : 'submit').click();
  if (phase === 'preview_draft') await expect(authoringRoot(page).getByRole('region', { name: 'Visitor preview', exact: true })).toBeVisible();
  else await expect(endpointPage(page).locator('.reception-detail-title')).toHaveText('created-1');
});

test('creating stays single-flight while its preview is pending', async ({ page }) => {
  await readyForm(page); await holdEndpoint(page, 'reception.endpoint.preview_draft'); await authoringAction(page, 'submit').click();
  await pending(page, 'reception.endpoint.preview_draft'); await expect(authoringAction(page, 'submit')).toBeDisabled(); await expect(authoringField(page, 'display_name')).toBeDisabled();
  const rect = await authoringAction(page, 'submit').boundingBox(); await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
  expect(await endpointCount(page, 'reception.endpoint.preview_draft')).toBe(1); await releaseEndpoint(page, 'reception.endpoint.preview_draft');
  await expect(endpointPage(page).locator('.reception-detail-title')).toHaveText('created-1'); expect(await endpointCount(page, 'reception.endpoint.create')).toBe(1);
});

test('leaving during the create preview prevents a later create and does not reopen the visitor view', async ({ page }) => {
  await readyForm(page); await holdEndpoint(page, 'reception.endpoint.preview_draft'); await authoringAction(page, 'submit').click(); await pending(page, 'reception.endpoint.preview_draft');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('link', { name: 'Records', exact: true }).click(); await expect(authoringRoot(page)).toHaveCount(0);
  await releaseEndpoint(page, 'reception.endpoint.preview_draft'); await expect.poll(() => page.evaluate(() => (window as any).__endpoints.pending('reception.endpoint.preview_draft'))).toBe(0);
  await page.getByRole('link', { name: 'Manage', exact: true }).click(); await expect(endpointPage(page).locator('.reception-sections')).toBeVisible();
  expect(await endpointCount(page, 'reception.endpoint.create')).toBe(0);
});

for (const operation of ['create', 'page.upsert'] as const) test(`pending ${operation} stays owned after departure`, async ({ page }) => {
  const method = operation === 'create' ? 'reception.endpoint.create' : 'reception.page.upsert';
  if (operation === 'create') await readyForm(page); else { await goAuthoring(page, 'reception_page', '', true); await expect(authoringField(page, 'display_name')).toHaveValue('Morgan Studio'); await authoringField(page, 'tagline').fill('Updated planning service'); }
  await holdEndpoint(page, method); await authoringAction(page, 'submit').click(); await pending(page, method);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('link', { name: 'Records', exact: true }).click(); await expect(authoringRoot(page)).toHaveCount(0);
  await page.locator('[data-recued-account-menu-trigger]').click(); const menu = page.locator('[data-recued-account-menu-popover]'); const office = menu.locator('[data-recued-server-switcher-item]').filter({ hasText: 'Office server' }); await office.click();
  const review = menu.locator('[data-recued-server-switcher-switch-confirm]'); await expect(review).toContainText('Work is still finishing on');
  await releaseEndpoint(page, method); await review.locator('[data-recued-server-switcher-switch-cancel]').click(); await office.click(); await expect(review.locator('[data-recued-server-switcher-switch-commit]')).toHaveText('Switch server');
  await review.locator('[data-recued-server-switcher-switch-cancel]').click(); await page.locator('[data-recued-account-menu-close]').click();
  if (operation === 'create') { await page.getByRole('link', { name: 'Manage', exact: true }).click(); await endpointPage(page).locator('.reception-row[data-endpoint-id="created-1"] [data-action="reception-open-detail"]').click(); await expect(endpointPage(page).locator('.reception-share-snippet').first()).toContainText('created-once'); }
  expect(await endpointCount(page, method)).toBe(1);
});

test('the page editor can retry a failed initial read without exposing an overwrite form', async ({ page }) => {
  await goAuthoring(page, 'reception_page', 'endpoints_fail=reception.page.get', true); await expect(authoringRoot(page).getByRole('alert')).toBeVisible(); await expect(authoringField(page, 'display_name')).toHaveCount(0);
  await failEndpoint(page); await authoringRoot(page).getByRole('button', { name: 'Retry page settings', exact: true }).click(); await expect(authoringField(page, 'display_name')).toHaveValue('Morgan Studio');
  expect(await endpointCount(page, 'reception.page.upsert')).toBe(0);
});

test('unsaved form edits retain their draft when leaving is declined', async ({ page }) => {
  await readyForm(page);
  await Promise.all([page.waitForEvent('dialog').then(dialog => dialog.dismiss()), page.getByRole('link', { name: 'Records', exact: true }).click()]);
  await expect(page).toHaveURL(/#reception\/endpoints\/new\/scheduling_link$/); await expect(authoringField(page, 'display_name')).toHaveValue('Customer project');
  await Promise.all([page.waitForEvent('dialog').then(dialog => dialog.accept()), page.getByRole('link', { name: 'Records', exact: true }).click()]);
  await expect(authoringRoot(page)).toHaveCount(0); expect(await endpointCount(page, 'reception.endpoint.create')).toBe(0);
});

test('choosing a response action reveals its required options immediately', async ({ page }) => {
  await readyForm(page, 'approval_link'); await authoringField(page, 'action_kind').focus(); await authoringField(page, 'action_kind').selectOption('pick_time'); await expect(authoringRoot(page).getByRole('button', { name: 'Add Options row', exact: true })).toBeVisible();
  await expect(authoringField(page, 'action_kind')).toBeFocused(); await authoringRoot(page).getByRole('button', { name: 'Add Options row', exact: true }).click(); await expect(authoringRoot(page).locator('[data-repeater-key="options"][data-row-field="id"]')).toBeFocused();
});

test('approval suggestions preserve the active target selection', async ({ page }) => {
  await readyForm(page, 'approval_link'); await holdEndpoint(page, 'reception.approval.targets'); await authoringField(page, 'on_action.on_approve_action').selectOption('mark_resolved'); await pending(page, 'reception.approval.targets');
  const target = authoringField(page, 'on_action.target_id'); await target.fill('task-project'); await target.evaluate(n => (n as HTMLInputElement).setSelectionRange(2, 6, 'backward'));
  await releaseEndpoint(page, 'reception.approval.targets'); await expect(target).toBeFocused(); await expect(authoringRoot(page).locator('datalist option[value="task-project"]')).toHaveCount(1);
  expect(await target.evaluate(n => ({ start: (n as HTMLInputElement).selectionStart, end: (n as HTMLInputElement).selectionEnd, direction: (n as HTMLInputElement).selectionDirection }))).toEqual({ start: 2, end: 6, direction: 'backward' });
});

test('the delayed page read does not take focus back from Account', async ({ page }) => {
  await goAuthoring(page, 'reception_page', 'endpoints_hold=reception.page.get', true); await pending(page, 'reception.page.get');
  const close = await accountFocus(page); await releaseEndpoint(page, 'reception.page.get'); await expect(authoringField(page, 'display_name')).toHaveValue('Morgan Studio'); await expect(close).toBeFocused();
});

test('a failed page save keeps its edited profile for an explicit retry', async ({ page }) => {
  await goAuthoring(page, 'reception_page', '', true); await authoringField(page, 'tagline').fill('A planning service for small studios'); await failEndpoint(page, 'reception.page.upsert'); await authoringAction(page, 'submit').click();
  await expect(authoringRoot(page).getByRole('alert')).toBeVisible(); await expect(authoringField(page, 'tagline')).toHaveValue('A planning service for small studios'); await failEndpoint(page); await authoringAction(page, 'submit').click(); await expect(authoringRoot(page)).toHaveCount(0);
  expect(await endpointCount(page, 'reception.page.upsert')).toBe(2);
});

test('failed approval suggestions can be retried without losing the entered target', async ({ page }) => {
  await readyForm(page, 'approval_link'); await failEndpoint(page, 'reception.approval.targets'); await authoringField(page, 'on_action.on_approve_action').selectOption('mark_resolved');
  await expect(authoringRoot(page).getByRole('button', { name: 'Retry linked work', exact: true })).toBeVisible(); await authoringField(page, 'on_action.target_id').fill('task-project');
  await failEndpoint(page); await authoringRoot(page).getByRole('button', { name: 'Retry linked work', exact: true }).click(); await expect(authoringRoot(page).locator('datalist option[value="task-project"]')).toHaveCount(1); await expect(authoringField(page, 'on_action.target_id')).toHaveValue('task-project');
});
