/** D-205 #3 — the `data.<collection>` READ FENCE across the whole Tier-1 read plane:
 *  `contact.search` · `mail.search` · `calendar.search` · `work.search` · `work.read`.
 *
 *  ## What this pins
 *  These five are every Tier-1 tool that reads a governed `READABLE_COLLECTIONS` entry, and
 *  **`isCollectionReadGranted` had ZERO call sites in `chat-tool-handlers.ts`** — so all
 *  five ignored the owner's grants panel entirely. A door whose owner had REVOKED `contact`
 *  (or `mail`, or `note`) still read the whole thing. Two fences on one door, and **the one
 *  the owner can SEE did not compose with the one that ran: a revoke that did not revoke.**
 *  They reach EXTERNAL agents over the MCP wire (the InternalToolRegistry Tier-1 bridge in
 *  `mcp-server.ts` — NOT the static `recued_*` catalog, which is why an earlier grep for
 *  `callRpc`/`serverRegistry` found nothing and drew the wrong conclusion).
 *
 *  ## The rulings these tests exist to hold (owner, 2026-07-12)
 *  1. ⛔ **The DEFAULT is unchanged — raw collections stay author-default ADMIT.** It is the
 *     owner's call which contract gets the spine, *"not our place to limit it or predict
 *     what is best."* So this is BEHAVIOR-PRESERVING at zero revokes; it only makes the
 *     owner's call ENFORCEABLE. Do NOT "harden" it by tightening the default.
 *  2. **NEVER `ok:false`** — the Tier-1 ANTI-LOOP invariant (`createMemorySearchHandler` +
 *     the 2026-06-09 `enrichment.search` entry in `docs/chat-prompt-optimization-log.md`):
 *     an errored read sends a reasoning model into a retry-to-timeout loop.
 *  3. **NEVER a silent / unexplained empty.** Each tool has a DIFFERENT envelope, and two of
 *     them can LIE outright: mail+calendar refuse into `{ matches: [] }` (indistinguishable
 *     from an empty mailbox) and `work.read` into `{ entity: null, found: false }`
 *     (indistinguishable from a deleted record). A policy refusal that renders as absence is
 *     a FALSE NEGATIVE the model states to the user AS FACT — *"you have no mail from Bob"*,
 *     *"that task doesn't exist"*. `contact.search` (a fan-out) can carry a NAMED
 *     `partial_failure`; the other four carry a `hint`. Both are pinned.
 *  4. **The fence is scoped to the LOCAL read.** The vendor MIRROR + the outbound live
 *     escalation are a DIFFERENT authorization axis (the connection's own grant; the
 *     escalation is already judged by `admitSourceCatalogEscalation`). Denying a door its
 *     granted CRM lens because it lacks the core-graph grant would conflate two axes.
 *
 *  The gate under test is the REAL `createReadGrantChecker` — only the grant-ROW STORE (IO)
 *  is stubbed. A test that stubbed `isCollectionReadGranted` itself would prove nothing
 *  about the gate. Mutation-verified. */

import { describe, expect, it, vi } from 'vitest';

import { isReadableCollection, parseGrantEntry } from '@recued/contracts';
import type { ChatDispatchContext, ExecutionSource } from '@recued/contracts';

import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import type { GrantEntryResolver } from '../contract-grant-resolve.js';
import {
  createReadGrantChecker,
  type GatedReadGrantResolver,
} from '../read-grant-checker.js';

const DOOR = 'door-1';

/** The door's read fence as explicit grant rows: the listed collections GRANTED, every
 *  other GOVERNED collection REVOKED. This stubs the grant-row STORE only — the decision
 *  itself runs through the real `createReadGrantChecker`. */
const fence = (collections: readonly string[]): GrantEntryResolver => {
  const cols = new Set(collections);
  return {
    isGranted: (_contract_id, entry, authorDefault) => {
      const parsed = parseGrantEntry(entry);
      if (parsed.kind === 'collection') {
        return isReadableCollection(parsed.value) ? cols.has(parsed.value) : authorDefault;
      }
      return authorDefault;
    },
  };
};

const resolverFor = (collections: readonly string[]): GatedReadGrantResolver => ({
  resolveForContract: () => createReadGrantChecker(fence(collections), DOOR),
  resolveForSource: () => createReadGrantChecker(fence(collections), DOOR),
});

const doorSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'a1',
  tool_call_id: 'tc1',
  mcp_token_id: 'tok1',
  contract_id: DOOR,
};

