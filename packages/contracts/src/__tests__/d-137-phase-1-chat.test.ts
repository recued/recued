/** D-137 P1 — AI Chat contracts.
 *
 *  Acceptance per spec § A.1.1 + § A.2 + § A.7 + § A.8 + § A.14 +
 *  § Wire A + § Must Hold (D-137-equivalent of D-149 Must Hold I-15):
 *   - 6 closed-list Tier 1 tool names + per-name topic_tags +
 *     classifications + descriptor table consistency.
 *   - 3 closed tool tiers (1 | 2 | 3) with predicate + set.
 *   - 2 closed dispatch channels (internal_function_call | mcp_wire)
 *     with predicate + set.
 *   - 9 closed dispatch reason codes covering not_implemented through
 *     execution_error; predicate + set; disjoint from generic event
 *     names.
 *   - 3 closed model routing layers (local | free_pool | byok); ladder
 *     order matches § A.14 precedence.
 *   - 4 closed message roles (user | assistant | tool | system).
 *   - 10 closed `chat.*` rpc method names per Wire A.
 *   - 7 closed `chat.*` broadcast event kinds per Wire A; registered in
 *     ALL_BROADCAST_EVENT_KINDS + DEFAULT_SUBSCRIPTIONS (paired clients
 *     get chat events by default per D-148 § A.1 / D-121 Phase 6).
 *   - 4 closed `chat.session_changed` field discriminators.
 *   - core chat tables (sessions, messages, durable reviewed actions);
 *     per-pair-only
 *     invariant (chat substrate never broadcast cross-cloud — D-097).
 *   - Tier 1 descriptor table is exhaustive over Tier1ToolName.
 */

import { describe, it, expect } from 'vitest';
import {
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
  type ServerRpcRegistry,
} from '../rpc/server-registry.js';
import type { RpcRequest, RpcResponse } from '../rpc/types.js';
import type { ServerEvent } from '../events.js';
import {
  ALL_BROADCAST_EVENT_KINDS,
  CHAT_BROADCAST_EVENT_KINDS,
  CHAT_BROADCAST_EVENT_KIND_SET,
  CHAT_DISPATCH_CHANNELS,
  CHAT_DISPATCH_CHANNEL_SET,
  CHAT_DISPATCH_REASONS,
  CHAT_DISPATCH_REASON_SET,
  CHAT_MESSAGE_ROLES,
  CHAT_MESSAGE_ROLE_SET,
  CHAT_MODEL_ROUTING_LAYERS,
  CHAT_MODEL_ROUTING_LAYER_SET,
  CHAT_PICKER_SELF,
  CHAT_RPC_METHODS,
  CHAT_RPC_METHOD_SET,
  CHAT_SESSION_CHANGED_FIELDS,
  CHAT_SESSION_CHANGED_FIELD_SET,
  CHAT_TABLES,
  CHAT_TABLE_SET,
  DEFAULT_SUBSCRIPTIONS,
  TIER1_CLASSIFICATIONS,
  TIER1_CONCURRENCY_SAFE,
  TIER1_TOOL_DESCRIPTORS,
  TIER1_TOOL_NAMES,
  TIER1_TOOL_NAME_SET,
  TIER1_TOPIC_TAGS,
  TOOL_TIERS,
  TOOL_TIER_SET,
  isChatBroadcastEventKind,
  isChatDispatchChannel,
  isChatDispatchReason,
  isChatMessageRole,
  isChatModelRoutingLayer,
  isChatRpcMethod,
  isChatSessionChangedField,
  isTier1ToolName,
  isToolTier,
  type Tier1ToolName,
  type ToolTier,
} from '../index.js';

