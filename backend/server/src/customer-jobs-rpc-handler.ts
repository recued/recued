import { createHash } from 'node:crypto';
import { CUSTOMER_JOB_FILTERS, CUSTOMER_JOB_ARCHIVE_FILTERS, QUOTE_SIGNOFF_SEARCH_MAX, RpcError,
  type CustomerJob, type CustomerJobsListInput, type CustomerJobsListResult } from '@recued/contracts';
import { QuoteSignoffError } from './quote-signoff-service.js';
import { openCompletionResponse } from './quote-completion-rpc-handler.js';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = (value: string): bigint => {
  if (!/^\d+\.\d{4}$/.test(value) || value.length > 32) throw new Error('Invalid saved money');
  return BigInt(value.replace('.',''));
};
const decimal = (value: bigint) => `${value / 10_000n}.${String(value % 10_000n).padStart(4,'0')}`;
const reviewState = async (deps: ReceptionRpcDeps, prefix: string, endpoint: string | null) => {
  const anchor = endpoint ? await deps.auditLog.get(prefix+endpoint) : null;
  return anchor === null ? 'not_queued' as const : anchor.commit_status === 'awaiting_approval' ? 'waiting' as const
    : anchor.commit_status === 'running' || anchor.commit_status === 'pending' ? 'running' as const : 'closed' as const;
};
const matches = (job: CustomerJob,filter: NonNullable<CustomerJobsListInput['filter']>) => {
  switch (filter) {
    case 'all': return true;
    case 'waiting_customer': return job.waiting_customer;
    case 'owner_review': return job.needs_owner_review;
    case 'in_progress': return job.work === 'in_progress';
    case 'corrections': return job.corrections;
    case 'complete': return job.work === 'complete';
    case 'unpaid': return job.payment.has_unpaid_balance;
    case 'overdue': return job.payment.overdue;
    case 'needs_attention': return job.needs_attention;
  }
};

export interface CustomerJobsCapture { captured_at: number;jobs: CustomerJob[];sources: ReadonlyMap<string,string>;assertCurrent: () => void }

