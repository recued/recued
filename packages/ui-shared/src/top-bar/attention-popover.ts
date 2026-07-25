/** D-119 Phase 4 — Attention popover.
 *
 *  The popover that drops below the top-bar Attention slot when the
 *  user clicks the counter button. Two tabs:
 *
 *    1. Blocking work     — pending approvals + tripped circuits.
 *                           Each row carries inline action buttons
 *                           (approve / reject for approvals; reset /
 *                           leave-disabled for circuit trips) so the
 *                           user resolves without leaving the popover.
 *    2. Other notifications — informational items that don't block
 *                           work (currently: recovery-key reminder).
 *
 *  Pure render module — no DOM, no rpc. Action wiring lives in the
 *  sidebar dispatcher; this module just emits the right `data-action`
 *  + `data-*` attributes for the dispatcher to pick up.
 *
 *  The recipe-bound approval card (per `project_approval_ux`) is the
 *  authoritative full-context surface; the popover is a fast-path
 *  navigator that lets the user resolve without expanding the card.
 *  Both surfaces talk to the same `approval-decide` handler. */

import { e } from '../template.js';
import type { ApprovalRequest, ServerPendingApproval } from '@recued/contracts';
import type { AutoDisabledSummary } from '@recued/scheduler';

/** Two tabs from the spec wireframe. */
export type AttentionTab = 'blocking' | 'notifications';

/** One row in tab 2. Phase 4 only renders the recovery-key reminder;
 *  future server alerts (`ServerAlert`) plug in here unchanged. */
export interface InformationalNotification {
  /** Stable id for testing + future deduplication. */
  id: string;
  /** Headline rendered as the row's primary text. */
  title: string;
  /** Optional body (one short sentence) rendered below the title. */
  body?: string;
  /** Optional inline call-to-action — emits `data-action`. */
  cta?: { label: string; action: string };
}

export interface AttentionPopoverState {
  open: boolean;
  tab: AttentionTab;
  /** Flat list of pending approvals, sorted by arrival time the
   *  caller decides. The popover renders them as-is. */
  approvals: ApprovalRequest[];
  /** D-119 Phase 10 follow-up — pending approvals the paired server is
   *  tracking (cron / reactive / mcp + pair-proxied from another
   *  device). Rendered alongside local approvals; click routes to
   *  `approval-decide-server` which calls the `approval.resolve` rpc
   *  with first-write-wins reconciliation. */
  serverApprovals: ServerPendingApproval[];
  /** Auto-disabled circuit-trip summaries — same shape the options
   *  page uses (per `project_phase_g_d118_wiring_complete`). */
  circuitTrips: AutoDisabledSummary[];
  /** Informational items for tab 2. Empty array → "All clear" empty
   *  state on that tab. */
  informational: InformationalNotification[];
  /** Reset-in-flight set keyed by `${recipe_id}::${publisher_id}` so
   *  the reset button can render `disabled aria-busy` while the rpc
   *  is pending. Mirrors the options-page pattern. */
  resetInFlight: ReadonlySet<string>;
  /** D-119 Phase 10 follow-up — server approval resolves currently in
   *  flight, keyed by `approval_id`. Drives the busy state on the
   *  approve / reject buttons in server-approval rows so a slow
   *  network can't trigger a double-resolve. */
  serverResolveInFlight: ReadonlySet<string>;
}

const inFlightKey = (recipe_id: string, publisher_id: string): string =>
  `${recipe_id}::${publisher_id}`;

// ────────────────────────────────────────────────────────────────
// Tab strip
// ────────────────────────────────────────────────────────────────

