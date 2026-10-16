import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseMailDraftContent,customerJobPaymentStatementLines,CUSTOMER_JOB_PAYMENT_STATEMENT_REFERENCE_PREFIX,
  type MailDraftContent,type CustomerJobPaymentStatementInput,type CustomerJobPaymentStatementDraftInput,
  type CustomerJobPaymentStatementDraftResult } from '@recued/contracts';
import { QuoteSignoffError,type QuoteSignoffService } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { createMailSendClaimStore } from './storage/mail-send-claim-store.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string): never => { throw new QuoteSignoffError('customer_statement_invalid',message,400); };
const stale = (): never => { throw new QuoteSignoffError('customer_statement_stale','The job, invoice or payment records changed. Refresh and review a new job payment statement.'); };
const jobId = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
  ? value : invalid('Choose a customer job before preparing a payment statement.');
const digest = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  ? value : invalid('Refresh the job payment statement before preparing an email.');
interface DraftRow { reference: string;job_id: string;statement_hash: string;settings_ciphertext: string }
interface Settings { sender: string;recipient: string;core: string;content: MailDraftContent }
const readSettings = (value: unknown,reference: string): Settings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return stale();
  const settings = value as Partial<Settings>;
  if (typeof settings.sender !== 'string' || typeof settings.recipient !== 'string'
    || typeof settings.core !== 'string' || !settings.core) return stale();
  const content = parseMailDraftContent(settings.content);
  if (content.sender_mail_instance !== settings.sender || content.to.length !== 1 || content.to[0] !== settings.recipient
    || content.reconciliation_id !== reference || content.body_format !== 'text' || !content.body.includes(settings.core)) return stale();
  return { sender: settings.sender,recipient: settings.recipient,core: settings.core,content };
};

