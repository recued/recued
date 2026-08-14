/** D-225 Slice 2 — mint a pack composition from an MCP server's `tools/list`.
 *
 *  Enrolling an MCP connection generates a declaration instead of leaving its
 *  tools reachable only through the raw `connection-mcp-*` escape hatch. The
 *  output is an ORDINARY `CompositionIngredient`: it lowers through the same
 *  `decomposeComposition` every authored pack uses, is validated by the same
 *  `validateIngredient`, and its operations become ordinary contract-grantable
 *  op ids. Nothing here is a parallel path.
 *
 *  🔑 **Generating a COMPOSITION rather than a manifest is the design.** The
 *  lowering, the surface derivation and every publish-time gate then apply for
 *  free, and "a generated pack is validated, not exempted" (D-225 gate 7) is
 *  true by construction rather than by a check someone remembers to run.
 */

import {
  BULK_PACK_INSTALL_PERMISSION,
  GENERATED_PACK_PUBLISHER,
  RAW_OP_TOOL_PREFIX,
  type CompositionIngredient,
  type IngredientManifest,
  type McpPackReviewRow,
  type McpToolDescriptor,
  type OperationSpec,
  type OperationApproval,
  type OperationRiskTier,
  type PackOperationRow,
} from '@recued/contracts';

import { canonicalHash } from './canonical-hash.js';

/** How much of a hash rides in an id. 8 hex = 32 bits. These are not secrets
 *  and not adversarially collision-resistant on their own — they disambiguate
 *  ids within ONE server's tool list, where a collision needs two tools on the
 *  same server whose full descriptor hashes share a 32-bit prefix. The full
 *  digest is retained on the operation so a future tightening has it. */
const ID_HASH_LEN = 8;

/** ⛔ The DESCRIPTOR HASH — the identity a grant is really issued against.
 *
 *  D-225 § 7: three of four `tools/list` changes are already safe because a
 *  grant binds to an op-id STRING — a tool added or renamed has no grant row and
 *  is denied; a removed tool's row goes inert. The fourth is not: a tool
 *  MUTATED in place (same name, different `inputSchema`) keeps its name, so a
 *  grant issued for the old shape would keep applying to the new one.
 *
 *  ⇒ Hash `{ name, inputSchema }` and let the result ride the op id (see
 *  `mcpToolOpSegment`). A mutated tool then gets a DIFFERENT op id, has no
 *  grant row, and is denied at the next call — through the existing
 *  `isOpGranted` path, with **no drift detector and no new grant vocabulary**.
 *  Exactly D-177's trick of pinning a session grant to `recipe_hash`.
 *
 *  ⚠ On the seller path this is a pricing rule as much as a safety one: the
 *  catalog is the product, so a tool that changed shape must re-enter consent
 *  rather than keep billing against a grant issued for something else.
 *
 *  `description` is deliberately OUT of the preimage: it is display copy, and
 *  re-asking for consent because a server fixed a typo would train owners to
 *  approve without reading — which costs more safety than the churn buys.
 *
 *  ⛔ `destructive_hint` is out for a stronger reason. It is the SERVER's claim
 *  about itself, so it is not evidence and must never move a tier or an
 *  identity. A server could otherwise flip it to force a re-ask, or leave it
 *  flipped to avoid one. Nothing here reads it; `GENERATED_RISK` below explains
 *  why nothing should.
 *
 *  An ABSENT `input_schema` hashes as an explicit `null`, so "declares no
 *  arguments" is one stable identity rather than an undefined one. */
export const mcpToolDescriptorHash = async (
  descriptor: McpToolDescriptor,
): Promise<string> => canonicalHash({
  name: descriptor.name,
  input_schema: descriptor.input_schema ?? null,
});

/** The readable half of an op segment: the tool name, reduced to the alphabet
 *  `OP_SEGMENT_RE` admits (`[a-z0-9][a-z0-9_-]*[a-z0-9]`).
 *
 *  Lossy ON PURPOSE — it is a label, not an identity. `mcpToolOpSegment` always
 *  appends the descriptor hash, so two tool names that reduce to the same label
 *  still get different op ids. Nothing downstream may reverse this. */
const readableLabel = (name: string): string => {
  const reduced = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 48)
    // A trailing separator can reappear after the length clamp.
    .replace(/[^a-z0-9]+$/, '');
  return reduced.length === 0 ? 'tool' : reduced;
};

