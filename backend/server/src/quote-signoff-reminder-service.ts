/** Durable owner follow-up dates. Nothing in this service sends customer mail.
 * Links and recipient settings use the Reception encryption key; mail still runs
 * through the ordinary saved-draft recipe, approval gate and send-claim fence. */
import type Database from 'better-sqlite3';
import {
  parseMailDraftContent,
  SIGNOFF_REMINDER_REFERENCE_PREFIX,
  type QuoteSignoffReminder,
  type QuoteSignoffReminderSetInput,
  type QuoteSignoffReminderListInput,
  type QuoteSignoffReminderListResult,
  type QuoteSignoffReminderDraftResult,
  type QuoteSignoffSummary,
} from '@recued/contracts';
import { QuoteSignoffError, type QuoteSignoffService } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import type { PublicEndpointRegistryStore } from './storage/public-endpoint-registry-store.js';
import { createMailSendClaimStore } from './storage/mail-send-claim-store.js';

interface Settings { share_url?: string; sender_mail_instance?: string; recipient_email?: string }
interface Row {
  signoff_id: string; revision: number; due_at: number | null;
  settings_ciphertext: string; notified_at: number | null; drafted_at: number | null;
  last_draft_reference: string | null;
}
const invalid = (message: string): never => { throw new QuoteSignoffError('quote_signoff_reminder_invalid', message, 400); };
const stale = (): never => { throw new QuoteSignoffError('quote_signoff_reminder_stale', 'This follow-up changed. Refresh and review it again.'); };
const stopped = (): never => { throw new QuoteSignoffError('quote_signoff_reminder_stopped', 'This offer is no longer waiting for a customer on an active link.'); };
const reference = (row: Pick<Row, 'signoff_id' | 'revision'>) => `${SIGNOFF_REMINDER_REFERENCE_PREFIX}${row.signoff_id}_${row.revision}`;
const revision = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('The current follow-up revision is required.');
};
const id = (value: unknown): string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  ? value : invalid('A customer sign-off reference is required.');

