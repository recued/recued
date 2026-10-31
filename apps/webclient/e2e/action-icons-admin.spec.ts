import { expect, test, type Page } from '@playwright/test';
import { clickActionGlyph } from './helpers/action-glyph.js';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
type Write = { method: string; args: unknown };
declare global { interface Window { __adminIconWrites: Write[] } }

const calls = (page: Page, method: string) => page.evaluate(method => window.__app.rpcCallCount(method), method);
const hold = (page: Page, method: string) => page.evaluate(method => window.__app.holdRpcResponses?.(method), method);
const release = (page: Page, method: string) => page.evaluate(method => window.__app.releaseRpcResponses?.(method), method);
const boot = async (page: Page, query = '') => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?${query}&settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
};

test('Updates Check glyph keeps the request single-flight without applying an update', async ({ page }) => {
  await boot(page, 'updates=ready');
  await page.evaluate(() => window.__app.setHash('#settings/updates'));
  const check = page.locator('[data-recued-updates-check]');
  await expect(check).toHaveText('Check for updates');
  await expect(page.locator('[data-recued-updates-status]')).toContainText('latest version');
  const before = await calls(page, 'update.check');
  await hold(page, 'update.check');
  await clickActionGlyph(page, check);
  await expect(check).toHaveText('Checking…');
  await expect(check).toBeDisabled();
  await clickActionGlyph(page, check);
  expect(await calls(page, 'update.check')).toBe(before + 1);
  expect(await release(page, 'update.check')).toBe(1);
  await expect(check).toHaveText('Check for updates');
  await expect(check).toBeEnabled();
  expect(await calls(page, 'update.apply')).toBe(0);
  expect(await calls(page, 'update.rollback')).toBe(0);
});

test('Updates download and Cancel glyphs retain deliberate confirmation and one pending apply', async ({ page }) => {
  await boot(page, 'updates=available-slow-apply');
  await page.evaluate(() => window.__app.setHash('#settings/updates'));
  const apply = page.locator('[data-recued-updates-apply]');
  await expect(apply).toHaveText('Update to 26.8.1');
  await clickActionGlyph(page, apply);
  await expect(apply).toHaveText('Confirm update');
  expect(await calls(page, 'update.apply')).toBe(0);
  await clickActionGlyph(page, page.locator('[data-recued-updates-apply-cancel]'));
  await expect(apply).toHaveText('Update to 26.8.1');
  expect(await calls(page, 'update.apply')).toBe(0);
  await clickActionGlyph(page, apply);
  await hold(page, 'update.apply');
  await clickActionGlyph(page, apply);
  await expect(apply).toHaveText('Updating…');
  await expect(apply).toBeDisabled();
  await clickActionGlyph(page, apply);
  expect(await calls(page, 'update.apply')).toBe(1);
  expect(await release(page, 'update.apply')).toBe(1);
  await expect(apply).toHaveText('Update to 26.8.1');
  expect(await calls(page, 'update.rollback')).toBe(0);
});

test('Updates rollback glyph keeps the pending command single-flight', async ({ page }) => {
  await boot(page, 'updates=ready');
  await page.evaluate(() => {
    Object.assign(window, { __connectionsFixture: async (method: string) => method === 'update.rollback'
      ? { result: { status: 'refused', detail: 'No previous version.' } } : undefined });
    window.__app.setHash('#settings/updates');
  });
  const rollback = page.locator('[data-recued-updates-rollback]');
  await expect(rollback).toBeVisible();
  await hold(page, 'update.rollback');
  await clickActionGlyph(page, rollback);
  await expect(rollback).toHaveText('Rolling back…');
  await expect(rollback).toBeDisabled();
  await clickActionGlyph(page, rollback);
  expect(await calls(page, 'update.rollback')).toBe(1);
  expect(await release(page, 'update.rollback')).toBe(1);
  await expect(rollback).toHaveText('Roll back to previous version');
  await expect(page.locator('[data-recued-updates-rollback-result]')).toContainText('No previous version.');
  expect(await calls(page, 'update.apply')).toBe(0);
});

const openRules = async (page: Page) => {
  await boot(page, 'contracts=paged');
  await page.evaluate(() => {
    window.__adminIconWrites = [];
    Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
      if (method === 'collection.contract.listOverrides') return { result: { overrides: [{
        actor: 'user_self', ingredient_id: 'recued-core/mail-post', operation_id: 'send',
        policy: { denied: true }, written_at: 1,
      }] } };
      if (method === 'collection.contract.listCatalogOperations') return { result: { ingredients: [{
        ingredient_id: 'recued-core/mail-post', name: 'Mail', operations: [{
          operation_id: 'send', operation_key: 'send', risk_tier: 'write', groups: ['mail'],
        }],
      }] } };
      if (method === 'collection.contract.deleteOverride' || method === 'collection.contract.upsertOverride') {
        window.__adminIconWrites.push({ method, args });
        return { error: { code: 'UNAVAILABLE', message: 'Try the permission change again.' } };
      }
      return undefined;
    } });
    window.__app.setHash('#contracts/view/others');
  });
  const rules = page.locator('[data-recued-contracts-rules]');
  await rules.locator('summary').click();
  await expect(rules.locator('[data-recued-permissions-row]')).toHaveCount(1);
  return rules;
};

