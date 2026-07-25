/** WS rpc dispatcher — bridges a typed `HandlerRegistry` to the
 *  server's `HandlerResult` envelope.
 *
 *  This is the server-side mirror of `serverConn` / `swConn`: the same
 *  contracts-level registry drives the call site (client) and the
 *  handler site (server). A compile error here = a compile error in
 *  every extension caller, and vice versa.
 *
 *  Responsibilities:
 *
 *    1. Method lookup — missing methods return `not_configured`. Since
 *       the registry is a partial map, "wire up fewer methods" just
 *       means omitting keys. No more per-case `if (!someDeps)`.
 *    2. Maintenance gate — while a migration marker is active, only
 *       `auth.state` / `auth.migrate.status` / `auth.migrate.resume`
 *       are allowed; everything else yields `migration_in_progress`.
 *    3. Auto-lock activity — every call except state/status-polling
 *       counts as user activity and resets the idle timer.
 *    4. Error normalisation — handlers throw `RpcError` for coded
 *       failures (`unauthorized`, `not_configured`, `bad_request`…);
 *       the dispatcher converts them to a `HandlerResult` with the
 *       stable code + status. Uncoded throws become `500 internal`.
 *
 *  The dispatcher returns the same `HandlerResult<unknown>` shape the
 *  existing ws-server switch produces, so call sites don't change.
 */

import { RpcError, type HandlerRegistry, type RpcRegistry } from '@recued/contracts';
import type { HandlerResult } from './types.js';

/** Methods that remain available while a migration marker is set. */
export const MIGRATION_ALLOWED_METHODS = new Set<string>([
  'auth.state',
  'auth.migrate.status',
  'auth.migrate.resume',
]);

/** Methods that do NOT reset the auto-lock idle timer. UI polling of
 *  state/status is not user activity.
 *
 *  Codex 2026-05-17 P2 fold (slice 116b round 4) — `passport.fetch` is
 *  automatically fired by the webclient bootstrap on every successful
 *  WS reconnect to drive the cert-pin verify path. A reconnect storm
 *  on an otherwise-idle browser would otherwise reset the key-manager
 *  idle timer every cycle, keeping the server unlocked indefinitely
 *  without real user interaction. Treating the rpc as activity-exempt
 *  preserves the auto-lock invariant. */
export const AUTO_LOCK_IDLE_EXEMPT = new Set<string>([
  'auth.state',
  'auth.migrate.status',
  'passport.fetch',
  // D-169 P0 — `bridge.capabilityProfile.push` is automatically fired
  // by the bridge SW on every WS reconnect AND on every
  // chrome.permissions onAdded/onRemoved event. A reconnect storm or
  // permission churn would otherwise reset the key-manager idle timer
  // every cycle, keeping the server unlocked indefinitely without real
  // user interaction — identical posture to `passport.fetch` above.
  'bridge.capabilityProfile.push',
]);

/** Methods that remain available even when lifecycle is `booting` or
 *  `draining` (Phase C). Keeps diagnostic + recovery rpc reachable
 *  while other methods are gated. */
export const LIFECYCLE_ALLOWED_METHODS = new Set<string>([
  'server.getStatus',
  'server.getLifecycleState',
  'server.resetCrashLoop',
  'server.getBootstrap',
  // Recovery key / auth state polling stays open so the ext can
  // surface "server is draining" without losing its auth view.
  'auth.state',
]);

/** Gates the dispatcher enforces around every method. */
export interface DispatcherGates {
  /** Returns true when a migration marker is active. Optional — pass
   *  nothing when the server doesn't have migration deps wired. */
  migrationActive?: () => boolean;
  /** Called on every non-exempt method to reset the auto-lock idle
   *  timer. Optional — pass nothing when auth isn't configured. */
  touchActivity?: () => void;
  /** Optional allowlist of every valid method name. When provided,
   *  lookups hit this set before checking the registry — any method
   *  not in the set returns `unknown_method`, while methods in the
   *  set but absent from the registry return `not_configured`. When
   *  omitted, all missing-handler cases return `not_configured`. */
  knownMethods?: ReadonlySet<string>;
  /** Current lifecycle state (Phase C). When provided AND the state
   *  is not `running`, rpc calls outside `LIFECYCLE_ALLOWED_METHODS`
   *  fail with `not_ready` / `draining`. Absent → Phase A/B behavior
   *  (no lifecycle gating). */
  lifecycleState?: () => import('@recued/contracts').LifecycleState;
}

