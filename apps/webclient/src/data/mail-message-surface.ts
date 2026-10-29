import type {
  CollectionRecord, MailConversationItem, MailConversationRequest, MailConversationSnapshot,
  MailMessageRef, MailMessageSnapshot,
} from '@recued/contracts';
import { e, formatClientDateTime, MAIL_COMPOSE_STYLES } from '@recued/ui-shared';
import { mountMailCompose, type MailComposeDeps, type MailComposeMount } from '../mail/mail-compose-host.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { COLLECTION_DETAIL_HEADING_ATTR } from './collection-explorer.js';

export interface MailMessageCallers {
  get?: (ref: MailMessageRef) => Promise<MailMessageSnapshot>;
  conversation?: (ref: MailConversationRequest) => Promise<MailConversationSnapshot>;
}
interface MailConversationScroll {
  slug: string;
  thread_id: string | null;
  incarnation: string | null;
  top: number;
  anchor: { record_id: string; offset: number } | null;
}

export const MAIL_MESSAGE_STYLES = `
.data-mail-conversation { min-width: 0; display: grid; gap: 18px; }
.data-mail-conversation-head { display: grid; gap: 8px; }
.data-mail-conversation-heading { display: flex; align-items: start; justify-content: space-between; gap: 16px; }
.data-mail-conversation-heading h2 { margin: 0; font-size: 1.3rem; line-height: 1.4; overflow-wrap: anywhere; }
.data-mail-conversation-heading .data-button { flex: none; }
.data-mail-conversation-layout { min-width: 0; display: grid; grid-template-columns: minmax(150px, 210px) minmax(0, 1fr); gap: 20px; align-items: start; }
.data-mail-conversation-index { position: sticky; top: 16px; display: grid; gap: 5px; max-height: 70vh; overflow-y: auto; }
.data-mail-conversation-index button { text-align: left; display: grid; gap: 5px; width: 100%; padding: 10px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--fg); font: inherit; font-size: 13px; cursor: pointer; }
.data-mail-conversation-index button[aria-current="true"] { border-color: var(--border); background: var(--surface-sunk); box-shadow: inset 3px 0 var(--accent); }
.data-mail-conversation-index strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.data-mail-conversation-index span { color: var(--fg-muted); font-size: 12px; }
.data-mail-conversation-messages { min-width: 0; display: grid; gap: 12px; }
.data-mail-conversation-card { scroll-margin-top: 16px; min-width: 0; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--surface); }
.data-mail-conversation-card.is-selected { box-shadow: inset 3px 0 var(--accent); }
.data-mail-conversation-toggle { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; padding: 14px 16px; width: 100%; border: 0; background: transparent; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
.data-mail-conversation-toggle:hover, .data-mail-conversation-index button:hover { background: var(--surface-sunk); }
.data-mail-conversation-toggle strong { font-size: 14px; overflow-wrap: anywhere; }
.data-mail-conversation-toggle time { font-size: 12px; color: var(--fg-muted); }
.data-mail-conversation-subject { grid-column: 1 / -1; font-size: 14px; overflow-wrap: anywhere; }
.data-mail-conversation-preview { grid-column: 1 / -1; color: var(--fg-muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.data-mail-conversation-labels { color: var(--fg-muted); font-size: 12px; overflow-wrap: anywhere; }
.data-mail-conversation-card .data-mail-message { padding: 4px 16px 18px; }
.data-mail-message { display: grid; gap: 16px; min-width: 0; }
.data-mail-message dl { display: grid; grid-template-columns: auto minmax(0,1fr); gap: 6px 16px; margin: 0; font-size: 14px; }
.data-mail-message dt { color: var(--fg-muted); }
.data-mail-message dd { margin: 0; overflow-wrap: anywhere; }
.data-mail-message pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.65; }
.data-mail-message-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.data-mail-message-note { margin: 0; color: var(--fg-muted); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.data-mail-conversation-older { justify-self: start; }
@media (max-width: 720px) {
  .data-mail-conversation-layout { grid-template-columns: minmax(0, 1fr); }
  .data-mail-conversation-index { display: none; }
  .data-mail-conversation-heading { flex-wrap: wrap; gap: 10px; }
  .data-mail-conversation-heading h2 { font-size: 1.15rem; }
  .data-mail-conversation-toggle { padding: 14px 12px; grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .data-mail-conversation-card .data-mail-message { padding: 4px 12px 16px; }
  .data-mail-message dl { gap: 8px 12px; font-size: 13px; }
  .data-mail-message-actions .data-button, .data-mail-conversation-heading .data-button, .data-mail-conversation-older { min-height: 42px; }
}
`;

