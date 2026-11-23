import { expect, test, type Page } from '@playwright/test';
import { installTemplatesPage, openTemplates, gallery, galleryIntent } from './helpers/reception-templates.js';
import { authoringRoot, authoringField } from './helpers/reception-authoring.js';
import { endpointCount, holdEndpoint, releaseEndpoint, failEndpoint } from './helpers/reception-endpoints.js';

test.beforeEach(async ({ page }) => installTemplatesPage(page));
const pending = (page: Page, method: string) => expect.poll(() => page.evaluate(method => (window as any).__endpoints.pending(method), method)).toBe(1);
const pick = (page: Page, ref: string) => gallery(page).locator(`[data-action="reception-template-use"][data-template-ref="${ref}"]`);

test('an early gallery waits for the catalog and picks the freshly loaded seed', async ({ page }) => {
  await openTemplates(page, 'endpoints_hold=reception.template.list');
  await pending(page, 'reception.template.list'); await expect(gallery(page).getByRole('status', { name: 'Loading templates' })).toBeVisible();
  await expect(gallery(page)).not.toContainText('No Reception templates');
  await releaseEndpoint(page, 'reception.template.list'); await pick(page, 'foundation:intake/client_inquiry').click();
  await expect(authoringField(page, 'form_definition.form_definition_id')).toHaveValue('fd_foundation_client_inquiry_v1');
  await expect(authoringField(page, 'display_name')).toHaveValue('');
  expect(await endpointCount(page, 'reception.template.list')).toBe(1);
  expect(await endpointCount(page, 'reception.endpoint.create')).toBe(0);
});

test('catalog failure offers a retry and preserves the intent and its caret', async ({ page }) => {
  await openTemplates(page, 'endpoints_fail=reception.template.list');
  await expect(gallery(page).getByRole('alert')).toContainText('load');
  await galleryIntent(page).fill('Conference speaker biographies');
  await failEndpoint(page); await holdEndpoint(page, 'reception.template.list');
  await gallery(page).getByRole('button', { name: 'Retry templates', exact: true }).click(); await pending(page, 'reception.template.list');
  await galleryIntent(page).focus(); await galleryIntent(page).evaluate(n => (n as HTMLInputElement).setSelectionRange(2, 8, 'backward'));
  await releaseEndpoint(page, 'reception.template.list'); await expect(pick(page, 'foundation:intake/client_inquiry')).toBeVisible();
  await expect(galleryIntent(page)).toBeFocused(); await expect(galleryIntent(page)).toHaveValue('Conference speaker biographies');
  expect(await galleryIntent(page).evaluate(n => [(n as HTMLInputElement).selectionStart, (n as HTMLInputElement).selectionEnd, (n as HTMLInputElement).selectionDirection])).toEqual([2, 8, 'backward']);
});

test('Tab stays in the named gallery and Escape returns to the New control', async ({ page }) => {
  await openTemplates(page); await expect(gallery(page)).toHaveAttribute('role', 'dialog');
  await expect(gallery(page)).toHaveAccessibleName('Reception templates');
  const buttons = gallery(page).getByRole('button'); await buttons.last().focus(); await page.keyboard.press('Tab');
  await expect(buttons.first()).toBeFocused(); await page.keyboard.press('Shift+Tab'); await expect(buttons.last()).toBeFocused();
  await page.keyboard.press('Escape'); await expect(gallery(page)).toHaveCount(0);
  await expect(page.locator('[data-action="reception-open-templates"]:visible')).toBeFocused();
});

for (const [ref, kind, field, value] of [
  ['foundation:scheduling/intro_call', 'scheduling_link', 'available_window_definition.tz', 'America/New_York'],
  ['foundation:drop/document_request', 'drop_link', 'size_cap_bytes', '26214400'],
  ['foundation:approval/approve_message', 'approval_link', 'action_kind', 'approve_wording'],
] as const) test(`${kind} template opens its configured review without creating`, async ({ page }) => {
  await openTemplates(page); await pick(page, ref).click(); await expect(authoringRoot(page)).toBeVisible();
  await expect(authoringField(page, field)).toHaveValue(value);
  expect(await endpointCount(page, 'reception.endpoint.create')).toBe(0);
});

test('pack provenance stays visible and its selected seed comes from that pack', async ({ page }) => {
  await openTemplates(page); const card = gallery(page).locator('.reception-template-card').filter({ hasText: 'Project intake from Studio' });
  await expect(card).toContainText('Studio project intake'); await expect(gallery(page)).toContainText('could not be loaded');
  await card.getByRole('button').click(); await expect(authoringRoot(page)).toBeVisible();
  await expect(authoringRoot(page).locator('[data-repeater-key="form_definition.fields"][data-row-field="name"]').first()).not.toHaveValue('');
  expect(await endpointCount(page, 'reception.endpoint.create')).toBe(0);
});

test('AI failure keeps the intent and retry opens a sanitized draft without writing', async ({ page }) => {
  await openTemplates(page); await failEndpoint(page, 'reception.compose.propose');
  await galleryIntent(page).fill('Conference speaker biographies'); await galleryIntent(page).press('Enter');
  await expect(gallery(page).locator('[data-recued-intent-status]')).toContainText('needs AI set up');
  await expect(galleryIntent(page)).toHaveValue('Conference speaker biographies'); await failEndpoint(page);
  await galleryIntent(page).press('Enter'); await expect(authoringField(page, 'display_name')).toHaveValue('Speaker biographies');
  await expect(authoringRoot(page).locator('[data-repeater-key="form_definition.fields"][data-row-field="name"]')).toHaveCount(2);
  await expect(authoringField(page, 'required_visitor_fields.email')).toHaveValue('optional');
  expect(await endpointCount(page, 'reception.compose.propose')).toBe(2);
  expect(await endpointCount(page, 'reception.endpoint.create')).toBe(0); expect(await endpointCount(page, 'execute')).toBe(0);
});

