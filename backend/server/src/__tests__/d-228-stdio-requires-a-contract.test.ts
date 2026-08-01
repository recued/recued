/** D-228 slices 1 + 6 — the stdio/CLI MCP surface carries a contract or carries
 *  nothing, AT ALL THREE SEAMS.
 *
 *  ⛔ PROXIMITY IS NOT IDENTITY. This surface used to hand back every slug that
 *  cleared two hardcoded fences, unfiltered, because it supplied no
 *  `inboundTokenAuthorize` — `buildMcpExecutionSource`'s own comment described
 *  the result as "governed by no contract (the owner reads all)". Claude Desktop
 *  is a third-party application, and so is any local process that can reach a
 *  stdio server; running on the owner's machine does not make a caller the
 *  owner.
 *
 *  ⛔⛔ SLICE 1 CLOSED ONLY ONE OF THE THREE and the commit headline overclaimed
 *  for a day: `buildMcpContractSnapshot` returned `[]`, while `handleToolsList`
 *  (`gate ? gate(t.name) : true`) and `handleToolCall` (`deps.inboundTokenAuthorize
 *  && !deps.inboundTokenAuthorize(name)` — an absent callback SKIPS the deny)
 *  both went on treating "no checklist" as "the owner, allow everything". So a
 *  token-less `recued mcp` still ADVERTISED and DISPATCHED the whole registry
 *  catalog. Slice 6 closes both; the enumeration and dispatch tests below are
 *  what makes the headline true.
 *
 *  ⚠ UNBOUND IS NOT UNGATED — the distinction the old fixtures blurred.
 *  `boundContractId: undefined` is a token carrying no CONTRACT (it still has a
 *  checklist). `inboundTokenAuthorize: undefined` is NO TOKEN AT ALL. Only the
 *  second is denied here. */

import { describe, expect, it } from 'vitest';

import { primitiveGrantEntry } from '@recued/contracts';

import { _testing } from '../mcp-server.js';

const manifests = new Map<string, unknown>([
  ['ai-classify', { slug: 'ai-classify', kind: 'api', author: 'acme' }],
  ['data-file-read', { slug: 'data-file-read', kind: 'api', author: 'acme' }],
]);

const baseDeps = {
  executorConfig: {
    manifests: {
      slugs: () => [...manifests.keys()],
      get: (slug: string) => manifests.get(slug) ?? null,
    },
  },
  // `ids` is what `recued_listRecipes` dispatches into — needed so the
  // permitting witness below proves the call REACHES the handler rather than
  // dying earlier for an unrelated reason.
  recipeStore: { get: () => null, ids: () => [] },
} as Record<string, unknown>;

const source = { channel: 'mcp', actor: 'contracted_user', contract_id: 'c1' } as never;

const snapshot = (deps: unknown) =>
  (_testing as unknown as {
    buildMcpContractSnapshot: (
      s: unknown, d: unknown,
    ) => { allowed_tools: readonly string[] };
  })
    .buildMcpContractSnapshot(source, deps);

const listTools = async (deps: unknown): Promise<string[]> => {
  const res = (await (_testing as {
    handleToolsList: (d: unknown) => Promise<{ tools: Array<{ name: string }> }>;
  }).handleToolsList(deps));
  return res.tools.map((t) => t.name);
};

const callTool = async (name: string, deps: unknown) =>
  (await (_testing as {
    handleToolCall: (p: unknown, d: unknown) => Promise<{
      isError?: boolean; content: Array<{ text: string }>;
    }>;
  }).handleToolCall({ name, arguments: {} }, deps));

describe('D-228 slice 6 — ENUMERATION denies without a checklist', () => {
  /** ⛔⛔ THE REGRESSION GUARD for `handleToolsList`. Restoring the old
   *  `gate ? gate(t.name) : true` reds this. An ungranted tool's NAME, DESCRIPTION
   *  and SCHEMA are themselves disclosure — the catalog tells a caller what this
   *  server can reach — so the enumeration seam has to close with the dispatch. */
  it('a token-less caller is advertised NOTHING — not even the meta tools', async () => {
    expect(await listTools(baseDeps)).toEqual([]);
  });

  /** ⚠ THE PERMITTING WITNESS. Without it "returns []" is indistinguishable
   *  from a `handleToolsList` that returns [] for everyone — which would have
   *  dark-booted every MCP client instead of fixing anything. */
  it('…while a caller WITH a checklist is advertised what it grants', async () => {
    const names = await listTools({ ...(baseDeps as object), inboundTokenAuthorize: () => true });
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('recued_listRecipes');
  });

  it('and the checklist still filters — a granted name appears, an ungranted one does not', async () => {
    const names = await listTools({
      ...(baseDeps as object),
      inboundTokenAuthorize: (n: string) => n === 'recued_listRecipes',
    });
    expect(names).toEqual(['recued_listRecipes']);
  });
});

