import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { createReceptionPortHandler, type ReceptionPortHandlerDeps } from '../../../backend/server/src/ports/reception/handler.js';
import { RECEPTION_LOOKUP_PATH } from '../../../backend/server/src/ports/reception/handlers/visitor-lookup-mint.js';
import { createReceptionRateLimiter } from '../../../backend/server/src/ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../../../backend/server/src/ports/reception/registry-cache.js';
import { deriveReceptionPepper } from '../../../backend/server/src/ports/reception/server-secret-pepper.js';
import { createPublicEndpointRegistryStore } from '../../../backend/server/src/storage/public-endpoint-registry-store.js';
import { createReceptionFormSubmissionStore } from '../../../backend/server/src/storage/reception-form-store.js';
import { createReceptionManageCredentialStore } from '../../../backend/server/src/storage/reception-manage-credential-store.js';
import { ensureReceptionSchema } from '../../../backend/server/src/storage/reception-store.js';

test.use({ javaScriptEnabled: false, viewport: { width: 1280, height: 620 } });

const now = Date.UTC(2026, 10, 24, 16);
const submittedAt = now - 60_000;
const referenceId = 'b413156c-8494-4a07-9f17-0485a79f4708';
const endpointId = 'ep-project-intake';

const startLookup = async (runReceptionLookupRecipe?: ReceptionPortHandlerDeps['runReceptionLookupRecipe']) => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db);
  const submissions = createReceptionFormSubmissionStore(db);
  const credentials = createReceptionManageCredentialStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const pepper = deriveReceptionPepper(Buffer.alloc(32, 0x57));
  submissions.insert({
    submission_id: referenceId,
    endpoint_id: endpointId,
    form_definition_id: 'project-intake',
    submitted_at: submittedAt,
    source_ip_hash: null,
    visitor_email_encrypted: null,
    submission_blob_encrypted: 'AQID',
    schema_version: 1,
    processing_outcome: 'pending',
  });
  const scope = { kind: 'intake_form', purpose: 'lookup', endpoint_id: endpointId, record_id: referenceId } as const;
  const live = credentials.issue({ ...scope, now });
  const expired = credentials.issue({ ...scope, now: submittedAt, ttl_ms: now - submittedAt });

  const handler = createReceptionPortHandler({
    getStore: () => registry,
    getCache: () => cache,
    getRateLimiter: () => limiter,
    getPepper: () => pepper,
    now: () => now,
    getIntakeFormSubmissionStore: () => submissions,
    getReceptionManageCredentialStore: () => credentials,
    ...(runReceptionLookupRecipe && { runReceptionLookupRecipe }),
  });
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Request lookup listener did not start');
  const lookupUrl = (secret: string) => `http://127.0.0.1:${address.port}${RECEPTION_LOOKUP_PATH}/${secret}`;
  return {
    url: lookupUrl(live.secret),
    unavailableUrls: [lookupUrl(expired.secret), lookupUrl(`recued_manage_${'z'.repeat(43)}`)],
    startWork: () => submissions.markProcessed({
      submission_id: referenceId, outcome: 'processed', resolved: { kind: 'task', id: 'project-task' },
    }),
    revoke: () => credentials.revokeLookupsForRecord({ endpoint_id: endpointId, record_id: referenceId, now }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
};

test('a request link refreshes its status and uses the same unavailable page after revocation or expiry', async ({ page }) => {
  const lookup = await startLookup();
  try {
    expect((await page.goto(lookup.url))?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Your request', level: 1 })).toBeVisible();
    await expect(page.getByText('We have your request. Nothing has been decided yet.', { exact: true })).toBeVisible();

    lookup.startWork();
    expect((await page.reload())?.status()).toBe(200);
    await expect(page.getByText('Your request is being worked on.', { exact: true })).toBeVisible();
    await expect(page.getByText(referenceId, { exact: true })).toBeVisible();
    await expect(page.getByText(new Date(submittedAt).toISOString(), { exact: true })).toBeVisible();

    expect(lookup.revoke()).toBe(1);
    const revoked = await page.reload();
    expect(revoked?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'This link is no longer available', level: 1 })).toBeVisible();
    await expect(page.getByText(referenceId, { exact: true })).toHaveCount(0);
    const revokedHtml = await revoked?.text();
    for (const url of lookup.unavailableUrls) {
      const response = await page.goto(url);
      expect(response?.status()).toBe(404);
      expect(await response?.text()).toBe(revokedHtml);
    }
  } finally {
    await lookup.close();
  }
});

test('the AI notice precedes recipe output and its link works by keyboard', async ({ page, browserName }) => {
  const notice = 'Parts of this page were produced using AI.';
  const update = 'The latest project drawings are ready for your review.';
  const drawingsUrl = 'https://example.test/drawings';
  const linkLabel = 'Review the drawings';
  const lookup = await startLookup(async () => ({
    kind: 'completed',
    uses_ai: true,
    render: [
      { type: 'text', data: update },
      { type: 'link_button', data: [{ label: linkLabel, url: drawingsUrl }] },
    ],
  }));
  try {
    await page.route(drawingsUrl, route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Project drawings</title><h1>Project drawings</h1>',
    }));
    expect((await page.goto(lookup.url))?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Your request', level: 1 })).toBeVisible();
    await expect(page.getByText(notice, { exact: true })).toBeVisible();
    await expect(page.getByText(update, { exact: true })).toBeVisible();
    const content = await page.getByRole('main').innerText();
    expect(content.indexOf(notice)).toBeLessThan(content.indexOf(update));
    await expect(page.getByText(referenceId, { exact: true })).toHaveCount(0);

    const link = page.getByRole('link', { name: linkLabel, exact: true });
    await page.keyboard.press(browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab');
    await expect(link).toBeFocused();
    const opened = page.waitForResponse(response => response.url() === drawingsUrl && response.request().isNavigationRequest());
    await page.keyboard.press('Enter');
    expect(await (await opened).request().headerValue('referer')).toBeNull();
    await expect(page).toHaveURL(drawingsUrl);
    await expect(page.getByRole('heading', { name: 'Project drawings' })).toBeVisible();
  } finally {
    await lookup.close();
  }
});
