/** D-136 P7.G — Settings UI capstone render tests.
 *
 *  Pure-render coverage. Three UI surfaces ship in P7.G:
 *    1. Topic detail drawer extensions:
 *       - Coverage panel (band + reasoning + per-axis numbers + bias
 *         hints; D-136 §A.14.4).
 *       - MCP visibility toggle (D-136 §A.13.5; per-pair user override
 *         shadowing the registry default).
 *       - Reset entry-point button (D-136 §A.12; opens the modal).
 *    2. Topic-reset modal (dry-run-then-confirm flow; D-136 §A.12).
 *    3. Panel-level pass-through of the new state slots.
 *
 *  Tests pin the data-action selectors so the host binding (sidebar
 *  + webapp) can wire `housekeeping-mcp-visibility-toggle`,
 *  `housekeeping-reset-{open,confirm,cancel,toggle-psi,done,retry}`
 *  through to the `mcp.visibility.write` + `housekeeping.topic.reset`
 *  rpcs without renderer churn. */

import { describe, expect, it } from 'vitest';
import {
  initialHousekeepingPanelState,
  initialHousekeepingResetModalState,
  renderHousekeepingDetailDrawer,
  renderHousekeepingPanel,
  renderHousekeepingTopicResetModal,
  type HousekeepingPanelState,
  type HousekeepingResetModalState,
} from '../server-settings/housekeeping/index.js';
import type {
  HousekeepingTaskStatus,
  RegistryDescribeTopicEntry,
} from '@recued/contracts';

const NOW = 1_750_000_000_000;

const baseState = (overrides?: Partial<HousekeepingPanelState>): HousekeepingPanelState => ({
  ...initialHousekeepingPanelState(),
  config: {
    preset: 'balanced',
    cycle_budget_ms: 60_000,
    cycle_interval_minutes: 15,
    allow_byok_background: false,
    pause_background_ai_until: null,
    updated_at: NOW,
  },
  ...(overrides ?? {}),
});

const aiTask = (
  id: string = 'enrichment.summary',
  overrides: Partial<HousekeepingTaskStatus> = {},
): HousekeepingTaskStatus => ({
  meta: {
    id,
    description: `${id} — test description`,
    interruptible: true,
    kind: 'enrichment',
  },
  enrichment: {
    token_estimate_per_record: 600,
    source_collection_count: 50,
    ai_path_available: true,
  },
  ...overrides,
});

const coverageEntry = (
  topic: string,
  overrides?: Partial<RegistryDescribeTopicEntry>,
): RegistryDescribeTopicEntry => ({
  topic,
  temporal_class: 'time_bound',
  identity_aggregation: 'scenario',
  lifecycle_policy: 'recompute_on_drift',
  valid_scopes: ['mail'],
  compression_class: 'lossy',
  prompt_bias_hints: ['caps_output_at_250_words'],
  description: `${topic} — test description`,
  ai_surface: true,
  mcp_exposed: 'public',
  coverage: {
    row_count: 5_000,
    latest_event_at: NOW - 2 * 60 * 60_000, // 2h ago
    producer_last_run_at: NOW - 15 * 60_000,
    producer_failure_rate_24h: 0.02,
    ai_surface: true,
  },
  coverage_quality: 'high',
  coverage_quality_reasoning: '5K+ rows; latest event 2h ago; producer success rate 98% over 24h.',
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Drawer — Coverage panel
// ────────────────────────────────────────────────────────────────

describe('D-136 P7.G — drawer Coverage panel', () => {
  it('renders the band badge + reasoning when coverageEntry is set', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: null,
      recentRuns: [],
      errorHistory: [],
      hasConfidenceField: false,
      writing: false,
      writeError: null,
      coverageEntry: coverageEntry('summary'),
      now: NOW,
    });
    expect(html).toContain('housekeeping-drawer-coverage-section');
    expect(html).toMatch(/data-band="high"/);
    expect(html).toContain('5K+ rows; latest event 2h ago');
    // Per-axis stats render.
    expect(html).toContain('5,000');
    expect(html).toContain('2.0%');
  });

  it('omits the Coverage panel when coverageEntry is absent', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: null,
      recentRuns: [],
      errorHistory: [],
      hasConfidenceField: false,
      writing: false,
      writeError: null,
      now: NOW,
    });
    expect(html).not.toContain('housekeeping-drawer-coverage-section');
  });

  it('renders prompt_bias_hints inside an expandable details element', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: null,
      recentRuns: [],
      errorHistory: [],
      hasConfidenceField: false,
      writing: false,
      writeError: null,
      coverageEntry: coverageEntry('summary', {
        prompt_bias_hints: ['caps_output_at_250_words', 'narrative_form_loses_quantitative_detail'],
      }),
      now: NOW,
    });
    expect(html).toContain('Prompt bias hints (2)');
    expect(html).toContain('caps_output_at_250_words');
    expect(html).toContain('narrative_form_loses_quantitative_detail');
  });

  it('renders the novel band when coverage_quality === novel_query_likely_uncovered', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: null,
      recentRuns: [],
      errorHistory: [],
      hasConfidenceField: false,
      writing: false,
      writeError: null,
      coverageEntry: coverageEntry('summary', {
        coverage_quality: 'novel_query_likely_uncovered',
        coverage_quality_reasoning: '0 rows — producer has not run yet.',
        coverage: {
          row_count: 0,
          latest_event_at: null,
          producer_last_run_at: null,
          producer_failure_rate_24h: 0,
          ai_surface: true,
        },
      }),
      now: NOW,
    });
    expect(html).toMatch(/data-band="novel_query_likely_uncovered"/);
    expect(html).toContain('Novel — likely uncovered');
    expect(html).toContain('never');
  });
});

