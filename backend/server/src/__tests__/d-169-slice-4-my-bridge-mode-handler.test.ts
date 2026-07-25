/** D-169 P2 Slice 4 — `notifications.my_bridge_mode` handler.
 *
 *  Self-scoped read keyed on the authenticated `WsClient.client_token_id`
 *  (no arg — a client can only ask about itself). The handler reads the
 *  full per-bridge roster from the block then returns ONLY the caller's
 *  own row's modes (channel-isolation, I-10): no bridge sees another
 *  bridge's flags on the wire. `{ modes: null }` when the caller carries
 *  no client_token_id or is not a recognised paired bridge.
 */

import { describe, expect, it, vi } from 'vitest';

import { handleNotificationsMyBridgeMode } from '../notifications-handler.js';
import type { NotificationBlock } from '@recued/notification';
import type { WsClient } from '../ws-server.js';

interface FakeRow {
  client_token_id: string;
  label: string;
  modes: { notification: boolean; approval: boolean };
  connected: boolean;
  added_at?: number;
}

const blockWithRows = (
  rows: readonly FakeRow[],
): { block: NotificationBlock } => ({
  block: {
    describeNotificationBridges: async () => rows,
  } as unknown as NotificationBlock,
});

const ctxWith = (client_token_id?: string): WsClient =>
  ({ ...(client_token_id !== undefined ? { client_token_id } : {}) }) as WsClient;

describe('D-169 Slice 4 — handleNotificationsMyBridgeMode', () => {
  it("returns the caller's own modes when client_token_id matches a paired bridge", async () => {
    const deps = blockWithRows([
      { client_token_id: 'bridge-A', label: 'A', modes: { notification: true, approval: true }, connected: true },
      { client_token_id: 'bridge-B', label: 'B', modes: { notification: false, approval: false }, connected: false },
    ]);

    const result = await handleNotificationsMyBridgeMode(deps, ctxWith('bridge-A'));

    expect(result).toEqual({ modes: { notification: true, approval: true } });
  });

  it('returns null when the caller is not a recognised paired bridge (e.g. a webclient)', async () => {
    const deps = blockWithRows([
      { client_token_id: 'bridge-A', label: 'A', modes: { notification: true, approval: true }, connected: true },
    ]);

    const result = await handleNotificationsMyBridgeMode(deps, ctxWith('webclient-X'));

    expect(result).toEqual({ modes: null });
  });

  it('returns null without querying the roster when the WS carries no client_token_id', async () => {
    const describe = vi.fn(async () => [] as FakeRow[]);
    const deps = {
      block: { describeNotificationBridges: describe } as unknown as NotificationBlock,
    };

    const result = await handleNotificationsMyBridgeMode(deps, ctxWith(undefined));

    expect(result).toEqual({ modes: null });
    expect(describe).not.toHaveBeenCalled();
  });

  it('returns null for an empty-string client_token_id (treated as unauthenticated)', async () => {
    const describe = vi.fn(async () => [] as FakeRow[]);
    const deps = {
      block: { describeNotificationBridges: describe } as unknown as NotificationBlock,
    };

    const result = await handleNotificationsMyBridgeMode(deps, ctxWith(''));

    expect(result).toEqual({ modes: null });
    expect(describe).not.toHaveBeenCalled();
  });

  it('projects ONLY {notification, approval} — no sibling rows or extra fields leak', async () => {
    const deps = blockWithRows([
      { client_token_id: 'bridge-A', label: 'Secret label A', modes: { notification: false, approval: true }, connected: true, added_at: 123 },
      { client_token_id: 'bridge-B', label: 'Secret label B', modes: { notification: true, approval: true }, connected: true },
    ]);

    const result = await handleNotificationsMyBridgeMode(deps, ctxWith('bridge-A'));

    expect(result.modes).toEqual({ notification: false, approval: true });
    expect(Object.keys(result.modes ?? {})).toEqual(['notification', 'approval']);
    // The other bridge's id/label must not appear anywhere in the response.
    expect(JSON.stringify(result)).not.toContain('bridge-B');
    expect(JSON.stringify(result)).not.toContain('Secret label');
  });
});
