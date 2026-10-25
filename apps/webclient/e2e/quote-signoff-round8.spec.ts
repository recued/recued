import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { openSignoffRequestDetails } from './helpers/signoff-request.js';
import type {} from './harness/quote-signoff-harness.js';

declare global {
  interface Window {
    __round8Clipboard: { value: string; writes: string[]; intents: string[] };
    __round8PrintCallbacks: Array<() => void>;
  }
}
type Kind = 'quote' | 'completion';
const BASE = HARNESS_ORIGIN + '/quote-signoff-harness.html';
const DAY = 86_400_000;
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message));
  const policy = (await readFile(resolve(import.meta.dirname, '../public/_headers'), 'utf8'))
    .match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route('**/quote-signoff-harness.html*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
  });
});
test.afterEach(async ({ page }) => expect(errors.get(page)).toEqual([]));
async function prepare(page: Page, kind: Kind = 'quote', query = '', days = 7) {
  await page.goto(BASE + '?' + (kind === 'completion' ? 'completion&' : '') + query);
  if (kind === 'quote') {
    const creation = page.locator('[data-signoff-create]');
    if (!await creation.evaluate(node => (node as HTMLDetailsElement).open)) await creation.locator('summary').first().click();
    await page.getByRole('combobox', { name: 'Open quote', exact: true }).selectOption('Q1');
    for (const [label, value] of [
      ['Business name shown to the customer', 'Studio'], ['Complete scope shown to the customer', 'Three drawings and final PDF delivery.'],
      ['Task to create after your approval', 'Deliver drawings'], ['Invoice reference', 'INV-NEW'],
    ]) await page.getByLabel(label!, { exact: true }).fill(value!);
    await page.getByLabel('Link lifetime in days', { exact: true }).fill(String(days));
  } else {
    await openSignoffRequestDetails(page.locator('[data-signoff-history] article').first());
    await page.getByRole('button', { name: 'Request completion', exact: true }).click();
    await page.getByLabel('Delivered work shown to the customer', { exact: true }).fill('Delivered all three drawings and final PDF.');
    await page.getByLabel('Completion link life (days)', { exact: true }).fill(String(days));
  }
  await page.getByRole('button', { name: kind === 'quote' ? 'Prepare sign-off preview' : 'Prepare completion preview', exact: true }).click();
  const publish = page.getByRole('button', { name: kind === 'quote' ? 'Publish sign-off link' : 'Publish completion link', exact: true });
  await expect(publish).toBeEnabled();
  return { publish, preview: kind === 'quote' ? page.locator('[data-signoff-preview]') : page.getByRole('form', { name: 'Request customer completion', exact: true }) };
}
async function publish(page: Page, kind: Kind = 'quote', query = '', days = 7) {
  const controls = await prepare(page, kind, query, days); await controls.publish.click();
  const share = page.locator('[data-customer-link-share]'); await expect(share.locator('input')).not.toHaveValue('');
  return { ...controls, share };
}
async function callCount(page: Page, method: string) {
  return page.evaluate(method => window.__quoteSignoff.calls.filter(call => call.method === method).length, method);
}
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0))); }
const recovery = (page: Page) => page.getByRole('button', { name: 'Resume saved completion preview', exact: true, includeHidden: true });
async function failPublication(page: Page, mode: 'offline' | 'expired' = 'offline', days = 7) {
  const controls = await prepare(page, 'completion', '', days);
  const deadline = await controls.preview.locator('[data-customer-request-expiry] time').getAttribute('datetime');
  await page.getByLabel('Completion requests', { exact: true }).selectOption('review');
  await expect(page.locator('[data-completion-history] article')).toHaveCount(0);
  await page.evaluate(mode => window.__quoteSignoff.failPublish(mode), mode); await controls.publish.click();
  await expect(recovery(page)).toBeVisible(); await expect(recovery(page)).toBeEnabled();
  return { ...controls, deadline };
}
async function openReceipt(page: Page) {
  const card = page.locator('[data-signoff-history] article').first(); await openSignoffRequestDetails(card);
  await card.getByRole('button', { name: 'View sign-off receipt', exact: true }).click();
  const view = page.getByRole('region', { name: 'Sign-off receipt', exact: true });
  await expect(view.getByRole('button', { name: 'Print / save PDF', exact: true })).toBeEnabled(); return view;
}
async function installPrintCompletion(page: Page) {
  // Capture the actual owner callback; this checks UI cleanup without opening
  // an OS dialog or depending on synthetic events in a script-disabled frame.
  await page.addInitScript(() => {
    window.__round8PrintCallbacks = [];
    window.print = () => document.documentElement.setAttribute('data-round8-printed', 'true');
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (this: EventTarget, type, listener, options) {
      const target = this;
      if (type === 'load' && target instanceof HTMLIFrameElement && target.hasAttribute('data-signoff-receipt-print')) {
        const original = listener;
        listener = (event: Event) => {
          const view = target.contentWindow!;
          const register = view.addEventListener.bind(view) as EventTarget['addEventListener'];
          view.addEventListener = ((name: string, callback: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => {
            if (name === 'afterprint' && typeof callback === 'function') window.__round8PrintCallbacks.push(() => callback.call(view, new Event('afterprint')));
            register(name, callback, opts);
          }) as typeof view.addEventListener;
          if (typeof original === 'function') original.call(target, event); else original?.handleEvent(event);
        };
      }
      add.call(target, type, listener, options);
    };
  });
}
async function startPrint(page: Page, view: Locator, count = 1) {
  await view.getByRole('button', { name: 'Print / save PDF', exact: true }).press('Enter');
  await expect(page.frameLocator('[data-signoff-receipt-print]').locator('html')).toHaveAttribute('data-round8-printed', 'true');
  await expect.poll(() => page.evaluate(() => window.__round8PrintCallbacks.length)).toBe(count);
}

test.describe('1. Later clipboard intent wins', () => {
  for (const kind of ['quote', 'completion'] as const) for (const newer of ['none', 'copy', 'cut'] as const) {
    test(kind + ' pending availability respects newer ' + newer, async ({ page }) => {
      await page.clock.install({ time: new Date('2026-10-24T12:00:00Z') });
      await page.clock.pauseAt(new Date('2026-10-24T12:00:01Z'));
      await page.addInitScript(() => {
        window.__round8Clipboard = { value: '', writes: [], intents: [] };
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
          window.__round8Clipboard.value = value; window.__round8Clipboard.writes.push(value);
        } } });
        const copied = (event: Event) => {
          event.preventDefault(); if (!event.isTrusted) return;
          const field = document.activeElement;
          if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
            window.__round8Clipboard.value = field.value.slice(field.selectionStart!, field.selectionEnd!);
            window.__round8Clipboard.intents.push(event.type);
          }
        };
        document.addEventListener('copy', copied, true); document.addEventListener('cut', copied, true);
      });
      const { share } = await publish(page, kind); const url = await share.locator('input').inputValue();
      await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.link.check'));
      await share.getByRole('button', { name: 'Copy link', exact: true }).click();
      await expect(share.getByRole('heading', { name: 'Checking saved link', exact: true })).toBeVisible();
      const field = page.getByLabel('Find customer, quote or invoice', { exact: true });
      if (newer !== 'none') {
        await field.fill('NEWER OWNER TEXT'); await field.evaluate(node => (node as HTMLInputElement).select());
        await page.keyboard.press(newer === 'copy' ? 'ControlOrMeta+C' : 'ControlOrMeta+X');
        expect(await page.evaluate(() => window.__round8Clipboard.intents)).toEqual([newer]);
      }
      await page.evaluate(() => window.__quoteSignoff.release());
      if (newer === 'none') {
        await expect(share.getByRole('status')).toHaveText('Link copied.');
        expect(await page.evaluate(() => window.__round8Clipboard.writes)).toEqual([url]);
      } else {
        await expect(share.getByRole('status')).toContainText('You copied something else.');
        expect(await page.evaluate(() => window.__round8Clipboard)).toEqual({ value: 'NEWER OWNER TEXT', writes: [], intents: [newer] });
        await expect(field).toBeFocused(); await expect(share.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled();
      }
    });
  }
  test('an untrusted copy event does not cancel the owner copy', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }));
    const { share } = await publish(page);
    await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.link.check'));
    await share.getByRole('button', { name: 'Copy link', exact: true }).click();
    await page.evaluate(() => { document.dispatchEvent(new Event('copy', { bubbles: true })); window.__quoteSignoff.release(); });
    await expect(share.getByRole('status')).toHaveText('Link copied.');
  });
});

