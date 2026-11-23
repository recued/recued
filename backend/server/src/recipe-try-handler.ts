/** D-402 slice C — "Try it" (`recipe.try`): the recipe as Kitchen holds it, unsaved, run once for real in
 *  the owner's browser before it is saved, every change asked about first (§8.1, ruling 8).
 *
 *  The owner's paired webclient only, as Kitchen's other run tools are (`recipe-run-capture-handler.ts`).
 *  The recipe is checked as the editor checks it (`validateRecipeInline`), then run as the Run button
 *  runs a recipe, with the trial's override (`InternalExecuteOverrides.trial`): each change in a web
 *  page asks at its step, on the live page (`bridges/browser-trials.ts`), and every other write is
 *  held as an "always ask" action is, whatever would stand in for it. Recued never saves the draft:
 *  the owner does, in Kitchen. */
import { RpcError, type HandlerSlice, type RecipeDefinition, type ServerRpcRegistry } from '@recued/contracts';

import { browserTrials } from './bridges/browser-trials.js';
import { handleRpcExecute, type ExecuteHandlerDeps } from './execute-handler.js';
import type { ClientTokenStore } from './pairing/client-tokens.js';
import { validateRecipeInline } from './recipe-save-handler.js';
import type { RecipeRunCaptureStore } from './storage/recipe-run-capture-store.js';
import type { WsClient } from './ws-server.js';

export interface RecipeTryDeps {
  clientTokens: Pick<ClientTokenStore, 'get'>;
  /** D-402 slice C (§8.3) — where the trial is recorded for its saved test, which the owner keeps once
   *  the recipe is saved. Absent, the trial runs unrecorded. */
  captures?: Pick<RecipeRunCaptureStore, 'trial'>;
}

/** The largest request a trial takes: the recipe and its settings. */
export const RECIPE_TRY_MAX_BYTES = 1_000_000;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const makeRecipeTryHandlers = (
  deps?: RecipeTryDeps,
  execute?: ExecuteHandlerDeps,
): HandlerSlice<ServerRpcRegistry, 'recipe.try', WsClient> => ({
  methods: ['recipe.try'],
  handlers: {
    'recipe.try': async (raw, client) => {
      if (!deps || !execute) throw new RpcError('not_configured', 'Trying a recipe is unavailable on this server.', 503);
      const token = client.client_token_id ? deps.clientTokens.get(client.client_token_id) : null;
      const instance = client.token_instance_id ?? client.instance_id;
      const owner = (): void => {
        const current = client.client_token_id ? deps.clientTokens.get(client.client_token_id) : null;
        if (client.client_kind !== 'webclient' || !current || current.client_kind !== 'webclient' || current.revoked_at !== null
          || !instance || current.metadata?.instance_id !== instance) {
          throw new RpcError('unauthorized', 'Use your paired webclient to try a recipe.', 403);
        }
      };
      if (!token) throw new RpcError('unauthorized', 'Use your paired webclient to try a recipe.', 403);
      owner();
      if (!record(raw) || !record(raw.recipe)) throw new RpcError('bad_request', 'Send the recipe to try.', 400);
      if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > RECIPE_TRY_MAX_BYTES) {
        throw new RpcError('bad_request', 'Keep a recipe to try under 1 MB.', 400);
      }
      const recipe = raw.recipe as unknown as RecipeDefinition;
      const checked = validateRecipeInline(recipe);
      if (!checked.ok) {
        const errors = checked.issues.filter((issue) => issue.severity === 'error')
          .map((issue) => `${issue.path !== undefined && issue.path !== '' ? `${issue.path}: ` : ''}${issue.message}`);
        throw new RpcError('bad_request', `Fix the recipe before trying it:\n${errors.join('\n')}`, 400);
      }
      // Recorded for its saved test, by the same paired client as Kitchen's captures (`recipe-run-capture-handler.ts`).
      const actor = JSON.stringify([client.client_token_id, client.token_instance_id ?? client.instance_id]);
      const recording = deps.captures?.trial(recipe.recipe_id, actor, owner);
      let run: string | undefined;
      const response = await handleRpcExecute(execute, {
        recipe,
        ...(record(raw.config) ? { config: raw.config } : {}),
        ...(record(raw.context) ? { context: raw.context } : {}),
        trigger_source: 'manual',
      }, client, { trial: true, ...(recording !== undefined ? { regression_capture: recording.recorder,
        onRunMinted: (run_id: string) => { run = run_id; recording.bind(run_id); browserTrials.keepRecorder(run_id, recording.recorder); } } : {}) });
      if (recording === undefined) return response;
      void recording.done.finally(() => { if (run !== undefined) browserTrials.forgetRecorder(run); });
      // A trial that settled says now whether it is a saved test (its replay is bounded); a held one is
      // still being recorded, and says so.
      const held = response.awaiting_approval === true || (response as { awaiting_peer?: boolean }).awaiting_peer === true;
      return { ...response, capture: held ? recording.current() : await recording.done };
    },
  },
});
