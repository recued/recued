import { parseCustomerAccountContactDefaults,type CustomerAccountContactDefaults,type CustomerAccountContactDefaultsRecord,type CustomerAccount,
  type Conn,type ServerRpcRegistry } from '@recued/contracts';
import type { MailComposeDeps } from '../mail/mail-compose-host.js';

export type CustomerAccountContactDefaultsReadConn = Conn<Pick<ServerRpcRegistry,'reception.accounts.contact.get'>>;
export type CustomerAccountContactDefaultsConn = CustomerAccountContactDefaultsReadConn & Conn<Pick<ServerRpcRegistry,'reception.accounts.contact.set'>>;
const checked = (value: CustomerAccountContactDefaultsRecord,account_id: string): CustomerAccountContactDefaultsRecord => {
  if (!value || value.format !== 'recued.customer-account-contact-defaults' || value.version !== 1 || value.account_id !== account_id
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || (value.revision === 0 ? value.updated_at !== null : !Number.isSafeInteger(value.updated_at) || value.updated_at! < 0)) {
    throw new Error('The contact defaults do not match this saved account. Refresh and try again.');
  }
  const contact = parseCustomerAccountContactDefaults(value.contact);
  if (value.revision === 0 && Object.keys(contact).length) throw new Error('The contact defaults have not been saved for this account.');
  return { ...value,contact };
};
export const readCustomerAccountContactDefaults = async (conn: CustomerAccountContactDefaultsReadConn,account_id: string) =>
  checked(await conn('reception.accounts.contact.get',{ account_id }),account_id);

