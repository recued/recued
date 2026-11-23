import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import type { InboxItem } from '@recued/contracts';
import { createAskStore, type InboundReply, type PendingAsk } from '@recued/notification';
import { createInMemoryCollection } from '@recued/storage';
import { ASK_LANDING_LINK_TTL_MS, createAskLandingPortHandler } from '../../../backend/server/src/ask-landing-port.js';
import { createAskLandingEditApproval } from '../../../backend/server/src/ask-landing-edit-approval.js';
import { buildAskLandingDetails } from '../../../backend/server/src/ask-landing-held-op-details.js';
import { createInMemoryAskLandingNonceStore } from '../../../backend/server/src/ask-landing-nonce-store.js';
import { allowingAskLandingAbuseDeps } from '../../../backend/server/src/__tests__/ask-landing-test-helpers.js';

// Real HTTP, renderer, stores, detail builder and edit approver. Channel and
// release callbacks write only local fixture state, with no provider calls.
test.use({ javaScriptEnabled: false });
const NOW = 1_700_000_000_000;
const ASK_ID = 'ask-payload-fixture';
const DEFAULT_BUDGET = 16 * 1024;

const startPage = async (body: string, cap?: number) => {
  let clock = NOW, issued = 0;
  const asks = createAskStore(createInMemoryCollection<PendingAsk>());
  await asks.create({ ask_id: ASK_ID, message: { title: 'Review fixture request', text: 'Review this local fixture.' },
    options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    handler_kind: 'gateway.preflight', handler_payload: { checkpoint_id: 'fixture-hold' },
    fanout_channels: ['telegram'], created_at: NOW,
  });
  const item: InboxItem = { hold_id: 'fixture-hold', operation_id: 'reception-scheduling.scheduling.materialize',
    top_tier_kind: 'booking', source: { kind: 'scheduling_link', record_ref: 'fixture-request' },
    args: { body, notify_visitor: true },
    arg_schema: { fields: [{ key: 'body', type: 'string', label: 'Details', required: true },
      { key: 'notify_visitor', type: 'boolean', label: 'Tell the visitor' }] },
    preview: { title: 'Fixture request' }, proposed_action: 'Create a booking', status: 'pending',
  };
  const replies: InboundReply[] = [], overrides: Record<string, unknown>[] = [];
  const nonces = createInMemoryAskLandingNonceStore();
  const handler = createAskLandingPortHandler({
    getAsk: id => asks.get(id), getVerificationPhrase: async () => undefined,
    submitAnswer: async reply => {
      await asks.recordAnswer(ASK_ID, { option: reply.option, answered_at: clock }, reply.via);
      replies.push(reply);
    },
    submitEditedApproval: createAskLandingEditApproval({
      findHoldItem: async id => id === item.hold_id ? item : null, timeZone: 'UTC',
      approve: async input => {
        Object.assign(item.args, input.edits); overrides.push(input.edits);
        await asks.recordAnswer(ASK_ID, { option: 'approve', answered_at: clock }, 'telegram');
        return { released: true };
      },
    }),
    resolveDetails: async () => buildAskLandingDetails(item, { editable: true, timeZone: 'UTC' }),
    nonceStore: { issue: (id, now) => { issued++; return nonces.issue(id, now); },
      consume: (id, nonce, now) => nonces.consume(id, nonce, now) },
    now: () => clock, abuse: allowingAskLandingAbuseDeps(),
    ...(cap !== undefined ? { maxBodyBytes: cap } : {}),
  });
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 503; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ask listener');
  return { asks, item, replies, overrides, issued: () => issued,
    url: `http://127.0.0.1:${address.port}/ask/${ASK_ID}?via=telegram`,
    setNow: (value: number) => { clock = value; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
};

const answer = async (page: Page, choice: 'Approve' | 'Deny') => {
  const button = page.getByRole('button', { name: choice, exact: true });
  if (await button.count()) await button.focus();
  else {
    await page.getByRole('radio', { name: choice, exact: true }).focus(); await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Submit response', exact: true }).focus();
  }
  const [response] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.keyboard.press('Enter')]);
  return response?.status();
};
const reopen = async (page: Page) => {
  await page.getByRole('link', { name: 'Reopen decision', exact: true }).focus();
  const [response] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.keyboard.press('Enter')]);
  return response?.status();
};

