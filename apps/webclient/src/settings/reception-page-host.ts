/** D-149 follow-on § A.9 + § A.20.1 — Reception Settings host runtime.
 *
 *  `reception-page-render.ts` mounts the spine list view + dispatches every
 *  list-level action it can satisfy off the injected `ReceptionPageShell`,
 *  and forwards the remaining nine host-level actions through
 *  `opts.onUnhandledAction`. This module is **the host that catches those
 *  forwards.** The natural composition target for an `app.recued.com`
 *  Reception surface: the list mount stays alive in `pageHost`, and on
 *  each forwarded action this host mounts the right satellite —
 *  `mountAuthoringForm` for the three create / edit flows or
 *  `mountLaunchWizard` for the § A.20.1 first-run flow — into a separate
 *  `modalHost` element. The page mount keeps subscribing to the same
 *  shell underneath, so when the satellite closes and the shell refetches,
 *  the list re-renders automatically.
 *
 *  ── What the host owns vs forwards ─────────────────────────────────
 *  Owns (the routed/mount-launching forwards): `reception-launch-wizard`,
 *  `reception-new-endpoint`, `reception-edit-page`,
 *  `reception-pair-intake-recipe`, and `reception-open-templates`.
 *  (R19 Slice 2 — `reception-new-endpoint` / `reception-edit-page` + the
 *  templates browser's template / AI picks NAVIGATE to the routed full-page
 *  authoring form when `onEnterAuthoring` is wired, instead of opening the
 *  modal satellite.)
 *  Forwards (the four prompt-driven forwards that aren't mount launches —
 *  `reception-extend` / `reception-rotate-token` / `reception-revoke` /
 *  `reception-emergency-disable-all`): bridged to the consumer through
 *  `onPromptAction`. Those need a date / reason / confirm prompt this host
 *  doesn't draw; whichever satellite ships next plugs in there.
 *
 *  ── PacketDeclaration derivation (the non-obvious bit) ─────────────
 *  `mountAuthoringForm` requires a `PacketDeclaration` for every link-style
 *  kind (the substrate-separate D-145 wrapper the preview / create dispatch
 *  builders consume). The host derives it LAZILY via `buildPacketDeclaration`
 *  — the mount calls the factory at preview / submit time with the current
 *  working config, so a user-typed id flows in even on a fresh-seed mount
 *  (a mount-time-static declaration would capture the empty seed + leave
 *  submit inert once the user types). Default rules:
 *    - `scheduling_link` → `source_query_ref: { kind: 'data.calendar.combined' }` (id-less);
 *    - `intake_form` → the user-typed `form_definition.form_definition_id`
 *      off the working config (which a "Use template" seed already
 *      stamped, and the lazy factory re-reads on every preview / submit);
 *    - `drop_link` → `source_query_ref: { kind: 'reception_drop_config',
 *      drop_config_id: <opaque substrate-owned id> }` — same shape the
 *      wizard plan uses (`LAUNCH_WIZARD_DROP_CONFIG_ID`); the substrate
 *      reads the real config off the registry row's `metadata_blob`, not
 *      this id;
 *    - `approval_link` → `source_query_ref: { kind: 'reception_approval_intent',
 *      intent_id: <opaque substrate-owned id> }` — the exact drop_link
 *      situation: the create handler mints the real `reception_approval_intent`
 *      row keyed on the endpoint_id (1:1) + reads the action config off the
 *      registry row's `metadata_blob`, so this id is a stable cosmetic
 *      placeholder (`STANDALONE_APPROVAL_INTENT_ID`), not a key. (The user's
 *      one instance-specific field, `on_action.target_id`, is captured in
 *      the config blob via the authoring form, not in this ref.);
 *    - `status_link` → null: it is create-hidden
 *      (`UNAVAILABLE_RECEPTION_ENDPOINT_KINDS`) until its visitor reader
 *      lands, so submit is never reached for it anyway;
 *    - `reception_page` is the singleton — no packet declaration path
 *      at all (its `page.upsert` rpc carries no D-145 wrapper).
 *
 *  ── Hard-ceiling expiry derivation ─────────────────────────────────
 *  `drop_link` / `approval_link` / `status_link` have hard expiry
 *  ceilings; their `create` rpc rejects long-lived. The authoring mount
 *  derives `expires_at = now + config.expiry_days * DAY_MS` for these
 *  kinds at preview / submit time, mirroring the wizard plan builder's
 *  derivation for `drop_link`. The host needn't pass an explicit
 *  `expiresAt` — the mount handles it from the working config.
 *
 *  ── Share registration on close ────────────────────────────────────
 *  The substrate's `ReceptionEndpointCreateResult.share_url_once` is
 *  genuinely one-shot — the shell does not auto-cache it (see
 *  `setEndpointShare` DD#4 on the shell). When the create / wizard finish
 *  surfaces a result, the host immediately calls `shell.setEndpointShare`
 *  with a freshly-composed `ShareCardsInput` (title / description from
 *  `RECEPTION_KIND_COPY`, expiry note from the row's `expires_at`) so the
 *  next `openDetail` over the same `endpoint_id` draws the § A.20.4 Share
 *  Cards. The wizard run yields one entry per created link kind; the host
 *  registers every one.
 *
 *  ── Lifecycle ──────────────────────────────────────────────────────
 *  `mountReceptionPageHost` returns the same `update()` / `dispose()`
 *  shape every mount in this layer uses. `dispose` tears down the open
 *  modal mount + the underlying page mount + clears both hosts.
 *  Opening a second modal while one is already open disposes the first
 *  (the host never overlaps mounts — the inner state would race on the
 *  shell's `last_error` channel).
 *
 *  Spec: D-149 § A.9 (Settings UX integration) + § A.20.1
 *  (Launch Wizard) + § A.20.4 (Share Cards) + § A.3 (preview-hash gate). */