// ────────────────────────────────────────────────────────────────
// Drawer — Reset entry-point
// ────────────────────────────────────────────────────────────────

describe('D-136 P7.G — drawer Reset entry-point', () => {
  it('renders the reset section + open button regardless of coverageEntry', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: null,
      recentRuns: [],
      errorHistory: [],
      hasConfidenceField: false,
      writing: false,
      writeError: null,
      now: NOW,
    });
    expect(html).toContain('housekeeping-drawer-reset-section');
    expect(html).toMatch(/data-action="housekeeping-reset-open"[^>]*data-topic="summary"/);
  });
});

// ────────────────────────────────────────────────────────────────
// Topic-reset modal — phase-by-phase render
// ────────────────────────────────────────────────────────────────

const baseImpact = {
  rows_to_tombstone: 1234,
  pinned_protected: 5,
  psi_baselines_to_drop: 1,
  estimated_recompute_tokens: 246_800,
};

const baseAppliedSummary = {
  rows_tombstoned: 1234,
  rows_recompute_enqueued: 1234,
  psi_baselines_dropped: 1,
  pinned_skipped: 5,
};

const resetState = (
  overrides: Partial<HousekeepingResetModalState>,
): HousekeepingResetModalState => ({
  ...initialHousekeepingResetModalState(),
  topic: 'summary',
  ...overrides,
});

