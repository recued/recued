import { yoursFieldError } from './yours-field-errors.js';
import type { Asset, YoursCommand, YoursSnapshot } from '@recued/contracts';
import { assetObservationFieldName } from './asset-observation-editor.js';
import { yoursChoice, yoursInput, yoursNode } from './yours-view.js';

export const mountAssetWriterEditor = (host: HTMLFormElement, asset: Asset, snapshot: YoursSnapshot, changed: () => void, initial: { field?: string; recipe_id?: string } = {}) => {
  yoursNode(host, 'p', '', 'Authorize one installed recipe version to report the selected fields. A changed version needs your review again.');
  const recipe = yoursChoice(host, 'Installed observation recipe', 'writer-recipe', [['', 'Choose a recipe'], ...(snapshot.observation_recipes ?? []).map(item => [item.id, `${item.name} · ${item.publisher}`] as [string, string])], initial.recipe_id ?? '', changed);
  recipe.required = true;
  if (!snapshot.observation_recipes?.length) yoursNode(host, 'p', '', 'No observation recipes are installed. Install one before enrolling a writer.');
  const fields = yoursNode(host, 'fieldset', ''); yoursNode(fields, 'legend', '', 'Fields it may write');
  const checks = new Map<string, HTMLInputElement>();
  for (const group of ['readings', 'observations'] as const) for (const field of Object.keys(asset[group])) {
    const path = `${group}.${field}`;
    checks.set(path, yoursInput(fields, `${assetObservationFieldName(field)} · ${group === 'readings' ? 'reading' : 'condition'}`, `writer-field-${group}-${field}`, '', changed, 'checkbox'));
  }
  const selectedFields = () => [...checks].filter(([, input]) => input.checked).map(([path]) => path);
  const drafts = new Map<string, Set<string>>(); let selectedRecipe = recipe.value;
  const update = () => {
    const draft = drafts.get(recipe.value);
    const current = new Set((snapshot.observation_bindings ?? []).filter(binding => binding.asset_id === asset.id && binding.actor_ref === `recipe:${recipe.value}`).flatMap(binding => binding.fields));
    for (const [path, input] of checks) input.checked = draft ? draft.has(path) : current.has(path) || path === initial.field;
  };
  recipe.addEventListener('change', () => { drafts.set(selectedRecipe, new Set(selectedFields())); selectedRecipe = recipe.value; update(); }); update();
  yoursNode(host, 'p', 'yours-muted', 'A manual entry keeps its priority. Allow automatic updates on that field separately when you want a fresh authorized observation to replace it.');
  return { read(): Extract<YoursCommand, { action: 'binding.save' }> {
    const selected = snapshot.observation_recipes?.find(item => item.id === recipe.value);
    if (!selected) yoursFieldError(recipe, 'Choose an installed observation recipe');
    const fields = selectedFields(); if (!fields.length) yoursFieldError(checks.values().next().value ?? recipe, 'Choose the fields this recipe may update');
    return { action: 'binding.save', asset_id: asset.id, recipe_id: selected.id, expected_recipe_hash: selected.hash, fields };
  } };
};
