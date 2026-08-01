import { canonicalJSONStringify, sha256Hex } from '@recued/crypto';
import type {
  RecordsNamespaceView,
  RecordsPackRef,
} from '@recued/contracts';

const digest = (value: unknown): string => sha256Hex(canonicalJSONStringify(value));

/** Stable subset of namespace state that §9.1 requires an approval to bind.
 * updated_at is deliberately excluded: every semantic mutable fact is carried
 * explicitly, while wall-clock representation is not transition authority. */
export const recordsNamespaceReviewDigest = (
  namespace: RecordsNamespaceView,
): string => digest({
  owner: namespace.owner,
  state: namespace.state,
  activation_generation: namespace.activation_generation,
  state_generation: namespace.state_generation,
  quota: namespace.quota,
  schema: namespace.schema,
  artifact_digest: namespace.artifact_digest,
  subscriber_digest: namespace.subscriber_digest,
});

export const recordsOwnerPolicyDigest = (policy: unknown): string => digest(policy);

export interface RecordsRoutePlanDigestInput {
  owner: RecordsPackRef;
  current_version: number;
  target_version: number;
  current_artifact_digest: string;
  target_artifact_digest: string;
  target_storage_schema_hash: string;
  migration_plans: readonly unknown[];
  migration_artifacts: readonly unknown[];
  pending_event_disposition: 'drain_or_explicit_retire';
}

/** Binds every deterministic input from which the coordinator selects its
 * finite route. Any plan/body/artifact drift therefore invalidates review even
 * if the marketplace manifest's recipe refs did not change. */
export const recordsRoutePlanDigest = (
  input: RecordsRoutePlanDigestInput,
): string => digest(input);

export const recordsManifestReviewHash = (
  manifest: unknown,
  recordsFence?: unknown,
): string => digest(
  recordsFence === undefined
    ? manifest
    : { manifest, records_review_fence: recordsFence },
);
