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
/** Extra args a store needs before a PROBE can see anything. ⛔⛔ THIS EXISTS
 *  BECAUSE `file.search` WAS SILENTLY UNPROBEABLE. It defaults to
 *  `scope: 'session'` — files attached to THIS conversation — and the probe sent
 *  only `{query, limit}`, so it answered `files: []` with
 *  "no conversation files are readable here" for every term, on every turn,
 *  forever. Measured directly against the real handler: the same probe with
 *  `scope: 'all'` returns the matching file.
 *
 *  🔑 THAT IS THIS FEATURE'S OWN WORST FAILURE MODE, not a missing nicety. An
 *  INCOMPLETE index is worse than none — naming a subset makes the unnamed read
 *  as ABSENT, worth 16/23 -> 0/10 on the store the line could not name. `file`
 *  was in `CHAT_INDEX_STORES`, so it looked covered, and answered nothing.
 *
 *  ⚠⚠ AND THE NARROW DEFAULT IS DELIBERATE, WHICH IS WHY THIS NEEDS AN ARGUMENT
 *  RATHER THAN A SHRUG. `file.search`'s own schema tells the model: "`all` =
 *  every file Mary holds, INCLUDING UPLOADS FROM STRANGERS. Say nothing to get
 *  `session`; widen only on an explicit request from HER."
 *
 *  🔑 THE INDEX IS A POINTER; THE TOOL IS STILL THE GATE. Widening the probe
 *  does not widen what the model can READ. The probe's only output is a STORE
 *  NAME on the index line — never a filename, never content — and if the model
 *  then calls `file.search` it gets `session` by default and must widen
 *  explicitly, exactly as before. So the owner's rule about what may be
 *  RETURNED is untouched; what changes is only whether the line can say "there
 *  is something here".
 *
 *  ⚠ The trade is real and worth naming: an owner who considers even the
 *  EXISTENCE signal too much should drop `file.search` from
 *  `CHAT_INDEX_STORES` rather than leave it listed and unprobeable — a listed
 *  store that always answers nothing is the harm mode above, not a safe
 *  middle. */
export const CHAT_INDEX_PROBE_ARGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'file.search': { scope: 'all' },
  // `work.search` takes ONE `kind` per call, so each kind is a separate probe
  // keyed `work.search:<kind>`. `chatIndexProbeTool` maps the key back to the
  // real tool name for admission + handler lookup.
  'work.search:task': { kind: 'task' },
  'work.search:note': { kind: 'note' },
  'work.search:commitment': { kind: 'commitment' },
  'work.search:project': { kind: 'project' },
  'work.search:booking': { kind: 'booking' },
};

/** The TOOL a probe key dispatches to. Keys may carry a per-call discriminator
 *  (`work.search:note`); everything before the first `:` is the tool name.
 *
 *  ⛔ USED FOR ADMISSION AND HANDLER LOOKUP BOTH. A key reaching `admitTier1`
 *  or `tier1Handlers` unsplit is not a tool, so it is denied or missing — and
 *  a denied probe reads exactly like an empty store, which is this feature's
 *  own measured harm mode. */
export const chatIndexProbeTool = (probeKey: string): string =>
  probeKey.split(':')[0] ?? probeKey;

/** How a probe key is NAMED in the line the model reads. The model calls
 *  `work.search`, never `work.search:note`, so the discriminator is dropped —
 *  and duplicate names collapse, so a term found in three kinds names the tool
 *  once rather than reading as three stores. */
export const chatIndexProbeLabel = (probeKey: string): string =>
  chatIndexProbeTool(probeKey);

