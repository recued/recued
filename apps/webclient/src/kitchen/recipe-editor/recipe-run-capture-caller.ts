import type { Conn, ServerRpcRegistry, RecipeRunCaptureRequest, RecipeRunCaptureSummary, RecipeRunCaptureRead,
  RecipeRunCaptureResult, RecipeRunCaptureImport, RecipeRegressionRead } from '@recued/contracts';
import { WEBCLIENT_RUN_RPC_TIMEOUT_MS } from '../../realtime/rpc-conn.js';
export interface RecipeRunCaptureCaller {
  prepare(request: RecipeRunCaptureRequest): Promise<RecipeRunCaptureSummary>;
  run(request: { capture_id: string }): Promise<RecipeRunCaptureResult>;
  list(request: { recipe_id: string }): Promise<{ captures: RecipeRunCaptureSummary[] }>;
  get(request: { capture_id: string }): Promise<RecipeRunCaptureRead>;
  remove(request: { capture_id: string }): Promise<{ deleted: true }>;
  import(request: RecipeRunCaptureImport): Promise<RecipeRegressionRead>;
}
/** Never retries a live run. Its one-use prepared ID recovers through list/get. */
export const createRecipeRunCaptureCaller = (call: Conn<ServerRpcRegistry>): RecipeRunCaptureCaller => ({
  prepare: request => call('recipe.capture.prepare',request),
  run: request => call('recipe.capture.run',request,{ timeout: WEBCLIENT_RUN_RPC_TIMEOUT_MS }),
  list: request => call('recipe.capture.list',request),
  get: request => call('recipe.capture.get',request),
  remove: request => call('recipe.capture.delete',request),
  import: request => call('recipe.capture.import',request),
});