/** Freeze board evidence. A selected job also gets a synchronous write-boundary assertion. */
export const captureCustomerJobs = async (deps: ReceptionRpcDeps,jobId?: string): Promise<CustomerJobsCapture> => {
    const store = deps.getApprovalIntentStore!(); const read = (endpoint: string | null) => endpoint ? store.findByEndpoint(endpoint) : null;
    const completionService = deps.getQuoteCompletionService!();
    const local = () => deps.getQuoteSignoffService!().customerJobsSnapshot(read,root => completionService.latestForJob(root,read),jobId);
    const snapshot = local();
    const selected = (value: typeof snapshot) => value.jobs.filter(job => !jobId || job.job_id === jobId);
    const stable = (value: typeof snapshot) => hash(JSON.parse(JSON.stringify(selected(value),(key,v) => key === 'checked_at' ? undefined : v)));
    const original = jobId ? stable(snapshot) : null;
    const closeouts = deps.getCustomerJobCloseoutService?.();
    const sources = new Map<string,string>(selected(snapshot).filter(job => jobId || closeouts?.hasArchive(job.job_id))
      .map(job => [job.job_id,hash(JSON.parse(JSON.stringify(job,(key,v) => key === 'checked_at' ? undefined : v)))]));
    const jobs: CustomerJob[] = [];
    for (const saved of selected(snapshot)) {
      const { offer,agreement,invoices } = saved;
      const completion = saved.completion?.completion ?? null;
      if (completion && saved.completion) {
        await openCompletionResponse(deps,completion,completion.endpoint_id,saved.completion.snapshot,snapshot.captured_at,true,saved.completion.expected_hash);
        if (completion.state === 'waiting' && saved.completion.snapshot === null) completion.response.decision = 'unavailable';
        if (completion.state === 'accepted' || completion.state === 'corrections_requested') {
          completion.review = await reviewState(deps,'reception-quote-completion-',completion.endpoint_id);
        }
      }
      if (offer.state === 'accepted') offer.release_review = await reviewState(deps,'reception-quote-signoff-',offer.endpoint_id);
      let offer_reply: CustomerJob['offer_reply'] = offer.responded_at === null ? 'not_recorded' : 'received';
      if (offer.state === 'waiting') {
        const intent = saved.offer_intent;
        if (!intent || intent.endpoint_id !== offer.endpoint_id || intent.intent_id !== offer.endpoint_id
          || intent.target_id !== offer.signoff_id || intent.action_kind !== 'approve_wording') offer_reply = 'unavailable';
        else if (intent.consumed_at !== null) offer_reply = Number.isSafeInteger(intent.consumed_at)
          && intent.consumed_at >= offer.created_at && intent.consumed_at < offer.expires_at
          && intent.consumed_at <= snapshot.captured_at ? 'received' : 'unavailable';
      }
      const task = agreement?.follow_up?.task;
      const work: CustomerJob['work'] = !agreement ? 'not_released' : task?.availability === 'current'
        ? task.done ? 'complete' : 'in_progress' : 'unavailable';
      const payment: CustomerJob['payment'] = { status: invoices.length ? 'unavailable' : 'not_invoiced',
        amount_paid: null,outstanding: null,has_unpaid_balance: false,overdue: false };
      let agreed_total: string | null = null;
      if (invoices.length && saved.agreement_available) {
        try {
          let total = 0n;let paid = 0n;let credited = 0n;let outstanding = 0n;let available = true;let refundCredit=0n;let refunded=0n;let refundDue=0n;let hasRefunds=false;
          for (const invoice of invoices) {
            total += money(invoice.amount);
            const current = invoice.follow_up?.invoice;
            if (invoice.currency !== offer.currency || current?.availability !== 'current') { available = false;continue; }
            payment.has_unpaid_balance ||= money(current.outstanding) > 0n;
            payment.overdue ||= current.overdue;
            if (current.status === 'carried_forward') { available = false;continue; }
            hasRefunds ||= current.amount_refund_credited!==undefined;refundCredit+=money(current.amount_refund_credited??'0.0000');refunded+=money(current.amount_refunded??'0.0000');refundDue+=money(current.refund_due??'0.0000');
            paid += money(current.amount_paid);credited += money(current.amount_credited ?? '0.0000');outstanding += money(current.outstanding);
          }
          agreed_total = decimal(total);
          if (available && paid+credited+outstanding === total) Object.assign(payment,{ amount_paid: decimal(paid),outstanding: decimal(outstanding),
            ...(credited > 0n ? { amount_credited: decimal(credited) } : {}),
            ...(hasRefunds ? { amount_refund_credited: decimal(refundCredit),amount_refunded: decimal(refunded),refund_due: decimal(refundDue),net_received: decimal(paid-refunded),net_invoice_total: decimal(total-credited-refundCredit) } : {}),
            status: outstanding === 0n ? credited > 0n ? 'credited' : 'paid' : paid === 0n ? 'unpaid' : 'part_paid' });
        } catch { /* No aggregate balance is better than a guessed balance. */ }
      }
      const completion_matches_agreement = !!completion && completion.signoff_id === agreement?.signoff_id;
      const currentCompletion = completion_matches_agreement && completion?.availability === 'current'
        && completion.state !== 'cancelled' && completion.state !== 'superseded';
      const pendingAddition = !!offer.addition && ['draft','publishing','waiting','accepted'].includes(offer.state);
      const waiting_customer = offer.state === 'waiting' && offer.availability === 'current' && offer_reply === 'not_recorded'
        || !!currentCompletion && completion?.state === 'waiting' && completion.response.decision === 'not_recorded';
      const needs_owner_review = offer.availability === 'current' && offer.release_review === 'waiting'
        || !!currentCompletion && completion?.review === 'waiting';
      const corrections = !!currentCompletion && completion?.response.decision === 'corrections_requested' && work === 'in_progress';
      const needs_attention = !!payment.refund_due && payment.refund_due !== '0.0000' || !saved.agreement_available || work === 'unavailable' || payment.status === 'unavailable'
        || offer.availability !== 'current' || offer_reply === 'unavailable'
        || offer.state === 'accepted' && offer.release_review !== 'waiting' && offer.release_review !== 'running'
        || completion_matches_agreement && !!completion && (completion.availability !== 'current' || completion.response.decision === 'unavailable'
          || ['accepted','corrections_requested'].includes(completion.state) && completion.review !== 'waiting' && completion.review !== 'running');
      const job: CustomerJob = { job_id: saved.job_id,created_at: saved.created_at,customer: offer.customer,quote_label: offer.quote_label,
        ...(offer.quote_reference ? { quote_reference: offer.quote_reference } : {}),currency: offer.currency,agreed_scope: saved.agreed_scope,
        agreed_total,offer,agreement,invoices,work,payment,completion,completion_matches_agreement,offer_reply,
        waiting_customer,needs_owner_review,corrections,needs_attention,
        can_request_completion: saved.agreement_available && !pendingAddition && agreement?.can_request_completion === true };
      const archive = closeouts?.project(job,sources.get(job.job_id));
      if (archive && archive.revision > 0) job.archive = archive;
      if (archive?.needs_review) job.needs_attention = true;
      jobs.push(job);
    }
    return { captured_at: snapshot.captured_at,jobs,sources,assertCurrent: () => {
      if (!jobId) throw new QuoteSignoffError('customer_job_closeout_invalid','Choose one original customer job before closing it out.',400);
      if (stable(local()) !== original) throw new QuoteSignoffError('customer_job_closeout_stale','This job changed. Refresh and review its closeout again.');
    } };
};

