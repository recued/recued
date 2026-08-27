/** Reception route bootstrap — the DOM boundary above the three R19
 *  sections (`#reception/<section>`).
 *
 *  Every Reception mount in `apps/webclient/src/settings/` (+ the inbox in
 *  `apps/webclient/src/reception/`) takes pre-built host elements — the
 *  webclient does not call `document.createElement` anywhere else. This
 *  module is the ONE place that does — the natural mount point for the
 *  `app.recued.com` `#reception` route.
 *
 *  ── R19: from one-long-page to three sections ─────────────────────
 *  Pre-R19 this bootstrap built page + inbox + modal + prompts hosts and
 *  mounted ONE `mountReceptionRoute` over all of them — a single long
 *  scrolling page with the spine, the inbox below it, and the abuse +
 *  templates panels stacked at the bottom behind CTAs. R19 splits that
 *  into THREE deep-linked sections (`reception-sections.ts`), only ONE of
 *  which mounts per route instance (the same idiom as
 *  `bootstrap-connections-route.ts`):
 *    - **Inbox** (default)  — `mountReceptionInboxPanel` (the D-173 queue).
 *    - **Abuse**            — `mountReceptionAbuseSection` (reuses the
 *      shell's `loadAbuseInbox` / `banIp` / `unbanIp`).
 *    - **Endpoints**        — `mountReceptionRoute` (the spine: page +
 *      modal + prompts; NO inboxHost — the inbox is its own section now).
 *  `reception` is a `WEBCLIENT_DEEP_LINK_ROUTES` member, so a tab click
 *  changes the hash and the shell re-mounts this route with the new
 *  `initialSection` — back / forward / refresh all hold.
 *
 *  ── What the bootstrap owns ───────────────────────────────────────
 *    - **Route chrome.** A `<header>` introduction + a segmented tab bar of
 *      anchors (`#reception/<section>`) + a content host the active
 *      section mounts into.
 *    - **DOM construction.** The section-specific host divs. The
 *      Endpoints section keeps the page / modal / prompts triad the spine
 *      expects (modal + prompts carry `data-reception-shell-slot` so the
 *      fixed-overlay CSS targets them); the Inbox + Abuse sections get one
 *      plain host each.
 *    - **Style injection.** A single `<style>` tag in `document.head`
 *      with every CSS layer the route needs. Idempotent via a marker
 *      attribute (`data-recued-reception-styles`).
 *    - **Cleanup on dispose.** Tears down the active section mount then
 *      removes the route root from `opts.root`. The `<style>` tag stays —
 *      it is global, idempotent, and may be in use by another surface
 *      that shares the primitive layer.
 *
 *  ── What the bootstrap does NOT own ───────────────────────────────
 *  The caller constructs the `ReceptionPageShell` (over a typed
 *  `ReceptionConn` + the broadcast subscriber) and the rpc `Conn` itself
 *  — PWA-wide concerns (multiple Settings surfaces share one WS
 *  connection). The bootstrap takes them as inputs.
 *
 *  Spec: D-149 § A.9; design record
 *  internal design notes §9 + R19 / R19.1. */

import {
  PRIMITIVE_STYLES,
} from '@recued/ui-shared/primitives';

import {
  RECEPTION_AUTHORING_STYLES,
} from './reception-authoring-render.js';
import {
  LAUNCH_WIZARD_STYLES,
} from './reception-launch-wizard-render.js';
import {
  LAUNCH_WIZARD_MOUNT_STYLES,
} from './reception-launch-wizard-mount.js';
import {
  RECEPTION_PAGE_STYLES,
} from './reception-page-render.js';
import {
  RECEPTION_PROMPTS_HOST_STYLES,
} from './reception-prompts-host.js';
import {
  RECEPTION_TEMPLATES_BROWSER_STYLES,
} from './reception-templates-mount.js';
import { isReceptionEndpointKind } from '@recued/contracts';

