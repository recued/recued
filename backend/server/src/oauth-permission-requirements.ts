/** D-322 §43 — declared scope needs, with incomplete recipe metadata kept unknown. */
import { KERNEL_OP_REGISTRY, MAILBOX_ARGUMENT_OPS, collectionPermissionScopes,
  type IngredientManifest, type RecipeDefinition, type ManagedOAuthConnectionUse, type OAuthPermissionNeeds, type Dish } from '@recued/contracts';
import type { CollectionInstanceRecord } from './collections/instance-store.js';
const kernelById = new Map(KERNEL_OP_REGISTRY.map(entry => [entry.op, entry]));
const kernelByIngredient = new Map(KERNEL_OP_REGISTRY.filter(entry => entry.backing_slug).map(entry => [entry.backing_slug!, entry]));
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export const readOAuthPermissionRequirements = (name: string, deps: {
  uses: readonly ManagedOAuthConnectionUse[]; complete: boolean;
  bindings: readonly { connection_name: string; catalog_slug: string; installed_pack_id: string }[];
  manifest(slug: string): IngredientManifest | null | undefined;
  /** The same lowered recipe the run uses; a failed resolution must throw. */
  recipe(id: string): RecipeDefinition | null | undefined;
}): OAuthPermissionNeeds => {
  let complete = deps.complete; const warnings = new Set<string>();
  const scopes = new Map<string, Map<string, ManagedOAuthConnectionUse>>();
  const add = (values: readonly string[] | undefined, use: ManagedOAuthConnectionUse): void => {
    if (values === undefined) { complete = false; warnings.add('Some operations have no declared OAuth permissions. Their requirements remain unknown.'); return; }
    for (const scope of values) {
      if (typeof scope !== 'string' || !scope.trim() || scope.length > 2048 || /[\x00-\x20\x7f]/.test(scope)) { complete = false; continue; }
      const sources = scopes.get(scope) ?? new Map<string, ManagedOAuthConnectionUse>();
      sources.set(use.kind + ':' + use.id, use); scopes.set(scope, sources);
    }
  };
  const catalog = (id: string, use: ManagedOAuthConnectionUse): void => {
    const manifest = deps.manifest(id);
    if (!manifest?.operations) { complete = false; warnings.add('An installed catalog could not supply its OAuth permission requirements.'); return; }
    for (const operation of Object.values(manifest.operations)) add(operation.required_scopes, use);
  };
  const bindings = deps.bindings.filter(b => b.connection_name === name);
  for (const use of deps.uses.filter(u => u.kind === 'pack')) if (!bindings.some(b => b.installed_pack_id === use.id)) {
    complete = false; warnings.add('Some installed pack usage has no resolved catalog binding. Its permission needs remain unknown.');
  }
  for (const binding of bindings) catalog(binding.catalog_slug,
    deps.uses.find(u => u.kind === 'pack' && u.id === binding.installed_pack_id)
      ?? { kind: 'pack', id: binding.installed_pack_id, label: binding.installed_pack_id });
  for (const use of deps.uses.filter(u => u.kind === 'recipe')) {
    let recipe: RecipeDefinition | null | undefined;
    try { recipe = deps.recipe(use.id); } catch { /* An unresolved recipe is not an empty dependency. */ }
    if (!recipe) { complete = false; warnings.add('A saved recipe could not be resolved. Refresh its dependencies before cleanup.'); continue; }
    let found = false;
    for (const step of [...recipe.prefetch_steps, ...recipe.steps, ...recipe.trigger_steps ?? []]) {
      if (!('ingredient' in step) || typeof step.ingredient !== 'string') {
        if ('op' in step) { complete = false; warnings.add('A dynamic recipe operation has unresolved permission needs.'); }
        continue;
      }
      const manifest = deps.manifest(step.ingredient);
      const bound = bindings.some(b => b.catalog_slug === step.ingredient);
      const explicit = 'connection' in step && step.connection === name;
      if (!bound && !explicit) continue;
      found = true;
      if (!manifest?.operations) { complete = false; continue; }
      const operation = 'input' in step && step.input && typeof step.input === 'object' && 'operation' in step.input
        && typeof step.input.operation === 'string' ? manifest.operations[step.input.operation] : undefined;
      if (operation) add(operation.required_scopes, use);
      else catalog(step.ingredient, use);
    }
    if (!found) { complete = false; warnings.add('Some saved recipe access cannot be assigned to declared OAuth scopes.'); }
  }
  // Dishes and paused schedules keep the recipe's needs; they are not evidence of disuse.
  const recipes = deps.uses.filter(u => u.kind === 'recipe');
  if (deps.uses.some(u => ['dish', 'schedule'].includes(u.kind)) && recipes.length === 0) {
    complete = false; warnings.add('A dish or schedule has unresolved recipe requirements.');
  }
  return { complete, warnings: [...warnings].sort(), requirements: [...scopes].sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, sources]) => ({ scope, uses: [...sources.values()] })) };
};

