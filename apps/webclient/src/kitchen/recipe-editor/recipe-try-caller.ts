import type { Conn, RecipeDefinition, RecipeRunCaptureSummary, ServerExecuteResponse, ServerRpcRegistry } from '@recued/contracts';

/** D-402 slice C — how long Kitchen waits for a trial ("Try it"). Each change in it waits up to five
 *  minutes for the owner's answer, and a trial may make several, so it waits longer than a run from the
 *  Run button (`WEBCLIENT_RUN_RPC_TIMEOUT_MS`). Still bounded, and a dropped connection fails the call at
 *  once; the trial goes on at the server, and its result shows in Logs. */
export const WEBCLIENT_TRIAL_RPC_TIMEOUT_MS = 30 * 60_000;

/** A trial's answer: the run's, and whether it is the recipe's saved test (`RecipeRunCaptureSummary`). */
export type RecipeTryResult = ServerExecuteResponse & { capture?: RecipeRunCaptureSummary };

export type RecipeTryCaller = (args: { recipe: RecipeDefinition; config?: Record<string, unknown> }) => Promise<RecipeTryResult>;

/** D-402 slice C — "Try it": the recipe as the editor holds it, unsaved, run once for real in the owner's
 *  browser, every change asked about first (`recipe.try`). */
export const createRecipeTryCaller = (call: Conn<ServerRpcRegistry>): RecipeTryCaller =>
  (args) => call('recipe.try', args, { timeout: WEBCLIENT_TRIAL_RPC_TIMEOUT_MS });
