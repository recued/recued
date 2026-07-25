/** D-148 W3.5b / W3.9 / W3.10 — exposure-substrate composer.
 *
 *  Owns the cmdServe-side wiring that brings the `ExposureStateMachine`
 *  online + binds listeners at the persisted resolution. Three pieces:
 *
 *    1. **First-boot seed.** `deriveBootstrapDerivedExposureState`
 *       derives the initial `ExposureState` from the operator's explicit
 *       gestures — `bootstrap.webhook_port > 0` + `RECUED_PUBLIC_REACHABLE`.
 *       Without this seed the lan_only baseline keeps `webhooks.lan` +
 *       `webhooks.public` false, so the path-router 404s every legacy
 *       `/webhook/*` / `/hook/*` / `/v1/connection/webhook/*` ingress.
 *       With W3.9 persistence the seed is the FIRST-BOOT only — subsequent
 *       boots load Mary's persisted preset from SQLite.
 *
 *    2. **`--reset-exposure` failsafe.** W3.10 ships a one-shot CLI flag
 *       that discards the persisted row + re-derives from bootstrap. The
 *       only operator path that recovers from a `/ws` lockout (Mary typed
 *       the disconnect phrase + applied the maintenance preset; no other
 *       admin channel remains). The reset stamps an
 *       `EXPOSURE_RESET_AUDIT_ACTION` row through the high-assurance
 *       signed-audit path (D-148 follow-up #6) — verifiers see the row
 *       with `signature` + `signer_fingerprint` populated.
 *
 *    3. **Reapply + LAN bind assertion.** `reapply()` is the boot-time
 *       no-validation, no-audit path; it brings listeners up at the
 *       persisted resolution. Immediately afterwards
 *       `assertLanListenerBoundOrExit` fails boot (exit 4, matching the
 *       lifecycle-lock-fail code) when the LAN listener required by the
 *       resolution didn't bind — silent failure leaves Mary with no
 *       admin channel.
 *
 *  Audit + broadcast side effects are best-effort. The audit emitter
 *  swallows + logs failures so a thrown emit can't abort a state-machine
 *  transition (the machine's Codex P1 #1 fold places audit BEFORE listener
 *  apply, so a thrown audit error would prevent the bind). The broadcast
 *  emitter fans an `exposure_changed` event onto the D-121 bus via
 *  `emitExposureChanged` (M-XSURF-1) — paired clients refresh their
 *  connection assumptions off it; a missing bus or wedged push is a
 *  best-effort no-op. */

import type Database from 'better-sqlite3';
import type { AuditLogStore } from '@recued/storage';
import {
  createExposureStateMachine,
  createInMemoryExposureStore,
  type ExposureSideEffects,
  type ExposureStateMachine,
  type ExposureStateStore,
} from '../../exposure/index.js';
import {
  assertLanListenerBoundOrExit,
  deriveBootstrapDerivedExposureState,
} from '../../exposure/bootstrap.js';
import { createSqliteExposureStore } from '../../exposure/sqlite-store.js';
import {
  applyResetExposureBoot,
  EXPOSURE_RESET_AUDIT_ACTION,
} from '../../exposure/reset-flag.js';
import type { ProductionPathListenerCoordinator } from '../../network/path-listener-coordinator.js';
import { getFlag } from '../../cli/parse.js';
import { emitExposureChanged } from '../../events/emit-sites.js';
import type { EventBus } from '../../events/bus.js';

export interface ComposeExposureSubstrateInput {
  /** Raw `process.argv.slice(2)` — read once for the `--reset-exposure`
   *  flag. The composer never holds onto the array. */
  args: string[];
  /** When undefined (dbless harness) the composer falls back to the
   *  in-memory store; persisted-preset reload + `--reset-exposure` are
   *  no-ops in that mode. */
  db: Database.Database | undefined;
  /** `createSigningAuditLog`-wrapped audit log. Absent (dbless harness or
   *  composition without audit) → audit emits silently no-op. The four
   *  W3.5b exposure actions + the W3.10 reset are in
   *  `HIGH_ASSURANCE_AUDIT_KINDS` so the wrapped store signs each row
   *  with `server_identity_key` at emit time (D-148 follow-up #6). */
  auditLog: AuditLogStore | undefined;
  /** Production listener coordinator. The composer reads `.status()` once
   *  after `reapply()` to assert LAN bind succeeded. */
  listenerCoordinator: ProductionPathListenerCoordinator;
  /** `loadedConfig.bootstrap.webhook_port` — bootstrap-derived seed feeds
   *  `deriveBootstrapDerivedExposureState`. `> 0` flips webhook paths
   *  reachable on first boot. */
  webhookPort: number;
  /** Resolved LAN bind address (`resolveLanAddress().address`). */
  lanBindAddress: string;
  /** Live WS-handle client count getter. Threaded into the state machine
   *  as `activeWsConnections.count`. Late-bound by getter so the caller
   *  can wire the WS handle before the machine constructs. */
  wsHandleClientCount: () => number;
  /** D-121 realtime broadcast bus. The exposure `broadcast` side effect
   *  fans an `exposure_changed` event onto it per transition (M-XSURF-1)
   *  so paired clients refresh their connection assumptions. Absent
   *  (db-less harness or a composition path without a bus) → the
   *  broadcast effect is a best-effort no-op; the transition still
   *  commits + audits locally. */
  eventBus?: EventBus;
}

