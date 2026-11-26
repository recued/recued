import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { invalidateTriage, openTriage, triage, triageApprove, triageCard, triageClear, triageDrain, triageFilter,
  triageNote, triageRefresh, triageSearch, triageSummary } from './helpers/approval-triage-fixture.js';

let external: string[] = [];
const queueTab = (page: Page, key: string) => triage(page).locator(`[data-recued-approvals-queue-key="${key}"]`);
test.beforeEach(async ({ page }) => {
  external = [];
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(HARNESS_URL).origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
});
installFullAppHooks();
test.afterEach(async ({ page }) => {
  expect(external).toEqual([]);
  const data = await page.evaluate(() => window.__approvalTriage ? {
    writes: window.__approvalTriage.calls.filter(call => ['notification.submitAnswer', 'notification.giveSecret', 'approval.resolve', 'chat.plan.approve', 'chat.plan.cancel'].includes(call.method)),
    expected: window.__approvalTriage.expectedWrites,
  } : null);
  if (data) expect(data.writes).toEqual(data.expected);
});

test('the settled full-app fixture distinguishes an empty inbox from failed or pending reads', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?settle_reads=1#approvals`); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(triage(page).locator('[data-recued-approvals-empty]')).toBeVisible();
  await expect(triage(page).locator('[data-recued-approvals-empty]')).toHaveText('All clear.');
  await expect(triage(page).getByRole('alert')).toHaveCount(0);
  await expect(triage(page).locator('[data-recued-approvals-loading]')).toHaveCount(0);
  await expect(triageFilter(page, 'all')).toHaveText('All (0)');
  const reads = await page.evaluate(() => Object.fromEntries(['approval.list', 'approval.subscribe', 'notification.pending_asks'].map(method => [method, window.__app.rpcCallCount(method)])));
  for (const count of Object.values(reads)) expect(count).toBeGreaterThan(0);
});

test('held empty reads remain loading, then expose a recoverable error before an explicit retry', async ({ page }) => {
  await openTriage(page, { empty: true, held: ['approval.list', 'approval.subscribe'] });
  await expect(triage(page).locator('[data-recued-approvals-loading]')).toBeVisible();
  await expect(triage(page).locator('[data-recued-approvals-empty]')).toBeHidden();
  await page.evaluate(() => { const f = window.__approvalTriage; f.held = []; f.release('approval.list', 'error'); f.release('approval.subscribe', 'error'); });
  await expect(triage(page).getByRole('alert').first()).toContainText('Review temporarily unavailable.');
  await expect(triageFilter(page, 'all')).toHaveText('All (0 loaded)');
  await expect(triage(page).locator('[data-recued-approvals-empty]')).toBeHidden();
  await triageRefresh(page).focus(); await triageRefresh(page).press('Enter');
  await expect(triage(page).locator('[data-recued-approvals-empty]')).toBeVisible();
  await expect(triage(page).locator('[data-recued-approvals-empty]')).toHaveText('All clear.');
  await expect(triageRefresh(page)).toBeFocused();
});

test('real-app triage keeps native reasons and Undo through filters, updates and changed review context', async ({ page }) => {
  await openTriage(page, { width: 390 });
  await triageNote(page, 'ask-b').fill('Keep this separate.');
  const note = triageNote(page); const original = await note.elementHandle();
  const written = 'Checked the extra visit.'; await note.pressSequentially(written);
  await note.press('ControlOrMeta+z'); const undone = await note.inputValue(); expect(undone).not.toBe(written);
  await note.press('ControlOrMeta+Shift+z'); await expect(note).toHaveValue(written);
  await triageFilter(page, 'plan').click(); await expect(triageCard(page, 'plan-a')).toBeVisible();
  await page.evaluate(() => { const f = window.__approvalTriage;
    f.asks = [{ ...f.asks[1]!, ask_id: 'ask-c', created_at: f.asks[0]!.created_at - 25 }, ...Array.from(f.asks).reverse()];
  }); await invalidateTriage(page);
  await expect(triageFilter(page, 'ask')).toHaveText('Questions (3)');
  await expect(triageFilter(page, 'plan')).toBeFocused();
  await triageFilter(page, 'ask').click(); await expect(note).toHaveValue(written);
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await note.press('ControlOrMeta+z'); await expect(note).toHaveValue(undone);
  await note.press('ControlOrMeta+Shift+z'); await expect(note).toHaveValue(written);
  await triageSearch(page).fill('Checked the extra visit.'); await expect(triageCard(page, 'ask-a')).toBeHidden();
  await page.evaluate(() => { window.__approvalTriage.asks.find(ask => ask.ask_id === 'ask-a')!.body = 'A different follow-up for review.'; });
  await invalidateTriage(page); await expect(triageCard(page, 'ask-a')).toContainText('A different follow-up for review.');
  await triageDrain(page); await expect(triageSearch(page)).toBeFocused();
  await triageClear(page).click(); await expect(note).toHaveValue(''); await expect(triageNote(page, 'ask-b')).toHaveValue('Keep this separate.');
  await expect(triageSearch(page)).toBeFocused();
});

