/** Prefetch entity resolution — minimal working slice.
 *
 *  `user_prompt → search(warehouse entities) → contribute top-K labeled
 *  candidates to the prompt draft → LLM`. Speculative, zero-harm: weak or
 *  empty results simply aren't injected and the LLM proceeds (calling a
 *  resolution tool itself, as today). The aim is to save a tool-call turn
 *  on the subset where a mentioned entity resolves — not to be correct.
 *
 *  Design: internal design notes
 *
 *  Boundaries:
 *    - Warehouse access is an INJECTED port (`EntitySearchPort`) — the
 *      package stays IO-free per the import boundary; the backend wires a
 *      real adapter at boot (the `DataPresenceProbe` pattern). The no-op
 *      default contributes nothing, so registering prefetch is
 *      behavior-preserving until a real port is wired.
 *    - The `ctx.prompt` accumulator IS the extensibility seam: any future
 *      producer can `contribute` more parts and the orchestrator gathers
 *      them the same way (no registry needed yet — design § knobs).
 *    - PII (D-167 N.10.1) + read-scope (D-157) are enforced by the wiring
 *      layer. The prefetch surfaces warehouse contacts, so it contributes a
 *      STRUCTURED `entity` part (raw records + a `render`), NOT pre-rendered
 *      text: a free-text line carries no entity label the privacy resolver
 *      could see, so the egress gather aliases the payload against the turn's
 *      shared ledger and THEN renders — the model sees aliases, and the same
 *      contact renders to the same alias everywhere it appears. This package
 *      shapes + renders candidates; it never touches the privacy marker
 *      itself (the gather stamps it). The injected search must honour the
 *      turn's scope fence.
 */

import type { TurnContext } from '@recued/middleware';

import { shouldSeedEntityValue } from './common-words.js';

export {
  COMMON_SINGLE_TOKEN_WORDS,
  PROSE_FUNCTION_WORDS,
  isCommonSingleTokenWord,
  isProseFunctionWord,
  shouldSeedEntityValue,
} from './common-words.js';

/** A resolved entity candidate the prefetch surfaces to the turn. */
export interface PrefetchCandidate {
  /** Stable key (canonical email / entity id) — lets the LLM act on the
   *  exact record without a second resolution hop. */
  readonly ref: string;
  /** Human-facing name shown in the labeled block. */
  readonly label: string;
  /** Entity kind — `'contact' | 'company' | 'deal' | …`. */
  readonly kind: string;
  /** Search relevance, higher = better. Used for the inject floor + cap. */
  readonly score: number;
  /** Optional canonical phone (E.164) of the resolved contact. NOT
   *  rendered into the prompt — carried only so the egress gather can
   *  alias it into the turn's shared ledger (the `contact` entity-privacy
   *  tag stamps `phone`). That seeds the ledger BEFORE egress, so a phone
   *  the USER typed (and that rides in tool args) is aliased by the same
   *  D-167 P4 user-message pass that protects a typed name — known phone →
   *  aliased, unknown phone → passes through. See `toPrefetchEntityRecord`. */
  readonly phone?: string;
  /** D-167 B4 — optional company/org of the resolved contact. Like `phone`, it
   *  is NOT rendered into the prompt — carried only so the egress gather seeds it
   *  into the turn's shared ledger as an `org` value (the `contact` entity-privacy
   *  tag stamps `company` → `org`). That aliases the company a USER typed in the
   *  same turn (known org → aliased, unknown → passes through). Withheld from the
   *  seed when it is a single-token common word (`shouldSeedEntityValue`, the B4
   *  commonness filter — see `toPrefetchEntityRecord`). */
  readonly company?: string;
  /** D-167 B1 — this candidate resolved on an EXACT high-precision identifier
   *  (a typed email or phone), not a fuzzy name overlap. A pinned candidate is
   *  NEVER dropped by the top-K display cap (`selectWithPinned`): the user typed
   *  this contact's identifier, so its full canonical values MUST reach the alias
   *  ledger or the raw identifier egresses to the cloud LLM. Fuzzy name matches
   *  stay capped at `limit`; only confirmed identifier matches pin. */
  readonly pinned?: boolean;
  /** D-167 §2 (ambiguity-gate) — this FUZZY candidate is one of 2+ contacts that
   *  TIE for the strongest match on a name/company reference the user typed (e.g.
   *  several "Sarah"s), so it is NOT a confident pre-resolution. The scorer sets it
   *  over the full warehouse view, BEFORE the top-K cap; a pinned exact-identifier
   *  match is never ambiguous (the user typed the exact value → definitive), and a
   *  fuzzy candidate that loses a reference outright to a strictly stronger match is
   *  dropped by the scorer (never surfaced). The producer renders ambiguous
   *  candidates under a distinct "ask before acting" block so the model
   *  disambiguates with the user instead of auto-resolving the wrong one — the
   *  wrong-Sarah failure a confident wrong guess causes (worse than no guess). */
  readonly ambiguous?: boolean;
}

