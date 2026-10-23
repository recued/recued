import { expect, test, type Page } from '@playwright/test';
import { evaluateCustomDomainPreflight, evaluateCustomDomainIssuanceEligibility } from '@recued/contracts';
import { HARNESS_URL } from './helpers/full-app.js';

type Outcome = 'success' | 'error';
type Reply = { result?: unknown; error?: { code: string; message: string } };
type Call = { method: string; args: unknown };
interface DomainFixture {
  reads: string[];
  writes: Call[];
  expectedWrites: Call[];
  unexpectedWrites: string[];
  release(index: number, outcome: Outcome): void;
  releaseWrite(outcome: Outcome): void;
}
declare global { interface Window { __customDomainContinuity: DomainFixture } }

const ALPHA = 'alpha.example.test';
const BETA = 'beta.example.test';
const APEX = 'their-domain.com';
const LONG_HOSTNAME = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'example', 'test'].join('.');
const panel = (page: Page) => page.locator('[data-recued-custom-domains]');
const input = (page: Page) => panel(page).locator('[data-recued-custom-domains-input]');
const check = (page: Page) => panel(page).locator('[data-recued-custom-domains-check]');
const add = (page: Page) => panel(page).locator('[data-recued-custom-domains-add]');
const record = (page: Page) => panel(page).locator('[data-recued-custom-domains-record]');
const status = (page: Page) => panel(page).locator('[data-recued-custom-domains-status]');
const error = (page: Page) => panel(page).locator('[data-recued-custom-domains-error]');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside custom domains', exact: true });
const keyFor = (width: number) => width === 390 ? 'Space' : 'Enter';
const drain = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const release = (page: Page, index: number, outcome: Outcome) =>
  page.evaluate(args => window.__customDomainContinuity.release(args.index, args.outcome), { index, outcome });
const reads = (page: Page) => page.evaluate(() => window.__customDomainContinuity.reads);
const fixtures = Object.fromEntries([ALPHA, BETA, APEX, LONG_HOSTNAME].map(hostname => {
  // Incomplete delegation is deliberate: adding a domain before DNS is ready
  // remains supported. Every RPC below is synthetic and stays on localhost.
  const preflight = evaluateCustomDomainPreflight({
    hostname, handle: 'alice', observation: {
      host_cnames: ['alice.recued.net'], host_addresses: [], ddns_addresses: [],
      delegation_cnames: [], caa_records: [],
    },
  });
  const decision = evaluateCustomDomainIssuanceEligibility({
    row: { cert_source: 'unregistered', ownership_status: 'pending', enabled: false },
    preflight, subscription_active: true, enrolled_custom_count: 1,
  });
  return [hostname, { preflight, decision }];
}));
let errors: string[] = [];
let externalRequests: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = []; externalRequests = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(HARNESS_URL).origin) return route.continue();
    externalRequests.push(route.request().url()); return route.abort();
  });
});
test.afterEach(async ({ page }, info) => {
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  // Chromium-only CDP journeys skip before the page fixture is installed.
  if (info.expectedStatus === 'skipped') return;
  const receipt = await page.evaluate(() => ({
    reads: window.__customDomainContinuity.reads.length,
    rpcReads: window.__app.rpcCallCount('collection.hostname.issuanceReadiness'),
    writes: window.__customDomainContinuity.writes,
    expected: window.__customDomainContinuity.expectedWrites,
    unexpected: window.__customDomainContinuity.unexpectedWrites,
  }));
  expect(receipt.unexpected).toEqual([]);
  expect(receipt.writes).toEqual(receipt.expected);
  expect(receipt.reads).toBe(receipt.rpcReads);
});

const open = async (page: Page, width: number, hostname = ALPHA) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(fixtures => {
    const pending: { hostname: string; resolve(reply: Reply): void; released: boolean }[] = [];
    let write: ((reply: Reply) => void) | null = null;
    const fixture: DomainFixture = {
      reads: [], writes: [], expectedWrites: [], unexpectedWrites: [],
      release(index, outcome) {
        const item = pending[index];
        if (!item || item.released) throw new Error(`No pending custom domain read ${index}`);
        item.released = true;
        item.resolve(outcome === 'error'
          ? { error: { code: 'UNAVAILABLE', message: `Synthetic DNS unavailable for ${item.hostname}` } }
          : { result: fixtures[item.hostname] });
      },
      releaseWrite(outcome) {
        if (!write) throw new Error('No pending custom domain enrollment');
        const resolve = write; write = null;
        resolve(outcome === 'error'
          ? { error: { code: 'UNAVAILABLE', message: 'Synthetic enrollment unavailable' } }
          : { result: { hostname: { hostname: fixture.reads[fixture.reads.length - 1] } } });
      },
    };
    Object.assign(window, {
      __customDomainContinuity: fixture,
      __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
        if (['collection.hostname.issuanceReadiness', 'collection.hostname.preflight'].includes(method)) {
          const hostname = (args as { hostname: string }).hostname;
          fixture.reads.push(hostname);
          if (!fixtures[hostname]) throw new Error(`Unexpected DNS fixture hostname ${hostname}`);
          return new Promise(resolve => { pending.push({ hostname, resolve, released: false }); });
        }
        if (method === 'collection.hostname.add') {
          fixture.writes.push({ method, args });
          return new Promise(resolve => { write = resolve; });
        }
        if (['collection.hostname.update', 'collection.hostname.verify', 'collection.hostname.remove',
          'tls_domain.upload', 'tls_domain.remove', 'tls.renew', 'key.rotate'].includes(method)) {
          fixture.unexpectedWrites.push(method);
          return { error: { code: 'FORBIDDEN', message: 'Unexpected synthetic fixture write' } };
        }
        if (method === 'tls_domain.list') return { result: { entries: [] } };
        return undefined;
      },
    });
  }, fixtures);
  await page.goto(`${HARNESS_URL}?settle_reads=1&notifications=ready&yours=demo`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    const target = document.createElement('button');
    target.textContent = 'Outside custom domains'; document.body.appendChild(target);
    window.__app.setHash('#settings/server/hostnames');
  });
  await expect(input(page)).toBeVisible(); await drain(page);
  await input(page).focus(); await page.keyboard.type(hostname);
  return { oldInput: (await input(page).elementHandle())!, oldCheck: (await check(page).elementHandle())! };
};
const startCheck = async (page: Page, width: number) => {
  const count = (await reads(page)).length;
  await check(page).focus(); await page.keyboard.press(keyFor(width));
  await expect(status(page)).toHaveText(new RegExp('Checking DNS for '));
  await expect(status(page)).toHaveAttribute('role', 'status');
  await expect(status(page)).toHaveAttribute('aria-atomic', 'true');
  await expect(status(page)).toBeFocused(); await expect(status(page)).toBeInViewport();
  await expect.poll(async () => (await reads(page)).length).toBe(count + 1);
};
const edit = async (page: Page, hostname: string) => {
  await input(page).focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(hostname);
  await expect(input(page)).toHaveValue(hostname);
};
const expectOutcome = async (page: Page, outcome: Outcome, hostname: string) => {
  await expect(check(page)).toBeEnabled(); await expect(status(page)).toBeHidden();
  if (outcome === 'success') {
    await expect(record(page)).toContainText(hostname);
    await expect(error(page)).toHaveCount(0);
  } else {
    await expect(error(page)).toContainText(`Synthetic DNS unavailable for ${hostname}`);
    await expect(error(page)).toHaveAttribute('role', 'alert');
    await expect(record(page)).toHaveCount(0);
  }
};

