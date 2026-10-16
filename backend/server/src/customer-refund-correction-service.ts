import { createHash,randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CustomerRefundCorrectionPrepareInput,CustomerRefundCorrectionRecord,CustomerRefundCorrectionPreview,CustomerRefundCorrectionApplyInput,
  CustomerRefundCorrectionApplyResult,CustomerRefundCorrectionHistoryInput,CustomerRefundCorrectionHistory,CustomerRefundBalance,StepMeta } from '@recued/contracts';
import type { RecordsStore } from './records/store.js';
import type { QuoteSignoffService } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { invalid,stale,uuid,text,money,day } from './customer-refund-input.js';
import { refundUnits as units,refundDecimal as decimal,refundEntryFields } from './customer-refund-ledger.js';
import { customerRefundRecordIdentity,matchesCustomerRefundIdentity,issuedCustomerRefund,type IssuedCustomerRefund } from './customer-refund-identity.js';

interface Plan {
  request: CustomerRefundCorrectionPrepareInput;correction: CustomerRefundCorrectionRecord;
  snapshot_hash: string;write_hash: string;source_plan_hash: string;original_record_hash: string;payment_identity: string;
}
interface Row {
  correction_id: string;request_key: string;signoff_id: string;refund_id: string;credit_id: string;payment_id: string;replacement_id: string | null;
  payment_identity: string;original_record_hash: string;plan_hash: string;plan_ciphertext: string;created_at: number;
  applied_at: number | null;run_id: string | null;actor: string | null;reversal_record_hash: string | null;replacement_record_hash: string | null;
}
const hash=(value: unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const summary=(c: CustomerRefundCorrectionRecord)=>[
  `Reverse refund record ${c.before.refund_ref} on invoice ${c.invoice_ref}.`,
  `Original recorded refund: ${c.before.amount} ${c.currency} · ${c.before.returned_on}. Reason: ${c.before.reason}`,
  ...(c.before.method ? [`Original method: ${c.before.method}`] : []),...(c.before.reference ? [`Original reference: ${c.before.reference}`] : []),
  `Correction date: ${c.reversed_on}. Reason: ${c.reason}`,
  ...(c.replacement ? [`Replacement refund ${c.replacement.refund_ref}: ${c.replacement.amount} ${c.currency} · ${c.replacement.returned_on}. Reason: ${c.replacement.reason}`,
    ...(c.replacement.method ? [`Replacement method: ${c.replacement.method}`] : []),...(c.replacement.reference ? [`Replacement reference: ${c.replacement.reference}`] : [])] : ['No replacement refund record.']),
  `Paid invoice credit ${c.credit.credit_ref} stays ${c.credit.amount} ${c.currency}.`,
  `Original invoice total stays ${c.invoice_total} ${c.currency}. Original recorded payments stay ${c.amount_paid} ${c.currency}.`,
  `Unpaid credits stay ${c.amount_credited} ${c.currency}. Customer still owes: ${c.outstanding} ${c.currency}.`,
  `Recorded refunds: ${c.before_balance.amount_refunded} → ${c.after_balance.amount_refunded} ${c.currency}.`,
  `Refund still owed: ${c.before_balance.refund_due} → ${c.after_balance.refund_due} ${c.currency}.`,
  `Recorded net received: ${c.before_balance.net_received} → ${c.after_balance.net_received} ${c.currency}.`,
  'Keep the original refund, payment, invoice, credits and agreed work. Save a linked correction after fresh owner review.',
  'This corrects local records. It does not send or recover money, or contact a payment provider.',
].join('\n');

export const createCustomerRefundCorrections=(deps: {
  db: Database.Database;records: RecordsStore;signoffs: QuoteSignoffService;codec: PreapprovalCodec;now: ()=>number;
})=>{
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_refund_corrections (
    correction_id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,signoff_id TEXT NOT NULL,refund_id TEXT NOT NULL,credit_id TEXT NOT NULL,payment_id TEXT NOT NULL,
    replacement_id TEXT UNIQUE,payment_identity TEXT NOT NULL,original_record_hash TEXT NOT NULL,plan_hash TEXT NOT NULL,plan_ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL,
    applied_at INTEGER,run_id TEXT,actor TEXT,reversal_record_hash TEXT,replacement_record_hash TEXT
  );CREATE INDEX IF NOT EXISTS customer_refund_corrections_history ON customer_refund_corrections(signoff_id,created_at DESC,correction_id);
  CREATE UNIQUE INDEX IF NOT EXISTS customer_refund_corrections_applied ON customer_refund_corrections(refund_id) WHERE applied_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS core_record_outbox_refund_reversal_identity_idx ON core_record_outbox(publisher,pack_slug,pk) WHERE kind='refund_reversal';`);
  const identity=(entity: string,id: string)=>customerRefundRecordIdentity(deps,entity,id);
  const matches=(entity: string,id: string,expected: string | null)=>matchesCustomerRefundIdentity(deps,entity,id,expected);
  const rowFor=(id: string)=>deps.db.prepare('SELECT * FROM customer_refund_corrections WHERE correction_id=?').get(id) as Row | undefined;
  const freshRow=(row: Row)=>{
    const fresh=rowFor(row.correction_id);
    if (!fresh || ['request_key','signoff_id','refund_id','credit_id','payment_id','replacement_id','payment_identity','original_record_hash','plan_hash','plan_ciphertext','created_at'].some(key=>fresh[key as keyof Row]!==row[key as keyof Row])) return stale();
    return fresh;
  };
  const open=async(row: Row): Promise<Plan>=>{
    deps.codec.assertUnlocked();const value=await deps.codec.open(row.plan_ciphertext);deps.codec.assertUnlocked();
    if (!value || typeof value!=='object' || Array.isArray(value)) return stale();const plan=value as Plan;
    if (hash(plan)!==row.plan_hash || plan.correction?.correction_id!==row.correction_id || plan.correction.signoff_id!==row.signoff_id
      || plan.correction.before.refund_id!==row.refund_id || plan.correction.credit.credit_id!==row.credit_id || plan.correction.payment.payment_id!==row.payment_id
      || (plan.correction.replacement?.refund_id??null)!==row.replacement_id || plan.request.signoff_id!==row.signoff_id || plan.request.refund_id!==row.refund_id
      || plan.correction.prepared_at!==row.created_at || plan.payment_identity!==row.payment_identity || plan.original_record_hash!==row.original_record_hash) return stale();
    freshRow(row);return plan;
  };
  const assertIssued=(id: string,signoff_id: string)=>{
    const issued=issuedCustomerRefund(deps,signoff_id,id);
    if (!issued || issued.kind!=='refund' || issued.applied_at===null || !matches('refund',id,issued.applied_record_hash)
      || !matches('payment',issued.payment_id,issued.payment_identity)) return stale();return issued;
  };
  const requireCurrent=(plan: Plan)=>{
    deps.codec.assertUnlocked();const base=deps.signoffs.customerRefundCorrectionSnapshot(plan.request.signoff_id,plan.request.refund_id);
    const issued=assertIssued(plan.request.refund_id,plan.request.signoff_id);
    if (base.history.snapshot_hash!==plan.snapshot_hash || base.write_hash!==plan.write_hash || issued.plan_hash!==plan.source_plan_hash
      || !matches('refund',plan.request.refund_id,plan.original_record_hash) || !matches('payment',issued.payment_id,plan.payment_identity)) return stale();
    return base;
  };
  const assertApplied=(row: Row)=>{
    deps.codec.assertUnlocked();const fresh=freshRow(row);
    if (fresh.applied_at===null || !matches('refund',row.refund_id,row.original_record_hash) || !matches('payment',row.payment_id,row.payment_identity)
      || !matches('refund_reversal',row.correction_id,fresh.reversal_record_hash)
      || row.replacement_id && !matches('refund',row.replacement_id,fresh.replacement_record_hash)) return stale();return fresh;
  };
  const entry=(row: Row,plan: Plan): CustomerRefundCorrectionRecord=>({ ...plan.correction,applied_at: row.applied_at,
    ...(row.run_id ? { run_id: row.run_id } : {}),...(row.actor ? { actor: row.actor } : {}) });
  const preview=(row: Row,plan: Plan): CustomerRefundCorrectionPreview=>({ correction: entry(row,plan),review: { correction_id: row.correction_id,expected_plan_hash: row.plan_hash,summary: summary(plan.correction) } });
  return {
    async prepare(input: CustomerRefundCorrectionPrepareInput,prepared_by: string): Promise<CustomerRefundCorrectionPreview> {
      deps.codec.assertUnlocked();uuid(input.request_key);uuid(input.signoff_id);uuid(input.refund_id);
      if (typeof prepared_by!=='string' || !prepared_by || prepared_by.length>512 || !['reverse','replace'].includes(input.action)) invalid('Choose a refund reversal or replacement from a paired owner client.');
      if (typeof input.expected_snapshot_hash!=='string' || !/^[a-f0-9]{64}$/.test(input.expected_snapshot_hash)) return stale();
      if (input.action==='reverse' && [input.amount,input.returned_on,input.replacement_reason,input.method,input.reference].some(v=>v!==undefined)) invalid('A reversal cannot include replacement refund fields.');
      const method=text(input.method,512,true);const reference=text(input.reference,512,true);
      if ([method,reference].some(v=>v && /[\u0000-\u001f]/.test(v))) invalid('Refund methods and references must stay on one line.');
      const request: CustomerRefundCorrectionPrepareInput={ request_key: input.request_key,signoff_id: input.signoff_id,refund_id: input.refund_id,
        expected_snapshot_hash: input.expected_snapshot_hash,action: input.action,reason: text(input.reason,1000)!,reversed_on: day(input.reversed_on),
        ...(input.action==='replace' ? { amount: money(input.amount),returned_on: day(input.returned_on),replacement_reason: text(input.replacement_reason,1000)!,...(method ? { method } : {}),...(reference ? { reference } : {}) } : {}) };
      const key=hash([prepared_by,request.request_key]);
      const replay=deps.db.prepare('SELECT * FROM customer_refund_corrections WHERE request_key=?').get(key) as Row | undefined;
      if (replay) { const plan=await open(replay);if (hash(plan.request)!==hash(request)) invalid('This preview key was used for different correction fields. Preview again.');const row=freshRow(replay);if (row.applied_at===null) requireCurrent(plan);return preview(row,plan); }
      const saved=deps.db.transaction(()=>{
        const base=deps.signoffs.customerRefundCorrectionSnapshot(request.signoff_id,request.refund_id);const h=base.history;
        if (h.snapshot_hash!==request.expected_snapshot_hash || h.invoice.availability!=='current') return stale();
        const issued=assertIssued(request.refund_id,request.signoff_id);const original=base.refund;
        const credit=h.paid_credits?.find(c=>c.credit_id===original.credit_id);const payment=h.payments.find(p=>p.payment_id===original.payment_id);
        if (!credit || !payment || issued.credit_id!==credit.credit_id || issued.payment_id!==payment.payment_id) return stale();
        if ((h.refunds??[]).filter(r=>r.reversal).length>=1000) invalid('This invoice already has 1,000 refund corrections. Review Records.');
        if (request.action==='replace' && (h.refunds?.length??0)>=1000) invalid('This invoice already has 1,000 refund entries. Reverse without a replacement or review Records.');
        const correction_id=randomUUID();const replacement_id=request.action==='replace' ? randomUUID() : null;
        const replacement=replacement_id ? { refund_id: replacement_id,refund_ref: 'RF-'+replacement_id,credit_id: credit.credit_id,payment_id: payment.payment_id,
          amount: request.amount!,returned_on: request.returned_on!,reason: request.replacement_reason!,replaces_refund_id: original.refund_id,
          ...(method ? { method } : {}),...(reference ? { reference } : {}) } : null;
        const active=(h.refunds??[]).filter(r=>!r.reversal && r.refund_id!==original.refund_id);
        if (replacement) {
          const used=active.filter(r=>r.credit_id===credit.credit_id).reduce((n,r)=>n+units(r.amount),0n);
          if (used+units(replacement.amount)>units(credit.amount)) invalid('The replacement exceeds the amount available on this paid invoice credit.');
          if (reference && active.some(r=>r.payment_id===payment.payment_id && r.reference===reference)) invalid('This refund reference is already recorded against the payment.');
        }
        const before_balance: CustomerRefundBalance={ amount_refund_credited: h.invoice.amount_refund_credited!,amount_refunded: h.invoice.amount_refunded!,refund_due: h.invoice.refund_due!,net_received: h.invoice.net_received!,net_invoice_total: h.invoice.net_invoice_total! };
        const difference=units(original.amount)-units(replacement?.amount??'0.0000');
        const after_balance: CustomerRefundBalance={ ...before_balance,amount_refunded: decimal(units(before_balance.amount_refunded)-difference),
          refund_due: decimal(units(before_balance.refund_due)+difference),net_received: decimal(units(before_balance.net_received)+difference) };
        const correction: CustomerRefundCorrectionRecord={ correction_id,signoff_id: h.signoff_id,invoice_id: h.invoice_id,invoice_ref: h.invoice_ref,currency: h.currency,
          action: request.action,reason: request.reason,reversed_on: request.reversed_on,before: refundEntryFields(original),replacement,credit,payment,
          invoice_total: h.total,amount_paid: h.invoice.amount_paid,amount_credited: h.invoice.amount_credited??'0.0000',outstanding: h.invoice.outstanding,
          before_balance,after_balance,prepared_at: deps.now(),prepared_by,applied_at: null };
        const plan: Plan={ request,correction,snapshot_hash: h.snapshot_hash!,write_hash: base.write_hash,source_plan_hash: issued.plan_hash,
          original_record_hash: identity('refund',original.refund_id),payment_identity: identity('payment',payment.payment_id) };
        const ciphertext=deps.codec.sealSync(plan);requireCurrent(plan);const digest=hash(plan);
        deps.db.prepare('INSERT INTO customer_refund_corrections (correction_id,request_key,signoff_id,refund_id,credit_id,payment_id,replacement_id,payment_identity,original_record_hash,plan_hash,plan_ciphertext,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING')
          .run(correction_id,key,h.signoff_id,original.refund_id,credit.credit_id,payment.payment_id,replacement_id,plan.payment_identity,plan.original_record_hash,digest,ciphertext,correction.prepared_at);
        const row=deps.db.prepare('SELECT * FROM customer_refund_corrections WHERE request_key=?').get(key) as Row | undefined;if (!row) return stale();return { row,plan: row.correction_id===correction_id ? plan : null };
      }).immediate();
      if (saved.plan) return preview(saved.row,saved.plan);const winner=await open(saved.row);if (hash(winner.request)!==hash(request)) invalid('This preview key was used for different correction fields.');const row=freshRow(saved.row);if (row.applied_at===null) requireCurrent(winner);return preview(row,winner);
    },
    async apply(input: CustomerRefundCorrectionApplyInput,meta?: StepMeta): Promise<CustomerRefundCorrectionApplyResult> {
      const row=rowFor(uuid(input.correction_id));if (!row) return stale();const plan=await open(row);
      if (input.expected_plan_hash!==row.plan_hash || input.summary!==summary(plan.correction)) return stale();
      return deps.db.transaction(()=>{
        deps.codec.assertUnlocked();const fresh=freshRow(row);const result=(already_applied: boolean): CustomerRefundCorrectionApplyResult=>({ correction_id: row.correction_id,signoff_id: row.signoff_id,refund_id: row.refund_id,...(row.replacement_id ? { replacement_refund_id: row.replacement_id } : {}),already_applied });
        if (fresh.applied_at!==null) return result(true);const base=requireCurrent(plan);const c=plan.correction;const at=deps.now();const recorded_at=new Date(at).toISOString();
        if (c.replacement) deps.records.execute({ binding: base.refund_binding,principal: 'owner',args: { id: c.replacement.refund_id,values: {
          invoice_ref: 'invoice/'+c.invoice_id,payment_ref: 'payment/'+c.payment.payment_id,credit_ref: 'paid_credit/'+c.credit.credit_id,refund_ref: c.replacement.refund_ref,currency: c.currency,
          amount: c.replacement.amount,returned_on: c.replacement.returned_on,reason: c.replacement.reason,replaces_refund_ref: 'refund/'+row.refund_id,
          ...(c.replacement.method ? { method: c.replacement.method } : {}),...(c.replacement.reference ? { reference: c.replacement.reference } : {}),recorded_at } } });
        deps.records.execute({ binding: base.reversal_binding,principal: 'owner',args: { id: row.correction_id,values: {
          invoice_ref: 'invoice/'+c.invoice_id,payment_ref: 'payment/'+c.payment.payment_id,credit_ref: 'paid_credit/'+c.credit.credit_id,refund_ref: 'refund/'+row.refund_id,
          reversal_ref: 'RFR-'+row.correction_id,currency: c.currency,amount: c.before.amount,reversed_on: c.reversed_on,reason: c.reason,recorded_at,
          ...(row.replacement_id ? { replacement_ref: 'refund/'+row.replacement_id } : {}) } } });
        deps.db.prepare('UPDATE customer_refund_corrections SET applied_at=?,run_id=?,actor=?,reversal_record_hash=?,replacement_record_hash=? WHERE correction_id=? AND applied_at IS NULL')
          .run(at,meta?.run_id??null,meta?.actor??null,identity('refund_reversal',row.correction_id),row.replacement_id ? identity('refund',row.replacement_id) : null,row.correction_id);
        return result(false);
      }).immediate();
    },
    async replacementForCopy(signoff_id: string,id: string) {
      const row=deps.db.prepare('SELECT * FROM customer_refund_corrections WHERE signoff_id=? AND replacement_id=? AND applied_at IS NOT NULL').get(signoff_id,id) as Row | undefined;
      if (!row) return stale();const plan=await open(row);const fresh=assertApplied(row);if (!plan.correction.replacement) return stale();
      const issued: IssuedCustomerRefund={ action_id: id,signoff_id,kind: 'refund',credit_id: row.credit_id,payment_id: row.payment_id,payment_identity: row.payment_identity,
        plan_hash: row.plan_hash,applied_record_hash: fresh.replacement_record_hash,applied_at: fresh.applied_at };
      return { issued,credit: plan.correction.credit,payment: plan.correction.payment,refund: plan.correction.replacement,assertCurrent: ()=>{ assertApplied(row); } };
    },
    async history(input: CustomerRefundCorrectionHistoryInput): Promise<CustomerRefundCorrectionHistory> {
      deps.codec.assertUnlocked();const id=uuid(input.signoff_id);const limit=input.limit??50;if (!Number.isInteger(limit) || limit<1 || limit>100) invalid('Correction history limit must be 1–100.');let anchor: { at: number;id: string } | undefined;
      if (input.cursor!==undefined) try {
        if (typeof input.cursor!=='string' || input.cursor.length>512 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) invalid('Start from the newest correction history.');const value=JSON.parse(Buffer.from(input.cursor,'base64url').toString());
        if (!value || Object.keys(value).sort().join(',')!=='at,id,signoff_id' || value.signoff_id!==id || !Number.isSafeInteger(value.at) || value.at<0) invalid('Start from the newest correction history.');anchor={ at: value.at,id: uuid(value.id) };
      } catch { invalid('Start from the newest correction history.'); }
      const rows=deps.db.prepare(`SELECT * FROM customer_refund_corrections WHERE signoff_id=? ${anchor ? 'AND (created_at<? OR (created_at=? AND correction_id>?))' : ''} ORDER BY created_at DESC,correction_id LIMIT ?`)
        .all(id,...(anchor ? [anchor.at,anchor.at,anchor.id] : []),limit+1) as Row[];
      const opened: Array<{ row: Row;plan: Plan }>=[];for (const row of rows.slice(0,limit)) opened.push({ row,plan: await open(row) });
      const corrections=opened.map(({row,plan})=>entry(freshRow(row),plan));const last=rows[Math.min(rows.length,limit)-1];
      return { corrections,...(last && rows.length>limit ? { next_cursor: Buffer.from(JSON.stringify({ signoff_id: id,at: last.created_at,id: last.correction_id })).toString('base64url') } : {}) };
    },
  };
};
