/** D-335 slice F — the owner's rpc over the passes for Browser Toolkit writes: list the live
 *  passes, end one, list the open suggestions to always allow a key, accept one (mint its
 *  pass), dismiss one for good. Registered in the `collection.contract.` slice, which MCP
 *  never reaches: an AI never sees, mints or ends a pass.
 *
 *  Every decision is audited reserve-class (`browser_pass_minted` / `_dismissed` /
 *  `_revoked`), best-effort: the decision is the store's, the audit row its record. */

import { RpcError, type BrowserPassRow, type BrowserPassSuggestionRow } from '@recued/contracts';
import type { ActivityAction, AuditLogStore } from '@recued/storage';

import { BrowserPassError, type BrowserPassStore } from './storage/browser-pass-store.js';

export interface BrowserPassRpcDeps {
  readonly store?: BrowserPassStore;
  readonly auditLog?: AuditLogStore;
  readonly now?: () => number;
}

const text = (method: string, field: string, args: unknown): string => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new RpcError('bad_request', `${method}: args must be an object`);
  }
  const value = (args as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError('bad_request', `${method}: ${field} is required`);
  }
  return value;
};

export const createBrowserPassRpcHandlers = (deps: BrowserPassRpcDeps) => {
  const now = deps.now ?? Date.now;
  const store = (method: string): BrowserPassStore => {
    if (deps.store === undefined) throw new RpcError('not_configured', `${method}: browser passes are not wired`, 501);
    return deps.store;
  };
  const decided = <T>(method: string, run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (error instanceof BrowserPassError) {
        throw new RpcError(error.code, `${method}: ${error.message}`, error.code === 'not_found' ? 404 : 400, method);
      }
      throw error;
    }
  };
  const audit = (action: ActivityAction, target: string, detail: Record<string, unknown>, at: number): void => {
    if (deps.auditLog === undefined) return;
    void deps.auditLog.logActivity({
      activity_id: '', timestamp: at, action, target, detail: JSON.stringify(detail),
    }).catch(() => undefined);
  };

  return {
    'collection.contract.listBrowserPasses': async (): Promise<{ passes: BrowserPassRow[] }> =>
      ({ passes: store('collection.contract.listBrowserPasses').listPasses(now()) }),

    'collection.contract.revokeBrowserPass': async (args: unknown): Promise<{ pass: BrowserPassRow }> => {
      const method = 'collection.contract.revokeBrowserPass';
      const pass_id = text(method, 'pass_id', args);
      const at = now();
      const pass = decided(method, () => store(method).revoke(pass_id, at));
      audit('browser_pass_revoked', pass_id, {
        key_hash: pass.key_hash, recipe: pass.key.recipe, site: pass.key.site, kind: pass.kind, uses: pass.uses,
      }, at);
      return { pass };
    },

    'collection.contract.listBrowserPassSuggestions': async (): Promise<{ suggestions: BrowserPassSuggestionRow[] }> =>
      ({ suggestions: store('collection.contract.listBrowserPassSuggestions').listSuggestions(now()) }),

    'collection.contract.acceptBrowserPassSuggestion': async (
      args: unknown,
    ): Promise<{ pass: BrowserPassRow; suggestion: BrowserPassSuggestionRow }> => {
      const method = 'collection.contract.acceptBrowserPassSuggestion';
      const key_hash = text(method, 'key_hash', args);
      const at = now();
      const result = decided(method, () => store(method).accept(key_hash, at));
      audit('browser_pass_minted', result.pass.pass_id, {
        key_hash, recipe: result.pass.key.recipe, site: result.pass.key.site,
        principal: result.pass.key.principal.kind, kind: result.pass.kind, from: 'suggestion',
      }, at);
      return result;
    },

    'collection.contract.dismissBrowserPassSuggestion': async (args: unknown): Promise<{ key_hash: string }> => {
      const method = 'collection.contract.dismissBrowserPassSuggestion';
      const key_hash = text(method, 'key_hash', args);
      const at = now();
      decided(method, () => store(method).dismiss(key_hash, at));
      audit('browser_pass_dismissed', key_hash, {}, at);
      return { key_hash };
    },
  };
};
