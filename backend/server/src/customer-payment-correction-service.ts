import { createHash,randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CustomerPaymentCorrectionPrepareInput,CustomerPaymentCorrectionApplyInput,CustomerPaymentCorrectionApplyResult,
  CustomerPaymentCorrectionRecord,CustomerPaymentCorrectionPreview,CustomerPaymentCorrectionHistoryInput,
  CustomerPaymentCorrectionHistory,CustomerPaymentEntry,RecordsFriendlyRecord,StepMeta } from '@recued/contracts';
import { QuoteSignoffError,type QuoteSignoffService } from './quote-signoff-service.js';
import type { RecordsStore } from './records/store.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';

const OWNER = { publisher: 'recued-core',pack_slug: 'invoice-book' };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string): never => { throw new QuoteSignoffError('customer_correction_invalid',message,400); };
const stale = (): never => { throw new QuoteSignoffError('customer_correction_stale','The payment, invoice or correction changed. Refresh payment history and preview a new correction.'); };
const uuid = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
  ? value : invalid('Choose a recorded payment and preview its correction.');
const text = (value: unknown,label: string,max: number): string => typeof value === 'string' && value.trim() && value.trim().length <= max && !/[\u0000\r]/.test(value)
  ? value.trim() : invalid(`${label} is required and must fit ${max} characters.`);
