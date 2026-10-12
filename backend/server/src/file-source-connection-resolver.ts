/** D-192 file SOURCE family — the connection resolver the file-source adapter
 *  leaves read their credential + config through, WITH lazy OAuth2 refresh.
 *
 *  The file-source leaves (`file-source-adapters/{s3,dropbox}.ts`) never touch
 *  storage/crypto: they call `resolveConnection(name)` and read whatever it
 *  returns. In v1 that only DECRYPTED the stored auth — fine for S3 (static
 *  `basic` access-key/secret) but BROKEN for Dropbox: a freshly-enrolled
 *  `oauth2_refresh` connection carries a `refresh_token` but NO
 *  `current_access_token` (the OAuth dance only propagates the refresh token),
 *  and the Dropbox leaf reads the token via `resolveBearerAccessToken`, which
 *  for `oauth2_refresh` reads `current_access_token`. So the mirror never
 *  synced. Unlike the `connection` adapter (which refreshes + persists at call
 *  time), the file-source path bypasses that adapter entirely.
 *
 *  This resolver closes the gap by running the decrypted auth through the SAME
 *  `createEnsureFreshAuth` gate the `connection.api` / `connection.mcp` handlers
 *  use: it refreshes an `oauth2_refresh` token only when missing or within the
 *  lead window, single-flights concurrent refreshes per connection (`row.pk`),
 *  persists the rotated token best-effort (so the next cycle reads a fresh row),
 *  and passes a non-oauth2 auth (S3's `basic`) through UNTOUCHED — no fetch, no
 *  persist. The single-flight map lives on the gate, so the caller must build
 *  this resolver ONCE and reuse it (the compose site memoizes it).
 *
 *  Extracted from the compose closure so it is unit-testable; the compose site
 *  dynamic-imports `decode`/`encode` (keeping the connection-handler module out
 *  of the static boot graph) and injects them.
 *
 *  Spec: D-192; the refresh gate is
 *  `packages/ingredients/src/connection-api.ts` (`createEnsureFreshAuth`); the
 *  persist template is `composition/bin/wire-executor-config.ts`
 *  (`makeRefreshPersistAuth`) + `wire-vendor-substrate.ts`. */

import { RpcError } from '@recued/contracts';
import { createEnsureFreshAuth, type EnsureFreshAuthDeps } from '@recued/ingredients';

import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { FileConnectionCredential } from './file-source-adapters/index.js';
import type { ManagedOAuthService } from './managed-oauth-service.js';

/** The AEAD decode/encode primitives from `connection-handler.js`, injected
 *  (the compose site dynamic-imports them so the heavy module stays out of the
 *  static boot graph; tests pass fakes). Typed via `typeof import` in type
 *  position — erased at compile, so this adds no runtime import. */
type DecodeAuthFromStorage = (typeof import('./connection-handler.js'))['decodeAuthFromStorage'];
type EncodeAuthForStorage = (typeof import('./connection-handler.js'))['encodeAuthForStorage'];

export interface FileSourceConnectionResolverDeps {
  connectionStore: Pick<ConnectionStoreSqlite, 'get' | 'upsert' | 'persistRefreshedAuth'>;
  decodeAuthFromStorage: DecodeAuthFromStorage;
  encodeAuthForStorage: EncodeAuthForStorage;
  /** The connection sub-DEK key provider (absent on a non-vault boot). */
  keyProvider: Parameters<EncodeAuthForStorage>[2];
  fetchImpl?: typeof fetch;
  managedOAuth?: Pick<ManagedOAuthService, 'fetch'>;
  now?: () => number;
  /** Advisory signal when a refreshed credential could not be persisted. */
  onPersistFailure?: EnsureFreshAuthDeps['onPersistFailure'];
}

export type ResolvedFileSourceConnection = FileConnectionCredential;

/** Persist a refreshed OAuth2 auth back to the connection store, re-encoding via
 *  the same sub-DEK used at enrollment and PRESERVING the row's other fields
 *  (subresource_path / granted_scopes / health / config) — a refresh restamp
 *  must never null them (the `makeRefreshPersistAuth` invariant; dropping
 *  granted_scopes would false-negative pack-readiness). Best-effort by the
 *  gate's contract: a throw here is swallowed and the fresh token is still used
 *  for the current cycle. */
