import { getMessengerVendorDeclaration, type ChatMessengerSessionStatus, type ChatSessionSummary } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

export interface MessengerSessionListReply {
  sessions: ChatSessionSummary[];
  messenger_status_available?: boolean;
  history_filters_available?: boolean;
}
const receiveLabels: Record<ChatMessengerSessionStatus['receive'], string> = {
  active: 'Receiving', connecting: 'Connecting', retrying: 'Reconnecting', error: 'Recued could not connect to receive',
  stopped: 'Recued has stopped receiving', locked: 'Your keys are locked', invalid: 'This connection needs a look',
  webhook: 'Set up to be told directly', paused: 'Server paused', unknown: 'Recued does not know if it is receiving',
  checking: 'Checking connection', unavailable: 'Recued cannot check this connection',
  connection_changed: 'The account or where it goes has changed', not_connected: 'Not connected',
  unlinked: 'Not set up to deliver here',
};
const counts = ['pending_count', 'sending_count', 'failed_count', 'unknown_count', 'skipped_count'] as const;
const valid = (status: ChatMessengerSessionStatus | undefined): status is ChatMessengerSessionStatus =>
  !!status && typeof status.vendor === 'string' && status.vendor.length > 0
  && typeof status.recipient === 'string' && status.recipient.length > 0
  && typeof status.linked === 'boolean' && Object.hasOwn(receiveLabels, status.receive)
  && (status.delivery === null || !!status.delivery && counts.every(name =>
    Number.isSafeInteger(status.delivery![name]) && status.delivery![name] >= 0));

export const messengerSessionLabels = (status: ChatMessengerSessionStatus, stale = false) => {
  const vendor = getMessengerVendorDeclaration(status.vendor)?.display_name ?? status.vendor;
  const delivery = status.delivery;
  let send = 'Recued cannot follow what was sent';
  let sendState = 'unavailable';
  if (delivery && !stale) {
    if (delivery.unknown_count) { send = `${delivery.unknown_count} that Recued cannot account for${delivery.unknown_count === 1 ? '' : 's'} unknown`; sendState = 'unknown'; }
    else if (delivery.failed_count) { send = `${delivery.failed_count} deliver${delivery.failed_count === 1 ? 'y' : 'ies'} failed`; sendState = 'failed'; }
    else if (delivery.sending_count) { send = `Sending · ${delivery.pending_count} pending`; sendState = 'sending'; }
    else if (delivery.pending_count) { send = `${delivery.pending_count} message${delivery.pending_count === 1 ? '' : 's'} waiting to send`; sendState = 'pending'; }
    else if (delivery.skipped_count) { send = `${delivery.skipped_count} skipped message${delivery.skipped_count === 1 ? '' : 's'}`; sendState = 'skipped'; }
    else { send = 'All sent'; sendState = 'sent'; }
    if (delivery.pending_count && (delivery.unknown_count || delivery.failed_count)) send += ` · ${delivery.pending_count} pending`;
    if (delivery.skipped_count && delivery.pending_count) send += ` · ${delivery.skipped_count} skipped`;
  }
  return { vendor, receive: stale ? 'Recued cannot tell if it is receiving' : receiveLabels[status.receive],
    receiveState: stale ? 'unavailable' : status.receive, send: stale ? 'Recued cannot tell what was sent' : send, sendState };
};

export const CHAT_MESSENGER_LIST_STYLES = `
[data-chat-messenger-row] { display: grid; gap: 3px; margin-top: 6px; font-size: 11px; line-height: 1.4; }
[data-chat-messenger-row][hidden], [data-chat-messenger-actions][hidden] { display: none; }
[data-chat-messenger-identity] { display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline; overflow-wrap: anywhere; }
[data-chat-messenger-vendor] { border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; font-weight: 650; }
[data-chat-messenger-receive], [data-chat-messenger-send] { color: var(--muted); overflow-wrap: anywhere; }
[data-chat-messenger-receive="error"], [data-chat-messenger-receive="connection_changed"],
[data-chat-messenger-send="failed"], [data-chat-messenger-send="unknown"] { color: var(--danger, var(--fg)); }
[data-chat-messenger-actions] { display: grid; gap: 4px; }
[data-recued-chat-route-session-actions][open]:has([data-chat-messenger-actions]:not([hidden])) { padding-bottom: 200px; }
`;

/** Status refreshes patch only these small row hosts. They never replace the
 * history search box, composer, open action menu or focused recovery control. */
