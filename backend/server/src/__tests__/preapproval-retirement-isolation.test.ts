import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { StepMeta } from '@recued/contracts';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { GATED_ACTION_TERMINAL_RETENTION_MS } from '../gated-action-store.js';
import { createCircuitBreakerStore } from '../auto-run-scheduler.js';
import { createPreapprovalActivations } from '../storage/preapproval-activations.js';
import { createPreapprovalNotifications } from '../preapproval-notifications.js';
import { createPreapprovalOutbox } from '../preapproval-outbox.js';
import { createPreapprovalRequestOrigin } from '../preapproval-request-origin.js';
import { recordStep, resourceFixture, resourceFixtureDisposers } from './preapproval-resources-fixture.js';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });
type Fixture = Awaited<ReturnType<typeof resourceFixture>>;
const kernel = (f: Fixture) => {
  const meta: StepMeta = { step_id: 'request-review', execution_source: f.origin.source };
  const origin = createPreapprovalRequestOrigin({ ownerId: 'realm', recipes: f.sources.recipes,
    definitions: f.definitions, clientTokens: f.clients, inboundTokens: f.inbound }, meta);
  return { meta, origin };
};
const authority = (db: Database.Database, ref: string) => ({
  execution: db.prepare(`SELECT future_ref,state,revision,lineage,stop_requested,status_reason,root_run_id,worker_id,fence,updated_at
    FROM preapproval_executions WHERE future_ref=?`).get(ref),
  grants: db.prepare('SELECT * FROM preapproval_grants WHERE future_ref=?').all(ref),
  decisions: db.prepare('SELECT * FROM preapproval_decisions WHERE future_ref=?').all(ref),
  mutations: db.prepare('SELECT * FROM preapproval_mutations WHERE future_ref=?').all(ref),
  members: db.prepare('SELECT * FROM preapproval_members WHERE future_ref=?').all(ref),
});
const snapshot = (f: Fixture, ref: string) => (f.db.prepare('SELECT snapshot_ciphertext FROM preapproval_executions WHERE future_ref=?')
  .get(ref) as { snapshot_ciphertext: string }).snapshot_ciphertext;
const noEffects = (f: Fixture) => {
  expect(f.db.prepare('SELECT count(*) AS n FROM gated_action_receipts').get()).toEqual({ n: 0 });
  expect(f.db.prepare('SELECT count(*) AS n FROM commits').get()).toEqual({ n: 0 });
  for (const id of ['a', 'b']) expect(f.row(id)).toMatchObject({ title: id, _record: { revision: 0 } });
};
const fault = (f: Fixture) => f.db.exec(`CREATE TRIGGER fail_terminal_retention BEFORE UPDATE OF snapshot_ciphertext ON preapproval_executions
  BEGIN SELECT RAISE(ABORT, 'terminal retention unavailable'); END`);
const terminal = async () => {
  const f = await resourceFixture(); f.save([recordStep('a')]);
  const old = await f.service.prepare(f.request(), f.origin);
  const input = await f.decision(old.proposal_id);
  const decision = await f.storage.repository.decide(input, f.responder);
  const approved = await f.storage.repository.inspect(old.proposal_id);
  const mutation = { grant_id: approved.grant!.grant_id, expected_revision: approved.grant!.revision, request_id: randomUUID() };
  await f.storage.repository.revoke(mutation, f.responder);
  await f.composed.outbox.drain(); f.clock.now += GATED_ACTION_TERMINAL_RETENTION_MS + 1;
  return { f, old, input, decision, mutation };
};
const outbox = (f: Fixture, options: { onError?: (error: unknown) => void; maintain?: () => void } = {}) => {
  const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(f.db, 'pending_asks')),
    settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(f.db, 'notification_settings')),
    channels: [createUiChannel({ busSink: () => {} })], now: () => f.clock.now });
  return createPreapprovalOutbox({ storage: f.storage,
    activations: createPreapprovalActivations({ ...f.sources, circuits: createCircuitBreakerStore(f.db),
      now: () => f.clock.now, serverTimeZone: () => undefined }),
    notifications: createPreapprovalNotifications({ repository: f.storage.repository, block,
      gatedActions: f.execution.gatedActionStore, reviewLink: id => '/preapproval/' + id }), ...options });
};

