/** Reception ▸ Endpoints ▸ Set up — the routed full-page Launch Wizard
 *  (`#reception/endpoints/setup`, R19 Slice 3).
 *
 *  ── Why this exists (the same "can't enable" fix as Slice 2) ───────
 *  Pre-R19 the § A.20.1 Launch Wizard mounted into the Settings
 *  `modalHost` overlay — a `rgba(0,0,0,0.4)` backdrop with a
 *  `.reception-wizard` that carried no surface of its own, so the wizard
 *  rendered TRANSPARENT over the dark backdrop: invisible, unusable. R19
 *  Slice 2 promoted the per-kind authoring forms out of that modal into
 *  routed full pages; this module does the same for the Launch Wizard —
 *  the 7-step first-run flow that EMBEDS those same authoring forms in its
 *  config-editing steps. The `.reception-wizard` opaque-card fix in
 *  `reception-launch-wizard-render.ts` covers the residual modal path too.
 *
 *  ── What it owns ──────────────────────────────────────────────────
 *    - **Chrome.** A "← Endpoints" back-link (a plain anchor — native hash
 *      nav, NOT caught by the wizard's action dispatcher, which lives on
 *      the child wizard host) + a child host the wizard mounts into. Built
 *      with `doc.createElement` (the inbox-panel / bootstrap / authoring-
 *      section DOM-boundary idiom).
 *    - **The embedded wizard.** `mountLaunchWizard` over the shared shell —
 *      the unchanged 7-step flow. The section only relocates it from a
 *      modal satellite to a routed page; every config-editing step, the
 *      stepper, validation, plan preview, and finish dispatch are the
 *      wizard mount's, unchanged.
 *    - **Share capture on finish.** A successful finish returns one
 *      `LaunchWizardRunResult` carrying a one-shot `share_url_once` per
 *      created link kind that the shell never re-surfaces; the section
 *      registers each via `shell.setEndpointShare` (reusing the page-host's
 *      `buildShareInputForCreate`) — identical to the modal path's
 *      `openLaunchWizard` close handler — so the endpoint's `openDetail`
 *      draws the § A.20.4 Share Cards. If the finish created EXACTLY ONE
 *      shareable endpoint it then navigates to that endpoint's DETAIL
 *      (`onNavigateToDetail`) so its one-shot cards surface immediately;
 *      a multi-endpoint finish / cancel / unwired navigator falls back to
 *      the endpoints list (`onBack`). Cancel passes no result.
 *
 *  Unlike the authoring section there is no seed / edit-fetch path: the
 *  wizard is a first-run flow that always starts from fresh per-kind
 *  configs (mirroring the modal `openLaunchWizard`, which passes no
 *  `initialConfigs`).
 *
 *  Design record: internal design notes §9
 *  + Review log R19 / R19.1. */

import type { LaunchWizardStepId } from '@recued/contracts';

import { serializeShellRoute } from '../shell/route.js';
import { buildShareInputForCreate } from './reception-page-host.js';
import {
  mountLaunchWizard,
  type LaunchWizardMount,
} from './reception-launch-wizard-mount.js';
import { isReceptionEndpointKindAvailable } from './reception.js';
import type {
  LaunchWizardRunResult,
  ReceptionPageShell,
} from './reception-page-shell.js';

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

export interface ReceptionWizardSectionOptions {
  /** Route content host — the section appends its chrome here + clears it
   *  on dispose. */
  host: HTMLElement;
  /** The SHARED reception page shell — the embedded `mountLaunchWizard`
   *  drives `runLaunchWizard` through it, and the section registers each
   *  created endpoint's share URL via `setEndpointShare`. */
  shell: ReceptionPageShell;
  /** The server's current exposure profile id — feeds the wizard's
   *  `current_exposure_profile` (the planner flags `profile_switch_needed`
   *  when it is not the recommended one) + the step-1 profile gate. */
  exposureProfile: string;
  /** Navigate back to the endpoints list — fired on cancel, and on a finish
   *  that did not create exactly one shareable endpoint. The route layer
   *  points this at `#reception/endpoints`. */
  onBack: () => void;
  /** Navigate to a single created endpoint's detail
   *  (`#reception/endpoints/<id>`) so its one-shot Share Cards surface
   *  immediately. Fired IN PLACE OF `onBack` only when the wizard finished
   *  with EXACTLY ONE shareable endpoint; a multi-endpoint finish stays on
   *  the list (it shows them all), and an unwired navigator falls back to
   *  `onBack`. The route layer points this at the Slice-4 detail deep link. */
  onNavigateToDetail?: (endpointId: string) => void;
  /** Fill the per-step content slot for the wizard's three
   *  non-config-editing steps (`profile_check` / `view_as_visitor` /
   *  `share`). Forwarded verbatim to the wizard mount's `renderStepContent`
   *  seam; the four config-editing steps are filled by the wizard itself. */
  renderStepContent?: (stepId: LaunchWizardStepId) => string | null;
  /** Bridge the wizard's `switch-profile` button to D-148's exposure rpc —
   *  the wizard owns no exposure-profile dispatch. Forwarded verbatim. */
  onSwitchProfile?: () => void;
  /** DOM document seam — defaults to `globalThis.document`. Throws if
   *  neither is available (non-browser env without an override). */
  document?: Document;
  /** Clock seam — defaults to `Date.now`. Threaded into the wizard's plan
   *  derivation + the share-card expiry note. */
  now?: () => number;
  /** Wizard-mount factory seam — defaults to the real `mountLaunchWizard`.
   *  Injected in tests to exercise the section's close handling (the
   *  share-registration loop + the disposed-guard on a late finish) without
   *  reproducing the wizard's full four-config validation flow — production
   *  never passes it. */
  mountWizard?: typeof mountLaunchWizard;
}

