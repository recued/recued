import type { Conn, ServerRpcRegistry, RecipeRegressionSave, RecipeRegressionDelete,
  RecipeRegressionRead, RecipeRegressionRun, RecipeRegressionResult } from '@recued/contracts';

export interface RecipeRegressionCaller {
  get(args: { recipe_id: string; revision?: number }): Promise<RecipeRegressionRead>;
  save(args: RecipeRegressionSave): Promise<RecipeRegressionRead>;
  remove(args: RecipeRegressionDelete): Promise<RecipeRegressionRead>;
  run(args: Omit<RecipeRegressionRun,'run_id'>, signal: AbortSignal): Promise<RecipeRegressionResult>;
}
export const createRecipeRegressionCaller = (call: Conn<ServerRpcRegistry>): RecipeRegressionCaller => ({
  get: args => call('recipe.regression.get',args),
  save: args => call('recipe.regression.save',args),
  remove: args => call('recipe.regression.delete',args),
  async run(args,signal) {
    signal.throwIfAborted();
    const run_id = crypto.randomUUID();
    const cancel = (): void => { void call('recipe.regression.cancel',{ run_id }).catch(() => {}); };
    signal.addEventListener('abort',cancel,{ once: true });
    try { return await call('recipe.regression.run',{ ...args,run_id },{ signal,timeout: 65_000 }); }
    finally { signal.removeEventListener('abort',cancel); }
  },
});