/** Cap on pinned (exact-identifier) candidates kept regardless of `limit` — a
 *  safety bound so an adversarial message naming dozens of contacts can't blow
 *  up the seed / rendered block. Realistic messages name only a few
 *  identifiers, so this never bites in practice; the bound just keeps the seed
 *  small (design §2) under pathological input. */
export const PINNED_CANDIDATE_MAX = 10;

/** Select which candidates to return: keep EVERY pinned (exact-identifier)
 *  match up to `PINNED_CANDIDATE_MAX`, then fill the remaining `limit` display
 *  slots with the top non-pinned (fuzzy) matches. So a typed email/phone is
 *  never crowded out of the seeded set by fuzzy name overlaps or the K cap
 *  (the B1 privacy win), while fuzzy context stays capped at `limit`. The
 *  returned length may EXCEED `limit` when several identifiers match — that is
 *  intended (each is a real mention the user typed). Input must be sorted
 *  best-first. */
export const selectWithPinned = <T extends { readonly score: number; readonly pinned?: boolean }>(
  sorted: readonly T[],
  limit: number,
): T[] => {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const c of sorted) (c.pinned ? pinned : rest).push(c);
  const keptPinned = pinned.slice(0, PINNED_CANDIDATE_MAX);
  const room = Math.max(0, limit - keptPinned.length);
  return [...keptPinned, ...rest.slice(0, room)];
};

/** The warehouse search port — injected at boot. Given the prompt's content
 *  `tokens` (name/word unigrams + bare numbers), `phoneRuns` (reconstructed
 *  phone-FORMATTED digit runs), and `emailRuns` (reconstructed full email
 *  addresses), returns scored candidates best-first. Sync OR async; the producer
 *  awaits either form. The backend adapter owns tokenisation-insensitive matching
 *  (FTS `unicode61 remove_diacritics 2` or an in-memory equivalent) so
 *  casing/accents are handled there.
 *
 *  `phoneRuns` + `emailRuns` are kept SEPARATE from `tokens` on purpose — both
 *  are HIGH-PRECISION identifiers the unigram split would shred (`alice@acme.com`
 *  → `alice` `acme` `com`; `(415) 555-0199` → `415` `555` `0199`). They are
 *  reconstructed whole so the adapter can EXACT-match a typed identifier against
 *  the warehouse, the design's unconditional-win path (D1): an identifier never
 *  appears in prose unless the user typed it, so a wrong match is inert. The
 *  country-code-less national phone form stays ambiguous with a bare invoice
 *  number, so it matches only `phoneRuns`, never a bare token. */
export type EntitySearchPort = (
  query: {
    readonly tokens: readonly string[];
    readonly phoneRuns?: readonly string[];
    /** Full email addresses reconstructed from the prompt (`extractEmailRuns`).
     *  The adapter exact-matches these against a contact's canonical email. */
    readonly emailRuns?: readonly string[];
    readonly limit: number;
  },
) => Promise<readonly PrefetchCandidate[]> | readonly PrefetchCandidate[];

/** No-op default — resolves nothing, so prefetch contributes nothing
 *  until a real port is wired (mirrors `noopDataPresenceProbe`). */
export const noopEntitySearch: EntitySearchPort = () => [];

/** Prefetch dependencies + tuning. `search` is the only required field;
 *  `limit` caps injected candidates, `minScore` is the "worth injecting"
 *  floor (the one soft gate — far below "confident answer"). */
export interface PrefetchDeps {
  readonly search: EntitySearchPort;
  readonly limit?: number;
  readonly minScore?: number;
}

/** The default deps — no-op search, K=3, floor 0. Behavior-preserving. */
export const DEFAULT_PREFETCH_DEPS: PrefetchDeps = {
  search: noopEntitySearch,
  limit: 3,
  minScore: 0,
};

