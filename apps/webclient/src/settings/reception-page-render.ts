/** D-149 follow-on § A.9 — Settings → Server → Reception page renderer +
 *  mount (the host-side framework renderer).
 *
 *  The § A.9 spine + the five satellites are pure projection; the page
 *  shell (`reception-page-shell.ts`) is the stateful container that
 *  wires them to the `reception.*` rpc surface + the broadcast bus.
 *  Both are substrate — nothing draws pixels. **This is the renderer:
 *  the host-side piece that turns `ReceptionPageShellState` into DOM and
 *  wires `data-action` clicks back to the shell.**
 *
 *  ── Why "vanilla DOM" is the framework ────────────────────────────
 *  Per the chat barrel's note (`apps/webclient/src/chat/index.ts`) the
 *  webclient's UI renderer "lives in the user's framework of choice
 *  (React / Svelte / vanilla DOM)". The webclient's whole UI layer is
 *  HTML-string rendering — every `@recued/ui-shared` surface is a pure
 *  `renderX(props) -> string` + a companion `*_STYLES` constant, driven
 *  by a delegated `data-action` dispatcher. This module follows that
 *  established pattern: `renderReceptionPage` is the `renderConnectionsPage`
 *  shape, `mountReceptionPage` is the `mountServerPill` shape. It is the
 *  FIRST webclient↔`@recued/ui-shared` consumer — D-148 P11 deleted the
 *  old `apps/extension` / `apps/webapp` ui-shared consumers; the thin
 *  webclient PWA re-establishes the link here.
 *
 *  ── Two exports ───────────────────────────────────────────────────
 *    - **`renderReceptionPage(state, now?)`** — a PURE projection of
 *      `ReceptionPageShellState` to an HTML string. No I/O, no shell
 *      reference; every interactive element carries a `data-action` (and
 *      the `data-*` payload that action needs). The `now` arg only feeds
 *      the access-log relative timestamps — every other relative label
 *      was already baked by a satellite builder with the shell's clock.
 *    - **`mountReceptionPage(opts)`** — the `mountServerPill`-shape
 *      mount: it `subscribe()`s to the shell, re-renders the host on
 *      every state change, and installs a `createActionDispatcher` over
 *      the `data-action` markup. Returns an `update()` / `dispose()`
 *      handle.
 *
 *  ── View routing — what the shell's surface actually supports ──────
 *  `ReceptionPageShellState` has no current-view discriminator, and the
 *  shell exposes `closeDetail()` + `closeViewAsVisitor()` but NO clear
 *  method for `abuse_inbox` (it is set-only — `loadAbuseInbox`
 *  populates it, nothing clears).
 *  So the renderer routes faithfully to that surface:
 *    - `view_as_visitor` and `detail` are **drill-in routes** — each has
 *      a shell close method, so each fully replaces the list view with a
 *      back affordance wired to that method. `view_as_visitor` wins over
 *      `detail` (the detail-view "View as visitor" button leaves both
 *      non-null; the preview is the focused trust-check the user just
 *      asked for).
 *    - `abuse_inbox` is a set-only panel — NOT a drill-in route. (Both
 *      the inline Abuse and Templates panels later graduated OUT of the
 *      spine — Abuse to `#reception/abuse`, Templates to the standalone
 *      `mountTemplatesBrowser` modal — see the render body; this routing
 *      note covers the remaining drill-in vs. set-only shell surfaces.)
 *
 *  ── Native vs host-forwarded actions ──────────────────────────────
 *  `mountReceptionPage` drives every action the shell's surface can
 *  satisfy with a no-arg / id-only call (refresh, open-detail, enable,
 *  disable, preview-as-visitor, the closes, ban / unban, the subview
 *  loads). The rest forward to `opts.onUnhandledAction` because they
 *  need more than the renderer holds:
 *    - `rotate-token` / `create-from-preview` mint a one-shot
 *      `share_url_once` the HOST must capture + register via
 *      `shell.setEndpointShare` with kind-appropriate copy (the page
 *      shell's DD#7) — the mount cannot.
 *    - `new-endpoint` / `edit-page` / `use-template` / `launch-wizard`
 *      need the authoring forms / wizard chrome (composed dispatch
 *      payloads — those satellites are not part of `ReceptionPageShellState`).
 *    - `extend` needs a date the renderer cannot collect.
 *    - `revoke` / `emergency-disable-all` are irreversible / bulk —
 *      the host owns the confirm step.
 *
 *  ── XSS ───────────────────────────────────────────────────────────
 *  Every server- / user-supplied string flows through `e()` before
 *  interpolation. The View-As-Visitor `rendered_html` is anonymous-
 *  visitor markup (the spec's TR-8 custom-content-XSS surface) — it goes
 *  into a fully-locked `<iframe sandbox="" srcdoc=…>`, never the live
 *  DOM.
 *
 *  Spec: D-149 § A.9 (Settings UX) + § A.20.1-A.20.6. */

import { e, timeAgo } from '@recued/ui-shared/template';
import {
  actionBar,
  badge,
  button,
  dataTable,
  emptyHint,
  inlineHint,
  panel,
  statusDot,
  type BadgeTone,
  type StatusTone,
  type TableColumn,
} from '@recued/ui-shared/primitives';

import {
  RECEPTION_ERROR_COPY,
  RECEPTION_SAFETY_LABEL_TOOLTIP,
  isReceptionEndpointKindAvailable,
  type ReceptionAccessLogRow,
  type ReceptionEndpointDetailModel,
  type ReceptionEndpointRow,
  type ReceptionEndpointStatus,
  type ReceptionKindSection,
  type ReceptionPageModel,
} from './reception.js';
import {
  ABUSE_INBOX_ERROR_COPY,
  type AbuseInboxBlockedEntryModel,
  type AbuseInboxRowModel,
  type AbuseInboxSubviewModel,
} from './reception-abuse-inbox.js';
import type {
  ViewAsVisitorModel,
  ViewAsVisitorPanelModel,
} from './reception-view-as-visitor.js';
import { createActionDispatcher } from '@recued/ui-shared/action-dispatcher';
import { isReceptionPairableKind } from '@recued/contracts';
import type {
  ReceptionPageShell,
  ReceptionPageShellError,
  ReceptionPageShellState,
} from './reception-page-shell.js';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Hash-link affordance
// ════════════════════════════════════════════════════════════════

/** Attribute marker on the Reception status header's "Settings" link.
 *  The anchor renders as a plain `<a href="#settings">` so the
 *  bootstrap's hashchange listener picks the navigation up natively;
 *  this attribute exists so tests can locate the element without
 *  scraping `href` matches. Used by `d-148-settings-hash-link.test.ts`. */
export const RECEPTION_SETTINGS_LINK_ATTR = 'data-recued-settings-link';

/** D-151 P0 — attribute markers on the Compose entry points. The
 *  desktop top-band link and the mobile FAB both route to `#compose`;
 *  tests use these hooks instead of scraping link text. */
export const RECEPTION_COMPOSE_LINK_ATTR = 'data-recued-compose-link';
export const RECEPTION_COMPOSE_FAB_ATTR = 'data-recued-compose-fab';

/** D-169 P2 (N.9 "N awaiting you") — attribute marker on the count badge
 *  rendered INSIDE the Approvals nav link when there is at least one
 *  pending ask. The attribute's VALUE is the count, so a test (or a
 *  future introspection) reads presence + magnitude in one hit. The badge
 *  is absent at zero / not-yet-loaded — the link stays uncluttered when
 *  nothing is waiting on the user. Rendered by `renderApprovalsCountBadge`. */
export const RECEPTION_APPROVALS_COUNT_ATTR = 'data-recued-approvals-count';

