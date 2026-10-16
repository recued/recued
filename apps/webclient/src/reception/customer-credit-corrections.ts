import { setCustomerReviewLink } from './customer-review-link.js';
import { CUSTOMER_CREDIT_CORRECTION_RECIPE,type Conn,type ServerRpcRegistry,type CustomerPaymentHistory,
  type CustomerInvoiceCreditEntry,type CustomerCreditCorrectionPreview,type CustomerCreditCorrectionRecord } from '@recued/contracts';
import type { QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';

export type CustomerCreditCorrectionsConn = Conn<Pick<ServerRpcRegistry,
  'reception.signoff.invoice.credit.correction.prepare' | 'reception.signoff.invoice.credit.correction.history'>>;
/** An owner editor outside the payment rows. The governed recipe owns every money change. */
export const mountCustomerCreditCorrections = (opts: {
  document: Document;host: HTMLElement;conn: CustomerCreditCorrectionsConn;payment: QuoteSignoffPaymentOptions;
  onChanged: () => void;onStateChanged: () => void;canReview: () => boolean;returnFocus: (credit_id: string) => void;
}) => {
  const doc = opts.document;const root = doc.createElement('section');root.setAttribute('data-credit-corrections','');opts.host.appendChild(root);
  const add = (tag: string,text: string,host: HTMLElement = root) => { const node = doc.createElement(tag);node.textContent = text;host.appendChild(node);return node; };
  const button = (text: string,host: HTMLElement,click: () => void) => {
    const node = doc.createElement('button');node.type = 'button';node.textContent = text;host.appendChild(node);node.addEventListener('click',click);return node;
  };
  add('style',`[data-credit-corrections] [hidden]{display:none!important}
    [data-credit-corrections] h3,[data-credit-corrections] h4,[data-credit-corrections] p{overflow-wrap:anywhere}
    [data-credit-corrections] form,[data-credit-corrections] label{display:grid;gap:8px}
    [data-credit-corrections] input,[data-credit-corrections] select,[data-credit-corrections] textarea{box-sizing:border-box;max-width:100%;min-width:0}
    [data-credit-corrections] pre{white-space:pre-wrap;overflow-wrap:anywhere}
    [data-credit-correction-history]{display:grid;gap:10px}
  `);
  const editor = doc.createElement('form');editor.hidden = true;editor.tabIndex = -1;
  editor.setAttribute('aria-label','Correct invoice credit');editor.setAttribute('data-credit-correction-editor','');root.appendChild(editor);
  const heading = add('h3','Correct invoice credit',editor);
  const modeLabel = add('label','Correction action',editor);const mode = doc.createElement('select');mode.name = 'correction_action';mode.id = 'recued-credit-correction-action-'+crypto.randomUUID();modeLabel.setAttribute('for',mode.id);editor.appendChild(mode);
  for (const [value,text] of [['reverse','Reverse this credit'],['replace','Reverse and replace this credit']]) {
    const option = doc.createElement('option');option.value = value!;option.textContent = text!;mode.appendChild(option);
  }
  const fields = add('div','',editor);
  const input = (label: string,type: string,name: string,required = false,max = 512) => {
    const host = add('label',label,fields);const node = doc.createElement('input');node.type = type;node.name = name;
    node.required = required;node.maxLength = max;host.appendChild(node);return node;
  };
  const amount = input('Replacement credit amount','text','replacement_credit_amount',true,24);amount.inputMode = 'decimal';
  const issued = input('Replacement credit date','date','replacement_credit_issued_on',true);
  const replacementLabel = add('label','Replacement credit reason (shown on customer copy)',fields);const replacementReason = doc.createElement('textarea');replacementReason.name = 'replacement_credit_reason';replacementReason.maxLength = 1000;replacementLabel.appendChild(replacementReason);
  const reverseLabel = add('label','Reverse date',editor);const reversed = doc.createElement('input');reversed.type = 'date';reversed.name = 'credit_reversed_on';reversed.required = true;reverseLabel.appendChild(reversed);
  const reasonLabel = add('label','Reason for correction (shown on customer copies)',editor);const reason = doc.createElement('textarea');reason.name = 'correction_reason';reason.required = true;reason.maxLength = 1000;reasonLabel.appendChild(reason);
  const previewButton = doc.createElement('button');previewButton.type = 'submit';previewButton.textContent = 'Preview credit correction';editor.appendChild(previewButton);
  const close = button('Close credit correction',editor,() => reset());
  const status = add('p','',editor);status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const previewHost = add('div','',editor);previewHost.setAttribute('data-credit-correction-preview','');
  const review = button('Review credit correction',editor,() => { void submitReview(); });review.hidden = true;
  const runs = add('a','Review in Runs',editor);runs.hidden = true;
  add('h3','Credit correction history');const historyStatus = add('p','');historyStatus.setAttribute('role','status');
  const historyHost = add('div','');historyHost.setAttribute('data-credit-correction-history','');
  const historyActions = add('div','');
  const historyRefresh = button('Refresh credit correction history',historyActions,() => { void loadHistory(cursor,[...previous]); });
  const newer = button('Newer credit corrections',historyActions,() => { if (previous.length) void loadHistory(previous.at(-1),previous.slice(0,-1)); });
  const older = button('Older credit corrections',historyActions,() => { if (nextCursor) void loadHistory(nextCursor,[...previous,cursor]); });
  let disposed = false;let busy = false;let dirty = false;let queued = false;let generation = 0;
  let historyGeneration = 0;let historyLoading = false;let signoff_id = '';
  let selected: { history: CustomerPaymentHistory;credit: CustomerInvoiceCreditEntry } | null = null;
  let prepared: CustomerCreditCorrectionPreview | null = null;let requestKey = crypto.randomUUID();
  let cursor: string | undefined;let nextCursor: string | undefined;let previous: Array<string | undefined> = [];
  const message = (error: unknown) => error instanceof Error ? error.message : 'The credit correction could not be prepared. Try again.';
  const controls = () => {
    const locked = busy || queued;[mode,amount,issued,replacementReason,reversed,reason,previewButton].forEach(node => { node.disabled = locked; });
    close.disabled = busy;review.disabled = busy || queued || !prepared;
    fields.hidden = mode.value === 'reverse';amount.required = issued.required = replacementReason.required = !fields.hidden;
    historyRefresh.disabled = newer.disabled = older.disabled = historyLoading || busy;
    newer.disabled ||= previous.length === 0;older.disabled ||= !nextCursor;
  };
  const reset = (restoreFocus = true) => {
    if (disposed || busy) return;
    const id = selected?.credit.credit_id;generation++;selected = null;prepared = null;dirty = false;queued = false;editor.hidden = true;
    previewHost.replaceChildren();review.hidden = true;runs.hidden = true;controls();opts.onStateChanged();if (id && restoreFocus) opts.returnFocus(id);
  };
  const showHistory = (entry: CustomerCreditCorrectionRecord) => {
    const card = add('article','',historyHost);card.setAttribute('data-correction-id',entry.correction_id);
    add('h4',`${entry.applied_at === null ? 'Prepared correction for' : 'Reversed credit'} ${entry.before.credit_ref}`,card);
    add('p',entry.applied_at === null ? 'Prepared only — no credit changed.' : `Applied ${new Date(entry.applied_at).toISOString()}. Reverse date: ${entry.reversed_on}.`,card);
    add('p',`Original: ${entry.before.amount} ${entry.currency} · ${entry.before.issued_on} · ${entry.before.reason}`,card);
    add('p',entry.replacement ? `Replacement ${entry.replacement.credit_ref}: ${entry.replacement.amount} ${entry.currency} · ${entry.replacement.issued_on} · ${entry.replacement.reason}` : 'No replacement credit.',card);
    add('p',`Net credits: ${entry.before_balance.amount_credited} → ${entry.after_balance.amount_credited} ${entry.currency}. Outstanding: ${entry.before_balance.outstanding} → ${entry.after_balance.outstanding} ${entry.currency}.`,card);
    add('p',`Recorded paid stays ${entry.after_balance.amount_paid} ${entry.currency}.`,card);add('p',`Reason: ${entry.reason}`,card);add('p',`Prepared by paired client ${entry.prepared_by}.`,card);
    if (entry.run_id) add('p',`Reviewed run: ${entry.run_id}${entry.actor ? ` · ${entry.actor}` : ''}`,card);
    if (entry.applied_at === null && entry.run_id) { const link = add('a','Check review in Runs',card);setCustomerReviewLink(doc,link,entry.run_id,'#reception/signoffs/'+encodeURIComponent(entry.signoff_id)); }
  };
  const loadHistory = async (requestedCursor?: string,requestedPrevious = [...previous]) => {
    if (disposed || !signoff_id) return;
    const current = ++historyGeneration;const id = signoff_id;historyLoading = true;historyStatus.textContent = 'Loading correction history…';controls();
    try {
      const result = await opts.conn('reception.signoff.invoice.credit.correction.history',{ signoff_id: id,limit: 50,...(requestedCursor ? { cursor: requestedCursor } : {}) });
      if (disposed || current !== historyGeneration || id !== signoff_id) return;
      if (result.corrections.some(entry => entry.signoff_id !== id)) throw new Error('Correction history does not match this invoice.');
      cursor = requestedCursor;previous = requestedPrevious;nextCursor = result.next_cursor;historyHost.replaceChildren();result.corrections.forEach(showHistory);
      historyStatus.textContent = result.corrections.length ? `Correction history page ${previous.length+1}.` : 'No credit corrections recorded.';
    } catch (error) { if (!disposed && current === historyGeneration) historyStatus.textContent = message(error); }
    finally { if (!disposed && current === historyGeneration) { historyLoading = false;controls(); } }
  };
  const submitReview = async () => {
    if (disposed || busy || queued || !prepared) return;
    if (!opts.canReview()) { status.textContent = 'Close the email you have open before reviewing a credit correction.';return; }
    const target = prepared;const current = ++generation;let applied = false;busy = true;controls();opts.onStateChanged();
    try {
      const inventory = await opts.payment.listRecipes();if (disposed || current !== generation) return;
      const matches = inventory.recipes.filter(entry => entry.recipe_id === CUSTOMER_CREDIT_CORRECTION_RECIPE
        && entry.recipe.recipe_id === CUSTOMER_CREDIT_CORRECTION_RECIPE && entry.publisher_id === 'recued-core' && entry.version >= 1 && entry.recipe.version === entry.version
        && entry.recipe.metadata?.recipe_bundle === 'recued-core/reception-approval');
      if (matches.length !== 1) throw new Error('Install or update Reception — Approval from Packs before reviewing credit corrections.');
      const result = await opts.payment.execute({ recipe_id: CUSTOMER_CREDIT_CORRECTION_RECIPE,config: { ...target.review } });
      if (disposed || current !== generation) return;
      if (result.awaiting_approval === true) {
        queued = true;dirty = false;setCustomerReviewLink(doc,runs,result.run_id,'#reception/signoffs/'+encodeURIComponent(target.correction.signoff_id));status.textContent = 'Correction is waiting for your approval. Review the credit and balance change in Runs.';
      } else if (result.success === true && result.run_terminated === undefined) {
        let confirmationCursor: string | undefined;let confirmed = false;const visited = new Set<string>();
        do {
          const saved = await opts.conn('reception.signoff.invoice.credit.correction.history',{ signoff_id: target.correction.signoff_id,limit: 100,...(confirmationCursor ? { cursor: confirmationCursor } : {}) });
          if (disposed || current !== generation) return;
          const recorded = saved.corrections.find(entry => entry.correction_id === target.correction.correction_id);
          if (recorded) {
            confirmed = recorded.applied_at !== null && recorded.signoff_id === target.correction.signoff_id
              && recorded.invoice_id === target.correction.invoice_id && recorded.before.credit_id === target.correction.before.credit_id;
            break;
          }
          confirmationCursor = saved.next_cursor;
          if (confirmationCursor && visited.has(confirmationCursor)) break;
          if (confirmationCursor) visited.add(confirmationCursor);
        } while (confirmationCursor);
        if (!confirmed) {
          throw new Error('The run finished, but this correction is still unconfirmed. Check Runs and refresh payment history.');
        }
        dirty = false;queued = true;status.textContent = 'Credit correction applied. Refreshing payment history.';applied = true;await loadHistory(undefined,[]);
      } else throw new Error('The correction was not applied. Check Runs before trying again.');
    } catch (error) { if (!disposed && current === generation) status.textContent = message(error); }
    finally { if (!disposed && current === generation) { busy = false;controls();opts.onStateChanged();if (applied) { reset();opts.onChanged(); } } }
  };
  editor.addEventListener('input',() => { if (busy || queued) return;dirty = true;prepared = null;requestKey = crypto.randomUUID();previewHost.replaceChildren();review.hidden = true;controls();opts.onStateChanged(); });
  mode.addEventListener('change',() => { if (busy || queued) return;dirty = true;prepared = null;requestKey = crypto.randomUUID();previewHost.replaceChildren();review.hidden = true;controls();opts.onStateChanged(); });
  editor.addEventListener('submit',event => {
    event.preventDefault();if (disposed || busy || queued || !selected || !opts.canReview()) return;
    const target = selected;const current = ++generation;busy = true;prepared = null;review.hidden = true;previewHost.replaceChildren();status.textContent = 'Preparing credit correction…';controls();opts.onStateChanged();
    void (async () => {
      let alreadyApplied = false;
      try {
        const result = await opts.conn('reception.signoff.invoice.credit.correction.prepare',{ request_key: requestKey,signoff_id: target.history.signoff_id,
          credit_id: target.credit.credit_id,expected_snapshot_hash: target.history.snapshot_hash!,action: mode.value === 'reverse' ? 'reverse' : 'replace',reason: reason.value,reversed_on: reversed.value,
          ...(mode.value === 'reverse' ? {} : { amount: amount.value,issued_on: issued.value,replacement_reason: replacementReason.value }) });
        if (disposed || current !== generation) return;
        if (result.correction.signoff_id !== target.history.signoff_id || result.correction.before.credit_id !== target.credit.credit_id
          || result.correction.invoice_id !== target.history.invoice_id || result.review.correction_id !== result.correction.correction_id
          || !/^[a-f0-9]{64}$/.test(result.review.expected_plan_hash)) throw new Error('This correction does not match the selected credit.');
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
    open(history: CustomerPaymentHistory,credit: CustomerInvoiceCreditEntry) {
      if (disposed || busy || !editor.hidden || !history.snapshot_hash || credit.reversal || !history.credit_notes?.some(entry => entry.credit_id === credit.credit_id && !entry.reversal) || !opts.canReview()) return;
      selected = { history,credit };prepared = null;queued = false;dirty = false;generation++;requestKey = crypto.randomUUID();
      heading.textContent = `Correct credit ${credit.credit_ref} — ${history.invoice_ref}`;mode.value = 'reverse';
      amount.value = credit.amount;issued.value = credit.issued_on;replacementReason.value = credit.reason;reason.value = '';
      const now = new Date();reversed.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      previewHost.replaceChildren();review.hidden = true;runs.hidden = true;status.textContent = 'Reverse this credit or replace it. Keep the original entry and preview the exact balance change.';
      editor.hidden = false;controls();editor.focus();opts.onStateChanged();
    },
    setInvoice(value: CustomerPaymentHistory) { const id = value.signoff_id;if (signoff_id !== id) { busy = false;reset(false);signoff_id = id;historyGeneration++;cursor = nextCursor = undefined;previous = [];historyHost.replaceChildren(); }void loadHistory(cursor,[...previous]); },
    isOpen: () => !editor.hidden,hasUnsavedChanges: () => dirty,hasInFlightWork: () => busy,reset,
    dispose: () => { disposed = true;generation++;historyGeneration++;root.remove(); },
  };
};
