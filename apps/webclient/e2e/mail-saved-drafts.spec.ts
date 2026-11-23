import { expect, test, type Page } from '@playwright/test';
import type { MailDraft, MailDraftDeleteRequest, ServerRpcRegistry } from '@recued/contracts';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';

declare global {
  interface Window {
    __mailDraftsFixture: {
      rows: MailDraft[];
      failLists: number;
      failListAfterDelete: boolean;
      failMailboxRead: boolean;
      deleteOutcome: 'ok' | 'refused' | 'lost';
      deletes: MailDraftDeleteRequest[];
      lists: ServerRpcRegistry['mail.drafts.list']['request'][];
      gets: string[];
      holdListQuery: string | null;
      listPending: boolean;
      releaseList(): void;
      holdGet: boolean;
      getPending: boolean;
      releaseGet(): void;
    };
  }
}

test.use({ locale: 'en-US', timezoneId: 'UTC' });
const id = (n: number): string => `mad_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const drafts = (page: Page) => page.locator('[data-mail-saved-drafts]');
const row = (page: Page, n: number) => drafts(page).locator(`[data-mail-draft-id="${id(n)}"]`);
let errors: string[] = [], dialogs: string[] = [], popups: string[] = [];

test.beforeEach(({ page }) => {
  errors = []; dialogs = []; popups = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
  page.on('popup', popup => { popups.push(popup.url()); void popup.close(); });
});
test.afterEach(() => {
  expect(errors, 'uncaught browser errors').toEqual([]);
  expect(dialogs, 'browser dialogs').toEqual([]);
  expect(popups, 'popups').toEqual([]);
});

const openDrafts = async (page: Page, mailboxUnavailable = false): Promise<void> => {
  await page.addInitScript(unavailable => {
    window.__mailDraftsFixture = {
      rows: [1, 2, 3].map(n => ({
        draft_id: `mad_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        incarnation: 'fixture-generation', revision: 1, origin_contract_id: null,
        created_at: Date.parse('2026-10-24T08:00:00Z'), updated_at: Date.parse('2026-10-24T08:00:00Z') + n * 86_400_000,
        content: { sender_mail_instance: 'work', to: [n === 1 ? 'alex@example.test' : 'sam@example.test'],
          subject: n === 3 ? 'Another saved message' : 'Meeting follow-up', body: `Saved message ${n}.`, body_format: 'text' },
      })), failLists: 0, failListAfterDelete: false, failMailboxRead: unavailable, deleteOutcome: 'ok', deletes: [],
      lists: [], gets: [], holdListQuery: null, listPending: false, releaseList() {}, holdGet: false, getPending: false, releaseGet() {},
    };
    window.__connectionsFixture = async (method, raw) => {
      const state = window.__mailDraftsFixture;
      const args = (raw ?? {}) as ServerRpcRegistry['mail.drafts.list']['request'] & { draft_id?: string; expected_revision?: number; content?: MailDraft['content'] };
      if (method === 'collection.mail.list' && state.failMailboxRead) return { error: { code: 'fixture_mailbox_unavailable', message: 'Mailbox status is unavailable.' } };
      if (method === 'collection.mail.list') return { result: { instances: [{ slug: 'work', adapter_type: 'imap',
        send_capable: true, draft_capable: true, account_email: 'owner@example.test' }, { slug: 'personal', adapter_type: 'imap',
        send_capable: true, draft_capable: true, account_email: 'personal@example.test' }] } };
      if (method === 'mail.drafts.list') {
        state.lists.push(structuredClone(args));
        if (state.failLists > 0) { state.failLists--; return { error: { code: 'fixture_read_unavailable', message: 'Draft list refresh unavailable.' } }; }
        const found = state.rows.filter(draft => draft.draft_id > (args.cursor ?? '')).sort((a, b) => a.draft_id.localeCompare(b.draft_id));
        const page: MailDraft[] = []; let examined = 0;
        for (const draft of found.slice(0, 2)) {
          examined++;
          const { content } = draft;
          const fold = (value: string): string => value.normalize('NFKC').toLowerCase();
          if (args.sender_mail_instance && content.sender_mail_instance !== args.sender_mail_instance) continue;
          if (args.query && ![content.subject, ...content.to, ...(content.cc as string[] ?? []), ...(content.bcc as string[] ?? [])].some(value => fold(value).includes(fold(args.query!)))) continue;
          page.push(draft);
          if (page.length === (args.limit ?? 25)) break;
        }
        const result = { drafts: page.map(({ content, ...draft }) => ({ ...draft, subject: content.subject, sender_mail_instance: content.sender_mail_instance,
          to: content.to, cc: content.cc, bcc: content.bcc })), next_cursor: found.length > examined ? found[examined - 1]!.draft_id : null };
        if (state.holdListQuery !== null && args.query === state.holdListQuery) {
          state.holdListQuery = null; state.listPending = true;
          await new Promise<void>(done => { state.releaseList = () => { state.listPending = false; done(); }; });
        }
        return { result };
      }
      if (method === 'mail.drafts.get') {
        state.gets.push(args.draft_id!);
        const draft = state.rows.find(item => item.draft_id === args.draft_id);
        const result = draft ? { result: structuredClone(draft) } : { error: { code: 'mail_draft_not_found', message: 'Draft missing.' } };
        if (state.holdGet) {
          state.holdGet = false; state.getPending = true;
          await new Promise<void>(done => { state.releaseGet = () => { state.getPending = false; done(); }; });
        }
        return result;
      }
      if (method === 'mail.drafts.update') {
        const draft = state.rows.find(item => item.draft_id === args.draft_id);
        if (!draft || draft.revision !== args.expected_revision) return { error: { code: 'mail_draft_stale', message: 'This draft changed.' } };
        draft.content = structuredClone(args.content!); draft.revision++; draft.updated_at++;
        return { result: structuredClone(draft) };
      }
      if (method === 'mail.drafts.delete') {
        state.deletes.push({ draft_id: args.draft_id!, expected_revision: args.expected_revision! });
        const draft = state.rows.find(item => item.draft_id === args.draft_id);
        if (!draft || draft.revision !== args.expected_revision) return { error: { code: 'mail_draft_stale', message: 'This draft changed.' } };
        const outcome = state.deleteOutcome; state.deleteOutcome = 'ok';
        if (outcome === 'refused') return { error: { code: 'fixture_delete_refused', message: 'The draft could not be deleted.' } };
        state.rows = state.rows.filter(item => item !== draft);
        if (outcome === 'lost') return { error: { code: 'fixture_delete_lost', message: 'Delete response was lost.' } };
        if (state.failListAfterDelete) { state.failLists++; state.failListAfterDelete = false; }
        return { result: { deleted: true } };
      }
      return undefined;
    };
  }, mailboxUnavailable);
  await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html#mail`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(drafts(page)).toHaveAttribute('aria-busy', 'false');
  await expect(drafts(page).locator('[data-mail-draft-id]')).toHaveCount(2);
};

