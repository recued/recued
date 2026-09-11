/**
 * §D.L1 — the live-control bubble (shell-frame Step 2).
 *
 * The bell's twin: an ambient, route-independent floating control that mounts
 * once into shell chrome (alongside the 🔔 attention popover) and lives off the
 * realtime bus — NOT inside any route. It replaces the D-181 chat-header
 * "running" bubble (lifted out of `chat/bootstrap-chat-route.ts`) and MERGES the
 * D-186 session-grant "Active passes" surface (ported from the Runs route) into
 * one panel, so the owner sees + controls everything in flight from any screen.
 *
 * Two sections, RUNNING above GRANTS, each with a scope label so "Kill" (a
 * server-wide execution op) is never confused with "Revoke" (a session grant):
 *   RUNNING · server-wide (D-181) — run / queued / detached, with Kill or
 *     Promote+Cancel; the collapsed counter tints to DANGER when one is stalled.
 *   GRANTS  · your active passes (D-177 session grants, surfaced per D-186) —
 *     with Revoke.
 *
 * Ambient: the bubble renders only while the total (running + grants) is > 0
 * (no clutter at idle). Collapsed it is a single `◉ N` counter that expands
 * UPWARD into the panel (it is bottom-anchored, so the panel grows above the
 * button and never displaces it). Both sections are gated on their caller being
 * wired, so a host that passes only one set of callers gets only that section.
 *
 * Mirrors `mountApprovalAttentionPopover` (the bell): owns its host element, its
 * own state (closure vars, no shared route state), its own scoped `render()`,
 * its own bus subscriptions + debounce, and a self-contained `dispose()`.
 */
import type {
  ActiveExecutionEntry,
  ChatToolCallRecord,
  ExecutionActiveRequest,
  ExecutionActiveResponse,
  ExecutionCancelRequest,
  ExecutionCancelResponse,
  ExecutionKillRequest,
  ExecutionKillResponse,
  ExecutionPromoteRequest,
  ExecutionPromoteResponse,
  SessionGrantListRequest,
  SessionGrantListResponse,
  SessionGrantRevokeRequest,
  SessionGrantView,
} from '@recued/contracts';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import type { WebclientReconnectSubscriber } from '../realtime/connection-status.js';
import { serializeChatSessionAddress, serializeLogsRunAddress } from '../shell/route.js';

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + host introspection.
// ════════════════════════════════════════════════════════════════

export const LIVE_CONTROL_BUBBLE_HOST_ATTR = 'data-recued-live-control-bubble';
export const LIVE_CONTROL_BUBBLE_TOGGLE_ATTR =
  'data-recued-live-control-toggle';
export const LIVE_CONTROL_BUBBLE_PANEL_ATTR = 'data-recued-live-control-panel';
export const LIVE_CONTROL_BUBBLE_CLOSE_ATTR = 'data-recued-live-control-close';
/** One running entry row. Carries the control id (run_id / queued_call_id). */
export const LIVE_CONTROL_BUBBLE_RUNNING_ROW_ATTR =
  'data-recued-live-control-running-row';
export const LIVE_CONTROL_BUBBLE_TOOL_ROW_ATTR = 'data-recued-live-control-tool-row';
const TOOL_REVIEW_ATTR = 'data-recued-tool-call-review';
const TOOL_LINK_ATTR = 'data-recued-tool-call-link';
/** A Kill / Cancel / Promote button. Carries the action. */
export const LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR =
  'data-recued-live-control-run-control';
/** One session-grant row. Carries the `contract_id`. */
export const LIVE_CONTROL_BUBBLE_GRANT_ROW_ATTR =
  'data-recued-live-control-grant-row';
/** A Revoke button. Carries the `contract_id`. */
export const LIVE_CONTROL_BUBBLE_GRANT_CONTROL_ATTR =
  'data-recued-live-control-grant-control';
/** A per-section non-terminal control verdict line. Carries the section. */
export const LIVE_CONTROL_BUBBLE_NOTICE_ATTR =
  'data-recued-live-control-notice';

const LIVE_CONTROL_BUBBLE_STYLES_MARKER =
  'data-recued-live-control-bubble-styles';

type LiveControlRunAction = 'kill' | 'promote' | 'cancel';
type LiveControlAction = LiveControlRunAction | 'revoke' | 'review';

const BUSY_CONTROL_LABELS: Readonly<Record<LiveControlAction, string>> = {
  kill: 'Killing…',
  promote: 'Promoting…',
  cancel: 'Cancelling…',
  revoke: 'Revoking…',
  review: 'Saving…',
};

// ════════════════════════════════════════════════════════════════
// Caller seams — typed over the @recued/contracts shapes (same callers
// the Runs route uses, structurally identical). Each section is gated on
// its list caller: RUNNING on `activeCaller`, GRANTS on `grantsListCaller`.
// ════════════════════════════════════════════════════════════════

export type LiveControlActiveCaller = (
  request: ExecutionActiveRequest,
) => Promise<ExecutionActiveResponse>;
export type LiveControlKillCaller = (
  request: ExecutionKillRequest,
) => Promise<ExecutionKillResponse>;
export type LiveControlCancelCaller = (
  request: ExecutionCancelRequest,
) => Promise<ExecutionCancelResponse>;
export type LiveControlPromoteCaller = (
  request: ExecutionPromoteRequest,
) => Promise<ExecutionPromoteResponse>;
export type LiveControlGrantsListCaller = (
  request: SessionGrantListRequest,
) => Promise<SessionGrantListResponse>;
export type LiveControlGrantsRevokeCaller = (
  request: SessionGrantRevokeRequest,
) => Promise<SessionGrantView>;

