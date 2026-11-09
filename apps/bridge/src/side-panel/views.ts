/** D-169 P1 — side-panel views.
 *
 *  Pure-render functions for each section. The mount module subscribes
 *  to the local store and re-invokes the render that owns each section
 *  on every change. No virtual DOM — `clearChildren` + rebuild is
 *  cheap for a small panel.
 *
 *  Section taxonomy (N.5; D-181 slice 6a adds active-executions):
 *   1. Server status (rich)              — `renderServerStatusSection`
 *   - Active executions (live + control) — `renderActiveExecutionsSection`
 *   2. Recipe results                    — `renderRecipeResultsSection`
 *   3. Notifications                     — `renderNotificationsSection`
 *   4. Approvals (read-only this slice)  — `renderApprovalsSection`
 *   5. Bridge diagnostic (collapsible)    — `renderBridgeDiagnosticSection`
 *
 *  D-169 P2 Slice 1 fills sections #2/#3/#4 from the live bus buffer
 *  (`realtime/bus-buffer.ts`) via the SW `fetch-frames` poll. Section #4
 *  renders read-only ask rows; the interactive approval card +
 *  `notification.submitAnswer` wiring (shared `@recued/ui-shared`
 *  primitive) is Slice 3.
 *
 *  Stable DOM attributes ride on each section + each top-level row so
 *  side-panel tests can query without coupling to className. */

import { renderAskCard } from '@recued/ui-shared/approval-card';

// ⚠ THE BRANCH CHOICE LIVES IN ONE PLACE, and it is a pure function so it can
// be tested exhaustively without a DOM — this repo has no jsdom, and a shim big
// enough to render this module would become the thing under test. Restating
// these conditions here as well is how the two copies would drift.
import { approvalsBody, notificationsBody } from './mode-gates.js';
import { isOnBlockedSite, normalizeBlockedSite } from '../permissions/site-grants.js';
import {
  KEEP_SIGNED_IN_DEFAULT_MINUTES,
  KEEP_SIGNED_IN_MAX_MINUTES,
  KEEP_SIGNED_IN_MIN_MINUTES,
  type KeepSignedInSite,
  type KeepSignedInWindow,
} from '../keep-signed-in.js';
import { confirmedOutcomeGuidance } from './diagnostic-error.js';
import type { DiagnosticSummaryCopyState } from './diagnostic-summary.js';

import type { ActiveExecutionEntry, ServerSystemStatus } from '@recued/contracts';

import type {
  SidePanelDiagnosticFrame,
  SidePanelDisconnectState,
  SidePanelElementWatchStatus,
  SidePanelPairState,
  SidePanelSitesState,
  SidePanelStatusFrame,
  SidePanelStoreState,
} from './store/local-store.js';
import type { DisconnectHandlers } from './disconnect.js';

/** The webclient automation surface the post-create hint deep-links to.
 *  The watch lands DISARMED (brick 1 reconciler); the user enables it
 *  there — the Bridge never enables it (thin/stateless, charter §2). */
const WEBCLIENT_AUTOMATION_URL = 'https://app.recued.com/#automation';

/** D-169 P2 Slice 3 — submit callback the approvals section threads into
 *  each interactive approval card. Called with the open ask + the chosen
 *  option's id; the host (mount → side-panel entry) round-trips it to the
 *  SW `notification.submitAnswer` responder. MAY be async — the card awaits
 *  it to keep its buttons disabled in-flight and re-enables them (with an
 *  inline error) if it rejects (Codex Slice-3 fold). */
export type ApprovalAnswerHandler = (
  askId: string,
  optionId: string,
  /** D-234 § 234.4e — the written reason, when the ask invited one. */
  note?: string,
) => void | Promise<void>;

/** D-169 P2 brick 3 — "Watch this element" launch callback. The side-panel
 *  button calls it; the host (entry) asks the SW to inject the picker into
 *  the active tab. The sanctioned creator gesture (charter §2) — the one
 *  write path on an otherwise read-only surface. MAY be async. */
export type ElementWatchLaunchHandler = () => void | Promise<void>;

/** D-335 slice G — the Sites section's actions. Each MAY be async; its button
 *  stays disabled until it settles. `onAllowEverySite` must ask Chrome inside
 *  the click itself: Chrome grants a site only during a user gesture. */
export interface SitesHandlers {
  onAllowEverySite?: () => void | Promise<void>;
  onStopEverySite?: () => void | Promise<void>;
  /** D-335 slice H — asks Chrome for screenshots inside the click, as
   *  `onAllowEverySite` asks for every site. */
  onAllowScreenshots?: () => void | Promise<void>;
  onStopScreenshots?: () => void | Promise<void>;
  /** Called with a site already in the list's form (`normalizeBlockedSite`). */
  onAddBlocked?: (site: string) => void | Promise<void>;
  onRemoveBlocked?: (site: string) => void | Promise<void>;
  /** D-347 follow-up 19 — Keep signed in: a site with its settings, checked as the list keeps them. */
  onAddKeep?: (entry: KeepSignedInSite) => void | Promise<void>;
  onRemoveKeep?: (site: string) => void | Promise<void>;
  /** D-347 follow-up 22 — what a form's own check found to fix, kept in the section's state so that a redraw
   *  (Keep signed in writes its status every minute or so) does not wipe it: the list of sites never used,
   *  and Keep signed in. */
  onBlockedProblem?: (problem: string) => void | Promise<void>;
  onKeepProblem?: (problem: string) => void | Promise<void>;
}

/** Hands a form's problem to its handler, whose failures are its own. */
const reportProblem = (report: ((problem: string) => void | Promise<void>) | undefined, problem: string): void => {
  try {
    void Promise.resolve(report?.(problem)).catch(() => undefined);
  } catch {
    // The handler reports its own failures.
  }
};

/** D-181 slice 6a — the action a live-control button routes. `kill` carries a
 *  run_id (a running run / detached job); `cancel` + `promote` carry a
 *  queued_call_id (a call still waiting on a slot). */
export type ActiveControlAction = 'kill' | 'cancel' | 'promote';

/** D-181 slice 6a — control callback the active-executions section threads into
 *  each row's buttons. Called with the action + the relevant id (run_id for
 *  `kill`, queued_call_id for `cancel` / `promote`); the host (mount → entry)
 *  round-trips it to the SW `execution-{kill,cancel,promote}` responder →
 *  `execution.*` rpc. Present ONLY when this bridge holds `bridge_mode.approval`
 *  (§8) — absent → the section renders a read-only mirror (no buttons). MAY be
 *  async. */
export type ActiveControlHandler = (
  action: ActiveControlAction,
  id: string,
) => void | Promise<void>;

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for jsdom tests + Settings UI
// ════════════════════════════════════════════════════════════════

export const SIDE_PANEL_ROOT_ATTR = 'data-recued-side-panel-root';
/** The unpaired panel's pairing section, and the slot inside it where the
 *  pair form mounts (`pairing/pair-code-input-host.ts`). */
export const SIDE_PANEL_PAIR_SECTION_ATTR = 'data-recued-side-panel-pair';
export const SIDE_PANEL_PAIR_HOST_ATTR = 'data-recued-side-panel-pair-host';
export const SIDE_PANEL_SECTION_ATTR = 'data-recued-side-panel-section';
export const SIDE_PANEL_STATUS_VALUE_ATTR = 'data-recued-side-panel-status-value';
/** The Server status section's Disconnect buttons: `ask`, `confirm` or `cancel`. */
export const SIDE_PANEL_DISCONNECT_ATTR = 'data-recued-side-panel-disconnect';
/** Why the last Disconnect did not go through. */
export const SIDE_PANEL_DISCONNECT_MESSAGE_ATTR = 'data-recued-side-panel-disconnect-message';
/** D-169 P2 Slice 1 — stable hook on each rendered list row (sections
 *  #2/#3/#4) so tests can count + query items without coupling to
 *  className. The attribute value is the section id. */
export const SIDE_PANEL_LIST_ITEM_ATTR = 'data-recued-side-panel-list-item';
export const SIDE_PANEL_HEADER_TITLE_ID = 'header-title';
export const SIDE_PANEL_HEADER_SUBTITLE_ID = 'header-subtitle';
/** 2026-11-04 — the server's connection, as a pill beside the title (`updateHeaderStatus`). */
export const SIDE_PANEL_HEADER_STATUS_ID = 'header-status';
/** D-169 P2 brick 3 — stable hooks for the "Watch this element" creator
 *  block: the wrapper, its launch button, and its transient status line. */
export const SIDE_PANEL_WATCH_CTA_ATTR = 'data-recued-side-panel-watch-cta';
export const SIDE_PANEL_WATCH_BUTTON_ATTR = 'data-recued-side-panel-watch-button';
export const SIDE_PANEL_WATCH_STATUS_ATTR = 'data-recued-side-panel-watch-status';
/** D-181 slice 6a — stable hooks for the active-executions section: each entry
 *  row (value = the entry's control id), each lane line (value = lane name),
 *  each control button (value = the action), and the transient notice line. */
export const SIDE_PANEL_ACTIVE_ROW_ATTR = 'data-recued-side-panel-active-row';
/** The service worker's `fetch-status` answer while its socket is still
 *  coming up (`service-worker-bootstrap.ts`). */
