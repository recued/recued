import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MESSENGER_PRINCIPAL_CONFIG_KEY, RpcError } from '@recued/contracts';
import { createNotificationSettingsStore, type NotificationSettings } from '@recued/notification';
import { createPreapprovalTelegramIngress } from '../preapproval-telegram-ingress.js';
import { composeInboundAnswerDispatcher } from '../composition/bin/wire-inbound-answer-dispatcher.js';
import { compoundPlan, decisionInput, ownerResponder, preparedMember, preparedPlan, repositoryFixture } from './d-261-fixtures.js';
import type { PreapprovalPrompt, PreapprovalRepository } from '../storage/preapproval-repository.js';
import { createPreapprovalTelegramDelivery } from '../preapproval-telegram-delivery.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { encodePlaintextAuth } from './d-163-remote-channel-test-helpers.js';

const harness = () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE test_owner(connection_id TEXT, sender TEXT); INSERT INTO test_owner VALUES('telegram', '42')");
  const state = { now: 1_000, locked: false };
  const boot = () => {
    const fixture = repositoryFixture(db, state, {
      validateResponder(responder) {
        if (responder.channel === 'webclient' && responder.key === ownerResponder.key) return;
        if (responder.channel === 'telegram' && db.prepare('SELECT 1 FROM test_owner WHERE connection_id = ? AND sender = ?')
          .get(responder.connection_id, responder.owner_sender)) return;
        throw new RpcError('preapproval_invalid_proof', 'The messaging account is not the current owner.', 403);
      },
    });
    const ingress = createPreapprovalTelegramIngress(fixture.repository);
    const { messengerDispatchers } = composeInboundAnswerDispatcher({ preapprovalReview: ingress });
    const receive = (prompt: PreapprovalPrompt, options: {
      sender?: string; conversation?: string; message?: number; event?: number; decision?: string; connection?: string;
    } = {}) => {
      const event = { connection_name: options.connection ?? 'telegram',
      update_id: String(options.event ?? 90), payload: { update_id: options.event ?? 90, callback_query: {
        id: `callback-${options.event ?? 90}`, data: `${prompt.ask_id}|${options.decision ?? 'approve'}`,
        from: { id: options.sender ?? '42', is_bot: false },
        message: { message_id: options.message ?? 700, chat: { id: options.conversation ?? '42' } },
      } } };
      return messengerDispatchers.telegram!(event);
    };
    return { ...fixture, ingress, receive };
  };
  const prepare = async (plan = compoundPlan()) => {
    const runtime = boot();
    const proposal = await runtime.repository.prepare(plan, true);
    const prompt = runtime.repository.reservePrompt(proposal.proposal_id)!;
    const recordDelivery = () => runtime.repository.recordDelivery(prompt, {
      connection_id: 'telegram', owner_sender: '42', conversation_id: '42', vendor_message_id: '700',
    });
    return { ...runtime, proposal, prompt, recordDelivery };
  };
  return { db, state, boot, prepare };
};

const deliveryHarness = async (h: ReturnType<typeof harness>, repository: PreapprovalRepository) => {
  const connections = createConnectionStore(h.db);
  connections.upsert({ kind: 'notification', name: 'telegram', display_name: 'Owner Telegram',
    config_json: JSON.stringify({ chat_id: '42', [MESSENGER_PRINCIPAL_CONFIG_KEY]: '42' }),
    auth_ciphertext: encodePlaintextAuth({ type: 'bearer', token: 'test-bot-token' }), enrolled_at: 1, updated_at: 1 });
  const settings = createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(h.db, 'notification_settings'));
  await settings.setChannelMode('telegram', { notification: true, approval: true });
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 700 } }), { status: 200 });
  };
  const delivery = createPreapprovalTelegramDelivery({ repository, connectionStore: connections,
    block: { getNotificationSettings: () => settings.get() }, reviewLink: id => `https://paired.example/preapproval/${id}`,
    transportOptions: { fetchImpl } });
  return { delivery, requests };
};

