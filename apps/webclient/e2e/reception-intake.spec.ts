import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { VISITOR_LOOKUP_DEFAULT_TTL_MS, type IntakeFormConfig } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { deriveFormSubmissionPiiKeyFromSubDek } from '../../../backend/server/src/ports/reception/form-pii.js';
import { createReceptionPortHandler } from '../../../backend/server/src/ports/reception/handler.js';
import { createInMemoryIntakeFormNonceStore } from '../../../backend/server/src/ports/reception/handlers/intake-form.js';
import { openReceptionRecordBlob } from '../../../backend/server/src/ports/reception/open-reception-record.js';
import { createReceptionRateLimiter } from '../../../backend/server/src/ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../../../backend/server/src/ports/reception/registry-cache.js';
import { computeBearerHmac, deriveReceptionPepper } from '../../../backend/server/src/ports/reception/server-secret-pepper.js';
import { createPublicEndpointRegistryStore } from '../../../backend/server/src/storage/public-endpoint-registry-store.js';
import { createReceptionFormSubmissionStore } from '../../../backend/server/src/storage/reception-form-store.js';
import { createReceptionManageCredentialStore } from '../../../backend/server/src/storage/reception-manage-credential-store.js';
import { ensureReceptionSchema } from '../../../backend/server/src/storage/reception-store.js';

test.use({ javaScriptEnabled: false, viewport: { width: 1440, height: 800 } });

const checkoutUrl = 'https://example.test/checkout';

