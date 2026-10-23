import { expect, test, type Page } from '@playwright/test';
import type { TLSDomainCertListEntry } from '@recued/contracts';
import { FIXED_NOW, HARNESS_URL } from './helpers/full-app.js';

type Outcome = 'error' | 'empty' | 'rows';
type Reply = { result?: unknown; error?: { code: string; message: string } };
type Write = { method: string; args: unknown };
interface CertificateReadFixture {
  mode: 'hold' | 'ready';
  reads: number;
  writes: Write[];
  expectedWrites: Write[];
  unexpectedWrites: string[];
  removed: boolean;
  pending(): number;
  settleInitial(outcome: Outcome): void;
  release(index: number, outcome: Outcome): void;
}
declare global { interface Window { __certificateReadRecovery: CertificateReadFixture } }

const panel = (page: Page) => page.locator('[data-recued-tls-certs-panel]');
const retry = (page: Page) => panel(page).getByRole('button', { name: 'Retry loading certificates', exact: true });
const loading = (page: Page) => panel(page).locator('[data-recued-tls-certs-status]');
const heading = (page: Page) => panel(page).getByRole('heading', { name: 'Installed certificates', exact: true });
const row = (page: Page) => panel(page).locator('[data-recued-tls-certs-row]');
const empty = (page: Page) => panel(page).locator('[data-recued-tls-certs-empty]');
const form = (page: Page) => panel(page).locator('[data-recued-tls-certs-upload-form]');
const field = (page: Page, name: string) => form(page).locator(`[data-recued-tls-certs-upload-field="${name}"]`);
const outside = (page: Page) => page.getByRole('button', { name: 'Outside installed certificates', exact: true });
const readCount = (page: Page) => page.evaluate(() => window.__certificateReadRecovery.reads);
const drain = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const release = (page: Page, index: number, outcome: Outcome) =>
  page.evaluate(args => window.__certificateReadRecovery.release(args.index, args.outcome), { index, outcome });
const keyFor = (width: number) => width === 390 ? 'Space' : 'Enter';
const certPem = '-----BEGIN CERTIFICATE-----\nSYNTHETIC FIXTURE\n-----END CERTIFICATE-----';
const keyPem = '-----BEGIN PRIVATE KEY-----\nSYNTHETIC FIXTURE\n-----END PRIVATE KEY-----';
let errors: string[] = [];
let externalRequests: string[] = [];

// All inventory reads and certificate writes use held or synthetic local replies.
test.beforeEach(async ({ page }) => {
  errors = []; externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(HARNESS_URL).origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  const receipt = await page.evaluate(() => ({
    writes: window.__certificateReadRecovery.writes,
    expected: window.__certificateReadRecovery.expectedWrites,
    unexpected: window.__certificateReadRecovery.unexpectedWrites,
    reads: window.__certificateReadRecovery.reads,
    rpcReads: window.__app.rpcCallCount('tls_domain.list'),
  }));
  expect(receipt.unexpected).toEqual([]);
  expect(receipt.writes).toEqual(receipt.expected);
  expect(receipt.reads).toBe(receipt.rpcReads);
});

const expectOutcome = async (page: Page, outcome: Outcome) => {
  await expect(loading(page)).toHaveCount(0);
  if (outcome === 'error') {
    await expect(panel(page).getByRole('alert')).toContainText('inventory read unavailable');
    await expect(retry(page)).toBeVisible();
    await expect(empty(page)).toHaveCount(0);
  } else {
    await expect(retry(page)).toHaveCount(0);
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    await expect(row(page)).toHaveCount(outcome === 'rows' ? 1 : 0);
    await expect(empty(page)).toHaveCount(outcome === 'empty' ? 1 : 0);
  }
};

