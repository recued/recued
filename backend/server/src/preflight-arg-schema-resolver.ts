/** Runtime catalog lookup adapter; pure field resolution is shared with offline authoring. */
import type { ArgEditField } from '@recued/contracts';
import type { ArgEditSchemaResolverDeps, ResolvedOperationCatalogEntry } from '@recued/ingredient-authoring';
export { resolveArgEditSchema } from '@recued/ingredient-authoring';
export type { ArgEditSchema, ResolvedArgEditField, ResolvedOperationCatalogEntry, ResolvedTargetField, ArgEditSchemaResolverDeps } from '@recued/ingredient-authoring';

/** Build the runtime lookup from injected installed request-schema and
 * preserved editable-argument readers. Either reader may be absent; an
 * operation unknown to both resolves to null. Field resolution stays in
 * the shared pure helper and this adapter performs no writes. */
export const createOperationCatalogLookup = (readers: {
  readonly getRequestSchema?: (operationId: string) => unknown;
  readonly getEditableArgs?: (operationId: string) => readonly ArgEditField[] | null | undefined;
}): ArgEditSchemaResolverDeps['lookupOperation'] => {
  return (operationId: string): ResolvedOperationCatalogEntry | null => {
    const editable_args = readers.getEditableArgs?.(operationId) ?? undefined;
    const request_schema = readers.getRequestSchema?.(operationId);
    if (editable_args === undefined && request_schema === undefined) return null;
    return {
      ...(editable_args !== undefined ? { editable_args } : {}),
      ...(request_schema !== undefined ? { request_schema } : {}),
    };
  };
};
