/** D-137 P5 follow-on — Codex review fold-back regressions.
 *
 *  Two findings from the Codex review:
 *
 *    - **P1** — Token grants weren't enforced at MCP dispatch.
 *      Possession of any active inbound token granted access to every
 *      registry tool, defeating the Settings → MCP Tokens checklist.
 *      Fold: `McpDeps.inboundTokenAuthorize` callback gates every
 *      `handleToolCall` dispatch path; the HTTP and stdio composers wire
 *      `isMcpInboundTokenToolAuthorized` for inbound-token bearers.
 *      D-228 later retired the env-var exception this fold originally
 *      carried: a verified CLI owner is now stated positively with
 *      `ownerAdmitAll`, while an absent callback denies.
 *
 *    - **P2** — Dispatch closure fell through to `baseMcpDeps` when
 *      bearer re-resolution missed inside the dispatch path (token
 *      revoked / deleted / expired between verifier accept + dispatch).
 *      An invalid bearer could complete one more MCP call instead of
 *      being rejected. Fold: dispatch closure returns a JSON-RPC
 *      `-32001` error envelope when verification accepted but
 *      resolution misses now.
 *
 *  This test suite exercises the substrate-level invariants. The full
 *  end-to-end HTTP wiring lives in `wire-mcp-http-transport.ts` and its
 *  dedicated tests; here we cover the grant predicate, store revocation
 *  seam, and `mcp-server` list/call enforcement directly. Keeping a
 *  hand-built copy of the transport closure here would only create a
 *  second stale contract.
 */

import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildDefaultMcpInboundTokenGrants,
  isMcpInboundTokenToolAuthorized,
  type McpInboundTokenRecord,
  type ToolEntry,
} from '@recued/contracts';
import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
} from '../storage/chat-inbound-token-store.js';

const tier1Read = (name: string): ToolEntry => ({
  name,
  tier: 1,
  description: '',
  arg_schema: {},
  topic_tags: [],
  classification: 'read',
  concurrency_safe: true,
});

describe('D-137 P5 follow-on Codex P1 fold — per-tool grant gate', () => {
  it('isMcpInboundTokenToolAuthorized rejects tools absent from grants (default-deny)', () => {
    const catalog = [tier1Read('mail.search'), tier1Read('contact.search')];
    const grants = buildDefaultMcpInboundTokenGrants(catalog);
    // Bob revokes contact.search via Settings → MCP Tokens checklist.
    const restricted: Readonly<Record<string, boolean>> = {
      ...grants,
      'contact.search': false,
    };
    const record: McpInboundTokenRecord = {
      token_id: 'a'.repeat(16),
      bearer_hash: 'b'.repeat(64),
      label: 'Mary',
      created_at: 0,
      revoked_at: null,
      grants: restricted,
      concurrency_tier: 5,
      chat_mode: null,
      updated_at: 0,
    };
    expect(isMcpInboundTokenToolAuthorized(record, 'mail.search', 1_000)).toBe(true);
    expect(isMcpInboundTokenToolAuthorized(record, 'contact.search', 1_000)).toBe(false);
    // New tool ships in a future release: default-deny per spec § A.9
    // new-tool default-off.
    expect(isMcpInboundTokenToolAuthorized(record, 'memory.search', 1_000)).toBe(false);
  });

  it('isMcpInboundTokenToolAuthorized rejects every tool when token is revoked', () => {
    const record: McpInboundTokenRecord = {
      token_id: 'a'.repeat(16),
      bearer_hash: 'b'.repeat(64),
      label: 'Mary',
      created_at: 0,
      revoked_at: 500,
      grants: { 'mail.search': true },
      concurrency_tier: 5,
      chat_mode: null,
      updated_at: 0,
    };
    expect(isMcpInboundTokenToolAuthorized(record, 'mail.search', 1_000)).toBe(false);
  });

  it('callback shape: inboundTokenAuthorize closes over a record + a clock', () => {
    // Mirrors bin.ts dispatch-closure construction. The store-backed
    // path builds the callback as a closure capturing the matched
    // record + Date.now; we exercise the same shape here so any
    // future change to `isMcpInboundTokenToolAuthorized`'s signature
    // surfaces as a compile / test failure at this seam too.
    const record: McpInboundTokenRecord = {
      token_id: 'a'.repeat(16),
      bearer_hash: 'b'.repeat(64),
      label: 'Mary',
      created_at: 0,
      revoked_at: null,
      grants: { 'mail.search': true, 'contact.search': false },
      concurrency_tier: 5,
      chat_mode: null,
      updated_at: 0,
    };
    const callback = (tool_name: string): boolean =>
      isMcpInboundTokenToolAuthorized(record, tool_name, Date.now());
    expect(callback('mail.search')).toBe(true);
    expect(callback('contact.search')).toBe(false);
    expect(callback('memory.search')).toBe(false);
  });
});

