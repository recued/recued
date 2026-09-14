/** Server profile list — the roster rows, for embedding in the account menu.
 *
 *  ── The design constraint ───────────────────────────────────────────────
 *  The case this exists for is "my server is offline". Anything behind a
 *  Settings page is unreachable in that state, because every Server settings
 *  panel is driven by rpc against the server that just went away. So this
 *  reads ONLY the local profile roster — no rpc, no network, no server
 *  round-trip — and is fully usable with nothing running on the other end.
 *  Everything else follows from that.
 *
 *  ── Why it owns no trigger ──────────────────────────────────────────────
 *  It renders rows into a host and nothing more. The account menu owns the
 *  trigger, the badge, and the open/close behaviour, so this stays a list
 *  that can be dropped into any container — and the scroll bound belongs to
 *  that container, not here.
 *
 *  ── What it does not do ─────────────────────────────────────────────────
 *  It does not connect, pair, or write storage. It renders the roster and
 *  reports intent (`onSwitch` / `onRename` / `onRemove`); the caller owns
 *  persistence and the re-bootstrap. Keeping the mount free of storage lets
 *  the interaction be tested against a fake DOM with plain callbacks.
 *
 *  ── Pending profiles ────────────────────────────────────────────────────
 *  A profile with no URL yet (`server_profiles.isPendingProfile`) is roster
 *  bookkeeping, not a destination, and is filtered out before render — an
 *  unclickable row is worse than no row.
 */

import type { WebclientServerProfile } from '@recued/contracts';
import { validLastConnectedAt } from '../storage/server-profiles.js';
import type { ServerSwitchActiveWork } from './server-switch-work-tracker.js';

export const SERVER_SWITCHER_ATTR = 'data-recued-server-switcher';
export const SERVER_SWITCHER_MENU_ATTR = 'data-recued-server-switcher-menu';
export const SERVER_SWITCHER_ITEM_ATTR = 'data-recued-server-switcher-item';
export const SERVER_SWITCHER_CURRENT_ATTR = 'data-recued-server-switcher-current';
export const SERVER_SWITCHER_RECENCY_ATTR = 'data-recued-server-switcher-recency';
export const SERVER_SWITCHER_SWITCH_CONFIRM_ATTR =
  'data-recued-server-switcher-switch-confirm';
export const SERVER_SWITCHER_SWITCH_COMMIT_ATTR =
  'data-recued-server-switcher-switch-commit';
export const SERVER_SWITCHER_SWITCH_CANCEL_ATTR =
  'data-recued-server-switcher-switch-cancel';
export const SERVER_SWITCHER_SWITCH_ERROR_ATTR =
  'data-recued-server-switcher-switch-error';
export const SERVER_SWITCHER_ACTIVE_WORK_ATTR =
  'data-recued-server-switcher-active-work';
export const SERVER_SWITCHER_ACTIVE_WORK_ITEM_ATTR =
  'data-recued-server-switcher-active-work-item';
export const SERVER_SWITCHER_RETURN_TO_WORK_ATTR =
  'data-recued-server-switcher-return-to-work';
export const SERVER_SWITCHER_RENAME_ATTR = 'data-recued-server-switcher-rename';
export const SERVER_SWITCHER_RENAME_FORM_ATTR =
  'data-recued-server-switcher-rename-form';
export const SERVER_SWITCHER_RENAME_INPUT_ATTR =
  'data-recued-server-switcher-rename-input';
export const SERVER_SWITCHER_RENAME_SAVE_ATTR =
  'data-recued-server-switcher-rename-save';
export const SERVER_SWITCHER_RENAME_CANCEL_ATTR =
  'data-recued-server-switcher-rename-cancel';
export const SERVER_SWITCHER_RENAME_ERROR_ATTR =
  'data-recued-server-switcher-rename-error';
export const SERVER_SWITCHER_ANNOUNCER_ATTR =
  'data-recued-server-switcher-announcer';
export const SERVER_SWITCHER_REMOVE_ATTR = 'data-recued-server-switcher-remove';
export const SERVER_SWITCHER_REMOVE_CONFIRM_ATTR =
  'data-recued-server-switcher-remove-confirm';
export const SERVER_SWITCHER_REMOVE_LOCAL_ATTR =
  'data-recued-server-switcher-remove-local';
export const SERVER_SWITCHER_REMOVE_REVOKE_ATTR =
  'data-recued-server-switcher-remove-revoke';
export const SERVER_SWITCHER_REMOVE_CANCEL_ATTR =
  'data-recued-server-switcher-remove-cancel';
export const SERVER_SWITCHER_REMOVE_STATUS_ATTR =
  'data-recued-server-switcher-remove-status';
export const SERVER_SWITCHER_REMOVE_ERROR_ATTR =
  'data-recued-server-switcher-remove-error';
export const SERVER_SWITCHER_EMPTY_ATTR = 'data-recued-server-switcher-empty';
export const SERVER_SWITCHER_STYLES_MARKER = 'data-recued-server-switcher-styles';

export const SERVER_PROFILE_LABEL_MAX_LENGTH = 80;

export type ServerProfileRemovalMode = 'local' | 'revoke';
export type ServerSwitchWorkState =
  | 'clean'
  | 'chat_draft'
  | 'unsaved_changes'
  | 'in_flight'
  | 'in_flight_with_chat_draft'
  | 'in_flight_with_unsaved_changes';

/** A server switch cannot prove whether an already-issued request reached the
 * source server. Keep that uncertainty explicit instead of describing it as a
 * normal discard. */
export const isInFlightServerSwitchWorkState = (
  state: ServerSwitchWorkState,
): boolean => state === 'in_flight'
  || state === 'in_flight_with_chat_draft'
  || state === 'in_flight_with_unsaved_changes';

export const serverSwitchWorkStateHasChatDraft = (
  state: ServerSwitchWorkState,
): boolean => state === 'chat_draft'
  || state === 'in_flight_with_chat_draft';

/** Whether the boundary the owner already reviewed covers a fresher route
 * state. Settling to clean is always safer; a newly-appearing draft, unsaved
 * edit, or unknown request outcome requires updated copy and another click. */
export const serverSwitchReviewCoversWorkState = (
  reviewed: ServerSwitchWorkState,
  current: ServerSwitchWorkState,
): boolean => {
  if (current === 'clean' || current === reviewed) return true;
  const reviewedInFlight = isInFlightServerSwitchWorkState(reviewed);
  const reviewedDraft = serverSwitchWorkStateHasChatDraft(reviewed);
  const reviewedUnsaved = reviewed === 'unsaved_changes'
    || reviewed === 'in_flight_with_unsaved_changes';
  const currentInFlight = isInFlightServerSwitchWorkState(current);
  const currentDraft = serverSwitchWorkStateHasChatDraft(current);
  const currentUnsaved = current === 'unsaved_changes'
    || current === 'in_flight_with_unsaved_changes';
  return (!currentInFlight || reviewedInFlight)
    && (!currentDraft || reviewedDraft)
    && (!currentUnsaved || reviewedUnsaved);
};