describe('D-137 P1 — TIER1_TOOL_NAMES closed list (§ A.1.1)', () => {
  // D-137 P2 § A.4 — `deal.search` widened the closed list from six to seven as
  // the CRM-side scope-search primitive; D-190 adds `account.search` (the CRM
  // account/company/organization lens), bringing it to eight; D-192 read
  // resolution adds the work-entity pair `work.search` + `work.read` (local
  // rich meta + bounded targeted vendor escalation), bringing it to ten; D-198
  // adds `memory.write` (the durable-save half of the shared memory pool),
  // bringing it to eleven. The order mirrors `Tier1ToolName`'s declaration order
  // in `chat.ts`.
  const expected: ReadonlyArray<Tier1ToolName> = [
    'contact.search',
    'mail.search',
    'calendar.search',
    'memory.search',
    'memory.write',
    'enrichment.search',
    'deal.search',
    'account.search',
    'work.search',
    'work.read',
    'recipe.run',
  ];

  it('lists exactly eleven canonical primitives in spec order (P1 six + deal/account.search + work.search/read + memory.write)', () => {
    expect(TIER1_TOOL_NAMES).toEqual(expected);
  });

  it('TIER1_TOOL_NAME_SET contains every entry', () => {
    for (const name of TIER1_TOOL_NAMES) {
      expect(TIER1_TOOL_NAME_SET.has(name)).toBe(true);
    }
    expect(TIER1_TOOL_NAME_SET.size).toBe(TIER1_TOOL_NAMES.length);
  });

  it('isTier1ToolName accepts every member + rejects unknown', () => {
    for (const name of TIER1_TOOL_NAMES) {
      expect(isTier1ToolName(name)).toBe(true);
    }
    expect(isTier1ToolName('mail.send')).toBe(false); // P3-deferred (write)
    expect(isTier1ToolName('')).toBe(false);
    expect(isTier1ToolName(null)).toBe(false);
    expect(isTier1ToolName(undefined)).toBe(false);
    expect(isTier1ToolName(42)).toBe(false);
    expect(isTier1ToolName({})).toBe(false);
  });

  it('every Tier 1 name has matching topic_tags + classification', () => {
    for (const name of TIER1_TOOL_NAMES) {
      expect(TIER1_TOPIC_TAGS[name]).toBeDefined();
      expect(TIER1_TOPIC_TAGS[name].length).toBeGreaterThan(0);
      expect(TIER1_CLASSIFICATIONS[name]).toBeDefined();
    }
  });

  it('search primitives are read-classified; recipe.run + memory.write are unknown', () => {
    // Semantic ratchet (codex LOW): EVERY read primitive is asserted
    // explicitly — a future flip of one entry (+ a mirrored descriptor)
    // must fail here, not slip through the exhaustiveness-only checks.
    expect(TIER1_CLASSIFICATIONS['contact.search']).toBe('read');
    expect(TIER1_CLASSIFICATIONS['mail.search']).toBe('read');
    expect(TIER1_CLASSIFICATIONS['calendar.search']).toBe('read');
    expect(TIER1_CLASSIFICATIONS['memory.search']).toBe('read');
    expect(TIER1_CLASSIFICATIONS['enrichment.search']).toBe('read');
    expect(TIER1_CLASSIFICATIONS['deal.search']).toBe('read');
    expect(TIER1_CLASSIFICATIONS['account.search']).toBe('read');
    expect(TIER1_CLASSIFICATIONS['work.search']).toBe('read');
    expect(TIER1_CLASSIFICATIONS['work.read']).toBe('read');
    expect(TIER1_CLASSIFICATIONS['recipe.run']).toBe('unknown');
    // D-198 — memory.write is deliberately `unknown` (NOT `write`): a soft,
    // reversible, grant-gated write that bypasses P3 plan-approval so a granted
    // customer can contribute autonomously (§3). See TIER1_CLASSIFICATIONS doc.
    expect(TIER1_CLASSIFICATIONS['memory.write']).toBe('unknown');
  });

  it('read primitives batch-safe; recipe.run sequential (D-164 § 6)', () => {
    for (const name of TIER1_TOOL_NAMES) {
      expect(TIER1_CONCURRENCY_SAFE[name]).toBe(name !== 'recipe.run');
    }
  });
});

