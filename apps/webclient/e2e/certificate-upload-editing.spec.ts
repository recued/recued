import { expect, test, type Locator, type Page } from '@playwright/test';
import { HARNESS_URL } from './helpers/full-app.js';

type Field = 'domain' | 'cert_pem' | 'private_key_pem' | 'chain_pem';
interface CertificateEditingFixture {
  uploads: unknown[];
  removals: unknown[];
  expectedUploads: number;
  expectedRemovals: number;
}
declare global { interface Window { __certificateEditing: CertificateEditingFixture } }
const fields: Field[] = ['domain', 'cert_pem', 'private_key_pem', 'chain_pem'];
const panel = (page: Page) => page.locator('[data-recued-tls-certs-panel]');
const control = (page: Page, field: Field) => panel(page).locator(`[data-recued-tls-certs-upload-field="${field}"]`);
const picker = (page: Page, field: Field) => panel(page).locator(`[data-recued-tls-certs-upload-file="${field}"]`);
const form = (page: Page) => panel(page).locator('[data-recued-tls-certs-upload-form]');
const drafts: Record<Field, string> = {
  domain: 'server.example.test',
  cert_pem: 'SYNTHETIC CERTIFICATE\nfixture only',
  private_key_pem: 'SYNTHETIC PRIVATE KEY\nfixture only',
  chain_pem: 'SYNTHETIC ISSUER CHAIN\nfixture only',
};
let errors: string[] = [];
let externalRequests: string[] = [];

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
  const fixture = await page.evaluate(() => window.__certificateEditing);
  expect(fixture.removals).toHaveLength(fixture.expectedRemovals);
  expect(fixture.uploads).toHaveLength(fixture.expectedUploads);
});