export interface ReceptionWizardSectionMount {
  /** Re-render the embedded wizard from its current cursor + configs. */
  update(): void;
  /** Tear down the embedded wizard + remove the chrome. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// mountReceptionWizardSection
// ════════════════════════════════════════════════════════════════

export const mountReceptionWizardSection = (
  opts: ReceptionWizardSectionOptions,
): ReceptionWizardSectionMount => {
  const doc =
    opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountReceptionWizardSection: no document available — pass `opts.document` for non-browser environments',
    );
  }
  const { host, shell } = opts;
  const now = opts.now ?? ((): number => Date.now());

  // ── Chrome: wrapper + back-link + child wizard host ──
  const root = doc.createElement('div');
  root.className = 'reception-page reception-wizard-section';
  // A queryable mount marker — the bootstrap routing tests assert the
  // wizard page mounted instead of the spine.
  root.setAttribute('data-reception-wizard-section', '');

  const header = doc.createElement('header');
  header.className = 'reception-wizard-section-head';
  const back = doc.createElement('a');
  back.className = 'reception-wizard-section-back';
  // A plain anchor (no `data-action`) — the click is native hash nav, so it
  // is NOT caught by the wizard's action dispatcher (which lives on the
  // child wizard host below + would preventDefault it).
  back.setAttribute('href', serializeShellRoute('reception', 'endpoints'));
  back.textContent = '← Endpoints';
  header.appendChild(back);
  root.appendChild(header);

  const wizardHost = doc.createElement('div');
  wizardHost.className = 'reception-wizard-section-body';
  root.appendChild(wizardHost);
  host.appendChild(root);

  let disposed = false;

  /** Capture every one-shot share URL (for currently available link kinds)
   *  then navigate back. Mirrors the modal host's `openLaunchWizard` close
   *  handler so the Share Cards surface identically whether the wizard was
   *  modal or routed.
   *
   *  The shares are registered even if the section was disposed mid-finish
   *  (the shared shell outlives the section, and each URL is one-shot — same
   *  as the modal host's late-resolve behavior). But navigation is GUARDED
   *  on `disposed`: a finish that resolves after the user already left must
   *  not yank them back to the endpoints list (mirrors Slice 2's Codex
   *  MEDIUM fold on the authoring section). */
  const onClose = (result?: LaunchWizardRunResult): void => {
    const shareableIds: string[] = [];
    if (result !== undefined) {
      const at = now();
      for (const created of result.created) {
        if (!isReceptionEndpointKindAvailable(created.kind)) continue;
        shell.setEndpointShare(
          created.result.endpoint_id,
          buildShareInputForCreate(created.kind, created.result, null, at),
        );
        shareableIds.push(created.result.endpoint_id);
      }
    }
    if (disposed) return;
    // Exactly one shareable endpoint → land on its detail so the one-shot
    // Share Cards surface immediately. Multiple → the endpoints list shows
    // them all; zero (or no detail nav wired) → the list.
    if (shareableIds.length === 1 && opts.onNavigateToDetail !== undefined) {
      opts.onNavigateToDetail(shareableIds[0]!);
      return;
    }
    opts.onBack();
  };

  const mountWizard = opts.mountWizard ?? mountLaunchWizard;
  const wizard: LaunchWizardMount = mountWizard({
    host: wizardHost,
    shell,
    exposureProfile: opts.exposureProfile,
    now,
    onClose,
    ...(opts.renderStepContent !== undefined
      ? { renderStepContent: opts.renderStepContent }
      : {}),
    ...(opts.onSwitchProfile !== undefined
      ? { onSwitchProfile: opts.onSwitchProfile }
      : {}),
  });

  return {
    update: () => {
      if (disposed) return;
      wizard.update();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      wizard.dispose();
      try {
        host.removeChild(root);
      } catch {
        root.remove();
      }
    },
  };
};
