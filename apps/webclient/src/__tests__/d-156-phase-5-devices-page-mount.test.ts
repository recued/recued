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

import { mountDevicesPage, type PairListCaller } from '../settings/devices-page-mount.js';

// ════════════════════════════════════════════════════════════════
// Fake host
// ════════════════════════════════════════════════════════════════

const makeFakeHost = () => {
  let html = '';
  let focusedTarget:
    | { action: string; instanceId: string }
    | { receipt: true }
    | { renameInput: true }
    | { outside: true }
    | undefined;
  /** What the owner has typed in the rename field (the live input value). */
  let renameValue: string | undefined;
  const body = {} as HTMLElement;
  const outside = {} as HTMLElement;
  const fakeDocument = {
    get activeElement() {
      const target = focusedTarget;
      if (target === undefined) return body;
      if ('outside' in target) return outside;
      if ('receipt' in target) return {
        hasAttribute: (name: string) => name === 'data-device-revoke-success',
      } as unknown as HTMLElement;
      if ('renameInput' in target) return {
        hasAttribute: (name: string) => name === 'data-rename-input',
        getAttribute: () => null,
      } as unknown as HTMLElement;
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
      if (!html.includes('data-rename-input')) renameValue = undefined;
      if (focusedTarget === undefined || !('outside' in focusedTarget)) focusedTarget = undefined;
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
      if (selector === '[data-rename-input]') {
        const input = /<input\b[^>]*data-rename-input[^>]*>/.exec(html)?.[0];
        if (input === undefined) return null;
        const written = /value="([^"]*)"/.exec(input)?.[1] ?? '';
        return {
          get value() { return renameValue ?? written; },
          focus: () => { focusedTarget = { renameInput: true }; },
          select: () => {},
          setSelectionRange: () => {},
        } as unknown as HTMLElement;
      }
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
    focusAction: (action: string, instanceId?: string): void => {
      const button = [...host.querySelectorAll<HTMLElement>(`[data-action="${action}"]`)]
        .find(candidate => instanceId === undefined || candidate.getAttribute('data-instance-id') === instanceId);
      if (button === undefined) throw new Error(`Missing ${action} button`);
      button.focus();
    },
    focusOutside: (): void => { focusedTarget = { outside: true }; },
    typeRename: (value: string): void => { renameValue = value; },
    submitRename: (instanceId: string): void => {
      fire('submit', {
        hasAttribute: (name: string) => name === 'data-rename-form',
        getAttribute: (name: string) => (name === 'data-instance-id' ? instanceId : null),
      });
    },
    pressEscape: (): void => {
      for (const fn of [...(listeners.keydown ?? [])]) {
        fn({
          key: 'Escape',
          type: 'keydown',
          stopPropagation: () => {},
          target: { hasAttribute: () => false, getAttribute: () => null },
        } as unknown as Event);
      }
    },
    escapeRename: (instanceId: string): void => {
      for (const fn of [...(listeners.keydown ?? [])]) {
        fn({
          key: 'Escape',
          type: 'keydown',
          stopPropagation: () => {},
          target: {
            hasAttribute: (name: string) => name === 'data-rename-input',
            getAttribute: (name: string) => (name === 'data-instance-id' ? instanceId : null),
          },
        } as unknown as Event);
      }
    },
    renameInputFocused: (): boolean =>
      focusedTarget !== undefined && 'renameInput' in focusedTarget,
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

const deferredList = () => {
  let resolve!: (value: Awaited<ReturnType<PairListCaller>>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Awaited<ReturnType<PairListCaller>>>((done, fail) => {
    resolve = done; reject = fail;
  });
  return { promise, resolve, reject };
};

const settleList = (read: ReturnType<typeof deferredList>, outcome: 'success' | 'failure'): void => {
  if (outcome === 'success') read.resolve({ devices: [buildDevice({ display_name: 'Older phone' })] });
  else read.reject(new Error('Older list unavailable'));
};

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
    expect(html).toMatch(/\(Browser\)/);
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

  it('does not call a list that never loaded empty', async () => {
    // ⛔ Under "Couldn't load paired devices" it read "No paired devices yet."
    // — a claim about the server the page had not been able to check.
    const fakeHost = makeFakeHost();
    mountDevicesPage({
      host: fakeHost.host,
      runPairList: vi.fn(async () => { throw new Error('network down'); }),
      runPairRevoke: vi.fn(),
      now: () => FIXED_NOW,
    });
    await flush();
    expect(fakeHost.getHtml()).toContain('data-error="list"');
    expect(fakeHost.getHtml()).not.toContain('No paired devices yet');
    expect(fakeHost.getHtml()).not.toContain('account-devices-table');
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
    // ⛔ With no Revoke on its own row, the page says where this browser can
    // revoke its own access, instead of claiming that it cannot.
    expect(html).toContain(
      'To revoke this browser’s own access, open Account &amp; servers and choose Forget.',
    );
    expect(html).not.toContain('cannot remove itself');
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
    expect(html).toContain('Recued could not revoke this device');
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
    // Click, plus the rename form's submit and Escape.
    expect(fakeHost.listenerCount()).toBe(3);

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

describe('mountDevicesPage — overlapping roster refreshes', () => {
  it.each([
    { older: 'success', newer: 'success' },
    { older: 'failure', newer: 'success' },
    { older: 'success', newer: 'failure' },
    { older: 'failure', newer: 'failure' },
  ] as const)('keeps the newer $newer after an older $older arrives late', async ({ older, newer }) => {
    const fakeHost = makeFakeHost(); const first = deferredList(); const second = deferredList();
    const onListError = vi.fn();
    const runPairList = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke: vi.fn(), onListError });
    try {
      const latest = mount.refresh();
      if (newer === 'success') second.resolve({ devices: [buildDevice({ instance_id: 'new-device', display_name: 'Current tablet' })] });
      else second.reject(new Error('Latest list unavailable'));
      await latest;
      if (newer === 'success') fakeHost.clickAction('revoke-device', 'new-device');
      const html = fakeHost.getHtml(); const focus = fakeHost.getFocusedTarget();
      expect(html).toContain(newer === 'success' ? 'Current tablet' : 'data-error="list"');
      settleList(first, older); await flush();
      expect(fakeHost.getHtml()).toBe(html);
      expect(fakeHost.getFocusedTarget()).toEqual(focus);
      expect(fakeHost.getHtml()).not.toContain('Older phone');
      expect(onListError).toHaveBeenCalledTimes(newer === 'failure' ? 1 : 0);
      expect(runPairList).toHaveBeenCalledTimes(2);
    } finally { mount.dispose(); }
  });

  it.each(['success', 'failure'] as const)('keeps the newest read pending after an older %s', async outcome => {
    const fakeHost = makeFakeHost(); const first = deferredList(); const second = deferredList();
    const onListError = vi.fn();
    const runPairList = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke: vi.fn(), onListError });
    try {
      const latest = mount.refresh();
      settleList(first, outcome); await flush();
      expect(fakeHost.getHtml()).toContain('Loading devices…');
      expect(fakeHost.getHtml()).not.toContain('Older phone');
      expect(fakeHost.getHtml()).not.toContain('data-error="list"');
      expect(onListError).not.toHaveBeenCalled();
      second.resolve({ devices: [] }); await latest;
      expect(fakeHost.getHtml()).toContain('No paired devices yet.');
      expect(fakeHost.getHtml()).not.toContain('Loading devices…');
    } finally { mount.dispose(); }
  });

  it.each(['success', 'failure'] as const)('ignores a Retry %s superseded by a roster broadcast', async outcome => {
    const fakeHost = makeFakeHost(); const retry = deferredList(); const broadcast = deferredList();
    const sub = makeFakeSubscribe(); const onListError = vi.fn();
    const runPairList = vi.fn().mockRejectedValueOnce(new Error('Initial list unavailable'))
      .mockReturnValueOnce(retry.promise).mockReturnValueOnce(broadcast.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke: vi.fn(), subscribe: sub.subscribe, onListError });
    try {
      await flush(); fakeHost.clickAction('retry-list'); fakeHost.clickAction('retry-list');
      expect(runPairList).toHaveBeenCalledTimes(2);
      sub.fire('pair.list_changed', { kind: 'pair.list_changed', op: 'added', cursor: 1 });
      expect(runPairList).toHaveBeenCalledTimes(3);
      broadcast.resolve({ devices: [buildDevice({ instance_id: 'new-device', display_name: 'Current tablet' })] });
      await flush(); fakeHost.clickAction('revoke-device', 'new-device');
      const html = fakeHost.getHtml(); const focus = fakeHost.getFocusedTarget();
      settleList(retry, outcome); await flush();
      expect(fakeHost.getHtml()).toBe(html);
      expect(fakeHost.getFocusedTarget()).toEqual(focus);
      expect(fakeHost.getHtml()).not.toContain('data-error="list"');
      expect(onListError).toHaveBeenCalledTimes(1);
    } finally { mount.dispose(); }
  });

  it.each([
    { outcome: 'success', late: false }, { outcome: 'failure', late: false },
    { outcome: 'success', late: true }, { outcome: 'failure', late: true },
  ] as const)('keeps a revoke receipt through an older $outcome (late: $late)', async ({ outcome, late }) => {
    const fakeHost = makeFakeHost(); const older = deferredList(); const reconcile = deferredList();
    const onListError = vi.fn(); const runPairRevoke = vi.fn(async () => ({ ok: true as const }));
    const runPairList = vi.fn().mockResolvedValueOnce({ devices: [buildDevice({ display_name: 'Phone to revoke' })] })
      .mockReturnValueOnce(older.promise).mockReturnValueOnce(reconcile.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke, onListError });
    try {
      await flush(); const backgroundRead = mount.refresh();
      fakeHost.clickAction('revoke-device', 'inst-A'); fakeHost.clickAction('confirm-revoke', 'inst-A');
      await flush();
      expect(runPairList).toHaveBeenCalledTimes(3);
      expect(mount.hasInFlightWork()).toBe(true);
      expect(fakeHost.getHtml()).toContain('Done. That device can no longer reach this server.');
      if (!late) {
        settleList(older, outcome); await backgroundRead;
        expect(mount.hasInFlightWork()).toBe(true);
        expect(fakeHost.getHtml()).toContain('Loading devices…');
        expect(fakeHost.getFocusedTarget()).toEqual({ receipt: true });
      }
      reconcile.resolve({ devices: [buildDevice({ revoked_at: 1_999_999 })] }); await flush();
      expect(mount.hasInFlightWork()).toBe(false);
      expect(fakeHost.getHtml()).toContain('No paired devices yet.');
      const html = fakeHost.getHtml();
      if (late) { settleList(older, outcome); await backgroundRead; }
      expect(fakeHost.getHtml()).toBe(html);
      expect(fakeHost.getFocusedTarget()).toEqual({ receipt: true });
      expect(onListError).not.toHaveBeenCalled();
      expect(runPairRevoke).toHaveBeenCalledExactlyOnceWith({ instance_id: 'inst-A' });
    } finally { mount.dispose(); }
  });

  it.each([
    { older: 'success', newer: 'success', newerFirst: true },
    { older: 'failure', newer: 'success', newerFirst: true },
    { older: 'success', newer: 'failure', newerFirst: true },
    { older: 'failure', newer: 'failure', newerFirst: true },
    { older: 'success', newer: 'success', newerFirst: false },
    { older: 'failure', newer: 'success', newerFirst: false },
    { older: 'success', newer: 'failure', newerFirst: false },
    { older: 'failure', newer: 'failure', newerFirst: false },
  ] as const)('settles a revoke from the newest $newer, older $older (newer first: $newerFirst)', async ({ older, newer, newerFirst }) => {
    const fakeHost = makeFakeHost(); const originalRead = deferredList(); const currentRead = deferredList();
    const sub = makeFakeSubscribe(); const onListError = vi.fn();
    const otherDevice = buildDevice({ instance_id: 'inst-B', display_name: 'Other tablet' });
    const runPairList = vi.fn().mockResolvedValueOnce({ devices: [buildDevice({}), otherDevice] })
      .mockReturnValueOnce(originalRead.promise).mockReturnValueOnce(currentRead.promise);
    const runPairRevoke = vi.fn(async () => ({ ok: true as const }));
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke, subscribe: sub.subscribe, onListError });
    try {
      await flush(); fakeHost.clickAction('revoke-device', 'inst-A'); fakeHost.clickAction('confirm-revoke', 'inst-A');
      await flush();
      sub.fire('pair.list_changed', { kind: 'pair.list_changed', op: 'revoked', cursor: 2 });
      expect(runPairList).toHaveBeenCalledTimes(3);
      if (!newerFirst) {
        settleList(originalRead, older); await flush();
        expect(mount.hasInFlightWork()).toBe(true);
        expect(fakeHost.getHtml()).toContain('Loading devices…');
      }
      if (newer === 'success') currentRead.resolve({ devices: [otherDevice] });
      else currentRead.reject(new Error('Latest list unavailable'));
      await flush();
      expect(mount.hasInFlightWork()).toBe(false);
      expect(fakeHost.getFocusedTarget()).toEqual({ receipt: true });
      fakeHost.clickAction('revoke-device', 'inst-B');
      expect(fakeHost.getFocusedAction()).toEqual({ action: 'cancel-revoke', instanceId: 'inst-B' });
      const html = fakeHost.getHtml(); const focus = fakeHost.getFocusedTarget();
      if (newerFirst) { settleList(originalRead, older); await flush(); }
      expect(fakeHost.getHtml()).toBe(html);
      expect(fakeHost.getFocusedTarget()).toEqual(focus);
      expect(onListError).toHaveBeenCalledTimes(newer === 'failure' ? 1 : 0);
      expect(runPairRevoke).toHaveBeenCalledExactlyOnceWith({ instance_id: 'inst-A' });
    } finally { mount.dispose(); }
  });

  it.each(['success', 'failure'] as const)('keeps the next revoke busy after an obsolete %s from the previous revoke', async outcome => {
    const fakeHost = makeFakeHost(); const originalRead = deferredList(); const currentRead = deferredList();
    const sub = makeFakeSubscribe(); const otherDevice = buildDevice({ instance_id: 'inst-B' });
    let finishSecondCommand!: (value: { ok: true }) => void;
    const secondCommand = new Promise<{ ok: true }>(resolve => { finishSecondCommand = resolve; });
    const runPairRevoke = vi.fn().mockResolvedValueOnce({ ok: true }).mockReturnValueOnce(secondCommand);
    const runPairList = vi.fn().mockResolvedValueOnce({ devices: [buildDevice({}), otherDevice] })
      .mockReturnValueOnce(originalRead.promise).mockReturnValueOnce(currentRead.promise).mockResolvedValueOnce({ devices: [] });
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke, subscribe: sub.subscribe });
    try {
      await flush(); fakeHost.clickAction('revoke-device', 'inst-A'); fakeHost.clickAction('confirm-revoke', 'inst-A');
      await flush(); sub.fire('pair.list_changed', { kind: 'pair.list_changed', op: 'revoked', cursor: 2 });
      currentRead.resolve({ devices: [otherDevice] }); await flush();
      expect(mount.hasInFlightWork()).toBe(false);
      fakeHost.clickAction('revoke-device', 'inst-B'); fakeHost.clickAction('confirm-revoke', 'inst-B');
      expect(runPairRevoke).toHaveBeenCalledTimes(2);
      const html = fakeHost.getHtml();
      settleList(originalRead, outcome); await flush();
      expect(mount.hasInFlightWork()).toBe(true);
      expect(fakeHost.getHtml()).toBe(html);
      expect(fakeHost.getFocusedAction()).toEqual({ action: 'confirm-revoke', instanceId: 'inst-B' });
      finishSecondCommand({ ok: true }); await flush();
      expect(mount.hasInFlightWork()).toBe(false);
      expect(fakeHost.getHtml()).toContain('No paired devices yet.');
      expect(runPairRevoke).toHaveBeenNthCalledWith(2, { instance_id: 'inst-B' });
    } finally { mount.dispose(); }
  });

  it.each(['success', 'failure'] as const)('ignores overlapping %s completions after disposal', async outcome => {
    const fakeHost = makeFakeHost(); const first = deferredList(); const second = deferredList();
    const onListError = vi.fn();
    const runPairList = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke: vi.fn(), onListError });
    const latest = mount.refresh(); mount.dispose();
    settleList(second, outcome); await latest; settleList(first, outcome); await flush(); await mount.refresh();
    expect(fakeHost.getHtml()).toBe('');
    expect(onListError).not.toHaveBeenCalled();
    expect(runPairList).toHaveBeenCalledTimes(2);
  });
});

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