describe('D-137 P1 — TIER1_TOOL_DESCRIPTORS exhaustive over Tier1ToolName', () => {
  it('descriptor table has one entry per Tier 1 name', () => {
    for (const name of TIER1_TOOL_NAMES) {
      const descriptor = TIER1_TOOL_DESCRIPTORS[name];
      expect(descriptor).toBeDefined();
      expect(descriptor.name).toBe(name);
      expect(descriptor.classification).toBe(TIER1_CLASSIFICATIONS[name]);
      expect(descriptor.topic_tags).toEqual(TIER1_TOPIC_TAGS[name]);
      expect(typeof descriptor.description).toBe('string');
      expect(descriptor.description.length).toBeGreaterThan(0);
    }
  });

  it('descriptor keys equal Tier 1 name closed list', () => {
    const descriptorKeys = Object.keys(TIER1_TOOL_DESCRIPTORS).sort();
    const tierNames = [...TIER1_TOOL_NAMES].sort();
    expect(descriptorKeys).toEqual(tierNames);
  });
});

// ────────────────────────────────────────────────────────────────
// D-164 § 6 — per-Tier-1 batch-dispatch safety ratchet.
//
// `TIER1_CONCURRENCY_SAFE` parallels `TIER1_CLASSIFICATIONS` and
// `TIER1_TOPIC_TAGS`: a closed-list per-name boolean that seeds
// `ToolEntry.concurrency_safe` on every projected Tier 1 entry. The
// catalog substrate + framework dispatch primitive read the per-tool
// value off the projected entry; this table is the source of truth
// they pull from.
// ────────────────────────────────────────────────────────────────

describe('D-164 § 6 — TIER1_CONCURRENCY_SAFE', () => {
  it('has one entry per Tier 1 name (exhaustive)', () => {
    const tableKeys = Object.keys(TIER1_CONCURRENCY_SAFE).sort();
    const tierNames = [...TIER1_TOOL_NAMES].sort();
    expect(tableKeys).toEqual(tierNames);
  });

  it('every `*.search` primitive declares true (local warehouse reads are idempotent)', () => {
    expect(TIER1_CONCURRENCY_SAFE['contact.search']).toBe(true);
    expect(TIER1_CONCURRENCY_SAFE['mail.search']).toBe(true);
    expect(TIER1_CONCURRENCY_SAFE['calendar.search']).toBe(true);
    expect(TIER1_CONCURRENCY_SAFE['memory.search']).toBe(true);
    expect(TIER1_CONCURRENCY_SAFE['enrichment.search']).toBe(true);
    expect(TIER1_CONCURRENCY_SAFE['deal.search']).toBe(true);
  });

  it('`recipe.run` umbrella declares false (per-recipe concurrency is unknown at umbrella level)', () => {
    expect(TIER1_CONCURRENCY_SAFE['recipe.run']).toBe(false);
  });

  it('TIER1_TOOL_DESCRIPTORS.<name>.concurrency_safe matches TIER1_CONCURRENCY_SAFE[name]', () => {
    // Single source of truth invariant — descriptor projection MUST
    // mirror the closed-list table. A future Tier 1 widening edits
    // both in tandem, or this ratchet fires.
    for (const name of TIER1_TOOL_NAMES) {
      expect(TIER1_TOOL_DESCRIPTORS[name].concurrency_safe).toBe(
        TIER1_CONCURRENCY_SAFE[name],
      );
    }
  });
});

describe('D-137 P1 — TOOL_TIERS closed list (§ A.1.1)', () => {
  it('lists 1 | 2 | 3 in tier order', () => {
    expect(TOOL_TIERS).toEqual([1, 2, 3]);
    expect(TOOL_TIER_SET.size).toBe(3);
  });

  it('isToolTier accepts every tier + rejects unknown', () => {
    for (const tier of TOOL_TIERS as ReadonlyArray<ToolTier>) {
      expect(isToolTier(tier)).toBe(true);
    }
    expect(isToolTier(0)).toBe(false);
    expect(isToolTier(4)).toBe(false);
    expect(isToolTier('1' as unknown)).toBe(false);
    expect(isToolTier(null)).toBe(false);
  });
});