it('returns the durable kernel receipt during retirement failure and retries cleanup without duplicate review or restored authority', async () => {
  const c = await terminal(); const before = authority(c.f.db, c.old.future_execution_ref);
  const privateContent = snapshot(c.f, c.old.future_execution_ref); expect(privateContent).not.toBe('');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    fault(c.f); const request = c.f.request(); const { meta, origin } = kernel(c.f);
    const attempt = await c.f.execution.preapprovalRequest!(request, meta).then(receipt => ({ receipt }), error => ({ error }));
    const stored = c.f.db.prepare('SELECT proposal_id,future_ref FROM preapproval_proposals WHERE idempotency_key=?')
      .get(request.idempotency_key) as { proposal_id: string; future_ref: string };
    expect(stored).toBeDefined();
    expect(c.f.db.prepare('SELECT count(*) AS n FROM preapproval_proposals').get()).toEqual({ n: 2 });
    const expected = await c.f.service.prepare(request, origin);
    const asks = await c.f.block.listOpenAsks(); expect(asks).toHaveLength(1);
    expect(asks[0]!.handler_payload.proposal_id).toBe(stored.proposal_id);
    expect(authority(c.f.db, c.old.future_execution_ref)).toEqual(before);
    expect(snapshot(c.f, c.old.future_execution_ref)).toBe(privateContent);
    expect(c.f.db.prepare('SELECT count(*) AS n FROM preapproval_retired_reviews').get()).toEqual({ n: 0 });
    expect(attempt).toEqual({ receipt: expected });
    expect(await c.f.execution.preapprovalRequest!(request, meta)).toEqual(expected);
    expect((await c.f.block.listOpenAsks()).map(ask => ask.ask_id)).toEqual([asks[0]!.ask_id]);
    expect(c.f.db.prepare('SELECT count(*) AS n FROM preapproval_outbox WHERE future_ref=?').get(stored.future_ref)).toEqual({ n: 1 });
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) expect(call).toContainEqual(expect.objectContaining({ message: 'terminal retention unavailable' }));
    c.f.db.exec('DROP TRIGGER fail_terminal_retention'); await c.f.composed.outbox.drain();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(snapshot(c.f, c.old.future_execution_ref)).toBe('');
    expect(c.f.db.prepare('SELECT count(*) AS n FROM preapproval_retired_reviews').get()).toEqual({ n: 1 });
    c.f = await c.f.reopen(); const reopened = kernel(c.f);
    expect(await c.f.execution.preapprovalRequest!(request, reopened.meta)).toEqual(expected);
    expect((await c.f.block.listOpenAsks()).map(ask => ask.ask_id)).toEqual([asks[0]!.ask_id]);
    expect(c.f.db.prepare('SELECT count(*) AS n FROM preapproval_proposals').get()).toEqual({ n: 2 });
    expect((await c.f.storage.repository.inspect(c.old.proposal_id)).retired_review).toBeDefined();
    expect((await c.f.storage.repository.decide(c.input, c.f.responder)).decision_id).toBe(c.decision.decision_id);
    expect((await c.f.storage.repository.revoke(c.mutation, c.f.responder)).grant?.status).toBe('revoked');
    expect(authority(c.f.db, c.old.future_execution_ref)).toEqual(before); noEffects(c.f);
  } finally { warn.mockRestore(); }
});

it('reports optional retirement errors through the configured error hook and leaves direct storage failure observable', async () => {
  const c = await terminal(); fault(c.f);
  const before = authority(c.f.db, c.old.future_execution_ref), privateContent = snapshot(c.f, c.old.future_execution_ref);
  const onError = vi.fn(), drain = outbox(c.f, { onError });
  await expect(drain.drain()).resolves.toBeUndefined();
  expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'terminal retention unavailable' }));
  await expect(c.f.storage.repository.retireReviewContent()).rejects.toThrow('terminal retention unavailable');
  expect(snapshot(c.f, c.old.future_execution_ref)).toBe(privateContent);
  expect(c.f.db.prepare('SELECT count(*) AS n FROM preapproval_retired_reviews').get()).toEqual({ n: 0 });
  expect(authority(c.f.db, c.old.future_execution_ref)).toEqual(before);
  c.f.db.exec('DROP TRIGGER fail_terminal_retention'); await drain.drain();
  expect(onError).toHaveBeenCalledTimes(1); expect(snapshot(c.f, c.old.future_execution_ref)).toBe('');
  expect(authority(c.f.db, c.old.future_execution_ref)).toEqual(before); noEffects(c.f);
});

it('still rejects preparation persistence failures without an orphan execution, review, notification or effect', async () => {
  const f = await resourceFixture(); f.save([recordStep('a')]); const { meta } = kernel(f);
  f.db.exec("CREATE TRIGGER fail_review_creation BEFORE INSERT ON preapproval_proposals BEGIN SELECT RAISE(ABORT, 'review persistence unavailable'); END");
  await expect(f.execution.preapprovalRequest!(f.request(), meta)).rejects.toThrow('review persistence unavailable');
  for (const table of ['preapproval_proposals', 'preapproval_executions', 'preapproval_grants', 'preapproval_outbox']) {
    expect(f.db.prepare('SELECT count(*) AS n FROM ' + table).get()).toEqual({ n: 0 });
  }
  expect(await f.block.listOpenAsks()).toEqual([]); noEffects(f);
});

it('still propagates critical maintenance failure and leaves pending delivery unconsumed', async () => {
  const f = await resourceFixture(); f.save([recordStep('a')]); const { origin } = kernel(f);
  const created = await f.service.prepare(f.request(), origin);
  const onError = vi.fn();
  const drain = outbox(f, { onError, maintain: () => { f.db.prepare('SELECT * FROM missing_critical_maintenance_table').get(); } });
  await expect(drain.drain()).rejects.toThrow('missing_critical_maintenance_table');
  expect(onError).not.toHaveBeenCalled(); expect(await f.block.listOpenAsks()).toEqual([]);
  expect(f.db.prepare('SELECT state FROM preapproval_outbox WHERE future_ref=?').all(created.future_execution_ref)).toEqual([{ state: 'pending' }]);
  expect((await f.storage.repository.inspect(created.proposal_id)).execution_status).toBe('prepared');
  expect(f.db.prepare('SELECT count(*) AS n FROM preapproval_grants').get()).toEqual({ n: 0 }); noEffects(f);
});