const buildPersistAuth = (
  deps: FileSourceConnectionResolverDeps,
  now: () => number,
): EnsureFreshAuthDeps['persistAuth'] =>
  async (row, newAuth) => {
    const auth_ciphertext = await deps.encodeAuthForStorage(
      newAuth,
      { kind: row.kind, name: row.name },
      deps.keyProvider,
    );
    if (deps.connectionStore.persistRefreshedAuth) {
      if (!deps.connectionStore.persistRefreshedAuth(row, auth_ciphertext, now())) {
        throw new Error('The connection changed during credential refresh.');
      }
      return;
    }
    deps.connectionStore.upsert({
      kind: row.kind,
      name: row.name,
      ...(row.subtype !== undefined ? { subtype: row.subtype } : {}),
      display_name: row.display_name,
      ...(row.publisher_id !== undefined ? { publisher_id: row.publisher_id } : {}),
      config_json: row.config_json,
      auth_ciphertext,
      enrolled_at: row.enrolled_at,
      updated_at: now(),
      ...(row.last_used_at !== undefined ? { last_used_at: row.last_used_at } : {}),
      ...(row.health_json !== undefined ? { health_json: row.health_json } : {}),
      ...(row.subresource_path !== undefined ? { subresource_path: row.subresource_path } : {}),
      ...(row.granted_scopes_json !== undefined
        ? { granted_scopes_json: row.granted_scopes_json }
        : {}),
    });
  };

/** Parse a connection row's `config_json` to a plain object. Malformed → `{}`
 *  (the leaf surfaces a `config` outcome — e.g. missing region/bucket — the
 *  scheduler records + retries). */
const parseConfig = (config_json: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(config_json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to empty
  }
  return {};
};

/** Build the file-source connection resolver. Build ONCE + reuse (the refresh
 *  single-flight map lives on the gate this closes over). */
export const createFileSourceConnectionResolver = (
  deps: FileSourceConnectionResolverDeps,
): ((connection_name: string) => Promise<ResolvedFileSourceConnection | null>) => {
  const now = deps.now ?? ((): number => Date.now());
  const ensureFreshAuth = createEnsureFreshAuth({
    persistAuth: buildPersistAuth(deps, now),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    now,
    ...(deps.onPersistFailure ? { onPersistFailure: deps.onPersistFailure } : {}),
  });
  return async (
    connection_name: string,
  ): Promise<ResolvedFileSourceConnection | null> => {
    const row = deps.connectionStore.get('api', connection_name);
    if (row === null) return null;
    const decoded = await deps.decodeAuthFromStorage(
      row.auth_ciphertext,
      { kind: row.kind, name: row.name },
      deps.keyProvider,
    );
    if (decoded.type === 'managed_oauth') {
      const broker = deps.managedOAuth;
      if (!broker) throw new RpcError('not_configured', 'Managed OAuth is unavailable for file access on this server.');
      const current = deps.connectionStore.get('api', connection_name);
      if (!current || current.auth_ciphertext !== row.auth_ciphertext || current.config_json !== row.config_json) {
        throw new RpcError('conflict', 'The file connection changed during credential resolution.');
      }
      return { auth: decoded, config: parseConfig(row.config_json), managedFetch: async (url, init) => {
        // Decrypt again on every use so locking the vault also seals an in-flight walk.
        const live = deps.connectionStore.get('api', connection_name);
        if (!live || live.auth_ciphertext !== row.auth_ciphertext || live.config_json !== row.config_json) {
          throw new RpcError('conflict', 'The file connection changed. Start a fresh read or sync.');
        }
        const auth = await deps.decodeAuthFromStorage(live.auth_ciphertext,
          { kind: live.kind, name: live.name }, deps.keyProvider);
        const afterDecode = deps.connectionStore.get('api', connection_name);
        if (!afterDecode || afterDecode.auth_ciphertext !== live.auth_ciphertext || afterDecode.config_json !== live.config_json
          || auth.type !== 'managed_oauth') throw new RpcError('conflict', 'The file connection changed.');
        const target = new URL(url);
        // Dropbox's authored file API splits listing and downloads across these
        // two fixed hosts. This exception is private to file access; generic API
        // requests retain the single-origin binding. No arbitrary host override.
        const dropboxContent = auth.target_origin === 'https://api.dropboxapi.com'
          && target.origin === 'https://content.dropboxapi.com';
        if ((target.origin !== auth.target_origin && !dropboxContent) || target.username || target.password || target.hash) {
          throw new RpcError('bad_request', 'The managed file request targets a different vendor.');
        }
        const { body, ...rest } = init;
        return broker.fetch(dropboxContent ? { ...auth, target_origin: target.origin } : auth, url,
          { ...rest, ...(body !== undefined ? { body: body as BodyInit } : {}) });
      } };
    }
    // Lazy refresh: an `oauth2_refresh` token that is missing or near expiry is
    // refreshed + persisted; S3's `basic` auth passes through untouched.
    const auth = await ensureFreshAuth(row, decoded);
    return { auth, config: parseConfig(row.config_json) };
  };
};
