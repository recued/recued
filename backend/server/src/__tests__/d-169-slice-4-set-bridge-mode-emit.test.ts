/** D-169 P2 Slice 4 — `set_bridge_mode` bus-emit + composer threading.
 *
 *  A successful `notifications.set_bridge_mode` fans out a
 *  `notification.bridge_mode_changed` event so the affected bridge's side
 *  panel re-reads its mode live. These tests pin: the emit fires ONLY on a
 *  successful set, carries `client_token_id == bridge_id` and the merged
 *  POST-change modes (not the partial patch), is skipped on
 *  `bridge_unknown`, and is a no-op when no bus emitter is wired. The
 *  composer half verifies the bus → `emit` thread is present iff a bus was
 *  passed. */

import type { NotificationBlock, NotificationSettings } from '@recued/notification';
import { describe, expect, it, vi } from 'vitest';

import { composeNotificationsRpcDeps } from '../composition/bin/wire-notifications-rpc-deps.js';
import type { EventBus, ServerEventInput } from '../events/bus.js';
import {
  handleNotificationsSetBridgeMode,
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
  email: { notification: false, approval: false, messenger: false },
  bridges,
});

const block = (patch: Partial<NotificationBlock> = {}): NotificationBlock =>
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

describe('D-169 P2 Slice 4 — set_bridge_mode bus emit', () => {
  it('emits notification.bridge_mode_changed with the bridge_id + POST-change modes on a successful set', async () => {
    // The set toggles approval ON; the merged stored row also carries a
    // pre-existing notification:true — the emit must reflect the merged row,
    // not the partial patch.
    const setNotificationBridgeMode = vi.fn(async () => ({
      ok: true as const,
      settings: settings({
        'bridge-1': { notification: true, approval: true },
      }),
    }));
    const emit = vi.fn<(event: ServerEventInput) => void>();
    const deps: NotificationRpcDeps = { block: block({ setNotificationBridgeMode }), emit };

    const result = await handleNotificationsSetBridgeMode(deps, {
      bridge_id: 'bridge-1',
      patch: { approval: true },
    });

    expect(result).toEqual({
      ok: true,
      settings: settings({ 'bridge-1': { notification: true, approval: true } }),
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      kind: 'notification.bridge_mode_changed',
      client_token_id: 'bridge-1',
      // merged post-change modes — NOT the `{ approval: true }` patch.
      modes: { notification: true, approval: true },
    });
  });

  it('does NOT emit on a bridge_unknown result', async () => {
    const emit = vi.fn<(event: ServerEventInput) => void>();
    const deps: NotificationRpcDeps = {
      block: block({
        setNotificationBridgeMode: vi.fn(async () => ({
          ok: false as const,
          reason: 'bridge_unknown' as const,
          bridge_id: 'missing',
        })),
      }),
      emit,
    };

    const result = await handleNotificationsSetBridgeMode(deps, {
      bridge_id: 'missing',
      patch: { approval: true },
    });

    expect(result).toEqual({
      ok: false,
      reason: 'bridge_unknown',
      bridge_id: 'missing',
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('does NOT emit when the (ok) result is missing the bridge row (defensive guard)', async () => {
    const emit = vi.fn<(event: ServerEventInput) => void>();
    const deps: NotificationRpcDeps = {
      block: block({
        // ok:true but the settings carry no row for this id — the handler's
        // `if (modes)` guard must skip the emit rather than send undefined.
        setNotificationBridgeMode: vi.fn(async () => ({
          ok: true as const,
          settings: settings({}),
        })),
      }),
      emit,
    };

    await handleNotificationsSetBridgeMode(deps, {
      bridge_id: 'bridge-1',
      patch: { approval: true },
    });

    expect(emit).not.toHaveBeenCalled();
  });

  it('resolves the result and does not throw when no emit is wired (dbless harness)', async () => {
    const deps: NotificationRpcDeps = {
      block: block({
        setNotificationBridgeMode: vi.fn(async () => ({
          ok: true as const,
          settings: settings({
            'bridge-1': { notification: false, approval: true },
          }),
        })),
      }),
      // no `emit`
    };

    const result = await handleNotificationsSetBridgeMode(deps, {
      bridge_id: 'bridge-1',
      patch: { approval: true },
    });

    expect(result).toMatchObject({ ok: true });
  });
});

describe('D-169 P2 Slice 4 — composeNotificationsRpcDeps bus threading', () => {
  it('threads an emit that forwards to the bus when an eventBus is supplied', () => {
    const busEmit = vi.fn();
    const bus = { emit: busEmit } as unknown as EventBus;

    const bundle = composeNotificationsRpcDeps({ block: block(), eventBus: bus });

    expect(bundle.notificationsDeps).toBeDefined();
    expect(bundle.notificationsDeps?.emit).toBeTypeOf('function');

    const event: ServerEventInput = {
      kind: 'notification.bridge_mode_changed',
      client_token_id: 'bridge-1',
      modes: { notification: false, approval: true },
    };
    bundle.notificationsDeps?.emit?.(event);
    expect(busEmit).toHaveBeenCalledWith(event);
  });

  it('omits emit entirely when no eventBus is supplied', () => {
    const bundle = composeNotificationsRpcDeps({ block: block() });
    expect(bundle.notificationsDeps).toBeDefined();
    expect(bundle.notificationsDeps?.emit).toBeUndefined();
  });

  it('returns an undefined bundle when the block is absent', () => {
    const busEmit = vi.fn();
    const bundle = composeNotificationsRpcDeps({
      block: undefined,
      eventBus: { emit: busEmit } as unknown as EventBus,
    });
    expect(bundle.notificationsDeps).toBeUndefined();
  });
});
