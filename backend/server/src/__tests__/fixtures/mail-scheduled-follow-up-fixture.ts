import { createMailFollowUpTaskFixture } from './mail-follow-up-task-fixture.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createAuditLogStore, createCheckpointStore, createCommitStore, type AuditEntry } from '@recued/storage';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel, type PendingAsk, type NotificationSettings } from '@recued/notification';
import type { Checkpoint, Commit, MailDraftContent, PreparePreapproval, PreapprovalDecisionRequest, RecipeDefinition } from '@recued/contracts';
import { createMailFollowUpFixture } from './mail-follow-up-fixture.js';
import { createSQLiteCollection } from '../../sqlite-collection.js';
import { createPreapprovalStorage } from '../../storage/preapproval-storage.js';
import { createRecipeStore } from '../../recipe-store.js';
import { createScheduleStore } from '../../schedule-store.js';
import { createAutoRunSettingsStore, createCircuitBreakerStore } from '../../auto-run-scheduler.js';
import { createDishStore } from '../../dish-store.js';
import { createDishGroupStore } from '../../dish-group-store.js';
import { createEventTriggersStore } from '../../triggers/store.js';
import { createManifestRegistry } from '../../manifest-loader.js';
import { KERNEL_MANIFESTS } from '../../kernel-manifests.js';
import { createContractStore, createContractScanFn } from '../../storage/contract-store.js';
import { createContractDefinitionStore } from '../../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../../storage/contract-grant-entry-store.js';
import { createConnectionCatalogBindingStore } from '../../storage/connection-catalog-binding-store.js';
import { createConnectionStore } from '../../storage/connection-store.js';
import { createClientTokenStore } from '../../pairing/client-tokens.js';
import { createOpAdmissionGate } from '../../op-admission-gate.js';
import { createContractOverlayResolver } from '../../policy-contract-overlay.js';
import { createApprovalResumeAuthorityResolver } from '../../approval-resume-authority.js';
import { createGatedActionStore, createSqliteGatedActionChangeClock, createSqliteGatedActionCompareAndSet, GATED_ACTION_TABLE, type GatedActionRecord } from '../../gated-action-store.js';
import { composePreapproval } from '../../composition/bin/wire-preapproval.js';
import { requirePreapprovalOwner, makePreapprovalHandlers } from '../../preapproval-handler.js';
import { createCollectionRegistry } from '../../collections/registry.js';
import { createBlobStore } from '../../storage/blob-store.js';
import { createMailCollection, mailRecordIdForSource, type MailSendResult } from '../../collections/mail/mail-collection.js';
import type { MailProvider, OutgoingMessage } from '../../collections/mail/provider.js';
import { handleCollectionMailSend } from '../../collections/collection-handler.js';
import { currentPreapprovalIo, withPreapprovalIo } from '../../preapproval-io-context.js';
import { createMailFollowUpSendService, dispatchMailWithReplyWatch } from '../../mail-follow-up-send-service.js';
import { createMailFollowUpSendStore } from '../../storage/mail-follow-up-send-store.js';
import type { ExecuteHandlerDeps } from '../../execute-handler.js';
import type { WsClient } from '../../ws-server.js';

/** Real reviewed execution, authority, engine, native collection send and
 * encrypted stores. Only the provider's delivery and Sent sync are controlled. */
