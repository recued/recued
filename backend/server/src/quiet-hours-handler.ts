/** D-269 step 3 — `notification.quiet_hours.get` / `.set`.
 *
 *  ⛔⛔ ARMING IS GATED ON A RESOLVABLE TIMEZONE, AND THE REFUSAL IS THE POINT.
 *  Quiet hours is WALL CLOCK and the sweep runs with no client attached, so
 *  without a zone "22:00" means nothing the server can act on. Accepting the
 *  write and silently doing nothing would be the worst available outcome: the
 *  owner believes they are protected, and the only evidence otherwise is a
 *  notification that arrives at 3am.
 *
 *  ⚠ The gate is RESOLVABLE, not DECLARED — `follows_host` satisfies it with
 *  nothing typed, so a laptop owner never picks a zone and quiet hours works. */

import {
  canArmQuietHours,
  isValidQuietHoursMinute,
  QUIET_HOURS_APPLIES_TO,
  resolveServerTimeZone,
  RpcError,
  type HandlerSlice,
  type QuietHoursAppliesTo,
  type QuietHoursGetResponse,
  type QuietHoursSetRequest,
  type QuietHoursSetResponse,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { QuietHoursStore } from './storage/quiet-hours-store.js';
import type { ServerTimeZoneStore } from './storage/server-timezone-store.js';
import type { WsClient } from './ws-server.js';

export interface QuietHoursRpcDeps {
  store: QuietHoursStore;
  /** The D-269 step 1 zone. Quiet hours cannot arm without one. */
  timezoneStore: ServerTimeZoneStore;
  now?: () => number;
  hostZone?: () => string;
}

const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'notification.quiet_hours rpc requires a registered paired client',
      401,
    );
  }
};

type Methods = 'notification.quiet_hours.get' | 'notification.quiet_hours.set';

export const makeQuietHoursHandlers = (
  deps: QuietHoursRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, Methods, WsClient> | undefined => {
  if (!deps) return undefined;
  const now = deps.now ?? ((): number => Date.now());
  const hostZone = deps.hostZone
    ?? ((): string => Intl.DateTimeFormat().resolvedOptions().timeZone);

  const project = (): QuietHoursGetResponse => {
    const tz = deps.timezoneStore.read();
    return {
      policy: deps.store.read(),
      can_arm: canArmQuietHours(tz),
      resolved_zone: resolveServerTimeZone(tz, hostZone()),
    };
  };

  return {
    methods: ['notification.quiet_hours.get', 'notification.quiet_hours.set'],
    handlers: {
      'notification.quiet_hours.get': async (_a, client): Promise<QuietHoursGetResponse> => {
        requireRegisteredClient(client);
        return project();
      },

      'notification.quiet_hours.set': async (args, client): Promise<QuietHoursSetResponse> => {
        requireRegisteredClient(client);
        const method = 'notification.quiet_hours.set';
        const req = (args ?? {}) as QuietHoursSetRequest;

        for (const field of ['from_minute', 'to_minute'] as const) {
          const v = req[field];
          if (v !== undefined && !isValidQuietHoursMinute(v)) {
            throw new RpcError(
              'bad_request',
              `${method}: ${field} must be a whole number of minutes since local `
              + `midnight, 0–1439`,
            );
          }
        }
        if (req.enabled !== undefined && typeof req.enabled !== 'boolean') {
          throw new RpcError('bad_request', `${method}: enabled must be a boolean`);
        }

        let applies_to: QuietHoursAppliesTo[] | undefined;
        if (req.applies_to !== undefined) {
          if (!Array.isArray(req.applies_to) || req.applies_to.length === 0) {
            throw new RpcError(
              'bad_request',
              `${method}: applies_to must be a non-empty array`,
            );
          }
          for (const v of req.applies_to) {
            if (!QUIET_HOURS_APPLIES_TO.includes(v)) {
              throw new RpcError(
                'bad_request',
                `${method}: applies_to may contain ${QUIET_HOURS_APPLIES_TO.join(' and ')}`,
              );
            }
          }
          // ⚠ D-269 step 5 — `'approval'` is now ACCEPTED and is still not the
          // recommendation: D-261 pre-approval buys the same silence without the
          // work waiting, and the asks this would hold are exactly the reactive
          // ones pre-approval cannot freeze. The surface says so at the point of
          // choosing; the rpc does not moralise, it records the choice.
          applies_to = [...new Set(req.applies_to)];
        }

        const wantsEnabled = req.enabled ?? deps.store.read().enabled;
        if (wantsEnabled && !canArmQuietHours(deps.timezoneStore.read())) {
          throw new RpcError(
            'failed_precondition',
            `${method}: set this server's timezone first — quiet hours is a wall `
            + `clock, and the sweep runs with no browser attached, so "22:00" `
            + `needs a zone the server itself can read`,
          );
        }

        deps.store.write(
          {
            ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
            ...(req.from_minute !== undefined ? { from_minute: req.from_minute } : {}),
            ...(req.to_minute !== undefined ? { to_minute: req.to_minute } : {}),
            ...(applies_to !== undefined ? { applies_to } : {}),
          },
          now(),
        );
        return project();
      },
    },
  };
};
