/** D-132 Phase 5 — Detail-drawer + reshaped enrichment-producer
 *  section render tests.
 *
 *  Pure-render coverage. The drawer + section components emit string
 *  HTML; tests assert the render output against the spec wireframe in
 *  D-132 §A.7. The host wires `data-action` clicks back
 *  to `housekeeping.trust.{read,write,dismiss_promotion}` rpcs (P4
 *  shipped) — these tests pin the data-action selectors so the host
 *  binding stays stable. */

import { describe, expect, it } from 'vitest';
import {
  initialHousekeepingPanelState,
  renderHousekeepingDetailDrawer,
  renderHousekeepingEnrichmentProducerSection,
  renderHousekeepingPanel,
  topicFromTaskId,
  type HousekeepingDrawerRunEntry,
  type HousekeepingPanelState,
} from '../server-settings/housekeeping/index.js';
import type {
  EnrichmentTrustRow,
  HousekeepingErrorEntry,
  HousekeepingTaskStatus,
} from '@recued/contracts';

const NOW = 1_700_000_000_000;

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

const deterministicTask = (
  id: string = 'enrichment.thread_signals',
  overrides: Partial<HousekeepingTaskStatus> = {},
): HousekeepingTaskStatus => ({
  meta: {
    id,
    description: `${id} — deterministic`,
    interruptible: true,
    kind: 'enrichment',
  },
  enrichment: {
    token_estimate_per_record: 0,
    source_collection_count: 200,
  },
  ...overrides,
});

const trustRow = (overrides: Partial<EnrichmentTrustRow>): EnrichmentTrustRow => ({
  topic: 'summary',
  trust_state: 'manual',
  pool_policy: 'free_then_byok',
  manual_run_count: 0,
  promotion_suggested_at: null,
  promotion_dismissed_at: null,
  updated_at: NOW,
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// topicFromTaskId
// ────────────────────────────────────────────────────────────────

describe('D-132 P5 — topicFromTaskId', () => {
  it('strips the enrichment. prefix', () => {
    expect(topicFromTaskId('enrichment.summary')).toBe('summary');
    expect(topicFromTaskId('enrichment.thread_signals')).toBe('thread_signals');
  });

  it('returns the id unchanged when the prefix is absent', () => {
    expect(topicFromTaskId('audit-compaction')).toBe('audit-compaction');
    expect(topicFromTaskId('cache-eviction-beyond-ttl')).toBe('cache-eviction-beyond-ttl');
  });

  it('strips a task_id_suffix down to the bare topic (registry/trust key)', () => {
    // Production registers `enrichment.open_loop_pressure.project` via a
    // `task_id_suffix` — the trust store + registry key on the bare topic.
    expect(topicFromTaskId('enrichment.open_loop_pressure.project')).toBe('open_loop_pressure');
  });
});

// ────────────────────────────────────────────────────────────────
// renderHousekeepingDetailDrawer — defaults + radio rendering
// ────────────────────────────────────────────────────────────────

describe('D-132 P5 — renderHousekeepingDetailDrawer', () => {
  // R25 — the drawer's Trust radios moved to the inline row control (see
  // the producer-section describe). The drawer now holds only the Model
  // pool (pool_policy) radios + the read-access cross-link.
  it('defaults the Model pool to free_then_byok when no trust row', () => {
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
    expect(html).toMatch(/value="free_then_byok"[^>]*checked/);
    // Trust-state radios are gone from the drawer.
    expect(html).not.toContain('data-action="housekeeping-trust-state-pick"');
    expect(html).not.toContain('value="manual"');
  });

  it('honours the persisted pool policy over the registry default', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: trustRow({ trust_state: 'auto', pool_policy: 'byok_only' }),
      recentRuns: [],
      errorHistory: [],
      hasConfidenceField: false,
      writing: false,
      writeError: null,
      now: NOW,
    });
    expect(html).toMatch(/value="byok_only"[^>]*checked/);
    expect(html).not.toMatch(/value="free_then_byok"[^>]*checked/);
  });

  it('renders all three Model pool radios', () => {
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
    for (const v of ['free_only', 'free_then_byok', 'byok_only']) {
      expect(html).toMatch(new RegExp(`value="${v}"`));
    }
  });

  it('exposes pool-policy-pick + a read-access link to Contracts (no MCP toggle)', () => {
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
    expect(html).toContain('data-action="housekeeping-pool-policy-pick"');
    // Trust-state-pick is inline on the row now, not in the drawer.
    expect(html).not.toContain('data-action="housekeeping-trust-state-pick"');
    expect(html).toContain('data-topic="summary"');
    // R25 — the per-topic MCP-visibility checkbox was replaced by a
    // per-contract read-access cross-link.
    expect(html).toContain('housekeeping-drawer-read-access');
    expect(html).toContain('href="#contracts"');
    expect(html).not.toContain('housekeeping-mcp-visibility-toggle');
  });

  it('disables the Model pool radios while a write is in flight', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: null,
      recentRuns: [],
      errorHistory: [],
      hasConfidenceField: false,
      writing: true,
      writeError: null,
      now: NOW,
    });
    // Three Model-pool radios; each carries a disabled attribute.
    const matches = html.match(/<input[^>]*type="radio"[^>]*disabled/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it('renders the inline error block when a write failed', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: null,
      recentRuns: [],
      errorHistory: [],
      hasConfidenceField: false,
      writing: false,
      writeError: 'rpc rejected: quota exhausted',
      now: NOW,
    });
    expect(html).toContain('rpc rejected: quota exhausted');
    expect(html).toContain('rx-msg-error');
  });
});

