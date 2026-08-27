import type { ChatDispatchContext, ChatDispatchResult } from './chat-tool-handlers.js';
import { CHAT_INDEX_GENERIC_WORDS } from './chat-index-generic-words.js';

/** One probe: does this store hold this term? Returns the store's own answer;
 *  the caller never sees a row. Implementations run the ordinary Tier-1 read
 *  handler, which self-fences the collection grant — a store the owner revoked
 *  answers `ok:false` and is therefore never named, with no extra check here. */
export type ChatIndexProbe = (
  store: string,
  term: string,
  ctx: ChatDispatchContext,
) => Promise<ChatDispatchResult>;

/** Stores to probe, each paired with the array field that means A REAL HIT, in
 *  the order their names should render.
 *
 *  ⛔⛔ THE FIELD NAME IS LOAD-BEARING AND DIFFERS PER STORE. A shape-agnostic
 *  "any non-empty array in the result" check is WRONG here and fails OPEN:
 *  `mail.search` returns `{ matches, collections, source_freshness }`, and
 *  `collections` is non-empty whenever a mailbox is merely ENROLLED — so the
 *  generic walk reports a hit for every term in every store, naming everything
 *  and indexing nothing. Each entry below was read off the handler's own
 *  success return, not inferred.
 *
 *  ⛔ `recall.search` IS probeable, and an earlier version of this file claimed
 *  it was not. The claim was that its per-turn budget belongs to the MODEL, so
 *  probing would spend the model's own allowance. That is false: the budget
 *  counter lives INSIDE the `turn_state` Map handed to the dispatch
 *  (`getTurnState` creates it in whatever scratch it is given), and the model's
 *  dispatches use the turn's `streamState`. A probe passing its OWN fresh Map
 *  therefore gets its own `search_calls: 0` and costs the model NOTHING.
 *  ⇒ Measured consequence of leaving it out: the index named only mail+memory,
 *  the model searched exactly those two and stopped, and the answer — which
 *  lives only in prior-session interaction history — was unreachable in 0/5
 *  runs where control reached it 6/9 (p=0.031).
 *
 *  ⛔ `work.search` is deliberately ABSENT: it delegates to
 *  `runWorkEntitySearchTool` in another module and its hit field was not
 *  verified here. An unverified field would silently mean "never hits" (dead
 *  probe) or "always hits" (the fail-open above) — neither announces itself, so
 *  the store stays out until someone reads its return.
 *
 *  Order is STABLE, not ranked: the line says where a term appears, never which
 *  store is likelier to answer.
 *
 *  ⛔ `andCapable` — DOES A MULTI-TERM QUERY MEAN *ALL OF THESE* HERE? Only the
 *  FTS-backed stores. `recall` / `memory` match by JS substring on an
 *  exact→relaxed→LOOSE ladder whose last rung is `some(t => text.includes(t))`,
 *  i.e. ANY token, and `contact` is SQL `LIKE '%term%'` on one field. Sending
 *  them a co-occurrence expression does not make them honour it — it degrades
 *  to OR, and the index then claims a store holds the whole question when it
 *  holds one word of it.
 *
 *  ⚠ CAUGHT ONLY BY A LIVE RUN. The unit test's fake probe implemented ideal
 *  AND for every store, so the collapse passed there while emitting
 *  `agreed sandhurst renewal: memory.search, mail.search` against a memory row
 *  that contained none of `agreed` or `renewal`. A double that is more
 *  competent than the real thing proves the call, not the message.
 *
 *  ⛔ This REPLACES a `prefixable` flag that was correctly deleted for its
 *  original purpose — the relaxation rung reaches variants from a bare term, so
 *  nothing needs `term*` any more. It existed because FTS stores needed `term*` to reach `Thornfields`
 *  from `thornfield` while the substring stores (`recall` / `memory` /
 *  `contact`, the last via SQL LIKE) would have matched a LITERAL asterisk and
 *  returned nothing. The empty-result relaxation rung in
 *  `collections/table.ts` now retries a missed query over prefix forms of the
 *  tokens the index holds, so a bare term reaches the variant on its own —
 *  measured: with the flag OFF the line still named `mail.search`, identically
 *  to ON. A knob that no longer decides anything is worse than no knob, because
 *  the next reader assumes it does. */
