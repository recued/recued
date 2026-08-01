import { createHash } from 'node:crypto';

import type { RecipeDefinition, RecordsEventPointer, RecordsPackRef } from '@recued/contracts';
import { hashRecipe } from '@recued/recipes';

export interface RecordsSubscriberBinding {
  recipe_id: string;
  publisher_id: string;
  recipe_digest: string;
  trigger_index: number;
  trigger_digest: string;
  /** Exact installed Records operation-group grant set. It is deliberately
   * carried in the binding digest so a revoke or raise retires old pending
   * deliveries instead of reinterpreting them under new authority. */
  grant_snapshot: RecordsSubscriberGrantSnapshot;
  binding_digest: string;
  event_types: RecordsEventPointer['type'][];
  filter?: Record<string, unknown>;
}

export interface RecordsSubscriberGrantSnapshot {
  installed_pack_id: string;
  ingredient_id: string;
  connection_name: string;
  group_ids: string[];
}

export interface RecordsGrantRowView {
  segments: string[];
  value: unknown;
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
};
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

const eventTypes = (pattern: string): RecordsEventPointer['type'][] | null => {
  if (pattern === 'record.*') return ['record.created', 'record.updated', 'record.deleted'];
  if (pattern === 'record.created' || pattern === 'record.updated' || pattern === 'record.deleted') {
    return [pattern];
  }
  return null;
};

/** Bind ordinary raw event_triggers to their verified owning Records pack.
 * The authored event carries no namespace selector; the installer supplies it
 * by storing this binding under the owner tuple. */
export const deriveRecordsSubscriberBindings = (
  owner: RecordsPackRef,
  recipes: readonly {
    recipe: RecipeDefinition;
    publisher_id: string;
    recipe_digest?: string;
  }[],
  grantSnapshot: RecordsSubscriberGrantSnapshot = {
    installed_pack_id: '__records_test_unbound__',
    ingredient_id: '__records_test_unbound__',
    connection_name: '__records_test_unbound__',
    group_ids: [],
  },
): { bindings: RecordsSubscriberBinding[]; digest: string } => {
  const bindings: RecordsSubscriberBinding[] = [];
  for (const entry of recipes) {
    const recipeDigest = entry.recipe_digest ?? hashRecipe(entry.recipe);
    const recordsTriggers = (entry.recipe.event_triggers ?? []).filter((trigger) =>
      typeof trigger.event === 'string' && eventTypes(trigger.event) !== null);
    if (recordsTriggers.length > 0 && Object.keys(entry.recipe.variables ?? {}).length > 0) {
      throw new Error(
        `Records watcher '${entry.recipe.recipe_id}' cannot depend on mutable dish/install config`,
      );
    }
    for (const [triggerIndex, trigger] of (entry.recipe.event_triggers ?? []).entries()) {
      if (typeof trigger.event !== 'string') continue;
      const types = eventTypes(trigger.event);
      if (types === null) continue;
      const triggerDigest = digest(trigger);
      const binding = {
        owner,
        recipe_id: entry.recipe.recipe_id,
        publisher_id: entry.publisher_id,
        recipe_digest: recipeDigest,
        trigger_index: triggerIndex,
        trigger_digest: triggerDigest,
        grant_snapshot: {
          ...grantSnapshot,
          group_ids: [...grantSnapshot.group_ids].sort(),
        },
        event_types: types,
        ...(trigger.filter !== undefined ? { filter: trigger.filter } : {}),
      };
      bindings.push({
        recipe_id: binding.recipe_id,
        publisher_id: binding.publisher_id,
        recipe_digest: binding.recipe_digest,
        trigger_index: binding.trigger_index,
        trigger_digest: binding.trigger_digest,
        grant_snapshot: binding.grant_snapshot,
        binding_digest: digest(binding),
        event_types: binding.event_types,
        ...(binding.filter !== undefined ? { filter: binding.filter } : {}),
      });
    }
  }
  bindings.sort((left, right) => left.binding_digest.localeCompare(right.binding_digest));
  return { bindings, digest: digest(bindings) };
};

/** Compare one binding's install-time grant set with the live contract.grant
 * rows for that pack. Exact equality is intentional: both revoke and raise
 * retire pending work, while a newly committed event receives the new digest. */
export const recordsSubscriberGrantSnapshotMatches = (
  snapshot: RecordsSubscriberGrantSnapshot,
  rows: readonly RecordsGrantRowView[],
): boolean => {
  const current = rows.flatMap((row) => {
    if (row.segments.length !== 4
      || row.segments[0] !== snapshot.installed_pack_id
      || row.segments[1] !== snapshot.ingredient_id
      || row.segments[2] !== snapshot.connection_name
      || (row.value as { allowed?: unknown } | null)?.allowed !== true) return [];
    return [row.segments[3]!];
  });
  const currentIds = [...new Set(current)].sort();
  const expectedIds = [...new Set(snapshot.group_ids)].sort();
  return currentIds.length === expectedIds.length
    && currentIds.every((value, index) => value === expectedIds[index]);
};

export const recordsSubscriberMatches = (
  binding: RecordsSubscriberBinding,
  event: RecordsEventPointer,
): boolean => {
  if (!binding.event_types.includes(event.type)) return false;
  for (const [key, expected] of Object.entries(binding.filter ?? {})) {
    const actual = key === 'kind' || key === 'entity'
      ? event.entity
      : key === 'id'
        ? event.id
        : key === 'cause'
          ? event.cause
          : key === 'revision'
            ? event.revision
            : undefined;
    // Existing trigger-filter fidelity semantics pass missing paths. Records
    // bindings are stricter: the closed pointer exposes only these fields, so
    // an unknown filter can never accidentally broaden a subscription.
    if (actual === undefined || !Object.is(actual, expected)) return false;
  }
  return true;
};
