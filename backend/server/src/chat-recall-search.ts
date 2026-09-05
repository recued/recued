/** D-213 Track A / A2 — bounded owner interaction-history search.
 *
 * The backend scans authoritative encrypted chat rows newest-first. It owns
 * lexical matching and scan coverage only; the A3 handler owns public
 * `exhausted` / `partial` semantics, cross-lane composition, and result budgets. */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { FTS_STOPWORDS, type FtsMatchRung } from '@recued/fts';

import { CHAT_MESSAGE_RECALL_ELIGIBILITY } from './storage/chat-store.js';
import { isSnapshotToolRow } from './chat-tool-row.js';

import type {
  OwnerRecallCorpusScope,
  RecallCorpusScope,
} from './chat-recall-scope.js';
import type {
  ChatRecallSourceCursor,
  ChatRecallSourceRow,
  ChatStore,
} from './storage/chat-store.js';

export const RECALL_QUERY_MAX_BYTES = 512;
/** Ceiling on the RAW arg before normalization. The 512-byte cap above applies
 * to the NORMALIZED phrase, so without this an arbitrarily long arg would pay a
 * full NFKC + two regex passes to yield at most 512 bytes. Generous enough that
 * no realistic query is affected (it is 8x the normalized cap). */
export const RECALL_QUERY_RAW_MAX_BYTES = 4_096;
export const RECALL_SEARCH_WALL_TIME_MS = 250;
export const RECALL_INTERACTION_EXACT_MAX_BYTES = 64 * 1024;

const DEFAULT_SCAN_PAGE_SIZE = 32;
const DEFAULT_MAX_RANKED_CANDIDATES = 64;
const CONTINUATION_VERSION = 1;
const CONTINUATION_TOKEN_PREFIX = 'v1';
const CONTINUATION_IV_BYTES = 12;
const CONTINUATION_TAG_BYTES = 16;
const CONTINUATION_AAD = Buffer.from(
  'recued:d213:interaction-scan-continuation:v1',
  'utf8',
);
const CANONICAL_BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/u;

export type InteractionRecallKind = 'user' | 'assistant' | 'tool';

export interface NormalizedRecallQuery {
  /** Byte-capped, NFKC-normalized, lower-cased search phrase. */
  readonly text: string;
  /** Locale-aware word segments used by the lexical matcher. */
  readonly terms: readonly string[];
}

/** Private backend result. `session_id` is an egress/reharvest handle and must
 * be projected out before any model-visible serialization. */
export interface InteractionRecallCandidate {
  readonly item_id: string;
  readonly session_id: string;
  readonly kind: InteractionRecallKind;
  readonly timestamp: number;
  readonly content: string;
  readonly size_bytes: number;
  readonly score: number;
  /** Which relaxation rung admitted this row. ⛔ CARRIED ALL THE WAY TO THE
   *  MODEL ON PURPOSE: relaxing without SAYING SO is worse than not relaxing,
   *  because a `loose` row — one that shares SOME terms and may share nothing
   *  else — would arrive looking exactly like an exact hit. `memory.search`
   *  already reports its rung and its tool description tells the model to read
   *  it before trusting the result; this lane now owes the same. */
  readonly match: FtsMatchRung;
}

export interface RecallNeighbourQuery {
  readonly anchor_id: string;
  /** ⛔ REQUIRED, and it was NOT here before. `neighbours` hardcoded the OWNER
   *  bucket while `search` and `fetchExact` took a scope — harmless while the
   *  owner corpus was the only one, and a cross-tenant leak the moment a second
   *  one existed: a contracted caller's search would return its own rows and
   *  then step to the OWNER's neighbours around them. The compiler found this
   *  when the store's selector became mandatory; nothing else would have. */
  readonly scope: RecallCorpusScope;
  /** D-137 — see `RecallSearchBackend.search`. */
  readonly tool_session_id?: string;
  readonly next?: number;
  readonly prev?: number;
}

