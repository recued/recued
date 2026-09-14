import type { ChatDeliveryItem, ChatDeliveryListRequest, ChatDeliverySnapshot, ChatDeliveryState } from '@recued/contracts';

export interface ChatDeliveryClient {
  (method: 'chat.deliveries.list', args: ChatDeliveryListRequest): Promise<ChatDeliverySnapshot>;
  (method: 'chat.delivery.retry', args: { session_id: string; delivery_id: string; submission_id: string; accept_unknown?: boolean }): Promise<{ ok: true }>;
  (method: 'chat.delivery.skip', args: { session_id: string; delivery_id: string; submission_id: string }): Promise<{ ok: true }>;
  (method: 'chat.messenger.connect', args: { session_id: string; vendor: string }): Promise<{ session_id: string }>;
}

export const CHAT_DELIVERY_STYLES = `
[data-chat-delivery], [data-chat-message-delivery] { font-size: .875rem; overflow-wrap: anywhere; }
[data-chat-delivery] { padding: .75rem; border: 1px solid var(--border, #7775); border-radius: .5rem; }
[data-chat-delivery] p, [data-chat-message-delivery] p { margin: .35rem 0; }
[data-chat-delivery] [data-delivery-id] { padding: .6rem 0; border-top: 1px solid var(--border, #7775); }
[data-chat-delivery] button, [data-chat-message-delivery] button { margin: .25rem .5rem .25rem 0; }
[data-chat-message-delivery] { margin-top: .5rem; }
[data-chat-message-delivery] summary { cursor: pointer; }
[data-delivery-files] { padding-left: 1.25rem; margin: .4rem 0; }
[data-delivery-state="failed"], [data-delivery-state="unknown"] { border-inline-start: 3px solid var(--warning, #b87417); padding-inline-start: .5rem; }
`;

const labels: Record<ChatDeliveryState | 'not_mirrored', string> = {
  pending: 'Waiting to send', sending: 'Sending', failed: 'Delivery failed', unknown: 'Recued does not know if it arrived',
  sent: 'Delivered', skipped: 'Skipped', not_mirrored: 'Not mirrored',
};
const reasons: Record<string, string> = {
  binding_changed: 'the connection or account changed', rate_limited: 'waiting for the rate limit',
  attachment_unavailable: 'the file is gone', attachment_changed: 'the file changed after this message',
  attachment_blocked: 'the file is being checked, or was flagged', attachment_unsupported: 'this connection cannot send files',
  auth: 'check what this connection is allowed to do', invalid_request: 'Messenger refused this part. Check the file size and where it was going',
  network: 'Recued could not confirm Messenger got it', missing_receipt: 'Recued could not confirm Messenger got it',
  restart_after_send: 'it was cut short before Recued could confirm it arrived', delivery_unavailable: 'it could not be delivered',
  reply_target_unavailable: 'Recued cannot confirm the quoted message ever arrived. Sort that out first, or skip this reply',
};
const statusLabel = (item: ChatDeliveryItem): string => {
  if (item.state === 'sent' && item.details?.plan === 'legacy' && item.details.attachments.length) return 'The text arrived. The files did not';
  const state = item.sent_chunks > 0 && item.sent_chunks < item.total_chunks
    ? `Partially delivered (${item.sent_chunks}/${item.total_chunks}) · ${labels[item.state]}` : labels[item.state];
  return item.error ? `${state} · ${reasons[item.error] ?? 'it could not be delivered'}` : state;
};
interface SessionView {
  snapshot?: ChatDeliverySnapshot;
  messages: Map<string, { item: ChatDeliveryItem; revision: number }>;
  checked: Set<string>;
  ids: string[];
  loading?: Promise<void>;
  dirty: boolean;
  unavailable: boolean;
  error?: string;
  history: { open: boolean; cursors: Array<string | undefined>; version: number; page?: ChatDeliverySnapshot };
}

