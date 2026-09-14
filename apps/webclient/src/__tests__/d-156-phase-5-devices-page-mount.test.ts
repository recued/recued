/** D-156 P5 — Settings → Devices page mount tests.
 *
 *  Drives `mountDevicesPage` through the documented user actions —
 *  Revoke → Cancel → Revoke → Yes-revoke → success → roster refresh —
 *  via a string-innerHTML fake DOM and a fake `pair.list` /
 *  `pair.revoke` rpc pair. Same shape as the launch-wizard / reception-
 *  authoring mount tests; the renderer's HTML is asserted against
 *  substrings since vitest runs under node (no jsdom).
 */

import { describe, it, expect, vi } from 'vitest';
import type { ServerPairedDevice } from '@recued/contracts';

import { mountDevicesPage } from '../settings/devices-page-mount.js';

// ════════════════════════════════════════════════════════════════
// Fake host
// ════════════════════════════════════════════════════════════════

const makeFakeHost = () => {
  let html = '';
  let focusedTarget:
    | { action: string; instanceId: string }
    | { receipt: true }
    | undefined;
  const body = {} as HTMLElement;
  const fakeDocument = {
    get activeElement() {
      const target = focusedTarget;
      if (target === undefined) return body;
      if ('receipt' in target) return {} as HTMLElement;
      return {
        getAttribute: (name: string) => {
          if (name === 'data-action') return target.action;
          if (name === 'data-instance-id') return target.instanceId;
          return null;
        },
      } as HTMLElement;
    },
    body,
  } as unknown as Document;
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
      focusedTarget = undefined;
    },
    ownerDocument: fakeDocument,
    addEventListener: (evt: string, fn: (event: Event) => void): void => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt: string, fn: (event: Event) => void): void => {
      listeners[evt]?.delete(fn);
    },
    querySelectorAll: (selector: string): HTMLElement[] => {
      const action = /^\[data-action="([^"]+)"\]$/.exec(selector)?.[1];
      if (action === undefined) return [];
      return [...html.matchAll(/<button\b([^>]*)>/g)]
        .map((match) => match[1] ?? '')
        .filter((attributes) =>
          attributes.includes(`data-action="${action}"`),
        )
        .map((attributes) => {
          const instanceId = /data-instance-id="([^"]+)"/.exec(attributes)?.[1] ?? '';
          return {
            getAttribute: (name: string) => {
              if (name === 'data-action') return action;
              if (name === 'data-instance-id') return instanceId;
              return null;
            },
            focus: () => {
              focusedTarget = { action, instanceId };
            },
            scrollIntoView: () => {},
          } as unknown as HTMLElement;
        });
    },
    querySelector: (selector: string): HTMLElement | null => {
      if (
        selector !== '[data-device-revoke-success]'
        || !html.includes('data-device-revoke-success')
      ) {
        return null;
      }
      return {
        focus: () => {
          focusedTarget = { receipt: true };
        },
        scrollIntoView: () => {},
      } as unknown as HTMLElement;
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
    getFocusedAction: () =>
      focusedTarget !== undefined && 'action' in focusedTarget
        ? focusedTarget
        : undefined,
    getFocusedTarget: () => focusedTarget,
    listenerCount: () => Object.values(listeners).reduce((n, s) => n + s.size, 0),
    clickAction: (action: string, instanceId?: string): void => {
      const actionEl = {
        getAttribute: (name: string) => {
          if (name === 'data-action') return action;
          if (name === 'data-instance-id') return instanceId ?? null;
          return null;
        },
      };
      const target = {
        closest: (selector: string) => {
          if (selector === '[data-action]') return actionEl;
          return null;
        },
      };
      fire('click', target);
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════

const FIXED_NOW = 2_000_000_000_000;

const buildDevice = (over: Partial<ServerPairedDevice>): ServerPairedDevice => ({
  instance_id: 'inst-A',
  display_name: 'Phone',
  kind: 'webclient',
  added_at: 1_900_000,
  revoked_at: null,
  connected: true,
  connected_at: 1_999_999,
  ...over,
});

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('mountDevicesPage — initial render + roster fetch', () => {
  it('renders the loading banner before pair.list resolves', async () => {
    const fakeHost = makeFakeHost();
    let resolveList!: (value: { devices: ServerPairedDevice[] }) => void;
    const runPairList = vi.fn(
      () =>
        new Promise<{ devices: ServerPairedDevice[] }>((resolve) => {
          resolveList = resolve;
        }),
    );
    const runPairRevoke = vi.fn();

    const mount = mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });

    // Initial render fired synchronously — should include the loading
    // banner since pair.list hasn't resolved.
    expect(fakeHost.getHtml()).toContain('Loading devices…');
    expect(runPairList).toHaveBeenCalledTimes(1);

    resolveList({ devices: [] });
    await flush();
    expect(fakeHost.getHtml()).not.toContain('Loading devices…');
    expect(fakeHost.getHtml()).toContain('No paired devices yet.');
    mount.dispose();
  });

  it('renders active rows from pair.list + drops revoked devices (R30)', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [
        buildDevice({ instance_id: 'inst-A', display_name: 'Phone' }),
        buildDevice({
          instance_id: 'inst-B',
          display_name: 'Old laptop',
          connected: false,
          connected_at: undefined,
          revoked_at: 1_950_000,
        }),
      ],
    }));
    const runPairRevoke = vi.fn();

    mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });

    await flush();
    const html = fakeHost.getHtml();
    expect(html).toContain('Phone');
    expect(html).toContain('Online now');
    // R30 — the revoked device drops off the active roster (it lingers
    // only in the audit log); re-pairing returns it as a fresh row.
    expect(html).not.toContain('Old laptop');
    expect(html).not.toContain('Revoked');
    // buildDevice defaults kind to 'webclient'.
    expect(html).toMatch(/\(Webclient\)/);
  });

  it('D-156 P10 — renders the per-device kind label from the row (Bridge / CLI)', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [
        buildDevice({ instance_id: 'wc', display_name: 'Phone', kind: 'webclient' }),
        buildDevice({ instance_id: 'br', display_name: 'Laptop', kind: 'bridge' }),
        buildDevice({ instance_id: 'cl', display_name: 'Server', kind: 'cli' }),
      ],
    }));

    mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke: vi.fn(),
      now: () => FIXED_NOW,
    });

    await flush();
    const html = fakeHost.getHtml();
    expect(html).toMatch(/\(Webclient\)/);
    expect(html).toMatch(/\(Bridge\)/);
    expect(html).toMatch(/\(CLI\)/);
  });

  it('surfaces a list error when pair.list rejects + fires onListError', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => {
      throw new Error('network down');
    });
    const runPairRevoke = vi.fn();
    const onListError = vi.fn();

    mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
      onListError,
    });

    await flush();
    expect(fakeHost.getHtml()).toContain("Couldn't load paired devices");
    expect(fakeHost.getHtml()).toContain('data-error="list"');
    expect(onListError).toHaveBeenCalledTimes(1);
    expect(onListError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('keeps list Retry focused, single-flight, and advances into recovered rows', async () => {
    const fakeHost = makeFakeHost();
    let listCalls = 0;
    let resolveRetry!: (value: { devices: ServerPairedDevice[] }) => void;
    const runPairList = vi.fn(async () => {
      listCalls += 1;
      if (listCalls === 1) throw new Error('network down');
      return new Promise<{ devices: ServerPairedDevice[] }>((resolve) => {
        resolveRetry = resolve;
      });
    });

    mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke: vi.fn(),
      now: () => FIXED_NOW,
    });
    await flush();

    fakeHost.clickAction('retry-list');
    expect(fakeHost.getHtml()).toContain('Retrying…');
    expect(fakeHost.getHtml()).toContain('aria-disabled="true"');
    expect(fakeHost.getHtml()).toContain('aria-busy="true"');
    expect(fakeHost.getHtml()).not.toMatch(/data-action="retry-list"[^>]* disabled/);
    expect(fakeHost.getFocusedAction()).toEqual({
      action: 'retry-list',
      instanceId: '',
    });
    fakeHost.clickAction('retry-list');
    expect(runPairList).toHaveBeenCalledTimes(2);

    resolveRetry({
      devices: [buildDevice({ instance_id: 'inst-recovered' })],
    });
    await flush();
    expect(fakeHost.getHtml()).not.toContain('data-error="list"');
    expect(fakeHost.getFocusedAction()).toEqual({
      action: 'revoke-device',
      instanceId: 'inst-recovered',
    });
  });

  it('returns a failed list Retry to the recreated retry action', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => {
      throw new Error('network down');
    });

    mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke: vi.fn(),
      now: () => FIXED_NOW,
    });
    await flush();

    fakeHost.clickAction('retry-list');
    await flush();
    expect(runPairList).toHaveBeenCalledTimes(2);
    expect(fakeHost.getHtml()).toContain('>Retry</button>');
    expect(fakeHost.getFocusedAction()).toEqual({
      action: 'retry-list',
      instanceId: '',
    });
  });

  it('passes currentInstanceId through to the renderer (self-revoke gating)', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [
        buildDevice({ instance_id: 'inst-self', display_name: 'This' }),
        buildDevice({ instance_id: 'inst-other', display_name: 'Other' }),
      ],
    }));
    const runPairRevoke = vi.fn();

    mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      currentInstanceId: 'inst-self',
      now: () => FIXED_NOW,
    });

    await flush();
    const html = fakeHost.getHtml();
    // The "self" row gets the placeholder, not a Revoke button.
    expect(html).toContain('account-devices-row--current');
    expect(html).toContain('account-devices-action-placeholder');
    // The "other" row gets a Revoke button stamped with its
    // instance_id.
    expect(html).toMatch(
      /data-action="revoke-device"[^>]*data-instance-id="inst-other"/,
    );
  });

  it('R30 — the list-error banner offers a Retry that re-fetches', async () => {
    const fakeHost = makeFakeHost();
    let calls = 0;
    const runPairList = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('network down');
      return {
        devices: [buildDevice({ instance_id: 'inst-A', display_name: 'Phone' })],
      };
    });

    mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke: vi.fn(),
      now: () => FIXED_NOW,
    });
    await flush();
    expect(fakeHost.getHtml()).toContain("Couldn't load paired devices");
    expect(fakeHost.getHtml()).toContain('data-action="retry-list"');

    // Clicking Retry re-fetches → the roster loads + the error clears.
    fakeHost.clickAction('retry-list');
    await flush();
    expect(runPairList).toHaveBeenCalledTimes(2);
    expect(fakeHost.getHtml()).toContain('Phone');
    expect(fakeHost.getHtml()).not.toContain("Couldn't load paired devices");
  });
});

