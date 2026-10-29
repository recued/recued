import { expect, test, type Page } from '@playwright/test';
import type { MailDraft, MailDraftDeleteRequest } from '@recued/contracts';
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
    };
    window.__connectionsFixture = async (method, raw) => {
      const state = window.__mailDraftsFixture;
      const args = (raw ?? {}) as { cursor?: string; draft_id?: string; expected_revision?: number };
      if (method === 'collection.mail.list' && state.failMailboxRead) return { error: { code: 'fixture_mailbox_unavailable', message: 'Mailbox status is unavailable.' } };
      if (method === 'collection.mail.list') return { result: { instances: [{ slug: 'work', adapter_type: 'imap',
        send_capable: true, draft_capable: true, account_email: 'owner@example.test' }] } };
      if (method === 'mail.drafts.list') {
        if (state.failLists > 0) { state.failLists--; return { error: { code: 'fixture_read_unavailable', message: 'Draft list refresh unavailable.' } }; }
        const found = state.rows.filter(draft => draft.draft_id > (args.cursor ?? '')).sort((a, b) => a.draft_id.localeCompare(b.draft_id));
        const page = found.slice(0, 2);
        return { result: { drafts: page.map(({ content, ...draft }) => ({ ...draft, subject: content.subject, sender_mail_instance: content.sender_mail_instance })),
          next_cursor: found.length > page.length ? page.at(-1)!.draft_id : null } };
      }
      if (method === 'mail.drafts.get') {
        const draft = state.rows.find(item => item.draft_id === args.draft_id);
        return draft ? { result: structuredClone(draft) } : { error: { code: 'mail_draft_not_found', message: 'Draft missing.' } };
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
