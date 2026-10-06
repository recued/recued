/** D-137 Trio #A — Chat tool handler wiring tests.
 *
 *  Verifies the Tier 1 + Tier 2 dispatch path actually reaches the
 *  warehouse stores + recipe executor, replacing the P1.4 substrate's
 *  `not_implemented` stubs. Each Tier 1 primitive gets at minimum:
 *    - successful dispatch reaching its store
 *    - `invalid_args` for malformed input
 *    - `execution_error` when the late-bound dep is undefined (the
 *      legacy `not_implemented` equivalent for the dbless harness
 *      window)
 *
 *  Tier 2 dispatch covers: parse `<publisher>/<recipe_id>` correctly;
 *  surface `invalid_args` on malformed tool name; surface
 *  `execution_error` when the recipe is uninstalled mid-turn; reach
 *  the executor closure on the happy path.
 *
 *  Tier 2 source covers: enumerate `RecipeStore.ids()` (bundled +
 *  SQLite); filter kernel recipes (`metadata.author === 'recued'`);
 *  fall back to `metadata.author` for `publisher_id` when the
 *  StoredRecipe row is absent (pure-bundled case). */

import { describe, it, expect, vi } from 'vitest';
import type {
  ChatDispatchContext,
  ConnectionMcpAnnotationState,
  ContractSnapshot,
  ExecutionSource,
  RecipeDefinition,
} from '@recued/contracts';
import { IngredientError } from '@recued/ingredients';
import {
  buildChatTier1Handlers,
  buildChatToolRegistryInputs,
  createChatManifestLookup,
  createChatTier2Dispatch,
  createChatTier2Source,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';
import type { ExecuteRequest, ExecuteResponse } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

const ctxInternal = (session_id = 'sess-1', turn_id = 'turn-1'): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id,
  turn_id,
});

const buildRecipe = (
  recipe_id: string,
  author = 'recued-core',
  chat_exposed = true,
): RecipeDefinition =>
  ({
    recipe_id,
    version: 1,
    metadata: {
      name: recipe_id,
      description: `Test ${recipe_id}`,
      author,
      tags: ['test'],
    },
    chat_exposed,
    steps: [],
  } as unknown as RecipeDefinition);

// Deliberately hardcoded (a pin, not an import). D-177 rule-5 slice E (5.g)
// appended the capability-truthful posture + approval-card affordance.
// 2026-10-04 added where approvals are answered (the model had been inventing it).
const AWAITING_APPROVAL_MESSAGE =
  "This action is paused and is now queued for the user's approval before it can run. "
  + 'This is the expected, successful outcome for an action that sends a message or '
  + 'changes something outside Recued — it is NOT a failure. The action is already '
  + 'queued; do NOT call this tool again or resend it. Let the user know the action '
  + 'needs their approval before it can proceed. Approvals are answered in the Recued '
  + 'app, from the bell at the top of the page (Attention), which also opens the '
  + 'Approvals page. You do not have the ability to '
  + 'approve or bypass approvals yourself; if the user wants fewer approval '
  + 'interruptions, the approval card itself may offer bounded options (such as '
  + 'allowing repeats for this session).';

const buildExecuteResponse = (
  recipe_id: string,
  overrides: Partial<ExecuteResponse> = {},
): ExecuteResponse => ({
  recipe_id,
  recipe_hash: 'hash',
  success: true,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 0,
  ...overrides,
});

const expectAwaitingApprovalWrapped = (raw: unknown): void => {
  const wrapped = raw as Record<string, unknown>;
  expect(wrapped.status).toBe('awaiting_approval');
  expect(wrapped.message).toBe(AWAITING_APPROVAL_MESSAGE);
  expect(wrapped.awaiting_approval).toBe(true);
  expect(typeof wrapped.recipe_id).toBe('string');
  // The clean agent-facing held shape DROPS the misleading `success:false` /
  // empty steps / errors — a held run is a third state, not a failure.
  expect(wrapped.success).toBeUndefined();
  expect(wrapped.steps).toBeUndefined();
  expect(wrapped.errors).toBeUndefined();
};

const mcpExecutionSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'stdio_local',
  tool_call_id: 'mcp-test-abc123',
  mcp_token_id: 'stdio_local',
  contract_id: 'stdio_local',
};

const mcpContractSnapshot: ContractSnapshot = {
  contract_id: 'stdio_local',
  contract_version: '1',
  allowed_tools: ['safe-http'],
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_000,
};

/** Build a deps stub with overrides per test. Each store getter returns
 *  undefined by default so a test only wires what it asserts on. */
const buildDepsStub = (
  overrides: Partial<ChatToolHandlerDeps> = {},
): ChatToolHandlerDeps => ({
  getContactStore: () => undefined,
  getCollectionRegistry: () => undefined,
  getAuditLog: () => undefined,
  getEnrichmentStore: () => undefined,
  getRecipeStore: () =>
    ({
      ids: () => [],
      get: () => null,
      getStored: () => null,
      listStored: () => [],
    }) as never,
  getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
  getExecuteRecipe: () => undefined,
  ...overrides,
});


// ────────────────────────────────────────────────────────────────
// contact.search
// ────────────────────────────────────────────────────────────────