describe('D-261 Telegram owner delivery binding', () => {
  it('refuses early, forwarded, wrong-sender and wrong-connection callbacks before any activation', async () => {
    const h = harness();
    try {
      const f = await h.prepare();
      await expect(f.receive(f.prompt)).rejects.toMatchObject({ code: 'preapproval_invalid_proof' });
      f.recordDelivery();
      for (const options of [{ sender: 'someone-else' }, { conversation: 'other-chat' }, { message: 701 }, { connection: 'other-bot' }]) {
        await expect(f.receive(f.prompt, options)).rejects.toMatchObject({ code: 'preapproval_invalid_proof' });
      }
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_grants').get()).toEqual({ n: 0 });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM d261_test_activation').get()).toEqual({ n: 0 });
    } finally { h.db.close(); }
  });

  it('uses the persistent delivery after restart and deduplicates the vendor event without a new challenge', async () => {
    const h = harness();
    try {
      const f = await h.prepare();
      f.recordDelivery();
      const afterRestart = h.boot();
      await afterRestart.receive(f.prompt);
      await afterRestart.receive(f.prompt);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_grants').get()).toEqual({ n: 1 });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM d261_test_activation').get()).toEqual({ n: 1 });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_vendor_decisions').get()).toEqual({ n: 1 });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_challenges').get()).toEqual({ n: 0 });
      await expect(afterRestart.receive(f.prompt, { decision: 'deny' })).rejects.toMatchObject({ code: 'preapproval_decision_conflict' });
    } finally { h.db.close(); }
  });

  it('rechecks the current owner enrollment and rejects a callback for an obsolete selection', async () => {
    const h = harness();
    try {
      const f = await h.prepare();
      f.recordDelivery();
      h.db.prepare("UPDATE test_owner SET sender = 'new-owner'").run();
      await expect(f.receive(f.prompt)).rejects.toMatchObject({ code: 'preapproval_invalid_proof' });
      h.db.prepare("UPDATE test_owner SET sender = '42'").run();
      const review = await f.repository.review(f.proposal.proposal_id, ownerResponder);
      await f.repository.select({ proposal_id: review.proposal_id, expected_revision: review.revision,
        member_ids: review.selected_member_ids }, ownerResponder);
      await expect(f.receive(f.prompt)).rejects.toMatchObject({ code: 'preapproval_stale' });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_grants').get()).toEqual({ n: 0 });
    } finally { h.db.close(); }
  });

  it('serializes a paired webclient decision against the verified Telegram reply', async () => {
    const h = harness();
    try {
      const f = await h.prepare();
      f.recordDelivery();
      const webRequest = await decisionInput(f.repository, f.proposal.proposal_id);
      const results = await Promise.allSettled([f.repository.decide(webRequest, ownerResponder), f.receive(f.prompt)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_grants').get()).toEqual({ n: 1 });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM d261_test_activation').get()).toEqual({ n: 1 });
    } finally { h.db.close(); }
  });

  it('intercepts the callback before generic notification parsing or model routing can discard its sender', async () => {
    const h = harness();
    try {
      const f = await h.prepare();
      f.recordDelivery();
      const genericParse = vi.fn(() => { throw new Error('Generic parse must not see this decision'); });
      const { messengerDispatchers } = composeInboundAnswerDispatcher({ preapprovalReview: f.ingress,
        messengerChannels: { telegram: { parseInboundReply: genericParse } as never } });
      const event = { connection_name: 'telegram', update_id: '90', payload: {
        callback_query: { id: 'callback-90', data: `${f.prompt.ask_id}|approve`, from: { id: 42 },
          message: { message_id: 700, chat: { id: 42 } } },
      } };
      await messengerDispatchers.telegram!(event);
      expect(genericParse).not.toHaveBeenCalled();
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_grants').get()).toEqual({ n: 1 });
    } finally { h.db.close(); }
  });

  it('delivers a complete material review through the real transport and creates the matching durable callback ticket', async () => {
    const h = harness();
    try {
      const f = await h.prepare();
      const { delivery, requests } = await deliveryHarness(h, f.repository);
      expect(await delivery.deliver(f.proposal.proposal_id)).toBe('review');
      expect(requests).toHaveLength(1);
      const body = requests[0]!.body;
      expect(body.text).toContain('private reviewed content');
      expect(body.text).toContain('frozen-file-1');
      expect(body.text).toContain('mail-account');
      expect(body.text).not.toContain('test-bot-token');
      expect(body.text).not.toContain('trimmed');
      expect(body.reply_markup).toBeDefined();
      expect(f.repository.listDeliveries(f.proposal.proposal_id)).toHaveLength(1);
      expect(await delivery.deliver(f.proposal.proposal_id)).toBe('review');
      expect(requests).toHaveLength(1);
      await h.boot().receive(f.prompt);
      await delivery.close(f.proposal.proposal_id);
      expect(requests[1]!.url).toContain('/editMessageText');
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_grants').get()).toEqual({ n: 1 });
    } finally { h.db.close(); }
  });

  it('sends a webclient review link with no decision buttons or approval ticket when full material cannot fit', async () => {
    const h = harness();
    try {
      const f = await h.prepare(preparedPlan([preparedMember({ input: { body: 'reviewed-content'.repeat(400) } })]));
      const { delivery, requests } = await deliveryHarness(h, f.repository);
      expect(await delivery.deliver(f.proposal.proposal_id)).toBe('link');
      expect(requests).toHaveLength(1);
      expect(requests[0]!.body.text).toContain(`https://paired.example/preapproval/${f.proposal.proposal_id}`);
      expect(requests[0]!.body.reply_markup).toBeUndefined();
      expect(f.repository.listDeliveries(f.proposal.proposal_id)).toEqual([]);
      expect(f.repository.listReviewLinks(f.proposal.proposal_id)).toHaveLength(1);
      expect(await delivery.deliver(f.proposal.proposal_id)).toBe('link');
      expect(requests).toHaveLength(1);
      const restarted = h.boot();
      const afterRestart = await deliveryHarness(h, restarted.repository);
      expect(await afterRestart.delivery.deliver(f.proposal.proposal_id)).toBe('link');
      expect(afterRestart.requests).toHaveLength(0);
      await expect(f.receive(f.prompt)).rejects.toMatchObject({ code: 'preapproval_invalid_proof' });
      await expect(restarted.receive(f.prompt)).rejects.toMatchObject({ code: 'preapproval_invalid_proof' });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_grants').get()).toEqual({ n: 0 });
    } finally { h.db.close(); }
  });
});
