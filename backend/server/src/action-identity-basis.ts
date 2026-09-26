/** D-177 P1b — the basis an action's identity is hashed from: the manifest's
 *  defaults merged under the step's input, resolved against the run's stores,
 *  then shaped exactly as dispatch shapes what the adapter RECEIVES.
 *
 *  ⛔ The last step is the point (integrity audit, 2026-09-24). Since D-306,
 *  dispatch drops a kernel manifest's placeholder nulls that the step did not
 *  supply, while this basis kept them. So "omitted" and "explicitly null" hashed
 *  alike and ran differently. A seller pass's `period_end` is the case: omitted
 *  means the package's length, `null` means permanent. One approval or grant
 *  admitted both. The same function, in the same order, as `dispatch.ts`.
 *
 *  Provider slots (ai, http, mcp, dom, connection) keep the placeholders: dispatch
 *  keeps them there too, and a pre-approval checks each provider call's input
 *  against the hash of the one the owner reviewed. */

import type { IngredientManifest } from '@recued/contracts';
import {
  mergeManifestStepInput,
  resolveDispatchSlot,
  withoutManifestPlaceholders,
} from '@recued/ingredients';

export const actionIdentityBasis = (
  manifest: IngredientManifest,
  input: Record<string, unknown>,
  resolve: (merged: Record<string, unknown>) => Record<string, unknown>,
  opts: { readonly surfaceDispatch: boolean },
): Record<string, unknown> => {
  const merged = mergeManifestStepInput(manifest.input, input, {
    trustedSurfaceDispatch: opts.surfaceDispatch,
  });
  const resolved = resolve(merged);
  return resolveDispatchSlot(manifest) === 'kernel'
    ? withoutManifestPlaceholders(resolved, manifest.input, input)
    : resolved;
};
