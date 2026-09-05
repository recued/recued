/** D-259 — `packs.unrunnable`: the DURABLE half of the boot pack finding.
 *
 *  ⛔⛔ WHAT THIS REPLACES, AND WHY A TEST FILE SAYS SO. The finding first
 *  shipped as a durable ASK, because `ask` is the only persisting delivery on
 *  the notification block. That put an error report into the owner's queue of
 *  pending DECISIONS: it accumulated across restarts (a dedup had to be
 *  written), needed a no-op answer consumer so a one-option dismissal could
 *  complete, and — the real defect — was CLEARED BY BEING ANSWERED while the
 *  packs were still broken.
 *
 *  🔑 The condition is re-derivable, so it does not need persisting at all.
 *  These assertions pin that: the rpc must recompute, never cache.
 */
import { describe, expect, it, vi } from 'vitest';

import { handlePacksUnrunnable } from '../pack-unrunnable-handler.js';
import type { IngredientManifest } from '@recued/contracts';

/** A REAL legacy shape (unsupervised `detached`), not synthetic garbage — the
 *  class this check exists for is a pack installed before the D-259 decoders
 *  were deleted. */
const legacyManifest = (slug: string): IngredientManifest => ({
  slug,
  version: 1,
  kind: 'cli',
  name: slug,
  description: 'legacy',
  publisher: 'test',
  operations: [{
    id: 'run',
    name: 'run',
    description: 'run',
    risk_tier: 'read',
    binding: { kind: 'cli', command: 'true', detached: true },
  }],
} as unknown as IngredientManifest);

describe('D-259 packs.unrunnable', () => {
  it('reports nothing when every installed manifest still validates', () => {
    const res = handlePacksUnrunnable({ listManifests: () => [] });
    expect(res.findings).toEqual([]);
    expect(res.exact_pack_identities).toBe(true);
  });

  /** ⛔ THE ANTI-CACHE ASSERTION. A stored finding is exactly what this design
   *  rejected; if the handler memoised, a pack repaired between calls would
   *  keep its badge forever and the owner would be told to fix what is fixed. */
  it('RE-DERIVES per call — a repaired pack stops being reported', () => {
    let manifests = [legacyManifest('codex-pack')];
    const listManifests = vi.fn(() => manifests);
    const deps = { listManifests };

    const before = handlePacksUnrunnable(deps);
    expect(before.findings.length).toBeGreaterThan(0);

    manifests = [];
    const after = handlePacksUnrunnable(deps);
    expect(after.findings).toEqual([]);
    // Proof it went back to the source rather than answering from memory.
    expect(listManifests).toHaveBeenCalledTimes(2);
  });

  /** ⚠ Without a contract store the catalog→pack join cannot be proved, so the
   *  finding is still REPORTED but the caller is told not to mint a detail
   *  link. Reporting nothing would hide a real problem; linking anyway would
   *  ship the dead link this arc keeps warning about. */
  it('reports findings without a store, but withholds link authority', () => {
    const res = handlePacksUnrunnable({
      listManifests: () => [legacyManifest('codex-pack')],
    });
    expect(res.findings.map((f) => f.slug)).toContain('codex-pack');
    expect(res.exact_pack_identities).toBe(false);
  });

  it('survives an unreadable manifest instead of hiding every other finding', () => {
    const res = handlePacksUnrunnable({
      listManifests: () => [
        null as unknown as IngredientManifest,
        legacyManifest('codex-pack'),
      ],
    });
    expect(res.findings.map((f) => f.slug)).toContain('codex-pack');
  });
});
