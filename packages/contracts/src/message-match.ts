/** D-192 messenger flagship (M2) — the canonical tag / mention / content
 *  MATCHER over an inbound chat message. Pure deterministic logic; no IO,
 *  no LLM (taxonomy § 3a: a match is a DETERMINISTIC trigger — the matched
 *  message becomes a `message` COMMITMENT_EVIDENCE_KIND snapshot inline at
 *  trigger time; an optional AI-paraphrase layer sits ABOVE this, never
 *  inside it). Same-inputs → same-output is load-bearing (the matcher is
 *  the shared substrate for the M4 evidence funnel AND, later, a reactive
 *  `message_match` trigger).
 *
 *  This is the first substrate to read a chat message's CONTENT — today's
 *  trigger layer only binds a conversation id (`wire-messenger-turn.ts`)
 *  or filters the bus record by strict scalar equality (`trigger-sugar.ts`
 *  `matchesTriggerDispatchFilter`); nothing tokenized `#tags` / `@mentions`
 *  / keywords out of the text. Named `MessageMatch*` to stay disjoint from
 *  the unrelated `contact_topic_mention` trigger (an AI-EXTRACTION event
 *  keyed on `subject_contact_id` + topic — not a chat @mention).
 *
 *  Structure mirrors `contact-match.ts` (`evaluate*Match` accumulating
 *  `matched_*`, private `matches*` helpers). Vocabulary aligns with the
 *  `contains` condition operator (`conditions.ts`), but content matching
 *  here is CASE-INSENSITIVE by design — a chat intent signal ("I'll send")
 *  should not be case-sensitive, unlike the recipe `contains` operator.
 *
 *  Spec: `docs/d-192-kinds-taxonomy.md` § 3a (M-1). */

// ────────────────────────────────────────────────────────────────
// Closed enums + caps (fail-closed bounds)
// ────────────────────────────────────────────────────────────────

/** Pattern family — the discriminator on `MessageMatchPattern`.
 *   - `tag`     — a `#hashtag` token (convention-driven; e.g. `#commit`).
 *   - `mention` — an `@handle` token, or a Slack-encoded `<@USERID>`
 *     (matched on the user id); the sender-identity resolution is the M3
 *     linker's job — this only matches the token.
 *   - `content` — a keyword/phrase in the body (case-insensitive). */
export const MESSAGE_MATCH_KINDS = ['tag', 'mention', 'content'] as const;
export type MessageMatchKind = (typeof MESSAGE_MATCH_KINDS)[number];
export const MESSAGE_MATCH_KIND_SET: ReadonlySet<string> = new Set(MESSAGE_MATCH_KINDS);

/** Content-match sub-mode.
 *   - `contains` (default) — case-insensitive substring.
 *   - `word`     — case-insensitive WHOLE-WORD match (`commit` matches
 *     "please commit" but not "committed"). */
export const MESSAGE_CONTENT_MATCH_MODES = ['contains', 'word'] as const;
export type MessageContentMatchMode = (typeof MESSAGE_CONTENT_MATCH_MODES)[number];
export const MESSAGE_CONTENT_MATCH_MODE_SET: ReadonlySet<string> = new Set(
  MESSAGE_CONTENT_MATCH_MODES,
);

/** Max declared patterns evaluated in one `matchMessage` call — a runaway
 *  pattern list is truncated (fail-closed; the extras never silently cost
 *  unbounded regex work). */
export const MESSAGE_MATCH_MAX_PATTERNS = 64;

/** Max chars of a single pattern's `value`. */
export const MESSAGE_MATCH_PATTERN_VALUE_MAX = 128;

/** Max chars of message text the matcher scans — longer text is truncated
 *  for matching (a chat message is short by nature; this bounds the regex
 *  work on a pathological body). */
export const MESSAGE_MATCH_TEXT_SCAN_MAX = 4096;

/** The messenger-connection `config_json` field that holds the declared
 *  `MessageMatchPattern[]` (M4). The single source of truth for the key —
 *  the wire reads it, the connection-write path validates it, and the
 *  resolver view reserves it (`CONNECTION_VIEW_RESERVED_FIELDS`). */
export const MESSAGE_MATCH_CONFIG_KEY = 'match_patterns';

// ────────────────────────────────────────────────────────────────
// Pattern + projection + result shapes
// ────────────────────────────────────────────────────────────────

export interface MessageTagPattern {
  kind: 'tag';
  /** The tag token to match (a leading `#` is stripped forgivingly, so
   *  both `commit` and `#commit` match `#commit`). Case-insensitive. */
  value: string;
}

export interface MessageMentionPattern {
  kind: 'mention';
  /** The handle / Slack user id to match (a leading `@` is stripped
   *  forgivingly). Case-insensitive. */
  value: string;
}