/** A statement is a read-only customer copy. Only its private email reservation is written. */
export const createCustomerJobPaymentStatementService = (deps: {
  db: Database.Database;signoffs: QuoteSignoffService;codec: PreapprovalCodec;now: () => number;
}) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_job_payment_statement_drafts (
    reference TEXT PRIMARY KEY,job_id TEXT NOT NULL,statement_hash TEXT NOT NULL,
    settings_ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS customer_job_payment_statement_drafts_job ON customer_job_payment_statement_drafts(job_id);
  CREATE INDEX IF NOT EXISTS core_record_outbox_payment_identity_idx
    ON core_record_outbox(publisher,pack_slug,pk) WHERE kind='payment';`);
  const claims = createMailSendClaimStore(deps.db);
  const readRow = (reference: string) => deps.db.prepare('SELECT * FROM customer_job_payment_statement_drafts WHERE reference=?').get(reference) as DraftRow | undefined;
  const assertRow = (row: DraftRow) => {
    const fresh = readRow(row.reference);
    if (!fresh || fresh.job_id !== row.job_id || fresh.statement_hash !== row.statement_hash
      || fresh.settings_ciphertext !== row.settings_ciphertext) return stale();
  };
  const assertNoUncertain = (job_id: string,except?: string) => {
    const rows = deps.db.prepare('SELECT reference FROM customer_job_payment_statement_drafts WHERE job_id=?').all(job_id) as Array<{ reference: string }>;
    if (rows.some(row => { const claim = row.reference === except ? null : claims.get(row.reference);
      return claim && !['sent','confirmed','reconciled','not_sent','released'].includes(claim.status); })) {
      throw new QuoteSignoffError('customer_statement_uncertain','Check the previous statement email outcome in Mail before preparing another.');
    }
  };
  const snapshot = (id: unknown) => { deps.codec.assertUnlocked();return deps.signoffs.jobPaymentStatementSnapshot(jobId(id)); };
  const savedContent = async (row: DraftRow,job_id: string,statement_hash: string): Promise<CustomerJobPaymentStatementDraftResult> => {
    if (row.job_id !== job_id || row.statement_hash !== statement_hash) return stale();
    const settings = readSettings(await deps.codec.open(row.settings_ciphertext),row.reference);
    if (snapshot(job_id).statement_hash !== statement_hash) return stale();
    assertRow(row);assertNoUncertain(job_id);
    return { idempotency_key: row.reference,content: settings.content };
  };
  return {
    statement(input: CustomerJobPaymentStatementInput) { return snapshot(input.job_id); },
    async draft(input: CustomerJobPaymentStatementDraftInput): Promise<CustomerJobPaymentStatementDraftResult> {
      const statement = snapshot(input.job_id);
      if (statement.statement_hash !== digest(input.expected_statement_hash)) return stale();
      if (typeof input.sender_mail_instance !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.sender_mail_instance)
        || typeof input.recipient_email !== 'string' || input.recipient_email.length > 254
        || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.recipient_email)) invalid('Choose a mail account and one customer email address.');
      const core = customerJobPaymentStatementLines(statement).join('\n');
      const reference = CUSTOMER_JOB_PAYMENT_STATEMENT_REFERENCE_PREFIX + hash([statement.statement_hash,input.sender_mail_instance,input.recipient_email]);
      const content = parseMailDraftContent({ sender_mail_instance: input.sender_mail_instance,to: [input.recipient_email],
        subject: `Job payment statement: ${statement.quote_reference ?? statement.quote_label}`.replace(/[\r\n]/g,' ').slice(0,200),
        body_format: 'text',body: `Hello ${statement.customer},\n\nHere are the invoices and recorded payments for your job.\n\n${core}\n\n`,reconciliation_id: reference });
      assertNoUncertain(statement.job_id);
      const existing = readRow(reference);
      if (existing) return savedContent(existing,statement.job_id,statement.statement_hash);
      const settings: Settings = { sender: input.sender_mail_instance,recipient: input.recipient_email,core,content };
      const ciphertext = deps.codec.sealSync(settings);
      if (snapshot(statement.job_id).statement_hash !== statement.statement_hash) return stale();
      assertNoUncertain(statement.job_id);
      deps.db.prepare(`INSERT INTO customer_job_payment_statement_drafts
        (reference,job_id,statement_hash,settings_ciphertext,created_at) VALUES (?,?,?,?,?)
        ON CONFLICT(reference) DO NOTHING`).run(reference,statement.job_id,statement.statement_hash,ciphertext,deps.now());
      const stored = readRow(reference);if (!stored) return stale();
      if (stored.settings_ciphertext !== ciphertext) return savedContent(stored,statement.job_id,statement.statement_hash);
      return { idempotency_key: reference,content };
    },
    async guardSend(input: { reconciliation_id?: unknown;instance?: unknown;to?: unknown;cc?: unknown;bcc?: unknown;
      body_text?: unknown;body_html?: unknown;attachments?: unknown }): Promise<(() => void) | undefined> {
      if (typeof input.reconciliation_id !== 'string' || !input.reconciliation_id.startsWith(CUSTOMER_JOB_PAYMENT_STATEMENT_REFERENCE_PREFIX)) return;
      if (!/^qjs_[a-f0-9]{64}$/.test(input.reconciliation_id)) return stale();
      const row = readRow(input.reconciliation_id);if (!row) return stale();deps.codec.assertUnlocked();
      const settings = readSettings(await deps.codec.open(row.settings_ciphertext),row.reference);
      const empty = (value: unknown) => value === undefined || value === null || Array.isArray(value) && value.length === 0;
      if (input.instance !== settings.sender || !Array.isArray(input.to) || input.to.length !== 1 || input.to[0] !== settings.recipient
        || !empty(input.cc) || !empty(input.bcc) || !empty(input.attachments)
        || input.body_html !== undefined && input.body_html !== null
        || typeof input.body_text !== 'string' || !input.body_text.includes(settings.core)) {
        invalid('Keep the statement’s account, customer, invoices, payments and balances. Refresh and prepare a new statement to change them.');
      }
      const assert = () => {
        deps.codec.assertUnlocked();
        if (snapshot(row.job_id).statement_hash !== row.statement_hash) return stale();
        assertRow(row);assertNoUncertain(row.job_id,row.reference);
      };
      assert();return assert;
    },
  };
};
export type CustomerJobPaymentStatementService = ReturnType<typeof createCustomerJobPaymentStatementService>;
