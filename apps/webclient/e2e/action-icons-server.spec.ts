import { expect, test, type Page } from '@playwright/test';
import { evaluateCustomDomainPreflight, evaluateCustomDomainIssuanceEligibility } from '@recued/contracts';
import { clickActionGlyph } from './helpers/action-glyph.js';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
type ServerIconCall = { method: string; args: unknown };
declare global { interface Window { __serverIconWrites: ServerIconCall[]; __serverIconCopies: string[] } }
const calls = (page: Page, method: string) => page.evaluate(method => window.__app.rpcCallCount(method), method);
const hold = (page: Page, method: string) => page.evaluate(method => window.__app.holdRpcResponses?.(method), method);
const release = (page: Page, method: string) => page.evaluate(method => window.__app.releaseRpcResponses?.(method), method);
const domain = 'owner.example.test';
const preflight = evaluateCustomDomainPreflight({ hostname: domain, handle: 'alice', observation: {
  host_cnames: ['alice.recued.net'], host_addresses: [], ddns_addresses: [], delegation_cnames: [], caa_records: [],
} });
const dns = { preflight, decision: evaluateCustomDomainIssuanceEligibility({
  row: { cert_source: 'unregistered', ownership_status: 'pending', enabled: false },
  preflight, subscription_active: true, enrolled_custom_count: 1,
}) };

const boot = async (page: Page, hash: string) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(({ hash, dns }) => {
    let ddnsEnabled = true;
    const rows = ['first.example.test', 'second.example.test'].map((hostname, index) => ({
      hostname_id: `icon-host-${index}`, hostname, cert_source: 'byo_external', verification_method: 'dns_txt',
      ownership_status: 'verified', listener_ports: [443], ddns_managed: false, enabled: true, tls_topology: 'server_terminated',
    }));
    window.__serverIconWrites = []; window.__serverIconCopies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { window.__serverIconCopies.push(text); },
    } });
    Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
      if (method === 'collection.hostname.list') return { result: { hostnames: rows } };
      if (method === 'collection.hostname.addressUses') return { error: { code: 'unknown_method', message: 'Optional read absent in this fixture.' } };
      if (method === 'network.local_urls') return { result: { urls: [] } };
      if (method === 'pro_convenience.status') return { result: {
        entitlement: 'entitled', publisher_handle: 'alice', ddns_hostname: 'alice.recued.net',
        items: { handle: { state: 'active' }, ddns: { state: 'active' }, acme: { state: 'active' } },
      } };
      if (method === 'ddns.status') return { result: { enabled: ddnsEnabled } };
      if (method === 'collection.hostname.issuanceReadiness' || method === 'collection.hostname.preflight') return { result: dns };
      if (method === 'tls_domain.list') return { result: { entries: ['first.example.test', 'second.example.test'].map(domain => ({
        domain, source: 'byo_upload', issuer: 'Synthetic CA', fingerprint: 'ab'.repeat(32), expires_at: Date.now() + 90 * 86_400_000,
      })) } };
      if (['collection.hostname.add', 'collection.hostname.remove', 'collection.hostname.update', 'collection.hostname.verifyOwnership',
        'ddns.setEnabled', 'tls_domain.upload', 'tls_domain.remove', 'tls.renew', 'key.rotate'].includes(method)) {
        window.__serverIconWrites.push({ method, args });
        if (method === 'ddns.setEnabled') {
          ddnsEnabled = args !== null && typeof args === 'object' && 'enabled' in args && args.enabled === true;
          return { result: { enabled: ddnsEnabled } };
        }
        if (method === 'tls.renew') return { result: {
          ok: true, op: 'tls_renew', key_class: 'tls_private_key', new_fingerprint: 'sha256:SYNTHETIC', rotated_at: 1_700_000_000_000,
        } };
        return { error: { code: 'UNAVAILABLE', message: 'Synthetic server action refused.' } };
      }
      return undefined;
    } });
    window.__app.setHash(hash);
  }, { hash, dns });
};

test('Hostnames Add and Cancel glyphs preserve an unsent editor', async ({ page }) => {
  await boot(page, '#settings/server/hostnames');
  const panel = page.locator('[data-recued-hostnames-panel]');
  await clickActionGlyph(page, panel.locator('[data-recued-hostnames-add-open]'));
  const form = panel.locator('[data-recued-hostnames-add-form]');
  await form.locator('[data-recued-hostnames-add-field="hostname"]').fill('draft.example.test');
  await clickActionGlyph(page, form.locator('[data-recued-hostnames-add-cancel]'));
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__serverIconWrites)).toEqual([]);
});