const open = async (page: Page, width: number, refusal: 'issues' | 'error' = 'error') => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(refusal => {
    const fixture: CertificateEditingFixture = { uploads: [], removals: [], expectedUploads: 0, expectedRemovals: 0 };
    Object.assign(window, {
      __certificateEditing: fixture,
      __connectionsFixture: async (method: string, args: unknown) => {
        if (method === 'tls_domain.list') return { result: { entries: [] } };
        if (method === 'tls_domain.upload') {
          fixture.uploads.push(args);
          return { error: { code: 'INVALID_ARGUMENT', message: 'Synthetic certificate refused.',
            ...(refusal === 'issues' ? { details: { issues: [{ code: 'tls_san_mismatch' }, { code: 'tls_chain_invalid' }] } } : {}) } };
        }
        if (method === 'tls_domain.remove') {
          fixture.removals.push(args);
          return { error: { code: 'FORBIDDEN', message: 'Unexpected removal in local fixture.' } };
        }
        return undefined;
      },
    });
    window.__app.setHash('#settings/server/certificates');
  }, refusal);
  const button = panel(page).getByRole('button', { name: 'Upload a certificate', exact: true });
  await expect(button).toBeVisible();
  await button.click();
  await expect(form(page)).toBeVisible();
};
const selection = (input: Locator) => input.evaluate(input => {
  const field = input as HTMLInputElement | HTMLTextAreaElement;
  return { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection };
});
const select = (input: Locator, start: number, end: number) => input.evaluate((input, range) => {
  (input as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(range.start, range.end, 'forward');
}, { start, end });

for (const width of [390]) {
  for (const field of fields) {
    test(`Certificates ${field} keeps typing, selection, undo and keyboard traversal at ${width}px`, async ({ page, browserName }) => {
      await open(page, width);
      const input = control(page, field);
      const original = await input.elementHandle();
      const originalForm = await form(page).elementHandle();
      // Test a fresh undo group: browsers group a later selection replacement
      // with the original typing differently, even in an ordinary input.
      await input.click();
      await page.keyboard.type('abc');
      await expect(input).toHaveValue('abc');
      await expect(input).toBeFocused();
      await page.keyboard.press('ControlOrMeta+z');
      await expect(input).toHaveValue('');
      await expect(input).toBeFocused();
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect(input).toHaveValue('abc');
      await expect(input).toBeFocused();
      await input.fill('');
      for (const sibling of fields.filter(sibling => sibling !== field)) await control(page, sibling).fill(drafts[sibling]);
      await input.click();
      await page.keyboard.type(drafts[field]);
      await expect(input).toHaveValue(drafts[field]);
      await expect(input).toBeFocused();
      expect(await selection(input)).toMatchObject({ start: drafts[field].length, end: drafts[field].length });

      await select(input, 2, 5);
      await page.keyboard.type('X');
      const edited = drafts[field].slice(0, 2) + 'X' + drafts[field].slice(5);
      await expect(input).toHaveValue(edited);
      await expect(input).toBeFocused();
      expect(await selection(input)).toMatchObject({ start: 3, end: 3 });
      expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      expect(await originalForm!.evaluate(node => node.isConnected)).toBe(true);
      for (const sibling of fields.filter(sibling => sibling !== field)) await expect(control(page, sibling)).toHaveValue(drafts[sibling]);

      // WebKit's full keyboard navigation includes the native file picker.
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(field === 'domain' ? control(page, 'cert_pem') : picker(page, field)).toBeFocused();
    });
  }

  for (const field of ['cert_pem', 'private_key_pem', 'chain_pem'] as const) {
    test(`Certificates ${field} file import preserves the other field's selection at ${width}px`, async ({ page }) => {
      await open(page, width);
      for (const sibling of fields) await control(page, sibling).fill(drafts[sibling]);
      const hostname = control(page, 'domain');
      const original = await control(page, field).elementHandle();
      const originalPicker = await picker(page, field).elementHandle();
      await hostname.click();
      await select(hostname, 2, 5);
      const before = await selection(hostname);
      const imported = 'SYNTHETIC FILE CONTENT\nfixture only';
      await picker(page, field).setInputFiles({ name: 'fixture.pem', mimeType: 'text/plain', buffer: Buffer.from(imported) });
      await expect(control(page, field)).toHaveValue(imported);
      await expect(hostname).toBeFocused();
      expect(await selection(hostname)).toEqual(before);
      expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      expect(await originalPicker!.evaluate(node => node.isConnected)).toBe(true);
      for (const sibling of fields.filter(sibling => sibling !== field)) await expect(control(page, sibling)).toHaveValue(drafts[sibling]);
      await page.keyboard.type('X');
      await expect(hostname).toHaveValue(drafts.domain.slice(0, 2) + 'X' + drafts.domain.slice(5));
      await expect(hostname).toBeFocused();
    });
  }

  for (const field of fields) {
    test(`Certificates local validation links ${field}, focuses it and preserves correction at ${width}px`, async ({ page, browserName }) => {
      await open(page, width);
      const pem = '-----BEGIN CERTIFICATE-----\nSYNTHETIC\n-----END CERTIFICATE-----';
      const key = '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----';
      const valid: Record<Field, string> = { domain: drafts.domain, cert_pem: pem, private_key_pem: key, chain_pem: pem };
      const labels: Record<Field, string> = { domain: 'Hostname', cert_pem: 'Certificate (PEM)', private_key_pem: 'Private key (PEM)', chain_pem: 'Issuer chain (PEM, optional)' };
      for (const name of fields) await control(page, name).fill(name === field ? (name === 'chain_pem' ? 'invalid chain' : '') : valid[name]);
      const input = control(page, field), helpId = `tls-validation-help-${width}-${field}`;
      await input.evaluate((input, id) => {
        const help = document.createElement('p'); help.id = id; help.textContent = 'Synthetic field help.';
        input.parentElement!.parentElement!.appendChild(help); input.setAttribute('aria-describedby', id);
      }, helpId);
      const originalForm = await form(page).elementHandle();
      const originals = await Promise.all(fields.map(name => control(page, name).elementHandle()));
      for (const name of fields) await expect(control(page, name)).not.toHaveAttribute('aria-invalid');
      const submit = panel(page).getByRole('button', { name: 'Upload certificate', exact: true });
      await submit.focus(); await submit.press('Enter');
      const error = panel(page).locator('[data-recued-tls-certs-error]');
      await expect(error).toBeVisible(); await expect(input).toBeFocused();
      const id = await error.getAttribute('id'); expect(id).toBeTruthy();
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await expect(input).toHaveAttribute('aria-describedby', `${helpId} ${id}`);
      await expect(input).toHaveAccessibleName(labels[field]);
      await expect(input).toHaveAccessibleDescription(`Synthetic field help. ${await error.innerText()}`);
      expect(await input.evaluate((input, id) => input.parentElement!.parentElement!.contains(document.getElementById(id!)) && !input.parentElement!.contains(document.getElementById(id!)), id)).toBe(true);
      for (const name of fields.filter(name => name !== field)) await expect(control(page, name)).not.toHaveAttribute('aria-invalid');
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(field === 'domain' ? control(page, 'cert_pem') : picker(page, field)).toBeFocused();
      await submit.focus(); await submit.press('Enter');
      await expect(error).toHaveAttribute('id', id!);
      await expect(input).toHaveAttribute('aria-describedby', `${helpId} ${id}`);
      await expect(input).toBeFocused();
      const before = await input.inputValue(), range = await selection(input);
      await page.keyboard.type('X');
      const edited = before.slice(0, range.start!) + 'X' + before.slice(range.end!);
      await expect(input).toHaveValue(edited); await expect(input).toBeFocused();
      await expect(input).not.toHaveAttribute('aria-invalid');
      await expect(input).toHaveAttribute('aria-describedby', helpId); await expect(error).toHaveCount(0);
      // The browser may include the fixture fill in its native undo group.
      await page.keyboard.press('ControlOrMeta+z'); expect(await input.inputValue()).not.toBe(edited);
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(input).toHaveValue(edited);
      await expect(error).toHaveCount(0);
      await input.fill(field === 'chain_pem' ? 'invalid chain' : '');
      await submit.focus(); await submit.press('Enter'); await expect(input).toHaveAttribute('aria-invalid', 'true');
      if (field === 'domain') await input.fill(valid[field]);
      else {
        const hostname = control(page, 'domain'); await hostname.focus(); await select(hostname, 2, 5);
        const selected = await selection(hostname);
        await picker(page, field).setInputFiles({ name: 'fixture.pem', mimeType: 'text/plain', buffer: Buffer.from(valid[field]) });
        await expect(input).toHaveValue(valid[field]); await expect(hostname).toBeFocused();
        expect(await selection(hostname)).toEqual(selected);
        await expect(picker(page, field)).toHaveAccessibleName(`Choose file: ${labels[field]}`);
      }
      await expect(input).not.toHaveAttribute('aria-invalid'); await expect(input).toHaveAttribute('aria-describedby', helpId);
      await expect(error).toHaveCount(0);
      for (const node of originals) expect(await node!.evaluate(node => node.isConnected)).toBe(true);
      expect(await originalForm!.evaluate(node => node.isConnected)).toBe(true);
      await page.evaluate(() => { window.__certificateEditing.expectedUploads = 1; });
      await submit.focus(); await submit.press('Enter'); await expect(error).toContainText('Synthetic certificate refused.');
      for (const name of fields) await expect(control(page, name)).not.toHaveAttribute('aria-invalid');
      await expect(input).toHaveAttribute('aria-describedby', helpId);
      await expect(input).toHaveAccessibleDescription('Synthetic field help.');
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(await originalForm!.evaluate(node => node.isConnected)).toBe(false);
      await expect(page.locator(`[id="${id}"]`)).toHaveCount(0);
      await panel(page).getByRole('button', { name: 'Upload a certificate', exact: true }).click();
      await expect(control(page, field)).not.toHaveAttribute('aria-invalid');
      await expect(control(page, field)).not.toHaveAttribute('aria-describedby');
      await expect(panel(page).locator('[data-recued-tls-certs-error]')).toHaveCount(0);
    });
  }

  for (const refusal of ['local', 'issues', 'error'] as const) {
    test(`Certificates correction clears ${refusal} feedback while keeping the draft editable at ${width}px`, async ({ page }) => {
      await open(page, width, refusal === 'issues' ? 'issues' : 'error');
      if (refusal !== 'local') {
        await control(page, 'domain').fill(drafts.domain);
        await control(page, 'cert_pem').fill('-----BEGIN CERTIFICATE-----\nSYNTHETIC\n-----END CERTIFICATE-----');
        await control(page, 'private_key_pem').fill('-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----');
        await page.evaluate(() => { window.__certificateEditing.expectedUploads = 1; });
      }
      await panel(page).getByRole('button', { name: 'Upload certificate', exact: true }).click();
      const feedback = panel(page).locator(refusal === 'issues' ? '[data-recued-tls-certs-issue]' : '[data-recued-tls-certs-error]');
      await expect(feedback).toHaveCount(refusal === 'issues' ? 2 : 1);
      const input = control(page, 'domain');
      const original = await input.elementHandle();
      const preserved = await control(page, 'private_key_pem').inputValue();
      await input.click();
      await select(input, 0, (await input.inputValue()).length);
      await page.keyboard.type('edited.example.test');
      await expect(input).toHaveValue('edited.example.test');
      await expect(input).toBeFocused();
      await expect(panel(page).locator('[data-recued-tls-certs-issue], [data-recued-tls-certs-error]')).toHaveCount(0);
      await expect(control(page, 'private_key_pem')).toHaveValue(preserved);
      expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      if (refusal !== 'local') {
        const uploads = await page.evaluate(() => window.__certificateEditing.uploads);
        expect(uploads).toEqual([{ domain: drafts.domain,
          cert_pem: '-----BEGIN CERTIFICATE-----\nSYNTHETIC\n-----END CERTIFICATE-----',
          private_key_pem: preserved, source: 'byo_upload' }]);
      }
    });
  }
}

interface CertificateNavigationFixture {
  reads: number;
  installed: boolean;
  failRead: boolean;
  failUpload: boolean;
  uploadIssues?: boolean;
  failRemove: boolean;
}
declare global { interface Window { __certificateNavigation: CertificateNavigationFixture } }
const certDraftPrompt = 'Discard the unsaved certificate upload?';
const certWorkPrompt = 'A certificate change is still in progress. Leave Settings anyway?';
const certNavUnload = (page: Page) => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
});
const certNavLeave = (page: Page) => page.evaluate(() => window.__app.setHash('#yours/assets'));
const certNavUpload = (page: Page) => form(page).getByRole('button', { name: 'Upload certificate', exact: true });
const certNavLoading = (page: Page) => panel(page).locator('[data-recued-tls-certs-status]');
const certNavOpen = async (page: Page, width: number, seed = false, openForm = true, holdRead = false, readError = false) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ seed, readError }) => {
    const fixture: CertificateEditingFixture = { uploads: [], removals: [], expectedUploads: 0, expectedRemovals: 0 };
    const nav: CertificateNavigationFixture = { reads: 0, installed: seed, failRead: readError, failUpload: false, failRemove: false };
    Object.assign(window, {
      __certificateEditing: fixture, __certificateNavigation: nav,
      __connectionsFixture: async (method: string, args: unknown) => {
        if (method === 'tls_domain.list') {
          nav.reads++;
          if (nav.failRead) return { error: { code: 'UNAVAILABLE', message: 'Synthetic inventory unavailable.' } };
          return { result: { entries: nav.installed ? [{ domain: 'server.example.test', source: 'byo_upload', issuer: 'Synthetic CA', fingerprint: 'ab'.repeat(32), expires_at: Date.now() + 90 * 86400000 }] : [] } };
        }
        if (method === 'tls_domain.upload') {
          fixture.uploads.push(args);
          if (nav.failUpload) return { error: { code: nav.uploadIssues ? 'INVALID_ARGUMENT' : 'UNAVAILABLE', message: 'Synthetic upload failed.',
            ...(nav.uploadIssues ? { details: { issues: [{ code: 'tls_san_mismatch' }, { code: 'tls_chain_invalid' }] } } : {}) } };
          nav.installed = true;
          return { result: { fingerprint: 'cd'.repeat(32), expires_at: Date.now() + 90 * 86400000, san: ['server.example.test'] } };
        }
        if (method === 'tls_domain.remove') {
          fixture.removals.push(args);
          if (nav.failRemove) return { error: { code: 'UNAVAILABLE', message: 'Synthetic removal failed.' } };
          nav.installed = false; return { result: { removed: true } };
        }
        return undefined;
      },
    });
  }, { seed, readError });
  await page.goto(`${HARNESS_URL}?settle_reads=1&notifications=ready&yours=demo${holdRead ? '&hold_rpc=tls_domain.list' : ''}#settings/server/certificates`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (!holdRead) await expect(certNavLoading(page)).toHaveCount(0);
  if (openForm) {
    await panel(page).getByRole('button', { name: seed ? 'Replace' : 'Upload a certificate', exact: true }).click();
    await expect(form(page)).toBeVisible();
  }
};
const certNavFill = async (page: Page) => {
  await control(page, 'domain').fill(drafts.domain);
  await control(page, 'cert_pem').fill('-----BEGIN CERTIFICATE-----\nSYNTHETIC\n-----END CERTIFICATE-----');
  await control(page, 'private_key_pem').fill('-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----');
};
const certNavStartUpload = async (page: Page, fail = false) => {
  await page.evaluate(fail => {
    window.__certificateEditing.expectedUploads++; window.__certificateNavigation.failUpload = fail;
    window.__app.holdRpcResponses?.('tls_domain.upload');
  }, fail);
  await certNavUpload(page).press('Enter'); await expect(form(page).getByRole('button', { name: 'Uploading…', exact: true })).toBeDisabled();
};
const certNavBeginUpload = async (page: Page, fail = false) => {
  await certNavFill(page); await certNavStartUpload(page, fail);
};