const domainDraftPrompt = 'Discard the unsaved custom domain?';
const domainWorkPrompt = 'A custom domain is still being added. Leave Settings anyway?';
const domainUnload = (page: Page) => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event); return event.defaultPrevented;
});
const domainLeave = (page: Page) => page.evaluate(() => window.__app.setHash('#yours/assets'));
const discardDomainDraft = async (page: Page) => {
  const prompted = new Promise<string>(resolve => page.once('dialog', dialog => {
    resolve(dialog.message()); void dialog.accept();
  }));
  await page.evaluate(() => window.__app.setHash('#yours'));
  expect(await prompted).toBe(domainDraftPrompt);
};

for (const width of [390, 1280]) {
  for (const scenario of ['after-success', 'during-success', 'during-error'] as const) {
    test(`Custom DNS ${scenario} preserves the edited draft and undo at ${width}px`, async ({ page }, info) => {
      const { oldInput, oldCheck } = await open(page, width);
      await startCheck(page, width);
      let oldAdd;
      let oldCopy;
      if (scenario === 'after-success') {
        await release(page, 0, 'success'); await expectOutcome(page, 'success', ALPHA);
        oldAdd = await add(page).elementHandle();
        oldCopy = await panel(page).locator('[data-recued-custom-domains-copy]').first().elementHandle();
      }
      await edit(page, BETA);
      // Engines choose different undo transaction boundaries. Record the native
      // history before the reply, then require the same undo/redo after it.
      await page.keyboard.press('ControlOrMeta+z');
      const undoValue = await input(page).inputValue();
      expect(undoValue).not.toBe(BETA);
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(input(page)).toHaveValue(BETA);
      await input(page).evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 3, 'forward'));
      if (scenario !== 'after-success') await release(page, 0, scenario === 'during-error' ? 'error' : 'success');
      await drain(page);
      expect(await oldInput.evaluate(node => node === document.activeElement)).toBe(true);
      expect(await oldCheck.evaluate(node => node.isConnected)).toBe(true);
      await expect(input(page)).toHaveValue(BETA); await expect(input(page)).toBeFocused();
      expect(await input(page).evaluate(node => {
        const field = node as HTMLInputElement; return [field.selectionStart, field.selectionEnd, field.selectionDirection];
      })).toEqual([1, 3, 'forward']);
      await expect(record(page)).toHaveCount(0); await expect(error(page)).toHaveCount(0); await expect(add(page)).toHaveCount(0);
      await oldAdd?.evaluate(node => (node as HTMLButtonElement).click());
      await oldCopy?.evaluate(node => (node as HTMLButtonElement).click());
      await page.keyboard.press('ControlOrMeta+z'); await expect(input(page)).toHaveValue(undoValue);
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(input(page)).toHaveValue(BETA);
      expect(await reads(page)).toEqual([ALPHA]);
      await startCheck(page, width); await release(page, 1, 'success'); await expectOutcome(page, 'success', BETA);
      await expect(check(page)).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('current-domain-results.png'), fullPage: true });
    });
  }

  for (const oldOutcome of ['success', 'error'] as const) {
    for (const newOutcome of ['success', 'error'] as const) {
      test(`Custom DNS old ${oldOutcome} cannot settle new ${newOutcome} at ${width}px`, async ({ page }) => {
        await open(page, width); await startCheck(page, width);
        await edit(page, BETA); await startCheck(page, width);
        await release(page, 0, oldOutcome); await drain(page);
        await expect(status(page)).toHaveText(`Checking DNS for ${BETA}…`); await expect(status(page)).toBeFocused();
        await expect(check(page)).toBeDisabled(); await expect(record(page)).toHaveCount(0); await expect(error(page)).toHaveCount(0);
        await release(page, 1, newOutcome); await expectOutcome(page, newOutcome, BETA);
        await expect(check(page)).toBeFocused(); expect(await reads(page)).toEqual([ALPHA, BETA]);
      });
    }
  }

  test(`Custom DNS cannot reuse a check after A to B to A at ${width}px`, async ({ page }) => {
    await open(page, width); await startCheck(page, width);
    await edit(page, BETA); await edit(page, ALPHA);
    await release(page, 0, 'success'); await drain(page);
    await expect(input(page)).toBeFocused(); await expect(record(page)).toHaveCount(0); await expect(add(page)).toHaveCount(0);
    await startCheck(page, width); await release(page, 1, 'success'); await expectOutcome(page, 'success', ALPHA);
    expect(await reads(page)).toEqual([ALPHA, ALPHA]);
  });

  test(`Custom DNS accepts equivalent edits without replacing the input at ${width}px`, async ({ page }) => {
    const { oldInput } = await open(page, width); await startCheck(page, width);
    await input(page).focus(); await page.keyboard.press('End'); await page.keyboard.type('.');
    await input(page).evaluate(node => (node as HTMLInputElement).setSelectionRange(0, 1, 'forward'));
    await page.keyboard.type('A');
    await release(page, 0, 'success'); await expectOutcome(page, 'success', ALPHA);
    await expect(input(page)).toHaveValue('Alpha.example.test.'); await expect(input(page)).toBeFocused();
    expect(await oldInput.evaluate(node => node === document.activeElement)).toBe(true);
    expect(await reads(page)).toEqual([ALPHA]); await expect(add(page)).toBeEnabled();
  });

  for (const outcome of ['success', 'error'] as const) {
    for (const owner of ['check', 'outside', 'blurred'] as const) {
      test(`Custom DNS ${outcome} respects ${owner} focus at ${width}px`, async ({ page, browserName }) => {
        await open(page, width); await startCheck(page, width);
        await check(page).evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
        await page.keyboard.press('Enter'); expect(await reads(page)).toEqual([ALPHA]);
        if (owner === 'outside') {
          await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
          await expect(status(page)).not.toBeFocused(); await outside(page).focus();
        } else if (owner === 'blurred') await status(page).evaluate(node => (node as HTMLElement).blur());
        await release(page, 0, outcome); await expectOutcome(page, outcome, ALPHA);
        if (owner === 'check') await expect(check(page)).toBeFocused();
        else if (owner === 'outside') await expect(outside(page)).toBeFocused();
        else expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
      });
    }

    test(`Custom DNS disposal ignores late ${outcome} at ${width}px`, async ({ page }) => {
      const { oldCheck } = await open(page, width); await startCheck(page, width);
      await discardDomainDraft(page);
      await expect(panel(page)).toHaveCount(0); await outside(page).focus();
      await release(page, 0, outcome); await oldCheck.evaluate(node => (node as HTMLButtonElement).click()); await drain(page);
      await expect(panel(page)).toHaveCount(0); await expect(outside(page)).toBeFocused();
      expect(await reads(page)).toEqual([ALPHA]);
      await page.evaluate(() => window.__app.setHash('#settings/server/hostnames'));
      await expect(input(page)).toHaveValue(''); await expect(record(page)).toHaveCount(0); await expect(add(page)).toHaveCount(0);
    });

    test(`Custom domain enrollment remains acknowledged after refresh ${outcome} at ${width}px`, async ({ page }, info) => {
      const { oldInput } = await open(page, width); await startCheck(page, width);
      await release(page, 0, 'success'); await expectOutcome(page, 'success', ALPHA);
      await expect(panel(page)).toContainText('Missing. Without it'); await expect(add(page)).toBeEnabled();
      const oldAdd = (await add(page).elementHandle())!;
      await page.evaluate(hostname => window.__customDomainContinuity.expectedWrites.push({
        method: 'collection.hostname.add', args: { hostname, cert_source: 'recued_acme_custom' },
      }), ALPHA);
      await add(page).focus(); await page.keyboard.press(keyFor(width));
      await expect(status(page)).toHaveText(`Adding ${ALPHA}…`); await expect(status(page)).toBeFocused();
      await expect(input(page)).toBeDisabled(); await expect(check(page)).toBeDisabled();
      await oldAdd.evaluate(node => (node as HTMLButtonElement).click());
      await check(page).evaluate(node => (node as HTMLButtonElement).click());
      await outside(page).focus(); await page.evaluate(() => window.__customDomainContinuity.releaseWrite('success'));
      await expect(status(page)).toHaveText(`Checking DNS for ${ALPHA}…`);
      expect(await domainUnload(page)).toBe(false);
      await expect(panel(page)).toContainText(`${ALPHA} added.`); await expect(add(page)).toHaveCount(0);
      await release(page, 1, outcome); await expectOutcome(page, outcome, ALPHA);
      expect(await domainUnload(page)).toBe(false);
      await expect(panel(page)).toContainText(`${ALPHA} added.`); await expect(add(page)).toHaveCount(0);
      await expect(outside(page)).toBeFocused(); expect(await oldInput.evaluate(node => node.isConnected)).toBe(true);
      await oldAdd.evaluate(node => (node as HTMLButtonElement).click());
      expect(await reads(page)).toEqual([ALPHA, ALPHA]);
      await page.screenshot({ path: info.outputPath('acknowledged-enrollment.png'), fullPage: true });
      await edit(page, BETA); await expect(panel(page)).not.toContainText(`${ALPHA} added.`);
      await expect(record(page)).toHaveCount(0); await expect(add(page)).toHaveCount(0);
    });
  }

  test(`Custom domain enrollment failure preserves a retryable draft at ${width}px`, async ({ page }) => {
    await open(page, width); await startCheck(page, width);
    await release(page, 0, 'success'); await expectOutcome(page, 'success', ALPHA);
    await page.evaluate(hostname => window.__customDomainContinuity.expectedWrites.push({
      method: 'collection.hostname.add', args: { hostname, cert_source: 'recued_acme_custom' },
    }), ALPHA);
    await add(page).focus(); await page.keyboard.press(keyFor(width));
    await expect(status(page)).toHaveText(`Adding ${ALPHA}…`);
    await page.evaluate(() => window.__customDomainContinuity.releaseWrite('error'));
    await expect(error(page)).toContainText('Synthetic enrollment unavailable');
    await expect(input(page)).toHaveValue(ALPHA); await expect(input(page)).toBeEnabled();
    await expect(add(page)).toBeEnabled(); await expect(panel(page)).not.toContainText(`${ALPHA} added.`);
    expect(await reads(page)).toEqual([ALPHA]);
    await edit(page, BETA); await expect(error(page)).toHaveCount(0); await expect(add(page)).toHaveCount(0);
  });
}

