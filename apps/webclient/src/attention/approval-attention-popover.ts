/** D-174 - global approval attention popover for the webclient.
 *
 *  The shared top-bar attention slot is a pure string renderer. This
 *  adapter gives the webclient a small persistent DOM host and wires
 *  the blocking attention union: approval gates, gateway asks, durable
 *  pending Chat plans, and unresolved connection-recovery checks/reopens.
 *  Reception INBOX awaiting_approval holds surface here through their
 *  gateway.preflight ask rows in notification.pending_asks.
 *  reception_approval_intent is intentionally excluded: it is a
 *  visitor-to-engine flow with no user-pending state.
 */

import { CONNECTION_NAME_REGEX } from '@recued/ui-shared';
import { renderAttentionSlot } from '@recued/ui-shared/top-bar';
import {
  CONNECTION_AUTH_TYPES,
  connectionCredentialRejectionCorrection,
} from '@recued/contracts';
import type {
  ConnectionKind,
  ConnectionView,
  ServerPendingApproval,
  ServerPendingAsk,
} from '@recued/contracts';

import type {
  ApprovalChangedSubscriber,
  ApprovalListCaller,
  ApprovalResolveCaller,
  ApprovalSubscribeCaller,
} from '../approvals/bootstrap-approvals-route.js';
import type {
  AsksListCaller,
  AsksSubmitAnswerCaller,
} from '../approvals/asks-panel.js';
import {
  pendingChatPlanHref,
  pendingChatPlanResolutionCopy,
  type PendingChatPlan,
  type PendingChatPlanResolution,
  type PendingChatPlansStoreState,
} from '../approvals/pending-chat-plans-store.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import type { WebclientReconnectSubscriber } from '../realtime/connection-status.js';
import type {
  ConnectionsEnrollListCaller,
} from '../settings/connections-enroll-panel.js';
import type {
  ProfileBoundPostSafeStopRecoveryTarget,
} from '../connections/bootstrap-connections-route.js';
import {
  classifyRpcError,
  resolveSurfaceErrorDisplay,
  type SurfaceErrorEntry,
} from '../shell/rpc-error-copy.js';

export const ATTENTION_TOPBAR_HOST_ATTR = 'data-recued-attention-topbar';
export const ATTENTION_TOPBAR_STYLES_MARKER =
  'data-recued-attention-topbar-styles';
export const ATTENTION_SEE_ALL_LINK_ATTR =
  'data-recued-attention-see-all-link';
export const ATTENTION_ERROR_ATTR = 'data-recued-attention-error';
export const ATTENTION_ERROR_ANNOUNCER_ATTR =
  'data-recued-attention-error-announcer';
export const ATTENTION_GATEWAY_ASK_ROW_ATTR =
  'data-recued-attention-gateway-ask';
export const ATTENTION_CHAT_PLAN_LINK_ATTR =
  'data-recued-attention-chat-plan-link';
export const ATTENTION_CHAT_PLAN_RESOLUTION_ATTR =
  'data-recued-attention-chat-plan-resolution';
export const ATTENTION_CHAT_PLAN_RESOLUTION_ANNOUNCER_ATTR =
  'data-recued-attention-chat-plan-resolution-announcer';
export const ATTENTION_CONNECTION_RECOVERY_LINK_ATTR =
  'data-recued-attention-connection-recovery-link';
export const ATTENTION_INACTIVE_PROFILE_RECOVERY_ATTR =
  'data-recued-attention-inactive-profile-recovery';
export const ATTENTION_CONNECTION_RECOVERY_REVIEW_ATTR =
  'data-recued-attention-connection-recovery-review';
export const ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR =
  'data-recued-attention-recovery-excursion-return';
export const ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR =
  'data-recued-attention-recovery-excursion-return-announcer';
export const ATTENTION_RECOVERY_INTENT_CONTINUATION_ATTR =
  'data-recued-attention-recovery-intent-continuation';
export const ATTENTION_CONNECTIONS_LINK_ATTR =
  'data-recued-attention-connections-link';
export const ATTENTION_DIALOG_ATTR = 'data-recued-attention-dialog';
export const ATTENTION_CLOSE_BUTTON_ATTR =
  'data-recued-attention-close-button';

export const ATTENTION_TOPBAR_STYLES = `
[${ATTENTION_TOPBAR_HOST_ATTR}] {
  position: static;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  box-sizing: border-box;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] *,
[${ATTENTION_TOPBAR_HOST_ATTR}] *::before,
[${ATTENTION_TOPBAR_HOST_ATTR}] *::after {
  box-sizing: border-box;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .webclient-attention-anchor {
  position: relative;
  display: flex;
  align-items: center;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .top-bar-attention {
  position: relative;
  display: inline-flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border, #e4e4e7);
  border-radius: 8px;
  background: var(--surface, #ffffff);
  color: var(--fg-muted, #71717a);
  cursor: pointer;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .top-bar-attention--active {
  border-color: var(--accent, #0e7490);
  background: var(--accent-weak, rgba(14, 116, 144, 0.10));
  color: var(--accent, #0e7490);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .top-bar-attention--open {
  box-shadow: 0 0 0 3px var(--accent-weak, rgba(14, 116, 144, 0.10));
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .top-bar-attention:focus-visible,
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-popover-close:focus-visible,
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-action:focus-visible,
[${ATTENTION_TOPBAR_HOST_ATTR}] .webclient-attention-footer a:focus-visible {
  outline: 2px solid var(--accent, #0e7490);
  outline-offset: 2px;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .top-bar-attention-glyph {
  display: inline-flex;
  width: 18px;
  height: 18px;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .top-bar-attention-glyph svg {
  display: block;
  width: 100%;
  height: 100%;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .top-bar-attention-badge {
  display: inline-flex;
  min-width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  padding: 0 5px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  background: var(--danger, #dc2626);
  color: var(--on-danger, #ffffff);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .top-bar-attention-badge {
  position: absolute;
  top: -5px;
  right: -5px;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .webclient-attention-popover-frame {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 80;
  display: flex;
  flex-direction: column;
  width: min(380px, calc(100vw - 32px));
  max-height: min(560px, calc(100vh - 80px));
  overflow: hidden;
  border: 1px solid var(--border-strong, #d4d4d8);
  border-radius: 12px;
  background: var(--surface, #ffffff);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.18);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-popover {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-popover-header {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 15px 16px 13px;
  border-bottom: 1px solid var(--border, #e4e4e7);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-popover-heading {
  display: grid;
  gap: 3px;
  min-width: 0;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-popover-title {
  margin: 0;
  color: var(--fg, #27272a);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.3;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-popover-summary {
  margin: 0;
  color: var(--fg-muted, #71717a);
  font-size: 12px;
  line-height: 1.45;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-popover-close {
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--fg-muted, #71717a);
  cursor: pointer;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-popover-close:hover {
  background: var(--surface-sunk, #f4f6f8);
  color: var(--fg, #27272a);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-popover-close svg {
  width: 16px;
  height: 16px;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-popover-body {
  display: grid;
  gap: 12px;
  min-height: 0;
  padding: 12px 12px 14px;
  overflow: auto;
  overscroll-behavior: contain;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-section {
  display: grid;
  gap: 8px;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 10px;
  border: 1px solid var(--border, #e4e4e7);
  border-radius: 8px;
  background: var(--surface, #ffffff);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-body {
  display: grid;
  gap: 3px;
  min-width: 0;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-title,
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-meta,
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-reason {
  overflow-wrap: anywhere;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-title {
  font-size: 13px;
  font-weight: 650;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-meta,
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-reason {
  font-size: 12px;
  color: var(--fg-muted, #71717a);
}
/* A gateway ask's body is a STRUCTURED document — one labeled line per
   argument, a shared-fields line, a numbered member list. Rendered into a
   plain span it collapsed to a single run-on paragraph: every newline and
   every list indent became one space, so the reader saw the enumerated
   actions they were approving as one undifferentiated smear. Slack and
   Telegram (plain-text wire) have always shown the structure; this row is
   where the owner actually answers, and it was the one surface that
   destroyed it. pre-wrap keeps the line breaks and the indents while
   still wrapping long values. Matches ASK_CARD_STYLES in
   @recued/ui-shared, which the #approvals queue and the Bridge panel
   already use. */
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-reason {
  white-space: pre-wrap;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  justify-content: flex-end;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  border: 1px solid var(--border-strong, #d4d4d8);
  border-radius: 8px;
  padding: 0 10px;
  background: var(--surface, #ffffff);
  color: var(--fg, #27272a);
  font: inherit;
  font-size: 12px;
  line-height: 1.2;
  text-decoration: none;
  cursor: pointer;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-action--link {
  color: var(--accent, #0e7490);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-action--approve {
  border-color: var(--accent, #0e7490);
  background: var(--accent, #0e7490);
  color: var(--on-accent, #ffffff);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-action--reject {
  color: var(--danger, #dc2626);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-action--confirm {
  border-color: var(--danger, #dc2626);
  background: var(--danger, #dc2626);
  color: var(--on-danger, #ffffff);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-action[disabled] {
  cursor: wait;
  opacity: 0.72;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-action[disabled]:not([aria-busy="true"]) {
  cursor: not-allowed;
  opacity: 0.55;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-empty,
[${ATTENTION_TOPBAR_HOST_ATTR}] .webclient-attention-error {
  padding: 14px;
  border: 1px solid var(--border, #e4e4e7);
  border-radius: 8px;
  background: var(--surface-sunk, #f4f6f8);
  color: var(--fg-muted, #71717a);
  font-size: 13px;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-empty {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-empty-glyph {
  display: inline-flex;
  width: 22px;
  height: 22px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--accent-weak, rgba(14, 116, 144, 0.10));
  color: var(--accent, #0e7490);
  font-size: 12px;
  font-weight: 700;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-empty-copy {
  display: grid;
  gap: 2px;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-empty-title {
  color: var(--fg, #27272a);
  font-weight: 650;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-empty-detail {
  line-height: 1.45;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-plan-resolution {
  display: grid;
  gap: 8px;
  padding: 11px;
  border: 1px solid var(--border, #e4e4e7);
  border-left: 3px solid var(--accent, #0e7490);
  border-radius: 8px;
  background: var(--surface-sunk, #f4f6f8);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-recovery-intent-continuation[data-phase="failed"] {
  border-left-color: var(--danger, #dc2626);
  background: var(--danger-weak, #fef2f2);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-recovery-intent-continuation[data-phase="failed"] .attention-plan-resolution-title {
  color: var(--danger, #dc2626);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-recovery-intent-continuation[data-phase="failed"][data-remediation="connection"] {
  border-left-color: var(--warning, #9a6700);
  background: var(--surface-sunk, #f4f6f8);
  background: color-mix(in srgb, var(--warning, #9a6700) 8%, var(--surface, #ffffff));
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-recovery-intent-continuation[data-phase="failed"][data-remediation="connection"] .attention-plan-resolution-title {
  color: var(--warning, #8a5a00);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-recovery-intent-continuation[data-phase="failed"][data-remediation="review"] {
  border-left-color: var(--accent, #0e7490);
  background: var(--surface-sunk, #f4f6f8);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-recovery-intent-continuation[data-phase="failed"][data-remediation="review"] .attention-plan-resolution-title {
  color: var(--fg, #27272a);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-plan-resolution-copy {
  display: grid;
  gap: 3px;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-plan-resolution-title {
  color: var(--fg, #27272a);
  font-size: 13px;
  font-weight: 650;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-plan-resolution-detail {
  color: var(--fg-muted, #71717a);
  font-size: 12px;
  line-height: 1.45;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-plan-resolution-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
[${ATTENTION_CHAT_PLAN_RESOLUTION_ANNOUNCER_ATTR}],
[${ATTENTION_ERROR_ANNOUNCER_ATTR}],
[${ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR}] {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .webclient-attention-error {
  color: var(--danger, #dc2626);
  background: var(--danger-weak, #fef2f2);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .webclient-attention-footer {
  display: flex;
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: 14px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-top: 1px solid var(--border, #e4e4e7);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .webclient-attention-footer a {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  gap: 5px;
  color: var(--accent, #0e7490);
  font-size: 13px;
  font-weight: 650;
  text-decoration: none;
}
@media (max-width: 520px) {
  [${ATTENTION_TOPBAR_HOST_ATTR}] .webclient-attention-popover-frame {
    position: fixed;
    top: 64px;
    right: 12px;
    left: 12px;
    width: auto;
    max-height: calc(100dvh - 72px);
  }
  [${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row {
    grid-template-columns: 1fr;
  }
  [${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-actions,
  [${ATTENTION_TOPBAR_HOST_ATTR}] .attention-plan-resolution-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    justify-content: stretch;
  }
  [${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-action {
    min-height: 38px;
  }
  [${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-actions > :only-child,
  [${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-actions > :first-child:nth-last-child(3),
  [${ATTENTION_TOPBAR_HOST_ATTR}] .attention-plan-resolution-actions > :only-child,
  [${ATTENTION_TOPBAR_HOST_ATTR}] .attention-plan-resolution-actions > :first-child:nth-last-child(3) {
    grid-column: 1 / -1;
  }
}
`;