test('required reasons and held answer recovery preserve the shell navigation owner and exact retry', async ({ page }) => {
  await openTriage(page, { width: 390, held: ['notification.submitAnswer'] });
  await triageApprove(page).click(); await expect(triageNote(page)).toBeFocused();
  expect(await page.evaluate(() => window.__approvalTriage.calls.filter(call => call.method === 'notification.submitAnswer'))).toEqual([]);
  const args = { ask_id: 'ask-a', option_id: 'yes', note: 'Reviewed before answering.' };
  await triageNote(page).fill(args.note);
  await page.evaluate(args => window.__approvalTriage.expectedWrites.push({ method: 'notification.submitAnswer', args }), args);
  await triageApprove(page).click(); await expect(triageApprove(page)).toBeDisabled();
  const dialogs: string[] = []; page.once('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.evaluate(() => window.__app.setHash('#yours')); await expect.poll(() => dialogs.length).toBe(1);
  await expect(page).toHaveURL(/#approvals$/u);
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  await triageFilter(page, 'gate').click(); await triageSearch(page).fill('unmatched review');
  await page.evaluate(() => { const f = window.__approvalTriage; f.held = []; f.release('notification.submitAnswer', 'error'); });
  await expect(triageApprove(page)).toBeEnabled(); await expect(triageSearch(page)).toBeFocused();
  await expect(triageCard(page, 'ask-a')).toBeHidden(); await triageClear(page).click();
  await expect(triageNote(page)).toHaveValue(args.note);
  await page.evaluate(args => window.__approvalTriage.expectedWrites.push({ method: 'notification.submitAnswer', args }), args);
  await triageApprove(page).click(); await expect(triageCard(page, 'ask-a')).toHaveCount(0);
  await expect(triageFilter(page, 'all')).toHaveText('All (3)');
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
});

test('the desktop queue keeps the selected question and its native reason through filtering and refresh', async ({ page }) => {
  await openTriage(page, { width: 1440 });
  const queue = triage(page).getByRole('tablist', { name: 'Pending decision queue' });
  const panel = triage(page).getByRole('tabpanel');
  await expect(queue.getByRole('tab')).toHaveCount(4);
  await expect(queueTab(page, 'ask:ask-a')).toHaveAccessibleName(/Review customer follow-up 1.*Question.*just now/);
  await triageSearch(page).fill('follow-up');
  await triageFilter(page, 'ask').click();
  await expect(queue.getByRole('tab')).toHaveCount(2);
  const first = queueTab(page, 'ask:ask-a');
  const second = queueTab(page, 'ask:ask-b');
  await first.click();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel).toBeFocused();
  const reason = triageNote(page, 'ask-a');
  await reason.fill('Keep the draft with the first question.');
  const original = await reason.elementHandle();

  await second.click();
  await expect(triageCard(page, 'ask-a')).toBeHidden();
  await expect(triageCard(page, 'ask-b')).toBeVisible();
  await page.evaluate(() => {
    const fixture = window.__approvalTriage;
    const first = fixture.asks[0]!;
    fixture.asks = [...fixture.asks, { ...first, ask_id: 'ask-c', title: 'Earlier customer follow-up', created_at: first.created_at - 60000 }];
  });
  await invalidateTriage(page);
  await expect(queue.getByRole('tab')).toHaveCount(3);
  await expect(queue.getByRole('tab').first()).toHaveAccessibleName(/Earlier customer follow-up/);
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(second).toBeFocused();
  await expect(triageSearch(page)).toHaveValue('follow-up');
  await expect(triageFilter(page, 'ask')).toHaveAttribute('aria-pressed', 'true');
  await second.press('ArrowUp');
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(reason).toHaveValue('Keep the draft with the first question.');
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await expect(triageNote(page, 'ask-b')).toHaveValue('');
});

test('the desktop queue submits only explicit decisions and focuses the next matching item', async ({ page }) => {
  await openTriage(page);
  await queueTab(page, 'gate:gate-a').click();
  const gate = triageCard(page, 'gate-a'); const arm = gate.locator('[data-recued-approval-action="arm"]');
  await arm.focus(); await arm.press('Enter');
  await expect(gate.locator('[data-recued-approval-action="confirm"]')).toBeFocused();
  await triageFilter(page, 'ask').click(); await invalidateTriage(page); await expect(triageFilter(page, 'ask')).toBeFocused();
  await triageFilter(page, 'gate').click(); await expect(gate.locator('[data-recued-approval-action="confirm"]')).toBeVisible();
  await triageFilter(page, 'all').click();
  expect(await page.evaluate(() => window.__approvalTriage.calls.filter(call => call.method === 'approval.resolve'))).toEqual([]);
  await page.evaluate(() => window.__approvalTriage.expectedWrites.push({ method: 'approval.resolve', args: { approval_id: 'gate-a', decision: 'approve' } }));
  await gate.locator('[data-recued-approval-action="confirm"]').press('Enter');
  await expect(gate).toHaveCount(0); await expect(triageFilter(page, 'all')).toHaveText('All (3)');
  await expect(queueTab(page, 'plan:plan-a')).toHaveAttribute('aria-selected', 'true');
  await expect(triageCard(page, 'plan-a')).toBeFocused();
  await page.evaluate(() => window.__approvalTriage.expectedWrites.push({ method: 'chat.plan.cancel', args: { plan_id: 'plan-a' } }));
  await triageCard(page, 'plan-a').locator('[data-recued-chat-plan-action="reject"]').press('Enter');
  const receipt = triage(page).locator('[data-recued-approvals-plan-resolution]');
  await expect(receipt).toBeVisible();
  await expect(triageFilter(page, 'all')).toHaveText('All (2)');
  await triageDrain(page);
  await expect(triageCard(page, 'ask-a')).toBeFocused();
  await expect(queueTab(page, 'ask:ask-a')).toHaveAttribute('aria-selected', 'true');
});

test('a pending secret guards departure, sends once and keeps later triage focus', async ({ page }) => {
  await openTriage(page, { width: 390, secret: true, held: ['notification.giveSecret'] });
  const form = triageCard(page, 'ask-a').locator('[data-recued-ask-secret]');
  const input = form.locator('input[type="password"]'); const use = form.getByRole('button', { name: 'Use it', exact: true });
  await use.click(); await expect(input).toBeFocused();
  const args = { ask_id: 'ask-a', value: 'fixture-sign-in-value', remember: true };
  await input.fill(args.value); await form.getByRole('checkbox').check();
  await page.evaluate(args => window.__approvalTriage.expectedWrites.push({ method: 'notification.giveSecret', args }), args);
  await input.focus(); await input.press('Enter'); await expect(use).toHaveAttribute('aria-busy', 'true');
  await expect(use).toBeFocused();
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  const dialogs: string[] = []; page.once('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.evaluate(() => window.__app.setHash('#yours')); await expect.poll(() => dialogs.length).toBe(1);
  await expect(page).toHaveURL(/#approvals$/u); await expect(use).toBeFocused();
  await use.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await triageFilter(page, 'gate').click(); await triageSearch(page).fill('another review');
  await page.evaluate(() => { const f = window.__approvalTriage; f.held = []; f.release('notification.giveSecret', 'success'); });
  await expect(form.locator('button[type="submit"]')).not.toHaveAttribute('aria-busy'); await expect(triageSearch(page)).toBeFocused();
  await triageClear(page).click(); await expect(input).toHaveValue('');
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
});

test('a secret refresh keeps pending ownership and recovers a failed give without reviving retired controls', async ({ page }) => {
  await openTriage(page, { secret: true, held: ['notification.giveSecret'] });
  await queueTab(page, 'ask:ask-a').click();
  const form = triageCard(page, 'ask-a').locator('[data-recued-ask-secret]'); const input = form.locator('input[type="password"]');
  const use = form.getByRole('button', { name: 'Use it', exact: true });
  const args = { ask_id: 'ask-a', value: 'first-fixture-value', remember: true };
  await input.fill(args.value); await form.getByRole('checkbox').check(); const retired = await form.elementHandle();
  await page.evaluate(args => window.__approvalTriage.expectedWrites.push({ method: 'notification.giveSecret', args }), args);
  await use.focus(); await use.press('Enter'); await expect(use).toHaveAttribute('aria-busy', 'true');
  await triageRefresh(page).click(); await expect(triageRefresh(page)).not.toHaveAttribute('aria-busy');
  expect(await retired!.evaluate(node => node.isConnected)).toBe(false);
  await expect(input).toHaveValue(''); await expect(input).toBeDisabled(); await expect(use).toHaveAttribute('aria-busy', 'true');
  await expect(form.getByRole('checkbox')).toBeChecked(); await expect(form.getByRole('checkbox')).toBeDisabled();
  await retired!.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await triageSearch(page).focus();
  await page.evaluate(() => { const f = window.__approvalTriage; f.held = []; f.release('notification.giveSecret', 'error'); });
  await expect(input).toBeEnabled(); await expect(form.getByRole('alert')).toHaveText('Recued could not give it. Try again.');
  await expect(triageSearch(page)).toBeFocused();
  const retry = { ...args, value: 'replacement-fixture-value', remember: false }; await input.fill(retry.value);
  await page.evaluate(args => window.__approvalTriage.expectedWrites.push({ method: 'notification.giveSecret', args }), retry);
  await use.focus(); await use.press('Enter'); await expect(input).toHaveValue('');
  await expect(form.getByRole('alert')).toBeHidden();
});

test('an accepted departure fences a late secret reply and the next mount starts empty', async ({ page }) => {
  await openTriage(page, { secret: true, serverProfiles: true, held: ['notification.giveSecret'] });
  await queueTab(page, 'ask:ask-a').click();
  const form = triageCard(page, 'ask-a').locator('[data-recued-ask-secret]');
  const args = { ask_id: 'ask-a', value: 'retired-fixture-value', remember: false };
  await form.locator('input[type="password"]').fill(args.value);
  await page.evaluate(args => window.__approvalTriage.expectedWrites.push({ method: 'notification.giveSecret', args }), args);
  await form.getByRole('button', { name: 'Use it', exact: true }).click();
  page.once('dialog', dialog => dialog.accept()); await page.evaluate(() => window.__app.setHash('#yours'));
  await expect(triage(page)).toHaveCount(0);
  // The bootstrap owns this request after its originating route is gone.
  await page.locator('[data-recued-account-menu-trigger]').click();
  const menu = page.locator('[data-recued-account-menu-popover]');
  await menu.locator('[data-recued-server-switcher-item]').filter({ hasText: 'Office server' }).click();
  const review = menu.locator('[data-recued-server-switcher-switch-confirm]');
  await expect(review).toContainText('Providing a sign-in value');
  await review.locator('[data-recued-server-switcher-switch-cancel]').click();
  await page.locator('[data-recued-account-menu-trigger]').click();
  await page.evaluate(() => { const f = window.__approvalTriage; f.held = []; f.release('notification.giveSecret', 'error'); });
  await triageDrain(page); await expect(triage(page)).toHaveCount(0);
  await page.evaluate(() => window.__app.setHash('#approvals'));
  await queueTab(page, 'ask:ask-a').click();
  await expect(triageCard(page, 'ask-a').locator('input[type="password"]')).toHaveValue('');
  await expect(triageCard(page, 'ask-a').getByRole('alert')).toBeHidden();
});

test('a future-run review stays a read-only handoff to its exact proposal', async ({ page }) => {
  await openTriage(page, { ownerReview: true, width: 390 });
  const card = triageCard(page, 'ask-a');
  await expect(card.locator('[data-recued-ask-option]')).toHaveCount(0);
  await expect(card.locator('textarea')).toHaveCount(0);
  const review = card.getByRole('link', { name: 'Look at this run', exact: true });
  await expect(review).toHaveAttribute('href', '#approvals/preapproval/proposal-a');
  await review.click(); await expect(page).toHaveURL(/#approvals\/preapproval\/proposal-a$/u);
  await expect(triage(page)).toHaveCount(0);
});

test.describe('pending decisions in Universal Search', () => {
  const group = (page: Page) => page.getByRole('region', { name: 'Pending decision search results', exact: true });
  const query = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
  const type = (page: Page) => page.getByRole('combobox', { name: 'Result type', exact: true });
  const hits = (page: Page) => group(page).locator('[data-search-decision-key]');
  const hit = (page: Page, key: string) => group(page).locator(`[data-search-decision-key="${key}"]`);
  const notice = (page: Page) => group(page).locator('[data-decision-search-error]');
  const find = async (page: Page, text = '') => {
    if (text !== await query(page).inputValue()) await query(page).fill(text);
    await type(page).selectOption('decision');
    await expect(group(page)).toHaveAttribute('aria-busy', 'false');
  };
  const boot = (page: Page, options: Parameters<typeof openTriage>[1] = {}) => openTriage(page, { ...options, address: '#data/search' });
  const back = (page: Page) => triage(page).getByRole('link', { name: 'Back to search', exact: true });
  const review = (page: Page) => triage(page).getByRole('region', { name: 'Matching decision navigation', exact: true });
  const remaining = (page: Page) => review(page).getByRole('status');
  const previous = (page: Page) => review(page).getByRole('button', { name: 'Previous matching decision', exact: true });
  const next = (page: Page) => review(page).getByRole('button', { name: 'Next matching decision', exact: true });

  test('finds readable requests across all three kinds while excluding hidden payloads, raw metadata, and typed values', async ({ page }) => {
    await boot(page); await find(page);
    await expect(hits(page)).toHaveCount(4);
    await query(page).fill('follow-up'); await expect(hits(page)).toHaveCount(3);
    await type(page).selectOption('all'); await expect(hit(page, 'gate:gate-a')).toBeVisible();
    await page.evaluate(() => {
      const f = window.__approvalTriage;
      f.plans[0]!.payload_available = false; f.plans[0]!.plan.args = { subject: 'hidden-payload-needle' };
      Object.assign(f.asks[0]!, { raw_metadata: 'hidden-metadata-needle', value: 'typed-value-needle' });
      f.asks[0]!.title = 'Review Café ﬁle <img.*>';
    });
    await group(page).getByRole('button', { name: 'Refresh pending decisions', exact: true }).click();
    await type(page).selectOption('decision');
    for (const text of ['hidden-payload-needle', 'hidden-metadata-needle', 'typed-value-needle']) {
      await query(page).fill(text);
      await expect(group(page)).toHaveAttribute('aria-busy', 'false');
      await expect(group(page).getByText('No pending decisions match this search.', { exact: true })).toBeVisible();
      await expect(hits(page)).toHaveCount(0);
    }
    await query(page).fill('CAFÉ FILE <img.*>'); await expect(hits(page)).toHaveCount(1);
    await expect(hit(page, 'ask:ask-a')).toContainText('Café ﬁle <img.*>');
    await expect(group(page).locator('img, textarea, input, [data-recued-ask-option], [data-recued-approval-action]')).toHaveCount(0);
  });

  test('opens each exact review and restores query, type, focus, and phone scroll through Back and browser Back', async ({ page }, info) => {
    await boot(page, { width: 390 });
    await page.evaluate(() => { const f = window.__approvalTriage, first = f.asks[0]!;
      for (let i = 0; i < 18; i++) f.asks.push({ ...first, ask_id: 'extra-' + i, created_at: first.created_at - 100 - i });
    });
    await find(page);
    const top = (key: string) => hit(page, key).evaluate(element => {
      for (let node = element.parentElement; node; node = node.parentElement)
        if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node.scrollTop;
      return document.scrollingElement?.scrollTop ?? 0;
    });
    for (const [key, text, count] of [['gate:gate-a', 'Remove archived', 1], ['ask:ask-b', 'additional visit', 20], ['plan:plan-a', 'Welcome pack', 1]] as const) {
      await query(page).fill(text); await expect(hits(page)).toHaveCount(count);
      const target = hit(page, key); await target.scrollIntoViewIfNeeded(); await target.focus();
      const before = await top(key); if (key === 'ask:ask-b') expect(before).toBeGreaterThan(0);
      if (key === 'ask:ask-b') await page.clock.setFixedTime(new Date(FIXED_NOW + 120_000));
      await page.keyboard.press('Enter');
      const id = key.slice(key.indexOf(':') + 1);
      await expect(triageCard(page, id)).toBeFocused();
      await expect(back(page)).toHaveAttribute('href', '#data/search');
      if (key === 'ask:ask-b') {
        await expect(triageSearch(page)).toHaveValue(text);
        await previous(page).press('Enter'); await expect(triageCard(page, 'ask-a')).toBeFocused();
        await next(page).press('Enter'); await expect(triageCard(page, 'ask-b')).toBeFocused();
        await page.screenshot({ path: info.outputPath('decision-search-review-phone.png'), animations: 'disabled' });
        await page.goBack();
      } else await back(page).click();
      await expect(query(page)).toHaveValue(text); await expect(type(page)).toHaveValue('decision');
      await expect(hit(page, key)).toBeFocused(); await expect(hits(page)).toHaveCount(count);
      await expect.poll(async () => Math.abs(await top(key) - before)).toBeLessThanOrEqual(2);
    }
  });

  test('steps through matching reviews by keyboard without losing notes or destructive confirmation', async ({ page }, info) => {
    await boot(page, { width: 390 }); await find(page, 'follow-up');
    await hit(page, 'ask:ask-a').press('Enter');
    await expect(triageSearch(page)).toHaveValue('follow-up');
    await expect(triageCard(page, 'plan-a')).toBeHidden();
    await expect(remaining(page)).toHaveText('3 matching decisions remaining. Reviewing 2 of 3.');
    await triageNote(page).fill('Keep this review reason.');
    await previous(page).focus(); await page.keyboard.press('Enter');
    await expect(triageCard(page, 'gate-a')).toBeFocused();
    await expect(previous(page)).toHaveAttribute('aria-disabled', 'true');
    await triageCard(page, 'gate-a').locator('[data-recued-approval-action="arm"]').press('Enter');
    const confirm = () => triageCard(page, 'gate-a').locator('[data-recued-approval-action="confirm"]');
    await expect(confirm()).toBeVisible();
    await next(page).focus(); await page.keyboard.press('Enter'); await expect(triageCard(page, 'ask-a')).toBeFocused();
    await expect(triageNote(page)).toHaveValue('Keep this review reason.');
    // Real keyboard traversal keeps the controls usable in WebKit too.
    await previous(page).focus(); await page.keyboard.press(info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(next(page)).toBeFocused(); await page.keyboard.press('Enter');
    await expect(triageCard(page, 'ask-b')).toBeFocused(); await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
    await next(page).evaluate(button => (button as HTMLButtonElement).click()); await expect(triageCard(page, 'ask-b')).toBeFocused();
    await previous(page).press('Enter'); await previous(page).press('Enter');
    await expect(triageCard(page, 'gate-a')).toBeFocused(); await expect(confirm()).toBeVisible();
    await page.screenshot({ path: info.outputPath('matching-decisions-phone.png'), animations: 'disabled' });
    await back(page).click(); await expect(hit(page, 'ask:ask-a')).toBeFocused();
    await expect(query(page)).toHaveValue('follow-up'); await expect(type(page)).toHaveValue('decision');
  });

  test('advances after each explicit decision across all three kinds and focuses the completed queue', async ({ page }) => {
    await boot(page); await find(page); await hit(page, 'gate:gate-a').press('Enter');
    await expect(remaining(page)).toHaveText('4 matching decisions remaining. Reviewing 1 of 4.');
    await page.evaluate(() => window.__approvalTriage.expectedWrites.push(
      { method: 'approval.resolve', args: { approval_id: 'gate-a', decision: 'approve' } },
      { method: 'chat.plan.cancel', args: { plan_id: 'plan-a' } },
      { method: 'notification.submitAnswer', args: { ask_id: 'ask-a', option_id: 'yes', note: 'Checked the extra visit.' } },
      { method: 'notification.submitAnswer', args: { ask_id: 'ask-b', option_id: 'no' } },
    ));
    await triageCard(page, 'gate-a').locator('[data-recued-approval-action="arm"]').press('Enter');
    await triageCard(page, 'gate-a').locator('[data-recued-approval-action="confirm"]').press('Enter');
    await expect(triageCard(page, 'plan-a')).toBeFocused(); await expect(remaining(page)).toContainText('3 matching decisions remaining');
    await expect(next(page)).toHaveAttribute('aria-disabled', 'false');
    await triageCard(page, 'plan-a').locator('[data-recued-chat-plan-action="reject"]').press('Enter');
    await expect(triageCard(page, 'ask-a')).toBeFocused();
    await expect(triage(page).locator('[data-recued-approvals-plan-resolution]')).toBeVisible();
    await triageNote(page).fill('Checked the extra visit.'); await triageApprove(page).press('Enter');
    await expect(triageCard(page, 'ask-b')).toBeFocused();
    await expect(remaining(page)).toHaveText('1 matching decision remaining. Reviewing 1 of 1.');
    await triageCard(page, 'ask-b').locator('[data-recued-ask-option="no"]').press('Enter');
    await expect(remaining(page)).toHaveText('0 matching decisions remaining.'); await expect(remaining(page)).toBeFocused();
    await expect(previous(page)).toHaveAttribute('aria-disabled', 'true'); await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
    await back(page).click(); await expect(hits(page)).toHaveCount(0); await expect(query(page)).toBeFocused();
    await expect(type(page)).toHaveValue('decision'); await expect(query(page)).toHaveValue('');
  });

  test('guards matching navigation during a write and keeps the exact failed review ready for retry', async ({ page }) => {
    await boot(page); await find(page, 'additional visit'); await hit(page, 'ask:ask-a').press('Enter');
    await triageNote(page).fill('Keep this if sending fails.');
    await page.evaluate(() => { const f = window.__approvalTriage; f.held = ['notification.submitAnswer'];
      f.expectedWrites.push({ method: 'notification.submitAnswer', args: { ask_id: 'ask-a', option_id: 'yes', note: 'Keep this if sending fails.' } }); });
    await triageApprove(page).press('Enter');
    await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
    // Dispatching click directly also exercises the handler's in-flight guard.
    await next(page).evaluate(button => (button as HTMLButtonElement).click());
    await expect(remaining(page)).toHaveText('2 matching decisions remaining. Reviewing 1 of 2.');
    await page.evaluate(() => { const f = window.__approvalTriage; f.held = []; f.release('notification.submitAnswer', 'error'); });
    await expect(triageApprove(page)).toBeFocused(); await expect(triageNote(page)).toHaveValue('Keep this if sending fails.');
    await expect(triageCard(page, 'ask-a').getByRole('alert')).toBeVisible();
    await expect(next(page)).toHaveAttribute('aria-disabled', 'false');
    await page.evaluate(() => { const f = window.__approvalTriage; f.expectedWrites.push(f.expectedWrites[0]!); });
    await triageApprove(page).press('Enter'); await expect(triageCard(page, 'ask-b')).toBeFocused();
    await expect(remaining(page)).toContainText('1 matching decision remaining');
  });

  test('reconciles live removals and new matches without taking focus from later filter edits', async ({ page }) => {
    await boot(page); await find(page, 'additional visit'); await hit(page, 'ask:ask-a').press('Enter');
    await page.evaluate(() => { window.__approvalTriage.asks = window.__approvalTriage.asks.filter(ask => ask.ask_id !== 'ask-a'); });
    await invalidateTriage(page); await expect(triageCard(page, 'ask-b')).toBeFocused();
    await expect(remaining(page)).toHaveText('1 matching decision remaining. Reviewing 1 of 1.');
    await triageSearch(page).fill('Welcome pack'); await expect(triageSearch(page)).toBeFocused();
    await expect(remaining(page)).toHaveText('1 matching decision remaining.');
    await page.evaluate(() => { const f = window.__approvalTriage; f.asks = [{ ...f.asks[0]!, ask_id: 'new-ask', title: 'Welcome pack follow-up' }]; });
    await invalidateTriage(page); await expect(triageSearch(page)).toBeFocused();
    await expect(remaining(page)).toHaveText('2 matching decisions remaining.');
    await next(page).press('Enter'); await expect(triageCard(page, 'plan-a')).toBeFocused();
    await next(page).press('Enter'); await expect(triageCard(page, 'new-ask')).toBeFocused();
    await triageFilter(page, 'gate').press('Enter'); await expect(remaining(page)).toHaveText('0 matching decisions remaining.');
    await expect(triageFilter(page, 'gate')).toBeFocused();
    await triageClear(page).press('Enter'); await expect(triageSearch(page)).toHaveValue('');
    await expect(remaining(page)).toHaveText('3 matching decisions remaining.');
    await back(page).click(); await expect(query(page)).toHaveValue('additional visit'); await expect(type(page)).toHaveValue('decision');
  });

  test('keeps a secret inside its review and guards navigation until its submission settles', async ({ page }) => {
    await boot(page, { secret: true, held: ['notification.giveSecret'] }); await find(page);
    await hit(page, 'ask:ask-a').press('Enter');
    const form = triageCard(page, 'ask-a').locator('[data-recued-ask-secret]');
    const input = form.locator('input[type="password"]'); const use = form.getByRole('button', { name: 'Use it', exact: true });
    const args = { ask_id: 'ask-a', value: 'queue-fixture-value', remember: false };
    await input.fill(args.value);
    await next(page).press('Enter'); await expect(triageCard(page, 'ask-b')).toBeFocused();
    await previous(page).press('Enter'); await expect(input).toHaveValue(args.value);
    await page.evaluate(args => window.__approvalTriage.expectedWrites.push({ method: 'notification.giveSecret', args }), args);
    await use.press('Enter'); await expect(use).toHaveAttribute('aria-busy', 'true');
    await expect(previous(page)).toHaveAttribute('aria-disabled', 'true'); await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
    await next(page).evaluate(button => (button as HTMLButtonElement).click()); await expect(use).toBeFocused();
    await page.evaluate(() => { const f = window.__approvalTriage; f.held = []; f.release('notification.giveSecret', 'success'); });
    await expect(input).toHaveValue(''); await expect(next(page)).toHaveAttribute('aria-disabled', 'false');
    await next(page).press('Enter'); await expect(triageCard(page, 'ask-b')).toBeFocused();
  });

  test('explains an arrival that stopped matching and waits for explicit navigation to the remaining match', async ({ page }) => {
    await boot(page); await find(page, 'additional visit');
    await page.evaluate(() => { const f = window.__approvalTriage; f.afterReply = method => {
      if (method === 'notification.pending_asks') { f.afterReply = undefined;
        f.asks = f.asks.map(ask => ask.ask_id === 'ask-a' ? { ...ask, body: 'Revised customer request.' } : ask);
      }
    }; });
    await hit(page, 'ask:ask-a').press('Enter');
    const landing = triage(page).locator('[data-decision-search-landing]');
    await expect(landing).toContainText('no longer matches'); await expect(landing).toBeFocused();
    await expect(triageCard(page, 'ask-a')).toBeHidden(); await expect(triageCard(page, 'ask-b')).not.toBeFocused();
    await expect(remaining(page)).toHaveText('1 matching decision remaining.');
    await next(page).press('Enter'); await expect(triageCard(page, 'ask-b')).toBeFocused(); await expect(landing).toBeHidden();
    await back(page).click(); await expect(query(page)).toHaveValue('additional visit'); await expect(hits(page)).toHaveCount(1);
  });

  test('labels incomplete queues and recovers their missing matches without changing the selected review', async ({ page }) => {
    await boot(page); await find(page); await hit(page, 'gate:gate-a').press('Enter');
    await expect(triageCard(page, 'gate-a')).toBeFocused();
    await page.evaluate(() => { window.__approvalTriage.failing = ['notification.pending_asks']; });
    await triageRefresh(page).press('Enter');
    await expect(remaining(page)).toContainText('among loaded decisions');
    await expect(triage(page).getByRole('alert').first()).toContainText('temporarily unavailable');
    await next(page).press('Enter'); await expect(triageCard(page, 'plan-a')).toBeFocused();
    await page.evaluate(() => { window.__approvalTriage.failing = []; });
    await triageRefresh(page).focus(); await triageRefresh(page).press('Enter');
    await expect(remaining(page)).toHaveText('4 matching decisions remaining. Reviewing 2 of 4.');
    await expect(triageRefresh(page)).toBeFocused();
    await next(page).press('Enter'); await expect(triageCard(page, 'ask-a')).toBeFocused();
  });

  test('refreshes pending counts after an explicit decision and keeps the search when its selected row disappears', async ({ page }) => {
    await boot(page); await find(page, 'additional visit'); await expect(hits(page)).toHaveCount(2);
    await hit(page, 'ask:ask-a').click(); await expect(triageCard(page, 'ask-a')).toBeFocused();
    const note = 'Checked this request.';
    await triageNote(page).fill(note);
    await page.evaluate(note => window.__approvalTriage.expectedWrites.push({ method: 'notification.submitAnswer', args: { ask_id: 'ask-a', option_id: 'yes', note } }), note);
    await triageApprove(page).click(); await expect(triageCard(page, 'ask-a')).toHaveCount(0);
    await back(page).click();
    await expect(query(page)).toHaveValue('additional visit'); await expect(type(page)).toHaveValue('decision');
    await expect(hits(page)).toHaveCount(1); await expect(hit(page, 'ask:ask-b')).toBeVisible();
    await expect(group(page).locator('.rq-group-count')).toHaveText('1'); await expect(query(page)).toBeFocused();
  });

  test('explains a resolved or changed selection and never substitutes another decision', async ({ page }) => {
    await boot(page); await find(page, 'follow-up');
    await page.evaluate(() => { window.__approvalTriage.gates = []; });
    await hit(page, 'gate:gate-a').press('Enter');
    await expect(notice(page)).toContainText('no longer pending'); await expect(notice(page)).toBeFocused();
    await expect(page).toHaveURL(/#data\/search$/u); await expect(hits(page)).toHaveCount(2);
    await page.evaluate(() => { window.__approvalTriage.asks[0]!.body = 'A revised follow-up request.'; });
    await hit(page, 'ask:ask-a').press('Enter');
    await expect(notice(page)).toContainText('changed'); await expect(notice(page)).toBeFocused();
    await expect(hit(page, 'ask:ask-a')).toContainText('A revised follow-up request.');
    await hit(page, 'ask:ask-a').press('Enter'); await expect(triageCard(page, 'ask-a')).toBeFocused();
  });

  test('keeps partial results and later query focus through failed reads and live refreshes', async ({ page }) => {
    await boot(page, { held: ['notification.pending_asks'] });
    await type(page).selectOption('decision'); await expect(hit(page, 'gate:gate-a')).toBeVisible();
    await expect(group(page)).toHaveAttribute('aria-busy', 'true');
    await query(page).fill('Welcome pack');
    await page.evaluate(() => { const f = window.__approvalTriage; f.held = []; f.failing = ['notification.pending_asks']; f.release('notification.pending_asks', 'error'); });
    await expect(hit(page, 'plan:plan-a')).toBeVisible(); await expect(group(page).getByRole('alert')).toContainText('temporarily unavailable');
    await expect(query(page)).toBeFocused();
    await expect(group(page)).not.toContainText('No pending decisions match');
    await page.evaluate(() => { window.__approvalTriage.failing = []; });
    await invalidateTriage(page);
    await expect(group(page)).toHaveAttribute('aria-busy', 'false'); await expect(group(page).getByRole('alert')).toHaveCount(0);
    await expect(hits(page)).toHaveCount(1); await expect(query(page)).toBeFocused();
  });

  test('retires a pending selection check when the query changes and never follows its late reply', async ({ page }) => {
    await boot(page); await find(page, 'follow-up');
    for (const [text, key, count] of [['follow-up ', 'gate:gate-a', 3], ['Welcome pack', 'plan:plan-a', 1]] as const) {
      await page.evaluate(() => { window.__approvalTriage.held = ['approval.list']; });
      await hit(page, 'gate:gate-a').press('Enter'); await expect(notice(page)).toBeFocused();
      await expect.poll(() => page.evaluate(() => window.__approvalTriage.pending('approval.list'))).toBeGreaterThan(0);
      await query(page).fill(text);
      await page.evaluate(() => { const f = window.__approvalTriage; f.held = []; f.release('approval.list', 'success'); });
      await expect(hit(page, key)).toBeVisible(); await expect(hits(page)).toHaveCount(count);
      await expect(group(page)).toHaveAttribute('aria-busy', 'false'); await expect(query(page)).toBeFocused();
      await expect(page).toHaveURL(/#data\/search$/u); await expect(notice(page)).toHaveCount(0);
    }
  });

  test('explains a decision resolved between Search confirmation and arrival, with a direct return', async ({ page }) => {
    await boot(page); await find(page, 'Remove archived');
    await page.evaluate(() => { const f = window.__approvalTriage; f.afterReply = method => {
      if (method === 'approval.list') { f.afterReply = undefined; f.gates = []; }
    }; });
    await hit(page, 'gate:gate-a').press('Enter');
    const landing = triage(page).locator('[data-decision-search-landing]');
    await expect(landing).toContainText('no longer pending'); await expect(landing).toBeFocused();
    await expect(triageCard(page, 'gate-a')).toHaveCount(0);
    await back(page).click(); await expect(query(page)).toHaveValue('Remove archived');
    await expect(hits(page)).toHaveCount(0); await expect(query(page)).toBeFocused();
  });

  test('saves the Pending decisions type through existing Saved Views and reopens the same review from it', async ({ page }) => {
    await boot(page); await find(page, 'additional visit');
    const tools = page.locator('[data-saved-data-views]');
    await tools.getByRole('button', { name: 'Save current view', exact: true }).click();
    await tools.getByLabel('View name', { exact: true }).fill('Customer decisions');
    await tools.getByRole('button', { name: 'Save view', exact: true }).click();
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-saved-data-views') ?? '[]').at(-1));
    expect(saved.definition).toEqual({ tab: 'search', query: 'additional visit', result_type: 'decision' });
    await page.evaluate(hash => window.__app.setHash(hash), '#views/' + saved.id);
    await expect(type(page)).toHaveValue('decision'); await expect(hits(page)).toHaveCount(2);
    await hit(page, 'ask:ask-b').press('Enter'); await expect(back(page)).toHaveAttribute('href', '#views/' + saved.id);
    await back(page).click(); await expect(hit(page, 'ask:ask-b')).toBeFocused(); await expect(query(page)).toHaveValue('additional visit');
  });
});