describe('D-137 P1 — CHAT_DISPATCH_CHANNELS closed list (§ A.1.1)', () => {
  it('lists exactly two channels (internal_function_call | mcp_wire)', () => {
    expect(CHAT_DISPATCH_CHANNELS).toEqual([
      'internal_function_call',
      'mcp_wire',
    ]);
    expect(CHAT_DISPATCH_CHANNEL_SET.size).toBe(2);
  });

  it('isChatDispatchChannel accepts every channel + rejects unknown', () => {
    for (const channel of CHAT_DISPATCH_CHANNELS) {
      expect(isChatDispatchChannel(channel)).toBe(true);
    }
    expect(isChatDispatchChannel('bridge_command')).toBe(false);
    expect(isChatDispatchChannel('webhook')).toBe(false);
    expect(isChatDispatchChannel('')).toBe(false);
    expect(isChatDispatchChannel(null)).toBe(false);
  });
});

describe('D-137 P1 — CHAT_DISPATCH_REASONS closed list (§ A.1.1)', () => {
  it('lists exactly twelve reason codes (P1: 9 + P3 plan-approval: 2 + D-181 run-cancel: 1)', () => {
    expect(CHAT_DISPATCH_REASONS).toEqual([
      'not_implemented',
      'unknown_tool',
      'invalid_args',
      'channel_denied',
      'kind_gated',
      'classification_blocked',
      'connection_unavailable',
      'capacity_gap',
      'execution_error',
      // D-137 P3 § A.11 — write dispatched before Mary approved.
      'awaiting_approval',
      // D-137 P3 § A.11 — Mary explicitly cancelled the proposal.
      'plan_cancelled',
      // D-181 § 9 — the owner killed / cancelled-in-queue the dispatched run.
      'run_cancelled',
    ]);
    expect(CHAT_DISPATCH_REASON_SET.size).toBe(12);
  });

  it('isChatDispatchReason accepts every reason + rejects unknown', () => {
    for (const reason of CHAT_DISPATCH_REASONS) {
      expect(isChatDispatchReason(reason)).toBe(true);
    }
    expect(isChatDispatchReason('rate_limited')).toBe(false);
    expect(isChatDispatchReason('forbidden')).toBe(false);
    expect(isChatDispatchReason(null)).toBe(false);
  });

  it('not_implemented sentinel reserved for P1 stub handlers', () => {
    expect(CHAT_DISPATCH_REASON_SET.has('not_implemented')).toBe(true);
  });
});

describe('D-137 P1 — CHAT_MODEL_ROUTING_LAYERS ladder (§ A.14)', () => {
  it('is the 2-value routing vocabulary free_pool → byok (D-191 retired local)', () => {
    expect(CHAT_MODEL_ROUTING_LAYERS).toEqual([
      'free_pool',
      'byok',
    ]);
    expect(CHAT_MODEL_ROUTING_LAYER_SET.size).toBe(2);
  });

  it('isChatModelRoutingLayer accepts every layer + rejects unknown', () => {
    for (const layer of CHAT_MODEL_ROUTING_LAYERS) {
      expect(isChatModelRoutingLayer(layer)).toBe(true);
    }
    expect(isChatModelRoutingLayer('recued_inference')).toBe(false); // Recued bears no inference cost
    expect(isChatModelRoutingLayer('')).toBe(false);
  });
});

describe('D-137 P1 — CHAT_PICKER_SELF sentinel (§ A.7)', () => {
  it('default picker target is the literal string "self"', () => {
    expect(CHAT_PICKER_SELF).toBe('self');
  });
});

