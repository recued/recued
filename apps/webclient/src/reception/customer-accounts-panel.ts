import { accountStatementDocument } from './customer-financial-document.js';
import { focusCustomerWorkspace } from './customer-workspace-focus.js';
import { mountCustomerAccountContactDefaults,readCustomerAccountContactDefaults,type CustomerAccountContactDefaultsConn } from './customer-account-contact-defaults.js';
import { mountCustomerAccountPaymentReminders,type CustomerAccountPaymentReminderConn } from './customer-account-payment-reminders.js';
import { customerAccountStatementLines,CUSTOMER_ACCOUNT_MAX_JOBS,type Conn,type ServerRpcRegistry,type CustomerAccount,
  type CustomerAccountStatement,type CustomerJob } from '@recued/contracts';
import type { MailComposeDeps } from '../mail/mail-compose-host.js';
import { mountCustomerAccountPayments,type CustomerAccountPaymentsConn } from './customer-account-payments.js';
import type { QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';
import { customerStatementHtml,mountCustomerStatementView } from './customer-statement-view.js';

export type CustomerAccountsConn = CustomerAccountContactDefaultsConn & CustomerAccountPaymentReminderConn & CustomerAccountPaymentsConn & Conn<Pick<ServerRpcRegistry,'reception.accounts.list' | 'reception.accounts.get' |
  'reception.accounts.save' | 'reception.accounts.statement' | 'reception.accounts.statement.draft' | 'reception.jobs.list'>>;
export const customerAccountStatementHtml = (statement: CustomerAccountStatement) =>
  customerStatementHtml('Customer account statement',customerAccountStatementLines(statement),accountStatementDocument(statement));

/** Account edits and statement drafts live outside the polled job cards. */
export const mountCustomerAccountsPanel = (opts: {
  host: HTMLElement;document: Document;conn: CustomerAccountsConn;mail?: MailComposeDeps;payment?: QuoteSignoffPaymentOptions;onChanged?: () => void;
  canReviewEmail?: () => boolean;onStateChanged?: () => void;now?: () => number;
}) => {
  const { document: doc,conn } = opts;
  const add = <K extends keyof HTMLElementTagNameMap>(tag: K,text: string,host: HTMLElement) => {
    const node = doc.createElement(tag);node.textContent = text;host.appendChild(node);return node;
  };
  const button = (text: string,host: HTMLElement,click: () => void) => {
    const node = add('button',text,host);node.type = 'button';node.addEventListener('click',click);return node;
  };
  const root = add('section','',opts.host);root.hidden = true;root.tabIndex = -1;root.setAttribute('data-customer-accounts','');root.setAttribute('aria-label','Customer accounts');
  add('style',`[data-customer-accounts]{display:grid;gap:12px;min-width:0}[data-customer-accounts] [hidden]{display:none!important}
    [data-customer-accounts] form,[data-customer-accounts] fieldset{display:grid;gap:10px;min-width:0}
    [data-customer-accounts] p,[data-customer-accounts] label{overflow-wrap:anywhere}
    [data-customer-accounts] input:not([type=checkbox]){box-sizing:border-box;width:100%;min-width:0}
    [data-account-job-choices]>label,[data-customer-accounts] .account-confirmation{display:flex;align-items:flex-start;gap:10px}
    [data-customer-accounts] input[type=checkbox]{width:auto;flex-shrink:0;margin:3px 0}
    [data-account-actions]{display:flex;flex-wrap:wrap;gap:10px}
    [data-customer-accounts] article{border:1px solid var(--border-subtle,#ddd);border-radius:8px;padding:12px}
  `,root);
  add('h3','Customer accounts',root);
  add('p','Create an account and choose its jobs explicitly. Matching names do not link jobs. A job can belong to one account.',root);
  const status = add('p','',root);status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const toolbar = add('div','',root);toolbar.setAttribute('data-account-actions','');
  const fresh = button('New customer account',toolbar,() => { if (!canReplace()) return;void edit({ account_id: crypto.randomUUID(),revision: 0,customer: '',job_ids: [],created_at: 0,updated_at: 0 }); });
  const refresh = button('Refresh customer accounts',toolbar,() => { if (canReplace()) void loadAccounts(cursor,previous); });
  const close = button('Close customer accounts',toolbar,() => {
    if (!canReplace()) return;generation++;root.hidden = true;editor.hidden = true;returnFocus?.();
  });
  const list = add('div','',root);list.setAttribute('data-customer-account-list','');
  const paging = add('div','',root);paging.setAttribute('data-account-actions','');
  const newer = button('Previous accounts',paging,() => { if (canReplace() && previous.length) void loadAccounts(previous.at(-1),previous.slice(0,-1)); });
  const older = button('More accounts',paging,() => { if (canReplace() && next) void loadAccounts(next,[...previous,cursor]); });
  const savedAccount = add('section','',root);savedAccount.hidden = true;savedAccount.tabIndex = -1;savedAccount.setAttribute('aria-label','Saved customer account');
  const savedText = add('p','',savedAccount);const savedReference = add('p','',savedAccount);
  const editor = add('form','',root);editor.hidden = true;editor.setAttribute('aria-label','Edit customer account');
  const editHeading = add('h4','New customer account',editor);
  const nameLabel = add('label','Customer account name',editor);const name = add('input','',nameLabel);name.required = true;name.maxLength = 200;name.name = 'customer_account_name';
  add('p','The selected jobs are the full account selection. Removing a job does not delete its invoices or history.',editor);
  const chosen = add('div','',editor);chosen.setAttribute('aria-label','Selected account jobs');
  const finder = add('fieldset','',editor);add('legend','Find jobs to link',finder);
  const searchLabel = add('label','Search jobs to link',finder);const search = add('input','',searchLabel);search.type = 'search';search.maxLength = 200;
  const find = button('Find customer jobs',finder,() => { if (!busy) { jobQuery = search.value.trim();void loadJobs(); } });
  const candidates = add('div','',finder);candidates.setAttribute('data-account-job-choices','');
  const jobMore = button('More jobs to link',finder,() => { if (!busy && jobNext) void loadJobs(jobNext); });
  const confirmation = add('label','',editor);confirmation.className='account-confirmation';const confirm = add('input','',confirmation);confirm.type = 'checkbox';
  add('span','I confirm these jobs belong to this customer account.',confirmation);
  const save = add('button','Save customer account',editor);save.type = 'submit';
  const discard = button('Discard account edits',editor,() => { if (busy) return;dirty = false;editor.hidden = true;controls();fresh.focus(); });
  let disposed = false;let busy = false;let dirty = false;let generation = 0;
  let cursor: string | undefined;let next: string | undefined;let previous: Array<string | undefined> = [];
  let jobNext: string | undefined;let jobQuery = '';let selected = new Set<string>();let editing: CustomerAccount | null = null;let lastSaved: CustomerAccount | null = null;
  let returnFocus: (() => void) | undefined;const knownJobs = new Map<string,CustomerJob>();
  let reminders: ReturnType<typeof mountCustomerAccountPaymentReminders> | null = null;
  let contacts: ReturnType<typeof mountCustomerAccountContactDefaults> | null = null;
  const statement = mountCustomerStatementView<CustomerAccountStatement>({ host: root,document: doc,kind: 'account',mail: opts.mail,
    canReviewEmail: (): boolean => !contacts?.isOpen() && !dirty && !reminders?.isOpen() && !reminders?.hasUnsavedChanges() && !reminders?.hasOpenEmail() && !reminders?.hasInFlightWork() && !payments.hasUnsavedChanges() && !payments.hasOpenEmail() && !payments.hasInFlightWork() && opts.canReviewEmail?.() !== false,
    onStateChanged: () => { queueMicrotask(() => { if (!disposed) controls(); }); },
    read: id => conn('reception.accounts.statement',{ account_id: id }),
    contactDefaults: copy => readCustomerAccountContactDefaults(conn,copy.account_id),
    prepare: (copy,sender,recipient) => conn('reception.accounts.statement.draft',{ account_id: copy.account_id,
      expected_statement_hash: copy.statement_hash,sender_mail_instance: sender,recipient_email: recipient }),
    validate: (copy,id) => copy.format === 'recued.customer-account-statement' && copy.version === 1 && copy.account_id === id
      && copy.jobs.length > 0 && copy.jobs.length <= CUSTOMER_ACCOUNT_MAX_JOBS && copy.balances.length > 0,
    documentModel: accountStatementDocument,lines: customerAccountStatementLines,heading: copy => `Customer account statement — ${copy.customer}`,
  });
  const payments = mountCustomerAccountPayments({ host: root,document: doc,conn,payment: opts.payment,mail: opts.mail,
    canReview: (): boolean => !contacts?.isOpen() && !dirty && !reminders?.isOpen() && !reminders?.hasUnsavedChanges() && !reminders?.hasOpenEmail() && !reminders?.hasInFlightWork() && !statement.hasUnsavedChanges() && !statement.hasOpenEmail() && !statement.hasInFlightWork() && opts.canReviewEmail?.() !== false,
    onChanged: () => opts.onChanged?.(),onStateChanged: () => { queueMicrotask(() => { if (!disposed) controls(); }); },
  });
  reminders = opts.mail ? mountCustomerAccountPaymentReminders({ host: root,document: doc,conn,mail: opts.mail,now: opts.now,autoLoad: false,
    canChange: (): boolean => !contacts?.isOpen() && !busy && !dirty && !statement.hasUnsavedChanges() && !statement.hasOpenEmail() && !statement.hasInFlightWork()
      && !payments.hasUnsavedChanges() && !payments.hasOpenEmail() && !payments.hasInFlightWork() && opts.canReviewEmail?.() !== false,
    canReviewEmail: (): boolean => !contacts?.isOpen() && !busy && !dirty && !statement.hasUnsavedChanges() && !statement.hasOpenEmail() && !statement.hasInFlightWork()
      && !payments.hasUnsavedChanges() && !payments.hasOpenEmail() && !payments.hasInFlightWork() && opts.canReviewEmail?.() !== false,
    onChanged: () => opts.onChanged?.(),onStateChanged: () => { queueMicrotask(() => { if (!disposed) { payments.updateControls();controls(); } }); },
  }) : null;
  contacts = mountCustomerAccountContactDefaults({ host: root,document: doc,conn,mail: opts.mail,
    canChange: () => !busy && !dirty && !reminders?.isOpen() && !reminders?.hasInFlightWork() && !reminders?.hasOpenEmail()
      && !statement.hasUnsavedChanges() && !statement.hasOpenEmail() && !statement.hasInFlightWork()
      && !payments.hasUnsavedChanges() && !payments.hasOpenEmail() && !payments.hasInFlightWork() && opts.canReviewEmail?.() !== false,
    onStateChanged: () => { queueMicrotask(() => { if (!disposed) controls(); }); },
  });
  const viewSaved = button('View saved account statement',savedAccount,() => {
    if (!lastSaved || !canReplace()) return;editor.hidden = true;
    void statement.open(lastSaved.account_id,() => { if (!disposed) (savedAccount.hidden ? editor.hidden ? fresh : name : viewSaved).focus(); });
  });
  const contactSaved = button('Edit saved account contact defaults',savedAccount,() => {
    if (lastSaved && canReplace()) { editor.hidden = true;void contacts?.open(lastSaved,() => contactSaved.focus()); }
  });
  const editSaved = button('Edit saved customer account',savedAccount,() => { if (lastSaved) openEditor(lastSaved.account_id); });
  const paySaved = button('Open saved account payments',savedAccount,() => { if (lastSaved && canReplace()) void payments.open(lastSaved.account_id,() => paySaved.focus()); });
  const followSaved = reminders ? button('Follow up on saved account payment',savedAccount,() => { if (lastSaved && canReplace()) void reminders.open(lastSaved,() => followSaved?.focus()); }) : null;
  const inFlight = () => busy || contacts?.hasInFlightWork() === true || statement.hasInFlightWork() || payments.hasInFlightWork() || reminders?.hasInFlightWork() === true;
  const canReplace = () => {
    if (inFlight() || dirty || contacts?.isOpen() || reminders?.isOpen() || reminders?.hasUnsavedChanges() || reminders?.hasOpenEmail() || statement.hasUnsavedChanges() || statement.hasOpenEmail() || payments.hasUnsavedChanges() || payments.hasOpenEmail()) {
      status.textContent = contacts?.isOpen() ? 'Save or discard the contact edits, then close contact defaults before changing accounts.'
        : 'Save or discard account edits, and close the follow-up, payment or email before changing accounts.';return false;
    }
    return true;
  };
  const controls = () => {
    const working = inFlight() || contacts?.isOpen() === true;contactSaved.disabled = working || !lastSaved;if (followSaved) followSaved.disabled = working || !lastSaved;paySaved.disabled = working || !lastSaved;viewSaved.disabled = working || !lastSaved?.job_ids.length;editSaved.disabled = working || !lastSaved;fresh.disabled = working;refresh.disabled = working;close.disabled = working;
    list.hidden = !editor.hidden;toolbar.hidden = !editor.hidden;
    newer.disabled = working || !previous.length;older.disabled = working || !next;paging.hidden = !editor.hidden || (!previous.length && !next);
    const editingBlocked = busy || contacts?.isOpen() === true || reminders?.isOpen() === true || reminders?.hasOpenEmail() === true || reminders?.hasUnsavedChanges() === true;
    name.disabled = editingBlocked;search.disabled = editingBlocked;find.disabled = busy;jobMore.disabled = busy || !jobNext;
    confirm.disabled = editingBlocked;save.disabled = editingBlocked || !dirty || !confirm.checked || statement.hasOpenEmail() || statement.hasInFlightWork();discard.disabled = busy;
    for (const check of editor.querySelectorAll<HTMLInputElement>('input[data-account-job]')) check.disabled = busy;
    for (const action of chosen.querySelectorAll<HTMLButtonElement>('button')) action.disabled = busy;
    for (const action of list.querySelectorAll<HTMLButtonElement>('button')) action.disabled = working || action.dataset.accountEmpty === 'true';
    opts.onStateChanged?.();
  };
  const changed = () => { dirty = true;confirm.checked = false;controls(); };
  const renderSelection = () => {
    chosen.replaceChildren();add('p',`${selected.size} selected job${selected.size === 1 ? '' : 's'} (maximum 100).`,chosen);
    for (const id of selected) {
      const job = knownJobs.get(id);const line = add('div','',chosen);
      const label = job ? `${job.quote_label} · ${job.customer} · ${job.quote_reference ?? id}` : `Saved job ${id}`;
      add('p',label,line);const remove = button(`Remove job ${job?.quote_label ?? id}`,line,() => {
        selected.delete(id);changed();renderSelection();syncChoices();(chosen.querySelector<HTMLButtonElement>('button') ?? name).focus();
      });remove.setAttribute('data-account-remove-job',id);remove.disabled = busy;
    }
  };
  const syncChoices = () => { for (const input of candidates.querySelectorAll<HTMLInputElement>('input[data-account-job]')) input.checked = selected.has(input.getAttribute('data-account-job')!); };
  const message = (error: unknown) => error instanceof Error ? error.message : 'Customer accounts could not be loaded. Try again.';
  const loadJobs = async (desired?: string) => {
    if (disposed || busy || editor.hidden) return;const current = ++generation;busy = true;controls();
    try {
      const result = await conn('reception.jobs.list',{ limit: 50,...(jobQuery ? { search: jobQuery } : {}),...(desired ? { cursor: desired } : {}) });
      if (disposed || generation !== current) return;candidates.replaceChildren();jobNext = result.next_cursor;
      for (const job of result.jobs) {
        knownJobs.set(job.job_id,job);if (!job.agreement) continue;
        const label = add('label','',candidates);const check = add('input','',label);check.type = 'checkbox';check.checked = selected.has(job.job_id);check.setAttribute('data-account-job',job.job_id);
        add('span',`${job.quote_label} · ${job.customer} · ${job.quote_reference ?? job.job_id} · ${job.currency}`,label);
        check.addEventListener('change',() => {
          if (check.checked && selected.size >= CUSTOMER_ACCOUNT_MAX_JOBS) { check.checked = false;status.textContent = 'Choose up to 100 customer jobs.';return; }
          if (check.checked) selected.add(job.job_id);else selected.delete(job.job_id);changed();renderSelection();
        });
      }
      renderSelection();status.textContent = 'Choose only jobs that belong to this customer. Use More jobs to link to browse further.';
    } catch (error) { if (!disposed && generation === current) status.textContent = message(error); }
    finally { if (!disposed && generation === current) { busy = false;controls(); } }
  };
  const edit = async (account: CustomerAccount) => {
    savedAccount.hidden = true;lastSaved = null;editing = account;selected = new Set(account.job_ids);name.value = account.customer;dirty = false;confirm.checked = false;
    editor.hidden = false;editHeading.textContent = account.revision ? `Edit customer account — ${account.customer}` : 'New customer account';
    search.value = '';jobQuery = '';jobNext = undefined;renderSelection();controls();await loadJobs();if (!disposed && !editor.hidden && !busy) { focusCustomerWorkspace(editor);name.focus({preventScroll:true}); }
  };
  const openEditor = (id: string) => {
    if (!canReplace()) return;busy = true;controls();const current = ++generation;
    void conn('reception.accounts.get',{ account_id: id }).then(account => {
      if (!disposed && generation === current) { busy = false;void edit(account); }
    }).catch(error => { if (!disposed && generation === current) { status.textContent = message(error);busy = false;controls(); } });
  };
  const loadAccounts = async (desired?: string,history: Array<string | undefined> = []) => {
    if (disposed || busy) return;const current = ++generation;busy = true;controls();
    try {
      const result = await conn('reception.accounts.list',{ limit: 25,...(desired ? { cursor: desired } : {}) });
      if (disposed || generation !== current) return;cursor = desired;previous = [...history];next = result.next_cursor;list.replaceChildren();
      if (!result.accounts.length) add('p','No customer accounts on this page. Create an account to link its jobs.',list);
      for (const account of result.accounts) {
        const card = add('article','',list);card.setAttribute('data-account-id',account.account_id);
        add('h4',account.customer,card);add('p',`${account.job_ids.length} linked jobs`,card);const tools = add('details','',card);add('summary','Account actions',tools);
        button(`Edit account ${account.customer}`,tools,() => { openEditor(account.account_id); });
        const contact = button(`Edit contact defaults for ${account.customer}`,tools,() => {
          if (!canReplace()) return;editor.hidden = true;void contacts?.open(account,() => {
            (list.querySelector<HTMLButtonElement>(`[data-account-id="${account.account_id}"] button[data-account-contact-action]`) ?? fresh).focus();
          });
        });contact.setAttribute('data-account-contact-action','');
        const view = button(`View account statement for ${account.customer}`,tools,() => {
          if (!canReplace()) return;editor.hidden = true;void statement.open(account.account_id,() => {
            if (disposed) return;(list.querySelector<HTMLButtonElement>(`[data-account-id="${account.account_id}"] button[data-account-statement-action]`) ?? fresh).focus();
          });
        });
        view.setAttribute('data-account-statement-action','');view.dataset.accountEmpty = String(!account.job_ids.length);view.disabled = !account.job_ids.length;
        const pay = button(`Open account payments for ${account.customer}`,tools,() => { if (canReplace()) { editor.hidden = true;void payments.open(account.account_id,() => pay.focus()); } });
        if (reminders) {
          const follow = button(`Follow up on account payment for ${account.customer}`,tools,() => {
            if (canReplace()) { editor.hidden = true;void reminders.open(account,() => follow.focus()); }
          });
        }
      }
      status.textContent = `${result.accounts.length} customer accounts on this page.`;
    } catch (error) { if (!disposed && generation === current) status.textContent = message(error)+' Previously loaded accounts remain visible.'; }
    finally { if (!disposed && generation === current) { busy = false;controls(); } }
  };
  name.addEventListener('input',changed);confirm.addEventListener('change',controls);
  search.addEventListener('keydown',event => { if (event.key === 'Enter') { event.preventDefault();find.click(); } });
  editor.addEventListener('submit',event => {
    event.preventDefault();if (busy || contacts?.isOpen() || reminders?.isOpen() || reminders?.hasOpenEmail() || reminders?.hasUnsavedChanges() || !editing || !dirty || !confirm.checked || statement.hasOpenEmail() || statement.hasInFlightWork()) return;
    const input = { account_id: editing.account_id,expected_revision: editing.revision,customer: name.value.trim(),job_ids: [...selected] };
    const current = ++generation;busy = true;controls();
    void conn('reception.accounts.save',input).then(account => {
      if (disposed || generation !== current) return;editing = account;lastSaved = account;dirty = false;confirm.checked = false;editor.hidden = true;
      savedText.textContent = `Customer account saved: ${account.customer}. ${account.job_ids.length} selected jobs.`;
      savedReference.textContent = `Account ${account.account_id}`;savedAccount.hidden = false;savedAccount.focus();
      status.textContent = 'Customer account saved. Review its statement to prepare a customer copy.';busy = false;controls();
      void loadAccounts(cursor,previous).then(() => {
        if (!disposed && lastSaved?.account_id === account.account_id && !dirty && !savedAccount.hidden && !inFlight()) {
          (account.job_ids.length ? viewSaved : savedAccount).focus();
        }
      });
    }).catch(error => { if (!disposed && generation === current) { status.textContent = message(error);busy = false;controls(); } });
  });
  controls();
  return {
    open: async (onClosed?: () => void) => { if (!canReplace()) return;returnFocus = onClosed;root.hidden = false;reminders?.update();await loadAccounts(cursor,previous);if (!disposed) focusCustomerWorkspace(root); },
    update: () => { if (!root.hidden) reminders?.update(); },
    hasOpenEmail: () => contacts?.isOpen() === true || statement.hasOpenEmail() || payments.hasOpenEmail() || reminders?.hasOpenEmail() === true,hasUnsavedChanges: () => dirty || contacts?.hasUnsavedChanges() === true || statement.hasUnsavedChanges() || payments.hasUnsavedChanges() || reminders?.hasUnsavedChanges() === true,hasInFlightWork: inFlight,
    dispose: () => { disposed = true;generation++;contacts?.dispose();statement.dispose();payments.dispose();reminders?.dispose();root.remove(); },
  };
};
