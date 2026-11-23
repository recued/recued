import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Checkpoint } from '@recued/contracts';
import { createPreflightAnswerHandler } from '@recued/gateway';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore,
  type Channel, type NotificationBlock, type PendingAsk, type NotificationSettings, type SubmitAnswerOptions } from '@recued/notification';
import { createAuditLogStore, createBatchAskStore, createCheckpointStore, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { createBatchApprovalCoordinator } from '../batch-approval.js';
import { createPreparedInboxRejectionRecorder } from '../reception-inbox-prepared-rejection.js';
import { createReceptionInboxSubviewStore } from '../storage/reception-inbox-subview-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { buildAnswerActivities } from '../composition/bin/wire-notification-block.js';
import { createAskLandingInboxApproval } from '../ask-landing-inbox-approval.js';
import { createAskLandingPortHandler } from '../ask-landing-port.js';
import { buildAskLandingDetails } from '../ask-landing-held-op-details.js';
import { createInMemoryAskLandingNonceStore } from '../ask-landing-nonce-store.js';
import { createPausedAnswerRefusal } from '../pause-approval.js';
import { defaultIsReceptionOriginAnchor, findReceptionHoldItem, handleReceptionInboxApprove, handleReceptionInboxReject, type ReceptionInboxDeps } from '../reception-inbox-handler.js';
import { allowingAskLandingAbuseDeps } from './ask-landing-test-helpers.js';

export const WINNER_NOW = 1_700_000_000_000;
export const WINNER_ASK = 'ask-winner-fixture';
export const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
export const createApprovalWinnerFixture = async (requiredNote = false, batched = false) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-approval-winner-fixture-')), path = join(dir, 'state.sqlite');
  let db: Database.Database, asks: ReturnType<typeof createAskStore>, checkpoints: ReturnType<typeof createCheckpointStore>;
  let audit: ReturnType<typeof createAuditLogStore>, inbox: ReceptionInboxDeps, block: NotificationBlock;
  let batchStore: ReturnType<typeof createBatchAskStore>;
  let subview: ReturnType<typeof createReceptionInboxSubviewStore>;
  let rejectionFailure: 'before-subview' | 'after-audit' | undefined;
  const broadcasts: unknown[] = [];
  let port: ReturnType<typeof createAskLandingPortHandler> | undefined;
  let now = WINNER_NOW, paused = false;
  let answerFailure: 'before' | 'after' | undefined, checkpointFailure: 'before' | 'after' | undefined;
  let preparationGate: ReturnType<typeof deferred> | undefined, preparationEntered: ReturnType<typeof deferred> | undefined;
  let checkpointGate: ReturnType<typeof deferred> | undefined, checkpointEntered: ReturnType<typeof deferred> | undefined;
  let lookupGate: ReturnType<typeof deferred> | undefined, lookupEntered: ReturnType<typeof deferred> | undefined;
  const resumes: Checkpoint[] = [], denials: Checkpoint[] = [];
  const submit: NotificationBlock['submitAnswer'] = (reply, options) => {
    const prepare = options?.prepare;
    const wrapped: SubmitAnswerOptions | undefined = prepare ? { prepare: async ask => {
      if (preparationGate) { const wait = preparationGate; preparationGate = undefined; preparationEntered!.resolve(); await wait.promise; }
      return prepare(ask);
    } } : undefined;
    return block.submitAnswer(reply, wrapped);
  };
  const open = () => {
    port = undefined;
    db = new Database(path);
    audit = createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'audit_log'), createSQLiteCollection<ActivityEntry>(db, 'activity_log'));
    checkpoints = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
    asks = createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks'));
    const writeAnswer = asks.recordAnswer.bind(asks);
    asks.recordAnswer = async (...args) => {
      const failure = answerFailure; answerFailure = undefined;
      if (failure === 'before') throw new Error('answer write failed before commit');
      await writeAnswer(...args);
      if (failure === 'after') throw new Error('answer write failed after commit');
    };
    const getCheckpoint = checkpoints.get.bind(checkpoints);
    checkpoints.get = async id => {
      const checkpoint = await getCheckpoint(id);
      if (lookupGate) { const wait = lookupGate; lookupGate = undefined; lookupEntered!.resolve(); await wait.promise; }
      return checkpoint;
    };
    const writeCheckpoint = checkpoints.setArgOverrides.bind(checkpoints);
    checkpoints.setArgOverrides = async (...args) => {
      const failure = checkpointFailure; checkpointFailure = undefined;
      if (failure === 'before') throw new Error('checkpoint write failed before commit');
      const result = await writeCheckpoint(...args);
      if (failure === 'after') throw new Error('checkpoint write failed after commit');
      if (checkpointGate) { const wait = checkpointGate; checkpointGate = undefined; checkpointEntered!.resolve(); await wait.promise; }
      return result;
    };
    const ui: Channel = { name: 'ui', capability: 'inline', owns_llm_egress: true,
      deliverNotify: async () => {}, deliverAsk: async () => {}, closeAsk: async () => {} };
    block = createNotificationBlock({ askStore: asks,
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
      channels: [ui], now: () => now,
      refuseAnswer: createPausedAnswerRefusal({ isPaused: () => paused }),
      recordAnswerAudit: async record => { for (const row of buildAnswerActivities(record)) await audit.logActivity(row); } });
    const resumer = { resumeRun: async (checkpoint: Checkpoint) => { resumes.push(structuredClone(checkpoint)); },
      denyRun: async (checkpoint: Checkpoint) => { denials.push(structuredClone(checkpoint)); } };
    subview = createReceptionInboxSubviewStore(db);
    const recordPreparedDenial = createPreparedInboxRejectionRecorder({
      subviewStore: { ...subview, record: row => {
        if (rejectionFailure === 'before-subview') { rejectionFailure = undefined; throw new Error('rejection projection failed'); }
        subview.record(row);
      } },
      auditLog: { ...audit, logActivity: async row => {
        await audit.logActivity(row);
        if (rejectionFailure === 'after-audit') { rejectionFailure = undefined; throw new Error('rejection projection failed'); }
      } },
    });
    batchStore = createBatchAskStore(createSQLiteCollection(db, 'batch_asks'));
    const batches = createBatchApprovalCoordinator({ batchAskStore: batchStore, checkpointStore: checkpoints, resumer,
      notifier: { ask: async () => { throw new Error('Unexpected fixture batch raise'); }, notify: async () => {}, registerAskHandler: () => {} },
      listUnresolvedAsks: async () => [], cancelAsk: async () => 'cancelled', now: () => now, recordPreparedDenial });
    block.registerAskHandler('gateway.preflight', createPreflightAnswerHandler({ checkpointStore: checkpoints,
      resumer, batchApprovals: batches.hooks, recordPreparedDenial }));
    inbox = { auditLog: audit, checkpointStore: checkpoints,
      resolveArgEditSchema: () => ({ fields: [{ key: 'title', type: 'string', label: 'Title' },
        { key: 'connection_name', type: 'string', label: 'Calendar', affects_target: true }] }),
      resolveSource: () => {
        return { top_tier_kind: 'booking', source: { kind: 'scheduling_link', record_ref: 'fixture' },
          args: { title: 'Original', connection_name: 'calendar-A' }, preview: { title: 'Fixture' }, proposed_action: 'Create a booking' };
      },
      isReceptionOrigin: defaultIsReceptionOriginAnchor, isServerPaused: () => paused,
      submitAnswer: async (ask_id, option) => { await submit({ ask_id, option, via: 'ui' }); },
      submitPreparedAnswer: (ask_id, option, prepare) => submit({ ask_id, option, via: 'ui' }, { prepare }),
      subviewStore: subview,
      broadcast: event => { broadcasts.push(event); }, now: () => now };
  };
  open();
  if (batched) await batchStore!.create({ batch_id: 'batch-1', unit_kind: 'run', unit_id: 'run-1',
    ingredient_slug: 'recued-core/reception-scheduling', operation_id: 'reception-scheduling.scheduling.materialize',
    channel: 'reception', actor: 'anonymous', channel_session_id: 'fixture', risk_tier: 'write',
    recipe_id: 'recued-core/reception-scheduling-incoming', recipe_hash: 'hash-1', arg_shape_hash: 'shape-1',
    source: { channel: 'reception', actor: 'anonymous', reception_id: 'r1' }, current_ask_id: WINNER_ASK, created_at: WINNER_NOW,
  }, { checkpoint_id: 'cp-1', run_id: 'run-1', canonical_payload_hash: 'payload-1', summary: 'Fixture' });
  await asks!.create({ ask_id: WINNER_ASK, message: { title: 'Review fixture', text: 'Review this local request.' },
    options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }], handler_kind: 'gateway.preflight',
    handler_payload: { checkpoint_id: 'cp-1', run_id: 'run-1', recipe_id: 'recued-core/reception-scheduling-incoming', gated_step_id: 'materialize',
      ...(batched ? { batch_id: 'batch-1', payload_version: 1, batch_checkpoint_ids: ['cp-1'] } : {}) },
    fanout_channels: ['ui'], created_at: WINNER_NOW, ...(requiredNote ? { note_prompt: 'required' as const } : {}) });
  await audit!.append({ run_id: 'run-1', recipe_id: 'recued-core/reception-scheduling-incoming', recipe_hash: 'hash-1',
    started_at: WINNER_NOW, finished_at: WINNER_NOW, duration_ms: 0, commit_status: 'awaiting_approval', config_snapshot: {}, errors: [],
    trigger_url: null, trigger_source: 'reactive', instance_id: null, execution_source: { channel: 'reception', actor: 'anonymous', reception_id: 'r1', contract_id: 'door-1' },
    ask_id: WINNER_ASK, checkpoint_id: 'cp-1' } as unknown as AuditEntry);
  await checkpoints!.write({ checkpoint_id: 'cp-1', run_id: 'run-1', recipe_id: 'recued-core/reception-scheduling-incoming', gated_step_id: 'materialize',
    approved_target: { ingredient_slug: 'recued-core/reception-scheduling', operation_id: 'reception-scheduling.scheduling.materialize', connection_name: 'calendar-A' },
    step_state: { materialize: { input: { title: 'Original', connection_name: 'calendar-A' } } }, created_at: WINNER_NOW } as unknown as Checkpoint);
  const landing = () => createAskLandingInboxApproval({ inbox, submitAnswer: submit, timeZone: 'UTC' });
  return {
    resumes, denials, broadcasts, get block() { return block; }, get inbox() { return inbox; }, get subview() { return subview; },
    get checkpoints() { return checkpoints; },
    ask: () => asks.get(WINNER_ASK),
    activities: () => db.prepare('SELECT data FROM activity_log ORDER BY key').all().map(row => JSON.parse((row as { data: string }).data) as ActivityEntry),
    approveEdited: async (title: string, via: 'telegram' | 'slack' = 'telegram') => {
      const ask = await asks.get(WINNER_ASK); if (!ask) throw new Error('Missing fixture ask');
      return landing()({ ask, option: 'approve', rawEdits: { title }, via });
    },
    approveInApp: (edits: Record<string, unknown>) => handleReceptionInboxApprove(inbox, { hold_id: 'cp-1', edits }, { instance_id: 'paired-fixture' }),
    rejectInApp: (reason?: string) => handleReceptionInboxReject(inbox, { hold_id: 'cp-1', ...(reason !== undefined ? { reason } : {}) }, { instance_id: 'paired-fixture' }),
    plainAnswer: (option: 'approve' | 'deny') => submit({ ask_id: WINNER_ASK, option, via: 'ui' }),
    setPaused: (value: boolean) => { paused = value; }, setNow: (value: number) => { now = value; },
    failAnswerWrite: (at: 'before' | 'after') => { answerFailure = at; },
    failCheckpointWrite: (at: 'before' | 'after') => { checkpointFailure = at; },
    failRejectionProjection: (at: 'before-subview' | 'after-audit') => { rejectionFailure = at; },
    stallPreparation: () => { const entered = deferred(), release = deferred(); preparationEntered = entered; preparationGate = release; return { entered: entered.promise, release: release.resolve }; },
    stallCheckpointWrite: () => { const entered = deferred(), release = deferred(); checkpointEntered = entered; checkpointGate = release; return { entered: entered.promise, release: release.resolve }; },
    stallLookup: () => { const entered = deferred(), release = deferred(); lookupEntered = entered; lookupGate = release; return { entered: entered.promise, release: release.resolve }; },
    restart: async () => { db.close(); open(); await block.recoverPendingAsks(); },
    corruptPreparedBinding: async () => {
      const ask = await asks.get(WINNER_ASK); if (!ask?.answer) throw new Error('No recorded answer');
      ask.answer.prepared = { ...ask.answer.prepared, checkpoint_id: 'a-different-checkpoint' };
      db.prepare('UPDATE pending_asks SET data = ? WHERE key = ?').run(JSON.stringify(ask), WINNER_ASK);
    },
    get handler() { return port ??= createAskLandingPortHandler({ getAsk: id => block.getAsk(id), getVerificationPhrase: async () => undefined,
      submitAnswer: async reply => { await submit(reply); }, submitEditedApproval: landing(),
      resolveDetails: async () => { const item = await findReceptionHoldItem(inbox, 'cp-1'); return item ? buildAskLandingDetails(item, { editable: true, timeZone: 'UTC' }) : null; },
      nonceStore: createInMemoryAskLandingNonceStore(), now: () => now, abuse: allowingAskLandingAbuseDeps() }); },
    close: () => { preparationGate?.resolve(); checkpointGate?.resolve(); lookupGate?.resolve(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
};