export const BRIDGE_STATUS_CONNECTING = 'bridge_connecting';
export const SIDE_PANEL_ACTIVE_LANE_ATTR = 'data-recued-side-panel-active-lane';
export const SIDE_PANEL_ACTIVE_CONTROL_ATTR = 'data-recued-side-panel-active-control';
export const SIDE_PANEL_ACTIVE_NOTICE_ATTR = 'data-recued-side-panel-active-notice';
export const SIDE_PANEL_DIAGNOSTIC_REFRESH_ATTR = 'data-recued-diagnostic-refresh';
export const SIDE_PANEL_DIAGNOSTIC_COPY_ATTR = 'data-recued-diagnostic-copy';
export const SIDE_PANEL_DIAGNOSTIC_SUMMARY_ATTR = 'data-recued-diagnostic-summary';
/** D-335 slice G — the Sites section: the grant's state (value `unknown`,
 *  `every_site` or `not_granted`), its button (value `allow` or `stop`), each
 *  listed site's row and Remove button (value = the site), the input, its Add
 *  button, and the message line. */
export const SIDE_PANEL_SITES_STATUS_ATTR = 'data-recued-side-panel-sites-status';
export const SIDE_PANEL_SITES_GRANT_ATTR = 'data-recued-side-panel-sites-grant';
export const SIDE_PANEL_SITES_ROW_ATTR = 'data-recued-side-panel-sites-row';
export const SIDE_PANEL_SITES_REMOVE_ATTR = 'data-recued-side-panel-sites-remove';
export const SIDE_PANEL_SITES_INPUT_ATTR = 'data-recued-side-panel-sites-input';
export const SIDE_PANEL_SITES_ADD_ATTR = 'data-recued-side-panel-sites-add';
export const SIDE_PANEL_SITES_MESSAGE_ATTR = 'data-recued-side-panel-sites-message';
/** D-335 slice H — the screenshots line (value `on` or `off`) and its button
 *  (value `allow` or `stop`), shown while every site is allowed. */
export const SIDE_PANEL_SITES_SCREENSHOTS_ATTR = 'data-recued-side-panel-sites-screenshots';
export const SIDE_PANEL_SITES_SCREENSHOTS_GRANT_ATTR = 'data-recued-side-panel-sites-screenshots-grant';
/** D-347 follow-up 19 — Keep signed in's card: a site's row, its Remove, its status, the add form's fields
 *  (`site`, `every`, `mode`, `when`, `day-<0..6>`, `from`, `to`, `hours`), its Add and its message. */
export const SIDE_PANEL_KEEP_ROW_ATTR = 'data-recued-side-panel-keep-row';
export const SIDE_PANEL_KEEP_REMOVE_ATTR = 'data-recued-side-panel-keep-remove';
export const SIDE_PANEL_KEEP_STATUS_ATTR = 'data-recued-side-panel-keep-status';
export const SIDE_PANEL_KEEP_FIELD_ATTR = 'data-recued-side-panel-keep-field';
export const SIDE_PANEL_KEEP_ADD_ATTR = 'data-recued-side-panel-keep-add';
export const SIDE_PANEL_KEEP_MESSAGE_ATTR = 'data-recued-side-panel-keep-message';

export type SectionId =
  | 'server-status'
  | 'sites'
  | 'active-executions'
  | 'recipe-results'
  | 'notifications'
  | 'approvals'
  | 'bridge-diagnostic'
  // 2026-11-04 — the "Watch this element" block, as a section so it folds (`folds.ts`).
  | 'watch';

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

const formatSeconds = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

const formatCount = (n: number | null): string =>
  n === null ? '—' : String(n);

/** λ×W approval-load row. Load renders as a percentage (occupancy of the
 *  approval channel); the sample count rides along because a 7-day median
 *  can rest on very few answers — a bare percentage would over-claim. */
