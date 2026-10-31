import { expect, test, type Page } from '@playwright/test';
import { clickActionGlyph } from './helpers/action-glyph.js';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
type IconWrite = { method: string; args: unknown };
declare global { interface Window { __preferenceIconWrites: IconWrite[] } }
const calls = (page: Page, method: string) => page.evaluate(method => window.__app.rpcCallCount(method), method);
const hold = (page: Page, method: string) => page.evaluate(method => window.__app.holdRpcResponses?.(method), method);
const release = (page: Page, method: string) => page.evaluate(method => window.__app.releaseRpcResponses?.(method), method);
const boot = async (page: Page, query: string, hash: string) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?${query}&settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(hash => {
    window.__preferenceIconWrites = [];
    Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
      if (['account.bind', 'account.unbind', 'key.rotate', 'chat.execution.forget', 'chat.execution.draft_recipe'].includes(method)) {
        window.__preferenceIconWrites.push({ method, args });
      }
      if (method === 'key.rotate') {
        const op = args !== null && typeof args === 'object' && 'op' in args && args.op === 'mark_compromised'
          ? 'mark_compromised' : 'master_dek_rotate';
        return { result: { ok: true, op, key_class: 'master_dek', rotated_at: 1_700_000_000_000 } };
      }
      if (method === 'chat.execution.draft_recipe') return { error: { code: 'UNAVAILABLE', message: 'Draft service temporarily unavailable.' } };
      return undefined;
    } });
    window.__app.setHash(hash);
  }, hash);
};

test('Account Connect glyph keeps one pending binding and restores the check action', async ({ page }) => {
  await boot(page, 'account=unbound', '#settings/account');
  const connect = page.locator('[data-recued-account-binding-connect]');
  await expect(connect).toHaveText('Connect your recued.com account');
  await hold(page, 'account.bind');
  await clickActionGlyph(page, connect);
  await expect(connect).toHaveText('Connecting…');
  await expect(connect).toBeDisabled();
  await clickActionGlyph(page, connect);
  await expect.poll(() => calls(page, 'account.bind')).toBe(1);
  await expect.poll(() => release(page, 'account.bind')).toBe(1);
  await expect(connect).toHaveText('Check the connection again');
  expect(await calls(page, 'account.unbind')).toBe(0);
});

test('Account Move and Cancel glyphs preserve review before confirming the destination', async ({ page }) => {
  await boot(page, 'account=conflict', '#settings/account');
  const move = page.locator('[data-recued-account-binding-connect]');
  const dialog = page.getByRole('alertdialog', { name: 'Two accounts want this server' });
  await clickActionGlyph(page, move);
  await expect(dialog).toBeVisible();
  await clickActionGlyph(page, dialog.locator('[data-recued-account-binding-cancel-rebind]'));
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.__preferenceIconWrites)).toEqual([{
    method: 'account.bind', args: { binding_token: expect.any(String) },
  }]);
  await clickActionGlyph(page, move);
  await expect(dialog).toBeVisible();
  await hold(page, 'account.bind');
  const confirm = dialog.locator('[data-recued-account-binding-confirm-rebind]');
  await clickActionGlyph(page, confirm);
  await expect(confirm).toHaveText('Moving…');
  await expect(confirm).toBeDisabled();
  await clickActionGlyph(page, confirm);
  await expect.poll(() => calls(page, 'account.bind')).toBe(3);
  expect(await page.evaluate(() => window.__preferenceIconWrites[2])).toEqual({
    method: 'account.bind', args: { binding_token: expect.any(String), confirm_rebind: true },
  });
  await expect.poll(() => release(page, 'account.bind')).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(move).toHaveText('Check the connection again');
});

