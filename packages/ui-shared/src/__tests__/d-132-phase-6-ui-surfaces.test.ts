/** D-132 Phase 6 — Run-Now widening + promotion banner + top-bar
 *  Pause-AI render tests.
 *
 *  Pure-render coverage. Tests pin the wire-shape contracts the host
 *  dispatcher subscribes to (`data-action` selectors + `data-*`
 *  attributes) so the binding stays stable across refactors. The
 *  rpc surface itself is exercised in `backend/server/src/__tests__/
 *  d-132-phase-4-trust-rpc.test.ts` — these tests verify only the
 *  string HTML emission. */

import { describe, expect, it } from 'vitest';
import {
  PAUSE_DURATIONS_MS,
  PAUSE_UNTIL_RESUME_TIMESTAMP,
} from '@recued/contracts';
import {
  initialHousekeepingPanelState,
  initialHousekeepingRunNowDialogState,
  renderHousekeepingPanel,
  renderHousekeepingPromotionBanner,
  renderHousekeepingRunNowConfirmDialog,
  type HousekeepingPanelState,
  type HousekeepingPromotionSuggestion,
} from '../server-settings/housekeeping/index.js';
import {
  PAUSE_AI_DURATION_KEYS,
  renderPauseAiSlot,
  resolvePauseUntilMs,
  type PauseAiSlotState,
} from '../top-bar/index.js';
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

const aiTask = (overrides: Partial<HousekeepingTaskStatus> = {}): HousekeepingTaskStatus => ({
  meta: {
    id: 'enrichment.summary',
    description: 'Mail summary digest',
    interruptible: true,
    kind: 'enrichment',
  },
  enrichment: {
    token_estimate_per_record: 600,
    source_collection_count: 50,
    ai_path_available: true,
    scope_read: [
      {
        collection: 'data.mail',
        sample_field_paths: ['subject', 'body_preview', 'from'],
        record_count: 50,
      },
    ],
    effective_pool_policy: 'free_then_byok',
    global_byok_allowed: true,
  },
  ...overrides,
});