describe('D-137 P5 follow-on Codex P2 fold — verifier-then-revoke race', () => {
  it('verifyBearer returns null after revoke (the substrate seam the P2 fold relies on)', () => {
    const db = new Database(':memory:');
    ensureChatInboundTokenSchema(db);
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: {
        label: 'Mary',
        peer_handle: 'mary',
        grants: { 'mail.search': true },
        concurrency_tier: 5,
        chat_mode: null,
      },
      now: 1_000,
    });
    // Verify works pre-revoke.
    expect(
      store.verifyBearer({ bearer: issued.bearer_plaintext, now: 1_500 }),
    ).not.toBeNull();
    // Revoke.
    store.revokeToken({ token_id: issued.record.token_id, now: 2_000 });
    // Now verifyBearer returns null — this is the seam bin.ts dispatch
    // closure consults. Pre-fold, the closure fell through to
    // baseMcpDeps when this happened; post-fold, the closure returns
    // a JSON-RPC -32001 error envelope.
    expect(
      store.verifyBearer({ bearer: issued.bearer_plaintext, now: 2_500 }),
    ).toBeNull();
  });
});

describe('D-137 P5 follow-on Codex fold — combined behavior', () => {
  it('legitimate tool call passes the gate; denied tool call is refused', () => {
    const record: McpInboundTokenRecord = {
      token_id: 'a'.repeat(16),
      bearer_hash: 'b'.repeat(64),
      label: 'Mary',
      created_at: 0,
      revoked_at: null,
      grants: { 'mail.search': true },
      concurrency_tier: 5,
      chat_mode: null,
      updated_at: 0,
    };
    const gate = (tool_name: string): boolean =>
      isMcpInboundTokenToolAuthorized(record, tool_name, Date.now());
    expect(gate('mail.search')).toBe(true);
    // Pre-fold, this would have invoked the registry; post-fold, the
    // gate returns false and `handleToolCall` surfaces an MCP error.
    expect(gate('contact.search')).toBe(false);
  });
});