const formatAskLoad = (
  a: ServerSystemStatus['ask_load'] | undefined,
): string => {
  // `undefined` tolerated deliberately: a pre-`ask_load` server serving a
  // newer bridge omits the field entirely, and version skew must render as
  // not-wired, never crash the whole status card.
  if (a == null) return '—';
  if (a.median_answer_ms === null || a.load === null) {
    return `${a.raised} asks / 7d · no answers in window`;
  }
  const mins = Math.round(a.median_answer_ms / 60_000);
  const median = mins < 60 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`;
  return `${(a.load * 100).toFixed(1)}% (${a.raised} asks / 7d · median ${median} · n=${a.answered_sample})`;
};

/** D-212 §7.10 — render the keyfile posture.
 *
 *  ⛔ Deliberately NOT `formatCount`-shaped. That helper collapses `null` to
 *  `—`, and applying the same treatment here would render a known-UNSEALED
 *  realm identically to a boot-race. `null` is "we do not know" (an older
 *  server, or a snapshot taken before the identity booted); `'none'` is "we
 *  know, and it is bad". */
const formatKeyfileSealing = (
  sealing: 'machine' | 'passphrase' | 'none' | null,
): string => {
  if (sealing === null) return '—';
  if (sealing === 'none') return '⚠ UNSEALED';
  return `sealed (${sealing})`;
};

export const formatRelative = (
  unix_ms: number | null,
  now: number,
): string => {
  if (unix_ms === null) return 'never';
  const deltaSec = Math.max(0, Math.floor((now - unix_ms) / 1000));
  if (deltaSec < 5) return 'just now';
  return `${formatSeconds(deltaSec)} ago`;
};

const appendRow = (
  doc: Document,
  card: HTMLElement,
  key: string,
  value: string,
  rowAttr?: string,
): void => {
  const row = doc.createElement('div');
  row.className = 'row';
  if (rowAttr) row.setAttribute(SIDE_PANEL_STATUS_VALUE_ATTR, rowAttr);
  const k = doc.createElement('span');
  k.className = 'k';
  k.textContent = key;
  const v = doc.createElement('span');
  v.className = 'v';
  v.textContent = value;
  row.appendChild(k);
  row.appendChild(v);
  card.appendChild(row);
};

const emptyCard = (
  doc: Document,
  message: string,
  tone: 'neutral' | 'danger' = 'neutral',
): HTMLElement => {
  const card = doc.createElement('div');
  card.className =
    tone === 'danger'
      ? 'card card-empty card-empty-danger'
      : 'card card-empty';
  const p = doc.createElement('div');
  p.className = 'empty';
  p.textContent = message;
  card.appendChild(p);
  return card;
};

/** D-169 P2 Slice 1 — append one list-section row to a card. `primary`
 *  is the left label (`.k`), `meta` the right-aligned monospace cell
 *  (`.v`); optional `secondary` lines render as muted sub-lines beneath.
 *  All text goes through `textContent`, so any server-derived string is
 *  inert (no HTML injection). The row carries the stable list-item hook
 *  for tests. */
const appendListItem = (
  doc: Document,
  card: HTMLElement,
  section: SectionId,
  primary: string,
  meta: string,
  secondary?: ReadonlyArray<string>,
): void => {
  const row = doc.createElement('div');
  row.className = 'row';
  row.setAttribute(SIDE_PANEL_LIST_ITEM_ATTR, section);
  const k = doc.createElement('span');
  k.className = 'k';
  k.textContent = primary;
  const v = doc.createElement('span');
  v.className = 'v';
  v.textContent = meta;
  row.appendChild(k);
  row.appendChild(v);
  card.appendChild(row);
  for (const line of secondary ?? []) {
    if (line === '') continue;
    const sub = doc.createElement('div');
    sub.className = 'subtle';
    sub.textContent = line;
    card.appendChild(sub);
  }
};

/** D-169 P2 Slice 1 Codex fold — treat a blank / whitespace-only title
 *  as absent so a `title ?? text` fallback works (`??` only catches
 *  null / undefined, NOT `''`). Without this an empty-string title from
 *  the bus would render a blank primary line + demote the real body
 *  text to a sub-line. Shared by the notifications + approvals
 *  renderers. */
const nonBlankTitle = (title: string | undefined): string | undefined =>
  title !== undefined && title.trim() !== '' ? title : undefined;

const buildSectionShell = (
  doc: Document,
  id: SectionId,
  title: string,
): { section: HTMLElement; heading: HTMLElement; body: HTMLElement } => {
  const section = doc.createElement('section');
  section.setAttribute(SIDE_PANEL_SECTION_ATTR, id);
  const h2 = doc.createElement('h2');
  h2.textContent = title;
  section.appendChild(h2);
  const body = doc.createElement('div');
  section.appendChild(body);
  return { section, heading: h2, body };
};

// ════════════════════════════════════════════════════════════════
// Header (always rendered; updates per pair state)
// ════════════════════════════════════════════════════════════════

export const updateHeader = (
  doc: Document,
  pair: SidePanelPairState,
): void => {
  const titleEl = doc.getElementById(SIDE_PANEL_HEADER_TITLE_ID);
  const subtitleEl = doc.getElementById(SIDE_PANEL_HEADER_SUBTITLE_ID);
  if (!titleEl || !subtitleEl) return;
  if (!pair.paired) {
    titleEl.textContent = 'Recued Bridge';
    subtitleEl.textContent = 'Pair this bridge to get started.';
    subtitleEl.setAttribute('title', '');
    return;
  }
  // Keep the product brand stable like the webclient top bar; the paired
  // server is connection context, not a replacement app identity.
  titleEl.textContent = 'Recued Bridge';
  const connectionLabel =
    pair.server_display_name && pair.server_url
      ? `${pair.server_display_name} · ${pair.server_url}`
      : pair.server_display_name ?? pair.server_url ?? 'Paired';
  subtitleEl.textContent = connectionLabel;
  subtitleEl.setAttribute('title', connectionLabel);
};

/** 2026-11-04 — the server's connection as a pill beside the panel's title, so it shows while the
 *  Server section is folded: Connected, Connecting…, Offline or "Cannot reach server" (the one
 *  danger hue, as the section's own pill uses it). Hidden while unpaired (`null`). */
export const updateHeaderStatus = (
  doc: Document,
  frame: SidePanelStatusFrame | null,
): void => {
  const pill = doc.getElementById(SIDE_PANEL_HEADER_STATUS_ID);
  if (!pill) return;
  if (frame === null) {
    pill.hidden = true;
    return;
  }
  const { status, error } = frame;
  const [label, tone] = status === null
    ? (error === null || error === BRIDGE_STATUS_CONNECTING ? ['Connecting…', 'plain'] : ['Cannot reach server', 'danger'])
    : status.ws_state === 'offline' ? ['Offline', 'danger'] : ['Connected', 'ok'];
  pill.textContent = label;
  pill.className = `pill header-status${tone === 'danger' ? ' pill-danger' : tone === 'ok' ? ' pill-ok' : ''}`;
  pill.hidden = false;
};

// ════════════════════════════════════════════════════════════════
// Pairing (unpaired panel)
// ════════════════════════════════════════════════════════════════

/** The unpaired panel: the bridge's single purpose, then the slot the pair
 *  form mounts into. The form lives here, not in a toolbar popup: 0.0.1
 *  paired from a popup, which Chrome closes on any click elsewhere — copying
 *  the code from another tab, say — and a popup closed while the server
 *  answered lost a pairing whose code was already spent. The panel stays
 *  open, and the service worker sends the request anyway, so even closing
 *  the panel costs nothing (`pairing/worker-pairing.ts`).
 *
 *  D-169 P3.4 — this is the first view every user (and a Chrome Web Store
 *  reviewer, who won't self-host a server) sees, so it has to convey the
 *  Bridge's single purpose on its own: a thin/stateless browser companion
 *  that actuates server-issued commands + surfaces notifications/approvals
 *  and holds no data of its own (D-148/D-169). */
export const renderPairSection = (
  doc: Document,
): { section: HTMLElement; slot: HTMLElement } => {
  const section = doc.createElement('div');
  section.setAttribute(SIDE_PANEL_PAIR_SECTION_ATTR, '');
  section.className = 'pair-section';

  // Single-purpose statement (CWS requirement + first-run orientation).
  const purpose = doc.createElement('p');
  purpose.className = 'purpose';
  purpose.textContent =
    'Recued Bridge is the browser companion for a Recued server you host '
    + 'yourself. It reads pages you point it at, shows desktop notifications, '
    + 'and lets you approve actions — carrying out only what your server asks '
    + 'and keeping no data of its own.';
  section.appendChild(purpose);

  const slot = doc.createElement('div');
  slot.setAttribute(SIDE_PANEL_PAIR_HOST_ATTR, '');
  slot.className = 'pair-host';
  section.appendChild(slot);

  const subtle = doc.createElement('div');
  subtle.className = 'empty';
  subtle.textContent =
    'Once paired, this panel shows live server status, recent recipe runs, '
    + 'notifications, and approvals.';
  section.appendChild(subtle);
  return { section, slot };
};

// ════════════════════════════════════════════════════════════════
// "Watch this element" creator entry (brick 3)
// ════════════════════════════════════════════════════════════════

/** D-169 P2 brick 3 — the dom-watch creator entry-point: a single button
 *  that launches the in-page element picker (the SANCTIONED write gesture on
 *  this otherwise read-only surface, charter §2) + a transient status line
 *  fed by the launch result and the SW-pushed create outcome. NOT a section
 *  (carries no section attr) — it's a thin action block, like the pair CTA.
 *  Display only beyond the one button; no list, no inline enable (the watch
 *  lands DISARMED and is enabled in the webclient). */
export const renderElementWatchCta = (
  doc: Document,
  status: SidePanelElementWatchStatus,
  opts?: { onLaunch?: ElementWatchLaunchHandler },
): HTMLElement => {
  const wrap = doc.createElement('div');
  wrap.className = 'watch-cta';
  wrap.setAttribute(SIDE_PANEL_WATCH_CTA_ATTR, '');

  const button = doc.createElement('button');
  button.className = 'watch-button';
  button.setAttribute(SIDE_PANEL_WATCH_BUTTON_ATTR, '');
  button.setAttribute('type', 'button');
  button.textContent = 'Watch this element';
  const onLaunch = opts?.onLaunch;
  // `addEventListener` is absent on the jsdom-free test fake; guard so the
  // pure-render tests still build the button (the click path is exercised by
  // the mount test's event-capable fake).
  if (onLaunch && typeof button.addEventListener === 'function') {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      const originalLabel = button.textContent;
      button.textContent = 'Starting picker…';
      void Promise.resolve(onLaunch())
        .catch(() => {
          // The production handler converts transport failures into the
          // store-backed status line. Isolate an injected handler that still
          // rejects so the panel never produces an unhandled promise.
        })
        .finally(() => {
          button.disabled = false;
          button.setAttribute('aria-busy', 'false');
          button.textContent = originalLabel;
        });
    });
  }
  wrap.appendChild(button);

  if (status.message !== '') {
    const line = doc.createElement('div');
    line.className =
      status.tone === 'danger' ? 'watch-status watch-status-danger' : 'watch-status';
    line.setAttribute(SIDE_PANEL_WATCH_STATUS_ATTR, '');
    line.setAttribute('role', status.tone === 'danger' ? 'alert' : 'status');
    line.textContent = status.message;
    wrap.appendChild(line);
    if (status.webclient_link) {
      const link = doc.createElement('a');
      link.className = 'watch-link';
      link.setAttribute('href', WEBCLIENT_AUTOMATION_URL);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noreferrer');
      link.textContent = 'Open the webclient → Automation';
      wrap.appendChild(link);
    }
  }
  return wrap;
};

// ════════════════════════════════════════════════════════════════
// Sites (D-335 slice G)
// ════════════════════════════════════════════════════════════════

/** A button that runs `action` once at a time: disabled, and `aria-busy`,
 *  until it settles. A rejection is the handler's to report. ⚠ The action
 *  starts inside the click, never a tick later: Chrome grants a site only
 *  while the gesture lasts. */
const actionButton = (
  doc: Document,
  label: string,
  className: string,
  attr: [string, string],
  action: (() => void | Promise<void>) | undefined,
): HTMLButtonElement => {
  const button = doc.createElement('button');
  button.className = className;
  button.setAttribute('type', 'button');
  button.setAttribute(attr[0], attr[1]);
  button.textContent = label;
  // `addEventListener` is absent on the test fake (see the watch button).
  if (action && typeof button.addEventListener === 'function') {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      let settled: Promise<void>;
      try {
        settled = Promise.resolve(action());
      } catch {
        settled = Promise.resolve();
      }
      void settled
        .catch(() => undefined)
        .finally(() => {
          button.disabled = false;
          button.setAttribute('aria-busy', 'false');
        });
    });
  }
  return button;
};

/** D-335 slice G — the sites this Bridge may use, and the owner's list of
 *  sites Recued must never use. The grant is Chrome's own permission; the
 *  list lives in this browser (`permissions/site-grants.ts`). */
export const renderSitesSection = (
  doc: Document,
  sites: SidePanelSitesState,
  handlers: SitesHandlers = {},
): HTMLElement => {
  const { section, body } = buildSectionShell(doc, 'sites', 'Sites');

  const grant = doc.createElement('div');
  grant.className = 'card sites-card';
  const status = doc.createElement('p');
  status.className = 'sites-status';
  status.setAttribute(SIDE_PANEL_SITES_STATUS_ATTR,
    sites.every_site === null ? 'unknown' : sites.every_site ? 'every_site' : 'not_granted');
  status.textContent = sites.every_site === null ? 'Checking which sites the Bridge may use…'
    : sites.every_site ? 'The Bridge may use every site in this browser for your AI.'
      : 'The Bridge may not use your sites yet.';
  grant.appendChild(status);
  const explain = doc.createElement('p');
  explain.className = 'sites-explain';
  explain.textContent = 'Your AI reads pages and, after you approve, types, clicks and opens pages, signed in as you.';
  grant.appendChild(explain);
  // Chrome's own grant: the button is the only place this panel asks for it.
  if (sites.every_site !== null) {
    grant.appendChild(sites.every_site
      ? actionButton(doc, 'Stop using every site', 'sites-button', [SIDE_PANEL_SITES_GRANT_ATTR, 'stop'], handlers.onStopEverySite)
      : actionButton(doc, 'Allow every site', 'sites-button sites-button-primary', [SIDE_PANEL_SITES_GRANT_ATTR, 'allow'],
        handlers.onAllowEverySite));
  }
  // D-335 slice H — screenshots of those pages, a separate grant the owner asks
  // for (Chrome pictures a tab only for an extension holding `<all_urls>`).
  if (sites.every_site === true && sites.screenshots !== null) {
    const shots = doc.createElement('p');
    shots.className = 'sites-status';
    shots.setAttribute(SIDE_PANEL_SITES_SCREENSHOTS_ATTR, sites.screenshots ? 'on' : 'off');
    shots.textContent = sites.screenshots ? 'Your AI can also take screenshots of these pages.'
      : 'Your AI cannot take screenshots.';
    grant.appendChild(shots);
    const shotsExplain = doc.createElement('p');
    shotsExplain.className = 'sites-explain';
    shotsExplain.textContent = 'A screenshot shows a page as you see it, its frames and fields included, '
      + 'and brings its tab to the front for a moment.';
    grant.appendChild(shotsExplain);
    grant.appendChild(sites.screenshots
      ? actionButton(doc, 'Stop screenshots', 'sites-button', [SIDE_PANEL_SITES_SCREENSHOTS_GRANT_ATTR, 'stop'],
        handlers.onStopScreenshots)
      : actionButton(doc, 'Allow screenshots', 'sites-button', [SIDE_PANEL_SITES_SCREENSHOTS_GRANT_ATTR, 'allow'],
        handlers.onAllowScreenshots));
  }
  body.appendChild(grant);

  const list = doc.createElement('div');
  list.className = 'card sites-card';
  const heading = doc.createElement('h3');
  heading.className = 'sites-heading';
  heading.textContent = 'Never use these sites';
  list.appendChild(heading);
  if (sites.blocked.length === 0) {
    const none = doc.createElement('p');
    none.className = 'sites-explain';
    none.textContent = 'No sites listed. A site here, and every page under it, is never read or acted on.';
    list.appendChild(none);
  }
  for (const site of sites.blocked) {
    const row = doc.createElement('div');
    row.className = 'sites-row';
    row.setAttribute(SIDE_PANEL_SITES_ROW_ATTR, site);
    const name = doc.createElement('span');
    name.className = 'sites-name';
    name.textContent = site;
    row.appendChild(name);
    const remove = actionButton(doc, 'Remove', 'sites-button', [SIDE_PANEL_SITES_REMOVE_ATTR, site],
      handlers.onRemoveBlocked ? () => handlers.onRemoveBlocked!(site) : undefined);
    remove.setAttribute('aria-label', `Remove ${site}`);
    row.appendChild(remove);
    list.appendChild(row);
  }

  const message = doc.createElement('p');
  message.className = 'sites-message';
  message.setAttribute(SIDE_PANEL_SITES_MESSAGE_ATTR, '');
  message.setAttribute('role', 'status');
  message.textContent = sites.message;

  const add = doc.createElement('div');
  add.className = 'sites-add';
  const input = doc.createElement('input');
  input.className = 'sites-input';
  input.setAttribute('type', 'text');
  input.setAttribute('placeholder', 'example.com');
  input.setAttribute('aria-label', 'A site Recued must never use');
  input.setAttribute(SIDE_PANEL_SITES_INPUT_ATTR, '');
  add.appendChild(input);
  // Checked here, so a typo keeps the text to fix rather than losing it to a
  // re-render.
  const addTyped = (): void | Promise<void> => {
    const site = normalizeBlockedSite(input.value ?? '');
    if (site === null) {
      message.textContent = 'Type a site such as example.com.';
      reportProblem(handlers.onBlockedProblem, message.textContent);
      return;
    }
    return handlers.onAddBlocked?.(site);
  };
  add.appendChild(actionButton(doc, 'Add', 'sites-button', [SIDE_PANEL_SITES_ADD_ATTR, ''],
    handlers.onAddBlocked ? addTyped : undefined));
  if (handlers.onAddBlocked && typeof input.addEventListener === 'function') {
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      try {
        void Promise.resolve(addTyped()).catch(() => undefined);
      } catch {
        // The handler reports its own failures.
      }
    });
  }
  list.appendChild(add);
  list.appendChild(message);
  body.appendChild(list);
  body.appendChild(renderKeepSignedInCard(doc, sites, handlers));
  return section;
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** A moment as this computer's clock shows it, `HH:MM`. */
const clockAt = (at: number): string => {
  const when = new Date(at);
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
};
/** Days as a person writes them: `Mon–Fri` for a run of three or more, else each. */
const daysSaid = (days: readonly number[]): string => {
  const run = days.length >= 3 && days.every((day, i) => i === 0 || day === days[i - 1]! + 1);
  return run ? `${DAY_NAMES[days[0]!]!}–${DAY_NAMES[days.at(-1)!]!}` : days.map((day) => DAY_NAMES[day]!).join(', ');
};
const keepWindowSaid = (window: KeepSignedInWindow | undefined): string => (window === undefined ? 'always'
  : 'until' in window ? `until ${clockAt(window.until)}` : `${daysSaid(window.days)}, ${window.from}–${window.to}`);

/** D-347 follow-up 19 — Keep signed in (`keep-signed-in.ts`): the sites whose sign-in the Bridge keeps
 *  alive, each with how often, how, when and what happened last, and a form to add one. */
const renderKeepSignedInCard = (doc: Document, sites: SidePanelSitesState, handlers: SitesHandlers): HTMLElement => {
  const rows = sites.keep ?? [];
  const card = doc.createElement('div');
  card.className = 'card sites-card';
  const heading = doc.createElement('h3');
  heading.className = 'sites-heading';
  heading.textContent = 'Keep signed in';
  card.appendChild(heading);
  const explain = doc.createElement('p');
  explain.className = 'sites-explain';
  explain.textContent = 'For a site that signs you out when you are idle. While a tab shows it, the Bridge refreshes it '
    + 'every few minutes: never while Recued is acting in the browser, and never a tab you are using. Pick fewer minutes '
    + 'than the site lets you stay idle, since a refresh can come a little late.';
  card.appendChild(explain);
  for (const { entry, status } of rows) {
    const row = doc.createElement('div');
    row.className = 'sites-row';
    row.setAttribute(SIDE_PANEL_KEEP_ROW_ATTR, entry.site);
    const name = doc.createElement('span');
    name.className = 'sites-name';
    name.textContent = entry.site;
    row.appendChild(name);
    const remove = actionButton(doc, 'Remove', 'sites-button', [SIDE_PANEL_KEEP_REMOVE_ATTR, entry.site],
      handlers.onRemoveKeep ? () => handlers.onRemoveKeep!(entry.site) : undefined);
    remove.setAttribute('aria-label', `Stop keeping ${entry.site} signed in`);
    row.appendChild(remove);
    card.appendChild(row);
    const how = doc.createElement('p');
    how.className = 'sites-explain';
    how.textContent = `Every ${String(entry.every_minutes)} minute${entry.every_minutes === 1 ? '' : 's'}, `
      + `${entry.mode === 'session' ? 'keeping the session' : 'reloading the page'}, ${keepWindowSaid(entry.window)}.`;
    card.appendChild(how);
    const said = doc.createElement('p');
    said.className = 'sites-explain';
    said.setAttribute(SIDE_PANEL_KEEP_STATUS_ATTR, entry.site);
    said.textContent = entry.off === true ? 'Stopped: its hours ran out. Add it again to start again.'
      : `${status?.last !== undefined ? `${clockAt(status.last.at)}: ${status.last.said}` : 'Not refreshed yet.'}`
        + `${status?.next_at !== undefined ? ` Next at ${clockAt(status.next_at)}.` : ''}`;
    card.appendChild(said);
  }

  const message = doc.createElement('p');
  message.className = 'sites-message';
  message.setAttribute(SIDE_PANEL_KEEP_MESSAGE_ATTR, '');
  message.setAttribute('role', 'status');
  message.textContent = sites.keep_message ?? '';
  const field = <T extends HTMLElement>(tag: string, key: string, attrs: Record<string, string>, value?: string): T => {
    const element = doc.createElement(tag) as T;
    element.setAttribute(SIDE_PANEL_KEEP_FIELD_ATTR, key);
    for (const [name, attr] of Object.entries(attrs)) element.setAttribute(name, attr);
    if (value !== undefined) (element as unknown as { value: string }).value = value;
    return element;
  };
  const labelled = (text: string, ...parts: HTMLElement[]): HTMLElement => {
    const label = doc.createElement('label');
    label.className = 'sites-explain';
    label.appendChild(doc.createTextNode?.(`${text} `) ?? Object.assign(doc.createElement('span'), { textContent: `${text} ` }));
    for (const part of parts) label.appendChild(part);
    return label;
  };
  const choice = (key: string, aria: string, options: Array<[string, string]>): HTMLSelectElement => {
    const select = field<HTMLSelectElement>('select', key, { 'aria-label': aria });
    for (const [value, text] of options) {
      const option = doc.createElement('option');
      option.setAttribute('value', value);
      option.textContent = text;
      select.appendChild(option);
    }
    (select as unknown as { value: string }).value = options[0]![0];
    return select;
  };
  const add = doc.createElement('div');
  add.className = 'sites-add';
  const site = field<HTMLInputElement>('input', 'site', { type: 'text', placeholder: 'console.example.com',
    'aria-label': 'A site to keep signed in' }, '');
  add.appendChild(site);
  const every = field<HTMLInputElement>('input', 'every', { type: 'number', min: String(KEEP_SIGNED_IN_MIN_MINUTES),
    max: String(KEEP_SIGNED_IN_MAX_MINUTES), 'aria-label': 'Minutes between refreshes' }, String(KEEP_SIGNED_IN_DEFAULT_MINUTES));
  card.appendChild(add);
  const settings = doc.createElement('div');
  settings.className = 'sites-add';
  settings.appendChild(labelled('Every', every, Object.assign(doc.createElement('span'), { textContent: ' minutes' })));
  const mode = choice('mode', 'How to refresh it', [['session', 'Keep the session'], ['reload', 'Reload the page']]);
  settings.appendChild(mode);
  const when = choice('when', 'When', [['always', 'Always'], ['days', 'On these days and hours'], ['hours', 'For the next hours']]);
  settings.appendChild(when);
  card.appendChild(settings);
  // On these days and hours: Monday first, as a week is read; Monday to Friday, 08:00 to 18:00, to start with.
  const days = doc.createElement('div');
  days.className = 'sites-add';
  const dayBoxes = [1, 2, 3, 4, 5, 6, 0].map((day) => {
    const box = field<HTMLInputElement>('input', `day-${String(day)}`, { type: 'checkbox', 'aria-label': DAY_NAMES[day]! });
    (box as unknown as { checked: boolean }).checked = day >= 1 && day <= 5;
    days.appendChild(labelled(DAY_NAMES[day]!, box));
    return { day, box };
  });
  const from = field<HTMLInputElement>('input', 'from', { type: 'time', 'aria-label': 'From' }, '08:00');
  const to = field<HTMLInputElement>('input', 'to', { type: 'time', 'aria-label': 'To' }, '18:00');
  days.appendChild(labelled('From', from));
  days.appendChild(labelled('to', to));
  const hoursRow = doc.createElement('div');
  hoursRow.className = 'sites-add';
  const hours = field<HTMLInputElement>('input', 'hours', { type: 'number', min: '1', max: '24', 'aria-label': 'Hours' }, '4');
  hoursRow.appendChild(labelled('For the next', hours, Object.assign(doc.createElement('span'), { textContent: ' hours' })));
  const shown = (value: string) => {
    (days as unknown as { hidden: boolean }).hidden = value !== 'days';
    (hoursRow as unknown as { hidden: boolean }).hidden = value !== 'hours';
  };
  shown('always');
  if (typeof when.addEventListener === 'function') {
    when.addEventListener('change', () => shown((when as unknown as { value: string }).value));
  }
  card.appendChild(days);
  card.appendChild(hoursRow);
  // Checked here, so a mistake keeps what was typed to fix rather than losing it to a re-render; what to fix is
  // said at once and kept in the section's state, so the next redraw says it too (follow-up 22).
  const say = (problem: string): void => {
    message.textContent = problem;
    reportProblem(handlers.onKeepProblem, problem);
  };
  const addTyped = (): void | Promise<void> => {
    const value = (element: HTMLElement) => String((element as unknown as { value?: unknown }).value ?? '').trim();
    const host = normalizeBlockedSite(value(site));
    if (host === null) {
      say('Type a site such as console.example.com.');
      return;
    }
    // The timer would leave it alone (follow-up 20): said now, not at its first refresh.
    if (isOnBlockedSite(`https://${host}/`, sites.blocked)) {
      say(`${host} is on your list of sites never to use, so the Bridge leaves it alone.`);
      return;
    }
    const minutes = Number(value(every));
    if (!Number.isInteger(minutes) || minutes < KEEP_SIGNED_IN_MIN_MINUTES || minutes > KEEP_SIGNED_IN_MAX_MINUTES) {
      say(`Refresh it every ${String(KEEP_SIGNED_IN_MIN_MINUTES)} to ${String(KEEP_SIGNED_IN_MAX_MINUTES)} minutes.`);
      return;
    }
    let window: KeepSignedInWindow | undefined;
    const whenValue = value(when);
    if (whenValue === 'days') {
      const picked = dayBoxes.filter(({ box }) => (box as unknown as { checked?: boolean }).checked === true)
        .map(({ day }) => day).sort((a, b) => a - b);
      const start = value(from);
      const end = value(to);
      if (picked.length === 0 || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start >= end) {
        say('Pick at least one day, and a time it starts before the time it ends.');
        return;
      }
      window = { days: picked, from: start, to: end };
    } else if (whenValue === 'hours') {
      const count = Number(value(hours));
      if (!Number.isInteger(count) || count < 1 || count > 24) {
        say('For the next 1 to 24 hours.');
        return;
      }
      window = { until: Date.now() + count * 3_600_000 };
    }
    message.textContent = '';
    return handlers.onAddKeep?.({ site: host, every_minutes: minutes, mode: value(mode) === 'reload' ? 'reload' : 'session',
      ...(window !== undefined ? { window } : {}) });
  };
  card.appendChild(actionButton(doc, 'Keep signed in', 'sites-button', [SIDE_PANEL_KEEP_ADD_ATTR, ''],
    handlers.onAddKeep ? addTyped : undefined));
  card.appendChild(message);
  return card;
};

