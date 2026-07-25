/** R25 — `mountMaintenancePanel` (Server ▸ Maintenance) tests.
 *
 *  Drives the mount through the string-innerHTML fake-host pattern.
 *  Covers: renders only the core-task partition with Run-now buttons +
 *  clean one-liners; enrichment producers are excluded; Run-now open →
 *  confirm fires `housekeeping.task.run_now` then reloads status; a
 *  `housekeeping_cycle` broadcast reloads status; no run-now caller → no
 *  Run-now buttons; `dispose()` drops listeners + is idempotent. */

import { describe, expect, it, vi } from 'vitest';

import { mountMaintenancePanel } from '../settings/maintenance-panel-mount.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import type { HousekeepingTaskStatus } from '@recued/contracts';

const NOW = 1_700_000_000_000;

const coreTask = (id: string, description: string): HousekeepingTaskStatus => ({
  meta: { id, description, interruptible: true, kind: 'core' },
  state: {
    task_id: id,
    cursor: { kind: 'complete' },
    last_run_at: NOW - 60_000,
    last_status: 'complete',
    consecutive_errors: 0,
  },
});

const enrichmentTask = (): HousekeepingTaskStatus => ({
  meta: { id: 'enrichment.summary', description: 'Mail summary digest', interruptible: true, kind: 'enrichment' },
  enrichment: { token_estimate_per_record: 600, source_collection_count: 50 },
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const makeFakeHost = () => {
  let html = '';
  const attrs = new Map<string, string>();
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const handlers: Record<string, (event?: unknown) => void> = {};
  const host = {
    get innerHTML() { return html; },
    set innerHTML(v: string) { html = v; },
    setAttribute: (k: string, v: string): void => { attrs.set(k, v); },
    removeAttribute: (k: string): void => { attrs.delete(k); },
    getAttribute: (k: string): string | null => attrs.get(k) ?? null,
    addEventListener: (evt: string, fn: (event: Event) => void): void => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt: string, fn: (event: Event) => void): void => {
      listeners[evt]?.delete(fn);
    },
  } as unknown as HTMLElement;
  const subscribe = vi.fn((kind: string, handler: (event?: unknown) => void) => {
    handlers[kind] = handler;
    return () => { delete handlers[kind]; };
  }) as unknown as BroadcastSubscriber['on'];
  return {
    host,
    subscribe,
    getHtml: () => html,
    listenerCount: () => Object.values(listeners).reduce((n, s) => n + s.size, 0),
    fireCycle: () => handlers.housekeeping_cycle?.({}),
    clickAction: (action: string, taskId?: string): void => {
      const actionEl = {
        getAttribute: (n: string) =>
          n === 'data-action' ? action : n === 'data-task-id' ? (taskId ?? null) : null,
      };
      for (const fn of [...(listeners.click ?? [])]) {
        fn({ target: { closest: (s: string) => (s === '[data-action]' ? actionEl : null) } } as unknown as Event);
      }
    },
  };
};

describe('mountMaintenancePanel', () => {
  it('renders only the core-task partition, with Run-now + clean one-liners', async () => {
    const fakeHost = makeFakeHost();
    const runStatusRead = vi.fn(() =>
      Promise.resolve({ tasks: [coreTask('audit-compaction', 'Dedupe noisy audit rows'), enrichmentTask()] }),
    );
    const runRunNow = vi.fn(() => Promise.resolve({ ok: true as const, cycle_result: {} }));
    const mount = mountMaintenancePanel({
      host: fakeHost.host, runStatusRead, runRunNow, now: () => NOW, subscribe: fakeHost.subscribe,
    });
    await mount.whenLoaded();
    const html = fakeHost.getHtml();
    expect(html).toContain('audit-compaction');
    expect(html).toContain('Dedupe noisy audit rows');
    expect(html).toContain('housekeeping-task-table');
    // Run-now button rendered (caller wired).
    expect(html).toMatch(/data-action="housekeeping-run-now-open"[^>]*data-task-id="audit-compaction"/);
    // Enrichment producer is NOT in the maintenance table.
    expect(html).not.toContain('enrichment.summary');
    mount.dispose();
  });

  it('run-now open → confirm fires the rpc then reloads status', async () => {
    const fakeHost = makeFakeHost();
    const runStatusRead = vi.fn(() => Promise.resolve({ tasks: [coreTask('cache-gc', 'Evict expired cache')] }));
    const runRunNow = vi.fn(() => Promise.resolve({ ok: true as const, cycle_result: {} }));
    const mount = mountMaintenancePanel({ host: fakeHost.host, runStatusRead, runRunNow, now: () => NOW });
    await mount.whenLoaded();
    expect(runStatusRead).toHaveBeenCalledTimes(1);

    fakeHost.clickAction('housekeeping-run-now-open', 'cache-gc');
    expect(fakeHost.getHtml()).toContain('housekeeping-runnow-dialog');

    fakeHost.clickAction('housekeeping-run-now-confirm');
    await flush();
    expect(runRunNow).toHaveBeenCalledWith({ task_id: 'cache-gc' });
    // Status re-read after the run (initial + refresh).
    expect(runStatusRead).toHaveBeenCalledTimes(2);
    mount.dispose();
  });

  it('reloads status on a housekeeping_cycle broadcast', async () => {
    const fakeHost = makeFakeHost();
    const runStatusRead = vi.fn(() => Promise.resolve({ tasks: [coreTask('tls-cert-renewal', 'Renew TLS cert')] }));
    const mount = mountMaintenancePanel({
      host: fakeHost.host, runStatusRead, now: () => NOW, subscribe: fakeHost.subscribe,
    });
    await mount.whenLoaded();
    expect(runStatusRead).toHaveBeenCalledTimes(1);
    fakeHost.fireCycle();
    await flush();
    await mount.whenLoaded();
    expect(runStatusRead).toHaveBeenCalledTimes(2);
    mount.dispose();
  });

  it('a cycle firing mid-load does not stale-drop the load that clears loading', async () => {
    // Split-generation guard: the cycle refresh must use its own counter,
    // else the initial load (which clears `loading`) gets invalidated and
    // the panel can stick on "Loading…".
    const fakeHost = makeFakeHost();
    const resolvers: Array<(v: { tasks: HousekeepingTaskStatus[] }) => void> = [];
    const runStatusRead = vi.fn(
      () => new Promise<{ tasks: HousekeepingTaskStatus[] }>((res) => resolvers.push(res)),
    );
    const mount = mountMaintenancePanel({
      host: fakeHost.host, runStatusRead, now: () => NOW, subscribe: fakeHost.subscribe,
    });
    // Initial load in flight (loading=true). Fire a cycle before it resolves.
    expect(mount.getState().loading).toBe(true);
    fakeHost.fireCycle();
    await flush();
    // Resolve the refresh first, then the initial load.
    resolvers[1]?.({ tasks: [coreTask('cache-gc', 'refresh tasks')] });
    await flush();
    resolvers[0]?.({ tasks: [coreTask('audit-compaction', 'load tasks')] });
    await flush();
    // The initial load was NOT invalidated by the cycle → loading cleared.
    expect(mount.getState().loading).toBe(false);
    expect(mount.getState().tasks.length).toBeGreaterThan(0);
    mount.dispose();
  });

  it('omits Run-now buttons when no run-now caller is wired', async () => {
    const fakeHost = makeFakeHost();
    const runStatusRead = vi.fn(() => Promise.resolve({ tasks: [coreTask('link-discovery', 'Discover links')] }));
    const mount = mountMaintenancePanel({ host: fakeHost.host, runStatusRead, now: () => NOW });
    await mount.whenLoaded();
    expect(fakeHost.getHtml()).toContain('link-discovery');
    expect(fakeHost.getHtml()).not.toContain('data-action="housekeeping-run-now-open"');
    mount.dispose();
  });

  it('dispose() drops listeners and is idempotent', async () => {
    const fakeHost = makeFakeHost();
    const runStatusRead = vi.fn(() => Promise.resolve({ tasks: [coreTask('audit-compaction', 'x')] }));
    const mount = mountMaintenancePanel({ host: fakeHost.host, runStatusRead, now: () => NOW });
    await mount.whenLoaded();
    expect(fakeHost.listenerCount()).toBeGreaterThan(0);
    mount.dispose();
    expect(fakeHost.listenerCount()).toBe(0);
    expect(() => mount.dispose()).not.toThrow();
  });
});
