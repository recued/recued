import { IngredientError, type KernelDispatchers } from '@recued/ingredients';
import type { ExecutionSource } from '@recued/contracts';
import type { GatedReadGrantResolver } from './read-grant-checker.js';
import type { SituationAccess } from './situations/access.js';
import { createReadScope } from './situations/read-scope.js';

/** Generic recipe reads cannot bypass the native tools' two grant axes. The
 * origin comes from StepMeta, never authored input. UI CRUD uses its paired door. */
export const assetKernelReadGates = (
  dispatchers: Pick<KernelDispatchers, 'workEntityList' | 'workEntityGet'>,
  grants: GatedReadGrantResolver | undefined,
  access?: SituationAccess,
): Pick<KernelDispatchers, 'workEntityList' | 'workEntityGet'> => {
  const admit = (kind: string, source: ExecutionSource | undefined): void => {
    if (kind !== 'asset') return;
    const checker = source && grants?.resolveForSource(source);
    if (!checker?.isVerbOpGranted('core.work-entity.read') || !checker.isCollectionReadGranted('asset')) {
      throw new IngredientError('INGREDIENT_SCOPE_INSUFFICIENT', 'Asset reads require core.work-entity.read and data.asset for the actual execution source');
    }
  };
  return {
    ...(dispatchers.workEntityList ? { workEntityList: async (input) => {
      admit(input.kind, input.origin_execution_source);
      const scope = access && createReadScope(access, input.origin_execution_source);
      if (scope?.limited) {
        const visible: Awaited<ReturnType<NonNullable<KernelDispatchers['workEntityList']>>>['entities'] = [];
        for (let offset = 0; ; offset += 500) {
          const page = await dispatchers.workEntityList!({ ...input, offset, limit: 500 });
          visible.push(...page.entities.filter(row => scope.allows({ collection: input.kind, id: row.id })).map(row => scope.cleanWork(row)));
          if (page.entities.length < 500) break;
          if (offset >= 20_000) throw new IngredientError('BAD_INPUT', 'Narrow the source before reading this many scoped records');
        }
        // No whole-collection count is returned. Page only after the boundary.
        const current = createReadScope(access!, input.origin_execution_source);
        const rows = visible.filter(row => current.allows({ collection: input.kind, id: row.id }));
        return { entities: rows.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 100)), total: rows.length };
      }
      return dispatchers.workEntityList!(input);
    } } : {}),
    ...(dispatchers.workEntityGet ? { workEntityGet: async (input) => {
      admit(input.kind, input.origin_execution_source);
      const result = await dispatchers.workEntityGet!(input);
      const scope = access && createReadScope(access, input.origin_execution_source);
      if (result.entity && scope?.limited) {
        if (!scope.allows({ collection: input.kind, id: result.entity.id })) throw new IngredientError('INGREDIENT_SCOPE_INSUFFICIENT', 'This record is outside the contract spheres. This is a permission refusal, not evidence that it does not exist.');
        return { ...result, entity: scope.cleanWork(result.entity) };
      }
      return result;
    } } : {}),
  };
};
