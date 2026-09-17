/** D-148 § A.7 — Per-path Exposure state machine (Amendment 2026-05-11; W3.5).
 *
 *  The user toggles per-path resolution OR snaps the toggle grid to a
 *  named preset in Settings → Server → Exposure; this module is the
 *  server-side authority that:
 *
 *    1. Validates the requested transition (DDNS available when any
 *       path would resolve `public`; public-MCP requires acknowledgement;
 *       `/ws` going fully off requires the lockout confirmation phrase).
 *    2. Re-resolves per-path `(lan; public)` state via the contracts
 *       helpers (`applyPreset` / `applyPathResolution`).
 *    3. Calls back to the listener-set substrate to bind / unbind the
 *       two listeners per the new aggregate (`anyPathLan` / `anyPathPublic`).
 *    4. Stamps a high-assurance audit row signed with
 *       `server_identity_key` (action `exposure_path_resolution_change` /
 *       `exposure_preset_apply` / `public_mcp_acknowledged` /
 *       `public_mcp_revoked`).
 *    5. Broadcasts an `exposure_changed` event so connected clients
 *       refresh their Reachability Doctor + connection assumptions.
 *
 *  The state machine itself is small + deterministic. The interesting
 *  surface is the side-effect coordination: listener rebinds, audit
 *  signing, broadcast propagation. W3.5 ships these in lockstep —
 *  starting a public listener without the matching audit row would
 *  break compliance, and the reverse would lie to clients.
 *
 *  Pre-launch zero-installs policy (per CLAUDE.md): the legacy 5-profile
 *  state machine retires outright in this slice; no compat shim, no
 *  migration code.
 */