// ════════════════════════════════════════════════════════════════
// Section 1 — Server status (rich)
// ════════════════════════════════════════════════════════════════

/** The Disconnect under the server's status: the button, or the question it asks first, since
 *  only pairing again undoes it. Shown however the server is doing: offline is when an owner
 *  most needs it. */
const renderDisconnect = (
  doc: Document,
  state: SidePanelDisconnectState,
  handlers: DisconnectHandlers,
  serverName: string,
): HTMLElement => {
  const block = doc.createElement('div');
  block.className = 'disconnect';
  if (state.phase === 'idle') {
    block.appendChild(actionButton(doc, 'Disconnect this bridge', 'disconnect-button',
      [SIDE_PANEL_DISCONNECT_ATTR, 'ask'], handlers.onAsk));
  } else {
    const prompt = doc.createElement('p');
    prompt.className = 'disconnect-prompt';
    prompt.textContent = `Disconnect this bridge from ${serverName}? Recued stops using this browser until you pair it again.`;
    block.appendChild(prompt);
    const actions = doc.createElement('div');
    actions.className = 'disconnect-actions';
    const working = state.phase === 'working';
    const confirm = actionButton(doc, working ? 'Disconnecting…' : 'Disconnect', 'disconnect-button disconnect-button-danger',
      [SIDE_PANEL_DISCONNECT_ATTR, 'confirm'], working ? undefined : handlers.onConfirm);
    if (working) confirm.disabled = true;
    actions.appendChild(confirm);
    if (!working) {
      actions.appendChild(actionButton(doc, 'Cancel', 'disconnect-button', [SIDE_PANEL_DISCONNECT_ATTR, 'cancel'],
        handlers.onCancel));
    }
    block.appendChild(actions);
  }
  if (state.message !== '') {
    const message = doc.createElement('p');
    message.className = 'disconnect-message';
    message.setAttribute(SIDE_PANEL_DISCONNECT_MESSAGE_ATTR, '');
    message.setAttribute('role', 'status');
    message.textContent = state.message;
    block.appendChild(message);
  }
  return block;
};

