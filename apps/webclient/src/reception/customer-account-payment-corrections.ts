import { setCustomerReviewLink } from './customer-review-link.js';
import { CUSTOMER_ACCOUNT_PAYMENT_CORRECTION_RECIPE,type Conn,type ServerRpcRegistry,type CustomerAccountPaymentReceipt,
  type CustomerAccountPaymentCorrectionPreview,type CustomerAccountPaymentCorrectionRecord } from '@recued/contracts';
import type { QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';
export type CustomerAccountPaymentCorrectionsConn = Conn<Pick<ServerRpcRegistry,'reception.accounts.payment.receipt'
  | 'reception.accounts.payment.correction.prepare' | 'reception.accounts.payment.correction.history'>>;
export const mountCustomerAccountPaymentCorrections = (opts: {
  document: Document;host: HTMLElement;conn: CustomerAccountPaymentCorrectionsConn;payment?: QuoteSignoffPaymentOptions;
  canReview: () => boolean;onChanged: () => void;onStateChanged: () => void;
}) => {
  const doc = opts.document;
  const add = <K extends keyof HTMLElementTagNameMap>(tag: K,text: string,host: HTMLElement) => { const n = doc.createElement(tag);n.textContent = text;host.appendChild(n);return n; };
  const root = add('section','',opts.host);root.hidden = true;root.tabIndex = -1;root.setAttribute('data-account-payment-corrections','');root.setAttribute('aria-label','Account payment correction');
  const button = (text: string,host: HTMLElement,fn: () => void) => { const n = add('button',text,host);n.type = 'button';n.addEventListener('click',fn);return n; };
  const heading = add('h4','Correct account payment',root);const status = add('p','',root);status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  add('p','Correct the original invoice entries together. Enter zero to remove an active allocation. Removed entries cannot be restored. This changes recorded payments only.',root);
  const refresh = button('Refresh account correction',root,() => { if (!dirty && !busy && !queued) void load(); });
  const close = button('Close account payment correction',root,() => { if (reset()) focus?.(); });
  const form = add('form','',root);form.setAttribute('aria-label','Correct customer account payment');
  const actionLabel = add('label','Account correction action',form);const mode = add('select','',form);mode.id = 'recued-account-payment-correction-action';actionLabel.setAttribute('for',mode.id);
  for (const [value,text] of [['correct','Correct payment and allocations'],['void','Void all active allocations']]) { const n = add('option',text!,mode);n.value = value!; }
  const fields = add('div','',form);
  const input = (label: string,name: string,type = 'text',required = false,max = 512) => { const host = add('label',label,fields);const n = add('input','',host);n.name = name;n.type = type;n.required = required;n.maxLength = max;return n; };
  const amount = input('Correct account payment total','account_correction_amount','text',true,24);amount.inputMode = 'decimal';
  const received = input('Correct account received date','account_correction_date','date',true);
  const method = input('Correct account payment method','account_correction_method');const reference = input('Correct account payment reference','account_correction_reference');
  const choices = add('div','',fields);choices.setAttribute('data-account-correction-allocations','');
  const reasonHost = add('label','Reason for account payment correction',form);const reason = add('textarea','',reasonHost);reason.required = true;reason.maxLength = 1000;
  const prepare = add('button','Preview account payment correction',form);prepare.type = 'submit';
  const previewHost = add('div','',root);previewHost.setAttribute('data-account-correction-preview','');
  const review = button('Review account payment correction',root,() => { void submitReview(); });review.hidden = true;
  const runs = add('a','Review correction in Runs',root);runs.hidden = true;
  add('h4','Account payment correction history',root);const historyStatus = add('p','',root);historyStatus.setAttribute('role','status');
  const history = add('div','',root);history.setAttribute('data-account-correction-history','');
  const historyRefresh = button('Refresh account correction history',root,() => { void loadHistory(cursor,[...previous]); });
  const newer = button('Newer account corrections',root,() => { if (previous.length) void loadHistory(previous.at(-1),previous.slice(0,-1)); });
  const older = button('Older account corrections',root,() => { if (next) void loadHistory(next,[...previous,cursor]); });
  let disposed = false;let busy = false;let historyBusy = false;let dirty = false;let queued = false;let generation = 0;let historyGeneration = 0;let paymentId = '';
  let copy: CustomerAccountPaymentReceipt | null = null;let prepared: CustomerAccountPaymentCorrectionPreview | null = null;let requestKey = crypto.randomUUID();let focus: (() => void) | undefined;
  let cursor: string | undefined,next: string | undefined,previous: Array<string | undefined> = [];const allocations = new Map<string,HTMLInputElement>();
  const message = (error: unknown) => error instanceof Error ? error.message : 'The account payment correction could not be loaded. Try again.';
  const controls = () => {
    const locked = busy || queued || !copy;for (const node of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input,select,button,textarea')) node.disabled = locked;
    prepare.disabled ||= !opts.payment || !copy?.allocations.some(a => a.current_payment);fields.hidden = mode.value === 'void';amount.required = received.required = !fields.hidden;
    for (const n of allocations.values()) { n.required = !fields.hidden;n.disabled = locked || fields.hidden; }
    review.disabled = busy || queued || !prepared || !opts.payment;close.disabled = busy || historyBusy;refresh.disabled = busy || dirty || queued || historyBusy;
    historyRefresh.disabled = newer.disabled = older.disabled = busy || historyBusy;newer.disabled ||= !previous.length;older.disabled ||= !next;opts.onStateChanged();
  };
  const reset = () => {
    if (disposed || busy || historyBusy) return false;generation++;historyGeneration++;root.hidden = true;copy = null;prepared = null;dirty = queued = false;
    paymentId = '';form.reset();allocations.clear();choices.replaceChildren();previewHost.replaceChildren();history.replaceChildren();controls();return true;
  };
  const renderHistory = (c: CustomerAccountPaymentCorrectionRecord) => {
    const card = add('article','',history);card.setAttribute('data-account-correction-id',c.correction_id);
    add('h5',`${c.applied_at === null ? 'Prepared correction' : c.action === 'void' ? 'Voided account payment' : 'Corrected account payment'} ${c.correction_id}`,card);
    add('p',`${c.before_amount} → ${c.after_amount} ${c.currency}. ${c.applied_at === null ? 'Prepared only; no records changed.' : 'Applied '+new Date(c.applied_at).toISOString()+'.'}`,card);
    add('p',`Reason: ${c.reason}`,card);
    for (const a of c.allocations) add('p',`${a.invoice_ref}: ${a.before.amount} → ${a.after?.amount ?? 'removed'}; outstanding ${a.before_balance.outstanding} → ${a.after_balance.outstanding} ${c.currency}.`,card);
    if (c.run_id) add('p',`Reviewed run: ${c.run_id}`,card);
  };
  const loadHistory = async (desired?: string,prior: Array<string | undefined> = []) => {
    if (disposed || !paymentId || historyBusy) return;const id = paymentId,current = ++historyGeneration;historyBusy = true;controls();
    try {
      const result = await opts.conn('reception.accounts.payment.correction.history',{ account_payment_id: id,limit: 25,...(desired ? { cursor: desired } : {}) });
      if (disposed || current !== historyGeneration || id !== paymentId) return;
      if (result.corrections.some(c => c.account_payment_id !== id)) throw new Error('Correction history does not match this payment.');
      cursor = desired;previous = prior;next = result.next_cursor;history.replaceChildren();result.corrections.forEach(renderHistory);
      historyStatus.textContent = result.corrections.length ? `Correction history page ${prior.length+1}.` : 'No account payment corrections recorded.';
    } catch (error) { if (!disposed && current === historyGeneration) historyStatus.textContent = message(error); }
    finally { if (!disposed && current === historyGeneration) { historyBusy = false;controls(); } }
  };
  const load = async () => {
    if (disposed || busy || !paymentId) return;const id = paymentId,current = ++generation;busy = true;copy = null;prepared = null;queued = dirty = false;requestKey = crypto.randomUUID();
    form.reset();choices.replaceChildren();allocations.clear();previewHost.replaceChildren();review.hidden = true;runs.hidden = true;heading.textContent = `Correct account payment ${id}`;
    status.textContent = 'Loading the current payment receipt…';controls();const historyLoad = loadHistory();
    try {
      const result = await opts.conn('reception.accounts.payment.receipt',{ account_payment_id: id });if (disposed || current !== generation) return;
      if (result.payment.account_payment_id !== id || result.payment.applied_at === null || !/^[a-f0-9]{64}$/.test(result.statement_hash)
        || result.format !== 'recued.customer-account-payment-receipt' || result.version !== 1 || !result.allocations.length || result.allocations.length > 100) throw new Error('The receipt does not match this recorded payment.');
      copy = result;heading.textContent = `Correct account payment — ${result.payment.customer}`;amount.value = result.current_allocated;
      const active = result.allocations.filter(a => a.current_payment);const common = active[0]?.current_payment;
      received.value = common?.received_on ?? '';method.value = common?.method ?? '';reference.value = common?.reference ?? '';
      for (const a of result.allocations) {
        if (!a.current_payment) { add('p',`${a.invoice_ref}: entry already removed. It cannot be restored.`,choices);continue; }
        const label = add('label',`${a.invoice_ref} · Current allocation ${a.current_payment.amount} ${result.payment.currency} · Outstanding ${a.current_outstanding}`,choices);
        const n = add('input','',label);n.type = 'text';n.inputMode = 'decimal';n.value = a.current_payment.amount;n.required = true;n.maxLength = 24;n.setAttribute('data-account-correction-payment',a.payment_id);allocations.set(a.payment_id,n);
      }
      status.textContent = active.length ? 'Enter a correction reason, then preview every invoice change. A corrected date, method and reference apply to every remaining entry.' : 'All entries have been removed. The receipt and correction history remain available.';
    } catch (error) { if (!disposed && current === generation) status.textContent = message(error); }
    finally { await historyLoad;if (!disposed && current === generation) { busy = false;controls(); } }
  };
  const changed = () => { if (busy || queued) return;dirty = true;prepared = null;requestKey = crypto.randomUUID();previewHost.replaceChildren();review.hidden = true;runs.hidden = true;controls(); };
  const submitReview = async () => {
    if (disposed || busy || queued || !prepared || !opts.payment || !opts.canReview()) return;const target = prepared,current = ++generation;busy = true;controls();
    try {
      const inventory = await opts.payment.listRecipes();if (disposed || current !== generation) return;
      const matches = inventory.recipes.filter(r => r.recipe_id === CUSTOMER_ACCOUNT_PAYMENT_CORRECTION_RECIPE && r.recipe.recipe_id === CUSTOMER_ACCOUNT_PAYMENT_CORRECTION_RECIPE
        && r.version >= 1 && r.recipe.version === r.version && r.recipe.metadata?.recipe_bundle === 'recued-core/reception-approval');
      if (matches.length !== 1) throw new Error('Install or update Reception — Approval from Packs before reviewing account payment corrections.');
      const result = await opts.payment.execute({ recipe_id: CUSTOMER_ACCOUNT_PAYMENT_CORRECTION_RECIPE,config: { ...target.review } });if (disposed || current !== generation) return;
      if (result.awaiting_approval === true) { queued = true;dirty = false;setCustomerReviewLink(doc,runs,result.run_id,'#reception/accounts');status.textContent = 'Account payment correction is waiting for your approval. Review every invoice change in Runs. Closing this editor keeps that review in Runs.'; }
      else if (result.success === true && result.run_terminated === undefined) {
        const saved = await opts.conn('reception.accounts.payment.correction.history',{ account_payment_id: paymentId,limit: 100 });if (disposed || current !== generation) return;
        if (!saved.corrections.some(c => c.correction_id === target.correction.correction_id && c.applied_at !== null)) throw new Error('The correction is unconfirmed. Check Runs before trying again.');
        queued = true;dirty = false;status.textContent = 'Account payment correction applied. Close this editor and refresh the receipt to see current entries.';opts.onChanged();
      } else throw new Error('The correction was not confirmed. Check Runs before trying again.');
      await loadHistory();
    } catch (error) { if (!disposed && current === generation) status.textContent = message(error); }
    finally { if (!disposed && current === generation) { busy = false;controls(); } }
  };
  form.addEventListener('input',changed);mode.addEventListener('change',changed);
  form.addEventListener('submit',event => {
    event.preventDefault();if (disposed || busy || queued || !copy || !opts.payment || !opts.canReview()) return;
    const snapshot = copy,current = ++generation;busy = true;prepared = null;review.hidden = true;previewHost.replaceChildren();controls();
    void opts.conn('reception.accounts.payment.correction.prepare',{ request_key: requestKey,account_payment_id: snapshot.payment.account_payment_id,expected_receipt_hash: snapshot.statement_hash,
      action: mode.value === 'void' ? 'void' : 'correct',reason: reason.value,...(mode.value === 'void' ? {} : { amount: amount.value.trim(),received_on: received.value,method: method.value,reference: reference.value,
        allocations: [...allocations].map(([payment_id,n]) => ({ payment_id,amount: n.value.trim() })) }) }).then(result => {
      if (disposed || current !== generation) return;
      if (result.correction.account_payment_id !== paymentId || result.correction.account_id !== snapshot.payment.account_id || result.review.correction_id !== result.correction.correction_id
        || !/^[a-f0-9]{64}$/.test(result.review.expected_plan_hash)) throw new Error('The correction preview does not match this payment.');
      prepared = result;add('pre',result.review.summary,previewHost);queued = result.correction.applied_at !== null;dirty = !queued;review.hidden = queued;
      status.textContent = queued ? 'This correction is already applied. Refresh its receipt.' : 'Preview ready. Review every allocation to request owner approval.';void loadHistory();
      if (queued) opts.onChanged();
    }).catch(error => { if (!disposed && current === generation) status.textContent = message(error); })
      .finally(() => { if (!disposed && current === generation) { busy = false;controls(); } });
  });
  return {
    async open(id: string,onClosed: () => void) { if (disposed || busy || !root.hidden || !opts.canReview()) return;paymentId = id;focus = onClosed;root.hidden = false;root.focus();cursor = next = undefined;previous = [];history.replaceChildren();await load(); },
    reset,isOpen: () => !root.hidden,hasUnsavedChanges: () => dirty,hasInFlightWork: () => busy || historyBusy,
    dispose() { disposed = true;generation++;historyGeneration++;root.remove(); },
  };
};
