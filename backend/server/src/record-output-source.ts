import { createHash } from 'node:crypto';
import { canonicalJSONStringify, isRecordOutputSource } from '@recued/contracts';
import type {
  EntitySchemaIngredientInput, GatewayCallAudit, IngredientManifest,
  RecipeDefinition, RecordOutputSource,
} from '@recued/contracts';
import type { IngredientCacheOptions } from '@recued/ingredients';
import { connectionRevision } from './connection-revision.js';
import type { RecordOutputSourceCache } from './record-output-source-cache.js';

interface Dependencies {
  recipe: Pick<RecipeDefinition, 'recipe_id' | 'steps' | 'prefetch_steps'>;
  manifest: (catalog: string, version?: number) => IngredientManifest | null;
  schemas: (catalog: string, version?: number) => readonly EntitySchemaIngredientInput[];
  connectionVendor: (connection_name: string) => string | null;
  /** Stable enrollment/credential/scope identity, excluding health and use time.
   * Its opaque digest binds output metadata and private cache receipts.
   * Absent => display-only source without cache proof. */
  connectionIdentity?: (connection_name: string) => unknown;
  cacheEvidence?: RecordOutputSourceCache;
}

type Call = Pick<GatewayCallAudit, 'ingredient_id' | 'operation_id' | 'connection_name'>;
interface Proof {
  version: 1;
  catalog: string;
  operation_id: string;
  connection_name: string;
  fingerprint?: string;
  sources: RecordOutputSource[];
}
const callKey = (call: Call): string => JSON.stringify([call.ingredient_id, call.operation_id, call.connection_name]);

/** One run's successful call evidence. Private cache receipts can attest an
 * unchanged API result; missing proof, derived steps, or multiple sources stay
 * manual. Neither compatibility tags nor record payloads establish provenance. */