/** The pack-local op id for one tool: `<readable-label>_<descriptor-hash-8>`.
 *
 *  🔑 **Three problems, one derivation.**
 *
 *  1. **A tool name is not an op segment.** Names are arbitrary
 *     (`github/create-issue`, `createIssue`, `x`); op segments are
 *     `OP_SEGMENT_RE` and at least two characters. So a name must be mapped,
 *     and mapping is lossy.
 *  2. **Lossy mapping collides**, and a collision would put two tools on one op
 *     id — one grant admitting a call the owner never saw. Resolving collisions
 *     by scanning the tool SET would be worse: the id would depend on which
 *     other tools exist, so adding a tool could renumber another one and move
 *     its grant silently. ⇒ The derivation is a pure function of the DESCRIPTOR
 *     ALONE, never of the set.
 *  3. **A mutated tool must re-ask** (§ 7). Making the hash part of the id gets
 *     this for free.
 *
 *  The hash is appended ALWAYS, not only when the label is lossy. A conditional
 *  suffix would leave one adversarial hole — a server publishing a tool named
 *  exactly `<label>_<hash>` matching another tool's derived id — and, more
 *  importantly, it would make a tool's op id change shape when an unrelated
 *  property of its name changed. Uniform is cheaper to reason about than clever.
 *
 *  ⚠ This is the answer to D-225 open question 3 ("does the descriptor hash need
 *  a new grant-entry shape, or can it ride the op id?"). It rides the op id,
 *  because decision 3 of the spec is "no new authorization vocabulary" and a new
 *  `GRANT_ENTRY_KINDS` member is exactly that. The cost is accepted and real:
 *  op ids carry an opaque suffix in `#contracts`, and re-approving after a
 *  schema change is a new row rather than an edit. */
export const mcpToolOpSegment = async (
  descriptor: McpToolDescriptor,
): Promise<string> => {
  const hash = await mcpToolDescriptorHash(descriptor);
  return `${readableLabel(descriptor.name)}_${hash.slice(0, ID_HASH_LEN)}`;
};

/** The generated pack's slug, derived from the connection it was minted for.
 *
 *  Stable across re-mints of the SAME connection — re-probing a server must
 *  produce the same pack, or every existing grant would be orphaned by a
 *  refresh. Derived rather than named so an untrusted connection name cannot
 *  choose the slug (the `records-<hash>` precedent, same reasoning). */
export const mcpGeneratedPackSlug = async (
  connection: { kind: string; name: string },
): Promise<string> => `mcp-${(await canonicalHash(connection)).slice(0, 32)}`;

/** Everything the generator needs. `connection` identifies the enrolled record;
 *  `descriptors` is the `tools/list` snapshot it was probed from. */
export interface McpPackGenerationInput {
  connection: { kind: string; name: string };
  descriptors: readonly McpToolDescriptor[];
  /** Display name for the generated pack. Falls back to the connection name. */
  display_name?: string;
}

/** The composition-local ingredient slug every generated operation joins to. */
const INGREDIENT_SLUG = 'mcp';

/** ⚠ Conservative by construction. Every generated op is `write` + `ask`.
 *
 *  ⛔ `McpToolDescriptor.destructive_hint` is the one field that looks like it
 *  should decide this, and it is precisely the one that must not. It is the
 *  SERVER's claim about its own tool — the party a risk tier exists to
 *  constrain. A server wanting its write tool auto-granted need only omit it.
 *  D-137 reached the same conclusion for the chat catalog and said so in the
 *  field's own doc comment ("the hint is informational only; Mary always
 *  confirms"); the difference is that a generated pack has no Mary in the loop
 *  at mint time, so the conservative tier IS the confirmation.
 *
 *  There is no version of "ask the tool whether it is dangerous" that carries
 *  assurance. A check built on the hint would be assurance-SHAPED with none,
 *  which is worse than none because it reads as a control. Same reasoning as
 *  D-225 Slice 1's deliberately-absent `validateApiBindingRiskConsistency` arm.
 *
 *  This is not timidity — it is the only tier the evidence supports, and the
 *  consequences are load-bearing:
 *    - `write` means the decomposer derives `grant_default: 'off'` for every
 *      group (`maxRisk === 'read' ? 'on_after_connect' : 'off'`), so a generated
 *      pack auto-grants NOTHING at enrollment.
 *    - `ask` means each op is held for approval until the owner decides.
 *  A wrong `read` here would be silent and unrecoverable — it would auto-grant a
 *  third party's write tool at enrollment. A wrong `write` is merely a prompt
 *  the owner can relax. The asymmetry chooses. */
