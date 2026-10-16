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

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

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
    inputAction: (action: string, value: string): void => {
      fire('input', { value, getAttribute: (name: string) => name === 'data-action' ? action : null });
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
  // D-285 follow-up — the dismissal write. ⛔ The default has to return a REAL
  // dismissed signal, because the mount adopts `effective` as the new state:
  // a stub carrying only `source_topic` silently DROPPED the dismissal and
  // made the banner reappear inside the same mount. A double that cannot
  // represent what it returns tests the double.
  const runDriftDismiss = vi.fn((args: { source_topic: string }) =>
    Promise.resolve({
      ok: true as const,
      effective: storedSignal({ source_topic: args.source_topic, dismissed_at: NOW }),
    }),
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
    runDriftDismiss,
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

  for (const control of [
    { action: 'housekeeping-trust-state-pick', value: 'manual', patch: { trust_state: 'manual' as const } },
    { action: 'housekeeping-pool-policy-pick', value: 'free_only', patch: { pool_policy: 'free_only' as const } },
  ]) {
    it(`serializes same-topic changes while ${control.action} is pending`, async () => {
      const fakeHost = makeFakeHost();
      const deps = makeDeps();
      const saved = trustRow('auto');
      deps.runTrustRead.mockResolvedValue({ rows: [saved] });
      const ack = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
      deps.runTrustWrite.mockImplementationOnce(() => ack.promise);
      const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
      await mount.whenLoaded();
      fakeHost.changeAction(control.action, { topic: 'summary', value: control.value });
      fakeHost.changeAction('housekeeping-trust-state-pick', { topic: 'summary', value: 'off' });
      fakeHost.changeAction('housekeeping-pool-policy-pick', { topic: 'summary', value: 'byok_only' });
      deps.fireCycle();
      await flush();
      expect(deps.runTrustWrite).toHaveBeenCalledTimes(1);
      expect(deps.runTrustWrite).toHaveBeenCalledWith({ topic: 'summary', ...control.patch });
      expect(mount.getState().trustRows.summary).toEqual(saved);
      expect(mount.getState().trustWriting.summary).toBe(true);
      const effective = { ...saved, ...control.patch };
      ack.resolve({ ok: true, effective });
      await flush();
      expect(mount.getState().trustRows.summary).toEqual(effective);
      expect(mount.getState().trustWriting.summary).toBeUndefined();
      mount.dispose();
    });

    it(`keeps the saved choice after ${control.action} fails and accepts an explicit retry`, async () => {
      const fakeHost = makeFakeHost();
      const deps = makeDeps();
      const saved = trustRow('auto');
      const effective = { ...saved, ...control.patch };
      deps.runTrustRead.mockResolvedValue({ rows: [saved] });
      const ack = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
      deps.runTrustWrite.mockImplementationOnce(() => ack.promise)
        .mockResolvedValueOnce({ ok: true, effective });
      const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
      await mount.whenLoaded();
      fakeHost.changeAction(control.action, { topic: 'summary', value: control.value });
      fakeHost.changeAction(control.action, { topic: 'summary', value: control.value });
      expect(deps.runTrustWrite).toHaveBeenCalledTimes(1);
      ack.reject(new Error('write unavailable'));
      await flush();
      expect(mount.getState().trustRows.summary).toEqual(saved);
      expect(mount.getState().trustWriteError.summary).toBe('write unavailable');
      expect(mount.getState().trustWriting.summary).toBeUndefined();
      fakeHost.changeAction(control.action, { topic: 'summary', value: control.value });
      await flush();
      expect(deps.runTrustWrite).toHaveBeenCalledTimes(2);
      expect(mount.getState().trustRows.summary).toEqual(effective);
      expect(mount.getState().trustWriteError.summary).toBeUndefined();
      mount.dispose();
    });
  }

  it('allows another topic to write without clearing the first topic\'s pending change', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const saved = trustRow('auto');
    const other = { ...saved, topic: 'thread_signals' };
    deps.runTrustRead.mockResolvedValue({ rows: [saved, other] });
    deps.runStatusRead.mockResolvedValue({ tasks: [aiTask(), {
      ...aiTask(), meta: { ...aiTask().meta, id: 'enrichment.thread_signals' },
    }] });
    const first = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    const second = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    deps.runTrustWrite.mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    fakeHost.changeAction('housekeeping-trust-state-pick', { topic: 'summary', value: 'manual' });
    fakeHost.changeAction('housekeeping-pool-policy-pick', { topic: 'thread_signals', value: 'free_only' });
    expect(deps.runTrustWrite).toHaveBeenCalledTimes(2);
    second.resolve({ ok: true, effective: { ...other, pool_policy: 'free_only' } });
    await flush();
    expect(mount.getState().trustWriting.summary).toBe(true);
    expect(mount.getState().trustWriting.thread_signals).toBeUndefined();
    first.resolve({ ok: true, effective: { ...saved, trust_state: 'manual' } });
    await flush();
    expect(mount.getState().trustRows.summary?.trust_state).toBe('manual');
    expect(mount.getState().trustRows.thread_signals?.pool_policy).toBe('free_only');
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

  it('blocks unchanged and repeated schedule writes while keeping Save focusable', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    let resolve!: (value: { ok: true; effective: HousekeepingConfigRow }) => void;
    deps.runConfigWrite.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const mount = mountHousekeepingPanel({ host: fakeHost.host, ...deps });
    await mount.whenLoaded();
    fakeHost.clickAction('housekeeping-save');
    expect(deps.runConfigWrite).not.toHaveBeenCalled();
    fakeHost.changeAction('housekeeping-preset-pick', { value: 'light' });
    fakeHost.clickAction('housekeeping-save');
    expect(mount.getState().saving).toBe(true);
    expect(fakeHost.getHtml()).toMatch(/data-action="housekeeping-save"[^>]*aria-disabled="true"[^>]*aria-busy="true"/);
    expect(fakeHost.getHtml()).not.toMatch(/<button[^>]*data-action="housekeeping-save"[^>]*\sdisabled(?:\s|>)/);
    fakeHost.changeAction('housekeeping-preset-pick', { value: 'aggressive' });
    fakeHost.changeAction('housekeeping-custom-budget', { value: '99000' });
    fakeHost.inputAction('housekeeping-custom-interval', '90');
    fakeHost.clickAction('housekeeping-save');
    expect(deps.runConfigWrite).toHaveBeenCalledTimes(1);
    expect(mount.getState().draftPreset).toBe('light');
    expect(mount.getState().customDraft).toEqual({});
    resolve({ ok: true, effective: makeConfig('light') });
    await flush();
    fakeHost.clickAction('housekeeping-save');
    expect(deps.runConfigWrite).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('retains unblurred number text and empty edits through passive updates and failed saves', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    deps.runConfigWrite.mockRejectedValueOnce(new Error('Schedule save unavailable.'));
    const mount = mountHousekeepingPanel({ host: fakeHost.host, ...deps });
    await mount.whenLoaded();
    fakeHost.changeAction('housekeeping-preset-pick', { value: 'custom' });
    fakeHost.inputAction('housekeeping-custom-budget', '065000');
    fakeHost.inputAction('housekeeping-custom-interval', '');
    deps.fireCycle();
    await flush();
    expect(fakeHost.getHtml()).toMatch(/id="housekeeping-custom-budget"[^>]*value="065000"/);
    expect(fakeHost.getHtml()).toMatch(/id="housekeeping-custom-interval"[^>]*value=""/);
    fakeHost.clickAction('housekeeping-save');
    expect(deps.runConfigWrite).not.toHaveBeenCalled();
    expect(fakeHost.getHtml()).toContain('Enter a cycle budget and interval');
    fakeHost.inputAction('housekeeping-custom-interval', '27');
    fakeHost.changeAction('housekeeping-custom-start', { value: '8' });
    fakeHost.changeAction('housekeeping-custom-end', { value: '19' });
    fakeHost.clickAction('housekeeping-save');
    await flush();
    expect(deps.runConfigWrite).toHaveBeenCalledWith({
      preset: 'custom', cycle_budget_ms: 65_000, cycle_interval_minutes: 27,
      custom_window_start_hour: 8, custom_window_end_hour: 19,
    });
    expect(fakeHost.getHtml()).toContain('Schedule save unavailable.');
    expect(fakeHost.getHtml()).toMatch(/id="housekeeping-custom-budget"[^>]*value="065000"/);
    expect(fakeHost.getHtml()).toMatch(/id="housekeeping-custom-interval"[^>]*value="27"/);
    mount.dispose();
  });

  for (const timing of ['before', 'during'] as const) {
    for (const result of ['snapshot', 'error'] as const) {
      it(`keeps the accepted schedule when a ${timing}-save refresh later returns a stale ${result}`, async () => {
        const fakeHost = makeFakeHost();
        const deps = makeDeps();
        const mount = mountHousekeepingPanel({ host: fakeHost.host, ...deps });
        await mount.whenLoaded();
        let resolveRead!: (value: HousekeepingConfigRow) => void;
        let rejectRead!: (error: Error) => void;
        let resolveWrite!: (value: { ok: true; effective: HousekeepingConfigRow }) => void;
        deps.runConfigRead.mockImplementationOnce(() => new Promise((r, j) => { resolveRead = r; rejectRead = j; }));
        deps.runConfigWrite.mockImplementationOnce(() => new Promise((r) => { resolveWrite = r; }));
        fakeHost.changeAction('housekeeping-preset-pick', { value: 'light' });
        const read = timing === 'before' ? mount.refresh() : null;
        fakeHost.clickAction('housekeeping-save');
        const duringRead = timing === 'during' ? mount.refresh() : null;
        resolveWrite({ ok: true, effective: makeConfig('light') });
        await flush();
        if (result === 'snapshot') resolveRead(makeConfig('balanced'));
        else rejectRead(new Error('Old read unavailable.'));
        await (read ?? duringRead);
        expect(mount.getState().config?.preset).toBe('light');
        expect(mount.getState().error).toBeNull();
        expect(fakeHost.getHtml()).toContain('Currently light');
        mount.dispose();
      });
    }
  }

  it('keeps the schedule and drafts visible when a full refresh fails', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, ...deps });
    await mount.whenLoaded();
    fakeHost.changeAction('housekeeping-preset-pick', { value: 'custom' });
    fakeHost.inputAction('housekeeping-custom-budget', '72000');
    deps.runConfigRead.mockRejectedValueOnce(new Error('Housekeeping read unavailable.'));
    await mount.refresh();
    expect(fakeHost.getHtml()).toContain('Housekeeping read unavailable.');
    expect(fakeHost.getHtml()).toContain('housekeeping-custom-fields');
    expect(fakeHost.getHtml()).toMatch(/id="housekeeping-custom-budget"[^>]*value="72000"/);
    mount.dispose();
  });

  it('does not repaint or start another read after disposal during a schedule save', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    let resolve!: (value: { ok: true; effective: HousekeepingConfigRow }) => void;
    deps.runConfigWrite.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const mount = mountHousekeepingPanel({ host: fakeHost.host, ...deps });
    await mount.whenLoaded();
    fakeHost.changeAction('housekeeping-preset-pick', { value: 'light' });
    fakeHost.clickAction('housekeeping-save');
    mount.dispose();
    resolve({ ok: true, effective: makeConfig('light') });
    await flush();
    expect(fakeHost.getHtml()).toBe('');
    expect(deps.runConfigRead).toHaveBeenCalledTimes(1);
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
    await flush();
    expect(fakeHost.getHtml()).not.toContain('housekeeping-drift-banner');
    mount.dispose();
  });

  it.each(['promote', 'dismiss'] as const)('blocks repeated promotion %s and leaves a failed banner retryable', async (kind) => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const pending = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    const caller = kind === 'promote' ? deps.runTrustWrite : deps.runDismissPromotion;
    caller.mockImplementationOnce(() => pending.promise);
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    deps.fire('enrichment_promotion_suggested', {
      kind: 'enrichment_promotion_suggested', topic: 'summary', manual_run_count: 3,
      estimated_idle_cycle_cost_tokens: 1200, cursor: 1,
    });
    const activate = (choice = kind) => fakeHost.clickActionAttrs(`housekeeping-promotion-${choice}`, { 'data-topic': 'summary' });
    activate();
    activate();
    activate(kind === 'promote' ? 'dismiss' : 'promote');
    expect(caller).toHaveBeenCalledTimes(1);
    expect(kind === 'promote' ? deps.runDismissPromotion : deps.runTrustWrite).not.toHaveBeenCalled();
    expect(mount.getState().promotionWriting.summary).toBe(true);
    expect(fakeHost.getHtml()).toContain('housekeeping-promotion-banner');
    pending.reject(new Error('banner save failed'));
    await flush();
    expect(mount.getState().promotionWriting.summary).toBeUndefined();
    expect(fakeHost.getHtml()).toContain('banner save failed');
    activate();
    await flush();
    expect(caller).toHaveBeenCalledTimes(2);
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    expect(mount.getState().promotionWriteError.summary).toBeUndefined();
    mount.dispose();
  });

  it('keeps a pending drift dismissal visible, blocks repeats and Review, and accepts an explicit retry', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const pending = deferred<{ ok: true; effective: ConfidenceDriftSignal }>();
    deps.runDriftRead.mockResolvedValue({ rows: [storedSignal()] });
    deps.runDriftDismiss.mockImplementationOnce(() => pending.promise);
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    await flush();
    const dismiss = () => fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
    dismiss();
    dismiss();
    fakeHost.clickActionAttrs('housekeeping-drift-review', { 'data-source-topic': 'summary' });
    expect(deps.runDriftDismiss).toHaveBeenCalledTimes(1);
    expect(mount.getState().expandedTopic).toBeNull();
    expect(mount.getState().driftWriting.summary).toBe(true);
    expect(fakeHost.getHtml()).toContain('Dismissing…');
    pending.reject(new Error('dismissal failed'));
    await flush();
    expect(mount.getState().driftSignals.summary?.dismissed_at).toBeUndefined();
    expect(fakeHost.getHtml()).toContain('dismissal failed');
    dismiss();
    await flush();
    expect(deps.runDriftDismiss).toHaveBeenCalledTimes(2);
    expect(fakeHost.getHtml()).not.toContain('housekeeping-drift-banner');
    expect(mount.getState().driftWriteError.summary).toBeUndefined();
    mount.dispose();
  });

  const trustActions = ['run-policy', 'model-pool', 'promote', 'dismiss'] as const;
  type TrustAction = typeof trustActions[number];
  const activateTrustAction = (fakeHost: ReturnType<typeof makeFakeHost>, action: TrustAction, topic = 'summary') => {
    if (action === 'run-policy' || action === 'model-pool') {
      fakeHost.changeAction(action === 'run-policy' ? 'housekeeping-trust-state-pick' : 'housekeeping-pool-policy-pick', {
        topic, value: action === 'run-policy' ? 'off' : 'free_only',
      });
    } else fakeHost.clickActionAttrs(`housekeeping-promotion-${action}`, { 'data-topic': topic });
  };
  const effectiveAfter = (saved: EnrichmentTrustRow, action: TrustAction): EnrichmentTrustRow => ({
    ...saved,
    ...(action === 'run-policy' ? { trust_state: 'off' as const }
      : action === 'model-pool' ? { pool_policy: 'free_only' as const }
        : action === 'promote' ? { trust_state: 'auto' as const }
          : { promotion_dismissed_at: NOW }),
  });

  for (const outcome of ['success', 'failure']) {
    it.each(trustActions)(`shares the topic lock during %s ${outcome} and does not queue blocked actions`, async (action) => {
      const fakeHost = makeFakeHost();
      const deps = makeDeps();
      const saved = { ...trustRow('manual'), manual_run_count: 3, promotion_suggested_at: NOW };
      deps.runTrustRead.mockResolvedValue({ rows: [saved] });
      const pending = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
      const caller = action === 'dismiss' ? deps.runDismissPromotion : deps.runTrustWrite;
      caller.mockImplementationOnce(() => pending.promise);
      const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
      await mount.whenLoaded();
      activateTrustAction(fakeHost, action);
      for (const blocked of trustActions) activateTrustAction(fakeHost, blocked);
      expect(deps.runTrustWrite).toHaveBeenCalledTimes(action === 'dismiss' ? 0 : 1);
      expect(deps.runDismissPromotion).toHaveBeenCalledTimes(action === 'dismiss' ? 1 : 0);
      expect(mount.getState().trustRows.summary).toEqual(saved);
      expect(mount.getState().trustWriting.summary).toBe(true);
      const expected = outcome === 'success' ? effectiveAfter(saved, action) : saved;
      if (outcome === 'success') pending.resolve({ ok: true, effective: expected });
      else pending.reject(new Error('trust row save failed'));
      await flush();
      expect(mount.getState().trustRows.summary).toEqual(expected);
      expect(mount.getState().trustWriting.summary).toBeUndefined();
      expect(mount.getState().promotionWriting.summary).toBeUndefined();
      expect(caller).toHaveBeenCalledTimes(1);
      const followup = { ...expected, pool_policy: 'byok_only' as const };
      deps.runTrustWrite.mockResolvedValueOnce({ ok: true, effective: followup });
      fakeHost.changeAction('housekeeping-pool-policy-pick', { topic: 'summary', value: 'byok_only' });
      await flush();
      expect(mount.getState().trustRows.summary).toEqual(followup);
      expect(deps.runTrustWrite).toHaveBeenCalledTimes(action === 'dismiss' ? 1 : 2);
      mount.dispose();
    });
  }

  it.each(['promote', 'dismiss'] as const)('a pending %s leaves another topic writable and keeps its newer row', async (action) => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const saved = { ...trustRow('manual'), manual_run_count: 3, promotion_suggested_at: NOW };
    const other = { ...saved, topic: 'thread_signals' };
    deps.runTrustRead.mockResolvedValue({ rows: [saved, other] });
    deps.runStatusRead.mockResolvedValue({ tasks: [aiTask(), { ...aiTask(), meta: { ...aiTask().meta, id: 'enrichment.thread_signals' } }] });
    const pending = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    const caller = action === 'dismiss' ? deps.runDismissPromotion : deps.runTrustWrite;
    caller.mockImplementationOnce(() => pending.promise);
    const changedOther = { ...other, pool_policy: 'free_only' as const };
    deps.runTrustWrite.mockResolvedValueOnce({ ok: true, effective: changedOther });
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    activateTrustAction(fakeHost, action);
    activateTrustAction(fakeHost, 'model-pool', 'thread_signals');
    await flush();
    expect(mount.getState().trustRows.thread_signals).toEqual(changedOther);
    expect(mount.getState().trustWriting.summary).toBe(true);
    expect(mount.getState().trustWriting.thread_signals).toBeUndefined();
    pending.resolve({ ok: true, effective: effectiveAfter(saved, action) });
    await flush();
    expect(mount.getState().trustRows.thread_signals).toEqual(changedOther);
    expect(mount.getState().trustRows.summary).toEqual(effectiveAfter(saved, action));
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

  for (const outcome of ['success', 'failure']) {
    it(`ignores an old reset ${outcome} while a reopened preview is still pending`, async () => {
      const fakeHost = makeFakeHost();
      const deps = makeDeps();
      const old = deferred<ReturnType<typeof resetResult>>();
      const current = deferred<ReturnType<typeof resetResult>>();
      deps.runTopicReset.mockImplementationOnce(() => old.promise)
        .mockImplementationOnce(() => current.promise);
      const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
      await mount.whenLoaded();
      fakeHost.clickActionAttrs('housekeeping-reset-open', { 'data-topic': 'summary' });
      fakeHost.clickAction('housekeeping-reset-cancel');
      fakeHost.clickActionAttrs('housekeeping-reset-open', { 'data-topic': 'summary' });
      const before = structuredClone(mount.getState().reset);
      if (outcome === 'success') old.resolve(resetResult(false, { confirmation_token: 'obsolete' }));
      else old.reject(new Error('obsolete preview failure'));
      await flush();
      expect(mount.getState().reset).toEqual(before);
      expect(mount.getState().reset.phase).toBe('previewing');
      fakeHost.clickAction('housekeeping-reset-confirm');
      expect(deps.runTopicReset).toHaveBeenCalledTimes(2);
      current.resolve(resetResult(false, { confirmation_token: 'current' }));
      await flush();
      expect(mount.getState().reset.confirmation_token).toBe('current');
      mount.dispose();
    });

    for (const phase of ['preview', 'confirming', 'applied']) {
      it(`keeps the newer reset ${phase} and confirmation choice after an old ${outcome}`, async () => {
        const fakeHost = makeFakeHost();
        const deps = makeDeps();
        const old = deferred<ReturnType<typeof resetResult>>();
        const confirm = deferred<ReturnType<typeof resetResult>>();
        deps.runTopicReset.mockImplementationOnce(() => old.promise)
          .mockResolvedValueOnce(resetResult(false, {
            confirmation_token: 'current-token', reset_psi_baselines: false,
          }))
          .mockImplementationOnce(() => confirm.promise);
        const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
        await mount.whenLoaded();
        fakeHost.clickActionAttrs('housekeeping-reset-open', { 'data-topic': 'summary' });
        fakeHost.clickAction('housekeeping-reset-cancel');
        fakeHost.clickActionAttrs('housekeeping-reset-open', { 'data-topic': 'summary' });
        await flush();
        if (phase !== 'preview') fakeHost.clickAction('housekeeping-reset-confirm');
        if (phase === 'applied') {
          confirm.resolve(resetResult(true, { reset_psi_baselines: false }));
          await flush();
        }
        expect(mount.getState().reset.phase).toBe(phase);
        const before = structuredClone(mount.getState().reset);
        if (outcome === 'success') old.resolve(resetResult(false, {
          confirmation_token: 'obsolete-token', reset_psi_baselines: true,
        }));
        else old.reject(new Error('obsolete preview failure'));
        await flush();
        expect(mount.getState().reset).toEqual(before);
        if (phase === 'preview') fakeHost.clickAction('housekeeping-reset-confirm');
        expect(deps.runTopicReset).toHaveBeenNthCalledWith(3, {
          topic: 'summary', confirmation_token: 'current-token', reset_psi_baselines: false,
        });
        expect(deps.runTopicReset).toHaveBeenCalledTimes(3);
        if (phase !== 'applied') {
          confirm.resolve(resetResult(true, { reset_psi_baselines: false }));
          await flush();
        }
        expect(mount.getState().reset.phase).toBe('applied');
        expect(mount.getState().reset.confirmation_token).toBeNull();
        mount.dispose();
      });
    }
  }

  it('keeps a newer preview failure and mints a fresh token on explicit retry', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const old = deferred<ReturnType<typeof resetResult>>();
    deps.runTopicReset.mockImplementationOnce(() => old.promise)
      .mockRejectedValueOnce(new Error('current preview failure'))
      .mockResolvedValueOnce(resetResult(false, { confirmation_token: 'retry-token' }));
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    fakeHost.clickActionAttrs('housekeeping-reset-open', { 'data-topic': 'summary' });
    fakeHost.clickAction('housekeeping-reset-cancel');
    fakeHost.clickActionAttrs('housekeeping-reset-open', { 'data-topic': 'summary' });
    await flush();
    old.resolve(resetResult(false, { confirmation_token: 'obsolete-token' }));
    await flush();
    expect(mount.getState().reset.phase).toBe('error');
    expect(mount.getState().reset.error).toBe('current preview failure');
    expect(mount.getState().reset.confirmation_token).toBeNull();
    fakeHost.clickAction('housekeeping-reset-confirm');
    expect(deps.runTopicReset).toHaveBeenCalledTimes(2);
    fakeHost.clickAction('housekeeping-reset-retry');
    await flush();
    expect(mount.getState().reset.phase).toBe('preview');
    expect(mount.getState().reset.confirmation_token).toBe('retry-token');
    mount.dispose();
  });

  it('ignores a reset preview arriving after disposal', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const reply = deferred<ReturnType<typeof resetResult>>();
    deps.runTopicReset.mockImplementationOnce(() => reply.promise);
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    fakeHost.clickActionAttrs('housekeeping-reset-open', { 'data-topic': 'summary' });
    mount.dispose();
    reply.resolve(resetResult(false));
    await flush();
    expect(fakeHost.getHtml()).toBe('');
    expect(mount.getState().reset.phase).toBe('previewing');
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

describe('drift event continuity', () => {
  for (const age of ['same', 'older'] as const) {
    for (const dismissal of ['visible', 'persisted', 'local'] as const) {
      for (const readOutcome of ['success', 'failure'] as const) {
        it(`keeps the ${dismissal} stored result during a ${age} event and follow-up read ${readOutcome}`, async () => {
          const fakeHost = makeFakeHost();
          const deps = makeDeps();
          const original = storedSignal({ low_confidence_delta: 0.17,
            ...(dismissal === 'persisted' ? { dismissed_at: NOW + 5 } : {}) });
          const other = storedSignal({ source_topic: 'thread_signals' });
          deps.runDriftRead.mockResolvedValueOnce({ rows: [original, other] });
          const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW + 10, ...deps,
            ...(dismissal === 'local' ? { runDriftDismiss: undefined } : {}) });
          await mount.whenLoaded();
          await flush();
          if (dismissal === 'local') fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
          const before = mount.getState().driftSignals.summary;
          const read = deferred<{ rows: ConfidenceDriftSignal[] }>();
          deps.runDriftRead.mockImplementationOnce(() => read.promise);
          deps.fire('enrichment_drift_detected', {
            kind: 'enrichment_drift_detected', source_topic: 'summary',
            computed_at: age === 'same' ? NOW : NOW - 1,
            severity: age === 'same' ? 'significant' : 'moderate',
            psi: age === 'same' ? 0.31 : 0.18,
            low_confidence_delta: age === 'same' ? 0.17 : 0.09, cursor: 100,
          });
          expect(deps.runDriftRead).toHaveBeenCalledTimes(2);
          expect(mount.getState().driftSignals.summary).toEqual(before);
          expect(mount.getState().driftSignals.thread_signals).toEqual(other);
          if (readOutcome === 'success') read.resolve({ rows: [original, other] });
          else read.reject(new Error('Drift read unavailable.'));
          await flush();
          expect(mount.getState().driftSignals.summary).toEqual(before);
          expect(mount.getState().driftSignals.thread_signals).toEqual(other);
          expect(mount.getState().error).toBeNull();
          mount.dispose();
        });
      }
    }
  }

  for (const dismissed of [false, true]) {
    for (const readOutcome of ['success', 'failure'] as const) {
      it(`paints a genuinely newer event over a ${dismissed ? 'dismissed' : 'visible'} result before read ${readOutcome}`, async () => {
        const fakeHost = makeFakeHost();
        const deps = makeDeps();
        deps.runDriftRead.mockResolvedValueOnce({ rows: [storedSignal(dismissed ? { dismissed_at: NOW } : {})] });
        const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
        await mount.whenLoaded();
        await flush();
        const read = deferred<{ rows: ConfidenceDriftSignal[] }>();
        deps.runDriftRead.mockImplementationOnce(() => read.promise);
        const next = storedSignal({ computed_at: NOW + 1, severity: 'moderate', psi: 0.18, low_confidence_delta: 0.12 });
        deps.fire('enrichment_drift_detected', {
          kind: 'enrichment_drift_detected', source_topic: next.source_topic,
          computed_at: next.computed_at, severity: next.severity, psi: next.psi,
          low_confidence_delta: next.low_confidence_delta, cursor: 100,
        });
        const placeholder = mount.getState().driftSignals.summary;
        expect(placeholder).toMatchObject({ computed_at: NOW + 1, severity: 'moderate', low_confidence_delta: 0.12 });
        expect(placeholder.dismissed_at).toBeUndefined();
        expect(placeholder.baseline_distribution).toEqual([]);
        expect(placeholder.recent_distribution).toEqual([]);
        expect(placeholder.shift).toBeUndefined();
        expect(fakeHost.getHtml()).toContain('housekeeping-drift-banner');
        if (readOutcome === 'success') read.resolve({ rows: [next] });
        else read.reject(new Error('Drift read unavailable.'));
        await flush();
        expect(mount.getState().driftSignals.summary).toEqual(readOutcome === 'success' ? next : placeholder);
        mount.dispose();
      });
    }
  }

  it.each(['same', 'older'] as const)('keeps a bus-only dismissal after a %s event and re-arms on a newer one', async (age) => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps,
      runDriftRead: undefined, runDriftDismiss: undefined });
    await mount.whenLoaded();
    const event = { kind: 'enrichment_drift_detected', source_topic: 'summary',
      computed_at: NOW, severity: 'significant', psi: 0.31, cursor: 100 };
    deps.fire('enrichment_drift_detected', event);
    fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
    deps.fire('enrichment_drift_detected', { ...event, computed_at: age === 'same' ? NOW : NOW - 1, cursor: 101 });
    expect(mount.getState().driftSignals.summary.dismissed_at).toBe(NOW);
    expect(fakeHost.getHtml()).not.toContain('housekeeping-drift-banner');
    deps.fire('enrichment_drift_detected', { ...event, computed_at: NOW + 1, cursor: 102 });
    expect(mount.getState().driftSignals.summary.dismissed_at).toBeUndefined();
    expect(fakeHost.getHtml()).toContain('housekeeping-drift-banner');
    expect(deps.runDriftRead).not.toHaveBeenCalled();
    expect(deps.runDriftDismiss).not.toHaveBeenCalled();
    mount.dispose();
  });
});

