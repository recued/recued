import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installCommitmentFollowUpFixture } from './helpers/commitment-follow-up-fixture.js';

installFullAppHooks();
test.use({ timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installCommitmentFollowUpFixture>>;
const reader = (page: Page) => page.locator('.work-entity-commitment-reader');
const action = (page: Page) => reader(page).getByRole('button', { name: 'Draft follow-up', exact: true });
const compose = (page: Page) => page.getByRole('dialog', { name: 'New mail', exact: true });
const field = (page: Page, name: string) => compose(page).locator(`[data-form-field="${name}"]`);
const brief = (page: Page) => compose(page).getByRole('textbox', { name: 'What should this email say?', exact: true });
const boot = async (page: Page, prepare?: (f: Fixture) => void) => {
  const f = await installCommitmentFollowUpFixture(page); prepare?.(f);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/commitment/promise-one`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(reader(page)).toContainText('Send the revised proposal <team>'); return f;
};
const discard = async (page: Page) => {
  await compose(page).getByRole('button', { name: 'Close', exact: true }).click();
  const confirm = compose(page).getByRole('button', { name: 'Discard draft', exact: true });
  if (await confirm.isVisible()) await confirm.click();
  await expect(compose(page)).toHaveCount(0);
};
const recovery = (page: Page) => page.evaluate(() => Object.keys(sessionStorage)
  .filter(key => key.startsWith('recued.mail.compose-recovery.v1:'))
  .flatMap(key => JSON.parse(sessionStorage.getItem(key)!) as Array<{ id: string; brief: string; dialog: { values: { body: string } } }>));

test('drafts from quoted promise facts, keeps edits and saved mail, then returns to the exact reader', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); const f = await boot(page);
  try {
    const hash = await page.evaluate(() => location.hash);
    await action(page).click(); await expect(brief(page)).toBeFocused();
    await expect(compose(page).locator('[data-form-array-item="to"]')).toHaveValue(f.person.email);
    await expect(brief(page)).toHaveValue(/"statement": "Send the revised proposal <team>"/);
    await expect(brief(page)).toHaveValue(/"direction": "I owe them"/);
    await expect(brief(page)).toHaveValue(/"deadline": "2026-11-21"/);
    await expect(field(page, 'body')).toBeEmpty(); expect(f.executions).toEqual([]); expect(f.writes).toEqual([]);
    await brief(page).fill((await brief(page).inputValue()) + '\nAsk whether Friday still works.');
    await compose(page).getByRole('button', { name: 'Draft with AI', exact: true }).click();
    await expect(field(page, 'body')).toHaveValue('Hello Riley,\nHere is an update on the proposal.');
    expect(f.executions).toHaveLength(1); expect(f.executions[0]).toMatchObject({ recipe_id: 'draft-composed-mail',
      config: { to: [f.person.email], brief: expect.stringContaining('Ask whether Friday still works.') } });
    await field(page, 'subject').fill('Proposal update'); await field(page, 'body').fill('My reviewed update.');
    await compose(page).getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect.poll(() => f.saved()?.content.body).toBe('My reviewed update.');
    await compose(page).screenshot({ path: info.outputPath('commitment-follow-up-phone.png') });
    const saved = f.saved(); await discard(page);
    await expect(action(page)).toBeFocused(); expect(await page.evaluate(() => location.hash)).toBe(hash);
    await expect(reader(page)).toHaveAttribute('data-commitment-id', 'promise-one');
    await action(page).click(); await expect(brief(page)).toBeFocused(); expect(f.saved()).toEqual(saved);
    expect(f.executions.some(call => call.recipe_id === 'send-composed-mail')).toBe(false);
    await discard(page);
  } finally { f.dispose(); }
});

test('sending a reviewed follow-up retains the existing approval hold and returns focus', async ({ page }) => {
  const f = await boot(page);
  try {
    await action(page).click(); await field(page, 'subject').fill('Proposal follow-up'); await field(page, 'body').fill('Can you share an update?');
    await compose(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(compose(page)).toHaveCount(0);
    await expect(reader(page).getByRole('status').filter({ hasText: 'Follow-up is waiting for approval.' })).toBeVisible();
    await expect(action(page)).toBeFocused();
    expect(f.executions).toEqual([{ recipe_id: 'send-composed-mail', trigger_source: 'manual', config: expect.objectContaining({
      sender_mail_instance: 'work', to: [f.person.email], subject: 'Proposal follow-up', body: 'Can you share an update?' }) }]);
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('protects an already open email against another follow-up entry', async ({ page }) => {
  const f = await boot(page);
  try {
    await action(page).click(); await field(page, 'body').fill('Keep my unfinished draft.');
    await action(page).evaluate(button => (button as HTMLButtonElement).click());
    await expect(reader(page).getByRole('alert')).toContainText('Finish or close your open email');
    await expect(compose(page)).toHaveCount(1); await expect(field(page, 'body')).toHaveValue('Keep my unfinished draft.');
    expect(f.executions).toEqual([]); expect(f.writes).toEqual([]); await discard(page);
  } finally { f.dispose(); }
});

test('keeps recovery text and editable promise instructions when another follow-up opens after reload', async ({ page }) => {
  const f = await boot(page);
  try {
    await action(page).click(); await field(page, 'body').fill('Keep this recovery message.');
    await expect.poll(async () => (await recovery(page))[0]?.dialog.values.body).toBe('Keep this recovery message.');
    const previous = (await recovery(page))[0]!;
    page.once('dialog', prompt => { void prompt.accept(); }); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    const flushed = (await recovery(page))[0]!;
    expect(flushed).toMatchObject({ id: previous.id, brief: previous.brief, dialog: previous.dialog });
    await action(page).click(); await expect(brief(page)).toBeFocused();
    await expect.poll(async () => (await recovery(page)).length).toBe(2);
    expect((await recovery(page)).find(entry => entry.id === previous.id)).toEqual(flushed);
    await discard(page); expect(await recovery(page)).toEqual([flushed]); expect(f.executions).toEqual([]);
  } finally { f.dispose(); }
});

test('retries a failed contact check and refuses a commitment changed since it was read', async ({ page }) => {
  const f = await boot(page, f => f.failContact(true));
  try {
    await expect(reader(page).getByRole('alert')).toContainText('Contact details interrupted');
    f.failContact(false); f.change({ statement: 'A different promise' }); await action(page).click();
    await expect(reader(page).getByRole('alert')).toContainText('Reopen it before drafting');
    await expect(compose(page)).toHaveCount(0); expect(f.executions).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('uses saved promise edits and retains the action after discarding further edits', async ({ page }) => {
  const f = await boot(page);
  try {
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('.work-entity-dialog[data-kind="commitment"][data-mode="edit"]');
    await editor.locator('[data-form-field="statement"]').fill('Send the final proposal');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page)).toContainText('Commitment saved.'); await expect(action(page)).toBeEnabled();
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.locator('[data-form-field="statement"]').fill('Unsaved changes');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await action(page).click(); await expect(brief(page)).toHaveValue(/"statement": "Send the final proposal"/);
    expect(f.writes).toEqual(['work_entity.upsert']); expect(f.executions).toEqual([]); await discard(page);
  } finally { f.dispose(); }
});

for (const heldMethod of ['contact.get', 'collection.mail.list'] as const) {
  test(`drops a delayed ${heldMethod} check when the commitment reader closes`, async ({ page }) => {
    const f = await boot(page);
    try {
      await expect(action(page)).toBeEnabled(); f.hold(heldMethod); await action(page).click();
      await expect.poll(() => f.waiting(heldMethod)).toBe(true);
      await reader(page).getByRole('button', { name: 'Close', exact: true }).click(); await expect(reader(page)).toHaveCount(0);
      const count = f.completed(heldMethod); f.release(heldMethod); await expect.poll(() => f.completed(heldMethod)).toBe(count + 1);
      await expect(compose(page)).toHaveCount(0); expect(f.executions).toEqual([]); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });
}

test('explains a missing email address and hides follow-up on a closed commitment', async ({ page }) => {
  const f = await boot(page, f => f.replyContact({ ...f.person, email: 'not-an-address' }));
  try {
    await expect(reader(page)).toContainText('Add an email address to this contact'); await expect(action(page)).toHaveCount(0);
    f.replyContact(undefined); f.change({ lifecycle_state: 'fulfilled' });
    await reader(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => window.__app.setHash('#data/commitment/promise-one'));
    await expect(reader(page)).toContainText('Fulfilled'); await expect(action(page)).toHaveCount(0);
    expect(f.executions).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const mode of ['draft_only', 'none', 'unavailable'] as const) {
  test(`uses existing mailbox readiness for ${mode}`, async ({ page }) => {
    const f = await boot(page, f => f.mode(mode));
    try {
      await action(page).click();
      if (mode === 'draft_only') {
        await expect(brief(page)).toBeFocused(); await expect(compose(page).getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
        await field(page, 'subject').fill('Follow up later'); await field(page, 'body').fill('Draft for later.'); await compose(page).getByRole('button', { name: 'Save draft', exact: true }).click();
        await expect.poll(() => f.saved()?.content.body).toBe('Draft for later.'); await discard(page);
      } else {
        await expect(reader(page).getByRole('alert')).toContainText(mode === 'none' ? 'Connect a mailbox' : 'could not be checked');
        await expect(compose(page)).toHaveCount(0);
      }
      expect(f.executions).toEqual([]);
    } finally { f.dispose(); }
  });
}
