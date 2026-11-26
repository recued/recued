import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import type { ApprovalLinkConfig } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { createReceptionPortHandler } from '../../../backend/server/src/ports/reception/handler.js';
import { createInMemoryApprovalLinkNonceStore } from '../../../backend/server/src/ports/reception/handlers/approval-link.js';
import {
  deriveApprovalIntentPiiKeyFromSubDek,
  openApprovalIntentPiiField,
} from '../../../backend/server/src/ports/reception/approval-pii.js';
import { createReceptionRateLimiter } from '../../../backend/server/src/ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../../../backend/server/src/ports/reception/registry-cache.js';
import { computeBearerHmac, deriveReceptionPepper } from '../../../backend/server/src/ports/reception/server-secret-pepper.js';
import { createPublicEndpointRegistryStore } from '../../../backend/server/src/storage/public-endpoint-registry-store.js';
import { createReceptionApprovalIntentStore } from '../../../backend/server/src/storage/reception-approval-store.js';
import { ensureReceptionSchema } from '../../../backend/server/src/storage/reception-store.js';

test.use({ javaScriptEnabled: false, viewport: { width: 1280, height: 620 } });

const startResponse = async (kind: 'quote' | 'completion') => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db);
  const intents = createReceptionApprovalIntentStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const nonce = createInMemoryApprovalLinkNonceStore();
  const pepper = deriveReceptionPepper(Buffer.alloc(32, 0x51));
  const key = deriveApprovalIntentPiiKeyFromSubDek(new Uint8Array(32).fill(0x76));
  const endpointId = 'ep-public-' + kind;
  const bearer = 'fixture-response-bearer';
  const now = Date.UTC(2026, 10, 24, 16);
  const completion = kind === 'completion';
  const config: ApprovalLinkConfig = {
    display_name: 'Northwind Studio',
    action_kind: 'approve_wording',
    prompt: completion ? 'Accept completion or request corrections.' : 'Do you accept the quote and the scope shown below?',
    context_raw: {
      summary: completion
        ? 'Completion for quote Q-1045\n\nAgreed scope:\nLighting schedule and two shelf elevations.\n\nDelivered work:\nThe updated drawings include changes from the final coordination meeting.'
        : 'Quote Q-1045 — Fieldwork Studio\nRevision 4\n2400 USD total\nNet: 2200; VAT included: 200 USD\n\nScope:\nLighting schedule, two shelf elevations, and one revision after review.',
    },
    visitor_field_constraints: { name: 'optional', email: 'optional' },
    expiry_days: 7,
    submit_button_label: 'Send response',
    on_action: { target_id: 'fixture-request', on_approve_action: completion ? 'quote_completion' : 'quote_signoff' },
  };
  registry.create({
    endpoint_id: endpointId, kind: 'approval_link',
    packet_declaration: { packet_kind: 'approval_link_packet', source_query_ref: { kind: 'reception_approval_intent', intent_id: endpointId } },
    bearer_secret_hmac: computeBearerHmac(bearer, pepper), created_at: now, created_by_client_id: 'fixture',
    expires_at: now + 7 * 86_400_000, long_lived_acknowledged_at: null, metadata: { ...config },
  });
  registry.enable(endpointId, now);
  intents.create({ intent_id: endpointId, endpoint_id: endpointId, action_kind: config.action_kind, target_id: config.on_action.target_id });

  const auditLog = { logActivity: async () => undefined } as unknown as AuditLogStore;
  const handler = createReceptionPortHandler({
    getStore: () => registry, getCache: () => cache, getRateLimiter: () => limiter, getPepper: () => pepper, now: () => now,
    getApprovalIntentStore: () => intents, getApprovalLinkNonceStore: () => nonce, getApprovalIntentPiiKey: () => key, auditLog,
    checkQuoteCompletionLink: () => null, checkQuoteSignoffLink: () => null,
  });
  let posts = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST') posts++;
    void handler(req, res).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Sign-off listener did not start');
  return {
    url: `http://127.0.0.1:${address.port}/reception/approve/${endpointId}?t=${bearer}`,
    posts: () => posts,
    consumedAt: () => intents.findByEndpoint(endpointId)?.consumed_at,
    outcome: async () => {
      const row = intents.findByEndpoint(endpointId);
      if (!row) throw new Error('Approval intent missing');
      return openApprovalIntentPiiField({
        key, endpoint_id: endpointId, intent_id: row.intent_id, field: 'outcome',
        ciphertext: row.consumed_outcome_encrypted,
      });
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
};

test('quote validation keeps the agreement and draft in view for a keyboard retry', async ({ page }) => {
  const quote = await startResponse('quote');
  try {
    expect((await page.goto(quote.url))?.status()).toBe(200);
    const terms = page.getByRole('region', { name: 'Quote terms' });
    const name = page.getByLabel(/^Your name/);
    const email = page.getByLabel(/^Your email/);
    const comment = page.getByLabel('Reason or proposed changes (optional)', { exact: true });
    const decline = page.getByRole('radio', { name: 'Decline this quote' });
    const send = page.getByRole('button', { name: 'Send response', exact: true });
    await expect(terms).toContainText('2400 USD total');
    await expect(send).toBeInViewport({ ratio: 1 });

    const reason = 'Please include a third elevation.';
    await name.fill('Morgan Álvarez');
    await email.fill('morgan@studio'); // Native email control accepts this. The server requires a qualified domain.
    await decline.press('Space');
    await comment.fill(reason);
    const invalid = page.waitForResponse(response => response.request().method() === 'POST');
    await send.press('Enter');
    expect((await invalid).status()).toBe(400);
    await expect(page.getByRole('alert')).toContainText('Enter a valid email address');
    await expect(terms).toContainText('2400 USD total');
    await expect(name).toHaveValue('Morgan Álvarez');
    await expect(email).toHaveValue('morgan@studio');
    await expect(decline).toBeChecked();
    await expect(comment).toHaveValue(reason);
    expect(quote.consumedAt()).toBeNull();

    await page.getByRole('link', { name: 'Fix your response', exact: true }).press('Enter');
    await expect(page.locator('#rcp-response-form')).toBeFocused();
    await email.fill('morgan@example.test');
    await send.press('Enter');
    await expect(page.getByRole('heading', { name: 'Response received', exact: true })).toBeVisible();
    await expect(page.getByText('Quote declined', { exact: true })).toBeVisible();
    expect(quote.posts()).toBe(2);
    expect(await quote.outcome()).toBe(`reject:${reason}`);
  } finally {
    await quote.close();
  }
});

test('completion contact fields never default to acceptance and the explicit correction is saved', async ({ page }) => {
  const completion = await startResponse('completion');
  try {
    expect((await page.goto(completion.url))?.status()).toBe(200);
    const name = page.getByLabel(/^Your name/);
    const email = page.getByLabel(/^Your email/);
    const correction = 'Please correct the elevation dimensions.';
    await name.fill('Morgan');
    await email.fill('morgan@example.test');
    await page.getByLabel(/^Corrections/).fill(correction);
    await name.press('Enter');
    await email.press('Enter');
    expect(completion.posts()).toBe(0);
    expect(completion.consumedAt()).toBeNull();

    const requestCorrections = page.getByRole('button', { name: 'Request corrections', exact: true });
    await expect(requestCorrections).toBeInViewport({ ratio: 1 });
    await requestCorrections.press('Space');
    await expect(page.getByRole('heading', { name: 'Response received', exact: true })).toBeVisible();
    await expect(page.getByText('Corrections requested', { exact: true })).toBeVisible();
    expect(completion.posts()).toBe(1);
    expect(await completion.outcome()).toBe(`reject:${correction}`);
  } finally {
    await completion.close();
  }
});