/** How a store answers a CO-OCCURRENCE probe — the index's own "tier 2", the
 *  question "does one store hold ALL of these words?".
 *
 *  ⛔ `'none'` IS NOT "CANNOT AND", IT IS "WOULD LIE ABOUT IT". `recall` and
 *  `memory` match on an exact→relaxed→LOOSE ladder whose last rung is
 *  `some(t => text.includes(t))` — ANY token — and `contact` is SQL
 *  `LIKE '%term%'` on one field. Sending them a co-occurrence expression does
 *  not make them honour it; it degrades to OR, and the index then claims a
 *  store holds the whole question when it holds one word of it. Caught by a
 *  live run: the unit harness implemented ideal AND for every store, so the
 *  collapse passed there while emitting `agreed sandhurst renewal:
 *  memory.search` against a row containing neither `agreed` nor `renewal`.
 *
 *  ⛔ AND THE MODE IS ABOUT SYNTAX AS MUCH AS SEMANTICS, which a boolean hid.
 *  `'fts'` stores parse FTS5 (`"a"* "b"*`) and get implicit AND for free.
 *  `'terms'` stores mean AND but read a query as plain text — sending them
 *  FTS5 punctuation would have them hunt for literal quotes and asterisks and
 *  match nothing, so the collapse would silently never fire and the flag would
 *  look like a no-op. `file.search` is exactly that case: it requires every
 *  term over name+path, and would choke on the quoting. */
export type ChatIndexAndMode = 'none' | 'fts' | 'terms';

export const CHAT_INDEX_STORES: ReadonlyArray<
  readonly [store: string, hitField: string, andMode: ChatIndexAndMode]