/** A separate owner preference editor never rewrites the account's job selection. */
export const mountCustomerAccountContactDefaults = (opts: {
  host: HTMLElement;document: Document;conn: CustomerAccountContactDefaultsConn;mail?: Pick<MailComposeDeps,'listMailInstances'>;
  canChange: () => boolean;onStateChanged: () => void;
}) => {
  const doc = opts.document;
  const add = <K extends keyof HTMLElementTagNameMap>(tag: K,text: string,host: HTMLElement) => {
    const node = doc.createElement(tag);node.textContent = text;host.appendChild(node);return node;
  };
  const root = add('section','',opts.host);root.hidden = true;root.tabIndex = -1;root.setAttribute('data-account-contact-defaults','');root.setAttribute('aria-label','Saved account contact defaults');
  add('style',`[data-account-contact-defaults]{display:grid;gap:12px;padding:14px;border:1px solid var(--border,#ddd);border-radius:8px;min-width:0}
    [data-account-contact-defaults][hidden]{display:none!important}[data-account-contact-defaults] form,[data-account-contact-defaults] label{display:grid;gap:8px;min-width:0}
    [data-account-contact-defaults] p{overflow-wrap:anywhere}[data-account-contact-defaults] input,[data-account-contact-defaults] select{box-sizing:border-box;width:100%;min-width:0;max-width:100%}
    [data-contact-default-actions]{display:flex;flex-wrap:wrap;gap:8px}`,root);
  const heading = add('h4','Saved account contact defaults',root);
  add('p','Use these to fill new account statement, payment receipt and follow-up emails. Review each email before sending. Saved drafts and follow-ups keep their own choices.',root);
  const status = add('p','',root);status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const form = add('form','',root);form.setAttribute('aria-label','Edit account contact defaults');
  const field = (label: string,type: string,maxLength: number) => { const wrap = add('label',label,form);const node = add('input','',wrap);node.type = type;node.maxLength = maxLength;return node; };
  const name = field('Contact name (optional)','text',200);const email = field('Default customer email (optional)','email',254);
  const senderLabel = add('label','Default Mail account (optional)',form);const sender = add('select','',form);sender.id = 'recued-account-contact-default-sender';senderLabel.setAttribute('for',sender.id);
  const mailStatus = add('p','',form);const actions = add('div','',form);actions.setAttribute('data-contact-default-actions','');
  const save = add('button','Save contact defaults',actions);save.type = 'submit';
  const clear = add('button','Clear contact fields',actions);clear.type = 'button';
  const refresh = add('button','Refresh contact defaults',actions);refresh.type = 'button';
  const discard = add('button','Discard contact default edits',actions);discard.type = 'button';
  const close = add('button','Close contact defaults',actions);close.type = 'button';
  let disposed = false;let busy = false;let dirty = false;let generation = 0;let account: CustomerAccount | null = null;
  let record: CustomerAccountContactDefaultsRecord | null = null;let returnFocus: (() => void) | undefined;
  const controls = () => {
    for (const node of [name,email,sender,clear,refresh,discard,close]) node.disabled = busy;
    save.disabled = busy || !record || !dirty || !opts.canChange();opts.onStateChanged();
  };
  const finish = () => {
    const current = ++generation;root.hidden = true;dirty = false;record = null;account = null;controls();
    queueMicrotask(() => { if (!disposed && current === generation && root.hidden) returnFocus?.(); });
  };
  const changed = () => { if (disposed || busy) return;dirty = true;controls(); };
  const load = async () => {
    if (disposed || busy || !account) return;
    if (dirty) { status.textContent = 'Save or discard your contact edits before refreshing.';return; }
    const target = account;const current = ++generation;busy = true;record = null;name.value = email.value = '';sender.replaceChildren();controls();status.textContent = 'Loading saved contact defaults…';
    try {
      const [defaults,mail] = await Promise.allSettled([readCustomerAccountContactDefaults(opts.conn,target.account_id),
        opts.mail?.listMailInstances() ?? Promise.resolve({ instances: [] })]);
      if (disposed || current !== generation) return;
      if (defaults.status === 'rejected') throw defaults.reason;
      record = defaults.value;name.value = record.contact.contact_name ?? '';email.value = record.contact.recipient_email ?? '';
      const blank = add('option','Choose for each email',sender);blank.value = '';
      const senders = mail.status === 'fulfilled' ? mail.value.instances.filter(row => row.send_capable) : [];
      for (const row of senders) { const option = add('option',row.account_email || row.slug,sender);option.value = row.slug; }
      const preferred = record.contact.sender_mail_instance;
      if (preferred && !senders.some(row => row.slug === preferred)) { const missing = add('option',preferred+' (unavailable)',sender);missing.value = preferred; }
      sender.value = preferred ?? '';dirty = false;
      status.textContent = record.revision === 0 ? 'No contact defaults saved yet.' : 'Saved contact defaults loaded. Changes apply to new email forms.';
      mailStatus.textContent = preferred && !senders.some(row => row.slug === preferred) ? 'The saved Mail account is unavailable. New emails will ask you to choose one.'
        : mail.status === 'rejected' ? 'Mail accounts could not be loaded. You can still save the contact name and email.'
          : !senders.length ? 'Connect a Mail account that can send to choose a default sender.' : 'The default Mail account must be available when you prepare an email.';
    } catch (error) { if (!disposed && current === generation) status.textContent = error instanceof Error ? error.message : 'Contact defaults could not be loaded.'; }
    finally { if (!disposed && current === generation) { busy = false;controls();name.focus(); } }
  };
  name.addEventListener('input',changed);email.addEventListener('input',changed);sender.addEventListener('change',changed);
  clear.addEventListener('click',() => { if (busy) return;name.value = email.value = sender.value = '';changed();status.textContent = 'Contact fields cleared in this form. Save to clear the saved defaults.';name.focus(); });
  refresh.addEventListener('click',() => { void load(); });
  discard.addEventListener('click',() => { if (!busy) finish(); });
  close.addEventListener('click',() => { if (busy) return;if (dirty) { status.textContent = 'Save or discard the contact edits before closing.';return; }finish(); });
  form.addEventListener('submit',event => {
    event.preventDefault();if (disposed || busy || !account || !record || !dirty || !opts.canChange()) return;
    let fields: CustomerAccountContactDefaults;
    try { fields = parseCustomerAccountContactDefaults({ ...(name.value.trim() ? { contact_name: name.value.trim() } : {}),
      ...(email.value.trim() ? { recipient_email: email.value.trim() } : {}),...(sender.value ? { sender_mail_instance: sender.value } : {}) }); }
    catch (error) { status.textContent = error instanceof Error ? error.message : 'Choose valid contact defaults.';return; }
    const target = account.account_id;const expected = record.revision;const current = ++generation;busy = true;controls();
    void opts.conn('reception.accounts.contact.set',{ account_id: target,expected_revision: expected,contact: fields }).then(value => {
      if (disposed || current !== generation) return;
      const saved = checked(value,target);
      if (saved.revision !== expected+1 || JSON.stringify(saved.contact) !== JSON.stringify(fields)) throw new Error('The saved contact defaults are unconfirmed. Close and refresh them before trying again.');
      record = saved;dirty = false;status.textContent = 'Contact defaults saved. Close this view to use them in a new account email.';
    }).catch(error => { if (!disposed && current === generation) status.textContent = error instanceof Error ? error.message : 'Contact defaults could not be saved. Your edits remain in this form.'; })
      .finally(() => { if (!disposed && current === generation) { busy = false;controls(); } });
  });
  controls();
  return { open: async (value: CustomerAccount,onClosed?: () => void) => {
    if (disposed || busy || dirty || !opts.canChange()) return;
    account = value;returnFocus = onClosed;root.hidden = false;heading.textContent = 'Account contact defaults — '+value.customer;root.focus();await load();
  },isOpen: () => !root.hidden,hasUnsavedChanges: () => dirty,hasInFlightWork: () => busy,
  dispose: () => { disposed = true;generation++;root.remove(); } };
};
