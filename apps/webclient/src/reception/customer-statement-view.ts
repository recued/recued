import { focusCustomerWorkspace } from './customer-workspace-focus.js';
import { renderCustomerFinancialDocument,customerFinancialDocumentHtml,CUSTOMER_FINANCIAL_DOCUMENT_STYLES,type CustomerFinancialDocument } from './customer-financial-document.js';
import { composeDialog,type CustomerJobPaymentStatementDraftResult,type CustomerAccountContactDefaultsRecord } from '@recued/contracts';
import { FORM_RENDERER_STYLES,MAIL_COMPOSE_STYLES } from '@recued/ui-shared';
import { mountMailCompose,type MailComposeDeps } from '../mail/mail-compose-host.js';
import { downloadReceiptHtml } from './quote-signoff-receipt.js';

const escape = (value: string) => value.replace(/[&<>"']/g,char =>
  ({ '&': '&amp;','<': '&lt;','>': '&gt;','"': '&quot;',"'": '&#39;' })[char]!);
export const customerStatementHtml = (title: string,lines: string[],model?: CustomerFinancialDocument): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escape(title)}</title><style>
${CUSTOMER_FINANCIAL_DOCUMENT_STYLES}
body{font:16px/1.5 system-ui,sans-serif;color:#17212b;background:white;max-width:850px;margin:32px auto;padding:0 24px}
p{margin:8px 0;overflow-wrap:anywhere}h1{line-height:1.2}@media print{body{margin:0;padding:0}}
</style></head><body><h1>${escape(title)}</h1>
${model ? customerFinancialDocumentHtml(model) : lines.map(line => `<p>${escape(line)}</p>`).join('\n')}</body></html>`;

/** The editor lives outside the polled job cards. Mail is optional for exports. */
export const mountCustomerStatementView = <T extends { statement_hash: string }>(opts: {
  host: HTMLElement;document: Document;kind: 'job-payment' | 'account' | 'account-payment';
  mail?: MailComposeDeps;canReviewEmail?: () => boolean;onStateChanged?: () => void;
  contactDefaults?: (statement: T) => Promise<CustomerAccountContactDefaultsRecord>;
  read(id: string): Promise<T>;prepare(statement: T,sender: string,recipient: string): Promise<CustomerJobPaymentStatementDraftResult>;
  documentModel?: (statement: T) => CustomerFinancialDocument;
  validate(statement: T,id: string): boolean;lines(statement: T): string[];heading(statement: T): string;
}) => {
  const { document: doc } = opts;
  const label = opts.kind === 'job-payment' ? 'job payment statement' : opts.kind === 'account-payment' ? 'account payment receipt' : 'account statement';
  const title = `Customer ${label}`;
  const attribute = `data-customer-${opts.kind}-statement`;
  const copyAttribute = `data-${opts.kind}-statement-copy`;
  const printAttribute = `data-${opts.kind}-statement-print`;
  const html = (statement: T) => customerStatementHtml(title,opts.lines(statement),opts.documentModel?.(statement));
  const root = doc.createElement('section');root.hidden = true;root.tabIndex = -1;
  root.setAttribute(attribute,'');root.setAttribute('aria-label',title);opts.host.appendChild(root);
  const add = (tag: string,text: string,host: HTMLElement = root) => { const node = doc.createElement(tag);node.textContent = text;host.appendChild(node);return node; };
  const button = (text: string,host: HTMLElement,click: () => void) => {
    const node = doc.createElement('button');node.type = 'button';node.textContent = text;host.appendChild(node);node.addEventListener('click',click);return node;
  };
  add('style',`${CUSTOMER_FINANCIAL_DOCUMENT_STYLES}
[${attribute}]{display:grid;gap:12px;min-width:0}
    [${attribute}] [hidden]{display:none!important}
    [${copyAttribute}]{display:grid;gap:6px}
    [${attribute}] p{overflow-wrap:anywhere}
    [${attribute}] .statement-actions{display:flex;flex-wrap:wrap;gap:10px}
    [${attribute}] form,[${attribute}] label{display:grid;gap:8px}
    [${attribute}] input,[${attribute}] select{box-sizing:border-box;max-width:100%;min-width:0}
  `);
  const heading = add('h3',title);
  const status = add('p','');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const actions = add('div','');actions.className = 'statement-actions';
  const refresh = button(`Refresh ${label}`,actions,() => { void load(); });
  const close = button(`Close ${label}`,actions,() => {
    if (busy || compose?.hasInFlightWork()) return;
    if (hasOpenEmail()) { status.textContent = 'Close the statement email before closing this payment statement.';return; }
    generation++;statement = null;dirty = false;clearPrint();root.hidden = true;copy.replaceChildren();emailForm.hidden = true;returnFocus?.();
  });
  const copy = add('div','');copy.setAttribute(copyAttribute,'');
  const print = button(`Print ${label} / save PDF`,actions,() => {
    if (!statement || disposed || printFrame) return;
    const frame = doc.createElement('iframe');printFrame = frame;controls();
    frame.setAttribute(printAttribute,'');frame.title = `${label[0]!.toUpperCase()+label.slice(1)} print view`;
    frame.setAttribute('aria-hidden','true');frame.tabIndex = -1;frame.setAttribute('sandbox','allow-same-origin allow-modals');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;bottom:0;left:0;';
    frame.addEventListener('load',() => {
      if (disposed || printFrame !== frame) return;const view = frame.contentWindow;
      if (!view) { clearPrint();controls();status.textContent = 'Printing is unavailable in this browser.';return; }
      if (printTimer !== undefined) clearTimeout(printTimer);printTimer = undefined;
      view.addEventListener('afterprint',() => { if (printFrame === frame) { clearPrint();controls(); } },{ once: true });
      try { view.focus();view.print(); }
      catch { clearPrint();controls();status.textContent = 'Download the statement and print it from your browser.'; }
    });
    printTimer = setTimeout(() => { if (printFrame === frame) { clearPrint();controls();status.textContent = 'The print view could not load. Try again.'; } },10_000);
    frame.srcdoc = html(statement);root.appendChild(frame);
  });
  const download = button(`Download ${label}`,actions,() => {
    if (!statement || disposed) return;
    try { downloadReceiptHtml(doc,root,`${opts.kind === 'job-payment' ? 'job-statement' : opts.kind === 'account-payment' ? 'account-payment-receipt' : 'account-statement'}-${statement.statement_hash.slice(0,16)}.html`,html(statement)); }
    catch (error) { status.textContent = message(error); }
  });
  const emailForm = doc.createElement('form');emailForm.hidden = true;emailForm.setAttribute('aria-label',`Prepare ${label} email`);root.appendChild(emailForm);
  const emailLabel = add('label','Customer email',emailForm);const email = doc.createElement('input');email.type = 'email';email.required = true;email.maxLength = 254;email.name = `${opts.kind}_statement_recipient`;emailLabel.appendChild(email);
  const accountLabel = add('label','Mail account',emailForm);const account = doc.createElement('select');account.required = true;
  account.id = `recued-${opts.kind}-statement-account`;account.name = `${opts.kind}_statement_account`;accountLabel.setAttribute('for',account.id);emailForm.appendChild(account);
  const review = doc.createElement('button');review.type = 'submit';review.textContent = `Review ${label} email`;emailForm.appendChild(review);
  const mailStatus = add('p','');
  const contactStatus = add('p','');contactStatus.hidden = !opts.contactDefaults;contactStatus.setAttribute('data-account-contact-default-status','');
  const composeHost = add('div','');
  let compose: ReturnType<typeof mountMailCompose> | null = null;
  let disposed = false;let busy = false;let dirty = false;let generation = 0;let selected = '';
  let statement: T | null = null;let returnFocus: (() => void) | undefined;
  let defaults: CustomerAccountContactDefaultsRecord | null = null;let mailReady = false;let recipientEdited = false;let senderEdited = false;
  let printFrame: HTMLIFrameElement | null = null;let printTimer: ReturnType<typeof setTimeout> | undefined;
  const clearPrint = () => { if (printTimer !== undefined) clearTimeout(printTimer);printTimer = undefined;printFrame?.remove();printFrame = null; };
  const message = (error: unknown) => error instanceof Error ? error.message : `Could not load the ${label}. Try again.`;
  const hasOpenEmail = () => Boolean(compose && composeDialog(compose.state()));
  const canReplace = () => {
    if (dirty || hasOpenEmail() || compose?.hasInFlightWork()) { status.textContent = 'Review or close this statement email before opening another job or account, or refreshing the statement.';return false; }
    return true;
  };
  const controls = () => {
    refresh.disabled = busy;close.disabled = busy || compose?.hasInFlightWork() === true;
    print.disabled = !statement || printFrame !== null;download.disabled = !statement;
    email.disabled = busy;account.disabled = busy;review.disabled = busy || !statement || hasOpenEmail();
    opts.onStateChanged?.();
  };
  const applyDefaults = () => {
    if (!defaults) return;
    if (!recipientEdited) email.value = defaults.contact.recipient_email ?? '';
    const sender = defaults.contact.sender_mail_instance;
    const available = !sender || [...account.options].some(option => option.value === sender);
    if (mailReady && !senderEdited) account.value = available ? sender ?? '' : '';
    contactStatus.textContent = !Object.keys(defaults.contact).length ? 'No saved contact defaults. Choose the details for this email.'
      : (defaults.contact.contact_name ? 'Saved contact: '+defaults.contact.contact_name+'. ' : 'Saved account contact defaults loaded. ')
        +'Check the recipient and Mail account before reviewing the email.';
    if (mailReady && !available) contactStatus.textContent += ' The saved Mail account is unavailable. Choose a Mail account for this email.';
  };
  const loadDefaults = async (current: number,copy: T) => {
    if (!opts.contactDefaults) return;
    contactStatus.textContent = 'Loading saved account contact defaults…';
    try {
      const result = await opts.contactDefaults(copy);
      if (disposed || current !== generation) return;defaults = result;applyDefaults();
    } catch { if (!disposed && current === generation) contactStatus.textContent = 'Saved contact defaults could not be loaded. Choose the email details yourself.'; }
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
      mailReady = true;applyDefaults();
      emailForm.hidden = account.options.length < 2;mailStatus.textContent = emailForm.hidden
        ? 'Connect a mail account that can send to review a statement email.' : 'This saves a private draft. Review the email and choose Send.';
    } catch { if (!disposed && current === generation) mailStatus.textContent = 'Mail accounts could not be loaded. You can still print or download this statement.'; }
  };
  const load = async () => {
    if (disposed || busy || !selected || !canReplace()) return;
    const current = ++generation;busy = true;statement = null;clearPrint();copy.replaceChildren();emailForm.hidden = true;mailStatus.textContent = '';
    recipientEdited = senderEdited = false;defaults = null;mailReady = false;email.value = '';account.replaceChildren();contactStatus.textContent = '';
    controls();status.textContent = `Loading ${label}…`;
    try {
      const result = await opts.read(selected);
      if (disposed || current !== generation) return;
      if (!opts.validate(result,selected) || !/^[a-f0-9]{64}$/.test(result.statement_hash)) {
        throw new Error('This statement does not match the selected job or account.');
      }
      html(result);statement = result;
      heading.textContent = opts.heading(result);
      if (opts.documentModel) renderCustomerFinancialDocument(doc,copy,opts.documentModel(result));else opts.lines(result).forEach(line => add('p',line,copy));
      status.textContent = opts.kind === 'account-payment' ? 'Account payment receipt ready. Original allocations and current payment entries are included.'
        : `${label[0]!.toUpperCase()+label.slice(1)} ready. All linked released invoices are included; balances reflect the business’s records at capture.`;
      dirty = false;mailStatus.textContent = 'Connect Mail to review a statement email.';
      if (opts.mail?.drafts) void loadDefaults(current,result);
      void loadMailAccounts(current);
    } catch (error) { if (!disposed && current === generation) { statement = null;status.textContent = message(error); } }
    finally { if (!disposed && current === generation) { busy = false;controls(); } }
  };
  emailForm.addEventListener('input',() => { dirty = true;controls(); });emailForm.addEventListener('change',() => { dirty = true;controls(); });
  email.addEventListener('input',() => { recipientEdited = true; });email.addEventListener('change',() => { recipientEdited = true; });
  account.addEventListener('input',() => { senderEdited = true; });account.addEventListener('change',() => { senderEdited = true; });
  emailForm.addEventListener('submit',event => {
    event.preventDefault();
    if (busy || disposed || !statement || !compose || !opts.mail?.drafts) return;
    if (hasOpenEmail() || compose.hasUnsavedChanges() || opts.canReviewEmail?.() === false) { status.textContent = `Close the email you have open before reviewing an account or job statement.`;return; }
    const savedStatement = statement;const current = ++generation;busy = true;controls();
    void (async () => {
      try {
        const prepared = await opts.prepare(savedStatement,account.value,email.value.trim());
        if (disposed || current !== generation) return;
        const saved = await opts.mail!.drafts!.create(prepared);
        if (disposed || current !== generation) return;
        dirty = false;await compose!.refresh();
        if (disposed || current !== generation) return;
        if (!await compose!.openSaved(saved.draft_id)) throw new Error('The statement draft is saved in Mail. Close your current email before opening it.');
        status.textContent = 'Statement draft saved. Review it and choose Send; Recued uses your normal mail approval controls.';
      } catch (error) { if (!disposed && current === generation) status.textContent = message(error); }
      finally { if (!disposed && current === generation) { busy = false;controls(); } }
    })();
  });
  const open = async (id: string,onClosed?: () => void) => {
    if (disposed || busy || !canReplace()) return;
    selected = id;returnFocus = onClosed;heading.textContent = title;root.hidden = false;await load();if (!disposed) focusCustomerWorkspace(root);
  };
  if (opts.mail) {
    add('style',`${FORM_RENDERER_STYLES}\n${MAIL_COMPOSE_STYLES}`,composeHost);
    const mail = opts.mail;
    compose = mountMailCompose(composeHost,{ ...mail,onStateChanged: () => { mail.onStateChanged?.();if (!disposed) controls(); } });
  }
  controls();
  return { open,hasOpenEmail,
    reset: () => {
      if (disposed || busy || !canReplace()) return false;
      generation++;statement = null;dirty = false;clearPrint();root.hidden = true;copy.replaceChildren();emailForm.hidden = true;controls();return true;
    },
    hasUnsavedChanges: () => dirty || compose?.hasUnsavedChanges() === true,
    hasInFlightWork: () => busy || compose?.hasInFlightWork() === true,
    dispose: () => { disposed = true;generation++;clearPrint();compose?.destroy();root.remove(); } };
};