for (const width of [390]) {
  for (const name of fields) {
    test(`Certificates navigation preserves every draft ${name} when departure is canceled at ${width}px`, async ({ page }) => {
      await certNavOpen(page, width); await control(page, name).focus(); await page.keyboard.type(drafts[name]);
      // Multiline typing can create several native undo groups. Capture the
      // browser's result before navigation so cancellation must preserve it.
      await page.keyboard.press('ControlOrMeta+z');
      const undone = await control(page, name).inputValue();
      expect(undone).not.toBe(drafts[name]);
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(control(page, name)).toHaveValue(drafts[name]);
      await control(page, name).evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 5, 'backward'));
      const original = await control(page, name).elementHandle(), originalForm = await form(page).elementHandle(), files = await form(page).locator('[data-recued-tls-certs-upload-file]').elementHandles();
      const dialogs: string[] = []; let accept = false;
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
      expect(await certNavUnload(page)).toBe(true); await certNavLeave(page); await expect.poll(() => dialogs).toEqual([certDraftPrompt]);
      await expect(control(page, name)).toHaveValue(drafts[name]); await expect(control(page, name)).toBeFocused();
      expect(await control(page, name).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([2, 5, 'backward']);
      expect(await original!.evaluate(input => input.isConnected && input === document.activeElement)).toBe(true);
      expect(await originalForm!.evaluate(node => node.isConnected)).toBe(true);
      for (const file of files) expect(await file.evaluate(node => node.isConnected)).toBe(true);
      await page.keyboard.press('ControlOrMeta+z'); await expect(control(page, name)).toHaveValue(undone);
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(control(page, name)).toHaveValue(drafts[name]);
      accept = true; await certNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
      await page.evaluate(() => window.__app.setHash('#settings/server/certificates'));
      await panel(page).getByRole('button', { name: 'Upload a certificate', exact: true }).click();
      for (const field of fields) await expect(control(page, field)).toHaveValue('');
      expect(dialogs).toEqual([certDraftPrompt, certDraftPrompt]);
    });
  }

  test(`Certificates navigation protects canceled and accepted native reloads at ${width}px`, async ({ page }) => {
    await certNavOpen(page, width); for (const name of fields) await control(page, name).fill(drafts[name]);
    const original = await form(page).elementHandle(), dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.type()); void (accept ? dialog.accept() : dialog.dismiss()); });
    await page.evaluate(() => { location.reload(); }); await expect.poll(() => dialogs).toEqual(['beforeunload']);
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    for (const name of fields) await expect(control(page, name)).toHaveValue(drafts[name]);
    accept = true; await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await panel(page).getByRole('button', { name: 'Upload a certificate', exact: true }).click();
    for (const name of fields) await expect(control(page, name)).toHaveValue('');
    expect(dialogs).toEqual(['beforeunload', 'beforeunload']);
  });

  for (const name of ['cert_pem', 'private_key_pem', 'chain_pem'] as const) {
    test(`Certificates navigation preserves a selected ${name} file until it is cleared at ${width}px`, async ({ page }) => {
      await certNavOpen(page, width); await picker(page, name).setInputFiles({ name: 'empty-fixture.pem', mimeType: 'text/plain', buffer: Buffer.from('') });
      await expect(control(page, name)).toHaveValue(''); expect(await certNavUnload(page)).toBe(true);
      const original = await picker(page, name).elementHandle(), dialogs: string[] = [];
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await certNavLeave(page); await expect.poll(() => dialogs).toEqual([certDraftPrompt]);
      expect(await original!.evaluate(node => node.isConnected && (node as HTMLInputElement).files?.[0]?.name === 'empty-fixture.pem')).toBe(true);
      await picker(page, name).setInputFiles([]); expect(await certNavUnload(page)).toBe(false);
      await certNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([certDraftPrompt]);
    });
  }

  for (const seeded of [false, true]) {
    test(`Certificates navigation leaves untouched and restored ${seeded ? 'replacement' : 'new'} forms clean at ${width}px`, async ({ page }) => {
      await certNavOpen(page, width, seeded); expect(await certNavUnload(page)).toBe(false);
      for (const name of fields) {
        const seed = await control(page, name).inputValue(); await control(page, name).fill(`${seed} `); expect(await certNavUnload(page)).toBe(true);
        await control(page, name).fill(seed); expect(await certNavUnload(page)).toBe(false);
      }
      await control(page, 'cert_pem').fill(drafts.cert_pem); expect(await certNavUnload(page)).toBe(true);
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click(); expect(await certNavUnload(page)).toBe(false);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await certNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([]);
    });
  }

  for (const failure of ['local', 'server'] as const) {
    test(`Certificates navigation keeps a ${failure} upload failure guarded until restored at ${width}px`, async ({ page }) => {
      await certNavOpen(page, width);
      if (failure === 'local') await control(page, 'domain').fill(drafts.domain);
      else {
        await certNavFill(page); await page.evaluate(() => { window.__certificateEditing.expectedUploads++; window.__certificateNavigation.failUpload = true; });
      }
      await certNavUpload(page).click(); await expect(form(page).getByRole('alert')).toBeVisible(); expect(await certNavUnload(page)).toBe(true);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await certNavLeave(page); await expect.poll(() => dialogs).toEqual([certDraftPrompt]);
      for (const name of fields) await control(page, name).fill(''); expect(await certNavUnload(page)).toBe(false);
      await certNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([certDraftPrompt]);
    });
  }

  for (const outcome of ['success', 'error'] as const) {
    test(`Certificates navigation guards a pending upload through ${outcome} at ${width}px`, async ({ page }) => {
      await certNavOpen(page, width); await certNavBeginUpload(page, outcome === 'error'); expect(await certNavUnload(page)).toBe(true);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.type() === 'beforeunload' ? 'beforeunload' : dialog.message()); void dialog.dismiss(); });
      await certNavLeave(page); await expect.poll(() => dialogs).toEqual([certWorkPrompt]);
      await page.evaluate(() => { location.reload(); }); await expect.poll(() => dialogs).toEqual([certWorkPrompt, 'beforeunload']);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('tls_domain.upload'))).toBe(1);
      if (outcome === 'success') { await expect(form(page)).toHaveCount(0); await expect(panel(page).locator('[data-recued-tls-certs-result]')).toBeVisible(); }
      else {
        await expect(form(page).getByRole('alert')).toContainText('Synthetic upload failed.'); await certNavLeave(page);
        await expect.poll(() => dialogs).toEqual([certWorkPrompt, 'beforeunload', certDraftPrompt]);
        await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      }
      expect(await certNavUnload(page)).toBe(false); await certNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
      expect(await page.evaluate(() => window.__certificateEditing.uploads)).toHaveLength(1);
    });

    test(`Certificates navigation ignores a late upload ${outcome} after accepted departure at ${width}px`, async ({ page }) => {
      await certNavOpen(page, width); await certNavBeginUpload(page, outcome === 'error');
      const dialogs: string[] = []; let accept = true;
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
      await certNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([certWorkPrompt]);
      await page.evaluate(() => window.__app.setHash('#settings/server/certificates'));
      await panel(page).getByRole('button', { name: 'Upload a certificate', exact: true }).click();
      await control(page, 'domain').fill('fresh.example.test'); await control(page, 'domain').evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 6, 'backward'));
      const fresh = await control(page, 'domain').elementHandle();
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('tls_domain.upload'))).toBe(1);
      await expect(control(page, 'domain')).toHaveValue('fresh.example.test'); await expect(control(page, 'domain')).toBeFocused();
      expect(await fresh!.evaluate(input => input.isConnected && input === document.activeElement)).toBe(true);
      expect(await control(page, 'domain').evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([2, 6, 'backward']);
      await expect(form(page).getByRole('alert')).toHaveCount(0); accept = false; await certNavLeave(page);
      await expect.poll(() => dialogs).toEqual([certWorkPrompt, certDraftPrompt]);
    });

    test(`Certificates navigation guards a pending removal through ${outcome} at ${width}px`, async ({ page }) => {
      await certNavOpen(page, width, true, false);
      await panel(page).getByRole('button', { name: 'Remove', exact: true }).click(); expect(await certNavUnload(page)).toBe(false);
      await page.evaluate(fail => { window.__certificateEditing.expectedRemovals++; window.__certificateNavigation.failRemove = fail; window.__app.holdRpcResponses?.('tls_domain.remove'); }, outcome === 'error');
      await panel(page).getByRole('button', { name: 'Remove certificate', exact: true }).click(); expect(await certNavUnload(page)).toBe(true);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await certNavLeave(page); await expect.poll(() => dialogs).toEqual([certWorkPrompt]);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('tls_domain.remove'))).toBe(1);
      await expect(panel(page).getByRole('button', { name: 'Removing…', exact: true })).toHaveCount(0); expect(await certNavUnload(page)).toBe(false);
      await certNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([certWorkPrompt]);
      expect(await page.evaluate(() => window.__certificateEditing.removals)).toEqual([{ domain: drafts.domain }]);
    });
  }

  test(`Certificates navigation leaves untouched inventory reads and retires their late replies at ${width}px`, async ({ page }) => {
    await certNavOpen(page, width, false, false, true); await expect(certNavLoading(page)).toBeVisible(); expect(await certNavUnload(page)).toBe(false);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await certNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    const count = await page.evaluate(() => window.__certificateNavigation.reads); expect(count).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('tls_domain.list'))).toBe(count);
    await expect(panel(page)).toHaveCount(0); expect(dialogs).toEqual([]);
  });

  test(`Certificates navigation retains Back and Forward through repeated draft cancellation at ${width}px`, async ({ page }) => {
    await certNavOpen(page, width); await certNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#settings/server/certificates'));
    await panel(page).getByRole('button', { name: 'Upload a certificate', exact: true }).click(); await control(page, 'domain').fill(drafts.domain);
    const original = await form(page).elementHandle(), dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.goBack(); await expect.poll(() => dialogs).toHaveLength(attempt); await expect(page).toHaveURL(/#settings\/server\/certificates$/u);
      expect(await original!.evaluate(node => node.isConnected)).toBe(true); await expect(control(page, 'domain')).toHaveValue(drafts.domain);
    }
    accept = true; await page.goBack(); await expect(page.locator('[data-recued-yours]')).toBeVisible(); await page.goForward();
    await panel(page).getByRole('button', { name: 'Upload a certificate', exact: true }).click(); await expect(control(page, 'domain')).toHaveValue('');
    expect(dialogs).toEqual([certDraftPrompt, certDraftPrompt, certDraftPrompt]);
  });

  test(`Certificates navigation keeps drafts guarded through an inventory Retry at ${width}px`, async ({ page }) => {
    await certNavOpen(page, width, false, true, false, true); await control(page, 'private_key_pem').fill(drafts.private_key_pem);
    const original = await form(page).elementHandle();
    await page.evaluate(() => { window.__certificateNavigation.failRead = false; window.__app.holdRpcResponses?.('tls_domain.list'); });
    await panel(page).getByRole('button', { name: 'Retry loading certificates', exact: true }).click();
    await expect(certNavLoading(page)).toBeVisible(); expect(await certNavUnload(page)).toBe(true);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('tls_domain.list'))).toBe(1);
    await expect(certNavLoading(page)).toHaveCount(0); expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    await expect(control(page, 'private_key_pem')).toHaveValue(drafts.private_key_pem); expect(await certNavUnload(page)).toBe(true);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await certNavLeave(page); await expect.poll(() => dialogs).toEqual([certDraftPrompt]);
  });
}

