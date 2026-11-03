import { expect, test, type Page } from '@playwright/test';
import type { MailDraft } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
type MailMode = 'ready' | 'none' | 'read_only' | 'draft_only' | 'unavailable';
const selectedAddress = 'alex+desk@example.test';
const detail = (page: Page) => page.locator('[data-recued-data-contact-detail]');
const email = (page: Page) => detail(page).getByRole('button', { name: 'Email', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'New mail', exact: true });
const field = (page: Page, name: string) => dialog(page).locator(`[data-form-field="${name}"]`);
const openContact = async (page: Page, address = selectedAddress) => {
  await page.evaluate(address => window.__app.setHash(`#data/contact/${encodeURIComponent(address)}`), address);
  await expect(email(page)).toBeVisible();
};
const discard = async (page: Page) => {
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
};

const boot = async (page: Page, mode: MailMode = 'ready'): Promise<void> => {
  await page.addInitScript(({ mode, selectedAddress }) => {
    let currentMode = mode, holdNext = false, reads = 0, completed = 0;
    let releaseRead: (() => void) | undefined;
    let saved: MailDraft | null = null;
    const executions: Array<{ recipe_id: string; config: Record<string, unknown> }> = [];
    const alex = { email: 'alex@example.test', name: 'Alex Rivera', source: 'manual', interaction_count: 4,
      first_seen_at: 1_700_000_000_000, last_seen_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 };
    const contact = (address: string) => address === selectedAddress || address === alex.email ? alex
      : address === 'blair@example.test' ? { ...alex, email: address, name: 'Blair Chen' }
        : address === 'merged@example.test' ? { ...alex, email: address, merged_into: alex.email } : null;
    Object.assign(window, { __contactMail: {
      executions, saved: () => structuredClone(saved), reads: () => reads, completed: () => completed,
      setMode(value: MailMode) { currentMode = value; },
      hold() { holdNext = true; },
      release() { if (!releaseRead) throw new Error('No account read is waiting.'); const done = releaseRead; releaseRead = undefined; done(); },
    }, __connectionsFixture: async (method: string, raw: unknown) => {
      const args = raw as Record<string, unknown> | undefined;
      if (method === 'contact.list') return { result: { contacts: [alex], total: 1, rollups: {} } };
      if (method === 'contact.get') return { result: { contact: contact(args?.email as string), identifiers: {
        emails: ['alex@example.test'], phones: [],
      } } };
      // An address with no contact of its own asks whose second address it is.
      if (method === 'contact.resolve') return { result: { contact: contact(args?.email as string) } };
      if (method === 'contact.search.local') return { result: { contacts: [
        { email: selectedAddress, name: alex.name }, { email: 'blair@example.test', name: 'Blair Chen' },
      ], total: 2, rollups: {} } };
      if (method === 'contact.contributions') return { result: { contributions: [] } };
      if (method === 'yours.read' && args?.contact_id) return { result: { episodes: [], occasions: [] } };
      if (method === 'data.timeline') return { result: { entries: [] } };
      if (method === 'collection.mail.list') {
        reads++;
        const responseMode = currentMode;
        if (holdNext) { holdNext = false; await new Promise<void>(done => { releaseRead = done; }); }
        completed++;
        if (responseMode === 'unavailable') return { error: { code: 'unavailable', message: 'Mail accounts unavailable.' } };
        return { result: { instances: responseMode === 'none' ? [] : [
          { slug: 'work', adapter_type: 'gmail', account_email: 'owner@example.test',
            send_capable: responseMode === 'ready', draft_capable: responseMode !== 'read_only',
            receive_capable: true, auth_state: 'healthy', caps: {} },
          ...(responseMode === 'ready' ? [{ slug: 'other', adapter_type: 'smtp', account_email: 'other@example.test',
            send_capable: true, draft_capable: false, receive_capable: false, auth_state: 'healthy', caps: {} }] : []),
        ] } };
      }
      if (method === 'mail.drafts.create' || method === 'mail.drafts.update') {
        saved = { draft_id: 'mad_00000000-0000-4000-8000-000000000001', incarnation: 'contact-draft',
          revision: (saved?.revision ?? 0) + 1, content: structuredClone(args?.content) as MailDraft['content'],
          origin_contract_id: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_001 };
        return { result: structuredClone(saved) };
      }
      if (method === 'execute') {
        executions.push(structuredClone(args) as { recipe_id: string; config: Record<string, unknown> });
        return { result: { success: false, awaiting_approval: true } };
      }
      return undefined;
    } });
  }, { mode, selectedAddress });
  await page.goto(`${HARNESS_URL}?data=contacts&settle_reads=1#data/search`);
  await page.waitForFunction(() => window.__app?.ready === true);
};