// ────────────────────────────────────────────────────────────────
// Drawer — scope-read + last-N runs + confidence sparkline + errors
// ────────────────────────────────────────────────────────────────

describe('D-132 P5 — drawer scope-read + history sections', () => {
  it('renders scope-read entries with collection + sample fields + record count', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask('enrichment.summary'),
      scopeRead: [
        {
          collection: 'data.mail',
          sample_field_paths: ['subject', 'body_preview', 'from'],
        },
      ],
      trustRow: null,
      recentRuns: [],
      errorHistory: [],
      hasConfidenceField: false,
      writing: false,
      writeError: null,
      now: NOW,
    });
    expect(html).toContain('data.mail');
    expect(html).toContain('subject');
    expect(html).toContain('body_preview');
    expect(html).toContain('from');
    // Source-collection count threads through from `task.enrichment`.
    expect(html).toContain('50 records');
  });

  it('renders the empty hint when scope-read is absent', () => {
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
    expect(html).toContain('No scope-of-read declared');
  });

  it('renders the last-N runs table with status + duration + tokens', () => {
    const runs: HousekeepingDrawerRunEntry[] = [
      { ts: NOW - 5_000, status: 'complete', duration_ms: 320, tokens: 1500 },
      { ts: NOW - 60_000, status: 'yield', duration_ms: 800 },
      { ts: NOW - 3_600_000, status: 'error', duration_ms: 50 },
    ];
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: null,
      recentRuns: runs,
      errorHistory: [],
      hasConfidenceField: false,
      writing: false,
      writeError: null,
      now: NOW,
    });
    expect(html).toContain('Complete');
    expect(html).toContain('Yielded');
    expect(html).toContain('Error');
    expect(html).toContain('320ms');
    expect(html).toContain('1,500');
    // Relative time formatting.
    expect(html).toContain('5s ago');
    expect(html).toContain('1m ago');
    expect(html).toContain('1h ago');
  });

  it('renders "Not run yet" when recentRuns is empty', () => {
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
    expect(html).toContain('Not run yet');
  });

  it('hides the confidence section when hasConfidenceField is false', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: null,
      recentRuns: [{ ts: NOW, status: 'complete', duration_ms: 100, confidence: 0.9 }],
      errorHistory: [],
      hasConfidenceField: false,
      writing: false,
      writeError: null,
      now: NOW,
    });
    expect(html).not.toContain('housekeeping-drawer-confidence-section');
    expect(html).not.toContain('confidence sparkline');
  });

  it('renders the confidence sparkline when hasConfidenceField is true + samples present', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: null,
      recentRuns: [
        { ts: NOW, status: 'complete', duration_ms: 100, confidence: 0.4 },
        { ts: NOW - 1_000, status: 'complete', duration_ms: 100, confidence: 0.8 },
      ],
      errorHistory: [],
      hasConfidenceField: true,
      writing: false,
      writeError: null,
      now: NOW,
    });
    expect(html).toContain('housekeeping-drawer-confidence-section');
    expect(html).toContain('avg 0.60');
    expect(html).toContain('(2 runs)');
  });

  it('renders sparkline empty hint when hasConfidenceField=true but no samples', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: null,
      recentRuns: [{ ts: NOW, status: 'complete', duration_ms: 100 }],
      errorHistory: [],
      hasConfidenceField: true,
      writing: false,
      writeError: null,
      now: NOW,
    });
    expect(html).toContain('No confidence data yet');
  });

  it('caps error history at TRUST_ERROR_HISTORY_SIZE entries', () => {
    const errors: HousekeepingErrorEntry[] = [
      { ts: NOW - 1_000, message: 'err1' },
      { ts: NOW - 2_000, message: 'err2' },
      { ts: NOW - 3_000, message: 'err3' },
      { ts: NOW - 4_000, message: 'err4' }, // 4th entry must be dropped
    ];
    const html = renderHousekeepingDetailDrawer({
      task: aiTask(),
      scopeRead: [],
      trustRow: null,
      recentRuns: [],
      errorHistory: errors,
      hasConfidenceField: false,
      writing: false,
      writeError: null,
      now: NOW,
    });
    expect(html).toContain('err1');
    expect(html).toContain('err2');
    expect(html).toContain('err3');
    expect(html).not.toContain('err4');
  });

  it('renders the wipe-semantics inline note', () => {
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
    expect(html).toContain('Disabling preserves prior enrichment data');
    expect(html).toContain('Uninstall the pack to remove rows');
  });

  it('renders the producer description from task meta', () => {
    const html = renderHousekeepingDetailDrawer({
      task: aiTask('enrichment.summary', {
        meta: {
          id: 'enrichment.summary',
          description: 'Mail summary digest — last 30 days per contact.',
          interruptible: true,
          kind: 'enrichment',
        },
      }),
      scopeRead: [],
      trustRow: null,
      recentRuns: [],
      errorHistory: [],
      hasConfidenceField: false,
      writing: false,
      writeError: null,
      now: NOW,
    });
    expect(html).toContain('Mail summary digest');
  });
});

