import { composeDialog,type QuoteSignoffReminder,type QuoteSignoffReminderSetInput,type QuoteSignoffReminderDraftResult,type CustomerAccountContactDefaultsRecord } from '@recued/contracts';
import { FORM_RENDERER_STYLES,MAIL_COMPOSE_STYLES } from '@recued/ui-shared';
import { mountMailCompose,type MailComposeDeps } from '../mail/mail-compose-host.js';

export interface CustomerReminderRequest { request_id: string;customer: string;quote_label: string;quote_reference?: string;expires_at?: number;detail?: string }
export type CustomerReminderState = Omit<QuoteSignoffReminder,'signoff_id' | 'has_saved_link'> & { has_saved_link?: boolean;draft_stale?: boolean;notice?: string };
export type CustomerReminderOptions = { mail: MailComposeDeps;now?: () => number;canReviewEmail?: () => boolean;canChange?: () => boolean;onStateChanged?: () => void;autoLoad?: boolean;editorOnly?: boolean };
export interface CustomerReminderApi {
  get(input: { request_id: string }): Promise<CustomerReminderState>;
  set(input: Omit<QuoteSignoffReminderSetInput,'signoff_id'> & { request_id: string }): Promise<CustomerReminderState>;
  list(input: { limit?: number;cursor?: string }): Promise<{ reminders: Array<{ request: CustomerReminderRequest;reminder: CustomerReminderState }>;next_cursor?: string }>;
  draft(input: { request_id: string;expected_revision: number }): Promise<QuoteSignoffReminderDraftResult>;
}
/** Keep edits outside the refreshed queue. The shared composer owns Send. */
export const mountCustomerReminders = (opts: CustomerReminderOptions & {
  host: HTMLElement;document: Document;api: CustomerReminderApi;kind: 'offer' | 'completion' | 'payment' | 'account_payment';
  contactDefaults?: (request_id: string) => Promise<CustomerAccountContactDefaultsRecord>;
}) => {
  const { document: doc,api: conn } = opts; const now = opts.now ?? Date.now;
  const accountKind = opts.kind === 'account_payment';
  const paymentKind = opts.kind === 'payment' || accountKind;
  const label = (text: string) => accountKind ? text.replace('payment','account payment').replace('Payment','Account payment') : text;
  const namespace = accountKind ? 'account-payment' : opts.kind === 'offer' ? 'signoff' : opts.kind;
  const root = doc.createElement('section'); root.setAttribute(`data-${namespace}-reminders`, ''); opts.host.appendChild(root);
  const add = (tag: string, text: string, host: HTMLElement = root) => {
    const element = doc.createElement(tag); element.textContent = text; host.appendChild(element); return element;
  };
  const title = add('h3',opts.kind === 'offer' ? 'Customer follow-ups' : paymentKind ? label('Customer payment follow-ups') : 'Customer completion follow-ups');
  const introduction = add('p', opts.kind === 'offer' ? 'Set a date to follow up on an unanswered offer. Email reminders become saved drafts for you to review.'
    : accountKind ? 'Follow up on the account’s unpaid invoices together. Linked invoice reminders are held until this account follow-up is paused, including after sending.'
    : paymentKind ? 'Follow up on a recorded unpaid invoice. Review email drafts before sending; payment is recorded separately.'
      : 'Set a date to follow up on an unanswered completion request. Email reminders become saved drafts for you to review.');
  const status = add('p', 'Loading follow-ups…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = add('div', ''); actions.className = 'request-actions';
  const button = (text: string, host: HTMLElement, click: () => void) => {
    const node = doc.createElement('button'); node.type = 'button'; node.textContent = text;
    node.addEventListener('click', click); host.appendChild(node); return node;
  };
  const refresh = button(paymentKind ? label('Refresh payment follow-ups') : 'Refresh follow-ups', actions, () => { void load(); });
  const queue = add('div', ''); queue.setAttribute(`data-${namespace}-reminder-queue`, '');
  const pages = add('div', ''); pages.className = 'request-actions';
  const newer = button(paymentKind ? label('Earlier payment follow-ups') : 'Earlier follow-ups', pages, () => {
    if (!busy && !loading && previous.length) void load({ cursor: previous.at(-1), previous: previous.slice(0, -1) });
  });
  const older = button(paymentKind ? label('More payment follow-ups') : 'More follow-ups', pages, () => {
    if (!busy && !loading && next) void load({ cursor: next, previous: [...previous, cursor] });
  });
  if (opts.editorOnly) for (const node of [title,introduction,status,actions,queue,pages]) node.hidden = true;
  const editor = add('div', ''); editor.hidden = true; editor.setAttribute(`data-${namespace}-reminder-editor`, '');
  const heading = add('h3', '', editor);
  const editorStatus = add('p', '', editor); editorStatus.setAttribute('role', 'status'); editorStatus.setAttribute('aria-live', 'polite');
  const form = doc.createElement('form');form.setAttribute('aria-label',opts.kind === 'offer' ? 'Customer follow-up' : paymentKind ? label('Payment follow-up') : 'Completion follow-up');editor.appendChild(form);
  const field = (name: string, label: string, type: string) => {
    const wrap = add('label', label, form); const input = doc.createElement('input'); input.type = type;
    input.setAttribute('name', name); wrap.appendChild(input); return input;
  };
  const when = field('reminder_due_at', 'Follow-up time (your device timezone)', 'datetime-local'); when.required = true;
  const email = field('reminder_recipient', 'Customer email (optional)', 'email'); email.maxLength = 254;
  const accountLabel = add('label', 'Mail account (optional)', form);
  const account = doc.createElement('select'); account.setAttribute('name', 'reminder_account'); account.setAttribute('id',`recued-${opts.kind}-reminder-account`);accountLabel.setAttribute('for',`recued-${opts.kind}-reminder-account`);form.appendChild(account);
  const link = paymentKind ? null : field('reminder_link', opts.kind === 'offer' ? 'Offer link (paste it here for an older request)' : 'Completion link (paste it here for an older request)', 'url');
  const contactStatus = add('p','',form);contactStatus.hidden = !opts.contactDefaults;contactStatus.setAttribute('data-account-contact-default-status','');
  if (link) link.maxLength = 2048;
  const save = doc.createElement('button'); save.type = 'submit'; save.textContent = paymentKind ? label('Save payment follow-up') : 'Save follow-up'; form.appendChild(save);
  const close = button(paymentKind ? label('Close payment follow-up') : 'Close follow-up', editor, () => {
    if (!busy) { editor.hidden = true; selected = null; dirty = false; editorGeneration++; controls();returnFocus?.(); }
  });
  const pauseEditor = accountKind ? button('Pause account payment follow-up',editor,() => {
    if (!selected || busy || selected.reminder.due_at === null) return;const target = selected;
    void mutate(async () => {
      await conn.set({ request_id: target.request.request_id,expected_revision: target.reminder.revision,due_at: null });
      if (disposed) return;editor.hidden = true;selected = null;dirty = false;editorGeneration++;
      status.textContent = 'Account follow-up paused. Linked invoice reminders can resume once unknown sends are resolved.';
    }).then(() => { if (!disposed && !selected) returnFocus?.(); });
  }) : null;
  const editorControls: Array<HTMLInputElement | HTMLSelectElement | HTMLButtonElement> = [when,email,account,save,close];
  if (pauseEditor) editorControls.push(pauseEditor);
  if (link) editorControls.push(link);
  const composeHost = add('div', '');
  const style = doc.createElement('style'); style.textContent = `${FORM_RENDERER_STYLES}\n${MAIL_COMPOSE_STYLES}`; composeHost.appendChild(style);
  const compose = mountMailCompose(composeHost,{ ...opts.mail,onStateChanged: () => { opts.mail.onStateChanged?.();queueMicrotask(() => { if (!disposed) controls(); }); } });
  let disposed = false; let generation = 0; let editorGeneration = 0;
  let loading = false; let busy = false; let dirty = false;
  let cursor: string | undefined; let next: string | undefined; let previous: Array<string | undefined> = [];
  let pending: { cursor?: string; previous: Array<string | undefined> } | undefined;
  let selected: { request: CustomerReminderRequest; reminder: CustomerReminderState } | null = null;
  let rowButtons: HTMLButtonElement[] = [];
  let returnFocus: (() => void) | undefined;
  let recipientEdited = false;let senderEdited = false;
  const focusedAction = () => rowButtons.find(node => node === doc.activeElement)?.getAttribute('data-reminder-action');
  const focusIsIdle = () => !doc.activeElement || doc.activeElement === doc.body;
  const focusAction = (key: string) => (rowButtons.find(node => node.getAttribute('data-reminder-action') === key) ?? refresh).focus();
  const message = (error: unknown) => error instanceof Error ? error.message : 'The follow-up could not be loaded. Try again.';
  const controls = () => {
    refresh.disabled = busy || loading; newer.disabled = busy || loading || previous.length === 0;
    older.disabled = busy || loading || !next;
    pages.hidden = opts.editorOnly === true || previous.length === 0 && !next;
    rowButtons.forEach(node => { node.disabled = busy; });
    editorControls.forEach(node => { node.disabled = busy; });
    if (pauseEditor) pauseEditor.disabled = busy || !selected || selected.reminder.due_at === null;
    opts.onStateChanged?.();
  };
  const mutate = async (body: () => Promise<void>, sourceAction?: string) => {
    if (busy || disposed) return;
    if (opts.canChange?.() === false) { status.textContent = 'Save or close the account edits, payment or email before changing its follow-up.';return; }
    const origin = doc.activeElement;const action = sourceAction ?? focusedAction();
    const control = editorControls.find(node => node === doc.activeElement);
    busy = true; controls();
    try { await body(); if (!disposed) await load(); }
    catch (error) { if (!disposed) { status.textContent = message(error); editorStatus.textContent = message(error); } }
    finally { if (!disposed) {
      busy = false; controls();
      if (focusIsIdle() || doc.activeElement === origin) { if (action) focusAction(action); else if (control) control.focus(); }
    } }
  };
  const changeFromQueue = (body: () => Promise<void>,sourceAction: string) => {
    if (!editor.hidden) {
      editorStatus.textContent = 'Save or close this follow-up before changing it from the queue.';return;
    }
    void mutate(body,sourceAction);
  };
  const localDate = (instant: number) => {
    const date = new Date(instant); const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const open = async (request: CustomerReminderRequest, onClosed?: () => void) => {
    if (disposed || busy || compose.hasInFlightWork()) return;
    if (opts.canChange?.() === false) { status.textContent = 'Save or close the account edits, payment or email before changing its follow-up.';return; }
    if (dirty) {
      editorStatus.textContent = 'Save or close this follow-up before opening another.'; return;
    }
    const action = focusedAction();
    returnFocus = onClosed ?? (() => { if (action) focusAction(action); else refresh.focus(); });
    const current = ++editorGeneration;
    editor.hidden = false; editorStatus.textContent = 'Loading follow-up…';
    heading.textContent = `Follow up — ${request.customer} — ${paymentKind ? request.quote_reference ?? request.quote_label : request.quote_label}`;
    selected = null; when.value = ''; email.value = ''; if (link) link.value = ''; account.replaceChildren();
    recipientEdited = senderEdited = false;contactStatus.textContent = '';
    busy = true; controls();
    try {
      const [reminderResult, mailResult] = await Promise.allSettled([
        conn.get( { request_id: request.request_id }), opts.mail.listMailInstances(),
      ]);
      if (disposed || current !== editorGeneration) return;
      if (reminderResult.status === 'rejected') throw reminderResult.reason;
      const reminder = reminderResult.value;
      selected = { request, reminder }; dirty = false;
      when.value = localDate(reminder.due_at ?? (request.expires_at === undefined ? now() + 86_400_000 : Math.min(now() + 86_400_000, request.expires_at - 60_000)));
      email.value = reminder.recipient_email ?? ''; if (link) link.value = '';
      account.replaceChildren(); const empty = doc.createElement('option'); empty.value = ''; empty.textContent = 'Owner reminder only'; account.appendChild(empty);
      const senders = mailResult.status === 'fulfilled' ? mailResult.value.instances.filter(row => row.send_capable) : [];
      for (const row of senders) { const option = doc.createElement('option'); option.value = row.slug;
        option.textContent = row.account_email || row.slug; account.appendChild(option); }
      if (reminder.sender_mail_instance && !senders.some(row => row.slug === reminder.sender_mail_instance)) {
        const missing = doc.createElement('option'); missing.value = reminder.sender_mail_instance;
        missing.textContent = `${reminder.sender_mail_instance} (unavailable)`; account.appendChild(missing);
      }
      account.value = reminder.sender_mail_instance ?? '';
      editorStatus.textContent = accountKind
        ? 'Email drafts list all unpaid account invoices and totals by currency. Save again after changes. Refunds owed or incomplete records stop follow-up. Linked invoice reminders stay held until you pause this account follow-up.'
        : paymentKind
        ? 'Email drafts use the current recorded invoice balance and due date. Save this follow-up again if the invoice changes after drafting.'
        : reminder.has_saved_link ? 'The active request link is saved. Leave the link field blank to keep it.'
        : 'For an email reminder, paste the active request link. You can save an owner reminder without email settings.';
      if (reminder.notice) editorStatus.textContent = reminder.notice;
      if (accountKind && reminder.status === 'stopped') editorStatus.textContent += ' This follow-up is stopped. Review the account statement, or pause it to hand follow-up back to its invoices.';
      if (mailResult.status === 'rejected') editorStatus.textContent += ' Mail accounts could not be loaded; owner reminders remain available.';
      if (reminder.revision === 0 && opts.contactDefaults) {
        contactStatus.textContent = 'Loading saved account contact defaults…';
        void opts.contactDefaults(request.request_id).then(defaults => {
          if (disposed || current !== editorGeneration || busy || selected?.request.request_id !== request.request_id || selected.reminder.revision !== 0) return;
          if (!recipientEdited) email.value = defaults.contact.recipient_email ?? '';
          const preferred = defaults.contact.sender_mail_instance;const available = !preferred || senders.some(row => row.slug === preferred);
          if (!senderEdited) account.value = available ? preferred ?? '' : '';
          contactStatus.textContent = Object.keys(defaults.contact).length ? (defaults.contact.contact_name ? 'Saved contact: '+defaults.contact.contact_name+'. ' : '')+'Check the email details, then save this follow-up.' : 'No saved contact defaults. Choose the details for this follow-up.';
          if (!available) contactStatus.textContent += ' The saved Mail account is unavailable. Choose one, or clear both email fields for an owner reminder.';
        }).catch(() => {
          if (!disposed && current === editorGeneration && !busy && selected?.request.request_id === request.request_id && selected.reminder.revision === 0) {
            contactStatus.textContent = 'Saved contact defaults could not be loaded. Choose the email details yourself.';
          }
        });
      }
    } catch (error) { if (!disposed && current === editorGeneration) { selected = null; editorStatus.textContent = message(error); } }
    finally { if (!disposed && current === editorGeneration) { busy = false; controls(); if (selected) when.focus(); } }
  };
  const draft = async (request: CustomerReminderRequest, reminder: CustomerReminderState, sourceAction: string) => {
    await mutate(async () => {
      if (dirty) throw new Error('Save or close this follow-up before reviewing its email.');
      if (!opts.mail.drafts) throw new Error('Saved email drafts are unavailable. Open Mail to configure them.');
      if (compose.hasUnsavedChanges() || composeDialog(compose.state()) || opts.canReviewEmail?.() === false) throw new Error('Close the email you have open before reviewing another reminder.');
      const prepared = await conn.draft( { request_id: request.request_id, expected_revision: reminder.revision });
      if (disposed) return;
      const saved = await opts.mail.drafts.create(prepared);
      if (disposed) return;
      await compose.refresh();
      if (disposed) return;
      if (!await compose.openSaved(saved.draft_id)) throw new Error('The draft is saved in Mail. Close your current email before opening it.');
      status.textContent = 'Reminder draft saved. Review it and choose Send; Recued uses your normal mail approval controls.';
    }, sourceAction);
  };
  const load = async (page: { cursor?: string; previous: Array<string | undefined> } = pending ?? { cursor, previous: [...previous] }) => {
    const requestedCursor = page.cursor; const requestedPrevious = page.previous;
    const current = ++generation; pending = page;
    let restoreAction: string | null | undefined;
    loading = true; controls();
    try {
      const page = await conn.list( { limit: 50, ...(requestedCursor ? { cursor: requestedCursor } : {}) });
      if (disposed || current !== generation) return;
      cursor = requestedCursor; previous = [...requestedPrevious]; next = page.next_cursor;
      restoreAction = focusedAction();
      queue.replaceChildren(); rowButtons = [];
      for (const { request, reminder } of page.reminders) {
        const card = add('article', '', queue); card.setAttribute('data-reminder-request-id', request.request_id);
        add('h4', `${request.customer} — ${request.quote_reference ?? request.quote_label}`, card);
        if (request.detail) add('p',request.detail,card);
        add('p', `${reminder.status === 'due' ? 'Follow-up due' : 'Follow-up scheduled'}: ${new Date(reminder.due_at!).toLocaleString()}.`, card);
        if (reminder.delivery === 'uncertain') add('p', 'The previous email outcome is unknown. Review it in Mail before preparing another.', card);
        else if (reminder.draft_stale) add('p',accountKind ? 'The account or billing records changed after this draft. Edit and save the follow-up again for a fresh email.' : 'The invoice changed after this draft was prepared. Edit and save the follow-up again for a fresh email.',card);
        else if (reminder.delivery === 'draft_ready') add('p', 'A reminder draft is ready to review in Mail.', card);
        const rowActions = add('div', '', card); rowActions.className = 'request-actions';
        const action = (label: string, key: string, click: (identity: string) => void) => {
          const identity = `${request.request_id}:${key}`;
          const node = button(label, rowActions, () => click(identity));
          node.setAttribute('data-reminder-action', identity); rowButtons.push(node);
        };
        action(paymentKind ? label('Edit payment follow-up') : 'Edit follow-up', 'edit', identity => { void open(request, () => focusAction(identity)); });
        action(paymentKind ? label('Snooze payment 1 day') : 'Snooze 1 day', 'snooze', identity => { changeFromQueue(async () => {
          await conn.set( { request_id: request.request_id,
            expected_revision: reminder.revision, due_at: Math.max(now(), reminder.due_at!) + 86_400_000 });
        }, identity); });
        action(paymentKind ? label('Pause payment follow-up') : 'Pause follow-up', 'pause', identity => { changeFromQueue(async () => {
          await conn.set( { request_id: request.request_id, expected_revision: reminder.revision, due_at: null });
        }, identity); });
        if (reminder.status === 'due' && reminder.delivery !== 'uncertain' && !reminder.draft_stale
          && reminder.recipient_email && reminder.sender_mail_instance && (paymentKind || reminder.has_saved_link)) {
          action(paymentKind ? label('Review payment reminder email') : 'Review reminder email', 'draft', identity => { void draft(request, reminder, identity); });
        }
      }
      if (!page.reminders.length) add('p', accountKind ? 'No account payment follow-ups on this page. Set one beside a saved customer account.' : paymentKind ? 'No payment follow-ups on this page. Set one on an open invoice in Customer jobs.'
        : 'No follow-ups on this page. Set a follow-up on a request waiting for its customer.', queue);
      pages.hidden = opts.editorOnly === true || (!previous.length && !next);
      status.textContent = `Follow-up page ${previous.length + 1} · ${page.reminders.length} request${page.reminders.length === 1 ? '' : 's'}.`;
    } catch (error) { if (!disposed && current === generation) status.textContent = `Could not load follow-ups. ${message(error)}`; }
    finally { if (!disposed && current === generation) {
      loading = false; pending = undefined; controls();
      if (!busy && restoreAction && focusIsIdle()) focusAction(restoreAction);
    } }
  };
  form.addEventListener('input', () => { dirty = true;controls(); }); form.addEventListener('change', () => { dirty = true;controls(); });
  email.addEventListener('input',() => { recipientEdited = true; });email.addEventListener('change',() => { recipientEdited = true; });
  account.addEventListener('input',() => { senderEdited = true; });account.addEventListener('change',() => { senderEdited = true; });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!selected || busy || disposed) return;
    const time = new Date(when.value).getTime();
    if (!Number.isSafeInteger(time)) { editorStatus.textContent = 'Choose a follow-up date and time.'; return; }
    const target = selected;
    recipientEdited = senderEdited = true;contactStatus.textContent = '';
    void mutate(async () => {
      const reminder = await conn.set( { request_id: target.request.request_id,
        expected_revision: target.reminder.revision, due_at: time, recipient_email: email.value.trim(), sender_mail_instance: account.value,
        ...(link?.value.trim() ? { share_url: link.value.trim() } : {}) });
      if (disposed) return; selected = { request: target.request, reminder }; dirty = false;
      editorStatus.textContent = 'Follow-up saved. You will be reminded when it is due. Email sends still need review.';
    });
  });
  if (opts.autoLoad !== false) void load();
  return { open,isOpen: () => !editor.hidden, update: () => { if (!disposed && !opts.editorOnly) void load(); },
    hasOpenEmail: () => Boolean(composeDialog(compose.state())),
    hasUnsavedChanges: () => dirty || compose.hasUnsavedChanges(),
    hasInFlightWork: () => busy || compose.hasInFlightWork(),
    dispose: () => { disposed = true; generation++; editorGeneration++; compose.destroy(); root.remove(); },
  };
};
