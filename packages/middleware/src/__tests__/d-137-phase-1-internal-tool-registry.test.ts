/** D-137 P1 — InternalToolRegistry substrate.
 *
 *  Acceptance per spec § A.1.1 + § A.2:
 *   - Factory returns a registry seeded with the closed Tier 1
 *     catalog (6 entries) — `list()` length + `listByTier(1)` parity.
 *   - `listByTier(2)` + `listByTier(3)` return empty at P1 (Tier 2 +
 *     Tier 3 enumeration lands in Wave 2).
 *   - `getByName` accepts every Tier 1 name; returns null on unknown.
 *   - `dispatch` returns `{ ok: false, reason: 'not_implemented' }`
 *     for every Tier 1 entry by default (P1 stub handlers).
 *   - `dispatch` rejects unknown tools with reason `unknown_tool`.
 *   - Channel-isolation invariant: internal_function_call requires
 *     `session_id` + forbids `mcp_token_id`; mcp_wire requires
 *     `mcp_token_id` + forbids `session_id`; violations resolve
 *     `{ ok: false, reason: 'channel_denied' }`.
 *   - Per-Tier-1 handler overrides take precedence over the default
 *     stub; missing-name overrides are ignored (defensive).
 *   - `subscribeRefresh` returns an unsubscribe handle; calling it
 *     removes the listener from the internal subscriber set
 *     (substrate hook; emit landings come with the per-primitive
 *     wiring slice).
 */

import { describe, it, expect } from 'vitest';
import {
  CHAT_DISPATCH_REASONS,
  TIER1_CONCURRENCY_SAFE,
  TIER1_TOOL_NAMES,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type Tier1ToolName,
} from '@recued/contracts';
import {
  createInternalToolRegistry,
  tier1ToolNames,
  type Tier1Handler,
} from '../internal-tool-registry/index.js';

const ctxInternal = (session_id = 'sess-1', turn_id = 'turn-1'): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id,
  turn_id,
});

const ctxMcpWire = (mcp_token_id = 'token-1'): ChatDispatchContext => ({
  channel: 'mcp_wire',
  mcp_token_id,
});

describe('D-137 P1 — createInternalToolRegistry: Tier 1 catalog (§ A.1.1)', () => {
  it('list() returns the closed Tier 1 catalog (six entries)', () => {
    const registry = createInternalToolRegistry();
    const entries = registry.list();
    expect(entries.length).toBe(TIER1_TOOL_NAMES.length);
    expect(entries.map((e) => e.name).sort()).toEqual(
      [...TIER1_TOOL_NAMES].sort(),
    );
    for (const entry of entries) {
      expect(entry.tier).toBe(1);
    }
  });

  it('listByTier(1) equals list() at P1 (no Tier 2/3 entries yet)', () => {
    const registry = createInternalToolRegistry();
    expect(registry.listByTier(1)).toEqual(registry.list());
  });

  it('listByTier(2) + listByTier(3) return empty at P1', () => {
    const registry = createInternalToolRegistry();
    expect(registry.listByTier(2)).toEqual([]);
    expect(registry.listByTier(3)).toEqual([]);
  });

  it('getByName accepts every Tier 1 name; returns null on unknown', () => {
    const registry = createInternalToolRegistry();
    for (const name of TIER1_TOOL_NAMES) {
      const entry = registry.getByName(name);
      expect(entry).not.toBeNull();
      expect(entry?.name).toBe(name);
      expect(entry?.tier).toBe(1);
    }
    // D-137 P2 widened the Tier 1 closed list to include `deal.search`;
    // P3-deferred write primitives still resolve null.
    expect(registry.getByName('mail.send')).toBeNull(); // P3-deferred
    expect(registry.getByName('')).toBeNull();
  });

  it('tier1ToolNames re-export agrees with the contract-level closed list', () => {
    expect(tier1ToolNames()).toEqual(TIER1_TOOL_NAMES);
  });

  // D-164 § 6 — buildTier1Catalog propagates the descriptor's
  // `concurrency_safe` onto every projected ToolEntry. The dispatch
  // primitive + catalog substrate read off the entry, so the projector
  // is the binding seam between the closed-list table and the runtime
  // consumer.
  it('projects concurrency_safe from TIER1_CONCURRENCY_SAFE onto every Tier 1 entry', () => {
    const registry = createInternalToolRegistry();
    for (const entry of registry.list()) {
      expect(entry.concurrency_safe).toBe(
        TIER1_CONCURRENCY_SAFE[entry.name as Tier1ToolName],
      );
    }
  });

  it('getByName returns an entry carrying the canonical concurrency_safe value', () => {
    const registry = createInternalToolRegistry();
    for (const name of TIER1_TOOL_NAMES) {
      const entry = registry.getByName(name);
      expect(entry?.concurrency_safe).toBe(TIER1_CONCURRENCY_SAFE[name]);
    }
  });
});

