/** source_mirror — the complete-walk delete diff (D-192 P1.5 extraction).
 *
 *  THE correctness home for absence-based delete detection, lifted from
 *  the D-190 generic CRM reconciler's S2 logic. The rule (D-190 S2,
 *  codex review fold — see also the
 *  `feedback_absence_is_not_deletion_without_completeness_proof`
 *  discipline):
 *
 *  Absence proves deletion ONLY on a walk with a POSITIVE completeness
 *  proof. GATE on `complete`, never on `!truncated` — a non-paginating
 *  catalog (a `search_style` without `pagination_style`) returns the
 *  FIRST page with `truncated:false`, so `!truncated` alone would treat
 *  a partial page as the full set and false-delete everything beyond
 *  it. `complete` is true only when the pagination follower PROVABLY
 *  ran to exhaustion (`pages_fetched` present on the gateway audit +
 *  not truncated). Not complete ⇒ return NO deletes (fail-closed; catch
 *  up next cycle). */

export interface CompleteWalkDeleteInput {
  /** The walk's positive completeness proof — pagination follower ran
   *  AND did not truncate. False/unknown ⇒ zero deletes, always. */
  complete: boolean;
  /** Prior mirror keys for the scope (ALL rows — may span sibling
   *  namespaces; see `keyPrefix`). */
  priorKeys: Iterable<string>;
  /** Every key the current walk saw — INCLUDING unchanged records (a
   *  hash-skipped record is still present remotely). */
  polledKeys: ReadonlySet<string>;
  /** Restrict the diff to prior keys under this prefix — the caller's
   *  namespace boundary (e.g. the CRM reconciler's
   *  `<vendor>_<entity>_<connection>_`, whose trailing delimiter must be
   *  unambiguous in the key alphabet). Omit when `priorKeys` is already
   *  scoped exactly. */
  keyPrefix?: string;
}

/** Keys present in the prior mirror but absent from a PROVABLY complete
 *  walk — the records to tombstone. Empty unless `complete`. */
export const computeCompleteWalkDeletes = (input: CompleteWalkDeleteInput): string[] => {
  if (!input.complete) return [];
  const deletes: string[] = [];
  for (const key of input.priorKeys) {
    if (input.keyPrefix !== undefined && !key.startsWith(input.keyPrefix)) continue;
    if (!input.polledKeys.has(key)) deletes.push(key);
  }
  return deletes;
};
