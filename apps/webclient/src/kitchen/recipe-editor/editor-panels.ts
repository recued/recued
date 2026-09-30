import type { RecipeDefinition, VariableDefault } from '@recued/contracts';
import type { ParamDef } from '@recued/transforms';

export interface RecipePanelsContext {
  document: Document;
  recipe: RecipeDefinition;
  change(recipe: RecipeDefinition, rebuild?: boolean): void;
  value(label: string, key: string, value: unknown, schema: ParamDef | undefined,
    change: (value: unknown) => void): HTMLElement;
}
const text = (doc: Document, parent: HTMLElement, tag: string, value: string): HTMLElement => {
  const el = doc.createElement(tag); el.textContent = value; parent.appendChild(el); return el;
};
const button = (doc: Document, label: string, action: () => void): HTMLButtonElement => {
  const el = doc.createElement('button'); el.type = 'button'; el.textContent = label;
  el.className = 'rx-btn rx-btn-secondary rx-btn-sm'; el.addEventListener('click', action); return el;
};

/** Full definitions stay lossless: editing one setting never rebuilds a whitelist
 * of recipe fields or silently drops advanced variable/output declarations. */
export const renderRecipeSettings = (context: RecipePanelsContext): HTMLElement => {
  const { document: doc } = context;
  // Each callback reads the current recipe through this context, which the host
  // provides as a getter. Several fields can be edited without a full repaint.
  const section = doc.createElement('details');
  section.className = 'recipe-editor-section recipe-editor-settings';
  section.setAttribute('data-recued-recipe-settings', '');
  const summary = text(doc, section, 'summary', '');
  text(doc, summary, 'span', 'Recipe settings');
  text(doc, summary, 'span', 'What it does, what goes in, what comes out').className = 'recipe-editor-panel-hint';
  const body = doc.createElement('div'); body.className = 'recipe-editor-panel-body'; section.appendChild(body);
  const grid = doc.createElement('div'); grid.className = 'recipe-editor-field-grid'; body.appendChild(grid);
  const value = (label: string, key: string, current: unknown, schema: ParamDef | undefined,
    change: (next: unknown) => void): void => { grid.appendChild(context.value(label, key, current, schema, change)); };
  value('Description', 'metadata.description', context.recipe.metadata.description, { type: 'string' }, next => {
    context.change({ ...context.recipe, metadata: { ...context.recipe.metadata, description: String(next ?? '') } });
  });
  value('Keep the answer for (seconds)', 'ttl', context.recipe.ttl, { type: 'number', required: true }, next => {
    context.change({ ...context.recipe, ttl: next as number });
  });
  const vars = doc.createElement('div'); vars.className = 'recipe-editor-settings-block';
  text(doc, vars, 'h3', 'Inputs');
  text(doc, vars, 'p', 'Set what these start as. Use JSON to say which are needed, or to offer choices.');
  for (const [name, initial] of Object.entries(context.recipe.variables)) {
    // A connection and a mail template have their own sections (D-315 §5.2).
    if (initial && typeof initial === 'object' && !Array.isArray(initial)
      && 'type' in initial && (String(initial.type) === 'connection' || String(initial.type) === 'mail_template')) continue;
    const row = doc.createElement('div'); row.className = 'recipe-editor-variable-row';
    row.appendChild(context.value(name, `variables.${name}`, initial, { type: 'any' }, next => {
      const variables = { ...context.recipe.variables, [name]: (next ?? null) as VariableDefault };
      context.change({ ...context.recipe, variables });
    }));
    const remove = button(doc, 'Remove', () => {
      const variables = { ...context.recipe.variables }; delete variables[name];
      context.change({ ...context.recipe, variables }, true);
    });
    remove.setAttribute('aria-label', `Remove variable ${name}`);
    row.appendChild(remove);
    vars.appendChild(row);
  }
  const add = doc.createElement('div'); add.className = 'recipe-editor-variable-row';
  const name = doc.createElement('input'); name.placeholder = 'Input name'; name.setAttribute('aria-label', 'New input name'); name.setAttribute('data-recued-recipe-editor-field', 'variable_new_name');
  const error = doc.createElement('span'); error.setAttribute('role', 'status');
  error.className = 'recipe-editor-field-error';
  add.appendChild(name);
  add.appendChild(button(doc, 'Add input', () => {
    const key = name.value.trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      error.textContent = 'Use letters, numbers and underscores. Start with a letter.'; return;
    }
    if (Object.hasOwn(context.recipe.variables, key)) { error.textContent = 'You already have an input with this name.'; return; }
    context.change({ ...context.recipe, variables: { ...context.recipe.variables, [key]: null } }, true);
  }));
  vars.appendChild(add); vars.appendChild(error); body.appendChild(vars);

  const run = doc.createElement('div'); run.className = 'recipe-editor-settings-block';
  text(doc, run, 'h3', 'Automatic runs');
  const enabled = doc.createElement('input'); enabled.type = 'checkbox'; enabled.checked = context.recipe.auto_run !== undefined;
  enabled.setAttribute('data-recued-recipe-auto-run', ''); enabled.setAttribute('data-recued-recipe-editor-field', 'auto_run_enabled');
  const label = doc.createElement('label'); label.appendChild(enabled); text(doc, label, 'span', 'Run every so often'); run.appendChild(label);
  enabled.addEventListener('change', () => {
    const next = { ...context.recipe };
    if (enabled.checked) next.auto_run = { interval_ms: 60_000 };
    else delete next.auto_run;
    context.change(next, true);
  });
  if (context.recipe.auto_run) {
    for (const [key, labelText, schema] of [
      ['interval_ms', 'Interval (milliseconds)', { type: 'number', required: true }],
      ['dynamic', 'Use the next run time the Recipe works out', { type: 'boolean' }],
      // D-319 — no "switch on at install": nothing runs until the owner
      // switches the Recipe on, with its settings.
    ] as const) {
      const current = context.recipe.auto_run[key] ?? false;
      run.appendChild(context.value(labelText, `auto_run.${key}`, current, schema, next => {
        context.change({ ...context.recipe, auto_run: { ...context.recipe.auto_run!, [key]: next } });
      }));
    }
  }
  if (context.recipe.trigger_steps?.length && !context.recipe.auto_run) {
    text(doc, run, 'p', 'Steps that set things off need this Recipe to run on its own. Turn that on, or remove those steps, before you save.');
  }
  body.appendChild(run);
  const output = doc.createElement('div'); output.className = 'recipe-editor-settings-block';
  text(doc, output, 'h3', 'Output');
  text(doc, output, 'p', 'Say what this Recipe shows, or sends to somebody else.');
  output.appendChild(context.value('What it gives back (JSON)', 'output', context.recipe.output, { type: 'object', required: true }, next => {
    context.change({ ...context.recipe, output: next as RecipeDefinition['output'] });
  }));
  body.appendChild(output);
  return section;
};

