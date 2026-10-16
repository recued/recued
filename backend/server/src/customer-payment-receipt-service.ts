import { customerRefundBalanceFields } from '@recued/contracts';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseMailDraftContent,customerPaymentReceiptLines,CUSTOMER_PAYMENT_RECEIPT_REFERENCE_PREFIX,type MailDraftContent,
  type CustomerPaymentHistoryInput,type CustomerPaymentHistory,type CustomerPaymentReceiptInput,
  type CustomerPaymentReceipt,type CustomerPaymentReceiptDraftInput,type CustomerPaymentReceiptDraftResult } from '@recued/contracts';
import { QuoteSignoffError,type QuoteSignoffService } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { createMailSendClaimStore } from './storage/mail-send-claim-store.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string): never => { throw new QuoteSignoffError('customer_payment_invalid',message,400); };
const stale = (): never => { throw new QuoteSignoffError('customer_payment_stale','The payment or invoice changed. Refresh payment history and review a new receipt.'); };
const requestId = (id: unknown): string => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
  ? id : invalid('A customer sign-off reference is required.');
const paymentId = (id: unknown): string => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f]/.test(id)
  ? id : invalid('A recorded payment reference is required.');
const digest = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  ? value : invalid('Refresh payment history before reviewing this receipt.');

interface DraftRow { reference: string;signoff_id: string;payment_id: string;snapshot_hash: string;settings_ciphertext: string }
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

