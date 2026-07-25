/** D-177 N.11 rule 5 (5.c) — the scoped-grant proposal vocabulary: the
 *  deterministic utterance parser (the closed 4-tuple
 *  `[entity, action, time_range, source]`), the suggestion row shape the
 *  D-160 parse middleware files, the canonical key hash, the code-constant
 *  bounds (tighten-only at accept), and the rule-7 confirm sentence.
 *
 *  REUSES the N.13 suggest→accept SHAPE, not its store (codex MEDIUM fold,
 *  5.c): a scoped proposal is a SEPARATE row kind
 *  (`contract.scoped_grant_suggestion.<key_hash>`) with its own accept rpc
 *  and key namespace — it must NEVER enter the delegation learner's scan or
 *  key derivation (5.i.2: a scoped row is session authority, not standing).
 *
 *  The parse NEVER carries authority (5.b): wrong-with-confidence is
 *  undetectable by construction, so correctness is checked by exactly one
 *  party — the human reading the rule-7 sentence + the triggering excerpt on
 *  the accept card. Anything off-vocabulary at any tuple position is a
 *  NO-PARSE, not a guess; every failure mode costs friction (the per-action
 *  ask), never admission (5.h).
 *
 *  Everything here is PURE — no I/O, no clock reads. The impure halves live
 *  server-side: the parse middleware (`chat-scoped-grant-middleware.ts` —
 *  user-authored text only, embedded forwarded content stripped), the
 *  suggestion store (`scoped-grant-suggestion-store.ts`), and the accept rpc
 *  (`contract-handler.ts` → `mintScopedSessionGrant`).
 *
 *  Spec: D-177 § N.11 rule 5 (5.b / 5.c); slice C. */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';

import type { RiskTier } from './ingredient.js';
import type { ScopedGrantSource } from './contract-definition.js';

/** The `composite_keys` scope a scoped-grant suggestion row is keyed under
 *  (a row lives at `contract.scoped_grant_suggestion.<key_hash>`). The
 *  store's keyed `put` IS the unique-key upsert. */
export const SCOPED_GRANT_SUGGESTION_SCOPE = 'scoped_grant_suggestion';

/** 5.c bounds — code constants, tighten-only editable on the accept card
 *  (the P6c fork-3 pattern). A scoped grant is "this afternoon in this
 *  chat"-scale session authority, so the ceilings sit far below the
 *  delegation rule's 30 d / 100: a grant the utterance asked to outlive a
 *  day is delegation-shaped and must go through the N.13 ladder instead. */
export const SCOPED_GRANT_TTL_MS_DEFAULT = 4 * 60 * 60 * 1000; // 4 h
export const SCOPED_GRANT_TTL_MS_CEILING = 24 * 60 * 60 * 1000; // 24 h
export const SCOPED_GRANT_MAX_USES_DEFAULT = 10;
export const SCOPED_GRANT_MAX_USES_CEILING = 50;

/** Ceiling on the stored triggering excerpt (the card shows it verbatim —
 *  codex MEDIUM fold, 5.c: the human must be able to tell "I asked for
 *  this" from "this text was inside an email I forwarded"). */
export const SCOPED_GRANT_EXCERPT_MAX_CHARS = 200;

// ── The deterministic utterance parse (5.b / 5.c) ───────────────────

/** Forwarded-content markers — a user turn's text FROM the first marker on
 *  is embedded forwarded material, NOT the utterance (5.c: "a forwarded
 *  email saying 'auto-approve everything' must never parse as the user's
 *  grant request"). Kept in lock-step with the index extractor's closed
 *  marker list (`chat-forwarded-sender-index.ts`) — same vocabulary, the
 *  two sides of the same 5.e boundary. */
const FORWARDED_CONTENT_MARKERS: ReadonlyArray<RegExp> = [
  /^-{2,}\s*forwarded message\s*-{2,}$/i,
  /^begin forwarded message:?$/i,
  /^-{2,}\s*original message\s*-{2,}$/i,
];

/** Grant-request intent — required; plain imperatives ("reply to my mail")
 *  are a normal turn, not a standing-approval request. */