test('starts an editable email to the displayed address, preserves an open draft and returns to search after approval', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const search = page.getByRole('searchbox', { name: 'Search everything' });
  await search.fill('Northwind');
  const result = page.locator(`[data-search-contact-email="${selectedAddress}"]`);
  await result.click();
  await expect(detail(page)).toContainText(selectedAddress);
  await page.screenshot({ path: testInfo.outputPath('contact-email-mobile.png'), fullPage: true });
  const hash = await page.evaluate(() => location.hash);
  await email(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('[data-form-array-item="to"]')).toHaveValue(selectedAddress);
  await expect(field(page, 'subject')).toBeEmpty();
  await expect(field(page, 'body')).toBeEmpty();
  expect(await page.evaluate(() => window.__contactMail.executions)).toEqual([]);
  expect(await page.evaluate(() => window.__contactMail.saved())).toBeNull();
  await field(page, 'body').fill('Please review the revised scope.');
  // A second entry attempt cannot replace the draft, even before the modal's hit testing.
  await email(page).evaluate(button => (button as HTMLButtonElement).click());
  await expect(field(page, 'body')).toHaveValue('Please review the revised scope.');
  await expect(dialog(page)).toHaveCount(1);
  await expect(detail(page).getByRole('alert')).toContainText('Finish or close your open email');
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  await dialog(page).locator('[data-form-array-item="to"]').fill('reviewer@example.test');
  await dialog(page).locator('[data-action="select-mail-compose-sender"]').selectOption('other');
  await field(page, 'subject').fill('Scope review');
  await dialog(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(detail(page).getByRole('status')).toContainText('Email is waiting for approval.');
  await expect(email(page)).toBeFocused();
  const sent = await page.evaluate(() => window.__contactMail.executions);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ recipe_id: 'send-composed-mail', config: { sender_mail_instance: 'other',
    to: ['reviewer@example.test'], subject: 'Scope review', body: 'Please review the revised scope.' } });
  expect(sent[0]?.config.in_reply_to ?? null).toBeNull();
  expect(sent[0]?.config.references ?? []).toEqual([]);
  expect(sent[0]?.config.cc ?? []).toEqual([]);
  expect(sent[0]?.config.bcc ?? []).toEqual([]);
  await page.getByRole('button', { name: /Back to search/ }).click();
  await expect(search).toHaveValue('Northwind');
  await expect(result).toBeFocused();
});

for (const [mode, message] of [
  ['none', 'Connect a mailbox in Connections'],
  ['read_only', 'Your mailboxes are read-only'],
  ['unavailable', 'Your mail accounts could not be checked'],
] as const) {
  test(`explains ${mode} mail readiness on the contact and retries without losing the profile`, async ({ page }) => {
    await boot(page, mode); await openContact(page);
    await email(page).focus();
    await email(page).press('Enter');
    await expect(detail(page).getByRole('alert')).toContainText(message);
    await expect(dialog(page)).toHaveCount(0);
    await expect(email(page)).toBeEnabled();
    await expect(email(page)).toBeFocused();
    await page.evaluate(() => window.__contactMail.setMode('ready'));
    await email(page).click();
    await expect(dialog(page)).toBeVisible();
    await discard(page);
    await expect(email(page)).toBeFocused();
    await expect(detail(page).getByRole('alert')).toHaveCount(0);
    await expect(detail(page)).not.toContainText('Email sent.');
    expect(await page.evaluate(() => window.__contactMail.executions)).toEqual([]);
  });
}

test('keeps a draft-only mailbox useful without enabling sending', async ({ page }) => {
  await boot(page, 'draft_only'); await openContact(page);
  await email(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(dialog(page).getByRole('button', { name: 'Schedule…', exact: true })).toBeDisabled();
  await field(page, 'subject').fill('Follow up');
  await field(page, 'body').fill('Save this for later.');
  await dialog(page).getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('[data-mail-draft-status]')).toContainText('Draft saved.');
  expect(await page.evaluate(() => window.__contactMail.saved()?.content)).toMatchObject({
    sender_mail_instance: 'work', to: [selectedAddress], subject: 'Follow up', body: 'Save this for later.',
  });
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(email(page)).toBeFocused();
  expect(await page.evaluate(() => window.__contactMail.executions)).toEqual([]);
});

test('retires an old contact account read while a newer contact opens its own email', async ({ page }) => {
  await boot(page); await openContact(page);
  await page.evaluate(() => window.__contactMail.hold());
  await email(page).click();
  await expect(detail(page).getByRole('button', { name: 'Opening…', exact: true })).toBeDisabled();
  await openContact(page, 'blair@example.test');
  await email(page).click();
  await expect(dialog(page).locator('[data-form-array-item="to"]')).toHaveValue('blair@example.test');
  await field(page, 'body').fill('Blair draft');
  const completed = await page.evaluate(() => window.__contactMail.completed());
  await page.evaluate(() => window.__contactMail.release());
  await expect.poll(() => page.evaluate(() => window.__contactMail.completed())).toBe(completed + 1);
  await expect(dialog(page)).toHaveCount(1);
  await expect(dialog(page).locator('[data-form-array-item="to"]')).toHaveValue('blair@example.test');
  await expect(field(page, 'body')).toHaveValue('Blair draft');
  await discard(page);
});