const renderTabStrip = (state: AttentionPopoverState): string => {
  const blockingCount =
    state.approvals.length
    + state.serverApprovals.length
    + state.circuitTrips.length;
  const notificationsCount = state.informational.length;
  const tab = (key: AttentionTab, label: string, count: number): string => {
    const active = state.tab === key;
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
        <span class="attention-tab-label">${e(label)}</span>
        ${badge}
      </button>
    `;
  };
  return `
    <div class="attention-tabs" role="tablist">
      ${tab('blocking', 'Blocking work', blockingCount)}
      ${tab('notifications', 'Other notifications', notificationsCount)}
    </div>
  `;
};

// ────────────────────────────────────────────────────────────────
// Approval row
// ────────────────────────────────────────────────────────────────

const renderApprovalRow = (request: ApprovalRequest): string => {
  const tier = request.risk_tier;
  const isDestructive = tier === 'destructive';
  // Destructive approvals never auto-confirm in the popover — the
  // user must expand the recipe card (which carries the "I understand
  // this cannot be undone" checkbox). The popover row delegates by
  // emitting `expand-approval` instead of approve/reject.
  if (isDestructive) {
    return `
      <li class="attention-row attention-row--approval attention-row--destructive"
        data-recipe-id="${e(request.recipe_id)}">
        <div class="attention-row-body">
          <span class="attention-row-title">${e(request.description)}</span>
          <span class="attention-row-meta">${e(request.ingredient_slug)} · destructive</span>
        </div>
        <button type="button"
          class="attention-row-action attention-row-action--review"
          data-action="expand-approval"
          data-recipe-key="${e(request.recipe_id)}"
          aria-label="Review destructive approval — confirmation required in the recipe card">
          Review…
        </button>
      </li>
    `;
  }
  return `
    <li class="attention-row attention-row--approval"
      data-recipe-id="${e(request.recipe_id)}">
      <div class="attention-row-body">
        <span class="attention-row-title">${e(request.description)}</span>
        <span class="attention-row-meta">${e(request.ingredient_slug)} · ${e(tier)}</span>
      </div>
      <div class="attention-row-actions">
        <button type="button"
          class="attention-row-action attention-row-action--reject"
          data-action="approval-decide"
          data-decision="deny"
          data-recipe-key="${e(request.recipe_id)}">
          Reject
        </button>
        <button type="button"
          class="attention-row-action attention-row-action--approve"
          data-action="approval-decide"
          data-decision="allow_once"
          data-recipe-key="${e(request.recipe_id)}">
          Approve
        </button>
      </div>
    </li>
  `;
};

// ────────────────────────────────────────────────────────────────
// Server approval row (D-119 Phase 10 follow-up)
// ────────────────────────────────────────────────────────────────
//
// Mirrors the local approval row's shape so users see one unified
// list, but routes through the `approval-decide-server` action which
// calls the server's `approval.resolve` rpc instead of the local
// `approval.respond` SW message. Destructive approvals delegate to
// the recipe-card review path the same way local destructive ones
// do — the confirm checkbox lives on the card, not the popover.
//
// Server approvals are keyed by `approval_id` (server-issued UUID)
// rather than recipe_id, since the server may have multiple pending
// approvals for the same recipe across separate runs.

const renderServerApprovalRow = (
  approval: ServerPendingApproval,
  resolveInFlight: ReadonlySet<string>,
): string => {
  const tier = approval.risk_tier;
  const isDestructive = tier === 'destructive';
  const busy = resolveInFlight.has(approval.approval_id);
  // Destructive server approvals delegate to the recipe-card review
  // path. The card carries the same expand-approval UI for local
  // approvals; the recipe-key it surfaces is the recipe_id from the
  // server payload.
  if (isDestructive) {
    return `
      <li class="attention-row attention-row--approval attention-row--destructive attention-row--server"
        data-approval-id="${e(approval.approval_id)}"
        data-recipe-id="${e(approval.recipe_id)}">
        <div class="attention-row-body">
          <span class="attention-row-title">${e(approval.description)}</span>
          <span class="attention-row-meta">${e(approval.ingredient_slug)} · destructive · server</span>
        </div>
        <button type="button"
          class="attention-row-action attention-row-action--review"
          data-action="expand-approval"
          data-recipe-key="${e(approval.recipe_id)}"
          aria-label="Review destructive approval — confirmation required in the recipe card">
          Review…
        </button>
      </li>
    `;
  }
  const busyAttrs = busy ? ' disabled aria-busy="true"' : '';
  const busyClass = busy ? ' is-busy' : '';
  return `
    <li class="attention-row attention-row--approval attention-row--server"
      data-approval-id="${e(approval.approval_id)}"
      data-recipe-id="${e(approval.recipe_id)}">
      <div class="attention-row-body">
        <span class="attention-row-title">${e(approval.description)}</span>
        <span class="attention-row-meta">${e(approval.ingredient_slug)} · ${e(tier)} · server</span>
      </div>
      <div class="attention-row-actions">
        <button type="button"
          class="attention-row-action attention-row-action--reject${busyClass}"
          data-action="approval-decide-server"
          data-decision="reject"
          data-approval-id="${e(approval.approval_id)}"${busyAttrs}>
          Reject
        </button>
        <button type="button"
          class="attention-row-action attention-row-action--approve${busyClass}"
          data-action="approval-decide-server"
          data-decision="approve"
          data-approval-id="${e(approval.approval_id)}"${busyAttrs}>
          Approve
        </button>
      </div>
    </li>
  `;
};

// ────────────────────────────────────────────────────────────────
// Circuit-trip row
// ────────────────────────────────────────────────────────────────

const renderCircuitTripRow = (
  summary: AutoDisabledSummary,
  resetInFlight: ReadonlySet<string>,
): string => {
  const busy = resetInFlight.has(inFlightKey(summary.recipe_id, summary.publisher_id));
  const reasonLine = summary.last_failure_reason
    ? `<span class="attention-row-reason">${e(summary.last_failure_reason)}</span>`
    : '';
  return `
    <li class="attention-row attention-row--circuit"
      data-recipe-id="${e(summary.recipe_id)}"
      data-publisher-id="${e(summary.publisher_id)}">
      <div class="attention-row-body">
        <span class="attention-row-title">${e(summary.name)}</span>
        <span class="attention-row-meta">auto-disabled · ${summary.consecutive_failures} failures</span>
        ${reasonLine}
      </div>
      <div class="attention-row-actions">
        <button type="button"
          class="attention-row-action attention-row-action--leave"
          data-action="attention-leave-disabled"
          data-recipe-id="${e(summary.recipe_id)}"
          data-publisher-id="${e(summary.publisher_id)}">
          Leave disabled
        </button>
        <button type="button"
          class="attention-row-action attention-row-action--reset${busy ? ' is-busy' : ''}"
          data-action="attention-reset-circuit"
          data-recipe-id="${e(summary.recipe_id)}"
          data-publisher-id="${e(summary.publisher_id)}"
          ${busy ? 'disabled aria-busy="true"' : ''}>
          ${busy ? 'Resetting…' : 'Reset'}
        </button>
      </div>
    </li>
  `;
};

// ────────────────────────────────────────────────────────────────
// Tabs
// ────────────────────────────────────────────────────────────────

const renderBlockingTab = (state: AttentionPopoverState): string => {
  const totalApprovals = state.approvals.length + state.serverApprovals.length;
  const empty = totalApprovals === 0 && state.circuitTrips.length === 0;
  if (empty) {
    return `
      <div class="attention-empty" role="status">
        <span class="attention-empty-glyph" aria-hidden="true">✓</span>
        <span class="attention-empty-text">All clear</span>
      </div>
    `;
  }
  // Local + server approvals share one section so users see one
  // unified list. Local rows render first (they're tied to a live
  // browser run with full context); server rows follow with a
  // `· server` meta-tag so the origin is obvious.
  const approvals = totalApprovals > 0
    ? `
      <div class="attention-section">
        <h3 class="attention-section-title">Approvals (${totalApprovals})</h3>
        <ul class="attention-list" role="list">
          ${state.approvals.map(renderApprovalRow).join('')}${state.serverApprovals
            .map((a) => renderServerApprovalRow(a, state.serverResolveInFlight))
            .join('')}
        </ul>
      </div>
    `
    : '';
  const circuits = state.circuitTrips.length > 0
    ? `
      <div class="attention-section">
        <h3 class="attention-section-title">Circuit trips (${state.circuitTrips.length})</h3>
        <ul class="attention-list" role="list">
          ${state.circuitTrips.map((s) => renderCircuitTripRow(s, state.resetInFlight)).join('')}
        </ul>
      </div>
    `
    : '';
  return `${approvals}${circuits}`;
};

const renderInformationalRow = (n: InformationalNotification): string => {
  const cta = n.cta
    ? `
      <button type="button"
        class="attention-row-action attention-row-action--cta"
        data-action="${e(n.cta.action)}">
        ${e(n.cta.label)}
      </button>
    `
    : '';
  return `
    <li class="attention-row attention-row--info" data-notification-id="${e(n.id)}">
      <div class="attention-row-body">
        <span class="attention-row-title">${e(n.title)}</span>
        ${n.body ? `<span class="attention-row-meta">${e(n.body)}</span>` : ''}
      </div>
      ${cta}
    </li>
  `;
};

const renderNotificationsTab = (state: AttentionPopoverState): string => {
  if (state.informational.length === 0) {
    return `
      <div class="attention-empty" role="status">
        <span class="attention-empty-glyph" aria-hidden="true">✓</span>
        <span class="attention-empty-text">All clear</span>
      </div>
    `;
  }
  return `
    <ul class="attention-list" role="list">
      ${state.informational.map(renderInformationalRow).join('')}
    </ul>
  `;
};

// ────────────────────────────────────────────────────────────────
// Popover
// ────────────────────────────────────────────────────────────────

export const renderAttentionPopover = (state: AttentionPopoverState): string => {
  if (!state.open) return '';
  const body =
    state.tab === 'blocking'
      ? renderBlockingTab(state)
      : renderNotificationsTab(state);
  return `
    <div class="attention-popover" role="dialog" aria-label="Attention">
      ${renderTabStrip(state)}
      <div class="attention-popover-body">
        ${body}
      </div>
    </div>
  `;
};
