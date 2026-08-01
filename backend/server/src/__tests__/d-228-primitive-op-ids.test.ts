/** D-228 slice 5 — every Tier-1 chat primitive has an op id, minted from the
 *  handler table so the set cannot drift.
 *
 *  ⚠ IDENTITY ONLY. Nothing consults these yet, deliberately — the same shape
 *  slice 1b used for `ingredient.<slug>`. Tier-1 primitives are the always-on
 *  tools, so a default-deny bug here dark-boots the assistant; minting is
 *  reversible while nothing reads it, wiring is not. */

import { describe, expect, it } from 'vitest';
import {
  PRIMITIVE_GRANT_PREFIX,
  classifyGrantEntry,
  opGrantEntry,
  primitiveGrantEntry,
} from '@recued/contracts';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';

/** ⛔ DERIVED FROM THE TABLE, never hand-listed. A hand-maintained copy of a
 *  growing set is the defect slice 2 removed one layer down — the kernel
 *  whitelist that was one element and the whole policy. */
const primitives = (): string[] => Object.keys(buildChatTier1Handlers({} as never));

describe('every primitive gets a grant-legal op id', () => {
  it('mints one per handler in the table', () => {
    const names = primitives();
    expect(names.length).toBeGreaterThan(8);
    for (const name of names) {
      const opId = primitiveGrantEntry(name);
      expect(opId).toBe(`${PRIMITIVE_GRANT_PREFIX}${name}`);
      // Accepted verbatim as an op entry, and classified as one.
      expect(opGrantEntry(opId)).toBe(opId);
      expect(classifyGrantEntry(opId)).toBe('op');
    }
  });

  /** ⛔⛔ THE COLLISION THAT FORCED A NAMESPACE. `enrichment.search` is a live
   *  Tier-1 tool whose bare name starts with the reserved TOPIC prefix, so
   *  `opGrantEntry` throws on it. Ten of eleven primitives would have been fine
   *  bare; this is the one that makes bare names unusable, and special-casing it
   *  is how a vocabulary starts growing exceptions. */
  it('rescues enrichment.search, whose BARE name is refused', () => {
    expect(() => opGrantEntry('enrichment.search')).toThrow(/reserved_prefix/);
    const opId = primitiveGrantEntry('enrichment.search');
    expect(opGrantEntry(opId)).toBe(opId);
    expect(classifyGrantEntry(opId)).toBe('op');
  });

  /** ⚠ The set is derived, so a primitive added later is minted automatically.
   *  Pinned because the value of deriving is exactly that it cannot be forgotten. */
  it('covers the primitives that exist today', () => {
    const names = primitives();
    for (const expected of [
      'contact.search', 'mail.search', 'calendar.search', 'memory.search',
      'enrichment.search', 'recipe.run',
    ]) {
      expect(names, `${expected} must be in the table`).toContain(expected);
    }
  });
});

describe('what the namespace must NOT be', () => {
  /** ⛔ NOT `core.` — the obvious choice and the dangerous one. `core.*` is the
   *  kernel op namespace, where this codebase already documents the confusion:
   *  the Tier-1 `mail.search` is a fenced fan-out over every mailbox while
   *  `core.mail.email.search` is one mailbox by slug. A grant reviewer seeing
   *  `core.mail.search` could not tell which they were approving. */
  it('does not collide with the kernel op namespace', () => {
    const opId = primitiveGrantEntry('mail.search');
    expect(opId.startsWith('core.')).toBe(false);
    expect(opId).not.toBe('core.mail.search');
  });

  it('does not collide with the collection or topic prefixes', () => {
    for (const name of primitives()) {
      const opId = primitiveGrantEntry(name);
      expect(opId.startsWith('data.')).toBe(false);
      expect(opId.startsWith('enrichment.')).toBe(false);
    }
  });
});