// ════════════════════════════════════════════════════════════════
// Action surface
// ════════════════════════════════════════════════════════════════

/** Every `data-action` the renderer emits. The mount's dispatcher is
 *  typed against this union (tsc enforces a handler per action); the
 *  renderer's `button({ action })` call sites are gated by the same
 *  literal type. */
export const RECEPTION_PAGE_ACTIONS = [
  // ── Mount-native — driven straight off the shell with a no-arg /
  //    id-only call ────────────────────────────────────────────────
  'reception-refresh',
  'reception-open-detail',
  'reception-close-detail',
  'reception-enable',
  'reception-disable',
  'reception-preview-as-visitor',
  'reception-close-view-as-visitor',
  'reception-open-abuse-inbox',
  'reception-ban-ip',
  'reception-unban-ip',
  // ── Host-forwarded — need a one-shot-result capture, a composed
  //    dispatch payload, a date, or an irreversible-action confirm ──
  'reception-launch-wizard',
  'reception-new-endpoint',
  'reception-edit-page',
  'reception-pair-intake-recipe',
  'reception-extend',
  'reception-rotate-token',
  'reception-revoke',
  'reception-emergency-disable-all',
  // ── Host-forwarded — `reception-open-templates` opens the standalone
  //    templates-browser modal (the daily-use "+ New" entry point); the
  //    host lands `mountTemplatesBrowser` in its `modalHost`. ──────────
  'reception-open-templates',
] as const;

export type ReceptionPageAction = (typeof RECEPTION_PAGE_ACTIONS)[number];

/** The mount-native subset — the actions `mountReceptionPage` satisfies
 *  itself off the injected `shell`. Everything in `RECEPTION_PAGE_ACTIONS`
 *  not listed here forwards to `opts.onUnhandledAction`. Exported so a
 *  ratchet test can assert the split stays exhaustive. */
export const RECEPTION_PAGE_NATIVE_ACTIONS = [
  'reception-refresh',
  'reception-open-detail',
  'reception-close-detail',
  'reception-enable',
  'reception-disable',
  'reception-preview-as-visitor',
  'reception-close-view-as-visitor',
  'reception-open-abuse-inbox',
  'reception-ban-ip',
  'reception-unban-ip',
] as const satisfies ReadonlyArray<ReceptionPageAction>;

// ════════════════════════════════════════════════════════════════
// View routing
// ════════════════════════════════════════════════════════════════

/** Which top-level surface the renderer paints. `view_as_visitor` and
 *  `detail` are drill-in routes (the shell has a close method for each);
 *  `list` is the spine list view, which additionally renders the
 *  `abuse_inbox` / `templates` panels inline when loaded. `unloaded` is
 *  the pre-`loadPage()` prompt. */
export type ReceptionActiveView =
  | 'view_as_visitor'
  | 'detail'
  | 'list'
  | 'unloaded';

/** Resolve the active view from shell state. Precedence: a freshly-run
 *  preview (`view_as_visitor`) wins over an open `detail` — the
 *  detail-view "View as visitor" button leaves both non-null and the
 *  preview is the trust-check the user just asked for. Pure — no I/O. */
export const resolveReceptionActiveView = (
  state: ReceptionPageShellState,
): ReceptionActiveView => {
  if (state.view_as_visitor !== null) return 'view_as_visitor';
  if (state.detail !== null) return 'detail';
  if (state.page !== null) return 'list';
  return 'unloaded';
};

// ════════════════════════════════════════════════════════════════
// Small shared helpers
// ════════════════════════════════════════════════════════════════

/** Resolve a captured rpc-failure code to remediation copy. The shell's
 *  `last_error.code` is the `RpcError.code` of whichever `reception.*`
 *  rpc rejected — most resolve through the spine's `RECEPTION_ERROR_COPY`
 *  or the Abuse Inbox's `ABUSE_INBOX_ERROR_COPY` closed-list registries;
 *  a `'transport'` throw (or any code outside both) falls back to the
 *  rpc's raw message. Pure — no I/O. Exported so the R19 first-class Abuse
 *  section (`reception-abuse-section.ts`) resolves shell errors the same
 *  way the spine does (including the abuse-specific copy registry), rather
 *  than leaking the raw message. */
export const resolveReceptionErrorCopy = (
  err: ReceptionPageShellError,
): string => {
  const spine = (RECEPTION_ERROR_COPY as Record<string, string>)[err.code];
  if (spine !== undefined) return spine;
  const abuse = (ABUSE_INBOX_ERROR_COPY as Record<string, string>)[err.code];
  if (abuse !== undefined) return abuse;
  // Humanize the connection codes (server_offline / timeout / connection_lost /
  // …) so they don't leak the raw `webclient rpc: …` string; a real server
  // error keeps its own message.
  const classified = classifyRpcError(err);
  if (classified.connectionCaused) return classified.copy;
  return err.message;
};

/** Map an endpoint's lifecycle status to a `badge` tone. */
const statusBadgeTone = (status: ReceptionEndpointStatus): BadgeTone => {
  switch (status) {
    case 'active':
      return 'ok';
    case 'disabled':
      return 'idle';
    case 'expired':
    case 'revoked':
      return 'off';
  }
};

/** Human label for a lifecycle status — the badge text. */
const statusLabel = (status: ReceptionEndpointStatus): string => {
  switch (status) {
    case 'active':
      return 'Active';
    case 'disabled':
      return 'Disabled';
    case 'expired':
      return 'Expired';
    case 'revoked':
      return 'Revoked';
  }
};

/** `data-*` attribute string from a flat record — keys are emitted
 *  verbatim as `data-<key>` (callers pass already-kebab keys), values
 *  escaped. Empty / undefined values are dropped. */
const dataAttrs = (data: Readonly<Record<string, string | undefined>>): string =>
  Object.entries(data)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `data-${k}="${e(v)}"`)
    .join(' ');

/** Whether a string is a syntactically-valid `http(s)` URL — the gate
 *  for emitting it into an `href`. `e()` blocks attribute-breakout but
 *  does NOT neuter a `javascript:` / `data:` scheme (no HTML
 *  metacharacters to escape), so a value projected from server / operator
 *  state must have its scheme checked before it becomes a clickable
 *  link. Pure — no I/O. */
