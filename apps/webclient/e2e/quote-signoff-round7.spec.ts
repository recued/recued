import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { openSignoffRequestDetails } from './helpers/signoff-request.js';
import type {} from './harness/quote-signoff-harness.js';

declare global {
  interface Window { __round7Clipboard?: { reject(): void; resolve(): void } }
}
type Kind = 'quote' | 'completion';
const BASE = HARNESS_ORIGIN + '/quote-signoff-harness.html';
const DAY = 86_400_000;
const failures = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = []; failures.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  const headers = await readFile(resolve(import.meta.dirname, '../public/_headers'), 'utf8');
  const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route('**/quote-signoff-harness.html*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
  });
});
test.afterEach(async ({ page }) => expect(failures.get(page)).toEqual([]));

async function draft(page: Page, kind: Kind = 'quote', query = '', days = 7) {
  await page.goto(BASE + '?' + (kind === 'completion' ? 'completion&' : '') + query);
  if (kind === 'quote') {
    const creation = page.locator('[data-signoff-create]');
    if (!await creation.evaluate(node => (node as HTMLDetailsElement).open)) await creation.locator('summary').first().click();
    await page.getByRole('combobox', { name: 'Open quote', exact: true }).selectOption('Q1');
    for (const [label, value] of [
      ['Business name shown to the customer', 'Studio'],
      ['Complete scope shown to the customer', 'Three drawings and final PDF delivery.'],
      ['Task to create after your approval', 'Deliver drawings'], ['Invoice reference', 'INV-NEW'],
    ]) await page.getByLabel(label!, { exact: true }).fill(value!);
    await page.getByLabel('Link lifetime in days', { exact: true }).fill(String(days));
  } else {
    await openSignoffRequestDetails(page.locator('[data-signoff-history] article').first());
    await page.getByRole('button', { name: 'Request completion', exact: true }).click();
    await page.getByLabel('Delivered work shown to the customer', { exact: true }).fill('Delivered all three drawings and the final PDF.');
    await page.getByLabel('Completion link life (days)', { exact: true }).fill(String(days));
  }
  return {
    prepare: page.getByRole('button', { name: kind === 'quote' ? 'Prepare sign-off preview' : 'Prepare completion preview', exact: true }),
    publish: page.getByRole('button', { name: kind === 'quote' ? 'Publish sign-off link' : 'Publish completion link', exact: true }),
    preview: kind === 'quote' ? page.locator('[data-signoff-preview]') : page.getByRole('form', { name: 'Request customer completion', exact: true }),
  };
}
async function prepare(page: Page, kind: Kind = 'quote', query = '', days = 7) {
  const controls = await draft(page, kind, query, days);
  await controls.prepare.click(); await expect(controls.publish).toBeEnabled(); return controls;
}
async function publish(page: Page, kind: Kind = 'quote', query = '', days = 7) {
  const controls = await prepare(page, kind, query, days); await controls.publish.click();
  const share = page.locator('[data-customer-link-share]');
  await expect(share.locator('input')).not.toHaveValue('');
  return { ...controls, share };
}
async function installClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: () => new Promise<void>((resolve, reject) => {
        window.__round7Clipboard = { resolve, reject: () => reject(new Error('Fixture clipboard denied')) };
      }),
    } });
  });
}
async function readReceiptDownload(page: Page, view: Locator) {
  const pending = page.waitForEvent('download');
  await view.getByRole('button', { name: 'Download receipt', exact: true }).click();
  const path = await (await pending).path(); expect(path).not.toBeNull();
  return readFile(path!, 'utf8');
}
async function openReceipt(page: Page, index = 0) {
  const card = page.locator('[data-signoff-history] article').nth(index);
  await openSignoffRequestDetails(card);
  await card.getByRole('button', { name: 'View sign-off receipt', exact: true }).click();
  return page.getByRole('region', { name: 'Sign-off receipt', exact: true });
}

