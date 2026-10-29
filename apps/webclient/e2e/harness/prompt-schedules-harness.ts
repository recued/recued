import { bootstrapChatRoute, CHAT_ROUTE_STYLES, type ChatRouteConn } from '../../src/chat/bootstrap-chat-route.js';
import { bootstrapAutomationRoute } from '../../src/automation/bootstrap-automation-route.js';
import type { Conn, ServerRpcRegistry } from '@recued/contracts';
import type { BroadcastSubscriber } from '../../src/realtime/subscriber.js';

const subscribers = new Map<string, Set<(event: unknown) => void>>();
const subscribe = ((kind: string, callback: (event: unknown) => void) => {
  const list = subscribers.get(kind) ?? new Set(); list.add(callback); subscribers.set(kind, list);
  return () => list.delete(callback);
}) as BroadcastSubscriber['on'];
const call = async (method: string, args: unknown) => {
  const response = await fetch('/prompt-rpc', { method: 'POST', body: JSON.stringify({ method, args }) });
  const reply = await response.json(); if (reply.error) throw new Error(reply.error); return reply.result;
};
const root = document.getElementById('app')!;
if (new URLSearchParams(location.search).has('automation')) {
  bootstrapAutomationRoute({ root, rehearsalCall: call as Conn<ServerRpcRegistry>, subscribe,
    serverTimeZone: () => 'America/New_York',
    recipeEntriesCaller: () => call('recipe.list', {}),
    dishesListCaller: async () => {
      const result = await call('dishes.list', {});
      return { dishes: Array.isArray(result?.dishes) ? result.dishes : [] };
    },
    schedulesCreateCaller: args => call('schedules.create', args),
    schedulesListCaller: async () => {
      const result = await call('schedules.list', {});
      return { schedules: Array.isArray(result?.schedules) ? result.schedules : [] };
    } });
} else {
  const style = document.createElement('style'); style.textContent = CHAT_ROUTE_STYLES; document.head.append(style);
  bootstrapChatRoute({ root, conn: call as ChatRouteConn, subscribe, initialSessionId: 'scheduled-session' });
}
Object.assign(window, { promptEvent: (event: { kind: string }) => {
  for (const callback of subscribers.get(event.kind) ?? []) callback(event);
} });