const GENERATED_RISK = 'write' as const;
const GENERATED_APPROVAL = 'ask' as const;

/** Machine-readable reason a generated op holds, for the D-211 approval-reason
 *  vocabulary (lowercase snake_case, 3-64 chars). */
const GENERATED_APPROVAL_REASON = 'mcp_tool_unverified_tier';

/** Mint the composition. Pure + deterministic: same descriptors ⇒ same
 *  composition, byte for byte, so a re-mint that changes nothing changes
 *  nothing.
 *
 *  Operations are emitted in DESCRIPTOR-HASH order rather than `tools/list`
 *  order, so a server that shuffles its array between probes does not reshuffle
 *  the composition and make a no-op re-mint look like a change.
 *
 *  ⛔ Throws on a duplicate op id. Two descriptors deriving one id means either
 *  a 32-bit hash-prefix collision or the same tool listed twice; both are
 *  states where a grant could admit a call the owner did not see, so neither
 *  may be resolved silently. */
export const generateMcpPackComposition = async (
  input: McpPackGenerationInput,
): Promise<CompositionIngredient> => {
  const withIds = await Promise.all(input.descriptors.map(async (descriptor) => ({
    descriptor,
    op: await mcpToolOpSegment(descriptor),
    hash: await mcpToolDescriptorHash(descriptor),
  })));
  withIds.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  const seen = new Set<string>();
  const operations: PackOperationRow[] = withIds.map(({ descriptor, op }) => {
    if (seen.has(op)) {
      throw new Error(
        `mcp pack generation: two tools derive the operation id '${op}' `
        + `(latest: ${JSON.stringify(descriptor.name)}). Refusing to mint a pack where one `
        + 'grant would cover two tools.',
      );
    }
    seen.add(op);
    const row: PackOperationRow = {
      op,
      ingredient: INGREDIENT_SLUG,
      risk: GENERATED_RISK,
      approval: GENERATED_APPROVAL,
      approval_reason: GENERATED_APPROVAL_REASON,
      // ⚠ The tool NAME lives here and nowhere else that dispatches. The op id
      // above is a derived label; this is the string that goes on the wire.
      bind: { kind: 'mcp', tool: descriptor.name },
    };
    if (descriptor.description !== undefined) row.description = descriptor.description;
    if (descriptor.input_schema !== undefined) {
      (row.bind as Record<string, unknown>).arguments_schema = descriptor.input_schema;
    }
    return row;
  });

  return {
    schema_version: 1,
    slug: await mcpGeneratedPackSlug(input.connection),
    force_catalog_lowering: true,
    // ⛔ Always, including for a one-tool server. Without it a single-tool
    // `tools/list` collapses to a plain wrapper with no op id, and the tool
    // becomes unreachable by any contract grant — the exact opposite of what
    // generating a declaration is for.
    ingredients: [
      // ⛔⛔ `.name`, NOT `.kind`. This bound the catalog to a connection
      // literally called 'mcp' (the KIND) instead of the enrolled connection it
      // was minted for, so no `connection_catalog_binding` row ever named the
      // real connection. Everything downstream then failed closed and looked
      // like an authorization problem: the profile reconciler had no target, the
      // pack grants could not be recorded (the grant scope REQUIRES a
      // connection_name), and the D-165 gateway denied every op —
      // `no_connection_profile` when the recipe named the connection,
      // `operation_not_granted` when it did not. § 234.4p.16d.
      { slug: INGREDIENT_SLUG, kind: 'connection', connection: { connection: input.connection.name } },
    ],
    operations,
  } as unknown as CompositionIngredient;
  // ⚠ No `name` / `description` here: `CompositionIngredient` HAS no such
  // fields (the decomposer derives the catalog's name from the slug). They
  // belong on the pack manifest, which is the surface the owner reads.
  /* c8 ignore next */
};

/** The publisher a generated pack is stamped with. Re-exported so a caller
 *  minting one cannot reach for `KERNEL_AUTHOR` out of habit — see the ⛔ note
 *  on `GENERATED_PACK_PUBLISHER`. */
export { GENERATED_PACK_PUBLISHER };

