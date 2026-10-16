import { setCustomerReviewLink } from './customer-review-link.js';
import { CUSTOMER_PAYMENT_CORRECTION_RECIPE,type Conn,type ServerRpcRegistry,type CustomerPaymentHistory,
  type CustomerPaymentEntry,type CustomerPaymentCorrectionPreview,type CustomerPaymentCorrectionRecord } from '@recued/contracts';
import type { QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';

export type CustomerPaymentCorrectionsConn = Conn<Pick<ServerRpcRegistry,
  'reception.signoff.payment.correction.prepare' | 'reception.signoff.payment.correction.history'>>;
/** An owner editor outside the payment rows. The governed recipe owns every money change. */
export const mountCustomerPaymentCorrections = (opts: {
  document: Document;host: HTMLElement;conn: CustomerPaymentCorrectionsConn;payment: QuoteSignoffPaymentOptions;
  onChanged: () => void;onStateChanged: () => void;canReview: () => boolean;returnFocus: (payment_id: string) => void;
}) => {
  const doc = opts.document;const root = doc.createElement('section');root.setAttribute('data-payment-corrections','');opts.host.appendChild(root);
  const add = (tag: string,text: string,host: HTMLElement = root) => { const node = doc.createElement(tag);node.textContent = text;host.appendChild(node);return node; };
  const button = (text: string,host: HTMLElement,click: () => void) => {
    const node = doc.createElement('button');node.type = 'button';node.textContent = text;host.appendChild(node);node.addEventListener('click',click);return node;
  };
  add('style',`[data-payment-corrections] [hidden]{display:none!important}
    [data-payment-corrections] h3,[data-payment-corrections] h4,[data-payment-corrections] p{overflow-wrap:anywhere}
    [data-payment-corrections] form,[data-payment-corrections] label{display:grid;gap:8px}
    [data-payment-corrections] input,[data-payment-corrections] select,[data-payment-corrections] textarea{box-sizing:border-box;max-width:100%;min-width:0}
    [data-payment-corrections] pre{white-space:pre-wrap;overflow-wrap:anywhere}
    [data-payment-correction-history]{display:grid;gap:10px}
  `);
  const editor = doc.createElement('form');editor.hidden = true;editor.tabIndex = -1;
  editor.setAttribute('aria-label','Correct recorded payment');editor.setAttribute('data-payment-correction-editor','');root.appendChild(editor);
  const heading = add('h3','Correct recorded payment',editor);
  const modeLabel = add('label','Correction action',editor);const mode = doc.createElement('select');mode.name = 'correction_action';mode.id = 'recued-payment-correction-action';modeLabel.setAttribute('for',mode.id);editor.appendChild(mode);
  for (const [value,text] of [['correct','Correct payment fields'],['void','Void recorded payment']]) {
    const option = doc.createElement('option');option.value = value!;option.textContent = text!;mode.appendChild(option);
  }
  const fields = add('div','',editor);
  const input = (label: string,type: string,name: string,required = false,max = 512) => {
    const host = add('label',label,fields);const node = doc.createElement('input');node.type = type;node.name = name;
    node.required = required;node.maxLength = max;host.appendChild(node);return node;
  };
  const amount = input('Correct amount','text','correct_amount',true,24);amount.inputMode = 'decimal';
  const received = input('Correct received date','date','correct_received_on',true);
  const method = input('Correct payment method','text','correct_method');
  const reference = input('Correct payment reference','text','correct_reference');
  const reasonLabel = add('label','Reason for correction',editor);const reason = doc.createElement('textarea');reason.name = 'correction_reason';reason.required = true;reason.maxLength = 1000;reasonLabel.appendChild(reason);
  const previewButton = doc.createElement('button');previewButton.type = 'submit';previewButton.textContent = 'Preview payment correction';editor.appendChild(previewButton);
  const close = button('Close payment correction',editor,() => reset());
  const status = add('p','',editor);status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const previewHost = add('div','',editor);previewHost.setAttribute('data-payment-correction-preview','');
  const review = button('Review payment correction',editor,() => { void submitReview(); });review.hidden = true;
  const runs = add('a','Review in Runs',editor);runs.hidden = true;
  add('h3','Payment correction history');const historyStatus = add('p','');historyStatus.setAttribute('role','status');
  const historyHost = add('div','');historyHost.setAttribute('data-payment-correction-history','');
  const historyActions = add('div','');
  const historyRefresh = button('Refresh correction history',historyActions,() => { void loadHistory(cursor,[...previous]); });
  const newer = button('Newer corrections',historyActions,() => { if (previous.length) void loadHistory(previous.at(-1),previous.slice(0,-1)); });
  const older = button('Older corrections',historyActions,() => { if (nextCursor) void loadHistory(nextCursor,[...previous,cursor]); });
  let disposed = false;let busy = false;let dirty = false;let queued = false;let generation = 0;
  let historyGeneration = 0;let historyLoading = false;let signoff_id = '';
  let selected: { history: CustomerPaymentHistory;payment: CustomerPaymentEntry } | null = null;
  let prepared: CustomerPaymentCorrectionPreview | null = null;let requestKey = crypto.randomUUID();
  let cursor: string | undefined;let nextCursor: string | undefined;let previous: Array<string | undefined> = [];
  const message = (error: unknown) => error instanceof Error ? error.message : 'The payment correction could not be prepared. Try again.';
  const controls = () => {
    const locked = busy || queued;[mode,amount,received,method,reference,reason,previewButton].forEach(node => { node.disabled = locked; });
    close.disabled = busy;review.disabled = busy || queued || !prepared;
    fields.hidden = mode.value === 'void';amount.required = received.required = !fields.hidden;
    historyRefresh.disabled = newer.disabled = older.disabled = historyLoading || busy;
    newer.disabled ||= previous.length === 0;older.disabled ||= !nextCursor;
  };
  const reset = () => {
    if (disposed || busy) return;
    const id = selected?.payment.payment_id;generation++;selected = null;prepared = null;dirty = false;queued = false;editor.hidden = true;
    previewHost.replaceChildren();review.hidden = true;runs.hidden = true;controls();opts.onStateChanged();if (id) opts.returnFocus(id);
  };
  const showHistory = (entry: CustomerPaymentCorrectionRecord) => {
    const card = add('article','',historyHost);card.setAttribute('data-correction-id',entry.correction_id);
    add('h4',`${entry.applied_at === null ? 'Prepared correction for payment' : entry.action === 'void' ? 'Voided payment' : 'Corrected payment'} ${entry.payment_id}`,card);
    add('p',entry.applied_at === null ? 'Prepared only — no money changed.' : `Applied ${new Date(entry.applied_at).toISOString()}.`,card);
    add('p',`Before: ${entry.before.amount} ${entry.currency} · ${entry.before.received_on} · ${entry.before.method || '(no method)'} · ${entry.before.reference || '(no reference)'}`,card);
    add('p',entry.after ? `After: ${entry.after.amount} ${entry.currency} · ${entry.after.received_on} · ${entry.after.method || '(no method)'} · ${entry.after.reference || '(no reference)'}`
      : 'After: entry removed from the active payment ledger.',card);
    add('p',`Recorded paid: ${entry.before_balance.amount_paid} → ${entry.after_balance.amount_paid} ${entry.currency}. Outstanding: ${entry.before_balance.outstanding} → ${entry.after_balance.outstanding} ${entry.currency}.`,card);
    add('p',`Reason: ${entry.reason}`,card);add('p',`Prepared by paired client ${entry.prepared_by}.`,card);
    if (entry.after_balance.amount_credited) add('p',`Recorded credits stay ${entry.after_balance.amount_credited} ${entry.currency}.`,card);
    if (entry.run_id) add('p',`Reviewed run: ${entry.run_id}${entry.actor ? ` · ${entry.actor}` : ''}`,card);
    if (entry.applied_at === null && entry.run_id) { const link = add('a','Check review in Runs',card);setCustomerReviewLink(doc,link,entry.run_id,'#reception/signoffs/'+encodeURIComponent(entry.signoff_id)); }
  };
  const loadHistory = async (requestedCursor?: string,requestedPrevious = [...previous]) => {
    if (disposed || !signoff_id) return;
    const current = ++historyGeneration;const id = signoff_id;historyLoading = true;historyStatus.textContent = 'Loading correction history…';controls();
    try {
      const result = await opts.conn('reception.signoff.payment.correction.history',{ signoff_id: id,limit: 50,...(requestedCursor ? { cursor: requestedCursor } : {}) });
      if (disposed || current !== historyGeneration || id !== signoff_id) return;
      if (result.corrections.some(entry => entry.signoff_id !== id)) throw new Error('Correction history does not match this invoice.');
      cursor = requestedCursor;previous = requestedPrevious;nextCursor = result.next_cursor;historyHost.replaceChildren();result.corrections.forEach(showHistory);
      historyStatus.textContent = result.corrections.length ? `Correction history page ${previous.length+1}.` : 'No payment corrections recorded.';
    } catch (error) { if (!disposed && current === historyGeneration) historyStatus.textContent = message(error); }
    finally { if (!disposed && current === historyGeneration) { historyLoading = false;controls(); } }
  };
  const submitReview = async () => {
    if (disposed || busy || queued || !prepared) return;
    if (!opts.canReview()) { status.textContent = 'Close the email you have open before reviewing a payment correction.';return; }
    const target = prepared;const current = ++generation;let applied = false;busy = true;controls();opts.onStateChanged();
    try {
      const inventory = await opts.payment.listRecipes();if (disposed || current !== generation) return;
      const matches = inventory.recipes.filter(entry => entry.recipe_id === CUSTOMER_PAYMENT_CORRECTION_RECIPE
        && entry.recipe.recipe_id === CUSTOMER_PAYMENT_CORRECTION_RECIPE && entry.version >= 1 && entry.recipe.version === entry.version
        && entry.recipe.metadata?.recipe_bundle === 'recued-core/reception-approval');
      if (matches.length !== 1) throw new Error('Install or update Reception — Approval from Packs before reviewing payment corrections.');
      const result = await opts.payment.execute({ recipe_id: CUSTOMER_PAYMENT_CORRECTION_RECIPE,config: { ...target.review } });
      if (disposed || current !== generation) return;
      if (result.awaiting_approval === true) {
        queued = true;dirty = false;setCustomerReviewLink(doc,runs,result.run_id,'#reception/signoffs/'+encodeURIComponent(target.correction.signoff_id));status.textContent = 'Correction is waiting for your approval. Review the payment and balance change in Runs.';
      } else if (result.success === true && result.run_terminated === undefined) {
        const saved = await opts.conn('reception.signoff.payment.correction.history',{ signoff_id: target.correction.signoff_id,limit: 100 });
        if (disposed || current !== generation) return;
        if (!saved.corrections.some(entry => entry.correction_id === target.correction.correction_id && entry.applied_at !== null)) {
          throw new Error('The run finished, but this correction is still unconfirmed. Check Runs and refresh payment history.');
        }
        dirty = false;queued = true;status.textContent = 'Payment correction applied. Refreshing payment history.';applied = true;await loadHistory(undefined,[]);
      } else throw new Error('The correction was not applied. Check Runs before trying again.');
    } catch (error) { if (!disposed && current === generation) status.textContent = message(error); }
    finally { if (!disposed && current === generation) { busy = false;controls();opts.onStateChanged();if (applied) { reset();opts.onChanged(); } } }
  };
  editor.addEventListener('input',() => { if (busy || queued) return;dirty = true;prepared = null;requestKey = crypto.randomUUID();previewHost.replaceChildren();review.hidden = true;controls();opts.onStateChanged(); });
  mode.addEventListener('change',() => { if (busy || queued) return;dirty = true;prepared = null;requestKey = crypto.randomUUID();previewHost.replaceChildren();review.hidden = true;controls();opts.onStateChanged(); });
  editor.addEventListener('submit',event => {
    event.preventDefault();if (disposed || busy || queued || !selected || !opts.canReview()) return;
    const target = selected;const current = ++generation;busy = true;prepared = null;review.hidden = true;previewHost.replaceChildren();status.textContent = 'Preparing payment correction…';controls();opts.onStateChanged();
    void (async () => {
      let alreadyApplied = false;
      try {
        const result = await opts.conn('reception.signoff.payment.correction.prepare',{ request_key: requestKey,signoff_id: target.history.signoff_id,
          payment_id: target.payment.payment_id,expected_snapshot_hash: target.history.snapshot_hash!,action: mode.value === 'void' ? 'void' : 'correct',reason: reason.value,
          ...(mode.value === 'void' ? {} : { amount: amount.value,received_on: received.value,method: method.value,reference: reference.value }) });
        if (disposed || current !== generation) return;
        if (result.correction.signoff_id !== target.history.signoff_id || result.correction.payment_id !== target.payment.payment_id
          || result.correction.invoice_id !== target.history.invoice_id || result.review.correction_id !== result.correction.correction_id
          || !/^[a-f0-9]{64}$/.test(result.review.expected_plan_hash)) throw new Error('This correction does not match the selected payment.');
        prepared = result;add('pre',result.review.summary,previewHost);
        alreadyApplied = result.correction.applied_at !== null;review.hidden = alreadyApplied;dirty = !alreadyApplied;
        status.textContent = alreadyApplied ? 'This correction is already applied. Refreshing payment history.'
          : 'Preview ready. Review the change to request owner approval; no money has changed.';void loadHistory(undefined,[]);
      } catch (error) { if (!disposed && current === generation) status.textContent = message(error); }
      finally { if (!disposed && current === generation) { busy = false;controls();opts.onStateChanged();if (alreadyApplied) { reset();opts.onChanged(); } } }
    })();
  });
  controls();
  return {
    open(history: CustomerPaymentHistory,payment: CustomerPaymentEntry) {
      if (disposed || busy || !editor.hidden || !history.snapshot_hash || !opts.canReview()) return;
      selected = { history,payment };prepared = null;queued = false;dirty = false;generation++;requestKey = crypto.randomUUID();
      heading.textContent = `Correct payment ${payment.payment_id} — ${history.invoice_ref}`;mode.value = 'correct';
      amount.value = payment.amount;received.value = payment.received_on;method.value = payment.method ?? '';reference.value = payment.reference ?? '';reason.value = '';
      previewHost.replaceChildren();review.hidden = true;runs.hidden = true;status.textContent = 'Correct a recorded entry or void it. Enter a reason, then preview the invoice balance change.';
      editor.hidden = false;controls();editor.focus();opts.onStateChanged();
    },
    setInvoice(id: string) { if (signoff_id !== id) { signoff_id = id;historyGeneration++;cursor = nextCursor = undefined;previous = [];historyHost.replaceChildren(); }void loadHistory(cursor,[...previous]); },
    isOpen: () => !editor.hidden,hasUnsavedChanges: () => dirty,hasInFlightWork: () => busy,reset,
    dispose: () => { disposed = true;generation++;historyGeneration++;root.remove(); },
  };
};