export const CHAT_INDEX_STORES: ReadonlyArray<
  readonly [store: string, hitField: string, andCapable: boolean]
> = [
  // ⛔ `recall.search` MATCHES THE OWNER'S OWN CURRENT MESSAGE. The interaction
  //    lane indexes the live turn too, so an unfiltered probe returns a hit for
  //    EVERY distinctive term the owner just typed — measured: a statement turn
  //    produced `pausing: recall.search; safety: recall.search; clears:
  //    recall.search`, one entry per word, all self-matches. That is noise with
  //    the shape of signal, and it would name recall on every line forever.
  //    `hasHit` therefore drops matches whose `session_relation` is `current`:
  //    the current session is already in `chat_tail` and needs no index.
  ['recall.search', 'matches', false],
  ['memory.search', 'memories', false],
  ['mail.search', 'matches', true],
  ['contact.search', 'candidates', false],
  ['calendar.search', 'matches', true],
  ['file.search', 'files', true],
];

/** ⛔ BOUNDS ARE THE WHOLE COST STORY. Every turn pays
 *  `terms x stores` local FTS queries BEFORE the model is called, so these two
 *  caps are what keep a pre-seed from becoming a pre-stall. 4 x 6 = 24 bounded
 *  local reads, run concurrently. */
/** How many candidate terms are PROBED. Deliberately generous: on a long
 *  multi-task prompt the useful terms are spread through the whole request, and
 *  a low cap silently indexes only its opening clause.
 *
 *  ⛔ MEASURED FAILURE AT 4: "I'm prepping for the Sandhurst renewal review on
 *  Thursday. Remind me what NOTICE PERIOD we agreed, whether the site BADGES
 *  came through, and what I said about the SAFETY review." probed
 *  `prepping, sandhurst, renewal, review` — a junk verb plus the first clause —
 *  and never looked at `notice`, `period`, `badges` or `safety`, which are the
 *  terms for three of the four sub-questions. Probes run concurrently and cost
 *  0.02–10ms each, so wall-clock tracks the SLOWEST probe, not the count.
 *
 *  ⚠ THIS CAP IS STILL POSITIONAL, WHICH IS THE SAME FLAW ONE LEVEL UP. Terms
 *  are taken in appearance order until the cap, so a request longer than ~16
 *  distinctive words still goes unindexed at its tail — at 12, the example above
 *  reached `badges` but not `safety` (its 14th). Rarity ranking cannot fix this:
 *  rarity is what the PROBE measures, so a term has to be probed before it can
 *  be ranked. Raising the cap trades that tail against probe fan-out
 *  (16 x 6 = 96 concurrent reads), and the honest position is that very long
 *  requests remain truncated. */
export const CHAT_INDEX_MAX_TERMS = 16;

/** How many terms reach the LINE. The cap above buys coverage; this one keeps
 *  the line short. Which terms survive is decided by DISCRIMINATIVENESS, not by
 *  where they sat in the sentence — see `buildChatIndexContext`. */
export const CHAT_INDEX_MAX_LINE_TERMS = 5;

/** A term matching MORE than this many records in a store does not DISCRIMINATE
 *  there, so naming the store says nothing — that is the job the word list used
 *  to do badly and this does per-owner.
 *
 *  🔑 Measured on 50k real messages: `enron` matches 45% of an Enron employee's
 *  mail (→ over cap → not named) and 0.6% of a consultant's who has Enron as one
 *  client (→ under cap → named). Same word, opposite and CORRECT verdicts, with
 *  no list to maintain.
 *
 *  ⚠ `recall.search` returns at most `RECALL_SEARCH_MATCHES_PER_CALL` (20) per
 *  call, so it can never exceed this cap and is always treated as
 *  discriminating. That is a deliberate degradation, not an oversight: recall is
 *  the store the model most under-searches, and over-naming it is the cheaper
 *  error. */