const isSafeHttpUrl = (url: string): boolean => {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

// ════════════════════════════════════════════════════════════════
// Status header
// ════════════════════════════════════════════════════════════════

/** D-169 P2 (N.9) — the "N awaiting you" count badge for the Approvals
 *  nav link. Returns `''` for a zero / not-yet-loaded count so the link
 *  renders exactly as it did pre-badge (the `>Approvals<` shape the
 *  hash-link test pins stays intact either way). The bare number is
 *  ambiguous to assistive tech on its own, so the `aria-label` + `title`
 *  voice the full N.9 phrasing; the link's own "Approvals" text plus this
 *  label compose into "Approvals, N awaiting you". `count` is a number so
 *  it is HTML-safe to interpolate directly; the label still flows through
 *  `e()` defensively + for uniformity with the rest of the renderer. */
const renderApprovalsCountBadge = (count: number): string => {
  if (count <= 0) return '';
  const label = `${count} awaiting you`;
  return `<span class="reception-nav-badge" ${RECEPTION_APPROVALS_COUNT_ATTR}="${count}" aria-label="${e(label)}" title="${e(label)}">${count}</span>`;
};

/** The top status band. Once the page is loaded the spine already
 *  projected the serving / exposure posture into `page.status_header` —
 *  render straight off it. Before load there is only the out-of-band
 *  `state.status` context (seeded from the exposure resolution): show
 *  its raw bits without inventing the spine's label-precedence rule.
 *
 *  `pendingAsksCount` decorates the Approvals nav link with the N.9 count
 *  badge — sourced (via the route's `resolvePendingAsksCount` seam) from
 *  the `notification.pending_asks` list length, kept live by the route's
 *  `notification.ask` / `notification.ask_closed` subscription. Zero ⇒ no
 *  badge. */
const renderStatusHeader = (
  state: ReceptionPageShellState,
  pendingAsksCount: number,
): string => {
  const header = state.page?.status_header;
  const serving = header
    ? header.serving
    : state.status.reception_public && !state.status.emergency_disabled;
  const label = header
    ? header.status_label
    : state.status.emergency_disabled
      ? 'Emergency disabled'
      : !state.status.reception_public
        ? 'Not publicly exposed'
        : 'Enabled';
  const baseUrl = header ? header.base_url : state.status.base_url;
  const counts = state.page
    ? `<span class="reception-status-counts">${state.page.active_endpoints} active · ${state.page.total_endpoints} total</span>`
    : '';
  // `base_url` is projected from server / operator exposure state — only
  // emit it into an `href` when it is a real http(s) URL. A malformed /
  // non-http(s) value (`javascript:` / `data:` / garbage) renders as
  // escaped plain text, never a clickable link.
  const baseUrlBlock = !baseUrl
    ? `<span class="reception-status-url reception-status-url--none">No public base URL — configure exposure + a TLS domain first.</span>`
    : isSafeHttpUrl(baseUrl)
      ? `<a class="reception-status-url" href="${e(baseUrl)}" target="_blank" rel="noopener noreferrer">${e(baseUrl)}</a>`
      : `<span class="reception-status-url reception-status-url--none">${e(baseUrl)}</span>`;
  // Plain `<a href="#...">` nav links (Compose + Approvals + Settings) — rely on
  // the bootstrap's hashchange listener (`parseRouteFromHash` in
  // `webclient-bootstrap.ts`) to tear down Reception + mount the target
  // route. A plain anchor (vs a `data-action` button) preserves native
  // browser affordances: middle-click → new tab, right-click → copy
  // link, screen reader → "link" role. Hash routing is the existing wire
  // format; these are purely discovery affordances on top of it.
  // D-151 P0 — Compose is the daily-use creation entry. The desktop
  // `+ New` link is part of this top band; the duplicate `+` anchor below
  // becomes the full-width mobile creation action.
  // D-169 P2 — the Approvals link surfaces the top-level `#approvals`
  // route (the D-158 ask inbox); it sits before Settings as the more
  // actionable "what's waiting on me" entry. N.9 — a count badge
  // ("N awaiting you") rides inside the link when `pendingAsksCount > 0`.
  return `
    <header class="reception-status-header">
      <div class="reception-status-line">
        ${statusDot(serving ? 'ok' : 'off')}
        <h2 class="reception-status-title">Reception</h2>
        ${badge({ label, tone: serving ? 'ok' : 'off' })}
        ${counts}
        <span class="reception-status-spacer"></span>
        <a class="reception-status-nav-link reception-compose-link" ${RECEPTION_COMPOSE_LINK_ATTR} data-action="reception-open-templates" href="#" role="button">+ New</a>
        <a class="reception-status-nav-link" data-recued-approvals-link href="#approvals">Approvals${renderApprovalsCountBadge(pendingAsksCount)}</a>
        <a class="reception-status-nav-link" data-recued-settings-link href="#settings">Settings</a>
        ${button({
          label: 'Refresh',
          size: 'xs',
          action: 'reception-refresh',
        })}
        ${button({
          label: 'Emergency disable all',
          size: 'xs',
          variant: 'danger-text',
          action: 'reception-emergency-disable-all',
        })}
      </div>
      ${baseUrlBlock}
      <a class="reception-compose-fab" ${RECEPTION_COMPOSE_FAB_ATTR} data-action="reception-open-templates" href="#" role="button" aria-label="New endpoint" title="New endpoint">+</a>
    </header>
  `;
};

// ════════════════════════════════════════════════════════════════
// Endpoint row + kind section (the spine list view)
// ════════════════════════════════════════════════════════════════

/** § A.20.6 safety-label chips — emoji + text from the contract, the
 *  longer "why it matters" copy as the hover title. */
const renderSafetyLabels = (row: ReceptionEndpointRow): string => {
  if (row.safety_labels.length === 0) return '';
  return `
    <div class="reception-safety-labels">
      ${row.safety_labels
        .map(
          (lbl) =>
            `<span class="reception-safety-label" title="${e(RECEPTION_SAFETY_LABEL_TOOLTIP[lbl.kind])}">${e(lbl.emoji)} ${e(lbl.text)}</span>`,
        )
        .join('')}
    </div>
  `;
};

/** Tooltip rendered on the disabled Edit-page button while the route's
 *  page-config cache has not yet completed its first `reception.page.get`
 *  round-trip. The cache-gated window is normally sub-second; if the
 *  retry path exhausts and the user is still seeing this, the route
 *  has not yet succeeded on a subsequent shell-driven reload. */
const EDIT_PAGE_GATED_TOOLTIP = 'Loading reception page settings…';

/** The lifecycle action buttons for one row — gated by status +
 *  singleton-ness. The `reception_page` singleton is token-less + has no
 *  expiry / revocation (see the spine's `is_singleton` doc), so it shows
 *  "Edit page" + "Detail" only. `revoked` is terminal for endpoint
 *  lifecycle actions; an intake form still exposes "Checkout recipe" so an
 *  owner can inspect or clear its separately durable pair.
 *
 *  When `editPageGated` is true, the singleton's "Edit page" button is
 *  rendered in a disabled state — the route's page-config cache has
 *  not loaded yet, so opening the authoring form would seed defaults
 *  + a submit would silently overwrite the existing singleton. See
 *  `mountReceptionRoute` DD#2. */
const renderRowActions = (
  row: ReceptionEndpointRow,
  editPageGated: boolean,
): string => {
  const data = { 'endpoint-id': row.endpoint_id };
  const detailBtn = button({
    label: 'Detail',
    size: 'xs',
    action: 'reception-open-detail',
    data,
  });
  if (row.is_singleton) {
    return actionBar({
      gap: 4,
      children: [
        button({
          label: 'Edit page',
          size: 'xs',
          action: 'reception-edit-page',
          data,
          ...(editPageGated ? { disabled: true, title: EDIT_PAGE_GATED_TOOLTIP } : {}),
        }),
        detailBtn,
      ],
    });
  }
  const children: string[] = [];
  const visitorShareAvailable = isReceptionEndpointKindAvailable(row.kind);
  if (row.status === 'active') {
    children.push(button({ label: 'Disable', size: 'xs', action: 'reception-disable', data }));
    if (visitorShareAvailable) {
      children.push(
        button({
          label: 'View as visitor',
          size: 'xs',
          action: 'reception-preview-as-visitor',
          data,
        }),
        button({ label: 'Rotate token', size: 'xs', action: 'reception-rotate-token', data }),
      );
    }
    children.push(
      button({ label: 'Extend', size: 'xs', action: 'reception-extend', data }),
    );
  } else if (row.status === 'disabled') {
    children.push(
      button({ label: 'Enable', size: 'xs', variant: 'primary', action: 'reception-enable', data }),
    );
  } else if (row.status === 'expired') {
    children.push(
      button({ label: 'Extend', size: 'xs', variant: 'primary', action: 'reception-extend', data }),
    );
  }
  // D-210 R-2 slice 4 — offered for every kind that has something to RUN the pair, derived
  // from the same `RECEPTION_PAIR_CONSUMER` the rpc gate refuses on. A hand-kept list here
  // would eventually offer a button that 409s, or hide one that works.
  //
  // The label was 'Checkout recipe' — D-200's vocabulary, and already stale for intake since
  // D-207 3d·6d split the general pair out of the payment module: any statically-analyzable
  // recipe may be paired (lead capture, triage, booking), and most pair nothing to buy.
  if (isReceptionPairableKind(row.kind)) {
    children.push(
      button({
        label: 'Recipe',
        size: 'xs',
        action: 'reception-pair-intake-recipe',
        data,
      }),
    );
  }
  children.push(detailBtn);
  if (row.status !== 'revoked') {
    children.push(
      button({ label: 'Revoke', size: 'xs', variant: 'danger-text', action: 'reception-revoke', data }),
    );
  }
  return actionBar({ gap: 4, children });
};

/** One endpoint row in a kind section. */
const renderEndpointRow = (
  row: ReceptionEndpointRow,
  now: number,
  editPageGated: boolean,
): string => {
  const name = row.is_singleton ? 'Reception page' : row.endpoint_id;
  const lastAccessed =
    row.last_accessed_at !== null
      ? `Last access ${e(timeAgo(row.last_accessed_at, now))}`
      : 'No access yet';
  const revocation =
    row.status === 'revoked' && row.revocation_reason
      ? `<span class="reception-row-revocation">Revoked: ${e(row.revocation_reason)}</span>`
      : '';
  return `
    <div class="reception-row" ${dataAttrs({ 'endpoint-id': row.endpoint_id })}>
      <div class="reception-row-head">
        <span class="reception-row-name">${e(name)}</span>
        ${badge({ label: statusLabel(row.status), tone: statusBadgeTone(row.status) })}
        <span class="reception-row-meta">${e(row.expiry_label)}</span>
        <span class="reception-row-meta">${row.audit_count} ${row.audit_count === 1 ? 'access' : 'accesses'}</span>
        <span class="reception-row-meta">${e(lastAccessed)}</span>
      </div>
      ${renderSafetyLabels(row)}
      ${revocation}
      ${renderRowActions(row, editPageGated)}
    </div>
  `;
};

/** One per-kind list section. The `reception_page` create button (which
 *  shares the `reception-edit-page` action when `can_create` + no
 *  singleton row exists yet) is disabled while `editPageGated` is true,
 *  same gate the singleton row's "Edit page" button uses. */
const renderKindSection = (
  section: ReceptionKindSection,
  now: number,
  editPageGated: boolean,
): string => {
  const rows =
    section.rows.length > 0
      ? section.rows.map((r) => renderEndpointRow(r, now, editPageGated)).join('')
      : emptyHint({ message: `No ${section.singular} endpoints yet.` });
  const isSingletonCreate = section.kind === 'reception_page';
  const createBtn = section.can_create
    ? button({
        label: section.create_label,
        size: 'sm',
        variant: 'primary',
        action: isSingletonCreate ? 'reception-edit-page' : 'reception-new-endpoint',
        data: { kind: section.kind },
        ...(isSingletonCreate && editPageGated
          ? { disabled: true, title: EDIT_PAGE_GATED_TOOLTIP }
          : {}),
      })
    : '';
  return `
    <section class="reception-section" ${dataAttrs({ kind: section.kind })}>
      <div class="reception-section-head">
        <h3 class="reception-section-title">${e(section.section_label)}</h3>
        ${createBtn}
      </div>
      <p class="reception-section-desc">${e(section.description)}</p>
      <div class="reception-section-rows">${rows}</div>
    </section>
  `;
};

/** The § A.20.1 first-run CTA — surfaced when no endpoint is enabled. */
const renderFirstRunCta = (): string =>
  panel({
    tone: 'info',
    title: 'Set up Reception',
    body: `
      <p class="reception-cta-body">
        Reception is your public front door — anonymous visitors can submit forms,
        drop files, or check managed links without a Recued account. The Launch
        Wizard walks you through a Reception page and intake form in under ten minutes.
      </p>
      ${button({
        label: 'Start the Launch Wizard',
        variant: 'primary',
        size: 'sm',
        action: 'reception-launch-wizard',
      })}
    `,
  });

// ════════════════════════════════════════════════════════════════
// Abuse Inbox panel (inline within the list view)
// ════════════════════════════════════════════════════════════════

const renderAbuseInboxRow = (row: AbuseInboxRowModel): string => {
  const data = { 'endpoint-id': row.endpoint_id, 'source-ip-hash': row.source_ip_hash };
  const banBtn = row.ip_blocked
    ? button({ label: 'Unban IP', size: 'xs', action: 'reception-unban-ip', data })
    : button({ label: 'Ban IP', size: 'xs', variant: 'danger-text', action: 'reception-ban-ip', data });
  const detailBtn = button({
    label: 'Investigate',
    size: 'xs',
    action: 'reception-open-detail',
    data: { 'endpoint-id': row.endpoint_id },
  });
  return `
    <div class="reception-abuse-row">
      <div class="reception-abuse-row-head">
        <span class="reception-abuse-signal">${e(row.signal_label)}</span>
        ${row.ip_blocked ? badge({ label: 'Banned', tone: 'off' }) : ''}
        <span class="reception-row-meta">${row.event_count} ${row.event_count === 1 ? 'event' : 'events'}</span>
        <span class="reception-row-meta">first ${e(row.first_seen_label)}</span>
        <span class="reception-row-meta">last ${e(row.last_seen_label)}</span>
      </div>
      <p class="reception-abuse-desc">${e(row.signal_description)}</p>
      <p class="reception-abuse-detail">
        Endpoint <code class="reception-mono">${e(row.endpoint_id)}</code>
        · source <code class="reception-mono">${e(row.source_ip_hash_prefix)}…</code>
      </p>
      <p class="reception-abuse-suggest">${e(row.suggested_action)}</p>
      ${actionBar({ gap: 4, children: [detailBtn, banBtn] })}
    </div>
  `;
};

const renderAbuseInboxBlockedEntry = (entry: AbuseInboxBlockedEntryModel): string => {
  const data = { 'endpoint-id': entry.endpoint_id, 'source-ip-hash': entry.source_ip_hash };
  return `
    <div class="reception-abuse-blocked-row">
      <span class="reception-row-meta">
        <code class="reception-mono">${e(entry.source_ip_hash_prefix)}…</code>
        on <code class="reception-mono">${e(entry.endpoint_id)}</code>
        · banned ${e(entry.blocked_at_label)}
        ${entry.reason ? `· ${e(entry.reason)}` : ''}
      </span>
      ${button({ label: 'Unban IP', size: 'xs', action: 'reception-unban-ip', data })}
    </div>
  `;
};

/** Render the Abuse Inbox panel from its subview model. Exported so the
 *  R19 first-class Abuse section (`reception-abuse-section.ts`) reuses the
 *  exact rendering (signal-cluster rows + the banned-IP block list +
 *  Refresh) the spine grew it as; the abuse section drives the same
 *  `reception-{open-abuse-inbox,ban-ip,unban-ip,open-detail}` actions
 *  through its own dispatcher. */
export const renderAbuseInboxPanel = (inbox: AbuseInboxSubviewModel): string => {
  const body = inbox.header.is_empty
    ? emptyHint({ message: `No abuse signals in ${inbox.header.window_label.toLowerCase()}.` })
    : inbox.rows.map(renderAbuseInboxRow).join('');
  const blocked =
    inbox.blocked_entries.length > 0
      ? `
        <div class="reception-abuse-blocked">
          <h4 class="reception-subhead">Currently banned (${inbox.header.blocked_count})</h4>
          ${inbox.blocked_entries.map(renderAbuseInboxBlockedEntry).join('')}
        </div>
      `
      : '';
  return panel({
    title: 'Abuse Inbox',
    body: `
      <div class="reception-abuse-head">
        <span class="reception-row-meta">${e(inbox.header.window_label)} · ${inbox.header.total_signals} ${inbox.header.total_signals === 1 ? 'cluster' : 'clusters'}</span>
        ${button({ label: 'Refresh', size: 'xs', action: 'reception-open-abuse-inbox' })}
      </div>
      <p class="reception-abuse-threshold">${e(inbox.header.threshold_explanation)}</p>
      <div class="reception-abuse-rows">${body}</div>
      ${blocked}
    `,
  });
};

// ════════════════════════════════════════════════════════════════
// Spine list view
// ════════════════════════════════════════════════════════════════

const renderListView = (
  page: ReceptionPageModel,
  _state: ReceptionPageShellState,
  now: number,
  editPageGated: boolean,
): string => {
  // R19 — the spine is the ENDPOINTS section only: first-run CTA + the
  // per-kind endpoint sections. The Abuse Inbox graduated to its own
  // first-class `#reception/abuse` section (`reception-abuse-section.ts`),
  // and the inline intake-form Templates panel was retired (the live
  // "+ New" templates gallery is the modal `mountTemplatesBrowser`), so
  // both left the spine.
  const firstRun = page.is_first_run ? renderFirstRunCta() : '';
  const sections = page.sections.map((s) => renderKindSection(s, now, editPageGated)).join('');
  return `
    ${firstRun}
    <div class="reception-sections">${sections}</div>
  `;
};

// ════════════════════════════════════════════════════════════════
// Per-endpoint detail view (drill-in route)
// ════════════════════════════════════════════════════════════════

const ACCESS_LOG_COLUMNS: ReadonlyArray<TableColumn<ReceptionAccessLogRow & { _now: number }>> = [
  { header: 'When', cell: (r) => timeAgo(r.accessed_at, r._now) },
  {
    header: 'Source',
    cell: (r) => (r.source_ip_hash_prefix === '' ? '—' : `${r.source_ip_hash_prefix}…`),
    cellClass: 'reception-mono',
  },
  { header: 'Action', cell: (r) => r.action_label },
  { header: 'Outcome', cell: (r) => r.outcome_label },
  {
    header: 'Path',
    cell: (r) => r.url_path_redacted ?? '—',
    cellClass: 'reception-mono',
  },
];

const renderShareCards = (detail: ReceptionEndpointDetailModel): string => {
  if (!isReceptionEndpointKindAvailable(detail.row.kind)) {
    return panel({
      tone: 'neutral',
      compact: true,
      body: inlineHint(
        'Share and visitor-preview actions for this endpoint kind are not yet available. Existing endpoints remain manageable here.',
      ),
    });
  }
  if (!detail.share_url_available) {
    // The rotate CTA only makes sense for a link-style endpoint that
    // still has a live token. The `reception_page` singleton is
    // tokenless by contract (see the spine's `is_singleton` doc) and a
    // revoked endpoint cannot be rotated (`endpoint_already_revoked`) —
    // for those, surface the hint without the dead-end CTA, consistent
    // with how `renderRowActions` + the detail action bar already gate
    // rotate.
    const canRotate =
      !detail.row.is_singleton && detail.row.status !== 'revoked';
    return panel({
      tone: 'neutral',
      compact: true,
      body: canRotate
        ? `
        ${inlineHint('The share URL is shown once at create / rotate and never again. Rotate the token to mint a fresh one.')}
        ${button({
          label: 'Rotate token',
          size: 'xs',
          action: 'reception-rotate-token',
          data: { 'endpoint-id': detail.row.endpoint_id },
        })}
      `
        : inlineHint(
            detail.row.is_singleton
              ? 'The Reception page is your tokenless public front door — there is no share secret to rotate.'
              : 'This endpoint is revoked — its token cannot be rotated. Create a fresh endpoint instead.',
          ),
    });
  }
  return `
    <div class="reception-share-cards">
      ${detail.share_cards
        .map(
          (card) => `
        <div class="reception-share-card">
          <span class="reception-share-channel">${e(card.channel)}</span>
          <pre class="reception-share-snippet">${e(card.snippet)}</pre>
        </div>
      `,
        )
        .join('')}
    </div>
  `;
};

const renderDetailView = (detail: ReceptionEndpointDetailModel, now: number): string => {
  const row = detail.row;
  const pkt = detail.packet_declaration;
  const visitorShareAvailable = isReceptionEndpointKindAvailable(row.kind);
  const fieldsVisible =
    pkt.fields_visible_override !== undefined
      ? pkt.fields_visible_override.map((f) => e(f)).join(', ')
      : 'packet-kind default';
  const accessRows = detail.access_log_rows.map((r) => ({ ...r, _now: now }));
  const accessTable =
    accessRows.length > 0
      ? dataTable({
          columns: ACCESS_LOG_COLUMNS as TableColumn<ReceptionAccessLogRow & { _now: number }>[],
          rows: accessRows,
          extraClass: 'reception-access-log',
        })
      : emptyHint({ message: 'No access-log entries for this endpoint yet.' });
  return `
    <div class="reception-detail">
      <div class="reception-detail-head">
        ${button({ label: '← Back to Reception', size: 'xs', action: 'reception-close-detail' })}
        <span class="reception-detail-title">${e(row.is_singleton ? 'Reception page' : row.endpoint_id)}</span>
        ${badge({ label: statusLabel(row.status), tone: statusBadgeTone(row.status) })}
      </div>
      ${renderSafetyLabels(row)}
      <div class="reception-detail-meta">
        <span class="reception-row-meta">${e(row.expiry_label)}</span>
        <span class="reception-row-meta">Created ${e(timeAgo(row.created_at, now))}</span>
        <span class="reception-row-meta">${row.audit_count} ${row.audit_count === 1 ? 'access' : 'accesses'}</span>
        <span class="reception-row-meta">${detail.distinct_source_ip_count} distinct ${detail.distinct_source_ip_count === 1 ? 'source IP' : 'source IPs'}</span>
      </div>
      ${
        !row.is_singleton
          ? actionBar({
              gap: 4,
              bordered: true,
              children:
                row.status === 'active'
                  ? [
                      button({ label: 'Disable', size: 'xs', action: 'reception-disable', data: { 'endpoint-id': row.endpoint_id } }),
                      ...(visitorShareAvailable
                        ? [
                            button({ label: 'View as visitor', size: 'xs', action: 'reception-preview-as-visitor', data: { 'endpoint-id': row.endpoint_id } }),
                            button({ label: 'Rotate token', size: 'xs', action: 'reception-rotate-token', data: { 'endpoint-id': row.endpoint_id } }),
                          ]
                        : []),
                      button({ label: 'Extend', size: 'xs', action: 'reception-extend', data: { 'endpoint-id': row.endpoint_id } }),
                      button({ label: 'Revoke', size: 'xs', variant: 'danger-text', action: 'reception-revoke', data: { 'endpoint-id': row.endpoint_id } }),
                    ]
                  : row.status === 'disabled'
                    ? [
                        button({ label: 'Enable', size: 'xs', variant: 'primary', action: 'reception-enable', data: { 'endpoint-id': row.endpoint_id } }),
                        button({ label: 'Revoke', size: 'xs', variant: 'danger-text', action: 'reception-revoke', data: { 'endpoint-id': row.endpoint_id } }),
                      ]
                    : row.status === 'expired'
                      ? [
                          button({ label: 'Extend', size: 'xs', variant: 'primary', action: 'reception-extend', data: { 'endpoint-id': row.endpoint_id } }),
                          button({ label: 'Revoke', size: 'xs', variant: 'danger-text', action: 'reception-revoke', data: { 'endpoint-id': row.endpoint_id } }),
                        ]
                      : [],
            })
          : ''
      }
      <div class="reception-detail-section">
        <h4 class="reception-subhead">Packet declaration</h4>
        <p class="reception-row-meta">
          Packet kind <code class="reception-mono">${e(pkt.packet_kind)}</code>
          · source <code class="reception-mono">${e(pkt.source_query_ref.kind)}</code>
        </p>
        <p class="reception-row-meta">Visible fields: ${fieldsVisible}</p>
      </div>
      <div class="reception-detail-section">
        <h4 class="reception-subhead">Share cards</h4>
        ${renderShareCards(detail)}
      </div>
      <div class="reception-detail-section">
        <h4 class="reception-subhead">Access log</h4>
        ${accessTable}
      </div>
    </div>
  `;
};

// ════════════════════════════════════════════════════════════════
// View-As-Visitor view (drill-in route)
// ════════════════════════════════════════════════════════════════

const renderViewAsVisitorPanel = (panelModel: ViewAsVisitorPanelModel): string => {
  const visible = panelModel.visible_field_rows
    .map(
      (f) =>
        `<li class="reception-vav-field reception-vav-field--visible"><code class="reception-mono">${e(f.field)}</code> — ${e(f.rationale)}</li>`,
    )
    .join('');
  const stripped = panelModel.stripped_field_rows
    .map(
      (f) =>
        `<li class="reception-vav-field reception-vav-field--stripped"><code class="reception-mono">${e(f.field)}</code> — ${e(f.rationale)}</li>`,
    )
    .join('');
  const invariants = panelModel.invariant_summary.rows
    .map(
      (inv) =>
        `<li class="reception-vav-invariant reception-vav-invariant--${inv.satisfied ? 'ok' : 'flagged'}">${inv.satisfied ? '✓' : '⚠'} <strong>${e(inv.invariant)}</strong> — ${e(inv.detail)}</li>`,
    )
    .join('');
  return `
    <div class="reception-vav-panel">
      <div class="reception-vav-fieldsplit">
        <div>
          <h4 class="reception-subhead">Visitor sees (${panelModel.visible_field_count})</h4>
          <ul class="reception-vav-fieldlist">${visible}</ul>
        </div>
        <div>
          <h4 class="reception-subhead">Stripped at the boundary (${panelModel.stripped_field_count})</h4>
          <ul class="reception-vav-fieldlist">${stripped}</ul>
        </div>
      </div>
      <div class="reception-vav-posture">
        <p class="reception-row-meta"><strong>Expiry:</strong> ${e(panelModel.expiry_policy.expires_at_label)} — default ${e(panelModel.expiry_policy.default_label)}, ceiling ${e(panelModel.expiry_policy.max_label)}.</p>
        <p class="reception-row-meta"><strong>Token:</strong> ${e(panelModel.token_mode_label)} — ${e(panelModel.token_mode_description)}</p>
        <p class="reception-row-meta"><strong>Audit:</strong> ${e(panelModel.audit_mode_label)} — ${e(panelModel.audit_mode_description)}</p>
      </div>
      <div class="reception-vav-invariants">
        <h4 class="reception-subhead">${e(panelModel.invariant_summary.compliance_label)}</h4>
        <ul class="reception-vav-invariantlist">${invariants}</ul>
      </div>
    </div>
  `;
};

const renderViewAsVisitorView = (vav: ViewAsVisitorModel): string => {
  // The server-rendered visitor page is anonymous-visitor markup (the
  // spec's TR-8 custom-content-XSS surface) — it goes into a fully
  // locked iframe (`sandbox=""` ⇒ no scripts, no same-origin, no
  // forms), never the live DOM. `e()` escapes it for the `srcdoc`
  // attribute.
  const freshnessTone = vav.preview_is_fresh ? 'info' : 'warn';
  return `
    <div class="reception-vav">
      <div class="reception-vav-head">
        ${button({
          label: '← Back to Reception',
          size: 'xs',
          action: 'reception-close-view-as-visitor',
        })}
        <span class="reception-vav-title">View as visitor</span>
        <span class="reception-vav-synthetic">synthetic preview — no access-log entry</span>
      </div>
      ${panel({
        tone: freshnessTone,
        compact: true,
        body: `<p class="reception-row-meta">${e(vav.preview_freshness_label)}</p>`,
      })}
      <div class="reception-vav-preview">
        <h4 class="reception-subhead">Server-rendered visitor page</h4>
        <iframe
          class="reception-vav-frame"
          sandbox=""
          title="Reception visitor preview"
          srcdoc="${e(vav.rendered_html)}"
        ></iframe>
      </div>
      ${
        vav.panel !== null
          ? renderViewAsVisitorPanel(vav.panel)
          : inlineHint('This preview did not carry a field-visibility panel — re-run it against an up-to-date server.')
      }
    </div>
  `;
};

// ════════════════════════════════════════════════════════════════
// Top-level renderer
// ════════════════════════════════════════════════════════════════

/** Render options for `renderReceptionPage`. */
export interface RenderReceptionPageOptions {
  /** When true, the singleton's "Edit page" button + the section's
   *  `reception_page` create button are rendered disabled with a tooltip
   *  — the route's page-config cache has not yet completed its first
   *  `reception.page.get` round-trip, and opening the authoring form
   *  would risk overwriting the existing singleton with default values.
   *  Defaults to false (no gating). See `ReceptionPageHostOptions.gateEditPage`
   *  + `mountReceptionRoute` DD#2. */
  editPageGated?: boolean;
  /** D-169 P2 (N.9) — number of open D-158 asks awaiting the user. When
   *  `> 0`, the Approvals nav link in the status header carries a count
   *  badge ("N awaiting you"). Defaults to `0` (no badge). The route layer
   *  feeds it from the `notification.pending_asks` list length via
   *  `mountReceptionPage`'s `resolvePendingAsksCount` seam; a non-route
   *  render (a unit test, or a future caller that doesn't track asks)
   *  simply omits it. */
  pendingAsksCount?: number;
}

/** Render the whole Reception Settings page from shell state. Pure — no
 *  I/O, no shell reference. `now` feeds only the access-log relative
 *  timestamps (every other relative label was baked by a satellite
 *  builder with the shell's clock); it defaults to `Date.now()`. */
export const renderReceptionPage = (
  state: ReceptionPageShellState,
  now: number = Date.now(),
  opts: RenderReceptionPageOptions = {},
): string => {
  const view = resolveReceptionActiveView(state);
  const editPageGated = opts.editPageGated ?? false;
  const pendingAsksCount = opts.pendingAsksCount ?? 0;
  const loading = state.loading
    ? '<div class="reception-loading-bar" role="status" aria-label="Working…"></div>'
    : '';
  const error = state.last_error
    ? panel({
        tone: 'danger',
        title: 'Reception action failed',
        role: 'alert',
        body: `<p class="reception-error-copy">${e(resolveReceptionErrorCopy(state.last_error))}</p>
               <p class="reception-error-code">Code: <code class="reception-mono">${e(state.last_error.code)}</code></p>`,
      })
    : '';

  let body: string;
  if (view === 'view_as_visitor' && state.view_as_visitor !== null) {
    body = renderViewAsVisitorView(state.view_as_visitor);
  } else if (view === 'detail' && state.detail !== null) {
    body = renderDetailView(state.detail, now);
  } else if (view === 'list' && state.page !== null) {
    body = renderListView(state.page, state, now, editPageGated);
  } else {
    body = panel({
      tone: 'info',
      title: 'Reception',
      body: `
        <p class="reception-cta-body">
          Load the Reception page to manage your public-facing endpoints.
        </p>
        ${button({
          label: 'Load Reception',
          variant: 'primary',
          size: 'sm',
          action: 'reception-refresh',
        })}
      `,
    });
  }

  return `
    <div class="reception-page" ${dataAttrs({ view })}>
      ${loading}
      ${renderStatusHeader(state, pendingAsksCount)}
      ${error}
      <div class="reception-body">${body}</div>
    </div>
  `;
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

/** Options for `mountReceptionPage`. */
export interface ReceptionPageViewOptions {
  /** Host element the page is rendered into. Replaced on every state
   *  change; cleared on `dispose()`. */
  host: HTMLElement;
  /** The page shell — the mount subscribes to it + drives the
   *  mount-native actions off it (`RECEPTION_PAGE_NATIVE_ACTIONS`). */
  shell: ReceptionPageShell;
  /** Handler for the host-forwarded actions — `rotate-token` /
   *  `create-from-preview`'s one-shot results, the authoring / wizard
   *  composed payloads, `extend`'s date, the `revoke` /
   *  `emergency-disable-all` confirm. Receives the action name + the
   *  matched element's `dataset`. Optional — absent ⇒ those actions are
   *  no-ops (the renderer still draws their buttons). */
  onUnhandledAction?: (action: ReceptionPageAction, dataset: DOMStringMap) => void;
  /** Returns true when the consumer's page-config cache has NOT yet
   *  loaded (or has been invalidated) — the renderer disables the
   *  singleton's "Edit page" button + the section's `reception_page`
   *  create button. Called on every render. Defaults to `() => false`
   *  (no gating). Closes the `mountReceptionRoute` DD#2 residual
   *  hard-failure overwrite path: with this seam wired the Edit
   *  button cannot be clicked while the cache is empty, so a
   *  fresh-install-style submit can't blank-overwrite the singleton. */
  gateEditPage?: () => boolean;
  /** D-169 P2 (N.9) — resolve the current count of open D-158 asks
   *  awaiting the user (`notification.pending_asks` list length). Called
   *  on every render; `> 0` decorates the Approvals nav link with the
   *  "N awaiting you" count badge. Defaults to `() => 0` (no badge). The
   *  route layer (`mountReceptionRoute`) backs it with a value it keeps
   *  fresh off the `notification.ask` / `notification.ask_closed` bus —
   *  same shape as `gateEditPage` (a `() => T` seam re-read each render,
   *  the owning layer forcing a redraw when the value moves). */
  resolvePendingAsksCount?: () => number;
  /** R19 Slice 4 — routed endpoint detail. When wired, the
   *  `reception-open-detail` / `reception-close-detail` actions NAVIGATE to /
   *  from the endpoint-detail deep link (`#reception/endpoints/<id>` ↔
   *  `#reception/endpoints`) instead of driving the in-place
   *  `shell.openDetail` / `shell.closeDetail`, so the detail view is a
   *  durable, shareable URL — the abuse "Investigate" target, surviving
   *  refresh + back/forward. The re-mounted spine reconciles the detail open
   *  from the URL (`mountReceptionRoute`'s `initialDetailId`). Absent ⇒ the
   *  in-place shell calls (the pre-R19 path + the non-routed compositions /
   *  their tests). */
  onEnterDetail?: (endpointId: string) => void;
  onExitDetail?: () => void;
  /** Clock seam for the access-log relative timestamps — defaults to
   *  `Date.now`. */
  now?: () => number;
}

/** Mounted-view handle. */
export interface ReceptionPageView {
  /** Re-render from the current shell state. Called automatically on
   *  every shell state change; exposed for an explicit redraw. */
  update(): void;
  /** Unsubscribe from the shell, detach the action dispatcher, clear
   *  the host. Idempotent. */
  dispose(): void;
}

/** Mount the Reception page into a host element — the `mountServerPill`
 *  shape. Subscribes to the shell, re-renders on every state change, and
 *  installs a delegated `data-action` dispatcher: the mount-native
 *  actions drive the shell directly, the rest forward to
 *  `opts.onUnhandledAction`.
 *
 *  Shell action methods return promises that reject on rpc failure (the
 *  shell ALSO captures the failure into `last_error`, which the
 *  subscribe-driven re-render surfaces) — the native handlers `.catch()`
 *  the rejection so it never escapes as an unhandled rejection. */
export const mountReceptionPage = (
  opts: ReceptionPageViewOptions,
): ReceptionPageView => {
  const now = opts.now ?? (() => Date.now());
  const gateEditPage = opts.gateEditPage ?? ((): boolean => false);
  const resolvePendingAsksCount =
    opts.resolvePendingAsksCount ?? ((): number => 0);
  const { host, shell } = opts;
  let disposed = false;
  let lastHtml = '';

  const render = (): void => {
    if (disposed) return;
    const html = renderReceptionPage(shell.getState(), now(), {
      editPageGated: gateEditPage(),
      pendingAsksCount: resolvePendingAsksCount(),
    });
    if (html === lastHtml) return;
    host.innerHTML = html;
    lastHtml = html;
  };

  // The native handlers fire-and-forget against the shell — the shell
  // already routes rpc failures into `last_error` + the subscription
  // re-renders, so `.catch()` only swallows the rejection.
  const swallow = (p: Promise<unknown>): void => {
    void p.catch(() => {});
  };
  const forward = (action: ReceptionPageAction) => (dataset: DOMStringMap): void => {
    opts.onUnhandledAction?.(action, dataset);
  };

  const handlers = {
    'reception-refresh': () => swallow(shell.loadPage()),
    'reception-open-detail': (d: DOMStringMap) => {
      if (!d.endpointId) return;
      // R19 Slice 4 — routed detail: navigate to the deep link (a durable,
      // shareable URL); the re-mounted spine reconciles the detail open from
      // it. Falls back to the in-place open when no navigator is wired.
      if (opts.onEnterDetail !== undefined) {
        opts.onEnterDetail(d.endpointId);
        return;
      }
      swallow(shell.openDetail(d.endpointId));
    },
    'reception-close-detail': () => {
      // R19 Slice 4 — routed detail: navigate back to the endpoints list.
      // Falls back to the in-place close when no navigator is wired.
      if (opts.onExitDetail !== undefined) {
        opts.onExitDetail();
        return;
      }
      shell.closeDetail();
    },
    'reception-enable': (d: DOMStringMap) => {
      if (d.endpointId) swallow(shell.enableEndpoint(d.endpointId));
    },
    'reception-disable': (d: DOMStringMap) => {
      if (d.endpointId) swallow(shell.disableEndpoint(d.endpointId));
    },
    'reception-preview-as-visitor': (d: DOMStringMap) => {
      if (d.endpointId) swallow(shell.previewEndpointAsVisitor(d.endpointId));
    },
    'reception-close-view-as-visitor': () => shell.closeViewAsVisitor(),
    'reception-open-abuse-inbox': () => swallow(shell.loadAbuseInbox()),
    'reception-ban-ip': (d: DOMStringMap) => {
      if (d.endpointId && d.sourceIpHash) swallow(shell.banIp(d.endpointId, d.sourceIpHash));
    },
    'reception-unban-ip': (d: DOMStringMap) => {
      if (d.endpointId && d.sourceIpHash) swallow(shell.unbanIp(d.endpointId, d.sourceIpHash));
    },
    'reception-launch-wizard': forward('reception-launch-wizard'),
    'reception-new-endpoint': forward('reception-new-endpoint'),
    'reception-edit-page': forward('reception-edit-page'),
    'reception-pair-intake-recipe': forward('reception-pair-intake-recipe'),
    'reception-extend': forward('reception-extend'),
    'reception-rotate-token': forward('reception-rotate-token'),
    'reception-revoke': forward('reception-revoke'),
    'reception-emergency-disable-all': forward('reception-emergency-disable-all'),
    'reception-open-templates': forward('reception-open-templates'),
  } satisfies Record<ReceptionPageAction, (dataset: DOMStringMap) => void>;

  const detachDispatcher = createActionDispatcher<ReceptionPageAction>({
    root: host,
    handlers,
  });
  const unsubscribe = shell.subscribe(render);
  render();

  return {
    update: render,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      detachDispatcher();
      host.innerHTML = '';
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles — self-contained `.reception-*` selectors, colours from the
// shared CSS custom properties (same convention as every primitive +
// `CONNECTIONS_PAGE_STYLES`).
// ════════════════════════════════════════════════════════════════

export const RECEPTION_PAGE_STYLES = `
.reception-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px;
  position: relative;
}
.reception-page .rx-btn {
  min-height: 34px;
  border-radius: 8px;
  font-weight: 650;
  transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease;
}
.reception-page .rx-btn:hover:not(:disabled) { transform: translateY(-1px); }
.reception-page .rx-panel {
  border-radius: 12px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.04);
}
.reception-loading-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--accent, var(--fg));
  opacity: 0.7;
  animation: reception-loading-pulse 1s ease-in-out infinite;
}
@keyframes reception-loading-pulse {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 0.8; }
}
.reception-status-header {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
  padding: 18px 20px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: linear-gradient(110deg, var(--accent-weak), transparent 52%), var(--surface);
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.04), 0 12px 32px rgba(24, 24, 27, 0.04);
}
.reception-status-header::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--accent);
}
.reception-status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.reception-status-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.015em;
  margin: 0;
}
.reception-status-counts {
  font-size: 12px;
  color: var(--fg-muted);
}
.reception-status-spacer { flex: 1; }
.reception-status-url {
  align-self: flex-start;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--accent, var(--fg));
  text-decoration: none;
  padding: 5px 8px;
  border-radius: 7px;
  background: var(--surface-sunk);
}
.reception-status-url--none { color: var(--fg-muted); font-family: inherit; }
.reception-status-nav-link {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  font-size: 12px;
  font-weight: 650;
  color: var(--accent, var(--fg));
  text-decoration: none;
  padding: 6px 9px;
  border-radius: 8px;
  white-space: nowrap;
}
.reception-status-nav-link:hover {
  background: var(--surface-sunk);
}
.reception-status-nav-link:focus-visible {
  outline: 2px solid var(--accent, var(--fg));
  outline-offset: 1px;
}
.reception-compose-link {
  background: var(--accent, var(--fg));
  color: var(--on-accent);
}
.reception-compose-link:hover {
  background: var(--accent-dim, var(--accent, var(--fg)));
  color: var(--on-accent);
  text-decoration: none;
}
.reception-compose-fab {
  display: none;
}
.reception-nav-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--accent, var(--fg));
  color: var(--bg);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  vertical-align: middle;
}
@media (max-width: 640px) {
  .reception-compose-link {
    display: none;
  }
  .reception-compose-fab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    align-self: stretch;
    min-height: 40px;
    border-radius: 9px;
    background: var(--accent, var(--fg));
    color: var(--on-accent);
    text-decoration: none;
    font-size: 18px;
    font-weight: 650;
    box-shadow: 0 6px 18px rgba(24, 24, 27, 0.12);
  }
  .reception-compose-fab::after {
    content: "New endpoint";
    font-size: 13px;
  }
  .reception-compose-fab:focus-visible {
    outline: 2px solid var(--accent, var(--fg));
    outline-offset: 3px;
  }
}
.reception-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.reception-sections {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.reception-section {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 17px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.035);
}
.reception-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.reception-section-title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--fg);
  margin: 0;
}
.reception-section-desc {
  max-width: 72ch;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg-muted);
  margin: 0;
}
.reception-section-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.reception-row {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 13px 14px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--surface-sunk);
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.reception-row:hover {
  border-color: var(--border-strong, var(--border));
  box-shadow: 0 4px 14px rgba(24, 24, 27, 0.045);
}
.reception-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.reception-row-name {
  font-size: 13px;
  font-weight: 650;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--fg);
}
.reception-row-meta {
  font-size: 12px;
  color: var(--fg-muted);
}
.reception-row-revocation {
  font-size: 12px;
  color: var(--fail);
}
.reception-safety-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.reception-safety-label {
  font-size: 11px;
  color: var(--fg-muted);
  padding: 3px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  cursor: help;
}
.reception-row > .rx-action-bar {
  padding-top: 9px;
  border-top: 1px solid var(--border);
}
.reception-mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
}
.reception-cta-body {
  font-size: 13px;
  color: var(--fg);
  margin: 0 0 10px;
}
.reception-subviews {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.reception-subview-cta {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 14px;
  border: 1px dashed var(--border);
  border-radius: 11px;
  background: var(--surface-sunk);
}
.reception-subhead {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  margin: 12px 0 6px;
}
.reception-abuse-head,
.reception-templates-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.reception-abuse-threshold {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0 0 8px;
}
.reception-abuse-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.reception-abuse-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 13px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
}
.reception-abuse-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.reception-abuse-signal {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.reception-abuse-desc,
.reception-abuse-detail,
.reception-abuse-suggest {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0;
}
.reception-abuse-suggest { color: var(--fg); }
.reception-abuse-blocked {
  margin-top: 10px;
}
.reception-abuse-blocked-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
}
.reception-templates-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.reception-template-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 13px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
}
.reception-template-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.reception-template-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.reception-template-desc {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0;
}
.reception-detail,
.reception-vav {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.reception-detail-head,
.reception-vav-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.reception-detail-title,
.reception-vav-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}
.reception-vav-synthetic {
  font-size: 11px;
  color: var(--fg-muted);
  font-style: italic;
}
.reception-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.reception-detail-section {
  display: flex;
  flex-direction: column;
}
.reception-share-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.reception-share-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
}
.reception-share-channel {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--fg-muted);
}
.reception-share-snippet {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}
.reception-access-log { width: 100%; }
.reception-vav-frame {
  width: 100%;
  height: 360px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
}
.reception-vav-fieldsplit {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.reception-vav-fieldsplit > div { flex: 1; min-width: 200px; }
.reception-vav-fieldlist,
.reception-vav-invariantlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.reception-vav-field,
.reception-vav-invariant {
  font-size: 12px;
  color: var(--fg-muted);
}
.reception-vav-field--visible { color: var(--fg); }
.reception-vav-invariant--flagged { color: var(--warn); }
.reception-vav-posture {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.reception-error-copy {
  font-size: 13px;
  margin: 0 0 4px;
}
.reception-error-code {
  font-size: 11px;
  color: var(--fg-muted);
  margin: 0;
}
@media (max-width: 640px) {
  .reception-page { gap: 14px; padding: 0; }
  .reception-status-header { padding: 16px 14px; border-radius: 12px; }
  .reception-status-spacer { display: none; }
  .reception-status-url { width: 100%; }
  .reception-section { padding: 14px; border-radius: 12px; }
  .reception-section-head { align-items: flex-start; }
  .reception-section-head .rx-btn { flex-shrink: 0; }
  .reception-row { padding: 12px; }
  .reception-row > .rx-action-bar .rx-btn { flex: 1 1 auto; }
  .reception-detail-meta { gap: 7px; }
  .reception-vav-frame { height: 300px; }
}
@media (prefers-reduced-motion: reduce) {
  .reception-page *, .reception-page *::before, .reception-page *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`;
