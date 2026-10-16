import { customerInvoiceRecordAddress } from '../data/records-navigation.js';
import { paymentReceiptDocument,customerFinancialDocumentHtml,renderCustomerFinancialDocument,CUSTOMER_FINANCIAL_DOCUMENT_STYLES } from './customer-financial-document.js';
import { focusCustomerWorkspace } from './customer-workspace-focus.js';
import { mountCustomerRefunds } from './customer-refunds.js';
import { customerRefundBalanceLines } from '@recued/contracts';
import { mountCustomerInvoiceCredits } from './customer-invoice-credits.js';
import { mountCustomerPaymentCorrections } from './customer-payment-corrections.js';
import type { QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';
import { composeDialog,customerPaymentReceiptLines,type Conn,type ServerRpcRegistry,
  type CustomerPaymentHistory,type CustomerPaymentReceipt } from '@recued/contracts';
import { FORM_RENDERER_STYLES,MAIL_COMPOSE_STYLES } from '@recued/ui-shared';
import { mountMailCompose,type MailComposeDeps } from '../mail/mail-compose-host.js';
import { downloadReceiptHtml } from './quote-signoff-receipt.js';

export type CustomerInvoiceSection = 'payments' | 'credits' | 'refunds' | 'documents';
export type CustomerPaymentHistoryConn = Conn<Pick<ServerRpcRegistry,
  'reception.signoff.payment.history' | 'reception.signoff.payment.receipt' | 'reception.signoff.payment.receipt.draft' | 'reception.signoff.refund.correction.prepare' | 'reception.signoff.refund.correction.history' | 'reception.signoff.refund.prepare' | 'reception.signoff.refund.history' | 'reception.signoff.refund.copy' | 'reception.signoff.refund.receipt.draft' | 'reception.signoff.invoice.credit.correction.prepare' | 'reception.signoff.invoice.credit.correction.history' | 'reception.signoff.invoice.credit.prepare' | 'reception.signoff.invoice.credit.history' | 'reception.signoff.invoice.credit.copy' | 'reception.signoff.payment.correction.prepare' | 'reception.signoff.payment.correction.history'>>;
const escape = (value: string) => value.replace(/[&<>"']/g,char =>
  ({ '&': '&amp;','<': '&lt;','>': '&gt;','"': '&quot;',"'": '&#39;' })[char]!);
/** A static customer copy contains no private notes, active code or remote resources. */
export const customerPaymentReceiptHtml = (receipt: CustomerPaymentReceipt): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Customer payment receipt</title><style>
${CUSTOMER_FINANCIAL_DOCUMENT_STYLES}
body{font:16px/1.5 system-ui,sans-serif;color:#17212b;background:white;max-width:850px;margin:32px auto;padding:0 24px}
p{margin:8px 0;overflow-wrap:anywhere}h1{line-height:1.2}@media print{body{margin:0;padding:0}}
</style></head><body><h1>Customer payment receipt</h1>
${customerFinancialDocumentHtml(paymentReceiptDocument(receipt))}</body></html>`;

/** History is read from Invoice Book. Preparing an email saves a private draft;
 * the shared Mail composer owns the reviewed Send and ordinary approval flow. */
export const mountCustomerPaymentHistory = (opts: {
  host: HTMLElement;document: Document;conn: CustomerPaymentHistoryConn;
  mail?: MailComposeDeps;canReviewEmail?: () => boolean;payment?: QuoteSignoffPaymentOptions;onCorrected?: () => void;
}) => {
  const { document: doc,conn } = opts;
  const root = doc.createElement('section');root.hidden = true;root.tabIndex = -1;
  root.setAttribute('data-customer-payment-history','');root.setAttribute('aria-label','Customer payment history');opts.host.appendChild(root);
  const add = (tag: string,text: string,host: HTMLElement = root) => { const node = doc.createElement(tag);node.textContent = text;host.appendChild(node);return node; };
  const button = (text: string,host: HTMLElement,click: () => void) => {
    const node = doc.createElement('button');node.type = 'button';node.textContent = text;host.appendChild(node);node.addEventListener('click',click);return node;
  };
  add('style',`${CUSTOMER_FINANCIAL_DOCUMENT_STYLES}
[data-customer-payment-history]{display:grid;gap:12px;min-width:0}
    [data-customer-payment-history] [hidden]{display:none!important}
    [data-customer-payment-history] article,[data-payment-receipt-copy]{display:grid;gap:10px}
    [data-customer-payment-history] p{overflow-wrap:anywhere}
    [data-customer-payment-history] .payment-history-actions{display:flex;flex-wrap:wrap;gap:10px}
    [data-customer-payment-history] form,[data-customer-payment-history] label{display:grid;gap:8px}
    [data-customer-payment-history] input,[data-customer-payment-history] select{box-sizing:border-box;max-width:100%;min-width:0}
  `);
  const heading = add('h3','Customer payment history');
  const status = add('p','');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const actions = add('div','');actions.className = 'payment-history-actions';
  const refresh = button('Refresh payment history',actions,() => { void load(); });
  const close = button('Close payment history',actions,() => {
    if (busy || compose?.hasInFlightWork() || corrections?.hasInFlightWork() || credits?.hasInFlightWork() || refunds?.hasInFlightWork()) return;
    if(!discardReceiptFields() || !canReplace())return;
    corrections?.reset();credits?.reset();refunds?.reset();generation++;history = null;receipt = null;dirty = false;clearPrint();root.hidden = true;entries.replaceChildren();copy.replaceChildren();emailForm.hidden = true;returnFocus?.();
  });
  const sectionNav=add('nav','');sectionNav.className='payment-history-actions';sectionNav.setAttribute('aria-label','Invoice billing sections');
  const sectionButtons=new Map<CustomerInvoiceSection,HTMLButtonElement>();
  for(const [id,label] of [['payments','Payments'],['credits','Credits'],['refunds','Refunds'],['documents','Documents']] as const) {
    sectionButtons.set(id,button(label,sectionNav,()=>{if(!busy && canReplace()){paintSection(id);focusCustomerWorkspace(sectionHosts[id]);}}));
  }
  const balances=add('div','');balances.setAttribute('data-invoice-balances','');
  const sectionHosts = {payments:add('section',''),credits:add('section',''),refunds:add('section',''),documents:add('section','')};
  for(const [id,host] of Object.entries(sectionHosts))host.setAttribute('data-invoice-section',id);
  add('h4','Recorded payments',sectionHosts.payments);add('h4','Invoice documents',sectionHosts.documents);
  const documents=add('div','',sectionHosts.documents);
  let activeSection: CustomerInvoiceSection='payments';
  const paintSection=(section: CustomerInvoiceSection)=>{activeSection=section;for(const [id,host] of Object.entries(sectionHosts))host.hidden=id!==section;for(const [id,node] of sectionButtons)node.setAttribute('aria-pressed',String(id===section));};
  const entries = add('div','',sectionHosts.payments);entries.setAttribute('data-payment-history-entries','');
  const paging = add('div','',sectionHosts.payments);paging.className = 'payment-history-actions';
  const newer = button('Newer payments',paging,() => { if (previous.length) void load(previous.at(-1),previous.slice(0,-1)); });
  const older = button('Older payments',paging,() => { if (history?.next_cursor) void load(history.next_cursor,[...previous,cursor]); });
  const receiptRegion = add('section','',sectionHosts.documents);receiptRegion.hidden = true;receiptRegion.setAttribute('data-payment-receipt','');
  add('h3','Customer payment receipt',receiptRegion);
  const copy = add('div','',receiptRegion);copy.setAttribute('data-payment-receipt-copy','');
  const receiptActions = add('div','',receiptRegion);receiptActions.className = 'payment-history-actions';
  let receiptSource: HTMLButtonElement | undefined;
  const backToHistory = button('Back to payment history',receiptActions,()=>{
    if(busy || !discardReceiptFields() || !canReplace())return;receipt=null;receiptRegion.hidden=true;copy.replaceChildren();emailForm.hidden=true;clearPrint();
    paintSection('payments');(receiptSource?.isConnected ? receiptSource : refresh).focus();
  });
  const print = button('Print payment receipt / save PDF',receiptActions,() => {
    if (!receipt || disposed || printFrame) return;
    const frame = doc.createElement('iframe');printFrame = frame;controls();
    frame.setAttribute('data-payment-receipt-print','');frame.title = 'Payment receipt print view';
    frame.setAttribute('aria-hidden','true');frame.tabIndex = -1;frame.setAttribute('sandbox','allow-same-origin allow-modals');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;bottom:0;left:0;';
    frame.addEventListener('load',() => {
      if (disposed || printFrame !== frame) return;const view = frame.contentWindow;
      if (!view) { clearPrint();controls();status.textContent = 'Printing is unavailable in this browser.';return; }
      if (printTimer !== undefined) clearTimeout(printTimer);printTimer = undefined;
      view.addEventListener('afterprint',() => { if (printFrame === frame) { clearPrint();controls(); } },{ once: true });
      try { view.focus();view.print(); }
      catch { clearPrint();controls();status.textContent = 'Download the receipt and print it from your browser.'; }
    });
    printTimer = setTimeout(() => { if (printFrame === frame) { clearPrint();controls();status.textContent = 'The print view could not load. Try again.'; } },10_000);
    frame.srcdoc = customerPaymentReceiptHtml(receipt);root.appendChild(frame);
  });
  const download = button('Download payment receipt',receiptActions,() => {
    if (!receipt || disposed) return;
    try { downloadReceiptHtml(doc,root,`payment-${receipt.receipt_hash.slice(0,16)}.html`,customerPaymentReceiptHtml(receipt)); }
    catch (error) { status.textContent = message(error); }
  });
  const emailForm = doc.createElement('form');emailForm.hidden = true;emailForm.setAttribute('aria-label','Prepare payment receipt email');receiptRegion.appendChild(emailForm);
  const emailLabel = add('label','Customer email',emailForm);const email = doc.createElement('input');email.type = 'email';email.required = true;email.maxLength = 254;email.name = 'payment_receipt_recipient';emailLabel.appendChild(email);
  const accountLabel = add('label','Mail account',emailForm);const account = doc.createElement('select');account.required = true;
  account.id = 'recued-payment-receipt-account';account.name = 'payment_receipt_account';accountLabel.setAttribute('for',account.id);emailForm.appendChild(account);
  const review = doc.createElement('button');review.type = 'submit';review.textContent = 'Review payment receipt email';emailForm.appendChild(review);
  const mailStatus = add('p','',receiptRegion);
  const composeHost = add('div','');
  let compose: ReturnType<typeof mountMailCompose> | null = null;
  let refunds: ReturnType<typeof mountCustomerRefunds> | null = null;
  if (opts.mail) { add('style',`${FORM_RENDERER_STYLES}\n${MAIL_COMPOSE_STYLES}`,composeHost);compose = mountMailCompose(composeHost,opts.mail); }
  let disposed = false;let busy = false;let dirty = false;let generation = 0;let selected = '';
  let history: CustomerPaymentHistory | null = null;let receipt: CustomerPaymentReceipt | null = null;
  let lastCorrectedPayment = '';
  let cursor: string | undefined;let previous: Array<string | undefined> = [];let returnFocus: (() => void) | undefined;
  let rowButtons: HTMLButtonElement[] = [];
  let printFrame: HTMLIFrameElement | null = null;let printTimer: ReturnType<typeof setTimeout> | undefined;
  const clearPrint = () => { if (printTimer !== undefined) clearTimeout(printTimer);printTimer = undefined;printFrame?.remove();printFrame = null; };
  const message = (error: unknown) => error instanceof Error ? error.message : 'Could not load the payment receipt. Try again.';
  const hasOpenEmail = () => Boolean(compose && composeDialog(compose.state()));
  const discardReceiptFields=()=>{
    if(!dirty)return true;
    if(doc.defaultView?.confirm('Discard the unsaved payment receipt email details?')!==true)return false;
    dirty=false;email.value='';account.value='';return true;
  };
  const canReplace = () => {
    if (refunds?.isOpen()) { status.textContent = 'Finish or close the refund entry, correction or receipt email before refreshing payment history.';return false; }
    if (credits?.isOpen()) { status.textContent = 'Finish or close the invoice credit before refreshing history or opening another payment.';return false; }
    if (corrections?.isOpen()) { status.textContent = 'Finish or close the payment correction before refreshing history or opening another payment.';return false; }
    if (dirty || hasOpenEmail() || compose?.hasInFlightWork()) { status.textContent = 'Review or close this receipt email before opening another payment or refreshing history.';return false; }
    return true;
  };
  const controls = () => {
    const correcting = corrections?.hasInFlightWork() === true || credits?.hasInFlightWork() === true || refunds?.hasInFlightWork() === true;
    refresh.disabled = busy || correcting;close.disabled = busy || correcting || compose?.hasInFlightWork() === true;
    newer.disabled = busy || previous.length === 0;older.disabled = busy || !history?.next_cursor;
    print.disabled = !receipt || printFrame !== null;download.disabled = !receipt;
    email.disabled = busy;account.disabled = busy;review.disabled = busy || !receipt;
    sectionButtons.forEach(node=>{node.disabled=busy;});
    paging.hidden = previous.length===0 && !history?.next_cursor;
    rowButtons.forEach(node => { node.disabled = busy || refunds?.isOpen() === true || history?.consistency !== 'matched' || !history.snapshot_hash; });
  };
  const loadMailAccounts = async (current: number) => {
    if (!opts.mail?.drafts) return;
    mailStatus.textContent = 'Loading mail accounts. Print and download are ready.';
    try {
      const mail = await opts.mail.listMailInstances();
      if (disposed || current !== generation) return;
      const empty = doc.createElement('option');empty.value = '';empty.textContent = 'Choose a mail account';account.appendChild(empty);
      for (const row of mail.instances.filter(item => item.send_capable)) {
        const option = doc.createElement('option');option.value = row.slug;option.textContent = row.account_email || row.slug;account.appendChild(option);
      }
      emailForm.hidden = account.options.length < 2;mailStatus.textContent = emailForm.hidden
        ? 'Connect a mail account that can send to review a receipt email.' : 'This saves a private draft. Review the email and choose Send.';
    } catch { if (!disposed && current === generation) mailStatus.textContent = 'Mail accounts could not be loaded. You can still print or download this receipt.'; }
  };
  const viewReceipt = async (payment_id: string,source?: HTMLButtonElement) => {
    if (disposed || busy || !history?.snapshot_hash || !canReplace()) return;
    receiptSource=source;const expected = history;const current = ++generation;busy = true;receipt = null;clearPrint();controls();
    paintSection('documents');receiptRegion.hidden = false;copy.replaceChildren();emailForm.hidden = true;status.textContent = 'Loading payment receipt…';
    try {
      const result = await conn('reception.signoff.payment.receipt',{ signoff_id: selected,payment_id,expected_snapshot_hash: expected.snapshot_hash! });
      if (disposed || current !== generation) return;
      if (result.format !== 'recued.customer-payment-receipt' || ![1,2].includes(result.version)
        || result.signoff_id !== selected || result.payment.payment_id !== payment_id || result.invoice_id !== expected.invoice_id
        || !/^[a-f0-9]{64}$/.test(result.receipt_hash)) throw new Error('This payment receipt does not match the selected invoice.');
      customerPaymentReceiptHtml(result);receipt = result;
      renderCustomerFinancialDocument(doc,copy,paymentReceiptDocument(result));
      status.textContent = 'Payment receipt ready. The balance is a snapshot of the business’s records.';
      dirty = false;email.value = '';account.replaceChildren();
      mailStatus.textContent = 'Connect Mail to review a receipt email.';
      void loadMailAccounts(current);
    } catch (error) { if (!disposed && current === generation) { receipt = null;status.textContent = message(error); } }
    finally { if (!disposed && current === generation) { busy = false;controls();if(receipt)focusCustomerWorkspace(receiptRegion); } }
  };
  const load = async (requestedCursor?: string,requestedPrevious: Array<string | undefined> = []) => {
    if (disposed || busy || !selected || !canReplace()) return;
    const current = ++generation;busy = true;controls();status.textContent = 'Loading payment history…';
    try {
      const result = await conn('reception.signoff.payment.history',{ signoff_id: selected,limit: 50,...(requestedCursor ? { cursor: requestedCursor } : {}) });
      if (disposed || current !== generation) return;
      if (result.signoff_id !== selected) throw new Error('This payment history does not match the selected invoice.');
      corrections?.setInvoice(result.signoff_id);credits?.setInvoice(result);refunds?.setInvoice(result);
      history = result;cursor = requestedCursor;previous = [...requestedPrevious];receipt = null;clearPrint();receiptRegion.hidden = true;emailForm.hidden = true;
      heading.textContent = `Invoice billing — ${result.invoice_ref} — ${result.customer}`;
      entries.replaceChildren();documents.replaceChildren();balances.replaceChildren();rowButtons = [];
      if (result.invoice.availability === 'current' && result.invoice.amount_credited) add('p',`Recorded credits: ${result.invoice.amount_credited} ${result.currency}`,balances);
      if (result.invoice.availability === 'current') add('p',`Recorded paid: ${result.invoice.amount_paid} ${result.currency} · outstanding: ${result.invoice.outstanding} ${result.currency}.`,balances);
      if (result.invoice.availability === 'current') customerRefundBalanceLines(result.invoice,result.currency).forEach(line=>add('p',line,balances));
      for (const payment of result.payments) {
        const article = add('article','',entries);article.setAttribute('data-payment-id',payment.payment_id);
        add('h4',`${payment.amount} ${result.currency} · ${payment.received_on}`,article);
        if (payment.method) add('p',`Method: ${payment.method}`,article);
        if (payment.reference) add('p',`Payment reference: ${payment.reference}`,article);
        const receiptButton = button('View payment receipt',article,() => {void viewReceipt(payment.payment_id,receiptButton);});rowButtons.push(receiptButton);
        const documentButton=button(`Payment receipt — ${payment.amount} ${result.currency} · ${payment.received_on}`,documents,()=>{void viewReceipt(payment.payment_id,receiptButton);});rowButtons.push(documentButton);
        if (corrections && !result.paid_credits?.some(c=>c.payment_id===payment.payment_id)) rowButtons.push(button('Correct recorded payment',article,() => {
          if (disposed || busy || !history?.snapshot_hash || !canReplace()) return;
          generation++;receipt = null;clearPrint();copy.replaceChildren();receiptRegion.hidden = true;emailForm.hidden = true;
          lastCorrectedPayment = payment.payment_id;corrections.open(history,payment);
        }));
      }
      if (!result.payments.length) add('p',result.consistency === 'unavailable' ? 'Payment entries could not be loaded.' : 'No recorded payments on this page.',entries);
      if (!result.payments.length)add('p','No payment receipts on this history page.',documents);
      button('Find credit documents',documents,()=>{if(canReplace()){paintSection('credits');focusCustomerWorkspace(sectionHosts.credits);}});
      button('Find refund receipts',documents,()=>{if(canReplace()){paintSection('refunds');refunds?.showHistory();}});
      const records = add('a','Review invoice record',documents);records.setAttribute('href',customerInvoiceRecordAddress(result.invoice_id));
      status.textContent = result.issue ?? `Payment page ${previous.length + 1} · ${result.payments.length} recorded payment${result.payments.length === 1 ? '' : 's'}.`;
    } catch (error) { if (!disposed && current === generation) status.textContent = message(error) + (history ? ' Previously loaded entries remain visible. Refresh history to retry.' : ''); }
    finally { if (!disposed && current === generation) { busy = false;controls(); } }
  };
  emailForm.addEventListener('input',() => { dirty = true; });emailForm.addEventListener('change',() => { dirty = true; });
  emailForm.addEventListener('submit',event => {
    event.preventDefault();
    if (busy || disposed || !receipt || !compose || !opts.mail?.drafts) return;
    if (refunds?.isOpen() || corrections?.isOpen() || credits?.isOpen() || hasOpenEmail() || compose.hasUnsavedChanges() || opts.canReviewEmail?.() === false) { status.textContent = 'Close the email you have open before reviewing a payment receipt.';return; }
    const savedReceipt = receipt;const current = ++generation;busy = true;controls();
    void (async () => {
      try {
        const prepared = await conn('reception.signoff.payment.receipt.draft',{ signoff_id: savedReceipt.signoff_id,payment_id: savedReceipt.payment.payment_id,
          expected_receipt_hash: savedReceipt.receipt_hash,sender_mail_instance: account.value,recipient_email: email.value.trim() });
        if (disposed || current !== generation) return;
        const saved = await opts.mail!.drafts!.create(prepared);
        if (disposed || current !== generation) return;
        dirty = false;await compose!.refresh();
        if (disposed || current !== generation) return;
        if (!await compose!.openSaved(saved.draft_id)) throw new Error('The receipt draft is saved in Mail. Close your current email before opening it.');
        status.textContent = 'Receipt draft saved. Review it and choose Send; Recued uses your normal mail approval controls.';
      } catch (error) { if (!disposed && current === generation) status.textContent = message(error); }
      finally { if (!disposed && current === generation) { busy = false;controls(); } }
    })();
  });
  const open = async (id: string,onClosed?: () => void,section: CustomerInvoiceSection='payments',issueCredit=false) => {
    if (disposed || busy || !canReplace()) return;
    selected = id;returnFocus = onClosed;entries.replaceChildren();receiptRegion.hidden = true;heading.textContent = 'Customer payment history';history = null;receipt = null;cursor = undefined;previous = [];root.hidden = false;paintSection(section);await load();if (!disposed) {focusCustomerWorkspace(root);if(section==='refunds')refunds?.showHistory();if(issueCredit)credits?.open();}
  };
  const corrections = opts.payment ? mountCustomerPaymentCorrections({ document: doc,host: sectionHosts.payments,conn,payment: opts.payment,
    canReview: (): boolean => !refunds?.isOpen() && !credits?.isOpen() && !dirty && !hasOpenEmail() && !compose?.hasInFlightWork() && opts.canReviewEmail?.() !== false,
    onChanged: () => { receipt = null;clearPrint();copy.replaceChildren();receiptRegion.hidden = true;emailForm.hidden = true;void load().then(() => { if (!disposed && !root.hidden) { const card = [...entries.querySelectorAll<HTMLElement>('[data-payment-id]')].find(node => node.getAttribute('data-payment-id') === lastCorrectedPayment);
      const action = card ? [...card.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Correct recorded payment') : undefined;(action ?? refresh).focus(); } });opts.onCorrected?.(); },
    onStateChanged: controls,returnFocus: id => { const card = [...entries.querySelectorAll<HTMLElement>('[data-payment-id]')].find(node => node.getAttribute('data-payment-id') === id);
      const action = card ? [...card.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Correct recorded payment') : undefined;
      (action ?? refresh).focus(); } }) : null;
  const credits = opts.payment ? mountCustomerInvoiceCredits({ document: doc,host: sectionHosts.credits,conn,payment: opts.payment,
    canReview: (): boolean => !refunds?.isOpen() && !corrections?.isOpen() && !dirty && !hasOpenEmail() && !compose?.hasInFlightWork() && opts.canReviewEmail?.() !== false,
    onChanged: (): void => { receipt = null;clearPrint();copy.replaceChildren();receiptRegion.hidden = true;emailForm.hidden = true;void load().then(() => { if (!disposed && !root.hidden) credits?.focusAfterChange(); });opts.onCorrected?.(); },
    returnFocus: () => { refresh.focus(); },
    onStateChanged: controls }) : null;
  refunds = opts.payment ? mountCustomerRefunds({ document: doc,host: sectionHosts.refunds,conn,payment: opts.payment,...(opts.mail ? { mail: opts.mail } : {}),
    canReview: (): boolean => !credits?.isOpen() && !corrections?.isOpen() && !dirty && !hasOpenEmail() && !compose?.hasInFlightWork() && opts.canReviewEmail?.() !== false,
    onStateChanged: controls,returnFocus: () => { if (!disposed) refresh.focus(); },
    onChanged: () => { receipt=null;clearPrint();copy.replaceChildren();receiptRegion.hidden=true;emailForm.hidden=true;void load().then(()=>{ if (!disposed && !root.hidden) refresh.focus(); });opts.onCorrected?.(); } }) : null;
  paintSection(activeSection);controls();
  return { open,openSection:(id: string,section: CustomerInvoiceSection,onClosed?:()=>void)=>open(id,onClosed,section,section==='credits'),isOpen:()=>!root.hidden,hasOpenEmail: () => refunds?.isOpen() === true || hasOpenEmail() || corrections?.isOpen() === true || credits?.isOpen() === true,hasUnsavedChanges: () => refunds?.hasUnsavedChanges() === true || dirty || corrections?.hasUnsavedChanges() === true || credits?.hasUnsavedChanges() === true || compose?.hasUnsavedChanges() === true,
    hasInFlightWork: () => refunds?.hasInFlightWork() === true || busy || corrections?.hasInFlightWork() === true || credits?.hasInFlightWork() === true || compose?.hasInFlightWork() === true,
    dispose: () => { disposed = true;generation++;clearPrint();refunds?.dispose();credits?.dispose();corrections?.dispose();compose?.destroy();root.remove(); } };
};