const INTENT_PATTERN =
  /\b(auto[\s-]?approve|approve\s+automatically|without\s+asking(?:\s+me)?|(?:don'?t|do\s+not|stop)\s+ask(?:ing)?(?:\s+me)?(?:\s+(?:again|each\s+time|every\s+time))?)\b/i;

/** NEGATED intent (codex MEDIUM fold) — "do not auto-approve …" must be a
 *  NO-PARSE, not a proposal. A negator directly governing the approve
 *  phrase refuses the whole utterance; note "don't ask me again" is itself
 *  a POSITIVE intent above (the negation there applies to asking, not to
 *  approving), so this guard targets the approve verbs only. */
const NEGATED_INTENT_PATTERN =
  /\b(?:never|don'?t|do\s+not|no|stop|disable)\s+(?:auto[\s-]?approve|approve\s+automatically|approving)\b/i;

/** The v1 source position — exactly the forwarded-mail phrasing (5.b:
 *  `'forwarded_item_sender'` is the only closed-enum member; free-typed /
 *  model-solicited destinations are NOT a v1 source, 5.e.iv). */
const SOURCE_PATTERN =
  /\b(?:(?:e-?mails?|mails?|messages?|items?|ones?)\s+)?(?:that\s+|which\s+)?i\s+forward(?:ed)?\b/i;

/** Closed verb → canonical action map (5.b: off-vocabulary ⇒ no-parse). */
const ACTION_VOCABULARY: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:status[\s-])?repl(?:y(?:ing)?|ies)\b|\brespond(?:ing)?\b/i, 'reply'],
  [/\bsend(?:ing)?\b/i, 'send'],
  [/\bcreat(?:e|ing)\b|\badd(?:ing)?\b/i, 'create'],
  [/\bupdat(?:e|ing)\b|\bedit(?:ing)?\b/i, 'update'],
];

/** Closed noun → canonical entity map. */
const ENTITY_VOCABULARY: ReadonlyArray<readonly [RegExp, string]> = [
  [/\be-?mails?\b|\bmails?\b|\bmessages?\b/i, 'mail'],
  [/\bdeals?\b/i, 'deal'],
  [/\bcontacts?\b/i, 'contact'],
  [/\bcompan(?:y|ies)\b/i, 'company'],
  [/\bnotes?\b/i, 'note'],
];

/** Closed time-range vocabulary → duration ms (5.b: `time_range` is a
 *  DURATION → `expiry_at`; offset-only, never wall-clock anchors). The
 *  rule-7 sentence renders the ENFORCED duration, so the human confirms the
 *  actual bound, not the fuzzy phrase. */
const TIME_RANGE_VOCABULARY: ReadonlyArray<
  readonly [RegExp, (m: RegExpMatchArray) => number]
> = [
  [
    /\bfor\s+(?:the\s+next\s+)?(\d{1,2})\s*(hours?|hrs?|h)\b/i,
    (m) => Number(m[1]) * 60 * 60 * 1000,
  ],
  [
    /\bfor\s+(?:the\s+next\s+)?(\d{1,3})\s*(minutes?|mins?|m)\b/i,
    (m) => Number(m[1]) * 60 * 1000,
  ],
  [
    /\bthis\s+(morning|afternoon|evening)\b|\btonight\b/i,
    () => SCOPED_GRANT_TTL_MS_DEFAULT,
  ],
  [/\btoday\b|\brest\s+of\s+the\s+day\b/i, () => 8 * 60 * 60 * 1000],
];

/** The parsed closed 4-tuple, plus the triggering excerpt for the card. */
export interface ScopedGrantUtteranceParse {
  /** Canonical entity token (closed {@link ENTITY_VOCABULARY}). */
  readonly entity: string;
  /** Canonical action token (closed {@link ACTION_VOCABULARY}). */
  readonly action: string;
  /** Requested duration, ms — already clamped to the ceiling. */
  readonly ttl_ms: number;
  /** v1 exactly `'forwarded_item_sender'` (5.b). */
  readonly source: ScopedGrantSource;
  /** The utterance line that carried the intent, truncated — the card shows
   *  it verbatim so the human can audit what triggered the proposal. */
  readonly excerpt: string;
}