> = [
  // ⛔ `recall.search` MATCHES THE OWNER'S OWN CURRENT MESSAGE. The interaction
  //    lane indexes the live turn too, so an unfiltered probe returns a hit for
  //    EVERY distinctive term the owner just typed — measured: a statement turn
  //    produced `pausing: recall.search; safety: recall.search; clears:
  //    recall.search`, one entry per word, all self-matches. That is noise with
  //    the shape of signal, and it would name recall on every line forever.
  //
  //    ⛔⛔ THE SUPPRESSION IS D-213's, NOT A SECOND COPY OF IT. This used to
  //    drop every row whose `session_relation` is `current`, justified as "the
  //    current session is already in `chat_tail`". That is true for
  //    `CHAT_TAIL_LIMIT` (=3) rows and FALSE for every turn before them: at
  //    turn 19, turns 1-15 are in neither the tail nor the index, so the one
  //    store that holds them is never named — and naming a subset is this
  //    feature's own measured harm mode (0/10 reached vs 16/23 with no index
  //    at all). The probe now registers the turn's `visible_recall_item_ids`
  //    (D-213: tail rows + the current user row) onto its own scratch Map, so
  //    the recall lane excludes them at SEARCH time via `excluded_item_ids` —
  //    the same rule the model's own dispatches get, one definition.
  //    ⚠ That registration is load-bearing: without it every self-match comes
  //    back and the noise above returns. BOTH turn surfaces must pass the ids.
  ['recall.search', 'matches', 'none'],
  ['memory.search', 'memories', 'none'],
  ['mail.search', 'matches', 'fts'],
  ['contact.search', 'candidates', 'none'],
  ['calendar.search', 'matches', 'fts'],
  // ⛔ NOT FTS. `file.search` LISTS the collection and filters FILENAMES by JS
  // substring (`r.filename.toLowerCase().includes(query)`) — it never touches
  // the FTS table, so a quoted co-occurrence expression reaches it as literal
  // text and matches nothing. Same error I already made with `contact.search`:
  // the store owns an FTS table, but the TOOL does not use it. Read the path the
  // TOOL takes, not the capabilities the store happens to have.
  //
  // ⚠ It also means the index can only ever locate a file by its NAME. A term
  // that appears solely in file CONTENT is invisible here, and no probe of this
  // tool will find it.
  ['file.search', 'files', 'terms'],
  // ⛔⛔ WORK ENTITIES WERE ABSENT, AND THE INDEX REPORTED A CONFIDENT WRONG
  //   STORE BECAUSE OF IT. Measured (task 343, run `2026-09-07T12-05-21-166Z`):
  //   the packet carried `index_context: "ring: memory.search; surcharge:
  //   memory.search"` while twelve notes titled "Kestrel ring NN" sat in
  //   `work.search`. The model followed the line — eight `memory.search` calls
  //   across four rounds in turn 7, never once reaching for the store that had
  //   the answer — and the turn ended "I can't complete the sum".
  //
  //   🔑 A MISSING STORE DOES NOT PRODUCE "UNKNOWN", IT PRODUCES A WRONG
  //   POINTER. This index reports the stores that HIT; with the holding store
  //   unprobed, the loosest match among the rest wins and is stated in the same
  //   grammar as a real find. `memory.search` returned one irrelevant memory at
  //   `match: 'loose'` and became the answer.
  //
  //   ⛔ `'fts'` VERIFIED BY THE TOOL'S PATH, NOT THE STORE'S CAPABILITIES —
  //   the rule `file.search` above exists to enforce. `work.search` reaches
  //   `searchIdsByText` -> `toFtsMatch` -> FTS5 `MATCH` (the word-matching index
  //   shipped 2026-09-05), so it parses a co-occurrence expression correctly.
  //   Before that change it filtered in JS and would have belonged in `'terms'`.
  //
  //   ⚠ ONE `kind` PER CALL, so this is five probes per term, not one: the
  //   cost per turn goes ~12 -> ~22 concurrent local reads at the observed
  //   median of 2 terms. They are SQLite reads against `work_entity_fts`, not
  //   model calls — no tokens, no provider latency — and both probe loops are
  //   already `Promise.all`. Probing only `note` was considered and refused: it
  //   would narrow this blind spot while leaving the same failure shape for a
  //   term that lives in a task, project, commitment or booking.
  ['work.search:task', 'entities', 'fts'],
  ['work.search:note', 'entities', 'fts'],
  ['work.search:commitment', 'entities', 'fts'],
  ['work.search:project', 'entities', 'fts'],
  ['work.search:booking', 'entities', 'fts'],
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
/** CJK has no inter-word spaces, so a 2-character run is a whole word.
 *
 *  ⚠ CJK IS SEGMENTED, BUT ONLY THREE OF THE SIX STORES CAN USE IT. The query
 *  side is solved by `Intl.Segmenter` (below). The STORED side is not: FTS5's
 *  `unicode61` makes an unspaced run ONE token, so `mail` / `calendar` /
 *  `memory` match a CJK term only where it sits at the START of a run, while
 *  `recall` / `file` / `contact` match by JS substring or SQL LIKE and work
 *  fully. Measured, so it is not a guess.
 *
 *  ⛔ AND THE OBVIOUS FTS FIX IS A TRAP: the `trigram` tokenizer is the
 *  textbook answer for CJK, and it has a THREE-CHARACTER FLOOR — measured,
 *  `续约` and `通知` (2 chars) return 0 while `通知期` (3) returns 1. The most
 *  common Chinese word length is two characters, so trigram misses precisely
 *  the words a corpus is made of. What does work is space-separating Han at
 *  FTS-write time so each character is a token and a 2-char word matches as an
 *  adjacent phrase — verified, Latin in the same blob unaffected. That is a
 *  migration over shipped derived rows and is deliberately NOT bundled here. */
const CJK_MIN_TERM_LENGTH = 2;

/** Scripts whose words are NOT delimited by spaces. ⛔ THE SET WAS WRONG WHEN
 *  IT WAS SPELLED "CJK", IN BOTH DIRECTIONS, AND BOTH HALVES WERE MEASURED
 *  AGAINST A REAL FTS5 INDEX RATHER THAN REASONED ABOUT:
 *
 *   · HANGUL WAS IN IT AND MUST NOT BE. Korean IS space-separated, so
 *     `unicode61` tokenizes it correctly — a mid-run `갱신` matches exactly.
 *     Suppressing the index for Korean owners bought nothing and cost them the
 *     feature.
 *   · THAI / LAO / KHMER WERE ABSENT AND MUST BE IN IT. They are unspaced too,
 *     so they hit the identical failure — measured, a mid-run Thai `ระยะเวลา`
 *     scores exact=0 against its own document.
 *
 *  ⚠ Myanmar reads as OK on the same probe (exact=1) and is deliberately left
 *  out rather than added on the assumption that "unspaced" implies "broken" —
 *  the shape of the script is not the test, the tokenizer's behaviour is. */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}]/u;

