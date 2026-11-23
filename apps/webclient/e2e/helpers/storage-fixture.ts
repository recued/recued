import { expect, type Page } from '@playwright/test';
import { FIXED_NOW, HARNESS_URL } from './full-app.js';

export const STORAGE_RECORDS = 'records:fixture/body-signals/daily_metric';
type Reply = { result?: unknown; error?: { code: string; message: string } };
export interface StorageFixture {
  calls: Array<{ method: string; args: Record<string, unknown> }>;
  expectedRuns: Array<Record<string, unknown>>;
  expectedDownloads: number;
  held: string[];
  snapshot: unknown;
  replies: Record<string, Reply[]>;
  release(method: string, index: number, reply?: Reply): void;
  pending(method: string): number;
}
declare global { interface Window { __storageFixture: StorageFixture } }

export const storagePanel = (page: Page) => page.locator('[data-recued-storage-space-host]');
export const storageForm = (page: Page) => storagePanel(page).locator('[data-recued-storage-purge]');
export const storageAction = (page: Page, name: string) => storageForm(page).locator(`[data-recued-storage-action="${name}"]`);
export const storageOutside = (page: Page) => page.getByRole('button', { name: 'Outside Storage settings', exact: true });
export const storageDrain = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
export const storageCalls = (page: Page, method: string) => page.evaluate(method =>
  window.__storageFixture.calls.filter(call => call.method === method).map(call => call.args), method);
export const releaseStorage = (page: Page, method: string, index: number, reply?: Reply) =>
  page.evaluate(args => window.__storageFixture.release(args.method, args.index, args.reply), { method, index, reply });

export const openStorage = async (page: Page, options: { width?: number; readError?: boolean; held?: string[] } = {}) => {
  await page.setViewportSize({ width: options.width ?? 1280, height: 900 });
  await page.clock.setFixedTime(FIXED_NOW);
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(({ now, options }) => {
    const pending = new Map<string, Array<{ resolve(reply: Reply): void; released: boolean }>>();
    const fixture: StorageFixture = {
      calls: [], expectedRuns: [], expectedDownloads: 0, held: options.held ?? [], replies: {},
      snapshot: { measured_at: now, database: { file_bytes: 104857600, free_bytes: 20971520 }, kinds: [
        { kind: 'records:fixture/body-signals/daily_metric', group: 'records', label: 'Body signals · Daily metric', items: 26, item_words: 'rows', oldest_at: now - 31536000000, added_30d: 3, purge: { by: 'saved', export: 'records' } },
        { kind: 'runs', group: 'activity', label: 'Run history', items: 1042, item_words: 'runs', bytes: 10485760, oldest_at: now - 31536000000, added_30d: 12, purge: { by: 'started', export: 'runs' } },
        { kind: 'reading_history', group: 'activity', label: 'Reading history', items: 19, item_words: 'readings', purge: { by: 'taken' } },
        { kind: 'knowledge', group: 'yours', label: 'Your knowledge', items: 8, item_words: 'items', hold: 'yours' },
        { kind: 'source', group: 'assets', label: 'Source files', items: 0, bytes: 0, item_words: 'files', hold: 'with_source' },
        { kind: 'synced_mail', group: 'copies', label: 'Mail copies', bytes: 1048576, item_words: 'messages', hold: 'resyncs' },
        { kind: 'conversations', group: 'conversations', label: 'Conversations', items: 4, item_words: 'conversations', hold: 'not_yet' },
      ] },
      pending: method => (pending.get(method) ?? []).filter(item => !item.released).length,
      release(method, index, reply) {
        const item = pending.get(method)?.[index];
        if (!item || item.released) throw new Error(`No pending ${method} ${index}`);
        item.released = true;
        item.resolve(reply ?? { result: fixture.snapshot });
      },
    };
    if (options.readError) fixture.replies['storage.kinds.read'] = [{ error: { code: 'UNAVAILABLE', message: 'Storage measurement temporarily unavailable.' } }];
    Object.assign(window, { __storageFixture: fixture,
      __connectionsFixture: async (method: string, args: Record<string, unknown>): Promise<Reply | undefined> => {
        if (!method.startsWith('storage.') && method !== 'records.export' && method !== 'audit.export.page') return undefined;
        fixture.calls.push({ method, args });
        const queued = fixture.replies[method]?.shift();
        if (queued) return queued;
        if (fixture.held.includes(method)) return new Promise(resolve => {
          const items = pending.get(method) ?? []; items.push({ resolve, released: false }); pending.set(method, items);
        });
        if (method === 'storage.kinds.read') return { result: fixture.snapshot };
        if (method === 'storage.purge.preview') return { result: { ...args, items: 12, bytes: 1048576, oldest_at: now - 31536000000,
          newest_at: now - 20000000000, token: 'fixture-preview', expires_at: now + 60000 } };
        if (method === 'storage.purge.run') return { result: { kind: args.kind, before: args.before, deleted: 12, blocked: 0, bytes_freed: 1048576 } };
        if (method === 'records.export') return { result: { csv: 'id,value\nold,12\nrecent,14\n', row_count: 2 } };
        return { result: { body: '{"id":"old-run"}\n', entries_in_page: 1 } };
      },
    });
    const button = document.createElement('button'); button.textContent = 'Outside Storage settings'; document.body.append(button);
    window.__app.setHash('#settings/server/storage');
  }, { now: FIXED_NOW, options });
  await expect(storagePanel(page)).toBeVisible();
  if (options.readError) await expect(storagePanel(page).getByRole('alert')).toContainText('Storage measurement temporarily unavailable.');
  else if (!options.held?.includes('storage.kinds.read')) await expect(storagePanel(page).getByRole('rowheader', { name: 'Run history', exact: true })).toBeVisible();
};
export const openStorageKind = async (page: Page, kind = 'runs') => {
  await storagePanel(page).locator('[data-recued-storage-kind]').filter({ has: page.locator(`[data-kind="${kind}"]`) }).getByRole('button').click();
  await expect(storageForm(page)).toBeVisible();
};
export const previewStorage = async (page: Page) => {
  await storageAction(page, 'preview').click();
  await expect(storageForm(page).locator('.storage-space-preview')).toBeVisible();
};
