/** D-247 slice 1 — the `recipe` grant kind, its fence, and the one inverted
 *  author default.
 *
 *  ⛔ THE FENCE AND THE CLASSIFIER ARE ONE CHANGE, WHICH IS WHY THEY ARE ONE
 *  TEST FILE. `recipe.` joining `RESERVED_GRANT_ENTRY_PREFIXES` is what stops
 *  `opGrantEntry` minting a key the widened `classifyGrantEntry` reads back as a
 *  recipe grant. Either half alone is a bug; only the pair is correct. */
import { describe, expect, it } from 'vitest';
import {
  GRANT_ENTRY_KINDS,
  RECIPE_GRANT_PREFIX,
  RESERVED_GRANT_ENTRY_PREFIXES,
  DECLARED_OPERATION_ID_RESERVED_PREFIXES,
  classifyGrantEntry,
  parseGrantEntry,
  recipeGrantEntry,
  isRecipeGrantEntry,
  opGrantEntry,
  collectionGrantEntry,
  topicGrantEntry,
  peerLabelGrantEntry,
  declaredOperationIdReservedPrefix,
  ownerOnlyAdjustedAuthorDefault,
  OWNER_CONTRACT_ID,
} from '../index.js';

describe('D-247 slice 1 — the kind', () => {
  it('adds `recipe` and leaves the four existing kinds untouched, in order', () => {
    // Ratchet: the four are load-bearing for every stored row written before
    // D-247. A reorder or rename is a silent re-point of live authorizations.
    expect([...GRANT_ENTRY_KINDS]).toEqual([
      'op', 'collection', 'topic', 'peer_label', 'recipe',
    ]);
  });

  it('round-trips format → classify → parse', () => {
    const key = recipeGrantEntry('recued-core', 'overdue-invoice-chase');
    expect(key).toBe('recipe.recued-core/overdue-invoice-chase');
    expect(classifyGrantEntry(key)).toBe('recipe');
    expect(parseGrantEntry(key)).toEqual({
      kind: 'recipe',
      value: 'recued-core/overdue-invoice-chase',
    });
    expect(isRecipeGrantEntry(key)).toBe(true);
  });

  it('does not disturb how the other four classify', () => {
    expect(classifyGrantEntry(collectionGrantEntry('mail' as never))).toBe('collection');
    expect(classifyGrantEntry(topicGrantEntry('mail.summary' as never))).toBe('topic');
    expect(classifyGrantEntry(peerLabelGrantEntry('ask-me'))).toBe('peer_label');
    expect(classifyGrantEntry('core.mail.send')).toBe('op');
    expect(classifyGrantEntry('recued-core.fleet.quote')).toBe('op');
    expect(classifyGrantEntry('acme/invoice.send')).toBe('op');
    expect(isRecipeGrantEntry('core.mail.send')).toBe(false);
  });
});

describe('D-247 slice 1 — the fence', () => {
  it('`recipe.` is a RESERVED grant-entry prefix', () => {
    expect(RESERVED_GRANT_ENTRY_PREFIXES).toContain(RECIPE_GRANT_PREFIX);
  });

  it('opGrantEntry FAILS LOUD on a `recipe.`-leading operation id', () => {
    // Without this the op key would classify as a recipe grant — an op grant
    // silently answering a different question at the gate.
    expect(() => opGrantEntry('recipe.x')).toThrow(/grant_entry_op_id_reserved_prefix/);
    expect(() => opGrantEntry('recipe.evil/pack.op')).toThrow(/reserved grant-entry prefix/);
  });

  it('a downloaded catalog cannot DECLARE a `recipe.*` operation id', () => {
    expect(DECLARED_OPERATION_ID_RESERVED_PREFIXES).toContain(RECIPE_GRANT_PREFIX);
    expect(declaredOperationIdReservedPrefix('recipe.thing.do')).toBe(RECIPE_GRANT_PREFIX);
  });

  it('the genuine op namespaces stay mintable', () => {
    // The fence must not catch `core.*` / `primitive.*` / `ingredient.*` / pack ids.
    expect(opGrantEntry('core.mail.send')).toBe('core.mail.send');
    expect(opGrantEntry('primitive.recall_search')).toBe('primitive.recall_search');
    expect(opGrantEntry('ingredient.mail-send_ab12cd34')).toBe('ingredient.mail-send_ab12cd34');
    expect(opGrantEntry('recued-core.fleet.quote')).toBe('recued-core.fleet.quote');
  });
});

describe('D-247 slice 1 — D7, the one inverted author default', () => {
  const RECIPE = recipeGrantEntry('recued-core', 'refund-payment-square');

  it('resolves FALSE for the OWNER — the inversion, and the whole point', () => {
    // Every other kind is owner-permissive. This one is not: catalog membership
    // for ~2,264 recipes is a token budget, not a trust question.
    expect(ownerOnlyAdjustedAuthorDefault(RECIPE, OWNER_CONTRACT_ID, true)).toBe(false);
  });

  it('resolves FALSE for a contract-free dispatch and for a bound door', () => {
    expect(ownerOnlyAdjustedAuthorDefault(RECIPE, '', true)).toBe(false);
    expect(ownerOnlyAdjustedAuthorDefault(RECIPE, 'door-abc', true)).toBe(false);
  });

  it('ignores the caller-supplied normalDefault entirely', () => {
    expect(ownerOnlyAdjustedAuthorDefault(RECIPE, OWNER_CONTRACT_ID, false)).toBe(false);
    expect(ownerOnlyAdjustedAuthorDefault(RECIPE, 'door-abc', false)).toBe(false);
  });

  it('leaves the owner-default-only TIGHTEN untouched for non-recipe entries', () => {
    // Guard against folding the recipe rule into `isOwnerDefaultOnlyEntry`,
    // which is relied on to be a tighten that never closes for the owner.
    expect(ownerOnlyAdjustedAuthorDefault('data.webhook', OWNER_CONTRACT_ID, true)).toBe(true);
    expect(ownerOnlyAdjustedAuthorDefault('data.webhook', 'door-abc', true)).toBe(false);
    expect(ownerOnlyAdjustedAuthorDefault('core.mail.send', 'door-abc', true)).toBe(true);
  });
});
