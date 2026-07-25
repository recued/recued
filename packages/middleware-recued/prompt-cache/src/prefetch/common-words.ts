/** D-167 Prefetch PII Coverage Expansion — B4 commonness filter.
 *
 *  The single-token-common-word residual (design
 *  `docs/d-167-prefetch-pii-coverage-design.md` §5 + the §6.1 measurement):
 *  with full-value containment (D3) every MULTI-token name/org seeds precisely,
 *  but a SINGLE-token value that is itself a common English word — a contact
 *  whose whole name is "Will", an org literally named "Gap" — still over-aliases
 *  when the bare word appears in unrelated prose ("I *will* follow up", "mind the
 *  *gap*"). The measurement found the entire false-positive residual is exactly
 *  this class (`Will`/`Mark`/`Summer`/`Gap`/`Block`/`Slack`/`Stripe`/…), each a
 *  common word; the gate the data mandated is: **don't SEED a single-token value
 *  that's a common English word.** `scanContent` aliases anything in the ledger,
 *  so withholding the seed is the surgical fix — it costs nothing for multi-token
 *  names (always seeded, D3) or DISTINCTIVE single tokens (Datadog/Twilio/Okta —
 *  not common words, still seeded), and only declines to protect a contact whose
 *  entire name/org IS a common word (the comfort-layer's accepted "miss > corrupt"
 *  trade — such a value is low-identifying and round-trips raw, never leaks).
 *
 *  Curating principle: HIGH-FREQUENCY everyday English — the words that actually
 *  appear in prose and so actually collide. Words known PRIMARILY as distinctive
 *  brands/proper names are deliberately EXCLUDED even when they are dictionary
 *  words (e.g. `snowflake`, `oracle`-the-product's rarer peers), so a user's
 *  distinctive single-token org keeps its protection. The §6.1 measurement's
 *  offender list (`Sunday Summer Art Mark Will Block Gap Slack Square Bond Amazon
 *  Meta Bench Stripe Apple` …) is the coverage target; the measurement's
 *  `RARE_NAMES` / `RARE_ORG` pools are the must-NOT-contain set.
 *
 *  Case-insensitive (`any case`, design §5): the set holds lower-cased words and
 *  the predicate lower-cases its input. Pure data + one predicate — no I/O — so
 *  both the production seed path (`toPrefetchEntityRecord`) and the measurement
 *  harness gate on the SAME contract.
 */

/** The grammatically-CLOSED prose classes — pronouns, determiners,
 *  conjunctions, prepositions, auxiliaries, and the high-frequency two-letter
 *  function words. These appear in prose BY CONSTRUCTION ("give *me* their
 *  email", "*the* report"), so unlike the open categories below they can never
 *  be a deliberate single-token reference to a person or org. Exported
 *  separately because the prefetch MATCHER excludes exactly this subset as
 *  fuzzy name/org evidence (`isProseFunctionWord`): a derived contact named
 *  "Me" (a calendar organizer display name) must not surface on everyday
 *  phrasing, while a contact named "Bob" or "April" — open-category words
 *  below — must keep matching a deliberate first-name mention. The full
 *  `COMMON_SINGLE_TOKEN_WORDS` (which composes this set) keeps gating the
 *  SEED side, where the calculus is over-aliasing prose, not match evidence. */
export const PROSE_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  // ── High-frequency two-letter function words (over-aliasing one of these in
  //    prose is severe — "do *it*", "*in* the office" — so withhold them even
  //    though a contact/org literally named "It"/"In" is vanishingly rare) ──
  'of', 'to', 'in', 'on', 'at', 'by', 'an', 'or', 'as', 'is', 'be', 'we', 'he',
  'do', 'go', 'so', 'no', 'my', 'me', 'us', 'if', 'it', 'up', 'am', 'ok', 'hi',

  // ── Pronouns / determiners / conjunctions / prepositions / auxiliaries /
  //    interrogatives — the genuinely CLOSED classes only. Open-class members
  //    of the historical mixed block (nouns/verbs/adjectives like "day",
  //    "see", "new") are NOT here — they stay seed-gated in the full common
  //    list below but remain MATCHABLE ("Day" is a real surname). ──
  'the', 'and', 'for', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was',
  'one', 'our', 'out', 'has', 'him', 'his', 'how',
  'now', 'two', 'who', 'did', 'its', 'let',
  'she', 'too', 'this', 'that', 'with', 'they', 'them', 'then',
  'than', 'here', 'there', 'when', 'what', 'which', 'were', 'your', 'from',
  'into', 'over', 'some', 'such', 'only', 'same', 'each', 'both', 'most',
  'other', 'about', 'after', 'again', 'these', 'those', 'their', 'would',
  'could', 'should', 'where', 'while', 'because', 'before', 'between',
]);

