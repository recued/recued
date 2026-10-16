/** Shared native grant renewal: preserve each member's local needs and concurrent owner edits. */
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
type Codec = typeof import('./connection-handler.js');
/** A queued renewal must reread its row before sending a rotating token. */
export const withCurrentConnectionRenewal = <T>(store: Pick<ConnectionStoreSqlite, 'get' | 'withCredentialLease'>,
  row: ConnectionRow, run: () => Promise<T>): Promise<T> => {
  const current = async () => {
    const latest = store.get(row.kind, row.name);
    if (!latest || latest.pk !== row.pk || latest.enrolled_at !== row.enrolled_at
      || latest.auth_ciphertext !== row.auth_ciphertext || latest.config_json !== row.config_json) {
      throw new Error('The connection changed before credential renewal.');
    }
    return run();
  };
  return store.withCredentialLease ? store.withCredentialLease([row.name], current) : current();
};
/** Exact automatic changes; owner metadata is never accepted as a renewal. */
export interface NativeOAuthRenewal { previous: ConnectionRow; current: ConnectionRow }
export const persistNativeOAuthRenewal = async (deps: {
  store: Pick<ConnectionStoreSqlite, 'get' | 'persistRefreshedAuth'> & Partial<Pick<ConnectionStoreSqlite, 'list'>>;
  encode: Codec['encodeAuthForStorage']; decode: Codec['decodeAuthFromStorage'];
  key?: Parameters<Codec['encodeAuthForStorage']>[2]; now(): number;
  onRenewal?(changes: readonly NativeOAuthRenewal[]): void;
}, previous: ConnectionRow, next: ConnectionAuth, configPatch?: { base_url: string }): Promise<void> => {
  const old = await deps.decode(previous.auth_ciphertext, previous, deps.key);
  if (old.type !== 'oauth2_refresh' || next.type !== 'oauth2_refresh' || !next.native_credential_id) {
    const ciphertext = await deps.encode(next, previous, deps.key);
    if (!deps.store.persistRefreshedAuth?.(previous, ciphertext, Math.max(deps.now(), previous.updated_at + 1), configPatch)) {
      throw new Error('The connection changed during credential renewal.');
    }
    return;
  }
  const members: { row: ConnectionRow; auth: Extract<ConnectionAuth, { type: 'oauth2_refresh' }> }[] = [];
  if (!deps.store.list) throw new Error('Shared native renewal requires the connection list.');
  members.push({ row: previous, auth: old });
  for (const row of deps.store.list({ kind: 'api' })) {
    if (row.pk === previous.pk) continue;
    let auth: ConnectionAuth;
    try { auth = await deps.decode(row.auth_ciphertext, row, deps.key); } catch { continue; }
    if (auth.type !== 'oauth2_refresh') continue;
    if (auth.native_credential_id === next.native_credential_id
      && auth.client_id === old.client_id && auth.client_secret === old.client_secret
      && auth.token_endpoint === old.token_endpoint && auth.token_auth_style === old.token_auth_style) members.push({ row, auth });
  }
  // Encode every member before the synchronous CAS writes: an owner edit during
  // encryption is preserved, and no await can split a successful group renewal.
  // App provenance belongs to the local copy, just like its required scopes.
  // Joining a grant's renewal cannot confirm or reassign another copy's origin.
  const updates = await Promise.all(members.map(async member => ({ ...member,
    ciphertext: await deps.encode({ ...next, saved_oauth_app: member.auth.saved_oauth_app, required_scopes: member.row.pk === previous.pk
      ? next.required_scopes : member.auth.required_scopes }, member.row, deps.key) })));
  const changes: NativeOAuthRenewal[] = [];
  const persist = (update: typeof updates[number], patch?: { base_url: string }): boolean => {
    const latest = deps.store.get(update.row.kind, update.row.name);
    if (!latest || latest.pk !== update.row.pk || latest.enrolled_at !== update.row.enrolled_at
      || latest.auth_ciphertext !== update.row.auth_ciphertext) return false;
    // A configuration edit keeps the same grant. Persist its rotated token
    // against the latest row and preserve that edit, including a new API URL.
    const effectivePatch = latest.config_json === update.row.config_json ? patch : undefined;
    const updated_at = Math.max(deps.now(), latest.updated_at + 1);
    const saved = deps.store.persistRefreshedAuth!(latest, update.ciphertext, updated_at, effectivePatch);
    if (saved) changes.push({ previous: update.row, current: { ...update.row, auth_ciphertext: update.ciphertext, updated_at,
      ...(effectivePatch ? { config_json: JSON.stringify({ ...JSON.parse(update.row.config_json), base_url: effectivePatch.base_url }) } : {}) } });
    return saved;
  };
  const initiatingRowRenewed = persist((updates.find(u => u.row.pk === previous.pk))!, configPatch);
  for (const update of updates) {
    if (update.row.pk === previous.pk) continue;
    persist(update, configPatch && update.row.config_json === previous.config_json ? configPatch : undefined);
  }
  deps.onRenewal?.(changes);
  // A replaced initiating row no longer owns this grant, but its surviving
  // members still need the successful rotation before the conflict is reported.
  if (!initiatingRowRenewed) throw new Error('The native credential changed during renewal.');
};

/** Only an automatic renewal keeps this server-generated family identity. */
export const decodeCurrentNativeOAuth = async (deps: {
  store: Pick<ConnectionStoreSqlite, 'get'> & Partial<Pick<ConnectionStoreSqlite, 'permissionCleanupId'>>;
  decode: Codec['decodeAuthFromStorage']; key?: Parameters<Codec['decodeAuthFromStorage']>[2];
}, snapshot: ConnectionRow): Promise<ConnectionAuth> => {
  const assertNotPaused = () => {
    if (snapshot.kind === 'api' && deps.store.permissionCleanupId?.(snapshot.name)) {
      throw new Error('Finish the saved permission cleanup before using this connection.');
    }
  };
  const original = await deps.decode(snapshot.auth_ciphertext, { kind: snapshot.kind, name: snapshot.name }, deps.key);
  // An execution can hold an older row without a native family ID. Its
  // cached token must still obey the current durable cleanup pause.
  assertNotPaused();
  if (original.type !== 'oauth2_refresh') return original;
  const current = deps.store.get(snapshot.kind, snapshot.name);
  if (!current || current.pk !== snapshot.pk || current.enrolled_at !== snapshot.enrolled_at || current.config_json !== snapshot.config_json) {
    throw new Error('The connection changed before native authentication could be used.');
  }
  if (!original.native_credential_id) {
    // Without a server-issued family identity, a different ciphertext is not
    // authority to reuse either the old or replacement token. Resolve again.
    if (current.auth_ciphertext !== snapshot.auth_ciphertext) {
      throw new Error('The connection changed before authentication could be used.');
    }
    return original;
  }
  const auth = await deps.decode(current.auth_ciphertext, { kind: current.kind, name: current.name }, deps.key);
  assertNotPaused();
  if (auth.type !== 'oauth2_refresh' || auth.native_credential_id !== original.native_credential_id) {
    throw new Error('The native account changed before authentication could be used.');
  }
  return auth;
};
