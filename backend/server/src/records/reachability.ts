/** The same namespace and installed operation-group gate serves preparation
 * and actual catalog dispatch. Owner review never creates pack reachability. */
import type { IngredientManifest, RecordsExecutionBinding, ScanFn } from '@recued/contracts';
import type { RecordsStore } from './store.js';

export const recordsOperationReachable = (deps: {
  records: Pick<RecordsStore, 'getNamespace'>;
  manifest(slug: string): IngredientManifest | null | undefined;
  scan?: ScanFn;
}, principal: string | null, ingredientId: string, operationId: string, binding: RecordsExecutionBinding): boolean => {
  if (principal === null) return false;
  const namespace = deps.records.getNamespace(binding.owner);
  if (!(namespace?.state.state === 'ready'
    && namespace.state.version === binding.pack_version
    && namespace.state.storage_schema_hash === binding.storage_schema_hash
    && namespace.state.declaration_hash === binding.declaration_hash)) return false;
  const manifest = deps.manifest(ingredientId);
  const groups = manifest?.operations?.[operationId]?.groups ?? [];
  if (!manifest?.surfaces?.records || groups.length === 0 || !deps.scan) return false;
  const grantedGroups = new Set(deps.scan('grant', [ingredientId, ingredientId, ingredientId])
    .filter(row => row.segments.length === 4 && row.segments[0] === ingredientId
      && row.segments[1] === ingredientId && row.segments[2] === ingredientId && row.value.allowed === true)
    .map(row => row.segments[3]));
  return groups.some(groupId => manifest.operation_groups?.[groupId]?.operations.includes(operationId) === true
    && grantedGroups.has(groupId));
};
