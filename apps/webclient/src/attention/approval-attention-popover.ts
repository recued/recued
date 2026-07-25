/** D-174 - global approval attention popover for the webclient.
 *
 *  The shared top-bar attention slot is a pure string renderer. This
 *  adapter gives the webclient a small persistent DOM host and wires
 *  the blocking attention union: approval.* plus notification.pending_asks.
 *  Reception INBOX awaiting_approval holds surface here through their
 *  gateway.preflight ask rows in notification.pending_asks.
 *  reception_approval_intent is intentionally excluded: it is a
 *  visitor-to-engine flow with no user-pending state.
 */

import {
  renderAttentionSlot,
  type AttentionTab,
} from '@recued/ui-shared/top-bar';
import type { ServerPendingApproval, ServerPendingAsk } from '@recued/contracts';

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
import type { PendingChatPlan } from '../approvals/pending-chat-plans-store.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import type { WebclientReconnectSubscriber } from '../realtime/connection-status.js';
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
export const ATTENTION_GATEWAY_ASK_ROW_ATTR =
  'data-recued-attention-gateway-ask';

export const ATTENTION_TOPBAR_STYLES = `
[${ATTENTION_TOPBAR_HOST_ATTR}] {
  position: sticky;
  top: 0;
  z-index: 60;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  min-height: 48px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border, #e4e4e7);
  background: var(--surface, #ffffff);
  color: var(--fg, #27272a);
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
[${ATTENTION_TOPBAR_HOST_ATTR}] .top-bar-attention-glyph {
  font-size: 16px;
  line-height: 1;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .top-bar-attention-badge,
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-tab-count {
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
  width: min(380px, calc(100vw - 32px));
  max-height: min(560px, calc(100vh - 80px));
  overflow: auto;
  border: 1px solid var(--border-strong, #d4d4d8);
  border-radius: 8px;
  background: var(--surface, #ffffff);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.18);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-popover {
  display: grid;
  gap: 0;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid var(--border, #e4e4e7);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-tab {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 0;
  border-right: 1px solid var(--border, #e4e4e7);
  background: var(--surface-sunk, #f4f6f8);
  color: var(--fg-muted, #71717a);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-tab:last-child {
  border-right: 0;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-tab--active {
  background: var(--surface, #ffffff);
  color: var(--fg, #27272a);
  font-weight: 650;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-popover-body {
  display: grid;
  gap: 12px;
  padding: 12px;
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
  gap: 6px;
  align-items: center;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-action {
  min-height: 30px;
  border: 1px solid var(--border-strong, #d4d4d8);
  border-radius: 8px;
  padding: 0 10px;
  background: var(--surface, #ffffff);
  color: var(--fg, #27272a);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
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
  display: flex;
  gap: 8px;
  align-items: center;
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .webclient-attention-error {
  margin: 12px 12px 0;
  color: var(--danger, #dc2626);
  background: var(--danger-weak, #fef2f2);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .webclient-attention-footer {
  display: flex;
  justify-content: flex-end;
  padding: 10px 12px;
  border-top: 1px solid var(--border, #e4e4e7);
}
[${ATTENTION_TOPBAR_HOST_ATTR}] .webclient-attention-footer a {
  color: var(--accent, #0e7490);
  font-size: 13px;
  font-weight: 650;
  text-decoration: none;
}
@media (max-width: 520px) {
  [${ATTENTION_TOPBAR_HOST_ATTR}] {
    padding: 8px 12px;
  }
  [${ATTENTION_TOPBAR_HOST_ATTR}] .webclient-attention-popover-frame {
    right: -4px;
    width: calc(100vw - 24px);
  }
  [${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row {
    grid-template-columns: 1fr;
  }
  [${ATTENTION_TOPBAR_HOST_ATTR}] .attention-row-actions {
    justify-content: flex-end;
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
  /** R20 (Option A) — live chat-plan aggregator (the bootstrap-scoped store
   *  fed by chat.plan_proposed/resolved). The popover reads it + re-renders off
   *  its change feed, surfacing pending plans in the unified peek beside gates
   *  + asks. Absent → no plans shown. */
  chatPlans?: {
    list(): ReadonlyArray<PendingChatPlan>;
    subscribe(listener: () => void): () => void;
  };
  /** R20 — resolve a chat plan: approve → chat.plan.approve, reject →
   *  chat.plan.cancel (wire verb unchanged). The chat.plan_resolved broadcast
   *  then drops it from the store → the row clears. */
  runChatPlanResolve?: (args: {
    plan_id: string;
    decision: 'approve' | 'reject';
  }) => Promise<unknown>;
}

export interface ApprovalAttentionPopoverMount {
  getApprovals(): ReadonlyArray<ServerPendingApproval>;
  getAsks(): ReadonlyArray<ServerPendingAsk>;
  isOpen(): boolean;
  refreshApprovals(): Promise<void>;
  refreshAsks(): Promise<void>;
  whenLoaded(): Promise<void>;
  dispose(): void;
}

type ActionElement = {
  getAttribute(name: string): string | null;
};

/** One row in the unified attention peek — gates + asks + chat plans, merged
 *  newest-first (R20). `sortAt` is an epoch-ms timestamp every kind carries
 *  (gate/ask `created_at`, plan client `proposed_at`). */
type AttentionRow =
  | { kind: 'approval'; sortAt: number; id: string; approval: ServerPendingApproval }
  | { kind: 'ask'; sortAt: number; id: string; ask: ServerPendingAsk }
  | { kind: 'plan'; sortAt: number; id: string; plan: PendingChatPlan };

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

const renderTabStrip = (
  tab: AttentionTab,
  blockingCount: number,
): string => {
  const renderTab = (
    key: AttentionTab,
    label: string,
    count: number,
  ): string => {
    const active = tab === key;
    const badge =
      count > 0
        ? `<span class="attention-tab-count" aria-hidden="true">${count > 99 ? '99+' : count}</span>`
        : '';
    return `
      <button type="button"
        class="attention-tab ${active ? 'attention-tab--active' : ''}"
        data-action="set-attention-tab"
        data-attention-tab="${key}"
        role="tab"
        aria-selected="${active ? 'true' : 'false'}">
        <span class="attention-tab-label">${escapeHtml(label)}</span>
        ${badge}
      </button>
    `;
  };
  return `
    <div class="attention-tabs" role="tablist">
      ${renderTab('blocking', 'Blocking work', blockingCount)}
      ${renderTab('notifications', 'Other notifications', 0)}
    </div>
  `;
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
  const slugHtml = escapeHtml(approval.ingredient_slug);

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
          <span class="attention-row-meta">approval gate - ${slugHtml} - destructive</span>
          <span class="attention-row-reason">Destructive - this cannot be undone. Confirm to proceed.</span>
        </div>
        <div class="attention-row-actions">
          <button type="button"
            class="attention-row-action${busyClass}"
            data-action="approval-disarm"
            data-approval-id="${idAttr}"${busyAttrs}>
            Cancel
          </button>
          <button type="button"
            class="attention-row-action attention-row-action--confirm${busyClass}"
            data-action="approval-decide-server"
            data-decision="approve"
            data-approval-id="${idAttr}"${busyAttrs}>
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
          <span class="attention-row-meta">approval gate - ${slugHtml} - destructive</span>
        </div>
        <div class="attention-row-actions">
          <button type="button"
            class="attention-row-action attention-row-action--reject${busyClass}"
            data-action="approval-decide-server"
            data-decision="reject"
            data-approval-id="${idAttr}"${busyAttrs}>
            Reject
          </button>
          <button type="button"
            class="attention-row-action attention-row-action--approve${busyClass}"
            data-action="approval-arm"
            data-approval-id="${idAttr}"${busyAttrs}>
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
        <span class="attention-row-meta">approval gate - ${slugHtml} - ${escapeHtml(tier)}</span>
      </div>
      <div class="attention-row-actions">
        <button type="button"
          class="attention-row-action attention-row-action--reject${busyClass}"
          data-action="approval-decide-server"
          data-decision="reject"
          data-approval-id="${idAttr}"${busyAttrs}>
          Reject
        </button>
        <button type="button"
          class="attention-row-action attention-row-action--approve${busyClass}"
          data-action="approval-decide-server"
          data-decision="approve"
          data-approval-id="${idAttr}"${busyAttrs}>
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
          data-option-id="${escapeHtml(option.id)}"${busyAttrs}>
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
        <span class="attention-row-meta">gateway ask</span>
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
  const busyAttrs = busy ? ' disabled aria-busy="true"' : '';
  const busyClass = busy ? ' is-busy' : '';
  const idAttr = escapeHtml(plan.plan_id);
  return `
    <li class="attention-row attention-row--chat-plan"
      data-attention-kind="chat-plan"
      data-plan-id="${idAttr}">
      <div class="attention-row-body">
        <span class="attention-row-title">Run ${escapeHtml(plan.tool)}</span>
        <span class="attention-row-meta">chat plan - tier ${plan.tier}</span>
      </div>
      <div class="attention-row-actions">
        <button type="button"
          class="attention-row-action attention-row-action--reject${busyClass}"
          data-action="chat-plan-decide"
          data-decision="reject"
          data-plan-id="${idAttr}"${busyAttrs}>
          Reject
        </button>
        <button type="button"
          class="attention-row-action attention-row-action--approve${busyClass}"
          data-action="chat-plan-decide"
          data-decision="approve"
          data-plan-id="${idAttr}"${busyAttrs}>
          Approve
        </button>
      </div>
    </li>
  `;
};

const renderUnifiedPopover = (state: {
  open: boolean;
  tab: AttentionTab;
  blockingCount: number;
  rows: ReadonlyArray<AttentionRow>;
  resolvingApprovals: ReadonlySet<string>;
  resolvingAsks: ReadonlySet<string>;
  resolvingPlans: ReadonlySet<string>;
  armedApprovals: ReadonlySet<string>;
}): string => {
  if (!state.open) return '';
  const renderAllClear = (): string => `
    <div class="attention-empty" role="status">
      <span class="attention-empty-glyph" aria-hidden="true">&#10003;</span>
      <span class="attention-empty-text">All clear</span>
    </div>
  `;
  // R20 — ONE unified list (gates + asks + chat plans, newest-first); no
  // per-kind section headers. The notifications tab stays informational-only.
  const body =
    state.tab === 'notifications' || state.rows.length === 0
      ? renderAllClear()
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
                  : renderChatPlanRow(row.plan, state.resolvingPlans),
            )
            .join('')}
        </ul>
      `;
  return `
    <div class="attention-popover" role="dialog" aria-label="Attention">
      ${renderTabStrip(state.tab, state.blockingCount)}
      <div class="attention-popover-body">
        ${body}
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

  let disposed = false;
  let open = false;
  let tab: AttentionTab = 'blocking';
  let approvalPhase: 'loading' | 'ready' | 'error' = 'loading';
  let askPhase: 'loading' | 'ready' | 'error' = 'loading';
  let approvals: ReadonlyArray<ServerPendingApproval> = [];
  let asks: ReadonlyArray<ServerPendingAsk> = [];
  let seq: number | null = null;
  let approvalPendingCountOverride: number | null = null;
  let approvalLoadGeneration = 0;
  let askLoadGeneration = 0;
  // Bumped per `startApprovalSubscription` so a stale in-flight subscribe can't
  // clobber the baseline a newer reconnect re-subscribe established.
  let approvalSubscribeGeneration = 0;
  let pendingApprovalLoad: Promise<void> = Promise.resolve();
  let pendingAskLoad: Promise<void> = Promise.resolve();
  let pendingSubscribe: Promise<void> = Promise.resolve();
  let approvalListError: SurfaceErrorEntry | null = null;
  let approvalLiveError: SurfaceErrorEntry | null = null;
  let askListError: SurfaceErrorEntry | null = null;
  let askSubmitError: SurfaceErrorEntry | null = null;
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
  const unsubscribers: Array<() => void> = [];

  const planList = (): ReadonlyArray<PendingChatPlan> =>
    opts.chatPlans?.list() ?? [];

  // R20 — the unified peek's rows: gates + asks + chat plans, newest-first.
  const mergedRows = (): AttentionRow[] => {
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
    ];
    return rows.sort((a, b) =>
      a.sortAt !== b.sortAt ? b.sortAt - a.sortAt : a.id.localeCompare(b.id),
    );
  };

  const approvalBlockingCount = (): number =>
    Math.max(
      0,
      Math.floor(approvalPendingCountOverride ?? approvals.length),
    );

  const blockingCount = (): number =>
    approvalBlockingCount() + asks.length + planList().length;

  const render = (): void => {
    if (disposed) return;
    // Defensive — drop armed flags for gates no longer pending (resolved on
    // another device). A still-pending armed gate is KEPT (benign re-renders
    // must not disarm a confirm-in-progress).
    for (const id of [...armedApprovals]) {
      if (!approvals.some((a) => a.approval_id === id)) {
        armedApprovals.delete(id);
      }
    }
    const rows = mergedRows();
    // Tier 2 — connection-caused failures defer to the global offline banner
    // (keep the last-known counts; show nothing here) instead of stacking 3-5
    // raw rpc lines; only a real per-operation error shows inline, humanized.
    const errorDisplay = resolveSurfaceErrorDisplay(
      [approvalListError, approvalLiveError, askListError, askSubmitError, planResolveError],
      { hasData: rows.length > 0 },
    );
    const popover = open
      ? `
        <div class="webclient-attention-popover-frame">
          ${
            errorDisplay !== null
              ? `<div class="webclient-attention-error" ${ATTENTION_ERROR_ATTR}${errorDisplay.connectionCaused ? ' data-connection="true"' : ''}>${escapeHtml(errorDisplay.text)}</div>`
              : ''
          }
          ${renderUnifiedPopover({
            open: true,
            tab,
            blockingCount: blockingCount(),
            rows,
            resolvingApprovals: resolving,
            resolvingAsks,
            resolvingPlans,
            armedApprovals,
          })}
          <div class="webclient-attention-footer">
            <a href="#approvals" ${ATTENTION_SEE_ALL_LINK_ATTR}>See all</a>
          </div>
        </div>
      `
      : '';
    topbar.innerHTML = `
      <div class="webclient-attention-anchor">
        ${renderAttentionSlot({ blockingCount: blockingCount(), open })}
        ${popover}
      </div>
    `;
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
    render();
    try {
      await opts.runChatPlanResolve({ plan_id, decision });
      // SUCCESS — KEEP the guard so a second click can't re-fire approve before
      // the chat.plan_resolved broadcast drops the plan from the store (Option A
      // has no list rpc to re-fetch). Stale guards are pruned on store change.
    } catch (err) {
      resolvingPlans.delete(plan_id);
      planResolveError = { error: classifyRpcError(err), label: "Couldn't resolve plan", origin: 'action' };
      render();
    }
  };

  const onClick = (event: Event): void => {
    const actionEl = actionElementFromEvent(event);
    if (actionEl === null) return;
    const action = actionEl.getAttribute('data-action');
    if (action === 'open-attention') {
      event.preventDefault();
      open = !open;
      if (open && approvalPhase !== 'ready') void refreshApprovals();
      if (open && askPhase !== 'ready') void refreshAsks();
      render();
      return;
    }
    if (action === 'set-attention-tab') {
      event.preventDefault();
      const next = actionEl.getAttribute('data-attention-tab');
      if (next === 'blocking' || next === 'notifications') {
        tab = next;
        render();
      }
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
      }
      return;
    }
    if (action === 'approval-disarm') {
      event.preventDefault();
      const approvalId = actionEl.getAttribute('data-approval-id');
      if (approvalId !== null) {
        armedApprovals.delete(approvalId);
        render();
      }
      return;
    }
    if (action === 'chat-plan-decide') {
      event.preventDefault();
      const planId = actionEl.getAttribute('data-plan-id');
      const decision = actionEl.getAttribute('data-decision');
      if (planId !== null && (decision === 'approve' || decision === 'reject')) {
        void resolvePlan(planId, decision);
      }
    }
  };

  topbar.addEventListener('click', onClick);
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
  // R20 — re-render when the live chat-plan store changes (a plan proposed or
  // resolved on any surface). The store owns the bus subscriptions. Also prunes
  // in-flight guards for plans the store has dropped so a kept-on-success guard
  // doesn't linger past the row.
  if (opts.chatPlans !== undefined) {
    unsubscribers.push(
      opts.chatPlans.subscribe(() => {
        if (disposed) return;
        const live = new Set(planList().map((p) => p.plan_id));
        for (const id of [...resolvingPlans]) {
          if (!live.has(id)) resolvingPlans.delete(id);
        }
        render();
      }),
    );
  }
  render();
  startApprovalSubscription();
  void refreshApprovals();
  void refreshAsks();

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
      }),
    );
  }

  return {
    getApprovals: () => approvals,
    getAsks: () => asks,
    isOpen: () => open,
    refreshApprovals,
    refreshAsks,
    whenLoaded: async () => {
      await Promise.all([pendingApprovalLoad, pendingAskLoad, pendingSubscribe]);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      topbar.removeEventListener('click', onClick);
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
    },
  };
};
