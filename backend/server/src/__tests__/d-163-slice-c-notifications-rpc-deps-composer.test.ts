/** D-163 Slice C — notifications rpc-deps composer test.
 *
 *  Asserts the thin composer (`composeNotificationsRpcDeps`):
 *    - block present → `{ notificationsDeps: { block } }`
 *    - block absent  → `{ notificationsDeps: undefined }`
 *
 *  The composer is a presence gate, not a constructor — the block is
 *  already constructed earlier in boot via `composeNotificationBlock`,
 *  so this slice just decides whether the bundle propagates onto the
 *  rpc handler set. */

import { CHANNEL_ROLES, MESSENGER_VENDOR_SLUGS } from '@recued/contracts';
import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it } from 'vitest';

import {
  createAskStore,
  createBridgeChannel,
  createNotificationBlock,
  createNotificationSettingsStore,
  createUiChannel,
  type Channel,
  type ChannelReadinessProbe,
  type NotificationBlock,
  type NotificationSettings,
  type PendingAsk,
} from '@recued/notification';

import { composeNotificationsRpcDeps } from '../composition/bin/wire-notifications-rpc-deps.js';

const probeFalse: ChannelReadinessProbe = () => false;

const buildBlock = (): NotificationBlock => {
  const ui = createUiChannel({ busSink: () => undefined });
  const bridge = createBridgeChannel({ bridgeSink: () => undefined });
  const channels: readonly Channel[] = [ui, bridge];
  return createNotificationBlock({
    askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
    settingsStore: createNotificationSettingsStore(
      createInMemoryCollection<NotificationSettings>(),
    ),
    channels,
    readinessProbe: probeFalse,
  });
};

describe('composeNotificationsRpcDeps', () => {
  it('returns undefined deps when block is absent', () => {
    const bundle = composeNotificationsRpcDeps({ block: undefined });
    expect(bundle.notificationsDeps).toBeUndefined();
  });

  it('returns deps that close over the provided block', () => {
    const block = buildBlock();
    const bundle = composeNotificationsRpcDeps({ block });
    expect(bundle.notificationsDeps).toBeDefined();
    expect(bundle.notificationsDeps?.block).toBe(block);
  });

  it('threaded deps round-trip through describeNotificationChannels', async () => {
    const block = buildBlock();
    const bundle = composeNotificationsRpcDeps({ block });
    expect(bundle.notificationsDeps).toBeDefined();
    // The composer holds a reference, not a copy — the block's surface
    // remains the source of truth for the rpc result.
    const result = await bundle.notificationsDeps!.block.describeNotificationChannels();
    // Derived, not hand-spelled — see the sibling handler suite for why a
    // literal count here went red the moment Discord's row was fixed.
    // Asserting the full list (not just its length) also proves the composer
    // passes the block's surface through without filtering it.
    expect(result.map((r) => r.channel)).toEqual([
      'ui',
      'bridge',
      ...MESSENGER_VENDOR_SLUGS.filter(
        (v) => CHANNEL_ROLES[v].notification || CHANNEL_ROLES[v].approval,
      ),
      'email',
    ]);
  });
});