export const createRecordOutputSources = (deps: Dependencies) => {
  const steps = new Map([...(deps.recipe.prefetch_steps ?? []), ...(deps.recipe.steps ?? [])]
    .map(step => [step.id, step]));
  const calls = new Map<string, Map<string, Proof>>();
  const prepared = new Map<string, Map<string, Proof>>();
  const failed = new Set<string>();
  const manifestFor = (catalog: string, stepId: string): IngredientManifest | null => {
    const rawVersion = (steps.get(stepId) as { ingredient_version?: unknown }).ingredient_version;
    return deps.manifest(catalog, typeof rawVersion === 'number' ? rawVersion : undefined);
  };
  const proofFor = (call: Call, stepId: string): Proof | undefined => {
    const step = steps.get(stepId)!;
    const rawVersion = (step as { ingredient_version?: unknown }).ingredient_version;
    const version = typeof rawVersion === 'number' ? rawVersion : undefined;
    const manifest = deps.manifest(call.ingredient_id, version);
    const operationKeys = Object.entries(manifest?.operations ?? {})
      .filter(([, operation]) => operation.operation_id === call.operation_id).map(([key]) => key);
    const platform = deps.connectionVendor(call.connection_name);
    if (operationKeys.length !== 1 || !manifest?.surfaces?.api?.executes?.[operationKeys[0]!]
      || platform === null) return undefined;
    const schemas = deps.schemas(call.ingredient_id, version);
    const identity = deps.connectionIdentity?.(call.connection_name);
    const revision = connectionRevision(identity);
    const candidates = new Map<string, RecordOutputSource[]>();
    for (const schema of schemas) {
      const entity = schema.entity_id;
      if (schema.ingredient_id !== call.ingredient_id || schema.wraps_vendor !== platform
        || schema.scope !== `connection.api.${platform}.${entity}`
        || !Object.values(schema.source_operations).some(operation =>
          operation.catalog === call.ingredient_id && operation.operation === operationKeys[0])) continue;
      const result: RecordOutputSource = { kind: 'api', platform,
        connection_name: call.connection_name, entity, ...(revision ? { connection_revision: revision } : {}) };
      if (!isRecordOutputSource(result)) continue;
      candidates.set(entity, [...(candidates.get(entity) ?? []), result]);
    }
    const sources = [...candidates].filter(([, matches]) => matches.length === 1)
      .sort(([a], [b]) => a.localeCompare(b)).map(([, matches]) => matches[0]!);
    const fingerprint = identity === undefined || identity === null ? undefined
      : createHash('sha256').update(canonicalJSONStringify([manifest, schemas, platform, identity])).digest('hex');
    return { version: 1, catalog: call.ingredient_id, operation_id: call.operation_id,
      connection_name: call.connection_name, sources, ...(fingerprint ? { fingerprint } : {}) };
  };
  const resultEvidence: NonNullable<IngredientCacheOptions['resultEvidence']> = ({ slug, input, stepMeta }) => {
    if (stepMeta?.recipe_id !== deps.recipe.recipe_id || !steps.has(stepMeta.step_id)
      || stepMeta.surface_dispatch !== true || input.connection_kind !== 'api') return undefined;
    const stepId = stepMeta.step_id;
    try {
      const operation = stepMeta.surface_operation_key;
      const operationId = operation && manifestFor(slug, stepId)?.operations?.[operation]?.operation_id;
      if (!operationId || typeof input.connection !== 'string') { failed.add(stepId); return undefined; }
      const call: Call = { ingredient_id: slug, operation_id: operationId, connection_name: input.connection };
      const proof = proofFor(call, stepId);
      if (!proof) { failed.add(stepId); return undefined; }
      const entries = prepared.get(stepId) ?? new Map<string, Proof>();
      const previous = entries.get(callKey(call));
      if (previous && canonicalJSONStringify(previous) !== canonicalJSONStringify(proof)) failed.add(stepId);
      entries.set(callKey(call), proof);
      prepared.set(stepId, entries);
      return {
        cached(entry) {
          try {
            const saved = deps.cacheEvidence?.get(entry);
            if (!proof.fingerprint || saved === undefined
              || canonicalJSONStringify(saved) !== canonicalJSONStringify(proof)) failed.add(stepId);
          } catch { failed.add(stepId); }
        },
        stored(entry) {
          try {
            if (!proof.fingerprint || !deps.cacheEvidence || proof.sources.length === 0) return;
            // A connection or declaration changed while the provider was running.
            // Do not mint a cache receipt for that ambiguous interval.
            if (canonicalJSONStringify(proofFor(call, stepId)) !== canonicalJSONStringify(proof)) {
              failed.add(stepId); return;
            }
            deps.cacheEvidence.set(entry, proof);
          } catch { failed.add(stepId); }
        },
      };
    } catch { failed.add(stepId); return undefined; }
  };
  const observe = (event: GatewayCallAudit): void => {
    if (event.recipe_id !== deps.recipe.recipe_id || !event.step_id || !steps.has(event.step_id)) return;
    if (event.outcome !== 'success' || event.surface_kind !== 'api') { failed.add(event.step_id); return; }
    try {
      // Cache-aware calls retain their pre-dispatch snapshot. Other direct API
      // calls capture declarations and enrollment at gateway completion.
      const captured = prepared.get(event.step_id)?.get(callKey(event));
      const proof = captured ?? proofFor(event, event.step_id);
      // Cache lookup, LRU refresh and response adaptation all await. Fence the
      // captured binding again at gateway completion, after those boundaries.
      if (!proof || (captured && canonicalJSONStringify(proofFor(event, event.step_id))
        !== canonicalJSONStringify(captured))) { failed.add(event.step_id); return; }
      const entries = calls.get(event.step_id) ?? new Map<string, Proof>();
      entries.set(canonicalJSONStringify(proof), proof);
      calls.set(event.step_id, entries);
    } catch { failed.add(event.step_id); }
  };
  const source = (entity: string, stepId: string): RecordOutputSource | undefined => {
    const entries = calls.get(stepId);
    if (failed.has(stepId) || entries?.size !== 1) return undefined;
    const result = entries.values().next().value!.sources.find(candidate => candidate.entity === entity);
    return result ? { ...result } : undefined;
  };
  return { observe, source, resultEvidence };
};