test('Account Disconnect glyph reviews the server change and Cancel sends no unbind', async ({ page }) => {
  await boot(page, 'account=conflict', '#settings/account');
  const disconnect = page.locator('[data-recued-account-binding-unbind]');
  const dialog = page.getByRole('alertdialog', { name: 'Disconnect this server?' });
  await clickActionGlyph(page, disconnect);
  await clickActionGlyph(page, dialog.locator('[data-recued-account-binding-cancel-unbind]'));
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, 'account.unbind')).toBe(0);
  await clickActionGlyph(page, disconnect);
  await hold(page, 'account.unbind');
  const confirm = dialog.locator('[data-recued-account-binding-confirm-unbind]');
  await clickActionGlyph(page, confirm);
  await expect(confirm).toHaveText('Disconnecting…');
  await expect(confirm).toBeDisabled();
  await clickActionGlyph(page, confirm);
  await expect.poll(() => calls(page, 'account.unbind')).toBe(1);
  await expect.poll(() => release(page, 'account.unbind')).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-recued-account-binding-connect]')).toHaveText('Connect your recued.com account');
  expect(await calls(page, 'account.bind')).toBe(0);
});

test('Account Sign out glyph keeps the browser action single-flight through failure', async ({ page }) => {
  await boot(page, 'account=bound&account_signout_response=fail-slow', '#settings/account');
  const signOut = page.locator('[data-recued-account-binding-signout]');
  await clickActionGlyph(page, signOut);
  await expect(signOut).toHaveText('Signing out…');
  await expect(signOut).toBeDisabled();
  await clickActionGlyph(page, signOut);
  await expect(signOut).toHaveText('Sign out');
  expect(await page.evaluate(() => window.__app.accountSignOutCount?.())).toBe(1);
  expect(await calls(page, 'account.unbind')).toBe(0);
  await expect(page.locator('[data-recued-account-binding-session]')).toBeVisible();
});

for (const action of ['rotate', 'compromise'] as const) {
  test(`Key Health ${action} glyph reviews and dispatches the exact key action`, async ({ page }) => {
    await boot(page, '', '#settings/server/key-health');
    const trigger = page.locator(`[data-recued-key-health-${action}="master_dek"]`);
    const cancel = page.locator('[data-recued-key-health-cancel]');
    await clickActionGlyph(page, trigger);
    await clickActionGlyph(page, cancel);
    expect(await calls(page, 'key.rotate')).toBe(0);
    await clickActionGlyph(page, trigger);
    await hold(page, 'key.rotate');
    await clickActionGlyph(page, page.locator('[data-recued-key-health-confirm]'));
    await expect(page.locator('[data-recued-key-health-panel-state="busy"]')).toBeVisible();
    expect(await page.evaluate(() => window.__preferenceIconWrites)).toEqual([{
      method: 'key.rotate', args: action === 'rotate' ? { op: 'master_dek_rotate' } : { op: 'mark_compromised', key_class: 'master_dek' },
    }]);
    expect(await release(page, 'key.rotate')).toBe(1);
    const close = page.locator('[data-recued-key-health-close]');
    await expect(close).toBeVisible();
    await clickActionGlyph(page, close);
    await expect(trigger).toBeVisible();
    expect(await calls(page, 'key.rotate')).toBe(1);
  });
}

test('Learning Forget glyph preserves the second case identity and double confirmation', async ({ page }) => {
  await boot(page, 'privacy=learning-cases-multiple', '#settings/privacy');
  // The base fixture has one presence flag for all cases. Give this two-row
  // journey a response that preserves the unselected case after the re-read.
  await page.evaluate(() => {
    Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
      if (method === 'chat.execution.forget') {
        window.__preferenceIconWrites.push({ method, args });
        return { result: { removed: true, cases_remaining: 1 } };
      }
      if (method === 'chat.execution.learned') return { result: { cases: [{
        case_id: 'learning-case-1', request: ['send the quarterly report'],
        flows: [{ tools_that_may_be_needed: ['file.search', 'mail.send'], outcome: ['You confirmed this was right.'] }],
        shown_to_model: true, request_observations: 3, last_seen_at: 1_700_000_000_000,
      }] } };
      return undefined;
    } });
  });
  const forget = page.locator('[data-recued-learning-forget="learning-case-2"]');
  await clickActionGlyph(page, forget);
  await expect(forget).toHaveText('Tap again to forget');
  expect(await calls(page, 'chat.execution.forget')).toBe(0);
  await hold(page, 'chat.execution.forget');
  await clickActionGlyph(page, forget);
  await expect(forget).toHaveText('Forgetting...');
  await expect(forget).toBeDisabled();
  await clickActionGlyph(page, forget);
  expect(await page.evaluate(() => window.__preferenceIconWrites)).toEqual([{
    method: 'chat.execution.forget', args: { case_id: 'learning-case-2' },
  }]);
  expect(await release(page, 'chat.execution.forget')).toBe(1);
  await expect(forget).toHaveCount(0);
  await expect(page.locator('[data-recued-learning-forget="learning-case-1"]')).toBeVisible();
});

