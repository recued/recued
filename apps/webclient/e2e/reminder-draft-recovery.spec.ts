import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installReminderWorkspaceFixture, REMINDER_WORKSPACE_NOW as NOW } from './helpers/reminder-workspace-fixture.js';
import type { ReminderDraftEntry } from '../src/reminders/reminder-draft-recovery.js';

installFullAppHooks();
test.use({ timezoneId: 'Asia/Tokyo' });
const form = (page: Page) => page.locator('[data-reminder-create-form]');
const message = (page: Page) => form(page).getByRole('textbox', { name: 'Reminder', exact: true });
const time = (page: Page) => form(page).getByLabel('Date and time (America/New_York)', { exact: true });
const recovery = (page: Page) => page.getByRole('region', { name: 'Unfinished reminders and alarms', exact: true });
const found = (page: Page) => page.getByRole('region', { name: 'Unfinished work search results', exact: true });
const stored = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('recued.reminder.draft-recovery.v1:'))
  .flatMap(key => JSON.parse(sessionStorage.getItem(key)!) as ReminderDraftEntry[]));
const go = async (page: Page, hash = '#data/reminder') => {
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&server_profiles=multiple${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const boot = async (page: Page) => {
  await page.clock.setFixedTime(new Date(NOW)); const fixture = await installReminderWorkspaceFixture(page, true);
  await go(page); return fixture;
};
const open = async (page: Page, text: string) => {
  await page.getByRole('button', { name: 'New reminder', exact: true }).click(); await message(page).fill(text);
};
const search = async (page: Page, text: string) => {
  await page.evaluate(() => window.__app.setHash('#data/search'));
  await page.getByRole('searchbox', { name: 'Search everything', exact: true }).fill(text);
  await expect(found(page)).toHaveAttribute('aria-busy', 'false');
};

test('recovers the latest exact input immediately after refresh and saves in its original server zone', async ({ page }, info) => {
  const f = await boot(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const words = 'Call Café 😀\n <img src=x> & review'; await open(page, words);
    await time(page).fill('2026-11-02T09:15'); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(recovery(page)).toContainText(words);
    const kept = (await stored(page))[0]!;
    f.setZone('Europe/Paris');
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(message(page)).toHaveValue(words); await expect(message(page)).toBeFocused(); await expect(time(page)).toHaveValue('2026-11-02T09:15');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: 'disabled', fullPage: true, path: info.outputPath('reminder-recovery-phone.png') });
    expect(f.creates).toEqual([]); await form(page).getByRole('button', { name: 'Set reminder', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    expect(f.creates).toEqual([{ text: 'Call Café 😀 <img src=x> & review', at: Date.parse('2026-11-02T14:15Z'), creation_id: kept.values.creationId }]);
    expect(f.pendingCount()).toBe(1); expect(await stored(page)).toEqual([]);
  } finally { f.dispose(); }
});

test('keeps a draft by keyboard, finds it under Drafts, and returns to the original search after saving', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page, 'Kestrel call later'); await time(page).fill('2026-11-03T11:45');
    const keep = form(page).getByRole('button', { name: 'Keep draft for later', exact: true }); await keep.focus(); await page.keyboard.press('Enter');
    await expect(form(page)).toHaveCount(0); await expect(recovery(page).getByRole('button', { name: 'Resume draft', exact: true })).toBeFocused();
    expect(f.creates).toEqual([]); const kept = (await stored(page))[0]!;
    await search(page, 'Kestrel call later'); const choice = found(page).getByRole('button', { name: 'Resume reminder draft Kestrel call later', exact: true });
    await choice.focus(); await page.keyboard.press('Enter'); await expect(message(page)).toHaveValue('Kestrel call later');
    await form(page).getByRole('button', { name: 'Set reminder', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(f.creates[0]?.creation_id).toBe(kept.values.creationId);
    await page.getByRole('tab', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('searchbox', { name: 'Search everything', exact: true })).toHaveValue('Kestrel call later');
    await expect(found(page).locator('[data-recovery-draft-key]')).toHaveCount(0);
  } finally { f.dispose(); }
});

test('keeps an Automation alarm and resumes its exact alarm panel through Universal Search', async ({ page }) => {
  const f = await boot(page);
  try {
    await page.evaluate(() => window.__app.setHash('#automation/schedules'));
    await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
    await page.getByLabel('Schedule type', { exact: true }).selectOption('alarm');
    await form(page).getByRole('textbox', { name: 'Alarm message', exact: true }).fill('Take medicine Kestrel');
    await time(page).fill('2026-11-02T12:30');
    await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click();
    await expect(form(page)).toHaveCount(0); const kept = (await stored(page))[0]!;
    await search(page, 'alarm medicine');
    await found(page).getByRole('button', { name: 'Resume alarm draft Take medicine Kestrel', exact: true }).click();
    await expect(form(page).getByRole('heading', { name: 'Alarm details', exact: true })).toBeVisible();
    await expect(form(page).getByRole('textbox', { name: 'Alarm message', exact: true })).toHaveValue('Take medicine Kestrel');
    await expect(time(page)).toHaveValue('2026-11-02T12:30'); expect(f.creates).toEqual([]);
    await form(page).getByRole('button', { name: 'Create alarm', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(f.creates[0]).toMatchObject({ text: 'Take medicine Kestrel', creation_id: kept.values.creationId, at: Date.parse('2026-11-02T17:30Z') });
    expect(f.pendingCount()).toBe(1); expect(await stored(page)).toEqual([]);
  } finally { f.dispose(); }
});

test('checks an interrupted save after it rang with the original identity and past instant, without a duplicate', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page, 'Call after results'); await time(page).fill('2026-11-01T10:02'); f.loseNextCreate();
    await form(page).getByRole('button', { name: 'Set reminder', exact: true }).press('Enter');
    await expect(form(page).getByRole('button', { name: 'Check save', exact: true })).toBeFocused();
    await expect(message(page)).toBeDisabled(); await expect(time(page)).toBeDisabled();
    const id = f.createdId()!, original = f.creates[0]!;
    await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click();
    const later = NOW + 180_000; f.setNow(later); f.deliver(id); await page.clock.setFixedTime(new Date(later));
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(form(page).getByRole('button', { name: 'Check save', exact: true })).toBeFocused();
    await expect(time(page)).toHaveValue('2026-11-01T10:02'); await expect(time(page)).toBeDisabled();
    await form(page).getByRole('button', { name: 'Check save', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(f.creates).toEqual([original, original]); expect(f.createdId()).toBe(id); expect(f.pendingCount()).toBe(0);
    expect(f.get(id)).toMatchObject({ state: 'delivered', at: original.at }); expect(await stored(page)).toEqual([]);
  } finally { f.dispose(); }
});

test('persists in-flight creation before dispatch, blocks competing actions, and recovers after refresh', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page, 'Held creation'); f.holdNextCreate();
    await form(page).getByRole('button', { name: 'Set reminder', exact: true }).click(); await expect.poll(f.createPending).toBe(true);
    const copy = (await stored(page))[0]!; expect(copy.status).toBe('pending'); expect(copy.values.request).toEqual(f.creates[0]);
    await expect(form(page).getByRole('button', { name: 'Keep draft for later', exact: true })).toBeDisabled();
    await expect(form(page).getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click(); await expect(form(page)).toBeVisible();
    expect(f.creates).toHaveLength(1);
    await page.reload(); f.releaseCreate(); await page.waitForFunction(() => window.__app?.ready === true);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await form(page).getByRole('button', { name: 'Check save', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(f.creates).toHaveLength(2); expect(f.creates[1]).toEqual(f.creates[0]); expect(f.pendingCount()).toBe(1);
  } finally { f.dispose(); }
});

test('keeps the editor after write, read-back or discard failure and never dispatches without recovery', async ({ page }) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    Storage.prototype.getItem = function(key) {
      if (key.startsWith('recued.reminder.draft-recovery.v1:') && document.documentElement.dataset.recoveryRead === 'blocked') throw Error('Read blocked');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('recued.reminder.draft-recovery.v1:') && document.documentElement.dataset.recoveryWrite === 'blocked') throw Error('Write blocked');
      set.call(this, key, value);
    };
    Storage.prototype.removeItem = function(key) {
      if (key.startsWith('recued.reminder.draft-recovery.v1:') && document.documentElement.dataset.recoveryWrite === 'blocked') throw Error('Remove blocked');
      remove.call(this, key);
    };
  });
  const f = await boot(page);
  try {
    await page.evaluate(() => { document.documentElement.dataset.recoveryWrite = 'blocked'; });
    await open(page, 'Latest unpersisted words');
    await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('could not be confirmed'); await expect(message(page)).toHaveValue('Latest unpersisted words');
    await form(page).getByRole('button', { name: 'Set reminder', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('save could not start'); expect(f.creates).toEqual([]);
    await page.evaluate(() => { delete document.documentElement.dataset.recoveryWrite; });
    await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await page.evaluate(() => { document.documentElement.dataset.recoveryRead = 'blocked'; });
    await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('could not be confirmed');
    await page.evaluate(() => { delete document.documentElement.dataset.recoveryRead; document.documentElement.dataset.recoveryWrite = 'blocked'; });
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('could not be discarded');
    await page.evaluate(() => { delete document.documentElement.dataset.recoveryWrite; });
    await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect((await stored(page))[0]?.values.text).toBe('Latest unpersisted words'); expect(f.creates).toEqual([]);
  } finally { f.dispose(); }
});

