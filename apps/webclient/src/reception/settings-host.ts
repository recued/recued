/** D-149 follow-on § A.9 — Reception Settings composition (PWA shell).
 *
 *  The three Reception Settings host units shipped in prior sessions —
 *  `mountReceptionPage` / `mountReceptionPageHost` / `mountReceptionPromptsHost`
 *  — each own a slice of the surface, and the composition is non-trivial:
 *    1. `mountReceptionPromptsHost` must mount FIRST because
 *       `mountReceptionPageHost` needs `promptsHost.open` for its
 *       `onPromptAction` bridge.
 *    2. The three DOM host elements need a coherent visual layout — the
 *       page list flows in normal document order, the modal-host slot
 *       overlays above it, the prompts-host slot overlays above the
 *       modal. The two host APIs are explicit that the *consumer* owns
 *       the layout (see `mountReceptionPageHost` DD#1 + `mountReceptionPromptsHost`
 *       DD#1) — so SOMETHING has to be the consumer.
 *    3. Dispose order matters — the page host must tear down before the
 *       prompts host, otherwise a satellite-mount close handler that
 *       fires synchronously (e.g. a `setEndpointShare` registration) can
 *       race a prompts host whose listeners are already detached.
 *
 *  This module is **the PWA shell wiring** that lands those three
 *  decisions in one place. It is the natural mount point for an
 *  `app.recued.com` Reception Settings route — the route handler builds
 *  three child DOM elements with the right z-stacking, hands them to
 *  `mountReceptionSettings`, and gets a single combined handle back. The
 *  shell forwards every page-host seam (resolvePageConfig /
 *  resolveTemplateSeed / buildPacketDeclaration / renderWizardStepContent
 *  / onSwitchProfile / now) so the caller's policy points stay one level
 *  out — the shell itself adds no behavior beyond composition.
 *
 *  ── Key design decisions (non-obvious — READ before touching) ──────
 *
 *  DD#1 — The shell takes THREE pre-built host elements, not a single
 *  root the shell carves into children. The two underlying host APIs
 *  (`mountReceptionPageHost.pageHost` / `.modalHost` /
 *  `mountReceptionPromptsHost.host`) already expect distinct elements,
 *  and the consumer "owns the visual layout" (per both host docstrings
 *  — overlay / sidebar / column-split is the caller's call). Creating
 *  child divs inside `mountReceptionSettings` would force one layout
 *  policy AND demand a live DOM (the vitest-node environment has no
 *  `document.createElement`). Letting the consumer pre-build the three
 *  elements stays consistent + keeps the shell unit-testable through
 *  the same fake-host pattern every Reception mount test uses.
 *
 *  DD#2 — Prompts host mounts FIRST, page host SECOND. The page host's
 *  `onPromptAction` callback fires synchronously on every click against
 *  the four prompt-driven `data-action` buttons (`reception-extend` /
 *  `reception-rotate-token` / `reception-revoke` /
 *  `reception-emergency-disable-all`). The callback is captured at page-
 *  host mount time, so the prompts-host handle must already exist.
 *  Reversing the order would force a two-step wire (mount page → late-
 *  bind prompts) which we explicitly want to avoid.
 *
 *  DD#3 — Dispose in reverse mount order: page host FIRST, prompts host
 *  SECOND. The page host's `dispose()` tears down any open satellite
 *  mount (authoring form / launch wizard). A satellite's close handler
 *  can synchronously call `shell.setEndpointShare` — that touches the
 *  shell's share registry, not the prompts host, so tearing the prompts
 *  host down first is technically safe today. But the synchronous-close
 *  contract is fragile (a future satellite could add a prompts-host
 *  bridge on close), so the shell tears down in reverse mount order
 *  defensively. The reverse-mount-order rule is the same one
 *  `mountReceptionPageHost` follows for its own modal dispose.
 *
 *  DD#4 — The shell exposes `update()` even though it currently only
 *  forwards to the page host. Reason: the prompts host has no
 *  shell-subscription update path (it renders only on `open()` /
 *  `close()` / `dispose()` and a per-field edit), so an external
 *  re-render trigger never reaches it. The page host's `update()` is
 *  also rare (the shell subscription drives renders), but keeping the
 *  contract present means a future page-host re-render path stays
 *  forward-compatible.
 *
 *  DD#5 — Idempotent dispose. The page host's `dispose()` is idempotent
 *  per its own contract; the prompts host's is too. The shell wraps
 *  both behind a single `disposed` flag so the combined dispose stays
 *  idempotent even if a downstream re-dispose call races a teardown
 *  hook. Mirrors the dispose discipline of every other host in this
 *  layer.
 *
 *  Spec: D-149 § A.9 (Settings UX integration). */