for (const width of [280, 390, 1280]) {
  for (const hostname of [APEX, LONG_HOSTNAME]) {
    test(`Custom DNS styles keep ${hostname === APEX ? 'apex guidance' : 'long records'} readable at ${width}px`, async ({ page }, info) => {
      await open(page, width, hostname);
      await expect(panel(page)).toHaveCSS('display', 'flex');
      await expect(check(page)).toHaveCSS('display', 'flex');
      await expect(panel(page)).toHaveCSS('flex-direction', 'column');
      await expect(panel(page)).toHaveCSS('border-top-width', '1px');
      await expect(panel(page).locator('.custom-domains-form')).toHaveCSS('flex-wrap', 'wrap');
      await expect(panel(page).locator('.custom-domains-results')).toBeHidden();
      await startCheck(page, width);
      await expect(status(page)).toHaveCSS('font-size', '13px');
      await release(page, 0, 'success'); await expectOutcome(page, 'success', hostname);
      await expect(record(page)).toHaveCSS('border-top-width', '1px');
      const family = await input(page).evaluate(node => getComputedStyle(node).fontFamily);
      for (const button of await panel(page).getByRole('button').all()) {
        await expect(button).toHaveCSS('display', 'flex');
        await expect(button).toHaveCSS('font-family', family);
      }
      const delegation = panel(page).locator('[data-recued-custom-domains-delegation]');
      await expect(delegation).toHaveCSS('border-left-width', '2px');
      await expect(record(page)).toContainText(hostname);
      await expect(delegation).toContainText(`_acme-challenge.${hostname}`);
      await expect(delegation).toContainText('DNS only');
      await expect(panel(page).locator('[data-recued-custom-domains-relative]')).toHaveCount(2);
      if (hostname === APEX) {
        const warning = panel(page).locator('[data-recued-custom-domains-apex]');
        await expect(warning).toContainText('ALIAS, ANAME');
        await expect(warning).toHaveCSS('border-left-width', '3px');
        expect(await warning.evaluate(node => {
          const record = document.querySelector('[data-recued-custom-domains-record]')!;
          return (node.compareDocumentPosition(record) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        })).toBe(true);
      }
      // Long DNS values may wrap; the short field labels must remain words.
      expect(await panel(page).locator('.custom-domains-record-row > .custom-domains-record-label').evaluateAll(labels => labels.every(label => {
        const range = document.createRange(); range.selectNodeContents(label);
        return range.getClientRects().length === 1;
      }))).toBe(true);
      expect(await panel(page).evaluate(root => {
        const bounds = root.getBoundingClientRect();
        return Array.from(root.querySelectorAll('input, button, .custom-domains-record-value')).every(node => {
          const box = node.getBoundingClientRect();
          return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
        });
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await panel(page).locator('.custom-domains-records').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('styled-dns-instructions.png'), fullPage: true });
      // A fresh route mount must reuse the existing bundle and remain styled.
      await discardDomainDraft(page); await expect(panel(page)).toHaveCount(0);
      await page.evaluate(() => window.__app.setHash('#settings/server/hostnames'));
      await expect(panel(page)).toHaveCSS('display', 'flex');
      await expect(panel(page)).toHaveCSS('border-top-width', '1px');
      await expect(page.locator('style[data-recued-settings-route-styles]')).toHaveCount(1);
      await expect(input(page)).toHaveValue('');
    });
  }
}

const beginDomainEnrollment = async (page: Page, width: number, hostname = ALPHA) => {
  await open(page, width, hostname); await startCheck(page, width);
  await release(page, 0, 'success'); await expectOutcome(page, 'success', ALPHA);
  await page.evaluate(hostname => window.__customDomainContinuity.expectedWrites.push({
    method: 'collection.hostname.add', args: { hostname, cert_source: 'recued_acme_custom' },
  }), ALPHA);
  await add(page).focus(); await page.keyboard.press(keyFor(width));
  await expect(status(page)).toHaveText(`Adding ${ALPHA}…`); await expect(input(page)).toBeDisabled();
};

for (const width of [390, 1280]) {
  test(`Custom domain navigation preserves raw drafts and native editing on cancellation at ${width}px`, async ({ page }) => {
    const raw = ' HTTPS://Alpha.EXAMPLE.test/path ';
    const { oldInput, oldCheck } = await open(page, width, raw);
    await page.keyboard.press('ControlOrMeta+z'); const undoValue = await input(page).inputValue(); expect(undoValue).not.toBe(raw);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(input(page)).toHaveValue(raw);
    await input(page).evaluate((node: HTMLInputElement) => node.setSelectionRange(2, 6, 'backward'));
    const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    expect(await domainUnload(page)).toBe(true); await domainLeave(page); await expect.poll(() => dialogs).toEqual([domainDraftPrompt]);
    await expect(input(page)).toHaveValue(raw); await expect(input(page)).toBeFocused();
    expect(await oldInput.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    expect(await oldCheck.evaluate(node => node.isConnected)).toBe(true);
    expect(await input(page).evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 6, 'backward']);
    await page.keyboard.press('ControlOrMeta+z'); await expect(input(page)).toHaveValue(undoValue);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(input(page)).toHaveValue(raw);
    accept = true; await domainLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#settings/server/hostnames')); await expect(input(page)).toHaveValue('');
    expect(await domainUnload(page)).toBe(false); expect(dialogs).toEqual([domainDraftPrompt, domainDraftPrompt]);
  });

  test(`Custom domain navigation protects native reloads and preserves canceled editing at ${width}px`, async ({ page }) => {
    const raw = ' HTTPS://Alpha.EXAMPLE.test/path ';
    const { oldInput } = await open(page, width, raw);
    await input(page).evaluate((node: HTMLInputElement) => node.setSelectionRange(2, 6, 'backward'));
    expect(await domainUnload(page)).toBe(true);
    const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.type()); void (accept ? dialog.accept() : dialog.dismiss()); });
    await page.evaluate(() => { location.reload(); }); await expect.poll(() => dialogs).toEqual(['beforeunload']);
    await expect(input(page)).toHaveValue(raw); await expect(input(page)).toBeFocused();
    expect(await oldInput.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    expect(await input(page).evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 6, 'backward']);
    accept = true; await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(input(page)).toHaveValue(''); expect(await domainUnload(page)).toBe(false);
    expect(dialogs).toEqual(['beforeunload', 'beforeunload']);
  });

  test(`Custom domain navigation leaves untouched, cleared and restored forms clean at ${width}px`, async ({ page }) => {
    await open(page, width, ''); expect(await domainUnload(page)).toBe(false);
    await check(page).click(); await expect(error(page)).toContainText('Type the name'); expect(await domainUnload(page)).toBe(false);
    for (const raw of [' ', ALPHA, 'HTTPS://Alpha.example.test/path']) {
      await input(page).fill(raw); expect(await domainUnload(page)).toBe(true);
      await input(page).fill(''); expect(await domainUnload(page)).toBe(false);
    }
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await domainLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([]);
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`Custom domain navigation keeps DNS ${outcome} guarded as a draft at ${width}px`, async ({ page }) => {
      const { oldInput } = await open(page, width); await startCheck(page, width); expect(await domainUnload(page)).toBe(true);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await domainLeave(page); await expect.poll(() => dialogs).toEqual([domainDraftPrompt]);
      await release(page, 0, outcome); await expectOutcome(page, outcome, ALPHA);
      await expect(input(page)).toHaveValue(ALPHA); expect(await oldInput.evaluate(node => node.isConnected)).toBe(true);
      expect(await domainUnload(page)).toBe(true); await domainLeave(page); await expect.poll(() => dialogs).toEqual([domainDraftPrompt, domainDraftPrompt]);
      await input(page).fill(''); expect(await domainUnload(page)).toBe(false);
      await domainLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toHaveLength(2);
    });

    test(`Custom domain navigation retires a late DNS ${outcome} after accepted departure at ${width}px`, async ({ page }) => {
      const { oldCheck } = await open(page, width); await startCheck(page, width);
      const dialogs: string[] = []; let accept = true;
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
      await domainLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([domainDraftPrompt]);
      await page.evaluate(() => window.__app.setHash('#settings/server/hostnames')); await expect(input(page)).toHaveValue('');
      await input(page).fill(BETA); await input(page).evaluate((node: HTMLInputElement) => node.setSelectionRange(1, 4, 'backward'));
      const fresh = await input(page).elementHandle(); await release(page, 0, outcome);
      await oldCheck.evaluate(node => (node as HTMLButtonElement).click()); await drain(page);
      await expect(input(page)).toHaveValue(BETA); await expect(input(page)).toBeFocused();
      expect(await fresh!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      expect(await input(page).evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([1, 4, 'backward']);
      await expect(record(page)).toHaveCount(0); await expect(error(page)).toHaveCount(0); expect(await reads(page)).toEqual([ALPHA]);
      accept = false; await domainLeave(page); await expect.poll(() => dialogs).toEqual([domainDraftPrompt, domainDraftPrompt]);
    });

    test(`Custom domain navigation guards enrollment until ${outcome} and retires acknowledged drafts at ${width}px`, async ({ page }) => {
      const raw = ' HTTPS://Alpha.EXAMPLE.test/path ';
      await beginDomainEnrollment(page, width, raw); expect(await domainUnload(page)).toBe(true);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.type() === 'beforeunload' ? 'beforeunload' : dialog.message()); void dialog.dismiss(); });
      await domainLeave(page); await expect.poll(() => dialogs).toEqual([domainWorkPrompt]);
      await page.evaluate(() => { location.reload(); }); await expect.poll(() => dialogs).toEqual([domainWorkPrompt, 'beforeunload']);
      await page.evaluate(outcome => window.__customDomainContinuity.releaseWrite(outcome), outcome);
      if (outcome === 'success') {
        await expect(panel(page)).toContainText(`${ALPHA} added.`); await expect(status(page)).toHaveText(`Checking DNS for ${ALPHA}…`);
        await expect(input(page)).toHaveValue(raw); expect(await domainUnload(page)).toBe(false);
        await input(page).fill(`${raw} `); expect(await domainUnload(page)).toBe(true);
        await input(page).fill(raw); expect(await domainUnload(page)).toBe(false);
        await release(page, 1, 'error'); await expectOutcome(page, 'error', ALPHA);
        await expect(panel(page)).toContainText(`${ALPHA} added.`); expect(await domainUnload(page)).toBe(false);
        await input(page).fill(BETA); expect(await domainUnload(page)).toBe(true);
        await input(page).fill(raw); expect(await domainUnload(page)).toBe(false);
      } else {
        await expect(error(page)).toContainText('Synthetic enrollment unavailable'); await expect(input(page)).toHaveValue(raw);
        expect(await domainUnload(page)).toBe(true); await domainLeave(page);
        await expect.poll(() => dialogs).toEqual([domainWorkPrompt, 'beforeunload', domainDraftPrompt]);
      }
      await input(page).fill(''); expect(await domainUnload(page)).toBe(false);
      await domainLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
      expect(await page.evaluate(() => window.__customDomainContinuity.writes)).toHaveLength(1);
    });

    test(`Custom domain navigation ignores a late enrollment ${outcome} after accepted departure at ${width}px`, async ({ page }) => {
      await beginDomainEnrollment(page, width);
      const dialogs: string[] = []; let accept = true;
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
      await domainLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([domainWorkPrompt]);
      await page.evaluate(() => window.__app.setHash('#settings/server/hostnames')); await expect(input(page)).toHaveValue('');
      await input(page).fill(BETA); await input(page).evaluate((node: HTMLInputElement) => node.setSelectionRange(1, 4, 'backward'));
      const fresh = await input(page).elementHandle(); await page.evaluate(outcome => window.__customDomainContinuity.releaseWrite(outcome), outcome); await drain(page);
      await expect(input(page)).toHaveValue(BETA); await expect(input(page)).toBeFocused();
      expect(await fresh!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      expect(await input(page).evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([1, 4, 'backward']);
      await expect(record(page)).toHaveCount(0); await expect(error(page)).toHaveCount(0); await expect(panel(page)).not.toContainText(`${ALPHA} added.`);
      expect(await reads(page)).toEqual([ALPHA]); accept = false; await domainLeave(page);
      await expect.poll(() => dialogs).toEqual([domainWorkPrompt, domainDraftPrompt]);
    });
  }

  test(`Custom domain navigation preserves Back and Forward after repeated cancellation at ${width}px`, async ({ page }) => {
    await open(page, width, ''); await domainLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#settings/server/hostnames')); await input(page).fill(ALPHA);
    const original = await input(page).elementHandle(), dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.goBack(); await expect.poll(() => dialogs).toHaveLength(attempt); await expect(page).toHaveURL(/#settings\/server\/hostnames$/u);
      await expect(input(page)).toHaveValue(ALPHA); expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    }
    accept = true; await page.goBack(); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.goForward(); await expect(input(page)).toHaveValue(''); expect(await domainUnload(page)).toBe(false);
    expect(dialogs).toEqual([domainDraftPrompt, domainDraftPrompt, domainDraftPrompt]);
  });
}

