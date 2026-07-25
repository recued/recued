/** D-149 follow-on § A.9 — Reception Settings route entrypoint.
 *
 *  The natural mount point for an `app.recued.com` Reception Settings
 *  route. Sits on top of `mountReceptionSettings` and adds the one
 *  layer the settings host deliberately externalised: the cache that
 *  feeds `resolvePageConfig` + `resolveTemplateSeed`.
 *
 *  ── What this module owns ─────────────────────────────────────────
 *    - The two rpc reads the settings host CAN'T own without coupling
 *      to a `Conn` shape — `reception.page.get` (singleton config) +
 *      `reception.template.list` (raw Foundation-pack templates). The
 *      route keeps its own raw `IntakeFormTemplate` cache to feed the
 *      standalone templates-browser modal's "Use template" bridge (the
 *      shell no longer projects an inline templates model).
 *    - Cache freshness — `resolvePageConfig` returns whatever was most
 *      recently fetched. The page-config cache refreshes on every
 *      shell-state change (after `upsertReceptionPage`, after a
 *      `reception.endpoint_changed` broadcast triggers the spine
 *      refetch) so the next "Edit page" click reads the just-upserted
 *      config (DD#3). The raw-templates cache loads once on mount — it is
 *      static pack content, so nothing in shell state drives a reload.
 *    - Initial-load ordering — `reception.page.get` runs FIRST; only
 *      once it resolves (success or capped retry exhaustion) do we
 *      fire `shell.loadPage()`. The spine's "Edit page" button is
 *      gated on `state.page` being populated, so serializing this way
 *      means the cache is fresh by the time the button is clickable
 *      (DD#2 / Codex P1 fold).
 *
 *  ── Key design decisions (non-obvious — READ before touching) ─────
 *
 *  DD#1 — The route handler takes three PRE-BUILT host elements, not
 *  a single root it carves into children. Same shape as
 *  `mountReceptionSettings` (the layer below) — for the same reason:
 *  the webclient does not call `document.createElement` anywhere (no
 *  jsdom in tests, every host accepts a pre-built element). The PWA
 *  bootstrap is the natural place for the `<div data-reception-shell-slot=...>`
 *  × 3 construction + the `RECEPTION_SETTINGS_SHELL_STYLES` injection
 *  — that's a 5-line bootstrap that doesn't merit unit coverage.
 *
 *  DD#2 — Initial loads serialize `loadPage` AFTER the first
 *  `reception.page.get` attempt (success or one-shot retry). Why this
 *  ordering matters: `mountReceptionPageHost.resolvePageConfig`
 *  documents `null` to mean "fresh-install case (no singleton exists
 *  yet)". If we let the spine render + Edit button appear before the
 *  cache loads, an early click reads a synchronous `null` from an
 *  unloaded cache, the host treats that as fresh-install, the
 *  authoring form opens with defaults, and submit replaces the
 *  existing singleton with a blank-canvas write — silent overwrite
 *  (Codex review P1). Serializing the load order means the Edit
 *  button only becomes visible once `state.page` populates, which
 *  follows `shell.loadPage()`, which we hold until page-config has
 *  had one round-trip. On rpc failure we retry ONCE with a 300ms
 *  delay then fire `loadPage` anyway — the spine isn't held hostage
 *  to a broken server. The residual hard-failure case (both attempts
 *  fail, `loadPage` fires, spine renders, Edit click reads a `null`
 *  cache) is closed by the `gateEditPage` seam in DD#7: while
 *  `pageConfigLoaded` is false the host disables both Edit-page
 *  buttons + the dispatch drops any synthesized click, so a hard
 *  failure leaves the user with a disabled "Loading…" button rather
 *  than an overwrite path. Templates load in parallel and have no
 *  ordering constraint.
 *
 *  DD#3 — Page-config cache refreshes on every shell-state change.
 *  The shell's `upsertReceptionPage` triggers a list refetch which
 *  mutates state.page, which fires our listener, which re-reads
 *  `reception.page.get`. Same path catches `reception.endpoint_changed`
 *  broadcasts that re-trigger the list refetch. We don't try to
 *  filter on which state field changed — `reception.page.get` is a
 *  cheap singleton read + the coalescing flag absorbs any storms.
 *
 *  DD#4 — Template seed uses an empty `display_name`. The contract's
 *  `intakeFormConfigFromTemplate` requires a display_name (per-endpoint,
 *  user-supplied), but the route handler has no display_name at the
 *  time `resolveTemplateSeed` fires (the host's dataset only carries
 *  `template-ref`). We seed with `''` so the authoring form pre-loads
 *  every template field except display_name; the user types it before
 *  submit. The contract validator catches an empty display_name at
 *  submit time via `display_name_empty`, so the user sees inline
 *  remediation, not a silent failure. Better than seeding with a
 *  fabricated placeholder that would land in the persisted config.
 *
 *  DD#5 — Dispose unsubscribes from the shell BEFORE tearing the
 *  settings host down. The host's dispose chain (page host → prompts
 *  host) can synchronously close an open authoring mount whose close
 *  handler calls `shell.setEndpointShare` — that mutates shell state +
 *  notifies our subscriber. If we unsubscribed AFTER, that final
 *  notification would fire a no-op `reception.page.get` rpc on a
 *  disposed route. Unsubscribing first is harmless (any in-flight
 *  rpc still resolves; the `disposed` guard drops its write).
 *
 *  Raw-templates cache — loaded once on mount (`reloadTemplates`). It is
 *  static Foundation-pack content the standalone templates-browser modal's
 *  "Use template" bridge reads via the route's raw `IntakeFormTemplate`
 *  cache. The shell no longer projects an inline templates model, so there
 *  is no shell-state signal to refresh against (the old DD#6 reference-
 *  tracking refresh was retired with that satellite).
 *
 *  DD#7 — `gateEditPage` returns `!pageConfigLoaded`, and the route
 *  forces an explicit `host.update()` on the false→true transition.
 *  Why both: the host's renderer re-renders on every shell-state
 *  change (DD#3), but the gate signal lives in the route's own
 *  `pageConfigLoaded` flag, which a shell-state change doesn't
 *  necessarily fire alongside. In the hard-failure-then-recovery
 *  case (both initial page.gets fail, loadPage fires, then a later
 *  state-change-driven reload succeeds), the shell-driven re-render
 *  happens BEFORE the cache-reload succeeds — so without the
 *  explicit redraw the gate would stay visually closed until the
 *  NEXT state change. The transition guard means we only redraw on
 *  the rising edge — every other successful reload just refreshes
 *  the cache contents, no gate-state movement, no extra render
 *  needed (the next shell-state change picks up the fresh cache
 *  naturally via DD#3). The `host` reference is initialized before
 *  any `reloadPageConfig` body runs (the initial-load IIFE is
 *  async + the subscribe listener fires only after mount), so the
 *  closure capture is safe.
 *
 *  DD#8 — D-169 P2 (N.9) Approvals nav badge. The route also owns the
 *  "N awaiting you" count on the status header's Approvals link. It is a
 *  cross-cutting affordance (the asks inbox is a different top-level
 *  route), NOT part of the reception-page model — so it lives here in the
 *  composition layer, beside the page-config / templates caches, rather
 *  than bleeding into `ReceptionPageShellState`. The count threads to the
 *  renderer through the same shape as `gateEditPage`: a `() => number`
 *  seam (`resolvePendingAsksCount`) re-read on every render, with the
 *  route forcing `host.update()` whenever the value moves. Unlike DD#7's
 *  rising-edge guard, the badge redraws on EVERY count change — no shell-
 *  state event accompanies an ask bus frame, so nothing else would repaint
 *  it (`mountReceptionPage`'s `html === lastHtml` dedup keeps redundant
 *  updates cheap). Gated on both `opts.subscribe` and
 *  `opts.enablePendingAsks !== false`: absent/disabled ⇒ the feature is
 *  inert (count 0, no badge, no `notification.pending_asks` rpc). Keeping
 *  this feature flag separate from the bus seam matters because Reception
 *  inbox and D-200 pair views still need live invalidations when the separate
 *  Approvals route is disabled. The same
 *  closure-capture-is-safe reasoning as DD#7 applies — `reloadPendingAsks`
 *  only touches `host` after its `await`, and the seed/subscription run
 *  after `host` is assigned.
 *
 *  Spec: D-149 § A.9 (Settings UX integration);
 *  D-169 § N.9 (count badge). */