/** An external door's MCP-wire dispatch — carries the `ExecutionSource` the fence
 *  resolves its governing contract from. */
const doorCtx = (): ChatDispatchContext => ({
  channel: 'mcp_wire',
  mcp_token_id: 'tok1',
  execution_source: doorSource,
});

/** The owner's own internal dispatch — NO `execution_source`, so the fence falls back to
 *  the author-default checker (admit). This is the shape every pre-existing
 *  `contact.search` test uses, which is why they stay green. */
const ownerCtx = (): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: 's1',
  turn_id: 't1',
});

/** The PII the fence must not leak. A distinctive string so a leak anywhere in the
 *  serialized envelope is caught, not just in the field we happened to assert on. */
const SECRET_NAME = 'Bob-Very-Secret-Surname';
const CONTACT_EMAIL = 'bob@acme.example';

/** The cross-plane LINK, as distinctive sentinels. Deliberately NOT the vendor's own record key:
 *  the whole question is whether the CORE row's link fields cross onto a chat candidate, and a
 *  fixture that reused the vendor's id would confuse "the link leaked" with "the vendor named
 *  itself". */
const LINK_SENTINEL = 'LINK-ID-DO-NOT-LEAK';
const CONTACT_ID_SENTINEL = 'ct_DO_NOT_LEAK';

type Stubs = {
  get?: ReturnType<typeof vi.fn>;
  list?: ReturnType<typeof vi.fn>;
  findByAlias?: ReturnType<typeof vi.fn>;
  mirrorList?: ReturnType<typeof vi.fn>;
  grants?: readonly string[] | undefined;
};

const buildDeps = (s: Stubs): ChatToolHandlerDeps => {
  const get = s.get ?? vi.fn().mockReturnValue({
    _id: CONTACT_EMAIL,
    email: CONTACT_EMAIL,
    name: SECRET_NAME,
  });
  const list = s.list ?? vi.fn().mockReturnValue([]);
  const findByAlias = s.findByAlias ?? vi.fn().mockReturnValue({ contact: null, alternatives: [] });
  return {
    getContactStore: () => ({ get, list, findByAlias }) as never,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    ...(s.mirrorList
      ? {
          getBoundCrmMirrorSources: () => [
            { source_id: 'hubspot', scope: 'connection.api.hubspot.contact' },
          ],
          getCrmRecordMirror: () => ({ list: s.mirrorList }) as never,
        }
      : {}),
    ...(s.grants !== undefined
      ? { getReadGrantResolver: () => resolverFor(s.grants as readonly string[]) }
      : {}),
  } as unknown as ChatToolHandlerDeps;
};

type Envelope = {
  candidates: Array<{
    source: string;
    record: { email: string | null; name?: string; target_id?: string };
  }>;
  partial?: boolean;
  partial_failures?: Array<{ source: string; reason: string }>;
};

const search = async (deps: ChatToolHandlerDeps, ctx: ChatDispatchContext) => {
  const handlers = buildChatTier1Handlers(deps);
  const result = await handlers['contact.search']!({ email: CONTACT_EMAIL, limit: 5 }, ctx);
  return result;
};

/** `contact.search` with caller-chosen args — the identifier branches (`alias` + `platform`)
 *  are a different code path from the `email` lookup, and it is the one that traverses the
 *  cross-plane LINK. */
const searchWith = async (
  deps: ChatToolHandlerDeps,
  ctx: ChatDispatchContext,
  args: Record<string, unknown>,
) => {
  const handlers = buildChatTier1Handlers(deps);
  return handlers['contact.search']!({ limit: 5, ...args }, ctx);
};

// ────────────────────────────────────────────────────────────────
// The SIBLINGS — mail.search / calendar.search / work.search / work.read.
//
// Same hole, four more tools. `isCollectionReadGranted` had ZERO call sites in
// `chat-tool-handlers.ts`, so ALL FIVE Tier-1 tools that read a governed collection
// ignored the owner's grants panel. Fixing contacts alone would have left `mail` — the
// more sensitive collection — wide open, which is how a "fix" ships next to its own hole.
//
// Each tool has a DIFFERENT envelope, so each refusal has to be honest in its own shape.
// The two that could lie are pinned hardest:
//   · mail/calendar → `{ matches: [] }`  — indistinguishable from an empty mailbox
//   · work.read     → `{ found: false }` — indistinguishable from a deleted record
// The `hint` is the only thing separating "you may not read this" from "this is not there".
// ────────────────────────────────────────────────────────────────