// ════════════════════════════════════════════════════════════════
// Revoke state machine
// ════════════════════════════════════════════════════════════════

describe('mountDevicesPage — two-stage revoke confirm', () => {
  it('clicking Revoke opens the confirm panel for that row only', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [
        buildDevice({ instance_id: 'inst-A', display_name: 'Phone' }),
        buildDevice({ instance_id: 'inst-B', display_name: 'Other' }),
      ],
    }));
    const runPairRevoke = vi.fn();

    mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });
    await flush();

    fakeHost.clickAction('revoke-device', 'inst-A');
    const html = fakeHost.getHtml();
    expect(html).toContain('account-devices-confirm-row');
    expect(html).toContain('data-action="confirm-revoke"');
    expect(html).toContain('data-action="cancel-revoke"');
    // Only inst-A's confirm panel renders.
    expect(html).toMatch(
      /confirm-row[^>]*data-instance-id="inst-A"/,
    );
    expect(html).not.toMatch(/confirm-row[^>]*data-instance-id="inst-B"/);
  });

  it('clicking Revoke on a second row collapses the first confirm', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [
        buildDevice({ instance_id: 'inst-A', display_name: 'Phone' }),
        buildDevice({ instance_id: 'inst-B', display_name: 'Other' }),
      ],
    }));
    const runPairRevoke = vi.fn();

    mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });
    await flush();

    fakeHost.clickAction('revoke-device', 'inst-A');
    expect(fakeHost.getHtml()).toMatch(
      /confirm-row[^>]*data-instance-id="inst-A"/,
    );
    fakeHost.clickAction('revoke-device', 'inst-B');
    const html = fakeHost.getHtml();
    expect(html).toMatch(/confirm-row[^>]*data-instance-id="inst-B"/);
    expect(html).not.toMatch(/confirm-row[^>]*data-instance-id="inst-A"/);
  });

  it('Cancel collapses the confirm without calling pair.revoke', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [buildDevice({ instance_id: 'inst-A' })],
    }));
    const runPairRevoke = vi.fn();

    mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });
    await flush();

    fakeHost.clickAction('revoke-device', 'inst-A');
    expect(fakeHost.getHtml()).toContain('account-devices-confirm-row');
    expect(fakeHost.getFocusedAction()).toEqual({
      action: 'cancel-revoke',
      instanceId: 'inst-A',
    });
    fakeHost.clickAction('cancel-revoke', 'inst-A');
    expect(fakeHost.getHtml()).not.toContain('account-devices-confirm-row');
    expect(runPairRevoke).not.toHaveBeenCalled();
    expect(fakeHost.getFocusedAction()).toEqual({
      action: 'revoke-device',
      instanceId: 'inst-A',
    });
  });

  it('"Yes, revoke" calls pair.revoke + refreshes roster on success', async () => {
    const fakeHost = makeFakeHost();
    let listCallCount = 0;
    let resolveRefresh!: (value: { devices: ServerPairedDevice[] }) => void;
    const runPairList = vi.fn(async () => {
      listCallCount++;
      if (listCallCount === 1) {
        return {
          devices: [
            buildDevice({ instance_id: 'inst-A', display_name: 'Phone' }),
          ],
        };
      }
      return new Promise<{ devices: ServerPairedDevice[] }>((resolve) => {
        resolveRefresh = resolve;
      });
    });
    const runPairRevoke = vi.fn(async () => ({ ok: true as const }));

    const mount = mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });
    await flush();
    expect(mount.hasInFlightWork()).toBe(false);

    fakeHost.clickAction('revoke-device', 'inst-A');
    fakeHost.clickAction('confirm-revoke', 'inst-A');
    expect(mount.hasInFlightWork()).toBe(true);
    // The accepted receipt owns focus even while the authoritative roster
    // reconciliation remains in flight.
    await flush();
    expect(listCallCount).toBe(2);
    expect(fakeHost.getHtml()).toContain('Loading devices…');
    expect(fakeHost.getHtml()).toContain('Done. That device can no longer reach this server.');
    expect(fakeHost.getFocusedTarget()).toEqual({ receipt: true });
    expect(mount.hasInFlightWork()).toBe(true);

    resolveRefresh({
      devices: [
        buildDevice({
          instance_id: 'inst-A',
          display_name: 'Phone',
          revoked_at: 1_999_999,
          connected: false,
          connected_at: undefined,
        }),
      ],
    });
    await flush();

    expect(runPairRevoke).toHaveBeenCalledWith({ instance_id: 'inst-A' });
    expect(listCallCount).toBe(2);
    const html = fakeHost.getHtml();
    // R30 — after the refresh the now-revoked device drops off the roster
    // entirely (no struck-through row); here it was the only device.
    expect(html).not.toContain('account-devices-row--revoked');
    expect(html).toContain('No paired devices yet');
    // The confirm panel collapsed.
    expect(html).not.toContain('account-devices-confirm-row');
    expect(html).toContain('Done. That device can no longer reach this server.');
    expect(fakeHost.getFocusedTarget()).toEqual({ receipt: true });
    expect(mount.hasInFlightWork()).toBe(false);
  });

  it('pair.revoke failure keeps the confirm panel open + surfaces inline error', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [buildDevice({ instance_id: 'inst-A', display_name: 'Phone' })],
    }));
    const runPairRevoke = vi.fn(async () => {
      throw new Error('forbidden');
    });

    const mount = mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });
    await flush();

    fakeHost.clickAction('revoke-device', 'inst-A');
    fakeHost.clickAction('confirm-revoke', 'inst-A');
    await flush();

    const html = fakeHost.getHtml();
    // The confirm panel stays expanded for retry.
    expect(html).toContain('account-devices-confirm-row');
    expect(html).toContain('Recued could not shut this device out');
    expect(html).toContain('forbidden. Try again');
    expect(fakeHost.getFocusedAction()).toEqual({
      action: 'confirm-revoke',
      instanceId: 'inst-A',
    });
    expect(mount.hasInFlightWork()).toBe(false);
  });

  it('R30 defect #1 — a self-targeted revoke is refused at the handler (no rpc, no confirm)', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [
        buildDevice({ instance_id: 'inst-self', display_name: 'This' }),
        buildDevice({ instance_id: 'inst-other', display_name: 'Other' }),
      ],
    }));
    const runPairRevoke = vi.fn(async () => ({ ok: true as const }));

    mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      currentInstanceId: 'inst-self',
      now: () => FIXED_NOW,
    });
    await flush();

    // The renderer omits the button on the self row, but the guard is the
    // real defense: a stray click for our own instance opens no confirm…
    fakeHost.clickAction('revoke-device', 'inst-self');
    expect(fakeHost.getHtml()).not.toContain('account-devices-confirm-row');
    // …and a direct confirm-revoke on self never reaches the rpc.
    fakeHost.clickAction('confirm-revoke', 'inst-self');
    await flush();
    expect(runPairRevoke).not.toHaveBeenCalled();

    // A revoke of ANOTHER device still works normally.
    fakeHost.clickAction('revoke-device', 'inst-other');
    expect(fakeHost.getHtml()).toContain('account-devices-confirm-row');
    fakeHost.clickAction('confirm-revoke', 'inst-other');
    await flush();
    expect(runPairRevoke).toHaveBeenCalledWith({ instance_id: 'inst-other' });
  });
});

