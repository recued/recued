import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CUSTOMER_ACCOUNT_MAX_JOBS,CUSTOMER_ACCOUNT_STATEMENT_REFERENCE_PREFIX,customerAccountStatementLines,parseMailDraftContent,
  type CustomerAccount,type CustomerAccountInput,type CustomerAccountSaveInput,type CustomerAccountsListInput,type CustomerAccountsListResult,
  type CustomerAccountStatement,type CustomerAccountStatementBalance,type CustomerAccountStatementDraftInput,
  type CustomerAccountStatementDraftResult,type MailDraftContent } from '@recued/contracts';
import { QuoteSignoffError,type QuoteSignoffService } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { createMailSendClaimStore } from './storage/mail-send-claim-store.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string): never => { throw new QuoteSignoffError('customer_account_invalid',message,400); };
const stale = (): never => { throw new QuoteSignoffError('customer_account_stale','The account, its selected jobs or their billing records changed. Refresh and review a new account statement.'); };
const unavailable = (): never => { throw new QuoteSignoffError('customer_account_unavailable','This customer account is unavailable. Refresh its saved job selection before continuing.'); };
const uuid = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
  ? value : invalid('Choose a saved customer account and original customer jobs.');
const jobs = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > CUSTOMER_ACCOUNT_MAX_JOBS) return invalid('Choose up to 100 original customer jobs.');
  const ids = value.map(uuid).sort();
  if (new Set(ids).size !== ids.length) return invalid('Choose each original customer job only once.');
  return ids;
};
const customerName = (value: unknown): string => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200 && !/[\x00-\x1f\x7f]/.test(value)
  ? value.trim() : invalid('Enter a customer account name of up to 200 characters on one line.');
interface AccountRow { account_id: string;revision: number;settings_ciphertext: string;created_at: number;updated_at: number }
interface Selection { customer: string;job_ids: string[] }
interface DraftRow { reference: string;account_id: string;statement_hash: string;settings_ciphertext: string }
interface MailSettings { sender: string;recipient: string;core: string;content: MailDraftContent }
const selection = (value: unknown): Selection => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('customer' in value) || !('job_ids' in value)) return unavailable();
  const customer = customerName(value.customer);const job_ids = jobs(value.job_ids);
  if (JSON.stringify(value.job_ids) !== JSON.stringify(job_ids)) return unavailable();
  return { customer,job_ids };
};
const mailSettings = (value: unknown,reference: string): MailSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('sender' in value) || typeof value.sender !== 'string' || !('recipient' in value) || typeof value.recipient !== 'string'
    || !('core' in value) || typeof value.core !== 'string' || !value.core || !('content' in value)) return stale();
  const content = parseMailDraftContent(value.content);
  if (content.sender_mail_instance !== value.sender || content.to.length !== 1 || content.to[0] !== value.recipient
    || content.reconciliation_id !== reference || content.body_format !== 'text' || !content.body.includes(value.core)) return stale();
  return { sender: value.sender,recipient: value.recipient,core: value.core,content };
};
const units = (value: string) => {
  if (!/^\d+\.\d{4}$/.test(value) || value.length > 32) return unavailable();
  return BigInt(value.replace('.',''));
};
const decimal = (value: bigint) => `${value / 10_000n}.${String(value % 10_000n).padStart(4,'0')}`;

/** Account membership is explicit owner metadata. Statements reuse the complete
 * job snapshots; they never merge names, alter a ledger or offset customer debt. */