test('rejects a changed search selection and isolates drafts from a different pairing', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page, 'Kestrel stale selection'); await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click();
    await search(page, 'Kestrel stale selection');
    await page.evaluate(() => {
      for (const key of Object.keys(sessionStorage).filter(key => key.startsWith('recued.reminder.draft-recovery.v1:'))) {
        const entries = JSON.parse(sessionStorage.getItem(key)!) as ReminderDraftEntry[];
        entries[0]!.values.text = 'Newer owner input'; sessionStorage.setItem(key, JSON.stringify(entries));
      }
    });
    await found(page).locator('[data-recovery-draft-key]').click();
    await expect(form(page)).toHaveCount(0); await expect(page.getByRole('searchbox', { name: 'Search everything', exact: true })).toBeVisible();
    await page.evaluate(() => {
      for (const key of Object.keys(sessionStorage).filter(key => key.startsWith('recued.reminder.draft-recovery.v1:'))) {
        sessionStorage.setItem('recued.reminder.draft-recovery.v1:foreign-pairing', sessionStorage.getItem(key)!); sessionStorage.removeItem(key);
      }
    });
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await page.getByRole('searchbox', { name: 'Search everything', exact: true }).fill('Newer owner input');
    await expect(found(page).locator('[data-recovery-draft-key]')).toHaveCount(0); expect(f.creates).toEqual([]);
  } finally { f.dispose(); }
});

test('confirms removal of an unconfirmed recovery copy without cancelling its existing reminder', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page, 'Keep existing reminder'); f.loseNextCreate();
    await form(page).getByRole('button', { name: 'Set reminder', exact: true }).click();
    await expect(form(page).getByRole('button', { name: 'Check save', exact: true })).toBeVisible();
    await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click();
    const id = f.createdId()!; await recovery(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
    const confirm = recovery(page).getByRole('group', { name: 'Discard reminder recovery?', exact: true });
    await expect(confirm.getByRole('button', { name: 'Keep draft', exact: true })).toBeFocused();
    await confirm.getByRole('button', { name: 'Discard recovery copy', exact: true }).click();
    await expect(recovery(page)).toHaveCount(0); expect(await stored(page)).toEqual([]);
    expect(f.get(id)?.state).toBe('pending'); expect(f.creates).toHaveLength(1); expect(f.pendingCount()).toBe(1);
  } finally { f.dispose(); }
});