type ClipboardMode = 'success' | 'denied' | 'unavailable' | 'hold';
interface DomainClipboardFixture {
  mode: ClipboardMode;
  calls: string[];
  release(index: number, outcome: Outcome): void;
}
declare global { interface Window { __domainClipboard: DomainClipboardFixture } }
const copyButton = (page: Page, index: number) => panel(page).locator('[data-recued-custom-domains-copy]').nth(index);
const copyFeedback = (page: Page, index: number) => panel(page).locator('[data-recued-custom-domains-copy-status]').nth(index);
const copyValue = (index: number) => index === 0 ? 'alice.recued.net' : '_acme-challenge.alice.recued.net';
const installClipboard = (page: Page, mode: ClipboardMode) => page.addInitScript(mode => {
  const pending: { resolve(): void; reject(reason: Error): void; released: boolean }[] = [];
  const fixture: DomainClipboardFixture = {
    mode, calls: [],
    release(index, outcome) {
      const item = pending[index];
      if (!item || item.released) throw new Error(`No pending clipboard write ${index}`);
      item.released = true;
      if (outcome === 'success') item.resolve(); else item.reject(new Error('Synthetic clipboard denial'));
    },
  };
  window.__domainClipboard = fixture;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: mode === 'unavailable' ? undefined : {
      writeText(value: string): Promise<void> {
        fixture.calls.push(value);
        if (fixture.mode === 'denied') return Promise.reject(new Error('Synthetic clipboard denial'));
        if (fixture.mode === 'hold') return new Promise((resolve, reject) => { pending.push({ resolve, reject, released: false }); });
        return Promise.resolve();
      },
    },
  });
}, mode);
const releaseCopy = (page: Page, outcome: Outcome) => page.evaluate(outcome => window.__domainClipboard.release(0, outcome), outcome);
const openCopy = async (page: Page, width: number, mode: ClipboardMode) => {
  await installClipboard(page, mode); await open(page, width); await startCheck(page, width);
  await release(page, 0, 'success'); await expectOutcome(page, 'success', ALPHA);
};

