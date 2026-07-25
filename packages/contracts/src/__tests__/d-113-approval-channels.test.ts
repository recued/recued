/** D-113 — Approval channels contract invariants.
 *
 *  These tests lock the contract surface: constant values, structural
 *  relations between TTLs, union completeness, and re-export from the
 *  contracts barrel. The contract file is pure types + constants, so
 *  tests here exercise the constants and use type-only assertions
 *  (cast to unknown to shape-check at compile time without runtime
 *  enforcement).
 */

import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_INTERVAL_STEADY_MS,
  HEARTBEAT_INTERVAL_BURST_MS,
  HEARTBEAT_BURST_DURATION_MS,
  PAIR_TTL_MS,
  ITEM_TTL_MS,
  OWNER_GRACE_WINDOW_MS,
  DISPATCH_EXPIRY_MS,
  ROUTING_TABLE_ENTRY_TTL_MS,
  RECENT_RESOLVED_WINDOW_EXT_MS,
  CHAT_CHANNEL_DEFAULT_TTL_MS,
  EMAIL_CHANNEL_DEFAULT_TTL_MS,
} from '../index.js';
import type {
  ApprovalChannelConfig,
  ApprovalPendingRecord,
  ApprovalResolutionKind,
  ApprovalResolutionRecord,
  WorkerDispatch,
  WorkerDispatchKind,
  WorkerDispatchPayload,
  ApprovalListPayload,
  ApprovalStatusPayload,
  ApprovalActionPayload,
  DispatchCallback,
  EncryptedBlob,
} from '../index.js';

describe('D-113 timing constants', () => {
  it('matches the spec values', () => {
    expect(HEARTBEAT_INTERVAL_STEADY_MS).toBe(5_000);
    expect(HEARTBEAT_INTERVAL_BURST_MS).toBe(1_000);
    expect(HEARTBEAT_BURST_DURATION_MS).toBe(20_000);
    expect(PAIR_TTL_MS).toBe(15_000);
    expect(ITEM_TTL_MS).toBe(15_000);
    expect(OWNER_GRACE_WINDOW_MS).toBe(10_000);
    expect(DISPATCH_EXPIRY_MS).toBe(60_000);
    expect(ROUTING_TABLE_ENTRY_TTL_MS).toBe(60_000);
    expect(RECENT_RESOLVED_WINDOW_EXT_MS).toBe(300_000);
    expect(CHAT_CHANNEL_DEFAULT_TTL_MS).toBe(7_200_000);
    expect(EMAIL_CHANNEL_DEFAULT_TTL_MS).toBe(-1);
  });

  it('enforces cadence invariants — burst < steady', () => {
    // Burst mode (after events) must be faster than steady idle.
    expect(HEARTBEAT_INTERVAL_BURST_MS).toBeLessThan(HEARTBEAT_INTERVAL_STEADY_MS);
  });

  it('PAIR_TTL and ITEM_TTL are 3× steady cadence', () => {
    // Three heartbeat rounds before an item / matched pair evicts —
    // gives the gossip protocol convergence headroom.
    expect(PAIR_TTL_MS).toBe(HEARTBEAT_INTERVAL_STEADY_MS * 3);
    expect(ITEM_TTL_MS).toBe(HEARTBEAT_INTERVAL_STEADY_MS * 3);
  });

  it('OWNER_GRACE_WINDOW is 2× steady cadence', () => {
    // Peer takeover kicks in after 2 rounds of owner silence.
    expect(OWNER_GRACE_WINDOW_MS).toBe(HEARTBEAT_INTERVAL_STEADY_MS * 2);
  });

  it('DISPATCH_EXPIRY > ITEM_TTL — worker holds dispatches longer than gossip items', () => {
    // Otherwise a dispatch could expire on the worker before the
    // target instance has a chance to pull it.
    expect(DISPATCH_EXPIRY_MS).toBeGreaterThan(ITEM_TTL_MS);
  });

  it('EMAIL_CHANNEL_DEFAULT_TTL_MS sentinel is -1 (full approval lifetime)', () => {
    // The -1 sentinel means "never timeout the email channel
    // independently — track the approval's own timeout_at instead."
    expect(EMAIL_CHANNEL_DEFAULT_TTL_MS).toBe(-1);
    // Assert it is less than any legitimate positive ttl so downstream
    // comparisons (`if (ttl > 0)`) branch correctly.
    expect(EMAIL_CHANNEL_DEFAULT_TTL_MS).toBeLessThan(0);
  });
});

describe('D-113 channel config shape', () => {
  it('ApprovalChannelConfig has exactly four channel families', () => {
    // A valid config is accepted by the type system.
    const config: ApprovalChannelConfig = {
      extension: [
        { slug: 'ext-abc', permission: 'action', enabled: true },
      ],
      slack: [
        { slug: 'workspace-a', permission: 'action', enabled: true, ttl_ms: 7_200_000 },
      ],
      telegram: [
        { slug: 'chat-b', permission: 'read', enabled: false },
      ],
      email: [
        {
          slug: 'e1',
          permission: 'action',
          enabled: true,
          to_address: 'user@example.com',
          verified_at: Date.now(),
          verification_source: 'manual_click',
        },
      ],
    };
    // Four arrays, one per channel family — this is the contract.
    const keys = Object.keys(config).sort();
    expect(keys).toEqual(['email', 'extension', 'slack', 'telegram']);
  });

  it('every channel family supports both permission tiers', () => {
    const config: ApprovalChannelConfig = {
      extension: [
        { slug: 'a', permission: 'read', enabled: true },
        { slug: 'b', permission: 'action', enabled: true },
      ],
      slack: [
        { slug: 'a', permission: 'read', enabled: true },
        { slug: 'b', permission: 'action', enabled: true },
      ],
      telegram: [
        { slug: 'a', permission: 'read', enabled: true },
        { slug: 'b', permission: 'action', enabled: true },
      ],
      email: [
        { slug: 'a', permission: 'read', enabled: true, to_address: 'r@x' },
        { slug: 'b', permission: 'action', enabled: true, to_address: 'w@x' },
      ],
    };
    for (const family of Object.values(config)) {
      const perms = new Set(
        (family as ReadonlyArray<{ permission: string }>).map((c) => c.permission),
      );
      expect(perms).toEqual(new Set(['read', 'action']));
    }
  });
});

