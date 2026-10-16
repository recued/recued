import { createHash,randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CUSTOMER_ACCOUNT_PAYMENT_MAX_ALLOCATIONS,CUSTOMER_ACCOUNT_PAYMENT_REFERENCE_PREFIX,customerAccountPaymentReceiptLines,customerRefundBalanceFields,parseMailDraftContent,
  type CustomerAccountPaymentPrepareInput,type CustomerAccountPaymentPreview,type CustomerAccountPaymentRecord,type CustomerAccountPaymentAllocation,
  type CustomerAccountPaymentApplyInput,type CustomerAccountPaymentApplyResult,type CustomerAccountPaymentHistoryInput,type CustomerAccountPaymentHistory,
  type CustomerAccountPaymentReceiptInput,type CustomerAccountPaymentReceipt,type CustomerAccountPaymentReceiptAllocation,
  type CustomerAccountPaymentReceiptDraftInput,type CustomerAccountPaymentReceiptDraftResult,type MailDraftContent } from '@recued/contracts';
import type { StepMeta } from '@recued/contracts';
import { QuoteSignoffError,type QuoteSignoffService } from './quote-signoff-service.js';
import type { CustomerAccountStatementService } from './customer-account-statement-service.js';
import type { RecordsStore } from './records/store.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { createMailSendClaimStore } from './storage/mail-send-claim-store.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string): never => { throw new QuoteSignoffError('customer_account_payment_invalid',message,400); };
const stale = (): never => { throw new QuoteSignoffError('customer_account_payment_stale','The account, invoice balances or saved payment changed. Refresh and preview the payment again.'); };
const uuid = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
  ? value : invalid('Choose a saved customer account and payment.');
const digest = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : invalid('Refresh and review the current account balances.');
const units = (value: string) => BigInt(value.replace('.',''));
const decimal = (value: bigint) => `${value / 10_000n}.${String(value % 10_000n).padStart(4,'0')}`;
const money = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,4})?$/.test(value) || value.length > 24) return invalid('Enter a positive amount with up to four decimal places.');
  const [whole,fraction = ''] = value.split('.');const scaled = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4,'0'));
  if (scaled <= 0n || scaled > 9_223_372_036_854_775_807n) return invalid('The payment is outside Invoice Book’s exact money range.');
  return decimal(scaled);
};
const optional = (value: unknown,label: string): string | undefined => {
  if (value === undefined || value === '') return;
  if (typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return invalid(`${label} must fit 512 characters on one line.`);
  return value;
};
const date = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+'T00:00:00Z'))
    || new Date(value+'T00:00:00Z').toISOString().slice(0,10) !== value) return invalid('Choose a calendar payment date.');
  return value;
};
interface Row {
  account_payment_id: string;request_key: string;account_id: string;plan_hash: string;plan_ciphertext: string;
  created_at: number;applied_at: number | null;run_id: string | null;actor: string | null;
}
interface Plan {
  request: CustomerAccountPaymentPrepareInput;request_hash: string;payment: CustomerAccountPaymentRecord;
  writes: Array<{ signoff_id: string;snapshot_hash: string;write_hash: string;set: Record<string,string | number>;unset: string[] }>;
}
interface DraftRow { reference: string;account_payment_id: string;receipt_hash: string;settings_ciphertext: string }
interface MailSettings { sender: string;recipient: string;core: string;content: MailDraftContent }
const summary = (p: CustomerAccountPaymentRecord) => [
  `Record account payment ${p.account_payment_id} for ${p.customer} (${p.account_id}).`,
  `Amount received: ${p.amount} ${p.currency} on ${p.received_on}.`,
  `Method: ${p.method || '(none)'}. Reference: ${p.reference || '(none)'}.`,
  ...p.allocations.map(a => `Invoice ${a.invoice_ref} (${a.invoice_id}): allocate ${a.amount} ${p.currency}; recorded paid ${a.before_paid} → ${a.after_paid}; outstanding ${a.before_outstanding} → ${a.after_outstanding}.`),
  'Apply every payment entry and invoice balance together after owner review. This records money already received.',
].join('\n');