/** A `{ matches, collections }` tool (mail / calendar), driven with a registry that WOULD
 *  return a match — so an empty result can only come from the fence.
 *
 *  ⚠ The two tools reach their store through DIFFERENT surfaces: `mail.search` calls
 *  `c.search(...)`, `calendar.search` calls `c.table.search(...)` (and only accepts a
 *  collection that HAS a `table` — `isCalendarCollection`). A stub without `table` would
 *  fall into the pre-existing "no calendar collections" empty path and the test would go
 *  green for the WRONG reason, proving nothing about the fence. `probe` is whichever
 *  search the tool under test would actually call. */
const searchCollectionTool = async (
  tool: 'mail.search' | 'calendar.search',
  platform: 'mail' | 'calendar',
  grants: readonly string[] | undefined,
  ctx: ChatDispatchContext,
) => {
  const probe = vi.fn().mockReturnValue([
    { record_id: 'm1', hot: { subject: SECRET_NAME }, rank: 1, snippet: SECRET_NAME },
  ]);
  const collection =
    platform === 'mail'
      ? { platform, slug: 'mail-1', search: probe, list: () => [] }
      : { platform, slug: 'cal-1', table: { search: probe }, list: () => [] };
  const deps = {
    getCollectionRegistry: () => ({ list: () => [collection] }),
    ...(grants !== undefined ? { getReadGrantResolver: () => resolverFor(grants) } : {}),
  } as unknown as ChatToolHandlerDeps;
  const handlers = buildChatTier1Handlers(deps);
  const result = await handlers[tool]!({ query: 'anything', limit: 5 }, ctx);
  return { result, probe };
};

describe.each([
  ['mail.search', 'mail'],
  ['calendar.search', 'calendar'],
] as const)('D-205 #3 — %s honours the data.%s collection grant', (tool, platform) => {
  it('BEHAVIOR-PRESERVING: a door with NO explicit revoke still reads (author-default ADMIT)', async () => {
    const { result, probe } = await searchCollectionTool(
      tool, platform, [platform], doorCtx(),
    );
    expect(result.ok).toBe(true);
    expect(probe).toHaveBeenCalled();
  });

  it('THE FIX: a revoked door reads NOTHING, and the registry is never touched', async () => {
    // `contact` granted, this collection revoked — proves the fence is per-collection.
    const { result, probe } = await searchCollectionTool(
      tool, platform, ['contact'], doorCtx(),
    );
    expect(result.ok).toBe(true); // ANTI-LOOP
    expect(probe).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET_NAME);
  });

  it('THE REFUSAL IS VISIBLE: the empty carries a hint that is not "you have nothing"', async () => {
    // `{ matches: [] }` is indistinguishable from an empty mailbox. Without the hint the
    // model reports a policy fence to the user as a fact about their data.
    const { result } = await searchCollectionTool(tool, platform, ['contact'], doorCtx());
    const env = (result as { result: { matches: unknown[]; hint?: string } }).result;
    expect(env.matches).toHaveLength(0);
    expect(env.hint).toBeDefined();
    expect(env.hint!).toMatch(/not read-granted/i);
    expect(env.hint!).toContain(`data.${platform}`);
    expect(env.hint!).toMatch(/not .*not found|NOT an empty result/i);
    expect(env.hint!).toMatch(/do not retry/i);
  });
});