// D-220 Slice B — pack-shipped intake templates on the gallery + seed path.
import type {
  PackReceptionTemplateListing,
  PackReceptionTemplateUnavailable,
} from '@recued/contracts';
import type {
  IntakeFormConfig,
  IntakeFormTemplate,
  LaunchWizardStepId,
  PacketDeclaration,
  ReceptionConfigTemplate,
  ReceptionConfigTemplateSeed,
  ReceptionEndpointCreateResult,
  ReceptionEndpointKind,
  ReceptionPageConfig,
} from '@recued/contracts';
import {
  LAUNCH_WIZARD_DROP_CONFIG_ID,
  RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND,
  isReceptionEndpointKind,
} from '@recued/contracts';

import {
  RECEPTION_KIND_COPY,
  computeExpiryLabel,
  isReceptionEndpointKindAvailable,
} from './reception.js';
import {
  mountAuthoringForm,
  type AuthoringFormMount,
  type AuthoringFormMountOptions,
} from './reception-authoring-mount.js';
import {
  mountLaunchWizard,
  type LaunchWizardMount,
  type LaunchWizardMountOptions,
} from './reception-launch-wizard-mount.js';
import {
  mountReceptionPage,
  type ReceptionPageAction,
  type ReceptionPageView,
} from './reception-page-render.js';
import {
  mountTemplatesBrowser,
  type TemplatesBrowserMount,
} from './reception-templates-mount.js';
import type {
  LaunchWizardRunResult,
  ReceptionPageShell,
} from './reception-page-shell.js';

// ════════════════════════════════════════════════════════════════
// Action partition — the forwarded actions this host mounts or routes,
// vs the four it bridges to the consumer's prompt path.
// ════════════════════════════════════════════════════════════════

/** The host-forwarded actions this host satisfies natively by mounting a
 *  satellite or entering a routed full-page surface. Exported so a ratchet test can assert the
 *  split stays exhaustive against `RECEPTION_PAGE_ACTIONS` minus
 *  `RECEPTION_PAGE_NATIVE_ACTIONS` minus the prompt set below. */
export const RECEPTION_HOST_MOUNT_ACTIONS = [
  'reception-launch-wizard',
  'reception-new-endpoint',
  'reception-edit-page',
  'reception-pair-intake-recipe',
  'reception-open-templates',
] as const satisfies ReadonlyArray<ReceptionPageAction>;

/** The four host-forwarded actions that need a date / reason / confirm
 *  prompt this host does not own — bridged to `opts.onPromptAction`. */
export const RECEPTION_HOST_PROMPT_ACTIONS = [
  'reception-extend',
  'reception-rotate-token',
  'reception-revoke',
  'reception-emergency-disable-all',
] as const satisfies ReadonlyArray<ReceptionPageAction>;

export type ReceptionHostMountAction =
  (typeof RECEPTION_HOST_MOUNT_ACTIONS)[number];
export type ReceptionHostPromptAction =
  (typeof RECEPTION_HOST_PROMPT_ACTIONS)[number];

/** R19 Slice 2 — the routed-authoring navigation target. When the
 *  consumer wires `onEnterAuthoring`, the host NAVIGATES to a routed
 *  full-page authoring form (`#reception/endpoints/new|edit/<kind>`)
 *  instead of opening the transparent modal satellite — the owner's
 *  "can't enable" fix (the modal overlay is the bug). `mode` is the
 *  route verb; `kind` the per-kind form; `seedConfig` (template /
 *  AI-proposed) is an already-resolved working config handed off out of
 *  band (the routed section reads it transiently — a URL can't carry a
 *  full config). Absent `onEnterAuthoring` ⇒ the host keeps opening the
 *  modal (the pre-R19 path; preserved for the non-routed compositions +
 *  their tests). */
export interface EnterAuthoringTarget {
  readonly mode: 'new' | 'edit';
  readonly kind: ReceptionEndpointKind;
  readonly seedConfig?: object | null;
}