/** Decompose a prompt into dedup'd Unicode content tokens. Unigrams ONLY
 *  — the search side's IDF ranking isolates the name; no span / n-gram
 *  enumeration (design § decompose). Bare numbers ride here too (a contiguous
 *  `14155550199` is matched against a contact's FULL E.164 only — see
 *  `extractPhoneRuns` for the formatted-phone path).
 *
 *  The `≥ 2` length floor (drops single-letter noise like `a` / `I`) is
 *  measured in CODE POINTS via `[...t]`, not `String.length` (UTF-16 code
 *  units) — otherwise a single astral character (`𠮷`, two code units)
 *  would survive while a single BMP character (`中`, one unit) is dropped.
 *  Code-point counting treats both alike. Keeping single-character CJK
 *  tokens (meaningful, unlike a lone Latin letter) is part of the deferred
 *  CJK / trigram work — design § coverage gaps. */
export const decomposeToTokens = (text: string): readonly string[] =>
  [...new Set((text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => [...t].length > 1))];

/** Reconstruct phone-FORMATTED digit runs a user typed — the identifier path the
 *  unigram split loses (`(415) 555-0199` → `415` `555` `0199`).
 *
 *  A run is ≥ 2 digit groups joined ONLY by phone separators (space . ( ) + -),
 *  bounded by non-alphanumeric on BOTH ends, with each whole run collapsed to its
 *  digit string (phone-plausible 7–15 digits). Three deliberate constraints:
 *    - ≥ 2 groups: a LONE bare digit string is NOT a phone run — it stays a
 *      `decomposeToTokens` unigram (matched against the contact's full E.164
 *      only), since a bare number is too ambiguous with an invoice/account id to
 *      treat as a country-code-less national phone.
 *    - word-bounded: the trailing `(?![\p{L}\p{N}])` makes the greedy run BACK
 *      OFF a digit group glued to letters, so `(415) 555-0199 2pm` yields the
 *      clean `4155550199` (the `2` of `2pm` is dropped), not `41555501992`.
 *    - WHOLE run only (no sub-windows): emitting every sub-window would let the
 *      SUFFIX of one number (`5550199` of `…415-555-0199`) masquerade as a short
 *      local contact's standalone phone — a false identifier. The price is two
 *      documented SAFE residuals: two space-adjacent phones (`415 555 0199 650
 *      555 0100`) over-merge to an out-of-range run that's dropped, and a phone
 *      glued to a bare trailing number (`…0199 5 times`) merges — both fail
 *      CLOSED (the phone stays raw / unresolved), never resolving a WRONG
 *      contact.
 *  The search side matches each run EXACTLY against a contact's
 *  `phoneMatchDigits`, so a run that is nobody's number is inert. */
const PHONE_RUN = /(?<![\p{L}\p{N}])\d+(?:[ .()+-]+\d+)+(?![\p{L}\p{N}])/gu;
export const extractPhoneRuns = (text: string): readonly string[] => {
  const out = new Set<string>();
  for (const run of text.match(PHONE_RUN) ?? []) {
    const digits = run.replace(/\D+/gu, '');
    if (digits.length >= 7 && digits.length <= 15) out.add(digits);
  }
  return [...out];
};

/** Reconstruct full email addresses the unigram split shreds (`alice@acme.com`
 *  → `alice` `acme` `com`). A run is `local@domain.tld`, bounded by a
 *  non-email char on BOTH ends so it doesn't fuse with surrounding prose, and
 *  lower-cased (the adapter canonicalises again for the exact compare; lower
 *  is the case-insensitive bias of the comfort layer, design D7). The
 *  local-part / domain classes stay ASCII-plus-common-symbol — EAI / IDN
 *  emails are out of scope for the comfort layer, mirroring `scanContent`'s
 *  ASCII local-part. Returned WHOLE (never sub-windows) so a longer address
 *  can't have a suffix masquerade as a different contact's email. The search
 *  side exact-matches each run against a contact's canonical email, so a run
 *  that is nobody's address is inert. */
const EMAIL_RUN = /(?<![\w.+%-])[\w.+%-]+@[\w-]+(?:\.[\w-]+)+(?![\w-])/gu;
export const extractEmailRuns = (text: string): readonly string[] => {
  const out = new Set<string>();
  for (const run of text.match(EMAIL_RUN) ?? []) out.add(run.toLowerCase());
  return [...out];
};