import type {
  Conn,
  IntakeFormTemplate,
  LaunchWizardStepId,
  PacketDeclaration,
  ReceptionConfigTemplate,
  ReceptionEndpointKind,
  ReceptionPageConfig,
  ServerRpcRegistry,
} from '@recued/contracts';
import {
  intakeFormConfigFromTemplate,
  proposedEndpointConfigToAuthoringSeed,
} from '@recued/contracts';

import { receptionConfigTemplateAuthoringSeed } from './reception-config-templates.js';
import type { EnterAuthoringTarget } from './reception-page-host.js';
import {
  mountReceptionInboxPanel,
  type ReceptionInboxPanelMount,
} from '../reception/inbox-panel.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import type { ReceptionPageShell } from './reception-page-shell.js';
import {
  mountReceptionSettings,
  type ReceptionSettingsHost,
} from './reception-settings-host.js';
import type { ReceptionPromptKind } from './reception-prompts-host.js';

// ════════════════════════════════════════════════════════════════
// Conn + options
// ════════════════════════════════════════════════════════════════

/** Typed rpc dispatch narrowed to the route-owned reads. The host
 *  injects a full `Conn<ServerRpcRegistry>` (or wider); the route only
 *  needs the page/template/inbox slices plus the D-169 P2 (N.9)
 *  pending-asks count and D-200's routed pair-selector reads/writes. */
