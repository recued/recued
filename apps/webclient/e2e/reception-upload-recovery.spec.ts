import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { DropLinkConfig } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { ensureReceptionSchema } from '../../../backend/server/src/storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../../../backend/server/src/storage/public-endpoint-registry-store.js';
import { createReceptionDropBlobStore } from '../../../backend/server/src/storage/reception-drop-store.js';
import { createBlobStore } from '../../../backend/server/src/storage/blob-store.js';
import { createReceptionPortHandler } from '../../../backend/server/src/ports/reception/handler.js';
import { createReceptionRegistryCache } from '../../../backend/server/src/ports/reception/registry-cache.js';
import { createReceptionRateLimiter } from '../../../backend/server/src/ports/reception/rate-limiter.js';
import { deriveReceptionPepper, computeBearerHmac } from '../../../backend/server/src/ports/reception/server-secret-pepper.js';
import { createInMemoryDropLinkNonceStore } from '../../../backend/server/src/ports/reception/handlers/drop-link.js';
import { deriveDropBlobPiiKeyFromSubDek, openDropBlobPiiField } from '../../../backend/server/src/ports/reception/drop-pii.js';
import { createReceptionUploadService } from '../../../backend/server/src/upload/reception-upload-service.js';

// A real public dispatcher, SQLite registry, nonce store, upload service and CAS.
// Only the lost final response is intercepted; the upload has already committed.
const PDF = Buffer.from('%PDF-1.7\nBrowser recovery fixture\n');
const startReception = async (overrides: Partial<DropLinkConfig> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'reception-upload-browser-'));
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db);
  const drops = createReceptionDropBlobStore(db);
  const cache = createReceptionRegistryCache();
  const nonce = createInMemoryDropLinkNonceStore();
  const blobs = createBlobStore(join(root, 'cas'));
  const limiter = createReceptionRateLimiter({ db });
  const pepper = deriveReceptionPepper(Buffer.alloc(32, 0xa1));
  const key = deriveDropBlobPiiKeyFromSubDek(new Uint8Array(32).fill(0x6e));
  const now = Date.now();
  const config: DropLinkConfig = {
    display_name: 'Browser fixture', instructions: 'Send a PDF.', success_message: 'Received.', submit_button_label: 'Upload',
    link_kind: 'repeated', size_cap_bytes: 1024, allowed_mime_types: ['application/pdf'], expiry_days: 7,
    max_uploads_per_endpoint_per_day: 5, required_visitor_fields: { name: 'optional', email: 'optional', description: 'optional' },
    on_upload: { create_data_file_entity: true, auto_attach_to_contact: false }, ...overrides,
  };
  registry.create({ endpoint_id: 'ep-browser', kind: 'drop_link',
    packet_declaration: { packet_kind: 'drop_link_packet', source_query_ref: { kind: 'reception_drop_config', drop_config_id: 'fixture' } },
    bearer_secret_hmac: computeBearerHmac('fixture-bearer', pepper), created_at: now - 1000, created_by_client_id: 'fixture',
    expires_at: now + 120_000, long_lived_acknowledged_at: null, metadata: { ...config },
  });
  registry.enable('ep-browser', now);
  const auditLog = { logActivity: async () => undefined } as unknown as AuditLogStore;
  const service = createReceptionUploadService({ db, blobs, uploadsRoot: join(root, 'uploads'), dropBlobStore: drops,
    getStore: () => registry, getDropLinkNonceStore: () => nonce, getDropBlobPiiKey: () => key, auditLog,
    now: () => now, invalidateRegistryCache: id => cache.invalidate(id),
  });
  const handler = createReceptionPortHandler({ getStore: () => registry, getCache: () => cache,
    getRateLimiter: () => limiter, getPepper: () => pepper, now: () => now,
    getDropLinkNonceStore: () => nonce, getReceptionUploadService: () => service, getDropBlobStore: () => drops,
    getBlobStore: () => blobs, getDropBlobPiiKey: () => key, getDropBlobsRoot: () => root, auditLog,
  });
  const requests: Array<{ method: string; path: string }> = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', path: new URL(req.url ?? '/', 'http://local').pathname });
    void handler(req, res).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No reception listener');
  return { db, drops, registry, cache, key, requests, now,
    url: `http://127.0.0.1:${address.port}/reception/drop/ep-browser?t=fixture-bearer`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close(); rmSync(root, { recursive: true, force: true });
    },
  };
};

