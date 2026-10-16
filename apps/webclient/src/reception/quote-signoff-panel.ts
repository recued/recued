import {focusCustomerWorkspace} from './customer-workspace-focus.js';
import { customerInvoiceRecordAddress } from '../data/records-navigation.js';
import { receptionInboxTargetAddress } from './navigation.js';
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

export type QuoteSignoffConn = Conn<Pick<ServerRpcRegistry,
  'reception.signoff.quotes' | 'reception.signoff.prepare' | 'reception.signoff.publish'
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
    [data-recued-quote-signoffs] { display:grid; gap:18px; max-width:850px; }
    [data-recued-quote-signoffs] [hidden] { display:none !important; }
    [data-recued-quote-signoffs] [data-signoff-completions],
    [data-recued-quote-signoffs] [data-completion-history],
    [data-recued-quote-signoffs] [data-signoff-reminders],
    [data-recued-quote-signoffs] [data-signoff-reminder-queue],
    [data-recued-quote-signoffs] [data-signoff-reminder-editor] { display:grid; gap:12px; }
    [data-recued-quote-signoffs] [data-signoff-receipt],
    [data-recued-quote-signoffs] [data-signoff-receipt-requests] { display:grid; gap:12px; }
    [data-recued-quote-signoffs] h2, [data-recued-quote-signoffs] h3, [data-recued-quote-signoffs] p { margin:0; }
    [data-recued-quote-signoffs] [data-signoff-create]>summary{cursor:pointer;font-weight:650;padding:12px;border:1px solid var(--border);border-radius:8px;color:var(--accent)}
    [data-recued-quote-signoffs] [data-signoff-create][open]>summary{margin-bottom:16px}
    [data-recued-quote-signoffs] .signoff-billing-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;border:1px solid var(--border);border-radius:10px;padding:14px}
    @media(max-width:640px){[data-recued-quote-signoffs] .signoff-billing-fields{grid-template-columns:1fr}}
    [data-recued-quote-signoffs] form { display:grid; gap:12px; }
    [data-recued-quote-signoffs] label { display:grid; gap:5px; font-size:14px; }
    [data-recued-quote-signoffs] input, [data-recued-quote-signoffs] select,
    [data-recued-quote-signoffs] textarea { width:100%; padding:10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--fg); font:inherit; }
    [data-recued-quote-signoffs] textarea { min-height:130px; resize:vertical; }
    [data-recued-quote-signoffs] input[type="checkbox"] { width:auto; }
    [data-recued-quote-signoffs] button { padding:9px 14px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--fg); cursor:pointer; width:fit-content; }
    [data-recued-quote-signoffs] button:disabled { opacity:.6; cursor:default; }
    [data-recued-quote-signoffs] pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; line-height:1.5; padding:16px; background:var(--surface-sunk); border-radius:10px; }
    [data-recued-quote-signoffs] article { display:grid; gap:8px; padding:16px; border:1px solid var(--border); border-radius:10px; }
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
  add('p', 'Offer an exact quote and scope to your customer. After they accept, review the task and invoice in Reception Inbox before releasing work.');
  const setupHelp = add('p', 'Install Quote Pipeline and Invoice Book from Packs to get started. This creates a local invoice with the quoted total; sending it and collecting payment are separate steps.');
  const message = add('p', 'Loading quotes…'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
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
  const prepare = doc.createElement('button'); prepare.type = 'submit'; prepare.textContent = 'Preview customer sign-off'; form.appendChild(prepare);
  const previewHost = doc.createElement('div'); previewHost.setAttribute('data-signoff-preview', ''); creation.appendChild(previewHost);
  const shareHost = doc.createElement('div'); shareHost.setAttribute('data-signoff-share', ''); creation.appendChild(shareHost);
  const reminders = opts.reminders ? mountQuoteSignoffReminders({ ...opts.reminders,autoLoad: false,editorOnly: true, host: root, document: doc, conn,
    canReviewEmail: (): boolean => !paymentHistory.hasOpenEmail() && !paymentHistory.hasInFlightWork() }) : null;
  const historyHead = doc.createElement('div'); historyHead.className = 'signoff-actions'; root.appendChild(historyHead);
  add('h3', 'Requests and responses', historyHead);
  const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh'; historyHead.appendChild(refresh);
  const searchForm = doc.createElement('form'); searchForm.setAttribute('role', 'search'); root.appendChild(searchForm);
  const searchLabel = add('label', 'Find customer, quote or invoice', searchForm);
  const search = doc.createElement('input'); search.type = 'search'; search.maxLength = QUOTE_SIGNOFF_SEARCH_MAX;
  search.setAttribute('name', 'signoff_search'); searchLabel.appendChild(search);
  const stateLabel = add('label', 'Request status', searchForm);
  const state = doc.createElement('select'); state.setAttribute('name', 'signoff_state'); stateLabel.appendChild(state);
  const all = doc.createElement('option'); all.value = ''; all.textContent = 'All requests'; state.appendChild(all);
  for (const value of ['waiting', 'accepted', 'released', 'rejected', 'cancelled', 'superseded', 'draft', 'publishing'] as const) {
    const option = doc.createElement('option'); option.value = value; option.textContent = states[value]; state.appendChild(option);
  }
  const searchActions = doc.createElement('div'); searchActions.className = 'signoff-actions'; searchForm.appendChild(searchActions);
  const find = doc.createElement('button'); find.type = 'submit'; find.textContent = 'Search'; searchActions.appendChild(find);
  const clear = doc.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear search'; searchActions.appendChild(clear);
  const historyStatus = add('p', 'Loading requests…'); historyStatus.setAttribute('role', 'status'); historyStatus.setAttribute('aria-live', 'polite');
  const history = doc.createElement('div'); history.setAttribute('data-signoff-history', ''); root.appendChild(history);
  const pages = doc.createElement('div'); pages.className = 'signoff-actions'; root.appendChild(pages);
  const newer = doc.createElement('button'); newer.type = 'button'; newer.textContent = 'Newer requests'; pages.appendChild(newer);
  const older = doc.createElement('button'); older.type = 'button'; older.textContent = 'Older requests'; pages.appendChild(older);
  const paymentHistory = mountCustomerPaymentHistory({ host: root,document: doc,conn,mail: opts.reminders?.mail,
    payment: opts.payment,onCorrected: () => { void load();reminders?.update(); },
    canReviewEmail: (): boolean => !reminders?.hasOpenEmail() && !reminders?.hasInFlightWork() });
  const receipts = mountQuoteSignoffReceipt({ document: doc, host: root,
    read: signoff_id => conn('reception.signoff.receipt', { signoff_id }),
    returnFocus: id => {
      const buttons = root.querySelectorAll<HTMLButtonElement>('[data-signoff-receipt-open]');
      const target = Array.from(buttons).find(button => button.getAttribute('data-signoff-receipt-open') === id);
      (target ?? search).focus();
    },
  });

  const completions = mountQuoteCompletionPanel({ document: doc,host: root,conn,reminders: !!opts.reminders,
    onChanged: () => { if (!disposed) void load(); } });
  let disposed = false; let busy = false; let generation = 0;let focusInitial=true;
  let historyLoading = false;
  let selectedSignoff = opts.initialSignoffId;let firstLoad = true;
  let currentSearch = ''; let currentState: QuoteSignoffState | undefined;
  let pageCursor: string | undefined; let nextCursor: string | undefined;
  let previousCursors: Array<string | undefined> = [];
  type HistoryPage = { cursor?: string; previous: Array<string | undefined> };
  let pendingPage: HistoryPage | undefined;
  let prepared: QuoteSignoffPrepareResult | null = null;
  let additionBase: QuoteSignoffSummary | null = null;
  let publish: HTMLButtonElement | undefined;
  let historyButtons: HTMLButtonElement[] = [];
  const historyControls = () => {
    refresh.disabled = busy || historyLoading;
    newer.disabled = busy || historyLoading || previousCursors.length === 0;
    older.disabled = busy || historyLoading || nextCursor === undefined;
    search.disabled = busy; state.disabled = busy; find.disabled = busy; clear.disabled = busy;
  };
  const setBusy = (value: boolean) => {
    busy = value; quote.disabled = value; prepare.disabled = value; refresh.disabled = value; newQuote.disabled = value;
    Object.values(fields).forEach((control) => { control.disabled = value; });
    if (publish) publish.disabled = value;
    historyButtons.forEach((button) => { button.disabled = value; });
    historyControls();
  };
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed. Try again.';
  const invalidate = () => { prepared = null; publish = undefined; previewHost.replaceChildren(); };
  const selectAgreement = (base: QuoteSignoffSummary | null) => {
    additionBase = base; invalidate(); shareHost.replaceChildren();
    quoteLabel.hidden = base !== null; quote.required = base === null;
    fieldHosts.task_title!.hidden = base !== null; fields.task_title!.required = base === null;
    fieldHosts.amount!.hidden = base === null; fields.amount!.required = base !== null;
    newQuote.hidden = base === null; additionDescription.hidden = base === null;
    fieldHosts.scope!.firstChild!.textContent = base ? 'Added scope shown to the customer' : 'Complete scope shown to the customer';
    fieldHosts.vat_amount!.firstChild!.textContent = base ? 'VAT included in the added amount (blank means zero)' : 'VAT included in the quoted total (blank means zero)';
    prepare.textContent = base ? 'Preview added work' : 'Preview customer sign-off';
    if (base) {
      creation.open = true;
      const amount = base.addition?.total_amount ?? base.amount;
      additionDescription.textContent = `Add work to ${base.quote_label} for ${base.customer}. Already agreed: ${amount} ${base.currency}. Your approval will append the added scope to the existing task and create a separate invoice for the added amount.`;
      for (const name of ['scope', 'amount', 'invoice_ref', 'vat_amount', 'issued_on', 'due_on']) fields[name]!.value = '';
      message.textContent = 'Describe the added work and charge. The customer will see the previous agreement and the new total.';
    } else message.textContent = 'Choose an open quote to prepare a request.';
  };
  const payment = opts.payment ? createQuoteSignoffPayment({ ...opts.payment, document: doc, host: root,
    readOffer: async id => (await conn('reception.signoff.list', { signoff_id: id, limit: 1 })).signoffs[0],
    onChanged: () => { if (!disposed) void load(); },
    onMessage: text => { if (!disposed) message.textContent = text; },
  }) : null;
  const billingFields = add('fieldset','',form);add('legend','Invoice details',billingFields);billingFields.className='signoff-billing-fields';
  for (const name of ['invoice_ref','vat_amount','issued_on','due_on','expiry_days']) billingFields.appendChild(fieldHosts[name]!);
  form.insertBefore(billingFields,prepare);
  newQuote.addEventListener('click', () => { if (!busy && !disposed) selectAgreement(null); });
  form.addEventListener('input', invalidate); form.addEventListener('change', invalidate);
  const load = async (page: HistoryPage = pendingPage ?? { cursor: pageCursor, previous: [...previousCursors] }) => {
    const current = ++generation;
    pendingPage = page;
    historyLoading = true; historyControls(); historyStatus.textContent = 'Loading requests…';
    try {
      const [offers, open] = await Promise.all([conn('reception.signoff.list', { limit: 50,...(selectedSignoff ? {signoff_id:selectedSignoff} : {}),
        ...(currentSearch ? { search: currentSearch } : {}), ...(currentState ? { state: currentState } : {}),
        ...(page.cursor ? { cursor: page.cursor } : {}) }), conn('reception.signoff.quotes').then(
        value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))]);
      if (disposed || current !== generation) return;
      pageCursor = page.cursor; previousCursors = [...page.previous]; nextCursor = offers.next_cursor;
      const selected = quote.value; quote.replaceChildren();
      const placeholder = doc.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a quote'; quote.appendChild(placeholder);
      quoteStatus.hidden = open.ok;
      quoteStatus.textContent = open.ok ? '' : `Could not load open quotes. ${errorMessage(open.error)}`;
      const openQuotes = open.ok ? open.value.quotes : [];
      setupHelp.hidden = openQuotes.length > 0 || offers.signoffs.length > 0;
      if (firstLoad && !offers.signoffs.length && !selectedSignoff) creation.open = true;firstLoad = false;
      pages.hidden = !previousCursors.length && !nextCursor;
      openQuotes.forEach((q) => { const option = doc.createElement('option'); option.value = q.id;
        option.textContent = `${q.label} — ${q.customer} — ${q.amount} ${q.currency} (revision ${q.revision})`; quote.appendChild(option); });
      quote.value = openQuotes.some((q) => q.id === selected) ? selected : '';
      history.replaceChildren(); historyButtons = [];
      const amended = new Set(offers.signoffs.filter((offer) => offer.state === 'released' && offer.addition)
        .map((offer) => offer.addition!.parent_signoff_id));
      for (const offer of offers.signoffs) {
        const card = doc.createElement('article'); card.setAttribute('data-signoff-id', offer.signoff_id); history.appendChild(card);
        add('h3', `${offer.quote_label} — ${offer.customer}`, card);
        if (offer.quote_reference) add('p', `Quote ${offer.quote_reference}.`, card);
        add('p', `${states[offer.state]} · revision ${offer.quote_revision} · ${offer.amount} ${offer.currency}`, card);
        if (offer.addition) add('p', `Added work ${offer.addition.revision} · previously ${offer.addition.base_amount} · new agreed total ${offer.addition.total_amount} ${offer.currency}.`, card);
        if (offer.availability !== 'current') add('p', `This offer is ${offer.availability}. Prepare a new request before releasing work.`, card);
        add('p', `Task: ${offer.task_title}. Invoice ${offer.invoice_ref}, due ${offer.due_on}.`, card);
        const details = doc.createElement('details'); card.appendChild(details); add('summary', 'Offered scope', details);
        add('pre', offer.scope, details);
        const receipt = doc.createElement('button'); receipt.type = 'button'; receipt.textContent = 'View sign-off receipt';
        receipt.setAttribute('data-signoff-receipt-open', offer.signoff_id); card.appendChild(receipt); historyButtons.push(receipt);
        receipt.addEventListener('click', () => { if (!busy && !disposed) void receipts.open(offer.signoff_id); });
        if (offer.state === 'accepted' && offer.availability === 'current' && offer.release_review === 'waiting') {
          const inbox = add('a', 'Review release in Reception Inbox', card); inbox.setAttribute('href', receptionInboxTargetAddress(offer.signoff_id));
        }
        if (offer.state === 'accepted' && offer.release_review === 'not_queued') add('p', 'The response is recorded. Its release is waiting to be queued for owner review.', card);
        if (offer.state === 'accepted' && offer.release_review === 'running') add('p', 'The reviewed release is running.', card);
        if (offer.state === 'accepted' && offer.release_review === 'closed') {
          add('p', 'Owner review closed without releasing work. Review the run, or cancel this request and prepare a new one.', card);
          const runs = add('a', 'Review in Runs', card); runs.setAttribute('href', '#logs');
        }
        if (offer.state === 'waiting' && offer.endpoint_id) {
          const manage = add('a', 'Manage share link', card); manage.setAttribute('href', `#reception/endpoints/${encodeURIComponent(offer.endpoint_id)}`);
          if (reminders && offer.availability === 'current') {
            const follow = doc.createElement('button'); follow.type = 'button'; follow.textContent = 'Set follow-up';
            follow.addEventListener('click', () => { if (!busy) void reminders.open(offer); });
            card.appendChild(follow); historyButtons.push(follow);
          }
        }
        if (offer.state === 'released') {
          if (offer.can_request_completion) {
            const completion = doc.createElement('button'); completion.type = 'button'; completion.textContent = 'Request completion';
            card.appendChild(completion); historyButtons.push(completion);
            completion.addEventListener('click',() => { if (!busy && !disposed) completions.open(offer); });
          }
          const follow = offer.follow_up;
          if (!follow) add('p', 'Current work and payment status is unavailable. Refresh to try again.', card);
          else {
            if (follow.task.availability === 'current') {
              const task = follow.task;
              add('p', `Work ${task.done ? 'complete' : 'unfinished'}: ${task.title}.`
                + (task.state !== undefined ? ` State: ${task.state}.` : '')
                + (task.progress !== undefined ? ` Progress: ${task.progress}%.` : ''), card);
              if (offer.task_id) {
                const openTask = add('a', 'Open task', card);
                openTask.setAttribute('href', `#data/task/${encodeURIComponent(offer.task_id)}`);
              }
            } else add('p', follow.task.availability === 'missing' ? 'Linked task is missing.'
              : follow.task.availability === 'changed' ? 'Linked task has changed. Review it in Tasks.'
                : 'Task status is unavailable. Refresh to try again.', card);
            if (follow.invoice.availability === 'current') {
              const invoice = follow.invoice;
              add('p', `Invoice ${offer.invoice_ref}: ` + (invoice.refund_due && invoice.refund_due !== '0.0000' ? 'refund owed to customer.' : invoice.amount_refunded && invoice.amount_refunded !== '0.0000' && invoice.outstanding === '0.0000' ? 'balance settled after recorded refund.' : invoice.status === 'credited' ? 'balance cleared with invoice credits.' : invoice.status === 'settled' ? 'recorded paid in full.'
                : invoice.status === 'carried_forward' ? `balance carried to ${invoice.carried_to}. Follow that invoice in Records.`
                  : `${invoice.outstanding} ${offer.currency} outstanding${invoice.overdue ? ' · overdue' : ''}. Due ${invoice.due_on}.`), card);
              if (invoice.amount_refund_credited!==undefined) add('p',`Customer still owes: ${invoice.outstanding} ${offer.currency}`,card);
              customerRefundBalanceLines(invoice,offer.currency).forEach(line=>add('p',line,card));
              add('p', `Recorded paid: ${invoice.amount_paid} ${offer.currency}.`, card);
              if (payment && canRecordSignoffPayment(offer)) {
                const recordPayment = doc.createElement('button'); recordPayment.type = 'button';
                recordPayment.textContent = 'Record payment'; recordPayment.disabled = busy;
                card.appendChild(recordPayment); historyButtons.push(recordPayment);
                recordPayment.addEventListener('click', () => { if (!busy && !disposed) void payment.open(offer); });
              }
            } else add('p', `Invoice ${offer.invoice_ref}: ` + (follow.invoice.availability === 'missing' ? 'record is missing.'
              : follow.invoice.availability === 'changed' ? 'terms or balance changed. Review it in Records.'
                : 'status is unavailable. Refresh to try again.'), card);
          }
          const paymentHistoryButton = doc.createElement('button');paymentHistoryButton.type = 'button';
          paymentHistoryButton.textContent = `View payment history — ${offer.invoice_ref}`;paymentHistoryButton.disabled = busy;
          paymentHistoryButton.setAttribute('data-signoff-payment-history',offer.signoff_id);card.appendChild(paymentHistoryButton);historyButtons.push(paymentHistoryButton);
          paymentHistoryButton.addEventListener('click',() => { if (!busy && !disposed) void paymentHistory.open(offer.signoff_id,() => {
            const replacement = [...history.querySelectorAll<HTMLButtonElement>('[data-signoff-payment-history]')]
              .find(node => node.getAttribute('data-signoff-payment-history') === offer.signoff_id);
            (replacement ?? search).focus();
          }); });
          const records = add('a', 'Browse Records', card); records.setAttribute('href',offer.invoice_id ? customerInvoiceRecordAddress(offer.invoice_id) : '#data/records');
          if ((offer.can_add_work ?? !amended.has(offer.signoff_id))
            && (!follow || follow.task.availability === 'current' && !follow.task.done)) {
            const extra = doc.createElement('button'); extra.type = 'button'; extra.textContent = 'Add work'; extra.disabled = busy;
            card.appendChild(extra); historyButtons.push(extra);
            extra.addEventListener('click', () => { if (!busy && !disposed) { selectAgreement(offer); fields.scope!.focus(); } });
          }
        }
        if (['draft', 'publishing', 'waiting', 'accepted'].includes(offer.state)) {
          const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel request'; cancel.disabled = busy;
          card.appendChild(cancel); historyButtons.push(cancel);
          cancel.addEventListener('click', async () => {
            if (busy || disposed) return; setBusy(true);
            try { await conn('reception.signoff.cancel', { signoff_id: offer.signoff_id });
              if (disposed) return;
              if (prepared?.signoff.signoff_id === offer.signoff_id) invalidate();
              message.textContent = 'Request cancelled. Its link is closed and any queued release will be refused.'; await load();
            } catch (error) { if (!disposed) message.textContent = errorMessage(error); }
            finally { if (!disposed) setBusy(false); }
          });
        }
      }
      completions.update();
      if (!offers.signoffs.length) add('p', currentSearch || currentState ? 'No requests match this search.' : 'No customer sign-offs yet.', history);
      historyStatus.textContent = `Page ${previousCursors.length + 1} · ${offers.signoffs.length} request${offers.signoffs.length === 1 ? '' : 's'}.`;
      if (offers.truncated && !offers.next_cursor) add('p', 'Update Recued to browse more requests.', history);
      if (open.ok && open.value.truncated) add('p', 'Showing up to 100 open quotes.', history);
      if (message.textContent === 'Loading quotes…' || message.textContent === '') message.textContent = open.ok
        ? openQuotes.length ? 'Choose an open quote to prepare a request.' : 'Record an open quote in Quote Pipeline to prepare a sign-off.' : '';
    } catch (error) {
      if (!disposed && current === generation) historyStatus.textContent = `Could not load requests. ${errorMessage(error)}`;
    } finally {
      if (!disposed && current === generation) { pendingPage = undefined;historyLoading = false;historyControls();if(focusInitial){focusInitial=false;if(root.isConnected && doc.activeElement===doc.body)focusCustomerWorkspace(opts.startNew ? creation : root);} }
    }
  };
  const applySearch = () => {
    if (busy || disposed) return;
    const selected = QUOTE_SIGNOFF_STATES.find(value => value === state.value);
    if (state.value && !selected) return;
    selectedSignoff = undefined;currentSearch = search.value.trim(); currentState = selected;
    pageCursor = undefined; previousCursors = []; nextCursor = undefined;
    history.replaceChildren(); historyButtons = []; void load({ previous: [] });
  };
  searchForm.addEventListener('submit', event => { event.preventDefault(); applySearch(); });
  state.addEventListener('change', applySearch);
  clear.addEventListener('click', () => { search.value = ''; state.value = ''; applySearch(); });
  older.addEventListener('click', () => {
    if (!busy && !disposed && !historyLoading && nextCursor) void load({ cursor: nextCursor,
      previous: [...previousCursors, pageCursor] });
  });
  newer.addEventListener('click', () => {
    if (!busy && !disposed && !historyLoading && previousCursors.length) void load({
      cursor: previousCursors.at(-1), previous: previousCursors.slice(0, -1) });
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || disposed) return;
    if (form.reportValidity && !form.reportValidity()) return;
    setBusy(true); invalidate(); shareHost.replaceChildren();
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
      if (disposed) return; prepared = result;
      add('h3', 'What the customer will see', previewHost); add('pre', result.customer_preview, previewHost);
      add('p', `After acceptance and your approval: ${result.signoff.addition ? 'append the added scope to' : 'create'} “${result.signoff.task_title}” and ${result.signoff.addition ? 'create an additional' : 'create'} invoice ${result.signoff.invoice_ref}, dated ${result.signoff.issued_on}, due ${result.signoff.due_on}.`, previewHost);
      const keepLink = doc.createElement('input'); keepLink.type = 'checkbox'; keepLink.setAttribute('name', 'remember_link_for_reminders');
      if (reminders) add('label', 'Save this link for follow-up emails', previewHost).appendChild(keepLink);
      publish = doc.createElement('button'); publish.type = 'button'; publish.textContent = 'Publish sign-off link';
      publish.disabled = busy; previewHost.appendChild(publish);
      publish.addEventListener('click', async () => {
        if (busy || disposed || !prepared) return; const snapshot = prepared; setBusy(true);
        try {
          const created = await conn('reception.signoff.publish', { signoff_id: snapshot.signoff.signoff_id, preview_hash: snapshot.preview_hash,
            ...(reminders && keepLink.checked ? { remember_link_for_reminders: true } : {}) });
          if (disposed) return; invalidate();
          add('p', 'Share this link with your customer. It accepts one response.', shareHost);
          const label = add('label', 'Customer sign-off link', shareHost);
          const link = doc.createElement('input'); link.type = 'url'; link.readOnly = true; link.value = created.share_url; label.appendChild(link);
          link.addEventListener('focus', () => link.select());
          message.textContent = 'Sign-off link published. Customer acceptance will queue a release for your approval.'; await load();
        } catch (error) { if (!disposed) { message.textContent = `${errorMessage(error)} Preview again if the preview has expired.`; invalidate(); } }
        finally { if (!disposed) setBusy(false); }
      });
      message.textContent = result.signoff.addition
        ? 'Review the added work and new total, then publish its link. This replaces any pending amendment for this agreement.'
        : 'Review the exact quote and scope, then publish its link. This replaces any earlier offer for this quote.'; await load();
    } catch (error) { if (!disposed) message.textContent = errorMessage(error); }
    finally { if (!disposed) setBusy(false); }
  });
  refresh.addEventListener('click', () => { if (!busy && !disposed) void load(); });
  const interval = setInterval(() => { if (!busy && !disposed && !historyLoading) { void load(); reminders?.update(); } }, 20_000);
  completions.update(); void load();
  return { update: () => { if (!disposed) { void load(); reminders?.update(); } },
    hasUnsavedChanges: () => paymentHistory.hasUnsavedChanges() || reminders?.hasUnsavedChanges() === true || completions.hasUnsavedChanges(),
    hasInFlightWork: () => paymentHistory.hasInFlightWork() || busy || completions.hasInFlightWork() || payment?.hasInFlightWork() === true || reminders?.hasInFlightWork() === true,
    dispose: () => { disposed = true; generation++; clearInterval(interval); paymentHistory.dispose(); payment?.dispose(); reminders?.dispose(); receipts.dispose(); completions.dispose(); root.remove(); } };
};
