/** D-133 P4 — Drift section in the detail drawer.
 *
 *  Pure-render coverage. Verifies the Drift section renders only when
 *  `driftSignal` is present, the severity badge carries the right
 *  data attribute, and the window summary lines reflect the
 *  persisted shape. */

import { describe, expect, it } from 'vitest';
import {
  initialHousekeepingPanelState,
  renderHousekeepingDetailDrawer,
  renderHousekeepingEnrichmentProducerSection,
  type HousekeepingPanelState,
} from '../server-settings/housekeeping/index.js';
import type {
  ConfidenceDriftSignal,
  HousekeepingTaskStatus,
} from '@recued/contracts';

const NOW = 1_700_000_000_000;

const purposeTask = (): HousekeepingTaskStatus => ({
  meta: {
    id: 'enrichment.purpose',
    description: 'Mail purpose classifier',
    interruptible: true,
    kind: 'enrichment',
  },
  enrichment: {
    token_estimate_per_record: 600,
    source_collection_count: 50,
  },
});

const drift = (overrides: Partial<ConfidenceDriftSignal> = {}): ConfidenceDriftSignal => ({
  source_topic: 'purpose',
  psi: 0.31,
  severity: 'significant',
  baseline_window: { start_at: 1_690_000_000_000, end_at: 1_692_592_000_000, sample_count: 5832 },
  recent_window: { start_at: 1_699_395_200_000, end_at: NOW, sample_count: 1247 },
  baseline_distribution: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
  recent_distribution: [0.4, 0.3, 0.1, 0.05, 0.05, 0.05, 0.025, 0.025, 0, 0],
  computed_at: NOW,
  ...overrides,
});

const drawerProps = (overrides: Partial<Parameters<typeof renderHousekeepingDetailDrawer>[0]> = {}) => ({
  task: purposeTask(),
  scopeRead: [],
  trustRow: null,
  isAiSurface: true,
  recentRuns: [],
  errorHistory: [],
  hasConfidenceField: true,
  writing: false,
  writeError: null,
  now: NOW,
  ...overrides,
});

describe('D-133 P4 — drawer drift section visibility', () => {
  it('renders no drift section when driftSignal is undefined', () => {
    const html = renderHousekeepingDetailDrawer(drawerProps());
    expect(html).not.toMatch(/housekeeping-drawer-drift-section/);
  });

  it('renders no drift section when driftSignal is null', () => {
    const html = renderHousekeepingDetailDrawer(drawerProps({ driftSignal: null }));
    expect(html).not.toMatch(/housekeeping-drawer-drift-section/);
  });

  it('renders the drift section when driftSignal is present', () => {
    const html = renderHousekeepingDetailDrawer(drawerProps({ driftSignal: drift() }));
    expect(html).toMatch(/housekeeping-drawer-drift-section/);
    expect(html).toMatch(/<h4>Drift<\/h4>/);
  });

  it('renders the drift section even when hasConfidenceField is false (drift is independent)', () => {
    const html = renderHousekeepingDetailDrawer(
      drawerProps({ driftSignal: drift(), hasConfidenceField: false }),
    );
    expect(html).toMatch(/housekeeping-drawer-drift-section/);
  });
});

describe('D-133 P4 — drift section content', () => {
  it('renders PSI to three decimals', () => {
    const html = renderHousekeepingDetailDrawer(
      drawerProps({ driftSignal: drift({ psi: 0.314159 }) }),
    );
    expect(html).toMatch(/PSI=0\.314/);
  });

  it('severity badge carries data-severity attribute (significant)', () => {
    const html = renderHousekeepingDetailDrawer(
      drawerProps({ driftSignal: drift({ severity: 'significant' }) }),
    );
    expect(html).toMatch(/data-severity="significant"/);
    expect(html).toMatch(/Significant/);
  });

  it('severity badge carries data-severity attribute (moderate)', () => {
    const html = renderHousekeepingDetailDrawer(
      drawerProps({ driftSignal: drift({ severity: 'moderate', psi: 0.18 }) }),
    );
    expect(html).toMatch(/data-severity="moderate"/);
    expect(html).toMatch(/Moderate/);
    expect(html).toMatch(/PSI=0\.180/);
  });

  it('drift section carries data-source-topic attribute', () => {
    const html = renderHousekeepingDetailDrawer(
      drawerProps({ driftSignal: drift({ source_topic: 'purpose' }) }),
    );
    expect(html).toMatch(/data-source-topic="purpose"/);
  });

  it('window dl renders both Recent and Baseline lines with sample counts', () => {
    const html = renderHousekeepingDetailDrawer(
      drawerProps({
        driftSignal: drift({
          recent_window: { start_at: 1_699_395_200_000, end_at: NOW, sample_count: 1247 },
          baseline_window: { start_at: 1_690_000_000_000, end_at: 1_692_592_000_000, sample_count: 5832 },
        }),
      }),
    );
    expect(html).toMatch(/Recent/);
    expect(html).toMatch(/Baseline/);
    expect(html).toMatch(/1247 samples/);
    expect(html).toMatch(/5832 samples/);
  });
});

describe('D-133 P4 — enrichment-producer section threads driftSignals', () => {
  const baseState = (overrides?: Partial<HousekeepingPanelState>): HousekeepingPanelState => ({
    ...initialHousekeepingPanelState(),
    ...(overrides ?? {}),
  });

  it('passes driftSignals[topic] through to the drawer', () => {
    const state = baseState({
      expandedTopic: 'purpose',
      driftSignals: { purpose: drift() },
    });
    const html = renderHousekeepingEnrichmentProducerSection({
      tasks: [purposeTask()],
      expandedTopic: state.expandedTopic,
      trustRows: state.trustRows,
      recentRuns: state.recentRuns,
      errorHistory: state.errorHistory,
      hasConfidenceField: { purpose: true },
      trustWriting: state.trustWriting,
      trustWriteError: state.trustWriteError,
      scopeRead: state.scopeRead,
      driftSignals: state.driftSignals,
      // Coverage slot defaults empty here; this test pins the D-133
      // driftSignals threading. R25 filter props default to no-filter.
      coverageEntries: state.coverageEntries,
      search: '',
      costFilter: 'all',
      now: NOW,
    });
    expect(html).toMatch(/housekeeping-drawer-drift-section/);
    expect(html).toMatch(/PSI=0\.310/);
  });

  it('drawer omits the drift section when driftSignals[topic] is absent', () => {
    const state = baseState({ expandedTopic: 'purpose' });
    const html = renderHousekeepingEnrichmentProducerSection({
      tasks: [purposeTask()],
      expandedTopic: state.expandedTopic,
      trustRows: state.trustRows,
      recentRuns: state.recentRuns,
      errorHistory: state.errorHistory,
      hasConfidenceField: { purpose: true },
      trustWriting: state.trustWriting,
      trustWriteError: state.trustWriteError,
      scopeRead: state.scopeRead,
      driftSignals: state.driftSignals,
      // Coverage slot defaults empty here; this test pins the D-133
      // driftSignals threading. R25 filter props default to no-filter.
      coverageEntries: state.coverageEntries,
      search: '',
      costFilter: 'all',
      now: NOW,
    });
    expect(html).not.toMatch(/housekeeping-drawer-drift-section/);
  });
});

describe('D-133 P4 — initialHousekeepingPanelState seeds driftSignals', () => {
  it('exposes empty driftSignals on the initial state', () => {
    expect(initialHousekeepingPanelState().driftSignals).toEqual({});
  });
});