export interface MessageContentPattern {
  kind: 'content';
  /** The keyword / phrase to match, case-insensitive. */
  value: string;
  /** Match mode — defaults to `contains`. */
  mode?: MessageContentMatchMode;
}

/** One declared match pattern — a `kind`-discriminated union. */
export type MessageMatchPattern =
  | MessageTagPattern
  | MessageMentionPattern
  | MessageContentPattern;

/** The canonical projection of an inbound chat message — the shared input
 *  vocabulary for the matcher (M2) and the evidence funnel (M4). The
 *  MATCHER reads only `text` + the optional structured `tags` / `mentions`
 *  (when a per-vendor projector — M1 — supplies them; else they are
 *  derived from `text`). `vendor` / `sender` / `sent_at` / `permalink` are
 *  carried for the downstream `message` evidence capture. */
export interface MessageProjection {
  /** The messenger vendor slug (`slack` / `telegram` / …). */
  vendor: string;
  /** The sender's platform-native id (`ParsedInbound.from`). */
  sender: string;
  /** The message text — the matcher's primary input. */
  text: string;
  /** When the message was sent (unix-ms), when the payload carries it. */
  sent_at?: number;
  /** A permalink to the source message, when composable. */
  permalink?: string;
  /** Structured hashtags, when a per-vendor projector (M1) extracted them;
   *  else the matcher derives tags from `text`. */
  tags?: readonly string[];
  /** Structured mentions (handles / ids), when a per-vendor projector
   *  (M1) extracted them; else the matcher derives mentions from `text`. */
  mentions?: readonly string[];
}

/** One matched pattern + what it matched (for evidence, audit, and
 *  highlighting). */
export interface MessageMatch {
  pattern: MessageMatchPattern;
  /** What matched. For `tag` / `mention` — the CANONICAL normalized token
   *  (`#commit` / `@anna`; lower-cased + NFC), a stable identity regardless
   *  of the text's casing/encoding. For `content` — the actual-case
   *  substring as it appeared in the NFC-normalized text (for highlight /
   *  snippet). */
  matched: string;
}

// ────────────────────────────────────────────────────────────────
// Tokenizer — pure, unicode-aware
// ────────────────────────────────────────────────────────────────

// Canonical token grammar — ONE definition shared by the tokenizer AND the
// validator (so a declared pattern that could never tokenize is caught at
// declare time). A token STARTS with a letter/number/underscore and
// CONTINUES with those plus COMBINING MARKS (`\p{M}`): a mark continues a
// token in decomposed (NFD) scripts but never starts one. All text and
// pattern values are NFC-normalized before matching, so precomposed (`café`)
// and decomposed (`cafe`+combining-acute) forms behave identically.
const TOKEN_START_CLASS = '[\\p{L}\\p{N}_]';
const TOKEN_CONT_CLASS = '[\\p{L}\\p{N}\\p{M}_]';

/** A single canonical tag/mention token, anchored — used by the validator to
 *  reject an un-matchable declared value (`foo-bar`, `two words`). NFC the
 *  value before testing. */
const MESSAGE_TOKEN_GRAMMAR_RE = new RegExp(`^${TOKEN_START_CLASS}${TOKEN_CONT_CLASS}*$`, 'u');

/** A `#tag` — `#` NOT preceded by a token char (so `C#`, `a#b`, email tails,
 *  and a `#` right after a combining mark never tokenize; `#a#b` yields only
 *  `a`, per hashtag convention), followed by a token. */
const TAG_RE = new RegExp(`(?<!${TOKEN_CONT_CLASS})#(${TOKEN_START_CLASS}${TOKEN_CONT_CLASS}*)`, 'gu');

/** An `@mention` — `@` NOT preceded by a token char (so `user@host` emails
 *  never tokenize), followed by a token. Also captures the id inside a
 *  Slack-encoded mention (`<@U123>` / `<@U123|name>`): the `@` is preceded by
 *  `<` (a non-token char), so the id captures up to the `>` / `|`. */
const MENTION_RE = new RegExp(`(?<!${TOKEN_CONT_CLASS})@(${TOKEN_START_CLASS}${TOKEN_CONT_CLASS}*)`, 'gu');

export interface MessageTokens {
  tags: string[];
  mentions: string[];
}

/** Canonicalize a token for case-insensitive, encoding-stable comparison:
 *  trim → NFC → lower-case. */
const normalizeToken = (token: string): string => token.trim().normalize('NFC').toLowerCase();

/** Strip ONE leading `#` / `@` sigil if present (forgiving pattern authoring
 *  — a user may write `#commit` or `commit`). */
const stripSigil = (sigil: '#' | '@', value: string): string =>
  value.startsWith(sigil) ? value.slice(1) : value;