export type ReceptionRouteConn = Conn<
  Pick<
    ServerRpcRegistry,
    | 'reception.page.get'
    | 'reception.template.list'
    | 'reception.compose.propose'
    | 'recipe.list'
    | 'reception.intake_recipe_pair.get'
    | 'reception.intake_recipe_pair.bind'
    | 'reception.intake_recipe_pair.configure'
    | 'reception.intake_recipe_pair.clear'
      | 'notification.pending_asks'
    | 'reception.inbox.list'
    | 'reception.inbox.approve'
    | 'reception.inbox.reject'
    // D-210 §4c — the Records section. Added here rather than plumbed as
    // callers from `webclient-bootstrap.ts`: the host already injects a full
    // `Conn<ServerRpcRegistry>`, which satisfies the wider Pick by
    // contravariance, so the whole section costs no bootstrap edit.
    //
    // `form_response.*` + `execute` are the Responses lens (the `#data` →
    // Received surface, moved here on the owner's IMMUTABLE/MUTABLE rule);
    // `recipe.list` above is reused by its manual-run automation picker.
    | 'reception.record.list'
    | 'form_response.list'
    | 'form_response.get'
    | 'execute'
    // D-174 ref-picker — the inbox's "Destination" combobox reads the
    // work-entity Source registry for its options.
    | 'work_entity.source.list'
  >
>;

/** Options for `mountReceptionRoute`. Combines the three pre-built host
 *  elements (DD#1) + the shell + the rpc conn + every forwardable
 *  settings-host seam. */
export interface ReceptionRouteOptions {
  /** Spine list host — handed to `mountReceptionSettings.pageHost`. */
  pageHost: HTMLElement;
  /** D-173 P6 Reception Inbox host — optional so older direct route tests
   *  that provide only the three D-149 hosts keep mounting the spine. */
  inboxHost?: HTMLElement;
  /** DOM document seam for the D-173 inbox DOM-node mount. Optional because
   *  direct route tests without an inbox host do not need DOM construction. */
  document?: Document;
  /** Satellite-mount host — handed to `mountReceptionSettings.modalHost`. */
  modalHost: HTMLElement;
  /** Prompts-modal host — handed to `mountReceptionSettings.promptsHost`. */
  promptsHost: HTMLElement;
  /** The page shell — both the settings host + the route's cache
   *  refresh subscribe to it. */
  shell: ReceptionPageShell;
  /** Rpc dispatcher for the route-owned reads. The wider host's
   *  `Conn<ServerRpcRegistry>` satisfies the narrowed type by
   *  contravariance — no shim needed. */
  conn: ReceptionRouteConn;
  /** Current exposure profile id — forwarded to the settings host. */
  exposureProfile: string;

