import { expect, test, type Page } from '@playwright/test';

type Kind = 'health' | 'integrity';
type RequestKind = Kind | 'history' | 'destinations' | 'save-health' | 'save-integrity' | 'save-unattended';
const refresh = (page: Page) => page.getByRole('button', { name: 'Refresh backup status', exact: true });
const freshness = (page: Page, kind: Kind) => page.locator(`[data-backup-${kind}-refresh-status]`);
const time = (page: Page, kind: Kind) => page.locator(`[data-backup-${kind}-last-refreshed]`);
const field = (page: Page, kind: Kind) => page.locator(kind === 'health' ? '[data-backup-health-hours]' : '[data-backup-integrity-time]');
const save = (page: Page, kind: Kind) => page.locator(`[data-backup-${kind}-save]`);
const release = (page: Page, kind: RequestKind, index = 0, outcome: 'success' | 'error' | 'unavailable' = 'success') =>
  page.evaluate(({ kind, index, outcome }) => window.__backupStatus.release(kind, index, outcome), { kind, index, outcome });
const count = (page: Page, kind: RequestKind) => page.evaluate(kind => window.__backupStatus.calls.filter(call => call.kind === kind).length, kind);
const storage = async (page: Page, index = 0) => { await release(page, 'destinations', index); await release(page, 'history', index); };
const open = async (page: Page, ready = true) => {
  await page.goto('/backup-status-refresh-harness.html');
  await page.waitForFunction(() => window.__backupStatus !== undefined);
  await storage(page);
  if (ready) {
    await release(page, 'health'); await release(page, 'integrity');
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
  }
};
const activate = async (page: Page) => { await refresh(page).focus(); await page.keyboard.press('Enter'); };
const readOnly = async (page: Page) => {
  expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
  expect(await page.evaluate(() => window.__backupStatus.calls.filter(call => call.kind.startsWith('save-')))).toEqual([]);
};
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