/** Read-only owner projection. Freeze each job's local records before opening replies;
 * every existing mutation workflow still rechecks its own exact target. */
export const handleCustomerJobsList = async (deps: ReceptionRpcDeps,input: CustomerJobsListInput | void,
  caller: { instance_id?: string | null } | undefined): Promise<CustomerJobsListResult> => {
  if (!caller?.instance_id) throw new RpcError('unauthorized','Customer jobs require a paired owner client.',401);
  if (!deps.getQuoteSignoffService || !deps.getQuoteCompletionService || !deps.getApprovalIntentStore) {
    throw new RpcError('not_configured','Customer jobs are unavailable on this server.',503);
  }
  const args = input === undefined ? {} : input;
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => !['search','filter','limit','cursor','archive'].includes(key))) {
    throw new RpcError('customer_jobs_invalid','Invalid customer jobs query.',400);
  }
  const limit = args.limit === undefined ? 50 : args.limit; const filter = args.filter === undefined ? 'all' : args.filter;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !CUSTOMER_JOB_FILTERS.includes(filter)) {
    throw new RpcError('customer_jobs_invalid','Choose a job filter and a limit from 1 to 100.',400);
  }
  if (args.search !== undefined && (typeof args.search !== 'string' || args.search.length > QUOTE_SIGNOFF_SEARCH_MAX || args.search.includes('\0'))) {
    throw new RpcError('customer_jobs_invalid','Search must fit within 200 characters.',400);
  }
  const archive = args.archive === undefined ? 'active' : args.archive;
  if (!CUSTOMER_JOB_ARCHIVE_FILTERS.includes(archive)) throw new RpcError('customer_jobs_invalid','Choose active, archived or all jobs.',400);
  const search = (args.search ?? '').trim().toLowerCase(); const query = hash({ search,filter,archive });
  let anchor: { at: number; id: string } | undefined;
  if (args.cursor !== undefined) {
    try {
      if (typeof args.cursor !== 'string' || args.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(args.cursor)) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['v','query','at','id'].includes(key))
        || !('v' in value) || value.v !== 1 || !('query' in value) || value.query !== query
        || !('at' in value) || typeof value.at !== 'number' || !Number.isSafeInteger(value.at) || value.at < 0
        || !('id' in value) || typeof value.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)) throw new Error();
      anchor = { at: value.at,id: value.id };
    } catch { throw new RpcError('customer_jobs_invalid','This job page no longer matches the search. Start from the newest jobs.',400); }
  }
  try {
    const signoffs = deps.getQuoteSignoffService();
    const page: CustomerJob[] = [];let scanned = 0;let more = true;let capturedAt = 0;
    let after = anchor ? { created_at: anchor.at,job_id: anchor.id } : undefined;
    // Status filters need current tasks, canonical replies and verified money.
    // Bound that work; a short page continues from the last checked root.
    while (more && scanned < 200 && page.length < limit) {
      const window = signoffs.customerJobCandidates({ limit: Math.min(25,200-scanned),after,search,archive });
      capturedAt = window.captured_at;more = window.has_more;
      for (const [index,candidate] of window.candidates.entries()) {
        after = candidate;scanned++;more = index+1 < window.candidates.length || window.has_more;
        const snapshot = await captureCustomerJobs(deps,candidate.job_id);capturedAt = snapshot.captured_at;
        try { snapshot.assertCurrent(); }
        catch (error) {
          if (error instanceof QuoteSignoffError && error.code === 'customer_job_closeout_stale') {
            throw new QuoteSignoffError('customer_jobs_stale','A job changed while this page loaded. Refresh jobs to read its current evidence.');
          }
          throw error;
        }
        const job = snapshot.jobs[0];if (!job) continue;
        if (job.created_at !== candidate.created_at) throw new QuoteSignoffError('customer_jobs_stale','The job order changed. Refresh jobs and start from the newest page.');
        const archived = job.archive?.archived_at !== null && job.archive?.archived_at !== undefined;
        if (archive === 'archived' && !archived || archive === 'active' && archived && !job.archive?.needs_review) continue;
        const haystack = [job.customer,job.quote_label,job.quote_reference ?? '',...job.invoices.map(entry => entry.invoice_ref),job.offer.invoice_ref].join('\n').toLowerCase();
        if ((!search || haystack.includes(search)) && matches(job,filter)) page.push(job);
        if (page.length === limit) break;
      }
      if (!window.candidates.length) more = false;
    }
    return { captured_at: capturedAt,jobs: page,scanned_jobs: scanned,
      ...(more && scanned === 200 && page.length < limit ? { scan_limited: true } : {}),
      ...(more && after ? { next_cursor: Buffer.from(JSON.stringify({ v: 1,query,at: after.created_at,id: after.job_id })).toString('base64url') } : {}) };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);
    throw new RpcError('customer_jobs_unavailable','Customer jobs could not be read completely. Refresh or review saved requests in Records.',503);
  }
};
