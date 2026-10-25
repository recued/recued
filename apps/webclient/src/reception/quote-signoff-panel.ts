import { focusCustomerWorkspace, restoreCustomerWorkspaceControl } from './customer-workspace-focus.js';
import { customerInvoiceRecordAddress } from '../data/records-navigation.js';
import { receptionCustomerJobAddress, receptionInboxTargetAddress } from './navigation.js';
import { customerRefundBalanceLines } from '@recued/contracts';
import { QUOTE_SIGNOFF_SEARCH_MAX, QUOTE_SIGNOFF_STATES,
  type Conn, type ServerRpcRegistry, type QuoteSignoffPrepareResult,
  type QuoteSignoffState, type QuoteSignoffSummary } from '@recued/contracts';
import { canRecordSignoffPayment, createQuoteSignoffPayment,
  type QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';
import { mountQuoteSignoffReminders, type QuoteSignoffReminderOptions } from './quote-signoff-reminders.js';
import { mountQuoteCompletionPanel } from './quote-completion-panel.js';
import { mountCustomerPaymentHistory } from './customer-payment-history.js';
import { mountQuoteSignoffReceipt } from './quote-signoff-receipt.js';
import { readCustomerRequestBoardState } from './customer-request-board-state.js';
import { customerRequestExpiry, refreshCustomerRequestExpiries, customerPreviewExpired } from './customer-request-expiry.js';
import { mountCustomerLinkShare } from './customer-link-share.js';
import { guardCustomerHistoryInteraction } from './customer-history-interaction.js';
import { keepCustomerReplySelection } from './customer-history-selection.js';
import { customerRequestClock, type CustomerRequestClock } from './customer-request-clock.js';
import { mountCustomerPreviewFreshness } from './customer-preview-freshness.js';
import { appendCustomerResponseText } from './customer-response-text.js';

export type QuoteSignoffConn = Conn<Pick<ServerRpcRegistry,
  'reception.signoff.resume' | 'reception.signoff.link.check' | 'reception.signoff.completion.resume' | 'reception.signoff.quotes' | 'reception.signoff.prepare' | 'reception.signoff.publish'
  | 'reception.signoff.prepare_addition' | 'reception.signoff.list' | 'reception.signoff.cancel'
  | 'reception.signoff.receipt'
  | 'reception.signoff.payment.history' | 'reception.signoff.payment.receipt' | 'reception.signoff.payment.receipt.draft' | 'reception.signoff.refund.correction.prepare' | 'reception.signoff.refund.correction.history' | 'reception.signoff.refund.prepare' | 'reception.signoff.refund.history' | 'reception.signoff.refund.copy' | 'reception.signoff.refund.receipt.draft' | 'reception.signoff.invoice.credit.correction.prepare' | 'reception.signoff.invoice.credit.correction.history' | 'reception.signoff.invoice.credit.prepare' | 'reception.signoff.invoice.credit.history' | 'reception.signoff.invoice.credit.copy' | 'reception.signoff.payment.correction.prepare' | 'reception.signoff.payment.correction.history'
  | 'reception.signoff.completion.prepare' | 'reception.signoff.completion.publish'
  | 'reception.signoff.completion.list' | 'reception.signoff.completion.cancel'
  | 'reception.signoff.payment.reminders.get'
  | 'reception.signoff.completion.reminders.get'
  | 'reception.signoff.payment.reminders.set'
  | 'reception.signoff.completion.reminders.set'
  | 'reception.signoff.payment.reminders.list'
  | 'reception.signoff.completion.reminders.list'
  | 'reception.signoff.payment.reminders.draft'
  | 'reception.signoff.completion.reminders.draft'
  | 'reception.signoff.reminders.get' | 'reception.signoff.reminders.set'
  | 'reception.signoff.reminders.list' | 'reception.signoff.reminders.draft'>>;

/** Customer acceptance and owner release are distinct decisions. All terms
 * and destinations come from the prepared server snapshot, never the DOM. */
export const mountQuoteSignoffPanel = (opts: {
  host: HTMLElement; conn: QuoteSignoffConn; document: Document;
  initialSignoffId?: string;startNew?: boolean;
  payment?: QuoteSignoffPaymentOptions;
  reminders?: QuoteSignoffReminderOptions;
}) => {
  const { document: doc, conn } = opts;
  const root = doc.createElement('section'); root.setAttribute('data-recued-quote-signoffs', '');
  opts.host.appendChild(root);
  const style = doc.createElement('style'); style.textContent = `
    [data-recued-quote-signoffs] { display:grid; gap:16px; max-width:850px; min-width:0; }
    [data-recued-quote-signoffs] [hidden] { display:none !important; }
    [data-recued-quote-signoffs] details:not([open]) > :not(summary) { display:none !important; }
    [data-recued-quote-signoffs] [data-signoff-completions],
    [data-recued-quote-signoffs] [data-completion-history],
    [data-recued-quote-signoffs] [data-signoff-reminders],
    [data-recued-quote-signoffs] [data-signoff-reminder-queue],
    [data-recued-quote-signoffs] [data-signoff-reminder-editor] { display:grid; gap:12px; }
    [data-recued-quote-signoffs] [data-signoff-receipt],
    [data-recued-quote-signoffs] [data-signoff-receipt-requests] { display:grid; gap:12px; }
    [data-recued-quote-signoffs] h2, [data-recued-quote-signoffs] h3, [data-recued-quote-signoffs] p { margin:0; }
    [data-recued-quote-signoffs] [role=status]:empty { display:none; }
    [data-recued-quote-signoffs] .signoff-intro { font-size:14px;line-height:1.5;color:var(--fg-muted); }
    [data-recued-quote-signoffs] [data-signoff-create]>summary{cursor:pointer;font-weight:650;padding:12px;border:1px solid var(--border);border-radius:8px;color:var(--accent)}
    [data-recued-quote-signoffs] [data-signoff-create][open]>summary{margin-bottom:16px}
    [data-recued-quote-signoffs] .signoff-billing-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;border:1px solid var(--border);border-radius:10px;padding:14px}
    [data-recued-quote-signoffs] .signoff-expiry-help{grid-column:1/-1;font-size:13px;color:var(--fg-muted)}
    @media(max-width:640px){[data-recued-quote-signoffs] .signoff-billing-fields{grid-template-columns:1fr}}
    [data-recued-quote-signoffs] form { display:grid; gap:12px; }
    [data-recued-quote-signoffs] label { display:grid; gap:5px; font-size:14px; }
    [data-recued-quote-signoffs] input, [data-recued-quote-signoffs] select,
    [data-recued-quote-signoffs] textarea { width:100%; padding:10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--fg); font:inherit; }
    [data-recued-quote-signoffs] textarea { min-height:130px; resize:vertical; }
    [data-recued-quote-signoffs] input[type="checkbox"] { width:auto; }
    [data-recued-quote-signoffs] button { min-height:44px;padding:9px 14px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--fg); cursor:pointer; width:fit-content;font:inherit;font-size:14px; }
    [data-recued-quote-signoffs] button:disabled { opacity:.6; cursor:default; }
    [data-recued-quote-signoffs] pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; line-height:1.5; padding:16px; background:var(--surface-sunk); border-radius:10px; }
    [data-recued-quote-signoffs] article { display:grid; gap:10px; padding:16px; border:1px solid var(--border); border-radius:10px;min-width:0;overflow-wrap:anywhere; }
    [data-signoff-history] { display:grid;gap:12px; }
    [data-signoff-history] .signoff-card-header { display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px 16px; }
    [data-signoff-history] .signoff-card-header h3 { font-size:17px;flex:1 1 200px; }
    [data-signoff-history] .signoff-amount { font-weight:650;font-variant-numeric:tabular-nums; }
    [data-signoff-history] .signoff-card-status { display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;font-size:13px; }
    [data-signoff-history] [data-signoff-state] { width:fit-content;padding:4px 9px;border-radius:6px;background:var(--surface-sunk);font-size:13px; }
    [data-signoff-history] summary { cursor:pointer;min-height:36px;line-height:1.5;padding:6px 0; }
    [data-signoff-history] .signoff-request-details { display:grid;gap:12px;padding-top:10px; }
    [data-recued-quote-signoffs] .signoff-primary { display:inline-flex;align-items:center;min-height:44px;box-sizing:border-box;padding:9px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--on-accent,#fff);text-decoration:none;font-size:14px; }
    [data-recued-quote-signoffs] .signoff-replacement-notice { border-left:3px solid var(--accent);padding:10px 12px;background:var(--surface-sunk);font-size:14px;line-height:1.5; }
    [data-recued-quote-signoffs] .signoff-filters { grid-template-columns:minmax(0,2fr) minmax(0,1fr);align-items:end; }
    [data-recued-quote-signoffs] .signoff-filter-actions { grid-column:1/-1; }
    [data-recued-quote-signoffs] .signoff-actions { display:flex; flex-wrap:wrap; gap:10px; }
    [data-recued-quote-signoffs] :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  `; root.appendChild(style);
  const add = (tag: string, text: string, host: HTMLElement = root) => {
    const node = doc.createElement(tag); node.textContent = text; host.appendChild(node); return node;
  };
  const states: Record<QuoteSignoffState, string> = {
    draft: 'Draft', publishing: 'Publishing', waiting: 'Waiting for customer', accepted: 'Customer accepted',
    rejected: 'Customer declined', cancelled: 'Cancelled', superseded: 'Replaced by a newer offer', released: 'Work and invoice released',
  };
  add('h2', 'Customer sign-offs');
  add('p', 'Share a saved quote and scope. Review the customer’s reply before releasing its task and invoice.').className = 'signoff-intro';
  const setupHelp = add('p', 'Install Quote Pipeline and Invoice Book from Packs to get started. This creates a local invoice with the quoted total; sending it and collecting payment are separate steps.');
  const message = add('p', 'Loading quotes…'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const recoverPublish = doc.createElement('button'); recoverPublish.type = 'button'; recoverPublish.textContent = 'Resume saved sign-off preview';
  recoverPublish.hidden = true; root.appendChild(recoverPublish);
  const creation = doc.createElement('details');creation.setAttribute('data-signoff-create','');creation.open = opts.startNew === true;root.appendChild(creation);
  add('summary','New customer sign-off',creation);
  const form = doc.createElement('form');creation.appendChild(form);
  const additionDescription = add('p', '', form); additionDescription.hidden = true;
  const newQuote = doc.createElement('button'); newQuote.type = 'button'; newQuote.textContent = 'Start a new quote sign-off';
  newQuote.hidden = true; form.appendChild(newQuote);
  const quoteLabel = add('label', 'Open quote', form);
  const quote = doc.createElement('select'); quote.setAttribute('name', 'quote_id'); quote.required = true; quoteLabel.appendChild(quote);
  const quoteStatus = add('p', '', form); quoteStatus.setAttribute('role', 'status'); quoteStatus.setAttribute('aria-live', 'polite');
  quoteStatus.hidden = true;
  const fields: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
  const fieldHosts: Record<string, HTMLElement> = {};
  const field = (name: string, label: string, type = 'text', required = true, max?: number) => {
    const wrap = add('label', label, form);
    fieldHosts[name] = wrap;
    const control = type === 'textarea' ? doc.createElement('textarea') : doc.createElement('input');
    if (type !== 'textarea') (control as HTMLInputElement).type = type;
    control.setAttribute('name', name); control.required = required;
    if (max) control.maxLength = max;
    wrap.appendChild(control); fields[name] = control; return control;
  };
  field('display_name', 'Business name shown to the customer', 'text', true, 100);
  field('scope', 'Complete scope shown to the customer', 'textarea', true, 6000);
  add('p', 'Include deliverables, exclusions and any terms the customer must accept. Private quote notes are kept private.', form);
  field('task_title', 'Task to create after your approval', 'text', true, 200);
  field('amount', 'Added amount including VAT', 'text', false, 24);
  fieldHosts.amount!.hidden = true;
  field('invoice_ref', 'Invoice reference', 'text', true, 100);
  field('vat_amount', 'VAT included in the quoted total (blank means zero)', 'text', false, 24);
  field('issued_on', 'Invoice date (blank uses today)', 'date', false);
  field('due_on', 'Invoice due date (blank uses 30 days after issue)', 'date', false);
  const expiry = field('expiry_days', 'Link lifetime in days', 'number') as HTMLInputElement;
  expiry.min = '1'; expiry.max = '30'; expiry.step = '1'; expiry.value = '7';
  const replacementNotice = add('p', 'Preparing a preview saves this request and immediately replaces earlier active requests for the same quote, including an accepted request waiting for your review. Their links and queued releases will stop working.', form);
  replacementNotice.className = 'signoff-replacement-notice'; replacementNotice.setAttribute('data-signoff-replacement-notice', '');
  const formActions = doc.createElement('div'); formActions.className = 'signoff-actions'; form.appendChild(formActions);
  const prepare = doc.createElement('button'); prepare.type = 'submit'; prepare.textContent = 'Prepare sign-off preview'; prepare.className = 'signoff-primary'; formActions.appendChild(prepare);
  const discard = doc.createElement('button'); discard.type = 'button'; discard.textContent = 'Discard draft'; formActions.appendChild(discard);
  const previewHost = doc.createElement('div'); previewHost.setAttribute('data-signoff-preview', ''); creation.appendChild(previewHost);
  const shareHost = doc.createElement('div'); shareHost.setAttribute('data-signoff-share', ''); creation.appendChild(shareHost);
  const reminders = opts.reminders ? mountQuoteSignoffReminders({ ...opts.reminders,autoLoad: false,editorOnly: true, host: root, document: doc, conn,
    canReviewEmail: (): boolean => !paymentHistory.hasOpenEmail() && !paymentHistory.hasInFlightWork() }) : null;
  const historyHead = doc.createElement('div'); historyHead.className = 'signoff-actions'; root.appendChild(historyHead);
  add('h3', 'Requests and responses', historyHead);
  const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh'; historyHead.appendChild(refresh);
  const searchForm = doc.createElement('form'); searchForm.className = 'signoff-filters'; searchForm.setAttribute('role', 'search'); root.appendChild(searchForm);
  const searchLabel = add('label', 'Find customer, quote or invoice', searchForm);
  const search = doc.createElement('input'); search.type = 'search'; search.maxLength = QUOTE_SIGNOFF_SEARCH_MAX;
  search.setAttribute('name', 'signoff_search'); searchLabel.appendChild(search);
  const stateLabel = add('label', 'Request status', searchForm);
  const state = doc.createElement('select'); state.setAttribute('name', 'signoff_state'); stateLabel.appendChild(state);
  const all = doc.createElement('option'); all.value = ''; all.textContent = 'All requests'; state.appendChild(all);
  for (const value of ['waiting', 'accepted', 'released', 'rejected', 'cancelled', 'superseded', 'draft', 'publishing'] as const) {
    const option = doc.createElement('option'); option.value = value; option.textContent = states[value]; state.appendChild(option);
  }
  const searchActions = doc.createElement('div'); searchActions.className = 'signoff-actions signoff-filter-actions'; searchForm.appendChild(searchActions);
  const find = doc.createElement('button'); find.type = 'submit'; find.textContent = 'Search'; searchActions.appendChild(find);
  const clear = doc.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear search'; searchActions.appendChild(clear);
  const historyStatus = add('p', 'Loading requests…'); historyStatus.setAttribute('role', 'status'); historyStatus.setAttribute('aria-live', 'polite');
  const history = doc.createElement('div'); history.setAttribute('data-signoff-history', ''); root.appendChild(history);
  const pages = doc.createElement('div'); pages.className = 'signoff-actions'; root.appendChild(pages);
  const newer = doc.createElement('button'); newer.type = 'button'; newer.textContent = 'Newer requests'; pages.appendChild(newer);
  const older = doc.createElement('button'); older.type = 'button'; older.textContent = 'Older requests'; pages.appendChild(older);
  const revealControl = (target: HTMLElement | undefined) => {
    const disclosure = target?.closest<HTMLDetailsElement>('[data-signoff-disclosure="actions"]');
    if (disclosure) disclosure.open = true;
    (target ?? search).focus();
  };
  const paymentHistory = mountCustomerPaymentHistory({ host: root,document: doc,conn,mail: opts.reminders?.mail,
    payment: opts.payment,onCorrected: () => { void load();reminders?.update(); },
    canReviewEmail: (): boolean => !reminders?.hasOpenEmail() && !reminders?.hasInFlightWork() });
  const receipts = mountQuoteSignoffReceipt({ document: doc, host: root,
    read: signoff_id => conn('reception.signoff.receipt', { signoff_id }),
    returnFocus: id => {
      const buttons = root.querySelectorAll<HTMLButtonElement>('[data-signoff-receipt-open]');
      const target = Array.from(buttons).find(button => button.getAttribute('data-signoff-receipt-open') === id);
      revealControl(target);
    },
  });

  const view = doc.defaultView; const mountedHash = view?.location.hash ?? '';
  const boardScope = opts.initialSignoffId ?? 'all';
  const restored = opts.startNew ? undefined : readCustomerRequestBoardState(view?.history?.state?.recuedCustomerRequests, boardScope, mountedHash);
  let restoreBoard = !!restored; let interacted = false;
  let returnBoard = restored?.returnBoard;
  const completions = mountQuoteCompletionPanel({ document: doc,host: root,conn,reminders: !!opts.reminders,
    boardState: restored?.completion,restoreFocus: () => !interacted && returnBoard === 'completions',
    onBoardChange: interaction => { if (interaction) returnBoard = 'completions'; saveBoard(); },
    onChanged: () => { if (!disposed) void load(); } });
  const interactedWithPage = () => { interacted = true; };
  doc.addEventListener?.('pointerdown', interactedWithPage, true); doc.addEventListener?.('keydown', interactedWithPage, true);
  let disposed = false; let busy = false; let generation = 0;let focusInitial=true;
  let historyLoading = false;
  let hasLoadedHistory = false;
  let selectedSignoff = restored ? restored.signoffId : opts.initialSignoffId;let firstLoad = true;
  let currentSearch = restored?.search ?? ''; let currentState = restored?.state;
  search.value = currentSearch; state.value = currentState ?? '';
  let displayedQuery = { search: currentSearch, state: currentState, signoffId: selectedSignoff };
  const pane = () => root.closest?.<HTMLElement>('[data-recued-webclient-content]');
  const disclosureKey = (node: HTMLElement) => JSON.stringify([node.closest('[data-signoff-id]')?.getAttribute('data-signoff-id'), node.getAttribute('data-signoff-disclosure')]);
  let returnId = restored?.returnId; let returnAction = restored?.returnAction;
  const saveBoard = () => {
    if (disposed || historyLoading || !hasLoadedHistory || opts.startNew || restoreBoard || !view || view.location.hash !== mountedHash) return;
    try { view.history.replaceState({ ...view.history.state, recuedCustomerRequests: { scope: boardScope, hash: mountedHash,
      ...displayedQuery, cursor: pageCursor, previous: [...previousCursors], scrollTop: pane()?.scrollTop ?? 0, returnId, returnAction,
      completion: completions.getBoardState(),returnBoard,
      expanded: [...history.querySelectorAll<HTMLElement>('details[open]')].map(disclosureKey) } }, ''); } catch { /* Embedded History may be unavailable. */ }
  };
  const saveReturn = (event: Event) => {
    const target = (event.target as HTMLElement).closest?.<HTMLElement>('[data-signoff-action]');
    if (target) { returnBoard = 'requests'; returnId = target.closest('[data-signoff-id]')?.getAttribute('data-signoff-id') ?? undefined; returnAction = target.getAttribute('data-signoff-action') ?? undefined; }
    saveBoard();
  };
  history.addEventListener('click', saveReturn, true); history.addEventListener('focusin', saveReturn); history.addEventListener('toggle', saveBoard, true);
  pane()?.addEventListener('scroll', saveBoard, { passive: true });
  let pageCursor: string | undefined = restored?.cursor; let nextCursor: string | undefined;
  let previousCursors: Array<string | undefined> = restored?.previous ?? [];
  type HistoryPage = { cursor?: string; previous: Array<string | undefined> };
  let pendingPage: HistoryPage | undefined;
  let prepared: QuoteSignoffPrepareResult | null = null;
  let savedDraft: { id: string; terms: string } | undefined;
  let share: ReturnType<typeof mountCustomerLinkShare> | undefined;
  let sharedRequestId: string | undefined;
  let additionBase: QuoteSignoffSummary | null = null;
  const formSnapshot = () => JSON.stringify([additionBase?.signoff_id, quote.value, ...Object.values(fields).map(control => control.value)]);
  let savedForm = formSnapshot();
  let formDirty = false;
  let publish: HTMLButtonElement | undefined;
  let reviewFreshness: ReturnType<typeof mountCustomerPreviewFreshness>;
  const historyInteraction = guardCustomerHistoryInteraction(doc, history);
  const requestClocks = new Map<string, CustomerRequestClock>();
  type PublishRecovery = { id: string; terms: string; expiresAt: number };
  let publishRecovery: PublishRecovery | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const canRecoverPublish = () => !!publishRecovery && publishRecovery.terms === formSnapshot()
    && (requestClocks.get(publishRecovery.id)?.() ?? Date.now()) < publishRecovery.expiresAt;
  const renderPublishRecovery = () => { recoverPublish.hidden = prepared !== null || !canRecoverPublish(); recoverPublish.disabled = busy; };
  const setPublishRecovery = (value?: PublishRecovery) => {
    if (recoveryTimer !== undefined) clearTimeout(recoveryTimer); recoveryTimer = undefined; publishRecovery = value;
    const watch = () => {
      recoveryTimer = undefined;
      if (disposed || !publishRecovery) return;
      const remaining = publishRecovery.expiresAt - (requestClocks.get(publishRecovery.id)?.() ?? Date.now());
      if (remaining <= 0) publishRecovery = undefined;
      else recoveryTimer = setTimeout(watch,Math.min(remaining,2_147_483_647));
      renderPublishRecovery();
    };
    watch(); renderPublishRecovery();
  };
  let historyButtons: HTMLButtonElement[] = [];
  const historyControls = () => {
    refresh.disabled = busy || historyLoading;
    newer.disabled = busy || historyLoading || previousCursors.length === 0;
    older.disabled = busy || historyLoading || nextCursor === undefined;
    search.disabled = busy; state.disabled = busy; find.disabled = busy; clear.disabled = busy;
  };
  const setBusy = (value: boolean) => {
    busy = value; quote.disabled = value; prepare.disabled = value; discard.disabled = value; refresh.disabled = value; newQuote.disabled = value;
    Object.values(fields).forEach((control) => { control.disabled = value; });
    if (publish) publish.disabled = value || reviewFreshness?.isExpired() === true;
    reviewFreshness?.setBusy(value);
    historyButtons.forEach((button) => { button.disabled = value; });
    historyControls(); renderPublishRecovery();
  };
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed. Try again.';
  const invalidate = () => { reviewFreshness?.dispose(); reviewFreshness = undefined; prepared = null; publish = undefined; previewHost.replaceChildren(); renderPublishRecovery(); };
  const selectAgreement = (base: QuoteSignoffSummary | null) => {
    if (formDirty) {
      message.textContent = 'Finish or discard the current sign-off draft before choosing another agreement.';
      creation.open = true; fields.scope!.focus(); return;
    }
    setPublishRecovery(); additionBase = base; invalidate(); savedDraft = undefined;
    quoteLabel.hidden = base !== null; quote.required = base === null;
    fieldHosts.task_title!.hidden = base !== null; fields.task_title!.required = base === null;
    fieldHosts.amount!.hidden = base === null; fields.amount!.required = base !== null;
    newQuote.hidden = base === null; additionDescription.hidden = base === null;
    fieldHosts.scope!.firstChild!.textContent = base ? 'Added scope shown to the customer' : 'Complete scope shown to the customer';
    fieldHosts.vat_amount!.firstChild!.textContent = base ? 'VAT included in the added amount (blank means zero)' : 'VAT included in the quoted total (blank means zero)';
    prepare.textContent = base ? 'Prepare added-work preview' : 'Prepare sign-off preview';
    replacementNotice.textContent = base
      ? 'Preparing a preview saves this added-work request and immediately replaces pending added-work requests for this agreement, including an accepted request waiting for your review. Their links and queued releases will stop working.'
      : 'Preparing a preview saves this request and immediately replaces earlier active requests for the same quote, including an accepted request waiting for your review. Their links and queued releases will stop working.';
    if (base) {
      creation.open = true;
      const amount = base.addition?.total_amount ?? base.amount;
      additionDescription.textContent = `Add work to ${base.quote_label} for ${base.customer}. Already agreed: ${amount} ${base.currency}. Your approval will append the added scope to the existing task and create a separate invoice for the added amount.`;
      for (const name of ['scope', 'amount', 'invoice_ref', 'vat_amount', 'issued_on', 'due_on']) fields[name]!.value = '';
      message.textContent = 'Describe the added work and charge. The customer will see the previous agreement and the new total.';
    } else message.textContent = 'Choose an open quote to prepare a request.';
    savedForm = formSnapshot();
  };
  const payment = opts.payment ? createQuoteSignoffPayment({ ...opts.payment, document: doc, host: root,
    readOffer: async id => (await conn('reception.signoff.list', { signoff_id: id, limit: 1 })).signoffs[0],
    onChanged: () => { if (!disposed) void load(); },
    onMessage: text => { if (!disposed) message.textContent = text; },
  }) : null;
  const billingFields = add('fieldset','',form);add('legend','Invoice details',billingFields);billingFields.className='signoff-billing-fields';
  for (const name of ['invoice_ref','vat_amount','issued_on','due_on','expiry_days']) billingFields.appendChild(fieldHosts[name]!);
  const expiryHelp = add('p', 'Days are counted from preparation. Saved previews keep the deadline shown below.', billingFields);
  expiryHelp.className = 'signoff-expiry-help';
  form.insertBefore(billingFields,replacementNotice);
  newQuote.addEventListener('click', () => { if (!busy && !disposed) selectAgreement(null); });
  discard.addEventListener('click', () => {
    if (busy || disposed) return;
    for (const control of Object.values(fields)) control.value = '';
    expiry.value = '7'; quote.value = ''; formDirty = false;
    selectAgreement(null); savedForm = formSnapshot(); quote.focus();
    message.textContent = 'Draft fields discarded. Any request already prepared remains in Requests and responses.';
  });
  const edit = () => { formDirty = formSnapshot() !== savedForm; invalidate(); };
  form.addEventListener('input', edit); form.addEventListener('change', edit);
  const resumeSaved = async (signoffId: string) => {
    if (busy || disposed) return;
    const ownUnchangedDraft = savedDraft?.id === signoffId && savedDraft.terms === formSnapshot();
    if (formDirty && !ownUnchangedDraft) { message.textContent = 'Finish or discard the current draft before resuming a saved preview.'; creation.open = true; fields.scope!.focus(); return; }
    const keepPreview = ownUnchangedDraft && prepared?.signoff.signoff_id === signoffId;
    if (keepPreview && reviewFreshness?.customerExpired()) { focusCustomerWorkspace(reviewFreshness.element); return; }
    const rememberLink = keepPreview && previewHost.querySelector<HTMLInputElement>('input[name=remember_link_for_reminders]')?.checked === true;
    let refreshFailed = false;
    setBusy(true); if (keepPreview) reviewFreshness?.invalidateReview(); else invalidate();
    try {
      const result = await conn('reception.signoff.resume', { signoff_id: signoffId });
      if (disposed) return;
      if (result.signoff.signoff_id !== signoffId) throw new Error('This preview belongs to another request. Refresh before continuing.');
      formDirty = false; selectAgreement(result.parent ?? null); creation.open = true;
      const saved = result.signoff;
      if (![...quote.options].some(option => option.value === saved.quote_id)) { const option = doc.createElement('option'); option.value = saved.quote_id; option.textContent = `${saved.quote_label} — ${saved.customer}`; quote.appendChild(option); }
      quote.value = saved.quote_id;
      for (const name of ['scope','task_title','invoice_ref','vat_amount','issued_on','due_on','amount'] as const) fields[name]!.value = saved[name];
      fields.display_name!.value = result.display_name; expiry.value = String(result.expiry_days);
      savedForm = formSnapshot(); formDirty = false; showPrepared(result,rememberLink);
    } catch (error) { if (!disposed) { message.textContent = errorMessage(error); if (keepPreview) { refreshFailed = true; reviewFreshness?.failed(); } } }
    finally { if (!disposed) { setBusy(false); focusCustomerWorkspace(refreshFailed && reviewFreshness ? reviewFreshness.element : prepared ? previewHost : message); } }
  };
  recoverPublish.addEventListener('click',() => {
    if (!busy && !disposed && canRecoverPublish()) void resumeSaved(publishRecovery!.id);
  });
  const load = async (page: HistoryPage = pendingPage ?? { cursor: pageCursor, previous: [...previousCursors] }, sourceControl?: HTMLButtonElement) => {
    const current = ++generation; const query = { search: currentSearch, state: currentState, signoffId: selectedSignoff };
    const loadingControl = sourceControl ?? [refresh, newer, older].find(node => node === doc.activeElement);
    const previousActive = doc.activeElement;
    pendingPage = page;
    historyLoading = true; historyControls();
    void historyInteraction.ready().then(ready => {
      if (ready && !disposed && current === generation && historyLoading) historyStatus.textContent = 'Loading requests…';
    });
    try {
      let readClock: CustomerRequestClock | undefined;
      const [offers, open] = await Promise.all([conn('reception.signoff.list', { limit: 50,...(selectedSignoff ? {signoff_id:selectedSignoff} : {}),
        ...(currentSearch ? { search: currentSearch } : {}), ...(currentState ? { state: currentState } : {}),
        ...(page.cursor ? { cursor: page.cursor } : {}) }).then(result => {
          if (Number.isSafeInteger(result.server_now)) readClock = customerRequestClock(doc,result.server_now);
          return result;
        }), conn('reception.signoff.quotes').then(
        value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))]);
      if (disposed || current !== generation) return;
      if (!await historyInteraction.ready() || disposed || current !== generation) return;
      if (offers.signoffs.some(offer => offer.signoff_id === publishRecovery?.id && (offer.state !== 'draft' || offer.availability !== 'current'))) setPublishRecovery();
      if (offers.signoffs.some(offer => offer.signoff_id === sharedRequestId && (offer.state !== 'waiting' || offer.availability !== 'current'
        || offer.response && offer.response.decision !== 'not_recorded'))) share?.close();
      const focused = [...history.querySelectorAll<HTMLElement>('[data-signoff-action]')].find(node => node === doc.activeElement);
      const focusId = focused?.closest('[data-signoff-id]')?.getAttribute('data-signoff-id');
      const focusAction = focused?.getAttribute('data-signoff-action');
      const expanded = new Set(restoreBoard ? restored?.expanded : [...history.querySelectorAll<HTMLElement>('details[open]')].map(disclosureKey));
      const scroller = root.closest?.<HTMLElement>('[data-recued-webclient-content]');
      const scrollTop = scroller?.scrollTop;
      displayedQuery = query; pageCursor = page.cursor; previousCursors = [...page.previous]; nextCursor = offers.next_cursor;
      const selected = quote.value;
      const selectedLabel = [...quote.children].find(option => (option as HTMLOptionElement).value === selected)?.textContent;
      quoteStatus.hidden = open.ok;
      quoteStatus.textContent = open.ok ? '' : `Could not load open quotes. ${errorMessage(open.error)}`;
      const openQuotes = open.ok ? open.value.quotes : [];
      if (open.ok || quote.children.length === 0) {
        quote.replaceChildren();
        const placeholder = doc.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a quote'; quote.appendChild(placeholder);
        openQuotes.forEach((q) => { const option = doc.createElement('option'); option.value = q.id;
          option.textContent = `${q.label} — ${q.customer} — ${q.amount} ${q.currency} (revision ${q.revision})`; quote.appendChild(option); });
        if (open.ok && selected && !openQuotes.some(q => q.id === selected) && open.value.truncated && selectedLabel) {
          const kept = doc.createElement('option'); kept.value = selected; kept.textContent = selectedLabel; quote.appendChild(kept);
          quote.value = selected; quoteStatus.hidden = false;
          quoteStatus.textContent = 'Only the first 100 open quotes are shown. Your selection is kept; preparing will check it again.';
        } else {
          quote.value = openQuotes.some(q => q.id === selected) ? selected : '';
          if (selected && quote.value !== selected && !additionBase) {
            invalidate(); formDirty = formSnapshot() !== savedForm; quoteStatus.hidden = false;
            quoteStatus.textContent = 'Your selected quote is no longer in the open quote list. Choose an open quote to prepare a request.';
          }
        }
      }
      setupHelp.hidden = !open.ok || quote.children.length > 1 || offers.signoffs.length > 0;
      if (firstLoad && !offers.signoffs.length && !selectedSignoff) creation.open = true;firstLoad = false;
      pages.hidden = !previousCursors.length && !nextCursor;
      const restoreReplySelection = keepCustomerReplySelection(doc,history,'data-signoff-id');
      history.replaceChildren(); historyButtons = [];
      const amended = new Set(offers.signoffs.filter((offer) => offer.state === 'released' && offer.addition)
        .map((offer) => offer.addition!.parent_signoff_id));
      for (const offer of offers.signoffs) {
        if (readClock) requestClocks.set(offer.signoff_id,readClock);
        const card = doc.createElement('article'); card.setAttribute('data-signoff-id', offer.signoff_id); history.appendChild(card);
        const header = add('div', '', card); header.className = 'signoff-card-header';
        add('h3', `${offer.quote_label} — ${offer.customer}`, header);
        add('p', `${offer.amount} ${offer.currency}`, header).className = 'signoff-amount';
        const statusLine = add('div', '', card); statusLine.className = 'signoff-card-status';
        const reply = offer.response;
        const replyLabel = reply?.decision === 'unavailable' && ['accepted','rejected'].includes(offer.state) ? 'Reply processed'
          : reply && ['accepted','declined'].includes(reply.decision) && offer.state === 'waiting' ? 'Reply received · Processing pending' : states[offer.state];
        const status = add('p', replyLabel + (offer.state === 'accepted' && offer.release_review === 'waiting' ? ' · Needs your review' : ''), statusLine);
        status.setAttribute('data-signoff-state', offer.state);
        if (offer.quote_reference) add('span', `Quote ${offer.quote_reference}`, statusLine);
        if (['draft', 'publishing', 'waiting', 'accepted'].includes(offer.state)) card.appendChild(customerRequestExpiry(doc, offer.expires_at,requestClocks.get(offer.signoff_id)));
        if (offer.addition) add('p', `Added work ${offer.addition.revision} · previously ${offer.addition.base_amount} · new agreed total ${offer.addition.total_amount} ${offer.currency}.`, card);
        if (offer.availability !== 'current') add('p', `This offer is ${offer.availability}. Prepare a new request before releasing work.`, card);
        if (reply?.decision === 'declined') {
          if (offer.state !== 'rejected') add('p','Customer declined this quote.',card);
          if (reply.reason) {
            const reason = appendCustomerResponseText(doc,card,reply.reason,'Reason or proposed changes','Read full reason');
            reason.summary.setAttribute('data-signoff-response-reason',''); reason.details?.setAttribute('data-signoff-disclosure','reason');
          } else add('p','No reason supplied.',card);
        } else if (reply?.decision === 'unavailable') add('p','Customer reply unavailable. Refresh to try again.',card);
        else if (reply?.decision === 'accepted' && offer.state === 'waiting') add('p','Customer accepted this quote.',card);
        const primary = add('div', '', card); primary.className = 'signoff-actions'; primary.setAttribute('data-signoff-primary', '');
        const disclosure = doc.createElement('details'); disclosure.setAttribute('data-signoff-disclosure', 'actions'); card.appendChild(disclosure);
        add('summary', 'Details and actions', disclosure);
        const secondary = add('div', '', disclosure); secondary.className = 'signoff-request-details';
        add('p', `${offer.quote_reference ? `Quote ${offer.quote_reference} · ` : ''}revision ${offer.quote_revision}`, secondary);
        add('p', `Task: ${offer.task_title}. Invoice ${offer.invoice_ref}, due ${offer.due_on}.`, secondary);
        const details = doc.createElement('details'); details.setAttribute('data-signoff-disclosure', 'scope'); secondary.appendChild(details); add('summary', 'Offered scope', details);
        add('pre', offer.scope, details);
        const receipt = doc.createElement('button'); receipt.type = 'button'; receipt.textContent = 'View sign-off receipt';
        receipt.setAttribute('data-signoff-receipt-open', offer.signoff_id); secondary.appendChild(receipt); historyButtons.push(receipt);
        receipt.addEventListener('click', () => { if (!busy && !disposed) void receipts.open(offer.signoff_id); });
        if (offer.state === 'draft' && offer.availability === 'current') {
          const resume = add('button', 'Resume preview', primary) as HTMLButtonElement; resume.type = 'button'; historyButtons.push(resume);
          resume.addEventListener('click', () => { void resumeSaved(offer.signoff_id); });
        }
        if (offer.state === 'accepted' && offer.availability === 'current' && offer.release_review === 'waiting') {
          const inbox = add('a', 'Review release in Reception Inbox', primary); inbox.setAttribute('href', receptionInboxTargetAddress(offer.signoff_id));
        }
        if (offer.state === 'accepted' && offer.release_review === 'not_queued') add('p', 'The response is recorded. Its release is waiting to be queued for owner review.', card);
        if (offer.state === 'accepted' && offer.release_review === 'running') add('p', 'The reviewed release is running.', card);
        if (offer.state === 'accepted' && offer.release_review === 'closed') {
          add('p', 'Owner review closed without releasing work. Review the run, or cancel this request and prepare a new one.', card);
          const runs = add('a', 'Review in Runs', primary); runs.setAttribute('href', '#logs');
        }
        if (offer.state === 'waiting' && offer.endpoint_id) {
          const manage = add('a', 'Manage share link', primary); manage.setAttribute('href', `#reception/endpoints/${encodeURIComponent(offer.endpoint_id)}`);
          if (reminders && offer.availability === 'current') {
            const follow = doc.createElement('button'); follow.type = 'button'; follow.textContent = 'Set follow-up';
            follow.addEventListener('click', () => { if (!busy) void reminders.open(offer); });
            secondary.appendChild(follow); historyButtons.push(follow);
          }
        }
        if (offer.state === 'released') {
          const job = add('a', 'Open job', primary);
          job.setAttribute('href', receptionCustomerJobAddress(offer.addition?.root_signoff_id ?? offer.signoff_id).hash);
          if (offer.can_request_completion) {
            const completion = doc.createElement('button'); completion.type = 'button'; completion.textContent = 'Request completion';
            secondary.appendChild(completion); historyButtons.push(completion);
            completion.addEventListener('click',() => { if (!busy && !disposed) completions.open(offer, () => {
              const target = [...history.querySelectorAll<HTMLElement>('[data-signoff-action]')].find(node => node.closest('[data-signoff-id]')?.getAttribute('data-signoff-id') === offer.signoff_id && node.textContent === 'Request completion');
              revealControl(target);
            }); });
          }
          const follow = offer.follow_up;
          if (!follow) add('p', 'Current work and payment status is unavailable. Refresh to try again.', secondary);
          else {
            if (follow.task.availability === 'current') {
              const task = follow.task;
              add('p', `Work ${task.done ? 'complete' : 'unfinished'}: ${task.title}.`
                + (task.state !== undefined ? ` State: ${task.state}.` : '')
                + (task.progress !== undefined ? ` Progress: ${task.progress}%.` : ''), secondary);
              if (offer.task_id) {
                const openTask = add('a', 'Open task', secondary);
                openTask.setAttribute('href', `#data/task/${encodeURIComponent(offer.task_id)}`);
              }
            } else add('p', follow.task.availability === 'missing' ? 'Linked task is missing.'
              : follow.task.availability === 'changed' ? 'Linked task has changed. Review it in Tasks.'
                : 'Task status is unavailable. Refresh to try again.', secondary);
            if (follow.invoice.availability === 'current') {
              const invoice = follow.invoice;
              add('p', `Invoice ${offer.invoice_ref}: ` + (invoice.refund_due && invoice.refund_due !== '0.0000' ? 'refund owed to customer.' : invoice.amount_refunded && invoice.amount_refunded !== '0.0000' && invoice.outstanding === '0.0000' ? 'balance settled after recorded refund.' : invoice.status === 'credited' ? 'balance cleared with invoice credits.' : invoice.status === 'settled' ? 'recorded paid in full.'
                : invoice.status === 'carried_forward' ? `balance carried to ${invoice.carried_to}. Follow that invoice in Records.`
                  : `${invoice.outstanding} ${offer.currency} outstanding${invoice.overdue ? ' · overdue' : ''}. Due ${invoice.due_on}.`), secondary);
              if (invoice.amount_refund_credited!==undefined) add('p',`Customer still owes: ${invoice.outstanding} ${offer.currency}`,secondary);
              customerRefundBalanceLines(invoice,offer.currency).forEach(line=>add('p',line,secondary));
              add('p', `Recorded paid: ${invoice.amount_paid} ${offer.currency}.`, secondary);
              if (payment && canRecordSignoffPayment(offer)) {
                const recordPayment = doc.createElement('button'); recordPayment.type = 'button';
                recordPayment.textContent = 'Record payment'; recordPayment.disabled = busy;
                secondary.appendChild(recordPayment); historyButtons.push(recordPayment);
                recordPayment.addEventListener('click', () => { if (!busy && !disposed) void payment.open(offer); });
              }
            } else add('p', `Invoice ${offer.invoice_ref}: ` + (follow.invoice.availability === 'missing' ? 'record is missing.'
              : follow.invoice.availability === 'changed' ? 'terms or balance changed. Review it in Records.'
                : 'status is unavailable. Refresh to try again.'), secondary);
          }
          const paymentHistoryButton = doc.createElement('button');paymentHistoryButton.type = 'button';
          paymentHistoryButton.textContent = `View payment history — ${offer.invoice_ref}`;paymentHistoryButton.disabled = busy;
          paymentHistoryButton.setAttribute('data-signoff-payment-history',offer.signoff_id);secondary.appendChild(paymentHistoryButton);historyButtons.push(paymentHistoryButton);
          paymentHistoryButton.addEventListener('click',() => { if (!busy && !disposed) void paymentHistory.open(offer.signoff_id,() => {
            const replacement = [...history.querySelectorAll<HTMLButtonElement>('[data-signoff-payment-history]')]
              .find(node => node.getAttribute('data-signoff-payment-history') === offer.signoff_id);
            revealControl(replacement);
          }); });
          const records = add('a', 'Browse Records', secondary); records.setAttribute('href',offer.invoice_id ? customerInvoiceRecordAddress(offer.invoice_id) : '#data/records');
          if ((offer.can_add_work ?? !amended.has(offer.signoff_id))
            && (!follow || follow.task.availability === 'current' && !follow.task.done)) {
            const extra = doc.createElement('button'); extra.type = 'button'; extra.textContent = 'Add work'; extra.disabled = busy;
            secondary.appendChild(extra); historyButtons.push(extra);
            extra.addEventListener('click', () => { if (!busy && !disposed) { selectAgreement(offer); fields.scope!.focus(); } });
          }
        }
        if (['draft', 'publishing', 'waiting', 'accepted'].includes(offer.state)) {
          const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel request'; cancel.disabled = busy;
          secondary.appendChild(cancel); historyButtons.push(cancel);
          cancel.addEventListener('click', async () => {
            if (busy || disposed) return; const previousActive = doc.activeElement; setBusy(true); share?.checking();
            try { await conn('reception.signoff.cancel', { signoff_id: offer.signoff_id });
              if (disposed) return;
              if (prepared?.signoff.signoff_id === offer.signoff_id) invalidate();
              message.textContent = 'Request cancelled. Its link is closed and any queued release will be refused.';
            } catch (error) { if (!disposed) message.textContent = errorMessage(error); }
            finally { if (!disposed) { await share?.check(); if (!disposed) await load(); if (!disposed) {
              setBusy(false);
              const card = [...history.querySelectorAll<HTMLElement>('[data-signoff-id]')]
                .find(node => node.getAttribute('data-signoff-id') === offer.signoff_id);
              const target = card?.querySelector<HTMLElement>('[data-signoff-action="Cancel request"]') ?? card?.querySelector<HTMLElement>('summary');
              restoreCustomerWorkspaceControl(doc,cancel,target ? [target,refresh] : [refresh],previousActive);
            } } }
          });
        }
        if (!primary.children.length) primary.appendChild(receipt);
        for (const node of primary.children) node.className = 'signoff-primary';
        for (const node of card.querySelectorAll<HTMLElement>('button,a,summary')) {
          node.setAttribute('data-signoff-action', node.getAttribute('href') ?? node.textContent ?? '');
        }
      }
      for (const node of history.querySelectorAll<HTMLDetailsElement>('details')) node.open = expanded.has(disclosureKey(node));
      if (focusId && focusAction) {
        const replacement = [...history.querySelectorAll<HTMLElement>('[data-signoff-action]')].find(node =>
          node.closest('[data-signoff-id]')?.getAttribute('data-signoff-id') === focusId && node.getAttribute('data-signoff-action') === focusAction);
        (replacement ?? search).focus({ preventScroll: true });
      }
      restoreReplySelection?.();
      if (scroller && scrollTop !== undefined) scroller.scrollTop = scrollTop;
      const completionLoad = completions.update();
      if (restoreBoard && returnBoard === 'completions') {
        await completionLoad;
        if (disposed || current !== generation) return;
      }
      if (!offers.signoffs.length) add('p', currentSearch || currentState ? 'No requests match this search.' : 'No customer sign-offs yet.', history);
      historyStatus.textContent = `Page ${previousCursors.length + 1} · ${offers.signoffs.length} request${offers.signoffs.length === 1 ? '' : 's'}.`;
      if (offers.truncated && !offers.next_cursor) add('p', 'Update Recued to browse more requests.', history);
      if (open.ok && open.value.truncated) add('p', 'Showing up to 100 open quotes.', history);
      if (message.textContent === 'Loading quotes…' || message.textContent === '') message.textContent = open.ok
        ? openQuotes.length ? '' : 'Record an open quote in Quote Pipeline to prepare a sign-off.' : '';
      if (restoreBoard) {
        restoreBoard = false;
        if (!interacted && restored) {
          const target = returnBoard === 'completions' ? undefined : [...history.querySelectorAll<HTMLElement>('[data-signoff-action]')].find(node => node.closest('[data-signoff-id]')?.getAttribute('data-signoff-id') === returnId && node.getAttribute('data-signoff-action') === returnAction);
          target?.focus({ preventScroll: true }); if (scroller) scroller.scrollTop = restored.scrollTop;
        }
      }
      refreshCustomerRequestExpiries(root); hasLoadedHistory = true; historyLoading = false; saveBoard();
    } catch (error) {
      if (!disposed && current === generation && await historyInteraction.ready() && !disposed && current === generation) historyStatus.textContent = `Could not load requests. ${errorMessage(error)}`;
    } finally {
      if (!disposed && current === generation) {
        pendingPage = undefined; historyLoading = false; historyControls();
        restoreCustomerWorkspaceControl(doc, loadingControl ?? null, [refresh], previousActive);
        if (focusInitial) { focusInitial = false; if (root.isConnected && doc.activeElement === doc.body) focusCustomerWorkspace(opts.startNew ? creation : root); }
      }
    }
  };
  const applySearch = () => {
    if (busy || disposed) return;
    const selected = QUOTE_SIGNOFF_STATES.find(value => value === state.value);
    if (state.value && !selected) return;
    selectedSignoff = undefined;currentSearch = search.value.trim(); currentState = selected;
    hasLoadedHistory = false;
    pageCursor = undefined; previousCursors = []; nextCursor = undefined;
    history.replaceChildren(); historyButtons = []; void load({ previous: [] });
  };
  searchForm.addEventListener('submit', event => { event.preventDefault(); applySearch(); });
  state.addEventListener('change', applySearch);
  clear.addEventListener('click', () => { search.value = ''; state.value = ''; applySearch(); });
  older.addEventListener('click', () => {
    if (!busy && !disposed && !historyLoading && nextCursor) void load({ cursor: nextCursor,
      previous: [...previousCursors, pageCursor] }, older);
  });
  newer.addEventListener('click', () => {
    if (!busy && !disposed && !historyLoading && previousCursors.length) void load({
      cursor: previousCursors.at(-1), previous: previousCursors.slice(0, -1) }, newer);
  });
  const showPrepared = (result: QuoteSignoffPrepareResult,rememberLink = false) => {
      if (disposed) return; reviewFreshness?.dispose(); reviewFreshness = undefined;
      setPublishRecovery();
      prepared = result; savedDraft = { id: result.signoff.signoff_id, terms: formSnapshot() }; previewHost.replaceChildren();
      const clock = customerRequestClock(doc,result.preview_server_now); requestClocks.set(result.signoff.signoff_id,clock);
      add('h3', 'What the customer will see', previewHost); previewHost.appendChild(customerRequestExpiry(doc, result.signoff.expires_at,clock)); add('pre', result.customer_preview, previewHost);
      add('p', `After acceptance and your approval: ${result.signoff.addition ? 'append the added scope to' : 'create'} “${result.signoff.task_title}” and ${result.signoff.addition ? 'create an additional' : 'create'} invoice ${result.signoff.invoice_ref}, dated ${result.signoff.issued_on}, due ${result.signoff.due_on}.`, previewHost);
      const keepLink = doc.createElement('input'); keepLink.type = 'checkbox'; keepLink.setAttribute('name', 'remember_link_for_reminders');
      keepLink.checked = rememberLink;
      if (reminders) add('label', 'Save this link for follow-up emails', previewHost).appendChild(keepLink);
      reviewFreshness = mountCustomerPreviewFreshness({ document: doc,host: previewHost,expiresAt: result.preview_expires_at,serverNow: result.preview_server_now,customerExpiresAt: result.signoff.expires_at,clock,
        refreshLabel: 'Refresh sign-off preview',onExpire: () => setBusy(busy),onRefresh: () => { void resumeSaved(result.signoff.signoff_id); } });
      publish = doc.createElement('button'); publish.type = 'button'; publish.textContent = 'Publish sign-off link';
      publish.className = 'signoff-primary'; publish.disabled = busy || reviewFreshness?.isExpired() === true; previewHost.appendChild(publish); reviewFreshness?.setBusy(busy);
      publish.addEventListener('click', async () => {
        if (busy || disposed || !prepared || reviewFreshness?.isExpired()) return; const snapshot = prepared; setBusy(true);
        let published = false;
        try {
          const created = await conn('reception.signoff.publish', { signoff_id: snapshot.signoff.signoff_id, preview_hash: snapshot.preview_hash,
            ...(reminders && keepLink.checked ? { remember_link_for_reminders: true } : {}) });
          if (disposed) return; invalidate();
          share?.dispose(); sharedRequestId = created.signoff.signoff_id; share = mountCustomerLinkShare({ document: doc, host: shareHost, label: 'Customer sign-off link', heading: 'Sign-off link ready',
            url: created.share_url, expiresAt: created.signoff.expires_at,now: requestClocks.get(created.signoff.signoff_id),
            customer: created.signoff.customer,quoteLabel: created.signoff.quote_label,quoteReference: created.signoff.quote_reference ?? created.signoff.quote_id,
            check: async () => (await conn('reception.signoff.link.check', { kind: 'signoff', request_id: created.signoff.signoff_id, share_url: created.share_url })).current });
          savedForm = formSnapshot(); formDirty = false; savedDraft = undefined; published = true;
          message.textContent = 'Sign-off link published. Customer acceptance will queue a release for your approval.'; await load();
        } catch (error) { if (!disposed) {
          setPublishRecovery({ id: snapshot.signoff.signoff_id,terms: formSnapshot(),expiresAt: snapshot.signoff.expires_at });
          message.textContent = customerPreviewExpired(error)
          ? 'This preview expired. Choose Resume saved sign-off preview to review and publish the same saved request.'
          : `${errorMessage(error)} If the request is still a draft, choose Resume saved sign-off preview to try again.`; invalidate(); await load(); } }
        finally { if (!disposed) { setBusy(false); focusCustomerWorkspace(published ? shareHost : message); } }
      });
      message.textContent = 'Saved preview ready. Review the saved quote and scope, then publish its link. Its expiry is unchanged.';
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || disposed) return;
    if (form.reportValidity && !form.reportValidity()) return;
    setPublishRecovery(); setBusy(true); invalidate(); share?.checking();
    try {
      const common = { display_name: fields.display_name!.value, scope: fields.scope!.value,
        invoice_ref: fields.invoice_ref!.value, expiry_days: Number(expiry.value),
        ...(fields.vat_amount!.value ? { vat_amount: fields.vat_amount!.value } : {}),
        ...(fields.issued_on!.value ? { issued_on: fields.issued_on!.value } : {}),
        ...(fields.due_on!.value ? { due_on: fields.due_on!.value } : {}),
      };
      const result = additionBase
        ? await conn('reception.signoff.prepare_addition', { ...common, parent_signoff_id: additionBase.signoff_id, amount: fields.amount!.value })
        : await conn('reception.signoff.prepare', { ...common, quote_id: quote.value, task_title: fields.task_title!.value });
      if (disposed) return; showPrepared(result);
      message.textContent = result.signoff.addition
        ? 'Preview prepared. Earlier pending added-work requests have been replaced. Review the saved added work and new total, then publish its link.'
        : 'Preview prepared. Earlier active requests for this quote have been replaced. Review the saved quote and scope, then publish its link.'; await load();
    } catch (error) { if (!disposed) { message.textContent = errorMessage(error); await load(); } }
    finally { await share?.check(); if (!disposed) { setBusy(false); focusCustomerWorkspace(prepared && previewHost.isConnected ? previewHost : message); } }
  });
  refresh.addEventListener('click', () => { if (!busy && !disposed) void load(undefined, refresh); });
  const interval = setInterval(() => { refreshCustomerRequestExpiries(root); if (!busy && !disposed && !historyLoading) { void load(); reminders?.update(); } }, 20_000);
  completions.update(); void load();
  return { update: () => { if (!disposed) { void load(); reminders?.update(); } },
    hasUnsavedChanges: () => formDirty || payment?.hasUnsavedChanges() === true || paymentHistory.hasUnsavedChanges() || reminders?.hasUnsavedChanges() === true || completions.hasUnsavedChanges(),
    hasInFlightWork: () => paymentHistory.hasInFlightWork() || busy || completions.hasInFlightWork() || payment?.hasInFlightWork() === true || reminders?.hasInFlightWork() === true,
    dispose: () => { saveBoard(); pane()?.removeEventListener('scroll', saveBoard); doc.removeEventListener?.('pointerdown', interactedWithPage, true); doc.removeEventListener?.('keydown', interactedWithPage, true); disposed = true; generation++; clearInterval(interval); if (recoveryTimer !== undefined) clearTimeout(recoveryTimer); historyInteraction.dispose(); reviewFreshness?.dispose(); paymentHistory.dispose(); payment?.dispose(); reminders?.dispose(); receipts.dispose(); completions.dispose(); share?.dispose(); root.remove(); } };
};