test('Hostnames Remove glyph reviews and sends the selected second name once', async ({ page }) => {
  await boot(page, '#settings/server/hostnames');
  const row = page.locator('[data-recued-hostnames-row="second.example.test"]');
  await clickActionGlyph(page, row.getByRole('button', { name: 'Remove', exact: true }));
  const confirm = page.locator('[data-recued-hostnames-remove-confirm]');
  expect(await calls(page, 'collection.hostname.remove')).toBe(0);
  await clickActionGlyph(page, page.locator('[data-recued-hostnames-remove-cancel]'));
  await expect(confirm).toHaveCount(0);
  await clickActionGlyph(page, row.getByRole('button', { name: 'Remove', exact: true }));
  await hold(page, 'collection.hostname.remove');
  await clickActionGlyph(page, confirm);
  await expect(confirm).toBeDisabled();
  await clickActionGlyph(page, confirm);
  expect(await page.evaluate(() => window.__serverIconWrites)).toEqual([{
    method: 'collection.hostname.remove', args: { hostname: 'second.example.test' },
  }]);
  expect(await release(page, 'collection.hostname.remove')).toBe(1);
  await expect(page.locator('[data-recued-hostnames-panel]')).toContainText('Synthetic server action refused.');
  await expect(page.locator('[data-recued-hostnames-row="first.example.test"]')).toBeVisible();
});

test('Hostnames Pause and Start glyphs preserve distinct DDNS requests', async ({ page }) => {
  await boot(page, '#settings/server/hostnames');
  const toggle = page.locator('[data-recued-hostnames-ddns-toggle]');
  await expect(toggle).toHaveText('Pause the address');
  await clickActionGlyph(page, toggle);
  await expect(toggle).toHaveText('Start the address again');
  await clickActionGlyph(page, toggle);
  await expect(toggle).toHaveText('Pause the address');
  expect(await page.evaluate(() => window.__serverIconWrites)).toEqual([
    { method: 'ddns.setEnabled', args: { enabled: false } },
    { method: 'ddns.setEnabled', args: { enabled: true } },
  ]);
});

test('DNS Check and Copy glyphs keep the selected name and perform no enrollment', async ({ page }) => {
  await boot(page, '#settings/server/hostnames');
  const panel = page.locator('[data-recued-custom-domains]');
  await panel.locator('[data-recued-custom-domains-input]').fill(domain);
  const check = panel.locator('[data-recued-custom-domains-check]');
  await hold(page, 'collection.hostname.issuanceReadiness');
  await clickActionGlyph(page, check);
  await expect(check).toHaveText('Checking…');
  await expect(check).toBeDisabled();
  await clickActionGlyph(page, check);
  expect(await calls(page, 'collection.hostname.issuanceReadiness')).toBe(1);
  expect(await release(page, 'collection.hostname.issuanceReadiness')).toBe(1);
  await expect(check).toHaveText('Check DNS');
  await clickActionGlyph(page, panel.locator('[data-recued-custom-domains-copy]').first());
  await expect.poll(() => page.evaluate(() => window.__serverIconCopies)).toEqual(['alice.recued.net']);
  expect(await page.evaluate(() => window.__serverIconWrites)).toEqual([]);
});

test('Certificate Upload glyph preserves its exact draft through a pending refusal', async ({ page }) => {
  await boot(page, '#settings/server/certificates');
  const panel = page.locator('[data-recued-tls-certs-panel]');
  await clickActionGlyph(page, panel.getByRole('button', { name: 'Upload a certificate', exact: true }));
  const values = { domain: 'upload.example.test',
    cert_pem: '-----BEGIN CERTIFICATE-----\nSYNTHETIC\n-----END CERTIFICATE-----',
    private_key_pem: '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----' };
  for (const [field, value] of Object.entries(values)) await panel.locator(`[data-recued-tls-certs-upload-field="${field}"]`).fill(value);
  await hold(page, 'tls_domain.upload');
  const upload = panel.getByRole('button', { name: 'Upload certificate', exact: true });
  await clickActionGlyph(page, upload);
  const pending = panel.getByRole('button', { name: 'Uploading…', exact: true });
  await expect(pending).toBeDisabled();
  await clickActionGlyph(page, pending);
  expect(await page.evaluate(() => window.__serverIconWrites)).toEqual([{
    method: 'tls_domain.upload', args: { ...values, source: 'byo_upload' },
  }]);
  expect(await release(page, 'tls_domain.upload')).toBe(1);
  await expect(panel).toContainText('Synthetic server action refused.');
  for (const [field, value] of Object.entries(values)) await expect(panel.locator(`[data-recued-tls-certs-upload-field="${field}"]`)).toHaveValue(value);
});