for (const width of [390, 1280]) {
  for (const index of [0, 1]) {
    for (const mode of ['success', 'denied', 'unavailable'] as const) {
      test(`DNS copy ${index === 0 ? 'routing' : 'delegation'} handles ${mode} at ${width}px`, async ({ page }, info) => {
        await openCopy(page, width, mode);
        const oldInput = (await input(page).elementHandle())!;
        const button = copyButton(page, index);
        const oldButton = (await button.elementHandle())!;
        await expect(button).toHaveAttribute('aria-label', `Copy value for ${index === 0 ? '' : '_acme-challenge.'}${ALPHA}`);
        await button.focus(); await page.keyboard.press(keyFor(width));
        await expect(copyFeedback(page, index)).toHaveAttribute('role', 'status');
        await expect(copyFeedback(page, index)).toHaveAttribute('aria-atomic', 'true');
        if (mode === 'success') {
          await expect(copyFeedback(page, index)).toHaveText('Value copied.'); await expect(button).toBeFocused();
        } else {
          await expect(copyFeedback(page, index)).toContainText('Copy it manually');
          expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(copyValue(index));
          expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(copyValue(index));
        }
        expect(await page.evaluate(() => window.__domainClipboard.calls)).toEqual(mode === 'unavailable' ? [] : [copyValue(index)]);
        await expect(button).toHaveAttribute('aria-disabled', 'false');
        await expect(copyFeedback(page, 1 - index)).toBeHidden();
        expect(await oldButton.evaluate(node => node.isConnected)).toBe(true);
        expect(await oldInput.evaluate(node => node.isConnected)).toBe(true);
        if (mode === 'denied') {
          await page.evaluate(() => { window.__domainClipboard.mode = 'success'; });
          await button.focus(); await page.keyboard.press(keyFor(width));
          await expect(copyFeedback(page, index)).toHaveText('Value copied.'); await expect(button).toBeFocused();
          expect(await page.evaluate(() => window.__domainClipboard.calls)).toEqual([copyValue(index), copyValue(index)]);
        }
        expect(await reads(page)).toEqual([ALPHA]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (mode !== 'success') await page.screenshot({ path: info.outputPath('manual-dns-copy.png'), fullPage: true });
      });
    }
  }
}

for (const owner of ['button', 'outside', 'selection', 'input'] as const) {
  test(`DNS copy denial respects ${owner} ownership while pending`, async ({ page, browserName }) => {
    await openCopy(page, 390, 'hold');
    const button = copyButton(page, 1); const oldButton = (await button.elementHandle())!;
    await button.focus(); await page.keyboard.press('Space');
    await expect(copyFeedback(page, 1)).toHaveText('Copying value…');
    await expect(button).toHaveAttribute('aria-disabled', 'true'); await expect(button).toBeFocused();
    await page.keyboard.press('Enter'); await oldButton.evaluate(node => (node as HTMLButtonElement).click());
    expect(await page.evaluate(() => window.__domainClipboard.calls)).toEqual([copyValue(1)]);
    if (owner === 'outside') {
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab'); await outside(page).focus();
    } else if (owner === 'input') {
      await input(page).focus(); await page.keyboard.press('End'); await page.keyboard.type('.');
      await input(page).evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 3, 'forward'));
    } else if (owner === 'selection') {
      await page.evaluate(() => {
        const text = document.createElement('p'); text.textContent = 'Keep this newer selection'; document.body.appendChild(text);
        const range = document.createRange(); range.selectNodeContents(text);
        const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      });
    }
    await releaseCopy(page, 'error'); await expect(copyFeedback(page, 1)).toContainText('Copy it manually');
    if (owner === 'button') {
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(copyValue(1));
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(copyValue(1));
    } else if (owner === 'outside') await expect(outside(page)).toBeFocused();
    else if (owner === 'selection') {
      await expect(button).toBeFocused(); expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('Keep this newer selection');
    } else {
      await expect(input(page)).toBeFocused(); await expect(input(page)).toHaveValue(`${ALPHA}.`);
      expect(await input(page).evaluate(node => [(node as HTMLInputElement).selectionStart, (node as HTMLInputElement).selectionEnd])).toEqual([1, 3]);
    }
    await expect(button).toHaveAttribute('aria-disabled', 'false');
  });
}

