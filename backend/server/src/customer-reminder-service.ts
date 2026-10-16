import { isCustomerJobArchived,isCustomerSignoffArchived,jobArchiveTableExists } from './storage/customer-job-archive-store.js';
/** Shared durable follow-up engine. Customer mail is prepared privately;
 * ordinary mail approval and send claims remain the only delivery path. */
import type Database from 'better-sqlite3';
import { parseMailDraftContent,SIGNOFF_REMINDER_REFERENCE_PREFIX,COMPLETION_REMINDER_REFERENCE_PREFIX,PAYMENT_REMINDER_REFERENCE_PREFIX,CUSTOMER_ACCOUNT_PAYMENT_REMINDER_REFERENCE_PREFIX,
  type QuoteSignoffReminder,type QuoteSignoffReminderSetInput,type QuoteSignoffReminderListInput,
  type QuoteSignoffReminderDraftResult,type ApprovalLinkConfig } from '@recued/contracts';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import type { PublicEndpointRegistryStore } from './storage/public-endpoint-registry-store.js';
import { createMailSendClaimStore } from './storage/mail-send-claim-store.js';

export interface CustomerReminderRequest { customer: string;quote_label: string;expires_at: number;endpoint_id: string | null;state: string;availability: string }
export interface CustomerReminderState extends Omit<QuoteSignoffReminder,'signoff_id'> { request_id: string;draft_stale?: boolean }
export interface CustomerReminderSetInput extends Omit<QuoteSignoffReminderSetInput,'signoff_id'> { request_id: string }
export type CustomerReminderListInput = QuoteSignoffReminderListInput;
export type CustomerReminderDraftResult = QuoteSignoffReminderDraftResult;
export interface CustomerReminderListResult<T> { reminders: Array<{ request: T;reminder: CustomerReminderState }>;next_cursor?: string }
type CustomerReminderDeps<T extends CustomerReminderRequest> = {
  db: Database.Database;codec: PreapprovalCodec;now: () => number;
  identify: (request: T) => string;message: (request: T,link: string) => { subject: string;body: string };
  notificationText?: (request: T) => string;
  assertReady?: (request: T,reference?: string) => void;reserveDraft?: (request: T,reference: string) => void;
} & ({
  kind: 'offer' | 'completion';endpoints: PublicEndpointRegistryStore;
  pepper: () => Buffer;shareBaseUrl: () => string;
  requests: { get: (id: string) => T;approvalConfig: (id: string) => ApprovalLinkConfig };
} | {
  kind: 'payment';requests: { get: (id: string) => T };current: (request: T) => boolean;fingerprint: (request: T) => string | null;
  invoiceLine: (request: T) => string;
} | {
  kind: 'account_payment';requests: { capture: (id: string) => Promise<() => T> };
  current: (request: T) => boolean;fingerprint: (request: T) => string | null;invoiceLine: (request: T) => string;
});
const REMINDER_TARGETS = {
  offer: { table: 'quote_signoff_reminders',idColumn: 'signoff_id',requestTable: 'quote_signoffs',
    prefix: SIGNOFF_REMINDER_REFERENCE_PREFIX,errorPrefix: 'quote_signoff_reminder',
    notificationTitle: 'Customer sign-off needs follow-up',location: 'Reception → Customer sign-offs' },
  completion: { table: 'quote_completion_reminders',idColumn: 'completion_id',requestTable: 'quote_completion_signoffs',
    prefix: COMPLETION_REMINDER_REFERENCE_PREFIX,errorPrefix: 'quote_completion_reminder',
    notificationTitle: 'Customer completion needs follow-up',location: 'Reception → Customer jobs' },
  payment: { table: 'quote_payment_reminders',idColumn: 'signoff_id',requestTable: 'quote_signoffs',
    prefix: PAYMENT_REMINDER_REFERENCE_PREFIX,errorPrefix: 'quote_payment_reminder',
    notificationTitle: 'Customer payment needs follow-up',location: 'Reception → Customer jobs' },
  account_payment: { table: 'customer_account_payment_reminders',idColumn: 'account_id',requestTable: 'customer_accounts',
    prefix: CUSTOMER_ACCOUNT_PAYMENT_REMINDER_REFERENCE_PREFIX,errorPrefix: 'customer_account_payment_reminder',
    notificationTitle: 'Customer account payment needs follow-up',location: 'Reception → Customer jobs → Customer accounts' },
} as const;

