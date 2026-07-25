/** D-145 PA11 — `mountLlmResultCacheCard` tests.
 *
 *  Drives the mount through its documented user actions via the
 *  string-innerHTML fake host pattern (same as `d-156-phase-5-devices-
 *  page-mount.test.ts`). Click events are synthesized with a
 *  `target.closest('[data-action]')` stub so the delegated listener
 *  fires without parsing the rendered HTML.
 *
 *  Covers:
 *    - Initial paint renders the loading skeleton; `runStats` fires
 *      on mount.
 *    - Successful stats response populates the snapshot + paints the
 *      rollup HTML.
 *    - Empty cache (`total_entries === 0`) renders the short note +
 *      hides the Clear button.
 *    - `runStats` rejection surfaces the inline load error.
 *    - Clicking Clear transitions to the inline confirm strip.
 *    - Cancel returns to the populated card without invoking
 *      `runClear`.
 *    - Confirm fires `runClear`, refreshes stats on success.
 *    - `runClear` rejection surfaces `clearError`; the strip stays
 *      open so the user can retry.
 *    - Read-only mount (no `runClear`) suppresses the Clear click.
 *    - `dispose()` removes the listener + clears innerHTML +
 *      idempotent on repeat call. */

import { describe, expect, it, vi } from 'vitest';

import { mountLlmResultCacheCard } from '../settings/llm-result-cache-card-mount.js';

// ════════════════════════════════════════════════════════════════
// Fake host (mirror of d-156-phase-5-devices-page-mount.test.ts)
// ════════════════════════════════════════════════════════════════

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
    hasAttribute: (k: string): boolean => attrs.has(k),
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
  return {
    host,
    getHtml: () => html,
    getAttr: (k: string) => attrs.get(k) ?? null,
    listenerCount: () =>
      Object.values(listeners).reduce((n, s) => n + s.size, 0),
    clickAction: (action: string): void => {
      const actionEl = {
        getAttribute: (name: string) => (name === 'data-action' ? action : null),
      };
      const target = {
        closest: (selector: string) =>
          selector === '[data-action]' ? actionEl : null,
      };
      fire('click', target);
    },
  };
};

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const FIXED_NOW = 2_000_000_000_000;

const populatedStats = () => ({
  total_entries: 12,
  total_hits: 36,
  per_topic: [
    { topic: 'summary' as const, entry_count: 8, hit_count: 24 },
    { topic: 'embedding' as const, entry_count: 4, hit_count: 12 },
  ],
  last_gc_at: FIXED_NOW - 3 * 60 * 60 * 1000,
});

const emptyStats = () => ({
  total_entries: 0,
  total_hits: 0,
  per_topic: [],
  last_gc_at: null as number | null,
});

// ════════════════════════════════════════════════════════════════
// Initial paint + load
// ════════════════════════════════════════════════════════════════

