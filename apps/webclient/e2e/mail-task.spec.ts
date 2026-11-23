import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailTaskFixture } from './helpers/mail-task-fixture.js';

installFullAppHooks();
test.use({ timezoneId: 'America/Los_Angeles' });
const editor = (page: Page) => page.locator('.work-entity-dialog[data-kind="task"]');
const email = (page: Page) => page.getByRole('article', { name: 'Email message', exact: true });
const recovery = (page: Page) => page.getByRole('region', { name: 'Unfinished tasks', exact: true });
const boot = async (page: Page, prepare?: (fixture: Awaited<ReturnType<typeof installMailTaskFixture>>) => void) => {
  const fixture = await installMailTaskFixture(page); prepare?.(fixture);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/mail`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-collection-record]')).toHaveCount(30);
  await page.locator('[data-collection-record="mail-1"]').click();
  await expect(email(page).getByRole('button', { name: 'Create task', exact: true })).toBeVisible();
  return fixture;
};
const create = async (page: Page) => {
  await email(page).getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(editor(page)).toHaveAttribute('data-mode', 'create');
  await expect(editor(page).locator('[data-form-field="title"]')).toBeFocused();
};
const reload = async (page: Page) => {
  const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); };
  page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); }
  await page.waitForFunction(() => window.__app?.ready === true);
};

test('creates a reviewed task from the selected conversation message and returns to that exact email on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await boot(page);
  try {
    await page.locator('.data-mail-conversation-toggle[data-mail-record="mail-2"]').click();
    await expect(email(page)).toContainText('second email needs');
    await create(page); const dialog = editor(page);
    await expect(dialog.locator('[data-form-field="title"]')).toHaveValue('Quote 2');
    await expect(dialog.locator('[data-form-field="body"]')).toHaveValue(/From: Alex.*\nEmail: .*#data\/mail\/record\/work\/mail-2\n\nEmail excerpt:\nThe second email needs a separate follow-up\./s);
    expect(fixture.writes).toEqual([]); expect(fixture.tasks()).toEqual([]);
    await dialog.getByLabel('Source', { exact: true }).selectOption('other.task');
    await dialog.locator('[data-form-field="title"]').fill('Send the revised quote');
    await dialog.locator('[data-form-field="due_at"]').fill('2030-10-30T09:45');
    await dialog.locator('[data-form-field="priority"]').selectOption('high');
    await dialog.getByRole('button', { name: 'More details', exact: true }).click();
    const project = dialog.locator('[data-ref-picker="form-ref-parent_project"]');
    await project.getByRole('combobox').fill('Launch');
    await project.getByRole('option', { name: 'Launch project · Recued', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveAttribute('data-mode', 'read');
    expect(fixture.writes).toEqual([expect.objectContaining({ kind: 'task', source_id: 'other.task', title: 'Send the revised quote', done: false,
      due_at: Date.parse('2030-10-30T09:45:00-07:00'), priority: 'high', parent_project_id: 'launch' })]);
    expect(fixture.writes[0]).not.toHaveProperty('id'); expect(fixture.writes[0]).not.toHaveProperty('linked_mail_thread_id');
    expect(fixture.tasks()).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Back to email', exact: true }).click();
    await expect(page).toHaveURL(/#data\/mail\/record\/work\/mail-2$/);
    await expect(email(page)).toContainText('second email needs');
    await expect(email(page).getByRole('button', { name: 'Create task', exact: true })).toBeFocused();
    expect(fixture.calls).not.toContain('collection.mail.message.updateState');
    await page.screenshot({ path: testInfo.outputPath('mail-task-phone.png'), fullPage: true });
  } finally { fixture.dispose(); }
});

test('requires discard for a prefilled draft and restores reader Find, scroll, inbox pages, filters and row focus', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await page.getByLabel('Message status', { exact: true }).selectOption('unread');
    await page.getByRole('button', { name: 'Load more messages', exact: true }).click();
    await expect(page.locator('[data-collection-record]')).toHaveCount(35);
    const row = page.locator('[data-collection-record="mail-31"]'), host = page.locator('[data-recued-webclient-content]');
    await row.scrollIntoViewIfNeeded(); const inboxTop = await host.evaluate(node => node.scrollTop);
    await row.click(); await expect(email(page)).toBeVisible();
    await email(page).getByRole('button', { name: 'Find in email', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Find in this email', exact: true }).fill('delivery');
    await expect(email(page).locator('mark')).toHaveCount(1);
    await host.evaluate(node => { node.scrollTop = 500; });
    // Let the click's visibility and sticky-overlay checks finish scrolling
    // before recording the viewport that starts this workflow.
    await email(page).getByRole('button', { name: 'Create task', exact: true }).click({ trial: true });
    const readerTop = await host.evaluate(node => node.scrollTop);
    await create(page); const dialog = editor(page);
    await dialog.getByRole('button', { name: 'Back to email', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(dialog.locator('[data-form-field="title"]')).toHaveValue('Quote 31');
    await dialog.getByRole('button', { name: 'Back to email', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(email(page)).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Find in this email', exact: true })).toHaveValue('delivery');
    await expect(email(page).locator('mark')).toHaveCount(1);
    expect(await host.evaluate(node => node.scrollTop)).toBe(readerTop);
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await expect(row).toBeFocused(); await expect(page.locator('[data-collection-record]')).toHaveCount(35);
    await expect(page.getByLabel('Message status', { exact: true })).toHaveValue('unread');
    expect(await host.evaluate(node => node.scrollTop)).toBe(inboxTop);
    expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('immediately recovers an untouched prefilled task as a new draft after reload', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await create(page); const body = await editor(page).locator('[data-form-field="body"]').inputValue();
    await reload(page); await expect(recovery(page)).toContainText('Quote 1');
    expect(fixture.writes).toEqual([]);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor(page)).toHaveAttribute('data-mode', 'create');
    await expect(editor(page).locator('[data-form-field="body"]')).toHaveValue(body);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page)).toHaveCount(0); await expect(recovery(page)).toHaveCount(0);
    expect(fixture.writes).toHaveLength(1); expect(fixture.writes[0]).not.toHaveProperty('id');
    expect(fixture.tasks()[0]?.body).toContain('#data/mail/record/work/mail-1');
  } finally { fixture.dispose(); }
});

test('browser Back can keep the task recovery copy while returning to the mounted email', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await create(page); await editor(page).locator('[data-form-field="title"]').fill('Still to review');
    page.once('dialog', dialog => { void dialog.accept(); });
    await page.goBack(); await expect(email(page)).toBeVisible();
    await expect(page).toHaveURL(/#data\/mail\/record\/work\/mail-1$/);
    expect(fixture.writes).toEqual([]);
    await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/task`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(recovery(page)).toContainText('Still to review');
  } finally { fixture.dispose(); }
});