// ════════════════════════════════════════════════════════════════
// Lifecycle
// ════════════════════════════════════════════════════════════════

describe('mountDevicesPage — dispose', () => {
  it('dispose clears the host + detaches the click listener', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [buildDevice({ instance_id: 'inst-A' })],
    }));
    const runPairRevoke = vi.fn();

    const mount = mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });
    await flush();
    expect(fakeHost.listenerCount()).toBe(1);

    mount.dispose();
    expect(fakeHost.getHtml()).toBe('');
    expect(fakeHost.listenerCount()).toBe(0);

    // Idempotent — second dispose is a no-op.
    mount.dispose();
    expect(fakeHost.getHtml()).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════
// D-156 follow-on — live pair.list_changed subscription
// ════════════════════════════════════════════════════════════════

/** Fake `BroadcastSubscriber['on']` seam — captures listeners by kind so a
 *  test can fire an event + assert the subscribe / unsubscribe lifecycle. */
const makeFakeSubscribe = () => {
  const byKind = new Map<string, Set<(event: unknown) => void>>();
  let unsubscribeCalls = 0;
  const subscribe = ((kind: string, listener: (event: unknown) => void) => {
    let set = byKind.get(kind);
    if (!set) {
      set = new Set();
      byKind.set(kind, set);
    }
    set.add(listener);
    return () => {
      unsubscribeCalls += 1;
      byKind.get(kind)?.delete(listener);
    };
  }) as unknown as Parameters<typeof mountDevicesPage>[0]['subscribe'];
  return {
    subscribe,
    fire: (kind: string, event: unknown): void => {
      for (const fn of [...(byKind.get(kind) ?? [])]) fn(event);
    },
    listenerCount: (kind: string): number => byKind.get(kind)?.size ?? 0,
    unsubscribeCalls: (): number => unsubscribeCalls,
  };
};

