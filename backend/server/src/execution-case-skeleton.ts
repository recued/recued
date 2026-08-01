/** D-219 — SKELETON MATCHING: a high-confidence retrieval signal.
 *
 *  ⛔ WHY ALIGNMENT AND NOT EXTRACTION. Deciding "which words in this prompt are
 *  values" is open-ended and measured unreliable — the prompt-cache NER, whose
 *  certainty gate is tuned so a false positive cannot poison a cache, extracted
 *  a name in 3 of 18 realistic sentences and never on both sides of a matching
 *  pair. But retrieval never has to answer that question in the open. It asks a
 *  PAIRWISE one: does this prompt match THIS stored one? Align the two and the
 *  differing span IS the slot. Extraction stops preceding the comparison and
 *  falls out of it, and alignment is deterministic — no model, no certainty
 *  gate, no per-language rules.
 *
 *  ⛔⛔ ALIGNMENT ALONE IS NOT SAFE, AND THE MEASUREMENT IS UNAMBIGUOUS. These
 *  two pairs are structurally identical — same length, one substitution:
 *
 *      send MARY an email    / send JOHN an email      same procedure
 *      DELETE the invoice    / SEND the invoice        emphatically not
 *
 *  Permitting any single substitution accepted **6 of 6** authored
 *  different-procedure pairs, including that one. Cheap deterministic proxies
 *  narrow it but do not close it: "both tokens are rare in the corpus" still
 *  accepted `email the INVOICE to acme` ~ `email the CONTRACT to acme`, and
 *  "not the first token" is an English-imperative assumption that "can you
 *  delete the invoice" walks straight through. ⇒ **A hole is permitted only
 *  where something POSITIVELY TYPES both sides as the same kind of value.**
 *  That predicate is injected rather than chosen here, because the sound
 *  sources differ in what they cost: the owner's contact index types the
 *  recipient case at no privacy cost, while the D-219 argument capture would
 *  type every parameter and is fenced behind acceptance #47.
 *
 *  ⚠ DELIBERATELY LOW RECALL. Over 30,876 real prompt pairs, 95% differ in
 *  shape entirely and only 0.376% are within two substitutions; not one of
 *  three authored rephrasings ("send mary an email" / "email mary") aligns at
 *  all. This cannot replace lexical relevance and is not meant to — it is the
 *  signal that says "you have done exactly this before", which lexical overlap
 *  cannot express at any threshold. Match few, be right.
 *
 *  ⚠ NOT A KEYING PRIMITIVE, on purpose. Using this to AGGREGATE cases would
 *  fix real fragmentation (measured: 14.1% of real turn messages have a
 *  near-twin that today becomes its own singleton case) — but a wrong retrieval
 *  costs one irrelevant card, while a wrong KEY merges two procedures' evidence
 *  permanently and re-keys the corpus. That is exactly what the F1 defect was.
 *  Keying needs a stricter rule than this one, not the same rule. */

/** The most substitutions a pair may differ by and still be one pattern. Two
 *  covers "different recipient, different date"; beyond that the requests are
 *  simply not the same request. */
export const SKELETON_MAX_HOLES = 2;

/** `inferredIntent`'s cap. A stored intent facet of exactly this many terms MAY
 *  have been truncated, and a truncated skeleton can match a prompt that
 *  continues differently — so those are refused rather than guessed at. */
const INTENT_TERM_CAP = 8;

export interface SkeletonAlignment {
  /** Aligned one-for-one differences, in order. */
  readonly holes: ReadonlyArray<readonly [string, string]>;
  /** Tokens present on one side only. Any at all disqualifies a match: the two
   *  requests are not the same shape, whatever else they share. */
  readonly shapeDrift: number;
}

/** Token-level LCS alignment. Pure, and deliberately not a similarity score —
 *  the caller needs to inspect WHICH positions differ, not how many. */
