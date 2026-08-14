/** D-225 Slice 2 — minting a pack from an MCP server's `tools/list`.
 *
 *  The claims that matter here are about IDENTITY, not shape:
 *
 *  - a grant is issued against an op id, so the op id must change when the tool
 *    changes and must NOT change when anything else does;
 *  - the derivation must not depend on which OTHER tools exist, or adding a
 *    tool could move an unrelated grant;
 *  - the generated pack must be VALIDATED, which means its publisher must not
 *    be the one that bypasses validation.
 *
 *  Each of those is tested by the case that would break it, not by a happy path.
 */
import { describe, expect, it } from 'vitest';
import {
  FIRST_PARTY_PUBLISHER,
  GENERATED_PACK_PUBLISHER,
  KERNEL_AUTHOR,
  RESERVED_HANDLES,
  isKernelManifest,
  parseOpId,
  publisherMayDeclare,
  type IngredientManifest,
  type McpToolDescriptor,
} from '@recued/contracts';

import { decomposeComposition } from '../decomposer.js';
import { validateComposition } from '../validators.js';
import { validateIngredient } from '@recued/ingredients';
import {
  generateMcpPackComposition,
  mcpGeneratedPackSlug,
  mcpToolDescriptorHash,
  mcpToolOpSegment,
  stampGeneratedMcpCatalog,
} from '../mcp-pack.js';

const CONNECTION = { kind: 'mcp', name: 'recued_peer' };

const tool = (over: Partial<McpToolDescriptor> = {}): McpToolDescriptor => ({
  name: 'project.list',
  description: 'List projects.',
  input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
  ...over,
});

const generate = (descriptors: McpToolDescriptor[]) =>
  generateMcpPackComposition({ connection: CONNECTION, descriptors });

describe('§ 234.4p.16d — the composition binds the connection by NAME', () => {
  it('binds `ingredients[].connection.connection` to the connection NAME, not its kind', async () => {
    // ⛔⛔ THIS FIELD HAD NO COVERAGE AND CARRIED A `.kind` WHERE `.name`
    // BELONGS, so every generated pack bound its catalog to a connection
    // literally called 'mcp'. Nothing named the enrolled connection, so no
    // `connection_catalog_binding` row existed, the profile reconciler had no
    // target, the pack grants could not be recorded (the grant scope REQUIRES a
    // connection_name) and the D-165 gateway denied every op — as
    // `no_connection_profile` when a recipe named the connection and
    // `operation_not_granted` when it did not. It read as an authorization
    // problem for three rounds of chasing.
    //
    // 🔑 The fixture discriminates BY CONSTRUCTION: `CONNECTION.kind` ('mcp')
    // and `CONNECTION.name` ('recued_peer') differ, so this assertion cannot
    // pass against the old value. A fixture whose kind and name matched would
    // have been green either way — which is how the bug survived.
    const composition = await generate([tool()]);
    const ingredients = (composition as unknown as {
      ingredients: { connection?: { connection?: string } }[];
    }).ingredients;
    expect(ingredients).toHaveLength(1);
    expect(ingredients[0]?.connection?.connection).toBe(CONNECTION.name);
    expect(ingredients[0]?.connection?.connection).not.toBe(CONNECTION.kind);
  });
});

describe('D-225 Slice 2 — the publisher must not be the validator bypass', () => {
  it('is NOT the kernel author', () => {
    // ⛔ The whole point. `isKernelManifest` is a validator bypass, not a label:
    // a manifest authored `recued` never reaches catalog-form or surface
    // validation. A generated pack — per-user, minted from a third party's
    // tools/list, reviewed by nobody — must not receive that exemption.
    expect(GENERATED_PACK_PUBLISHER).not.toBe(KERNEL_AUTHOR);
    expect(isKernelManifest({ author: GENERATED_PACK_PUBLISHER })).toBe(false);
    // The permitting half — proves the check is live and would have caught it.
    expect(isKernelManifest({ author: KERNEL_AUTHOR })).toBe(true);
  });

  it('holds no reserved pack capability', () => {
    // `publisherMayDeclare` is exact-equality on `recued-core`. If it ever
    // became a `recued*` prefix match, this handle would silently acquire
    // first-party capabilities.
    expect(publisherMayDeclare(GENERATED_PACK_PUBLISHER, 'pre_install')).toBe(false);
    expect(publisherMayDeclare(GENERATED_PACK_PUBLISHER, 'connection_requirements')).toBe(false);
  });

  it('is reserved, so no third party can publish under it', () => {
    expect(RESERVED_HANDLES.has(GENERATED_PACK_PUBLISHER)).toBe(true);
  });
});

