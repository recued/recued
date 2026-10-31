import { expect, test, type Page } from '@playwright/test';
import { clickActionGlyph } from './helpers/action-glyph.js';
import { openBackupCopyDetails, openBackupDisclosure } from './helpers/backup-disclosure.js';

type RequestKind = Parameters<Window['__backupStatus']['release']>[0];
const release = (page: Page, kind: RequestKind, index = 0) =>
  page.evaluate(({ kind, index }) => window.__backupStatus.release(kind, index), { kind, index });
const count = (page: Page, kind: RequestKind) =>
  page.evaluate(kind => window.__backupStatus.calls.filter(call => call.kind === kind).length, kind);
const errors = new Map<Page, string[]>();
test.beforeEach(({ page }) => {
  const seen: string[] = []; errors.set(page, seen); page.on('pageerror', error => seen.push(error.message));
});
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

const open = async (page: Page, mode: 'empty' | 'running' | 'cleanup' = 'empty') => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') });
  await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z'));
  await page.goto(`/backup-status-refresh-harness.html?drills=${mode}&schedule=configured`);
  await page.waitForFunction(() => window.__backupStatus !== undefined);
  await openBackupDisclosure(page, 'tools');
  for (const kind of ['destinations', 'history', 'health', 'integrity'] as const) await release(page, kind);
  await expect(page.getByRole('button', { name: 'Refresh backup status', exact: true })).toHaveAttribute('aria-busy', 'false');
};

for (const kind of ['health', 'integrity', 'unattended'] as const) {
  test(`${kind} Save and Discard glyphs preserve the schedule payload and send one save`, async ({ page }) => {
    await open(page);
    if (kind === 'unattended') await openBackupDisclosure(page, 'schedule');
    const prefix = kind === 'unattended' ? 'unattended' : `backup-${kind}`;
    const field = page.locator(`[data-${prefix}-${kind === 'health' ? 'hours' : 'time'}]`);
    const save = page.locator(`[data-${prefix}-save]`);
    const discard = page.locator(`[data-${prefix}-discard]`);
    const original = await field.inputValue();
    const next = kind === 'health' ? '48' : '06:45';
    await field.fill(next);
    await clickActionGlyph(page, discard);
    await expect(field).toHaveValue(original);
    expect(await count(page, `save-${kind}`)).toBe(0);
    await field.fill(next);
    await clickActionGlyph(page, save);
    await expect(save).toBeDisabled();
    await clickActionGlyph(page, save);
    expect(await count(page, `save-${kind}`)).toBe(1);
    const submitted = await page.evaluate(kind => window.__backupStatus.calls.find(call => call.kind === `save-${kind}`)?.policy, kind);
    expect(submitted).toMatchObject(kind === 'health'
      ? { alerts_enabled: true, backup_max_age_hours: 48, recovery_max_age_days: 30 }
      : kind === 'integrity'
        ? { enabled: true, schedule: { cadence: 'weekly', hour_utc: 6, minute_utc: 45, weekday_utc: 0 } }
        : { enabled: true, keep_last: 5, schedule: { cadence: 'daily', hour_utc: 6, minute_utc: 45, weekday_utc: 0 } });
    await release(page, `save-${kind}`);
    if (kind !== 'unattended') await release(page, kind, 1);
    await expect(page.locator(`[data-${prefix}-feedback]`)).toContainText(/saved/i);
    await expect(field).toHaveValue(next);
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
  });
}