/** Run the search, apply the floor, cap at `limit`. Pure given `search`. */
export const prefetchEntities = async (
  text: string,
  deps: PrefetchDeps,
): Promise<readonly PrefetchCandidate[]> => {
  const limit = deps.limit ?? 3;
  const minScore = deps.minScore ?? 0;
  const tokens = decomposeToTokens(text);
  const phoneRuns = extractPhoneRuns(text);
  const emailRuns = extractEmailRuns(text);
  if (tokens.length === 0 && phoneRuns.length === 0 && emailRuns.length === 0) return [];
  const hits = await deps.search({ tokens, phoneRuns, emailRuns, limit });
  // Keep all pinned (exact email/phone) matches + fill the rest to `limit` with
  // top fuzzy — so a typed identifier is never dropped by the K cap before it
  // can be seeded into the alias ledger (D-167 B1). A port that never sets
  // `pinned` degrades to the prior `slice(0, limit)` behaviour exactly.
  return selectWithPinned(hits.filter((h) => h.score >= minScore), limit);
};

/** Header for CONFIDENT candidates — a single (or strictly dominant) match per
 *  reference. The "verify" framing keeps the LLM from over-trusting a wrong match
 *  (design § the one place precision doesn't vanish). */
const PREFETCH_CONFIDENT_HEADER =
  'Possible entities referenced in this message (speculative pre-resolution — '
  + 'verify before relying, and resolve via tools if a match is wrong or missing):';

/** Header for AMBIGUOUS candidates (D-167 §2 ambiguity-gate) — 2+ stored contacts
 *  tie for the strongest match on a reference the user typed, so the prefetch must
 *  NOT present any of them as resolved. The framing steers the model to ASK rather
 *  than auto-resolve the wrong one (the wrong-Sarah failure). */
const PREFETCH_AMBIGUOUS_HEADER =
  'Multiple stored contacts could match a reference in this message — these are '
  + 'ambiguous. Do NOT assume which one is meant: ask the user to clarify (or '
  + 'resolve via tools) before acting on any of them:';

const prefetchLine = (
  c: { readonly label: string; readonly kind: string; readonly ref: string },
): string => `- ${c.label} (${c.kind}, ref: ${c.ref})`;

/** Format candidates as labeled, explicitly-speculative context block(s).
 *  Splits on the D-167 §2 ambiguity flag: unambiguous matches render under the
 *  "verify before relying" header; ambiguous ones (2+ contacts tie on a typed
 *  reference) render under a distinct "ask before acting" header so the model
 *  disambiguates rather than auto-resolving a wrong match. Either group may be
 *  empty → one block; both empty (no candidates) → empty string (nothing
 *  contributed).
 *
 *  A candidate with NO label contributes NO line: the B4 seed gate withholds
 *  a single-token common-word name ("April", "Bob"-alone), and the rendered
 *  block reads labels off the (aliased) payload — so such a candidate would
 *  render as a nameless `- (contact, ref: …)` fragment the model cannot
 *  connect to anything (the bench measured exactly this shape collapsing
 *  prefetch trust). The candidate still seeds the alias ledger at the GATHER
 *  (render-independent), so its values stay protected at egress; only the
 *  unusable line is dropped. */
export const formatPrefetchContext = (
  candidates: readonly PrefetchCandidate[],
): string => {
  const labeled = candidates.filter((c) => c.label.trim().length > 0);
  if (labeled.length === 0) return '';
  const confident = labeled.filter((c) => c.ambiguous !== true);
  const ambiguous = labeled.filter((c) => c.ambiguous === true);
  const blocks: string[] = [];
  if (confident.length > 0) {
    blocks.push([PREFETCH_CONFIDENT_HEADER, ...confident.map(prefetchLine)].join('\n'));
  }
  if (ambiguous.length > 0) {
    blocks.push([PREFETCH_AMBIGUOUS_HEADER, ...ambiguous.map(prefetchLine)].join('\n'));
  }
  return blocks.join('\n\n');
};

/** Latest user-turn text from history; `''` when none. (Local copy — the
 *  gate keeps its own; both are tiny and intentionally independent.) */
const latestUserText = (history: TurnContext['history']): string => {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role === 'user') return entry.text;
  }
  return '';
};

/** The entity kind the contact-backed prefetch surfaces. The egress gather
 *  stamps it as each payload record's inline privacy marker so the canonical
 *  `contact` entity-privacy tag aliases `email` / `name` / `target_id` before
 *  the block is rendered. The prefetch search is contact-backed today; a future
 *  kind needs both a canonical entity-privacy tag AND a matching field mapping
 *  in `toPrefetchEntityRecord`. */