  // ── Forwarded settings-host seams (see ReceptionSettingsOptions) ──
  buildPacketDeclaration?: (
    kind: ReceptionEndpointKind,
    config: object,
  ) => PacketDeclaration | null;
  renderWizardStepContent?: (stepId: LaunchWizardStepId) => string | null;
  onSwitchProfile?: () => void;
  onPromptClose?: (kind: ReceptionPromptKind) => void;
  /** R19 Slice 2 — routed full-page authoring. Forwarded to the settings
   *  host → page host; when present the create / edit / template-pick
   *  entries navigate to a routed authoring page instead of the modal. */
  onEnterAuthoring?: (target: EnterAuthoringTarget) => void;
  /** R19 Slice 3 — routed full-page Launch Wizard. Forwarded to the
   *  settings host → page host; when present the `reception-launch-wizard`
   *  CTA navigates to a routed wizard page instead of the modal. */
  onEnterWizard?: () => void;
  /** D-200 Slice 6g.4 — routed fixed pair selector. Forwarded to the
   *  settings/page host; the bootstrap supplies the deep-link navigator. */
  onEnterPairing?: (endpointId: string) => void;
  /** R19 Slice 4 — routed endpoint detail open/close. Forwarded to the
   *  settings host → page host → page mount; when wired the spine's per-row
   *  "Detail" + the detail view's "Back to Reception" navigate to / from the
   *  `#reception/endpoints/<id>` deep link instead of the in-place
   *  `shell.openDetail` / `closeDetail`. */
  onEnterDetail?: (endpointId: string) => void;
  onExitDetail?: () => void;
  /** R19 Slice 4 — deep-link detail landing. When set, the route opens this
   *  endpoint's detail on mount (`#reception/endpoints/<id>` — the abuse
   *  "Investigate" target / a shared or refreshed detail URL). The route
   *  owns the shell, so it reconciles the persisted drill-in state directly
   *  rather than threading the id down to the page mount: on mount it clears
   *  any stale detail / view-as-visitor (the shell outlives route re-mounts)
   *  then opens this id. */
  initialDetailId?: string;
  now?: () => number;
  /** Shared broadcast-bus seam (the webclient bootstrap's `subscriber.on`).
   *  The route and sibling Reception sections use it for live invalidation.
   *  When `enablePendingAsks` is not false, this route additionally seeds
   *  the Approvals nav badge from `notification.pending_asks` and re-reads it
   *  on `notification.ask` / `.ask_closed`. Omitting the seam keeps direct
   *  read-only test compositions inert. All owned listeners unsubscribe on
   *  dispose. */
  subscribe?: BroadcastSubscriber['on'];
  /** Whether the Reception header should seed/subscribe the cross-route
   *  Approvals count. Defaults to enabled when `subscribe` exists. This is
   *  deliberately separate from the bus seam: disabling the Approvals route
   *  must not disable Reception inbox or pair invalidations. */
  enablePendingAsks?: boolean;
}