export const createChatDeliveryView = (conn: ChatDeliveryClient, changed: () => void, open: (session: string, message?: string) => void) => {
  const sessions = new Map<string, SessionView>();
  const attempts = new Map<string, { id: string; acceptUnknown: boolean }>();
  const actionErrors = new Map<string, string>();
  const busy = new Set<string>(); const expanded = new Set<string>();
  let selected: string | null = null; let disposed = false;
  const state = (session: string): SessionView => {
    let value = sessions.get(session);
    if (!value) { value = { messages: new Map(), checked: new Set(), ids: [], dirty: false, unavailable: false,
      history: { open: false, cursors: [undefined], version: 0 } }; sessions.set(session, value); }
    return value;
  };
  const refresh = (session: string): Promise<void> => {
    if (disposed) return Promise.resolve();
    const s = state(session);
    if (s.loading) { s.dirty = true; return s.loading; }
    const ids = [...s.ids]; let historyVersion = s.history.version;
    const historyOpen = s.history.open; let cursor = s.history.cursors.at(-1);
    const read = Promise.resolve().then(async () => {
      try {
        const overview = await conn('chat.deliveries.list', { session_id: session, details: true });
        if (!Array.isArray(overview?.deliveries) || !Number.isSafeInteger(overview.revision)) throw new Error('Recued could not read the delivery details');
        if (disposed) return;
        if (s.snapshot && s.snapshot.generation !== overview.generation) {
          s.messages.clear(); s.checked.clear(); s.history.page = undefined;
          s.history.cursors = [undefined]; cursor = undefined; historyVersion = ++s.history.version;
        }
        const adopt = (reply: ChatDeliverySnapshot) => {
          for (const item of reply.deliveries) {
            const previous = s.messages.get(item.message_id);
            if (!previous || reply.revision >= previous.revision) s.messages.set(item.message_id, { item, revision: reply.revision });
          }
        };
        adopt(overview);
        if (!s.snapshot || s.snapshot.generation !== overview.generation || overview.revision >= s.snapshot.revision) s.snapshot = overview;
        const lookups: Array<Promise<ChatDeliverySnapshot>> = [];
        if (overview.details_available) for (let i = 0; i < ids.length; i += 200) {
          lookups.push(conn('chat.deliveries.list', { session_id: session, view: 'messages', details: true, message_ids: ids.slice(i, i + 200) }));
        }
        const [messages, history] = await Promise.all([
          Promise.all(lookups),
          overview.details_available && historyOpen ? conn('chat.deliveries.list', {
            session_id: session, view: 'history', details: true, limit: 25, ...(cursor ? { cursor } : {}),
          }) : Promise.resolve(undefined),
        ]);
        if (disposed) return;
        const replies = [overview, ...messages, ...(history ? [history] : [])];
        if (replies.some(reply => reply.generation !== overview.generation || !Array.isArray(reply.deliveries)
          || !Number.isSafeInteger(reply.revision))) throw new Error('Conversation changed');
        for (const reply of replies) adopt(reply);
        if (overview.details_available) for (const [index, reply] of messages.entries()) {
          for (const id of ids.slice(index * 200, (index + 1) * 200)) {
            s.checked.add(id);
            if (!reply.deliveries.some(item => item.message_id === id) && (s.messages.get(id)?.revision ?? -1) <= reply.revision) s.messages.delete(id);
          }
        }
        if (history && s.history.version === historyVersion) s.history.page = history;
        // A send may commit between the overview and the message/page read.
        // Refresh counts as well as rows instead of mixing their revisions.
        if (replies.some(reply => reply.revision > overview.revision)) s.dirty = true;
        const keep = new Set([...s.ids, ...s.snapshot.deliveries.map(item => item.message_id),
          ...(s.history.page?.deliveries.map(item => item.message_id) ?? [])]);
        for (const id of s.messages.keys()) if (!keep.has(id)) s.messages.delete(id);
        s.unavailable = false;
      } catch { s.unavailable = true; }
      finally {
        s.loading = undefined;
        if (!disposed && selected === session) changed();
        if (s.dirty) { s.dirty = false; void refresh(session); }
      }
    });
    s.loading = read;
    return read;
  };
  const control = (doc: Document, session: string, id: string, label: string, action: () => Promise<unknown>, disabled = false, fallbackFocus?: string) => {
    const button = doc.createElement('button'); button.type = 'button'; button.textContent = label;
    button.setAttribute('data-delivery-control', id); button.disabled = disabled || busy.has(id);
    button.addEventListener('click', () => {
      if (busy.has(id) || button.disabled) return;
      const ownedFocus = doc.activeElement === button;
      busy.add(id); button.disabled = true;
      void action().then(() => { state(session).error = undefined; })
        .catch(() => { state(session).error = 'Recued could not confirm that. Check the status again, then try once more.'; })
        .finally(() => {
          busy.delete(id);
          if (disposed || selected !== session) return;
          const restore = ownedFocus && (doc.activeElement === doc.body || doc.activeElement?.getAttribute('data-delivery-control') === id);
          changed();
          if (restore) {
            const controls = Array.from(doc.querySelectorAll<HTMLElement>('[data-delivery-control]'));
            (controls.find(control => control.getAttribute('data-delivery-control') === id)
              ?? controls.find(control => control.getAttribute('data-delivery-control') === fallbackFocus))?.focus({ preventScroll: true });
          }
        });
    });
    return button;
  };
  const actions = (doc: Document, session: string, item: ChatDeliveryItem, scope: string): HTMLElement => {
    const host = doc.createElement('div');
    if (item.state !== 'failed' && item.state !== 'unknown') return host;
    for (const action of ['retry', 'skip'] as const) {
      const key = `${item.delivery_id}:${action}`;
      const label = action === 'skip' ? 'Skip this delivery' : item.state === 'unknown' ? 'Send again. It may arrive twice' : 'Retry delivery';
      host.append(control(doc, session, `${scope}:${key}`, label, async () => {
        if (busy.has(item.delivery_id)) return;
        actionErrors.delete(item.delivery_id); busy.add(item.delivery_id); changed();
        try {
          const attempt = attempts.get(key) ?? { id: crypto.randomUUID(), acceptUnknown: action === 'retry' && item.state === 'unknown' };
          attempts.set(key, attempt);
          const args = { session_id: session, delivery_id: item.delivery_id, submission_id: attempt.id };
          if (action === 'retry') await conn('chat.delivery.retry', { ...args, ...(attempt.acceptUnknown ? { accept_unknown: true } : {}) });
          else await conn('chat.delivery.skip', args);
          attempts.delete(key);
          await refresh(session);
        } catch {
          actionErrors.set(item.delivery_id, 'Recued could not confirm that. Check where it got to before you try again.');
          await refresh(session);
        } finally { busy.delete(item.delivery_id); }
      }, state(session).unavailable || busy.has(item.delivery_id), scope.startsWith('message:') ? `${scope}:details` : 'history:toggle'));
    }
    const actionError = actionErrors.get(item.delivery_id);
    if (actionError) {
      const error = doc.createElement('p'); error.setAttribute('role', 'alert'); error.textContent = actionError;
      host.append(error, control(doc, session, `${scope}:${item.delivery_id}:refresh`, 'Refresh delivery status', () => refresh(session)));
    }
    return host;
  };
  const describe = (doc: Document, item: ChatDeliveryItem): HTMLElement => {
    const host = doc.createElement('div'); const details = item.details;
    if (!details) return host;
    const text = doc.createElement('p');
    text.textContent = details.plan === 'native' ? 'Received on Messenger.'
      : details.plan === 'legacy' ? 'Only the text was sent. The files were not.'
        : details.text ? `Text: ${details.text.sent_parts}/${details.text.total_parts} parts delivered.` : 'The text has not been sent.';
    host.append(text);
    if (details.attachments.length) {
      const files = doc.createElement('ul'); files.setAttribute('data-delivery-files', '');
      details.attachments.forEach((file, index) => {
        const row = doc.createElement('li');
        row.textContent = `${file.filename ?? `Attachment ${index + 1}`} · ${labels[file.state]}`
          + (file.skipped ? ' · further delivery skipped' : '')
          + (file.error ? ` · ${reasons[file.error] ?? 'it could not be delivered'}` : ''); files.append(row);
      }); host.append(files);
    }
    if (item.state === 'skipped') {
      const note = doc.createElement('p'); note.textContent = 'The parts that arrived are still on Messenger. Nothing else will be sent.'; host.append(note);
    }
    if (details.uncertain_parts && item.state !== 'sending') {
      const note = doc.createElement('p'); note.textContent = `${details.uncertain_parts} part or parts were never confirmed, and may already be on Messenger.`; host.append(note);
    }
    if (details.unavailable) {
      const note = doc.createElement('p'); note.textContent = 'Recued cannot show some of the message or file details.'; host.append(note);
    }
    return host;
  };
  const deliveryRow = (doc: Document, session: string, item: ChatDeliveryItem, scope: string): HTMLElement => {
    const row = doc.createElement('div'); row.setAttribute('data-delivery-id', item.delivery_id); row.setAttribute('data-delivery-state', item.state);
    const message = item.details?.message;
    if (message) {
      const label = `${message.role === 'user' ? 'You' : 'Assistant'}: ${message.snippet || 'Attachment message'}`;
      row.append(control(doc, session, `${scope}:${item.delivery_id}:open`, label, async () => open(session, item.message_id)));
      const time = doc.createElement('time'); time.textContent = new Date(message.ts).toLocaleString(); row.append(time);
    } else row.append(control(doc, session, `${scope}:${item.delivery_id}:open`, 'Go to message', async () => open(session, item.message_id)));
    const status = doc.createElement('p'); status.textContent = statusLabel(item);
    row.append(status, describe(doc, item), actions(doc, session, item, scope));
    return row;
  };
  const render = (doc: Document, session: string): HTMLElement | null => {
    if (selected !== session) {
      if (selected) sessions.delete(selected);
      expanded.clear(); actionErrors.clear(); selected = session; void refresh(session);
    }
    const s = state(session); const snapshot = s.snapshot;
    if (!snapshot || (!snapshot.binding && !snapshot.available)) return null;
    const root = doc.createElement('section'); root.setAttribute('aria-label', 'Keeping Messenger up to date'); root.setAttribute('data-chat-delivery', '');
    const summary = doc.createElement('p'); root.append(summary);
    if (snapshot.binding) {
      summary.textContent = `New messages sync to ${snapshot.binding.vendor} · ${snapshot.binding.recipient}`;
      summary.title = `Connected account: ${snapshot.binding.account}`;
      if (snapshot.binding.thread_id) summary.textContent += ` · thread ${snapshot.binding.thread_id}`;
      if (!snapshot.pending_count && !s.unavailable) {
        const status = doc.createElement('p'); status.textContent = snapshot.skipped_count > 0
          ? 'All caught up. Some were skipped, so Messenger may be missing messages or files.' : 'Delivery caught up.'; root.append(status);
      }
      const pending = snapshot.deliveries.map(item => s.messages.get(item.message_id)?.item ?? item).filter(item => item.state !== 'sent' && item.state !== 'skipped');
      for (const item of pending.slice(0, 5)) root.append(deliveryRow(doc, session, item, 'overview'));
      if (snapshot.pending_count > 5) { const more = doc.createElement('p'); more.textContent = `${snapshot.pending_count - 5} more messages waiting`; root.append(more); }
      if (snapshot.details_available) {
        root.append(control(doc, session, 'history:toggle', s.history.open ? 'Hide delivery history' : 'Delivery history', async () => {
          s.history.open = !s.history.open; s.history.version++; s.history.cursors = [undefined]; s.history.page = undefined;
          changed(); if (s.history.open) await refresh(session);
        }));
        if (s.history.open) {
          const history = doc.createElement('section'); history.setAttribute('aria-label', 'Delivery history'); history.setAttribute('data-delivery-history', '');
          const page = s.history.page;
          const heading = doc.createElement('p'); heading.textContent = page ? `Delivery history · page ${s.history.cursors.length} · newest first` : 'Loading delivery history…'; history.append(heading);
          for (const item of page?.deliveries ?? []) history.append(deliveryRow(doc, session, s.messages.get(item.message_id)?.item ?? item, 'history'));
          if (page && !page.deliveries.length) { const empty = doc.createElement('p'); empty.textContent = 'Nothing on this page.'; history.append(empty); }
          const navigate = async (cursors: Array<string | undefined>) => {
            s.history.cursors = cursors; s.history.version++; s.history.page = undefined; changed(); await refresh(session);
          };
          if (s.history.cursors.length > 1) history.append(control(doc, session, 'history:newer', 'Newer deliveries', () => navigate(s.history.cursors.slice(0, -1)), !!s.loading));
          if (page?.next_cursor) history.append(control(doc, session, 'history:older', 'Older deliveries', () => navigate([...s.history.cursors, page.next_cursor]), !!s.loading));
          history.append(control(doc, session, 'history:latest', 'Latest deliveries', () => navigate([undefined]), !!s.loading));
          root.append(history);
        }
      }
    } else if (snapshot.available) {
      const available = snapshot.available;
      summary.textContent = `This saved chat is not linked to the current ${available.vendor} account.`;
      if (available.linked_session_id) root.append(control(doc, session, 'connect:open', 'Open current Messenger chat', async () => open(available.linked_session_id!)));
      else root.append(control(doc, session, 'connect:new', `Sync new messages to ${available.vendor} · ${available.recipient}`, async () => {
        await conn('chat.messenger.connect', { session_id: session, vendor: available.vendor }); await refresh(session);
      }));
    }
    if (s.unavailable) {
      const status = doc.createElement('p'); status.setAttribute('role', 'alert'); status.textContent = 'Recued cannot tell you where this got to.';
      root.append(status, control(doc, session, 'refresh', 'Refresh delivery status', () => refresh(session)));
    }
    if (s.error) { const error = doc.createElement('p'); error.setAttribute('role', 'alert'); error.textContent = s.error; root.append(error); }
    return root;
  };
  return { render, refresh,
    setMessages(session: string, ids: string[]) {
      const s = state(session);
      if (ids.length === s.ids.length && ids.every((id, i) => id === s.ids[i])) return;
      s.ids = ids;
      const keep = new Set(ids);
      for (const id of s.checked) if (!keep.has(id)) s.checked.delete(id);
      void refresh(session);
    },
    renderMessage(doc: Document, session: string, id: string): HTMLElement | null {
      const s = state(session);
      if (!s.snapshot?.binding || !s.snapshot.details_available) return null;
      const item = s.messages.get(id)?.item;
      if (!item) {
        const note = doc.createElement('p'); note.textContent = s.unavailable ? 'Recued cannot reach Messenger.'
          : s.checked.has(id) ? 'Recued has no note of this message being sent to Messenger.' : 'Checking Messenger delivery…'; return note;
      }
      const root = doc.createElement('details'); const key = `${session}:${id}`;
      root.open = expanded.has(key); root.setAttribute('data-message-delivery-state', item.state);
      const summary = doc.createElement('summary'); summary.setAttribute('data-delivery-control', `message:${id}:details`);
      summary.textContent = `Messenger · ${s.unavailable ? 'Recued cannot check now. Last it knew: ' : ''}${statusLabel(item)}`;
      root.append(summary);
      root.addEventListener('toggle', () => { if (root.open) expanded.add(key); else expanded.delete(key); });
      root.append(describe(doc, item), actions(doc, session, item, `message:${id}`));
      return root;
    },
    ready: (session: string) => state(session).loading ?? refresh(session),
    dispose() { disposed = true; sessions.clear(); attempts.clear(); actionErrors.clear(); busy.clear(); expanded.clear(); },
  };
};