export interface MountLiveControlBubbleOptions {
  host: HTMLElement;
  document?: Document;
  /** RUNNING section (D-181). Absent `activeCaller` → no RUNNING section. */
  activeCaller?: LiveControlActiveCaller;
  dismissToolCall?: (request: { session_id: string; message_id: string }) => Promise<{ dismissed: boolean }>;
  reconnect?: WebclientReconnectSubscriber;
  killCaller?: LiveControlKillCaller;
  cancelCaller?: LiveControlCancelCaller;
  promoteCaller?: LiveControlPromoteCaller;
  /** GRANTS section (D-186). Absent `grantsListCaller` → no GRANTS section. */
  grantsListCaller?: LiveControlGrantsListCaller;
  grantsRevokeCaller?: LiveControlGrantsRevokeCaller;
  subscribe?: BroadcastSubscriber['on'];
  /** Debounce (ms) for the bus-delta re-list. `<= 0` re-lists immediately. */
  activeRefreshDebounceMs?: number;
  now?: () => number;
}

export interface LiveControlBubbleMount {
  getActiveEntries(): ReadonlyArray<ActiveExecutionEntry>;
  getToolCalls(): ReadonlyArray<ChatToolCallRecord>;
  getSessionGrants(): ReadonlyArray<SessionGrantView>;
  isOpen(): boolean;
  refreshActive(): Promise<void>;
  refreshGrants(): Promise<void>;
  killRun(run_id: string): Promise<void>;
  cancelCall(queued_call_id: string): Promise<void>;
  promoteCall(queued_call_id: string): Promise<void>;
  revokeGrant(contract_id: string): Promise<void>;
  whenLoaded(): Promise<void>;
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Pure helpers — running (mirror the chat bubble + Runs "Active" feed).
// ════════════════════════════════════════════════════════════════

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

const ACTIVE_STATE_LABEL: Record<ActiveExecutionEntry['state'], string> = {
  running: 'Running',
  waiting_slot: 'Queued',
  detached: 'Detached',
  stopping: 'Stopping…',
};

/** Compact elapsed-time formatter (`45s` / `12m` / `3h`); empty when unknown. */
const formatElapsed = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
};

const activeEntryTitle = (entry: ActiveExecutionEntry): string =>
  entry.step_id !== undefined && entry.step_id.length > 0
    ? [entry.recipe_id, entry.step_id].join(' · ')
    : entry.recipe_id;

/** The id a control targets: a queued call cancels / promotes by its
 *  `queued_call_id`; a run / detached job kills by `run_id`. Falls back across
 *  the two so a row always renders even if one id is briefly absent. */
const activeControlId = (entry: ActiveExecutionEntry): string =>
  entry.entry_kind === 'queued-call'
    ? entry.queued_call_id ?? entry.run_id ?? ''
    : entry.run_id ?? '';

// ════════════════════════════════════════════════════════════════
// Pure helpers — grants (ported from the Runs "Active passes" section).
// ════════════════════════════════════════════════════════════════

const PASS_MODE_LABELS: Record<SessionGrantView['grant_mode'], string> = {
  exact: 'one call',
  batch: 'batch',
  open: 'open-ended',
  scoped: 'scoped',
  raw_op: 'direct op',
};

/** Compact duration (`45s` / `12m` / `3h`); `—` when non-positive/unknown. */
const formatWait = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
};

/** "expires in 4m" — recomputed from `expiry_at` at render time (falls back to
 *  the server's `remaining_ttl_ms` snapshot when the row has no `expiry_at`). */
const formatExpiresIn = (grant: SessionGrantView, now: number): string => {
  const remaining =
    grant.expiry_at !== undefined
      ? grant.expiry_at - now
      : grant.remaining_ttl_ms;
  if (remaining === undefined) return 'no expiry';
  if (remaining <= 0) return 'expiring';
  return `expires in ${formatWait(remaining)}`;
};

/** What the pass lets through — prefer the operation(s), else the
 *  ingredient(s); append the bound connection as "via <conn>". */
const passPermitsSummary = (permits: SessionGrantView['permits']): string => {
  const parts: string[] = [];
  const ops = permits.operation_ids ?? [];
  const ingredients = permits.ingredient_ids ?? [];
  if (ops.length > 0) parts.push(ops.join(', '));
  else if (ingredients.length > 0) parts.push(ingredients.join(', '));
  const conns = permits.connection_names ?? [];
  if (conns.length > 0) parts.push(`via ${conns.join(', ')}`);
  return parts.join(' ');
};

/** The remaining budget — a batch grant's count is its items; everything else
 *  shows uses-left. Empty when unbounded (defensive). */
const passBudgetSummary = (grant: SessionGrantView): string => {
  if (grant.grant_mode === 'batch' && grant.member_count !== undefined) {
    return grant.uses_remaining !== undefined &&
      grant.uses_remaining !== grant.member_count
      ? `${grant.uses_remaining}/${grant.member_count} items left`
      : `${grant.member_count} item${grant.member_count === 1 ? '' : 's'}`;
  }
  if (grant.uses_remaining !== undefined && grant.max_uses !== undefined) {
    return `${grant.uses_remaining}/${grant.max_uses} uses left`;
  }
  return '';
};