test('leaving Data retires a pending account read without a late compose portal', async ({ page }) => {
  await boot(page); await openContact(page);
  await page.evaluate(() => window.__contactMail.hold());
  await email(page).click();
  await expect(detail(page).getByRole('button', { name: 'Opening…', exact: true })).toBeDisabled();
  const completed = await page.evaluate(() => window.__contactMail.completed());
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(detail(page)).toHaveCount(0);
  await page.evaluate(() => window.__contactMail.release());
  await expect.poll(() => page.evaluate(() => window.__contactMail.completed())).toBe(completed + 1);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('[data-mail-reply-compose-portal]')).toHaveCount(0);
});

test('a Memory round trip retires the old account read and allows a fresh Email attempt', async ({ page }) => {
  await boot(page); await openContact(page);
  await page.evaluate(() => window.__contactMail.hold());
  await email(page).click();
  await expect(detail(page).getByRole('button', { name: 'Opening…', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(detail(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await expect(email(page)).toBeEnabled();
  await email(page).click();
  await expect(dialog(page)).toBeVisible();
  const completed = await page.evaluate(() => window.__contactMail.completed());
  await page.evaluate(() => window.__contactMail.release());
  await expect.poll(() => page.evaluate(() => window.__contactMail.completed())).toBe(completed + 1);
  await expect(dialog(page)).toHaveCount(1);
  await expect(dialog(page).locator('[data-form-array-item="to"]')).toHaveValue(selectedAddress);
  await discard(page);
});

test('browser Back honors the email draft guard before returning to search', async ({ page }) => {
  await boot(page);
  const search = page.getByRole('searchbox', { name: 'Search everything' });
  await search.fill('Northwind');
  const result = page.locator(`[data-search-contact-email="${selectedAddress}"]`);
  await result.click();
  const contactHash = await page.evaluate(() => location.hash);
  await email(page).click();
  await field(page, 'body').fill('Keep this unfinished email.');
  const prompts: string[] = [];
  page.once('dialog', prompt => { prompts.push(prompt.message()); void prompt.dismiss(); });
  await page.goBack();
  await expect.poll(() => prompts.length).toBe(1);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(contactHash);
  await expect(field(page, 'body')).toHaveValue('Keep this unfinished email.');
  await discard(page);
  await page.goBack();
  await expect(search).toHaveValue('Northwind');
  await expect(result).toBeFocused();
  await result.click();
  await email(page).click();
  page.once('dialog', prompt => { prompts.push(prompt.message()); void prompt.accept(); });
  await page.goBack();
  await expect.poll(() => prompts.length).toBe(2);
  await expect(dialog(page)).toHaveCount(0);
  await expect(search).toBeVisible();
});

test('contact editing retires a pending Email check and allows a fresh email after editing', async ({ page }) => {
  await boot(page); await openContact(page);
  await page.evaluate(() => window.__contactMail.hold());
  await email(page).click();
  await expect(detail(page).getByRole('button', { name: 'Opening…', exact: true })).toBeDisabled();
  await detail(page).getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit contact', exact: true });
  await editor.getByLabel('Name', { exact: true }).fill('Alex, edited locally');
  const completed = await page.evaluate(() => window.__contactMail.completed());
  await page.evaluate(() => window.__contactMail.release());
  await expect.poll(() => page.evaluate(() => window.__contactMail.completed())).toBe(completed + 1);
  await expect(dialog(page)).toHaveCount(0);
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Alex, edited locally');
  await expect(editor.getByLabel('Name', { exact: true })).toBeFocused();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await editor.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(email(page)).toBeEnabled();
  await email(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('[data-form-array-item="to"]')).toHaveValue(selectedAddress);
  await discard(page);
  expect(await page.evaluate(() => window.__contactMail.executions)).toEqual([]);
});

test('offers no Email action for a missing or merged contact', async ({ page }) => {
  await boot(page);
  for (const address of ['missing@example.test', 'merged@example.test']) {
    await page.evaluate(address => window.__app.setHash(`#data/contact/${encodeURIComponent(address)}`), address);
    await expect(detail(page)).toContainText(address === 'missing@example.test' ? 'No contact record found' : 'This contact was merged');
    await expect(email(page)).toHaveCount(0);
  }
  expect(await page.evaluate(() => window.__contactMail.reads())).toBe(0);
});

declare global { interface Window { __contactMail: {
  executions: Array<{ recipe_id: string; config: Record<string, unknown> }>;
  saved(): MailDraft | null; reads(): number; completed(): number;
  setMode(value: MailMode): void; hold(): void; release(): void;
} } }
