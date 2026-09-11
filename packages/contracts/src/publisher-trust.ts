/** D-223 § 7.2 — the seam where "may this publisher declare X" is answered.
 *
 *  Today the answer is a slug comparison, and this file changes nothing about
 *  that. It exists because the comparison was written inline at three sites — the
 *  manifest validator twice and the pre-install planner once — which is a slug to
 *  chase rather than a rule to change. When a publisher-verification property
 *  lands, it lands here.
 *
 *  ⚠ THE CAPABILITY PARAMETER IS NOT DECORATION. D-223 § 7.2.1: the reserved
 *  capabilities fail differently, so they gate differently. Presenting a slimmer
 *  form is publisher trust and is exactly what verification can mean. Claiming a
 *  vendor identity is PER-VENDOR recognition — a verified "Acme Corp" is vouched
 *  for as a publisher, not authorized to represent Google. Reaching into a
 *  credential the owner enrolled for something else is the OWNER's call at
 *  install and is not earnable by anyone. A single boolean would quietly make
 *  verification the answer to all three, so the question is asked per capability
 *  even while every answer is currently the same. */

/** The handle Recued itself publishes under. */
export const FIRST_PARTY_PUBLISHER = 'recued-core';

/** Pack capabilities that are not open to every publisher. */
export type ReservedPackCapability =
  /** A core feature: installed by the server, never listed, not owner-manageable
   *  — the foundation-pack path. */
  | 'pre_install'
  /** Ship inside the release artifact. Fails differently from the others: it
   *  grants no authority at all, it decides what a distribution CARRIES. A
   *  third-party pack cannot put bytes in Recued's binary, which is a release
   *  decision rather than a trust one — and the reason it is asked here anyway
   *  is that the day publisher verification lands, "verified" must not silently
   *  answer this one too. */
  | 'bundled'
  /** Declare a connection descriptor: matching, vendor identity, OAuth issuer,
   *  dedup endpoint. NOT the same as declaring a connection HINT, which is open
   *  to every publisher and gated by value admission instead (D-223 § 0). */
  | 'connection_requirements';

/** May this publisher declare this capability?
 *
 *  Behaviour today: `publisher === 'recued-core'`, for every capability. The
 *  parameter is the extension point, not the current logic. */
export const publisherMayDeclare = (
  publisher: unknown,
  capability: ReservedPackCapability,
): boolean => {
  // Referenced so the parameter cannot be dropped as unused by a future edit —
  // losing it would collapse three questions into one, which is the mistake
  // § 7.2.1 exists to prevent.
  void capability;
  return publisher === FIRST_PARTY_PUBLISHER;
};

/** The refusal wording, shared so the validator and the planner cannot drift on
 *  what they tell an author. */
export const reservedCapabilityMessage = (
  capability: ReservedPackCapability,
  publisher: unknown,
): string =>
  `${capability} is reserved for the '${FIRST_PARTY_PUBLISHER}' publisher; `
  + `got ${JSON.stringify(publisher)}`;
