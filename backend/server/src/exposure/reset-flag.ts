/** D-148 W3.10 — `--reset-exposure` boot-flag failsafe.
 *
 *  Recovery surface for the per-path exposure state machine. Wired into
 *  `cmdServe` at the same point W3.9's SQLite-backed `ExposureStateStore`
 *  is constructed. When the operator passes `--reset-exposure` on the
 *  cmdServe invocation, the helper discards the persisted row and
 *  re-derives the initial state from the W3.5b bootstrap (which has
 *  `/ws.lan: true` per `deriveBootstrapDerivedExposureState`), then
 *  stamps a high-assurance audit row with the closed-list action
 *  `exposure_reset_via_cli`.
 *
 *  Failure mode this addresses: Mary typed the `disconnect webclients`
 *  phrase and applied the `maintenance` preset — `/ws` is now fully off
 *  and she has no other admin channel. She SSHs into the box, restarts
 *  with `recued serve --reset-exposure`, and the persisted lockout is
 *  replaced with the bootstrap-derived state. One-shot — the flag does
 *  not persist; a subsequent restart without the flag loads the
 *  recovered state normally.
 *
 *  Substrate discipline:
 *    - The persisted state is replaced atomically (single `store.save`).
 *    - `changed_by_client_id` is forced to `'system:cli_reset'` so the
 *      forensic trail distinguishes operator CLI recovery from a
 *      runtime mutation.
 *    - `reason` is set to a fixed `'--reset-exposure boot flag'` literal
 *      so log + audit copy is stable across audits.
 *    - `last_changed_at` uses the injected clock (defaults to
 *      `Date.now`).
 *    - Audit emit is best-effort: the recovery path SHOULD complete
 *      even if the audit emit throws (otherwise an audit-store outage
 *      would prevent Mary from recovering from a lockout — backwards).
 *      The helper logs but does not propagate audit-emit failures. */

import type { ExposureState, PathResolution, PathRole } from '@recued/contracts';
import { PATH_ROLES } from '@recued/contracts';
import type { ExposureStateStore } from './index.js';

/** Action code mirrored from `packages/storage/src/audit.ts` (ActivityAction
 *  union + RESERVE_ACTIONS) + `packages/contracts/src/keys.ts`
 *  (HIGH_ASSURANCE_AUDIT_KINDS). One row per CLI-driven reset. */
export const EXPOSURE_RESET_AUDIT_ACTION = 'exposure_reset_via_cli' as const;

/** Caller-supplied identifier for the operator-CLI mutation source.
 *  Identifies CLI-driven resets in the forensic trail without leaking
 *  a real client_id. */
export const CLI_RESET_CLIENT_ID = 'system:cli_reset' as const;

/** Caller-supplied reason recorded alongside the reset. Fixed string so
 *  the audit + log copy stays stable across audits. */
export const CLI_RESET_REASON = '--reset-exposure boot flag' as const;

export interface ApplyResetExposureBootArgs {
  /** SQLite-backed (production) or in-memory (test) store. */
  store: ExposureStateStore;
  /** Bootstrap-derived initial state (from
   *  `deriveBootstrapDerivedExposureState`). Used both for first-boot
   *  seeding (reset=false path) and for the recovery target (reset=true
   *  path). */
  bootstrap: ExposureState;
  /** True iff `--reset-exposure` was passed on the cmdServe invocation. */
  resetRequested: boolean;
  /** Best-effort audit emit. The state-machine-shaped payload mirrors
   *  the W3.5 `ExposureSideEffects.recordAudit` signature so the same
   *  audit-log wrapper can carry it. Throwing here does NOT block the
   *  reset (the recovery path stays unblocked even if the audit
   *  substrate is itself wedged). */
  recordAudit?: (payload: ResetAuditPayload) => Promise<void>;
  /** Best-effort logger. Defaults to a no-op (tests pin via injection).
   *  Production callers route through `console.warn`. */
  log?: (message: string) => void;
  /** Pluggable clock. Defaults to `Date.now`. */
  now?: () => number;
}

/** Audit payload shape emitted when `--reset-exposure` runs. Carries
 *  the resolved target state so a downstream auditor can confirm what
 *  Mary's recovery landed on. */
export interface ResetAuditPayload {
  action: typeof EXPOSURE_RESET_AUDIT_ACTION;
  resolution: Record<PathRole, PathResolution>;
  changed_by_client_id: typeof CLI_RESET_CLIENT_ID;
  reason: typeof CLI_RESET_REASON;
  applied_at: number;
}

export interface ApplyResetExposureBootOutcome {
  /** `true` iff `resetRequested === true` AND the helper overwrote the
   *  persisted row with the bootstrap-derived state. `false` when no
   *  reset was requested (the regular load-or-seed path applied). */
  reset: boolean;
  /** The state now in the store after the helper ran. When
   *  `resetRequested === false`, this is the loaded state OR the
   *  bootstrap state (when load returned null). When `resetRequested
   *  === true`, this is the bootstrap state with the CLI-reset
   *  metadata applied. */
  persisted: ExposureState;
}

const cloneResolution = (
  src: Record<PathRole, PathResolution>,
): Record<PathRole, PathResolution> => {
  const out = {} as Record<PathRole, PathResolution>;
  for (const role of PATH_ROLES) {
    out[role] = { lan: src[role].lan, public: src[role].public };
  }
  return out;
};

/** Apply the boot-flag gate. Returns whether the reset path was taken
 *  and the state now in the store. The helper is the only entry point
 *  for the recovery action — callers that need to discard the
 *  persisted row should always route through here so the audit row is
 *  stamped atomically with the save. */
export const applyResetExposureBoot = async (
  args: ApplyResetExposureBootArgs,
): Promise<ApplyResetExposureBootOutcome> => {
  const now = args.now ?? Date.now;
  const log = args.log ?? (() => {});
  if (args.resetRequested) {
    const at = now();
    const next: ExposureState = {
      resolution: cloneResolution(args.bootstrap.resolution),
      derived_preset_label: args.bootstrap.derived_preset_label,
      public_mcp_acknowledgement: { ...args.bootstrap.public_mcp_acknowledgement },
      last_changed_at: at,
      changed_by_client_id: CLI_RESET_CLIENT_ID,
      reason: CLI_RESET_REASON,
    };
    await args.store.save(next);
    log(
      `[exposure] --reset-exposure: persisted state discarded; bootstrap-derived state saved (changed_by=${CLI_RESET_CLIENT_ID})`,
    );
    if (args.recordAudit) {
      try {
        await args.recordAudit({
          action: EXPOSURE_RESET_AUDIT_ACTION,
          resolution: cloneResolution(next.resolution),
          changed_by_client_id: CLI_RESET_CLIENT_ID,
          reason: CLI_RESET_REASON,
          applied_at: at,
        });
      } catch (err) {
        // Audit emit failure does NOT block the reset. Mary's recovery
        // must complete even if the audit substrate is wedged.
        log(
          `[exposure] --reset-exposure: audit emit failed (continuing): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { reset: true, persisted: next };
  }
  // No reset requested — regular load-or-seed path. Mirrors the bin.ts
  // wiring before W3.10 ships this helper (W3.9 had the same shape
  // inlined).
  const existing = await args.store.load();
  if (existing !== null) {
    return { reset: false, persisted: existing };
  }
  await args.store.save(args.bootstrap);
  return { reset: false, persisted: args.bootstrap };
};