const MOUNT_ACTION_SET: ReadonlySet<ReceptionPageAction> = new Set(
  RECEPTION_HOST_MOUNT_ACTIONS,
);
const PROMPT_ACTION_SET: ReadonlySet<ReceptionPageAction> = new Set(
  RECEPTION_HOST_PROMPT_ACTIONS,
);

// ════════════════════════════════════════════════════════════════
// PacketDeclaration factory
// ════════════════════════════════════════════════════════════════

/** Read a dotted path off a plain working-config object. Returns
 *  undefined for any missing / non-object intermediate. Defensive —
 *  `buildDefaultPacketDeclaration` reads the user-typed
 *  `form_definition.form_definition_id` off an in-progress edit, so
 *  every intermediate may be undefined. */
const readPath = (target: object, path: string): unknown => {
  let node: unknown = target;
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
};

/** Default `PacketDeclaration` factory — derives the wrapper for the
 *  kinds whose `source_query_ref` is either id-less or sources its id
 *  from the user-typed working config (or, for `drop_link` /
 *  `approval_link`, from a stable substrate-owned placeholder id —
 *  `LAUNCH_WIZARD_DROP_CONFIG_ID` / `STANDALONE_APPROVAL_INTENT_ID`).
 *  Returns null only for `status_link` (create-hidden until its visitor
 *  reader lands) and `reception_page` (the singleton has no
 *  packet-declaration path).
 *
 *  Consumers can override this via `opts.buildPacketDeclaration` to plug
 *  in their own minting policy; the override sees the same
 *  `(kind, config)` signature. */
/** Stable opaque `reception_approval_intent` id the standalone
 *  approval_link create path stamps into its packet declaration. The
 *  approval analog of `LAUNCH_WIZARD_DROP_CONFIG_ID`: the create handler
 *  mints the real per-endpoint intent row keyed on the minted endpoint_id
 *  (1:1) and ignores this ref's value, so a fixed placeholder keeps the
 *  packet declaration canonical across creates rather than fragmenting on
 *  a random id. approval_link is not a launch-wizard kind, hence the
 *  standalone- (not `launch_wizard_`) prefix. */
const STANDALONE_APPROVAL_INTENT_ID = 'standalone_approval_link';

export const buildDefaultPacketDeclaration = (
  kind: ReceptionEndpointKind,
  config: object,
): PacketDeclaration | null => {
  switch (kind) {
    case 'reception_page':
      return null;
    case 'scheduling_link':
      return {
        packet_kind: RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND.scheduling_link,
        source_query_ref: { kind: 'data.calendar.combined' },
      };
    case 'intake_form': {
      const formDefinitionId = readPath(config, 'form_definition.form_definition_id');
      if (typeof formDefinitionId !== 'string' || formDefinitionId.length === 0) {
        return null;
      }
      return {
        packet_kind: RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND.intake_form,
        source_query_ref: {
          kind: 'reception_form_definition',
          form_definition_id: formDefinitionId,
        },
      };
    }
    case 'drop_link':
      // Same substrate-owned opaque id the wizard plan uses (§ A.20.1
      // `buildLaunchWizardPlan`) — the real config lives in the
      // registry row's `metadata_blob`, not in this ref. The standalone
      // create flow reuses the wizard's value rather than minting a
      // fresh one so a single host doesn't fragment the `reception_drop_config`
      // primary-key space.
      return {
        packet_kind: RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND.drop_link,
        source_query_ref: {
          kind: 'reception_drop_config',
          drop_config_id: LAUNCH_WIZARD_DROP_CONFIG_ID,
        },
      };
    case 'approval_link':
      // The exact drop_link situation — a stable opaque substrate-owned
      // id; the real intent row is keyed on the endpoint_id at create
      // time + the action config lives in the registry row's
      // `metadata_blob`. The user's one instance-specific field
      // (`on_action.target_id`) is captured in the config blob via the
      // authoring form, not this ref.
      return {
        packet_kind: RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND.approval_link,
        source_query_ref: {
          kind: 'reception_approval_intent',
          intent_id: STANDALONE_APPROVAL_INTENT_ID,
        },
      };
    case 'status_link':
      // Create-hidden (`UNAVAILABLE_RECEPTION_ENDPOINT_KINDS`) until its
      // visitor reader lands — submit is never reached, so null is fine.
      return null;
  }
};

// ════════════════════════════════════════════════════════════════
// Share-card composition
// ════════════════════════════════════════════════════════════════

/** Compose a `ShareCardsInput` for an `endpoint_id` from the
 *  `ReceptionEndpointCreateResult`'s one-shot `share_url_once` + the
 *  per-kind copy (`RECEPTION_KIND_COPY[kind].singular`) + the row's
 *  expiry. The host calls `shell.setEndpointShare` with this so the
 *  next `openDetail` over `endpoint_id` draws the § A.20.4 Share Cards;
 *  the substrate never re-surfaces `share_url_once`, so this is the
 *  single moment to capture it. Pure — no I/O.
 *
 *  Exported (R19 Slice 2) so the routed full-page authoring section
 *  (`reception-authoring-section.ts`) captures the one-shot share URL on
 *  create-close exactly like the modal path here does — the share-card
 *  registration is the same regardless of whether the form was a modal
 *  satellite or a routed page. */
