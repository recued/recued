/** D-133 P5 — Drift banner render tests.
 *
 *  Pure-render coverage. Banner re-uses the D-132 P6 promotion-banner
 *  shell (shared `data-action="..."` host-dispatcher contract style)
 *  but emits its own action selectors:
 *
 *    - `housekeeping-drift-review`   — opens drawer + scrolls to Drift
 *    - `housekeeping-drift-dismiss`  — fires dismissal rpc
 *
 *  Visibility filter: banners render only for `severity != 'none'`
 *  AND `dismissed_at === undefined`. */

import { describe, expect, it } from 'vitest';
import {
  initialHousekeepingPanelState,
  renderHousekeepingDriftBanner,
  renderHousekeepingPanel,
  type HousekeepingPanelState,
} from '../server-settings/housekeeping/index.js';
import type { ConfidenceDriftSignal } from '@recued/contracts';

const NOW = 1_700_000_000_000;

const drift = (overrides: Partial<ConfidenceDriftSignal> = {}): ConfidenceDriftSignal => ({
  source_topic: 'purpose',
  psi: 0.31,
  severity: 'significant',
  baseline_window: { start_at: NOW - 5_000, end_at: NOW - 1_000, sample_count: 5832 },
  recent_window: { start_at: NOW - 1_000, end_at: NOW, sample_count: 1247 },
  baseline_distribution: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
  recent_distribution: [0.4, 0.3, 0.1, 0.05, 0.05, 0.05, 0.025, 0.025, 0, 0],
  computed_at: NOW,
  ...overrides,
});

describe('D-133 P5 — drift banner visibility filter', () => {
  it('returns empty string with no signals', () => {
    const html = renderHousekeepingDriftBanner({ signals: {}, writing: {}, writeError: {} });
    expect(html).toBe('');
  });

  it('omits the section element when only none-severity signals are present', () => {
    const html = renderHousekeepingDriftBanner({
      signals: { purpose: drift({ severity: 'none' }) },
      writing: {},
      writeError: {},
    });
    expect(html).toBe('');
  });

  it('omits a banner when its dismissed_at is set + severity unchanged', () => {
    const html = renderHousekeepingDriftBanner({
      signals: { purpose: drift({ dismissed_at: NOW - 1 }) },
      writing: {},
      writeError: {},
    });
    expect(html).toBe('');
  });

  it('renders when at least one signal is moderate or significant + not dismissed', () => {
    const html = renderHousekeepingDriftBanner({
      signals: { purpose: drift() },
      writing: {},
      writeError: {},
    });
    expect(html).toMatch(/housekeeping-drift-banner/);
  });
});

describe('D-133 P5 — drift banner content', () => {
  it('renders the source topic + PSI to two decimals', () => {
    const html = renderHousekeepingDriftBanner({
      signals: { purpose: drift({ psi: 0.314159 }) },
      writing: {},
      writeError: {},
    });
    expect(html).toMatch(/<code>purpose<\/code>/);
    expect(html).toMatch(/PSI=0\.31/);
  });

  it('renders different copy for moderate vs significant', () => {
    const moderate = renderHousekeepingDriftBanner({
      signals: { purpose: drift({ severity: 'moderate', psi: 0.18 }) },
      writing: {},
      writeError: {},
    });
    expect(moderate).toMatch(/has drifted moderately/);

    const significant = renderHousekeepingDriftBanner({
      signals: { purpose: drift({ severity: 'significant', psi: 0.31 }) },
      writing: {},
      writeError: {},
    });
    expect(significant).toMatch(/has drifted significantly/);
  });

  it('emits Review + Dismiss buttons with the locked data-action selectors', () => {
    const html = renderHousekeepingDriftBanner({
      signals: { purpose: drift() },
      writing: {},
      writeError: {},
    });
    expect(html).toMatch(/data-action="housekeeping-drift-review"[^>]*data-source-topic="purpose"/);
    expect(html).toMatch(/data-action="housekeeping-drift-dismiss"[^>]*data-source-topic="purpose"/);
  });

  it('disables both buttons while writing[topic] is true', () => {
    const html = renderHousekeepingDriftBanner({
      signals: { purpose: drift() },
      writing: { purpose: true },
      writeError: {},
    });
    expect(html).toMatch(/data-action="housekeeping-drift-review"[^>]*disabled/);
    expect(html).toMatch(/data-action="housekeeping-drift-dismiss"[^>]*disabled/);
  });

  it('renders an inline error block when writeError[topic] is set', () => {
    const html = renderHousekeepingDriftBanner({
      signals: { purpose: drift() },
      writing: {},
      writeError: { purpose: 'rpc dropped' },
    });
    expect(html).toMatch(/rpc dropped/);
  });

  it('multiple eligible signals render multiple banners', () => {
    const html = renderHousekeepingDriftBanner({
      signals: {
        purpose: drift({ source_topic: 'purpose' }),
        action_items: drift({ source_topic: 'action_items', severity: 'moderate', psi: 0.18 }),
      },
      writing: {},
      writeError: {},
    });
    // Each banner has its own data-source-topic="<topic>" attribute on
    // the banner root, so two unique attributes = two banners.
    const sourceTopics = (html.match(/data-source-topic="[^"]+"/g) ?? []).filter(
      (s, i, arr) => arr.indexOf(s) === i,
    );
    expect(sourceTopics).toHaveLength(2);
    expect(html).toMatch(/data-source-topic="purpose"/);
    expect(html).toMatch(/data-source-topic="action_items"/);
  });

  it('eligible-mixed-with-none filters out none signals', () => {
    const html = renderHousekeepingDriftBanner({
      signals: {
        purpose: drift({ severity: 'significant' }),
        summary: drift({ source_topic: 'summary', severity: 'none' }),
      },
      writing: {},
      writeError: {},
    });
    expect(html).toMatch(/data-source-topic="purpose"/);
    expect(html).not.toMatch(/data-source-topic="summary"/);
  });
});

describe('D-133 P5 — panel mounts the drift banner', () => {
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

  it('renders the drift banner above the preset picker when a signal is eligible', () => {
    const html = renderHousekeepingPanel({
      ...baseState({ driftSignals: { purpose: drift() } }),
      now: NOW,
    });
    expect(html).toMatch(/housekeeping-drift-banner/);
  });

  it('initialHousekeepingPanelState seeds drift state slots', () => {
    const s = initialHousekeepingPanelState();
    expect(s.driftSignals).toEqual({});
    expect(s.driftWriting).toEqual({});
    expect(s.driftWriteError).toEqual({});
  });
});
