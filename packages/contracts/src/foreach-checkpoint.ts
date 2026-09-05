import { canonicalJSONStringifyStrict } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';

/** Domain-separated digest of the complete resolved foreach source. The
 * checkpoint retains results only for the completed prefix, so this digest is
 * what prevents an unreviewed change to the current or remaining items from
 * inheriting the step-scoped approval. */
export const hashForeachCheckpointSource = (source: readonly unknown[]): string =>
  sha256Hex(`recued:foreach-checkpoint-source:v1\n${canonicalJSONStringifyStrict(source)}`);

/** Durable progress for a gate raised inside one foreach step. Completed
 * iterations are retained so approval resumes at the exact paused item and the
 * final step result remains the whole aggregate. Kept outside the checkpoint
 * and signal modules so those two contracts do not form a type cycle. */
export interface ForeachCheckpointResult {
  ok: boolean;
  /** The authored per-item filter skipped this item before any dispatch. */
  skipped?: boolean;
  result?: unknown;
  error?: unknown;
  item?: unknown;
}

export interface ForeachCheckpointProgress {
  /** Must equal the checkpoint's gated_step_id. */
  step_id: string;
  /** Index of the item that raised the gate (and therefore runs next). */
  next_index: number;
  /** Original resolved source length; a changed source fails closed. */
  source_length: number;
  /** SHA-256 of every resolved source item, including the current and
   * remaining suffix. Length alone is not an authority boundary. */
  source_hash: string;
  /** Exact per-item envelopes for indices [0, next_index). */
  results: ForeachCheckpointResult[];
}