export interface MountApprovalAttentionPopoverOptions {
  host: HTMLElement;
  document?: Document;
  runApprovalList: ApprovalListCaller;
  runApprovalResolve: ApprovalResolveCaller;
  runApprovalSubscribe: ApprovalSubscribeCaller;
  runPendingAsksList: AsksListCaller;
  runPendingAskSubmitAnswer: AsksSubmitAnswerCaller;
  onApprovalChanged?: ApprovalChangedSubscriber;
  subscribe?: BroadcastSubscriber['on'];
  /** Reconnect seam — fires on each transition into `connected`. Re-arms the
   *  one-shot `approval.subscribe` so a restarted server re-registers this
   *  client + any stale `liveError` clears, and refreshes the queues. */
  reconnect?: WebclientReconnectSubscriber;
  /** Bootstrap-scoped durable Chat approval inbox. The popover reads its
   * all-session snapshot plus reconciled live state. Absent → no plans shown. */
  chatPlans?: {
    list(): ReadonlyArray<PendingChatPlan>;
    latestResolution?(): PendingChatPlanResolution | null;
    state?(): PendingChatPlansStoreState;
    refresh?(): Promise<void>;
    whenLoaded?(): Promise<void>;
    recordResolution?(
      plan: PendingChatPlan,
      decision: 'approve' | 'reject',
    ): void;
    dismissResolution?(plan_id: string): void;
    subscribe(listener: () => void): () => void;
  };
  /** R20 — resolve a chat plan: approve → chat.plan.approve, reject →
   *  chat.plan.cancel (wire verb unchanged). The chat.plan_resolved broadcast
   *  then drops it from the store → the row clears. */
  runChatPlanResolve?: (args: {
    plan_id: string;
    decision: 'approve' | 'reject';
  }) => Promise<unknown>;
  /** Existing authoritative connection-list read. Its privacy-safe post-ack
   * sidecar is projected into Attention without merging backend stores. */
  runConnectionRecoveryList?: ConnectionsEnrollListCaller;
  /** The exact local server profile this shell booted against. Its id binds
   * links; its user-facing label never enters the URL. */
  connectionRecoveryProfile?: {
    id: string;
    label: string;
  };
  /** Builds the exact profile + identity Connections landing for one row. */
  connectionRecoveryHref?: (
    target: ProfileBoundPostSafeStopRecoveryTarget,
  ) => string;
  /** Identity-free sibling-tab wake-up. Every signal is followed by a fresh
   * authoritative list before the queue changes. */
  subscribeConnectionRecovery?: (listener: () => void) => () => void;
  /** Last-observed, profile-only reminders for saved servers that are not live
   * in this tab. They contain no connection identity, count, URL, or status. */
  inactiveConnectionRecoveryHints?: ReadonlyArray<
    AttentionInactiveConnectionRecoveryHint
  >;
  /** Opens Account on the exact profile without selecting it. `opened` means
   * the owner can now make the normal reviewed switch choice. */
  onReviewInactiveConnectionRecovery?: (
    profileId: string,
  ) => 'opened' | 'missing' | 'unavailable';
  /** One-shot destination-boot intent. Attention opens and keeps this context
   * until the target server returns a valid authoritative list. */
  initialConnectionRecoveryReview?: {
    serverProfileId: string;
  };
  /** Records only profile-level availability after a valid current-server
   * list. `observedAt` is captured before the request so an older in-flight
   * response cannot overwrite a newer sibling observation. */
  onConnectionRecoverySnapshot?: (snapshot: {
    serverProfileId: string;
    hasRecoveries: boolean;
    observedAt: number;
  }) => void;
  /** Retire destination-switch continuity after one valid authoritative list. */
  onConnectionRecoveryReviewSettled?: (serverProfileId: string) => void;
  /** Explicitly closing an unverified review abandons its reload continuity. */
  onConnectionRecoveryReviewDismissed?: (serverProfileId: string) => void;
  /** Neutral, durable return affordance after a recovery excursion reaches an
   * authoritative all-clear. It contains only a locally resolved profile. */
  initialRecoveryExcursionReturn?: AttentionRecoveryExcursionReturn;
  /** Opens Account on the source profile. The existing reviewed switch remains
   * the only authority that can change servers. */
  onReviewRecoveryExcursionReturn?: (
    profileId: string,
  ) => 'opened' | 'missing' | 'unavailable';
  /** Explicitly staying on the recovery server retires the saved return. */
  onDismissRecoveryExcursionReturn?: (profileId: string) => void;
  /** Quiet, same-tab continuation after automatic route focus safely expires. */
  initialRecoveryIntentContinuation?: AttentionRecoveryIntentContinuation;
  /** Starts a deliberate route-owned freshness check. `started` closes the
   * popover but keeps the item until bootstrap confirms a useful landing. */
  onResumeRecoveryIntentContinuation?: (
    continuation: AttentionRecoveryIntentContinuation,
  ) => 'started' | 'missing' | 'unavailable';
  /** Opens the broad current area without claiming the failed recheck passed. */
  onReviewRecoveryIntentContinuation?: (
    continuation: AttentionRecoveryIntentContinuation,
  ) => 'started' | 'missing' | 'unavailable';
  /** Opens Account for a connection-bound remediation while retaining the
   * exact scrubbed route and closed-list landing intent for reconnect. */
  onRemediateRecoveryIntentConnection?: (
    continuation: AttentionRecoveryIntentContinuation,
  ) => 'started' | 'missing' | 'unavailable';
  /** Explicit dismissal retires the privacy-safe session marker. */
  onDismissRecoveryIntentContinuation?: () => void;
  /** Deterministic relative-time/request-lineage seam. */
  now?: () => number;
}

export interface AttentionConnectionRecovery {
  kind: ConnectionKind;
  name: string;
  displayName: string;
  serverProfileId: string;
  serverProfileLabel: string;
  status: 'pending' | 'auth_failed' | 'unreachable' | 'unknown';
  acknowledgedAt: number;
}

export interface AttentionInactiveConnectionRecoveryHint {
  serverProfileId: string;
  serverProfileLabel: string;
  observedAt: number;
}

export interface AttentionRecoveryExcursionReturn {
  serverProfileId: string;
  serverProfileLabel: string;
}

export type AttentionRecoveryIntentRemediation =
  | 'retry'
  | 'connection'
  | 'review';

export interface AttentionRecoveryIntentContinuation {
  readonly serverProfileId: string;
  readonly serverProfileLabel: string;
  readonly landingHash: string;
  readonly areaLabel: string;
  readonly intent: 'continue' | 'choose_again';
  /** Ephemeral UI state only. The session marker intentionally omits it so a
   * reload always returns to a truthful, retryable `ready` posture. */
  readonly phase:
    | 'ready'
    | 'checking'
    | 'failed'
    | 'waiting_for_connection';
  /** Closed-list recovery posture derived from live shell/route state. Raw
   * errors, credentials, and route-owned detail never enter this value. */
  readonly remediation: AttentionRecoveryIntentRemediation | null;
}

export interface ApprovalAttentionPopoverMount {
  getApprovals(): ReadonlyArray<ServerPendingApproval>;
  getAsks(): ReadonlyArray<ServerPendingAsk>;
  getConnectionRecoveries(): ReadonlyArray<AttentionConnectionRecovery>;
  getInactiveConnectionRecoveryHints(): ReadonlyArray<
    AttentionInactiveConnectionRecoveryHint
  >;
  isOpen(): boolean;
  refreshApprovals(): Promise<void>;
  refreshAsks(): Promise<void>;
  refreshConnectionRecoveries(): Promise<void>;
  /** A local profile rename updates copy only; row authority and the opaque
   * profile id remain pinned to this boot. */
  setConnectionRecoveryProfileLabel(label: string): void;
  /** Replace profile-only inactive reminders after a roster/storage refresh. */
  setInactiveConnectionRecoveryHints(
    hints: ReadonlyArray<AttentionInactiveConnectionRecoveryHint>,
  ): void;
  /** Set or clear the neutral recovery-excursion return after a roster or
   * authoritative recovery refresh. */
  setRecoveryExcursionReturn(
    value: AttentionRecoveryExcursionReturn | null,
  ): void;
  getRecoveryExcursionReturn(): AttentionRecoveryExcursionReturn | null;
  setRecoveryIntentContinuation(
    value: AttentionRecoveryIntentContinuation | null,
  ): void;
  /** Successful route-owned completion closes an open dialog without moving
   * focus away from the exact destination that just took ownership. */
  completeRecoveryIntentContinuation(): void;
  getRecoveryIntentContinuation(): AttentionRecoveryIntentContinuation | null;
  whenLoaded(): Promise<void>;
  dispose(): void;
}

type ActionElement = {
  getAttribute(name: string): string | null;
};

/** One row in the unified attention peek, newest-first by durable server
 * proposal/create time. */
type AttentionRow =
  | { kind: 'approval'; sortAt: number; id: string; approval: ServerPendingApproval }
  | { kind: 'ask'; sortAt: number; id: string; ask: ServerPendingAsk }
  | { kind: 'plan'; sortAt: number; id: string; plan: PendingChatPlan }
  | {
      kind: 'connection_recovery';
      sortAt: number;
      id: string;
      recovery: AttentionConnectionRecovery;
    }
  | {
      kind: 'inactive_profile_recovery';
      sortAt: number;
      id: string;
      hint: AttentionInactiveConnectionRecoveryHint;
    };

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });

const actionElementFromEvent = (event: Event): ActionElement | null => {
  const target = event.target as
    | { closest?: (selector: string) => ActionElement | null }
    | null
    | undefined;
  return target?.closest?.('[data-action]') ?? null;
};

const identifierWordmarks = new Map<string, string>([
  ['api', 'API'],
  ['crm', 'CRM'],
  ['gmail', 'Gmail'],
  ['hubspot', 'HubSpot'],
  ['id', 'ID'],
  ['oauth', 'OAuth'],
  ['url', 'URL'],
]);

const humanizeIdentifier = (value: string): string => {
  const words = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._/:\-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return 'Action';
  return words
    .map((word, index) => {
      const wordmark = identifierWordmarks.get(word);
      if (wordmark !== undefined) return wordmark;
      return index === 0
        ? `${word.charAt(0).toUpperCase()}${word.slice(1)}`
        : word;
    })
    .join(' ');
};

const approvalRiskLabel = (
  tier: ServerPendingApproval['risk_tier'],
): string => {
  switch (tier) {
    case 'write':
      return 'Changes data';
    case 'admin':
      return 'Changes access';
    case 'destructive':
      return 'Permanent change';
  }
};

const chatPlanSourceLabel = (plan: PendingChatPlan): string => {
  switch (plan.tier) {
    case 1:
      return 'Recued action';
    case 2:
      return 'Recipe';
    case 3:
      return 'Connected tool';
  }
};

const renderApprovalRow = (
  approval: ServerPendingApproval,
  resolving: ReadonlySet<string>,
  armed: ReadonlySet<string>,
): string => {
  const tier = approval.risk_tier;
  const isDestructive = tier === 'destructive';
  const busy = resolving.has(approval.approval_id);
  const busyAttrs = busy ? ' disabled aria-busy="true"' : '';
  const busyClass = busy ? ' is-busy' : '';
  const idAttr = escapeHtml(approval.approval_id);
  const recipeAttr = escapeHtml(approval.recipe_id);
  const titleHtml = escapeHtml(approval.description);
  const actionLabel = escapeHtml(humanizeIdentifier(approval.ingredient_slug));
  const riskLabel = escapeHtml(approvalRiskLabel(tier));

  if (isDestructive && armed.has(approval.approval_id)) {
    // Armed destructive: caution + Cancel + a danger Confirm. R20 — the REAL
    // inline confirm that replaces the old hollow Review-then-route.
    return `
      <li class="attention-row attention-row--approval attention-row--server"
        data-attention-kind="approval"
        data-approval-id="${idAttr}"
        data-recipe-id="${recipeAttr}">
        <div class="attention-row-body">
          <span class="attention-row-title">${titleHtml}</span>
          <span class="attention-row-meta">Approval &middot; ${actionLabel} &middot; ${riskLabel}</span>
          <span class="attention-row-reason">This cannot be undone. Confirm only if the details are correct.</span>
        </div>
        <div class="attention-row-actions">
          <button type="button"
            class="attention-row-action${busyClass}"
            data-action="approval-disarm"
            data-approval-id="${idAttr}"
            aria-label="Cancel confirmation: ${titleHtml}"${busyAttrs}>
            Cancel
          </button>
          <button type="button"
            class="attention-row-action attention-row-action--confirm${busyClass}"
            data-action="approval-decide-server"
            data-decision="approve"
            data-approval-id="${idAttr}"
            aria-label="Confirm: ${titleHtml}"${busyAttrs}>
            Confirm
          </button>
        </div>
      </li>
    `;
  }
  if (isDestructive) {
    // Unarmed destructive: Reject resolves immediately; Approve ARMS (no resolve).
    return `
      <li class="attention-row attention-row--approval attention-row--server"
        data-attention-kind="approval"
        data-approval-id="${idAttr}"
        data-recipe-id="${recipeAttr}">
        <div class="attention-row-body">
          <span class="attention-row-title">${titleHtml}</span>
          <span class="attention-row-meta">Approval &middot; ${actionLabel} &middot; ${riskLabel}</span>
        </div>
        <div class="attention-row-actions">
          <button type="button"
            class="attention-row-action attention-row-action--reject${busyClass}"
            data-action="approval-decide-server"
            data-decision="reject"
            data-approval-id="${idAttr}"
            aria-label="Reject: ${titleHtml}"${busyAttrs}>
            Reject
          </button>
          <button type="button"
            class="attention-row-action attention-row-action--approve${busyClass}"
            data-action="approval-arm"
            data-approval-id="${idAttr}"
            aria-label="Approve: ${titleHtml}"${busyAttrs}>
            Approve
          </button>
        </div>
      </li>
    `;
  }
  // Non-destructive: Reject + Approve (immediate).
  return `
    <li class="attention-row attention-row--approval attention-row--server"
      data-attention-kind="approval"
      data-approval-id="${idAttr}"
      data-recipe-id="${recipeAttr}">
      <div class="attention-row-body">
        <span class="attention-row-title">${titleHtml}</span>
        <span class="attention-row-meta">Approval &middot; ${actionLabel} &middot; ${riskLabel}</span>
      </div>
      <div class="attention-row-actions">
        <button type="button"
          class="attention-row-action attention-row-action--reject${busyClass}"
          data-action="approval-decide-server"
          data-decision="reject"
          data-approval-id="${idAttr}"
          aria-label="Reject: ${titleHtml}"${busyAttrs}>
          Reject
        </button>
        <button type="button"
          class="attention-row-action attention-row-action--approve${busyClass}"
          data-action="approval-decide-server"
          data-decision="approve"
          data-approval-id="${idAttr}"
          aria-label="Approve: ${titleHtml}"${busyAttrs}>
          Approve
        </button>
      </div>
    </li>
  `;
};

