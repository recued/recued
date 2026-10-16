import { focusCustomerWorkspace,restoreCustomerWorkspaceControl } from './customer-workspace-focus.js';
import { CUSTOMER_JOB_TIMELINE_CATEGORIES,type Conn,type ServerRpcRegistry,type CustomerJobTimeline,
  type CustomerJobTimelineCategory,type CustomerJobTimelineEvent } from '@recued/contracts';

export type CustomerJobTimelineConn = Conn<Pick<ServerRpcRegistry,'reception.jobs.timeline'>>;
const labels: Record<CustomerJobTimelineCategory,string> = { all: 'All activity',agreements: 'Offers and added work',work: 'Work and completion',money: 'Invoices and money',followups: 'Emails and follow-ups',archive: 'Archive history' };
export const mountCustomerJobTimeline = (opts: { host: HTMLElement;document: Document;conn: CustomerJobTimelineConn;
  canOpen: () => boolean;onStateChanged: () => void;onAction: (event: CustomerJobTimelineEvent,returnToTimeline: () => void) => void }) => {
  const { document: doc } = opts;
  const root = doc.createElement('section');root.hidden = true;root.tabIndex = -1;root.setAttribute('data-job-timeline','');root.setAttribute('aria-label','Job timeline');opts.host.appendChild(root);
  const add = (tag: string,text: string,host: HTMLElement = root) => { const node = doc.createElement(tag);node.textContent = text;host.appendChild(node);return node; };
  add('style',`[data-job-timeline]{display:grid;gap:14px;padding:18px;border:1px solid var(--border,#ddd);border-radius:12px;min-width:0;overflow-wrap:anywhere}
    [data-job-timeline][hidden]{display:none!important}[data-job-timeline] form,[data-job-timeline-summary]{display:grid;gap:10px}
    [data-job-timeline] ol{display:grid;gap:14px;margin:0;padding-left:24px}[data-job-timeline] li{display:grid;gap:8px;border-left:3px solid var(--border,#ddd);padding:12px;min-width:0}
    [data-job-timeline] [data-timeline-actions]{display:flex;flex-wrap:wrap;gap:10px}[data-job-timeline] input,[data-job-timeline] select{max-width:100%}
    [data-job-timeline] h4{margin:0}[data-job-timeline] pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0}`);
  const heading = add('h3','Job timeline');add('p','Saved activity for one job. Current work and balances are shown separately. Refresh to check for newer activity.');
  const summary = add('div','');summary.setAttribute('data-job-timeline-summary','');
  const form = add('form','');form.setAttribute('aria-label','Find job activity');
  const searchLabel = add('label','Find activity',form);const search = doc.createElement('input');search.type = 'search';search.maxLength = 200;searchLabel.appendChild(search);
  const filterLabel = add('label','Activity type',form);const filter = doc.createElement('select');filter.id = 'recued-job-timeline-category';filterLabel.setAttribute('for',filter.id);form.appendChild(filter);
  for (const value of CUSTOMER_JOB_TIMELINE_CATEGORIES) { const node = doc.createElement('option');node.value = value;node.textContent = labels[value];filter.appendChild(node); }
  const button = (text: string,host: HTMLElement = root) => { const node = doc.createElement('button');node.type = 'button';node.textContent = text;host.appendChild(node);return node; };
  const apply = button('Find activity',form);apply.type = 'submit';
  const actions = add('div','');actions.setAttribute('data-timeline-actions','');const refresh = button('Refresh timeline',actions);const close = button('Close job timeline',actions);
  const status = add('p','');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const list = add('ol','');list.setAttribute('data-job-timeline-events','');
  const paging = add('div','');paging.setAttribute('data-timeline-actions','');const newer = button('Newer activity',paging);const older = button('Older activity',paging);
  let focusOnLoad = false;let disposed = false;let busy = false;let generation = 0;let jobId: string | null = null;let returnFocus: (() => void) | undefined;
  let selected: CustomerJobTimeline | null = null;let query: { category: CustomerJobTimelineCategory;search: string } = { category: 'all',search: '' };
  let page: { cursor?: string;previous: Array<string | undefined> } = { previous: [] };let next: string | undefined;let stalePage = false;
  const controls = () => { refresh.disabled = busy || !jobId;close.disabled = busy;apply.disabled = busy;search.disabled = busy;filter.disabled = busy;
    newer.disabled = busy || stalePage || !page.previous.length;older.disabled = busy || stalePage || !next;opts.onStateChanged(); };
  const finish = () => { root.hidden = true;generation++;selected = null;jobId = null;returnFocus?.();controls(); };
  const format = (value: number) => new Date(value).toLocaleString();
  const render = (report: CustomerJobTimeline) => {
    heading.textContent = `Job timeline — ${report.job.quote_label} · ${report.job.customer}`;summary.replaceChildren();
    add('p','Job '+report.job_id,summary);add('p','Captured '+format(report.captured_at),summary);
    add('p','Current work: '+report.job.work.replaceAll('_',' '),summary);
    add('p',report.job.agreement ? !report.billing_available ? 'Current balances need review in Records.' : 'Current amount owed: '+(report.job.payment.outstanding ?? 'unavailable')+' '+report.job.currency+'; refund owed: '+(report.job.payment.status === 'unavailable' ? 'unavailable' : report.job.payment.refund_due ?? '0.0000')+' '+report.job.currency+'.' : 'No work or invoice was released.',summary);
    for (const issue of report.issues) { const warning = add('p',issue,summary);warning.setAttribute('data-timeline-issue',''); }
    if (report.job.archive?.archived_at != null) add('p',report.job.archive.needs_review ? 'Archived job changed. Review closeout to restore it.' : 'This job is archived.',summary);
    const details = add('details','',summary);add('summary','What this timeline includes',details);report.notes.forEach(note => add('p',note,details));
    for (const row of report.schedules) add('p',`Saved ${row.kind} follow-up: ${row.due_at === null ? 'paused or not scheduled' : format(row.due_at)}.`,details);
    if (report.schedules.length) add('p','Open follow-ups to check whether these saved settings can run.',details);
    list.replaceChildren();
    for (const event of report.events) {
      const item = add('li','',list);item.setAttribute('data-timeline-event',event.event_id);add('h4',event.title,item);
      add('p',event.recorded_at === null ? 'Save time not available' : 'Recorded '+format(event.recorded_at),item);
      if (event.business_date) add('p',event.business_date.label+': '+event.business_date.value,item);
      for (const line of event.details) add('pre',line,item);
      if (event.run_id) { const run = add('a','View owner review in Runs',item);run.setAttribute('href','#logs/'+encodeURIComponent(event.run_id)); }
      if (event.action) {
        const open = button(event.action === 'receipt' ? 'View sign-off receipt' : event.action === 'payment_history' ? 'View invoice history' : 'Review closeout',item);
        open.addEventListener('click',() => {
          if (disposed || busy) return;
          if (!opts.canOpen()) { status.textContent = 'Save or close your other job or email edits before opening this activity.';return; }
          const current = ++generation;root.hidden = true;controls();
          const resume = () => { if (!disposed && current === generation && opts.canOpen()) { root.hidden = false;controls();open.focus(); } };
          try { opts.onAction(event,resume); } catch (error) { resume();status.textContent = error instanceof Error ? error.message : 'This activity could not be opened.'; }
        });
      }
    }
    if (!report.events.length) add('li','No activity matches this view.',list);
  };
  const load = async (desired = page,trigger?:HTMLElement) => {
    if (disposed || busy || !jobId) return;const id = jobId;const priorFocus=doc.activeElement;const source=trigger ?? (root.contains(priorFocus)?priorFocus as HTMLElement:null);const current = ++generation;busy = true;controls();status.textContent = 'Loading saved job activity…';
    try {
      const report = await opts.conn('reception.jobs.timeline',{ job_id: id,limit: 50,...query,...(desired.cursor ? { cursor: desired.cursor } : {}) });
      if (disposed || current !== generation) return;
      if (report.job_id !== id || report.job.job_id !== id) throw new Error('The timeline belongs to another job. Refresh and try again.');
      selected = report;stalePage = false;page = { cursor: desired.cursor,previous: [...desired.previous] };next = report.next_cursor;render(report);
      status.textContent = `${report.events.length} activity entries on this page; ${report.matching_events} match this view.`;
    } catch (error) {
      if (!disposed && current === generation) { stalePage = true;status.textContent = (error instanceof Error ? error.message : 'The job timeline could not be loaded.')
        +(selected ? ' Previously loaded activity remains visible. Refresh the timeline to retry.' : ' Refresh the timeline to retry.'); }
    } finally { if (!disposed && current === generation) { busy = false;controls();if (focusOnLoad) { focusOnLoad = false;focusCustomerWorkspace(root); }else restoreCustomerWorkspaceControl(doc,source,[newer,older,refresh],priorFocus); } }
  };
  form.addEventListener('submit',event => { event.preventDefault();if (busy) return;query = { category: filter.value as CustomerJobTimelineCategory,search: search.value.trim() };void load({ previous: [] }); });
  refresh.addEventListener('click',() => { if (!busy) void load({ previous: [] },refresh); });
  close.addEventListener('click',() => { if (!busy) finish(); });
  older.addEventListener('click',() => { if (!busy && !stalePage && next) void load({ cursor: next,previous: [...page.previous,page.cursor] },older); });
  newer.addEventListener('click',() => { if (!busy && !stalePage && page.previous.length) void load({ cursor: page.previous.at(-1),previous: page.previous.slice(0,-1) },newer); });
  controls();
  return { open: async (id: string,onClosed: () => void) => {
    if (disposed || busy || !opts.canOpen()) return;
    generation++;jobId = id;returnFocus = onClosed;selected = null;page = { previous: [] };next = undefined;stalePage = false;
    query = { category: 'all',search: '' };filter.value = 'all';search.value = '';summary.replaceChildren();list.replaceChildren();heading.textContent = 'Job timeline';
    focusOnLoad = true;root.hidden = false;await load();
  },isOpen: () => !root.hidden,hasInFlightWork: () => busy,dispose: () => { disposed = true;generation++;root.remove(); } };
};