/** Stamp verified pack provenance onto a decomposed manifest.
 *
 *  `decomposeComposition` cannot know the marketplace-authoritative pack
 *  publisher, so its portable output uses `recued-core`. Install callers that
 *  do know the verified owner must replace both the author and every grant
 *  identity. Keying the dotted id by `<publisher>.<pack>.<operation>` prevents
 *  two publishers shipping the same public pack slug from sharing grants.
 *  Plain 1x1 bodies have no operations; they still receive the correct author.
 */
export const stampPackOwnedManifest = (
  manifest: IngredientManifest,
  owner: { publisher: string; pack_slug: string },
): IngredientManifest => {
  const operations = Object.fromEntries(
    Object.entries(manifest.operations ?? {}).map(([key, spec]) => [
      key,
      { ...spec, operation_id: `${owner.publisher}.${owner.pack_slug}.${key}` },
    ]),
  );
  return { ...manifest, author: owner.publisher, operations };
};

/** Stamp the generated publisher onto the decomposed catalog.
 *
 *  ⛔ **Without this the publisher decision is INERT.**
 *  `decomposeComposition` stamps every catalog with its `DEFAULT_AUTHOR`, which
 *  is `recued-core` — the FIRST-PARTY publisher. So a generated pack that went
 *  straight from decompose to install carries a first-party author on its
 *  catalog and legacy slash-form op ids.
 *
 *  ⚠ **Corrected 2026-07-31 — an earlier version of this comment claimed
 *  `publisherMayDeclare` would then hand the pack every reserved capability
 *  (`pre_install`, `connection_requirements`). That is WRONG, and it propagated
 *  into the spec and a commit message before being checked.**
 *  `publisherMayDeclare` reads the PACK MANIFEST's `publisher` field
 *  (`bulk-pack.ts` — `publisherMayDeclare(obj.publisher, …)`), which
 *  `mcpPackManifest` always sets to `recued-local`. The catalog's `author`
 *  never fed it. The reserved-capability path was never open.
 *
 *  The real consequence is narrower and still worth the stamp: `opGrantEntry`
 *  returns the `operation_id` verbatim, so a slash-form id makes
 *  `isGeneratedPackOpEntry` (prefix `recued-local.`) miss — and § 9.6's
 *  owner-default-only treatment silently does not apply, leaving generated ops
 *  on the permissive WILDCARD-DOOR default that § 9.6 exists to close. Bounded
 *  by every generated op being `write` + `ask`, so a wildcard door still meets
 *  the approval gate: a defence-in-depth layer was inert, not a silent exposure.
 *
 *  Defining `GENERATED_PACK_PUBLISHER` does not by itself put it anywhere. This
 *  is the call site that does, and it is the reason the constant is not merely
 *  documentation.
 *
 *  The `operation_id` rewrite is not cosmetic either: the decomposer emits the
 *  legacy `<author>/<pack>.<op>` slash form, while a Tier-P op id — the string a
 *  contract grant actually binds to — is dotted `<publisher>.<pack>.<op>`
 *  (`parseOpId`). `stampRecordsCatalog` does the same restamp for the same
 *  reason. */
export const stampGeneratedMcpCatalog = (
  catalog: IngredientManifest,
): IngredientManifest => stampPackOwnedManifest(catalog, {
  publisher: GENERATED_PACK_PUBLISHER,
  pack_slug: catalog.slug,
});

// ────────────────────────────────────────────────────────────────
// D-225 Slice 2b — the enrollment review chain
// ────────────────────────────────────────────────────────────────

/** Project a `tools/list` snapshot into the owner's review rows.
 *
 *  🔑 **Seed the SUGGESTION, never the DEFAULT.** This is the whole point of
 *  the shape above, and it is the one place this flow could quietly go wrong.
 *
 *  If a `readOnlyHint: true` seeded the row's STORED value at
 *  `read` / `never`, then an owner who clicks Save without reading would have
 *  handed a third-party server auto-run permission — and the server set that
 *  policy itself, with one boolean. Every gate we rely on is bypassed, because
 *  the owner nominally chose it: `confirm_risk_downgrade` never fires, and
 *  `isApprovalBelowRiskFloor` never fires either.
 *
 *  ⇒ `stored` is `write` / `ask` on every row, unconditionally. The hint
 *  renders as an attributed badge next to a suggestion the owner must actually
 *  click. **Save-without-reading holds everything**, which is the correct
 *  outcome for "I did not look."
 *
 *  This is D-137's rule for the chat catalog, applied verbatim: the upstream
 *  hint *"may seed the default at classification time, but Mary always confirms
 *  before the tool becomes visible."* The confirming is the part that cannot be
 *  skipped, so it is the part that is not automated here.
 *
 *  ⚠ A `destructive` hint suggests nothing. It can only propose a tier ABOVE
 *  the floor, and the owner raising a tier is not a decision that needs a
 *  shortcut — the badge alone tells them. Only the RELAXING direction gets a
 *  suggestion, and only because that is the direction with real ergonomic cost. */
