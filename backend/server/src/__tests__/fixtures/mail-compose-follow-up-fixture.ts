import { readFileSync } from 'node:fs';
import { createAuditLogStore, createCheckpointStore, createCommitStore, createInMemoryCollection,
  type AuditEntry, type ActivityEntry } from '@recued/storage';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel, type PendingAsk, type NotificationSettings } from '@recued/notification';
import { registerPreflightHandler } from '@recued/gateway';
import type { RecipeDefinition, ServerRpcRegistry, CollectionRecord, NormalizedMailSend, Checkpoint, Commit } from '@recued/contracts';
import { makeExecuteHandlers, type ExecuteHandlerDeps } from '../../execute-handler.js';
import { createRecipeStore } from '../../recipe-store.js';
import { createManifestRegistry } from '../../manifest-loader.js';
import { createPreflightResumer } from '../../preflight-resumer.js';
import { createMailFollowUpSendStore } from '../../storage/mail-follow-up-send-store.js';
import { createMailFollowUpSendService } from '../../mail-follow-up-send-service.js';
import { createMailFollowUpFixture, type MailFollowUpFixture } from './mail-follow-up-fixture.js';
import { mailRecordIdForSource, type MailSendResult } from '../../collections/mail/mail-collection.js';

/** Real execute handler, engine, kernel normalizer, approval gate, owner answer,
 * resumer, and encrypted watch stores. The fixture's send policy can require
 * individual review; provider delivery is recorded instead of reaching a mailbox. */
export const createMailComposeFollowUpFixture = (base?: MailFollowUpFixture, requireApproval = true) => {
  const f = base ?? createMailFollowUpFixture();
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
  const checkpointStore = createCheckpointStore(createInMemoryCollection<Checkpoint>());
  const commitStore = createCommitStore(createInMemoryCollection<Commit>());
  const asks = createAskStore(createInMemoryCollection<PendingAsk>());
  const block = createNotificationBlock({ askStore: asks, channels: [createUiChannel({ busSink: () => {} })],
    settingsStore: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()) });
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(JSON.parse(readFileSync(new URL('../../../../../community/recipes/send-composed-mail.json', import.meta.url), 'utf8')) as RecipeDefinition);
  const store = createMailFollowUpSendStore(f.db, f.codec);
  const makeSend = () => createMailFollowUpSendService({ store, watches: f.service, mailbox: f.mailbox,
    incarnation: slug => f.instances.getIncarnation!('mail', slug), validateOwner: () => f.principal.validate(),
    now: f.now, runStatus: async id => (await auditLog.get(id))?.commit_status });
  let service = makeSend();
  const manifests = createManifestRegistry();
  // An owner may already cover a send. Exercise both policy outcomes; the
  // stricter fixture declares the ordinary destructive always-ask floor.
  if (requireApproval) manifests.register({ ...manifests.get('mail-send')!, risk_tier: 'destructive' });
  const delivered: Array<{ input: NormalizedMailSend; result: MailSendResult }> = [];
  const deps: ExecuteHandlerDeps = {
    recipeStore, baseVault: {}, instanceId: 'compose-watch-fixture', auditLog, checkpointStore, commitStore, preflightNotifier: block,
    approvalResumeAuthority: { resolve: ({ execution_source }) => ({ admitted: true, execution_source }) },
    executorConfig: { manifests, kernelDispatchers: { mailSend: async input => {
      const observed = await service.beforeSend(input); if (observed?.cached) return observed.cached;
      const source = 'composed-provider-' + String(delivered.length + 1), result: MailSendResult = {
        source_id: source, message_id: source, sent_at: f.now(), _id: null, _collection: 'data.mail', thread_id: 'composed-thread-' + String(delivered.length + 1),
      };
      delivered.push({ input: structuredClone(input), result });
      if (observed) await service.afterSend(observed.id, result); return result;
    } } },
    listSendCapableMailboxes: () => [{ name: 'work', address: 'owner@example.test', provider: 'Fixture' }],
  } as ExecuteHandlerDeps;
  registerPreflightHandler(block, { checkpointStore, resumer: createPreflightResumer({ getExecuteDeps: () => deps, auditLog }) });
  const client = { client_kind: 'webclient', client_token_id: 'paired-owner', user_id: 'owner' } as never;
  const execute = (args: ServerRpcRegistry['execute']['request']) => makeExecuteHandlers(deps, { service: f.service, send: service, authorize: () => { f.principal.validate(); return 'paired-owner'; } })!
    .handlers.execute(args, client);
  const syncSent = (index = delivered.length - 1, patch: Partial<CollectionRecord> = {}): CollectionRecord => {
    const { input, result } = delivered[index]!;
    const row: CollectionRecord = { record_id: mailRecordIdForSource(result.source_id), source_id: result.source_id, received_at: result.sent_at,
      modified_at: result.sent_at, size_bytes: 100, body_inline: input.body_html ?? input.body_text,
      hot_fields: { from: 'owner@example.test', to: input.to, cc: input.cc ?? [], subject: input.subject,
        thread_id: result.thread_id!, direction: 'outbound', folder: 'Sent', is_read: true, rfc_message_id: `<${result.source_id}@example.test>`, has_attachments: !!input.attachments?.length, is_flagged: false }, ...patch };
    f.tables.get(input.instance)!.upsert(row); return row;
  };
  const answer = async (option: 'approve' | 'deny') => {
    const open = (await asks.listByStatus('open')).at(-1); if (!open) throw Error('The send did not reach its approval gate.');
    if (!open.options.some(item => item.id === option)) throw Error('The send does not offer ' + option + ': ' + open.options.map(item => item.id).join(','));
    await block.submitAnswer({ ask_id: open.ask_id, option, via: 'ui' });
  };
  return { ...f, sendStore: store, send: () => service, execute, delivered, asks, answer, syncSent,
    restartSend() { service = makeSend(); }, deps };
};
