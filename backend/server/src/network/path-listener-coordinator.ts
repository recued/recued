/** D-148 § A.7.4 / W3.5b — production `PathListenerCoordinator` adapter.
 *
 *  The `ExposureStateMachine` (`../exposure/`) treats listener-set
 *  rebinds as an injected side-effect via `PathListenerCoordinator.apply({
 *  resolution, bind_addresses })`. W3.5 shipped the seam + test stubs;
 *  W3.5b wires the production binding that owns the actual `PathListenerSet`
 *  from `@recued/server-tls` and applies the new resolution by closing the
 *  current set + constructing a new one with the same handler map.
 *
 *  Rebind semantics (§ A.7.4):
 *
 *  1. Stop the current listener set (graceful close; pending requests
 *     drain). The state machine has already emitted the high-assurance
 *     audit row by the time this is called (Codex P1 #1 fold carried
 *     forward from W2.x).
 *  2. Build a fresh `createPathListenerSet` with the new `resolution` +
 *     same handlers + same legacy aliases. Listener bind happens lazily
 *     inside `set.start()`.
 *  3. Return per-listener bind status. Bind failures land here (port-in-use,
 *     EACCES, etc.) and surface in `PathListenerCoordinatorStatus.failure`;
 *     the state machine records the failure in `per_path` without aborting
 *     the transition.
 *
 *  Lifecycle:
 *  - `start()` is called once at boot from bin.ts BEFORE the state machine
 *    runs `reapply()`. The initial listener set comes up against the
 *    persisted resolution.
 *  - `apply(...)` is called on every state-machine transition.
 *  - `stop()` is called on shutdown by bin.ts.
 *
 *  Channel-isolation invariant preserved: the per-role handler map is
 *  captured at boot time + never mutated; each apply() reconstructs the
 *  listener set with the same handlers, only the resolution changes. */

import type {
  PathListenerCoordinator,
  PathListenerCoordinatorStatus,
} from '../exposure/index.js';
import {
  createPathListenerSet,
  type CertChainHolder,
  type HostnameSniBindingLookup,
  type PathListenerSet,
  type PathListenerStatus,
  type PathRouterLegacyAlias,
  type PortRequestHandler,
  type PortUpgradeHandler,
} from '@recued/server-tls';
import type { PathRole, TLSDomainCertChain } from '@recued/contracts';

export interface ProductionPathListenerCoordinatorOptions {
  /** Per-role handler map. Captured at construction; never mutated. */
  handlers: Partial<Record<PathRole, PortRequestHandler>>;
  /** Per-role upgrade handler map. */
  upgradeHandlers: Partial<Record<PathRole, PortUpgradeHandler>>;
  /** Legacy path alias table (W3.5b scaffolding — retires alongside path
   *  renames in a follow-up). */
  legacyAliases?: ReadonlyArray<PathRouterLegacyAlias>;
  /** D-148 follow-up #7 — bare-root request handler. Threaded onto the
   *  public listener via `PathListenerSetOptions.rootHandler` on every
   *  rebuild. Captured at construction; never mutated across rebinds
   *  so the redirect surface is stable. Absent → public-listener bare
   *  `/` 404s. */
  rootHandler?: PortRequestHandler;
  /** Offline-pairing convenience — bare-root handler threaded onto the LAN
   *  listener only (mirror of `rootHandler`). Production supplies a
   *  302-to-`/webclient/` redirect gated on a verified webclient bundle
   *  being present, so a self-hoster's bare LAN `/` lands them on the
   *  embedded webclient to pair offline. Absent → LAN bare `/` 404s. */
  lanRootHandler?: PortRequestHandler;
  /** Shared TLS cert holder. Pointer-swap rotation propagates through the
   *  public listener's `SNICallback`. Null/empty holder → public listener
   *  binds plaintext (upstream-proxy mode). */
  cert_chain: CertChainHolder;
  /** Optional D-152 hostname registry lookup. When supplied, public TLS
   *  SNI selection first checks the hostname registry's enabled +
   *  ownership-verified binding before reading cert material. */
  hostname_binding_lookup?: HostnameSniBindingLookup;
  /** Optional D-148 TLS-domain cert lookup used by SNI dispatch. */
  tls_domain_lookup?: (servername: string) => TLSDomainCertChain | null;
  /** LAN listener port. Defaults to standard port 80 per spec § A.6.
   *  Tests / dev override to 0 (OS-picked). */
  lan_port?: number;
  /** Public listener port. Defaults to standard port 443 per spec § A.6. */
  public_port?: number;
  /** Optional structured logger forwarded to the listener set. */
  log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    data?: Record<string, unknown>,
  ) => void;
}

export interface ProductionPathListenerCoordinator extends PathListenerCoordinator {
  /** Per-listener status snapshot (LAN + public). Reads in-memory state. */
  status(): PathListenerStatus[];
  /** Graceful close. Idempotent. */
  stop(): Promise<void>;
}

/** Build the production coordinator. Owns the active `PathListenerSet`
 *  reference; `apply()` rebuilds the set with the new resolution. */
