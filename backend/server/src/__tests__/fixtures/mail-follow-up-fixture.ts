import { createMailReplacementSourceReader } from '../../mail-follow-up-replacement-source.js';
import type { InboundMailAttachmentPart } from '../../collections/mail/provider.js';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { RpcError, parseAddress, reminderMailReference, type MailMessageAttachment, type CollectionHealth, type CollectionRecord } from '@recued/contracts';
import { createInstanceStore } from '../../collections/instance-store.js';
import { createCollectionTable } from '../../collections/table.js';
import { createPreapprovalCodec } from '../../storage/preapproval-codec.js';
import { createMailDraftStore } from '../../storage/mail-drafts.js';
import { createMailFollowUpStore } from '../../storage/mail-follow-up-store.js';
import { createMailFollowUpService } from '../../mail-follow-up-service.js';

export const MAIL_FOLLOW_UP_NOW = Date.parse('2026-11-23T18:00:00Z');
export const createMailFollowUpFixture = (ownerToken: () => string = () => 'paired-owner', tasks?: Parameters<typeof createMailFollowUpService>[0]['tasks']) => {
  const db = new Database(':memory:');
  let clock = MAIL_FOLLOW_UP_NOW, unlocked = true, allowed = true, running = true;
  let inboundSyncAt: number | null = null;
  let replacementParts: InboundMailAttachmentPart[] = [], replacementFiles: MailMessageAttachment[] = [];
  let beforeReplacement: (() => Promise<void>) | undefined;
  let beforeDraftCommit: (() => Promise<void>) | undefined;
  let beforeWatchCommit: ((value: unknown) => Promise<void>) | undefined;
  const codec = createPreapprovalCodec(() => unlocked ? new Uint8Array(32).fill(9) : null);
  const instances = createInstanceStore({ db });
  const tables = new Map<string, ReturnType<typeof createCollectionTable>>();
  const health: CollectionHealth = { platform: 'mail', slug: 'work', state: 'idle',
    last_indexed_at: clock, pending_queue_size: 0, error_count_24h: 0, auth_state: 'healthy' };
  const seed: CollectionRecord = { record_id: 'sent-1', source_id: 'provider-sent-1', received_at: clock - 3600_000,
    modified_at: clock, size_bytes: 32, body_inline: 'Can you confirm the renewal?', hot_fields: {
      from: 'Owner <owner@example.test>', to: ['Alex <alex@example.test>'], cc: ['Copy <copy@example.test>'],
      subject: 'Renewal', thread_id: 'renewal-thread', folder: 'Sent', direction: 'outbound',
      reply_automation: 'v1:unmarked',
      is_read: true, is_flagged: false, has_attachments: false, message_id: 'provider-sent-1', rfc_message_id: '<sent-1@example.test>',
    } };
  for (const slug of ['work', 'personal']) {
    instances.upsert({ platform: 'mail', slug, adapter_type: 'imap', config: {}, auth_state: 'healthy', last_synced_at: clock,
      caps: { read: 'yes', write: 'yes', delete: 'yes', watch: 'none', mirror: 'optional', auth: 'none', path_style: 'posix' } });
    const table = createCollectionTable({ db, platform: 'mail', slug }); table.upsert(structuredClone(seed)); tables.set(slug, table);
  }
  const drafts = createMailDraftStore(db, { ...codec, async seal(value) {
    const result = await codec.seal(value); await beforeDraftCommit?.(); return result;
  } }, () => clock);
  const store = createMailFollowUpStore(db, { ...codec, async seal(value) {
    const result = await codec.seal(value); await beforeWatchCommit?.(value); return result;
  } });
  const validate = (): void => { if (!allowed) throw new RpcError('forbidden', 'Draft permission was revoked.', 403); };
  const principal = { owner_id: 'test-realm', contract_id: null, validate };
  const mailbox = (slug: string) => {
    const table = tables.get(slug); if (!table || !instances.get('mail', slug)) return undefined;
    return { accountEmail: 'owner@example.test', get: table.get, list: table.list, health: () => ({ ...health, slug }),
      get lastInboundSyncAt() { return inboundSyncAt; } };
  };
  const makeService = () => createMailFollowUpService({ store, mailbox,
    ...(tasks ? { tasks } : {}),
    incarnation: slug => instances.getIncarnation!('mail', slug), now: () => clock, canRun: () => running && unlocked,
    readReplacement: createMailReplacementSourceReader({
      mailbox: slug => {
        const box = mailbox(slug); if (!box) return undefined;
        return { ...box, provider: { fetchMessage: async sourceId => {
          await beforeReplacement?.(); const row = tables.get(slug)!.list({ platform: 'mail', slug, limit: 100 }).find(item => item.source_id === sourceId);
          if (!row) return null; const hot = row.hot_fields;
          return { source_id: sourceId, rfc_message_id: String(hot.rfc_message_id), from: parseAddress(String(hot.from))?.email ?? '',
            to: (hot.to as string[]).map(value => parseAddress(value)?.email ?? ''), cc: (hot.cc as string[]).map(value => parseAddress(value)?.email ?? ''),
            subject: String(hot.subject), received_at: row.received_at, body_text: row.body_inline ?? '', thread_id: String(hot.thread_id),
            folder_or_label: String(hot.folder), direction: 'outbound' as const, is_read: true, is_flagged: false,
            has_attachments: hot.has_attachments === true, ...(replacementParts.length ? { attachments: replacementParts } : {}) };
        } } };
      },
      incarnation: slug => instances.getIncarnation!('mail', slug),
      attachments: async ref => ({ slug: ref.slug, record_id: ref.record_id, incarnation: ref.incarnation,
        items: structuredClone(replacementFiles), warnings: [], truncated: false }),
      assertAttachments: (_ref, items) => { if (JSON.stringify(items) !== JSON.stringify(replacementFiles)) throw new RpcError('resource_changed', 'Attachments changed.', 409); },
    }),
    createDraft: (input, token, current) => {
      if (token !== ownerToken()) throw new RpcError('forbidden', 'A paired owner is required.', 403);
      return drafts.create(input, { ...principal, validate() { validate(); current(); } });
    },
  });
  const service = makeService();
  const reference = (slug = 'work', id = 'sent-1') => reminderMailReference(slug, tables.get(slug)!.get(id)!, instances.getIncarnation!('mail', slug))!;
  const request = (at = clock + 3600_000, slug = 'work') => ({ creation_id: randomUUID(), mail_ref: reference(slug), check_at: at });
  return {
    db, codec, drafts, store, service, makeService, tables, instances, mailbox, principal, reference, request,
    health, seed, now: () => clock, time: (value: number) => { clock = value; },
    completeInboundSync: () => { inboundSyncAt = clock; health.last_indexed_at = clock; },
    due: (at = clock + 3600_000) => { clock = at; health.last_indexed_at = at; },
    unlock: (value: boolean) => { unlocked = value; }, allow: (value: boolean) => { allowed = value; }, run: (value: boolean) => { running = value; },
    replacementAttachments: (parts: InboundMailAttachmentPart[], files: MailMessageAttachment[]) => { replacementParts = parts; replacementFiles = files; },
    beforeReplacement: (hook?: () => Promise<void>) => { beforeReplacement = hook; },
    beforeWatch: (hook?: (value: unknown) => Promise<void>) => { beforeWatchCommit = hook; },
    beforeDraft: (hook?: () => Promise<void>) => { beforeDraftCommit = hook; },
    add: (fields: Partial<CollectionRecord> & { hot_fields?: Record<string, unknown> } = {}, slug = 'work') => {
      const row = { ...seed, record_id: 'reply-1', source_id: 'provider-reply-1', received_at: clock, ...fields,
        hot_fields: { ...seed.hot_fields, from: 'Alex <alex@example.test>', to: ['owner@example.test'], cc: [],
          direction: 'inbound', folder: 'Inbox', rfc_message_id: '<reply-1@example.test>', ...fields.hot_fields } };
      tables.get(slug)!.upsert(row); return row;
    },
    draftCount: () => (db.prepare('SELECT count(*) AS n FROM mail_drafts').get() as { n: number }).n,
    dispose: () => db.close(),
  };
};
export type MailFollowUpFixture = ReturnType<typeof createMailFollowUpFixture>;