/** NFC-normalize + scan-cap a message's text (the one place the scan bound is
 *  applied). Cap FIRST to bound the normalization work on a pathological body,
 *  then normalize the bounded slice. */
const normalizeScan = (text: string): string =>
  text.slice(0, MESSAGE_MATCH_TEXT_SCAN_MAX).normalize('NFC');

/** Tokenize already-normalized (NFC + scan-capped) text. */
const tokenizeNormalized = (scan: string): MessageTokens => {
  const tags = new Set<string>();
  const mentions = new Set<string>();
  for (const m of scan.matchAll(TAG_RE)) tags.add(normalizeToken(m[1]));
  for (const m of scan.matchAll(MENTION_RE)) mentions.add(normalizeToken(m[1]));
  return { tags: [...tags], mentions: [...mentions] };
};

/** Extract the distinct, canonical `#tags` and `@mentions` from a message's
 *  text. Deterministic; NFC-normalized; scans at most
 *  `MESSAGE_MATCH_TEXT_SCAN_MAX` chars. */
export const tokenizeMessageText = (text: string): MessageTokens =>
  tokenizeNormalized(normalizeScan(text));

// ────────────────────────────────────────────────────────────────
// Matcher — pure, OR semantics across patterns
// ────────────────────────────────────────────────────────────────

/** Escape a string for literal use inside a `RegExp`. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Fail-closed guard on a runtime pattern `value` — `matchMessage` is
 *  exported SEPARATELY from the validator, so an unvalidated pattern must
 *  never (a) match everything (empty value), (b) throw (non-string), or (c)
 *  build a pathological `RegExp` (over-cap value). Returns the trimmed value
 *  iff it is a non-empty string ≤ the cap; else `undefined` → the caller
 *  SKIPS the pattern. */
const sanitizePatternValue = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MESSAGE_MATCH_PATTERN_VALUE_MAX) return undefined;
  return trimmed;
};

/** Match a sanitized `content` value against the NFC-normalized scan text,
 *  returning the actual-case matched substring or `undefined`. An unknown
 *  `mode` fails closed (skip). */
const matchContent = (
  value: string,
  mode: MessageContentMatchMode | undefined,
  scanText: string,
): string | undefined => {
  if (mode !== undefined && !MESSAGE_CONTENT_MATCH_MODE_SET.has(mode)) return undefined;
  const needle = value.normalize('NFC');
  if (mode === 'word') {
    // Case-insensitive whole-word: the value bounded by non-token chars.
    const re = new RegExp(`(?<!${TOKEN_CONT_CLASS})${escapeRegExp(needle)}(?!${TOKEN_CONT_CLASS})`, 'iu');
    const m = re.exec(scanText);
    return m ? m[0] : undefined;
  }
  const idx = scanText.toLowerCase().indexOf(needle.toLowerCase());
  return idx >= 0 ? scanText.slice(idx, idx + needle.length) : undefined;
};

/** Evaluate a single pattern; returns the matched token/substring or
 *  `undefined`. Fail-closed on an invalid runtime `value`. */
const matchOne = (
  pattern: MessageMatchPattern,
  tagSet: ReadonlySet<string>,
  mentionSet: ReadonlySet<string>,
  scanText: string,
): string | undefined => {
  // Fail-closed on a non-object member (`null` / primitive) BEFORE any field
  // access — `matchMessage` accepts unvalidated input, so a malformed member
  // must skip, never throw (`typeof null === 'object'`, hence the null check).
  if (pattern === null || typeof pattern !== 'object') return undefined;
  const value = sanitizePatternValue((pattern as { value?: unknown }).value);
  if (value === undefined) return undefined;
  switch (pattern.kind) {
    case 'tag': {
      const bare = normalizeToken(stripSigil('#', value));
      return bare.length > 0 && tagSet.has(bare) ? `#${bare}` : undefined;
    }
    case 'mention': {
      const bare = normalizeToken(stripSigil('@', value));
      return bare.length > 0 && mentionSet.has(bare) ? `@${bare}` : undefined;
    }
    case 'content':
      return matchContent(value, pattern.mode, scanText);
    default:
      return undefined;
  }
};

/** Canonicalize a projection-supplied or derived token so both compare on the
 *  same basis as pattern values — strip a leading sigil (a projector may emit
 *  `#tag` or bare `tag`) then normalize (NFC + lower). Idempotent on the
 *  already-bare derived tokens. */
const canonProjectionTag = (token: string): string => normalizeToken(stripSigil('#', token));
const canonProjectionMention = (token: string): string => normalizeToken(stripSigil('@', token));