export const createMailMessageSurface = (opts: {
  document: Document;
  callers: MailMessageCallers;
  compose?: MailComposeDeps;
  actionAttr: string;
  onSelectedRecord?(slug: string, record: CollectionRecord): void;
  render(): void;
}) => {
  let anchor: MailMessageRef | null = null;
  let ref: MailMessageRef | null = null;
  let conversation: MailConversationSnapshot | null = null;
  let messages: MailConversationItem[] = [];
  let snapshot: MailMessageSnapshot | null = null;
  let expanded = true, olderLoaded = false;
  let loading = false, opening = false, refreshing = false, olderLoading = false;
  let error: string | null = null, conversationError: string | null = null;
  let notice = '';
  let generation = 0, readGeneration = 0;
  let disposed = false;
  let portal: HTMLElement | null = null;
  let compose: MailComposeMount | null = null;
  let composeWasOpen = false;
  const action = (name: string): string => `${opts.actionAttr}="mail-message-${name}"`;
  const busy = (pending: boolean): string => pending ? ' aria-disabled="true" aria-busy="true"' : '';
  const paint = (): void => opts.render();
  const focusReply = (): void => {
    opts.document.querySelector<HTMLButtonElement>(`[${opts.actionAttr}="mail-message-reply"]`)?.focus();
  };
  const beforeLeave = (): boolean => {
    if (compose?.state().dialog) { portal?.querySelector<HTMLElement>('[data-mail-compose-ai-brief]')?.focus(); return false; }
    return true;
  };
  const ensureCompose = (): MailComposeMount | null => {
    if (!opts.compose) return null;
    if (compose) return compose;
    if (!opts.document.head.querySelector('[data-mail-reply-compose-styles]')) {
      const style = opts.document.createElement('style');
      style.setAttribute('data-mail-reply-compose-styles', ''); style.textContent = MAIL_COMPOSE_STYLES;
      opts.document.head.appendChild(style);
    }
    portal = opts.document.createElement('div');
    portal.setAttribute('data-mail-reply-compose-portal', '');
    opts.document.body.appendChild(portal);
    compose = mountMailCompose(portal, { ...opts.compose, onStateChanged: () => {
      opts.compose?.onStateChanged?.();
      const isOpen = compose?.state().dialog != null;
      if (composeWasOpen && !isOpen && !disposed) {
        const outcome = compose?.lastOutcome();
        if (outcome) { notice = outcome === 'held' ? 'Reply is waiting for approval.' : 'Reply sent.'; paint(); }
        focusReply();
      }
      composeWasOpen = isOpen;
    } });
    return compose;
  };
  const scoped = (id: string): MailMessageRef => ({ slug: anchor!.slug, record_id: id,
    ...(conversation?.incarnation ? { conversation: { thread_id: conversation.thread_id, incarnation: conversation.incarnation } } : {}),
  });
  const syncSelectedRecord = (): void => {
    const selected = messages.find(message => message.record_id === ref?.record_id);
    if (!selected || !ref || !conversation) return;
    opts.onSelectedRecord?.(ref.slug, {
      record_id: selected.record_id, source_id: selected.source_id, received_at: selected.received_at,
      modified_at: selected.modified_at, size_bytes: selected.size_bytes,
      hot_fields: { from: selected.from, to: selected.to, subject: selected.subject,
        thread_id: conversation.thread_id, direction: selected.direction, folder: selected.folder,
        is_read: selected.is_read, has_attachments: selected.has_attachments },
    });
  };
  const acceptMessage = (result: MailMessageSnapshot, current: MailMessageRef): void => {
    if (result.slug !== current.slug || result.record_id !== current.record_id) throw new Error('The email changed. Refresh the conversation before continuing.');
    snapshot = result;
  };
  const read = async (): Promise<void> => {
    if (!ref || !opts.callers.get) return;
    const current = ref, root = generation, request = ++readGeneration;
    loading = true; error = null; paint();
    try {
      const result = await opts.callers.get(current);
      if (disposed || root !== generation || request !== readGeneration) return;
      acceptMessage(result, current);
    } catch (err) { if (!disposed && root === generation && request === readGeneration) error = humanizeRpcError(err); }
    finally { if (!disposed && root === generation && request === readGeneration) { loading = false; paint(); } }
  };
  const merge = (items: MailConversationItem[]): void => {
    const unique = new Map(messages.map(message => [message.record_id, message]));
    for (const message of items) unique.set(message.record_id, message);
    messages = [...unique.values()].sort((a, b) => a.received_at - b.received_at || (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0));
  };
  const loadConversation = async (older = false): Promise<void> => {
    if (!anchor || !opts.callers.conversation || refreshing || olderLoading) return;
    const current = !older && conversation && ref ? { slug: ref.slug, record_id: ref.record_id } : anchor, root = generation;
    const prior = conversation;
    if (older) olderLoading = true; else refreshing = true;
    // Keep the retry control mounted while its request is pending.
    if (prior) conversationError = null;
    paint();
    try {
      const result = await opts.callers.conversation({ ...current,
        ...(prior ? { expected_thread_id: prior.thread_id, ...(prior.incarnation ? { expected_incarnation: prior.incarnation } : {}) } : {}),
        ...(older && prior?.next_before ? { before: prior.next_before } : {}),
      });
      if (disposed || root !== generation) return;
      if (result.slug !== current.slug || result.anchor.record_id !== current.record_id
        || prior && (result.thread_id !== prior.thread_id || result.incarnation !== prior.incarnation)) {
        throw new Error('The conversation changed. Open it again from Mail.');
      }
      // A selection made while metadata was refreshing wins over the older
      // request's anchor, including an email outside the latest page. Its body
      // read still verifies membership and mailbox incarnation before display.
      const retainedSelection = !older ? messages.find(message => message.record_id === ref?.record_id
        && message.record_id !== current.record_id) : undefined;
      anchor = current; conversation = result; olderLoaded = older; conversationError = null;
      if (!older) messages = [];
      merge([...(retainedSelection ? [retainedSelection] : []), ...result.messages, result.anchor]);
      if (!messages.some(message => message.record_id === ref?.record_id)) ref = scoped(current.record_id);
      else ref = scoped(ref!.record_id);
      syncSelectedRecord();
      if (!older) { snapshot = null; notice = ''; void read(); }
    } catch (err) {
      if (disposed || root !== generation) return;
      const code = (err as { code?: string } | null)?.code;
      conversationError = !prior && (code === 'unknown_method' || code === 'method_not_found') ? null : humanizeRpcError(err);
      // History is optional for reading the independently verified anchor.
      // Never replace an already-scoped conversation with an unscoped read.
      if (!prior) void read();
    } finally {
      if (!disposed && root === generation) { refreshing = false; olderLoading = false; paint(); }
    }
  };
  const open = async (next: MailMessageRef): Promise<void> => {
    if (!opts.callers.get) return;
    generation++; readGeneration++;
    anchor = { slug: next.slug, record_id: next.record_id }; ref = anchor;
    conversation = null; messages = []; snapshot = null; expanded = true; olderLoaded = false;
    loading = false; opening = false; refreshing = false; olderLoading = false;
    error = null; conversationError = null; notice = '';
    if (opts.callers.conversation) await loadConversation(); else await read();
  };
  const select = (id: string, toggle: boolean): void => {
    if (!anchor || !messages.some(message => message.record_id === id) || !beforeLeave() || opening) return;
    if (ref?.record_id === id) { expanded = toggle ? !expanded : true; paint(); return; }
    ref = scoped(id); snapshot = null; notice = ''; expanded = true;
    syncSelectedRecord(); void read();
  };
  const reply = async (): Promise<void> => {
    if (!ref || !snapshot?.reply || !opts.callers.get || opening || loading || refreshing || compose?.state().dialog) return;
    const host = ensureCompose(); if (!host) return;
    const current = ref, root = generation, request = ++readGeneration;
    opening = true; error = null; notice = ''; paint();
    try {
      const [fresh] = await Promise.all([opts.callers.get(current), host.refresh()]);
      if (disposed || root !== generation || request !== readGeneration) return;
      acceptMessage(fresh, current);
      // A different sending mailbox cannot lend its capability to this reply.
      if (!fresh.reply) error = fresh.reply_unavailable_reason ?? 'Reply is unavailable for this email.';
      else if (fresh.reply.original_source_id !== current.slug || !host.openReply(fresh.reply)) error = 'Sending is unavailable for this mailbox. Check its connection before replying.';
    } catch (err) { if (!disposed && root === generation && request === readGeneration) error = humanizeRpcError(err); }
    finally { if (!disposed && root === generation && request === readGeneration) { opening = false; paint(); } }
  };
  const renderMessage = (): string => {
    const controls = `<div class="data-mail-message-actions">${snapshot?.reply && opts.compose
      ? `<button type="button" class="data-button" data-mail-focus="reply" ${action('reply')}${busy(loading || opening || refreshing)}>${opening ? 'Checking reply…' : 'Reply'}</button>` : ''}
      <button type="button" class="data-button" data-mail-focus="refresh" ${action('refresh')}${busy(loading || opening || refreshing)}>Refresh email</button></div>`;
    return `<article class="data-mail-message" aria-label="Email message" aria-busy="${loading}">
      ${controls}${loading ? '<p role="status">Reading email…</p>' : ''}${error ? `<p role="alert" tabindex="-1" data-mail-focus="error">${e(error)}</p>` : ''}
      ${notice ? `<p role="status">${e(notice)}</p>` : ''}
      ${snapshot ? `<dl><dt>From</dt><dd>${e(snapshot.from)}</dd><dt>To</dt><dd>${e(snapshot.to.join(', '))}</dd>
        ${snapshot.cc.length ? `<dt>Cc</dt><dd>${e(snapshot.cc.join(', '))}</dd>` : ''}</dl>
      ${snapshot.reply_unavailable_reason ? `<p class="data-mail-message-note">${e(snapshot.reply_unavailable_reason)}</p>` : ''}
      ${snapshot.read === 'stored' ? '<p class="data-mail-message-note">Showing the stored copy.</p>' : ''}
      ${snapshot.body_truncated ? '<p role="status" class="data-mail-message-note">Showing the beginning of this long email. AI reply drafting is unavailable for a partial message.</p>' : ''}
      ${snapshot.body === null ? '<p role="status">The email body is unavailable.</p>' : `<pre>${e(snapshot.body || '(Empty message)')}</pre>`}` : ''}
    </article>`;
  };
  return {
    open,
    hasSnapshot: () => ref !== null,
    render: (): string => {
      if (!opts.callers.get || !ref) return '';
      if (!conversation) return `<section class="data-mail-conversation">
        ${snapshot ? `<h2 ${COLLECTION_DETAIL_HEADING_ATTR} tabindex="-1">${e(snapshot.subject || '(No subject)')}</h2>` : ''}
        ${refreshing ? '<p role="status">Loading conversation…</p>' : ''}
        ${conversationError ? `<p role="alert">${e(conversationError)}</p><button type="button" class="data-button" data-mail-focus="conversation-refresh" ${action('conversation-refresh')}${busy(refreshing)}>Retry conversation</button>` : ''}
        ${renderMessage()}
      </section>`;
      const subject = conversation.anchor.subject;
      const label = (message: MailConversationItem): string => message.direction === 'outbound' ? 'Sent' : message.direction === 'inbound' ? 'Received' : 'Email';
      const sender = (message: MailConversationItem): string => message.direction === 'outbound' ? `You${message.to.length ? ` → ${message.to.slice(0, 2).join(', ')}${message.to.length > 2 ? ` +${message.to.length - 2} more` : ''}` : ''}` : message.from || 'Unknown sender';
      return `<section class="data-mail-conversation" aria-label="Email conversation">
        <header class="data-mail-conversation-head">
          <div class="data-mail-conversation-heading"><h2 ${COLLECTION_DETAIL_HEADING_ATTR} tabindex="-1">${e(conversation.anchor.subject || '(No subject)')}</h2>
          <button type="button" class="data-button" data-mail-focus="conversation-refresh" ${action('conversation-refresh')}${busy(refreshing || olderLoading || opening)}>${refreshing ? 'Refreshing…' : 'Refresh conversation'}</button></div>
          <p class="data-mail-message-note">${e(conversation.mailbox_address)} · ${messages.length} loaded ${messages.length === 1 ? 'message' : 'messages'}</p>
          <p class="data-mail-message-note">${conversation.thread_id === null ? 'No conversation ID is available. Showing this email only.' : 'Showing synced messages from this mailbox. Earlier or unsynced messages may be missing.'}</p>
        </header>
        ${conversationError ? `<p role="alert">${e(conversationError)}</p>` : ''}
        ${conversation.next_before ? `<button type="button" class="data-button data-mail-conversation-older" data-mail-focus="older" ${action('older')}${busy(olderLoading || refreshing || opening)}>${olderLoading ? 'Loading older messages…' : 'Load older messages'}</button>` : olderLoaded ? '<p class="data-mail-message-note" role="status" tabindex="-1" data-mail-focus="older">All available synced messages are loaded.</p>' : ''}
        <div class="data-mail-conversation-layout">
          <nav class="data-mail-conversation-index" aria-label="Messages in this conversation">${messages.map(message => `<button type="button" ${action('select')} data-mail-record="${e(message.record_id)}" data-mail-focus="index:${e(message.record_id)}" aria-current="${ref!.record_id === message.record_id}"><strong>${e(sender(message))}</strong><span>${label(message)} · ${e(formatClientDateTime(message.received_at))}</span></button>`).join('')}</nav>
          <div class="data-mail-conversation-messages">${messages.map((message, index) => {
            const selected = message.record_id === ref!.record_id, isOpen = selected && expanded;
            return `<section class="data-mail-conversation-card${selected ? ' is-selected' : ''}">
              <button type="button" class="data-mail-conversation-toggle" ${action('toggle')} data-mail-record="${e(message.record_id)}" data-mail-focus="card:${e(message.record_id)}" aria-expanded="${isOpen}" aria-controls="mail-message-panel-${index}">
                <strong>${e(sender(message))}</strong><time>${e(formatClientDateTime(message.received_at))}</time>
                ${message.subject && message.subject !== subject ? `<span class="data-mail-conversation-subject">${e(message.subject)}</span>` : ''}
                <span class="data-mail-conversation-labels">${label(message)}${message.folder && message.folder.toLowerCase() !== label(message).toLowerCase() ? ` · ${e(message.folder)}` : ''}${message.direction !== 'outbound' && !message.is_read ? ' · Unread' : ''}${message.has_attachments ? ' · Attachments' : ''} · ${isOpen ? 'Collapse' : 'Read email'}</span>
                ${!isOpen && message.snippet ? `<span class="data-mail-conversation-preview">${e(message.snippet)}</span>` : ''}
              </button><div id="mail-message-panel-${index}"${isOpen ? '' : ' hidden'}>${isOpen ? renderMessage() : ''}</div>
            </section>`;
          }).join('')}</div>
        </div>
      </section>`;
    },
    handleAction: (name: string, target?: HTMLElement): void => {
      if (name === 'mail-message-refresh' && ref && !opening && !loading && !refreshing && beforeLeave()) void read();
      if (name === 'mail-message-conversation-refresh' && !opening && beforeLeave()) void loadConversation();
      if (name === 'mail-message-older' && conversation?.next_before && !opening && beforeLeave()) void loadConversation(true);
      if (name === 'mail-message-reply') void reply();
      if (name === 'mail-message-select' || name === 'mail-message-toggle') {
        const id = target?.getAttribute('data-mail-record'); if (id) {
          select(id, name === 'mail-message-toggle');
          if (name === 'mail-message-select') opts.document.querySelector('.data-mail-conversation-card.is-selected')?.scrollIntoView({ block: 'start' });
        }
      }
    },
    // The index scrolls independently of the reading area. Keep its first
    // visible message in place when a route repaint replaces the DOM.
    captureScroll: (root: HTMLElement): MailConversationScroll | null => {
      if (!conversation) return null;
      const index = root.querySelector<HTMLElement>('.data-mail-conversation-index');
      if (!index || index.clientHeight === 0) return null;
      const bounds = index.getBoundingClientRect();
      let anchor: MailConversationScroll['anchor'] = null;
      for (const button of index.querySelectorAll<HTMLElement>('[data-mail-record]')) {
        const rect = button.getBoundingClientRect();
        if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
          anchor = { record_id: button.getAttribute('data-mail-record')!, offset: rect.top - bounds.top };
          break;
        }
      }
      return { slug: conversation.slug, thread_id: conversation.thread_id, incarnation: conversation.incarnation,
        top: index.scrollTop, anchor };
    },
    restoreScroll: (root: HTMLElement, previous: MailConversationScroll | null): void => {
      if (!previous || !conversation || previous.slug !== conversation.slug
        || previous.thread_id !== conversation.thread_id || previous.incarnation !== conversation.incarnation) return;
      const index = root.querySelector<HTMLElement>('.data-mail-conversation-index');
      if (!index || index.clientHeight === 0) return;
      const anchor = previous.anchor;
      const target = anchor ? Array.from(index.querySelectorAll<HTMLElement>('[data-mail-record]'))
        .find(button => button.getAttribute('data-mail-record') === anchor.record_id) : null;
      index.scrollTop = target && anchor
        ? index.scrollTop + target.getBoundingClientRect().top - index.getBoundingClientRect().top - anchor.offset
        : previous.top;
    },
    // The route also repaints on unrelated mail-fact and connection updates.
    captureFocus: (active: HTMLElement | null | undefined): { slug: string; record_id: string; key: string } | null => {
      const key = active?.getAttribute('data-mail-focus');
      return key && ref ? { slug: ref.slug, record_id: ref.record_id, key } : null;
    },
    restoreFocus: (root: HTMLElement, previous: { slug: string; record_id: string; key: string } | null): void => {
      if (!previous || previous.slug !== ref?.slug || previous.record_id !== ref.record_id) return;
      const target = Array.from(root.querySelectorAll<HTMLElement>('[data-mail-focus]'))
        .find(node => node.getAttribute('data-mail-focus') === previous.key)
        ?? (previous.key === 'reply' ? root.querySelector<HTMLElement>('[data-mail-focus="error"]') : null);
      target?.focus({ preventScroll: true });
    },
    beforeLeave,
    reset: (): void => {
      generation++; readGeneration++; anchor = null; ref = null; conversation = null; messages = []; snapshot = null;
      loading = false; opening = false; refreshing = false; olderLoading = false; olderLoaded = false; error = null; conversationError = null; notice = '';
    },
    hasUnsavedChanges: (): boolean => compose?.hasUnsavedChanges() === true,
    hasInFlightWork: (): boolean => opening || compose?.hasInFlightWork() === true,
    dispose: (): void => { disposed = true; generation++; readGeneration++; compose?.destroy(); portal?.remove(); },
  };
};
