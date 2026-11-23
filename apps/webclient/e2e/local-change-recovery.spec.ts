import { expect, test, type Locator } from '@playwright/test';
import { atomic, atomicApprove, atomicRefresh, openLocalRecovery, undo } from './helpers/local-change-recovery-fixture.js';
import { ATOMIC_SET, ATOMIC_UNDO } from './harness/local-change-sets.js';
const unloadGuarded = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented;
});
const expectUncoveredFocus = async (target: Locator): Promise<void> => {
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport({ ratio: 1 });
  expect(await target.evaluate(element => {
    const rect = element.getBoundingClientRect(), hit = element.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit === element || hit !== null && element.contains(hit);
  })).toBe(true);
};
let pageErrors: string[];
test.beforeEach(({ page }) => { pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message)); });
test.afterEach(() => expect(pageErrors).toEqual([]));

test('an atomic decision keeps pending ownership, read recovery and a boot-owned lease after accepted departure', async ({ page }) => {
  await openLocalRecovery(page, { held: ['local_changes.decide'], profiles: true });
  await atomicApprove(page).focus(); await atomicApprove(page).press('Enter');
  await expectUncoveredFocus(atomic(page).locator('[data-local-change-progress]')); expect(await unloadGuarded(page)).toBe(true);
  const dialogs: string[] = []; page.once('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.evaluate(() => window.__app.setHash('#yours')); await expect.poll(() => dialogs.length).toBe(1);
  await expect(page).toHaveURL(new RegExp(ATOMIC_SET + '$'));
  const account = page.locator('[data-recued-account-menu-trigger]'); await account.focus();
  await page.evaluate(() => window.__localRecovery.release('local_changes.decide', true));
  await expect(atomic(page).getByRole('alert')).toContainText('Local review temporarily unavailable'); await expect(account).toBeFocused();
  await expect(atomicApprove(page)).toBeDisabled();
  await page.evaluate(() => { window.__localRecovery.failing = ['local_changes.get']; });
  await atomic(page).getByRole('button', { name: 'Check result', exact: true }).click();
  await expect(atomic(page).getByRole('alert')).toContainText('Local result read unavailable'); await expect(atomicApprove(page)).toBeDisabled();
  await page.evaluate(() => { window.__localRecovery.failing = []; });
  await atomic(page).getByRole('button', { name: 'Check result', exact: true }).click();
  await expect(atomic(page)).toContainText('No decision has been recorded.'); await expect(atomicApprove(page)).toBeEnabled();
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(1);
  await atomicApprove(page).click(); page.once('dialog', dialog => dialog.accept()); await page.evaluate(() => window.__app.setHash('#yours'));
  await expect(atomic(page)).toHaveCount(0); await account.click();
  const menu = page.locator('[data-recued-account-menu-popover]');
  await menu.locator('[data-recued-server-switcher-item]').filter({ hasText: 'Office server' }).click();
  const confirm = menu.locator('[data-recued-server-switcher-switch-confirm]'); await expect(confirm).toContainText('Resolving an approval');
  await confirm.locator('[data-recued-server-switcher-switch-cancel]').click(); await account.click();
  const reads = await page.evaluate(() => window.__app.rpcCallCount('local_changes.get'));
  await page.evaluate(() => window.__localRecovery.release('local_changes.decide'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(atomic(page)).toHaveCount(0); expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.get'))).toBe(reads);
  await page.evaluate(id => window.__app.setHash('#approvals/local-changes/' + id), ATOMIC_SET);
  await expect(atomic(page)).toContainText('All 2 local changes are confirmed.');
  const decisions = await page.evaluate(() => window.__localRecovery.calls.filter(call => call.method === 'local_changes.decide'));
  expect(decisions).toHaveLength(2); expect(decisions[1]).toEqual(decisions[0]);
});

test('atomic refresh retains resource reading position and later shell focus', async ({ page }) => {
  await openLocalRecovery(page);
  await page.evaluate(id => {
    const saved = JSON.parse(sessionStorage.getItem('recued-test-local-changes')!);
    saved[id].review.changes[0].resource_review.resources[0].before.body = Array.from({ length: 80 }, (_, index) => 'Reviewed line ' + index).join('\n');
    sessionStorage.setItem('recued-test-local-changes', JSON.stringify(saved));
  }, ATOMIC_SET);
  await atomicRefresh(page).click(); const region = atomic(page).getByRole('region', { name: 'Reviewed changes for Update note a', exact: true });
  await region.focus(); await region.press('End'); await expect.poll(() => region.evaluate(element => element.scrollTop >= element.scrollHeight - element.clientHeight - 1)).toBe(true);
  const top = await region.evaluate(element => element.scrollTop); expect(top).toBeGreaterThan(0);
  await atomicRefresh(page).evaluate(button => (button as HTMLButtonElement).click()); await expect(atomicRefresh(page)).toHaveText('Refresh');
  await expect(region).toBeFocused(); expect(await region.evaluate(element => element.scrollTop)).toBe(top);
  const account = page.locator('[data-recued-account-menu-trigger]'); await account.focus();
  await atomicRefresh(page).evaluate(button => (button as HTMLButtonElement).click()); await expect(atomicRefresh(page)).toHaveText('Refresh'); await expect(account).toBeFocused();
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(0);
});

test('an atomic approval checks current expiry even before the next timer paint', async ({ page }) => {
  await page.clock.setFixedTime(Date.now()); await openLocalRecovery(page);
  const old = await atomicApprove(page).elementHandle();
  const expires = await page.evaluate(id => JSON.parse(sessionStorage.getItem('recued-test-local-changes')!)[id].review.expires_at, ATOMIC_SET);
  await page.clock.setFixedTime(expires + 1); await old!.evaluate(button => (button as HTMLButtonElement).click());
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(0);
  await expect(atomic(page)).toContainText('This review expired.');
});

test('grouped undo preparation retries its exact request and navigates after pending work settles', async ({ page }) => {
  await openLocalRecovery(page, { held: ['local_changes.prepare_undo'] }); await atomicApprove(page).click();
  await atomic(page).getByRole('button', { name: 'Review undo together', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__localRecovery.pending('local_changes.prepare_undo'))).toBe(1);
  await page.evaluate(() => window.__localRecovery.release('local_changes.prepare_undo', true));
  await expect(atomic(page).getByRole('alert')).toContainText('Local review temporarily unavailable');
  await page.evaluate(() => { window.__localRecovery.held = []; });
  await atomic(page).getByRole('button', { name: 'Review undo together', exact: true }).press('Enter');
  await expect(page).toHaveURL(new RegExp(ATOMIC_UNDO + '$'));
  const attempts = await page.evaluate(() => window.__localRecovery.calls.filter(call => call.method === 'local_changes.prepare_undo'));
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(1);
});

for (const surface of ['chat', 'line', 'approvals', 'runs'] as const) test(`${surface} undo keeps pending progress and preserves later shell focus`, async ({ page }) => {
  await openLocalRecovery(page, { surface, held: ['local_undo.decide'] });
  await undo(page).getByRole('button', { name: 'Review undo', exact: true }).click();
  const approve = undo(page).getByRole('button', { name: 'Approve undo', exact: true }); await approve.focus(); await approve.press('Enter');
  await expectUncoveredFocus(undo(page).getByRole('status'));
  const account = page.locator('[data-recued-account-menu-trigger]'); await account.focus();
  await page.evaluate(() => window.__localRecovery.release('local_undo.decide'));
  await expect(undo(page)).toContainText('Undone. The change was reversed.'); await expect(account).toBeFocused();
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(1);
});

test('a preapproval refresh keeps its undo review and guards a pending undo decision', async ({ page }) => {
  await openLocalRecovery(page, { surface: 'approvals', held: ['local_undo.decide'] });
  await undo(page).getByRole('button', { name: 'Review undo', exact: true }).click(); const original = await undo(page).elementHandle();
  const refresh = page.locator('[data-recued-preapproval-route]').getByRole('button', { name: 'Refresh', exact: true });
  await refresh.click(); await expect(undo(page).getByRole('button', { name: 'Approve undo', exact: true })).toBeVisible();
  expect(await original!.evaluate(element => element.isConnected)).toBe(true);
  await undo(page).getByRole('button', { name: 'Approve undo', exact: true }).click(); expect(await unloadGuarded(page)).toBe(true);
  const dialogs: string[] = []; page.once('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.evaluate(() => window.__app.setHash('#yours')); await expect.poll(() => dialogs.length).toBe(1);
  await expect(page).toHaveURL(/#approvals\/preapproval\//u);
  await refresh.click(); expect(await original!.evaluate(element => element.isConnected)).toBe(true);
  await expect(undo(page).getByRole('button', { name: 'Approve undo', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__localRecovery.release('local_undo.decide')); await expect(undo(page)).toContainText('Undone.');
});

test('a detached undo approval cannot approve a replacement review', async ({ page }) => {
  await openLocalRecovery(page, { surface: 'approvals' });
  const open = undo(page).getByRole('button', { name: 'Review undo', exact: true }); await open.click();
  const old = await undo(page).getByRole('button', { name: 'Approve undo', exact: true }).elementHandle(); await open.click();
  await expect(undo(page).getByRole('heading', { name: 'Undo this change?', exact: true })).toBeVisible();
  expect(await old!.evaluate(element => element.isConnected)).toBe(false); await old!.evaluate(button => (button as HTMLButtonElement).click());
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(0);
});

test('an expired individual undo requires a fresh review and another explicit approval', async ({ page }) => {
  await page.clock.setFixedTime(Date.now()); await openLocalRecovery(page, { surface: 'approvals' });
  await undo(page).getByRole('button', { name: 'Review undo', exact: true }).click();
  await page.clock.setFixedTime(Date.now() + 11 * 60_000);
  await undo(page).getByRole('button', { name: 'Approve undo', exact: true }).click();
  await expect(undo(page).getByRole('alert')).toContainText('expired'); expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(0);
  await undo(page).getByRole('button', { name: 'Review undo again', exact: true }).click();
  await expect(undo(page).getByRole('heading', { name: 'Undo this change?', exact: true })).toBeFocused();
  await undo(page).getByRole('button', { name: 'Approve undo', exact: true }).click();
  await expect(undo(page)).toContainText('Undone.'); expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(1);
});

test('a departed undo read never starts a late review request', async ({ page }) => {
  await openLocalRecovery(page, { surface: 'approvals', held: ['local_undo.get'] });
  await undo(page).getByRole('button', { name: 'Review undo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__localRecovery.pending('local_undo.get'))).toBe(1);
  await page.evaluate(() => window.__app.setHash('#yours')); await expect(undo(page)).toHaveCount(0);
  await page.evaluate(() => window.__localRecovery.release('local_undo.get'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.review'))).toBe(0); await expect(page).toHaveURL(/#yours$/u);
});

test('atomic history retains pagination focus through an error and the final page', async ({ page }) => {
  await openLocalRecovery(page);
  await page.evaluate(id => {
    const original = JSON.parse(sessionStorage.getItem('recued-test-local-changes')!)[id]; let attempts = 0;
    Object.assign(window, { __localChangeFixture: async (method: string, args: Record<string, unknown>) => {
      if (method !== 'local_changes.list') return undefined;
      window.__localRecovery.calls.push({ method, args });
      if (args.cursor && ++attempts === 1) return { error: { code: 'UNAVAILABLE', message: 'Next local changes unavailable.' } };
      const next = !!args.cursor, row = structuredClone(original);
      row.change_set_id = next ? 'lcs_33333333-3333-4333-8333-333333333333' : id;
      row.review.title = next ? 'Next local review' : 'First local review';
      return { result: { items: [row], next_cursor: next ? null : 'local-next' } };
    } });
    window.__app.setHash('#approvals/local-changes');
  }, ATOMIC_SET);
  const more = atomic(page).getByRole('button', { name: 'Load more', exact: true }); await more.focus(); await more.press('Enter');
  await expect(atomic(page).getByRole('alert')).toContainText('Next local changes unavailable'); await expect(more).toBeFocused();
  await more.press('Enter'); await expect(atomic(page).getByRole('link', { name: 'Next local review', exact: true })).toBeFocused();
  await expect(atomic(page).getByRole('link', { name: 'First local review', exact: true })).toBeVisible(); await expect(more).toHaveCount(0);
  expect(await page.evaluate(() => window.__localRecovery.calls.filter(call => call.method === 'local_changes.list').map(call => call.args)))
    .toEqual([{ cursor: '' }, { cursor: 'local-next' }, { cursor: 'local-next' }]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(0);
});

test('Chat retains its open undo and pending route owner through a real thread repaint', async ({ page }) => {
  await openLocalRecovery(page, { surface: 'chat', held: ['local_undo.decide'] });
  await undo(page).getByRole('button', { name: 'Review undo', exact: true }).click(); const original = await undo(page).elementHandle();
  await undo(page).getByRole('button', { name: 'Approve undo', exact: true }).click();
  const before = await page.evaluate(() => window.__app.rpcCallCount('chat.sessions.list'));
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'chat.session_changed', session_id: 'chat_1', field: 'title', value: 'Planning chat', cursor: 1200,
  } }));
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('chat.sessions.list'))).toBeGreaterThan(before);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await original!.evaluate(element => element.isConnected)).toBe(true);
  await expect(undo(page).getByRole('status')).toHaveText('Applying the reviewed undo…'); await expect(undo(page).getByRole('status')).toBeFocused();
  expect(await unloadGuarded(page)).toBe(true);
  const dialogs: string[] = []; page.once('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.evaluate(() => window.__app.setHash('#yours')); await expect.poll(() => dialogs.length).toBe(1);
  await expect(page).toHaveURL(/#chat\/session\/chat_1$/u);
  await page.evaluate(() => window.__localRecovery.release('local_undo.decide')); await expect(undo(page)).toContainText('Undone.');
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(1);
});

test('migration to an atomic review retries one preparation without approving either review', async ({ page }) => {
  await openLocalRecovery(page, { surface: 'migration', held: ['local_changes.prepare'] });
  const prepare = page.getByRole('button', { name: 'Review as one atomic change set', exact: true }); await prepare.click();
  await expect.poll(() => page.evaluate(() => window.__localRecovery.pending('local_changes.prepare'))).toBe(1);
  await page.evaluate(() => window.__localRecovery.release('local_changes.prepare', true));
  await expect(page.locator('[data-recued-preapproval-route]').getByRole('alert')).toContainText('Local review temporarily unavailable');
  await expect(prepare).toBeFocused(); await page.evaluate(() => { window.__localRecovery.held = []; }); await prepare.press('Enter');
  await expect(page).toHaveURL(new RegExp(ATOMIC_SET + '$')); await expect(atomicApprove(page)).toBeEnabled();
  const requests = await page.evaluate(() => window.__localRecovery.calls.filter(call => call.method === 'local_changes.prepare'));
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide') + window.__app.rpcCallCount('preapproval.decide'))).toBe(0);
});

test('an unknown individual undo stays read-only through checks and reload', async ({ page }) => {
  await openLocalRecovery(page, { surface: 'approvals' }); await undo(page).getByRole('button', { name: 'Review undo', exact: true }).click();
  await page.evaluate(() => {
    let result: import('@recued/contracts').LocalUpdateUndoResult | null = null;
    Object.assign(window, { __localChangeFixture: async (method: string, args: Record<string, unknown>) => {
      if (method === 'local_undo.decide') {
        result = { undo_id: String(args.undo_id), predecessor_receipt_id: document.querySelector('[data-local-update-undo]')!.getAttribute('data-local-update-undo')!, status: 'unknown' };
        sessionStorage.setItem('recued-test-local-update-undo-result', JSON.stringify(result));
      }
      return ['local_undo.get', 'local_undo.decide'].includes(method) ? { result } : undefined;
    } });
  });
  await undo(page).getByRole('button', { name: 'Approve undo', exact: true }).click(); await expect(undo(page)).toContainText('Undo outcome is unknown.');
  await undo(page).getByRole('button', { name: 'Check undo result', exact: true }).click(); await expect(undo(page)).toContainText('Undo outcome is unknown.');
  await expect(undo(page).getByRole('button', { name: 'Approve undo', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(1);
  await page.reload(); await undo(page).getByRole('button', { name: 'Review undo', exact: true }).click();
  await expect(undo(page)).toContainText('Undo outcome is unknown.'); expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.review') + window.__app.rpcCallCount('local_undo.decide'))).toBe(0);
});

test('a delayed undo review that expires keeps later shell focus', async ({ page }) => {
  const initial = Date.now(); await page.clock.setFixedTime(initial); await openLocalRecovery(page, { surface: 'approvals' });
  await page.evaluate(() => window.__app.holdRpcResponses?.('local_undo.review'));
  await undo(page).getByRole('button', { name: 'Review undo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('local_undo.review'))).toBe(1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const account = page.locator('[data-recued-account-menu-trigger]'); await account.focus(); await page.clock.setFixedTime(initial + 11 * 60_000);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('local_undo.review'))).toBe(1);
  await expect(undo(page).getByRole('alert')).toContainText('expired'); await expect(account).toBeFocused();
  await expect(undo(page).getByRole('button', { name: 'Approve undo', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(0);
});

test('expiry hands a focused atomic decision to its local notice without submitting', async ({ page }) => {
  await page.clock.setFixedTime(Date.now()); await openLocalRecovery(page); await atomicApprove(page).focus();
  const expiry = await page.evaluate(id => JSON.parse(sessionStorage.getItem('recued-test-local-changes')!)[id].review.expires_at, ATOMIC_SET);
  await page.clock.setFixedTime(expiry + 1);
  await expectUncoveredFocus(atomic(page).locator('[data-local-change-expiry]'));
  await expect(atomicApprove(page)).toBeDisabled(); expect(await page.evaluate(() => window.__app.rpcCallCount('local_changes.decide'))).toBe(0);
});