export const createQuoteSignoffReminderService = (deps: {
  db: Database.Database; signoffs: QuoteSignoffService; codec: PreapprovalCodec;
  endpoints: PublicEndpointRegistryStore; pepper: () => Buffer; shareBaseUrl: () => string;
  now: () => number;
}) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS quote_signoff_reminders (
    signoff_id TEXT PRIMARY KEY REFERENCES quote_signoffs(signoff_id),
    revision INTEGER NOT NULL, due_at INTEGER,
    settings_ciphertext TEXT NOT NULL, notified_at INTEGER, drafted_at INTEGER, last_draft_reference TEXT
  ); CREATE INDEX IF NOT EXISTS quote_signoff_reminders_due ON quote_signoff_reminders(due_at,signoff_id);`);
  const claims = createMailSendClaimStore(deps.db);
  const read = (signoffId: string) => deps.db.prepare('SELECT * FROM quote_signoff_reminders WHERE signoff_id=?')
    .get(signoffId) as Row | undefined;
  const settings = async (row: Row | undefined): Promise<Settings> => row
    ? await deps.codec.open(row.settings_ciphertext) as Settings : {};
  const linkIsCurrent = (offer: QuoteSignoffSummary, url: string): boolean => {
    try {
      const parsed = new URL(url); const base = new URL(deps.shareBaseUrl());
      return parsed.origin === base.origin && parsed.username === '' && parsed.password === '' && parsed.hash === ''
        && parsed.pathname === `${base.pathname.replace(/\/+$/, '')}/reception/approve/${encodeURIComponent(offer.endpoint_id!)}`
        && [...parsed.searchParams.keys()].length === 1 && parsed.searchParams.has('t')
        && deps.endpoints.verifyBearer({ endpoint_id: offer.endpoint_id!, submitted_secret: parsed.searchParams.get('t')!,
          pepper: deps.pepper(), now: deps.now() }).kind === 'ok';
    } catch { return false; }
  };
  const isCurrent = (offer: QuoteSignoffSummary, config: Settings): boolean => {
    if (offer.state !== 'waiting' || offer.availability !== 'current' || !offer.endpoint_id) return false;
    // The visitor consume is durable before the response processor advances
    // the sign-off row. Stop at that first write, including during drain lag.
    if (!deps.db.prepare('SELECT 1 FROM reception_approval_intent WHERE intent_id=? AND consumed_at IS NULL')
      .get(offer.endpoint_id)) return false;
    const endpoint = deps.endpoints.loadForVerify(offer.endpoint_id, deps.now());
    try {
      if (!endpoint || typeof endpoint.metadata_blob !== 'string'
        || JSON.stringify(JSON.parse(endpoint.metadata_blob)) !== JSON.stringify(deps.signoffs.approvalConfig(offer.signoff_id))) return false;
    } catch { return false; }
    return endpoint !== null && endpoint.enabled === 1 && endpoint.revoked_at === null
      && (endpoint.expires_at === null || endpoint.expires_at > deps.now())
      && (!config.share_url || linkIsCurrent(offer, config.share_url));
  };
  const delivery = (row: Row | undefined): QuoteSignoffReminder['delivery'] => {
    if (!row) return 'not_prepared';
    const claim = row.last_draft_reference ? claims.get(row.last_draft_reference) : null;
    if (claim && !['sent', 'reconciled', 'confirmed', 'not_sent', 'released'].includes(claim.status)) return 'uncertain';
    if (row.drafted_at === null || row.last_draft_reference !== reference(row)) return 'not_prepared';
    if (!claim) return 'draft_ready';
    if (claim.status === 'sent' || claim.status === 'reconciled' || claim.status === 'confirmed') return 'sent';
    if (claim.status === 'not_sent' || claim.status === 'released') return 'not_sent';
    return 'uncertain';
  };
  const describe = (offer: QuoteSignoffSummary, row: Row | undefined, config: Settings): QuoteSignoffReminder => ({
    signoff_id: offer.signoff_id, revision: row?.revision ?? 0, due_at: row?.due_at ?? null,
    status: !row || row.revision === 0 ? 'unscheduled' : row.due_at === null ? 'paused'
      : !isCurrent(offer, config) || delivery(row) === 'sent' ? 'stopped'
        : row.due_at <= deps.now() ? 'due' : 'scheduled',
    has_saved_link: Boolean(config.share_url && linkIsCurrent(offer, config.share_url)),
    ...(config.sender_mail_instance ? { sender_mail_instance: config.sender_mail_instance } : {}),
    ...(config.recipient_email ? { recipient_email: config.recipient_email } : {}),
    notified_at: row?.notified_at ?? null, drafted_at: row?.drafted_at ?? null, delivery: delivery(row),
  });
  let sweeping = false;
  const service = {
    rememberLink(signoffId: string, shareUrl: string) {
      deps.codec.assertUnlocked(); const offer = deps.signoffs.get(id(signoffId));
      if (!isCurrent(offer, { share_url: shareUrl })) stopped();
      const ciphertext = deps.codec.sealSync({ share_url: shareUrl });
      deps.db.prepare(`INSERT INTO quote_signoff_reminders
        (signoff_id,revision,due_at,settings_ciphertext,notified_at,drafted_at) VALUES (?,0,NULL,?,NULL,NULL)
        ON CONFLICT(signoff_id) DO NOTHING`).run(signoffId, ciphertext);
    },
    async get(signoffId: string): Promise<QuoteSignoffReminder> {
      deps.codec.assertUnlocked(); deps.signoffs.get(id(signoffId)); const row = read(signoffId);
      const config = await settings(row);
      if ((read(signoffId)?.revision ?? 0) !== (row?.revision ?? 0)) stale();
      return describe(deps.signoffs.get(signoffId), row, config);
    },
    async set(input: QuoteSignoffReminderSetInput): Promise<QuoteSignoffReminder> {
      id(input.signoff_id); revision(input.expected_revision); deps.codec.assertUnlocked();
      for (const key of ['share_url', 'sender_mail_instance', 'recipient_email'] as const) {
        if (input[key] !== undefined && typeof input[key] !== 'string') invalid('Invalid follow-up settings.');
      }
      const offer = deps.signoffs.get(input.signoff_id); const row = read(input.signoff_id);
      if ((row?.revision ?? 0) !== input.expected_revision) stale();
      if (input.due_at !== null && (!Number.isSafeInteger(input.due_at) || input.due_at <= 0 || input.due_at >= offer.expires_at)) {
        invalid('Choose a follow-up time before this offer expires.');
      }
      if (input.due_at !== null && delivery(row) === 'uncertain') {
        throw new QuoteSignoffError('quote_signoff_reminder_uncertain', 'Check the previous email outcome in Mail before scheduling another reminder.');
      }
      const old = await settings(row);
      const config: Settings = { ...old,
        ...(input.share_url !== undefined ? { share_url: input.share_url } : {}),
        ...(input.sender_mail_instance !== undefined ? { sender_mail_instance: input.sender_mail_instance.trim() } : {}),
        ...(input.recipient_email !== undefined ? { recipient_email: input.recipient_email.trim() } : {}),
      };
      if (config.share_url && (input.due_at !== null || input.share_url !== undefined)
        && (config.share_url.length > 2048 || !linkIsCurrent(offer, config.share_url))) {
        invalid('Paste the active link for this offer, from this server.');
      }
      if (Boolean(config.sender_mail_instance) !== Boolean(config.recipient_email)) invalid('Choose both a mail account and a customer email, or leave both blank.');
      if (config.sender_mail_instance && (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(config.sender_mail_instance)
        || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(config.recipient_email!) || config.recipient_email!.length > 254)) {
        invalid('Choose a mail account and one customer email address.');
      }
      const ciphertext = deps.codec.sealSync(config);
      const saved = deps.db.transaction(() => {
        deps.codec.assertUnlocked(); const current = read(input.signoff_id); const fresh = deps.signoffs.get(input.signoff_id);
        if ((current?.revision ?? 0) !== input.expected_revision) stale();
        if (input.due_at !== null && !isCurrent(fresh, config)) stopped();
        if (input.due_at !== null && delivery(current) === 'uncertain') stale();
        deps.db.prepare(`INSERT INTO quote_signoff_reminders
          (signoff_id,revision,due_at,settings_ciphertext,notified_at,drafted_at) VALUES (?,?,?,?,NULL,NULL)
          ON CONFLICT(signoff_id) DO UPDATE SET revision=excluded.revision,due_at=excluded.due_at,
            settings_ciphertext=excluded.settings_ciphertext,notified_at=NULL,drafted_at=NULL`)
          .run(input.signoff_id, input.expected_revision + 1, input.due_at, ciphertext);
        return describe(fresh, read(input.signoff_id), config);
      }).immediate();
      return saved;
    },
    async list(input: QuoteSignoffReminderListInput = {}): Promise<QuoteSignoffReminderListResult> {
      deps.codec.assertUnlocked(); const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('Follow-up page limit must be 1–100.');
      let anchor: { due_at: number; signoff_id: string } | undefined;
      if (input.cursor !== undefined) {
        try {
          if (typeof input.cursor !== 'string' || input.cursor.length > 512) invalid('Invalid follow-up page.');
          const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()) as { v: number; due_at: number; signoff_id: string };
          if (value.v !== 1 || !Number.isSafeInteger(value.due_at) || value.due_at <= 0) invalid('Invalid follow-up page.');
          anchor = { due_at: value.due_at, signoff_id: id(value.signoff_id) };
        } catch { invalid('Invalid follow-up page. Start from the first page.'); }
      }
      const rows = deps.db.prepare(`SELECT r.* FROM quote_signoff_reminders r JOIN quote_signoffs s USING(signoff_id)
        WHERE r.due_at IS NOT NULL AND s.state='waiting' AND s.expires_at>?
        ${anchor ? 'AND (r.due_at>? OR (r.due_at=? AND r.signoff_id>?))' : ''}
        ORDER BY r.due_at,r.signoff_id LIMIT ?`).all(deps.now(),
        ...(anchor ? [anchor.due_at, anchor.due_at, anchor.signoff_id] : []), limit + 1) as Row[];
      const reminders: QuoteSignoffReminderListResult['reminders'] = [];
      for (const row of rows.slice(0, limit)) {
        const config = await settings(row);
        if (read(row.signoff_id)?.revision !== row.revision) continue;
        const signoff = deps.signoffs.get(row.signoff_id); const reminder = describe(signoff, row, config);
        if (reminder.status === 'due' || reminder.status === 'scheduled') reminders.push({ signoff, reminder });
      }
      const last = rows[limit - 1];
      return { reminders, ...(rows.length > limit && last ? { next_cursor: Buffer.from(JSON.stringify({
        v: 1, due_at: last.due_at, signoff_id: last.signoff_id,
      })).toString('base64url') } : {}) };
    },
    async draft(signoffId: string, expectedRevision: number): Promise<QuoteSignoffReminderDraftResult> {
      id(signoffId); revision(expectedRevision); deps.codec.assertUnlocked(); const row = read(signoffId);
      if (!row || row.revision !== expectedRevision) return stale();
      const config = await settings(row); const offer = deps.signoffs.get(signoffId);
      if (row.due_at === null || row.due_at > deps.now() || !isCurrent(offer, config)) stopped();
      if (!config.share_url || !config.sender_mail_instance || !config.recipient_email) {
        invalid('Set a customer email, mail account and the active offer link before preparing an email.');
      }
      const ref = reference(row); const quoteName = offer.quote_reference ?? offer.quote_label;
      const content = parseMailDraftContent({ sender_mail_instance: config.sender_mail_instance, to: [config.recipient_email],
        subject: `Reminder: please review ${quoteName}`.replace(/[\r\n]/g, ' ').slice(0, 200), body_format: 'text',
        body: `Hello ${offer.customer},\n\nPlease review our offer for ${quoteName} (${offer.amount} ${offer.currency}) and let us know your decision.\n\n${config.share_url}\n\nThis offer expires on ${new Date(offer.expires_at).toISOString()}.\n\nThank you.`,
        reconciliation_id: ref });
      deps.db.transaction(() => {
        const fresh = read(signoffId); deps.codec.assertUnlocked();
        if (fresh?.revision !== expectedRevision) stale();
        if (!isCurrent(deps.signoffs.get(signoffId), config)) stopped();
        if (delivery(fresh) === 'uncertain' || delivery(fresh) === 'sent') {
          throw new QuoteSignoffError('quote_signoff_reminder_dispatched', 'This reminder already has a send attempt. Review its outcome in Mail.');
        }
        deps.db.prepare(`UPDATE quote_signoff_reminders SET drafted_at=COALESCE(drafted_at,?),last_draft_reference=?
          WHERE signoff_id=? AND revision=?`).run(deps.now(), ref, signoffId, expectedRevision);
      }).immediate();
      return { idempotency_key: ref, content };
    },
    /** Called after the approval gate. The returned synchronous assertion runs
     * again after attachment/account reads, immediately before the send claim. */
    async guardSend(input: { reconciliation_id?: unknown; instance?: unknown; to?: unknown; cc?: unknown; bcc?: unknown;
      body_text?: unknown; body_html?: unknown; attachments?: unknown }): Promise<(() => void) | undefined> {
      if (typeof input.reconciliation_id !== 'string' || !input.reconciliation_id.startsWith(SIGNOFF_REMINDER_REFERENCE_PREFIX)) return;
      const match = /^qsr_([a-f0-9-]{36})_(\d+)$/.exec(input.reconciliation_id);
      if (!match) return stopped();
      const signoffId = id(match[1]); const expectedRevision = Number(match[2]); const row = read(signoffId);
      if (!row || row.revision !== expectedRevision || row.drafted_at === null || row.due_at === null) return stale();
      const config = await settings(row);
      if (!config.share_url || input.instance !== config.sender_mail_instance || !Array.isArray(input.to)
        || input.to.length !== 1 || input.to[0] !== config.recipient_email
        || Array.isArray(input.cc) && input.cc.length > 0 || Array.isArray(input.bcc) && input.bcc.length > 0
        || input.body_html !== undefined && input.body_html !== null
        || typeof input.body_text !== 'string' || !input.body_text.includes(config.share_url)
        || Array.isArray(input.attachments) && input.attachments.length > 0) {
        invalid('Keep the reminder account, customer and active link. Change them in Customer sign-offs before preparing a new draft.');
      }
      const assert = () => {
        deps.codec.assertUnlocked(); const fresh = read(signoffId);
        if (!fresh || fresh.revision !== expectedRevision || fresh.settings_ciphertext !== row.settings_ciphertext || fresh.due_at === null) return stale();
        if (fresh.due_at > deps.now() || !isCurrent(deps.signoffs.get(signoffId), config)) stopped();
      };
      assert(); return assert;
    },
    async sweep(notify: (message: { title: string; text: string }) => Promise<void>, isQuiet = (_now: number) => false) {
      if (sweeping || isQuiet(deps.now())) return;
      sweeping = true;
      try {
        let cursor: string | undefined;
        do {
          const page = await service.list({ limit: 100, ...(cursor ? { cursor } : {}) });
          for (const item of page.reminders) {
            if (item.reminder.status !== 'due' || item.reminder.notified_at !== null || isQuiet(deps.now())) continue;
            const current = await service.get(item.signoff.signoff_id);
            if (current.status !== 'due' || current.revision !== item.reminder.revision || isQuiet(deps.now())) continue;
            const row = read(current.signoff_id); const config = await settings(row);
            // Mark before fan-out: queue visibility survives a stopped delivery,
            // and concurrent ticks/restarts cannot produce duplicate notifications.
            const claimed = deps.db.transaction(() => {
              deps.codec.assertUnlocked(); const fresh = read(current.signoff_id);
              if (!fresh || fresh.revision !== current.revision || fresh.settings_ciphertext !== row?.settings_ciphertext
                || fresh.notified_at !== null || isQuiet(deps.now())
                || describe(deps.signoffs.get(current.signoff_id), fresh, config).status !== 'due') return false;
              return deps.db.prepare(`UPDATE quote_signoff_reminders SET notified_at=?
                WHERE signoff_id=? AND revision=? AND notified_at IS NULL`)
                .run(deps.now(), current.signoff_id, current.revision).changes > 0;
            }).immediate();
            if (claimed) await notify({ title: 'Customer sign-off needs follow-up',
              text: `${item.signoff.customer} — ${item.signoff.quote_label}. Review the follow-up in Reception → Customer sign-offs.` });
          }
          cursor = page.next_cursor;
        } while (cursor);
      } finally { sweeping = false; }
    },
  };
  return service;
};
export type QuoteSignoffReminderService = ReturnType<typeof createQuoteSignoffReminderService>;