test.describe('2. Print completion focus', () => {
  for (const newer of [false, true]) test('returns print focus while preserving newer focus=' + newer, async ({ page }) => {
    await installPrintCompletion(page); await prepare(page); const view = await openReceipt(page); await startPrint(page, view);
    const field = page.getByLabel('Complete scope shown to the customer', { exact: true });
    if (newer) await field.fill('Newer owner editing while printing.');
    await page.evaluate(() => window.__round8PrintCallbacks[0]!());
    await expect(page.locator('[data-signoff-receipt-print]')).toHaveCount(0);
    await expect(view.getByRole('button', { name: 'Print / save PDF', exact: true })).toBeEnabled();
    if (newer) await expect(field).toBeFocused(); else await expect(view.getByRole('button', { name: 'Print / save PDF', exact: true })).toBeFocused();
  });
  test('a completion callback after Close cannot focus the hidden receipt', async ({ page }) => {
    await installPrintCompletion(page); await prepare(page); const view = await openReceipt(page); await startPrint(page, view);
    await view.getByRole('button', { name: 'Close receipt', exact: true }).click();
    await expect(page.getByRole('button', { name: 'View sign-off receipt', exact: true })).toBeFocused();
    await page.evaluate(() => window.__round8PrintCallbacks[0]!()); await expect(view).toBeHidden();
    await expect(page.getByRole('button', { name: 'View sign-off receipt', exact: true })).toBeFocused();
  });
  test('a disposed receipt cannot take focus from a newer view', async ({ page }) => {
    await installPrintCompletion(page); await prepare(page); const view = await openReceipt(page); await startPrint(page, view);
    await page.evaluate(() => {
      window.__quoteSignoff.dispose(); const input = document.createElement('input'); input.id = 'new-view'; document.body.appendChild(input); input.focus();
      window.__round8PrintCallbacks[0]!();
    });
    await expect(page.locator('#new-view')).toBeFocused(); await expect(page.locator('[data-signoff-receipt]')).toHaveCount(0);
  });
  test('an older print completion cannot clear the replacement print frame', async ({ page }) => {
    await installPrintCompletion(page); await prepare(page); const view = await openReceipt(page); await startPrint(page, view);
    await view.getByRole('button', { name: 'Refresh receipt', exact: true }).click();
    await expect(view.getByRole('button', { name: 'Print / save PDF', exact: true })).toBeEnabled(); await startPrint(page, view, 2);
    await page.evaluate(() => window.__round8PrintCallbacks[0]!());
    await expect(page.locator('[data-signoff-receipt-print]')).toHaveCount(1);
    await page.evaluate(() => window.__round8PrintCallbacks[1]!());
    await expect(view.getByRole('button', { name: 'Print / save PDF', exact: true })).toBeFocused();
  });
});

