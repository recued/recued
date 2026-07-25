/** D-192 make-live test helper — narrow a declaration's pin, with TEETH.
 *
 *  The D-192 authority ladder (ratified 2026-07-14) made `contract_source`
 *  OPTIONAL: a Source with no pinned document is legal and proves its ops
 *  EMPIRICALLY instead (a live smoke against a real connection — ladder §6).
 *  Every vendor in the make-live suites, however, IS pinned. So their
 *  pin-equality proofs must now ASSERT that they are, rather than assume it.
 *
 *  ⛔ Do NOT reach for `?.` to silence the possibly-undefined. This:
 *
 *      expect(decl.contract_source?.url).toBe(pin?.url);   // ❌
 *
 *  PASSES VACUOUSLY when both sides are undefined — so a declaration that lost
 *  its pin, or a pack whose pin stopped decomposing onto the catalog, would sail
 *  through its own pin-equality test GREEN. A silent-green pin check is exactly
 *  the failure mode the ladder exists to prevent, and it would be a poor irony to
 *  introduce it into the very tests that guard against it. Throw instead — an
 *  absent pin here is a bug in the pack, not a posture.
 *
 *  (The kernel HubSpot suite has narrowed this way since P2, because the kernel
 *  declaration type has carried an optional `contract_source` all along. This is
 *  that precedent, shared out now that the pack type has converged onto it.) */

import type {
  WorkEntitySourceContractSource,
  WorkEntitySourceDeclaration,
} from '@recued/contracts';

export const requirePin = (
  decl: Pick<WorkEntitySourceDeclaration, 'contract_source'>,
): WorkEntitySourceContractSource => {
  const cs = decl.contract_source;
  if (cs === undefined) {
    throw new Error(
      'This Source is PINNED by its pack, but its declaration carries no contract_source. '
      + 'The D-192 authority ladder made that field optional (an unpinned Source is legal and '
      + 'proves its ops empirically), so pin-equality must ASSERT the pin rather than assume '
      + 'it. See docs/d-192-authority-ladder.md §3.',
    );
  }
  return cs;
};