interface CertificateFileReadsFixture {
  pending: number;
  release(index: number): Promise<void>;
}
declare global { interface Window { __certificateFileReads: CertificateFileReadsFixture } }
// Hold the start of a real browser file read so every race is deterministic.
const holdCertificateFiles = (page: Page) => page.evaluate(() => {
  const NativeReader = window.FileReader;
  const reads: Array<(() => Promise<void>) | null> = [];
  window.FileReader = class extends NativeReader {
    override readAsText(file: Blob, encoding?: string): void {
      reads.push(() => new Promise<void>(resolve => {
        this.addEventListener('loadend', () => resolve(), { once: true });
        super.readAsText(file, encoding);
      }));
    }
  };
  window.__certificateFileReads = {
    get pending() { return reads.filter(read => read !== null).length; },
    release: async index => {
      const read = reads[index];
      if (!read) throw new Error(`No held certificate read at ${index}`);
      reads[index] = null;
      await read();
    },
  };
});
const pickCertificateFile = (page: Page, field: Field, text: string, name = 'fixture.pem') =>
  picker(page, field).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
const releaseCertificateFile = (page: Page, index: number) => page.evaluate(index => window.__certificateFileReads.release(index), index);

for (const width of [390]) {
  for (const name of ['cert_pem', 'private_key_pem', 'chain_pem'] as const) {
    test(`Certificates file lifecycle retires a canceled ${name} import before a new draft at ${width}px`, async ({ page }) => {
      await certNavOpen(page, width); await holdCertificateFiles(page);
      await pickCertificateFile(page, name, 'OLD SYNTHETIC FILE'); expect(await certNavUnload(page)).toBe(true);
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click(); expect(await certNavUnload(page)).toBe(false);
      await panel(page).getByRole('button', { name: 'Upload a certificate', exact: true }).click();
      await control(page, name).fill('fresh draft'); await control(page, name).evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(2, 5, 'backward'));
      const original = await control(page, name).elementHandle();
      await releaseCertificateFile(page, 0);
      await expect(control(page, name)).toHaveValue('fresh draft'); await expect(control(page, name)).toBeFocused();
      expect(await selection(control(page, name))).toEqual({ start: 2, end: 5, direction: 'backward' });
      expect(await original!.evaluate(node => node.isConnected)).toBe(true); expect(await certNavUnload(page)).toBe(true);
    });
  }

  test(`Certificates file lifecycle keeps the latest choice when reads finish out of order at ${width}px`, async ({ page }) => {
    await certNavOpen(page, width); await holdCertificateFiles(page);
    await pickCertificateFile(page, 'private_key_pem', 'OLD SYNTHETIC KEY', 'old.pem');
    await pickCertificateFile(page, 'private_key_pem', 'NEW SYNTHETIC KEY', 'new.pem');
    expect(await page.evaluate(() => window.__certificateFileReads.pending)).toBe(2);
    await releaseCertificateFile(page, 1); await expect(control(page, 'private_key_pem')).toHaveValue('NEW SYNTHETIC KEY');
    await releaseCertificateFile(page, 0); await expect(control(page, 'private_key_pem')).toHaveValue('NEW SYNTHETIC KEY');
    expect(await picker(page, 'private_key_pem').evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('new.pem');
  });

  test(`Certificates file lifecycle keeps a cleared picker clean after its delayed read at ${width}px`, async ({ page }) => {
    await certNavOpen(page, width); await holdCertificateFiles(page);
    await pickCertificateFile(page, 'private_key_pem', 'OLD SYNTHETIC KEY'); expect(await certNavUnload(page)).toBe(true);
    await picker(page, 'private_key_pem').setInputFiles([]); expect(await certNavUnload(page)).toBe(false);
    await releaseCertificateFile(page, 0); await expect(control(page, 'private_key_pem')).toHaveValue(''); expect(await certNavUnload(page)).toBe(false);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await certNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([]);
  });

  test(`Certificates file lifecycle keeps newer native edits through a delayed import at ${width}px`, async ({ page }) => {
    await certNavOpen(page, width); await holdCertificateFiles(page);
    await pickCertificateFile(page, 'private_key_pem', 'OLD SYNTHETIC KEY');
    await control(page, 'private_key_pem').focus(); await page.keyboard.type('abc');
    await control(page, 'private_key_pem').evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(1, 2, 'backward'));
    await releaseCertificateFile(page, 0); await expect(control(page, 'private_key_pem')).toHaveValue('abc');
    await expect(control(page, 'private_key_pem')).toBeFocused(); expect(await selection(control(page, 'private_key_pem'))).toEqual({ start: 1, end: 2, direction: 'backward' });
    await page.keyboard.press('ControlOrMeta+z'); await expect(control(page, 'private_key_pem')).toHaveValue('');
    await picker(page, 'private_key_pem').setInputFiles([]); expect(await certNavUnload(page)).toBe(false);
  });

  test(`Certificates file lifecycle allows the current read after canceled navigation at ${width}px`, async ({ page }) => {
    await certNavOpen(page, width); await holdCertificateFiles(page);
    await pickCertificateFile(page, 'private_key_pem', 'CURRENT SYNTHETIC KEY');
    await control(page, 'domain').fill(drafts.domain); await control(page, 'domain').evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 5, 'backward'));
    const original = await picker(page, 'private_key_pem').elementHandle(), dialogs: string[] = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await certNavLeave(page); await expect.poll(() => dialogs).toEqual([certDraftPrompt]);
    await releaseCertificateFile(page, 0); await expect(control(page, 'private_key_pem')).toHaveValue('CURRENT SYNTHETIC KEY');
    await expect(control(page, 'domain')).toBeFocused(); expect(await selection(control(page, 'domain'))).toEqual({ start: 2, end: 5, direction: 'backward' });
    expect(await original!.evaluate(node => node.isConnected)).toBe(true); expect(await certNavUnload(page)).toBe(true);
  });

  test(`Certificates file lifecycle ignores a read after accepted route departure at ${width}px`, async ({ page }) => {
    await certNavOpen(page, width); await holdCertificateFiles(page); await pickCertificateFile(page, 'private_key_pem', 'OLD SYNTHETIC KEY');
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
    await certNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#settings/server/certificates'));
    await panel(page).getByRole('button', { name: 'Upload a certificate', exact: true }).click();
    await control(page, 'private_key_pem').fill('fresh key'); await releaseCertificateFile(page, 0);
    await expect(control(page, 'private_key_pem')).toHaveValue('fresh key'); expect(dialogs).toEqual([certDraftPrompt]);
  });

  test(`Certificates file lifecycle preserves selected empty files through validation at ${width}px`, async ({ page }) => {
    await certNavOpen(page, width); await pickCertificateFile(page, 'private_key_pem', '', 'empty-fixture.pem');
    const original = await picker(page, 'private_key_pem').elementHandle(), originalForm = await form(page).elementHandle();
    expect(await certNavUnload(page)).toBe(true); await certNavUpload(page).click(); await expect(form(page).getByRole('alert')).toBeVisible();
    expect(await original!.evaluate(node => node.isConnected)).toBe(true); expect(await originalForm!.evaluate(node => node.isConnected)).toBe(true);
    expect(await picker(page, 'private_key_pem').evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('empty-fixture.pem');
    expect(await certNavUnload(page)).toBe(true);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await certNavLeave(page); await expect.poll(() => dialogs).toEqual([certDraftPrompt]);
    await picker(page, 'private_key_pem').setInputFiles([]); expect(await certNavUnload(page)).toBe(false);
  });
}