export const mcpPackReviewRows = async (
  descriptors: readonly McpToolDescriptor[],
): Promise<McpPackReviewRow[]> => {
  const rows = await Promise.all(descriptors.map(async (d) => {
    const row: McpPackReviewRow = {
      op: await mcpToolOpSegment(d),
      tool: d.name,
      stored: { risk: GENERATED_RISK, approval: GENERATED_APPROVAL },
    };
    if (d.description !== undefined) row.description = d.description;
    const says: { read_only?: boolean; destructive?: boolean } = {};
    if (d.read_only_hint !== undefined) says.read_only = d.read_only_hint;
    if (d.destructive_hint !== undefined) says.destructive = d.destructive_hint;
    if (Object.keys(says).length > 0) row.server_says = says;
    // A read-only CLAIM, not corroborated by a destructive claim, is worth
    // offering as one click. It is still only an offer.
    if (d.read_only_hint === true && d.destructive_hint !== true) {
      row.suggested = { risk: 'read', approval: 'never' };
    }
    return row;
  }));
  return rows.sort((a, b) => (a.op < b.op ? -1 : a.op > b.op ? 1 : 0));
};

/** What changed on the server since the pack was minted. */
export interface McpToolsDrift {
  /** Tools whose descriptor hash is new — added OR mutated in place. Both are
   *  "an op id nobody has granted", so they are one category to the substrate;
   *  the UI can split them by tool name if it wants to. */
  added: string[];
  /** Descriptor hashes the pack declares that the server no longer publishes —
   *  removed OR the pre-mutation shape of a changed tool. */
  removed: string[];
}

/** Compare the descriptor hashes a pack was minted from against a fresh probe.
 *
 *  ⛔ **Keyed on HASHES, not names, and that is the whole reason this exists.**
 *  A name-based comparison sees tools appear and disappear but is BLIND to a
 *  tool mutated in place — same name, new `input_schema` — which is precisely
 *  the case the descriptor hash was introduced for (D-225 § 7). Undetected, the
 *  installed pack keeps declaring the old schema under the old op id and keeps
 *  dispatching against a grant the owner issued for a tool that no longer has
 *  that shape.
 *
 *  With no auto-update, this is the ONLY thing standing between the owner and
 *  silent staleness — so it is not an optimisation. Empty on both sides means
 *  the pack is current. */
export const mcpToolsDrift = async (
  mintedHashes: readonly string[],
  current: readonly McpToolDescriptor[],
): Promise<McpToolsDrift> =>
  mcpToolsDriftFromHashes(
    mintedHashes,
    await Promise.all(current.map((d) => mcpToolDescriptorHash(d))),
  );

/** The same comparison when BOTH sides are already hashes.
 *
 *  🔑 This is what a drift BADGE runs on, and the reason it exists separately:
 *  a badge must be computable with NO probe. The current side is
 *  `ConnectionHealth.tool_hashes`, persisted at the last probe; the minted side
 *  derives from the installed pack's own bindings. Both are at rest, so the
 *  connections list can render a badge without touching the network — and a
 *  badge that cost a live probe per row would either not exist or be wrong. */
export const mcpToolsDriftFromHashes = (
  mintedHashes: readonly string[],
  currentHashes: readonly string[],
): McpToolsDrift => {
  const before = new Set(mintedHashes);
  const now = new Set(currentHashes);
  return {
    added: [...now].filter((h) => !before.has(h)).sort(),
    removed: [...before].filter((h) => !now.has(h)).sort(),
  };
};

/** The descriptor hashes a mint was taken from — persisted with the connection
 *  so `mcpToolsDrift` has something to compare against. */
export const mcpMintedHashes = async (
  descriptors: readonly McpToolDescriptor[],
): Promise<string[]> =>
  (await Promise.all(descriptors.map((d) => mcpToolDescriptorHash(d)))).sort();

/** Wrap the generated composition into the installable pack manifest
 *  `handlePacksInstall` accepts. Version is pinned to 1: a generated pack is a
 *  pure derivation, so "the same tools" is always the same pack, and a bumping
 *  version would make every re-mint look like an upgrade to a surface that
 *  reasons about versions. */