export const createMessengerSessionList = (options: {
  document: Pick<Document, 'createElement' | 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  read(): Promise<MessengerSessionListReply>;
  openDelivery(session: string): void;
  actionsLocked(): boolean;
  changed?(): void;
  intervalMs?: number;
}) => {
  const entries = new Map<string, { status: ChatMessengerSessionStatus; stale: boolean }>();
  const mounts = new Map<string, { root: HTMLElement; actions: HTMLElement; paint: () => void }>();
  let known = new Set<string>();
  let disposed = false;
  let externalRead = false;
  let generation = 0;
  let running = false;
  let dirty = false;
  let readUnavailable = false;
  let filtersAvailable = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const paint = (): void => { for (const mount of mounts.values()) mount.paint(); };
  const unavailable = (): void => { readUnavailable = true; for (const entry of entries.values()) entry.stale = true; paint(); options.changed?.(); };
  const schedule = (delay = options.intervalMs ?? 5_000): void => {
    clearTimer();
    if (!disposed && !externalRead && (entries.size > 0 || readUnavailable)) {
      timer = setTimeout(() => { timer = undefined; void refresh(); }, delay);
      timer.unref?.();
    }
  };
  const apply = (reply: MessengerSessionListReply): void => {
    filtersAvailable = reply.history_filters_available === true;
    readUnavailable = reply.messenger_status_available === false
      || reply.sessions.some(session => session.messenger !== undefined && !valid(session.messenger));
    if (readUnavailable) { unavailable(); return; }
    const byId = new Map(reply.sessions.map(session => [session.id, session.messenger]));
    for (const id of known) {
      const status = byId.get(id);
      if (valid(status)) entries.set(id, { status, stale: false });
      else if (reply.messenger_status_available === true && status === undefined) entries.delete(id);
      else if (entries.has(id)) entries.get(id)!.stale = true;
    }
    paint();
    options.changed?.();
  };
  const refresh = async (): Promise<void> => {
    if (disposed || externalRead || options.document.visibilityState === 'hidden') { schedule(); return; }
    if (running) { dirty = true; return; }
    clearTimer(); running = true;
    const request = generation;
    // Keep a stalled request single-flight, but stop presenting its old success
    // as current. Normal connection RPC timeouts/reconnects release the read.
    const deadline = setTimeout(() => { if (!disposed && request === generation) unavailable(); }, 8_000);
    deadline.unref?.();
    try {
      const reply = await options.read();
      if (!disposed && request === generation) apply(reply);
    } catch { if (!disposed && request === generation) unavailable(); }
    finally {
      clearTimeout(deadline); running = false;
      if (dirty) { dirty = false; schedule(50); } else schedule();
    }
  };
  const visibility = (): void => { if (options.document.visibilityState !== 'hidden') { unavailable(); schedule(0); } };
  options.document.addEventListener('visibilitychange', visibility);

  return {
    filtersAvailable: () => filtersAvailable,
    statusUnavailable: () => readUnavailable,
    project(session: ChatSessionSummary) {
      const entry = entries.get(session.id);
      return { id: session.id, ...(entry ? { messenger: entry.status } : {}), stale: entry?.stale ?? false };
    },
    beginRead() { externalRead = true; generation++; clearTimer(); },
    adopt(reply: MessengerSessionListReply) {
      generation++; externalRead = false; known = new Set(reply.sessions.map(session => session.id));
      for (const id of entries.keys()) if (!known.has(id)) entries.delete(id);
      apply(reply); schedule();
    },
    failed() { generation++; externalRead = false; unavailable(); schedule(); },
    invalidate() { schedule(50); },
    beginRender() { mounts.clear(); },
    mount(row: HTMLElement, menu: HTMLElement, session: string) {
      const doc = options.document;
      const root = doc.createElement('span'); root.setAttribute('data-chat-messenger-row', session); root.hidden = true; row.appendChild(root);
      const actions = doc.createElement('div'); actions.setAttribute('data-chat-messenger-actions', ''); actions.hidden = true; menu.appendChild(actions);
      let children: { vendor: HTMLElement; recipient: HTMLElement; receive: HTMLElement; send: HTMLElement; delivery: HTMLButtonElement; connection: HTMLAnchorElement } | undefined;
      const update = (): void => {
        const entry = entries.get(session); root.hidden = !entry; actions.hidden = !entry;
        if (!entry) return;
        if (!children) {
          const identity = doc.createElement('span'); identity.setAttribute('data-chat-messenger-identity', ''); root.appendChild(identity);
          const vendor = doc.createElement('span'); vendor.setAttribute('data-chat-messenger-vendor', ''); identity.appendChild(vendor);
          const recipient = doc.createElement('span'); identity.appendChild(recipient);
          const receive = doc.createElement('span'); root.appendChild(receive);
          const send = doc.createElement('span'); root.appendChild(send);
          const delivery = doc.createElement('button'); delivery.type = 'button'; delivery.className = 'chat-session-action';
          delivery.setAttribute('data-chat-messenger-delivery', session); delivery.textContent = 'Messenger delivery';
          delivery.addEventListener('click', () => { if (!options.actionsLocked()) options.openDelivery(session); }); actions.appendChild(delivery);
          const connection = doc.createElement('a'); connection.className = 'chat-session-action';
          connection.setAttribute('data-chat-messenger-connection', session); connection.textContent = 'Connection settings'; actions.appendChild(connection);
          children = { vendor, recipient, receive, send, delivery, connection };
        }
        const labels = messengerSessionLabels(entry.status, entry.stale);
        children.vendor.textContent = labels.vendor;
        children.recipient.textContent = entry.status.recipient;
        children.receive.textContent = `Receive: ${labels.receive}`;
        children.receive.setAttribute('data-chat-messenger-receive', labels.receiveState);
        children.send.textContent = `Send: ${labels.send}`;
        children.send.setAttribute('data-chat-messenger-send', labels.sendState);
        children.delivery.disabled = options.actionsLocked();
        children.connection.setAttribute('href', serializeShellRoute('connections', 'others'));
      };
      mounts.set(session, { root, actions, paint: update }); update();
    },
    dispose() { disposed = true; generation++; clearTimer(); mounts.clear(); options.document.removeEventListener('visibilitychange', visibility); },
  };
};
