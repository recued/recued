/** What each step does to the owner's records — the server's half of "read
 *  fresh before a write" (engine `step-seed.ts`). One derivation, used by the
 *  recipe runner (`execute-handler.ts`) and by tests that compose the server's
 *  caches, so the two cannot drift.
 *
 *  Read from the manifests the server already holds:
 *  - a step whose ingredient is not read-tier WRITES — for a catalog, its own
 *    operation decides, since the catalog wrapper is read/data whatever it runs;
 *  - a step the engine cannot name before it runs (a templated ingredient or
 *    operation) counts as a write, so the reads around it stay fresh;
 *  - a read-tier `data` step backing a kernel op reads the OWNER'S OWN records;
 *  - everything else — transforms, AI, vendor reads — keeps its cache. */

import {
  isCatalogForm,
  kernelOpForBackingSlug,
  type IngredientManifest,
  type RecipeStep,
} from '@recued/contracts';
import type { StepEffect } from '@recued/engine';

export const createStepEffect = (
  manifestFor: (slug: string) => IngredientManifest | null | undefined,
): ((step: RecipeStep) => StepEffect) => (step) => {
  const slug = (step as { ingredient?: unknown }).ingredient;
  if (typeof slug !== 'string') return 'other';
  if (slug.includes('{{')) return 'write';
  const manifest = manifestFor(slug);
  if (manifest === null || manifest === undefined) return 'other';
  if (isCatalogForm(manifest)) {
    const input = (step as { input?: unknown }).input;
    const operation = input !== null && typeof input === 'object'
      ? (input as { operation?: unknown }).operation
      : undefined;
    if (typeof operation !== 'string' || operation.includes('{{')) return 'write';
    return manifest.operations?.[operation]?.risk_tier === 'read' ? 'other' : 'write';
  }
  if (manifest.risk_tier !== 'read') return 'write';
  return manifest.category === 'data' && kernelOpForBackingSlug(slug) !== undefined
    ? 'own_read'
    : 'other';
};