export const mcpPackManifest = async (
  input: McpPackGenerationInput,
): Promise<Record<string, unknown>> => {
  const composition = await generateMcpPackComposition(input);
  return {
    manifest_version: 2,
    slug: composition.slug,
    publisher: GENERATED_PACK_PUBLISHER,
    name: input.display_name ?? input.connection.name,
    description:
      `Generated from the '${input.connection.name}' MCP connection's tools/list. `
      + 'Recued vouches that this declaration was read faithfully from the server — '
      + 'not for what the tools do.',
    version: 1,
    // Pack-level install permission. `BULK_PACK_INSTALL_PERMISSION` is mandatory
    // on every pack — it is what the install itself is authorized by, not a
    // capability the pack requests, so a generated pack carries it like any
    // other. ⚠ Both this and `requires` being present at all were caught by
    // running the REAL parser: the first draft omitted the field and the second
    // shipped it empty, and each produced a manifest the install pipeline
    // refused. Nothing short of that pipeline would have said so.
    requires: [BULK_PACK_INSTALL_PERMISSION],
    recipes: [],
    tags: ['mcp', 'generated'],
    contents: [{ type: 'composition', composition }],
  };
};

/** The descriptor hashes an INSTALLED generated pack was minted from.
 *
 *  🔑 Derived from the pack's own bindings rather than stored separately. The
 *  binding already carries `tool` (the name) and `arguments_schema` (the
 *  `input_schema`) — which is exactly the descriptor-hash preimage — so the
 *  pack IS the record of what was minted. A second copy in the connection row
 *  could disagree with the pack it claims to describe, and the disagreement
 *  would be invisible: drift would be computed against a snapshot no installed
 *  operation corresponds to.
 *
 *  ⇒ One record, and it is the artifact itself. Pair with
 *  `ConnectionHealth.tool_hashes` (the CURRENT probe) to get drift. */
export const mcpMintedHashesFromCatalog = async (
  catalog: IngredientManifest,
): Promise<string[]> => {
  const executes = catalog.surfaces?.api?.executes ?? {};
  const descriptors: McpToolDescriptor[] = [];
  for (const binding of Object.values(executes)) {
    if (binding.kind !== 'mcp') continue;
    const d: McpToolDescriptor = { name: binding.tool };
    if (binding.arguments_schema !== undefined) d.input_schema = binding.arguments_schema;
    descriptors.push(d);
  }
  return mcpMintedHashes(descriptors);
};

/** D-228 slice 3 — the UPSTREAM TOOL NAMES an installed catalog already
 *  dispatches, so a second surface offering the same tools can stand down.
 *
 *  🔑 **NAMES, NOT HASHES, AND THE DIFFERENCE IS THE POINT.** Its sibling above
 *  answers *"has this pack gone stale"*, which is a question about SHAPE — so it
 *  hashes `{name, input_schema}` and a tool mutated in place reads as drift.
 *  This answers *"is this tool reachable as a governed pack op"*, which is a
 *  question about REACHABILITY, and reachability is by name: `bind.tool` is the
 *  string that goes on the wire. A tool whose schema changed is still dispatched
 *  by the same op — staler than the owner thinks, which the drift badge is what
 *  reports, but not UNREACHABLE. Keying this on hashes would resurrect a
 *  duplicate Tier-3 entry for every drifted tool, which is the two-faces defect
 *  coming back through the door built to close it.
 *
 *  ⚠ SYNC, deliberately. Its only consumer is the chat catalog builder, which is
 *  synchronous and runs per turn; an async coverage lookup there would need a
 *  cache, and a cache is a second copy of the inventory that can disagree with
 *  the catalog it claims to describe.
 *
 *  ⚠ Not generated-pack-specific. Any composition catalog bound to an mcp
 *  connection dispatches its tools through the same `bind.tool`, so an ordinary
 *  marketplace pack covering a tool counts too — and should, for the same
 *  reason. */
export const mcpToolNamesFromCatalog = (
  catalog: IngredientManifest,
): Set<string> => new Set(mcpToolOperationsFromCatalog(catalog).keys());