const checkedAt = (html: string): string | undefined =>
  /<time datetime="([^"]+)"/.exec(html)?.[1];

describe('mountDevicesPage — manual refresh and last successful check', () => {
  it('completes refresh and revoke reconciliation when locale APIs fail', async () => {
    const intl = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new RangeError('Locale unavailable'); });
    const locale = vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(() => { throw new Error('Locale blocked'); });
    const fakeHost = makeFakeHost(); let now = FIXED_NOW;
    let devices = [buildDevice({})];
    const runPairList = vi.fn(async () => ({ devices }));
    const runPairRevoke = vi.fn(async () => { devices = []; return { ok: true as const }; });
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke, now: () => now });
    try {
      await flush(); expect(checkedAt(fakeHost.getHtml())).toBe(new Date(now).toISOString());
      expect(fakeHost.getHtml()).toContain('Unknown time');
      now += 1_000; fakeHost.clickAction('refresh-devices'); await flush();
      expect(checkedAt(fakeHost.getHtml())).toBe(new Date(now).toISOString());
      expect(fakeHost.getHtml()).not.toContain('Refreshing…');
      fakeHost.clickAction('revoke-device', 'inst-A'); fakeHost.clickAction('confirm-revoke', 'inst-A');
      await flush();
      expect(mount.hasInFlightWork()).toBe(false);
      expect(fakeHost.getHtml()).toContain('No paired devices yet.');
      expect(fakeHost.getHtml()).toContain('Done. That device can no longer reach this server.');
      expect(runPairList).toHaveBeenCalledTimes(3);
      expect(runPairRevoke).toHaveBeenCalledOnce();
    } finally { mount.dispose(); intl.mockRestore(); locale.mockRestore(); }
  });

  it('checks presence once per activation and stamps completion rather than dispatch', async () => {
    const fakeHost = makeFakeHost();
    const initial = deferredList(); const manual = deferredList();
    let now = FIXED_NOW;
    const runPairList = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(manual.promise);
    const runPairRevoke = vi.fn();
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke, now: () => now });
    try {
      expect(fakeHost.getHtml()).toContain('Not checked yet');
      expect(checkedAt(fakeHost.getHtml())).toBeUndefined();
      fakeHost.clickAction('refresh-devices');
      expect(runPairList).toHaveBeenCalledTimes(1);
      now += 1_000;
      initial.resolve({ devices: [buildDevice({ connected: false })] }); await flush();
      const firstTime = new Date(now).toISOString();
      expect(checkedAt(fakeHost.getHtml())).toBe(firstTime);
      expect(fakeHost.getHtml()).toContain('Offline');

      now += 1_000;
      fakeHost.clickAction('refresh-devices');
      expect(fakeHost.getHtml()).toContain('Refreshing…');
      expect(fakeHost.getHtml()).toContain('Offline');
      expect(checkedAt(fakeHost.getHtml())).toBe(firstTime);
      expect(fakeHost.getFocusedAction()).toEqual({ action: 'refresh-devices', instanceId: '' });
      fakeHost.clickAction('refresh-devices'); fakeHost.clickAction('refresh-devices');
      expect(runPairList).toHaveBeenCalledTimes(2);
      expect(mount.hasInFlightWork()).toBe(false);
      now += 1_000;
      manual.resolve({ devices: [buildDevice({ connected: true })] }); await flush();
      expect(fakeHost.getHtml()).toContain('Online now');
      expect(fakeHost.getHtml()).not.toContain('Refreshing…');
      expect(checkedAt(fakeHost.getHtml())).toBe(new Date(now).toISOString());
      expect(fakeHost.getFocusedAction()).toEqual({ action: 'refresh-devices', instanceId: '' });
      expect(runPairRevoke).not.toHaveBeenCalled();
    } finally { mount.dispose(); }
  });

  it('retains successful rows and their check time through a failed refresh and Retry', async () => {
    const fakeHost = makeFakeHost(); const manual = deferredList(); const retry = deferredList();
    let now = FIXED_NOW;
    const onListError = vi.fn();
    const runPairList = vi.fn().mockResolvedValueOnce({ devices: [buildDevice({ connected: false })] })
      .mockReturnValueOnce(manual.promise).mockReturnValueOnce(retry.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke: vi.fn(), now: () => now, onListError });
    try {
      await flush(); const firstTime = checkedAt(fakeHost.getHtml());
      expect(firstTime).toBe(new Date(now).toISOString());
      now += 10_000; fakeHost.clickAction('refresh-devices');
      manual.reject(new Error('Connection interrupted')); await flush();
      expect(fakeHost.getHtml()).toContain('data-error="list"');
      expect(fakeHost.getHtml()).toContain('Offline');
      expect(checkedAt(fakeHost.getHtml())).toBe(firstTime);
      expect(fakeHost.getFocusedAction()).toEqual({ action: 'refresh-devices', instanceId: '' });
      fakeHost.clickAction('retry-list'); fakeHost.clickAction('refresh-devices');
      expect(runPairList).toHaveBeenCalledTimes(3);
      expect(checkedAt(fakeHost.getHtml())).toBe(firstTime);
      now += 10_000; retry.resolve({ devices: [buildDevice({ connected: true })] }); await flush();
      expect(fakeHost.getHtml()).not.toContain('data-error="list"');
      expect(checkedAt(fakeHost.getHtml())).toBe(new Date(now).toISOString());
      expect(fakeHost.getFocusedAction()).toEqual({ action: 'revoke-device', instanceId: 'inst-A' });
      expect(onListError).toHaveBeenCalledOnce();
    } finally { mount.dispose(); }
  });

  it('offers Refresh after an initial failure without inventing a successful check', async () => {
    const fakeHost = makeFakeHost(); const manual = deferredList();
    const runPairList = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockReturnValueOnce(manual.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke: vi.fn(), now: () => FIXED_NOW });
    try {
      await flush();
      expect(fakeHost.getHtml()).toContain('Not checked yet');
      expect(checkedAt(fakeHost.getHtml())).toBeUndefined();
      fakeHost.clickAction('refresh-devices');
      manual.resolve({ devices: [] }); await flush();
      expect(fakeHost.getHtml()).toContain('No paired devices yet.');
      expect(checkedAt(fakeHost.getHtml())).toBe(new Date(FIXED_NOW).toISOString());
      expect(fakeHost.getFocusedAction()).toEqual({ action: 'refresh-devices', instanceId: '' });
    } finally { mount.dispose(); }
  });

  it.each([
    { newer: 'success', newerFirst: true }, { newer: 'failure', newerFirst: true },
    { newer: 'success', newerFirst: false }, { newer: 'failure', newerFirst: false },
  ] as const)('stamps only the accepted $newer read (newer first: $newerFirst)', async ({ newer, newerFirst }) => {
    const fakeHost = makeFakeHost(); const manual = deferredList(); const broadcast = deferredList();
    const sub = makeFakeSubscribe(); let now = FIXED_NOW;
    const runPairList = vi.fn().mockResolvedValueOnce({ devices: [buildDevice({})] })
      .mockReturnValueOnce(manual.promise).mockReturnValueOnce(broadcast.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke: vi.fn(), now: () => now, subscribe: sub.subscribe });
    try {
      await flush(); const firstTime = new Date(now).toISOString();
      fakeHost.clickAction('refresh-devices');
      sub.fire('pair.list_changed', { kind: 'pair.list_changed', op: 'added', cursor: 1 });
      if (!newerFirst) {
        now += 1_000; manual.resolve({ devices: [] }); await flush();
        expect(checkedAt(fakeHost.getHtml())).toBe(firstTime);
        expect(fakeHost.getHtml()).toContain('Refreshing…');
      }
      now += 2_000;
      if (newer === 'success') broadcast.resolve({ devices: [buildDevice({})] });
      else broadcast.reject(new Error('Latest read unavailable'));
      await flush();
      const acceptedTime = newer === 'success' ? new Date(now).toISOString() : firstTime;
      expect(checkedAt(fakeHost.getHtml())).toBe(acceptedTime);
      if (newerFirst) { now += 3_000; manual.resolve({ devices: [] }); await flush(); }
      expect(checkedAt(fakeHost.getHtml())).toBe(acceptedTime);
      expect(fakeHost.getHtml()).not.toContain('Refreshing…');
      expect(runPairList).toHaveBeenCalledTimes(3);
    } finally { mount.dispose(); }
  });

  it.each([
    { action: 'cancel-revoke', outcome: 'success' }, { action: 'confirm-revoke', outcome: 'success' },
    { action: 'cancel-revoke', outcome: 'failure' }, { action: 'confirm-revoke', outcome: 'failure' },
  ] as const)('keeps $action focused through a background $outcome', async ({ action, outcome }) => {
    const fakeHost = makeFakeHost(); const background = deferredList(); const runPairRevoke = vi.fn();
    const runPairList = vi.fn().mockResolvedValueOnce({ devices: [buildDevice({})] }).mockReturnValueOnce(background.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke });
    try {
      await flush(); fakeHost.clickAction('revoke-device', 'inst-A'); fakeHost.focusAction(action, 'inst-A');
      const read = mount.refresh();
      expect(fakeHost.getFocusedAction()).toEqual({ action, instanceId: 'inst-A' });
      settleList(background, outcome); await read;
      expect(fakeHost.getFocusedAction()).toEqual({ action, instanceId: 'inst-A' });
      expect(fakeHost.getHtml()).toContain('role="alertdialog"');
      expect(runPairRevoke).not.toHaveBeenCalled();
    } finally { mount.dispose(); }
  });

  it.each(['confirmation', 'outside'] as const)('respects focus moved to %s while a manual refresh is pending', async owner => {
    const fakeHost = makeFakeHost(); const manual = deferredList();
    const runPairList = vi.fn().mockResolvedValueOnce({ devices: [buildDevice({})] }).mockReturnValueOnce(manual.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke: vi.fn() });
    try {
      await flush(); fakeHost.clickAction('refresh-devices');
      if (owner === 'confirmation') fakeHost.clickAction('revoke-device', 'inst-A');
      else fakeHost.focusOutside();
      const focus = fakeHost.getFocusedTarget();
      manual.resolve({ devices: [buildDevice({})] }); await flush();
      expect(fakeHost.getFocusedTarget()).toEqual(focus);
    } finally { mount.dispose(); }
  });

  it('returns focus to Refresh if a background read removes the reviewed device', async () => {
    const fakeHost = makeFakeHost(); const background = deferredList();
    const runPairList = vi.fn().mockResolvedValueOnce({ devices: [buildDevice({})] }).mockReturnValueOnce(background.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke: vi.fn() });
    try {
      await flush(); fakeHost.clickAction('revoke-device', 'inst-A');
      const read = mount.refresh(); background.resolve({ devices: [] }); await read;
      expect(fakeHost.getHtml()).not.toContain('role="alertdialog"');
      expect(fakeHost.getFocusedAction()).toEqual({ action: 'refresh-devices', instanceId: '' });
    } finally { mount.dispose(); }
  });

  it('keeps a confirmed revoke pending across a manual refresh of presence', async () => {
    const fakeHost = makeFakeHost(); const manual = deferredList(); const reconciliation = deferredList();
    let finishRevoke!: (value: { ok: true }) => void;
    const command = new Promise<{ ok: true }>(resolve => { finishRevoke = resolve; });
    const runPairRevoke = vi.fn(() => command);
    const runPairList = vi.fn().mockResolvedValueOnce({ devices: [buildDevice({})] })
      .mockReturnValueOnce(manual.promise).mockReturnValueOnce(reconciliation.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke });
    try {
      await flush(); fakeHost.clickAction('revoke-device', 'inst-A'); fakeHost.clickAction('confirm-revoke', 'inst-A');
      fakeHost.clickAction('refresh-devices');
      expect(mount.hasInFlightWork()).toBe(true);
      fakeHost.clickAction('confirm-revoke', 'inst-A');
      manual.resolve({ devices: [buildDevice({})] }); await flush();
      expect(mount.hasInFlightWork()).toBe(true);
      expect(fakeHost.getHtml()).toContain('Revoking…');
      finishRevoke({ ok: true }); await flush();
      expect(mount.hasInFlightWork()).toBe(true);
      expect(fakeHost.getFocusedAction()).toEqual({ action: 'refresh-devices', instanceId: '' });
      reconciliation.resolve({ devices: [] }); await flush();
      expect(mount.hasInFlightWork()).toBe(false);
      expect(fakeHost.getFocusedAction()).toEqual({ action: 'refresh-devices', instanceId: '' });
      expect(fakeHost.getHtml()).toContain('Done. That device can no longer reach this server.');
      expect(runPairRevoke).toHaveBeenCalledExactlyOnceWith({ instance_id: 'inst-A' });
      expect(runPairList).toHaveBeenCalledTimes(3);
    } finally { mount.dispose(); }
  });

  it('keeps Refresh focused if a pending revoke fails during a manual check', async () => {
    const fakeHost = makeFakeHost(); const manual = deferredList();
    let failRevoke!: (error: Error) => void;
    const command = new Promise<{ ok: true }>((_resolve, reject) => { failRevoke = reject; });
    const runPairList = vi.fn().mockResolvedValueOnce({ devices: [buildDevice({})] }).mockReturnValueOnce(manual.promise);
    const mount = mountDevicesPage({ host: fakeHost.host, runPairList, runPairRevoke: () => command });
    try {
      await flush(); fakeHost.clickAction('revoke-device', 'inst-A'); fakeHost.clickAction('confirm-revoke', 'inst-A');
      fakeHost.clickAction('refresh-devices');
      failRevoke(new Error('Revoke unavailable')); await flush();
      expect(mount.hasInFlightWork()).toBe(false);
      expect(fakeHost.getHtml()).toContain('Revoke unavailable');
      expect(fakeHost.getFocusedAction()).toEqual({ action: 'refresh-devices', instanceId: '' });
      manual.resolve({ devices: [buildDevice({})] }); await flush();
      expect(fakeHost.getFocusedAction()).toEqual({ action: 'refresh-devices', instanceId: '' });
    } finally { mount.dispose(); }
  });
});

