import { createHash,randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CustomerAccountPaymentCorrectionPrepareInput,CustomerAccountPaymentCorrectionRecord,CustomerAccountPaymentCorrectionPreview,
  CustomerAccountPaymentCorrectionApplyInput,CustomerAccountPaymentCorrectionApplyResult,CustomerAccountPaymentCorrectionHistoryInput,
  CustomerAccountPaymentCorrectionHistory,StepMeta } from '@recued/contracts';
import type { CustomerAccountPaymentService } from './customer-account-payment-service.js';
import type { CustomerPaymentCorrectionService,CustomerPaymentCorrectionPlan } from './customer-payment-correction-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { QuoteSignoffError,type QuoteSignoffService } from './quote-signoff-service.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string): never => { throw new QuoteSignoffError('customer_account_correction_invalid',message,400); };
const stale = (): never => { throw new QuoteSignoffError('customer_account_correction_stale','The account payment, invoice entries or reviewed correction changed. Refresh its receipt and preview again.'); };
const uuid = (v: unknown): string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v) ? v : invalid('Choose a saved account payment.');
const digest = (v: unknown): string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : invalid('Refresh the current account payment receipt.');
const units = (v: string) => BigInt(v.replace('.',''));
const decimal = (v: bigint) => `${v/10000n}.${String(v%10000n).padStart(4,'0')}`;
const money = (v: unknown): string => {
  if (typeof v !== 'string' || !/^\d+(?:\.\d{1,4})?$/.test(v) || v.length > 24) return invalid('Enter amounts with up to four decimal places.');
  const [w,f = ''] = v.split('.');const n = BigInt(w!)*10000n+BigInt(f.padEnd(4,'0'));
  if (n > 9_223_372_036_854_775_807n) return invalid('The corrected amount is outside Invoice Book’s exact money range.');return decimal(n);
};
const optional = (v: unknown): string | undefined => {
  if (v === undefined || v === '') return;
  if (typeof v !== 'string' || v.length > 512 || /[\x00-\x1f\x7f]/.test(v)) return invalid('Payment details must fit 512 characters on one line.');return v;
};
interface Row { correction_id: string;request_key: string;account_payment_id: string;plan_hash: string;plan_ciphertext: string;created_at: number;applied_at: number | null;run_id: string | null;actor: string | null }
interface Plan { request: CustomerAccountPaymentCorrectionPrepareInput;request_hash: string;correction: CustomerAccountPaymentCorrectionRecord;children: CustomerPaymentCorrectionPlan[] }
const summary = (c: CustomerAccountPaymentCorrectionRecord) => [
  `${c.action === 'void' ? 'Void' : 'Correct'} account payment ${c.account_payment_id} for ${c.customer} (${c.account_id}).`,
  `Current recorded allocations: ${c.before_amount} → ${c.after_amount} ${c.currency}.`,
  ...c.allocations.flatMap(a => [
    `Invoice ${a.invoice_ref} (${a.invoice_id}), payment ${a.payment_id}.`,
    `Before: ${a.before.amount} ${c.currency}, ${a.before.received_on}; method ${a.before.method || '(none)'}; reference ${a.before.reference || '(none)'}.`,
    a.after ? `After: ${a.after.amount} ${c.currency}, ${a.after.received_on}; method ${a.after.method || '(none)'}; reference ${a.after.reference || '(none)'}.` : 'After: remove this entry from the active ledger.',
    `Recorded paid: ${a.before_balance.amount_paid} → ${a.after_balance.amount_paid}; outstanding: ${a.before_balance.outstanding} → ${a.after_balance.outstanding} ${c.currency}.`,
    `Invoice status: ${a.before_balance.status} → ${a.after_balance.status}; settled date: ${a.before_balance.settled_on || '(none)'} → ${a.after_balance.settled_on || '(none)'}.`,
    ...(a.before_balance.amount_credited ? [`Invoice credits stay ${a.before_balance.amount_credited} ${c.currency}.`] : []),
  ]),
  `Reason: ${c.reason}`,'Apply every invoice change and correction history together after fresh owner review. This corrects local records; it does not move or refund money.',
].join('\n');
export const createCustomerAccountPaymentCorrectionService = (deps: {
  db: Database.Database;signoffs: QuoteSignoffService;payments: CustomerAccountPaymentService;corrections: CustomerPaymentCorrectionService;codec: PreapprovalCodec;now: () => number;
}) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_account_payment_corrections (
    correction_id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,account_payment_id TEXT NOT NULL,plan_hash TEXT NOT NULL,
    plan_ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL,applied_at INTEGER,run_id TEXT,actor TEXT
  ); CREATE INDEX IF NOT EXISTS customer_account_payment_correction_history ON customer_account_payment_corrections(account_payment_id,created_at DESC,correction_id);`);
  const rowFor = (id: string) => deps.db.prepare('SELECT * FROM customer_account_payment_corrections WHERE correction_id=?').get(id) as Row | undefined;
  const winnerFor = (key: string) => deps.db.prepare('SELECT * FROM customer_account_payment_corrections WHERE request_key=?').get(key) as Row | undefined;
  const fresh = (row: Row) => {
    const r = rowFor(row.correction_id);
    if (!r || r.request_key !== row.request_key || r.account_payment_id !== row.account_payment_id || r.plan_hash !== row.plan_hash
      || r.plan_ciphertext !== row.plan_ciphertext || r.created_at !== row.created_at) return stale();return r;
  };
  const open = async (row: Row): Promise<Plan> => {
    deps.codec.assertUnlocked();const v = await deps.codec.open(row.plan_ciphertext);deps.codec.assertUnlocked();
    if (!v || typeof v !== 'object' || Array.isArray(v)) return stale();const p = v as Plan;
    if (hash(p) !== row.plan_hash || p.correction?.correction_id !== row.correction_id || p.correction.account_payment_id !== row.account_payment_id
      || p.correction.prepared_at !== row.created_at || hash(p.request) !== p.request_hash) return stale();fresh(row);return p;
  };
  const entry = (r: Row,p: Plan): CustomerAccountPaymentCorrectionRecord => ({ ...p.correction,applied_at: r.applied_at,
    ...(r.run_id ? { run_id: r.run_id } : {}),...(r.actor ? { actor: r.actor } : {}),allocations: p.correction.allocations.map(a => ({ ...a,applied_at: r.applied_at,
      ...(r.run_id ? { run_id: r.run_id } : {}),...(r.actor ? { actor: r.actor } : {}) })) });
  const preview = (r: Row,p: Plan): CustomerAccountPaymentCorrectionPreview => ({ correction: entry(r,p),review: { correction_id: r.correction_id,expected_plan_hash: r.plan_hash,summary: summary(p.correction) } });
  const check = (p: Plan,capture: Awaited<ReturnType<CustomerAccountPaymentService['captureCorrection']>>) => {
    deps.codec.assertUnlocked();if (capture.read().statement_hash !== p.request.expected_receipt_hash) return stale();p.children.forEach(child => deps.corrections.validateForGroup(child));
  };
  const replay = async (r: Row,request: CustomerAccountPaymentCorrectionPrepareInput): Promise<CustomerAccountPaymentCorrectionPreview> => {
    const p = await open(r);if (p.request_hash !== hash(request)) return invalid('This request key was used for different correction fields. Preview again.');
    if (fresh(r).applied_at !== null) return preview(fresh(r),p);
    try {
      const capture = await deps.payments.captureCorrection({ account_payment_id: r.account_payment_id });
      deps.codec.assertUnlocked();const current = fresh(r);if (current.applied_at === null) check(p,capture);return preview(current,p);
    } catch (error) { deps.codec.assertUnlocked();const current = fresh(r);if (current.applied_at !== null) return preview(current,p);throw error; }
  };
  return {
    async prepare(input: CustomerAccountPaymentCorrectionPrepareInput,prepared_by: string): Promise<CustomerAccountPaymentCorrectionPreview> {
      deps.codec.assertUnlocked();uuid(input.request_key);uuid(input.account_payment_id);digest(input.expected_receipt_hash);
      if (Object.keys(input).some(k => !['request_key','account_payment_id','expected_receipt_hash','action','reason','amount','received_on','method','reference','allocations'].includes(k))) invalid('Only payment correction fields are accepted.');
      if (!prepared_by || typeof prepared_by !== 'string' || prepared_by.length > 512) invalid('A paired owner client is required.');
      if (!['correct','void'].includes(input.action) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 1000 || /[\x00\r]/.test(input.reason)) invalid('Choose an action and give a correction reason of up to 1,000 characters.');
      const request: CustomerAccountPaymentCorrectionPrepareInput = { request_key: input.request_key,account_payment_id: input.account_payment_id,expected_receipt_hash: input.expected_receipt_hash,action: input.action,reason: input.reason.trim() };
      if (input.action === 'void') {
        if ([input.amount,input.received_on,input.method,input.reference,input.allocations].some(v => v !== undefined)) invalid('A group void has no replacement fields.');
      } else {
        const amount = money(input.amount);if (units(amount) <= 0n) invalid('A corrected group must retain a positive amount. Choose void to remove all entries.');
        if (typeof input.received_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.received_on) || !Number.isFinite(Date.parse(input.received_on+'T00:00:00Z'))
          || new Date(input.received_on+'T00:00:00Z').toISOString().slice(0,10) !== input.received_on) invalid('Choose a calendar received date.');
        if (!Array.isArray(input.allocations) || !input.allocations.length || input.allocations.length > 100) invalid('Choose the active original allocations, up to 100.');
        const allocations = input.allocations!.map(a => {
          if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['payment_id','amount'].includes(k))) return invalid('Choose original payment entries and amounts only.');
          return { payment_id: uuid(a.payment_id),amount: money(a.amount) };
        }).sort((a,b) => a.payment_id.localeCompare(b.payment_id));
        if (new Set(allocations.map(a => a.payment_id)).size !== allocations.length || allocations.reduce((n,a) => n+units(a.amount),0n) !== units(amount)) invalid('Choose each active entry once and allocate the exact corrected total.');
        const method = optional(input.method),reference = optional(input.reference);
        Object.assign(request,{ amount,received_on: input.received_on,allocations,...(method ? { method } : {}),...(reference ? { reference } : {}) });
      }
      const key = hash([prepared_by,input.request_key]);const existing = winnerFor(key);if (existing) return replay(existing,request);
      let capture: Awaited<ReturnType<CustomerAccountPaymentService['captureCorrection']>>;
      try { capture = await deps.payments.captureCorrection({ account_payment_id: input.account_payment_id }); }
      catch (error) { deps.codec.assertUnlocked();const winner = winnerFor(key);if (winner) return replay(winner,request);throw error; }
      const winner = winnerFor(key);if (winner) return replay(winner,request);
      const created = deps.db.transaction(() => {
        deps.codec.assertUnlocked();const copy = capture.read();if (copy.statement_hash !== request.expected_receipt_hash) return stale();
        const active = copy.allocations.filter(a => a.current_payment);
        if (!active.length) invalid('All entries from this payment are already removed. Its receipt and correction history remain available.');
        if (request.action === 'correct' && (active.length !== request.allocations!.length || active.some(a => !request.allocations!.some(b => b.payment_id === a.payment_id)))) invalid('Correct only the active entries from this original payment. Removed entries cannot be restored.');
        const children = active.map(a => {
          const amount = request.action === 'void' ? '0.0000' : request.allocations!.find(b => b.payment_id === a.payment_id)!.amount;
          const action = units(amount) === 0n ? 'void' as const : 'correct' as const;
          return deps.corrections.buildForGroup({ request_key: randomUUID(),signoff_id: a.signoff_id,payment_id: a.payment_id,
            expected_snapshot_hash: a.current_payment ? deps.signoffs.paymentHistorySnapshot(a.signoff_id).snapshot_hash! : '',action,reason: request.reason,
            ...(action === 'correct' ? { amount,received_on: request.received_on!,...(request.method ? { method: request.method } : {}),...(request.reference ? { reference: request.reference } : {}) } : {}) },prepared_by);
        });
        if (request.action === 'correct' && children.every(c => JSON.stringify(c.correction.before) === JSON.stringify(c.correction.after))) invalid('Change a payment field or allocation before previewing.');
        const correction: CustomerAccountPaymentCorrectionRecord = { correction_id: randomUUID(),account_payment_id: copy.payment.account_payment_id,account_id: copy.payment.account_id,
          customer: copy.payment.customer,currency: copy.payment.currency,action: request.action,reason: request.reason,before_amount: copy.current_allocated,after_amount: request.amount ?? '0.0000',
          allocations: children.map(c => c.correction),prepared_at: deps.now(),prepared_by,applied_at: null };
        if (summary(correction).length > 60_000) invalid('This correction is too large to review safely. Shorten the payment details or reason.');
        const p: Plan = { request,request_hash: hash(request),correction,children };const ciphertext = deps.codec.sealSync(p);check(p,capture);
        deps.db.prepare(`INSERT INTO customer_account_payment_corrections (correction_id,request_key,account_payment_id,plan_hash,plan_ciphertext,created_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING`).run(correction.correction_id,key,correction.account_payment_id,hash(p),ciphertext,correction.prepared_at);
        const stored = winnerFor(key);if (!stored) return stale();return { row: stored,plan: stored.correction_id === correction.correction_id ? p : null };
      }).immediate();
      return created.plan ? preview(fresh(created.row),created.plan) : replay(created.row,request);
    },
    async apply(input: CustomerAccountPaymentCorrectionApplyInput,meta?: StepMeta): Promise<CustomerAccountPaymentCorrectionApplyResult> {
      const row = rowFor(uuid(input.correction_id));if (!row) return stale();const p = await open(row);
      if (input.expected_plan_hash !== row.plan_hash || input.summary !== summary(p.correction)) return stale();
      const result = (already_applied: boolean): CustomerAccountPaymentCorrectionApplyResult => ({ correction_id: row.correction_id,account_payment_id: row.account_payment_id,account_id: p.correction.account_id,already_applied });
      if (fresh(row).applied_at !== null) return result(true);
      let capture: Awaited<ReturnType<CustomerAccountPaymentService['captureCorrection']>>;
      try { capture = await deps.payments.captureCorrection({ account_payment_id: row.account_payment_id }); }
      catch (error) { deps.codec.assertUnlocked();if (fresh(row).applied_at !== null) return result(true);throw error; }
      return deps.db.transaction(() => {
        deps.codec.assertUnlocked();if (fresh(row).applied_at !== null) return result(true);check(p,capture);
        p.children.forEach(child => deps.corrections.applyForGroup(child,meta));
        if (capture.read().current_allocated !== p.correction.after_amount) return stale();
        deps.db.prepare('UPDATE customer_account_payment_corrections SET applied_at=?,run_id=?,actor=? WHERE correction_id=? AND applied_at IS NULL')
          .run(deps.now(),meta?.run_id ?? null,meta?.actor ?? null,row.correction_id);return result(false);
      }).immediate();
    },
    async history(input: CustomerAccountPaymentCorrectionHistoryInput): Promise<CustomerAccountPaymentCorrectionHistory> {
      deps.codec.assertUnlocked();const id = uuid(input.account_payment_id);const limit = input.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('Choose a correction history page size from 1 to 100.');
      let anchor: { at: number;id: string } | undefined;
      if (input.cursor !== undefined) {
        try {
          if (typeof input.cursor !== 'string' || input.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) invalid('Start from the newest correction.');
          const v = JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
          if (!v || Object.keys(v).sort().join(',') !== 'account_payment_id,at,id' || v.account_payment_id !== id || !Number.isSafeInteger(v.at) || v.at < 0) invalid('Start from the newest correction.');anchor = { at: v.at,id: uuid(v.id) };
        } catch { invalid('Start from the newest correction.'); }
      }
      const rows = deps.db.prepare(`SELECT * FROM customer_account_payment_corrections WHERE account_payment_id=? ${anchor ? 'AND (created_at<? OR (created_at=? AND correction_id>?))' : ''}
        ORDER BY created_at DESC,correction_id LIMIT ?`).all(id,...(anchor ? [anchor.at,anchor.at,anchor.id] : []),limit+1) as Row[];
      const page = rows.slice(0,limit);const corrections: CustomerAccountPaymentCorrectionRecord[] = [];
      for (const row of page) { const p = await open(row);corrections.push(entry(fresh(row),p)); }
      const last = page.at(-1);return { corrections,...(rows.length > limit && last ? { next_cursor: Buffer.from(JSON.stringify({ account_payment_id: id,at: last.created_at,id: last.correction_id })).toString('base64url') } : {}) };
    },
  };
};
export type CustomerAccountPaymentCorrectionService = ReturnType<typeof createCustomerAccountPaymentCorrectionService>;