export const CHAT_INDEX_TOO_COMMON_CAP = 50;
export const CHAT_INDEX_MAX_STORES_PER_TERM = 4;

const MIN_TERM_LENGTH = 4;

/** Distinctive terms from the owner's message, in first-appearance order.
 *  Lowercased, de-duplicated, stripped of punctuation, and filtered against the
 *  corpus stoplist. Numbers are dropped: `2024` indexes nothing. */
export const distinctiveTerms = (userMessage: string): readonly string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of userMessage.toLowerCase().split(/[^a-z0-9'-]+/)) {
    const term = raw.replace(/^[''-]+|[''-]+$/g, '');
    if (term.length < MIN_TERM_LENGTH) continue;
    if (!/[a-z]/.test(term)) continue;
    if (CHAT_INDEX_GENERIC_WORDS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= CHAT_INDEX_MAX_TERMS) break;
  }
  return out;
};

/** A hit is a NON-EMPTY named array, and nothing else.
 *
 *  ⛔ A DENIED READ ANSWERS `ok: true`, NOT `ok: false`. `collectionReadFenced`
 *  returns `{ ok: true, result: { matches: [], hint } }` on purpose — the Tier-1
 *  ANTI-LOOP invariant, so a fenced model is told the fence rather than looping.
 *  That makes `ok` useless as a permission signal here; the EMPTY ARRAY is what
 *  keeps a revoked store from being named, and it is the only thing that does. */
const usableCount = (result: ChatDispatchResult, hitField: string): number => {
  // Callers request `CHAT_INDEX_TOO_COMMON_CAP + 1`, so a full array means "at
  // least cap+1 matches" — too common HERE to be worth naming.
  if (!result.ok) return 0;
  const value = (result as { result?: unknown }).result;
  if (value === null || typeof value !== 'object') return 0;
  const field = (value as Record<string, unknown>)[hitField];
  if (!Array.isArray(field) || field.length === 0) return 0;
  // A match in the CURRENT session is not something an index can usefully point
  // at — the model already has it in `chat_tail`. Rows without the field (every
  // other store) are kept, so this narrows recall only.
  const usable = field.filter((row) =>
    row === null
    || typeof row !== 'object'
    || (row as Record<string, unknown>).session_relation !== 'current');
  // 0 = no hit; >CAP = present but not discriminating. Both are "don't name it",
  // but the COUNT is what lets terms be ranked against each other below.
  return usable.length <= CHAT_INDEX_TOO_COMMON_CAP ? usable.length : 0;
};

/** The CO-OCCURRENCE probe expression for a set of terms.
 *
 *  ⛔⛔ IT MUST BE ONE THE RELAXATION RUNG SKIPS, or the idea collapses into
 *  nothing. A plain `thornfield payment terms` misses (no record holds all
 *  three), the rung then retries over the tokens the corpus DOES hold, and the
 *  phrase probe returns exactly what the single-word `thornfield` probe already
 *  returned — it would look like it worked while measuring nothing.
 *
 *  Explicit quoted-prefix tokens (`"a"* "b"*`) are implicit AND, and the rung's
 *  guard declines to relax any query carrying FTS syntax. So this stays a STRICT
 *  all-terms-present test while still reaching `Thornfields` from `thornfield`. */
const coOccurrenceQuery = (terms: readonly string[]): string =>
  terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');

/** Build the pre-seed index line, or `undefined` when nothing is worth saying.
 *
 *  ⛔⛔ STORE NAMES ONLY — never a title, a count, a snippet or a summary. This
 *  is an INDEX (where to look), not an ANSWER (what is there). The distinction
 *  is not stylistic: a variant that rendered one-line SUMMARIES produced a
 *  confident `12% discount ... two-year commitment` that appeared in NO packet
 *  and contradicted the stored record — an honest "I have no record of that"
 *  turned into fiction. Bare store names measured EQUAL to titles (9/10 vs
 *  9/10) on the two-referent case and beat no-index (1/10), so the richer
 *  render bought nothing and cost truth. */