export const renderServerStatusSection = (
  doc: Document,
  frame: SidePanelStatusFrame,
  now: number,
  opts?: { disconnect?: SidePanelDisconnectState; onDisconnect?: DisconnectHandlers; serverName?: string },
): HTMLElement => {
  const { section, body } = buildSectionShell(doc, 'server-status', 'Server status');
  const disconnectBlock = (): void => {
    if (opts?.disconnect === undefined) return;
    body.appendChild(renderDisconnect(doc, opts.disconnect, opts.onDisconnect ?? {}, opts.serverName ?? 'your server'));
  };
  if (frame.status === null) {
    // `bridge_connecting` is the service worker saying its socket is still
    // coming up — a wait, not a failure. It once surfaced as the raw
    // transport error, in red, on every first open after pairing.
    const connecting = frame.error === BRIDGE_STATUS_CONNECTING;
    body.appendChild(
      emptyCard(
        doc,
        connecting
          ? 'Connecting to your server…'
          : frame.error
            ? `Could not load status: ${frame.error}`
            : 'Loading server status…',
        frame.error && !connecting ? 'danger' : 'neutral',
      ),
    );
    disconnectBlock();
    return section;
  }
  const s = frame.status;
  const card = doc.createElement('div');
  card.className = 'card';

  // D-169 P3.2 — connectedness hero. The WS state is the section's primary
  // signal, so it leads the card as a prominent pill with the server name
  // beside it (the rest are secondary k/v rows). Offline is the one place
  // this section uses the single danger hue (`.pill-danger`); serving /
  // idle stay hue-free (label + weight only, D-174).
  const hero = doc.createElement('div');
  hero.className = 'status-hero';
  const pill = doc.createElement('span');
  pill.className =
    s.ws_state === 'serving'
      ? 'pill pill-ok'
      : s.ws_state === 'offline'
        ? 'pill pill-danger'
        : 'pill';
  pill.textContent =
    s.ws_state === 'serving'
      ? `Serving ${s.paired_client_connected}/${s.paired_client_count}`
      : s.ws_state === 'idle'
        ? `Idle — ${s.paired_client_count} paired`
        : 'Offline';
  hero.appendChild(pill);
  const heroName = doc.createElement('span');
  heroName.className = 'status-hero-name';
  heroName.textContent = s.name;
  hero.appendChild(heroName);
  card.appendChild(hero);

  appendRow(doc, card, 'Version', s.version, 'version');
  appendRow(doc, card, 'Uptime', formatSeconds(s.uptime_seconds), 'uptime');
  appendRow(
    doc,
    card,
    'Last sync',
    formatRelative(s.last_sync_at, now),
    'last-sync',
  );
  appendRow(
    doc,
    card,
    'Executions (1h / 24h)',
    `${formatCount(s.executions_last_hour)} / ${formatCount(s.executions_last_24h)}`,
    'executions',
  );
  appendRow(
    doc,
    card,
    'Pending asks',
    formatCount(s.pending_asks),
    'pending-asks',
  );
  appendRow(
    doc,
    card,
    'Approval load',
    formatAskLoad(s.ask_load),
    'ask-load',
  );
  appendRow(
    doc,
    card,
    'Scheduler queue',
    formatCount(s.schedule_queue_depth),
    'schedule-queue',
  );
  appendRow(
    doc,
    card,
    'Recent errors',
    formatCount(s.recent_error_count),
    'recent-errors',
  );
  // D-212 §7.10 — the standing keyfile-sealing posture.
  //
  // ⛔ `'none'` is NOT `null` and must not render like one. `null` is the
  // not-wired case every counter above uses (`—`); `'none'` means the key that
  // opens this realm sits readable beside its database. They are the same width
  // on screen and opposite in meaning.
  //
  // 🔑 This row IS the floor. D-212 §7.9 used to refuse enrollment on an
  // unsealed keyfile; §7.10 retracted that (it fired on essentially every
  // headless Linux install and its own prescribed remedy bricked the server)
  // and replaced it with visibility — an operator may run unsealed, but not
  // without knowing. Rendering this as "—" would remove the replacement and
  // leave nothing in place of either.
  appendRow(doc, card, 'Keyfile', formatKeyfileSealing(s.keyfile_sealing), 'keyfile-sealing');
  body.appendChild(card);

  if (s.keyfile_sealing === 'none') {
    // The consequence, not just the state. A label alone tells an operator
    // their keyfile is "unsealed" without telling them what that costs.
    const warn = doc.createElement('div');
    warn.className = 'empty';
    warn.setAttribute(SIDE_PANEL_STATUS_VALUE_ATTR, 'keyfile-sealing-warning');
    // ⚠ The remedy WITH its price. The earlier one-liner stopped at "set the
    // passphrase and run recover-keyfile", which reads far cheaper than it
    // is: regeneration mints a NEW server identity (the keyfile also holds
    // `server_identity`, `publisher_identity` and the D-175 account binding),
    // so it re-pairs every device — including the bridge reading this.
    warn.textContent =
      'Anyone who copies this server’s data directory gets the keys to your '
      + 'realm along with it. To seal it: set RECUED_IDENTITY_PASSPHRASE, then '
      + 'run ‘recued recover-keyfile’ with your 24-word recovery key. That '
      + 're-creates the server identity — every paired device, this one '
      + 'included, must pair again, the publisher identity changes, and the '
      + 'account binding is lost. Your data is untouched.';
    body.appendChild(warn);
  }

  if (frame.fetched_at !== null) {
    const refreshed = doc.createElement('div');
    refreshed.className = 'empty';
    refreshed.textContent = `Refreshed ${formatRelative(frame.fetched_at, now)}`;
    body.appendChild(refreshed);
  }
  disconnectBlock();
  return section;
};