/** D-228 slice 4 — the same walk, keeping the OPERATION each tool is dispatched
 *  through rather than only its name.
 *
 *  🔑 **THE TIER HAS TO COME FROM SOMEWHERE ONCE `tool_overrides` IS GONE.** The
 *  `connection-mcp-read` / `-write` kernel slugs must carry a TRUE tier — a
 *  read-tier dispatch of a write tool is a spoof past the preflight — and until
 *  now the truth came from a per-tool value the owner typed into a side store.
 *  The pack op IS that truth: it declares a `risk_tier`, and the owner's ruling
 *  can lower it through the gated editor. So the caller resolves the risk the
 *  same way the DOOR does, off the same rows.
 *
 *  ⚠ Returns the operation KEY, and the SPEC beside it. The key is what indexes
 *  `manifest.operations`; the spec carries the qualified `operation_id` an owner
 *  ruling is keyed on. Handing back only one of them is how a caller ends up
 *  reading a ruling row that nothing wrote. */
export const mcpToolOperationsFromCatalog = (
  catalog: IngredientManifest,
): Map<string, { operation: string; spec: OperationSpec }> => {
  const out = new Map<string, { operation: string; spec: OperationSpec }>();
  const operations = catalog.operations ?? {};
  for (const [operation, binding] of Object.entries(catalog.surfaces?.api?.executes ?? {})) {
    if (binding.kind !== 'mcp') continue;
    if (typeof binding.tool !== 'string' || binding.tool === '') continue;
    const spec = operations[operation];
    if (spec === undefined) continue;
    // ⛔ FIRST WINS. Two operations binding one tool would make the tool's tier
    // ambiguous, and picking the looser one silently is how a write becomes a
    // read. A generated pack cannot produce this (one op per descriptor, and
    // duplicate op ids THROW at mint), so it can only arrive from a hand-authored
    // pack — where refusing to answer twice is the conservative reading.
    if (out.has(binding.tool)) continue;
    out.set(binding.tool, { operation, spec });
  }
  return out;
};

/** Which enrolled connection minted this generated pack?
 *
 *  🔑 **Recomputes the derivation instead of storing a mapping.** The pack slug
 *  is `mcp-<hash({kind, name})>` — one-way, so there is no reading it backwards.
 *  The alternative to scanning is recording connection→pack somewhere, and a
 *  second record can disagree with the derivation it claims to describe: the
 *  pack would say it belongs to a connection whose slug no longer hashes to it,
 *  and nothing would notice. Here the mapping IS the function, so it cannot
 *  drift from itself.
 *
 *  O(connections) with one hash each — a user has a handful of MCP connections,
 *  and this runs on teardown, not on a hot path.
 *
 *  Returns null when no enrolled connection derives the slug, which is the
 *  ordinary case for every pack that is not a generated MCP one. */
export const mcpConnectionForPackSlug = async (
  pack_slug: string,
  connections: readonly { kind: string; name: string }[],
): Promise<{ kind: string; name: string } | null> => {
  for (const connection of connections) {
    const slug = await mcpGeneratedPackSlug({ kind: connection.kind, name: connection.name });
    if (slug === pack_slug) return { kind: connection.kind, name: connection.name };
  }
  return null;
};

/** True when a pack slug has the generated-MCP shape.
 *
 *  ⚠ A cheap PRE-FILTER, never the authority. It says "worth checking", and
 *  `mcpConnectionForPackSlug` says whether it is actually one — a third party
 *  cannot publish under `recued-local` (reserved), but a slug is just a string
 *  and nothing should act on its shape alone. */
export const looksLikeGeneratedMcpPackSlug = (slug: string): boolean =>
  /^mcp-[a-f0-9]{32}$/.test(slug);

/** The trailing `_<descriptor-hash-8>` every generated op segment carries
 *  (`mcpToolOpSegment`). Anchored at the END so a label that itself contains an
 *  8-hex run is not mis-split. */
const OP_SEGMENT_HASH_SUFFIX_RE = new RegExp(`^(.+)_[a-f0-9]{${String(ID_HASH_LEN)}}$`);

/** Read a peer's tool name as a REFLECTION of some other server's tool, and
 *  return the label of that upstream tool.
 *
 *  A generated pack's ops reach a peer's wire as
 *  `recued_op_recued-local.mcp-<32hex>.<label>_<8hex>`, where `<label>` is
 *  `readableLabel(<the upstream tool's own name>)`. So a name of that exact
 *  shape says "this tool of mine is really someone else's, relayed" — and the
 *  label is the only part of the upstream identity that survives the trip.
 *
 *  `undefined` for every tool a peer owns itself, including its native
 *  `recued_*` verbs and its ordinary marketplace pack ops. */