export const buildShareInputForCreate = (
  kind: ReceptionEndpointKind,
  result: ReceptionEndpointCreateResult,
  expires_at: number | null,
  now: number,
): { share_url: string; title: string; description: string; expiry_note?: string } => {
  const copy = RECEPTION_KIND_COPY[kind];
  // expiry_label is "Never expires" / "Expires in N days" — passing it
  // verbatim as the share card's expiry_note keeps the substrate's copy
  // consistent across the Settings list view + the share-card surface.
  const expiry_note = expires_at !== null ? computeExpiryLabel(expires_at, now) : undefined;
  return {
    share_url: result.share_url_once,
    title: `Your new ${copy.singular}`,
    description: copy.description,
    ...(expiry_note !== undefined ? { expiry_note } : {}),
  };
};

// ════════════════════════════════════════════════════════════════
// Host options + handle
// ════════════════════════════════════════════════════════════════

/** Options for `mountReceptionPageHost`. */
export interface ReceptionPageHostOptions {
  /** Host element where `mountReceptionPage` renders the spine list view.
   *  The page mount stays mounted here for the host's full lifetime —
   *  satellite mounts go into `modalHost`, not this one. */
  pageHost: HTMLElement;
  /** Host element where `mountAuthoringForm` / `mountLaunchWizard` render
   *  their working-config containers — distinct from `pageHost` so the
   *  page list stays visible underneath + the shell-subscribed list
   *  re-projects automatically when the satellite closes. The consumer
   *  owns the visual layout (overlay / sidebar / column-split). */
  modalHost: HTMLElement;
  /** The page shell — both the page mount + the satellite mounts drive
   *  rpc through this. */
  shell: ReceptionPageShell;
  /** Current exposure profile id — feeds the launch wizard's
   *  `current_exposure_profile` (the planner flags `profile_switch_needed`
   *  when it is not the recommended one). */
  exposureProfile: string;

  // ── Seams the host can't infer from substrate ─────────────────────

