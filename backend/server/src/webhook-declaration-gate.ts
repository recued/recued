/** D-201 standalone-recipe activation gate.
 *
 * Pack install has the Slice-4 owner-selection/binding transaction. Standalone
 * Kitchen/MCP save does not yet carry an owner-approved ingress selection, so a
 * local recipe with a non-empty declaration would still create inert work while
 * reporting success. Keep those non-pack seams fail-closed until the local
 * chooser can invoke the same consumer store.
 */

import type { RecipeDefinition } from '@recued/contracts';

export const D201_WEBHOOK_RUNTIME_UNAVAILABLE =
  'D-201 standalone webhook recipes require an owner-selected ingress binding; install them through a webhook-enabled pack or save without webhook declarations';

export const hasNonEmptyWebhookDeclarations = (
  recipe: Pick<RecipeDefinition, 'webhook_requirements' | 'webhook_triggers'>,
): boolean =>
  (Array.isArray(recipe.webhook_requirements) && recipe.webhook_requirements.length > 0)
  || (Array.isArray(recipe.webhook_triggers) && recipe.webhook_triggers.length > 0);
