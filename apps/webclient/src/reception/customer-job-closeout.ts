import { customerInvoiceRecordAddress } from '../data/records-navigation.js';
import { receptionSignoffAddress,receptionInboxTargetAddress } from './navigation.js';
import { focusCustomerWorkspace,restoreCustomerWorkspaceControl } from './customer-workspace-focus.js';
import type { Conn,ServerRpcRegistry,CustomerJobCloseoutReport } from '@recued/contracts';
export type CustomerJobCloseoutConn = Conn<Pick<ServerRpcRegistry,'reception.jobs.closeout.get' | 'reception.jobs.archive' | 'reception.jobs.restore'>>;
/** Keep the reviewed copy outside refreshed job cards. Archive never executes a payment or task action. */
export const mountCustomerJobCloseout = (opts: { host: HTMLElement;document: Document;conn: CustomerJobCloseoutConn;
  canOpen: () => boolean;onChanged: () => void;onStateChanged: () => void }) => {
  const { document: doc,conn } = opts;
  const root = doc.createElement('section');root.hidden = true;root.tabIndex = -1;root.setAttribute('data-job-closeout','');root.setAttribute('aria-label','Job closeout');opts.host.appendChild(root);
  const add = (tag: string,text: string) => { const node = doc.createElement(tag);node.textContent = text;root.appendChild(node);return node; };
  add('style',`[data-job-closeout]{display:grid;gap:12px;min-width:0;padding:18px;border:1px solid var(--border,#ddd);border-radius:12px;overflow-wrap:anywhere}
    [data-job-closeout][hidden]{display:none!important}[data-job-closeout-copy]{display:grid;gap:8px;min-width:0}
    [data-job-closeout] label{display:flex;align-items:flex-start;gap:10px}[data-job-closeout] input[type=checkbox]{flex-shrink:0;margin-top:3px}
    [data-job-closeout-actions]{display:flex;flex-wrap:wrap;gap:10px}`);
  add('h3','Job closeout');add('p','Review the saved work, customer reply and money records. Archiving keeps all records and stops this job’s reminder sends. Restore it before starting more work.');
  const status = add('p','');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const copy = add('div','');copy.setAttribute('data-job-closeout-copy','');
  const label = add('label','');const confirm = doc.createElement('input');confirm.type = 'checkbox';label.appendChild(confirm);
  const confirmation = doc.createElement('span');confirmation.textContent = 'I reviewed this job’s work, customer replies, balances and follow-ups.';label.appendChild(confirmation);
  const actions = add('div','');actions.setAttribute('data-job-closeout-actions','');
  const button = (text: string,body: () => void) => { const node = doc.createElement('button');node.type = 'button';node.textContent = text;node.addEventListener('click',body);actions.appendChild(node);return node; };
  const refresh = button('Recheck closeout',() => { if (!busy && jobId) void load(jobId,refresh); });
  const archive = button('Archive job',() => { if (!busy && selected?.can_archive && confirm.checked && selected.snapshot_hash) void mutate('archive'); });
  const restore = button('Restore job',() => { if (!busy && selected?.archive.archived_at !== null && selected) void mutate('restore'); });
  const close = button('Close job closeout',() => { if (!busy) finish(); });
  let jobId: string | null = null;let reviewStale = false;let selected: CustomerJobCloseoutReport | null = null;let busy = false;let focusOnLoad = false;let disposed = false;let generation = 0;let returnFocus: (() => void) | undefined;
  const controls = () => {
    refresh.disabled = busy || !jobId;close.disabled = busy;confirm.disabled = busy || !selected?.can_archive;
    archive.hidden = selected?.archive.archived_at != null;restore.hidden = selected?.archive.archived_at == null;
    archive.disabled = busy || reviewStale || !selected?.can_archive || !confirm.checked;restore.disabled = busy || reviewStale || !selected;
    opts.onStateChanged();
  };
  const finish = () => { root.hidden = true;selected = null;jobId = null;reviewStale = false;confirm.checked = false;generation++;controls();returnFocus?.(); };
  const render = (report: CustomerJobCloseoutReport) => {
    copy.replaceChildren();const line = (text: string) => { const node = doc.createElement('p');node.textContent = text;copy.appendChild(node); };
    if (report.job) {
      const job = report.job;line(`${job.quote_label} — ${job.customer}`);line(`Job ${job.job_id}`);
      line(`Offer: ${job.offer.state.replaceAll('_',' ')}`);line(`Work: ${job.work.replaceAll('_',' ')}`);
      const reply = job.completion;line(`Customer completion: ${!reply ? 'not requested' : !job.completion_matches_agreement ? 'belongs to earlier work' : reply.state === 'cancelled' ? 'cancelled' : reply.response.decision.replaceAll('_',' ')}`);
      line(job.agreement ? `Customer still owes: ${job.payment.outstanding ?? 'unavailable'} ${job.currency}` : 'No invoice or work was released.');
      if (job.agreement) line(`Refund still owed: ${job.payment.status==='unavailable' ? 'unavailable' : job.payment.refund_due ?? '0.0000'} ${job.currency}`);
      for (const invoice of job.invoices) line(invoice.follow_up?.invoice.availability === 'current'
        ? `Invoice ${invoice.invoice_ref}: ${invoice.follow_up.invoice.outstanding} ${job.currency} still owed; due ${invoice.follow_up.invoice.due_on}.`
        : `Invoice ${invoice.invoice_ref}: balance needs review.`);
      const scope = doc.createElement('details');const summary = doc.createElement('summary');summary.textContent = job.agreed_scope === null ? 'Offered scope' : 'Agreed scope';scope.appendChild(summary);
      const wording = doc.createElement('pre');wording.textContent = job.agreed_scope ?? job.offer.scope;scope.appendChild(wording);copy.appendChild(scope);
    }
    line(`${report.reminders.saved_schedules} saved follow-up schedules; ${report.reminders.uncertain_sends} unknown email outcomes.`);
    line('Saved schedules stay saved. Archived job reminders cannot notify, prepare email or send. Owner-paused schedules stay paused after restore. Account statements keep linked archived jobs.');
    if (report.archive.archived_at !== null) line(`Archived ${new Date(report.archive.archived_at).toLocaleString()}.`);
    if (report.job?.archive?.needs_review) line('The job changed after closeout. Restore it and review the changes.');
    if (report.blockers.length) {
      const heading = doc.createElement('h4');heading.textContent='Before you archive';copy.appendChild(heading);
      const checklist=doc.createElement('ul');checklist.setAttribute('data-closeout-checklist','');copy.appendChild(checklist);
      for(const text of report.blockers){const item=doc.createElement('li');item.textContent=text;checklist.appendChild(item);}
      const resolve=doc.createElement('nav');resolve.setAttribute('aria-label','Resolve closeout blockers');resolve.className='job-actions';copy.appendChild(resolve);
      const action=(text:string,href:string)=>{const a=doc.createElement('a');a.textContent=text;a.href=href;resolve.appendChild(a);};
      const job=report.job;
      if(job?.agreement?.task_id)action('Open task','#data/task/'+encodeURIComponent(job.agreement.task_id));
      for(const invoice of job?.invoices ?? [])if(invoice.invoice_id)action('Review invoice '+invoice.invoice_ref,customerInvoiceRecordAddress(invoice.invoice_id));
      if(job?.needs_owner_review)action('Review customer reply',receptionInboxTargetAddress(job.completion_matches_agreement && job.completion?.review === 'waiting' ? job.completion.completion_id : job.offer.signoff_id));
      if(job)action('Review sign-off request',receptionSignoffAddress(job.offer.signoff_id));
      if(report.reminders.uncertain_sends)action('Check email outcome','#mail');
    }
    if (report.events.length) { line('Recent archive history');report.events.forEach(event => line(`${event.action === 'archive' ? 'Archived' : 'Restored'} ${new Date(event.recorded_at).toLocaleString()}`)); }
    if (report.has_older_events) line('Earlier archive events remain saved. This view shows the latest 50.');
  };
  const message = (error: unknown) => error instanceof Error ? error.message : 'Job closeout could not be completed. Refresh and try again.';
  const load = async (id: string,trigger?:HTMLElement) => {
    if (disposed || busy) return;const priorFocus=doc.activeElement;const source=trigger ?? (root.contains(priorFocus)?priorFocus as HTMLElement:null);const current = ++generation;busy = true;confirm.checked = false;controls();status.textContent = 'Loading current closeout…';
    try {
      const report = await conn('reception.jobs.closeout.get',{ job_id: id });
      if (disposed || current !== generation) return;
      if (report.job_id !== id || report.archive.job_id !== id) throw new Error('The closeout belongs to another job. Refresh and try again.');
      selected = report;reviewStale = false;render(report);status.textContent = report.can_archive ? 'This job is ready for your closeout review.' : report.archive.archived_at !== null ? 'This job is archived. Restore keeps its history.' : 'Finish the listed items before archiving.';
    } catch (error) { if (!disposed && current === generation) { selected = null;copy.replaceChildren();status.textContent = message(error); } }
    finally { if (!disposed && current === generation) { busy = false;controls();if (focusOnLoad) { focusOnLoad = false;focusCustomerWorkspace(root); }else restoreCustomerWorkspaceControl(doc,source,[refresh],priorFocus); } }
  };
  const mutate = async (action: 'archive' | 'restore') => {
    if (disposed || busy || reviewStale || !selected || !opts.canOpen()) return;const target = selected;
    busy = true;controls();
    try {
      const result = action === 'archive' ? await conn('reception.jobs.archive',{ job_id: target.job_id,expected_revision: target.archive.revision,
        expected_snapshot_hash: target.snapshot_hash!,confirmed: true }) : await conn('reception.jobs.restore',{ job_id: target.job_id,expected_revision: target.archive.revision });
      if (disposed) return;
      if (result.job_id !== target.job_id || result.revision !== target.archive.revision+1 || (result.archived_at !== null) !== (action === 'archive')) throw new Error('The archive result could not be confirmed. Refresh closeout before trying again.');
      busy = false;finish();opts.onChanged();
    } catch (error) { if (!disposed) { confirm.checked = false;reviewStale = true;status.textContent = message(error); } }
    finally { if (!disposed) { busy = false;controls(); } }
  };
  confirm.addEventListener('change',controls);controls();
  return { open: async (id: string,onClosed: () => void) => {
    if (disposed || busy || !opts.canOpen()) return;
    if (!root.hidden && confirm.checked) { status.textContent = 'Close this closeout before reviewing another job.';return; }
    focusOnLoad = true;jobId = id;reviewStale = false;returnFocus = onClosed;selected = null;copy.replaceChildren();root.hidden = false;await load(id);
  },isOpen: () => !root.hidden,hasUnsavedChanges: () => confirm.checked,hasInFlightWork: () => busy,
  dispose: () => { disposed = true;generation++;root.remove(); } };
};
