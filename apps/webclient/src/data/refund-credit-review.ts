import {
  formatRefundCents, refundCents, refundWatchOrder,
  type Commitment, type RefundCreditCaseRef, type RefundCreditsChange, type RefundCreditsRead,
  type RefundCreditsView, type RefundStatementCredit,
} from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export interface RefundCreditCallers {
  read(input: RefundCreditsRead): Promise<RefundCreditsView>;
  change(input: RefundCreditsChange): Promise<RefundCreditsView>;
}

interface Review {
  ref: RefundCreditCaseRef;
  title: string;
  dialog: HTMLDialogElement;
  account: string;
  view?: RefundCreditsView;
  selected: Map<string, RefundStatementCredit>;
  remove?: string;
  busy: boolean;
  error?: string;
  notice?: string;
}

export const createRefundCreditReview = (deps: {
  document: Document;
  callers?: RefundCreditCallers;
  current: () => Commitment | null;
  restoreFocus: () => void;
}) => {
  let review: Review | null = null;
  const current = (value: Review) => {
    const commitment = deps.current();
    return review === value && commitment?.id === value.ref.commitment_id && commitment.created_at === value.ref.created_at;
  };
  const close = (restore = false) => {
    const value = review;
    review = null;
    value?.dialog.remove();
    if (restore) deps.restoreFocus();
  };

  const selectedTotal = (value: Review) => [...value.selected.values()]
    .reduce((sum, credit) => sum + (refundCents(credit.amount) ?? 0n), 0n);

  const paint = (value: Review) => {
    if (!current(value)) return;
    const { view, dialog, busy } = value;
    const active = dialog.ownerDocument.activeElement as HTMLElement | null;
    const focus = dialog.contains(active) ? active?.getAttribute('data-refund-focus') : null;
    const caret = focus === 'account' ? (active as HTMLInputElement).selectionStart : null;
    const scroll = dialog.querySelector('[data-refund-body]')?.scrollTop ?? 0;
    const currency = view?.expected?.currency ?? '';
    const money = (amount: string) => e(amount + (currency ? ' ' + currency : ''));
    const lockedAccount = view?.matches.some(match => match.credit) ? view.account_label : undefined;
    const hasChanged = view?.matches.some(match => !match.credit) ?? false;
    const remaining = view?.outstanding == null ? null : refundCents(view.outstanding);
    const oversize = remaining !== null && selectedTotal(value) > remaining;
    const reviewTotal = '<p role="status">' + value.selected.size + ' selected · ' + money(formatRefundCents(selectedTotal(value))) + '</p>';
    const creditLabel = (credit: RefundStatementCredit) => '<strong>' + money(credit.amount) + '</strong> <span>' +
      e(credit.posted_on) + '</span><span>' + e(credit.description || 'Statement credit') + '</span>';
    const matches = view?.matches.map(match => '<li data-refund-match="' + e(match.line.id) + '">'
      + (match.credit ? creditLabel(match.credit) : '<p>Saved credit changed or is unavailable.</p>')
      + '<button type="button" data-refund-remove="' + e(match.line.id) + '" data-refund-focus="remove-' + e(match.line.id) + '"'
      + (busy ? ' disabled' : '') + '>Remove credit link</button></li>').join('') ?? '';
    const candidateIds = new Set(view?.candidates.map(credit => credit.line.id));
    const creditOption = (credit: RefundStatementCredit) =>
      '<li><label><input type="checkbox" data-refund-credit="' + e(credit.line.id) + '" data-refund-focus="credit-' + e(credit.line.id) + '"'
      + (value.selected.has(credit.line.id) ? ' checked' : '') + (busy ? ' disabled' : '')
      + '> ' + creditLabel(credit) + '</label></li>';
    const candidates = view?.candidates.map(creditOption).join('') ?? '';
    const selections = [...value.selected.values()].filter(credit => !candidateIds.has(credit.line.id)).map(creditOption).join('');
    const summary = view ? '<dl class="refund-credit-totals"><div><dt>Expected</dt><dd>'
      + (view.expected ? money(view.expected.amount) : 'Amount needed') + '</dd></div><div><dt>Confirmed credits</dt><dd>'
      + money(view.credited) + '</dd></div><div><dt>Still outstanding</dt><dd>'
      + (view.outstanding === null ? 'Unknown' : money(view.outstanding)) + '</dd></div></dl>' : '';
    const removal = view?.matches.find(match => match.line.id === value.remove);
    const searchable = view?.statement_available && view.expected;
    const canConfirm = !busy && !value.remove && !hasChanged && !oversize && value.selected.size > 0
      && value.account.trim() === view?.account_label;
    dialog.innerHTML = '<header><h2 id="refund-credits-title" tabindex="-1" data-refund-focus="heading">Review statement credits</h2><p>'
      + e(value.title) + '</p></header><div class="refund-credit-body" data-refund-body>'
      + summary
      + (value.error ? '<p role="alert">' + e(value.error) + '</p>' : '')
      + (value.notice ? '<p role="status">' + e(value.notice) + '</p>' : '')
      + (busy ? '<p role="status">Checking statement credits…</p>' : '')
      + (view && !view.statement_available ? '<p>Import a statement using Bank statement import to review its credits here.</p>' : '')
      + (view && !view.expected ? '<p>Set the expected amount and currency on the commitment before confirming credits.</p>' : '')
      + (view?.exceeds_expected ? '<p role="alert">Confirmed credits exceed the current expected amount. Review the saved links.</p>' : '')
      + (view?.outstanding === '0.00' && !view.exceeds_expected && !hasChanged
        ? '<p>The full refund is confirmed. Use Mark fulfilled on an open commitment when you’re ready.</p>' : '')
      + (hasChanged ? '<p>Remove any changed credit links and review the current statement lines again.</p>' : '')
      + (removal ? '<p>Remove this link from the refund review?</p>'
        + (removal.credit ? '<p>' + creditLabel(removal.credit) + '</p>' : '') : '')
      + (matches && !removal ? '<h3>Matched credits</h3><ul>' + matches + '</ul>' : '')
      + (searchable && !removal ? '<form data-refund-search><label>Statement account label'
        + '<input type="text" name="account" data-refund-account data-refund-focus="account" value="' + e(value.account) + '"'
        + (lockedAccount ? ' readonly' : '') + (busy ? ' disabled' : '') + ' maxlength="2048" autocomplete="off"></label>'
        + '<button type="submit" data-refund-focus="search"' + (busy ? ' disabled' : '') + '>Find credits</button></form>'
        + (selections ? '<h3>Selected credits</h3><ul>' + selections + '</ul>' : '')
        + (candidates ? '<h3>Available credits</h3><ul>' + candidates + '</ul>'
          : view?.account_label ? '<p>No available credits on this page for this account and currency.</p>' : '')
        + (view?.next_cursor ? '<button type="button" data-refund-action="more" data-refund-focus="more"'
          + (busy ? ' disabled' : '') + '>Next page</button>' : '')
        + (oversize ? '<p role="alert">The selection exceeds the outstanding refund. Review which credits belong to this order.</p>' : '') : '')
      + '</div><footer>'
      + (removal ? '<button type="button" data-refund-action="back" data-refund-focus="back">Back</button>'
        + '<button type="button" data-refund-action="remove" data-refund-focus="confirm"'
        + (busy ? ' disabled' : '') + '>Confirm removal</button>'
        : (value.selected.size ? reviewTotal : '') + '<button type="button" data-refund-action="close" data-refund-focus="close">Close</button>'
        + (value.error ? '<button type="button" data-refund-action="refresh" data-refund-focus="refresh"'
          + (busy ? ' disabled' : '') + '>Refresh</button>' : '')
        + (searchable ? '<button type="button" data-refund-action="confirm" data-refund-focus="confirm"'
          + (!canConfirm ? ' disabled' : '') + '>Confirm selected credits</button>' : ''))
      + '</footer>';
    const scrollHost = dialog.querySelector('[data-refund-body]');
    if (scrollHost) scrollHost.scrollTop = scroll;
    const wanted = [...dialog.querySelectorAll<HTMLElement>('[data-refund-focus]')]
      .find(control => control.getAttribute('data-refund-focus') === focus && !control.matches(':disabled'));
    wanted?.focus({ preventScroll: true });
    if (wanted && caret !== null && focus === 'account') (wanted as HTMLInputElement).setSelectionRange(caret, caret);
    if (focus && !wanted) dialog.querySelector<HTMLElement>('#refund-credits-title')?.focus({ preventScroll: true });
  };

  const load = async (value: Review, account?: string, cursor?: string) => {
    if (!current(value) || value.busy) return;
    value.busy = true; value.error = undefined; value.notice = undefined;
    if (!cursor) {
      value.selected.clear();
      if (value.view) value.view = { ...value.view, next_cursor: undefined, candidates: [] };
    }
    paint(value);
    try {
      const fresh = await deps.callers!.read({ ...value.ref, ...(account ? { account_label: account } : {}), ...(cursor ? { cursor } : {}) });
      if (!current(value)) return;
      if (value.view && value.view.review_token !== fresh.review_token) value.selected.clear();
      value.view = fresh;
      if (fresh.account_label !== undefined) value.account = fresh.account_label;
    } catch (error) {
      if (current(value)) value.error = humanizeRpcError(error);
    } finally {
      if (current(value)) { value.busy = false; paint(value); }
    }
  };

  const change = async (value: Review, action: 'confirm' | 'remove') => {
    if (!current(value) || !value.view || value.busy) return;
    const proof = { ...value.ref, review_token: value.view.review_token };
    const request: RefundCreditsChange = action === 'remove'
      ? { ...proof, action, line_id: value.remove! }
      : { ...proof, action, account_label: value.view.account_label!, lines: [...value.selected.values()].map(credit => credit.line) };
    value.busy = true; value.error = undefined; value.notice = undefined; paint(value);
    try {
      const fresh = await deps.callers!.change(request);
      if (!current(value)) return;
      value.view = fresh;
      value.selected.clear();
      value.remove = undefined;
      value.notice = action === 'confirm' ? 'Statement credits confirmed.' : 'Credit link removed.';
    } catch (error) {
      if (current(value)) { value.error = humanizeRpcError(error); value.remove = undefined; }
    } finally {
      if (current(value)) { value.busy = false; paint(value); }
    }
  };

  return {
    open() {
      const commitment = deps.current();
      const order = commitment && refundWatchOrder(commitment);
      if (review || !deps.callers || !commitment || !order || !deps.document.createElement) return;
      const dialog = deps.document.createElement('dialog');
      if (typeof dialog.showModal !== 'function') return;
      dialog.className = 'refund-credit-review';
      dialog.setAttribute('aria-labelledby', 'refund-credits-title');
      const value: Review = { ref: { commitment_id: commitment.id, created_at: commitment.created_at },
        title: order.merchant + ' · Order ' + order.order_id, dialog, account: '', selected: new Map(), busy: false };
      review = value;
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(true); });
      dialog.addEventListener('input', event => {
        const control = event.target as HTMLInputElement;
        if (!current(value) || !control.hasAttribute('data-refund-account')) return;
        value.account = control.value;
        if (value.view?.account_label !== undefined && value.account.trim() !== value.view.account_label) {
          value.selected.clear();
          value.view = { ...value.view, account_label: undefined, candidates: [], next_cursor: undefined };
          paint(value);
        }
      });
      dialog.addEventListener('submit', event => {
        event.preventDefault();
        if (!current(value) || value.busy) return;
        const account = value.account.trim();
        if (account) void load(value, account);
        else { value.error = 'Enter the account label from the statement import.'; paint(value); }
      });
      dialog.addEventListener('change', event => {
        const control = event.target as HTMLInputElement;
        const id = control.getAttribute('data-refund-credit');
        if (!current(value) || value.busy || id === null) return;
        const candidate = value.view?.candidates.find(credit => credit.line.id === id);
        if (control.checked && candidate) value.selected.set(id, candidate);
        else value.selected.delete(id);
        paint(value);
      });
      dialog.addEventListener('click', event => {
        if (!current(value)) return;
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
        const action = button?.getAttribute('data-refund-action');
        if (action === 'close') { close(true); return; }
        if (value.busy || button?.disabled) return;
        const line = button?.getAttribute('data-refund-remove');
        if (line) { value.remove = line; paint(value); dialog.querySelector<HTMLElement>('[data-refund-action="back"]')?.focus(); }
        else if (action === 'back') { value.remove = undefined; paint(value); }
        else if (action === 'refresh') void load(value, value.view?.account_label);
        else if (action === 'more' && value.view?.next_cursor) void load(value, value.view.account_label, value.view.next_cursor);
        else if (action === 'confirm' || action === 'remove') void change(value, action);
      });
      deps.document.body.append(dialog);
      paint(value);
      dialog.showModal();
      dialog.querySelector<HTMLElement>('#refund-credits-title')?.focus();
      void load(value);
    },
    sync() { if (review && !current(review)) close(); },
    dispose() { close(); },
  };
};