/** Factory result — the dispatcher itself. */
export type RpcDispatcher<Ctx> = (
  method: string,
  args: Record<string, unknown>,
  ctx: Ctx,
) => Promise<HandlerResult<unknown>>;

const notConfigured = (method: string): HandlerResult<never> => ({
  ok: false,
  status: 501,
  error: {
    code: 'not_configured',
    message: `rpc method "${method}" is not wired up on this server`,
  },
});

const migrationInProgress = (): HandlerResult<never> => ({
  ok: false,
  status: 503,
  error: {
    code: 'migration_in_progress',
    message: 'server is re-encrypting data; retry after migration completes',
  },
});

const notReady = (method: string): HandlerResult<never> => ({
  ok: false,
  status: 503,
  error: {
    code: 'not_ready',
    message: `server is still booting; retry shortly (method: ${method})`,
  },
});

const draining = (method: string): HandlerResult<never> => ({
  ok: false,
  status: 503,
  error: {
    code: 'draining',
    message: `server is draining; new rpc calls rejected (method: ${method})`,
  },
});

const unknownMethod = (method: string): HandlerResult<never> => ({
  ok: false,
  status: 404,
  error: { code: 'unknown_method', message: `Unknown rpc method: ${method}` },
});

/** Convert a thrown value into a `HandlerResult` error. `RpcError`
 *  round-trips its code + status + structured details; anything else
 *  becomes `internal`. */
const thrownToResult = (err: unknown, method: string): HandlerResult<never> => {
  if (err instanceof RpcError) {
    return {
      ok: false,
      status: err.status ?? 500,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
  }
  return {
    ok: false,
    status: 500,
    error: {
      code: 'internal',
      message:
        err instanceof Error
          ? `${method}: ${err.message}`
          : `${method}: ${String(err)}`,
    },
  };
};

/** Build a dispatcher from a handler registry + optional gates.
 *
 *  The registry is partial: any method not present resolves to
 *  `not_configured`. Combined with typed request/response flow from
 *  contracts, this replaces the pre-existing `switch (method)` with
 *  a flat lookup + one gate block. */
export const createRpcDispatcher = <R extends RpcRegistry, Ctx>(
  registry: HandlerRegistry<R, Ctx>,
  gates: DispatcherGates = {},
): RpcDispatcher<Ctx> => {
  const options = gates;
  return async (method, args, ctx) => {
    // Lifecycle gate (Phase C) — block non-exempt methods while
    // booting or draining. Exempt set covers status + lifecycle
    // reads so operators can diagnose during the window.
    if (gates.lifecycleState) {
      const state = gates.lifecycleState();
      if (state !== 'running' && !LIFECYCLE_ALLOWED_METHODS.has(method)) {
        if (state === 'booting') return notReady(method);
        // draining / restarting / shutting_down / crashed all look
        // the same from the caller's POV — the server is winding down.
        return draining(method);
      }
    }

    // Maintenance gate — block everything except migration-allowed
    // methods while a re-encryption is underway.
    if (gates.migrationActive?.() && !MIGRATION_ALLOWED_METHODS.has(method)) {
      return migrationInProgress();
    }

    // Auto-lock idle-timer reset (skip state-polling calls).
    if (gates.touchActivity && !AUTO_LOCK_IDLE_EXEMPT.has(method)) {
      gates.touchActivity();
    }

    const handler = (registry as Record<string, RpcHandlerFn<Ctx> | undefined>)[method as string];
    if (handler === undefined) {
      // Whether the method is "truly unknown" vs "known but no deps
      // wired" is ambiguous at runtime — HandlerRegistry is sparse by
      // design. Callers may pass `knownMethods` to disambiguate, but
      // by default we prefer `not_configured` since almost every real
      // missing-handler case is a features-off-at-this-server one.
      return options.knownMethods && !options.knownMethods.has(method)
        ? unknownMethod(method)
        : notConfigured(method);
    }

    try {
      const result = await handler(args, ctx);
      return { ok: true, status: 200, body: result };
    } catch (err) {
      return thrownToResult(err, method);
    }
  };
};

/** Narrowed runtime type alias used internally by the dispatcher. */
type RpcHandlerFn<Ctx> = (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;
