/** Shared scoring core for the prompt-cache prefetch contact search.
 *
 *  The scoring that turns a set of candidate contact rows + a parsed query into
 *  ranked `PrefetchCandidate[]` lives here, PURE, decoupled from row sourcing — so
 *  the current whole-warehouse scan (`createContactPrefetchSearch`) and the
 *  prefetch-owned FTS&RAM index that will replace it
 *  (D-167 §1.A) run the EXACT
 *  same per-row scoring + tie behaviour, identical output at ≤ the scan cap.
 *
 *  Pure: no IO, no warehouse access. The caller supplies the candidate rows, the
 *  parsed query context, and a phone-uniqueness oracle (`isUnique`) so the
 *  page-local vs store-wide difference lives in the caller, not the scorer.
 */

import { phoneMatchDigits } from '@recued/transforms';
import { canonicalizeEmail } from '@recued/contracts';
import { isProseFunctionWord, selectWithPinned } from '@recued/middleware-prompt-cache';

import type { PrefetchCandidate } from '@recued/middleware-prompt-cache';

/** The lean contact projection the scorer reads — the four scored columns
 *  (`email` is the table PK so always present; the rest nullable → optional).
 *  Structurally compatible with the contact store's `PrefetchScanRow`. */
export interface PrefetchScoreRow {
  readonly email: string;
  readonly name?: string;
  readonly phone?: string;
  readonly company?: string;
}

/** Casefold + strip combining diacritics → the accent/casing-invariant key both
 *  the query tokens and the contact name/company tokens are matched on (the FUZZY
 *  surfacing normalisation, accent-INsensitive — distinct from `scanContent`'s
 *  exact accent-SENSITIVE aliasing). */
export const normalize = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

export const wordSet = (s: string): ReadonlySet<string> =>
  new Set(normalize(s).match(/[\p{L}\p{N}]+/gu) ?? []);

/** The parsed, normalised query the scorer consumes — built once by
 *  `buildQueryContext`, reused across every candidate row. */
export interface PrefetchQueryContext {
  /** Normalised content tokens, `≥ 2` code points (drops single-letter noise). */
  readonly queryTokens: ReadonlySet<string>;
  /** Phone-FORMATTED digit runs (`extractPhoneRuns`) — kept apart from bare
   *  tokens so a country-code-less national form matches ONLY a formatted phone. */
  readonly phoneRunSet: ReadonlySet<string>;
  /** Full email addresses (`extractEmailRuns`), canonicalised to the contact
   *  store's key form for an exact compare. */
  readonly emailRunSet: ReadonlySet<string>;
  /** True when there is nothing to match on (all three sets empty) → the caller
   *  should short-circuit to `[]` before any warehouse read. */
  readonly isEmpty: boolean;
}

/** Parse a prefetch query into the normalised context the scorer reuses. The scan
 *  (and the prefetch-owned index that will replace it) call this with the same
 *  `EntitySearchPort` query, so token / phone-run / email-run handling can't drift. */
export const buildQueryContext = (query: {
  readonly tokens: readonly string[];
  readonly phoneRuns?: readonly string[];
  readonly emailRuns?: readonly string[];
}): PrefetchQueryContext => {
  // `≥ 2` floor measured in CODE POINTS (`[...t]`), not UTF-16 units — so a single
  // astral char and a single BMP char are treated alike (matches the producer's
  // `decomposeToTokens`). Single-char CJK = deferred CJK work.
  const queryTokens = new Set(
    query.tokens.map(normalize).filter((t) => [...t].length >= 2),
  );
  // Digits need no accent/casing normalisation.
  const phoneRunSet = new Set(query.phoneRuns ?? []);
  // D-167 B1 — canonicalise to the SAME form the contact store keys on so an exact
  // compare resolves a contact by a typed email even when its name shares no token.
  const emailRunSet = new Set(
    (query.emailRuns ?? []).map((e) => canonicalizeEmail(e)).filter((e): e is string => !!e),
  );
  return {
    queryTokens,
    phoneRunSet,
    emailRunSet,
    isEmpty: queryTokens.size === 0 && phoneRunSet.size === 0 && emailRunSet.size === 0,
  };
};

