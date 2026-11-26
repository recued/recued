import type {
  CustomerAccountChoice, CustomerDecisionRef, CustomerDecisionReview, CustomerDecisionWatchChange, CustomerDecisionWatchView,
  CustomerInteractionEvidence,
} from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const CUSTOMER_WATCH_ACTION = 'records-customer-watch';

export interface CustomerDecisionWatchCallers {
  accounts: (request: { query: string }) => Promise<{ accounts: CustomerAccountChoice[] }>;
  read: (ref: CustomerDecisionRef) => Promise<CustomerDecisionWatchView>;
  change: (request: CustomerDecisionWatchChange) => Promise<CustomerDecisionWatchView>;
  reviews: () => Promise<{ reviews: CustomerDecisionReview[] }>;
}

const vendorOf = (account: CustomerAccountChoice) =>
  account.scope === 'connection.api.hubspot.company' ? 'HubSpot' : 'Salesforce';
export const customerAccountLabel = (account: CustomerAccountChoice) =>
  [account.label, account.domain, vendorOf(account) + ' · ' + account.connection].filter(Boolean).join(' · ');

const date = (at: number) => e(new Date(at).toLocaleString());
const interaction = (label: string, row: CustomerInteractionEvidence, vendor: string) => `<div>
  <dt>${e(label)}</dt><dd>${e(row.label)} · ${date(row.at)}
  <small>${e(vendor)} · ${e(row.kind.replaceAll('_', ' '))} · ${e(row.id)}</small></dd>
</div>`;

export const renderCustomerDecisionEvidence = (review: CustomerDecisionReview): string => `
  <p>A new email from ${e(review.account.label)} arrived ${review.gap_days} days after the previous recorded interaction.</p>
  <dl class="customer-decision-evidence">
    ${interaction('Previous interaction', review.previous, vendorOf(review.account))}
    ${interaction('New inbound email', review.incoming, vendorOf(review.account))}
    ${review.rationale ? `<div><dt>Original rationale</dt><dd>${e(review.rationale)}</dd></div>` : ''}
  </dl>`;

interface Editor {
  dialog: HTMLDialogElement;
  ref: CustomerDecisionRef;
  view?: CustomerDecisionWatchView;
  accounts?: CustomerAccountChoice[];
  query: string;
  busy: boolean;
  stopping: boolean;
  error?: string;
}

