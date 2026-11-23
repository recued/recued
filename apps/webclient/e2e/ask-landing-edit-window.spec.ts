import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { createAskStore, type InboundReply, type PendingAsk } from '@recued/notification';
import { createInMemoryCollection } from '@recued/storage';
import type { InboxItem } from '@recued/contracts';
import { ASK_LANDING_EDIT_TTL_MS, createAskLandingPortHandler } from '../../../backend/server/src/ask-landing-port.js';
import { createInMemoryAskLandingNonceStore } from '../../../backend/server/src/ask-landing-nonce-store.js';
import { createAskLandingEditApproval } from '../../../backend/server/src/ask-landing-edit-approval.js';
import { buildAskLandingDetails } from '../../../backend/server/src/ask-landing-held-op-details.js';
import { allowingAskLandingAbuseDeps } from '../../../backend/server/src/__tests__/ask-landing-test-helpers.js';

// Native forms against the real HTTP handler, renderer, AskStore and nonce
// store, production detail builder and edit approver. The final release callback
// records fixture answers locally, without providers.
test.use({ javaScriptEnabled: false });
const NOW = 1_700_000_000_000;
const ASK_ID = 'ask-browser-edit-window';
const ORIGINAL_SLOT = '20 Jul 2026, 19:30 CEST';
const ORIGINAL_EPOCH = Date.UTC(2026, 6, 20, 17, 30);

const startEditPage = async (nowAt: number) => {
  const asks = createAskStore(createInMemoryCollection<PendingAsk>());
  await asks.create({ ask_id: ASK_ID,
    message: { title: 'Approve fixture booking', text: 'Review this local fixture booking.' },
    options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    handler_kind: 'gateway.preflight', handler_payload: { checkpoint_id: 'fixture-hold' },
    fanout_channels: ['telegram'], created_at: NOW,
  });
  let clock = nowAt;
  const replies: InboundReply[] = [];
  const edited: Array<{ hold_id: string; ask_id: string; edits: Record<string, unknown> }> = [];
  const item: InboxItem = { hold_id: 'fixture-hold', operation_id: 'reception-scheduling.scheduling.materialize',
    top_tier_kind: 'booking', source: { kind: 'scheduling_link', record_ref: 'fixture-request' },
    args: { start_at: ORIGINAL_EPOCH },
    arg_schema: { fields: [{ key: 'start_at', type: 'datetime', label: 'Slot start', required: true }] },
    preview: { title: 'Fixture booking' }, proposed_action: 'Create a booking', status: 'pending',
  };
  const handler = createAskLandingPortHandler({
    getAsk: id => asks.get(id), getVerificationPhrase: async () => undefined,
    submitAnswer: async reply => {
      await asks.recordAnswer(reply.ask_id, { option: reply.option, answered_at: clock }, reply.via);
      replies.push(reply);
    },
    submitEditedApproval: createAskLandingEditApproval({
      findHoldItem: async id => id === item.hold_id ? item : null, timeZone: 'Europe/Paris',
      approve: async input => {
        Object.assign(item.args, input.edits);
        await asks.recordAnswer(ASK_ID, { option: 'approve', answered_at: clock }, input.via);
        edited.push(input);
        return { released: true };
      },
    }),
    nonceStore: createInMemoryAskLandingNonceStore(), now: () => clock,
    abuse: allowingAskLandingAbuseDeps(),
    resolveDetails: async () => buildAskLandingDetails(item, { editable: true, timeZone: 'Europe/Paris' }),
  });
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 503; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ask listener');
  return { asks, replies, edited, item,
    url: `http://127.0.0.1:${address.port}/ask/${ASK_ID}?via=telegram`,
    setNow: (value: number) => { clock = value; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
};

const focusChoice = async (page: Page, choice: 'Approve' | 'Deny') => {
  const button = page.getByRole('button', { name: choice, exact: true });
  if (await button.count()) { await button.focus(); return; }
  await page.getByRole('radio', { name: choice, exact: true }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Submit response', exact: true }).focus();
};
const submitChoice = async (page: Page, choice: 'Approve' | 'Deny') => {
  await focusChoice(page, choice);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 10_000 }), page.keyboard.press('Enter')]);
};

test('a fresh link after the edit deadline shows original values and submits a plain approval', async ({ page }) => {
  const fixture = await startEditPage(NOW + 25 * 60 * 60 * 1000);
  try {
    expect((await page.goto(fixture.url))?.status()).toBe(200);
    await expect(page.locator('body')).toContainText(ORIGINAL_SLOT);
    await expect(page.locator('[name^="edit."]')).toHaveCount(0);
    await submitChoice(page, 'Approve');
    await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
    expect(fixture.replies).toEqual([{ ask_id: ASK_ID, option: 'approve', via: 'telegram' }]);
    expect(fixture.edited).toHaveLength(0);
    expect((await fixture.asks.get(ASK_ID))?.answer?.option).toBe('approve');
  } finally { await fixture.close(); }
});