describe('D-137 Trio #A — contact.search handler (P2 fan-out envelope)', () => {
  it('reaches the contact store list when query supplied', async () => {
    const list = vi.fn().mockReturnValue([
      { _id: 'mary@example.com', email: 'mary@example.com', name: 'Mary' },
    ]);
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getContactStore: () =>
          ({ list, get: () => null }) as never,
      }),
    );
    const result = await handlers['contact.search']!({ query: 'Mary', limit: 5 }, ctxInternal());
    expect(result.ok).toBe(true);
    expect(list).toHaveBeenCalledWith({ name_contains: 'Mary', limit: 5 });
    if (result.ok) {
      const r = result.result as {
        candidates: Array<{ source: string; record: { email: string | null } }>;
      };
      expect(r.candidates).toHaveLength(1);
      expect(r.candidates[0]!.source).toBe('local');
      expect(r.candidates[0]!.record.email).toBe('mary@example.com');
    }
  });

  it('routes company to a company_contains list (D-167 B3 org search; threaded into fan-out)', async () => {
    const list = vi.fn().mockReturnValue([
      { _id: 'dana@acme.com', email: 'dana@acme.com', name: 'Dana', company: 'Acme Corp' },
    ]);
    const handlers = buildChatTier1Handlers(
      buildDepsStub({ getContactStore: () => ({ list, get: () => null }) as never }),
    );
    const result = await handlers['contact.search']!({ company: 'Acme', limit: 5 }, ctxInternal());
    expect(result.ok).toBe(true);
    // The `company` arg must be threaded into the fan-out (the P1 codex fold) AND
    // routed to the store's company_contains filter — NOT a default bare list.
    expect(list).toHaveBeenCalledWith({ company_contains: 'Acme', limit: 5 });
    if (result.ok) {
      const r = result.result as { candidates: Array<{ record: { email: string | null } }> };
      expect(r.candidates[0]!.record.email).toBe('dana@acme.com');
    }
  });

  it('routes email to get() when provided', async () => {
    const get = vi.fn().mockReturnValue({
      _id: 'mary@example.com',
      email: 'mary@example.com',
      name: 'Mary',
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getContactStore: () => ({ list: () => [], get }) as never,
      }),
    );
    const result = await handlers['contact.search']!(
      { email: 'mary@example.com' },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(get).toHaveBeenCalledWith('mary@example.com');
  });

  it('surfaces local-source partial_failure when contact store is undefined', async () => {
    const handlers = buildChatTier1Handlers(buildDepsStub());
    const result = await handlers['contact.search']!({}, ctxInternal());
    // D-137 P2 — missing contact store is now a per-source degradation
    // (the local source throws) rather than a tool-level execution_error.
    // The fan-out runner catches + tags the failure; the agent sees
    // `partial: true` + the source label rather than a hard fail.
    expect(result.ok).toBe(true);
    if (result.ok) {
      const r = result.result as {
        candidates: unknown[];
        partial?: boolean;
        partial_failures?: Array<{ source: string; reason: string }>;
      };
      expect(r.candidates).toHaveLength(0);
      expect(r.partial).toBe(true);
      expect(r.partial_failures?.[0]?.source).toBe('local');
    }
  });

  it('returns invalid_args for non-object args', async () => {
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getContactStore: () => ({ list: () => [], get: () => null }) as never,
      }),
    );
    const result = await handlers['contact.search']!([], ctxInternal());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });
});

// ────────────────────────────────────────────────────────────────
// mail.search / calendar.search
// ────────────────────────────────────────────────────────────────

const mockCollection = (platform: 'mail' | 'calendar', slug: string, search?: unknown[], list?: unknown[]) =>
  ({
    platform,
    slug,
    search: vi.fn().mockReturnValue(search ?? []),
    list: vi.fn().mockReturnValue(list ?? []),
  }) as never;

