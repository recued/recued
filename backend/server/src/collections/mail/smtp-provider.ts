import { IngredientError } from '@recued/ingredients';
import type { OAuthAccountStore } from './oauth.js';
import { mailAttachmentPartFromBytes, type CanonicalMessage, type MailDispatchBoundary, type MailProvider, type OutgoingMessage, type SentMessageMeta } from './provider.js';
import { submitSmtp, type SmtpConfig, type SmtpTransportFactory } from './smtp.js';
import { settleWithin, STOP_GRACE_MS } from '../../lifecycle/settle-within.js';

interface OutgoingJournal {
  status: 'pending' | 'accepted';
  message: OutgoingMessage;
  meta: SentMessageMeta;
}

const localCopy = (entry: OutgoingJournal, from: string): CanonicalMessage => ({
  source_id: entry.meta.source_id, rfc_message_id: entry.meta.message_id,
  reconciliation_id: entry.message.reconciliation_id,
  from, to: entry.message.to, cc: entry.message.cc ?? [], bcc: entry.message.bcc, subject: entry.message.subject,
  thread_id: entry.message.in_reply_to ?? entry.meta.message_id,
  folder_or_label: 'Sent', direction: 'outbound', is_read: true, is_flagged: false,
  received_at: entry.meta.sent_at, body_text: entry.message.body_text, body_html: entry.message.body_html,
  has_attachments: Boolean(entry.message.attachments?.length),
  attachments: entry.message.attachments?.map((attachment, index) => mailAttachmentPartFromBytes({
    filename: attachment.filename, mime_type: attachment.mime_type,
    source_part_id: String(index + 1), bytes: Buffer.from(attachment.bytes_b64, 'base64'),
  })),
  headers: { 'message-id': entry.meta.message_id,
    ...(entry.message.in_reply_to ? { 'in-reply-to': entry.message.in_reply_to } : {}),
    ...(entry.message.reply_to ? { 'reply-to': entry.message.reply_to } : {}),
  },
});

/** No inbound connection, scan, or source-proof lookup is implemented here. */
export const createSmtpProvider = (opts: {
  slug: string; config: SmtpConfig; accountStore: OAuthAccountStore;
  smtpFactory?: SmtpTransportFactory; now?: () => number;
}): MailProvider => {
  const prefix = `smtp.${opts.slug}.outgoing.`;
  const key = (sourceId: string) => prefix + Buffer.from(sourceId).toString('base64url');
  const store = opts.accountStore;
  let closed = false;
  const inFlight = new Set<Promise<SentMessageMeta>>();
  const acknowledge = (sourceId: string) => store.delete(key(sourceId));
  const send = async (message: OutgoingMessage, boundary?: MailDispatchBoundary): Promise<SentMessageMeta> => {
    const msg = { ...message, reply_to: message.reply_to ?? opts.config.reply_to };
    let journal: OutgoingJournal | undefined;
    let meta: SentMessageMeta;
    try {
      ({ meta } = await submitSmtp({ kind: 'smtp', slug: opts.slug, msg, config: opts.config,
        factory: opts.smtpFactory, now: opts.now,
        boundary: { revalidate: boundary?.revalidate, assertActive() {
          if (closed) throw new IngredientError('MAIL_SEND_NETWORK_FAILED', 'This SMTP account is no longer active.', { not_sent: true });
          boundary?.assertActive();
        } },
        beforeSubmit: async next => {
          journal = { status: 'pending', message: msg, meta: next };
          await store.set(key(next.source_id), JSON.stringify(journal));
        },
      }));
    } catch (error) {
      if (journal && error instanceof IngredientError && error.details?.not_sent === true) {
        await acknowledge(journal.meta.source_id).catch(() => {});
      }
      throw error;
    }
    const accepted: OutgoingJournal = { status: 'accepted', message: msg, meta };
    try { await store.set(key(meta.source_id), JSON.stringify(accepted)); }
    catch {
      meta.warnings = [{ code: 'MAIL_SEND_LOCAL_COPY_FAILED',
        message: 'SMTP accepted the message, but its local history receipt could not be saved. Do not resend.' }];
    }
    return { ...meta, local_copy: localCopy(accepted, opts.config.from) };
  };
  return {
    kind: 'smtp', slug: opts.slug, accountEmail: opts.config.from,
    sendCapable: true, draftCapable: false, mutationCapable: false,
    async connect() { closed = false; }, async initialScan() {},
    async startSync() { return async () => {}; },
    // A send in flight gets the stop's grace and no more. Cut off by the exit,
    // it stays in the outgoing journal as `pending` — an unknown outcome, kept
    // and never sent again (`replay` skips every entry not `accepted`) — and a
    // send that had not reached the server yet is refused by `closed` first.
    async close() { closed = true; await settleWithin(Promise.allSettled([...inFlight]), STOP_GRACE_MS); },
    health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: inFlight.size }),
    localSent: {
      acknowledge,
      async replay(onMessage) {
        const entries = await store.getAll?.();
        if (!entries) throw new Error('SMTP outgoing history storage is unavailable.');
        for (const [entryKey, value] of Object.entries(entries)) {
          if (!entryKey.startsWith(prefix)) continue;
          const entry = JSON.parse(value) as OutgoingJournal;
          // Unknown attempts are retained; no replay ever dispatches mail.
          if (entry.status !== 'accepted') continue;
          await onMessage(localCopy(entry, opts.config.from));
          await acknowledge(entry.meta.source_id);
        }
      },
    },
    send(message, boundary) {
      if (closed) return Promise.reject(new IngredientError('MAIL_SEND_NETWORK_FAILED',
        'This SMTP account is no longer active.', { kind: 'smtp', slug: opts.slug, not_sent: true }));
      const pending = send(message, boundary);
      inFlight.add(pending);
      void pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
      return pending;
    },
  };
};
