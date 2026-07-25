/** D-122 Phase 4.5 — `notification-send` handler tests. */

import { describe, expect, it } from 'vitest';
import {
  ALL_NOTIFICATION_CHANNELS,
  handleNotificationSend,
  type NotificationDispatchResult,
} from '../notification-handler.js';
import { NOTIFICATION_DELIVERY_CHANNELS, RpcError } from '@recued/contracts';

describe('D-122 Phase 4.5 — notification-send', () => {
  it('rejects an empty channels array', async () => {
    await expect(handleNotificationSend(
      { dispatchers: {} },
      { channels: [], text: 'hi' },
    )).rejects.toBeInstanceOf(RpcError);
  });

  it('fans out to all channels when channels are omitted', async () => {
    // Both halves derived from the registry: a dispatcher per delivery channel, and
    // the expectation that EVERY one of them was reached. Hand-listing the four
    // meant a newly declared vendor got no dispatcher here and quietly dropped out
    // of the default fan-out — which is the exact production bug this make-live
    // found in `NOTIFICATION_CHANNEL_REGISTRY`.
    const dispatchers = Object.fromEntries(
      NOTIFICATION_DELIVERY_CHANNELS.map((c) => [c, async () => ({ ok: true })]),
    );
    const out = await handleNotificationSend(
      { dispatchers } as Parameters<typeof handleNotificationSend>[0],
      { text: 'hi' },
    );
    expect(out.delivered_to.sort()).toEqual([...NOTIFICATION_DELIVERY_CHANNELS].sort());
    expect(out.failed).toEqual([]);
  });

  it('rejects an empty text', async () => {
    await expect(handleNotificationSend(
      { dispatchers: {} },
      { channels: ['slack'], text: '' },
    )).rejects.toBeInstanceOf(RpcError);
  });

  it('reports unconfigured channels as failed', async () => {
    const out = await handleNotificationSend(
      { dispatchers: {} },
      { channels: ['slack', 'email'], text: 'hello' },
    );
    expect(out.delivered_to).toEqual([]);
    expect(out.failed.sort()).toEqual(['email', 'slack']);
  });

  it('routes to a wired dispatcher', async () => {
    const out = await handleNotificationSend(
      {
        dispatchers: {
          slack: async () => ({ ok: true }) as NotificationDispatchResult,
        },
      },
      { channels: ['slack'], text: 'hi' },
    );
    expect(out.delivered_to).toEqual(['slack']);
    expect(out.failed).toEqual([]);
  });

  it('aggregates per-channel results', async () => {
    const out = await handleNotificationSend(
      {
        dispatchers: {
          slack: async () => ({ ok: true }),
          email: async () => ({ ok: false, reason: 'channel_not_configured' }),
          telegram: async () => { throw new Error('boom'); },
        },
      },
      { channels: ['slack', 'email', 'telegram', 'in_app'], text: 'hi' },
    );
    expect(out.delivered_to).toEqual(['slack']);
    expect(out.failed.sort()).toEqual(['email', 'in_app', 'telegram']);
  });

  it('forwards optional title + link_url to dispatchers', async () => {
    let captured: unknown;
    const out = await handleNotificationSend(
      {
        dispatchers: {
          slack: async (payload) => { captured = payload; return { ok: true }; },
        },
      },
      {
        channels: ['slack'],
        text: 'body',
        title: 'subject',
        link_url: 'https://example.com',
      } as Parameters<typeof handleNotificationSend>[1],
    );
    expect(out.delivered_to).toEqual(['slack']);
    expect(captured).toMatchObject({
      channel: 'slack',
      text: 'body',
      title: 'subject',
      link_url: 'https://example.com',
    });
  });

  it('rejects unknown channel slugs', async () => {
    await expect(handleNotificationSend(
      { dispatchers: {} },
      // ⚠ was the literal `discord` — a vendor that did not exist yet, and which
      // stopped being an "unknown channel" the day it shipped. Name an impossibility.
      { channels: ['not_a_transport' as 'slack'], text: 'hi' },
    )).rejects.toBeInstanceOf(RpcError);
  });

  it('exposes the closed channel enum', () => {
    // Derived — the enum IS the delivery-channel registry (seam 10), so restating
    // its members by hand only guarantees that the next vendor breaks this test.
    expect(ALL_NOTIFICATION_CHANNELS).toEqual([...NOTIFICATION_DELIVERY_CHANNELS]);
  });
});
