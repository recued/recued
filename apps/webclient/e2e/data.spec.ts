import Database from 'better-sqlite3';
import { createContactStore } from '../../../backend/server/src/storage/contact-store.js';
import { createProactiveHistoryStore } from '../../../backend/server/src/storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../../../backend/server/src/storage/proactive-proposal-store.js';
import { handleContactGet, handleContactList, handleContactSearchLocal } from '../../../backend/server/src/contact-handler.js';
import { applyContactFileImport, planContactFileImport } from '../../../backend/server/src/contact-import-file.js';
import type { ContactImportOccasionSelection, YoursCommand, YoursSnapshot } from '@recued/contracts';
import { installProjectOverviewFixture } from './helpers/project-overview-fixture.js';
import { installCommitmentWorkspaceFixture } from './helpers/commitment-workspace-fixture.js';
import { expect, test, type Page } from '@playwright/test';
import type { MailFactRow, MailFactRowsCursor, MailFactRowsQuery, MailFactSenderDismissal, MailFactSendersResult, ReminderView, WorkEntity } from '@recued/contracts';
import {
  DATA_DETAIL_HEADING, HARNESS_URL, SHARED_PROVENANCE, SHARED_PROVENANCE_DETAIL,
  SHARED_PROVENANCE_PRIMARY, SHARED_REFERENCE, SHARED_REFERENCE_ID, installFullAppHooks,
} from './helpers/full-app.js';

/**
 * Data browser journeys against the deterministic full-app harness.
 * Shares the app boot and uncaught-page-error gates with full-app.spec.ts.
 * Included in e2e:webclient:full and the standard webclient Playwright config.
 */
const DATA_TAB = 'data-recued-data-route-tab';
const DATA_CONTACT_ROW = 'data-recued-data-contact-row';
const DATA_CONTACT_DETAIL_HEADING = 'data-recued-data-contact-detail-heading';
const DATA_CONTACT_LOAD_MORE = 'data-recued-data-contact-load-more';
const DATA_CONTACT_DISCARD_GUARD = 'data-recued-data-contact-discard-guard';
const DATA_CONTACT_DISCARD_KEEP = 'data-recued-data-contact-discard-keep';
const DATA_CONTACT_DISCARD_COMMIT = 'data-recued-data-contact-discard-commit';
const DATA_CONTACT_IMPORT = 'data-recued-data-contact-import';
const DATA_CONTACT_IMPORT_RESULT =
  'data-recued-data-contact-import-result';
const DATA_CONTACT_SCAN = 'data-recued-data-contact-scan';
const DATA_SCAN_RESULT = 'data-recued-data-scan-result';
const DATA_MERGE_RESULT = 'data-recued-data-merge-result';
const DATA_WORK_ENTITY_LOAD_MORE = 'data-recued-data-work-entity-load-more';
const DATA_WORK_ENTITY_DISCARD_GUARD =
  'data-recued-data-work-entity-discard-guard';
const DATA_WORK_ENTITY_DISCARD_KEEP =
  'data-recued-data-work-entity-discard-keep';
const DATA_WORK_ENTITY_DISCARD_COMMIT =
  'data-recued-data-work-entity-discard-commit';
const DATA_FORM_RESPONSE_LOAD_MORE = 'data-recued-data-form-response-load-more';
const DATA_FORM_RESPONSE_DETAIL_HEADING =
  'data-recued-data-form-response-detail-heading';
const DATA_FORM_RESPONSE_VALUES = 'data-recued-data-form-response-values';
const DATA_FORM_RESPONSE_EMAIL = 'data-recued-data-form-response-email';
const DATA_FORM_RESPONSE_STATE = 'data-recued-data-form-response-state';
const DATA_FORM_RESPONSE_DISCARD_GUARD =
  'data-recued-data-form-response-discard-guard';
const DATA_FORM_RESPONSE_DISCARD_KEEP =
  'data-recued-data-form-response-discard-keep';
const DATA_FORM_RESPONSE_DISCARD_COMMIT =
  'data-recued-data-form-response-discard-commit';
const DATA_MEMORY_COMPOSE_DISCARD_GUARD =
  'data-recued-memory-compose-discard-guard';
const DATA_MEMORY_COMPOSE_DISCARD_KEEP =
  'data-recued-memory-compose-discard-keep';
const DATA_MEMORY_COMPOSE_DISCARD_COMMIT =
  'data-recued-memory-compose-discard-commit';
const DATA_MEMORY_IMPORT_DISCARD_GUARD =
  'data-recued-memory-import-discard-guard';
const DATA_MEMORY_IMPORT_DISCARD_KEEP =
  'data-recued-memory-import-discard-keep';
const DATA_MEMORY_IMPORT_DISCARD_COMMIT =
  'data-recued-memory-import-discard-commit';
const DATA_MEMORY_DETAIL_HEADING = 'data-recued-memory-detail-heading';
const DATA_FORM_RESPONSE_RUN = 'data-recued-data-form-response-run';
const DATA_FORM_RESPONSE_RUN_PICKER =
  'data-recued-data-form-response-run-picker';
const DATA_COLLECTION_SLUG = 'data-collection-slug';
const DATA_COLLECTION_RECORD = 'data-collection-record';
const DATA_DOWNLOAD_FILE = 'data-recued-data-download-file';

type ReminderWriteOutcome = 'success' | 'refused' | 'error';
type ReminderReadOutcome = 'current' | 'missing' | 'error';
declare global { interface Window {
  __reminderFocus: {
    reads: number;
    writes: { method: string; args: { reminder_id: string; at?: number } }[];
    waitingForRead: boolean;
    releaseWrite(outcome: ReminderWriteOutcome): void;
    releaseRead(outcome: ReminderReadOutcome): void;
  };
} }

/** Held replies exercise the real Data route's repaint and focus capture. */
const openReminderFocusFixture = async (page: Page, holdRead = false): Promise<void> => {
  await page.addInitScript(({ holdRead }) => {
    type Reply = { result?: unknown; error?: { code: string; message: string } };
    let reminder: ReminderView = {
      reminder_id: 'rem_1', text: 'Call the dentist', at: Date.UTC(2030, 9, 16, 19),
      when: 'Wednesday 16 October at 7:00 PM', state: 'pending', delivered_at: null, time_zone: 'UTC',
    };
    const neighbor: ReminderView = { ...reminder, reminder_id: 'rem_2', text: 'Read a book' };
    const history: ReminderView = { ...reminder, reminder_id: 'rem_0', text: 'Stretch', state: 'delivered', delivered_at: reminder.at };
    let write: { method: string; args: { reminder_id: string; at?: number }; resolve: (reply: Reply) => void } | null = null;
    let read: ((reply: Reply) => void) | null = null;
    const listed = (): Reply => ({ result: {
      reminders: [...(reminder.state === 'pending' ? [reminder] : []), neighbor],
      count: reminder.state === 'pending' ? 2 : 1,
      delivered: [history, ...(reminder.state !== 'pending' ? [reminder] : [])],
    } });
    const fixture: Window['__reminderFocus'] = {
      reads: 0, writes: [], waitingForRead: false,
      releaseWrite(outcome) {
        if (write === null) throw new Error('No reminder write is waiting.');
        const pending = write; write = null;
        if (outcome === 'error') {
          pending.resolve({ error: { code: 'unavailable', message: 'Fixture reminder request interrupted.' } });
        } else if (pending.method === 'reminder.update') {
          if (outcome === 'success') reminder = { ...reminder, at: pending.args.at!, when: 'Moved to the chosen time' };
          pending.resolve({ result: { updated: outcome === 'success', reminder: { ...reminder }, message: outcome === 'success' ? 'Reminder time changed.' : 'Reminder time could not be changed.' } });
        } else {
          if (outcome === 'success') reminder = { ...reminder, state: 'cancelled' };
          pending.resolve({ result: { cancelled: outcome === 'success', reminder: { ...reminder }, message: outcome === 'success' ? 'Reminder cancelled.' : 'Reminder could not be cancelled.' } });
        }
      },
      releaseRead(outcome) {
        if (read === null) throw new Error('No reminder read is waiting.');
        const resolve = read; read = null; fixture.waitingForRead = false;
        if (outcome === 'missing') reminder = { ...reminder, state: 'delivered', delivered_at: reminder.at };
        resolve(outcome === 'error'
          ? { error: { code: 'unavailable', message: 'Fixture reminder list interrupted.' } }
          : listed());
      },
    };
    window.__reminderFocus = fixture;
    Object.assign(window, { __connectionsFixture: async (method: string, args: { reminder_id: string; at?: number }) => {
      if (method === 'reminder.list') {
        fixture.reads += 1;
        if (holdRead && fixture.writes.length > 0) return new Promise<Reply>(resolve => { read = resolve; fixture.waitingForRead = true; });
        return listed();
      }
      if (method === 'reminder.update' || method === 'reminder.cancel') {
        fixture.writes.push({ method, args });
        return new Promise<Reply>(resolve => { write = { method, args, resolve }; });
      }
      return undefined;
    } });
  }, { holdRead });
  await page.goto(`${HARNESS_URL}?reminder_focus=1#data/reminder`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-recued-reminders]')).toContainText('Call the dentist');
};

const startReminderWrite = async (page: Page, action: 'save' | 'cancel', scripted = false): Promise<void> => {
  const row = page.locator('.reminders-row[data-reminder-id="rem_1"]');
  await row.getByRole('button', { name: action === 'save' ? 'Edit reminder' : 'Cancel', exact: true }).click();
  if (action === 'save') await row.locator('[data-recued-reminders-field="at"]').fill('2030-10-17T20:30');
  const button = row.getByRole('button', { name: action === 'save' ? 'Save' : 'Cancel it', exact: true });
  if (scripted) {
    await page.locator('[data-recued-account-menu-trigger]').focus();
    await button.evaluate(node => (node as HTMLButtonElement).click());
  } else {
    await button.focus();
    await page.keyboard.press('Enter');
  }
  await expect.poll(() => page.evaluate(() => window.__reminderFocus.writes.length)).toBe(1);
};

const expectReminderWrite = async (page: Page, action: 'save' | 'cancel'): Promise<void> => {
  expect(await page.evaluate(() => window.__reminderFocus.writes)).toEqual([{
    method: action === 'save' ? 'reminder.update' : 'reminder.cancel',
    args: { reminder_id: 'rem_1', ...(action === 'save' ? { at: Date.UTC(2030, 9, 17, 20, 30) } : {}) },
  }]);
};

type MailFactsPageReply = 'page' | 'empty' | 'missing-email' | 'duplicates' | 'error';
declare global { interface Window {
  __mailFactsPaging: {
    queries: MailFactRowsQuery[];
    pending: boolean;
    release(reply: MailFactsPageReply): void;
  };
} }

const openMailFactsPagingFixture = async (
  page: Page, failure: 'initial' | 'first-append' | 'third-page' = 'third-page',
): Promise<void> => {
  await page.addInitScript(({ failure }) => {
    type Reply = { result?: unknown; error?: { code: string; message: string } };
    const cursor = (id: string): MailFactRowsCursor => ({ email_at: id === 'a' ? 3000 : 2000, slug: 'work', record_id: `mail:${id}` });
    const row = (id: string): MailFactRow => ({
      fact: {
        fact_id: id, type: 'shipment', template_id: null, email: { slug: 'work', record_id: `mail:${id}` },
        email_at: id === 'a' ? 3000 : id === 'b' ? 2000 : 1000, position: 0, identity_keys: [], thing_id: null,
        variables: { carrier: 'UPS', tracking_number: `1Z-${id}`, state: 'in_transit' },
        passes: { carrier: 'standard', tracking_number: 'standard', state: 'standard' },
        data: { parcel: id }, missing: [], refused: [], complete: true, source_hash: `fixture-${id}`, revision: 1, created_at: 1,
      },
      email: { slug: 'work', record_id: `mail:${id}`, from: 'parcels@example.test', subject: `Parcel ${id}`, at: id === 'a' ? 3000 : id === 'b' ? 2000 : 1000 },
      thing: null, of_email: { index: 1, count: 1 }, runs: [],
    });
    let failed = false;
    let pending: { resolve: (reply: Reply) => void; query: MailFactRowsQuery } | null = null;
    const fixture: Window['__mailFactsPaging'] = {
      queries: [], pending: false,
      release(reply) {
        if (pending === null) throw new Error('No mail facts page is waiting.');
        const { resolve, query } = pending; pending = null; fixture.pending = false;
        if (reply === 'error') resolve({ error: { code: 'unavailable', message: 'Fixture page interrupted.' } });
        else if (reply === 'empty') resolve({ result: { rows: [] } });
        else if (reply === 'missing-email') resolve({ result: { rows: [{ ...row('c'), email: null }] } });
        else if (reply === 'duplicates') resolve({ result: { rows: [row('a'), row('b')] } });
        else resolve({ result: query.before === undefined ? { rows: [row('a')], next_cursor: cursor('a') }
          : { rows: [row('b'), row('c')] } });
      },
    };
    window.__mailFactsPaging = fixture;
    Object.assign(window, { __connectionsFixture: async (method: string, query: MailFactRowsQuery) => {
      if (method === 'mail_fact.template.list') return { result: { templates: [] } };
      if (method === 'mail_fact.type.list') return { result: { types: [] } };
      if (method !== 'mail_fact.facts.list') return undefined;
      fixture.queries.push(structuredClone(query));
      if (query.type === 'bill') return { result: { rows: [row('filtered')] } };
      const shouldFail = failure === 'initial' ? query.before === undefined
        : query.before?.record_id === (failure === 'first-append' ? 'mail:a' : 'mail:b');
      if (shouldFail) {
        if (!failed) { failed = true; return { error: { code: 'unavailable', message: 'Fixture page interrupted.' } }; }
        return new Promise<Reply>(resolve => { pending = { resolve, query }; fixture.pending = true; });
      }
      return { result: query.before === undefined ? { rows: [row('a')], next_cursor: cursor('a') }
        : { rows: [row('b')], next_cursor: cursor('b') } };
    } });
  }, { failure });
  await page.goto(`${HARNESS_URL}?mail_facts_paging=1#data/mail_fact`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const host = page.locator('[data-recued-mail-facts]');
  if (failure !== 'initial') {
    await expect(host.locator('[data-recued-mail-fact-row]')).toHaveCount(1);
    if (failure === 'third-page') {
      await host.getByRole('button', { name: 'Load more', exact: true }).click();
      await expect(host.locator('[data-recued-mail-fact-row]')).toHaveCount(2);
    }
    await host.getByRole('button', { name: 'Load more', exact: true }).click();
  }
  await expect(host.getByRole('alert')).toContainText('Fixture page interrupted.');
};

const retryMailFactsPage = async (page: Page): Promise<void> => {
  const before = await page.evaluate(() => window.__mailFactsPaging.queries.length);
  const retry = page.locator('[data-recued-mail-facts-focus="retry"]');
  await retry.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__mailFactsPaging.pending)).toBe(true);
  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
  await expect.poll(() => page.evaluate(() => window.__mailFactsPaging.queries.length)).toBe(before + 1);
};

type MailSendersReply = 'populated' | 'empty' | 'dismissed' | 'error';
declare global { interface Window {
  __mailSendersRecovery: {
    reads: number;
    writes: MailFactSenderDismissal[];
    pending: number;
    release(reply: MailSendersReply): void;
  };
} }

const openMailSendersRecoveryFixture = async (page: Page, ready = false): Promise<void> => {
  await page.addInitScript(({ ready }) => {
    type Reply = { result?: unknown; error?: { code: string; message: string } };
    let pending: ((reply: Reply) => void) | null = null;
    let dismissed = false;
    const listed = (reply: Exclude<MailSendersReply, 'error'>): MailFactSendersResult => ({
      senders: reply === 'populated' && !dismissed ? [{
        address: 'news@club.example.test', count: 3, subjects: [{ subject: 'Club news', count: 3 }],
        newest: { slug: 'work', record_id: 'mail:9', from: 'news@club.example.test', subject: 'Club news', at: 1 },
      }] : [],
      dismissed: dismissed ? ['news@club.example.test'] : reply === 'dismissed' ? ['old@club.example.test'] : [],
      days: 30, scanned: 40,
    });
    const interrupted: Reply = { error: { code: 'unavailable', message: 'Fixture sender count interrupted.' } };
    const fixture: Window['__mailSendersRecovery'] = {
      reads: 0, writes: [], pending: 0,
      release(reply) {
        if (pending === null) throw new Error('No sender read is waiting.');
        const resolve = pending; pending = null; fixture.pending = 0;
        resolve(reply === 'error' ? interrupted : { result: listed(reply) });
      },
    };
    window.__mailSendersRecovery = fixture;
    Object.assign(window, { __connectionsFixture: async (method: string, args: MailFactSenderDismissal) => {
      if (method === 'mail_fact.facts.list') return { result: { rows: [] } };
      if (method === 'mail_fact.template.list') return { result: { templates: [] } };
      if (method === 'mail_fact.type.list') return { result: { types: [] } };
      if (method === 'mail_fact.senders.list') {
        fixture.reads += 1;
        if (fixture.reads === 1) return ready ? { result: listed('populated') } : interrupted;
        if (ready && fixture.reads === 2 && fixture.writes.length > 0) return interrupted;
        return new Promise<Reply>(resolve => { pending = resolve; fixture.pending = 1; });
      }
      if (method === 'mail_fact.senders.dismiss') {
        fixture.writes.push(structuredClone(args)); dismissed = args.dismissed;
        return { result: args };
      }
      return undefined;
    } });
  }, { ready });
  await page.goto(`${HARNESS_URL}?mail_senders_recovery=1#data/mail_fact/senders`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const host = page.locator('[data-recued-mail-facts="senders"]');
  if (ready) await expect(host.locator('[data-recued-mail-fact-sender]')).toHaveCount(1);
  else {
    await expect(host.getByRole('alert')).toContainText('Fixture sender count interrupted.');
    await expect(host.getByText('Loading…', { exact: true })).toHaveCount(0);
    await expect(host.getByText('Counting your mail…', { exact: true })).toHaveCount(0);
  }
};

const retryMailSendersRead = async (page: Page): Promise<void> => {
  const before = await page.evaluate(() => window.__mailSendersRecovery.reads);
  const retry = page.locator('[data-recued-mail-facts-focus="snd:retry"]');
  await retry.focus(); await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
  await expect.poll(() => page.evaluate(() => window.__mailSendersRecovery.pending)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__mailSendersRecovery.reads)).toBe(before + 1);
};

installFullAppHooks();

