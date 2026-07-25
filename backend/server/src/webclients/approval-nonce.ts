/** D-148 § A.4.3 — server-side approval nonce store.
 *
 *  Issues a single-use nonce when an approval request is broadcast to
 *  a webclient; verifies the nonce on the inbound `approval.respond`
 *  rpc; consumes the nonce on the first successful verify.
 *
 *  Binding: `(approval_id, responder_client_id)`. Approvals that
 *  fan out to multiple webclients receive distinct nonces per
 *  client; resolving on one client cannot replay against the others
 *  (each carries its own nonce + `responder_client_id`).
 *
 *  In-memory; survives only as long as the server process does.
 *  Approvals themselves are short-lived (5-min default per
 *  `APPROVAL_AUTO_DENY_DEFAULT_MS`); a server restart prompts re-
 *  request via the existing approval substrate (D-119 Phase 10).
 *
 *  The nonce TTL (`APPROVAL_NONCE_TTL_MS`) is independent of the
 *  approval's `expires_at` — it caps the window during which a
 *  forgotten + re-discovered nonce can be redeemed. The two windows
 *  cooperate: the smaller wins.
 */

import {
  APPROVAL_NONCE_TTL_MS,
  type ApprovalNonceEnvelope,
  type ApprovalNonceErrorCode,
  type ApprovalResponseWire,
} from '@recued/contracts';

export interface ApprovalNonceStore {
  /** Issue a fresh nonce envelope for a given approval + responder
   *  tuple. Idempotent on repeat issue: the same caller asking again
   *  for the same tuple gets a freshened nonce + extended `expires_at`.
   *  Each fresh issue invalidates the prior nonce for the same
   *  tuple — replay against the prior nonce after a re-issue fails
   *  with `approval_nonce_invalid`. */
  issue(args: {
    approval_id: string;
    responder_client_id: string;
    nonce_bytes?: Uint8Array;
    now?: number;
  }): ApprovalNonceEnvelope;
  /** Verify + consume an inbound response envelope. Returns ok on
   *  success (nonce removed from the store); typed error otherwise. */
  consume(
    response: ApprovalResponseWire,
    args: { responder_client_id: string; now?: number },
  ): { ok: true } | { ok: false; error: ApprovalNonceErrorCode };
  /** Snapshot — used by Settings + tests. */
  list(): ApprovalNonceEnvelope[];
  /** Drop all pending nonces (test reset). */
  clear(): void;
}

const NONCE_BYTES = 16;

const toB64 = (bytes: Uint8Array): string => {
  if (typeof globalThis.btoa === 'function') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return globalThis.btoa(s);
  }
  return Buffer.from(bytes).toString('base64');
};

const generateNonce = (override?: Uint8Array): string => {
  if (override) return toB64(override);
  const bytes = new Uint8Array(NONCE_BYTES);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < NONCE_BYTES; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return toB64(bytes);
};

/** Codex P3 #6 fold — length-prefix tuple key. A naive `${a}|${b}`
 *  format collides when an id contains the `|` character; the length
 *  prefix removes the ambiguity (every byte position is unambiguously
 *  attributable to one of the two components). */
const tupleKey = (approval_id: string, responder_client_id: string): string =>
  `${approval_id.length}:${approval_id}|${responder_client_id.length}:${responder_client_id}`;

export const createApprovalNonceStore = (
  options: { now?: () => number; ttl_ms?: number } = {},
): ApprovalNonceStore => {
  const clock = options.now ?? Date.now;
  const ttl = options.ttl_ms ?? APPROVAL_NONCE_TTL_MS;
  /** Live envelopes keyed on `(approval_id, responder_client_id)`. */
  const live = new Map<string, ApprovalNonceEnvelope>();
  /** Reverse index from `nonce` → tuple key. Lets the consumer
   *  detect "this nonce was rotated by a fresh issue" without
   *  needing to scan the map. */
  const nonce_index = new Map<string, string>();
  /** Consumed nonce ledger — guards replay. Entries past their TTL
   *  are swept lazily. */
  const consumed = new Map<string, number>();

  const sweep = (now: number): void => {
    for (const [key, env] of live) {
      if (now > env.expires_at) {
        live.delete(key);
        nonce_index.delete(env.nonce);
      }
    }
    for (const [n, t] of consumed) {
      if (now - t > ttl) consumed.delete(n);
    }
  };

  return {
    issue(args) {
      const now = args.now ?? clock();
      sweep(now);
      const key = tupleKey(args.approval_id, args.responder_client_id);
      const prior = live.get(key);
      if (prior) {
        nonce_index.delete(prior.nonce);
      }
      const nonce = generateNonce(args.nonce_bytes);
      const envelope: ApprovalNonceEnvelope = {
        nonce,
        approval_id: args.approval_id,
        responder_client_id: args.responder_client_id,
        expires_at: now + ttl,
      };
      live.set(key, envelope);
      nonce_index.set(nonce, key);
      return envelope;
    },
    consume(response, args) {
      const now = args.now ?? clock();
      // Replay guard — has this nonce already been consumed?
      if (consumed.has(response.nonce)) {
        return { ok: false, error: 'approval_nonce_consumed' };
      }
      // IMPORTANT: lookup BEFORE sweep so an expired entry surfaces
      // as `approval_nonce_expired` rather than `approval_nonce_invalid`
      // (which would conflate "never existed" with "existed-but-expired").
      const key = nonce_index.get(response.nonce);
      if (!key) {
        return { ok: false, error: 'approval_nonce_invalid' };
      }
      const env = live.get(key);
      if (!env) {
        return { ok: false, error: 'approval_nonce_invalid' };
      }
      if (env.responder_client_id !== args.responder_client_id) {
        return { ok: false, error: 'approval_nonce_mismatched_client' };
      }
      if (env.approval_id !== response.approval_id) {
        return { ok: false, error: 'approval_nonce_mismatched_approval' };
      }
      if (now > env.expires_at) {
        live.delete(key);
        nonce_index.delete(env.nonce);
        return { ok: false, error: 'approval_nonce_expired' };
      }
      // Consume.
      live.delete(key);
      nonce_index.delete(env.nonce);
      consumed.set(env.nonce, now);
      // Drop unrelated past-TTL entries on the same call so the
      // store doesn't grow without bound.
      sweep(now);
      return { ok: true };
    },
    list() {
      return [...live.values()];
    },
    clear() {
      live.clear();
      nonce_index.clear();
      consumed.clear();
    },
  };
};