describe('D-137 Trio #A — mail.search / calendar.search handlers', () => {
  it('fans out FTS5 search across mail collections when query supplied', async () => {
    const gmail = mockCollection('mail', 'gmail', [
      { record_id: 'm1', hot_fields: { subject: 'Re: foo' }, rank: -0.1, snippet: 'foo' },
    ]);
    const outlook = mockCollection('mail', 'outlook', [
      { record_id: 'm2', hot_fields: { subject: 'Re: bar' }, rank: -0.2, snippet: 'bar' },
    ]);
    // A non-mail collection that must be skipped.
    const drive = mockCollection('calendar' as 'mail' | 'calendar', 'drive', []);
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getCollectionRegistry: () =>
          ({ list: () => [gmail, outlook, drive] }) as never,
      }),
    );
    const result = await handlers['mail.search']!({ query: 'foo', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const r = result.result as { matches: unknown[]; collections: string[] };
      expect(r.matches).toHaveLength(2);
      expect(r.collections).toEqual(['gmail', 'outlook']);
    }
    expect((gmail as { search: ReturnType<typeof vi.fn> }).search).toHaveBeenCalled();
    expect((outlook as { search: ReturnType<typeof vi.fn> }).search).toHaveBeenCalled();
    expect((drive as { search: ReturnType<typeof vi.fn> }).search).not.toHaveBeenCalled();
  });

  it('names an UNKNOWN near_id instead of answering with an empty page', async () => {
    // ⛔⛔ Measured, not theorised: a live model composed six `near_id` values
    // it had never read — `mail:pobm0001pob` and siblings, pattern-matched off
    // the corpus's own id scheme — and every one returned `ok: true` with an
    // empty `matches`. That is refusing by SUCCEEDING: an empty page reads as
    // "the thread ends here", which is the one answer that invites no
    // correction, so the model kept inventing.
    const gmail = {
      platform: 'mail', slug: 'gmail',
      search: vi.fn().mockReturnValue([]),
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),          // no such record
      neighbours: vi.fn().mockReturnValue([]),
    } as never;
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getCollectionRegistry: () => ({ list: () => [gmail] }) as never,
      }),
    );
    const result = await handlers['mail.search']!(
      { near_id: 'mail:pobm0001pob', next: 2 }, ctxInternal(),
    );
    expect(result.ok, 'a Tier-1 read reports absence in the BODY, never by failing').toBe(true);
    if (result.ok) {
      const r = result.result as {
        matches: unknown[]; anchor_not_found?: string; note?: string;
      };
      expect(r.matches).toHaveLength(0);
      expect(r.anchor_not_found).toBe('mail:pobm0001pob');
      expect(r.note ?? '').toContain('cannot be constructed or guessed');
    }
    expect(
      (gmail as { neighbours: ReturnType<typeof vi.fn> }).neighbours,
      'an anchor that does not exist must not even be walked',
    ).not.toHaveBeenCalled();
  });

  it('still steps normally when the anchor DOES exist', async () => {
    // The other half of the matrix — without this, the test above passes just
    // as well against a handler that refused every `near_id` outright.
    const gmail = {
      platform: 'mail', slug: 'gmail',
      search: vi.fn().mockReturnValue([]),
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue({ record_id: 'm1' }),
      neighbours: vi.fn().mockReturnValue([
        { record_id: 'm2', hot_fields: { subject: 'the reply' }, received_at: 2 },
      ]),
    } as never;
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getCollectionRegistry: () => ({ list: () => [gmail] }) as never,
      }),
    );
    const result = await handlers['mail.search']!(
      { near_id: 'm1', next: 2 }, ctxInternal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const r = result.result as { matches: unknown[]; anchor_not_found?: string };
      expect(r.matches).toHaveLength(1);
      expect(r.anchor_not_found, 'a real anchor must not be flagged').toBeUndefined();
    }
  });

  it('reports neighbours omitted by the result limit and clears the flag when below every quota', async () => {
    const later = { record_id: 'later', hot_fields: { subject: 'Offer withdrawn' }, received_at: 3 };
    const earlier = { record_id: 'earlier', hot_fields: { subject: 'Original terms' }, received_at: 1 };
    const gmail = {
      platform: 'mail', slug: 'gmail',
      get: vi.fn().mockReturnValue({ record_id: 'seed' }),
      // Like the store: `next` walks later mail, `prev` earlier mail.
      neighbours: vi.fn((q: { next?: number; prev?: number }) => [
        ...(q.next ? [later] : []), ...(q.prev ? [earlier] : []),
      ]),
    };
    const handlers = buildChatTier1Handlers(buildDepsStub({
      getCollectionRegistry: () => ({ list: () => [gmail] }) as never,
    }));
    const clipped = await handlers['mail.search']!({ near_id: 'seed', next: 1, prev: 1, limit: 1 }, ctxInternal());
    expect(clipped).toMatchObject({ ok: true, result: { matches: [{ record_id: 'later' }], more_matches: true } });
    const full = await handlers['mail.search']!({ near_id: 'seed', next: 3, prev: 3, limit: 2 }, ctxInternal());
    expect(full).toMatchObject({ ok: true, result: { matches: [{ record_id: 'later' }, { record_id: 'earlier' }], more_matches: false } });
  });

  it.each([{ next: 2 }, { prev: 2 }, { next: 2, prev: 10 }])('discloses a neighbour direction with more mail beyond the requested count: %j', async direction => {
    // Three messages on each side of the anchor; the store returns up to the count asked.
    const side = (name: string) => [1, 2, 3].map(n => ({ record_id: `${name}-${n}`, hot_fields: {}, received_at: n }));
    const mail = { platform: 'mail', slug: 'work', get: () => ({ record_id: 'seed' }),
      neighbours: (q: { next?: number; prev?: number }) => [
        ...side('later').slice(0, q.next ?? 0), ...side('earlier').slice(0, q.prev ?? 0),
      ],
    };
    const handlers = buildChatTier1Handlers(buildDepsStub({
      getCollectionRegistry: () => ({ list: () => [mail] }) as never,
    }));
    const result = await handlers['mail.search']!({ near_id: 'seed', ...direction, limit: 20 }, ctxInternal());
    expect(result).toMatchObject({ ok: true, result: { more_matches: true } });
  });

  it('reports more_matches only when a direction has more mail than it returned', async () => {
    const later = ['l1', 'l2', 'l3', 'l4', 'l5'];
    const earlier = ['e1', 'e2', 'e3'];
    const row = (record_id: string) => ({ record_id, hot_fields: {}, received_at: 1 });
    const mail = { platform: 'mail', slug: 'work', get: () => ({ record_id: 'seed' }),
      neighbours: (q: { next?: number; prev?: number }) => [
        ...later.slice(0, q.next ?? 0).map(row), ...earlier.slice(0, q.prev ?? 0).map(row),
      ],
    };
    const handlers = buildChatTier1Handlers(buildDepsStub({
      getCollectionRegistry: () => ({ list: () => [mail] }) as never,
    }));
    // Five of five later messages and three earlier ones: that is everything.
    const all = await handlers['mail.search']!({ near_id: 'seed', prev: 5, next: 5 }, ctxInternal());
    expect(all).toMatchObject({ ok: true, result: { more_matches: false } });
    expect((all as { result: { matches: unknown[] } }).result.matches).toHaveLength(8);
    later.push('l6');
    const more = await handlers['mail.search']!({ near_id: 'seed', prev: 5, next: 5 }, ctxInternal());
    expect(more).toMatchObject({ ok: true, result: { more_matches: true } });
    expect((more as { result: { matches: Array<{ record_id: string }> } }).result.matches.map(match => match.record_id))
      .toEqual(['l1', 'l2', 'l3', 'l4', 'l5', 'e1', 'e2', 'e3']);
  });

  it('follows near_id only in the named mailbox, and refuses an anchor id that two mailboxes share', async () => {
    // Two IMAP accounts can store different messages under the same record_id.
    const mailbox = (slug: string) => ({
      platform: 'mail', slug,
      search: vi.fn().mockReturnValue([]),
      list: vi.fn().mockReturnValue([]),
      get: vi.fn((id: string) => (id === 'shared' ? { record_id: 'shared' } : null)),
      neighbours: vi.fn((q: { next?: number }) => (q.next ? [{ record_id: `${slug}-reply`, hot_fields: {}, received_at: 2 }] : [])),
    });
    const work = mailbox('work');
    const personal = mailbox('personal');
    const handlers = buildChatTier1Handlers(buildDepsStub({
      getCollectionRegistry: () => ({ list: () => [work, personal] }) as never,
    }));
    const scoped = await handlers['mail.search']!({ near_id: 'shared', slug: 'work', next: 2 }, ctxInternal());
    expect(scoped).toMatchObject({ ok: true, result: {
      matches: [{ collection_slug: 'work', record_id: 'work-reply' }], collections: ['work'] } });
    expect(personal.neighbours).not.toHaveBeenCalled();
    const ambiguous = await handlers['mail.search']!({ near_id: 'shared', next: 2 }, ctxInternal());
    expect(ambiguous).toMatchObject({ ok: true, result: {
      matches: [], more_matches: false, anchor_ambiguous: 'shared', mailboxes: ['work', 'personal'] } });
    expect(personal.neighbours).not.toHaveBeenCalled();
    // The slug scopes ordinary searches too, and an unknown one is named.
    await handlers['mail.search']!({ query: 'terms', slug: 'personal' }, ctxInternal());
    expect(personal.search).toHaveBeenCalled();
    expect(work.search).not.toHaveBeenCalled();
    const unknown = await handlers['mail.search']!({ near_id: 'shared', slug: 'archive', next: 2 }, ctxInternal());
    expect(unknown).toMatchObject({ ok: true, result: { matches: [], mailbox_not_found: 'archive', collections: ['work', 'personal'] } });
  });

  it('uses list() instead of search() when query is empty', async () => {
    const gmail = mockCollection(
      'mail',
      'gmail',
      undefined,
      [{ record_id: 'm1', hot_fields: { subject: 'foo' }, received_at: 1 }],
    );
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getCollectionRegistry: () => ({ list: () => [gmail] }) as never,
      }),
    );
    const result = await handlers['mail.search']!({ since: 100, limit: 5 }, ctxInternal());
    expect(result.ok).toBe(true);
    expect((gmail as { list: ReturnType<typeof vi.fn> }).list).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'mail', slug: 'gmail', since: 100, limit: 5 }),
    );
    expect((gmail as { search: ReturnType<typeof vi.fn> }).search).not.toHaveBeenCalled();
  });

  it('returns empty result with no platforms registered', async () => {
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getCollectionRegistry: () => ({ list: () => [] }) as never,
      }),
    );
    const result = await handlers['mail.search']!({ query: 'foo' }, ctxInternal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.result as { matches: unknown[] }).matches).toHaveLength(0);
    }
  });

  it('clamps aggregated matches to the requested limit', async () => {
    const gmail = mockCollection('mail', 'gmail', [
      { record_id: 'm1', hot_fields: {}, rank: -0.1, snippet: '' },
      { record_id: 'm2', hot_fields: {}, rank: -0.2, snippet: '' },
    ]);
    const outlook = mockCollection('mail', 'outlook', [
      { record_id: 'm3', hot_fields: {}, rank: -0.3, snippet: '' },
      { record_id: 'm4', hot_fields: {}, rank: -0.4, snippet: '' },
    ]);
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getCollectionRegistry: () => ({ list: () => [gmail, outlook] }) as never,
      }),
    );
    const result = await handlers['mail.search']!({ query: 'x', limit: 3 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.result as { matches: unknown[] }).matches).toHaveLength(3);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// memory.search
