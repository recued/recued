/** D-149 P12 § A.20.7 — Public Trust Footer resolver (follow-on wiring).
 *
 *  P12 shipped `buildTrustFooter` (a pure builder in `@recued/contracts`)
 *  as substrate; this is the follow-on leg that wires it into the six
 *  visitor renderers. Two entry points bridge the substrate builder to
 *  the per-request render path:
 *
 *    - `buildReceptionTrustFooterFromToggle` — pure; applies the
 *      § A.20.7 default-on semantics (absent toggle ⇒ enabled) and
 *      delegates to `buildTrustFooter`. The `reception_page` handler
 *      uses this directly: it has already loaded the singleton config,
 *      so it passes `config.trust_footer_enabled` without a second read.
 *    - `resolveReceptionTrustFooter` — reads the per-server
 *      `trust_footer_enabled` toggle off the `reception_page` singleton
 *      config via the store's `loadReceptionPageConfigForSettings`
 *      (which does NOT gate on the singleton's enable/revoke state — a
 *      disabled front-door page must not silently default-on a footer
 *      the operator explicitly turned off), then delegates to the pure
 *      builder. The five link-kind handlers use this — they don't
 *      otherwise touch the singleton.
 *
 *  Shared contract for both:
 *    - The toggle is a per-server setting stored on the `reception_page`
 *      singleton config (§ A.20.7 "per-server toggle"). Absent singleton
 *      OR absent toggle ⇒ default-on; an explicit `false` is the only
 *      value that suppresses the footer.
 *    - `deployment_mode` is a boot-constant derived once in `bin.ts`
 *      from the resolved public base URL host (`isProDdnsHost`).
 *    - The footer body is FULLY substrate-fixed (§ A.20.7 "not
 *      user-customizable text body") — nothing per-endpoint is
 *      interpolated, so there is no injection surface and no display
 *      name to escape. Renderers emit the returned string verbatim.
 *    - Returns `null` when the toggle is off (the renderer emits no
 *      trust-footer block).
 *
 *  Spec: D-149 § A.20.7. */

import {
  buildTrustFooter,
  resolveReceptionInboxFanoutMode,
  type ReceptionInboxFanoutMode,
  type TrustFooterDeploymentMode,
} from '@recued/contracts';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';

/** Build the trust footer from an already-resolved toggle value. Pure —
 *  no I/O. `trust_footer_enabled` absent (`undefined`) ⇒ default-on per
 *  § A.20.7; an explicit `false` returns `null`. The footer body is
 *  fully substrate-fixed (no per-endpoint interpolation). */
export const buildReceptionTrustFooterFromToggle = (args: {
  readonly trust_footer_enabled: boolean | undefined;
  readonly deployment_mode: TrustFooterDeploymentMode;
}): string | null =>
  buildTrustFooter({
    enabled: args.trust_footer_enabled ?? true,
    deployment_mode: args.deployment_mode,
  });

export interface ResolveReceptionTrustFooterArgs {
  readonly store: PublicEndpointRegistryStore;
  readonly deployment_mode: TrustFooterDeploymentMode;
}

/** Resolve the Public Trust Footer string for a link-kind visitor
 *  render, or `null` when the per-server toggle is off. Reads the
 *  `trust_footer_enabled` toggle off the `reception_page` singleton
 *  config on every call via `loadReceptionPageConfigForSettings` — the
 *  *ungated* settings reader. `loadReceptionPageSingleton` would NOT
 *  work here: it returns `null` for a disabled / revoked singleton (the
 *  P4 emergency-disable contract for the renderable front-door), which
 *  would make an explicit `trust_footer_enabled: false` read as absent
 *  and silently default back on for the still-enabled link kinds (Codex
 *  review fold). A fresh read per request is correct + cheap (one
 *  indexed row) — the singleton config is the operator's live setting
 *  and is not on the registry's 60s endpoint-cache. */
export const resolveReceptionTrustFooter = (
  args: ResolveReceptionTrustFooterArgs,
): string | null => {
  const config = args.store.loadReceptionPageConfigForSettings();
  return buildReceptionTrustFooterFromToggle({
    trust_footer_enabled: config?.trust_footer_enabled,
    deployment_mode: args.deployment_mode,
  });
};

/** D-210 Phase C — read the owner's inbox device-fanout mode off the same
 *  singleton config, through the same *ungated* settings reader and for
 *  the same reason: an emergency-disabled front-door page must not
 *  silently flip a stored `'notify'` back to the loud default. Fresh read
 *  per call (one indexed row) — the setting is live, and a raise that
 *  consulted a boot-time snapshot would ignore every change since.
 *
 *  A missing row / config / field all resolve to `'approval'` via the
 *  contract's own resolver, so this cannot become a second place where
 *  the default is decided. */
export const resolveReceptionInboxFanoutModeFromStore = (
  store: PublicEndpointRegistryStore,
): ReceptionInboxFanoutMode =>
  resolveReceptionInboxFanoutMode(
    store.loadReceptionPageConfigForSettings()?.inbox_fanout_mode,
  );
