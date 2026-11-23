import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { createAskStore, type InboundReply, type PendingAsk } from '@recued/notification';
import { createInMemoryCollection } from '@recued/storage';
import { ASK_LANDING_LINK_TTL_MS, createAskLandingPortHandler } from '../../../backend/server/src/ask-landing-port.js';
import { ASK_LANDING_NONCE_MAX_PER_ASK, ASK_LANDING_NONCE_TTL_MS, createInMemoryAskLandingNonceStore } from '../../../backend/server/src/ask-landing-nonce-store.js';
import { allowingAskLandingAbuseDeps } from '../../../backend/server/src/__tests__/ask-landing-test-helpers.js';

// Real HTTP, shipped renderer/CSP and ask/nonce stores. Controlled time and
// local channel answers reproduce staleness without provider writes.
test.use({ javaScriptEnabled: false });
const NOW = 1_700_000_000_000;
const ASK_ID = 'ask-stale-form-fixture';
const PRIVATE_DETAIL = 'Private fixture held-operation details';

const startPage = async () => {
  let clock = NOW, issued = 0;
  const asks = createAskStore(createInMemoryCollection<PendingAsk>());
  await asks.create({ ask_id: ASK_ID, message: { title: 'Approve fixture', text: 'Review this local fixture decision.' },
    options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    handler_kind: 'gateway.preflight', handler_payload: { checkpoint_id: 'fixture-hold' },
    fanout_channels: ['telegram'], created_at: NOW,
  });
  const nonces = createInMemoryAskLandingNonceStore(), replies: InboundReply[] = [];
  const handler = createAskLandingPortHandler({
    getAsk: id => asks.get(id), getVerificationPhrase: async () => 'Fixture verification phrase',
    submitAnswer: async reply => {
      if ((await asks.get(ASK_ID))?.status !== 'open') return;
      await asks.recordAnswer(ASK_ID, { option: reply.option, answered_at: clock }, reply.via);
      replies.push(reply);
    },
    resolveDetails: async () => ({ details: [{ label: 'Arguments', value: PRIVATE_DETAIL }] }),
    nonceStore: {
      issue: (id, now) => { issued++; return nonces.issue(id, now); },
      consume: (id, nonce, now) => nonces.consume(id, nonce, now),
    },
    now: () => clock, abuse: allowingAskLandingAbuseDeps(),
  });
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 503; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ask listener');
  return { asks, replies, issued: () => issued,
    url: `http://127.0.0.1:${address.port}/ask/${ASK_ID}?via=telegram`,
    setNow: (value: number) => { clock = value; },
    answerElsewhere: () => asks.recordAnswer(ASK_ID, { option: 'deny', answered_at: clock }, 'ui'),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
};

const answer = async (page: Page, choice: 'Approve' | 'Deny') => {
  await page.getByRole('radio', { name: choice, exact: true }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Submit response', exact: true }).focus();
  const [response] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.keyboard.press('Enter')]);
  return response?.status();
};
const expectRecovery = async (page: Page) => {
  await expect(page.getByRole('heading', { name: 'This form is no longer current', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Reopen decision', exact: true })).toBeVisible();
  await expect(page.locator('form,[name="form_nonce"]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(PRIVATE_DETAIL);
};
const reopen = async (page: Page) => {
  await page.getByRole('link', { name: 'Reopen decision', exact: true }).focus();
  const [response] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.keyboard.press('Enter')]);
  return response?.status();
};

test('an expired form reopens through GET and requires a new choice with the original channel', async ({ page }) => {
  const f = await startPage();
  try {
    await page.goto(f.url);
    const originalNonce = await page.locator('[name="form_nonce"]').inputValue();
    f.setNow(NOW + ASK_LANDING_NONCE_TTL_MS + 1);
    expect(await answer(page, 'Approve')).toBe(403);
    await expectRecovery(page);
    expect(f.issued()).toBe(1); expect(f.replies).toHaveLength(0);
    expect((await f.asks.get(ASK_ID))?.status).toBe('open');
    expect(await reopen(page)).toBe(200);
    expect(await page.locator('[name="form_nonce"]').inputValue()).not.toBe(originalNonce);
    await expect(page.locator('[name="via"]')).toHaveValue('telegram');
    await expect(page.getByRole('radio', { name: 'Approve', exact: true })).not.toBeChecked();
    expect(f.replies).toHaveLength(0);
    expect(await answer(page, 'Deny')).toBe(200);
    expect(f.replies).toEqual([{ ask_id: ASK_ID, option: 'deny', via: 'telegram' }]);
  } finally { await f.close(); }
});

test('an evicted form nonce can recover without accepting the rejected submission', async ({ page, request }) => {
  const f = await startPage();
  try {
    await page.goto(f.url);
    for (let i = 0; i < ASK_LANDING_NONCE_MAX_PER_ASK; i++) expect((await request.get(f.url)).status()).toBe(200);
    const issuedBeforePost = f.issued();
    expect(await answer(page, 'Approve')).toBe(403);
    await expectRecovery(page);
    expect(f.issued()).toBe(issuedBeforePost); expect(f.replies).toHaveLength(0);
    expect(await reopen(page)).toBe(200);
    expect(await answer(page, 'Approve')).toBe(200);
    expect(f.replies).toEqual([{ ask_id: ASK_ID, option: 'approve', via: 'telegram' }]);
  } finally { await f.close(); }
});

test('reopening a stale form shows the answer recorded by another channel', async ({ page }) => {
  const f = await startPage();
  try {
    await page.goto(f.url); f.setNow(NOW + ASK_LANDING_NONCE_TTL_MS + 1); await f.answerElsewhere();
    expect(await answer(page, 'Approve')).toBe(403); await expectRecovery(page);
    expect(await reopen(page)).toBe(200);
    await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
    await expect(page.locator('body')).toContainText('Response recorded: Deny via ui');
    await expect(page.locator('body')).not.toContainText(PRIVATE_DETAIL);
    await expect(page.locator('form,[name="form_nonce"]')).toHaveCount(0);
    expect(f.replies).toHaveLength(0); expect(f.issued()).toBe(1);
  } finally { await f.close(); }
});

test('reopening a stale form respects link expiry while leaving the decision open elsewhere', async ({ page }) => {
  const f = await startPage();
  try {
    await page.goto(f.url); f.setNow(NOW + ASK_LANDING_LINK_TTL_MS + 1);
    expect(await answer(page, 'Approve')).toBe(403); await expectRecovery(page);
    expect(await reopen(page)).toBe(404);
    await expect(page.getByRole('heading', { name: 'No longer available', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(PRIVATE_DETAIL);
    await expect(page.locator('form,[name="form_nonce"]')).toHaveCount(0);
    expect(f.replies).toHaveLength(0); expect(f.issued()).toBe(1);
    expect((await f.asks.get(ASK_ID))?.status).toBe('open');
  } finally { await f.close(); }
});