test.describe('Standalone Notes reader', () => {
  test.use({ locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  type ClipboardWindow = Window & { __noteCopies: string[]; __holdNoteCopy: boolean; __releaseNoteCopy?: () => void };
  const note = (id: string, title: string, body: string, source_id = 'recued.note'): Extract<WorkEntity, { _kind: 'note' }> => ({
    _kind: 'note', id, title, body, source_id, sync_state: 'live', conflict_policy: 'recued_wins',
    created_at: Date.parse('2026-09-08T19:00:00Z'), updated_at: Date.parse('2026-09-08T19:00:00Z'),
    last_seen_at: Date.parse('2026-09-08T19:00:00Z'), last_user_action_at: Date.parse('2026-09-08T19:00:00Z'),
    related_contact_ids: [], related_calendar_event_ids: [], related_mail_thread_ids: [], related_project_ids: [],
  });
  const boot = async (page: Page, notes: Extract<WorkEntity, { _kind: 'note' }>[]) => {
    await page.clock.install({ time: new Date('2026-09-08T12:00:00-07:00') });
    await page.addInitScript(rows => {
      sessionStorage.setItem('recued-test-today-entities', JSON.stringify(rows));
      const state = window as unknown as ClipboardWindow;
      state.__noteCopies = []; state.__holdNoteCopy = false;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
        state.__noteCopies.push(text);
        if (state.__holdNoteCopy) { state.__holdNoteCopy = false; await new Promise<void>(resolve => { state.__releaseNoteCopy = resolve; }); }
      } } });
    }, notes);
    await page.goto(`${HARNESS_URL}?data=today#data/note`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
  };
  const open = (page: Page, id: string) => page.locator(`[data-action="open-edit-work-entity"][data-entity-id="${id}"]`).click();
  const reader = (page: Page) => page.locator('.work-entity-note-reader');
  const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit Note', exact: true });
  const writes = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-today-mutations') ?? '[]') as { args: Record<string, unknown> }[]);

  test('reads and copies a standalone imported note, preserves the list, and ignores late copy feedback', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const body = `  needle — café 🧾\r\n<img src=x onerror="throw new Error('unsafe')">\r\n${'A complete line of saved note text.\r\n'.repeat(120)}  `;
    await boot(page, [note('imported-note', 'Imported note', body, 'imported.note'), note('other-note', 'Other note', 'Another independent note.')]);
    const source = page.locator('.work-entity-source-dropdown-select');
    const search = page.locator('[data-action="search-work-entities"][data-kind="note"]');
    await source.selectOption('imported.note'); await search.fill('needle'); await open(page, 'imported-note');
    const view = reader(page);
    await expect(view.getByRole('heading', { name: 'Imported note', exact: true })).toBeVisible();
    expect(await view.locator('[data-note-body]').textContent()).toBe(body.replace(/\r\n/g, '\n'));
    await expect(view.locator('[data-note-body] img, [data-note-body] script')).toHaveCount(0);
    await expect(view.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(view.getByText('Related records', { exact: true })).toHaveCount(0);
    await expect(view.getByText('Activity timeline', { exact: true })).toHaveCount(0);
    const content = view.locator('.work-entity-note-content'); await content.evaluate(element => { element.scrollTop = 350; });
    const position = await content.evaluate(element => element.scrollTop); expect(position).toBeGreaterThan(0);
    await view.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(view.locator('[data-note-notice]')).toHaveText('Note text copied.');
    expect(await page.evaluate(() => (window as unknown as ClipboardWindow).__noteCopies)).toEqual([body]);
    expect(await content.evaluate(element => element.scrollTop)).toBe(position);
    await page.evaluate(() => { (window as unknown as ClipboardWindow).__holdNoteCopy = true; });
    await view.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(view.getByRole('button', { name: 'Copying…', exact: true })).toBeVisible();
    await view.getByRole('button', { name: 'Back to notes', exact: true }).click();
    await expect(view).toHaveCount(0); await expect(source).toHaveValue('imported.note'); await expect(search).toHaveValue('needle');
    await source.selectOption({ label: 'All Sources' }); await search.fill(''); await open(page, 'other-note');
    await expect(reader(page).getByRole('heading', { name: 'Other note', exact: true })).toBeVisible();
    await page.evaluate(async () => {
      (window as unknown as ClipboardWindow).__releaseNoteCopy?.();
      for (let index = 0; index < 8; index++) await Promise.resolve();
    });
    await expect(reader(page).locator('[data-note-notice]')).toHaveCount(0);
    expect(await writes(page)).toEqual([]);
  });

  test('edits title and exact text, keeps optional links, and cancels a draft back to the saved reader', async ({ page }) => {
    const body = '\n  Original text\r\nSecond line with spaces  \r\n';
    await boot(page, [{ ...note('editable-note', 'Original\r\n title', body), related_project_ids: ['project-one'] }]);
    await open(page, 'editable-note');
    const related = reader(page).locator('details').filter({ has: page.getByText('Related records', { exact: true }) });
    await related.locator('summary').click();
    await expect(related.getByRole('button', { name: 'Manage related records', exact: true })).toBeVisible();
    await reader(page).getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(reader(page).locator('[data-note-notice]')).toHaveText('Note text copied.');
    await expect(related.getByRole('button', { name: 'Manage related records', exact: true })).toBeVisible();
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(page).getByLabel('Note text')).toHaveValue(body.replace(/\r\n/g, '\n'));
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page).locator('[data-note-notice]')).toHaveText('No changes to save.');
    expect(await writes(page)).toEqual([]);
    const changed = '\n  revised 🧾\nA line with trailing spaces  \n';
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByLabel('Title', { exact: true }).fill('');
    await editor(page).getByLabel('Note text').fill(changed);
    await editor(page).getByRole('button', { name: 'More details', exact: true }).click();
    await expect(editor(page).getByRole('textbox', { name: 'Related project 1', exact: true })).toHaveValue('project-one');
    await editor(page).getByRole('button', { name: 'Fewer details', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page).getByRole('heading', { name: 'Note', exact: true })).toBeVisible();
    await expect(reader(page).locator('[data-note-notice]')).toHaveText('Note saved.');
    expect(await reader(page).locator('[data-note-body]').textContent()).toBe(changed);
    expect((await writes(page))[0]?.args).toEqual({ kind: 'note', id: 'editable-note', title: '', body: changed });
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-today-entities')!)[0].related_project_ids)).toEqual(['project-one']);
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByLabel('Title', { exact: true }).fill('Unsaved title'); await page.keyboard.press('Escape');
    const discard = page.getByRole('alertdialog'); await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(editor(page).getByLabel('Title', { exact: true })).toHaveValue('Unsaved title');
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await discard.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(reader(page).getByRole('heading', { name: 'Note', exact: true })).toBeVisible();
    expect(await reader(page).locator('[data-note-body]').textContent()).toBe(changed); expect(await writes(page)).toHaveLength(1);
    await reader(page).getByRole('button', { name: 'Back to notes', exact: true }).click();
    await expect(page.locator('[data-entity-id="editable-note"] .work-entity-list-row-primary')).toContainText('revised');
  });

  test('creates a note with optional details and preserves collapsed fields on save', async ({ page }) => {
    await boot(page, []);
    await page.getByRole('button', { name: '+ New Note', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New Note', exact: true });
    const body = '\n  New note text 🧾\nKeep these spaces.  \n';
    await dialog.getByLabel('Title', { exact: true }).fill('New note');
    await dialog.getByLabel('Note text').fill(body);
    await dialog.getByRole('button', { name: 'More details', exact: true }).click();
    const addProject = dialog.locator('[data-form-array-add="related_project"]');
    await expect(addProject).toBeVisible(); await addProject.click();
    await dialog.getByRole('textbox', { name: 'Related project 1', exact: true }).fill('project-one');
    await dialog.getByRole('button', { name: 'Fewer details', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await writes(page)).toEqual([{ args: expect.objectContaining({
      kind: 'note', source_id: 'recued.note', title: 'New note', body, related_project_ids: ['project-one'],
    }), method: 'work_entity.upsert' }]);
    await open(page, 'note-created');
    await expect(reader(page).getByRole('heading', { name: 'New note', exact: true })).toBeVisible();
    expect(await reader(page).locator('[data-note-body]').textContent()).toBe(body);
    await reader(page).getByText('Related records', { exact: true }).click();
    await expect(reader(page).getByText('1 project', { exact: true })).toBeVisible();
  });

  test('rechecks edit permission and retains a rejected or unconfirmed draft without repeating the write', async ({ page }) => {
    await boot(page, [note('confirmed-note', 'Confirmed note', 'Original source text')]); await open(page, 'confirmed-note');
    await page.evaluate(() => { document.documentElement.dataset.notesReadonly = '1'; });
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(reader(page).getByRole('alert')).toContainText('cannot be edited now'); await expect(editor(page)).toHaveCount(0);
    expect(await writes(page)).toEqual([]);
    await reader(page).getByRole('button', { name: 'Back to notes', exact: true }).click();
    await page.evaluate(() => { delete document.documentElement.dataset.notesReadonly; }); await open(page, 'confirmed-note');
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByLabel('Note text').fill('Keep this draft');
    await page.evaluate(() => {
      const rows = JSON.parse(sessionStorage.getItem('recued-test-today-entities')!); rows[0].title = 'Changed at source';
      sessionStorage.setItem('recued-test-today-entities', JSON.stringify(rows)); document.documentElement.dataset.todayVendorWon = '1';
    });
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText('did not confirm your edits');
    await expect(editor(page).getByLabel('Note text')).toHaveValue('Keep this draft');
    expect((await writes(page))[0]?.args).toEqual({ kind: 'note', id: 'confirmed-note', body: 'Keep this draft' });
    await page.evaluate(() => { delete document.documentElement.dataset.todayVendorWon; document.documentElement.dataset.todayAwaitingVerify = '1'; });
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText('source has not confirmed');
    await expect(editor(page).getByRole('alert')).toBeFocused();
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText('waiting for its source'); expect(await writes(page)).toHaveLength(2);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-today-entities')!)[0].title)).toBe('Changed at source');
  });
});

test.describe('Task editing and due-date shortcuts', () => {
  test.use({ locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  const log = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-today-mutations') ?? '[]') as { method: string; args: Record<string, unknown> }[]);
  const boot = async (page: Page) => {
    await page.clock.install({ time: new Date('2026-09-08T12:00:00-07:00') });
    await page.goto(`${HARNESS_URL}?data=today#today`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(page.locator('[data-today-view]')).toHaveAttribute('aria-busy', 'false');
  };

  test('Today moves a timed due and requires source confirmation before clearing it', async ({ page }) => {
    await boot(page);
    const row = page.locator('[data-today-item="task:task-today"]');
    await row.getByRole('button', { name: 'Due tomorrow: Review the brief', exact: true }).click();
    await expect(page.locator('[data-today-task-notice]')).toContainText('Rescheduled');
    expect((await log(page))[0]).toEqual({ method: 'work_entity.upsert', args: {
      kind: 'task', id: 'task-today', due_at: Date.parse('2026-09-09T13:00:00-07:00'),
    } });

    await page.evaluate(() => { document.documentElement.dataset.todayAwaitingVerify = '1'; });
    await row.getByRole('button', { name: 'Clear due date: Review the brief', exact: true }).click();
    await expect(row.locator('[data-today-task-error]')).toContainText('source has not confirmed');
    await expect(page.locator('[data-today-task-notice]')).toHaveCount(0);
    await expect(row).toContainText('Review the brief');
    expect((await log(page))[1]?.args).toEqual({ kind: 'task', id: 'task-today', clear_due_at: true });
    await row.locator('[data-today-task-editor]').getByRole('button', { name: 'Clear date', exact: true }).click();
    await expect(row.locator('[data-today-task-error]')).toContainText('waiting for its source');
    expect(await log(page)).toHaveLength(2);
  });

  test('Today opens the task editor, preserves collapsed relationships, and saves cleared notes and dates', async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem('recued-test-today-entities', JSON.stringify([{
      _kind: 'task', id: 'task-edit', title: 'File the return', body: 'Check the receipt', priority: 'low',
      due_at: Date.parse('2026-09-08T00:00:00Z'), done: false, blocks_task_ids: ['follow-up'],
      source_id: 'recued.task', sync_state: 'live', conflict_policy: 'recued_wins',
      last_seen_at: 1, created_at: 1, updated_at: 1,
    }])));
    await boot(page);
    await page.getByRole('link', { name: 'Edit details: File the return', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit Task', exact: true });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/#data\/task\/task-edit$/);
    await dialog.getByLabel('Title').fill('File the final return');
    await dialog.getByLabel('Notes', { exact: true }).fill('');
    await dialog.getByLabel('Priority', { exact: true }).selectOption('high');
    await dialog.getByRole('button', { name: 'Due tomorrow', exact: true }).click();
    await dialog.getByRole('button', { name: 'More details', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Blocks task 1', exact: true })).toHaveValue('follow-up');
    await dialog.getByRole('button', { name: 'Fewer details', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await log(page))[0]?.args;
    expect(saved).toMatchObject({ kind: 'task', id: 'task-edit', title: 'File the final return',
      body: '', priority: 'high', due_at: Date.parse('2026-09-09T00:00:00Z') });
    expect(saved).not.toHaveProperty('blocks_task_ids');

    await page.locator('[data-action="open-edit-work-entity"][data-entity-id="task-edit"]').click();
    await expect(dialog.getByLabel('Notes', { exact: true })).toHaveValue('');
    await dialog.getByRole('button', { name: 'More details', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Blocks task 1', exact: true })).toHaveValue('follow-up');
    await dialog.getByLabel('Priority', { exact: true }).selectOption('');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('already has a priority');
    expect(await log(page)).toHaveLength(1);
    await dialog.getByLabel('Priority', { exact: true }).selectOption('high');
    await dialog.getByRole('button', { name: 'Clear due date', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await log(page))[1]?.args).toMatchObject({ kind: 'task', id: 'task-edit', clear_due_at: true });
    expect((await log(page))[1]?.args).not.toHaveProperty('due_at');
    await page.locator('[data-action="open-edit-work-entity"][data-entity-id="task-edit"]').click();
    await dialog.getByRole('button', { name: 'More details', exact: true }).click();
    await dialog.getByRole('button', { name: 'Fewer details', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('task edits retain the draft on mismatched or pending confirmation without replaying untouched fields', async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem('recued-test-today-entities', JSON.stringify([{
      _kind: 'task', id: 'task-today', title: 'Review the brief', done: false, blocks_task_ids: [],
      source_id: 'recued.task', sync_state: 'live', conflict_policy: 'source_wins',
      due_at: Date.parse('2026-09-09T00:00:00.001Z'),
      created_at: Date.parse('2026-09-08T12:00:00-07:00'), updated_at: Date.now(), last_seen_at: Date.now(),
    }])));
    await boot(page);
    await page.getByRole('link', { name: 'Edit details: Review the brief', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit Task', exact: true });
    await dialog.getByLabel('Notes', { exact: true }).fill('Keep this draft');
    await page.evaluate(() => {
      // A concurrent source update must survive saving only the notes.
      sessionStorage.setItem('recued-test-today-entities', JSON.stringify([{
        _kind: 'task', id: 'task-today', title: 'Updated at source', done: false, blocks_task_ids: [],
        source_id: 'recued.task', sync_state: 'live', conflict_policy: 'source_wins',
        due_at: Date.parse('2026-09-08T13:00:00-07:00'),
        created_at: Date.parse('2026-09-08T12:00:00-07:00'), updated_at: Date.now(), last_seen_at: Date.now(),
      }]));
      document.documentElement.dataset.todayVendorWon = '1';
    });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('did not confirm your edits');
    await expect(dialog.getByLabel('Notes', { exact: true })).toHaveValue('Keep this draft');
    await expect(dialog.getByLabel('Due date', { exact: true })).toHaveValue('2026-09-08T17:00');
    expect((await log(page))[0]?.args).toEqual({ kind: 'task', id: 'task-today', body: 'Keep this draft' });
    await page.evaluate(() => {
      delete document.documentElement.dataset.todayVendorWon;
      document.documentElement.dataset.todayAwaitingVerify = '1';
    });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('source has not confirmed');
    await expect(dialog.getByRole('alert')).toBeFocused();
    await expect(dialog.getByLabel('Notes', { exact: true })).toHaveValue('Keep this draft');
    expect((await log(page))[1]?.args).toEqual({ kind: 'task', id: 'task-today', body: 'Keep this draft' });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('waiting for its source');
    expect(await log(page)).toHaveLength(2);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-today-entities')!)[0].title)).toBe('Updated at source');
  });
});

test('Data keeps keyboard focus on a collection tab through its repaint', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.__app.setHash('#data'));

  const tasks = page.locator(`[${DATA_TAB}="task"]`);
  await expect(tasks).toBeVisible();
  await tasks.focus();
  await expect(tasks).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/#data\/task$/);
  await expect(tasks).toHaveAttribute('data-active', 'true');
  await expect(tasks).toBeFocused();
});

test('Data collection tabs form one arrow-key keyboard stop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.__app.setHash('#data'));

  const tablist = page.getByRole('tablist', { name: 'Data collections' });
  const tabs = tablist.getByRole('tab');
  const contacts = page.locator(`[${DATA_TAB}="contact"]`);
  const tasks = page.locator(`[${DATA_TAB}="task"]`);
  const records = page.locator(`[${DATA_TAB}="records"]`);
  const search = page.locator(`[${DATA_TAB}="search"]`);
  await expect(tablist).toBeVisible();
  // D-290 — Today left this tablist for its own `#today` route (18 → 17),
  // D-315 put Mail facts under Received (17 → 18), and the Webhooks collection
  // was deleted (`3452f3017`, 18 → 17), and D-324 put Reminders last under
  // Owned (17 → 18).
  await expect(tabs).toHaveCount(18);
  await expect(tablist.locator('[tabindex="0"]')).toHaveCount(1);
  // ⚠ D-290 — a tabless `#data` lands on Contacts again (D-267 had made it
  // Today, which is no longer a tab here). This test is about the ARROW-KEY
  // STOP; the landing is asserted because it decides which tab holds that stop.
  await expect(contacts).toHaveAttribute('aria-selected', 'true');
  await expect(contacts).toHaveAccessibleDescription('Owned');
  await expect(records).toHaveAccessibleDescription('Records');
  await expect(page.getByRole('tabpanel', { name: 'Contacts' })).toBeVisible();

  await contacts.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#data\/task$/);
  await expect(tasks).toHaveAttribute('aria-selected', 'true');
  await expect(tasks).toBeFocused();
  await expect(tablist.locator('[tabindex="0"]')).toHaveCount(1);

  await page.keyboard.press('End');
  await expect(page).toHaveURL(/#data\/search$/);
  await expect(search).toHaveAttribute('aria-selected', 'true');
  await expect(search).toBeFocused();

  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(/#data\/records$/);
  await expect(records).toHaveAttribute('aria-selected', 'true');
  await expect(records).toBeFocused();

  await page.keyboard.press('Home');
  await expect(page).toHaveURL(/#data\/contact$/);
  await expect(contacts).toHaveAttribute('aria-selected', 'true');
  await expect(contacts).toBeFocused();
  await expect(tablist.locator('[tabindex="0"]')).toHaveCount(1);
});

test('Data exposes full mobile targets for its persistent navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#data'));

  const switcher = page.getByRole('group', { name: 'Data or Memory' });
  const lenses = switcher.getByRole('button');
  await expect(lenses).toHaveCount(2);
  const heights = await lenses.evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().height)
  );
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(36);

  const collections = page.getByRole('combobox', { name: 'Collection', exact: true });
  // One option per Data tab: 18 since D-324 added Reminders.
  await expect(collections.locator('option')).toHaveCount(18);
  await expect(collections).toBeVisible();
  expect((await collections.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole('tablist', { name: 'Data collections' })).toBeHidden();

  const memory = switcher.getByRole('button', { name: 'Memory' });
  await memory.focus();
  await expect(memory).toBeFocused();
});

for (const { query, collection, label } of [
  { query: 'calendar', collection: 'calendar', label: 'Calendar' },
  { query: 'pack', collection: 'records', label: 'Pack records' },
]) {
  test(`Data preserves native Collection picker typeahead for ${query}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${HARNESS_URL}?data=contacts&settle_reads=1#data/contact`);
    await page.waitForFunction(() => window.__app?.ready === true);

    const collections = page.getByRole('combobox', { name: 'Collection', exact: true });
    await expect(collections).toHaveValue('contact');
    await collections.focus();
    await page.keyboard.type(query, { delay: 80 });

    await expect(collections).toHaveValue(collection);
    await expect(collections).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`#data/${collection}(?:/|$)`));
    await expect(page.getByRole('tabpanel', { name: label, exact: true })).toBeVisible();
  });
}

test('Data hands collection focus between tabs and picker at the breakpoint', async ({ page }) => {
  await page.setViewportSize({ width: 641, height: 900 });
  await page.goto(`${HARNESS_URL}?data=contacts&settle_reads=1#data/contact`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const contacts = page.locator(`[${DATA_TAB}="contact"]`);
  const tasks = page.locator(`[${DATA_TAB}="task"]`);
  const notes = page.locator(`[${DATA_TAB}="note"]`);
  const commitments = page.locator(`[${DATA_TAB}="commitment"]`);
  const collections = page.getByRole('combobox', { name: 'Collection', exact: true });
  await contacts.focus();
  await page.keyboard.press('ArrowRight');
  await expect(tasks).toBeFocused();

  await page.setViewportSize({ width: 640, height: 900 });
  await expect(collections).toHaveValue('task');
  await expect(collections).toBeFocused();
  await page.keyboard.press('n');
  await expect(collections).toHaveValue('note');

  await page.setViewportSize({ width: 641, height: 900 });
  await expect(notes).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(commitments).toBeFocused();
  await expect(page).toHaveURL(/#data\/commitment$/);

  await page.keyboard.press('Home');
  await expect(contacts).toBeFocused();
  const search = page.getByRole('searchbox', { name: 'Search contacts' });
  await search.focus();
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(search).toBeFocused();
  await page.setViewportSize({ width: 641, height: 900 });
  await expect(search).toBeFocused();
});

test('Data keeps a contact file apply visible, owned, and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=contact-import&contact_import_apply_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact/import'));

  const importView = page.locator(`[${DATA_CONTACT_IMPORT}]`);
  const picker = page.getByLabel('Choose a vCard or CSV file');
  await expect(importView).toBeVisible();
  await picker.setInputFiles({
    name: 'contacts.vcf',
    mimeType: 'text/vcard',
    buffer: Buffer.from('BEGIN:VCARD\nFN:Bob Smith\nEND:VCARD'),
  });

  const changes = page.getByRole('checkbox', {
    name: 'Also change 1 contact you already have',
  });
  await expect(changes).toBeVisible();
  await changes.check();
  const apply = importView.locator(
    '[data-recued-data-action="contact-import-file-apply"]',
  );
  await expect(apply).toHaveText('Import 2 new and 1 change');
  await apply.focus();
  await page.keyboard.press('Enter');

  await expect(apply).toHaveText('Importing…');
  await expect(apply).toBeFocused();
  await expect(apply).not.toHaveAttribute('disabled');
  await expect(apply).toHaveAttribute('aria-disabled', 'true');
  await expect(apply).toHaveAttribute('aria-busy', 'true');
  await expect(picker).toBeDisabled();
  await expect(changes).toBeDisabled();
  const cancel = importView.getByRole('button', { name: 'Cancel', exact: true });
  const back = importView.getByRole('button', { name: 'Back to contacts' });
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await expect(back).toHaveAttribute('aria-disabled', 'true');

  // Synthetic dispatch bypasses browser affordances, so these assertions also
  // prove the imperative guards retain the exact visible owner.
  await cancel.dispatchEvent('click');
  await back.dispatchEvent('click');
  await apply.dispatchEvent('click');
  await apply.dispatchEvent('click');
  await expect(importView).toBeVisible();
  await expect(apply).toBeFocused();
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('contact.import.file_apply'),
  )).toBe(1);

  const receipt = page.locator(`[${DATA_CONTACT_IMPORT_RESULT}]`);
  await expect(receipt).toHaveText('2 added · 1 changed');
  await expect(receipt).toHaveAttribute('role', 'status');
  await expect(receipt).toHaveAttribute('tabindex', '-1');
  await expect(receipt).toBeFocused();
});

test('Data keeps CRM contact promotion attached to its reviewed selection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=contact-promote&contact_import_promote_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact/import'));

  const importView = page.locator(`[${DATA_CONTACT_IMPORT}]`);
  await importView.getByRole('button', { name: 'Browse & add' }).click();
  const carol = importView.getByRole('checkbox', { name: /Carol Jones/ });
  const dave = importView.getByRole('checkbox', { name: /Dave Lee/ });
  await expect(carol).toBeVisible();
  await carol.check();

  const promote = importView.locator(
    '[data-recued-data-action="contact-import-promote"]',
  );
  await expect(promote).toHaveText('Add 1 to my contacts');
  await promote.focus();
  await page.keyboard.press('Enter');

  await expect(promote).toHaveText('Adding…');
  await expect(promote).toBeFocused();
  await expect(promote).not.toHaveAttribute('disabled');
  await expect(promote).toHaveAttribute('aria-disabled', 'true');
  await expect(promote).toHaveAttribute('aria-busy', 'true');
  await expect(importView.getByLabel('Search this CRM')).toBeDisabled();
  await expect(carol).toBeDisabled();
  await expect(dave).toBeDisabled();
  const back = importView.getByRole('button', { name: 'All sources' });
  await expect(back).toHaveAttribute('aria-disabled', 'true');

  await dave.dispatchEvent('click');
  await back.dispatchEvent('click');
  await promote.dispatchEvent('click');
  await promote.dispatchEvent('click');
  await expect(importView.getByRole('heading', { name: 'Add from HubSpot (work)' }))
    .toBeVisible();
  await expect(carol).toBeChecked();
  await expect(dave).not.toBeChecked();
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('contact.import.promote'),
  )).toBe(1);

  const receipt = page.locator(`[${DATA_CONTACT_IMPORT_RESULT}]`);
  await expect(receipt).toHaveText('1 added');
  await expect(receipt).toHaveAttribute('role', 'status');
  await expect(receipt).toHaveAttribute('tabindex', '-1');
  await expect(receipt).toBeFocused();
});

test('Data keeps duplicate scanning owned and withholds its stale review queue', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=contact-scan&contact_scan_response=slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact/scan'));

  const scanView = page.locator(`[${DATA_CONTACT_SCAN}]`);
  const review = page.getByRole('dialog', { name: 'Contact merge review' });
  await expect(scanView).toBeVisible();
  await expect(review).toBeVisible();
  const scan = scanView.locator(
    '[data-recued-data-action="run-merge-scan"]',
  );
  await scan.focus();
  await page.keyboard.press('Enter');

  await expect(scan).toHaveText('Scanning…');
  await expect(scan).toBeFocused();
  await expect(scan).not.toHaveAttribute('disabled');
  await expect(scan).toHaveAttribute('aria-disabled', 'true');
  await expect(scan).toHaveAttribute('aria-busy', 'true');
  await expect(review).toHaveCount(0);
  const back = scanView.getByRole('button', { name: /Back to contacts/ });
  await expect(back).toHaveAttribute('aria-disabled', 'true');

  await back.dispatchEvent('click');
  await scan.dispatchEvent('click');
  await scan.dispatchEvent('click');
  await expect(scanView).toBeVisible();
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('contact.merge.scan_now'),
  )).toBe(1);

  const receipt = page.locator(`[${DATA_SCAN_RESULT}]`);
  await expect(receipt).toContainText('Compared 42 contacts');
  await expect(receipt).toContainText('1 new possible duplicate');
  await expect(receipt).toHaveAttribute('role', 'status');
  await expect(receipt).toHaveAttribute('tabindex', '-1');
  await expect(receipt).toBeFocused();
  await expect(review).toBeVisible();
});

test('Data keeps a merge decision owned through queue reconciliation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=contact-merge&contact_merge_response=slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact/scan'));

  const scanView = page.locator(`[${DATA_CONTACT_SCAN}]`);
  const review = page.getByRole('dialog', { name: 'Contact merge review' });
  await expect(review.locator(
    '.merge-review-card[data-email="alice.a@example.test"]',
  )).toContainText('Alice Archer');
  await expect(review.locator(
    '.merge-review-card[data-email="alice.b@example.test"]',
  )).toContainText('Alice A.');
  const reject = review.locator('[data-action="contact-merge-reject"]');
  await reject.focus();
  await page.keyboard.press('Enter');

  await expect(reject).toHaveText('Marking as different…');
  await expect(reject).toBeFocused();
  await expect(reject).not.toHaveAttribute('disabled');
  await expect(reject).toHaveAttribute('aria-disabled', 'true');
  await expect(reject).toHaveAttribute('aria-busy', 'true');
  await expect(review.locator('[data-action="contact-merge-confirm"]'))
    .toBeDisabled();
  const survivorChoices = review.locator(
    '[data-action="contact-merge-set-survivor"]',
  );
  await expect(survivorChoices).toHaveCount(2);
  await expect(survivorChoices.nth(0)).toBeDisabled();
  await expect(survivorChoices.nth(1)).toBeDisabled();
  const back = scanView.getByRole('button', { name: /Back to contacts/ });
  const scan = scanView.locator('[data-recued-data-action="run-merge-scan"]');
  await expect(back).toHaveAttribute('aria-disabled', 'true');
  await expect(scan).toBeDisabled();

  await survivorChoices.nth(0).dispatchEvent('click');
  await back.dispatchEvent('click');
  await scan.dispatchEvent('click');
  await reject.dispatchEvent('click');
  await reject.dispatchEvent('click');
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('contact.merge.reject'),
  )).toBe(1);
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('contact.merge.scan_now'),
  )).toBe(0);

  const receipt = page.locator(`[${DATA_MERGE_RESULT}]`);
  await expect(receipt).toContainText('Marked as different');
  await expect(receipt).toContainText('The list is up to date');
  await expect(receipt).toHaveAttribute('role', 'status');
  await expect(receipt).toHaveAttribute('tabindex', '-1');
  await expect(receipt).toBeFocused();
  await expect(review.getByText('No pending merge candidates')).toBeVisible();
});

test('Data task search accepts continuous keyboard input', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#data/task'));

  const dataRoute = page.locator('[data-saved-data-route]');
  await expect(dataRoute.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(dataRoute.getByRole('heading', { name: 'Tasks', level: 2 }))
    .toBeVisible();
  await expect(dataRoute.getByRole('region', { name: 'Tasks' })).toBeVisible();
  await expect(dataRoute.locator('main')).toHaveCount(0);

  const search = page.locator(
    'input[data-action="search-work-entities"][data-kind="task"]',
  );
  await expect(search).toBeVisible();
  await search.focus();
  await expect(search).toBeFocused();
  await page.keyboard.type('budget');

  await expect(search).toHaveValue('budget');
  await expect(search).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('X');
  await expect(search).toHaveValue('budgXet');
  await expect(search).toBeFocused();
});

test('Data task source selection retains refresh ownership', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=work-entities-paged#data/task`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const source = page.locator('select[data-action="select-source"]');
  await expect(source).toHaveAccessibleName('Source');
  const callsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('work_entity.list'),
  );
  await source.focus();
  await source.selectOption('recued.task');

  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('work_entity.list')),
  ).toBe(callsBefore + 1);
  await expect(source).toHaveValue('recued.task');
  await expect(source).toBeFocused();
});

test('Data booking search coalesces server reads while typing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=work-entities-paged#data/booking`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const search = page.locator(
    'input[data-action="search-work-entities"][data-kind="booking"]',
  );
  await expect(search).toBeVisible();
  const callsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('work_entity.list'),
  );
  await search.focus();
  await page.keyboard.type('opaque');

  await expect(search).toHaveValue('opaque');
  await expect(search).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('work_entity.list')),
  ).toBe(callsBefore + 1);
});

test('Data moves focus into New Task and restores its opener on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=work-entities-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/task'));

  const trigger = page.getByRole('button', { name: '+ New Task', exact: true });
  expect((await trigger.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await trigger.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'New Task' });
  const title = dialog.getByLabel('Title');
  await expect(title).toBeFocused();
  await expect(title).toBeInViewport();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Data protects an unfinished task create from Escape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=work-entities-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/task'));

  const trigger = page.getByRole('button', { name: '+ New Task', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'New Task' });
  const title = dialog.getByLabel('Title');
  const guard = page.locator(`[${DATA_WORK_ENTITY_DISCARD_GUARD}]`);
  await title.fill('未完了のタスク');
  await title.focus();
  const composingEscape = await title.evaluate((input) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    const dispatched = input.dispatchEvent(event);
    return { dispatched, defaultPrevented: event.defaultPrevented };
  });
  expect(composingEscape).toEqual({
    dispatched: true,
    defaultPrevented: false,
  });
  await expect(guard).toHaveCount(0);
  await expect(title).toHaveValue('未完了のタスク');
  await expect(title).toBeFocused();

  await title.fill('Unfinished new task');
  await page.keyboard.press('Escape');

  await expect(guard).toBeFocused();
  await page.locator(`[${DATA_WORK_ENTITY_DISCARD_KEEP}]`).click();
  await expect(guard).toHaveCount(0);
  await expect(title).toHaveValue('Unfinished new task');
  await expect(title).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(guard).toBeFocused();
  await page.locator(`[${DATA_WORK_ENTITY_DISCARD_COMMIT}]`).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Data contact search retains its keyboard query while refreshing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const search = page.getByRole('searchbox', { name: 'Search contacts' });
  await expect(search).toBeVisible();
  const contactsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('contact.search.local'),
  );
  const sourcesBefore = await page.evaluate(
    () => window.__app.rpcCallCount('contact.source.list'),
  );
  await search.focus();
  await expect(search).toBeFocused();
  await page.keyboard.type('mary');

  await expect(search).toHaveValue('mary');
  await expect(search).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('contact.search.local')),
  ).toBe(contactsBefore + 1);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('contact.source.list')),
  ).toBe(sourcesBefore + 1);
});