import {
  mountReceptionRoute,
  type ReceptionRoute,
  type ReceptionRouteOptions,
} from './reception-route.js';
import type { EnterAuthoringTarget } from './reception-page-host.js';
import {
  mountReceptionAuthoringSection,
  stashReceptionAuthoringSeed,
} from './reception-authoring-section.js';
import {
  mountReceptionWizardSection,
} from './reception-launch-wizard-section.js';
import {
  mountReceptionIntakeRecipePairSection,
  RECEPTION_INTAKE_RECIPE_PAIR_SECTION_STYLES,
} from './reception-intake-recipe-pair-section.js';
import {
  RECEPTION_SETTINGS_SHELL_STYLES,
  type ReceptionSettingsShellSlot,
} from './reception-settings-host.js';
import {
  RECEPTION_SECTIONS,
  RECEPTION_ROUTE_CONTENT_ATTR,
  RECEPTION_ROUTE_HOST_ATTR,
  RECEPTION_ROUTE_TABS_ATTR,
  RECEPTION_SECTION_NAV_STYLES,
  type ReceptionSection,
} from './reception-sections.js';
import {
  parseReceptionAddress,
  receptionAddressSelection,
  receptionEndpointAuthoringAddress,
  receptionEndpointDetailAddress,
  receptionEndpointPairAddress,
  receptionEndpointSetupAddress,
  receptionHierarchicalAddress,
  receptionSectionAddress,
  type ReceptionAddress,
} from './reception-navigation.js';
import {
  mountReceptionAbuseSection,
} from './reception-abuse-section.js';
import {
  mountReceptionRecordsSection,
} from '../reception/records-section.js';
import {
  mountReceptionInboxPanel,
} from '../reception/inbox-panel.js';
import { createHierarchicalHistory } from '../shell/hierarchical-navigation.js';

// ════════════════════════════════════════════════════════════════
// Style payload
// ════════════════════════════════════════════════════════════════

/** Attribute name on the injected `<style>` tag. The bootstrap looks
 *  for this marker on entry to skip duplicate injection (idempotent
 *  across re-bootstraps + concurrent route instances). */
export const RECEPTION_BOOTSTRAP_STYLES_MARKER =
  'data-recued-reception-styles';

/** Aggregated CSS payload injected by `bootstrapReceptionRoute`. Order
 *  matters — `PRIMITIVE_STYLES` ships base classes (`.rx-btn`, `.rx-panel`,
 *  …) the Reception surface CSS overrides build on. */
export const RECEPTION_BOOTSTRAP_STYLES = [
  PRIMITIVE_STYLES,
  RECEPTION_SECTION_NAV_STYLES,
  RECEPTION_SETTINGS_SHELL_STYLES,
  RECEPTION_PAGE_STYLES,
  RECEPTION_AUTHORING_STYLES,
  LAUNCH_WIZARD_STYLES,
  LAUNCH_WIZARD_MOUNT_STYLES,
  RECEPTION_PROMPTS_HOST_STYLES,
  RECEPTION_TEMPLATES_BROWSER_STYLES,
  RECEPTION_INTAKE_RECIPE_PAIR_SECTION_STYLES,
].join('\n');

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

/** Options for `bootstrapReceptionRoute`. Strips the four pre-built host
 *  fields from `ReceptionRouteOptions` (the bootstrap owns those) + adds
 *  the caller-supplied `root` element, the DOM `document` seam, and the
 *  active `initialSection`. Every other forwardable seam flows through
 *  verbatim. */