/** The phone/identifier gating the scorer needs, supplied by the caller. */
export interface PrefetchScoreContext extends PrefetchQueryContext {
  /** Max candidates to return (pinned identifier matches survive past it). */
  readonly limit: number;
  /** The FUZZY (name/company) candidate set is COMPLETE — retrieval surfaced every
   *  contact that could fuzzy-match. Gates the §2 ambiguity fail-closed: when false
   *  (e.g. the FTS leg hit its cap, so an off-cap contender could be missed) EVERY
   *  fuzzy candidate is marked ambiguous. Independent of phone completeness — the
   *  index keeps phone-form uniqueness store-wide even when the fuzzy leg caps, so
   *  this must NOT gate the phone path (see `phoneFormsComplete`). */
  readonly fuzzyComplete: boolean;
  /** Phone-form uniqueness (`isUnique`) is trustworthy STORE-WIDE — a phone hit
   *  asserts ONE contact owns the number, unprovable off a truncated page. The
   *  D-167 §1.A index backs `isUnique` with `contact_phone_forms` (a store-wide
   *  `COUNT(DISTINCT contact)`), so the adapter passes `true` regardless of fuzzy
   *  truncation; a future caller with page-local uniqueness would pass `false` to
   *  suppress phone hits. */
  readonly phoneFormsComplete: boolean;
  /** True iff the phone form maps to exactly one contact STORE-WIDE — the index
   *  adapter backs this with `contact_phone_forms` (a `COUNT(DISTINCT contact)`).
   *  National/trunk forms can collide across countries; the FULL E.164 is unique by
   *  construction absent a duplicate row. */
  readonly isUnique: (digits: string) => boolean;
}

/** Score candidate rows against the query and select the ranked output.
 *
 *  Score = a contact's name tokens that appear in the prompt PLUS its company
 *  tokens that appear PLUS an exact phone/email identifier hit. Closed-class
 *  prose FUNCTION words (`isProseFunctionWord` — "me"/"the"/"it") contribute
 *  NOTHING as fuzzy evidence on either leg: prose mechanics must not resolve
 *  contacts that happen to bear them as names, while open-category name-words
 *  ("Bob"/"April"/"Gap") keep matching a deliberate mention. Multi-token name
 *  matches outrank an incidental single common-word hit; an exact identifier
 *  (+5, pinned) outranks any fuzzy overlap. `selectWithPinned` keeps every
 *  identifier (pinned) match past the top-K cap so its values always reach the
 *  alias ledger (D-167 B1); fuzzy matches stay capped at `limit`.
 *
 *  D-167 §2 ambiguity-gate (lives here so the FTS&RAM index that replaces the scan
 *  inherits it): after scoring, a FUZZY candidate is confident only if it is the
 *  SOLE fuzzy candidate matching each reference (query token) it hit; if 2+ fuzzy
 *  candidates share a matched token that reference is contested and all of them are
 *  flagged AMBIGUOUS, so the producer renders an "ask before acting" block instead
 *  of auto-resolving the wrong contact. Pinned identifier matches are definitive and
 *  bypass the contest. A TRUNCATED scan can't prove in-page sole-matcher uniqueness
 *  (a collision may sit off the cap), so it fails closed — every fuzzy candidate is
 *  ambiguous (the pinned email path stays definitive). The flag rides to the
 *  producer on `PrefetchCandidate.ambiguous`.
 *
 *  The `ref` is the canonical email, so a contact without one is skipped — a
 *  phone-only contact can't seed an email ref today (noted limitation; the phone
 *  still rides for ledger-aliasing when an email-bearing contact matches). */