// ════════════════════════════════════════════════════════════════
// Section 2 — Recipe results (always-on, pure-read)
// ════════════════════════════════════════════════════════════════

const RECIPE_STATUS_LABEL: Record<'ok' | 'error' | 'paused', string> = {
  ok: 'OK',
  error: 'Error',
  paused: 'Paused',
};

/** D-169 P3.3 — recipe-run status → chip class. D-174 colour discipline:
 *  only `error` carries the single danger hue (`.pill-danger`); `ok` is a
 *  weighted-but-hue-free chip (`.pill-ok`); `paused` is a plain neutral
 *  pill. A failed run is the one thing in this section that earns red. */
const RECIPE_STATUS_PILL_CLASS: Record<'ok' | 'error' | 'paused', string> = {
  ok: 'pill pill-ok',
  error: 'pill pill-danger',
  paused: 'pill',
};

/** D-169 P3.3 — one recipe-run row: the recipe id on the left (ellipsis-
 *  truncated, full id on hover via `title`), a status chip + timing cluster
 *  on the right, and the failure category as a muted sub-line beneath error
 *  rows. The chip is the only place a failure shows the danger hue; ok /
 *  paused stay hue-free. All text goes through `textContent` (inert). */
const appendRecipeRow = (
  doc: Document,
  card: HTMLElement,
  item: SidePanelStoreState['recipe_results']['items'][number],
  now: number,
): void => {
  const row = doc.createElement('div');
  row.className = 'row';
  row.setAttribute(SIDE_PANEL_LIST_ITEM_ATTR, 'recipe-results');

  const id = doc.createElement('span');
  id.className = 'k recipe-id';
  id.textContent = item.recipe_id;
  // Full id on hover — the truncation is visual only (CSS ellipsis).
  id.setAttribute('title', item.recipe_id);
  row.appendChild(id);

  const meta = doc.createElement('span');
  meta.className = 'run-meta';
  const chip = doc.createElement('span');
  chip.className = RECIPE_STATUS_PILL_CLASS[item.status];
  chip.textContent = RECIPE_STATUS_LABEL[item.status];
  meta.appendChild(chip);
  const timing = doc.createElement('span');
  timing.className = 'v';
  const timeParts: string[] = [];
  if (item.duration_ms !== null) {
    timeParts.push(formatSeconds(item.duration_ms / 1000));
  }
  timeParts.push(formatRelative(item.started_at, now));
  timing.textContent = timeParts.join(' · ');
  meta.appendChild(timing);
  row.appendChild(meta);

  card.appendChild(row);

  if (item.error_category) {
    const sub = doc.createElement('div');
    sub.className = 'subtle';
    sub.textContent = item.error_category;
    card.appendChild(sub);
  }
};

export const renderRecipeResultsSection = (
  doc: Document,
  frame: SidePanelStoreState['recipe_results'],
  now: number,
): HTMLElement => {
  const { section, body } = buildSectionShell(
    doc,
    'recipe-results',
    'Recent runs',
  );
  if (frame.error) {
    body.appendChild(emptyCard(doc, `Could not load: ${frame.error}`, 'danger'));
  } else if (frame.items.length === 0) {
    body.appendChild(
      emptyCard(
        doc,
        frame.fetched_at === null
          ? 'Loading recent runs…'
          : 'No recent recipe runs yet. Recent executions land here.',
      ),
    );
  } else {
    const card = doc.createElement('div');
    card.className = 'card';
    for (const item of frame.items) appendRecipeRow(doc, card, item, now);
    body.appendChild(card);
  }
  return section;
};

// ════════════════════════════════════════════════════════════════
// Section 2.5 — Active executions (D-181 slice 6a)
// ════════════════════════════════════════════════════════════════

/** D-181 slice 6a — entry-state → display label (mirrors the webclient Runs
 *  "Active" section so the two surfaces read the same). */
const ACTIVE_STATE_LABEL: Record<ActiveExecutionEntry['state'], string> = {
  running: 'Running',
  waiting_slot: 'Queued',
  detached: 'Detached',
  stopping: 'Stopping…',
};

/** The id a control button targets: a queued-call cancels / promotes by its
 *  `queued_call_id`; a run / detached-job kills by `run_id`. Falls back across
 *  the two so a row always renders even if one id is briefly absent (the live
 *  feed can carry a queued-call before its run_id threads down). */
const activeControlId = (entry: ActiveExecutionEntry): string =>
  entry.entry_kind === 'queued-call'
    ? entry.queued_call_id ?? entry.run_id ?? ''
    : entry.run_id ?? '';

const activeEntryTitle = (entry: ActiveExecutionEntry): string =>
  entry.step_id !== undefined && entry.step_id.length > 0
    ? `${entry.recipe_id} · ${entry.step_id}`
    : entry.recipe_id;

/** Append one live-control button to a row's controls cluster, wiring its click
 *  to the host `onControl` (same guard as the watch-CTA button: the pure-render
 *  test fake has no `addEventListener`, so only attach when present). */
const appendActiveControl = (
  doc: Document,
  controls: HTMLElement,
  action: ActiveControlAction,
  id: string,
  label: string,
  onControl: ActiveControlHandler,
): void => {
  const button = doc.createElement('button');
  button.className =
    action === 'promote' ? 'active-control' : 'active-control active-control-danger';
  button.setAttribute('type', 'button');
  button.setAttribute(SIDE_PANEL_ACTIVE_CONTROL_ATTR, action);
  button.textContent = label;
  if (typeof button.addEventListener === 'function') {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      const originalLabel = button.textContent;
      button.textContent =
        action === 'kill'
          ? 'Stopping…'
          : action === 'cancel'
            ? 'Cancelling…'
            : 'Promoting…';
      void Promise.resolve(onControl(action, id))
        .catch(() => {
          // Production maps failures to a store-backed notice. Keep an
          // injected rejecting handler from surfacing as an unhandled promise.
        })
        .finally(() => {
          button.disabled = false;
          button.setAttribute('aria-busy', 'false');
          button.textContent = originalLabel;
        });
    });
  }
  controls.appendChild(button);
};

/** D-181 slice 6a — one active-executions row: the recipe (· step) on the
 *  left, a state / origin / elapsed / stalled meta cluster on the right, and —
 *  when control is wired (approval-mode bridge) — Promote / Cancel (queued) or
 *  Kill (running) buttons beneath. All text is `textContent` (inert). */
const appendActiveRow = (
  doc: Document,
  card: HTMLElement,
  entry: ActiveExecutionEntry,
  now: number,
  onControl: ActiveControlHandler | undefined,
): void => {
  const row = doc.createElement('div');
  row.className = 'row';
  row.setAttribute(SIDE_PANEL_LIST_ITEM_ATTR, 'active-executions');
  row.setAttribute(SIDE_PANEL_ACTIVE_ROW_ATTR, activeControlId(entry));

  const k = doc.createElement('span');
  k.className = 'k recipe-id';
  k.textContent = activeEntryTitle(entry);
  k.setAttribute('title', activeEntryTitle(entry));
  row.appendChild(k);

  const v = doc.createElement('span');
  v.className = 'v';
  const sinceTs = entry.slot_acquired_at ?? entry.started_at;
  const metaParts: string[] = [ACTIVE_STATE_LABEL[entry.state], entry.origin];
  if (Number.isFinite(now) && now >= sinceTs) {
    metaParts.push(formatSeconds((now - sinceTs) / 1000));
  }
  if (entry.progress.stalled === true) metaParts.push('stalled');
  v.textContent = metaParts.join(' · ');
  row.appendChild(v);
  card.appendChild(row);

  if (onControl === undefined) return;
  const id = activeControlId(entry);
  if (id === '') return;
  const controls = doc.createElement('div');
  controls.className = 'active-controls';
  if (entry.entry_kind === 'queued-call' && entry.queued_call_id !== undefined) {
    appendActiveControl(doc, controls, 'promote', id, 'Promote', onControl);
    appendActiveControl(doc, controls, 'cancel', id, 'Cancel', onControl);
  } else if (entry.run_id !== undefined && entry.run_id.length > 0) {
    appendActiveControl(doc, controls, 'kill', id, 'Kill', onControl);
  }
  // Only append the cluster if it actually got a button (a queued-call with no
  // queued_call_id and no run_id yields neither — leave the row control-less).
  if (controls.children.length > 0) card.appendChild(controls);
};

/** D-181 slice 6a — the live active-executions section: a read-only mirror of
 *  `execution.active` (runs + queued calls + per-lane occupancy), with
 *  kill / cancel / promote buttons routed to the server ONLY when `onControl`
 *  is wired — which the mount supplies iff this bridge holds
 *  `bridge_mode.approval` (§8: a non-approval bridge VIEWS the list but cannot
 *  mutate the queue; the server re-checks the same gate, fail-closed). */
