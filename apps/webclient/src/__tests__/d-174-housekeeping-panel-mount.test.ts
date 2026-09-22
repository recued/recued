/** D-132/D-133 — `mountHousekeepingPanel` (trust-core slice) tests.
 *
 *  Drives the mount through its documented user actions via the
 *  string-innerHTML fake-host pattern (same as
 *  `d-145-pa11-llm-result-cache-card-mount.test.ts`), extended with a
 *  `change` synthesizer for the radios / number inputs.
 *
 *  Covers: initial load fires config + status + trust reads and paints
 *  the panel; a trust-radio pick writes through `housekeeping.trust.write`
 *  and patches the row; a preset pick + Save writes config; Run-now opens
 *  + confirms through `housekeeping.task.run_now`; a `housekeeping_cycle`
 *  broadcast reloads status; `dispose()` removes listeners + is
 *  idempotent. */

import { describe, expect, it, vi } from 'vitest';

import {
  HOUSEKEEPING_PANEL_STYLES,
  mountHousekeepingPanel,
} from '../settings/housekeeping-panel-mount.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import type {
  ConfidenceDriftSignal,
  EnrichmentTrustRow,
  EnrichmentTrustState,
  HousekeepingConfigRow,
  HousekeepingTaskStatus,
  RegistryDescribeTopicEntry,
} from '@recued/contracts';

const NOW = 1_700_000_000_000;

const makeConfig = (
  preset: HousekeepingConfigRow['preset'] = 'balanced',
): HousekeepingConfigRow => ({
  preset,
  cycle_budget_ms: 60_000,
  cycle_interval_minutes: 15,
  allow_byok_background: false,
  pause_background_ai_until: null,
  updated_at: NOW,
});

const aiTask = (): HousekeepingTaskStatus => ({
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
      { collection: 'data.mail', sample_field_paths: ['subject'], record_count: 50 },
    ],
    effective_pool_policy: 'free_then_byok',
    global_byok_allowed: true,
  },
});

const trustRow = (
  trust_state: EnrichmentTrustState = 'auto',
): EnrichmentTrustRow => ({
  topic: 'summary',
  trust_state,
  pool_policy: 'free_then_byok',
  manual_run_count: 0,
  promotion_suggested_at: null,
  promotion_dismissed_at: null,
  updated_at: NOW,
});

const coverageEntry = (): RegistryDescribeTopicEntry => ({
  topic: 'summary',
  temporal_class: 'stable_truth',
  identity_aggregation: 'scenario',
  lifecycle_policy: 'forward_only',
  valid_scopes: ['mail'],
  compression_class: 'lossy',
  prompt_bias_hints: [],
  description: 'Mail summary digest',
  ai_surface: true,
  mcp_exposed: 'public',
  coverage: {
    row_count: 50,
    latest_event_at: NOW,
    producer_last_run_at: NOW,
    producer_failure_rate_24h: 0,
    ai_surface: true,
  },
  coverage_quality: 'high',
  coverage_quality_reasoning: '50 rows, fresh',
});

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

