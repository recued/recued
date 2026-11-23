import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { createAskStore, type InboundReply, type PendingAsk } from '@recued/notification';
import { createInMemoryCollection } from '@recued/storage';
import { ASK_LANDING_LINK_TTL_MS, createAskLandingPortHandler } from '../../../backend/server/src/ask-landing-port.js';
import { ASK_LANDING_NONCE_TTL_MS, createInMemoryAskLandingNonceStore } from '../../../backend/server/src/ask-landing-nonce-store.js';
import { allowingAskLandingAbuseDeps } from '../../../backend/server/src/__tests__/ask-landing-test-helpers.js';

// Real HTTP handler, notification ask store, nonce store and shipped renderer.
// A controlled detail lookup and clock reproduce the asynchronous boundary;
// channel answers are recorded locally without contacting a messaging service.
test.use({ javaScriptEnabled: false });
const NOW = 1_700_000_000_000;
const ASK_ID = 'ask-browser-state';
const PRIVATE_DETAIL = 'Private fixture operation arguments';

const startAskPage = async () => {
  const asks = createAskStore(createInMemoryCollection<PendingAsk>());
  await asks.create({ ask_id: ASK_ID, message: { title: 'Approve fixture', text: 'Review this fixture decision.' },
    options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    handler_kind: 'gateway.preflight', handler_payload: { checkpoint_id: 'fixture-hold' },
    fanout_channels: ['telegram'], created_at: NOW,
  });
  let clock = NOW, start!: () => void, release!: () => void;
  const detailsStarted = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const replies: InboundReply[] = [];
  const handler = createAskLandingPortHandler({
    getAsk: id => asks.get(id), getVerificationPhrase: async () => 'Fixture verification phrase',
    submitAnswer: async reply => {
      if ((await asks.get(reply.ask_id))?.status !== 'open') return;
      await asks.recordAnswer(reply.ask_id, { option: reply.option, answered_at: clock }, reply.via);
      replies.push(reply);
    },
    nonceStore: createInMemoryAskLandingNonceStore(), now: () => clock,
    abuse: allowingAskLandingAbuseDeps(),
    resolveDetails: async () => {
      start(); await gate;
      return { heading: 'Held fixture operation', details: [{ label: 'Arguments', value: PRIVATE_DETAIL }] };
    },
  });
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 503; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ask listener');
  return { asks, replies, detailsStarted, release,
    url: `http://127.0.0.1:${address.port}/ask/${ASK_ID}?via=telegram`,
    setNow: (value: number) => { clock = value; },
    answerElsewhere: () => asks.recordAnswer(ASK_ID, { option: 'approve', answered_at: clock }, 'ui'),
    close: async () => {
      release(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
};

test('an answer arriving while the public approval page loads removes its action controls and held details', async ({ page }) => {
  const fixture = await startAskPage();
  try {
    const navigation = page.goto(fixture.url);
    await fixture.detailsStarted;
    await fixture.answerElsewhere(); fixture.release();
    expect((await navigation)?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
    await expect(page.locator('body')).toContainText('Response recorded: Approve via ui');
    await expect(page.locator('body')).not.toContainText(PRIVATE_DETAIL);
    await expect(page.getByRole('button', { name: 'Submit response', exact: true })).toHaveCount(0);
    await expect(page.locator('[name="form_nonce"]')).toHaveCount(0);
    expect(fixture.replies).toHaveLength(0);
    expect((await fixture.asks.get(ASK_ID))?.status).toBe('answered');
  } finally { await fixture.close(); }
});

test('expiry during a public detail lookup closes only the link and discloses no held operation', async ({ page }) => {
  const fixture = await startAskPage();
  try {
    const navigation = page.goto(fixture.url);
    await fixture.detailsStarted;
    fixture.setNow(NOW + ASK_LANDING_LINK_TTL_MS + 1); fixture.release();
    expect((await navigation)?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'No longer available', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(PRIVATE_DETAIL);
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.locator('[name="form_nonce"]')).toHaveCount(0);
    expect((await fixture.asks.get(ASK_ID))?.status).toBe('open');
    // The owner can still answer through another channel after this URL expires.
    await fixture.answerElsewhere();
    expect((await fixture.asks.get(ASK_ID))?.status).toBe('answered');
    expect(fixture.replies).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('a still-open decision remains answerable after detail loading exceeds the form nonce lifetime', async ({ page }) => {
  const fixture = await startAskPage();
  try {
    const navigation = page.goto(fixture.url);
    await fixture.detailsStarted;
    fixture.setNow(NOW + ASK_LANDING_NONCE_TTL_MS + 1); fixture.release();
    expect((await navigation)?.status()).toBe(200);
    await expect(page.locator('body')).toContainText(PRIVATE_DETAIL);
    await expect(page.locator('[name="form_nonce"]')).toHaveCount(1);
    await page.getByRole('radio', { name: 'Approve', exact: true }).focus();
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Submit response', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
    await expect(page.locator('body')).toContainText('Response recorded: Approve via telegram');
    expect(fixture.replies).toHaveLength(1);
    expect(fixture.replies[0]).toMatchObject({ ask_id: ASK_ID, option: 'approve', via: 'telegram' });
  } finally { await fixture.close(); }
});