describe('D-136 P7.G — renderHousekeepingTopicResetModal', () => {
  it('emits empty string when topic is null (modal closed)', () => {
    expect(renderHousekeepingTopicResetModal({ state: initialHousekeepingResetModalState(), now: NOW })).toBe('');
  });

  it('renders the previewing view while dry-run is in flight', () => {
    const html = renderHousekeepingTopicResetModal({
      state: resetState({ phase: 'previewing' }),
      now: NOW,
    });
    expect(html).toContain('Loading impact preview');
    expect(html).toContain('data-action="housekeeping-reset-cancel"');
  });

  it('renders the impact summary + token cost in preview phase', () => {
    const html = renderHousekeepingTopicResetModal({
      state: resetState({
        phase: 'preview',
        impact: baseImpact,
        confirmation_token: 'reset_abc123',
        expires_at: NOW + 4 * 60_000,
      }),
      now: NOW,
    });
    expect(html).toContain('1,234');
    expect(html).toContain('246,800 tokens');
    expect(html).toContain('expires in 4 min');
    expect(html).toMatch(/data-action="housekeeping-reset-confirm"[^>]*data-topic="summary"/);
    // Confirm button must NOT be disabled when token is present.
    expect(html).not.toMatch(/data-action="housekeeping-reset-confirm"[^>]*disabled/);
  });

  it('disables Confirm when confirmation_token is null (post-toggle re-mint pending)', () => {
    const html = renderHousekeepingTopicResetModal({
      state: resetState({
        phase: 'preview',
        impact: baseImpact,
        confirmation_token: null,
      }),
      now: NOW,
    });
    expect(html).toMatch(/data-action="housekeeping-reset-confirm"[^>]*disabled/);
  });

  it('renders the PSI baselines toggle + flips data-action', () => {
    const html = renderHousekeepingTopicResetModal({
      state: resetState({
        phase: 'preview',
        impact: baseImpact,
        confirmation_token: 'reset_abc123',
      }),
      now: NOW,
    });
    expect(html).toContain('data-action="housekeeping-reset-toggle-psi"');
    // Default is checked (resetPsiBaselines: null → safe default true).
    expect(html).toMatch(/data-action="housekeeping-reset-toggle-psi"[^>]*checked/);
  });

  it('renders unchecked PSI toggle when state.resetPsiBaselines === false', () => {
    const html = renderHousekeepingTopicResetModal({
      state: resetState({
        phase: 'preview',
        impact: baseImpact,
        confirmation_token: 'reset_abc123',
        resetPsiBaselines: false,
      }),
      now: NOW,
    });
    expect(html).not.toMatch(/data-action="housekeeping-reset-toggle-psi"[^>]*checked/);
  });

  it('renders the dollar estimate when modelUnitCostUsd is set', () => {
    const html = renderHousekeepingTopicResetModal({
      state: resetState({
        phase: 'preview',
        impact: baseImpact,
        confirmation_token: 'reset_abc123',
      }),
      now: NOW,
      modelUnitCostUsd: 0.0000025, // sample per-token cost
    });
    expect(html).toContain('$0.62'); // 246800 * 0.0000025
  });

  it('renders the deterministic copy when estimated_recompute_tokens is 0', () => {
    const html = renderHousekeepingTopicResetModal({
      state: resetState({
        phase: 'preview',
        impact: { ...baseImpact, estimated_recompute_tokens: 0 },
        confirmation_token: 'reset_abc123',
      }),
      now: NOW,
    });
    expect(html).toContain('No additional cost — recompute is deterministic.');
  });

  it('renders the confirming view (in-flight) with disabled buttons', () => {
    const html = renderHousekeepingTopicResetModal({
      state: resetState({
        phase: 'confirming',
        impact: baseImpact,
        confirmation_token: 'reset_abc123',
      }),
      now: NOW,
    });
    expect(html).toContain('Applying…');
    expect(html).toMatch(/data-action="housekeeping-reset-confirm"[^>]*disabled/);
    expect(html).toMatch(/data-action="housekeeping-reset-cancel"[^>]*disabled/);
  });

  it('renders the applied view + Done button after confirm succeeds', () => {
    const html = renderHousekeepingTopicResetModal({
      state: resetState({
        phase: 'applied',
        impact: { ...baseImpact, rows_to_tombstone: 0, estimated_recompute_tokens: 0 },
        appliedSummary: baseAppliedSummary,
      }),
      now: NOW,
    });
    expect(html).toContain('Reset complete for');
    expect(html).toContain('1,234'); // rows tombstoned
    expect(html).toContain('data-action="housekeeping-reset-done"');
  });

  it('renders the error view + Retry button when rpc failed', () => {
    const html = renderHousekeepingTopicResetModal({
      state: resetState({
        phase: 'error',
        error: 'enrichment store not wired on this server',
      }),
      now: NOW,
    });
    expect(html).toContain('enrichment store not wired on this server');
    expect(html).toMatch(/data-action="housekeeping-reset-retry"[^>]*data-topic="summary"/);
    expect(html).toContain('data-action="housekeeping-reset-cancel"');
  });

  it('exposes role + aria-modal on the dialog wrapper for a11y', () => {
    const html = renderHousekeepingTopicResetModal({
      state: resetState({
        phase: 'preview',
        impact: baseImpact,
        confirmation_token: 'reset_abc123',
      }),
      now: NOW,
    });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Reset enrichment topic summary"');
  });
});

// ────────────────────────────────────────────────────────────────
// Panel pass-through — reset modal mounts at the panel level
// ────────────────────────────────────────────────────────────────

describe('D-136 P7.G — panel mounts the reset modal', () => {
  it('threads the reset state into the modal renderer', () => {
    const html = renderHousekeepingPanel({
      ...baseState({
        tasks: [aiTask('enrichment.summary')],
        reset: {
          ...initialHousekeepingResetModalState(),
          topic: 'summary',
          phase: 'preview',
          impact: baseImpact,
          confirmation_token: 'reset_abc123',
          expires_at: NOW + 5 * 60_000,
        },
      }),
      now: NOW,
    });
    expect(html).toContain('class="housekeeping-reset-modal"');
    expect(html).toContain('data-phase="preview"');
    expect(html).toMatch(/data-action="housekeeping-reset-confirm"[^>]*data-topic="summary"/);
  });

  it('omits the modal when reset.topic is null (closed)', () => {
    const html = renderHousekeepingPanel({
      ...baseState({ tasks: [aiTask('enrichment.summary')] }),
      now: NOW,
    });
    expect(html).not.toContain('class="housekeeping-reset-modal"');
  });

  it('passes coverageEntries into the expanded producer drawer', () => {
    const html = renderHousekeepingPanel({
      ...baseState({
        tasks: [aiTask('enrichment.summary')],
        expandedTopic: 'summary',
        coverageEntries: { summary: coverageEntry('summary') },
      }),
      now: NOW,
    });
    // Coverage panel renders inside the drawer. R25 removed the per-topic
    // MCP-visibility toggle — read exposure is per-contract now.
    expect(html).toContain('housekeeping-drawer-coverage-section');
    expect(html).not.toContain('housekeeping-drawer-mcp-section');
  });
});