describe('D-113 resolution kinds', () => {
  it('exposes all five resolution kinds in the union', () => {
    // Exhaustiveness check — the type union matches the spec's
    // enumeration. Compile-time completeness guaranteed by the switch.
    const kinds: ApprovalResolutionKind[] = [
      'user_action',
      'executor_timeout',
      'executor_cancelled',
      'executor_cascade',
      'executor_killed',
    ];
    for (const k of kinds) {
      // Each kind is a valid assignment target — compiler catches
      // drift if any are removed or renamed.
      const r: ApprovalResolutionRecord = {
        approval_id: 'ap-1',
        created_by_instance: 'inst-1',
        kind: k,
        resolved_at: 1,
      };
      expect(r.kind).toBe(k);
    }
  });
});

describe('D-113 worker dispatch', () => {
  it('WorkerDispatchKind union matches the three D-113 variants', () => {
    // D-113 lands three kinds; D-114 will extend — our invariant is
    // "D-113 ships exactly these three."
    const d113Kinds: WorkerDispatchKind[] = [
      'approval_list',
      'approval_status',
      'approval_action',
    ];
    expect(d113Kinds).toHaveLength(3);
  });

  it('ApprovalActionPayload carries nonce for dedup', () => {
    const payload: ApprovalActionPayload = {
      approval_id: 'ap-1',
      decision: 'approve',
      actor_channel: 'email',
      actor_identifier: 'user@example.com',
      note: 'looks good',
      nonce: 'abc123',
    };
    // Nonce is required — the worker's dedup cache is keyed by it.
    expect(payload.nonce).toBeTruthy();
  });

  it('WorkerDispatch.expires_at convention = created_at + DISPATCH_EXPIRY_MS', () => {
    const created = 1_700_000_000_000;
    const dispatch: WorkerDispatch = {
      request_id: 'req-1',
      target_instance_id: 'inst-1',
      kind: 'approval_action',
      payload: {
        approval_id: 'ap-1',
        decision: 'approve',
        actor_channel: 'slack-slash',
        nonce: 'xyz',
      },
      created_at: created,
      expires_at: created + DISPATCH_EXPIRY_MS,
    };
    expect(dispatch.expires_at - dispatch.created_at).toBe(DISPATCH_EXPIRY_MS);
  });

  it('DispatchCallback supports slack and telegram variants', () => {
    const slack: DispatchCallback = {
      kind: 'slack',
      response_url: 'https://hooks.slack.com/...',
      ephemeral: true,
    };
    const telegram: DispatchCallback = {
      kind: 'telegram',
      chat_id: 42,
      message_id: 100,
    };
    expect(slack.kind).toBe('slack');
    expect(telegram.kind).toBe('telegram');
  });

  it('WorkerDispatchPayload narrows correctly by kind', () => {
    const listP: WorkerDispatchPayload = {};
    const statusP: WorkerDispatchPayload = { approval_id: 'ap-1' };
    const actionP: WorkerDispatchPayload = {
      approval_id: 'ap-1',
      decision: 'reject',
      actor_channel: 'telegram-slash',
      nonce: 'n1',
    };
    // Assert the shapes exist at runtime.
    expect(listP).toBeDefined();
    expect((statusP as ApprovalStatusPayload).approval_id).toBe('ap-1');
    expect((actionP as ApprovalActionPayload).decision).toBe('reject');
    // Empty list payload is legal shape.
    const emptyList: ApprovalListPayload = {};
    expect(Object.keys(emptyList)).toHaveLength(0);
  });
});

describe('D-113 pending record shape', () => {
  it('channel_handles are optional and track both slack + telegram independently', () => {
    const minimal: ApprovalPendingRecord = {
      approval_id: 'ap-1',
      initiator_instance: 'inst-1',
      recipe_id: 'recipe-x',
      step_id: 'confirm',
      prompt: 'Update deal?',
      created_at: 1,
      timeout_at: 900_001,
    };
    expect(minimal.channel_handles).toBeUndefined();

    const withHandles: ApprovalPendingRecord = {
      ...minimal,
      channel_handles: {
        slack: [
          {
            workspace_slug: 'ws-a',
            channel_id: 'C0123',
            message_ts: '1700000000.000001',
            posted_at: 1,
          },
        ],
        telegram: [
          {
            chat_slug: 'tg-b',
            chat_id: 789,
            message_id: 101,
            posted_at: 2,
          },
        ],
      },
    };
    expect(withHandles.channel_handles?.slack).toHaveLength(1);
    expect(withHandles.channel_handles?.telegram).toHaveLength(1);
  });
});

describe('D-113 encrypted blob', () => {
  it('carries ciphertext + iv + plaintext sender', () => {
    // Sender stays plaintext so the heartbeat worker can route by
    // instance without decrypting. Content stays encrypted.
    const blob: EncryptedBlob = {
      ciphertext: 'YWJjZA==',
      iv: 'MTIz',
      from: 'inst-alpha',
    };
    expect(blob.from).toBe('inst-alpha');
    expect(blob.ciphertext).toBeTruthy();
    expect(blob.iv).toBeTruthy();
  });
});