// ────────────────────────────────────────────────────────────────

describe('D-137 Trio #A — memory.search handler', () => {
  // RETIRED: `listRecent when no recipe_id supplied` + `listByRecipe when
  // recipe_id supplied`. `memory.search` no longer touches the audit log — the
  // audit half bypassed `core.memory.audit.read` (the grant the MCP door DOES
  // enforce) and, arriving by RECENCY rather than by match, crowded the body
  // budget with the noisiest feed. It is now pool-only recall; `recipe_id` is
  // gone from the schema. Behavior is covered by `d-198-memory-search-recall`.

  it('NEVER touches the audit log (the ungated half is gone)', async () => {
    const listRecent = vi.fn();
    const listByRecipe = vi.fn();
    const handlers = buildChatTier1Handlers(
      buildDepsStub({ getAuditLog: () => ({ listRecent, listByRecipe }) as never }),
    );
    const result = await handlers['memory.search']!({}, ctxInternal());
    expect(result.ok).toBe(true);
    expect(listRecent).not.toHaveBeenCalled();
    expect(listByRecipe).not.toHaveBeenCalled();
  });

  it('a bare call still ANSWERS (guided empty, never ok:false — the anti-loop invariant)', async () => {
    // The 2026-06-09 `enrichment.search` loop-fix cites THIS tool's never-error
    // fallback as its precedent. An `ok:false` here makes the agent retry to
    // timeout. No pool wired → empty + hint, not an error.
    const handlers = buildChatTier1Handlers(buildDepsStub({}));
    const result = await handlers['memory.search']!({}, ctxInternal());
    expect(result.ok).toBe(true);
    expect((result as { result: { memories: unknown[] } }).result.memories).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// enrichment.search
// ────────────────────────────────────────────────────────────────

describe('D-137 Trio #A — enrichment.search handler', () => {
  it('passes topic + scope + target_id through to list()', async () => {
    const list = vi.fn().mockReturnValue([{ _id: 'e1' }]);
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getEnrichmentStore: () => ({ list }) as never,
      }),
    );
    const result = await handlers['enrichment.search']!(
      {
        topic: 'sentiment',
        scope: 'mail',
        target_id: 'm1',
        limit: 7,
      },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(list).toHaveBeenCalledWith({
      topic: 'sentiment',
      scope: 'mail',
      target_id: 'm1',
      limit: 7,
    });
  });

  it('returns a guided EMPTY result (ok:true), NOT invalid_args, when topic is missing — so a tool-looping agent does not retry to a timeout', async () => {
    // Substrate-support: a missing `topic` used to return invalid_args, which
    // made a capable model (qwen3.7-plus) RETRY blindly until the turn timed
    // out (internal benchmarks gap #2). It now mirrors memory.search —
    // ok:true + empty + a hint to supply a topic — so the agent answers in one
    // more turn. The store is NOT touched on the missing-topic path.
    const list = vi.fn(() => []);
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getEnrichmentStore: () => ({ list }) as never,
      }),
    );
    const result = await handlers['enrichment.search']!({}, ctxInternal());
    expect(result.ok).toBe(true);
    expect(list).not.toHaveBeenCalled();
    if (result.ok) {
      const r = result.result as { enrichments: unknown[]; hint: string };
      expect(r.enrichments).toEqual([]);
      expect(r.hint).toContain('topic');
    }
  });

  it('returns an explicit no-match hint when a supplied topic has no rows', async () => {
    // Distinguishes the two empty paths: a missing topic asks the model to
    // supply one (above); a supplied topic reaches the store and explicitly
    // says that the search found nothing, preventing the model from inventing
    // an absent enrichment.
    const list = vi.fn(() => []);
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getEnrichmentStore: () => ({ list }) as never,
      }),
    );
    const result = await handlers['enrichment.search']!(
      { topic: 'sentiment' },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ topic: 'sentiment' }));
    if (result.ok) {
      const r = result.result as { enrichments: unknown[]; hint: string };
      expect(r.enrichments).toEqual([]);
      expect(r.hint).toContain('found nothing');
      expect(r.hint).toContain('Do not supply');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// recipe.run
// ────────────────────────────────────────────────────────────────

describe('D-137 Trio #A — recipe.run handler', () => {
  it('forwards recipe_id + config + trigger_source: chat to the executor', async () => {
    const execute = vi
      .fn()
      .mockImplementation(async (req: ExecuteRequest) =>
        buildExecuteResponse(req.recipe_id ?? 'inline'),
      );
    const handlers = buildChatTier1Handlers(
      buildDepsStub({ getExecuteRecipe: () => execute }),
    );
    const result = await handlers['recipe.run']!(
      { recipe_id: 'foo/bar', config: { entity_id: 'e1' } },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe_id: 'foo/bar',
        config: { entity_id: 'e1' },
        trigger_source: 'chat',
      }),
    );
  });

  it('wraps a held Tier-1 recipe.run send response as awaiting_approval', async () => {
    const execute = vi.fn().mockResolvedValue(
      buildExecuteResponse('foo/send', {
        success: false,
        awaiting_approval: true,
      }),
    );
    const handlers = buildChatTier1Handlers(
      buildDepsStub({ getExecuteRecipe: () => execute }),
    );

    const result = await handlers['recipe.run']!(
      { recipe_id: 'foo/send' },
      ctxInternal(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expectAwaitingApprovalWrapped(result.result);
    }
  });

  it('passes through a non-held recipe.run response unchanged', async () => {
    const executeResponse = buildExecuteResponse('foo/bar', {
      awaiting_approval: false,
    });
    const execute = vi.fn().mockResolvedValue(executeResponse);
    const handlers = buildChatTier1Handlers(
      buildDepsStub({ getExecuteRecipe: () => execute }),
    );

    const result = await handlers['recipe.run']!(
      { recipe_id: 'foo/bar' },
      ctxInternal(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const passed = result.result as ExecuteResponse & {
        status?: unknown;
        message?: unknown;
      };
      expect(passed).toBe(executeResponse);
      expect(passed.status).toBeUndefined();
      expect(passed.message).toBeUndefined();
      expect(passed.success).toBe(true);
      expect(passed.steps).toEqual([]);
      expect(passed.errors).toEqual([]);
      expect(passed.awaiting_approval).toBe(false);
    }
  });

  it('returns invalid_args when neither recipe_id nor recipe supplied', async () => {
    const execute = vi.fn();
    const handlers = buildChatTier1Handlers(
      buildDepsStub({ getExecuteRecipe: () => execute }),
    );
    const result = await handlers['recipe.run']!({}, ctxInternal());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns execution_error when the executor is undefined (pre-publish window)', async () => {
    const handlers = buildChatTier1Handlers(buildDepsStub());
    const result = await handlers['recipe.run']!(
      { recipe_id: 'foo/bar' },
      ctxInternal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('execution_error');
  });

  it('propagates executor throw as execution_error', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('engine boom'));
    const handlers = buildChatTier1Handlers(
      buildDepsStub({ getExecuteRecipe: () => execute }),
    );
    const result = await handlers['recipe.run']!(
      { recipe_id: 'foo/bar' },
      ctxInternal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('execution_error');
      expect(result.detail).toContain('engine boom');
    }
  });
});

