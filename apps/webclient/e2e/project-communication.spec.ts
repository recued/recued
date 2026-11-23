import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks, CHAT_INPUT, CHAT_SEND } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute } from '../src/shell/route.js';
import { readRecordChatMessage, selectedRecordsOf } from '../src/chat/record-context.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const hash = (id = 'project-one') => serializeShellRoute('data', 'project', id), title = 'Release <team>';
const overview = (page: Page) => page.locator('[data-project-overview]');
const actions = (page: Page) => overview(page).locator('[data-project-communication]');
const mailButton = (page: Page) => actions(page).getByRole('button', { name: 'Draft status email', exact: true });
const chatButton = (page: Page) => actions(page).getByRole('button', { name: 'Chat about project', exact: true });
const recipient = (page: Page) => actions(page).getByRole('combobox', { name: 'Recipient', exact: true });
const continueMail = (page: Page) => actions(page).getByRole('button', { name: 'Continue to email', exact: true });
const mail = (page: Page) => page.getByRole('dialog', { name: 'New mail', exact: true });
const brief = (page: Page) => mail(page).getByRole('textbox', { name: 'What should this email say?', exact: true });
const query = (page: Page) => overview(page).getByRole('searchbox', { name: 'Search this project', exact: true });
const visit = (page: Page, address: string) => page.evaluate(address => { location.hash = address; }, address);
const attentionRows = (page: Page) => overview(page).locator('[data-project-attention-list] [data-action="project-attention-open"]');
const boot = async (page: Page, opts: { prepare?: (f: Fixture) => void | Promise<void>; mailbox?: 'none' | 'read_only' | 'unavailable'; address?: string } = {}) => {
  const sends: Record<string, unknown>[] = [], executions: Record<string, unknown>[] = [];
  const session = { id: 'created', title: 'Project conversation', created_at: 1, last_active_at: 2, archived: false,
    picker_state: { current: 'self' }, model_routing: { current: 'byok', provider: 'openai', model_id: 'fixture' } };
  const f = await installTaskNoteSourceFixture(page, { searchable: true, caller: async (method, args) => {
    if (method === 'execute') { executions.push(structuredClone(args)); return { result: { success: true, output: { render: [{ type: 'text', data: 'Project update draft.' }] } } }; }
    if (method === 'chat.sessions.list') return { result: { sessions: sends.length ? [{ ...session, message_count: sends.length }] : [] } };
    if (method === 'chat.session.create') return { result: { session_id: session.id } };
    if (method === 'chat.session.get') return { result: { ...session, id: args.session_id, plans: [], messages: sends.map((row, i) => ({ id: 'user-' + i, session_id: args.session_id,
      role: 'user', content: row.message, ts: 3, target_server: 'self', picker_at_send: { display_name: 'Self' }, model_used: { provider: 'openai', model_id: 'fixture' } })) } };
    if (method === 'chat.send') { sends.push(structuredClone(args)); return { result: { turn_id: 'turn-' + sends.length, status: 'succeeded' } }; }
    if (method === 'collection.mail.list' && opts.mailbox) return opts.mailbox === 'unavailable'
      ? { error: { code: 'unavailable', message: 'Mailbox check interrupted' } }
      : { result: { instances: opts.mailbox === 'none' ? [] : [{ slug: 'read-only', adapter_type: 'gmail', account_email: 'owner@example.test', send_capable: false, draft_capable: false, receive_capable: true }] } };
    return undefined;
  } });
  const second = await f.seedContact('sam@example.test', 'Sam <team>');
  f.updateProject('project-one', { title, description: 'PRIVATE_PROJECT_DETAIL', target_completion_at: Date.parse('2026-11-15'), related_contact_ids: [f.person.contact_id!, second.contact_id!] });
  f.seedProject('project-two', { title: 'Another project' });
  for (let i = 0; i < 12; i++) f.seedTask('overdue-' + i, { title: 'Overdue project task ' + i, parent_project_id: 'project-one', due_at: Date.parse('2026-10-30T18:00:00Z') - i * 1000 });
  f.seedTask('completed', { title: 'Finished project task', done: true, parent_project_id: 'project-one' });
  for (const id of ['approval', 'delivery']) f.seedCommitment(id, { statement: 'Private commitment ' + id, blocks_project_ids: ['project-one'] });
  f.seedNote('matching-note', { title: 'Matching note', body: 'Project search context.', related_project_ids: ['project-one'] });
  await opts.prepare?.(f); await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + (opts.address ?? hash()));
  await page.waitForFunction(() => window.__app?.ready === true);
  if (!opts.address || opts.address === hash()) { await expect(overview(page)).toHaveAttribute('data-project-overview', 'project-one'); await expect(mailButton(page)).toBeEnabled(); await expect(overview(page).getByRole('button', { name: '12 Overdue tasks', exact: true })).toBeVisible(); }
  return { ...f, second, sends, executions };
};
const choose = async (page: Page, id: string) => { await mailButton(page).click(); await expect(recipient(page)).toBeVisible(); await recipient(page).selectOption(id); };
const filter = async (page: Page) => {
  await query(page).fill('Matching note'); await query(page).press('Enter');
  await overview(page).getByRole('group', { name: 'Tasks to show', exact: true }).getByRole('button', { name: 'Completed', exact: true }).click();
};