export interface BootstrapReceptionRouteOptions
  extends Omit<
    ReceptionRouteOptions,
    'pageHost' | 'inboxHost' | 'modalHost' | 'promptsHost'
  > {
  /** Root element where the route chrome (header + tab bar + content) is
   *  appended. The caller chooses the root's width / height / position
   *  (in the PWA this is the app shell's content root). */
  root: HTMLElement;
  /** DOM document seam — defaults to `globalThis.document` so the browser
   *  pass-through is zero-config. Override for unit tests (the webclient
   *  ships with no jsdom in vitest). Throws if neither the option nor the
   *  global is available. */
  document?: Document;
  /** Preferred complete route selection. Positional options remain for narrow
   * mounts; production passes this parsed hierarchical address. */
  initialAddress?: ReceptionAddress;
  /** Shell-cache alignment after in-page endpoint preview writes. */
  onHashSync?: (hash: string) => void;
  /** Deep-link segment 0 — the active section (`#reception/<section>`).
   *  Defaults to `inbox` (an absent / unknown value degrades to the
   *  default per `resolveReceptionSection`). */
  initialSection?: string;
  /** Deep-link segment 1 (R19 Slice 2 / 3 / 4 + D-200 Slice 6g.4). On the `endpoints` section,
   *  `new` / `edit` routes the routed full-page authoring form
   *  (`#reception/endpoints/new|edit/<kind>`, Slice 2), `setup` routes the
   *  routed full-page Launch Wizard (`#reception/endpoints/setup`, Slice 3),
   *  `pair` routes the fixed pair selector (segment 2 is its endpoint id),
   *  and any other value is an endpoint-detail id — the spine opens that
   *  endpoint's detail on mount (`#reception/endpoints/<id>`, Slice 4).
   *  Absent ⇒ the spine list. */
  initialSubview?: string;
  /** Deep-link segment 2 — the authoring form's endpoint kind when
   *  `initialSubview` is `new` / `edit`, or the intake endpoint id when it
   *  is `pair`. */
  initialKind?: string;
  /** Hash navigator for routed authoring, setup, pairing, and narrow mounts.
   *  Defaults to `globalThis.location.hash =`. Injected in tests to
   *  assert navigation without touching real `location`. Production endpoint
   *  preview navigation uses the shared in-page history controller. */
  navigate?: (hash: string) => void;
}