const PREFETCH_ENTITY_KIND = 'contact';

/** Map a candidate into the canonical-contact record shape the privacy
 *  resolver tags (`email` / `name` / `target_id` / `phone` / `company`). A
 *  contact's `ref` IS its canonical email (the search returns `rec.email`), so
 *  it seeds BOTH `email` and `target_id` (which alias to the same surface — the
 *  ledger keys on `(kind, value)`); `label` is the display name. When the
 *  candidate was resolved with a `phone` / `company`, each rides along on the
 *  payload (tagged `phone` / `org` by the `contact` entity-privacy tag) so the
 *  gather seeds it into the ledger — `renderPrefetchEntityBlock` emits neither,
 *  so they reach the ledger but not the prompt. `kind` rides along for the
 *  render. No `__entity` marker here — the gather stamps it, so this package
 *  stays free of the privacy-substrate constant.
 *
 *  D-167 B4 commonness filter — `name` and `company` are WITHHELD from the
 *  record (so the gather never seeds them) when they are single-token common
 *  English words (`shouldSeedEntityValue`). `scanContent` aliases anything
 *  seeded, so seeding a contact literally named "Will" or an org named "Gap"
 *  would over-alias the bare word in unrelated prose; multi-token names (D3)
 *  and distinctive single tokens still seed. A withheld `name` simply drops the
 *  speculative block's label for that contact (the email ref still surfaces) —
 *  the comfort-layer's accepted "miss > corrupt" trade (design §5). */
const toPrefetchEntityRecord = (c: PrefetchCandidate): Record<string, unknown> => ({
  email: c.ref,
  ...(shouldSeedEntityValue(c.label) ? { name: c.label } : {}),
  target_id: c.ref,
  kind: c.kind,
  ...(c.phone !== undefined ? { phone: c.phone } : {}),
  ...(c.company !== undefined && shouldSeedEntityValue(c.company)
    ? { company: c.company }
    : {}),
  // D-167 §2 — the ambiguity flag is non-PII, so it rides on the payload like
  // `kind`: the egress gather's `...record` spread preserves it through aliasing
  // and `renderPrefetchEntityBlock` reads it back to group the (aliased) line.
  ...(c.ambiguous === true ? { ambiguous: true } : {}),
});

/** Render the (aliased) entity payload into the same speculative "verify"
 *  block `formatPrefetchContext` produces — reading the aliased `email` / `name`
 *  back as the candidate `ref` / `label`, so the model sees aliases, never raw
 *  PII. Reads only named fields, so any inline `__entity` marker the gather
 *  stamped never appears in the rendered text. */
const renderPrefetchEntityBlock = (
  payload: readonly Record<string, unknown>[],
): string =>
  formatPrefetchContext(
    payload.map((r) => ({
      ref: typeof r['email'] === 'string' ? r['email'] : '',
      label: typeof r['name'] === 'string' ? r['name'] : '',
      kind: typeof r['kind'] === 'string' ? r['kind'] : PREFETCH_ENTITY_KIND,
      score: 0,
      // Read the §2 ambiguity flag back from the (aliased) payload so the block
      // splits confident vs ambiguous candidates (the flag survives the gather).
      ...(r['ambiguous'] === true ? { ambiguous: true } : {}),
    })),
  );

/** Run prefetch for a turn and contribute the resolved candidates to the
 *  prompt draft as a STRUCTURED `entity` part (raw records + `render`) — NOT
 *  pre-rendered text. The egress gather aliases the payload against the turn's
 *  shared ledger and then renders, so the model sees aliases and the same
 *  contact renders to the same alias everywhere (D-167 N.10.1). Zero-harm:
 *  contributes nothing when the search returns nothing / everything is below
 *  floor. Returns the candidates for caller diagnostics + tests. */
export const contributePrefetch = async (
  ctx: TurnContext,
  deps: PrefetchDeps,
): Promise<readonly PrefetchCandidate[]> => {
  const text = latestUserText(ctx.history);
  if (text.length === 0) return [];
  const candidates = await prefetchEntities(text, deps);
  if (candidates.length === 0) return candidates;
  ctx.prompt.contribute({
    role: 'entity',
    entity: PREFETCH_ENTITY_KIND,
    payload: candidates.map(toPrefetchEntityRecord),
    render: renderPrefetchEntityBlock,
  });
  return candidates;
};