describe('D-205 #3 — work.search / work.read fence per KIND (task/note/commitment/project)', () => {
  /** `workDeps` now also wires the `core.work-entity.read` VERB-OP gate, because
   *  that fence runs BEFORE the per-kind one. Default: the verb GRANTED — these
   *  tests are about the COLLECTION axis, so the capability axis must be open or
   *  they'd all pass for the wrong reason (every refusal would be the verb's).
   *  The verb fence has its own describe block below. */
  const workDeps = (grants: readonly string[], verbGranted = true) =>
    ({
      getWorkEntityResolver: () => {
        throw new Error('resolver must NOT be reached when the kind is fenced');
      },
      getReadGrantResolver: () => resolverFor(grants),
      getOpAdmissionGate: () => ({
        isFrozenByPause: () => false,
        isOpGranted: (_s: ExecutionSource, opId: string | undefined) =>
          opId === 'core.work-entity.read' ? verbGranted : true,
      }),
    }) as unknown as ChatToolHandlerDeps;

  it('work.search: a revoked KIND returns a guided empty, resolver never reached', async () => {
    // `kind` IS the collection. `task` granted, `note` revoked.
    const handlers = buildChatTier1Handlers(workDeps(['task']));
    const result = await handlers['work.search']!({ kind: 'note', limit: 5 }, doorCtx());

    expect(result.ok).toBe(true); // ANTI-LOOP; and the throwing resolver proves no read
    const env = (result as { result: { entities: unknown[]; total: number; hint?: string } }).result;
    expect(env.entities).toHaveLength(0);
    expect(env.total).toBe(0);
    expect(env.hint).toMatch(/not read-granted/i);
    expect(env.hint).toContain('data.note');
  });

  it('work.read: a revoked KIND must NOT read as "not found" — the hint says so', async () => {
    // 🔑 The sharpest one. This tool's not-found shape is `{ entity: null, found: false }`.
    // Reusing it for a refusal tells the model "that task does not exist" — a policy
    // decision laundered into a fact about the world, which it states to the user as one.
    const handlers = buildChatTier1Handlers(workDeps(['task']));
    const result = await handlers['work.read']!(
      { kind: 'commitment', id: 'c1' },
      doorCtx(),
    );

    expect(result.ok).toBe(true);
    const env = (result as {
      result: { entity: unknown; found: boolean; hint?: string };
    }).result;
    expect(env.entity).toBeNull();
    expect(env.hint).toBeDefined();
    expect(env.hint!).toContain('data.commitment');
    expect(env.hint!).toMatch(/NOT "not found"/i);
    expect(env.hint!).toMatch(/may well exist/i);
  });

  it('BEHAVIOR-PRESERVING: a GRANTED kind reaches the resolver (the fence is not blanket)', async () => {
    // The throwing resolver is the assertion: a granted kind MUST get past the fence.
    const handlers = buildChatTier1Handlers(workDeps(['note']));
    await expect(
      handlers['work.search']!({ kind: 'note', limit: 5 }, doorCtx()),
    ).rejects.toThrow(/resolver must NOT be reached/);
  });
});

// ════════════════════════════════════════════════════════════════
// The `core.work-entity.read` VERB-OP fence — the CAPABILITY axis
//
// The read half of `work-entity` had no grant handle while all 15 of its writes
// had one, so `work.search` / `work.read` were default-ON for any door (Tier-1 +
// `classification: 'read'` → `buildDefaultMcpInboundTokenGrants` = true). The
// only thing between a door and the owner's whole work graph was the per-Source
// `mcp_exposed` flag — which is GLOBAL, not per-door, so exposing a Source for
// ONE door exposed it to every door holding the default-ON tool.
//
// These drive the REAL `buildChatTier1Handlers` → `admitWorkEntityRead`; only
// the gate's grant lookup is stubbed. `feedback_test_real_gate_not_mock_for_admission`.
// ════════════════════════════════════════════════════════════════