describe('D-137 P1 — CHAT_MESSAGE_ROLES closed list (§ Contract Tightening)', () => {
  it('lists exactly four roles', () => {
    expect(CHAT_MESSAGE_ROLES).toEqual([
      'user',
      'assistant',
      'tool',
      'system',
    ]);
    expect(CHAT_MESSAGE_ROLE_SET.size).toBe(4);
  });

  it('isChatMessageRole accepts every role + rejects unknown', () => {
    for (const role of CHAT_MESSAGE_ROLES) {
      expect(isChatMessageRole(role)).toBe(true);
    }
    expect(isChatMessageRole('agent')).toBe(false);
    expect(isChatMessageRole('observer')).toBe(false);
    expect(isChatMessageRole(null)).toBe(false);
  });
});

describe('D-137 P1 — CHAT_RPC_METHODS closed list (§ Wire A)', () => {
  it('lists every chat method, including D-214 feedback and diagnostics', () => {
    expect(CHAT_RPC_METHODS).toEqual([
      'chat.sessions.list',
      'chat.session.get',
      'chat.session.create',
      'chat.session.delete',
      'chat.session.export',
      // D-167 transparency — read back the aliased "what we sent" egress history.
      'chat.egress.get',
      'chat.send',
      'chat.data_diagnosis.resolve',
      'chat.plans.pending.list',
      'chat.plan.approve',
      'chat.plan.cancel',
      'chat.execution.feedback',
      'chat.execution.feedback.retract',
      'chat.execution.diagnostics',
      'chat.session.set_picker',
      'chat.session.set_model_pref',
      // D-167 chat provider-threading — per-session override lifecycle +
      // the per-pair global default it inherits from.
      'chat.session.clear_model_pref',
      'chat.default_model_pref.get',
      'chat.default_model_pref.set',
      'chat.tool_catalog.get',
      'chat.tool_catalog.set',
      'chat.connection_mcp.list',
      'chat.connection_mcp.get',
      'chat.connection_mcp.set',
      // D-137 P4 § A.7 + § A.7.1 — picker entry projection + refresh.
      'chat.picker.entries',
      'chat.picker.refresh',
      // D-137 P5 follow-on § A.9 — Bob's per-pair inbound MCP token
      // registry. Six methods; reserved local-UI only via
      // `chat.inbound_token.` prefix in `MCP_RESERVED_RPC_PREFIXES`.
      'chat.inbound_token.list',
      'chat.inbound_token.get',
      'chat.inbound_token.issue',
      'chat.inbound_token.update_grants',
      // D-171 slice 3 — rebind the bound contract_id in place (lazy cap/expiry).
      'chat.inbound_token.update_contract',
      'chat.inbound_token.revoke',
      'chat.inbound_token.delete',
      // D-171 slice 2c — the grant checklist's live self tool catalog.
      'chat.inbound_token.tool_catalog',
    ]);
    expect(CHAT_RPC_METHOD_SET.size).toBe(34);
  });

  it('isChatRpcMethod accepts every method + rejects unknown', () => {
    for (const method of CHAT_RPC_METHODS) {
      expect(isChatRpcMethod(method)).toBe(true);
    }
    expect(isChatRpcMethod('chat.session.archive')).toBe(false); // not at P1
    expect(isChatRpcMethod('chat.tool.list')).toBe(false); // Tier 1+2+3 enumeration via session.get
    expect(isChatRpcMethod('')).toBe(false);
  });

  it('every chat method registered in SERVER_RPC_METHODS dispatcher list', () => {
    // Without this every `chat.*` request lands as `unknown_method`
    // even when the per-method handler ships. The closed list in
    // `chat.ts` is the contract; the dispatcher's known-method list in
    // `rpc/server-registry.ts` must mirror it.
    for (const method of CHAT_RPC_METHODS) {
      expect(SERVER_RPC_METHODS).toContain(method);
      expect(SERVER_RPC_METHOD_SET.has(method)).toBe(true);
    }
  });

  it('types verify-before-retry correlation on chat.send', () => {
    const request: RpcRequest<ServerRpcRegistry, 'chat.send'> = {
      session_id: 'session_1',
      message: 'Verify the prior outcome before trying again.',
      picker_state: { current: 'self' },
      retry_of_plan_id: 'plan_uncertain',
    };
    expect(request.retry_of_plan_id).toBe('plan_uncertain');
  });

  it('types the all-session pending-plan recovery response', () => {
    const response: RpcResponse<
      ServerRpcRegistry,
      'chat.plans.pending.list'
    > = { plans: [] };
    expect(response.plans).toEqual([]);
  });
});

