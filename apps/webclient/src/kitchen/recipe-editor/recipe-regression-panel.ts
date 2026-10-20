import { parseRecipeRegressionCases, parseRecipeRegressionAssertion, RECIPE_REGRESSION_LIMITS,
  type RecipeDefinition, type RecipeRegressionAssertion, type RecipeRegressionRead, type RecipeRegressionResult,
  type RecipeRegressionSave, type RecipeRegressionDelete, type RecipeRegressionSuite, type RegressionPhase } from '@recued/contracts';
import type { RecipeRegressionCaller } from './recipe-regression-caller.js';

interface CheckDraft { kind: 'step_status' | 'value' | 'exists'; phase: RegressionPhase; step_id: string; field: 'input' | 'output'; path: string; expected: string }
interface CaseDraft { id: string; name: string; sample: string; expected: 'passed' | 'failed' | 'gated'; checks: CheckDraft[] }
const blankCase = (): CaseDraft => ({ id: crypto.randomUUID(),name: 'New case',sample: '{}',expected: 'passed',checks: [] });
const checkDraft = (check: Exclude<RecipeRegressionAssertion,{ kind: 'run_status' }>): CheckDraft => ({
  kind: check.kind,phase: check.phase,step_id: check.step_id,field: check.kind === 'step_status' ? 'output' : check.field,
  path: check.kind === 'step_status' ? '[]' : JSON.stringify(check.path),expected: check.kind === 'step_status' ? check.expected : JSON.stringify(check.expected),
});
const fromSuite = (suite: RecipeRegressionSuite): CaseDraft[] => suite.cases.map(test => ({ id: test.id,name: test.name,
  sample: JSON.stringify(test.sample,null,2),expected: test.assertions.find(check => check.kind === 'run_status')?.expected ?? 'passed',
  checks: test.assertions.filter((check): check is Exclude<RecipeRegressionAssertion,{ kind: 'run_status' }> => check.kind !== 'run_status').map(checkDraft) }));

/** Retains its DOM/model across editor repaints. Fixtures persist only after an
 * explicit save; unsaved case edits join the editor's existing leave guard. */
