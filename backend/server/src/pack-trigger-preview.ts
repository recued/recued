/** D-296 — the automations an update will SWITCH OFF, so the update dialog can
 *  warn before the owner presses Update.
 *
 *  An update that changes a recipe's trigger declaration re-creates its row.
 *  The one unambiguous case — one trigger before, one after, same recipe —
 *  now carries the armed state and settings over (`carriedTriggerFor`); any
 *  other change of an ARMED trigger still lands disarmed, and silently did.
 *  This names those, by the SAME declarations and the SAME pairing rule the
 *  reconcile will apply, so the warning cannot disagree with what happens. */

import type { ConnectionVendorEntity, EventTrigger, RecipeDefinition } from '@recued/contracts';

import {
  carriedTriggerFor,
  declarationKey,
  recipeTriggerDeclarations,
} from './triggers/declarative-reconciler.js';
import type { EventTriggersStore } from './triggers/store.js';

/** Published by the stage that composes the trigger substrate. */
export interface TriggerPreviewDeps {
  store: Pick<EventTriggersStore, 'list' | 'ownerEnabled'>;
  getVendorEntities: () => ReadonlyArray<Pick<ConnectionVendorEntity, 'vendor' | 'entity' | 'crm_alias'>>;
}

const rowKey = (row: EventTrigger): string =>
  declarationKey({
    recipe_id: row.recipe_id,
    publisher_id: row.publisher_id,
    pattern: row.pattern,
    ...(row.filter !== undefined && row.filter !== null ? { filter: row.filter } : {}),
    ...(row.fields !== undefined && row.fields !== null ? { fields: row.fields } : {}),
  });

export const triggersSwitchedOff = (input: {
  preview: TriggerPreviewDeps;
  /** The recipes the update installs, as they will be, each under the
   *  publisher it installs as. */
  recipes: ReadonlyArray<{ recipe_id: string; publisher_id: string; definition: RecipeDefinition }>;
}): Array<{ recipe_id: string; name: string; reason: 'changed' | 'removed' }> => {
  const vendors = input.preview.getVendorEntities();
  const managed = input.preview.store.list().filter((row) => row.origin === 'recipe');
  const out: Array<{ recipe_id: string; name: string; reason: 'changed' | 'removed' }> = [];
  for (const recipe of input.recipes) {
    const rows = managed
      .filter((row) => row.publisher_id === recipe.publisher_id && row.recipe_id === recipe.recipe_id)
      .map((row) => ({ key: rowKey(row), row }));
    // On for the owner — a row a reviewed execution parks reads disabled.
    const on = new Set(rows
      .filter(({ row }) => input.preview.store.ownerEnabled(row.trigger_id))
      .map(({ row }) => row.trigger_id));
    if (on.size === 0) continue;
    const keys = [...new Set(recipeTriggerDeclarations(recipe, vendors).declarations.map(declarationKey))];
    const carried = carriedTriggerFor(rows, keys);
    const switchedOff = rows.some(({ key, row }) =>
      on.has(row.trigger_id) && !keys.includes(key) && carried?.row.trigger_id !== row.trigger_id);
    if (switchedOff) {
      out.push({
        recipe_id: recipe.recipe_id,
        name: recipe.definition.metadata?.name ?? recipe.recipe_id,
        // No trigger at all any more, or a changed one that cannot be paired.
        reason: keys.length === 0 ? 'removed' : 'changed',
      });
    }
  }
  return out;
};