const optional = (value: unknown,label: string): string | undefined => {
  if (value === undefined || value === '') return;
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${label} must fit 512 characters without control characters.`);
  return value as string;
};
const amount = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,4})?$/.test(value) || value.length > 24) invalid('Enter a positive amount with up to four decimal places.');
  const [whole,fraction = ''] = (value as string).split('.');const scaled = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4,'0'));
  if (scaled <= 0n || scaled > 9_223_372_036_854_775_807n) invalid('The corrected amount is outside Invoice Book’s exact money range.');
  return decimal(scaled);
};
const date = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+'T00:00:00Z'))
    || new Date(value+'T00:00:00Z').toISOString().slice(0,10) !== value) invalid('Choose a calendar payment date.');
  return value as string;
};
const units = (value: string) => BigInt(value.replace('.',''));
const decimal = (value: bigint) => `${value / 10_000n}.${String(value % 10_000n).padStart(4,'0')}`;
interface Row {
  correction_id: string;request_key: string;signoff_id: string;payment_id: string;plan_hash: string;
  plan_ciphertext: string;created_at: number;applied_at: number | null;run_id: string | null;actor: string | null;
}
export interface CustomerPaymentCorrectionPlan {
  request: CustomerPaymentCorrectionPrepareInput;request_hash: string;snapshot_hash: string;write_hash: string;
  before_invoice: RecordsFriendlyRecord;before_payment: RecordsFriendlyRecord;
  correction: CustomerPaymentCorrectionRecord;invoice_set: Record<string,string | number>;invoice_unset: string[];
}
const summary = (entry: CustomerPaymentCorrectionRecord): string => [
  `${entry.action === 'void' ? 'Void recorded payment' : 'Correct recorded payment'} ${entry.payment_id} on invoice ${entry.invoice_ref}.`,
  `Before: ${entry.before.amount} ${entry.currency}, received ${entry.before.received_on}; method ${entry.before.method || '(none)'}; reference ${entry.before.reference || '(none)'}.`,
  entry.after ? `After: ${entry.after.amount} ${entry.currency}, received ${entry.after.received_on}; method ${entry.after.method || '(none)'}; reference ${entry.after.reference || '(none)'}.`
    : 'Remove this entry from the active payment ledger; keep its original values in correction history.',
  `Recorded paid: ${entry.before_balance.amount_paid} → ${entry.after_balance.amount_paid} ${entry.currency}.`,
  ...(entry.before_balance.amount_credited ? [`Recorded credits stay ${entry.before_balance.amount_credited} ${entry.currency}.`] : []),
  `Outstanding: ${entry.before_balance.outstanding} → ${entry.after_balance.outstanding} ${entry.currency}.`,
  `Invoice status: ${entry.before_balance.status} → ${entry.after_balance.status}.`,
  `Invoice settled date: ${entry.before_balance.settled_on || '(none)'} → ${entry.after_balance.settled_on || '(none)'}.`,
  'Update payment timing reports from the dates in the corrected payment list.',
  `Reason: ${entry.reason}`,
  'Apply the payment and invoice change together after owner review. This changes local records only.',
].join('\n');

/** Preparation records an encrypted preview. Only the governed kernel step applies it. */
export const createCustomerPaymentCorrectionService = (deps: {
  db: Database.Database;records: RecordsStore;signoffs: QuoteSignoffService;codec: PreapprovalCodec;now: () => number;
}) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_payment_corrections (
    correction_id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,signoff_id TEXT NOT NULL,payment_id TEXT NOT NULL,
    plan_hash TEXT NOT NULL,plan_ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL,applied_at INTEGER,run_id TEXT,actor TEXT
  ); CREATE INDEX IF NOT EXISTS customer_payment_corrections_history ON customer_payment_corrections(signoff_id,created_at DESC,correction_id);
  CREATE INDEX IF NOT EXISTS core_record_outbox_payment_identity_idx ON core_record_outbox(publisher,pack_slug,pk) WHERE kind='payment';`);
  const rowFor = (id: string) => deps.db.prepare('SELECT * FROM customer_payment_corrections WHERE correction_id=?').get(id) as Row | undefined;
  const assertRow = (row: Row) => {
    const fresh = rowFor(row.correction_id);
    if (!fresh || fresh.request_key !== row.request_key || fresh.signoff_id !== row.signoff_id || fresh.payment_id !== row.payment_id
      || fresh.plan_hash !== row.plan_hash || fresh.plan_ciphertext !== row.plan_ciphertext || fresh.created_at !== row.created_at) return stale();
    return fresh;
  };
  const open = async (row: Row): Promise<CustomerPaymentCorrectionPlan> => {
    deps.codec.assertUnlocked();const value = await deps.codec.open(row.plan_ciphertext);deps.codec.assertUnlocked();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return stale();
    const plan = value as CustomerPaymentCorrectionPlan;
    if (hash(plan) !== row.plan_hash || plan.correction?.correction_id !== row.correction_id
      || plan.correction.signoff_id !== row.signoff_id || plan.correction.payment_id !== row.payment_id
      || plan.correction.prepared_at !== row.created_at || hash(plan.request) !== plan.request_hash) return stale();
    assertRow(row);return plan;
  };
  const entry = (row: Row,plan: CustomerPaymentCorrectionPlan): CustomerPaymentCorrectionRecord => ({ ...plan.correction,applied_at: row.applied_at,
    ...(row.run_id ? { run_id: row.run_id } : {}),...(row.actor ? { actor: row.actor } : {}) });
  const preview = (row: Row,plan: CustomerPaymentCorrectionPlan): CustomerPaymentCorrectionPreview => ({ correction: entry(row,plan),
    review: { correction_id: row.correction_id,expected_plan_hash: row.plan_hash,summary: summary(plan.correction) } });
  const requireCurrent = (plan: CustomerPaymentCorrectionPlan) => {
    deps.codec.assertUnlocked();const fresh = deps.signoffs.paymentCorrectionSnapshot(plan.request.signoff_id,plan.request.payment_id,plan.request.action);
    if (fresh.history.snapshot_hash !== plan.snapshot_hash || fresh.write_hash !== plan.write_hash) return stale();
    return fresh;
  };
  const normalize = (input: CustomerPaymentCorrectionPrepareInput,prepared_by: string) => {
      deps.codec.assertUnlocked();uuid(input.request_key);uuid(input.signoff_id);
      if (typeof input.payment_id !== 'string' || !input.payment_id || input.payment_id.length > 256 || /[\u0000-\u001f]/.test(input.payment_id)) invalid('Choose a recorded payment.');
      const payment_id = input.payment_id;const reason = text(input.reason,'Correction reason',1000);
      if (typeof input.expected_snapshot_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_snapshot_hash)
        || !['correct','void'].includes(input.action)) invalid('Refresh payment history and choose a correction action.');
      if (typeof prepared_by !== 'string' || !prepared_by || prepared_by.length > 512) invalid('A paired owner client is required.');
      const after: CustomerPaymentEntry | null = input.action === 'void' ? null : {
        payment_id,amount: amount(input.amount),received_on: date(input.received_on),
        ...(optional(input.method,'Payment method') ? { method: optional(input.method,'Payment method') } : {}),
        ...(optional(input.reference,'Payment reference') ? { reference: optional(input.reference,'Payment reference') } : {}),
      };
      if (!after && [input.amount,input.received_on,input.method,input.reference].some(value => value !== undefined)) invalid('A void has no replacement payment fields.');
      const request: CustomerPaymentCorrectionPrepareInput = { request_key: input.request_key,signoff_id: input.signoff_id,payment_id,
        expected_snapshot_hash: input.expected_snapshot_hash,action: input.action,reason,...(after ? {
          amount: after.amount,received_on: after.received_on,...(after.method ? { method: after.method } : {}),...(after.reference ? { reference: after.reference } : {}),
        } : {}) };
      return { request,after,reason,payment_id };
  };
  const buildPlan = (normalized: ReturnType<typeof normalize>,prepared_by: string,allowUnchanged = false): CustomerPaymentCorrectionPlan => {
    const { request: input,after,reason,payment_id } = normalized;const request = input;
        const base = deps.signoffs.paymentCorrectionSnapshot(input.signoff_id,payment_id,input.action);
        const history = base.history;
        if (history.invoice.availability !== 'current' || history.invoice.status === 'carried_forward') return stale();
        if (history.snapshot_hash !== input.expected_snapshot_hash) return stale();
        const before = history.payments.find(payment => payment.payment_id === payment_id)!;
        if (!allowUnchanged && after && JSON.stringify(before) === JSON.stringify(after)) invalid('Change a payment field before previewing a correction.');
        const paid = history.payments.reduce((sum,payment) => sum + (payment.payment_id === payment_id ? after ? units(after.amount) : 0n : units(payment.amount)),0n);
        const total = units(history.total);const credited = units(history.invoice.amount_credited ?? '0.0000');if (paid+credited > total) invalid('The corrected payments would exceed the invoice total.');
        const outstanding = total-credited-paid;const status = outstanding === 0n ? credited > 0n ? 'credited' as const : 'settled' as const : 'open' as const;
        const dates = history.payments.filter(payment => payment.payment_id !== payment_id).map(payment => payment.received_on);
        if (after) dates.push(after.received_on);const settled_on = status === 'settled' ? dates.sort().at(-1)! : undefined;
        const invoice_set: Record<string,string | number> = { amount_paid: decimal(paid),outstanding: decimal(outstanding),status };
        if (settled_on) {
          const days = Math.round((Date.parse(settled_on+'T00:00:00Z')-Date.parse(base.invoice.due_on+'T00:00:00Z'))/86_400_000);
          invoice_set.settled_on = settled_on;invoice_set.days_late = days;invoice_set.paid_on_time = days <= 0 ? 1 : 0;
        }
        const correction: CustomerPaymentCorrectionRecord = { correction_id: randomUUID(),signoff_id: input.signoff_id,payment_id,
          invoice_id: history.invoice_id,invoice_ref: history.invoice_ref,currency: history.currency,action: input.action,reason,before,after,
          before_balance: { amount_paid: history.invoice.amount_paid,...(credited > 0n ? { amount_credited: decimal(credited) } : {}),outstanding: history.invoice.outstanding,status: history.invoice.status === 'credited' ? 'credited' : history.invoice.status === 'settled' ? 'settled' : 'open',
            ...(typeof base.invoice.settled_on === 'string' && base.invoice.settled_on ? { settled_on: base.invoice.settled_on } : {}) },
          after_balance: { amount_paid: decimal(paid),...(credited > 0n ? { amount_credited: decimal(credited) } : {}),outstanding: decimal(outstanding),status,...(settled_on ? { settled_on } : {}) },
          prepared_at: deps.now(),prepared_by,applied_at: null };
        const plan: CustomerPaymentCorrectionPlan = { request,request_hash: hash(request),snapshot_hash: history.snapshot_hash!,write_hash: base.write_hash,
          before_invoice: base.invoice,before_payment: base.payment,correction,invoice_set,invoice_unset: settled_on ? [] : ['settled_on','days_late','paid_on_time'] };
    return plan;
  };
  const writePlan = (plan: CustomerPaymentCorrectionPlan) => {
        const base = requireCurrent(plan);const payment = base.payment;const invoice = base.invoice;
        if (plan.correction.after && JSON.stringify(plan.correction.before) !== JSON.stringify(plan.correction.after)) {
          const after = plan.correction.after;
          deps.records.execute({ binding: base.payment_binding,args: { id: payment.id,expected_version: payment._record.version,expected_revision: payment._record.revision,
            set: { amount: after.amount,received_on: after.received_on,...(after.method ? { method: after.method } : {}),...(after.reference ? { reference: after.reference } : {}) },
            unset: [...(after.method ? [] : ['method']),...(after.reference ? [] : ['reference'])] },principal: 'owner' });
        } else if (!plan.correction.after) deps.records.execute({ binding: base.payment_binding,args: { id: payment.id,expected_version: payment._record.version,expected_revision: payment._record.revision },principal: 'owner' });
        const invoiceChanged = Object.entries(plan.invoice_set).some(([key,value]) => invoice[key] !== value)
          || plan.invoice_unset.some(key => invoice[key] !== undefined && invoice[key] !== null);
        if (invoiceChanged) deps.records.execute({ binding: base.invoice_binding,args: { id: invoice.id,expected_version: invoice._record.version,expected_revision: invoice._record.revision,
          set: plan.invoice_set,unset: plan.invoice_unset },principal: 'owner' });
  };
  return {
    /** Internal synchronous plans are sealed by the enclosing account correction. No writes occur here. */
    buildForGroup(input: CustomerPaymentCorrectionPrepareInput,prepared_by: string) { return buildPlan(normalize(input,prepared_by),prepared_by,true); },
    validateForGroup(plan: CustomerPaymentCorrectionPlan) { requireCurrent(plan); },
    /** Called only inside the account correction's immediate transaction. History and records roll back together. */
    applyForGroup(plan: CustomerPaymentCorrectionPlan,meta?: StepMeta) {
      deps.codec.assertUnlocked();requireCurrent(plan);
      const c = plan.correction;const request_key = hash([c.prepared_by,plan.request.request_key]);
      if (rowFor(c.correction_id) || deps.db.prepare('SELECT 1 FROM customer_payment_corrections WHERE request_key=?').get(request_key)) return stale();
      const ciphertext = deps.codec.sealSync(plan);requireCurrent(plan);
      deps.db.prepare(`INSERT INTO customer_payment_corrections
        (correction_id,request_key,signoff_id,payment_id,plan_hash,plan_ciphertext,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(c.correction_id,request_key,c.signoff_id,c.payment_id,hash(plan),ciphertext,c.prepared_at);
      writePlan(plan);
      deps.db.prepare('UPDATE customer_payment_corrections SET applied_at=?,run_id=?,actor=? WHERE correction_id=?')
        .run(deps.now(),meta?.run_id ?? null,meta?.actor ?? null,c.correction_id);
    },
    async prepare(input: CustomerPaymentCorrectionPrepareInput,prepared_by: string): Promise<CustomerPaymentCorrectionPreview> {
      const normalized = normalize(input,prepared_by);const { request,payment_id } = normalized;
      const request_key = hash([prepared_by,input.request_key]);
      const replay = deps.db.prepare('SELECT * FROM customer_payment_corrections WHERE request_key=?').get(request_key) as Row | undefined;
      if (replay) {
        const plan = await open(replay);if (plan.request_hash !== hash(request)) invalid('This preview request was already used for different correction fields. Preview again.');
        const fresh = assertRow(replay);if (fresh.applied_at === null) requireCurrent(plan);return preview(fresh,plan);
      }
      const created = deps.db.transaction(() => {
        const plan = buildPlan(normalized,prepared_by);const correction = plan.correction;
        const plan_hash = hash(plan);const plan_ciphertext = deps.codec.sealSync(plan);requireCurrent(plan);
        deps.db.prepare(`INSERT INTO customer_payment_corrections
          (correction_id,request_key,signoff_id,payment_id,plan_hash,plan_ciphertext,created_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(request_key) DO NOTHING`)
          .run(correction.correction_id,request_key,input.signoff_id,payment_id,plan_hash,plan_ciphertext,correction.prepared_at);
        const stored = deps.db.prepare('SELECT * FROM customer_payment_corrections WHERE request_key=?').get(request_key) as Row | undefined;
        if (!stored) return stale();
        return { row: stored,plan: stored.correction_id === correction.correction_id ? plan : null };
      }).immediate();
      if (created.plan) return preview(created.row,created.plan);
      const winner = await open(created.row);
      if (winner.request_hash !== hash(request)) invalid('This preview request was already used for different correction fields. Preview again.');
      const fresh = assertRow(created.row);if (fresh.applied_at === null) requireCurrent(winner);return preview(fresh,winner);
    },
    async apply(input: CustomerPaymentCorrectionApplyInput,meta?: StepMeta): Promise<CustomerPaymentCorrectionApplyResult> {
      const row = rowFor(uuid(input.correction_id));if (!row) return stale();const plan = await open(row);
      if (input.expected_plan_hash !== row.plan_hash || input.summary !== summary(plan.correction)) return stale();
      return deps.db.transaction(() => {
        deps.codec.assertUnlocked();const freshRow = assertRow(row);
        const result = (already_applied: boolean): CustomerPaymentCorrectionApplyResult => ({ correction_id: row.correction_id,
          signoff_id: row.signoff_id,payment_id: row.payment_id,invoice_id: plan.correction.invoice_id,action: plan.correction.action,already_applied });
        if (freshRow.applied_at !== null) return result(true);
        writePlan(plan);
        deps.db.prepare('UPDATE customer_payment_corrections SET applied_at=?,run_id=?,actor=? WHERE correction_id=? AND applied_at IS NULL')
          .run(deps.now(),meta?.run_id ?? null,meta?.actor ?? null,row.correction_id);
        return result(false);
      }).immediate();
    },
    async history(input: CustomerPaymentCorrectionHistoryInput): Promise<CustomerPaymentCorrectionHistory> {
      deps.codec.assertUnlocked();const signoff_id = uuid(input.signoff_id);const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Correction history limit must be 1–100.');
      let anchor: { at: number;id: string } | undefined;
      if (input.cursor !== undefined) {
        try {
          if (typeof input.cursor !== 'string' || input.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) invalid('Start from the newest correction history.');
          const value = JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
          if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'at,id,signoff_id' || value.signoff_id !== signoff_id
            || !Number.isSafeInteger(value.at) || value.at < 0) invalid('Start from the newest correction history.');
          anchor = { at: value.at,id: uuid(value.id) };
        } catch { invalid('Start from the newest correction history.'); }
      }
      const rows = deps.db.prepare(`SELECT * FROM customer_payment_corrections WHERE signoff_id=?
        ${anchor ? 'AND (created_at<? OR (created_at=? AND correction_id>?))' : ''} ORDER BY created_at DESC,correction_id LIMIT ?`)
        .all(signoff_id,...(anchor ? [anchor.at,anchor.at,anchor.id] : []),limit+1) as Row[];
      const page = rows.slice(0,limit);const corrections: CustomerPaymentCorrectionRecord[] = [];
      for (const row of page) { const plan = await open(row);corrections.push(entry(assertRow(row),plan)); }
      const last = page.at(-1);return { corrections,...(rows.length > limit && last ? {
        next_cursor: Buffer.from(JSON.stringify({ signoff_id,at: last.created_at,id: last.correction_id })).toString('base64url'),
      } : {}) };
    },
  };
};
export type CustomerPaymentCorrectionService = ReturnType<typeof createCustomerPaymentCorrectionService>;