const reflectedUpstreamLabel = (toolName: string): string | undefined => {
  if (!toolName.startsWith(RAW_OP_TOOL_PREFIX)) return undefined;
  const segments = toolName.slice(RAW_OP_TOOL_PREFIX.length).split('.');
  if (segments.length !== 3) return undefined;
  const [publisher, pack, operation] = segments as [string, string, string];
  if (publisher !== GENERATED_PACK_PUBLISHER) return undefined;
  if (!looksLikeGeneratedMcpPackSlug(pack)) return undefined;
  return OP_SEGMENT_HASH_SUFFIX_RE.exec(operation)?.[1];
};

/** What a loopback subtraction kept and what it removed. `dropped` is not
 *  bookkeeping — an auto-mint reports it, so an owner who wonders where a tool
 *  went reads "we were looking at ourselves" rather than nothing. */
export interface McpReflectionSubtraction {
  kept: McpToolDescriptor[];
  dropped: McpToolDescriptor[];
}

/** ⛔⛔ D-225 auto-mint — SUBTRACT THE TOOLS THIS SERVER IS SEEING REFLECTED
 *  BACK AT ITSELF, before anything is minted from them.
 *
 *  **The situation.** Recued server A enrols Recued server B as an mcp
 *  connection. B has already enrolled A. So B's `tools/list` is
 *  `{B's own tools} ∪ {A's tools, relayed through B's generated pack}` — and a
 *  naive mint pulls A's OWN tools back into A's pack as ops that call B to call
 *  A. Owner, naming it: *"recued-a: recued-b tools {b.tools, b.mcp.a.tools}, so
 *  it creates a loopback duplicated tools if b didn't set it right."*
 *
 *  **The subtraction is EXACT, not a name heuristic.** `exposedToolNames` is what
 *  WE expose to THAT peer — derived from the contract it presents when it calls
 *  us (`MCP_PEER_CONTRACT_CONFIG_KEY` on the connection). A reflection of one of
 *  those is the only thing removed:
 *
 *      drop D  ⟺  D is shaped like a relayed generated-pack op
 *                 AND its upstream label is `readableLabel(N)` for some N we expose
 *
 *  ⚠ **BOTH terms are load-bearing, and the second alone is WRONG.** A peer's own
 *  native `recued_listRecipes` has the SAME NAME as ours — subtracting on the
 *  bare name would delete the peer's legitimate tool and leave the reflection
 *  (which is named nothing like it) in place. Exactly backwards.
 *
 *  ⚠ A NAME FILTER (`recued_op_recued-local.mcp-*` alone — the first term
 *  without the second) was considered and rejected: it cannot tell OUR
 *  reflection from the peer's legitimate relay of a THIRD server, and would
 *  silently strip every tool a Recued peer honestly re-offers.
 *
 *  🔑 **DEGRADES CORRECTLY.** An ordinary third-party MCP server carries no
 *  `peer_contract_id`, so `exposedToolNames` is empty, so nothing is subtracted
 *  and everything mints. The filter only ever fires where a relationship exists
 *  to reflect through.
 *
 *  ⚠ It matches on the LABEL, not the descriptor hash, and that direction is
 *  chosen. The hash would need our own advertised `input_schema` for each tool
 *  to be byte-identical to what the peer probed; a schema that has changed since
 *  would silently stop matching and mint the loopback — a false negative that
 *  fails OPEN. The label survives that drift. Its cost is the opposite error: a
 *  third server's tool whose label collides with one of ours, relayed by this
 *  peer, is dropped — an absent op the owner can re-mint, which fails CLOSED and
 *  is visible in `dropped`.
 *
 *  ⛔ **CALL IT BEFORE `mcpPackManifest`, never after.** Minting first and hiding
 *  later would put the reflected op id into the composition, into the inventory
 *  and into the grant surface, where a row can outlive the hiding. */
export const subtractReflectedMcpTools = (
  descriptors: readonly McpToolDescriptor[],
  exposedToolNames: readonly string[],
): McpReflectionSubtraction => {
  const exposedLabels = new Set(exposedToolNames.map(readableLabel));
  const kept: McpToolDescriptor[] = [];
  const dropped: McpToolDescriptor[] = [];
  for (const descriptor of descriptors) {
    const upstream = reflectedUpstreamLabel(descriptor.name);
    if (upstream !== undefined && exposedLabels.has(upstream)) dropped.push(descriptor);
    else kept.push(descriptor);
  }
  return { kept, dropped };
};