test('backup Refresh and stored-copy glyphs keep reads separate from explicit checks', async ({ page }) => {
  await open(page);
  const row = page.locator('[data-remote-backup-id]').first();
  await openBackupCopyDetails(row);
  await clickActionGlyph(page, row.getByRole('button', { name: 'Test recovery', exact: true }));
  const words = page.locator('[data-drill-words]');
  await words.fill('synthetic unsubmitted recovery words');
  const refresh = page.getByRole('button', { name: 'Refresh backup status', exact: true });
  await clickActionGlyph(page, refresh);
  await expect(refresh).toContainText('Refreshing');
  await clickActionGlyph(page, refresh);
  expect(await count(page, 'history')).toBe(2);
  expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
  for (const kind of ['destinations', 'history', 'health', 'integrity'] as const) await release(page, kind, 1);
  await expect(refresh).toHaveAttribute('aria-busy', 'false');
  await expect(words).toHaveValue('synthetic unsubmitted recovery words');
  const check = row.getByRole('button', { name: 'Check stored copy', exact: true });
  await clickActionGlyph(page, check);
  await clickActionGlyph(page, check);
  expect(await count(page, 'check')).toBe(1);
  expect(await page.evaluate(() => window.__backupStatus.calls.find(call => call.kind === 'check')?.policy))
    .toEqual({ operation_id: '12345678-1234-4234-8234-123456789abc' });
  await release(page, 'check');
  await expect(row).toContainText('Stored copy verified');
  expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['check']);
});

test('restore glyphs prepare once and open a preview only after a separate explicit action', async ({ page }) => {
  await open(page);
  const prepare = page.getByRole('button', { name: 'Prepare a restore', exact: true });
  await clickActionGlyph(page, prepare);
  await clickActionGlyph(page, prepare);
  expect(await count(page, 'retrieve')).toBe(1);
  await release(page, 'retrieve');
  const preview = page.getByRole('button', { name: 'Open restore preview', exact: true });
  await expect(preview).toBeVisible();
  expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['retrieve']);
  await clickActionGlyph(page, preview);
  expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['retrieve', 'restore']);
  expect(await count(page, 'retrieve')).toBe(1);
});

test('recovery Run glyph submits once and clears the submitted recovery words', async ({ page }) => {
  await open(page);
  const row = page.locator('[data-remote-backup-id]').first();
  await openBackupCopyDetails(row);
  await clickActionGlyph(page, row.getByRole('button', { name: 'Test recovery', exact: true }));
  const words = page.locator('[data-drill-words]');
  await words.fill('synthetic setup words');
  const start = page.getByRole('button', { name: 'Run recovery test', exact: true });
  await clickActionGlyph(page, start);
  await expect(words).toHaveValue('');
  await expect(start).toBeDisabled();
  await clickActionGlyph(page, start);
  expect(await count(page, 'start-drill')).toBe(1);
  expect(await page.evaluate(() => window.__backupStatus.calls.find(call => call.kind === 'start-drill')?.policy))
    .toMatchObject({ backup_operation_id: '12345678-1234-4234-8234-123456789abc' });
  await release(page, 'start-drill');
  await expect(page.locator('[data-drill-feedback]')).toContainText('server is running the test');
  expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['start-drill']);
});

for (const action of ['cancel', 'cleanup'] as const) {
  test(`recovery ${action} glyph acts on its receipt once and refresh does not repeat it`, async ({ page }) => {
    await open(page, action === 'cancel' ? 'running' : 'cleanup');
    await expect(page.locator(action === 'cancel' ? '[data-drill-cleanup]' : '[data-drill-cancel]')).toBeHidden();
    const control = page.getByRole('button', { name: action === 'cancel' ? 'Cancel test' : 'Retry cleanup', exact: true });
    await clickActionGlyph(page, control);
    await expect(control).toBeDisabled();
    await clickActionGlyph(page, control);
    expect(await count(page, `${action}-drill`)).toBe(1);
    expect(await page.evaluate(action => window.__backupStatus.calls.find(call => call.kind === `${action}-drill`)?.policy, action))
      .toEqual({ operation_id: '22345678-1234-4234-8234-123456789abc' });
    await release(page, `${action}-drill`);
    await expect(page.locator('[data-drill-feedback]')).toContainText(action === 'cancel' ? 'Cancellation requested' : 'Temporary files are gone');
    await clickActionGlyph(page, page.getByRole('button', { name: 'Refresh recovery receipts', exact: true }));
    expect(await count(page, `${action}-drill`)).toBe(1);
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([`${action}-drill`]);
  });
}