import type {
  IntakeFormConfig,
  IntakeFormTemplate,
  LaunchWizardStepId,
  PacketDeclaration,
  ReceptionConfigTemplate,
  ReceptionConfigTemplateSeed,
  ReceptionEndpointKind,
  ReceptionPageConfig,
} from '@recued/contracts';

import {
  mountReceptionPageHost,
  type EnterAuthoringTarget,
  type ReceptionHostPromptAction,
  type ReceptionPageHost,
} from './page-host.js';
import {
  mountReceptionPromptsHost,
  type ReceptionPromptKind,
  type ReceptionPromptsHost,
} from './prompts-host.js';
// D-220 Slice B — pack-shipped intake templates on the gallery + seed path.
import type {
  PackReceptionTemplateListing,
  PackReceptionTemplateUnavailable,
} from '@recued/contracts';
import type { ReceptionPageShell } from './page-shell.js';

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

/** Options for `mountReceptionSettings`. The shell takes the three
 *  pre-built host elements (DD#1) + every page-host seam, forwards them
 *  verbatim, and returns a single combined handle. */
export interface ReceptionSettingsOptions {
  /** Host element for the spine list — handed to `mountReceptionPageHost.pageHost`.
   *  Flows in normal document order; no z-stacking required. */
  pageHost: HTMLElement;
  /** Host element for the satellite mount slot (authoring form / launch
   *  wizard) — handed to `mountReceptionPageHost.modalHost`. The caller
   *  is expected to z-stack this above `pageHost`; the shell does not
   *  enforce. The element stays empty until `mountReceptionPageHost`
   *  opens a satellite, so `:empty { display: none }` is a clean way to
   *  keep the overlay out of the click path. */
  modalHost: HTMLElement;
  /** Host element for the prompts modal — handed to `mountReceptionPromptsHost.host`.
   *  Z-stacked ABOVE `modalHost` by the caller (an open prompt + an open
   *  authoring mount can legitimately coexist — see
   *  `mountReceptionPromptsHost` DD#1). Same `:empty` opt-out applies. */
  promptsHost: HTMLElement;
  /** The page shell — both mounts drive rpc through it. */
  shell: ReceptionPageShell;
  /** Current exposure profile id — feeds the launch wizard's
   *  `current_exposure_profile` (the planner flags `profile_switch_needed`
   *  when it is not the recommended one). */
  exposureProfile: string;

  // ── Forwarded page-host seams ─────────────────────────────────────
  // Every optional seam on `ReceptionPageHostOptions` is mirrored here
  // and passed through verbatim. The shell adds no behavior beyond
  // composition (DD#1) — it never wraps, caches, or augments.