for (const outcome of ['success', 'error'] as const) {
  for (const invalidation of ['edit', 'recheck', 'dispose'] as const) {
    test(`DNS copy ignores a late ${outcome} after ${invalidation}`, async ({ page }) => {
      await openCopy(page, 390, 'hold');
      const button = copyButton(page, 0); const oldButton = (await button.elementHandle())!;
      const oldFeedback = (await copyFeedback(page, 0).elementHandle())!;
      await button.focus(); await page.keyboard.press('Enter'); await expect(copyFeedback(page, 0)).toHaveText('Copying value…');
      if (invalidation === 'edit') await edit(page, BETA);
      else if (invalidation === 'recheck') { await startCheck(page, 390); await release(page, 1, 'success'); await expectOutcome(page, 'success', ALPHA); }
      else { await discardDomainDraft(page); await expect(panel(page)).toHaveCount(0); }
      if (invalidation !== 'edit') await outside(page).focus();
      await releaseCopy(page, outcome); await drain(page);
      await oldButton.evaluate(node => (node as HTMLButtonElement).click());
      expect(await oldFeedback.evaluate(node => node.textContent)).toBe('Copying value…');
      expect(await page.evaluate(() => window.__domainClipboard.calls)).toEqual([copyValue(0)]);
      expect(await page.evaluate(() => document.getSelection()?.toString() ?? '')).not.toBe(copyValue(0));
      if (invalidation === 'edit') { await expect(input(page)).toBeFocused(); await expect(input(page)).toHaveValue(BETA); }
      else await expect(outside(page)).toBeFocused();
      if (invalidation === 'dispose') {
        await page.evaluate(() => window.__app.setHash('#settings/server/hostnames')); await expect(input(page)).toHaveValue('');
      }
      await expect(panel(page)).not.toContainText('Value copied.'); await expect(panel(page)).not.toContainText('Copy it manually');
    });
  }
}

