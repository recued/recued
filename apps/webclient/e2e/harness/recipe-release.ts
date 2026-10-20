/** Browser-only transport fixture. Production storage, pairing, proof checking
 * and atomic activation are tested through SQLite and actual WebSocket RPC. */
import { runRecipeRegression } from '@recued/engine';
import type { RecipeDefinition, RecipeReleaseView, RecipeReleaseMutation, RecipeReleaseReview,
  RecipeRegressionVersion } from '@recued/contracts';
import type { RecipeReleaseCaller } from '../../src/kitchen/recipe-editor/recipe-release-caller.js';
import { regressionHarnessRecipe } from './recipe-regression.js';
interface State { view: RecipeReleaseView; requests: Record<string,{ fingerprint: string; result: RecipeReleaseMutation }>; review: RecipeReleaseReview | null }
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
};
const digest = async (value: unknown): Promise<string> => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2,'0')).join('');
export const createReleaseHarnessCaller = (): RecipeReleaseCaller => {
  const key = 'recued-release-browser', scenario = new URLSearchParams(location.search).get('releases');
  const read = async (): Promise<State> => {
    const stored = sessionStorage.getItem(key); if (stored) return JSON.parse(stored);
    return { view: { recipe_id: regressionHarnessRecipe.recipe_id,supported: true,managed: false,revision: 0,
      active: { sequence: 0,digest: await digest(regressionHarnessRecipe),created_at: 0,recipe: structuredClone(regressionHarnessRecipe) },draft: null,drafts: [],releases: [],qualification: null },requests: {},review: null };
  };
  const write = (state: State) => sessionStorage.setItem(key,JSON.stringify(state));
  const suite = (): RecipeRegressionVersion | null => {
    const saved = JSON.parse(sessionStorage.getItem('recued-regression-browser') ?? '{"versions":[]}') as { versions: RecipeRegressionVersion[] };
    return saved.versions.at(-1) ?? null;
  };
  const checkRevision = (state: State, expected: number): void => { if (state.view.revision !== expected) throw new Error('The release draft changed in another tab. Reload the saved draft.'); };
  const fresh = (state: State): void => { if (!state.view.qualification || state.view.qualification.suite_revision !== suite()?.revision) throw new Error('Saved tests changed. Run them again before activation.'); };
  const replay = (state: State, request: { request_id: string }): RecipeReleaseMutation | undefined => {
    const prior = state.requests[request.request_id]; if (!prior) return;
    if (prior.fingerprint !== JSON.stringify(request)) throw new Error('Request id changed.');
    return { ...structuredClone(prior.result),...structuredClone(state.view),mutation_revision: prior.result.mutation_revision };
  };
  const save = async (candidate: RecipeDefinition, request: { request_id: string; expected_revision: number }, state: State): Promise<RecipeReleaseMutation> => {
    checkRevision(state,request.expected_revision); const active = state.view.active!;
    if (!state.view.managed) { active.sequence = 1; state.view.releases = [{ sequence: 1,digest: active.digest,created_at: 1 }]; }
    state.view.managed = true; state.view.revision++;
    const draft = { revision: state.view.revision,digest: await digest(candidate),base_digest: active.digest,created_at: Date.now(),recipe: structuredClone(candidate) };
    state.view.draft = draft; const { recipe: _recipe,...metadata } = draft; state.view.drafts.push(metadata); state.view.qualification = null; state.review = null;
    const result: RecipeReleaseMutation = { ...structuredClone(state.view),mutation_revision: state.view.revision,saved_draft: structuredClone(draft) };
    state.requests[request.request_id] = { fingerprint: JSON.stringify(request),result }; write(state); return result;
  };
  return {
    async get() { if (scenario === 'late-load') await new Promise(resolve => setTimeout(resolve,800)); return structuredClone((await read()).view); },
    async save(request) {
      const state = await read(), prior = replay(state,request); if (prior) return prior;
      const result = await save(request.candidate,request,state);
      if (scenario === 'late-save' && result.mutation_revision === 1) await new Promise(resolve => setTimeout(resolve,800));
      if (scenario === 'peer' && result.mutation_revision === 1) {
        const peer = structuredClone(request.candidate); peer.steps[0] = { id: 'count',transform: 'count',input: [99] };
        await save(peer,{ request_id: 'peer',expected_revision: 1 },state); return { ...result,...structuredClone(state.view),mutation_revision: 1 };
      }
      if (scenario === 'lost-save' && result.mutation_revision === 1) throw new Error('Draft save reply lost. Retry saving the same draft.');
      return result;
    },
    async restore(request) {
      const state = await read(), prior = replay(state,request); if (prior) return prior;
      const historic = request.sequence === 1 ? regressionHarnessRecipe : Object.values(state.requests).map(item => item.result.activated).find(item => item?.sequence === request.sequence)?.recipe;
      if (!historic) throw new Error('Release no longer retained.');
      const result = await save(historic,request,state);
      if (scenario === 'late-restore') await new Promise(resolve => setTimeout(resolve,800));
      return result;
    },
    async test(request,signal) {
      const state = await read(); checkRevision(state,request.expected_revision); state.view.qualification = null; state.review = null; write(state);
      const draft = structuredClone(state.view.draft!), saved = suite(); if (!saved) throw new Error('Save a recipe test suite first.');
      if (scenario === 'slow' || scenario === 'defer') await new Promise<void>((resolve,reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort',abort); resolve(); },scenario === 'slow' ? 20_000 : 800);
        if (signal.aborted) abort(); else signal.addEventListener('abort',abort,{ once: true });
      });
      const result = await runRecipeRegression(saved.suite,draft.recipe,signal); signal.throwIfAborted();
      const current = await read(); checkRevision(current,request.expected_revision);
      if (result.failed === 0) current.view.qualification = { receipt_id: crypto.randomUUID(),draft_revision: draft.revision,candidate_digest: draft.digest,
        suite_revision: saved.revision,suite_digest: saved.digest,passed: result.passed,expires_at: Date.now() + 900_000 };
      write(current); return { ...structuredClone(current.view),comparison: { ...result,recipe_id: draft.recipe.recipe_id,revision: saved.revision,suite_digest: saved.digest,candidate_hash: draft.digest,baseline_hash: await digest(saved.suite.baseline) } };
    },
    async prepare(request) {
      const state = await read(); checkRevision(state,request.expected_revision); fresh(state);
      const review: RecipeReleaseReview = { review_id: crypto.randomUUID(),draft_revision: state.view.draft!.revision,candidate_digest: state.view.draft!.digest,active_digest: state.view.active!.digest,
        expires_at: Date.now() + 300_000,changes: [{ path: ['steps'],before_present: true,after_present: true,before: state.view.active!.recipe.steps,after: state.view.draft!.recipe.steps }],truncated: false };
      state.review = review; write(state); return review;
    },
    async activate(request) {
      const state = await read(), prior = replay(state,request); if (prior) return prior;
      checkRevision(state,request.expected_revision); fresh(state);
      if (state.review?.review_id !== request.review_id) throw new Error('Activation review changed.');
      const activated = { sequence: state.view.active!.sequence + 1,digest: state.view.draft!.digest,created_at: Date.now(),recipe: structuredClone(state.view.draft!.recipe) };
      state.view.active = activated; const { recipe: _recipe,...metadata } = activated; state.view.releases.push(metadata); state.view.revision++; state.view.qualification = null; state.review = null;
      const result = { ...structuredClone(state.view),mutation_revision: state.view.revision,activated };
      state.requests[request.request_id] = { fingerprint: JSON.stringify(request),result }; write(state);
      if (scenario === 'lost-activate') throw new Error('Activation reply lost. Retry activation.');
      return result;
    },
  };
};