test('keeps the email readable on a source read failure and retries without an automatic write', async ({ page }) => {
  const fixture = await boot(page);
  try {
    fixture.failSources(true); await email(page).getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(email(page).getByRole('alert')).toContainText('Task Sources could not be loaded');
    await expect(editor(page)).toHaveCount(0); expect(fixture.writes).toEqual([]);
    fixture.failSources(false); await create(page); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('explains when no task destination can be written without leaving the email', async ({ page }) => {
  const fixture = await boot(page, fixture => fixture.noWritable());
  try {
    await email(page).getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(email(page).getByRole('alert')).toContainText('No writable task Source');
    await expect(editor(page)).toHaveCount(0); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('drops a late task preparation after selecting another email or leaving Mail', async ({ page }) => {
  const fixture = await boot(page);
  try {
    fixture.holdSources(); await email(page).getByRole('button', { name: 'Create task', exact: true }).click();
    await expect.poll(fixture.waiting).toBe(true);
    await page.locator('.data-mail-conversation-toggle[data-mail-record="mail-2"]').click();
    await expect(email(page)).toContainText('second email needs'); fixture.release();
    await expect(email(page).getByRole('button', { name: 'Create task', exact: true })).toBeVisible();
    await expect(editor(page)).toHaveCount(0);
    fixture.holdSources(); await email(page).getByRole('button', { name: 'Create task', exact: true }).click();
    await expect.poll(fixture.waiting).toBe(true);
    await page.evaluate(() => { location.hash = '#data/task'; });
    await expect(page.getByRole('button', { name: '+ New Task', exact: true })).toBeVisible(); fixture.release();
    await expect(editor(page)).toHaveCount(0); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

for (const reply of ['lost', 'pending'] as const) test(`keeps a ${reply} save recoverable and prevents a second task create`, async ({ page }) => {
  const fixture = await boot(page);
  try {
    await create(page); fixture.reply(reply);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText(reply === 'lost' ? 'save reply was lost' : 'did not confirm');
    await expect(editor(page)).toHaveAttribute('data-mode', 'create');
    fixture.reply('normal'); await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText('previous save was not confirmed');
    expect(fixture.writes).toHaveLength(1); expect(fixture.tasks()).toHaveLength(1);
    await reload(page); await expect(recovery(page)).toContainText('Save was not confirmed');
    await expect(recovery(page).getByRole('button', { name: 'Resume draft', exact: true })).toBeDisabled();
  } finally { fixture.dispose(); }
});

test('allows follow-up drafts from partial and missing email text while naming the limitation', async ({ page }) => {
  const fixture = await boot(page, fixture => fixture.partialBody());
  try {
    await create(page); await expect(editor(page).locator('[data-form-field="body"]')).toHaveValue(/Email excerpt \(partial\):\nOnly the retained beginning\./);
    await editor(page).getByRole('button', { name: 'Back to email', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    fixture.missingBody(); await email(page).getByRole('button', { name: 'Refresh email', exact: true }).click();
    await expect(email(page)).toContainText('email body is unavailable'); await create(page);
    await expect(editor(page).locator('[data-form-field="body"]')).toHaveValue(/email text was unavailable/);
    expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});
