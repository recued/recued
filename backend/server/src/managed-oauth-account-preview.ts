/** D-322 §25 — fixed identity GETs; no scope request, token refresh or raw payload projection. */
import type { ConnectionAuth, ManagedOAuthAccountIdentity } from '@recued/contracts';
import { injectConnectionApiAuth } from '@recued/ingredients';

const unknown = (reason: ManagedOAuthAccountIdentity['reason']): ManagedOAuthAccountIdentity => ({ status: 'unknown', reason });
const text = (v: unknown): string | undefined => typeof v === 'string' && v.trim() && v.length <= 200 && !/[\r\n\0]/.test(v) ? v.trim() : undefined;
const email = (v: unknown): string | undefined => typeof v === 'string' && v.length <= 254 && !/[\r\n\0]/.test(v)
  && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : undefined;
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

const endpoint = (raw: string): { url: URL; kind: 'gmail' | 'graph' | 'drive' } | undefined => {
  try {
    const base = new URL(raw);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return;
    const path = base.pathname.replace(/\/$/, '');
    if (base.origin === 'https://gmail.googleapis.com' && path === '/gmail/v1') {
      return { url: new URL('/gmail/v1/users/me/profile?fields=emailAddress', base), kind: 'gmail' };
    }
    if (base.origin === 'https://graph.microsoft.com' && ['/v1.0', '/beta'].includes(path)) {
      return { url: new URL(path + '/me?$select=id,mail,userPrincipalName,displayName', base), kind: 'graph' };
    }
    if (base.origin === 'https://www.googleapis.com' && path === '/drive/v3') {
      return { url: new URL('/drive/v3/about?fields=user(emailAddress,displayName,permissionId)', base), kind: 'drive' };
    }
  } catch { /* Unknown or malformed services never select a generic identity endpoint. */ }
};

const boundedJson = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  if (Number(response.headers.get('Content-Length')) > 8192 || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Identity unavailable');
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (let count = 0; count < 64; count++) {
      const part = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const abort = (): void => reject(new Error('Identity unavailable'));
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        void reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
      if (part.done) {
        const buffer = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
        return JSON.parse(new TextDecoder().decode(buffer));
      }
      bytes += part.value.byteLength;
      if (bytes > 8192) throw new Error('Identity unavailable');
      chunks.push(part.value);
    }
    throw new Error('Identity unavailable');
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
};

const identityResponse = (read: () => Promise<Response>, signal: AbortSignal): Promise<Response> => new Promise((resolve, reject) => {
  const abort = (): void => reject(new Error('Identity unavailable'));
  if (signal.aborted) { abort(); return; }
  signal.addEventListener('abort', abort, { once: true });
  void Promise.resolve().then(read).then(response => {
    // A transport may ignore cancellation. Discard its late body without reading it.
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); return; }
    resolve(response);
  }, reject).finally(() => signal.removeEventListener('abort', abort));
});

const project = (raw: unknown, kind: 'gmail' | 'graph' | 'drive'): ManagedOAuthAccountIdentity => {
  const root = record(raw); const user = kind === 'drive' ? record(root.user) : root;
  const address = email(kind === 'graph' ? user.mail : user.emailAddress);
  const id = kind === 'gmail' ? address : text(kind === 'drive' ? user.permissionId : user.id);
  if (!id) return unknown('unavailable');
  const name = text(user.displayName); const username = kind === 'graph' ? text(user.userPrincipalName) : undefined;
  return { status: 'known', account_id: id, ...(address ? { email: address } : {}),
    ...(name ? { display_name: name } : {}), ...(username ? { user_name: username } : {}) };
};

export const readManagedOAuthAccountIdentity = async (args: {
  auth?: ConnectionAuth; base_url: string; now: number;
  fetch: typeof fetch;
  managedFetch(auth: import('@recued/contracts').ManagedOAuthAuth, url: string, init: RequestInit): Promise<Response>;
}): Promise<ManagedOAuthAccountIdentity> => {
  if (!args.auth) return unknown('not_authorized');
  const selected = endpoint(args.base_url);
  if (!selected) return unknown('unsupported');
  const auth = args.auth;
  if (!['managed_oauth', 'bearer', 'oauth2_refresh'].includes(auth.type)
    || auth.type === 'oauth2_refresh' && (!auth.current_access_token || auth.expires_at !== undefined && auth.expires_at <= args.now)) return unknown('unavailable');
  const headers = new Headers({ Accept: 'application/json' }); const url = selected.url;
  try {
    injectConnectionApiAuth(auth, headers, url, { method: 'GET', nowMs: args.now });
    const init = { method: 'GET', headers, redirect: 'error' as const, credentials: 'omit' as const, signal: AbortSignal.timeout(5000) };
    const response = await identityResponse(() => auth.type === 'managed_oauth'
      ? args.managedFetch(auth, url.toString(), init) : args.fetch(url, init), init.signal);
    if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); return unknown('unavailable'); }
    return project(await boundedJson(response, init.signal), selected.kind);
  } catch { return unknown('unavailable'); }
};