describe('mountDevicesPage — live pair.list_changed subscription', () => {
  it('subscribes to pair.list_changed + re-fetches the roster on add + revoke events', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [buildDevice({ instance_id: 'inst-A' })],
    }));
    const sub = makeFakeSubscribe();

    const mount = mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke: vi.fn(),
      subscribe: sub.subscribe,
      now: () => FIXED_NOW,
    });
    await flush();
    // Initial mount fetch (DD#4) + exactly one pair.list_changed listener.
    expect(runPairList).toHaveBeenCalledTimes(1);
    expect(sub.listenerCount('pair.list_changed')).toBe(1);

    // A pair add on another client fires the event → roster re-fetch.
    sub.fire('pair.list_changed', { kind: 'pair.list_changed', op: 'added', cursor: 1 });
    await flush();
    expect(runPairList).toHaveBeenCalledTimes(2);

    // A revoke on another client re-fetches too.
    sub.fire('pair.list_changed', { kind: 'pair.list_changed', op: 'revoked', cursor: 2 });
    await flush();
    expect(runPairList).toHaveBeenCalledTimes(3);

    mount.dispose();
  });

  it('dispose() unsubscribes — a later event does not re-fetch', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({ devices: [] as ServerPairedDevice[] }));
    const sub = makeFakeSubscribe();

    const mount = mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke: vi.fn(),
      subscribe: sub.subscribe,
      now: () => FIXED_NOW,
    });
    await flush();
    expect(runPairList).toHaveBeenCalledTimes(1);

    mount.dispose();
    expect(sub.unsubscribeCalls()).toBe(1);
    expect(sub.listenerCount('pair.list_changed')).toBe(0);

    // Even if a stray event slips through after teardown, the listener is
    // gone (and refresh() also guards `disposed`), so no further fetch.
    sub.fire('pair.list_changed', { kind: 'pair.list_changed', op: 'added', cursor: 9 });
    await flush();
    expect(runPairList).toHaveBeenCalledTimes(1);
  });

  it('absent subscribe seam → mount fetches on mount only (no crash, no subscription)', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({ devices: [] as ServerPairedDevice[] }));

    const mount = mountDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke: vi.fn(),
      now: () => FIXED_NOW,
    });
    await flush();
    expect(runPairList).toHaveBeenCalledTimes(1);
    // Dispose stays clean with no subscription to tear down.
    expect(() => mount.dispose()).not.toThrow();
  });
});
