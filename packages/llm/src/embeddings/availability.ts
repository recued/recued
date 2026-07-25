import type {
  AvailabilityStatus,
  LLMConfig,
  LLMSlot,
} from '../types.js';
import type { QuotaTracker } from '../quota.js';

/** D-174 R28 Slice C — embeddings-side availability snapshot.
 *
 *  Embeddings resolves to ONE dedicated source: `config.embeddings_slot`
 *  (a full LLMSlot whose `model` field carries the embeddings model). There
 *  is no free-pool-of-embeddings, and slot_1 / slot_2 are never consulted —
 *  embeddings is a recipe + housekeeping capability deliberately kept off
 *  the chat match path. (Pre-Slice-C this walked slot_1 → slot_2 → pool and
 *  keyed on a per-slot `embeddings_model` field; that field is gone.)
 *
 *  The snapshot is the input to (a) the embeddings resolver in
 *  `executor.ts` and (b) the housekeeping probe
 *  (`probeEmbeddingsPathAvailability` in
 *  `backend/server/src/housekeeping/ai-availability.ts`). Both build the
 *  snapshot once and reason from it.
 *
 *  Cooldown is keyed under the fixed `EMBEDDINGS_SLOT_KEY` on the shared
 *  `QuotaTracker`, so a 429 the embeddings provider returns deranks the
 *  slot until the cooldown window closes. */
export const EMBEDDINGS_SLOT_KEY = 'embeddings_slot';

export interface EmbeddingsAvailabilitySnapshot {
  embeddings_slot: AvailabilityStatus;
}

export interface BuildEmbeddingsAvailabilityDeps {
  config: LLMConfig;
  quota: QuotaTracker;
}

/** Compute the snapshot of the embeddings slot's live state. Pure: no I/O,
 *  no mutation of `config` or `quota`. */
export const buildEmbeddingsAvailability = (
  deps: BuildEmbeddingsAvailabilityDeps,
): EmbeddingsAvailabilitySnapshot => ({
  embeddings_slot: embeddingsSlotStatus(deps.config.embeddings_slot, deps.quota),
});

/** Embeddings-slot availability. Order of checks matters — the reason
 *  returned is the *first* failed check, which keeps the UI message
 *  specific. A missing slot and a slot missing its api_key both read as
 *  `no_key` (nothing usable configured); a slot with a key but no model
 *  reads as `no_embeddings_model`. An Anthropic-provider slot still passes
 *  here (key + model present) and surfaces unavailable at execute time via
 *  the adapter stub — there's no public Anthropic embeddings model to gate
 *  on at availability time. */
const embeddingsSlotStatus = (
  slot: LLMSlot | undefined,
  quota: QuotaTracker,
): AvailabilityStatus => {
  if (!slot) return { available: false, reason: 'no_key' };
  if (!slot.api_key) return { available: false, reason: 'no_key' };
  if (!slot.model) return { available: false, reason: 'no_embeddings_model' };
  if (quota.isInCooldown(EMBEDDINGS_SLOT_KEY)) {
    return { available: false, reason: 'quota_exhausted' };
  }
  return { available: true };
};
