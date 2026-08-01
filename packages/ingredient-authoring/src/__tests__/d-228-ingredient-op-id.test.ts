/** D-228 slice 1b — an ingredient tool's op id, and the descriptor-hash
 *  discipline that makes a grant survive a rename but not a mutation. */

import { describe, expect, it } from 'vitest';

import { classifyGrantEntry, opGrantEntry } from '@recued/contracts';

import {
  INGREDIENT_OP_PREFIX,
  ingredientDescriptorHash,
  ingredientOpId,
} from '../ingredient-op.js';

const base = {
  slug: 'ai-classify',
  input: { 'llm.data': { type: 'string' }, 'llm.categories': { type: 'array' } },
  risk_tier: 'read',
};

describe('the op id', () => {
  it('is namespaced and carries the hash', async () => {
    const { op_id, descriptor_hash } = await ingredientOpId(base);
    expect(op_id.startsWith(INGREDIENT_OP_PREFIX)).toBe(true);
    expect(op_id).toBe(`ingredient.ai-classify_${descriptor_hash.slice(0, 8)}`);
    // The FULL digest comes back beside it — recomputing it later from a
    // manifest that has since changed is exactly the wrong operation.
    expect(descriptor_hash.length).toBeGreaterThan(8);
  });

  it('is stable across calls for the same descriptor', async () => {
    expect((await ingredientOpId(base)).op_id).toBe((await ingredientOpId(base)).op_id);
  });

  /** ⚠ The label is lossy on purpose, so the hash is what separates them. */
  it('separates two slugs that reduce to the same label', async () => {
    const a = await ingredientOpId({ ...base, slug: 'data/file.read' });
    const b = await ingredientOpId({ ...base, slug: 'data-file-read' });
    expect(a.op_id).not.toBe(b.op_id);
  });

  it('never emits an empty label', async () => {
    const { op_id } = await ingredientOpId({ ...base, slug: '///' });
    expect(op_id).toMatch(/^ingredient\.ingredient_[0-9a-f]{8}$/);
  });
});

describe('what MUST change the identity', () => {
  /** ⛔⛔ THE MUTATION THE HASH EXISTS FOR. A rename or an addition is already
   *  safe — no grant row, denied. An ingredient MUTATED IN PLACE keeps its slug,
   *  so without this a grant issued for the old call surface keeps applying. */
  it('a changed call surface changes the op id', async () => {
    const before = await ingredientOpId(base);
    const after = await ingredientOpId({
      ...base,
      input: { ...(base.input as object), 'llm.context': { type: 'string' } },
    });
    expect(after.op_id).not.toBe(before.op_id);
  });

  /** ⛔⛔ THE DIVERGENCE FROM THE MCP PRECEDENT, pinned so it is not "tidied"
   *  back into line. `mcpToolDescriptorHash` excludes `destructive_hint`
   *  because it is a REMOTE SERVER's runtime self-report that nothing reads —
   *  admitting it would let a third party flip a bit to force or dodge a
   *  re-ask. `risk_tier` is an AUTHORED field on an installed manifest that has
   *  passed publish review, and it IS read: it moves the approval floor. An
   *  ingredient going read → write while holding its grant is the mutation this
   *  hash is for. */
  it('a changed risk_tier changes the op id — read → write must re-ask', async () => {
    const read = await ingredientOpId({ ...base, risk_tier: 'read' });
    const write = await ingredientOpId({ ...base, risk_tier: 'write' });
    expect(write.op_id).not.toBe(read.op_id);
  });

  it('an absent input is ONE stable identity, not an undefined one', async () => {
    const a = await ingredientOpId({ slug: 'x-tool' });
    const b = await ingredientOpId({ slug: 'x-tool', input: undefined });
    expect(a.op_id).toBe(b.op_id);
    // …and distinct from an ingredient that takes an empty object.
    const empty = await ingredientOpId({ slug: 'x-tool', input: {} });
    expect(empty.op_id).not.toBe(a.op_id);
  });
});

describe('what must NOT change the identity', () => {
  /** ⚠ THE PERMITTING WITNESS, and the important half. Without these the hash
   *  is indistinguishable from "hash the whole manifest", which would re-ask on
   *  every typo fix and train owners to approve without reading — costing more
   *  safety than the churn buys. */
  it('display copy does not change the op id', async () => {
    const before = await ingredientOpId(base);
    const after = await ingredientOpId({
      ...base,
      // Fields deliberately absent from the preimage.
      ...({ name: 'AI Classifier v2', description: 'fixed a typo', tags: ['ai'], category: 'ai' } as object),
    });
    expect(after.op_id).toBe(before.op_id);
  });

  it('a version bump alone does not change the op id', async () => {
    const before = await ingredientOpId(base);
    const after = await ingredientOpId({ ...base, ...({ version: 9 } as object) });
    expect(after.op_id).toBe(before.op_id);
  });
});

describe('the hash itself', () => {
  it('is order-insensitive over the call surface', async () => {
    const a = await ingredientDescriptorHash({
      slug: 's', input: { b: 1, a: 2 }, risk_tier: 'read',
    });
    const b = await ingredientDescriptorHash({
      slug: 's', input: { a: 2, b: 1 }, risk_tier: 'read',
    });
    expect(a).toBe(b);
  });
});

describe('it rides the EXISTING grant vocabulary, unextended', () => {
  /** ⛔⛔ THE CHECK THAT CAUGHT A WRONG COMMENT. An earlier revision of
   *  `ingredient-op.ts` said `ingredient.` should be added to
   *  `RESERVED_GRANT_ENTRY_PREFIXES`. That list is the prefixes an op id must
   *  NOT start with — `opGrantEntry` THROWS on them — so reserving it would
   *  have made every id minted here unusable as a grant entry. */
  it('is accepted verbatim by opGrantEntry and classifies as `op`', async () => {
    const { op_id } = await ingredientOpId(base);
    expect(opGrantEntry(op_id)).toBe(op_id);
    // ⚠ Returns the kind DIRECTLY, not an object. My first probe read `.kind`
    // with a fallback, which printed the right answer for the wrong reason and
    // hid the shape.
    expect(classifyGrantEntry(op_id)).toBe('op');
  });

  /** The permitting witness for the reservation itself: the two prefixes that
   *  ARE reserved still throw, so the test above is not passing because
   *  `opGrantEntry` accepts everything. */
  it('…while a genuinely reserved prefix is still refused', () => {
    expect(() => opGrantEntry('data.mail')).toThrow(/reserved_prefix/);
    expect(() => opGrantEntry('enrichment.deal_health_score')).toThrow(/reserved_prefix/);
  });
});