import {
  PATH_ROLES,
  totalRecord,
  DEFAULT_PATH_RESOLUTION,
  EXPOSURE_PRESETS,
  applyPreset as projectPreset,
  applyPathResolution as projectPathResolution,
  deriveLabel,
  anyPathLan,
  anyPathPublic,
  isAcknowledgementWellFormed,
  isValidPublicMcpAcknowledgementPhrase,
  isValidWsLockoutPhrase,
  requiredWsLockoutPhrase,
  requiresPublicMcpAcknowledgementForResolution,
  type ExposureChangedEvent,
  type ExposurePreset,
  type ExposureState,
  type NetworkErrorCode,
  type PathResolution,
  type PathRole,
  type PublicMcpAcknowledgement,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// External substrate hooks
// ────────────────────────────────────────────────────────────────

/** Persistence boundary for the exposure state. W3.5 ships an in-memory
 *  implementation; production wires through SQLite via the D-148 P5
 *  `server_state` table (single-row, server-internal). */
export interface ExposureStateStore {
  load(): Promise<ExposureState | null>;
  save(state: ExposureState): Promise<void>;
}

/** Per-listener bind status returned by the listener coordinator. Mirrors
 *  the `PathListenerStatus` shape from `@recued/server-tls` without
 *  importing it (the substrate stays decoupled from the listener layer
 *  for testability — the coordinator is the seam). */
export interface PathListenerCoordinatorStatus {
  listening: boolean;
  bind_address: string | null;
  failure?: string;
}

/** Listener-set substrate hook. The state machine asks the listener
 *  coordinator to rebind both listeners (LAN + public) per the new
 *  per-path resolution. The coordinator returns per-listener status so
 *  the state machine can record bind failures in the persisted state
 *  without aborting the transition (audit + broadcast still record
 *  user intent). */
export interface PathListenerCoordinator {
  /** Apply the resolved per-path table to the live listener set.
   *  Returns the per-listener status (lan + public). */
  apply(args: {
    resolution: Record<PathRole, PathResolution>;
    bind_addresses: { lan: string; public: string };
    /** ⚠ LIVE PORTS, omitted ⇒ the ones the coordinator was built with.
     *  A changed port rebinds ONLY that listener — see the coordinator. */
    ports?: { lan?: number; public?: number };
  }): Promise<{
    lan: PathListenerCoordinatorStatus;
    public: PathListenerCoordinatorStatus;
  }>;
}

/** Audit + broadcast hooks. The state machine emits one high-assurance
 *  audit row + an `exposure_changed` broadcast per transition; this
 *  module only formats — actual persistence + fan-out is the caller's. */
export interface ExposureSideEffects {
  recordAudit(payload: {
    action:
      | 'exposure_path_resolution_change'
      | 'exposure_preset_apply'
      | 'public_mcp_acknowledged'
      | 'public_mcp_revoked';
    resolution: Record<PathRole, PathResolution>;
    derived_preset_label: ExposureState['derived_preset_label'];
    public_mcp_acknowledgement: PublicMcpAcknowledgement;
    changed_by_client_id: string;
    reason?: string;
    /** Free-text confirmation phrase the user typed at the gate.
     *  Carried in the audit-row provenance bundle for compliance
     *  review. Set on `exposure_preset_apply` (when the preset
     *  threaded an ack), `public_mcp_acknowledged`, and on a
     *  `set_path_resolution` call against `/ws` that triggered the
     *  lockout gate (Mary typed `disconnect webclients` or
     *  `disable ws`). */
    free_text_confirmation?: string;
    /** Targeted path on `exposure_path_resolution_change`; unset on
     *  the preset / public-MCP actions. */
    path?: PathRole;
    /** New per-path resolution applied on
     *  `exposure_path_resolution_change`; unset on the preset /
     *  public-MCP actions. */
    next_resolution?: PathResolution;
    /** Active client count at lockout-gate evaluation time. Useful
     *  for compliance review (`disconnect webclients` flavor required
     *  the threshold to be > 0). */
    active_ws_connections?: number;
  }): Promise<void>;
  broadcast(event: ExposureChangedEvent): Promise<void>;
}

/** DDNS availability probe. Public-path resolutions require a reachable
 *  DDNS handle (Pro recued.cloud OR user-configured DDNS adapter). The
 *  state machine refuses transitions that would resolve any path to
 *  `public === true` when the probe reports unavailable. */
export interface DdnsAvailability {
  isConfigured(): Promise<boolean>;
}

/** Active WS connection count probe. Used by the `/ws` lockout gate
 *  (§ A.6.6) to pick the `'disconnect webclients'` vs `'disable ws'`
 *  phrase. Optional — when absent, the gate assumes zero (lighter
 *  `disable ws` phrase). */
export interface ActiveWsConnections {
  count(): number;
}

/** Clock injection. Defaults to `Date.now`; tests pin the value. */
export type Clock = () => number;

// ────────────────────────────────────────────────────────────────
// Default in-memory store (testing + bootstrapping)
// ────────────────────────────────────────────────────────────────

export const createInMemoryExposureStore = (
  initial?: ExposureState,
): ExposureStateStore => {
  let state: ExposureState | null = initial ?? null;
  return {
    async load() {
      return state ? cloneState(state) : null;
    },
    async save(next) {
      state = cloneState(next);
    },
  };
};

const cloneResolution = (
  src: Record<PathRole, PathResolution>,
): Record<PathRole, PathResolution> => {
  return totalRecord(PATH_ROLES, (role) => ({
    lan: src[role].lan,
    public: src[role].public,
  }));
};

const cloneState = (state: ExposureState): ExposureState => ({
  resolution: cloneResolution(state.resolution),
  derived_preset_label: state.derived_preset_label,
  public_mcp_acknowledgement: { ...state.public_mcp_acknowledgement },
  last_changed_at: state.last_changed_at,
  changed_by_client_id: state.changed_by_client_id,
  ...(state.reason !== undefined ? { reason: state.reason } : {}),
});

/** Default exposure state shipped at first boot — matches the `lan_only`
 *  preset shape (LAN-only on /health + /ws + /mcp; /webhooks +
 *  /reception off; no ack). */
export const DEFAULT_EXPOSURE_STATE: ExposureState = {
  resolution: cloneResolution(DEFAULT_PATH_RESOLUTION),
  derived_preset_label: 'lan_only',
  public_mcp_acknowledgement: { acknowledged: false },
  last_changed_at: 0,
  changed_by_client_id: '',
};

// ────────────────────────────────────────────────────────────────
// State-machine API
// ────────────────────────────────────────────────────────────────

export interface ExposureStateMachineOptions {
  store: ExposureStateStore;
  listener: PathListenerCoordinator;
  effects: ExposureSideEffects;
  ddns: DdnsAvailability;
  /** Bind addresses applied to the LAN + public listeners. The state
   *  machine doesn't probe interfaces here — caller computes the
   *  detected primary LAN IP per § A.7.5 (see `resolveLanAddress` in
   *  `../network/resolve-lan-address.ts`) and refreshes when topology
   *  changes. */
  bind_addresses: { lan: string; public: string };
  /** Active WS connection probe. Drives the `/ws` lockout gate's
   *  phrase selection (§ A.6.6). Optional — absent → zero. */
  activeWsConnections?: ActiveWsConnections;
  clock?: Clock;
}

export interface ApplyPresetArgs {
  preset: ExposurePreset;
  /** Required when the preset's projected resolution would drop
   *  `/ws` to `{ lan: false, public: false }` while the current
   *  state has either bit true. Same closed-list phrases as
   *  `setPathResolution`'s lockout gate (§ A.6.6) — `'disconnect
   *  webclients'` when active clients > 0, `'disable ws'` when 0.
   *  The `maintenance` preset is the canonical caller of this
   *  parameter; the `lan_only` / `public` presets keep `/ws` enabled
   *  and don't trip the gate. */
  lockout_confirmation_phrase?: string;
  changed_by_client_id: string;
  reason?: string;
}

export interface SetPathResolutionArgs {
  path: PathRole;
  resolution: PathResolution;
  /** Required when the transition would set `/ws` to
   *  `{ lan: false, public: false }`. Spec § A.6.6 closed phrases:
   *  `'disconnect webclients'` (active WS > 0) or `'disable ws'`
   *  (active WS == 0). */
  lockout_confirmation_phrase?: string;
  changed_by_client_id: string;
  reason?: string;
}

export interface SetPublicMcpArgs {
  acknowledge: boolean;
  /** Required when `acknowledge === true`. Validated against
   *  `PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE` per § A.7.2. */
  free_text_confirmation?: string;
  changed_by_client_id: string;
  reason?: string;
}

export type ExposureMutationResult =
  | { ok: true; state: ExposureState }
  | {
      ok: false;
      error: NetworkErrorCode;
      /** Set on `ws_lockout_unconfirmed` so the UI knows which phrase
       *  flavor to surface + how many clients the gate is about to
       *  disconnect. */
      ws_lockout_required_phrase?: string;
      ws_lockout_active_clients?: number;
    };

export interface ExposureStateMachine {
  /** Read the current state (lazy-loads + initialises from default
   *  on first call). */
  current(): Promise<ExposureState>;
  /** Apply the current state to the listener set (used at boot to
   *  bring listeners up at the persisted resolution). Same flow as
   *  `applyPreset` / `setPathResolution` minus the validation + audit
   *  emit. */
  reapply(): Promise<ExposureState>;
  /** Snap the toggle grid to a named preset. Threads the active
   *  acknowledgement so `applyPreset('public', ...)` only flips
   *  `/mcp.public` when ack is well-formed; otherwise it stays false
   *  and the rpc returns ok + leaves the modal surface to the caller
   *  per § A.7.2. */
  applyPreset(args: ApplyPresetArgs): Promise<ExposureMutationResult>;
  /** Single-path mutation. Enforces the public-MCP ack gate (when
   *  promoting `/mcp.public`) and the `/ws` lockout phrase gate. */
  setPathResolution(args: SetPathResolutionArgs): Promise<ExposureMutationResult>;
  /** Toggle the public-MCP acknowledgement (the only path that can
   *  flip `/mcp.public = true`). Demotion (acknowledge=false) always
   *  allowed. Side-effect: when the user de-acknowledges, the
   *  resolution's `mcp.public` bit is forced false (defense-in-depth). */
  setPublicMcpAcknowledgement(
    args: SetPublicMcpArgs,
  ): Promise<ExposureMutationResult>;
}

const requiresAnyPublic = (
  resolution: Record<PathRole, PathResolution>,
): boolean => anyPathPublic(resolution);

export const createExposureStateMachine = (
  opts: ExposureStateMachineOptions,
): ExposureStateMachine => {
  const clock = opts.clock ?? Date.now;
  let cached: ExposureState | null = null;
  // Single in-flight transition guard. Concurrent calls serialize
  // through this lock — the second caller observes the first call's
  // result via `current()` after the first completes.
  let inflight: Promise<unknown> | null = null;

  const loadOrInit = async (): Promise<ExposureState> => {
    if (cached) return cached;
    const persisted = await opts.store.load();
    cached = persisted ?? cloneState(DEFAULT_EXPOSURE_STATE);
    return cached;
  };

  const applyTransition = async (
    nextResolution: Record<PathRole, PathResolution>,
    nextAck: PublicMcpAcknowledgement,
    changed_by_client_id: string,
    reason: string | undefined,
    auditAction: ExposureSideEffects extends {
      recordAudit(payload: infer P): infer _R;
    }
      ? Extract<P, { action: unknown }>['action']
      : never,
    auditOnly: boolean,
    extraAuditFields?: {
      path?: PathRole;
      next_resolution?: PathResolution;
      free_text_confirmation?: string;
      active_ws_connections?: number;
    },
  ): Promise<ExposureState> => {
    const derived_preset_label = deriveLabel(nextResolution, nextAck);
    // Codex P1 #1 fold carried forward — emit the high-assurance audit
    // row BEFORE applying the listener changes. Spec § A.7.4 makes
    // audit + listener one transition; failing audit must abort the
    // whole transition (otherwise we'd bind public listeners with no
    // signed record). Persist + broadcast happen after listeners apply
    // (so the recorded state matches the live binding); listener-bind
    // failure surfaces in `per_path_state` per § A.18 graceful
    // degradation.
    if (!auditOnly) {
      await opts.effects.recordAudit({
        action: auditAction,
        resolution: cloneResolution(nextResolution),
        derived_preset_label,
        public_mcp_acknowledgement: { ...nextAck },
        changed_by_client_id,
        ...(reason !== undefined ? { reason } : {}),
        ...(extraAuditFields ?? {}),
      });
    }
    await opts.listener.apply({
      resolution: nextResolution,
      bind_addresses: opts.bind_addresses,
    });
    const next: ExposureState = {
      resolution: cloneResolution(nextResolution),
      derived_preset_label,
      public_mcp_acknowledgement: { ...nextAck },
      last_changed_at: clock(),
      changed_by_client_id,
      ...(reason !== undefined ? { reason } : {}),
    };
    await opts.store.save(next);
    cached = next;
    if (!auditOnly) {
      await opts.effects.broadcast({
        type: 'exposure_changed',
        resolution: cloneResolution(nextResolution),
        derived_preset_label,
        public_mcp_acknowledgement: { ...nextAck },
        changed_at: next.last_changed_at,
        changed_by_client_id,
      });
    }
    return next;
  };

  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    while (inflight) {
      try {
        await inflight;
      } catch {
        // Previous transition's failure shouldn't block ours; we
        // still serialize but observe the outcome.
      }
    }
    const p = (async () => fn())();
    inflight = p;
    try {
      return await p;
    } finally {
      if (inflight === p) inflight = null;
    }
  };

  const activeClients = (): number => {
    try {
      return opts.activeWsConnections?.count() ?? 0;
    } catch {
      return 0;
    }
  };

  return {
    current: loadOrInit,

    reapply: () =>
      guarded(async () => {
        const state = await loadOrInit();
        return applyTransition(
          state.resolution,
          state.public_mcp_acknowledgement,
          state.changed_by_client_id || 'system',
          state.reason,
          'exposure_preset_apply',
          true,
        );
      }),

    applyPreset: ({ preset, lockout_confirmation_phrase, changed_by_client_id, reason }) =>
      guarded<ExposureMutationResult>(async () => {
        if (!(EXPOSURE_PRESETS as ReadonlyArray<ExposurePreset>).includes(preset)) {
          return { ok: false, error: 'preset_unknown' };
        }
        const state = await loadOrInit();
        const projected = projectPreset(preset, state.public_mcp_acknowledgement);
        // /ws lockout gate (§ A.6.6) — Codex W3.5 P1 fold. The gate
        // exists on `setPathResolution`; a preset projection that
        // drops `/ws` to fully-off without the confirmation phrase
        // would otherwise bypass it. Apply the same check on
        // `applyPreset` whenever the projection moves `/ws` from
        // any reachable state to `{ lan: false, public: false }`.
        // `lan_only` / `public` keep `/ws` enabled; only
        // `maintenance` trips this in the closed preset list.
        const currentWs = state.resolution.ws;
        const nextWs = projected.ws;
        const wsGoingFullyOff = !nextWs.lan && !nextWs.public && (currentWs.lan || currentWs.public);
        let lockoutPhraseEcho: string | undefined;
        if (wsGoingFullyOff) {
          const active = activeClients();
          const required = requiredWsLockoutPhrase({
            next_resolution: nextWs,
            active_ws_connections: active,
          });
          if (required) {
            if (
              !lockout_confirmation_phrase
              || !isValidWsLockoutPhrase(lockout_confirmation_phrase, required)
            ) {
              return {
                ok: false,
                error: lockout_confirmation_phrase
                  ? 'ws_lockout_phrase_mismatch'
                  : 'ws_lockout_unconfirmed',
                ws_lockout_required_phrase: required,
                ws_lockout_active_clients: active,
              };
            }
            lockoutPhraseEcho = lockout_confirmation_phrase;
          }
        }
        // DDNS gate — any path resolving to `public === true` requires
        // DDNS configured (otherwise the public listener has nothing
        // routable to bind under).
        if (requiresAnyPublic(projected)) {
          const ddns = await opts.ddns.isConfigured();
          if (!ddns) {
            return { ok: false, error: 'preset_unachievable_no_ddns' };
          }
        }
        const active = activeClients();
        const next = await applyTransition(
          projected,
          state.public_mcp_acknowledgement,
          changed_by_client_id,
          reason,
          'exposure_preset_apply',
          false,
          {
            ...(lockoutPhraseEcho !== undefined
              ? { free_text_confirmation: lockoutPhraseEcho }
              : {}),
            ...(wsGoingFullyOff ? { active_ws_connections: active } : {}),
          },
        );
        return { ok: true, state: next };
      }),

    setPathResolution: ({
      path,
      resolution,
      lockout_confirmation_phrase,
      changed_by_client_id,
      reason,
    }) =>
      guarded<ExposureMutationResult>(async () => {
        if (!(PATH_ROLES as ReadonlyArray<PathRole>).includes(path)) {
          return { ok: false, error: 'path_unknown' };
        }
        const state = await loadOrInit();
        const current = state.resolution[path];
        // /mcp.public ack gate — refuse promotion without a well-formed
        // acknowledgement. Demotion (public bit going false) never
        // demands the gate.
        if (
          requiresPublicMcpAcknowledgementForResolution({
            path,
            next_resolution: resolution,
            current_resolution: current,
          })
        ) {
          if (!isAcknowledgementWellFormed(state.public_mcp_acknowledgement)) {
            return { ok: false, error: 'public_mcp_not_acknowledged' };
          }
          if (!state.public_mcp_acknowledgement.acknowledged) {
            return { ok: false, error: 'public_mcp_not_acknowledged' };
          }
        }
        // /ws lockout gate (§ A.6.6) — when the target leaves both
        // bits false, demand the confirmation phrase appropriate to
        // the active-client count.
        let lockoutPhraseEcho: string | undefined;
        if (path === 'ws') {
          const active = activeClients();
          const required = requiredWsLockoutPhrase({
            next_resolution: resolution,
            active_ws_connections: active,
          });
          if (required) {
            if (
              !lockout_confirmation_phrase
              || !isValidWsLockoutPhrase(lockout_confirmation_phrase, required)
            ) {
              return {
                ok: false,
                error: lockout_confirmation_phrase
                  ? 'ws_lockout_phrase_mismatch'
                  : 'ws_lockout_unconfirmed',
                ws_lockout_required_phrase: required,
                ws_lockout_active_clients: active,
              };
            }
            lockoutPhraseEcho = lockout_confirmation_phrase;
          }
        }
        const projected = projectPathResolution(state.resolution, path, resolution);
        // DDNS gate — applied to the RESOLVED table, not just the
        // target path. Toggling /webhooks public on a server without
        // DDNS is refused even when /webhooks was the path the user
        // touched.
        if (requiresAnyPublic(projected)) {
          const ddns = await opts.ddns.isConfigured();
          if (!ddns) {
            return { ok: false, error: 'preset_unachievable_no_ddns' };
          }
        }
        const active = activeClients();
        const next = await applyTransition(
          projected,
          state.public_mcp_acknowledgement,
          changed_by_client_id,
          reason,
          'exposure_path_resolution_change',
          false,
          {
            path,
            next_resolution: { lan: resolution.lan, public: resolution.public },
            ...(lockoutPhraseEcho !== undefined
              ? { free_text_confirmation: lockoutPhraseEcho }
              : {}),
            ...(path === 'ws' ? { active_ws_connections: active } : {}),
          },
        );
        return { ok: true, state: next };
      }),

    setPublicMcpAcknowledgement: ({
      acknowledge,
      free_text_confirmation,
      changed_by_client_id,
      reason,
    }) =>
      guarded<ExposureMutationResult>(async () => {
        const state = await loadOrInit();
        let nextAck: PublicMcpAcknowledgement;
        if (acknowledge) {
          if (typeof free_text_confirmation !== 'string') {
            return { ok: false, error: 'public_mcp_not_acknowledged' };
          }
          if (!isValidPublicMcpAcknowledgementPhrase(free_text_confirmation)) {
            return { ok: false, error: 'public_mcp_phrase_mismatch' };
          }
          nextAck = {
            acknowledged: true,
            acknowledged_at: clock(),
            acknowledged_by_client_id: changed_by_client_id,
            free_text_confirmation,
            ...(reason !== undefined ? { reason } : {}),
          };
        } else {
          nextAck = { acknowledged: false };
        }
        // Defense-in-depth: well-formedness must pass when ack=true.
        if (acknowledge && !isAcknowledgementWellFormed(nextAck)) {
          return { ok: false, error: 'public_mcp_phrase_mismatch' };
        }
        // Project a resolution that drops `/mcp.public` when ack is
        // revoked (demotion is always allowed; the bit cannot survive
        // an un-ack). The other paths' bits stay verbatim.
        let nextResolution = cloneResolution(state.resolution);
        if (!acknowledge && nextResolution.mcp.public) {
          nextResolution.mcp = { lan: nextResolution.mcp.lan, public: false };
        }
        // DDNS gate on the ack path. When acknowledging on a server
        // whose current resolution doesn't reach public anywhere, the
        // ack itself is harmless (no public path bound until the user
        // toggles `/mcp.public` separately). When acknowledging on a
        // server whose resolution would route MCP to public AND no
        // DDNS is configured, refuse so user intent matches achievable
        // reachability.
        //
        // To match the legacy flow's discipline (Codex P2 #4 fold),
        // we check the RESOLVED table — which under W3.5's per-path
        // model is just the current resolution.
        if (acknowledge && requiresAnyPublic(nextResolution)) {
          const ddns = await opts.ddns.isConfigured();
          if (!ddns) {
            return { ok: false, error: 'preset_unachievable_no_ddns' };
          }
        }
        const auditAction = acknowledge
          ? 'public_mcp_acknowledged'
          : 'public_mcp_revoked';
        const next = await applyTransition(
          nextResolution,
          nextAck,
          changed_by_client_id,
          reason,
          auditAction,
          false,
          {
            ...(acknowledge && free_text_confirmation !== undefined
              ? { free_text_confirmation }
              : {}),
          },
        );
        return { ok: true, state: next };
      }),
  };
};
