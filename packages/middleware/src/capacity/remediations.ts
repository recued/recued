/** D-145 PB1.6 — remediation registry.
 *
 *  Closed-list `CapacityRemediationAction` enum (defined in
 *  `@recued/contracts`) + fallback-copy registry + default-visibility
 *  registry. The walker (PB1.2) uses these when the spec entry omits
 *  `user_facing_copy` or `visibility`.
 *
 *  Spec: § B.4. Design: § PB1.6 + § N.4. */

import type {
  CapacityRemediationAction,
  CapacityRemediationVisibility,
} from '@recued/contracts';

export const CAPACITY_REMEDIATION_FALLBACK_COPY: Readonly<
  Record<CapacityRemediationAction, string>
> = {
  show_bridge_install_prompt: 'Install the Browser Bridge to continue.',
  offer_install: 'Install the required ingredient to continue.',
  open_login_tab: 'Sign in to continue.',
  lazy_ask_user: 'Recued needs more information to continue.',
  request_permission_grant: 'Grant the required permission to continue.',
  enroll_connection: 'Enroll the connection in Settings → Connections to continue.',
  check_pool_quota: 'AI quota exhausted. Add a BYOK key or wait for the pool to refill.',
  mark_ingredient_degraded: 'This integration is temporarily unavailable while we update.',
  repair_capacity_probe:
    "Recued couldn't check this capability. Try again or check Settings → Diagnostics.",
  noop: '',
};

export const CAPACITY_REMEDIATION_DEFAULT_VISIBILITY: Readonly<
  Record<CapacityRemediationAction, CapacityRemediationVisibility>
> = {
  show_bridge_install_prompt: 'user_visible',
  offer_install: 'user_visible',
  open_login_tab: 'user_visible',
  lazy_ask_user: 'user_visible',
  request_permission_grant: 'user_visible',
  enroll_connection: 'user_visible',
  check_pool_quota: 'user_visible',
  // Engine routes around degraded ingredient; PB7 doesn't render.
  mark_ingredient_degraded: 'engine_internal',
  // Probe failure is operator-facing, not user-facing.
  repair_capacity_probe: 'engine_internal',
  noop: 'engine_internal',
};