declare global { interface Window { __domainAuditIme: Array<{ type: string; trusted: boolean }> } }
for (const width of [390, 1280]) {
  for (const departure of ['route', 'reload'] as const) {
    test(`Custom domain audit retains trusted composition text after canceled ${departure} at ${width}px`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'Trusted composition injection uses Chromium CDP.');
      const { oldInput } = await open(page, width, '');
      await input(page).evaluate(node => {
        window.__domainAuditIme = [];
        for (const name of ['compositionstart', 'compositionupdate', 'compositionend']) node.addEventListener(name, event => {
          window.__domainAuditIme.push({ type: event.type, trusted: event.isTrusted });
        });
      });
      const cdp = await page.context().newCDPSession(page), dialogs: string[] = [];
      page.on('dialog', dialog => { dialogs.push(dialog.type() === 'beforeunload' ? 'beforeunload' : dialog.message()); void dialog.dismiss(); });
      try {
        await cdp.send('Input.imeSetComposition', { text: ALPHA, selectionStart: 2, selectionEnd: 5 });
        await expect(input(page)).toHaveValue(ALPHA); expect(await domainUnload(page)).toBe(true);
        const events = await page.evaluate(() => window.__domainAuditIme);
        expect(events.some(event => event.type === 'compositionstart')).toBe(true); expect(events.every(event => event.trusted)).toBe(true);
        if (departure === 'route') await domainLeave(page); else await page.evaluate(() => { location.reload(); });
        await expect.poll(() => dialogs).toEqual([departure === 'route' ? domainDraftPrompt : 'beforeunload']);
        await expect(input(page)).toHaveValue(ALPHA); await expect(input(page)).toBeFocused();
        expect(await oldInput.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
        // The browser owns modal-dialog composition completion. Check retained
        // text and fresh native editing, without claiming an OS IME commit.
        await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(BETA);
        await expect(input(page)).toHaveValue(BETA); expect(await domainUnload(page)).toBe(true);
        await input(page).fill(''); expect(await domainUnload(page)).toBe(false);
      } finally { await cdp.detach(); }
    });
  }

  test(`Custom domain audit keeps a failed enrollment retry guarded until success at ${width}px`, async ({ page }) => {
    await beginDomainEnrollment(page, width); await page.evaluate(() => window.__customDomainContinuity.releaseWrite('error'));
    await expect(error(page)).toContainText('Synthetic enrollment unavailable'); expect(await domainUnload(page)).toBe(true);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.evaluate(hostname => window.__customDomainContinuity.expectedWrites.push({ method: 'collection.hostname.add', args: { hostname, cert_source: 'recued_acme_custom' } }), ALPHA);
    await add(page).press('Enter'); await expect(input(page)).toBeDisabled(); await domainLeave(page);
    await expect.poll(() => dialogs).toEqual([domainWorkPrompt]);
    await page.evaluate(() => window.__customDomainContinuity.releaseWrite('success'));
    await expect(panel(page)).toContainText(`${ALPHA} added.`); expect(await domainUnload(page)).toBe(false);
    await release(page, 1, 'error'); await expectOutcome(page, 'error', ALPHA); expect(await domainUnload(page)).toBe(false);
    await domainLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([domainWorkPrompt]);
    expect(await page.evaluate(() => window.__customDomainContinuity.writes)).toHaveLength(2);
  });

  test(`Custom domain audit tracks consecutive acknowledgments despite an older DNS reply at ${width}px`, async ({ page }) => {
    await beginDomainEnrollment(page, width); await page.evaluate(() => window.__customDomainContinuity.releaseWrite('success'));
    await expect(panel(page)).toContainText(`${ALPHA} added.`); expect(await domainUnload(page)).toBe(false);
    await edit(page, BETA); expect(await domainUnload(page)).toBe(true); await startCheck(page, width);
    await release(page, 2, 'success'); await expectOutcome(page, 'success', BETA);
    await page.evaluate(hostname => window.__customDomainContinuity.expectedWrites.push({ method: 'collection.hostname.add', args: { hostname, cert_source: 'recued_acme_custom' } }), BETA);
    await add(page).press('Enter'); await expect(input(page)).toBeDisabled();
    await page.evaluate(() => window.__customDomainContinuity.releaseWrite('success'));
    await expect(panel(page)).toContainText(`${BETA} added.`); expect(await domainUnload(page)).toBe(false);
    await release(page, 1, 'success'); await expect(status(page)).toHaveText(`Checking DNS for ${BETA}…`);
    await expect(input(page)).toHaveValue(BETA); expect(await domainUnload(page)).toBe(false);
    await release(page, 3, 'error'); await expectOutcome(page, 'error', BETA); expect(await domainUnload(page)).toBe(false);
    await input(page).fill(`${BETA} `); expect(await domainUnload(page)).toBe(true); await input(page).fill(BETA); expect(await domainUnload(page)).toBe(false);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await domainLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([]);
    expect(await page.evaluate(() => window.__customDomainContinuity.writes)).toHaveLength(2);
  });

  test(`Custom domain audit leaves a cleared draft clean while its old DNS read completes at ${width}px`, async ({ page }) => {
    const { oldCheck } = await open(page, width); await startCheck(page, width); await input(page).fill('');
    expect(await domainUnload(page)).toBe(false);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await domainLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await release(page, 0, 'success'); await oldCheck.evaluate(node => (node as HTMLButtonElement).click()); await drain(page);
    await page.evaluate(() => window.__app.setHash('#settings/server/hostnames'));
    await expect(input(page)).toHaveValue(''); await expect(record(page)).toHaveCount(0); await expect(error(page)).toHaveCount(0);
    expect(await domainUnload(page)).toBe(false); expect(dialogs).toEqual([]); expect(await reads(page)).toEqual([ALPHA]);
  });
}

