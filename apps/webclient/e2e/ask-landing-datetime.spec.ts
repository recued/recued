import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import type { InboxItem } from '@recued/contracts';
import { createAskStore, type PendingAsk } from '@recued/notification';
import { createInMemoryCollection } from '@recued/storage';
import { createAskLandingPortHandler } from '../../../backend/server/src/ask-landing-port.js';
import { createAskLandingEditApproval } from '../../../backend/server/src/ask-landing-edit-approval.js';
import { buildAskLandingDetails } from '../../../backend/server/src/ask-landing-held-op-details.js';
import { createInMemoryAskLandingNonceStore } from '../../../backend/server/src/ask-landing-nonce-store.js';
import { allowingAskLandingAbuseDeps } from '../../../backend/server/src/__tests__/ask-landing-test-helpers.js';

// Real HTTP handler, renderer, ask/nonce stores, detail builder and edit
// approver. The final release callback applies only local fixture overrides.
test.use({ javaScriptEnabled: false });
const NOW = 1_700_000_000_000;
const ASK_ID = 'ask-datetime-fixture';
const TIME_ZONE = 'Europe/Paris';
const PRECISE_INSTANT = Date.UTC(2026, 6, 20, 17, 30, 45, 123);

const startPage = async (original: number) => {
  const asks = createAskStore(createInMemoryCollection<PendingAsk>());
  await asks.create({ ask_id: ASK_ID, message: { title: 'Approve fixture booking', text: 'Review this local fixture.' },
    options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    handler_kind: 'gateway.preflight', handler_payload: { checkpoint_id: 'fixture-hold' },
    fanout_channels: ['telegram'], created_at: NOW,
  });
  const item: InboxItem = { hold_id: 'fixture-hold', operation_id: 'reception-scheduling.scheduling.materialize',
    top_tier_kind: 'booking', source: { kind: 'scheduling_link', record_ref: 'fixture-request' },
    args: { start_at: original, title: 'Fixture booking' },
    arg_schema: { fields: [{ key: 'start_at', type: 'datetime', label: 'Slot start', required: true },
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
      findHoldItem: async id => id === item.hold_id ? item : null, timeZone: TIME_ZONE,
      approve: async input => {
        Object.assign(item.args, input.edits);
        overrides.push(input.edits);
        await asks.recordAnswer(ASK_ID, { option: 'approve', answered_at: NOW }, 'telegram');
        return { released: true };
      },
    }),
    resolveDetails: async () => buildAskLandingDetails(item, { editable: true, timeZone: TIME_ZONE }),
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
  await page.getByRole('button', { name: 'Approve', exact: true }).focus();
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.keyboard.press('Enter')]);
  await expect(page.getByRole('heading', { name: 'Already answered', exact: true })).toBeVisible();
};

for (const fixture of [
  { name: 'seconds and milliseconds', original: PRECISE_INSTANT, rendered: '2026-07-20T19:30' },
  { name: 'the first repeated-hour instant', original: Date.UTC(2026, 9, 25, 0, 30), rendered: '2026-10-25T02:30' },
  { name: 'the second repeated-hour instant', original: Date.UTC(2026, 9, 25, 1, 30), rendered: '2026-10-25T02:30' },
]) {
  test(`an untouched datetime preserves ${fixture.name} without an override`, async ({ page }) => {
    const f = await startPage(fixture.original);
    try {
      await page.goto(f.url);
      await expect(page.locator('[name="edit.start_at"]')).toHaveValue(fixture.rendered);
      await approve(page);
      expect(f.item.args.start_at).toBe(fixture.original);
      expect(f.overrides).toEqual([{}]);
      expect(f.plainAnswers()).toBe(0);
      expect((await f.asks.get(ASK_ID))?.answer?.option).toBe('approve');
    } finally { await f.close(); }
  });
}

test('changing another field keeps the untouched datetime exact', async ({ page }) => {
  const f = await startPage(PRECISE_INSTANT);
  try {
    await page.goto(f.url);
    await page.locator('[name="edit.title"]').fill('Changed title');
    await approve(page);
    expect(f.item.args.start_at).toBe(PRECISE_INSTANT);
    expect(f.item.args.title).toBe('Changed title');
    expect(f.overrides).toEqual([{ title: 'Changed title' }]);
    expect(f.plainAnswers()).toBe(0);
  } finally { await f.close(); }
});