/** The encrypted preview owns one immutable allocation group. Existing invoice
 * ledgers remain the financial source of truth, including all later corrections. */
export const createCustomerAccountPaymentService = (deps: {
  db: Database.Database;records: RecordsStore;signoffs: QuoteSignoffService;accounts: CustomerAccountStatementService;
  codec: PreapprovalCodec;now: () => number;
}) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_account_payments (
    account_payment_id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,account_id TEXT NOT NULL,
    plan_hash TEXT NOT NULL,plan_ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL,applied_at INTEGER,run_id TEXT,actor TEXT
  ); CREATE INDEX IF NOT EXISTS customer_account_payments_history ON customer_account_payments(account_id,created_at DESC,account_payment_id);
  CREATE TABLE IF NOT EXISTS customer_account_payment_drafts (
    reference TEXT PRIMARY KEY,account_payment_id TEXT NOT NULL,receipt_hash TEXT NOT NULL,settings_ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS customer_account_payment_drafts_payment ON customer_account_payment_drafts(account_payment_id);`);
  const claims = createMailSendClaimStore(deps.db);
  const rowFor = (id: string) => deps.db.prepare('SELECT * FROM customer_account_payments WHERE account_payment_id=?').get(id) as Row | undefined;
  const rowForRequest = (key: string) => deps.db.prepare('SELECT * FROM customer_account_payments WHERE request_key=?').get(key) as Row | undefined;
  const assertRow = (row: Row) => {
    const fresh = rowFor(row.account_payment_id);
    if (!fresh || fresh.request_key !== row.request_key || fresh.account_id !== row.account_id || fresh.plan_hash !== row.plan_hash
      || fresh.plan_ciphertext !== row.plan_ciphertext || fresh.created_at !== row.created_at) return stale();
    return fresh;
  };
  const open = async (row: Row): Promise<Plan> => {
    deps.codec.assertUnlocked();const value = await deps.codec.open(row.plan_ciphertext);deps.codec.assertUnlocked();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return stale();
    const plan = value as Plan;
    if (hash(plan) !== row.plan_hash || plan.payment?.account_payment_id !== row.account_payment_id || plan.payment.account_id !== row.account_id
      || plan.payment.prepared_at !== row.created_at || hash(plan.request) !== plan.request_hash) return stale();
    assertRow(row);return plan;
  };
  const entry = (row: Row,plan: Plan): CustomerAccountPaymentRecord => ({ ...plan.payment,applied_at: row.applied_at,
    ...(row.run_id ? { run_id: row.run_id } : {}),...(row.actor ? { actor: row.actor } : {}) });
  const preview = (row: Row,plan: Plan): CustomerAccountPaymentPreview => ({ payment: entry(row,plan),
    review: { account_payment_id: row.account_payment_id,expected_plan_hash: row.plan_hash,summary: summary(plan.payment) } });
  const current = (plan: Plan,read: Awaited<ReturnType<CustomerAccountStatementService['capture']>>['read']) => {
    deps.codec.assertUnlocked();if (read().statement_hash !== plan.request.expected_statement_hash) return stale();
    return plan.writes.map(write => {
      const base = deps.signoffs.paymentPostingSnapshot(write.signoff_id);
      if (base.history.snapshot_hash !== write.snapshot_hash || base.write_hash !== write.write_hash) return stale();return base;
    });
  };
  const readPreview = async (row: Row,request: CustomerAccountPaymentPrepareInput,
    captured?: Awaited<ReturnType<CustomerAccountStatementService['capture']>>): Promise<CustomerAccountPaymentPreview> => {
    const plan = await open(row);
    if (plan.request_hash !== hash(request)) invalid('This preview request was already used for different payment fields. Preview again.');
    if (assertRow(row).applied_at !== null) return preview(assertRow(row),plan);
    let capture = captured;
    try { capture ??= await deps.accounts.capture({ account_id: row.account_id }); }
    catch (error) {
      deps.codec.assertUnlocked();const fresh = assertRow(row);
      if (fresh.applied_at !== null) return preview(fresh,plan);
      throw error;
    }
    deps.codec.assertUnlocked();const fresh = assertRow(row);
    if (fresh.applied_at === null) current(plan,capture.read);
    return preview(fresh,plan);
  };
  const receiptSnapshot = (row: Row,plan: Plan): CustomerAccountPaymentReceipt => deps.db.transaction((): CustomerAccountPaymentReceipt => {
    deps.codec.assertUnlocked();const saved = assertRow(row);if (saved.applied_at === null) return invalid('Approve this account payment before preparing a receipt.');
    const roots = [...new Set(plan.payment.allocations.map(a => a.job_id))];
    const jobs = roots.map(id => deps.signoffs.jobPaymentStatementSnapshot(id));
    const allocations: CustomerAccountPaymentReceiptAllocation[] = plan.payment.allocations.map(a => {
      const job = jobs.find(j => j.job_id === a.job_id)!;const invoice = job.invoices.find(i => i.signoff_id === a.signoff_id);
      if (!invoice || invoice.invoice_id !== a.invoice_id || invoice.invoice_ref !== a.invoice_ref || job.currency !== plan.payment.currency
        || job.business_name !== plan.payment.business_name) return stale();
      const payment = invoice.payments.find(p => p.payment_id === a.payment_id) ?? null;
      if (!payment && deps.records.ownerGet({ publisher: 'recued-core',pack_slug: 'invoice-book' },'payment',a.payment_id)) return stale();
      const same = payment && payment.amount === a.amount && payment.received_on === plan.payment.received_on
        && (payment.method ?? '') === (plan.payment.method ?? '') && (payment.reference ?? '') === (plan.payment.reference ?? '');
      return { ...a,state: !payment ? 'removed' : same ? 'unchanged' : 'changed',current_payment: payment,
        current_paid: invoice.amount_paid,current_outstanding: invoice.outstanding,
        ...(invoice.amount_credited ? { amount_credited: invoice.amount_credited } : {}),...customerRefundBalanceFields(invoice) };
    });
    return { format: 'recued.customer-account-payment-receipt',version: 1,captured_at: deps.now(),
      statement_hash: hash({ saved,jobs: jobs.map(j => [j.job_id,j.statement_hash]) }),payment: entry(saved,plan),allocations,
      current_allocated: decimal(allocations.reduce((n,a) => n+(a.current_payment ? units(a.current_payment.amount) : 0n),0n)) };
  })();
  const loadReceipt = async (id: unknown) => {
    const row = rowFor(uuid(id));if (!row) return stale();const plan = await open(row);return { row,plan,copy: receiptSnapshot(row,plan) };
  };
  const draftRow = (reference: string) => deps.db.prepare('SELECT * FROM customer_account_payment_drafts WHERE reference=?').get(reference) as DraftRow | undefined;
  const assertDraft = (row: DraftRow) => { if (JSON.stringify(draftRow(row.reference)) !== JSON.stringify(row)) return stale(); };
  const assertNoUncertain = (id: string,except?: string) => {
    const rows = deps.db.prepare('SELECT reference FROM customer_account_payment_drafts WHERE account_payment_id=?').all(id) as Array<{ reference: string }>;
    if (rows.some(row => { const claim = row.reference === except ? null : claims.get(row.reference);
      return claim && !['sent','confirmed','reconciled','not_sent','released'].includes(claim.status); })) {
      throw new QuoteSignoffError('customer_account_payment_uncertain','Check the previous account payment receipt email outcome in Mail before preparing another.');
    }
  };
  const mailSettings = async (row: DraftRow): Promise<MailSettings> => {
    deps.codec.assertUnlocked();const value = await deps.codec.open(row.settings_ciphertext);deps.codec.assertUnlocked();assertDraft(row);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('sender' in value) || typeof value.sender !== 'string'
      || !('recipient' in value) || typeof value.recipient !== 'string' || !('core' in value) || typeof value.core !== 'string' || !value.core || !('content' in value)) return stale();
    const content = parseMailDraftContent(value.content);
    if (content.sender_mail_instance !== value.sender || content.to.length !== 1 || content.to[0] !== value.recipient
      || content.reconciliation_id !== row.reference || content.body_format !== 'text' || !content.body.includes(value.core)) return stale();
    return { sender: value.sender,recipient: value.recipient,core: value.core,content };
  };
  return {
    async prepare(input: CustomerAccountPaymentPrepareInput,prepared_by: string): Promise<CustomerAccountPaymentPreview> {
      deps.codec.assertUnlocked();uuid(input.request_key);uuid(input.account_id);digest(input.expected_statement_hash);
      if (typeof prepared_by !== 'string' || !prepared_by || prepared_by.length > 512) invalid('A paired owner client is required.');
      if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) invalid('Choose one invoice currency.');
      if (!Array.isArray(input.allocations) || !input.allocations.length || input.allocations.length > CUSTOMER_ACCOUNT_PAYMENT_MAX_ALLOCATIONS) invalid('Allocate this payment to 1–100 invoices.');
      const allocations = input.allocations.map(a => {
        if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['signoff_id','amount'].includes(k))) return invalid('Choose invoice identities and allocation amounts only.');
        return { signoff_id: uuid(a.signoff_id),amount: money(a.amount) };
      }).sort((a,b) => a.signoff_id.localeCompare(b.signoff_id));
      if (new Set(allocations.map(a => a.signoff_id)).size !== allocations.length) invalid('Choose each invoice only once.');
      const amount = money(input.amount);if (allocations.reduce((n,a) => n+units(a.amount),0n) !== units(amount)) invalid('The allocation amounts must add up exactly to the payment received.');
      const method = optional(input.method,'Payment method');const reference = optional(input.reference,'Payment reference');
      const request: CustomerAccountPaymentPrepareInput = { request_key: input.request_key,account_id: input.account_id,
        expected_statement_hash: input.expected_statement_hash,currency: input.currency,amount,received_on: date(input.received_on),
        ...(method ? { method } : {}),...(reference ? { reference } : {}),allocations };
      const request_key = hash([prepared_by,input.request_key]);
      const replay = rowForRequest(request_key);if (replay) return readPreview(replay,request);
      let capture: Awaited<ReturnType<CustomerAccountStatementService['capture']>>;
      try { capture = await deps.accounts.capture({ account_id: input.account_id }); }
      catch (error) {
        deps.codec.assertUnlocked();const winner = rowForRequest(request_key);
        if (winner) return readPreview(winner,request);
        throw error;
      }
      const winner = rowForRequest(request_key);if (winner) return readPreview(winner,request,capture);
      const created = deps.db.transaction(() => {
        const copy = capture.read();if (copy.statement_hash !== request.expected_statement_hash) return stale();
        const bases = allocations.map(a => {
          const job = copy.jobs.find(j => j.invoices.some(i => i.signoff_id === a.signoff_id));
          if (!job || job.currency !== request.currency) return invalid('Every invoice must belong to this saved account and use the selected currency.');
          const base = deps.signoffs.paymentPostingSnapshot(a.signoff_id);
          if (base.history.invoice.availability !== 'current' || units(a.amount) > units(base.history.invoice.outstanding)) return invalid('An allocation exceeds its invoice’s outstanding balance.');
          return { base,job_id: job.job_id,amount: a.amount };
        });
        const account_payment_id = randomUUID();const at = deps.now();
        const entries: CustomerAccountPaymentAllocation[] = bases.map(({ base,job_id,amount }) => ({ job_id,
          signoff_id: base.history.signoff_id,invoice_id: base.history.invoice_id,invoice_ref: base.history.invoice_ref,payment_id: randomUUID(),amount,
          before_paid: String(base.invoice.amount_paid),after_paid: decimal(units(String(base.invoice.amount_paid))+units(amount)),
          before_outstanding: String(base.invoice.outstanding),after_outstanding: decimal(units(String(base.invoice.outstanding))-units(amount)) }));
        const payment: CustomerAccountPaymentRecord = { account_payment_id,account_id: copy.account_id,customer: copy.customer,business_name: copy.business_name,
          currency: request.currency,amount,received_on: request.received_on,...(method ? { method } : {}),...(reference ? { reference } : {}),
          allocations: entries,prepared_at: at,prepared_by,applied_at: null };
        if (summary(payment).length > 60_000) invalid('This payment preview is too large. Allocate fewer invoices in one payment.');
        const writes: Plan['writes'] = bases.map(({ base },index) => {
          const a = entries[index]!;const credited = units(String(base.invoice.amount_credited ?? '0.0000'));
          const status = units(a.after_outstanding) === 0n ? credited > 0n ? 'credited' : 'settled' : 'open';
          const set: Record<string,string | number> = { amount_paid: a.after_paid,outstanding: a.after_outstanding,status };
          if (status === 'settled') {
            const settled = [...base.history.payments.map(p => p.received_on),request.received_on].sort().at(-1)!;
            const days = Math.round((Date.parse(settled+'T00:00:00Z')-Date.parse(String(base.invoice.due_on)+'T00:00:00Z'))/86_400_000);
            set.settled_on = settled;set.days_late = days;set.paid_on_time = days <= 0 ? 1 : 0;
          }
          return { signoff_id: a.signoff_id,snapshot_hash: base.history.snapshot_hash!,write_hash: base.write_hash,set,
            unset: status === 'settled' ? [] : ['settled_on','days_late','paid_on_time'] };
        });
        const plan: Plan = { request,request_hash: hash(request),payment,writes };const plan_hash = hash(plan);const ciphertext = deps.codec.sealSync(plan);current(plan,capture.read);
        deps.db.prepare(`INSERT INTO customer_account_payments (account_payment_id,request_key,account_id,plan_hash,plan_ciphertext,created_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING`).run(account_payment_id,request_key,copy.account_id,plan_hash,ciphertext,at);
        const stored = deps.db.prepare('SELECT * FROM customer_account_payments WHERE request_key=?').get(request_key) as Row | undefined;
        if (!stored) return stale();return { row: stored,plan: stored.account_payment_id === account_payment_id ? plan : null };
      }).immediate();
      if (!created.plan) return readPreview(created.row,request,capture);
      const fresh = assertRow(created.row);if (fresh.applied_at === null) current(created.plan,capture.read);return preview(fresh,created.plan);
    },
    async apply(input: CustomerAccountPaymentApplyInput,meta?: StepMeta): Promise<CustomerAccountPaymentApplyResult> {
      const row = rowFor(uuid(input.account_payment_id));if (!row) return stale();const plan = await open(row);
      if (input.expected_plan_hash !== row.plan_hash || input.summary !== summary(plan.payment)) return stale();
      const result = (already_applied: boolean) => ({ account_payment_id: row.account_payment_id,account_id: row.account_id,already_applied });
      if (assertRow(row).applied_at !== null) return result(true);
      const capture = await deps.accounts.capture({ account_id: row.account_id });
      return deps.db.transaction(() => {
        deps.codec.assertUnlocked();if (assertRow(row).applied_at !== null) return result(true);
        const bases = current(plan,capture.read);
        for (let i = 0;i < bases.length;i++) {
          const base = bases[i]!;const allocation = plan.payment.allocations[i]!;const write = plan.writes[i]!;
          // Tombstones and moved entries must never be revived by a retry.
          if (deps.records.ownerGet({ publisher: 'recued-core',pack_slug: 'invoice-book' },'payment',allocation.payment_id)
            || (deps.db.prepare("SELECT count(*) AS n FROM core_record_outbox WHERE publisher='recued-core' AND pack_slug='invoice-book' AND kind='payment' AND pk=?").get(allocation.payment_id) as { n: number }).n) return stale();
          deps.records.execute({ binding: base.payment_binding,args: { id: allocation.payment_id,values: {
            invoice_ref: `invoice/${allocation.invoice_id}`,amount: allocation.amount,received_on: plan.payment.received_on,
            ...(plan.payment.method ? { method: plan.payment.method } : {}),...(plan.payment.reference ? { reference: plan.payment.reference } : {}),
            recorded_at: new Date(deps.now()).toISOString(),
          } },principal: 'owner' });
          deps.records.execute({ binding: base.invoice_binding,args: { id: base.invoice.id,expected_version: base.invoice._record.version,
            expected_revision: base.invoice._record.revision,set: write.set,unset: write.unset },principal: 'owner' });
        }
        // Fail the complete transaction if the resulting account is no longer exportable.
        capture.read();
        deps.db.prepare('UPDATE customer_account_payments SET applied_at=?,run_id=?,actor=? WHERE account_payment_id=? AND applied_at IS NULL')
          .run(deps.now(),meta?.run_id ?? null,meta?.actor ?? null,row.account_payment_id);return result(false);
      }).immediate();
    },
    async history(input: CustomerAccountPaymentHistoryInput): Promise<CustomerAccountPaymentHistory> {
      deps.codec.assertUnlocked();const id = uuid(input.account_id);await deps.accounts.get({ account_id: id });
      const limit = input.limit ?? 25;if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('Choose a payment page size from 1 to 100.');
      let anchor: { at: number;id: string } | undefined;
      if (input.cursor !== undefined) {
        try {
          if (typeof input.cursor !== 'string' || input.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) invalid('Start from the newest account payments.');
          const value = JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
          if (!value || Object.keys(value).sort().join(',') !== 'account_id,at,id' || value.account_id !== id || !Number.isSafeInteger(value.at) || value.at < 0) invalid('Start from the newest account payments.');
          anchor = { at: value.at,id: uuid(value.id) };
        } catch { invalid('Start from the newest account payments.'); }
      }
      const rows = deps.db.prepare(`SELECT * FROM customer_account_payments WHERE account_id=?
        ${anchor ? 'AND (created_at<? OR (created_at=? AND account_payment_id>?))' : ''} ORDER BY created_at DESC,account_payment_id LIMIT ?`)
        .all(id,...(anchor ? [anchor.at,anchor.at,anchor.id] : []),limit+1) as Row[];
      const page = rows.slice(0,limit);const plans = await Promise.all(page.map(open));
      const payments = page.map((row,i) => entry(assertRow(row),plans[i]!));const last = page.at(-1);
      return { payments,...(rows.length > limit && last ? { next_cursor: Buffer.from(JSON.stringify({ account_id: id,at: last.created_at,id: last.account_payment_id })).toString('base64url') } : {}) };
    },
    /** Internal read closure rechecks the original payment group and its complete current ledgers synchronously. */
    async captureCorrection(input: CustomerAccountPaymentReceiptInput) {
      const { row,plan } = await loadReceipt(input.account_payment_id);
      return { read: () => receiptSnapshot(row,plan) };
    },
    async receipt(input: CustomerAccountPaymentReceiptInput) { return (await loadReceipt(input.account_payment_id)).copy; },
    async draft(input: CustomerAccountPaymentReceiptDraftInput): Promise<CustomerAccountPaymentReceiptDraftResult> {
      const { row,plan,copy } = await loadReceipt(input.account_payment_id);if (digest(input.expected_receipt_hash) !== copy.statement_hash) return stale();
      if (typeof input.sender_mail_instance !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.sender_mail_instance)
        || typeof input.recipient_email !== 'string' || input.recipient_email.length > 254 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.recipient_email)) invalid('Choose a mail account and one customer email address.');
      const core = customerAccountPaymentReceiptLines(copy).join('\n');const reference = CUSTOMER_ACCOUNT_PAYMENT_REFERENCE_PREFIX+hash([copy.statement_hash,input.sender_mail_instance,input.recipient_email]);
      const content = parseMailDraftContent({ sender_mail_instance: input.sender_mail_instance,to: [input.recipient_email],
        subject: `Customer account payment receipt: ${copy.payment.customer}`.slice(0,200),body_format: 'text',body: core,reconciliation_id: reference });
      assertNoUncertain(row.account_payment_id);const existing = draftRow(reference);
      if (existing) {
        const settings = await mailSettings(existing);if (receiptSnapshot(row,plan).statement_hash !== copy.statement_hash) return stale();
        assertNoUncertain(row.account_payment_id);return { idempotency_key: reference,content: settings.content };
      }
      const settings: MailSettings = { sender: input.sender_mail_instance,recipient: input.recipient_email,core,content };
      const ciphertext = deps.codec.sealSync(settings);if (receiptSnapshot(row,plan).statement_hash !== copy.statement_hash) return stale();assertNoUncertain(row.account_payment_id);
      deps.db.prepare(`INSERT INTO customer_account_payment_drafts (reference,account_payment_id,receipt_hash,settings_ciphertext,created_at) VALUES (?,?,?,?,?)
        ON CONFLICT(reference) DO NOTHING`).run(reference,row.account_payment_id,copy.statement_hash,ciphertext,deps.now());
      const stored = draftRow(reference);if (!stored) return stale();
      if (stored.settings_ciphertext !== ciphertext) {
        const winner = await mailSettings(stored);if (receiptSnapshot(row,plan).statement_hash !== copy.statement_hash) return stale();assertNoUncertain(row.account_payment_id);
        return { idempotency_key: reference,content: winner.content };
      }
      return { idempotency_key: reference,content };
    },
    async guardSend(input: { reconciliation_id?: unknown;instance?: unknown;to?: unknown;cc?: unknown;bcc?: unknown;body_text?: unknown;body_html?: unknown;attachments?: unknown }): Promise<(() => void) | undefined> {
      if (typeof input.reconciliation_id !== 'string' || !input.reconciliation_id.startsWith(CUSTOMER_ACCOUNT_PAYMENT_REFERENCE_PREFIX)) return;
      if (!/^qap_[a-f0-9]{64}$/.test(input.reconciliation_id)) return stale();const reserved = draftRow(input.reconciliation_id);if (!reserved) return stale();
      const settings = await mailSettings(reserved);const { row,plan } = await loadReceipt(reserved.account_payment_id);
      const empty = (value: unknown) => value === undefined || value === null || Array.isArray(value) && value.length === 0;
      if (input.instance !== settings.sender || !Array.isArray(input.to) || input.to.length !== 1 || input.to[0] !== settings.recipient
        || !empty(input.cc) || !empty(input.bcc) || !empty(input.attachments) || input.body_html !== undefined && input.body_html !== null
        || typeof input.body_text !== 'string' || !input.body_text.includes(settings.core)) invalid('Keep the complete account payment receipt, invoice allocations and customer address. Prepare a new receipt to change them.');
      const assert = () => { if (receiptSnapshot(row,plan).statement_hash !== reserved.receipt_hash) return stale();assertDraft(reserved);assertNoUncertain(row.account_payment_id,reserved.reference); };
      assert();return assert;
    },
  };
};
export type CustomerAccountPaymentService = ReturnType<typeof createCustomerAccountPaymentService>;