// ── Fake host (mirror of the cache-card mount test, + change synth) ──
const makeFakeHost = () => {
  let html = '';
  const attrs = new Map<string, string>();
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    setAttribute: (k: string, v: string): void => {
      attrs.set(k, v);
    },
    removeAttribute: (k: string): void => {
      attrs.delete(k);
    },
    getAttribute: (k: string): string | null => attrs.get(k) ?? null,
    addEventListener: (evt: string, fn: (event: Event) => void): void => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt: string, fn: (event: Event) => void): void => {
      listeners[evt]?.delete(fn);
    },
  } as unknown as HTMLElement;
  const fire = (evt: string, target: unknown): void => {
    for (const fn of [...(listeners[evt] ?? [])]) {
      fn({ target, type: evt, preventDefault: () => {} } as unknown as Event);
    }
  };
  const topicHolder = (topic?: string) => ({
    getAttribute: (n: string) => (n === 'data-topic' ? topic ?? null : null),
  });
  return {
    host,
    getHtml: () => html,
    listenerCount: () =>
      Object.values(listeners).reduce((n, s) => n + s.size, 0),
    clickAction: (action: string, opts?: { taskId?: string; topic?: string }): void => {
      const actionEl = {
        getAttribute: (n: string) =>
          n === 'data-action'
            ? action
            : n === 'data-task-id'
              ? opts?.taskId ?? null
              : n === 'data-topic'
                ? opts?.topic ?? null
                : null,
        closest: (s: string) =>
          s === '[data-topic]' && opts?.topic ? topicHolder(opts.topic) : null,
      };
      fire('click', {
        closest: (s: string) => (s === '[data-action]' ? actionEl : null),
      });
    },
    changeAction: (
      action: string,
      opts?: { value?: string; topic?: string; checked?: boolean },
    ): void => {
      fire('change', {
        value: opts?.value ?? '',
        checked: opts?.checked ?? false,
        getAttribute: (n: string) =>
          n === 'data-action'
            ? action
            : n === 'data-topic'
              ? opts?.topic ?? null
              : null,
        closest: (s: string) =>
          s === '[data-topic]' && opts?.topic ? topicHolder(opts.topic) : null,
      });
    },
    // Click variant carrying a `data-source-topic` (drift banner) or
    // `data-topic` (promotion banner / reset open) directly on the
    // action element — no ancestor lookup.
    clickActionAttrs: (
      action: string,
      attrs: Record<string, string>,
    ): void => {
      fire('click', {
        closest: (s: string) =>
          s === '[data-action]'
            ? {
                getAttribute: (n: string) =>
                  n === 'data-action' ? action : (attrs[n] ?? null),
                closest: () => null,
              }
            : null,
      });
    },
  };
};

const resetResult = (
  applied: boolean,
  overrides?: Partial<{ confirmation_token: string | null; reset_psi_baselines: boolean }>,
) => ({
  applied,
  confirmation_token: applied ? null : (overrides?.confirmation_token ?? 'tok-1'),
  expires_at: applied ? null : NOW + 300_000,
  topic: 'summary',
  scope_filter: null as null,
  reset_psi_baselines: overrides?.reset_psi_baselines ?? true,
  impact: {
    rows_to_tombstone: 12,
    pinned_protected: 1,
    psi_baselines_to_drop: 1,
    estimated_recompute_tokens: 3000,
  },
  applied_summary: {
    rows_tombstoned: applied ? 12 : 0,
    rows_recompute_enqueued: applied ? 12 : 0,
    psi_baselines_dropped: applied ? 1 : 0,
    pinned_skipped: applied ? 1 : 0,
  },
});

const makeDeps = () => {
  const handlers: Record<string, (event?: unknown) => void> = {};
  const runConfigRead = vi.fn(() => Promise.resolve(makeConfig()));
  const runConfigWrite = vi.fn(() =>
    Promise.resolve({ ok: true as const, effective: makeConfig('light') }),
  );
  const runStatusRead = vi.fn(() => Promise.resolve({ tasks: [aiTask()] }));
  const runTrustRead = vi.fn(() => Promise.resolve({ rows: [] as EnrichmentTrustRow[] }));
  const runRunNow = vi.fn(() =>
    Promise.resolve({ ok: true as const, cycle_result: {} }),
  );
  const runTrustWrite = vi.fn(() =>
    Promise.resolve({ ok: true as const, effective: trustRow('auto') }),
  );
  const runDismissPromotion = vi.fn(() =>
    Promise.resolve({ ok: true as const, effective: trustRow('manual') }),
  );
  const runRegistryDescribe = vi.fn(() =>
    Promise.resolve({
      topics: [coverageEntry()],
      total_rows_visible: 50,
    }),
  );
  const runTopicReset = vi.fn(() => Promise.resolve(resetResult(false)));
  // D-285 — every mount now pulls the persisted drift signals. Empty by
  // default so the existing cases exercise the addition without changing.
  const runDriftRead = vi.fn(() =>
    Promise.resolve({ rows: [] as ConfidenceDriftSignal[] }),
  );
  const subscribe = vi.fn((kind: string, handler: (event?: unknown) => void) => {
    handlers[kind] = handler;
    return () => {
      delete handlers[kind];
    };
  }) as unknown as BroadcastSubscriber['on'];
  return {
    runConfigRead,
    runConfigWrite,
    runStatusRead,
    runTrustRead,
    runRunNow,
    runTrustWrite,
    runDismissPromotion,
    runRegistryDescribe,
    runTopicReset,
    runDriftRead,
    subscribe,
    fireCycle: () => handlers.housekeeping_cycle?.({}),
    fire: (kind: string, payload: unknown) => handlers[kind]?.(payload),
  };
};

