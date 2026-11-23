import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, type Page } from '@playwright/test';
import { createPreflightAnswerHandler } from '@recued/gateway';
import type { Checkpoint } from '@recued/contracts';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore,
  type Channel, type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createAuditLogStore, createCheckpointStore, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { createSQLiteCollection } from '../../../backend/server/src/sqlite-collection.js';
import { buildAnswerActivities } from '../../../backend/server/src/composition/bin/wire-notification-block.js';
import { createAskLandingPortHandler } from '../../../backend/server/src/ask-landing-port.js';
import { createAskLandingInboxApproval } from '../../../backend/server/src/ask-landing-inbox-approval.js';
import { buildAskLandingDetails } from '../../../backend/server/src/ask-landing-held-op-details.js';
import { createInMemoryAskLandingNonceStore } from '../../../backend/server/src/ask-landing-nonce-store.js';
import { defaultIsReceptionOriginAnchor, findReceptionHoldItem, handleReceptionInboxApprove,
  type ReceptionInboxDeps } from '../../../backend/server/src/reception-inbox-handler.js';
import { allowingAskLandingAbuseDeps } from '../../../backend/server/src/__tests__/ask-landing-test-helpers.js';

// The server's landing/inbox join, real notification block and audit projection,
// and SQLite stores. Channel callbacks are local; no provider actions occur.
test.use({ javaScriptEnabled: false });
const NOW = 1_700_000_000_000, ASK_ID = 'ask-channel-fixture';
const startPage = async (via?: string, editable = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-ask-channel-fixture-'));
  const path = join(dir, 'state.sqlite'), db = new Database(path);
  const audit = createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'audit_log'), createSQLiteCollection<ActivityEntry>(db, 'activity_log'));
  const checkpoints = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
  const asks = createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks'));
  await asks.create({ ask_id: ASK_ID, message: { title: 'Review fixture', text: 'Review this local request.' },
    options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    handler_kind: 'gateway.preflight', handler_payload: { checkpoint_id: 'cp-1', run_id: 'run-1', recipe_id: 'recued-core/reception-scheduling-incoming', gated_step_id: 'materialize' }, fanout_channels: ['ui'], created_at: NOW });
  const ui: Channel = { name: 'ui', capability: 'inline', owns_llm_egress: true,
    deliverNotify: async () => {}, deliverAsk: async () => {}, closeAsk: async () => {} };
  const block = createNotificationBlock({ askStore: asks,
    settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
    channels: [ui], now: () => NOW, recordAnswerAudit: async record => { for (const activity of buildAnswerActivities(record)) await audit.logActivity(activity); } });
  block.registerAskHandler('gateway.preflight', createPreflightAnswerHandler({ checkpointStore: { ...checkpoints, delete: async () => {} }, resumer: { resumeRun: async () => {}, denyRun: async () => {} } }));
  const anchor = { run_id: 'run-1', recipe_id: 'recued-core/reception-scheduling-incoming', recipe_hash: 'hash-1',
    started_at: NOW, finished_at: NOW, duration_ms: 0, commit_status: 'awaiting_approval', config_snapshot: {}, errors: [],
    trigger_url: null, trigger_source: 'reactive', instance_id: null,
    execution_source: { channel: 'reception', actor: 'anonymous', reception_id: 'r1' }, ask_id: ASK_ID, checkpoint_id: 'cp-1' } as unknown as AuditEntry;
  await audit.append(anchor);
  await checkpoints.write({ checkpoint_id: 'cp-1', run_id: 'run-1', recipe_id: anchor.recipe_id, gated_step_id: 'materialize',
    approved_target: { ingredient_slug: 'recued-core/reception-scheduling', operation_id: 'reception-scheduling.scheduling.materialize' },
    step_state: { materialize: { input: { title: 'Original title' } } }, created_at: NOW } as unknown as Checkpoint);
  const inbox: ReceptionInboxDeps = { auditLog: audit, checkpointStore: checkpoints,
    resolveArgEditSchema: () => ({ fields: [{ key: 'title', type: 'string', label: 'Title' }] }),
    resolveSource: () => ({ top_tier_kind: 'booking', source: { kind: 'scheduling_link', record_ref: 'fixture' },
      args: { title: 'Original title' }, preview: { title: 'Fixture' }, proposed_action: 'Create a booking' }),
    isReceptionOrigin: defaultIsReceptionOriginAnchor,
    submitAnswer: async (ask_id, option) => { await block.submitAnswer({ ask_id, option, via: 'ui' }); },
    submitPreparedAnswer: (ask_id, option, prepare) => block.submitAnswer({ ask_id, option, via: 'ui' }, { prepare }),
    subviewStore: { record: () => {}, list: () => [], listDismissedSince: () => [] } as unknown as ReceptionInboxDeps['subviewStore'],
    broadcast: () => {}, now: () => NOW };
  const handler = createAskLandingPortHandler({ getAsk: id => block.getAsk(id), getVerificationPhrase: async () => undefined,
    submitAnswer: async reply => { await block.submitAnswer(reply); },
    submitEditedApproval: createAskLandingInboxApproval({ inbox, submitAnswer: (reply, options) => block.submitAnswer(reply, options), timeZone: 'UTC' }),
    resolveDetails: async () => { const item = await findReceptionHoldItem(inbox, 'cp-1');
      return item ? buildAskLandingDetails(item, { editable, timeZone: 'UTC' }) : null; },
    nonceStore: createInMemoryAskLandingNonceStore(), now: () => NOW, abuse: allowingAskLandingAbuseDeps() });
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 503; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No ask listener');
  return { url: `http://127.0.0.1:${address.port}/ask/${ASK_ID}${via !== undefined ? '?via=' + encodeURIComponent(via) : ''}`,
    readStored: () => {
      const reader = new Database(path, { readonly: true });
      try {
        const ask = reader.prepare('SELECT data FROM pending_asks WHERE key = ?').get(ASK_ID) as { data: string };
        const activity = reader.prepare("SELECT data FROM activity_log WHERE json_extract(data,'$.target') = ?").get(ASK_ID) as { data: string } | undefined;
        const checkpoint = reader.prepare('SELECT data FROM checkpoints WHERE key = ?').get('cp-1') as { data: string };
        return { ask: JSON.parse(ask.data) as PendingAsk, activity: activity ? JSON.parse(activity.data) as ActivityEntry : undefined,
          checkpoint: JSON.parse(checkpoint.data) as Checkpoint };
      } finally { reader.close(); }
    },
    approveInApp: () => handleReceptionInboxApprove(inbox, { hold_id: 'cp-1', edits: {} }, { instance_id: 'paired-fixture' }),
    changeAskBinding: () => audit.append({ ...anchor, ask_id: 'a-different-ask' }),
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
      db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
};
const answer = async (page: Page, choice: 'Approve' | 'Deny') => {
  const button = page.getByRole('button', { name: choice, exact: true });
  if (await button.count()) await button.focus();
  else { await page.getByRole('radio', { name: choice, exact: true }).focus(); await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Submit response', exact: true }).focus(); }
  const [response] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.keyboard.press('Enter')]);
  expect(response?.status()).toBe(200);
};