export interface ExposureSubstrateBundle {
  /** Live state machine — caller assigns to its `exposureMachineRef`
   *  late-binding ref so `exposure.*` rpc dispatch picks it up. The
   *  publish MUST land before `finalize()` runs: `reapply()` brings the
   *  LAN listener up + a WS upgrade arriving between bind + publish
   *  would route through the rpc thunk while `exposureMachineRef` is
   *  still undefined. The pre-extraction ordering closed that window
   *  by publishing before `reapply()`; the split-phase contract
   *  preserves it. */
  exposureMachine: ExposureStateMachine;
  /** Run `reapply()` to bring listeners up at the persisted resolution +
   *  assert the LAN listener bound (process.exit(4) on failure). MUST
   *  be called after the caller publishes `exposureMachine` into its
   *  late-bound ref. Idempotent — `reapply()` is the no-audit boot
   *  path; a second call would just re-apply the same resolution. */
  finalize: () => Promise<void>;
}

export const composeExposureSubstrate = async (
  input: ComposeExposureSubstrateInput,
): Promise<ExposureSubstrateBundle> => {
  const {
    args,
    db,
    auditLog,
    listenerCoordinator,
    webhookPort,
    lanBindAddress,
    wsHandleClientCount,
    eventBus,
  } = input;

  // Codex W3.5b P1 fold — derive the initial resolution from explicit
  // operator gestures so the wired webhook + hook listeners are actually
  // reachable. The bootstrap-derived shape is the FIRST-BOOT seed only —
  // subsequent boots load Mary's chosen preset from SQLite. The env-var
  // route stays for legacy self-host config but it no longer overrides a
  // persisted choice.
  const RECUED_PUBLIC_REACHABLE_ENV = process.env.RECUED_PUBLIC_REACHABLE;
  const publicReachableFlag =
    RECUED_PUBLIC_REACHABLE_ENV === 'true' || RECUED_PUBLIC_REACHABLE_ENV === '1';
  const initialExposureState = deriveBootstrapDerivedExposureState({
    webhook_port: webhookPort,
    public_reachable: publicReachableFlag,
  });

  // W3.10 — `--reset-exposure` is the operator failsafe for /ws lockout
  // (Mary typed the disconnect phrase + applied maintenance preset; no
  // other admin channel remains). The helper discards the persisted row
  // and re-derives from the bootstrap state. One-shot — a subsequent
  // restart without the flag loads the recovered state normally.
  const resetExposureRequested = getFlag(args, 'reset-exposure');
  let exposureStore: ExposureStateStore;
  if (db) {
    const sqliteStore = createSqliteExposureStore(db);
    // `exposure_reset_via_cli` is in HIGH_ASSURANCE_AUDIT_KINDS so the
    // wrapped audit log stamps an Ed25519 signature from
    // `server_identity_key` automatically. Same path applies to the four
    // W3.5b exposure actions (`exposure_path_resolution_change` /
    // `exposure_preset_apply` / `public_mcp_acknowledged` /
    // `public_mcp_revoked`) emitted through `exposureEffects.recordAudit`
    // below.
    const resetOutcome = await applyResetExposureBoot({
      store: sqliteStore,
      bootstrap: initialExposureState,
      resetRequested: resetExposureRequested,
      log: (msg) => console.warn(msg),
      recordAudit: async (payload) => {
        if (!auditLog) return;
        await auditLog.logActivity({
          activity_id: `exposure:${payload.action}:${payload.applied_at}`,
          timestamp: payload.applied_at,
          action: payload.action,
          target: 'exposure',
          detail: JSON.stringify({
            resolution: payload.resolution,
            changed_by_client_id: payload.changed_by_client_id,
            reason: payload.reason,
          }),
        });
      },
    });
    if (resetOutcome.reset) {
      console.warn(
        `[exposure] --reset-exposure: ${EXPOSURE_RESET_AUDIT_ACTION} stamped (audit emit best-effort). Restart without the flag to resume normal boot.`,
      );
    }
    exposureStore = sqliteStore;
  } else {
    exposureStore = createInMemoryExposureStore(initialExposureState);
  }

  const exposureEffects: ExposureSideEffects = {
    recordAudit: async (payload) => {
      // Best-effort high-assurance audit emit. Failure here does NOT
      // abort the transition; the state machine's Codex P1 #1 fold is
      // that audit precedes listener apply, so a thrown error here would
      // prevent the bind. The four exposure actions are in
      // HIGH_ASSURANCE_AUDIT_KINDS so the wrapped `auditLog` signs each
      // row at emit time (D-148 follow-up #6).
      if (auditLog) {
        try {
          await auditLog.logActivity({
            activity_id: `exposure:${payload.action}:${Date.now()}`,
            timestamp: Date.now(),
            action: payload.action,
            target: payload.path ?? 'exposure',
            detail: JSON.stringify({
              resolution: payload.resolution,
              derived_preset_label: payload.derived_preset_label,
              public_mcp_acknowledged: payload.public_mcp_acknowledgement.acknowledged,
              ...(payload.next_resolution !== undefined
                ? { next_resolution: payload.next_resolution }
                : {}),
              changed_by_client_id: payload.changed_by_client_id,
              ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
              ...(payload.free_text_confirmation !== undefined
                ? { free_text_confirmation: payload.free_text_confirmation }
                : {}),
              ...(payload.active_ws_connections !== undefined
                ? { active_ws_connections: payload.active_ws_connections }
                : {}),
            }),
          });
        } catch (err) {
          console.warn('[exposure] audit emit failed', err instanceof Error ? err.message : err);
        }
      }
    },
    broadcast: async (event) => {
      // M-XSURF-1 — fan the transition onto the D-121 broadcast bus so
      // paired clients (the webclient's Settings → Server → Exposure grid
      // + preset badge) refresh their connection assumptions without
      // re-fetching the passport. `emitExposureChanged` maps the rotation-
      // surface `ExposureChangedEvent` onto the bus envelope and swallows
      // a wedged push; a missing bus (db-less harness) is a no-op. Audit
      // already emitted (and precedes the listener bind), so a broadcast
      // failure can't roll back a committed transition.
      emitExposureChanged(eventBus, event);
    },
  };

  const exposureMachine = createExposureStateMachine({
    store: exposureStore,
    listener: listenerCoordinator,
    effects: exposureEffects,
    // DDNS probe — defaults to false until Pro DDNS substrate wires the
    // production source. The in-process stub keeps the state machine
    // refusing transitions that would resolve any path public until the
    // substrate is wired.
    ddns: {
      isConfigured: async () => false,
    },
    bind_addresses: { lan: lanBindAddress, public: '0.0.0.0' },
    activeWsConnections: { count: wsHandleClientCount },
  });

  // Two-phase return: construction is complete, but `reapply()` + the
  // LAN-bind assertion are deferred until the caller publishes the
  // machine into its late-bound ref. See `ExposureSubstrateBundle`
  // docblock for the ordering rationale.
  const finalize = async (): Promise<void> => {
    // Boot path: bring listeners up at the persisted resolution. The
    // first call also initialises the store with the bootstrap-derived
    // initial state. `reapply()` is the explicit "no validation, no
    // audit emit" entry — it's the idempotent boot path.
    await exposureMachine.reapply();

    // Codex W3.5b P2 fold — fail boot when the LAN listener required by
    // resolution didn't bind (port in use, EACCES, address unreachable).
    // The substrate intentionally doesn't throw on bind failure (§ A.18
    // graceful degradation surfaces to the Reachability Doctor); for
    // the LAN listener — Mary's admin channel — silent failure leaves
    // the server unusable. Mirrors the lifecycle-lock-fail exit code
    // (4) so the supervisor doesn't restart-loop on a permanent bind
    // problem.
    const postReapplyState = await exposureMachine.current();
    assertLanListenerBoundOrExit(
      listenerCoordinator.status(),
      postReapplyState.resolution,
    );
  };

  return { exposureMachine, finalize };
};