describe('D-153 P2.C — buildExecuteRequest contract-channel fields', () => {
  it('threads mcp_wire execution_source + contract_snapshot onto ExecuteRequest', async () => {
    const captured: ExecuteRequest[] = [];
    const execute = vi.fn().mockImplementation(async (req: ExecuteRequest) => {
      captured.push(req);
      return buildExecuteResponse(req.recipe_id ?? 'inline');
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({ getExecuteRecipe: () => execute }),
    );
    const ctx: ChatDispatchContext = {
      channel: 'mcp_wire',
      mcp_token_id: 'stdio_local',
      execution_source: mcpExecutionSource,
      contract_snapshot: mcpContractSnapshot,
    };

    const result = await handlers['recipe.run']!(
      { recipe_id: 'policy-recipe' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.trigger_source).toBe('mcp');
    expect(captured[0]?.execution_source).toBe(mcpExecutionSource);
    expect(captured[0]?.contract_snapshot).toBe(mcpContractSnapshot);
  });

  it('keeps internal_function_call requests on trigger_source chat without contract fields', async () => {
    const captured: ExecuteRequest[] = [];
    const execute = vi.fn().mockImplementation(async (req: ExecuteRequest) => {
      captured.push(req);
      return buildExecuteResponse(req.recipe_id ?? 'inline');
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({ getExecuteRecipe: () => execute }),
    );

    const result = await handlers['recipe.run']!(
      { recipe_id: 'internal-recipe' },
      ctxInternal(),
    );

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.trigger_source).toBe('chat');
    expect(captured[0]?.execution_source).toBeUndefined();
    expect(captured[0]?.contract_snapshot).toBeUndefined();
  });

  it('threads execution_source without inventing a missing contract_snapshot', async () => {
    const captured: ExecuteRequest[] = [];
    const execute = vi.fn().mockImplementation(async (req: ExecuteRequest) => {
      captured.push(req);
      return buildExecuteResponse(req.recipe_id ?? 'inline');
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({ getExecuteRecipe: () => execute }),
    );
    const ctx: ChatDispatchContext = {
      channel: 'mcp_wire',
      mcp_token_id: 'stdio_local',
      execution_source: mcpExecutionSource,
    };

    const result = await handlers['recipe.run']!(
      { recipe_id: 'missing-snapshot' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.trigger_source).toBe('mcp');
    expect(captured[0]?.execution_source).toBe(mcpExecutionSource);
    expect(captured[0]?.contract_snapshot).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Tier 2 dispatch
// ────────────────────────────────────────────────────────────────

describe('D-137 Trio #A — Tier 2 dispatch', () => {
  it('parses <publisher>/<recipe_id> and forwards to executor', async () => {
    const recipe = buildRecipe('foo/bar');
    const execute = vi.fn().mockImplementation(async (req: ExecuteRequest) =>
      buildExecuteResponse(req.recipe_id ?? 'inline'),
    );
    const dispatch = createChatTier2Dispatch(
      buildDepsStub({
        getRecipeStore: () =>
          ({
            ids: () => ['foo/bar'],
            get: (id: string) => (id === 'foo/bar' ? recipe : null),
            getStored: () => null,
            listStored: () => [],
          }) as never,
        getExecuteRecipe: () => execute,
      }),
    );
    // A Tier-2 tool's arg schema is FLAT (deriveTier2ArgSchema projects the
    // recipe's `variables`), so the model passes config values at the top
    // level — the dispatch maps those flat args to the recipe's `config`.
    const result = await dispatch(
      'recued-core/foo/bar',
      { x: 1 },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe_id: 'foo/bar',
        config: { x: 1 },
        trigger_source: 'chat',
      }),
    );
  });

  it('maps the FLAT model args to recipe config (deriveTier2ArgSchema contract)', async () => {
    // Regression for the Tier-2 arg-mapping gap: `deriveTier2ArgSchema`
    // (chat-catalog.ts) gives the model a FLAT schema of the recipe's
    // variables, so a real model dispatches `{ to, subject, body }` at the top
    // level — NOT a nested `{ config: { … } }` envelope (that is the Tier-1
    // `recipe.run` umbrella's shape). The Tier-2 dispatch MUST forward those
    // flat args as the recipe's `config`; reading `args.config` here instead
    // drops every model-composed value and runs the recipe with empty config
    // (a required variable resolves empty — e.g. a gated send with no
    // recipient that fails post-approval).
    const recipe = buildRecipe('foo/send');
    const execute = vi.fn().mockImplementation(async (req: ExecuteRequest) =>
      buildExecuteResponse(req.recipe_id ?? 'inline'),
    );
    const dispatch = createChatTier2Dispatch(
      buildDepsStub({
        getRecipeStore: () =>
          ({
            ids: () => ['foo/send'],
            get: (id: string) => (id === 'foo/send' ? recipe : null),
            getStored: () => null,
            listStored: () => [],
          }) as never,
        getExecuteRecipe: () => execute,
      }),
    );
    const result = await dispatch(
      'recued-core/foo/send',
      { to: 'someone@example.com', subject: 'Hi', body: 'Hello.' },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe_id: 'foo/send',
        config: { to: 'someone@example.com', subject: 'Hi', body: 'Hello.' },
      }),
    );
    // The nested-envelope shape is NOT silently honoured on the Tier-2 path:
    // a literal top-level `config` key would just be one more flat arg.
    const call = execute.mock.calls[0][0] as ExecuteRequest;
    expect(call.config).not.toHaveProperty('config');
  });

  it.each(['vault', 'context'])(
    'rejects a caller-supplied server-owned %s carrier before Tier 2 execution',
    async (carrier) => {
      const recipe = buildRecipe('foo/send');
      const execute = vi.fn();
      const dispatch = createChatTier2Dispatch(
        buildDepsStub({
          getRecipeStore: () =>
            ({
              ids: () => ['foo/send'],
              get: (id: string) => (id === 'foo/send' ? recipe : null),
              getStored: () => null,
              listStored: () => [],
            }) as never,
          getExecuteRecipe: () => execute,
        }),
      );

      const result = await dispatch(
        'recued-core/foo/send',
        { to: 'someone@example.com', [carrier]: { injected: true } },
        ctxInternal(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_args');
        expect(result.detail).toContain('server-owned vault or execution context');
      }
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('wraps a held publisher recipe send response as awaiting_approval', async () => {
    const recipe = buildRecipe('foo/send');
    const execute = vi.fn().mockResolvedValue(
      buildExecuteResponse('foo/send', {
        success: false,
        awaiting_approval: true,
      }),
    );
    const dispatch = createChatTier2Dispatch(
      buildDepsStub({
        getRecipeStore: () =>
          ({
            ids: () => ['foo/send'],
            get: (id: string) => (id === 'foo/send' ? recipe : null),
            getStored: () => null,
            listStored: () => [],
          }) as never,
        getExecuteRecipe: () => execute,
      }),
    );

    const result = await dispatch(
      'recued-core/foo/send',
      { to: 'someone@example.com', subject: 'Hi', body: 'Hello.' },
      ctxInternal(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expectAwaitingApprovalWrapped(result.result);
    }
  });

  it('returns invalid_args for malformed tool name (no slash)', async () => {
    const dispatch = createChatTier2Dispatch(buildDepsStub());
    const result = await dispatch('no-slash', {}, ctxInternal());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('returns invalid_args when slash is leading/trailing', async () => {
    const dispatch = createChatTier2Dispatch(buildDepsStub());
    const a = await dispatch('/recipe', {}, ctxInternal());
    const b = await dispatch('publisher/', {}, ctxInternal());
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });

  it('returns execution_error when recipe was uninstalled mid-turn', async () => {
    const execute = vi.fn();
    const dispatch = createChatTier2Dispatch(
      buildDepsStub({
        getRecipeStore: () =>
          ({
            ids: () => [],
            get: () => null,
            getStored: () => null,
            listStored: () => [],
          }) as never,
        getExecuteRecipe: () => execute,
      }),
    );
    const result = await dispatch(
      'recued-core/missing-recipe',
      {},
      ctxInternal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('execution_error');
    expect(execute).not.toHaveBeenCalled();
  });
});

// ⛔⛔ D-228 slice 4 — THE TIER-3 DISPATCH SUITE IS DELETED WITH ITS SUBJECT.
// It exercised `createChatTier3Dispatch`: resolving `<connection>.<tool>`
// against `tool_overrides` and routing through the `connection-mcp-read` /
// `-write` kernel slugs at the tier the owner had typed there. That store is
// gone (D-225 named it the standing defect) and an MCP tool now reaches chat
// once, as a contract-governed `recued_op_*` pack operation.
//
// ⚠ What those tests really protected — a read-tier slug must not carry a
// write-tier tool — did NOT go with them. It moved to the gate that still
// enforces it for every engine caller: `d-177-p2b-connection-mcp-gate`,
// where it is now resolved from the pack operation instead of a side store.


// ────────────────────────────────────────────────────────────────
// Tier 2 source enumeration
// ────────────────────────────────────────────────────────────────

describe('D-137 Trio #A — Tier 2 source', () => {
  it('enumerates ids() + builds entries with publisher from stored row', () => {
    const r1 = buildRecipe('a/b', 'recued-core');
    const r2 = buildRecipe('c/d', 'third-party');
    const source = createChatTier2Source(
      buildDepsStub({
        getRecipeStore: () =>
          ({
            ids: () => ['a/b', 'c/d'],
            get: (id: string) => (id === 'a/b' ? r1 : id === 'c/d' ? r2 : null),
            getStored: (id: string) =>
              id === 'a/b'
                ? { publisher_id: 'recued-core' }
                : id === 'c/d'
                  ? { publisher_id: 'third-party' }
                  : null,
            listStored: () => [],
          }) as never,
      }),
    );
    const entries = source.listRecipes();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ recipe_id: 'a/b', publisher_id: 'recued-core' });
    expect(entries[1]).toMatchObject({ recipe_id: 'c/d', publisher_id: 'third-party' });
  });

  it('filters kernel recipes (metadata.author === recued)', () => {
    const kernel = buildRecipe('recued/run-ingredient', 'recued');
    const userland = buildRecipe('user/recipe', 'recued-core');
    const source = createChatTier2Source(
      buildDepsStub({
        getRecipeStore: () =>
          ({
            ids: () => ['recued/run-ingredient', 'user/recipe'],
            get: (id: string) =>
              id === 'recued/run-ingredient'
                ? kernel
                : id === 'user/recipe'
                  ? userland
                  : null,
            getStored: () => null,
            listStored: () => [],
          }) as never,
      }),
    );
    const entries = source.listRecipes();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recipe_id).toBe('user/recipe');
  });

  it('falls back to metadata.author when stored row is absent (bundled-only)', () => {
    const bundled = buildRecipe('a/b', 'recued-core');
    const source = createChatTier2Source(
      buildDepsStub({
        getRecipeStore: () =>
          ({
            ids: () => ['a/b'],
            get: () => bundled,
            getStored: () => null,
            listStored: () => [],
          }) as never,
      }),
    );
    const entries = source.listRecipes();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.publisher_id).toBe('recued-core');
  });
});

// ────────────────────────────────────────────────────────────────
// Manifest lookup
// ────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────
// Codex review folds (P1 + 2×P2)
// ────────────────────────────────────────────────────────────────

describe('D-137 Trio #A Codex P1 — Tier 2 dispatch ignores inline recipe', () => {
  it('drops args.recipe when Tier 2 path pins a recipe_id', async () => {
    const installed = buildRecipe('foo/bar');
    const captured: ExecuteRequest[] = [];
    const execute = vi.fn().mockImplementation(async (req: ExecuteRequest) => {
      captured.push(req);
      return buildExecuteResponse(req.recipe_id ?? 'inline');
    });
    const dispatch = createChatTier2Dispatch(
      buildDepsStub({
        getRecipeStore: () =>
          ({
            ids: () => ['foo/bar'],
            get: (id: string) => (id === 'foo/bar' ? installed : null),
            getStored: () => null,
            listStored: () => [],
          }) as never,
        getExecuteRecipe: () => execute,
      }),
    );
    // The AI tries to smuggle an inline recipe through the Tier 2 args
    // bundle — the registered tool name pinned `foo/bar`, but
    // `handleExecute` resolves `recipe` before `recipe_id` so an
    // unguarded forward would silently run the inline definition.
    const attackerInline = {
      recipe_id: 'attacker',
      version: 1,
      metadata: { name: 'attacker', author: 'unknown' },
      steps: [],
    };
    const result = await dispatch(
      'recued-core/foo/bar',
      { recipe: attackerInline, config: { x: 1 } },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.recipe_id).toBe('foo/bar');
    expect(captured[0]?.recipe).toBeUndefined();
  });

  it('Tier 1 recipe.run still accepts inline recipe (escape hatch per § A.11)', async () => {
    // Symmetric assertion — the Tier 1 path is deliberately the AI's
    // ad-hoc escape hatch; inline recipe MUST pass through there.
    const captured: ExecuteRequest[] = [];
    const execute = vi.fn().mockImplementation(async (req: ExecuteRequest) => {
      captured.push(req);
      return buildExecuteResponse(req.recipe_id ?? 'inline');
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({ getExecuteRecipe: () => execute }),
    );
    const inlineRecipe = {
      recipe_id: 'one-shot',
      version: 1,
      metadata: { name: 'one-shot', author: 'recued-core' },
      steps: [],
    };
    const result = await handlers['recipe.run']!(
      { recipe: inlineRecipe },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(captured[0]?.recipe).toEqual(inlineRecipe);
  });
});

describe('D-137 Trio #A Codex P2a — calendar.search uses CalendarCollectionTable', () => {
  it('calls CalendarCollection.table.search() not the no-op Collection.search()', async () => {
    const tableSearch = vi.fn().mockReturnValue([
      {
        record_id: 'evt-1',
        hot: { calendar_id: 'primary', summary: 'Standup', start_at: 1, end_at: 2 },
        rank: -0.1,
        snippet: 'standup notes',
      },
    ]);
    const collectionSearch = vi.fn().mockReturnValue([]); // The no-op
    const calendarCollection = {
      platform: 'calendar',
      slug: 'gcal-primary',
      // Legacy Collection.search — must NOT be called for calendar
      search: collectionSearch,
      list: vi.fn().mockReturnValue([]),
      // The real surface
      table: {
        search: tableSearch,
        list: vi.fn().mockReturnValue([]),
        listSnapshots: vi.fn().mockReturnValue([]),
      },
    };
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getCollectionRegistry: () =>
          ({ list: () => [calendarCollection] }) as never,
      }),
    );
    const result = await handlers['calendar.search']!(
      { query: 'standup', limit: 10 },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const r = result.result as { matches: unknown[] };
      expect(r.matches).toHaveLength(1);
    }
    expect(tableSearch).toHaveBeenCalledWith({ query: 'standup', limit: 10 });
    expect(collectionSearch).not.toHaveBeenCalled();
  });

  it('uses table.listSnapshots() for time-window queries (no query string)', async () => {
    const listSnapshots = vi.fn().mockReturnValue([
      {
        record_id: 'cal:canonical-1',
        source_id: 'src-1',
        received_at: 100,
        hot: { calendar_id: 'primary', summary: 'Standup', start_at: 1, end_at: 2 },
      },
    ]);
    const calendarCollection = {
      platform: 'calendar',
      slug: 'gcal-primary',
      search: vi.fn(),
      list: vi.fn(),
      table: {
        search: vi.fn(),
        list: vi.fn(),
        listSnapshots,
      },
    };
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getCollectionRegistry: () => ({ list: () => [calendarCollection] }) as never,
      }),
    );
    const result = await handlers['calendar.search']!(
      { start_since: 1000, start_until: 2000, calendar_id: 'primary' },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(listSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        start_since: 1000,
        start_until: 2000,
        calendar_id: 'primary',
      }),
    );
    if (result.ok) {
      const r = result.result as { matches: Array<{ record_id: string }> };
      expect(r.matches[0]?.record_id).toBe('cal:canonical-1');
    }
  });

  it('accepts `since`/`until` aliases (mirrors mail.search ergonomics)', async () => {
    const listSnapshots = vi.fn().mockReturnValue([]);
    const calendarCollection = {
      platform: 'calendar',
      slug: 'gcal-primary',
      search: vi.fn(),
      list: vi.fn(),
      table: {
        search: vi.fn(),
        list: vi.fn(),
        listSnapshots,
      },
    };
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getCollectionRegistry: () => ({ list: () => [calendarCollection] }) as never,
      }),
    );
    await handlers['calendar.search']!(
      { since: 500, until: 1500 },
      ctxInternal(),
    );
    expect(listSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({ start_since: 500, start_until: 1500 }),
    );
  });

  it('falls open when no calendar collections registered', async () => {
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getCollectionRegistry: () => ({ list: () => [] }) as never,
      }),
    );
    const result = await handlers['calendar.search']!({ query: 'foo' }, ctxInternal());
    expect(result.ok).toBe(true);
  });

  it('filters out collections that lack a `table` property (defensive)', async () => {
    // A registered "calendar" collection without the table surface
    // shouldn't crash — the type guard skips it.
    const malformed = {
      platform: 'calendar',
      slug: 'malformed',
      search: vi.fn(),
      list: vi.fn(),
    };
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getCollectionRegistry: () => ({ list: () => [malformed] }) as never,
      }),
    );
    const result = await handlers['calendar.search']!({ query: 'x' }, ctxInternal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.result as { matches: unknown[] }).matches).toHaveLength(0);
    }
  });
});

