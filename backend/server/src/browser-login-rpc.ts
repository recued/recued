/** D-335 slice Z — the owner's rpc over the logins remembered for browser steps: list them (the
 *  site, the field, the kind of secret, never the secret) and forget one. Registered in the
 *  `collection.contract.` slice, which MCP never reaches: an AI never sees or forgets a login.
 *  A forgotten login is audited `browser_login_forgotten`, best-effort. */

import { RpcError, type BrowserLoginRow } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import type { BrowserLoginStore } from './storage/browser-login-store.js';

export interface BrowserLoginRpcDeps {
  readonly store?: BrowserLoginStore;
  readonly auditLog?: AuditLogStore;
  readonly now?: () => number;
  /** D-402 slice H5 — a browser's name as its owner gave it, for the list. */
  readonly browserNameOf?: (browser_id: string) => string | undefined;
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

export const createBrowserLoginRpcHandlers = (deps: BrowserLoginRpcDeps) => {
  const now = deps.now ?? Date.now;
  const store = (method: string): BrowserLoginStore => {
    if (deps.store === undefined) throw new RpcError('not_configured', `${method}: remembered logins are not wired`, 501);
    return deps.store;
  };
  return {
    'collection.contract.listBrowserLogins': async (): Promise<{ logins: BrowserLoginRow[] }> =>
      ({ logins: store('collection.contract.listBrowserLogins').list().map((login) => {
        // D-402 slice H5 — each by the browser it was saved in, named as its owner named it.
        const name = deps.browserNameOf?.(login.browser);
        return name !== undefined ? { ...login, browser_name: name } : login;
      }) }),

    'collection.contract.forgetBrowserLogin': async (args: unknown): Promise<{ forgotten: true }> => {
      const method = 'collection.contract.forgetBrowserLogin';
      const browser = text(method, 'browser', args);
      const origin = text(method, 'origin', args);
      const field = text(method, 'field', args);
      if (!store(method).forget(browser, origin, field)) {
        throw new RpcError('not_found', `${method}: no login is remembered for that field on ${origin}`, 404, method);
      }
      if (deps.auditLog !== undefined) {
        void deps.auditLog.logActivity({ activity_id: '', timestamp: now(), action: 'browser_login_forgotten', target: origin,
          detail: JSON.stringify({ field, browser }) }).catch(() => undefined);
      }
      return { forgotten: true };
    },
  };
};
