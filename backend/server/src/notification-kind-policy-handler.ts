/** D-269 step 2 — `notification.kind_policy.get` / `.set`.
 *
 *  The owner says, per anchored kind, whether they are told and how far ahead.
 *  `offset_ms` replaces `WORK_ENTITY_DUE_SOON_WINDOW_MS` as the due-status
 *  sweep's input; `enabled` gates the emission and nothing else.
 *
 *  ⛔ `get` ALWAYS RETURNS ALL FOUR KINDS, stored or defaulted, so a client
 *  renders the full list without knowing which rows exist and without carrying
 *  a second copy of the defaults. */

import {
  defaultNotificationKindPolicy,
  isNotificationAnchoredKind,
  isValidNotificationOffsetMs,
  NOTIFICATION_KIND_MAX_OFFSET_MS,
  RpcError,
  type HandlerSlice,
  type NotificationKindPolicyGetResponse,
  type NotificationKindPolicySetRequest,
  type NotificationKindPolicySetResponse,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { NotificationKindPolicyStore } from './storage/notification-kind-policy-store.js';
import type { WsClient } from './ws-server.js';

export interface NotificationKindPolicyRpcDeps {
  store: NotificationKindPolicyStore;
  now?: () => number;
}

const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'notification.kind_policy rpc requires a registered paired client',
      401,
    );
  }
};

type Methods = 'notification.kind_policy.get' | 'notification.kind_policy.set';

export const makeNotificationKindPolicyHandlers = (
  deps: NotificationKindPolicyRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, Methods, WsClient> | undefined => {
  if (!deps) return undefined;
  const now = deps.now ?? ((): number => Date.now());

  return {
    methods: ['notification.kind_policy.get', 'notification.kind_policy.set'],
    handlers: {
      'notification.kind_policy.get': async (
        _args,
        client,
      ): Promise<NotificationKindPolicyGetResponse> => {
        requireRegisteredClient(client);
        return { policies: deps.store.list() };
      },

      'notification.kind_policy.set': async (
        args,
        client,
      ): Promise<NotificationKindPolicySetResponse> => {
        requireRegisteredClient(client);
        const method = 'notification.kind_policy.set';
        const req = (args ?? {}) as NotificationKindPolicySetRequest;

        if (!isNotificationAnchoredKind(req.kind)) {
          // ⛔ Names `project` explicitly, because it is the one a reader will
          // reach for: it HAS an anchor and was ruled out on judgement, so a
          // bare "unknown kind" would read as an oversight to fix rather than a
          // decision to respect.
          throw new RpcError(
            'bad_request',
            `${method}: kind must be task, commitment, booking or calendar `
            + `(project has a deadline but deliberately carries no reminder policy)`,
          );
        }

        if (req.offset_ms !== undefined && !isValidNotificationOffsetMs(req.offset_ms)) {
          throw new RpcError(
            'bad_request',
            `${method}: offset_ms must be a whole number of milliseconds between `
            + `0 and ${NOTIFICATION_KIND_MAX_OFFSET_MS} (a negative offset would mean `
            + `"tell me after it is due", which is an escalation and not a reminder)`,
          );
        }
        if (req.enabled !== undefined && typeof req.enabled !== 'boolean') {
          throw new RpcError('bad_request', `${method}: enabled must be a boolean`);
        }
        if (req.offset_ms === undefined && req.enabled === undefined) {
          // ⚠ Refused rather than treated as a no-op: a write that changes
          // nothing but stamps `updated_at` makes the row look edited.
          throw new RpcError(
            'bad_request',
            `${method}: pass enabled, offset_ms, or both`,
          );
        }

        deps.store.write(
          req.kind,
          {
            ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
            ...(req.offset_ms !== undefined ? { offset_ms: req.offset_ms } : {}),
          },
          now(),
        );
        // Returns the FULL list, not the one row — the caller re-renders from
        // one response and cannot drift from the server's view of the others.
        return { policies: deps.store.list() };
      },
    },
  };
};

/** Re-exported so a composition root can build a default without importing the
 *  contracts module for one call. */
export { defaultNotificationKindPolicy };