const optionModifierClass = (label: string): string => {
  if (/\b(reject|deny|no|cancel)\b/i.test(label)) {
    return ' attention-row-action--reject';
  }
  if (/\b(approve|allow|yes|confirm)\b/i.test(label)) {
    return ' attention-row-action--approve';
  }
  return '';
};

const renderGatewayAskRow = (
  ask: ServerPendingAsk,
  resolving: ReadonlySet<string>,
): string => {
  const title = ask.title?.trim() || 'Gateway ask';
  const showBody = ask.title !== undefined && ask.title.trim() !== '';
  const busy = resolving.has(ask.ask_id);
  const optionButtons = ask.options
    .map((option) => {
      const label = option.label.trim() || option.id;
      const busyAttrs = busy ? ' disabled aria-busy="true"' : '';
      const busyClass = busy ? ' is-busy' : '';
      return `
        <button type="button"
          class="attention-row-action${optionModifierClass(label)}${busyClass}"
          data-action="gateway-ask-answer"
          data-ask-id="${escapeHtml(ask.ask_id)}"
          data-option-id="${escapeHtml(option.id)}"
          aria-label="${escapeHtml(`${label}: ${title}`)}"${busyAttrs}>
          ${escapeHtml(label)}
        </button>
      `;
    })
    .join('');
  // R20 — asks resolve INLINE via their options; the old per-row "Review"
  // route to #approvals is dropped (the footer "See all" still opens the full
  // queue).
  return `
    <li class="attention-row attention-row--gateway-ask"
      data-attention-kind="gateway-ask"
      ${ATTENTION_GATEWAY_ASK_ROW_ATTR}="${escapeHtml(ask.ask_id)}">
      <div class="attention-row-body">
        <span class="attention-row-title">${escapeHtml(title)}</span>
        <span class="attention-row-meta">Connected action &middot; Answer to continue</span>
        ${showBody ? `<span class="attention-row-reason">${escapeHtml(ask.text)}</span>` : ''}
      </div>
      <div class="attention-row-actions">
        ${optionButtons}
      </div>
    </li>
  `;
};

const renderChatPlanRow = (
  plan: PendingChatPlan,
  resolving: ReadonlySet<string>,
): string => {
  const busy = resolving.has(plan.plan_id);
  const freshReview = plan.retry_of_plan_id !== undefined;
  const payloadAvailable = plan.payload_available !== false;
  const busyAttrs = busy ? ' disabled aria-busy="true"' : '';
  const approveAttrs =
    busyAttrs
    || (
      payloadAvailable
        ? ''
        : ' disabled title="Exact reviewed details are required before approval."'
    );
  const busyClass = busy ? ' is-busy' : '';
  const idAttr = escapeHtml(plan.plan_id);
  const chatHref = escapeHtml(pendingChatPlanHref(plan));
  const actionName = humanizeIdentifier(plan.tool);
  const actionLabel = escapeHtml(actionName);
  const sourceLabel = escapeHtml(chatPlanSourceLabel(plan));
  const retryAttr = freshReview
    ? ` data-retry-of-plan-id="${escapeHtml(plan.retry_of_plan_id!)}"`
    : '';
  const reason = !payloadAvailable
    ? 'Exact reviewed details are unavailable after recovery. You can safely reject this plan, but it cannot be approved.'
    : freshReview
      ? 'Earlier permission was used; review this action again before approving.'
      : '';
  return `
    <li class="attention-row attention-row--chat-plan"
      data-attention-kind="chat-plan"
      data-plan-id="${idAttr}"${retryAttr}>
      <div class="attention-row-body">
        <span class="attention-row-title">${freshReview ? 'Review again: ' : 'Run '}${actionLabel}</span>
        <span class="attention-row-meta">${freshReview ? 'Fresh approval' : 'Chat approval'} &middot; ${sourceLabel}</span>
        ${reason === '' ? '' : `<span class="attention-row-reason">${escapeHtml(reason)}</span>`}
      </div>
      <div class="attention-row-actions">
        <a class="attention-row-action attention-row-action--link"
          href="${chatHref}"
          data-action="open-chat-plan"
          data-plan-id="${idAttr}"
          aria-label="${escapeHtml(`Review ${actionName} in Chat`)}"
          ${ATTENTION_CHAT_PLAN_LINK_ATTR}>
          Review in Chat
        </a>
        <button type="button"
          class="attention-row-action attention-row-action--reject${busyClass}"
          data-action="chat-plan-decide"
          data-decision="reject"
          data-plan-id="${idAttr}"${busyAttrs}
          aria-label="${escapeHtml(`Reject: ${actionName}`)}">
          Reject
        </button>
        <button type="button"
          class="attention-row-action attention-row-action--approve${busyClass}"
          data-action="chat-plan-decide"
          data-decision="approve"
          data-plan-id="${idAttr}"${approveAttrs}
          aria-label="${escapeHtml(`Approve: ${actionName}`)}">
          Approve
        </button>
      </div>
    </li>
  `;
};

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validate the whole sidecar against the rows in the same authoritative list.
 * A stale or malformed entry cannot become an Attention target. */
const projectConnectionRecoveries = (
  response: Awaited<ReturnType<ConnectionsEnrollListCaller>>,
  profile: { id: string; label: string },
): ReadonlyArray<AttentionConnectionRecovery> | null => {
  const raw = response.credential_post_safe_stop_verifications;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > response.connections.length) {
    return null;
  }
  const connectionByKey = new Map(
    response.connections.map((connection) => [
      `${connection.kind}/${connection.name}`,
      connection,
    ]),
  );
  const seen = new Set<string>();
  const projected: AttentionConnectionRecovery[] = [];
  for (const candidate of raw as ReadonlyArray<unknown>) {
    if (!isRecordValue(candidate)) return null;
    const kind = candidate.kind;
    const name = candidate.name;
    const status = candidate.status;
    const acknowledgedAt = candidate.acknowledged_at;
    if (
      (kind !== 'api' && kind !== 'mcp' && kind !== 'notification')
      || typeof name !== 'string'
      || !CONNECTION_NAME_REGEX.test(name)
      || (
        status !== 'pending'
        && status !== 'auth_failed'
        && status !== 'unreachable'
        && status !== 'unknown'
      )
      || typeof acknowledgedAt !== 'number'
      || !Number.isSafeInteger(acknowledgedAt)
      || acknowledgedAt < 0
    ) return null;
    const key = `${kind}/${name}`;
    const connection = connectionByKey.get(key) as ConnectionView | undefined;
    if (connection === undefined || seen.has(key)) return null;
    seen.add(key);
    if (status === 'pending') {
      if (
        candidate.checked_at !== undefined
        || candidate.connection_updated_at !== undefined
        || candidate.credential_correction !== undefined
      ) return null;
    } else {
      const checkedAt = candidate.checked_at;
      const connectionUpdatedAt = candidate.connection_updated_at;
      if (
        typeof checkedAt !== 'number'
        || !Number.isSafeInteger(checkedAt)
        || checkedAt < 0
        || typeof connectionUpdatedAt !== 'number'
        || !Number.isSafeInteger(connectionUpdatedAt)
        || connectionUpdatedAt < 0
        || connection.updated_at !== connectionUpdatedAt
        || (
          status !== 'auth_failed'
          && candidate.credential_correction !== undefined
        )
      ) return null;
      if (candidate.credential_correction !== undefined) {
        const rawCorrection = candidate.credential_correction;
        if (!isRecordValue(rawCorrection)) return null;
        const authType = CONNECTION_AUTH_TYPES.find((value) =>
          value === rawCorrection.auth_type);
        if (authType === undefined || !Array.isArray(rawCorrection.field_keys)) {
          return null;
        }
        const expected = connectionCredentialRejectionCorrection(authType);
        if (
          expected === null
          || rawCorrection.field_keys.length !== expected.field_keys.length
          || rawCorrection.field_keys.some((field, index) =>
            field !== expected.field_keys[index])
        ) return null;
      }
    }
    const displayName = typeof connection.display_name === 'string'
      && connection.display_name.trim() !== ''
      ? connection.display_name.trim()
      : name;
    projected.push({
      kind,
      name,
      displayName,
      serverProfileId: profile.id,
      serverProfileLabel: profile.label,
      status,
      acknowledgedAt,
    });
  }
  return projected;
};

const renderConnectionRecoveryRow = (
  recovery: AttentionConnectionRecovery,
  href: string,
): string => {
  const identity = `${recovery.kind}/${recovery.name}`;
  const copy = recovery.status === 'auth_failed'
    ? {
        title: `${recovery.displayName} still needs sign-in attention`,
        meta: 'Connection recovery · Saved credential rejected',
        reason: 'A fresh server check still found a rejection. Review the current saved credential.',
        action: 'Review credential',
      }
    : recovery.status === 'unreachable'
      ? {
          title: `Finish recovery for ${recovery.displayName}`,
          meta: 'Connection recovery · Provider unreachable',
          reason: 'The provider could not be reached; this does not prove the saved credential is wrong.',
          action: 'Try check again',
        }
      : recovery.status === 'unknown'
        ? {
            title: `Finish recovery for ${recovery.displayName}`,
            meta: 'Connection recovery · Check incomplete',
            reason: 'The server could not complete an authoritative check. Reconnect, then try once more.',
            action: 'Try check again',
          }
        : {
            title: `Finish recovery for ${recovery.displayName}`,
            meta: 'Connection recovery · Check required',
            reason: 'The earlier recovery stop is closed. Check the credential currently saved.',
            action: 'Check connection',
          };
  return `
    <li class="attention-row attention-row--connection-recovery"
      data-attention-kind="connection-recovery"
      data-connection-kind="${escapeHtml(recovery.kind)}"
      data-connection-name="${escapeHtml(recovery.name)}">
      <div class="attention-row-body">
        <span class="attention-row-title">${escapeHtml(copy.title)}</span>
        <span class="attention-row-meta">${escapeHtml(`${copy.meta} · Server profile: ${recovery.serverProfileLabel} · ${identity}`)}</span>
        <span class="attention-row-reason">${escapeHtml(copy.reason)}</span>
      </div>
      <div class="attention-row-actions">
        <a class="attention-row-action attention-row-action--link"
          href="${escapeHtml(href)}"
          data-action="open-connection-recovery"
          data-connection-kind="${escapeHtml(recovery.kind)}"
          data-connection-name="${escapeHtml(recovery.name)}"
          aria-label="${escapeHtml(`${copy.action} on ${recovery.serverProfileLabel}: ${identity}`)}"
          ${ATTENTION_CONNECTION_RECOVERY_LINK_ATTR}>
          ${escapeHtml(copy.action)}
        </a>
      </div>
    </li>
  `;
};

const formatInactiveRecoveryObservation = (
  observedAt: number,
  now: number,
): string => {
  const elapsed = Math.max(0, now - observedAt);
  if (elapsed < 60_000) return 'Last confirmed while active just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) {
    return `Last confirmed while active ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `Last confirmed while active ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(hours / 24);
  return `Last confirmed while active ${days} ${days === 1 ? 'day' : 'days'} ago`;
};

const renderInactiveConnectionRecoveryRow = (
  hint: AttentionInactiveConnectionRecoveryHint,
  now: number,
): string => `
  <li class="attention-row attention-row--inactive-profile-recovery"
    data-attention-kind="inactive-profile-recovery"
    data-server-profile-id="${escapeHtml(hint.serverProfileId)}"
    ${ATTENTION_INACTIVE_PROFILE_RECOVERY_ATTR}>
    <div class="attention-row-body">
      <span class="attention-row-title">${escapeHtml(`${hint.serverProfileLabel} may still need connection recovery`)}</span>
      <span class="attention-row-meta">${escapeHtml(`Inactive server profile · ${formatInactiveRecoveryObservation(hint.observedAt, now)}`)}</span>
      <span class="attention-row-reason">This is a last-observed reminder, not a live result. Open Account to review the profile switch. After it succeeds, Recued will recheck before revealing connection details or actions.</span>
    </div>
    <div class="attention-row-actions">
      <button type="button"
        class="attention-row-action attention-row-action--link"
        data-action="review-inactive-connection-recovery"
        data-server-profile-id="${escapeHtml(hint.serverProfileId)}"
        aria-label="${escapeHtml(`Review the profile switch to recheck connection recovery on ${hint.serverProfileLabel}`)}">
        Review switch
      </button>
    </div>
  </li>
`;

type ConnectionRecoveryReviewPresentation =
  | { phase: 'checking'; serverProfileId: string; serverProfileLabel: string }
  | { phase: 'retryable'; serverProfileId: string; serverProfileLabel: string }
  | {
      phase: 'verified';
      serverProfileId: string;
      serverProfileLabel: string;
      recoveryCount: number;
    };