  /** Resolve the current `ReceptionPageConfig` singleton for the
   *  `reception-edit-page` flow. The projected `page.sections[].rows[]`
   *  model intentionally does NOT carry the singleton's raw `metadata`
   *  blob (the spine projects only the visible bits), so the consumer
   *  plugs in their own access — typically a cached `openDetail` over
   *  the singleton endpoint id, or a separate `reception.page.get` rpc
   *  if the surface adds one. Returns null for the fresh-seed case (no
   *  singleton exists yet — `mountAuthoringForm` falls back to its
   *  `seedWorkingConfig` defaults). */
  resolvePageConfig?: () => ReceptionPageConfig | null;
  /** Resolve an `IntakeFormConfig` seed from a template ref for the
   *  templates-browser "Use template" pick (an intake_form card). The
   *  consumer typically wraps the contract's `useIntakeFormTemplate` over
   *  a loaded `IntakeFormTemplate` + the user-typed display name. Returns
   *  null for an unknown / not-yet-loaded template — the host then enters
   *  the authoring form with a fresh seed (the user can still hand-build
   *  the form). */
  resolveTemplateSeed?: (templateRef: string) => IntakeFormConfig | null;
  /** Resolve the raw Foundation-pack templates for the standalone
   *  templates-browser modal (`reception-open-templates`, the daily-use
   *  "+ New" entry point). The route layer's natural impl returns its
   *  `reception.template.list` cache. Defaults to `() => []` — the
   *  gallery then renders the "Foundation pack not installed" empty
   *  state. */
  getTemplates?: () => ReadonlyArray<IntakeFormTemplate>;
  /** D-151 — resolve the raw non-intake config templates (`scheduling_link`
   *  + `reception_page`) for the standalone templates-browser modal. The
   *  route layer returns its `reception.template.list` `config_templates`
   *  cache. Defaults to `() => []` — no config-template sections render. */
  getConfigTemplates?: () => ReadonlyArray<ReceptionConfigTemplate>;
  /** D-220 Slice B — resolve the intake templates INSTALLED PACKS shipped
   *  for the standalone templates-browser modal. The route layer returns its
   *  `reception.template.list` `pack_templates` cache. Defaults to `() => []`
   *  — no pack section renders. */
  getPackTemplates?: () => ReadonlyArray<PackReceptionTemplateListing>;
  /** D-220 Slice B — stored pack templates the server could not admit
   *  (`pack_templates_unavailable`), surfaced by the gallery as a note. */
  getPackTemplatesUnavailable?: () => ReadonlyArray<PackReceptionTemplateUnavailable>;
  /** D-151 — resolve a per-kind config seed from a config-template ref for
   *  the "Use template" flow on a non-intake card. The route wraps the
   *  contract's `receptionConfigFromTemplate` over a loaded template + an
   *  empty display name (the user types it in the authoring form). Returns
   *  null for an unknown / not-yet-loaded ref — the host then opens the
   *  authoring form with a fresh seed for the card's kind. */
  resolveConfigTemplateSeed?: (templateRef: string) => ReceptionConfigTemplateSeed | null;
  /** D-151 P2 — intent-first authoring seam. The standalone templates-
   *  browser modal renders a "Describe it with AI" entry (the intent-first
   *  sibling of the template gallery) ONLY when this is provided; the host
   *  forwards it to the mount. On submit the consumer runs
   *  `reception.compose.propose` over the free text + converts the result
   *  to a per-kind authoring seed (`proposedEndpointConfigToAuthoringSeed`),
   *  returning `{ ok: true, kind, config, reason? }` on success or
   *  `{ ok: false, message }` on a friendly degraded path. On `ok` the host
   *  opens the authoring form seeded with `config` (the same
   *  `openAuthoringForm` path "Use template" takes). Absent ⇒ the gallery
   *  hides the Describe-it section entirely. */
  onProposeIntent?: (
    intent: string,
  ) => Promise<
    | { ok: true; kind: ReceptionEndpointKind; config: object; reason?: string }
    | { ok: false; message: string }
  >;
  /** Returns true while the consumer's page-config cache is NOT yet
   *  ready to seed the singleton edit. When set, the host (a) renders
   *  the singleton's "Edit page" button + the section's `reception_page`
   *  create button in a disabled state with a "Loading…" tooltip, and
   *  (b) drops any `reception-edit-page` dispatch defensively so a
   *  test-synthesized click can't bypass the visual gate. Defaults to
   *  `() => false` (no gating).
   *
   *  Why: `resolvePageConfig` returns `null` for two distinguishable
   *  situations — fresh-install (no singleton yet) and cache-not-loaded
   *  (race window). The host has no way to tell them apart, so without
   *  this seam an Edit click during the race window opens the authoring
   *  form with default values + the user's submit silently overwrites
   *  the existing singleton. The route layer above (`mountReceptionRoute`
   *  DD#2) flips this gate based on its own `pageConfigLoaded` flag,
   *  which carries the missing context. */
  gateEditPage?: () => boolean;
  /** D-169 P2 (N.9) — resolve the current count of open D-158 asks
   *  awaiting the user. Forwarded verbatim to
   *  `ReceptionPageViewOptions.resolvePendingAsksCount`; `> 0` decorates
   *  the status header's Approvals nav link with the "N awaiting you"
   *  count badge. The route layer (`mountReceptionRoute`) keeps the value
   *  fresh off the `notification.ask` / `notification.ask_closed` bus.
   *  Defaults (in the page mount) to `() => 0` — no badge. */
  resolvePendingAsksCount?: () => number;
  /** Override the default `PacketDeclaration` factory — the host calls
   *  this whenever it needs a declaration for a link kind's preview /
   *  create dispatch. Consumers plug in their own minting policy for
   *  `approval_link` / `status_link` (or to override drop_link's id
   *  allocation). Defaults to `buildDefaultPacketDeclaration`. */
  buildPacketDeclaration?: (
    kind: ReceptionEndpointKind,
    config: object,
  ) => PacketDeclaration | null;
  /** Render content for the wizard's three non-config-editing steps
   *  (`profile_check` / `view_as_visitor` / `share`) — other satellites
   *  with no mount yet. Forwarded straight to the wizard's
   *  `renderStepContent` seam; the host imposes no contract beyond what
   *  the wizard mount documents (return the slot HTML or null). */
  renderWizardStepContent?: (stepId: LaunchWizardStepId) => string | null;
  /** Bridge the wizard's `switch-profile` button to D-148's exposure
   *  rpc — the wizard owns no exposure-profile dispatch. The host
   *  forwards verbatim; consumer triggers the rpc + (on success) calls
   *  `update()` so the wizard refetches via the next mount. */
  onSwitchProfile?: () => void;
  /** Bridge the four host-forwarded actions that aren't mount launches
   *  (`reception-extend` / `reception-rotate-token` / `reception-revoke`
   *  / `reception-emergency-disable-all`) — these need a date / reason /
   *  confirm prompt this host doesn't draw. Receives the action name +
   *  the matched element's `dataset`. Absent ⇒ those actions are no-ops
   *  (the page renderer still draws their buttons). The natural sink:
   *  `mountReceptionPromptsHost`'s `open()` method — wire as
   *  `onPromptAction: promptsHost.open`. */
  onPromptAction?: (action: ReceptionHostPromptAction, dataset: DOMStringMap) => void;
  /** R19 Slice 2 — routed full-page authoring. When provided, the host
   *  NAVIGATES to a routed authoring page for the three authoring entry
   *  points (`reception-new-endpoint`, `reception-edit-page`, and a
   *  template / AI pick in the standalone templates browser) instead of
   *  opening the modal satellite. The route layer plugs in a navigator
   *  (set the `#reception/endpoints/new|edit/<kind>` hash) + stashes any
   *  `seedConfig` for the routed section to pick up. Absent ⇒ the host
   *  falls back to the modal authoring form (the pre-R19 path), so the
   *  non-routed compositions + their tests are unaffected. */
  onEnterAuthoring?: (target: EnterAuthoringTarget) => void;
  /** R19 Slice 3 — routed full-page Launch Wizard. When provided, the
   *  `reception-launch-wizard` action NAVIGATES to a routed wizard page
   *  (`#reception/endpoints/setup`) instead of opening the modal satellite
   *  — the same "can't enable" fix as `onEnterAuthoring` (the modal overlay
   *  is the bug). The route layer plugs in a navigator (set the
   *  `#reception/endpoints/setup` hash). Absent ⇒ the host falls back to
   *  the modal wizard (the pre-R19 path), so the non-routed compositions +
   *  their tests are unaffected. */
  onEnterWizard?: () => void;
  /** D-200 Slice 6g.4 — routed fixed pair selector. The intake-row
   *  `reception-pair-intake-recipe` action names only the local endpoint;
   *  the bootstrap routes to `#reception/endpoints/pair/<endpoint-id>`,
   *  where the selector reads `recipe.list` + the server-derived pair.
   *  Absent ⇒ the legacy non-routed composition safely does nothing. */
  onEnterPairing?: (endpointId: string) => void;
  /** R19 Slice 4 — routed endpoint detail. Forwarded verbatim to
   *  `mountReceptionPage`'s `onEnterDetail` / `onExitDetail`: when wired the
   *  spine's per-row "Detail" + the detail view's "Back to Reception"
   *  navigate to / from the `#reception/endpoints/<id>` deep link instead of
   *  the in-place `shell.openDetail` / `closeDetail`. Absent ⇒ the in-place
   *  path (the non-routed compositions + their tests). */
  onEnterDetail?: (endpointId: string) => void;
  onExitDetail?: () => void;
  /** Clock seam — defaults to `Date.now`. Threaded into the wizard
   *  mount's `now` + into the share-card expiry-note composition. */
  now?: () => number;
}

