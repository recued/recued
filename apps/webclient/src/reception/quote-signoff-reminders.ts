import { composeDialog, type Conn, type ServerRpcRegistry, type QuoteSignoffReminder, type QuoteSignoffSummary } from '@recued/contracts';
import { FORM_RENDERER_STYLES, MAIL_COMPOSE_STYLES } from '@recued/ui-shared';
import { mountMailCompose, type MailComposeDeps } from '../mail/mail-compose-host.js';

export type QuoteSignoffReminderConn = Conn<Pick<ServerRpcRegistry,
  'reception.signoff.reminders.get' | 'reception.signoff.reminders.set'
  | 'reception.signoff.reminders.list' | 'reception.signoff.reminders.draft'>>;
export type QuoteSignoffReminderOptions = { mail: MailComposeDeps; now?: () => number };

/** The editor lives outside the polled request cards, so refresh cannot erase
 * owner edits. Saving a draft is private; the shared mail composer owns Send. */
export const mountQuoteSignoffReminders = (opts: QuoteSignoffReminderOptions & {
  host: HTMLElement; document: Document; conn: QuoteSignoffReminderConn;
}) => {
  const { document: doc, conn } = opts; const now = opts.now ?? Date.now;
  const root = doc.createElement('section'); root.setAttribute('data-signoff-reminders', ''); opts.host.appendChild(root);
  const add = (tag: string, text: string, host: HTMLElement = root) => {
    const element = doc.createElement(tag); element.textContent = text; host.appendChild(element); return element;
  };
  add('h3', 'Customer follow-ups');
  add('p', 'Set a date to follow up on an unanswered offer. Email reminders become saved drafts for you to review.');
  const status = add('p', 'Loading follow-ups…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = add('div', ''); actions.className = 'signoff-actions';
  const button = (text: string, host: HTMLElement, click: () => void) => {
    const node = doc.createElement('button'); node.type = 'button'; node.textContent = text;
    node.addEventListener('click', click); host.appendChild(node); return node;
  };
  const refresh = button('Refresh follow-ups', actions, () => { void load(); });
  const queue = add('div', ''); queue.setAttribute('data-signoff-reminder-queue', '');
  const pages = add('div', ''); pages.className = 'signoff-actions';
  const newer = button('Earlier follow-ups', pages, () => {
    if (!busy && !loading && previous.length) void load({ cursor: previous.at(-1), previous: previous.slice(0, -1) });
  });
  const older = button('More follow-ups', pages, () => {
    if (!busy && !loading && next) void load({ cursor: next, previous: [...previous, cursor] });
  });
  const editor = add('div', ''); editor.hidden = true; editor.setAttribute('data-signoff-reminder-editor', '');
  const heading = add('h3', '', editor);
  const editorStatus = add('p', '', editor); editorStatus.setAttribute('role', 'status'); editorStatus.setAttribute('aria-live', 'polite');
  const form = doc.createElement('form'); editor.appendChild(form);
  const field = (name: string, label: string, type: string) => {
    const wrap = add('label', label, form); const input = doc.createElement('input'); input.type = type;
    input.setAttribute('name', name); wrap.appendChild(input); return input;
  };
  const when = field('reminder_due_at', 'Follow-up time (your device timezone)', 'datetime-local'); when.required = true;
  const email = field('reminder_recipient', 'Customer email (optional)', 'email'); email.maxLength = 254;
  const accountLabel = add('label', 'Mail account (optional)', form);
  const account = doc.createElement('select'); account.setAttribute('name', 'reminder_account'); accountLabel.appendChild(account);
  const link = field('reminder_link', 'Offer link (paste it here for an older request)', 'url'); link.maxLength = 2048;
  const save = doc.createElement('button'); save.type = 'submit'; save.textContent = 'Save follow-up'; form.appendChild(save);
  const close = button('Close follow-up', editor, () => { if (!busy) { editor.hidden = true; selected = null; dirty = false; editorGeneration++; } });
  const composeHost = add('div', '');
  const style = doc.createElement('style'); style.textContent = `${FORM_RENDERER_STYLES}\n${MAIL_COMPOSE_STYLES}`; composeHost.appendChild(style);
  const compose = mountMailCompose(composeHost, opts.mail);
  let disposed = false; let generation = 0; let editorGeneration = 0;
  let loading = false; let busy = false; let dirty = false;
  let cursor: string | undefined; let next: string | undefined; let previous: Array<string | undefined> = [];
  let pending: { cursor?: string; previous: Array<string | undefined> } | undefined;
  let selected: { signoff: QuoteSignoffSummary; reminder: QuoteSignoffReminder } | null = null;
  let rowButtons: HTMLButtonElement[] = [];
  const message = (error: unknown) => error instanceof Error ? error.message : 'The follow-up could not be loaded. Try again.';
  const controls = () => {
    refresh.disabled = busy || loading; newer.disabled = busy || loading || previous.length === 0;
    older.disabled = busy || loading || !next;
    rowButtons.forEach(node => { node.disabled = busy; });
    [when, email, account, link, save, close].forEach(node => { node.disabled = busy; });
  };
  const mutate = async (body: () => Promise<void>) => {
    if (busy || disposed) return; busy = true; controls();
    try { await body(); if (!disposed) await load(); }
    catch (error) { if (!disposed) { status.textContent = message(error); editorStatus.textContent = message(error); } }
    finally { if (!disposed) { busy = false; controls(); } }
  };
  const localDate = (instant: number) => {
    const date = new Date(instant); const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const open = async (signoff: QuoteSignoffSummary) => {
    if (disposed || busy || compose.hasInFlightWork()) return;
    if (dirty) {
      editorStatus.textContent = 'Save or close this follow-up before opening another.'; return;
    }
    const current = ++editorGeneration;
    editor.hidden = false; editorStatus.textContent = 'Loading follow-up…';
    heading.textContent = `Follow up — ${signoff.customer} — ${signoff.quote_label}`;
    selected = null; when.value = ''; email.value = ''; link.value = ''; account.replaceChildren();
    busy = true; controls();
    try {
      const [reminderResult, mailResult] = await Promise.allSettled([
        conn('reception.signoff.reminders.get', { signoff_id: signoff.signoff_id }), opts.mail.listMailInstances(),
      ]);
      if (disposed || current !== editorGeneration) return;
      if (reminderResult.status === 'rejected') throw reminderResult.reason;
      const reminder = reminderResult.value;
      selected = { signoff, reminder }; dirty = false;
      when.value = localDate(reminder.due_at ?? Math.min(now() + 86_400_000, signoff.expires_at - 60_000));
      email.value = reminder.recipient_email ?? ''; link.value = '';
      account.replaceChildren(); const empty = doc.createElement('option'); empty.value = ''; empty.textContent = 'Owner reminder only'; account.appendChild(empty);
      const senders = mailResult.status === 'fulfilled' ? mailResult.value.instances.filter(row => row.send_capable) : [];
      for (const row of senders) { const option = doc.createElement('option'); option.value = row.slug;
        option.textContent = row.account_email || row.slug; account.appendChild(option); }
      if (reminder.sender_mail_instance && !senders.some(row => row.slug === reminder.sender_mail_instance)) {
        const missing = doc.createElement('option'); missing.value = reminder.sender_mail_instance;
        missing.textContent = `${reminder.sender_mail_instance} (unavailable)`; account.appendChild(missing);
      }
      account.value = reminder.sender_mail_instance ?? '';
      editorStatus.textContent = reminder.has_saved_link ? 'The active offer link is saved. Leave the link field blank to keep it.'
        : 'For an email reminder, paste the active offer link. You can save an owner reminder without email settings.';
      if (mailResult.status === 'rejected') editorStatus.textContent += ' Mail accounts could not be loaded; owner reminders remain available.';
    } catch (error) { if (!disposed && current === editorGeneration) { selected = null; editorStatus.textContent = message(error); } }
    finally { if (!disposed && current === editorGeneration) { busy = false; controls(); if (selected) when.focus(); } }
  };
  const draft = async (signoff: QuoteSignoffSummary, reminder: QuoteSignoffReminder) => {
    await mutate(async () => {
      if (!opts.mail.drafts) throw new Error('Saved email drafts are unavailable. Open Mail to configure them.');
      if (compose.hasUnsavedChanges() || composeDialog(compose.state())) throw new Error('Close the email you have open before reviewing another reminder.');
      const prepared = await conn('reception.signoff.reminders.draft', { signoff_id: signoff.signoff_id, expected_revision: reminder.revision });
      if (disposed) return;
      const saved = await opts.mail.drafts.create(prepared);
      if (disposed) return;
      await compose.refresh();
      if (disposed) return;
      if (!await compose.openSaved(saved.draft_id)) throw new Error('The draft is saved in Mail. Close your current email before opening it.');
      status.textContent = 'Reminder draft saved. Review it and choose Send; Recued uses your normal mail approval controls.';
    });
  };
  const load = async (page: { cursor?: string; previous: Array<string | undefined> } = pending ?? { cursor, previous: [...previous] }) => {
    const requestedCursor = page.cursor; const requestedPrevious = page.previous;
    const current = ++generation; pending = page;
    loading = true; controls();
    try {
      const page = await conn('reception.signoff.reminders.list', { limit: 50, ...(requestedCursor ? { cursor: requestedCursor } : {}) });
      if (disposed || current !== generation) return;
      cursor = requestedCursor; previous = [...requestedPrevious]; next = page.next_cursor;
      queue.replaceChildren(); rowButtons = [];
      for (const { signoff, reminder } of page.reminders) {
        const card = add('article', '', queue); card.setAttribute('data-reminder-signoff-id', signoff.signoff_id);
        add('h4', `${signoff.customer} — ${signoff.quote_reference ?? signoff.quote_label}`, card);
        add('p', `${reminder.status === 'due' ? 'Follow-up due' : 'Follow-up scheduled'}: ${new Date(reminder.due_at!).toLocaleString()}.`, card);
        if (reminder.delivery === 'uncertain') add('p', 'The previous email outcome is unknown. Review it in Mail before preparing another.', card);
        else if (reminder.delivery === 'draft_ready') add('p', 'A reminder draft is ready to review in Mail.', card);
        const rowActions = add('div', '', card); rowActions.className = 'signoff-actions';
        rowButtons.push(button('Edit follow-up', rowActions, () => { void open(signoff); }));
        rowButtons.push(button('Snooze 1 day', rowActions, () => { void mutate(async () => {
          await conn('reception.signoff.reminders.set', { signoff_id: signoff.signoff_id,
            expected_revision: reminder.revision, due_at: Math.max(now(), reminder.due_at!) + 86_400_000 });
        }); }));
        rowButtons.push(button('Pause follow-up', rowActions, () => { void mutate(async () => {
          await conn('reception.signoff.reminders.set', { signoff_id: signoff.signoff_id, expected_revision: reminder.revision, due_at: null });
        }); }));
        if (reminder.status === 'due' && reminder.delivery !== 'uncertain' && reminder.recipient_email && reminder.sender_mail_instance && reminder.has_saved_link) {
          rowButtons.push(button('Review reminder email', rowActions, () => { void draft(signoff, reminder); }));
        }
      }
      if (!page.reminders.length) add('p', 'No follow-ups on this page. Set a follow-up on a request waiting for its customer.', queue);
      status.textContent = `Follow-up page ${previous.length + 1} · ${page.reminders.length} request${page.reminders.length === 1 ? '' : 's'}.`;
    } catch (error) { if (!disposed && current === generation) status.textContent = `Could not load follow-ups. ${message(error)}`; }
    finally { if (!disposed && current === generation) { loading = false; pending = undefined; controls(); } }
  };
  form.addEventListener('input', () => { dirty = true; }); form.addEventListener('change', () => { dirty = true; });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!selected || busy || disposed) return;
    const time = new Date(when.value).getTime();
    if (!Number.isSafeInteger(time)) { editorStatus.textContent = 'Choose a follow-up date and time.'; return; }
    const target = selected;
    void mutate(async () => {
      const reminder = await conn('reception.signoff.reminders.set', { signoff_id: target.signoff.signoff_id,
        expected_revision: target.reminder.revision, due_at: time, recipient_email: email.value.trim(), sender_mail_instance: account.value,
        ...(link.value.trim() ? { share_url: link.value.trim() } : {}) });
      if (disposed) return; selected = { signoff: target.signoff, reminder }; dirty = false;
      editorStatus.textContent = 'Follow-up saved. You will be reminded when it is due. Email sends still need review.';
    });
  });
  void load();
  return { open, update: () => { if (!disposed) void load(); },
    hasUnsavedChanges: () => dirty || compose.hasUnsavedChanges(),
    hasInFlightWork: () => busy || compose.hasInFlightWork(),
    dispose: () => { disposed = true; generation++; editorGeneration++; compose.destroy(); root.remove(); },
  };
};
