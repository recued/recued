/** D-149 P3 Pass-3 — `preview_hash` substrate for create-on-preview
 *  gating.
 *
 *  The pre-Pass-3 `reception.endpoint.create` rpc let any caller mint
 *  a new endpoint from a packet_declaration with no reading-back of
 *  the visitor-facing surface. D-151 design review surfaced the trap:
 *  Mary could create an endpoint thinking it exposed X, but the actual
 *  rendered visitor surface might silently expose Y (a bad
 *  `fields_visible_override` or a mis-typed `source_query_ref` could
 *  reshape what visitors see without surfacing a difference at the
 *  rpc layer).
 *
 *  Pass-3 adds the `reception.endpoint.preview_draft` rpc that produces
 *  the same render the production handler would produce + the
 *  canonical SHA-256 of the create-input shape. The substrate stores
 *  the hash with a 10-minute TTL; `reception.endpoint.create` REQUIRES
 *  the caller to supply the same hash, gating "user saw this exact
 *  config in preview before clicking Create."
 *
 *  Canonicalization: sorted JSON via the existing
 *  `canonicalJSONStringify` (from `@recued/crypto`) — the same
 *  canonicalizer the audit-signing path uses. Same canonical shape →
 *  same hash; any non-key-order edit (a single character change in
 *  `packet_declaration.fields_visible_override`) flips the hash.
 *
 *  Spec: docs/d-149-spec.md § A.3 line 380 + Pass-3 note. */

import { createHash } from 'node:crypto';
import { canonicalJSONStringify } from '@recued/crypto';
import type {
  PacketDeclaration,
  ReceptionEndpointKind,
} from '@recued/contracts';

/** Per Pass-3 — preview-hash TTL. Long enough for Mary to walk through
 *  the preview + confirm; short enough that a stale hash isn't a
 *  surface for replay attacks (an attacker who got a hash 24h ago
 *  can't use it to bypass current preview validation). */
export const PREVIEW_HASH_TTL_MS = 10 * 60 * 1000;

export interface PreviewHashInput {
  readonly kind: ReceptionEndpointKind;
  readonly packet_declaration: PacketDeclaration;
  readonly expires_at?: number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Canonical SHA-256 of the preview input. Used by both
 *  `reception.endpoint.preview_draft` (emit) and
 *  `reception.endpoint.create` (verify). */
export const computePreviewHash = (input: PreviewHashInput): string => {
  const canonical: PreviewHashInput = {
    kind: input.kind,
    packet_declaration: input.packet_declaration,
  };
  if (input.expires_at !== undefined) {
    (canonical as { expires_at?: number | null }).expires_at = input.expires_at;
  }
  if (input.metadata !== undefined) {
    (canonical as { metadata?: Readonly<Record<string, unknown>> }).metadata =
      input.metadata;
  }
  const bytes = canonicalJSONStringify(canonical);
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
};

interface PreviewHashEntry {
  readonly hash: string;
  readonly expires_at: number;
}

export interface PreviewHashStore {
  /** Stamp a hash with a 10-minute expiry; returns the absolute expiry
   *  (now + TTL). The renderer surfaces this back to Mary so the UI
   *  can disable the Create button after the window closes. */
  remember(input: { hash: string; now: number }): { expires_at: number };
  /** Validate a caller-supplied hash. Returns the validation outcome
   *  the rpc layer maps to closed-list `RpcError.code`. */
  validate(input: {
    hash: string;
    now: number;
  }): 'ok' | 'preview_hash_unknown' | 'preview_hash_expired';
  /** Diagnostic — count of remembered hashes (drops expired ones). */
  size(now: number): number;
  /** Test helper — wipe the in-memory store. */
  reset(): void;
}

/** In-memory hash store. Per-pair; never persists across restarts (the
 *  preview window is 10 min; expecting Mary to retain the preview
 *  across a server restart is operationally implausible). */
export const createPreviewHashStore = (): PreviewHashStore => {
  const entries = new Map<string, PreviewHashEntry>();

  const sweepExpired = (now: number): void => {
    for (const [hash, entry] of entries) {
      if (entry.expires_at <= now) entries.delete(hash);
    }
  };

  return {
    remember({ hash, now }) {
      sweepExpired(now);
      const expires_at = now + PREVIEW_HASH_TTL_MS;
      entries.set(hash, { hash, expires_at });
      return { expires_at };
    },

    validate({ hash, now }) {
      // Order matters: check the entry's expiry BEFORE the global sweep
      // so an expired entry surfaces as `preview_hash_expired` (not
      // `preview_hash_unknown` post-sweep). The sweep still runs after
      // to keep the store size bounded; expired entries lookup-up
      // explicitly return the typed expiry result.
      const entry = entries.get(hash);
      if (!entry) {
        sweepExpired(now);
        return 'preview_hash_unknown';
      }
      if (entry.expires_at <= now) {
        entries.delete(hash);
        sweepExpired(now);
        return 'preview_hash_expired';
      }
      sweepExpired(now);
      // Per Pass-3 design: hashes are single-use to avoid replay. The
      // rpc consumer enforces single-use by deleting on successful
      // `create`; if the caller's `create` then fails downstream (e.g.,
      // validator catches a per-kind ceiling), they'll have to re-run
      // preview to get a fresh hash. That's correct — a re-run of
      // preview re-confirms Mary's understanding of the visible
      // surface.
      entries.delete(hash);
      return 'ok';
    },

    size(now) {
      sweepExpired(now);
      return entries.size;
    },

    reset() {
      entries.clear();
    },
  };
};