/** Native collection users do not necessarily name an Apps & APIs connection. */
export const readNativeOAuthPermissionRequirements = (row: CollectionInstanceRecord, deps: {
  recipes: readonly { recipe: RecipeDefinition; pack?: ManagedOAuthConnectionUse }[];
  dishes: readonly Pick<Dish, 'dish_id' | 'recipe_id' | 'name' | 'enabled'>[];
  schedules: readonly { schedule_id: string; recipe_id: string; enabled: boolean }[];
  complete: boolean;
}): OAuthPermissionNeeds => {
  let complete = deps.complete; const requirements: OAuthPermissionNeeds['requirements'][number][] = [];
  const uses = new Map<string, ManagedOAuthConnectionUse>(); const warnings = new Set<string>();
  const localDrafts = new Set(['core.mail.draft.create', 'core.mail.draft.read', 'core.mail.draft.update', 'core.mail.draft.delete']);
  for (const { recipe, pack } of deps.recipes) {
    for (const step of [...recipe.prefetch_steps, ...recipe.steps, ...recipe.trigger_steps ?? []]) {
      const entry = 'op' in step && typeof step.op === 'string' ? kernelById.get(step.op)
        : 'ingredient' in step && typeof step.ingredient === 'string' ? kernelByIngredient.get(step.ingredient) : undefined;
      if (!entry || entry.entity !== row.platform || localDrafts.has(entry.op)) continue;
      const spec = Object.hasOwn(MAILBOX_ARGUMENT_OPS, entry.op) ? MAILBOX_ARGUMENT_OPS[entry.op] : undefined;
      const args = 'args' in step ? step.args : 'input' in step ? step.input : undefined;
      const target = spec && isRecord(args) ? args[spec.arg] : undefined;
      if (typeof target === 'string' && !target.includes('{{') && target !== row.slug) continue;
      const mayUse = typeof target !== 'string' || target.includes('{{');
      const recipeUses: ManagedOAuthConnectionUse[] = [{ kind: 'recipe', id: recipe.recipe_id, label: recipe.metadata.name, ...(mayUse ? { may_use: true as const } : {}) },
        ...(pack ? [{ ...pack, ...(mayUse ? { may_use: true as const } : {}) }] : []),
        ...deps.dishes.filter(d => d.recipe_id === recipe.recipe_id).map(d => ({ kind: 'dish' as const, id: d.dish_id, label: d.name || recipe.metadata.name,
          ...(mayUse ? { may_use: true as const } : {}), ...(!d.enabled ? { paused: true as const } : {}) })),
        ...deps.schedules.filter(s => s.recipe_id === recipe.recipe_id).map(s => ({ kind: 'schedule' as const, id: s.schedule_id, label: recipe.metadata.name,
          ...(mayUse ? { may_use: true as const } : {}), ...(!s.enabled ? { paused: true as const } : {}) }))];
      for (const use of recipeUses) uses.set(use.kind + ':' + use.id, use);
      if (!spec && entry.risk !== 'read' && !['core.mail.sent.reconcile', 'core.mail.draft.save-to-mailbox'].includes(entry.op)) {
        complete = false; warnings.add('A native workflow has account-dependent permission needs that cannot be resolved from its saved arguments.'); continue;
      }
      const provider = row.adapter_type === 'graph' ? 'graph' : row.platform === 'mail' ? 'gmail' : 'gcal';
      const choice = row.platform === 'mail' ? { platform: 'mail' as const, slug: row.slug, read: true as const,
        send: spec?.sends === true, organize: spec?.sends !== true && entry.risk !== 'read' && entry.op !== 'core.mail.sent.reconcile' }
        : { platform: 'calendar' as const, slug: row.slug, read: true as const, edit_events: entry.risk !== 'read' };
      requirements.push(...collectionPermissionScopes(provider, choice).map(scope => ({ scope, uses: recipeUses })));
    }
  }
  return { complete, requirements, uses: [...uses.values()], warnings: [...warnings] };
};
