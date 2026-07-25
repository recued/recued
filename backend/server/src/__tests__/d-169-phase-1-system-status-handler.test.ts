import { describe, expect, it, vi } from 'vitest';

import type { WsServerHandle } from '../ws-server.js';
import {
  handleSystemStatus,
  makeSystemStatusHandlers,
  type SystemStatusDeps,
} from '../system-status-handler.js';

const wsHandle = (
  connected: number,
  rows: Array<{ instance_id: string; name: string; connected_at: number }> = [],
): WsServerHandle =>
  ({
    clientCount: () => connected,
    listConnectedInstances: () => rows,
    getPairedUserId: () => undefined,
    revokeConnectedInstance: () => ({ revoked: false }),
    revokeAllConnectedInstances: () => 0,
    closeAllForWsLockout: () => 0,
  }) as unknown as WsServerHandle;

const lastSyncFromHandle = (
  getWsServer: () => WsServerHandle | undefined,
): number | null => {
  const handle = getWsServer();
  if (!handle) return null;
  const rows = handle.listConnectedInstances();
  if (rows.length === 0) return null;
  const maxSeconds = Math.max(...rows.map((r) => r.connected_at));
  return maxSeconds > 0 ? maxSeconds * 1000 : null;
};

const deps = (
  patch: Partial<SystemStatusDeps> = {},
): SystemStatusDeps => ({
  getServerDisplayName: () => 'Recued Local',
  getServerVersion: () => '1.2.3-test',
  getUptimeSeconds: () => 42,
  getLastSyncAt: () => null,
  now: () => 1_800_000_000_000,
  ...patch,
});

describe('D-169 P1 system.status handler', () => {
  it('returns the fully populated ServerSystemStatus shape when all deps are wired', async () => {
    const handle = wsHandle(2, [
      { instance_id: 'web-1', name: 'Webclient', connected_at: 1_700_000_001 },
      { instance_id: 'bridge-1', name: 'Bridge', connected_at: 1_700_000_007 },
    ]);
    const getWsServer = () => handle;
    const out = await handleSystemStatus(
      deps({
        getWsServer,
        getLastSyncAt: () => lastSyncFromHandle(getWsServer),
        getPairedClientCount: async () => 3,
        countExecutionsInWindow: async (windowMs) =>
          windowMs === 60 * 60 * 1000 ? 4 : 17,
        countPendingAsks: async () => 2,
        getScheduleQueueDepth: async () => 5,
        countRecentErrors: async () => 1,
      }),
    );

    expect(out).toEqual({
      status: {
        name: 'Recued Local',
        version: '1.2.3-test',
        uptime_seconds: 42,
        paired_client_count: 3,
        paired_client_connected: 2,
        ws_state: 'serving',
        last_sync_at: 1_700_000_007_000,
        executions_last_hour: 4,
        executions_last_24h: 17,
        pending_asks: 2,
        schedule_queue_depth: 5,
        recent_error_count: 1,
        snapshot_at: 1_800_000_000_000,
      },
    });
  });

  it('uses the ws_state discriminator for offline, idle, and serving states', async () => {
    await expect(
      handleSystemStatus(deps({ getWsServer: () => undefined })),
    ).resolves.toMatchObject({
      status: { ws_state: 'offline', paired_client_connected: 0 },
    });

    await expect(
      handleSystemStatus(deps({ getWsServer: () => wsHandle(0) })),
    ).resolves.toMatchObject({
      status: { ws_state: 'idle', paired_client_connected: 0 },
    });

    await expect(
      handleSystemStatus(deps({ getWsServer: () => wsHandle(1) })),
    ).resolves.toMatchObject({
      status: { ws_state: 'serving', paired_client_connected: 1 },
    });
  });

  it('uses durable paired_client_count when wired and falls back to live connected count', async () => {
    await expect(
      handleSystemStatus(
        deps({
          getWsServer: () => wsHandle(0),
          getPairedClientCount: async () => 7,
        }),
      ),
    ).resolves.toMatchObject({
      status: { paired_client_count: 7, paired_client_connected: 0 },
    });

    await expect(
      handleSystemStatus(deps({ getWsServer: () => wsHandle(2) })),
    ).resolves.toMatchObject({
      status: { paired_client_count: 2, paired_client_connected: 2 },
    });
  });

  it('returns null counter fields when their accessors are absent', async () => {
    await expect(handleSystemStatus(deps())).resolves.toMatchObject({
      status: {
        executions_last_hour: null,
        executions_last_24h: null,
        pending_asks: null,
        schedule_queue_depth: null,
        recent_error_count: null,
      },
    });
  });

  it('derives last_sync_at as null without a handle or roster and max ms when populated', async () => {
    let handle: WsServerHandle | undefined;
    const getWsServer = () => handle;

    await expect(
      handleSystemStatus(
        deps({ getWsServer, getLastSyncAt: () => lastSyncFromHandle(getWsServer) }),
      ),
    ).resolves.toMatchObject({ status: { last_sync_at: null } });

    handle = wsHandle(0, []);
    await expect(
      handleSystemStatus(
        deps({ getWsServer, getLastSyncAt: () => lastSyncFromHandle(getWsServer) }),
      ),
    ).resolves.toMatchObject({ status: { last_sync_at: null } });

    handle = wsHandle(2, [
      { instance_id: 'a', name: 'A', connected_at: 10 },
      { instance_id: 'b', name: 'B', connected_at: 25 },
    ]);
    await expect(
      handleSystemStatus(
        deps({ getWsServer, getLastSyncAt: () => lastSyncFromHandle(getWsServer) }),
      ),
    ).resolves.toMatchObject({ status: { last_sync_at: 25_000 } });
  });

  it('keeps uptime_seconds monotonic relative to an injected clock', async () => {
    let now = 1_800_000_000_000;
    const boot = now;
    const getUptimeSeconds = () => Math.floor((now - boot) / 1000);

    const first = await handleSystemStatus(deps({ now: () => now, getUptimeSeconds }));
    now += 15_000;
    const second = await handleSystemStatus(deps({ now: () => now, getUptimeSeconds }));

    expect(second.status.uptime_seconds).toBeGreaterThanOrEqual(
      first.status.uptime_seconds,
    );
    expect(second.status.uptime_seconds).toBe(15);
  });

  it('sets snapshot_at from the injected now thunk', async () => {
    await expect(
      handleSystemStatus(deps({ now: () => 123_456 })),
    ).resolves.toMatchObject({
      status: { snapshot_at: 123_456 },
    });
  });

  it('makeSystemStatusHandlers(undefined) returns undefined', () => {
    expect(makeSystemStatusHandlers(undefined)).toBeUndefined();
  });

  it('handler slice invokes handleSystemStatus with the carried deps', async () => {
    const getServerDisplayName = vi.fn(() => 'Slice Server');
    const getServerVersion = vi.fn(() => 'slice-version');
    const slice = makeSystemStatusHandlers(
      deps({
        getServerDisplayName,
        getServerVersion,
        getUptimeSeconds: () => 9,
      }),
    );

    const out = await slice!.handlers['system.status'](undefined, undefined as never);

    expect(slice?.methods).toEqual(['system.status']);
    expect(getServerDisplayName).toHaveBeenCalledTimes(1);
    expect(getServerVersion).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({
      status: { name: 'Slice Server', version: 'slice-version', uptime_seconds: 9 },
    });
  });
});