test('editing the intent does not submit until the owner asks for a draft', async ({ page }) => {
  await openTemplates(page); await galleryIntent(page).fill('Conference speaker biographies');
  await galleryIntent(page).click(); await galleryIntent(page).press('End'); await page.keyboard.insertText(' and photos');
  expect(await endpointCount(page, 'reception.compose.propose')).toBe(0);
  await gallery(page).getByRole('button', { name: 'Let AI write it', exact: true }).click();
  await expect(authoringField(page, 'display_name')).toHaveValue('Speaker biographies');
  expect(await page.evaluate(() => (window as any).__endpoints.calls.find((c: any) => c.method === 'reception.compose.propose').args.intent_text)).toBe('Conference speaker biographies and photos');
});

test('a catalog reply after closing does not reopen the gallery or move focus', async ({ page }) => {
  await openTemplates(page, 'endpoints_hold=reception.template.list'); await pending(page, 'reception.template.list');
  await gallery(page).getByRole('button', { name: 'Close', exact: true }).click();
  await releaseEndpoint(page, 'reception.template.list'); await expect(gallery(page)).toHaveCount(0);
  await expect(page.locator('[data-action="reception-open-templates"]:visible')).toBeFocused();
});

test('a pending AI request locks its text, ignores duplicate submits and can be closed', async ({ page }) => {
  await openTemplates(page); await holdEndpoint(page, 'reception.compose.propose'); await galleryIntent(page).fill('Conference speaker biographies');
  await galleryIntent(page).press('Enter'); await pending(page, 'reception.compose.propose');
  await expect(galleryIntent(page)).toBeDisabled(); await expect(gallery(page).getByRole('button', { name: 'Let AI write it', exact: true })).toBeDisabled();
  await gallery(page).locator('form').evaluate(n => n.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(await endpointCount(page, 'reception.compose.propose')).toBe(1);
  await gallery(page).getByRole('button', { name: 'Close', exact: true }).click(); await releaseEndpoint(page, 'reception.compose.propose');
  await expect(gallery(page)).toHaveCount(0); await expect(authoringRoot(page)).toHaveCount(0); await expect(page).toHaveURL(/#reception\/endpoints$/);
});

test('a later Account interaction keeps its focus and the AI draft waits for review', async ({ page }) => {
  await openTemplates(page); await holdEndpoint(page, 'reception.compose.propose'); await galleryIntent(page).fill('Conference speaker biographies');
  await galleryIntent(page).press('Enter'); await pending(page, 'reception.compose.propose');
  await page.locator('[data-recued-account-menu-trigger]').focus(); await page.keyboard.press('Enter'); const close = page.locator('[data-recued-account-menu-close]'); await close.focus();
  await releaseEndpoint(page, 'reception.compose.propose'); await expect(gallery(page).getByRole('button', { name: 'Review AI draft', exact: true })).toBeVisible();
  await expect(close).toBeFocused(); await expect(authoringRoot(page)).toHaveCount(0);
  await close.press('Enter'); await gallery(page).getByRole('button', { name: 'Review AI draft', exact: true }).click();
  await expect(authoringField(page, 'display_name')).toHaveValue('Speaker biographies');
});

test('choosing a template during AI drafting retires the late proposal', async ({ page }) => {
  await openTemplates(page); await holdEndpoint(page, 'reception.compose.propose'); await galleryIntent(page).fill('Conference speaker biographies');
  await galleryIntent(page).press('Enter'); await pending(page, 'reception.compose.propose');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Reception action'); void dialog.accept(); });
  await pick(page, 'foundation:scheduling/intro_call').click();
  await expect(authoringField(page, 'available_window_definition.tz')).toHaveValue('America/New_York'); await releaseEndpoint(page, 'reception.compose.propose');
  await expect(authoringField(page, 'available_window_definition.tz')).toHaveValue('America/New_York'); expect(await endpointCount(page, 'reception.endpoint.create')).toBe(0);
});

test('declining a pending AI navigation retains the gallery and allows a fresh next draft', async ({ page }) => {
  await openTemplates(page); await holdEndpoint(page, 'reception.compose.propose'); await galleryIntent(page).fill('Conference speaker biographies');
  await galleryIntent(page).press('Enter'); await pending(page, 'reception.compose.propose');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Reception action'); void dialog.dismiss(); });
  await pick(page, 'foundation:scheduling/intro_call').click(); await expect(page).toHaveURL(/#reception\/endpoints$/);
  await expect(gallery(page)).toBeVisible(); await gallery(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(gallery(page)).toHaveCount(0); await releaseEndpoint(page, 'reception.compose.propose');
  await expect(authoringRoot(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'New scheduling link', exact: true }).click();
  await expect(authoringField(page, 'display_name')).toHaveValue('');
  await expect(authoringRoot(page).locator('.reception-form-repeater-row[data-repeater-key="available_window_definition.explicit_windows"]')).toHaveCount(0);
});
