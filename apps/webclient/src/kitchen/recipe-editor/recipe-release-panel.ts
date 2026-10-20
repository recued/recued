import type { RecipeDefinition, RecipeReleaseView, RecipeReleaseReview, RecipeReleaseSave,
  RecipeReleaseActivate, RecipeReleaseRestore, RecipeReleaseMutation, RecipeReleaseTestResult } from '@recued/contracts';
import type { RecipeReleaseCaller } from './recipe-release-caller.js';

export const createRecipeReleasePanel = (options: { document: Document; recipeId: string; caller: RecipeReleaseCaller;
  initial?: RecipeReleaseView; getRecipe(): RecipeDefinition; hasUnsavedChanges(): boolean;
  loadRecipe(recipe: RecipeDefinition): void; draftSaved(recipe: RecipeDefinition, unchanged: boolean): void;
  activated(sequence: number): void; changed(): void;
  confirm?: (message: string) => boolean }) => {
  const doc = options.document, root = doc.createElement('details'), body = doc.createElement('div');
  root.className = 'recipe-editor-section'; root.setAttribute('data-recipe-release',''); root.style.cssText = 'min-width:0;max-width:100%;overflow-wrap:anywhere';
  const summary = doc.createElement('summary'); summary.textContent = 'Reviewed releases'; root.append(summary,body);
  body.className = 'recipe-editor-panel-body'; body.style.minWidth = '0';
  let current = options.initial, expected = current?.revision ?? 0, busy = false, disposed = false, edited = false, needsReload = false;
  let workingEpoch = 0;
  let message = current?.managed ? 'Working on the saved draft. The active recipe keeps running until you activate a reviewed release.' : 'Save drafts and review tested changes before replacing the active recipe.';
  let error = '', review: RecipeReleaseReview | undefined, comparison: RecipeReleaseTestResult['comparison'] | undefined;
  let pendingSave: RecipeReleaseSave | undefined, pendingActivation: RecipeReleaseActivate | undefined, pendingRestore: RecipeReleaseRestore | undefined;
  let controller: AbortController | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  let targetRelease = current?.releases.at(-2)?.sequence ?? current?.releases[0]?.sequence ?? 0;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K,text?: string): HTMLElementTagNameMap[K] => { const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  const confirm = (text: string): boolean => options.confirm?.(text) ?? doc.defaultView?.confirm(text) ?? false;
  const status = (): void => { body.querySelector<HTMLElement>('[data-release-status]')?.focus(); };
  const sameWorking = (): boolean => !edited && !!current?.draft;
  const assertWorking = (): void => {
    if (!sameWorking() || JSON.stringify(options.getRecipe()) !== JSON.stringify(current!.draft!.recipe)) throw new Error('Save and test the current working draft before activation.');
  };
  const armExpiry = (): void => {
    if (expiry) clearTimeout(expiry);
    const end = review?.expires_at ?? current?.qualification?.expires_at;
    if (end) expiry = setTimeout(() => { if (disposed) return; review = undefined; if (current) current.qualification = null;
      message = 'The test result or review expired. Run the saved tests again before activation.'; render(); options.changed(); },Math.max(0,end - Date.now()) + 1);
  };
  const accept = (value: RecipeReleaseView, mutationRevision = value.revision): void => {
    current = value; expected = mutationRevision; needsReload = value.revision !== mutationRevision;
    if (!value.releases.some(item => item.sequence === targetRelease)) targetRelease = value.releases.at(-2)?.sequence ?? value.releases[0]?.sequence ?? 0;
    review = undefined; comparison = undefined; armExpiry(); options.changed();
  };
  const button = (label: string, callback: () => void, disabled = false): HTMLButtonElement => {
    const element = node('button',label); element.type = 'button'; element.className = 'recipe-editor-btn'; element.disabled = busy || disabled;
    element.style.cssText = 'max-width:100%;white-space:normal'; element.onclick = callback; return element;
  };
  const json = (parent: HTMLElement,value: unknown): void => { const element = node('pre',JSON.stringify(value,null,2)); element.tabIndex = 0;
    element.style.cssText = 'max-width:100%;max-height:24rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere'; parent.append(element); };
  const render = (): void => {
    if (disposed) return; body.replaceChildren();
    const state = node('p',error || (busy ? controller ? 'Testing the saved release draft…' : 'Loading or saving release state…' : message));
    state.setAttribute('data-release-status',''); state.setAttribute('role',error ? 'alert' : 'status'); state.tabIndex = -1;
    state.setAttribute('data-state',error ? 'error' : busy ? 'running' : needsReload || edited ? 'stale' : current?.qualification ? 'qualified' : 'ready'); body.append(state);
    const controls = node('div'); controls.className = 'recipe-editor-actions'; controls.style.flexWrap = 'wrap'; body.append(controls);
    controls.append(button('Reload saved draft',() => { void reload(); }));
    if (!current) return;
    if (!current.supported) { body.append(node('p',current.reason)); return; }
    body.append(node('p',`Active release: ${current.active?.sequence || 'current saved recipe'}. Saved draft: ${current.draft?.revision ?? 'none'}.`));
    if (!current.managed) {
      body.append(node('p','Start reviewed releases to save this working recipe as a draft. Later ordinary saves cannot replace the active recipe. Existing schedules keep using the active version.'));
      controls.append(button('Start reviewed releases',() => { void saveDraft(); })); return;
    }
    controls.append(button(pendingSave ? 'Retry saving draft' : 'Save release draft',() => { void saveDraft(); },needsReload));
    const test = button('Test saved draft',() => { void runTests(); },!sameWorking() || needsReload); test.setAttribute('data-release-test',''); controls.append(test);
    if (controller) { const cancel = button('Cancel release tests',() => controller?.abort()); cancel.disabled = false; controls.append(cancel); }
    const qualified = !!current.qualification && current.qualification.expires_at > Date.now();
    controls.append(button('Review activation',() => { void prepare(); },!qualified || !sameWorking() || needsReload));
    if (qualified) body.append(node('p',`${current.qualification!.passed} saved cases passed on test version ${current.qualification!.suite_revision}. Valid until ${new Date(current.qualification!.expires_at).toLocaleTimeString()}.`));
    body.append(node('p','Only the exact saved draft can be activated. Draft edits and changes to the saved tests require a fresh test run. These tests use pretend service results.'));
    if (current.releases.length > 1) {
      const label = node('label','Release to restore'), choice = node('select'); choice.setAttribute('aria-label','Release to restore'); choice.style.maxWidth = '100%'; choice.disabled = busy;
      for (const release of [...current.releases].reverse()) { const option = node('option',`Release ${release.sequence}`); option.value = String(release.sequence); choice.append(option); }
      choice.value = String(targetRelease); choice.onchange = () => { targetRelease = Number(choice.value); pendingRestore = undefined; }; label.append(choice); body.append(label);
      body.append(button(pendingRestore ? 'Retry restoring draft' : 'Restore as draft',() => { void restore(); },needsReload));
    }
    if (comparison) {
      const result = node('section'); result.setAttribute('data-release-results','');
      result.append(node('h3',`${comparison.passed} passed, ${comparison.failed} failed`));
      for (const test of comparison.cases) { const detail = node('details'); detail.append(node('summary',`${test.name}: ${test.candidate.passed ? 'passed' : 'failed'}`));
        for (const assertion of test.candidate.assertions) if (!assertion.passed) { detail.append(node('p',`Check ${assertion.index + 1}: ${assertion.message}`)); json(detail,{ present: assertion.present,actual: assertion.actual }); }
        result.append(detail);
      }
      body.append(result);
    }
    if (review) {
      const section = node('section'); section.setAttribute('data-release-review',''); section.append(node('h3',`Review draft ${review.draft_revision} before activation`));
      for (const change of review.changes) { section.append(node('h4',change.path.length ? change.path.join(' → ') : 'Recipe')); json(section,change); }
      if (!review.changes.length && !review.truncated) section.append(node('p','This draft has the same content as the active recipe.'));
      if (review.truncated) section.append(node('p','This summary is shortened. Review the full draft below.'));
      const full = node('details'); full.append(node('summary','Full saved draft')); json(full,current.draft?.recipe); section.append(full);
      const active = node('details'); active.append(node('summary','Full active recipe')); json(active,current.active?.recipe); section.append(active);
      section.append(button(pendingActivation ? 'Retry activation' : 'Activate reviewed draft',() => { void activate(); },!sameWorking() || needsReload || review.expires_at <= Date.now())); body.append(section);
    }
  };
  const perform = async (operation: () => Promise<void>): Promise<void> => {
    if (busy || disposed) return; busy = true; error = ''; render(); options.changed();
    try { await operation(); } catch (cause) { if (!disposed) {
      error = cause instanceof Error ? cause.message : String(cause); comparison = undefined;
      if (current) current.qualification = null;
      if (!pendingActivation) review = undefined;
    } }
    finally { if (!disposed) { busy = false; render(); status(); options.changed(); } }
  };
  const reload = async (): Promise<void> => {
    if (options.hasUnsavedChanges() && !confirm('Discard unsaved recipe edits and load the saved release draft?')) return;
    const before = workingEpoch, priorExpected = expected;
    await perform(async () => { const value = await options.caller.get({ recipe_id: options.recipeId }); if (disposed) return;
      if (before !== workingEpoch) { accept(value,priorExpected); needsReload = true; edited = true; message = 'Newer working edits were kept. Reload explicitly before continuing with saved release state.'; return; }
      accept(value); pendingSave = undefined; pendingActivation = undefined; pendingRestore = undefined;
      if (value.managed && value.draft) options.loadRecipe(value.draft.recipe);
      // Loading updates the editor epoch synchronously. Acknowledge that saved
      // snapshot after its change notification, so it remains ready for tests.
      edited = false;
      message = value.managed ? `Loaded release draft ${value.draft!.revision}. The active recipe was not changed.` : 'Reviewed releases have not been started for this local recipe.';
    });
  };
  const saved = (value: RecipeReleaseMutation, recipe: RecipeDefinition, unchanged: boolean): void => {
    accept(value,value.mutation_revision); options.draftSaved(recipe,unchanged); edited = !unchanged;
    message = `Saved release draft ${value.saved_draft!.revision}. The active recipe was not changed.${needsReload ? ' Newer changes exist; reload before continuing.' : ''}`;
  };
  const saveDraft = async (): Promise<void> => {
    const before = workingEpoch;
    await perform(async () => {
      const recipe = structuredClone(options.getRecipe());
      if (recipe.recipe_id !== options.recipeId) throw new Error('Save this recipe under its new id and reopen it before using reviewed releases.');
      if (!current?.supported || !current.active) throw new Error('Load the release state for a saved local recipe first.');
      pendingSave ??= { recipe_id: options.recipeId,expected_revision: expected,expected_active_digest: current.active.digest,request_id: crypto.randomUUID(),candidate: recipe };
      const snapshot = structuredClone(pendingSave.candidate), result = await options.caller.save(structuredClone(pendingSave)); if (disposed) return;
      pendingSave = undefined; pendingActivation = undefined; pendingRestore = undefined; saved(result,snapshot,before === workingEpoch);
    });
  };
  const runTests = async (): Promise<void> => {
    if (!current?.draft || !sameWorking() || busy || needsReload) return;
    const draft = current.draft.revision; review = undefined; current.qualification = null; comparison = undefined; controller = new AbortController(); const signal = controller.signal;
    await perform(async () => { try {
      assertWorking();
      const value = await options.caller.test({ recipe_id: options.recipeId,expected_revision: expected,draft_revision: draft },signal); signal.throwIfAborted();
      if (disposed) return; accept(value); comparison = value.comparison;
      message = edited ? 'Working edits changed while tests ran. Save and test the new draft.' : value.qualification ? 'Saved draft passed. Review the changes before activation.' : 'Saved draft did not pass. Review the failed checks below.';
    } catch (cause) { if (signal.aborted) throw new Error('Release tests cancelled. No passing result was kept.'); throw cause; }
    finally { controller = undefined; } });
  };
  const prepare = async (): Promise<void> => {
    if (!current?.draft || !current.qualification || !sameWorking() || needsReload) return;
    await perform(async () => { assertWorking(); const value = await options.caller.prepare({ recipe_id: options.recipeId,expected_revision: expected,draft_revision: current!.draft!.revision,receipt_id: current!.qualification!.receipt_id });
      if (disposed) return; review = value; pendingActivation = undefined; armExpiry(); message = 'Review the before and after values. Activate only when these are the intended changes.'; });
  };
  const activate = async (): Promise<void> => {
    if (!review || !sameWorking() || needsReload) return;
    const before = workingEpoch;
    await perform(async () => {
      assertWorking();
      pendingActivation ??= { recipe_id: options.recipeId,expected_revision: expected,review_id: review!.review_id,request_id: crypto.randomUUID() };
      const value = await options.caller.activate(structuredClone(pendingActivation)); if (disposed) return;
      pendingActivation = undefined; accept(value,value.mutation_revision); options.draftSaved(value.activated!.recipe,before === workingEpoch); options.activated(value.activated!.sequence);
      message = `Activated release ${value.activated!.sequence}.${needsReload ? ' Newer changes exist; reload before continuing.' : ''}`;
    });
  };
  const restore = async (): Promise<void> => {
    if (!current?.active || needsReload) return;
    if (options.hasUnsavedChanges() && !confirm('Discard unsaved edits and restore the selected release as a new draft?')) return;
    const before = workingEpoch;
    await perform(async () => {
      pendingRestore ??= { recipe_id: options.recipeId,expected_revision: expected,expected_active_digest: current!.active!.digest,request_id: crypto.randomUUID(),sequence: targetRelease };
      const value = await options.caller.restore(structuredClone(pendingRestore)); if (disposed) return;
      pendingRestore = undefined; accept(value,value.mutation_revision);
      if (before !== workingEpoch) { needsReload = true; edited = true; message = 'The release was restored as a saved draft. Newer working edits were kept; reload explicitly to open the restored draft.'; return; }
      options.loadRecipe(value.saved_draft!.recipe); edited = false;
      message = `Restored release ${targetRelease} as draft ${value.saved_draft!.revision}. Test and review it before activation.`;
    });
  };
  root.ontoggle = () => { if (root.open && !current && !busy) void reload(); };
  root.onkeydown = event => { if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); if (options.hasUnsavedChanges() || !current?.managed || pendingSave) void saveDraft();
  } };
  render(); armExpiry();
  return { element: root, saveDraft, managesCurrentRecipe: () => current?.managed === true,hasInFlightWork: () => busy,
    recipeChanged() { workingEpoch++; edited = true; review = undefined; pendingSave = undefined; pendingActivation = undefined; pendingRestore = undefined; render(); },
    dispose() { disposed = true; controller?.abort(); if (expiry) clearTimeout(expiry); root.remove(); } };
};