/** Settled work may disappear from a review, but every action that is active at
 * commit time must have been visible when the owner made the discard choice. */
export const serverSwitchReviewCoversActiveWork = (
  reviewed: ReadonlyArray<ServerSwitchActiveWork>,
  current: ReadonlyArray<ServerSwitchActiveWork>,
): boolean => {
  const reviewedIds = new Set(reviewed.map((work) => work.id));
  return current.every((work) => reviewedIds.has(work.id));
};

export interface MountProfileListOptions {
  /** Container the rows are appended to (the account menu's profile row). */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** The roster, already read from local storage. Re-read via `refresh()`. */
  profiles: ReadonlyArray<WebclientServerProfile>;
  activeProfileId: string | null;
  /** Switch to another profile. The caller persists + re-bootstraps; this
   *  list only reports the intent. */
  onSwitch: (
    id: string,
    reviewedWorkState: ServerSwitchWorkState,
    reviewedActiveWork?: ReadonlyArray<ServerSwitchActiveWork>,
  ) => void | Promise<void>;
  /** Re-read immediately before commit. A draft/editor can become dirty while
   *  the choice is open; a changed state is shown and must be confirmed again. */
  switchWorkState?: () => ServerSwitchWorkState;
  /** Named boot-scoped actions behind the coarse work-state boundary. */
  switchActiveWork?: () => ReadonlyArray<ServerSwitchActiveWork>;
  /** Leave the choice open only long enough to return to the exact source
   * route. The Account host closes itself before navigating. */
  onReturnToWork?: (href: string) => void;
  /** Fired when the ALREADY-active row is clicked. No switch happens; the
   *  container uses it to close, so the click still feels answered. */
  onSelectActive?: () => void;
  /** Mark the active row as unreachable. Only the active profile's state is
   *  ever known — the rest are unprobed. */
  activeUnreachable?: boolean;
  /** True only while the active profile has a live authenticated connection.
   *  Self-revocation is never offered against an unproved/offline server. */
  activeConnected?: boolean;
  /** Local clock used for relative recency labels. */
  now?: () => number;
  /** Persist a user-facing name for one profile. Omitted means the list stays
   *  read-only. Renaming never needs a live server. */
  onRename?: (
    id: string,
    label: string,
  ) => string | void | Promise<string | void>;
  /** Remove the local profile, optionally revoking this browser's server-side
   *  paired instance first. Omitted → no remove control. */
  onRemove?: (
    id: string,
    mode: ServerProfileRemovalMode,
  ) => void | Promise<void>;
}

export interface ProfileListMount {
  /** Re-render against a new roster (after a switch or removal), optionally
   *  updating whether the active server is currently reachable. */
  refresh(
    profiles: ReadonlyArray<WebclientServerProfile>,
    activeProfileId: string | null,
    activeUnreachable?: boolean,
    activeConnected?: boolean,
  ): void;
  /** Focus one exact saved profile without selecting it. Route-independent
   * handoffs use this to preserve the normal click + reviewed confirmation as
   * the deliberate server-switch boundary. */
  focusProfile(id: string): boolean;
  /** Distinguish a removed row from one temporarily disabled by an in-flight
   * profile operation before an external dialog handoff changes focus. */
  profileAvailability(id: string): 'available' | 'unavailable' | 'missing';
  /** Whether a reviewed profile mutation has crossed its commit boundary and
   * still owns the eventual result. External route landings must not close or
   * navigate underneath that operation. */
  hasInFlightAction(): boolean;
  /** Drop any idle switch/rename/removal review. In-flight work keeps
   *  ownership of its result even if the containing Account dialog closes. */
  disarm(): void;
  /** Tear down listeners and nodes. Idempotent. */
  dispose(): void;
}