test('Data moves keyboard focus into the New contact dialog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const trigger = page.getByRole('button', { name: 'New contact', exact: true });
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'New contact' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Email')).toBeFocused();
});

test('Data restores the New contact trigger when its dialog closes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const trigger = page.getByRole('button', { name: 'New contact', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  await expect(dialog.getByLabel('Email')).toBeFocused();

  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await close.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Data protects an unfinished contact create from dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const trigger = page.getByRole('button', { name: 'New contact', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  const email = dialog.getByLabel('Email');
  await email.fill('unfinished@example.test');
  await page.keyboard.press('Escape');

  const guard = page.locator(`[${DATA_CONTACT_DISCARD_GUARD}]`);
  await expect(dialog).toBeVisible();
  await expect(guard).toHaveAttribute('role', 'alertdialog');
  await expect(guard).toBeFocused();
  await expect(dialog.locator('.data-contact-dialog-editor'))
    .toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(guard).toHaveCount(0);
  await expect(email).toHaveValue('unfinished@example.test');
  await expect(email).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(guard).toBeFocused();
  const keep = page.locator(`[${DATA_CONTACT_DISCARD_KEEP}]`);
  await page.keyboard.press('Tab');
  await expect(keep).toBeFocused();
  await keep.click();
  await expect(guard).toHaveCount(0);
  await expect(email).toHaveValue('unfinished@example.test');
  await expect(email).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(guard).toBeFocused();
  const discard = page.locator(`[${DATA_CONTACT_DISCARD_COMMIT}]`);
  await page.keyboard.press('Shift+Tab');
  await expect(discard).toBeFocused();
  await discard.click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Data keeps Tab navigation inside the Contact dialog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  await page.getByRole('button', { name: 'New contact', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await close.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');

  await expect(save).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
});

test('Data closes the Contact dialog with Escape and restores its trigger', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const trigger = page.getByRole('button', { name: 'New contact', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  await expect(dialog.getByLabel('Email')).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Data focuses the invalid Contact field after validation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  await page.getByRole('button', { name: 'New contact', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await save.focus();
  await expect(save).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(dialog.getByRole('alert')).toHaveText('Email is required.');
  await expect(dialog.getByLabel('Email')).toBeFocused();
});

test('Data moves keyboard focus into the editable Contact field', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=contacts&contact_edit_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  await page.locator(
    `[${DATA_CONTACT_ROW}="mary@example.test"] button`,
  ).click();
  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  await edit.focus();
  await expect(edit).toBeFocused();
  await page.keyboard.press('Enter');

  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('contact.get'))).toBe(2);
  const opening = page.locator(
    '[data-recued-data-action="open-edit-contact"]',
  );
  expect(await opening.evaluate((button) => ({
    text: button.textContent?.trim(),
    disabled: button.hasAttribute('disabled'),
    ariaDisabled: button.getAttribute('aria-disabled'),
    ariaBusy: button.getAttribute('aria-busy'),
    focused: button === document.activeElement,
  }))).toEqual({
    text: 'Opening editor…',
    disabled: false,
    ariaDisabled: 'true',
    ariaBusy: 'true',
    focused: true,
  });
  await opening.dispatchEvent('click');
  await opening.dispatchEvent('click');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('contact.get'))).toBe(2);

  const dialog = page.getByRole('dialog', { name: 'Edit contact' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Email')).toHaveAttribute('readonly', '');
  await expect(dialog.getByLabel('Name')).toBeFocused();

  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
});

test('Data protects an unfinished contact edit from Cancel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=contacts`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  await page.locator(
    `[${DATA_CONTACT_ROW}="mary@example.test"] button`,
  ).click();
  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  await edit.click();
  const dialog = page.getByRole('dialog', { name: 'Edit contact' });
  const name = dialog.getByLabel('Name');
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await name.fill('Unfinished Mary');
  await cancel.focus();
  await page.keyboard.press('Enter');

  const guard = page.locator(`[${DATA_CONTACT_DISCARD_GUARD}]`);
  await expect(guard).toBeFocused();
  await page.locator(`[${DATA_CONTACT_DISCARD_KEEP}]`).click();
  await expect(guard).toHaveCount(0);
  await expect(name).toHaveValue('Unfinished Mary');
  await expect(cancel).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(guard).toBeFocused();
  await page.locator(`[${DATA_CONTACT_DISCARD_COMMIT}]`).click();
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
});

test('Data does not reopen Contact edit after leaving its detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=contacts&contact_edit_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const row = page.locator(
    `[${DATA_CONTACT_ROW}="mary@example.test"] button`,
  );
  await row.click();
  await expect(page.locator(`[${DATA_CONTACT_DETAIL_HEADING}]`)).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('contact.get'))).toBe(2);

  const back = page.getByRole('button', {
    name: '← Back to contacts',
    exact: true,
  });
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(row).toBeFocused();
  await page.waitForTimeout(900);

  await expect(page.getByRole('dialog', { name: 'Edit contact' })).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('contact.get'))).toBe(2);
});

test('Data restores failed Contact edit focus without opening a dialog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=contacts&contact_edit_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  await page.locator(
    `[${DATA_CONTACT_ROW}="mary@example.test"] button`,
  ).click();
  await expect(page.locator(`[${DATA_CONTACT_DETAIL_HEADING}]`)).toBeVisible();
  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  await edit.focus();
  await page.keyboard.press('Enter');

  const opening = page.getByRole('button', {
    name: 'Opening editor…',
    exact: true,
  });
  await expect(opening).toBeFocused();
  await expect(page.getByRole('alert')).toHaveText(
    'Contact editor unavailable.',
  );
  await expect(page.getByRole('dialog', { name: 'Edit contact' })).toHaveCount(0);
  await expect(edit).toBeFocused();
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('contact.get'))).toBe(2);
});

test('Data restores Contact edit focus after a successful save', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=contacts`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  await page.locator(
    `[${DATA_CONTACT_ROW}="mary@example.test"] button`,
  ).click();
  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  await edit.click();
  const dialog = page.getByRole('dialog', { name: 'Edit contact' });
  await dialog.getByLabel('Name').fill('Mary Updated');
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await save.focus();
  await expect(save).toBeFocused();
  await page.keyboard.press('Enter');

  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('contact.upsert'))).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
});

test('Data restores the New contact trigger after a successful save', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=contacts`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const trigger = page.getByRole('button', { name: 'New contact', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  await dialog.getByLabel('Email').fill('new@example.test');
  await dialog.getByLabel('Name').fill('New Person');
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await save.focus();
  await page.keyboard.press('Enter');

  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('contact.upsert'))).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Data keeps Contact save focused and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=contacts&hold_rpc=contact.upsert`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const trigger = page.getByRole('button', { name: 'New contact', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  const email = dialog.getByLabel('Email');
  const name = dialog.getByLabel('Name');
  await email.fill('single-flight@example.test');
  await name.fill('Single Flight');
  const save = dialog.locator(
    '[data-recued-data-action="submit-contact-dialog"]',
  );
  await save.focus();
  await page.keyboard.press('Enter');

  await expect(save).toHaveText('Saving…');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).not.toHaveAttribute('disabled', '');
  await expect(save).toBeFocused();
  await expect(email).toHaveAttribute('readonly', '');
  await expect(name).toHaveAttribute('readonly', '');
  await expect(dialog.getByLabel('Phone')).toHaveAttribute('readonly', '');
  await expect(dialog.getByLabel('Company')).toHaveAttribute('readonly', '');
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await expect(close).toHaveAttribute('aria-disabled', 'true');
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(save).toBeFocused();
  await close.dispatchEvent('click');
  await cancel.dispatchEvent('click');
  await expect(dialog).toBeVisible();
  await expect(save).toBeFocused();
  await save.dispatchEvent('click');
  await save.dispatchEvent('click');

  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('contact.upsert'))).toBe(1);
  expect(await page.evaluate(
    () => window.__app.releaseRpcResponses?.('contact.upsert'),
  )).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Data retains a Contact save across tab and route leave', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=contacts&hold_rpc=contact.upsert`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const trigger = page.getByRole('button', { name: 'New contact', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  await dialog.getByLabel('Email').fill('owned-save@example.test');
  await dialog.getByLabel('Name').fill('Owned Save');
  const save = dialog.locator(
    '[data-recued-data-action="submit-contact-dialog"]',
  );
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(save).toHaveText('Saving…');
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return window.dispatchEvent(event);
  })).toBe(false);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    window.__app.setHash('#chat');
  });

  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening. Leave Data anyway?',
  );
  await expect.poll(() => page.evaluate(() => window.location.hash))
    .toBe('#data/contact');
  await expect(dialog).toBeVisible();
  await expect(save).toBeFocused();

  expect(await page.evaluate(
    () => window.__app.releaseRpcResponses?.('contact.upsert'),
  )).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return window.dispatchEvent(event);
  })).toBe(true);
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Data restores failed Contact save focus and draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=contacts&compose_commit_response=slow&contact_save_response=fail`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  await page.getByRole('button', { name: 'New contact', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  const email = dialog.getByLabel('Email');
  const name = dialog.getByLabel('Name');
  await email.fill('retry@example.test');
  await name.fill('Retry Person');
  const save = dialog.locator(
    '[data-recued-data-action="submit-contact-dialog"]',
  );
  await save.focus();
  await page.keyboard.press('Enter');

  await expect(save).toHaveText('Saving…');
  await expect(save).toBeFocused();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Contact save unavailable.',
  );
  await expect(save).toHaveText('Save');
  await expect(save).toBeFocused();
  await expect(email).toHaveValue('retry@example.test');
  await expect(name).toHaveValue('Retry Person');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('contact.upsert'))).toBe(1);
});

test('Data contains long Contact identity text on a narrow phone', async ({ page }) => {
  const longName = `Contact${'Identity'.repeat(30)}`;
  const longEmail = `${'contact'.repeat(8)}@example.test`;
  const longCompany = `Company${'Identifier'.repeat(24)}`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=contacts&contact_text=long`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const row = page.locator(`[${DATA_CONTACT_ROW}]`).first();
  await expect(row.locator('.data-row-title')).toHaveText(longName);
  await expect(row.locator('.data-row-meta')).toHaveText(
    `${longEmail} - ${longCompany}`,
  );
  const listGeometry = await row.evaluate((node) => {
    const route = node.closest<HTMLElement>('[data-recued-data-route]');
    const elements = [
      node,
      node.querySelector<HTMLElement>('.data-contact-row-button'),
      node.querySelector<HTMLElement>('.data-contact-text'),
    ].filter((element): element is HTMLElement => element !== null);
    return {
      routeScrollWidth: route?.scrollWidth ?? 0,
      routeClientWidth: route?.clientWidth ?? 0,
      elements: elements.map((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      })),
    };
  });
  expect(listGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(listGeometry.routeClientWidth);
  for (const bounds of listGeometry.elements) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }

  await row.getByRole('button').click();
  const heading = page.locator(`[${DATA_CONTACT_DETAIL_HEADING}]`);
  await expect(heading).toHaveText(longName);
  await expect(page.locator('.data-contact-detail-heading .data-row-meta'))
    .toHaveText(longEmail);
  const detailGeometry = await page.locator(
    '[data-recued-data-contact-detail]',
  ).evaluate((detail) => {
    const route = detail.closest<HTMLElement>('[data-recued-data-route]');
    const elements = [
      detail,
      detail.querySelector<HTMLElement>('.data-contact-detail-header'),
      detail.querySelector<HTMLElement>('.data-contact-detail-heading'),
      detail.querySelector<HTMLElement>(
        '[data-recued-data-contact-detail-heading]',
      ),
      detail.querySelector<HTMLElement>(
        '.data-contact-detail-heading .data-row-meta',
      ),
      detail.querySelector<HTMLElement>(
        '.data-contact-detail-heading .data-row-subtle',
      ),
      ...detail.querySelectorAll<HTMLElement>('.data-contact-value-text'),
    ].filter((element): element is HTMLElement => element !== null);
    return {
      routeScrollWidth: route?.scrollWidth ?? 0,
      routeClientWidth: route?.clientWidth ?? 0,
      elements: elements.map((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      })),
    };
  });
  expect(detailGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(detailGeometry.routeClientWidth);
  for (const bounds of detailGeometry.elements) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit contact' });
  await expect(dialog.getByLabel('Email')).toHaveValue(longEmail);
  await expect(dialog.getByLabel('Name')).toHaveValue(longName);
  await expect(dialog.getByLabel('Company')).toHaveValue(longCompany);
  const dialogGeometry = await dialog.evaluate((node) => ({
    left: node.getBoundingClientRect().left,
    right: node.getBoundingClientRect().right,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  expect(dialogGeometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(dialogGeometry.right).toBeLessThanOrEqual(280.5);
  expect(dialogGeometry.scrollWidth).toBeLessThanOrEqual(
    dialogGeometry.clientWidth,
  );
});

test('Data hands keyboard focus from a contact row to its loaded detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=contacts`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const row = page.locator(
    `[${DATA_CONTACT_ROW}="mary@example.test"] button`,
  );
  await expect(row).toBeVisible();
  await row.focus();
  await expect(row).toBeFocused();
  await page.keyboard.press('Enter');

  const heading = page.locator(`[${DATA_CONTACT_DETAIL_HEADING}]`);
  await expect(heading).toHaveText('Mary Rivera');
  await expect(heading).toBeFocused();
  await expect(page.locator('.memory-entity-detail-title')).toHaveJSProperty(
    'tagName',
    'H4',
  );
  const activitySectionHeadings = await page
    .locator('.memory-entity-detail-section-title')
    .evaluateAll((elements) => elements.map((element) => element.tagName));
  expect(new Set(activitySectionHeadings)).toEqual(new Set(['H5']));
});

test('Data renders a prior in-page hash after opening contact detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=contacts`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const row = page.locator(
    `[${DATA_CONTACT_ROW}="mary@example.test"] button`,
  );
  await row.click();
  const heading = page.locator(`[${DATA_CONTACT_DETAIL_HEADING}]`);
  await expect(heading).toHaveText('Mary Rivera');
  await expect(page).toHaveURL(/#data\/contact\/mary%40example\.test$/);

  // Opening the detail writes through History (which emits no hashchange).
  // Returning to the prior hash must not equal a stale shell cache and no-op.
  await page.evaluate(() => window.__app.setHash('#data/contact'));
  await expect(page).toHaveURL(/#data\/contact$/);
  await expect(heading).toHaveCount(0);
  await expect(row).toBeVisible();
});

test('Data returns keyboard focus from contact detail to its exact row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=contacts`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const row = page.locator(
    `[${DATA_CONTACT_ROW}="mary@example.test"] button`,
  );
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`[${DATA_CONTACT_DETAIL_HEADING}]`)).toBeFocused();

  const back = page.getByRole('button', {
    name: '← Back to contacts',
    exact: true,
  });
  await back.focus();
  await expect(back).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(row).toBeVisible();
  await expect(row).toBeFocused();
});

test('Data guards contact pagination and advances focus on the final page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=contacts-paged&data_pagination_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/contact'));

  const loadMore = page.locator(`[${DATA_CONTACT_LOAD_MORE}] button`);
  await expect(loadMore).toBeVisible();
  await loadMore.focus();
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('contact.list'),
  );
  await page.evaluate((attr) => {
    document.querySelector<HTMLElement>(`[${attr}] button`)?.click();
    document.querySelector<HTMLElement>(`[${attr}] button`)?.click();
  }, DATA_CONTACT_LOAD_MORE);

  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('contact.list')),
  ).toBe(before + 1);
  expect(await loadMore.evaluate((button) => ({
    text: button.textContent?.trim(),
    disabled: button.hasAttribute('disabled'),
    ariaDisabled: button.getAttribute('aria-disabled'),
    ariaBusy: button.getAttribute('aria-busy'),
    focused: button === document.activeElement,
  }))).toEqual({
    text: 'Loading…',
    disabled: false,
    ariaDisabled: 'true',
    ariaBusy: 'true',
    focused: true,
  });

  const second = page.locator(
    `[${DATA_CONTACT_ROW}="john@example.test"] button`,
  );
  await expect(second).toBeVisible();
  await expect(page.locator(
    `[${DATA_CONTACT_ROW}="zoe@example.test"]`,
  )).toHaveCount(0);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('contact.list')),
  ).toBe(before + 1);
  await expect(loadMore).toBeFocused();

  await page.keyboard.press('Enter');
  const final = page.locator(
    `[${DATA_CONTACT_ROW}="zoe@example.test"] button`,
  );
  await expect(final).toBeVisible();
  await expect(page.locator(`[${DATA_CONTACT_LOAD_MORE}]`)).toHaveCount(0);
  await expect(final).toBeFocused();
});

test('Data keeps narrow Booking filters usable', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(`${HARNESS_URL}?data=work-entities-paged#data/booking`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const search = page.getByRole('searchbox', { name: 'Search bookings' });
  const filter = page.getByRole('combobox', {
    name: 'Filter bookings by status',
  });
  const geometry = await Promise.all([search, filter].map((control) =>
    control.evaluate((node) => ({
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
      top: node.getBoundingClientRect().top,
      bottom: node.getBoundingClientRect().bottom,
      width: node.getBoundingClientRect().width,
    }))
  ));
  for (const bounds of geometry) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.width).toBeGreaterThanOrEqual(200);
  }
  expect(geometry[1]!.top).toBeGreaterThanOrEqual(geometry[0]!.bottom);
});

test('Data contains long work-entity text on a narrow phone', async ({ page }) => {
  const longTitle = `WorkEntity${'Identity'.repeat(30)}`;
  const longBody = `Details${'Provider'.repeat(30)}`;
  const longSource = `Source${'Provider'.repeat(30)}`;
  const longRelationship = `task-${'Related'.repeat(30)}`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=work-entities-paged&work_entity_text=long#data/task`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const row = page.locator(
    '[data-action="open-edit-work-entity"][data-entity-id="task-0"]',
  );
  await expect(row.locator('.work-entity-list-row-primary'))
    .toHaveText(longTitle);
  await expect(row.locator('.work-entity-list-row-secondary'))
    .toContainText(longBody.slice(0, 40));
  await expect(row.locator('.work-entity-list-row-source'))
    .toHaveText(longSource);
  const listGeometry = await page.locator('.work-entity-page').evaluate(
    (surface) => {
      const route = surface.closest<HTMLElement>('[data-recued-data-route]');
      const elements = [
        surface,
        surface.querySelector<HTMLElement>('.work-entity-page-source-row'),
        surface.querySelector<HTMLElement>('.work-entity-source-dropdown'),
        surface.querySelector<HTMLElement>(
          '.work-entity-source-dropdown-select',
        ),
        surface.querySelector<HTMLElement>('.work-entity-list-row'),
        surface.querySelector<HTMLElement>('.work-entity-list-row-button'),
        surface.querySelector<HTMLElement>('.work-entity-list-row-primary'),
        surface.querySelector<HTMLElement>('.work-entity-list-row-secondary'),
        surface.querySelector<HTMLElement>('.work-entity-list-row-source'),
      ].filter((element): element is HTMLElement => element !== null);
      return {
        routeScrollWidth: route?.scrollWidth ?? 0,
        routeClientWidth: route?.clientWidth ?? 0,
        elements: elements.map((element) => ({
          left: element.getBoundingClientRect().left,
          right: element.getBoundingClientRect().right,
        })),
      };
    },
  );
  expect(listGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(listGeometry.routeClientWidth);
  for (const bounds of listGeometry.elements) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
  }

  await row.click();
  const dialog = page.getByRole('dialog', { name: 'Edit Task' });
  await expect(dialog.getByLabel('Title')).toHaveValue(longTitle);
  await expect(dialog.getByLabel('Notes')).toHaveValue(longBody);
  await expect(dialog.locator('.work-entity-dialog-source-value'))
    .toHaveText(longSource);
  await dialog.getByRole('button', { name: 'More details', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Blocks task 1' }))
    .toHaveValue(longRelationship);
  const dialogGeometry = await dialog.evaluate((surface) => {
    const elements = [
      surface,
      surface.querySelector<HTMLElement>('.work-entity-dialog-form'),
      surface.querySelector<HTMLElement>('.work-entity-dialog-source-static'),
      surface.querySelector<HTMLElement>('.work-entity-dialog-source-value'),
    ].filter((element): element is HTMLElement => element !== null);
    return elements.map((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
  });
  for (const bounds of dialogGeometry) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }
});

test('Data guards task pagination and advances focus on the final page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=work-entities-paged&data_pagination_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/task'));

  const loadMore = page.locator(`[${DATA_WORK_ENTITY_LOAD_MORE}] button`);
  await expect(loadMore).toBeVisible();
  await loadMore.focus();
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('work_entity.list'),
  );
  await page.evaluate((attr) => {
    document.querySelector<HTMLElement>(`[${attr}] button`)?.click();
    document.querySelector<HTMLElement>(`[${attr}] button`)?.click();
  }, DATA_WORK_ENTITY_LOAD_MORE);

  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('work_entity.list')),
  ).toBe(before + 1);
  expect(await loadMore.evaluate((button) => ({
    text: button.textContent?.trim(),
    disabled: button.hasAttribute('disabled'),
    ariaDisabled: button.getAttribute('aria-disabled'),
    ariaBusy: button.getAttribute('aria-busy'),
    focused: button === document.activeElement,
  }))).toEqual({
    text: 'Loading…',
    disabled: false,
    ariaDisabled: 'true',
    ariaBusy: 'true',
    focused: true,
  });

  const second = page.locator(
    '[data-action="open-edit-work-entity"][data-entity-id="task-1"]',
  );
  await expect(second).toBeVisible();
  await expect(page.locator('[data-entity-id="task-2"]')).toHaveCount(0);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('work_entity.list')),
  ).toBe(before + 1);
  await expect(loadMore).toBeFocused();

  await page.keyboard.press('Enter');
  const final = page.locator(
    '[data-action="open-edit-work-entity"][data-entity-id="task-2"]',
  );
  await expect(final).toBeVisible();
  await expect(page.locator(`[${DATA_WORK_ENTITY_LOAD_MORE}]`)).toHaveCount(0);
  await expect(final).toBeFocused();
});

test('Data carries task-row focus through edit loading and back from the dialog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=work-entities-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/task'));

  const row = page.locator(
    '[data-action="open-edit-work-entity"][data-entity-id="task-0"]',
  );
  const readsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('work_entity.get'),
  );
  await row.focus();
  await page.keyboard.press('Enter');

  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await expect(row).toHaveAttribute('aria-busy', 'true');
  await expect(row).not.toHaveAttribute('disabled');
  await expect(row).toContainText('Opening…');
  await expect(row).toBeFocused();
  await row.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('work_entity.get')),
  ).toBe(readsBefore + 1);

  const dialog = page.getByRole('dialog', { name: 'Edit Task' });
  const title = dialog.getByLabel('Title');
  await expect(title).toHaveValue('Task 0');
  await expect(title).toBeFocused();
  await expect(title).toBeInViewport();

  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(save).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
});

test('Data protects an unfinished task edit from dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=work-entities-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/task'));

  const row = page.locator(
    '[data-action="open-edit-work-entity"][data-entity-id="task-0"]',
  );
  await row.click();
  const dialog = page.getByRole('dialog', { name: 'Edit Task' });
  const title = dialog.getByLabel('Title');
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await title.fill('Unfinished task edit');
  await close.focus();
  await page.keyboard.press('Enter');

  const guard = page.locator(`[${DATA_WORK_ENTITY_DISCARD_GUARD}]`);
  await expect(dialog).toBeVisible();
  await expect(guard).toHaveAttribute('role', 'alertdialog');
  await expect(guard).toBeFocused();
  await expect(guard).toContainText('Discard your task changes?');
  const guardActionHeights = await guard.getByRole('button').evaluateAll(
    (buttons) => buttons.map((button) => button.getBoundingClientRect().height),
  );
  expect(Math.min(...guardActionHeights)).toBeGreaterThanOrEqual(36);

  await page.keyboard.press('Escape');
  await expect(guard).toHaveCount(0);
  await expect(title).toHaveValue('Unfinished task edit');
  await expect(close).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(guard).toBeFocused();
  await page.locator(`[${DATA_WORK_ENTITY_DISCARD_KEEP}]`).click();
  await expect(guard).toHaveCount(0);
  await expect(close).toBeFocused();
  await expect(title).toHaveValue('Unfinished task edit');

  await page.keyboard.press('Enter');
  const discard = page.locator(`[${DATA_WORK_ENTITY_DISCARD_COMMIT}]`);
  await expect(discard).toHaveText('Discard changes');
  await discard.click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText('Task 0');
  await expect(row).toBeFocused();
});

test('Data focuses a newly added task relationship without losing the draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=work-entities-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/task'));

  await page.locator(
    '[data-action="open-edit-work-entity"][data-entity-id="task-0"]',
  ).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Task' });
  const title = dialog.getByLabel('Title');
  await title.fill('Draft survives repaint');
  await dialog.getByRole('button', { name: 'More details', exact: true }).click();
  const add = dialog.getByRole('button', { name: 'Add Blocks task' });
  await add.focus();
  await page.keyboard.press('Enter');

  const entry = dialog.getByRole('textbox', { name: 'Blocks task 1' });
  await expect(entry).toHaveCount(1);
  await expect(entry).toBeFocused();
  await expect(entry).toBeInViewport();
  await expect(title).toHaveValue('Draft survives repaint');
});

test('Data restores task relationship removal focus to a survivor or Add', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=work-entities-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/task'));

  await page.locator(
    '[data-action="open-edit-work-entity"][data-entity-id="task-0"]',
  ).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Task' });
  const title = dialog.getByLabel('Title');
  await title.fill('Removal draft survives');
  await dialog.getByRole('button', { name: 'More details', exact: true }).click();
  const add = dialog.getByRole('button', { name: 'Add Blocks task' });
  await add.click();
  await dialog.getByRole('textbox', { name: 'Blocks task 1' }).fill('task-a');
  await add.click();
  await dialog.getByRole('textbox', { name: 'Blocks task 2' }).fill('task-b');

  const firstRemove = dialog.getByRole('button', {
    name: 'Remove Blocks task 1',
  });
  await firstRemove.focus();
  await page.keyboard.press('Enter');
  const survivor = dialog.getByRole('textbox', { name: 'Blocks task 1' });
  await expect(survivor).toHaveValue('task-b');
  await expect(survivor).toBeFocused();
  await expect(survivor).toBeInViewport();
  await expect(title).toHaveValue('Removal draft survives');

  const lastRemove = dialog.getByRole('button', {
    name: 'Remove Blocks task 1',
  });
  await lastRemove.focus();
  await page.keyboard.press('Enter');
  await expect(survivor).toHaveCount(0);
  await expect(add).toBeFocused();
  await expect(add).toBeInViewport();
  await expect(title).toHaveValue('Removal draft survives');
});