describe('D-228 slice 6 — DISPATCH denies without a checklist', () => {
  /** ⛔⛔ THE REGRESSION GUARD for `handleToolCall`, and the seam that actually
   *  moved data. Enumeration only leaks the menu; this is the one where a
   *  token-less local process READ THE OWNER'S MAIL. */
  it('a token-less caller cannot dispatch, and is told why', async () => {
    const res = await callTool('recued_listRecipes', baseDeps);
    expect(res.isError).toBe(true);
    // The refusal names the RECOVERY, not just the denial — this surface had no
    // way to present a token before slice 1, so a bare "denied" is a dead end.
    expect(res.content[0]?.text).toContain('presented no MCP token');
    expect(res.content[0]?.text).toContain('RECUED_MCP_TOKEN');
  });

  /** ⚠ THE PERMITTING WITNESS — the dispatch path must still WORK. */
  it('…while a granted caller dispatches', async () => {
    const res = await callTool('recued_listRecipes', {
      ...(baseDeps as object),
      inboundTokenAuthorize: () => true,
    });
    expect(res.isError).toBeFalsy();
  });

  it('an ungranted tool is refused with the CHECKLIST message, not the no-token one', async () => {
    const res = await callTool('recued_listRecipes', {
      ...(baseDeps as object),
      inboundTokenAuthorize: () => false,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("per-tool checklist");
    expect(res.content[0]?.text).not.toContain('presented no MCP token');
  });
});

/** D-228 slice 5 — the property that makes CONTRACT-level wiring of Tier-1
 *  primitives redundant on this channel, pinned at the DISPATCH SEAM.
 *
 *  ⛔⛔ It was only ever proven on the PURE PREDICATE
 *  (`isMcpInboundTokenToolAuthorized(record, 'contact.search') === false` in
 *  `d-137-phase-5-inbound-tokens.test.ts`), which says nothing about whether
 *  `handleToolCall` consults it for a Tier-1 name. Tier-1 dispatch inside the
 *  registry is `handler(args, ctx)` with NO op gate of its own, so if the wire
 *  gate ever stopped covering registry names, primitives would become ungated
 *  and every test above would still pass. */
describe('a Tier-1 primitive is governed by the per-token checklist', () => {
  it('⛔ a DENIED primitive is refused before any dispatch', async () => {
    const res = await callTool('contact.search', {
      ...(baseDeps as object),
      inboundTokenAuthorize: (n: string) => n !== 'contact.search',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('per-tool checklist');
  });

  /** ⚠ THE PERMITTING WITNESS, and it needs the indirect proof: with no
   *  `internalRegistry` on these deps an ADMITTED name falls through to the
   *  dispatch default and THROWS `Unknown tool`. That throw is the evidence the
   *  gate passed — a refusal returns an envelope, it does not throw. Without
   *  this half, the test above is indistinguishable from "every name is
   *  refused". */
  it('…while a GRANTED primitive gets past the gate', async () => {
    let threw: unknown = null;
    try {
      await callTool('contact.search', {
        ...(baseDeps as object),
        inboundTokenAuthorize: () => true,
      });
    } catch (e) { threw = e; }
    expect((threw as Error | null)?.message ?? '').toMatch(/Unknown tool/);
    expect((threw as Error | null)?.message ?? '').not.toMatch(/checklist/);
  });
});

/** D-228 slice 5 — THE CONTRACT GATE on Tier-1 primitives, on `mcp_wire`.
 *
 *  ⛔⛔ THIS IS A SECOND AXIS, not a replacement. The per-token checklist above
 *  says what THIS TOKEN may use; the contract says what this DOOR may ever be
 *  granted. Both must pass, so a token can never widen past its contract — the
 *  property D-228 exists for.
 *
 *  ⚠ Every one of these supplies an `opAdmissionGate`. Without one the gate
 *  short-circuits, which is exactly why the rest of the MCP suite stayed green
 *  when this landed: a guard stubbed out at every call site has never run. */
const gateDeps = (
  isOpGranted: (source: unknown, opId: string) => boolean,
  seen?: string[],
) => ({
  ...(baseDeps as object),
  inboundTokenAuthorize: () => true,
  internalRegistry: { getByName: (n: string) => ({ name: n, tier: 1, _meta: { tier: 1 } }) },
  opAdmissionGate: {
    isOpGranted: (source: unknown, opId: string) => {
      seen?.push(opId);
      return isOpGranted(source, opId);
    },
  },
});

describe('D-228 slice 5 — the contract gates Tier-1 primitives', () => {
  it('⛔ a primitive the contract does not grant is REFUSED', async () => {
    const res = await callTool('mail.search', gateDeps(() => false));
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('not granted by this contract');
  });

  /** ⚠ THE PERMITTING WITNESS. Without it "refused" is indistinguishable from a
   *  branch that refuses every Tier-1 name. An ADMITTED call proceeds past the
   *  gate into dispatch, which these partial deps cannot complete — so it throws
   *  rather than returning the contract-deny envelope, and that is the proof. */
  it('…while a granted primitive gets PAST the gate', async () => {
    let threw: unknown = null;
    let res: { content?: Array<{ text: string }> } | null = null;
    try {
      res = await callTool('mail.search', gateDeps(() => true));
    } catch (e) { threw = e; }
    const text = res?.content?.[0]?.text ?? '';
    expect(text).not.toContain('not granted by this contract');
    expect(threw !== null || text !== '').toBe(true);
  });

  /** ⛔ Keyed on the NAMESPACED id — the same one the reconcile seeds, the
   *  grandfather writes and the grants UI toggles. A gate reading the bare tool
   *  name would deny/admit against an id nothing else ever writes. */
  it('asks the gate about `primitive.<tool>`, never the bare name', async () => {
    const seen: string[] = [];
    await callTool('mail.search', gateDeps(() => false, seen));
    expect(seen).toContain(primitiveGrantEntry('mail.search'));
    expect(seen).not.toContain('mail.search');
  });

  /** ⚠ THE DISCRIMINATOR — Tier 2 (installed recipes) is governed by its own
   *  recipe-dispatch path, so a blanket registry gate would double-gate it. */
  it('does not gate a Tier-2 entry', async () => {
    const seen: string[] = [];
    const deps = {
      ...gateDeps(() => false, seen),
      internalRegistry: { getByName: (n: string) => ({ name: n, tier: 2, _meta: { tier: 2 } }) },
    };
    let text = '';
    try {
      const res = await callTool('acme/some-recipe', deps);
      text = res.content?.[0]?.text ?? '';
    } catch { /* dispatch incomplete on partial deps — fine */ }
    expect(text).not.toContain('not granted by this contract');
    expect(seen).toHaveLength(0);
  });
});

describe('a caller carrying nothing gets nothing', () => {
  it('⛔ NO authorizer ⇒ an EMPTY catalog, never every slug', () => {
    expect(snapshot(baseDeps).allowed_tools).toEqual([]);
  });
});

describe('a caller carrying a contract gets what it grants', () => {
  /** ⛔⛔ THE PERMITTING WITNESS, and the half that makes the test above mean
   *  something. Without it, "returns []" is indistinguishable from a snapshot
   *  builder that returns [] for everyone. */
  it('an authorizer that grants one slug yields exactly that slug', () => {
    const out = snapshot({
      ...baseDeps,
      inboundTokenAuthorize: (name: string) => name === 'ai-classify',
    });
    expect(out.allowed_tools).toContain('ai-classify');
    expect(out.allowed_tools).not.toContain('data-file-read');
  });

  /** The wire-name alias is load-bearing: `allowed_tools` keys on raw slugs
   *  while the per-tool gate keys on wire names, so a
   *  `recued_ingredient_<slug>` grant has to admit the bare slug too. */
  it('admits a slug granted under its recued_ingredient_ wire name', () => {
    const out = snapshot({
      ...baseDeps,
      inboundTokenAuthorize: (name: string) => name === 'recued_ingredient_data-file-read',
    });
    expect(out.allowed_tools).toContain('data-file-read');
  });

  /** ⛔ A dead bound contract still denies — the kill switch runs before any
   *  grant is consulted, so this is not reachable by granting harder. */
  it('a bound-but-inactive contract yields nothing even with a permissive authorizer', () => {
    const out = snapshot({
      ...baseDeps,
      boundContractId: 'c9',
      boundContractActive: false,
      inboundTokenAuthorize: () => true,
    });
    expect(out.allowed_tools).toEqual([]);
  });
});