export interface RecallSearchBackendResult {
  readonly matches: readonly InteractionRecallCandidate[];
  /** True only when every row in the requested scan range was readable and the
   * frontier was reached. */
  readonly complete: boolean;
  /** Present only when wall time stopped a continuable scan frontier. */
  readonly continuation?: string;
  readonly invalid_continuation: boolean;
  /** True when ranked matches existed beyond the bounded candidate buffer. */
  readonly more_matches: boolean;
  readonly inspected_rows: number;
}

export type RecallExactFetchResult =
  | {
      readonly status: 'ok';
      readonly match: InteractionRecallCandidate;
      /** ⛔ THE PAIR INVARIANT HOLDS ON THIS PATH TOO. A held dispatch is two
       *  rows -- the ask (args) and the answer (result) -- and the design
       *  premise is that reaching EITHER returns BOTH. `search` has always
       *  expanded pairs; `fetchExact` did not, so an `item_id` fetch returned
       *  half an exchange and WHICH half was luck. Measured on a live drive:
       *  the model fetched a settle row, got `To`/`Subject` and no body, and
       *  confidently re-sent different text -- a broken promise that reads as a
       *  successful retrieval. */
      readonly siblings?: readonly InteractionRecallCandidate[];
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'unreadable' };

export interface RecallSearchBackend {
  search(input: {
    readonly query?: NormalizedRecallQuery;
    readonly scope: RecallCorpusScope;
    /** D-137 — the session whose TOOL rows are in scope. Tool rows are TASK
     *  context and a task lives in a session; user/assistant rows stay
     *  corpus-wide. Absent ⇒ no tool row is reachable, which is the
     *  fail-closed reading of "no task to recover context for". */
    readonly tool_session_id?: string;
    readonly kinds?: ReadonlySet<InteractionRecallKind>;
    readonly excluded_item_ids?: ReadonlySet<string>;
    readonly continuation?: string;
    readonly max_ms?: number;
  }): Promise<RecallSearchBackendResult>;
  fetchExact(
    item_id: string,
    scope: RecallCorpusScope,
    tool_session_id?: string,
  ): Promise<RecallExactFetchResult>;
  /** Messages adjacent to an anchor within its own session — the reply
   *  direction (`next`) or the context direction (`prev`). Optional so a
   *  backend without it degrades to search-only rather than failing. */
  neighbours?(query: RecallNeighbourQuery): Promise<InteractionRecallCandidate[]>;
}

/** Add the paired half of any matched two-event tool call.
 *
 *  ⚠ Bounded by `maxCandidates` like every other page, and de-duplicated: a
 *  query that matched BOTH halves must not return either twice. Siblings are
 *  appended rather than interleaved so the score order of the actual matches
 *  survives — a pair is context for a hit, not a hit of its own, and giving it
 *  a borrowed score would let it outrank rows that really matched. */
/** An exact fetch returns the row asked for plus, at most, its pair sibling.
 *  Two: an ask and its answer. */
const RECALL_EXACT_PAIR_LIMIT = 2;

const expandPairs = async (
  store: Pick<ChatStore, 'getRecallPair'>,
  scope: RecallCorpusScope,
  toolSessionId: string | null,
  matches: readonly InteractionRecallCandidate[],
  maxCandidates: number,
): Promise<InteractionRecallCandidate[]> => {
  if (store.getRecallPair === undefined || matches.length === 0) return [...matches];
  const seen = new Set(matches.map((m) => m.item_id));
  const extras: InteractionRecallCandidate[] = [];
  for (const match of matches) {
    if (matches.length + extras.length >= maxCandidates) break;
    let rows: Awaited<ReturnType<NonNullable<ChatStore['getRecallPair']>>>;
    try {
      rows = await store.getRecallPair({
        row_eligibility: scope.row_eligibility,
        recall_contract_id: scope.recall_contract_id,
        tool_session_id: toolSessionId,
        item_id: match.item_id,
      });
    } catch {
      // A pair lookup is enrichment. Failing it must not fail the search.
      continue;
    }
    for (const row of rows) {
      if (!row.readable || seen.has(row.item_id)) continue;
      seen.add(row.item_id);
      extras.push(candidateFromSource(row, 0, 'exact'));
    }
  }
  return [...matches, ...extras].slice(0, maxCandidates);
};

