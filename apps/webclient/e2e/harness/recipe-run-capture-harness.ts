/** Private transport fixture: real editor, capture compiler and fixture engine.
 * Actual pairing/execution/storage are covered by the server RPC test. */
import { NS,type NamespaceStores,type RecipeDefinition,type RecipeRegressionRead,type RecipeRunCaptureRead,
  type RecipeRunCaptureSummary,type RecipeRunCaptureRequest } from '@recued/contracts';
import { executeRecipe,buildRecipeRunCaptureDraft,copyRecipeCaptureJson,runRecipeRegression,simulateRecipe,type RecipeRunCaptureInput } from '@recued/engine';
import { bootstrapRecipeEditorRoute } from '../../src/kitchen/recipe-editor/recipe-editor-route.js';
import type { RecipeRunCaptureCaller } from '../../src/kitchen/recipe-editor/recipe-run-capture-caller.js';
import type { RecipeRegressionCaller } from '../../src/kitchen/recipe-editor/recipe-regression-caller.js';
const scenario = new URLSearchParams(location.search).get('scenario');
const recipe: RecipeDefinition = { recipe_id: 'capture-fixture',version: 1,ttl: 0,
  metadata: { name: 'Captured fixture',description: 'Private capture fixture.',author: 'owner',supported_platforms: [] },variables: { rows: null },
  steps: [{ id: 'count',transform: 'count',input: '{{config.rows}}',...(scenario === 'failed' ? { fail_on: '{{step.count}} greater 0' } : {}) }],prefetch_steps: [],output: { render: [] } };
const key = 'recipe-capture-fixture';
interface State { requests: Record<string,RecipeRunCaptureRequest>; captures: Record<string,RecipeRunCaptureRead>; runs: number; imports: number; suite: RecipeRegressionRead; receipts: Record<string,RecipeRegressionRead> }
const read = (): State => JSON.parse(sessionStorage.getItem(key) ?? JSON.stringify({ requests: {},captures: {},runs: 0,imports: 0,suite: { head_revision: 0,versions: [],version: null },receipts: {} }));
const write = (state: State) => sessionStorage.setItem(key,JSON.stringify(state));
const caller: RecipeRunCaptureCaller = {
  async prepare(request) {
    const state = read(), capture_id = crypto.randomUUID(), capture: RecipeRunCaptureSummary = { capture_id,recipe_id: request.recipe_id,created_at: Date.now(),expires_at: Date.now() + 600_000,state: 'prepared' };
    state.requests[capture_id] = request; state.captures[capture_id] = { capture,draft: null }; write(state); return capture;
  },
  async run({ capture_id }) {
    let state = read(); const selected = state.captures[capture_id]!;
    if (selected.capture.state !== 'prepared') throw new Error('This capture already started.');
    selected.capture.state = 'running'; state.runs++; write(state);
    if (scenario === 'slow') await new Promise(resolve => setTimeout(resolve,1000));
    const request = state.requests[capture_id]!, stores = Object.fromEntries([...NS].map(key => [key,Object.create(null)])) as NamespaceStores;
    stores.config = request.config ?? {}; stores.context = request.context ?? {};
    let input: RecipeRunCaptureInput | undefined;
    const execution = await executeRecipe({ recipe: structuredClone(recipe),stores,ingredientExecutor: async () => { throw new Error('Fixture never dispatches providers'); },onTestCaptureInput: value => { input = copyRecipeCaptureJson(value); } });
    state = read(); const captured = state.captures[capture_id]!;
    captured.capture.run_outcome = scenario === 'held' ? 'held' : execution.success ? 'passed' : 'failed';
    if (scenario === 'held') { captured.capture.state = 'unavailable'; captured.capture.reason = 'Held run is incomplete and cannot be imported.'; }
    else { captured.draft = await buildRecipeRunCaptureDraft(capture_id,input!,execution); captured.capture.state = 'ready'; }
    write(state); if (scenario === 'lost-run') throw new Error('Run reply lost.'); return { execution: { recipe_id: execution.recipe_id,recipe_hash: execution.recipe_hash,success: execution.success,
      output: execution.output,steps: execution.steps,errors: execution.errors,duration_ms: execution.duration_ms },capture: captured.capture };
  },
  async list() { return { captures: Object.values(read().captures).map(item => item.capture) }; },
  async get({ capture_id }) {
    const value = read().captures[capture_id]; if (!value || value.capture.expires_at <= Date.now()) throw new Error('Capture expired.'); return value;
  },
  async remove({ capture_id }) { const state = read(); delete state.captures[capture_id]; write(state); return { deleted: true }; },
  async import(request) {
    const state = read(); if (state.receipts[request.request_id]) return state.receipts[request.request_id]!;
    if (state.suite.head_revision !== request.expected_revision) throw new Error('Saved tests changed. Reload before importing.');
    const captured = state.captures[request.capture_id]!; if (captured.capture.expires_at <= Date.now()) throw new Error('Capture expired.');
    if (!request.reviewed || request.recipe_digest !== captured.draft?.recipe_digest) throw new Error('Review this exact capture.');
    const revision = state.suite.head_revision + 1;
    const suite = state.suite.version?.suite ?? { title: 'Captured recipe tests',baseline: captured.draft.recipe,cases: [] };
    if (suite.cases.some(test => test.id === request.case.id)) throw new Error('Capture already imported.');
    suite.cases.push(request.case);
    const version = { recipe_id: recipe.recipe_id,revision,digest: 'suite-' + revision,created_at: Date.now(),suite };
    state.suite = { head_revision: revision,versions: [{ revision,digest: version.digest,created_at: version.created_at }],version }; state.imports++; state.receipts[request.request_id] = state.suite; write(state);
    if (scenario === 'lost-import') throw new Error('Import reply lost.'); return state.suite;
  },
};
const tests: RecipeRegressionCaller = {
  async get() { return read().suite; },
  async save(request) { const state = read(); if (state.suite.head_revision !== request.expected_revision) throw new Error('Saved tests changed.');
    const revision = request.expected_revision + 1,version = { recipe_id: recipe.recipe_id,revision,digest: 'suite-' + revision,created_at: Date.now(),suite: request.suite };
    state.suite = { head_revision: revision,versions: [{ revision,digest: version.digest,created_at: version.created_at }],version }; write(state); return state.suite;
  },
  async remove() { const state = read(); state.suite = { head_revision: state.suite.head_revision + 1,versions: [],version: null }; write(state); return state.suite; },
  async run(request,signal) { const saved = read().suite.version!; return { ...await runRecipeRegression(saved.suite,request.candidate,signal),recipe_id: recipe.recipe_id,revision: saved.revision,suite_digest: saved.digest,baseline_hash: 'before',candidate_hash: 'after' }; },
};
const route = bootstrapRecipeEditorRoute({ root: document.querySelector<HTMLElement>('#root')!,document,initialRecipe: recipe,
  captureCaller: caller,regressionCaller: tests,simulateCaller: ({ recipe,sample },signal) => simulateRecipe(recipe,sample,signal),
  validateCaller: async () => ({ ok: true,issues: [] }),saveCaller: async () => ({ saved: true,recipe_id: recipe.recipe_id,version: recipe.version,name: recipe.metadata.name }) });
Object.assign(window,{ captureFixture: { hasUnsavedChanges: () => route.hasUnsavedChanges(),hasInFlightWork: () => route.hasInFlightWork() } });