export const REFUND_CREDIT_STYLES = String.raw`
.refund-credit-review { width:min(38rem,calc(100vw - 24px)); max-height:calc(100dvh - 24px); box-sizing:border-box; overflow:hidden; border:1px solid var(--border); border-radius:10px; padding:0; background:var(--surface); color:var(--fg); }
.refund-credit-review[open] { display:flex; flex-direction:column; }
.refund-credit-review::backdrop { background:#0006; }
.refund-credit-review header, .refund-credit-review footer { padding:12px 16px; flex-shrink:0; }
.refund-credit-review header h2, .refund-credit-review header p { margin:0; }
.refund-credit-review footer { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:8px; border-top:1px solid var(--border); }
.refund-credit-review footer p { margin:0 auto 0 0; }
.refund-credit-body { min-height:0; overflow:auto; overscroll-behavior:contain; padding:12px 16px; border-top:1px solid var(--border); }
.refund-credit-review input:not([type="checkbox"]), .refund-credit-review button { min-height:44px; max-width:100%; font:inherit; padding:6px 10px; background:var(--surface); color:var(--fg); border:1px solid var(--border); border-radius:6px; box-sizing:border-box; }
.refund-credit-review form { display:flex; flex-wrap:wrap; align-items:end; gap:8px; }
.refund-credit-review form label { display:grid; gap:4px; }
.refund-credit-review ul { list-style:none; padding:0; }
.refund-credit-review li { display:grid; grid-template-columns:minmax(0,1fr); gap:4px; padding:8px 0; border-bottom:1px solid var(--border); overflow-wrap:anywhere; }
.refund-credit-review li label { min-height:44px; display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.refund-credit-review li label span:last-child { flex-basis:100%; }
.refund-credit-review li button { justify-self:start; }
.refund-credit-totals { display:flex; gap:16px; flex-wrap:wrap; margin:0 0 12px; }
.refund-credit-totals dd { margin:0; font-weight:600; }
`;