export const createProductionPathListenerCoordinator = (
  opts: ProductionPathListenerCoordinatorOptions,
): ProductionPathListenerCoordinator => {
  const {
    handlers,
    upgradeHandlers,
    legacyAliases,
    rootHandler,
    lanRootHandler,
    cert_chain,
    hostname_binding_lookup,
    tls_domain_lookup,
    lan_port,
    public_port,
    log,
  } = opts;

  let active: PathListenerSet | null = null;
  let lastStatuses: PathListenerStatus[] = [];
  // Bind addresses the active set was constructed with. `applyResolution`
  // reconciles routing in place but CANNOT move a bound socket to a new
  // address — so if `apply()` is ever called with different bind addresses
  // (boot-fixed today, but the seam is generic), the in-place path would
  // silently keep the old addresses. Track them to detect the change and
  // fall back to a full rebuild instead.
  let activeBind: { lan: string; public: string } | null = null;
  // ⛔ THERE IS NO `activePorts`, AND ITS ABSENCE IS DELIBERATE. One lived here,
  // documented as "tracked separately from `activeBind` because a port change
  // does NOT need the full rebuild an address change does" — and it was
  // WRITE-ONLY: assigned on start, cleared on stop, recomputed on every apply,
  // and read by nothing. Mutation exposed it: corrupting the value it carried
  // forward changed no behaviour any test or caller could see.
  //
  // ⚠ The decision it looked like it informed is made by `active ?
  // applyResolution : buildAndStart` — which keys on whether a set EXISTS, not
  // on which ports it holds. `activeBind` is the real twin: it IS read, to
  // detect an address change that needs a full rebuild.
  //
  // ⇒ State that looks like it tracks something, and does not, is worse than no
  // state: the next reader budgets for a port-change decision that was never
  // being made here.
  // Serialize rebinds — a concurrent `apply()` while a previous one is
  // still draining listeners would race the active reference + bind two
  // sets on the same port. The state machine's own concurrency guard
  // upstream prevents this in normal operation, but defense-in-depth
  // here keeps the coordinator safe under direct callers (smoke tests
  // exercising rapid resolution flips).
  let inflight: Promise<unknown> | null = null;

  const buildAndStart = async (
    resolution: Parameters<PathListenerCoordinator['apply']>[0]['resolution'],
    bind_addresses: Parameters<PathListenerCoordinator['apply']>[0]['bind_addresses'],
  ): Promise<PathListenerStatus[]> => {
    const set = createPathListenerSet({
      resolution,
      handlers,
      upgradeHandlers,
      ...(legacyAliases ? { legacyAliases } : {}),
      ...(rootHandler ? { rootHandler } : {}),
      ...(lanRootHandler ? { lanRootHandler } : {}),
      cert_chain,
      ...(hostname_binding_lookup ? { hostname_binding_lookup } : {}),
      ...(tls_domain_lookup ? { tls_domain_lookup } : {}),
      ...(lan_port !== undefined ? { lan_port } : {}),
      lan_bind_address: bind_addresses.lan,
      ...(public_port !== undefined ? { public_port } : {}),
      public_bind_address: bind_addresses.public,
      ...(log ? { log } : {}),
    });
    const statuses = await set.start();
    active = set;
    activeBind = { lan: bind_addresses.lan, public: bind_addresses.public };
    lastStatuses = statuses;
    return statuses;
  };

  const stopActive = async (): Promise<void> => {
    const set = active;
    active = null;
    activeBind = null;
    if (set) {
      try {
        await set.stop();
      } catch (err) {
        log?.('warn', 'path listener stop failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    while (inflight) {
      try { await inflight; } catch { /* observe + serialize */ }
    }
    const p = (async () => fn())();
    inflight = p;
    try {
      return await p;
    } finally {
      if (inflight === p) inflight = null;
    }
  };

  const toCoordinatorStatus = (status: PathListenerStatus): PathListenerCoordinatorStatus => ({
    listening: status.listening,
    bind_address: status.bind_address,
    ...(status.failure ? { failure: status.failure } : {}),
  });

  return {
    apply: ({ resolution, bind_addresses, ports }) =>
      guarded(async () => {
        // D-148 exposure-flip robustness — when a set is already running,
        // reconcile it IN PLACE rather than tearing the whole thing down
        // and rebuilding. The old destroy-then-recreate path called
        // `set.stop()` (→ `server.close()`) on the live LAN listener,
        // which BLOCKS FOREVER on the operator's never-draining control
        // WS — wedging the rebind so the LAN socket closes (new connects
        // refused) but never comes back. `applyResolution` updates routing
        // through the live dispatcher and only binds/unbinds a listener
        // whose bind decision actually flipped, so a path content-flip
        // (e.g. reception on, LAN already up) touches no socket at all.
        //
        // A bind-address change can't be honored in place (a bound socket
        // can't move addresses) — fall back to a full rebuild then. Bind
        // addresses are boot-fixed today, so this is defense in depth; the
        // in-place path is what every normal flip takes.
        const bindChanged =
          activeBind !== null &&
          (activeBind.lan !== bind_addresses.lan ||
            activeBind.public !== bind_addresses.public);
        if (bindChanged) await stopActive();
        // ⛔ A PORT CHANGE IS *NOT* AN ADDRESS CHANGE. An address change tears
        // the whole set down, which the comment above warns can wedge on the
        // operator's never-draining control WS. A port change goes through
        // `applyResolution`, which stops and rebinds ONLY the listener whose
        // port moved and leaves the other serving — so changing `public_port`
        // never touches the LAN socket the owner may be connected through.
        const effectivePorts = {
          ...(ports?.lan !== undefined ? { lan: ports.lan } : {}),
          ...(ports?.public !== undefined ? { public: ports.public } : {}),
        };
        const statuses = active
          ? await active.applyResolution(resolution, effectivePorts)
          : await buildAndStart(resolution, bind_addresses);
        lastStatuses = statuses;
        const lan = statuses.find((s) => s.listener === 'lan');
        const pub = statuses.find((s) => s.listener === 'public');
        // Both slots always populate — `start()` returns one row per
        // listener. Defensive defaults in case the substrate ever
        // changes to skip a row (currently it doesn't).
        return {
          lan: lan ? toCoordinatorStatus(lan) : { listening: false, bind_address: null },
          public: pub ? toCoordinatorStatus(pub) : { listening: false, bind_address: null },
        };
      }),
    status: () => lastStatuses,
    stop: () => guarded(stopActive),
  };
};
