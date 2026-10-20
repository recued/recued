import { createHash } from 'node:crypto';
import { canonicalJSONStringify, CONNECTION_NAME_REGEX, RpcError, type ConnectionRow } from '@recued/contracts';

/** Account identity excludes display names, health and routine use timestamps. */
export const connectionIdentity = (row: ConnectionRow | null | undefined, authSourceId?: string): unknown => row?.kind === 'api'
  ? { enrolled_at: row.enrolled_at, auth: authSourceId ?? row.auth_ciphertext, config: row.config_json,
    subtype: row.subtype ?? null, scope: row.subresource_path ?? null,
    granted_scopes: row.granted_scopes_json ?? null }
  : undefined;

/** Only this opaque digest leaves the host; credentials and configuration do not. */
export const connectionRevision = (identity: unknown): string | undefined => identity == null ? undefined
  : createHash('sha256').update(canonicalJSONStringify(['api-account-v1', identity])).digest('hex');

export const connectionRevisionGuard = (
  value: unknown,
  current: (name: string) => ConnectionRow | null | undefined,
  authSourceId?: (name: string) => string | undefined,
): (() => void) | undefined => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError('bad_request', 'connection_revisions must map connection names to account revisions.');
  }
  const revisions = Object.entries(value);
  if (revisions.some(([name, revision]) => !CONNECTION_NAME_REGEX.test(name)
    || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) {
    throw new RpcError('bad_request', 'connection_revisions contains an invalid account revision.');
  }
  return () => {
    for (const [name, revision] of revisions) {
      if (connectionRevision(connectionIdentity(current(name), authSourceId?.(name))) !== revision) {
        throw new RpcError('connection_changed', 'An account used by these page arguments changed. Reopen the page and review the arguments before running.', 409);
      }
    }
  };
};