test.describe('1. Server clock through publication', () => {
  for (const kind of ['quote', 'completion'] as const) {
    for (const offset of [-8 * DAY, 0, 8 * DAY]) test(kind + ' share and history retain the server deadline at offset ' + offset, async ({ page }) => {
      await page.clock.install({ time: new Date('2026-10-24T12:00:00Z') });
      const { share } = await publish(page, kind, 'server_clock_offset=' + offset);
      await expect(share.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled();
      await page.clock.setSystemTime(new Date('2026-12-24T12:00:00Z'));
      await page.evaluate(() => window.__quoteSignoff.update());
      const history = page.locator(kind === 'quote' ? '[data-signoff-history]' : '[data-completion-history]');
      await expect(history.locator('[data-customer-request-remaining]').first()).toContainText('About 7 days left');
      await expect(share.locator('input')).not.toHaveValue('');
      await page.clock.fastForward(7 * DAY + 1);
      await expect(share.locator('input')).toHaveValue('');
      await expect(share.getByRole('button', { name: 'Copy link', exact: true })).toBeDisabled();
      await expect(share.getByRole('status')).toHaveText('Link expired. Do not share it.');
    });
    test(kind + ' delayed publication does not restart the saved lifetime', async ({ page }) => {
      await page.clock.install({ time: new Date('2026-10-24T12:00:00Z') });
      const controls = await prepare(page, kind, '', 1);
      await page.evaluate(kind => window.__quoteSignoff.deferNext(kind === 'quote' ? 'reception.signoff.publish' : 'reception.signoff.completion.publish'), kind);
      await controls.publish.click(); await page.clock.fastForward(60_000);
      await page.evaluate(() => window.__quoteSignoff.release());
      const share = page.locator('[data-customer-link-share]'); await expect(share.locator('input')).not.toHaveValue('');
      await page.clock.fastForward(DAY - 60_000 + 1);
      await expect(share.locator('input')).toHaveValue('');
    });
    test(kind + ' legacy preview keeps guarded local lifetime and server availability checks', async ({ page }) => {
      await page.clock.install(); const { share } = await publish(page, kind, 'legacy_preview', 1);
      await page.evaluate(() => window.__quoteSignoff.linkStatus('inactive'));
      await share.getByRole('button', { name: 'Copy link', exact: true }).click();
      await expect(share.locator('input')).toHaveValue('');
      await expect(share.getByRole('button', { name: 'Copy link', exact: true })).toBeDisabled();
    });
  }
});

test.describe('2. Clipboard focus', () => {
  for (const mode of ['reject', 'timeout'] as const) for (const moved of [false, true]) {
    test(mode + ' keeps newer editing=' + moved + ' and still offers manual copying', async ({ page }) => {
      await page.clock.install(); await installClipboard(page);
      const { share } = await publish(page); const input = share.locator('input');
      await share.getByRole('button', { name: 'Copy link', exact: true }).click();
      await expect.poll(() => page.evaluate(() => !!window.__round7Clipboard)).toBe(true);
      const scope = page.getByLabel('Complete scope shown to the customer', { exact: true });
      if (moved) {
        await scope.fill('New editing while clipboard is pending.');
        await scope.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(4, 11));
      }
      if (mode === 'reject') await page.evaluate(() => window.__round7Clipboard!.reject());
      else await page.clock.fastForward(2_001);
      await expect(share.getByRole('status')).toContainText('Copy is unavailable.');
      if (moved) {
        await expect(scope).toBeFocused(); await expect(scope).toHaveValue('New editing while clipboard is pending.');
        expect(await scope.evaluate(node => [(node as HTMLTextAreaElement).selectionStart, (node as HTMLTextAreaElement).selectionEnd])).toEqual([4, 11]);
        await expect(share.getByRole('status')).toContainText('Select and copy');
      } else {
        await expect(input).toBeFocused();
        expect(await input.evaluate(node => [(node as HTMLInputElement).selectionStart, (node as HTMLInputElement).selectionEnd])).toEqual([0, (await input.inputValue()).length]);
      }
    });
  }
  test('moving during the availability read also prevents a late clipboard focus takeover', async ({ page }) => {
    await installClipboard(page); const { share } = await publish(page);
    await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.link.check'));
    await share.getByRole('button', { name: 'Copy link', exact: true }).click();
    const scope = page.getByLabel('Complete scope shown to the customer', { exact: true });
    await scope.fill('New work during the availability check.');
    await page.evaluate(() => window.__quoteSignoff.release());
    await expect.poll(() => page.evaluate(() => !!window.__round7Clipboard)).toBe(true);
    await page.evaluate(() => window.__round7Clipboard!.reject());
    await expect(share.getByRole('status')).toContainText('Select and copy'); await expect(scope).toBeFocused();
  });
  test('a removed sharing view cannot select its old link on clipboard failure', async ({ page }) => {
    await installClipboard(page); const { share } = await publish(page);
    await share.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!window.__round7Clipboard)).toBe(true);
    await page.evaluate(() => window.__quoteSignoff.remount());
    const search = page.getByLabel('Find customer, quote or invoice', { exact: true }); await search.fill('New search');
    await page.evaluate(() => window.__round7Clipboard!.reject());
    await expect(search).toBeFocused(); await expect(search).toHaveValue('New search');
    await expect(page.locator('[data-customer-link-share]')).toHaveCount(0);
  });
});

