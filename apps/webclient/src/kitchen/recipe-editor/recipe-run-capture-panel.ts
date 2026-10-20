import { regressionObject, parseRecipeRegressionCases,
  type RecipeRunCaptureRead, type RecipeRunCaptureSummary, type RecipeRunCaptureImport,
  type RecipeRegressionRead, type RecipeRunCaptureRequest } from '@recued/contracts';
import type { RecipeRunCaptureCaller } from './recipe-run-capture-caller.js';
import type { RecipeRegressionCaller } from './recipe-regression-caller.js';

/** Stable authoring subtree. Recording runs the installed recipe; imported
 * tests remain fixture-only and use the existing versioned regression store. */
export const createRecipeRunCapturePanel = (options: { document: Document; recipeId: string;
  caller: RecipeRunCaptureCaller; regressionCaller: RecipeRegressionCaller;
  testsBusy(): boolean; imported(value: RecipeRegressionRead): void; changed(): void }) => {
  const doc = options.document, root = doc.createElement('details'); root.setAttribute('data-recipe-run-capture','');
  root.className = 'recipe-editor-section'; root.style.cssText = 'min-width:0;max-width:100%;overflow-wrap:anywhere';
  let disposed = false, busy = false, loaded = false, requestDirty = false, draftDirty = false, uncertainRun = false;
  let runText = '{\n  "config": {},\n  "context": {}\n}', caseText = '', captures: RecipeRunCaptureSummary[] = [];
  let selected: RecipeRunCaptureRead | undefined, expectedRevision = 0, acknowledged = false, imported = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let pending: RecipeRunCaptureImport | undefined, message = 'Capture a new run, then review its data before saving a test.', error = '';
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K,text?: string): HTMLElementTagNameMap[K] => {
    const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; return el;
  };
  const summary = node('summary','Capture a run as a saved test'), body = node('div'); body.className = 'recipe-editor-panel-body'; body.style.minWidth = '0'; root.append(summary,body);
  const canImport = (): boolean => !busy && !options.testsBusy() && !!selected?.draft && selected.capture.expires_at > Date.now() && acknowledged && !imported;
  const refreshAvailability = (): void => {
    const save = body.querySelector<HTMLButtonElement>('[data-capture-import]'); if (save) save.disabled = !canImport();
  };
  const changed = (): void => { options.changed(); refreshAvailability(); };
  const button = (text: string,action: () => void,disabled = false): HTMLButtonElement => {
    const el = node('button',text); el.type = 'button'; el.className = 'recipe-editor-btn'; el.disabled = busy || disabled;
    el.style.cssText = 'max-width:100%;white-space:normal'; el.onclick = action; return el;
  };
  const textarea = (label: string,value: string,onInput: (value: string) => void): HTMLTextAreaElement => {
    const group = node('label',label), el = node('textarea'); el.value = value; el.rows = 10; el.disabled = busy;
    el.setAttribute('aria-label',label); el.style.cssText = 'box-sizing:border-box;display:block;width:100%;min-width:0;max-width:100%;font:inherit';
    el.oninput = () => onInput(el.value); group.append(el); body.append(group); return el;
  };
  const status = (): void => body.querySelector<HTMLElement>('[data-capture-status]')?.focus();
  const render = (): void => {
    if (disposed) return; body.replaceChildren();
    body.append(node('p','Run the installed recipe using its real connections and normal approvals. Unsaved recipe edits are not run. Capture keeps settings and step results privately for ten minutes.'));
    body.append(node('p','Vault and connection namespaces are excluded. Common credential fields are redacted; inspect the remaining data before saving. Saved tests use pretend service results.'));
    const state = node('p',error || (busy ? 'Working on the captured run…' : message)); state.setAttribute('data-capture-status',''); state.setAttribute('role',error ? 'alert' : 'status'); state.tabIndex = -1; body.append(state);
    textarea('Run settings and event context (JSON)',runText,value => { runText = value; requestDirty = true; changed(); });
    const actions = node('div'); actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
    actions.append(button('Run installed recipe and capture',() => { void start(); },uncertainRun || captures.some(item => item.state === 'running')),
      button('Reload captured runs',() => { void reload(); })); body.append(actions);
    const list = node('ul'); list.style.cssText = 'min-width:0;padding-inline-start:20px';
    for (const capture of captures) {
      const row = node('li'); row.append(node('span',`${new Date(capture.created_at).toLocaleTimeString()} · ${capture.state} `));
      row.append(button('Review capture',() => { void load(capture.capture_id); }));
      if (capture.state === 'prepared') row.append(button('Run prepared capture',() => { if (discard()) void run(capture.capture_id); }));
      if (capture.state !== 'running') row.append(button('Remove capture',() => { void remove(capture.capture_id); }));
      list.append(row);
    }
    body.append(list);
    if (selected) {
      body.append(node('p',`Capture ${selected.capture.capture_id}. Expires ${new Date(selected.capture.expires_at).toLocaleTimeString()}.`));
      if (selected.capture.run_outcome) {
        body.append(node('p',`Live run outcome: ${selected.capture.run_outcome}. This is separate from whether a test draft was captured.`));
        const logs = node('a','Open Logs for run details'); logs.href = '#logs'; body.append(logs);
      }

      if (!selected.draft) body.append(node('p',selected.capture.reason ?? 'This capture has not produced an importable test. Reload captured runs after it finishes.'));
      else {
        const draft = selected.draft, definition = node('details'); definition.append(node('summary','Captured recipe definition'));
        const pre = node('pre',JSON.stringify(draft.recipe,null,2)); pre.tabIndex = 0; pre.style.cssText = 'min-width:0;max-width:100%;max-height:24rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere'; definition.append(pre); body.append(definition);
        body.append(node('p',`Recorded recipe digest: ${draft.source_recipe_digest}. Test recipe digest: ${draft.recipe_digest}. ${draft.redactions.length} redaction locations listed. ${draft.checks_omitted} checks omitted by the case limit.`));
        if (draft.redactions.length) { const pre = node('pre',draft.redactions.join('\n')); pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'; body.append(pre); }
        body.append(node('p',draft.replay_matches ? 'The generated fixture reproduces the captured step results.' : 'Redaction changed replayed results. Review and edit the expected values before importing, then run the saved suite.'));
        body.append(node('p',`Import adds one case to saved test revision ${expectedRevision}. An existing suite keeps its baseline and other cases. A first suite uses the captured recipe. Edit expectations to describe the behavior you want; an observed failure is not automatically the desired result.`));
        textarea('Captured test case (JSON)',caseText,value => {
          caseText = value; draftDirty = true; acknowledged = false; pending = undefined;
          const ack = body.querySelector<HTMLInputElement>('[data-capture-ack]'); if (ack) ack.checked = false; changed();
        });
        const label = node('label'), ack = node('input'); ack.type = 'checkbox'; ack.checked = acknowledged; ack.disabled = busy; ack.setAttribute('data-capture-ack','');
        ack.onchange = () => { acknowledged = ack.checked; refreshAvailability(); }; label.append(ack,doc.createTextNode(' I reviewed the captured data and expected results.')); body.append(label);
        const saveButton = button(pending ? 'Retry importing case' : 'Import into saved tests',() => { void save(); }); saveButton.setAttribute('data-capture-import',''); saveButton.disabled = !canImport(); body.append(saveButton);
        if (options.testsBusy()) body.append(node('p','Finish or save edits in Saved recipe tests before importing.'));
      }
    }
  };
  const discard = (): boolean => !draftDirty || (doc.defaultView?.confirm('Discard unfinished captured-test edits?') ?? false);
  const perform = async (operation: () => Promise<void>): Promise<void> => {
    if (busy || disposed) return; busy = true; error = ''; render(); changed();
    try { await operation(); } catch (cause) { if (!disposed) error = cause instanceof Error ? cause.message : String(cause); }
    finally { if (!disposed) { busy = false; render(); changed(); status(); } }
  };
  const refreshList = async (): Promise<void> => {
    const value = await options.caller.list({ recipe_id: options.recipeId }); if (disposed) return;
    captures = value.captures; loaded = true; uncertainRun = false;
  };
  const accept = async (id: string): Promise<void> => {
    const [value,tests] = await Promise.all([options.caller.get({ capture_id: id }),options.regressionCaller.get({ recipe_id: options.recipeId })]);
    if (disposed) return; selected = value; expectedRevision = tests.head_revision; caseText = value.draft ? JSON.stringify(value.draft.case,null,2) : '';
    draftDirty = false; acknowledged = false; pending = undefined; imported = !!tests.version?.suite.cases.some(test => test.id === id);
    if (expiry) clearTimeout(expiry);
    expiry = setTimeout(() => {
      if (disposed || selected?.capture.capture_id !== id) return;
      message = 'The temporary capture expired. Unfinished edits remain here to copy, but this capture can no longer be imported.';
      const state = body.querySelector('[data-capture-status]'); if (state) state.textContent = message;
      refreshAvailability(); changed();
    },Math.max(0,value.capture.expires_at - Date.now()) + 1);

    message = imported ? 'This captured case is already in the latest saved suite.' : 'Review the captured case, remove private data and set the expected behavior.';
  };
  const run = async (id: string): Promise<void> => perform(async () => {
    uncertainRun = true;
    try {
      const value = await options.caller.run({ capture_id: id }); if (disposed) return;
      requestDirty = false; await refreshList(); await accept(id);
      if (value.capture.state !== 'ready') message = value.capture.reason ?? 'Run finished without an importable capture.';
    } catch (cause) {
      try { await refreshList(); } catch { /* The original lost-run reply stays visible. */ }
      throw new Error(`${cause instanceof Error ? cause.message : String(cause)} Reload captured runs and check Logs before starting another run.`);
    }
  });
  const start = async (): Promise<void> => {
    if (!discard() || busy || disposed || uncertainRun || captures.some(item => item.state === 'running')) return;
    let id = '';
    await perform(async () => {
      const raw = regressionObject(JSON.parse(runText),['config','context','dish_id','connections']);
      const request: RecipeRunCaptureRequest = { recipe_id: options.recipeId };
      for (const key of ['config','context'] as const) if (raw[key] !== undefined) request[key] = regressionObject(raw[key]);
      if (raw.dish_id !== undefined) { if (typeof raw.dish_id !== 'string') throw new Error('Dish ID must be text.'); request.dish_id = raw.dish_id; }
      if (raw.connections !== undefined) request.connections = Object.fromEntries(Object.entries(regressionObject(raw.connections)).map(([key,value]) => {
        if (typeof value !== 'string') throw new Error('Connection choices must be text.'); return [key,value];
      }));
      const prepared = await options.caller.prepare(request); if (!disposed) id = prepared.capture_id;
    });
    if (id && !disposed) await run(id);
  };
  const reload = async (): Promise<void> => perform(async () => { await refreshList(); message = 'Captured runs reloaded. Review a ready capture to import a case.'; });
  const load = async (id: string): Promise<void> => { if (!discard()) return; await perform(() => accept(id)); };
  const remove = async (id: string): Promise<void> => {
    if (selected?.capture.capture_id === id && !discard()) return;
    await perform(async () => { await options.caller.remove({ capture_id: id }); if (disposed) return;
      if (selected?.capture.capture_id === id) { selected = undefined; draftDirty = false; acknowledged = false; pending = undefined; }
      await refreshList(); message = 'Temporary capture removed. Saved tests were not changed.';
    });
  };
  const save = async (): Promise<void> => {
    if (!canImport()) return;
    await perform(async () => {
      pending ??= { capture_id: selected!.capture.capture_id,recipe_digest: selected!.draft!.recipe_digest,
        expected_revision: expectedRevision,request_id: crypto.randomUUID(),reviewed: true,case: parseRecipeRegressionCases([JSON.parse(caseText)])[0]! };
      const result = await options.caller.import(structuredClone(pending)); if (disposed) return;
      expectedRevision = result.version!.revision; pending = undefined; draftDirty = false; imported = true; acknowledged = false;
      message = `Imported captured case in saved test version ${result.version!.revision}. Run it in Saved recipe tests.`; options.imported(result);
    });
  };
  root.ontoggle = () => { if (root.open && !loaded && !busy) void reload(); };
  render();
  return { element: root,refreshAvailability,hasUnsavedChanges: () => requestDirty || draftDirty,hasInFlightWork: () => busy,
    dispose() { disposed = true; if (expiry) clearTimeout(expiry); root.remove(); } };
};