describe('work.search / work.read — the core.work-entity.read verb-op fence', () => {
  const verbDeps = (verbGranted: boolean) =>
    ({
      getWorkEntityResolver: () => {
        throw new Error('resolver must NOT be reached when the verb is fenced');
      },
      // EVERY collection granted — so a refusal here can ONLY be the verb.
      getReadGrantResolver: () =>
        resolverFor(['task', 'note', 'commitment', 'project']),
      getOpAdmissionGate: () => ({
        isFrozenByPause: () => false,
        isOpGranted: (_s: ExecutionSource, opId: string | undefined) =>
          opId === 'core.work-entity.read' ? verbGranted : true,
      }),
    }) as unknown as ChatToolHandlerDeps;

  it('an UNGRANTED verb fences work.search — guided empty, resolver never reached', async () => {
    const handlers = buildChatTier1Handlers(verbDeps(false));
    const result = await handlers['work.search']!({ kind: 'task', limit: 5 }, doorCtx());

    expect(result.ok).toBe(true); // ANTI-LOOP; the throwing resolver proves no read
    const env = (result as {
      result: { entities: unknown[]; total: number; hint?: string };
    }).result;
    expect(env.entities).toHaveLength(0);
    expect(env.total).toBe(0);
    expect(env.hint).toMatch(/core\.work-entity\.read/);
  });

  it('an UNGRANTED verb fences work.read — and NOT as "not found"', async () => {
    // Same sharpest-case reasoning as the per-kind twin: `{entity: null,
    // found: false}` reads as "that task does not exist" — here about a record
    // the user just named by id.
    const handlers = buildChatTier1Handlers(verbDeps(false));
    const result = await handlers['work.read']!({ kind: 'task', id: 't1' }, doorCtx());

    expect(result.ok).toBe(true);
    const env = (result as {
      result: { entity: unknown; found: boolean; hint?: string };
    }).result;
    expect(env.entity).toBeNull();
    expect(env.hint).toBeDefined();
    expect(env.hint!).toMatch(/core\.work-entity\.read/);
    expect(env.hint!).toMatch(/NOT "not found"/i);
    expect(env.hint!).toMatch(/may well exist/i);
  });

  it('🔑 the verb refusal must NOT send the user chasing a data.<kind> grant', async () => {
    // The two fences are fixed by DIFFERENT grants. Naming the collection here
    // would be a wild goose chase — granting `data.task` cannot lift a verb
    // refusal — and the model states the remedy to the user as fact.
    const handlers = buildChatTier1Handlers(verbDeps(false));
    const result = await handlers['work.search']!({ kind: 'task', limit: 5 }, doorCtx());
    const hint = (result as { result: { hint?: string } }).result.hint!;

    expect(hint).not.toMatch(/data\.task/);
    expect(hint).toMatch(/will NOT lift this/i);
  });

  it('BEHAVIOR-PRESERVING: a GRANTED verb reaches the resolver', async () => {
    const handlers = buildChatTier1Handlers(verbDeps(true));
    await expect(
      handlers['work.search']!({ kind: 'task', limit: 5 }, doorCtx()),
    ).rejects.toThrow(/resolver must NOT be reached/);
  });

  it('🔑 a MISSING gate fails CLOSED — a door cannot read by starving the seam', async () => {
    // The precise shape of the bug this op fixes: an absent fence must never
    // read as permission. Mirrors `admitMemoryRead`'s posture.
    const noGate = {
      getWorkEntityResolver: () => {
        throw new Error('resolver must NOT be reached with no gate');
      },
      getReadGrantResolver: () =>
        resolverFor(['task', 'note', 'commitment', 'project']),
    } as unknown as ChatToolHandlerDeps;
    const handlers = buildChatTier1Handlers(noGate);
    const result = await handlers['work.search']!({ kind: 'task', limit: 5 }, doorCtx());

    expect(result.ok).toBe(true);
    expect((result as { result: { hint?: string } }).result.hint).toMatch(
      /core\.work-entity\.read/,
    );
  });

  it('the verb fence runs BEFORE the per-kind fence — the coarser axis answers first', async () => {
    // Both fences would refuse; the caller must learn the VERB is missing,
    // because that is the one they'd have to fix first.
    const bothFenced = {
      getWorkEntityResolver: () => {
        throw new Error('resolver must NOT be reached');
      },
      getReadGrantResolver: () => resolverFor([]), // every collection revoked too
      getOpAdmissionGate: () => ({
        isFrozenByPause: () => false,
        isOpGranted: () => false,
      }),
    } as unknown as ChatToolHandlerDeps;
    const handlers = buildChatTier1Handlers(bothFenced);
    const result = await handlers['work.search']!({ kind: 'task', limit: 5 }, doorCtx());
    const hint = (result as { result: { hint?: string } }).result.hint!;

    expect(hint).toMatch(/core\.work-entity\.read/);
    expect(hint).not.toMatch(/data\.task/);
  });
});

