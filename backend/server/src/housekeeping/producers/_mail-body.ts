/** Shared mail-body helpers for AI-driven mail-scope housekeeping
 *  producers. Extracted from `summary.ts` + `purpose.ts` once the third
 *  consumer (`action_items`) demonstrated the shape generalises.
 *
 *  Each producer keeps its own `MIN_BODY_CHARS` constant since the
 *  floor varies by signal density: summary needs ≥100 chars to be
 *  worthwhile, purpose can classify bodies as short as 50 chars,
 *  action_items wants ≥100 chars to capture context. The body-fetch
 *  + truncation logic itself is identical across all three. */

import type { CollectionRecord } from '@recued/contracts';

import type { BlobStore } from '../../storage/blob-store.js';

/** Hard cap on body characters fed to the LLM. ~32K chars is ~8K
 *  tokens at typical English ratios — well under every contracted-AI
 *  context window. The truncation is a soft byte cut (UTF-16 code
 *  units, no grapheme awareness); summarisation / classification /
 *  extraction are all forgiving so the occasional split-emoji at the
 *  boundary is benign. */
export const MAX_INPUT_CHARS = 32_000;

/** Read the body of a mail record. Inline first (≤64 KB cutoff), then
 *  CAS-stored bodies via `blob_hash`. Returns null when neither path
 *  resolves — caller's contract is "no body, no signal" → return null
 *  from the producer to skip the row entirely. */
export const fetchMailBody = async (
  record: CollectionRecord,
  blobs: BlobStore,
): Promise<string | null> => {
  if (typeof record.body_inline === 'string' && record.body_inline.length > 0) {
    return record.body_inline;
  }
  if (typeof record.blob_hash === 'string' && record.blob_hash.length > 0) {
    const buf = await blobs.get(record.blob_hash);
    if (buf === null) return null;
    return buf.toString('utf8');
  }
  return null;
};

/** Truncate body for LLM input. Soft cut at `MAX_INPUT_CHARS`. */
export const truncateForLlm = (s: string): string =>
  s.length <= MAX_INPUT_CHARS ? s : s.slice(0, MAX_INPUT_CHARS);