describe('D-137 P5 follow-on Codex P1 fold — handleToolCall gate end-to-end', () => {
  it('refuses dispatch with the per-token error envelope when callback returns false', async () => {
    const { _testing } = await import('../mcp-server.js');
    const denyAll = vi.fn().mockReturnValue(false);
    // Minimal McpDeps stub — only the gate matters for this test path.
    // The gate runs BEFORE every dispatch branch, so the legacy /
    // ingredient / registry refs never fire when it rejects.
    const result = await _testing.handleToolCall(
      { name: 'recued_listRecipes', arguments: {} },
      // We deliberately cast to bypass the rest of the McpDeps shape;
      // the gate short-circuits before any other dep is touched.
      { inboundTokenAuthorize: denyAll } as unknown as Parameters<
        typeof _testing.handleToolCall
      >[1],
    );
    expect(denyAll).toHaveBeenCalledWith('recued_listRecipes');
    // err() shape: { content: [{ type: 'text', text: <msg> }], isError: true }
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text' }],
    });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toMatch(/not granted by this token/);
  });

  /** ⛔⛔ REWRITTEN BY DECISION — D-228 slice 6; see the sibling below for why
   *  the D-137 P5 interim it pinned no longer holds. The OWNER still skips the
   *  gate; what changed is that the owner now has to SAY SO. */
  it('the OWNER skips the gate (ownerAdmitAll), reaching the dispatch body', async () => {
    const { _testing } = await import('../mcp-server.js');
    // The unknown-tool path PAST the gate throws `Unknown tool: ...` from the
    // dispatch's default branch — that throw IS the proof the gate didn't
    // refuse first (a refused gate returns the err() envelope, not a throw).
    let threw: unknown = null;
    try {
      await _testing.handleToolCall(
        { name: 'recued_unknown_tool_for_test', arguments: {} },
        { ownerAdmitAll: true } as unknown as Parameters<typeof _testing.handleToolCall>[1],
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toMatch(/Unknown tool/);
    // Crucially, the gate-refusal copy is NOT in the throw message.
    expect((threw as Error).message).not.toMatch(/not granted by this token/);
  });

  /** ⛔⛔ THE OTHER HALF, and the one the interim left open: a caller with
   *  NEITHER a checklist NOR the owner claim. It reaches no dispatch branch at
   *  all — it is refused, and the refusal names the recovery. Note it does NOT
   *  throw `Unknown tool`, which is the proof the gate ran FIRST. */
  it('a caller that presented NOTHING is refused before dispatch', async () => {
    const { _testing } = await import('../mcp-server.js');
    const res = (await _testing.handleToolCall(
      { name: 'recued_unknown_tool_for_test', arguments: {} },
      {} as unknown as Parameters<typeof _testing.handleToolCall>[1],
    )) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/presented no MCP token/);
  });
});

describe('D-171 external-door fold — tools/list per-token catalog filter', () => {
  const manifestlessDeps = (extra: Record<string, unknown> = {}) =>
    ({
      executorConfig: {
        manifests: { slugs: () => [], get: () => undefined },
      },
      ...extra,
    }) as unknown as import('../mcp-server.js').McpDeps;

  it('advertises only granted tools when inboundTokenAuthorize is set', async () => {
    const { _testing } = await import('../mcp-server.js');
    const gate = vi.fn((name: string) => name === 'recued_listRecipes');
    const result = (await _testing.handleToolsList(
      manifestlessDeps({ inboundTokenAuthorize: gate }),
    )) as { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name)).toEqual(['recued_listRecipes']);
    // The gate saw every catalog entry — the filter is enumeration-side,
    // not a pre-narrowed list.
    expect(gate.mock.calls.length).toBeGreaterThan(1);
  });

  /** ⛔⛔ REWRITTEN BY DECISION — D-228 slice 6. This read "returns the full
   *  catalog when the callback is undefined (owner transports)" and pinned the
   *  D-137 P5 interim: *"the env-var bearer path leaves the callback undefined
   *  (single-tenant interim — operator full access by design)"*.
   *
   *  🔑 THE INTERIM'S PRECONDITION IS GONE. It existed because this surface had
   *  NO WAY to present a token; D-228 slice 1 added `--token` / `RECUED_MCP_TOKEN`
   *  and resolves it against the inbound-token store. What "callback undefined"
   *  used to mean — the operator — is now said POSITIVELY with `ownerAdmitAll`,
   *  which only a `client_kind === 'cli'` verified bearer sets. Absence went back
   *  to meaning what it says: nothing was presented.
   *
   *  Both halves are kept, because the pair is the whole point. */
  it('the OWNER transport still returns the full catalog (ownerAdmitAll)', async () => {
    const { _testing } = await import('../mcp-server.js');
    const result = (await _testing.handleToolsList(
      manifestlessDeps({ ownerAdmitAll: true }),
    )) as { tools: Array<{ name: string }> };
    expect(result.tools.length).toBeGreaterThan(1);
    expect(result.tools.map((t) => t.name)).toContain('recued_listRecipes');
  });

  it('…while a caller that presented NOTHING gets an empty catalog', async () => {
    const { _testing } = await import('../mcp-server.js');
    const result = (await _testing.handleToolsList(manifestlessDeps())) as {
      tools: Array<{ name: string }>;
    };
    expect(result.tools).toEqual([]);
  });
});