for (const fixture of [
  { name: 'untouched Telegram approval', via: 'telegram', expected: 'telegram', edit: false },
  { name: 'edited Slack approval', via: 'slack', expected: 'slack', edit: true },
  { name: 'legacy approval link', via: undefined, expected: 'email', edit: false },
  { name: 'invalid channel fallback', via: 'not-a-channel', expected: 'email', edit: true },
]) {
  test(`${fixture.name} retains its channel in SQLite and the confirmation`, async ({ page }) => {
    const f = await startPage(fixture.via);
    try {
      await page.goto(f.url);
      await expect(page.locator('[name="via"]')).toHaveValue(fixture.expected);
      await expect(page.locator('[name="edit.title"]')).toHaveValue('Original title');
      if (fixture.edit) await page.locator('[name="edit.title"]').fill('Edited title');
      await answer(page, 'Approve');
      const stored = f.readStored();
      expect(stored.ask.status).toBe('handled'); expect(stored.ask.answered_via).toBe(fixture.expected);
      expect(stored.activity?.answered_via).toBe(fixture.expected);
      expect(stored.activity?.detail).toContain(`via ${fixture.expected}`);
      expect(stored.checkpoint.arg_overrides).toStrictEqual(fixture.edit ? { title: 'Edited title' } : {});
      await expect(page.locator('.recorded')).toHaveText(`Response recorded: Approve via ${fixture.expected}`);
    } finally { await f.close(); }
  });
}

for (const fixture of [{ choice: 'Deny' as const, editable: true }, { choice: 'Approve' as const, editable: false }]) {
  test(`plain ${fixture.choice} retains its existing channel attribution`, async ({ page }) => {
    const f = await startPage('telegram', fixture.editable);
    try {
      await page.goto(f.url); await answer(page, fixture.choice);
      const stored = f.readStored();
      expect(stored.ask.answered_via).toBe('telegram'); expect(stored.activity?.answered_via).toBe('telegram');
      await expect(page.locator('.recorded')).toHaveText(`Response recorded: ${fixture.choice} via telegram`);
    } finally { await f.close(); }
  });
}

test('a paired app approval retains the UI default', async ({ page }) => {
  const f = await startPage('telegram');
  try {
    await page.goto(f.url); expect((await f.approveInApp()).released).toBe(true); await page.reload();
    const stored = f.readStored();
    expect(stored.ask.answered_via).toBe('ui'); expect(stored.activity?.answered_via).toBe('ui');
    await expect(page.locator('.recorded')).toHaveText('Response recorded: Approve via ui');
  } finally { await f.close(); }
});

test('the landing capability must still match the held operation before edits or answers', async ({ page }) => {
  const f = await startPage('telegram');
  try {
    await page.goto(f.url); await page.locator('[name="edit.title"]').fill('Tampered binding');
    await f.changeAskBinding(); await answer(page, 'Approve');
    const stored = f.readStored();
    expect(stored.ask.status).toBe('open'); expect(stored.activity).toBeUndefined();
    expect(stored.checkpoint.arg_overrides).toBeUndefined();
    await expect(page.locator('.error')).toContainText('could not be approved');
  } finally { await f.close(); }
});