const open = async (page: Page, width: number, outcome: Outcome = 'error') => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(now => {
    type Pending = { resolve(reply: Reply): void; released: boolean };
    const pending: Pending[] = [];
    const reply = (outcome: Outcome): Reply => {
      if (outcome === 'error') return { error: { code: 'UNAVAILABLE', message: 'Synthetic inventory read unavailable' } };
      const entry: TLSDomainCertListEntry = {
        domain: 'scout.example.test', issuer: 'Synthetic fixture CA', source: 'byo_upload',
        fingerprint: (fixture.writes.some(write => write.method === 'tls_domain.upload') ? 'cd' : 'ab').repeat(32),
        expires_at: now + 90 * 86400000,
      };
      return { result: { entries: outcome === 'rows' ? [entry] : [] } };
    };
    const fixture: CertificateReadFixture = {
      mode: 'hold', reads: 0, writes: [], expectedWrites: [], unexpectedWrites: [], removed: true,
      pending: () => pending.filter(item => !item.released).length,
      settleInitial(outcome) {
        for (const item of pending) if (!item.released) item.resolve(reply(outcome));
        pending.length = 0;
      },
      release(index, outcome) {
        const item = pending[index];
        if (!item || item.released) throw new Error(`No pending certificate read ${index}`);
        item.released = true; item.resolve(reply(outcome));
      },
    };
    Object.assign(window, {
      __certificateReadRecovery: fixture,
      __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
        if (method === 'tls_domain.list') {
          fixture.reads++;
          if (fixture.mode === 'ready') return reply('rows');
          return new Promise(resolve => { pending.push({ resolve, released: false }); });
        }
        if (method === 'tls_domain.upload') {
          fixture.writes.push({ method, args });
          return { result: { fingerprint: 'cd'.repeat(32), expires_at: now + 90 * 86400000, san: ['scout.example.test'] } };
        }
        if (method === 'tls_domain.remove') {
          fixture.writes.push({ method, args }); return { result: { removed: fixture.removed } };
        }
        if (['tls.renew', 'key.rotate'].includes(method)) {
          fixture.unexpectedWrites.push(method);
          return { error: { code: 'FORBIDDEN', message: 'Unexpected synthetic fixture write' } };
        }
        return undefined;
      },
    });
    const target = document.createElement('button');
    target.textContent = 'Outside installed certificates'; document.body.appendChild(target);
    window.__app.setHash('#settings/server/certificates');
  }, FIXED_NOW);
  await expect(loading(page)).toHaveText('Loading certificates…');
  // Exposure reads this same RPC on mount; settle both before counting Retry.
  await expect.poll(() => page.evaluate(() => window.__certificateReadRecovery.pending())).toBe(2);
  await drain(page); await outside(page).focus();
  await page.evaluate(value => window.__certificateReadRecovery.settleInitial(value), outcome);
  await expectOutcome(page, outcome); await drain(page);
  await expect(outside(page)).toBeFocused();
  return readCount(page);
};

const startRetry = async (page: Page, key: string) => {
  const before = await readCount(page);
  const oldRetry = await retry(page).elementHandle();
  await retry(page).focus(); await page.keyboard.press(key);
  await expect(loading(page)).toHaveText('Loading certificates…');
  await expect(loading(page)).toHaveAttribute('role', 'status');
  await expect(loading(page)).toHaveAttribute('aria-atomic', 'true');
  await expect(loading(page)).toBeFocused(); await expect(loading(page)).toBeInViewport();
  await oldRetry!.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
  await page.keyboard.press('Enter');
  expect(await readCount(page)).toBe(before + 1);
  expect(await page.evaluate(() => window.__certificateReadRecovery.pending())).toBe(1);
  return { before, oldRetry: oldRetry! };
};