const chooseDelete = async (page: Page, n: number): Promise<void> => {
  const control = row(page, n).getByRole('button', { name: 'Delete', exact: true });
  await control.focus(); await control.press('Enter');
  await expect(row(page, n).getByRole('group', { name: 'Delete saved draft' })).toBeVisible();
};
const confirmDelete = async (page: Page, n: number): Promise<void> => {
  const control = row(page, n).getByRole('button', { name: 'Delete draft', exact: true });
  await control.focus(); await control.press('Enter');
};

test('draft filters search beyond the first scan page and preview each recipient kind', async ({ page }) => {
  await openDrafts(page);
  await page.evaluate(() => {
    const state = window.__mailDraftsFixture;
    for (const n of [4, 5]) state.rows.push({ ...structuredClone(state.rows[0]!),
      draft_id: `mad_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      content: { ...state.rows[0]!.content, subject: 'Scope 100% <review>', sender_mail_instance: n === 4 ? 'work' : 'personal',
        to: ['primary@example.test'], ...(n === 4 ? { cc: ['hidden@example.test'] } : { bcc: ['hidden@example.test'] }) } });
  });
  const search = drafts(page).getByRole('searchbox', { name: 'Search saved drafts' });
  await search.fill('hidden@example.test');
  await expect(row(page, 4)).toBeVisible();
  await expect(row(page, 4)).toContainText('To: primary@example.test · Cc: hidden@example.test');
  await drafts(page).getByRole('button', { name: 'More drafts', exact: true }).click();
  await expect(row(page, 5)).toContainText('Bcc: hidden@example.test');
  await drafts(page).getByRole('combobox', { name: 'Sender mailbox' }).selectOption('personal');
  await expect(drafts(page).locator('[data-mail-draft-id]')).toHaveCount(1);
  await expect(row(page, 5)).toBeVisible();
  await search.fill('100%');
  await expect(row(page, 5).getByRole('button', { name: 'Scope 100% <review>', exact: true })).toBeVisible();
  await drafts(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(search).toHaveValue(''); await expect(search).toBeFocused();
  await expect(drafts(page).getByRole('combobox', { name: 'Sender mailbox' })).toHaveValue('');
  await expect(drafts(page).locator('[data-mail-draft-id]')).toHaveCount(2);
  expect(await page.evaluate(() => window.__mailDraftsFixture.lists.some(request => request.query === 'hidden@example.test' && request.cursor !== undefined))).toBe(true);
  expect(await page.evaluate(() => window.__mailDraftsFixture.gets)).toEqual([]);
});

test('a new draft query retires old scans and Retry keeps the current filters', async ({ page }) => {
  await openDrafts(page);
  await page.evaluate(() => { window.__mailDraftsFixture.holdListQuery = 'Meeting'; });
  const search = drafts(page).getByRole('searchbox', { name: 'Search saved drafts' });
  await search.fill('Meeting'); await page.waitForFunction(() => window.__mailDraftsFixture.listPending);
  await search.fill('Another');
  await expect(row(page, 3)).toBeVisible();
  await page.evaluate(() => window.__mailDraftsFixture.releaseList());
  await expect(drafts(page).locator('[data-mail-draft-id]')).toHaveCount(1);
  await expect(row(page, 3)).toBeVisible(); await expect(search).toBeFocused();
  await page.evaluate(() => { window.__mailDraftsFixture.failLists = 1; });
  await search.fill('sam@example.test');
  await expect(drafts(page).getByRole('alert')).toContainText('Draft list refresh unavailable');
  await expect(drafts(page)).not.toContainText('No saved drafts match');
  await drafts(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(row(page, 2)).toBeVisible(); await expect(search).toHaveValue('sam@example.test');
  await expect(drafts(page).getByRole('alert')).toHaveCount(0);
});

const searchDraftsEverywhere = async (page: Page, query: string) => {
  await page.evaluate(() => { location.hash = '#data/search'; });
  const search = page.locator('[data-recued-universal-search-input]');
  await expect(search).toBeVisible(); await search.fill(query);
  const group = page.getByRole('region', { name: 'Saved draft search results' });
  await expect(group).toBeVisible(); await expect(group).toHaveAttribute('aria-busy', 'false');
  return { search, group };
};
const globalDraft = (page: Page, n: number) => page.locator(`[data-search-draft-id="${id(n)}"]`);

test('changing result type retires a draft open without discarding the confirmed search results', async ({ page }) => {
  await openDrafts(page); await searchDraftsEverywhere(page, 'Meeting');
  const type = page.getByRole('combobox', { name: 'Result type', exact: true });
  await type.selectOption('draft'); await page.evaluate(() => { window.__mailDraftsFixture.holdGet = true; });
  await globalDraft(page, 1).click(); await page.waitForFunction(() => window.__mailDraftsFixture.getPending);
  await type.selectOption('mail'); await expect(globalDraft(page, 1)).toHaveCount(0);
  await type.selectOption('draft'); await expect(globalDraft(page, 2)).toBeVisible(); await globalDraft(page, 2).click();
  const editor = page.getByRole('dialog', { name: 'New mail', exact: true });
  await expect(editor.locator('[data-form-field="body"]')).toHaveValue('Saved message 2.');
  await page.evaluate(() => window.__mailDraftsFixture.releaseGet());
  await expect(editor.locator('[data-form-field="body"]')).toHaveValue('Saved message 2.');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(type).toHaveValue('draft'); await expect(globalDraft(page, 2)).toBeFocused();
});

test('universal search resumes the current saved draft, saves its revision and returns to the same result', async ({ page }) => {
  await openDrafts(page);
  const { search } = await searchDraftsEverywhere(page, 'Meeting');
  await expect(globalDraft(page, 1)).toContainText('To: alex@example.test');
  await page.evaluate(() => {
    const draft = window.__mailDraftsFixture.rows[0]!;
    draft.revision = 2; draft.content.subject = 'Meeting latest canonical'; draft.content.body = 'Latest server body.';
  });
  await globalDraft(page, 1).focus(); await globalDraft(page, 1).press('Enter');
  const editor = page.getByRole('dialog', { name: 'New mail', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.locator('[data-form-field="subject"]')).toHaveValue('Meeting latest canonical');
  const body = editor.locator('[data-form-field="body"]');
  await expect(body).toHaveValue('Latest server body.'); await body.fill('Continued from universal search.');
  // A second result cannot replace an email with unsaved edits, including a
  // synthetic activation from a background pane.
  await globalDraft(page, 2).evaluate(element => (element as HTMLElement).click());
  await expect(body).toHaveValue('Continued from universal search.');
  expect(await page.evaluate(() => window.__mailDraftsFixture.gets)).toEqual([id(1)]);
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(editor.locator('[data-mail-draft-status]')).toContainText('Draft saved.');
  expect(await page.evaluate(() => window.__mailDraftsFixture.rows[0]!.revision)).toBe(3);
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toHaveCount(0); await expect(search).toHaveValue('Meeting');
  await expect(globalDraft(page, 1)).toContainText('Meeting latest canonical');
  await expect(globalDraft(page, 1)).toBeFocused();
  await expect(page.getByRole('region', { name: 'Saved draft search results' }).getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => ({ create: window.__app.rpcCallCount('mail.drafts.create'), update: window.__app.rpcCallCount('mail.drafts.update'), execute: window.__app.rpcCallCount('execute') })))
    .toEqual({ create: 0, update: 1, execute: 0 });
});

test('changing universal search cancels a pending draft open and an unavailable result stays in search', async ({ page }) => {
  await openDrafts(page);
  const { search } = await searchDraftsEverywhere(page, 'Meeting');
  await page.evaluate(() => { window.__mailDraftsFixture.holdGet = true; });
  await globalDraft(page, 1).click(); await page.waitForFunction(() => window.__mailDraftsFixture.getPending);
  await search.fill('Another'); await expect(globalDraft(page, 3)).toBeVisible();
  await page.evaluate(() => window.__mailDraftsFixture.releaseGet());
  await expect(page.getByRole('dialog', { name: 'New mail', exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.__mailDraftsFixture.rows = window.__mailDraftsFixture.rows.filter(draft => !draft.content.subject.includes('Another')); });
  await globalDraft(page, 3).click();
  await expect(page.getByRole('region', { name: 'Saved draft search results' }).getByRole('alert')).toContainText('Draft missing');
  await expect(search).toHaveValue('Another');
  await expect(page.getByRole('dialog', { name: 'New mail', exact: true })).toHaveCount(0);
});

test('universal draft More retries its page and focuses the first new match', async ({ page }) => {
  await openDrafts(page);
  await page.evaluate(() => {
    const state = window.__mailDraftsFixture, template = state.rows[0]!;
    state.rows = Array.from({ length: 18 }, (_, index) => ({ ...structuredClone(template),
      draft_id: `mad_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      content: { ...template.content, subject: `Review ${index + 1}` } }));
  });
  const { group } = await searchDraftsEverywhere(page, 'Review');
  await expect(group.locator('[data-search-draft-id]')).toHaveCount(5);
  await page.evaluate(() => { window.__mailDraftsFixture.failLists = 1; });
  await group.getByRole('button', { name: 'More drafts', exact: true }).click();
  await expect(group.getByRole('alert')).toContainText('Draft list refresh unavailable');
  await expect(group.locator('[data-search-draft-id]')).toHaveCount(5);
  await group.getByRole('button', { name: 'Retry drafts', exact: true }).focus();
  await group.getByRole('button', { name: 'Retry drafts', exact: true }).press('Enter');
  await expect(group.locator('[data-search-draft-id]')).toHaveCount(15);
  await expect(globalDraft(page, 6)).toBeFocused();
  await expect(group.getByRole('alert')).toHaveCount(0);
});

