/** D-402 slice F4 (§7.9) — the owner's rpc over what callers may do without asking: list the
 *  pre-approvals the owner's chats and AI apps hold ("Happening without asking"), and "Stop allowing" one
 *  caller's permissions for one recipe (`stop-allowing.ts`). Registered in the `collection.contract.`
 *  slice, which MCP never reaches: an AI app gives up its own through an op of its own, never this. */

import {
  readPreapprovalCaller,
  RpcError,
  type CallerPreapprovalRow,
  type CallerPreapprovalView,
  type RecipeDefinition,
  type StopAllowingResult,
} from '@recued/contracts';

import { stopAllowing, type StopAllowingDeps } from './stop-allowing.js';
import type { TriggerPreapprovalStore } from './storage/trigger-preapproval-store.js';
import { triggerPreapprovalRecipeSha256 } from './trigger-preapproval-rpc.js';

export interface CallerPreapprovalRpcDeps {
  readonly store?: Pick<TriggerPreapprovalStore, 'listCallers'>;
  /** What "Stop allowing" reaches; read when it is asked, as the stores are wired late. */
  readonly stopDeps?: () => StopAllowingDeps;
  readonly recipeOf?: (recipe_id: string) => RecipeDefinition | null | undefined;
  readonly aiAppNameOf?: (contract_id: string) => string | undefined;
  readonly now?: () => number;
}

/** Who holds a caller's pre-approval, in the owner's words: "your chats", or the AI app by the name its
 *  key has. The pages, and a run's page in Logs, say it the same way. */
export const preapprovalCallerName = (
  caller: import('@recued/contracts').PreapprovalCaller,
  aiAppNameOf: ((contract_id: string) => string | undefined) | undefined,
): string => (caller.kind === 'owner_chat' ? 'your chats' : aiAppNameOf?.(caller.contract_id) ?? 'an AI app');

/** A row as the owner's pages list it: its recipe by name, who holds it in the owner's words, and
 *  whether it still covers anything. */
export const callerPreapprovalView = (
  row: CallerPreapprovalRow,
  deps: Pick<CallerPreapprovalRpcDeps, 'recipeOf' | 'aiAppNameOf'>,
): CallerPreapprovalView => {
  const recipe = deps.recipeOf?.(row.recipe_id) ?? null;
  const state = row.revoked_at !== undefined ? 'revoked'
    : recipe === null || triggerPreapprovalRecipeSha256(recipe) !== row.recipe_sha256 ? 'outdated' : 'live';
  return {
    ...row,
    state,
    recipe_name: recipe?.metadata.name ?? row.recipe_id,
    caller_name: preapprovalCallerName(row.caller, deps.aiAppNameOf),
  };
};

export const createCallerPreapprovalRpcHandlers = (deps: CallerPreapprovalRpcDeps) => ({
  /** Every standing pre-approval a caller holds, and a one-run one while its run lasts, newest first. */
  'collection.contract.listCallerPreapprovals': async (): Promise<{ preapprovals: CallerPreapprovalView[] }> => {
    const method = 'collection.contract.listCallerPreapprovals';
    if (deps.store === undefined) throw new RpcError('not_configured', `${method}: pre-approvals are not wired`, 501, method);
    return { preapprovals: deps.store.listCallers().filter((row) => row.run_id === undefined || row.revoked_at === undefined)
      .map((row) => callerPreapprovalView(row, deps)) };
  },
  /** End every standing permission one caller holds for one recipe, at once. Never asks: it only removes. */
  'collection.contract.stopAllowing': async (args: unknown): Promise<{ ended: StopAllowingResult }> => {
    const method = 'collection.contract.stopAllowing';
    const input = args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : undefined;
    const caller = readPreapprovalCaller(input?.caller);
    const recipe_id = typeof input?.recipe_id === 'string' && input.recipe_id.trim() !== '' ? input.recipe_id.trim() : undefined;
    if (caller === undefined || recipe_id === undefined) {
      throw new RpcError('bad_request', `${method}: caller (your chats, or an AI app by its contract) and recipe_id are required`, 400, method);
    }
    if (deps.stopDeps === undefined) throw new RpcError('not_configured', `${method}: pre-approvals are not wired`, 501, method);
    return { ended: stopAllowing(deps.stopDeps(), { caller, recipe_id, by: 'owner_app' }) };
  },
});