const renderConnectionRecoveryReview = (
  review: ConnectionRecoveryReviewPresentation,
): string => {
  const title = review.phase === 'checking'
    ? `Checking ${review.serverProfileLabel} now`
    : review.phase === 'retryable'
      ? `Couldn’t confirm ${review.serverProfileLabel} yet`
      : review.recoveryCount === 0
        ? `${review.serverProfileLabel} is clear`
        : review.recoveryCount === 1
          ? `A fresh check found 1 connection recovery`
          : `A fresh check found ${review.recoveryCount} connection recoveries`;
  const detail = review.phase === 'checking'
    ? 'Recued is asking the selected server now. The inactive-profile reminder is not being treated as current.'
    : review.phase === 'retryable'
      ? 'The selected server did not return a valid recovery list. Reconnect or retry here; no stale connection details were shown.'
      : review.recoveryCount === 0
        ? 'A fresh authoritative check found no unresolved connection recovery. The earlier reminder has been retired.'
        : 'These connection rows came from the selected server’s fresh authoritative list. The earlier inactive reminder has been replaced.';
  return `
    <div class="attention-plan-resolution attention-connection-recovery-review"
      role="status" aria-live="polite" aria-atomic="true"
      data-phase="${review.phase}"
      ${ATTENTION_CONNECTION_RECOVERY_REVIEW_ATTR}="${escapeHtml(review.serverProfileId)}">
      <div class="attention-plan-resolution-copy">
        <span class="attention-plan-resolution-title">${escapeHtml(title)}</span>
        <span class="attention-plan-resolution-detail">${escapeHtml(detail)}</span>
      </div>
      ${review.phase === 'checking'
        ? ''
        : `<div class="attention-plan-resolution-actions">
            ${review.phase === 'retryable'
              ? `<button type="button" class="attention-row-action attention-row-action--approve"
                  data-action="retry-connection-recovery-review">
                  Retry check
                </button>`
              : ''}
            <button type="button" class="attention-row-action"
              data-action="dismiss-connection-recovery-review">
              ${review.phase === 'verified' ? 'Done' : 'Dismiss'}
            </button>
          </div>`}
    </div>
  `;
};

const renderRecoveryExcursionReturn = (
  value: AttentionRecoveryExcursionReturn,
): string => `
  <div class="attention-plan-resolution attention-recovery-excursion-return"
    ${ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR}="${escapeHtml(value.serverProfileId)}">
    <div class="attention-plan-resolution-copy">
      <span class="attention-plan-resolution-title">${escapeHtml(`Return to ${value.serverProfileLabel} when you’re ready`)}</span>
      <span class="attention-plan-resolution-detail">You came here to review connection recovery. The saved return goes through the normal server-switch review and restores only the safe area you left&mdash;not record details, connection identities, credentials, or drafts.</span>
    </div>
    <div class="attention-plan-resolution-actions">
      <button type="button"
        class="attention-row-action attention-row-action--approve"
        data-action="review-recovery-excursion-return"
        data-server-profile-id="${escapeHtml(value.serverProfileId)}">
        Review return
      </button>
      <button type="button"
        class="attention-row-action"
        data-action="dismiss-recovery-excursion-return"
        data-server-profile-id="${escapeHtml(value.serverProfileId)}">
        Stay here
      </button>
    </div>
  </div>
`;

const renderRecoveryIntentContinuation = (
  value: AttentionRecoveryIntentContinuation,
  canReview: boolean,
  canRemediateConnection: boolean,
): string => {
  const waitingForConnection = value.phase === 'waiting_for_connection';
  const landingAction = value.intent === 'choose_again'
    ? 'choose again'
    : 'continue';
  const landingActionGerund = value.intent === 'choose_again'
    ? 'choosing again'
    : 'continuing';
  const title = value.phase === 'checking'
    ? `Rechecking ${value.areaLabel}…`
    : waitingForConnection
      ? `Waiting to recheck ${value.areaLabel}`
      : value.phase === 'failed'
        ? value.remediation === 'connection'
          ? `Reconnect before returning to ${value.areaLabel}`
          : value.remediation === 'review'
            ? `Review ${value.areaLabel} before ${landingActionGerund}`
            : `${value.areaLabel} couldn’t be refreshed`
        : value.intent === 'choose_again'
          ? `Return to ${value.areaLabel} and choose again`
          : `Finish returning to ${value.areaLabel}`;
  const detail = value.phase === 'checking'
    ? `Recued is checking ${value.areaLabel} on ${value.serverProfileLabel} against the latest server state. You can close Attention; this saved return stays available until the check finishes.`
    : waitingForConnection
      ? `Recued will retry the exact current-state check when ${value.serverProfileLabel} reconnects, then return you to the exact place to ${landingAction} in ${value.areaLabel}. No action or confirmation will replay.`
      : value.phase === 'failed'
        ? value.remediation === 'connection'
          ? `${value.serverProfileLabel} wasn’t connected when Recued checked ${value.areaLabel}. Review that connection so Recued can recheck and return you to the exact place to ${landingAction}.`
          : value.remediation === 'review'
            ? `${value.areaLabel} does not expose a safe background refresh from this view. Open its current status instead; your work wasn’t changed and the earlier confirmation won’t repeat.`
            : `Recued couldn’t confirm that ${value.areaLabel} is current. Retry its route-owned check, or review the area as it is now. Your work wasn’t changed and the earlier confirmation won’t repeat.`
        : `Recued paused this return on ${value.serverProfileLabel} so it wouldn’t interrupt you. Recheck the current view when you’re ready; the earlier confirmation won’t repeat.`;
  const reviewAction = (primary: boolean): string => canReview
    ? `<button type="button"
        class="attention-row-action${primary ? ' attention-row-action--approve' : ''}"
        data-action="review-recovery-intent-continuation"
        aria-label="${escapeHtml(`Review ${value.areaLabel} on ${value.serverProfileLabel}`)}">
        Review ${escapeHtml(value.areaLabel)}
      </button>`
    : '';
  const retryAction = (primary: boolean): string => `
    <button type="button"
      class="attention-row-action${primary ? ' attention-row-action--approve' : ''}"
      data-action="resume-recovery-intent-continuation"
      aria-label="${escapeHtml(`Try rechecking ${value.areaLabel} on ${value.serverProfileLabel}`)}">
      Try again
    </button>`;
  const connectionAction = (primary: boolean): string =>
    canRemediateConnection
      ? `<button type="button"
          class="attention-row-action${primary ? ' attention-row-action--approve' : ''}"
          data-action="remediate-recovery-intent-connection"
          aria-label="${escapeHtml(`Review the ${value.serverProfileLabel} connection before returning to ${value.areaLabel}`)}">
          Review connection
        </button>`
      : '';
  const phaseActions = value.phase === 'checking'
    ? `<button type="button"
        class="attention-row-action attention-row-action--approve"
        aria-label="${escapeHtml(`Rechecking ${value.areaLabel} on ${value.serverProfileLabel}`)}"
        aria-busy="true"
        aria-disabled="true"
        disabled>
        Rechecking&hellip;
      </button>`
    : waitingForConnection
      ? `<button type="button"
          class="attention-row-action attention-row-action--approve"
          aria-label="${escapeHtml(`Waiting for ${value.serverProfileLabel} before rechecking ${value.areaLabel}`)}"
          aria-busy="true"
          aria-disabled="true"
          disabled>
          Waiting for connection&hellip;
        </button>
        ${connectionAction(false)}`
      : value.phase === 'failed'
        ? value.remediation === 'connection'
          ? `${connectionAction(true)}${reviewAction(!canRemediateConnection)}`
          : value.remediation === 'review'
            ? reviewAction(true)
            : `${retryAction(true)}${reviewAction(false)}`
        : `<button type="button"
            class="attention-row-action attention-row-action--approve"
            data-action="resume-recovery-intent-continuation"
            aria-label="${escapeHtml(`Recheck ${value.areaLabel} on ${value.serverProfileLabel}`)}">
            Recheck area
          </button>`;
  return `
    <div class="attention-plan-resolution attention-recovery-intent-continuation"
      data-phase="${value.phase}"
      data-remediation="${value.remediation ?? 'none'}"
      ${value.phase === 'checking' || waitingForConnection ? 'aria-busy="true"' : ''}
      ${ATTENTION_RECOVERY_INTENT_CONTINUATION_ATTR}>
      <div class="attention-plan-resolution-copy">
        <span class="attention-plan-resolution-title">${escapeHtml(title)}</span>
        <span class="attention-plan-resolution-detail">${escapeHtml(detail)}</span>
      </div>
      <div class="attention-plan-resolution-actions">
        ${phaseActions}
        <button type="button"
          class="attention-row-action"
          data-action="dismiss-recovery-intent-continuation">
          ${waitingForConnection ? 'Stop waiting' : 'Dismiss'}
        </button>
      </div>
    </div>
  `;
};

const renderUnifiedPopover = (state: {
  blockingCount: number;
  loading: boolean;
  verified: boolean;
  errorText: string | null;
  errorConnectionCaused: boolean;
  rows: ReadonlyArray<AttentionRow>;
  resolvingApprovals: ReadonlySet<string>;
  resolvingAsks: ReadonlySet<string>;
  resolvingPlans: ReadonlySet<string>;
  armedApprovals: ReadonlySet<string>;
  planResolution: PendingChatPlanResolution | null;
  connectionRecoveryHref: (
    target: ProfileBoundPostSafeStopRecoveryTarget,
  ) => string;
  connectionRecoveryReview: ConnectionRecoveryReviewPresentation | null;
  recoveryExcursionReturn: AttentionRecoveryExcursionReturn | null;
  recoveryIntentContinuation: AttentionRecoveryIntentContinuation | null;
  canReviewRecoveryIntentContinuation: boolean;
  canRemediateRecoveryIntentConnection: boolean;
  now: number;
}): string => {
  const renderAllClear = (): string => `
    <div class="attention-empty" role="status">
      <span class="attention-empty-glyph" aria-hidden="true">&#10003;</span>
      <span class="attention-empty-copy">
        <span class="attention-empty-title">You&rsquo;re all caught up</span>
        <span class="attention-empty-detail">No items are waiting on you.</span>
      </span>
    </div>
  `;
  const renderLoading = (): string => `
    <div class="attention-empty" role="status">
      <span class="attention-empty-copy">
        <span class="attention-empty-title">Checking what needs you&hellip;</span>
        <span class="attention-empty-detail">This should only take a moment.</span>
      </span>
    </div>
  `;
  const renderUnverified = (): string => `
    <div class="attention-empty" role="status">
      <span class="attention-empty-copy">
        <span class="attention-empty-title">We couldn&rsquo;t verify the queue</span>
        <span class="attention-empty-detail">Reconnect to check for items waiting on you.</span>
      </span>
    </div>
  `;
  const renderPlanResolution = (
    resolution: PendingChatPlanResolution,
  ): string => {
    const copy = pendingChatPlanResolutionCopy(resolution);
    return `
      <div class="attention-plan-resolution"
        data-outcome="${escapeHtml(resolution.outcome)}"
        ${ATTENTION_CHAT_PLAN_RESOLUTION_ATTR}="${escapeHtml(resolution.plan_id)}">
        <div class="attention-plan-resolution-copy">
          <span class="attention-plan-resolution-title">${escapeHtml(copy.title)}</span>
          <span class="attention-plan-resolution-detail">${escapeHtml(copy.detail)}</span>
        </div>
        <div class="attention-plan-resolution-actions">
          <a class="attention-row-action attention-row-action--approve"
            href="${escapeHtml(pendingChatPlanHref(resolution))}"
            data-action="open-chat-plan"
            ${ATTENTION_CHAT_PLAN_LINK_ATTR}>
            ${escapeHtml(copy.linkLabel)}
          </a>
          <button type="button"
            class="attention-row-action"
            data-action="dismiss-chat-plan-resolution"
            data-plan-id="${escapeHtml(resolution.plan_id)}">
            Dismiss
          </button>
        </div>
      </div>
    `;
  };
  // R20 — ONE unified list (gates + asks + chat plans, newest-first); no
  // per-kind sections or empty parallel notification surface.
  const pendingBody =
    state.rows.length === 0
      ? state.connectionRecoveryReview !== null
        || state.recoveryExcursionReturn !== null
        || state.recoveryIntentContinuation !== null
        ? ''
        : (
          state.loading
            ? renderLoading()
            : state.verified
              ? state.planResolution === null
                ? renderAllClear()
                : ''
              : renderUnverified()
          )
      : `
        <ul class="attention-list" role="list">
          ${state.rows
            .map((row) =>
              row.kind === 'approval'
                ? renderApprovalRow(
                    row.approval,
                    state.resolvingApprovals,
                    state.armedApprovals,
                  )
                : row.kind === 'ask'
                  ? renderGatewayAskRow(row.ask, state.resolvingAsks)
                  : row.kind === 'plan'
                    ? renderChatPlanRow(row.plan, state.resolvingPlans)
                    : row.kind === 'connection_recovery'
                      ? renderConnectionRecoveryRow(
                          row.recovery,
                          state.connectionRecoveryHref({
                            serverProfileId: row.recovery.serverProfileId,
                            kind: row.recovery.kind,
                            name: row.recovery.name,
                          }),
                        )
                      : renderInactiveConnectionRecoveryRow(
                          row.hint,
                          state.now,
                        ),
            )
            .join('')}
        </ul>
      `;
  const summary = state.connectionRecoveryReview?.phase === 'checking'
    ? `Rechecking ${state.connectionRecoveryReview.serverProfileLabel} for connection recovery.`
    : state.connectionRecoveryReview?.phase === 'retryable'
      ? `${state.connectionRecoveryReview.serverProfileLabel} still needs a fresh recovery check.`
      : state.connectionRecoveryReview?.phase === 'verified'
        ? `The fresh ${state.connectionRecoveryReview.serverProfileLabel} recovery check is complete.`
        : state.recoveryExcursionReturn !== null && state.blockingCount === 1
          ? `A saved return to ${state.recoveryExcursionReturn.serverProfileLabel} is ready to review.`
          : state.recoveryIntentContinuation !== null && state.blockingCount === 1
            ? state.recoveryIntentContinuation.phase === 'checking'
              ? `Rechecking ${state.recoveryIntentContinuation.areaLabel} on ${state.recoveryIntentContinuation.serverProfileLabel}.`
              : state.recoveryIntentContinuation.phase === 'waiting_for_connection'
                ? `Waiting for ${state.recoveryIntentContinuation.serverProfileLabel} before rechecking ${state.recoveryIntentContinuation.areaLabel}.`
              : state.recoveryIntentContinuation.phase === 'failed'
                ? state.recoveryIntentContinuation.remediation === 'connection'
                  ? `${state.recoveryIntentContinuation.areaLabel} is waiting on its server connection.`
                  : state.recoveryIntentContinuation.remediation === 'review'
                    ? `${state.recoveryIntentContinuation.areaLabel} needs a current-area review.`
                    : `${state.recoveryIntentContinuation.areaLabel} couldn’t be refreshed; review it or try again.`
                : `A paused return to ${state.recoveryIntentContinuation.areaLabel} is saved for when you’re ready.`
          : state.blockingCount > 0
            ? `${state.blockingCount} item${state.blockingCount === 1 ? ' is' : 's are'} waiting for you.`
            : state.loading
              ? 'Checking for anything that needs you.'
              : 'Nothing needs your attention right now.';
  const hasConnectionRecoveries = state.rows.some(
    (row) => row.kind === 'connection_recovery',
  );
  return `
    <div class="attention-popover"
      role="dialog"
      aria-labelledby="webclient-attention-title"
      aria-describedby="webclient-attention-summary"
      ${ATTENTION_DIALOG_ATTR}
      tabindex="-1">
      <div class="attention-popover-header">
        <div class="attention-popover-heading">
          <h2 class="attention-popover-title" id="webclient-attention-title">Attention</h2>
          <p class="attention-popover-summary" id="webclient-attention-summary">${escapeHtml(summary)}</p>
        </div>
        <button type="button"
          class="attention-popover-close"
          data-action="close-attention"
          ${ATTENTION_CLOSE_BUTTON_ATTR}
          aria-label="Close attention">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18"></path>
          </svg>
        </button>
      </div>
      <div class="attention-popover-body">
        ${
          state.errorText === null
            ? ''
            : `<div class="webclient-attention-error" ${ATTENTION_ERROR_ATTR}${state.errorConnectionCaused ? ' data-connection="true"' : ''}>${escapeHtml(state.errorText)}</div>`
        }
        ${state.connectionRecoveryReview === null
          ? ''
          : renderConnectionRecoveryReview(state.connectionRecoveryReview)}
        ${state.recoveryExcursionReturn === null
          ? ''
          : renderRecoveryExcursionReturn(state.recoveryExcursionReturn)}
        ${state.recoveryIntentContinuation === null
          ? ''
          : renderRecoveryIntentContinuation(
              state.recoveryIntentContinuation,
              state.canReviewRecoveryIntentContinuation,
              state.canRemediateRecoveryIntentConnection,
            )}
        ${state.planResolution === null ? '' : renderPlanResolution(state.planResolution)}
        ${pendingBody}
      </div>
      <div class="webclient-attention-footer">
        <a href="#approvals"
          data-action="open-approvals"
          ${ATTENTION_SEE_ALL_LINK_ATTR}>
          Open approvals <span aria-hidden="true">&rarr;</span>
        </a>
        ${hasConnectionRecoveries
          ? `<a href="#connections/others"
              data-action="open-connections"
              ${ATTENTION_CONNECTIONS_LINK_ATTR}>
              Open Connections <span aria-hidden="true">&rarr;</span>
            </a>`
          : ''}
      </div>
    </div>
  `;
};