describe('D-285 — drift survives a reload', () => {
  for (const delivery of ['broadcast', 'read']) {
    for (const outcome of ['success', 'failure']) {
      for (const alreadyDismissed of [false, true]) {
        it(`keeps a newer ${delivery} verdict ${alreadyDismissed ? 'dismissed' : 'visible'} after an older dismissal ${outcome}`, async () => {
          const fakeHost = makeFakeHost();
          const deps = makeDeps();
          const original = storedSignal();
          deps.runDriftRead.mockResolvedValue({ rows: [original] });
          const pending = deferred<{ ok: true; effective: ConfidenceDriftSignal }>();
          deps.runDriftDismiss.mockImplementationOnce(() => pending.promise);
          const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
          await mount.whenLoaded();
          await flush();
          fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
          const next = storedSignal({ computed_at: NOW + 1, severity: 'moderate', psi: 0.18,
            ...(alreadyDismissed ? { dismissed_at: NOW + 2 } : {}) });
          deps.runDriftRead.mockResolvedValue({ rows: [next] });
          if (delivery === 'broadcast') {
            deps.fire('enrichment_drift_detected', {
              kind: 'enrichment_drift_detected', source_topic: 'summary', psi: next.psi,
              severity: next.severity, computed_at: next.computed_at, cursor: 100,
            });
          } else await mount.refresh();
          await flush();
          expect(mount.getState().driftSignals.summary).toEqual(next);
          if (outcome === 'success') pending.resolve({ ok: true, effective: { ...original, dismissed_at: NOW } });
          else pending.reject(new Error('old dismissal failed'));
          await flush();
          expect(mount.getState().driftSignals.summary).toEqual(next);
          expect(mount.getState().driftWriting.summary).toBeUndefined();
          expect(mount.getState().driftWriteError.summary).toBeUndefined();
          expect(fakeHost.getHtml().includes('housekeeping-drift-banner')).toBe(!alreadyDismissed);
          if (!alreadyDismissed) {
            deps.runDriftDismiss.mockResolvedValueOnce({ ok: true, effective: { ...next, dismissed_at: NOW + 3 } });
            fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
            await flush();
            expect(deps.runDriftDismiss).toHaveBeenCalledTimes(2);
            expect(mount.getState().driftSignals.summary?.computed_at).toBe(next.computed_at);
            expect(mount.getState().driftSignals.summary?.dismissed_at).toBe(NOW + 3);
            expect(fakeHost.getHtml()).not.toContain('housekeeping-drift-banner');
          }
          mount.dispose();
        });
      }
    }
  }

  it('keeps the server’s first dismissal timestamp within the same computation', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const original = storedSignal();
    const pending = deferred<{ ok: true; effective: ConfidenceDriftSignal }>();
    deps.runDriftRead.mockResolvedValue({ rows: [original] });
    deps.runDriftDismiss.mockImplementationOnce(() => pending.promise);
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW + 50, ...deps });
    await mount.whenLoaded();
    await flush();
    fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
    expect(mount.getState().driftSignals.summary?.dismissed_at).toBe(NOW + 50);
    pending.resolve({ ok: true, effective: { ...original, dismissed_at: NOW + 10 } });
    await flush();
    expect(mount.getState().driftSignals.summary?.dismissed_at).toBe(NOW + 10);
    mount.dispose();
  });

  it('accepts a newer computation actually acknowledged by the server', async () => {
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    deps.runDriftRead.mockResolvedValue({ rows: [storedSignal()] });
    const next = storedSignal({ computed_at: NOW + 1, dismissed_at: NOW + 2 });
    deps.runDriftDismiss.mockResolvedValueOnce({ ok: true, effective: next });
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    await flush();
    fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
    await flush();
    expect(mount.getState().driftSignals.summary).toEqual(next);
    expect(mount.getState().driftWriting.summary).toBeUndefined();
    expect(fakeHost.getHtml()).not.toContain('housekeeping-drift-banner');
    mount.dispose();
  });

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

  /** A server that remembers, which is the whole point. `runDriftDismiss`
   *  writes `dismissed_at` onto the row `runDriftRead` will hand back next
   *  time — so a REMOUNT reads what the dismissal wrote. A double that
   *  acknowledged the call without changing the row is exactly the bug:
   *  every assertion below would still pass while the banner came back. */
  const fakeDriftServer = (deps: ReturnType<typeof makeDeps>, at = NOW) => {
    let row: ConfidenceDriftSignal = storedSignal();
    deps.runDriftRead.mockImplementation(() => Promise.resolve({ rows: [row] }));
    deps.runDriftDismiss.mockImplementation(() => {
      // Idempotent, like the handler: the FIRST timestamp stands.
      row = { ...row, dismissed_at: row.dismissed_at ?? at };
      return Promise.resolve({ ok: true as const, effective: row });
    });
    return { current: () => row };
  };

  it('a dismissal SURVIVES A REMOUNT, which a refresh could never show', async () => {
    // ⛔⛔ THE REGRESSION D-285 SHIPPED, AND WHY ITS TEST MISSED IT. The case
    // below this one calls `mount.refresh()` — the SAME mount, whose in-memory
    // `driftSignals` still holds the dismissal — so it passed while the real
    // path was broken. Measured live: dismiss, reload, the banner is back;
    // fresh tab, back again. A remount starts from `{}` and reads the server,
    // which is the only shape that can tell.
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    const server = fakeDriftServer(deps);
    const first = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await first.whenLoaded();
    await flush();
    await flush();
    expect(fakeHost.getHtml()).toContain('housekeeping-drift-banner');

    fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
    await flush();
    await flush();
    expect(deps.runDriftDismiss).toHaveBeenCalledWith({ source_topic: 'summary' });
    expect(server.current().dismissed_at).toBe(NOW);
    first.dispose();

    // A new mount: empty state, reads the server. This is a reload.
    const secondHost = makeFakeHost();
    const second = mountHousekeepingPanel({ host: secondHost.host, now: () => NOW, ...deps });
    await second.whenLoaded();
    await flush();
    await flush();

    expect(secondHost.getHtml()).not.toContain('housekeeping-drift-banner');
    second.dispose();
  });

  it('degrades to a local dismissal when the server has no dismiss method', async () => {
    // Documents what an older server does: the banner returns on the next
    // mount. Not silently — it is the pre-D-285 shape, and the honest thing
    // is for the test to name it rather than leave it to be discovered.
    const fakeHost = makeFakeHost();
    const { runDriftDismiss: _absent, ...deps } = makeDeps();
    deps.runDriftRead.mockResolvedValue({ rows: [storedSignal()] });
    const first = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await first.whenLoaded();
    await flush();
    await flush();
    fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
    expect(fakeHost.getHtml()).not.toContain('housekeeping-drift-banner');
    first.dispose();

    const secondHost = makeFakeHost();
    const second = mountHousekeepingPanel({ host: secondHost.host, now: () => NOW, ...deps });
    await second.whenLoaded();
    await flush();
    await flush();
    expect(secondHost.getHtml()).toContain('housekeeping-drift-banner');
    second.dispose();
  });

  it('a FAILED dismissal brings the banner back and says why', async () => {
    // ⛔ Leaving it hidden would be the friendlier lie: it returns on the next
    // load anyway, and the owner would meet it again with no idea why.
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    deps.runDriftRead.mockResolvedValue({ rows: [storedSignal()] });
    deps.runDriftDismiss.mockRejectedValue(new Error('server said no'));
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    await flush();
    await flush();

    fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
    await flush();
    await flush();

    expect(mount.getState().driftSignals.summary?.dismissed_at).toBeUndefined();
    expect(fakeHost.getHtml()).toContain('housekeeping-drift-banner');
    expect(mount.getState().driftWriteError.summary).toContain('server said no');
    mount.dispose();
  });

  it('does not re-raise a banner the owner just dismissed', async () => {
    // ⚠ SAME-MOUNT refresh. Kept because it pins the merge rule (the read must
    // not clobber a dismissal it is holding), but it is NOT the reload case —
    // see the remount test above, which is the one that catches the defect.
    const fakeHost = makeFakeHost();
    const deps = makeDeps();
    deps.runDriftRead.mockResolvedValue({ rows: [storedSignal()] });
    const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
    await mount.whenLoaded();
    await flush();
    await flush();
    fakeHost.clickActionAttrs('housekeeping-drift-dismiss', { 'data-source-topic': 'summary' });
    await flush();
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
    await flush();
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

// ── The promotion banner: same defect as the drift banner had ────────
//
// ⛔ `promotionSuggestions` had exactly two writers — the broadcast handler and
// the one that REMOVES an entry — and starts `{}`. So the banner rendered once,
// for whoever happened to be looking, and was gone on the next mount, while
// `promotion_suggested_at` sat on the trust row the panel had just fetched.
// A refresh-based test could never show it; these remount.

const suggestedRow = (over: Partial<EnrichmentTrustRow> = {}): EnrichmentTrustRow => ({
  ...trustRow('manual'),
  manual_run_count: 3,
  promotion_suggested_at: NOW,
  ...over,
});

const mountWith = async (rows: EnrichmentTrustRow[]) => {
  const fakeHost = makeFakeHost();
  const deps = makeDeps();
  deps.runTrustRead.mockResolvedValue({ rows });
  const mount = mountHousekeepingPanel({ host: fakeHost.host, now: () => NOW, ...deps });
  await mount.whenLoaded();
  await flush();
  await flush();
  return { fakeHost, deps, mount };
};

describe('promotion banner survives a reload', () => {
  it('restores from the trust rows the panel already loads — no broadcast', async () => {
    const { fakeHost, mount } = await mountWith([suggestedRow()]);

    expect(fakeHost.getHtml()).toContain('housekeeping-promotion-banner');
    expect(mount.getState().promotionSuggestions.summary?.manual_run_count).toBe(3);
    mount.dispose();
  });

  it('⛔ does NOT re-raise it on a topic the owner already turned on', async () => {
    // Nothing clears `promotion_suggested_at` when they accept — `trust-store`
    // carries it forward — so "suggested and not dismissed" would nag forever
    // on a topic that is already automatic. This is the clause that decides it.
    const { fakeHost, mount } = await mountWith([suggestedRow({ trust_state: 'auto' })]);

    expect(fakeHost.getHtml()).not.toContain('housekeeping-promotion-banner');
    mount.dispose();
  });

  it('does not re-raise one they dismissed', async () => {
    const { fakeHost, mount } = await mountWith([
      suggestedRow({ promotion_dismissed_at: NOW }),
    ]);

    expect(fakeHost.getHtml()).not.toContain('housekeeping-promotion-banner');
    mount.dispose();
  });

  it('says it does not know the cost, rather than claiming the run is free', async () => {
    // ⚠ The estimate is computed at fire time from per-record tokens × source
    // count; neither is on the trust row. `formatTokens` renders `<= 0` as
    // "no estimate available", so 0 is the honest value here — NOT a claim.
    const { fakeHost, mount } = await mountWith([suggestedRow()]);

    expect(fakeHost.getHtml()).toContain('no estimate available');
    expect(fakeHost.getHtml()).not.toContain('~0 tokens');
    mount.dispose();
  });

  it('a LIVE suggestion wins over the restored one, because it has the cost', async () => {
    const { fakeHost, deps, mount } = await mountWith([suggestedRow()]);
    deps.fire('enrichment_promotion_suggested', {
      kind: 'enrichment_promotion_suggested',
      topic: 'summary',
      manual_run_count: 3,
      estimated_idle_cycle_cost_tokens: 30_000,
      cursor: 9,
    });
    await flush();

    expect(mount.getState().promotionSuggestions.summary?.estimated_idle_cycle_cost_tokens)
      .toBe(30_000);
    expect(fakeHost.getHtml()).toContain('30,000 tokens');
    mount.dispose();
  });
});

const firePromotion = (deps: ReturnType<typeof makeDeps>, topic = 'summary', cost = 30_000): void => {
  deps.fire('enrichment_promotion_suggested', {
    kind: 'enrichment_promotion_suggested', topic, manual_run_count: 3,
    estimated_idle_cycle_cost_tokens: cost, cursor: 9,
  });
};

describe('promotion continuity', () => {
  it.each(['restored', 'live'] as const)('removes a %s suggestion only after inline Auto succeeds', async (origin) => {
    const { fakeHost, deps, mount } = await mountWith([
      suggestedRow(), suggestedRow({ topic: 'thread_signals' }),
    ]);
    if (origin === 'live') firePromotion(deps);
    const before = mount.getState().promotionSuggestions.summary;
    const other = mount.getState().promotionSuggestions.thread_signals;
    const ack = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    deps.runTrustWrite.mockImplementationOnce(() => ack.promise);
    fakeHost.changeAction('housekeeping-trust-state-pick', { topic: 'summary', value: 'auto' });
    expect(mount.getState().promotionSuggestions.summary).toEqual(before);
    expect(mount.getState().trustRows.summary.trust_state).toBe('manual');
    ack.resolve({ ok: true, effective: suggestedRow({ trust_state: 'auto' }) });
    await flush();
    expect(mount.getState().trustRows.summary.trust_state).toBe('auto');
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    expect(mount.getState().promotionSuggestions.thread_signals).toEqual(other);
    expect(mount.getState().trustWriting.summary).toBeUndefined();
    mount.dispose();
  });

  it.each(['restored', 'live'] as const)('keeps a %s suggestion after failed Auto and removes it after explicit retry', async (origin) => {
    const { fakeHost, deps, mount } = await mountWith([suggestedRow()]);
    if (origin === 'live') firePromotion(deps);
    const before = mount.getState().promotionSuggestions.summary;
    const ack = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    deps.runTrustWrite.mockImplementationOnce(() => ack.promise)
      .mockResolvedValueOnce({ ok: true, effective: suggestedRow({ trust_state: 'auto' }) });
    const pick = () => fakeHost.changeAction('housekeeping-trust-state-pick', { topic: 'summary', value: 'auto' });
    pick();
    ack.reject(new Error('Auto save unavailable.'));
    await flush();
    expect(mount.getState().promotionSuggestions.summary).toEqual(before);
    expect(mount.getState().trustRows.summary.trust_state).toBe('manual');
    expect(mount.getState().trustWriting.summary).toBeUndefined();
    expect(mount.getState().trustWriteError.summary).toBe('Auto save unavailable.');
    expect(deps.runTrustWrite).toHaveBeenCalledTimes(1);
    pick();
    await flush();
    expect(deps.runTrustWrite).toHaveBeenCalledTimes(2);
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    expect(mount.getState().trustWriteError.summary).toBeUndefined();
    mount.dispose();
  });

  it.each([
    { name: 'Manual', action: 'housekeeping-trust-state-pick', value: 'manual', effective: suggestedRow() },
    { name: 'Off', action: 'housekeeping-trust-state-pick', value: 'off', effective: suggestedRow({ trust_state: 'off' }) },
    { name: 'Model pool', action: 'housekeeping-pool-policy-pick', value: 'free_only', effective: suggestedRow({ pool_policy: 'free_only' }) },
  ])('retains a live cost estimate after a $name save', async ({ action, value, effective }) => {
    const { fakeHost, deps, mount } = await mountWith([suggestedRow()]);
    firePromotion(deps);
    const before = mount.getState().promotionSuggestions.summary;
    deps.runTrustWrite.mockResolvedValueOnce({ ok: true, effective });
    fakeHost.changeAction(action, { topic: 'summary', value });
    await flush();
    expect(mount.getState().promotionSuggestions.summary).toEqual(before);
    expect(mount.getState().trustRows.summary).toEqual(effective);
    mount.dispose();
  });

  it.each([
    { name: 'Auto', effective: suggestedRow({ trust_state: 'auto' }) },
    { name: 'dismissed', effective: suggestedRow({ promotion_dismissed_at: NOW }) },
  ])('honors the effective $name row even when only Model pool was requested', async ({ effective }) => {
    const { fakeHost, deps, mount } = await mountWith([suggestedRow()]);
    firePromotion(deps);
    deps.runTrustWrite.mockResolvedValueOnce({ ok: true, effective });
    fakeHost.changeAction('housekeeping-pool-policy-pick', { topic: 'summary', value: 'free_only' });
    await flush();
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    expect(mount.getState().trustRows.summary).toEqual(effective);
    mount.dispose();
  });

  it.each([
    { name: 'Auto', effective: suggestedRow({ trust_state: 'auto' }) },
    { name: 'dismissed', effective: suggestedRow({ promotion_dismissed_at: NOW }) },
  ])('removes a live suggestion when refresh reads an $name row without clearing another topic', async ({ effective }) => {
    const other = suggestedRow({ topic: 'thread_signals' });
    const { deps, mount } = await mountWith([suggestedRow(), other]);
    firePromotion(deps);
    firePromotion(deps, other.topic, 12_000);
    const otherSuggestion = mount.getState().promotionSuggestions.thread_signals;
    deps.runTrustRead.mockResolvedValueOnce({ rows: [effective, other] });
    await mount.refresh();
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    expect(mount.getState().promotionSuggestions.thread_signals).toEqual(otherSuggestion);
    mount.dispose();
  });

  it('keeps the live estimate on refresh and restores a newly suggested topic', async () => {
    const { deps, mount } = await mountWith([suggestedRow()]);
    firePromotion(deps);
    const before = mount.getState().promotionSuggestions.summary;
    deps.runTrustRead.mockResolvedValueOnce({ rows: [suggestedRow(), suggestedRow({ topic: 'thread_signals' })] });
    await mount.refresh();
    expect(mount.getState().promotionSuggestions.summary).toEqual(before);
    expect(mount.getState().promotionSuggestions.thread_signals).toEqual({
      topic: 'thread_signals', manual_run_count: 3, estimated_idle_cycle_cost_tokens: 0,
    });
    mount.dispose();
  });

  it('keeps a new topic broadcast that arrives during an older trust read', async () => {
    const { deps, mount } = await mountWith([suggestedRow()]);
    const read = deferred<{ rows: EnrichmentTrustRow[] }>();
    deps.runTrustRead.mockImplementationOnce(() => read.promise);
    const refresh = mount.refresh();
    firePromotion(deps, 'thread_signals', 12_000);
    read.resolve({ rows: [suggestedRow()] });
    await refresh;
    expect(mount.getState().promotionSuggestions.thread_signals?.estimated_idle_cycle_cost_tokens).toBe(12_000);
    mount.dispose();
  });

  it('leaves live suggestions intact when the trust refresh fails', async () => {
    const { deps, mount } = await mountWith([suggestedRow()]);
    firePromotion(deps);
    const before = mount.getState().promotionSuggestions;
    deps.runTrustRead.mockRejectedValueOnce(new Error('Trust read unavailable.'));
    await mount.refresh();
    expect(mount.getState().promotionSuggestions).toEqual(before);
    expect(mount.getState().error).toBe('Trust read unavailable.');
    mount.dispose();
  });
});

const settledPromotionRow = (choice: 'auto' | 'dismissed'): EnrichmentTrustRow => suggestedRow(
  choice === 'auto' ? { trust_state: 'auto' } : { promotion_dismissed_at: NOW },
);

describe('promotion hints during trust saves', () => {
  it.each([
    { name: 'Manual', action: 'housekeeping-trust-state-pick', value: 'manual', effective: suggestedRow() },
    { name: 'Off', action: 'housekeeping-trust-state-pick', value: 'off', effective: suggestedRow({ trust_state: 'off' }) },
    { name: 'Model pool', action: 'housekeeping-pool-policy-pick', value: 'free_only', effective: suggestedRow({ pool_policy: 'free_only' }) },
  ])('retains the latest pending estimate when a $name reply confirms eligibility', async ({ action, value, effective }) => {
    const other = suggestedRow({ topic: 'thread_signals' });
    const { fakeHost, deps, mount } = await mountWith([settledPromotionRow('auto'), other]);
    const beforeOther = mount.getState().promotionSuggestions.thread_signals;
    const write = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    deps.runTrustWrite.mockImplementationOnce(() => write.promise);
    fakeHost.changeAction(action, { topic: 'summary', value });
    firePromotion(deps, 'summary', 30_000);
    firePromotion(deps, 'summary', 60_000);
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    expect(mount.getState().trustRows.summary.trust_state).toBe('auto');
    expect(deps.runTrustRead).toHaveBeenCalledTimes(1);
    write.resolve({ ok: true, effective });
    await flush();
    expect(mount.getState().trustRows.summary).toEqual(effective);
    expect(mount.getState().promotionSuggestions.summary?.estimated_idle_cycle_cost_tokens).toBe(60_000);
    expect(fakeHost.getHtml()).toContain('60,000 tokens');
    expect(mount.getState().promotionSuggestions.thread_signals).toEqual(beforeOther);
    expect(deps.runTrustWrite).toHaveBeenCalledTimes(1);
    expect(deps.runTrustRead).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it.each([
    { name: 'Auto', effective: settledPromotionRow('auto') },
    { name: 'dismissed', effective: settledPromotionRow('dismissed') },
    { name: 'unarmed', effective: suggestedRow({ promotion_suggested_at: null }) },
  ])('discards the pending hint after an effective $name reply', async ({ effective }) => {
    const { fakeHost, deps, mount } = await mountWith([settledPromotionRow('auto')]);
    const write = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    deps.runTrustWrite.mockImplementationOnce(() => write.promise);
    fakeHost.changeAction('housekeeping-trust-state-pick', { topic: 'summary', value: 'manual' });
    firePromotion(deps);
    write.resolve({ ok: true, effective });
    await flush();
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    expect(mount.getState().trustRows.summary).toEqual(effective);
    deps.runTrustWrite.mockResolvedValueOnce({ ok: true, effective: suggestedRow() });
    fakeHost.changeAction('housekeeping-trust-state-pick', { topic: 'summary', value: 'manual' });
    await flush();
    expect(mount.getState().promotionSuggestions.summary?.estimated_idle_cycle_cost_tokens).toBe(0);
    expect(deps.runTrustRead).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it.each(['auto', 'dismissed'] as const)('discards a pending hint after failure and keeps the saved %s choice', async (choice) => {
    const saved = settledPromotionRow(choice);
    const { fakeHost, deps, mount } = await mountWith([saved]);
    const write = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    deps.runTrustWrite.mockImplementationOnce(() => write.promise);
    fakeHost.changeAction('housekeeping-trust-state-pick', { topic: 'summary', value: 'manual' });
    firePromotion(deps);
    write.reject(new Error('Manual save unavailable.'));
    await flush();
    expect(mount.getState().trustRows.summary).toEqual(saved);
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    expect(mount.getState().trustWriteError.summary).toBe('Manual save unavailable.');
    expect(deps.runTrustWrite).toHaveBeenCalledTimes(1);
    deps.runTrustWrite.mockResolvedValueOnce({ ok: true, effective: suggestedRow() });
    fakeHost.changeAction('housekeeping-trust-state-pick', { topic: 'summary', value: 'manual' });
    await flush();
    expect(mount.getState().promotionSuggestions.summary?.estimated_idle_cycle_cost_tokens).toBe(0);
    expect(mount.getState().trustWriteError.summary).toBeUndefined();
    expect(deps.runTrustRead).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('keeps pending hints isolated when two topics finish in the opposite order', async () => {
    const other = suggestedRow({ topic: 'thread_signals' });
    const { fakeHost, deps, mount } = await mountWith([
      settledPromotionRow('auto'), { ...other, trust_state: 'auto' },
    ]);
    const summaryWrite = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    const otherWrite = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    deps.runTrustWrite.mockImplementationOnce(() => summaryWrite.promise).mockImplementationOnce(() => otherWrite.promise);
    for (const topic of ['summary', other.topic]) {
      fakeHost.changeAction('housekeeping-trust-state-pick', { topic, value: 'manual' });
      firePromotion(deps, topic, topic === 'summary' ? 30_000 : 12_000);
    }
    otherWrite.resolve({ ok: true, effective: other });
    await flush();
    expect(mount.getState().promotionSuggestions.thread_signals?.estimated_idle_cycle_cost_tokens).toBe(12_000);
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    summaryWrite.resolve({ ok: true, effective: suggestedRow() });
    await flush();
    expect(mount.getState().promotionSuggestions.summary?.estimated_idle_cycle_cost_tokens).toBe(30_000);
    expect(mount.getState().promotionSuggestions.thread_signals?.estimated_idle_cycle_cost_tokens).toBe(12_000);
    expect(deps.runTrustRead).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('keeps the pending hint when an older event read completes after the save', async () => {
    const { fakeHost, deps, mount } = await mountWith([settledPromotionRow('auto')]);
    const read = deferred<{ rows: EnrichmentTrustRow[] }>();
    const write = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    deps.runTrustRead.mockImplementationOnce(() => read.promise);
    firePromotion(deps, 'summary', 12_000);
    deps.runTrustWrite.mockImplementationOnce(() => write.promise);
    fakeHost.changeAction('housekeeping-trust-state-pick', { topic: 'summary', value: 'manual' });
    firePromotion(deps, 'summary', 60_000);
    write.resolve({ ok: true, effective: suggestedRow() });
    await flush();
    read.resolve({ rows: [settledPromotionRow('auto')] });
    await flush();
    expect(mount.getState().trustRows.summary.trust_state).toBe('manual');
    expect(mount.getState().promotionSuggestions.summary?.estimated_idle_cycle_cost_tokens).toBe(60_000);
    expect(deps.runTrustRead).toHaveBeenCalledTimes(2);
    mount.dispose();
  });

  it('does not restore a pending hint after disposal', async () => {
    const { fakeHost, deps, mount } = await mountWith([settledPromotionRow('auto')]);
    const write = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    deps.runTrustWrite.mockImplementationOnce(() => write.promise);
    fakeHost.changeAction('housekeeping-trust-state-pick', { topic: 'summary', value: 'manual' });
    firePromotion(deps);
    mount.dispose();
    write.resolve({ ok: true, effective: suggestedRow() });
    await flush();
    expect(fakeHost.getHtml()).toBe('');
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
  });
});

describe('promotion event reconciliation', () => {
  for (const choice of ['auto', 'dismissed'] as const) {
    for (const outcome of ['success', 'failure', 'absent'] as const) {
      it(`keeps a known ${choice} suggestion hidden through read ${outcome}`, async () => {
        const saved = settledPromotionRow(choice);
        const other = suggestedRow({ topic: 'thread_signals' });
        const { deps, mount } = await mountWith([saved, other]);
        const otherSuggestion = mount.getState().promotionSuggestions.thread_signals;
        const read = deferred<{ rows: EnrichmentTrustRow[] }>();
        deps.runTrustRead.mockImplementationOnce(() => read.promise);
        firePromotion(deps);
        expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
        expect(deps.runTrustRead).toHaveBeenCalledTimes(2);
        if (outcome === 'failure') read.reject(new Error('Trust unavailable.'));
        else read.resolve({ rows: outcome === 'absent' ? [] : [saved, other] });
        await flush();
        expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
        expect(mount.getState().promotionSuggestions.thread_signals).toEqual(otherSuggestion);
        expect(mount.getState().trustRows.summary).toEqual(saved);
        expect(mount.getState().error).toBeNull();
        expect(deps.runTrustRead).toHaveBeenCalledTimes(2);
        mount.dispose();
      });
    }

    it(`allows a genuinely eligible server row after known ${choice} with its live estimate`, async () => {
      const { deps, mount } = await mountWith([settledPromotionRow(choice)]);
      const read = deferred<{ rows: EnrichmentTrustRow[] }>();
      deps.runTrustRead.mockImplementationOnce(() => read.promise);
      firePromotion(deps);
      expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
      const eligible = suggestedRow({ promotion_suggested_at: NOW + 1, updated_at: NOW + 2 });
      read.resolve({ rows: [eligible] });
      await flush();
      expect(mount.getState().trustRows.summary).toEqual(eligible);
      expect(mount.getState().promotionSuggestions.summary?.estimated_idle_cycle_cost_tokens).toBe(30_000);
      mount.dispose();
    });
  }

  for (const initial of ['eligible', 'unknown'] as const) {
    for (const current of ['auto', 'dismissed', 'unarmed'] as const) {
      it(`withdraws an ${initial} event hint when the server confirms ${current}`, async () => {
        const { deps, mount } = await mountWith(initial === 'eligible' ? [suggestedRow()] : []);
        const read = deferred<{ rows: EnrichmentTrustRow[] }>();
        deps.runTrustRead.mockImplementationOnce(() => read.promise);
        firePromotion(deps);
        expect(mount.getState().promotionSuggestions.summary?.estimated_idle_cycle_cost_tokens).toBe(30_000);
        const row = current === 'unarmed' ? suggestedRow({ promotion_suggested_at: null }) : settledPromotionRow(current);
        read.resolve({ rows: [row] });
        await flush();
        expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
        expect(mount.getState().trustRows.summary).toEqual(row);
        mount.dispose();
      });
    }
  }

  it.each(['auto', 'eligible'] as const)('keeps the latest event read when its %s reply arrives first', async (latest) => {
    const { deps, mount } = await mountWith([settledPromotionRow('auto')]);
    const older = deferred<{ rows: EnrichmentTrustRow[] }>();
    const newer = deferred<{ rows: EnrichmentTrustRow[] }>();
    deps.runTrustRead.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    firePromotion(deps, 'summary', 30_000);
    firePromotion(deps, 'summary', 60_000);
    const current = latest === 'auto' ? settledPromotionRow('auto') : suggestedRow({ updated_at: NOW + 2 });
    newer.resolve({ rows: [current] });
    await flush();
    older.resolve({ rows: [latest === 'auto' ? suggestedRow() : settledPromotionRow('auto')] });
    await flush();
    expect(mount.getState().trustRows.summary).toEqual(current);
    if (latest === 'auto') expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    else expect(mount.getState().promotionSuggestions.summary?.estimated_idle_cycle_cost_tokens).toBe(60_000);
    mount.dispose();
  });

  for (const action of ['inline-auto', 'pool', 'promote', 'dismiss'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      it(`ignores a stale event read after ${action} ${outcome}`, async () => {
        const saved = suggestedRow();
        const { fakeHost, deps, mount } = await mountWith([saved]);
        const read = deferred<{ rows: EnrichmentTrustRow[] }>();
        const write = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
        deps.runTrustRead.mockImplementationOnce(() => read.promise);
        firePromotion(deps);
        const caller = action === 'dismiss' ? deps.runDismissPromotion : deps.runTrustWrite;
        caller.mockImplementationOnce(() => write.promise);
        if (action === 'inline-auto' || action === 'pool') {
          fakeHost.changeAction(action === 'pool' ? 'housekeeping-pool-policy-pick' : 'housekeeping-trust-state-pick', {
            topic: 'summary', value: action === 'pool' ? 'free_only' : 'auto',
          });
        } else fakeHost.clickActionAttrs(`housekeeping-promotion-${action}`, { 'data-topic': 'summary' });
        const effective = action === 'pool' ? suggestedRow({ pool_policy: 'free_only' })
          : settledPromotionRow(action === 'dismiss' ? 'dismissed' : 'auto');
        if (outcome === 'success') write.resolve({ ok: true, effective });
        else write.reject(new Error('Save unavailable.'));
        await flush();
        const current = mount.getState().trustRows.summary;
        const suggestion = mount.getState().promotionSuggestions.summary;
        read.resolve({ rows: [outcome === 'success' && action !== 'pool' ? saved : settledPromotionRow('auto')] });
        await flush();
        expect(mount.getState().trustRows.summary).toEqual(current);
        expect(mount.getState().promotionSuggestions.summary).toEqual(suggestion);
        expect(caller).toHaveBeenCalledTimes(1);
        mount.dispose();
      });
    }
  }

  it('keeps a newer promotion read when an older full refresh completes', async () => {
    const { deps, mount } = await mountWith([suggestedRow()]);
    const full = deferred<{ rows: EnrichmentTrustRow[] }>();
    const event = deferred<{ rows: EnrichmentTrustRow[] }>();
    deps.runTrustRead.mockImplementationOnce(() => full.promise).mockImplementationOnce(() => event.promise);
    const refresh = mount.refresh();
    firePromotion(deps);
    const accepted = settledPromotionRow('auto');
    event.resolve({ rows: [accepted] });
    await flush();
    full.resolve({ rows: [suggestedRow()] });
    await refresh;
    expect(mount.getState().trustRows.summary).toEqual(accepted);
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    mount.dispose();
  });

  it('isolates topics when an unrelated save overlaps the promotion read', async () => {
    const other = suggestedRow({ topic: 'thread_signals' });
    const { fakeHost, deps, mount } = await mountWith([settledPromotionRow('auto'), other]);
    const read = deferred<{ rows: EnrichmentTrustRow[] }>();
    deps.runTrustRead.mockImplementationOnce(() => read.promise);
    firePromotion(deps);
    const changed = { ...other, pool_policy: 'free_only' as const };
    deps.runTrustWrite.mockResolvedValueOnce({ ok: true, effective: changed });
    fakeHost.changeAction('housekeeping-pool-policy-pick', { topic: other.topic, value: 'free_only' });
    await flush();
    read.resolve({ rows: [suggestedRow(), other] });
    await flush();
    expect(mount.getState().trustRows.thread_signals).toEqual(changed);
    expect(mount.getState().trustRows.summary.trust_state).toBe('manual');
    expect(mount.getState().promotionSuggestions.summary?.estimated_idle_cycle_cost_tokens).toBe(30_000);
    mount.dispose();
  });

  it('keeps an unknown-topic live hint when an older server omits its row', async () => {
    const { deps, mount } = await mountWith([]);
    firePromotion(deps);
    await flush();
    expect(mount.getState().promotionSuggestions.summary?.estimated_idle_cycle_cost_tokens).toBe(30_000);
    mount.dispose();
  });

  it('ignores an event read after disposal', async () => {
    const { fakeHost, deps, mount } = await mountWith([settledPromotionRow('auto')]);
    const read = deferred<{ rows: EnrichmentTrustRow[] }>();
    deps.runTrustRead.mockImplementationOnce(() => read.promise);
    firePromotion(deps);
    mount.dispose();
    read.resolve({ rows: [suggestedRow()] });
    await flush();
    expect(fakeHost.getHtml()).toBe('');
    expect(mount.getState().trustRows.summary.trust_state).toBe('auto');
  });

  it('lets a newer full refresh supersede an event read', async () => {
    const { deps, mount } = await mountWith([settledPromotionRow('auto')]);
    const read = deferred<{ rows: EnrichmentTrustRow[] }>();
    deps.runTrustRead.mockImplementationOnce(() => read.promise);
    firePromotion(deps);
    deps.runTrustRead.mockResolvedValueOnce({ rows: [settledPromotionRow('dismissed')] });
    await mount.refresh();
    read.resolve({ rows: [suggestedRow()] });
    await flush();
    expect(mount.getState().trustRows.summary.promotion_dismissed_at).toBe(NOW);
    expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    mount.dispose();
  });

  it.each(['success', 'failure'] as const)('leaves a pending Auto save to settle an event through %s', async (outcome) => {
    const { fakeHost, deps, mount } = await mountWith([suggestedRow()]);
    const write = deferred<{ ok: true; effective: EnrichmentTrustRow }>();
    deps.runTrustWrite.mockImplementationOnce(() => write.promise);
    fakeHost.changeAction('housekeeping-trust-state-pick', { topic: 'summary', value: 'auto' });
    firePromotion(deps);
    expect(deps.runTrustRead).toHaveBeenCalledTimes(1);
    if (outcome === 'success') write.resolve({ ok: true, effective: settledPromotionRow('auto') });
    else write.reject(new Error('Save unavailable.'));
    await flush();
    if (outcome === 'success') expect(mount.getState().promotionSuggestions.summary).toBeUndefined();
    else expect(mount.getState().promotionSuggestions.summary?.estimated_idle_cycle_cost_tokens).toBe(30_000);
    expect(deps.runTrustWrite).toHaveBeenCalledTimes(1);
    mount.dispose();
  });
});
