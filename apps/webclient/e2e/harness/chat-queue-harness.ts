import { bootstrapChatRoute, CHAT_ROUTE_STYLES, type ChatRouteConn, type BootstrapChatRouteOptions } from '../../src/chat/bootstrap-chat-route.js';
import { noticeReplyDraft } from '../../src/chat/quoted-replies.js';

const subscribers = new Map<string, Set<(event: unknown) => void>>();
const style = document.createElement('style'); style.textContent = CHAT_ROUTE_STYLES; document.head.appendChild(style);
const conn = (async (method: string, args: unknown) => {
  const response = await fetch('/d265-rpc', { method: 'POST', body: JSON.stringify({ method, args }) });
  const envelope = await response.json();
  if (envelope.error) throw new Error(envelope.error);
  return envelope.result;
}) as ChatRouteConn;
const subscribe = ((kind: string, callback: (event: unknown) => void) => {
  const list = subscribers.get(kind) ?? new Set(); list.add(callback); subscribers.set(kind, list);
  return () => list.delete(callback);
}) as BootstrapChatRouteOptions['subscribe'];
// `?start` opens on the start view (the webclient's landing, no chat open),
// where a first message creates its conversation.
const opening = new URLSearchParams(location.search).has('start') ? {} : { initialSessionId: 's' };
let route = bootstrapChatRoute({ root: document.getElementById('app')!, conn, ...opening, subscribe });
Object.assign(window, {
  queueTestEvent: (event: { kind: string }) => { for (const callback of subscribers.get(event.kind) ?? []) callback(event); },
  queueTestRefresh: () => route.refresh(),
  queueTestHasInFlight: () => route.hasInFlightWork(),
  queueTestRePair: async () => {
    const draft = route.getRecoveryDraft(); route.dispose();
    route = bootstrapChatRoute({ root: document.getElementById('app')!, conn, initialSessionId: 's', subscribe,
      ...(draft ? { initialRecoveryDraft: draft } : {}) });
    await route.whenLoaded();
  },
  // D-343 slice 4 — the chat as Today's "Close the day" opens it: the new conversation, replying to its notice.
  queueTestOpenClosing: async (notice: { session_id: string; message_id: string; title: string; text: string }) => {
    route.dispose();
    route = bootstrapChatRoute({ root: document.getElementById('app')!, conn, initialSessionId: notice.session_id, subscribe,
      initialRecoveryDraft: { text: '', protected: true, modelSourceId: null, replyTo: noticeReplyDraft(notice) } });
    await route.whenLoaded();
  },
});
void route.whenLoaded().then(() => document.body.setAttribute('data-ready', 'true'));
