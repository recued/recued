/** D-113 C6 — chat-adapter coordination helpers.
 *
 *  Pure-function tests for the owner-first-with-grace logic +
 *  record-mutation helpers that drive cross-peer chat-update
 *  coordination. Adapter implementations (slack-adapter, telegram-
 *  adapter) are tested separately since they hit external APIs. */

import { describe, it, expect } from 'vitest';
import {
  shouldUpdateChannel,
  appendSlackHandle,
  appendTelegramHandle,
  markChannelUpdateDone,
} from '../chat-adapter.js';
import {
  OWNER_GRACE_WINDOW_MS,
  type ApprovalPendingRecord,
  type ApprovalResolutionRecord,
  type SlackChannelHandle,
  type TelegramChannelHandle,
} from '@recued/contracts';

const mkPending = (overrides: Partial<ApprovalPendingRecord> = {}): ApprovalPendingRecord => ({
  approval_id: 'ap-1',
  initiator_instance: 'instance-1',
  recipe_id: 'test-recipe',
  step_id: 's1',
  prompt: 'Update deal?',
  created_at: 1_000,
  timeout_at: 61_000,
  ...overrides,
});

const mkResolution = (overrides: Partial<ApprovalResolutionRecord> = {}): ApprovalResolutionRecord => ({
  approval_id: 'ap-1',
  created_by_instance: 'instance-2',
  kind: 'user_action',
  resolved_at: 10_000,
  actor: { channel: 'slack', identifier: 'U1', user_display: 'Alice' },
  decision: 'approve',
  ...overrides,
});

describe('shouldUpdateChannel — owner-first-with-grace', () => {
  it('skips when channel_updates_done flag is already set', () => {
    const resolution = mkResolution({ channel_updates_done: { slack: true } });
    const result = shouldUpdateChannel(
      mkPending(),
      resolution,
      'slack',
      { self: { instance_id: 'instance-1' }, now: 11_000 },
    );
    expect(result).toBe(false);
  });

  it('initiator updates immediately regardless of grace', () => {
    const result = shouldUpdateChannel(
      mkPending({ initiator_instance: 'instance-1' }),
      mkResolution({ resolved_at: 10_000 }),
      'slack',
      { self: { instance_id: 'instance-1' }, now: 10_001 },  // 1ms after resolve
    );
    expect(result).toBe(true);
  });

  it('peer waits until past OWNER_GRACE_WINDOW_MS', () => {
    const resolvedAt = 10_000;
    const peerDeps = (now: number) => ({
      self: { instance_id: 'instance-peer' },
      now,
    });
    const pending = mkPending({ initiator_instance: 'instance-1' });
    const resolution = mkResolution({ resolved_at: resolvedAt });

    // Just under the grace window → wait.
    expect(
      shouldUpdateChannel(pending, resolution, 'slack',
        peerDeps(resolvedAt + OWNER_GRACE_WINDOW_MS - 1)),
    ).toBe(false);

    // Just past → takeover.
    expect(
      shouldUpdateChannel(pending, resolution, 'slack',
        peerDeps(resolvedAt + OWNER_GRACE_WINDOW_MS + 1)),
    ).toBe(true);
  });

  it('independent slack / telegram flags', () => {
    const resolution = mkResolution({
      channel_updates_done: { slack: true },  // slack done, telegram not
    });
    const deps = { self: { instance_id: 'instance-1' }, now: 11_000 };
    expect(shouldUpdateChannel(mkPending(), resolution, 'slack', deps)).toBe(false);
    expect(shouldUpdateChannel(mkPending(), resolution, 'telegram', deps)).toBe(true);
  });
});

describe('appendSlackHandle', () => {
  it('appends when channel_handles is absent', () => {
    const pending = mkPending();
    const handle: SlackChannelHandle = {
      workspace_slug: 'T1', channel_id: 'C1', message_ts: '123.456', posted_at: 1_000,
    };
    const updated = appendSlackHandle(pending, handle);
    expect(updated.channel_handles?.slack).toEqual([handle]);
    // Original untouched — pure helper.
    expect(pending.channel_handles).toBeUndefined();
  });

  it('appends alongside existing handles', () => {
    const existing: SlackChannelHandle = {
      workspace_slug: 'T1', channel_id: 'C1', message_ts: '100.000', posted_at: 500,
    };
    const pending = mkPending({ channel_handles: { slack: [existing] } });
    const handle: SlackChannelHandle = {
      workspace_slug: 'T2', channel_id: 'C2', message_ts: '200.000', posted_at: 1_000,
    };
    const updated = appendSlackHandle(pending, handle);
    expect(updated.channel_handles?.slack).toEqual([existing, handle]);
  });

  it('preserves telegram handles when appending slack', () => {
    const tg: TelegramChannelHandle = {
      chat_slug: 'tg-1', chat_id: 123, message_id: 456, posted_at: 500,
    };
    const pending = mkPending({ channel_handles: { telegram: [tg] } });
    const handle: SlackChannelHandle = {
      workspace_slug: 'T1', channel_id: 'C1', message_ts: '100.000', posted_at: 1_000,
    };
    const updated = appendSlackHandle(pending, handle);
    expect(updated.channel_handles?.telegram).toEqual([tg]);
    expect(updated.channel_handles?.slack).toEqual([handle]);
  });
});

describe('appendTelegramHandle', () => {
  it('appends without disturbing slack handles', () => {
    const sl: SlackChannelHandle = {
      workspace_slug: 'T1', channel_id: 'C1', message_ts: '100', posted_at: 500,
    };
    const pending = mkPending({ channel_handles: { slack: [sl] } });
    const handle: TelegramChannelHandle = {
      chat_slug: 'tg-1', chat_id: 999, message_id: 1, posted_at: 1_000,
    };
    const updated = appendTelegramHandle(pending, handle);
    expect(updated.channel_handles?.slack).toEqual([sl]);
    expect(updated.channel_handles?.telegram).toEqual([handle]);
  });
});

describe('markChannelUpdateDone', () => {
  it('sets slack flag without clobbering telegram', () => {
    const resolution = mkResolution({
      channel_updates_done: { telegram: true },
    });
    const updated = markChannelUpdateDone(resolution, 'slack');
    expect(updated.channel_updates_done).toEqual({ slack: true, telegram: true });
  });

  it('creates the flags object when absent', () => {
    const updated = markChannelUpdateDone(mkResolution(), 'slack');
    expect(updated.channel_updates_done).toEqual({ slack: true });
  });

  it('is idempotent when flag is already set', () => {
    const resolution = mkResolution({ channel_updates_done: { slack: true } });
    const updated = markChannelUpdateDone(resolution, 'slack');
    expect(updated.channel_updates_done).toEqual({ slack: true });
  });
});
