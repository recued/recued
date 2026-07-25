/** D-148 W3.5b — bootstrap-derived `ExposureState` helpers.
 *
 *  Co-located with the state machine so production wiring (`bin.ts`) and
 *  tests (`__tests__/d-148-w3-5b-bin-smoke.test.ts`) import the same
 *  implementation without going through `bin.ts`'s CLI dispatcher.
 *
 *  Both helpers were added in the Codex W3.5b fold:
 *  - `deriveBootstrapDerivedExposureState` (P1): seeds the initial
 *    resolution from explicit operator gestures (`bootstrap.webhook_port`
 *    + `RECUED_PUBLIC_REACHABLE`) so configured webhook listeners stay
 *    reachable after the path-routed migration.
 *  - `assertLanListenerBoundOrExit` (P2): fails boot when the LAN
 *    listener required by resolution didn't bind. The substrate's
 *    graceful-degradation flow (§ A.18) intentionally swallows bind
 *    failures into per-listener status; for the LAN listener — Mary's
 *    admin channel — silent failure leaves the server unusable. */

import type {
  ExposureState,
  PathResolution,
  PathRole,
} from '@recued/contracts';

/** Boot-time inputs that influence the initial exposure state. */
export interface BootstrapDerivedExposureStateInput {
  /** `loadedConfig.bootstrap.webhook_port`. `> 0` enables webhooks LAN
   *  (and webhooks public when paired with public_reachable). */
  webhook_port: number;
  /** `RECUED_PUBLIC_REACHABLE` env var (parsed to boolean). When true,
   *  the legacy single-listener flow served every path on the public
   *  port — mirror by widening health + ws + webhooks' public bits.
   *  `/mcp` stays LAN-only (ack-gated per § A.7.2); `/reception` stays
   *  off (D-149 opt-in per Must Hold I-1). */
  public_reachable: boolean;
}

/** Derive the initial `ExposureState` from explicit operator gestures.
 *
 *  | path       | lan | public                                     |
 *  |:-----------|:----|:-------------------------------------------|
 *  | health     | ✓   | ✓ iff public_reachable                     |
 *  | ws         | ✓   | ✓ iff public_reachable                     |
 *  | mcp        | ✓   | — (ack-gated; user toggles via Settings)   |
 *  | webhooks   | ✓ iff webhook_port>0 | ✓ iff webhook_port>0 AND public_reachable |
 *  | reception  | — | — (D-149 opt-in)                            |
 *  | oauth      | — | — (D-165 opt-in)                            |
 *
 *  `derived_preset_label = 'custom'` because the bootstrap-shaped state
 *  isn't one of the 3 closed-list presets (`lan_only` / `public` /
 *  `maintenance`); Settings UX surfaces the Custom badge so Mary can
 *  re-snap to a preset when she wants. */
export const deriveBootstrapDerivedExposureState = (
  input: BootstrapDerivedExposureStateInput,
): ExposureState => {
  const { webhook_port, public_reachable } = input;
  const webhooksLan = webhook_port > 0;
  const webhooksPublic = webhooksLan && public_reachable;
  return {
    resolution: {
      health: { lan: true, public: public_reachable },
      ws: { lan: true, public: public_reachable },
      mcp: { lan: true, public: false },
      llm_gateway: { lan: true, public: public_reachable },
      webhooks: { lan: webhooksLan, public: webhooksPublic },
      reception: { lan: false, public: false },
      // D-165 — vendor OAuth callback is a new opt-in public surface
      // (no legacy operator gesture maps to it). Stays off in the
      // bootstrap-derived state, like `reception`. The handler is wired
      // (slice 2b Piece W) but the `public` preset keeps it off until
      // slice 3 lands the webclient consumer; the user opts in then.
      oauth: { lan: false, public: false },
      // D-158 P2b-ii — notification ask-landing page, an opt-in public
      // surface like `reception` / `oauth`; off in the bootstrap-derived
      // state until the user applies the `public` preset.
      ask: { lan: false, public: false },
      // R26.2 Delta 3 — embedded webclient served on LAN if a bundle is
      // present (the D-152 off-grid case); public exposure stays an
      // explicit opt-in, off in the bootstrap-derived state.
      webclient: { lan: true, public: false },
    },
    derived_preset_label: 'custom',
    public_mcp_acknowledgement: { acknowledged: false },
    last_changed_at: Date.now(),
    changed_by_client_id: 'system:bootstrap_derive',
    reason: `webhook_port=${webhook_port}, public_reachable=${public_reachable}`,
  };
};

/** Per-listener bind status accepted by `assertLanListenerBoundOrExit`.
 *  Mirrors `PathListenerStatus` from `@recued/server-tls` without
 *  importing it directly — keeps this module dependency-light for
 *  test/unit consumption. */
export interface BootstrapListenerStatus {
  listener: 'lan' | 'public';
  listening: boolean;
  bind_address: string | null;
  failure?: string;
}

/** Compute whether `assertLanListenerBoundOrExit` would fail boot. Pure
 *  function — extracted so tests can validate the boot guard without
 *  invoking `process.exit`. Returns `null` when the boot guard would
 *  pass, otherwise the failure reason (a string for logging /
 *  diagnostics).
 *
 *  Conditions for failure:
 *  1. Resolution requires LAN binding (any path's `lan` bit true).
 *  2. The LAN listener row reports `listening: false`.
 *
 *  Public-listener failures are surfaced separately by the Reachability
 *  Doctor; they do NOT fail boot per W3.5b's policy (LAN listener
 *  remains Mary's admin channel even if the public listener can't bind). */
export const evaluateLanBindGate = (
  statuses: ReadonlyArray<BootstrapListenerStatus>,
  resolution: Record<PathRole, PathResolution>,
): { fail: false } | { fail: true; reason: string; bind_address: string | null } => {
  const anyLanPath = Object.values(resolution).some((r) => r.lan);
  if (!anyLanPath) return { fail: false };
  const lan = statuses.find((s) => s.listener === 'lan');
  if (lan && lan.listening) return { fail: false };
  return {
    fail: true,
    reason: lan?.failure ?? 'unknown',
    bind_address: lan?.bind_address ?? null,
  };
};

/** Production boot guard. Wraps `evaluateLanBindGate` + emits to
 *  stderr + `process.exit(4)` on failure (mirrors the lifecycle-lock
 *  exit code so the supervisor doesn't restart-loop a permanent bind
 *  problem). Tests invoke `evaluateLanBindGate` directly to avoid the
 *  exit-call side effect. */
export const assertLanListenerBoundOrExit = (
  statuses: ReadonlyArray<BootstrapListenerStatus>,
  resolution: Record<PathRole, PathResolution>,
): void => {
  const verdict = evaluateLanBindGate(statuses, resolution);
  if (!verdict.fail) return;
  console.error(
    `[network] LAN listener required by resolution but failed to bind: ${verdict.reason} (bind_address=${verdict.bind_address ?? '?'}).`,
  );
  console.error(
    '  Resolve the underlying port / permission / interface problem before restarting.',
  );
  process.exit(4);
};
