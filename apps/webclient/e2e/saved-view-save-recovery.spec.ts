import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { expect, test, type Page } from '@playwright/test';
import type { SavedDataView, SavedDataViewCreateOnceRequest } from '@recued/contracts';
import { openSavedViewList } from './helpers/saved-data-views.js';

const BASE = `${HARNESS_ORIGIN}/full-app-harness.html`;
const KEY = 'recued-test-saved-data-views';
const ID = 'view_00000000-0000-4000-8000-000000000001';
const tools = (page: Page) => page.locator('[data-saved-data-views]');
const query = (page: Page) => page.locator('[data-recued-data-contact-search]');
const status = (page: Page) => tools(page).locator('[data-view-create-status]');
const notice = (page: Page) => tools(page).locator('[data-view-notice]');
const stored = (page: Page): Promise<SavedDataView[]> => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? '[]'), KEY);
type Reply = { result?: unknown; error?: { code: string; message: string } };
interface SaveRecoveryFixture {
  writes: SavedDataViewCreateOnceRequest[];
  next: 'lost' | 'not-applied' | 'malformed' | 'rejected' | null;
  failChecks: boolean;
  nextCheck: 'missing' | 'rejected' | null;
  holdWrite: boolean;
  release(): void;
  mutate: 'removed' | 'changed' | null;
}
declare global { interface Window { __saveRecovery: SaveRecoveryFixture } }

let errors: string[] = [], interruptions: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = []; interruptions = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { interruptions.push(dialog.type()); void dialog.dismiss(); });
  page.on('popup', popup => { interruptions.push('popup'); void popup.close(); });
});
test.afterEach(() => { expect(errors).toEqual([]); expect(interruptions).toEqual([]); });