// ────────────────────────────────────────────────────────────────
// Reshaped enrichment-producer-section — table + expand toggle
// ────────────────────────────────────────────────────────────────

describe('D-132 P5 — renderHousekeepingEnrichmentProducerSection (reshaped)', () => {
  const baseSectionProps = (
    tasks: ReadonlyArray<HousekeepingTaskStatus>,
    overrides: Partial<Parameters<typeof renderHousekeepingEnrichmentProducerSection>[0]> = {},
  ) => ({
    tasks,
    expandedTopic: null,
    trustRows: {},
    recentRuns: {},
    errorHistory: {},
    hasConfidenceField: {},
    trustWriting: {},
    trustWriteError: {},
    scopeRead: {},
    driftSignals: {},
    // D-136 P7.G — Settings UI capstone slots default to empty maps
    // here so the existing P5 tests stay focused on drawer / scope /
    // trust shapes; P7.G's own tests exercise these.
    coverageEntries: {},
    search: '',
    costFilter: 'all' as const,
    now: NOW,
    ...overrides,
  });

  it('renders a table with the spec column shape', () => {
    const html = renderHousekeepingEnrichmentProducerSection(
      baseSectionProps([aiTask()]),
    );
    expect(html).toContain('<table class="housekeeping-producer-table">');
    expect(html).toContain('<th>Producer</th>');
    expect(html).toContain('<th>Run policy</th>');
    expect(html).toContain('<th>Last run</th>');
  });

  it('shows the topic as the bare key (strips enrichment. prefix)', () => {
    const html = renderHousekeepingEnrichmentProducerSection(
      baseSectionProps([aiTask('enrichment.summary')]),
    );
    expect(html).toContain('<code>summary</code>');
    expect(html).not.toContain('<code>enrichment.summary</code>');
  });

  it('renders the toggle button with data-action housekeeping-drawer-toggle', () => {
    const html = renderHousekeepingEnrichmentProducerSection(
      baseSectionProps([aiTask('enrichment.summary')]),
    );
    expect(html).toMatch(/data-action="housekeeping-drawer-toggle"[^>]*data-topic="summary"/);
  });

  it('mounts the drawer beneath the matching topic when expandedTopic is set', () => {
    const collapsed = renderHousekeepingEnrichmentProducerSection(
      baseSectionProps([aiTask('enrichment.summary')]),
    );
    expect(collapsed).not.toContain('class="housekeeping-drawer"');

    const expanded = renderHousekeepingEnrichmentProducerSection(
      baseSectionProps([aiTask('enrichment.summary')], { expandedTopic: 'summary' }),
    );
    expect(expanded).toContain('class="housekeeping-drawer"');
    expect(expanded).toContain('data-topic="summary"');
  });

  it('disables Run now when trust=off', () => {
    const html = renderHousekeepingEnrichmentProducerSection(
      baseSectionProps([aiTask('enrichment.summary')], {
        trustRows: { summary: trustRow({ trust_state: 'off' }) },
      }),
    );
    expect(html).toMatch(/data-action="housekeeping-run-now-open"[^>]*disabled/);
  });

  it('keeps Run now enabled when trust=manual (still a manual fire path)', () => {
    const html = renderHousekeepingEnrichmentProducerSection(
      baseSectionProps([aiTask('enrichment.summary')], {
        trustRows: { summary: trustRow({ trust_state: 'manual' }) },
      }),
    );
    // No disabled attribute on the Run-now button.
    expect(html).not.toMatch(/data-action="housekeeping-run-now-open"[^>]*disabled/);
  });

  it('reflects the run policy inline per row from the persisted state + default', () => {
    // R25 — Run policy is an inline segmented control on the row (was the
    // "Trust" label + drawer radios). Each row's selected radio carries
    // `checked`; assert both rows show Auto selected — one persisted, one
    // derived from the deterministic default.
    const html = renderHousekeepingEnrichmentProducerSection(
      baseSectionProps(
        [
          aiTask('enrichment.summary'),
          deterministicTask('enrichment.thread_signals'),
        ],
        {
          trustRows: {
            summary: trustRow({ topic: 'summary', trust_state: 'auto' }),
            // thread_signals absent — falls back to deterministic default `auto`.
          },
        },
      ),
    );
    const matches = html.match(/data-trust-state="auto"[^>]*checked/g) ?? [];
    expect(matches.length).toBe(2);
    // The inline control writes trust_state via the same rpc action.
    expect(html).toContain('data-action="housekeeping-trust-state-pick"');
  });

  it('falls back to the AI default (manual) run policy when no trust row', () => {
    // Moved from the drawer (R25): the AI-surface default is `manual`.
    const html = renderHousekeepingEnrichmentProducerSection(
      baseSectionProps([aiTask('enrichment.summary')]),
    );
    expect(html).toMatch(/data-trust-state="manual"[^>]*checked/);
    expect(html).not.toMatch(/data-trust-state="off"[^>]*checked/);
    expect(html).not.toMatch(/data-trust-state="auto"[^>]*checked/);
  });

  it('threads scopeRead per topic into the drawer when expanded', () => {
    const html = renderHousekeepingEnrichmentProducerSection(
      baseSectionProps([aiTask('enrichment.summary')], {
        expandedTopic: 'summary',
        scopeRead: {
          summary: [{ collection: 'data.mail', sample_field_paths: ['subject'] }],
        },
      }),
    );
    expect(html).toContain('data.mail');
    expect(html).toContain('subject');
  });
});

// ────────────────────────────────────────────────────────────────
// renderHousekeepingPanel — props pass-through
// ────────────────────────────────────────────────────────────────

describe('D-132 P5 — panel threads drawer state through', () => {
  it('renders the drawer when state.expandedTopic matches an enrichment task', () => {
    const html = renderHousekeepingPanel({
      ...baseState({
        tasks: [aiTask('enrichment.summary')],
        expandedTopic: 'summary',
        scopeRead: {
          summary: [{ collection: 'data.mail', sample_field_paths: ['subject'] }],
        },
      }),
      now: NOW,
    });
    expect(html).toContain('class="housekeeping-drawer"');
    expect(html).toContain('data.mail');
  });

  it('does not render the drawer when expandedTopic is null', () => {
    const html = renderHousekeepingPanel({
      ...baseState({
        tasks: [aiTask('enrichment.summary')],
        expandedTopic: null,
      }),
      now: NOW,
    });
    expect(html).not.toContain('class="housekeeping-drawer"');
  });
});