test.describe('3. Phone preparation errors', () => {
  for (const mode of ['before', 'after'] as const) for (const retainedLink of [false, true]) {
    test('reveals quote failure ' + mode + ' with retained link=' + retainedLink, async ({ page }, info) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const controls = retainedLink ? await publish(page) : await draft(page);
      await page.evaluate(mode => window.__quoteSignoff.prepareFailure(mode), mode);
      await controls.prepare.click();
      const error = page.getByRole('status').filter({ hasText: 'Fixture preview unavailable. Try again.' });
      await expect(error).toBeFocused(); await expect(controls.prepare).toBeEnabled();
      const box = (await error.boundingBox())!; expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(844);
      await expect(page.getByLabel('Complete scope shown to the customer', { exact: true })).toHaveValue('Three drawings and final PDF delivery.');
      await expect(page.getByLabel('Invoice reference', { exact: true })).toHaveValue('INV-NEW');
      if (retainedLink) {
        const share = page.locator('[data-customer-link-share]');
        if (mode === 'before') await expect(share.locator('input')).not.toHaveValue('');
        else await expect(share.locator('input')).toHaveValue('');
      }
      await page.screenshot({ path: info.outputPath('phone-prepare-error.png') });
    });
  }
});

test.describe('4. Completion read feedback', () => {
  test('clears a recovered read error while retaining publish feedback', async ({ page }) => {
    await publish(page, 'completion');
    const action = page.locator('[data-signoff-completions] > p[role=status]').first();
    const feedback = await action.innerText(); const status = page.locator('[data-completion-load-status]');
    const refresh = page.getByRole('button', { name: 'Refresh completions', exact: true });
    await page.evaluate(() => window.__quoteSignoff.failCompletion(true)); await refresh.click();
    await expect(status).toHaveText('Completion unavailable. Try again.');
    await page.evaluate(() => window.__quoteSignoff.failCompletion(false)); await refresh.click();
    await expect(status).toBeEmpty(); await expect(action).toHaveText(feedback);
    await expect(page.locator('[data-completion-history] article')).toHaveCount(1);
  });
  test('a successful read cannot erase an action failure', async ({ page }) => {
    await publish(page, 'completion');
    await page.evaluate(() => window.__quoteSignoff.failCompletion(true));
    await page.getByRole('button', { name: 'Cancel completion request', exact: true }).click();
    const action = page.locator('[data-signoff-completions] > p[role=status]').first();
    await expect(action).toHaveText('Completion unavailable. Try again.');
    await expect(page.getByRole('button', { name: 'Refresh completions', exact: true })).toBeEnabled();
    await page.evaluate(() => window.__quoteSignoff.failCompletion(false));
    await page.getByRole('button', { name: 'Refresh completions', exact: true }).click();
    await expect(page.locator('[data-completion-load-status]')).toBeEmpty(); await expect(action).toHaveText('Completion unavailable. Try again.');
  });
  for (const olderFails of [false, true]) test('ignores an older list outcome (failure=' + olderFails + ')', async ({ page }) => {
    await publish(page, 'completion'); const refresh = page.getByRole('button', { name: 'Refresh completions', exact: true });
    await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.completion.list')); await refresh.click();
    const oldRow = (await page.locator('[data-completion-history] article').elementHandle())!;
    await page.evaluate(value => window.__quoteSignoff.failCompletion(value), !olderFails); await refresh.click();
    const status = page.locator('[data-completion-load-status]');
    if (olderFails) await expect.poll(() => oldRow.evaluate(node => node.isConnected)).toBe(false);
    else await expect(status).toHaveText('Completion unavailable. Try again.');
    await page.evaluate(value => { window.__quoteSignoff.failCompletion(value); window.__quoteSignoff.release(); }, olderFails);
    await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    await expect.poll(() => page.evaluate(() => window.__quoteSignoff.calls.filter(call => call.method === 'reception.signoff.completion.list').length)).toBeGreaterThan(2);
    if (olderFails) await expect(status).toBeEmpty(); else await expect(status).toHaveText('Completion unavailable. Try again.');
  });
});