export const scorePrefetchCandidates = (
  rows: readonly PrefetchScoreRow[],
  ctx: PrefetchScoreContext,
): PrefetchCandidate[] => {
  const { queryTokens, phoneRunSet, emailRunSet, limit, fuzzyComplete, phoneFormsComplete, isUnique } = ctx;
  const scored: Array<{
    readonly ref: string;
    readonly label: string;
    readonly score: number;
    readonly phone?: string;
    readonly company?: string;
    readonly pinned?: boolean;
    /** The normalised query tokens this candidate matched (name ∪ company) — the
     *  D-167 §2 ambiguity-gate groups fuzzy candidates by these to find, per
     *  reference, whether one dominates or several tie. */
    readonly matchedTokens: ReadonlySet<string>;
    /** Set by the §2 gate after scoring — a fuzzy candidate that ties for the top
     *  of a reference it matched (2+ contenders). Pinned matches stay unambiguous. */
    ambiguous?: boolean;
  }> = [];
  for (const rec of rows) {
    if (rec.email === undefined || rec.email.length === 0) continue;
    let score = 0;
    // `pinned` = resolved on an EXACT identifier (email / phone) the user typed —
    // `selectWithPinned` keeps it past the top-K cap (D-167 B1). Fuzzy never pins.
    let pinned = false;
    // The query tokens this candidate matched fuzzily (name + company), collected
    // for the §2 ambiguity contest below. A pinned (identifier) match needs none.
    const matched = new Set<string>();
    // A grammatically-closed prose FUNCTION word is not name evidence — "give
    // *me* their email" must not surface a contact named "Me" (the calendar
    // organizer display name every seeded warehouse derives). Function words
    // appear in prose by construction, so counting them lets everyday phrasing
    // confidently resolve unrelated contacts; the bench measured the cost (a
    // nameless second candidate beside the real one collapsed prefetch trust
    // to ~1/6 — the model re-verified instead of using the ref). The exclusion
    // is `isProseFunctionWord` — DELIBERATELY narrower than the seed-side B4
    // list: open-category common words that double as real names ("Bob",
    // "Pat", "April", "Gap") stay matchable, because a user typing one CAN
    // mean the contact; a closed-class word never can. A contact whose ENTIRE
    // name is one function word is fuzzy-unfindable (B4 already withholds its
    // label + ledger seed — the documented "miss > corrupt" trade, now
    // coherent across seed and match). Exact email/phone identifier matches
    // are unaffected (pinned path below).
    if (rec.name !== undefined && rec.name.length > 0) {
      for (const nameTok of wordSet(rec.name)) {
        if (queryTokens.has(nameTok) && !isProseFunctionWord(nameTok)) {
          score += 1; matched.add(nameTok);
        }
      }
    }
    // D-167 B4 — fuzzy company/org token overlap, scored like a name token so a
    // contact surfaces when the user mentions its org. Never pins. The company
    // also rides on the candidate below for ledger seeding REGARDLESS of a token
    // match here (mirrors how `phone` is carried); over-aliasing of a single-token
    // common-word org is prevented at the seed by the producer's commonness filter
    // — and the function-word exclusion gates the match here exactly like the
    // name leg (an org literally named "The"/"It" is noise; "Gap" keeps
    // matching).
    if (rec.company !== undefined && rec.company.length > 0) {
      for (const orgTok of wordSet(rec.company)) {
        if (queryTokens.has(orgTok) && !isProseFunctionWord(orgTok)) {
          score += 1; matched.add(orgTok);
        }
      }
    }
    // Exact phone-identifier match — a SEPARATED phone with NO name resolves the
    // contact, seeding its E.164 for the egress aliaser. The FULL E.164 matches a
    // BARE contiguous token OR a formatted run; the country-code-less NATIONAL /
    // trunk-`0` forms match a FORMATTED run ONLY (never a bare number — too
    // ambiguous with an invoice id). Every form is gated on uniqueness, and the
    // whole block on `phoneFormsComplete` (store-wide phone-form uniqueness — NOT
    // the fuzzy `fuzzyComplete`, so a capped fuzzy leg never suppresses an exact
    // phone hit). The cheap query-membership check is evaluated BEFORE `isUnique` so
    // the (store-backed, per-call SQL `countPhoneForm`) uniqueness oracle only runs
    // for a form the query actually contains — a non-phone query issues no count.
    if (rec.phone !== undefined && rec.phone.length > 0 && phoneFormsComplete) {
      const { full, national } = phoneMatchDigits(rec.phone);
      const fullHit = full !== undefined
        && (queryTokens.has(full) || phoneRunSet.has(full)) && isUnique(full);
      const nationalHit = national.some((d) => phoneRunSet.has(d) && isUnique(d));
      if (fullHit || nationalHit) { score += 5; pinned = true; }
    }
    // Exact email-identifier match (D-167 B1). `email` is the contacts PK → globally
    // unique, so a match is DEFINITIVELY the one contact with no ambiguity — needs
    // neither the `scanComplete` nor the page-local-uniqueness gate phone carries.
    if (emailRunSet.size > 0 && emailRunSet.has(rec.email)) { score += 5; pinned = true; }
    if (score > 0) {
      scored.push({
        ref: rec.email,
        label: rec.name ?? rec.email,
        score,
        matchedTokens: matched,
        ...(pinned ? { pinned: true } : {}),
        ...(rec.phone !== undefined && rec.phone.length > 0 ? { phone: rec.phone } : {}),
        ...(rec.company !== undefined && rec.company.length > 0 ? { company: rec.company } : {}),
      });
    }
  }
  // D-167 §2 ambiguity-gate — flag a fuzzy candidate AMBIGUOUS when a reference it
  // matched is CONTESTED: 2+ fuzzy candidates matched the same query token. PINNED
  // (exact-identifier) matches are definitive — the user typed the value — so they
  // are confident and excluded from the contest (their incidental name overlaps
  // must not contest a genuine fuzzy match).
  //
  // Per-token contention ONLY — deliberately NO cross-token dominance and NOTHING
  // is dropped. This scorer sees a deduped BAG of tokens with no adjacency, so it
  // cannot tell a single multi-token reference ("Sarah Smith") from two one-token
  // references that happen to spell one stored contact's full name ("Sarah and Kim"
  // with a stored "Sarah Kim"). Any rule that lets a higher-overlap candidate
  // dominate single-token matches would drop the real contacts and surface the
  // wrong one CONFIDENTLY — worse than no guess (§2). So a candidate is confident
  // only when it is the SOLE fuzzy matcher of every reference it hit; otherwise it
  // is ambiguous. The conservative cost is that a typed full name whose first name
  // collides with another contact is flagged ambiguous instead of a clean win — the
  // model still resolves it from the full name in the user text. A single
  // sole-match fuzzy name and every pinned identifier stay clean wins.
  //
  // Incomplete FUZZY coverage (`fuzzyComplete === false` — e.g. the FTS leg hit its
  // cap, so a query token matched more contacts than were retrieved): a second
  // matcher of a name could sit off-cap, so an in-set sole-matcher's uniqueness is
  // UNPROVABLE — a hidden "Sarah" would otherwise render confident. Fail CLOSED:
  // mark every fuzzy candidate ambiguous (the pinned EMAIL + exact phone paths are
  // unaffected — they don't depend on fuzzy completeness). Correct: a token matching
  // more contacts than the cap is genuinely ambiguous.
  const fuzzy = scored.filter((s) => s.pinned !== true);
  if (!fuzzyComplete) {
    for (const c of fuzzy) c.ambiguous = true;
  } else {
    const tokenMatchers = new Map<string, number>();
    for (const c of fuzzy) {
      for (const tok of c.matchedTokens) {
        tokenMatchers.set(tok, (tokenMatchers.get(tok) ?? 0) + 1);
      }
    }
    for (const c of fuzzy) {
      for (const tok of c.matchedTokens) {
        if ((tokenMatchers.get(tok) ?? 0) >= 2) { c.ambiguous = true; break; }
      }
    }
  }
  // Rank by score, then CONFIDENT before AMBIGUOUS, then (stable) the input recency
  // order. The ambiguity tiebreak means an unambiguous sole match isn't crowded out
  // of the top-K by equal-score ambiguous candidates — e.g. on "Megacorp Kim" the
  // unique "Kim" surfaces ahead of the many ambiguous "Megacorp" contacts. Among
  // candidates of equal score AND ambiguity the sort is stable, preserving the
  // retrieval's `last_interaction DESC` recency order.
  scored.sort((a, b) =>
    (b.score - a.score)
    || ((a.ambiguous === true ? 1 : 0) - (b.ambiguous === true ? 1 : 0)));

  // Keep every EXACT-identifier (pinned) match past the top-K cap so its values
  // always reach the alias ledger; fill the rest of `limit` with top fuzzy
  // (D-167 B1 — `selectWithPinned`). A name-only result set is unaffected.
  return selectWithPinned(scored, limit).map<PrefetchCandidate>(({ ref, label, score, phone, company, pinned, ambiguous }) => ({
    ref,
    label,
    kind: 'contact',
    score,
    ...(pinned ? { pinned: true } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(company !== undefined ? { company } : {}),
    ...(ambiguous === true ? { ambiguous: true } : {}),
  }));
};