test('drafting a status email uses an explicitly chosen person and fresh complete facts in the existing AI composer', async ({ page }, info) => {
  const f = await boot(page);
  try {
    await filter(page); await mailButton(page).focus(); await page.keyboard.press('Enter'); await expect(recipient(page)).toHaveValue(''); await expect(continueMail(page)).toBeDisabled();
    await expect(recipient(page)).toContainText(f.person.name!); await expect(recipient(page)).toContainText(f.second.name!); await recipient(page).selectOption(f.person.contact_id!);
    await page.screenshot({ path: info.outputPath('project-recipient-phone.png'), fullPage: true });
    f.updateTask('overdue-0', { done: true }); await continueMail(page).click(); await expect(brief(page)).toBeFocused();
    const text = await brief(page).inputValue(); expect(text).toContain(f.person.email); expect(text).toContain('13 open, 2 completed'); expect(text).toContain('Overdue tasks: 11');
    expect(text).toContain('Outstanding blocking commitments: 2'); expect(text).toContain('2026-11-15'); expect(text).toContain('America/Los_Angeles'); expect(text).not.toMatch(/PRIVATE_PROJECT_DETAIL|Private commitment|project-one/);
    await brief(page).fill('Keep this editable project update brief.'); expect(f.executions).toEqual([]); expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
    await page.screenshot({ path: info.outputPath('project-update-email-phone.png'), fullPage: true });
    await mail(page).getByRole('button', { name: 'Close', exact: true }).click(); await mail(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
    await expect(mailButton(page)).toBeFocused(); await expect(query(page)).toHaveValue('Matching note'); await expect(overview(page).getByRole('group', { name: 'Tasks to show', exact: true }).getByRole('button', { name: 'Completed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally { f.dispose(); }
});

test('a project without linked contacts offers no invented recipient', async ({ page }) => {
  const f = await boot(page, { prepare: f => { f.updateProject('project-one', { related_contact_ids: [] }); } });
  try { await mailButton(page).click(); await expect(actions(page)).toContainText('No contacts are linked'); await expect(continueMail(page)).toBeDisabled(); await expect(mail(page)).toHaveCount(0); expect(f.executions).toEqual([]); expect(f.writes).toEqual([]); }
  finally { f.dispose(); }
});

for (const change of ['email', 'link', 'project'] as const) test(`a changed ${change} is refused before drafting a project update`, async ({ page }) => {
  const f = await boot(page);
  try {
    await choose(page, f.person.contact_id!);
    if (change === 'email') f.contactReply(f.person.contact_id!, { ...f.person, email: 'changed@example.test' });
    else if (change === 'link') f.updateProject('project-one', { related_contact_ids: [f.second.contact_id!] });
    else { f.removeProject(); f.seedProject('project-one', { title: 'Replacement project', related_contact_ids: [f.person.contact_id!] }, Date.parse('2026-11-02T00:00:00Z')); }
    await continueMail(page).click(); await expect(actions(page).getByRole('alert')).toContainText(change === 'email' ? 'email address changed' : change === 'link' ? 'no longer linked' : 'removed or replaced');
    await expect(mail(page)).toHaveCount(0); expect(f.executions).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('failed linked-contact reads remain explicit and can be retried', async ({ page }) => {
  const f = await boot(page);
  try {
    f.fail('contact.get', f.person.contact_id!); await mailButton(page).click(); await expect(recipient(page).locator('option', { hasText: 'Contact unavailable' })).toHaveJSProperty('disabled', true);
    await expect(continueMail(page)).toBeDisabled(); f.fail('contact.get', f.person.contact_id!, false);
    await actions(page).getByRole('button', { name: 'Reload contacts', exact: true }).click(); await expect(recipient(page)).toContainText(f.person.email); await expect(recipient(page)).toHaveValue(''); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const mailbox of ['none', 'read_only', 'unavailable'] as const) test(`mailbox readiness ${mailbox} keeps the project and recipient choice available`, async ({ page }) => {
  const f = await boot(page, { mailbox });
  try {
    await choose(page, f.person.contact_id!); await continueMail(page).click(); await expect(actions(page).getByRole('alert')).toContainText(mailbox === 'none' ? 'Connect a mailbox' : mailbox === 'read_only' ? 'read-only' : 'could not be checked');
    await expect(mail(page)).toHaveCount(0); await expect(recipient(page)).toHaveValue(f.person.contact_id!); expect(f.executions).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const operation of ['summary', 'mailbox'] as const) test(`a delayed ${operation} read cannot open an email over a newer project`, async ({ page }) => {
  const f = await boot(page);
  try {
    if (operation === 'summary') { f.hold('work_entity.project.attention', 'project-one'); await mailButton(page).click(); }
    else { await choose(page, f.person.contact_id!); f.hold('collection.mail.list', ''); await continueMail(page).click(); }
    await expect.poll(f.waiting).toBe(true); await visit(page, hash('project-two')); await expect(overview(page)).toHaveAttribute('data-project-overview', 'project-two');
    f.release(); await expect(overview(page)).toContainText('Another project'); await expect(mail(page)).toHaveCount(0); expect(f.executions).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('Chat attaches the exact project and Back restores the project query, draft, filters, loaded attention and focus', async ({ page }, info) => {
  const f = await boot(page);
  try {
    await filter(page); await overview(page).getByRole('button', { name: '12 Overdue tasks', exact: true }).click(); await overview(page).getByRole('button', { name: 'More attention items', exact: true }).click(); await expect(attentionRows(page)).toHaveCount(12);
    await query(page).fill('Keep this unsubmitted query'); await chatButton(page).focus(); const top = await chatButton(page).evaluate(node => node.getBoundingClientRect().top); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#chat\/new$/); const input = page.locator(`[${CHAT_INPUT}]`); await expect(input).toHaveValue('What needs attention in this project, and what should I do next?');
    await expect(page.locator('[data-chat-selected-records]').getByRole('link', { name: title, exact: true })).toBeVisible(); expect(f.sends).toEqual([]); expect(f.executions).toEqual([]);
    await page.screenshot({ path: info.outputPath('project-chat-phone.png'), fullPage: true });
    page.once('dialog', dialog => { void dialog.dismiss(); }); await page.goBack(); await expect(input).toHaveValue('What needs attention in this project, and what should I do next?');
    page.once('dialog', dialog => { void dialog.accept(); }); await page.goBack();
    await expect(query(page)).toHaveValue('Keep this unsubmitted query'); await expect(overview(page).getByRole('group', { name: 'Tasks to show', exact: true }).getByRole('button', { name: 'Completed', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(attentionRows(page)).toHaveCount(12); await expect(chatButton(page)).toBeFocused(); await expect.poll(() => chatButton(page).evaluate(node => node.getBoundingClientRect().top)).toBeCloseTo(top, 0);
    await chatButton(page).click(); await input.fill('What is blocking this project?'); await page.locator(`[${CHAT_SEND}]`).click(); await expect.poll(() => f.sends.length).toBe(1);
    const context = readRecordChatMessage(String(f.sends[0]!.message))!, records = selectedRecordsOf(context.context); expect(context.question).toBe('What is blocking this project?');
    expect(records[0]!.reference.identity).toBe(JSON.stringify(['project', f.project().id, f.project().source_id, null, f.project().created_at])); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a reused project is refused by the Chat action', async ({ page }) => {
  const f = await boot(page);
  try {
    f.removeProject(); f.seedProject('project-one', { title: 'Replacement project' }, Date.parse('2026-11-02T00:00:00Z')); await chatButton(page).click();
    await expect(actions(page).getByRole('alert')).toContainText('removed or replaced'); await expect(overview(page)).toContainText(title); await expect(page).toHaveURL(/#data\/project\/project-one$/); expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('an existing project email draft stays protected when Chat is requested', async ({ page }) => {
  const f = await boot(page);
  try {
    await choose(page, f.person.contact_id!); await continueMail(page).click(); await mail(page).locator('[data-form-field="body"]').fill('Keep this unfinished project email.');
    const reads = f.reads.length; await chatButton(page).evaluate(node => (node as HTMLButtonElement).click()); await expect(brief(page)).toBeFocused();
    await expect(mail(page).locator('[data-form-field="body"]')).toHaveValue('Keep this unfinished project email.'); expect(f.reads).toHaveLength(reads); expect(f.sends).toEqual([]); expect(f.executions).toEqual([]); await expect(page).toHaveURL(/#data\/project\/project-one$/);
  } finally { f.dispose(); }
});

test('Add records finds projects by name and previews and attaches their exact saved identity', async ({ page }) => {
  const f = await boot(page, { address: '#chat/new' });
  try {
    await page.getByRole('button', { name: 'Add records', exact: true }).click(); const picker = page.locator('dialog[data-record-link-insert-dialog]');
    await picker.getByRole('combobox', { name: 'Record type', exact: true }).selectOption('project'); const search = picker.getByRole('searchbox', { name: 'Search records', exact: true }); await search.fill('Release'); await search.press('Enter');
    await picker.getByRole('button', { name: 'Preview ' + title, exact: true }).click(); const preview = picker.getByRole('region', { name: 'Record preview', exact: true });
    await expect(preview).toContainText('Saved status: active'); await preview.getByRole('button', { name: 'Add to selection', exact: true }).click(); await picker.getByRole('button', { name: 'Use 1 record', exact: true }).click();
    await expect(page.locator('[data-chat-selected-records]')).toContainText(title); expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a newer search interaction wins over delayed project return focus', async ({ page }) => {
  const f = await boot(page);
  try {
    await filter(page); await chatButton(page).click(); await expect(page).toHaveURL(/#chat\/new$/); f.hold('work_entity.project.items', ''); page.once('dialog', dialog => { void dialog.accept(); }); await page.goBack();
    await expect.poll(f.waiting).toBe(true); await query(page).fill('Newer project search'); f.release();
    await expect(overview(page).locator('[data-project-section="task"]')).not.toHaveAttribute('aria-busy', 'true'); await expect(query(page)).toHaveValue('Newer project search'); await expect(query(page)).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