export const createCustomerDecisionWatchEditor = (opts: {
  document: Document;
  callers?: CustomerDecisionWatchCallers;
  current: () => CustomerDecisionRef | null;
  restoreFocus: () => void;
}) => {
  let editor: Editor | null = null;
  const isCurrent = (state: Editor) => {
    const current = opts.current();
    return editor === state && current?.decision_id === state.ref.decision_id && current.created_at === state.ref.created_at;
  };
  const close = (restore = false) => {
    const current = editor;
    editor = null;
    current?.dialog.remove();
    if (current && restore) opts.restoreFocus();
  };
  const paint = (state: Editor, focus?: string) => {
    if (!isCurrent(state)) return;
    const watch = state.view?.watch;
    const disabled = state.busy ? ' disabled' : '';
    const scroll = state.dialog.querySelector('[data-customer-watch-body]')?.scrollTop ?? 0;
    state.dialog.innerHTML = `<header><h2 id="customer-watch-title" tabindex="-1">Watch customer reengagement</h2></header>
      <div class="customer-watch-body" data-customer-watch-body>
        ${state.error ? `<p role="alert">${e(state.error)}</p>` : ''}
        ${state.busy ? '<p role="status">Checking customer watch…</p>' : ''}
        ${state.view ? `<p>A new customer email after at least ${state.view.quiet_days} quiet days brings this decision back in Today.</p>` : ''}
        ${watch ? `<h3>${e(customerAccountLabel(watch.account))}</h3>
          ${watch.state === 'account_unavailable' ? '<p role="status">This linked account changed or is unavailable. Stop the watch to choose an account again.</p>'
            : watch.state === 'waiting_for_signal' ? '<p role="status">Waiting for synced account evidence. <a href="#settings/housekeeping">Account re-entry signal in Housekeeping</a></p>'
              : '<p role="status">Watching this account.</p>'}
          ${watch.checked_at !== undefined ? `<p>Last checked ${date(watch.checked_at)}</p>` : ''}
          ${watch.review ? `<section><h3>${watch.review.reviewed_at !== undefined ? 'Reviewed reengagement' : 'Decision to review'}</h3>
            ${renderCustomerDecisionEvidence(watch.review)}
            ${watch.review.reviewed_at === undefined ? `<button type="button" data-customer-watch="reviewed"${disabled}>Mark reviewed</button>` : ''}
          </section>` : ''}
          ${state.stopping ? '<p>Stop watching this account for this decision?</p>' : ''}
        ` : state.view ? `<form>
          <label>CRM account name <input name="account" type="search" maxlength="160" value="${e(state.query)}"${disabled}></label>
          <button type="submit"${disabled}>Find accounts</button></form>
          ${state.accounts ? state.accounts.length ? `<ul>${state.accounts.map((account, index) =>
            `<li><span>${e(customerAccountLabel(account))}</span><button type="button" data-customer-watch="start" data-account-index="${index}"
                 aria-label="${e('Watch ' + customerAccountLabel(account))}"${disabled}>Watch account</button></li>`).join('')}</ul>`
            : '<p>No synced accounts matched that name.</p>' : ''}
        ` : ''}
      </div><footer>
        <button type="button" data-customer-watch="close">Close</button>
        ${state.error || watch ? `<button type="button" data-customer-watch="refresh"${disabled}>Refresh</button>` : ''}
        ${watch ? state.stopping
          ? `<button type="button" data-customer-watch="stop"${disabled}>Confirm stop</button>`
          : `<button type="button" data-customer-watch="ask-stop"${disabled}>Stop watch</button>` : ''}
      </footer>`;
    const body = state.dialog.querySelector('[data-customer-watch-body]');
    if (body) body.scrollTop = scroll;
    if (focus) (state.dialog.querySelector<HTMLElement>(focus) ?? state.dialog.querySelector<HTMLElement>('h2'))?.focus();
  };
  const perform = async (state: Editor, run: () => Promise<void>, focus: string) => {
    if (!isCurrent(state) || state.busy) return;
    state.busy = true; state.error = undefined; paint(state, 'h2');
    try { await run(); }
    catch (err) { state.error = humanizeRpcError(err); }
    finally { state.busy = false; paint(state, focus); }
  };
  return {
    open() {
      const callers = opts.callers;
      const ref = opts.current();
      if (editor || !callers || !ref) return;
      const dialog = opts.document.createElement('dialog');
      if (typeof dialog.showModal !== 'function') return;
      dialog.className = 'customer-watch-editor';
      dialog.setAttribute('aria-labelledby', 'customer-watch-title');
      const state: Editor = { dialog, ref, query: '', busy: false, stopping: false };
      editor = state;
      const refresh = () => perform(state, async () => {
        state.view = await callers.read(state.ref);
      }, state.view?.watch ? 'h2' : 'input[name="account"]');
      const change = (request: CustomerDecisionWatchChange) => perform(state, async () => {
        state.view = await callers.change(request);
        state.stopping = false;
        state.accounts = undefined;
      }, 'h2');
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(true); });
      dialog.addEventListener('submit', event => {
        event.preventDefault();
        const input = dialog.querySelector<HTMLInputElement>('input[name="account"]');
        if (!input) return;
        state.query = input.value;
        state.accounts = undefined;
        void perform(state, async () => {
          state.accounts = (await callers.accounts({ query: state.query })).accounts;
        }, '[data-customer-watch="start"], input[name="account"]');
      });
      dialog.addEventListener('click', event => {
        if (!isCurrent(state)) return;
        const button = (event.target as HTMLElement).closest('button');
        const action = button?.getAttribute('data-customer-watch');
        if (action === 'close') { close(true); return; }
        if (state.busy || button?.disabled) return;
        const watch = state.view?.watch;
        if (action === 'refresh') void refresh();
        if (action === 'start' && !watch) {
          const account = state.accounts?.[Number(button?.getAttribute('data-account-index'))];
          if (account) void change({ action, decision: state.ref, account: { scope: account.scope, target_id: account.target_id } });
        }
        if (action === 'reviewed' && watch?.review) void change({ action, watch_id: watch.id, review_id: watch.review.id });
        if (action === 'ask-stop' && watch) { state.stopping = true; paint(state, '[data-customer-watch="stop"]'); }
        if (action === 'stop' && state.stopping && watch) void change({ action, watch_id: watch.id });
      });
      opts.document.body.appendChild(dialog);
      paint(state);
      dialog.showModal();
      void refresh();
    },
    sync() { if (editor && !isCurrent(editor)) close(); },
    dispose() { close(); },
  };
};

export const CUSTOMER_WATCH_STYLES = `
.customer-watch-editor { width:min(38rem,calc(100vw - 24px)); max-height:calc(100dvh - 24px); box-sizing:border-box;
  overflow:hidden; border:1px solid var(--border); border-radius:10px; padding:0; background:var(--surface); color:var(--fg); }
.customer-watch-editor[open] { display:flex; flex-direction:column; }
.customer-watch-editor::backdrop { background:#0006; }
.customer-watch-editor header, .customer-watch-editor footer { padding:12px 16px; flex-shrink:0; }
.customer-watch-editor h2 { margin:0; }
.customer-watch-editor footer { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:8px; border-top:1px solid var(--border); }
.customer-watch-body { min-height:0; overflow:auto; overscroll-behavior:contain; padding:10px 16px 16px; border-top:1px solid var(--border); overflow-wrap:anywhere; }
.customer-watch-editor input, .customer-watch-editor button { box-sizing:border-box; min-height:44px; max-width:100%;
  font:inherit; padding:6px 10px; background:var(--surface); color:var(--fg); border:1px solid var(--border); border-radius:6px; }
.customer-watch-editor label { display:grid; gap:4px; }
.customer-watch-editor form { display:flex; flex-wrap:wrap; gap:8px; align-items:end; }
.customer-watch-editor ul { list-style:none; padding:0; }
.customer-watch-editor li { padding:8px 0; border-bottom:1px solid var(--border); display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.customer-decision-evidence { display:grid; gap:8px; min-width:0; overflow-wrap:anywhere; }
.customer-decision-evidence dt { font-weight:600; }
.customer-decision-evidence dd { margin:0; white-space:pre-wrap; }
.customer-decision-evidence small { display:block; color:var(--muted); }
`;
