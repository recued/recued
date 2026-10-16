import type Database from 'better-sqlite3';
import { matchesCustomerRefundIdentity } from './customer-refund-identity.js';
import type { CustomerPaidCreditEntry,CustomerRefundEntry,CustomerRefundBalance,RecordsExecutionBinding,RecordsFriendlyRecord } from '@recued/contracts';
import type { RecordsStore } from './records/store.js';
const OWNER = { publisher: 'recued-core',pack_slug: 'invoice-book' };
export const refundUnits = (value: string) => BigInt(value.replace('.',''));
export const refundDecimal = (value: bigint) => `${value/10_000n}.${String(value%10_000n).padStart(4,'0')}`;
export const refundEntryFields = (entry: CustomerRefundEntry): CustomerRefundEntry => ({
  refund_id: entry.refund_id,refund_ref: entry.refund_ref,credit_id: entry.credit_id,payment_id: entry.payment_id,
  amount: entry.amount,returned_on: entry.returned_on,reason: entry.reason,
  ...(entry.method ? { method: entry.method } : {}),...(entry.reference ? { reference: entry.reference } : {}),
  ...(entry.replaces_refund_id ? { replaces_refund_id: entry.replaces_refund_id } : {}),
});
export const emptyRefundBalance = (paid: string,total: string,credited: string): CustomerRefundBalance => ({
  amount_refund_credited: '0.0000',amount_refunded: '0.0000',refund_due: '0.0000',net_received: paid,net_invoice_total: refundDecimal(refundUnits(total)-refundUnits(credited)),
});
export const readCustomerRefundLedger = (deps: {
  db: Database.Database;records: RecordsStore;binding: (action: 'get' | 'search',entity: string) => RecordsExecutionBinding;
},invoice: RecordsFriendlyRecord) => {
  const paid_credits: CustomerPaidCreditEntry[] = [];const refunds: CustomerRefundEntry[] = [];
  const evidence: Array<{ record: RecordsFriendlyRecord;changes: unknown }> = [];
  const version=deps.binding('get','invoice').pack_version;
  if (version < 8) return { paid_credits,refunds,evidence,balance: undefined,bindings: undefined };
  const fail = (): never => { throw new Error('Paid invoice credit and refund records need review.'); };
  const money = (value: unknown,positive = true): string => {
    if (typeof value !== 'string' || !/^\d+\.\d{4}$/.test(value) || value.length>24) return fail();
    const n=refundUnits(value);if ((positive ? n<=0n : n<0n) || n>refundUnits(String(invoice.total))) return fail();return value;
  };
  const text = (value: unknown,max: number,optional = false): string | undefined => {
    if (optional && (value == null || value === '')) return;
    if (typeof value !== 'string' || !value.trim() || value.length>max || /[\u0000\r]/.test(value)) return fail();return value;
  };
  const day = (value: unknown): string => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+'T00:00:00Z'))
      || new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value) return fail();return value;
  };
  const link = (value: unknown,entity: string): string => typeof value==='string' && value.startsWith(entity+'/') && value.length>entity.length+1 ? value.slice(entity.length+1) : fail();
  const lifecycle = deps.db.prepare('SELECT count(*) AS n,max(event_id) AS event_id FROM core_record_outbox WHERE publisher=? AND pack_slug=? AND kind=? AND pk=?');
  const bindings = { creditGet: deps.binding('get','paid_credit'),creditSearch: deps.binding('search','paid_credit'),refundGet: deps.binding('get','refund'),refundSearch: deps.binding('search','refund'),paymentGet: deps.binding('get','payment'),
    ...(version>=9 ? { reversalGet: deps.binding('get','refund_reversal'),reversalSearch: deps.binding('search','refund_reversal') } : {}) };
  const rows = (entity: string) => {
    const found: RecordsFriendlyRecord[]=[];let cursor: string | undefined;
    do {
      const page=deps.records.ownerSearch({ owner: OWNER,entity,filters: { invoice_ref: 'invoice/'+invoice.id },limit: 200,...(cursor ? { cursor } : {}) });found.push(...page.records);cursor=page.next_cursor;
      if (found.length>1000 || found.length===1000 && cursor) fail();
    } while(cursor);
    for (const record of found) {
      if (record.invoice_ref!=='invoice/'+invoice.id || record.currency!==invoice.currency) fail();
      evidence.push({ record,changes: lifecycle.get(OWNER.publisher,OWNER.pack_slug,entity,record.id) });
    }
    return found;
  };
  const perPayment = new Map<string,bigint>();let credited=0n;let refunded=0n;
  for (const row of rows('paid_credit')) {
    const payment_id=link(row.payment_ref,'payment');const payment=deps.records.ownerGet(OWNER,'payment',payment_id);const amount=money(row.amount);
    if (!payment || payment.invoice_ref!=='invoice/'+invoice.id || row.credit_ref!=='PCR-'+row.id) fail();
    const used=(perPayment.get(payment_id)??0n)+refundUnits(amount);if (used>refundUnits(money(payment!.amount))) fail();perPayment.set(payment_id,used);credited+=refundUnits(amount);
    evidence.push({ record: payment!,changes: lifecycle.get(OWNER.publisher,OWNER.pack_slug,'payment',payment_id) });
    paid_credits.push({ credit_id: row.id,credit_ref: String(row.credit_ref),payment_id,amount,issued_on: day(row.issued_on),reason: text(row.reason,1000)! });
  }
  const byCredit=new Map(paid_credits.map(entry=>[entry.credit_id,entry]));
  for (const row of rows('refund')) {
    const credit_id=link(row.credit_ref,'paid_credit');const credit=byCredit.get(credit_id);const payment_id=link(row.payment_ref,'payment');const amount=money(row.amount);
    if (!credit || credit.payment_id!==payment_id || row.refund_ref!=='RF-'+row.id || version<9 && row.replaces_refund_ref!=null) fail();
    const method=text(row.method,512,true);const reference=text(row.reference,512,true);
    if ([method,reference].some(value=>value && /[\u0000-\u001f]/.test(value))) fail();
    refunds.push({ refund_id: row.id,refund_ref: String(row.refund_ref),credit_id,payment_id,amount,returned_on: day(row.returned_on),reason: text(row.reason,1000)!,...(method ? { method } : {}),...(reference ? { reference } : {}),
      ...(row.replaces_refund_ref!=null ? { replaces_refund_id: link(row.replaces_refund_ref,'refund') } : {}) });
  }
  const byRefund=new Map(refunds.map(entry=>[entry.refund_id,entry]));
  if (version>=9) for (const row of rows('refund_reversal')) {
    const original=byRefund.get(link(row.refund_ref,'refund'));if (!original) return fail();
    if (original.reversal || row.reversal_ref!=='RFR-'+row.id || link(row.credit_ref,'paid_credit')!==original.credit_id
      || link(row.payment_ref,'payment')!==original.payment_id || money(row.amount)!==original.amount) fail();
    const replacement_id=row.replacement_ref==null ? undefined : link(row.replacement_ref,'refund');
    if (replacement_id) {
      const replacement=byRefund.get(replacement_id);
      if (!replacement || replacement.refund_id===original.refund_id || replacement.replaces_refund_id!==original.refund_id
        || replacement.credit_id!==original.credit_id || replacement.payment_id!==original.payment_id) fail();
    }
    original.reversal={ correction_id: row.id,reversed_on: day(row.reversed_on),reason: text(row.reason,1000)!,...(replacement_id ? { replacement_refund_id: replacement_id } : {}) };
  }
  const perCredit=new Map<string,bigint>();const references=new Set<string>();
  for (const entry of refunds) {
    if (entry.replaces_refund_id && byRefund.get(entry.replaces_refund_id)?.reversal?.replacement_refund_id!==entry.refund_id) fail();
    const visited=new Set<string>();let current: CustomerRefundEntry | undefined=entry;
    while (current?.replaces_refund_id) {
      if (visited.has(current.refund_id)) fail();visited.add(current.refund_id);current=byRefund.get(current.replaces_refund_id);
    }
    if (!entry.reversal) {
      const used=(perCredit.get(entry.credit_id)??0n)+refundUnits(entry.amount);if (used>refundUnits(byCredit.get(entry.credit_id)!.amount)) fail();
      perCredit.set(entry.credit_id,used);refunded+=refundUnits(entry.amount);
      if (entry.reference) { const key=JSON.stringify([entry.payment_id,entry.reference]);if (references.has(key)) fail();references.add(key); }
    }
  }
  const paid=refundUnits(money(invoice.amount_paid,false));const unpaidCredits=refundUnits(money(invoice.amount_credited??'0.0000',false));
  // An owner can delete an append-only Records row. A previously recorded
  // refund must then require repair, rather than becoming available to record again.
  const signoff_id=invoice.id.startsWith('quote_signoff_') ? invoice.id.slice('quote_signoff_'.length) : '';
  const table=(name: string)=>Boolean(deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const knownRefunds=new Set<string>();
  if (table('customer_refund_actions')) {
    const applied=deps.db.prepare('SELECT action_id,kind,payment_id,payment_identity,applied_record_hash FROM customer_refund_actions WHERE signoff_id=? AND applied_at IS NOT NULL LIMIT 2001').all(signoff_id) as Array<{ action_id: string;kind: string;payment_id: string;payment_identity: string;applied_record_hash: string|null }>;
    if (applied.length>2000) fail();
    for (const row of applied) {
      if (!['credit','refund'].includes(row.kind) || !matchesCustomerRefundIdentity(deps,row.kind==='credit' ? 'paid_credit' : 'refund',row.action_id,row.applied_record_hash)
        || !matchesCustomerRefundIdentity(deps,'payment',row.payment_id,row.payment_identity)) fail();
      if (row.kind==='refund') knownRefunds.add(row.action_id);
    }
  }
  const corrected=new Map<string,string>();
  if (table('customer_refund_corrections')) {
    const applied=deps.db.prepare('SELECT correction_id,refund_id,replacement_id,payment_id,payment_identity,original_record_hash,reversal_record_hash,replacement_record_hash FROM customer_refund_corrections WHERE signoff_id=? AND applied_at IS NOT NULL LIMIT 1001').all(signoff_id) as Array<{ correction_id: string;refund_id: string;replacement_id: string|null;payment_id: string;payment_identity: string;original_record_hash: string;reversal_record_hash: string|null;replacement_record_hash: string|null }>;
    if (applied.length>1000) fail();
    for (const row of applied) {
      if (!matchesCustomerRefundIdentity(deps,'refund',row.refund_id,row.original_record_hash) || !matchesCustomerRefundIdentity(deps,'payment',row.payment_id,row.payment_identity)
        || !matchesCustomerRefundIdentity(deps,'refund_reversal',row.correction_id,row.reversal_record_hash)
        || row.replacement_id && !matchesCustomerRefundIdentity(deps,'refund',row.replacement_id,row.replacement_record_hash)
        || byRefund.get(row.refund_id)?.reversal?.correction_id!==row.correction_id) fail();
      corrected.set(row.refund_id,row.correction_id);if (row.replacement_id) knownRefunds.add(row.replacement_id);
    }
  }
  for (const id of knownRefunds) {
    const entry=byRefund.get(id);if (!entry || entry.reversal && corrected.get(id)!==entry.reversal.correction_id) fail();
  }
  if (credited>paid || refunded>credited || paid+unpaidCredits+refundUnits(money(invoice.outstanding,false))!==refundUnits(String(invoice.total))) fail();
  const balance: CustomerRefundBalance={ amount_refund_credited: refundDecimal(credited),amount_refunded: refundDecimal(refunded),refund_due: refundDecimal(credited-refunded),net_received: refundDecimal(paid-refunded),net_invoice_total: refundDecimal(refundUnits(String(invoice.total))-unpaidCredits-credited) };
  return { paid_credits,refunds,evidence,bindings,...(paid_credits.length ? { balance } : {}) };
};