const LIVE_CONTROL_BUBBLE_STYLES = `
/* Bottom-anchored, route-independent shell chrome. §D.L1 wants it "by the
   chatbox, growing UPWARD": the panel sits ABOVE the button (last DOM child) so
   opening grows the bubble upward without moving the counter, and the container
   is pinned to the bottom edge — right-aligned to the centered content column
   (--wc-content-max, where the chat composer lives) rather than the far viewport
   corner, so on the chat home it reads as attached to the chatbox. On a viewport
   narrower than the column the max() clamps it to 16px from the edge.
   pointer-events:none lets clicks fall through the empty gap above the collapsed
   button; children re-arm. */
[${LIVE_CONTROL_BUBBLE_HOST_ATTR}] {
  position: fixed;
  right: max(16px, calc(50% - var(--wc-content-max, 1080px) / 2 + 16px));
  bottom: 16px;
  z-index: 55;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-height: calc(100vh - 32px);
  pointer-events: none;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
[${LIVE_CONTROL_BUBBLE_TOGGLE_ATTR}] {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--fg);
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.16);
}
[${LIVE_CONTROL_BUBBLE_TOGGLE_ATTR}][aria-expanded="true"] {
  border-color: var(--accent);
}
/* Stalled / needs-attention → DANGER tint on the collapsed counter. */
[${LIVE_CONTROL_BUBBLE_TOGGLE_ATTR}][data-stalled="true"] {
  border-color: var(--fail);
  color: var(--fail);
}
[${LIVE_CONTROL_BUBBLE_PANEL_ATTR}] {
  pointer-events: auto;
  box-sizing: border-box;
  width: min(360px, calc(100vw - 32px));
  max-height: min(60vh, 520px);
  overflow-y: auto;
  overscroll-behavior: contain;
  display: grid;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  padding: 12px 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
}
[${LIVE_CONTROL_BUBBLE_PANEL_ATTR}] .lc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
[${LIVE_CONTROL_BUBBLE_PANEL_ATTR}] .lc-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
[${LIVE_CONTROL_BUBBLE_CLOSE_ATTR}] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
[${LIVE_CONTROL_BUBBLE_CLOSE_ATTR}]:hover {
  background: var(--surface-subtle);
  color: var(--fg);
}
[${LIVE_CONTROL_BUBBLE_PANEL_ATTR}] .lc-section {
  display: grid;
  gap: 6px;
}
[${LIVE_CONTROL_BUBBLE_PANEL_ATTR}] .lc-section-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
[${LIVE_CONTROL_BUBBLE_PANEL_ATTR}] .lc-section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
}
[${LIVE_CONTROL_BUBBLE_PANEL_ATTR}] .lc-section-scope {
  font-size: 11px;
  color: var(--muted);
}
[${LIVE_CONTROL_BUBBLE_NOTICE_ATTR}] {
  font-size: 12px;
  color: var(--muted);
}
[${LIVE_CONTROL_BUBBLE_RUNNING_ROW_ATTR}],
[${LIVE_CONTROL_BUBBLE_GRANT_ROW_ATTR}] {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  border-top: 1px solid var(--border-subtle);
  padding-top: 6px;
}
[${LIVE_CONTROL_BUBBLE_RUNNING_ROW_ATTR}]:first-of-type,
[${LIVE_CONTROL_BUBBLE_GRANT_ROW_ATTR}]:first-of-type {
  border-top: none;
  padding-top: 0;
}
[${LIVE_CONTROL_BUBBLE_PANEL_ATTR}] .lc-row-title {
  font-size: 13px;
  font-weight: 650;
}
[${LIVE_CONTROL_BUBBLE_PANEL_ATTR}] .lc-row-meta {
  font-size: 12px;
  color: var(--muted);
}
[${LIVE_CONTROL_BUBBLE_PANEL_ATTR}] .lc-row-controls {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
[${LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR}],
[${LIVE_CONTROL_BUBBLE_GRANT_CONTROL_ATTR}],
[${TOOL_REVIEW_ATTR}],
[${TOOL_LINK_ATTR}] {
  min-width: 36px;
  min-height: 36px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
[${TOOL_LINK_ATTR}] {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
  box-sizing: border-box;
}
[${LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR}][data-danger="true"],
[${LIVE_CONTROL_BUBBLE_GRANT_CONTROL_ATTR}][data-danger="true"] {
  border-color: var(--fail);
  color: var(--fail);
}
[${LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR}][aria-disabled="true"],
[${LIVE_CONTROL_BUBBLE_GRANT_CONTROL_ATTR}][aria-disabled="true"],
[${TOOL_REVIEW_ATTR}][aria-disabled="true"] {
  opacity: 0.55;
  cursor: default;
}
@media (prefers-reduced-motion: no-preference) {
  [${LIVE_CONTROL_BUBBLE_TOGGLE_ATTR}] {
    transition: border-color 90ms ease, color 90ms ease;
  }
}
`;