export const alignSkeleton = (
  left: readonly string[],
  right: readonly string[],
): SkeletonAlignment => {
  const n = left.length;
  const m = right.length;
  const lcs: number[][] = Array.from(
    { length: n + 1 },
    () => new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = left[i] === right[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const holes: Array<readonly [string, string]> = [];
  let i = 0;
  let j = 0;
  let drift = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    // A one-for-one substitution shows up in an LCS walk as both sides being
    // droppable at the same step. Anything else is a genuine insertion or
    // deletion, which changes the shape rather than filling a hole.
    if (
      lcs[i + 1]![j]! >= lcs[i]![j + 1]!
      && lcs[i + 1]![j + 1]! === lcs[i + 1]![j]!
    ) {
      holes.push([left[i]!, right[j]!]);
      i += 1;
      j += 1;
      continue;
    }
    drift += 1;
    if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return { holes, shapeDrift: drift + (n - i) + (m - j) };
};

/** Decides whether one aligned difference is a VALUE that may vary.
 *
 *  ⛔ Returning `true` unconditionally is not a permissive default, it is the
 *  measured-unsafe rule — it accepts `delete the invoice` ~ `send the invoice`.
 *  An implementation must positively type BOTH sides. */
export type SkeletonHolePredicate = (
  hole: readonly [string, string],
) => boolean;

export interface SkeletonMatchInput {
  /** The incoming prompt's canonical terms, in order. */
  readonly promptTerms: readonly string[];
  /** The stored case's canonical terms, in order. */
  readonly storedTerms: readonly string[];
  readonly isValueHole: SkeletonHolePredicate;
  /** Whether `storedTerms` is the WHOLE stored request.
   *
   *  ⛔ FALSE MEANS THE TEXT MAY BE A PREFIX, and a prefix aligns perfectly
   *  with a prompt that then goes somewhere else entirely — a confident WRONG
   *  answer, the worst failure for a signal whose value is confidence. The
   *  reachable source of a prefix is `request_shape.intent_facets[0]`, which is
   *  `inferredIntent`'s first EIGHT distinct terms; a caller with only that
   *  must pass false and gets a refusal at the cap.
   *
   *  ⚠ Binding to the truncated facet was measured and rejected: only 23% of
   *  real turn messages are under 8 distinct terms (median 9), so it would work
   *  exclusively on the briefest requests — the ones where a procedure is least
   *  worth short-circuiting. The stored prompt travels from the candidate scan
   *  instead, which already decrypts it. */
  readonly storedIsComplete: boolean;
}

/** True only for a pair that is the same request with typed values swapped.
 *
 *  ⚠ Fails closed in every uncertain direction: any shape drift, more than
 *  {@link SKELETON_MAX_HOLES} differences, an untyped hole, an empty side, or a
 *  possibly-truncated stored intent all return false. */
export const isSkeletonMatch = (input: SkeletonMatchInput): boolean => {
  const { promptTerms, storedTerms, isValueHole } = input;
  // ⚠ Belt-and-braces, and known to be: an empty side produces shape drift
  // equal to the other side's length, so the drift check below already refuses
  // it — verified by mutation (removing this line reddens nothing). Kept as a
  // statement of intent at the entry, not relied on.
  if (promptTerms.length === 0 || storedTerms.length === 0) return false;
  // ⛔ Only when the stored side may be a PREFIX. With the whole request in
  // hand there is nothing to truncate and no reason to refuse a long one — that
  // refusal would exclude 77% of real traffic for a hazard that does not apply.
  if (
    !input.storedIsComplete
    && (
      storedTerms.length >= INTENT_TERM_CAP
      || promptTerms.length >= INTENT_TERM_CAP
    )
  ) return false;
  const { holes, shapeDrift } = alignSkeleton(storedTerms, promptTerms);
  if (shapeDrift > 0) return false;
  if (holes.length > SKELETON_MAX_HOLES) return false;
  return holes.every((hole) => isValueHole(hole));
};
