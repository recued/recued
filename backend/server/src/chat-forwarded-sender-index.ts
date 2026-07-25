/** D-177 N.11 rule 5 (5.d hot-path + 5.f) — the per-session
 *  forwarded-sender candidate index.
 *
 *  A NARROW precomputed index built as items are contributed — the
 *  rule-1 resolver-seam pattern (`resolveStoredRowOrigin`), never a
 *  synchronous history mine (N.9.8). The gateway (slice D) threads
 *  `candidates(session_id)` into `SessionGrantMatchContext.
 *  scoped_sender_candidates` for the `'scoped'` grant's containment
 *  check at match AND consume.
 *
 *  Eligibility (5.f): only USER-contributed items feed the index — the
 *  orchestrator records exactly the chat turns it just persisted with
 *  `contributor: 'user'`. Channel scope is CHAT ONLY for v1: messenger
 *  turns are stamped but NOT recorded here until messenger's
 *  inbound-media paths pass their own stamping audit (5.f).
 *
 *  Candidate semantics (5.e.i): the extracted STRUCTURED sender of a
 *  forwarded mail block — never an address merely appearing in body
 *  text, signature, or a quoted reply chain. The extractor requires an
 *  explicit forwarded-message marker line followed by a header cluster
 *  (`From:` plus at least two companion header keys), and skips
 *  quote-prefixed (`>`) lines entirely, so a `From:` inside a nested
 *  quoted chain never qualifies.
 *
 *  Durability posture: in-memory only, deliberately. A scoped grant is
 *  session-bound with candidates time-bounded to `[minted_at,
 *  expiry_at]`; on restart the index is empty and every fire degrades
 *  to ASKING — the spec's blessed failure direction ("an evicted/
 *  compacted item simply can't match ⇒ degrades toward asking", 5.f).
 *
 *  Extraction rigor (5.d): the `From:` header VALUE goes through
 *  `parseAddress` (full RFC-5322 wrapper handling — `Name <a@b>`,
 *  `a@b (Name)`, encoded display names) and the result is the
 *  canonical lowercased token; equality downstream is over this
 *  extracted token, never raw bytes.
 *
 *  Spec: D-177 § N.11 rule 5 (5.d / 5.e / 5.f). */

import { parseAddress } from '@recued/contracts';
import type { ScopedSenderCandidate } from '@recued/contracts';

/** Marker lines mail clients emit at the top of forwarded content.
 *  Matched against a trimmed line, case-insensitive. Closed list —
 *  widening it is a deliberate change, not a tweak: every new marker
 *  admits a new way for text to count as "a mail the user forwarded". */
const FORWARDED_MARKERS: ReadonlyArray<RegExp> = [
  /^-{2,}\s*forwarded message\s*-{2,}$/i, // Gmail / mutt
  /^begin forwarded message:?$/i, // Apple Mail
  /^-{2,}\s*original message\s*-{2,}$/i, // Outlook
];

/** Header keys that may accompany `From:` in a forwarded header
 *  cluster. Two of these within the lookahead window confirm the
 *  `From:` line is a structured header block, not prose. */
const COMPANION_HEADER = /^(date|sent|to|subject|cc|reply-to):/i;

/** How many lines after the marker the `From:` line may sit, and how
 *  many lines after `From:` the companion headers may sit. Forwarded
 *  header blocks are tight; a generous-but-bounded window keeps the
 *  scan deterministic and cheap. */
const MARKER_TO_FROM_WINDOW = 4;
const COMPANION_WINDOW = 5;

/** Per-session candidate cap. The index is deliberately narrow — a
 *  session that somehow accumulates more forwarded senders than this
 *  drops the OLDEST entries (those are the ones most likely already
 *  outside any active grant's window). */
const MAX_CANDIDATES_PER_SESSION = 256;

const isQuoted = (line: string): boolean => /^\s*>/.test(line);

