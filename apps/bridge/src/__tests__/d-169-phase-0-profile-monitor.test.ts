/** D-169 P0 - bridge capability profile monitor tests.
 *
 *  Pins the bridge-side permission re-push behavior added for TR-17:
 *  every explicit push and chrome.permissions mutation rebuilds a
 *  fresh BridgeCapabilityProfile from getAll() plus the snapshot
 *  accessor before sending it to the server.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_ACTIONS, type BridgeCapabilityProfile } from '@recued/contracts';
import {
  buildCapabilityProfile,
  createBridgeCapabilityProfileMonitor,
  type BridgeCapabilityProfileSnapshot,
  type ChromePermissionsApi,
  type ChromePermissionsSnapshot,
} from '../permissions/profile-monitor.js';

type PermissionHandler = (perms: ChromePermissionsSnapshot) => void;

const flushAsyncWork = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const waitFor = async (assertion: () => void): Promise<void> => {
  let lastErr: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastErr = err;
      await flushAsyncWork();
    }
  }
  throw lastErr;
};

const buildChromePermissions = (
  initial: ChromePermissionsSnapshot = {},
) => {
  let current = initial;
  const addedHandlers: PermissionHandler[] = [];
  const removedHandlers: PermissionHandler[] = [];
  return {
    getAll: vi.fn(async () => current),
    onAdded: {
      addListener(handler: PermissionHandler) {
        addedHandlers.push(handler);
      },
      removeListener(handler: PermissionHandler) {
        const i = addedHandlers.indexOf(handler);
        if (i >= 0) addedHandlers.splice(i, 1);
      },
    },
    onRemoved: {
      addListener(handler: PermissionHandler) {
        removedHandlers.push(handler);
      },
      removeListener(handler: PermissionHandler) {
        const i = removedHandlers.indexOf(handler);
        if (i >= 0) removedHandlers.splice(i, 1);
      },
    },
    addedHandlers,
    removedHandlers,
    setSnapshot(next: ChromePermissionsSnapshot) {
      current = next;
    },
    fireAdded(perms: ChromePermissionsSnapshot = current) {
      for (const h of [...addedHandlers]) h(perms);
    },
    fireRemoved(perms: ChromePermissionsSnapshot = current) {
      for (const h of [...removedHandlers]) h(perms);
    },
  } satisfies ChromePermissionsApi & {
    addedHandlers: PermissionHandler[];
    removedHandlers: PermissionHandler[];
    setSnapshot(next: ChromePermissionsSnapshot): void;
    fireAdded(perms?: ChromePermissionsSnapshot): void;
    fireRemoved(perms?: ChromePermissionsSnapshot): void;
  };
};

const profileSnapshot = (
  overrides: Partial<BridgeCapabilityProfileSnapshot> = {},
): BridgeCapabilityProfileSnapshot => ({
  software_version: '1.2.3',
  chrome_version: '126.0.6478.0',
  offscreen_supported: true,
  alarms_supported: false,
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('D-169 P0 - buildCapabilityProfile', () => {
  it('produces a well-shaped profile from chrome.permissions.getAll and omits absent user_agent', async () => {
    const chromePermissions = buildChromePermissions({
      permissions: ['storage', 'tabs'],
      origins: ['*://app.hubspot.com/*'],
    });

    const profile = await buildCapabilityProfile({
      chromePermissions,
      snapshot: () => profileSnapshot(),
    });

    expect(profile).toEqual({
      software_version: '1.2.3',
      chrome_version: '126.0.6478.0',
      permissions_granted: ['storage', 'tabs'],
      granted_origins: ['*://app.hubspot.com/*'],
      offscreen_supported: true,
      alarms_supported: false,
      supported_actions: [...BRIDGE_ACTIONS],
    });
    expect('user_agent' in profile).toBe(false);
    // A server reads this to tell an owner to update a Bridge that cannot inspect (D-335).
    expect(profile.supported_actions).toContain('inspect');
  });

  it('rejects when chrome.permissions.getAll rejects', async () => {
    const chromePermissions = buildChromePermissions();
    const err = new Error('getAll failed');
    chromePermissions.getAll.mockRejectedValueOnce(err);

    await expect(buildCapabilityProfile({
      chromePermissions,
      snapshot: () => profileSnapshot(),
    })).rejects.toBe(err);
  });
});

describe('D-169 P0 - createBridgeCapabilityProfileMonitor', () => {
  it('pushNow sends a freshly built profile', async () => {
    const chromePermissions = buildChromePermissions({
      permissions: ['storage'],
      origins: ['*://example.com/*'],
    });
    const push = vi.fn(async (_profile: BridgeCapabilityProfile) => undefined);
    const monitor = createBridgeCapabilityProfileMonitor({
      chromePermissions,
      snapshot: () => profileSnapshot({ user_agent: 'Chrome/test' }),
      push,
    });

    await monitor.pushNow();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      software_version: '1.2.3',
      chrome_version: '126.0.6478.0',
      permissions_granted: ['storage'],
      granted_origins: ['*://example.com/*'],
      offscreen_supported: true,
      alarms_supported: false,
      supported_actions: [...BRIDGE_ACTIONS],
      user_agent: 'Chrome/test',
    });
  });

  it('wires chrome.permissions.onAdded and onRemoved and fires pushNow from both', async () => {
    const chromePermissions = buildChromePermissions({
      permissions: ['storage'],
      origins: ['*://one.example/*'],
    });
    const push = vi.fn(async (_profile: BridgeCapabilityProfile) => undefined);
    createBridgeCapabilityProfileMonitor({
      chromePermissions,
      snapshot: () => profileSnapshot(),
      push,
    });

    expect(chromePermissions.addedHandlers).toHaveLength(1);
    expect(chromePermissions.removedHandlers).toHaveLength(1);

    chromePermissions.fireAdded();
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));

    chromePermissions.setSnapshot({
      permissions: ['tabs'],
      origins: ['*://two.example/*'],
    });
    chromePermissions.fireRemoved();
    await waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    expect(push.mock.calls[1][0].granted_origins).toEqual(['*://two.example/*']);
  });

  it('collapses concurrent pushNow calls onto the in-flight promise and re-fires with dirty state', async () => {
    const chromePermissions = buildChromePermissions({
      permissions: ['storage'],
      origins: ['*://before.example/*'],
    });
    const pushed: BridgeCapabilityProfile[] = [];
    let releaseFirstPush: () => void = () => undefined;
    const firstPushDone = new Promise<void>((resolve) => {
      releaseFirstPush = resolve;
    });
    const push = vi.fn(async (profile: BridgeCapabilityProfile) => {
      pushed.push(profile);
      if (pushed.length === 1) {
        await firstPushDone;
      }
    });
    const monitor = createBridgeCapabilityProfileMonitor({
      chromePermissions,
      snapshot: () => profileSnapshot(),
      push,
    });

    const first = monitor.pushNow();
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));

    chromePermissions.setSnapshot({
      permissions: ['storage', 'tabs'],
      origins: ['*://after.example/*'],
    });
    const second = monitor.pushNow();

    expect(second).toBe(first);
    releaseFirstPush();
    await first;
    await waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    expect(pushed[1].permissions_granted).toEqual(['storage', 'tabs']);
    expect(pushed[1].granted_origins).toEqual(['*://after.example/*']);
  });

  it('stop removes both listeners and makes pushNow a no-op', async () => {
    const chromePermissions = buildChromePermissions({
      permissions: ['storage'],
      origins: ['*://example.com/*'],
    });
    const push = vi.fn(async (_profile: BridgeCapabilityProfile) => undefined);
    const monitor = createBridgeCapabilityProfileMonitor({
      chromePermissions,
      snapshot: () => profileSnapshot(),
      push,
    });

    monitor.stop();

    expect(chromePermissions.addedHandlers).toEqual([]);
    expect(chromePermissions.removedHandlers).toEqual([]);
    await monitor.pushNow();
    chromePermissions.fireAdded();
    chromePermissions.fireRemoved();
    await flushAsyncWork();
    expect(push).not.toHaveBeenCalled();
  });

  it('routes push failures to onPushError without rethrowing', async () => {
    const chromePermissions = buildChromePermissions({
      permissions: ['storage'],
      origins: ['*://example.com/*'],
    });
    const err = new Error('push failed');
    const push = vi.fn(async () => {
      throw err;
    });
    const onPushError = vi.fn();
    const monitor = createBridgeCapabilityProfileMonitor({
      chromePermissions,
      snapshot: () => profileSnapshot(),
      push,
      onPushError,
    });

    await expect(monitor.pushNow()).resolves.toBeUndefined();
    expect(onPushError).toHaveBeenCalledTimes(1);
    expect(onPushError).toHaveBeenCalledWith(err);
  });

  it('re-reads the snapshot accessor on every fire', async () => {
    const chromePermissions = buildChromePermissions({
      permissions: ['storage'],
      origins: ['*://example.com/*'],
    });
    let userAgent = 'ua-one';
    const pushed: BridgeCapabilityProfile[] = [];
    const monitor = createBridgeCapabilityProfileMonitor({
      chromePermissions,
      snapshot: () => profileSnapshot({ user_agent: userAgent }),
      push: async (profile) => {
        pushed.push(profile);
      },
    });

    await monitor.pushNow();
    userAgent = 'ua-two';
    await monitor.pushNow();

    expect(pushed.map((p) => p.user_agent)).toEqual(['ua-one', 'ua-two']);
  });
});
