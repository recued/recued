/** D-213 §3.8 — scoped-join candidate contributor.
 *
 * ⛔ THE UNIT OF JOIN IS THE RETURNED PIECE (owner, 2026-07-25). When recall
 * returns pieceA of sessionA into sessionB, pieceA joins B: its PII carries
 * forward so it cannot leak in B, and it survives A's legitimate deletion.
 * NOTHING ELSE FROM A CROSSES.
 *
 * This replaces the whole-session historical reharvest, and the LRU cache,
 * private keyset frontier, four-session ceiling and monotonic-union machinery
 * that existed to make that reharvest bounded. Their reason is gone: a piece is
 * already bounded.
 *
 * ⚠ Why the read still walks a PREFIX rather than one row. A matched row may
 * mention someone first attested several rows EARLIER in its own session
 * (`m3: "John Adams owes a reply"` where the contact record was `m1`), so the
 * join reads its source oldest-first UP TO the matched row and then strips to
 * what the matched CONTENT actually contains. Oldest-first is what makes that
 * prefix stable as the source session grows.
 *
 * ⛔ Only the kv joins durably; the CONTENT is turn-local. Search reads
 * `content_encrypted` and never the candidate column, so a third session
 * recalling B cannot be handed sessionA's material — that column separation is
 * what stops `context_read` feeding itself (R7). */

import type { piiEgress } from '@recued/gateway';
import { shouldSeedEntityValue } from '@recued/middleware-prompt-cache';

import type { RecallJoinRef } from './chat-recall-search-tool.js';
import type {
  ChatPiiSourceHarvest,
  ChatStore,
  RetainedAliasCandidate,
} from './storage/chat-store.js';

export const PII_REHARVEST_MAX_ROWS = 256;
export const PII_REHARVEST_MAX_BYTES = 1_048_576;
export const PII_REHARVEST_MAX_CANDIDATES = 1_024;
export const PII_REHARVEST_MAX_MS = 250;
/** Distinct SOURCE SESSIONS a turn's joined pieces may read. A piece is already
 *  bounded, but a turn can return pieces from many sessions and each costs a
 *  prefix read. */
export const PII_JOIN_MAX_SOURCE_SESSIONS = 4;

export interface CandidateContribution {
  readonly candidates: readonly piiEgress.CandidateValueSeed[];
  readonly partial: boolean;
  readonly joined_source_session_ids: readonly string[];
  readonly decrypted_rows: number;
  readonly decrypted_bytes: number;
}

export interface CandidateContributor {
  contribute(input: {
    /** The private copy emitted by Track A X1 — the pieces recall RETURNED, not
     * the sessions they came from. No other source-discovery seam is accepted. */
    readonly joined_pieces: readonly RecallJoinRef[];
  }): Promise<CandidateContribution>;
}

const extractDeterministicCandidates = (
  text: string,
): readonly RetainedAliasCandidate[] => {
  const out: RetainedAliasCandidate[] = [];
  const seen = new Set<string>();
  const add = (
    kind: RetainedAliasCandidate['kind'],
    value: string,
  ): void => {
    if (value.length === 0) return;
    const key = `${kind}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value });
  };
  for (const match of text.matchAll(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
  )) {
    add('email', match[0]);
  }
  for (const match of text.matchAll(
    /\bhttps?:\/\/[^\s<>"'`]+/giu,
  )) {
    add('url', match[0].replace(/[),.;!?]+$/u, ''));
  }
  for (const match of text.matchAll(
    /(?<![\w])\+\d[\d ().-]{6,18}\d(?![\w])/gu,
  )) {
    const digits = match[0].replace(/\D/gu, '');
    if (digits.length >= 8 && digits.length <= 15) add('phone', match[0]);
  }
  return out;
};

const candidateKey = (candidate: RetainedAliasCandidate): string =>
  `${candidate.kind}\u0000${candidate.value}`;

const candidateAndSafeDerivatives = (
  candidate: RetainedAliasCandidate,
): readonly RetainedAliasCandidate[] => {
  if (candidate.kind !== 'url') return [candidate];
  // A retained URL may carry a path. The exact origin is a safe local
  // derivative and is literally present at the start of every same-origin URL,
  // allowing host-wide protection without allocating the absent path-bearing
  // value (P1).
  const origin = candidate.value.match(
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+/u,
  )?.[0];
  return origin && origin !== candidate.value
    ? [candidate, { value: origin, kind: 'url' }]
    : [candidate];
};

