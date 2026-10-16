import { setCustomerReviewLink } from './customer-review-link.js';
import { mountCustomerCreditCorrections } from './customer-credit-corrections.js';
import { CUSTOMER_INVOICE_CREDIT_RECIPE,customerInvoiceCreditLines,type Conn,type ServerRpcRegistry,
  type CustomerPaymentHistory,type CustomerInvoiceCreditPreview,type CustomerInvoiceCreditCopy } from '@recued/contracts';
import type { QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';
import { downloadReceiptHtml } from './quote-signoff-receipt.js';
export type CustomerInvoiceCreditsConn = Conn<Pick<ServerRpcRegistry,
  'reception.signoff.invoice.credit.correction.prepare' | 'reception.signoff.invoice.credit.correction.history' | 'reception.signoff.invoice.credit.prepare' | 'reception.signoff.invoice.credit.history' | 'reception.signoff.invoice.credit.copy'>>;
const escape = (value: string) => value.replace(/[&<>"']/g,char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[char]!);
export const customerInvoiceCreditHtml = (copy: CustomerInvoiceCreditCopy): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Customer invoice credit</title><style>body{font:16px/1.5 system-ui,sans-serif;color:#17212b;background:white;max-width:850px;margin:32px auto;padding:0 24px}p{white-space:pre-wrap;overflow-wrap:anywhere}h1{line-height:1.2}@media print{body{margin:0;padding:0}}</style></head><body><h1>Customer invoice credit</h1>
${customerInvoiceCreditLines(copy).map(line => `<p>${escape(line)}</p>`).join('\n')}</body></html>`;
/** Credit edits and the customer copy live outside the payment rows refreshed by polling. */
export const mountCustomerInvoiceCredits = (opts: { document: Document;host: HTMLElement;conn: CustomerInvoiceCreditsConn;payment: QuoteSignoffPaymentOptions;
  onChanged: () => void;onStateChanged: () => void;canReview: () => boolean;returnFocus: () => void }) => {
  const doc = opts.document;const root = doc.createElement('section');root.setAttribute('data-invoice-credits','');opts.host.appendChild(root);
  const add = (tag: string,text: string,host: HTMLElement = root) => { const node = doc.createElement(tag);node.textContent = text;host.appendChild(node);return node; };
  const button = (text: string,host: HTMLElement,click: () => void) => { const node = doc.createElement('button');node.type = 'button';node.textContent = text;host.appendChild(node);node.addEventListener('click',click);return node; };
  add('style',`[data-invoice-credits] [hidden]{display:none!important}[data-invoice-credits] h3,[data-invoice-credits] h4,[data-invoice-credits] p{overflow-wrap:anywhere}
    [data-invoice-credits] form,[data-invoice-credits] label{display:grid;gap:8px}[data-invoice-credits] input,[data-invoice-credits] textarea{box-sizing:border-box;max-width:100%;min-width:0}
    [data-invoice-credits] pre{white-space:pre-wrap;overflow-wrap:anywhere}`);
  add('h3','Invoice credits');const issue = button('Issue invoice credit',root,() => open());
  const editor = doc.createElement('form');editor.hidden = true;editor.tabIndex = -1;editor.setAttribute('aria-label','Issue invoice credit');editor.setAttribute('data-invoice-credit-editor','');root.appendChild(editor);
  const heading = add('h4','Issue invoice credit',editor);
  const input = (label: string,type: string,name: string,max: number) => { const host = add('label',label,editor);const node = doc.createElement('input');node.type = type;node.name = name;node.required = true;node.maxLength = max;host.appendChild(node);return node; };
  const amount = input('Credit amount','text','credit_amount',24);amount.inputMode = 'decimal';const issued = input('Credit date','date','credit_issued_on',10);
  const label = add('label','Credit reason (shown on customer copy)',editor);const reason = doc.createElement('textarea');reason.name = 'credit_reason';reason.required = true;reason.maxLength = 1000;label.appendChild(reason);
  const prepare = doc.createElement('button');prepare.type = 'submit';prepare.textContent = 'Preview invoice credit';editor.appendChild(prepare);
  const close = button('Close invoice credit',editor,() => reset());const status = add('p','',root);status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const preview = add('div','',editor);preview.setAttribute('data-invoice-credit-preview','');const review = button('Review invoice credit',editor,() => { void submit(); });review.hidden = true;
  const runs = add('a','Review credit in Runs',editor);runs.hidden = true;
  const historyStatus = add('p','');historyStatus.setAttribute('role','status');const historyHost = add('div','');historyHost.setAttribute('data-invoice-credit-history','');
  const actions = add('div','');const refresh = button('Refresh invoice credits',actions,() => { void loadHistory(cursor,[...previous]); });
  const newer = button('Newer invoice credits',actions,() => { if (previous.length) void loadHistory(previous.at(-1),previous.slice(0,-1)); });
  const older = button('Older invoice credits',actions,() => { if (nextCursor) void loadHistory(nextCursor,[...previous,cursor]); });
  const copyHost = add('section','');copyHost.hidden = true;copyHost.setAttribute('data-invoice-credit-copy','');add('h3','Customer invoice credit',copyHost);const copyLines = add('div','',copyHost);
  const print = button('Print invoice credit',copyHost,() => printCopy());const download = button('Download invoice credit',copyHost,() => {
    if (copy && !disposed) { try { downloadReceiptHtml(doc,root,`invoice-credit-${copy.copy_hash.slice(0,16)}.html`,customerInvoiceCreditHtml(copy)); } catch { status.textContent = 'The credit copy could not be downloaded. Try Print instead.'; } }
  });
  let corrections: ReturnType<typeof mountCustomerCreditCorrections> | null = null;let creditButtons: HTMLButtonElement[] = [];
  let disposed = false;let busy = false;let dirty = false;let queued = false;let generation = 0;let historyGeneration = 0;let loading = false;
  let history: CustomerPaymentHistory | null = null;let frozen: CustomerPaymentHistory | null = null;let prepared: CustomerInvoiceCreditPreview | null = null;
  let requestKey = crypto.randomUUID();let cursor: string | undefined;let nextCursor: string | undefined;let previous: Array<string | undefined> = [];
  let copy: CustomerInvoiceCreditCopy | null = null;let frame: HTMLIFrameElement | null = null;let timer: ReturnType<typeof setTimeout> | undefined;
  const message = (error: unknown) => error instanceof Error ? error.message : 'Invoice credits could not be loaded. Try again.';
  const clearPrint = () => { if (timer !== undefined) clearTimeout(timer);timer = undefined;frame?.remove();frame = null; };
  const controls = () => {
    const correcting = corrections?.hasInFlightWork() === true || corrections?.isOpen() === true;
    const locked = busy || queued;[amount,issued,reason,prepare].forEach(node => { node.disabled = locked; });close.disabled = busy;review.disabled = locked || !prepared;
    issue.disabled = busy || correcting || !editor.hidden || !history?.snapshot_hash || history.invoice.availability !== 'current' || history.invoice.status !== 'open';
    refresh.disabled = newer.disabled = older.disabled = loading || busy || correcting;newer.disabled ||= previous.length === 0;older.disabled ||= !nextCursor;
    print.disabled = !copy || frame !== null || busy || correcting;download.disabled = !copy || busy || correcting;creditButtons.forEach(node => { node.disabled = busy || !editor.hidden || correcting; });
  };
  const reset = (restoreFocus = true) => { if (disposed || busy) return;generation++;frozen = null;prepared = null;dirty = queued = false;editor.hidden = true;copy = null;copyHost.hidden = true;clearPrint();preview.replaceChildren();review.hidden = true;runs.hidden = true;controls();opts.onStateChanged();if (restoreFocus) issue.focus(); };
  const printCopy = () => {
    if (!copy || disposed || frame) return;const node = doc.createElement('iframe');frame = node;node.setAttribute('title','Printable invoice credit');node.setAttribute('sandbox','allow-same-origin allow-modals');
    node.style.cssText = 'position:fixed;left:-10000px;top:0;width:850px;height:1100px;border:0';controls();
    node.addEventListener('load',() => { if (disposed || frame !== node) return;if (timer !== undefined) clearTimeout(timer);timer = undefined;
      const view = node.contentWindow;if (!view) { clearPrint();controls();return; }view.addEventListener('afterprint',() => { if (frame === node) { clearPrint();controls();print.focus(); } },{ once:true });
      try { view.focus();view.print(); } catch { clearPrint();controls();status.textContent = 'Could not open the print view. Download the credit copy instead.'; }
    },{ once:true });
    timer = setTimeout(() => { if (frame === node) { clearPrint();controls();status.textContent = 'The print view could not load. Try again.'; } },10_000);node.srcdoc = customerInvoiceCreditHtml(copy);root.appendChild(node);
  };
  const readCopy = async (credit_id: string) => {
    if (disposed || busy || corrections?.isOpen() || !history) return;const id = history.signoff_id;const current = ++generation;busy = true;copy = null;clearPrint();copyHost.hidden = true;controls();opts.onStateChanged();
    try { const result = await opts.conn('reception.signoff.invoice.credit.copy',{ signoff_id:id,credit_id });if (disposed || current !== generation) return;
      if (result.format !== 'recued.customer-invoice-credit' || ![1,2,3].includes(result.version) || result.signoff_id !== id || result.credit.credit_id !== credit_id || !/^[a-f0-9]{64}$/.test(result.copy_hash)) throw new Error('This credit copy does not match the selected invoice.');
      copy = result;copyLines.replaceChildren();customerInvoiceCreditLines(result).forEach(line => add('p',line,copyLines));copyHost.hidden = false;status.textContent = 'Customer credit copy ready. Its balance is a snapshot of local records.';
    } catch (error) { if (!disposed && current === generation) status.textContent = message(error); }
    finally { if (!disposed && current === generation) { busy = false;controls();opts.onStateChanged(); } }
  };
  const loadHistory = async (requested?: string,trail = [...previous]) => {
    if (disposed || !history) return;const id = history.signoff_id;const current = ++historyGeneration;loading = true;controls();historyStatus.textContent = 'Loading invoice credits…';
    try { const result = await opts.conn('reception.signoff.invoice.credit.history',{ signoff_id:id,limit:50,...(requested ? { cursor:requested } : {}) });if (disposed || current !== historyGeneration) return;
      if (result.credits.some(credit => credit.signoff_id !== id)) throw new Error('Credit history does not match this invoice.');
      cursor = requested;previous = trail;nextCursor = result.next_cursor;historyHost.replaceChildren();creditButtons = [];
      for (const credit of result.credits) { const card = add('article','',historyHost);card.setAttribute('data-credit-id',credit.credit_id);add('h4',credit.credit_ref,card);
        add('p',credit.applied_at === null ? 'Prepared only — no credit issued.' : `Issued ${credit.issued_on} · ${credit.amount} ${credit.currency}`,card);add('p',`Reason: ${credit.reason}`,card);
        add('p',`Outstanding: ${credit.before_balance.outstanding} → ${credit.after_balance.outstanding} ${credit.currency}.`,card);
        if (credit.run_id) add('p',`Reviewed run: ${credit.run_id}`,card);
        if (credit.replaces_credit_id) add('p',`Replaces credit: CR-${credit.replaces_credit_id}`,card);
        if (credit.reversal) add('p',`Reversed on ${credit.reversal.reversed_on}: ${credit.reversal.reason}${credit.reversal.replacement_credit_id ? ` · Replacement: CR-${credit.reversal.replacement_credit_id}` : ''}`,card);
        if (credit.applied_at !== null) {
          creditButtons.push(button('View customer credit copy',card,() => { void readCopy(credit.credit_id); }));
          const currentCredit = history?.credit_notes?.find(entry => entry.credit_id === credit.credit_id);
          if (history && currentCredit && !currentCredit.reversal && !credit.reversal && history.snapshot_hash) creditButtons.push(button('Correct invoice credit',card,() => {
            if (!disposed && !busy && editor.hidden && history && opts.canReview()) { copy = null;copyHost.hidden = true;clearPrint();corrections?.open(history,currentCredit); }
          }));
        }
      }
      historyStatus.textContent = result.credits.length ? `Invoice credit history page ${previous.length+1}.` : 'No invoice credits recorded.';
    } catch (error) { if (!disposed && current === historyGeneration) historyStatus.textContent = message(error); }
    finally { if (!disposed && current === historyGeneration) { loading = false;controls(); } }
  };
  const open = () => {
    if (disposed || busy || corrections?.isOpen() || !editor.hidden || !history?.snapshot_hash) return;
    if (!opts.canReview()) { status.textContent = 'Finish or close the payment correction or email before issuing a credit.';return; }
    frozen = history;prepared = null;queued = dirty = false;requestKey = crypto.randomUUID();generation++;heading.textContent = `Issue credit — ${history.invoice_ref}`;
    const now = new Date();issued.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;amount.value = reason.value = '';
    preview.replaceChildren();review.hidden = true;runs.hidden = true;editor.hidden = false;copy = null;clearPrint();copyHost.hidden = true;status.textContent = 'Enter a credit up to the unpaid balance. Its reason appears on the customer copy.';controls();editor.focus();opts.onStateChanged();
  };
  const submit = async () => {
    if (disposed || busy || queued || !prepared || !opts.canReview()) return;const target = prepared;const current = ++generation;busy = true;controls();opts.onStateChanged();let applied = false;
    try { const inventory = await opts.payment.listRecipes();if (disposed || current !== generation) return;
      const matches = inventory.recipes.filter(row => row.recipe_id === CUSTOMER_INVOICE_CREDIT_RECIPE && row.recipe.recipe_id === CUSTOMER_INVOICE_CREDIT_RECIPE && row.publisher_id === 'recued-core' && row.version >= 1 && row.recipe.version === row.version && row.recipe.metadata?.recipe_bundle === 'recued-core/reception-approval');
      if (matches.length !== 1) throw new Error('Update Reception — Approval from Packs before reviewing invoice credits.');
      const result = await opts.payment.execute({ recipe_id:CUSTOMER_INVOICE_CREDIT_RECIPE,config:{ ...target.review } });if (disposed || current !== generation) return;
      if (result.awaiting_approval === true) { queued = true;dirty = false;setCustomerReviewLink(doc,runs,result.run_id,'#reception/signoffs/'+encodeURIComponent(target.credit.signoff_id));status.textContent = 'Invoice credit is waiting for owner approval. Review the balance change in Runs.'; }
      else if (result.success === true && result.run_terminated === undefined) {
        const saved = await opts.conn('reception.signoff.invoice.credit.history',{ signoff_id:target.credit.signoff_id,limit:100 });if (disposed || current !== generation) return;
        if (!saved.credits.some(credit => credit.credit_id === target.credit.credit_id && credit.applied_at !== null)) throw new Error('The run finished but this credit is unconfirmed. Check Runs and refresh.');
        dirty = false;applied = true;status.textContent = 'Invoice credit issued. Refreshing balances.';await loadHistory(undefined,[]);
      } else throw new Error('The invoice credit was not issued. Check Runs before trying again.');
    } catch (error) { if (!disposed && current === generation) status.textContent = message(error); }
    finally { if (!disposed && current === generation) { busy = false;controls();opts.onStateChanged();if (applied) { reset();opts.onChanged(); } } }
  };
  editor.addEventListener('input',() => { if (busy || queued) return;dirty = true;prepared = null;requestKey = crypto.randomUUID();preview.replaceChildren();review.hidden = true;controls();opts.onStateChanged(); });
  editor.addEventListener('submit',event => {
    event.preventDefault();if (disposed || busy || queued || !frozen || !opts.canReview()) return;const target = frozen;const current = ++generation;busy = true;prepared = null;review.hidden = true;preview.replaceChildren();controls();opts.onStateChanged();status.textContent = 'Preparing invoice credit…';
    void (async () => { let replay = false;
      try { const result = await opts.conn('reception.signoff.invoice.credit.prepare',{ request_key:requestKey,signoff_id:target.signoff_id,expected_snapshot_hash:target.snapshot_hash!,amount:amount.value,issued_on:issued.value,reason:reason.value });
        if (disposed || current !== generation) return;
        if (result.credit.signoff_id !== target.signoff_id || result.credit.invoice_id !== target.invoice_id || result.review.credit_id !== result.credit.credit_id || !/^[a-f0-9]{64}$/.test(result.review.expected_plan_hash)) throw new Error('This credit does not match the selected invoice.');
        prepared = result;replay = result.credit.applied_at !== null;add('pre',result.review.summary,preview);review.hidden = replay;dirty = !replay;
        status.textContent = replay ? 'This credit was already issued. Refreshing balances.' : 'Credit preview ready. Review it to request approval; the bill has not changed.';void loadHistory(undefined,[]);
      } catch (error) { if (!disposed && current === generation) status.textContent = message(error); }
      finally { if (!disposed && current === generation) { busy = false;controls();opts.onStateChanged();if (replay) { reset();opts.onChanged(); } } }
    })();
  });
  corrections = mountCustomerCreditCorrections({ document: doc,host: root,conn: opts.conn,payment: opts.payment,
    canReview: () => editor.hidden && !busy && opts.canReview(),
    onStateChanged: () => { controls();opts.onStateChanged(); },
    onChanged: () => { generation++;copy = null;copyHost.hidden = true;clearPrint();void loadHistory(undefined,[]);opts.onChanged(); },
    returnFocus: id => {const card = [...historyHost.querySelectorAll<HTMLElement>('[data-credit-id]')].find(node => node.getAttribute('data-credit-id') === id);(card?.querySelector('button') ?? issue).focus(); },
  });
  controls();return {open,
    setInvoice(value: CustomerPaymentHistory) { if (!history || history.snapshot_hash !== value.snapshot_hash || history.signoff_id !== value.signoff_id) {
      // A copy can start from the old cards while a history refresh is pending.
      // Fence that response when its invoice or ledger changes; retain same-invoice edits.
      if (history && (editor.hidden || history.signoff_id !== value.signoff_id)) { busy = false;reset(false); }
      copy = null;copyHost.hidden = true;clearPrint();
      if (history?.signoff_id !== value.signoff_id) status.textContent = '';
    }
      if (history?.signoff_id !== value.signoff_id) { historyGeneration++;cursor = nextCursor = undefined;previous = [];historyHost.replaceChildren(); }history = value;corrections?.setInvoice(value);controls();void loadHistory(cursor,[...previous]); },
    focusAfterChange: () => { if (!disposed) { if (issue.disabled) opts.returnFocus();else issue.focus(); } },
    isOpen: () => !editor.hidden || corrections?.isOpen() === true,hasUnsavedChanges: () => dirty || corrections?.hasUnsavedChanges() === true,hasInFlightWork: () => busy || corrections?.hasInFlightWork() === true,
    reset: () => { if (!busy && !corrections?.hasInFlightWork()) { reset();corrections?.reset(false); } },
    dispose: () => { disposed = true;generation++;historyGeneration++;clearPrint();corrections?.dispose();root.remove(); },
  };
};