/** Mounted route handle — combined `update()` / `dispose()`. */
export interface ReceptionRoute {
  /** Forward a redraw to the settings host (which forwards to the page
   *  host — same shape as every other mount's `update()`). */
  update(): void;
  /** Tear down the shell subscription + the settings host, in that
   *  order (DD#5). Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// mountReceptionRoute
// ════════════════════════════════════════════════════════════════

/** Capped retry delay for the initial `reception.page.get`. Tests rely
 *  on this being short enough to not stall a typical `await flush()`. */
const INITIAL_PAGE_GET_RETRY_DELAY_MS = 300;

export const mountReceptionRoute = (
  opts: ReceptionRouteOptions,
): ReceptionRoute => {
  // R19 Slice 4 — reconcile the persisted shell drill-in state with the URL
  // BEFORE the spine subscribes + does its first render. The shell is created
  // once (webclient bootstrap) and OUTLIVES route re-mounts, so a detail /
  // view-as-visitor opened before a tab switch or a Back navigation would
  // otherwise leak into this mount's first render as a stale view. Clearing
  // up front gives a clean list render; the deep-link id (if any) re-opens
  // the detail below. view-as-visitor is purely ephemeral (never URL-backed),
  // so it is always cleared. No subscribers exist yet, so these notify nobody.
  opts.shell.closeViewAsVisitor();
  opts.shell.closeDetail();

  let pageConfig: ReceptionPageConfig | null = null;
  let pageConfigLoaded = false;
  let rawTemplates: ReadonlyArray<IntakeFormTemplate> = [];
  // D-151 — the non-intake config templates from the same
  // `reception.template.list` cache (scheduling links + contact pages).
  let rawConfigTemplates: ReadonlyArray<ReceptionConfigTemplate> = [];
  let disposed = false;
  // DD#3 — coalesce concurrent reloadPageConfig invocations. A storm of
  // shell-state changes (e.g. loadPage flipping loading=true → false →
  // page populated) would otherwise spawn N parallel rpcs.
  let reloadInFlight = false;
  let reloadQueued = false;
  // DD#8 — the open-ask count feeding the Approvals nav badge via the
  // `resolvePendingAsksCount` seam below. Seeded + kept fresh only when
  // `opts.subscribe` is wired. `asksReloadGeneration` is the stale-
  // response guard: a storm of close-together `notification.ask*` frames
  // each bump it; only the freshest in-flight `notification.pending_asks`
  // result writes the count (mirrors the Approvals panel's `loadGeneration`).
  let pendingAsksCount = 0;
  let asksReloadGeneration = 0;

  const reloadPageConfig = async (): Promise<void> => {
    if (reloadInFlight) {
      reloadQueued = true;
      return;
    }
    reloadInFlight = true;
    try {
      const result = await opts.conn('reception.page.get');
      if (disposed) return;
      // DD#7 — rising-edge guard: only force a redraw when the gate
      // actually flips. Steady-state cache refreshes rely on the
      // shell-state-change re-render path (DD#3) — adding a redraw
      // here would double-paint on every shell event.
      const wasLoaded = pageConfigLoaded;
      pageConfig = result.config;
      pageConfigLoaded = true;
      if (!wasLoaded) host.update();
    } catch {
      // Cache stays at the previous value; the shell's own error path
      // (last_error) surfaces failures the user actually triggered. A
      // failed background refresh is silent on purpose.
    } finally {
      reloadInFlight = false;
      if (reloadQueued && !disposed) {
        reloadQueued = false;
        void reloadPageConfig();
      }
    }
  };

  const reloadTemplates = async (): Promise<void> => {
    try {
      const result = await opts.conn('reception.template.list');
      if (disposed) return;
      rawTemplates = result.templates;
      rawConfigTemplates = result.config_templates;
    } catch {
      // rawTemplates / rawConfigTemplates stay at the previous value;
      // resolveTemplateSeed / resolveConfigTemplateSeed return null for any
      // ref not already cached, the host opens the authoring form with a
      // blank seed (the documented "template not loaded" fallback).
    }
  };

  // DD#8 — re-read the authoritative open-ask count + force a redraw when
  // it moves. Unlike reloadPageConfig (whose steady-state refreshes ride
  // the shell-state-change render path, DD#7), nothing else repaints the
  // badge — asks are independent of reception shell state — so this owns
  // its own `host.update()`. The `mountReceptionPage` `html === lastHtml`
  // dedup absorbs the redundant repaint when the count is unchanged (and
  // the early `next === pendingAsksCount` return skips even that).
  const reloadPendingAsks = async (): Promise<void> => {
    const gen = ++asksReloadGeneration;
    try {
      const result = await opts.conn('notification.pending_asks');
      if (disposed || gen !== asksReloadGeneration) return; // stale / torn down
      const next = result.asks.length;
      if (next === pendingAsksCount) return;
      pendingAsksCount = next;
      host.update();
    } catch {
      // Leave the prior count; a transient failure must not blank a badge
      // the user can still act on (same silent-background-failure posture
      // as reloadPageConfig / reloadTemplates).
    }
  };

  const host: ReceptionSettingsHost = mountReceptionSettings({
    pageHost: opts.pageHost,
    modalHost: opts.modalHost,
    promptsHost: opts.promptsHost,
    shell: opts.shell,
    exposureProfile: opts.exposureProfile,
    resolvePageConfig: () => pageConfig,
    resolveTemplateSeed: (templateRef) => {
      const template = rawTemplates.find(
        (t) => t.template_ref === templateRef,
      );
      if (template === undefined) return null;
      // DD#4 — empty display_name; the user types one in the form.
      return intakeFormConfigFromTemplate(template, { display_name: '' });
    },
    // The standalone templates-browser modal (`reception-open-templates`,
    // the "+ New" entry point) renders the raw Foundation-pack templates
    // the route caches off `reception.template.list`. Same cache
    // the `resolveTemplateSeed` bridge reads — the gallery shows the cards,
    // the bridge resolves the picked ref into a seed config.
    getTemplates: () => rawTemplates,
    // D-151 — the non-intake config templates (scheduling links + contact
    // pages) the same gallery renders, off the same cache.
    getConfigTemplates: () => rawConfigTemplates,
    resolveConfigTemplateSeed: (templateRef) => {
      const template = rawConfigTemplates.find(
        (t) => t.template_ref === templateRef,
      );
      if (template === undefined) return null;
      // Blank display_name (the user types one in the authoring form) +
      // blank an approval_link's placeholder target_id, so the form opens
      // ready for deliberate entry. See `receptionConfigTemplateAuthoringSeed`.
      return receptionConfigTemplateAuthoringSeed(template);
    },
    // D-151 P2 — intent-first authoring. The "Describe it with AI" entry
    // in the templates-browser modal runs `reception.compose.propose` over
    // the free text + converts the `ProposedEndpointConfig` into a per-kind
    // authoring seed (`proposedEndpointConfigToAuthoringSeed` — which drops
    // forbidden field types at the contract boundary). On rpc failure it
    // returns a friendly degraded message (the gallery stays usable).
    onProposeIntent: async (intent) => {
      try {
        const proposed = await opts.conn('reception.compose.propose', {
          intent_text: intent,
        });
        const seed = proposedEndpointConfigToAuthoringSeed(proposed);
        return {
          ok: true,
          kind: seed.kind,
          config: seed.config,
          ...(proposed.ai_trace_redacted?.selection_reason_short !== undefined
            ? { reason: proposed.ai_trace_redacted.selection_reason_short }
            : {}),
        };
      } catch {
        return {
          ok: false,
          message:
            'Describe-it needs AI configured on this server — pick a template or build by hand.',
        };
      }
    },
    // DD#7 — the gate is closed while the cache has not loaded; the
    // renderer disables the Edit-page button + the host drops any
    // synthesized dispatch.
    gateEditPage: () => !pageConfigLoaded,
    // DD#8 — the Approvals nav badge count. Re-read on every render; the
    // route forces a redraw (in reloadPendingAsks) whenever the value
    // moves. Stays 0 → no badge when `opts.subscribe` is absent.
    resolvePendingAsksCount: () => pendingAsksCount,
    ...(opts.buildPacketDeclaration !== undefined
      ? { buildPacketDeclaration: opts.buildPacketDeclaration }
      : {}),
    ...(opts.renderWizardStepContent !== undefined
      ? { renderWizardStepContent: opts.renderWizardStepContent }
      : {}),
    ...(opts.onSwitchProfile !== undefined
      ? { onSwitchProfile: opts.onSwitchProfile }
      : {}),
    ...(opts.onPromptClose !== undefined
      ? { onPromptClose: opts.onPromptClose }
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
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const inbox: ReceptionInboxPanelMount | null =
    opts.inboxHost !== undefined
      ? mountReceptionInboxPanel({
          host: opts.inboxHost,
          conn: opts.conn,
          ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
          ...(opts.document !== undefined ? { document: opts.document } : {}),
          ...(opts.now !== undefined ? { now: opts.now } : {}),
        })
      : null;

  // DD#3 — every shell-state change re-reads the singleton config. (The
  // raw-templates cache for the standalone modal loads once below; nothing
  // in shell state drives a reload now — the old inline Templates browser
  // satellite was retired.)
  const unsubscribeShell = opts.shell.subscribe(() => {
    if (disposed) return;
    void reloadPageConfig();
  });

  // DD#2 — initial loads: page.get → shell.loadPage (serialized);
  // templates load in parallel.
  void (async (): Promise<void> => {
    await reloadPageConfig();
    if (disposed) return;
    if (!pageConfigLoaded) {
      // First attempt failed — one capped retry. The spine waits this
      // brief window before the Edit button can render; a transient
      // network blip resolves here, and a hard failure falls through
      // to fire loadPage anyway so the user isn't stuck (the residual
      // "Edit overwrites" risk in the hard-failure case requires a
      // host-layer seam — see DD#2).
      await new Promise<void>((r) =>
        setTimeout(r, INITIAL_PAGE_GET_RETRY_DELAY_MS),
      );
      if (disposed) return;
      await reloadPageConfig();
      if (disposed) return;
    }
    void opts.shell.loadPage();
  })();
  void reloadTemplates();

  // R19 Slice 4 — deep-link detail landing: open the endpoint's detail from
  // the URL, in parallel with the page / template loads (the spine subscribes
  // to the shell, so the resolved detail flips the view). `openDetail`'s own
  // refetch loads the endpoints list if `loadPage` has not landed yet, so this
  // is independent of the load ordering above. A stale / revoked id resolves
  // to `detail: null` (the spine falls back to the list) — never throws; the
  // `.catch` only swallows a transport rejection (the shell also captures it
  // into `last_error`). Detail open/close thereafter ride `onEnterDetail` /
  // `onExitDetail` (a fresh re-mount), so this fires once per landing.
  if (opts.initialDetailId !== undefined) {
    void opts.shell.openDetail(opts.initialDetailId).catch(() => {});
  }

  // DD#8 — Approvals nav badge: seed the count at mount + keep it live off
  // the bus. Gated separately from the shared bus seam: with no bus OR an
  // explicit `enablePendingAsks:false`, the feature is inert (no rpc, count
  // stays 0, no badge) while other Reception broadcast consumers stay live.
  // Both ask kinds are bus
  // signals to re-read the authoritative `notification.pending_asks` count
  // (the frame payload isn't consumed — the re-fetch is the source of
  // truth, same posture as the Approvals panel); the seed covers the at-
  // mount snapshot. Subscriptions drop on dispose.
  const asksUnsubscribes: Array<() => void> = [];
  if (opts.subscribe !== undefined && opts.enablePendingAsks !== false) {
    const onAskBusEvent = (): void => {
      if (disposed) return;
      void reloadPendingAsks();
    };
    asksUnsubscribes.push(opts.subscribe('notification.ask', onAskBusEvent));
    asksUnsubscribes.push(
      opts.subscribe('notification.ask_closed', onAskBusEvent),
    );
    void reloadPendingAsks();
  }

  return {
    update: () => {
      if (disposed) return;
      host.update();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // DD#5 — unsubscribe first so a satellite-close-driven state
      // mutation during host.dispose() doesn't fire a no-op rpc.
      unsubscribeShell();
      // DD#8 — drop the asks-count bus subscriptions; an in-flight
      // `notification.pending_asks` still resolves but the `disposed`
      // guard suppresses its write.
      for (const unsub of asksUnsubscribes) {
        try {
          unsub();
        } catch {
          // Unsubscribe errors are isolated — the subscriber owns its own
          // teardown; we only need to drop our handles.
        }
      }
      asksUnsubscribes.length = 0;
      inbox?.dispose();
      host.dispose();
    },
  };
};
