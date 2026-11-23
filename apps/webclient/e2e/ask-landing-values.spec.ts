import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import type { InboxItem } from '@recued/contracts';
import { createAskStore, type PendingAsk } from '@recued/notification';
import { createInMemoryCollection } from '@recued/storage';
import { createAskLandingPortHandler } from '../../../backend/server/src/ask-landing-port.js';
import { createAskLandingEditApproval } from '../../../backend/server/src/ask-landing-edit-approval.js';
import { buildAskLandingDetails } from '../../../backend/server/src/ask-landing-held-op-details.js';
import { createInMemoryAskLandingNonceStore } from '../../../backend/server/src/ask-landing-nonce-store.js';
import { validateEditsAgainstSchema } from '../../../backend/server/src/reception-inbox-handler.js';
import { allowingAskLandingAbuseDeps } from '../../../backend/server/src/__tests__/ask-landing-test-helpers.js';

// Native submissions through the real HTTP handler, renderer, stores, detail
// builder, edit approver and schema validator. Releases stay in local state.
test.use({ javaScriptEnabled: false });
const NOW = 1_700_000_000_000;
const ASK_ID = 'ask-values-fixture';
const startPage = async (original: string | number) => {
  const numeric = typeof original === 'number', key = numeric ? 'quantity' : 'body';
  const asks = createAskStore(createInMemoryCollection<PendingAsk>());
  await asks.create({ ask_id: ASK_ID, message: { title: 'Review fixture request', text: 'Review this local fixture.' },
    options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    handler_kind: 'gateway.preflight', handler_payload: { checkpoint_id: 'fixture-hold' },
    fanout_channels: ['telegram'], created_at: NOW,
  });
  const item: InboxItem = { hold_id: 'fixture-hold', operation_id: 'reception-scheduling.scheduling.materialize',
    top_tier_kind: 'booking', source: { kind: 'scheduling_link', record_ref: 'fixture-request' },
    args: { [key]: original, title: 'Fixture booking' },
    arg_schema: { fields: [{ key, type: numeric ? 'number' : 'string', label: key, required: true,
      ...(numeric ? { validation: { min: 0, max: 10 } } : {}) },
    { key: 'title', type: 'string', label: 'Title', required: true }] },
    preview: { title: 'Fixture booking' }, proposed_action: 'Create a booking', status: 'pending',
  };
  const overrides: Record<string, unknown>[] = [];
  let plainAnswers = 0;
  const handler = createAskLandingPortHandler({
    getAsk: id => asks.get(id), getVerificationPhrase: async () => undefined,
    submitAnswer: async reply => {
      plainAnswers++;
      await asks.recordAnswer(ASK_ID, { option: reply.option, answered_at: NOW }, reply.via);
    },
    submitEditedApproval: createAskLandingEditApproval({
      findHoldItem: async id => id === item.hold_id ? item : null, timeZone: 'UTC',
      approve: async input => {
        const edits = validateEditsAgainstSchema(input.edits, item.arg_schema, 'reception.inbox.approve');
        Object.assign(item.args, edits); overrides.push(edits);
        await asks.recordAnswer(ASK_ID, { option: 'approve', answered_at: NOW }, 'telegram');
        return { released: true };
      },
    }),
    resolveDetails: async () => buildAskLandingDetails(item, { editable: true, timeZone: 'UTC' }),
    nonceStore: createInMemoryAskLandingNonceStore(), now: () => NOW, abuse: allowingAskLandingAbuseDeps(),
  });
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 503; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ask listener');
  return { asks, item, overrides, plainAnswers: () => plainAnswers,
    url: `http://127.0.0.1:${address.port}/ask/${ASK_ID}?via=telegram`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
};

const approve = async (page: Page) => {
  const button = page.getByRole('button', { name: 'Approve', exact: true });
  if (await button.count()) await button.focus();
  else {
    await page.getByRole('radio', { name: 'Approve', exact: true }).focus(); await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Submit response', exact: true }).focus();
  }
  const [response] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.keyboard.press('Enter')]);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
};

