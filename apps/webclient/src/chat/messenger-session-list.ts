import { CHAT_MESSENGER_STATUS_BATCH, getMessengerVendorDeclaration, type ChatMessengerSessionStatus, type ChatSessionSummary, type ChatMessengerStatusResult } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

export interface MessengerSessionListReply {
  sessions: ChatSessionSummary[];
  messenger_status_available?: boolean;
  history_filters_available?: boolean;
  messenger_status_refresh_available?: boolean;
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
  readStatus?(sessionIds: string[]): Promise<ChatMessengerStatusResult>;
  needsListRefresh?(): boolean;
  refreshList?(): Promise<void>;
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
  let refreshOwner: object | undefined;
  let dirty = false;
  let readUnavailable = false;
  let filtersAvailable = false;
  let statusOnly = false;
  let recoverAll = false;
  const invalidated = new Map<string, number>();
  let invalidationRevision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const paint = (): void => { for (const mount of mounts.values()) mount.paint(); };
  const unavailable = (): void => { readUnavailable = true; for (const entry of entries.values()) entry.stale = true; paint(); options.changed?.(); };
  const schedule = (delay = options.intervalMs ?? 5_000): void => {
    clearTimer();
    if (!disposed && !externalRead && (entries.size > 0 || readUnavailable || invalidated.size > 0 || recoverAll && known.size > 0 || options.needsListRefresh?.())) {
      timer = setTimeout(() => { timer = undefined; void refresh(); }, delay);
      timer.unref?.();
    }
  };
  const apply = (reply: MessengerSessionListReply, partial = false): void => {
    filtersAvailable = reply.history_filters_available === true;
    readUnavailable = partial && readUnavailable || reply.messenger_status_available === false
      || reply.sessions.some(session => session.messenger !== undefined && !valid(session.messenger));
    if (reply.messenger_status_available === false || reply.sessions.some(session => session.messenger !== undefined && !valid(session.messenger))) { unavailable(); return; }
    const byId = new Map(reply.sessions.map(session => [session.id, session.messenger]));
    for (const id of partial ? byId.keys() : known) {
      const status = byId.get(id);
      if (valid(status)) entries.set(id, { status, stale: false });
      else if (reply.messenger_status_available === true && status === undefined) entries.delete(id);
      else if (entries.has(id)) entries.get(id)!.stale = true;
    }
    paint();
    options.changed?.();
  };
  const refreshStatus = async (request: number): Promise<void> => {
    const ids = recoverAll || readUnavailable ? [...known] : [...new Set([...entries.keys(), ...invalidated.keys()])];
    const batches: string[][] = [];
    for (let start = 0; start < ids.length; start += CHAT_MESSENGER_STATUS_BATCH) batches.push(ids.slice(start, start + CHAT_MESSENGER_STATUS_BATCH));
    if (!batches.length) batches.push([]);
    const results = new Map<string, ChatMessengerSessionStatus | undefined>();
    let next = 0; let failed = false; let fallback = false;
    await Promise.all(Array.from({ length: Math.min(4, batches.length) }, async () => {
      while (!disposed && request === generation && !failed && !fallback) {
        const batch = batches[next++]; if (!batch) return;
        try {
          const reply = await options.readStatus!(batch);
          if (disposed || request !== generation) return;
          const wanted = new Set(batch);
          if (reply?.messenger_status_available !== true || !Array.isArray(reply.sessions) || reply.sessions.length !== wanted.size
            || reply.sessions.some(row => !row || !wanted.delete(row.id) || row.messenger !== undefined && !valid(row.messenger)) || wanted.size > 0) {
            failed = true; return;
          }
          for (const row of reply.sessions) results.set(row.id, row.messenger);
        } catch (error) {
          if (disposed || request !== generation) return;
          const code = (error as { code?: string } | null)?.code;
          if (code === 'unknown_method' || code === 'not_configured') { fallback = true; statusOnly = false; }
          else failed = true;
        }
      }
    }));
    if (disposed || request !== generation) return;
    if (fallback) {
      const reply = await options.read();
      if (!disposed && request === generation) apply(reply);
      return;
    }
    readUnavailable = failed; recoverAll = false;
    if (failed) for (const entry of entries.values()) entry.stale = true;
    for (const [id, status] of results) {
      if (!known.has(id)) continue;
      if (status) entries.set(id, { status, stale: false }); else entries.delete(id);
    }
    paint(); options.changed?.();
  };
  const refresh = async (): Promise<void> => {
    if (disposed || externalRead || options.document.visibilityState === 'hidden') { schedule(); return; }
    if (refreshOwner) { dirty = true; return; }
    const owner = {};
    clearTimer(); refreshOwner = owner;
    let request = generation;
    const requestedInvalidations = new Map(invalidated);
    // Keep a stalled request single-flight, but stop presenting its old success
    // as current. Normal connection RPC timeouts/reconnects release the read.
    const deadline = setTimeout(() => { if (!disposed && request === generation) unavailable(); }, 8_000);
    deadline.unref?.();
    try {
      if (options.needsListRefresh?.() && options.refreshList) {
        const pending = options.refreshList();
        request = generation; // beginRead now owns the same pending refresh.
        await pending;
      } else if (statusOnly && options.readStatus) await refreshStatus(request);
      else {
        const reply = await options.read();
        if (!disposed && request === generation) { apply(reply); recoverAll = false; }
      }
    } catch { if (!disposed && request === generation) unavailable(); }
    finally {
      clearTimeout(deadline);
      if (refreshOwner === owner) {
        refreshOwner = undefined;
        if (request === generation) for (const [id, revision] of requestedInvalidations) {
          if (invalidated.get(id) === revision) invalidated.delete(id);
        }
        if (dirty || invalidated.size > 0) { dirty = false; schedule(50); } else schedule();
      }
    }
  };
  const visibility = (): void => { if (options.document.visibilityState !== 'hidden') { generation++; recoverAll = true; unavailable(); schedule(0); } };
  options.document.addEventListener('visibilitychange', visibility);

  return {
    filtersAvailable: () => filtersAvailable,
    statusUnavailable: () => readUnavailable,
    project(session: ChatSessionSummary) {
      const entry = entries.get(session.id);
      return { id: session.id, ...(entry ? { messenger: entry.status } : {}), stale: entry?.stale ?? false };
    },
    beginRead() { externalRead = true; generation++; invalidated.clear(); clearTimer(); },
    adopt(reply: MessengerSessionListReply, mode?: { append?: true; retain?: readonly string[] }) {
      // A completed newer metadata read supersedes a stalled refresh. Its
      // timer must not wait for an obsolete RPC, nor be released by that RPC.
      refreshOwner = undefined; dirty = false;
      generation++; externalRead = false; known = new Set([...(mode?.append ? known : mode?.retain ?? []), ...reply.sessions.map(session => session.id)]);
      statusOnly = reply.messenger_status_refresh_available === true && options.readStatus !== undefined;
      recoverAll = false;
      for (const id of entries.keys()) if (!known.has(id)) entries.delete(id);
      for (const id of invalidated.keys()) if (!known.has(id)) invalidated.delete(id);
      apply(reply, mode?.append || !!mode?.retain?.length); schedule(invalidated.size > 0 ? 50 : undefined);
    },
    failed() { refreshOwner = undefined; dirty = false; generation++; externalRead = false; unavailable(); schedule(); },
    invalidate(sessionId?: string) {
      if (sessionId && known.has(sessionId)) invalidated.set(sessionId, ++invalidationRevision);
      else { generation++; recoverAll = true; }
      schedule(50);
    },
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
