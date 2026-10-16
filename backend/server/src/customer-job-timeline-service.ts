import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CUSTOMER_JOB_TIMELINE_CATEGORIES,type CustomerJobTimeline,type CustomerJobTimelineInput,
  type CustomerJobTimelineEvent,type CustomerJobTimelineSchedule,type CustomerPaymentCorrectionRecord } from '@recued/contracts';
import { QuoteSignoffError } from './quote-signoff-service.js';
import { captureCustomerJobs } from './customer-jobs-rpc-handler.js';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import type { RecordsStore } from './records/store.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { openApprovalIntentPiiField } from './ports/reception/approval-pii.js';
import { openCompletionResponse } from './quote-completion-rpc-handler.js';
import { createMailSendClaimStore } from './storage/mail-send-claim-store.js';
import { jobArchiveTableExists } from './storage/customer-job-archive-store.js';

const OWNER = { publisher: 'recued-core',pack_slug: 'invoice-book' };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value,(key,v) => ['captured_at','checked_at'].includes(key) ? undefined : v)).digest('hex');
const fail = (message: string,code = 'customer_job_timeline_unavailable',status = 409): never => { throw new QuoteSignoffError(code,message,status); };
const invalid = (): never => fail('Choose a job, activity filter and page size from 1 to 100.','customer_job_timeline_invalid',400);
const limit = (): never => fail('This job has too much saved activity to show completely here. Review its requests and Records.','customer_job_timeline_limit');
const stale = (): never => fail('This job’s activity changed. Refresh its timeline and start from the newest activity.','customer_job_timeline_stale');
const at = (value: number): number => Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime())
  ? value : fail('A saved activity time is unavailable. Review the job in Records.');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const MAX = 5000;