// ⛔ There was no rename: two browsers of one kind read alike here ("Chrome
// on macOS"), and which one to revoke was a guess.
// ⛔ The revoke alert dialog ignored Escape.
describe('mountDevicesPage — Escape on a revoke confirmation', () => {
  it('closes it as Cancel does and returns to that row’s Revoke', async () => {
    const fake = makeFakeHost();
    const runPairRevoke = vi.fn(async () => ({ ok: true as const }));
    const mount = mountDevicesPage({
      host: fake.host,
      runPairList: vi.fn(async () => ({
        devices: [buildDevice({ instance_id: 'inst-B', display_name: 'Old phone', connected: false })],
      })),
      runPairRevoke,
      now: () => FIXED_NOW,
    });
    await flush();
    fake.clickAction('revoke-device', 'inst-B');
    expect(fake.getHtml()).toContain('data-action="confirm-revoke"');

    fake.pressEscape();

    expect(fake.getHtml()).not.toContain('data-action="confirm-revoke"');
    expect(fake.getFocusedAction()).toEqual({ action: 'revoke-device', instanceId: 'inst-B' });
    expect(runPairRevoke).not.toHaveBeenCalled();
    mount.dispose();
  });
});

describe('mountDevicesPage — rename', () => {
  const twoChromes = () => vi.fn(async () => ({
    devices: [
      buildDevice({ instance_id: 'inst-A', display_name: 'Chrome on macOS' }),
      buildDevice({ instance_id: 'inst-B', display_name: 'Chrome on macOS', connected: false }),
    ],
  }));

  it('opens a form in place of the name, saves the trimmed name, and shows it', async () => {
    const fake = makeFakeHost();
    const names: Record<string, string> = { 'inst-A': 'Chrome on macOS', 'inst-B': 'Chrome on macOS' };
    const runPairList = vi.fn(async () => ({
      devices: Object.entries(names).map(([instance_id, display_name]) =>
        buildDevice({ instance_id, display_name, connected: instance_id === 'inst-A' })),
    }));
    const runPairRename = vi.fn(async (args: { instance_id: string; display_name: string }) => {
      names[args.instance_id] = args.display_name;
      return { ok: true as const, display_name: args.display_name };
    });
    const mount = mountDevicesPage({
      host: fake.host,
      runPairList,
      runPairRevoke: vi.fn(async () => ({ ok: true as const })),
      runPairRename,
      now: () => FIXED_NOW,
    });
    await flush();

    fake.clickAction('rename-device', 'inst-B');
    expect(fake.getHtml()).toContain('data-rename-form');
    expect(fake.renameInputFocused()).toBe(true);
    fake.typeRename('  Old work laptop ');
    fake.submitRename('inst-B');
    await flush();

    expect(runPairRename).toHaveBeenCalledWith({ instance_id: 'inst-B', display_name: 'Old work laptop' });
    expect(fake.getHtml()).not.toContain('data-rename-form');
    expect(fake.getHtml()).toContain('Old work laptop');
    expect(runPairList).toHaveBeenCalledTimes(2);
    mount.dispose();
  });

  it('keeps the old name on Escape, and refuses an empty one before any call', async () => {
    const fake = makeFakeHost();
    const runPairRename = vi.fn(async () => ({ ok: true as const, display_name: 'x' }));
    const mount = mountDevicesPage({
      host: fake.host,
      runPairList: twoChromes(),
      runPairRevoke: vi.fn(async () => ({ ok: true as const })),
      runPairRename,
      now: () => FIXED_NOW,
    });
    await flush();

    fake.clickAction('rename-device', 'inst-A');
    fake.typeRename('   ');
    fake.submitRename('inst-A');
    expect(runPairRename).not.toHaveBeenCalled();
    expect(fake.getHtml()).toContain('Type a name of 1 to 64 characters.');

    fake.escapeRename('inst-A');
    expect(fake.getHtml()).not.toContain('data-rename-form');
    expect(fake.getFocusedAction()).toEqual({ action: 'rename-device', instanceId: 'inst-A' });
    mount.dispose();
  });

  it('keeps the form and the typed name when the server refuses, and through a refresh', async () => {
    const fake = makeFakeHost();
    const runPairList = twoChromes();
    const mount = mountDevicesPage({
      host: fake.host,
      runPairList,
      runPairRevoke: vi.fn(async () => ({ ok: true as const })),
      runPairRename: vi.fn(async () => { throw new Error('device belongs to a different user'); }),
      now: () => FIXED_NOW,
    });
    await flush();

    fake.clickAction('rename-device', 'inst-A');
    fake.typeRename('Kitchen iPad');
    await mount.refresh();
    expect(fake.getHtml()).toContain('value="Kitchen iPad"');

    fake.submitRename('inst-A');
    await flush();
    expect(fake.getHtml()).toContain('data-rename-form');
    expect(fake.getHtml()).toContain('Recued could not rename this device');
    expect(fake.getHtml()).toContain('value="Kitchen iPad"');
    mount.dispose();
  });

  it('offers no Rename without the caller (an older server)', async () => {
    const fake = makeFakeHost();
    const mount = mountDevicesPage({
      host: fake.host,
      runPairList: twoChromes(),
      runPairRevoke: vi.fn(async () => ({ ok: true as const })),
      now: () => FIXED_NOW,
    });
    await flush();
    expect(fake.getHtml()).not.toContain('data-action="rename-device"');
    mount.dispose();
  });

  it('says when an offline device was last used', async () => {
    const fake = makeFakeHost();
    const mount = mountDevicesPage({
      host: fake.host,
      runPairList: vi.fn(async () => ({
        devices: [buildDevice({ instance_id: 'inst-B', connected: false, last_seen_at: FIXED_NOW / 1000 - 2 * 86_400 })],
      })),
      runPairRevoke: vi.fn(async () => ({ ok: true as const })),
      now: () => FIXED_NOW,
    });
    await flush();
    expect(fake.getHtml()).toContain('Last used 2 days ago');
    mount.dispose();
  });
});