export const createCustomerAccountStatementService = (deps: {
  db: Database.Database;signoffs: QuoteSignoffService;codec: PreapprovalCodec;now: () => number;
}) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_accounts (
    account_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,settings_ciphertext TEXT NOT NULL,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS customer_account_jobs (
    job_id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES customer_accounts(account_id)
  ); CREATE INDEX IF NOT EXISTS customer_account_jobs_account ON customer_account_jobs(account_id);
  CREATE TABLE IF NOT EXISTS customer_account_statement_drafts (
    reference TEXT PRIMARY KEY,account_id TEXT NOT NULL,statement_hash TEXT NOT NULL,
    settings_ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS customer_account_statement_drafts_account ON customer_account_statement_drafts(account_id);
  CREATE INDEX IF NOT EXISTS core_record_outbox_payment_identity_idx
    ON core_record_outbox(publisher,pack_slug,pk) WHERE kind='payment';`);
  const claims = createMailSendClaimStore(deps.db);
  const row = (id: string) => deps.db.prepare('SELECT * FROM customer_accounts WHERE account_id=?').get(id) as AccountRow | undefined;
  const assertRow = (expected: AccountRow,account?: Selection) => {
    deps.codec.assertUnlocked();
    const fresh = row(expected.account_id);
    if (!fresh || JSON.stringify(fresh) !== JSON.stringify(expected)) return stale();
    if (account) {
      const linked = deps.db.prepare('SELECT job_id FROM customer_account_jobs WHERE account_id=? ORDER BY job_id').all(expected.account_id) as Array<{ job_id: string }>;
      if (JSON.stringify(linked.map(job => job.job_id)) !== JSON.stringify(account.job_ids)) return unavailable();
    }
  };
  const open = async (saved: AccountRow) => {
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 1) return unavailable();
    const settings = selection(await deps.codec.open(saved.settings_ciphertext));
    assertRow(saved,settings);
    const account: CustomerAccount = { account_id: saved.account_id,revision: saved.revision,...settings,created_at: saved.created_at,updated_at: saved.updated_at };
    return { saved,account };
  };
  const load = async (id: unknown) => { deps.codec.assertUnlocked();const saved = row(uuid(id));if (!saved) return unavailable();return open(saved); };
  const snapshot = (saved: AccountRow,account: CustomerAccount): CustomerAccountStatement => deps.db.transaction((): CustomerAccountStatement => {
    assertRow(saved,account);
    if (!account.job_ids.length) invalid('Link at least one released customer job before preparing an account statement.');
    const statements = account.job_ids.map(id => deps.signoffs.jobPaymentStatementSnapshot(id));
    const business_name = statements[0]!.business_name;
    if (statements.some(job => job.business_name !== business_name)) invalid('The selected jobs have different business names. Review the account job selection.');
    const invoices = statements.flatMap(job => job.invoices);
    if (invoices.length > 500) invalid('This account has over 500 invoices. Review its complete job statements separately.');
    if (new Set(invoices.map(invoice => invoice.invoice_id)).size !== invoices.length) return unavailable();
    const entries = invoices.reduce((n,i) => n+i.payments.length+(i.credits?.length ?? 0)+(i.credits?.filter(c=>c.reversal).length ?? 0)
      +(i.paid_credits?.length ?? 0)+(i.refunds?.length ?? 0)+(i.refunds?.filter(r=>r.reversal).length ?? 0),0);
    if (entries > 5000) invalid('This account has over 5,000 billing entries. Review its complete job statements separately.');
    const balances: CustomerAccountStatementBalance[] = [...new Set(statements.map(job => job.currency))].sort().map(currency => {
      const group = statements.filter(job => job.currency === currency);
      const sum = (field: 'invoiced_total' | 'amount_paid' | 'amount_credited' | 'amount_refund_credited' | 'amount_refunded' | 'outstanding' | 'refund_due') =>
        group.reduce((n,job) => n+units(job[field] ?? '0.0000'),0n);
      const paid = sum('amount_paid');const refunded = sum('amount_refunded');
      if (refunded > paid) return unavailable();
      return { currency,invoiced_total: decimal(sum('invoiced_total')),amount_paid: decimal(paid),amount_credited: decimal(sum('amount_credited')),
        amount_refund_credited: decimal(sum('amount_refund_credited')),amount_refunded: decimal(refunded),outstanding: decimal(sum('outstanding')),
        refund_due: decimal(sum('refund_due')),net_received: decimal(paid-refunded) };
    });
    return { format: 'recued.customer-account-statement',version: 1,captured_at: deps.now(),
      statement_hash: hash({ saved,selection: account.job_ids,jobs: statements.map(job => [job.job_id,job.statement_hash]) }),
      account_id: account.account_id,account_revision: account.revision,business_name,customer: account.customer,balances,jobs: statements };
  })();
  const statement = async (input: CustomerAccountInput) => { const { saved,account } = await load(input.account_id);return snapshot(saved,account); };
  const draftRow = (reference: string) => deps.db.prepare('SELECT * FROM customer_account_statement_drafts WHERE reference=?').get(reference) as DraftRow | undefined;
  const assertDraft = (expected: DraftRow) => { if (JSON.stringify(draftRow(expected.reference)) !== JSON.stringify(expected)) return stale(); };
  const assertNoUncertain = (id: string,except?: string) => {
    const rows = deps.db.prepare('SELECT reference FROM customer_account_statement_drafts WHERE account_id=?').all(id) as Array<{ reference: string }>;
    if (rows.some(item => { const claim = item.reference === except ? null : claims.get(item.reference);
      return claim && !['sent','confirmed','reconciled','not_sent','released'].includes(claim.status); })) {
      throw new QuoteSignoffError('customer_account_uncertain','Check the previous account statement email outcome in Mail before preparing another.');
    }
  };
  const savedContent = async (expected: DraftRow,saved: AccountRow,account: CustomerAccount,statement_hash: string): Promise<CustomerAccountStatementDraftResult> => {
    if (expected.account_id !== account.account_id || expected.statement_hash !== statement_hash) return stale();
    const settings = mailSettings(await deps.codec.open(expected.settings_ciphertext),expected.reference);
    if (snapshot(saved,account).statement_hash !== statement_hash) return stale();
    assertDraft(expected);assertNoUncertain(account.account_id);
    return { idempotency_key: expected.reference,content: settings.content };
  };
  return {
    async list(input: CustomerAccountsListInput = {}): Promise<CustomerAccountsListResult> {
      deps.codec.assertUnlocked();const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('Choose an account page size from 1 to 100.');
      const cursor = input.cursor === undefined ? '' : uuid(input.cursor);
      const rows = deps.db.prepare('SELECT * FROM customer_accounts WHERE account_id>? ORDER BY account_id LIMIT ?').all(cursor,limit+1) as AccountRow[];
      const page = rows.slice(0,limit);const opened = await Promise.all(page.map(open));
      for (const item of opened) assertRow(item.saved,item.account);
      return { accounts: opened.map(item => item.account),...(rows.length > limit ? { next_cursor: page.at(-1)!.account_id } : {}) };
    },
    async get(input: CustomerAccountInput) { return (await load(input.account_id)).account; },
    async save(input: CustomerAccountSaveInput): Promise<CustomerAccount> {
      deps.codec.assertUnlocked();const id = uuid(input.account_id);const customer = customerName(input.customer);const job_ids = jobs(input.job_ids);
      if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 || input.expected_revision >= Number.MAX_SAFE_INTEGER) invalid('Refresh the customer account before saving.');
      const previous = row(id);
      if ((previous?.revision ?? 0) !== input.expected_revision) return stale();
      const old = previous ? (await open(previous)).account : undefined;
      const settings: Selection = { customer,job_ids };const ciphertext = deps.codec.sealSync(settings);
      return deps.db.transaction(() => {
        deps.codec.assertUnlocked();
        if (previous) assertRow(previous,old);else if (row(id)) return stale();
        if (!previous && (deps.db.prepare('SELECT count(*) AS n FROM customer_accounts').get() as { n: number }).n >= 1000) invalid('There are already 1,000 customer accounts. Edit an existing account.');
        for (const job of job_ids) {
          const linked = deps.db.prepare('SELECT account_id FROM customer_account_jobs WHERE job_id=?').get(job) as { account_id: string } | undefined;
          if (linked && linked.account_id !== id) invalid('A selected job belongs to another account. Remove it there before linking it here.');
          if (!old?.job_ids.includes(job)) deps.signoffs.jobPaymentStatementSnapshot(job);
        }
        const at = deps.now();const revision = input.expected_revision+1;
        deps.db.prepare(`INSERT INTO customer_accounts (account_id,revision,settings_ciphertext,created_at,updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,settings_ciphertext=excluded.settings_ciphertext,updated_at=excluded.updated_at`)
          .run(id,revision,ciphertext,previous?.created_at ?? at,at);
        deps.db.prepare('DELETE FROM customer_account_jobs WHERE account_id=?').run(id);
        const link = deps.db.prepare('INSERT INTO customer_account_jobs (job_id,account_id) VALUES (?,?)');for (const job of job_ids) link.run(job,id);
        return { account_id: id,revision,customer,job_ids,created_at: previous?.created_at ?? at,updated_at: at };
      })();
    },
    statement,
    /** Recheck this decrypted account and its complete ledgers synchronously at the write boundary. */
    async captureForReminder(input: CustomerAccountInput) {
      const { saved,account } = await load(input.account_id);
      return { account,assertCurrent: () => assertRow(saved,account),read: () => snapshot(saved,account) };
    },
    async capture(input: CustomerAccountInput) {
      const { saved,account } = await load(input.account_id);
      return { statement: snapshot(saved,account),read: () => snapshot(saved,account) };
    },
    async draft(input: CustomerAccountStatementDraftInput): Promise<CustomerAccountStatementDraftResult> {
      const { saved,account } = await load(input.account_id);const copy = snapshot(saved,account);
      if (typeof input.expected_statement_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_statement_hash)
        || copy.statement_hash !== input.expected_statement_hash) return stale();
      if (typeof input.sender_mail_instance !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.sender_mail_instance)
        || typeof input.recipient_email !== 'string' || input.recipient_email.length > 254
        || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.recipient_email)) invalid('Choose a mail account and one customer email address.');
      const core = customerAccountStatementLines(copy).join('\n');
      const reference = CUSTOMER_ACCOUNT_STATEMENT_REFERENCE_PREFIX + hash([copy.statement_hash,input.sender_mail_instance,input.recipient_email]);
      const content = parseMailDraftContent({ sender_mail_instance: input.sender_mail_instance,to: [input.recipient_email],
        subject: `Customer account statement: ${copy.customer}`.slice(0,200),body_format: 'text',
        body: `Hello ${copy.customer},\n\nHere is your customer account statement.\n\n${core}\n\n`,reconciliation_id: reference });
      assertNoUncertain(account.account_id);const existing = draftRow(reference);
      if (existing) return savedContent(existing,saved,account,copy.statement_hash);
      const settings: MailSettings = { sender: input.sender_mail_instance,recipient: input.recipient_email,core,content };
      const ciphertext = deps.codec.sealSync(settings);
      if (snapshot(saved,account).statement_hash !== copy.statement_hash) return stale();assertNoUncertain(account.account_id);
      deps.db.prepare(`INSERT INTO customer_account_statement_drafts (reference,account_id,statement_hash,settings_ciphertext,created_at)
        VALUES (?,?,?,?,?) ON CONFLICT(reference) DO NOTHING`).run(reference,account.account_id,copy.statement_hash,ciphertext,deps.now());
      const stored = draftRow(reference);if (!stored) return stale();
      if (stored.settings_ciphertext !== ciphertext) return savedContent(stored,saved,account,copy.statement_hash);
      return { idempotency_key: reference,content };
    },
    async guardSend(input: { reconciliation_id?: unknown;instance?: unknown;to?: unknown;cc?: unknown;bcc?: unknown;
      body_text?: unknown;body_html?: unknown;attachments?: unknown }): Promise<(() => void) | undefined> {
      if (typeof input.reconciliation_id !== 'string' || !input.reconciliation_id.startsWith(CUSTOMER_ACCOUNT_STATEMENT_REFERENCE_PREFIX)) return;
      if (!/^qac_[a-f0-9]{64}$/.test(input.reconciliation_id)) return stale();
      const reserved = draftRow(input.reconciliation_id);if (!reserved) return stale();deps.codec.assertUnlocked();
      const settings = mailSettings(await deps.codec.open(reserved.settings_ciphertext),reserved.reference);
      const { saved,account } = await load(reserved.account_id);
      const empty = (value: unknown) => value === undefined || value === null || Array.isArray(value) && value.length === 0;
      if (input.instance !== settings.sender || !Array.isArray(input.to) || input.to.length !== 1 || input.to[0] !== settings.recipient
        || !empty(input.cc) || !empty(input.bcc) || !empty(input.attachments) || input.body_html !== undefined && input.body_html !== null
        || typeof input.body_text !== 'string' || !input.body_text.includes(settings.core)) {
        invalid('Keep the statement’s account, customer, selected jobs, invoices and balances. Refresh and prepare a new statement to change them.');
      }
      const assert = () => {
        if (snapshot(saved,account).statement_hash !== reserved.statement_hash) return stale();
        assertDraft(reserved);assertNoUncertain(account.account_id,reserved.reference);
      };
      assert();return assert;
    },
  };
};
export type CustomerAccountStatementService = ReturnType<typeof createCustomerAccountStatementService>;