test('Data keeps task save visible, single-flight, and returns focus to the updated row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=work-entities-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/task'));

  const row = page.locator(
    '[data-action="open-edit-work-entity"][data-entity-id="task-0"]',
  );
  await row.click();
  const dialog = page.getByRole('dialog', { name: 'Edit Task' });
  await dialog.getByLabel('Title').fill('Task polished');
  const save = dialog.locator(
    '[data-action="submit-work-entity-dialog"]',
  );
  const writesBefore = await page.evaluate(
    () => window.__app.rpcCallCount('work_entity.upsert'),
  );
  await save.focus();
  await page.keyboard.press('Enter');

  await expect(save).toHaveText('Saving…');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await expect(close).toHaveAttribute('aria-disabled', 'true');
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(save).toBeFocused();
  await close.dispatchEvent('click');
  await cancel.dispatchEvent('click');
  await page.locator('.work-entity-dialog-backdrop').dispatchEvent('click');
  await expect(dialog).toBeVisible();
  await expect(save).toBeFocused();
  await save.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('work_entity.upsert')),
  ).toBe(writesBefore + 1);

  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText('Task polished');
  await expect(row).toBeFocused();
});

test('Data moves task validation ownership to the first invalid field', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=work-entities-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/task'));

  await page.locator(
    '[data-action="open-edit-work-entity"][data-entity-id="task-0"]',
  ).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Task' });
  const title = dialog.getByLabel('Title');
  await title.fill('');
  const writesBefore = await page.evaluate(
    () => window.__app.rpcCallCount('work_entity.upsert'),
  );
  const save = dialog.locator(
    '[data-action="submit-work-entity-dialog"]',
  );
  await save.focus();
  await page.keyboard.press('Enter');

  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(title).toHaveAttribute('aria-invalid', 'true');
  await expect(title).toHaveValue('');
  await expect(title).toBeFocused();
  await expect(title).toBeInViewport();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('work_entity.upsert')),
  ).toBe(writesBefore);
});

test('Data contains long form-response text on a narrow phone', async ({ page }) => {
  const longEmail = `${'visitor'.repeat(8)}@example.test`;
  const longEndpoint = `Endpoint${'Identifier'.repeat(24)}`;
  const longDefinition = `Form${'Definition'.repeat(24)}`;
  const longSource = `Template${'Provider'.repeat(24)}`;
  const longFieldLabel = `Question${'Identifier'.repeat(24)}`;
  const longValue = `Answer${'Provider'.repeat(30)}`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=form-responses-paged&form_response_text=long`
      + '#data/form_response',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const row = page.locator('[data-recued-data-form-response-row]').first();
  await expect(row.locator('.data-row-title')).toHaveText(longEmail);
  await expect(row.locator('.data-row-meta')).toHaveText(longSource);
  expect(await page.locator('[data-recued-data-route]').evaluate((route) => (
    route.scrollWidth <= route.clientWidth
  ))).toBe(true);

  await row.getByRole('button').click();
  const detail = page.locator('[data-recued-data-form-response-detail]');
  await expect(page.locator(`[${DATA_FORM_RESPONSE_DETAIL_HEADING}]`))
    .toHaveText(longEmail);
  await expect(detail.locator('.data-response-field dt'))
    .toHaveText(longFieldLabel);
  await expect(detail.locator('.data-response-field dd'))
    .toHaveText(longValue);
  await expect(detail.locator('.data-response-meta')).toContainText(
    longDefinition,
  );
  await expect(detail.locator('.data-response-meta')).toContainText(
    longEndpoint,
  );
  await expect(page.locator(`[${DATA_FORM_RESPONSE_EMAIL}]`))
    .toHaveValue(longEmail);
  await expect(page.locator(`[${DATA_FORM_RESPONSE_VALUES}]`))
    .toContainText(longValue);

  const detailGeometry = await detail.evaluate((surface) => {
    const route = surface.closest<HTMLElement>('[data-recued-data-route]');
    const elements = [
      surface,
      surface.querySelector<HTMLElement>(
        '.data-form-response-detail-content',
      ),
      surface.querySelector<HTMLElement>('.data-response-header'),
      surface.querySelector<HTMLElement>(
        '[data-recued-data-form-response-detail-heading]',
      ),
      ...surface.querySelectorAll<HTMLElement>('.data-response-meta > div'),
      ...surface.querySelectorAll<HTMLElement>('.data-response-meta dd'),
      surface.querySelector<HTMLElement>('.data-response-fields'),
      surface.querySelector<HTMLElement>('.data-response-field'),
      surface.querySelector<HTMLElement>('.data-response-field dt'),
      surface.querySelector<HTMLElement>('.data-response-field dd'),
      surface.querySelector<HTMLElement>('.data-response-editor'),
    ].filter((element): element is HTMLElement => element !== null);
    return {
      routeScrollWidth: route?.scrollWidth ?? 0,
      routeClientWidth: route?.clientWidth ?? 0,
      elements: elements.map((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      })),
    };
  });
  expect(detailGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(detailGeometry.routeClientWidth);
  for (const bounds of detailGeometry.elements) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }
});

test('Data guards form-response pagination and advances focus on the final page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=form-responses-paged&data_pagination_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/form_response'));

  const loadMore = page.locator(`[${DATA_FORM_RESPONSE_LOAD_MORE}] button`);
  await expect(loadMore).toBeVisible();
  await loadMore.focus();
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('form_response.list'),
  );
  await page.evaluate((attr) => {
    document.querySelector<HTMLElement>(`[${attr}] button`)?.click();
    document.querySelector<HTMLElement>(`[${attr}] button`)?.click();
  }, DATA_FORM_RESPONSE_LOAD_MORE);

  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('form_response.list')),
  ).toBe(before + 1);
  expect(await loadMore.evaluate((button) => ({
    text: button.textContent?.trim(),
    disabled: button.hasAttribute('disabled'),
    ariaDisabled: button.getAttribute('aria-disabled'),
    ariaBusy: button.getAttribute('aria-busy'),
    focused: button === document.activeElement,
  }))).toEqual({
    text: 'Loading…',
    disabled: false,
    ariaDisabled: 'true',
    ariaBusy: 'true',
    focused: true,
  });

  const second = page.locator(
    '[data-recued-data-form-response-row="submission-1"] button',
  );
  await expect(second).toBeVisible();
  await expect(page.locator(
    '[data-recued-data-form-response-row="submission-2"]',
  )).toHaveCount(0);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('form_response.list')),
  ).toBe(before + 1);
  await expect(loadMore).toBeFocused();

  await page.keyboard.press('Enter');
  const final = page.locator(
    '[data-recued-data-form-response-row="submission-2"] button',
  );
  await expect(final).toBeVisible();
  await expect(page.locator(`[${DATA_FORM_RESPONSE_LOAD_MORE}]`)).toHaveCount(0);
  await expect(final).toBeFocused();
});

test('Data hands form-response focus into detail and returns it to the row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/form_response'));

  const row = page.locator(
    '[data-recued-data-form-response-row="submission-0"] button',
  );
  await expect(row).toBeVisible();
  await row.focus();
  await page.keyboard.press('Enter');

  const heading = page.locator(`[${DATA_FORM_RESPONSE_DETAIL_HEADING}]`);
  await expect(heading).toHaveText('visitor-0@example.test');
  await expect(heading).toBeFocused();

  const back = page.getByRole('button', {
    name: '← Back to form responses',
    exact: true,
  });
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(row).toBeVisible();
  await expect(row).toBeFocused();
});

test('Data protects unfinished form-response edits from Back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/form_response'));

  const row = page.locator(
    '[data-recued-data-form-response-row="submission-0"] button',
  );
  await row.click();
  const detail = page.locator(`[${DATA_FORM_RESPONSE_DETAIL_HEADING}]`);
  const email = page.locator(`[${DATA_FORM_RESPONSE_EMAIL}]`);
  const back = page.getByRole('button', {
    name: '← Back to form responses',
    exact: true,
  });
  await email.fill('unfinished@example.test');
  await back.focus();
  await page.keyboard.press('Enter');

  const guard = page.locator(`[${DATA_FORM_RESPONSE_DISCARD_GUARD}]`);
  await expect(detail).toBeVisible();
  await expect(guard).toHaveAttribute('role', 'alertdialog');
  await expect(guard).toBeFocused();
  await expect(page.locator('.data-form-response-detail-content'))
    .toHaveAttribute('inert', '');
  const collections = page.getByRole('combobox', { name: 'Collection', exact: true });
  await expect(collections).toBeDisabled();
  await collections.evaluate((select: HTMLSelectElement) => {
    select.value = 'contact';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(guard).toBeFocused();
  await expect(detail).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(guard).toHaveCount(0);
  await expect(email).toHaveValue('unfinished@example.test');
  await expect(back).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(guard).toBeFocused();
  const keep = page.locator(`[${DATA_FORM_RESPONSE_DISCARD_KEEP}]`);
  await page.keyboard.press('Tab');
  await expect(keep).toBeFocused();
  await keep.click();
  await expect(guard).toHaveCount(0);
  await expect(email).toHaveValue('unfinished@example.test');
  await expect(back).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(guard).toBeFocused();
  const discard = page.locator(`[${DATA_FORM_RESPONSE_DISCARD_COMMIT}]`);
  await page.keyboard.press('Shift+Tab');
  await expect(discard).toBeFocused();
  await discard.click();
  await expect(detail).toHaveCount(0);
  await expect(row).toBeFocused();
});

test('Data protects unfinished form-response edits from mobile collection changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/form_response'));
  await page.locator(
    '[data-recued-data-form-response-row="submission-0"] button',
  ).click();

  const detail = page.locator(`[${DATA_FORM_RESPONSE_DETAIL_HEADING}]`);
  const email = page.locator(`[${DATA_FORM_RESPONSE_EMAIL}]`);
  const collections = page.getByRole('combobox', { name: 'Collection', exact: true });
  await email.fill('tab-switch-draft@example.test');
  await collections.focus();
  await collections.selectOption('contact');

  const guard = page.locator(`[${DATA_FORM_RESPONSE_DISCARD_GUARD}]`);
  await expect(detail).toBeVisible();
  await expect(guard).toBeFocused();
  await expect(collections).toHaveValue('form_response');

  await page.locator(`[${DATA_FORM_RESPONSE_DISCARD_KEEP}]`).click();
  await expect(guard).toHaveCount(0);
  await expect(email).toHaveValue('tab-switch-draft@example.test');
  await expect(collections).toBeFocused();

  await collections.selectOption('contact');
  await expect(guard).toBeFocused();
  await page.locator(`[${DATA_FORM_RESPONSE_DISCARD_COMMIT}]`).click();
  await expect(collections).toHaveValue('contact');
  await expect(detail).toHaveCount(0);
  await expect(collections).toBeFocused();
});

test('Data protects unfinished form-response edits before Kitchen handoff', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/form_response'));
  await page.locator(
    '[data-recued-data-form-response-row="submission-0"] button',
  ).click();

  const detail = page.locator(`[${DATA_FORM_RESPONSE_DETAIL_HEADING}]`);
  const email = page.locator(`[${DATA_FORM_RESPONSE_EMAIL}]`);
  const automate = page.getByRole('link', { name: 'Automate this form' });
  await email.fill('kitchen-handoff-draft@example.test');
  await automate.focus();
  await page.keyboard.press('Enter');

  const guard = page.locator(`[${DATA_FORM_RESPONSE_DISCARD_GUARD}]`);
  await expect(detail).toBeVisible();
  await expect(guard).toBeFocused();
  await expect(page).toHaveURL(/#data\/form_response\/submission-0$/);

  await page.locator(`[${DATA_FORM_RESPONSE_DISCARD_KEEP}]`).click();
  await expect(guard).toHaveCount(0);
  await expect(email).toHaveValue('kitchen-handoff-draft@example.test');
  await expect(automate).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(guard).toBeFocused();
  await page.locator(`[${DATA_FORM_RESPONSE_DISCARD_COMMIT}]`).click();
  await expect(page).toHaveURL(/#kitchen\/new\/form-response\/project-intake$/);
  await expect(detail).toHaveCount(0);
});

test('Data advances owned focus into form-response automation discovery', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/form_response'));
  await page.locator(
    '[data-recued-data-form-response-row="submission-0"] button',
  ).click();

  const discover = page.locator(`[${DATA_FORM_RESPONSE_RUN}]`);
  const readsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('recipe.list'),
  );
  await discover.focus();
  await page.keyboard.press('Enter');

  await expect(discover).toHaveText('Looking for things that can run…');
  await expect(discover).toHaveAttribute('aria-disabled', 'true');
  await expect(discover).toHaveAttribute('aria-busy', 'true');
  await expect(discover).not.toHaveAttribute('disabled');
  await expect(discover).toBeFocused();
  await discover.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('recipe.list')),
  ).toBe(readsBefore + 1);

  const picker = page.locator(`[${DATA_FORM_RESPONSE_RUN_PICKER}="ready"]`);
  const heading = picker.getByRole('heading', { level: 3 });
  await expect(heading).toHaveText('Run this response now');
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
});

test('Data distinguishes form-response run actions and retains modal ownership', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=form-responses-paged&recipe_execute_delay_ms=750`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/form_response'));
  await page.locator(
    '[data-recued-data-form-response-row="submission-0"] button',
  ).click();
  await page.locator(`[${DATA_FORM_RESPONSE_RUN}]`).click();

  const exactForm = page.getByRole('button', {
    name: 'Look at it and run Review project intake (project-intake-review)',
    exact: true,
  });
  const allForms = page.getByRole('button', {
    name: 'Look at it and run Review every intake (all-intakes-review)',
    exact: true,
  });
  await expect(exactForm).toHaveCount(1);
  await expect(allForms).toHaveCount(1);

  await allForms.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog).toBeFocused();
  await expect(dialog).toContainText('Review every intake');
  const context = dialog.locator('[data-recued-run-modal-context]');
  await expect(context).toContainText('"submission_id": "submission-0"');
  await expect(context).toContainText('"form_definition_id": "project-intake"');
  await expect(context).not.toContainText('visitor-0@example.test');
  await expect(context).not.toContainText('Project 0');

  const runsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('execute'),
  );
  const run = dialog.locator(
    '[data-recued-run-modal-action="confirm-run"]',
  );
  await run.focus();
  await page.keyboard.press('Enter');
  await expect(run).toHaveAttribute('aria-disabled', 'true');
  await expect(run).toHaveAttribute('aria-busy', 'true');
  await expect(run).not.toHaveAttribute('disabled');
  await expect(run).toBeFocused();
  await run.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await dialog.getByRole('button', { name: 'Close' }).evaluate((button: HTMLElement) => {
    button.click();
  });
  await expect(dialog).toBeVisible();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('execute')),
  ).toBe(runsBefore + 1);
  await expect(run).not.toHaveAttribute('aria-busy');
  await expect(run).toBeFocused();
  await expect(dialog.getByRole('status')).toContainText('Run completed');

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(allForms).toBeFocused();

  await exactForm.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(exactForm).toBeFocused();
});

test('Data preserves form-response drafts and save ownership', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/form_response'));
  await page.locator(
    '[data-recued-data-form-response-row="submission-0"] button',
  ).click();

  const values = page.locator(`[${DATA_FORM_RESPONSE_VALUES}]`);
  const email = page.locator(`[${DATA_FORM_RESPONSE_EMAIL}]`);
  const lifecycle = page.locator(`[${DATA_FORM_RESPONSE_STATE}]`);
  const save = page.locator(
    'button[data-recued-data-action="save-form-response"]',
  );

  await values.fill('["not an object"]');
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Answers have to be a JSON object',
  );
  await expect(values).toHaveValue('["not an object"]');
  await expect(values).toBeFocused();

  await values.fill('{"project":"Owner revised"}');
  await email.fill('corrected@example.test');
  await lifecycle.selectOption('in_review');
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(save).toHaveText('Saving…');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).not.toBeDisabled();
  await expect(save).toBeFocused();

  await expect(save).toHaveText('Save changes');
  await expect(save).toBeFocused();
  await expect(values).toHaveValue('{\n  "project": "Owner revised"\n}');
  await expect(email).toHaveValue('corrected@example.test');
  await expect(lifecycle).toHaveValue('in_review');
});

test('Data keeps form-response navigation attached while saving', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/form_response'));
  await page.locator(
    '[data-recued-data-form-response-row="submission-0"] button',
  ).click();

  const heading = page.locator(`[${DATA_FORM_RESPONSE_DETAIL_HEADING}]`);
  const email = page.locator(`[${DATA_FORM_RESPONSE_EMAIL}]`);
  const save = page.locator(
    'button[data-recued-data-action="save-form-response"]',
  );
  const back = page.getByRole('button', {
    name: '← Back to form responses',
    exact: true,
  });
  const automate = page.getByRole('link', { name: 'Automate this form' });
  const contactTab = page.locator(`[${DATA_TAB}="contact"]`);
  await email.fill('saving@example.test');
  await save.focus();
  await page.keyboard.press('Enter');

  await expect(save).toHaveText('Saving…');
  await expect(back).toHaveAttribute('aria-disabled', 'true');
  await expect(automate).toHaveAttribute('aria-disabled', 'true');
  await expect(contactTab).toHaveAttribute('aria-disabled', 'true');
  await back.dispatchEvent('click');
  await automate.dispatchEvent('click');
  await contactTab.dispatchEvent('click');
  await expect(heading).toBeVisible();
  await expect(page).toHaveURL(/#data\/form_response\/submission-0$/);
  await expect(page.locator(`[${DATA_TAB}="form_response"]`))
    .toHaveAttribute('aria-selected', 'true');

  await expect(save).toHaveText('Save changes');
  await expect(back).not.toHaveAttribute('aria-disabled');
  await expect(automate).not.toHaveAttribute('aria-disabled');
  await expect(contactTab).not.toHaveAttribute('aria-disabled');
});

test('Data keeps form-response export visible, focused, and single-flight', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/form_response'));

  const csv = page.locator(
    'button[data-recued-data-action="export-form-responses"][data-format="csv"]',
  );
  const json = page.locator(
    'button[data-recued-data-action="export-form-responses"][data-format="json"]',
  );
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('form_response.export'),
  );
  const download = page.waitForEvent('download');
  await csv.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  await Promise.all([
    expect(csv).toHaveText('Exporting CSV…'),
    expect(csv).toHaveAttribute('aria-disabled', 'true'),
    expect(csv).toHaveAttribute('aria-busy', 'true'),
    expect(csv).not.toHaveAttribute('disabled'),
    expect(csv).toBeFocused(),
    expect(json).toHaveAttribute('aria-disabled', 'true'),
    expect(json).not.toHaveAttribute('aria-busy'),
  ]);

  await expect(csv).toHaveText('Export CSV');
  await expect(csv).toBeFocused();
  expect((await download).suggestedFilename()).toBe('form-responses.csv');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('form_response.export'),
    ),
  ).toBe(before + 1);
});

test('Data protects an unfinished Memory compose from Cancel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=memory`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));

  const add = page.getByRole('button', { name: 'Add memory', exact: true });
  await add.click();
  const form = page.getByRole('form', { name: 'New memory' });
  const kind = form.getByLabel('Kind');
  const body = form.getByLabel('Body');
  const cancel = form.getByRole('button', { name: 'Cancel', exact: true });
  await kind.fill('preference');
  await body.fill('Keep answers concise');
  await cancel.focus();
  await page.keyboard.press('Enter');

  const guard = page.locator(`[${DATA_MEMORY_COMPOSE_DISCARD_GUARD}]`);
  const keep = page.locator(`[${DATA_MEMORY_COMPOSE_DISCARD_KEEP}]`);
  const discard = page.locator(`[${DATA_MEMORY_COMPOSE_DISCARD_COMMIT}]`);
  await expect(form).toBeVisible();
  await expect(guard).toHaveAttribute('role', 'alertdialog');
  await expect(guard).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(keep).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(discard).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(guard).toHaveCount(0);
  await expect(kind).toHaveValue('preference');
  await expect(body).toHaveValue('Keep answers concise');
  await expect(cancel).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(guard).toBeFocused();
  await keep.click();
  await expect(guard).toHaveCount(0);
  await expect(cancel).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(guard).toBeFocused();
  await discard.click();
  await expect(form).toHaveCount(0);
  await expect(add).toBeFocused();
});

test('Data protects an unfinished Memory import from Close', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=memory`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));

  const opener = page.locator(
    'button[data-recued-data-action="memory-import"]',
  );
  await opener.click();
  const form = page.getByRole('form', { name: 'Import memory' });
  const input = form.getByLabel('JSON');
  const close = form.locator(
    'button[data-recued-data-action="memory-import-cancel"]',
  );
  await input.fill(
    '{"entries":[{"origin_actor":"user_self","kind":"note","body":"unfinished import"}]}',
  );
  await close.focus();
  await page.keyboard.press('Enter');

  const guard = page.locator(`[${DATA_MEMORY_IMPORT_DISCARD_GUARD}]`);
  const keep = page.locator(`[${DATA_MEMORY_IMPORT_DISCARD_KEEP}]`);
  const discard = page.locator(`[${DATA_MEMORY_IMPORT_DISCARD_COMMIT}]`);
  await expect(form).toBeVisible();
  await expect(guard).toHaveAttribute('role', 'alertdialog');
  await expect(guard).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(keep).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(discard).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(guard).toHaveCount(0);
  await expect(input).toContainText('unfinished import');
  await expect(close).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(guard).toBeFocused();
  await keep.click();
  await expect(guard).toHaveCount(0);
  await expect(close).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(guard).toBeFocused();
  await discard.click();
  await expect(form).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('Data keeps a Memory import visible, focused, and single-flight', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?data=memory`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));

  await page.locator(
    'button[data-recued-data-action="memory-import"]',
  ).click();
  const form = page.getByRole('form', { name: 'Import memory' });
  const input = form.getByLabel('JSON');
  const close = form.locator(
    'button[data-recued-data-action="memory-import-cancel"]',
  );
  const submit = form.locator(
    'button[data-recued-data-action="memory-import-submit"]',
  );
  await input.fill(
    '{"entries":[{"origin_actor":"user_self","kind":"note","body":"pending import"}]}',
  );
  await submit.focus();
  await page.keyboard.press('Enter');

  await expect(submit).toHaveText('Importing…');
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await expect(submit).toHaveAttribute('aria-busy', 'true');
  await expect(submit).not.toHaveAttribute('disabled');
  await expect(submit).toBeFocused();
  await expect(input).toHaveAttribute('readonly', '');
  await expect(close).toHaveAttribute('aria-disabled', 'true');
  await expect(close).not.toHaveAttribute('disabled');

  await page.keyboard.press('Enter');
  // Dispatch directly because Playwright correctly treats aria-disabled as
  // non-actionable; the delegated handler still needs to reject a synthetic
  // or assistive-tech activation without hiding the pending operation.
  await close.dispatchEvent('click');
  await expect(form).toBeVisible();
  await expect(submit).toBeFocused();
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Memory', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(submit).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.import')),
  ).toBe(1);
});

test('Data owns Memory Delete and Forget from review through completion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=memory-rows&memory_delete_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));

  const ownRow = page.locator('.memory-row').filter({
    hasText: 'Concise answers',
  });
  const remove = ownRow.getByRole('button', {
    name: 'Delete memory Concise answers (memory-own-1)',
    exact: true,
  });
  await remove.focus();
  await page.keyboard.press('Enter');
  const confirm = ownRow.locator(
    'button[data-recued-data-action="memory-delete-confirm"]',
  );
  const cancel = ownRow.locator(
    'button[data-recued-data-action="memory-delete-cancel"]',
  );
  await expect(confirm).toHaveText('Confirm');
  await expect(confirm).toBeFocused();
  await cancel.click();
  await expect(remove).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Deleting…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await expect(cancel).not.toHaveAttribute('disabled');

  await page.keyboard.press('Enter');
  await cancel.dispatchEvent('click');
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Memory', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(confirm).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.delete')),
  ).toBe(1);

  await expect(ownRow).toHaveCount(0);
  const add = page.getByRole('button', { name: 'Add memory', exact: true });
  await expect(add).toBeFocused();

  const systemRow = page.locator('.memory-row[data-origin="system"]');
  await expect(systemRow).toContainText('Recipe execution remembered');
  const forget = systemRow.getByRole('button', {
    name: 'Forget memory Recipe execution remembered (memory-system-1)',
    exact: true,
  });
  await forget.focus();
  await page.keyboard.press('Enter');
  const forgetConfirm = systemRow.locator(
    'button[data-recued-data-action="memory-delete-confirm"]',
  );
  await expect(forgetConfirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(forgetConfirm).toHaveText('Forgetting…');
  await expect(forgetConfirm).toBeFocused();
  await expect(systemRow).toHaveClass(/is-redacted/);
  await expect(systemRow).toContainText('Redacted');
  await expect(add).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.delete')),
  ).toBe(2);
});

test('Data keeps a failed Memory Delete retryable and focused', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=memory-rows&memory_delete_response=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));

  const row = page.locator('.memory-row').filter({ hasText: 'Concise answers' });
  await row.getByRole('button', {
    name: 'Delete memory Concise answers (memory-own-1)',
    exact: true,
  }).click();
  const confirm = row.locator(
    'button[data-recued-data-action="memory-delete-confirm"]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Deleting…');
  await expect(confirm).toBeFocused();

  await expect(row.getByRole('alert')).toHaveText(
    'Memory delete temporarily unavailable.',
  );
  await expect(confirm).toHaveText('Confirm');
  await expect(confirm).toBeFocused();
  await expect(row).toContainText('Concise answers');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.delete')),
  ).toBe(1);

  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Deleting…');
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add memory', exact: true }))
    .toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.delete')),
  ).toBe(2);
});

