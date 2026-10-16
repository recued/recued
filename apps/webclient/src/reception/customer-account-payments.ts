import {focusCustomerWorkspace} from './customer-workspace-focus.js';
import { setCustomerReviewLink } from './customer-review-link.js';
import { accountPaymentDocument } from './customer-financial-document.js';
import { readCustomerAccountContactDefaults,type CustomerAccountContactDefaultsReadConn } from './customer-account-contact-defaults.js';
import { mountCustomerAccountPaymentCorrections,type CustomerAccountPaymentCorrectionsConn } from './customer-account-payment-corrections.js';
import { CUSTOMER_ACCOUNT_PAYMENT_RECIPE,CUSTOMER_ACCOUNT_PAYMENT_MAX_ALLOCATIONS,customerAccountPaymentReceiptLines,
  type Conn,type ServerRpcRegistry,type CustomerAccountStatement,type CustomerAccountPaymentPreview,type CustomerAccountPaymentRecord,
  type CustomerAccountPaymentReceipt } from '@recued/contracts';
import type { MailComposeDeps } from '../mail/mail-compose-host.js';
import type { QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';
import { mountCustomerStatementView } from './customer-statement-view.js';

export type CustomerAccountPaymentsConn = CustomerAccountContactDefaultsReadConn & CustomerAccountPaymentCorrectionsConn & Conn<Pick<ServerRpcRegistry,'reception.accounts.statement' | 'reception.accounts.payment.prepare'
  | 'reception.accounts.payment.history' | 'reception.accounts.payment.receipt' | 'reception.accounts.payment.receipt.draft'>>;
/** Account payment edits remain outside the job board's refreshed cards. */
export const mountCustomerAccountPayments = (opts: {
  host: HTMLElement;document: Document;conn: CustomerAccountPaymentsConn;payment?: QuoteSignoffPaymentOptions;mail?: MailComposeDeps;
  canReview: () => boolean;onChanged: () => void;onStateChanged: () => void;
}) => {
  const { document: doc,conn } = opts;
  const add = <K extends keyof HTMLElementTagNameMap>(tag: K,text: string,host: HTMLElement) => {
    const node = doc.createElement(tag);node.textContent = text;host.appendChild(node);return node;
  };
  const root = add('section','',opts.host);root.hidden = true;root.tabIndex = -1;root.setAttribute('data-customer-account-payments','');root.setAttribute('aria-label','Customer account payments');
  const button = (text: string,host: HTMLElement,click: () => void) => { const node = add('button',text,host);node.type = 'button';node.addEventListener('click',click);return node; };
  add('style',`[data-customer-account-payments] [hidden]{display:none!important}
    [data-customer-account-payments] pre{white-space:pre-wrap;overflow-wrap:anywhere}
    [data-customer-account-payments] form,[data-customer-account-payments] label{display:grid;gap:8px;min-width:0}
    [data-customer-account-payments] input,[data-customer-account-payments] select{box-sizing:border-box;min-width:0;max-width:100%}
  `,root);
  const heading = add('h3','Customer account payments',root);
  const status = add('p','',root);status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  add('p','Record money already received. Choose invoices from this saved account, use one currency and allocate the exact payment amount.',root);
  const actions = add('div','',root);
  const refresh = button('Refresh account payments',actions,() => { if (canReplace()) void load(); });
  const close = button('Close account payments',actions,() => {
    if (!canReplace()) return;generation++;root.hidden = true;returnFocus?.();opts.onStateChanged();
  });
  const form = add('form','',root);form.setAttribute('aria-label','Record customer account payment');
  const input = (label: string,name: string,type = 'text',required = false,max = 512) => {
    const host = add('label',label,form);const node = add('input','',host);node.name = name;node.type = type;node.required = required;node.maxLength = max;return node;
  };
  const currencyLabel = add('label','Payment currency',form);const currency = add('select','',form);currency.id = 'recued-account-payment-currency';currencyLabel.setAttribute('for',currency.id);currency.required = true;
  const amount = input('Amount received','account_payment_amount','text',true,24);amount.inputMode = 'decimal';
  const received = input('Received on','account_payment_received_on','date',true);
  const method = input('Payment method','account_payment_method');const reference = input('Payment reference','account_payment_reference');
  add('p','Enter an amount beside each invoice being paid. Leave the others blank. Only invoices in the selected currency are submitted.',form);
  const choices = add('div','',form);choices.setAttribute('data-account-payment-invoices','');
  const prepare = add('button','Preview account payment',form);prepare.type = 'submit';
  const discard = button('Discard account payment',form,() => {
    if (busy || correction.isOpen()) return;if (!receipt.reset()) { status.textContent = 'Close the receipt email before changing this payment.';return; }if (queued) { dirty = false;queued = false;void load();return; }dirty = false;queued = false;prepared = null;requestKey = crypto.randomUUID();values.clear();form.reset();
    if (copy) { currency.value = copy.balances[0]!.currency;renderChoices(); }previewHost.replaceChildren();review.hidden = true;controls();opts.onStateChanged();amount.focus();
  });
  const previewHost = add('div','',root);previewHost.setAttribute('data-account-payment-preview','');
  const review = button('Review account payment',root,() => { void submitReview(); });review.hidden = true;
  const runs = add('a','Review in Runs',root);runs.hidden = true;
  add('h4','Account payment history',root);const historyStatus = add('p','',root);historyStatus.setAttribute('role','status');
  const history = add('div','',root);history.setAttribute('data-account-payment-history','');
  const paging = add('div','',root);
  const newer = button('Newer account payments',paging,() => { if (previous.length && canReplace()) void loadHistory(previous.at(-1),previous.slice(0,-1)); });
  const older = button('Older account payments',paging,() => { if (next && canReplace()) void loadHistory(next,[...previous,cursor]); });
  let disposed = false;let busy = false;let historyBusy = false;let dirty = false;let queued = false;let generation = 0;let historyGeneration = 0;let accountId = '';
  let copy: CustomerAccountStatement | null = null;let prepared: CustomerAccountPaymentPreview | null = null;let requestKey = crypto.randomUUID();
  const values = new Map<string,string>();let returnFocus: (() => void) | undefined;
  let cursor: string | undefined;let next: string | undefined;let previous: Array<string | undefined> = [];
  const receipt = mountCustomerStatementView<CustomerAccountPaymentReceipt>({ host: root,document: doc,kind: 'account-payment',mail: opts.mail,
    canReviewEmail: () => !dirty && !busy && !correction.isOpen() && opts.canReview(),onStateChanged: opts.onStateChanged,
    read: id => conn('reception.accounts.payment.receipt',{ account_payment_id: id }),
    contactDefaults: copy => readCustomerAccountContactDefaults(conn,copy.payment.account_id),
    prepare: (snapshot,sender,recipient) => conn('reception.accounts.payment.receipt.draft',{ account_payment_id: snapshot.payment.account_payment_id,
      expected_receipt_hash: snapshot.statement_hash,sender_mail_instance: sender,recipient_email: recipient }),
    validate: (snapshot,id) => snapshot.format === 'recued.customer-account-payment-receipt' && snapshot.version === 1 && snapshot.payment.account_payment_id === id
      && snapshot.payment.account_id === accountId && snapshot.payment.applied_at !== null && snapshot.allocations.length > 0 && snapshot.allocations.length <= CUSTOMER_ACCOUNT_PAYMENT_MAX_ALLOCATIONS,
    documentModel: accountPaymentDocument,lines: customerAccountPaymentReceiptLines,heading: snapshot => `Customer account payment receipt — ${snapshot.payment.customer}`,
  });
  const correction = mountCustomerAccountPaymentCorrections({ host: root,document: doc,conn,payment: opts.payment,
    canReview: () => !dirty && !busy && !receipt.hasOpenEmail() && !receipt.hasInFlightWork() && opts.canReview(),
    onChanged: () => {
      copy = null;prepared = null;values.clear();form.reset();currency.replaceChildren();choices.replaceChildren();previewHost.replaceChildren();review.hidden = true;
      status.textContent = 'The account payment changed. Refresh account payments before recording another. Pending reviews stay in Runs.';
      controls();void loadHistory();opts.onChanged();
    },onStateChanged: () => controls() });
  const message = (error: unknown) => error instanceof Error ? error.message : 'The account payment could not be loaded. Try again.';
  const inFlight = () => busy || historyBusy || receipt.hasInFlightWork() || correction.hasInFlightWork();
  const canReplace = () => {
    if (inFlight() || dirty || correction.isOpen() || receipt.hasUnsavedChanges() || receipt.hasOpenEmail()) { status.textContent = 'Finish or discard the account payment and close its receipt email before changing this view.';return false; }return true;
  };
  const controls = () => {
    const locked = busy || queued || !copy || correction.isOpen() || !opts.canReview();for (const node of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) node.disabled = locked;
    prepare.disabled = locked || !copy || !opts.payment;discard.disabled = busy || !copy || correction.isOpen() || !opts.canReview();discard.textContent = queued ? 'Start another account payment' : 'Discard account payment';
    review.disabled = busy || queued || !prepared || !opts.payment || correction.isOpen();refresh.disabled = close.disabled = inFlight();
    newer.disabled = inFlight() || !previous.length;older.disabled = inFlight() || !next;opts.onStateChanged();
  };
  const changed = () => {
    if (busy || queued || correction.isOpen() || !opts.canReview()) return;dirty = true;prepared = null;requestKey = crypto.randomUUID();previewHost.replaceChildren();review.hidden = true;runs.hidden = true;controls();
  };
  const renderChoices = () => {
    choices.replaceChildren();if (!copy) return;
    for (const job of copy.jobs.filter(j => j.currency === currency.value)) for (const invoice of job.invoices.filter(i => /^0\.0{4}$/.test(i.outstanding) === false)) {
      const label = add('label',`${invoice.invoice_ref} · ${job.quote_label} · Outstanding ${invoice.outstanding} ${currency.value}`,choices);
      const node = add('input','',label);node.type = 'text';node.inputMode = 'decimal';node.maxLength = 24;node.value = values.get(invoice.signoff_id) ?? '';
      node.setAttribute('data-account-payment-invoice',invoice.signoff_id);
      node.addEventListener('input',() => { if (!busy && !queued && !correction.isOpen() && opts.canReview()) values.set(invoice.signoff_id,node.value); });
    }
    if (!choices.childElementCount) add('p','No open invoice balances in this currency.',choices);
  };
  const showHistory = (p: CustomerAccountPaymentRecord) => {
    const card = add('article','',history);card.setAttribute('data-account-payment-id',p.account_payment_id);
    add('h5',`${p.applied_at === null ? 'Prepared payment' : 'Recorded payment'} ${p.amount} ${p.currency}`,card);
    add('p',`Payment ${p.account_payment_id} · ${p.received_on}${p.reference ? ` · ${p.reference}` : ''}`,card);
    add('p',p.applied_at === null ? 'Prepared only. Check approval in Runs.' : `Recorded ${new Date(p.applied_at).toISOString()}.`,card);
    for (const a of p.allocations) add('p',`${a.invoice_ref}: originally allocated ${a.amount} ${p.currency}.`,card);
    if (p.applied_at !== null) {
      const correct = button(`Correct account payment ${p.account_payment_id}`,card,() => { if (canReplace() && receipt.reset()) void correction.open(p.account_payment_id,() => history.querySelector<HTMLButtonElement>(`[data-account-payment-correct="${p.account_payment_id}"]`)?.focus()); });
      correct.setAttribute('data-account-payment-correct',p.account_payment_id);correct.disabled = !opts.payment;
      add('p','The receipt shows current entries and any changes since this payment was recorded.',card);
      const view = button(`View account payment receipt ${p.account_payment_id}`,card,() => { if (canReplace()) void receipt.open(p.account_payment_id,() => view.focus()); });
    }
  };
  const loadHistory = async (desired?: string,prior: Array<string | undefined> = []) => {
    if (disposed || !accountId || historyBusy) return;const id = accountId;const current = ++historyGeneration;historyBusy = true;controls();
    try {
      const result = await conn('reception.accounts.payment.history',{ account_id: id,limit: 25,...(desired ? { cursor: desired } : {}) });
      if (disposed || current !== historyGeneration || id !== accountId) return;
      if (result.payments.some(p => p.account_id !== id)) throw new Error('Payment history does not match this account.');
      cursor = desired;previous = prior;next = result.next_cursor;history.replaceChildren();result.payments.forEach(showHistory);
      historyStatus.textContent = result.payments.length ? `Account payment history page ${prior.length+1}.` : 'No account payments recorded.';
    } catch (error) { if (!disposed && current === historyGeneration) historyStatus.textContent = message(error); }
    finally { if (!disposed && current === historyGeneration) { historyBusy = false;controls(); } }
  };
  const load = async () => {
    if (disposed || busy || !accountId || !receipt.reset()) return;
    const id = accountId;const current = ++generation;busy = true;copy = null;prepared = null;queued = dirty = false;
    heading.textContent = `Customer account payments — Account ${id}`;values.clear();form.reset();currency.replaceChildren();choices.replaceChildren();
    review.hidden = true;runs.hidden = true;previewHost.replaceChildren();status.textContent = 'Loading account payment balances…';controls();
    const historyLoad = loadHistory();
    try {
      const result = await conn('reception.accounts.statement',{ account_id: id });if (disposed || current !== generation) return;
      if (result.account_id !== id || result.format !== 'recued.customer-account-statement' || !/^[a-f0-9]{64}$/.test(result.statement_hash) || !result.balances.length) throw new Error('The account statement does not match this account.');
      copy = result;heading.textContent = `Customer account payments — ${result.customer}`;currency.replaceChildren();
      for (const balance of result.balances) { const option = add('option',balance.currency,currency);option.value = balance.currency; }
      values.clear();prepared = null;queued = dirty = false;form.reset();currency.value = result.balances[0]!.currency;renderChoices();previewHost.replaceChildren();review.hidden = true;runs.hidden = true;
      status.textContent = opts.payment ? 'Choose the received payment and its invoice allocations, then preview.' : 'Payment entry is unavailable. Recorded receipts remain available below.';
    } catch (error) { if (!disposed && current === generation) status.textContent = message(error); }
    finally { await historyLoad;if (!disposed && current === generation) { busy = false;controls(); } }
  };
  const submitReview = async () => {
    if (disposed || busy || queued || !prepared || !opts.payment || correction.isOpen()) return;
    if (!opts.canReview() || receipt.hasOpenEmail() || receipt.hasInFlightWork()) { status.textContent = 'Close the email you have open before reviewing an account payment.';return; }
    const target = prepared;const current = ++generation;busy = true;controls();
    try {
      const inventory = await opts.payment.listRecipes();if (disposed || current !== generation) return;
      const matches = inventory.recipes.filter(r => r.recipe_id === CUSTOMER_ACCOUNT_PAYMENT_RECIPE && r.recipe.recipe_id === CUSTOMER_ACCOUNT_PAYMENT_RECIPE
        && r.version >= 1 && r.recipe.version === r.version && r.recipe.metadata?.recipe_bundle === 'recued-core/reception-approval');
      if (matches.length !== 1) throw new Error('Install or update Reception — Approval from Packs before recording account payments.');
      const result = await opts.payment.execute({ recipe_id: CUSTOMER_ACCOUNT_PAYMENT_RECIPE,config: { ...target.review } });
      if (disposed || current !== generation) return;
      if (result.awaiting_approval === true) { queued = true;dirty = false;setCustomerReviewLink(doc,runs,result.run_id,'#reception/accounts');status.textContent = 'Account payment is waiting for your approval. Review every allocation in Runs. Starting another entry keeps this submitted review in Runs.'; }
      else if (result.success === true && result.run_terminated === undefined) {
        const confirmed = await conn('reception.accounts.payment.receipt',{ account_payment_id: target.payment.account_payment_id });if (disposed || current !== generation) return;
        if (confirmed.payment.account_payment_id !== target.payment.account_payment_id || confirmed.payment.applied_at === null) throw new Error('The payment is unconfirmed. Check Runs before trying again.');
        queued = true;dirty = false;status.textContent = 'Account payment recorded. Its combined receipt is available in payment history.';opts.onChanged();
      } else throw new Error('The payment was not confirmed. Check Runs before trying again.');
      await loadHistory();
    } catch (error) { if (!disposed && current === generation) status.textContent = message(error); }
    finally { if (!disposed && current === generation) { busy = false;controls(); } }
  };
  form.addEventListener('input',changed);currency.addEventListener('change',() => { changed();renderChoices();controls(); });
  form.addEventListener('submit',event => {
    event.preventDefault();if (disposed || busy || queued || !copy || !opts.payment || correction.isOpen()) return;
    if (!opts.canReview() || receipt.hasOpenEmail() || receipt.hasInFlightWork()) { status.textContent = 'Close the email you have open before preparing an account payment.';return; }
    const snapshot = copy;const current = ++generation;busy = true;prepared = null;review.hidden = true;previewHost.replaceChildren();controls();
    const allocations = snapshot.jobs.filter(j => j.currency === currency.value).flatMap(j => j.invoices)
      .filter(i => values.get(i.signoff_id)?.trim()).map(i => ({ signoff_id: i.signoff_id,amount: values.get(i.signoff_id)!.trim() }));
    void conn('reception.accounts.payment.prepare',{ request_key: requestKey,account_id: snapshot.account_id,expected_statement_hash: snapshot.statement_hash,
      currency: currency.value,amount: amount.value.trim(),received_on: received.value,method: method.value,reference: reference.value,allocations }).then(result => {
      if (disposed || current !== generation) return;
      if (result.payment.account_id !== snapshot.account_id || result.review.account_payment_id !== result.payment.account_payment_id
        || !/^[a-f0-9]{64}$/.test(result.review.expected_plan_hash) || !result.payment.allocations.length) throw new Error('The payment preview does not match this account.');
      prepared = result;add('pre',result.review.summary,previewHost);const applied = result.payment.applied_at !== null;
      queued = applied;dirty = !applied;review.hidden = applied;status.textContent = applied ? 'This payment is already recorded. View its receipt in payment history.' : 'Preview ready. Review every invoice allocation to request owner approval.';
      void loadHistory();
    }).catch(error => { if (!disposed && current === generation) status.textContent = message(error); })
      .finally(() => { if (!disposed && current === generation) { busy = false;controls(); } });
  });
  controls();
  return {
    async open(id: string,onClosed?: () => void) {
      if (!canReplace() || !receipt.reset()) return;accountId = id;returnFocus = onClosed;root.hidden = false;cursor = next = undefined;previous = [];history.replaceChildren();await load();if(!disposed)focusCustomerWorkspace(root);
    },
    updateControls: controls,hasOpenEmail: receipt.hasOpenEmail,hasUnsavedChanges: () => dirty || correction.isOpen() || receipt.hasUnsavedChanges(),hasInFlightWork: inFlight,
    dispose() { disposed = true;generation++;historyGeneration++;receipt.dispose();correction.dispose();root.remove(); },
  };
};