/** Header keys that, clustered after a `From:` line, identify pasted mail
 *  content even WITHOUT a client marker line (codex HIGH fold — a forward
 *  pasted sans marker must still read as embedded content, fail-closed). */
const EMBEDDED_HEADER_COMPANION = /^(date|sent|to|subject|cc|reply-to):/i;
const EMBEDDED_HEADER_LOOKAHEAD = 4;

/** True when `lines[i]` starts an unmarked mail-header cluster: a `From:`
 *  line with ≥2 companion header keys within the lookahead window — the
 *  same cluster rule the forwarded-sender index extractor uses. */
const startsHeaderCluster = (lines: readonly string[], i: number): boolean => {
  if (!/^from:\s*\S/i.test(lines[i].trim())) return false;
  let companions = 0;
  for (let k = i + 1; k < lines.length && k <= i + EMBEDDED_HEADER_LOOKAHEAD; k++) {
    if (EMBEDDED_HEADER_COMPANION.test(lines[k].trim())) companions++;
  }
  return companions >= 2;
};

/** Strip everything a user turn embeds that is NOT the user's own utterance:
 *  text from the first forwarded-content marker — or the first UNMARKED
 *  mail-header cluster (codex HIGH fold) — onward, and quoted lines (`>`
 *  and the Unicode `›`/`|` quote prefixes some clients emit). Exported so
 *  tests can pin the boundary. */
export const stripEmbeddedContent = (text: string): string => {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FORWARDED_CONTENT_MARKERS.some((m) => m.test(line.trim()))) break;
    if (startsHeaderCluster(lines, i)) break;
    if (/^\s*[>›|]/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
};