export const SERVER_SWITCHER_STYLES = `
[${SERVER_SWITCHER_ATTR}] { display: block; }
[${SERVER_SWITCHER_ATTR}] *,
[${SERVER_SWITCHER_ATTR}] *::before,
[${SERVER_SWITCHER_ATTR}] *::after { box-sizing: border-box; }
[${SERVER_SWITCHER_MENU_ATTR}] {
  list-style: none;
  margin: 0;
  padding: 0;
  /* Fixed height + scroll: a roster is unbounded, and a menu that grows past
     the viewport puts its own controls out of reach. */
  max-height: 216px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
[${SERVER_SWITCHER_MENU_ATTR}] > li:not([${SERVER_SWITCHER_SWITCH_CONFIRM_ATTR}]):not([${SERVER_SWITCHER_REMOVE_CONFIRM_ATTR}]):not([${SERVER_SWITCHER_RENAME_FORM_ATTR}]) {
  display: flex;
  align-items: stretch;
  gap: 4px;
}
[${SERVER_SWITCHER_EMPTY_ATTR}] {
  padding: 8px;
  font-size: 12px;
  opacity: 0.7;
}
[${SERVER_SWITCHER_ITEM_ATTR}] {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  min-height: 62px;
  padding: 7px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
[${SERVER_SWITCHER_ITEM_ATTR}]:hover { background: var(--recued-surface-hover, rgba(127,127,127,0.12)); }
[${SERVER_SWITCHER_ITEM_ATTR}][aria-current="true"] { font-weight: 600; }
[${SERVER_SWITCHER_ITEM_ATTR}]:focus-visible,
[${SERVER_SWITCHER_SWITCH_COMMIT_ATTR}]:focus-visible,
[${SERVER_SWITCHER_SWITCH_CANCEL_ATTR}]:focus-visible,
[${SERVER_SWITCHER_RETURN_TO_WORK_ATTR}]:focus-visible,
[${SERVER_SWITCHER_RENAME_ATTR}]:focus-visible,
[${SERVER_SWITCHER_RENAME_INPUT_ATTR}]:focus-visible,
[${SERVER_SWITCHER_RENAME_SAVE_ATTR}]:focus-visible,
[${SERVER_SWITCHER_RENAME_CANCEL_ATTR}]:focus-visible,
[${SERVER_SWITCHER_REMOVE_ATTR}]:focus-visible,
[${SERVER_SWITCHER_REMOVE_LOCAL_ATTR}]:focus-visible,
[${SERVER_SWITCHER_REMOVE_REVOKE_ATTR}]:focus-visible,
[${SERVER_SWITCHER_REMOVE_CANCEL_ATTR}]:focus-visible {
  outline: 2px solid var(--recued-focus, #4c8dff);
  outline-offset: 1px;
}
[${SERVER_SWITCHER_ITEM_ATTR}] .recued-switcher-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
[${SERVER_SWITCHER_ITEM_ATTR}] .recued-switcher-name,
[${SERVER_SWITCHER_ITEM_ATTR}] .recued-switcher-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[${SERVER_SWITCHER_CURRENT_ATTR}] {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--recued-accent-weak, rgba(20, 125, 158, 0.12));
  color: var(--recued-accent, #147d9e);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
[${SERVER_SWITCHER_ITEM_ATTR}] .recued-switcher-url { font-size: 11px; opacity: 0.62; }
[${SERVER_SWITCHER_RECENCY_ATTR}] {
  font-size: 10.5px;
  opacity: 0.7;
}
[${SERVER_SWITCHER_ITEM_ATTR}][data-unreachable="true"] .recued-switcher-url {
  color: var(--recued-danger, #b3261e);
  opacity: 1;
}
[${SERVER_SWITCHER_RENAME_ATTR}],
[${SERVER_SWITCHER_REMOVE_ATTR}] {
  flex: 0 0 auto;
  min-width: 52px;
  min-height: 44px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  opacity: 0.78;
  cursor: pointer;
}
[${SERVER_SWITCHER_REMOVE_ATTR}]:hover { opacity: 1; background: var(--recued-surface-hover, rgba(127,127,127,0.12)); }
[${SERVER_SWITCHER_RENAME_ATTR}]:hover { opacity: 1; background: var(--recued-surface-hover, rgba(127,127,127,0.12)); }
[${SERVER_SWITCHER_RENAME_FORM_ATTR}] {
  display: block;
  margin: 2px 0 8px;
  padding: 10px;
  border: 1px solid var(--recued-border, rgba(127,127,127,0.28));
  border-radius: 8px;
  background: var(--recued-surface-subtle, rgba(127,127,127,0.07));
}
[${SERVER_SWITCHER_RENAME_FORM_ATTR}] label {
  display: block;
  margin-bottom: 5px;
  font-size: 12px;
  font-weight: 600;
}
[${SERVER_SWITCHER_RENAME_INPUT_ATTR}] {
  width: 100%;
  min-height: 44px;
  padding: 7px 9px;
  border: 1px solid var(--recued-border, rgba(127,127,127,0.35));
  border-radius: 7px;
  background: var(--recued-surface, #fff);
  color: inherit;
  font: inherit;
  font-size: 13px;
}
[${SERVER_SWITCHER_RENAME_FORM_ATTR}] .recued-switcher-rename-hint,
[${SERVER_SWITCHER_RENAME_ERROR_ATTR}] {
  margin: 5px 0 8px;
  font-size: 11px;
  line-height: 1.4;
}
[${SERVER_SWITCHER_RENAME_FORM_ATTR}] .recued-switcher-rename-hint { opacity: 0.72; }
[${SERVER_SWITCHER_RENAME_ERROR_ATTR}] { color: var(--recued-danger, #b3261e); }
[${SERVER_SWITCHER_RENAME_FORM_ATTR}] .recued-switcher-rename-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
[${SERVER_SWITCHER_RENAME_SAVE_ATTR}],
[${SERVER_SWITCHER_RENAME_CANCEL_ATTR}] {
  min-height: 44px;
  padding: 6px 10px;
  border: 1px solid var(--recued-border, rgba(127,127,127,0.28));
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
[${SERVER_SWITCHER_RENAME_SAVE_ATTR}] {
  border-color: var(--recued-accent, #147d9e);
  color: var(--recued-accent, #147d9e);
}
[${SERVER_SWITCHER_RENAME_SAVE_ATTR}]:hover,
[${SERVER_SWITCHER_RENAME_CANCEL_ATTR}]:hover {
  background: var(--recued-surface-hover, rgba(127,127,127,0.12));
}
[${SERVER_SWITCHER_ANNOUNCER_ATTR}] {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
[${SERVER_SWITCHER_SWITCH_CONFIRM_ATTR}],
[${SERVER_SWITCHER_REMOVE_CONFIRM_ATTR}] {
  display: block;
  margin: 2px 0 8px;
  padding: 10px;
  border: 1px solid var(--recued-border, rgba(127,127,127,0.28));
  border-radius: 8px;
  background: var(--recued-surface-subtle, rgba(127,127,127,0.07));
}
[${SERVER_SWITCHER_SWITCH_CONFIRM_ATTR}] h3,
[${SERVER_SWITCHER_REMOVE_CONFIRM_ATTR}] h3 {
  margin: 0 0 4px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
[${SERVER_SWITCHER_SWITCH_CONFIRM_ATTR}] p,
[${SERVER_SWITCHER_REMOVE_CONFIRM_ATTR}] p {
  margin: 0 0 8px;
  font-size: 11px;
  line-height: 1.4;
  opacity: 0.78;
  overflow-wrap: anywhere;
}
[${SERVER_SWITCHER_REMOVE_STATUS_ATTR}] { opacity: 0.86; }
[${SERVER_SWITCHER_REMOVE_ERROR_ATTR}] {
  color: var(--recued-danger, #b3261e);
  opacity: 1;
}
[${SERVER_SWITCHER_SWITCH_CONFIRM_ATTR}] .recued-switcher-switch-boundary {
  opacity: 1;
  font-weight: 600;
}
[${SERVER_SWITCHER_ACTIVE_WORK_ATTR}] {
  display: grid;
  gap: 5px;
  margin: 0 0 9px;
  padding: 0;
  list-style: none;
}
[${SERVER_SWITCHER_ACTIVE_WORK_ITEM_ATTR}] {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 7px 8px;
  border-radius: 7px;
  background: var(--recued-surface, rgba(127,127,127,0.08));
  font-size: 11px;
}
[${SERVER_SWITCHER_ACTIVE_WORK_ITEM_ATTR}] > span {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
[${SERVER_SWITCHER_RETURN_TO_WORK_ATTR}] {
  flex: 0 0 auto;
  min-height: 36px;
  padding: 5px 8px;
  border: 1px solid var(--recued-border, rgba(127,127,127,0.28));
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}
[${SERVER_SWITCHER_SWITCH_ERROR_ATTR}] {
  color: var(--recued-danger, #b3261e);
  opacity: 1;
}
[${SERVER_SWITCHER_SWITCH_CONFIRM_ATTR}] .recued-switcher-switch-actions,
[${SERVER_SWITCHER_REMOVE_CONFIRM_ATTR}] .recued-switcher-remove-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
[${SERVER_SWITCHER_SWITCH_COMMIT_ATTR}],
[${SERVER_SWITCHER_SWITCH_CANCEL_ATTR}],
[${SERVER_SWITCHER_RETURN_TO_WORK_ATTR}],
[${SERVER_SWITCHER_REMOVE_LOCAL_ATTR}],
[${SERVER_SWITCHER_REMOVE_REVOKE_ATTR}],
[${SERVER_SWITCHER_REMOVE_CANCEL_ATTR}] {
  min-height: 44px;
  padding: 6px 9px;
  border: 1px solid var(--recued-border, rgba(127,127,127,0.28));
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
[${SERVER_SWITCHER_SWITCH_COMMIT_ATTR}] {
  border-color: var(--recued-accent, #147d9e);
  color: var(--recued-accent, #147d9e);
}
[${SERVER_SWITCHER_SWITCH_COMMIT_ATTR}]:hover,
[${SERVER_SWITCHER_SWITCH_CANCEL_ATTR}]:hover,
[${SERVER_SWITCHER_RETURN_TO_WORK_ATTR}]:hover,
[${SERVER_SWITCHER_REMOVE_LOCAL_ATTR}]:hover,
[${SERVER_SWITCHER_REMOVE_CANCEL_ATTR}]:hover {
  background: var(--recued-surface-hover, rgba(127,127,127,0.12));
}
[${SERVER_SWITCHER_REMOVE_REVOKE_ATTR}] {
  border-color: color-mix(in srgb, var(--recued-danger, #b3261e) 48%, transparent);
  color: var(--recued-danger, #b3261e);
}
[${SERVER_SWITCHER_REMOVE_REVOKE_ATTR}]:hover {
  background: color-mix(in srgb, var(--recued-danger, #b3261e) 9%, transparent);
}
[${SERVER_SWITCHER_SWITCH_COMMIT_ATTR}][disabled],
[${SERVER_SWITCHER_SWITCH_CANCEL_ATTR}][disabled],
[${SERVER_SWITCHER_RETURN_TO_WORK_ATTR}][disabled],
[${SERVER_SWITCHER_REMOVE_LOCAL_ATTR}][disabled],
[${SERVER_SWITCHER_REMOVE_REVOKE_ATTR}][disabled],
[${SERVER_SWITCHER_REMOVE_CANCEL_ATTR}][disabled],
[${SERVER_SWITCHER_RENAME_INPUT_ATTR}][disabled],
[${SERVER_SWITCHER_RENAME_SAVE_ATTR}][disabled],
[${SERVER_SWITCHER_RENAME_CANCEL_ATTR}][disabled],
[${SERVER_SWITCHER_ITEM_ATTR}][disabled],
[${SERVER_SWITCHER_RENAME_ATTR}][disabled],
[${SERVER_SWITCHER_REMOVE_ATTR}][disabled] {
  cursor: wait;
  opacity: 0.55;
}
`;