describe('D-137 P1 — dispatch default not_implemented stubs', () => {
  it('every Tier 1 entry resolves not_implemented by default', async () => {
    const registry = createInternalToolRegistry();
    for (const name of TIER1_TOOL_NAMES) {
      const result = await registry.dispatch(name, {}, ctxInternal());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_implemented');
      }
    }
  });

  it('unknown tool resolves unknown_tool', async () => {
    const registry = createInternalToolRegistry();
    // D-137 P2 promoted `deal.search` into the closed list. Use a
    // genuinely unknown tool name to assert the unknown_tool path.
    const result = await registry.dispatch('definitely.unknown', {}, ctxInternal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown_tool');
      expect(CHAT_DISPATCH_REASONS).toContain(result.reason);
    }
  });
});

describe('D-137 P1 — channel-isolation invariant (§ A.2)', () => {
  const tool: Tier1ToolName = 'contact.search';

  it('internal_function_call requires session_id', async () => {
    const registry = createInternalToolRegistry();
    const ctx: ChatDispatchContext = {
      channel: 'internal_function_call',
    };
    const result = await registry.dispatch(tool, {}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('channel_denied');
  });

  it('internal_function_call forbids mcp_token_id (channel leak)', async () => {
    const registry = createInternalToolRegistry();
    const ctx: ChatDispatchContext = {
      channel: 'internal_function_call',
      session_id: 'sess-1',
      mcp_token_id: 'token-leak',
    };
    const result = await registry.dispatch(tool, {}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('channel_denied');
  });

  it('mcp_wire requires mcp_token_id', async () => {
    const registry = createInternalToolRegistry();
    const ctx: ChatDispatchContext = {
      channel: 'mcp_wire',
    };
    const result = await registry.dispatch(tool, {}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('channel_denied');
  });

  it('mcp_wire forbids session_id (channel leak)', async () => {
    const registry = createInternalToolRegistry();
    const ctx: ChatDispatchContext = {
      channel: 'mcp_wire',
      mcp_token_id: 'token-1',
      session_id: 'sess-leak',
    };
    const result = await registry.dispatch(tool, {}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('channel_denied');
  });

  it('mcp_wire forbids turn_id (channel leak)', async () => {
    const registry = createInternalToolRegistry();
    const ctx: ChatDispatchContext = {
      channel: 'mcp_wire',
      mcp_token_id: 'token-1',
      turn_id: 'turn-leak',
    };
    const result = await registry.dispatch(tool, {}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('channel_denied');
  });

  it('unknown channel string rejected at guard', async () => {
    const registry = createInternalToolRegistry();
    const ctx = {
      channel: 'bridge_command' as unknown,
    } as ChatDispatchContext;
    const result = await registry.dispatch(tool, {}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('channel_denied');
  });

  it('valid internal_function_call ctx reaches the stub handler', async () => {
    const registry = createInternalToolRegistry();
    const result = await registry.dispatch(tool, {}, ctxInternal());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_implemented');
  });

  it('valid mcp_wire ctx reaches the stub handler', async () => {
    const registry = createInternalToolRegistry();
    const result = await registry.dispatch(tool, {}, ctxMcpWire());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_implemented');
  });
});

describe('D-137 P1 — handler overrides', () => {
  it('overrides take precedence over the default stub', async () => {
    const calls: Array<{ name: string; ctx: ChatDispatchContext }> = [];
    const overrideHandler: Tier1Handler = async (_args, ctx) => {
      calls.push({ name: 'contact.search', ctx });
      return { ok: true, result: { hits: 0 } } satisfies ChatDispatchResult;
    };
    const registry = createInternalToolRegistry({
      tier1Handlers: {
        'contact.search': overrideHandler,
      },
    });
    const ctx = ctxInternal('sess-1', 'turn-1');
    const result = await registry.dispatch('contact.search', { q: 'Peter' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ hits: 0 });
    }
    expect(calls).toHaveLength(1);
  });

  it('un-overridden entries still resolve not_implemented', async () => {
    const overrideHandler: Tier1Handler = async () => ({
      ok: true,
      result: { hits: 0 },
    });
    const registry = createInternalToolRegistry({
      tier1Handlers: {
        'contact.search': overrideHandler,
      },
    });
    const result = await registry.dispatch('mail.search', {}, ctxInternal());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_implemented');
  });

  it('override map with non-Tier1 keys is silently ignored', async () => {
    const registry = createInternalToolRegistry({
      tier1Handlers: {
        'mail.send': (async () => ({ ok: true, result: null })) as Tier1Handler,
      } as Partial<Record<Tier1ToolName, Tier1Handler>>,
    });
    // mail.send still resolves unknown_tool (it's not a registered Tier 1 name).
    const result = await registry.dispatch('mail.send', {}, ctxInternal());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_tool');
  });

  it('list hides audit-marked irrelevant Tier 1 tools only while unbacked', async () => {
    const backedHandler: Tier1Handler = async () => ({
      ok: true,
      result: { hits: 0 },
    });
    const registry = createInternalToolRegistry({
      hiddenUnbackedTier1Tools: ['recipe.run'],
      tier1Handlers: {
        'contact.search': backedHandler,
      },
    });
    const listedNames = registry.list().map((entry) => entry.name);
    expect(listedNames).toContain('contact.search');
    expect(listedNames).not.toContain('recipe.run');
    expect(registry.listByTier(1).map((entry) => entry.name)).not.toContain(
      'recipe.run',
    );
    expect(registry.getByName('recipe.run')?.name).toBe('recipe.run');
    const result = await registry.dispatch('recipe.run', {}, ctxInternal());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_implemented');
  });

  it('list keeps an audit-marked Tier 1 tool once a handler override backs it', () => {
    const backedHandler: Tier1Handler = async () => ({
      ok: true,
      result: { run_id: 'run-1' },
    });
    const registry = createInternalToolRegistry({
      hiddenUnbackedTier1Tools: ['recipe.run'],
      tier1Handlers: {
        'recipe.run': backedHandler,
      },
    });
    expect(registry.list().map((entry) => entry.name)).toContain('recipe.run');
  });
});

describe('D-137 P1 — subscribeRefresh substrate hook', () => {
  it('returns a function that removes the listener', () => {
    const registry = createInternalToolRegistry();
    let fired = 0;
    const unsubscribe = registry.subscribeRefresh(() => {
      fired += 1;
    });
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    // Re-subscribing after unsubscribe should also succeed without throwing.
    const unsub2 = registry.subscribeRefresh(() => {
      fired += 100;
    });
    unsub2();
    expect(fired).toBe(0); // no emit path in P1 substrate
  });
});

// ════════════════════════════════════════════════════════════════════
// D-228 slice 5 — the contract gates Tier-1 primitives on the chat channel
// ════════════════════════════════════════════════════════════════════

/** ⛔⛔ THE LAST UNGATED SEAM, and the one I twice recorded as impossible to
 *  gate. I had read `ChatDispatchContext.execution_source`'s doc — *"undefined
 *  on dispatch paths whose producer hasn't been wired yet
 *  (internal_function_call today)"* — and concluded there was no contract to
 *  resolve here. The comment is STALE: `buildInternalDispatchCtx` always sets
 *  `execution_source: … ?? buildChatExecutionSource(session_id, turn_id)`, and
 *  `(chat, user_self)` resolves to `OWNER_CONTRACT_ID`. The principal on this
 *  channel is the OWNER, exactly as one would guess.
 *
 *  ⚠ The gate is INJECTED, not imported: `packages/` may never reach into
 *  `backend/`, where the op-admission gate lives. */
describe('D-228 slice 5 — admitTier1', () => {
  const okHandler = async () => ({ ok: true as const, tier: 1 as const, result: {} } as never);

  it('⛔ a primitive the contract refuses never reaches its handler', async () => {
    let ran = false;
    const registry = createInternalToolRegistry({
      tier1Handlers: { 'mail.search': async () => { ran = true; return okHandler(); } },
      admitTier1: () => false,
    });
    const res = await registry.dispatch('mail.search', {}, ctxInternal());
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('classification_blocked');
    // ⛔ THE ASSERTION THAT MATTERS — refused BEFORE the handler, so a denied
    // primitive performs no read at all rather than reading and discarding.
    expect(ran).toBe(false);
  });

  /** ⚠ THE PERMITTING WITNESS. Without it, "refused" is indistinguishable from
   *  a registry that refuses every Tier-1 dispatch. */
  it('…while an admitted primitive runs normally', async () => {
    let ran = false;
    const registry = createInternalToolRegistry({
      tier1Handlers: { 'mail.search': async () => { ran = true; return okHandler(); } },
      admitTier1: () => true,
    });
    const res = await registry.dispatch('mail.search', {}, ctxInternal());
    expect(ran).toBe(true);
    expect(res.ok).toBe(true);
  });

  /** ⚠ ABSENT ⇒ NO GATE. Every existing harness and any embedder without a
   *  contract substrate builds the registry with no callback; a default-deny
   *  there would dark-boot the assistant, which is the failure this whole slice
   *  has been arranged to avoid. */
  it('no callback ⇒ ungated (a host without a contract substrate still works)', async () => {
    let ran = false;
    const registry = createInternalToolRegistry({
      tier1Handlers: { 'mail.search': async () => { ran = true; return okHandler(); } },
    });
    await registry.dispatch('mail.search', {}, ctxInternal());
    expect(ran).toBe(true);
  });

  /** ⛔ The gate is asked about the tool BEING dispatched — a callback keyed on
   *  the wrong name would deny the wrong tool and look identical in aggregate. */
  it('asks about the dispatched tool name', async () => {
    const seen: string[] = [];
    const registry = createInternalToolRegistry({
      tier1Handlers: { 'contact.search': okHandler },
      admitTier1: (name) => { seen.push(name); return true; },
    });
    await registry.dispatch('contact.search', {}, ctxInternal());
    expect(seen).toEqual(['contact.search']);
  });
});