test('public upload replaces a rejected file with a fresh nonce and keeps visitor input under the shipped CSP', async ({ page }) => {
  const reception = await startReception();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(reception.url);
    await page.getByLabel('Name', { exact: true }).fill('Ada');
    await page.getByLabel('Email', { exact: true }).fill('ada@example.test');
    await page.getByLabel('Description', { exact: true }).fill('Keep this note after a rejection.');
    const nonceBefore = await page.locator('[name="form_nonce"]').inputValue();
    await page.locator('[name="blob"]').setInputFiles({ name: 'wrong.pdf', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a00000000', 'hex') });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.locator('.rcp-upload-status')).toContainText('file type');
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Ada');
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue('ada@example.test');
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Keep this note after a rejection.');
    await page.locator('[name="blob"]').setInputFiles({ name: 'correct.pdf', mimeType: 'application/pdf', buffer: PDF });
    await page.getByRole('button', { name: 'Try again', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.rcp-upload-status')).toContainText('Upload received');
    expect(await page.locator('[name="form_nonce"]').inputValue()).not.toBe(nonceBefore);
    const rows = reception.drops.listPendingForEndpoint('ep-browser');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.filename_sanitized).toBe('correct.pdf');
    expect(await openDropBlobPiiField({ key: reception.key, endpoint_id: 'ep-browser', blob_id: rows[0]!.blob_id,
      field: 'visitor_description', ciphertext: rows[0]!.visitor_description_encrypted! })).toBe('Keep this note after a rejection.');
    expect(errors).toEqual([]);
  } finally { await reception.close(); }
});

test('a quota failure preserves the file and a subsequently revoked link asks for a new link', async ({ page }) => {
  const reception = await startReception({ max_uploads_per_endpoint_per_day: 1 });
  reception.drops.insert({ blob_id: 'seed', endpoint_id: 'ep-browser', uploaded_at: reception.now, source_ip_hash: null,
    visitor_email_encrypted: null, visitor_name_encrypted: null, visitor_description_encrypted: null,
    filename_sanitized: 'earlier.pdf', mime_type_reported: 'application/pdf', mime_type_detected: 'application/pdf',
    size_bytes: 1, content_hash: 'seed', storage_path: 'seed', processing_outcome: 'pending',
  });
  try {
    await page.goto(reception.url);
    await page.getByLabel('Name', { exact: true }).fill('Ada');
    await page.locator('[name="blob"]').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.locator('.rcp-upload-status')).toContainText('daily upload limit');
    expect(await page.locator('[name="blob"]').evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('report.pdf');
    reception.registry.revoke({ endpoint_id: 'ep-browser', now: reception.now, reason: 'Owner revoked' });
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.locator('.rcp-upload-status')).toContainText('Ask the sender for a new link');
    await expect(page.locator('[type="submit"]')).toBeDisabled();
    await expect(page.getByLabel('Name', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Ada');
    expect(reception.drops.listPendingForEndpoint('ep-browser')).toHaveLength(1);
  } finally { await reception.close(); }
});

test('revoking the link during transfer asks for a new link without offering a retry', async ({ page }) => {
  const reception = await startReception();
  try {
    await page.route('**/uploads/*?*', async route => {
      if (route.request().method() === 'POST' && route.request().headers()['content-type'] === 'application/octet-stream') {
        reception.registry.revoke({ endpoint_id: 'ep-browser', now: reception.now, reason: 'Owner revoked' });
        reception.cache.invalidate('ep-browser');
      }
      await route.continue();
    });
    await page.goto(reception.url);
    await page.locator('[name="blob"]').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.locator('.rcp-upload-status')).toContainText('Ask the sender for a new link');
    await expect(page.locator('[type="submit"]')).toBeDisabled();
    expect(reception.drops.listPendingForEndpoint('ep-browser')).toHaveLength(0);
    expect(reception.requests.filter(r => r.path.endsWith('/finalize'))).toHaveLength(0);
  } finally { await reception.close(); }
});

test('a lost confirmation after real acceptance blocks another upload, including a programmatic submit', async ({ page }) => {
  const reception = await startReception();
  try {
    await page.route('**/uploads/*/finalize?*', async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(200); // The real service committed before losing its response.
      await route.abort('failed');
    });
    await page.goto(reception.url);
    await page.getByLabel('Name', { exact: true }).fill('Ada');
    await page.locator('[name="blob"]').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.locator('.rcp-upload-status')).toContainText('could not confirm whether your upload was received');
    await expect(page.locator('[type="submit"]')).toBeDisabled();
    await expect(page.getByLabel('Name', { exact: true })).toBeEnabled();
    expect(await page.locator('form').evaluate(form => !form.dispatchEvent(new Event('submit', { cancelable: true })))).toBe(true);
    expect(reception.drops.listPendingForEndpoint('ep-browser')).toHaveLength(1);
    expect(reception.requests.filter(r => r.method === 'POST' && r.path.endsWith('/uploads'))).toHaveLength(1);
    expect(reception.requests.filter(r => r.method === 'GET' && r.path.endsWith('/uploads'))).toHaveLength(0);
  } finally { await reception.close(); }
});

test('the public multipart form still accepts an upload with JavaScript disabled', async ({ browser }) => {
  const reception = await startReception();
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(reception.url);
    await page.locator('[name="blob"]').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.locator('body')).toContainText('Received.');
    expect(reception.drops.listPendingForEndpoint('ep-browser')).toHaveLength(1);
    expect(reception.requests.filter(r => r.method === 'POST').map(r => r.path)).toEqual(['/reception/drop/ep-browser']);
  } finally { await context.close(); await reception.close(); }
});