const boot = async (page: Page, options: { legacy?: boolean; copy?: boolean } = {}) => {
  if (options.copy) await page.addInitScript(({ key, id }) => {
    sessionStorage.setItem(key, JSON.stringify([{
      id, name: 'Pack tasks', revision: 3, created_at: 1, updated_at: 2,
      definition: { tab: 'task', query: 'Task', source_id: null, booking_lifecycle: 'all' },
      pack: { publisher: 'vendor', slug: 'work' },
      alert: { enabled: true, time_zone: 'UTC', status: 'watching', last_checked_at: 2, last_notified_at: null },
    }]));
  }, { key: KEY, id: ID });
  await page.goto(`${BASE}?data=${options.copy ? 'work-entities-paged&task_filters=1' : 'contacts'}${options.legacy ? '&saved_views_protocol=legacy' : ''}#${options.copy ? `views/${ID}` : 'data/contact'}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(tools(page).getByRole('button', { name: options.copy ? 'Save as new' : 'Save current view', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('data_views.list'))).toBeGreaterThan(0);
  await page.evaluate(() => {
    let release: () => void = () => {};
    const fixture: SaveRecoveryFixture = {
      writes: [], next: 'lost', failChecks: false, nextCheck: null, holdWrite: false, mutate: null,
      release: () => release(),
    };
    Object.assign(window, {
      __saveRecovery: fixture,
      __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
        if (method === 'data_views.creation.get' && fixture.nextCheck) {
          const next = fixture.nextCheck; fixture.nextCheck = null;
          return next === 'missing' ? { result: { creation: null } }
            : { error: { code: 'bad_request', message: 'Confirmation is temporarily refused.' } };
        }
        if (method === 'data_views.creation.get' && fixture.failChecks) {
          return { error: { code: 'connection_lost', message: 'The connection was interrupted.' } };
        }
        if (method !== 'data_views.create_once' && method !== 'data_views.create') return undefined;
        const input = args as SavedDataViewCreateOnceRequest;
        fixture.writes.push(structuredClone(input));
        if (fixture.holdWrite) await new Promise<void>(resolve => { release = resolve; });
        const next = fixture.next; fixture.next = null;
        const rows: SavedDataView[] = JSON.parse(sessionStorage.getItem('recued-test-saved-data-views') ?? '[]');
        const receipts: Record<string, { view_id: string }> = JSON.parse(sessionStorage.getItem('recued-test-saved-data-view-creations') ?? '{}');
        const id = receipts[input.request_id]?.view_id ?? rows.at(-1)?.id;
        const replay = fixture.writes.slice(0, -1).some(write => write.request_id === input.request_id);
        if (next === 'not-applied' || next === 'rejected' && !replay) {
          sessionStorage.setItem('recued-test-saved-data-views', JSON.stringify(rows.filter(row => row.id !== id)));
          delete receipts[input.request_id];
          sessionStorage.setItem('recued-test-saved-data-view-creations', JSON.stringify(receipts));
        } else if (fixture.mutate === 'removed') {
          sessionStorage.setItem('recued-test-saved-data-views', JSON.stringify(rows.filter(row => row.id !== id)));
        } else if (fixture.mutate === 'changed') {
          const row = rows.find(row => row.id === id)!;
          row.name = 'Updated elsewhere'; row.revision++;
          row.definition = { tab: 'contact', query: 'Newer settings' };
          sessionStorage.setItem('recued-test-saved-data-views', JSON.stringify(rows));
        }
        if (next === 'rejected') return { error: { code: 'bad_request', message: 'Choose a different name.' } };
        if (next === 'malformed') return { result: { request_id: crypto.randomUUID(), view_id: id, view: rows.at(-1) } };
        if (next) return { error: { code: 'connection_lost', message: 'The save reply was interrupted.' } };
        return undefined;
      },
    });
  });
};
const begin = async (page: Page, copy = false) => {
  if (!copy) await query(page).fill('Acme');
  await tools(page).getByRole('button', { name: copy ? 'Save as new' : 'Save current view', exact: true }).click();
  await tools(page).getByLabel('View name', { exact: true }).fill('Work contacts');
  await tools(page).getByRole('button', { name: 'Save view', exact: true }).click();
};

test('confirms an applied save after its reply is lost without issuing another create', async ({ page }) => {
  await boot(page); await begin(page);
  await expect(notice(page)).toContainText('Saved “Work contacts”');
  expect(await stored(page)).toEqual([expect.objectContaining({ name: 'Work contacts', definition: { tab: 'contact', query: 'Acme' } })]);
  expect(await page.evaluate(() => window.__saveRecovery.writes.length)).toBe(1);
  expect(await page.evaluate(() => window.__app.rpcCallCount('data_views.creation.get'))).toBe(1);
  await expect(tools(page).locator('[data-view-editor]')).toHaveCount(0);
});

test('keeps an unconfirmed save inline and checks it after reconnecting, even after closing the editor', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await boot(page);
  await page.evaluate(() => { window.__saveRecovery.failChecks = true; });
  await begin(page);
  await expect(status(page)).toContainText('Could not check this save');
  await expect(tools(page).getByLabel('View name', { exact: true })).toHaveValue('Work contacts');
  await expect(tools(page).getByLabel('View name', { exact: true })).toHaveAttribute('readonly', '');
  await expect(tools(page).getByRole('button', { name: 'Save view', exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('save-confirmation-phone.png'), fullPage: true });
  await tools(page).getByRole('button', { name: 'Close', exact: true }).click();
  await tools(page).getByRole('button', { name: 'Check saved view', exact: true }).click();
  await page.evaluate(() => { window.__saveRecovery.failChecks = false; });
  await tools(page).locator('[data-view-action="check-create"]').click();
  await expect(notice(page)).toContainText('Saved “Work contacts”');
  expect(await stored(page)).toHaveLength(1);
  expect(await page.evaluate(() => window.__saveRecovery.writes.length)).toBe(1);
});

test('retries a missing receipt with the same identity and captured filters while preserving the live search', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.__saveRecovery.next = 'not-applied'; });
  await begin(page);
  await expect(status(page)).toContainText('has not been confirmed');
  expect(await stored(page)).toEqual([]);
  await query(page).fill('Changed while recovering');
  await expect(tools(page).locator('[data-view-create-settings]')).toContainText('Acme');
  await page.screenshot({ path: test.info().outputPath('save-retry-desktop.png'), fullPage: true });
  await tools(page).getByRole('button', { name: 'Try saving again', exact: true }).click();
  await expect(notice(page)).toContainText('Saved “Work contacts”');
  const writes = await page.evaluate(() => window.__saveRecovery.writes);
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect(await stored(page)).toEqual([expect.objectContaining({ definition: { tab: 'contact', query: 'Acme' } })]);
  await expect(query(page)).toHaveValue('Changed while recovering');
});

test('Save as new recovers an owner copy without changing the pack view or copying its alert', async ({ page }) => {
  await boot(page, { copy: true });
  const original = (await stored(page))[0]!;
  await begin(page, true);
  await expect(notice(page)).toContainText('Saved “Work contacts”');
  const rows = await stored(page);
  expect(rows).toHaveLength(2); expect(rows[0]).toEqual(original);
  expect(rows[1]).toMatchObject({ definition: original.definition, revision: 1 });
  expect(rows[1]).not.toHaveProperty('pack'); expect(rows[1]).not.toHaveProperty('alert');
  expect(await page.evaluate(() => window.__saveRecovery.writes.length)).toBe(1);
  await expect(page).toHaveURL(new RegExp(`#views/${ID}$`));
});

test('a refused retry still checks the original unconfirmed save before releasing its identity', async ({ page }) => {
  await boot(page);
  // A read can precede a delayed original write. The fixture keeps that write
  // but returns the earlier missing-receipt observation.
  await page.evaluate(() => { window.__saveRecovery.nextCheck = 'missing'; });
  await begin(page);
  await expect(status(page)).toContainText('has not been confirmed');
  await page.evaluate(() => { window.__saveRecovery.next = 'rejected'; });
  await tools(page).getByRole('button', { name: 'Try saving again', exact: true }).click();
  await expect(notice(page)).toContainText('Saved “Work contacts”');
  const writes = await page.evaluate(() => window.__saveRecovery.writes);
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect(await stored(page)).toHaveLength(1);
});