test('Data owns Memory detail loading and returns Back to the exact row', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=memory-rows&memory_get_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));

  const row = page.locator('.memory-row').filter({ hasText: 'Concise answers' });
  const view = row.getByRole('button', {
    name: 'View memory Concise answers (memory-own-1)',
    exact: true,
  });
  await view.focus();
  await page.keyboard.press('Enter');
  const detail = page.getByRole('region', { name: 'Memory detail' });
  const heading = detail.locator(`[${DATA_MEMORY_DETAIL_HEADING}]`);
  await expect(detail).toContainText('Loading memory…');
  await expect(heading).toBeFocused();

  await detail.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(view).toBeFocused();
  await page.waitForTimeout(850);
  await expect(detail).toHaveCount(0);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.get')),
  ).toBe(1);

  await page.keyboard.press('Enter');
  await expect(detail).toContainText('Loading memory…');
  await expect(heading).toBeFocused();
  await expect(detail).toContainText('Keep answers concise and direct.');
  await expect(heading).toBeFocused();
  await detail.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(view).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.get')),
  ).toBe(2);
});

test('Data preserves outside-actor Memory provenance from list through detail', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=memory-rows&memory_provenance=1#data/memory`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const ownRow = page.locator('.memory-row[data-origin="user_self"]');
  const agentRow = page.locator('.memory-row[data-origin="contracted_user"]');
  await expect(agentRow).toContainText('Agent-authored operating note');
  await expect(ownRow.locator(`[${SHARED_PROVENANCE_DETAIL}]`)).toHaveCount(0);

  const provenance = agentRow.locator(`[${SHARED_PROVENANCE}]`);
  await expect(provenance).toHaveAttribute('data-kind', 'agent');
  await expect(provenance.locator(`[${SHARED_PROVENANCE_PRIMARY}]`))
    .toHaveText('Agent');
  await expect(provenance.locator(`[${SHARED_PROVENANCE_DETAIL}]`)).toHaveText(
    'agent browser-agent, under contract browser-contract, asserted this',
  );

  await agentRow.getByRole('button', {
    name: 'View memory Agent-authored operating note (memory-agent-1)',
    exact: true,
  }).click();
  const detail = page.getByRole('region', { name: 'Memory detail' });
  await expect(detail).toContainText('Use the verified provider record.');
  await expect(detail.locator(`[${SHARED_PROVENANCE}]`))
    .toHaveAttribute('data-kind', 'agent');
  await expect(detail.locator(`[${SHARED_PROVENANCE_DETAIL}]`)).toHaveText(
    'agent browser-agent, under contract browser-contract, asserted this',
  );
});

test('Data keeps a failed Memory detail owned through a successful retry', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=memory-rows&memory_get_response=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));

  const row = page.locator('.memory-row').filter({ hasText: 'Concise answers' });
  const view = row.getByRole('button', {
    name: 'View memory Concise answers (memory-own-1)',
    exact: true,
  });
  await view.click();
  const detail = page.getByRole('region', { name: 'Memory detail' });
  const heading = detail.locator(`[${DATA_MEMORY_DETAIL_HEADING}]`);
  await expect(heading).toBeFocused();
  await expect(detail.getByRole('alert')).toHaveText(
    'Memory entry temporarily unavailable.',
  );
  await expect(heading).toBeFocused();

  await detail.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(view).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(heading).toBeFocused();
  await expect(detail).toContainText('Keep answers concise and direct.');
  await expect(heading).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.get')),
  ).toBe(2);
});

test('Data owns Memory Edit prefill and keeps it single-flight', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=memory-rows&memory_get_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));

  const row = page.locator('.memory-row').filter({ hasText: 'Concise answers' });
  const edit = row.locator(
    'button[data-recued-data-action="memory-edit"]',
  );
  const remove = row.locator(
    'button[data-recued-data-action="memory-delete"]',
  );
  await edit.focus();
  await page.keyboard.press('Enter');
  await expect(edit).toHaveText('Opening…');
  await expect(edit).toHaveAttribute('aria-disabled', 'true');
  await expect(edit).toHaveAttribute('aria-busy', 'true');
  await expect(edit).not.toHaveAttribute('disabled');
  await expect(edit).toBeFocused();
  await expect(remove).toHaveAttribute('aria-disabled', 'true');

  await page.keyboard.press('Enter');
  await remove.dispatchEvent('click');
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Memory', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(edit).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.get')),
  ).toBe(1);

  const form = page.getByRole('form', { name: 'Edit memory' });
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Kind')).toHaveValue('preference');
  await expect(form.getByLabel('Body')).toHaveValue(
    'Keep answers concise and direct.',
  );
  await expect(form.getByLabel('Kind')).toBeFocused();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(edit).toHaveText('Edit');
  await expect(edit).toBeFocused();
});

test('Data keeps a failed Memory Edit prefill local and retryable', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=memory-rows&memory_get_response=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));

  const row = page.locator('.memory-row').filter({ hasText: 'Concise answers' });
  const edit = row.locator(
    'button[data-recued-data-action="memory-edit"]',
  );
  await edit.click();
  await expect(edit).toHaveText('Opening…');
  await expect(edit).toBeFocused();
  await expect(row.getByRole('alert')).toHaveText(
    'Memory entry temporarily unavailable.',
  );
  await expect(edit).toHaveText('Edit');
  await expect(edit).toBeFocused();
  await expect(row).toContainText('Concise answers');

  await page.keyboard.press('Enter');
  await expect(edit).toHaveText('Opening…');
  const form = page.getByRole('form', { name: 'Edit memory' });
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Kind')).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.get')),
  ).toBe(2);
});

test('Data gives every visible Memory control full mobile targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=memory-rows#data/memory`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const memory = page.getByRole('region', { name: 'Memory', exact: true });
  await expect(memory.getByRole('heading', {
    name: 'Memory',
    level: 2,
  })).toBeVisible();

  const controls = page.locator(
    '.memory-filter-chip, .memory-row-foot button, .memory-row-foot a',
  );
  const heights = await controls.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height)
  );
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(36);

  const lens = page.locator('[data-recued-memory-lens]');
  expect(await lens.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);

  await page.locator('[data-recued-data-action="memory-add"]').click();
  const compose = page.getByRole('form', { name: 'New memory' });
  await expect(compose).toBeVisible();
  await expect(compose.getByRole('heading', {
    name: 'New memory',
    level: 3,
  })).toBeVisible();
  const composeHeights = await compose.locator(
    'button, input, textarea',
  ).evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height)
  );
  expect(Math.min(...composeHeights)).toBeGreaterThanOrEqual(36);
  await compose.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.locator('[data-recued-data-action="memory-import"]').click();
  const importForm = page.getByRole('form', { name: 'Import memory' });
  await expect(importForm).toBeVisible();
  await expect(importForm.getByRole('heading', {
    name: 'Import memory',
    level: 3,
  })).toBeVisible();
  const importHeights = await importForm.locator(
    'button, textarea',
  ).evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height)
  );
  expect(Math.min(...importHeights)).toBeGreaterThanOrEqual(36);
  await importForm.getByRole('button', { name: 'Close', exact: true }).click();

  await page.locator(
    '[data-recued-data-action="memory-open"][data-memory-id="memory-own-1"]',
  ).click();
  const detail = page.getByRole('region', { name: 'Memory detail' });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', {
    name: 'Memory detail',
    level: 3,
  })).toBeVisible();
  const detailHeights = await detail.locator('button').evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().height)
  );
  expect(Math.min(...detailHeights)).toBeGreaterThanOrEqual(36);
});

test('Data contains long Memory content and controls on a narrow phone', async ({ page }) => {
  const longOwnId = `memory-${'identifier'.repeat(30)}`;
  const longOwnKind = `preference_${'kind'.repeat(24)}`;
  const longOwnSummary = `summary-${'identity'.repeat(24)}`;
  const longOwnPreview = `preview-${'provider'.repeat(28)}`;
  const longOwnBody = `body-${'provider'.repeat(40)}`;
  const longSystemKind = `run_${'kind'.repeat(24)}`;
  const longSystemSummary = `remembered-${'execution'.repeat(26)}`;
  const longGetError = `memory-${'unavailable'.repeat(28)}`;
  const longDeleteError = `delete-${'unavailable'.repeat(28)}`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=memory-rows&memory_text=long`
      + '&memory_get_response=fail-once-slow-retry'
      + '&memory_delete_response=fail-once-slow-retry#data/memory',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-data-route]');
  const expectRouteContained = async (): Promise<void> => {
    expect(await route.evaluate((node) => (
      node.scrollWidth <= node.clientWidth
    ))).toBe(true);
  };
  const expectViewportBounds = async (selector: string): Promise<void> => {
    const bounds = await page.locator(selector).evaluateAll((elements) => (
      elements.map((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
      }))
    ));
    expect(bounds.length).toBeGreaterThan(0);
    for (const bound of bounds) {
      expect(bound.left).toBeGreaterThanOrEqual(-0.5);
      expect(bound.right).toBeLessThanOrEqual(280.5);
    }
  };

  const ownRow = page.locator('.memory-row[data-origin="user_self"]');
  const systemRow = page.locator('.memory-row[data-origin="system"]');
  await expect(ownRow.locator('.memory-row-kind')).toHaveText(longOwnKind);
  await expect(ownRow.locator('.memory-row-title')).toHaveText(longOwnSummary);
  await expect(ownRow.locator('.memory-row-preview'))
    .toHaveText(longOwnPreview);
  await expect(systemRow.locator('.memory-row-kind'))
    .toHaveText(longSystemKind);
  await expect(systemRow.locator('.memory-row-title'))
    .toHaveText(longSystemSummary);
  const controlsGeometry = await page.locator(
    '.memory-filter-chips, .memory-lens-actions',
  ).evaluateAll((elements) => elements.map((element) => ({
    top: element.getBoundingClientRect().top,
    bottom: element.getBoundingClientRect().bottom,
  })));
  expect(controlsGeometry).toHaveLength(2);
  expect(controlsGeometry[1]!.top)
    .toBeGreaterThanOrEqual(controlsGeometry[0]!.bottom);
  await expectRouteContained();
  await expectViewportBounds(
    '.memory-lens-controls, .memory-filter-chips, .memory-lens-actions,'
      + ' .memory-row, .memory-row-head, .memory-row-title,'
      + ' .memory-row-preview',
  );

  const view = ownRow.locator('[data-recued-data-action="memory-open"]');
  await expect(view).toHaveAttribute('data-memory-id', longOwnId);
  await view.click();
  let detail = page.getByRole('region', { name: 'Memory detail' });
  await expect(detail.getByRole('alert')).toHaveText(longGetError);
  await expectRouteContained();
  await expectViewportBounds('.memory-detail, .memory-lens-error');

  await detail.getByRole('button', { name: '← Back', exact: true }).click();
  await view.click();
  detail = page.getByRole('region', { name: 'Memory detail' });
  await expect(detail.locator('.memory-row-kind')).toHaveText(longOwnKind);
  await expect(detail.locator('.memory-detail-summary'))
    .toHaveText(longOwnSummary);
  await expect(detail.locator('.memory-detail-body')).toHaveText(longOwnBody);
  await expectRouteContained();
  await expectViewportBounds(
    '.memory-detail, .memory-detail-head, .memory-row-kind,'
      + ' .memory-detail-summary, .memory-detail-body,'
      + ' .memory-detail-actions',
  );
  expect(await detail.locator('.memory-detail-body').evaluate((node) => (
    node.scrollWidth <= node.clientWidth
  ))).toBe(true);

  await detail.getByRole('button', { name: '← Back', exact: true }).click();
  await ownRow.locator('[data-recued-data-action="memory-delete"]').click();
  const confirm = ownRow.locator(
    '[data-recued-data-action="memory-delete-confirm"]',
  );
  await confirm.click();
  await expect(ownRow.getByRole('alert')).toHaveText(longDeleteError);
  await expectRouteContained();
  await expectViewportBounds(
    '.memory-row-confirm, .memory-row-delete-error,'
      + ' [data-recued-data-action="memory-delete-confirm"],'
      + ' [data-recued-data-action="memory-delete-cancel"]',
  );
  await ownRow.locator(
    '[data-recued-data-action="memory-delete-cancel"]',
  ).click();

  await page.locator('[data-recued-data-action="memory-add"]').click();
  const compose = page.getByRole('form', { name: 'New memory' });
  await compose.getByLabel('Kind').fill(longOwnKind);
  await compose.getByLabel('Summary').fill(longOwnSummary);
  await compose.getByLabel('Body').fill(longOwnBody);
  await expectRouteContained();
  await expectViewportBounds(
    '.memory-compose, .memory-compose-editor, .memory-field,'
      + ' .memory-input, .memory-textarea, .memory-compose-actions',
  );
  await compose.getByRole('button', { name: 'Cancel', exact: true }).click();
  const composeGuard = page.getByRole('alertdialog', {
    name: 'Discard your memory changes?',
  });
  await expect(composeGuard).toBeVisible();
  await expectRouteContained();
  await expectViewportBounds(
    '[data-recued-memory-compose-discard-guard],'
      + ' .memory-compose-discard-actions',
  );
  await composeGuard.getByRole('button', {
    name: 'Discard changes',
    exact: true,
  }).click();

  await page.locator('[data-recued-data-action="memory-import"]').click();
  const importForm = page.getByRole('form', { name: 'Import memory' });
  await importForm.getByLabel('JSON').fill(JSON.stringify([{
    kind: longOwnKind,
    summary: longOwnSummary,
    body: longOwnBody,
  }]));
  await expectRouteContained();
  await expectViewportBounds(
    '.memory-import-editor, .memory-field-hint, .memory-textarea,'
      + ' .memory-compose-actions',
  );
  await importForm.getByRole('button', { name: 'Close', exact: true }).click();
  const importGuard = page.getByRole('alertdialog', {
    name: 'Discard this import draft?',
  });
  await expect(importGuard).toBeVisible();
  await expectRouteContained();
  await expectViewportBounds(
    '[data-recued-memory-import-discard-guard],'
      + ' .memory-import-discard-actions',
  );
});

test('Data keeps Memory Export visible, focused, and single-flight', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=memory-rows&memory_get_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));

  const exportButton = page.locator(
    'button[data-recued-data-action="memory-export"]',
  );
  const importButton = page.locator(
    'button[data-recued-data-action="memory-import"]',
  );
  const addButton = page.locator(
    'button[data-recued-data-action="memory-add"]',
  );
  const dataLens = page.getByRole('button', { name: 'Data', exact: true });
  const memoryLens = page.getByRole('button', { name: 'Memory', exact: true });
  const allFilter = page.getByRole('button', { name: 'All', exact: true });
  const youFilter = page.getByRole('button', { name: 'You', exact: true });
  const openRun = page.getByRole('link', {
    name: 'Open run for memory Recipe execution remembered (memory-system-1)',
    exact: true,
  });
  const download = page.waitForEvent('download');

  await exportButton.focus();
  await page.keyboard.press('Enter');
  await Promise.all([
    expect(exportButton).toHaveText('Exporting…'),
    expect(exportButton).toHaveAttribute('aria-disabled', 'true'),
    expect(exportButton).toHaveAttribute('aria-busy', 'true'),
    expect(exportButton).not.toHaveAttribute('disabled'),
    expect(exportButton).toBeFocused(),
    expect(importButton).toHaveAttribute('aria-disabled', 'true'),
    expect(addButton).toHaveAttribute('aria-disabled', 'true'),
    expect(dataLens).toHaveAttribute('aria-disabled', 'true'),
    expect(memoryLens).toHaveAttribute('aria-disabled', 'true'),
    expect(allFilter).toHaveAttribute('aria-disabled', 'true'),
    expect(youFilter).toHaveAttribute('aria-disabled', 'true'),
    expect(openRun).toHaveAttribute('aria-disabled', 'true'),
  ]);

  await page.keyboard.press('Enter');
  await importButton.dispatchEvent('click');
  await addButton.dispatchEvent('click');
  await dataLens.dispatchEvent('click');
  await youFilter.dispatchEvent('click');
  await openRun.dispatchEvent('click');
  await expect(page).toHaveURL(/#data\/memory$/);
  await expect(memoryLens).toHaveAttribute('aria-pressed', 'true');
  await expect(allFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(exportButton).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.list')),
  ).toBe(2);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.get')),
  ).toBe(1);

  expect((await download).suggestedFilename()).toMatch(
    /^recued-memory-\d{4}-\d{2}-\d{2}\.json$/,
  );
  await expect(exportButton).toHaveText('Export');
  await expect(exportButton).not.toHaveAttribute('aria-busy');
  await expect(exportButton).toBeFocused();
});

test('Data keeps a failed Memory Export focused and retryable', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=memory-rows&memory_list_response=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));

  const exportButton = page.locator(
    'button[data-recued-data-action="memory-export"]',
  );
  await exportButton.focus();
  await page.keyboard.press('Enter');
  await expect(exportButton).toHaveText('Exporting…');
  await expect(exportButton).toBeFocused();

  await expect(page.getByRole('alert')).toHaveText(
    'Memory export temporarily unavailable.',
  );
  await expect(exportButton).toHaveText('Export');
  await expect(exportButton).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.list')),
  ).toBe(2);

  const download = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  await expect(exportButton).toHaveText('Exporting…');
  await expect(exportButton).toBeFocused();
  expect((await download).suggestedFilename()).toMatch(
    /^recued-memory-\d{4}-\d{2}-\d{2}\.json$/,
  );
  await expect(exportButton).toHaveText('Export');
  await expect(exportButton).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.list')),
  ).toBe(3);
});

test('Data owns Memory origin filtering and withholds stale rows', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=memory-rows&memory_list_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));
  await expect(page.locator('.memory-row')).toHaveCount(2);

  const filter = (value: string) => page.locator(
    `button[data-recued-data-action="memory-filter"][data-memory-filter="${value}"]`,
  );
  const all = filter('all');
  const you = filter('user_self');
  const system = filter('system');
  const exportButton = page.locator(
    'button[data-recued-data-action="memory-export"]',
  );
  const addButton = page.locator(
    'button[data-recued-data-action="memory-add"]',
  );
  const dataLens = page.getByRole('button', { name: 'Data', exact: true });
  const memoryLens = page.getByRole('button', { name: 'Memory', exact: true });

  await you.focus();
  await page.keyboard.press('Enter');
  await Promise.all([
    expect(you).toHaveText('You…'),
    expect(you).toHaveAttribute('aria-pressed', 'true'),
    expect(you).toHaveAttribute('aria-disabled', 'true'),
    expect(you).toHaveAttribute('aria-busy', 'true'),
    expect(you).toBeFocused(),
    expect(all).toHaveAttribute('aria-disabled', 'true'),
    expect(system).toHaveAttribute('aria-disabled', 'true'),
    expect(exportButton).toHaveAttribute('aria-disabled', 'true'),
    expect(addButton).toHaveAttribute('aria-disabled', 'true'),
    expect(dataLens).toHaveAttribute('aria-disabled', 'true'),
    expect(memoryLens).toHaveAttribute('aria-disabled', 'true'),
    expect(page.getByText('Loading memory…', { exact: true })).toBeVisible(),
    expect(page.locator('.memory-row')).toHaveCount(0),
  ]);

  await page.keyboard.press('Enter');
  await system.dispatchEvent('click');
  await exportButton.dispatchEvent('click');
  await addButton.dispatchEvent('click');
  await dataLens.dispatchEvent('click');
  await expect(memoryLens).toHaveAttribute('aria-pressed', 'true');
  await expect(you).toHaveAttribute('aria-pressed', 'true');
  await expect(you).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.list')),
  ).toBe(2);

  await expect(you).toHaveText('You');
  await expect(you).not.toHaveAttribute('aria-busy');
  await expect(you).not.toHaveAttribute('aria-disabled');
  await expect(you).toBeFocused();
  await expect(page.locator('.memory-row')).toHaveCount(1);
  await expect(page.locator('.memory-row')).toContainText('Concise answers');
  await expect(page.locator('.memory-row')).not.toContainText(
    'Recipe execution remembered',
  );
});

test('Data retries the selected Memory origin after a failed refresh', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=memory-rows&memory_list_response=filter-fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/memory'));
  await expect(page.locator('.memory-row')).toHaveCount(2);

  const you = page.locator(
    'button[data-recued-data-action="memory-filter"][data-memory-filter="user_self"]',
  );
  await you.focus();
  await page.keyboard.press('Enter');
  await expect(you).toHaveText('You…');
  await expect(you).toBeFocused();
  await expect(page.getByRole('alert')).toHaveText(
    'Memory filter temporarily unavailable.',
  );
  await expect(you).toHaveText('You');
  await expect(you).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.list')),
  ).toBe(2);

  await page.keyboard.press('Enter');
  await expect(you).toHaveText('You…');
  await expect(you).toBeFocused();
  await expect(page.locator('.memory-row')).toHaveCount(1);
  await expect(page.locator('.memory-row')).toContainText('Concise answers');
  await expect(you).toHaveText('You');
  await expect(you).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('memory.list')),
  ).toBe(3);
});

test('Data gives every visible Records control a mobile-sized target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=records`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/records'));
  await expect(page.getByRole('button', {
    name: 'Open record job-1',
    exact: true,
  })).toBeVisible();
  await expect(page.getByRole('region', {
    name: 'Record contents',
  })).toBeVisible();
  await expect(page.locator(
    '[data-recued-webclient-content] main',
  )).toHaveCount(0);

  const controls = page.locator(
    '.records-explorer button:visible, .records-explorer summary:visible, .records-explorer input:visible',
  );
  const targets = await controls.evaluateAll((elements) => elements.map((element) => ({
    name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
    height: element.getBoundingClientRect().height,
  })));
  expect(targets.length).toBeGreaterThan(0);
  expect(targets.filter((target) => target.height < 36)).toEqual([]);

  const records = page.locator('.records-explorer');
  expect(await records.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test('Data contains long Records identities and diagnostics on a narrow phone', async ({ page }) => {
  const longPublisher = `publisher-${'identity'.repeat(10)}`;
  const longPack = `pack-${'identifier'.repeat(10)}`;
  const longKind = `entity_${'kind'.repeat(18)}`;
  const longField = `field_${'identifier'.repeat(18)}`;
  const longRecordId = `record-${'identifier'.repeat(30)}`;
  const longSourceId = `source-${'identifier'.repeat(30)}`;
  const longTitle = `title-${'value'.repeat(40)}`;
  const longRelationshipField = `relationship_${'field'.repeat(28)}`;
  const longEventType = `record.${'delivery'.repeat(24)}`;
  const longDeliveryRecipe = `recipe-${'identifier'.repeat(28)}`;
  const longDeliveryError = `delivery-${'failure'.repeat(32)}`;
  const longPackRef = `${longPublisher}/${longPack}`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=records&records_text=long#data/records`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-data-route]');
  const expectRouteContained = async (): Promise<void> => {
    expect(await route.evaluate((node) => (
      node.scrollWidth <= node.clientWidth
    ))).toBe(true);
  };
  const expectViewportBounds = async (selector: string): Promise<void> => {
    const bounds = await page.locator(selector).evaluateAll((elements) => (
      elements.map((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
      }))
    ));
    for (const bound of bounds) {
      expect(bound.left).toBeGreaterThanOrEqual(-0.5);
      expect(bound.right).toBeLessThanOrEqual(280.5);
    }
  };

  // The pack by its name and publisher; the kind and field read as words. The identities
  // themselves stay in the data attributes, the record header and the purge confirmation.
  const longPackName = `Pack ${'Identifier'.repeat(10)}`;
  const namespace = page.locator('.records-namespace');
  await expect(namespace.locator('strong')).toHaveText(longPackName);
  await expect(namespace.locator('span')).toHaveText(`by ${longPublisher}`);
  await expect(page.locator('.records-pack-summary h3')).toHaveText(longPackName);
  await expect(page.locator('[data-action="records-select-kind"]'))
    .toContainText(`Entity ${'kind'.repeat(18)}`);
  await expect(page.locator(`td[data-field="${longField}"]`))
    .toHaveText(longTitle);
  await expect(page.locator('td[data-field="id"]')).toHaveText(longRecordId);
  await expectRouteContained();
  await expectViewportBounds(
    '.records-explorer, .records-namespace, .records-pack-summary,'
      + ' .records-kind-nav button, .records-table-scroll',
  );
  const tableScroll = page.locator('.records-table-scroll');
  expect(await tableScroll.evaluate((node) => (
    node.scrollWidth > node.clientWidth
  ))).toBe(true);

  await page.locator('.records-outbox > summary').click();
  const event = page.locator('.records-outbox-events > li');
  await expect(event.locator('strong')).toHaveText(longEventType);
  await expect(event.getByRole('alert')).toHaveText(longDeliveryError);
  await event.locator('details > summary').click();
  await expect(event.locator('code')).toHaveText(longDeliveryRecipe);
  await expect(event).toContainText(longDeliveryError);
  await expectRouteContained();
  await expectViewportBounds(
    '.records-outbox, .records-outbox > summary, .records-outbox-events > li,'
      + ' .records-outbox-events strong, .records-outbox-events .records-ref-link,'
      + ' .records-outbox-events details, .records-outbox-events code',
  );

  await page.locator('.records-row-open').click();
  const detail = page.locator('.records-detail');
  await expect(page.locator('#records-detail-title')).toHaveText(longRecordId);
  await expect(detail.locator('header small')).toContainText(longPackRef);
  const longFieldLabel = `Field ${'identifier'.repeat(18)}`;
  await expect(detail.locator('dt').filter({ hasText: longFieldLabel }))
    .toHaveText(longFieldLabel);
  await expect(detail.locator('dd').filter({ hasText: longTitle }))
    .toHaveText(longTitle);
  await expect(detail.locator('.records-relationship-impact .records-ref-link'))
    .toContainText(longSourceId);
  await expect(detail.locator('.records-relationship-impact code'))
    .toHaveText(longRelationshipField);
  await detail.locator(':scope > details > summary').click();
  const diagnostics = detail.locator(':scope > details > pre');
  await expect(diagnostics).toContainText(longRecordId);
  await detail.getByRole('button', { name: 'Delete record…' }).click();
  await expect(detail.locator('.records-delete-confirm')).toBeVisible();
  await expectRouteContained();
  await expectViewportBounds(
    '.records-detail, .records-detail header, #records-detail-title,'
      + ' .records-detail dl, .records-detail dl > div,'
      + ' .records-relationship-impact, .records-detail > details,'
      + ' .records-detail > details > pre, .records-delete-confirm',
  );
  expect(await diagnostics.evaluate((node) => (
    node.scrollWidth > node.clientWidth
  ))).toBe(true);

  await page.goto(
    `${HARNESS_URL}?data=records-orphaned&records_text=long#data/records`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-action="records-purge"]').click();
  const purge = page.locator('.records-purge-confirm');
  await expect(purge.locator('strong')).toHaveText(longPackRef);
  await expect(purge.locator('input')).toHaveAttribute(
    'placeholder',
    longPackRef,
  );
  await expectRouteContained();
  await expectViewportBounds(
    '.records-purge-confirm, .records-purge-confirm label,'
      + ' .records-purge-confirm input',
  );
});

test('Data opens Records with the keyboard and returns focus to the exact row', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?data=records`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/records'));

  const record = page.getByRole('button', {
    name: 'Open record job-1',
    exact: true,
  });
  await expect(record).toBeVisible();
  await record.focus();
  await page.keyboard.press('Enter');

  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('records.get')),
  ).toBe(1);
  const heading = page.locator('#records-detail-title');
  await expect(heading).toHaveText('job-1');
  await expect(heading).toBeFocused();

  const back = page.locator('[data-action="records-close-record"]');
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(record).toBeVisible();
  await expect(record).toBeFocused();
});

test('Data keeps a Records delete owned and reconciles its list once', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=records&records_delete_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/records'));

  const record = page.getByRole('button', {
    name: 'Open record job-1',
    exact: true,
  });
  await record.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#records-detail-title')).toBeFocused();

  const request = page.locator('[data-action="records-delete-record"]');
  await request.focus();
  await page.keyboard.press('Enter');
  const confirm = page.locator('[data-action="records-confirm-delete"]');
  const cancel = page.locator('[data-action="records-cancel-delete"]');
  const back = page.locator('[data-action="records-close-record"]');
  const namespace = page.locator(
    '[data-action="records-select-namespace"][data-records-namespace="publisher-a/same-board"]',
  );
  const kind = page.locator(
    '[data-action="records-select-kind"][data-records-kind="job"]',
  );
  const reference = page.locator(
    '[data-action="records-open-reference"][data-records-id="job-0"]',
  );
  await expect(reference).toHaveAttribute(SHARED_REFERENCE, 'action');
  await expect(reference).toHaveAttribute(SHARED_REFERENCE_ID, 'job/job-0');
  const outbox = page.locator('.records-outbox');
  const outboxSummary = outbox.locator('summary');
  const outboxRefresh = page.locator('[data-action="records-refresh-outbox"]');
  const retire = page.locator('[data-action="records-retire-event"]');
  const contactTab = page.locator(
    '[data-recued-data-route-tab="contact"]',
  );
  const memoryLens = page.locator('[data-memory-lens="memory"]');
  await expect(confirm).toHaveText('Delete record');
  await expect(confirm).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Deleting…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await expect(cancel).not.toHaveAttribute('disabled');
  await expect(back).toHaveAttribute('aria-disabled', 'true');
  await expect(namespace).toHaveAttribute('aria-disabled', 'true');
  await expect(kind).toHaveAttribute('aria-disabled', 'true');
  await expect(reference).toHaveAttribute('aria-disabled', 'true');
  await expect(outboxSummary).toHaveAttribute('aria-disabled', 'true');
  await expect(outboxRefresh).toHaveAttribute('aria-disabled', 'true');
  await expect(retire).toHaveAttribute('aria-disabled', 'true');
  await expect(contactTab).toHaveAttribute('aria-disabled', 'true');
  await expect(memoryLens).toHaveAttribute('aria-disabled', 'true');

  await confirm.dispatchEvent('click');
  await confirm.dispatchEvent('click');
  await cancel.dispatchEvent('click');
  await back.dispatchEvent('click');
  await namespace.dispatchEvent('click');
  await kind.dispatchEvent('click');
  await reference.dispatchEvent('click');
  await outboxSummary.dispatchEvent('click');
  await outboxRefresh.dispatchEvent('click');
  await retire.dispatchEvent('click');
  await contactTab.dispatchEvent('click');
  await memoryLens.dispatchEvent('click');
  await expect(page.locator('#records-detail-title')).toHaveText('job-1');
  await expect(outbox).not.toHaveAttribute('open');
  await expect(memoryLens).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('records.delete')),
  ).toBe(1);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    window.__app.setHash('#packs');
  });
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening in Records. Leave Data anyway?',
  );
  await expect(page).toHaveURL(/#data\/records$/);
  await expect(confirm).toBeFocused();

  await expect(page.getByText('No records in this kind.')).toBeVisible();
  await expect(record).toHaveCount(0);
  await expect(kind).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('records.namespace.list')),
  ).toBe(2);

  await page.evaluate(() => window.__app.setHash('#packs'));
  await expect(page).toHaveURL(/#packs$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Data keeps Records exports focused and single-flight', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=records&records_export_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/records'));

  const cases = [
    {
      action: 'records-export-pack',
      label: 'Export pack JSON',
      filename: 'publisher-a-same-board-records.json',
    },
    {
      action: 'records-export-kind-csv',
      label: 'Export kind CSV',
      filename: 'publisher-a-same-board-job-records.csv',
    },
  ] as const;
  const exports = page.locator('[data-action^="records-export-"]');
  await expect(exports).toHaveCount(4);
  let calls = await page.evaluate(
    () => window.__app.rpcCallCount('records.export'),
  );

  for (const candidate of cases) {
    const owner = page.locator(`[data-action="${candidate.action}"]`);
    const download = page.waitForEvent('download');
    await owner.focus();
    await page.keyboard.press('Enter');

    await expect(owner).toHaveText('Exporting…');
    await expect(owner).toHaveAttribute('aria-disabled', 'true');
    await expect(owner).toHaveAttribute('aria-busy', 'true');
    await expect(owner).not.toHaveAttribute('disabled');
    await expect(owner).toBeFocused();
    for (let index = 0; index < 4; index += 1) {
      const button = exports.nth(index);
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).not.toHaveAttribute('disabled');
      if (await button.getAttribute('data-action') !== candidate.action) {
        await expect(button).not.toHaveAttribute('aria-busy');
      }
    }

    await owner.dispatchEvent('click');
    await owner.dispatchEvent('click');
    await exports.nth(1).dispatchEvent('click');
    await expect.poll(
      () => page.evaluate(() => window.__app.rpcCallCount('records.export')),
    ).toBe(calls + 1);

    expect((await download).suggestedFilename()).toBe(candidate.filename);
    await expect(owner).toHaveText(candidate.label);
    await expect(owner).not.toHaveAttribute('aria-disabled');
    await expect(owner).not.toHaveAttribute('aria-busy');
    await expect(owner).toBeFocused();
    calls += 1;
  }
});

test('Data keeps Records event retirement visible, owned, and single-flight', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=records&records_retire_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/records'));

  const outbox = page.locator('.records-outbox');
  const summary = outbox.locator('summary');
  await expect(outbox).not.toHaveAttribute('open');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(outbox).toHaveAttribute('open', '');
  await expect(summary).toBeFocused();

  const arm = page.locator(
    '[data-action="records-retire-event"][data-records-event-id="event-job-1"]',
  );
  await arm.focus();
  await page.keyboard.press('Enter');
  const confirm = page.locator(
    '[data-action="records-confirm-retire-event"]',
  );
  const cancel = page.locator(
    '[data-action="records-cancel-retire-event"]',
  );
  await expect(outbox).toHaveAttribute('open', '');
  await expect(confirm).toBeFocused();

  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(outbox).toHaveAttribute('open', '');
  await expect(arm).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Retiring…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await expect(summary).toHaveAttribute('aria-disabled', 'true');
  const refresh = page.locator('[data-action="records-refresh-outbox"]');
  const namespace = page.locator('[data-action="records-select-namespace"]');
  const kind = page.locator('[data-action="records-select-kind"]');
  const record = page.getByRole('button', {
    name: 'Open record job-1',
    exact: true,
  });
  await expect(refresh).toHaveAttribute('aria-disabled', 'true');
  await expect(namespace).toHaveAttribute('aria-disabled', 'true');
  await expect(kind).toHaveAttribute('aria-disabled', 'true');
  await expect(record).toHaveAttribute('aria-disabled', 'true');

  await confirm.dispatchEvent('click');
  await confirm.dispatchEvent('click');
  await cancel.dispatchEvent('click');
  await summary.dispatchEvent('click');
  await refresh.dispatchEvent('click');
  await namespace.dispatchEvent('click');
  await kind.dispatchEvent('click');
  await record.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('records.outbox.retire'),
    ),
  ).toBe(1);
  await expect(outbox).toHaveAttribute('open', '');
  await expect(confirm).toBeFocused();

  await expect(summary).toContainText('0 pending · 1 dead-lettered');
  await expect(summary).toBeFocused();
  await expect(outbox.locator('li[data-status="dead_letter"]')).toHaveCount(1);
  await expect(confirm).toHaveCount(0);
  await expect(arm).toHaveCount(0);
  await expect(page.getByText('Loading Records…')).toHaveCount(0);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('records.namespace.list')),
  ).toBe(2);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('records.outbox.list')),
  ).toBe(2);
});

test('Data keeps Records outbox refresh focused and single-flight', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=records&records_outbox_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/records'));

  const outbox = page.locator('.records-outbox');
  const summary = outbox.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  const refresh = page.locator('[data-action="records-refresh-outbox"]');
  await refresh.focus();
  await page.keyboard.press('Enter');

  await expect(refresh).toHaveText('Refreshing…');
  await expect(refresh).toHaveAttribute('aria-disabled', 'true');
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
  await expect(refresh).not.toHaveAttribute('disabled');
  await expect(refresh).toBeFocused();
  await refresh.dispatchEvent('click');
  await refresh.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('records.outbox.list')),
  ).toBe(2);

  await expect(refresh).toHaveText('Check again');
  await expect(refresh).not.toHaveAttribute('aria-disabled');
  await expect(refresh).not.toHaveAttribute('aria-busy');
  await expect(refresh).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(refresh).toHaveText('Refreshing…');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(outbox).not.toHaveAttribute('open');
  await expect(summary).toBeFocused();
  await expect(refresh).toHaveText('Check again');
  await expect(summary).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('records.outbox.list')),
  ).toBe(3);
});

test('Data preserves and owns orphaned Records namespace purge', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=records-orphaned&records_purge_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/records'));

  const arm = page.locator('[data-action="records-purge"]');
  await arm.focus();
  await page.keyboard.press('Enter');
  const input = page.locator('[data-records-purge-confirmation]');
  const confirm = page.locator('[data-action="records-confirm-purge"]');
  const cancel = page.locator('[data-action="records-cancel-purge"]');
  await expect(input).toBeFocused();

  await input.fill('wrong/ref');
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').filter({
    hasText: 'Type publisher-a/same-board exactly to purge this namespace.',
  })).toHaveText('Type publisher-a/same-board exactly to purge this namespace.');
  await expect(input).toHaveValue('wrong/ref');
  await expect(input).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('records.purge')),
  ).toBe(0);

  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(arm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
  await input.fill('publisher-a/same-board');
  await confirm.focus();
  await page.keyboard.press('Enter');

  await expect(confirm).toHaveText('Purging…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await expect(cancel).not.toHaveAttribute('disabled');
  await expect(input).toHaveValue('publisher-a/same-board');
  await expect(input).toHaveAttribute('readonly', '');
  await expect(input).toHaveAttribute('aria-disabled', 'true');
  const namespace = page.locator('[data-action="records-select-namespace"]');
  const kind = page.locator('[data-action="records-select-kind"]');
  const exportPack = page.locator('[data-action="records-export-pack"]');
  const outboxSummary = page.locator('.records-outbox summary');
  await expect(namespace).toHaveAttribute('aria-disabled', 'true');
  await expect(kind).toHaveAttribute('aria-disabled', 'true');
  await expect(exportPack).toHaveAttribute('aria-disabled', 'true');
  await expect(outboxSummary).toHaveAttribute('aria-disabled', 'true');

  await confirm.dispatchEvent('click');
  await confirm.dispatchEvent('click');
  await cancel.dispatchEvent('click');
  await namespace.dispatchEvent('click');
  await kind.dispatchEvent('click');
  await exportPack.dispatchEvent('click');
  await outboxSummary.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('records.purge')),
  ).toBe(1);
  await expect(confirm).toBeFocused();
  await expect(input).toHaveValue('publisher-a/same-board');

  await expect(page.getByText(
    'No pack-owned Records are installed or retained.',
  )).toBeVisible();
  await expect(confirm).toHaveCount(0);
  await expect(arm).toHaveCount(0);
  const recordsTab = page.locator(
    '[data-recued-data-route-tab="records"]',
  );
  await expect(recordsTab).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('records.namespace.list')),
  ).toBe(2);
});

test('Data keeps Records namespace and kind switching focused and single-flight', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=records-navigation&records_navigation_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/records'));

  const namespaceA = page.locator(
    '[data-action="records-select-namespace"][data-records-namespace="publisher-a/same-board"]',
  );
  const namespaceB = page.locator(
    '[data-action="records-select-namespace"][data-records-namespace="publisher-b/same-board"]',
  );
  await expect(page.getByRole('button', {
    name: 'Open record invoice-1',
    exact: true,
  })).toBeVisible();
  const kindReads = await page.evaluate(
    () => window.__app.rpcCallCount('records.kind.list'),
  );

  await namespaceA.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('records.kind.list'),
  )).toBe(kindReads);
  await expect(namespaceA).toBeFocused();

  await namespaceB.focus();
  await page.keyboard.press('Enter');
  await expect(namespaceB).toHaveAttribute('aria-disabled', 'true');
  await expect(namespaceB).toHaveAttribute('aria-busy', 'true');
  await expect(namespaceB).not.toHaveAttribute('disabled');
  await expect(namespaceB).toBeFocused();
  await expect(namespaceA).toHaveAttribute('aria-disabled', 'true');
  await expect(namespaceA).not.toHaveAttribute('aria-busy');
  await namespaceB.dispatchEvent('click');
  await namespaceB.dispatchEvent('click');
  await namespaceA.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('records.kind.list')),
  ).toBe(kindReads + 1);

  await expect(page.getByRole('button', {
    name: 'Open record invoice-1',
    exact: true,
  })).toBeVisible();
  await expect(namespaceB).not.toHaveAttribute('aria-disabled');
  await expect(namespaceB).not.toHaveAttribute('aria-busy');
  await expect(namespaceB).toBeFocused();

  const invoiceKind = page.locator(
    '[data-action="records-select-kind"][data-records-kind="invoice"]',
  );
  const jobKind = page.locator(
    '[data-action="records-select-kind"][data-records-kind="job"]',
  );
  const kindPanel = page.locator('[data-records-kind-panel]');
  await expect(page.getByRole('tablist', { name: 'Record kinds' })).toBeVisible();
  await expect(page.locator(
    '[data-action="records-select-kind"][tabindex="0"]',
  )).toHaveCount(1);
  await expect(invoiceKind).toHaveAttribute('aria-selected', 'true');
  await expect(invoiceKind).toHaveAttribute('tabindex', '0');
  await expect(invoiceKind).toHaveAttribute(
    'aria-controls',
    'recued-records-kind-panel',
  );
  await expect(jobKind).toHaveAttribute('tabindex', '-1');
  await expect(kindPanel).toHaveAttribute(
    'aria-labelledby',
    'recued-records-kind-tab-invoice',
  );
  const searches = await page.evaluate(
    () => window.__app.rpcCallCount('records.search'),
  );
  await invoiceKind.focus();
  await page.keyboard.press('ArrowRight');
  await expect(jobKind).toHaveAttribute('aria-disabled', 'true');
  await expect(jobKind).toHaveAttribute('aria-busy', 'true');
  await expect(jobKind).not.toHaveAttribute('disabled');
  await expect(jobKind).toHaveAttribute('aria-selected', 'true');
  await expect(jobKind).toHaveAttribute('tabindex', '0');
  await expect(invoiceKind).toHaveAttribute('tabindex', '-1');
  await expect(jobKind).toBeFocused();
  await expect(invoiceKind).toHaveAttribute('aria-disabled', 'true');
  await expect(invoiceKind).not.toHaveAttribute('aria-busy');
  await jobKind.dispatchEvent('click');
  await jobKind.dispatchEvent('click');
  await invoiceKind.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('records.search')),
  ).toBe(searches + 1);

  await expect(page.getByRole('button', {
    name: 'Open record job-b',
    exact: true,
  })).toBeVisible();
  await expect(jobKind).not.toHaveAttribute('aria-disabled');
  await expect(jobKind).not.toHaveAttribute('aria-busy');
  await expect(jobKind).toBeFocused();
  await expect(kindPanel).toHaveAttribute(
    'aria-labelledby',
    'recued-records-kind-tab-job',
  );
  await expect(page.locator(
    '[data-action="records-select-kind"][tabindex="0"]',
  )).toHaveCount(1);

  const settledSearches = await page.evaluate(
    () => window.__app.rpcCallCount('records.search'),
  );
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('records.search'),
  )).toBe(settledSearches);
  await expect(jobKind).toBeFocused();
});

test('Data keeps the CRM timeline trigger focused through its load', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?data=timeline`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/crm'));

  const entity = page.getByRole('textbox', { name: 'Entity' });
  await entity.fill('crm-1');
  const open = page.locator(
    'button[data-recued-data-action="load-timeline"]',
  );
  await open.focus();
  await expect(open).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  await Promise.all([
    expect(open).toHaveText('Loading…'),
    expect(open).toHaveAttribute('aria-disabled', 'true'),
    expect(open).toHaveAttribute('aria-busy', 'true'),
    expect(open).not.toHaveAttribute('disabled'),
    expect(open).toBeFocused(),
  ]);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('data.timeline')),
  ).toBe(1);

  await entity.focus();
  await entity.evaluate((input: HTMLInputElement) => {
    input.setSelectionRange(input.value.length, input.value.length);
  });
  await page.keyboard.type('2');
  await expect(entity).toHaveValue('crm-12');
  await expect(entity).toBeFocused();
  await expect(open).toHaveText('Open timeline');
  await expect(open).not.toHaveAttribute('aria-disabled');
  await expect(open).not.toHaveAttribute('aria-busy');

  await open.focus();
  await page.keyboard.press('Enter');
  await expect(open).toHaveText('Loading…');
  await expect(open).toBeFocused();

  await expect(open).toHaveText('Open timeline');
  await expect(open).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('data.timeline')),
  ).toBe(2);
});