for (const fixture of [
  { name: 'large ASCII', body: 'x'.repeat(18_000), choice: 'Approve' as const },
  { name: 'non-ASCII', body: 'é'.repeat(3_000), choice: 'Deny' as const },
  { name: 'normalized line-ending', body: 'x\n'.repeat(2_400), choice: 'Deny' as const },
]) {
  test(`a ${fixture.name} prefill stays fully readable and answerable within the request budget`, async ({ page }) => {
    const f = await startPage(fixture.body);
    let posted = '';
    page.on('request', request => { if (request.method() === 'POST') posted = request.postData() ?? ''; });
    try {
      await page.goto(f.url);
      await expect(page.locator('body')).toContainText('too large to edit here');
      await expect(page.locator('textarea[readonly]')).toHaveValue(fixture.body);
      await expect(page.getByRole('checkbox')).toBeChecked();
      await expect(page.getByRole('checkbox')).toBeDisabled();
      await expect(page.locator('[name^="edit."],[name="edit_form"]')).toHaveCount(0);
      expect(await answer(page, fixture.choice)).toBe(200);
      expect(Buffer.byteLength(posted, 'utf8')).toBeLessThanOrEqual(DEFAULT_BUDGET);
      expect(f.replies).toEqual([{ ask_id: ASK_ID, option: fixture.choice.toLowerCase(), via: 'telegram' }]);
      expect(f.overrides).toHaveLength(0);
      expect(f.item.args).toEqual({ body: fixture.body, notify_visitor: true });
    } finally { await f.close(); }
  });
}

test('an oversized edit remains rejected and recovers through GET with the original channel', async ({ page }) => {
  const f = await startPage('Original notes');
  try {
    await page.goto(f.url); await page.locator('[name="edit.body"]').fill('x'.repeat(18_000));
    expect(await answer(page, 'Approve')).toBe(413);
    await expect(page.getByRole('heading', { name: 'This form is too large', exact: true })).toBeVisible();
    await expect(page.locator('form,[name="form_nonce"]')).toHaveCount(0);
    expect(f.issued()).toBe(1); expect(f.replies).toHaveLength(0); expect(f.overrides).toHaveLength(0);
    expect(f.item.args.body).toBe('Original notes');
    expect(await reopen(page)).toBe(200);
    await expect(page.locator('[name="edit.body"]')).toHaveValue('Original notes');
    await expect(page.locator('[name="via"]')).toHaveValue('telegram');
    expect(await answer(page, 'Deny')).toBe(200);
    expect(f.replies).toEqual([{ ask_id: ASK_ID, option: 'deny', via: 'telegram' }]);
    expect(f.overrides).toHaveLength(0);
  } finally { await f.close(); }
});

test('oversized-edit recovery still respects the decision-link lifetime', async ({ page }) => {
  const f = await startPage('Original notes');
  try {
    await page.goto(f.url); await page.locator('[name="edit.body"]').fill('x'.repeat(18_000));
    f.setNow(NOW + ASK_LANDING_LINK_TTL_MS + 1);
    expect(await answer(page, 'Approve')).toBe(413);
    expect(await reopen(page)).toBe(404);
    await expect(page.getByRole('heading', { name: 'No longer available', exact: true })).toBeVisible();
    expect(f.issued()).toBe(1); expect(f.replies).toHaveLength(0); expect(f.overrides).toHaveLength(0);
    expect((await f.asks.get(ASK_ID))?.status).toBe('open');
  } finally { await f.close(); }
});

test('an edit that fits a smaller configured budget still reaches the typed approval path', async ({ page }) => {
  const f = await startPage('Original notes', 512);
  let posted = '';
  page.on('request', request => { if (request.method() === 'POST') posted = request.postData() ?? ''; });
  try {
    await page.goto(f.url); await page.locator('[name="edit.body"]').fill('Updated é😀');
    expect(await answer(page, 'Approve')).toBe(200);
    expect(Buffer.byteLength(posted, 'utf8')).toBeLessThanOrEqual(512);
    expect(f.overrides).toEqual([{ body: 'Updated é😀' }]);
    expect(f.replies).toHaveLength(0);
    expect(f.item.args.notify_visitor).toBe(true);
  } finally { await f.close(); }
});