const broadCandidateIsAdmissible = (
  candidate: RetainedAliasCandidate,
): candidate is piiEgress.CandidateValueSeed => {
  const value = candidate.value;
  if (value.length === 0) return false;
  if (candidate.kind === 'name' || candidate.kind === 'org') {
    return shouldSeedEntityValue(value);
  }
  if (candidate.kind === 'address') {
    // ⛔ A BARE POSTCODE IS NEVER A BROAD SEED. D-167's `addressMatchForms`
    // refuses to generate one (`addressMatchForms({postal}) === []`, pinned at
    // `d-167-p1-alias-fields.test.ts:563`) because `94043` is indistinguishable
    // from an invoice number and `SW1A 1AA` from a warehouse code — replacing
    // both with one alias asserts a FALSE IDENTITY, which costs more than a miss.
    // The all-digit clause below catches US/DE/FR forms only; the WORD test is
    // what covers the alphanumeric ones (UK `SW1A 1AA`, CA `K1A 0B1`, NL
    // `1012 AB`, IE `D02 X285`).
    //
    // The proxy for "this is a real address run, not a postcode" is a purely
    // ALPHABETIC token of ≥ 3 characters — every street line (`1 Main Street`)
    // and every city-bearing composite (`Mountain View, CA 94043`) has one; no
    // postcode does. ⚠ Two accepted misses: a state-only composite (`CA 94043`)
    // and an all-abbreviation street (`12 A St`) are withheld. Both fail SAFE.
    //
    // ⚠ This gates BROAD SEEDING ONLY. The stored row keeps the postcode
    // verbatim (T4/P8) — that retention is what feeds P9's slot ordering, and
    // removing it would break the crash rebuild.
    const hasAlphabeticWord = value
      .split(/[^\p{L}]+/u)
      .some((token) => token.length >= 3);
    return value.length >= 4
      && !/^\d+$/u.test(value)
      && hasAlphabeticWord
      && (/\d/u.test(value) || /\s/u.test(value));
  }
  if (
    candidate.kind === 'external_id'
    || candidate.kind === 'account_id'
  ) {
    return value.length >= 4
      && !/^\d+$/u.test(value)
      && (
        /[^A-Za-z]/u.test(value)
        || (/\d/u.test(value) && /[A-Za-z]/u.test(value))
      );
  }
  return true;
};

const harvestedCandidates = (
  harvest: ChatPiiSourceHarvest,
  limit: number,
): {
  readonly candidates: readonly RetainedAliasCandidate[];
  readonly truncated: boolean;
} => {
  const values = new Map<string, RetainedAliasCandidate>();
  let truncated = false;
  for (const row of harvest.rows) {
    for (const sourceCandidate of [
      ...row.candidates,
      ...extractDeterministicCandidates(row.content),
    ]) {
      for (const candidate of candidateAndSafeDerivatives(sourceCandidate)) {
        const key = candidateKey(candidate);
        if (values.has(key)) continue;
        if (values.size >= limit) {
          truncated = true;
          continue;
        }
        values.set(key, candidate);
      }
    }
  }
  return { candidates: [...values.values()], truncated };
};

/** The scope filter — and the reason this is a JOIN rather than a copy. A
 *  value crosses only when the returned piece's own text contains it. Anything
 *  else in the source session stays in the source session, so a value the
 *  recalling session already disclosed is never retroactively aliased. */
const presentInJoinedText = (
  candidate: RetainedAliasCandidate,
  texts: readonly string[],
): boolean => {
  const needle = candidate.value.toLowerCase();
  return texts.some((text) => text.toLowerCase().includes(needle));
};