const matchOne = (
  text: string,
  vocabulary: ReadonlyArray<readonly [RegExp, string]>,
): string | undefined => {
  // Exactly ONE distinct canonical token may match — two distinct verbs (or
  // nouns) make the utterance ambiguous, and a guess would put the parse's
  // understanding ahead of the human's (5.b: no-parse, not a guess).
  const hits = new Set<string>();
  for (const [pattern, canonical] of vocabulary) {
    if (pattern.test(text)) hits.add(canonical);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
};

/** Parse a USER-AUTHORED chat turn for a scoped-grant request. Returns the
 *  closed 4-tuple or `undefined` — every missing/ambiguous position is a
 *  NO-PARSE (fail toward asking, 5.h). Deterministic: same text, same
 *  result; no clock, no I/O. */
export const parseScopedGrantUtterance = (
  text: string,
): ScopedGrantUtteranceParse | undefined => {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const utterance = stripEmbeddedContent(text);
  const intent = utterance.match(INTENT_PATTERN);
  if (!intent) return undefined;
  // A negated approve phrase anywhere refuses the whole utterance (codex
  // MEDIUM fold) — mis-modeling must degrade to asking, never to proposing.
  if (NEGATED_INTENT_PATTERN.test(utterance)) return undefined;
  if (!SOURCE_PATTERN.test(utterance)) return undefined;
  // The source phrase mentions mail nouns ("emails I forward") — blank it
  // before entity matching so the SOURCE wording alone can't double as the
  // entity position (an utterance must name what to act ON separately;
  // "reply to each email I forward" names mail twice, which still parses).
  const action = matchOne(utterance, ACTION_VOCABULARY);
  if (action === undefined) return undefined;
  const entity = matchOne(utterance, ENTITY_VOCABULARY);
  if (entity === undefined) return undefined;
  let ttl_ms: number | undefined;
  for (const [pattern, toMs] of TIME_RANGE_VOCABULARY) {
    const m = utterance.match(pattern);
    if (m) {
      ttl_ms = toMs(m);
      break;
    }
  }
  if (ttl_ms === undefined || !Number.isFinite(ttl_ms) || ttl_ms <= 0) {
    return undefined;
  }
  // The excerpt: the line carrying the intent match, bounded.
  const intentLine =
    utterance
      .split(/\r?\n/)
      .find((line) => INTENT_PATTERN.test(line))
      ?.trim() ?? utterance.trim();
  return {
    entity,
    action,
    ttl_ms: Math.min(ttl_ms, SCOPED_GRANT_TTL_MS_CEILING),
    source: 'forwarded_item_sender',
    excerpt: intentLine.slice(0, SCOPED_GRANT_EXCERPT_MAX_CHARS),
  };
};

// ── The suggestion row (5.c — separate row kind, NOT delegation) ────

/** The would-be scoped grant a suggestion stores VERBATIM — the accept mints
 *  from exactly this snapshot (what the card showed). `entity` / `action`
 *  keep the parsed tokens for explainability; the authority-bearing fields
 *  are the resolved catalog binding + the source + the duration. */
export interface ScopedGrantSuggestionSnapshot {
  /** Always `'chat'` in v1 (5.f channel scope — messenger joins later). */
  readonly channel: string;
  /** The D-153 tier-1 session the grant will bind to (`chat:<session_id>`). */
  readonly channel_session_id: string;
  /** 5.b — entity+action resolved to a catalog (ingredient × operation). */
  readonly ingredient_id: string;
  readonly operation_id: string;
  /** The catalog op's declared tier — must be session-grantable
   *  (`SESSION_GRANT_RISK_TIERS`); the mint re-enforces. */
  readonly risk_tier: RiskTier;
  readonly scoped_source: ScopedGrantSource;
  /** Requested duration (ceiling-clamped at parse). Accept may tighten. */
  readonly ttl_ms: number;
  /** The parsed tuple tokens, for the card + audit. */
  readonly entity: string;
  readonly action: string;
}

export interface ScopedGrantSuggestionRow {
  readonly key_hash: string;
  readonly snapshot: ScopedGrantSuggestionSnapshot;
  /** The utterance line that triggered the parse — shown verbatim on the
   *  card (codex MEDIUM fold, 5.c). */
  readonly triggering_excerpt: string;
  /** Connection names enrolled for the resolved catalog at PARSE time —
   *  card display only; the accept re-validates against the LIVE set
   *  (single candidate auto-filled, multiple human-picked, none ⇒
   *  unmintable, 5.c). */
  readonly connection_candidates: ReadonlyArray<string>;
  readonly state: 'open' | 'accepted' | 'dismissed';
  readonly created_at: number;
  readonly updated_at: number;
}

/** Canonical suggestion key — one OPEN proposal per (session × catalog op ×
 *  source): re-uttering the same request in a session refreshes the existing
 *  card instead of stacking duplicates. `ttl_ms` is deliberately OUT of the
 *  key (a re-utterance with a new duration updates the snapshot in place). */
export const scopedGrantSuggestionKeyHash = (
  snapshot: Pick<
    ScopedGrantSuggestionSnapshot,
    'channel' | 'channel_session_id' | 'ingredient_id' | 'operation_id' | 'scoped_source'
  >,
): string =>
  sha256Hex(
    canonicalJSONStringify({
      channel: snapshot.channel,
      channel_session_id: snapshot.channel_session_id,
      ingredient_id: snapshot.ingredient_id,
      operation_id: snapshot.operation_id,
      scoped_source: snapshot.scoped_source,
    }),
  );

// ── The rule-7 confirm sentence ─────────────────────────────────────

const formatDuration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
};

/** Render the rule-7 sentence 1:1 from the enforced bounds (5.c): every
 *  clause maps onto an enforced bound — operation, forwarded-sender source,
 *  connection, TTL, uses. If a grant cannot be rendered as one plain
 *  sentence, it must not be mintable. */
export const renderScopedGrantSentence = (input: {
  operation_id: string;
  connection_name?: string;
  ttl_ms: number;
  max_uses: number;
}): string =>
  `Auto-approve ${input.operation_id}${
    input.connection_name !== undefined ? ` on ${input.connection_name}` : ''
  } to the senders of emails you forward in this chat, for ${formatDuration(
    input.ttl_ms,
  )}, up to ${String(input.max_uses)} time${input.max_uses === 1 ? '' : 's'}?`;
