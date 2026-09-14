/** D-123 Phase 5 — Settings → Server → Housekeeping panel render +
 *  cost preview tests.
 *
 *  Pure-render coverage: panel branches on `loading` / `error` /
 *  `config` presence, preset picker reflects active vs draft,
 *  custom-window fields show iff preset === 'custom', task status
 *  table renders one row per registered task and splits core vs
 *  enrichment. The cost preview helper is the load-bearing math
 *  behind the *Run now* dialog's dollar estimate. */

import { describe, expect, it } from 'vitest';
import {
  computeHousekeepingCostPreview,
  initialHousekeepingPanelState,
  initialHousekeepingRunNowDialogState,
  renderHousekeepingPanel,
  renderHousekeepingPresetPicker,
  renderHousekeepingRunNowConfirmDialog,
  renderHousekeepingTaskStatusTable,
  type HousekeepingPanelState,
} from '../server-settings/housekeeping/index.js';
import type { HousekeepingTaskStatus } from '@recued/contracts';

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

const taskStatus = (
  id: string,
  kind: 'core' | 'enrichment' = 'core',
  overrides: Partial<HousekeepingTaskStatus> = {},
): HousekeepingTaskStatus => ({
  meta: { id, description: `${id} — test`, interruptible: true, kind },
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// computeHousekeepingCostPreview
// ────────────────────────────────────────────────────────────────

describe('D-123 P5 — computeHousekeepingCostPreview', () => {
  it('returns deterministic = true for 0-token producers', () => {
    const preview = computeHousekeepingCostPreview({
      enrichment: { token_estimate_per_record: 0, source_collection_count: 1234 },
    });
    expect(preview.deterministic).toBe(true);
    expect(preview.estimated_tokens).toBe(0);
    expect(preview.estimated_cost_usd).toBeUndefined();
  });

  it('multiplies tokens × source-collection size for AI producers', () => {
    const preview = computeHousekeepingCostPreview({
      enrichment: { token_estimate_per_record: 250, source_collection_count: 100 },
    });
    expect(preview.deterministic).toBe(false);
    expect(preview.estimated_tokens).toBe(25_000);
    expect(preview.estimated_cost_usd).toBeUndefined();
  });

  it('attaches a USD estimate when the model unit cost is supplied', () => {
    const preview = computeHousekeepingCostPreview({
      enrichment: { token_estimate_per_record: 1_000, source_collection_count: 50 },
      model_unit_cost_usd: 0.000_005,
    });
    expect(preview.estimated_tokens).toBe(50_000);
    expect(preview.estimated_cost_usd).toBeCloseTo(0.25, 5);
  });

  it('passes ai_path_available + ai_path_reason through for AI producers', () => {
    const preview = computeHousekeepingCostPreview({
      enrichment: {
        token_estimate_per_record: 600,
        source_collection_count: 50,
        ai_path_available: false,
        ai_path_reason: 'no_byok_no_freepool',
      },
    });
    expect(preview.ai_required).toBe(true);
    expect(preview.ai_path_available).toBe(false);
    expect(preview.ai_path_reason).toBe('no_byok_no_freepool');
  });

  it('marks deterministic producers as ai_required=false even when probe fields are absent', () => {
    const preview = computeHousekeepingCostPreview({
      enrichment: { token_estimate_per_record: 0, source_collection_count: 100 },
    });
    expect(preview.ai_required).toBe(false);
    expect(preview.ai_path_available).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// renderHousekeepingRunNowConfirmDialog — AI-availability warning
// ────────────────────────────────────────────────────────────────

describe('D-123 follow-on — Run Now dialog AI-availability warning', () => {
  const aiTask = (overrides?: Partial<HousekeepingTaskStatus>): HousekeepingTaskStatus => ({
    meta: {
      id: 'enrichment.summary',
      description: 'Mail summary',
      interruptible: true,
      kind: 'enrichment',
      idle_eligible: false,
    },
    enrichment: {
      token_estimate_per_record: 600,
      source_collection_count: 50,
      ai_path_available: true,
    },
    ...overrides,
  });

  it('renders the standard cost preview when AI is available', () => {
    const html = renderHousekeepingRunNowConfirmDialog({
      state: {
        ...initialHousekeepingRunNowDialogState(),
        task_id: 'enrichment.summary',
      },
      task: aiTask(),
    });
    expect(html).toContain('Estimated cost');
    expect(html).not.toContain('Configure AI');
    expect(html).toContain('role="dialog"');
    expect(html).toContain(
      'aria-labelledby="housekeeping-runnow-enrichment.summary-title"',
    );
    expect(html).toContain(
      'aria-describedby="housekeeping-runnow-enrichment.summary-body"',
    );
    expect(html).toContain(
      'id="housekeeping-runnow-enrichment.summary-title"',
    );
    // Run Now button must NOT be disabled.
    expect(html).toMatch(/data-action="housekeeping-run-now-confirm"[^>]*>(?:[^<]*Run now[^<]*)<\/button>/);
  });

  it('renders the no-AI warning + disables Run Now when ai_path_available is false', () => {
    const html = renderHousekeepingRunNowConfirmDialog({
      state: {
        ...initialHousekeepingRunNowDialogState(),
        task_id: 'enrichment.summary',
      },
      task: aiTask({
        enrichment: {
          token_estimate_per_record: 600,
          source_collection_count: 50,
          ai_path_available: false,
          ai_path_reason: 'no_byok_no_freepool',
        },
      }),
    });
    expect(html).toContain('No AI set up');
    expect(html).toContain('Settings, AI');
    // Run Now button must be disabled.
    expect(html).toMatch(/data-action="housekeeping-run-now-confirm"[^>]*disabled/);
  });

  it('uses the quota_exhausted copy when reason flips', () => {
    const html = renderHousekeepingRunNowConfirmDialog({
      state: {
        ...initialHousekeepingRunNowDialogState(),
        task_id: 'enrichment.summary',
      },
      task: aiTask({
        enrichment: {
          token_estimate_per_record: 600,
          source_collection_count: 50,
          ai_path_available: false,
          ai_path_reason: 'quota_exhausted',
        },
      }),
    });
    expect(html).toContain('You have used up your AI for today');
    expect(html).toMatch(/data-action="housekeeping-run-now-confirm"[^>]*disabled/);
  });
});

// ────────────────────────────────────────────────────────────────
// renderHousekeepingPanel
// ────────────────────────────────────────────────────────────────

describe('D-123 P5 — renderHousekeepingPanel', () => {
  it('shows a loading hint while config is null + loading is true', () => {
    const html = renderHousekeepingPanel({
      ...initialHousekeepingPanelState(),
      loading: true,
      now: NOW,
    });
    expect(html).toContain('Loading housekeeping config');
  });

  it('renders the preset picker + AI producers once config lands', () => {
    // R25 — the core-tasks table graduated to Server ▸ Maintenance; the
    // Housekeeping panel is now schedule + AI producers only.
    const html = renderHousekeepingPanel({
      ...baseState(),
      tasks: [taskStatus('enrichment.thread_signals', 'enrichment')],
      now: NOW,
    });
    expect(html).toContain('housekeeping-preset-picker');
    expect(html).toContain('AI producers');
    expect(html).toContain('housekeeping-producer-table');
    expect(html).toContain('thread_signals');
    // The core-tasks table is gone from this panel.
    expect(html).not.toContain('housekeeping-task-table');
  });

  it('renders custom-window fields only when draft preset is custom', () => {
    const noCustom = renderHousekeepingPanel({ ...baseState(), now: NOW });
    expect(noCustom).not.toContain('housekeeping-custom-fields');
    const withCustom = renderHousekeepingPanel({
      ...baseState(),
      draftPreset: 'custom',
      now: NOW,
    });
    expect(withCustom).toContain('housekeeping-custom-fields');
  });
});

describe('D-123 P5 — renderHousekeepingPresetPicker', () => {
  it('checks the active preset when no draft is set', () => {
    const html = renderHousekeepingPresetPicker({
      active: 'balanced',
      draft: null,
      saving: false,
    });
    // "balanced" radio is checked.
    expect(html).toMatch(/value="balanced"[^>]*checked/);
  });

  it('overrides the active radio when a draft is set', () => {
    const html = renderHousekeepingPresetPicker({
      active: 'balanced',
      draft: 'aggressive',
      saving: false,
    });
    expect(html).toMatch(/value="aggressive"[^>]*checked/);
    expect(html).not.toMatch(/value="balanced"[^>]*checked/);
  });
});

describe('D-123 P5 — renderHousekeepingTaskStatusTable', () => {
  it('splits core vs enrichment tasks per the kind filter', () => {
    const tasks: HousekeepingTaskStatus[] = [
      taskStatus('audit-compaction', 'core'),
      taskStatus('enrichment.thread_signals', 'enrichment'),
    ];
    const coreOnly = renderHousekeepingTaskStatusTable({
      tasks,
      kind: 'core',
      now: NOW,
    });
    expect(coreOnly).toContain('audit-compaction');
    expect(coreOnly).not.toContain('thread_signals');
  });

  it('⛔ D-250 § D — a measured cost RENDERS; an unmeasured one is an em dash', () => {
    // ⚠ The distinction the column exists to preserve: most housekeeping tasks
    // are deterministic and never call a provider. Rendering those as "0" would
    // claim a measurement nobody took, and would make a task that ran AI for
    // free indistinguishable from one with no AI in it at all.
    const html = renderHousekeepingTaskStatusTable({
      tasks: [
        taskStatus('summarize', 'enrichment', {
          state: {
            task_id: 'summarize',
            cursor: { kind: 'complete' },
            last_status: 'complete',
            consecutive_errors: 0,
            last_run_tokens: 1_500,
          },
        }),
        taskStatus('prune', 'enrichment', {
          state: {
            task_id: 'prune',
            cursor: { kind: 'complete' },
            last_status: 'complete',
            consecutive_errors: 0,
          },
        }),
      ],
      kind: 'enrichment',
      now: NOW,
    });
    expect(html).toContain('<th>Cost</th>');
    expect(html).toContain('1.5k');
    expect(html).toContain('—');
  });

  it('⚠ D-250 § D — a MEASURED zero renders exactly, never rounded away', () => {
    // A provider call that cost nothing (a cached completion, a refusal) is a
    // real answer. `formatTokens` must not turn a small real value into "0k".
    const html = renderHousekeepingTaskStatusTable({
      tasks: [
        taskStatus('cheap', 'enrichment', {
          state: {
            task_id: 'cheap',
            cursor: { kind: 'complete' },
            last_status: 'complete',
            consecutive_errors: 0,
            last_run_tokens: 4,
          },
        }),
      ],
      kind: 'enrichment',
      now: NOW,
    });
    expect(html).toContain('>4<');
    expect(html).not.toContain('0k');
  });

  it('renders an empty hint when no tasks of the kind are registered', () => {
    const html = renderHousekeepingTaskStatusTable({
      tasks: [],
      kind: 'core',
      now: NOW,
    });
    expect(html).toContain('housekeeping-task-empty');
  });

  it('names repeated core Run now actions by task id', () => {
    const html = renderHousekeepingTaskStatusTable({
      tasks: [
        taskStatus('audit-compaction'),
        taskStatus('cache-eviction-beyond-ttl'),
      ],
      kind: 'core',
      now: NOW,
      showRunNow: true,
    });
    expect(html).toContain('aria-label="Run audit-compaction now"');
    expect(html).toContain(
      'aria-label="Run cache-eviction-beyond-ttl now"',
    );
  });
});
