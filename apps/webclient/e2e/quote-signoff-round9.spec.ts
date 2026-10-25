import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { openSignoffRequestDetails } from './helpers/signoff-request.js';
import type {} from './harness/quote-signoff-harness.js';

declare global {
  interface Window { __round9Copy: { writes: string[]; hold: boolean; release?: () => void } }
}
type Kind = 'quote' | 'completion';
const BASE = HARNESS_ORIGIN + '/quote-signoff-harness.html';
const DAY = 86_400_000;
const errors = new WeakMap<Page,string[]>();
test.beforeEach(async ({ page }) => {
  const list: string[] = []; errors.set(page,list); page.on('pageerror',error => list.push(error.message));
  const policy = (await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8'))
    .match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route('**/quote-signoff-harness.html*',async route => {
    const response = await route.fetch();
    await route.fulfill({ response,headers: { ...response.headers(),'content-security-policy': policy } });
  });
  await page.clock.install({ time: new Date('2026-10-24T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-24T12:00:01Z'));
});
test.afterEach(async ({ page }) => expect(errors.get(page)).toEqual([]));
async function prepare(page: Page,kind: Kind = 'quote',query = '',days = 7) {
  await page.goto(BASE + '?' + (kind === 'completion' ? 'completion&' : '') + query);
  if (kind === 'quote') {
    const creation = page.locator('[data-signoff-create]');
    if (!await creation.evaluate(node => (node as HTMLDetailsElement).open)) await creation.locator('summary').first().click();
    await page.getByRole('combobox',{ name: 'Open quote',exact: true }).selectOption('Q1');
    for (const [label,value] of [['Business name shown to the customer','Studio'],['Complete scope shown to the customer','Three drawings and final PDF delivery.'],
      ['Task to create after your approval','Deliver drawings'],['Invoice reference','INV-NEW']]) await page.getByLabel(label!,{ exact: true }).fill(value!);
    await page.getByLabel('Link lifetime in days',{ exact: true }).fill(String(days));
  } else {
    await openSignoffRequestDetails(page.locator('[data-signoff-history] article').first());
    await page.getByRole('button',{ name: 'Request completion',exact: true }).click();
    await page.getByLabel('Delivered work shown to the customer',{ exact: true }).fill('Delivered all three drawings and final PDF.');
    await page.getByLabel('Completion link life (days)',{ exact: true }).fill(String(days));
  }
  await page.getByRole('button',{ name: kind === 'quote' ? 'Prepare sign-off preview' : 'Prepare completion preview',exact: true }).click();
  const publish = page.getByRole('button',{ name: kind === 'quote' ? 'Publish sign-off link' : 'Publish completion link',exact: true });
  await expect(publish).toBeEnabled();
  return { publish,preview: kind === 'quote' ? page.locator('[data-signoff-preview]') : page.getByRole('form',{ name: 'Request customer completion',exact: true }) };
}
async function published(page: Page,kind: Kind = 'quote',days = 7) {
  const controls = await prepare(page,kind,'',days); await controls.publish.click();
  const share = page.locator('[data-customer-link-share]'); await expect(share.locator('input')).not.toHaveValue('');
  await expect(page.getByRole('button',{ name: kind === 'quote' ? 'Prepare sign-off preview' : 'Refresh completions',exact: true })).toBeEnabled();
  return { ...controls,share };
}
const recovery = (page: Page) => page.getByRole('button',{ name: 'Resume saved sign-off preview',exact: true,includeHidden: true });
const historyStatus = (page: Page) => page.locator('[data-recued-quote-signoffs] > [role=status]').nth(1);
const completionStatus = (page: Page) => page.locator('[data-completion-load-status]');
async function calls(page: Page,method: string) { return page.evaluate(method => window.__quoteSignoff.calls.filter(call => call.method === method),method); }
async function failPublication(page: Page,mode: 'offline' | 'expired' = 'offline',filter: 'state' | 'search' = 'state',days = 7) {
  const controls = await prepare(page,'quote','',days);
  const deadline = await controls.preview.locator('[data-customer-request-expiry] time').getAttribute('datetime');
  if (filter === 'state') await page.getByRole('combobox',{ name: 'Request status',exact: true }).selectOption('waiting');
  else { await page.getByLabel('Find customer, quote or invoice',{ exact: true }).fill('unrelated customer'); await page.getByRole('button',{ name: 'Search',exact: true }).click(); }
  await expect(page.locator('[data-signoff-history] article')).toHaveCount(0);
  await page.evaluate(mode => window.__quoteSignoff.failPublish(mode),mode); await controls.publish.click();
  await expect(recovery(page)).toBeVisible(); await expect(recovery(page)).toBeEnabled(); return { ...controls,deadline };
}
async function receipt(page: Page,query = 'waiting') {
  await page.goto(BASE + '?' + query); const card = page.locator('[data-signoff-history] article').first();
  await openSignoffRequestDetails(card); await card.getByRole('button',{ name: 'View sign-off receipt',exact: true }).click();
  const view = page.getByRole('region',{ name: 'Sign-off receipt',exact: true });
  await expect(view.getByRole('button',{ name: 'Refresh receipt',exact: true })).toBeEnabled(); return view;
}
async function otherWork(page: Page) {
  await page.evaluate(() => { const field = document.createElement('input'); field.setAttribute('aria-label','Other owner work'); document.body.appendChild(field); });
  return page.getByLabel('Other owner work',{ exact: true });
}
async function installClipboard(page: Page,hold = false) {
  await page.addInitScript(hold => {
    window.__round9Copy = { writes: [],hold };
    Object.defineProperty(navigator,'clipboard',{ configurable: true,value: { writeText: async (value: string) => {
      window.__round9Copy.writes.push(value);
      if (window.__round9Copy.hold) await new Promise<void>(resolve => { window.__round9Copy.release = resolve; });
    } } });
    document.addEventListener('copy',event => event.preventDefault());
  },hold);
}

test.describe('1. Quote recovery outside history filters',() => {
  for (const mode of ['offline','expired'] as const) for (const filter of ['state','search'] as const) test(mode + ' recovers the same saved request under ' + filter,async ({ page },info) => {
    const controls = await failPublication(page,mode,filter);
    await page.screenshot({ path: info.outputPath('visible-quote-recovery.png') });
    await page.evaluate(() => window.__quoteSignoff.failPublish(null)); await recovery(page).focus(); await recovery(page).press('Enter');
    await expect(controls.publish).toBeEnabled(); await expect(recovery(page)).toBeHidden();
    await expect(controls.preview.locator('[data-customer-request-expiry] time')).toHaveAttribute('datetime',controls.deadline!);
    expect(await calls(page,'reception.signoff.prepare')).toHaveLength(1);
    expect((await calls(page,'reception.signoff.resume'))[0]!.payload).toEqual({ signoff_id: 'a1fecd4e-42ce-42a2-b7e7-731ce51a01b2' });
  });
  test('a failed resume retains its same-request recovery',async ({ page }) => {
    const { publish } = await failPublication(page); await page.evaluate(() => window.__quoteSignoff.failResume(true)); await recovery(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Fixture resume unavailable.' })).toBeVisible(); await expect(recovery(page)).toBeEnabled();
    await page.evaluate(() => window.__quoteSignoff.failResume(false)); await recovery(page).click(); await expect(publish).toBeEnabled();
    expect(await calls(page,'reception.signoff.prepare')).toHaveLength(1);
  });
  test('edited terms cannot resume and discarding retires recovery',async ({ page }) => {
    await failPublication(page); const field = page.getByLabel('Complete scope shown to the customer',{ exact: true });
    await field.fill('Edited scope.'); await expect(recovery(page)).toBeHidden(); await recovery(page).dispatchEvent('click'); expect(await calls(page,'reception.signoff.resume')).toHaveLength(0);
    await field.fill('Three drawings and final PDF delivery.'); await expect(recovery(page)).toBeVisible();
    await page.getByRole('button',{ name: 'Discard draft',exact: true }).click(); await expect(recovery(page)).toBeHidden();
    await recovery(page).dispatchEvent('click'); expect(await calls(page,'reception.signoff.resume')).toHaveLength(0);
  });
  test('another preparation clears recovery even when preparation fails',async ({ page }) => {
    await failPublication(page); await page.evaluate(() => window.__quoteSignoff.prepareFailure('before'));
    await page.getByRole('button',{ name: 'Prepare sign-off preview',exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Fixture preview unavailable.' })).toBeVisible(); await expect(recovery(page)).toBeHidden();
  });
  test('the saved customer deadline ends recovery without another gesture',async ({ page }) => {
    await failPublication(page,'offline','state',1); await page.clock.fastForward(DAY + 1); await expect(recovery(page)).toBeHidden();
    await recovery(page).dispatchEvent('click'); expect(await calls(page,'reception.signoff.resume')).toHaveLength(0);
  });
  test('a changed saved request retires recovery',async ({ page }) => {
    await failPublication(page); await page.getByRole('button',{ name: 'Clear search',exact: true }).click();
    await page.evaluate(() => window.__quoteSignoff.quoteResponse('declined')); await expect(recovery(page)).toBeHidden();
  });
  test('a disposed recovery cannot resume or recreate the previous view',async ({ page }) => {
    await failPublication(page); const old = await recovery(page).elementHandle(); await page.evaluate(() => window.__quoteSignoff.dispose());
    await old!.evaluate(node => node.dispatchEvent(new MouseEvent('click',{ bubbles: true }))); await page.clock.fastForward(DAY);
    expect(await calls(page,'reception.signoff.resume')).toHaveLength(0); await expect(page.locator('[data-recued-quote-signoffs]')).toHaveCount(0);
  });
});

test.describe('2. Failed completion filter context',() => {
  for (const from of ['all','review'] as const) test('retains the actual ' + from + ' result label on filter failure',async ({ page },info) => {
    await published(page,'completion'); const filter = page.getByLabel('Completion requests',{ exact: true }); const history = page.locator('[data-completion-history]');
    if (from === 'review') { await page.evaluate(() => window.__quoteSignoff.completionResponse('accepted')); await filter.selectOption('review'); await expect(history).toContainText('Customer accepted completion.'); }
    await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.completion.list'));
    const to = from === 'all' ? 'review' : 'all'; await filter.focus(); await filter.selectOption(to);
    await expect(completionStatus(page)).toContainText('Previous results are shown below.');
    await page.evaluate(() => { window.__quoteSignoff.failCompletion(true); window.__quoteSignoff.release(); });
    await expect(history).toHaveAttribute('aria-busy','false');
    await expect(completionStatus(page)).toHaveText('Completion unavailable. Try again. Previous results for ' + (from === 'all' ? 'All requests' : 'Needs owner review') + ' are shown below.');
    await expect(filter).toHaveValue(to); await page.screenshot({ path: info.outputPath('failed-filter-retained-context.png') });
    await page.evaluate(() => window.__quoteSignoff.failCompletion(false)); await page.getByRole('button',{ name: 'Refresh completions',exact: true }).click();
    await expect(completionStatus(page)).toBeEmpty(); expect((await calls(page,'reception.signoff.completion.list')).at(-1)!.payload).toEqual({ limit: 50,...(to === 'review' ? { review_only: true } : {}) });
    await expect(history.locator('article')).toHaveCount(to === 'review' ? 0 : 1);
  });
  test('an initial failure does not claim to retain results',async ({ page }) => {
    await page.goto(BASE + '?defer=reception.signoff.completion.list'); await page.evaluate(() => { window.__quoteSignoff.failCompletion(true); window.__quoteSignoff.release(); });
    await expect(completionStatus(page)).toHaveText('Completion unavailable. Try again.');
  });
  for (const filter of ['all','review'] as const) test('an unchanged ' + filter + ' filter keeps its concise refresh error',async ({ page }) => {
    await published(page,'completion');
    if (filter === 'review') {
      await page.evaluate(() => window.__quoteSignoff.completionResponse('accepted'));
      await page.getByLabel('Completion requests',{ exact: true }).selectOption('review');
      await expect(page.locator('[data-completion-history]')).toContainText('Customer accepted completion.');
    }
    await page.evaluate(() => window.__quoteSignoff.failCompletion(true));
    await page.getByRole('button',{ name: 'Refresh completions',exact: true }).click();
    await expect(completionStatus(page)).toHaveText('Completion unavailable. Try again.');
    await expect(page.getByLabel('Completion requests',{ exact: true })).toHaveValue(filter);
    await expect(page.locator('[data-completion-history] article')).toHaveCount(1);
  });
  test('a stale filter failure cannot erase the newer successful query',async ({ page }) => {
    await published(page,'completion'); const filter = page.getByLabel('Completion requests',{ exact: true });
    await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.completion.list','older'));
    await filter.selectOption('review'); await filter.selectOption('all'); await expect(completionStatus(page)).toBeEmpty();
    await page.evaluate(() => { window.__quoteSignoff.failCompletion(true); window.__quoteSignoff.release('older'); }); await page.clock.runFor(2);
    await expect(completionStatus(page)).toBeEmpty(); await expect(filter).toHaveValue('all');
  });
});

test.describe('3. Receipt refresh continuity',() => {
  for (const failure of [false,true]) for (const newer of [false,true]) test('retains collapsed terms and appropriate focus, failure=' + failure + ', newer=' + newer,async ({ page }) => {
    const view = await receipt(page); const terms = view.locator('details').first(); const refresh = view.getByRole('button',{ name: 'Refresh receipt',exact: true });
    await terms.locator('summary').click(); await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.receipt')); await refresh.press('Enter');
    const field = page.getByLabel('Find customer, quote or invoice',{ exact: true }); if (newer) await field.fill('Newer owner work');
    await page.evaluate(failure => { window.__quoteSignoff.failReceipt(failure); window.__quoteSignoff.release(); },failure); await expect(refresh).toBeEnabled();
    expect(await terms.evaluate(node => (node as HTMLDetailsElement).open)).toBe(false); await expect(newer ? field : refresh).toBeFocused();
  });
  test('honors a disclosure change made while refreshing',async ({ page }) => {
    const view = await receipt(page); const terms = view.locator('details').first(); await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.receipt'));
    await view.getByRole('button',{ name: 'Refresh receipt',exact: true }).press('Enter'); await terms.locator('summary').click();
    await page.evaluate(() => window.__quoteSignoff.release()); await expect(view.getByRole('button',{ name: 'Refresh receipt',exact: true })).toBeEnabled();
    expect(await terms.evaluate(node => (node as HTMLDetailsElement).open)).toBe(false);
    await expect(terms.locator('summary')).toBeFocused();
  });
  for (const end of ['close','dispose','switch'] as const) test('a late refresh cannot restore focus after ' + end,async ({ page }) => {
    const view = await receipt(page,'waiting&two_receipts'); await view.locator('details').first().locator('summary').click();
    await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.receipt')); await view.getByRole('button',{ name: 'Refresh receipt',exact: true }).press('Enter');
    if (end === 'close') await view.getByRole('button',{ name: 'Close receipt',exact: true }).click();
    else if (end === 'dispose') await page.evaluate(() => window.__quoteSignoff.dispose());
    else { const card = page.locator('[data-signoff-history] article').nth(1); await openSignoffRequestDetails(card); await card.getByRole('button',{ name: 'View sign-off receipt',exact: true }).click(); await expect(view).toContainText('Taylor'); }
    const field = await otherWork(page); await field.fill('Newer owner work'); await page.evaluate(() => window.__quoteSignoff.release());
    await expect(field).toBeFocused();
    if (end === 'switch') { await expect(view).toContainText('Taylor'); expect(await view.locator('details').first().evaluate(node => (node as HTMLDetailsElement).open)).toBe(true); }
    else await expect(view).toBeHidden();
  });
});

test.describe('4. Cancellation focus',() => {
  for (const kind of ['quote','completion'] as const) for (const outcome of ['success','failure','newer','dispose'] as const) test(kind + ' cancellation ' + outcome,async ({ page }) => {
    const { share } = await published(page,kind); const card = page.locator(kind === 'quote' ? '[data-signoff-history] article' : '[data-completion-history] article').first();
    if (kind === 'quote') await openSignoffRequestDetails(card);
    const label = kind === 'quote' ? 'Cancel request' : 'Cancel completion request'; const method = kind === 'quote' ? 'reception.signoff.cancel' : 'reception.signoff.completion.cancel';
    const field = await otherWork(page); if (outcome === 'failure') await page.evaluate(() => window.__quoteSignoff.failCancel(true));
    await page.evaluate(method => window.__quoteSignoff.deferNext(method),method); await card.getByRole('button',{ name: label,exact: true }).press('Enter');
    if (outcome === 'newer' || outcome === 'dispose') await field.fill('Newer owner editing');
    if (outcome === 'dispose') await page.evaluate(() => window.__quoteSignoff.dispose());
    await page.evaluate(() => window.__quoteSignoff.release()); await page.clock.runFor(3);
    if (outcome === 'dispose') { await expect(page.locator('[data-recued-quote-signoffs]')).toHaveCount(0); await expect(field).toBeFocused(); }
    else {
      await expect(page.getByRole('button',{ name: kind === 'quote' ? 'Refresh' : 'Refresh completions',exact: true })).toBeEnabled();
      if (outcome === 'failure') { await expect(card.getByRole('button',{ name: label,exact: true })).toBeFocused(); await expect(share.locator('input')).toBeEnabled(); }
      else { await expect(card).toContainText('Cancelled'); await expect(share.locator('input')).toBeDisabled(); await expect(outcome === 'newer' ? field : card.locator('summary').first()).toBeFocused(); }
    }
    expect(await calls(page,method)).toHaveLength(1);
  });
});

test.describe('5. Successful Copy link focus',() => {
  for (const kind of ['quote','completion'] as const) test(kind + ' keyboard copy retains focus and copies the exact link',async ({ page }) => {
    await installClipboard(page); const { share } = await published(page,kind); const copy = share.getByRole('button',{ name: 'Copy link',exact: true }); const url = await share.locator('input').inputValue();
    await copy.press('Enter'); await expect(share.getByRole('status')).toHaveText('Link copied.'); await expect(copy).toBeFocused(); expect(await page.evaluate(() => window.__round9Copy.writes)).toEqual([url]);
  });
  for (const kind of ['quote','completion'] as const) for (const newer of ['field','copy','dispose','expiry'] as const) test(kind + ' pending write respects newer ' + newer,async ({ page }) => {
    await installClipboard(page,true); const { share } = await published(page,kind,1); await share.getByRole('button',{ name: 'Copy link',exact: true }).press('Enter');
    await expect.poll(() => page.evaluate(() => window.__round9Copy.writes.length)).toBe(1);
    const field = await otherWork(page);
    if (newer === 'field' || newer === 'dispose') await field.fill('Newer work');
    else if (newer === 'copy') {
      await share.locator('[data-customer-link-identity]').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); });
      await page.keyboard.press('ControlOrMeta+C');
      await page.evaluate(() => document.activeElement?.setAttribute('data-round9-kept-focus','true'));
    }
    if (newer === 'dispose') await page.evaluate(() => window.__quoteSignoff.dispose());
    if (newer === 'expiry') await page.clock.fastForward(DAY + 1);
    await page.evaluate(() => window.__round9Copy.release?.()); await page.clock.runFor(2);
    if (newer === 'field' || newer === 'dispose') await expect(field).toBeFocused();
    else if (newer === 'expiry') { await expect(share.locator('input')).toBeDisabled(); await expect(share.getByRole('heading')).toHaveText('Link unavailable'); }
    else expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-round9-kept-focus'))).toBe(true);
  });
});

test.describe('6. Quote read feedback during activation',() => {
  for (const gesture of ['mouse','Space'] as const) for (const failure of [false,true]) test(gesture + ' keeps its disclosure through a read, failure=' + failure,async ({ page },info) => {
    await page.setViewportSize({ width: 390,height: 1100 }); await page.goto(BASE + '?waiting');
    const summary = page.locator('[data-signoff-history] [data-signoff-disclosure="actions"] > summary').first(); await expect(summary).toBeVisible(); await summary.scrollIntoViewIfNeeded();
    const before = await summary.boundingBox(); await summary.evaluate(node => node.setAttribute('data-round9-pressed','true'));
    if (gesture === 'mouse') { await page.mouse.move(before!.x + 40,before!.y + before!.height / 2); await page.mouse.down(); }
    else { await summary.focus(); await page.keyboard.down('Space'); }
    await page.evaluate(() => { window.__quoteSignoff.deferNext('reception.signoff.list'); window.__quoteSignoff.update(); });
    const error = 'The saved requests could not be read. The connection was interrupted while checking the saved customer response. Refresh the list and try again.';
    await page.evaluate(error => { window.__quoteSignoff.failSignoffList(error); window.__quoteSignoff.release(); },failure ? error : null); await page.clock.runFor(2);
    const after = await summary.boundingBox(); expect(after!.y).toBe(before!.y); await expect(summary).toHaveAttribute('data-round9-pressed','true');
    expect(await summary.evaluate(node => (node.parentElement as HTMLDetailsElement).open)).toBe(false);
    if (gesture === 'mouse') await page.mouse.up(); else await page.keyboard.up('Space'); await page.clock.runFor(3);
    await expect.poll(() => summary.evaluate(node => (node.parentElement as HTMLDetailsElement).open)).toBe(true);
    if (failure) await expect(historyStatus(page)).toContainText(error); else await expect(historyStatus(page)).toHaveText('Page 1 · 1 request.');
    await page.screenshot({ path: info.outputPath('activation-survives-feedback.png') });
  });
  test('an older read failure cannot overwrite the latest history result',async ({ page }) => {
    await page.goto(BASE + '?waiting'); await expect(historyStatus(page)).toHaveText('Page 1 · 1 request.');
    await page.evaluate(() => { window.__quoteSignoff.deferNext('reception.signoff.list','older'); window.__quoteSignoff.update(); });
    await page.evaluate(() => window.__quoteSignoff.update()); await expect(historyStatus(page)).toHaveText('Page 1 · 1 request.');
    await page.evaluate(() => { window.__quoteSignoff.failSignoffList('Older failure'); window.__quoteSignoff.release('older'); }); await page.clock.runFor(2);
    await expect(historyStatus(page)).toHaveText('Page 1 · 1 request.');
  });
  test('disposal releases a gesture-blocked failure without restoring old content',async ({ page }) => {
    await page.goto(BASE + '?waiting'); const summary = page.locator('[data-signoff-history] [data-signoff-disclosure="actions"] > summary').first();
    const box = await summary.boundingBox(); await page.mouse.move(box!.x + 20,box!.y + box!.height / 2); await page.mouse.down();
    await page.evaluate(() => { window.__quoteSignoff.deferNext('reception.signoff.list'); window.__quoteSignoff.update(); window.__quoteSignoff.failSignoffList('Late failure'); window.__quoteSignoff.release(); });
    await page.clock.runFor(2); await page.evaluate(() => window.__quoteSignoff.dispose()); await page.mouse.up(); await page.clock.runFor(2);
    await expect(page.locator('[data-recued-quote-signoffs]')).toHaveCount(0);
  });
});