describe('D-137 Trio #A Codex P2b — recipe.run resolves publisher-qualified ids', () => {
  it('strips <publisher>/<slug> when the bare slug is what the store has', async () => {
    const installed = buildRecipe('triage-inbox');
    const captured: ExecuteRequest[] = [];
    const execute = vi.fn().mockImplementation(async (req: ExecuteRequest) => {
      captured.push(req);
      return buildExecuteResponse(req.recipe_id ?? 'inline');
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getRecipeStore: () =>
          ({
            ids: () => ['triage-inbox'],
            get: (id: string) => (id === 'triage-inbox' ? installed : null),
            getStored: () => null,
            listStored: () => [],
          }) as never,
        getExecuteRecipe: () => execute,
      }),
    );
    const result = await handlers['recipe.run']!(
      { recipe_id: 'recued-core/triage-inbox' },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(captured[0]?.recipe_id).toBe('triage-inbox');
  });

  it('leaves the id alone when the literal form resolves (recipe_id contains /)', async () => {
    // A theoretical recipe whose recipe_id literally contains a slash —
    // we MUST NOT strip in that case, or we'd send the executor a
    // truncated id.
    const installed = buildRecipe('team-tool/run');
    const captured: ExecuteRequest[] = [];
    const execute = vi.fn().mockImplementation(async (req: ExecuteRequest) => {
      captured.push(req);
      return buildExecuteResponse(req.recipe_id ?? 'inline');
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getRecipeStore: () =>
          ({
            ids: () => ['team-tool/run'],
            get: (id: string) => (id === 'team-tool/run' ? installed : null),
            getStored: () => null,
            listStored: () => [],
          }) as never,
        getExecuteRecipe: () => execute,
      }),
    );
    const result = await handlers['recipe.run']!(
      { recipe_id: 'team-tool/run' },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(captured[0]?.recipe_id).toBe('team-tool/run');
  });

  it('forwards the original id when neither form resolves (executor surfaces recipe_not_found)', async () => {
    const captured: ExecuteRequest[] = [];
    const execute = vi.fn().mockImplementation(async (req: ExecuteRequest) => {
      captured.push(req);
      return buildExecuteResponse(req.recipe_id ?? 'inline');
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getRecipeStore: () =>
          ({
            ids: () => [],
            get: () => null,
            getStored: () => null,
            listStored: () => [],
          }) as never,
        getExecuteRecipe: () => execute,
      }),
    );
    const result = await handlers['recipe.run']!(
      { recipe_id: 'recued-core/missing' },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(captured[0]?.recipe_id).toBe('recued-core/missing');
  });

  it('handles bare recipe_ids unchanged', async () => {
    const installed = buildRecipe('triage-inbox');
    const captured: ExecuteRequest[] = [];
    const execute = vi.fn().mockImplementation(async (req: ExecuteRequest) => {
      captured.push(req);
      return buildExecuteResponse(req.recipe_id ?? 'inline');
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getRecipeStore: () =>
          ({
            ids: () => ['triage-inbox'],
            get: (id: string) => (id === 'triage-inbox' ? installed : null),
            getStored: () => null,
            listStored: () => [],
          }) as never,
        getExecuteRecipe: () => execute,
      }),
    );
    const result = await handlers['recipe.run']!(
      { recipe_id: 'triage-inbox' },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(captured[0]?.recipe_id).toBe('triage-inbox');
  });
});

