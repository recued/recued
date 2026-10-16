import { invalid,stale,uuid,text,money,day } from './customer-refund-input.js';
import { createHash,randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CustomerRefundPrepareInput,CustomerRefundAction,CustomerRefundApplyInput,CustomerRefundApplyResult,CustomerRefundPreview,
  CustomerRefundHistoryInput,CustomerRefundHistory,CustomerRefundCopyInput,CustomerRefundDocument,CustomerPaidCreditEntry,CustomerRefundEntry,CustomerRefundBalance,StepMeta } from '@recued/contracts';
import type { RecordsStore } from './records/store.js';
import type { QuoteSignoffService } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { emptyRefundBalance,refundUnits as units,refundDecimal as decimal,refundEntryFields } from './customer-refund-ledger.js';
import { createCustomerRefundReceiptMail } from './customer-refund-receipt-mail.js';
import { createCustomerRefundCorrections } from './customer-refund-correction-service.js';
import { customerRefundRecordIdentity,matchesCustomerRefundIdentity,issuedCustomerRefund,type IssuedCustomerRefund } from './customer-refund-identity.js';
const hash=(value: unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Plan { request: CustomerRefundPrepareInput;snapshot_hash: string;write_hash: string;payment_identity: string;action: CustomerRefundAction }
interface Row { action_id: string;request_key: string;signoff_id: string;kind: 'credit'|'refund';credit_id: string;payment_id: string;payment_identity: string;
  plan_hash: string;plan_ciphertext: string;created_at: number;applied_at: number|null;run_id: string|null;actor: string|null;applied_record_hash: string|null }
const summary=(a: CustomerRefundAction)=>[
  a.kind==='credit' ? `Issue paid invoice credit ${a.credit.credit_ref} on invoice ${a.invoice_ref}.` : `Record refund ${a.refund!.refund_ref} already completed outside Recued on invoice ${a.invoice_ref}.`,
  `Original payment ${a.payment.payment_id}: ${a.payment.amount} ${a.currency}, received ${a.payment.received_on}.`,
  `Original invoice total stays ${a.invoice_total} ${a.currency}. Recorded payments stay ${a.amount_paid} ${a.currency}.`,
  `Unpaid invoice credits stay ${a.amount_credited} ${a.currency}. Customer still owes: ${a.outstanding} ${a.currency}.`,
  `Paid invoice credit: ${a.credit.amount} ${a.currency} · ${a.credit.issued_on}. Reason: ${a.credit.reason}`,
  ...(a.refund ? [`Record returned: ${a.refund.amount} ${a.currency} · ${a.refund.returned_on}. Reason: ${a.refund.reason}`,
    ...(a.refund.method ? [`Method: ${a.refund.method}`] : []),...(a.refund.reference ? [`Refund reference: ${a.refund.reference}`] : [])] : []),
  `Paid invoice credits: ${a.before.amount_refund_credited} → ${a.after.amount_refund_credited} ${a.currency}.`,
  `Recorded refunds: ${a.before.amount_refunded} → ${a.after.amount_refunded} ${a.currency}.`,
  `Refund still owed: ${a.before.refund_due} → ${a.after.refund_due} ${a.currency}.`,
  `Recorded net received: ${a.before.net_received} → ${a.after.net_received} ${a.currency}.`,
  `Invoice after all credits: ${a.before.net_invoice_total} → ${a.after.net_invoice_total} ${a.currency}.`,
  'Keep the original invoice, payments, unpaid credits and agreed work. The customer’s outstanding debt stays unchanged.',
  'This saves a local record after owner review. It does not send money or contact a payment provider.',
].join('\n');
export const createCustomerRefundService=(deps: { db: Database.Database;records: RecordsStore;signoffs: QuoteSignoffService;codec: PreapprovalCodec;now: ()=>number })=>{
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_refund_actions (
    action_id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,signoff_id TEXT NOT NULL,kind TEXT NOT NULL,credit_id TEXT NOT NULL,payment_id TEXT NOT NULL,payment_identity TEXT NOT NULL,
    plan_hash TEXT NOT NULL,plan_ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL,applied_at INTEGER,run_id TEXT,actor TEXT,applied_record_hash TEXT
  );CREATE INDEX IF NOT EXISTS customer_refund_actions_history ON customer_refund_actions(signoff_id,created_at DESC,action_id);
  CREATE INDEX IF NOT EXISTS core_record_outbox_refund_identity_idx ON core_record_outbox(publisher,pack_slug,pk) WHERE kind='refund';CREATE INDEX IF NOT EXISTS core_record_outbox_paid_credit_identity_idx ON core_record_outbox(publisher,pack_slug,pk) WHERE kind='paid_credit';`);
  const rowFor=(id: string)=>deps.db.prepare('SELECT * FROM customer_refund_actions WHERE action_id=?').get(id) as Row|undefined;
  const identity=(entity: string,id: string)=>customerRefundRecordIdentity(deps,entity,id);
  const matches=(entity: string,id: string,expected: string|null)=>matchesCustomerRefundIdentity(deps,entity,id,expected);
  const corrections=createCustomerRefundCorrections(deps);
  const freshRow=(row: Row)=>{
    const fresh=rowFor(row.action_id);
    if (!fresh || ['request_key','signoff_id','kind','credit_id','payment_id','payment_identity','plan_hash','plan_ciphertext','created_at'].some(key=>fresh[key as keyof Row]!==row[key as keyof Row])) return stale();return fresh;
  };
  const open=async(row: Row): Promise<Plan>=>{
    deps.codec.assertUnlocked();const value=await deps.codec.open(row.plan_ciphertext);deps.codec.assertUnlocked();
    if (!value || typeof value!=='object' || Array.isArray(value)) return stale();const plan=value as Plan;
    if (hash(plan)!==row.plan_hash || plan.action?.action_id!==row.action_id || plan.action.signoff_id!==row.signoff_id || plan.action.kind!==row.kind
      || plan.action.credit.credit_id!==row.credit_id || plan.action.payment.payment_id!==row.payment_id || plan.payment_identity!==row.payment_identity
      || plan.action.prepared_at!==row.created_at || plan.request.signoff_id!==row.signoff_id || plan.request.payment_id!==row.payment_id || plan.request.kind!==row.kind) return stale();freshRow(row);return plan;
  };
  const entry=(row: Row,plan: Plan): CustomerRefundAction=>({ ...plan.action,applied_at: row.applied_at,...(row.run_id ? { run_id: row.run_id } : {}),...(row.actor ? { actor: row.actor } : {}) });
  const preview=(row: Row,plan: Plan): CustomerRefundPreview=>({ action: entry(row,plan),review: { action_id: row.action_id,expected_plan_hash: row.plan_hash,summary: summary(plan.action) } });
  const assertCredit=(credit: CustomerPaidCreditEntry,signoff_id: string)=>{
    const issued=rowFor(credit.credit_id);
    if (!issued || issued.kind!=='credit' || issued.signoff_id!==signoff_id || issued.applied_at===null || issued.credit_id!==credit.credit_id || issued.payment_id!==credit.payment_id
      || !issued.applied_record_hash || !matches('paid_credit',credit.credit_id,issued.applied_record_hash) || !matches('payment',credit.payment_id,issued.payment_identity)) return stale();
  };
  const requireCurrent=(plan: Plan)=>{
    deps.codec.assertUnlocked();const base=deps.signoffs.customerRefundSnapshot(plan.action.signoff_id);
    if (base.history.snapshot_hash!==plan.snapshot_hash || base.write_hash!==plan.write_hash || !matches('payment',plan.action.payment.payment_id,plan.payment_identity)) return stale();
    if (plan.action.kind==='refund') assertCredit(plan.action.credit,plan.action.signoff_id);return base;
  };
  const balance=(history: ReturnType<QuoteSignoffService['paymentHistorySnapshot']>): CustomerRefundBalance=>{
    if (history.invoice.availability!=='current') return stale();return history.invoice.amount_refund_credited===undefined
      ? emptyRefundBalance(history.invoice.amount_paid,history.total,history.invoice.amount_credited??'0.0000')
      : { amount_refund_credited: history.invoice.amount_refund_credited,amount_refunded: history.invoice.amount_refunded!,refund_due: history.invoice.refund_due!,net_received: history.invoice.net_received!,net_invoice_total: history.invoice.net_invoice_total! };
  };
  const documentHash=(row: IssuedCustomerRefund,snapshot: string)=>hash([snapshot,row.action_id,row.plan_hash,row.applied_record_hash,row.payment_identity]);
  const assertApplied=(row: IssuedCustomerRefund)=>{
    if (row.applied_at===null || !matches(row.kind==='credit' ? 'paid_credit' : 'refund',row.action_id,row.applied_record_hash) || !matches('payment',row.payment_id,row.payment_identity)) return stale();
  };
  const openCopy=async(signoff_id: string,action_id: string)=>{
    const row=rowFor(action_id);
    if (!row) return corrections.replacementForCopy(signoff_id,action_id);
    if (row.signoff_id!==signoff_id) return stale();const plan=await open(row);
    return { issued: row,credit: plan.action.credit,payment: plan.action.payment,refund: plan.action.refund,
      assertCurrent: ()=>{ const fresh=freshRow(row);assertApplied(fresh); } };
  };
  const copy=async(input: CustomerRefundCopyInput): Promise<CustomerRefundDocument>=>{
    const id=uuid(input.action_id);const signoff_id=uuid(input.signoff_id);const source=await openCopy(signoff_id,id);
    return deps.db.transaction((): CustomerRefundDocument=>{
      deps.codec.assertUnlocked();source.assertCurrent();const row=issuedCustomerRefund(deps,signoff_id,id);if (!row || row.plan_hash!==source.issued.plan_hash) return stale();assertApplied(row);
      const history=deps.signoffs.customerRefundSnapshot(row.signoff_id).history;
      if (history.invoice.availability!=='current') return stale();
      const credit=history.paid_credits?.find(c=>c.credit_id===row.credit_id);if (!credit || hash(credit)!==hash(source.credit)) return stale();assertCredit(credit,row.signoff_id);
      const refund=row.kind==='refund' ? history.refunds?.find(r=>r.refund_id===row.action_id) : null;
      if (row.kind==='refund' && (!refund || hash(refundEntryFields(refund))!==hash(source.refund ? refundEntryFields(source.refund) : null))) return stale();
      const payment=history.payments.find(p=>p.payment_id===row.payment_id);if (!payment || hash(payment)!==hash(source.payment)) return stale();
      return { format: 'recued.customer-refund-document',version: refund?.reversal || refund?.replaces_refund_id ? 2 : 1,kind: row.kind,action_id: row.action_id,captured_at: history.captured_at,document_hash: documentHash(row,history.snapshot_hash!),
        signoff_id: history.signoff_id,invoice_id: history.invoice_id,invoice_ref: history.invoice_ref,business_name: history.business_name,customer: history.customer,currency: history.currency,
        credit,refund: refund??null,payment,invoice_total: history.total,amount_paid: history.invoice.amount_paid,amount_credited: history.invoice.amount_credited??'0.0000',outstanding: history.invoice.outstanding,...balance(history) };
    })();
  };
  const assertDocumentCurrent=(doc: CustomerRefundDocument)=>{
    deps.codec.assertUnlocked();const row=issuedCustomerRefund(deps,doc.signoff_id,doc.action_id);if (!row) return stale();assertApplied(row);
    const history=deps.signoffs.customerRefundSnapshot(doc.signoff_id).history;assertCredit(doc.credit,doc.signoff_id);
    if (documentHash(row,history.snapshot_hash!)!==doc.document_hash) return stale();
  };
  const relatedActions=(signoff_id: string,action_id: string)=>{
    const history=deps.signoffs.customerRefundSnapshot(signoff_id).history;const byId=new Map((history.refunds??[]).map(r=>[r.refund_id,r]));
    let current=byId.get(action_id);const seen=new Set<string>();
    while (current?.replaces_refund_id) { if (seen.has(current.refund_id)) return stale();seen.add(current.refund_id);current=byId.get(current.replaces_refund_id); }
    const ids: string[]=[];seen.clear();while (current) { if (seen.has(current.refund_id)) return stale();seen.add(current.refund_id);ids.push(current.refund_id);current=current.reversal?.replacement_refund_id ? byId.get(current.reversal.replacement_refund_id) : undefined; }
    return ids.length ? ids : [action_id];
  };
  const mail=createCustomerRefundReceiptMail({ db: deps.db,codec: deps.codec,now: deps.now,copy,assertCurrent: assertDocumentCurrent,relatedActions });
  return {
    prepareCorrection: corrections.prepare,applyCorrection: corrections.apply,correctionHistory: corrections.history,
    copy,draft: mail.draft,guardSend: mail.guardSend,
    async prepare(input: CustomerRefundPrepareInput,prepared_by: string): Promise<CustomerRefundPreview> {
      deps.codec.assertUnlocked();uuid(input.request_key);uuid(input.signoff_id);
      if (typeof prepared_by!=='string' || !prepared_by || prepared_by.length>512 || !['credit','refund'].includes(input.kind)) invalid('Choose a paid invoice credit or a completed refund.');
      if (typeof input.expected_snapshot_hash!=='string' || !/^[a-f0-9]{64}$/.test(input.expected_snapshot_hash)) return stale();
      if (input.kind==='credit' && [input.credit_id,input.method,input.reference].some(v=>v!==undefined)) invalid('Paid invoice credits cannot include refund-only fields.');
      const payment_id=typeof input.payment_id==='string' && input.payment_id.length>0 && input.payment_id.length<=256 && !/[\u0000-\u001f]/.test(input.payment_id) ? input.payment_id : invalid('Choose a recorded payment.');
      const method=text(input.method,512,true);const reference=text(input.reference,512,true);if ([method,reference].some(v=>v && /[\u0000-\u001f]/.test(v))) invalid('Refund methods and references must stay on one line.');
      const request: CustomerRefundPrepareInput={ request_key: input.request_key,signoff_id: input.signoff_id,expected_snapshot_hash: input.expected_snapshot_hash,kind: input.kind,payment_id,amount: money(input.amount),date: day(input.date),reason: text(input.reason,1000)!,
        ...(input.kind==='refund' ? { credit_id: uuid(input.credit_id),...(method ? { method } : {}),...(reference ? { reference } : {}) } : {}) };
      const key=hash([prepared_by,request.kind,request.request_key]);
      const replay=deps.db.prepare('SELECT * FROM customer_refund_actions WHERE request_key=?').get(key) as Row|undefined;
      if (replay) { const plan=await open(replay);if (hash(plan.request)!==hash(request)) invalid('This preview key was used for different refund fields. Preview again.');const row=freshRow(replay);if (row.applied_at===null) requireCurrent(plan);return preview(row,plan); }
      const saved=deps.db.transaction(()=>{
        const base=deps.signoffs.customerRefundSnapshot(request.signoff_id);const history=base.history;if (history.snapshot_hash!==request.expected_snapshot_hash || history.invoice.availability!=='current') return stale();
        const payment=history.payments.find(p=>p.payment_id===request.payment_id);if (!payment) return stale();
        const action_id=randomUUID();const before=balance(history);let credit: CustomerPaidCreditEntry;let refund: CustomerRefundEntry|null=null;const amount=units(request.amount);
        if (request.kind==='credit') {
          if ((history.paid_credits?.length??0)>=1000) invalid('This invoice already has 1,000 paid invoice credits. Review Records.');
          const used=(history.paid_credits??[]).filter(c=>c.payment_id===payment.payment_id).reduce((n,c)=>n+units(c.amount),0n);
          if (used+amount>units(payment.amount)) invalid('Paid invoice credits cannot exceed the original payment.');
          credit={ credit_id: action_id,credit_ref: 'PCR-'+action_id,payment_id: payment.payment_id,amount: request.amount,issued_on: request.date,reason: request.reason };
        } else {
          if (reference && history.refunds?.some(r=>!r.reversal && r.payment_id===payment.payment_id && r.reference===reference)) invalid('This refund reference is already recorded against the payment.');
          if ((history.refunds?.length??0)>=1000) invalid('This invoice already has 1,000 refunds. Review Records.');
          const found=history.paid_credits?.find(c=>c.credit_id===request.credit_id && c.payment_id===payment.payment_id);if (!found) return stale();credit=found;assertCredit(credit,history.signoff_id);
          const used=(history.refunds??[]).filter(r=>!r.reversal && r.credit_id===credit.credit_id).reduce((n,r)=>n+units(r.amount),0n);
          if (used+amount>units(credit.amount)) invalid('The refund cannot exceed the amount still owed on this paid invoice credit.');
          refund={ refund_id: action_id,refund_ref: 'RF-'+action_id,credit_id: credit.credit_id,payment_id: payment.payment_id,amount: request.amount,returned_on: request.date,reason: request.reason,...(method ? { method } : {}),...(reference ? { reference } : {}) };
        }
        const after: CustomerRefundBalance=request.kind==='credit'
          ? { ...before,amount_refund_credited: decimal(units(before.amount_refund_credited)+amount),refund_due: decimal(units(before.refund_due)+amount),net_invoice_total: decimal(units(before.net_invoice_total)-amount) }
          : { ...before,amount_refunded: decimal(units(before.amount_refunded)+amount),refund_due: decimal(units(before.refund_due)-amount),net_received: decimal(units(before.net_received)-amount) };
        const action: CustomerRefundAction={ action_id,kind: request.kind,signoff_id: history.signoff_id,invoice_id: history.invoice_id,invoice_ref: history.invoice_ref,currency: history.currency,
          invoice_total: history.total,amount_paid: history.invoice.amount_paid,amount_credited: history.invoice.amount_credited??'0.0000',outstanding: history.invoice.outstanding,
          credit,refund,payment,before,after,prepared_at: deps.now(),prepared_by,applied_at: null };
        const plan: Plan={ request,snapshot_hash: history.snapshot_hash!,write_hash: base.write_hash,payment_identity: identity('payment',payment.payment_id),action };const plan_hash=hash(plan);const ciphertext=deps.codec.sealSync(plan);requireCurrent(plan);
        deps.db.prepare('INSERT INTO customer_refund_actions (action_id,request_key,signoff_id,kind,credit_id,payment_id,payment_identity,plan_hash,plan_ciphertext,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING').run(action_id,key,history.signoff_id,request.kind,credit.credit_id,payment.payment_id,plan.payment_identity,plan_hash,ciphertext,action.prepared_at);
        const row=deps.db.prepare('SELECT * FROM customer_refund_actions WHERE request_key=?').get(key) as Row|undefined;if (!row) return stale();return { row,plan: row.action_id===action_id ? plan : null };
      }).immediate();
      if (saved.plan) return preview(saved.row,saved.plan);const winner=await open(saved.row);if (hash(winner.request)!==hash(request)) invalid('This preview key was used for different refund fields.');const row=freshRow(saved.row);if (row.applied_at===null) requireCurrent(winner);return preview(row,winner);
    },
    async apply(input: CustomerRefundApplyInput,meta?: StepMeta): Promise<CustomerRefundApplyResult> {
      const row=rowFor(uuid(input.action_id));if (!row) return stale();const plan=await open(row);if (input.expected_plan_hash!==row.plan_hash || input.summary!==summary(plan.action)) return stale();
      return deps.db.transaction(()=>{
        deps.codec.assertUnlocked();const fresh=freshRow(row);const result=(already_applied: boolean): CustomerRefundApplyResult=>({ action_id: row.action_id,kind: row.kind,signoff_id: row.signoff_id,already_applied });if (fresh.applied_at!==null) return result(true);
        const base=requireCurrent(plan);const a=plan.action;const appliedAt=deps.now();const recorded_at=new Date(appliedAt).toISOString();
        const values=row.kind==='credit'
          ? { invoice_ref: 'invoice/'+a.invoice_id,payment_ref: 'payment/'+row.payment_id,credit_ref: a.credit.credit_ref,currency: a.currency,amount: a.credit.amount,issued_on: a.credit.issued_on,reason: a.credit.reason,recorded_at }
          : { invoice_ref: 'invoice/'+a.invoice_id,payment_ref: 'payment/'+row.payment_id,credit_ref: 'paid_credit/'+row.credit_id,refund_ref: a.refund!.refund_ref,currency: a.currency,amount: a.refund!.amount,returned_on: a.refund!.returned_on,reason: a.refund!.reason,...(a.refund!.method ? { method: a.refund!.method } : {}),...(a.refund!.reference ? { reference: a.refund!.reference } : {}),recorded_at };
        deps.records.execute({ binding: row.kind==='credit' ? base.credit_binding : base.refund_binding,principal: 'owner',args: { id: row.action_id,values } });
        deps.db.prepare('UPDATE customer_refund_actions SET applied_at=?,run_id=?,actor=?,applied_record_hash=? WHERE action_id=? AND applied_at IS NULL').run(appliedAt,meta?.run_id??null,meta?.actor??null,identity(row.kind==='credit' ? 'paid_credit' : 'refund',row.action_id),row.action_id);
        return result(false);
      }).immediate();
    },
    async history(input: CustomerRefundHistoryInput): Promise<CustomerRefundHistory> {
      deps.codec.assertUnlocked();const id=uuid(input.signoff_id);const limit=input.limit??50;if (!Number.isInteger(limit) || limit<1 || limit>100) invalid('Refund history limit must be 1–100.');let anchor: { at: number;id: string }|undefined;
      if (input.cursor!==undefined) {
        try {
          if (typeof input.cursor!=='string' || input.cursor.length>512 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) invalid('Start from the newest refund history.');const value=JSON.parse(Buffer.from(input.cursor,'base64url').toString());
          if (!value || Object.keys(value).sort().join(',')!=='at,id,signoff_id' || value.signoff_id!==id || !Number.isSafeInteger(value.at) || value.at<0) invalid('Start from the newest refund history.');anchor={ at: value.at,id: uuid(value.id) };
        } catch { invalid('Start from the newest refund history.'); }
      }
      const rows=deps.db.prepare(`SELECT * FROM customer_refund_actions WHERE signoff_id=? ${anchor ? 'AND (created_at<? OR (created_at=? AND action_id>?))' : ''} ORDER BY created_at DESC,action_id LIMIT ?`).all(id,...(anchor ? [anchor.at,anchor.at,anchor.id] : []),limit+1) as Row[];
      const opened: Array<{ row: Row;plan: Plan }>=[];for (const row of rows.slice(0,limit)) opened.push({ row,plan: await open(row) });
      const actions=opened.map(({row,plan})=>entry(freshRow(row),plan));const last=rows[Math.min(rows.length,limit)-1];return { actions,...(last && rows.length>limit ? { next_cursor: Buffer.from(JSON.stringify({ signoff_id: id,at: last.created_at,id: last.action_id })).toString('base64url') } : {}) };
    },
  };
};
export type CustomerRefundService=ReturnType<typeof createCustomerRefundService>;
