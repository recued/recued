/** D-121 Phase 6 — `events.subscribe` rpc handler.
 *
 *  Wires the realtime broadcast bus to the per-client WS push
 *  channel. Subscribing replaces the previous filter (no separate
 *  unsubscribe rpc); the ws-server tears down the registration when
 *  the WS closes.
 *
 *  Push envelope on the wire (matches `approval_changed` /
 *  `instance_revoked` / `server_heartbeat` shape — discriminated
 *  by `type`):
 *
 *      { type: 'server_event', event: ServerEvent }
 *
 *  The handler doesn't construct that envelope itself; it leaves
 *  it to the `pushToClient` callback supplied by ws-server, which
 *  has access to the underlying `send(ws, …)` helper. */

import {
  BROADCAST_EVENT_KIND_SET,
  RpcError,
  eventsSubscribeUnknownKindMessage,
  type BroadcastEventKind,
  type HandlerSlice,
  type ServerEvent,
  type ServerRpcRegistry,
  type SubscribeRequest,
} from '@recued/contracts';
import type { WsClient } from '../ws-server.js';
import type { EventBus, EventSubscriberId } from './bus.js';

export interface EventsHandlerDeps {
  /** Shared bus instance composed at server boot. */
  bus: EventBus;
  /** Push the wire envelope to one client. ws-server binds this to
   *  its `send(client.ws, …)` helper so subscribers see live + replay
   *  events without the bus knowing anything about WebSockets. */
  pushToClient: (
    client: WsClient,
    payload: { type: 'server_event'; event: ServerEvent },
  ) => void;
  /** Stable subscriber-id factory. ws-server returns the client's
   *  WS reference (object identity is stable for the connection's
   *  lifetime); tests pass a string. */
  subscriberId: (client: WsClient) => EventSubscriberId;
}

export type EventsMethods = 'events.subscribe';

/** The event ring contains owner-private invalidations (including gated-action
 * topology). The WS dispatcher resolves a bearer-only webclient's currently
 * valid paired identity onto `instance_id` before calling this handler, while
 * a revoked or never-registered client arrives with no id. Keep the same
 * registered-client boundary as the owner RPCs that consume those
 * invalidations. */
const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'events.subscribe requires a registered paired client',
      401,
    );
  }
};

/** Thin wrapper around `bus.subscribe` that builds the per-client
 *  push closure. Exported so ws-server can also call it
 *  programmatically (e.g. for the auto-default-subscription on a
 *  freshly-registered client). */
export const wireEventSubscription = (
  deps: EventsHandlerDeps,
  client: WsClient,
  req: SubscribeRequest,
) => {
  const id = deps.subscriberId(client);
  const ack = deps.bus.subscribe(id, req, (event) => {
    deps.pushToClient(client, { type: 'server_event', event });
  });
  return { ack, id };
};

export const makeEventsHandlers = (
  deps: EventsHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, EventsMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['events.subscribe'],
    handlers: {
      'events.subscribe': async (args, client) => {
        requireRegisteredClient(client);
        if (!args || typeof args !== 'object') {
          throw new RpcError('bad_request', 'events.subscribe: payload required', 400);
        }
        if (!Array.isArray(args.kinds) || args.kinds.length === 0) {
          throw new RpcError(
            'bad_request',
            'events.subscribe: kinds must be a non-empty array',
            400,
          );
        }
        // ⛔ A KIND THIS SERVER DOES NOT SEND IS LEFT OUT, NOT REFUSED.
        // D-148 P12 refused the whole call for one, so a stale client could
        // not wait on a retired kind (`session`) without being told. It then
        // got NO kind at all: a webclient cached across a retirement, or one
        // newer than this server, lost every live update and retried the same
        // list forever (found live 2026-10-10, after `service` was retired).
        // The ack names what was left out, so the client is still told. A
        // call that names nothing this server sends is still refused, in the
        // text a client's fallback for older servers reads.
        const kinds = args.kinds as unknown[];
        if (kinds.some((k) => typeof k !== 'string')) {
          throw new RpcError('bad_request', 'events.subscribe: kinds must be strings', 400);
        }
        const known = (kinds as string[]).filter(
          (k): k is BroadcastEventKind => BROADCAST_EVENT_KIND_SET.has(k as BroadcastEventKind),
        );
        const unknown = (kinds as string[]).filter(
          (k) => !BROADCAST_EVENT_KIND_SET.has(k as BroadcastEventKind),
        );
        if (known.length === 0) {
          throw new RpcError(
            'bad_request',
            eventsSubscribeUnknownKindMessage(unknown[0]!),
            400,
            undefined,
            { unknown_kinds: unknown },
          );
        }
        // Validate `cursor_since` (contract: `number`). The bus does
        // `req.cursor_since ?? cursor`, so a non-numeric / negative value is
        // NOT coalesced and slips into the replay-window comparisons —
        // `'x' >= cursor` / `ev.cursor <= 'x'` are both false, forcing a
        // synchronous full-ring replay (up to ringSize events) from a cheap
        // rpc. Reject anything but a non-negative finite number so a stale /
        // malformed cursor can't amplify into a firehose; a legitimate
        // replay (`cursor_since = N >= 0`) is the intended, ring-bounded path.
        if (
          args.cursor_since !== undefined &&
          (typeof args.cursor_since !== 'number' ||
            !Number.isFinite(args.cursor_since) ||
            args.cursor_since < 0)
        ) {
          throw new RpcError(
            'bad_request',
            'events.subscribe: cursor_since must be a non-negative finite number',
            400,
          );
        }
        try {
          const { ack } = wireEventSubscription(deps, client, { ...args, kinds: known });
          return unknown.length > 0 ? { ...ack, unknown_kinds: unknown } : ack;
        } catch (e) {
          throw new RpcError(
            'bad_request',
            e instanceof Error ? e.message : String(e),
            400,
          );
        }
      },
    },
  };
};