for (const width of [390, 1280]) {
  test(`Backup setup validation follows field order and clears recovery words on submission at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page);
    const input = (name: string) => page.locator(`[data-unattended-${name}]`);
    const submit = async () => { await input('save').focus(); await page.keyboard.press('Enter'); };
    await input('time').fill(''); await input('keep').fill('31'); await submit();
    await expect(input('destination')).toBeFocused();
    for (const name of ['destination', 'time', 'keep', 'words']) {
      await expect(input(name)).toHaveAttribute('aria-invalid', 'true');
      await expect(input(`${name}-error`)).toBeVisible();
      const message = await input(`${name}-error`).textContent();
      await expect(input(name)).toHaveAccessibleDescription(message!);
    }
    await input('destination').selectOption('Fixture backup storage');
    await expect(input('destination')).not.toHaveAttribute('aria-invalid');
    await submit(); await expect(input('time')).toBeFocused();
    await page.evaluate(() => window.__backupStatus.refresh());
    await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
    await expect(input('time')).toBeFocused(); await expect(input('time')).toHaveValue('');
    await expect(input('keep')).toHaveValue('31'); await readOnly(page);
    await input('time').fill('17:45'); await submit(); await expect(input('keep')).toBeFocused();
    await input('keep').fill('5'); await submit(); await expect(input('words')).toBeFocused();
    await input('words').fill('synthetic setup words');
    await expect(input('words')).not.toHaveAttribute('aria-invalid');
    await submit(); await expect.poll(() => count(page, 'save-unattended')).toBe(1);
    await expect(input('words')).toHaveValue('');
    await input('keep').fill('6'); await expect(input('words')).not.toHaveAttribute('aria-invalid');
    await release(page, 'save-unattended');
    await expect(input('feedback')).toContainText('newer edits'); await expect(input('keep')).toHaveValue('6');
    await expect(input('keep')).toBeFocused();
    expect(await page.evaluate(() => JSON.stringify(window.__backupStatus.calls))).not.toContain('synthetic setup words');
    await expect(page.locator('[data-remote-backups]')).not.toContainText('synthetic setup words');
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  for (const kind of ['health', 'integrity'] as const) {
    test(`Backup ${kind} validation identifies invalid fields and preserves drafts at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page);
      const input = field(page, kind), name = kind === 'health' ? 'hours' : 'time';
      const error = page.locator(`[data-backup-${kind}-${name}-error]`);
      const message = kind === 'health' ? 'Enter a whole number from 1 to 8760 hours.' : 'Enter a UTC time, such as 02:00.';
      await input.fill(''); await save(page, kind).focus(); await page.keyboard.press('Enter');
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await expect(error).toHaveText(message); await expect(error).toBeVisible();
      await expect(input).toHaveAccessibleDescription(message);
      await page.evaluate(() => window.__backupStatus.refresh());
      await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
      await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
      await expect(input).toBeFocused(); await expect(input).toHaveValue('');
      await expect(error).toHaveText(message); await readOnly(page);
      await input.fill(kind === 'health' ? '72' : '17:45');
      await expect(input).not.toHaveAttribute('aria-invalid'); await expect(error).toBeHidden();
      await save(page, kind).focus(); await page.keyboard.press('Enter');
      await expect.poll(() => count(page, `save-${kind}`)).toBe(1);
      await release(page, `save-${kind}`); await release(page, kind, 2);
      await expect(page.locator(`[data-backup-${kind}-feedback]`)).toContainText('saved');
      expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
    });
  }

  test(`Backup status refresh follows both reads and keeps drafts and focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page, false);
    await expect(refresh(page)).toHaveText('Refreshing backup status…');
    await expect(refresh(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await expect(refresh(page)).not.toHaveAttribute('disabled');
    await expect(freshness(page, 'health')).toContainText('No successful status refresh yet.');
    await refresh(page).focus(); await page.keyboard.press('Enter');
    expect(await count(page, 'history')).toBe(1); expect(await count(page, 'health')).toBe(1);
    await release(page, 'health'); await expect(time(page, 'health')).toBeVisible();
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await release(page, 'integrity'); await expect(refresh(page)).toHaveText('Refresh backup status');
    await expect(refresh(page)).toBeFocused();

    const hours = field(page, 'health'), schedule = field(page, 'integrity');
    await hours.fill('72'); await schedule.fill('17:45');
    const hoursNode = await hours.elementHandle(), scheduleNode = await schedule.elementHandle();
    const first = await time(page, 'health').getAttribute('datetime');
    await activate(page);
    await refresh(page).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    expect(await count(page, 'history')).toBe(2); expect(await count(page, 'health')).toBe(2);
    await storage(page, 1);
    await expect(page.locator('[data-remote-backups-status]')).toHaveText('Showing the latest remote backup receipts.');
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await expect(time(page, 'health')).toHaveAttribute('datetime', first!);
    await page.evaluate(() => window.__backupStatus.advance(1_000));
    await release(page, 'health', 1);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await schedule.focus();
    await page.evaluate(() => window.__backupStatus.advance(1_000));
    await release(page, 'integrity', 1);
    await expect(refresh(page)).toHaveText('Refresh backup status');
    await expect(schedule).toBeFocused(); await expect(hours).toHaveValue('72'); await expect(schedule).toHaveValue('17:45');
    await expect(time(page, 'health')).toHaveAttribute('datetime', '2023-11-14T22:13:21.000Z');
    await expect(time(page, 'integrity')).toHaveAttribute('datetime', '2023-11-14T22:13:22.000Z');
    expect(await hoursNode!.evaluate(node => node.isConnected && node === document.querySelector('[data-backup-health-hours]'))).toBe(true);
    expect(await scheduleNode!.evaluate(node => node.isConnected && node === document.querySelector('[data-backup-integrity-time]'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await readOnly(page);
  });

  for (const kind of ['health', 'integrity'] as const) {
    test(`Backup ${kind} status retains successful time on a failed refresh and recovers at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page);
      const prior = await time(page, kind).getAttribute('datetime');
      const input = field(page, kind), draft = kind === 'health' ? '72' : '17:45';
      await input.fill(draft); await activate(page); await storage(page, 1);
      await release(page, kind === 'health' ? 'integrity' : 'health', 1);
      await page.evaluate(() => window.__backupStatus.advance(1_000));
      await release(page, kind, 1, kind === 'health' ? 'error' : 'unavailable');
      await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
      await expect(refresh(page)).toBeFocused();
      await expect(freshness(page, kind)).toContainText('Latest status refresh failed.');
      await expect(time(page, kind)).toHaveAttribute('datetime', prior!);
      await expect(save(page, kind)).toBeDisabled(); await expect(input).toHaveValue(draft);
      await expect(page.locator('[data-remote-backups]')).not.toContainText('private provider');
      await activate(page); await storage(page, 2);
      await expect(time(page, kind)).toHaveAttribute('datetime', prior!);
      await release(page, kind === 'health' ? 'integrity' : 'health', 2);
      await page.evaluate(() => window.__backupStatus.advance(1_000));
      await release(page, kind, 2);
      await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
      await expect(refresh(page)).toBeFocused();
      await expect(time(page, kind)).toHaveAttribute('datetime', '2023-11-14T22:13:22.000Z');
      await expect(freshness(page, kind)).not.toContainText('failed');
      await expect(input).toHaveValue(draft); await readOnly(page);
    });

    for (const oldFirst of [true, false]) {
      test(`Backup ${kind} status recovers an uncertain save and stale read failure (old first: ${oldFirst}) at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 }); await open(page);
        const input = field(page, kind), draft = kind === 'health' ? '72' : '07:00';
        const prior = await time(page, kind).getAttribute('datetime');
        await input.fill(kind === 'health' ? '48' : '05:00');
        await page.evaluate(() => window.__backupStatus.refresh());
        await storage(page, 1); await release(page, kind === 'health' ? 'integrity' : 'health', 1);
        await save(page, kind).focus(); await page.keyboard.press('Enter');
        await input.fill(draft);
        if (oldFirst) {
          await release(page, kind, 1, 'error');
          await expect(freshness(page, kind)).toContainText('Waiting to refresh status after the save.');
        }
        await release(page, `save-${kind}`, 0, 'error');
        await expect(page.locator(`[data-backup-${kind}-feedback]`)).toContainText('could not be confirmed');
        if (!oldFirst) await release(page, kind, 1, 'error');
        await expect.poll(() => count(page, kind)).toBe(3);
        await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
        await expect(freshness(page, kind)).toContainText('Refreshing status…');
        await expect(time(page, kind)).toHaveAttribute('datetime', prior!);
        await page.evaluate(() => window.__backupStatus.advance(4_000));
        await release(page, kind, 2);
        await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
        await expect(time(page, kind)).toHaveAttribute('datetime', '2023-11-14T22:13:24.000Z');
        await expect(input).toHaveValue(draft); await expect(input).toBeFocused();
        await expect(freshness(page, kind)).not.toContainText('failed');
        await expect(page.locator('[data-remote-backups]')).not.toContainText('private provider');
        expect(await count(page, `save-${kind}`)).toBe(1);
        expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
      });
    }

    for (const oldFirst of [true, false]) {
      test(`Backup ${kind} status fences a pre-save read (old first: ${oldFirst}) at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 }); await open(page);
        const input = field(page, kind), submitted = kind === 'health' ? '48' : '05:00', newer = kind === 'health' ? '72' : '07:00';
        const prior = await time(page, kind).getAttribute('datetime');
        await input.fill(submitted);
        await page.evaluate(() => window.__backupStatus.refresh());
        await storage(page, 1); await release(page, kind === 'health' ? 'integrity' : 'health', 1);
        await save(page, kind).focus(); await page.keyboard.press('Enter');
        await expect.poll(() => count(page, `save-${kind}`)).toBe(1);
        await input.fill(newer); await expect(input).toBeFocused();
        await expect(freshness(page, kind)).toContainText('Waiting to refresh status after the save.');
        if (oldFirst) {
          await release(page, kind, 1);
          expect(await count(page, kind)).toBe(2);
          await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
          await expect(time(page, kind)).toHaveAttribute('datetime', prior!);
        }
        await release(page, `save-${kind}`);
        if (!oldFirst) {
          expect(await count(page, kind)).toBe(2);
          await expect(time(page, kind)).toHaveAttribute('datetime', prior!);
          await release(page, kind, 1);
        }
        await expect.poll(() => count(page, kind)).toBe(3);
        await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
        await expect(time(page, kind)).toHaveAttribute('datetime', prior!);
        await page.evaluate(() => window.__backupStatus.advance(3_000));
        await release(page, kind, 2);
        await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
        await expect(time(page, kind)).toHaveAttribute('datetime', '2023-11-14T22:13:23.000Z');
        await expect(input).toHaveValue(newer); await expect(input).toBeFocused();
        await expect(page.locator(kind === 'health' ? '[data-backup-health-feedback]' : '[data-backup-integrity-feedback]')).toContainText('newer edits');
        expect(await count(page, `save-${kind}`)).toBe(1);
        expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
      });
    }
  }
}