export const truncateRecallUtf8 = (
  value: string,
  maxBytes: number,
): string => {
  let output = '';
  let used = 0;
  for (const char of value) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (used + bytes > maxBytes) break;
    output += char;
    used += bytes;
  }
  return output;
};

const normalizeSearchText = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

const segmentWords = (value: string): string[] => {
  if (value.length === 0) return [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const words: string[] = [];
  for (const segment of segmenter.segment(value)) {
    if (segment.isWordLike) words.push(segment.segment);
  }
  // A punctuation-only query normalizes empty. A script whose runtime segmenter
  // yields no word-like records still gets one conservative phrase token.
  return words.length > 0 ? Array.from(new Set(words)) : [value];
};

export const normalizeRecallQuery = (
  raw: unknown,
): NormalizedRecallQuery | undefined => {
  if (typeof raw !== 'string') return undefined;
  const normalized = normalizeSearchText(
    truncateRecallUtf8(raw, RECALL_QUERY_RAW_MAX_BYTES),
  );
  if (normalized.length === 0) return undefined;
  const text = truncateRecallUtf8(normalized, RECALL_QUERY_MAX_BYTES).trim();
  if (text.length === 0) return undefined;
  return {
    text,
    terms: segmentWords(text),
  };
};

const countOccurrences = (text: string, term: string): number => {
  if (term.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(term, from);
    if (at < 0) break;
    count += 1;
    from = at + term.length;
  }
  return count;
};

/** Rung bands. The gap is wider than any within-rung score can reach (the phrase
 *  bonus is 1_000 and each term contributes at most 200), so the ladder ORDER is
 *  total: every exact match outranks every relaxed one, which outranks every
 *  loose one, and the existing term-frequency score only breaks ties WITHIN a
 *  band. ⛔ That is what makes this ADDITIVE — a row that matches today is still
 *  `exact`, still scores `RUNG_BAND.exact + <the same number as before>`, so it
 *  keeps both its membership AND its position. Nothing that ranks today can be
 *  displaced by a row the ladder newly admits.
 *
 *  ⛔⛔ THE NAME `RUNG_BAND` IS LOAD-BEARING OUTSIDE THIS FILE.
 *  internal benchmarks greps this exact identifier as its
 *  two-sided proof of whether the ladder is in a bundle. Renaming it makes that
 *  ratchet pass while the ladder is present — a bundle that reports
 *  "baseline verified: recall exact-terms-only" and is not one, which would make
 *  any future ladder A/B compare ladder against ladder. */
const RUNG_BAND: Readonly<Record<FtsMatchRung, number>> = {
  exact: 3_000_000,
  relaxed: 2_000_000,
  loose: 1_000_000,
};

/** ⛔⛔ THIS LANE WAS AND-ONLY, AND THAT IS THE WHOLE DEFECT. `lexicalScore`
 *  returned `null` unless EVERY query term appeared, so a query carrying two
 *  terms that ARE in the row plus three that are not matched NOTHING.
 *  Measured 2026-09-02 over the bench corpus, every query containing both
 *  `Ravenscourt` and `renewal` (both present in the target row):
 *  2 terms 1/1 hit · 3 terms 1/2 · 4 terms 1/5 · **5 terms 0/4**.
 *  `recall.search("Ravenscourt renewal")` → 2 matches;
 *  `recall.search("Ravenscourt renewal round land decision")` → 0, `exhausted`.
 *  A longer conversation makes the model write LONGER queries, so recall got
 *  strictly worse exactly where history matters most.
 *
 *  🔑 THE SAME BUG WAS ALREADY FOUND AND FIXED ON THE FTS SIDE. `@recued/fts`'s
 *  `toFtsMatchLadder` records it verbatim — *"`refund policy` hit the right
 *  entry, `What is your refund policy?` returned ZERO"* — and `memory.search`
 *  got the substring analogue in `user-memory-store.ts`'s `substringLadder`.
 *  The interaction lane never did. This is that same ladder, same rungs, same
 *  order, over THIS lane's own tokens.
 *
 *  ⛔ RE-TOKENIZING WITH `wordTokens` WOULD BE A DIFFERENT CHANGE. Recall
 *  segments with `Intl.Segmenter` (`segmentWords`) and the CJK work is pinned on
 *  that; swapping tokenizers here would silently move every existing match. Only
 *  the STOPWORD VOCABULARY is shared — one definition, imported, not copied. */
const lexicalScore = (
  content: string,
  query: NormalizedRecallQuery | undefined,
): { readonly score: number; readonly match: FtsMatchRung } | null => {
  if (query === undefined) return { score: 0, match: 'exact' };
  const normalized = normalizeSearchText(content);
  if (normalized.length === 0) return null;

  const contentTerms = query.terms.filter((t) => !FTS_STOPWORDS.has(t));
  // Mirrors `substringLadder`: `relaxed` only exists when stopwords were
  // actually dropped (otherwise it IS `exact`), and `loose` needs >1 content
  // term or it degenerates into "any single word matches anything".
  const rung: FtsMatchRung | null =
    query.terms.every((t) => normalized.includes(t))
      ? 'exact'
      : contentTerms.length > 0
        && contentTerms.length < query.terms.length
        && contentTerms.every((t) => normalized.includes(t))
        ? 'relaxed'
        : contentTerms.length > 1 && contentTerms.some((t) => normalized.includes(t))
          ? 'loose'
          : null;
  if (rung === null) return null;

  let score = normalized.includes(query.text) ? 1_000 : 0;
  for (const term of query.terms) {
    score += Math.min(20, countOccurrences(normalized, term)) * 10;
  }
  return { score: RUNG_BAND[rung] + score, match: rung };
};

const compareCandidates = (
  left: InteractionRecallCandidate,
  right: InteractionRecallCandidate,
): number =>
  right.score - left.score
  || right.timestamp - left.timestamp
  || right.item_id.localeCompare(left.item_id);

interface ContinuationPayload {
  readonly v: typeof CONTINUATION_VERSION;
  readonly t: number;
  readonly i: string;
}

const encodeContinuation = (
  cursor: ChatRecallSourceCursor,
  key: Buffer,
): string => {
  const plaintext = Buffer.from(
    JSON.stringify({
      v: CONTINUATION_VERSION,
      t: cursor.ts,
      i: cursor.message_id,
    } satisfies ContinuationPayload),
    'utf8',
  );
  const iv = randomBytes(CONTINUATION_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(CONTINUATION_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    CONTINUATION_TOKEN_PREFIX,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
};

const decodeCanonicalBase64url = (segment: string): Buffer | null => {
  if (!CANONICAL_BASE64URL_SEGMENT.test(segment)) return null;
  try {
    const decoded = Buffer.from(segment, 'base64url');
    return decoded.toString('base64url') === segment ? decoded : null;
  } catch {
    return null;
  }
};

const decodeContinuation = (
  token: string,
  key: Buffer,
): ChatRecallSourceCursor | null => {
  if (token.length === 0 || token.length > 1_024) return null;
  const pieces = token.split('.');
  if (pieces.length !== 4 || pieces[0] !== CONTINUATION_TOKEN_PREFIX) {
    return null;
  }
  const iv = decodeCanonicalBase64url(pieces[1] ?? '');
  const ciphertext = decodeCanonicalBase64url(pieces[2] ?? '');
  const tag = decodeCanonicalBase64url(pieces[3] ?? '');
  if (
    iv === null
    || ciphertext === null
    || tag === null
    || iv.length !== CONTINUATION_IV_BYTES
    || ciphertext.length === 0
    || tag.length !== CONTINUATION_TAG_BYTES
  ) {
    return null;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(CONTINUATION_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const parsed = JSON.parse(
      plaintext.toString('utf8'),
    ) as Partial<ContinuationPayload>;
    if (
      parsed.v !== CONTINUATION_VERSION
      || typeof parsed.t !== 'number'
      || !Number.isSafeInteger(parsed.t)
      || typeof parsed.i !== 'string'
      || parsed.i.length === 0
      || parsed.i.length > 512
    ) {
      return null;
    }
    return { ts: parsed.t, message_id: parsed.i };
  } catch {
    return null;
  }
};

const candidateFromSource = (
  source: Extract<ChatRecallSourceRow, { readable: true }>,
  score: number,
  match: FtsMatchRung,
): InteractionRecallCandidate => ({
  item_id: source.item_id,
  session_id: source.session_id,
  kind: source.kind,
  timestamp: source.timestamp,
  content: source.content,
  size_bytes: Buffer.byteLength(source.content, 'utf8'),
  score,
  match,
});

export const createRecallSearchBackend = (
  store: Pick<ChatStore,
    'scanRecallMessagesPage' | 'getRecallMessage' | 'getRecallNeighbours'
    | 'getRecallPair'>,
  options: {
    readonly now?: () => number;
    readonly continuation_secret?: Uint8Array;
    readonly page_size?: number;
    readonly max_ranked_candidates?: number;
  } = {},
): RecallSearchBackend => {
  // Capacity timing must not inherit wall-clock jumps. Tests inject a
  // deterministic clock; production uses Node's monotonic process clock.
  const now = options.now ?? (() => performance.now());
  const secret = options.continuation_secret ?? randomBytes(32);
  const continuationKey = createHash('sha256').update(secret).digest();
  const pageSize = Math.max(
    1,
    Math.min(Math.floor(options.page_size ?? DEFAULT_SCAN_PAGE_SIZE), 256),
  );
  const maxCandidates = Math.max(
    1,
    Math.floor(
      options.max_ranked_candidates ?? DEFAULT_MAX_RANKED_CANDIDATES,
    ),
  );

  return {
    /** Messages adjacent to an anchor within its own session.
     *
     *  🔑 THE ANSWER IN A CONVERSATION REPEATS NONE OF THE QUESTION'S WORDS.
     *  "are you sure you want to move from 30d to 90d?" is findable; the reply
     *  "no lets be fair & change it to 60d" is not — it shares no vocabulary
     *  with any query that would locate the question. Ranking cannot fix that
     *  and neither can relaxation; only stepping to the next message can.
     *
     *  Session-scoped because chat has no thread — the session IS the
     *  conversation — and direction-aware because the reply is AFTER and the
     *  context BEFORE, so the caller takes one side rather than a whole
     *  session. */
    async neighbours(input): Promise<InteractionRecallCandidate[]> {
      if (!store.getRecallNeighbours) return [];
      const rows = await store.getRecallNeighbours({
        row_eligibility: input.scope.row_eligibility,
        recall_contract_id: input.scope.recall_contract_id,
        tool_session_id: input.tool_session_id ?? null,
        item_id: input.anchor_id,
        ...(input.next !== undefined ? { next: input.next } : {}),
        ...(input.prev !== undefined ? { prev: input.prev } : {}),
      });
      // ⛔ SKIP UNREADABLE ROWS. A recall row can come back `readable: false`
      // (no decryptable content), and projecting one would put an empty message
      // in front of the model as if it were the reply it went looking for.
      // score 0: these matched nothing, and saying so keeps them from
      // outranking rows that actually did.
      return rows
        .filter((r): r is Extract<typeof r, { readable: true }> => r.readable)
        .map((r) => candidateFromSource(r, 0, 'exact'));
    },

    async search(input): Promise<RecallSearchBackendResult> {
      if (!store.scanRecallMessagesPage) {
        return {
          matches: [],
          complete: false,
          invalid_continuation: false,
          more_matches: false,
          inspected_rows: 0,
        };
      }

      let cursor: ChatRecallSourceCursor | undefined;
      if (input.continuation !== undefined) {
        const decoded = decodeContinuation(input.continuation, continuationKey);
        if (decoded === null) {
          return {
            matches: [],
            complete: false,
            invalid_continuation: true,
            more_matches: false,
            inspected_rows: 0,
          };
        }
        cursor = decoded;
      }

      const startedAt = now();
      const maxMs = Math.max(
        1,
        Math.floor(input.max_ms ?? RECALL_SEARCH_WALL_TIME_MS),
      );
      const matches: InteractionRecallCandidate[] = [];
      let inspectedRows = 0;
      let unreadable = false;
      let frontierCutoff = false;
      let moreMatches = false;
        // Reserve a quarter of the page for the most RECENT matches.
        const recencyFloor = Math.max(1, Math.floor(maxCandidates * 0.25));
        const recent: InteractionRecallCandidate[] = [];
      let reachedEnd = false;

      scan: while (!reachedEnd) {
        // Do not start another SQL/decrypt page after the wall-clock frontier.
        // The per-row check below still stops within a page; this outer check
        // prevents an already-expired call from materializing one extra page
        // merely to discover that it must return a continuation.
        if (inspectedRows > 0 && now() - startedAt >= maxMs) {
          frontierCutoff = true;
          break;
        }
        let page;
        try {
          page = await store.scanRecallMessagesPage({
            row_eligibility: input.scope.row_eligibility,
            recall_contract_id: input.scope.recall_contract_id,
            tool_session_id: input.tool_session_id ?? null,
            ...(cursor ? { after: cursor } : {}),
            limit: pageSize,
          });
        } catch {
          unreadable = true;
          break;
        }
        if (page.rows.length === 0) {
          reachedEnd = true;
          break;
        }

        for (const source of page.rows) {
          // Always inspect at least one new row per valid continuation so a
          // coarse/injected clock cannot issue the same frontier forever.
          if (inspectedRows > 0 && now() - startedAt >= maxMs) {
            frontierCutoff = true;
            break scan;
          }
          inspectedRows += 1;
          cursor = { ts: source.timestamp, message_id: source.item_id };
          if (!source.readable) {
            unreadable = true;
            continue;
          }
          if (
            input.kinds !== undefined
            && !input.kinds.has(source.kind)
          ) {
            continue;
          }
          if (input.excluded_item_ids?.has(source.item_id) === true) {
            continue;
          }
          const scored = lexicalScore(source.content, input.query);
          if (scored === null) continue;
          const candidate = candidateFromSource(source, scored.score, scored.match);
          matches.push(candidate);
          matches.sort(compareCandidates);
          if (matches.length > maxCandidates) {
            matches.pop();
            moreMatches = true;
          }
          // ── RECENCY FLOOR ──────────────────────────────────────────────────
          // ⛔ SCORE IS NEGATIVELY CORRELATED WITH CURRENCY HERE. `lexicalScore`
          // gives +1000 for a whole-phrase hit and +10 per term occurrence, and
          // timestamp is only a TIEBREAK — so an old message carrying the exact
          // phrasing people later quote back outranks yesterday's correction,
          // and past `maxCandidates` it EVICTS it. Older statements have had
          // longer to accumulate the wording a query is phrased in.
          //
          // A second bounded list keeps the newest candidates regardless of
          // score. It is bounded for the same reason the main list is — this
          // loop walks the whole corpus and must not accumulate it.
          //
          // ⛔ This does NOT rule that the newest is true. A newer message can
          // be a question, a guess, or wrong. The floor only guarantees the
          // newest is VISIBLE beside what it contradicts; which one stands is
          // the reader's judgement, and a substrate deciding that would be
          // consolidation with a timestamp.
          recent.push(candidate);
          recent.sort((a, b) => b.timestamp - a.timestamp
            || b.item_id.localeCompare(a.item_id));
          if (recent.length > recencyFloor) recent.pop();
        }

        if (page.next_cursor === undefined) {
          reachedEnd = true;
        } else {
          cursor = page.next_cursor;
        }
      }

      // Merge: reserve only for recent candidates the score pass MISSED, so the
      // page still comes back full (reserving unconditionally under-fills it).
      const present = new Set(matches.map((m) => m.item_id));
      const missing = recent.filter((r) => !present.has(r.item_id));
      const merged = missing.length === 0
        ? matches
        : [...matches.slice(0, Math.max(0, maxCandidates - missing.length)), ...missing]
            .slice(0, maxCandidates);

      // ⛔⛔ A MATCH ON EITHER HALF RETURNS BOTH. A two-event tool call is a
      //   dispatch row (the ask, with its args) and a result row (the outcome),
      //   written at the two times that genuinely differ. Returning only the
      //   half that matched is the failure the split exists to avoid: a query
      //   naming the ARGS finds "I asked to email Pat" with no outcome, and a
      //   query naming the RESULT finds an answer with nothing to say what was
      //   asked for. Neither half is a truncated view of the other.
      //
      // ⚠ Scoped by construction: `getRecallPair` applies the same corpus
      //   predicate as the scan. A sibling fetch keyed on the pair id alone
      //   would return a row from any corpus sharing that run id — which is
      //   exactly the shape `neighbours` shipped with, and exactly the leak it
      //   became once a second corpus existed.
      // ⛔⛔ A READ'S STORED RESULT IS A SNAPSHOT, AND RECALL MUST NOT SERVE IT.
      //   Re-running the read is strictly better: it is fresher, and it is what
      //   the model already does unprompted (measured 3/3 -- it re-ran
      //   `deal.search` in a later turn rather than reaching for the stored
      //   copy). Serving the snapshot instead is not merely redundant, it is
      //   WRONG WHERE IT MATTERS: a live drive had the model fetch a stored
      //   `memory.search` row and email a maintenance window that had already
      //   been changed, with every layer reporting success.
      //   EFFECT rows are kept: a send's composed `body` IS the artifact, it
      //   cannot be re-derived by re-running (that would re-send), and its
      //   consequence is not always in a domain store -- a denied run, or a
      //   best-effort Sent append that failed, leaves the tool row as the only
      //   copy.
      // ⚠ The predicate reads `TIER1_CLASSIFICATIONS`; see `chat-tool-row.ts`
      //   for why `'unknown'` is not `'read'` and why that is load-bearing.
      const paired = store.getRecallPair === undefined
        ? merged
        : await expandPairs(
          store, input.scope, input.tool_session_id ?? null, merged, maxCandidates,
        );

      return {
        matches: paired.filter(
          (m) => m.kind !== 'tool' || !isSnapshotToolRow(m.content),
        ),
        complete: reachedEnd && !unreadable,
        ...(frontierCutoff && cursor
          ? { continuation: encodeContinuation(cursor, continuationKey) }
          : {}),
        invalid_continuation: false,
        more_matches: moreMatches,
        inspected_rows: inspectedRows,
      };
    },

    async fetchExact(
      item_id,
      scope,
      tool_session_id,
    ): Promise<RecallExactFetchResult> {
      if (!store.getRecallMessage || item_id.length === 0 || item_id.length > 512) {
        return { status: 'not_found' };
      }
      let source: ChatRecallSourceRow | null;
      try {
        source = await store.getRecallMessage({
          row_eligibility: scope.row_eligibility,
          recall_contract_id: scope.recall_contract_id,
          tool_session_id: tool_session_id ?? null,
          item_id,
        });
      } catch {
        return { status: 'unreadable' };
      }
      if (source === null) return { status: 'not_found' };
      if (!source.readable) return { status: 'unreadable' };
      const match = candidateFromSource(source, 0, 'exact');
      // ⛔ THE EXACT PATH IS GATED TOO, OR THE GATE IS DECORATION. An
      //   `item_id` resolves whatever it names, so a handle held by anything --
      //   a packet pointer, a model that saw the id earlier -- would walk
      //   straight past a filter applied only to search.
      if (match.kind === 'tool' && isSnapshotToolRow(match.content)) {
        return { status: 'not_found' };
      }
      // Same helper the search path uses -- one rule, not a second expansion.
      const expanded = await expandPairs(
        store, scope, tool_session_id ?? null, [match], RECALL_EXACT_PAIR_LIMIT,
      );
      const siblings = expanded.filter(
        (c) => c.item_id !== match.item_id
          && (c.kind !== 'tool' || !isSnapshotToolRow(c.content)),
      );
      return {
        status: 'ok',
        match,
        ...(siblings.length > 0 ? { siblings } : {}),
      };
    },
  };
};

