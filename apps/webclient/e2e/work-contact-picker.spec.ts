import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installWorkContactPickerFixture } from './helpers/work-contact-picker-fixture.js';

installFullAppHooks();
test.use({ timezoneId: 'America/Los_Angeles' });
type Kind = 'task' | 'note' | 'project' | 'commitment';
type Fixture = Awaited<ReturnType<typeof installWorkContactPickerFixture>>;
const editor = (page: Page, kind: Kind = 'task') => page.locator(`.work-entity-dialog[data-kind="${kind}"]`);
const field = (kind: Kind, index = 0) => kind === 'task' ? 'assigned_contact' : kind === 'commitment' ? 'counterparty_contact' : `${kind === 'note' ? 'related_contact' : 'related_contacts'}-${index}`;
const picker = (page: Page, kind: Kind = 'task', index = 0) => editor(page, kind).locator(`[data-ref-picker="form-ref-${field(kind, index)}"]`);
const input = (page: Page, kind: Kind = 'task', index = 0) => picker(page, kind, index).getByRole('combobox');
const mirror = (page: Page, kind: Kind = 'task', index = 0) => picker(page, kind, index).locator('[data-ref-picker-value]');
const details = async (page: Page, kind: Kind) => {
  const button = editor(page, kind).getByRole('button', { name: 'More details', exact: true }); if (await button.isVisible()) await button.click();
};
const editButton = (page: Page, kind: Kind) => page.getByRole('button', { name: kind === 'project' ? 'Edit project' : 'Edit', exact: true });
const open = async (page: Page, kind: Kind = 'task') => {
  await editButton(page, kind).click(); await expect(editor(page, kind)).toHaveAttribute('data-mode', 'edit'); await details(page, kind);
};
const boot = async (page: Page, kind: Kind = 'task', prepare?: (f: Fixture) => void | Promise<void>, list = false) => {
  const f = await installWorkContactPickerFixture(page); await prepare?.(f);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/${kind}${list ? '' : `/${kind}-one`}`); await page.waitForFunction(() => window.__app?.ready === true);
  if (!list) await expect(editButton(page, kind)).toBeVisible(); return f;
};
const choose = async (page: Page, kind: Kind, name: string, email: string, index = 0) => {
  await input(page, kind, index).fill(name); await picker(page, kind, index).getByRole('option').filter({ hasText: email }).click();
  await expect(input(page, kind, index)).toHaveValue(name); await expect(mirror(page, kind, index)).toHaveValue(email);
};
const reload = async (page: Page) => {
  page.once('dialog', dialog => { void dialog.accept(); }); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
};

test('recent contact choices use fresh names and keyboard selection, retain Preview and clear without changing the assignment', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page); await choose(page, 'task', 'Alex', f.third.email);
    await expect(picker(page).getByRole('button', { name: 'Clear recent contacts', exact: true })).toBeVisible();
    await f.renameContact(f.third.email, 'Alex <team>'); await picker(page).getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(picker(page).getByRole('option')).toHaveText('Alex <team>Recent choice · ' + f.third.email);
    await input(page).press('ArrowDown'); await input(page).press('Enter'); await expect(mirror(page)).toHaveValue(f.third.email); await expect(input(page)).toHaveValue('Alex <team>');
    await picker(page).getByRole('button', { name: 'Preview selected contact', exact: true }).click();
    await expect(picker(page).getByRole('region', { name: 'Contact preview', exact: true })).toContainText('Alex <team>'); await expect(picker(page).locator('team')).toHaveCount(0);
    await page.keyboard.press('Escape'); await input(page).fill('Riley'); await input(page).evaluate(el => (el as HTMLInputElement).setSelectionRange(1, 3));
    await picker(page).getByRole('button', { name: 'Clear recent contacts', exact: true }).click(); await expect(input(page)).toHaveValue('Riley'); await expect(mirror(page)).toHaveValue(f.third.email);
    expect(await input(page).evaluate(el => [(el as HTMLInputElement).selectionStart, (el as HTMLInputElement).selectionEnd])).toEqual([1, 3]);
    expect(f.writes).toEqual([]); await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.locator('.work-entity-dialog-form')).toHaveCount(0);
    expect(f.writes).toEqual([{ kind: 'task', id: 'task-one', assigned_contact_id: f.third.email }]); expect(f.task().assigned_contact_id).toBe(f.third.email);
  } finally { f.dispose(); }
});

test('opens a contact preview from the keyboard and restores the query, caret and unsaved edit', async ({ page }, info) => {
  const f = await boot(page);
  try {
    await open(page); await expect(input(page)).toHaveValue(f.first.name!);
    await editor(page).locator('[data-form-field="title"]').fill('Contact checked'); await input(page).fill('Alex');
    await input(page).evaluate(el => (el as HTMLInputElement).setSelectionRange(1, 3));
    await picker(page).getByRole('button', { name: 'Preview selected contact', exact: true }).focus();
    await page.keyboard.press('Enter'); const preview = picker(page).getByRole('region', { name: 'Contact preview', exact: true });
    await expect(preview.getByRole('heading')).toHaveText(f.first.name!); await expect(preview).toContainText(f.first.email);
    await expect(preview).toContainText('Example <team>'); await expect(preview).toContainText('+14155550123'); await expect(preview.locator('img,team')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('contact-reference-preview.png'), fullPage: true });
    await page.keyboard.press('Escape'); await expect(preview).toHaveCount(0); await expect(input(page)).toBeFocused(); await expect(input(page)).toHaveValue('Alex');
    expect(await input(page).evaluate(el => [(el as HTMLInputElement).selectionStart, (el as HTMLInputElement).selectionEnd])).toEqual([1, 3]);
    await expect(mirror(page)).toHaveValue(f.first.contact_id!); await expect(editor(page).locator('[data-form-field="title"]')).toHaveValue('Contact checked'); expect(f.writes).toEqual([]);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.locator('.work-entity-dialog-form')).toHaveCount(0);
    expect(f.writes).toEqual([{ kind: 'task', id: 'task-one', title: 'Contact checked' }]); expect(f.task().assigned_contact_id).toBe(f.first.contact_id);
  } finally { f.dispose(); }
});

test('previews merged contacts in an array and retires a waiting preview when its row is removed', async ({ page }) => {
  const f = await boot(page, 'note');
  try {
    await open(page, 'note'); await expect(input(page, 'note')).toHaveValue(f.first.name!); f.merge();
    await picker(page, 'note').getByRole('button', { name: 'Preview selected contact', exact: true }).click();
    const preview = picker(page, 'note').getByRole('region', { name: 'Contact preview', exact: true });
    await expect(preview).toContainText(f.second.email); await expect(mirror(page, 'note')).toHaveValue(f.first.contact_id!);
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click(); f.holdName(f.first.contact_id!);
    await picker(page, 'note').getByRole('button', { name: 'Preview selected contact', exact: true }).click(); await expect.poll(() => f.waiting(f.first.contact_id!)).toBe(true);
    await editor(page, 'note').locator('[data-form-array-remove="related_contact"][data-form-array-index="0"]').click();
    const delivered = await page.evaluate(id => (window as unknown as { __workContactSettled: Record<string, number> }).__workContactSettled['contact.get:' + id] ?? 0, f.first.contact_id!);
    f.release(f.first.contact_id!);
    await page.waitForFunction(({ id, count }) => (window as unknown as { __workContactSettled: Record<string, number> }).__workContactSettled['contact.get:' + id]! > count, { id: f.first.contact_id!, count: delivered });
    await expect(editor(page, 'note').locator('[data-reference-preview]')).toHaveCount(0); await expect(mirror(page, 'note')).toHaveValue(f.second.email);
    await picker(page, 'note').getByRole('button', { name: 'Preview selected contact', exact: true }).click();
    await expect(preview).toContainText(f.second.email); await expect(preview).not.toContainText('Merged contact'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a closed editor retires a held contact preview without a write or a later panel opening', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page); await expect(input(page)).toHaveValue(f.first.name!); f.holdName(f.first.contact_id!);
    await picker(page).getByRole('button', { name: 'Preview selected contact', exact: true }).click(); await expect.poll(() => f.waiting(f.first.contact_id!)).toBe(true);
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click(); await expect(page.locator('.work-entity-dialog-form')).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    const delivered = await page.evaluate(id => (window as unknown as { __workContactSettled: Record<string, number> }).__workContactSettled['contact.get:' + id] ?? 0, f.first.contact_id!);
    f.release(f.first.contact_id!);
    await page.waitForFunction(({ id, count }) => (window as unknown as { __workContactSettled: Record<string, number> }).__workContactSettled['contact.get:' + id]! > count, { id: f.first.contact_id!, count: delivered });
    await page.locator('[data-action="open-edit-work-entity"][data-entity-id="task-one"]').click();
    await open(page); await expect(input(page)).toHaveValue(f.first.name!); await expect(editor(page).locator('[data-reference-preview]')).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['task', 'note', 'project', 'commitment'] as const) test(`resolves saved ${kind} contacts on a direct open and preserves references through an unrelated edit`, async ({ page }, info) => {
  const f = await boot(page, kind);
  try {
    await open(page, kind); await expect(input(page, kind)).toHaveValue(f.first.name!);
    await expect(picker(page, kind)).toContainText(f.first.email); await expect(mirror(page, kind)).toHaveValue(f.first.contact_id!);
    await expect(picker(page, kind).locator('img,script')).toHaveCount(0);
    if (kind === 'note' || kind === 'project') { await expect(input(page, kind, 1)).toHaveValue(f.second.name!); await expect(picker(page, kind, 1)).toContainText(f.second.email); }
    expect(f.writes).toEqual([]);
    const changedField = kind === 'commitment' ? 'statement' : 'title';
    await editor(page, kind).locator(`[data-form-field="${changedField}"]`).fill('Reviewed contact context');
    if (kind === 'project') await page.screenshot({ path: info.outputPath('project-contact-fields-desktop.png'), fullPage: true });
    await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => f.writes.length).toBe(1);
    expect(f.writes[0]).toMatchObject({ kind, id: kind + '-one', [changedField]: 'Reviewed contact context' });
    if (kind === 'task') { expect(f.task().assigned_contact_id).toBe(f.first.contact_id); expect(f.writes[0]).not.toHaveProperty('assigned_contact_id'); }
    else if (kind === 'commitment') expect(f.commitment().counterparty_contact_id).toBe(f.first.contact_id);
    else expect((kind === 'note' ? f.note() : f.project()).related_contact_ids).toEqual([f.first.contact_id, f.second.email]);
  } finally { f.dispose(); }
});

for (const selected of [false, true]) test(`a late contact label preserves ${selected ? 'a newly selected contact' : 'the typed query and stored selection'}`, async ({ page }) => {
  const f = await boot(page);
  try {
    await expect(page.getByRole('button', { name: `Open contact ${f.first.name}`, exact: true })).toBeVisible();
    f.holdName(f.first.contact_id!); await open(page); await expect.poll(() => f.waiting(f.first.contact_id!)).toBe(true);
    await input(page).fill('Alex'); await expect(picker(page).getByRole('option').filter({ hasText: f.third.email })).toBeVisible();
    if (selected) { await input(page).press('ArrowDown'); await input(page).press('Enter'); await expect(mirror(page)).toHaveValue(f.third.email); }
    f.release(f.first.contact_id!); await expect(input(page)).toHaveValue('Alex'); await expect(input(page)).toBeFocused();
    await expect(mirror(page)).toHaveValue(selected ? f.third.email : f.first.contact_id!);
    if (!selected) { await input(page).press('Escape'); await expect(input(page)).toHaveValue(f.first.name!); }
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('keeps a typed query through a form redraw and preserves selected contacts when note rows reindex', async ({ page }) => {
  const f = await boot(page, 'note');
  try {
    f.holdTimeline('note:note-one'); await open(page, 'note'); await expect(input(page, 'note')).toHaveValue(f.first.name!);
    await expect.poll(() => f.waiting('timeline:note:note-one')).toBe(true);
    await input(page, 'note').fill('Alex'); await expect(picker(page, 'note').getByRole('option')).toHaveCount(1);
    // The editor's real activity response redraws the host while the owner
    // is searching. Observe replacement so the assertion cannot pass early.
    await input(page, 'note').evaluate(node => Object.assign(window, { __contactPickerBeforeRedraw: node }));
    f.release('timeline:note:note-one');
    await page.waitForFunction(() => !(window as unknown as { __contactPickerBeforeRedraw: Element }).__contactPickerBeforeRedraw.isConnected);
    await expect(input(page, 'note')).toHaveValue('Alex'); await expect(mirror(page, 'note')).toHaveValue(f.first.contact_id!);
    await expect(picker(page, 'note').getByRole('option')).toHaveCount(1);
    await input(page, 'note').press('Escape');
    await editor(page, 'note').locator('[data-form-array-add="related_contact"]').click(); await choose(page, 'note', 'Alex', f.third.email, 2);
    await editor(page, 'note').locator('[data-form-array-remove="related_contact"][data-form-array-index="0"]').click();
    await expect(input(page, 'note')).toHaveValue(f.second.name!); await expect(input(page, 'note', 1)).toHaveValue('Alex');
    await expect(mirror(page, 'note', 1)).toHaveValue(f.third.email);
    await editor(page, 'note').getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => f.writes.length).toBe(1);
    expect(f.note().related_contact_ids).toEqual([f.second.email, f.third.email]);
  } finally { f.dispose(); }
});

test('an old label cannot rename the next note row after its reference is removed', async ({ page }) => {
  const f = await boot(page, 'note', f => f.holdName(f.first.contact_id!));
  try {
    await open(page, 'note'); await expect.poll(() => f.waiting(f.first.contact_id!)).toBe(true);
    await expect(input(page, 'note', 1)).toHaveValue(f.second.name!);
    await editor(page, 'note').locator('[data-form-array-remove="related_contact"][data-form-array-index="0"]').click();
    f.release(f.first.contact_id!); await expect(picker(page, 'note')).toContainText(f.second.email);
    await expect(mirror(page, 'note')).toHaveValue(f.second.email);
    await editor(page, 'note').getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => f.writes.length).toBe(1);
    expect(f.note().related_contact_ids).toEqual([f.second.email]);
  } finally { f.dispose(); }
});

for (const kind of ['task', 'note'] as const) test(`resolves a selected contact after resuming a new ${kind} draft`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 }); const f = await boot(page, kind, undefined, true);
  try {
    await page.getByRole('button', { name: `+ New ${kind === 'task' ? 'Task' : 'Note'}`, exact: true }).click();
    await editor(page, kind).locator('[data-form-field="title"]').fill('Unfinished contact work');
    if (kind === 'note') await editor(page, kind).locator('[data-form-field="body"]').fill('Keep the chosen person.');
    await details(page, kind);
    if (kind === 'note') await editor(page, kind).locator('[data-form-array-add="related_contact"]').click();
    await choose(page, kind, f.second.name!, f.second.email); await reload(page);
    await page.getByRole('region', { name: kind === 'task' ? 'Unfinished tasks' : 'Unfinished notes', exact: true }).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await details(page, kind); await expect(input(page, kind)).toHaveValue(f.second.name!); await expect(picker(page, kind)).toContainText(f.second.email);
    await expect(mirror(page, kind)).toHaveValue(f.second.email); expect(f.writes).toEqual([]);
    await page.screenshot({ path: info.outputPath(`resumed-${kind}-contact-phone.png`), fullPage: true });
    await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => f.writes.length).toBe(1);
    expect(f.writes[0]).toMatchObject(kind === 'task' ? { kind, assigned_contact_id: f.second.email } : { kind, related_contact_ids: [f.second.email] });
  } finally { f.dispose(); }
});

test('keeps an unavailable stored reference through unrelated task edits', async ({ page }) => {
  const f = await boot(page, 'task', f => f.reply(f.first.contact_id!, null));
  try {
    await open(page); await expect(input(page)).toHaveValue('Unavailable contact'); await expect(picker(page)).toContainText('Its saved reference is kept');
    await expect(mirror(page)).toHaveValue(f.first.contact_id!);
    await editor(page).getByRole('textbox', { name: 'Title', exact: true }).fill('Keep unavailable person');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => f.writes.length).toBe(1);
    expect(f.task().assigned_contact_id).toBe(f.first.contact_id); expect(f.writes[0]).not.toHaveProperty('assigned_contact_id');
  } finally { f.dispose(); }
});

test('retries failed contact details without changing the saved reference', async ({ page }) => {
  const f = await boot(page, 'task', f => f.failName(f.first.contact_id!, true));
  try {
    await open(page); await expect(picker(page)).toContainText('Contact details interrupted'); await expect(mirror(page)).toHaveValue(f.first.contact_id!);
    f.failName(f.first.contact_id!, false); await picker(page).getByRole('button', { name: 'Retry contact details', exact: true }).click();
    await expect(input(page)).toHaveValue(f.first.name!); await expect(picker(page)).toContainText(f.first.email); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('recovers failed searches, reports a real capped page and distinguishes equal contact names', async ({ page }) => {
  const f = await boot(page, 'task', f => f.seedContacts(25));
  try {
    await open(page); f.failSearch(true); await input(page).fill('Paged'); await expect(picker(page)).toContainText('Contact search interrupted');
    await expect(mirror(page)).toHaveValue(f.first.contact_id!); f.failSearch(false);
    await picker(page).getByRole('button', { name: 'Try again', exact: true }).click(); await expect(picker(page).getByRole('option')).toHaveCount(20);
    await expect(picker(page)).toContainText('More contacts match');
    await input(page).fill('Riley'); await expect(picker(page).getByRole('option')).toHaveCount(2);
    await picker(page).getByRole('option').filter({ hasText: f.second.email }).click(); await expect(mirror(page)).toHaveValue(f.second.email);
    await expect(picker(page).locator('[data-contact-picker-status]')).toContainText(f.second.email); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const legacy of [false, true]) test(`resolves a merged contact ${legacy ? 'email' : 'stable ID'} without rewriting that stored reference`, async ({ page }) => {
  const f = await boot(page, 'task', f => { if (legacy) f.legacyTask(); f.merge(); });
  try {
    const stored = f.task().assigned_contact_id!; await open(page); await expect(input(page)).toHaveValue(f.second.name!);
    await expect(picker(page)).toContainText(f.second.email); await expect(mirror(page)).toHaveValue(stored); expect(f.writes).toEqual([]);
    await editor(page).getByRole('textbox', { name: 'Title', exact: true }).fill('Review merged person'); await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => f.writes.length).toBe(1); expect(f.task().assigned_contact_id).toBe(stored);
  } finally { f.dispose(); }
});

test('retired contact reads cannot change a different task editor', async ({ page }) => {
  const f = await boot(page);
  try {
    await expect(page.getByRole('button', { name: `Open contact ${f.first.name}`, exact: true })).toBeVisible();
    f.holdName(f.first.contact_id!); await open(page); await expect.poll(() => f.waiting(f.first.contact_id!)).toBe(true);
    await page.evaluate(() => window.__app.setHash('#data/task/task-two'));
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible(); await open(page);
    f.release(f.first.contact_id!); await expect(input(page)).toHaveValue('Alex'); await expect(mirror(page)).toHaveValue(f.third.contact_id!);
    await expect(picker(page)).toContainText(f.third.email); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('clears contact array rows without saving empty references or losing the remaining contact', async ({ page }) => {
  const f = await boot(page, 'note');
  try {
    await open(page, 'note'); await expect(input(page, 'note')).toHaveValue(f.first.name!);
    await picker(page, 'note').getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(mirror(page, 'note')).toHaveValue(f.second.email); await expect(picker(page, 'note')).toContainText(f.second.email);
    await picker(page, 'note').getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(editor(page, 'note').locator('[data-form-array-item="related_contact"]')).toHaveCount(0);
    await editor(page, 'note').getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => f.writes.length).toBe(1);
    expect(f.note().related_contact_ids).toEqual([]); expect(f.writes[0]).toMatchObject({ related_contact_ids: [] });
  } finally { f.dispose(); }
});