export const createRecipeRegressionPanel = (options: { document: Document; recipeId: string; caller: RecipeRegressionCaller;
  getRecipe(): RecipeDefinition; changed?(): void; confirm?: (message: string) => boolean }) => {
  const doc = options.document, root = doc.createElement('details');
  root.className = 'recipe-editor-section'; root.setAttribute('data-recipe-regression','');
  root.style.cssText = 'min-width:0;max-width:100%;overflow-wrap:anywhere';
  const summary = doc.createElement('summary'); summary.textContent = 'Saved recipe tests'; root.append(summary);
  const body = doc.createElement('div'); body.className = 'recipe-editor-panel-body'; body.style.minWidth = '0'; root.append(body);
  let title = 'Recipe tests', baseline: RecipeDefinition | undefined, cases = [blankCase()], selected = cases[0]!.id;
  let saved: RecipeRegressionRead = { head_revision: 0,versions: [],version: null };
  let expectedRevision = 0;
  let dirty = false, busy = false, disposed = false, loaded = false, generation = 0, draftEpoch = 0, recipeEpoch = 0;
  let error = '', message = 'Load saved tests or make a new suite.', result: RecipeRegressionResult | undefined, stale = false;
  let controller: AbortController | undefined, pendingSave: RecipeRegressionSave | undefined, pendingDelete: RecipeRegressionDelete | undefined;
  let controlIndex = 0;
  const focusKey = (element: HTMLElement): void => { element.setAttribute('data-regression-control',String(controlIndex++)); };
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; return element;
  };
  const confirm = (text: string): boolean => options.confirm?.(text) ?? doc.defaultView?.confirm(text) ?? false;
  const status = (): void => { body.querySelector<HTMLElement>('[role=alert], [data-regression-status]')?.focus(); };
  const focusCase = (): void => { body.querySelector<HTMLInputElement>('[aria-label="Case name"]')?.focus(); };
  const focusCheck = (index: number): void => {
    const checks = body.querySelectorAll<HTMLElement>('[data-regression-check]');
    const target = checks[Math.min(index,checks.length - 1)]?.querySelector<HTMLSelectElement>('[aria-label="Check type"]')
      ?? body.querySelector<HTMLButtonElement>('[data-regression-add-check]');
    target?.focus();
  };
  const markStale = (): void => {
    if (!result) return; stale = true;
    const note = body.querySelector<HTMLElement>('[data-regression-result-note]');
    if (note && !note.textContent?.includes('changed since')) note.textContent += ' Recipe or tests changed since this run.';
  };
  const setDirty = (): void => {
    dirty = true; draftEpoch++; pendingSave = undefined; pendingDelete = undefined; markStale(); error = '';
    message = 'Test edits are unsaved. Save a version before running the suite.';
    options.changed?.();
    const state = body.querySelector<HTMLElement>('[data-regression-status]');
    if (state) { state.textContent = message; state.setAttribute('data-state','stale'); }
    const run = body.querySelector<HTMLButtonElement>('[data-regression-run]'); if (run) run.disabled = true;
    const save = body.querySelector<HTMLButtonElement>('[data-regression-save]'); if (save) save.disabled = busy;
  };
  const recipe = (): RecipeDefinition => {
    const value = structuredClone(options.getRecipe());
    if (value.recipe_id !== options.recipeId) throw new Error('The recipe id changed. Save and reopen it before using saved tests.');
    return value;
  };
  const suite = (): RecipeRegressionSuite => ({ title,baseline: structuredClone(baseline ?? recipe()),cases: parseRecipeRegressionCases(cases.map(test => ({
    id: test.id,name: test.name,sample: JSON.parse(test.sample),assertions: [{ kind: 'run_status',expected: test.expected },...test.checks.map(check =>
      parseRecipeRegressionAssertion(check.kind === 'step_status'
        ? { kind: check.kind,phase: check.phase,step_id: check.step_id,expected: check.expected }
        : { kind: check.kind,phase: check.phase,step_id: check.step_id,field: check.field,path: JSON.parse(check.path),expected: JSON.parse(check.expected) }))],
  }))) });
  const accept = (value: RecipeRegressionRead, expected = value.head_revision): void => {
    expectedRevision = expected;
    saved = value; baseline = structuredClone(value.version?.suite.baseline ?? recipe());
    title = value.version?.suite.title ?? 'Recipe tests'; cases = value.version ? fromSuite(value.version.suite) : [blankCase()];
    selected = cases[0]!.id; dirty = false; result = undefined; stale = false; pendingSave = undefined; pendingDelete = undefined; loaded = true;
  };
  const action = (label: string, callback: () => void, disabled = false): HTMLButtonElement => {
    const button = node('button',label); button.type = 'button'; button.disabled = busy || disabled;
    button.className = 'recipe-editor-btn'; button.style.cssText = 'max-width:100%;white-space:normal'; button.onclick = callback; return button;
  };
  const field = (parent: HTMLElement,label: string,value: string,onInput: (value: string) => void,multiline = false): HTMLInputElement | HTMLTextAreaElement => {
    const group = node('label',label); group.style.cssText = 'display:flex;flex-direction:column;gap:4px;min-width:0;max-width:100%;margin:8px 0';
    let control: HTMLInputElement | HTMLTextAreaElement;
    if (multiline) { const area = node('textarea'); area.rows = 6; control = area; } else control = node('input');
    control.value = value; control.setAttribute('aria-label',label); focusKey(control);
    control.style.cssText = 'box-sizing:border-box;max-width:100%;min-width:0;width:100%;font:inherit'; control.disabled = busy;
    control.disabled = busy && !controller;
    control.oninput = () => onInput(control.value); group.append(control); parent.append(group); return control;
  };
  const select = (parent: HTMLElement,label: string,value: string,values: readonly string[],onChange: (value: string) => void): HTMLSelectElement => {
    const group = node('label',label), control = node('select'); group.style.cssText = 'display:flex;flex-direction:column;min-width:0;max-width:100%;margin:8px 0';
    control.setAttribute('aria-label',label); focusKey(control); control.style.cssText = 'max-width:100%;min-width:0;font:inherit'; control.disabled = busy;
    for (const item of values) { const option = node('option',item); option.value = item; control.append(option); }
    control.value = value; control.disabled = busy && !controller;
    control.onchange = () => onChange(control.value); group.append(control); parent.append(group); return control;
  };
  const pre = (parent: HTMLElement,value: unknown): void => {
    const text = node('pre',JSON.stringify(value,null,2) ?? 'No value');
    text.style.cssText = 'max-width:100%;max-height:24rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere'; text.tabIndex = 0; parent.append(text);
  };
  const render = (): void => {
    if (disposed) return;
    const active = doc.activeElement, restore = active && root.contains(active) ? active.getAttribute('data-regression-control') : null;
    controlIndex = 0; body.replaceChildren();
    body.append(node('p','Save made-up inputs and expected results. Compare the saved baseline with your working recipe. Connected services are replaced by pretend results.'));
    const state = node('p',error || (busy ? controller ? 'Running test suite…' : 'Loading or saving tests…' : message));
    state.setAttribute('role',error ? 'alert' : 'status'); state.setAttribute('data-regression-status',''); state.tabIndex = -1;
    state.setAttribute('data-state',busy ? 'running' : stale ? 'stale' : result ? result.failed ? 'failed' : 'passed' : 'ready'); body.append(state);
    const controls = node('div'); controls.className = 'recipe-editor-actions'; controls.style.flexWrap = 'wrap'; body.append(controls);
    controls.append(action('Load saved tests',() => { void load(); }));
    if (saved.versions.length) {
      const versions = select(body,'Saved test version',String(saved.version?.revision ?? saved.versions[0]!.revision),saved.versions.map(item => String(item.revision)),value => { void load(Number(value)); });
      versions.setAttribute('data-regression-version','');
      body.append(node('p',`Viewing version ${saved.version?.revision ?? 'none'}. Latest version: ${saved.head_revision}. Each save creates a new version.`));
    }
    field(body,'Test suite name',title,value => { title = value; setDirty(); });
    controls.append(action('Use working recipe as baseline',() => {
      try { baseline = recipe(); setDirty(); message = 'The working recipe is now the draft baseline. Save a new test version to keep it.'; render(); status(); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); render(); status(); }
    }));
    const saveButton = action(pendingSave ? 'Retry saving version' : 'Save test version',() => { void save(); },!dirty && saved.version !== null);
    saveButton.setAttribute('data-regression-save',''); controls.append(saveButton);
    const runButton = action('Run test suite',() => { void run(); },!saved.version || dirty); runButton.setAttribute('data-regression-run',''); controls.append(runButton);
    if (controller) { const cancel = action('Cancel suite',() => controller?.abort()); cancel.disabled = false; controls.append(cancel); }
    if (saved.version || pendingDelete) controls.append(action(pendingDelete ? 'Retry deleting tests' : 'Delete saved tests',() => { void remove(); }));
    const choices = node('div'); choices.setAttribute('aria-label','Test cases'); choices.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:12px 0';
    for (const test of cases) { const button = action(test.name,() => { selected = test.id; render(); focusCase(); }); button.setAttribute('aria-pressed',String(test.id === selected)); choices.append(button); }
    choices.append(action('Add case',() => { const test = blankCase(); test.name = 'Case ' + (cases.length + 1); cases.push(test); selected = test.id; setDirty(); render(); focusCase(); },cases.length >= RECIPE_REGRESSION_LIMITS.cases));
    body.append(choices);
    const test = cases.find(item => item.id === selected)!;
    const editor = node('fieldset'); editor.style.cssText = 'min-width:0;max-width:100%;border:1px solid var(--border);padding:12px'; editor.append(node('legend','Edit test case'));
    field(editor,'Case name',test.name,value => { test.name = value; setDirty(); });
    field(editor,'Sample data (JSON)',test.sample,value => { test.sample = value; setDirty(); },true);
    editor.append(node('p','Use config for settings, context for the event, data for sample values and mocks for pretend step results.'));
    select(editor,'Expected recipe status',test.expected,['passed','failed','gated'],value => { if (value === 'passed' || value === 'failed' || value === 'gated') test.expected = value; setDirty(); });
    test.checks.forEach((check,index) => {
      const row = node('fieldset'); row.setAttribute('data-regression-check',''); row.style.cssText = 'min-width:0;margin:12px 0'; row.append(node('legend',`Check ${index + 1}`));
      select(row,'Check type',check.kind,['value','step_status','exists'],value => {
        if (value === 'value' || value === 'step_status' || value === 'exists') check.kind = value;
        check.expected = value === 'step_status' ? 'passed' : value === 'exists' ? 'true' : 'null'; setDirty(); render();
      });
      select(row,'Step phase',check.phase,['trigger','prefetch','sequential'],value => { if (value === 'trigger' || value === 'prefetch' || value === 'sequential') check.phase = value; setDirty(); });
      field(row,'Step id',check.step_id,value => { check.step_id = value; setDirty(); });
      if (check.kind === 'step_status') select(row,'Expected step status',check.expected,['passed','skipped','failed','blocked'],value => { check.expected = value; setDirty(); });
      else {
        select(row,'Value to check',check.field,['input','output'],value => { if (value === 'input' || value === 'output') check.field = value; setDirty(); });
        field(row,'Value path (JSON array)',check.path,value => { check.path = value; setDirty(); });
        if (check.kind === 'exists') select(row,'Value should exist',check.expected,['true','false'],value => { check.expected = value; setDirty(); });
        else field(row,'Expected value (JSON)',check.expected,value => { check.expected = value; setDirty(); },true);
      }
      row.append(action('Remove check',() => { test.checks.splice(index,1); setDirty(); render(); focusCheck(index); })); editor.append(row);
    });
    const addCheck = action('Add check',() => { test.checks.push({ kind: 'value',phase: 'sequential',step_id: baseline?.steps[0]?.id ?? 'step',field: 'output',path: '[]',expected: 'null' }); setDirty(); render(); focusCheck(test.checks.length - 1); },test.checks.length >= RECIPE_REGRESSION_LIMITS.assertions - 1);
    addCheck.setAttribute('data-regression-add-check','');
    editor.append(addCheck,
      action('Duplicate case',() => { const copy = structuredClone(test); copy.id = crypto.randomUUID(); copy.name += ' copy'; cases.push(copy); selected = copy.id; setDirty(); render(); focusCase(); },cases.length >= RECIPE_REGRESSION_LIMITS.cases),
      action('Remove case',() => { cases = cases.filter(item => item !== test); selected = cases[0]!.id; setDirty(); render(); focusCase(); },cases.length === 1));
    body.append(editor);
    if (result) {
      const results = node('section'); results.setAttribute('data-regression-results',''); results.style.minWidth = '0';
      results.append(node('h3',`Working recipe: ${result.passed} passed, ${result.failed} failed. ${result.changed} cases changed.`));
      const note = node('p',`Test version ${result.revision}. Baseline: ${result.cases.filter(item => !item.baseline.passed).length} failed.${stale ? ' Recipe or tests changed since this run.' : ''}`);
      note.setAttribute('data-regression-result-note',''); results.append(note);
      for (const item of result.cases) {
        const detail = node('details'); detail.append(node('summary',`${item.name} · ${item.candidate.passed ? 'passed' : 'failed'} · ${item.changes.length ? 'changed' : 'unchanged'}`));
        for (const [label,side] of [['Baseline',item.baseline],['Working recipe',item.candidate]] as const) {
          detail.append(node('h4',`${label} checks`));
          const list = node('ul'); for (const check of side.assertions) { const entry = node('li',`Check ${check.index + 1}: ${check.passed ? 'passed' : check.message}`); if (!check.passed) pre(entry,{ present: check.present,actual: check.actual }); list.append(entry); } detail.append(list);
        }
        for (const change of item.changes) {
          detail.append(node('h4',`${change.phase} · ${change.step_id} · ${change.kind}: ${change.fields.join(', ')}`));
          for (const [label,side] of [['Before',item.baseline],['After',item.candidate]] as const) {
            const steps = side.simulation.steps.filter(step => step.phase === change.phase), index = steps.findIndex(step => step.id === change.step_id);
            detail.append(node('strong',index >= 0 ? `${label} · position ${index + 1}` : `${label} · step missing`)); pre(detail,steps[index]);
          }
        }
        results.append(detail);
      }
      body.append(results);
    }
    if (restore !== null) body.querySelector<HTMLElement>(`[data-regression-control="${restore}"]`)?.focus();
  };
  const perform = async (operation: () => Promise<void>): Promise<void> => {
    if (busy || disposed) return; const current = ++generation; busy = true; error = ''; render(); options.changed?.();
    try { await operation(); }
    catch (cause) { if (!disposed && current === generation) { error = cause instanceof Error ? cause.message : String(cause); result = undefined; } }
    finally { if (!disposed && current === generation) { busy = false; render(); status(); options.changed?.(); } }
  };
  const load = async (revision?: number): Promise<void> => {
    if (dirty && !confirm('Discard unsaved test edits and load saved tests?')) { render(); return; }
    await perform(async () => { recipe(); const value = await options.caller.get({ recipe_id: options.recipeId,...(revision === undefined ? {} : { revision }) });
      if (disposed) return; accept(value); message = value.version ? `Loaded test version ${value.version.revision}.` : 'No saved tests yet. Add cases and save a version.'; });
  };
  const save = async (): Promise<void> => {
    await perform(async () => { recipe(); pendingSave ??= { recipe_id: options.recipeId,expected_revision: expectedRevision,request_id: crypto.randomUUID(),suite: suite() };
      const value = await options.caller.save(structuredClone(pendingSave)); if (disposed) return;
      // A later head can exist by the time our save reply arrives. It is not a
      // baseline we loaded, so it cannot become the next write's CAS token.
      accept(value,value.version!.revision); message = `Saved test version ${value.version!.revision}.${value.head_revision !== value.version!.revision ? ' Newer tests exist; load them before saving again.' : ''}`; });
  };
  const remove = async (): Promise<void> => {
    if (!pendingDelete && !confirm('Delete every saved test version for this recipe? Unsaved test edits will also be discarded.')) return;
    await perform(async () => { pendingDelete ??= { recipe_id: options.recipeId,expected_revision: expectedRevision,request_id: crypto.randomUUID() };
      const value = await options.caller.remove(pendingDelete); if (disposed) return; accept(value); message = 'Saved tests deleted. The recipe was not changed.'; });
  };
  const run = async (): Promise<void> => {
    if (!saved.version || dirty || busy) return;
    const revision = saved.version.revision, beforeRecipe = recipeEpoch, beforeDraft = draftEpoch;
    result = undefined; stale = false; controller = new AbortController(); const signal = controller.signal;
    await perform(async () => {
      try { const value = await options.caller.run({ recipe_id: options.recipeId,revision,candidate: recipe() },signal); signal.throwIfAborted();
        if (!disposed) { result = value; stale = beforeRecipe !== recipeEpoch || beforeDraft !== draftEpoch; message = stale ? 'Recipe changed since this suite started. Run it again.' : 'Suite finished. Review each case below.'; }
      } catch (cause) { if (signal.aborted) throw new Error('Test suite cancelled. No passing result was recorded.'); throw cause; }
      finally { controller = undefined; }
    });
  };
  root.ontoggle = () => { if (root.open && !loaded && !busy && !dirty) void load(); };
  root.onkeydown = event => {
    if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); if (!busy && (dirty || !saved.version)) void save();
    }
  };
  render();
  return { element: root, load, savedRevision: () => loaded ? saved.head_revision : undefined, hasUnsavedChanges: () => dirty, hasInFlightWork: () => busy,
    recipeChanged() { recipeEpoch++; if (result) { markStale(); message = 'Recipe changed since this suite ran. Run it again.'; const state = body.querySelector<HTMLElement>('[data-regression-status]'); if (state) { state.textContent = message; state.setAttribute('data-state','stale'); } } },
    dispose() { disposed = true; generation++; controller?.abort(); root.remove(); } };
};
