/** D-269 step 1 — `server.timezone.get` / `server.timezone.set`.
 *
 *  The owner declares where this SERVER lives relative to them — `fixed` (a NAS,
 *  a home server, a VPS: the machine stays, the owner may travel) or
 *  `follows_host` (a laptop: the machine goes where the owner goes). Everything
 *  that needs a wall clock with no live client attached resolves through the
 *  answer.
 *
 *  ⛔ THE MODE IS THE POINT, NOT THE ZONE. Reading the host clock was never
 *  wrong in itself — it is right for a laptop and wrong for a datacenter, and
 *  the defect was that the assumption could not be stated. So this family exists
 *  to make one unobservable fact sayable; the zone string is the easy half.
 *
 *  ⚠ `get` RETURNS THREE THINGS, AND A CLIENT CAN COMPUTE NONE OF THEM. Under
 *  `follows_host` the resolved zone IS the server's host reading; a browser that
 *  asked `Intl` would get its own zone and believe it had the server's. Handing
 *  back `resolved_zone` and `host_zone` is what lets the two-clock preview say
 *  something true rather than something plausible. */

import {
  canonicalizeIanaZone,
  resolveServerTimeZone,
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
  type ServerTimeZoneGetResponse,
  type ServerTimeZoneMode,
  type ServerTimeZoneSetRequest,
  type ServerTimeZoneSetResponse,
} from '@recued/contracts';
import type { ServerTimeZoneStore } from './storage/server-timezone-store.js';
import type { WsClient } from './ws-server.js';

export interface ServerTimeZoneRpcDeps {
  store: ServerTimeZoneStore;
  /** Clock for the `updated_at` stamp. Defaults to `Date.now`. */
  now?: () => number;
  /** ⚠ INJECTED, NOT READ HERE. The server's own IANA zone, normally
   *  `Intl.DateTimeFormat().resolvedOptions().timeZone`. A dep because a test
   *  that cannot pin the host zone can only assert the resolution it already
   *  assumed — and the resolution IS the thing under test. */
  hostZone?: () => string;
}

const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'server.timezone rpc requires a registered paired client',
      401,
    );
  }
};

type ServerTimeZoneMethods = 'server.timezone.get' | 'server.timezone.set';

export const makeServerTimeZoneHandlers = (
  deps: ServerTimeZoneRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ServerTimeZoneMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  const now = deps.now ?? ((): number => Date.now());
  const hostZone = deps.hostZone
    ?? ((): string => Intl.DateTimeFormat().resolvedOptions().timeZone);

  /** One projection for both methods, so a `set` response can never describe a
   *  different world than the `get` that follows it. */
  const project = (): ServerTimeZoneGetResponse => {
    const host = hostZone();
    const setting = deps.store.read();
    return {
      // ⚠ The WIRE always carries a setting, even when the row is absent, so a
      // client has something to render. The absent-row distinction is preserved
      // where it matters — `updated_at: 0` says "never set", and a wall-clock
      // feature asks `isServerTimeZoneConfigured`, not this shape.
      setting: setting ?? { mode: 'fixed', zone: null, updated_at: 0 },
      resolved_zone: resolveServerTimeZone(setting, host),
      host_zone: host,
    };
  };

  return {
    methods: ['server.timezone.get', 'server.timezone.set'],
    handlers: {
      'server.timezone.get': async (_args, client): Promise<ServerTimeZoneGetResponse> => {
        requireRegisteredClient(client);
        return project();
      },

      'server.timezone.set': async (args, client): Promise<ServerTimeZoneSetResponse> => {
        requireRegisteredClient(client);
        const method = 'server.timezone.set';
        const req = (args ?? {}) as ServerTimeZoneSetRequest;

        const mode: ServerTimeZoneMode = req.mode === 'follows_host' ? 'follows_host'
          : req.mode === 'fixed' ? 'fixed'
            : ((): never => {
              throw new RpcError(
                'bad_request',
                `${method}: mode must be 'fixed' or 'follows_host'`,
              );
            })();

        const prior = deps.store.read();
        // ⚠ ABSENT `zone` KEEPS THE STORED ONE; an explicit `null` clears it.
        // The difference matters: flipping to `follows_host` must not discard
        // what the owner typed (they may flip back tomorrow), but an owner who
        // deliberately clears the field should see it cleared.
        const requested = req.zone === undefined ? (prior?.zone ?? null) : req.zone;

        // ⛔⛔ CANONICALISE, DO NOT MERELY VALIDATE. `Intl` accepts `'EST'` and
        // resolves it to `America/Panama` — a real zone that never observes DST,
        // so a New Yorker typing the abbreviation they say out loud gets a clock
        // an hour wrong for eight months. No validator can read that intent.
        // Storing the CANONICAL id is what lets the picker show them
        // `America/Panama` and makes the mistake visible at the moment it is
        // made. (`'PST'` canonicalises to `America/Los_Angeles` and is fine.)
        const zone = requested === null ? null : canonicalizeIanaZone(requested);

        if (requested !== null && zone === null) {
          throw new RpcError(
            'bad_request',
            `${method}: '${String(requested)}' cannot serve as a wall clock. `
            + `Use an IANA zone such as 'America/Los_Angeles' — a fixed offset `
            + `('-08:00', 'Etc/GMT+8') never follows daylight saving`,
          );
        }

        if (mode === 'fixed' && zone === null) {
          // ⛔ REFUSED RATHER THAN SILENTLY FALLING BACK TO THE HOST. `fixed`
          // with no zone would resolve to the host reading and behave exactly
          // like `follows_host` while claiming not to — the invisible
          // deployment assumption this whole family exists to abolish.
          throw new RpcError(
            'bad_request',
            `${method}: mode 'fixed' needs a zone — pass 'follows_host' if this `
            + `server travels with you`,
          );
        }

        deps.store.write(mode, zone, now());
        return project();
      },
    },
  };
};