test('a confirmation refusal keeps an accepted save unconfirmed rather than allowing a fresh creation', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.__saveRecovery.next = null; window.__saveRecovery.nextCheck = 'rejected'; });
  await begin(page);
  await expect(status(page)).toContainText('Confirmation is temporarily refused');
  await expect(tools(page).getByLabel('View name', { exact: true })).toHaveAttribute('readonly', '');
  await expect(tools(page).getByRole('button', { name: 'Save view', exact: true })).toHaveCount(0);
  await tools(page).locator('[data-view-action="check-create"]').click();
  await expect(notice(page)).toContainText('Saved “Work contacts”');
  expect(await page.evaluate(() => window.__saveRecovery.writes.length)).toBe(1);
  expect(await stored(page)).toHaveLength(1);
});

test('recovery remains reachable after the source bookmark disappears', async ({ page }) => {
  await boot(page, { copy: true });
  await page.evaluate(() => { window.__saveRecovery.failChecks = true; });
  await begin(page, true);
  await expect(status(page)).toContainText('Could not check this save');
  await tools(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(({ key, id }) => {
    const rows: SavedDataView[] = JSON.parse(sessionStorage.getItem(key)!);
    sessionStorage.setItem(key, JSON.stringify(rows.filter(row => row.id !== id)));
  }, { key: KEY, id: ID });
  await openSavedViewList(page);
  await tools(page).locator(`details [data-view-action="open"][data-view-id="${ID}"]`).click();
  await expect(page.locator('[data-view-load-retry]')).toBeVisible();
  const check = tools(page).getByRole('button', { name: 'Check saved view', exact: true });
  await expect(check).toBeVisible(); await check.click();
  await expect(tools(page).getByLabel('View name', { exact: true })).toHaveValue('Work contacts');
  await page.evaluate(() => { window.__saveRecovery.failChecks = false; });
  await tools(page).locator('[data-view-action="check-create"]').click();
  await expect(notice(page)).toContainText('Saved “Work contacts”');
  expect(await stored(page)).toHaveLength(1);
  expect(await page.evaluate(() => window.__saveRecovery.writes.length)).toBe(1);
});

test('respects a view removed before confirmation and never recreates it', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.__saveRecovery.mutate = 'removed'; });
  await begin(page);
  await expect(notice(page)).toContainText('saved and later removed');
  expect(await stored(page)).toEqual([]);
  expect(await page.evaluate(() => window.__saveRecovery.writes.length)).toBe(1);
  await expect(tools(page).locator('[data-view-editor]')).toHaveCount(0);
});

test('confirms the latest view rather than reporting stale settings from a malformed reply', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.__saveRecovery.next = 'malformed'; window.__saveRecovery.mutate = 'changed'; });
  await begin(page);
  await expect(notice(page)).toContainText('now “Updated elsewhere” with newer settings');
  expect(await stored(page)).toEqual([expect.objectContaining({ name: 'Updated elsewhere', revision: 2, definition: { tab: 'contact', query: 'Newer settings' } })]);
  expect(await page.evaluate(() => window.__saveRecovery.writes.length)).toBe(1);
  await expect(query(page)).toHaveValue('Acme');
});

test('an explicit refusal keeps the draft editable for a corrected save', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.__saveRecovery.next = 'rejected'; });
  await begin(page);
  await expect(tools(page).getByRole('alert')).toContainText('Choose a different name');
  await expect(tools(page).getByLabel('View name', { exact: true })).not.toHaveAttribute('readonly', '');
  await tools(page).getByLabel('View name', { exact: true }).fill('Corrected name');
  await tools(page).getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(notice(page)).toContainText('Saved “Corrected name”');
  const writes = await page.evaluate(() => window.__saveRecovery.writes);
  expect(writes).toHaveLength(2); expect(writes[1]!.request_id).not.toBe(writes[0]!.request_id);
  expect(await stored(page)).toHaveLength(1);
});

test('legacy servers still save normally and offer read-only inspection after an uncertain save', async ({ page }) => {
  await boot(page, { legacy: true });
  await page.evaluate(() => { window.__saveRecovery.next = null; });
  await begin(page);
  await expect(notice(page)).toContainText('Saved “Work contacts”');
  await page.evaluate(() => { window.__saveRecovery.next = 'lost'; });
  await begin(page);
  await expect(status(page)).toContainText('could not be confirmed');
  await expect(tools(page).getByRole('button', { name: 'Try saving again', exact: true })).toHaveCount(0);
  await expect(tools(page).getByRole('link', { name: 'Open Saved views', exact: true })).toBeVisible();
  const lists = await page.evaluate(() => window.__app.rpcCallCount('data_views.list'));
  await tools(page).locator('[data-view-action="check-create"]').click();
  await expect(status(page)).toContainText('Inspect Saved views');
  expect(await page.evaluate(() => window.__app.rpcCallCount('data_views.list'))).toBe(lists + 1);
  expect(await page.evaluate(() => window.__app.rpcCallCount('data_views.create_once'))).toBe(0);
  expect(await page.evaluate(() => window.__saveRecovery.writes.length)).toBe(2);
  expect(await stored(page)).toHaveLength(2);
});