/** Scripts whose words are commonly two characters, so the Latin minimum length
 *  would discard real terms. A superset of the above: Korean is space-separated
 *  (hence not there) but `갱신` is still a 2-syllable word. */
const SHORT_WORD_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}]/u;

/** Abjads, where the TRILITERAL ROOT is the normal shape of a content word, so
 *  the Latin floor of 4 discards meaning rather than noise. The cut at 3 is
 *  measured, not guessed — it is exactly where content and function words
 *  separate in these scripts:
 *
 *    3 chars: `משך` (duration), `מהו` (what is), `مدة` (duration)  <- KEEP
 *    2 chars: `في` (in), `ما` (what), `هي` (is)                    <- drop
 *
 *  Two of five Hebrew words and one of six Arabic words in the probe sentences
 *  were being dropped at 4, `מדة` / `مدة` among them — the very noun the
 *  question was about. */
const ABJAD_SCRIPT = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const ABJAD_MIN_TERM_LENGTH = 3;

let cjkSegmenter: Intl.Segmenter | null | undefined;

/** Word-split a term that contains CJK. ⛔ Applied ONLY to terms that actually
 *  carry CJK, never to the Latin path: `Intl.Segmenter` breaks Latin on its own
 *  rules (apostrophes, hyphens) and re-tokenising there would silently
 *  invalidate every Latin measurement the index was promoted on.
 *
 *  Falls back to the whole run if the runtime has no segmenter — the pre-fix
 *  behaviour, i.e. inert rather than wrong. */
const segmentCjk = (term: string): readonly string[] => {
  if (!UNSPACED_SCRIPT.test(term)) return [term];
  if (cjkSegmenter === undefined) {
    try {
      cjkSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    } catch {
      cjkSegmenter = null;
    }
  }
  if (cjkSegmenter === null) return [term];
  const parts: string[] = [];
  for (const piece of cjkSegmenter.segment(term)) {
    if (piece.isWordLike === true) parts.push(piece.segment);
  }
  return parts.length > 0 ? parts : [term];
};

/** Distinctive terms from the owner's message, in first-appearance order.
 *  Lowercased, de-duplicated, stripped of punctuation, and filtered against the
 *  corpus stoplist.
 *
 *  ⛔ A PURE-DIGIT TERM IS KEPT. It used to be dropped, justified as "`2024`
 *  indexes nothing" — but that reasoned from the WEAKEST number to a rule over
 *  all of them. Measured, the drop cost `invoice 88421` its `88421` and
 *  `order 4471193` its `4471193`: in both the number is the single most
 *  distinctive thing in the sentence, and the index kept only the generic noun
 *  beside it. Commonness is already handled downstream by
 *  `CHAT_INDEX_TOO_COMMON_CAP`, which is where a year like `2024` dies on its
 *  own evidence rather than on its shape. */
