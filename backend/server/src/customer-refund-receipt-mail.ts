import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseMailDraftContent,customerRefundDocumentLines,isCustomerRefundReceiptReference,CUSTOMER_REFUND_RECEIPT_REFERENCE_PREFIX,
  type CustomerRefundCopyInput,type CustomerRefundDocument,type CustomerRefundDraftInput,type CustomerRefundDraftResult,type MailDraftContent } from '@recued/contracts';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { createMailSendClaimStore } from './storage/mail-send-claim-store.js';
interface Row { reference: string;signoff_id: string;action_id: string;document_hash: string;settings_ciphertext: string }
interface Settings { sender: string;recipient: string;core: string;content: MailDraftContent;document: CustomerRefundDocument }
const stale=(): never=>{ throw new QuoteSignoffError('customer_refund_stale','The refund or invoice changed. Refresh refund history and review a new receipt.'); };
const invalid=(message: string): never=>{ throw new QuoteSignoffError('customer_refund_invalid',message,400); };
export const createCustomerRefundReceiptMail=(deps: { db: Database.Database;codec: PreapprovalCodec;now: ()=>number;
  copy: (input: CustomerRefundCopyInput)=>Promise<CustomerRefundDocument>;assertCurrent: (document: CustomerRefundDocument)=>void;
  relatedActions: (signoff_id: string,action_id: string)=>string[] })=>{
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_refund_receipt_drafts (reference TEXT PRIMARY KEY,signoff_id TEXT NOT NULL,action_id TEXT NOT NULL,
    document_hash TEXT NOT NULL,settings_ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS customer_refund_receipt_drafts_action ON customer_refund_receipt_drafts(signoff_id,action_id);`);
  const claims=createMailSendClaimStore(deps.db);
  const rowFor=(reference: string)=>deps.db.prepare('SELECT * FROM customer_refund_receipt_drafts WHERE reference=?').get(reference) as Row|undefined;
  const assertRow=(row: Row)=>{ const fresh=rowFor(row.reference);if (!fresh || ['signoff_id','action_id','document_hash','settings_ciphertext'].some(key=>fresh[key as keyof Row]!==row[key as keyof Row])) return stale(); };
  const noUncertain=(row: Pick<Row,'signoff_id'|'action_id'>,except?: string)=>{
    const ids=deps.relatedActions(row.signoff_id,row.action_id);
    const prior=deps.db.prepare(`SELECT reference FROM customer_refund_receipt_drafts WHERE signoff_id=? AND action_id IN (${ids.map(()=>'?').join(',')})`).all(row.signoff_id,...ids) as Array<{ reference: string }>;
    if (prior.some(r=>{ const claim=r.reference===except ? null : claims.get(r.reference);return claim && !['sent','confirmed','reconciled','not_sent','released'].includes(claim.status); })) throw new QuoteSignoffError('customer_refund_uncertain','Check the previous refund receipt email outcome in Mail before preparing another.');
  };
  const settings=async(row: Row): Promise<Settings>=>{
    deps.codec.assertUnlocked();const value=await deps.codec.open(row.settings_ciphertext);deps.codec.assertUnlocked();
    if (!value || typeof value!=='object' || Array.isArray(value)) return stale();const s=value as Settings;const content=parseMailDraftContent(s.content);
    if (typeof s.sender!=='string' || typeof s.recipient!=='string' || typeof s.core!=='string' || !s.core
      || content.sender_mail_instance!==s.sender || content.to.length!==1 || content.to[0]!==s.recipient || content.body_format!=='text' || content.reconciliation_id!==row.reference || !content.body.includes(s.core)
      || s.document?.format!=='recued.customer-refund-document' || s.document.kind!=='refund' || s.document.document_hash!==row.document_hash || s.document.action_id!==row.action_id || s.document.signoff_id!==row.signoff_id) return stale();
    assertRow(row);deps.assertCurrent(s.document);return { ...s,content };
  };
  return {
    async draft(input: CustomerRefundDraftInput): Promise<CustomerRefundDraftResult> {
      const document=await deps.copy(input);if (document.kind!=='refund' || !document.refund) invalid('Issue the paid invoice credit, then record the completed refund before preparing its receipt.');
      if (input.expected_document_hash!==document.document_hash) return stale();
      if (typeof input.sender_mail_instance!=='string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.sender_mail_instance) || typeof input.recipient_email!=='string' || input.recipient_email.length>254 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.recipient_email)) invalid('Choose a mail account and one customer email address.');
      const core=customerRefundDocumentLines(document).join('\n');const reference=CUSTOMER_REFUND_RECEIPT_REFERENCE_PREFIX+createHash('sha256').update(JSON.stringify([document.document_hash,input.sender_mail_instance,input.recipient_email])).digest('hex');
      const target={ signoff_id: document.signoff_id,action_id: document.action_id };noUncertain(target);const existing=rowFor(reference);
      if (existing) { const saved=await settings(existing);noUncertain(existing);return { idempotency_key: reference,content: saved.content }; }
      const label=document.refund?.reversal ? 'Refund correction' : document.refund?.replaces_refund_id ? 'Corrected refund receipt' : 'Refund receipt';
      const content=parseMailDraftContent({ sender_mail_instance: input.sender_mail_instance,to: [input.recipient_email],subject: `${label}: ${document.invoice_ref}`.replace(/[\r\n]/g,' ').slice(0,200),body_format: 'text',body: `Hello ${document.customer},\n\n${core}\n\n`,reconciliation_id: reference });
      const saved: Settings={ sender: input.sender_mail_instance,recipient: input.recipient_email,core,content,document };const ciphertext=deps.codec.sealSync(saved);deps.assertCurrent(document);noUncertain(target);
      deps.db.prepare('INSERT INTO customer_refund_receipt_drafts (reference,signoff_id,action_id,document_hash,settings_ciphertext,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(reference) DO NOTHING').run(reference,document.signoff_id,document.action_id,document.document_hash,ciphertext,deps.now());
      const row=rowFor(reference);if (!row) return stale();if (row.settings_ciphertext!==ciphertext) { const winner=await settings(row);noUncertain(row);return { idempotency_key: reference,content: winner.content }; }
      return { idempotency_key: reference,content };
    },
    async guardSend(input: { reconciliation_id?: unknown;instance?: unknown;to?: unknown;cc?: unknown;bcc?: unknown;body_text?: unknown;body_html?: unknown;attachments?: unknown }): Promise<(()=>void)|undefined> {
      if (!isCustomerRefundReceiptReference(input.reconciliation_id)) return;if (!/^qrf_[a-f0-9]{64}$/.test(input.reconciliation_id)) return stale();const row=rowFor(input.reconciliation_id);if (!row) return stale();const s=await settings(row);
      if (input.instance!==s.sender || !Array.isArray(input.to) || input.to.length!==1 || input.to[0]!==s.recipient
        || Array.isArray(input.cc) && input.cc.length>0 || Array.isArray(input.bcc) && input.bcc.length>0 || input.body_html!=null
        || Array.isArray(input.attachments) && input.attachments.length>0 || typeof input.body_text!=='string' || !input.body_text.includes(s.core)) invalid('Keep the refund receipt’s account, customer, refund and balances. Refresh and review a new receipt to change them.');
      const assert=()=>{ deps.codec.assertUnlocked();assertRow(row);deps.assertCurrent(s.document);noUncertain(row,row.reference); };assert();return assert;
    },
  };
};