export const renderActiveExecutionsSection = (
  doc: Document,
  frame: SidePanelStoreState['active'],
  now: number,
  opts?: { onControl?: ActiveControlHandler },
): HTMLElement => {
  const { section, body } = buildSectionShell(
    doc,
    'active-executions',
    'Active executions',
  );

  // A non-terminal control verdict (e.g. "that run already finished") rendered
  // above the list so a no-op click is legible rather than silent.
  if (frame.notice !== '') {
    const notice = doc.createElement('div');
    notice.className = 'subtle';
    notice.setAttribute(SIDE_PANEL_ACTIVE_NOTICE_ATTR, '');
    notice.textContent = frame.notice;
    body.appendChild(notice);
  }

  if (frame.error) {
    body.appendChild(emptyCard(doc, `Could not load: ${frame.error}`, 'danger'));
    return section;
  }

  // Per-lane occupancy line ("local-heavy 2/2 · 1 queued, oldest 12m"), shown
  // whenever any lane has occupancy or a queue (an all-idle server omits it).
  const busyLanes = frame.lanes.filter(
    (lane) => lane.in_use > 0 || lane.queued > 0,
  );
  if (busyLanes.length > 0) {
    const laneCard = doc.createElement('div');
    laneCard.className = 'card';
    for (const lane of busyLanes) {
      const row = doc.createElement('div');
      row.className = 'row';
      row.setAttribute(SIDE_PANEL_ACTIVE_LANE_ATTR, lane.lane);
      const k = doc.createElement('span');
      k.className = 'k';
      k.textContent = lane.lane;
      const v = doc.createElement('span');
      v.className = 'v';
      const queuedPart =
        lane.queued > 0
          ? ` · ${lane.queued} queued, oldest ${formatSeconds(lane.oldest_wait_ms / 1000)}`
          : '';
      v.textContent = `${lane.in_use}/${lane.capacity}${queuedPart}`;
      row.appendChild(k);
      row.appendChild(v);
      laneCard.appendChild(row);
    }
    body.appendChild(laneCard);
  }

  if (frame.entries.length === 0) {
    body.appendChild(
      emptyCard(
        doc,
        frame.fetched_at === null
          ? 'Loading active executions…'
          : 'Nothing running. Active runs and queued calls land here.',
      ),
    );
    return section;
  }

  const card = doc.createElement('div');
  card.className = 'card';
  for (const entry of frame.entries) {
    appendActiveRow(doc, card, entry, now, opts?.onControl);
  }
  body.appendChild(card);
  return section;
};

// ════════════════════════════════════════════════════════════════
// Section 3 — Notifications (P1: empty state)
// ════════════════════════════════════════════════════════════════

/** D-163 O-1 — what the Notifications section says while Chrome has notifications from this
 *  extension turned off: nothing it sends reaches the desktop, reminders and approvals
 *  included, however the Notify switch is set. */
export const DESKTOP_NOTIFICATIONS_BLOCKED_COPY =
  'Chrome has notifications from Recued Bridge turned off, so reminders and approvals do not '
  + 'appear on your desktop. To see them, allow Recued Bridge in your notification settings.';

export const renderNotificationsSection = (
  doc: Document,
  frame: SidePanelStoreState['notifications'],
  now: number,
  opts?: { enabled?: boolean; desktopBlocked?: boolean },
): HTMLElement => {
  const { section, body } = buildSectionShell(
    doc,
    'notifications',
    'Notifications',
  );
  // D-169 P4 — notifications are an OPTIONAL surface gated by THIS bridge's
  // server-set mode (`bridge_mode.notification`, configured in the webclient;
  // the Bridge never writes it). When off, the section stays VISIBLE with a
  // read-only affordance instead of vanishing (owner decision — mirrors the
  // approvals empty-card precedent; nothing silently disappears). Live items /
  // load errors are suppressed while off — nothing surfaces here. `enabled`
  // omitted ⇒ render normally (the renderer default; the mount always passes
  // the flag explicitly, which is `false` until the self-scoped mode fetch
  // lands — fail-closed). Server status + recipe results stay always-on.
  const notifications = notificationsBody({
    enabled: opts?.enabled,
    error: frame.error,
    itemCount: frame.items.length,
    loading: frame.fetched_at === null,
  });
  if (notifications === 'off') {
    body.appendChild(
      emptyCard(
        doc,
        'Notifications are off for this bridge — turn them on in the webclient.',
      ),
    );
    return section;
  }
  // D-163 O-1 — on, but Chrome shows none of them: say so first, since the list below would
  // otherwise read as notifications the owner saw.
  if (opts?.desktopBlocked === true) {
    const blocked = emptyCard(doc, DESKTOP_NOTIFICATIONS_BLOCKED_COPY, 'danger');
    blocked.setAttribute(SIDE_PANEL_STATUS_VALUE_ATTR, 'desktop-notifications-blocked');
    body.appendChild(blocked);
  }
  if (frame.error) {
    body.appendChild(emptyCard(doc, `Could not load: ${frame.error}`, 'danger'));
  } else if (frame.items.length === 0) {
    body.appendChild(
      emptyCard(
        doc,
        frame.fetched_at === null
          ? 'Loading notifications…'
          : 'Nothing to show yet. Notifications fan out here.',
      ),
    );
  } else {
    const card = doc.createElement('div');
    card.className = 'card';
    for (const item of frame.items) {
      // When a (non-blank) title is present it's the primary line + the
      // body text renders beneath; otherwise the text IS the primary line.
      const title = nonBlankTitle(item.title);
      const primary = title ?? item.text;
      const secondary = title ? [item.text] : undefined;
      appendListItem(
        doc,
        card,
        'notifications',
        primary,
        formatRelative(item.fired_at, now),
        secondary,
      );
    }
    body.appendChild(card);
  }
  return section;
};

// ════════════════════════════════════════════════════════════════
// Section 4 — Approvals (P1: empty state)
// ════════════════════════════════════════════════════════════════

export const renderApprovalsSection = (
  doc: Document,
  frame: SidePanelStoreState['approvals'],
  now: number,
  opts?: { onAnswer?: ApprovalAnswerHandler },
): HTMLElement => {
  const { section, heading, body } = buildSectionShell(doc, 'approvals', 'Approvals');
  // 2026-11-04 — how many wait, beside the title, now that approvals lead the panel.
  if (frame.items.length > 0) {
    const count = doc.createElement('span');
    count.className = 'section-count';
    count.textContent = String(frame.items.length);
    count.setAttribute('aria-label', `${frame.items.length} waiting`);
    heading.appendChild(count);
  }
  const approvals = approvalsBody({
    error: frame.error,
    itemCount: frame.items.length,
    loading: frame.fetched_at === null,
    canAnswer: opts?.onAnswer !== undefined,
  });
  if (approvals === 'error') {
    body.appendChild(emptyCard(doc, `Could not load: ${frame.error}`, 'danger'));
  } else if (approvals === 'empty') {
    body.appendChild(emptyCard(doc, 'No pending approvals.'));
  } else if (approvals === 'loading' || approvals === 'empty-opt-in') {
    body.appendChild(
      emptyCard(
        doc,
        approvals === 'loading'
          ? 'Loading approvals…'
          : 'No pending approvals. Enable Approval mode in Settings → Notifications to opt in.',
      ),
    );
  } else if (approvals === 'interactive' && opts?.onAnswer) {
    // D-169 P2 Slice 3 — interactive approval cards. Each open ask renders
    // via the shared `@recued/ui-shared` approval card (I-12 — the same
    // primitive the webclient consumes; no per-client copy). Clicking an
    // option submits it through the host `onAnswer`, which round-trips to
    // the SW → `notification.submitAnswer` rpc. The block dedups
    // first-answer-wins across surfaces (D-158 I-6); the answered ask drops
    // out on the next `notification.ask_closed` bus frame + history
    // re-fetch (the mount rebuilds on every store change).
    const onAnswer = opts.onAnswer;
    for (const item of frame.items) {
      body.appendChild(
        renderAskCard(
          doc,
          item,
          {
            // ⚠ THE THIRD ARGUMENT IS OMITTED when there is no note, not passed
            // as `undefined` — the same rule the card itself follows. Forwarding
            // an explicit `undefined` changes `toHaveBeenCalledWith(id, opt)` for
            // every existing consumer, which is a silent behaviour change to every
            // Bridge approval card to carry a field they do not have. A shipped
            // test caught it here too.
            onAnswer: (optionId, note) => (note === undefined
              ? onAnswer(item.ask_id, optionId)
              : onAnswer(item.ask_id, optionId, note)),
          },
          // The section's clock, not the card's `Date.now()` fallback: the age
          // must agree with every other relative time on this panel. Omitted,
          // the store screenshots — rendered at a FIXED clock — said
          // "Waiting 6w" beside "4m ago", aging by the day they were built.
          { now },
        ),
      );
    }
  } else {
    // Read-only fallback when no submit handler is wired — surfaces the ask
    // + its option labels so the user sees what's pending. Kept for the
    // empty/error render-path tests and any future approval-mode-off
    // context (per-bridge mode gating is Slice 4).
    const card = doc.createElement('div');
    card.className = 'card';
    for (const item of frame.items) {
      const title = nonBlankTitle(item.title);
      const primary = title ?? item.text;
      const secondary: string[] = [];
      if (title) secondary.push(item.text);
      if (item.options.length > 0) {
        secondary.push(`Options: ${item.options.map((o) => o.label).join(' / ')}`);
      }
      appendListItem(
        doc,
        card,
        'approvals',
        primary,
        formatRelative(item.created_at, now),
        secondary,
      );
    }
    body.appendChild(card);
  }
  return section;
};

// ════════════════════════════════════════════════════════════════
// Section 5 — Bridge diagnostic (collapsible)
// ════════════════════════════════════════════════════════════════