describe('mountHousekeepingPanel — trust-core slice', () => {
  it('floors the run-policy control so its three labels cannot close up', () => {
    // The control lives in a grid cell whose track is `minmax(0, 1fr)` and
    // whose `td` sets `min-width: 0` — both of which exist to let a child
    // shrink past its own min-content. Without an explicit floor the
    // segmented control compresses and Off/Manual/Auto read as one word.
    expect(HOUSEKEEPING_PANEL_STYLES).toMatch(
      /\.housekeeping-producer-runpolicy\s*\{[^}]*min-width:\s*144px/s,
    );
    // The structural half: a floor stops the control shrinking, nowrap
    // stops a label breaking onto a second line inside whatever width it
    // does get.
    expect(HOUSEKEEPING_PANEL_STYLES).toMatch(
      /\.housekeeping-producer-runpolicy-seg span\s*\{[^}]*white-space:\s*nowrap/s,
    );
  });

  it('floors Last run to its own widest value, and never wraps it', () => {
    // The column renders relative time, so the ceiling is `999d ago`
    // (measured 70.5px in Chrome incl. cell padding). 80px is that plus
    // headroom for a wider default font off macOS — NOT room for an
    // absolute stamp, which this column deliberately does not show.
    expect(HOUSEKEEPING_PANEL_STYLES).toMatch(
      /\.housekeeping-producer-last-run\s*\{[^}]*min-width:\s*80px/s,
    );
    expect(HOUSEKEEPING_PANEL_STYLES).toMatch(
      /\.housekeeping-producer-last-run\s*\{[^}]*white-space:\s*nowrap/s,
    );
  });

  it('gives producer and drawer controls full targets with mobile cards', () => {
    expect(HOUSEKEEPING_PANEL_STYLES).toMatch(
      /\.housekeeping-producer-cost-segment\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(HOUSEKEEPING_PANEL_STYLES).toMatch(
      /\.housekeeping-producer-runpolicy-seg\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(HOUSEKEEPING_PANEL_STYLES).toContain(
      '.housekeeping-drawer-toggle-button { box-sizing: border-box; '
      + 'min-width: 36px; min-height: 36px; }',
    );
    expect(HOUSEKEEPING_PANEL_STYLES).toMatch(
      /\.housekeeping-drawer-radio\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(HOUSEKEEPING_PANEL_STYLES).toMatch(
      /\.housekeeping-reset-psi-toggle\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(HOUSEKEEPING_PANEL_STYLES).toContain(
      '@media (max-width: 720px)',
    );
    expect(HOUSEKEEPING_PANEL_STYLES).toMatch(
      /\.housekeeping-producer-table \.housekeeping-producer-row\s*\{[^}]*display:\s*grid/s,
    );
  });

  it('fires config + status + trust reads on mount and paints the panel', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    expect(fakeHost.getHtml()).toContain('<h2>Housekeeping</h2>');
    expect(fakeHost.getHtml()).toContain('Loading housekeeping…');
    await mount.whenLoaded();
    expect(deps.runConfigRead).toHaveBeenCalledTimes(1);
    expect(deps.runStatusRead).toHaveBeenCalledTimes(1);
    expect(deps.runTrustRead).toHaveBeenCalledTimes(1);
    const html = fakeHost.getHtml();
    expect(html).toContain('Housekeeping');
    expect(html).toContain('housekeeping-preset-picker');
    expect(html).toContain('enrichment.summary');
    // No banners until a broadcast lands (Commit 2 surfaces are
    // broadcast-fed, not present on a cold load).
    expect(html).not.toContain('housekeeping-promotion-banner');
    expect(html).not.toContain('housekeeping-drift-banner');
    // The reset modal is closed (no open click yet).
    expect(html).not.toContain('housekeeping-reset-modal');
    mount.dispose();
  });

  it('keeps the Housekeeping heading when the initial read fails', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    deps.runConfigRead.mockRejectedValueOnce(new Error('config read failed'));
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    expect(fakeHost.getHtml()).toContain('<h2>Housekeeping</h2>');
    expect(fakeHost.getHtml()).toContain('config read failed');
    mount.dispose();
  });

  it('writes a trust-state pick through housekeeping.trust.write', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    fakeHost.changeAction('housekeeping-trust-state-pick', {
      value: 'auto',
      topic: 'summary',
    });
    await flush();
    expect(deps.runTrustWrite).toHaveBeenCalledWith({
      topic: 'summary',
      trust_state: 'auto',
    });
    expect(mount.getState().trustRows.summary?.trust_state).toBe('auto');
    mount.dispose();
  });

  it('writes a pool-policy pick through housekeeping.trust.write', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    fakeHost.changeAction('housekeeping-pool-policy-pick', {
      value: 'byok_only',
      topic: 'summary',
    });
    await flush();
    expect(deps.runTrustWrite).toHaveBeenCalledWith({
      topic: 'summary',
      pool_policy: 'byok_only',
    });
    mount.dispose();
  });

  it('saves a preset change through housekeeping.config.write', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    fakeHost.changeAction('housekeeping-preset-pick', { value: 'light' });
    expect(mount.getState().draftPreset).toBe('light');
    fakeHost.clickAction('housekeeping-save');
    await flush();
    expect(deps.runConfigWrite).toHaveBeenCalledWith({ preset: 'light' });
    expect(mount.getState().config?.preset).toBe('light');
    expect(mount.getState().draftPreset).toBeNull();
    mount.dispose();
  });

  it('opens + confirms Run-now through housekeeping.task.run_now', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    // Regression guard (codex P1): the Run-now button must render the
    // kebab `data-task-id` the mount reads — a camelCase `taskId` data
    // key renders `data-taskid` and the open click becomes a dead no-op.
    expect(fakeHost.getHtml()).toMatch(
      /data-action="housekeeping-run-now-open"[^>]*data-task-id="enrichment\.summary"/,
    );
    fakeHost.clickAction('housekeeping-run-now-open', { taskId: 'enrichment.summary' });
    expect(mount.getState().runNow.task_id).toBe('enrichment.summary');
    expect(fakeHost.getHtml()).toContain(
      'aria-labelledby="housekeeping-runnow-enrichment.summary-title"',
    );
    fakeHost.clickAction('housekeeping-run-now-confirm');
    await flush();
    expect(deps.runRunNow).toHaveBeenCalledWith({ task_id: 'enrichment.summary' });
    // status re-read after the run (mount load + post-run refresh).
    expect(deps.runStatusRead.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mount.getState().runNow.task_id).toBeNull();
    mount.dispose();
  });

  it('reloads status on a housekeeping_cycle broadcast', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    expect(deps.runStatusRead).toHaveBeenCalledTimes(1);
    deps.fireCycle();
    await flush();
    expect(deps.runStatusRead).toHaveBeenCalledTimes(2);
    // a cycle reload re-reads status only, not config/trust.
    expect(deps.runConfigRead).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('a housekeeping_cycle mid-initial-load does not abort the full load', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    let resolveConfig!: (c: HousekeepingConfigRow) => void;
    deps.runConfigRead.mockImplementation(
      () =>
        new Promise<HousekeepingConfigRow>((r) => {
          resolveConfig = r;
        }),
    );
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    // A cycle arrives before the (hung) full load resolves — its
    // status-only refresh must not invalidate the in-flight full load
    // (separate generation counters).
    deps.fireCycle();
    await flush();
    resolveConfig(makeConfig());
    // `whenLoaded()` now tracks the cycle's status-refresh (it overwrote
    // pendingLoad), so drain microtasks to let the full load's
    // continuation settle instead.
    await flush();
    expect(mount.getState().config?.preset).toBe('balanced');
    mount.dispose();
  });

  // ── Commit 2 — promotion banner ───────────────────────────────────
  it('renders a promotion banner on enrichment_promotion_suggested + promotes via trust.write', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    deps.fire('enrichment_promotion_suggested', {
      kind: 'enrichment_promotion_suggested',
      topic: 'summary',
      manual_run_count: 3,
      estimated_idle_cycle_cost_tokens: 1200,
      cursor: 1,
    });
    await flush();
    expect(fakeHost.getHtml()).toContain('housekeeping-promotion-banner');
    expect(mount.getState().promotionSuggestions.summary?.manual_run_count).toBe(3);
    // Promote → trust.write auto, suggestion drains, trust row patched.
    fakeHost.clickActionAttrs('housekeeping-promotion-promote', { 'data-topic': 'summary' });
    await flush();
    expect(deps.runTrustWrite).toHaveBeenCalledWith({ topic: 'summary', trust_state: 'auto' });
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    expect(mount.getState().trustRows.summary?.trust_state).toBe('auto');
    mount.dispose();
  });

  it('dismisses a promotion banner via trust.dismiss_promotion', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    deps.fire('enrichment_promotion_suggested', {
      kind: 'enrichment_promotion_suggested',
      topic: 'summary',
      manual_run_count: 3,
      estimated_idle_cycle_cost_tokens: 1200,
      cursor: 1,
    });
    await flush();
    fakeHost.clickActionAttrs('housekeeping-promotion-dismiss', { 'data-topic': 'summary' });
    await flush();
    expect(deps.runDismissPromotion).toHaveBeenCalledWith({ topic: 'summary' });
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    mount.dispose();
  });

  // ── Commit 2 — drift banner ───────────────────────────────────────
  it('renders a drift banner on enrichment_drift_detected; review expands, dismiss collapses', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    deps.fire('enrichment_drift_detected', {
      kind: 'enrichment_drift_detected',
      source_topic: 'summary',
      psi: 0.31,
      severity: 'significant',
      computed_at: NOW,
      cursor: 2,
    });
    await flush();
    expect(fakeHost.getHtml()).toContain('housekeeping-drift-banner');
    // Review expands the producer drawer for the source topic.
    fakeHost.clickActionAttrs('housekeeping-drift-review', { 'data-source-topic': 'summary' });
    expect(mount.getState().expandedTopic).toBe('summary');
    // Dismiss stamps dismissed_at → banner collapses (client-side).
    fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
    expect(mount.getState().driftSignals.summary?.dismissed_at).toBe(NOW);
    expect(fakeHost.getHtml()).not.toContain('housekeeping-drift-banner');
    mount.dispose();
  });

  // ── R25 — coverage load (the MCP-visibility toggle was removed) ────
  it('loads coverage on mount into the expanded drawer, no MCP toggle', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    await flush(); // non-fatal meta load settles after the main load
    expect(deps.runRegistryDescribe).toHaveBeenCalledTimes(1);
    expect(mount.getState().coverageEntries.summary?.coverage_quality).toBe('high');
    // Expand the drawer: the coverage panel renders, and R25 replaced the
    // per-topic MCP-visibility checkbox with a per-contract read-access
    // cross-link.
    fakeHost.clickAction('housekeeping-drawer-toggle', { topic: 'summary' });
    const html = fakeHost.getHtml();
    expect(html).toContain('housekeeping-drawer-coverage-section');
    expect(html).toContain('housekeeping-drawer-read-access');
    expect(html).not.toContain('housekeeping-mcp-visibility-toggle');
    mount.dispose();
  });

  it('keeps the panel alive when the coverage meta load fails', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    deps.runRegistryDescribe.mockRejectedValueOnce(new Error('boom'));
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    await flush();
    // Main panel still painted; coverage just stays empty (no page error).
    expect(fakeHost.getHtml()).toContain('housekeeping-preset-picker');
    expect(mount.getState().error).toBeNull();
    expect(mount.getState().coverageEntries.summary).toBeUndefined();
    mount.dispose();
  });

  // ── Commit 2 — destructive topic-reset ────────────────────────────
  it('runs the topic-reset dry-run → confirm flow', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    deps.runTopicReset
      .mockImplementationOnce(() => Promise.resolve(resetResult(false)))
      .mockImplementationOnce(() => Promise.resolve(resetResult(true)));
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    // Open → dry-run (no token) → preview.
    fakeHost.clickActionAttrs('housekeeping-reset-open', { 'data-topic': 'summary' });
    await flush();
    expect(deps.runTopicReset).toHaveBeenNthCalledWith(1, { topic: 'summary' });
    expect(mount.getState().reset.phase).toBe('preview');
    expect(mount.getState().reset.confirmation_token).toBe('tok-1');
    expect(fakeHost.getHtml()).toContain('housekeeping-reset-modal');
    // Confirm → applies with the minted token + resolved psi flag.
    fakeHost.clickAction('housekeeping-reset-confirm');
    await flush();
    expect(deps.runTopicReset).toHaveBeenNthCalledWith(2, {
      topic: 'summary',
      confirmation_token: 'tok-1',
      reset_psi_baselines: true,
    });
    expect(mount.getState().reset.phase).toBe('applied');
    expect(mount.getState().reset.appliedSummary?.rows_tombstoned).toBe(12);
    // Done closes the modal.
    fakeHost.clickAction('housekeeping-reset-done');
    expect(mount.getState().reset.topic).toBeNull();
    expect(fakeHost.getHtml()).not.toContain('housekeeping-reset-modal');
    mount.dispose();
  });

  it('re-mints the reset token when the PSI checkbox is toggled', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    fakeHost.clickActionAttrs('housekeeping-reset-open', { 'data-topic': 'summary' });
    await flush();
    deps.runTopicReset.mockClear();
    // Toggling PSI off re-fires the dry-run with reset_psi_baselines:false.
    fakeHost.changeAction('housekeeping-reset-toggle-psi', { topic: 'summary', checked: false });
    await flush();
    expect(deps.runTopicReset).toHaveBeenCalledWith({ topic: 'summary', reset_psi_baselines: false });
    mount.dispose();
  });

  it('surfaces a reset dry-run error and retries', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    deps.runTopicReset
      .mockRejectedValueOnce(new Error('preview failed'))
      .mockImplementationOnce(() => Promise.resolve(resetResult(false)));
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    fakeHost.clickActionAttrs('housekeeping-reset-open', { 'data-topic': 'summary' });
    await flush();
    expect(mount.getState().reset.phase).toBe('error');
    expect(mount.getState().reset.error).toBe('preview failed');
    // Retry re-fires the dry-run → back to preview.
    fakeHost.clickAction('housekeeping-reset-retry');
    await flush();
    expect(mount.getState().reset.phase).toBe('preview');
    expect(mount.getState().reset.confirmation_token).toBe('tok-1');
    mount.dispose();
  });

  it('cancel closes the reset modal', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    fakeHost.clickActionAttrs('housekeeping-reset-open', { 'data-topic': 'summary' });
    await flush();
    expect(mount.getState().reset.phase).toBe('preview');
    fakeHost.clickAction('housekeeping-reset-cancel');
    expect(mount.getState().reset.topic).toBeNull();
    expect(fakeHost.getHtml()).not.toContain('housekeeping-reset-modal');
    mount.dispose();
  });

  it('omits the reset drawer section when runTopicReset is not wired', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const { runTopicReset: _omit, ...depsNoReset } = deps;
    const mount = mountHousekeepingPanel({
      host: fakeHost.host,
      now: () => NOW,
      ...depsNoReset,
    });
    await mount.whenLoaded();
    // Expand the drawer; without runTopicReset the reset section is gated off.
    fakeHost.clickAction('housekeeping-drawer-toggle', { topic: 'summary' });
    expect(fakeHost.getHtml()).not.toContain('housekeeping-drawer-reset-section');
    // Opening reset is a no-op (no dead button path).
    fakeHost.clickActionAttrs('housekeeping-reset-open', { 'data-topic': 'summary' });
    await flush();
    expect(mount.getState().reset.topic).toBeNull();
    mount.dispose();
  });

  it('dispose() removes listeners + the subscription and is idempotent', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    expect(fakeHost.listenerCount()).toBeGreaterThan(0);
    mount.dispose();
    expect(fakeHost.listenerCount()).toBe(0);
    expect(fakeHost.getHtml()).toBe('');
    expect(() => mount.dispose()).not.toThrow();
  });
});