for (const width of [390, 1280]) {
  for (const outcome of ['success', 'error'] as const) {
    test(`DNS input Enter preserves editing through ${outcome} and suppresses held-key repeats at ${width}px`, async ({ page }) => {
      const { oldInput, oldCheck } = await open(page, width);
      await input(page).fill('  HTTPS://Alpha.Example.Test./some/path  ');
      await input(page).evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 3, 'forward'));
      await page.keyboard.down('Enter');
      await expect(status(page)).toHaveText(`Checking DNS for ${ALPHA}…`);
      await expect(input(page)).toBeFocused(); await expect(input(page)).toBeEnabled();
      await page.keyboard.down('Enter'); expect(await reads(page)).toEqual([ALPHA]);
      await release(page, 0, outcome); await expectOutcome(page, outcome, ALPHA);
      await expect(input(page)).toBeFocused();
      expect(await oldInput.evaluate(node => node === document.activeElement)).toBe(true);
      expect(await oldCheck.evaluate(node => node.isConnected)).toBe(true);
      expect(await input(page).evaluate(node => [(node as HTMLInputElement).selectionStart, (node as HTMLInputElement).selectionEnd])).toEqual([1, 3]);
      await page.keyboard.down('Enter'); await drain(page); expect(await reads(page)).toEqual([ALPHA]);
      await page.keyboard.up('Enter');
      // A deliberate new Enter is a recheck, including after an RPC failure.
      await page.keyboard.press('Enter'); await expect(status(page)).toBeVisible();
      await expect.poll(() => reads(page)).toEqual([ALPHA, ALPHA]);
      await release(page, 1, 'success'); await expectOutcome(page, 'success', ALPHA);
      await expect(input(page)).toBeFocused();
    });
  }

  test(`DNS input empty Enter validates without a read at ${width}px`, async ({ page }) => {
    await open(page, width); await input(page).fill('   '); await page.keyboard.press('Enter');
    await expect(error(page)).toHaveText('Type the name you want to use.');
    await expect(input(page)).toBeFocused(); await expect(record(page)).toHaveCount(0);
    expect(await reads(page)).toEqual([]);
    await edit(page, ALPHA); await page.keyboard.press('Enter');
    await expect.poll(() => reads(page)).toEqual([ALPHA]);
    await release(page, 0, 'success'); await expectOutcome(page, 'success', ALPHA);
    await expect(input(page)).toBeFocused();
  });

  test(`DNS input Enter respects composition and modifiers at ${width}px`, async ({ page }) => {
    await open(page, width);
    for (const key of ['Shift+Enter', 'Control+Enter', 'Meta+Enter', 'Alt+Enter']) await page.keyboard.press(key);
    await drain(page); expect(await reads(page)).toEqual([]); await expect(input(page)).toBeFocused();
    // Synthetic composition lifecycle with a native Enter: this checks our
    // guard, without claiming qualification of a physical operating-system IME.
    await input(page).dispatchEvent('compositionstart', { data: 'あ' });
    await page.keyboard.press('Enter'); await drain(page); expect(await reads(page)).toEqual([]);
    await input(page).dispatchEvent('compositionend', { data: 'あ' });
    await input(page).dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: false, bubbles: true, cancelable: true });
    await drain(page); expect(await reads(page)).toEqual([]);
    await page.keyboard.press('Enter'); await expect.poll(() => reads(page)).toEqual([ALPHA]);
    await release(page, 0, 'success'); await expectOutcome(page, 'success', ALPHA);
    await expect(input(page)).toBeFocused();
  });
}

for (const obsolete of ['success', 'error'] as const) {
  test(`DNS input Enter starts an edited draft and ignores obsolete ${obsolete}`, async ({ page }) => {
    await open(page, 390); await page.keyboard.press('Enter');
    await expect.poll(() => reads(page)).toEqual([ALPHA]);
    await edit(page, BETA); await page.keyboard.press('Enter');
    await expect.poll(() => reads(page)).toEqual([ALPHA, BETA]);
    await release(page, 0, obsolete); await drain(page);
    await expect(status(page)).toHaveText(`Checking DNS for ${BETA}…`); await expect(input(page)).toBeFocused();
    await expect(record(page)).toHaveCount(0); await expect(error(page)).toHaveCount(0);
    await release(page, 1, 'success'); await expectOutcome(page, 'success', BETA);
    await expect(input(page)).toBeFocused();
  });
}
