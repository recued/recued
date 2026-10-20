/** Local browser transport fixture. Actual encryption, pairing and CAS are
 * qualified separately through SQLite and real WebSocket tests. */
import { runRecipeRegression } from '@recued/engine';
import type { RecipeDefinition,RecipeRegressionRead,RecipeRegressionVersion } from '@recued/contracts';
import type { RecipeRegressionCaller } from '../../src/kitchen/recipe-editor/recipe-regression-caller.js';
export const regressionHarnessRecipe: RecipeDefinition = { recipe_id: 'regression-browser',version: 1,ttl: 60,
  metadata: { name: 'Regression browser',description: 'A fixture recipe for saved tests.',author: 'owner',supported_platforms: [] },
  variables: {},prefetch_steps: [],steps: [{ id: 'count',transform: 'count',input: [] }],output: { render: [] } };
interface FixtureState { head: number; versions: RecipeRegressionVersion[]; requests: Record<string,{ fingerprint: string; revision: number }> }
export const createRegressionHarnessCaller = (): RecipeRegressionCaller => {
  const key = 'recued-regression-browser', scenario = new URLSearchParams(location.search).get('regression');
  const state = (): FixtureState => JSON.parse(sessionStorage.getItem(key) ?? '{"head":0,"versions":[],"requests":{}}');
  const write = (value: FixtureState) => sessionStorage.setItem(key,JSON.stringify(value));
  const read = (revision?: number): RecipeRegressionRead => {
    const current = state(); return { head_revision: current.head,versions: [...current.versions].reverse().map(({ revision,digest,created_at }) => ({ revision,digest,created_at })),
      version: structuredClone(revision === undefined ? current.versions.at(-1) ?? null : current.versions.find(item => item.revision === revision) ?? null) };
  };
  return {
    async get(args) { return read(args.revision); },
    async save(request) {
      const current = state(), fingerprint = JSON.stringify(request), replay = current.requests[request.request_id];
      if (replay) { if (replay.fingerprint !== fingerprint) throw new Error('Request id changed.'); return read(replay.revision); }
      if (current.head !== request.expected_revision) throw new Error('Tests changed in another tab. Load the latest version.');
      const revision = ++current.head;
      const version: RecipeRegressionVersion = { recipe_id: request.recipe_id,revision,digest: 'sha256:' + String(revision).padStart(64,'0'),created_at: Date.now(),suite: structuredClone(request.suite) };
      current.versions.push(version); current.requests[request.request_id] = { fingerprint,revision }; write(current);
      if (scenario === 'superseded' && revision === 1) {
        const peer = structuredClone(version); peer.revision = 2; peer.digest = 'sha256:' + '2'.repeat(64);
        peer.suite.title = 'Other tab tests'; peer.suite.cases[0]!.name = 'Other tab case';
        current.head = 2; current.versions.push(peer); write(current);
      }
      if (scenario === 'lost' && revision === 1) throw new Error('Save reply lost. Retry saving this version.');
      return read(revision);
    },
    async remove(request) {
      const current = state(), fingerprint = JSON.stringify(request), replay = current.requests[request.request_id];
      if (replay) { if (replay.fingerprint !== fingerprint) throw new Error('Request id changed.'); return read(); }
      if (current.head !== request.expected_revision) throw new Error('Tests changed in another tab.');
      current.head++; current.versions = []; current.requests[request.request_id] = { fingerprint,revision: current.head }; write(current); return read();
    },
    async run(request,signal) {
      const candidate = structuredClone(request.candidate), saved = read(request.revision).version;
      if (!saved) throw new Error('No saved test version.');
      if (scenario === 'slow' || scenario === 'defer') await new Promise<void>((resolve,reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort',abort); resolve(); },scenario === 'slow' ? 20_000 : 800);
        if (signal.aborted) abort(); else signal.addEventListener('abort',abort,{ once: true });
      });
      const result = await runRecipeRegression(saved.suite,candidate,signal);
      return { ...result,recipe_id: request.recipe_id,revision: request.revision,suite_digest: saved.digest,baseline_hash: 'fixture-baseline',candidate_hash: 'fixture-candidate' };
    },
  };
};