describe('D-137 P1 — CHAT_BROADCAST_EVENT_KINDS closed list (§ Wire A)', () => {
  const expected = [
    'chat.token_streamed',
    'chat.tool_call_started',
    'chat.tool_call_completed',
    'chat.plan_proposed',
    'chat.transparency',
    'chat.message_complete',
    'chat.data_diagnosis_resolved',
    'chat.session_changed',
    // D-137 W2.2 — per-kind catalog scope changed (Mary toggled in
    // Settings → Chat → Tool Catalog Scope).
    'chat.tool_catalog_scope_changed',
    // D-167 chat provider-threading — per-pair global chat-model default
    // changed (non-session-scoped; re-renders inherited session badges).
    'chat.default_model_pref_changed',
    // D-137 W2.3 — per-connection MCP tool annotation changed (Mary
    // saved a classification batch in Settings → Connections →
    // <name> → Tools).
    'chat.connection_mcp_annotation_changed',
    // D-137 P3 § A.5 Pattern 3 — disambiguation surface (chips OR
    // open question; scope-search returned plausible-but-ambiguous
    // candidates).
    'chat.disambiguation_proposed',
    // D-137 P3 § A.11 — plan resolved (Mary approved / cancelled a
    // pending write proposal).
    'chat.plan_resolved',
    // D-137 P4 § A.7.1 — picker entries changed (annotation write or
    // chat.picker.refresh that shifts picker visibility).
    'chat.picker_entries_changed',
    // D-137 P5 follow-on § A.9 — inbound-token registry mutated. Fans
    // the canonical record (sans bearer plaintext) on every issue /
    // update_grants / revoke / delete so paired clients re-render the
    // Settings → MCP Tokens table without a follow-up `list`.
    'chat.inbound_token_changed',
  ];

  it('lists exactly fifteen event kinds, including safe-check closure', () => {
    expect(CHAT_BROADCAST_EVENT_KINDS).toEqual(expected);
    expect(CHAT_BROADCAST_EVENT_KIND_SET.size).toBe(15);
  });

  it('isChatBroadcastEventKind accepts every kind + rejects unknown', () => {
    for (const kind of CHAT_BROADCAST_EVENT_KINDS) {
      expect(isChatBroadcastEventKind(kind)).toBe(true);
    }
    expect(isChatBroadcastEventKind('chat.error')).toBe(false);
    expect(isChatBroadcastEventKind('memory')).toBe(false);
    expect(isChatBroadcastEventKind(null)).toBe(false);
  });

  it('all seven chat kinds registered in ALL_BROADCAST_EVENT_KINDS', () => {
    for (const kind of CHAT_BROADCAST_EVENT_KINDS) {
      expect(ALL_BROADCAST_EVENT_KINDS).toContain(kind);
    }
  });

  it('all seven chat kinds in DEFAULT_SUBSCRIPTIONS (paired clients auto-subscribe)', () => {
    for (const kind of CHAT_BROADCAST_EVENT_KINDS) {
      expect(DEFAULT_SUBSCRIPTIONS).toContain(kind);
    }
  });
});