test('Data renders outside-actor provenance in the CRM timeline', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?data=timeline&reference_provenance=1#data/crm`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.getByRole('textbox', { name: 'Entity' }).fill('crm-1');
  await page.getByRole('button', { name: 'Open timeline' }).click();

  const entry = page.locator('.memory-timeline-entry');
  await expect(entry).toHaveAttribute('data-source', 'memory');
  const provenance = entry.locator(`[${SHARED_PROVENANCE}]`);
  await expect(provenance).toHaveAttribute('data-kind', 'agent');
  await expect(provenance.locator(`[${SHARED_PROVENANCE_PRIMARY}]`)).toHaveText(
    'agent browser-agent, under contract browser-contract, asserted this',
  );
  await expect(provenance.locator(`[${SHARED_PROVENANCE_DETAIL}]`))
    .toHaveCount(0);
});

test('Data keeps file download visible, focused, and single-flight', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?data=file-download`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/files'));

  const record = page.locator(
    `[${DATA_COLLECTION_RECORD}="file:0123456789abcdef0123456789abcdef"]`,
  );
  await record.focus();
  await page.keyboard.press('Enter');
  const detail = page.getByRole('region', { name: 'Record detail' });
  await expect(page.locator(`[${DATA_DETAIL_HEADING}]`)).toBeFocused();
  await expect(detail.locator('dt').filter({ hasText: /^Size$/ }))
    .toHaveCount(1);

  const download = page.locator(`[${DATA_DOWNLOAD_FILE}]`);
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('data.file.read'),
  );
  const saved = page.waitForEvent('download');
  await download.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  await Promise.all([
    expect(download).toHaveText('Downloading…'),
    expect(download).toHaveAttribute('aria-disabled', 'true'),
    expect(download).toHaveAttribute('aria-busy', 'true'),
    expect(download).not.toHaveAttribute('disabled'),
    expect(download).toBeFocused(),
  ]);

  await expect(download).toHaveText('Download file');
  await expect(download).toBeFocused();
  expect((await saved).suggestedFilename()).toBe('quarterly-plan.txt');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('data.file.read')),
  ).toBe(before + 1);
});

test('Data preserves calendar reschedule ownership', async ({ page }) => {
  await page.clock.setFixedTime(new Date(1_700_000_000_000));
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/calendar'));

  const record = page.locator(`[${DATA_COLLECTION_RECORD}="event-1"]`);
  await record.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`[${DATA_DETAIL_HEADING}]`)).toBeFocused();

  const open = page.getByRole('button', { name: 'Reschedule', exact: true });
  await open.focus();
  await page.keyboard.press('Enter');
  const input = page.locator(
    'input[data-recued-data-action="reschedule-input"]',
  );
  await expect(input).toBeFocused();
  await input.fill('2026-08-03T09:30');

  const save = page.locator(
    'button[data-recued-data-action="reschedule-submit"]',
  );
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('execute'),
  );
  await save.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await Promise.all([
    expect(save).toHaveText('Rescheduling…'),
    expect(save).toHaveAttribute('aria-disabled', 'true'),
    expect(save).toHaveAttribute('aria-busy', 'true'),
    expect(save).not.toHaveAttribute('disabled'),
    expect(save).toBeFocused(),
  ]);

  await expect(open).toBeVisible();
  await expect(open).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('execute')),
  ).toBe(before + 1);

  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(open).toBeFocused();
});

test('Data contains long collection records on a narrow phone', async ({ page }) => {
  const longSubject = `Subject${'Heading'.repeat(30)}`;
  const longFrom = `Sender${'Address'.repeat(30)}`;
  const longRecordId = `Message${'Identifier'.repeat(24)}`;
  const longSourceId = `Source${'Identifier'.repeat(24)}`;
  const longBody = `Payload${'Value'.repeat(40)}`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(`${HARNESS_URL}?collection_text=long#data/mail`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-data-route]');
  const instances = page.locator(`[${DATA_COLLECTION_SLUG}]`);
  await expect(instances).toHaveCount(2);
  const instanceGeometry = await instances.evaluateAll((controls) =>
    controls.map((control) => ({
      left: control.getBoundingClientRect().left,
      right: control.getBoundingClientRect().right,
      scrollWidth: control.scrollWidth,
      clientWidth: control.clientWidth,
      borderRadius: getComputedStyle(control).borderRadius,
    })),
  );
  expect(await route.evaluate((node) => node.scrollWidth <= node.clientWidth))
    .toBe(true);
  for (const bounds of instanceGeometry) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
    expect(bounds.borderRadius).toBe('8px');
  }

  await instances.first().click();
  const row = page.locator(`[${DATA_COLLECTION_RECORD}="${longRecordId}"]`);
  await expect(row.locator('.col-explorer-row-title')).toHaveText(longSubject);
  await expect(row.locator('.col-explorer-row-summary'))
    .toContainText(longFrom);
  const rowGeometry = await row.evaluate((control) => {
    const elements = [
      control,
      control.querySelector<HTMLElement>('.col-explorer-row-summary'),
      ...control.querySelectorAll<HTMLElement>('.col-explorer-field'),
    ].filter((element): element is HTMLElement => element !== null);
    return elements.map((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
  });
  expect(await route.evaluate((node) => node.scrollWidth <= node.clientWidth))
    .toBe(true);
  for (const bounds of rowGeometry) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }

  await row.click();
  const detail = page.getByRole('region', { name: 'Record detail' });
  await expect(page.locator(`[${DATA_DETAIL_HEADING}]`)).toHaveText(longSubject);
  await expect(detail.getByText(longFrom, { exact: true })).toBeVisible();
  await expect(detail.getByText(longSourceId, { exact: true })).toBeVisible();
  await expect(detail.getByText(longRecordId, { exact: true })).toBeVisible();
  await expect(detail.locator('.col-explorer-detail-body')).toHaveText(longBody);
  await detail.locator('.col-explorer-detail-raw summary').click();
  const detailGeometry = await detail.evaluate((surface) => {
    const elements = [
      surface,
      surface.querySelector<HTMLElement>('.col-explorer-detail-head'),
      surface.querySelector<HTMLElement>('.col-explorer-detail-title'),
      surface.querySelector<HTMLElement>('.col-explorer-detail-fields'),
      ...surface.querySelectorAll<HTMLElement>('.col-explorer-detail-field dd'),
      surface.querySelector<HTMLElement>('.col-explorer-detail-body'),
      surface.querySelector<HTMLElement>('.col-explorer-detail-raw pre'),
    ].filter((element): element is HTMLElement => element !== null);
    return elements.map((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
  });
  expect(await route.evaluate((node) => node.scrollWidth <= node.clientWidth))
    .toBe(true);
  for (const bounds of detailGeometry) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }
});

test('Data keeps keyboard focus on a collection source through record loading', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?connection=source-answer`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/mail'));

  const work = page.locator(`[${DATA_COLLECTION_SLUG}="work"]`);
  await expect(work).toBeVisible();
  await work.focus();
  await expect(work).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(work).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Quarterly planning', { exact: true })).toBeVisible();
  await expect(work).toBeFocused();
});

test('Data keeps collection list recovery focused and retryable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?connection=source-answer`
    + '&collection_list_response=fail-twice-slow-retry',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/mail'));

  const work = page.locator(`[${DATA_COLLECTION_SLUG}="work"]`);
  await work.focus();
  await page.keyboard.press('Enter');
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('Mail records are temporarily unavailable.');
  const retry = page.locator(
    '[data-recued-data-action="collection-retry"]',
  );
  await expect(retry).toHaveText('Retry');
  const callsAfterInitialFailure = await page.evaluate(
    () => window.__app.rpcCallCount('collection.list'),
  );
  await retry.focus();
  await page.keyboard.press('Enter');

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('collection.list')),
  ).toBe(callsAfterInitialFailure + 1);

  await expect(alert).toHaveText('Mail records are temporarily unavailable.');
  await expect(retry).toHaveText('Retry');
  await expect(retry).not.toHaveAttribute('aria-disabled');
  await expect(retry).not.toHaveAttribute('aria-busy');
  await expect(retry).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('collection.list')),
  ).toBe(callsAfterInitialFailure + 2);
  await expect(page.getByText('Quarterly planning', { exact: true })).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect(work).toBeFocused();
});

