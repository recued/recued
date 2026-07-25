/** Read-only rendering for D-195 recipe output actions.
 *
 *  The shared renderer is used by preview/sidebar surfaces that do not
 *  have installed-recipe state or the run-modal execution path. Therefore
 *  action descriptors render as inert labels only; executable controls live
 *  in the webclient result panel.
 */

import { e } from './escape.js';
import { renderBlockEmpty, renderBlockError } from './block-error.js';
import type { RenderContext } from './types.js';

type RecipeOutputAction = {
  kind: 'recipe.run';
  label: string;
  recipe_id: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const actionLabel = (value: unknown): { label: string; recipeId: string } | null => {
  const row = asRecord(value);
  if (
    row === null
    || row.kind !== 'recipe.run'
    || typeof row.label !== 'string'
    || row.label.trim().length === 0
    || typeof row.recipe_id !== 'string'
    || row.recipe_id.trim().length === 0
  ) {
    return null;
  }
  const action = row as RecipeOutputAction;
  return {
    label: action.label.trim(),
    recipeId: action.recipe_id.trim(),
  };
};

/** ⚠ `action.target` is the owner's internal `recipe_id`, and the block note
 *  points at the Recipes result panel. Both are chrome THIS RENDERER adds — no
 *  recipe asked for them — and both are meaningless-to-harmful in front of an
 *  anonymous visitor: an internal identifier they never needed, and an
 *  instruction to open a panel they cannot reach. `audience: 'public'` drops
 *  them and keeps the author's own label. See `RenderAudience`.
 *
 *  A `recipe.run` action stays INERT on every surface — the shared renderer has
 *  no execution path anywhere. A visitor-facing surface that wants a control
 *  that actually goes somewhere wants `link_button`, which is an anchor. */
export const renderActionInline = (value: unknown, context: RenderContext = {}): string => {
  const action = actionLabel(value);
  if (action === null) {
    return '<span class="action action-unsupported">Unsupported action</span>';
  }
  const target = context.audience === 'public'
    ? ''
    : `\n      <span class="action-target">${e(action.recipeId)}</span>`;
  return `
    <span class="action action-recipe-run" aria-disabled="true">
      <span class="action-label">${e(action.label)}</span>${target}
    </span>
  `;
};

export const renderActionGroupInline = (
  value: unknown,
  context: RenderContext = {},
): string => {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    return '<span class="action action-empty">No actions</span>';
  }
  return `<span class="action-group">${values.map((v) => renderActionInline(v, context)).join('')}</span>`;
};

export const renderButtonBlock = (data: unknown, context: RenderContext = {}): string => {
  if (data === null || data === undefined) return renderBlockEmpty('button');
  const values = Array.isArray(data) ? data : [data];
  if (values.length === 0) return renderBlockEmpty('button');
  if (values.every((value) => actionLabel(value) === null)) {
    return renderBlockError('button', 'invalid action descriptor');
  }
  const note = context.audience === 'public'
    ? ''
    : '\n      <div class="button-block-note">Recipe actions are read-only in this renderer.</div>';
  return `
    <div class="block button-block" data-action-mode="read-only">${note}
      ${renderActionGroupInline(values, context)}
    </div>
  `;
};