test('Certificate Remove and Cancel glyphs keep review tied to the second domain', async ({ page }) => {
  await boot(page, '#settings/server/certificates');
  const row = page.locator('[data-recued-tls-certs-row="second.example.test"]');
  const remove = row.getByRole('button', { name: 'Remove', exact: true });
  await clickActionGlyph(page, remove);
  await clickActionGlyph(page, row.getByRole('button', { name: 'Cancel', exact: true }));
  expect(await calls(page, 'tls_domain.remove')).toBe(0);
  await clickActionGlyph(page, remove);
  await hold(page, 'tls_domain.remove');
  await clickActionGlyph(page, row.getByRole('button', { name: 'Remove certificate', exact: true }));
  const pending = row.getByRole('button', { name: 'Removing…', exact: true });
  await expect(pending).toBeDisabled();
  await clickActionGlyph(page, pending);
  expect(await page.evaluate(() => window.__serverIconWrites)).toEqual([{
    method: 'tls_domain.remove', args: { domain: 'second.example.test' },
  }]);
  expect(await release(page, 'tls_domain.remove')).toBe(1);
  await expect(row).toContainText('Synthetic server action refused.');
});

test('Certificate Renew glyph preserves review and one pending renewal', async ({ page }) => {
  await boot(page, '#settings/server/certificates');
  const panel = page.locator('[data-recued-tls-renew-panel]');
  const renew = panel.getByRole('button', { name: 'Renew now', exact: true });
  await clickActionGlyph(page, renew);
  await clickActionGlyph(page, panel.getByRole('button', { name: 'Cancel', exact: true }));
  expect(await calls(page, 'tls.renew')).toBe(0);
  await clickActionGlyph(page, renew);
  await hold(page, 'tls.renew');
  const confirm = panel.getByRole('button', { name: 'Yes, renew', exact: true });
  await clickActionGlyph(page, confirm);
  await expect(confirm).toBeDisabled();
  await clickActionGlyph(page, confirm);
  expect(await page.evaluate(() => window.__serverIconWrites)).toEqual([{ method: 'tls.renew', args: {} }]);
  expect(await release(page, 'tls.renew')).toBe(1);
  await clickActionGlyph(page, panel.getByRole('button', { name: 'Close', exact: true }));
  await expect(renew).toBeVisible();
});

test('Exposure connection-example glyph opens read-only instructions and closes without a write', async ({ page }) => {
  await boot(page, '#settings/server/exposure');
  const panel = page.locator('[data-recued-exposure-panel]');
  const connect = panel.locator('[data-recued-exposure-connect-example]');
  await clickActionGlyph(page, connect);
  const dialog = panel.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await clickActionGlyph(page, dialog.getByRole('button', { name: 'Close', exact: true }));
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, 'exposure.apply_preset')).toBe(0);
  expect(await calls(page, 'exposure.set_path_resolution')).toBe(0);
  expect(await page.evaluate(() => window.__serverIconWrites)).toEqual([]);
});

test('Exposure instructions appear after navigating from Account and on return from another server tab', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?settle_reads=1&notifications=ready&yours=demo#settings/account`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByRole('tab', { name: 'Exposure', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Exposure', exact: true })).toHaveAttribute('aria-selected', 'true');
  const connect = page.locator('[data-recued-exposure-connect-example]');
  await expect(connect).toHaveCount(1);
  await clickActionGlyph(page, connect);
  const dialog = page.getByRole('dialog', { name: 'Connect an AI app to this server', exact: true });
  await expect(dialog.locator('[data-recued-exposure-connect-snippet="claude-code"]'))
    .toContainText('https://alice.recued.cloud:8443/mcp');
  await clickActionGlyph(page, dialog.getByRole('button', { name: 'Close', exact: true }));
  await page.getByRole('tab', { name: 'Hostnames', exact: true }).click();
  await page.getByRole('tab', { name: 'Exposure', exact: true }).click();
  await expect(connect).toHaveCount(1);
  for (const method of ['exposure.apply_preset', 'exposure.set_path_resolution', 'exposure.set_public_mcp_acknowledgement']) {
    expect(await calls(page, method)).toBe(0);
  }
});
