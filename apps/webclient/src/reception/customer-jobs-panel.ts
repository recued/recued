import { CUSTOMER_JOB_FILTERS, QUOTE_SIGNOFF_SEARCH_MAX, type Conn, type ServerRpcRegistry,
  type CustomerJob, type CustomerJobFilter, type CustomerJobsListResult } from '@recued/contracts';
import type { QuoteSignoffConn } from './quote-signoff-panel.js';
import { mountQuoteCompletionPanel } from './quote-completion-panel.js';
import { mountQuoteSignoffReceipt } from './quote-signoff-receipt.js';
import { canRecordSignoffPayment,createQuoteSignoffPayment,type QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';

export type CustomerJobsConn = QuoteSignoffConn & Conn<Pick<ServerRpcRegistry,'reception.jobs.list'>>;
const filters: Record<CustomerJobFilter,string> = { all: 'All jobs',waiting_customer: 'Waiting on the customer',
  owner_review: 'Needs owner review',in_progress: 'Work in progress',corrections: 'Corrections requested',
  complete: 'Work complete',unpaid: 'Unpaid balance',overdue: 'Overdue payment',needs_attention: 'Needs attention' };
const workLabels: Record<CustomerJob['work'],string> = { not_released: 'Work not released',in_progress: 'Work in progress',complete: 'Work complete',unavailable: 'Work status unavailable' };

export const mountCustomerJobsPanel = (opts: { host: HTMLElement;document: Document;conn: CustomerJobsConn;payment?: QuoteSignoffPaymentOptions }) => {
  const { document: doc,conn } = opts;
  const root = doc.createElement('section');root.setAttribute('data-customer-jobs','');opts.host.appendChild(root);
  const add = (tag: string,text: string,host: HTMLElement = root) => { const node = doc.createElement(tag);node.textContent = text;host.appendChild(node);return node; };
  const button = (text: string,host: HTMLElement = root) => { const node = doc.createElement('button');node.type = 'button';node.textContent = text;host.appendChild(node);return node; };
  const link = (text: string,href: string,host: HTMLElement) => { const node = add('a',text,host);node.setAttribute('href',href);return node; };
  const focusKey = (node: HTMLElement) => node.getAttribute('data-job-action') ?? node.getAttribute('href')
    ?? (node.tagName === 'SUMMARY' ? 'scope' : null);
  add('style',`[data-customer-jobs]{display:grid;gap:18px;max-width:1100px}
    [data-customer-jobs] [hidden]{display:none!important}
    [data-customer-jobs] h2,[data-customer-jobs] h3,[data-customer-jobs] p{margin:0}
    [data-customer-jobs] form,[data-customer-jobs] label,[data-customer-jobs] [data-job-list]{display:grid;gap:10px}
    [data-customer-jobs] article{display:grid;gap:12px;padding:18px;border:1px solid var(--border);border-radius:12px;min-width:0}
    [data-customer-jobs] .job-statuses{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
    [data-customer-jobs] .job-statuses>div{display:grid;gap:6px;align-content:start;min-width:0;padding:12px;background:var(--surface-sunk);border-radius:8px}
    [data-customer-jobs] .job-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    [data-customer-jobs] input,[data-customer-jobs] select,[data-customer-jobs] textarea{max-width:100%;width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--fg);font:inherit}
    [data-customer-jobs] button{padding:9px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--fg);cursor:pointer;width:fit-content}
    [data-customer-jobs] button:disabled{opacity:.6;cursor:default}
    [data-customer-jobs] pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
    [data-customer-jobs] :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    @media(max-width:640px){[data-customer-jobs] .job-statuses{grid-template-columns:1fr}}
  `);
  add('h2','Customer jobs');add('p','Follow each customer agreement from the first reply through delivery and payment. Work completion and money received are shown separately.');
  const form = doc.createElement('form');form.setAttribute('aria-label','Find customer jobs');root.appendChild(form);
  const searchLabel = add('label','Search customer, quote or invoice',form);const search = doc.createElement('input');search.type = 'search';search.maxLength = QUOTE_SIGNOFF_SEARCH_MAX;searchLabel.appendChild(search);
  const filterLabel = add('label','Show jobs',form);const filter = doc.createElement('select');filter.id = 'recued-customer-jobs-filter';
  filterLabel.setAttribute('for',filter.id);form.appendChild(filter);
  for (const value of CUSTOMER_JOB_FILTERS) { const option = doc.createElement('option');option.value = value;option.textContent = filters[value];filter.appendChild(option); }
  const submit = button('Search jobs',form);submit.type = 'submit';const refresh = button('Refresh jobs',form);
  const message = add('p','Loading customer jobs…');message.setAttribute('role','status');message.setAttribute('aria-live','polite');
  const list = add('div','');list.setAttribute('data-job-list','');
  const paging = add('div','');paging.className = 'job-actions';const newer = button('Newer jobs',paging);const older = button('Older jobs',paging);
  let disposed = false;let loading = false;let generation = 0;let nextCursor: string | undefined;
  type Page = { cursor?: string;previous: Array<string | undefined> };
  let page: Page = { previous: [] };let pending: Page | undefined;
  let query: { search: string;filter: CustomerJobFilter } = { search: '',filter: 'all' };
  let displayedQuery = { ...query };let hasLoaded = false;
  const changed = () => { if (!disposed) void load(); };
  const completions = mountQuoteCompletionPanel({ document: doc,host: root,conn,editorOnly: true,onChanged: changed });
  let receiptReturnJob: string | null = null;
  const receipts = mountQuoteSignoffReceipt({ document: doc,host: root,
    read: id => conn('reception.signoff.receipt',{ signoff_id: id }),returnFocus: () => {
      if (disposed) return;
      for (const target of root.querySelectorAll<HTMLButtonElement>('[data-job-receipt-open]')) {
        if (target.getAttribute('data-job-receipt-open') === receiptReturnJob) { target.focus();return; }
      }
      submit.focus();
    } });
  const payment = opts.payment ? createQuoteSignoffPayment({ ...opts.payment,document: doc,host: root,
    readOffer: async id => (await conn('reception.signoff.list',{ signoff_id: id })).signoffs.find(entry => entry.signoff_id === id),
    onChanged: changed,onMessage: text => { message.textContent = text; } }) : null;
  const inFlight = () => completions.hasInFlightWork() || payment?.hasInFlightWork() === true;
  const controls = () => {
    const busy = inFlight();submit.disabled = busy;refresh.disabled = busy;
    const sameQuery = query.search === displayedQuery.search && query.filter === displayedQuery.filter;
    newer.disabled = loading || busy || !sameQuery || page.previous.length === 0;older.disabled = loading || busy || !sameQuery || !nextCursor;
  };
  const render = (job: CustomerJob) => {
    const card = add('article','',list);card.setAttribute('data-job-id',job.job_id);
    add('h3',`${job.quote_label} — ${job.customer}`,card);
    if (job.quote_reference) add('p',`Quote ${job.quote_reference}`,card);
    if (job.agreed_total !== null) add('p',`Agreed total: ${job.agreed_total} ${job.currency}`,card);
    const statuses = add('div','',card);statuses.className = 'job-statuses';
    const work = add('div','',statuses);add('strong','Work',work);add('p',workLabels[job.work],work);
    if (job.agreement?.follow_up?.task.availability === 'current') add('p',job.agreement.follow_up.task.title,work);
    const reply = add('div','',statuses);add('strong','Customer reply',reply);
    if (job.offer.state !== 'released') {
      const offerText = job.offer.availability !== 'current' ? `Offer ${job.offer.availability}`
        : job.offer_reply === 'unavailable' ? 'Offer reply unavailable'
        : job.offer.state === 'waiting' && job.offer_reply === 'received' ? 'Offer reply received; processing pending'
          : job.offer.state === 'waiting' ? 'Waiting for offer sign-off'
            : job.offer.state === 'accepted' ? job.offer.release_review === 'closed' ? 'Owner review ended; work not released' : 'Offer accepted; owner release pending'
              : job.offer.state === 'rejected' ? 'Offer declined' : job.offer.state === 'cancelled' ? 'Offer cancelled' : 'Offer not published';
      add('p',`${job.offer.addition ? 'Added work: ' : ''}${offerText}`,reply);
    }
    if (job.completion) {
      const completion = job.completion;
      add('p',!job.completion_matches_agreement ? 'Completion reply belongs to an earlier agreement'
        : completion.response.decision === 'unavailable' ? 'Completion reply unavailable'
          : completion.state === 'cancelled' ? 'Completion request cancelled'
            : completion.availability !== 'current' ? `Completion request ${completion.availability}`
              : completion.response.decision === 'accepted' ? 'Customer accepted delivery'
                : completion.response.decision === 'corrections_requested' ? 'Customer requested corrections'
                  : completion.state === 'waiting' ? 'Waiting for completion reply' : 'Completion request not published',reply);
      if (completion.owner_action) add('p',completion.owner_action.action === 'close' ? 'Owner closed work after review' : 'Owner reopened work after review',reply);
      if (completion.state === 'waiting' && completion.response.decision !== 'not_recorded') add('p','Reply received; processing pending',reply);
      if (completion.review === 'closed' && completion.owner_action === null) add('p','Owner review ended without applying this completion',reply);
      if (completion.response.corrections) add('pre',completion.response.corrections,reply);
    } else if (job.agreement) add('p','No completion request yet',reply);
    const balance = add('div','',statuses);add('strong','Payment',balance);
    add('p',job.payment.status === 'not_invoiced' ? 'No invoice released'
      : job.payment.status === 'unavailable' ? 'Balance needs review in Records'
        : job.payment.status === 'paid' ? 'Recorded paid in full'
          : `${job.payment.outstanding} ${job.currency} outstanding${job.payment.overdue ? ' · overdue' : ''}`,balance);
    if (job.payment.amount_paid !== null) add('p',`Recorded paid: ${job.payment.amount_paid} ${job.currency}`,balance);
    if (job.needs_attention) add('p','This job needs attention. Review unavailable records or ended reviews before continuing.',card);
    const scope = add('details','',card);add('summary',job.agreed_scope === null ? 'Offered scope' : 'Agreed scope',scope);add('pre',job.agreed_scope ?? job.offer.scope,scope);
    const actions = add('div','',card);actions.className = 'job-actions';
    if (job.needs_owner_review) link('Review in Reception Inbox','#reception/inbox',actions);
    if (job.offer.release_review === 'closed' || job.completion?.review === 'closed' && job.completion.owner_action === null) link('Review in Runs','#runs',actions);
    if (job.agreement?.task_id && job.agreement.follow_up?.task.availability === 'current') link('Open task',`#data/task/${encodeURIComponent(job.agreement.task_id)}`,actions);
    if (job.can_request_completion && job.agreement) {
      const request = button('Request completion',actions);request.setAttribute('data-job-action','completion');
      request.addEventListener('click',() => { if (!disposed && !inFlight()) { completions.open(job.agreement!);controls(); } });
    }
    if (payment) for (const invoice of job.invoices) if (canRecordSignoffPayment(invoice)) {
      const pay = button(`Record payment — ${invoice.invoice_ref}`,actions);
      pay.setAttribute('data-job-action',`payment:${invoice.signoff_id}`);
      pay.addEventListener('click',() => { if (!disposed && !inFlight()) void payment.open(invoice).finally(controls); });
    }
    const receipt = button('View receipt',actions);receipt.setAttribute('data-job-receipt-open',job.job_id);receipt.setAttribute('data-job-action','receipt');
    receipt.addEventListener('click',() => { if (!disposed) { receiptReturnJob = job.job_id;void receipts.open((job.agreement ?? job.offer).signoff_id); } });
    link('View sign-off requests','#reception/signoffs',actions);link('Browse Records','#data/records',actions);
  };
  const load = async (desired = pending ?? page) => {
    if (disposed) return;const current = ++generation;const savedQuery = { ...query };pending = desired;loading = true;controls();
    try {
      const result: CustomerJobsListResult = await conn('reception.jobs.list',{ limit: 50,...(savedQuery.search ? { search: savedQuery.search } : {}),
        ...(savedQuery.filter !== 'all' ? { filter: savedQuery.filter } : {}),...(desired.cursor ? { cursor: desired.cursor } : {}) });
      if (disposed || current !== generation) return;
      const focused = [...list.querySelectorAll<HTMLElement>('button,a,summary')].find(node => node === doc.activeElement);
      const focusJob = focused?.closest('[data-job-id]')?.getAttribute('data-job-id');const action = focused ? focusKey(focused) : null;
      const expanded = new Set([...list.querySelectorAll<HTMLDetailsElement>('details[open]')]
        .map(node => node.closest('[data-job-id]')?.getAttribute('data-job-id')));
      page = { cursor: desired.cursor,previous: [...desired.previous] };pending = undefined;nextCursor = result.next_cursor;
      displayedQuery = savedQuery;hasLoaded = true;list.replaceChildren();
      for (const job of result.jobs) render(job);
      for (const details of list.querySelectorAll<HTMLDetailsElement>('details')) {
        details.open = expanded.has(details.closest('[data-job-id]')?.getAttribute('data-job-id'));
      }
      if (focused && focusJob && action) {
        const replacement = [...list.querySelectorAll<HTMLElement>('button,a,summary')].find(node =>
          node.closest('[data-job-id]')?.getAttribute('data-job-id') === focusJob && focusKey(node) === action);
        (replacement ?? submit).focus();
      }
      if (!result.jobs.length) add('p',savedQuery.search || savedQuery.filter !== 'all' ? 'No customer jobs match this view.' : 'No customer jobs yet. Start with a quote in Customer sign-offs.',list);
      message.textContent = `${result.jobs.length} ${result.jobs.length === 1 ? 'job' : 'jobs'} on this page.`;
    } catch (error) { if (!disposed && current === generation) message.textContent = (error instanceof Error ? error.message : 'Customer jobs could not be loaded. Try again.')
      + (hasLoaded ? ' Previously loaded jobs remain visible. Refresh jobs to retry this view.' : ''); }
    finally { if (!disposed && current === generation) { loading = false;controls(); } }
  };
  form.addEventListener('submit',event => { event.preventDefault();if (inFlight()) return;query = { search: search.value.trim(),filter: filter.value as CustomerJobFilter };pending = undefined;void load({ previous: [] }); });
  refresh.addEventListener('click',() => { if (!inFlight()) void load(); });
  older.addEventListener('click',() => { if (!loading && !inFlight() && nextCursor) void load({ cursor: nextCursor,previous: [...page.previous,page.cursor] }); });
  newer.addEventListener('click',() => { if (!loading && !inFlight() && page.previous.length) void load({ cursor: page.previous.at(-1),previous: page.previous.slice(0,-1) }); });
  const interval = setInterval(() => { if (!disposed && !loading && !inFlight()) void load(); },20_000);
  controls();void load();
  return { update: changed,hasUnsavedChanges: completions.hasUnsavedChanges,hasInFlightWork: inFlight,
    dispose: () => { disposed = true;generation++;clearInterval(interval);completions.dispose();receipts.dispose();payment?.dispose();root.remove(); } };
};