  /** Forwarded to `ReceptionPageHostOptions.resolvePageConfig`. The
   *  natural place for a PWA-route impl is a cache populated by a prior
   *  `openDetail` over `RECEPTION_PAGE_SINGLETON_ENDPOINT_ID` — but the
   *  shell does not own that cache, it forwards. */
  resolvePageConfig?: () => ReceptionPageConfig | null;
  /** Forwarded to `ReceptionPageHostOptions.resolveTemplateSeed`. The
   *  natural impl wraps the contract's `useIntakeFormTemplate` over an
   *  `IntakeFormTemplate` from the route's `reception.template.list`
   *  cache. */
  resolveTemplateSeed?: (templateRef: string) => IntakeFormConfig | null;
  /** Forwarded to `ReceptionPageHostOptions.getTemplates`. The natural
   *  impl returns the route's `reception.template.list` cache so the
   *  standalone templates-browser modal renders the Foundation-pack
   *  gallery. */
  getTemplates?: () => ReadonlyArray<IntakeFormTemplate>;
  /** Forwarded to `ReceptionPageHostOptions.getConfigTemplates` (D-151).
   *  The natural impl returns the route's `reception.template.list`
   *  `config_templates` cache so the standalone gallery renders the
   *  scheduling-link + contact-page cards. */
  getConfigTemplates?: () => ReadonlyArray<ReceptionConfigTemplate>;
  /** Forwarded to `ReceptionPageHostOptions.getPackTemplates` (D-220 Slice
   *  B). The natural impl returns the route's `reception.template.list`
   *  `pack_templates` cache so the gallery renders the installed packs' cards. */
  getPackTemplates?: () => ReadonlyArray<PackReceptionTemplateListing>;
  /** Forwarded to `ReceptionPageHostOptions.getPackTemplatesUnavailable`
   *  (D-220 Slice B). */
  getPackTemplatesUnavailable?: () => ReadonlyArray<PackReceptionTemplateUnavailable>;
  /** Forwarded to `ReceptionPageHostOptions.resolveConfigTemplateSeed`
   *  (D-151). The natural impl wraps `receptionConfigFromTemplate` over a
   *  loaded config template + an empty display name. */
  resolveConfigTemplateSeed?: (templateRef: string) => ReceptionConfigTemplateSeed | null;
  /** Forwarded to `ReceptionPageHostOptions.onProposeIntent` (D-151 P2).
   *  The route layer's impl runs `reception.compose.propose` + converts
   *  the result to a per-kind authoring seed; absent ⇒ the templates-
   *  browser modal hides its "Describe it with AI" section. */
  onProposeIntent?: (
    intent: string,
  ) => Promise<
    | { ok: true; kind: ReceptionEndpointKind; config: object; reason?: string }
    | { ok: false; message: string }
  >;
  /** Forwarded to `ReceptionPageHostOptions.gateEditPage`. The route
   *  layer's natural impl returns `!pageConfigLoaded` so the Edit-page
   *  button is disabled while the page-config cache has not loaded yet
   *  (closes the `mountReceptionRoute` DD#2 residual hard-failure
   *  overwrite path). */
  gateEditPage?: () => boolean;
  /** Forwarded to `ReceptionPageHostOptions.resolvePendingAsksCount`
   *  (D-169 P2 / N.9). The route layer's natural impl returns the live
   *  `notification.pending_asks` count so the status header's Approvals
   *  nav link carries the "N awaiting you" count badge. */
  resolvePendingAsksCount?: () => number;
  /** Forwarded to `ReceptionPageHostOptions.buildPacketDeclaration`.
   *  Defaults to `buildDefaultPacketDeclaration` when absent. */
  buildPacketDeclaration?: (
    kind: ReceptionEndpointKind,
    config: object,
  ) => PacketDeclaration | null;
  /** Forwarded to `ReceptionPageHostOptions.renderWizardStepContent`. */
  renderWizardStepContent?: (stepId: LaunchWizardStepId) => string | null;
  /** Forwarded to `ReceptionPageHostOptions.onSwitchProfile`. */
  onSwitchProfile?: () => void;
  /** Forwarded to `ReceptionPageHostOptions.onEnterAuthoring` (R19 Slice
   *  2). When present the page host navigates to the routed full-page
   *  authoring form instead of opening the modal satellite. */
  onEnterAuthoring?: (target: EnterAuthoringTarget) => void;
  /** Forwarded to `ReceptionPageHostOptions.onEnterWizard` (R19 Slice 3).
   *  When present the page host navigates to the routed full-page Launch
   *  Wizard instead of opening the modal satellite. */
  onEnterWizard?: () => void;
  /** D-200 Slice 6g.4 — forwarded to the page host's routed fixed
   *  intake-form/recipe selector entry. */
  onEnterPairing?: (endpointId: string) => void;
  /** Forwarded to `ReceptionPageHostOptions.onEnterDetail` / `.onExitDetail`
   *  (R19 Slice 4). When wired the spine's per-row "Detail" + the detail
   *  view's "Back to Reception" navigate to / from the
   *  `#reception/endpoints/<id>` deep link instead of the in-place
   *  `shell.openDetail` / `closeDetail`. */
  onEnterDetail?: (endpointId: string) => void;
  onExitDetail?: () => void;