interface Settings { share_url?: string; sender_mail_instance?: string; recipient_email?: string;draft_binding?: string }
interface Row {
  request_id: string; revision: number; due_at: number | null;
  settings_ciphertext: string; notified_at: number | null; drafted_at: number | null;
  last_draft_reference: string | null;
}
export const createCustomerReminderService = <T extends CustomerReminderRequest>(deps: CustomerReminderDeps<T>) => {
  const target = REMINDER_TARGETS[deps.kind];
  const paymentKind = deps.kind === 'payment' || deps.kind === 'account_payment';
  const capture = async (requestId: string): Promise<() => T> => {
    if (deps.kind === 'account_payment') return deps.requests.capture(requestId);
    return () => deps.requests.get(requestId);
  };
  const invalid = (message: string): never => { throw new QuoteSignoffError(`${target.errorPrefix}_invalid`, message, 400); };
  const stale = (): never => { throw new QuoteSignoffError(`${target.errorPrefix}_stale`, 'This follow-up changed. Refresh and review it again.'); };
  const stopped = (): never => { throw new QuoteSignoffError(`${target.errorPrefix}_stopped`, paymentKind
    ? deps.kind === 'account_payment' ? 'This account has no available unpaid invoices, has refunds owed, or contains unpaid archived work. Review its statement and restore archived jobs before following up.'
      : 'This invoice is no longer open for follow-up, an account follow-up is handling it, or its job is archived.' : 'This request is no longer waiting for a customer on an active link.'); };
  const reference = (row: Pick<Row, 'request_id' | 'revision'>) => `${target.prefix}${row.request_id}_${row.revision}`;
  const revision = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) invalid('The current follow-up revision is required.');
  };
  const id = (value: unknown): string => typeof value === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
    ? value : invalid(deps.kind === 'account_payment' ? 'A saved customer account reference is required.' : 'A customer sign-off reference is required.');

  deps.db.exec(`CREATE TABLE IF NOT EXISTS ${target.table} (
    ${target.idColumn} TEXT PRIMARY KEY REFERENCES ${target.requestTable}(${target.idColumn}),
    revision INTEGER NOT NULL, due_at INTEGER,
    settings_ciphertext TEXT NOT NULL, notified_at INTEGER, drafted_at INTEGER, last_draft_reference TEXT
  ); CREATE INDEX IF NOT EXISTS ${target.table}_due ON ${target.table}(due_at,${target.idColumn});`);
  const claims = createMailSendClaimStore(deps.db);
  const read = (requestId: string) => deps.db.prepare(`SELECT ${target.idColumn} AS request_id,* FROM ${target.table} WHERE ${target.idColumn}=?`)
    .get(requestId) as Row | undefined;
  const settings = async (row: Row | undefined): Promise<Settings> => row
    ? await deps.codec.open(row.settings_ciphertext) as Settings : {};
  const linkIsCurrent = (request: T, url: string): boolean => {
    if (paymentKind) return false;
    try {
      const parsed = new URL(url); const base = new URL(deps.shareBaseUrl());
      return parsed.origin === base.origin && parsed.username === '' && parsed.password === '' && parsed.hash === ''
        && parsed.pathname === `${base.pathname.replace(/\/+$/, '')}/reception/approve/${encodeURIComponent(request.endpoint_id!)}`
        && [...parsed.searchParams.keys()].length === 1 && parsed.searchParams.has('t')
        && deps.endpoints.verifyBearer({ endpoint_id: request.endpoint_id!, submitted_secret: parsed.searchParams.get('t')!,
          pepper: deps.pepper(), now: deps.now() }).kind === 'ok';
    } catch { return false; }
  };
  const isCurrent = (request: T, config: Settings): boolean => {
    if (deps.kind === 'completion' && jobArchiveTableExists(deps.db)) {
      const row = deps.db.prepare('SELECT root_signoff_id FROM quote_completion_signoffs WHERE completion_id=?').get(deps.identify(request)) as { root_signoff_id: string } | undefined;
      if (row && isCustomerJobArchived(deps.db,row.root_signoff_id)) return false;
    } else if (deps.kind !== 'account_payment' && isCustomerSignoffArchived(deps.db,deps.identify(request))) return false;
    if (paymentKind) return deps.current(request);
    if (request.state !== 'waiting' || request.availability !== 'current' || !request.endpoint_id) return false;
    // The visitor consume is durable before the response processor advances
    // the sign-off row. Stop at that first write, including during drain lag.
    if (!deps.db.prepare(`SELECT 1 FROM reception_approval_intent WHERE intent_id=? AND endpoint_id=?
      AND target_id=? AND action_kind='approve_wording' AND consumed_at IS NULL`)
      .get(request.endpoint_id,request.endpoint_id,deps.identify(request))) return false;
    const endpoint = deps.endpoints.loadForVerify(request.endpoint_id, deps.now());
    try {
      if (!endpoint || typeof endpoint.metadata_blob !== 'string'
        || JSON.stringify(JSON.parse(endpoint.metadata_blob)) !== JSON.stringify(deps.requests.approvalConfig(deps.identify(request)))) return false;
    } catch { return false; }
    return endpoint !== null && endpoint.enabled === 1 && endpoint.revoked_at === null
      && (endpoint.expires_at === null || endpoint.expires_at > deps.now())
      && (!config.share_url || linkIsCurrent(request, config.share_url));
  };
  const delivery = (row: Row | undefined): CustomerReminderState['delivery'] => {
    if (!row) return 'not_prepared';
    const claim = row.last_draft_reference ? claims.get(row.last_draft_reference) : null;
    if (claim && !['sent', 'reconciled', 'confirmed', 'not_sent', 'released'].includes(claim.status)) return 'uncertain';
    if (row.drafted_at === null || row.last_draft_reference !== reference(row)) return 'not_prepared';
    if (!claim) return 'draft_ready';
    if (claim.status === 'sent' || claim.status === 'reconciled' || claim.status === 'confirmed') return 'sent';
    if (claim.status === 'not_sent' || claim.status === 'released') return 'not_sent';
    return 'uncertain';
  };
  const describe = (request: T, row: Row | undefined, config: Settings): CustomerReminderState => ({
    request_id: deps.identify(request), revision: row?.revision ?? 0, due_at: row?.due_at ?? null,
    status: !row || row.revision === 0 ? 'unscheduled' : row.due_at === null ? 'paused'
      : !isCurrent(request, config) || delivery(row) === 'sent' ? 'stopped'
        : row.due_at <= deps.now() ? 'due' : 'scheduled',
    has_saved_link: Boolean(config.share_url && linkIsCurrent(request, config.share_url)),
    ...(config.sender_mail_instance ? { sender_mail_instance: config.sender_mail_instance } : {}),
    ...(config.recipient_email ? { recipient_email: config.recipient_email } : {}),
    notified_at: row?.notified_at ?? null, drafted_at: row?.drafted_at ?? null, delivery: delivery(row),
    ...(paymentKind ? { draft_stale: Boolean(row?.drafted_at !== undefined && row.drafted_at !== null
      && config.draft_binding !== deps.fingerprint(request)) } : {}),
  });
  let sweeping = false;
  const service = {
    rememberLink(requestId: string, shareUrl: string) {
      if (paymentKind) return invalid('Payment reminders use billing records, not an approval link.');
      deps.codec.assertUnlocked(); const request = deps.requests.get(id(requestId));
      if (!isCurrent(request, { share_url: shareUrl })) stopped();
      const ciphertext = deps.codec.sealSync({ share_url: shareUrl });
      deps.db.prepare(`INSERT INTO ${target.table}
        (${target.idColumn},revision,due_at,settings_ciphertext,notified_at,drafted_at) VALUES (?,0,NULL,?,NULL,NULL)
        ON CONFLICT(${target.idColumn}) DO NOTHING`).run(requestId, ciphertext);
    },
    async get(requestId: string): Promise<CustomerReminderState> {
      deps.codec.assertUnlocked(); const readRequest = await capture(id(requestId));readRequest();const row = read(requestId);
      const config = await settings(row);
      const fresh = read(requestId);
      // First draft preparation can bind new ciphertext at the same revision.
      // Never pair those new durable fields with an older decrypted config.
      if ((fresh?.revision ?? 0) !== (row?.revision ?? 0) || fresh?.settings_ciphertext !== row?.settings_ciphertext) stale();
      return describe(readRequest(), fresh, config);
    },
    async set(input: CustomerReminderSetInput): Promise<CustomerReminderState> {
      id(input.request_id); revision(input.expected_revision); deps.codec.assertUnlocked();
      for (const key of ['share_url', 'sender_mail_instance', 'recipient_email'] as const) {
        if (input[key] !== undefined && typeof input[key] !== 'string') invalid('Invalid follow-up settings.');
      }
      const readRequest = await capture(input.request_id);const request = readRequest();const row = read(input.request_id);
      if (paymentKind && input.share_url !== undefined) invalid('Payment reminders use the linked invoice, not an approval link.');
      if ((row?.revision ?? 0) !== input.expected_revision) stale();
      if (input.due_at !== null && (!Number.isSafeInteger(input.due_at) || input.due_at <= 0
        || !Number.isFinite(new Date(input.due_at).getTime()) || !paymentKind && input.due_at >= request.expires_at)) {
        invalid(paymentKind ? 'Choose a valid follow-up date and time.' : 'Choose a follow-up time before this request expires.');
      }
      if (input.due_at !== null && delivery(row) === 'uncertain') {
        throw new QuoteSignoffError(`${target.errorPrefix}_uncertain`, 'Check the previous email outcome in Mail before scheduling another reminder.');
      }
      const { draft_binding: _previousBinding,...old } = await settings(row);
      const config: Settings = { ...old,
        ...(input.share_url !== undefined ? { share_url: input.share_url } : {}),
        ...(input.sender_mail_instance !== undefined ? { sender_mail_instance: input.sender_mail_instance.trim() } : {}),
        ...(input.recipient_email !== undefined ? { recipient_email: input.recipient_email.trim() } : {}),
      };
      if (config.share_url && (input.due_at !== null || input.share_url !== undefined)
        && (config.share_url.length > 2048 || !linkIsCurrent(request, config.share_url))) {
        invalid('Paste the active link for this request, from this server.');
      }
      if (Boolean(config.sender_mail_instance) !== Boolean(config.recipient_email)) invalid('Choose both a mail account and a customer email, or leave both blank.');
      if (config.sender_mail_instance && (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(config.sender_mail_instance)
        || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(config.recipient_email!) || config.recipient_email!.length > 254)) {
        invalid('Choose a mail account and one customer email address.');
      }
      const ciphertext = deps.codec.sealSync(config);
      const saved = deps.db.transaction(() => {
        deps.codec.assertUnlocked(); const current = read(input.request_id); const fresh = readRequest();
        if ((current?.revision ?? 0) !== input.expected_revision) stale();
        if (input.due_at !== null && !isCurrent(fresh, config)) stopped();
        if (input.due_at !== null) deps.assertReady?.(fresh);
        if (input.due_at !== null && delivery(current) === 'uncertain') stale();
        deps.db.prepare(`INSERT INTO ${target.table}
          (${target.idColumn},revision,due_at,settings_ciphertext,notified_at,drafted_at) VALUES (?,?,?,?,NULL,NULL)
          ON CONFLICT(${target.idColumn}) DO UPDATE SET revision=excluded.revision,due_at=excluded.due_at,
            settings_ciphertext=excluded.settings_ciphertext,notified_at=NULL,drafted_at=NULL`)
          .run(input.request_id, input.expected_revision + 1, input.due_at, ciphertext);
        return describe(fresh, read(input.request_id), config);
      }).immediate();
      return saved;
    },
    async list(input: CustomerReminderListInput = {}): Promise<CustomerReminderListResult<T>> {
      deps.codec.assertUnlocked(); const limit = input.limit === undefined ? 50 : input.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('Follow-up page limit must be 1–100.');
      let anchor: { due_at: number; request_id: string } | undefined;
      if (input.cursor !== undefined) {
        try {
          if (typeof input.cursor !== 'string' || input.cursor.length > 512) invalid('Invalid follow-up page.');
          const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()) as { v: number; due_at: number; signoff_id?: string; completion_id?: string;account_id?: string;kind?: string };
          if (value.v !== 1 || !Number.isSafeInteger(value.due_at) || value.due_at <= 0) invalid('Invalid follow-up page.');
          if (paymentKind && value.kind !== deps.kind) invalid('Invalid payment follow-up page.');
          anchor = { due_at: value.due_at, request_id: id(value[target.idColumn]) };
        } catch { invalid('Invalid follow-up page. Start from the first page.'); }
      }
      const rows = deps.db.prepare(`SELECT r.${target.idColumn} AS request_id,r.* FROM ${target.table} r JOIN ${target.requestTable} s USING(${target.idColumn})
        WHERE r.due_at IS NOT NULL AND ${deps.kind === 'account_payment' ? '1=1' : paymentKind ? "s.state='released'" : "s.state='waiting' AND s.expires_at>?"}
        ${anchor ? `AND (r.due_at>? OR (r.due_at=? AND r.${target.idColumn}>?))` : ''}
        ORDER BY r.due_at,r.${target.idColumn} LIMIT ?`).all(...(paymentKind ? [] : [deps.now()]),
        ...(anchor ? [anchor.due_at, anchor.due_at, anchor.request_id] : []), limit + 1) as Row[];
      const reminders: CustomerReminderListResult<T>['reminders'] = [];
      for (const row of rows.slice(0, limit)) {
        const config = await settings(row);
        const fresh = read(row.request_id);
        if (!fresh || fresh.revision !== row.revision || fresh.settings_ciphertext !== row.settings_ciphertext) continue;
        const readRequest = await capture(row.request_id);
        const after = read(row.request_id);
        if (!after || after.revision !== row.revision || after.settings_ciphertext !== row.settings_ciphertext) continue;
        const request = readRequest(); const reminder = describe(request, after, config);
        if (reminder.status === 'due' || reminder.status === 'scheduled') reminders.push({ request, reminder });
      }
      const last = rows[limit - 1];
      return { reminders, ...(rows.length > limit && last ? { next_cursor: Buffer.from(JSON.stringify({
        v: 1, due_at: last.due_at, [target.idColumn]: last.request_id,
        ...(paymentKind ? { kind: deps.kind } : {}),
      })).toString('base64url') } : {}) };
    },
    async draft(requestId: string, expectedRevision: number): Promise<CustomerReminderDraftResult> {
      id(requestId); revision(expectedRevision); deps.codec.assertUnlocked(); const row = read(requestId);
      if (!row || row.revision !== expectedRevision) return stale();
      const config = await settings(row);const readRequest = await capture(requestId);const request = readRequest();
      if (row.due_at === null || row.due_at > deps.now() || !isCurrent(request, config)) stopped();
      if (!paymentKind && !config.share_url || !config.sender_mail_instance || !config.recipient_email) {
        return invalid(paymentKind ? 'Set a customer email and mail account before preparing a payment email.'
          : 'Set a customer email, mail account and the active request link before preparing an email.');
      }
      const draftBinding = paymentKind ? deps.fingerprint(request) : null;
      if (paymentKind && (!draftBinding || row.drafted_at !== null && config.draft_binding !== draftBinding)) return stale();
      const ref = reference(row); const message = deps.message(request,config.share_url ?? '');
      const content = parseMailDraftContent({ sender_mail_instance: config.sender_mail_instance,to: [config.recipient_email],
        subject: message.subject.replace(/[\r\n]/g,' ').slice(0,200),body_format: 'text',body: message.body,reconciliation_id: ref });
      deps.db.transaction(() => {
        const fresh = read(requestId); deps.codec.assertUnlocked();
        if (!fresh || fresh.revision !== expectedRevision || fresh.settings_ciphertext !== row.settings_ciphertext) return stale();
        const currentRequest = readRequest();
        if (!isCurrent(currentRequest, config)) stopped();deps.assertReady?.(currentRequest,ref);
        if (paymentKind && deps.fingerprint(currentRequest) !== draftBinding) stale();
        if (delivery(fresh) === 'uncertain' || delivery(fresh) === 'sent') {
          throw new QuoteSignoffError(`${target.errorPrefix}_dispatched`, 'This reminder already has a send attempt. Review its outcome in Mail.');
        }
        const ciphertext = paymentKind && fresh.drafted_at === null
          ? deps.codec.sealSync({ ...config,draft_binding: draftBinding }) : fresh.settings_ciphertext;
        deps.db.prepare(`UPDATE ${target.table} SET drafted_at=COALESCE(drafted_at,?),last_draft_reference=?,settings_ciphertext=?
          WHERE ${target.idColumn}=? AND revision=?`).run(deps.now(), ref, ciphertext, requestId, expectedRevision);
        deps.reserveDraft?.(currentRequest,ref);
      }).immediate();
      return { idempotency_key: ref, content };
    },
    /** Called after the approval gate. The returned synchronous assertion runs
     * again after attachment/account reads, immediately before the send claim. */
    async guardSend(input: { reconciliation_id?: unknown; instance?: unknown; to?: unknown; cc?: unknown; bcc?: unknown;
      body_text?: unknown; body_html?: unknown; attachments?: unknown }): Promise<(() => void) | undefined> {
      if (typeof input.reconciliation_id !== 'string' || !input.reconciliation_id.startsWith(target.prefix)) return;
      const match = /^([a-f0-9-]{36})_(\d+)$/.exec(input.reconciliation_id.slice(target.prefix.length));
      if (!match) return stopped();
      const requestId = id(match[1]); const expectedRevision = Number(match[2]); const row = read(requestId);
      if (!row || row.revision !== expectedRevision || row.drafted_at === null || row.due_at === null) return stale();
      // Send claims use the exact string. A numeric alias (such as _01)
      // must not turn the same occurrence into a second claim.
      if (input.reconciliation_id !== reference(row) || row.last_draft_reference !== reference(row)) return stale();
      const config = await settings(row);const readRequest = await capture(requestId);
      if (!config.sender_mail_instance || !config.recipient_email
        || !paymentKind && !config.share_url || input.instance !== config.sender_mail_instance || !Array.isArray(input.to)
        || input.to.length !== 1 || input.to[0] !== config.recipient_email
        || Array.isArray(input.cc) && input.cc.length > 0 || Array.isArray(input.bcc) && input.bcc.length > 0
        || input.body_html !== undefined && input.body_html !== null
        || typeof input.body_text !== 'string' || !paymentKind && !input.body_text.includes(config.share_url!)
        || Array.isArray(input.attachments) && input.attachments.length > 0) {
        invalid(paymentKind ? 'Keep the reminder account, customer and invoice details. Save a new follow-up to change them.'
          : 'Keep the reminder account, customer and active link. Change them in the follow-up editor before preparing a new draft.');
      }
      const assert = () => {
        deps.codec.assertUnlocked(); const fresh = read(requestId);
        if (!fresh || fresh.revision !== expectedRevision || fresh.settings_ciphertext !== row.settings_ciphertext || fresh.due_at === null) return stale();
        const request = readRequest();
        if (fresh.due_at > deps.now() || !isCurrent(request, config)) stopped();deps.assertReady?.(request,reference(row));
        if (paymentKind) {
          if (!config.draft_binding || deps.fingerprint(request) !== config.draft_binding) stale();
          if (typeof input.body_text !== 'string' || !input.body_text.includes(deps.invoiceLine(request))) {
            invalid('Keep the invoice reference, recorded balance and due date in the reminder. Save a new follow-up if the invoice changed.');
          }
        }
      };
      assert(); return assert;
    },
    async sweep(notify: (message: { title: string; text: string }) => Promise<void>, isQuiet = (_now: number) => false,
      readCurrent?: (id: string) => Promise<CustomerReminderState>): Promise<void> {
      if (sweeping || isQuiet(deps.now())) return;
      sweeping = true;
      try {
        let cursor: string | undefined;
        do {
          const page = await service.list({ limit: 100, ...(cursor ? { cursor } : {}) });
          for (const item of page.reminders) {
            if (item.reminder.status !== 'due' || item.reminder.notified_at !== null || isQuiet(deps.now())) continue;
            const current = await (readCurrent ?? service.get)(deps.identify(item.request));
            if (current.status !== 'due' || current.revision !== item.reminder.revision || isQuiet(deps.now())) continue;
            const row = read(current.request_id); const config = await settings(row);const readRequest = await capture(current.request_id);
            // Mark before fan-out: queue visibility survives a stopped delivery,
            // and concurrent ticks/restarts cannot produce duplicate notifications.
            const claimed = deps.db.transaction(() => {
              deps.codec.assertUnlocked(); const fresh = read(current.request_id);
              if (!fresh || fresh.revision !== current.revision || fresh.settings_ciphertext !== row?.settings_ciphertext
                || fresh.notified_at !== null || isQuiet(deps.now())
                || describe(readRequest(), fresh, config).status !== 'due') return false;
              return deps.db.prepare(`UPDATE ${target.table} SET notified_at=?
                WHERE ${target.idColumn}=? AND revision=? AND notified_at IS NULL`)
                .run(deps.now(), current.request_id, current.revision).changes > 0;
            }).immediate();
            if (claimed) await notify({ title: target.notificationTitle,
              text: deps.notificationText?.(item.request)
                ?? `${item.request.customer} — ${item.request.quote_label}. Review the follow-up in ${target.location}.` });
          }
          cursor = page.next_cursor;
        } while (cursor);
      } finally { sweeping = false; }
    },
  };
  return service;
};