export const createCustomerPaymentReceiptService = (deps: {
  db: Database.Database;signoffs: QuoteSignoffService;codec: PreapprovalCodec;now: () => number;
}) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_payment_receipt_drafts (
    reference TEXT PRIMARY KEY,signoff_id TEXT NOT NULL,payment_id TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,settings_ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS customer_payment_receipt_drafts_payment ON customer_payment_receipt_drafts(signoff_id,payment_id);
  CREATE INDEX IF NOT EXISTS core_record_outbox_payment_identity_idx
    ON core_record_outbox(publisher,pack_slug,pk) WHERE kind='payment';`);
  const claims = createMailSendClaimStore(deps.db);
  const readRow = (reference: string) => deps.db.prepare('SELECT * FROM customer_payment_receipt_drafts WHERE reference=?').get(reference) as DraftRow | undefined;
  const assertRow = (row: DraftRow) => {
    const fresh = readRow(row.reference);
    if (!fresh || fresh.signoff_id !== row.signoff_id || fresh.payment_id !== row.payment_id
      || fresh.settings_ciphertext !== row.settings_ciphertext || fresh.snapshot_hash !== row.snapshot_hash) return stale();
  };
  const assertNoUncertain = (signoff_id: string,payment_id: string,except?: string) => {
    const prior = deps.db.prepare('SELECT reference FROM customer_payment_receipt_drafts WHERE signoff_id=? AND payment_id=?')
      .all(signoff_id,payment_id) as Array<{ reference: string }>;
    if (prior.some(row => { const claim = row.reference === except ? null : claims.get(row.reference);
      return claim && !['sent','confirmed','reconciled','not_sent','released'].includes(claim.status); })) {
      throw new QuoteSignoffError('customer_payment_uncertain','Check the previous receipt email outcome in Mail before preparing another.');
    }
  };
  const snapshot = (id: unknown) => { deps.codec.assertUnlocked();return deps.signoffs.paymentHistorySnapshot(requestId(id)); };
  const savedContent = async (row: DraftRow,history: CustomerPaymentHistory,payment_id: string) => {
    if (row.signoff_id !== history.signoff_id || row.payment_id !== payment_id || row.snapshot_hash !== history.snapshot_hash) return stale();
    const saved = readSettings(await deps.codec.open(row.settings_ciphertext),row.reference);
    if (snapshot(history.signoff_id).snapshot_hash !== history.snapshot_hash) return stale();
    assertRow(row);assertNoUncertain(row.signoff_id,row.payment_id);
    return { idempotency_key: row.reference,content: saved.content };
  };
  const copy = (history: CustomerPaymentHistory,payment_id: unknown): CustomerPaymentReceipt => {
    if (history.consistency !== 'matched' || history.invoice.availability !== 'current' || !history.snapshot_hash) {
      throw new QuoteSignoffError('customer_payment_unavailable',history.issue ?? 'The payment history cannot support a receipt. Review it in Records.');
    }
    const payment = history.payments.find(item => item.payment_id === paymentId(payment_id));
    if (!payment) throw new QuoteSignoffError('customer_payment_missing','This payment is no longer recorded against the selected invoice.',404);
    return { format: 'recued.customer-payment-receipt',version: history.paid_credits?.length ? 2 : 1,captured_at: history.captured_at,
      receipt_hash: hash([history.snapshot_hash,payment.payment_id]),signoff_id: history.signoff_id,
      invoice_id: history.invoice_id,invoice_ref: history.invoice_ref,business_name: history.business_name,
      customer: history.customer,quote_label: history.quote_label,
      ...(history.quote_reference ? { quote_reference: history.quote_reference } : {}),
      currency: history.currency,total: history.total,payment,...customerRefundBalanceFields(history.invoice),amount_paid: history.invoice.amount_paid,
      outstanding: history.invoice.outstanding,due_on: history.invoice.due_on,
      ...(history.invoice.amount_credited ? { amount_credited: history.invoice.amount_credited } : {}) };
  };
  return {
    history(input: CustomerPaymentHistoryInput): CustomerPaymentHistory {
      const history = snapshot(input.signoff_id);const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Payment history limit must be 1–100.');
      const cursorSnapshot = history.snapshot_hash ?? hash([history.signoff_id,history.invoice,history.consistency,history.payments]);
      let start = 0;
      if (input.cursor !== undefined) {
        if (typeof input.cursor !== 'string' || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)
          || Buffer.from(input.cursor,'base64url').toString('base64url') !== input.cursor) invalid('Start again from the newest payment history.');
        let value: unknown;try { value = JSON.parse(Buffer.from(input.cursor,'base64url').toString()); } catch { return invalid('Start again from the newest payment history.'); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'id,index,snapshot,v'
          || !('v' in value) || value.v !== 1 || !('id' in value) || value.id !== history.signoff_id
          || !('snapshot' in value) || value.snapshot !== cursorSnapshot || !('index' in value)
          || typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= history.payments.length) return stale();
        start = value.index;
      }
      return { ...history,payments: history.payments.slice(start,start + limit),
        ...(start + limit < history.payments.length ? { next_cursor: Buffer.from(JSON.stringify({
          v: 1,id: history.signoff_id,snapshot: cursorSnapshot,index: start + limit,
        })).toString('base64url') } : {}) };
    },
    receipt(input: CustomerPaymentReceiptInput): CustomerPaymentReceipt {
      const history = snapshot(input.signoff_id);
      if (history.snapshot_hash !== digest(input.expected_snapshot_hash)) return stale();
      return copy(history,input.payment_id);
    },
    async draft(input: CustomerPaymentReceiptDraftInput): Promise<CustomerPaymentReceiptDraftResult> {
      const history = snapshot(input.signoff_id);const receipt = copy(history,input.payment_id);
      if (receipt.receipt_hash !== digest(input.expected_receipt_hash)) return stale();
      if (typeof input.sender_mail_instance !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.sender_mail_instance)
        || typeof input.recipient_email !== 'string' || input.recipient_email.length > 254
        || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.recipient_email)) invalid('Choose a mail account and one customer email address.');
      const core = customerPaymentReceiptLines(receipt).join('\n');
      const reference = CUSTOMER_PAYMENT_RECEIPT_REFERENCE_PREFIX + hash([receipt.receipt_hash,input.sender_mail_instance,input.recipient_email]);
      const content = parseMailDraftContent({ sender_mail_instance: input.sender_mail_instance,to: [input.recipient_email],
        subject: `Payment receipt: ${receipt.invoice_ref}`.replace(/[\r\n]/g,' ').slice(0,200),
        body_format: 'text',body: `Hello ${receipt.customer},\n\nThank you for your payment.\n\n${core}\n\n`,reconciliation_id: reference });
      assertNoUncertain(history.signoff_id,receipt.payment.payment_id);
      const existing = readRow(reference);
      if (existing) return savedContent(existing,history,receipt.payment.payment_id);
      const settings: Settings = { sender: input.sender_mail_instance,recipient: input.recipient_email,core,content };
      const ciphertext = deps.codec.sealSync(settings);
      if (snapshot(history.signoff_id).snapshot_hash !== history.snapshot_hash) return stale();
      assertNoUncertain(history.signoff_id,receipt.payment.payment_id);
      deps.db.prepare(`INSERT INTO customer_payment_receipt_drafts
        (reference,signoff_id,payment_id,snapshot_hash,settings_ciphertext,created_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(reference) DO NOTHING`).run(reference,history.signoff_id,receipt.payment.payment_id,history.snapshot_hash,ciphertext,deps.now());
      const stored = readRow(reference);
      if (!stored) return stale();
      if (stored.settings_ciphertext !== ciphertext) return savedContent(stored,history,receipt.payment.payment_id);
      return { idempotency_key: reference,content };
    },
    async guardSend(input: { reconciliation_id?: unknown;instance?: unknown;to?: unknown;cc?: unknown;bcc?: unknown;
      body_text?: unknown;body_html?: unknown;attachments?: unknown }): Promise<(() => void) | undefined> {
      if (typeof input.reconciliation_id !== 'string' || !input.reconciliation_id.startsWith(CUSTOMER_PAYMENT_RECEIPT_REFERENCE_PREFIX)) return;
      if (!/^qpe_[a-f0-9]{64}$/.test(input.reconciliation_id)) return stale();
      const row = readRow(input.reconciliation_id);
      if (!row) return stale();deps.codec.assertUnlocked();
      const settings = readSettings(await deps.codec.open(row.settings_ciphertext),row.reference);
      if (input.instance !== settings.sender || !Array.isArray(input.to) || input.to.length !== 1 || input.to[0] !== settings.recipient
        || Array.isArray(input.cc) && input.cc.length > 0 || Array.isArray(input.bcc) && input.bcc.length > 0
        || input.body_html !== undefined && input.body_html !== null || Array.isArray(input.attachments) && input.attachments.length > 0
        || typeof input.body_text !== 'string' || !input.body_text.includes(settings.core)) invalid('Keep the receipt’s account, customer, recorded payment and balance. Refresh and prepare a new receipt to change them.');
      const assert = () => {
        deps.codec.assertUnlocked();const history = snapshot(row.signoff_id);
        if (history.snapshot_hash !== row.snapshot_hash) return stale();
        assertRow(row);assertNoUncertain(row.signoff_id,row.payment_id,row.reference);
      };
      assert();return assert;
    },
  };
};
export type CustomerPaymentReceiptService = ReturnType<typeof createCustomerPaymentReceiptService>;