export const createMailScheduledFollowUpFixture = async (options: { tasks?: boolean } = {}) => {
  let ownerToken = '';
  const taskFixture = options.tasks ? await createMailFollowUpTaskFixture(() => ownerToken) : undefined;
  const f = taskFixture ?? createMailFollowUpFixture(() => ownerToken), db = f.db, now = f.now;
  const dir = mkdtempSync(join(tmpdir(), 'scheduled-watch-provider-'));
  const clients = createClientTokenStore(db, { argon2_params: { t: 1, m: 8, p: 1 } });
  const token = await clients.issue({ client_kind: 'webclient', metadata: { instance_id: 'scheduled-watch-browser' } }); ownerToken = token.token_id;
  const client = { client_kind: 'webclient', client_token_id: ownerToken, instance_id: 'scheduled-watch-browser' } as WsClient;
  const contracts = createContractStore(db), definitions = createContractDefinitionStore(contracts), grants = createContractGrantEntryStore(contracts);
  const gate = createOpAdmissionGate({ definitionStore: definitions, grantEntryStore: grants });
  const overlay = createContractOverlayResolver({ definitionStore: definitions, grantEntryStore: grants });
  const manifests = createManifestRegistry('/nonexistent', db);
  for (const slug of ['mail-send', 'data-file-read', 'mail-draft-create', 'mail-draft-read', 'mail-draft-update', 'mail-draft-delete']) manifests.register(KERNEL_MANIFESTS.find(m => m.slug === slug)!);
  contracts.put('owner_operation', ['mail-send', 'mail-send'], { approval: 'ask', op_hash: 'scheduled-mail-review' });
  const recipes = createRecipeStore('/nonexistent', db);
  recipes.save(JSON.parse(readFileSync(new URL('../../../../../community/recipes/send-composed-mail.json', import.meta.url), 'utf8')) as RecipeDefinition, 'recued-core', 'inline');
  const sources = { db, recipes, schedules: createScheduleStore(db), autoRun: createAutoRunSettingsStore(db), triggers: createEventTriggersStore(db), dishes: createDishStore(db), groups: createDishGroupStore(db) };
  const connections = createConnectionStore(db), bindings = createConnectionCatalogBindingStore(contracts);
  const clock = createSqliteGatedActionChangeClock(db);
  const storage = createPreapprovalStorage(db, clock, () => new Uint8Array(32).fill(9), { now });
  const execution: ExecuteHandlerDeps = { recipeStore: recipes, baseVault: {}, executorConfig: { manifests },
    commitStore: createCommitStore(createSQLiteCollection<Commit>(db, 'commits')), auditLog: createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'audit_log')),
    checkpointStore: createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints')),
    gatedActionStore: createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, GATED_ACTION_TABLE), { compareAndSet: createSqliteGatedActionCompareAndSet(db), nextChangeSeq: clock.nextChangeSeq }),
    opAdmissionGate: gate, contractOverlay: overlay, contractScan: createContractScanFn(contracts),
    approvalResumeAuthority: createApprovalResumeAuthorityResolver({ manifests, clientTokens: clients, contractOverlay: overlay, opAdmissionGate: gate, now }) };
  const registry = createCollectionRegistry(), blobs = createBlobStore(join(dir, 'blobs'), { getEncryptionKey: () => new Uint8Array(32).fill(9) });
  const deliveries: Array<{ message: OutgoingMessage; result: MailSendResult }> = [];
  const behavior = { uncertain: false, fail: false };
  const provider: MailProvider = { kind: 'imap', slug: 'work', sendCapable: true, mutationCapable: false, accountEmail: 'owner@example.test',
    async connect() {}, async initialScan() {}, async startSync() { return async () => {}; }, async close() {},
    health: () => ({ last_successful_sync_at: now(), error_count_24h: 0, pending_queue_size: 0 }),
    async send(message) {
      if (behavior.fail) throw new Error('Provider unavailable before confirmation');
      const n = deliveries.length + 1, result: MailSendResult = { source_id: 'scheduled-provider-' + n, message_id: `<scheduled-${n}@example.test>`, sent_at: now(), _id: null, _collection: 'data.mail' };
      deliveries.push({ message: structuredClone(message), result });
      if (behavior.uncertain) throw new Error('Provider acknowledgement lost'); return result;
    } };
  registry.register(createMailCollection({ db, blobs, slug: 'work', provider, now, bus: createWarehouseEventBus(),
    gate: createStorageGate({ quota: 20000000, reservePct: 10, surface: 'scheduled-watch-mail' }), config: () => ({ quota_bytes: 20000000, backfill_days: 1, retention_days: 30 }), auditLog: execution.auditLog }));
  let beforeIntent: (() => Promise<void>) | undefined;
  const sendStore = createMailFollowUpSendStore(db, { ...f.codec, async seal(value) {
    const ciphertext = await f.codec.seal(value), hook = beforeIntent; beforeIntent = undefined; await hook?.(); return ciphertext;
  } });
  const makeSend = () => createMailFollowUpSendService({ store: sendStore, watches: f.service, mailbox: f.mailbox,
    incarnation: slug => f.instances.getIncarnation!('mail', slug), validateOwner: id => { if (id !== ownerToken || clients.get(id)?.revoked_at !== null) throw new Error('Original owner revoked'); f.principal.validate(); }, now,
    runStatus: async id => (await execution.auditLog!.get(id))?.commit_status });
  let send = makeSend(); execution.mailFollowUpSend = send;
  const notifications = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
    settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')), channels: [createUiChannel({ busSink: () => {} })], now });
  const composed = composePreapproval({ ownerId: 'test-realm', storage, sources, circuits: createCircuitBreakerStore(db), execution,
    profiles: { connectionStore: connections, connectionCatalogBindingStore: bindings, getManifest: slug => manifests.get(slug) }, clientTokens: clients, definitions,
    notifications, reviewLink: id => '#approvals/preapproval/' + id, now, serverTimeZone: () => 'UTC', mail: { registry, instances: f.instances, blobs } });
  const attempts: Array<{ input: Parameters<typeof send.beforeSend>[0]; scheduled: Parameters<typeof send.beforeSend>[1] }> = [];
  let beforeProvider: (() => void) | undefined;
  execution.executorConfig.kernelDispatchers = { mailSend: async input => {
    const io = currentPreapprovalIo();
    const scheduled = io?.scheduledMailFollowUp?.(input as unknown as Record<string, unknown>);
    attempts.push({ input: structuredClone(input), scheduled: structuredClone(scheduled) });
    const dispatch = () => dispatchMailWithReplyWatch(input, send, guard =>
      handleCollectionMailSend({ registry }, input, guard ? { before_dispatch: guard } : undefined));
    if (!io || !beforeProvider) return dispatch();
    return withPreapprovalIo({ ...io, async beforeMailProvider(instance, args) {
      await io.beforeMailProvider(instance, args);
      const hook = beforeProvider;
      beforeProvider = undefined;
      hook?.();
    } }, dispatch);
  } };
  await storage.recover();
  const handlers = makePreapprovalHandlers(composed.handlers)!.handlers;
  const origin = requirePreapprovalOwner(client, clients, 'test-realm').origin;
  const request = (draft: { draft_id: string; revision: number }, runAt = now() + 86400000): PreparePreapproval => ({ idempotency_key: randomUUID(),
    subject: { kind: 'mail_draft', draft_id: draft.draft_id, draft_revision: draft.revision }, activation: { kind: 'one_shot', run_at: runAt, time_zone: 'UTC' },
    decision_deadline: Math.min(runAt, now() + 86400000), dispatch_deadline: runAt + 900000 });
  const prepare = async (content: MailDraftContent, runAt?: number) => {
    const draft = await f.drafts.create({ idempotency_key: randomUUID(), content }, f.principal);
    return { draft, prepared: await composed.service.prepare(request(draft, runAt), origin) };
  };
  const decide = async (id: string, decision: PreapprovalDecisionRequest['decision'] = 'approve') => {
    const review = await storage.repository.review(id, { channel: 'webclient', key: ownerToken });
    return storage.repository.decide({ proposal_id: id, expected_revision: review.revision, review_digest: review.review_digest, challenge: review.challenge, decision, request_id: randomUUID() }, { channel: 'webclient', key: ownerToken });
  };
  const syncSent = (index = deliveries.length - 1, threadId = 'scheduled-thread-' + index) => {
    const { message, result } = deliveries[index]!;
    const row = { ...f.seed, record_id: mailRecordIdForSource(result.source_id), source_id: result.source_id, received_at: result.sent_at, modified_at: result.sent_at, body_inline: message.body_text,
      hot_fields: { ...f.seed.hot_fields, subject: message.subject, to: message.to, cc: message.cc ?? [], thread_id: threadId, rfc_message_id: result.message_id } };
    f.tables.get('work')!.upsert(row); return row;
  };
  return { ...f, requestMail: f.request, taskFixture, execution, storage, composed, clients, token, client, origin, handlers, deliveries, behavior, sendStore, prepare, decide, request, syncSent, attempts,
    beforeIntent: (hook: () => Promise<void>) => { beforeIntent = hook; },
    beforeProvider: (hook: () => void) => { beforeProvider = hook; },
    send: () => send, restartSend: () => { send = makeSend(); execution.mailFollowUpSend = send; }, tick: () => composed.driver.tickSchedules(now()),
    dispose: () => { f.dispose(); rmSync(dir, { recursive: true, force: true }); } };
};

export const prepareLinkedFollowUpDraft = async (f: Awaited<ReturnType<typeof createMailScheduledFollowUpFixture>>) => {
  if (!f.taskFixture) throw new Error('A task fixture is required for a linked follow-up draft.');
  let watch = await f.service.start(f.requestMail(), f.token.token_id);
  watch = await f.service.setTask({
    id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.taskFixture.task.id,
  }, f.principal.validate);
  f.due();
  watch = await f.service.check(watch.id);
  const draft = await f.drafts.get({ draft_id: watch.draft_id }, f.principal);
  return { watch, draft };
};
