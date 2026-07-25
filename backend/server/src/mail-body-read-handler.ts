/** D-145 PA10 follow-on — `mail-body-read` ingredient handler.
 *
 *  Closes the PA10 CAS gap. `mail-get` returns the raw CollectionRecord,
 *  which carries `body_inline` (≤64 KB) OR a `blob_hash` pointer
 *  (>64 KB, spilled to content-addressed storage) — never both. Recipes
 *  that read `{{step.record.body_inline}}` therefore get nothing for the
 *  large messages that spilled to CAS, and those mails are silently
 *  skipped by downstream LLM-extraction steps. mail-body-read
 *  materializes the body either way so the recipe gets usable text
 *  regardless of size.
 *
 *  Materialization is deliberately NOT the housekeeping `fetchMailBody`
 *  helper: that one collapses an empty body to `null` (a producer
 *  "no signal, skip the row" convention), which is the wrong contract
 *  for a faithful recipe-facing read where an empty body must stay
 *  observable as `''` (distinct from a missing record or an unresolvable
 *  blob). `materializeMailBody` below is the recipe-facing variant.
 *
 *  Backs the kernel `mail-body-read` dispatcher only; there is no
 *  `mail.body_read` rpc surface yet (no client display consumer asks for
 *  materialized bodies), so this module mirrors `handleMailGet`'s
 *  deps+args shape without the `makeMailGetHandlers` rpc registration.
 *  Adding the rpc later is purely additive (contract spec + handler
 *  slice + wiring). */

import { RpcError } from '@recued/contracts';
import type { CollectionRecord } from '@recued/contracts';
import type { CollectionRegistry } from './collections/registry.js';
import type { BlobStore } from './storage/blob-store.js';

export interface MailBodyReadDeps {
  registry: CollectionRegistry;
  blobs: BlobStore;
}

export interface MailBodyReadResult {
  /** Materialized body text. Empty-but-present bodies are returned as
   *  `''`; `null` means the record is missing, carries no body at all,
   *  or its CAS blob is unresolvable. */
  body: string | null;
  /** True iff the record exists in the collection (independent of body
   *  presence) — lets a recipe distinguish a stale/unknown record_id
   *  from a legitimately empty body. */
  found: boolean;
  /** The record's body size in bytes per the warehouse row (the full,
   *  pre-truncation size); 0 when the record is missing. */
  size_bytes: number;
  /** True iff the body was cut by `max_chars` or by the hard ceiling. */
  truncated: boolean;
}

/** Hard ceiling on the returned body length, in characters (UTF-16 code
 *  units). A safety backstop, not a functional limit: it bounds how much
 *  text a single call can pull into recipe step state / audit rows even
 *  when the caller omits `max_chars` and the message body is
 *  pathologically large. Real mail bodies sit far below this; recipes
 *  feeding an `ai-*` step set a much smaller `max_chars` (≈32K) of their
 *  own.
 *
 *  Note: this caps the *returned* string. The CAS blob is still read into
 *  memory in full first — that is the existing `BlobStore.get` /
 *  housekeeping `fetchMailBody` contract (no partial-read API). Bounding
 *  the read itself would need a new ranged blob-read primitive; out of
 *  scope here. */
export const MAX_BODY_CHARS = 1_000_000;

/** Recipe-facing body materializer. Inline first (any string, INCLUDING
 *  `''`, so an empty body stays observable), then CAS via `blob_hash`.
 *  Returns `null` only when the record carries no body at all, or when
 *  the blob is unresolvable (CAS miss). */
export const materializeMailBody = async (
  record: CollectionRecord,
  blobs: BlobStore,
): Promise<string | null> => {
  if (typeof record.body_inline === 'string') {
    return record.body_inline;
  }
  if (typeof record.blob_hash === 'string' && record.blob_hash.length > 0) {
    const buf = await blobs.get(record.blob_hash);
    return buf === null ? null : buf.toString('utf8');
  }
  return null;
};

export const handleMailBodyRead = async (
  deps: MailBodyReadDeps,
  args: { slug?: unknown; record_id?: unknown; max_chars?: unknown },
): Promise<MailBodyReadResult> => {
  if (typeof args.slug !== 'string' || args.slug.length === 0) {
    throw new RpcError('bad_request', 'mail.body_read: slug is required');
  }
  if (typeof args.record_id !== 'string' || args.record_id.length === 0) {
    throw new RpcError('bad_request', 'mail.body_read: record_id is required');
  }
  let maxChars: number | undefined;
  if (args.max_chars != null) {
    if (
      typeof args.max_chars !== 'number'
      || !Number.isInteger(args.max_chars)
      || args.max_chars <= 0
    ) {
      throw new RpcError(
        'bad_request',
        'mail.body_read: max_chars must be a positive integer',
      );
    }
    maxChars = args.max_chars;
  }

  const collection = deps.registry.get('mail', args.slug);
  if (!collection) {
    throw new RpcError(
      'collection_not_found',
      `mail.body_read: instance '${args.slug}' not found`,
    );
  }

  const record = collection.get(args.record_id);
  if (!record) {
    return { body: null, found: false, size_bytes: 0, truncated: false };
  }

  const full = await materializeMailBody(record, deps.blobs);
  if (full === null) {
    return { body: null, found: true, size_bytes: record.size_bytes, truncated: false };
  }

  // Cap the returned body at the caller's `max_chars` (when given) and
  // always at the hard ceiling. `Math.min` collapses both bounds, so the
  // ceiling applies even when `max_chars` is omitted or exceeds it.
  const cap = maxChars !== undefined ? Math.min(maxChars, MAX_BODY_CHARS) : MAX_BODY_CHARS;
  const truncated = full.length > cap;
  return {
    body: truncated ? full.slice(0, cap) : full,
    found: true,
    size_bytes: record.size_bytes,
    truncated,
  };
};
