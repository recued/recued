/** D-137 W2.3 → D-228 slice 4 — THE TIER-3 CATALOG IS EMPTY, AND STAYS EMPTY.
 *
 *  This file used to enumerate the Tier-3 catalog: `<connection>.<tool>` entries
 *  projected from `tool_overrides`, the chat PRESENTATION store, gated on the
 *  owner having enabled and classified each tool. D-225 named that surface as
 *  the standing defect — one enrolled MCP tool reachable from chat twice,
 *  through two different gates — and slice 4 deleted the store it read.
 *
 *  ⛔ **WHAT REPLACED THOSE TESTS IS NOT NOTHING.** Deleting a suite whose
 *  subject is gone is correct; deleting it silently is how a producer gets
 *  re-added later and nobody notices that a second, weaker route to the same
 *  tools has reappeared. So the invariant is pinned instead: the registry
 *  projects ZERO tier-3 entries, and the tiers that DO exist are unaffected by
 *  its absence.
 *
 *  An MCP tool now reaches chat exactly once, as a contract-governed
 *  `recued_op_*` pack operation (`createChatRawOpSource`).
 */

import { describe, expect, it } from 'vitest';
import { createInternalToolRegistry } from '../internal-tool-registry/index.js';
import type { Tier1Handler } from '../internal-tool-registry/index.js';

const tier1: Record<string, Tier1Handler> = {
  'contact.search': async () => ({ ok: true, result: {} }),
};

describe('D-228 slice 4 — the Tier-3 catalog is retired', () => {
  it('⛔ projects ZERO tier-3 entries even with a source wired', () => {
    // The source seam survives (narrowing a shipped union is the change that
    // breaks a consumer nobody remembered), but nothing produces through it.
    const registry = createInternalToolRegistry({
      tier1Handlers: tier1,
      tier3Source: {
        listAnnotations: () => [
          // ⚠ D-228 slice 6 — the annotation no longer CARRIES a tool list, so
          // this source cannot describe a tier-3 entry even in a fixture. That
          // strengthens the claim below rather than weakening it: the projection
          // is empty because there is nothing left to project from.
          { connection_name: 'exa', topic_tags: [], updated_at: 1 },
        ] as never,
      },
    });

    expect(registry.listByTier(3)).toEqual([]);
  });

  it('⛔ resolves NO tier-3 name — the surface cannot be reached by memory either', () => {
    // A name a model saw on an earlier turn must not still resolve. The catalog
    // being empty and `getByName` refusing are two different claims.
    const registry = createInternalToolRegistry({ tier1Handlers: tier1 });

    expect(registry.getByName('exa.search')).toBeNull();
  });

  it('the tiers that still exist are unaffected', () => {
    // The permitting witness: "listByTier(3) is empty" would also pass for a
    // registry that projected nothing at all.
    const registry = createInternalToolRegistry({ tier1Handlers: tier1 });

    expect(registry.listByTier(1).map((e) => e.name)).toContain('contact.search');
    expect(registry.list().some((e) => e.tier === 3)).toBe(false);
  });
});
