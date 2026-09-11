import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { PREAPPROVAL_NOTIFICATION_HANDLER } from '@recued/contracts';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk, type UiNotificationEvent } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createPreapprovalNotifications } from '../preapproval-notifications.js';
import { handlePendingAsks } from '../history-handler.js';
import { compoundPlan, decisionInput, ownerResponder, repositoryFixture } from './d-261-fixtures.js';

const harness = () => {
  const db = new Database(':memory:');
  const fixture = repositoryFixture(db);
  const boot = () => {
    const events: UiNotificationEvent[] = [];
    const block = createNotificationBlock({
      askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
      channels: [createUiChannel({ busSink: event => events.push(event) })], now: () => fixture.state.now,
      askAnswerLink: askId => `https://public.example/ask/${askId}`,
    });
    const notifications = createPreapprovalNotifications({ repository: fixture.repository, block,
      reviewLink: id => `/preapproval/${id}` });
    return { block, notifications, events };
  };
  return { db, ...fixture, boot };
};

describe('D-261 protected notification decision projection', () => {
  it('rejects forged reserved handler payloads before a prompt is created', async () => {
    const h = harness();
    try {
      const { block } = h.boot();
      const proposal = await h.repository.prepare(compoundPlan(), true);
      const prompt = h.repository.reservePrompt(proposal.proposal_id)!;
      const { ask_id, ...payload } = prompt;
      await expect(block.ask({ title: 'Forged review', text: '' }, [{ id: 'approve', label: 'Approve' }],
        { kind: PREAPPROVAL_NOTIFICATION_HANDLER, payload }, { intent: 'interactive' }, { reserved_ask_id: ask_id }))
        .rejects.toMatchObject({ code: 'preapproval_invalid_proof' });
      expect(await block.listOpenAsks()).toEqual([]);
      expect(() => block.registerAskHandler(PREAPPROVAL_NOTIFICATION_HANDLER, () => {}))
        .toThrow(/no generic answer handler/);
    } finally { h.db.close(); }
  });

  it('uses one ask and one owner decision for an operation and its required attachment read', async () => {
    const h = harness();
    try {
      const { block, notifications } = h.boot();
      const proposal = await h.repository.prepare(compoundPlan(), true);
      await Promise.all([notifications.project(proposal.proposal_id), notifications.project(proposal.proposal_id)]);
      const asks = await block.listOpenAsks();
      expect(asks).toHaveLength(1);
      const ask = asks[0]!;
      const projected = await handlePendingAsks({ listOpenAsks: () => block.listOpenAsks() });
      expect(projected.asks).toMatchObject([{ ask_id: ask.ask_id, options: [],
        owner_review: { kind: 'preapproval', proposal_id: proposal.proposal_id } }]);
      expect(ask.handler_kind).toBe(PREAPPROVAL_NOTIFICATION_HANDLER);
      expect(JSON.stringify(ask)).not.toContain('public.example');
      for (const via of ['ui', 'telegram'] as const) {
        await expect(block.submitAnswer({ ask_id: ask.ask_id, option: 'approve', via }))
          .rejects.toMatchObject({ code: 'preapproval_invalid_proof' });
      }
      await expect(block.cancelAsk(ask.ask_id)).rejects.toMatchObject({ code: 'preapproval_invalid_proof' });
      expect((await block.getAsk(ask.ask_id))?.status).toBe('open');
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_grants').get()).toEqual({ n: 0 });
      const decision = await decisionInput(h.repository, proposal.proposal_id);
      await h.repository.decide(decision, ownerResponder);
      await notifications.project(proposal.proposal_id);
      expect((await block.getAsk(ask.ask_id))).toMatchObject({ status: 'handled', answer: { option: 'approve' } });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_grants').get()).toEqual({ n: 1 });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_members').get()).toEqual({ n: 2 });
      expect(h.repository.listPrompts(proposal.proposal_id)).toHaveLength(1);
    } finally { h.db.close(); }
  });

  it('recovers the same durable prompt after restart through the protected coordinator', async () => {
    const h = harness();
    try {
      const first = h.boot();
      const proposal = await h.repository.prepare(compoundPlan(), true);
      await first.notifications.project(proposal.proposal_id);
      const askId = (await first.block.listOpenAsks())[0]!.ask_id;
      const second = h.boot();
      await second.block.recoverPendingAsks();
      expect(second.events).toEqual([]);
      await second.notifications.project(proposal.proposal_id);
      expect((await second.block.listOpenAsks()).map(ask => ask.ask_id)).toEqual([askId]);
      expect(second.events.length).toBeGreaterThan(0);
      const request = await decisionInput(h.repository, proposal.proposal_id);
      await h.repository.decide({ ...request, decision: 'deny' }, ownerResponder);
      await second.notifications.project(proposal.proposal_id);
      expect((await second.block.getAsk(askId))).toMatchObject({ status: 'handled', answer: { option: 'deny' } });
    } finally { h.db.close(); }
  });

  it('retires the old prompt when selection changes and closes expired reviews from durable state', async () => {
    const h = harness();
    try {
      const { block, notifications } = h.boot();
      const plan = compoundPlan();
      const proposal = await h.repository.prepare(plan, true);
      await notifications.project(proposal.proposal_id);
      const oldId = (await block.listOpenAsks())[0]!.ask_id;
      await h.repository.select({ proposal_id: proposal.proposal_id, expected_revision: proposal.revision,
        member_ids: plan.members.map(member => member.member_id) }, ownerResponder);
      await notifications.project(proposal.proposal_id);
      expect((await block.getAsk(oldId))).toMatchObject({ status: 'handled' });
      expect((await block.getAsk(oldId))?.answer).toBeUndefined();
      expect(await block.listOpenAsks()).toHaveLength(1);
      h.state.now = 9_001;
      await notifications.project(proposal.proposal_id);
      expect(await block.listOpenAsks()).toEqual([]);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_grants').get()).toEqual({ n: 0 });
    } finally { h.db.close(); }
  });

  it('retains the committed owner decision when notification projection fails and retries it without reactivation', async () => {
    const h = harness();
    try {
      const { block, notifications } = h.boot();
      const proposal = await h.repository.prepare(compoundPlan(), true);
      await notifications.project(proposal.proposal_id);
      const askId = (await block.listOpenAsks())[0]!.ask_id;
      await h.repository.decide(await decisionInput(h.repository, proposal.proposal_id), ownerResponder);
      h.db.exec(`CREATE TRIGGER fail_ask_projection BEFORE INSERT ON pending_asks
        BEGIN SELECT RAISE(ABORT, 'projection unavailable'); END`);
      await expect(notifications.project(proposal.proposal_id)).rejects.toThrow('projection unavailable');
      expect((await block.getAsk(askId))?.status).toBe('open');
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_grants').get()).toEqual({ n: 1 });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM d261_test_activation').get()).toEqual({ n: 1 });
      h.db.exec('DROP TRIGGER fail_ask_projection');
      await notifications.project(proposal.proposal_id);
      expect((await block.getAsk(askId))?.status).toBe('handled');
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM d261_test_activation').get()).toEqual({ n: 1 });
    } finally { h.db.close(); }
  });
});