test.describe('3. Recovery outside filtered history', () => {
  for (const mode of ['offline', 'expired'] as const) test('recovers the same completion after ' + mode + ' while Review remains selected', async ({ page }, info) => {
    const controls = await failPublication(page, mode);
    await expect(page.getByRole('button', { name: 'Resume completion preview', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Delivered work shown to the customer', { exact: true })).toHaveValue('Delivered all three drawings and final PDF.');
    const before = await page.evaluate(() => (window.__quoteSignoff.calls.find(call => call.method === 'reception.signoff.completion.publish')!.payload as { completion_id: string }).completion_id);
    await recovery(page).focus(); await expect(recovery(page)).toBeFocused();
    await page.screenshot({ path: info.outputPath('visible-saved-recovery.png') });
    await page.evaluate(() => window.__quoteSignoff.failPublish(null)); await page.keyboard.press('Enter');
    await expect(controls.publish).toBeEnabled(); await expect(recovery(page)).toBeHidden();
    await expect(page.getByLabel('Completion requests', { exact: true })).toHaveValue('review');
    await expect(controls.preview.locator('[data-customer-request-expiry] time')).toHaveAttribute('datetime', controls.deadline!);
    expect(await callCount(page, 'reception.signoff.completion.prepare')).toBe(1);
    expect(await page.evaluate(() => window.__quoteSignoff.calls.find(call => call.method === 'reception.signoff.completion.resume')!.payload)).toMatchObject({ completion_id: before });
  });
  test('a failed recovery keeps its same-request retry', async ({ page }) => {
    const controls = await failPublication(page); await page.evaluate(() => window.__quoteSignoff.failResume(true));
    await recovery(page).click(); await expect(page.getByRole('status').filter({ hasText: 'Fixture resume unavailable.' })).toBeVisible();
    await expect(recovery(page)).toBeEnabled(); await page.evaluate(() => window.__quoteSignoff.failResume(false)); await recovery(page).click();
    await expect(controls.publish).toBeEnabled(); await expect(controls.preview.locator('[data-customer-request-expiry] time')).toHaveAttribute('datetime', controls.deadline!);
    expect(await callCount(page, 'reception.signoff.completion.prepare')).toBe(1); expect(await callCount(page, 'reception.signoff.completion.resume')).toBe(2);
  });
  test('edited or discarded delivery cannot resume the old saved terms', async ({ page }) => {
    await failPublication(page); const field = page.getByLabel('Delivered work shown to the customer', { exact: true });
    await field.fill('Changed delivered work.'); await expect(recovery(page)).toBeHidden(); await recovery(page).dispatchEvent('click');
    expect(await callCount(page, 'reception.signoff.completion.resume')).toBe(0);
    await field.fill('Delivered all three drawings and final PDF.'); await expect(recovery(page)).toBeVisible();
    await page.getByRole('button', { name: 'Discard completion draft', exact: true }).click();
    await expect(recovery(page)).toBeHidden(); await recovery(page).dispatchEvent('click'); expect(await callCount(page, 'reception.signoff.completion.resume')).toBe(0);
  });
  test('starting another preparation clears the previous recovery', async ({ page }) => {
    await failPublication(page); await page.evaluate(() => window.__quoteSignoff.prepareFailure('after'));
    await page.getByRole('button', { name: 'Prepare completion preview', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Fixture preview unavailable.' })).toBeVisible(); await expect(recovery(page)).toBeHidden();
  });
  test('the customer deadline also ends saved recovery', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-24T12:00:00Z') }); await failPublication(page, 'offline', 1);
    await page.clock.fastForward(DAY + 1); await expect(recovery(page)).toBeHidden();
    await recovery(page).dispatchEvent('click'); expect(await callCount(page, 'reception.signoff.completion.resume')).toBe(0);
  });
});

test.describe('4. Owner-actionable completion reviews', () => {
  for (const state of ['waiting', 'not_queued', 'running', 'closed'] as const) test('filters derived review state ' + state + ' and keeps All requests intact', async ({ page }) => {
    await publish(page, 'completion'); await page.evaluate(state => {
      window.__quoteSignoff.completionResponse('accepted'); window.__quoteSignoff.setCompletionReview(state);
    }, state);
    const history = page.locator('[data-completion-history]'); await expect(history.locator('article')).toHaveCount(1);
    const filter = page.getByLabel('Completion requests', { exact: true }); await filter.selectOption('review');
    await expect(history.locator('article')).toHaveCount(state === 'waiting' ? 1 : 0);
    await filter.selectOption('all'); await expect(history.locator('article')).toHaveCount(1);
    await expect(history).toContainText(state === 'running' ? 'The approved completion review is running.'
      : state === 'closed' ? 'Owner review ended without applying this completion.'
        : state === 'not_queued' ? 'The response is waiting to be queued for owner review.' : 'Customer accepted completion.');
  });
  test('polling moves a response into review only while approval is waiting', async ({ page }) => {
    await publish(page, 'completion'); await page.evaluate(() => { window.__quoteSignoff.completionResponse('accepted'); window.__quoteSignoff.setCompletionReview('not_queued'); });
    const history = page.locator('[data-completion-history]'); await page.getByLabel('Completion requests', { exact: true }).selectOption('review');
    await expect(history.locator('article')).toHaveCount(0); await page.evaluate(() => window.__quoteSignoff.setCompletionReview('waiting'));
    await expect(history.getByRole('link', { name: 'Review completion in Reception Inbox', exact: true })).toBeVisible();
    await page.evaluate(() => window.__quoteSignoff.setCompletionReview('running')); await expect(history.locator('article')).toHaveCount(0);
  });
});

test.describe('5. Server time on history reads', () => {
  for (const kind of ['quote', 'completion'] as const) {
    for (const offset of [-8 * DAY, 0, 8 * DAY]) test(kind + ' history keeps the saved deadline after remount and clock edit at offset ' + offset, async ({ page }) => {
      await page.clock.install({ time: new Date('2026-10-24T12:00:00Z') }); await publish(page, kind, 'server_clock_offset=' + offset);
      const history = page.locator(kind === 'quote' ? '[data-signoff-history]' : '[data-completion-history]');
      const time = history.locator('[data-customer-request-expiry] time').first(); const deadline = await time.getAttribute('datetime');
      const prepared = await callCount(page, kind === 'quote' ? 'reception.signoff.prepare' : 'reception.signoff.completion.prepare');
      await page.evaluate(() => window.__quoteSignoff.remount()); await expect(history.locator('[data-customer-request-remaining]').first()).toContainText('About 7 days left');
      await page.clock.setSystemTime(new Date('2026-12-24T12:00:00Z')); await page.evaluate(() => window.__quoteSignoff.update());
      await expect(history.locator('[data-customer-request-remaining]').first()).toContainText('About 7 days left');
      await expect(time).toHaveAttribute('datetime', deadline!);
      expect(await callCount(page, kind === 'quote' ? 'reception.signoff.prepare' : 'reception.signoff.completion.prepare')).toBe(prepared);
      await page.clock.fastForward(7 * DAY + 1); await expect(history.locator('[data-customer-request-remaining]').first()).toContainText('Expired');
    });
    test(kind + ' older list responses remain usable at the normal owner clock', async ({ page }) => {
      await page.clock.install(); await publish(page, kind, 'legacy_list_clock&legacy_preview');
      await page.evaluate(() => window.__quoteSignoff.remount());
      await expect(page.locator(kind === 'quote' ? '[data-signoff-history]' : '[data-completion-history]').locator('[data-customer-request-remaining]').first()).toContainText('About 7 days left');
    });
    test(kind + ' history paint does not restart its clock after a held native gesture', async ({ page }) => {
      await page.clock.install({ time: new Date('2026-10-24T12:00:00Z') }); await publish(page, kind, '', 1);
      const method = kind === 'quote' ? 'reception.signoff.list' : 'reception.signoff.completion.list';
      const count = await callCount(page, method);
      await page.evaluate(method => { window.__quoteSignoff.deferNext(method); window.__quoteSignoff.update(); }, method);
      await expect.poll(() => callCount(page, method)).toBeGreaterThan(count);
      const history = page.locator(kind === 'quote' ? '[data-signoff-history]' : '[data-completion-history]');
      const summary = history.locator('summary').first(); await summary.scrollIntoViewIfNeeded();
      const original = (await summary.elementHandle())!; const box = (await summary.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.evaluate(() => window.__quoteSignoff.release()); await page.clock.fastForward(3_600_000);
      expect(await original.evaluate(node => node.isConnected)).toBe(true); await page.mouse.up();
      await expect.poll(() => original.evaluate(node => node.isConnected)).toBe(false);
      await expect(history.locator('[data-customer-request-remaining]').first()).toContainText('About 23 hours left');
    });
  }
  test('an initial history read needs no prepared preview to align its clock', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-24T12:00:00Z') }); await page.goto(BASE + '?waiting&server_clock_offset=' + (-8 * DAY));
    await expect(page.locator('[data-signoff-history] [data-customer-request-remaining]')).toContainText('About 7 days left');
    expect(await callCount(page, 'reception.signoff.prepare')).toBe(0);
  });
  test('waiting for the quote roster cannot extend a history deadline', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-24T12:00:00Z') }); await publish(page, 'quote', '', 1);
    const old = (await page.locator('[data-signoff-history] article').elementHandle())!;
    const count = await callCount(page, 'reception.signoff.quotes');
    await page.evaluate(() => { window.__quoteSignoff.deferNext('reception.signoff.quotes'); window.__quoteSignoff.update(); });
    await expect.poll(() => callCount(page, 'reception.signoff.quotes')).toBeGreaterThan(count);
    await page.clock.fastForward(3_600_000); await page.evaluate(() => window.__quoteSignoff.release());
    await expect.poll(() => old.evaluate(node => node.isConnected)).toBe(false);
    await expect(page.locator('[data-signoff-history] [data-customer-request-remaining]')).toContainText('About 23 hours left');
  });
});

test.describe('6. Pending completion reads', () => {
  for (const failure of [false, true]) test('starting a read during a held click preserves its position and activation (failure=' + failure + ')', async ({ page }) => {
    await publish(page, 'completion'); await expect(page.locator('[data-completion-load-status]')).toBeEmpty();
    const summary = page.locator('[data-completion-history] summary').first(); await summary.scrollIntoViewIfNeeded();
    const before = (await summary.boundingBox())!; const original = (await summary.elementHandle())!;
    const count = await callCount(page,'reception.signoff.completion.list');
    await page.mouse.move(before.x + before.width / 2,before.y + before.height / 2); await page.mouse.down();
    await page.evaluate(() => { window.__quoteSignoff.deferNext('reception.signoff.completion.list'); window.__quoteSignoff.update(); });
    await expect.poll(() => callCount(page,'reception.signoff.completion.list')).toBeGreaterThan(count);
    await expect(page.locator('[data-completion-history]')).toHaveAttribute('aria-busy','true'); await settle(page);
    await expect(page.locator('[data-completion-load-status]')).toBeEmpty();
    expect((await summary.boundingBox())!.y).toBe(before.y);
    await page.evaluate(value => { window.__quoteSignoff.failCompletion(value); window.__quoteSignoff.release(); },failure); await settle(page);
    expect((await summary.boundingBox())!.y).toBe(before.y); expect(await original.evaluate(node => node.isConnected)).toBe(true);
    await page.mouse.up(); await expect(summary.locator('..')).toHaveAttribute('open','');
    await expect(page.locator('[data-completion-history]')).toHaveAttribute('aria-busy','false');
    if (failure) await expect(page.locator('[data-completion-load-status]')).toHaveText('Completion unavailable. Try again.');
    else { await expect.poll(() => original.evaluate(node => node.isConnected)).toBe(false); await expect(page.locator('[data-completion-load-status]')).toBeEmpty(); }
  });
  test('marks the first list read busy and announces loading', async ({ page }) => {
    await page.goto(BASE + '?completion&defer=reception.signoff.completion.list');
    const history = page.getByRole('region', { name: 'Completion request results', exact: true });
    await expect(history).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-completion-load-status]')).toHaveText('Loading completion requests…');
    await page.evaluate(() => window.__quoteSignoff.release()); await expect(history).toHaveAttribute('aria-busy', 'false');
    await expect(history).toContainText('No completion requests yet.');
  });
  test('labels retained rows while the newly selected filter is loading', async ({ page }, info) => {
    await publish(page, 'completion'); await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.completion.list'));
    const filter = page.getByLabel('Completion requests', { exact: true }); await filter.focus(); await filter.selectOption('review');
    const history = page.getByRole('region', { name: 'Completion request results', exact: true });
    await expect(history).toHaveAttribute('aria-busy', 'true'); await expect(history).toContainText('Waiting for customer');
    await expect(page.locator('[data-completion-load-status]')).toContainText('Previous results are shown below.');
    await page.locator('[data-signoff-completions]').screenshot({ path: info.outputPath('pending-filter-feedback.png') });
    await page.evaluate(() => window.__quoteSignoff.release()); await expect(history).toHaveAttribute('aria-busy', 'false');
    await expect(history.locator('article')).toHaveCount(0); await expect(page.locator('[data-completion-load-status]')).toBeEmpty();
    await expect(filter).toBeFocused();
  });
  for (const olderFails of [false, true]) test('an older read cannot clear the newer loading state (failure=' + olderFails + ')', async ({ page }) => {
    await publish(page, 'completion'); const refresh = page.getByRole('button', { name: 'Refresh completions', exact: true });
    const oldRow = (await page.locator('[data-completion-history] article').elementHandle())!;
    await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.completion.list', 'old')); await refresh.click();
    await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.completion.list', 'new')); await refresh.click();
    await page.evaluate(value => { window.__quoteSignoff.failCompletion(value); window.__quoteSignoff.release('old'); }, olderFails); await settle(page);
    await expect(page.locator('[data-completion-history]')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-completion-load-status]')).toContainText('Loading completion requests…');
    expect(await oldRow.evaluate(node => node.isConnected)).toBe(true);
    await page.evaluate(() => { window.__quoteSignoff.failCompletion(false); window.__quoteSignoff.release('new'); });
    await expect(page.locator('[data-completion-history]')).toHaveAttribute('aria-busy', 'false');
    await expect.poll(() => oldRow.evaluate(node => node.isConnected)).toBe(false); await expect(page.locator('[data-completion-load-status]')).toBeEmpty();
  });
  test('failed and retried reads retain action feedback while showing the current read state', async ({ page }) => {
    await publish(page, 'completion'); const action = page.locator('[data-signoff-completions] > p[role=status]').first(); const message = await action.innerText();
    const refresh = page.getByRole('button', { name: 'Refresh completions', exact: true });
    await page.evaluate(() => window.__quoteSignoff.failCompletion(true)); await refresh.click();
    await expect(page.locator('[data-completion-load-status]')).toHaveText('Completion unavailable. Try again.');
    await expect(page.locator('[data-completion-history]')).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() => { window.__quoteSignoff.failCompletion(false); window.__quoteSignoff.deferNext('reception.signoff.completion.list'); }); await refresh.click();
    await expect(page.locator('[data-completion-load-status]')).toContainText('Loading completion requests…'); await expect(action).toHaveText(message);
    await page.evaluate(() => window.__quoteSignoff.release()); await expect(page.locator('[data-completion-load-status]')).toBeEmpty(); await expect(action).toHaveText(message);
  });
  test('disposed pending reads cannot recreate controls or take newer focus', async ({ page }) => {
    await publish(page, 'completion'); await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.completion.list'));
    await page.getByRole('button', { name: 'Refresh completions', exact: true }).click();
    await page.evaluate(() => {
      window.__quoteSignoff.dispose(); const input = document.createElement('input'); input.id = 'new-view'; document.body.appendChild(input); input.focus(); window.__quoteSignoff.release();
    }); await settle(page);
    await expect(page.locator('[data-signoff-completions]')).toHaveCount(0); await expect(page.locator('#new-view')).toBeFocused();
  });
});