/** Mounted host handle. */
export interface ReceptionPageHost {
  /** Re-render the underlying page mount (rare — the shell subscription
   *  drives renders). Does not touch the open modal. */
  update(): void;
  /** Dispose the open modal mount + the page mount + clear both hosts.
   *  Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// mountReceptionPageHost
// ════════════════════════════════════════════════════════════════

/** Mount the full Reception Settings host — the page mount in `pageHost`
 *  + a satellite-mount slot in `modalHost`. Forwards the
 *  mount/routing actions natively (`reception-new-endpoint` /
 *  `reception-edit-page` / `reception-pair-intake-recipe` /
 *  `reception-open-templates` / `reception-launch-wizard`)
 *  + bridges the four prompt-driven actions to `onPromptAction`.
 *
 *  On a successful create / wizard finish, captures each `share_url_once`
 *  via `shell.setEndpointShare` before disposing the modal — the
 *  substrate never re-surfaces the URL, so this is the single moment to
 *  register it. */
export const mountReceptionPageHost = (
  opts: ReceptionPageHostOptions,
): ReceptionPageHost => {
  const { pageHost, modalHost, shell } = opts;
  const now = opts.now ?? ((): number => Date.now());
  const buildPacket =
    opts.buildPacketDeclaration ?? buildDefaultPacketDeclaration;
  let modal: AuthoringFormMount | LaunchWizardMount | TemplatesBrowserMount | null =
    null;
  let disposed = false;

  /** Tear down the open modal mount + clear its host. No-op when no
   *  modal is open or the host is disposed. The page mount stays alive
   *  underneath — the shell-subscribed re-render shows the refetched
   *  list automatically. */
  const closeModal = (): void => {
    if (modal !== null) {
      modal.dispose();
      modal = null;
    }
  };

  /** Open a new authoring-form mount, disposing any open modal first.
   *  Captures the create result's `share_url_once` on close (link kinds
   *  only — the `reception_page` singleton has no share path).
   *
   *  Plumbs the consumer's `buildPacketDeclaration` through to the
   *  mount as a lazy factory — the mount calls it at preview / submit
   *  time with the current working config, so a user-typed
   *  `form_definition_id` on a fresh intake form flows in (a
   *  mount-time-static declaration would capture the empty seed +
   *  leave submit inert). The `expires_at` for hard-ceiling kinds
   *  (drop / approval / status) is also derived lazily inside the
   *  mount from the working config's `expiry_days`. */
  const openAuthoringForm = (
    args: Pick<AuthoringFormMountOptions, 'kind' | 'initialConfig'>,
  ): void => {
    if (disposed) return;
    closeModal();
    modal = mountAuthoringForm({
      host: modalHost,
      shell,
      kind: args.kind,
      now,
      ...(args.initialConfig !== undefined && args.initialConfig !== null
        ? { initialConfig: args.initialConfig }
        : {}),
      // Singleton ignores its packet declaration (no D-145 wrapper on
      // `page.upsert`) — omit the factory for it to keep the wire
      // surface minimal.
      ...(args.kind !== 'reception_page'
        ? {
            buildPacketDeclaration: (config: object): PacketDeclaration | null =>
              buildPacket(args.kind, config),
          }
        : {}),
      onClose: (result?: ReceptionEndpointCreateResult): void => {
        // The singleton has no share path (its `page.upsert` does not
        // return a `share_url_once` — `result` is undefined). For link
        // kinds, a successful create surfaces the result; cancel passes
        // no result either.
        if (result !== undefined && isReceptionEndpointKindAvailable(args.kind)) {
          shell.setEndpointShare(
            result.endpoint_id,
            buildShareInputForCreate(args.kind, result, null, now()),
          );
        }
        closeModal();
      },
    });
  };

  /** Enter the per-kind authoring form for a fresh `new` create — the
   *  R19 Slice 2 routed full page when `onEnterAuthoring` is wired, else
   *  the pre-R19 modal satellite (`openAuthoringForm`). Shared by the
   *  direct "New endpoint" dispatch + the templates browser's template /
   *  AI picks (each already resolved to a working seed config). The
   *  routed path hands `seedConfig` off out of band — the section reads
   *  it transiently (a `#reception/endpoints/new/<kind>` hash can't carry
   *  a full config). */
  const enterNewAuthoring = (
    kind: ReceptionEndpointKind,
    seedConfig: object | null,
  ): void => {
    if (opts.onEnterAuthoring !== undefined) {
      opts.onEnterAuthoring({ mode: 'new', kind, seedConfig });
      return;
    }
    openAuthoringForm({ kind, initialConfig: seedConfig });
  };

  /** Open a launch-wizard mount, disposing any open modal first.
   *  Registers every available `created[].result.share_url_once` from
   *  the run result on close. */
  const openLaunchWizard = (): void => {
    if (disposed) return;
    closeModal();
    modal = mountLaunchWizard({
      host: modalHost,
      shell,
      exposureProfile: opts.exposureProfile,
      now,
      ...(opts.renderWizardStepContent !== undefined
        ? { renderStepContent: opts.renderWizardStepContent }
        : {}),
      ...(opts.onSwitchProfile !== undefined
        ? { onSwitchProfile: opts.onSwitchProfile }
        : {}),
      onClose: (result?: LaunchWizardRunResult): void => {
        if (result !== undefined) {
          // Each created entry carries the one-shot `share_url_once` the
          // shell does NOT auto-cache. Register every one before the
          // modal disposes; the wizard's planner order is preserved
          // for every currently available endpoint kind.
          const at = now();
          for (const created of result.created) {
            if (!isReceptionEndpointKindAvailable(created.kind)) continue;
            shell.setEndpointShare(
              created.result.endpoint_id,
              buildShareInputForCreate(created.kind, created.result, null, at),
            );
          }
        }
        closeModal();
      },
    });
  };

  /** Open the standalone templates-browser modal, disposing any open
   *  modal first. "Use template" resolves the seed via `resolveTemplateSeed`
   *  + enters the intake_form authoring form (routed full page when
   *  `onEnterAuthoring` is wired, else the modal satellite, via
   *  `enterNewAuthoring`); the gallery's own close just tears the modal
   *  down. */
  const openTemplatesBrowser = (): void => {
    if (disposed) return;
    closeModal();
    // `transitioning` guards the order-of-operations hazard: the mount
    // fires `onUseTemplate` THEN `onClose`. `onUseTemplate` opens the
    // authoring form, which `closeModal`s the gallery + installs the
    // authoring mount as `modal`. The mount's trailing `onClose` would
    // then tear THAT authoring mount down — so we suppress it when a
    // template was picked (the authoring open already replaced the modal).
    let transitioning = false;
    modal = mountTemplatesBrowser({
      host: modalHost,
      templates: opts.getTemplates?.() ?? [],
      configTemplates: opts.getConfigTemplates?.() ?? [],
      // D-220 Slice B — the pack section + its unavailable note.
      packTemplates: opts.getPackTemplates?.() ?? [],
      packTemplatesUnavailable: opts.getPackTemplatesUnavailable?.() ?? [],
      now,
      onUseTemplate: (ref: string, kind: ReceptionEndpointKind): void => {
        transitioning = true;
        if (kind === 'intake_form') {
          enterNewAuthoring('intake_form', opts.resolveTemplateSeed?.(ref) ?? null);
          return;
        }
        // A non-intake config-template card — resolve its per-kind seed.
        // The seed carries its own kind (authoritative from the contract);
        // fall back to the card's stamped kind + a fresh seed when the
        // template is not loaded.
        const seed = opts.resolveConfigTemplateSeed?.(ref) ?? null;
        enterNewAuthoring(seed?.kind ?? kind, seed?.config ?? null);
      },
      // D-151 P2 — the intent-first sibling. Absent ⇒ the mount hides
      // its Describe-it section. `onUseProposed` opens the authoring form
      // seeded with the AI-projected config; the `transitioning` guard
      // suppresses the mount's trailing `onClose` (the authoring open
      // already replaced the modal — same hazard as `onUseTemplate`).
      ...(opts.onProposeIntent !== undefined
        ? { onProposeIntent: opts.onProposeIntent }
        : {}),
      onUseProposed: (kind: ReceptionEndpointKind, config: object): void => {
        transitioning = true;
        enterNewAuthoring(kind, config);
      },
      onClose: (): void => {
        // The explicit close control tears the gallery down; a close that
        // trails a "Use template" pick is a no-op (the authoring form
        // already owns the modal slot).
        if (transitioning) return;
        closeModal();
      },
    });
  };

  /** Dispatch one host-forwarded action to its mount-launch / prompt-
   *  bridge handler. */
  const dispatch = (
    action: ReceptionPageAction,
    dataset: DOMStringMap,
  ): void => {
    if (disposed) return;
    if (PROMPT_ACTION_SET.has(action)) {
      opts.onPromptAction?.(action as ReceptionHostPromptAction, dataset);
      return;
    }
    if (!MOUNT_ACTION_SET.has(action)) {
      // Unreachable by `ReceptionPageAction` exhaustiveness — every
      // host-forwarded action is in either MOUNT or PROMPT — but
      // guard defensively so a future contract widen does not silently
      // drop dispatches.
      return;
    }
    switch (action as ReceptionHostMountAction) {
      case 'reception-launch-wizard':
        if (opts.onEnterWizard !== undefined) {
          // Routed full page (R19 Slice 3) — the wizard navigates to its
          // own page instead of the transparent modal satellite. The
          // routed section registers each created endpoint's share URL on
          // finish, just as `openLaunchWizard` does here.
          opts.onEnterWizard();
          return;
        }
        openLaunchWizard();
        return;
      case 'reception-edit-page': {
        // Defense-in-depth — the renderer already disables the button
        // when the gate is closed, but a synthesized click (e.g. from a
        // test fake host) would bypass the DOM-level guard. Drop the
        // dispatch silently so the same gate semantics hold either way.
        if (opts.gateEditPage?.() === true) return;
        if (opts.onEnterAuthoring !== undefined) {
          // Routed full page (R19 Slice 2). The section re-fetches
          // `reception.page.get` itself, so the stale-`null` overwrite
          // race the modal path guards against with `resolvePageConfig`
          // is closed at the section (fetch-before-seed), not here.
          opts.onEnterAuthoring({ mode: 'edit', kind: 'reception_page' });
          return;
        }
        const seed = opts.resolvePageConfig?.() ?? null;
        openAuthoringForm({
          kind: 'reception_page',
          initialConfig: seed,
        });
        return;
      }
      case 'reception-new-endpoint': {
        const kind = dataset.kind;
        if (kind === undefined || !isReceptionEndpointKind(kind)) return;
        // The page renderer never emits `reception-new-endpoint` for
        // the singleton (the section uses `reception-edit-page`
        // instead), but guard so a hand-crafted dataset can't land on
        // the wrong mount.
        if (kind === 'reception_page') return;
        if (!isReceptionEndpointKindAvailable(kind)) return;
        enterNewAuthoring(kind, null);
        return;
      }
      case 'reception-pair-intake-recipe':
        if (dataset.endpointId !== undefined) {
          opts.onEnterPairing?.(dataset.endpointId);
        }
        return;
      case 'reception-open-templates':
        openTemplatesBrowser();
        return;
    }
  };

  // ── Mount the spine list view ────────────────────────────────────
  const pageView: ReceptionPageView = mountReceptionPage({
    host: pageHost,
    shell,
    now,
    onUnhandledAction: dispatch,
    ...(opts.gateEditPage !== undefined ? { gateEditPage: opts.gateEditPage } : {}),
    ...(opts.resolvePendingAsksCount !== undefined
      ? { resolvePendingAsksCount: opts.resolvePendingAsksCount }
      : {}),
    // R19 Slice 4 — routed detail open/close (forwarded verbatim; absent ⇒
    // the page mount keeps the in-place `shell.openDetail` / `closeDetail`).
    ...(opts.onEnterDetail !== undefined ? { onEnterDetail: opts.onEnterDetail } : {}),
    ...(opts.onExitDetail !== undefined ? { onExitDetail: opts.onExitDetail } : {}),
  });

  return {
    update: () => pageView.update(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      closeModal();
      pageView.dispose();
    },
  };
};
