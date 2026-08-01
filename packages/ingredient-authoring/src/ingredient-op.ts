/** D-228 slice 1b — the op id for an INGREDIENT tool.
 *
 *  ⛔⛔ WHY THESE HAVE TO BE MINTED AT ALL. `allowed_tools` keys on raw
 *  ingredient SLUGS, and `GRANT_ENTRY_KINDS` is `['op','collection','topic']` —
 *  a slug cannot be named in a contract grant. The per-token checklist
 *  (Settings → MCP Tokens) is a TOKEN concept, not a contract one, so an
 *  ingredient tool is today governed by a vocabulary the contract cannot see.
 *  Measured: 159 kernel ingredient manifests, and not one declares
 *  `operations` — `operations` is a D-165 CATALOG concept (that is where
 *  `recued-core.rental-book.building.create` comes from). For an ordinary
 *  ingredient the ingredient IS the unit, so there is nothing to read an op id
 *  off and one has to be derived.
 *
 *  🔑 D-225's move, not a new vocabulary: give the tool an op id and let the
 *  EXISTING `isOpGranted` path govern it. The tool then stops being separately
 *  grantable — it is a projection of its op, and it appears iff that op is
 *  granted.
 *
 *  ⚠ SCOPE: this mints identities and settles the identity questions. It
 *  deliberately does NOT wire enumeration, grants or migration — the same shape
 *  D-225 slice 2 used ("PARTIAL by design. Builds the generator and settles the
 *  identity questions; deliberately does NOT wire enrollment"). Minting is
 *  reversible while nothing reads it; wiring it is not. */

import { canonicalHash } from './canonical-hash.js';

/** The namespace for an ingredient op: `ingredient.<label>_<hash8>`.
 *
 *  ⛔⛔ DO **NOT** ADD THIS TO `RESERVED_GRANT_ENTRY_PREFIXES` — an earlier
 *  revision of this comment said to, and it would have broken the feature it
 *  was describing. That list is the prefixes an op id must **NOT** start with
 *  (`data.` = collection, `enrichment.` = topic); it exists so
 *  `classifyGrantEntry` can treat "neither reserved prefix" as `op`, and
 *  `opGrantEntry` THROWS `grant_entry_op_id_reserved_prefix` on anything that
 *  leads with one. Reserving `ingredient.` would make every id minted here
 *  unusable as a grant entry.
 *
 *  🔑 Nothing needs reserving, and that is the point: `ingredient.<…>` leads
 *  with neither reserved prefix, so it classifies as `op` and rides the
 *  existing vocabulary with **no extension at all** — which is what "no new
 *  authorization vocabulary" is supposed to feel like. Pinned by
 *  `d-228-ingredient-op-id.test.ts`. */
export const INGREDIENT_OP_PREFIX = 'ingredient.';

/** How much of the hash rides in the id. 8 hex = 32 bits — the same budget
 *  `mcp-pack.ts` uses, for the same reason: these disambiguate ids within one
 *  installation, not against an adversary. The full digest is returned
 *  separately so a future tightening has it. */
const ID_HASH_LEN = 8;

/** The identity-bearing shape of an ingredient. */
export interface IngredientDescriptor {
  slug: string;
  /** The call surface — what a caller may pass. The analogue of an MCP tool's
   *  `input_schema`. */
  input?: unknown;
  /** The authored risk tier. IN the preimage; see the hash's doc for why this
   *  diverges from the MCP precedent. */
  risk_tier?: string;
}

/** ⛔ THE DESCRIPTOR HASH — the identity a grant is really issued against.
 *
 *  Three of four manifest changes are already safe because a grant binds to an
 *  op-id STRING: an ingredient added or renamed has no grant row and is denied;
 *  a removed one's row goes inert. The fourth is not — an ingredient MUTATED in
 *  place keeps its slug, so a grant issued for the old shape would keep
 *  applying to the new one. Hashing the call surface into the id means a
 *  mutated ingredient gets a DIFFERENT op id, has no grant row, and is denied
 *  at the next call, through the existing `isOpGranted` path with no drift
 *  detector and no new grant vocabulary. Exactly D-177's trick of pinning a
 *  session grant to `recipe_hash`.
 *
 *  ⚠ `name` / `description` / `tags` / `category` are OUT of the preimage, per
 *  the MCP precedent: they are display copy, and re-asking for consent because
 *  an author fixed a typo trains owners to approve without reading — which
 *  costs more safety than the churn buys.
 *
 *  ⚠ `version` is OUT for the same reason. A republish that changes neither the
 *  call surface nor the risk does not change the call CONTRACT, and forcing a
 *  re-ask on every version bump is the same click-through tax.
 *
 *  ⛔⛔ `risk_tier` is IN, and this DIVERGES from `mcpToolDescriptorHash`, which
 *  excludes `destructive_hint`. The divergence is deliberate and the reason is
 *  not cosmetic: `destructive_hint` is a REMOTE SERVER's runtime self-report
 *  that nothing reads (the generated pack always takes the conservative floor),
 *  so admitting it would let a third party flip a bit to force or dodge a
 *  re-ask. `risk_tier` is an AUTHORED field on an installed manifest that HAS
 *  passed publish review, and it IS read — it moves the approval floor. An
 *  ingredient silently going read → write while holding its grant is precisely
 *  the mutation this hash exists to catch, so it belongs in the identity.
 *
 *  An ABSENT `input` hashes as an explicit `null`, so "takes no arguments" is
 *  one stable identity rather than an undefined one. */
export const ingredientDescriptorHash = async (
  descriptor: IngredientDescriptor,
): Promise<string> => canonicalHash({
  slug: descriptor.slug,
  input: descriptor.input ?? null,
  risk_tier: descriptor.risk_tier ?? null,
});

/** The readable half of an op segment: the slug, reduced to the alphabet op
 *  segments admit (`[a-z0-9][a-z0-9_-]*[a-z0-9]`).
 *
 *  Lossy ON PURPOSE — it is a label, not an identity. `ingredientOpId` always
 *  appends the descriptor hash, so two slugs that reduce to the same label
 *  still get different op ids. Nothing downstream may reverse this. */
const readableLabel = (slug: string): string => {
  const reduced = slug
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 48)
    // A trailing separator can reappear after the length clamp.
    .replace(/[^a-z0-9]+$/, '');
  return reduced.length === 0 ? 'ingredient' : reduced;
};

/** The op id for one ingredient tool: `ingredient.<label>_<descriptor-hash-8>`.
 *
 *  ⚠ Returns the FULL digest beside the id. The id carries 32 bits for
 *  readability; a future tightening (or a collision audit) needs the whole
 *  thing, and recomputing it from a manifest that has since changed is exactly
 *  the operation that would be wrong. */
export const ingredientOpId = async (
  descriptor: IngredientDescriptor,
): Promise<{ op_id: string; descriptor_hash: string }> => {
  const descriptor_hash = await ingredientDescriptorHash(descriptor);
  const op_id = `${INGREDIENT_OP_PREFIX}${readableLabel(descriptor.slug)}`
    + `_${descriptor_hash.slice(0, ID_HASH_LEN)}`;
  return { op_id, descriptor_hash };
};
