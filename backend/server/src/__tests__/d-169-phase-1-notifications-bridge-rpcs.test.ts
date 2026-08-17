import { RpcError } from '@recued/contracts';
import type { NotificationBlock, NotificationSettings } from '@recued/notification';
import { describe, expect, it, vi } from 'vitest';

import {
  handleNotificationsDescribeBridges,
  handleNotificationsSetBridgeMode,
  makeNotificationsHandlers,
  type NotificationRpcDeps,
} from '../notifications-handler.js';

const settings = (
  bridges: NotificationSettings['bridges'] = {},
): NotificationSettings => ({
  ui: true,
  bridge: false,
  slack: { notification: false, approval: false, messenger: false },
  telegram: { notification: false, approval: false, messenger: false },
  whatsapp: { notification: false, approval: false, messenger: false },
  discord: { notification: false, approval: false, messenger: false },
  teams: { notification: false, approval: false, messenger: false },
  email: { notification: false, approval: false, messenger: false },
  bridges,
});

const block = (
  patch: Partial<NotificationBlock> = {},
): NotificationBlock =>
  ({
    notify: vi.fn(),
    ask: vi.fn(),
    registerAskHandler: vi.fn(),
    submitAnswer: vi.fn(),
    recoverPendingAsks: vi.fn(),
    countOutstandingAsks: vi.fn(),
    getNotificationSettings: vi.fn(),
    describeNotificationChannels: vi.fn(async () => []),
    setNotificationChannelMode: vi.fn(),
    setNotificationVerificationPhrase: vi.fn(),
    describeNotificationBridges: vi.fn(async () => []),
    setNotificationBridgeMode: vi.fn(),
    ...patch,
  }) as unknown as NotificationBlock;

const deps = (b: NotificationBlock): NotificationRpcDeps => ({ block: b });

const expectBadRequest = async (promise: Promise<unknown>): Promise<void> => {
  await expect(promise).rejects.toBeInstanceOf(RpcError);
  await expect(promise).rejects.toMatchObject({ code: 'bad_request' });
};

describe('D-169 P1 notifications bridge RPC handlers', () => {
  it('handleNotificationsDescribeBridges returns empty rows when the block has no bridges', async () => {
    const b = block({
      describeNotificationBridges: vi.fn(async () => []),
    });

    await expect(handleNotificationsDescribeBridges(deps(b))).resolves.toEqual({
      rows: [],
    });
  });

  it('handleNotificationsDescribeBridges returns the block row list', async () => {
    const rows = [
      {
        client_token_id: 'bridge-1',
        label: 'Bridge1 Chrome on macOS',
        modes: { notification: true, approval: false },
        added_at: 1_700_000_000,
        connected: true,
      },
    ];
    const b = block({
      describeNotificationBridges: vi.fn(async () => rows),
    });

    await expect(handleNotificationsDescribeBridges(deps(b))).resolves.toEqual({
      rows,
    });
  });

  it('rejects malformed bridge_id values with bad_request', async () => {
    const b = block();

    await expectBadRequest(
      handleNotificationsSetBridgeMode(deps(b), {
        bridge_id: 42 as unknown as string,
        patch: { notification: true },
      }),
    );
    await expectBadRequest(
      handleNotificationsSetBridgeMode(deps(b), {
        bridge_id: '',
        patch: { notification: true },
      }),
    );
    expect(b.setNotificationBridgeMode).not.toHaveBeenCalled();
  });

  it('rejects malformed patch shapes with bad_request', async () => {
    const b = block();

    await expectBadRequest(
      handleNotificationsSetBridgeMode(deps(b), {
        bridge_id: 'bridge-1',
        patch: null as unknown as { notification: boolean },
      }),
    );
    await expectBadRequest(
      handleNotificationsSetBridgeMode(deps(b), {
        bridge_id: 'bridge-1',
        patch: { notification: 'yes' } as unknown as { notification: boolean },
      }),
    );
    await expectBadRequest(
      handleNotificationsSetBridgeMode(deps(b), {
        bridge_id: 'bridge-1',
        patch: { approval: 1 } as unknown as { approval: boolean },
      }),
    );
    expect(b.setNotificationBridgeMode).not.toHaveBeenCalled();
  });

  it('rejects an empty patch with bad_request', async () => {
    const b = block();

    await expectBadRequest(
      handleNotificationsSetBridgeMode(deps(b), {
        bridge_id: 'bridge-1',
        patch: {},
      }),
    );
    expect(b.setNotificationBridgeMode).not.toHaveBeenCalled();
  });

  it('valid patch for a known bridge returns ok true and delegates to the block surface', async () => {
    const setNotificationBridgeMode = vi.fn(async () => ({
      ok: true as const,
      settings: settings({
        'bridge-1': { notification: true, approval: false },
      }),
    }));
    const b = block({ setNotificationBridgeMode });

    await expect(
      handleNotificationsSetBridgeMode(deps(b), {
        bridge_id: 'bridge-1',
        patch: { notification: true },
      }),
    ).resolves.toEqual({
      ok: true,
      settings: settings({
        'bridge-1': { notification: true, approval: false },
      }),
    });
    expect(setNotificationBridgeMode).toHaveBeenCalledWith('bridge-1', {
      notification: true,
    });
  });

  it('valid patch for an unknown bridge returns bridge_unknown as data', async () => {
    const b = block({
      setNotificationBridgeMode: vi.fn(async () => ({
        ok: false as const,
        reason: 'bridge_unknown' as const,
        bridge_id: 'missing',
      })),
    });

    await expect(
      handleNotificationsSetBridgeMode(deps(b), {
        bridge_id: 'missing',
        patch: { approval: true },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'bridge_unknown',
      bridge_id: 'missing',
    });
  });

  it('makeNotificationsHandlers includes the two D-169 bridge method names', async () => {
    const b = block({
      describeNotificationBridges: vi.fn(async () => []),
      setNotificationBridgeMode: vi.fn(async () => ({
        ok: true as const,
        settings: settings({
          'bridge-1': { notification: false, approval: true },
        }),
      })),
    });
    const slice = makeNotificationsHandlers(deps(b));

    expect(slice?.methods).toEqual([
      'notifications.describe',
      'notifications.set_channel',
      'notifications.set_verification_phrase',
      'notifications.describe_bridges',
      'notifications.set_bridge_mode',
      // D-169 P2 Slice 4 — the self-scoped per-bridge mode read.
      'notifications.my_bridge_mode',
    ]);
    await expect(
      slice!.handlers['notifications.describe_bridges'](
        undefined,
        undefined as never,
      ),
    ).resolves.toEqual({ rows: [] });
    await expect(
      slice!.handlers['notifications.set_bridge_mode'](
        { bridge_id: 'bridge-1', patch: { approval: true } },
        undefined as never,
      ),
    ).resolves.toMatchObject({ ok: true });
  });
});