describe('D-137 Trio #A — manifest lookup', () => {
  it('returns ingredient.kind when manifest exists', () => {
    const lookup = createChatManifestLookup(
      buildDepsStub({
        getExecutorConfig: () =>
          ({
            manifests: {
              get: (slug: string) =>
                slug === 'mail-search'
                  ? { kind: 'storage' }
                  : null,
            },
          }) as never,
      }),
    );
    expect(lookup('mail-search')).toBe('storage');
    expect(lookup('unknown')).toBeNull();
  });

  it('surfaces a decomposed cli toolkit catalog (kind:connection + cli_invocation) as cli (D-182 F2)', () => {
    // The installed whisper/docling catalog is stamped kind:'connection' by the
    // decomposer; its cli-ness lives in the cli_invocation connector runtime. The
    // live lookup detects it (isCliIngredient) so the Tier-2 "Local tools" toggle
    // governs it, not "Outbound connections".
    const lookup = createChatManifestLookup(
      buildDepsStub({
        getExecutorConfig: () =>
          ({
            manifests: {
              get: (slug: string) =>
                slug === 'whisper'
                  ? {
                      kind: 'connection',
                      surfaces: {
                        connector: {
                          runtime: { wire_protocol: 'cli_invocation', entry_point: 'whisper' },
                        },
                      },
                    }
                  : slug === 'hubspot-catalog'
                    ? { kind: 'connection', surfaces: { connector: { runtime: { wire_protocol: 'mcp' } } } }
                    : null,
            },
          }) as never,
      }),
    );
    expect(lookup('whisper')).toBe('cli');
    // A genuine (non-cli) connection catalog still reports connection.
    expect(lookup('hubspot-catalog')).toBe('connection');
  });
});