export const mountApprovalAttentionPopover = (
  opts: MountApprovalAttentionPopoverOptions,
): ApprovalAttentionPopoverMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountApprovalAttentionPopover: no document available - pass `opts.document` for non-browser environments',
    );
  }

  if (
    doc.head.querySelector(`style[${ATTENTION_TOPBAR_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(ATTENTION_TOPBAR_STYLES_MARKER, '');
    style.textContent = ATTENTION_TOPBAR_STYLES;
    doc.head.appendChild(style);
  }

  const topbar = doc.createElement('div');
  topbar.setAttribute(ATTENTION_TOPBAR_HOST_ATTR, '');
  opts.host.appendChild(topbar);

  // Persistent sibling live region. The popover itself is string-rebuilt, so
  // placing role=status inside it would either miss the first announcement or
  // repeat it on every queue refresh.
  const planResolutionAnnouncer = doc.createElement('div');
  planResolutionAnnouncer.setAttribute(
    ATTENTION_CHAT_PLAN_RESOLUTION_ANNOUNCER_ATTR,
    '',
  );
  planResolutionAnnouncer.setAttribute('role', 'status');
  planResolutionAnnouncer.setAttribute('aria-live', 'polite');
  planResolutionAnnouncer.setAttribute('aria-atomic', 'true');
  opts.host.appendChild(planResolutionAnnouncer);

  // Visible errors live inside a string-rebuilt popover. Keep their polite
  // announcement in a persistent sibling so one failure is spoken once, not
  // again after each busy-state or snapshot rerender.
  const errorAnnouncer = doc.createElement('div');
  errorAnnouncer.setAttribute(ATTENTION_ERROR_ANNOUNCER_ATTR, '');
  errorAnnouncer.setAttribute('role', 'status');
  errorAnnouncer.setAttribute('aria-live', 'polite');
  errorAnnouncer.setAttribute('aria-atomic', 'true');
  opts.host.appendChild(errorAnnouncer);

  // A recovery can become clear, or a route resume can pause, while Attention
  // is already open and focused. Announce either neutral affordance from a
  // persistent sibling so the string-rebuilt dialog neither misses that
  // transition nor repeats it on every unrelated queue render.
  const recoveryReturnAnnouncer = doc.createElement('div');
  recoveryReturnAnnouncer.setAttribute(
    ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    '',
  );
  recoveryReturnAnnouncer.setAttribute('role', 'status');
  recoveryReturnAnnouncer.setAttribute('aria-live', 'polite');
  recoveryReturnAnnouncer.setAttribute('aria-atomic', 'true');
  opts.host.appendChild(recoveryReturnAnnouncer);

  let disposed = false;
  let open = false;
  let approvalPhase: 'loading' | 'ready' | 'error' = 'loading';
  let askPhase: 'loading' | 'ready' | 'error' = 'loading';
  let connectionRecoveryPhase: 'loading' | 'ready' | 'error' =
    opts.runConnectionRecoveryList === undefined ? 'ready' : 'loading';
  let approvals: ReadonlyArray<ServerPendingApproval> = [];
  let asks: ReadonlyArray<ServerPendingAsk> = [];
  let connectionRecoveries: ReadonlyArray<AttentionConnectionRecovery> = [];
  let seq: number | null = null;
  let approvalPendingCountOverride: number | null = null;
  let approvalLoadGeneration = 0;
  let askLoadGeneration = 0;
  let connectionRecoveryLoadGeneration = 0;
  // Bumped per `startApprovalSubscription` so a stale in-flight subscribe can't
  // clobber the baseline a newer reconnect re-subscribe established.
  let approvalSubscribeGeneration = 0;
  let pendingApprovalLoad: Promise<void> = Promise.resolve();
  let pendingAskLoad: Promise<void> = Promise.resolve();
  let pendingConnectionRecoveryLoad: Promise<void> = Promise.resolve();
  let pendingSubscribe: Promise<void> = Promise.resolve();
  let approvalListError: SurfaceErrorEntry | null = null;
  let approvalLiveError: SurfaceErrorEntry | null = null;
  let askListError: SurfaceErrorEntry | null = null;
  let askSubmitError: SurfaceErrorEntry | null = null;
  let connectionRecoveryListError: SurfaceErrorEntry | null = null;
  let inactiveRecoveryActionError: {
    profileId: string;
    text: string;
  } | null = null;
  let recoveryIntentActionError: string | null = null;
  const resolving = new Set<string>();
  const resolvingAsks = new Set<string>();
  // R20 — destructive-gate armed flag + chat-plan resolve in-flight, host-owned
  // so a confirm-in-progress survives a benign re-render. Safety is the explicit
  // two-step: resolving needs a deliberate Confirm (no auto-confirm) over an
  // immutable pending gate. Armed flags for gates no longer pending are pruned
  // on render (a still-pending armed gate is kept).
  const armedApprovals = new Set<string>();
  const resolvingPlans = new Set<string>();
  let planResolveError: SurfaceErrorEntry | null = null;
  let planResolveErrorPlanId: string | null = null;
  let announcedPlanResolutionKey: string | null = null;
  let announcedRecoveryReturnKey: string | null = null;
  let announcedErrorText = '';
  const unsubscribers: Array<() => void> = [];

  const planList = (): ReadonlyArray<PendingChatPlan> =>
    opts.chatPlans?.list() ?? [];
  let connectionRecoveryProfile = (() => {
    const profile = opts.connectionRecoveryProfile;
    if (
      profile === undefined
      || profile.id.trim().length === 0
      || profile.id.length > 256
    ) return null;
    const label = profile.label.trim();
    return {
      id: profile.id,
      label: label.length > 0 ? label : 'Current server',
    };
  })();
  const now = (): number => {
    const value = (opts.now ?? Date.now)();
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
  };
  const normalizeInactiveConnectionRecoveryHints = (
    hints: ReadonlyArray<AttentionInactiveConnectionRecoveryHint>,
  ): ReadonlyArray<AttentionInactiveConnectionRecoveryHint> => {
    if (opts.onReviewInactiveConnectionRecovery === undefined) return [];
    const byProfile = new Map<string, AttentionInactiveConnectionRecoveryHint>();
    for (const hint of hints) {
      if (
        hint.serverProfileId.trim().length === 0
        || hint.serverProfileId.length > 256
        || hint.serverProfileId === connectionRecoveryProfile?.id
        || !Number.isSafeInteger(hint.observedAt)
        || hint.observedAt < 0
      ) continue;
      const label = hint.serverProfileLabel.trim();
      const normalized = {
        serverProfileId: hint.serverProfileId,
        serverProfileLabel: label.length > 0 ? label : 'Saved server',
        observedAt: hint.observedAt,
      };
      const existing = byProfile.get(normalized.serverProfileId);
      if (existing === undefined || normalized.observedAt > existing.observedAt) {
        byProfile.set(normalized.serverProfileId, normalized);
      }
    }
    return [...byProfile.values()].sort((a, b) =>
      b.observedAt - a.observedAt
      || a.serverProfileId.localeCompare(b.serverProfileId));
  };
  let inactiveConnectionRecoveryHints =
    normalizeInactiveConnectionRecoveryHints(
      opts.inactiveConnectionRecoveryHints ?? [],
    );
  const normalizeRecoveryExcursionReturn = (
    value: AttentionRecoveryExcursionReturn | null | undefined,
  ): AttentionRecoveryExcursionReturn | null => {
    if (
      value === null
      || value === undefined
      || opts.onReviewRecoveryExcursionReturn === undefined
      || value.serverProfileId.trim().length === 0
      || value.serverProfileId.length > 256
      || value.serverProfileId === connectionRecoveryProfile?.id
    ) return null;
    const label = value.serverProfileLabel.trim();
    return {
      serverProfileId: value.serverProfileId,
      serverProfileLabel: label.length > 0 ? label : 'Previous server',
    };
  };
  let recoveryExcursionReturn = normalizeRecoveryExcursionReturn(
    opts.initialRecoveryExcursionReturn,
  );
  const normalizeRecoveryIntentContinuation = (
    value: AttentionRecoveryIntentContinuation | null | undefined,
  ): AttentionRecoveryIntentContinuation | null => {
    if (
      value === null
      || value === undefined
      || opts.onResumeRecoveryIntentContinuation === undefined
      || value.serverProfileId.trim().length === 0
      || value.serverProfileId.length > 256
      || value.landingHash.length === 0
      || value.landingHash.length > 512
      || !value.landingHash.startsWith('#')
      || (value.intent !== 'continue' && value.intent !== 'choose_again')
      || (
        value.phase !== 'ready'
        && value.phase !== 'checking'
        && value.phase !== 'failed'
        && value.phase !== 'waiting_for_connection'
      )
      || (
        (value.phase === 'ready' || value.phase === 'checking')
        && value.remediation !== null
      )
      || (
        value.phase === 'failed'
        && value.remediation !== 'retry'
        && value.remediation !== 'connection'
        && value.remediation !== 'review'
      )
      || (
        value.phase === 'waiting_for_connection'
        && value.remediation !== 'connection'
      )
    ) return null;
    const profileLabel = value.serverProfileLabel.trim();
    const areaLabel = value.areaLabel.trim();
    if (profileLabel.length === 0 || areaLabel.length === 0) return null;
    return {
      serverProfileId: value.serverProfileId,
      serverProfileLabel: profileLabel,
      landingHash: value.landingHash,
      areaLabel,
      intent: value.intent,
      phase: value.phase,
      remediation: value.remediation,
    };
  };
  let recoveryIntentContinuation = normalizeRecoveryIntentContinuation(
    opts.initialRecoveryIntentContinuation,
  );
  let connectionRecoveryReview: ConnectionRecoveryReviewPresentation | null =
    (() => {
      const requested = opts.initialConnectionRecoveryReview;
      if (
        requested === undefined
        || connectionRecoveryProfile === null
        || requested.serverProfileId !== connectionRecoveryProfile.id
        || opts.runConnectionRecoveryList === undefined
      ) return null;
      return {
        phase: 'checking',
        serverProfileId: connectionRecoveryProfile.id,
        serverProfileLabel: connectionRecoveryProfile.label,
      };
    })();
  let connectionRecoveryReviewSettled = false;
  if (connectionRecoveryReview !== null) open = true;
  const connectionRecoveryHref = (
    target: ProfileBoundPostSafeStopRecoveryTarget,
  ): string => opts.connectionRecoveryHref?.(target) ?? '#connections/others';

  const queryTopbar = (selector: string): HTMLElement | null => {
    const queryable = topbar as unknown as {
      querySelector?: (value: string) => HTMLElement | null;
    };
    return queryable.querySelector?.(selector) ?? null;
  };

  const focusPlanResolutionHandoff = (planId: string): void => {
    if (opts.chatPlans?.latestResolution?.()?.plan_id !== planId) return;
    const receipt = queryTopbar(
      `[${ATTENTION_CHAT_PLAN_RESOLUTION_ATTR}]`,
    );
    if (receipt?.getAttribute(ATTENTION_CHAT_PLAN_RESOLUTION_ATTR) !== planId) {
      return;
    }
    receipt
      .querySelector<HTMLElement>(`[${ATTENTION_CHAT_PLAN_LINK_ATTR}]`)
      ?.focus?.({ preventScroll: true });
  };

  const focusAttentionTrigger = (): void => {
    queryTopbar('[data-action="open-attention"]')
      ?.focus?.({ preventScroll: true });
  };

  const focusAttentionDialog = (): void => {
    queryTopbar(`[${ATTENTION_CLOSE_BUTTON_ATTR}]`)
      ?.focus?.({ preventScroll: true });
  };

  const focusAction = (
    expected: Readonly<Record<string, string>>,
  ): void => {
    const queryable = topbar as unknown as {
      querySelectorAll?: (selector: string) => Iterable<HTMLElement>;
    };
    const candidates = Array.from(
      queryable.querySelectorAll?.('[data-action]') ?? [],
    );
    const match = candidates.find((candidate) =>
      Object.entries(expected).every(
        ([attr, value]) => candidate.getAttribute(attr) === value,
      ),
    );
    if (match?.hasAttribute('disabled') === false) {
      match.focus?.({ preventScroll: true });
    }
  };

  const focusIdentityAttrs = [
    'data-action',
    'data-approval-id',
    'data-ask-id',
    'data-option-id',
    'data-plan-id',
    'data-connection-kind',
    'data-connection-name',
    'data-server-profile-id',
    'data-decision',
    'href',
  ] as const;
  type AttentionFocusIdentity = ReadonlyArray<readonly [string, string]>;

  const captureAttentionFocus = (): AttentionFocusIdentity | null => {
    const activeElement = (
      doc as unknown as { activeElement?: HTMLElement | null }
    ).activeElement;
    const containable = topbar as unknown as {
      contains?: (candidate: Node) => boolean;
    };
    if (
      activeElement == null
      || containable.contains?.(activeElement as unknown as Node) !== true
    ) {
      return null;
    }
    return focusIdentityAttrs.flatMap((attr) => {
      const value = activeElement.getAttribute?.(attr);
      return value === null || value === undefined
        ? []
        : [[attr, value] as const];
    });
  };

  const restoreAttentionFocus = (
    identity: AttentionFocusIdentity | null,
  ): void => {
    if (identity === null || identity.length === 0) return;
    const queryable = topbar as unknown as {
      querySelectorAll?: (selector: string) => Iterable<HTMLElement>;
    };
    const candidates = Array.from(
      queryable.querySelectorAll?.('[data-action]') ?? [],
    );
    const match = candidates.find((candidate) =>
      identity.every(
        ([attr, value]) => candidate.getAttribute(attr) === value,
      ),
    );
    if (match !== undefined && !match.hasAttribute('disabled')) {
      match.focus?.({ preventScroll: true });
      return;
    }
    if (open) focusAttentionDialog();
    else focusAttentionTrigger();
  };

  // R20 — the unified peek's rows: gates + asks + chat plans, newest-first.
  const mergedRows = (): AttentionRow[] => {
    const compareRows = (a: AttentionRow, b: AttentionRow): number =>
      a.sortAt !== b.sortAt
        ? b.sortAt - a.sortAt
        : a.id.localeCompare(b.id);
    const rows: AttentionRow[] = [
      ...approvals.map(
        (approval): AttentionRow => ({
          kind: 'approval',
          sortAt: approval.created_at,
          id: approval.approval_id,
          approval,
        }),
      ),
      ...asks.map(
        (ask): AttentionRow => ({
          kind: 'ask',
          sortAt: ask.created_at,
          id: ask.ask_id,
          ask,
        }),
      ),
      ...planList().map(
        (plan): AttentionRow => ({
          kind: 'plan',
          sortAt: plan.proposed_at,
          id: plan.plan_id,
          plan,
        }),
      ),
      ...inactiveConnectionRecoveryHints.map(
        (hint): AttentionRow => ({
          kind: 'inactive_profile_recovery',
          sortAt: hint.observedAt,
          id: `inactive-profile-recovery:${hint.serverProfileId}`,
          hint,
        }),
      ),
    ];
    rows.sort(compareRows);
    const recoveryRows = connectionRecoveries.map(
      (recovery): AttentionRow => ({
        kind: 'connection_recovery',
        sortAt: recovery.acknowledgedAt,
        id: `connection-recovery:${recovery.kind}/${recovery.name}`,
        recovery,
      }),
    );
    // The recovery sidecar is already in durable server-lineage order. Merge
    // that ordered source with the other timestamp-ordered rows without ever
    // sorting recoveries against one another: either acknowledgement or probe
    // wall clocks can move backwards while the server's causal order cannot.
    const merged: AttentionRow[] = [];
    let rowIndex = 0;
    let recoveryIndex = 0;
    while (rowIndex < rows.length && recoveryIndex < recoveryRows.length) {
      if (compareRows(rows[rowIndex]!, recoveryRows[recoveryIndex]!) <= 0) {
        merged.push(rows[rowIndex++]!);
      } else {
        merged.push(recoveryRows[recoveryIndex++]!);
      }
    }
    merged.push(...rows.slice(rowIndex), ...recoveryRows.slice(recoveryIndex));
    return merged;
  };

  const approvalBlockingCount = (): number =>
    Math.max(
      0,
      Math.floor(approvalPendingCountOverride ?? approvals.length),
    );

  const blockingCount = (): number =>
    approvalBlockingCount()
    + asks.length
    + planList().length
    + connectionRecoveries.length
    + inactiveConnectionRecoveryHints.length
    + (recoveryExcursionReturn === null ? 0 : 1)
    + (recoveryIntentContinuation === null ? 0 : 1);

  const render = (): void => {
    if (disposed) return;
    const focusIdentity = captureAttentionFocus();
    // Defensive — drop armed flags for gates no longer pending (resolved on
    // another device). A still-pending armed gate is KEPT (benign re-renders
    // must not disarm a confirm-in-progress).
    for (const id of [...armedApprovals]) {
      if (!approvals.some((a) => a.approval_id === id)) {
        armedApprovals.delete(id);
      }
    }
    const rows = mergedRows();
    const chatPlanState = opts.chatPlans?.state?.();
    const planResolution = opts.chatPlans?.latestResolution?.() ?? null;
    if (open && planResolution !== null) {
      const announcementKey =
        `${planResolution.plan_id}:${planResolution.outcome}`;
      if (announcedPlanResolutionKey !== announcementKey) {
        announcedPlanResolutionKey = announcementKey;
        const copy = pendingChatPlanResolutionCopy(planResolution);
        planResolutionAnnouncer.textContent = `${copy.title}. ${copy.detail}`;
      }
    }
    const recoveryAnnouncement = recoveryIntentContinuation !== null
      ? {
          key: JSON.stringify([
            'intent',
            recoveryIntentContinuation.serverProfileId,
            recoveryIntentContinuation.landingHash,
            recoveryIntentContinuation.intent,
            recoveryIntentContinuation.phase,
            recoveryIntentContinuation.remediation,
          ]),
          copy: recoveryIntentContinuation.phase === 'checking'
            ? `Rechecking ${recoveryIntentContinuation.areaLabel} on ${recoveryIntentContinuation.serverProfileLabel}.`
            : recoveryIntentContinuation.phase === 'waiting_for_connection'
              ? `Waiting for ${recoveryIntentContinuation.serverProfileLabel}. ${recoveryIntentContinuation.areaLabel} will be rechecked after it reconnects.`
            : recoveryIntentContinuation.phase === 'failed'
              ? recoveryIntentContinuation.remediation === 'connection'
                ? `${recoveryIntentContinuation.areaLabel} needs ${recoveryIntentContinuation.serverProfileLabel} connected. Review the connection to retry the exact return after reconnect.`
                : recoveryIntentContinuation.remediation === 'review'
                  ? `${recoveryIntentContinuation.areaLabel} cannot be safely rechecked here. Review the current area before ${recoveryIntentContinuation.intent === 'choose_again' ? 'choosing again' : 'continuing'}.`
                  : `${recoveryIntentContinuation.areaLabel} couldn’t be refreshed. Review the area or try again.`
              : `A paused return to ${recoveryIntentContinuation.areaLabel} is saved for when you’re ready.`,
        }
      : recoveryExcursionReturn !== null
        ? {
            key: JSON.stringify([
              'excursion',
              recoveryExcursionReturn.serverProfileId,
              recoveryExcursionReturn.serverProfileLabel,
            ]),
            copy: `A saved return to ${recoveryExcursionReturn.serverProfileLabel} is ready to review.`,
          }
        : null;
    if (recoveryAnnouncement === null) {
      announcedRecoveryReturnKey = null;
      recoveryReturnAnnouncer.textContent = '';
    } else if (open) {
      if (announcedRecoveryReturnKey !== recoveryAnnouncement.key) {
        announcedRecoveryReturnKey = recoveryAnnouncement.key;
        recoveryReturnAnnouncer.textContent = recoveryAnnouncement.copy;
      }
    }
    const chatPlanLoadError: SurfaceErrorEntry | null =
      chatPlanState?.error == null
        ? null
        : {
            error: classifyRpcError(chatPlanState.error),
            label: "Couldn't refresh Chat approvals",
          };
    // Tier 2 — connection-caused failures defer to the global offline banner
    // (keep the last-known counts; show nothing here) instead of stacking 3-5
    // raw rpc lines; only a real per-operation error shows inline, humanized.
    const errorDisplay = resolveSurfaceErrorDisplay(
      [
        approvalListError,
        approvalLiveError,
        askListError,
        askSubmitError,
        connectionRecoveryReview !== null
          && connectionRecoveryReview.phase !== 'verified'
          ? null
          : connectionRecoveryListError,
        chatPlanLoadError,
        planResolveError,
      ],
      { hasData: rows.length > 0 },
    );
    const renderedErrorText = recoveryIntentActionError
      ?? inactiveRecoveryActionError?.text
      ?? errorDisplay?.text
      ?? null;
    const nextErrorAnnouncement = renderedErrorText ?? '';
    if (nextErrorAnnouncement !== announcedErrorText) {
      announcedErrorText = nextErrorAnnouncement;
      errorAnnouncer.textContent = nextErrorAnnouncement;
    }
    const popover = open
      ? `
        <div class="webclient-attention-popover-frame">
          ${renderUnifiedPopover({
            blockingCount: blockingCount(),
            loading:
              approvalPhase === 'loading'
              || askPhase === 'loading'
              || connectionRecoveryPhase === 'loading'
              || chatPlanState?.phase === 'loading',
            verified:
              approvalPhase === 'ready'
              && askPhase === 'ready'
              && connectionRecoveryPhase === 'ready'
              && (chatPlanState?.phase ?? 'ready') === 'ready'
              && approvalListError === null
              && approvalLiveError === null
              && askListError === null
              && connectionRecoveryListError === null
              && chatPlanLoadError === null,
            errorText: renderedErrorText,
            errorConnectionCaused:
              recoveryIntentActionError === null
              && inactiveRecoveryActionError === null
              && (errorDisplay?.connectionCaused ?? false),
            rows,
            resolvingApprovals: resolving,
            resolvingAsks,
            resolvingPlans,
            armedApprovals,
            planResolution,
            connectionRecoveryHref,
            connectionRecoveryReview,
            recoveryExcursionReturn,
            recoveryIntentContinuation,
            canReviewRecoveryIntentContinuation:
              opts.onReviewRecoveryIntentContinuation !== undefined,
            canRemediateRecoveryIntentConnection:
              opts.onRemediateRecoveryIntentConnection !== undefined,
            now: now(),
          })}
        </div>
      `
      : '';
    topbar.innerHTML = `
      <div class="webclient-attention-anchor">
        ${renderAttentionSlot({ blockingCount: blockingCount(), open })}
        ${popover}
      </div>
    `;
    restoreAttentionFocus(focusIdentity);
  };

  const refreshApprovals = (): Promise<void> => {
    const gen = ++approvalLoadGeneration;
    pendingApprovalLoad = (async () => {
      try {
        const res = await opts.runApprovalList();
        if (disposed || gen !== approvalLoadGeneration) return;
        approvals = [...res.approvals];
        approvalPendingCountOverride = null;
        approvalPhase = 'ready';
        approvalListError = null;
        render();
      } catch (err) {
        if (disposed || gen !== approvalLoadGeneration) return;
        approvalPhase = 'error';
        approvalListError = { error: classifyRpcError(err), label: "Couldn't load approvals" };
        render();
      }
    })();
    return pendingApprovalLoad;
  };

  const refreshAsks = (): Promise<void> => {
    const gen = ++askLoadGeneration;
    pendingAskLoad = (async () => {
      try {
        const res = await opts.runPendingAsksList();
        if (disposed || gen !== askLoadGeneration) return;
        asks = [...res.asks];
        askPhase = 'ready';
        askListError = null;
        render();
      } catch (err) {
        if (disposed || gen !== askLoadGeneration) return;
        askPhase = 'error';
        askListError = { error: classifyRpcError(err), label: "Couldn't load gateway asks" };
        render();
      }
    })();
    return pendingAskLoad;
  };

  const refreshConnectionRecoveries = (): Promise<void> => {
    const caller = opts.runConnectionRecoveryList;
    if (caller === undefined) return Promise.resolve();
    const gen = ++connectionRecoveryLoadGeneration;
    const observedAt = now();
    if (
      connectionRecoveryReview !== null
      && connectionRecoveryReview.phase !== 'verified'
    ) {
      connectionRecoveryReview = {
        phase: 'checking',
        serverProfileId: connectionRecoveryReview.serverProfileId,
        serverProfileLabel: connectionRecoveryProfile?.label
          ?? connectionRecoveryReview.serverProfileLabel,
      };
    }
    pendingConnectionRecoveryLoad = (async () => {
      try {
        if (connectionRecoveryProfile === null) {
          throw new Error(
            'Recued could not bind connection recovery to this server profile.',
          );
        }
        const response = await caller();
        if (disposed || gen !== connectionRecoveryLoadGeneration) return;
        const projected = projectConnectionRecoveries(
          response,
          connectionRecoveryProfile,
        );
        if (projected === null) {
          // A malformed authoritative snapshot cannot keep older recovery
          // links actionable. Other Attention row kinds retain their own
          // independently verified state.
          connectionRecoveries = [];
          throw new Error('The server returned an invalid connection recovery queue.');
        }
        connectionRecoveries = projected;
        connectionRecoveryPhase = 'ready';
        connectionRecoveryListError = null;
        try {
          opts.onConnectionRecoverySnapshot?.({
            serverProfileId: connectionRecoveryProfile.id,
            hasRecoveries: projected.length > 0,
            observedAt,
          });
        } catch {
          // Local discovery is advisory. A denied persistence sink cannot turn
          // a valid server-authoritative queue into a visible list failure.
        }
        if (
          connectionRecoveryReview !== null
          && connectionRecoveryReview.phase !== 'verified'
        ) {
          connectionRecoveryReview = {
            phase: 'verified',
            serverProfileId: connectionRecoveryProfile.id,
            serverProfileLabel: connectionRecoveryProfile.label,
            recoveryCount: projected.length,
          };
          if (!connectionRecoveryReviewSettled) {
            connectionRecoveryReviewSettled = true;
            try {
              opts.onConnectionRecoveryReviewSettled?.(
                connectionRecoveryProfile.id,
              );
            } catch {
              // The fresh result remains truthful if session-marker cleanup is
              // denied. The marker store itself writes an inert tombstone first.
            }
          }
        }
        render();
      } catch (err) {
        if (disposed || gen !== connectionRecoveryLoadGeneration) return;
        connectionRecoveryPhase = 'error';
        connectionRecoveryListError = {
          error: classifyRpcError(err),
          label: "Couldn't refresh connection recovery",
        };
        if (
          connectionRecoveryReview !== null
          && connectionRecoveryReview.phase !== 'verified'
        ) {
          connectionRecoveryReview = {
            phase: 'retryable',
            serverProfileId: connectionRecoveryReview.serverProfileId,
            serverProfileLabel: connectionRecoveryProfile?.label
              ?? connectionRecoveryReview.serverProfileLabel,
          };
        }
        render();
      }
    })();
    return pendingConnectionRecoveryLoad;
  };

  const startApprovalSubscription = (
    params?: { resetSeqBaseline?: boolean },
  ): void => {
    const gen = (approvalSubscribeGeneration += 1);
    pendingSubscribe = (async () => {
      try {
        const res = await opts.runApprovalSubscribe();
        if (disposed || gen !== approvalSubscribeGeneration) return;
        // On a reconnect the server may have RESTARTED (seq epoch resets to 0);
        // a `Math.max` against the pre-restart high-water would strand us above
        // every post-restart event and drop them as stale. Adopt the snapshot's
        // seq as the new baseline then; the generation guard keeps a stale
        // in-flight subscribe from undoing it. Mount/normal keeps `Math.max`.
        seq = params?.resetSeqBaseline === true
          ? res.seq
          : Math.max(seq ?? 0, res.seq);
        approvals = [...res.approvals];
        approvalPendingCountOverride = null;
        approvalPhase = 'ready';
        approvalLiveError = null;
        approvalListError = null;
        render();
      } catch (err) {
        if (disposed || gen !== approvalSubscribeGeneration) return;
        approvalLiveError = { error: classifyRpcError(err), label: 'Live approval updates unavailable' };
        render();
      }
    })();
  };

  const onApprovalChanged = (event: { seq: number; pending_count: number }): void => {
    if (seq !== null && event.seq <= seq) return;
    seq = event.seq;
    approvalPendingCountOverride = event.pending_count;
    render();
    void refreshApprovals();
  };

  const resolveApproval = async (
    approval_id: string,
    decision: 'approve' | 'reject',
  ): Promise<void> => {
    if (resolving.has(approval_id)) return;
    resolving.add(approval_id);
    approvalListError = null;
    approvalLiveError = null;
    render();
    try {
      await opts.runApprovalResolve({ approval_id, decision });
      // Resolved — drop the row + its (now-stale) armed flag. On failure we
      // keep it armed so the Confirm stays up for a retry.
      armedApprovals.delete(approval_id);
      approvals = approvals.filter(
        (approval) => approval.approval_id !== approval_id,
      );
      approvalPendingCountOverride = null;
      approvalPhase = 'ready';
      render();
      await refreshApprovals();
    } catch (err) {
      approvalListError = { error: classifyRpcError(err), label: "Couldn't update approval", origin: 'action' };
      render();
    } finally {
      resolving.delete(approval_id);
      render();
    }
  };

  const submitGatewayAsk = async (
    ask_id: string,
    option_id: string,
  ): Promise<void> => {
    if (resolvingAsks.has(ask_id)) return;
    resolvingAsks.add(ask_id);
    askSubmitError = null;
    render();
    try {
      await opts.runPendingAskSubmitAnswer({ ask_id, option_id });
      asks = asks.filter((ask) => ask.ask_id !== ask_id);
      askPhase = 'ready';
      render();
      await refreshAsks();
    } catch (err) {
      askSubmitError = { error: classifyRpcError(err), label: "Couldn't answer gateway ask", origin: 'action' };
      render();
    } finally {
      resolvingAsks.delete(ask_id);
      render();
    }
  };

  const resolvePlan = async (
    plan_id: string,
    decision: 'approve' | 'reject',
  ): Promise<void> => {
    if (opts.runChatPlanResolve === undefined) return;
    if (resolvingPlans.has(plan_id)) return;
    resolvingPlans.add(plan_id);
    planResolveError = null;
    planResolveErrorPlanId = null;
    render();
    try {
      const plan = planList().find(
        (candidate) => candidate.plan_id === plan_id,
      );
      await opts.runChatPlanResolve({ plan_id, decision });
      if (plan !== undefined) {
        // Preserve an explicit post-decision handoff even if the broadcast is
        // lost immediately after the authoritative RPC succeeds.
        opts.chatPlans?.recordResolution?.(plan, decision);
      }
      // Reconcile immediately so a missed resolving broadcast cannot strand
      // the consumed plan after a transport drop.
      await opts.chatPlans?.refresh?.();
      focusPlanResolutionHandoff(plan_id);
    } catch (err) {
      resolvingPlans.delete(plan_id);
      planResolveError = { error: classifyRpcError(err), label: "Couldn't resolve plan", origin: 'action' };
      planResolveErrorPlanId = plan_id;
      render();
      // If another paired client resolved it first and the terminal event was
      // missed, the authoritative snapshot clears this stale row/error and
      // supplies the neutral Chat handoff.
      await opts.chatPlans?.refresh?.();
      focusPlanResolutionHandoff(plan_id);
    }
  };

  const dismissConnectionRecoveryReview = (): void => {
    const review = connectionRecoveryReview;
    if (review === null) return;
    connectionRecoveryReview = null;
    if (!connectionRecoveryReviewSettled) {
      try {
        opts.onConnectionRecoveryReviewDismissed?.(review.serverProfileId);
      } catch {
        // Explicit UI dismissal still wins in memory when storage is locked.
      }
    }
  };

  const closeAttention = (restoreTrigger: boolean): void => {
    if (!open) return;
    dismissConnectionRecoveryReview();
    open = false;
    render();
    if (restoreTrigger) focusAttentionTrigger();
  };

  const onClick = (event: Event): void => {
    const actionEl = actionElementFromEvent(event);
    if (actionEl === null) return;
    const action = actionEl.getAttribute('data-action');
    if (action === 'open-attention') {
      event.preventDefault();
      if (open) {
        closeAttention(true);
        return;
      }
      open = true;
      inactiveRecoveryActionError = null;
      if (approvalPhase !== 'ready') void refreshApprovals();
      if (askPhase !== 'ready') void refreshAsks();
      // The post-ack queue has no dedicated event stream. Opening Attention is
      // an explicit, cheap freshness boundary over the existing list read.
      if (connectionRecoveryPhase !== 'loading') {
        void refreshConnectionRecoveries();
      }
      // Opening the inbox is a natural low-cost freshness boundary. Refresh
      // even from `ready`: the Chat vault may have unlocked since a recovered
      // shell was loaded, or a disconnect may have hidden an event.
      if (opts.chatPlans?.state?.().phase !== 'loading') {
        void opts.chatPlans?.refresh?.();
      }
      render();
      focusAttentionDialog();
      return;
    }
    if (action === 'close-attention') {
      event.preventDefault();
      closeAttention(true);
      return;
    }
    if (action === 'review-inactive-connection-recovery') {
      event.preventDefault();
      const profileId = actionEl.getAttribute('data-server-profile-id');
      if (profileId === null) return;
      let result: 'opened' | 'missing' | 'unavailable' = 'unavailable';
      try {
        result = opts.onReviewInactiveConnectionRecovery?.(profileId)
          ?? 'unavailable';
      } catch {
        result = 'unavailable';
      }
      if (result === 'opened') {
        inactiveRecoveryActionError = null;
        dismissConnectionRecoveryReview();
        open = false;
        render();
        return;
      }
      inactiveRecoveryActionError = {
        profileId,
        text: result === 'missing'
          ? 'That server profile is no longer saved on this browser. The reminder was retired.'
          : 'That saved server can’t be opened from Account right now. Finish any profile action already in progress, then retry. Your current server and work were not changed.',
      };
      render();
      focusAttentionDialog();
      return;
    }
    if (action === 'review-recovery-excursion-return') {
      event.preventDefault();
      const profileId = actionEl.getAttribute('data-server-profile-id');
      if (
        profileId === null
        || recoveryExcursionReturn?.serverProfileId !== profileId
      ) return;
      let result: 'opened' | 'missing' | 'unavailable' = 'unavailable';
      try {
        result = opts.onReviewRecoveryExcursionReturn?.(profileId)
          ?? 'unavailable';
      } catch {
        result = 'unavailable';
      }
      if (result === 'opened') {
        inactiveRecoveryActionError = null;
        dismissConnectionRecoveryReview();
        open = false;
        render();
        return;
      }
      if (result === 'missing') recoveryExcursionReturn = null;
      inactiveRecoveryActionError = {
        profileId,
        text: result === 'missing'
          ? 'That return server is no longer saved on this browser. The saved return was retired; this server and your work were not changed.'
          : 'That return server can’t be opened from Account right now. Finish any profile action already in progress, then retry. This server and your work were not changed.',
      };
      render();
      focusAttentionDialog();
      return;
    }
    if (action === 'dismiss-recovery-excursion-return') {
      event.preventDefault();
      const profileId = actionEl.getAttribute('data-server-profile-id');
      if (
        profileId === null
        || recoveryExcursionReturn?.serverProfileId !== profileId
      ) return;
      recoveryExcursionReturn = null;
      inactiveRecoveryActionError = null;
      try {
        opts.onDismissRecoveryExcursionReturn?.(profileId);
      } catch {
        // The explicit in-memory dismissal still wins if storage is denied.
      }
      render();
      focusAttentionDialog();
      return;
    }
    if (action === 'resume-recovery-intent-continuation') {
      event.preventDefault();
      const continuation = recoveryIntentContinuation;
      if (continuation === null) return;
      if (
        continuation.phase === 'checking'
        || continuation.phase === 'waiting_for_connection'
        || (
          continuation.phase === 'failed'
          && continuation.remediation !== 'retry'
        )
      ) {
        focusAttentionDialog();
        return;
      }
      let result: 'started' | 'missing' | 'unavailable' = 'unavailable';
      try {
        result = opts.onResumeRecoveryIntentContinuation?.(continuation)
          ?? 'unavailable';
      } catch {
        result = 'unavailable';
      }
      if (result === 'started') {
        recoveryIntentActionError = null;
        open = false;
        render();
        // The authoritative route check can take long enough to be perceptible.
        // Keep focus on a stable shell control until the fresh route-owned
        // target is ready to take it; removing the activated button alone
        // would otherwise strand keyboard and assistive-technology focus.
        focusAttentionTrigger();
        return;
      }
      if (result === 'missing') recoveryIntentContinuation = null;
      recoveryIntentActionError = result === 'missing'
        ? 'That paused return no longer matches this server or work area. The reminder was retired.'
        : 'That work area can’t be rechecked right now. Reconnect or finish the current navigation, then retry. Your current work was not changed.';
      render();
      focusAttentionDialog();
      return;
    }
    if (action === 'remediate-recovery-intent-connection') {
      event.preventDefault();
      const continuation = recoveryIntentContinuation;
      if (
        continuation === null
        || continuation.remediation !== 'connection'
        || (
          continuation.phase !== 'failed'
          && continuation.phase !== 'waiting_for_connection'
        )
      ) return;
      let result: 'started' | 'missing' | 'unavailable' = 'unavailable';
      try {
        result = opts.onRemediateRecoveryIntentConnection?.(continuation)
          ?? 'unavailable';
      } catch {
        result = 'unavailable';
      }
      if (result === 'started') {
        recoveryIntentActionError = null;
        open = false;
        render();
        focusAttentionTrigger();
        return;
      }
      if (result === 'missing') recoveryIntentContinuation = null;
      recoveryIntentActionError = result === 'missing'
        ? 'That paused return no longer matches this server or work area. The reminder was retired.'
        : 'That server connection can’t be reviewed right now. The saved return is unchanged; review the connection again or dismiss it when you’re ready.';
      render();
      focusAttentionDialog();
      return;
    }
    if (action === 'review-recovery-intent-continuation') {
      event.preventDefault();
      const continuation = recoveryIntentContinuation;
      if (continuation === null || continuation.phase !== 'failed') return;
      let result: 'started' | 'missing' | 'unavailable' = 'unavailable';
      try {
        result = opts.onReviewRecoveryIntentContinuation?.(continuation)
          ?? 'unavailable';
      } catch {
        result = 'unavailable';
      }
      if (result === 'started') {
        recoveryIntentActionError = null;
        open = false;
        render();
        focusAttentionTrigger();
        return;
      }
      if (result === 'missing') recoveryIntentContinuation = null;
      recoveryIntentActionError = result === 'missing'
        ? 'That paused return no longer matches this server or work area. The reminder was retired.'
        : 'That work area can’t be opened for review right now. Finish the current navigation, then retry. Your current work was not changed.';
      render();
      focusAttentionDialog();
      return;
    }
    if (action === 'dismiss-recovery-intent-continuation') {
      event.preventDefault();
      if (recoveryIntentContinuation === null) return;
      recoveryIntentContinuation = null;
      recoveryIntentActionError = null;
      try {
        opts.onDismissRecoveryIntentContinuation?.();
      } catch {
        // The explicit in-memory dismissal still wins if storage is denied.
      }
      render();
      focusAttentionDialog();
      return;
    }
    if (action === 'dismiss-connection-recovery-review') {
      event.preventDefault();
      closeAttention(true);
      return;
    }
    if (action === 'retry-connection-recovery-review') {
      event.preventDefault();
      if (connectionRecoveryReview?.phase !== 'retryable') return;
      void refreshConnectionRecoveries();
      render();
      focusAttentionDialog();
      return;
    }
    if (action === 'approval-decide-server') {
      event.preventDefault();
      const approvalId = actionEl.getAttribute('data-approval-id');
      const decision = actionEl.getAttribute('data-decision');
      if (
        approvalId !== null
        && (decision === 'approve' || decision === 'reject')
      ) {
        void resolveApproval(approvalId, decision);
      }
      return;
    }
    if (action === 'gateway-ask-answer') {
      event.preventDefault();
      const askId = actionEl.getAttribute('data-ask-id');
      const optionId = actionEl.getAttribute('data-option-id');
      if (askId !== null && optionId !== null) {
        void submitGatewayAsk(askId, optionId);
      }
      return;
    }
    // R20 — destructive gates arm an inline confirm here (replacing the old
    // hollow expand-approval route): Approve → arm, Cancel → disarm, Confirm
    // routes back through `approval-decide-server` with decision=approve.
    if (action === 'approval-arm') {
      event.preventDefault();
      const approvalId = actionEl.getAttribute('data-approval-id');
      if (approvalId !== null) {
        armedApprovals.add(approvalId);
        render();
        focusAction({
          'data-action': 'approval-decide-server',
          'data-approval-id': approvalId,
          'data-decision': 'approve',
        });
      }
      return;
    }
    if (action === 'approval-disarm') {
      event.preventDefault();
      const approvalId = actionEl.getAttribute('data-approval-id');
      if (approvalId !== null) {
        armedApprovals.delete(approvalId);
        render();
        focusAction({
          'data-action': 'approval-arm',
          'data-approval-id': approvalId,
        });
      }
      return;
    }
    if (
      action === 'open-chat-plan'
      || action === 'open-approvals'
      || action === 'open-connections'
      || action === 'open-connection-recovery'
    ) {
      // Do not prevent the anchor's default hash navigation. Closing the
      // overlay on the next microtask leaves the activation target mounted
      // through the browser's default action, then reveals the destination.
      dismissConnectionRecoveryReview();
      open = false;
      void Promise.resolve().then(render);
      return;
    }
    if (action === 'chat-plan-decide') {
      event.preventDefault();
      const planId = actionEl.getAttribute('data-plan-id');
      const decision = actionEl.getAttribute('data-decision');
      if (planId !== null && (decision === 'approve' || decision === 'reject')) {
        const plan = planList().find((candidate) => candidate.plan_id === planId);
        if (decision === 'approve' && plan?.payload_available === false) return;
        void resolvePlan(planId, decision);
      }
      return;
    }
    if (action === 'dismiss-chat-plan-resolution') {
      event.preventDefault();
      const planId = actionEl.getAttribute('data-plan-id');
      if (
        planId !== null
        && opts.chatPlans?.dismissResolution !== undefined
      ) {
        opts.chatPlans.dismissResolution(planId);
        focusAttentionDialog();
      }
    }
  };

  const onDocumentClick = (event: MouseEvent): void => {
    if (!open) return;
    // Opening rebuilds the button before this same click finishes bubbling.
    // `event.target` is therefore detached by the time document sees it, but
    // the browser's original composed path still proves the click came from
    // this attention host.
    if (event.composedPath?.().includes(topbar)) return;
    const containable = topbar as unknown as {
      contains?: (candidate: Node) => boolean;
    };
    if (
      event.target !== null
      && containable.contains?.(event.target as Node) === true
    ) {
      return;
    }
    closeAttention(false);
  };

  const onDocumentKeydown = (event: KeyboardEvent): void => {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeAttention(true);
  };

  topbar.addEventListener('click', onClick);
  doc.addEventListener('click', onDocumentClick);
  doc.addEventListener('keydown', onDocumentKeydown);
  if (opts.onApprovalChanged !== undefined) {
    unsubscribers.push(opts.onApprovalChanged(onApprovalChanged));
  }
  if (opts.subscribe !== undefined) {
    unsubscribers.push(
      opts.subscribe('approval', () => {
        if (disposed) return;
        approvalPendingCountOverride = null;
        void refreshApprovals();
      }),
    );
    unsubscribers.push(
      opts.subscribe('notification.ask', () => {
        if (disposed) return;
        void refreshAsks();
      }),
    );
    unsubscribers.push(
      opts.subscribe('notification.ask_closed', () => {
        if (disposed) return;
        void refreshAsks();
      }),
    );
  }
  // Re-render for snapshot state and live-map changes. Prune resolve guards
  // after authoritative reconciliation removes the row.
  if (opts.chatPlans !== undefined) {
    unsubscribers.push(
      opts.chatPlans.subscribe(() => {
        if (disposed) return;
        const live = new Set(planList().map((p) => p.plan_id));
        for (const id of [...resolvingPlans]) {
          if (!live.has(id)) resolvingPlans.delete(id);
        }
        if (
          planResolveErrorPlanId !== null
          && !live.has(planResolveErrorPlanId)
        ) {
          planResolveError = null;
          planResolveErrorPlanId = null;
        }
        render();
      }),
    );
  }
  if (opts.subscribeConnectionRecovery !== undefined) {
    unsubscribers.push(
      opts.subscribeConnectionRecovery(() => {
        if (disposed) return;
        void refreshConnectionRecoveries();
      }),
    );
  }
  render();
  startApprovalSubscription();
  void refreshApprovals();
  void refreshAsks();
  void refreshConnectionRecoveries();
  if (open) {
    void Promise.resolve().then(() => {
      if (!disposed && open) focusAttentionDialog();
    });
  }

  // Re-arm the one-shot `approval.subscribe` on every reconnect (a restarted
  // server kept no subscription record; a failed boot-time subscribe left a
  // stale `liveError`) + refresh both queues to catch what changed offline.
  if (opts.reconnect !== undefined) {
    unsubscribers.push(
      opts.reconnect(() => {
        if (disposed) return;
        // resetSeqBaseline: adopt the re-subscribe snapshot's seq so a restarted
        // server's low post-restart events aren't dropped against the stale
        // pre-restart high-water.
        startApprovalSubscription({ resetSeqBaseline: true });
        void refreshApprovals();
        void refreshAsks();
        void refreshConnectionRecoveries();
      }),
    );
  }

  return {
    getApprovals: () => approvals,
    getAsks: () => asks,
    getConnectionRecoveries: () => connectionRecoveries,
    getInactiveConnectionRecoveryHints: () =>
      inactiveConnectionRecoveryHints,
    isOpen: () => open,
    refreshApprovals,
    refreshAsks,
    refreshConnectionRecoveries,
    setConnectionRecoveryProfileLabel: (label) => {
      if (connectionRecoveryProfile === null) return;
      const normalized = label.trim();
      if (normalized.length === 0) return;
      connectionRecoveryProfile = {
        ...connectionRecoveryProfile,
        label: normalized,
      };
      connectionRecoveries = connectionRecoveries.map((recovery) => ({
        ...recovery,
        serverProfileLabel: normalized,
      }));
      if (connectionRecoveryReview !== null) {
        connectionRecoveryReview = {
          ...connectionRecoveryReview,
          serverProfileLabel: normalized,
        };
      }
      render();
    },
    setInactiveConnectionRecoveryHints: (hints) => {
      const normalized = normalizeInactiveConnectionRecoveryHints(hints);
      const unchanged = normalized.length === inactiveConnectionRecoveryHints.length
        && normalized.every((hint, index) => {
          const current = inactiveConnectionRecoveryHints[index];
          return current !== undefined
            && current.serverProfileId === hint.serverProfileId
            && current.serverProfileLabel === hint.serverProfileLabel
            && current.observedAt === hint.observedAt;
        });
      if (unchanged) return;
      inactiveConnectionRecoveryHints = normalized;
      if (
        inactiveRecoveryActionError !== null
        && !inactiveConnectionRecoveryHints.some((hint) =>
          hint.serverProfileId === inactiveRecoveryActionError?.profileId)
      ) inactiveRecoveryActionError = null;
      render();
    },
    setRecoveryExcursionReturn: (value) => {
      const normalized = normalizeRecoveryExcursionReturn(value);
      if (
        normalized?.serverProfileId === recoveryExcursionReturn?.serverProfileId
        && normalized?.serverProfileLabel
          === recoveryExcursionReturn?.serverProfileLabel
      ) return;
      recoveryExcursionReturn = normalized;
      if (
        inactiveRecoveryActionError !== null
        && normalized?.serverProfileId !== inactiveRecoveryActionError.profileId
      ) inactiveRecoveryActionError = null;
      render();
    },
    getRecoveryExcursionReturn: () => recoveryExcursionReturn,
    setRecoveryIntentContinuation: (value) => {
      const normalized = normalizeRecoveryIntentContinuation(value);
      if (
        normalized?.serverProfileId
          === recoveryIntentContinuation?.serverProfileId
        && normalized?.serverProfileLabel
          === recoveryIntentContinuation?.serverProfileLabel
        && normalized?.landingHash === recoveryIntentContinuation?.landingHash
        && normalized?.areaLabel === recoveryIntentContinuation?.areaLabel
        && normalized?.intent === recoveryIntentContinuation?.intent
        && normalized?.phase === recoveryIntentContinuation?.phase
        && normalized?.remediation
          === recoveryIntentContinuation?.remediation
      ) return;
      recoveryIntentContinuation = normalized;
      recoveryIntentActionError = null;
      render();
    },
    completeRecoveryIntentContinuation: () => {
      recoveryIntentContinuation = null;
      recoveryIntentActionError = null;
      open = false;
      render();
    },
    getRecoveryIntentContinuation: () => recoveryIntentContinuation,
    whenLoaded: async () => {
      await Promise.all([
        pendingApprovalLoad,
        pendingAskLoad,
        pendingConnectionRecoveryLoad,
        pendingSubscribe,
        opts.chatPlans?.whenLoaded?.() ?? Promise.resolve(),
      ]);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      topbar.removeEventListener('click', onClick);
      doc.removeEventListener('click', onDocumentClick);
      doc.removeEventListener('keydown', onDocumentKeydown);
      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch {
          // Route-independent teardown is best effort; DOM removal continues.
        }
      }
      unsubscribers.length = 0;
      try {
        opts.host.removeChild(topbar);
      } catch {
        try {
          topbar.remove();
        } catch {
          // Detached fake DOMs can throw. The host is already inert.
        }
      }
      try {
        opts.host.removeChild(planResolutionAnnouncer);
      } catch {
        try {
          planResolutionAnnouncer.remove();
        } catch {
          // Detached fake DOMs can throw. The announcer is already inert.
        }
      }
      try {
        opts.host.removeChild(errorAnnouncer);
      } catch {
        try {
          errorAnnouncer.remove();
        } catch {
          // Detached fake DOMs can throw. The announcer is already inert.
        }
      }
      try {
        opts.host.removeChild(recoveryReturnAnnouncer);
      } catch {
        try {
          recoveryReturnAnnouncer.remove();
        } catch {
          // Detached fake DOMs can throw. The announcer is already inert.
        }
      }
    },
  };
};