/** Test-only: omit named stores from the probe set, to measure DELIBERATE
 *  incompleteness under control.
 *
 *  ⛔ THE HARM NUMBER IN THE RECORD CAME FROM AN ACCIDENT, NOT AN EXPERIMENT.
 *  The index once failed to probe `recall.search` because of a wrong belief
 *  about its budget; the -11pt / 0-of-10 figures describe THAT BUILD, which no
 *  longer exists. They were being quoted as if they characterised the design's
 *  risk. They do not — they characterise a bug that was fixed.
 *
 *  The prospective risk is different and is what this exists to measure: a store
 *  gets added to the catalog and not to `CHAT_INDEX_STORES`, or one becomes
 *  unprobeable, and the index silently names a subset again. That is a
 *  CONTROLLED omission, and it deserves a controlled measurement rather than an
 *  anecdote from a build nobody can rerun. */
const omittedStores = (): ReadonlySet<string> => {
  const raw = process.env.RECUED_CHAT_INDEX_OMIT;
  if (typeof raw !== 'string' || raw.length === 0) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
};

export const buildChatIndexContext = async (
  userMessage: string,
  ctx: ChatDispatchContext,
  probe: ChatIndexProbe,
  storesIn: typeof CHAT_INDEX_STORES = CHAT_INDEX_STORES,
): Promise<string | undefined> => {
  let stores = storesIn;
  const omit = omittedStores();
  if (omit.size > 0) stores = stores.filter(([name]) => !omit.has(name));

  const terms = distinctiveTerms(userMessage);
  if (terms.length === 0) return undefined;

  const entries = await Promise.all(
    terms.map(async (term) => {
      const found = await Promise.all(
        stores.map(async ([store, hitField]) => {
          try {
            const n = usableCount(await probe(store, term, ctx), hitField);
            return n > 0 ? { store, n } : null;
          } catch {
            // A probe that throws is a store that answered nothing. It must not
            // take the turn down with it: the index is an optimisation, and the
            // pre-index behaviour (no line) is always a correct fallback.
            return null;
          }
        }),
      );
      const hits = found.filter((x): x is { store: string; n: number } => x !== null);
      return {
        term,
        stores: hits.map((h) => h.store).slice(0, CHAT_INDEX_MAX_STORES_PER_TERM),
        // Fewest matches = most specific. A term hitting 3 records LOCATES
        // something; one hitting 400 merely occurs.
        rarity: hits.length === 0 ? Infinity : Math.min(...hits.map((h) => h.n)),
      };
    }),
  );

  // ── RANK FIRST ───────────────────────────────────────────────────────────
  // ⛔ RANK BY DISCRIMINATIVENESS, NOT BY POSITION IN THE SENTENCE. The probe cap
  // used to double as the line cap, so the line was just the first N distinctive
  // words — on a long request, its opening clause — and a junk verb (`prepping`,
  // `agreed`) could take a slot from a term that actually locates something.
  // Ordering by fewest matches disposes of both WITHOUT hand-curating word
  // classes, which is what went wrong when a corpus-mined stoplist ended up
  // censoring real client names.
  //
  // Tie-break on SPREAD (a term in several stores is the one most likely to be
  // under-searched), then first appearance — `sort` is stable.
  const ranked = entries
    .filter((entry) => entry.stores.length > 0)
    .sort((a, b) => (a.rarity - b.rarity) || (b.stores.length - a.stores.length))
    .slice(0, CHAT_INDEX_MAX_LINE_TERMS);
  if (ranked.length === 0) return undefined;

  // ── CO-OCCURRENCE COLLAPSE ───────────────────────────────────────────────
  // A store holding ALL the owner's terms together is far stronger evidence than
  // the same store holding one. Listing `payment: mail.search` beside
  // `thornfield: mail.search` also misleads — it points at stores that merely
  // contain a common word, the same false lead that made `OR` the wrong
  // relaxation. A store where every term co-occurs is reported ONCE under the
  // phrase and dropped from the single-term entries.
  //
  // ⛔ OVER THE RANKED TERMS, NOT EVERY CANDIDATE. The probe cap is now 12, and
  // a strict AND over twelve words matches nothing anywhere — the collapse would
  // silently never fire and the flag would look like a no-op.
  const phraseTerms = ranked.map((e) => e.term);
  const phraseStores: string[] = [];
  // A/B switch: `0` renders the FLAT form so the collapse is measured, not assumed.
  const collapseOn = process.env.RECUED_CHAT_INDEX_COLLAPSE !== '0';
  if (collapseOn && phraseTerms.length > 1) {
    const q = coOccurrenceQuery(phraseTerms);
    const found = await Promise.all(
      stores.filter(([, , andCapable]) => andCapable).map(async ([store, hitField]) => {
        try {
          return usableCount(await probe(store, q, ctx), hitField) > 0 ? store : null;
        } catch {
          return null;
        }
      }),
    );
    phraseStores.push(...found.filter((x): x is string => x !== null));
  }
  const collapsed = new Set(phraseStores);

  const useful = ranked
    .map((entry) => ({ ...entry, stores: entry.stores.filter((st) => !collapsed.has(st)) }))
    .filter((entry) => entry.stores.length > 0);
  if (useful.length === 0 && phraseStores.length === 0) return undefined;

  // COVERAGE variant. The line normally names only the stores that HAVE the
  // term, which leaves the model unable to tell "checked and empty" from "never
  // checked" — the exact ambiguity that made the incomplete index harmful. This
  // renders the checked-and-empty stores explicitly.
  //
  // ⚠ It is NOT obviously an improvement, which is why it is gated and
  // measured: naming a store as empty converts "unmentioned" into "confirmed
  // empty", a STRONGER suppression signal. FTS is exact-match, so 0 hits for
  // `thornfield` does not mean contacts hold nothing relevant — a contact
  // "Jane at Thornfield Ltd" is reachable by a different query. Volume is
  // deliberately still omitted: bare stores already tied stores-with-counts
  // (9/10 vs 9/10), so this tests COVERAGE, not counts.
  const withZeros = process.env.RECUED_CHAT_INDEX_ZEROS === '1';
  const allStores = stores.map(([name]) => name);
  const singles = useful
    .map((entry) => {
      const named = `${entry.term}: ${entry.stores.join(', ')}`;
      if (!withZeros) return named;
      const empty = allStores.filter((n) => !entry.stores.includes(n));
      return empty.length > 0
        ? `${named} (checked, not in: ${empty.join(', ')})`
        : named;
    })
    .join('; ');

  // The phrase entry leads: it is the most specific thing the index knows.
  const body = phraseStores.length > 0
    ? [`${phraseTerms.join(' ')}: ${
        phraseStores.slice(0, CHAT_INDEX_MAX_STORES_PER_TERM).join(', ')}`,
       ...(singles ? [singles] : [])].filter((x) => x.length > 0).join('; ')
    : singles;

  // ⛔ MEASURED: WITHOUT THIS FRAMING THE MODEL READS THE INDEX AS A CLOSED
  // LIST. On the bench's multi-store case the index named `memory.search,
  // mail.search` and the model then called `recall.search` in 0/10 runs, where
  // the SAME task with no index called it in 7/10 — the line suppressed a tool
  // the model otherwise reached for, and the forbidden `memory.write` rose 1/10
  // -> 5/10 as it tried to write the answer it had stopped looking for.
  //
  // ⛔ THE ORIGINAL RATIONALE HERE WAS WRONG AND IS KEPT ONLY AS A WARNING. It
  // claimed recall.search "cannot be probed — it spends the model's own per-turn
  // budget", concluded every index was necessarily partial, and on that basis
  // ruled the whole design unshippable. The budget lives in the `turn_state`
  // MAP, so a probe with its own Map costs the model nothing; recall is probed
  // now and the harm inverted (reached 0/10 → 22/23). The index is NOT partial
  // in the way this framing assumes, which is why the framing stays OFF by
  // default and unproven. A claim of impossibility needs a test, not a reading.
  return process.env.RECUED_CHAT_INDEX_FRAMING === '1'
    ? `${body} — partial: only some stores are indexed, and a term may also be `
      + 'in ones not named here, including this conversation\'s own history. '
      + 'Search whatever the question calls for.'
    : body;
};