test.describe('5. Receipt snapshots', () => {
  test('retains the validated snapshot and its exports through a failed refresh, then replaces it on success', async ({ page }, info) => {
    await page.addInitScript(() => { window.print = () => document.documentElement.setAttribute('data-print-called', 'true'); });
    await prepare(page); const view = await openReceipt(page);
    const content = view.locator('[data-signoff-receipt-requests]');
    await expect(view.getByRole('button', { name: 'Download receipt', exact: true })).toBeEnabled();
    const before = await content.innerText(); const html = await readReceiptDownload(page, view); expect(html).not.toContain('PRIVATE');
    await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.receipt'));
    await view.getByRole('button', { name: 'Refresh receipt', exact: true }).click();
    await expect(view.getByRole('status')).toContainText('Refreshing receipt.');
    await expect.poll(() => content.innerText()).toBe(before);
    await expect(view.getByRole('button', { name: 'Download receipt', exact: true })).toBeEnabled();
    await page.evaluate(() => { window.__quoteSignoff.failReceipt(true); window.__quoteSignoff.release(); });
    await expect(view.getByRole('status')).toContainText('Receipt unavailable. Try again. Showing snapshot captured');
    await expect.poll(() => content.innerText()).toBe(before);
    expect(await readReceiptDownload(page, view)).toBe(html);
    await view.getByRole('button', { name: 'Print / save PDF', exact: true }).click();
    await expect(page.frameLocator('[data-signoff-receipt-print]').locator('html')).toHaveAttribute('data-print-called', 'true');
    await expect(page.frameLocator('[data-signoff-receipt-print]').locator('body')).toContainText('Three drawings');
    await view.screenshot({ path: info.outputPath('retained-receipt.png') });
    await page.evaluate(() => { window.__quoteSignoff.failReceipt(false); window.__quoteSignoff.setReview('waiting'); });
    await view.getByRole('button', { name: 'Refresh receipt', exact: true }).click();
    await expect(content).toContainText('Customer accepted');
    await expect(content.locator('article')).toHaveCount(1); await expect(view.getByRole('status')).not.toContainText('unavailable');
  });
  for (const mode of ['unsupported', 'mismatched', 'invalid_time'] as const) test('a rejected ' + mode + ' refresh cannot replace the validated receipt', async ({ page }) => {
    await prepare(page); const view = await openReceipt(page); const content = view.locator('[data-signoff-receipt-requests]');
    await expect(view.getByRole('button', { name: 'Download receipt', exact: true })).toBeEnabled(); const before = await content.innerText();
    await page.evaluate(mode => window.__quoteSignoff.receiptMode(mode), mode);
    await view.getByRole('button', { name: 'Refresh receipt', exact: true }).click();
    await expect(view.getByRole('button', { name: 'Refresh receipt', exact: true })).toBeEnabled();
    await expect(view.getByRole('status')).toContainText('Showing snapshot captured');
    await expect.poll(() => content.innerText()).toBe(before);
    await expect(view.getByRole('button', { name: 'Download receipt', exact: true })).toBeEnabled();
    await view.getByRole('button', { name: 'Close receipt', exact: true }).click(); await expect(view).toBeHidden();
    const reopened = await openReceipt(page);
    await expect(reopened.locator('[data-signoff-receipt-requests]')).toBeEmpty();
    await expect(reopened.getByRole('button', { name: 'Download receipt', exact: true })).toBeDisabled();
  });
  test('switching requests clears the previous customer snapshot before a failed read', async ({ page }) => {
    await page.goto(BASE + '?two_receipts'); const view = await openReceipt(page);
    await expect(view.locator('[data-signoff-receipt-requests]')).toContainText('Morgan');
    await page.evaluate(() => window.__quoteSignoff.failReceipt(true)); await openReceipt(page, 1);
    await expect(view.getByRole('status')).toHaveText('Receipt unavailable. Try again.');
    await expect(view.locator('[data-signoff-receipt-requests]')).toBeEmpty();
    await expect(view.getByRole('button', { name: 'Download receipt', exact: true })).toBeDisabled();
    await page.evaluate(() => window.__quoteSignoff.failReceipt(false)); await view.getByRole('button', { name: 'Refresh receipt', exact: true }).click();
    await expect(view.locator('[data-signoff-receipt-requests]')).toContainText('Taylor');
    await expect(view.locator('[data-signoff-receipt-requests]')).not.toContainText('Morgan');
  });
  test('a late read for the earlier request cannot replace the newer customer receipt', async ({ page }) => {
    await page.goto(BASE + '?two_receipts');
    await page.evaluate(() => window.__quoteSignoff.deferNext('reception.signoff.receipt')); const view = await openReceipt(page);
    await expect(view.getByRole('status')).toHaveText('Loading receipt…'); await openReceipt(page, 1);
    await expect(view.locator('[data-signoff-receipt-requests]')).toContainText('Taylor');
    await page.evaluate(() => window.__quoteSignoff.release());
    await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    await expect(view.locator('[data-signoff-receipt-requests]')).not.toContainText('Morgan');
    await expect(view.getByRole('button', { name: 'Download receipt', exact: true })).toBeEnabled();
  });
});