const certDraftStatus = (page: Page) => panel(page).locator('[data-recued-tls-certs-upload-draft-status]');
for (const width of [390]) {
  for (const field of fields) {
    test(`Certificates pending upload keeps newer ${field} text, selection, undo and navigation guard at ${width}px`, async ({ page }) => {
      await certNavOpen(page, width); await certNavBeginUpload(page);
      const input = control(page, field), original = await input.elementHandle(), originalForm = await form(page).elementHandle();
      await input.fill(field === 'domain' ? 'newer.example.test' : `SYNTHETIC NEWER ${field}`); await page.keyboard.type('X');
      const edited = await input.inputValue();
      await page.keyboard.press('ControlOrMeta+z'); const undone = await input.inputValue(); expect(undone).not.toBe(edited);
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(input).toHaveValue(edited);
      await select(input, 2, 5); const selected = await selection(input);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('tls_domain.upload'))).toBe(1);
      await expect(certDraftStatus(page)).toContainText(`Certificate installed for ${drafts.domain}.`);
      await expect(certDraftStatus(page)).toContainText('Your newer edits still need uploading.');
      await expect(certNavLoading(page)).toHaveCount(0); await expect(certNavUpload(page)).toBeEnabled();
      await expect(input).toHaveValue(edited); await expect(input).toBeFocused(); expect(await selection(input)).toEqual(selected);
      expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      expect(await originalForm!.evaluate(node => node.isConnected)).toBe(true);
      await page.keyboard.press('ControlOrMeta+z'); await expect(input).toHaveValue(undone);
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(input).toHaveValue(edited);
      expect(await certNavUnload(page)).toBe(true);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await certNavLeave(page); await expect.poll(() => dialogs).toEqual([certDraftPrompt]);
      await expect(input).toHaveValue(edited); await expect(input).toBeFocused();
      const uploads = await page.evaluate(() => window.__certificateEditing.uploads);
      expect(uploads).toHaveLength(1); expect(uploads[0]).toMatchObject({ domain: drafts.domain, source: 'byo_upload' });
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(form(page)).toHaveCount(0); expect(await certNavUnload(page)).toBe(false);
    });
  }

  for (const refusal of ['generic', 'issues'] as const) {
    test(`Certificates pending upload qualifies the earlier ${refusal} failure without blaming newer edits at ${width}px`, async ({ page }) => {
      await certNavOpen(page, width);
      await page.evaluate(issues => { window.__certificateNavigation.uploadIssues = issues; }, refusal === 'issues');
      await certNavBeginUpload(page, true);
      await control(page, 'domain').fill('newer.example.test');
      const key = control(page, 'private_key_pem'), original = await key.elementHandle();
      await key.fill('SYNTHETIC NEWER KEY'); await select(key, 2, 5); const selected = await selection(key);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('tls_domain.upload'))).toBe(1);
      await expect(certDraftStatus(page)).toContainText(`The submitted upload for ${drafts.domain} failed.`);
      await expect(certDraftStatus(page)).toContainText('Your newer edits still need uploading.');
      await expect(form(page).locator(refusal === 'issues' ? '[data-recued-tls-certs-issue]' : '[data-recued-tls-certs-error]')).toHaveCount(refusal === 'issues' ? 2 : 1);
      await expect(key).toHaveValue('SYNTHETIC NEWER KEY'); await expect(key).toBeFocused(); expect(await selection(key)).toEqual(selected);
      expect(await original!.evaluate(node => node.isConnected)).toBe(true); expect(await certNavUnload(page)).toBe(true);
      for (const field of fields) await expect(control(page, field)).not.toHaveAttribute('aria-invalid');
      await control(page, 'domain').fill('corrected.example.test'); await expect(certDraftStatus(page)).toHaveCount(0);
      await certNavUpload(page).press('Enter'); await expect(key).toHaveAttribute('aria-invalid', 'true'); await expect(key).toBeFocused();
      await expect(certDraftStatus(page)).toHaveCount(0); await expect(form(page).locator('[data-recued-tls-certs-issue]')).toHaveCount(0);
      expect(await page.evaluate(() => window.__certificateEditing.uploads)).toHaveLength(1);
    });
  }

  for (const mode of ['before-submit', 'after-submit', 'read-first', 'empty'] as const) {
    test(`Certificates pending upload preserves the ${mode} file choice and delayed read at ${width}px`, async ({ page }) => {
      await certNavOpen(page, width); await certNavFill(page); await holdCertificateFiles(page);
      const text = mode === 'empty' ? '' : '-----BEGIN PRIVATE KEY-----\nSYNTHETIC NEWER KEY\n-----END PRIVATE KEY-----';
      const input = control(page, 'private_key_pem'), file = picker(page, 'private_key_pem');
      const original = await input.elementHandle(), originalFile = await file.elementHandle(), originalForm = await form(page).elementHandle();
      if (mode === 'before-submit') await pickCertificateFile(page, 'private_key_pem', text, 'newer.pem');
      await certNavStartUpload(page);
      if (mode !== 'before-submit') await pickCertificateFile(page, 'private_key_pem', text, 'newer.pem');
      const hostname = control(page, 'domain'); await hostname.focus(); await select(hostname, 2, 5); const selected = await selection(hostname);
      if (mode === 'read-first' || mode === 'empty') await releaseCertificateFile(page, 0);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('tls_domain.upload'))).toBe(1);
      await expect(certDraftStatus(page)).toContainText(`Certificate installed for ${drafts.domain}.`);
      await expect(form(page)).toBeVisible(); await expect(certNavLoading(page)).toHaveCount(0);
      expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      expect(await originalFile!.evaluate(node => node.isConnected)).toBe(true);
      expect(await originalForm!.evaluate(node => node.isConnected)).toBe(true);
      expect(await file.evaluate((node: HTMLInputElement) => node.files?.[0]?.name)).toBe('newer.pem');
      if (mode === 'before-submit' || mode === 'after-submit') await releaseCertificateFile(page, 0);
      if (mode === 'empty') {
        await expect(input).toHaveValue('-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----');
        expect(await file.evaluate((node: HTMLInputElement) => node.files?.[0]?.size)).toBe(0);
      } else await expect(input).toHaveValue(text);
      await expect(hostname).toBeFocused(); expect(await selection(hostname)).toEqual(selected);
      expect(await certNavUnload(page)).toBe(true); expect(await page.evaluate(() => window.__certificateEditing.uploads)).toHaveLength(1);
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(form(page)).toHaveCount(0); expect(await certNavUnload(page)).toBe(false);
    });
  }
}