const startIntake = async (withReceipt = false) => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db);
  const submissions = createReceptionFormSubmissionStore(db);
  const credentials = createReceptionManageCredentialStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const nonce = createInMemoryIntakeFormNonceStore();
  const key = deriveFormSubmissionPiiKeyFromSubDek(new Uint8Array(32).fill(0x43));
  const pepper = deriveReceptionPepper(Buffer.alloc(32, 0x59));
  const endpointId = 'ep-public-intake';
  const bearer = 'fixture-intake-bearer';
  const now = Date.UTC(2026, 10, 24, 16);
  const config: IntakeFormConfig = {
    display_name: 'Northwind Studio',
    instructions: 'Tell us about your project so we can respond with next steps.',
    submit_button_label: 'Send request',
    success_message: 'We received your request.',
    form_definition: {
      form_definition_id: 'project-intake',
      fields: [
        { name: 'your_name', type: 'text', label: 'Your name', required: true },
        { name: 'website', type: 'text', label: 'Website', required: false },
        {
          name: 'project_kind', type: 'enum', label: 'Project type', required: true,
          values: ['commercial', 'residential'], value_labels: { commercial: 'Commercial', residential: 'Residential' },
        },
        { name: 'target_date', type: 'date', label: 'Target start date', required: false },
        { name: 'budget', type: 'number', label: 'Estimated budget', required: false },
        { name: 'callback_time', type: 'datetime', label: 'Preferred callback time', required: false },
        { name: 'notes', type: 'textarea', label: 'Project details', required: true },
        { name: 'contact_ok', type: 'boolean', label: 'You may contact me about this request', required: false },
      ],
    },
    submission_processing_rule: {
      target_kind: 'task',
      fields_to_include_in_target: ['your_name', 'notes'],
      fields_to_attach_as_metadata: ['project_kind', 'target_date', 'budget', 'callback_time', 'contact_ok'],
    },
    anti_spam: { honeypot_fields: ['website'], rate_limit_per_ip: 5, require_proof_of_work: false, require_captcha: false },
    required_visitor_fields: { email: 'required' },
    ...(withReceipt ? {
      visitor_receipt: { enabled: true },
      visitor_lookup: { enabled: true, expiry: { mode: 'fixed' as const, ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS } },
    } : {}),
  };
  const binding = {
    version: 1 as const, form_definition_id: config.form_definition.form_definition_id,
    recipe_id: 'fixture-intake-recipe', recipe_version: 1, pair_revision: `d200-pair-v1-${'a'.repeat(64)}` as const,
  };
  registry.create({
    endpoint_id: endpointId, kind: 'intake_form',
    packet_declaration: {
      packet_kind: 'intake_form_packet', source_query_ref: { kind: 'reception_form_definition', form_definition_id: binding.form_definition_id },
    },
    bearer_secret_hmac: computeBearerHmac(bearer, pepper), created_at: now, created_by_client_id: 'fixture',
    expires_at: now + 86_400_000, long_lived_acknowledged_at: null, metadata: { ...config },
  });
  registry.enable(endpointId, now);
  const auditLog = { logActivity: async () => undefined } as unknown as AuditLogStore;
  const handler = createReceptionPortHandler({
    getStore: () => registry, getCache: () => cache, getRateLimiter: () => limiter, getPepper: () => pepper, now: () => now,
    getIntakeFormSubmissionStore: () => submissions, getIntakeFormNonceStore: () => nonce,
    getIntakeFormSubmissionPiiKey: () => key, auditLog,
    getReceptionManageCredentialStore: () => credentials,
    resolveIntakeFormRecipePair: () => ({ kind: 'ready', binding, renders_response: withReceipt, uses_ai: true }),
    coordinateIntakeFormPairedRun: async () => withReceipt
      ? { kind: 'completed', render: [{ type: 'link_button', data: [{ label: 'Checkout', url: checkoutUrl }] }] }
      : { kind: 'held' },
  });
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Intake listener did not start');
  return {
    url: `http://127.0.0.1:${address.port}/reception/intake/${endpointId}?t=${bearer}`,
    values: async () => {
      const rows = submissions.listPendingForEndpoint(endpointId);
      expect(rows).toHaveLength(1);
      return openReceptionRecordBlob({ key, row: rows[0]! });
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
};

test('the AI disclosure accompanies a native keyboard submit and mixed fields persist in their configured order', async ({ page }) => {
  const intake = await startIntake();
  try {
    expect((await page.goto(intake.url))?.status()).toBe(200);
    const notice = 'This form uses AI to process what you send.';
    const send = page.getByRole('button', { name: 'Send request', exact: true });
    await expect(page.getByText(notice, { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(send).toBeInViewport({ ratio: 1 });
    await expect(send).toHaveAccessibleDescription(notice);

    const fields = {
      your_name: 'Morgan Álvarez', project_kind: 'commercial', target_date: '2026-12-07',
      budget: '9200.5', callback_time: '2026-12-04T10:30', notes: 'Design review for the café.', contact_ok: 'true',
    };
    const email = 'morgan@example.test';
    await page.getByLabel(/^Email/).fill(email);
    await page.getByLabel(/^Your name/).fill(fields.your_name);
    await page.getByLabel(/^Project type/).selectOption({ label: 'Commercial' });
    await page.getByLabel('Target start date', { exact: true }).fill(fields.target_date);
    await page.getByLabel('Estimated budget', { exact: true }).fill(fields.budget);
    await page.getByLabel('Preferred callback time', { exact: true }).fill(fields.callback_time);
    await page.getByLabel(/^Project details/).fill(fields.notes);
    await page.getByRole('checkbox', { name: 'You may contact me about this request' }).press('Space');

    const submitted = page.waitForResponse(response => response.request().method() === 'POST');
    await send.press('Enter');
    const response = await submitted;
    expect(response.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Submission received', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Your receipt' })).toHaveCount(0);
    const posted = new URLSearchParams(response.request().postData()!);
    expect(posted.get('form_nonce')).toBeTruthy();
    posted.delete('form_nonce');
    expect([...posted.entries()]).toEqual(Object.entries({ website: '', visitor_email: email, ...fields }));
    expect(await intake.values()).toEqual({ visitor_email: email, fields: { ...fields, contact_ok: true } });
  } finally {
    await intake.close();
  }
});

test('an intake receipt keeps checkout first and opens the matching request status by keyboard', async ({ page, browserName }) => {
  const intake = await startIntake(true);
  try {
    await page.setViewportSize({ width: 1280, height: 620 });
    expect((await page.goto(intake.url))?.status()).toBe(200);
    const notes = 'Please use the service entrance.\nBring the revised floor plan.';
    await page.getByLabel(/^Email/).fill('morgan@example.test');
    await page.getByLabel(/^Your name/).fill('Morgan Álvarez');
    await page.getByLabel(/^Project type/).selectOption({ label: 'Commercial' });
    await page.getByLabel(/^Project details/).fill(notes);

    const submitted = page.waitForResponse(response => response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send request', exact: true }).press('Enter');
    expect((await submitted).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Submission received', level: 1 })).toBeVisible();
    const receipt = page.getByRole('region', { name: 'Your receipt' });
    await expect(receipt.getByText(notes, { exact: true })).toBeVisible();
    const referenceId = await receipt.locator('code').innerText();
    const statusLink = receipt.getByRole('link', { name: 'Check request status', exact: true });
    await expect(statusLink).toHaveAccessibleDescription('Save this link to check again later.');
    await expect(statusLink).toHaveAttribute('href', /^\/reception\/lookup\/recued_manage_/);
    const statusUrl = new URL((await statusLink.getAttribute('href'))!, intake.url).href;
    const checkout = page.getByRole('link', { name: 'Checkout', exact: true });
    await expect(checkout).toHaveAttribute('href', checkoutUrl);

    const tab = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
    await page.keyboard.press(tab);
    await expect(checkout).toBeFocused();
    await page.keyboard.press(tab);
    await expect(statusLink).toBeFocused();
    const opened = page.waitForResponse(response => response.url() === statusUrl && response.request().isNavigationRequest());
    await page.keyboard.press('Enter');
    expect((await opened).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Your request', level: 1 })).toBeVisible();
    await expect(page.getByText(referenceId, { exact: true })).toBeVisible();
    await expect(page.getByText('We have your request. Nothing has been decided yet.', { exact: true })).toBeVisible();
    await expect(page.getByText(notes, { exact: true })).toHaveCount(0);
  } finally {
    await intake.close();
  }
});
