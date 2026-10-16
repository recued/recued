import { customerInvoiceRecordAddress } from '../data/records-navigation.js';
import { focusCustomerWorkspace } from './customer-workspace-focus.js';
import { receptionCustomerJobAddress,receptionSignoffAddress,receptionInboxTargetAddress,type CustomerJobTab } from './navigation.js';
import { mountCustomerReceivablesAging,type CustomerReceivablesAgingConn } from './customer-receivables-aging.js';
import { mountCustomerJobTimeline,type CustomerJobTimelineConn } from './customer-job-timeline.js';
import { mountCustomerJobCloseout,type CustomerJobCloseoutConn } from './customer-job-closeout.js';
import { customerRefundBalanceLines } from '@recued/contracts';
import { CUSTOMER_JOB_FILTERS, QUOTE_SIGNOFF_SEARCH_MAX, type Conn, type ServerRpcRegistry,
  type CustomerJob, type CustomerJobArchiveFilter, type CustomerJobFilter, type CustomerJobsListResult } from '@recued/contracts';
import type { QuoteSignoffConn } from './quote-signoff-panel.js';
import { mountQuoteCompletionReminders,type QuoteCompletionReminderOptions } from './quote-completion-reminders.js';
import { mountQuotePaymentReminders } from './quote-payment-reminders.js';
import { mountQuoteCompletionPanel } from './quote-completion-panel.js';
import { mountCustomerAccountsPanel,type CustomerAccountsConn } from './customer-accounts-panel.js';
import { mountCustomerJobPaymentStatement } from './customer-job-payment-statement.js';
import { mountCustomerPaymentHistory } from './customer-payment-history.js';
import { mountQuoteSignoffReceipt } from './quote-signoff-receipt.js';
import { canRecordSignoffPayment,createQuoteSignoffPayment,type QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';

export type CustomerJobsConn = CustomerReceivablesAgingConn & CustomerJobTimelineConn & CustomerJobCloseoutConn & CustomerAccountsConn & QuoteSignoffConn & Conn<Pick<ServerRpcRegistry,'reception.jobs.list' | 'reception.jobs.payment.statement' | 'reception.jobs.payment.statement.draft'>>;
const filters: Record<CustomerJobFilter,string> = { all: 'All jobs',waiting_customer: 'Waiting on the customer',
  owner_review: 'Needs owner review',in_progress: 'Work in progress',corrections: 'Corrections requested',
  complete: 'Work complete',unpaid: 'Unpaid balance',overdue: 'Overdue payment',needs_attention: 'Needs attention' };
const workLabels: Record<CustomerJob['work'],string> = { not_released: 'Work not released',in_progress: 'Work in progress',complete: 'Work complete',unavailable: 'Work status unavailable' };

export interface CustomerJobsBoardState { search: string;filter: CustomerJobFilter;archive: CustomerJobArchiveFilter;cursor?: string;previous: Array<string | undefined> }
export interface CustomerJobsPanelOptions { host: HTMLElement;document: Document;conn: CustomerJobsConn;payment?: QuoteSignoffPaymentOptions;reminders?: QuoteCompletionReminderOptions;
  jobId?: string;tab?: CustomerJobTab;workspace?: 'accounts' | 'receivables';initialState?: CustomerJobsBoardState;
  onJobLoaded?: (job: CustomerJob) => void;onOpenJob?: (id: string,tab: CustomerJobTab) => void;onCloseWorkspace?: () => void;onBoardStateChanged?: () => void }
export const mountCustomerJobsPanel = (opts: CustomerJobsPanelOptions) => {
  const { document: doc,conn } = opts;
  const root = doc.createElement('section');root.setAttribute('data-customer-jobs','');if(opts.jobId)root.setAttribute('data-job-detail','');opts.host.appendChild(root);
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
    [data-customer-jobs] input[type=checkbox]{width:auto}
    [data-customer-jobs] [data-completion-reminders],[data-customer-jobs] [data-completion-reminder-queue],[data-customer-jobs] [data-completion-reminder-editor],[data-customer-jobs] [data-payment-reminders],[data-customer-jobs] [data-payment-reminder-queue],[data-customer-jobs] [data-payment-reminder-editor]{display:grid;gap:12px}
    [data-customer-jobs] [data-completion-reminders] .signoff-actions{display:flex;flex-wrap:wrap;gap:10px}
    [data-customer-jobs] button{padding:9px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--fg);cursor:pointer;width:fit-content}
    [data-customer-jobs] button:disabled{opacity:.6;cursor:default}
    [data-customer-jobs] pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
    [data-customer-jobs] :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    [data-jobs-board]{display:grid;gap:16px;min-width:0}
    [data-customer-jobs] form[aria-label="Find customer jobs"]{grid-template-columns:minmax(180px,1fr) auto auto;align-items:end}
    [data-job-more-filters]>summary{cursor:pointer;padding:10px;border:1px solid var(--border);border-radius:8px;min-height:42px}
    [data-job-more-filters][open]{display:flex;gap:10px;align-items:end}
    [data-job-more-filters][open]>summary{align-self:end}
    [data-customer-jobs] .job-summary{grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1.3fr) auto;align-items:center;padding:16px}
    [data-customer-jobs] .job-summary h3{font-size:16px}
    [data-customer-jobs] .job-summary p{font-size:13px;color:var(--fg-muted)}
    [data-customer-jobs] .job-summary .job-flags{color:var(--accent);font-weight:650}
    [data-customer-jobs] a{color:var(--accent);text-underline-offset:3px}
    [data-customer-jobs] .job-primary-action{display:inline-flex;padding:9px 12px;background:var(--accent);color:var(--on-accent,#fff);border-radius:8px;text-decoration:none}
    [aria-label="Job quick views"]{flex-wrap:nowrap!important;overflow-x:auto;max-width:100%;padding-bottom:4px}
    [aria-label="Job quick views"] button{flex-shrink:0}
    [data-customer-jobs] .job-billing-list{display:grid}
    [data-customer-jobs] .job-invoice{display:grid;gap:10px;padding:14px;border:1px solid var(--border);border-radius:8px}
    @media(max-width:900px){[data-customer-jobs] .job-summary{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}[data-customer-jobs] form[aria-label="Find customer jobs"]{grid-template-columns:minmax(0,1fr) auto}[data-job-more-filters]{grid-column:1/-1;grid-row:2}}
    @media(max-width:640px){[data-customer-jobs] .job-summary{grid-template-columns:1fr}[data-customer-jobs] form[aria-label="Find customer jobs"]{grid-template-columns:minmax(0,1fr) auto}.job-search-field{grid-column:1/-1}[data-job-more-filters]{grid-column:2;grid-row:2}[data-job-more-filters][open]{grid-column:1/-1;display:grid}[data-customer-jobs] form[aria-label="Find customer jobs"]>.job-actions{grid-column:1;grid-row:2;flex-wrap:nowrap}}
    @media(max-width:640px){[data-customer-jobs] .job-statuses{grid-template-columns:1fr}}
  `);
  const board = add('div','');board.setAttribute('data-jobs-board','');
  const heading = add('h2',opts.jobId ? 'Customer job' : 'Customer jobs',board);
  if (!opts.jobId) add('p','Track work, customer replies and payment.',board);
  board.hidden = !!opts.workspace;

  const form = doc.createElement('form');form.setAttribute('aria-label','Find customer jobs');board.appendChild(form);form.hidden = !!opts.jobId;
  const searchLabel = add('label','Search customer, quote or invoice',form);const search = doc.createElement('input');search.type = 'search';search.maxLength = QUOTE_SIGNOFF_SEARCH_MAX;searchLabel.appendChild(search);
  const filterField=add('div','',form);const filterLabel = add('label','Show jobs',filterField);const filter = doc.createElement('select');filter.id = 'recued-customer-jobs-filter';
  filterLabel.setAttribute('for',filter.id);filterField.appendChild(filter);
  for (const value of CUSTOMER_JOB_FILTERS) { const option = doc.createElement('option');option.value = value;option.textContent = filters[value];filter.appendChild(option); }
  const archiveField=add('div','',form);const archiveLabel = add('label','Job history',archiveField);const archiveFilter = doc.createElement('select');archiveFilter.id = 'recued-customer-jobs-history';archiveLabel.setAttribute('for',archiveFilter.id);archiveField.appendChild(archiveFilter);
  for (const [value,text] of [['active','Active jobs'],['archived','Archived jobs'],['all','Active and archived jobs']]) { const option = doc.createElement('option');option.value = value!;option.textContent = text!;archiveFilter.appendChild(option); }
  const formActions = add('div','',form);formActions.className = 'job-actions';
  const submit = button('Search jobs',formActions);submit.type = 'submit';const refresh = button('Refresh jobs',formActions);
  const quick = add('nav','',board);quick.setAttribute('aria-label','Job quick views');quick.className = 'job-actions';quick.hidden = !!opts.jobId;
  const quickButtons = new Map<CustomerJobFilter,HTMLButtonElement>();
  for (const value of ['all','owner_review','overdue','waiting_customer','needs_attention'] as const) {
    const node = button(value === 'owner_review' ? 'Needs review' : value === 'waiting_customer' ? 'Waiting' : filters[value],quick);
    quickButtons.set(value,node);node.addEventListener('click',() => { filter.value = value;form.requestSubmit(); });
  }

  const accountsOpen = button('Customer accounts');accountsOpen.hidden = true;
  const agingOpen = button('Receivables aging');agingOpen.hidden = true;
  const retryJob=button('Retry job view',board);retryJob.hidden=true;retryJob.addEventListener('click',()=>{if(!loading)void load();});
  const message = add('p',opts.jobId ? 'Loading this job…' : 'Loading customer jobs…',board);message.setAttribute('role','status');message.setAttribute('aria-live','polite');
  const list = add('div','',board);list.setAttribute('data-job-list','');
  const paging = add('div','',board);paging.hidden = !!opts.jobId;paging.className = 'job-actions';const newer = button('Newer jobs',paging);const older = button('Older jobs',paging);
  let disposed = false;let loading = false;let generation = 0;let nextCursor: string | undefined;
  type Page = { cursor?: string;previous: Array<string | undefined> };
  let page: Page = { cursor: opts.initialState?.cursor,previous: opts.initialState?.previous ?? [] };let pending: Page | undefined;
  let query: { search: string;filter: CustomerJobFilter;archive: CustomerJobArchiveFilter } = { search: opts.initialState?.search ?? '',filter: opts.initialState?.filter ?? 'all',archive: opts.initialState?.archive ?? 'active' };
  search.value = query.search;filter.value = query.filter;archiveFilter.value = query.archive;
  let aging: ReturnType<typeof mountCustomerReceivablesAging> | null = null;
  let timeline: ReturnType<typeof mountCustomerJobTimeline> | null = null;
  let timelineReceiptReturn: (() => void) | undefined;
  let closeout: ReturnType<typeof mountCustomerJobCloseout> | null = null;
  let displayedQuery = { ...query };let hasLoaded = false;
  const changed = () => { if (!disposed) { void load();reminders?.update();paymentReminders?.update();accounts.update(); } };
  const completions = mountQuoteCompletionPanel({ document: doc,host: root,conn,editorOnly: true,reminders: !!opts.reminders,onChanged: changed });
  const reminders = opts.reminders ? mountQuoteCompletionReminders({ ...opts.reminders,autoLoad: false,editorOnly: true,host: root,document: doc,conn,
    canReviewEmail: (): boolean => !closeout?.isOpen() && !aging?.isOpen() && !timeline?.isOpen() && !accounts.hasOpenEmail() && !accounts.hasInFlightWork() && !paymentReminders?.hasOpenEmail() && !paymentReminders?.hasInFlightWork() && !paymentHistory.hasOpenEmail() && !paymentHistory.hasInFlightWork() && !paymentStatement.hasOpenEmail() && !paymentStatement.hasInFlightWork() }) : null;
  const paymentReminders = opts.reminders ? mountQuotePaymentReminders({ ...opts.reminders,autoLoad: false,editorOnly: true,host: root,document: doc,conn,
    canReviewEmail: (): boolean => !closeout?.isOpen() && !aging?.isOpen() && !timeline?.isOpen() && !accounts.hasOpenEmail() && !accounts.hasInFlightWork() && !reminders?.hasOpenEmail() && !reminders?.hasInFlightWork() && !paymentHistory.hasOpenEmail() && !paymentHistory.hasInFlightWork() && !paymentStatement.hasOpenEmail() && !paymentStatement.hasInFlightWork() }) : null;
  const paymentHistory = mountCustomerPaymentHistory({ host: root,document: doc,conn,mail: opts.reminders?.mail,payment: opts.payment,onCorrected: changed,
    canReviewEmail: (): boolean => !closeout?.isOpen() && !aging?.isOpen() && !timeline?.isOpen() && !accounts.hasOpenEmail() && !accounts.hasInFlightWork() && !reminders?.hasOpenEmail() && !reminders?.hasInFlightWork()
      && !paymentReminders?.hasOpenEmail() && !paymentReminders?.hasInFlightWork()
      && !paymentStatement.hasOpenEmail() && !paymentStatement.hasInFlightWork() });
  const paymentStatement = mountCustomerJobPaymentStatement({ host: root,document: doc,conn,mail: opts.reminders?.mail,
    canReviewEmail: (): boolean => !closeout?.isOpen() && !aging?.isOpen() && !timeline?.isOpen() && !accounts.hasOpenEmail() && !accounts.hasInFlightWork() && !reminders?.hasOpenEmail() && !reminders?.hasInFlightWork()
      && !paymentReminders?.hasOpenEmail() && !paymentReminders?.hasInFlightWork()
      && !paymentHistory.hasOpenEmail() && !paymentHistory.hasInFlightWork() });
  const accounts = mountCustomerAccountsPanel({ host: root,document: doc,conn,mail: opts.reminders?.mail,payment: opts.payment,now: opts.reminders?.now,onChanged: changed,
    onStateChanged: () => { queueMicrotask(() => { if (!disposed) controls(); }); },
    canReviewEmail: (): boolean => !closeout?.isOpen() && !aging?.isOpen() && !timeline?.isOpen() && !reminders?.hasOpenEmail() && !reminders?.hasInFlightWork()
      && !paymentReminders?.hasOpenEmail() && !paymentReminders?.hasInFlightWork()
      && !paymentHistory.hasOpenEmail() && !paymentHistory.hasInFlightWork()
      && !paymentStatement.hasOpenEmail() && !paymentStatement.hasInFlightWork() });
  accountsOpen.addEventListener('click',() => { if (!boardBusy() && !closeout?.isOpen() && !aging?.isOpen() && !timeline?.isOpen()) void accounts.open(() => accountsOpen.focus()); });
  let receiptReturnJob: string | null = null;
  const receipts = mountQuoteSignoffReceipt({ document: doc,host: root,
    read: id => conn('reception.signoff.receipt',{ signoff_id: id }),returnFocus: () => {
      if (disposed) return;
      if (timelineReceiptReturn) { const back = timelineReceiptReturn;timelineReceiptReturn = undefined;back();return; }
      for (const target of root.querySelectorAll<HTMLButtonElement>('[data-job-receipt-open]')) {
        if (target.getAttribute('data-job-receipt-open') === receiptReturnJob) { target.focus();return; }
      }
      submit.focus();
    } });
  const payment = opts.payment ? createQuoteSignoffPayment({ ...opts.payment,document: doc,host: root,
    readOffer: async id => (await conn('reception.signoff.list',{ signoff_id: id })).signoffs.find(entry => entry.signoff_id === id),
    onChanged: changed,onMessage: text => { message.hidden=false;message.textContent = text; } }) : null;
  const inFlight = (): boolean => aging?.hasInFlightWork() === true || timeline?.hasInFlightWork() === true || closeout?.hasInFlightWork() === true || accounts.hasInFlightWork() || paymentStatement.hasInFlightWork() || paymentHistory.hasInFlightWork() || completions.hasInFlightWork() || payment?.hasInFlightWork() === true || reminders?.hasInFlightWork() === true || paymentReminders?.hasInFlightWork() === true;
  // Keep board actions from replacing a source and its return to the captured report.
  const boardBusy = (): boolean => inFlight() || aging?.hasOpenSource() === true;
  const controls = () => {
    const busy = boardBusy();accountsOpen.disabled = busy;agingOpen.disabled = busy;submit.disabled = busy;refresh.disabled = busy;
    const sameQuery = query.search === displayedQuery.search && query.filter === displayedQuery.filter && query.archive === displayedQuery.archive;
    newer.disabled = loading || busy || !sameQuery || page.previous.length === 0;older.disabled = loading || busy || !sameQuery || !nextCursor;
    paging.hidden = !!opts.jobId || (!page.previous.length && !nextCursor);
    for (const [value,node] of quickButtons) { node.setAttribute('aria-pressed',String(value === query.filter));node.disabled = busy; }
  };
  const canReviewJob = () => !accounts.hasUnsavedChanges() && !accounts.hasOpenEmail() && !paymentStatement.hasUnsavedChanges() && !paymentStatement.hasOpenEmail()
    && !paymentHistory.hasUnsavedChanges() && !paymentHistory.hasOpenEmail() && !completions.hasUnsavedChanges()
    && !reminders?.isOpen() && !reminders?.hasUnsavedChanges() && !reminders?.hasOpenEmail() && !paymentReminders?.isOpen() && !paymentReminders?.hasUnsavedChanges() && !paymentReminders?.hasOpenEmail();
  const canCloseout = () => !aging?.isOpen() && !timeline?.isOpen() && canReviewJob();
  const canTimeline = () => !aging?.isOpen() && !closeout?.isOpen() && canReviewJob();
  const canAging = () => !timeline?.isOpen() && !closeout?.isOpen() && !boardBusy() && canReviewJob();
  aging = mountCustomerReceivablesAging({ host: root,document: doc,conn,canOpen: canAging,
    onStateChanged: () => { queueMicrotask(() => { if (!disposed) controls(); }); },
    onAction: (action,row,back) => {
      if (action === 'invoice') { void paymentHistory.open(row.signoff_id,back);return; }
      timelineJob = row.job_id;void timeline?.open(row.job_id,back);
    },
  });
  agingOpen.addEventListener('click',() => {
    if (disposed || boardBusy()) return;
    if (!canAging()) { message.textContent = 'Save or close job, account, payment or email work before opening receivables aging.';return; }
    void aging?.open(() => agingOpen.focus());
  });
  timeline = mountCustomerJobTimeline({ host: root,document: doc,conn,canOpen: canTimeline,
    onStateChanged: () => { queueMicrotask(() => { if (!disposed) controls(); }); },
    onAction: (event,back) => {
      if (event.action === 'closeout' && timelineJob) { void closeout?.open(timelineJob,back);return; }
      if (!event.signoff_id) { back();return; }
      if (event.action === 'payment_history') { void paymentHistory.open(event.signoff_id,back);return; }
      timelineReceiptReturn = back;void receipts.open(event.signoff_id);
    },
  });
  closeout = mountCustomerJobCloseout({ host: root,document: doc,conn,canOpen: canCloseout,onChanged: () => {changed();if(opts.jobId) opts.onCloseWorkspace?.();},
    onStateChanged: () => { queueMicrotask(() => { if (!disposed) controls(); }); } });
  let timelineJob: string | undefined;let initialViewOpened = false;let capturedAt = Date.now();
  const dueLabel = (invoice: CustomerJob['invoices'][number]) => {
    const value = invoice.follow_up?.invoice;if (value?.availability !== 'current') return '';
    let age = 0;try { const timeZone=opts.payment?.serverTimeZone?.();if(timeZone){const day = new Intl.DateTimeFormat('sv-SE',{timeZone}).format(new Date(capturedAt));age = Math.floor((Date.parse(day+'T00:00:00Z')-Date.parse(value.due_on+'T00:00:00Z'))/86400000);} } catch { /* Keep the server-supplied overdue state when a zone is unavailable. */ }
    return `Due ${value.due_on}${value.overdue ? age > 0 ? ` · ${age} days overdue` : ' · overdue' : ''}`;
  };
  const reviewTarget = (job: CustomerJob) => job.completion_matches_agreement && job.completion?.review === 'waiting' ? job.completion.completion_id : job.offer.signoff_id;
  const renderSummary = (job: CustomerJob) => {
    const card = add('article','',list);card.setAttribute('data-job-id',job.job_id);card.className = 'job-summary';
    const identity = add('div','',card);add('h3',`${job.quote_label} — ${job.customer}`,identity);
    if (job.quote_reference) add('p',job.quote_reference,identity);
    const flags = add('p','',identity);flags.className = 'job-flags';flags.textContent = [job.archive?.archived_at ? 'Archived' : '',job.needs_owner_review ? 'Needs review' : '',job.corrections ? 'Corrections requested' : '',job.payment.overdue ? 'Overdue' : '',job.waiting_customer ? 'Waiting on customer' : '',job.needs_attention ? 'Needs attention' : '',job.offer.availability!=='current' ? 'Offer '+job.offer.availability : ''].filter(Boolean).join(' · ');
    add('p',workLabels[job.work],card);
    const money = add('div','',card);add('p',job.payment.status === 'not_invoiced' ? 'No invoice released' : job.payment.outstanding === null ? 'Balance needs review' : `${job.payment.outstanding} ${job.currency} outstanding`,money);
    const overdue = job.invoices.filter(i=>i.follow_up?.invoice.availability === 'current' && i.follow_up.invoice.overdue);
    const dueInvoice=overdue[0] ?? [...job.invoices].filter(i=>i.follow_up?.invoice.availability==='current' && i.follow_up.invoice.status==='open').sort((a,b)=>a.due_on.localeCompare(b.due_on))[0];
    if(dueInvoice)add('p',dueLabel(dueInvoice),money);
    if (job.payment.refund_due && job.payment.refund_due !== '0.0000') add('p',`Refund owed: ${job.payment.refund_due} ${job.currency}`,money);
    const actions = add('div','',card);actions.className = 'job-actions';
    const jobLink=(text:string,tab:CustomerJobTab)=>{const a=link(text,receptionCustomerJobAddress(job.job_id,tab).hash,actions);a.addEventListener('click',event=>{const click=event as MouseEvent;if(opts.onOpenJob && !click.ctrlKey && !click.metaKey && !click.shiftKey && !click.altKey && !click.button){event.preventDefault();opts.onOpenJob(job.job_id,tab);}});return a;};
    jobLink('Open job','overview').setAttribute('data-job-open',job.job_id);
    const next=job.needs_owner_review ? link('Review reply',receptionInboxTargetAddress(reviewTarget(job)),actions)
      : job.waiting_customer ? link('View request',receptionSignoffAddress(job.offer.signoff_id),actions)
      : jobLink(job.payment.overdue ? 'Review payment' : job.corrections ? 'Review corrections' : 'View activity',job.payment.overdue ? 'billing' : 'activity');
    next.className = 'job-primary-action';
  };
  const renderDetail = (job: CustomerJob) => {
    opts.onJobLoaded?.(job);
    const card = add('article','',list);card.setAttribute('data-job-id',job.job_id);
    add('h3','Agreement and current status',card);
    const archived = job.archive?.archived_at != null;
    if (archived) add('p',job.archive?.needs_review ? 'Archived job changed — restore and review it.' : 'Archived job',card);
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
        : job.payment.refund_due && job.payment.refund_due !== '0.0000' ? 'Refund owed to customer'
        : job.payment.amount_refunded && job.payment.amount_refunded !== '0.0000' && job.payment.outstanding === '0.0000' ? 'Balance settled after recorded refund'
        : job.payment.status === 'credited' ? 'Balance cleared with invoice credits'
        : job.payment.status === 'paid' ? 'Recorded paid in full'
          : `${job.payment.outstanding} ${job.currency} outstanding${job.payment.overdue ? ' · overdue' : ''}`,balance);
    if (job.payment.amount_paid !== null) add('p',`Recorded paid: ${job.payment.amount_paid} ${job.currency}`,balance);
    if (job.payment.amount_credited) add('p',`Recorded credits: ${job.payment.amount_credited} ${job.currency}`,balance);
    if (job.payment.amount_refund_credited!==undefined && job.payment.outstanding!==null) add('p',`Customer still owes: ${job.payment.outstanding} ${job.currency}`,balance);
    customerRefundBalanceLines(job.payment,job.currency).forEach(line=>add('p',line,balance));
    if (job.needs_attention) add('p',job.payment.refund_due && job.payment.refund_due !== '0.0000' ? 'A refund is owed. Record it after returning the money to the customer.' : 'This job needs attention. Review unavailable records or ended reviews before continuing.',card);
    const scope = add('details','',card);add('summary',job.agreed_scope === null ? 'Offered scope' : 'Agreed scope',scope);add('pre',job.agreed_scope ?? job.offer.scope,scope);
    const actions = add('div','',card);actions.className = 'job-actions';
    if (job.needs_owner_review) link('Review in Reception Inbox',receptionInboxTargetAddress(reviewTarget(job)),actions);
    if (job.offer.release_review === 'closed' || job.completion?.review === 'closed' && job.completion.owner_action === null) link('Review in Runs','#logs',actions);
    if (job.agreement?.task_id && job.agreement.follow_up?.task.availability === 'current') link('Open task',`#data/task/${encodeURIComponent(job.agreement.task_id)}`,actions);
    if (!archived && job.can_request_completion && job.agreement) {
      const request = button('Request completion',actions);request.setAttribute('data-job-action','completion');
      request.addEventListener('click',() => { if (!disposed && !boardBusy() && !closeout?.isOpen() && !aging?.isOpen() && !timeline?.isOpen()) { completions.open(job.agreement!);controls(); } });
    }
    if (!archived && reminders && job.completion_matches_agreement && job.completion?.state === 'waiting'
      && job.completion.availability === 'current' && job.completion.response.decision === 'not_recorded') {
      const follow = button('Follow up on completion',actions);follow.setAttribute('data-job-action',`completion-follow-up:${job.completion.completion_id}`);
      follow.addEventListener('click',() => { if (!disposed && !boardBusy() && !closeout?.isOpen() && !aging?.isOpen() && !timeline?.isOpen()) void reminders.open(job.completion!,() => {
        const replacement = [...list.querySelectorAll<HTMLElement>('button[data-job-action]')].find(node =>
          node.closest('[data-job-id]')?.getAttribute('data-job-id') === job.job_id
          && node.getAttribute('data-job-action') === `completion-follow-up:${job.completion!.completion_id}`);
        (replacement ?? submit).focus();
      }); });
    }
    if (!archived && paymentReminders) for (const invoice of job.invoices) if (canRecordSignoffPayment(invoice)) {
      const follow = button(`Follow up on payment — ${invoice.invoice_ref}`,actions);
      const action = `payment-follow-up:${invoice.signoff_id}`;follow.setAttribute('data-job-action',action);
      follow.addEventListener('click',() => { if (!disposed && !boardBusy() && !closeout?.isOpen() && !aging?.isOpen() && !timeline?.isOpen()) void paymentReminders.open(invoice,() => {
        const replacement = [...list.querySelectorAll<HTMLElement>('button[data-job-action]')].find(node =>
          node.closest('[data-job-id]')?.getAttribute('data-job-id') === job.job_id && node.getAttribute('data-job-action') === action);
        (replacement ?? submit).focus();
      }); });
    }
    if (!archived && payment) for (const invoice of job.invoices) if (canRecordSignoffPayment(invoice)) {
      const pay = button(`Record payment — ${invoice.invoice_ref}`,actions);
      pay.setAttribute('data-job-action',`payment:${invoice.signoff_id}`);
      pay.addEventListener('click',() => { if (!disposed && !boardBusy() && !closeout?.isOpen() && !aging?.isOpen() && !timeline?.isOpen()) void payment.open(invoice).finally(controls); });
    }
    for (const invoice of job.invoices) {
      for (const [section,label] of [['credits','Issue credit'],['refunds','Refunds'],['documents','Documents']] as const) {
        const tool=button(`${label} — ${invoice.invoice_ref}`,actions);const key=`billing-${section}:${invoice.signoff_id}`;tool.setAttribute('data-job-action',key);
        tool.addEventListener('click',()=>{if(!disposed && !boardBusy())void paymentHistory.openSection(invoice.signoff_id,section,()=>{
          const replacement=[...list.querySelectorAll<HTMLElement>('[data-job-action]')].find(n=>n.getAttribute('data-job-action')===key);(replacement??submit).focus();
        });});
      }
      const action = `payment-history:${invoice.signoff_id}`;
      const history = button(`View payment history — ${invoice.invoice_ref}`,actions);history.setAttribute('data-job-action',action);
      history.addEventListener('click',() => { if (!disposed && !boardBusy() && !closeout?.isOpen() && !aging?.isOpen() && !timeline?.isOpen()) void paymentHistory.open(invoice.signoff_id,() => {
        const replacement = [...list.querySelectorAll<HTMLElement>('button[data-job-action]')].find(node =>
          node.closest('[data-job-id]')?.getAttribute('data-job-id') === job.job_id && node.getAttribute('data-job-action') === action);
        (replacement ?? submit).focus();
      }); });
    }
    if (job.invoices.length) {
      const statement = button('View job payment statement',actions);statement.setAttribute('data-job-action','payment-statement');
      statement.addEventListener('click',() => { if (!disposed && !boardBusy() && !closeout?.isOpen() && !aging?.isOpen() && !timeline?.isOpen()) void paymentStatement.open(job.job_id,() => {
        const replacement = [...list.querySelectorAll<HTMLElement>('button[data-job-action]')].find(node =>
          node.closest('[data-job-id]')?.getAttribute('data-job-id') === job.job_id && node.getAttribute('data-job-action') === 'payment-statement');
        (replacement ?? submit).focus();
      }); });
    }
    const viewTimeline = button('View job timeline',actions);viewTimeline.setAttribute('data-job-action','timeline');
    viewTimeline.addEventListener('click',() => {
      if (disposed || boardBusy()) return;
      if (!canTimeline()) { message.textContent = 'Save or close your job, account, payment or email edits before opening a timeline.';return; }
      timelineJob = job.job_id;void timeline?.open(job.job_id,() => {
        const replacement = [...list.querySelectorAll<HTMLElement>('[data-job-action=timeline]')].find(node => node.closest('[data-job-id]')?.getAttribute('data-job-id') === job.job_id);
        (replacement ?? submit).focus();
      });
    });
    const reviewCloseout = button(archived ? 'Review archived job' : 'Review closeout',actions);reviewCloseout.setAttribute('data-job-action','closeout');
    reviewCloseout.addEventListener('click',() => {
      if (disposed || boardBusy()) return;
      if (!canCloseout()) { message.textContent = 'Save or close your job, account, payment or email edits before reviewing closeout.';return; }
      void closeout?.open(job.job_id,() => {
        const replacement = [...list.querySelectorAll<HTMLElement>('[data-job-action=closeout]')].find(node => node.closest('[data-job-id]')?.getAttribute('data-job-id') === job.job_id);
        (replacement ?? submit).focus();
      });
    });
    const receipt = button('View sign-off receipt',actions);receipt.setAttribute('data-job-receipt-open',job.job_id);receipt.setAttribute('data-job-action','receipt');
    receipt.addEventListener('click',() => { if (!disposed && !boardBusy() && !aging?.isOpen() && !timeline?.isOpen() && !closeout?.isOpen()) { timelineReceiptReturn = undefined;receiptReturnJob = job.job_id;void receipts.open((job.agreement ?? job.offer).signoff_id); } });
    link('View sign-off request',receptionSignoffAddress(job.offer.signoff_id),actions);
    const tab = opts.tab ?? 'overview';
    const allowed = (node: Element) => {
      const action = node.getAttribute('data-job-action') ?? '';
      if (tab === 'billing') return action.startsWith('payment:') || action.startsWith('payment-history:') || action.startsWith('billing-') || action === 'payment-statement';
      if (tab === 'followups') return action.includes('follow-up:');
      if (tab !== 'overview') return false;
      return action === 'completion' || action === 'receipt' || node.getAttribute('href')?.startsWith('#data/task/') || node.getAttribute('href')?.startsWith('#reception/inbox/') || node.getAttribute('href')?.startsWith('#reception/signoffs/');
    };
    for (const node of [...actions.children]) if (!allowed(node)) node.remove();
    if (tab !== 'overview') for (const node of [...card.children]) if (node !== actions) (node as HTMLElement).hidden = true;
    if (tab === 'billing') {
      actions.classList.add('job-billing-list');
      for (const invoice of job.invoices) {
        const group = add('div','',actions);group.className = 'job-invoice';add('h3',invoice.invoice_ref,group);
        const balance = invoice.follow_up?.invoice;
        add('p',balance?.availability === 'current' ? `${balance.outstanding} ${invoice.currency} outstanding · ${dueLabel(invoice)}` : 'Balance needs review',group);
        const tools = add('div','',group);tools.className = 'job-actions';
        if(invoice.invoice_id)link('Open invoice record',customerInvoiceRecordAddress(invoice.invoice_id),tools);
        for (const node of [...actions.children]) if (node.getAttribute('data-job-action')?.endsWith(':'+invoice.signoff_id)) tools.appendChild(node);
      }
      if (!job.invoices.length) add('p','No invoice has been released for this job.',actions);
    }
    if (tab === 'followups' && !actions.children.length) add('p','No unanswered completion request or open invoice needs a follow-up. Offer follow-ups are available beside the sign-off request.',actions);
    list.hidden = tab === 'activity' || tab === 'closeout';
    heading.textContent = `${job.quote_label} — ${job.customer}`;
    if (!initialViewOpened) {
      initialViewOpened = true;
      if (tab === 'activity') { timelineJob = job.job_id;void timeline?.open(job.job_id,opts.onCloseWorkspace ?? (()=>{})); }
      else if (tab === 'closeout') void closeout?.open(job.job_id,opts.onCloseWorkspace ?? (()=>{}));
      else focusCustomerWorkspace(board);
    }

  };
  const readSelectedJob=async():Promise<CustomerJobsListResult>=>{
    const report=await conn('reception.jobs.closeout.get',{job_id:opts.jobId!});
    if(report.job_id!==opts.jobId || report.job && report.job.job_id!==opts.jobId)throw new Error('This response belongs to another job. Retry this job view.');
    return {captured_at:report.captured_at,jobs:report.job ? [report.job] : []};
  };
  const load = async (desired = pending ?? page) => {
    if (disposed) return;const current = ++generation;const savedQuery = { ...query };pending = desired;loading = true;controls();
    try {
      const result: CustomerJobsListResult = opts.jobId ? await readSelectedJob() : await conn('reception.jobs.list',{ limit: 50,...(savedQuery.search ? { search: savedQuery.search } : {}),
        ...(savedQuery.filter !== 'all' ? { filter: savedQuery.filter } : {}),...(savedQuery.archive !== 'active' ? { archive: savedQuery.archive } : {}),...(desired.cursor ? { cursor: desired.cursor } : {}) });
      if (disposed || current !== generation) return;
      const focused = [...list.querySelectorAll<HTMLElement>('button,a,summary')].find(node => node === doc.activeElement);
      const focusJob = focused?.closest('[data-job-id]')?.getAttribute('data-job-id');const action = focused ? focusKey(focused) : null;
      const expanded = new Set([...list.querySelectorAll<HTMLDetailsElement>('details[open]')]
        .map(node => node.closest('[data-job-id]')?.getAttribute('data-job-id')));
      page = { cursor: desired.cursor,previous: [...desired.previous] };pending = undefined;nextCursor = result.next_cursor;
      retryJob.hidden=true;capturedAt = result.captured_at;displayedQuery = savedQuery;hasLoaded = true;list.replaceChildren();
      for (const job of result.jobs) { if (opts.jobId) renderDetail(job);else renderSummary(job); }
      for (const details of list.querySelectorAll<HTMLDetailsElement>('details')) {
        details.open = expanded.has(details.closest('[data-job-id]')?.getAttribute('data-job-id'));
      }
      if (focused && focusJob && action) {
        const replacement = [...list.querySelectorAll<HTMLElement>('button,a,summary')].find(node =>
          node.closest('[data-job-id]')?.getAttribute('data-job-id') === focusJob && focusKey(node) === action);
        if(replacement)replacement.focus();else if(opts.jobId)focusCustomerWorkspace(board);else submit.focus();
      }
      if (!result.jobs.length) { add('p',opts.jobId ? 'This job is unavailable. Return to Jobs and refresh.' : result.scan_limited && result.next_cursor
        ? 'More saved jobs remain to check. Choose Older jobs to keep looking.'
        : savedQuery.search || savedQuery.filter !== 'all' || savedQuery.archive !== 'active' || desired.cursor || (result.scanned_jobs ?? 0)>0
          ? 'No customer jobs match this view.' : 'No customer jobs yet. Start with a customer quote.',list);
        if (!opts.jobId && !savedQuery.search && savedQuery.filter === 'all' && savedQuery.archive === 'active') link('Start a customer quote','#reception/signoffs/new',list);
      }
      opts.onBoardStateChanged?.();
      message.hidden=!!opts.jobId && result.jobs.length>0;
      message.textContent = opts.jobId ? result.jobs[0] ? `${workLabels[result.jobs[0].work]} · ${result.jobs[0].payment.outstanding ?? 'Unavailable'} ${result.jobs[0].currency} outstanding` : 'This job is unavailable.' : `${result.jobs.length} ${result.jobs.length === 1 ? 'job' : 'jobs'} on this page.`
        +(result.scan_limited && result.next_cursor ? ' More jobs remain to check for this view. Choose Older jobs to continue.' : '');
    } catch (error) { if (!disposed && current === generation) {retryJob.hidden=!opts.jobId;message.hidden=false;message.textContent = (error instanceof Error ? error.message : 'Customer jobs could not be loaded. Try again.')
      + (hasLoaded ? ' Previously loaded jobs remain visible. Refresh jobs to retry this view.' : '');} }
    finally { if (!disposed && current === generation) { loading = false;controls(); } }
  };
  form.addEventListener('submit',event => { event.preventDefault();if (boardBusy()) return;query = { search: search.value.trim(),filter: filter.value as CustomerJobFilter,archive: archiveFilter.value as CustomerJobArchiveFilter };pending = undefined;void load({ previous: [] }); });
  refresh.addEventListener('click',() => { if (!boardBusy()) void load(); });
  older.addEventListener('click',() => { if (!loading && !boardBusy() && nextCursor) void load({ cursor: nextCursor,previous: [...page.previous,page.cursor] }); });
  newer.addEventListener('click',() => { if (!loading && !boardBusy() && page.previous.length) void load({ cursor: page.previous.at(-1),previous: page.previous.slice(0,-1) }); });
  const interval = setInterval(() => { if (!disposed && root.isConnected && !opts.workspace && !loading && !inFlight()) void load();reminders?.update();paymentReminders?.update();accounts.update(); },20_000);
  searchLabel.className = 'job-search-field';
  const moreFilters = add('details','',form);moreFilters.setAttribute('data-job-more-filters','');add('summary','Filters',moreFilters);moreFilters.append(filterField,archiveField);
  if (query.filter !== 'all' || query.archive !== 'active') (moreFilters as HTMLDetailsElement).open = true;
  controls();
  if (opts.workspace === 'accounts') void accounts.open(opts.onCloseWorkspace);
  else if (opts.workspace === 'receivables') void aging?.open(opts.onCloseWorkspace ?? (()=>{}));
  else void load();
  return { suspend:()=>{generation++;loading=false;pending=undefined;query={...displayedQuery};search.value=query.search;filter.value=query.filter;archiveFilter.value=query.archive;controls();},getBoardState: (): CustomerJobsBoardState => ({ ...(hasLoaded?displayedQuery:query),cursor: page.cursor,previous: [...page.previous] }),update: changed,hasUnsavedChanges: () => payment?.hasUnsavedChanges() === true || accounts.hasOpenEmail() || paymentStatement.hasOpenEmail() || paymentHistory.hasOpenEmail() || closeout?.hasUnsavedChanges() === true || accounts.hasUnsavedChanges() || paymentStatement.hasUnsavedChanges() || paymentHistory.hasUnsavedChanges() || completions.hasUnsavedChanges() || reminders?.hasUnsavedChanges() === true || paymentReminders?.hasUnsavedChanges() === true,hasInFlightWork: inFlight,
    dispose: () => { disposed = true;generation++;clearInterval(interval);aging?.dispose();timeline?.dispose();closeout?.dispose();accounts.dispose();paymentStatement.dispose();paymentHistory.dispose();completions.dispose();reminders?.dispose();paymentReminders?.dispose();receipts.dispose();payment?.dispose();root.remove(); } };
};