// ── D-285 — the persisted drift read ────────────────────────────────
//
// ⛔ WHAT THESE GUARD, MEASURED NOT ASSUMED. On a live paired browser, twice:
// the banner rendered when the producer fired with the panel open (control)
// and was GONE after a reload in the SAME tab seconds later — `cursor_since`
// intact in sessionStorage, the row still stored, the task's own last-run
// cell reading "5s ago". Drift was visible only to whoever happened to be
// looking at that second. The first case below is that reload: a fresh mount
// with a stored signal and NO broadcast ever fired.

/** What the rpc returns — the stored row, bins and all. The broadcast cannot
 *  carry these; `driftSignalFromEvent` fills them with `[]` and says so. */
const storedSignal = (over: Partial<ConfidenceDriftSignal> = {}): ConfidenceDriftSignal => ({
  source_topic: 'summary',
  psi: 0.31,
  severity: 'significant',
  baseline_window: { start_at: 1_000, end_at: 2_000, sample_count: 300 },
  recent_window: { start_at: 3_000, end_at: 4_000, sample_count: 100 },
  baseline_distribution: [0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0],
  recent_distribution: [0.1, 0.9, 0, 0, 0, 0, 0, 0, 0, 0],
  computed_at: NOW,
  ...over,
});

describe('D-285 — drift survives a reload', () => {
  it('raises the banner from the STORED row, with no broadcast at all', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    deps.runDriftRead.mockResolvedValue({ rows: [storedSignal()] });
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    await flush();
    await flush();

    expect(deps.runDriftRead).toHaveBeenCalledTimes(1);
    expect(fakeHost.getHtml()).toContain('housekeeping-drift-banner');
    mount.dispose();
  });

  it('carries the distributions the event cannot, so the drawer has something to draw', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    deps.runDriftRead.mockResolvedValue({ rows: [storedSignal()] });
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    await flush();
    await flush();

    expect(mount.getState().driftSignals.summary?.baseline_distribution).toHaveLength(10);
    mount.dispose();
  });

  it('upgrades an event placeholder to the stored row one round-trip later', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    await flush();
    // The event paints first — that is what a broadcast is for — but carries
    // no bins, so the drawer would have nothing to render from it alone.
    deps.runDriftRead.mockResolvedValue({ rows: [storedSignal()] });
    deps.fire('enrichment_drift_detected', {
      kind: 'enrichment_drift_detected',
      source_topic: 'summary',
      psi: 0.31,
      severity: 'significant',
      computed_at: NOW,
      cursor: 2,
    });
    expect(mount.getState().driftSignals.summary?.baseline_distribution).toHaveLength(0);
    await flush();
    await flush();

    expect(mount.getState().driftSignals.summary?.baseline_distribution).toHaveLength(10);
    expect(fakeHost.getHtml()).toContain('housekeeping-drift-banner');
    mount.dispose();
  });

  it('does not re-raise a banner the owner just dismissed', async () => {
    // ⛔ The regression this rpc would otherwise INTRODUCE. Dismissal is
    // client-side state; without carrying it across the merge, the next read
    // hands back the same verdict undismissed and the banner pops straight
    // back up — the read would have made the surface naggier than the bug.
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    deps.runDriftRead.mockResolvedValue({ rows: [storedSignal()] });
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    await flush();
    await flush();
    fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
    expect(fakeHost.getHtml()).not.toContain('housekeeping-drift-banner');

    await mount.refresh();
    await flush();
    await flush();

    expect(mount.getState().driftSignals.summary?.dismissed_at).toBe(NOW);
    expect(fakeHost.getHtml()).not.toContain('housekeeping-drift-banner');
    mount.dispose();
  });

  it('re-arms on a NEWER computation, which is the transition rule', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    deps.runDriftRead.mockResolvedValue({ rows: [storedSignal()] });
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    await flush();
    await flush();
    fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
    expect(fakeHost.getHtml()).not.toContain('housekeeping-drift-banner');

    deps.runDriftRead.mockResolvedValue({ rows: [storedSignal({ computed_at: NOW + 1 })] });
    await mount.refresh();
    await flush();
    await flush();

    expect(mount.getState().driftSignals.summary?.dismissed_at).toBeUndefined();
    expect(fakeHost.getHtml()).toContain('housekeeping-drift-banner');
    mount.dispose();
  });

  it('degrades to bus-only when the server has no drift read', async () => {
    const fakeHost = makeFakeHost();
    const { runDriftRead: _omitted, ...deps } = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    await flush();

    expect(fakeHost.getHtml()).not.toContain('housekeeping-drift-banner');
    deps.fire('enrichment_drift_detected', {
      kind: 'enrichment_drift_detected',
      source_topic: 'summary',
      psi: 0.31,
      severity: 'significant',
      computed_at: NOW,
      cursor: 2,
    });
    await flush();
    expect(fakeHost.getHtml()).toContain('housekeeping-drift-banner');
    mount.dispose();
  });
});
