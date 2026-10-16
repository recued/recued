import { customerRefundBalanceFields } from '@recued/contracts';
import type { CustomerCreditCorrectionPrepareInput,CustomerCreditCorrectionApplyInput,CustomerCreditCorrectionApplyResult,CustomerCreditCorrectionRecord,CustomerCreditCorrectionPreview,CustomerCreditCorrectionHistoryInput,CustomerCreditCorrectionHistory } from '@recued/contracts';
import { createHash,randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CustomerInvoiceCreditPrepareInput,CustomerInvoiceCreditApplyInput,CustomerInvoiceCreditApplyResult,
  CustomerInvoiceCreditRecord,CustomerInvoiceCreditPreview,CustomerInvoiceCreditHistoryInput,CustomerInvoiceCreditHistory,
  CustomerInvoiceCreditCopyInput,CustomerInvoiceCreditCopy,CustomerInvoiceCreditEntry,RecordsFriendlyRecord,StepMeta } from '@recued/contracts';
import { QuoteSignoffError,type QuoteSignoffService } from './quote-signoff-service.js';
import type { RecordsStore } from './records/store.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
const OWNER = { publisher: 'recued-core',pack_slug: 'invoice-book' };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string): never => { throw new QuoteSignoffError('customer_credit_invalid',message,400); };
const stale = (): never => { throw new QuoteSignoffError('customer_credit_stale','The invoice, payments or credits changed. Refresh payment history and preview again.'); };
const uuid = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) ? value : invalid('Choose a released invoice and preview a credit.');
const units = (value: string) => BigInt(value.replace('.',''));
const decimal = (value: bigint) => `${value / 10_000n}.${String(value % 10_000n).padStart(4,'0')}`;
const money = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 24 || !/^\d+(?:\.\d{1,4})?$/.test(value)) invalid('Enter a positive credit with up to four decimal places.');
  const [whole,fraction = ''] = (value as string).split('.');const amount = BigInt(whole!)*10_000n+BigInt(fraction.padEnd(4,'0'));
  if (amount <= 0n || amount > 9_223_372_036_854_775_807n) invalid('The credit amount is outside Invoice Book’s exact range.');
  return decimal(amount);
};
const date = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+'T00:00:00Z'))
    || new Date(value+'T00:00:00Z').toISOString().slice(0,10) !== value) invalid('Choose a valid credit date.');
  return value as string;
};
interface Plan { request: CustomerInvoiceCreditPrepareInput;snapshot_hash: string;write_hash: string;credit: CustomerInvoiceCreditRecord }
interface Row { credit_id: string;request_key: string;signoff_id: string;plan_hash: string;plan_ciphertext: string;created_at: number;applied_at: number | null;run_id: string | null;actor: string | null;applied_credit_hash: string | null }
interface CorrectionRow {
  correction_id: string;request_key: string;signoff_id: string;credit_id: string;plan_hash: string;
  plan_ciphertext: string;created_at: number;applied_at: number | null;run_id: string | null;actor: string | null;applied_reversal_hash: string | null;
}
interface CorrectionPlan {
  request: CustomerCreditCorrectionPrepareInput;snapshot_hash: string;write_hash: string;
  original_identity: string;original_plan_hash: string;correction: CustomerCreditCorrectionRecord;
}
const correctionSummary = (entry: CustomerCreditCorrectionRecord): string => [
  `Reverse credit ${entry.before.credit_ref} on invoice ${entry.invoice_ref}.`,
  `Original credit: ${entry.before.amount} ${entry.currency}, issued ${entry.before.issued_on}.`,
  `Reverse on: ${entry.reversed_on}. Reason shown on customer copies: ${entry.reason}`,
  ...(entry.replacement ? [`Replacement credit: ${entry.replacement.credit_ref}, ${entry.replacement.amount} ${entry.currency}, issued ${entry.replacement.issued_on}.`,
    `Replacement reason shown on the customer copy: ${entry.replacement.reason}`] : ['No replacement credit.']),
  `Recorded paid stays ${entry.before_balance.amount_paid} ${entry.currency}.`,
  `Net credits: ${entry.before_balance.amount_credited} → ${entry.after_balance.amount_credited} ${entry.currency}.`,
  `Outstanding: ${entry.before_balance.outstanding} → ${entry.after_balance.outstanding} ${entry.currency}.`,
  `Invoice status: ${entry.before_balance.status} → ${entry.after_balance.status}.`,
  'Keep the original credit, invoice total, payment entries and agreed work. Save a linked reversal. Clear cash-payment timing fields.',
  'This corrects a recorded credit after owner review. It records no payment or refund.',
].join('\n');
const summary = (credit: CustomerInvoiceCreditRecord): string => [
  `Issue invoice credit ${credit.credit_ref} on invoice ${credit.invoice_ref}.`,
  `Credit: ${credit.amount} ${credit.currency} · ${credit.issued_on}.`,
  `Recorded paid stays ${credit.before_balance.amount_paid} ${credit.currency}.`,
  `Credits: ${credit.before_balance.amount_credited} → ${credit.after_balance.amount_credited} ${credit.currency}.`,
  `Outstanding: ${credit.before_balance.outstanding} → ${credit.after_balance.outstanding} ${credit.currency}.`,
  `Invoice status: ${credit.before_balance.status} → ${credit.after_balance.status}.`,
  'Keep the original invoice total, payment entries and agreed work. Clear cash-payment timing fields.',
  `Reason shown on the customer copy: ${credit.reason}`,
  'This records an invoice credit after owner review. It records no payment or refund.',
].join('\n');
export const createCustomerInvoiceCreditService = (deps: { db: Database.Database;records: RecordsStore;signoffs: QuoteSignoffService;codec: PreapprovalCodec;now: () => number }) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_invoice_credits (
    credit_id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,signoff_id TEXT NOT NULL,plan_hash TEXT NOT NULL,
    plan_ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL,applied_at INTEGER,run_id TEXT,actor TEXT,applied_credit_hash TEXT
  ); CREATE INDEX IF NOT EXISTS customer_invoice_credits_history ON customer_invoice_credits(signoff_id,created_at DESC,credit_id);
  CREATE INDEX IF NOT EXISTS core_record_outbox_credit_identity_idx ON core_record_outbox(publisher,pack_slug,pk) WHERE kind='credit_note';`);
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_credit_corrections (
    correction_id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,signoff_id TEXT NOT NULL,credit_id TEXT NOT NULL,
    plan_hash TEXT NOT NULL,plan_ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL,applied_at INTEGER,run_id TEXT,actor TEXT,applied_reversal_hash TEXT
  ); CREATE INDEX IF NOT EXISTS customer_credit_corrections_history ON customer_credit_corrections(signoff_id,created_at DESC,correction_id);
  CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_corrections_applied ON customer_credit_corrections(credit_id) WHERE applied_at IS NOT NULL;`);
  if (!deps.db.prepare("SELECT 1 FROM pragma_table_info('customer_credit_corrections') WHERE name='applied_reversal_hash'").get()) {
    deps.db.exec('ALTER TABLE customer_credit_corrections ADD COLUMN applied_reversal_hash TEXT');
  }
  // A namespace purge can reset counts and same-clock row metadata. Keep an event identity too.
  const creditIdentity = (id: string) => hash({ record: deps.records.ownerGet(OWNER,'credit_note',id),
    changes: deps.db.prepare("SELECT count(*) AS n,max(event_id) AS event_id FROM core_record_outbox WHERE publisher=? AND pack_slug=? AND kind='credit_note' AND pk=?").get(OWNER.publisher,OWNER.pack_slug,id) });
  const matchesCreditIdentity = (id: string,expected: string | null): boolean => {
    if (expected === creditIdentity(id)) return true;
    const record = deps.records.ownerGet(OWNER,'credit_note',id);
    if (!record || ![7,8,9].includes(record._record.version)) return false;
    const changes = deps.db.prepare("SELECT count(*) AS n,max(event_id) AS event_id FROM core_record_outbox WHERE publisher=? AND pack_slug=? AND kind='credit_note' AND pk=?").get(OWNER.publisher,OWNER.pack_slug,id);
    for (const version of [8,7,6]) {
      if (version>=record._record.version) continue;
      const legacy: RecordsFriendlyRecord={ ...record,_record: { ...record._record,version } };
      if (version===6) { if (record.replaces_credit_ref != null) continue;delete legacy.replaces_credit_ref; }
      if (expected===hash({ record: legacy,changes })) return true;
    }
    return false;
  };
  const rowFor = (id: string) => deps.db.prepare('SELECT * FROM customer_invoice_credits WHERE credit_id=?').get(id) as Row | undefined;
  const currentRow = (row: Row): Row => {
    const fresh = rowFor(row.credit_id);
    if (!fresh || ['request_key','signoff_id','plan_hash','plan_ciphertext','created_at'].some(key => fresh[key as keyof Row] !== row[key as keyof Row])) return stale();
    return fresh;
  };
  const open = async (row: Row): Promise<Plan> => {
    deps.codec.assertUnlocked();const value = await deps.codec.open(row.plan_ciphertext);deps.codec.assertUnlocked();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return stale();const plan = value as Plan;
    if (hash(plan) !== row.plan_hash || plan.credit?.credit_id !== row.credit_id || plan.credit.signoff_id !== row.signoff_id
      || plan.request.signoff_id !== row.signoff_id || plan.credit.prepared_at !== row.created_at) return stale();
    currentRow(row);return plan;
  };
  const entry = (row: Row,plan: Plan): CustomerInvoiceCreditRecord => ({ ...plan.credit,applied_at: row.applied_at,...(row.run_id ? { run_id: row.run_id } : {}),...(row.actor ? { actor: row.actor } : {}) });
  const preview = (row: Row,plan: Plan): CustomerInvoiceCreditPreview => ({ credit: entry(row,plan),review: { credit_id: row.credit_id,expected_plan_hash: row.plan_hash,summary: summary(plan.credit) } });
  const requireCurrent = (plan: Plan) => {
    deps.codec.assertUnlocked();const base = deps.signoffs.invoiceCreditSnapshot(plan.credit.signoff_id);
    if (base.history.snapshot_hash !== plan.snapshot_hash || base.write_hash !== plan.write_hash) return stale();return base;
  };
  const correctionRowFor = (id: string) => deps.db.prepare('SELECT * FROM customer_credit_corrections WHERE correction_id=?').get(id) as CorrectionRow | undefined;
  const appliedCorrectionFor = (credit_id: string) => deps.db.prepare('SELECT * FROM customer_credit_corrections WHERE credit_id=? AND applied_at IS NOT NULL').get(credit_id) as CorrectionRow | undefined;
  const reversalIdentity = (id: string) => hash({ record: deps.records.ownerGet(OWNER,'credit_reversal',id),
    changes: deps.db.prepare("SELECT count(*) AS n,max(event_id) AS event_id FROM core_record_outbox WHERE publisher=? AND pack_slug=? AND kind='credit_reversal' AND pk=?").get(OWNER.publisher,OWNER.pack_slug,id) });
  const matchesReversalIdentity = (id: string,expected: string | null) => {
    if (expected===reversalIdentity(id)) return true;
    const record=deps.records.ownerGet(OWNER,'credit_reversal',id);if (!record || ![8,9].includes(record._record.version)) return false;
    const changes=deps.db.prepare("SELECT count(*) AS n,max(event_id) AS event_id FROM core_record_outbox WHERE publisher=? AND pack_slug=? AND kind='credit_reversal' AND pk=?").get(OWNER.publisher,OWNER.pack_slug,id);
    return [8,7].filter(version=>version<record._record.version).some(version=>expected===hash({ record: { ...record,_record: { ...record._record,version } },changes }));
  };
  const assertReversalIdentity = (credit: CustomerInvoiceCreditEntry,signoff_id: string) => {
    const applied = appliedCorrectionFor(credit.credit_id);
    if (!applied && !credit.reversal) return;
    if (!applied || !credit.reversal || applied.signoff_id !== signoff_id || applied.correction_id !== credit.reversal.correction_id
      || !applied.applied_reversal_hash || !matchesReversalIdentity(applied.correction_id,applied.applied_reversal_hash)) return stale();
  };
  const currentCorrectionRow = (row: CorrectionRow) => {
    const fresh = correctionRowFor(row.correction_id);
    if (!fresh || ['request_key','signoff_id','credit_id','plan_hash','plan_ciphertext','created_at'].some(key => fresh[key as keyof CorrectionRow] !== row[key as keyof CorrectionRow])) return stale();
    return fresh;
  };
  const openCorrection = async (row: CorrectionRow): Promise<CorrectionPlan> => {
    deps.codec.assertUnlocked();const value = await deps.codec.open(row.plan_ciphertext);deps.codec.assertUnlocked();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return stale();const plan = value as CorrectionPlan;
    if (hash(plan) !== row.plan_hash || plan.correction?.correction_id !== row.correction_id || plan.correction.signoff_id !== row.signoff_id
      || plan.correction.before.credit_id !== row.credit_id || plan.request.signoff_id !== row.signoff_id || plan.request.credit_id !== row.credit_id
      || plan.correction.prepared_at !== row.created_at) return stale();
    currentCorrectionRow(row);return plan;
  };
  const correctionEntry = (row: CorrectionRow,plan: CorrectionPlan): CustomerCreditCorrectionRecord => ({ ...plan.correction,
    applied_at: row.applied_at,...(row.run_id ? { run_id: row.run_id } : {}),...(row.actor ? { actor: row.actor } : {}),
    replacement: plan.correction.replacement ? { ...plan.correction.replacement,applied_at: row.applied_at,
      ...(row.run_id ? { run_id: row.run_id } : {}),...(row.actor ? { actor: row.actor } : {}) } : null });
  const correctionPreview = (row: CorrectionRow,plan: CorrectionPlan): CustomerCreditCorrectionPreview => ({ correction: correctionEntry(row,plan),
    review: { correction_id: row.correction_id,expected_plan_hash: row.plan_hash,summary: correctionSummary(plan.correction) } });
  const requireCorrectionCurrent = (plan: CorrectionPlan) => {
    deps.codec.assertUnlocked();const base = deps.signoffs.invoiceCreditCorrectionSnapshot(plan.request.signoff_id,plan.request.credit_id);
    const original = rowFor(plan.request.credit_id);
    if (appliedCorrectionFor(plan.request.credit_id)) return stale();
    if (base.history.snapshot_hash !== plan.snapshot_hash || base.write_hash !== plan.write_hash || !original || original.applied_at === null
      || original.signoff_id !== plan.request.signoff_id || original.plan_hash !== plan.original_plan_hash
      || original.applied_credit_hash !== plan.original_identity || !matchesCreditIdentity(original.credit_id,plan.original_identity)) return stale();
    assertCreditAncestry(base.credit,base.history.signoff_id,base.history.credit_notes ?? []);
    if (plan.correction.replacement && (base.history.credit_notes?.length ?? 0) >= 1000) {
      throw new QuoteSignoffError('customer_credit_limit','This invoice already has 1,000 credits. Reverse the credit without a replacement, or review its history in Records.');
    }
    return base;
  };
  const creditFields = (credit: CustomerInvoiceCreditEntry): CustomerInvoiceCreditEntry => ({ credit_id: credit.credit_id,credit_ref: credit.credit_ref,
    amount: credit.amount,issued_on: credit.issued_on,reason: credit.reason,...(credit.replaces_credit_id ? { replaces_credit_id: credit.replaces_credit_id } : {}) });
  const assertCreditAncestry = (credit: CustomerInvoiceCreditEntry,signoff_id: string,ledger: CustomerInvoiceCreditEntry[]) => {
    const byId = new Map(ledger.map(entry => [entry.credit_id,entry]));const visited = new Set<string>();let current = credit;
    while (true) {
      if (visited.has(current.credit_id)) return stale();visited.add(current.credit_id);
      const issued = rowFor(current.credit_id);
      if (!issued || issued.signoff_id !== signoff_id || issued.applied_at === null || !matchesCreditIdentity(current.credit_id,issued.applied_credit_hash)) return stale();
      assertReversalIdentity(current,signoff_id);
      if (!current.replaces_credit_id) return;
      const predecessor = byId.get(current.replaces_credit_id);
      if (!predecessor || predecessor.reversal?.replacement_credit_id !== current.credit_id) return stale();
      current = predecessor;
    }
  };
  return {
    async prepare(input: CustomerInvoiceCreditPrepareInput,prepared_by: string): Promise<CustomerInvoiceCreditPreview> {
      deps.codec.assertUnlocked();uuid(input.request_key);uuid(input.signoff_id);
      if (typeof prepared_by !== 'string' || !prepared_by || prepared_by.length > 512) invalid('A paired owner client is required.');
      if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 1000 || /[\u0000\r]/.test(input.reason)) invalid('Enter a credit reason of up to 1,000 characters.');
      if (typeof input.expected_snapshot_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_snapshot_hash)) return stale();
      const request: CustomerInvoiceCreditPrepareInput = { request_key: input.request_key,signoff_id: input.signoff_id,expected_snapshot_hash: input.expected_snapshot_hash,
        amount: money(input.amount),issued_on: date(input.issued_on),reason: input.reason.trim() };
      const key = hash([prepared_by,request.request_key]);
      const replay = deps.db.prepare('SELECT * FROM customer_invoice_credits WHERE request_key=?').get(key) as Row | undefined;
      if (replay) {
        const plan = await open(replay);if (hash(plan.request) !== hash(request)) invalid('This preview key was used for different credit fields. Preview again.');
        const fresh = currentRow(replay);if (fresh.applied_at === null) requireCurrent(plan);return preview(fresh,plan);
      }
      const saved = deps.db.transaction(() => {
        const base = deps.signoffs.invoiceCreditSnapshot(request.signoff_id);const history = base.history;
        if (history.snapshot_hash !== request.expected_snapshot_hash || history.invoice.availability !== 'current') return stale();
        if (units(request.amount) > units(history.invoice.outstanding)) invalid('A credit cannot exceed the unpaid balance. Paid amounts need a refund workflow.');
        const credit_id = randomUUID();const amount_credited = decimal(units(history.invoice.amount_credited ?? '0.0000')+units(request.amount));
        const outstanding = decimal(units(history.invoice.outstanding)-units(request.amount));
        const credit: CustomerInvoiceCreditRecord = { credit_id,credit_ref: 'CR-'+credit_id,amount: request.amount,issued_on: request.issued_on,reason: request.reason,
          signoff_id: history.signoff_id,invoice_id: history.invoice_id,invoice_ref: history.invoice_ref,currency: history.currency,
          before_balance: { amount_paid: history.invoice.amount_paid,amount_credited: history.invoice.amount_credited ?? '0.0000',outstanding: history.invoice.outstanding,status: 'open' },
          after_balance: { amount_paid: history.invoice.amount_paid,amount_credited,outstanding,status: outstanding === '0.0000' ? 'credited' : 'open' },prepared_at: deps.now(),prepared_by,applied_at: null };
        const plan: Plan = { request,snapshot_hash: history.snapshot_hash!,write_hash: base.write_hash,credit };const plan_hash = hash(plan);const ciphertext = deps.codec.sealSync(plan);requireCurrent(plan);
        deps.db.prepare(`INSERT INTO customer_invoice_credits (credit_id,request_key,signoff_id,plan_hash,plan_ciphertext,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING`)
          .run(credit_id,key,credit.signoff_id,plan_hash,ciphertext,credit.prepared_at);
        const row = deps.db.prepare('SELECT * FROM customer_invoice_credits WHERE request_key=?').get(key) as Row | undefined;if (!row) return stale();
        return { row,plan: row.credit_id === credit_id ? plan : null };
      }).immediate();
      if (saved.plan) return preview(saved.row,saved.plan);const winner = await open(saved.row);
      if (hash(winner.request) !== hash(request)) invalid('This preview key was used for different credit fields. Preview again.');
      const fresh = currentRow(saved.row);if (fresh.applied_at === null) requireCurrent(winner);return preview(fresh,winner);
    },
    async apply(input: CustomerInvoiceCreditApplyInput,meta?: StepMeta): Promise<CustomerInvoiceCreditApplyResult> {
      const row = rowFor(uuid(input.credit_id));if (!row) return stale();const plan = await open(row);
      if (input.expected_plan_hash !== row.plan_hash || input.summary !== summary(plan.credit)) return stale();
      return deps.db.transaction(() => {
        deps.codec.assertUnlocked();const fresh = currentRow(row);const credit = plan.credit;
        const result = (already_applied: boolean): CustomerInvoiceCreditApplyResult => ({ credit_id: row.credit_id,signoff_id: row.signoff_id,invoice_id: credit.invoice_id,already_applied });
        if (fresh.applied_at !== null) return result(true);const base = requireCurrent(plan);const invoice = base.invoice;const appliedAt = deps.now();
        deps.records.execute({ binding: base.credit_binding,principal: 'owner',args: { id: credit.credit_id,values: { invoice_ref: `invoice/${credit.invoice_id}`,
          credit_ref: credit.credit_ref,currency: credit.currency,amount: credit.amount,issued_on: credit.issued_on,reason: credit.reason,recorded_at: new Date(appliedAt).toISOString() } } });
        deps.records.execute({ binding: base.invoice_binding,principal: 'owner',args: { id: invoice.id,expected_version: invoice._record.version,expected_revision: invoice._record.revision,
          set: { amount_credited: credit.after_balance.amount_credited,outstanding: credit.after_balance.outstanding,status: credit.after_balance.status },unset: ['settled_on','days_late','paid_on_time'] } });
        deps.db.prepare('UPDATE customer_invoice_credits SET applied_at=?,run_id=?,actor=?,applied_credit_hash=? WHERE credit_id=? AND applied_at IS NULL').run(appliedAt,meta?.run_id ?? null,meta?.actor ?? null,creditIdentity(row.credit_id),row.credit_id);
        return result(false);
      }).immediate();
    },
    async history(input: CustomerInvoiceCreditHistoryInput): Promise<CustomerInvoiceCreditHistory> {
      deps.codec.assertUnlocked();const id = uuid(input.signoff_id);const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Credit history limit must be 1–100.');let anchor: { at: number;id: string } | undefined;
      if (input.cursor !== undefined) {
        try {
          if (typeof input.cursor !== 'string' || input.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) invalid('Start from the newest credits.');
          const value = JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
          if (!value || Object.keys(value).sort().join(',') !== 'at,id,signoff_id' || value.signoff_id !== id || !Number.isSafeInteger(value.at) || value.at < 0) invalid('Start from the newest credits.');
          anchor = { at: value.at,id: uuid(value.id) };
        } catch { invalid('Start from the newest credits.'); }
      }
      const rows = deps.db.prepare(`SELECT * FROM customer_invoice_credits WHERE signoff_id=? ${anchor ? 'AND (created_at<? OR (created_at=? AND credit_id>?))' : ''} ORDER BY created_at DESC,credit_id LIMIT ?`)
        .all(id,...(anchor ? [anchor.at,anchor.at,anchor.id] : []),limit+1) as Row[];
      const opened: Array<{ row: Row;plan: Plan }> = [];for (const row of rows.slice(0,limit)) opened.push({ row,plan: await open(row) });
      deps.codec.assertUnlocked();let ledger: CustomerInvoiceCreditEntry[] = [];
      try { const current = deps.signoffs.paymentHistorySnapshot(id);if (current.consistency === 'matched') ledger = current.credit_notes ?? []; }
      catch (error) { if (!(error instanceof QuoteSignoffError)) throw error; }
      const credits = opened.map(({ row,plan }) => {
        const fresh = currentRow(row);const value = entry(fresh,plan);const current = ledger.find(credit => credit.credit_id === row.credit_id);
        return current?.reversal && fresh.applied_at !== null && matchesCreditIdentity(row.credit_id,fresh.applied_credit_hash)
          ? { ...value,reversal: current.reversal } : value;
      });
      const last = rows[Math.min(rows.length,limit)-1];return { credits,...(last && rows.length > limit ? { next_cursor: Buffer.from(JSON.stringify({ signoff_id: id,at: last.created_at,id: last.credit_id })).toString('base64url') } : {}) };
    },
    async prepareCorrection(input: CustomerCreditCorrectionPrepareInput,prepared_by: string): Promise<CustomerCreditCorrectionPreview> {
      deps.codec.assertUnlocked();uuid(input.request_key);uuid(input.signoff_id);uuid(input.credit_id);
      if (typeof prepared_by !== 'string' || !prepared_by || prepared_by.length > 512) invalid('A paired owner client is required.');
      if (!['reverse','replace'].includes(input.action)) invalid('Choose whether to reverse or replace this credit.');
      const text = (value: unknown): string => typeof value === 'string' && value.trim() && value.trim().length <= 1000 && !/[\u0000\r]/.test(value)
        ? value.trim() : invalid('Enter a reason of up to 1,000 characters, shown on customer copies.');
      if (typeof input.expected_snapshot_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_snapshot_hash)) return stale();
      if (input.action === 'reverse' && [input.amount,input.issued_on,input.replacement_reason].some(value => value !== undefined)) invalid('A reversal cannot also contain replacement fields.');
      const request: CustomerCreditCorrectionPrepareInput = { request_key: input.request_key,signoff_id: input.signoff_id,credit_id: input.credit_id,
        expected_snapshot_hash: input.expected_snapshot_hash,action: input.action,reason: text(input.reason),reversed_on: date(input.reversed_on),
        ...(input.action === 'replace' ? { amount: money(input.amount),issued_on: date(input.issued_on),replacement_reason: text(input.replacement_reason) } : {}) };
      const key = hash([prepared_by,request.request_key]);
      const replay = deps.db.prepare('SELECT * FROM customer_credit_corrections WHERE request_key=?').get(key) as CorrectionRow | undefined;
      if (replay) {
        const plan = await openCorrection(replay);if (hash(plan.request) !== hash(request)) invalid('This preview key was used for different correction fields. Preview again.');
        const fresh = currentCorrectionRow(replay);if (fresh.applied_at === null) requireCorrectionCurrent(plan);return correctionPreview(fresh,plan);
      }
      const originalRow = rowFor(request.credit_id);if (!originalRow || originalRow.signoff_id !== request.signoff_id) return stale();
      const originalPlan = await open(originalRow);
      const saved = deps.db.transaction(() => {
        const original = currentRow(originalRow);if (appliedCorrectionFor(request.credit_id)) return stale();const base = deps.signoffs.invoiceCreditCorrectionSnapshot(request.signoff_id,request.credit_id);const history = base.history;
        if (original.applied_at === null || !matchesCreditIdentity(original.credit_id,original.applied_credit_hash)
          || history.snapshot_hash !== request.expected_snapshot_hash || history.invoice.availability !== 'current'
          || hash(creditFields(base.credit)) !== hash(creditFields(originalPlan.credit))) return stale();
        if (request.action === 'replace' && request.amount === base.credit.amount && request.issued_on === base.credit.issued_on && request.replacement_reason === base.credit.reason) invalid('Change a credit field before previewing a replacement.');
        const restored = units(history.invoice.outstanding)+units(base.credit.amount);
        const replacementAmount = request.action === 'replace' ? units(request.amount!) : 0n;
        if (replacementAmount > restored) invalid('The replacement credit cannot exceed the restored unpaid balance.');
        const net = units(history.invoice.amount_credited ?? '0.0000')-units(base.credit.amount);
        const after_balance = { amount_paid: history.invoice.amount_paid,amount_credited: decimal(net+replacementAmount),outstanding: decimal(restored-replacementAmount),status: restored === replacementAmount ? 'credited' as const : 'open' as const };
        const preparedAt = deps.now();const correction_id = randomUUID();const replacementId = randomUUID();
        const replacement: CustomerInvoiceCreditRecord | null = request.action === 'replace' ? { credit_id: replacementId,credit_ref: 'CR-'+replacementId,amount: request.amount!,issued_on: request.issued_on!,reason: request.replacement_reason!,
          replaces_credit_id: base.credit.credit_id,signoff_id: history.signoff_id,invoice_id: history.invoice_id,invoice_ref: history.invoice_ref,currency: history.currency,
          before_balance: { amount_paid: history.invoice.amount_paid,amount_credited: decimal(net),outstanding: decimal(restored),status: 'open' },after_balance,
          prepared_at: preparedAt,prepared_by,applied_at: null } : null;
        const correction: CustomerCreditCorrectionRecord = { correction_id,signoff_id: history.signoff_id,invoice_id: history.invoice_id,invoice_ref: history.invoice_ref,currency: history.currency,
          action: request.action,reason: request.reason,reversed_on: request.reversed_on,before: creditFields(base.credit),replacement,
          before_balance: { amount_paid: history.invoice.amount_paid,amount_credited: history.invoice.amount_credited ?? '0.0000',outstanding: history.invoice.outstanding,status: history.invoice.status === 'credited' ? 'credited' : 'open' },after_balance,
          prepared_at: preparedAt,prepared_by,applied_at: null };
        const plan: CorrectionPlan = { request,snapshot_hash: history.snapshot_hash!,write_hash: base.write_hash,original_identity: original.applied_credit_hash!,original_plan_hash: original.plan_hash,correction };
        const planHash = hash(plan);const ciphertext = deps.codec.sealSync(plan);requireCorrectionCurrent(plan);
        deps.db.prepare('INSERT INTO customer_credit_corrections (correction_id,request_key,signoff_id,credit_id,plan_hash,plan_ciphertext,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING')
          .run(correction_id,key,history.signoff_id,base.credit.credit_id,planHash,ciphertext,preparedAt);
        const row = deps.db.prepare('SELECT * FROM customer_credit_corrections WHERE request_key=?').get(key) as CorrectionRow | undefined;if (!row) return stale();
        return { row,plan: row.correction_id === correction_id ? plan : null };
      }).immediate();
      if (saved.plan) return correctionPreview(saved.row,saved.plan);const winner = await openCorrection(saved.row);
      if (hash(winner.request) !== hash(request)) invalid('This preview key was used for different correction fields. Preview again.');
      const fresh = currentCorrectionRow(saved.row);if (fresh.applied_at === null) requireCorrectionCurrent(winner);return correctionPreview(fresh,winner);
    },
    async applyCorrection(input: CustomerCreditCorrectionApplyInput,meta?: StepMeta): Promise<CustomerCreditCorrectionApplyResult> {
      const row = correctionRowFor(uuid(input.correction_id));if (!row) return stale();const plan = await openCorrection(row);
      if (input.expected_plan_hash !== row.plan_hash || input.summary !== correctionSummary(plan.correction)) return stale();
      return deps.db.transaction(() => {
        deps.codec.assertUnlocked();const fresh = currentCorrectionRow(row);const correction = plan.correction;const replacement = correction.replacement;
        const result = (already_applied: boolean): CustomerCreditCorrectionApplyResult => ({ correction_id: row.correction_id,signoff_id: row.signoff_id,credit_id: row.credit_id,invoice_id: correction.invoice_id,
          ...(replacement ? { replacement_credit_id: replacement.credit_id } : {}),already_applied });
        if (fresh.applied_at !== null) return result(true);const base = requireCorrectionCurrent(plan);const invoice = base.invoice;const appliedAt = deps.now();
        if (replacement) {
          deps.records.execute({ binding: base.credit_binding,principal: 'owner',args: { id: replacement.credit_id,values: { invoice_ref: 'invoice/'+invoice.id,replaces_credit_ref: 'credit_note/'+row.credit_id,
            credit_ref: replacement.credit_ref,currency: replacement.currency,amount: replacement.amount,issued_on: replacement.issued_on,reason: replacement.reason,recorded_at: new Date(appliedAt).toISOString() } } });
          // The replacement is issued by this same reviewed transaction, never as a second pending preview.
          const issuedPlan: Plan = { request: { request_key: row.correction_id,signoff_id: row.signoff_id,expected_snapshot_hash: plan.snapshot_hash,amount: replacement.amount,issued_on: replacement.issued_on,reason: replacement.reason },
            snapshot_hash: plan.snapshot_hash,write_hash: hash({ invoice_binding: base.invoice_binding,credit_binding: base.credit_binding }),credit: replacement };
          deps.db.prepare('INSERT INTO customer_invoice_credits (credit_id,request_key,signoff_id,plan_hash,plan_ciphertext,created_at,applied_at,run_id,actor,applied_credit_hash) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(replacement.credit_id,hash({ replacement_of: row.correction_id }),row.signoff_id,hash(issuedPlan),deps.codec.sealSync(issuedPlan),replacement.prepared_at,appliedAt,meta?.run_id ?? null,meta?.actor ?? null,creditIdentity(replacement.credit_id));
        }
        deps.records.execute({ binding: base.reversal_binding,principal: 'owner',args: { id: row.correction_id,values: { invoice_ref: 'invoice/'+invoice.id,credit_ref: 'credit_note/'+row.credit_id,
          reversal_ref: 'CRV-'+row.correction_id,currency: correction.currency,amount: correction.before.amount,reason: correction.reason,reversed_on: correction.reversed_on,
          ...(replacement ? { replacement_ref: 'credit_note/'+replacement.credit_id } : {}),recorded_at: new Date(appliedAt).toISOString() } } });
        const invoiceSet = { amount_credited: correction.after_balance.amount_credited,outstanding: correction.after_balance.outstanding,status: correction.after_balance.status };
        const invoiceUnset = ['settled_on','days_late','paid_on_time'];
        // A reason/date-only replacement leaves the balance unchanged; Records refuses empty updates.
        if (Object.entries(invoiceSet).some(([key,value]) => invoice[key] !== value) || invoiceUnset.some(key => invoice[key] != null)) {
          deps.records.execute({ binding: base.invoice_binding,principal: 'owner',args: { id: invoice.id,expected_version: invoice._record.version,expected_revision: invoice._record.revision,set: invoiceSet,unset: invoiceUnset } });
        }
        deps.db.prepare('UPDATE customer_credit_corrections SET applied_at=?,run_id=?,actor=?,applied_reversal_hash=? WHERE correction_id=? AND applied_at IS NULL').run(appliedAt,meta?.run_id ?? null,meta?.actor ?? null,reversalIdentity(row.correction_id),row.correction_id);
        return result(false);
      }).immediate();
    },
    async correctionHistory(input: CustomerCreditCorrectionHistoryInput): Promise<CustomerCreditCorrectionHistory> {
      deps.codec.assertUnlocked();const id = uuid(input.signoff_id);const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Credit correction history limit must be 1–100.');let anchor: { at: number;id: string } | undefined;
      if (input.cursor !== undefined) {
        try {
          if (typeof input.cursor !== 'string' || input.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) invalid('Start from the newest credit corrections.');
          const value = JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
          if (!value || Object.keys(value).sort().join(',') !== 'at,id,signoff_id' || value.signoff_id !== id || !Number.isSafeInteger(value.at) || value.at < 0) invalid('Start from the newest credit corrections.');
          anchor = { at: value.at,id: uuid(value.id) };
        } catch { invalid('Start from the newest credit corrections.'); }
      }
      const rows = deps.db.prepare(`SELECT * FROM customer_credit_corrections WHERE signoff_id=? ${anchor ? 'AND (created_at<? OR (created_at=? AND correction_id>?))' : ''} ORDER BY created_at DESC,correction_id LIMIT ?`)
        .all(id,...(anchor ? [anchor.at,anchor.at,anchor.id] : []),limit+1) as CorrectionRow[];
      const opened: Array<{ row: CorrectionRow;plan: CorrectionPlan }> = [];for (const row of rows.slice(0,limit)) opened.push({ row,plan: await openCorrection(row) });
      const corrections = opened.map(({ row,plan }) => correctionEntry(currentCorrectionRow(row),plan));
      const last = rows[Math.min(rows.length,limit)-1];return { corrections,...(last && rows.length > limit ? { next_cursor: Buffer.from(JSON.stringify({ signoff_id: id,at: last.created_at,id: last.correction_id })).toString('base64url') } : {}) };
    },
    async copy(input: CustomerInvoiceCreditCopyInput): Promise<CustomerInvoiceCreditCopy> {
      uuid(input.signoff_id);const row = rowFor(uuid(input.credit_id));if (!row || row.signoff_id !== input.signoff_id) return stale();const plan = await open(row);
      return deps.db.transaction((): CustomerInvoiceCreditCopy => {
      deps.codec.assertUnlocked();const fresh = currentRow(row);
      if (fresh.applied_at === null) invalid('This credit has not been issued. Review it in Runs first.');
      if (!matchesCreditIdentity(row.credit_id,fresh.applied_credit_hash)) return stale();
      const history = deps.signoffs.paymentHistorySnapshot(input.signoff_id);const credit = history.credit_notes?.find(entry => entry.credit_id === row.credit_id);
      const original = creditFields(plan.credit);
      if (history.consistency !== 'matched' || history.invoice.availability !== 'current' || !history.snapshot_hash || !credit || JSON.stringify(creditFields(credit)) !== JSON.stringify(original)) return stale();
      assertCreditAncestry(credit,history.signoff_id,history.credit_notes ?? []);
      return { format: 'recued.customer-invoice-credit',version: history.paid_credits?.length ? 3 : 2,captured_at: history.captured_at,copy_hash: hash([history.snapshot_hash,credit.credit_id]),
        signoff_id: history.signoff_id,invoice_id: history.invoice_id,invoice_ref: history.invoice_ref,business_name: history.business_name,customer: history.customer,currency: history.currency,
        credit,...customerRefundBalanceFields(history.invoice),invoice_total: history.total,amount_paid: history.invoice.amount_paid,amount_credited: history.invoice.amount_credited ?? '0.0000',outstanding: history.invoice.outstanding };
      })();
    },
  };
};
export type CustomerInvoiceCreditService = ReturnType<typeof createCustomerInvoiceCreditService>;