/** A profile with no address is roster bookkeeping (a write that landed
 *  before its URL did), not somewhere to connect. Kept local rather than
 *  imported so this module stays DOM-only. */
const isConnectable = (p: WebclientServerProfile): boolean =>
  typeof p.server_url === 'string' && p.server_url.length > 0;

/** Most recently used first. Modern JS sorting is stable, so profiles with no
 *  recency retain roster order rather than jumping around between renders. */
export const orderServerProfilesByRecency = (
  profiles: ReadonlyArray<WebclientServerProfile>,
): ReadonlyArray<WebclientServerProfile> =>
  [...profiles].sort(
    (left, right) =>
      (validLastConnectedAt(right) ?? 0) - (validLastConnectedAt(left) ?? 0),
  );

export const formatServerProfileRecency = (
  connectedAt: number | null,
  now: number,
): string => {
  if (
    connectedAt === null
    || !Number.isFinite(connectedAt)
    || connectedAt < 0
  ) return 'Not connected yet';

  const elapsedMs = Math.max(0, now - connectedAt);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'Last connected just now';
  if (minutes < 60) {
    return `Last connected ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `Last connected ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `Last connected ${days} ${days === 1 ? 'day' : 'days'} ago`;
  }
  return `Last connected ${new Date(connectedAt).toLocaleDateString()}`;
};

