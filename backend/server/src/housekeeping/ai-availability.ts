/** D-123 follow-on — pre-confirm AI-availability probe.
 *
 *  Run-Now dialog calls this through `housekeeping.status.read`'s
 *  `getEnrichmentInfo` for any producer with a positive
 *  `estimate_per_record_tokens()`. When the probe says no path is
 *  available, the dialog renders the warning state ("Configure AI in
 *  Settings → AI before running") + disables the Run Now button. The
 *  producer's race-window LLM-error throw is the safety net for
 *  "user removed the key between probe and confirm."
 *
 *  Server-side runtimes have no web-chat path (`webChatSupported:
 *  false`) — only slot_1 / slot_2 / api free-pool entries count.
 *  Reasons:
 *    - `no_byok_no_freepool` — neither a configured slot nor any
 *      api free-pool entry exists. The user hasn't set up AI at all.
 *    - `quota_exhausted` — at least one path exists but every
 *      candidate is in cooldown / has hit its daily cap. Resolves
 *      automatically once a window closes.
 *
 *  Pure: takes a `LLMConfig` snapshot + a quota tracker, returns the
 *  probe result. `bin.ts` closes over the live config + tracker so a
 *  Settings → AI write is reflected on the next status read. */

import {
  buildAvailability,
  buildEmbeddingsAvailability,
  type AvailabilitySnapshot,
  type EmbeddingsAvailabilitySnapshot,
  type LLMConfig,
  type QuotaTracker,
} from '@recued/llm';
import type { WebChatTab } from '@recued/contracts';

export type AiPathReason = 'no_byok_no_freepool' | 'quota_exhausted';

export interface AiPathAvailability {
  available: boolean;
  reason?: AiPathReason;
}

/** D-131 Phase 3 / D-174 R28 Slice C — embeddings probe reasons.
 *
 *  Distinct from `AiPathReason` because the remediation diverges:
 *  `no_embeddings_model` means "an embeddings slot exists (with a key) but
 *  its model is unset — finish configuring it", a different help message
 *  than the chat-side `no_byok_no_freepool` ("no embeddings configured at
 *  all"). */
export type EmbeddingsPathReason =
  | 'no_byok_no_freepool'
  | 'no_embeddings_model'
  | 'quota_exhausted';

export interface EmbeddingsPathAvailability {
  available: boolean;
  reason?: EmbeddingsPathReason;
}

const emptyTabProbe = async (): Promise<Set<WebChatTab>> => new Set();

export const probeAiPathAvailability = async (
  config: LLMConfig | undefined,
  quota: QuotaTracker,
): Promise<AiPathAvailability> => {
  if (!config) return { available: false, reason: 'no_byok_no_freepool' };
  const snapshot: AvailabilitySnapshot = await buildAvailability({
    config,
    quota,
    tabProbe: emptyTabProbe,
    webChatSupported: false,
  });
  if (snapshot.slot_1.available) return { available: true };
  if (snapshot.slot_2.available) return { available: true };
  for (const entry of snapshot.free_pool) {
    if (entry.status.available) return { available: true };
  }
  // No path resolves — distinguish "user has no key" from "user has
  // keys but every path is in cooldown / over-cap".
  const slot1Reason = snapshot.slot_1.available ? null : snapshot.slot_1.reason;
  const slot2Reason = snapshot.slot_2.available ? null : snapshot.slot_2.reason;
  const anyQuotaExhausted =
    slot1Reason === 'quota_exhausted' ||
    slot2Reason === 'quota_exhausted' ||
    snapshot.free_pool.some(
      (e) => !e.status.available && e.status.reason === 'quota_exhausted',
    );
  return {
    available: false,
    reason: anyQuotaExhausted ? 'quota_exhausted' : 'no_byok_no_freepool',
  };
};

/** D-131 Phase 3 — embeddings-side path availability probe.
 *
 *  Parallel to `probeAiPathAvailability` but scoped to the embeddings
 *  surface. Run-Now dialog calls this for any producer whose output
 *  schema contains a vector — the future `embedding` mail producer
 *  (A.3) is the first such producer, with `semantic_cluster` (A.17)
 *  to follow.
 *
 *  Reasons (ordered by user-facing specificity):
 *    - `no_byok_no_freepool` — no embeddings slot configured at all.
 *      Remediation: "Set up an embeddings model in Settings → AI/Models."
 *    - `no_embeddings_model` — an embeddings slot exists (with a key) but
 *      its model is unset. Remediation: "Finish configuring the embeddings
 *      model on the slot."
 *    - `quota_exhausted` — the embeddings slot is in cooldown / over
 *      daily-cap. Resolves automatically.
 *
 *  Synchronous because `buildEmbeddingsAvailability` has no I/O (no
 *  tabProbe — embeddings has no web-chat surface). */
export const probeEmbeddingsPathAvailability = (
  config: LLMConfig | undefined,
  quota: QuotaTracker,
): EmbeddingsPathAvailability => {
  if (!config) return { available: false, reason: 'no_byok_no_freepool' };
  const snapshot: EmbeddingsAvailabilitySnapshot = buildEmbeddingsAvailability({
    config,
    quota,
  });
  const status = snapshot.embeddings_slot;
  if (status.available) return { available: true };

  // D-174 R28 Slice C — one dedicated source; map its single reason → the
  // probe reason.
  switch (status.reason) {
    case 'quota_exhausted':
      // The slot is configured but in cooldown / over-cap — wait it out.
      return { available: false, reason: 'quota_exhausted' };
    case 'no_embeddings_model':
      // A slot is present (with a key) but its model is unset — finish
      // configuring the embeddings model.
      return { available: false, reason: 'no_embeddings_model' };
    default:
      // No embeddings slot configured at all (`no_key`) — direct the user
      // to Settings → AI/Models to set one up.
      return { available: false, reason: 'no_byok_no_freepool' };
  }
};