test('Data keeps collection detail recovery focused and retryable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?connection=source-answer`
    + '&collection_get_response=fail-thrice-slow-retry',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/mail'));

  await page.locator(`[${DATA_COLLECTION_SLUG}="work"]`).click();
  const record = page.locator(`[${DATA_COLLECTION_RECORD}="mail-1"]`);
  await record.focus();
  await page.keyboard.press('Enter');

  const alert = page.getByRole('alert');
  await expect(alert).toHaveText(
    'Mail record detail is temporarily unavailable.',
  );
  const retry = page.locator(
    '[data-recued-data-action="collection-detail-retry"]',
  );
  await expect(retry).toHaveText('Retry');
  const callsAfterInitialFailure = await page.evaluate(
    () => window.__app.rpcCallCount('collection.get'),
  );
  await retry.focus();
  await page.keyboard.press('Enter');

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('collection.get')),
  ).toBe(callsAfterInitialFailure + 1);

  await expect(alert).toHaveText(
    'Mail record detail is temporarily unavailable.',
  );
  await expect(retry).toHaveText('Retry');
  await expect(retry).not.toHaveAttribute('aria-disabled');
  await expect(retry).not.toHaveAttribute('aria-busy');
  await expect(retry).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('collection.get')),
  ).toBe(callsAfterInitialFailure + 2);
  const collections = page.getByRole('combobox', { name: 'Collection', exact: true });
  await collections.focus();
  await expect(collections).toBeFocused();
  await expect(retry).toHaveText('Retry');
  await expect(alert).toHaveText(
    'Mail record detail is temporarily unavailable.',
  );
  await expect(collections).toBeFocused();

  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('collection.get')),
  ).toBe(callsAfterInitialFailure + 3);
  const heading = page.locator(`[${DATA_DETAIL_HEADING}]`);
  await expect(heading).toHaveText('Quarterly planning');
  await expect(heading).toBeFocused();
  await expect(alert).toHaveCount(0);
});

test('Data hands keyboard focus from a record row to its loaded detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?connection=source-answer`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/mail'));

  await page.locator(`[${DATA_COLLECTION_SLUG}="work"]`).click();
  const record = page.locator(`[${DATA_COLLECTION_RECORD}="mail-1"]`);
  await expect(record).toBeVisible();
  await record.focus();
  await expect(record).toBeFocused();
  await page.keyboard.press('Enter');

  const heading = page.locator(`[${DATA_DETAIL_HEADING}]`);
  await expect(heading).toHaveText('Quarterly planning');
  await expect(heading).toBeFocused();
  await expect(page.getByRole('region', { name: 'Record detail' })
    .locator('dt').filter({ hasText: /^Received$/ })).toHaveCount(1);
});

test('Data returns keyboard focus from record detail to its exact row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?connection=source-answer`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/mail'));

  await page.locator(`[${DATA_COLLECTION_SLUG}="work"]`).click();
  const record = page.locator(`[${DATA_COLLECTION_RECORD}="mail-1"]`);
  await record.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`[${DATA_DETAIL_HEADING}]`)).toBeFocused();

  const back = page.getByRole('button', { name: '← Back', exact: true });
  await back.focus();
  await expect(back).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(record).toBeVisible();
  await expect(record).toBeFocused();
});

for (const width of [390, 1280]) {
  for (const action of ['save', 'cancel'] as const) {
    for (const outcome of ['success', 'refused', 'error'] as const) {
      for (const moveAway of [false, true]) {
        test(`Data Reminders ${action} ${outcome} ${moveAway ? 'respects moved' : 'returns owned'} focus at ${width}px`, async ({ page }) => {
          await page.setViewportSize({ width, height: 900 });
          await openReminderFocusFixture(page);
          await startReminderWrite(page, action);
          const notice = page.locator('[data-recued-reminders-focus="notice"]');
          await expect(notice).toHaveText(action === 'save' ? 'Saving reminder…' : 'Cancelling reminder…');
          await expect(notice).toBeFocused();
          const outside = page.locator('[data-recued-account-menu-trigger]');
          if (moveAway) await outside.focus();
          await page.evaluate(outcome => window.__reminderFocus.releaseWrite(outcome), outcome);

          const host = page.locator('[data-recued-reminders]');
          const message = outcome === 'error' ? 'Fixture reminder request interrupted.'
            : action === 'save' ? (outcome === 'success' ? 'Reminder time changed.' : 'Reminder time could not be changed.')
              : outcome === 'success' ? 'Reminder cancelled.' : 'Reminder could not be cancelled.';
          await expect(host).toContainText(message);
          if (moveAway) await expect(outside).toBeFocused();
          else await expect(page.locator(`[data-recued-reminders-focus="${action === 'save' ? (outcome === 'success' ? 'edit:rem_1' : 'at:rem_1') : 'notice'}"]`)).toBeFocused();
          if (action === 'save' && outcome !== 'success') {
            await expect(host.locator('[data-recued-reminders-field="at"]')).toHaveValue('2030-10-17T20:30');
          }
          expect(await page.evaluate(() => window.__reminderFocus.reads)).toBe(outcome === 'error' ? 1 : 2);
          await expectReminderWrite(page, action);
        });
      }
    }
  }
}

for (const action of ['save', 'cancel'] as const) {
  for (const readOutcome of ['current', 'missing', 'error'] as const) {
    for (const moveAway of [false, true]) {
      test(`Data Reminders ${action} keeps ${moveAway ? 'another row’s' : 'owned'} focus through a delayed ${readOutcome} list`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openReminderFocusFixture(page, true);
        await startReminderWrite(page, action);
        await page.evaluate(() => window.__reminderFocus.releaseWrite('success'));
        await expect.poll(() => page.evaluate(() => window.__reminderFocus.waitingForRead)).toBe(true);
        const notice = page.locator('[data-recued-reminders-focus="notice"]');
        await expect(notice).toHaveText(action === 'save' ? 'Reminder time changed.' : 'Reminder cancelled.');
        await expect(action === 'save' ? page.locator('[data-recued-reminders-focus="edit:rem_1"]') : notice).toBeFocused();
        const neighbor = page.locator('[data-recued-reminders-focus="edit:rem_2"]');
        if (moveAway) await neighbor.focus();
        await page.evaluate(outcome => window.__reminderFocus.releaseRead(outcome), readOutcome);
        const host = page.locator('[data-recued-reminders]');
        await expect(notice).toHaveText(action === 'save' ? 'Reminder time changed.' : 'Reminder cancelled.');
        if (readOutcome === 'error') await expect(host.getByRole('alert')).toHaveText('Fixture reminder list interrupted.');
        if (readOutcome === 'missing' || (action === 'cancel' && readOutcome !== 'error')) {
          await expect(host.locator('.reminders-list[aria-label] [data-reminder-id="rem_1"]')).toHaveCount(0);
        }
        if (moveAway) await expect(neighbor).toBeFocused();
        else await expect(action === 'save' && readOutcome !== 'missing'
          ? page.locator('[data-recued-reminders-focus="edit:rem_1"]') : notice).toBeFocused();
        expect(await page.evaluate(() => window.__reminderFocus.reads)).toBe(2);
        await expectReminderWrite(page, action);
      });
    }
  }

  test(`Data Reminders ${action} respects history focus during its write`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openReminderFocusFixture(page);
    await startReminderWrite(page, action);
    const history = page.locator('[data-recued-reminders-focus="history"]');
    await history.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.reminders-history')).toHaveAttribute('open', '');
    await page.evaluate(() => window.__reminderFocus.releaseWrite('success'));
    await expect(page.locator('[data-recued-reminders-focus="notice"]')).toHaveText(action === 'save' ? 'Reminder time changed.' : 'Reminder cancelled.');
    await expect(history).toBeFocused();
    await expect(page.locator('.reminders-history')).toHaveAttribute('open', '');
    await expectReminderWrite(page, action);
  });

  test(`Data Reminders scripted ${action} leaves outside focus throughout the write`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openReminderFocusFixture(page);
    await startReminderWrite(page, action, true);
    const outside = page.locator('[data-recued-account-menu-trigger]');
    await expect(outside).toBeFocused();
    await page.evaluate(() => window.__reminderFocus.releaseWrite('success'));
    await expect(page.locator('[data-recued-reminders-focus="notice"]')).toHaveText(action === 'save' ? 'Reminder time changed.' : 'Reminder cancelled.');
    await expect(outside).toBeFocused();
    await expectReminderWrite(page, action);
  });
}

for (const width of [390, 1280]) {
  for (const failure of ['first-append', 'third-page'] as const) {
    for (const moveAway of [false, true]) {
      test(`Data Mail facts retries ${failure} with ${moveAway ? 'moved' : 'owned'} focus at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openMailFactsPagingFixture(page, failure);
        const host = page.locator('[data-recued-mail-facts]');
        const rows = host.locator('[data-recued-mail-fact-row]');
        const count = failure === 'third-page' ? 2 : 1;
        const failedQuery = await page.evaluate(() => window.__mailFactsPaging.queries.at(-1));
        await host.locator('[data-recued-mail-facts-focus="data:a"]').click();
        await retryMailFactsPage(page);
        await expect(rows).toHaveCount(count);
        await page.evaluate(() => window.__mailFactsPaging.release('error'));
        const retry = host.locator('[data-recued-mail-facts-focus="retry"]');
        await expect(retry).toHaveText('Try again');
        await expect(retry).toBeFocused();
        await expect(retry).not.toHaveAttribute('aria-busy');
        await expect(retry).not.toHaveAttribute('aria-disabled');
        await retryMailFactsPage(page);
        const outside = page.locator('[data-recued-account-menu-trigger]');
        if (moveAway) await outside.focus();
        await page.evaluate(() => window.__mailFactsPaging.release('page'));
        await expect(rows).toHaveCount(3);
        expect(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-recued-mail-fact-row')))).toEqual(['a', 'b', 'c']);
        await expect(host.getByRole('alert')).toHaveCount(0);
        await expect(host.locator('[data-recued-mail-fact-row="a"] details')).toHaveAttribute('open', '');
        await expect(host.locator('[data-recued-mail-facts-focus="list-count"]')).toHaveText('3 facts shown');
        if (moveAway) await expect(outside).toBeFocused();
        else await expect(host.locator(`[data-recued-mail-facts-focus="mail:${failure === 'third-page' ? 'c' : 'b'}"]`)).toBeFocused();
        const queries = await page.evaluate(() => window.__mailFactsPaging.queries);
        expect(queries.slice(-3)).toEqual([failedQuery, failedQuery, failedQuery]);
        expect(queries).toHaveLength(failure === 'third-page' ? 5 : 4);
      });
    }
  }

  for (const reply of ['page', 'empty'] as const) {
    test(`Data Mail facts retries an initial failure to ${reply} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openMailFactsPagingFixture(page, 'initial');
      await retryMailFactsPage(page);
      await page.evaluate(reply => window.__mailFactsPaging.release(reply), reply);
      const host = page.locator('[data-recued-mail-facts]');
      await expect(host.getByRole('alert')).toHaveCount(0);
      await expect(host.locator('[data-recued-mail-fact-row]')).toHaveCount(reply === 'page' ? 1 : 0);
      await expect(host.locator(`[data-recued-mail-facts-focus="${reply === 'page' ? 'mail:a' : 'view:facts'}"]`)).toBeFocused();
      if (reply === 'empty') await expect(host).toContainText('No facts yet.');
      expect(await page.evaluate(() => window.__mailFactsPaging.queries)).toEqual([{ limit: 50 }, { limit: 50 }]);
    });
  }
}

for (const reply of ['page', 'error'] as const) {
  test(`Data Mail facts retires a page retry before its stale ${reply} reply`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMailFactsPagingFixture(page);
    await retryMailFactsPage(page);
    const type = page.locator('[data-recued-mail-facts-filter="type"]');
    await type.selectOption('bill');
    const host = page.locator('[data-recued-mail-facts]');
    await expect(host.locator('[data-recued-mail-fact-row]')).toHaveAttribute('data-recued-mail-fact-row', 'filtered');
    await type.focus();
    await page.evaluate(reply => window.__mailFactsPaging.release(reply), reply);
    // Let the released transport reply and its route callback finish painting.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(host.getByRole('alert')).toHaveCount(0);
    await expect(host.locator('[data-recued-mail-fact-row]')).toHaveAttribute('data-recued-mail-fact-row', 'filtered');
    await expect(type).toBeFocused();
    await expect(type).toHaveValue('bill');
    expect(await page.evaluate(() => window.__mailFactsPaging.queries.at(-1))).toEqual({ limit: 50, type: 'bill' });
  });
}

for (const reply of ['empty', 'missing-email', 'duplicates'] as const) {
  for (const moveAway of [false, true]) {
    test(`Data Mail facts ends a ${reply} page retry with ${moveAway ? 'moved' : 'owned'} focus`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openMailFactsPagingFixture(page);
      await retryMailFactsPage(page);
      const outside = page.locator('[data-recued-account-menu-trigger]');
      if (moveAway) await outside.focus();
      await page.evaluate(reply => window.__mailFactsPaging.release(reply), reply);
      const host = page.locator('[data-recued-mail-facts]');
      await expect(host.getByRole('alert')).toHaveCount(0);
      const count = host.locator('[data-recued-mail-facts-focus="list-count"]');
      await expect(count).toHaveText(`${reply === 'missing-email' ? 3 : 2} facts shown`);
      await expect(host.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
      if (moveAway) await expect(outside).toBeFocused();
      else await expect(count).toBeFocused();
    });
  }
}

for (const width of [390, 1280]) {
  for (const reply of ['populated', 'empty', 'dismissed'] as const) {
    for (const moveAway of [false, true]) {
      test(`Data Mail senders recovers to ${reply} with ${moveAway ? 'moved' : 'owned'} focus at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openMailSendersRecoveryFixture(page);
        await retryMailSendersRead(page);
        const outside = page.locator('[data-recued-account-menu-trigger]');
        if (moveAway) await outside.focus();
        await page.evaluate(reply => window.__mailSendersRecovery.release(reply), reply);
        const host = page.locator('[data-recued-mail-facts="senders"]');
        await expect(host.getByRole('alert')).toHaveCount(0);
        await expect(host.locator('[data-recued-mail-fact-sender]')).toHaveCount(reply === 'populated' ? 1 : 0);
        if (reply === 'empty') await expect(host).toContainText('No sender without a template');
        if (reply === 'dismissed') await expect(host.locator('[data-recued-mail-facts-focus="snd:dismissed"]')).toHaveText('Dismissed (1)');
        if (moveAway) await expect(outside).toBeFocused();
        else {
          const key = reply === 'populated' ? 'snd:make:news@club.example.test' : reply === 'dismissed' ? 'snd:dismissed' : 'view:senders';
          await expect(host.locator(`[data-recued-mail-facts-focus="${key}"]`)).toBeFocused();
        }
        await expect(page).toHaveURL(/#data\/mail_fact\/senders$/);
        expect(await page.evaluate(() => window.__mailSendersRecovery.reads)).toBe(2);
        expect(await page.evaluate(() => window.__app.rpcCallCount('mail_fact.senders.dismiss'))).toBe(0);
      });
    }
  }

  test(`Data Mail senders keeps repeated read failures retryable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openMailSendersRecoveryFixture(page);
    await retryMailSendersRead(page);
    await page.evaluate(() => window.__mailSendersRecovery.release('error'));
    const host = page.locator('[data-recued-mail-facts="senders"]');
    const retry = host.locator('[data-recued-mail-facts-focus="snd:retry"]');
    await expect(retry).toHaveText('Try again');
    await expect(retry).not.toHaveAttribute('aria-busy');
    await expect(retry).not.toHaveAttribute('aria-disabled');
    await expect(retry).toBeFocused();
    await expect(host.getByText('Loading…', { exact: true })).toHaveCount(0);
    await retryMailSendersRead(page);
    await page.evaluate(() => window.__mailSendersRecovery.release('populated'));
    await expect(host.getByRole('alert')).toHaveCount(0);
    await expect(host.locator('[data-recued-mail-facts-focus="snd:make:news@club.example.test"]')).toBeFocused();
    expect(await page.evaluate(() => window.__mailSendersRecovery.reads)).toBe(3);
    expect(await page.evaluate(() => window.__mailSendersRecovery.writes)).toEqual([]);
  });
}

for (const reply of ['populated', 'error'] as const) {
  test(`Data Mail senders respects a view change before a late ${reply} reply`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMailSendersRecoveryFixture(page);
    await retryMailSendersRead(page);
    const facts = page.locator('[data-recued-mail-facts-focus="view:facts"]');
    await facts.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('[data-recued-mail-facts="facts"]')).toBeVisible();
    await page.evaluate(reply => window.__mailSendersRecovery.release(reply), reply);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(facts).toBeFocused();
    const senders = page.locator('[data-recued-mail-facts-focus="view:senders"]');
    await senders.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__mailSendersRecovery.pending)).toBe(1);
    await page.evaluate(() => window.__mailSendersRecovery.release('populated'));
    const host = page.locator('[data-recued-mail-facts="senders"]');
    await expect(host.locator('[data-recued-mail-fact-sender]')).toHaveCount(1);
    await expect(host.getByRole('alert')).toHaveCount(0);
    await expect(senders).toBeFocused();
    expect(await page.evaluate(() => window.__mailSendersRecovery.reads)).toBe(3);
    expect(await page.evaluate(() => window.__mailSendersRecovery.writes)).toEqual([]);
  });
}

test('Data Mail senders retries the read after dismissal without repeating the write', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMailSendersRecoveryFixture(page, true);
  const host = page.locator('[data-recued-mail-facts="senders"]');
  await host.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(host.getByRole('alert')).toContainText('Fixture sender count interrupted.');
  await retryMailSendersRead(page);
  await page.evaluate(() => window.__mailSendersRecovery.release('populated'));
  await expect(host.locator('[data-recued-mail-fact-sender]')).toHaveCount(0);
  await expect(host.getByRole('alert')).toHaveCount(0);
  await expect(host.locator('[data-recued-mail-facts-focus="snd:dismissed"]')).toBeFocused();
  expect(await page.evaluate(() => window.__mailSendersRecovery.reads)).toBe(3);
  expect(await page.evaluate(() => window.__mailSendersRecovery.writes)).toEqual([{ address: 'news@club.example.test', dismissed: true }]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('mail_fact.senders.dismiss'))).toBe(1);
});