export const distinctiveTerms = (userMessage: string): readonly string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  // ⛔⛔ UNICODE-AWARE, AND IT WAS NOT. The split was `[^a-z0-9'-]+`, so every
  // non-ASCII character acted as a SEPARATOR — which does not merely skip
  // non-English text, it CORRUPTS it. Measured: `préavis` -> `avis` (a
  // different word), `Kündigungsfrist` -> `ndigungsfrist`,
  // `Sandhurst-Verlängerung` -> `sandhurst-verl` + `ngerung`, `renovación` ->
  // `renovaci`. Those fragments can never match the stored record, and one like
  // `avis` may match something UNRELATED — a false lead, not a silent miss.
  // Chinese / Japanese / Russian / Arabic reduced to whatever Latin brand name
  // happened to appear, so the index was inert for those owners entirely.
  // ⛔⛔ `\p{M}` IS LOAD-BEARING AND WAS MISSING. A combining mark is neither a
  // letter nor a number, so without it every Thai tone mark, Indic matra,
  // Arabic harakat and Hebrew niqqud acted as a SEPARATOR — the identical bug
  // the ASCII-only class had, one layer down. Measured before the fix:
  //   अनुबंध की सूचना …  -> []      (Hindi, and Bengali, Tamil, Arabic, Hebrew)
  //   ระยะเวลาแจ้งล่วงหน้า -> แจ + งล   (Thai, shattered at the tone marks)
  // The Indic and Semitic cases returned NOTHING AT ALL: each fragment fell
  // under the Latin minimum length, so the index was silently inert for those
  // owners rather than merely degraded — and inert while shipped ON.
  outer: for (const raw of userMessage.toLowerCase().split(/[^\p{L}\p{N}\p{M}'-]+/u)) {
    const trimmed = raw.replace(/^[''-]+|[''-]+$/gu, '');
    for (const term of segmentCjk(trimmed)) {
      // ⚠ CJK writes words without spaces, so a script-blind minimum length
      // discards real terms: a 2-character Han/Kana/Hangul run is a word. Latin
      // keeps the higher floor, where short tokens are mostly function words.
      const floor = SHORT_WORD_SCRIPT.test(term)
        ? CJK_MIN_TERM_LENGTH
        : ABJAD_SCRIPT.test(term) ? ABJAD_MIN_TERM_LENGTH : MIN_TERM_LENGTH;
      if (term.length < floor) continue;
      // Letters OR digits — see the note above on pure-digit terms. This drops
      // only what carries neither, e.g. a token trimmed down to punctuation.
      if (!/[\p{L}\p{N}]/u.test(term)) continue;
      if (CHAT_INDEX_GENERIC_WORDS.has(term)) continue;
      if (seen.has(term)) continue;
      seen.add(term);
      out.push(term);
      if (out.length >= CHAT_INDEX_MAX_TERMS) break outer;
    }
  }
  return out;
};

/** ⚗ EXPERIMENT GATE, DEFAULT OFF — own-session rows older than `chat_tail`.
 *
 *  OFF (shipped): the probe registers nothing, the recall lane returns
 *  own-session rows, and `usableCount` drops every one of them on
 *  `session_relation`. Byte-identical to the behaviour this replaces.
 *
 *  ON: the probe registers the turn's `visible_recall_item_ids`, the lane
 *  excludes exactly those at SEARCH time, and the session filter is skipped —
 *  so a turn that has aged out of the 3-row tail becomes nameable.
 *
 *  ⛔⛔ BOTH HALVES MOVE TOGETHER OR THE ARM IS NOT THE ARM. Registering
 *  without skipping the filter changes CONTROL (excluded rows stop consuming
 *  the lane's ≤20-row page, so more non-current rows survive to be counted);
 *  skipping the filter without registering re-admits every self-match. Read
 *  once here so one env read cannot disagree with the other mid-turn. */
export const chatIndexSessionRowsEnabled = (): boolean =>
  process.env.RECUED_CHAT_INDEX_SESSION_ROWS === '1';

/** A hit is a NON-EMPTY named array, and nothing else.
 *
 *  ⛔ A DENIED READ ANSWERS `ok: true`, NOT `ok: false`. `wrapCollectionFence`
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
  // ON: rows already in the prompt were excluded by the recall lane itself
  // (`excluded_item_ids`, seeded from the probe's registered
  // `visible_recall_item_ids`), so a row that REACHES here is one the model does
  // NOT already hold — including an own-session turn aged out of the 3-row tail.
  // OFF: the lane returned them, so drop own-session rows here. Rows without the
  // field (every other store) are kept, so this narrows recall only.
  const usable = chatIndexSessionRowsEnabled()
    ? field
    : field.filter((row) =>
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
const coOccurrenceQuery = (
  terms: readonly string[],
  mode: ChatIndexAndMode,
): string => (mode === 'fts'
  // FTS5: quoted prefix tokens, implicitly ANDed by the engine.
  ? terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ')
  // Plain text: the store splits on whitespace and requires every term itself.
  // ⛔ It must NOT receive the FTS form — it would search for literal quotes.
  : terms.join(' '));

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

/** ⛔ THE UNSPACED-SCRIPT REFUSAL WAS LIFTED — the stored side is fixed.
 *
 *  For one day this returned `undefined` for any message carrying Han, Kana,
 *  Thai, Lao or Khmer. Not because CJK failed — it rendered, and well — but
 *  because it rendered INCOMPLETE: FTS5's `unicode61` makes an unspaced run ONE
 *  token, so `mail` / `calendar` / `memory` matched a term only where it BEGAN
 *  a run, and naming a subset is this feature's own measured harm mode.
 *
 *  `FTS_CONTENT_FORMAT` 2 removes the cause rather than the symptom: unspaced
 *  scripts are space-separated per GRAPHEME at FTS-write time, so a 2-character
 *  word matches as an adjacent phrase, and every existing index rebuilds itself
 *  once. Measured through the real collection table, same document:
 *  `mail.search(通知)` went 0 -> 1 at position 2.
 *
 *  ⚠ WHAT THE LIFT BUYS BACK IS NOISE, AND THE CAP IS WHAT HOLDS IT. Per-
 *  grapheme tokens make ANY substring of a run matchable, so Japanese auxiliary
 *  tails (`しま` / `した` out of `しました`) now match real documents instead of
 *  nothing. `CHAT_INDEX_TOO_COMMON_CAP` is the answer and it is a corpus-size
 *  answer: in a real Japanese mailbox those fragments appear everywhere and die
 *  on their own frequency; in a SMALL corpus they can sit under the cap and
 *  reach the line. That is a line with a useless entry on it, not a line that
 *  hides a store — the failure mode it replaced. */
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
      const raw = found.filter((x): x is { store: string; n: number } => x !== null);
      // Collapse `work.search:*` to one `work.search`, keeping first-hit order.
      const seenLabel = new Set<string>();
      const hits: { store: string; n: number }[] = [];
      for (const h of raw) {
        const label = chatIndexProbeLabel(h.store);
        if (seenLabel.has(label)) continue;
        seenLabel.add(label);
        hits.push({ store: label, n: h.n });
      }
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
    const found = await Promise.all(
      stores.filter(([, , mode]) => mode !== 'none').map(async ([store, hitField, mode]) => {
        try {
          const q = coOccurrenceQuery(phraseTerms, mode);
          return usableCount(await probe(store, q, ctx), hitField) > 0 ? store : null;
        } catch {
          return null;
        }
      }),
    );
    // ⛔⛔ LABEL HERE TOO, AND THE COLLAPSE DEPENDS ON IT. `found` carries PROBE
    //   KEYS (`work.search:note`), while `entry.stores` above already carries
    //   LABELS — so pushing keys leaks a tool name the model cannot call INTO
    //   THE LINE, and makes `collapsed.has('work.search')` false, so the
    //   single-term entries are never dropped.
    //
    //   🔑 BOTH FAILURES WERE VISIBLE IN ONE LIVE LINE (task 343, run
    //   `2026-09-07T13-45-02-144Z`):
    //     "ring note read checkpoint cost: work.search:note; ring:
    //      memory.search, work.search; note: memory.search, work.search; ..."
    //   the phrase names a non-existent tool AND the terms it should have
    //   collapsed are still listed beside it.
    for (const key of found) {
      if (key === null) continue;
      const label = chatIndexProbeLabel(key);
      if (!phraseStores.includes(label)) phraseStores.push(label);
    }
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
