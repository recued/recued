/** D-335 slice F — the owner's rpc over the passes for Browser Toolkit writes: list the live
 *  passes, end one, list the open suggestions to always allow a key, accept one (mint its
 *  pass), dismiss one for good. Registered in the `collection.contract.` slice, which MCP
 *  never reaches: an AI never sees, mints or ends a pass.
 *
 *  Every decision is audited reserve-class (`browser_pass_minted` / `_dismissed` /
 *  `_revoked`), best-effort: the decision is the store's, the audit row its record. */

import {
  RpcError, type BrowserPassBrowser, type BrowserPassKey, type BrowserPassRow, type BrowserPassSuggestionRow, type BrowserRequestPass,
} from '@recued/contracts';
import type { ActivityAction, AuditLogStore } from '@recued/storage';

import type { BridgeDispatcher } from './bridges/dispatcher.js';
import { BrowserPassError, type BrowserPassStore } from './storage/browser-pass-store.js';

export interface BrowserPassRpcDeps {
  readonly store?: BrowserPassStore;
  readonly auditLog?: AuditLogStore;
  readonly now?: () => number;
  /** D-402 slice H4d — the browser a key names, as the owner knows it (`browserPassBrowserFrom`). */
  readonly browserOf?: (browser_id: string) => BrowserPassBrowser;
}

/** D-402 slice H4d — a browser as the passes list names it, from routing: the owner's name while it is
 *  paired, else the name it last went by and that it is no longer paired. With no roster to read, whether
 *  it is paired is not said. Read at each call: the composition root holds the dispatcher by reference. */
export const browserPassBrowserFrom = (dispatcher: () => Pick<BridgeDispatcher, 'listBrowsers' | 'browserName'> | undefined) =>
  (browser_id: string): BrowserPassBrowser => {
    const routing = dispatcher();
    const browsers = routing?.listBrowsers?.();
    const paired = browsers?.find((browser) => browser.browser_id === browser_id);
    if (paired !== undefined) return { name: paired.name, paired: true };
    const name = routing?.browserName?.(browser_id);
    return { ...(name !== undefined ? { name } : {}), ...(browsers !== undefined ? { paired: false } : {}) };
  };

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
  /** D-402 slice H4d — a row whose key names its browser, with that browser as the owner knows it. */
  const named = <T extends { readonly key: BrowserPassKey }>(row: T): T => {
    if (row.key.browser === undefined || deps.browserOf === undefined) return row;
    const browser = deps.browserOf(row.key.browser);
    return { ...row, ...(browser.name !== undefined ? { browser_name: browser.name } : {}),
      ...(browser.paired !== undefined ? { browser_paired: browser.paired } : {}) };
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
    // D-341 slice A — the switch beside Send: whether this conversation's browser actions run
    // without asking, and turning that on (for eight hours at most) or off. The owner's chat only:
    // the conversation is named by its chat session, as a chat run's identity names it.
    'collection.contract.getRequestPass': async (args: unknown): Promise<{ pass?: BrowserRequestPass }> => {
      const method = 'collection.contract.getRequestPass';
      const pass = store(method).requestPass(`chat:${text(method, 'session_id', args)}`, now());
      return pass !== undefined ? { pass } : {};
    },

    'collection.contract.setRequestPass': async (args: unknown): Promise<{ pass?: BrowserRequestPass }> => {
      const method = 'collection.contract.setRequestPass';
      const key = `chat:${text(method, 'session_id', args)}`;
      const allow = (args as { allow?: unknown }).allow;
      if (typeof allow !== 'boolean') throw new RpcError('bad_request', `${method}: allow is true or false`);
      const at = now();
      if (allow) {
        const pass = store(method).startRequestPass(key, at);
        if (pass.started_at === at) audit('browser_request_pass_started', key, { expires_at: pass.expires_at }, at);
        return { pass };
      }
      if (store(method).endRequestPass(key, at)) audit('browser_request_pass_ended', key, {}, at);
      return {};
    },

    'collection.contract.listBrowserPasses': async (): Promise<{ passes: BrowserPassRow[] }> =>
      ({ passes: store('collection.contract.listBrowserPasses').listPasses(now()).map(named) }),

    'collection.contract.revokeBrowserPass': async (args: unknown): Promise<{ pass: BrowserPassRow }> => {
      const method = 'collection.contract.revokeBrowserPass';
      const pass_id = text(method, 'pass_id', args);
      const at = now();
      const pass = decided(method, () => store(method).revoke(pass_id, at));
      audit('browser_pass_revoked', pass_id, {
        key_hash: pass.key_hash, recipe: pass.key.recipe, site: pass.key.site, kind: pass.kind, uses: pass.uses,
      }, at);
      return { pass: named(pass) };
    },

    'collection.contract.listBrowserPassSuggestions': async (): Promise<{ suggestions: BrowserPassSuggestionRow[] }> =>
      ({ suggestions: store('collection.contract.listBrowserPassSuggestions').listSuggestions(now()).map(named) }),

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
      return { pass: named(result.pass), suggestion: named(result.suggestion) };
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