test('a new query can resume a different draft while an abandoned get is pending', async ({ page }) => {
  await openDrafts(page);
  const { search } = await searchDraftsEverywhere(page, 'Meeting');
  await page.evaluate(() => { window.__mailDraftsFixture.holdGet = true; });
  await globalDraft(page, 1).click(); await page.waitForFunction(() => window.__mailDraftsFixture.getPending);
  await search.fill('Another'); await expect(globalDraft(page, 3)).toBeVisible();
  await globalDraft(page, 3).click();
  const editor = page.getByRole('dialog', { name: 'New mail', exact: true });
  await expect(editor.locator('[data-form-field="body"]')).toHaveValue('Saved message 3.');
  await page.evaluate(() => window.__mailDraftsFixture.releaseGet());
  await expect(editor.locator('[data-form-field="body"]')).toHaveValue('Saved message 3.');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(globalDraft(page, 3)).toBeFocused();
  expect(await page.evaluate(() => window.__mailDraftsFixture.gets)).toEqual([id(1), id(3)]);
});

test('similar drafts have useful context and inline cancellation never deletes', async ({ page }) => {
  await openDrafts(page);
  for (const n of [1, 2]) {
    const open = row(page, n).getByRole('button', { name: 'Meeting follow-up', exact: true });
    await expect(open).toHaveAccessibleDescription(/From owner@example.test · Edited/);
    await expect(row(page, n).getByRole('button', { name: 'Delete', exact: true })).toHaveAccessibleDescription(/Meeting follow-up.*From owner@example.test/);
    await expect(row(page, n).locator('time')).toHaveAttribute('datetime', `2026-10-${24 + n}T08:00:00.000Z`);
  }
  expect(await page.evaluate(() => window.__app.rpcCallCount('mail.drafts.get'))).toBe(0);
  for (const cancel of ['button', 'Escape']) {
    await chooseDelete(page, 1);
    await expect(row(page, 1).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    expect(await page.evaluate(() => window.__app.rpcCallCount('mail.drafts.delete'))).toBe(0);
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else await row(page, 1).getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
    await expect(row(page, 1).getByRole('group')).toHaveCount(0);
    await expect(row(page, 1).getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  }
  expect(await page.evaluate(() => window.__app.rpcCallCount('mail.drafts.delete'))).toBe(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a confirmed deletion stays removed when its follow-up refresh fails and Retry only reads', async ({ page }) => {
  await openDrafts(page);
  await page.evaluate(() => { window.__mailDraftsFixture.failListAfterDelete = true; });
  await chooseDelete(page, 1); await confirmDelete(page, 1);
  await expect(row(page, 1)).toHaveCount(0); await expect(row(page, 2)).toBeVisible();
  await expect(drafts(page).getByRole('alert')).toContainText('Draft list refresh unavailable.');
  await expect(drafts(page)).toContainText('Deleted “Meeting follow-up”.');
  await expect(row(page, 2).getByRole('button', { name: 'Meeting follow-up', exact: true })).toBeFocused();
  await drafts(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(drafts(page).getByRole('alert')).toHaveCount(0); await expect(row(page, 1)).toHaveCount(0);
  expect(await page.evaluate(() => window.__mailDraftsFixture.deletes)).toEqual([{ draft_id: id(1), expected_revision: 1 }]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('preapproval.prepare'))).toBe(0);
});

for (const outcome of ['refused', 'lost'] as const) {
  test(`a ${outcome} delete response requires a read before another deletion`, async ({ page }) => {
    await openDrafts(page);
    await page.evaluate(mode => { window.__mailDraftsFixture.deleteOutcome = mode; }, outcome);
    await chooseDelete(page, 1); await confirmDelete(page, 1);
    await expect(drafts(page).getByRole('alert')).toContainText('confirm deletion');
    const remove = row(page, 1).getByRole('button', { name: 'Delete', exact: true });
    await expect(remove).toBeDisabled(); await remove.dispatchEvent('click');
    expect(await page.evaluate(() => window.__mailDraftsFixture.deletes.length)).toBe(1);
    if (outcome === 'refused') await page.evaluate(() => { window.__mailDraftsFixture.failLists = 1; });
    await drafts(page).getByRole('button', { name: 'More drafts', exact: true }).click();
    if (outcome === 'refused') await expect(drafts(page).getByRole('alert').filter({ hasText: 'Draft list refresh unavailable.' })).toBeVisible();
    else await expect(row(page, 3)).toBeVisible();
    await expect(remove).toBeDisabled();
    await expect(drafts(page).getByRole('alert').filter({ hasText: 'confirm deletion' })).toBeVisible();
    await drafts(page).getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(drafts(page).getByRole('alert')).toHaveCount(0);
    await expect(row(page, 1)).toHaveCount(outcome === 'lost' ? 0 : 1);
    if (outcome === 'refused') await expect(remove).toBeEnabled();
    expect(await page.evaluate(() => window.__mailDraftsFixture.deletes.length)).toBe(1);
  });
}

test('a changed or recreated draft retires its old confirmation before a write', async ({ page }) => {
  await openDrafts(page); await chooseDelete(page, 1);
  await page.evaluate(() => { const draft = window.__mailDraftsFixture.rows[0]!; draft.revision++; draft.content.subject = 'Updated draft'; });
  await drafts(page).getByRole('button', { name: 'Refresh drafts', exact: true }).click();
  await expect(row(page, 1).getByRole('button', { name: 'Updated draft', exact: true })).toBeVisible();
  await expect(row(page, 1).getByRole('group')).toHaveCount(0);
  await chooseDelete(page, 1);
  await page.evaluate(() => { window.__mailDraftsFixture.rows[0]!.incarnation = 'restored-generation'; });
  await drafts(page).getByRole('button', { name: 'Refresh drafts', exact: true }).click();
  await expect(row(page, 1).getByRole('group')).toHaveCount(0);
  expect(await page.evaluate(() => window.__mailDraftsFixture.deletes.length)).toBe(0);
  await chooseDelete(page, 1); await confirmDelete(page, 1); await expect(row(page, 1)).toHaveCount(0);
  expect(await page.evaluate(() => window.__mailDraftsFixture.deletes)).toEqual([{ draft_id: id(1), expected_revision: 2 }]);
});

test('Retry continues a failed More drafts read without restarting the loaded list', async ({ page }) => {
  await openDrafts(page);
  await page.evaluate(() => { window.__mailDraftsFixture.failLists = 1; });
  await drafts(page).getByRole('button', { name: 'More drafts', exact: true }).click();
  await expect(drafts(page).getByRole('alert')).toContainText('Draft list refresh unavailable.');
  await drafts(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(drafts(page).getByRole('alert')).toHaveCount(0);
  await expect(row(page, 1)).toBeVisible(); await expect(row(page, 2)).toBeVisible(); await expect(row(page, 3)).toBeVisible();
  expect(await page.evaluate(() => window.__mailDraftsFixture.deletes.length)).toBe(0);
});

test('an older delete refresh cannot unlock a later pending deletion', async ({ page }) => {
  await openDrafts(page, true);
  await page.evaluate(() => window.__app.holdRpcResponses?.('mail.drafts.list'));
  await chooseDelete(page, 1); await confirmDelete(page, 1);
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('mail.drafts.list'))).toBe(2);
  await page.evaluate(() => { window.__mailDraftsFixture.failMailboxRead = false; });
  await page.locator('[data-recued-mail-retry]').click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('mail.drafts.list'))).toBe(3);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('mail.drafts.list', 1))).toBe(1);
  await expect(drafts(page)).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(() => window.__app.holdRpcResponses?.('mail.drafts.delete'));
  await chooseDelete(page, 2); await confirmDelete(page, 2);
  await expect.poll(() => page.evaluate(() => window.__mailDraftsFixture.deletes.length)).toBe(2);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('mail.drafts.list', 0))).toBe(1);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const pending = row(page, 2).locator('[data-mail-draft-action="confirm-delete"]');
  await expect(pending).toBeDisabled(); await pending.dispatchEvent('click'); await pending.press('Enter');
  expect(await page.evaluate(() => window.__mailDraftsFixture.deletes.length)).toBe(2);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('mail.drafts.delete'))).toBe(1);
  await expect(row(page, 2)).toHaveCount(0);
  // The final follow-up list also uses the held transport; leave it settled.
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('mail.drafts.list'))).toBe(4);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('mail.drafts.list'))).toBe(1);
  await expect(drafts(page)).toHaveAttribute('aria-busy', 'false');
});

test('a late delete response cannot repaint Mail or reclaim focus after navigation', async ({ page }) => {
  await openDrafts(page);
  await page.evaluate(() => window.__app.holdRpcResponses?.('mail.drafts.delete'));
  await chooseDelete(page, 1); await confirmDelete(page, 1);
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('mail.drafts.delete'))).toBe(1);
  await page.evaluate(() => window.__app.setHash('#chat'));
  const input = page.locator('[data-recued-chat-route-input]'); await input.fill('Keep this question');
  const before = await page.evaluate(() => window.__app.rpcCallCount('mail.drafts.list'));
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('mail.drafts.delete'))).toBe(1);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(input).toBeFocused(); await expect(input).toHaveValue('Keep this question');
  await expect(drafts(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('mail.drafts.list'))).toBe(before);
});

test('draft context and inline confirmation stay usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await openDrafts(page);
  await chooseDelete(page, 2);
  await expect(row(page, 2)).toContainText('owner@example.test');
  const cancel = row(page, 2).getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('mail-saved-drafts-phone.png'), fullPage: true });
  await cancel.press('Enter'); await expect(row(page, 2).getByRole('group')).toHaveCount(0);
});