export const createCandidateContributor = (deps: {
  readonly owner_session_id: string;
  readonly store: ChatStore;
  readonly now?: () => number;
}): CandidateContributor => ({
  async contribute(input): Promise<CandidateContribution> {
    const now = deps.now ?? Date.now;
    const started = now();
    const values = new Map<string, RetainedAliasCandidate>();
    let partial = false;
    let decryptedRows = 0;
    let decryptedBytes = 0;

    // Group the turn's pieces by source session: one prefix read per session,
    // bounded by the LATEST matched row in it, then stripped against every
    // piece that session contributed.
    const bySession = new Map<string, {
      cursor: { ts: number; message_id: string };
      texts: string[];
    }>();
    for (const piece of input.joined_pieces) {
      if (
        typeof piece?.session_id !== 'string'
        || piece.session_id.length === 0
        || typeof piece.message_id !== 'string'
        || piece.message_id.length === 0
        || !Number.isFinite(piece.ts)
      ) continue;
      const existing = bySession.get(piece.session_id);
      if (existing === undefined) {
        if (bySession.size >= PII_JOIN_MAX_SOURCE_SESSIONS) {
          partial = true;
          continue;
        }
        bySession.set(piece.session_id, {
          cursor: { ts: piece.ts, message_id: piece.message_id },
          texts: [piece.content],
        });
        continue;
      }
      existing.texts.push(piece.content);
      if (
        piece.ts > existing.cursor.ts
        || (piece.ts === existing.cursor.ts
          && piece.message_id > existing.cursor.message_id)
      ) {
        existing.cursor = { ts: piece.ts, message_id: piece.message_id };
      }
    }

    const addCandidates = (
      candidates: readonly RetainedAliasCandidate[],
    ): void => {
      for (const candidate of candidates) {
        if (values.has(candidateKey(candidate))) continue;
        if (values.size >= PII_REHARVEST_MAX_CANDIDATES) {
          partial = true;
          break;
        }
        values.set(candidateKey(candidate), candidate);
      }
    };

    const harvest = async (
      session_id: string,
      until?: { ts: number; message_id: string },
    ): Promise<readonly RetainedAliasCandidate[]> => {
      if (deps.store.harvestPiiSources === undefined) {
        partial = true;
        return [];
      }
      const remainingRows = PII_REHARVEST_MAX_ROWS - decryptedRows;
      const remainingBytes = PII_REHARVEST_MAX_BYTES - decryptedBytes;
      const remainingCandidates =
        PII_REHARVEST_MAX_CANDIDATES - values.size;
      const remainingMs = PII_REHARVEST_MAX_MS - (now() - started);
      if (
        remainingRows <= 0
        || remainingBytes <= 0
        || remainingCandidates <= 0
        || remainingMs <= 0
      ) {
        partial = true;
        return [];
      }
      const timeout = Symbol('pii-join-timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        deps.store.harvestPiiSources({
          session_id,
          ...(until !== undefined ? { until } : {}),
          max_rows: remainingRows,
          max_bytes: remainingBytes,
          max_candidates: remainingCandidates,
          max_ms: remainingMs,
        }),
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), remainingMs);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      if (result === timeout) {
        partial = true;
        return [];
      }
      decryptedRows += result.decrypted_rows;
      decryptedBytes += result.decrypted_bytes;
      if (result.partial) partial = true;
      const projected = harvestedCandidates(result, remainingCandidates);
      if (projected.truncated) partial = true;
      return projected.candidates;
    };

    // The recalling session's own material is not a join — it is B protecting
    // itself, and it is unscoped for the same reason it always was.
    addCandidates(await harvest(deps.owner_session_id));

    const joined: string[] = [];
    for (const [session_id, group] of bySession) {
      if (session_id === deps.owner_session_id) continue;
      if (now() - started >= PII_REHARVEST_MAX_MS) {
        partial = true;
        break;
      }
      joined.push(session_id);
      const prefix = await harvest(session_id, group.cursor);
      addCandidates(
        prefix.filter((candidate) => presentInJoinedText(candidate, group.texts)),
      );
    }
    if (now() - started > PII_REHARVEST_MAX_MS) partial = true;

    return {
      // The source row retains every schema-attested candidate verbatim
      // (T4/P8). This final filter is only the free-text broad-scan gate:
      // common names and ambiguous ids must not rewrite unrelated prose.
      candidates: [...values.values()].filter(broadCandidateIsAdmissible),
      partial,
      joined_source_session_ids: joined,
      decrypted_rows: decryptedRows,
      decrypted_bytes: decryptedBytes,
    };
  },
});