describe('D-137 P1 — chat.tool_call_completed status-discriminated shape (§ Wire A)', () => {
  it('status:"ok" carries a required result_ref', () => {
    const ok: ServerEvent = {
      kind: 'chat.tool_call_completed',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      tool_name: 'contact.search',
      tier: 1,
      status: 'ok',
      result_ref: 'ref-abc',
      run_id: 'run-abc',
      cursor: 5,
    };
    expect(ok.kind).toBe('chat.tool_call_completed');
    if (ok.kind === 'chat.tool_call_completed' && ok.status === 'ok') {
      expect(ok.result_ref).toBe('ref-abc');
      expect(ok.run_id).toBe('run-abc');
    }
  });

  it('status:"error" carries a required reason from CHAT_DISPATCH_REASONS', () => {
    const err: ServerEvent = {
      kind: 'chat.tool_call_completed',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      tool_name: 'contact.search',
      tier: 1,
      status: 'error',
      reason: 'not_implemented',
      cursor: 6,
    };
    if (err.kind === 'chat.tool_call_completed' && err.status === 'error') {
      // The narrowed branch types `reason` as ChatDispatchReason; runtime
      // sanity-check that it's a closed-list member.
      expect(CHAT_DISPATCH_REASONS).toContain(err.reason);
    }
  });

  it('status:"error" reason narrowing rejects unknown strings at the type', () => {
    // This block compiles iff `reason: ChatDispatchReason`; substituting
    // a non-closed string would fail at tsc. The runtime assertion below
    // exercises every closed-list member to keep the body live.
    for (const reason of CHAT_DISPATCH_REASONS) {
      const err: ServerEvent = {
        kind: 'chat.tool_call_completed',
        session_id: 'sess-1',
        turn_id: 'turn-1',
        tool_name: 'mail.search',
        tier: 1,
        status: 'error',
        reason,
        cursor: 7,
      };
      if (err.kind === 'chat.tool_call_completed' && err.status === 'error') {
        expect(err.reason).toBe(reason);
      }
    }
  });

  it('links a consumed approval across started/completed events and distinguishes a held run', () => {
    const started: ServerEvent = {
      kind: 'chat.tool_call_started',
      session_id: 'sess-1',
      turn_id: 'turn-2',
      tool_name: 'mail.send',
      tier: 1,
      args: { to: 'mary@example.com' },
      plan_id: 'plan-1',
      cursor: 8,
    };
    const held: ServerEvent = {
      kind: 'chat.tool_call_completed',
      session_id: 'sess-1',
      turn_id: 'turn-2',
      tool_name: 'mail.send',
      tier: 1,
      status: 'ok',
      result_ref: 'ref-held',
      run_held: 'approval',
      plan_id: 'plan-1',
      cursor: 9,
    };

    expect(started.plan_id).toBe('plan-1');
    if (held.kind === 'chat.tool_call_completed' && held.status === 'ok') {
      expect(held.plan_id).toBe('plan-1');
      expect(held.run_held).toBe('approval');
    }
  });
});

describe('D-137 P1 — CHAT_SESSION_CHANGED_FIELDS closed list (§ Wire A)', () => {
  it('lists exactly four field discriminators', () => {
    expect(CHAT_SESSION_CHANGED_FIELDS).toEqual([
      'picker',
      'model_pref',
      'title',
      'archived',
    ]);
    expect(CHAT_SESSION_CHANGED_FIELD_SET.size).toBe(4);
  });

  it('isChatSessionChangedField accepts every field + rejects unknown', () => {
    for (const field of CHAT_SESSION_CHANGED_FIELDS) {
      expect(isChatSessionChangedField(field)).toBe(true);
    }
    expect(isChatSessionChangedField('settings')).toBe(false);
    expect(isChatSessionChangedField('')).toBe(false);
  });
});

describe('D-137 P1 — CHAT_TABLES inventory', () => {
  it('lists the core thread tables plus durable reviewed-action recovery', () => {
    expect(CHAT_TABLES).toEqual([
      'chat_sessions',
      'chat_messages',
      'chat_plans',
    ]);
    expect(CHAT_TABLE_SET.size).toBe(3);
  });
});
