/** D-163 P0 — Browser Bridge channel adapter.
 *
 *  Invariants under test:
 *   - I-4: Bridge is a discrete channel adapter (`createBridgeChannel`)
 *   - I-7: `createUiChannel` no longer accepts a `bridgeNotifier` opt
 *   - I-8: the deleted `BridgeOsNotifier` / `bridgeNotifier` symbols
 *          do not re-appear in the package
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createBridgeChannel,
  createUiChannel,
  type BridgeSink,
  type Channel,
  type NotificationMessage,
} from '../index.js';

describe('D-163 I-4 — Bridge as a discrete channel adapter', () => {
  it('createBridgeChannel returns a Channel with name=bridge + capability=notify-only', () => {
    const channel = createBridgeChannel({ bridgeSink: () => {} });
    expect(channel.name).toBe('bridge');
    expect(channel.capability).toBe('notify-only');
  });

  it('deliverNotify invokes the injected bridge sink with the message', async () => {
    const sink: BridgeSink = vi.fn();
    const channel = createBridgeChannel({ bridgeSink: sink });

    const message: NotificationMessage = { title: 'Sync', text: 'Sync done' };
    await channel.deliverNotify(message);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(message);
  });

  it('deliverAsk defensive fallback fires a passive notify body (defense-in-depth)', async () => {
    const sink = vi.fn<BridgeSink>();
    const channel = createBridgeChannel({ bridgeSink: sink });

    const message: NotificationMessage = {
      title: 'Approve',
      text: 'Approve transfer?',
    };
    await channel.deliverAsk('ask-defensive', message, [
      { id: 'approve', label: 'Approve' },
    ]);

    expect(sink).toHaveBeenCalledTimes(1);
    const payload = sink.mock.calls[0][0];
    expect(payload.title).toBe('Approve');
    expect(payload.text).toContain('open Recued to approve');
  });

  it('closeAsk is a no-op (OS notifications self-dismiss)', async () => {
    const sink = vi.fn<BridgeSink>();
    const channel = createBridgeChannel({ bridgeSink: sink });

    await channel.closeAsk('ask-closeOnBridge');

    expect(sink).not.toHaveBeenCalled();
  });
});

describe('D-163 I-7 — createUiChannel signature has no bridgeNotifier opt', () => {
  it('UiChannelOptions accepts only busSink', () => {
    const channel: Channel = createUiChannel({ busSink: () => {} });
    expect(channel.name).toBe('ui');
    expect(channel.capability).toBe('inline');
  });

  it('passing a bridgeNotifier opt is a compile-time error (TS-level ratchet)', () => {
    // @ts-expect-error — D-163 N.7 deletes the `bridgeNotifier` opt.
    createUiChannel({ busSink: () => {}, bridgeNotifier: () => {} });
  });
});

describe('D-163 I-8 — no bridgeNotifier / BridgeOsNotifier symbol remains', () => {
  const NOTIFICATION_SRC = join(__dirname, '..');

  const walkSource = function* (dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkSource(full);
      } else if (entry.name.endsWith('.ts')) {
        yield full;
      }
    }
  };

  it('no `bridgeNotifier` literal in @recued/notification source', () => {
    const hits: string[] = [];
    for (const file of walkSource(NOTIFICATION_SRC)) {
      const src = readFileSync(file, 'utf8');
      if (src.includes('bridgeNotifier')) hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  it('no `BridgeOsNotifier` literal in @recued/notification source', () => {
    const hits: string[] = [];
    for (const file of walkSource(NOTIFICATION_SRC)) {
      const src = readFileSync(file, 'utf8');
      if (src.includes('BridgeOsNotifier')) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});
