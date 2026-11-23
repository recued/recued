import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import type { InboxItem } from '@recued/contracts';
import { createAskStore, type InboundReply, type PendingAsk } from '@recued/notification';
import { createInMemoryCollection } from '@recued/storage';
import { ASK_LANDING_EDIT_TTL_MS, createAskLandingPortHandler } from '../../../backend/server/src/ask-landing-port.js';
import { createAskLandingEditApproval } from '../../../backend/server/src/ask-landing-edit-approval.js';
import { buildAskLandingDetails } from '../../../backend/server/src/ask-landing-held-op-details.js';
import { createInMemoryAskLandingNonceStore } from '../../../backend/server/src/ask-landing-nonce-store.js';
import { allowingAskLandingAbuseDeps } from '../../../backend/server/src/__tests__/ask-landing-test-helpers.js';

// Real native forms, handler, renderer, ask/nonce stores, detail builder and
// edit approver. Release and channel callbacks record only local fixture data.
test.use({ javaScriptEnabled: false });
const NOW = 1_700_000_000_000;
const ASK_ID = 'ask-checkbox-fixture';

const startPage = async (options: { checked?: boolean; nowAt?: number; offerSession?: boolean } = {}) => {
  let clock = options.nowAt ?? NOW;
  const asks = createAskStore(createInMemoryCollection<PendingAsk>());
  await asks.create({ ask_id: ASK_ID, message: { title: 'Approve fixture booking', text: 'Review this local fixture.' },
    options: [{ id: 'approve', label: 'Approve' },
      ...(options.offerSession ? [{ id: 'allow_session', label: 'Allow this session' }] : []),
      { id: 'deny', label: 'Deny' }],
    handler_kind: 'gateway.preflight', handler_payload: { checkpoint_id: 'fixture-hold' },
    fanout_channels: ['telegram'], created_at: NOW,
  });
  const item: InboxItem = { hold_id: 'fixture-hold', operation_id: 'reception-scheduling.scheduling.materialize',
    top_tier_kind: 'booking', source: { kind: 'scheduling_link', record_ref: 'fixture-request' },
    args: { notify_visitor: options.checked ?? true },
    arg_schema: { fields: [{ key: 'notify_visitor', type: 'boolean', label: 'Tell the visitor' }] },
    preview: { title: 'Fixture booking' }, proposed_action: 'Create a booking', status: 'pending',
  };
  const replies: InboundReply[] = [], overrides: Record<string, unknown>[] = [];
  const handler = createAskLandingPortHandler({
    getAsk: id => asks.get(id), getVerificationPhrase: async () => undefined,
    submitAnswer: async reply => {
      await asks.recordAnswer(ASK_ID, { option: reply.option, answered_at: clock }, reply.via);
      replies.push(reply);
    },
    submitEditedApproval: createAskLandingEditApproval({
      findHoldItem: async id => id === item.hold_id ? item : null, timeZone: 'UTC',
      approve: async input => {
        Object.assign(item.args, input.edits);
        await asks.recordAnswer(ASK_ID, { option: 'approve', answered_at: clock }, 'telegram');
        overrides.push(input.edits);
        return { released: true };
      },
    }),
    resolveDetails: async () => buildAskLandingDetails(item, { editable: true, timeZone: 'UTC' }),
    nonceStore: createInMemoryAskLandingNonceStore(), now: () => clock, abuse: allowingAskLandingAbuseDeps(),
  });
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 503; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ask listener');
  return { asks, item, replies, overrides,
    url: `http://127.0.0.1:${address.port}/ask/${ASK_ID}?via=telegram`,
    setNow: (value: number) => { clock = value; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
};

const answer = async (page: Page, choice: string) => {
  const button = page.getByRole('button', { name: choice, exact: true });
  if (await button.count()) await button.focus();
  else {
    await page.getByRole('radio', { name: choice, exact: true }).focus();
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Submit response', exact: true }).focus();
  }
  await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 10_000 }), page.keyboard.press('Enter')]);
};
const uncheck = async (page: Page) => {
  const box = page.getByRole('checkbox');
  await expect(box).toBeChecked();
  await box.focus(); await page.keyboard.press('Space');
  await expect(box).not.toBeChecked();
};

test('unchecking the only checkbox applies false through the edit approver', async ({ page }) => {
  const f = await startPage();
  try {
    await page.goto(f.url); await uncheck(page); await answer(page, 'Approve');
    await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
    expect(f.item.args.notify_visitor).toBe(false);
    expect(f.overrides).toEqual([{ notify_visitor: false }]);
    expect(f.replies).toHaveLength(0);
  } finally { await f.close(); }
});

test('an unchanged unchecked checkbox stays in the edit path without a spurious override', async ({ page }) => {
  const f = await startPage({ checked: false });
  try {
    await page.goto(f.url); await answer(page, 'Approve');
    await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
    expect(f.overrides).toEqual([{}]);
    expect(f.item.args.notify_visitor).toBe(false);
    expect(f.replies).toHaveLength(0);
  } finally { await f.close(); }
});

test('an unchecked-only submission crossing the edit deadline is refused before a plain-answer retry', async ({ page }) => {
  const f = await startPage({ nowAt: NOW + ASK_LANDING_EDIT_TTL_MS - 60_000 });
  try {
    await page.goto(f.url);
    const originalNonce = await page.locator('[name="form_nonce"]').inputValue();
    await uncheck(page); f.setNow(NOW + ASK_LANDING_EDIT_TTL_MS + 60_000);
    await answer(page, 'Approve');
    await expect(page.locator('body')).toContainText('This link can no longer be used to change the request.');
    expect((await f.asks.get(ASK_ID))?.status).toBe('open');
    expect(f.item.args.notify_visitor).toBe(true);
    expect(f.overrides).toHaveLength(0); expect(f.replies).toHaveLength(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.locator('[name="edit_form"]')).toHaveCount(0);
    expect(await page.locator('[name="form_nonce"]').inputValue()).not.toBe(originalNonce);
    await answer(page, 'Approve');
    await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
    expect(f.replies).toEqual([{ ask_id: ASK_ID, option: 'approve', via: 'telegram' }]);
    expect(f.item.args.notify_visitor).toBe(true); expect(f.overrides).toHaveLength(0);
  } finally { await f.close(); }
});

test('Deny ignores the unchecked edit form and never applies its changes', async ({ page }) => {
  const f = await startPage();
  try {
    await page.goto(f.url); await uncheck(page); await answer(page, 'Deny');
    await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
    expect(f.replies).toEqual([{ ask_id: ASK_ID, option: 'deny', via: 'telegram' }]);
    expect(f.item.args.notify_visitor).toBe(true); expect(f.overrides).toHaveLength(0);
  } finally { await f.close(); }
});

test('an unchecked-only edit form cannot turn into session allowance', async ({ page }) => {
  const f = await startPage({ offerSession: true });
  try {
    await page.goto(f.url); await uncheck(page); await answer(page, 'Allow this session');
    await expect(page.locator('body')).toContainText('Changing a value cannot be combined with allowing this session');
    expect((await f.asks.get(ASK_ID))?.status).toBe('open');
    expect(f.item.args.notify_visitor).toBe(true);
    expect(f.replies).toHaveLength(0); expect(f.overrides).toHaveLength(0);
    await answer(page, 'Deny');
    expect((await f.asks.get(ASK_ID))?.answer?.option).toBe('deny');
    expect(f.overrides).toHaveLength(0);
  } finally { await f.close(); }
});
