import type { Conn, ServerRpcRegistry, RecipeReleaseView, RecipeReleaseSave, RecipeReleaseRestore,
  RecipeReleaseMutation, RecipeReleasePrepare, RecipeReleaseReview, RecipeReleaseActivate,
  RecipeReleaseTest, RecipeReleaseTestResult } from '@recued/contracts';
export interface RecipeReleaseCaller {
  get(args: { recipe_id: string }): Promise<RecipeReleaseView>;
  save(args: RecipeReleaseSave): Promise<RecipeReleaseMutation>;
  restore(args: RecipeReleaseRestore): Promise<RecipeReleaseMutation>;
  test(args: Omit<RecipeReleaseTest,'run_id'>,signal: AbortSignal): Promise<RecipeReleaseTestResult>;
  prepare(args: RecipeReleasePrepare): Promise<RecipeReleaseReview>;
  activate(args: RecipeReleaseActivate): Promise<RecipeReleaseMutation>;
}
export const createRecipeReleaseCaller = (call: Conn<ServerRpcRegistry>): RecipeReleaseCaller => ({
  get: args => call('recipe.release.get',args),save: args => call('recipe.release.save',args),
  restore: args => call('recipe.release.restore',args),prepare: args => call('recipe.release.prepare',args),
  activate: args => call('recipe.release.activate',args),
  async test(args,signal) {
    signal.throwIfAborted(); const run_id = crypto.randomUUID();
    const cancel = (): void => { void call('recipe.regression.cancel',{ run_id }).catch(() => {}); };
    signal.addEventListener('abort',cancel,{ once: true });
    try { return await call('recipe.release.test',{ ...args,run_id },{ signal,timeout: 65_000 }); }
    finally { signal.removeEventListener('abort',cancel); }
  },
});