describe('mountLlmResultCacheCard — initial paint + load', () => {
  it('paints the loading skeleton + fires runStats on mount', async () => {
    const fakeHost = makeFakeHost();
    let resolveStats!: (value: ReturnType<typeof populatedStats>) => void;
    const runStats = vi.fn(
      () =>
        new Promise<ReturnType<typeof populatedStats>>((resolve) => {
          resolveStats = resolve;
        }),
    );

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      now: () => FIXED_NOW,
    });

    expect(runStats).toHaveBeenCalledTimes(1);
    expect(fakeHost.getHtml()).toContain('Loading cache stats…');
    expect(mount.getState().loading).toBe(true);
    expect(mount.getState().stats).toBeNull();

    resolveStats(populatedStats());
    await flush();
    expect(mount.getState().loading).toBe(false);
    expect(mount.getState().stats?.total_entries).toBe(12);
    expect(fakeHost.getHtml()).not.toContain('Loading cache stats…');
    mount.dispose();
  });

  it('paints the rollup + per-topic table for a populated cache', async () => {
    const fakeHost = makeFakeHost();
    const runStats = vi.fn(async () => populatedStats());

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      runClear: vi.fn(),
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    const html = fakeHost.getHtml();
    expect(html).toContain('LLM result cache');
    expect(html).toContain('<dt>Entries</dt>');
    expect(html).toContain('<dd>12</dd>');
    expect(html).toContain('<code>summary</code>');
    expect(html).toContain('<code>embedding</code>');
    expect(html).toContain('Clear cache');
    expect(html).toContain('3h ago');
    mount.dispose();
  });

  it('paints the empty-cache short note + hides Clear button', async () => {
    const fakeHost = makeFakeHost();
    const runStats = vi.fn(async () => emptyStats());

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      runClear: vi.fn(),
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    const html = fakeHost.getHtml();
    expect(html).toContain('Currently empty');
    expect(html).not.toContain('Clear cache');
    expect(html).toContain('Last GC sweep: —');
    mount.dispose();
  });

  it('surfaces the load error when runStats rejects', async () => {
    const fakeHost = makeFakeHost();
    const runStats = vi.fn(async () => {
      throw new Error('cache unsupported on this server');
    });

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    expect(mount.getState().loadError).toContain('cache unsupported');
    expect(fakeHost.getHtml()).toContain('cache unsupported');
    mount.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// Clear flow
// ════════════════════════════════════════════════════════════════

describe('mountLlmResultCacheCard — Clear two-stage confirm', () => {
  it('Clear click opens the inline confirm strip', async () => {
    const fakeHost = makeFakeHost();
    const runStats = vi.fn(async () => populatedStats());
    const runClear = vi.fn();

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      runClear,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    fakeHost.clickAction('housekeeping-cache-clear');
    expect(mount.getState().confirmingClear).toBe(true);
    expect(fakeHost.getHtml()).toContain('Confirm clear');
    expect(runClear).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('Cancel click closes the strip without invoking runClear', async () => {
    const fakeHost = makeFakeHost();
    const runStats = vi.fn(async () => populatedStats());
    const runClear = vi.fn();

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      runClear,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    fakeHost.clickAction('housekeeping-cache-clear');
    fakeHost.clickAction('housekeeping-cache-clear-cancel');
    expect(mount.getState().confirmingClear).toBe(false);
    expect(mount.getState().clearError).toBeNull();
    expect(runClear).not.toHaveBeenCalled();
    expect(fakeHost.getHtml()).not.toContain('Confirm clear');
    mount.dispose();
  });

  it('Confirm fires runClear + refreshes stats on success', async () => {
    const fakeHost = makeFakeHost();
    // First stats call paints the populated rollup; second (after
    // clear) returns the empty shape so the refresh is observable.
    let statsCallCount = 0;
    const runStats = vi.fn(async () => {
      statsCallCount += 1;
      return statsCallCount === 1 ? populatedStats() : emptyStats();
    });
    const runClear = vi.fn(async () => ({ ok: true as const, rows_deleted: 12 }));

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      runClear,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    fakeHost.clickAction('housekeeping-cache-clear');
    fakeHost.clickAction('housekeeping-cache-clear-confirm');
    await mount.whenClearSettled();

    expect(runClear).toHaveBeenCalledTimes(1);
    expect(runStats).toHaveBeenCalledTimes(2);
    expect(mount.getState().confirmingClear).toBe(false);
    expect(mount.getState().clearing).toBe(false);
    expect(mount.getState().clearError).toBeNull();
    expect(mount.getState().stats?.total_entries).toBe(0);
    expect(fakeHost.getHtml()).toContain('Currently empty');
    mount.dispose();
  });

  it('surfaces clearError when runClear rejects + keeps the strip open', async () => {
    const fakeHost = makeFakeHost();
    const runStats = vi.fn(async () => populatedStats());
    const runClear = vi.fn(async () => {
      throw new Error('permission denied — re-pair the device');
    });

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      runClear,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    fakeHost.clickAction('housekeeping-cache-clear');
    fakeHost.clickAction('housekeeping-cache-clear-confirm');
    await mount.whenClearSettled();

    expect(runClear).toHaveBeenCalledTimes(1);
    expect(mount.getState().clearing).toBe(false);
    expect(mount.getState().clearError).toContain('permission denied');
    // Strip stays open so the user can Cancel + retry.
    expect(mount.getState().confirmingClear).toBe(true);
    // Stats unchanged (no refresh after a failed clear — the cache
    // is still populated; the next refresh fires on user action).
    expect(mount.getState().stats?.total_entries).toBe(12);
    expect(runStats).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('Clear click is a no-op when runClear is absent (read-only mount)', async () => {
    const fakeHost = makeFakeHost();
    const runStats = vi.fn(async () => populatedStats());

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      // runClear omitted → read-only mount.
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    fakeHost.clickAction('housekeeping-cache-clear');
    expect(mount.getState().confirmingClear).toBe(false);
    mount.dispose();
  });

  it('Cancel mid-clear is suppressed (state machine deterministic)', async () => {
    const fakeHost = makeFakeHost();
    const runStats = vi.fn(async () => populatedStats());
    let resolveClear!: (value: { ok: true; rows_deleted: number }) => void;
    const runClear = vi.fn(
      () =>
        new Promise<{ ok: true; rows_deleted: number }>((resolve) => {
          resolveClear = resolve;
        }),
    );

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      runClear,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    fakeHost.clickAction('housekeeping-cache-clear');
    // Confirm without awaiting — leaves the rpc in flight.
    fakeHost.clickAction('housekeeping-cache-clear-confirm');
    expect(mount.getState().clearing).toBe(true);

    // Synthetic cancel click mid-clear: the renderer disables the
    // button so a real user couldn't click, but the fake-DOM has no
    // disabled tracking. The mount's own state-machine guard refuses.
    fakeHost.clickAction('housekeeping-cache-clear-cancel');
    expect(mount.getState().confirmingClear).toBe(true);
    expect(mount.getState().clearing).toBe(true);

    // Resolve the in-flight clear so cleanup completes.
    resolveClear({ ok: true, rows_deleted: 12 });
    await flush();
    await flush();
    mount.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// Lifecycle
// ════════════════════════════════════════════════════════════════

describe('mountLlmResultCacheCard — lifecycle', () => {
  it('stamps the host attribute on mount + clears it on dispose', async () => {
    const fakeHost = makeFakeHost();
    const runStats = vi.fn(async () => emptyStats());

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    expect(fakeHost.getAttr('data-recued-cache-card-host')).toBe('');
    mount.dispose();
    expect(fakeHost.getAttr('data-recued-cache-card-host')).toBeNull();
  });

  it('dispose removes the click listener + clears innerHTML', async () => {
    const fakeHost = makeFakeHost();
    const runStats = vi.fn(async () => populatedStats());

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      runClear: vi.fn(),
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    expect(fakeHost.listenerCount()).toBe(1);
    mount.dispose();
    expect(fakeHost.listenerCount()).toBe(0);
    expect(fakeHost.getHtml()).toBe('');
  });

  it('dispose is idempotent', async () => {
    const fakeHost = makeFakeHost();
    const runStats = vi.fn(async () => emptyStats());

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();
    mount.dispose();
    expect(() => mount.dispose()).not.toThrow();
  });

  it('refresh() re-fires runStats + tracks the latest load promise', async () => {
    const fakeHost = makeFakeHost();
    let statsCallCount = 0;
    const runStats = vi.fn(async () => {
      statsCallCount += 1;
      return statsCallCount === 1 ? emptyStats() : populatedStats();
    });

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();
    expect(mount.getState().stats?.total_entries).toBe(0);

    await mount.refresh();
    expect(runStats).toHaveBeenCalledTimes(2);
    expect(mount.getState().stats?.total_entries).toBe(12);
    mount.dispose();
  });

  it('state mutations after dispose are dropped', async () => {
    const fakeHost = makeFakeHost();
    let resolveStats!: (value: ReturnType<typeof populatedStats>) => void;
    const runStats = vi.fn(
      () =>
        new Promise<ReturnType<typeof populatedStats>>((resolve) => {
          resolveStats = resolve;
        }),
    );

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats,
      now: () => FIXED_NOW,
    });
    mount.dispose();
    resolveStats(populatedStats());
    await flush();
    // Disposed before the rpc resolved — state stays at the
    // pre-dispose snapshot (loading: true, stats: null).
    expect(mount.getState().stats).toBeNull();
  });
});
