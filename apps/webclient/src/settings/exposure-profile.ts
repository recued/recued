/** D-148 § A.4 + § A.7 — exposure switcher renderer (Amendment 2026-05-11; W3.5).
 *
 *  The Settings → Server → Exposure page renders a preset radio + the
 *  per-path toggle grid. User picks a preset to snap; toggling
 *  individual checkboxes flips the label to `'custom'`. Public-MCP
 *  carries a separate sub-toggle + free-text confirmation gate per
 *  `PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE`. `/ws` going fully off triggers
 *  the lockout confirmation gate per § A.6.6.
 *
 *  This module ships the model the UI iterates + the per-transition
 *  evaluator. It does NOT wire the rpc — the caller threads the
 *  evaluation result into `exposure.apply_preset` / `exposure.set_path_resolution`.
 *
 *  W3.5 retires the 5-profile switcher model outright per pre-launch
 *  zero-installs policy.
 */

import {
  EXPOSURE_PRESETS,
  PATH_ROLES,
  applyPreset,
  applyPathResolution,
  anyPathPublic,
  isAcknowledgementEffectivelyOn,
  deriveLabel,
  type DerivedPresetLabel,
  type ExposurePreset,
  type ExposureState,
  type PathResolution,
  type PathRole,
  type PublicMcpAcknowledgement,
} from '@recued/contracts';

export interface ExposureSwitcherModel {
  /** Recomputed UI label — preset name or `'custom'`. */
  derived_preset_label: DerivedPresetLabel;
  /** Per-path toggle grid the UI renders. Source of truth. */
  resolution: Record<PathRole, PathResolution>;
  /** Each preset + its preview (post-ack-thread). UI renders one row
   *  per preset; clicking snaps the grid to its shape. */
  options: ReadonlyArray<{
    preset: ExposurePreset;
    is_current: boolean;
    resolution: Record<PathRole, PathResolution>;
    /** True iff the preset's resolved shape has at least one public
     *  bit — drives the "Pro needed (no DDNS)" hint when the server
     *  doesn't have a handle yet. */
    requires_ddns: boolean;
  }>;
  /** True when the current resolution has any `public === true` bit.
   *  Drives the doctor's "you have public paths" copy. */
  any_public: boolean;
  /** Latest acknowledgement state (rendered as the public-MCP card). */
  public_mcp_acknowledgement: PublicMcpAcknowledgement;
}

export type ExposureTransitionEvaluation =
  | { ok: true; resolution: Record<PathRole, PathResolution> }
  | { ok: false; error: ExposureTransitionError };

export type ExposureTransitionError =
  | 'preset_unknown'
  | 'preset_unachievable_no_ddns'
  | 'public_mcp_not_acknowledged'
  | 'path_unknown'
  | 'ws_lockout_unconfirmed';

const presetRequiresPublicReach = (
  preset: ExposurePreset,
  ack: PublicMcpAcknowledgement,
): boolean => anyPathPublic(applyPreset(preset, ack));

/** Build the model the UI iterates over. Pure projection — no rpc
 *  side effects. Caller refetches when the server's `ExposureState`
 *  changes (broadcast via the `exposure_changed` event). */
export const buildExposureSwitcherModel = (
  args: {
    state: ExposureState;
    /** Server has DDNS configured (Pro subscription active OR
     *  user-supplied DDNS adapter). When false, presets requiring
     *  public reach raise `preset_unachievable_no_ddns`. */
    has_ddns: boolean;
  },
): ExposureSwitcherModel => {
  const ack = args.state.public_mcp_acknowledgement;
  const options = EXPOSURE_PRESETS.map((preset) => ({
    preset,
    is_current: deriveLabel(args.state.resolution, ack) === preset,
    resolution: applyPreset(preset, ack),
    requires_ddns: presetRequiresPublicReach(preset, ack) && !args.has_ddns,
  }));
  return {
    derived_preset_label: args.state.derived_preset_label,
    resolution: args.state.resolution,
    options,
    any_public: anyPathPublic(args.state.resolution),
    public_mcp_acknowledgement: ack,
  };
};

/** Pre-flight check before the rpc fires. Mirrors the server-side
 *  policy + lets the UI render an inline error rather than depending
 *  on the rpc round-trip. The server is still authoritative. */
export const isPresetTransitionAllowed = (args: {
  preset: ExposurePreset;
  has_ddns: boolean;
  acknowledgement: PublicMcpAcknowledgement;
}): ExposureTransitionEvaluation => {
  if (!(EXPOSURE_PRESETS as ReadonlyArray<ExposurePreset>).includes(args.preset)) {
    return { ok: false, error: 'preset_unknown' };
  }
  const projected = applyPreset(args.preset, args.acknowledgement);
  if (anyPathPublic(projected) && !args.has_ddns) {
    return { ok: false, error: 'preset_unachievable_no_ddns' };
  }
  return { ok: true, resolution: projected };
};

/** Pre-flight check for a per-path mutation. Mirrors the server-side
 *  validator (path_unknown / ws_lockout_unconfirmed / DDNS gate). The
 *  lockout confirmation prompt itself lives in the UI; this check
 *  surfaces the "needs phrase" branch so the UI can render the modal. */
export const isPathResolutionTransitionAllowed = (args: {
  current: ExposureState;
  path: PathRole;
  resolution: PathResolution;
  has_ddns: boolean;
  has_ws_lockout_confirmation: boolean;
}): ExposureTransitionEvaluation => {
  if (!(PATH_ROLES as ReadonlyArray<PathRole>).includes(args.path)) {
    return { ok: false, error: 'path_unknown' };
  }
  // ⛔ FIXED 2026-09-17 — this read `!…acknowledgement.acknowledged`, which
  // is NOT the gate. A record carrying `acknowledged: true` with a missing or
  // non-canonical phrase is malformed, and the server refuses it; this
  // pre-flight said "ok", so the UI fired the rpc and the owner got a
  // round-trip error instead of the acknowledgement modal. The sibling
  // pre-flight in `exposure-surface.ts` took the Codex W3.8 P2 #1 fold for
  // exactly this; this one was missed because the two are separate helpers
  // for the same gate.
  if (
    args.path === 'mcp'
    && args.resolution.public
    && !args.current.resolution.mcp.public
    && !isAcknowledgementEffectivelyOn(args.current.public_mcp_acknowledgement)
  ) {
    return { ok: false, error: 'public_mcp_not_acknowledged' };
  }
  if (
    args.path === 'ws'
    && !args.resolution.lan
    && !args.resolution.public
    && !args.has_ws_lockout_confirmation
  ) {
    return { ok: false, error: 'ws_lockout_unconfirmed' };
  }
  const projected = applyPathResolution(args.current.resolution, args.path, args.resolution);
  if (anyPathPublic(projected) && !args.has_ddns) {
    return { ok: false, error: 'preset_unachievable_no_ddns' };
  }
  return { ok: true, resolution: projected };
};