export const renderBridgeDiagnosticSection = (
  doc: Document,
  frame: SidePanelDiagnosticFrame,
  opts?: { onRefresh?: () => void; onCopy?: () => void; copyState?: DiagnosticSummaryCopyState },
): HTMLElement => {
  const section = doc.createElement('section');
  section.setAttribute(SIDE_PANEL_SECTION_ATTR, 'bridge-diagnostic');
  section.setAttribute('aria-busy', String(frame.refreshing));
  const details = doc.createElement('details');
  const summary = doc.createElement('summary');
  const unresolved = frame.unresolved;
  summary.textContent = unresolved && unresolved.count > 0
    ? `Bridge diagnostic · ${unresolved.count} awaiting confirmation` : 'Bridge diagnostic';
  details.appendChild(summary);

  const controls = doc.createElement('div');
  controls.className = 'diagnostic-controls';
  const freshness = doc.createElement('div');
  freshness.className = 'diagnostic-freshness subtle';
  const freshnessLabel = doc.createElement('span');
  freshnessLabel.textContent = 'Last successful refresh: ';
  freshness.appendChild(freshnessLabel);
  if (frame.last_successful_refresh_at !== null) {
    const timestamp = doc.createElement('time');
    const date = new Date(frame.last_successful_refresh_at);
    timestamp.textContent = date.toLocaleString();
    timestamp.setAttribute('datetime', date.toISOString());
    freshness.appendChild(timestamp);
  } else {
    const never = doc.createElement('span');
    never.textContent = 'Never';
    freshness.appendChild(never);
  }
  controls.appendChild(freshness);
  const refresh = doc.createElement('button');
  refresh.type = 'button';
  refresh.className = 'diagnostic-refresh';
  refresh.setAttribute(SIDE_PANEL_DIAGNOSTIC_REFRESH_ATTR, '');
  refresh.setAttribute('aria-label', 'Refresh Bridge diagnostics');
  // Keep keyboard focus through in-flight renders while refusing another
  // click. The entry coalesces this read with polling and invalidations.
  refresh.setAttribute('aria-disabled', String(frame.refreshing || !opts?.onRefresh));
  refresh.textContent = frame.refreshing ? 'Refreshing…' : 'Refresh';
  if (opts?.onRefresh) {
    refresh.addEventListener('click', () => {
      if (!frame.refreshing) opts.onRefresh?.();
    });
  }
  const actions = doc.createElement('div');
  actions.className = 'diagnostic-actions';
  actions.appendChild(refresh);
  const copyState = opts?.copyState;
  const copy = doc.createElement('button');
  copy.type = 'button';
  copy.className = 'diagnostic-refresh diagnostic-copy';
  copy.setAttribute(SIDE_PANEL_DIAGNOSTIC_COPY_ATTR, '');
  copy.setAttribute('aria-disabled', String(copyState?.phase === 'copying' || !opts?.onCopy));
  copy.textContent = copyState?.phase === 'copying' ? 'Copying…' : 'Copy diagnostic summary';
  if (opts?.onCopy) copy.addEventListener('click', () => { if (copyState?.phase !== 'copying') opts.onCopy?.(); });
  actions.appendChild(copy);
  controls.appendChild(actions);
  details.appendChild(controls);
  const copyNotice = doc.createElement('p');
  copyNotice.className = 'diagnostic-copy-notice subtle';
  copyNotice.setAttribute('role', 'status');
  copyNotice.setAttribute('aria-live', 'polite');
  copyNotice.textContent = copyState?.phase === 'copying' ? 'Copying diagnostic summary…'
    : copyState?.phase === 'copied' ? 'Diagnostic summary copied.'
      : copyState?.phase === 'manual' ? 'Could not copy automatically. Select and copy the summary below.'
        : 'Copies a summary of the displayed diagnostics.';
  details.appendChild(copyNotice);
  if (copyState?.phase === 'manual') {
    const summary = doc.createElement('textarea');
    summary.className = 'diagnostic-summary';
    summary.setAttribute(SIDE_PANEL_DIAGNOSTIC_SUMMARY_ATTR, '');
    summary.setAttribute('aria-label', 'Diagnostic summary');
    summary.setAttribute('readonly', '');
    summary.setAttribute('spellcheck', 'false');
    summary.textContent = copyState.summary;
    details.appendChild(summary);
  }
  const notice = doc.createElement('p');
  notice.className = frame.refresh_error ? 'diagnostic-notice diagnostic-notice-error' : 'diagnostic-notice subtle';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.textContent = frame.refreshing ? 'Refreshing diagnostics…'
    : frame.refresh_error ?? (frame.last_successful_refresh_at === null ? 'Diagnostics have not been refreshed yet.' : '');
  details.appendChild(notice);

  const card = doc.createElement('div');
  card.className = 'card';
  appendRow(
    doc,
    card,
    'Saved command results',
    formatCount(frame.idempotency_entry_count),
    'idempotency',
  );
  appendRow(doc, card, 'Awaiting confirmation', unresolved === null ? 'Unavailable' : String(unresolved.count), 'unresolved');
  appendRow(
    doc,
    card,
    'Queued commands',
    frame.pending_command_count === null ? 'Unavailable' : String(frame.pending_command_count),
    'queued-commands',
  );
  appendRow(doc, card, 'Current command', frame.queue_paused === null ? 'Unavailable' : frame.current_command_id ?? 'None', 'current-command');
  appendRow(doc, card, 'Queue state', frame.queue_paused === null ? 'Unavailable' : frame.queue_paused ? 'Paused' : 'Ready', 'queue-state');
  appendRow(
    doc,
    card,
    'Ingredient grants',
    formatCount(frame.grant_count),
    'grants',
  );
  details.appendChild(card);
  const pending = doc.createElement('div');
  pending.className = 'card unresolved-commands';
  const guidance = doc.createElement('p');
  guidance.className = 'subtle';
  guidance.textContent = unresolved === null ? 'Commands awaiting confirmation could not be loaded.'
    : unresolved.count === 0 ? 'No commands are awaiting confirmation.'
      : 'These commands have no confirmed outcome. Check the page before starting them again.';
  pending.appendChild(guidance);
  for (const entry of unresolved?.entries ?? []) {
    const row = doc.createElement('div');
    row.className = 'unresolved-command';
    row.setAttribute('data-recued-unresolved-command', '');
    const id = doc.createElement('code');
    id.textContent = entry.command_id;
    const started = doc.createElement('time');
    const date = new Date(entry.started_at);
    started.textContent = Number.isFinite(date.getTime()) ? `Started ${date.toLocaleString()}` : 'Start time unavailable';
    if (Number.isFinite(date.getTime())) started.setAttribute('datetime', date.toISOString());
    row.appendChild(id); row.appendChild(started); pending.appendChild(row);
  }
  if (unresolved && unresolved.count > unresolved.entries.length) {
    const more = doc.createElement('p');
    more.className = 'subtle';
    more.textContent = `Showing ${unresolved.entries.length} of ${unresolved.count} commands, ordered by command ID.`;
    pending.appendChild(more);
  }
  details.appendChild(pending);
  const confirmed = frame.recent_confirmed;
  const recent = doc.createElement('div');
  recent.className = 'card confirmed-outcomes';
  const heading = doc.createElement('h3');
  heading.textContent = 'Recent confirmed outcomes';
  recent.appendChild(heading);
  const note = doc.createElement('p');
  note.className = 'subtle';
  note.textContent = confirmed === null ? 'Recent confirmed outcomes could not be loaded.'
    : confirmed.count === 0 ? 'No confirmed outcomes are saved.'
      : 'Saved outcomes expire after 24 hours. Times show when results were recorded.';
  recent.appendChild(note);
  const labels = { ok: 'Completed', error: 'Failed', rejected: 'Rejected' };
  for (const entry of confirmed?.entries ?? []) {
    const row = doc.createElement('div');
    row.className = 'confirmed-command';
    row.setAttribute('data-recued-confirmed-command', '');
    const id = doc.createElement('code');
    id.textContent = entry.command_id;
    const status = doc.createElement('span');
    status.className = 'confirmed-status';
    status.textContent = labels[entry.status];
    const recorded = doc.createElement('time');
    const date = new Date(entry.stored_at);
    recorded.textContent = Number.isFinite(date.getTime()) ? `Recorded ${date.toLocaleString()}` : 'Recorded time unavailable';
    if (Number.isFinite(date.getTime())) recorded.setAttribute('datetime', date.toISOString());
    row.appendChild(id); row.appendChild(status); row.appendChild(recorded);
    const explanation = confirmedOutcomeGuidance(entry);
    if (explanation) {
      const cause = doc.createElement('p');
      cause.className = 'confirmed-error-cause';
      cause.setAttribute('data-recued-confirmed-error-cause', '');
      cause.textContent = explanation.cause;
      const next = doc.createElement('p');
      next.className = 'confirmed-error-hint';
      next.setAttribute('data-recued-confirmed-next-step', '');
      next.textContent = `Next step: ${explanation.next_step}`;
      row.appendChild(cause); row.appendChild(next);
      if (explanation.error_code) {
        const code = doc.createElement('code');
        code.className = 'confirmed-error-code';
        code.setAttribute('data-recued-confirmed-error-code', '');
        code.textContent = `Error code: ${explanation.error_code}`;
        row.appendChild(code);
      }
    }
    recent.appendChild(row);
  }
  if (confirmed && confirmed.count > 0) {
    const more = doc.createElement('p');
    more.className = 'subtle';
    more.textContent = `Showing ${confirmed.entries.length} of ${confirmed.count} confirmed outcomes, newest recorded first.`;
    recent.appendChild(more);
  }
  details.appendChild(recent);
  section.appendChild(details);
  return section;
};
