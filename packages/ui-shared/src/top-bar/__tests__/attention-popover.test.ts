/** D-119 Phase 4 — Attention popover tests.
 *
 *  Covers the popover's render decisions across the spec's five
 *  surface points (counter accuracy, two-tab routing, approval rows,
 *  circuit-trip rows, empty state) plus the destructive-tier guard
 *  rail that delegates to the recipe-card inline approval. */

import { describe, expect, it } from 'vitest';
import type { ApprovalRequest, ServerPendingApproval } from '@recued/contracts';
import type { AutoDisabledSummary } from '@recued/scheduler';
import {
  renderAttentionPopover,
  type AttentionPopoverState,
  type InformationalNotification,
} from '../attention-popover.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const mkApproval = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  request_id: 'req-1',
  recipe_id: 'send-summary-slack',
  step_id: 'post',
  ingredient_slug: 'slack-post',
  risk_tier: 'write',
  description: 'Post summary to #sales',
  resolved_input: {},
  timestamp: '2026-04-25T12:00:00.000Z',
  ...overrides,
});

const mkServerApproval = (
  overrides: Partial<ServerPendingApproval> = {},
): ServerPendingApproval => ({
  approval_id: 'srv-appr-1',
  recipe_id: 'send-summary-slack',
  step_id: 'post',
  ingredient_slug: 'slack-post',
  risk_tier: 'write',
  description: 'Post nightly summary to #sales',
  resolved_input: {},
  created_at: 1_700_000_000_000,
  timeout_at: 1_700_000_300_000,
  initiator_instance: 'home-server',
  ...overrides,
});

const mkCircuitTrip = (overrides: Partial<AutoDisabledSummary> = {}): AutoDisabledSummary => ({
  recipe_id: 'detect-deal-risk-hubspot',
  publisher_id: 'recued-core',
  name: 'Deal Risk Detector',
  consecutive_failures: 5,
  last_process_id: 'proc-abc',
  last_finished_at: 1_700_000_000_000,
  last_failure_reason: 'HTTP 503 from HubSpot',
  ...overrides,
});