test('Learning draft glyph keeps the edited request through review and a failed single request', async ({ page }) => {
  await boot(page, 'privacy=learning-cases', '#settings/privacy');
  const draft = page.locator('[data-recued-learning-draft="learning-case-1"]');
  await clickActionGlyph(page, draft);
  expect(await calls(page, 'chat.execution.draft_recipe')).toBe(0);
  const prompt = page.locator('[data-recued-learning-draft-prompt="learning-case-1"]');
  await prompt.fill('Run the report every Friday.');
  await hold(page, 'chat.execution.draft_recipe');
  await clickActionGlyph(page, draft);
  await expect(draft).toHaveText('Asking your AI…');
  await expect(draft).toBeDisabled();
  await clickActionGlyph(page, draft);
  expect(await page.evaluate(() => window.__preferenceIconWrites)).toEqual([{
    method: 'chat.execution.draft_recipe', args: { case_id: 'learning-case-1', prompt: 'Run the report every Friday.' },
  }]);
  expect(await release(page, 'chat.execution.draft_recipe')).toBe(1);
  await expect(draft).toHaveText('Yes, write the draft');
  await expect(prompt).toHaveValue('Run the report every Friday.');
});

test('Clear this browser glyphs preserve Cancel and the pending destructive confirmation', async ({ page }) => {
  await boot(page, 'browser_clear=slow', '#settings/privacy');
  const clear = page.locator('[data-recued-clear-this-browser-clear]');
  const confirm = page.locator('[data-recued-clear-this-browser-confirm]');
  await clickActionGlyph(page, clear);
  await clickActionGlyph(page, page.locator('[data-recued-clear-this-browser-cancel]'));
  await expect(clear).toBeVisible();
  await expect(confirm).toHaveCount(0);
  await clickActionGlyph(page, clear);
  await clickActionGlyph(page, confirm);
  await expect(page.locator('[data-recued-clear-this-browser-panel-state="busy"]')).toBeVisible();
  await expect(confirm).toBeDisabled();
  await clickActionGlyph(page, confirm);
  await expect(page.locator('[data-recued-clear-this-browser-reload]')).toBeVisible();
  expect(await page.evaluate(() => window.__preferenceIconWrites)).toEqual([]);
});

test('Transparency Retry glyph recovers the read without writing a preference', async ({ page }) => {
  await page.goto('/transparency-read-retry-harness.html');
  await page.waitForFunction(() => window.__transparencyReadRetry !== undefined);
  await page.evaluate(() => window.__transparencyReadRetry.release('read', 0, 'error'));
  const retry = page.getByRole('button', { name: 'Retry transparency settings', exact: true });
  await clickActionGlyph(page, retry);
  await expect(retry).toBeDisabled();
  await clickActionGlyph(page, retry);
  expect(await page.evaluate(() => window.__transparencyReadRetry.calls.map(call => call.kind))).toEqual(['read', 'read']);
  await page.evaluate(() => window.__transparencyReadRetry.release('read', 1));
  await expect(retry).toBeHidden();
});

test('Learning history Retry glyph keeps reads single-flight without changing a case', async ({ page }) => {
  await page.goto('/learning-history-retry-harness.html');
  await page.waitForFunction(() => window.__learningHistory !== undefined);
  await page.evaluate(() => window.__learningHistory.release('history', 0, 'error'));
  const retry = page.getByRole('button', { name: 'Retry learned history', exact: true });
  await clickActionGlyph(page, retry);
  await expect(retry).toBeDisabled();
  await clickActionGlyph(page, retry);
  expect(await page.evaluate(() => window.__learningHistory.calls.map(call => call.kind))).toEqual(['preferences', 'history', 'history']);
  await page.evaluate(() => window.__learningHistory.release('history', 1));
  await expect(retry).toHaveCount(0);
  expect(await page.evaluate(() => window.__learningHistory.calls.filter(call => ['save', 'forget', 'draft', 'handoff'].includes(call.kind)))).toEqual([]);
});
