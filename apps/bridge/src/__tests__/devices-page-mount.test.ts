/** D-156 P6 — Bridge Devices page mount tests.
 *
 *  Mirror of `apps/webclient/src/__tests__/d-156-phase-5-devices-page-
 *  mount.test.ts`, retargeted at the bridge surface. Same fake-host
 *  pattern, same rpc-caller injection, same state-machine coverage.
 *  Differs from the webclient suite in the asserted default kind
 *  label (`Bridge` here vs `Webclient` there) per DD#1 of the mount
 *  module.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ServerPairedDevice } from '@recued/contracts';

import { mountBridgeDevicesPage } from '../pairing/devices-page-mount.js';

// ════════════════════════════════════════════════════════════════
// Fake host
// ════════════════════════════════════════════════════════════════

const makeFakeHost = () => {
  let html = '';
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
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
  display_name: 'Bridge laptop',
  kind: 'bridge',
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

describe('mountBridgeDevicesPage — initial render + roster fetch', () => {
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

    const mount = mountBridgeDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });

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
        buildDevice({ instance_id: 'inst-A', display_name: 'Bridge laptop' }),
        buildDevice({
          instance_id: 'inst-B',
          display_name: 'Old bridge',
          connected: false,
          connected_at: undefined,
          revoked_at: 1_950_000,
        }),
      ],
    }));
    const runPairRevoke = vi.fn();

    mountBridgeDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });

    await flush();
    const html = fakeHost.getHtml();
    expect(html).toContain('Bridge laptop');
    expect(html).toContain('Online now');
    // R30 — the revoked device drops off the active roster.
    expect(html).not.toContain('Old bridge');
    expect(html).not.toContain('Revoked');
    // buildDevice defaults kind to 'bridge'.
    expect(html).toMatch(/\(Browser Bridge\)/);
  });

  it('D-156 P10 — renders the per-device kind label from the row (not a hard-coded bridge)', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [
        buildDevice({ instance_id: 'wc', display_name: 'Phone', kind: 'webclient' }),
        buildDevice({ instance_id: 'br', display_name: 'Laptop', kind: 'bridge' }),
        buildDevice({ instance_id: 'cl', display_name: 'Server', kind: 'cli' }),
      ],
    }));

    mountBridgeDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke: vi.fn(),
      now: () => FIXED_NOW,
    });

    await flush();
    const html = fakeHost.getHtml();
    // The bridge shows the whole roster, so a webclient row must
    // render "(Browser)" — proving device.kind is honoured, not a
    // hard-coded 'bridge'.
    expect(html).toMatch(/\(Browser\)/);
    expect(html).toMatch(/\(Browser Bridge\)/);
    expect(html).toMatch(/\(Command line\)/);
  });

  it('surfaces a list error when pair.list rejects + fires onListError', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => {
      throw new Error('network down');
    });
    const runPairRevoke = vi.fn();
    const onListError = vi.fn();

    mountBridgeDevicesPage({
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

  it('passes currentInstanceId through for self-revoke gating', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [
        buildDevice({ instance_id: 'inst-self', display_name: 'This bridge' }),
        buildDevice({ instance_id: 'inst-other', display_name: 'Other bridge' }),
      ],
    }));
    const runPairRevoke = vi.fn();

    mountBridgeDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      currentInstanceId: 'inst-self',
      now: () => FIXED_NOW,
    });

    await flush();
    const html = fakeHost.getHtml();
    expect(html).toContain('account-devices-row--current');
    expect(html).toContain('account-devices-action-placeholder');
    expect(html).toMatch(
      /data-action="revoke-device"[^>]*data-instance-id="inst-other"/,
    );
  });
});

// ════════════════════════════════════════════════════════════════
// Revoke state machine
// ════════════════════════════════════════════════════════════════

describe('mountBridgeDevicesPage — two-stage revoke confirm', () => {
  it('clicking Revoke opens the confirm panel for that row only', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [
        buildDevice({ instance_id: 'inst-A', display_name: 'A' }),
        buildDevice({ instance_id: 'inst-B', display_name: 'B' }),
      ],
    }));
    const runPairRevoke = vi.fn();

    mountBridgeDevicesPage({
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
    expect(html).toMatch(/confirm-row[^>]*data-instance-id="inst-A"/);
    expect(html).not.toMatch(/confirm-row[^>]*data-instance-id="inst-B"/);
  });

  it('clicking Revoke on a second row collapses the first confirm', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [
        buildDevice({ instance_id: 'inst-A', display_name: 'A' }),
        buildDevice({ instance_id: 'inst-B', display_name: 'B' }),
      ],
    }));
    const runPairRevoke = vi.fn();

    mountBridgeDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });
    await flush();

    fakeHost.clickAction('revoke-device', 'inst-A');
    expect(fakeHost.getHtml()).toMatch(/confirm-row[^>]*data-instance-id="inst-A"/);
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

    mountBridgeDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });
    await flush();

    fakeHost.clickAction('revoke-device', 'inst-A');
    expect(fakeHost.getHtml()).toContain('account-devices-confirm-row');
    fakeHost.clickAction('cancel-revoke', 'inst-A');
    expect(fakeHost.getHtml()).not.toContain('account-devices-confirm-row');
    expect(runPairRevoke).not.toHaveBeenCalled();
  });

  it('"Yes, revoke" calls pair.revoke + refreshes roster on success', async () => {
    const fakeHost = makeFakeHost();
    let listCallCount = 0;
    const runPairList = vi.fn(async () => {
      listCallCount++;
      return {
        devices:
          listCallCount === 1
            ? [buildDevice({ instance_id: 'inst-A', display_name: 'A' })]
            : [
                buildDevice({
                  instance_id: 'inst-A',
                  display_name: 'A',
                  revoked_at: 1_999_999,
                  connected: false,
                  connected_at: undefined,
                }),
              ],
      };
    });
    const runPairRevoke = vi.fn(async () => ({ ok: true as const }));

    mountBridgeDevicesPage({
      host: fakeHost.host,
      runPairList,
      runPairRevoke,
      now: () => FIXED_NOW,
    });
    await flush();

    fakeHost.clickAction('revoke-device', 'inst-A');
    fakeHost.clickAction('confirm-revoke', 'inst-A');
    await flush();
    await flush();

    expect(runPairRevoke).toHaveBeenCalledWith({ instance_id: 'inst-A' });
    expect(listCallCount).toBeGreaterThanOrEqual(2);
    const html = fakeHost.getHtml();
    // R30 — after the refresh the now-revoked device drops off the roster
    // entirely (no struck-through row); here it was the only device.
    expect(html).not.toContain('account-devices-row--revoked');
    expect(html).toContain('No paired devices yet');
    expect(html).not.toContain('account-devices-confirm-row');
  });

  it('pair.revoke failure keeps the confirm panel open + surfaces inline error', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [buildDevice({ instance_id: 'inst-A', display_name: 'A' })],
    }));
    const runPairRevoke = vi.fn(async () => {
      throw new Error('forbidden');
    });

    mountBridgeDevicesPage({
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
    expect(html).toContain('account-devices-confirm-row');
    expect(html).toContain('Could not revoke this device');
    expect(html).toContain('forbidden');
  });
});

// ════════════════════════════════════════════════════════════════
// Lifecycle
// ════════════════════════════════════════════════════════════════

describe('mountBridgeDevicesPage — dispose', () => {
  it('dispose clears the host + detaches the click listener', async () => {
    const fakeHost = makeFakeHost();
    const runPairList = vi.fn(async () => ({
      devices: [buildDevice({ instance_id: 'inst-A' })],
    }));
    const runPairRevoke = vi.fn();

    const mount = mountBridgeDevicesPage({
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

    mount.dispose();
    expect(fakeHost.getHtml()).toBe('');
  });
});