/** Match a declared pattern set against a projected message — OR semantics
 *  (every pattern that matches is returned, in pattern order; empty = no
 *  match). Prefers the projection's structured `tags` / `mentions` when
 *  present — an explicit `[]` means "the projector found none" and suppresses
 *  text derivation (the projector is authoritative); `undefined` derives from
 *  `text`. Deterministic and side-effect-free. Evaluates at most
 *  `MESSAGE_MATCH_MAX_PATTERNS`. */
export const matchMessage = (
  patterns: readonly MessageMatchPattern[],
  projection: MessageProjection,
): MessageMatch[] => {
  const results: MessageMatch[] = [];
  if (patterns.length === 0) return results;

  const scanText = normalizeScan(projection.text);
  const derived = tokenizeNormalized(scanText);
  const tagSet = new Set((projection.tags ?? derived.tags).map(canonProjectionTag));
  const mentionSet = new Set((projection.mentions ?? derived.mentions).map(canonProjectionMention));

  for (const pattern of patterns.slice(0, MESSAGE_MATCH_MAX_PATTERNS)) {
    const matched = matchOne(pattern, tagSet, mentionSet, scanText);
    if (matched !== undefined) results.push({ pattern, matched });
  }
  return results;
};

/** True iff any declared pattern matches — the cheap boolean the M4 funnel
 *  and a reactive trigger gate on. */
export const messageMatches = (
  patterns: readonly MessageMatchPattern[],
  projection: MessageProjection,
): boolean => matchMessage(patterns, projection).length > 0;

// ────────────────────────────────────────────────────────────────
// Validation — human-readable problems (empty = well-formed), the
// contracts idiom (`trigger-sugar.ts` `validateEventTrigger`).
// ────────────────────────────────────────────────────────────────

/** Validate one declared pattern. Returns human-readable problems (empty =
 *  well-formed). Pure + registry-free so the portable recipe validator and
 *  the server share ONE rule set. */
export const validateMessageMatchPattern = (
  pattern: MessageMatchPattern,
  path = 'pattern',
): string[] => {
  const problems: string[] = [];
  if (pattern === null || typeof pattern !== 'object') {
    problems.push(`${path} must be an object`);
    return problems; // not even a shape — nothing else to check
  }
  if (!MESSAGE_MATCH_KIND_SET.has(pattern.kind)) {
    problems.push(`${path}.kind must be one of ${MESSAGE_MATCH_KINDS.join('|')}`);
    return problems; // shape unknown — no point validating the rest
  }
  const value: unknown = (pattern as { value?: unknown }).value;
  if (typeof value !== 'string' || value.trim().length === 0) {
    problems.push(`${path}.value must be a non-empty string`);
  } else if (value.length > MESSAGE_MATCH_PATTERN_VALUE_MAX) {
    problems.push(`${path}.value must be <= ${MESSAGE_MATCH_PATTERN_VALUE_MAX} chars`);
  } else if (pattern.kind === 'tag' || pattern.kind === 'mention') {
    const bare = stripSigil(pattern.kind === 'tag' ? '#' : '@', value.trim()).normalize('NFC');
    if (bare.length === 0) {
      problems.push(`${path}.value must carry a ${pattern.kind} token after the sigil`);
    } else if (!MESSAGE_TOKEN_GRAMMAR_RE.test(bare)) {
      // Reject a value the tokenizer could never produce (e.g. `foo-bar`,
      // `two words`) — it would declare a dead trigger.
      problems.push(
        `${path}.value for a ${pattern.kind} must be a single token `
        + '(letters / numbers / marks / underscore — no whitespace or punctuation)',
      );
    }
  }
  if (
    pattern.kind === 'content' &&
    pattern.mode !== undefined &&
    !MESSAGE_CONTENT_MATCH_MODE_SET.has(pattern.mode)
  ) {
    problems.push(`${path}.mode must be one of ${MESSAGE_CONTENT_MATCH_MODES.join('|')}`);
  }
  return problems;
};

/** Validate a declared pattern SET (the cap + each member). Returns
 *  human-readable problems (empty = well-formed). */
export const validateMessageMatchPatterns = (
  patterns: readonly MessageMatchPattern[],
): string[] => {
  // Return EARLY on an over-cap array — do NOT then enumerate a per-member
  // problem for each of (potentially thousands of) elements. This bounds both
  // the validation work and the joined error message a caller builds from the
  // result (a 10k-element array yields ONE problem, not 10k+1).
  if (patterns.length > MESSAGE_MATCH_MAX_PATTERNS) {
    return [`at most ${MESSAGE_MATCH_MAX_PATTERNS} patterns (got ${patterns.length})`];
  }
  const problems: string[] = [];
  patterns.forEach((pattern, i) => {
    problems.push(...validateMessageMatchPattern(pattern, `patterns[${i}]`));
  });
  return problems;
};