/** High-frequency everyday English words — the single-token values withheld
 *  from the alias seed. Lower-cased; the Set dedupes the category overlaps. Kept
 *  intentionally curated (common, not exhaustive-dictionary) so a DISTINCTIVE
 *  single-token name/org is never accidentally filtered — see the module note. */
export const COMMON_SINGLE_TOKEN_WORDS: ReadonlySet<string> = new Set([
  // ── The closed function-word classes (also the matcher's exclusion set) ──
  ...PROSE_FUNCTION_WORDS,

  // ── Open-class members of the historical mixed block — seed-gated like
  //    every common word, but NOT in `PROSE_FUNCTION_WORDS` (each can be a
  //    real name: "Day", "New", "Way") so the matcher keeps them as evidence ──
  'day', 'get', 'man', 'new', 'old', 'see', 'way', 'boy', 'put', 'say', 'use',

  // ── Days / months / seasons (calendar words double as given names) ──
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'spring', 'summer', 'fall', 'autumn', 'winter',
  'today', 'tomorrow', 'yesterday', 'morning', 'noon', 'evening', 'night',

  // ── Common given-name-words (a name that is also an everyday word) ──
  'will', 'mark', 'grace', 'hope', 'rose', 'bill', 'art', 'joy', 'dawn',
  'faith', 'daisy', 'bob', 'pat', 'sunny', 'lily', 'ivy', 'holly', 'iris',
  'fern', 'olive', 'ruby', 'pearl', 'jade', 'amber', 'crystal', 'angel',
  'destiny', 'honor', 'patience', 'charity', 'sage', 'star', 'rain', 'sky',
  'storm', 'jasmine', 'violet', 'heather', 'robin', 'jay', 'wren', 'frank',
  'rich', 'guy', 'earl', 'duke', 'king', 'dean', 'miles',

  // ── Single-word brand-words that are everyday words (the "Gap" class) ──
  'gap', 'apple', 'square', 'box', 'block', 'mint', 'oracle', 'slack',
  'discord', 'amazon', 'meta', 'bond', 'anchor', 'bench', 'notion', 'stripe',
  'shell', 'shield', 'target', 'shop', 'store', 'base', 'camp', 'prime',
  'echo', 'lens', 'drive', 'sun', 'orange', 'patch', 'spark', 'flow', 'loop',
  'wave', 'pulse', 'core', 'edge', 'cloud', 'forge', 'beam', 'atlas',

  // ── Common everyday nouns ──
  'time', 'year', 'work', 'life', 'home', 'house', 'room', 'door', 'place',
  'world', 'hand', 'part', 'end', 'side', 'name', 'word', 'line', 'point',
  'group', 'case', 'fact', 'idea', 'plan', 'team', 'note', 'list', 'page',
  'site', 'link', 'data', 'file', 'mail', 'call', 'deal', 'cost', 'price',
  'rate', 'value', 'order', 'money', 'power', 'light', 'sound', 'music',
  'book', 'story', 'news', 'water', 'fire', 'air', 'earth', 'wind', 'snow',
  'moon', 'sea', 'lake', 'tree', 'wood', 'stone', 'gold', 'glass', 'paper',
  'food', 'bread', 'milk', 'wine', 'tea', 'coffee', 'thing', 'friend',
  'family', 'child', 'people', 'person', 'number', 'reason', 'result',
  'change', 'color', 'help', 'love', 'mind', 'body', 'head', 'face', 'eye',
  'foot', 'heart', 'voice', 'word', 'road', 'city', 'town', 'street',

  // ── Common verbs ──
  'make', 'take', 'come', 'give', 'find', 'know', 'look', 'want', 'need',
  'feel', 'tell', 'seem', 'turn', 'keep', 'hold', 'show', 'hear', 'play',
  'move', 'live', 'meet', 'send', 'read', 'open', 'walk', 'talk', 'wait',
  'send', 'pay', 'win', 'buy', 'sell', 'send', 'stop', 'start', 'build',
  'lead', 'grow', 'pass', 'fall', 'rise', 'lose', 'plan', 'work', 'call',
  'help', 'love', 'like', 'mark', 'note', 'ship', 'sign', 'join', 'save',

  // ── Common adjectives ──
  'big', 'small', 'long', 'high', 'low', 'good', 'bad', 'great', 'fine',
  'nice', 'fair', 'full', 'hot', 'cold', 'warm', 'cool', 'hard', 'soft',
  'fast', 'slow', 'easy', 'free', 'rich', 'poor', 'true', 'real', 'open',
  'clear', 'dark', 'deep', 'wide', 'sharp', 'clean', 'safe', 'right',
  'wrong', 'whole', 'ready', 'sure', 'best', 'next', 'last', 'first',
]);