const REPLY = 'Please correct the drawing scale and retain these exact instructions.\n' + 'Customer instruction for detailed review. '.repeat(18);
async function reply(page: Page, kind: Kind) {
  if (kind === 'quote') {
    await page.goto(BASE + '?waiting'); await page.evaluate(text => window.__quoteSignoff.quoteResponse('declined', text), REPLY);
  } else {
    await publish(page, 'completion'); await page.evaluate(text => window.__quoteSignoff.completionResponse('corrections_requested', text), REPLY);
  }
  const summary = page.getByText(kind === 'quote' ? 'Read full reason' : 'Read full corrections', { exact: true });
  await summary.click(); return summary.locator('..').locator('pre');
}
async function dragStart(page: Page, node: Locator, backwards = false) {
  await node.scrollIntoViewIfNeeded();
  const rect = await node.evaluate(node => {
    const range = document.createRange(); range.setStart(node.firstChild!, 0); range.setEnd(node.firstChild!, 24);
    const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const left = rect.x + 1; const right = rect.x + rect.w - 1; const y = rect.y + rect.h / 2;
  await page.mouse.move(backwards ? right : left, y); await page.mouse.down();
  await page.mouse.move(backwards ? left : right, y, { steps: 12 });
}
async function deferHistory(page: Page, kind: Kind) {
  const method = kind === 'quote' ? 'reception.signoff.list' : 'reception.signoff.completion.list';
  const count = await page.evaluate(method => window.__quoteSignoff.calls.filter(call => call.method === method).length, method);
  await page.evaluate(method => { window.__quoteSignoff.deferNext(method); window.__quoteSignoff.update(); }, method);
  await expect.poll(() => page.evaluate(method => window.__quoteSignoff.calls.filter(call => call.method === method).length, method)).toBeGreaterThan(count);
}
test.describe('6. Native customer reply selection', () => {
  for (const kind of ['quote', 'completion'] as const) {
    test(kind + ' preserves selection in the compact reply excerpt too', async ({ page }) => {
      await reply(page, kind);
      const history = page.locator(kind === 'quote' ? '[data-signoff-history]' : '[data-completion-history]');
      const excerpt = history.locator('[data-customer-response-text=excerpt]');
      await dragStart(page, excerpt); await page.mouse.up();
      const before = await page.evaluate(() => getSelection()!.toString()); expect(before.length).toBeGreaterThan(8);
      const original = (await excerpt.elementHandle())!; await page.evaluate(() => window.__quoteSignoff.update());
      await expect.poll(() => original.evaluate(node => node.isConnected)).toBe(false);
      expect(await page.evaluate(() => getSelection()!.toString())).toBe(before);
    });
    for (const backwards of [false, true]) test(kind + ' keeps a finished native selection (backwards=' + backwards + ')', async ({ page }) => {
      const pre = await reply(page, kind); await dragStart(page, pre, backwards); await page.mouse.up();
      const before = await page.evaluate(() => { const s = getSelection()!; return { text: s.toString(), anchor: s.anchorOffset, focus: s.focusOffset }; });
      expect(before.text.length).toBeGreaterThan(8); const original = (await pre.elementHandle())!;
      await page.evaluate(() => window.__quoteSignoff.update());
      await expect.poll(() => original.evaluate(node => node.isConnected)).toBe(false);
      expect(await page.evaluate(() => { const s = getSelection()!; return { text: s.toString(), anchor: s.anchorOffset, focus: s.focusOffset }; })).toEqual(before);
    });
    test(kind + ' keeps a selection while the native mouse drag is still held', async ({ page }) => {
      const pre = await reply(page, kind); await deferHistory(page, kind); const original = (await pre.elementHandle())!;
      await dragStart(page, pre); await page.evaluate(() => window.__quoteSignoff.release());
      await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
      expect(await original.evaluate(node => node.isConnected)).toBe(true); await page.mouse.up();
      const before = await page.evaluate(() => getSelection()!.toString()); expect(before.length).toBeGreaterThan(8);
      await expect.poll(() => original.evaluate(node => node.isConnected)).toBe(false);
      expect(await page.evaluate(() => getSelection()!.toString())).toBe(before);
    });
    test(kind + ' does not restore a selection into changed response text', async ({ page }) => {
      const pre = await reply(page, kind); await dragStart(page, pre); await page.mouse.up();
      expect(await page.evaluate(() => getSelection()!.toString())).not.toBe('');
      await page.evaluate(kind => {
        const text = 'Replacement customer response. ' + 'Updated instructions. '.repeat(20);
        if (kind === 'quote') window.__quoteSignoff.quoteResponse('declined', text);
        else window.__quoteSignoff.completionResponse('corrections_requested', text);
      }, kind);
      await expect(pre).toContainText('Replacement customer response.');
      expect(await page.evaluate(() => getSelection()!.toString())).toBe('');
    });
    test(kind + ' respects newer editing while a history read is pending', async ({ page }) => {
      const pre = await reply(page, kind); await dragStart(page, pre); await page.mouse.up();
      const original = (await pre.elementHandle())!; await deferHistory(page, kind);
      const creation = page.locator('[data-signoff-create]');
      if (!await creation.evaluate(node => (node as HTMLDetailsElement).open)) await creation.locator('summary').first().click();
      const field = page.getByLabel('Complete scope shown to the customer', { exact: true });
      await field.fill('New editing while the response refresh waits.');
      await field.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(4, 11));
      await page.evaluate(() => window.__quoteSignoff.release());
      await expect.poll(() => original.evaluate(node => node.isConnected)).toBe(false);
      await expect(field).toBeFocused();
      expect(await field.evaluate(node => [(node as HTMLTextAreaElement).selectionStart, (node as HTMLTextAreaElement).selectionEnd])).toEqual([4, 11]);
    });
  }
});