describe('D-205 #3 — contact.search honours the data.contact collection grant', () => {
  it('BEHAVIOR-PRESERVING: the owner (no execution_source) still reads the graph', async () => {
    const get = vi.fn().mockReturnValue({
      _id: CONTACT_EMAIL,
      email: CONTACT_EMAIL,
      name: SECRET_NAME,
    });
    const result = await search(buildDeps({ get }), ownerCtx());

    expect(result.ok).toBe(true);
    const env = (result as { result: Envelope }).result;
    expect(env.candidates.map((c) => c.source)).toContain('local');
    expect(get).toHaveBeenCalledWith(CONTACT_EMAIL);
  });

  it('BEHAVIOR-PRESERVING: a door with NO explicit revoke reads the graph (author-default ADMIT)', async () => {
    // The owner's ruling: raw collections stay default-open. A door that was never
    // explicitly revoked keeps reading — this fence does NOT tighten the default.
    const get = vi.fn().mockReturnValue({
      _id: CONTACT_EMAIL,
      email: CONTACT_EMAIL,
      name: SECRET_NAME,
    });
    const result = await search(buildDeps({ get, grants: ['contact'] }), doorCtx());

    expect(result.ok).toBe(true);
    const env = (result as { result: Envelope }).result;
    expect(env.candidates.map((c) => c.source)).toContain('local');
    expect(get).toHaveBeenCalledWith(CONTACT_EMAIL);
  });

  it('THE FIX: a door whose owner REVOKED contact reads NOTHING from the core graph', async () => {
    const get = vi.fn().mockReturnValue({
      _id: CONTACT_EMAIL,
      email: CONTACT_EMAIL,
      name: SECRET_NAME,
    });
    // `mail` granted, `contact` revoked — a real, plausible door fence.
    const result = await search(buildDeps({ get, grants: ['mail'] }), doorCtx());

    expect(result.ok).toBe(true); // ANTI-LOOP: never ok:false
    const env = (result as { result: Envelope }).result;

    // No local candidate...
    expect(env.candidates.filter((c) => c.source === 'local')).toHaveLength(0);
    // ...and the store was never even READ — the fence is upstream of the query.
    expect(get).not.toHaveBeenCalled();
    // ...and no PII leaked anywhere in the envelope.
    expect(JSON.stringify(result)).not.toContain(SECRET_NAME);
  });

  it('THE REFUSAL IS VISIBLE: it surfaces as a NAMED partial_failure, never a silent empty', async () => {
    // A silent empty would read as "this person does not exist" — a false negative the
    // model reports to the user as fact. The refusal must be legible.
    const result = await search(buildDeps({ grants: ['mail'] }), doorCtx());

    expect(result.ok).toBe(true);
    const env = (result as { result: Envelope }).result;
    expect(env.partial).toBe(true);
    const localFailure = env.partial_failures?.find((f) => f.source === 'local');
    expect(localFailure).toBeDefined();
    expect(localFailure!.reason).toMatch(/not read-granted/i);
    expect(localFailure!.reason).toMatch(/data\.contact/);
  });

  it('SEPARATE AXES: revoking data.contact does NOT suppress a granted CRM mirror', async () => {
    // The mirror is the VENDOR plane (its own connection grant; its live escalation is
    // already judged by `admitSourceCatalogEscalation`). Collapsing the two axes would
    // deny a door its granted CRM lens because it lacks the core-graph grant.
    const get = vi.fn().mockReturnValue({
      _id: CONTACT_EMAIL,
      email: CONTACT_EMAIL,
      name: SECRET_NAME,
    });
    const mirrorList = vi.fn().mockReturnValue([
      { target_id: 'hubspot_contact_1', meta: { email: CONTACT_EMAIL, name: 'Bob From HubSpot' } },
    ]);
    const result = await search(buildDeps({ get, mirrorList, grants: ['mail'] }), doorCtx());

    expect(result.ok).toBe(true);
    const env = (result as { result: Envelope }).result;
    // The core graph is fenced off...
    expect(env.candidates.filter((c) => c.source === 'local')).toHaveLength(0);
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET_NAME);
    // ...but the vendor mirror still answers under its own axis.
    expect(env.candidates.map((c) => c.source)).toContain('hubspot');
    expect(mirrorList).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// D-205 #3 RESIDUAL — the "LINK join" gate. ⛔ **IT IS MOOT, AND THESE TESTS ARE WHY.**
//
// The spec (§3 "The LINK is the gate-crossing edge") said `contact.search` *"MERGES local +
// mirror candidates into one list"* and that **"nothing enforces resolving `platform_ids`
// needs BOTH grants"** — and predicted the leak: a `crm=yes, core=no` door seeing a CRM
// record rendered as *"your contact Bob"*.
//
// 🔑 **Re-derived from code, the premise is false, and so no gate is needed:**
//
//   1. **The fan-out APPENDS; it does not JOIN.** `runScopeSearchFanout` pushes each source's
//      records with a `source:` tag — no dedup, no merge, no cross-source correlation.
//      "MERGES" is the wrong word for a concatenation.
//   2. **The link is NEVER PROJECTED.** Both `projectLocalContact` and `projectPlatformContact`
//      build the SAME flat `ChatContactCandidate` — `{email, target_id, name?, lifecycle_stage?,
//      recent_activity_at?}`. No `platform_ids`. No `contact_id`. And `target_id` is explicitly
//      PER-SOURCE (local → the canonical email; mirrors → `<vendor>_contact_<id>`), so the two
//      planes never even share a key space. There is nothing joined, hence nothing to gate.
//   3. **The ONE real link traversal is already fenced.** `alias` + `platform` resolves a
//      vendor `platform_id` → the CORE contact ("which of your contacts IS HubSpot 47291?").
//      That is the gate-crossing edge, in reverse — and it sits inside the LOCAL source, behind
//      the `data.contact` fence, which throws before any branch runs.
//
// ⚠ **So the danger is not a missing gate — it is a plausible future REFACTOR.** "Dedup the
// fan-out by email" is the most natural cleanup imaginable, and it would fuse the local Bob and
// the HubSpot Bob into one row: an assertion that *this vendor record IS your contact*, created
// by a tidy-up, leaking exactly what the owner predicted. These tests exist to make that
// refactor go red. **Do not delete them to "simplify the fan-out".**
//
// ⚠ Residual, unchanged and still an OWNER CALL (spec §3): under a `core=yes, crm=no` grant a
// provenance label / `platform_ids` on a `data.contact` read reveals that a HubSpot connection
// EXISTS (and an opaque record id) — never its dataset. Accepted, or suppress. Not a gate.
// ────────────────────────────────────────────────────────────────

describe('D-205 #3 residual — the LINK join is MOOT: the fan-out never joins the two planes', () => {
  it('APPENDS, NEVER JOINS: one person, two sources, TWO candidates in two key spaces', async () => {
    // 🔑 The refactor-defence. Both grants held, and the local contact and the HubSpot record
    // are THE SAME HUMAN (same email) — the exact input a "dedup the fan-out" cleanup would
    // collapse into one row. It must stay two rows: the vendor record is evidence from the
    // vendor plane, not an assertion about who your contact is.
    // ⚠ The link id is a DISTINCT sentinel, not the vendor's own record key. My first draft used
    // the same number for both, and the assertion "the link never crosses" then tripped on the
    // vendor candidate's own legitimate `target_id` — a fixture-value coincidence that would have
    // masked (or faked) the very thing under test.
    // [[feedback_fixture_value_coincidence_masks_field_confusion]]
    const get = vi.fn().mockReturnValue({
      _id: CONTACT_EMAIL,
      email: CONTACT_EMAIL,
      name: SECRET_NAME,
      // The core contact DOES carry the link — but it is a local-only field and must never ride
      // out on a chat candidate.
      platform_ids: [{ vendor: 'hubspot', platform_id: LINK_SENTINEL, state: 'confirmed' }],
      contact_id: CONTACT_ID_SENTINEL,
    });
    const mirrorList = vi.fn().mockReturnValue([
      { target_id: 'hubspot_contact_47291', meta: { email: CONTACT_EMAIL, name: 'Bob From HubSpot' } },
    ]);
    const result = await search(
      buildDeps({ get, mirrorList, grants: ['contact'] }),
      doorCtx(),
    );

    expect(result.ok).toBe(true);
    const env = (result as { result: Envelope }).result;

    // TWO candidates for one human — not one fused row.
    expect(env.candidates).toHaveLength(2);
    expect(env.candidates.map((c) => c.source).sort()).toEqual(['hubspot', 'local']);

    // Each stays in its OWN key space. A joined row would have to pick one, and picking IS the
    // assertion "these two are the same record".
    const local = env.candidates.find((c) => c.source === 'local')!;
    const vendor = env.candidates.find((c) => c.source === 'hubspot')!;
    expect(local.record.target_id).toBe(CONTACT_EMAIL);
    expect(vendor.record.target_id).toBe('hubspot_contact_47291');

    // ⛔ And the LINK itself never crosses: no `platform_ids`, no `contact_id`, anywhere in the
    // envelope — even though the local store row carries both. They stay reachable only through a
    // `data.contact.<email>` read, which is fenced by this same grant.
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('platform_ids');
    expect(wire).not.toContain(LINK_SENTINEL);
    expect(wire).not.toContain(CONTACT_ID_SENTINEL);
  });

  it('AS ITSELF, NEVER AS "YOUR CONTACT BOB": crm=yes / core=no renders the vendor record only', async () => {
    // The leak the owner predicted, and the one the spec wanted a gate for. It cannot occur:
    // `projectPlatformContact` builds the candidate from the VENDOR's own meta snapshot, so the
    // record renders as itself — the vendor's name, the vendor's key — and the core graph, which
    // is what would supply "your contact Bob", is fenced off entirely.
    const get = vi.fn().mockReturnValue({
      _id: CONTACT_EMAIL,
      email: CONTACT_EMAIL,
      name: SECRET_NAME,
      contact_id: 'ct_bob',
    });
    const mirrorList = vi.fn().mockReturnValue([
      { target_id: 'hubspot_contact_47291', meta: { email: CONTACT_EMAIL, name: 'Bob From HubSpot' } },
    ]);
    const result = await search(buildDeps({ get, mirrorList, grants: ['mail'] }), doorCtx());

    expect(result.ok).toBe(true);
    const env = (result as { result: Envelope }).result;

    const vendor = env.candidates.find((c) => c.source === 'hubspot')!;
    expect(vendor).toBeDefined();
    // The vendor's OWN name and key — never the core contact's identity.
    expect(vendor.record.name).toBe('Bob From HubSpot');
    expect(vendor.record.target_id).toBe('hubspot_contact_47291');
    expect(env.candidates.filter((c) => c.source === 'local')).toHaveLength(0);
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET_NAME);
    expect(JSON.stringify(result)).not.toContain('ct_bob');
  });

  it('🔑 THE REVERSE EDGE IS NOT EVEN EXPRESSIBLE: contact.search cannot NAME a CRM vendor', async () => {
    // 🔑 The last place a link could have been traversed — and it cannot be, by VOCABULARY.
    //
    // I built this test expecting to find the gate-crossing edge here: `alias` + `platform`
    // takes a record id and hands back the CORE contact ("which of your contacts IS HubSpot
    // 47291?"). **It does not reach the CRM plane at all**, and the test is what proved it:
    //
    //   · the CRM link lives in its OWN table, `contact_platform_link`
    //     (`ContactRecord.platform_ids`, `vendor: string` — hubspot / salesforce);
    //   · `contact.search`'s alias branch searches `contact_alias`, whose `platform` is a
    //     `ContactAliasPlatform` — a CLOSED, SOCIAL list:
    //     facebook · x · instagram · linkedin · github · substack.
    //
    // Two different substrates that happen to share the word "platform". A CRM vendor is not a
    // member of the alias vocabulary, so the tool rejects it outright — there is no door-
    // reachable read anywhere that resolves a CRM `platform_id` → a core contact.
    //
    // ⚠ If someone ever widens `CONTACT_ALIAS_PLATFORMS` to include a CRM vendor, THIS test goes
    // red — and that is the moment the LINK-join question becomes real. It is the tripwire.
    const findByAlias = vi.fn();
    const result = await searchWith(
      buildDeps({ findByAlias, grants: ['contact'] }),
      doorCtx(),
      { alias: '47291', platform: 'hubspot' },
    );

    // Rejected at the ARGS boundary (a correctable model error), not at the read.
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('invalid_args');
    expect((result as { detail: string }).detail).toMatch(/not a supported contact alias platform/);
    expect(findByAlias).not.toHaveBeenCalled();
  });

  it('the SOCIAL alias lookup is a CORE-graph read, and the fence covers it too', async () => {
    // The alias branch that DOES exist (`linkedin`, not `hubspot`) reads the core contact graph,
    // so the `data.contact` fence must cover it — the fence throws at the TOP of the local
    // source, before any identifier branch runs, which is what makes that true for every branch
    // rather than just the `email` one the other tests drive.
    const findByAlias = vi.fn().mockReturnValue({
      contact: { _id: CONTACT_EMAIL, email: CONTACT_EMAIL, name: SECRET_NAME },
      alternatives: [],
    });

    const revoked = await searchWith(
      buildDeps({ findByAlias, grants: ['mail'] }),
      doorCtx(),
      { alias: 'bob-smith', platform: 'linkedin' },
    );
    expect(revoked.ok).toBe(true); // ANTI-LOOP — a refusal is never ok:false
    const revokedEnv = (revoked as { result: Envelope }).result;
    expect(findByAlias).not.toHaveBeenCalled(); // the store was not even asked
    expect(revokedEnv.candidates.filter((c) => c.source === 'local')).toHaveLength(0);
    expect(JSON.stringify(revoked)).not.toContain(SECRET_NAME);
    expect(
      revokedEnv.partial_failures?.find((f) => f.source === 'local')?.reason,
    ).toMatch(/data\.contact/);

    // BEHAVIOR-PRESERVING: granted, it resolves. The fence is not blanket.
    const granted = await searchWith(
      buildDeps({ findByAlias, grants: ['contact'] }),
      doorCtx(),
      { alias: 'bob-smith', platform: 'linkedin' },
    );
    expect(granted.ok).toBe(true);
    const grantedEnv = (granted as { result: Envelope }).result;
    expect(findByAlias).toHaveBeenCalled();
    expect(grantedEnv.candidates.filter((c) => c.source === 'local')).toHaveLength(1);
  });
});