/** Extract the canonical sender tokens of every forwarded-mail header
 *  block in USER-AUTHORED turn text. Returns deduplicated canonical
 *  emails; empty when the text contains no marker-anchored cluster —
 *  fail-closed, the not-a-forward direction. */
export const extractForwardedSenderEmails = (
  text: string,
): string[] => {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const found = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!FORWARDED_MARKERS.some((m) => m.test(line))) continue;
    // Marker found — look for the From: line within the window.
    for (
      let j = i + 1;
      j < lines.length && j <= i + MARKER_TO_FROM_WINDOW;
      j++
    ) {
      const candidate = lines[j];
      if (isQuoted(candidate)) continue; // never read quoted chains
      const fromMatch = /^from:\s*(.+)$/i.exec(candidate.trim());
      if (!fromMatch) continue;
      // Require ≥2 companion headers nearby so a lone prose "From: x"
      // after a coincidental dash line doesn't qualify.
      let companions = 0;
      for (
        let k = j + 1;
        k < lines.length && k <= j + COMPANION_WINDOW;
        k++
      ) {
        if (isQuoted(lines[k])) continue;
        if (COMPANION_HEADER.test(lines[k].trim())) companions++;
      }
      if (companions < 2) continue;
      const parsed = parseAddress(fromMatch[1]);
      if (parsed && parsed.email) found.add(parsed.email);
      break; // one sender per marker block — the forwarded item's sender
    }
  }
  return [...found];
};

export interface SessionForwardedSenderIndex {
  /** Record a USER-contributed chat turn (call only after the row is
   *  durably persisted with `contributor: 'user'`). Extracts forwarded
   *  senders from the turn text; no-op when none are present. */
  recordUserTurn(session_id: string, text: string, contributed_at: number): void;
  /** The per-session candidate set, oldest-first — the value slice D
   *  threads into `SessionGrantMatchContext.scoped_sender_candidates`. */
  candidates(session_id: string): ReadonlyArray<ScopedSenderCandidate>;
  /** Drop a session's candidates (session delete). */
  evictSession(session_id: string): void;
}

/** D-177 slice D — resolve a gateway `channel_session_id` against the index.
 *  The index records by RAW chat `session_id`; the gateway keys sessions as
 *  `deriveChannelSessionId` strings (`chat:<session_id>`). Chat is the only
 *  v1 channel scope (5.f — messenger joins after its own stamping audit), so
 *  every non-`chat:` session resolves to NO candidates and a scoped grant
 *  degrades to asking there (fail closed). */
const CHAT_CHANNEL_SESSION_PREFIX = 'chat:';
export const scopedCandidatesForChannelSession = (
  index: SessionForwardedSenderIndex,
  channel_session_id: string,
): ReadonlyArray<ScopedSenderCandidate> => {
  if (!channel_session_id.startsWith(CHAT_CHANNEL_SESSION_PREFIX)) return [];
  return index.candidates(
    channel_session_id.slice(CHAT_CHANNEL_SESSION_PREFIX.length),
  );
};

export const createSessionForwardedSenderIndex = (
): SessionForwardedSenderIndex => {
  const bySession = new Map<string, ScopedSenderCandidate[]>();
  return {
    recordUserTurn(session_id, text, contributed_at): void {
      const emails = extractForwardedSenderEmails(text);
      if (emails.length === 0) return;
      const list = bySession.get(session_id) ?? [];
      for (const email of emails) {
        list.push({ email, contributed_at });
      }
      if (list.length > MAX_CANDIDATES_PER_SESSION) {
        list.splice(0, list.length - MAX_CANDIDATES_PER_SESSION);
      }
      bySession.set(session_id, list);
    },
    candidates(session_id): ReadonlyArray<ScopedSenderCandidate> {
      // Defensive copy — the internal list must only grow through
      // `recordUserTurn`'s extraction + eviction path (codex LOW fold).
      return [...(bySession.get(session_id) ?? [])];
    },
    evictSession(session_id): void {
      bySession.delete(session_id);
    },
  };
};