for (const fixture of [
  { name: 'LF text while another field changes', original: 'First\nSecond', changeTitle: true },
  { name: 'CRLF text', original: 'First\r\nSecond', changeTitle: false },
  { name: 'a leading blank line', original: '\nFirst\nSecond', changeTitle: false },
  { name: 'CR-only text', original: 'First\rSecond', changeTitle: false },
  { name: 'multiline text above the edit-length limit', original: 'First\n' + 'x'.repeat(4_200), changeTitle: false },
]) {
  test(`an untouched body preserves ${fixture.name}`, async ({ page }) => {
    const f = await startPage(fixture.original);
    try {
      await page.goto(f.url);
      await expect(page.locator('textarea[name="edit.body"]')).toHaveValue(fixture.original.replace(/\r\n?/g, '\n'));
      if (fixture.changeTitle) await page.locator('[name="edit.title"]').fill('Changed title');
      await approve(page);
      expect(f.item.args.body).toBe(fixture.original);
      expect(f.overrides).toEqual([fixture.changeTitle ? { title: 'Changed title' } : {}]);
      expect(f.plainAnswers()).toBe(0);
      expect((await f.asks.get(ASK_ID))?.answer?.option).toBe('approve');
    } finally { await f.close(); }
  });
}

test('deliberately edited multiline content still reaches the typed approval path', async ({ page }) => {
  const f = await startPage('First\nSecond');
  try {
    await page.goto(f.url); await page.locator('[name="edit.body"]').fill(' First\nChanged ');
    await approve(page);
    expect(f.overrides).toEqual([{ body: ' First\r\nChanged ' }]);
    expect(f.item.args.body).toBe(' First\r\nChanged ');
    expect(f.plainAnswers()).toBe(0);
  } finally { await f.close(); }
});

test('an oversized read-only preview retains its leading blank line and original value', async ({ page }) => {
  const original = '\n' + 'x'.repeat(18_000), f = await startPage(original);
  try {
    await page.goto(f.url);
    await expect(page.locator('textarea[readonly]')).toHaveValue(original);
    await expect(page.locator('[name^="edit."],[name="edit_form"]')).toHaveCount(0);
    await approve(page);
    expect(f.item.args.body).toBe(original);
    expect(f.overrides).toEqual([]); expect(f.plainAnswers()).toBe(1);
  } finally { await f.close(); }
});

for (const fixture of [{ name: 'prefilled', original: 2.5 }, { name: 'edited', original: 2 }]) {
  test(`the ${fixture.name} decimal is accepted within the field bounds`, async ({ page }) => {
    const f = await startPage(fixture.original);
    try {
      await page.goto(f.url);
      if (fixture.original !== 2.5) await page.locator('[name="edit.quantity"]').fill('2.5');
      expect(await page.locator('[name="edit.quantity"]').evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(true);
      await approve(page);
      expect(f.item.args.quantity).toBe(2.5);
      expect(f.overrides).toEqual([fixture.original === 2.5 ? {} : { quantity: 2.5 }]);
      expect(f.plainAnswers()).toBe(0);
    } finally { await f.close(); }
  });
}

test('decimal support retains native required and range checks before a valid submission', async ({ page }) => {
  const f = await startPage(2);
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST') posts++; });
  try {
    await page.goto(f.url);
    const input = page.locator('[name="edit.quantity"]');
    for (const invalid of [
      { value: '', flag: 'valueMissing' as const },
      { value: '-0.5', flag: 'rangeUnderflow' as const },
      { value: '10.5', flag: 'rangeOverflow' as const },
    ]) {
      await input.fill(invalid.value);
      expect(await input.evaluate((el: HTMLInputElement, flag) => el.validity[flag], invalid.flag)).toBe(true);
      await page.getByRole('button', { name: 'Approve', exact: true }).focus(); await page.keyboard.press('Enter');
      expect(posts).toBe(0); expect(f.overrides).toHaveLength(0);
      expect((await f.asks.get(ASK_ID))?.status).toBe('open');
    }
    await input.fill('2.5'); await approve(page);
    expect(posts).toBe(1); expect(f.overrides).toEqual([{ quantity: 2.5 }]);
  } finally { await f.close(); }
});