describe('D-225 Slice 2 — grant identity', () => {
  it('a MUTATED tool gets a DIFFERENT op id, so its grant cannot carry over', () => {
    // ⛔ The one tools/list change identity alone does not cover (§ 7). Same
    // NAME, different argument shape — a grant issued for the old shape would
    // keep applying if the id were derived from the name.
    const before = tool();
    const after = tool({
      input_schema: { type: 'object', properties: { limit: { type: 'number' }, all: { type: 'boolean' } } },
    });
    return Promise.all([mcpToolOpSegment(before), mcpToolOpSegment(after)])
      .then(([a, b]) => expect(a).not.toBe(b));
  });

  it('an UNCHANGED tool keeps its op id — a re-mint must not orphan grants', async () => {
    // The permitting half. An id that changed on every mint would re-ask
    // forever and train the owner to approve blind, which is the same failure
    // as never asking.
    expect(await mcpToolOpSegment(tool())).toBe(await mcpToolOpSegment(tool()));
  });

  it('a changed DESCRIPTION does not move the op id', async () => {
    // Display copy is out of the preimage on purpose: re-asking because a
    // server fixed a typo trains owners to click through.
    expect(await mcpToolOpSegment(tool()))
      .toBe(await mcpToolOpSegment(tool({ description: 'Lists the projects.' })));
  });

  it('⛔ a flipped destructive_hint does not move the op id', async () => {
    // The server's self-report must not be able to force OR avoid a re-ask.
    expect(await mcpToolOpSegment(tool()))
      .toBe(await mcpToolOpSegment(tool({ destructive_hint: true })));
  });

  it('an absent input_schema is a STABLE identity, not an undefined one', async () => {
    const bare: McpToolDescriptor = { name: 'ping' };
    expect(await mcpToolOpSegment(bare)).toBe(await mcpToolOpSegment({ name: 'ping' }));
    // …and distinct from the same tool that declares an empty object schema.
    expect(await mcpToolOpSegment(bare))
      .not.toBe(await mcpToolOpSegment({ name: 'ping', input_schema: {} }));
  });

  it('the op id does NOT depend on which other tools exist', async () => {
    // 🔑 The reason the derivation takes a descriptor and never the set. If
    // collisions were resolved by scanning siblings, adding an unrelated tool
    // could renumber this one and silently move its grant to a different tool.
    const alone = await generate([tool()]);
    const crowded = await generate([tool(), { name: 'project.create' }, { name: 'aaa' }]);
    const idIn = (c: { operations: { op: string; bind: unknown }[] }) =>
      c.operations.find((o) => (o.bind as { tool: string }).tool === 'project.list')!.op;
    expect(idIn(crowded as never)).toBe(idIn(alone as never));
  });

  it('two tools whose names REDUCE to the same label still get different ids', async () => {
    // `project.list` and `project/list` both reduce to `project_list`. Without
    // the hash suffix they would share one op id — one grant covering two
    // tools, one of which the owner never saw.
    const a = await mcpToolOpSegment({ name: 'project.list' });
    const b = await mcpToolOpSegment({ name: 'project/list' });
    expect(a).not.toBe(b);
    expect(a.startsWith('project_list_')).toBe(true);
    expect(b.startsWith('project_list_')).toBe(true);
  });

  it('the pack slug is stable per connection and differs across connections', async () => {
    expect(await mcpGeneratedPackSlug(CONNECTION)).toBe(await mcpGeneratedPackSlug(CONNECTION));
    expect(await mcpGeneratedPackSlug(CONNECTION))
      .not.toBe(await mcpGeneratedPackSlug({ kind: 'mcp', name: 'other_peer' }));
  });

  it('the descriptor hash is the full digest, not the truncated id', async () => {
    expect(await mcpToolDescriptorHash(tool())).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('D-225 Slice 2 — the generated composition', () => {
  it('names arbitrary tool names into legal op segments', async () => {
    const composition = await generate([
      { name: 'github/create-issue' },
      { name: 'createIssue' },
      { name: 'x' },
      { name: '___' },
      { name: 'a'.repeat(200) },
    ]);
    // Every op must parse as an operation-remainder segment, or the op id it
    // forms is unaddressable and no grant can ever name it.
    const OP_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/;
    for (const op of (composition as { operations: { op: string }[] }).operations) {
      expect(OP_SEGMENT_RE.test(op.op), `op '${op.op}' is not a legal segment`).toBe(true);
    }
  });

  it('puts the REAL tool name on the binding, never the derived op id', async () => {
    const composition = await generate([{ name: 'github/create-issue' }]);
    const row = (composition as unknown as { operations: { op: string; bind: { tool: string } }[] }).operations[0]!;
    expect(row.bind.tool).toBe('github/create-issue');
    expect(row.op).not.toBe('github/create-issue');
  });

  it('⚠ tiers EVERY generated op conservatively, whatever the server claims', async () => {
    // A wrong `read` here auto-grants a third party's write tool at enrollment
    // and is unrecoverable; a wrong `write` is a prompt the owner can relax.
    const composition = await generate([
      tool(),
      tool({ name: 'safe_read', destructive_hint: false }),
    ]);
    for (const row of (composition as { operations: { risk: string; approval: string }[] }).operations) {
      expect(row.risk).toBe('write');
      expect(row.approval).toBe('ask');
    }
  });

  it('is deterministic — same tools, same composition, regardless of list order', async () => {
    // A server that shuffles its array between probes must not make a no-op
    // re-mint look like a change.
    const a = await generate([tool(), { name: 'aaa' }, { name: 'zzz' }]);
    const b = await generate([{ name: 'zzz' }, tool(), { name: 'aaa' }]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('⛔ REFUSES to mint when two tools derive one op id', async () => {
    // Same tool listed twice with identical descriptors — one grant would cover
    // two operations. Refusing is the only safe resolution.
    await expect(generate([tool(), tool()])).rejects.toThrow(/two tools derive the operation id/);
  });

  it('lowers through the REAL decomposer to a validated mcp catalog', async () => {
    // 🔑 Gate 7 — a generated pack is validated, not exempted. This drives the
    // production lowering and the production validator, so the claim is not a
    // hand-built manifest agreeing with itself.
    const composition = await generate([tool(), { name: 'project.create' }]);
    const result = validateComposition(composition as never);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.valid).toBe(true);

    const decomposed = decomposeComposition[1]!(composition as never);
    const catalog = decomposed.catalog as IngredientManifest;
    expect(catalog).toBeDefined();
    expect(catalog.surfaces?.api?.transport).toBe('mcp');
    expect(catalog.surfaces?.api?.default_base_url).toBe('');
    // Every op is write-tier, so no group may auto-grant at enrollment.
    for (const group of Object.values(catalog.operation_groups ?? {})) {
      expect(group.grant_default).toBe('off');
    }
  });

  it('⛔ a ONE-TOOL server still lowers to a catalog with a real op id', async () => {
    // The 1x1 collapse would produce a plain wrapper ingredient: no operations
    // map, no op id, nothing a contract grant can name. A server publishing a
    // single tool is ordinary, so this is not an edge case — it is half the
    // reason `force_catalog_lowering` exists.
    const composition = await generate([tool()]);
    const decomposed = decomposeComposition[1]!(composition as never);
    expect(decomposed.ingredient).toBeUndefined();
    expect(decomposed.catalog).toBeDefined();
    const stamped = stampGeneratedMcpCatalog(decomposed.catalog as IngredientManifest);
    expect(Object.keys(stamped.operations ?? {})).toHaveLength(1);
    const opId = Object.values(stamped.operations ?? {})[0]!.operation_id!;
    expect(parseOpId(opId)?.tier).toBe('pack');
  });

  it('a generated pack is never marketplace-eligible', async () => {
    // Forcing the catalog branch must not have been bought by flipping
    // `catalog_kind`, which would also publish it.
    const composition = await generate([tool()]);
    const catalog = decomposeComposition[1]!(composition as never).catalog as IngredientManifest;
    expect(catalog.catalog_kind).toBe('private_byo');
    expect(catalog.marketplace_eligible).toBe(false);
  });

  it('⛔ the STAMP is what applies the publisher — decompose alone claims FIRST-PARTY', async () => {
    // The hole this closes: `decomposeComposition` stamps `DEFAULT_AUTHOR`,
    // which is `recued-core`. A generated pack installed straight from
    // decompose would satisfy `publisherMayDeclare` and hold every reserved
    // capability — on a declaration minted from a third party's tools/list.
    const composition = await generate([tool()]);
    const raw = decomposeComposition[1]!(composition as never).catalog as IngredientManifest;
    expect(raw.author).toBe(FIRST_PARTY_PUBLISHER);
    expect(publisherMayDeclare(raw.author, 'pre_install')).toBe(true);

    const stamped = stampGeneratedMcpCatalog(raw);
    expect(stamped.author).toBe(GENERATED_PACK_PUBLISHER);
    expect(publisherMayDeclare(stamped.author, 'pre_install')).toBe(false);
    expect(isKernelManifest(stamped)).toBe(false);
  });

  it('the stamp rewrites operation ids into the DOTTED Tier-P form a grant binds to', async () => {
    // The decomposer emits the legacy `<author>/<pack>.<op>` slash form, which
    // `parseOpId` does not accept — so an unstamped op could never be named by
    // a contract grant.
    const composition = await generate([tool()]);
    const stamped = stampGeneratedMcpCatalog(
      decomposeComposition[1]!(composition as never).catalog as IngredientManifest,
    );
    for (const [key, spec] of Object.entries(stamped.operations ?? {})) {
      expect(spec.operation_id).toBe(`${GENERATED_PACK_PUBLISHER}.${stamped.slug}.${key}`);
      expect(parseOpId(spec.operation_id!)).not.toBeNull();
      expect(parseOpId(spec.operation_id!)?.tier).toBe('pack');
    }
  });

  it('the stamped catalog still passes the manifest validator', async () => {
    // 🔑 Gate 7 end to end: generated → decomposed → stamped → VALIDATED. And
    // the validation is not vacuous, because the stamped author is neither
    // `recued` (which bypasses) nor absent.
    const composition = await generate([tool(), { name: 'project.create' }]);
    const stamped = stampGeneratedMcpCatalog(
      decomposeComposition[1]!(composition as never).catalog as IngredientManifest,
    );
    expect(isKernelManifest(stamped)).toBe(false);
    expect(validateIngredient(stamped).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('🔑 a RE-MINT cannot silently widen the catalog', async () => {
    // D-225 open question 1's second half, answered by the identity design
    // rather than by new policy. Re-probing a server that has CHANGED must not
    // quietly hand an existing grant more reach than it was issued for.
    //
    // Every op id is a pure function of its own descriptor, so:
    //   - a tool ADDED    → an id nobody has granted
    //   - a tool MUTATED  → an id nobody has granted (its old id is gone)
    //   - a tool REMOVED  → its id disappears; any grant row goes inert
    // The only ids that SURVIVE a re-mint are those whose descriptor is
    // byte-identical, which is exactly the set a prior grant was issued against.
    const before = await generate([
      tool(),
      { name: 'project.create', input_schema: { type: 'object' } },
      { name: 'legacy_thing' },
    ]);
    const after = await generate([
      tool(),                                                              // unchanged
      { name: 'project.create', input_schema: { type: 'object', required: ['name'] } }, // MUTATED
      { name: 'brand_new' },                                               // ADDED
      // `legacy_thing` REMOVED
    ]);
    const ids = (c: unknown) =>
      new Set((c as { operations: { op: string }[] }).operations.map((o) => o.op));
    const b = ids(before);
    const a = ids(after);

    const survived = [...a].filter((id) => b.has(id));
    // Exactly one op id survives — the untouched tool.
    expect(survived).toHaveLength(1);
    expect(survived[0]!.startsWith('project_list_')).toBe(true);

    // Everything else in the new catalog is an id no prior grant can name.
    const fresh = [...a].filter((id) => !b.has(id));
    expect(fresh).toHaveLength(2);
    // And the mutated tool's OLD id is gone, so its old grant reaches nothing.
    const staleMutated = [...b].filter((id) => id.startsWith('project_create_') && !a.has(id));
    expect(staleMutated).toHaveLength(1);
  });
});