const baseState = (overrides: Partial<AttentionPopoverState> = {}): AttentionPopoverState => ({
  open: true,
  tab: 'blocking',
  approvals: [],
  serverApprovals: [],
  circuitTrips: [],
  informational: [],
  resetInFlight: new Set(),
  serverResolveInFlight: new Set(),
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Open / closed
// ────────────────────────────────────────────────────────────────

describe('renderAttentionPopover — visibility', () => {
  it('renders nothing when state.open is false', () => {
    expect(renderAttentionPopover(baseState({ open: false }))).toBe('');
  });

  it('renders the dialog wrapper when state.open is true', () => {
    const html = renderAttentionPopover(baseState());
    expect(html).toContain('class="attention-popover"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Attention"');
  });
});

// ────────────────────────────────────────────────────────────────
// Tab strip
// ────────────────────────────────────────────────────────────────

describe('renderAttentionPopover — tab strip', () => {
  it('renders both tabs and marks the active one', () => {
    const html = renderAttentionPopover(baseState({ tab: 'notifications' }));
    expect(html).toContain('Blocking work');
    expect(html).toContain('Other notifications');
    // Active tab carries aria-selected="true" + the --active modifier.
    expect(html).toMatch(/data-attention-tab="notifications"[^>]*aria-selected="true"/);
    expect(html).toMatch(/data-attention-tab="blocking"[^>]*aria-selected="false"/);
  });

  it('emits per-tab counts when items exist', () => {
    const html = renderAttentionPopover(baseState({
      approvals: [mkApproval(), mkApproval({ request_id: 'req-2', recipe_id: 'r2' })],
      serverApprovals: [mkServerApproval()],
      circuitTrips: [mkCircuitTrip()],
      informational: [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }],
    }));
    // Blocking count = 2 local approvals + 1 server approval + 1 circuit-trip = 4
    expect(html).toMatch(/data-attention-tab="blocking"[\s\S]*?attention-tab-count[^>]*>4</);
    // Notifications count = 2
    expect(html).toMatch(/data-attention-tab="notifications"[\s\S]*?attention-tab-count[^>]*>2</);
  });

  it('caps tab counts at 99+', () => {
    const approvals = Array.from({ length: 120 }, (_, i) =>
      mkApproval({ request_id: `req-${i}`, recipe_id: `recipe-${i}` }),
    );
    const html = renderAttentionPopover(baseState({ approvals }));
    expect(html).toContain('>99+<');
  });

  it('hides per-tab counts when zero', () => {
    const html = renderAttentionPopover(baseState());
    expect(html).not.toContain('attention-tab-count');
  });
});

// ────────────────────────────────────────────────────────────────
// Blocking tab — empty
// ────────────────────────────────────────────────────────────────

describe('renderAttentionPopover — blocking tab empty state', () => {
  it('shows the All clear empty state when nothing is pending', () => {
    const html = renderAttentionPopover(baseState());
    expect(html).toContain('attention-empty');
    expect(html).toContain('All clear');
  });
});

// ────────────────────────────────────────────────────────────────
// Approval rows
// ────────────────────────────────────────────────────────────────

describe('renderAttentionPopover — approval rows', () => {
  it('emits approve + reject buttons wired to approval-decide', () => {
    const html = renderAttentionPopover(baseState({
      approvals: [mkApproval({ description: 'Update deal Acme' })],
    }));
    expect(html).toContain('Update deal Acme');
    expect(html).toContain('data-action="approval-decide"');
    expect(html).toContain('data-decision="allow_once"');
    expect(html).toContain('data-decision="deny"');
    expect(html).toContain('data-recipe-key="send-summary-slack"');
  });

  it('escapes the approval description (XSS defence)', () => {
    const html = renderAttentionPopover(baseState({
      approvals: [mkApproval({ description: '<img src=x onerror=alert(1)>' })],
    }));
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('destructive approvals delegate to the recipe-card review path', () => {
    const html = renderAttentionPopover(baseState({
      approvals: [mkApproval({ risk_tier: 'destructive', description: 'Delete contact records' })],
    }));
    // No inline approve/reject — the destructive confirm checkbox
    // lives on the recipe card, so the popover row routes there.
    expect(html).toContain('data-action="expand-approval"');
    expect(html).toContain('Review');
    expect(html).not.toContain('data-decision="allow_once"');
  });

  it('emits a section header with the approval count', () => {
    const html = renderAttentionPopover(baseState({
      approvals: [
        mkApproval({ request_id: 'r1', recipe_id: 'a' }),
        mkApproval({ request_id: 'r2', recipe_id: 'b' }),
      ],
    }));
    expect(html).toContain('Approvals (2)');
  });
});

// ────────────────────────────────────────────────────────────────
// Server approval rows (D-119 Phase 10 follow-up)
// ────────────────────────────────────────────────────────────────

describe('renderAttentionPopover — server approval rows', () => {
  it('emits approve + reject buttons wired to approval-decide-server', () => {
    const html = renderAttentionPopover(baseState({
      serverApprovals: [mkServerApproval({ description: 'Email Acme thread' })],
    }));
    expect(html).toContain('Email Acme thread');
    expect(html).toContain('data-action="approval-decide-server"');
    expect(html).toContain('data-decision="approve"');
    expect(html).toContain('data-decision="reject"');
    // Server rows are keyed by approval_id rather than recipe_id
    // because the server may have multiple approvals open for the
    // same recipe across separate runs.
    expect(html).toContain('data-approval-id="srv-appr-1"');
  });

  it('tags server-origin rows with a "· server" meta hint and the --server class', () => {
    const html = renderAttentionPopover(baseState({
      serverApprovals: [mkServerApproval({ ingredient_slug: 'gmail-send' })],
    }));
    expect(html).toContain('attention-row--server');
    // Meta line: "<slug> · <tier> · server"
    expect(html).toMatch(/gmail-send · write · server/);
  });

  it('destructive server approvals delegate to the recipe-card review path', () => {
    const html = renderAttentionPopover(baseState({
      serverApprovals: [mkServerApproval({
        risk_tier: 'destructive',
        description: 'Wipe HubSpot stage data',
      })],
    }));
    // Destructive rows MUST NOT carry inline approve/reject — the
    // confirm checkbox lives on the recipe card. They route to
    // expand-approval keyed by recipe_id, the same path the local
    // destructive row uses.
    expect(html).toContain('data-action="expand-approval"');
    expect(html).toContain('data-recipe-key="send-summary-slack"');
    expect(html).not.toContain('data-action="approval-decide-server"');
    expect(html).toContain('attention-row--destructive');
    expect(html).toContain('Review');
  });

  it('marks the approve/reject buttons busy while approval.resolve is in flight', () => {
    const approval = mkServerApproval();
    const html = renderAttentionPopover(baseState({
      serverApprovals: [approval],
      serverResolveInFlight: new Set([approval.approval_id]),
    }));
    // Both buttons get the busy treatment so the user can't fire
    // the rpc twice while it's mid-flight.
    expect(html).toMatch(/attention-row-action--approve[^"]*\sis-busy/);
    expect(html).toMatch(/attention-row-action--reject[^"]*\sis-busy/);
    // Two `disabled aria-busy="true"` occurrences (one per button).
    const matches = html.match(/disabled aria-busy="true"/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('escapes the server approval description (XSS defence)', () => {
    const html = renderAttentionPopover(baseState({
      serverApprovals: [mkServerApproval({
        description: '<script>alert(1)</script>',
      })],
    }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script');
  });

  it('rolls server approvals into the unified Approvals section count', () => {
    const html = renderAttentionPopover(baseState({
      approvals: [mkApproval()],
      serverApprovals: [
        mkServerApproval({ approval_id: 'srv-1' }),
        mkServerApproval({ approval_id: 'srv-2', recipe_id: 'r2' }),
      ],
    }));
    // Local + server roll into one section so users see one list.
    expect(html).toContain('Approvals (3)');
  });
});

// ────────────────────────────────────────────────────────────────
// Circuit-trip rows
// ────────────────────────────────────────────────────────────────

describe('renderAttentionPopover — circuit-trip rows', () => {
  it('emits Reset + Leave-disabled buttons with recipe identifiers', () => {
    const html = renderAttentionPopover(baseState({
      circuitTrips: [mkCircuitTrip()],
    }));
    expect(html).toContain('Deal Risk Detector');
    expect(html).toContain('data-action="attention-reset-circuit"');
    expect(html).toContain('data-action="attention-leave-disabled"');
    expect(html).toContain('data-recipe-id="detect-deal-risk-hubspot"');
    expect(html).toContain('data-publisher-id="recued-core"');
  });

  it('renders the failure reason when the summary carries one', () => {
    const html = renderAttentionPopover(baseState({
      circuitTrips: [mkCircuitTrip({ last_failure_reason: 'HubSpot rate limit hit' })],
    }));
    expect(html).toContain('HubSpot rate limit hit');
  });

  it('disables the Reset button when the rpc is in-flight', () => {
    const trip = mkCircuitTrip();
    const html = renderAttentionPopover(baseState({
      circuitTrips: [trip],
      resetInFlight: new Set([`${trip.recipe_id}::${trip.publisher_id}`]),
    }));
    expect(html).toMatch(/attention-row-action--reset[^"]*\sis-busy/);
    expect(html).toContain('disabled aria-busy="true"');
    expect(html).toContain('Resetting…');
  });

  it('falls back gracefully when last_failure_reason is omitted', () => {
    const html = renderAttentionPopover(baseState({
      circuitTrips: [mkCircuitTrip({ last_failure_reason: undefined })],
    }));
    expect(html).not.toContain('attention-row-reason');
  });

  it('emits a section header with the circuit-trip count', () => {
    const html = renderAttentionPopover(baseState({
      circuitTrips: [
        mkCircuitTrip(),
        mkCircuitTrip({ recipe_id: 'r2', name: 'Other' }),
      ],
    }));
    expect(html).toContain('Circuit trips (2)');
  });
});

// ────────────────────────────────────────────────────────────────
// Notifications tab
// ────────────────────────────────────────────────────────────────

describe('renderAttentionPopover — notifications tab', () => {
  const recoveryReminder: InformationalNotification = {
    id: 'recovery-key-reminder',
    title: 'Set up a recovery key',
    body: 'Protect your data so you can restore credentials after a browser reset.',
    cta: { label: 'Set up', action: 'recovery-setup-start' },
  };

  it('renders the empty state when no informational items exist', () => {
    const html = renderAttentionPopover(baseState({ tab: 'notifications' }));
    expect(html).toContain('attention-empty');
    expect(html).toContain('All clear');
  });

  it('renders informational rows with optional CTA wired via data-action', () => {
    const html = renderAttentionPopover(baseState({
      tab: 'notifications',
      informational: [recoveryReminder],
    }));
    expect(html).toContain('Set up a recovery key');
    expect(html).toContain('data-action="recovery-setup-start"');
    expect(html).toContain('Protect your data');
  });

  it('renders informational rows without a CTA', () => {
    const html = renderAttentionPopover(baseState({
      tab: 'notifications',
      informational: [{ id: 'plain', title: 'Just FYI' }],
    }));
    expect(html).toContain('Just FYI');
    expect(html).not.toContain('attention-row-action--cta');
  });
});