  /** Optional close callback — fires for each prompt close (success +
   *  cancel), mirroring `ReceptionPromptsHostOptions.onClose`. Forwarded
   *  to the prompts host. */
  onPromptClose?: (kind: ReceptionPromptKind) => void;

  /** Clock seam — defaults to `Date.now`. Threaded into both mounts so
   *  the wizard's `now`, the prompts host's rotate-share expiry-note
   *  composition, + the page host's share-card rendering all share the
   *  same time source. */
  now?: () => number;
}

/** Mounted shell handle. Combined `update()` / `dispose()` over the
 *  page host + prompts host (DD#5: idempotent). */
export interface ReceptionSettingsHost {
  /** Forward a redraw to the page host (DD#4). Does not touch the
   *  prompts host (which has no shell-subscription render path). */
  update(): void;
  /** Dispose both hosts in reverse mount order (DD#3: page first,
   *  prompts second). Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// mountReceptionSettings
// ════════════════════════════════════════════════════════════════

/** Compose the three Reception Settings hosts into a single mounted
 *  surface (DD#1 — the three DOM elements are pre-built by the caller;
 *  DD#2 — prompts host mounts first so the page host's `onPromptAction`
 *  has a synchronous sink to bind). Returns the combined handle. */
export const mountReceptionSettings = (
  opts: ReceptionSettingsOptions,
): ReceptionSettingsHost => {
  const now = opts.now ?? ((): number => Date.now());

  // DD#2 — prompts host mounts first so `pageHost.onPromptAction` binds
  // synchronously to a live handle.
  const promptsHost: ReceptionPromptsHost = mountReceptionPromptsHost({
    host: opts.promptsHost,
    shell: opts.shell,
    now,
    ...(opts.onPromptClose !== undefined ? { onClose: opts.onPromptClose } : {}),
  });

  const pageHost: ReceptionPageHost = mountReceptionPageHost({
    pageHost: opts.pageHost,
    modalHost: opts.modalHost,
    shell: opts.shell,
    exposureProfile: opts.exposureProfile,
    now,
    // The bridge — every prompt-driven `data-action` click on the page
    // mount lands on the prompts host's `open()` synchronously.
    onPromptAction: (
      action: ReceptionHostPromptAction,
      dataset: DOMStringMap,
    ): void => promptsHost.open(action, dataset),
    // Forwarded seams — the shell adds no behavior beyond composition.
    ...(opts.resolvePageConfig !== undefined
      ? { resolvePageConfig: opts.resolvePageConfig }
      : {}),
    ...(opts.resolveTemplateSeed !== undefined
      ? { resolveTemplateSeed: opts.resolveTemplateSeed }
      : {}),
    ...(opts.getTemplates !== undefined
      ? { getTemplates: opts.getTemplates }
      : {}),
    ...(opts.getConfigTemplates !== undefined
      ? { getConfigTemplates: opts.getConfigTemplates }
      : {}),
    // D-220 Slice B — pack-shipped templates + the unavailable note.
    ...(opts.getPackTemplates !== undefined
      ? { getPackTemplates: opts.getPackTemplates }
      : {}),
    ...(opts.getPackTemplatesUnavailable !== undefined
      ? { getPackTemplatesUnavailable: opts.getPackTemplatesUnavailable }
      : {}),
    ...(opts.resolveConfigTemplateSeed !== undefined
      ? { resolveConfigTemplateSeed: opts.resolveConfigTemplateSeed }
      : {}),
    ...(opts.onProposeIntent !== undefined
      ? { onProposeIntent: opts.onProposeIntent }
      : {}),
    ...(opts.gateEditPage !== undefined
      ? { gateEditPage: opts.gateEditPage }
      : {}),
    ...(opts.resolvePendingAsksCount !== undefined
      ? { resolvePendingAsksCount: opts.resolvePendingAsksCount }
      : {}),
    ...(opts.buildPacketDeclaration !== undefined
      ? { buildPacketDeclaration: opts.buildPacketDeclaration }
      : {}),
    ...(opts.renderWizardStepContent !== undefined
      ? { renderWizardStepContent: opts.renderWizardStepContent }
      : {}),
    ...(opts.onSwitchProfile !== undefined
      ? { onSwitchProfile: opts.onSwitchProfile }
      : {}),
    ...(opts.onEnterAuthoring !== undefined
      ? { onEnterAuthoring: opts.onEnterAuthoring }
      : {}),
    ...(opts.onEnterWizard !== undefined
      ? { onEnterWizard: opts.onEnterWizard }
      : {}),
    ...(opts.onEnterPairing !== undefined
      ? { onEnterPairing: opts.onEnterPairing }
      : {}),
    ...(opts.onEnterDetail !== undefined
      ? { onEnterDetail: opts.onEnterDetail }
      : {}),
    ...(opts.onExitDetail !== undefined
      ? { onExitDetail: opts.onExitDetail }
      : {}),
  });

  let disposed = false;

  return {
    update: () => {
      if (disposed) return;
      pageHost.update();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // DD#3 — reverse mount order. Page host first so its open modal
      // (if any) tears down before the prompts host listeners detach.
      pageHost.dispose();
      promptsHost.dispose();
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Recommended visual-layout styles (consumer opts in)
// ════════════════════════════════════════════════════════════════
//
// The shell does NOT apply these styles itself (the consumer owns the
// layout per DD#1). This export is the recommended default for an
// `app.recued.com` Reception Settings route: page list in normal flow,
// modal overlay above page, prompts overlay above modal, each overlay
// hidden when its host element is empty (so click-through works while
// no modal / prompt is open).
//
// Consumers apply by stamping `data-reception-shell` onto the parent
// element of the three child hosts, then including this stylesheet.
// Each child host must carry one of the three `data-reception-shell-slot`
// values below.

/** Closed list of `data-reception-shell-slot` values. The recommended
 *  styles target each slot; consumers can opt out per-slot. */
export const RECEPTION_SETTINGS_SHELL_SLOTS = [
  'page',
  'modal',
  'prompts',
] as const;

export type ReceptionSettingsShellSlot =
  (typeof RECEPTION_SETTINGS_SHELL_SLOTS)[number];

export const RECEPTION_SETTINGS_SHELL_STYLES = `
[data-reception-shell] {
  position: relative;
  width: 100%;
  height: 100%;
}
[data-reception-shell-slot="page"] {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: auto;
}
[data-reception-shell-slot="modal"],
[data-reception-shell-slot="prompts"] {
  position: fixed;
  inset: 0;
  /* flex-start + overflow-y auto keeps content scrollable when it
   * exceeds the viewport height; align-items center would clip the
   * top edge of a tall mount (the wizard's preview step + the authoring
   * form's long fieldsets routinely exceed mobile / small-laptop
   * viewports). The 24px padding visually centers a short mount; a tall
   * one scrolls from the top. */
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow-y: auto;
  background: rgba(9, 9, 11, 0.56);
  padding: clamp(16px, 4vw, 36px);
  box-sizing: border-box;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
[data-reception-shell-slot="modal"] {
  z-index: 100;
}
[data-reception-shell-slot="prompts"] {
  z-index: 200;
}
[data-reception-shell-slot="modal"]:empty,
[data-reception-shell-slot="prompts"]:empty {
  display: none;
}
@media (max-width: 640px) {
  [data-reception-shell-slot="modal"],
  [data-reception-shell-slot="prompts"] {
    padding: 10px;
  }
}
`;
