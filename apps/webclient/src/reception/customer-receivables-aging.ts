import { focusCustomerWorkspace,restoreCustomerWorkspaceControl } from './customer-workspace-focus.js';
import { RECEIVABLE_AGING_BUCKETS,type Conn,type ServerRpcRegistry,type CustomerReceivablesAging,
  type CustomerReceivableInvoice,type ReceivableAgingFilter } from '@recued/contracts';

export type CustomerReceivablesAgingConn = Conn<Pick<ServerRpcRegistry,'reception.jobs.receivables'>>;
const labels: Record<ReceivableAgingFilter,string> = { all: 'All receivables',current: 'Current',
  '1_30': '1–30 days','31_60': '31–60 days','61_90': '61–90 days', '91_plus': '91+ days',needs_review: 'Needs review' };
export const mountCustomerReceivablesAging = (opts: { host: HTMLElement;document: Document;conn: CustomerReceivablesAgingConn;
  canOpen: () => boolean;onStateChanged: () => void;
  onAction: (action: 'invoice' | 'job',row: CustomerReceivableInvoice,back: () => void) => void }) => {
  const doc = opts.document;const root = doc.createElement('section');root.hidden = true;root.tabIndex = -1;root.setAttribute('data-receivables-aging','');root.setAttribute('aria-label','Receivables aging');opts.host.appendChild(root);
  const add = (tag: string,text: string,host: HTMLElement = root) => { const el = doc.createElement(tag);el.textContent = text;host.appendChild(el);return el; };
  const button = (text: string,host: HTMLElement = root) => { const el = doc.createElement('button');el.type = 'button';el.textContent = text;host.appendChild(el);return el; };
  add('style',`[data-receivables-aging]{display:grid;gap:14px;padding:18px;border:1px solid var(--border,#ddd);border-radius:12px;min-width:0;overflow-wrap:anywhere}
    [data-receivables-aging][hidden]{display:none!important}[data-receivables-aging] form{display:grid;gap:10px}
    [data-receivables-aging] [data-aging-actions]{display:flex;flex-wrap:wrap;gap:10px}
    [data-aging-totals]{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:12px}
    [data-aging-totals] section,[data-aging-rows] article{min-width:0;display:grid;gap:8px;padding:14px;border:1px solid var(--border,#ddd);border-radius:8px}
    [data-aging-totals] dl{display:grid;grid-template-columns:1fr auto;gap:8px;margin:0}[data-aging-totals] dd{margin:0}
    [data-aging-rows]{display:grid;gap:12px}[data-receivables-aging] input,[data-receivables-aging] select{max-width:100%}
    [data-receivables-aging] h4{margin:0}`);
  add('h3','Receivables aging');add('p','Current recorded balances for invoices released through Customer jobs. Refresh to check for changes.');
  const form = add('form','');form.setAttribute('aria-label','Find receivables');
  const searchLabel = add('label','Customer, quote or invoice',form);const search = doc.createElement('input');search.type = 'search';search.maxLength = 200;searchLabel.appendChild(search);
  const choice = (text: string,id: string) => { const label = add('label',text,form);const select = doc.createElement('select');select.id = id;label.setAttribute('for',id);form.appendChild(select);return select; };
  const filter = choice('Age of receivables','recued-receivables-bucket');
  for (const value of ['all',...RECEIVABLE_AGING_BUCKETS,'needs_review'] as const) { const option = doc.createElement('option');option.value = value;option.textContent = labels[value];filter.appendChild(option); }
  const currency = choice('Currency','recued-receivables-currency');const allCurrency = doc.createElement('option');allCurrency.value = '';allCurrency.textContent = 'All currencies';currency.appendChild(allCurrency);
  const apply = button('Find receivables',form);apply.type = 'submit';
  const actions = add('div','');actions.setAttribute('data-aging-actions','');const refresh = button('Refresh aging',actions);const close = button('Close receivables aging',actions);
  const status = add('p','');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const caption = add('p','');const scope = add('p','');const warning = add('p','');warning.setAttribute('data-aging-warning','');
  const totals = add('div','');totals.setAttribute('data-aging-totals','');const notes = add('details','');add('summary','What the report includes',notes);const coverage = add('div','',notes);
  const rows = add('div','');rows.setAttribute('data-aging-rows','');
  const paging = add('div','');paging.setAttribute('data-aging-actions','');const previous = button('Previous receivables',paging);const more = button('More receivables',paging);
  let focusOnLoad = false;let disposed = false;let busy = false;let sourceOpen = false;let generation = 0;let selected: CustomerReceivablesAging | null = null;let returnFocus: (() => void) | undefined;
  let query: { search: string;currency?: string;bucket: ReceivableAgingFilter } = { search: '',bucket: 'all' };
  let page: { cursor?: string;previous: Array<string | undefined> } = { previous: [] };let next: string | undefined;let stalePage = false;
  const controls = () => { search.disabled = busy;filter.disabled = busy;currency.disabled = busy;apply.disabled = busy;refresh.disabled = busy;close.disabled = busy;
    previous.disabled = busy || stalePage || !page.previous.length;more.disabled = busy || stalePage || !next;opts.onStateChanged(); };
  const render = (report: CustomerReceivablesAging) => {
    caption.textContent = `As of ${report.as_of} in ${report.time_zone}. Captured ${new Date(report.captured_at).toLocaleString()}.`;
    scope.textContent = `Totals for ${query.search ? '“'+query.search+'”' : 'all customers, quotes and invoices'}; ${query.currency ?? 'each currency separately'}. Invoice list: ${labels[query.bucket]}.`;
    warning.textContent = report.complete ? 'All matching released invoices have verified billing records.'
      : `${report.review_count} matching invoice${report.review_count === 1 ? ' needs' : 's need'} review and ${report.review_count === 1 ? 'is' : 'are'} excluded from totals. Choose Needs review to inspect them.`;
    totals.replaceChildren();
    for (const balance of report.balances) {
      const card = add('section','',totals);card.setAttribute('data-aging-currency',balance.currency);add('h4',balance.currency+' · verified receivables',card);
      add('p',`Outstanding: ${balance.outstanding} ${balance.currency} across ${balance.invoice_count} invoice${balance.invoice_count === 1 ? '' : 's'}.`,card);
      add('p',`Overdue: ${balance.overdue} ${balance.currency}`,card);const list = add('dl','',card);
      for (const bucket of balance.buckets) { add('dt',labels[bucket.bucket],list);add('dd',bucket.amount+' '+balance.currency,list); }
      add('p',`Refunds owed separately: ${balance.refund_due} ${balance.currency}.`,card);
    }
    if (!report.balances.length) add('p','No verified receivables or refund liabilities match this search and currency.',totals);
    coverage.replaceChildren();report.notes.forEach(note => add('p',note,coverage));
    const desired = currency.value;currency.replaceChildren(allCurrency);
    for (const value of [...new Set([...report.currencies,...(query.currency ? [query.currency] : []),...(desired ? [desired] : [])])].sort()) {
      const option = doc.createElement('option');option.value = value;option.textContent = value;currency.appendChild(option);
    }
    currency.value = desired;rows.replaceChildren();
    for (const row of report.rows) {
      const card = add('article','',rows);card.setAttribute('data-aging-invoice',row.signoff_id);add('h4',row.invoice_ref+' · '+row.customer,card);
      add('p',row.quote_label+(row.quote_reference ? ' · '+row.quote_reference : ''),card);
      if (row.availability === 'needs_review') add('p','Needs review: '+row.issue,card);
      else { add('p',`Outstanding: ${row.outstanding} ${row.currency}`,card);add('p',`Due ${row.due_on} · ${row.days_overdue === 0 ? 'Current' : row.days_overdue+' days overdue'}`,card);
        if (row.refund_due !== '0.0000') add('p',`Refund owed separately: ${row.refund_due} ${row.currency}`,card); }
      const actions = add('div','',card);actions.setAttribute('data-aging-actions','');
      for (const [action,label] of [['invoice','View invoice history'],['job','View job timeline']] as const) {
        const open = button(label,actions);open.addEventListener('click',() => {
          if (disposed || busy) return;
          if (!opts.canOpen()) { status.textContent = 'Save or close other job, payment or email work before opening this source.';return; }
          const current = ++generation;sourceOpen = true;root.hidden = true;controls();
          const back = () => {
            if (disposed || current !== generation) return;
            sourceOpen = false;if (opts.canOpen()) { root.hidden = false;open.focus(); }controls();
          };
          try { opts.onAction(action,row,back); } catch (error) { back();status.textContent = error instanceof Error ? error.message : 'The source could not be opened.'; }
        });
      }
    }
    if (!report.rows.length) add('p','No receivables match this aging view. Refund liabilities are shown separately above.',rows);
  };
  const load = async (desired = page,trigger?:HTMLElement) => {
    if (disposed || busy) return;const priorFocus=doc.activeElement;const source=trigger ?? (root.contains(priorFocus)?priorFocus as HTMLElement:null);const current = ++generation;busy = true;controls();status.textContent = 'Loading current receivables…';
    try {
      const report = await opts.conn('reception.jobs.receivables',{ ...query,limit: 50,...(desired.cursor ? { cursor: desired.cursor } : {}) });
      if (disposed || generation !== current) return;
      if (report.format !== 'recued.customer-receivables-aging' || report.version !== 1) throw new Error('This aging report format is unavailable. Refresh and try again.');
      selected = report;page = { cursor: desired.cursor,previous: [...desired.previous] };next = report.next_cursor;stalePage = false;render(report);
      status.textContent = `${report.rows.length} invoice${report.rows.length === 1 ? '' : 's'} on this page; ${report.matching_rows} match this view.`;
    } catch (error) {
      if (!disposed && generation === current) { stalePage = true;status.textContent = (error instanceof Error ? error.message : 'Receivables could not be loaded.')
        +(selected ? ' Previously loaded receivables remain visible. Refresh aging to retry.' : ' Refresh aging to retry.'); }
    } finally { if (!disposed && generation === current) { busy = false;controls();if (focusOnLoad) { focusOnLoad = false;focusCustomerWorkspace(root); }else restoreCustomerWorkspaceControl(doc,source,[previous,more,refresh],priorFocus); } }
  };
  form.addEventListener('submit',event => { event.preventDefault();if (busy) return;query = { search: search.value.trim(),bucket: filter.value as ReceivableAgingFilter,...(currency.value ? { currency: currency.value } : {}) };void load({ previous: [] }); });
  refresh.addEventListener('click',() => { if (!busy) void load({ previous: [] },refresh); });
  more.addEventListener('click',() => { if (!busy && !stalePage && next) void load({ cursor: next,previous: [...page.previous,page.cursor] },more); });
  previous.addEventListener('click',() => { if (!busy && !stalePage && page.previous.length) void load({ cursor: page.previous.at(-1),previous: page.previous.slice(0,-1) },previous); });
  close.addEventListener('click',() => { if (busy) return;root.hidden = true;selected = null;generation++;returnFocus?.();controls(); });
  controls();
  return { open: async (onClosed: () => void) => {
    if (disposed || busy || sourceOpen || !opts.canOpen()) return;
    if (!root.hidden) { focusCustomerWorkspace(root);return; }
    generation++;returnFocus = onClosed;selected = null;page = { previous: [] };next = undefined;stalePage = false;
    query = { search: '',bucket: 'all' };search.value = '';filter.value = 'all';currency.value = '';caption.textContent = '';scope.textContent = '';warning.textContent = '';totals.replaceChildren();rows.replaceChildren();coverage.replaceChildren();
    focusOnLoad = true;root.hidden = false;await load();
  },isOpen: () => !root.hidden,hasOpenSource: () => sourceOpen,hasInFlightWork: () => busy,dispose: () => { disposed = true;generation++;root.remove(); } };
};