test('Permission Delete and Cancel glyphs preserve review and the exact pending rule', async ({ page }) => {
  const rules = await openRules(page);
  const remove = rules.locator('[data-recued-permissions-delete]');
  await clickActionGlyph(page, remove);
  expect(await page.evaluate(() => window.__adminIconWrites)).toEqual([]);
  await clickActionGlyph(page, rules.locator('[data-recued-permissions-delete-cancel]'));
  await expect(remove).toHaveText('Delete');
  expect(await page.evaluate(() => window.__adminIconWrites)).toEqual([]);
  await clickActionGlyph(page, remove);
  await hold(page, 'collection.contract.deleteOverride');
  await clickActionGlyph(page, rules.locator('[data-recued-permissions-delete-confirm]'));
  await expect(remove).toHaveText('Removing…');
  await expect(remove).toBeDisabled();
  await clickActionGlyph(page, remove);
  expect(await page.evaluate(() => window.__adminIconWrites)).toEqual([{
    method: 'collection.contract.deleteOverride',
    args: { actor: 'user_self', ingredient_id: 'recued-core/mail-post', operation_id: 'send' },
  }]);
  expect(await release(page, 'collection.contract.deleteOverride')).toBe(1);
  await expect(rules).toContainText('Try the permission change again.');
  await expect(rules.locator('[data-recued-permissions-row]')).toHaveCount(1);
});

test('Permission Save glyph submits the chosen policy once and keeps the failed draft', async ({ page }) => {
  const rules = await openRules(page);
  await rules.locator('[data-recued-permissions-create-actor]').selectOption('user_self');
  await rules.locator('[data-recued-permissions-create-ingredient]').selectOption('recued-core/mail-post');
  await rules.locator('[data-recued-permissions-create-operation]').selectOption('send');
  await rules.locator('[data-recued-permissions-create-denied]').check();
  const save = rules.locator('[data-recued-permissions-create-save]');
  await hold(page, 'collection.contract.upsertOverride');
  await clickActionGlyph(page, save);
  await expect(save).toHaveText('Saving…');
  await expect(save).toBeDisabled();
  await clickActionGlyph(page, save);
  expect(await page.evaluate(() => window.__adminIconWrites)).toEqual([{
    method: 'collection.contract.upsertOverride',
    args: { actor: 'user_self', ingredient_id: 'recued-core/mail-post', operation_id: 'send', policy: { denied: true } },
  }]);
  expect(await release(page, 'collection.contract.upsertOverride')).toBe(1);
  await expect(save).toHaveText('Add the rule');
  await expect(rules.locator('[data-recued-permissions-create-operation]')).toHaveValue('send');
  await expect(rules.locator('[data-recued-permissions-create-denied]')).toBeChecked();
});

for (const [hash, query, taskId] of [
  ['#settings/server/maintenance', '', 'audit-compaction'],
  ['#settings/housekeeping', 'housekeeping=ready', 'enrichment.summary'],
] as const) {
  test(`${taskId} Run and Cancel glyphs preserve review and dispatch the selected task once`, async ({ page }) => {
    await boot(page, query);
    await page.evaluate(hash => {
      window.__adminIconWrites = [];
      Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
        if (method === 'housekeeping.task.run_now') window.__adminIconWrites.push({ method, args });
        return undefined;
      } });
      window.__app.setHash(hash);
    }, hash);
    const trigger = page.getByRole('button', { name: `Run ${taskId} now`, exact: true });
    await clickActionGlyph(page, trigger);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await calls(page, 'housekeeping.task.run_now')).toBe(0);
    await clickActionGlyph(page, dialog.getByRole('button', { name: 'Cancel', exact: true }));
    await expect(dialog).toHaveCount(0);
    expect(await calls(page, 'housekeeping.task.run_now')).toBe(0);
    await clickActionGlyph(page, trigger);
    await hold(page, 'housekeeping.task.run_now');
    const confirm = dialog.getByRole('button', { name: 'Run now', exact: true });
    await clickActionGlyph(page, confirm);
    const running = dialog.getByRole('button', { name: 'Running…', exact: true });
    await expect(running).toBeDisabled();
    await clickActionGlyph(page, running);
    expect(await page.evaluate(() => window.__adminIconWrites)).toEqual([{
      method: 'housekeeping.task.run_now', args: { task_id: taskId },
    }]);
    expect(await release(page, 'housekeeping.task.run_now')).toBe(1);
    await expect(dialog).toHaveCount(0);
  });
}

test('Maintenance Reclaim glyph sends the named surface once while pending', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.__adminIconWrites = [];
    Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
      if (method === 'server.getStatus') return { result: { pressure_details: {
        worst_state: 'pressure_managed', per_surface: [{
          surface: 'cache', state: 'pressure_managed', used_bytes: 90, quota_bytes: 100, pct: 90,
        }],
      } } };
      if (method === 'server.runPressureReclaim') {
        window.__adminIconWrites.push({ method, args });
        return { result: { ran: true, bytes_freed: 80 } };
      }
      return undefined;
    } });
    window.__app.setHash('#settings/server/maintenance');
  });
  const row = page.locator('.maintenance-storage-row').filter({ has: page.getByRole('rowheader', { name: 'cache', exact: true }) });
  const reclaim = row.getByRole('button');
  await hold(page, 'server.runPressureReclaim');
  await clickActionGlyph(page, reclaim);
  await expect(reclaim).toHaveText('Reclaiming…');
  await expect(reclaim).toBeDisabled();
  await clickActionGlyph(page, reclaim);
  expect(await page.evaluate(() => window.__adminIconWrites)).toEqual([{
    method: 'server.runPressureReclaim', args: { surface: 'cache' },
  }]);
  expect(await release(page, 'server.runPressureReclaim')).toBe(1);
  await expect(row).toContainText('freed 80 B');
  await expect(reclaim).toHaveText('Reclaim now');
});