/** Mounted route handle — combined `update()` / `dispose()`. */
export interface BootstrapReceptionRoute {
  /** The active section this route instance mounted. */
  activeSection(): ReceptionSection;
  /** Forward a redraw to the active section's mount (no-op if the section
   *  has no `update`). */
  update(): void;
  hasInFlightWork(): boolean;
  /** Route-scoped shell copy for unresolved Reception mutations. */
  inFlightWorkPrompt(): string | null;
  /** Tear down the active section mount + remove the route chrome.
   *  Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// bootstrapReceptionRoute
// ════════════════════════════════════════════════════════════════

/** Bootstrap the `#reception` route in the PWA. Injects the aggregated
 *  CSS payload once (marker guarded), builds the route chrome (header +
 *  tab bar + content), and mounts ONLY the active section into the
 *  content host. The returned handle's `dispose()` tears down that mount
 *  + removes the chrome from `root`. */
export const bootstrapReceptionRoute = (
  opts: BootstrapReceptionRouteOptions,
): BootstrapReceptionRoute => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapReceptionRoute: no document available — pass `opts.document` for non-browser environments',
    );
  }

  // Idempotent style injection. A second bootstrap (concurrent route or
  // remount after dispose / section switch) finds the existing marker +
  // skips.
  if (
    doc.head.querySelector(`style[${RECEPTION_BOOTSTRAP_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(RECEPTION_BOOTSTRAP_STYLES_MARKER, '');
    style.textContent = RECEPTION_BOOTSTRAP_STYLES;
    doc.head.appendChild(style);
  }

  const mountedAddress = opts.initialAddress ?? parseReceptionAddress({
    surface: 'reception',
    segments: [opts.initialSection, opts.initialSubview, opts.initialKind]
      .filter((segment): segment is string => segment !== undefined),
  })!;
  const initialSelection = receptionAddressSelection(mountedAddress);
  const section = initialSelection.section;
  const initialSubview = initialSelection.subview ?? undefined;
  const initialKind = initialSelection.value ?? undefined;
  const receptionHistory = createHierarchicalHistory({
    initial: receptionHierarchicalAddress(mountedAddress),
    history: () => doc.defaultView?.history,
    onCommit: (address) => opts.onHashSync?.(address.hash),
  });
  /** Only the endpoint spine owns the list/detail DOM needed for an in-place
   * preview transition. Authoring, setup, and pairing are separate full-page
   * mounts, so their completion must still navigate and let the shell remount
   * the spine at the new detail address. */
  const endpointPreviewIsMounted =
    mountedAddress.kind === 'endpoint-detail'
    || (mountedAddress.kind === 'section'
      && mountedAddress.section === 'endpoints');

  // ── Route chrome: host + header + tab bar + content ──
  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(RECEPTION_ROUTE_HOST_ATTR, '');

  const header = doc.createElement('header');
  header.className = 'reception-route-header';
  const heading = doc.createElement('h1');
  heading.className = 'reception-route-title';
  heading.textContent = 'Reception';
  header.appendChild(heading);
  const subtitle = doc.createElement('p');
  subtitle.className = 'reception-route-subtitle';
  subtitle.textContent =
    'Review incoming requests, protect public access, and manage every visitor-facing endpoint.';
  header.appendChild(subtitle);
  routeRoot.appendChild(header);

  // Tab bar — anchors whose href is the section deep link; a click changes
  // the hash, the shell re-mounts this route with the new section.
  const tabBar = doc.createElement('nav');
  tabBar.setAttribute(RECEPTION_ROUTE_TABS_ATTR, '');
  tabBar.setAttribute('aria-label', 'Reception sections');
  for (const tab of RECEPTION_SECTIONS) {
    const link = doc.createElement('a');
    link.className =
      'reception-route-tab'
      + (tab.id === section ? ' reception-route-tab--active' : '');
    link.setAttribute('href', receptionSectionAddress(tab.id).hash);
    link.textContent = tab.label;
    if (tab.id === section) link.setAttribute('aria-current', 'page');
    tabBar.appendChild(link);
  }
  routeRoot.appendChild(tabBar);

  const content = doc.createElement('div');
  content.setAttribute(RECEPTION_ROUTE_CONTENT_ATTR, '');
  routeRoot.appendChild(content);

  // R19 Slice 2 — hash navigator (spine → routed authoring page, and the
  // authoring page → list back nav). Defaults to setting the real URL
  // hash; tests inject a fake. Setting `location.hash` fires `hashchange`
  // → the shell re-mounts this deep-link route with the new segments.
  const navigate =
    opts.navigate ??
    ((hash: string): void => {
      const loc = (globalThis as { location?: { hash: string } }).location;
      if (loc !== undefined) loc.hash = hash;
    });

  // The spine's authoring entries (New endpoint / Edit page / a template
  // or AI pick) navigate to a routed full-page form instead of the
  // transparent modal. A seed (template / AI-proposed config) is stashed
  // for the routed section to pick up — a `…/new/<kind>` hash can't carry
  // a full config.
  const onEnterAuthoring = (target: EnterAuthoringTarget): void => {
    if (target.kind === 'status_link') return;
    if (target.seedConfig !== undefined && target.seedConfig !== null) {
      stashReceptionAuthoringSeed(target.kind, target.seedConfig);
    }
    navigate(
      receptionEndpointAuthoringAddress(target.mode, target.kind).hash,
    );
  };

  // R19 Slice 3 — the spine's "Start the Launch Wizard" CTA navigates to a
  // routed full-page wizard instead of the transparent modal. No seed to
  // stash (the wizard is a first-run flow with no inbound config).
  const onEnterWizard = (): void => {
    navigate(receptionEndpointSetupAddress().hash);
  };

  // D-200 Slice 6g.4 — the fixed owner pair selector is a routed page. The
  // row supplies only the local endpoint id; the section reads the current
  // pair + complete durable recipe list and sends source locators to core.
  const onEnterPairing = (endpointId: string): void => {
    navigate(receptionEndpointPairAddress(endpointId).hash);
  };

  // R19 Slice 4 — endpoint previews have durable, shareable addresses. The
  // production shell keeps the list mounted and pairs push/replace history
  // writes with the shell's openDetail/closeDetail state; narrow mounts without
  // the cache-alignment seam retain the original hash-remount fallback.
  const onEnterDetail = (endpointId: string): void => {
    const address = receptionEndpointDetailAddress(endpointId);
    if (opts.onHashSync === undefined || !endpointPreviewIsMounted) {
      navigate(address.hash);
      return;
    }
    receptionHistory.navigate(address);
    void opts.shell.openDetail(endpointId)
      .then(() => {
        // A stale/revoked id resolves successfully with no detail. Retire only
        // that obsolete child address; transport failures keep it available
        // for refresh/retry, and a newer open/close wins via the current check.
        if (
          opts.shell.getState().detail === null
          && receptionHistory.current().hash === address.hash
        ) {
          receptionHistory.navigate(receptionSectionAddress('endpoints'), {
            intent: 'replace',
          });
        }
      })
      .catch(() => {});
  };
  const onExitDetail = (): void => {
    const address = receptionSectionAddress('endpoints');
    if (opts.onHashSync === undefined || !endpointPreviewIsMounted) {
      navigate(address.hash);
      return;
    }
    receptionHistory.navigate(address, { intent: 'replace' });
    opts.shell.closeDetail();
  };

  // ── Mount the active section into the content host ──
  let mount: {
    update?: () => void;
    hasInFlightWork?: () => boolean;
    dispose: () => void;
  };

  // R19 Slice 2 — a `new` / `edit` segment-1 on the endpoints section
  // routes the full-page authoring form; `status_link` is create-hidden,
  // and any other segment-1 (a future endpoint-detail id, Slice 4) falls
  // through to the spine list below.
  const authoringMode =
    initialSubview === 'new' || initialSubview === 'edit'
      ? initialSubview
      : null;
  const authoringKind =
    initialKind !== undefined &&
    isReceptionEndpointKind(initialKind) &&
    initialKind !== 'status_link'
      ? initialKind
      : null;
  // `edit` only has semantics for the `reception_page` singleton — link
  // kinds are create-only (immutable; no per-endpoint edit route yet), so
  // a hand-crafted `#…/edit/<link-kind>` falls through to the spine rather
  // than opening a blank create-shaped form in edit mode (Codex LOW). The
  // `!== null` checks stay inline so they narrow `authoringMode`/
  // `authoringKind` for the mount call below.
  if (
    section === 'endpoints'
    && initialSubview === 'pair'
    && initialKind !== undefined
    && initialKind.length > 0
  ) {
    mount = mountReceptionIntakeRecipePairSection({
      host: content,
      conn: opts.conn,
      endpointId: initialKind,
      ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
    });
  } else if (section === 'endpoints' && initialSubview === 'setup') {
    // Routed full-page Launch Wizard (R19 Slice 3) — the § A.20.1 first-run
    // flow out of the transparent modal. Mounts straight into `content`; no
    // page / modal / prompts triad. The wizard EMBEDS the same per-kind
    // authoring forms Slice 2 routed, sharing the working-config machinery.
    mount = mountReceptionWizardSection({
      host: content,
      shell: opts.shell,
      exposureProfile: opts.exposureProfile,
      onBack: () => navigate(receptionSectionAddress('endpoints').hash),
      // R19 Slice 4 follow-up — a single-endpoint finish lands on its detail
      // so the one-shot Share Cards surface immediately (reuses onEnterDetail).
      onNavigateToDetail: onEnterDetail,
      document: doc,
      ...(opts.renderWizardStepContent !== undefined
        ? { renderStepContent: opts.renderWizardStepContent }
        : {}),
      ...(opts.onSwitchProfile !== undefined
        ? { onSwitchProfile: opts.onSwitchProfile }
        : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  } else if (
    section === 'endpoints' &&
    authoringMode !== null &&
    authoringKind !== null &&
    (authoringMode === 'new' || authoringKind === 'reception_page')
  ) {
    // Routed full-page authoring form — the headline R19 "can't enable"
    // fix (out of the transparent modal). Mounts straight into `content`;
    // no page / modal / prompts triad.
    mount = mountReceptionAuthoringSection({
      host: content,
      shell: opts.shell,
      conn: opts.conn,
      mode: authoringMode,
      kind: authoringKind,
      onBack: () => navigate(receptionSectionAddress('endpoints').hash),
      // R19 Slice 4 follow-up — a successful link create lands on the new
      // endpoint's detail so the one-shot Share Cards surface immediately.
      onNavigateToDetail: onEnterDetail,
      document: doc,
      ...(opts.buildPacketDeclaration !== undefined
        ? { buildPacketDeclaration: opts.buildPacketDeclaration }
        : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  } else if (section === 'endpoints') {
    // The spine keeps the page / modal / prompts triad. The modal +
    // prompts hosts carry `data-reception-shell-slot` so the fixed-overlay
    // CSS (backdrop + z-stacking + `:empty{display:none}`) targets them;
    // `position:fixed` makes their nesting under `content` irrelevant.
    //
    // R19 Slice 4 — a segment-1 that is neither absent nor an authoring verb
    // (`new` / `edit` handled above; `setup` is the wizard branch) is an
    // endpoint-detail id: the spine opens that endpoint's detail on mount
    // (`#reception/endpoints/<id>`). Any of those verbs ⇒ the plain list.
    const initialDetailId =
      initialSubview !== undefined &&
      initialSubview !== 'new' &&
      initialSubview !== 'edit' &&
      initialSubview !== 'setup' &&
      initialSubview !== 'pair'
        ? initialSubview
        : undefined;
    const pageHost = doc.createElement('div');
    pageHost.setAttribute('data-reception-shell-page-main', '');
    content.appendChild(pageHost);
    const modalHost = makeSlot(doc, content, 'modal');
    const promptsHost = makeSlot(doc, content, 'prompts');
    mount = mountReceptionRoute({
      pageHost,
      modalHost,
      promptsHost,
      document: doc,
      shell: opts.shell,
      conn: opts.conn,
      exposureProfile: opts.exposureProfile,
      // R19 Slice 2 — the create / edit / template entries navigate to the
      // routed authoring page (above) instead of opening the modal.
      onEnterAuthoring,
      // R19 Slice 3 — the "Start the Launch Wizard" CTA navigates to the
      // routed wizard page (above) instead of opening the modal.
      onEnterWizard,
      // D-200 Slice 6g.4 — the intake-row checkout action navigates to the
      // fixed source selector above instead of attempting pair work here.
      onEnterPairing,
      // R19 Slice 4 — per-row preview and Back share the hierarchical address;
      // `initialDetailId` opens it on a deep-link landing.
      onEnterDetail,
      onExitDetail,
      ...(initialDetailId !== undefined ? { initialDetailId } : {}),
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
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
      ...(opts.enablePendingAsks !== undefined
        ? { enablePendingAsks: opts.enablePendingAsks }
        : {}),
    }) satisfies ReceptionRoute;
  } else if (section === 'records') {
    // D-210 §4c — the IMMUTABLE reception layers: Requests (sealed, redacted)
    // + Responses (accepted `form_response`, moved from `#data` on the owner's
    // IMMUTABLE/MUTABLE rule). Reuses `opts.conn` (the wider route conn
    // satisfies both narrower lens conns by contravariance), so no new caller
    // is plumbed through the bootstrap.
    //
    // ⛔ Must sit ABOVE the final `else`: that branch is the Inbox DEFAULT, and
    // an unmatched section silently renders the Inbox rather than this.
    mount = mountReceptionRecordsSection({
      host: content,
      conn: opts.conn,
      ...(opts.document !== undefined ? { document: opts.document } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  } else if (section === 'abuse') {
    mount = mountReceptionAbuseSection({
      host: content,
      shell: opts.shell,
    });
  } else {
    // Inbox (default) — the D-173 review queue. Reuses `opts.conn` (the
    // wider route conn satisfies the narrower inbox conn by contravariance).
    mount = mountReceptionInboxPanel({
      host: content,
      conn: opts.conn,
      headingLevel: 2,
      ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
      ...(opts.document !== undefined ? { document: opts.document } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  }

  opts.root.appendChild(routeRoot);

  let disposed = false;
  return {
    activeSection: () => section,
    update: () => {
      if (disposed) return;
      mount.update?.();
    },
    hasInFlightWork: () => mount.hasInFlightWork?.() ?? false,
    // Keep the copy available for the outer bootstrap's tracked mutation
    // owner too: authoring/wizard writes are tracked above this route, while
    // the Inbox reports its own decision state through `hasInFlightWork`.
    inFlightWorkPrompt: () =>
      disposed
        ? null
        : 'A Reception action is still in progress. Leave Reception anyway?',
    dispose: () => {
      if (disposed) return;
      disposed = true;
      mount.dispose();
      try {
        opts.root.removeChild(routeRoot);
      } catch {
        routeRoot.remove();
      }
    },
  };
};

/** Build a `data-reception-shell-slot` overlay host + append it to the
 *  parent. Used for the Endpoints section's modal + prompts overlays. */
const makeSlot = (
  doc: Document,
  parent: HTMLElement,
  slot: ReceptionSettingsShellSlot,
): HTMLElement => {
  const el = doc.createElement('div');
  el.setAttribute('data-reception-shell-slot', slot);
  parent.appendChild(el);
  return el;
};