export const mountProfileList = (
  opts: MountProfileListOptions,
): ProfileListMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountProfileList: no document available — pass `opts.document` for non-browser environments',
    );
  }

  const root = doc.createElement('div');
  root.setAttribute(SERVER_SWITCHER_ATTR, '');
  const list = doc.createElement('ul');
  list.setAttribute(SERVER_SWITCHER_MENU_ATTR, '');
  list.setAttribute('aria-label', 'Server profiles');
  list.setAttribute('tabindex', '-1');
  root.appendChild(list);
  const announcer = doc.createElement('p');
  announcer.setAttribute(SERVER_SWITCHER_ANNOUNCER_ATTR, '');
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');
  root.appendChild(announcer);
  opts.host.appendChild(root);

  let disposed = false;
  let profiles = opts.profiles;
  let activeId = opts.activeProfileId;
  let activeUnreachable = opts.activeUnreachable === true;
  let activeConnected = opts.activeConnected === true;
  /** One explicit choice panel at a time. A failed remote revoke stays open
   *  with the local-only escape hatch; success is owned by the caller, which
   *  persists first and then refreshes/reloads. */
  let removal: {
    id: string;
    busy: ServerProfileRemovalMode | null;
    error: string | null;
  } | null = null;
  let rename: {
    id: string;
    draft: string;
    busy: boolean;
    error: string | null;
  } | null = null;
  let switching: {
    id: string;
    workState: ServerSwitchWorkState;
    activeWork: ReadonlyArray<ServerSwitchActiveWork>;
    busy: boolean;
    error: string | null;
  } | null = null;
  let switchFocusTarget: HTMLElement | null = null;
  let confirmFocusTarget: HTMLElement | null = null;
  let renameFocusTarget: HTMLElement | null = null;
  const renderedRemoveButtons = new Map<string, HTMLElement>();
  const renderedRenameButtons = new Map<string, HTMLElement>();
  const renderedFocusKeys = new Map<HTMLElement, string>();
  const renderedFocusTargets = new Map<string, HTMLElement>();

  const registerFocusTarget = (
    key: string,
    element: HTMLElement,
  ): void => {
    renderedFocusKeys.set(element, key);
    renderedFocusTargets.set(key, element);
  };

  const disarmRemoval = (): void => {
    if (removal !== null && removal.busy !== null) return;
    removal = null;
  };

  const disarmRename = (): void => {
    if (rename?.busy === true) return;
    rename = null;
  };

  const disarmSwitch = (): void => {
    if (switching?.busy === true) return;
    switching = null;
  };

  const disarmChoices = (): void => {
    disarmSwitch();
    disarmRemoval();
    disarmRename();
  };

  const focusElement = (element: HTMLElement | null): void => {
    if (element === null) return;
    try {
      element.focus();
    } catch {
      /* detached/fake DOM — focus handoff is best-effort */
    }
  };

  const removalErrorCopy = (error: unknown): string =>
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : 'Recued could not remove that server. Try again.';

  const renameErrorCopy = (error: unknown): string =>
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : 'Recued could not save that name. Try again.';

  const switchErrorCopy = (error: unknown): string =>
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : 'Recued could not change servers. This tab is still on the one you were using.';

  const currentSwitchWorkState = (): ServerSwitchWorkState => {
    try {
      return opts.switchWorkState?.() ?? 'clean';
    } catch {
      // A broken route probe is not proof that work is safe to discard.
      return 'unsaved_changes';
    }
  };

  const currentSwitchActiveWork = (): ReadonlyArray<ServerSwitchActiveWork> => {
    try {
      return opts.switchActiveWork?.().map((work) => ({ ...work })) ?? [];
    } catch {
      // Unknown named details do not weaken the coarse fail-closed state.
      return [];
    }
  };

  const render = (): void => {
    const connectable = orderServerProfilesByRecency(
      profiles.filter(isConnectable),
    );
    const activeProfileLabel = connectable.find(
      (profile) => profile.id === activeId,
    )?.label;
    const clockNow = (opts.now ?? Date.now)();
    const renderedAt = Number.isFinite(clockNow) ? clockNow : Date.now();
    confirmFocusTarget = null;
    renameFocusTarget = null;
    switchFocusTarget = null;
    renderedRemoveButtons.clear();
    renderedRenameButtons.clear();
    renderedFocusKeys.clear();
    renderedFocusTargets.clear();
    while (list.firstChild !== null) list.removeChild(list.firstChild);

    if (connectable.length === 0) {
      // An empty roster still has to say something — a blank panel reads as
      // broken rather than as "nothing paired yet".
      const empty = doc.createElement('li');
      empty.setAttribute(SERVER_SWITCHER_EMPTY_ATTR, '');
      empty.textContent = 'This browser is not paired with any server.';
      list.appendChild(empty);
      return;
    }

    for (const p of connectable) {
      const row = doc.createElement('li');
      const item = doc.createElement('button');
      item.setAttribute('type', 'button');
      item.setAttribute(SERVER_SWITCHER_ITEM_ATTR, '');
      item.setAttribute('data-profile-id', p.id);
      const choiceBusy = (removal !== null && removal.busy !== null)
        || rename?.busy === true
        || switching?.busy === true;
      if (choiceBusy) item.setAttribute('disabled', '');
      registerFocusTarget(`item:${p.id}`, item);
      const isActive = p.id === activeId;
      item.setAttribute('aria-current', isActive ? 'true' : 'false');
      // Only the ACTIVE profile's reachability is known — the others are
      // unprobed, and claiming otherwise would be inventing status.
      if (isActive && activeUnreachable) {
        item.setAttribute('data-unreachable', 'true');
      }
      const name = doc.createElement('span');
      name.className = 'recued-switcher-name';
      name.textContent = p.label;
      const heading = doc.createElement('span');
      heading.className = 'recued-switcher-heading';
      heading.appendChild(name);
      if (isActive) {
        const current = doc.createElement('span');
        current.setAttribute(SERVER_SWITCHER_CURRENT_ATTR, '');
        current.textContent = 'Current';
        heading.appendChild(current);
      }
      const url = doc.createElement('span');
      url.className = 'recued-switcher-url';
      url.textContent = isActive && activeUnreachable
        ? `${p.server_url} — not reachable`
        : p.server_url;
      item.appendChild(heading);
      item.appendChild(url);
      const recency = doc.createElement('time');
      recency.setAttribute(SERVER_SWITCHER_RECENCY_ATTR, '');
      const connectedAt = validLastConnectedAt(p);
      recency.textContent = isActive && activeConnected
        ? 'Connected now'
        : formatServerProfileRecency(connectedAt, renderedAt);
      if (connectedAt !== null) {
        const connectedDate = new Date(connectedAt);
        if (Number.isFinite(connectedDate.getTime())) {
          recency.setAttribute('datetime', connectedDate.toISOString());
          recency.setAttribute('title', connectedDate.toLocaleString());
        }
      }
      item.appendChild(recency);
      item.addEventListener('click', () => {
        if (choiceBusy) return;
        disarmChoices();
        // Switching to the profile already active is a no-op rather than a
        // re-bootstrap: tearing down a healthy connection because someone
        // clicked the row they were already on is pure harm.
        if (p.id !== activeId) {
          switching = {
            id: p.id,
            workState: currentSwitchWorkState(),
            activeWork: currentSwitchActiveWork(),
            busy: false,
            error: null,
          };
          render();
          focusElement(switchFocusTarget);
        } else opts.onSelectActive?.();
      });
      row.appendChild(item);

      if (opts.onRename !== undefined) {
        const renameButton = doc.createElement('button');
        renameButton.setAttribute('type', 'button');
        renameButton.setAttribute(SERVER_SWITCHER_RENAME_ATTR, '');
        renameButton.setAttribute('data-profile-id', p.id);
        if (choiceBusy) renameButton.setAttribute('disabled', '');
        renameButton.textContent = 'Rename';
        renameButton.setAttribute('aria-label', `Rename ${p.label}`);
        renameButton.addEventListener('click', () => {
          if (choiceBusy) return;
          disarmChoices();
          rename = {
            id: p.id,
            draft: p.label,
            busy: false,
            error: null,
          };
          render();
          focusElement(renameFocusTarget);
        });
        renderedRenameButtons.set(p.id, renameButton);
        registerFocusTarget(`rename:${p.id}`, renameButton);
        row.appendChild(renameButton);
      }

      if (opts.onRemove !== undefined) {
        const remove = doc.createElement('button');
        remove.setAttribute('type', 'button');
        remove.setAttribute(SERVER_SWITCHER_REMOVE_ATTR, '');
        remove.setAttribute('data-profile-id', p.id);
        if (choiceBusy) remove.setAttribute('disabled', '');
        remove.textContent = 'Forget';
        remove.setAttribute(
          'aria-label',
          `See how to remove ${p.label} from this browser`,
        );
        remove.addEventListener('click', () => {
          if (choiceBusy) return;
          disarmChoices();
          removal = {
            id: p.id,
            busy: null,
            error: null,
          };
          render();
          focusElement(confirmFocusTarget);
        });
        renderedRemoveButtons.set(p.id, remove);
        registerFocusTarget(`remove:${p.id}`, remove);
        row.appendChild(remove);
      }
      list.appendChild(row);

      if (switching?.id === p.id) {
        const confirm = doc.createElement('li');
        confirm.setAttribute(SERVER_SWITCHER_SWITCH_CONFIRM_ATTR, '');
        confirm.setAttribute('data-profile-id', p.id);
        confirm.setAttribute('role', 'group');
        confirm.setAttribute('tabindex', '-1');
        registerFocusTarget(`switch-panel:${p.id}`, confirm);
        if (switching.busy) {
          confirm.setAttribute('aria-busy', 'true');
          switchFocusTarget = confirm;
        }
        const titleId = `recued-switch-server-${p.id}`;
        const consequenceId = `${titleId}-consequence`;
        const detailId = `${titleId}-detail`;
        const activeWorkId = `${titleId}-active-work`;
        confirm.setAttribute('aria-labelledby', titleId);
        confirm.setAttribute(
          'aria-describedby',
          [
            consequenceId,
            ...(switching.activeWork.length > 0 ? [activeWorkId] : []),
            detailId,
          ].join(' '),
        );

        const title = doc.createElement('h3');
        title.setAttribute('id', titleId);
        title.textContent = `Switch to ${p.label}?`;
        confirm.appendChild(title);

        const consequence = doc.createElement('p');
        consequence.setAttribute('id', consequenceId);
        consequence.className = 'recued-switcher-switch-boundary';
        const sourceLabel = activeProfileLabel ?? 'the current server';
        const resultReadyOnly = switching.activeWork.length > 0
          && switching.activeWork.every((work) => work.phase === 'result_ready');
        consequence.textContent = switching.workState === 'chat_draft'
          ? `The Chat message you have not sent is only in this tab. Switching loses it. It will never be sent to, or saved on, ${p.label}.`
          : switching.workState === 'unsaved_changes'
            ? `You have unsaved changes on ${sourceLabel}. Switching will discard them.`
            : switching.workState === 'in_flight_with_chat_draft'
              ? resultReadyOnly
                ? `There is a result waiting on ${sourceLabel}, and this tab has an unsent Chat draft. Switching will leave the result there, discard the draft, and move neither one to ${p.label}.`
                : `Work is still finishing on ${sourceLabel}, and this tab has an unsent Chat draft. It may already have reached that server. Switching now cannot confirm or cancel it, will discard the draft, and will not move either one to ${p.label}.`
              : switching.workState === 'in_flight_with_unsaved_changes'
                ? resultReadyOnly
                  ? `There is a result waiting on ${sourceLabel}, and this tab may also hold unsaved changes. Switching will leave the result there and discard changes that have not been saved.`
                  : `Work is still finishing on ${sourceLabel}, and this tab may also hold unsaved changes. Switching now cannot confirm or cancel work that may have reached that server, and will discard changes that have not.`
                : switching.workState === 'in_flight'
                  ? resultReadyOnly
                    ? `There is a result waiting on ${sourceLabel}. Switching now will leave that result there; it will not move to ${p.label}.`
                    : `Work is still finishing on ${sourceLabel}. It may already have reached that server. Switching now cannot confirm or cancel it; any outcome or receipt will stay there.`
                  : `Recued will reload this tab so it uses ${p.label}.`;
        confirm.appendChild(consequence);

        if (switching.activeWork.length > 0) {
          const activeWork = doc.createElement('ul');
          activeWork.setAttribute(SERVER_SWITCHER_ACTIVE_WORK_ATTR, '');
          activeWork.setAttribute('id', activeWorkId);
          activeWork.setAttribute('aria-label', 'Source-server work and results');
          for (const work of switching.activeWork) {
            const workItem = doc.createElement('li');
            workItem.setAttribute(SERVER_SWITCHER_ACTIVE_WORK_ITEM_ATTR, '');
            workItem.setAttribute('data-work-id', work.id);
            const label = doc.createElement('span');
            label.textContent = work.label;
            workItem.appendChild(label);
            if (
              work.returnHref !== undefined
              && opts.onReturnToWork !== undefined
            ) {
              const returnHref = work.returnHref;
              const returnButton = doc.createElement('button');
              returnButton.setAttribute('type', 'button');
              returnButton.setAttribute(SERVER_SWITCHER_RETURN_TO_WORK_ATTR, '');
              returnButton.setAttribute('data-work-id', work.id);
              returnButton.textContent = work.returnLabel ?? 'Return to work';
              if (switching.busy) returnButton.setAttribute('disabled', '');
              returnButton.addEventListener('click', () => {
                if (switching?.busy === true) return;
                switching = null;
                render();
                opts.onReturnToWork?.(returnHref);
              });
              workItem.appendChild(returnButton);
            }
            activeWork.appendChild(workItem);
          }
          confirm.appendChild(activeWork);
        }

        const detail = doc.createElement('p');
        detail.setAttribute('id', detailId);
        detail.textContent =
          'You stay where you are when that is safe. Chats, records, runs and links belong to one server and stay there.';
        confirm.appendChild(detail);

        if (switching.error !== null) {
          const error = doc.createElement('p');
          error.setAttribute(SERVER_SWITCHER_SWITCH_ERROR_ATTR, '');
          error.setAttribute('role', 'alert');
          error.setAttribute('tabindex', '-1');
          error.textContent = switching.error;
          confirm.appendChild(error);
          switchFocusTarget = error;
          registerFocusTarget(`switch-error:${p.id}`, error);
        }

        const actions = doc.createElement('div');
        actions.className = 'recued-switcher-switch-actions';
        const commit = doc.createElement('button');
        commit.setAttribute('type', 'button');
        commit.setAttribute(SERVER_SWITCHER_SWITCH_COMMIT_ATTR, '');
        commit.setAttribute('data-profile-id', p.id);
        commit.textContent = switching.busy
          ? 'Switching…'
          : isInFlightServerSwitchWorkState(switching.workState)
            ? resultReadyOnly
              ? 'Switch, and look later'
              : 'Switch, and check later'
            : 'Switch server';
        if (switching.busy) commit.setAttribute('disabled', '');
        commit.addEventListener('click', () => {
          if (disposed || switching?.id !== p.id || switching.busy) return;
          const latestWorkState = currentSwitchWorkState();
          const latestActiveWork = currentSwitchActiveWork();
          if (!serverSwitchReviewCoversWorkState(
            switching.workState,
            latestWorkState,
          ) || !serverSwitchReviewCoversActiveWork(
            switching.activeWork,
            latestActiveWork,
          )) {
            switching = {
              ...switching,
              workState: latestWorkState,
              activeWork: latestActiveWork,
              error: null,
            };
            render();
            announcer.textContent =
              'Your work changed while this choice was open. Review the updated switch details.';
            focusElement(
              renderedFocusTargets.get(`switch-panel:${p.id}`) ?? null,
            );
            return;
          }
          const reviewedWorkState = switching.workState;
          const reviewedActiveWork = switching.activeWork;
          switching = { ...switching, busy: true, error: null };
          render();
          focusElement(switchFocusTarget);
          void Promise.resolve()
            .then(() => reviewedActiveWork.length > 0
              ? opts.onSwitch(p.id, reviewedWorkState, reviewedActiveWork)
              : opts.onSwitch(p.id, reviewedWorkState))
            .then(() => {
              if (disposed || switching?.id !== p.id) return;
              // Production is navigating away, but an embed/test reload seam
              // may return without unloading. Do not leave that tab trapped in
              // a permanent, disabled “Switching…” state.
              switching = null;
              render();
            })
            .catch((error: unknown) => {
              if (disposed || switching?.id !== p.id) return;
              switching = {
                ...switching,
                busy: false,
                workState: currentSwitchWorkState(),
                activeWork: currentSwitchActiveWork(),
                error: switchErrorCopy(error),
              };
              render();
              focusElement(switchFocusTarget);
            });
        });
        registerFocusTarget(`switch-commit:${p.id}`, commit);
        actions.appendChild(commit);

        const cancel = doc.createElement('button');
        cancel.setAttribute('type', 'button');
        cancel.setAttribute(SERVER_SWITCHER_SWITCH_CANCEL_ATTR, '');
        cancel.setAttribute('data-profile-id', p.id);
        cancel.textContent = isInFlightServerSwitchWorkState(switching.workState)
          ? resultReadyOnly
            ? 'Stay and review'
            : 'Stay and wait'
          : 'Cancel';
        if (switching.busy) cancel.setAttribute('disabled', '');
        cancel.addEventListener('click', () => {
          if (switching?.busy === true) return;
          switching = null;
          render();
          focusElement(renderedFocusTargets.get(`item:${p.id}`) ?? null);
        });
        registerFocusTarget(`switch-cancel:${p.id}`, cancel);
        actions.appendChild(cancel);
        if (switchFocusTarget === null) switchFocusTarget = commit;
        confirm.appendChild(actions);
        list.appendChild(confirm);
      }

      if (opts.onRename !== undefined && rename?.id === p.id) {
        const renameRow = doc.createElement('li');
        renameRow.setAttribute(SERVER_SWITCHER_RENAME_FORM_ATTR, '');
        renameRow.setAttribute('data-profile-id', p.id);
        renameRow.setAttribute('role', 'group');
        renameRow.setAttribute('tabindex', '-1');
        if (rename.busy) {
          renameRow.setAttribute('aria-busy', 'true');
          renameFocusTarget = renameRow;
          registerFocusTarget(`rename-panel:${p.id}`, renameRow);
        }

        const inputId = `recued-rename-server-${p.id}`;
        const hintId = `${inputId}-hint`;
        const errorId = `${inputId}-error`;
        const label = doc.createElement('label');
        label.setAttribute('for', inputId);
        label.textContent = 'Server name';
        renameRow.appendChild(label);

        const input = doc.createElement('input');
        input.setAttribute('type', 'text');
        input.setAttribute('id', inputId);
        input.setAttribute(SERVER_SWITCHER_RENAME_INPUT_ATTR, '');
        input.setAttribute('data-profile-id', p.id);
        input.setAttribute('maxlength', String(SERVER_PROFILE_LABEL_MAX_LENGTH));
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('aria-describedby', hintId);
        input.value = rename.draft;
        if (rename.busy) input.setAttribute('disabled', '');
        input.addEventListener('input', () => {
          if (rename?.id === p.id && !rename.busy) rename.draft = input.value;
        });
        registerFocusTarget(`rename-input:${p.id}`, input);
        renameRow.appendChild(input);
        if (!rename.busy && rename.error === null) renameFocusTarget = input;

        const hint = doc.createElement('p');
        hint.setAttribute('id', hintId);
        hint.className = 'recued-switcher-rename-hint';
        hint.textContent = `Stored on this browser. Server address: ${p.server_url}`;
        renameRow.appendChild(hint);

        if (rename.error !== null) {
          const error = doc.createElement('p');
          error.setAttribute(SERVER_SWITCHER_RENAME_ERROR_ATTR, '');
          error.setAttribute('id', errorId);
          error.setAttribute('role', 'alert');
          error.textContent = rename.error;
          renameRow.appendChild(error);
          input.setAttribute('aria-invalid', 'true');
          input.setAttribute('aria-describedby', `${hintId} ${errorId}`);
          // Put the user back on the field they need to correct. The alert is
          // announced through `role=alert`; moving focus to prose would add an
          // extra reverse-tab before retrying.
          renameFocusTarget = input;
        }

        const actions = doc.createElement('div');
        actions.className = 'recued-switcher-rename-actions';
        const runRename = (event?: Event): void => {
          if (typeof event?.preventDefault === 'function') event.preventDefault();
          if (disposed || rename?.id !== p.id || rename.busy) return;
          const nextLabel = rename.draft.trim();
          if (nextLabel.length === 0) {
            rename = {
              ...rename,
              error: 'Enter a name for this server.',
            };
            render();
            focusElement(renameFocusTarget);
            return;
          }
          if (nextLabel.length > SERVER_PROFILE_LABEL_MAX_LENGTH) {
            rename = {
              ...rename,
              error: `Use ${SERVER_PROFILE_LABEL_MAX_LENGTH} characters or fewer.`,
            };
            render();
            focusElement(renameFocusTarget);
            return;
          }
          rename = { ...rename, draft: nextLabel, busy: true, error: null };
          render();
          focusElement(renameFocusTarget);
          void Promise.resolve()
            .then(() => opts.onRename?.(p.id, nextLabel))
            .then((savedLabel) => {
              if (disposed || rename?.id !== p.id) return;
              const committedLabel =
                typeof savedLabel === 'string' && savedLabel.trim().length > 0
                  ? savedLabel.trim()
                  : nextLabel;
              profiles = profiles.map((profile) =>
                profile.id === p.id
                  ? { ...profile, label: committedLabel }
                  : profile,
              );
              rename = null;
              render();
              announcer.textContent = `Server renamed to ${committedLabel}.`;
              focusElement(renderedRenameButtons.get(p.id) ?? null);
            })
            .catch((error: unknown) => {
              if (disposed || rename?.id !== p.id) return;
              rename = {
                ...rename,
                busy: false,
                error: renameErrorCopy(error),
              };
              render();
              focusElement(renameFocusTarget);
            });
        };
        input.addEventListener('keydown', (event: KeyboardEvent) => {
          if (event.key === 'Enter' && !event.isComposing) runRename(event);
        });

        const save = doc.createElement('button');
        save.setAttribute('type', 'button');
        save.setAttribute(SERVER_SWITCHER_RENAME_SAVE_ATTR, '');
        save.textContent = rename.busy ? 'Saving…' : 'Save name';
        if (rename.busy) save.setAttribute('disabled', '');
        save.addEventListener('click', runRename);
        registerFocusTarget(`rename-save:${p.id}`, save);
        actions.appendChild(save);

        const cancel = doc.createElement('button');
        cancel.setAttribute('type', 'button');
        cancel.setAttribute(SERVER_SWITCHER_RENAME_CANCEL_ATTR, '');
        cancel.textContent = 'Cancel';
        if (rename.busy) cancel.setAttribute('disabled', '');
        cancel.addEventListener('click', () => {
          if (rename?.busy === true) return;
          rename = null;
          render();
          focusElement(renderedRenameButtons.get(p.id) ?? null);
        });
        registerFocusTarget(`rename-cancel:${p.id}`, cancel);
        actions.appendChild(cancel);
        renameRow.appendChild(actions);
        list.appendChild(renameRow);
      }

      if (opts.onRemove !== undefined && removal?.id === p.id) {
        const confirm = doc.createElement('li');
        confirm.setAttribute(SERVER_SWITCHER_REMOVE_CONFIRM_ATTR, '');
        confirm.setAttribute('data-profile-id', p.id);
        confirm.setAttribute('role', 'group');
        confirm.setAttribute('tabindex', '-1');
        if (removal.busy !== null) {
          confirm.setAttribute('aria-busy', 'true');
          confirmFocusTarget = confirm;
          registerFocusTarget(`remove-panel:${p.id}`, confirm);
        }
        const titleId = `recued-remove-server-${p.id}`;
        confirm.setAttribute('aria-labelledby', titleId);

        const title = doc.createElement('h3');
        title.setAttribute('id', titleId);
        title.textContent = `Remove ${p.label}?`;
        confirm.appendChild(title);

        const detail = doc.createElement('p');
        detail.textContent =
          'Forgetting only removes this saved server from here. The server still lets this browser in.';
        confirm.appendChild(detail);

        const instanceId = p.pair_metadata?.instance_id?.trim() ?? '';
        const canRevoke = isActive && activeConnected && instanceId.length > 0;
        const status = doc.createElement('p');
        status.setAttribute(SERVER_SWITCHER_REMOVE_STATUS_ATTR, '');
        if (canRevoke) {
          status.textContent =
            'Take this browser’s access away first, to sign it out on the server, before you forget it here.';
        } else if (!isActive) {
          status.textContent =
            'Switch to this server first if you also want to take this browser’s access away.';
        } else if (!activeConnected) {
          status.textContent =
            'Reconnect to this server before revoking access. You can still forget the saved profile here.';
        } else {
          status.textContent =
            'This older profile has no revocable browser identity. You can still forget it here.';
        }
        confirm.appendChild(status);

        if (removal.error !== null) {
          const error = doc.createElement('p');
          error.setAttribute(SERVER_SWITCHER_REMOVE_ERROR_ATTR, '');
          error.setAttribute('role', 'alert');
          error.setAttribute('tabindex', '-1');
          error.textContent = removal.error;
          confirm.appendChild(error);
          confirmFocusTarget = error;
          registerFocusTarget(`remove-error:${p.id}`, error);
        }

        const actions = doc.createElement('div');
        actions.className = 'recued-switcher-remove-actions';
        const busy = removal.busy !== null;
        const runRemoval = (mode: ServerProfileRemovalMode): void => {
          if (disposed || removal?.id !== p.id || removal.busy !== null) return;
          removal = { id: p.id, busy: mode, error: null };
          render();
          focusElement(confirmFocusTarget);
          void Promise.resolve()
            .then(() => opts.onRemove?.(p.id, mode))
            .then(() => {
              if (disposed || removal?.id !== p.id) return;
              removal = null;
              render();
            })
            .catch((error: unknown) => {
              if (disposed || removal?.id !== p.id) return;
              removal = {
                id: p.id,
                busy: null,
                error: removalErrorCopy(error),
              };
              render();
              focusElement(confirmFocusTarget);
            });
        };

        const local = doc.createElement('button');
        local.setAttribute('type', 'button');
        local.setAttribute(SERVER_SWITCHER_REMOVE_LOCAL_ATTR, '');
        local.textContent = removal.busy === 'local'
          ? 'Forgetting…'
          : 'Forget on this browser';
        if (busy) local.setAttribute('disabled', '');
        local.addEventListener('click', () => runRemoval('local'));
        registerFocusTarget(`remove-local:${p.id}`, local);
        actions.appendChild(local);

        if (canRevoke) {
          const revoke = doc.createElement('button');
          revoke.setAttribute('type', 'button');
          revoke.setAttribute(SERVER_SWITCHER_REMOVE_REVOKE_ATTR, '');
          revoke.textContent = removal.busy === 'revoke'
            ? 'Revoking…'
            : 'Take access away and forget';
          if (busy) revoke.setAttribute('disabled', '');
          revoke.addEventListener('click', () => runRemoval('revoke'));
          registerFocusTarget(`remove-revoke:${p.id}`, revoke);
          actions.appendChild(revoke);
        }

        const cancel = doc.createElement('button');
        cancel.setAttribute('type', 'button');
        cancel.setAttribute(SERVER_SWITCHER_REMOVE_CANCEL_ATTR, '');
        cancel.textContent = 'Cancel';
        if (busy) cancel.setAttribute('disabled', '');
        cancel.addEventListener('click', () => {
          if (removal !== null && removal.busy !== null) return;
          removal = null;
          render();
          focusElement(renderedRemoveButtons.get(p.id) ?? null);
        });
        registerFocusTarget(`remove-cancel:${p.id}`, cancel);
        actions.appendChild(cancel);
        if (confirmFocusTarget === null) confirmFocusTarget = cancel;
        confirm.appendChild(actions);
        list.appendChild(confirm);
      }
    }
  };

  render();

  return {
    refresh(
      nextProfiles,
      nextActiveId,
      nextActiveUnreachable,
      nextActiveConnected,
    ) {
      if (disposed) return;
      const activeElement = (
        doc as unknown as { activeElement?: HTMLElement | null }
      ).activeElement ?? null;
      const focusKey = activeElement === null
        ? null
        : renderedFocusKeys.get(activeElement) ?? null;
      let focusWasInside = false;
      if (activeElement !== null) {
        try {
          focusWasInside = root.contains(activeElement);
        } catch {
          focusWasInside = false;
        }
      }
      profiles = nextProfiles;
      activeId = nextActiveId;
      if (nextActiveUnreachable !== undefined) {
        activeUnreachable = nextActiveUnreachable;
      }
      if (nextActiveConnected !== undefined) {
        activeConnected = nextActiveConnected;
      }
      // A sibling may have removed the profile while this choice was open.
      // Do not leave a confirmation for a record that no longer exists.
      const removalProfileDisappeared =
        removal !== null
        && !profiles.some((profile) => profile.id === removal?.id);
      if (removalProfileDisappeared) removal = null;
      const renamedProfileDisappeared =
        rename !== null
        && !profiles.some((profile) => profile.id === rename?.id);
      if (renamedProfileDisappeared) rename = null;
      const switchProfileDisappeared =
        switching !== null
        && !profiles.some((profile) => profile.id === switching?.id);
      if (switchProfileDisappeared) switching = null;
      render();
      if (focusKey !== null) {
        const restoredTarget = renderedFocusTargets.get(focusKey) ?? null;
        if (restoredTarget === null) {
          announcer.textContent =
            'That server profile is no longer saved on this browser.';
        }
        focusElement(restoredTarget ?? list);
      } else if (
        focusWasInside
        && (
          removalProfileDisappeared
          || renamedProfileDisappeared
          || switchProfileDisappeared
        )
      ) {
        announcer.textContent = 'That server profile is no longer saved on this browser.';
        focusElement(list);
      } else if (
        removalProfileDisappeared
        || renamedProfileDisappeared
        || switchProfileDisappeared
      ) {
        announcer.textContent = 'That server profile is no longer saved on this browser.';
      }
    },
    focusProfile(id) {
      if (disposed) return false;
      const target = renderedFocusTargets.get(`item:${id}`) ?? null;
      if (target === null || target.hasAttribute('disabled')) return false;
      focusElement(target);
      return true;
    },
    profileAvailability(id) {
      if (disposed) return 'unavailable';
      const target = renderedFocusTargets.get(`item:${id}`) ?? null;
      if (target === null) return 'missing';
      return target.hasAttribute('disabled') ? 'unavailable' : 'available';
    },
    hasInFlightAction() {
      return !disposed && (
        switching?.busy === true
        || rename?.busy === true
        || (removal !== null && removal.busy !== null)
      );
    },
    /** Drop any idle review — closing must not make a consequential choice
     *  feel pre-confirmed when the Account dialog next opens. */
    disarm() {
      disarmChoices();
      if (!disposed) render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      removal = null;
      rename = null;
      switching = null;
      try {
        opts.host.removeChild(root);
      } catch {
        /* already detached (menu torn down first) — best-effort */
      }
    },
  };
};