test.describe('Records CSV import', () => {
  const rows = (page: Page) => page.locator('.records-table tbody tr');
  const ready = async (page: Page) => {
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(page.locator('[data-recued-data-route]')).toBeVisible();
  };
  const checkCsvImport = async (page: Page) => {
    await page.getByRole('region', { name: 'Import records', exact: true }).getByRole('button', { name: 'Import CSV', exact: true }).click();
    const dialog = page.locator('[data-recued-sheet-import]');
    await dialog.getByRole('combobox').fill('Statement');
    await page.getByRole('option', { name: /Statement.csv/ }).click();
    await dialog.getByRole('button', { name: 'Next: match the columns', exact: true }).click();
    await dialog.locator('[data-var-key="account_label"]').fill('current-account');
    await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Check the file', exact: true }).click();
    await expect(dialog).toContainText('Check only — nothing recorded');
    return dialog;
  };

  test('Records imports through its pack recipe only after a check, then shows the receipt and new rows', async ({ page }) => {
    await page.goto('/full-app-harness.html?data=records-navigation&records_import=1#data/records');
    await ready(page);
    const imports = page.getByRole('region', { name: 'Import records', exact: true });
    await expect(imports.getByRole('button', { name: 'Import CSV', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Other statement pack/ }).click();
    await expect(imports).toHaveCount(0);
    await page.getByRole('button', { name: /Statement import.*recued-core/ }).click();
    const dialog = await checkCsvImport(page);
    expect(await page.evaluate(() => sessionStorage.getItem('recued-test-records-imported'))).toBeNull();
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Last import result' })).toContainText('Import finished');
    await expect(rows(page)).toContainText('Coffee');
    const runs = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-records-import-runs') ?? '[]'));
    expect(runs.map((run: { config: { check_first: boolean } }) => run.config.check_first)).toEqual([true, false]);
    expect(runs[1].config).toMatchObject({ file: 'file:statement', account_label: 'current-account',
      column_date: 'Date', column_description: 'Description', column_amount: 'Amount' });
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-records-import-dishes') ?? '[]'));
    expect(saved[0]).toMatchObject({ recipe_id: 'import-bank-statement', enabled: false });
    expect(saved[0].config_overlay).not.toHaveProperty('file');
    expect(saved[0].config_overlay).not.toHaveProperty('account_label');
  });

  test('Records keeps the confirmed import receipt when its refresh fails and recovers without importing again', async ({ page }) => {
    await page.goto('/full-app-harness.html?data=records-navigation&records_import=1#data/records');
    await ready(page);
    const dialog = await checkCsvImport(page);
    await page.evaluate(() => sessionStorage.setItem('recued-test-records-import-refresh-failure', '1'));
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const receipt = page.getByRole('region', { name: 'Last import result' });
    await expect(receipt).toContainText('Import finished');
    await expect(page.locator('[role="alert"]').first()).toContainText('Records refresh is temporarily unavailable');
    await page.evaluate(() => sessionStorage.removeItem('recued-test-records-import-refresh-failure'));
    await page.getByRole('button', { name: /Statement import.*recued-core/ }).click();
    await expect(rows(page)).toContainText('Coffee');
    await expect(receipt).toContainText('Import finished');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-records-import-runs') ?? '[]').length)).toBe(2);
  });
});

// Projects assemble only explicit links; the existing editors retain their
// mutation and draft guards while the overview owns the return navigation.
test('project overview pages linked work and returns from editing and creating tasks and notes', async ({ page }) => {
  await installProjectOverviewFixture(page);
  await page.goto(`${HARNESS_URL}?data=today#data/project`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-entity-id="launch"]').click();
  const overview = page.locator('[data-project-overview="launch"]');
  const tasks = overview.locator('[data-project-section="task"]');
  const notes = overview.locator('[data-project-section="note"]');
  await expect(overview.getByRole('heading', { name: 'Kestrel launch', exact: true })).toBeVisible();
  await expect(overview).toContainText('12 open · 2 completed tasks');
  await expect(tasks.locator('[data-project-item-id]')).toHaveCount(10);
  await expect(notes.locator('[data-project-item-id]')).toHaveCount(10);
  await expect(overview.getByText('Independent launch note', { exact: true })).toHaveCount(0);
  await tasks.getByRole('button', { name: 'More tasks', exact: true }).click();
  await notes.getByRole('button', { name: 'More notes', exact: true }).click();
  await expect(tasks.locator('[data-project-item-id]')).toHaveCount(14);
  await expect(notes.locator('[data-project-item-id]')).toHaveCount(12);
  const lastNote = notes.locator('[data-project-item-id="note-11"]');
  await lastNote.scrollIntoViewIfNeeded();
  const scroll = await page.locator('[data-recued-webclient-content]').evaluate(node => node.scrollTop);
  await lastNote.click();
  const reader = page.locator('.work-entity-note-reader');
  await expect(reader.getByRole('heading', { name: 'Launch note 11', exact: true })).toBeVisible();
  await reader.getByRole('button', { name: 'Back to project', exact: true }).click();
  await expect(lastNote).toBeFocused();
  expect(await page.locator('[data-recued-webclient-content]').evaluate(node => node.scrollTop)).toBe(scroll);
  await expect(notes.locator('[data-project-item-id]')).toHaveCount(12);
  await tasks.locator('[data-project-item-id="task-00"]').click();
  const task = page.getByRole('dialog', { name: 'Edit Task', exact: true });
  await task.getByRole('textbox', { name: /^Title/ }).fill('Revised launch task');
  await task.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(tasks.locator('[data-project-item-id="task-00"]')).toContainText('Revised launch task');
  await tasks.locator('[data-project-item-id="task-00"]').click();
  await task.getByRole('button', { name: 'Complete', exact: true }).click();
  await expect(task).toContainText('Task completed.');
  await task.getByRole('button', { name: 'Back to project', exact: true }).click();
  await expect(overview).toContainText('11 open · 3 completed tasks');
  await tasks.getByRole('button', { name: 'New task', exact: true }).click();
  const newTask = page.getByRole('dialog', { name: 'New Task', exact: true });
  await newTask.getByRole('textbox', { name: /^Title/ }).fill('Another launch task');
  await newTask.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(overview).toContainText('Another launch task');
  await notes.getByRole('button', { name: 'New note', exact: true }).click();
  const newNote = page.getByRole('dialog', { name: 'New Note', exact: true });
  await newNote.getByRole('textbox', { name: /^Title/ }).fill('Decisions');
  await newNote.getByRole('textbox', { name: /^Note text/ }).fill('Approved release details.');
  await newNote.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(overview).toContainText('Decisions');
  const writes = await page.evaluate(() => window.__projectOverview.writes);
  expect(writes.find(write => write.title === 'Another launch task')).toMatchObject({ parent_project_id: 'launch' });
  expect(writes.find(write => write.title === 'Decisions')).toMatchObject({ related_project_ids: ['launch'] });
  await overview.getByRole('button', { name: 'Edit project', exact: true }).click();
  const project = page.getByRole('dialog', { name: 'Edit Project', exact: true });
  await project.getByRole('textbox', { name: /^Title/ }).fill('Revised Kestrel launch');
  await project.getByRole('textbox', { name: /^Description/ }).fill('Updated project brief.');
  await project.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(overview).toContainText('Updated project brief.');
  await overview.getByRole('button', { name: 'Edit project', exact: true }).click();
  await project.getByRole('textbox', { name: /^Description/ }).fill('');
  await project.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(overview.getByText('Updated project brief.', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__projectOverview.writes.at(-1)?.description)).toBe('');
  await overview.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await expect(page.locator('[data-entity-id="launch"]')).toContainText('Revised Kestrel launch');
  await expect(page.locator('[data-entity-id="other"]')).toBeVisible();
});

test('project section retry preserves other work and late pages cannot replace another project', async ({ page }) => {
  await installProjectOverviewFixture(page, true);
  await page.goto(`${HARNESS_URL}?data=today#data/project`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-entity-id="launch"]').click();
  const overview = page.locator('[data-project-overview="launch"]');
  const tasks = overview.locator('[data-project-section="task"]');
  const notes = overview.locator('[data-project-section="note"]');
  await expect(tasks.locator('[data-project-item-id]')).toHaveCount(10);
  await expect(notes.getByRole('alert')).toContainText('Notes read interrupted');
  await page.evaluate(() => window.__projectOverview.failNotes(false));
  await notes.getByRole('button', { name: 'Try notes again', exact: true }).click();
  await expect(notes.locator('[data-project-item-id]')).toHaveCount(10);
  await expect(notes.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => window.__projectOverview.holdTaskPage());
  await tasks.getByRole('button', { name: 'More tasks', exact: true }).focus();
  await page.evaluate(() => { for (let i = 0; i < 2; i++) document.querySelector<HTMLButtonElement>('[data-action="project-work-more"][data-project-kind="task"]')!.click(); });
  await expect.poll(() => page.evaluate(() => window.__projectOverview.reads.filter(read => read.kind === 'task' && read.offset === 10).length)).toBe(1);
  await overview.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.locator('[data-entity-id="other"]').click();
  const other = page.locator('[data-project-overview="other"]');
  await expect(other.getByRole('heading', { name: 'Other project', exact: true })).toBeVisible();
  await expect(other.getByRole('button', { name: 'Edit project', exact: true })).toHaveCount(0);
  await expect(other).toContainText('Other project task');
  await expect(other.getByText('May be out of date', { exact: true })).toBeVisible();
  await page.evaluate(() => window.__projectOverview.releaseTaskPage());
  await expect(other).toBeVisible();
  await expect(other.getByText('Launch task 10', { exact: true })).toHaveCount(0);
});

test('project creation keeps a draft after an unconfirmed link and prevents a duplicate submission', async ({ page }) => {
  await installProjectOverviewFixture(page);
  await page.goto(`${HARNESS_URL}?data=today#data/project`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-entity-id="launch"]').click();
  await page.locator('[data-project-overview="launch"]').getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Task', exact: true });
  await dialog.getByRole('textbox', { name: /^Title/ }).fill('Check project association');
  await page.evaluate(() => window.__projectOverview.changeNextCreateLink());
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('source did not confirm');
  await expect(dialog.getByRole('textbox', { name: /^Title/ })).toHaveValue('Check project association');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('source already returned an item');
  expect(await page.evaluate(() => window.__projectOverview.writes.filter(write => write.method === 'work_entity.upsert').length)).toBe(1);
});

test('project live refresh preserves focus and drafts, and editing rechecks source permissions', async ({ page }) => {
  await installProjectOverviewFixture(page);
  await page.goto(`${HARNESS_URL}?data=today#data/project`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-entity-id="launch"]').click();
  const overview = page.locator('[data-project-overview="launch"]');
  await expect(overview).toContainText('12 open · 2 completed tasks');
  const owner = overview.getByRole('button', { name: 'New note', exact: true });
  await owner.focus();
  await page.evaluate(() => {
    window.__projectOverview.updateFromServer('Refreshed launch');
    window.__app.fireMessage({ type: 'server_event', event: { kind: 'warehouse', collection: 'task', op: 'update', id: 'task-00', cursor: Date.now() + 10_000 } });
  });
  await expect(overview.getByRole('heading', { name: 'Refreshed launch', exact: true })).toBeVisible();
  await expect(overview).toContainText('11 open · 3 completed tasks');
  await expect(owner).toBeFocused();
  await overview.locator('[data-project-item-id="note-00"]').click();
  const reader = page.locator('.work-entity-note-reader');
  await expect(reader.getByRole('heading', { name: 'Launch note 0', exact: true })).toBeVisible();
  await page.evaluate(() => window.__projectOverview.updateFromServer('Changed while reading'));
  await reader.getByRole('button', { name: 'Back to project', exact: true }).click();
  await expect(overview.getByRole('heading', { name: 'Changed while reading', exact: true })).toBeVisible();
  await expect(overview.locator('[data-project-section][aria-busy="true"]')).toHaveCount(0);
  await overview.getByRole('button', { name: 'Edit project', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit Project', exact: true });
  await editor.getByRole('textbox', { name: /^Description/ }).fill('Unfinished project brief');
  const before = await page.evaluate(() => window.__app.rpcCallCount('work_entity.list'));
  await page.evaluate(() => {
    window.__projectOverview.updateFromServer('Changed elsewhere');
    window.__app.fireMessage({ type: 'server_event', event: { kind: 'warehouse', collection: 'project', op: 'update', id: 'launch', cursor: Date.now() + 20_000 } });
  });
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('work_entity.list'))).toBeGreaterThan(before);
  await expect(editor.getByRole('textbox', { name: /^Description/ })).toHaveValue('Unfinished project brief');
  await editor.getByRole('button', { name: 'Back to project', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(overview.getByRole('heading', { name: 'Changed elsewhere', exact: true })).toBeVisible();
  await expect(overview.locator('[data-project-section][aria-busy="true"]')).toHaveCount(0);
  const beforePermissionRead = await page.evaluate(() => window.__app.rpcCallCount('work_entity.source.list'));
  await page.evaluate(() => window.__projectOverview.setProjectWritable(false));
  await overview.getByRole('button', { name: 'Edit project', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('work_entity.source.list'))).toBeGreaterThan(beforePermissionRead);
  await expect(page.getByRole('dialog', { name: 'Edit Project', exact: true })).toHaveCount(0);
  await expect(overview.getByRole('button', { name: 'Edit project', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__projectOverview.writes)).toEqual([]);
});


test('saved contact lookup is shared by Contacts, global Search and task contact pickers', async ({ page }, testInfo) => {
  const db = new Database(':memory:');
  const store = createContactStore(db);
  const alex = store.upsertManual({ email: 'alex@example.test', name: 'Alex Example',
    phone: '+14155550123', company: 'Northwind' }, 1);
  store.upsertContactAlias({ contact_id: alex.contact_id!, kind: 'chat_alias', alias_pattern: 'The desk', source: 'manual' }, 2);
  for (let index = 0; index < 7; index++)
    store.upsertManual({ email: `person${index}@example.test`, name: `Person ${index}`, company: 'Northwind' }, 1);
  const aliases = db.prepare('SELECT * FROM contact_alias ORDER BY id').all();
  let holdBrowse = false;
  let holdNextGet = false;
  let getHeld = false;
  const release: { browse?: () => void; get?: () => void } = {};
  const browseRead = new Promise<void>(resolve => { release.browse = resolve; });
  const profileRead = new Promise<void>(resolve => { release.get = resolve; });
  try {
    await page.route('**/__contact-search-fixture', async route => {
      const { method, args } = route.request().postDataJSON();
      const result = method === 'recipe.list' ? { recipes: [] } : method === 'packs.list' ? { packs: [] }
        : method === 'contact.search.local' ? await handleContactSearchLocal({ store }, args)
        : method === 'contact.get' ? await handleContactGet({ store }, args)
          : await handleContactList({ store }, args);
      if (holdBrowse && (method === 'contact.list' || method === 'contact.search.local' && args.with_rollups))
        await browseRead;
      if (method === 'contact.get' && holdNextGet) {
        holdNextGet = false; getHeld = true;
        await profileRead;
      }
      await route.fulfill({ json: { result } });
    });
    await page.addInitScript(() => Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
      if (!['contact.search.local', 'contact.get', 'contact.list', 'recipe.list', 'packs.list'].includes(method)) return undefined;
      return await (await fetch('/__contact-search-fixture', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })).json();
    } }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${HARNESS_URL}?data=contacts&settle_reads=1#data/contact`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const rows = page.locator('[data-recued-data-contact-row]');
    const contactQuery = page.getByRole('searchbox', { name: 'Search contacts' });
    for (const query of ['alex@example', '(415) 555-0123', 'The desk']) {
      await contactQuery.fill(query);
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText(alex.email);
    }
    await page.evaluate(() => window.__app.setHash('#data/search'));
    const search = page.getByRole('searchbox', { name: 'Search everything' });
    await search.fill('Northwind');
    const group = page.getByRole('region', { name: 'Contact search results' });
    const results = group.locator('[data-search-contact-email]');
    await expect(results).toHaveCount(5);
    await group.getByRole('button', { name: 'More contacts', exact: true }).click();
    await expect(results).toHaveCount(8);
    await expect(group.getByRole('button', { name: 'More contacts', exact: true })).toHaveCount(0);
    const result = group.locator('[data-search-contact-email="person6@example.test"]');
    // Opening an addressed profile must not depend on the list behind it.
    holdBrowse = true;
    await result.click();
    const heading = page.locator('[data-recued-data-contact-detail-heading]');
    await expect(heading).toContainText('Person 6');
    await expect(heading).toBeFocused();
    await page.getByRole('button', { name: /Back to search/ }).click();
    await expect(search).toHaveValue('Northwind');
    await expect(results).toHaveCount(8);
    await expect(result).toBeFocused();

    // Return and reopen the same identity while its older profile read is held.
    holdNextGet = true;
    await result.click();
    await expect.poll(() => getHeld).toBe(true);
    await page.getByRole('button', { name: /Back to search/ }).click();
    db.prepare('UPDATE contacts SET name=?, updated_at=? WHERE email=?').run('Person 6 updated', 2, 'person6@example.test');
    await result.click();
    await expect(heading).toHaveText('Person 6 updated');
    const staleRead = page.waitForResponse(response => response.url().endsWith('/__contact-search-fixture')
      && response.request().postDataJSON().method === 'contact.get');
    release.get?.();
    await staleRead;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(heading).toHaveText('Person 6 updated');
    await page.goBack();
    await expect(search).toHaveValue('Northwind');
    await expect(result).toBeFocused();
    await search.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('contact-search-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: testInfo.outputPath('contact-search-desktop.png'), fullPage: true });

    await page.goto(`${HARNESS_URL}?data=work-entities-paged&settle_reads=1#data/task`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.getByRole('button', { name: '+ New Task', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New Task', exact: true });
    await dialog.getByRole('button', { name: 'More details', exact: true }).click();
    const picker = dialog.locator('[data-ref-picker="form-ref-assigned_contact"]');
    await picker.getByRole('combobox').fill('The desk');
    await picker.getByRole('option').filter({ hasText: alex.email }).click();
    await expect(picker.locator('[data-ref-picker-value]')).toHaveValue(alex.email);
    expect(db.prepare('SELECT * FROM contact_alias ORDER BY id').all()).toEqual(aliases);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    release.browse?.(); release.get?.(); db.close();
  }
});

test('VCF import selects contact-linked dates, retains a failed review, and edits a one-time Occasion', async ({ page }, testInfo) => {
  const db = new Database(':memory:');
  const store = createContactStore(db);
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const deps = { store, history, transaction: <T>(work: () => T): T => db.transaction(work)() };
  let failApply = true;
  try {
    const fixtureRpc = async (method: string, raw: unknown) => {
      if (method === 'contact.get') return { result: await handleContactGet({ store }, raw as { email: string }) };
      if (method === 'contact.list') return { result: { contacts: store.list(), total: store.list().length } };
      if (method === 'contact.import.file_preview') return { result: planContactFileImport(deps, (raw as { text: string }).text) };
      if (method === 'contact.import.file_apply') {
        if (failApply) { failApply = false; return { error: { code: 'unavailable', message: 'The import was interrupted. Try again.' } }; }
        const args = raw as { text: string; apply_changes: boolean; occasions?: ContactImportOccasionSelection[] };
        return { result: applyContactFileImport(deps, args.text, args.apply_changes, args.occasions) };
      }
      if (method === 'yours.read') {
        const snapshot: YoursSnapshot = { assets: [], related_assets: [], total_assets: 0, classes: [], proposals: [], total_proposals: 0,
          occurrences: [], occasions: history.occasions(), episodes: [], sources: [], suppressions: [],
          intake: { emails_read: 0, receipts_found: 0, likely_assets: 0, last_scan_at: null }, unmatched_replies: [], phone_ready: false,
          settings: { digest: 'off', last_time: 'off', measures: false }, sphere_placements: [] };
        return { result: snapshot };
      }
      if (method === 'yours.change') {
        const args = raw as YoursCommand;
        if (args.action === 'occasion.save') {
          const saved = history.saveOccasion(args.occasion, Date.now());
          return { result: { id: saved.id, message: 'Occasion saved.' } };
        }
        return { result: { message: 'Recorded.' } };
      }
      return undefined;
    };
    await page.route('**/__vcf-import-fixture', async route => {
      const { method, args } = route.request().postDataJSON() as { method: string; args: unknown };
      await route.fulfill({ json: await fixtureRpc(method, args) ?? null });
    });
    await page.addInitScript(() => Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
      if (!['contact.get', 'contact.list', 'contact.import.file_preview', 'contact.import.file_apply', 'yours.read', 'yours.change'].includes(method)) return undefined;
      const response = await fetch('/__vcf-import-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
      return await response.json();
    } }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${HARNESS_URL}?data=contact-import&vcf_import=1&settle_reads=1#data/contact/import`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const upload = { name: 'alex.vcf', mimeType: 'text/vcard',
      buffer: Buffer.from(['BEGIN:VCARD', 'VERSION:4.0', 'FN:Alex', 'EMAIL;PREF=2:work@example.test', 'EMAIL;PREF=1:home@example.test',
        'TEL;PREF=1:+15550101', 'TEL:+15550102', 'item1.X-ABDATE:2030-06-01', 'item1.X-ABLabel:Graduation',
        'item2.X-ABDATE:--04-15', 'item2.X-ABLabel:First met', 'END:VCARD'].join('\n')) };
    await page.getByLabel('Choose a vCard or CSV file').setInputFiles(upload);
    const graduation = page.getByRole('group', { name: 'Alex · Graduation', exact: true });
    const firstMet = page.getByRole('group', { name: 'Alex · First met', exact: true });
    await expect(graduation.getByRole('checkbox')).not.toBeChecked();
    await page.getByRole('button', { name: 'Select all dates', exact: true }).click();
    await expect(graduation.getByRole('checkbox')).toBeChecked();
    await expect(firstMet.getByRole('checkbox')).toBeChecked();
    await page.getByRole('button', { name: 'Clear dates', exact: true }).click();
    await expect(graduation.getByRole('checkbox')).not.toBeChecked();
    await expect(firstMet.getByRole('checkbox')).not.toBeChecked();
    await expect(firstMet.getByRole('combobox', { name: 'Repeat First met for Alex' }).locator('option[value="once"]')).toHaveAttribute('disabled', '');
    await graduation.getByRole('checkbox').check();
    await graduation.getByLabel('Repeat Graduation for Alex').selectOption('once');
    await graduation.getByLabel('Remind Graduation for Alex').selectOption('1');
    await page.screenshot({ path: testInfo.outputPath('vcf-import-review.png'), fullPage: true });
    const apply = page.locator('[data-recued-data-action="contact-import-file-apply"]');
    await apply.click();
    await expect(page.getByText('The import was interrupted. Try again.', { exact: true })).toBeVisible();
    await expect(graduation.getByRole('checkbox')).toBeChecked();
    await expect(graduation.getByLabel('Repeat Graduation for Alex')).toHaveValue('once');
    await expect(graduation.getByLabel('Remind Graduation for Alex')).toHaveValue('1');
    expect(store.get('home@example.test')).toBeNull();
    await apply.click();
    await expect(page.locator(`[${DATA_CONTACT_IMPORT_RESULT}]`)).toContainText('1 added · 0 changed · 1 occasion saved');
    const contact = store.get('home@example.test')!;
    expect(contact.phone).toBe('+15550101');
    expect(store.resolveCanonicalEmail('work@example.test').canonical_email).toBe(contact.email);
    expect(store.listContactAliases(contact.contact_id!).filter(alias => alias.kind === 'phone_alias')).toHaveLength(2);
    expect(history.occasions()).toHaveLength(1);
    expect(history.occasions()[0]).toMatchObject({ people: [contact.contact_id], source_next_on: '2030-06-01' });

    await page.getByRole('button', { name: 'Back to contacts', exact: true }).click();
    await page.locator('[data-recued-data-contact-row]').filter({ hasText: 'home@example.test' }).click();
    const identifiers = page.getByRole('region', { name: 'Additional contact details' });
    await expect(identifiers).toContainText('work@example.test');
    await expect(identifiers).toContainText('+15550102');
    await page.goto(`${HARNESS_URL}?yours=demo&vcf_import=2&settle_reads=1#yours/occasions`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.getByRole('button', { name: 'Edit occasion', exact: true }).click();
    const form = page.locator('[data-yours-editor]');
    await expect(form.getByLabel('Repeat', { exact: true })).toHaveValue('once');
    await expect(form.getByLabel('Date', { exact: true })).toHaveValue('2030-06-01');
    await expect(form.getByLabel('Annual date (MM-DD)', { exact: true })).toBeHidden();
    await form.getByLabel('Date', { exact: true }).fill('2031-06-02');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(history.occasions()[0]).toMatchObject({ month_day: '06-02', source_next_on: '2031-06-02', people: [contact.contact_id] });
    await page.goto(`${HARNESS_URL}?data=contact-import&vcf_import=3&settle_reads=1#data/contact/import`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.getByLabel('Choose a vCard or CSV file').setInputFiles(upload);
    await expect(graduation).toContainText('2031-06-02');
    await expect(graduation.getByRole('checkbox')).not.toBeChecked();
    await graduation.getByRole('checkbox').check();
    await expect(apply).toHaveText('Import 1 occasion');
    await apply.click();
    await expect(page.locator(`[${DATA_CONTACT_IMPORT_RESULT}]`)).toContainText('1 occasion saved');
    expect(history.occasions()).toHaveLength(1);
    expect(history.occasions()[0]).toMatchObject({ source_next_on: '2030-06-01', people: [contact.contact_id] });
    expect(history.occasions()[0]?.rules[0]?.schedule).toEqual({ before: [{ amount: 1, unit: 'days' }], on_day: true });
  } finally { db.close(); }
});

test.describe('Commitment workspace', () => {
  test.use({ locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  const listRows = (page: Page) => page.locator('.work-entity-list-view[data-kind="commitment"] .work-entity-list-row');
  const selectView = async (page: Page, direction: string, status: string) => {
    await page.getByRole('combobox', { name: 'Who owes', exact: true }).focus();
    await page.getByRole('combobox', { name: 'Who owes', exact: true }).selectOption(direction);
    await page.getByRole('combobox', { name: 'Commitment status', exact: true }).focus();
    await page.getByRole('combobox', { name: 'Commitment status', exact: true }).selectOption(status);
  };

  test('Commitment workspace searches the complete set and restores saved direction and status filters', async ({ page }, testInfo) => {
    const f = await installCommitmentWorkspaceFixture(page);
    try {
      await page.goto(`${HARNESS_URL}?data=contacts#data/commitment`);
      await expect(listRows(page)).toHaveCount(100);
      await expect(page.getByRole('button', { name: /Prepare École_100% release/ })).toHaveCount(0);
      const search = page.getByRole('searchbox', { name: 'Search commitments', exact: true });
      await search.fill('ÉCOLE_100%');
      await expect(listRows(page)).toHaveCount(1);
      await expect(listRows(page)).toContainText('Prepare École_100% release');
      expect(f.reads.at(-1)?.search).toBe('ÉCOLE_100%');
      await search.fill('');
      await expect(listRows(page)).toHaveCount(100);
      await selectView(page, 'inbound', 'overdue');
      await expect(listRows(page)).toHaveCount(1);
      await expect(listRows(page)).toContainText('Maya will send the signed agreement');
      await expect(listRows(page)).toContainText('Maya Chen');
      await expect(listRows(page)).toContainText('Due Oct 28, 2026');
      await expect(page.getByRole('combobox', { name: 'Commitment status', exact: true })).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('commitments-desktop.png'), fullPage: true });
      const views = page.locator('[data-saved-data-views]');
      await views.getByRole('button', { name: 'Save current view', exact: true }).click();
      await views.getByLabel('View name', { exact: true }).fill('Waiting on Maya');
      await views.getByRole('button', { name: 'Save view', exact: true }).click();
      await expect(views.locator('[data-view-notice]')).toContainText('Saved “Waiting on Maya”');
      await selectView(page, 'outbound', 'open');
      await expect(listRows(page).filter({ hasText: 'Send Maya the revised proposal' })).toHaveCount(1);
      await page.getByRole('link', { name: 'Saved views', exact: true }).click();
      await page.getByRole('link', { name: /Waiting on Maya/ }).click();
      await expect(page.getByRole('combobox', { name: 'Who owes', exact: true })).toHaveValue('inbound');
      await expect(page.getByRole('combobox', { name: 'Commitment status', exact: true })).toHaveValue('overdue');
      await expect(listRows(page)).toHaveCount(1);
      expect(f.writes).toEqual([]);
    } finally { f.close(); }
  });

  test('Commitment workspace reader preserves drafts, confirms deadline edits and closes only writable promises', async ({ page }, testInfo) => {
    const f = await installCommitmentWorkspaceFixture(page);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${HARNESS_URL}?data=contacts#data/commitment`);
      await listRows(page).filter({ hasText: 'Send Maya the revised proposal' }).getByRole('button').click();
      const reader = page.locator('.work-entity-commitment-reader'), editor = page.locator('.work-entity-dialog[data-mode="edit"]');
      await expect(reader).toContainText('Maya Chen');
      await expect(reader).toContainText('Oct 28, 2026');
      await page.screenshot({ path: testInfo.outputPath('commitments-mobile.png'), fullPage: true });
      await reader.getByRole('button', { name: 'Edit', exact: true }).click();
      await editor.locator('[data-form-field="statement"]').fill('Unfinished promise edit');
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await expect(editor.locator('[data-form-field="statement"]')).toHaveValue('Unfinished promise edit');
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(reader).toContainText('Send Maya the revised proposal');
      expect(f.writes).toEqual([]);
      await reader.getByRole('button', { name: 'Edit', exact: true }).click();
      await editor.locator('[data-form-field="promised_for_at"]').fill('2026-11-02T14:30');
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(reader).toContainText('Commitment saved.');
      expect(f.store.readCommitment('maya-outbound')?.promised_for_at).toBe(Date.parse('2026-11-02T14:30:00-08:00'));
      await reader.getByRole('button', { name: 'Edit', exact: true }).click();
      await editor.locator('[data-form-field="promised_for_at"]').fill('');
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(reader).toContainText('No deadline');
      expect(f.store.readCommitment('maya-outbound')?.promised_for_at).toBeUndefined();
      await reader.getByRole('button', { name: 'Back to commitments', exact: true }).click();
      await selectView(page, 'outbound', 'open');
      await page.getByRole('searchbox', { name: 'Search commitments', exact: true }).fill('revised proposal');
      await listRows(page).filter({ hasText: 'Send Maya the revised proposal' }).getByRole('button').click();
      await reader.getByRole('button', { name: 'Mark fulfilled', exact: true }).click();
      await expect(reader.locator('[data-commitment-status]')).toHaveText('Fulfilled');
      await expect(reader.locator('[data-commitment-status]')).toBeFocused();
      expect(f.writes.filter(row => row.method === 'work_entity.commitment.fulfill')).toHaveLength(1);
      await reader.getByRole('button', { name: 'Back to commitments', exact: true }).click();
      await expect(listRows(page).filter({ hasText: 'Send Maya the revised proposal' })).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: 'Commitment status', exact: true })).toHaveValue('open');
      await page.getByRole('searchbox', { name: 'Search commitments', exact: true }).fill('');
      await selectView(page, 'inbound', 'all');
      await listRows(page).filter({ hasText: 'Imported promise' }).getByRole('button').click();
      await expect(reader).toContainText('This promise is read-only here.');
      await expect(reader.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await expect(reader.getByRole('button', { name: 'Mark fulfilled', exact: true })).toHaveCount(0);
      await expect(reader.getByRole('button', { name: 'Cancel commitment', exact: true })).toHaveCount(0);
      expect(f.writes).toHaveLength(3);
    } finally { f.close(); }
  });

  test('Commitment workspace admits cancellation of strict expired promises and blocks pending changes', async ({ page }) => {
    const f = await installCommitmentWorkspaceFixture(page);
    try {
      f.store.stagePendingWrite('commitment', 'maya-outbound', { staged_at: Date.now(), operation: 'update', dirty_fields: ['statement'], state: 'awaiting_verify' });
      f.store.writeCommitment({ ...f.store.readCommitment('maya-inbound')!, lifecycle_state: 'expired', expiry_policy: 'strict_expire' });
      await page.goto(`${HARNESS_URL}?data=contacts#data/commitment`);
      await listRows(page).filter({ hasText: 'Send Maya the revised proposal' }).getByRole('button').click();
      const reader = page.locator('.work-entity-commitment-reader');
      await expect(reader).toContainText('A change is waiting for source confirmation.');
      await expect(reader.getByRole('button', { name: 'Mark fulfilled', exact: true })).toHaveCount(0);
      await expect(reader.getByRole('button', { name: 'Cancel commitment', exact: true })).toHaveCount(0);
      await expect(reader.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      expect(f.writes).toEqual([]);
      await reader.getByRole('button', { name: 'Back to commitments', exact: true }).click();
      await selectView(page, 'inbound', 'closed');
      await listRows(page).filter({ hasText: 'Maya will send the signed agreement' }).getByRole('button').click();
      await expect(reader.locator('[data-commitment-status]')).toHaveText('Expired');
      await expect(reader.getByRole('button', { name: 'Mark fulfilled', exact: true })).toHaveCount(0);
      await reader.getByRole('button', { name: 'Edit', exact: true }).click();
      const editor = page.locator('.work-entity-dialog[data-mode="edit"]');
      await expect(editor.getByRole('button', { name: 'Mark fulfilled', exact: true })).toHaveCount(0);
      await expect(editor.getByRole('button', { name: 'Cancel commitment', exact: true })).toBeVisible();
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await reader.getByRole('button', { name: 'Cancel commitment', exact: true }).click();
      await expect(reader.locator('[data-commitment-status]')).toHaveText('Cancelled');
      expect(f.writes).toEqual([{ method: 'work_entity.commitment.cancel', args: { id: 'maya-inbound' } }]);
      expect(f.store.readCommitment('maya-inbound')?.lifecycle_state).toBe('cancelled');
    } finally { f.close(); }
  });
});