for (const width of [390]) {
  test(`Certificates retained upload notice follows cleared text and file drafts at ${width}px`, async ({ page }) => {
    await certNavOpen(page, width); await certNavBeginUpload(page);
    const original = await form(page).elementHandle();
    for (const field of fields) await control(page, field).fill('');
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('tls_domain.upload'))).toBe(1);
    const caption = panel(page).locator('[data-recued-tls-certs-result] .tls-certs-ok');
    await expect(caption).toHaveText(`Certificate installed for ${drafts.domain}.`);
    await expect(certDraftStatus(page)).toHaveCount(0); expect(await certNavUnload(page)).toBe(false);
    await expect(certNavLoading(page)).toHaveCount(0); await certNavBeginUpload(page);
    await control(page, 'private_key_pem').fill('SYNTHETIC NEWER KEY');
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('tls_domain.upload'))).toBe(1);
    await expect(certDraftStatus(page)).toContainText('Your newer edits still need uploading.');
    await expect(certNavLoading(page)).toHaveCount(0);
    for (const field of fields) await control(page, field).fill('');
    await expect(caption).toHaveText(`Certificate installed for ${drafts.domain}.`);
    await expect(certDraftStatus(page)).toHaveCount(0); expect(await certNavUnload(page)).toBe(false);
    const key = control(page, 'private_key_pem'); await key.focus(); await page.keyboard.type('x');
    await expect(certDraftStatus(page)).toHaveCount(1); expect(await certNavUnload(page)).toBe(true);
    await page.keyboard.press('Backspace'); await expect(key).toHaveValue(''); await expect(key).toBeFocused();
    expect(await selection(key)).toMatchObject({ start: 0, end: 0 });
    await expect(certDraftStatus(page)).toHaveCount(0); expect(await certNavUnload(page)).toBe(false);
    await picker(page, 'private_key_pem').setInputFiles({ name: 'empty-fixture.pem', mimeType: 'text/plain', buffer: Buffer.from('') });
    await expect(certDraftStatus(page)).toHaveCount(1); expect(await certNavUnload(page)).toBe(true);
    await picker(page, 'private_key_pem').setInputFiles([]);
    await expect(caption).toHaveText(`Certificate installed for ${drafts.domain}.`);
    await expect(certDraftStatus(page)).toHaveCount(0); expect(await certNavUnload(page)).toBe(false);
    await expect(key).toBeFocused(); expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    expect(await page.evaluate(() => window.__certificateEditing.uploads)).toHaveLength(2);
  });
}