export const mountLiveControlBubble = (
  opts: MountLiveControlBubbleOptions,
): LiveControlBubbleMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountLiveControlBubble: no document available - pass `opts.document` for non-browser environments',
    );
  }

  if (
    doc.head.querySelector(`style[${LIVE_CONTROL_BUBBLE_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(LIVE_CONTROL_BUBBLE_STYLES_MARKER, '');
    style.textContent = LIVE_CONTROL_BUBBLE_STYLES;
    doc.head.appendChild(style);
  }

  const bubbleRoot = doc.createElement('div');
  bubbleRoot.setAttribute(LIVE_CONTROL_BUBBLE_HOST_ATTR, '');
  opts.host.appendChild(bubbleRoot);

  const hasRunning = opts.activeCaller !== undefined;
  const hasGrants = opts.grantsListCaller !== undefined;
  const debounceMs = opts.activeRefreshDebounceMs ?? 250;
  const nowMs = (): number => opts.now?.() ?? Date.now();

  // ── State (closure-owned; no shared route state) ───────────────────
  let disposed = false;
  let expanded = false;
  // running
  let activeEntries: ReadonlyArray<ActiveExecutionEntry> = [];
  let toolCalls: ReadonlyArray<ChatToolCallRecord> = [];
  const reviewingCalls = new Set<string>();
  let activeNotice: string | null = null;
  let activeSeq = 0;
  const busyControlActions = new Map<string, LiveControlRunAction>();
  let activeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingActiveLoad: Promise<void> = Promise.resolve();
  // grants
  let sessionGrants: ReadonlyArray<SessionGrantView> = [];
  let grantsNotice: string | null = null;
  let grantsSeq = 0;
  const busyGrantIds = new Set<string>();
  let grantsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingGrantsLoad: Promise<void> = Promise.resolve();
  const unsubscribers: Array<() => void> = [];
  const closeFocusKey = 'close';
  const toggleFocusKey = 'toggle';
  let requestedFocusKey: string | null = null;
  const renderedFocusTargets = new Map<string, HTMLElement>();
  const renderedRunFocusKeys: string[] = [];
  const renderedGrantFocusKeys: string[] = [];

  const visibleActiveEntries = (): ReadonlyArray<ActiveExecutionEntry> => activeEntries.filter(entry =>
    entry.entry_kind !== 'run' || !toolCalls.some(call =>
      call.run_id === entry.run_id && call.state !== 'interrupted'));
  const totalCount = (): number => visibleActiveEntries().length + toolCalls.length + sessionGrants.length;

  const clearChildren = (node: HTMLElement): void => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  const controlFocusKey = (
    attr: string,
    action: string,
    id: string,
  ): string => JSON.stringify([attr, action, id]);

  const focusKeyForElement = (
    element: Element | null | undefined,
  ): string | null => {
    if (element === null || element === undefined) return null;
    if (!bubbleRoot.contains(element)) return null;
    if (element.hasAttribute(LIVE_CONTROL_BUBBLE_CLOSE_ATTR)) {
      return closeFocusKey;
    }
    if (element.hasAttribute(LIVE_CONTROL_BUBBLE_TOGGLE_ATTR)) {
      return toggleFocusKey;
    }
    for (const attr of [
      LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR,
      LIVE_CONTROL_BUBBLE_GRANT_CONTROL_ATTR,
      TOOL_REVIEW_ATTR,
      TOOL_LINK_ATTR,
    ]) {
      const action = element.getAttribute(attr);
      const id = element.getAttribute('data-id');
      if (action !== null && id !== null) {
        return controlFocusKey(attr, action, id);
      }
    }
    return null;
  };

  // ── Render ─────────────────────────────────────────────────────────
  const appendControl = (
    controls: HTMLElement,
    rowAttr: string,
    action: LiveControlAction,
    id: string,
    label: string,
    ownerLabel: string,
    danger: boolean,
    guarded: boolean,
    busy: boolean,
    onClick: () => void,
  ): void => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute(rowAttr, action);
    button.setAttribute('data-id', id);
    button.setAttribute('data-danger', danger ? 'true' : 'false');
    const visibleLabel = busy ? BUSY_CONTROL_LABELS[action] : label;
    button.textContent = visibleLabel;
    button.setAttribute(
      'aria-label',
      `${visibleLabel} ${ownerLabel} (${id})`,
    );
    if (guarded) button.setAttribute('aria-disabled', 'true');
    if (busy) button.setAttribute('aria-busy', 'true');
    const focusKey = controlFocusKey(rowAttr, action, id);
    renderedFocusTargets.set(focusKey, button);
    if (rowAttr === LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR || rowAttr === TOOL_REVIEW_ATTR) {
      renderedRunFocusKeys.push(focusKey);
    } else if (rowAttr === LIVE_CONTROL_BUBBLE_GRANT_CONTROL_ATTR) {
      renderedGrantFocusKeys.push(focusKey);
    }
    button.addEventListener('click', () => {
      if (!guarded) onClick();
    });
    controls.appendChild(button);
  };

  const buildSectionHead = (title: string, scope: string): HTMLElement => {
    const head = doc.createElement('div');
    head.className = 'lc-section-head';
    const h = doc.createElement('h3');
    h.className = 'lc-section-title';
    h.textContent = title;
    head.appendChild(h);
    const s = doc.createElement('span');
    s.className = 'lc-section-scope';
    s.textContent = scope;
    head.appendChild(s);
    return head;
  };

  const appendNotice = (
    section: HTMLElement,
    which: 'running' | 'grants',
    text: string,
  ): void => {
    const notice = doc.createElement('div');
    notice.setAttribute(LIVE_CONTROL_BUBBLE_NOTICE_ATTR, which);
    notice.setAttribute('role', 'status');
    notice.textContent = text;
    section.appendChild(notice);
  };

  const buildRunningSection = (): HTMLElement => {
    const section = doc.createElement('div');
    section.className = 'lc-section';
    section.appendChild(buildSectionHead('Running', 'server-wide'));
    if (activeNotice !== null) appendNotice(section, 'running', activeNotice);
    const now = nowMs();
    for (const entry of visibleActiveEntries()) {
      const id = activeControlId(entry);
      const ownerLabel = activeEntryTitle(entry);
      const row = doc.createElement('div');
      row.setAttribute(LIVE_CONTROL_BUBBLE_RUNNING_ROW_ATTR, id);
      row.setAttribute(
        'data-stalled',
        entry.progress.stalled === true ? 'true' : 'false',
      );

      const title = doc.createElement('span');
      title.className = 'lc-row-title';
      title.textContent = ownerLabel;
      row.appendChild(title);

      const meta = doc.createElement('span');
      meta.className = 'lc-row-meta';
      const sinceTs = entry.slot_acquired_at ?? entry.started_at;
      const metaParts: string[] = [
        ACTIVE_STATE_LABEL[entry.state],
        entry.origin,
      ];
      const elapsed =
        Number.isFinite(now) && now >= sinceTs
          ? formatElapsed(now - sinceTs)
          : '';
      if (elapsed !== '') metaParts.push(elapsed);
      if (entry.progress.stalled === true) metaParts.push('stalled');
      meta.textContent = metaParts.join(' · ');
      row.appendChild(meta);

      if (id !== '') {
        const busyAction = busyControlActions.get(id);
        const guarded = busyAction !== undefined;
        const controls = doc.createElement('span');
        controls.className = 'lc-row-controls';
        if (
          entry.entry_kind === 'queued-call' &&
          entry.queued_call_id !== undefined
        ) {
          appendControl(
            controls,
            LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR,
            'promote',
            id,
            'Promote',
            ownerLabel,
            false,
            guarded,
            busyAction === 'promote',
            () => void promoteCall(id),
          );
          appendControl(
            controls,
            LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR,
            'cancel',
            id,
            'Cancel',
            ownerLabel,
            true,
            guarded,
            busyAction === 'cancel',
            () => void cancelCall(id),
          );
        } else if (entry.run_id !== undefined && entry.run_id.length > 0) {
          appendControl(
            controls,
            LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR,
            'kill',
            id,
            'Kill',
            ownerLabel,
            true,
            guarded,
            busyAction === 'kill',
            () => void killRun(id),
          );
        }
        if (controls.children.length > 0) row.appendChild(controls);
      }
      section.appendChild(row);
    }
    return section;
  };

  const buildGrantsSection = (): HTMLElement => {
    const section = doc.createElement('div');
    section.className = 'lc-section';
    section.appendChild(buildSectionHead('Active passes', 'your grants'));
    if (grantsNotice !== null) appendNotice(section, 'grants', grantsNotice);
    const now = nowMs();
    for (const grant of sessionGrants) {
      const row = doc.createElement('div');
      row.setAttribute(LIVE_CONTROL_BUBBLE_GRANT_ROW_ATTR, grant.contract_id);
      row.setAttribute('data-grant-mode', grant.grant_mode);

      const title = doc.createElement('span');
      title.className = 'lc-row-title';
      title.textContent = grant.display_name;
      row.appendChild(title);

      const meta = doc.createElement('span');
      meta.className = 'lc-row-meta';
      const permits = passPermitsSummary(grant.permits);
      const budget = passBudgetSummary(grant);
      const metaParts: string[] = [PASS_MODE_LABELS[grant.grant_mode]];
      if (permits.length > 0) metaParts.push(permits);
      metaParts.push(formatExpiresIn(grant, now));
      if (budget.length > 0) metaParts.push(budget);
      meta.textContent = metaParts.join(' · ');
      row.appendChild(meta);

      const controls = doc.createElement('span');
      controls.className = 'lc-row-controls';
      appendControl(
        controls,
        LIVE_CONTROL_BUBBLE_GRANT_CONTROL_ATTR,
        'revoke',
        grant.contract_id,
        'Revoke',
        grant.display_name,
        true,
        busyGrantIds.has(grant.contract_id),
        busyGrantIds.has(grant.contract_id),
        () => void revokeGrant(grant.contract_id),
      );
      row.appendChild(controls);
      section.appendChild(row);
    }
    return section;
  };

  const buildPanel = (): HTMLElement => {
    const panel = doc.createElement('section');
    panel.setAttribute(LIVE_CONTROL_BUBBLE_PANEL_ATTR, '');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Live control');

    const head = doc.createElement('div');
    head.className = 'lc-head';
    const title = doc.createElement('span');
    title.className = 'lc-title';
    title.textContent = 'Live control';
    head.appendChild(title);
    const close = doc.createElement('button');
    close.type = 'button';
    close.setAttribute(LIVE_CONTROL_BUBBLE_CLOSE_ATTR, '');
    close.setAttribute('aria-label', 'Close live control');
    close.textContent = '✕'; // ✕
    close.addEventListener('click', () => setExpanded(false, toggleFocusKey));
    renderedFocusTargets.set(closeFocusKey, close);
    head.appendChild(close);
    panel.appendChild(head);

    // RUNNING above GRANTS — only the non-empty sections render (ambient).
    if (toolCalls.length > 0) panel.appendChild(buildToolCallsSection());
    if (visibleActiveEntries().length > 0) panel.appendChild(buildRunningSection());
    if (sessionGrants.length > 0) panel.appendChild(buildGrantsSection());
    return panel;
  };

  const buildToolCallsSection = (): HTMLElement => {
    const section = doc.createElement('div');
    section.className = 'lc-section';
    section.appendChild(buildSectionHead('Tool calls', 'your chats'));
    if (activeNotice !== null) appendNotice(section, 'running', activeNotice);
    const rememberLink = (link: HTMLElement, action: string, id: string): void => {
      link.setAttribute(TOOL_LINK_ATTR, action);
      link.setAttribute('data-id', id);
      const key = controlFocusKey(TOOL_LINK_ATTR, action, id);
      renderedFocusTargets.set(key, link);
      renderedRunFocusKeys.push(key);
    };
    for (const call of toolCalls) {
      const row = doc.createElement('div');
      row.setAttribute(LIVE_CONTROL_BUBBLE_RUNNING_ROW_ATTR, call.message_id);
      row.setAttribute(LIVE_CONTROL_BUBBLE_TOOL_ROW_ATTR, call.message_id);
      const live = call.state === 'interrupted' ? undefined : activeEntries.find(entry =>
        entry.entry_kind === 'run' && entry.run_id === call.run_id);
      const title = doc.createElement('span');
      title.className = 'lc-row-title';
      title.textContent = call.tool_name;
      row.appendChild(title);
      const meta = doc.createElement('span');
      meta.className = 'lc-row-meta';
      const state = live ? ACTIVE_STATE_LABEL[live.state]
        : call.state === 'interrupted' ? 'Interrupted — outcome unconfirmed'
          : call.state === 'held' ? 'Waiting for a result' : 'Running';
      const lastSignal = live?.progress.last_signal_at ?? call.last_signal_at;
      meta.textContent = [state,
        ...(lastSignal === undefined ? [] : [`last progress ${formatElapsed(nowMs() - lastSignal)} ago`]),
        ...(live?.progress.stalled || call.stalled ? ['stalled'] : []),
      ].join(' · ');
      row.appendChild(meta);
      const controls = doc.createElement('span');
      controls.className = 'lc-row-controls';
      const chatLink = doc.createElement('a');
      chatLink.textContent = 'Open chat';
      chatLink.setAttribute('href', serializeChatSessionAddress({ sessionId: call.session_id }));
      rememberLink(chatLink, 'chat', call.message_id);
      controls.appendChild(chatLink);
      if (call.state === 'held' && call.run_id) {
        const detail = doc.createElement('a');
        detail.textContent = 'View execution';
        detail.setAttribute('href', serializeLogsRunAddress({ runId: call.run_id }));
        rememberLink(detail, 'execution', call.message_id);
        controls.appendChild(detail);
      }
      if (live?.run_id && opts.killCaller) {
        const id = live.run_id;
        appendControl(controls, LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR, 'kill', id,
          'Kill', call.tool_name, true, busyControlActions.has(id),
          busyControlActions.get(id) === 'kill', () => void killRun(id));
      }
      if (call.state === 'interrupted' && opts.dismissToolCall) {
        appendControl(controls, TOOL_REVIEW_ATTR, 'review', call.message_id,
          'Mark reviewed', call.tool_name, false, reviewingCalls.has(call.message_id),
          reviewingCalls.has(call.message_id), () => {
          if (reviewingCalls.has(call.message_id)) return;
          reviewingCalls.add(call.message_id);
          render();
          void opts.dismissToolCall!({ session_id: call.session_id, message_id: call.message_id })
            .catch(error => { activeNotice = errMessage(error); })
            .finally(async () => {
              await loadActive();
              reviewingCalls.delete(call.message_id);
              render();
            });
        });
      }
      row.appendChild(controls);
      section.appendChild(row);
    }
    return section;
  };

  const render = (): void => {
    if (disposed) return;
    const preservedFocusKey =
      requestedFocusKey ?? focusKeyForElement(doc.activeElement);
    const previousRunIndex = preservedFocusKey === null
      ? -1
      : renderedRunFocusKeys.indexOf(preservedFocusKey);
    const previousGrantIndex = preservedFocusKey === null
      ? -1
      : renderedGrantFocusKeys.indexOf(preservedFocusKey);
    requestedFocusKey = null;
    renderedFocusTargets.clear();
    renderedRunFocusKeys.length = 0;
    renderedGrantFocusKeys.length = 0;
    clearChildren(bubbleRoot);
    const total = totalCount();
    if (total === 0) return; // ambient: nothing in flight → no bubble
    if (expanded) bubbleRoot.appendChild(buildPanel());
    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.setAttribute(LIVE_CONTROL_BUBBLE_TOGGLE_ATTR, '');
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.setAttribute('aria-label', 'Live control');
    const anyStalled = activeEntries.some(
      (entry) => entry.progress.stalled === true,
    ) || toolCalls.some(call => call.state === 'running' && call.stalled === true);
    toggle.setAttribute('data-stalled', anyStalled ? 'true' : 'false');
    // Built via join so no `${a} ${b}` template-literal interpolation sits at a
    // space boundary (a known Write/Edit NUL-corruption site).
    toggle.textContent = ['◉', String(total)].join(' ');
    toggle.addEventListener('click', () => {
      const next = !expanded;
      setExpanded(next, next ? closeFocusKey : toggleFocusKey);
    });
    renderedFocusTargets.set(toggleFocusKey, toggle);
    bubbleRoot.appendChild(toggle);
    let resolvedFocusKey = preservedFocusKey;
    if (
      resolvedFocusKey !== null
      && !renderedFocusTargets.has(resolvedFocusKey)
    ) {
      const survivingKeys = previousRunIndex >= 0
        ? renderedRunFocusKeys
        : previousGrantIndex >= 0
          ? renderedGrantFocusKeys
          : [];
      const previousIndex = previousRunIndex >= 0
        ? previousRunIndex
        : previousGrantIndex;
      resolvedFocusKey = survivingKeys.length > 0
        ? survivingKeys[Math.min(previousIndex, survivingKeys.length - 1)]!
        : expanded
          ? closeFocusKey
          : toggleFocusKey;
    }
    const focusTarget = resolvedFocusKey === null
      ? null
      : renderedFocusTargets.get(resolvedFocusKey) ?? null;
    focusTarget?.focus({ preventScroll: true });
  };

  // ── Open / close ───────────────────────────────────────────────────
  const setExpanded = (
    next: boolean,
    focusKey: string,
  ): void => {
    expanded = next;
    requestedFocusKey = focusKey;
    if (!next) {
      activeNotice = null;
      grantsNotice = null;
    }
    render();
    if (next) {
      if (hasRunning) void loadActive();
      if (hasGrants) void loadGrants();
    }
  };

  // After any re-list: drop a drained section's stale notice (PER section, so a
  // finished run's verdict can't reattach to an unrelated later row even while
  // the other section stays populated), and collapse the panel only once
  // EVERYTHING is gone (ambient — the next thing in flight re-appears collapsed).
  const reconcileEmpty = (): void => {
    if (activeEntries.length === 0 && toolCalls.length === 0) activeNotice = null;
    if (sessionGrants.length === 0) grantsNotice = null;
    if (totalCount() === 0) expanded = false;
  };

  // ── RUNNING loaders + actions (lifted from the chat bubble) ─────────
  const loadActive = (): Promise<void> => {
    if (opts.activeCaller === undefined || disposed) return Promise.resolve();
    const seq = ++activeSeq;
    const caller = opts.activeCaller;
    pendingActiveLoad = (async () => {
      try {
        const response = await caller({});
        if (disposed || seq !== activeSeq) return;
        activeEntries = response.entries;
        toolCalls = response.tool_calls ?? [];
        reconcileEmpty();
        render();
      } catch {
        /* soft signal — keep the prior list; the next delta / poll retries */
      }
    })();
    return pendingActiveLoad;
  };

  const scheduleActiveRefresh = (): void => {
    if (opts.activeCaller === undefined || disposed) return;
    if (debounceMs <= 0) {
      void loadActive();
      return;
    }
    if (activeRefreshTimer !== null) clearTimeout(activeRefreshTimer);
    activeRefreshTimer = setTimeout(() => {
      activeRefreshTimer = null;
      void loadActive();
    }, debounceMs);
  };

  // Run one live-control mutation, then re-list. The pending action remains
  // focusable while every control for its entry is guarded; `noticed` surfaces
  // the server's non-terminal verdict so a no-op click is legible rather than
  // silent.
  const runControl = async (
    action: LiveControlRunAction,
    busyId: string,
    op: () => Promise<{ noticed?: string } | void>,
  ): Promise<void> => {
    if (busyId.length === 0 || busyControlActions.has(busyId)) return;
    busyControlActions.set(busyId, action);
    activeNotice = null;
    render();
    try {
      const result = await op();
      if (disposed) return;
      activeNotice =
        result && result.noticed !== undefined ? result.noticed : null;
      render();
    } catch (err) {
      if (disposed) return;
      activeNotice = errMessage(err);
      render();
    } finally {
      // Hold the busy flag THROUGH the re-list (no flash-of-enabled), then
      // clear + force a render — `loadActive` soft-fails without rendering, so
      // an unconditional render here is what re-enables the button on that path
      // (mirrors `revokeGrant`). Matches the row staying guarded until settled.
      if (!disposed) await loadActive();
      busyControlActions.delete(busyId);
      if (!disposed) render();
    }
  };

  const killRun = (run_id: string): Promise<void> =>
    runControl('kill', run_id, async () => {
      if (opts.killCaller === undefined) {
        return { noticed: 'Kill is not available in this view.' };
      }
      const { status } = await opts.killCaller({ run_id });
      if (status === 'killed') return;
      return {
        noticed:
          status === 'already_terminal'
            ? 'That run already finished.'
            : 'That run is no longer active.',
      };
    });

  const cancelCall = (queued_call_id: string): Promise<void> =>
    runControl('cancel', queued_call_id, async () => {
      if (opts.cancelCaller === undefined) {
        return { noticed: 'Cancel is not available in this view.' };
      }
      const { status } = await opts.cancelCaller({ queued_call_id });
      if (status === 'cancelled_before_dispatch') return;
      return {
        noticed:
          status === 'already_dispatched'
            ? 'That call already started — use Kill instead.'
            : 'That queued call is no longer waiting.',
      };
    });

  const promoteCall = (queued_call_id: string): Promise<void> =>
    runControl('promote', queued_call_id, async () => {
      if (opts.promoteCaller === undefined) {
        return { noticed: 'Promote is not available in this view.' };
      }
      const { status } = await opts.promoteCaller({ queued_call_id });
      if (status === 'promoted') return;
      return { noticed: 'That queued call is no longer waiting.' };
    });

  // ── GRANTS loaders + actions (ported from the Runs route) ──────────
  const loadGrants = (): Promise<void> => {
    if (opts.grantsListCaller === undefined || disposed) {
      return Promise.resolve();
    }
    const seq = ++grantsSeq;
    const caller = opts.grantsListCaller;
    pendingGrantsLoad = (async () => {
      try {
        // Owner view — empty request: the bubble is the owner's cross-session
        // surface, so the server returns every ACTIVE session grant owner-wide.
        const response = await caller({});
        if (disposed || seq !== grantsSeq) return;
        sessionGrants = response.grants;
        reconcileEmpty();
        render();
      } catch (err) {
        if (disposed || seq !== grantsSeq) return;
        grantsNotice = errMessage(err);
        render();
      }
    })();
    return pendingGrantsLoad;
  };

  const scheduleGrantsRefresh = (): void => {
    if (opts.grantsListCaller === undefined || disposed) return;
    if (debounceMs <= 0) {
      void loadGrants();
      return;
    }
    if (grantsRefreshTimer !== null) clearTimeout(grantsRefreshTimer);
    grantsRefreshTimer = setTimeout(() => {
      grantsRefreshTimer = null;
      void loadGrants();
    }, debounceMs);
  };

  const revokeGrant = async (contract_id: string): Promise<void> => {
    if (contract_id.length === 0 || busyGrantIds.has(contract_id)) return;
    busyGrantIds.add(contract_id);
    grantsNotice = null;
    render();
    try {
      if (opts.grantsRevokeCaller === undefined) {
        grantsNotice = 'Revoke is not available in this view.';
        return;
      }
      await opts.grantsRevokeCaller({ contract_id });
      // Success stays silent — the row drops on the re-list below (and the
      // server's `contract.contract_definition_changed` broadcast re-lists
      // every other paired client).
    } catch (err) {
      if (disposed) return;
      grantsNotice = errMessage(err);
    } finally {
      // Hold the busy flag THROUGH the re-list so the row stays disabled until
      // it drops off (no flash-of-enabled-button → no duplicate revoke rpc).
      if (!disposed) await loadGrants();
      busyGrantIds.delete(contract_id);
      if (!disposed) render();
    }
  };

  // ── Bus + boot ─────────────────────────────────────────────────────
  if (opts.subscribe !== undefined) {
    if (hasRunning) {
      unsubscribers.push(
        opts.subscribe('execution', (event) => {
          if (disposed) return;
          // Skip the high-frequency, non-membership progress op — a stall /
          // start / complete changes the list, a progress tick does not.
          if (event.op === 'progress' && toolCalls.length === 0) return;
          scheduleActiveRefresh();
        }),
      );
      for (const kind of ['chat.tool_call_started', 'chat.tool_call_completed', 'chat.message_complete', 'chat.session_changed'] as const) {
        unsubscribers.push(opts.subscribe(kind, () => scheduleActiveRefresh()));
      }
    }
    if (hasGrants) {
      unsubscribers.push(
        // The authoritative mint/revoke signal — fired by the session-grant
        // resolver on a gate mint and by `session_grant.revoke`. Debounced.
        opts.subscribe('contract.contract_definition_changed', () => {
          if (disposed) return;
          scheduleGrantsRefresh();
        }),
      );
    }
  }

  render();
  if (opts.reconnect) unsubscribers.push(opts.reconnect(() => {
    void loadActive();
    void loadGrants();
  }));
  if (hasRunning) void loadActive();
  if (hasGrants) void loadGrants();

  return {
    getActiveEntries: () => activeEntries,
    getToolCalls: () => toolCalls,
    getSessionGrants: () => sessionGrants,
    isOpen: () => expanded,
    refreshActive: loadActive,
    refreshGrants: loadGrants,
    killRun,
    cancelCall,
    promoteCall,
    revokeGrant,
    whenLoaded: async () => {
      await Promise.all([pendingActiveLoad, pendingGrantsLoad]);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (activeRefreshTimer !== null) {
        clearTimeout(activeRefreshTimer);
        activeRefreshTimer = null;
      }
      if (grantsRefreshTimer !== null) {
        clearTimeout(grantsRefreshTimer);
        grantsRefreshTimer = null;
      }
      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch {
          // Route-independent teardown is best effort; DOM removal continues.
        }
      }
      unsubscribers.length = 0;
      try {
        opts.host.removeChild(bubbleRoot);
      } catch {
        try {
          bubbleRoot.remove();
        } catch {
          // Detached fake DOMs can throw. The host is already inert.
        }
      }
    },
  };
};