async function pages<T>(read: (cursor?: string) => Promise<{ values: T[];next_cursor?: string }>): Promise<T[]> {
  const result: T[] = [];const seen = new Set<string>();let cursor: string | undefined;
  do {
    const page = await read(cursor);result.push(...page.values);if (result.length > MAX) limit();
    cursor = page.next_cursor;if (cursor && seen.has(cursor)) fail('The complete activity history could not be read. Refresh and try again.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}

/** Read-only projection. Freeze all local evidence before decrypting, then reread it. */
export const createCustomerJobTimelineService = (deps: {
  db: Database.Database;records: RecordsStore;codec: PreapprovalCodec;now: () => number;rpc: () => ReceptionRpcDeps;
}) => ({
  async get(input: CustomerJobTimelineInput): Promise<CustomerJobTimeline> {
    if (!uuid(input.job_id)) invalid();
    const category = input.category === undefined ? 'all' : input.category;const size = input.limit === undefined ? 50 : input.limit;
    if (!CUSTOMER_JOB_TIMELINE_CATEGORIES.includes(category) || !Number.isSafeInteger(size) || size < 1 || size > 100
      || input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200 || input.search.includes('\0'))) invalid();
    const search = (input.search ?? '').trim().toLowerCase();const query = hash({ job_id: input.job_id,category,search });
    let cursor: { snapshot: string;after: string } | undefined;
    if (input.cursor !== undefined) {
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) invalid();
        const value: unknown = JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'after,query,snapshot,v'
          || !('v' in value) || value.v !== 1 || !('query' in value) || value.query !== query
          || !('snapshot' in value) || typeof value.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshot)
          || !('after' in value) || typeof value.after !== 'string' || value.after.length > 700 || value.after.includes('\0')) throw new Error('Invalid cursor');
        cursor = { snapshot: value.snapshot,after: value.after };
      } catch { invalid(); }
    }
    deps.codec.assertUnlocked();const rpc = deps.rpc();
    if (!rpc.getQuoteSignoffService || !rpc.getQuoteCompletionService || !rpc.getApprovalIntentStore
      || !rpc.getCustomerPaymentCorrectionService || !rpc.getCustomerInvoiceCreditService || !rpc.getCustomerRefundService) {
      fail('The complete job history is unavailable on this server.','not_configured',503);
    }
    const signoffs = rpc.getQuoteSignoffService!();const completions = rpc.getQuoteCompletionService!();
    const corrections = rpc.getCustomerPaymentCorrectionService!();const credits = rpc.getCustomerInvoiceCreditService!();const refunds = rpc.getCustomerRefundService!();
    const intents = rpc.getApprovalIntentStore!();const claims = createMailSendClaimStore(deps.db);
    const captured = await captureCustomerJobs(rpc,input.job_id);
    const assertCaptured = () => { try { captured.assertCurrent(); } catch (error) { if (error instanceof QuoteSignoffError && error.code === 'customer_job_closeout_stale') stale();throw error; } };
    deps.codec.assertUnlocked();assertCaptured();
    const job = captured.jobs[0];if (!job) fail('This original customer job is unavailable.','customer_job_unavailable',404);
    const readIntent = (endpoint: string | null) => endpoint ? intents.findByEndpoint(endpoint) : null;
    const frame = () => deps.db.transaction(() => {
      const ids = (deps.db.prepare(`SELECT signoff_id FROM quote_signoffs WHERE signoff_id=? OR json_extract(plan_json,'$.addition.root_signoff_id')=? ORDER BY rowid LIMIT 251`)
        .all(input.job_id,input.job_id) as Array<{ signoff_id: string }>).map(row => row.signoff_id);
      if (ids.length > 250) limit();
      if (!ids.includes(input.job_id)) fail('The original customer request is unavailable.');
      const marks = ids.map(() => '?').join(',');
      const requests = ids.map(id => {
        const value = signoffs.receipt(id,readIntent);
        if (value.receipt.root_signoff_id !== input.job_id) fail('A saved request belongs to another job.');
        return { entry: value.receipt.requests.at(-1)!,binding: value.responses.at(-1)! };
      });
      const completion = completions.receipt(ids,readIntent);
      let paymentCount = 0;
      const financial = job.invoices.map(invoice => {
        const history = signoffs.paymentHistorySnapshot(invoice.signoff_id);
        paymentCount += history.payments.length+(history.credit_notes?.length ?? 0)+(history.paid_credits?.length ?? 0)+(history.refunds?.length ?? 0);if (paymentCount > MAX) limit();
        const payments = history.consistency === 'matched' ? history.payments.map(payment => ({
          entry: payment,record: deps.records.ownerGet(OWNER,'payment',payment.payment_id),
        })) : [];
        const entries: Array<{ id: string;title: string;amount: string;date: string;label: string;state: string;record: ReturnType<RecordsStore['ownerGet']> }> = [];
        if (history.consistency === 'matched') {
          for (const credit of history.credit_notes ?? []) {
            entries.push({ id: 'credit:'+credit.credit_id,title: 'Invoice credit entry last saved',amount: credit.amount,date: credit.issued_on,label: 'Issued on',state: credit.reversal ? 'Reversed' : 'Issued',record: deps.records.ownerGet(OWNER,'credit_note',credit.credit_id) });
            if (credit.reversal) entries.push({ id: 'credit-reversal:'+credit.reversal.correction_id,title: 'Credit reversal entry last saved',amount: credit.amount,date: credit.reversal.reversed_on,label: 'Reversed on',state: 'Reversed',record: deps.records.ownerGet(OWNER,'credit_reversal',credit.reversal.correction_id) });
          }
          for (const credit of history.paid_credits ?? []) entries.push({ id: 'paid-credit:'+credit.credit_id,title: 'Paid invoice credit entry last saved',amount: credit.amount,date: credit.issued_on,label: 'Issued on',state: 'Issued',record: deps.records.ownerGet(OWNER,'paid_credit',credit.credit_id) });
          for (const refund of history.refunds ?? []) {
            entries.push({ id: 'refund:'+refund.refund_id,title: 'Refund entry last saved',amount: refund.amount,date: refund.returned_on,label: 'Returned on',state: refund.reversal ? 'Reversed' : 'Recorded outside Recued',record: deps.records.ownerGet(OWNER,'refund',refund.refund_id) });
            if (refund.reversal) entries.push({ id: 'refund-reversal:'+refund.reversal.correction_id,title: 'Refund reversal entry last saved',amount: refund.amount,date: refund.reversal.reversed_on,label: 'Reversed on',state: 'Reversed',record: deps.records.ownerGet(OWNER,'refund_reversal',refund.reversal.correction_id) });
          }
        }
        return { history,payments,entries };
      });
      if (financial.reduce((n,f) => n+f.payments.length,0) > MAX) limit();
      const journals = ['customer_payment_corrections','customer_invoice_credits','customer_credit_corrections','customer_refund_actions','customer_refund_corrections']
        .map(table => jobArchiveTableExists(deps.db,table) ? deps.db.prepare(`SELECT * FROM ${table} WHERE signoff_id IN (${marks}) ORDER BY rowid LIMIT 5001`).all(...ids) : []);
      if (journals.reduce((n,rows) => n+rows.length,0) > MAX) limit();
      const scheduleRows: Array<CustomerJobTimelineSchedule & { notified_at: number | null;drafted_at: number | null;last_draft_reference: string | null }> = [];
      for (const [table,kind] of [['quote_signoff_reminders','offer'],['quote_payment_reminders','payment']] as const) {
        if (jobArchiveTableExists(deps.db,table)) scheduleRows.push(...deps.db.prepare(`SELECT ? AS kind,signoff_id AS request_id,due_at,revision,notified_at,drafted_at,last_draft_reference FROM ${table} WHERE signoff_id IN (${marks}) ORDER BY signoff_id`).all(kind,...ids) as typeof scheduleRows);
      }
      if (jobArchiveTableExists(deps.db,'quote_completion_reminders')) scheduleRows.push(...deps.db.prepare(`SELECT 'completion' AS kind,r.completion_id AS request_id,r.due_at,r.revision,r.notified_at,r.drafted_at,r.last_draft_reference
        FROM quote_completion_reminders r JOIN quote_completion_signoffs c USING(completion_id) WHERE c.root_signoff_id=? ORDER BY r.completion_id`).all(input.job_id) as typeof scheduleRows);
      const references = new Set(scheduleRows.flatMap(row => row.last_draft_reference ? [row.last_draft_reference] : []));
      if (jobArchiveTableExists(deps.db,'customer_account_payment_reminder_invoices')) {
        const reserved = deps.db.prepare(`SELECT DISTINCT reference FROM customer_account_payment_reminder_invoices WHERE signoff_id IN (${marks}) ORDER BY reference LIMIT 5001`).all(...ids) as Array<{ reference: string }>;
        if (reserved.length > MAX) limit();reserved.forEach(row => references.add(row.reference));
      }
      const documents: Array<{ kind: string;reference: string;created_at: number;signoff_id: string | null;settings_ciphertext: string }> = [];
      for (const [table,kind] of [['customer_payment_receipt_drafts','Payment receipt'],['customer_refund_receipt_drafts','Refund or paid-credit receipt']] as const) {
        if (jobArchiveTableExists(deps.db,table)) documents.push(...deps.db.prepare(`SELECT ? AS kind,reference,created_at,signoff_id,settings_ciphertext FROM ${table} WHERE signoff_id IN (${marks}) ORDER BY reference LIMIT 5001`).all(kind,...ids) as typeof documents);
      }
      if (jobArchiveTableExists(deps.db,'customer_job_payment_statement_drafts')) documents.push(...deps.db.prepare("SELECT 'Job payment statement' AS kind,reference,created_at,NULL AS signoff_id,settings_ciphertext FROM customer_job_payment_statement_drafts WHERE job_id=? ORDER BY reference LIMIT 5001").all(input.job_id) as typeof documents);
      if (documents.length > MAX) limit();documents.forEach(row => references.add(row.reference));
      const mail = [...references].sort().map(reference => ({ reference,claim: claims.get(reference) }));
      const archive = jobArchiveTableExists(deps.db,'customer_job_archive_events') ? deps.db.prepare('SELECT revision,action,recorded_at FROM customer_job_archive_events WHERE job_id=? ORDER BY revision LIMIT 5001').all(input.job_id) as Array<{ revision: number;action: string;recorded_at: number }> : [];
      if (archive.length > MAX) limit();
      const archiveState = jobArchiveTableExists(deps.db) ? deps.db.prepare('SELECT * FROM customer_job_archives WHERE job_id=?').get(input.job_id) : null;
      const data = { requests,completion,financial,journals,scheduleRows,documents,mail,archive,archiveState,work: signoffs.jobCloseoutFingerprint(input.job_id) };
      return { ...data,stamp: hash(data) };
    })();
    const saved = frame();const capturedAt = at(deps.now());const issues: string[] = [];const events: CustomerJobTimelineEvent[] = [];
    const notes = ['Work and balances above are the saved state at capture, separate from historical activity.',
      'Older manual task edits, request cancellations and edited reminder schedules may have no saved time. Their latest state is shown with the request or saved settings.',
      'Payment, credit and refund entries show their latest saved values. Saved correction reviews keep earlier values. A business date is shown separately from the time Recued saved it.',
      'Saved email drafts and their latest send status appear here. Earlier send-status transitions are not retained.',
      'Account payments appear as invoice entries for this job. Full account payment receipts stay in Customer accounts.'];
    const add = (event: CustomerJobTimelineEvent) => {
      if (event.recorded_at !== null) at(event.recorded_at);
      events.push(event);if (events.length > MAX) limit();
    };
    const money = (amount: string,currency: string) => `${amount} ${currency}`;
    for (const { entry,binding } of saved.requests) {
      const intent = binding.snapshot;
      if (intent && intent.endpoint_id === binding.endpoint_id && intent.intent_id === binding.endpoint_id
        && intent.target_id === entry.signoff_id && intent.action_kind === 'approve_wording' && intent.consumed_at !== null) {
        entry.response.decision = 'unavailable';
        if (Number.isSafeInteger(intent.consumed_at) && intent.consumed_at >= entry.prepared_at
          && intent.consumed_at < entry.expires_at && intent.consumed_at <= capturedAt) {
          entry.response.received_at = intent.consumed_at;
          const key = rpc.getApprovalIntentPiiKey?.();
          if (key) {
            try {
              const outcome = await openApprovalIntentPiiField({ key,endpoint_id: intent.endpoint_id,intent_id: intent.intent_id,field: 'outcome',ciphertext: intent.consumed_outcome_encrypted });
              if (outcome === 'approve') entry.response.decision = 'accepted';
              else if (outcome === 'reject' || outcome?.startsWith('reject:')) entry.response.decision = 'declined';
            } catch { /* A saved processor state cannot replace a canonical reply. */ }
          }
        }
      }
      const prefix = entry.revision ? `Added work ${entry.revision}` : 'Offer';
      add({ event_id: `request:${entry.signoff_id}:prepared`,category: 'agreements',recorded_at: entry.prepared_at,title: prefix+' prepared',
        details: [money(entry.amount,entry.currency),'Current request state: '+entry.state.replaceAll('_',' '),entry.scope],signoff_id: entry.signoff_id,action: 'receipt' });
      if (entry.response.received_at !== null || entry.response.recorded_at !== null) add({
        event_id: `request:${entry.signoff_id}:reply`,category: 'agreements',recorded_at: entry.response.received_at ?? entry.response.recorded_at,
        title: entry.response.decision === 'accepted' ? 'Customer accepted '+prefix.toLowerCase() : entry.response.decision === 'declined' ? 'Customer declined '+prefix.toLowerCase() : 'Customer offer reply needs review',
        details: [entry.response.decision === 'unavailable' ? 'The canonical customer reply could not be read.' : 'Customer reply; owner release is a separate action.'],
        signoff_id: entry.signoff_id,action: 'receipt',
      });
      if (entry.release) {
        add({ event_id: `request:${entry.signoff_id}:released`,category: 'work',recorded_at: entry.release.recorded_at,title: entry.revision ? 'Owner released added work' : 'Owner released work',
          details: [entry.scope],signoff_id: entry.signoff_id,action: 'receipt' });
        add({ event_id: `invoice:${entry.signoff_id}`,category: 'money',recorded_at: entry.release.recorded_at,title: 'Invoice issued — '+entry.release.invoice_ref,
          details: [money(entry.amount,entry.currency),'Due '+entry.release.due_on],business_date: { label: 'Issued on',value: entry.release.issued_on },signoff_id: entry.signoff_id,action: 'payment_history' });
      }
    }
    for (const [index,entry] of saved.completion.entries.entries()) {
      const binding = saved.completion.responses[index]!;
      await openCompletionResponse(rpc,entry,binding.endpoint_id,binding.snapshot,capturedAt,false,binding.expected_hash);
      add({ event_id: `completion:${entry.completion_id}:prepared`,category: 'work',recorded_at: entry.created_at,title: 'Completion request prepared',
        details: [entry.delivery_summary,'Current request state: '+entry.state.replaceAll('_',' ')],signoff_id: entry.signoff_id,action: 'receipt' });
      if (entry.response.received_at !== null || entry.response.recorded_at !== null) add({
        event_id: `completion:${entry.completion_id}:reply`,category: 'work',recorded_at: entry.response.received_at ?? entry.response.recorded_at,
        title: entry.response.decision === 'accepted' ? 'Customer accepted completion' : entry.response.decision === 'corrections_requested' ? 'Customer requested work corrections' : 'Customer completion reply needs review',
        details: ['The customer reply is separate from the owner’s close or reopen action.'],signoff_id: entry.signoff_id,action: 'receipt',
      });
      if (entry.owner_action) add({ event_id: `completion:${entry.completion_id}:review`,category: 'work',recorded_at: entry.owner_action.recorded_at,
        title: entry.owner_action.action === 'close' ? 'Owner closed work after review' : 'Owner reopened work after review',
        details: ['This records the owner action on the saved completion request.'],signoff_id: entry.signoff_id,action: 'receipt' });
    }
    for (const { history,payments,entries } of saved.financial) {
      if (history.consistency !== 'matched') issues.push('Invoice '+history.invoice_ref+': current payment records need review in Records.');
      for (const { entry,record } of payments) add({
        event_id: `payment:${history.signoff_id}:${entry.payment_id}`,category: 'money',recorded_at: record ? record._record.updated_at : null,
        title: 'Payment entry last saved — '+history.invoice_ref,details: [money(entry.amount,history.currency),...(entry.method ? ['Method: '+entry.method] : []),...(entry.reference ? ['Reference: '+entry.reference] : [])],
        business_date: { label: 'Received on',value: entry.received_on },signoff_id: history.signoff_id,action: 'payment_history',
      });
      for (const entry of entries) add({ event_id: 'ledger:'+history.signoff_id+':'+entry.id,category: 'money',recorded_at: entry.record ? entry.record._record.updated_at : null,
        title: entry.title+' — '+history.invoice_ref,details: [money(entry.amount,history.currency),'Current entry state: '+entry.state],business_date: { label: entry.label,value: entry.date },signoff_id: history.signoff_id,action: 'payment_history' });
      const select = { signoff_id: history.signoff_id,limit: 100 };
      const paymentCorrections = await pages(async cursor => { const p = await corrections.history({ ...select,cursor });return { values: p.corrections,next_cursor: p.next_cursor }; });
      const issuedCredits = await pages(async cursor => { const p = await credits.history({ ...select,cursor });return { values: p.credits,next_cursor: p.next_cursor }; });
      const creditCorrections = await pages(async cursor => { const p = await credits.correctionHistory({ ...select,cursor });return { values: p.corrections,next_cursor: p.next_cursor }; });
      const actions = await pages(async cursor => { const p = await refunds.history({ ...select,cursor });return { values: p.actions,next_cursor: p.next_cursor }; });
      const refundCorrections = await pages(async cursor => { const p = await refunds.correctionHistory({ ...select,cursor });return { values: p.corrections,next_cursor: p.next_cursor }; });
      const reviewed = (kind: string,id: string,prepared: number,applied: number | null,title: string,details: string[],date?: { label: string;value: string },runId?: string) => {
        add({ event_id: kind+':'+id+':prepared',category: 'money',recorded_at: prepared,title: title+' previewed',details: [...details,applied === null ? 'Preview only; no financial change was applied.' : 'Owner review was applied later.'],
          signoff_id: history.signoff_id,action: 'payment_history',...(date ? { business_date: date } : {}),...(runId ? { run_id: runId } : {}) });
        if (applied !== null) add({ event_id: kind+':'+id+':applied',category: 'money',recorded_at: applied,title: title+' recorded',details,
          signoff_id: history.signoff_id,action: 'payment_history',...(date ? { business_date: date } : {}),...(runId ? { run_id: runId } : {}) });
      };
      const originals = new Map<string,CustomerPaymentCorrectionRecord>();
      for (const c of [...paymentCorrections].sort((a,b) => a.prepared_at-b.prepared_at || a.correction_id.localeCompare(b.correction_id))) {
        if (c.applied_at !== null && !originals.has(c.payment_id)) originals.set(c.payment_id,c);
        reviewed('payment-correction',c.correction_id,c.prepared_at,c.applied_at,c.action === 'void' ? 'Payment void' : 'Payment correction',
          ['Invoice '+c.invoice_ref,'Before: '+money(c.before.amount,c.currency)+(c.after ? '; after: '+money(c.after.amount,c.currency) : '; entry removed from the active ledger.'),'Reason: '+c.reason],
          c.after ? { label: 'Corrected received on',value: c.after.received_on } : undefined,c.run_id);
      }
      for (const c of originals.values()) if (history.consistency === 'matched' && !payments.some(p => p.entry.payment_id === c.payment_id)) add({
        event_id: `payment:${history.signoff_id}:${c.payment_id}:historical`,category: 'money',recorded_at: null,title: 'Earlier payment kept in correction history',
        details: [money(c.before.amount,c.currency),'This entry is no longer in the active payment list. Its original save time is not available here.'],
        business_date: { label: 'Received on',value: c.before.received_on },signoff_id: history.signoff_id,action: 'payment_history',
      });
      for (const c of issuedCredits) reviewed('invoice-credit',c.credit_id,c.prepared_at,c.applied_at,'Invoice credit',
        ['Invoice '+c.invoice_ref,money(c.amount,c.currency),'Reason: '+c.reason,...(c.replaces_credit_id ? ['Replaces credit '+c.replaces_credit_id] : [])],{ label: 'Issued on',value: c.issued_on },c.run_id);
      for (const c of creditCorrections) reviewed('credit-correction',c.correction_id,c.prepared_at,c.applied_at,'Invoice credit '+(c.action === 'replace' ? 'replacement' : 'reversal'),
        ['Invoice '+c.invoice_ref,'Original credit: '+money(c.before.amount,c.currency),...(c.replacement ? ['Replacement: '+money(c.replacement.amount,c.currency)] : []),'Reason: '+c.reason],{ label: 'Reversed on',value: c.reversed_on },c.run_id);
      for (const c of actions) reviewed('refund-action',c.action_id,c.prepared_at,c.applied_at,c.kind === 'credit' ? 'Paid invoice credit' : 'Customer refund',
        ['Invoice '+c.invoice_ref,money(c.refund?.amount ?? c.credit.amount,c.currency),'Reason: '+(c.refund?.reason ?? c.credit.reason),c.kind === 'credit' ? 'An issued credit and any later refund are recorded separately.' : 'Recorded outside Recued; this review moves no money.'],
        { label: c.refund ? 'Returned on' : 'Issued on',value: c.refund?.returned_on ?? c.credit.issued_on },c.run_id);
      for (const c of refundCorrections) reviewed('refund-correction',c.correction_id,c.prepared_at,c.applied_at,'Refund '+(c.action === 'replace' ? 'replacement' : 'reversal'),
        ['Invoice '+c.invoice_ref,'Original refund: '+money(c.before.amount,c.currency),...(c.replacement ? ['Replacement: '+money(c.replacement.amount,c.currency)] : []),'Reason: '+c.reason],{ label: 'Reversed on',value: c.reversed_on },c.run_id);
    }
    for (const row of saved.scheduleRows) {
      const base = `followup:${row.kind}:${row.request_id}:${row.revision}`;
      if (row.notified_at !== null) add({ event_id: base+':notification',category: 'followups',recorded_at: row.notified_at,title: 'Follow-up notification queued',
        details: [row.kind+' follow-up. Queueing is not proof of delivery.'] });
      if (row.drafted_at !== null) add({ event_id: base+':draft',category: 'followups',recorded_at: row.drafted_at,title: 'Reminder email prepared',
        details: [row.kind+' follow-up. Preparation is separate from Send.'] });
    }
    for (const row of saved.documents) add({ event_id: 'document:'+row.reference,category: 'followups',recorded_at: row.created_at,title: row.kind+' email draft saved',
      details: ['A private draft was saved. This does not mean the email was sent.'],...(row.signoff_id ? { signoff_id: row.signoff_id,action: 'payment_history' as const } : {}) });
    for (const { reference,claim } of saved.mail) if (claim) {
      const document = saved.documents.find(row => row.reference === reference);
      const title = ['sent','reconciled'].includes(claim.status) ? 'Reminder email send recorded' : claim.status === 'confirmed' ? 'Owner marked reminder email as sent'
        : ['not_sent','released'].includes(claim.status) ? 'Reminder email marked not sent' : 'Reminder email outcome needs review';
      add({ event_id: 'mail:'+reference,category: 'followups',recorded_at: claim.updated_at,title: document ? title.replace('Reminder email','Customer document email').replace('reminder email','document email') : title,
        details: [document ? document.kind : reference.startsWith('qapr_') ? 'Account payment follow-up covering this job.' : 'Job follow-up.','Saved outcome: '+claim.status.replaceAll('_',' ')] });
    }
    for (const event of saved.archive) {
      if (!['archive','restore'].includes(event.action) || !Number.isSafeInteger(event.revision) || event.revision < 1) fail('Saved archive history needs review.');
      add({ event_id: 'archive:'+event.revision,category: 'archive',recorded_at: event.recorded_at,
        title: event.action === 'archive' ? 'Owner archived job' : 'Owner restored job',details: ['Records and financial entries were kept.'],action: 'closeout' });
    }
    deps.codec.assertUnlocked();assertCaptured();if (frame().stamp !== saved.stamp) stale();
    events.sort((a,b) => a.recorded_at === null ? b.recorded_at === null ? a.event_id.localeCompare(b.event_id) : 1
      : b.recorded_at === null ? -1 : b.recorded_at-a.recorded_at || a.event_id.localeCompare(b.event_id));
    const snapshot = hash({ stamp: saved.stamp,job,events });if (cursor && cursor.snapshot !== snapshot) stale();
    const matching = events.filter(event => (category === 'all' || category === event.category)
      && (!search || [event.title,...event.details,event.business_date?.value ?? ''].join('\n').toLowerCase().includes(search)));
    const start = cursor ? matching.findIndex(event => event.event_id === cursor!.after)+1 : 0;
    if (cursor && start === 0) invalid();
    const page = matching.slice(start,start+size);const last = page.at(-1);
    return { job_id: input.job_id,captured_at: capturedAt,snapshot_hash: snapshot,job,events: page,total_events: events.length,matching_events: matching.length,
      billing_available: saved.financial.every(f => f.history.consistency === 'matched' && f.history.snapshot_hash !== null),issues,schedules: saved.scheduleRows.map(({ kind,request_id,due_at,revision }) => ({ kind,request_id,due_at: due_at === null ? null : at(due_at),revision })),notes,
      ...(start+size < matching.length && last ? { next_cursor: Buffer.from(JSON.stringify({ v: 1,query,snapshot,after: last.event_id })).toString('base64url') } : {}) };
  },
});
export type CustomerJobTimelineService = ReturnType<typeof createCustomerJobTimelineService>;