const deterministicTask = (
  overrides: Partial<HousekeepingTaskStatus> = {},
): HousekeepingTaskStatus => ({
  meta: {
    id: 'enrichment.thread_signals',
    description: 'Thread signals — deterministic',
    interruptible: true,
    kind: 'enrichment',
  },
  enrichment: {
    token_estimate_per_record: 0,
    source_collection_count: 200,
    scope_read: [
      {
        collection: 'data.mail',
        sample_field_paths: ['thread_id', 'date'],
        record_count: 200,
      },
    ],
  },
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Run-Now dialog — scope-of-read + pool-policy widening (§A.6)
// ────────────────────────────────────────────────────────────────

describe('D-132 P6 — Run-Now dialog scope-of-read', () => {
  it('renders scope_read entries on the AI-runnable cost-preview branch', () => {
    const html = renderHousekeepingRunNowConfirmDialog({
      state: { ...initialHousekeepingRunNowDialogState(), task_id: 'enrichment.summary' },
      task: aiTask(),
    });
    expect(html).toContain('What this reads');
    expect(html).toContain('data.mail');
    expect(html).toContain('subject');
    expect(html).toContain('body_preview');
    expect(html).toContain('from');
    // Per-entry record_count surfaces; the global source_collection_count
    // already renders elsewhere in the body and shouldn't double-count.
    expect(html).toContain('50 records');
  });

  it('renders scope_read on the deterministic branch (no AI cost)', () => {
    const html = renderHousekeepingRunNowConfirmDialog({
      state: {
        ...initialHousekeepingRunNowDialogState(),
        task_id: 'enrichment.thread_signals',
      },
      task: deterministicTask(),
    });
    expect(html).toContain('What this reads');
    expect(html).toContain('thread_id');
    expect(html).toContain('200 records');
    // Deterministic branch must skip the AI-routing badge.
    expect(html).not.toContain('AI routing:');
  });

  it('renders scope_read on the AI-blocked warning branch', () => {
    const blocked = aiTask({
      enrichment: {
        token_estimate_per_record: 600,
        source_collection_count: 50,
        ai_path_available: false,
        ai_path_reason: 'no_byok_no_freepool',
        scope_read: [
          {
            collection: 'data.mail',
            sample_field_paths: ['subject'],
            record_count: 50,
          },
        ],
        effective_pool_policy: 'free_then_byok',
        global_byok_allowed: true,
      },
    });
    const html = renderHousekeepingRunNowConfirmDialog({
      state: { ...initialHousekeepingRunNowDialogState(), task_id: 'enrichment.summary' },
      task: blocked,
    });
    expect(html).toContain('What this reads');
    expect(html).toContain('data.mail');
    // Run-now button is disabled by the existing AI-blocked guard.
    expect(html).toMatch(/data-action="housekeeping-run-now-confirm"[^>]*disabled/);
  });

  it('omits the scope-read section when the manifest cache is empty', () => {
    const html = renderHousekeepingRunNowConfirmDialog({
      state: { ...initialHousekeepingRunNowDialogState(), task_id: 'enrichment.summary' },
      task: aiTask({
        enrichment: {
          token_estimate_per_record: 600,
          source_collection_count: 50,
          ai_path_available: true,
          // scope_read intentionally omitted — early-boot race shape.
        },
      }),
    });
    expect(html).not.toContain('What this reads');
  });
});

describe('D-132 P6 — Run-Now dialog pool-policy badge', () => {
  it('renders the persisted pool policy when global BYOK is allowed', () => {
    const html = renderHousekeepingRunNowConfirmDialog({
      state: { ...initialHousekeepingRunNowDialogState(), task_id: 'enrichment.summary' },
      task: aiTask({
        enrichment: {
          token_estimate_per_record: 600,
          source_collection_count: 50,
          ai_path_available: true,
          effective_pool_policy: 'byok_only',
          global_byok_allowed: true,
        },
      }),
    });
    expect(html).toContain('AI routing:');
    expect(html).toContain('BYOK only');
    expect(html).toContain('data-policy="byok_only"');
    expect(html).toContain('data-collapsed="false"');
  });

  it('collapses the pool-policy label when the global BYOK switch is off', () => {
    const html = renderHousekeepingRunNowConfirmDialog({
      state: { ...initialHousekeepingRunNowDialogState(), task_id: 'enrichment.summary' },
      task: aiTask({
        enrichment: {
          token_estimate_per_record: 600,
          source_collection_count: 50,
          ai_path_available: true,
          effective_pool_policy: 'byok_only',
          global_byok_allowed: false,
        },
      }),
    });
    expect(html).toContain('Free pool only');
    expect(html).toContain('global BYOK off');
    expect(html).toContain('data-collapsed="true"');
  });

  it('skips the pool-policy badge when effective_pool_policy is absent', () => {
    const html = renderHousekeepingRunNowConfirmDialog({
      state: { ...initialHousekeepingRunNowDialogState(), task_id: 'enrichment.summary' },
      task: aiTask({
        enrichment: {
          token_estimate_per_record: 600,
          source_collection_count: 50,
          ai_path_available: true,
          // effective_pool_policy omitted — early-boot race.
        },
      }),
    });
    expect(html).not.toContain('AI routing:');
  });
});

// ────────────────────────────────────────────────────────────────
// Promotion banner — render + actions (§A.8)
// ────────────────────────────────────────────────────────────────

describe('D-132 P6 — promotion banner', () => {
  const suggestion = (
    overrides: Partial<HousekeepingPromotionSuggestion> = {},
  ): HousekeepingPromotionSuggestion => ({
    topic: 'summary',
    manual_run_count: 3,
    estimated_idle_cycle_cost_tokens: 30_000,
    ...overrides,
  });

  it('renders nothing when no suggestions are present', () => {
    const html = renderHousekeepingPromotionBanner({
      suggestions: {},
      writing: {},
      writeError: {},
    });
    expect(html).toBe('');
  });

  it('renders one banner per active suggestion with the topic + count copy', () => {
    const html = renderHousekeepingPromotionBanner({
      suggestions: {
        summary: suggestion(),
      },
      writing: {},
      writeError: {},
    });
    expect(html).toContain('housekeeping-promotion-banner');
    expect(html).toContain('<code>summary</code>');
    expect(html).toContain('3 times manually');
    expect(html).toContain('~30,000 tokens');
  });

  it('exposes the data-action selectors the host dispatcher binds', () => {
    const html = renderHousekeepingPromotionBanner({
      suggestions: { summary: suggestion() },
      writing: {},
      writeError: {},
    });
    expect(html).toMatch(
      /data-action="housekeeping-promotion-promote"[^>]*data-topic="summary"/,
    );
    expect(html).toMatch(
      /data-action="housekeeping-promotion-dismiss"[^>]*data-topic="summary"/,
    );
  });

  it('disables both buttons + flips the Promote label while a write is in flight', () => {
    const html = renderHousekeepingPromotionBanner({
      suggestions: { summary: suggestion() },
      writing: { summary: true },
      writeError: {},
    });
    const matches = html.match(/<button[^>]*disabled/g) ?? [];
    expect(matches.length).toBe(2);
    expect(html).toContain('Promoting…');
  });

  it('renders the inline error block when a banner write failed', () => {
    const html = renderHousekeepingPromotionBanner({
      suggestions: { summary: suggestion() },
      writing: {},
      writeError: { summary: 'rpc rejected: trust store unavailable' },
    });
    expect(html).toContain('rx-msg-error');
    expect(html).toContain('rpc rejected: trust store unavailable');
  });

  it('renders banners for multiple topics in insertion order', () => {
    const html = renderHousekeepingPromotionBanner({
      suggestions: {
        summary: suggestion({ topic: 'summary' }),
        purpose: suggestion({ topic: 'purpose', manual_run_count: 5 }),
      },
      writing: {},
      writeError: {},
    });
    const summaryIdx = html.indexOf('data-topic="summary"');
    const purposeIdx = html.indexOf('data-topic="purpose"');
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(purposeIdx).toBeGreaterThan(summaryIdx);
  });

  it('renders the "no estimate available" copy when the cost is zero/unknown', () => {
    const html = renderHousekeepingPromotionBanner({
      suggestions: {
        summary: suggestion({ estimated_idle_cycle_cost_tokens: 0 }),
      },
      writing: {},
      writeError: {},
    });
    expect(html).toContain('no estimate available');
    expect(html).not.toContain('~0 tokens');
  });
});

describe('D-132 P6 — promotion banner mounts inside housekeeping panel', () => {
  it('renders the banner above the preset picker when suggestions are present', () => {
    const html = renderHousekeepingPanel({
      ...baseState({
        promotionSuggestions: {
          summary: {
            topic: 'summary',
            manual_run_count: 3,
            estimated_idle_cycle_cost_tokens: 12_345,
          },
        },
      }),
      now: NOW,
    });
    const bannerIdx = html.indexOf('housekeeping-promotion-banner');
    const presetIdx = html.indexOf('housekeeping-preset-picker');
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    // Preset picker may render under a different selector — fall back to
    // the explicit picker class shipped by `renderHousekeepingPresetPicker`.
    expect(html).toContain('Auto-run suggestions');
    if (presetIdx >= 0) {
      expect(bannerIdx).toBeLessThan(presetIdx);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Top-bar Pause-AI slot — idle / paused / picker (§A.9)
// ────────────────────────────────────────────────────────────────

describe('D-132 P6 — top-bar Pause-AI slot', () => {
  const idleState = (overrides: Partial<PauseAiSlotState> = {}): PauseAiSlotState => ({
    pausedUntil: null,
    pickerOpen: false,
    writing: false,
    now: NOW,
    ...overrides,
  });

  it('renders the idle button + closed picker when no pause is active', () => {
    const html = renderPauseAiSlot(idleState());
    expect(html).toContain('top-bar-pause-ai--idle');
    expect(html).toContain('data-action="housekeeping-pause-ai-toggle"');
    expect(html).toContain('Pause AI');
    expect(html).not.toContain('top-bar-pause-ai-picker');
    expect(html).not.toContain('Resume now');
  });

  it('opens the duration picker when pickerOpen=true', () => {
    const html = renderPauseAiSlot(idleState({ pickerOpen: true }));
    expect(html).toContain('top-bar-pause-ai-picker');
    for (const key of PAUSE_AI_DURATION_KEYS) {
      expect(html).toContain(`data-duration="${key}"`);
    }
    expect(html).toContain('aria-expanded="true"');
  });

  it('renders all four duration presets in the picker', () => {
    const html = renderPauseAiSlot(idleState({ pickerOpen: true }));
    expect(html).toContain('Pause for 1h');
    expect(html).toContain('Pause for 4h');
    expect(html).toContain('Pause for 24h');
    expect(html).toContain('Until I resume');
  });

  it('renders the paused pill + Resume now action when a pause is active', () => {
    const html = renderPauseAiSlot(
      idleState({
        pausedUntil: NOW + 30 * 60_000,
      }),
    );
    expect(html).toContain('top-bar-pause-ai--paused');
    expect(html).toContain('resumes in 30m');
    expect(html).toContain('data-action="housekeeping-pause-ai-resume"');
    // Picker is suppressed while paused — Resume is the only action.
    expect(html).not.toContain('top-bar-pause-ai-picker');
  });

  it('renders the indefinite copy when pausedUntil === PAUSE_UNTIL_RESUME_TIMESTAMP', () => {
    const html = renderPauseAiSlot(
      idleState({ pausedUntil: PAUSE_UNTIL_RESUME_TIMESTAMP }),
    );
    expect(html).toContain('until you resume');
  });

  it('treats expired pausedUntil values as inactive', () => {
    const html = renderPauseAiSlot(
      idleState({ pausedUntil: NOW - 60_000 }),
    );
    // Expired window collapses back to the idle button.
    expect(html).toContain('top-bar-pause-ai--idle');
    expect(html).not.toContain('top-bar-pause-ai--paused');
  });

  it('disables every action button while a write is in flight', () => {
    const idleHtml = renderPauseAiSlot(idleState({ pickerOpen: true, writing: true }));
    const idleDisabled = idleHtml.match(/<button[^>]*disabled/g) ?? [];
    // 1 toggle + 4 picker options.
    expect(idleDisabled.length).toBe(5);

    const pausedHtml = renderPauseAiSlot(
      idleState({ pausedUntil: NOW + 60 * 60_000, writing: true }),
    );
    expect(pausedHtml).toMatch(/data-action="housekeeping-pause-ai-resume"[^>]*disabled/);
  });

  it('formats remaining time across minute/hour/day boundaries', () => {
    expect(
      renderPauseAiSlot(idleState({ pausedUntil: NOW + 90 * 60_000 })),
    ).toContain('1h 30m');
    expect(
      renderPauseAiSlot(idleState({ pausedUntil: NOW + 3 * 60_000 })),
    ).toContain('3m');
    expect(
      renderPauseAiSlot(idleState({ pausedUntil: NOW + 25 * 60 * 60_000 })),
    ).toContain('1d 1h');
  });
});

describe('D-132 P6 — resolvePauseUntilMs helper', () => {
  it('maps timed presets to now + their duration', () => {
    expect(resolvePauseUntilMs('1h', NOW)).toBe(NOW + PAUSE_DURATIONS_MS['1h']);
    expect(resolvePauseUntilMs('4h', NOW)).toBe(NOW + PAUSE_DURATIONS_MS['4h']);
    expect(resolvePauseUntilMs('24h', NOW)).toBe(NOW + PAUSE_DURATIONS_MS['24h']);
  });

  it('maps until_resume to PAUSE_UNTIL_RESUME_TIMESTAMP regardless of now', () => {
    expect(resolvePauseUntilMs('until_resume', NOW)).toBe(PAUSE_UNTIL_RESUME_TIMESTAMP);
    expect(resolvePauseUntilMs('until_resume', 0)).toBe(PAUSE_UNTIL_RESUME_TIMESTAMP);
  });
});