export const EDITOR_WORKBENCH_STYLES = `
[data-recued-recipe-editor-route] .recipe-editor-step-actions { flex-wrap: wrap; }
[data-recued-recipe-editor-route] .recipe-editor-topbar { margin-bottom: 20px; }
[data-recued-recipe-editor-route] .recipe-editor-section { margin-top: 16px; padding: 16px; }
[data-recued-recipe-editor-route] .recipe-editor-hint { color: var(--fg-muted); font-size: 12px; }
[data-recued-recipe-editor-route] .recipe-editor-trigger-empty { padding: 12px; text-align: left; border-style: solid; border-radius: 9px; }
[data-recued-recipe-editor-route] .recipe-editor-trigger-empty span { font-size: 12px; }
.recipe-editor-workspace { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 16px; align-items: start; }
.recipe-editor-workspace > * { min-width: 0; }
[data-recued-recipe-editor-route] .recipe-editor-workspace > div > :first-child { margin-top: 0; }
.recipe-editor-outline { position: sticky; top: 170px; box-sizing: border-box; max-height: calc(100dvh - 182px); overflow-y: auto; scrollbar-width: thin; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.recipe-editor-outline .recipe-editor-panel-body { gap: 12px; margin-top: 12px; }
.recipe-editor-outline-list { display: grid; gap: 12px; scrollbar-width: thin; }
.recipe-editor-outline-group { display: grid; gap: 3px; }
.recipe-editor-outline-group-title { padding: 0 7px 4px; color: var(--fg-muted); font-size: 11px; font-weight: 650; }
[data-recued-recipe-editor-route] .recipe-editor-outline-list button { display: flex; gap: 8px; text-align: left; white-space: normal; overflow-wrap: anywhere; justify-content: start; min-height: 46px; border: 1px solid transparent; border-radius: 7px; background: transparent; padding: 7px; }
[data-recued-recipe-editor-route] .recipe-editor-outline-list button:hover { background: var(--surface-sunk); }
[data-recued-recipe-editor-route] .recipe-editor-outline-list button[aria-current] { background: var(--accent-weak); border-color: var(--accent); }
[data-recued-recipe-editor-route] .recipe-editor-outline-list button[data-has-error] { color: var(--danger); }
.recipe-editor-outline-number { flex: 0 0 18px; color: var(--fg-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.recipe-editor-outline-copy { display: grid; gap: 2px; min-width: 0; }
.recipe-editor-outline-copy strong { font-size: 12px; font-weight: 600; }
.recipe-editor-outline-copy > span { font-size: 11px; color: var(--fg-muted); }
.recipe-editor-outline-empty { color: var(--fg-muted); font-size: 12px; line-height: 1.5; padding: 4px; }
.recipe-editor-outline-shortcuts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
[data-recued-recipe-editor-route] .recipe-editor-outline-shortcuts button { padding-inline: 4px; font-size: 11px; min-width: 0; }
.recipe-editor-search { display: flex; align-items: center; gap: 6px; min-width: 0; }
.recipe-editor-search input { min-width: 0; }
.recipe-editor-search [hidden] { display: none; }
.recipe-editor-search-count { font-size: 11px; color: var(--fg-muted); }
.recipe-editor-search-count:empty { display: none; }
.recipe-editor-value { min-width: 0; display: grid; gap: 5px; }
[data-recued-recipe-editor-route] .recipe-editor-step-body > .recipe-editor-field-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.recipe-editor-value input[type="checkbox"] { width: 20px; min-height: 20px; }
[data-recued-recipe-editor-route] .recipe-editor-reference-picker { justify-self: start; width: auto; max-width: 100%; min-height: 30px; padding: 4px 8px; font-size: 11px; color: var(--fg-muted); border-color: transparent; background: transparent; }
[data-recued-recipe-editor-route] .recipe-editor-reference-picker:hover { border-color: var(--border-strong); background: var(--surface); }
[data-recued-recipe-editor-route] [aria-invalid="true"] { border-color: var(--danger); }
.recipe-editor-field-error { color: var(--danger); font-size: 12px; overflow-wrap: anywhere; }
.recipe-editor-field-error:empty { display: none; }
.recipe-editor-settings > summary, .recipe-editor-test > summary, .recipe-editor-outline > details > summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; list-style: none; cursor: pointer; min-height: 26px; font-size: 14px; font-weight: 650; }
.recipe-editor-settings > summary::-webkit-details-marker, .recipe-editor-test > summary::-webkit-details-marker, .recipe-editor-outline > details > summary::-webkit-details-marker { display: none; }
.recipe-editor-settings > summary::before, .recipe-editor-test > summary::before, .recipe-editor-outline > details > summary::before { content: '▸'; color: var(--fg-muted); font-size: 12px; }
.recipe-editor-settings[open] > summary::before, .recipe-editor-test[open] > summary::before, .recipe-editor-outline > details[open] > summary::before { transform: rotate(90deg); }
[data-recued-recipe-editor-route] summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
.recipe-editor-panel-hint { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--fg-muted); }
.recipe-editor-outline .recipe-editor-panel-hint { font-size: 10px; }
.recipe-editor-settings-block { display: grid; gap: 10px; padding-top: 16px; border-top: 1px solid var(--border); min-width: 0; }
.recipe-editor-settings-block h3 { margin: 0; font-size: 14px; font-weight: 650; }
.recipe-editor-settings-block p { margin: 0; font-size: 12px; color: var(--fg-muted); }
.recipe-editor-settings-block label { display: flex; align-items: center; gap: 8px; }
.recipe-editor-settings-block label input[type="checkbox"] { width: 20px; min-height: 20px; }
.recipe-editor-variable-row { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; min-width: 0; }
.recipe-editor-variable-row > .recipe-editor-field { flex: 1 1 220px; min-width: 0; }
.recipe-editor-variable-row > input { flex: 1 1 180px; min-width: 0; }
.recipe-editor-recovery { padding: 12px; margin-block: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.recipe-editor-test-intro { margin: 0; font-size: 12px; line-height: 1.5; color: var(--fg-muted); }
.recipe-editor-test-help { padding: 10px 12px; background: var(--surface-sunk); border-radius: 8px; font-size: 12px; min-width: 0; }
.recipe-editor-test-help summary { cursor: pointer; color: var(--fg-muted); }
.recipe-editor-test-help p { line-height: 1.5; }
.recipe-editor-sample-label { margin-bottom: -8px; }
[data-recued-recipe-test-status] { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--surface-sunk); font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
[data-recued-recipe-test-status][data-state="passed"] { background: var(--accent-weak); color: var(--accent); }
[data-recued-recipe-test-status][data-state="failed"] { background: var(--danger-weak); color: var(--danger); }
.recipe-editor-test-results { display: grid; gap: 8px; }
.recipe-editor-test-totals { margin: 0 0 4px; color: var(--fg-muted); font-size: 12px; }
.recipe-editor-test-results details { padding: 10px; border: 1px solid var(--border); border-radius: 9px; min-width: 0; }
.recipe-editor-test-results details[data-state="failed"] { border-color: var(--danger); }
.recipe-editor-test-results summary { cursor: pointer; font-size: 13px; overflow-wrap: anywhere; }
.recipe-editor-test-results details > p { font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.recipe-editor-test-results strong { font-size: 11px; color: var(--fg-muted); }
.recipe-editor-test-values { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.recipe-editor-test-values > * { min-width: 0; }
.recipe-editor-test-results pre, .recipe-editor-test-help pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 280px; overflow: auto; font-size: 12px; line-height: 1.5; }
.recipe-editor-test-results pre { padding: 10px; border-radius: 6px; background: var(--surface-sunk); }
[data-recued-recipe-editor-route] .recipe-editor-settings, [data-recued-recipe-editor-route] .recipe-editor-test { display: block; }
.recipe-editor-panel-body { display: grid; gap: 16px; margin-top: 16px; min-width: 0; }
@media (max-width: 1100px) {
  .recipe-editor-workspace { grid-template-columns: minmax(0, 1fr); }
  .recipe-editor-outline { position: static; max-height: none; overflow: visible; }
  .recipe-editor-outline-list { max-height: 220px; overflow: auto; }
  .recipe-editor-outline-shortcuts { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  [data-recued-recipe-editor-route] .recipe-editor-header { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  [data-recued-recipe-editor-route] .recipe-editor-heading { grid-column: 1 / -1; }
  [data-recued-recipe-editor-route] .recipe-editor-topbar { margin-bottom: 16px; }
  .recipe-editor-panel-hint { flex: 1 1 100%; margin-left: 19px; }
  .recipe-editor-outline .recipe-editor-panel-hint { flex: 0 0 auto; margin-left: auto; }
  [data-recued-recipe-editor-route] .recipe-editor-reference-picker { min-height: 36px; }
  [data-recued-recipe-editor-route] .recipe-editor-step-body > .recipe-editor-field-grid { grid-template-columns: minmax(0, 1fr); }
  [data-recued-recipe-editor-route] summary,
  [data-recued-recipe-editor-route] .recipe-editor-outline > details > summary { min-height: 36px; }
}
@media (max-width: 560px) {
  .recipe-editor-variable-row { flex-direction: column; align-items: stretch; }
  .recipe-editor-variable-row > .recipe-editor-field, .recipe-editor-variable-row > input { flex: auto; }
  .recipe-editor-test-values { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 340px) {
  [data-recued-recipe-editor-route] .recipe-editor-header { grid-template-columns: minmax(0, 1fr); }
  .recipe-editor-outline-shortcuts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;