for (const width of [390, 1280]) {
  const key = keyFor(width);
  for (const outcome of ['empty', 'rows', 'error'] as const) {
    for (const owner of ['retry', 'outside', 'blurred'] as const) {
      test(`Certificates Retry ${outcome} respects ${owner} focus at ${width}px`, async ({ page, browserName }, info) => {
        await open(page, width);
        const { before, oldRetry } = await startRetry(page, key);
        if (owner === 'outside') {
          await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
          await expect(loading(page)).not.toBeFocused(); await outside(page).focus();
        }
        if (owner === 'blurred') await loading(page).evaluate(node => (node as HTMLElement).blur());
        await release(page, 0, outcome); await expectOutcome(page, outcome);
        if (owner === 'retry') {
          await expect(outcome === 'error' ? retry(page) : heading(page)).toBeFocused();
          await page.screenshot({ path: info.outputPath(`${outcome}.png`), fullPage: true });
        } else if (owner === 'outside') await expect(outside(page)).toBeFocused();
        else expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
        await oldRetry.evaluate(node => (node as HTMLButtonElement).click());
        expect(await readCount(page)).toBe(before + 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });
    }
  }

  for (const name of ['domain', 'cert_pem', 'private_key_pem', 'chain_pem']) {
    test(`Certificates Retry preserves ${name} editing, selection and undo at ${width}px`, async ({ page }) => {
      await open(page, width);
      await panel(page).getByRole('button', { name: 'Upload a certificate', exact: true }).click();
      for (const other of ['domain', 'cert_pem', 'private_key_pem', 'chain_pem']) {
        if (other !== name) await field(page, other).fill(`Synthetic draft ${other}`);
      }
      const oldForm = await form(page).elementHandle();
      const oldInput = await field(page, name).elementHandle();
      const files = await form(page).locator('[data-recued-tls-certs-upload-file]').elementHandles();
      await startRetry(page, key);
      await expect(form(page).getByRole('button', { name: 'Upload certificate', exact: true })).toBeDisabled();
      await field(page, name).focus(); await page.keyboard.type('abc');
      await field(page, name).evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 2, 'forward'));
      await release(page, 0, width === 390 ? 'error' : 'rows');
      await expect(loading(page)).toHaveCount(0);
      await expect(field(page, name)).toBeFocused();
      expect(await oldForm!.evaluate(node => node.isConnected)).toBe(true);
      expect(await oldInput!.evaluate(node => node === document.activeElement)).toBe(true);
      for (const file of files) expect(await file.evaluate(node => node.isConnected)).toBe(true);
      expect(await field(page, name).evaluate(node => {
        const input = node as HTMLInputElement;
        return [input.selectionStart, input.selectionEnd, input.selectionDirection];
      })).toEqual([1, 2, 'forward']);
      await page.keyboard.press('ControlOrMeta+z'); await expect(field(page, name)).toHaveValue('');
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(field(page, name)).toHaveValue('abc');
      for (const other of ['domain', 'cert_pem', 'private_key_pem', 'chain_pem']) {
        if (other !== name) await expect(field(page, other)).toHaveValue(`Synthetic draft ${other}`);
      }
    });
  }

  for (const operation of ['upload', 'removed', 'absent'] as const) {
    test(`Certificates ${operation} stays acknowledged through refresh failure and Retry at ${width}px`, async ({ page }, info) => {
      const before = await open(page, width, 'rows');
      let oldSubmit;
      if (operation === 'upload') {
        await row(page).getByRole('button', { name: 'Replace', exact: true }).click();
        await field(page, 'cert_pem').fill(certPem); await field(page, 'private_key_pem').fill(keyPem);
        await page.evaluate(args => window.__certificateReadRecovery.expectedWrites.push({ method: 'tls_domain.upload', args }),
          { domain: 'scout.example.test', cert_pem: certPem, private_key_pem: keyPem, source: 'byo_upload' });
        const submit = form(page).getByRole('button', { name: 'Upload certificate', exact: true });
        oldSubmit = await submit.elementHandle(); await submit.focus(); await page.keyboard.press(key);
      } else {
        await page.evaluate(removed => {
          window.__certificateReadRecovery.removed = removed;
          window.__certificateReadRecovery.expectedWrites.push({ method: 'tls_domain.remove', args: { domain: 'scout.example.test' } });
        }, operation === 'removed');
        await row(page).getByRole('button', { name: 'Remove', exact: true }).click();
        const submit = row(page).getByRole('button', { name: 'Remove certificate', exact: true });
        oldSubmit = await submit.elementHandle(); await submit.focus(); await page.keyboard.press(key);
      }
      const acknowledgment = panel(page).locator(operation === 'upload' ? '[data-recued-tls-certs-result]' : '[data-recued-tls-certs-removal-result]');
      await expect(loading(page)).toBeVisible(); await expect(acknowledgment).toBeVisible();
      await expect(row(page)).toHaveCount(0); await expect(empty(page)).toHaveCount(0);
      await expect(form(page)).toHaveCount(0);
      await release(page, 0, 'error'); await expectOutcome(page, 'error');
      await expect(panel(page).getByRole('alert')).toContainText('Could not refresh certificates.');
      await expect(acknowledgment).toContainText(operation === 'upload' ? 'Certificate installed.' : operation === 'removed'
        ? 'Certificate removed for scout.example.test.' : 'No certificate is installed for scout.example.test.');
      await expect(row(page)).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('acknowledged-refresh-error.png'), fullPage: true });
      await startRetry(page, key); await expect(acknowledgment).toBeVisible();
      await release(page, 1, operation === 'upload' ? 'rows' : 'empty');
      await expectOutcome(page, operation === 'upload' ? 'rows' : 'empty');
      await expect(heading(page)).toBeFocused(); await expect(acknowledgment).toBeVisible();
      await oldSubmit!.evaluate(node => (node as HTMLButtonElement).click());
      expect(await readCount(page)).toBe(before + 2);
    });
  }

  for (const outcome of ['rows', 'error'] as const) {
    test(`Certificates ignores a disposed Retry ${outcome} after remount at ${width}px`, async ({ page }) => {
      await open(page, width); await startRetry(page, key);
      await page.evaluate(() => { window.__certificateReadRecovery.mode = 'ready'; window.__app.setHash('#yours'); });
      await expect(panel(page)).toHaveCount(0);
      await page.evaluate(() => window.__app.setHash('#settings/server/certificates'));
      await expect(row(page)).toHaveCount(1);
      await panel(page).getByRole('button', { name: 'Upload a certificate', exact: true }).click();
      await field(page, 'domain').focus(); await page.keyboard.type('draft');
      const current = await field(page, 'domain').elementHandle();
      await release(page, 0, outcome); await drain(page);
      expect(await current!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      await expect(field(page, 'domain')).toHaveValue('draft');
      await expect(retry(page)).toHaveCount(0);
    });

    test(`Certificates leaves the selected Server tab focused after Retry ${outcome} at ${width}px`, async ({ page }) => {
      await open(page, width); await startRetry(page, key);
      const connect = page.getByRole('tab', { name: 'Connect a device', exact: true });
      await connect.focus(); await page.keyboard.press('Enter'); await expect(panel(page)).toBeHidden();
      await release(page, 0, outcome); await drain(page);
      await expect(loading(page)).toHaveCount(0);
      await expect(panel(page).locator('[data-recued-tls-certs-read-retry]')).toHaveCount(outcome === 'error' ? 1 : 0);
      await expect(connect).toBeFocused(); await expect(connect).toHaveAttribute('aria-selected', 'true');
    });
  }

  test(`Certificates keeps an in-flight PEM file import through Retry at ${width}px`, async ({ page }) => {
    await open(page, width);
    await panel(page).getByRole('button', { name: 'Upload a certificate', exact: true }).click();
    const file = form(page).locator('[data-recued-tls-certs-upload-file="cert_pem"]');
    const original = await file.elementHandle();
    await startRetry(page, key); await file.focus();
    await file.setInputFiles({ name: 'fixture.pem', mimeType: 'text/plain', buffer: Buffer.from(certPem) });
    await expect(field(page, 'cert_pem')).toHaveValue(certPem);
    await release(page, 0, width === 390 ? 'error' : 'rows'); await expect(loading(page)).toHaveCount(0);
    expect(await original!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    await expect(field(page, 'cert_pem')).toHaveValue(certPem);
  });
}