// ────────────────────────────────────────────────────────────────
// Bundle factory
// ────────────────────────────────────────────────────────────────

describe('D-137 Trio #A — buildChatToolRegistryInputs', () => {
  it('returns all four wiring inputs for createInternalToolRegistry', () => {
    const inputs = buildChatToolRegistryInputs(buildDepsStub());
    expect(inputs.tier1Handlers).toBeDefined();
    expect(typeof inputs.tier1Handlers['contact.search']).toBe('function');
    expect(typeof inputs.tier1Handlers['mail.search']).toBe('function');
    expect(typeof inputs.tier1Handlers['calendar.search']).toBe('function');
    expect(typeof inputs.tier1Handlers['memory.search']).toBe('function');
    expect(typeof inputs.tier1Handlers['enrichment.search']).toBe('function');
    expect(typeof inputs.tier1Handlers['recipe.run']).toBe('function');
    expect(typeof inputs.tier2Source.listRecipes).toBe('function');
    expect(typeof inputs.manifestLookup).toBe('function');
    expect(typeof inputs.tier2Dispatch).toBe('function');
    // ⛔ D-228 slice 4 — NO `tier3Dispatch`. Asserting its ABSENCE, because a
    // handler reappearing here would mean a second route to MCP tools had
    // been rewired without anyone deciding to.
    expect('tier3Dispatch' in inputs).toBe(false);
  });
});