test('a form crossing the edit deadline refuses changes then offers a native plain-answer retry', async ({ page }) => {
  const fixture = await startEditPage(NOW + ASK_LANDING_EDIT_TTL_MS - 60_000);
  try {
    await page.goto(fixture.url);
    const originalNonce = await page.locator('[name="form_nonce"]').inputValue();
    await page.locator('[name="edit.start_at"]').fill('2026-07-20T20:00');
    fixture.setNow(NOW + ASK_LANDING_EDIT_TTL_MS + 60_000);
    await submitChoice(page, 'Approve');
    await expect(page.locator('body')).toContainText('This link can no longer be used to change the request.');
    await expect(page.locator('body')).toContainText(ORIGINAL_SLOT);
    await expect(page.locator('[name^="edit."]')).toHaveCount(0);
    await expect(page.locator('[name="via"]')).toHaveValue('telegram');
    expect(await page.locator('[name="form_nonce"]').inputValue()).not.toBe(originalNonce);
    expect((await fixture.asks.get(ASK_ID))?.status).toBe('open');
    expect(fixture.replies).toHaveLength(0);
    expect(fixture.edited).toHaveLength(0);
    // Declining is still a plain answer, and the fresh form keeps provenance.
    await submitChoice(page, 'Deny');
    await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
    expect(fixture.replies).toEqual([{ ask_id: ASK_ID, option: 'deny', via: 'telegram' }]);
    expect(fixture.edited).toHaveLength(0);
    expect((await fixture.asks.get(ASK_ID))?.answer?.option).toBe('deny');
  } finally { await fixture.close(); }
});

test('editing and approving inside the edit window still submits the chosen values', async ({ page }) => {
  const fixture = await startEditPage(NOW + 23 * 60 * 60 * 1000);
  try {
    await page.goto(fixture.url);
    await page.locator('[name="edit.start_at"]').fill('2026-07-20T20:00');
    await submitChoice(page, 'Approve');
    await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
    expect(fixture.edited).toEqual([{ hold_id: 'fixture-hold', ask_id: ASK_ID, via: 'telegram', edits: { start_at: Date.UTC(2026, 6, 20, 18, 0) } }]);
    expect(fixture.replies).toHaveLength(0);
    expect((await fixture.asks.get(ASK_ID))?.answer?.option).toBe('approve');
  } finally { await fixture.close(); }
});


test('native Deny records a decision with untouched editable fields and never releases the held operation', async ({ page }) => {
  const fixture = await startEditPage(NOW + 23 * 60 * 60 * 1000);
  try {
    await page.goto(fixture.url);
    await expect(page.locator('[name="edit.start_at"]')).toHaveValue('2026-07-20T19:30');
    await submitChoice(page, 'Deny');
    await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
    expect(fixture.replies).toEqual([{ ask_id: ASK_ID, option: 'deny', via: 'telegram' }]);
    expect(fixture.edited).toHaveLength(0);
    expect(fixture.item.args).toEqual({ start_at: ORIGINAL_EPOCH });
    expect((await fixture.asks.get(ASK_ID))?.answer?.option).toBe('deny');
  } finally { await fixture.close(); }
});

test('Approve validates required edits while Deny can refuse the invalid form across the edit deadline', async ({ page }) => {
  const fixture = await startEditPage(NOW + ASK_LANDING_EDIT_TTL_MS - 60_000);
  try {
    await page.goto(fixture.url);
    const field = page.locator('[name="edit.start_at"]');
    await field.fill('');
    // Native constraint validation must still prevent an invalid approval.
    await focusChoice(page, 'Approve');
    await page.keyboard.press('Enter');
    await expect(field).toBeFocused();
    expect((await fixture.asks.get(ASK_ID))?.status).toBe('open');
    expect(fixture.edited).toHaveLength(0);
    expect(fixture.replies).toHaveLength(0);
    // Denying never commits these fields, including from an older form.
    fixture.setNow(NOW + ASK_LANDING_EDIT_TTL_MS + 60_000);
    await submitChoice(page, 'Deny');
    await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
    expect(fixture.replies).toEqual([{ ask_id: ASK_ID, option: 'deny', via: 'telegram' }]);
    expect(fixture.edited).toHaveLength(0);
    expect(fixture.item.args).toEqual({ start_at: ORIGINAL_EPOCH });
    expect((await fixture.asks.get(ASK_ID))?.answer?.option).toBe('deny');
  } finally { await fixture.close(); }
});