/** Commonness lookup key: trim, strip leading/trailing NON-alphanumeric
 *  (Unicode-aware), lower-case. So a store value carrying trailing punctuation
 *  (`Gap.`, `(Gap)`) still resolves to its bare word and is caught — the gate
 *  can't be bypassed by a stray period. INTERNAL punctuation is kept, so a
 *  distinctive `O'Brien` / `Coca-Cola` is NOT collapsed to a common word. */
const commonnessKey = (value: string): string =>
  value
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .toLowerCase();

/** Is `value` a SINGLE-token common English word (any case)? When true the
 *  prefetch seed is withheld (the B4 commonness filter, design §5). A value with
 *  internal whitespace is multi-token → always seedable (returns false), so this
 *  never touches a "First Last" name or "Acme Corp" org (D3 keeps those precise).
 *  Edge punctuation is stripped before the lookup (`Gap.` → `gap`); the lower-case
 *  key honours "any case" (`GAP` / `Gap` / `gap` all match). Empty / non-string →
 *  false. (The separate too-short-to-seed guard lives in `shouldSeedEntityValue`,
 *  not here — a single char isn't a "common word", but it must not seed either.) */
export const isCommonSingleTokenWord = (value: string): boolean => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false;
  return COMMON_SINGLE_TOKEN_WORDS.has(commonnessKey(trimmed));
};

/** Is `value` a grammatically-closed prose FUNCTION word ("me", "the", "it")?
 *  The prefetch matcher's exclusion predicate: such a token in a query is
 *  prose mechanics, never a deliberate name/org reference, so it contributes
 *  NOTHING as fuzzy match evidence — while the open categories of
 *  `COMMON_SINGLE_TOKEN_WORDS` (given-name-words "Bob"/"Pat", calendar words
 *  "April", brand words "Gap") stay matchable, because a user typing one CAN
 *  mean the contact/org. Same key normalisation as the seed-side predicate. */
export const isProseFunctionWord = (value: string): boolean => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false;
  return PROSE_FUNCTION_WORDS.has(commonnessKey(trimmed));
};

/** Should this name/org value SEED the alias ledger? The positive form of the
 *  B4 gate, read at every seed site (the production `toPrefetchEntityRecord` and
 *  the §6.1 measurement harness — one shared contract). Seed UNLESS the value is
 *  empty, a bare SINGLE CHARACTER, or a single-token common word. Multi-token
 *  (D3) + distinctive single tokens (Datadog/Twilio) seed; common single words
 *  (Will/Gap) do not. The single-character guard is load-bearing: a 1-char value
 *  (`X`, `A`) seeded into the ledger would make `scanContent` alias EVERY
 *  occurrence of that character in prose — catastrophic over-alias, far worse
 *  than the missed protection of one low-identifying char. */
export const shouldSeedEntityValue = (value: string): boolean => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  // Multi-token (internal whitespace) — full-value containment keeps it precise
  // (D3), so always seed regardless of any component word's commonness.
  if (/\s/.test(trimmed)) return true;
  const key = commonnessKey(trimmed);
  if ([...key].length <= 1) return false; // bare single char (or all-punctuation)
  return !COMMON_SINGLE_TOKEN_WORDS.has(key);
};
