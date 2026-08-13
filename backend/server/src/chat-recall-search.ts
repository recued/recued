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

import type { OwnerRecallCorpusScope } from './chat-recall-scope.js';
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

export type InteractionRecallKind = 'user' | 'assistant';

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
  | { readonly status: 'ok'; readonly match: InteractionRecallCandidate }
  | { readonly status: 'not_found' }
  | { readonly status: 'unreadable' };

export interface RecallSearchBackend {
  search(input: {
    readonly query?: NormalizedRecallQuery;
    readonly scope: OwnerRecallCorpusScope;
    readonly kinds?: ReadonlySet<InteractionRecallKind>;
    readonly excluded_item_ids?: ReadonlySet<string>;
    readonly continuation?: string;
    readonly max_ms?: number;
  }): Promise<RecallSearchBackendResult>;
  fetchExact(
    item_id: string,
    scope: OwnerRecallCorpusScope,
  ): Promise<RecallExactFetchResult>;
}

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

const lexicalScore = (
  content: string,
  query: NormalizedRecallQuery | undefined,
): number | null => {
  if (query === undefined) return 0;
  const normalized = normalizeSearchText(content);
  if (normalized.length === 0) return null;
  if (!query.terms.every((term) => normalized.includes(term))) return null;

  let score = normalized.includes(query.text) ? 1_000 : 0;
  for (const term of query.terms) {
    score += Math.min(20, countOccurrences(normalized, term)) * 10;
  }
  return score;
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
): InteractionRecallCandidate => ({
  item_id: source.item_id,
  session_id: source.session_id,
  kind: source.kind,
  timestamp: source.timestamp,
  content: source.content,
  size_bytes: Buffer.byteLength(source.content, 'utf8'),
  score,
});

export const createRecallSearchBackend = (
  store: Pick<ChatStore, 'scanRecallMessagesPage' | 'getRecallMessage'>,
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
          const score = lexicalScore(source.content, input.query);
          if (score === null) continue;
          matches.push(candidateFromSource(source, score));
          matches.sort(compareCandidates);
          if (matches.length > maxCandidates) {
            matches.pop();
            moreMatches = true;
          }
        }

        if (page.next_cursor === undefined) {
          reachedEnd = true;
        } else {
          cursor = page.next_cursor;
        }
      }

      return {
        matches,
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
    ): Promise<RecallExactFetchResult> {
      if (!store.getRecallMessage || item_id.length === 0 || item_id.length > 512) {
        return { status: 'not_found' };
      }
      let source: ChatRecallSourceRow | null;
      try {
        source = await store.getRecallMessage({
          row_eligibility: scope.row_eligibility,
          item_id,
        });
      } catch {
        return { status: 'unreadable' };
      }
      if (source === null) return { status: 'not_found' };
      if (!source.readable) return { status: 'unreadable' };
      return { status: 'ok', match: candidateFromSource(source, 0) };
    },
  };
};

