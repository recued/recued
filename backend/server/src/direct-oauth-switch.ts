/** D-322 §27 — encrypted native candidates and transferable, reviewed bulk authority. */
import { createHash, randomBytes } from 'node:crypto';
import { RpcError, getVendorProvider, managedOAuthScopeUnion, MANAGED_OAUTH_MIGRATION_LIMIT,
  type ConnectionRow, type DirectOAuthAuth, type DirectOAuthAuthorization, type DirectOAuthAuthenticationReview,
  type ManagedOAuthImpactPreview, type ManagedOAuthMigrationCandidate } from '@recued/contracts';
import { refreshOAuth2WithMetadata } from '@recued/ingredients';
import { oauthScopesCover } from './managed-oauth-service.js';
import type { NativeOAuthRenewal } from './native-oauth-renewal.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowHash = (r: ConnectionRow): string => hash([r.pk, r.updated_at, r.enrolled_at, r.auth_ciphertext, r.config_json,
  r.display_name, r.subtype, r.subresource_path, r.granted_scopes_json]);
const nonce = (): string => randomBytes(32).toString('base64url');
const refused = (): RpcError => new RpcError('conflict', 'The direct OAuth review changed, expired, or was retired. Review it again. Saved authentication was kept.');
interface Flow {
  id: string; expires: number; ciphertext: string; label: string; base: string; vendor?: string;
  names: string[]; expected: Map<string, string>; signature: string; requested: string[]; granted?: readonly string[];
  required: Map<string, readonly string[]>;
  target: string; source?: string; claimed: boolean; retired: boolean; busy: boolean;
  renewals: NativeOAuthRenewal[];
}
interface Issued { flow: Flow; name: string; impact: ManagedOAuthImpactPreview; consumed: boolean }
export interface DirectOAuthMigrationAuthority {
  names: readonly string[]; signature: string; expires_at: number;
  issue(name: string): Promise<{ auth: DirectOAuthAuthorization; impact: ManagedOAuthImpactPreview; retire(): void }>;
  renewals(): readonly NativeOAuthRenewal[];
  close(): void;
}
export const createDirectOAuthSwitch = (deps: {
  withSourceLease?<T>(row: ConnectionRow, run: () => Promise<T>): Promise<T>;
  rows(): ConnectionRow[]; decode(row: ConnectionRow): Promise<DirectOAuthAuth | import('@recued/contracts').ConnectionAuth>;
  encode(auth: DirectOAuthAuth, name: string): Promise<string>; decrypt(ciphertext: string, name: string): Promise<DirectOAuthAuth>;
  persistRefresh(row: ConnectionRow, auth: DirectOAuthAuth): Promise<readonly NativeOAuthRenewal[]>;
  candidates(names: readonly string[]): Promise<readonly ManagedOAuthMigrationCandidate[]>;
  signature(names: readonly string[]): string;
  impact(name: string, auth: DirectOAuthAuth, members: readonly string[]): Promise<ManagedOAuthImpactPreview>;
  fetch: typeof fetch; now(): number;
}) => {
  const flows = new Map<string, Flow>(); const issued = new Map<string, Issued>(); let reviews = 0;
  const row = (name: string): ConnectionRow => {
    const found = deps.rows().find(r => r.kind === 'api' && r.name === name); if (!found) throw refused(); return found;
  };
  const assertCurrent = (flow: Flow): void => {
    if (flow.retired || flow.expires <= deps.now() || flow.signature !== deps.signature([...flow.expected.keys()])) throw refused();
    for (const [name, expected] of flow.expected) if (rowHash(row(name)) !== expected) throw refused();
  };
  const prune = (): void => {
    for (const [id, flow] of flows) if (flow.retired || flow.expires <= deps.now()) { flow.retired = true; flows.delete(id); }
    for (const [id, receipt] of issued) if (receipt.flow.expires <= deps.now()) issued.delete(id);
  };
  const refresh = async (auth: DirectOAuthAuth, base: string, vendor?: string) => {
    try {
      const result = await refreshOAuth2WithMetadata(auth, deps.fetch, deps.now, vendor ? getVendorProvider(vendor) : undefined);
      if (result.auth.type !== 'oauth2_refresh') throw refused();
      const compatible = result.runtime_base.status !== 'invalid' && result.runtime_base.status !== 'missing'
        && (result.runtime_base.status !== 'valid' || new URL(result.runtime_base.base_url).origin === new URL(base).origin);
      return { auth: result.auth, granted: result.granted_scopes, compatible };
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError('credential_verification_failed', 'The native OAuth app could not renew its credentials. Review the app and authorize again. Saved authentication was kept.',
        422, 'collection.connection.managedOAuth', { reason: 'direct_oauth_refresh_failed', existing_credential_preserved: true });
    }
  };
  const assertRuntimeBase = (compatible: boolean): void => {
    if (!compatible) throw new RpcError('conflict', 'This OAuth account uses a different vendor API address. The saved API address must stay in place.');
  };
  const fresh = async (flow: Flow): Promise<DirectOAuthAuth> => {
    const sourceRow = flow.source ? row(flow.source) : undefined;
    const renew = async () => {
    assertCurrent(flow);
    let auth = await deps.decrypt(flow.ciphertext, flow.label);
    if (auth.current_access_token && (auth.expires_at === undefined || auth.expires_at > deps.now() + 30_000)) return auth;
    const source = flow.source ? row(flow.source) : undefined;
    const result = await refresh(auth, flow.base, flow.vendor); assertCurrent(flow);
    auth = result.auth;
    if (source) {
      const changes = await deps.persistRefresh(source, auth);
      for (const change of changes) {
        if (flow.expected.get(change.previous.name) === rowHash(change.previous)) {
          flow.expected.set(change.previous.name, rowHash(change.current));
        }
      }
      flow.renewals.push(...changes);
    }
    assertRuntimeBase(result.compatible);
    if (result.granted !== undefined && !oauthScopesCover(flow.base, result.granted, flow.requested)) {
      throw new RpcError('credential_verification_failed', 'The renewed native OAuth grant no longer covers the reviewed scopes. Authorize again.',
        422, 'collection.connection.managedOAuth', { reason: 'direct_oauth_missing_scopes', existing_credential_preserved: true });
    }
    flow.ciphertext = await deps.encode(auth, flow.label);
    // A missing scope response means unknown, rather than carrying stale grants.
    flow.granted = result.granted;
    assertCurrent(flow); return auth;
    };
    return sourceRow && deps.withSourceLease ? deps.withSourceLease(sourceRow, renew) : renew();
  };
  const checkedImpact = async (flow: Flow, name: string, pinned?: DirectOAuthAuth): Promise<ManagedOAuthImpactPreview> => {
    if (flow.busy) throw new RpcError('conflict', 'This direct OAuth account is already being checked.');
    flow.busy = true;
    try {
      assertCurrent(flow);
      const auth = pinned ?? await fresh(flow); const impact = await deps.impact(name, auth, [...flow.expected.keys()].filter(n => n !== name));
      assertCurrent(flow);
      if (hash(impact.target) !== flow.target) throw new RpcError('conflict', 'The native OAuth account changed after review. Review it again.');
      return impact;
    } finally { flow.busy = false; }
  };
  const reference = (flow: Flow, id: string): DirectOAuthAuthorization => ({ type: 'direct_oauth', authorization_receipt: id,
    requested_scopes: [...flow.requested] });
  const issue = async (flow: Flow, name: string) => {
    const impact = await checkedImpact(flow, name); const id = nonce(); const receipt = { flow, name, impact, consumed: false };
    issued.set(id, receipt);
    return { auth: reference(flow, id), impact, retire: () => { issued.delete(id); } };
  };
  const review = async (input: { selections: readonly { name: string; expected_updated_at: number }[];
    auth?: DirectOAuthAuth; source_name?: string; scopes?: readonly string[] }): Promise<DirectOAuthAuthenticationReview> => {
    prune();
    if (!Array.isArray(input.selections) || !input.selections.length || input.selections.length > MANAGED_OAUTH_MIGRATION_LIMIT
      || input.selections.some(s => !s || typeof s.name !== 'string' || !Number.isSafeInteger(s.expected_updated_at))
      || new Set(input.selections.map(s => s.name)).size !== input.selections.length
      || (input.auth === undefined) === (input.source_name === undefined)
      || input.scopes !== undefined && (!Array.isArray(input.scopes) || input.scopes.length > 256
        || input.scopes.some(s => typeof s !== 'string' || s.length > 2048 || /[\r\n\0]/.test(s)))) {
      throw new RpcError('bad_request', 'Choose a native OAuth app or a separate saved direct OAuth connection, and up to 20 current connections.');
    }
    if (flows.size + reviews >= 16 || issued.size + reviews >= 512) throw new RpcError('conflict', 'Too many direct OAuth reviews are pending. Cancel an old review or let it expire.');
    reviews++;
    let created: Flow | undefined;
    try {
      const selected = input.selections.map(s => { const r = row(s.name); if (r.updated_at !== s.expected_updated_at) throw refused(); return r; });
      const candidates = await deps.candidates(selected.map(r => r.name));
      if (candidates.length !== selected.length) throw refused();
      const first = candidates[0]!;
      if (candidates.some(c => c.base_url !== first.base_url || c.vendor !== first.vendor)) throw new RpcError('bad_request', 'Migrate one vendor API service at a time.');
      const source = input.source_name !== undefined ? row(input.source_name) : undefined;
      if (source && selected.some(r => r.name === source.name)) throw new RpcError('bad_request', 'The direct OAuth source must be separate from the connections being migrated.');
      if (source) {
        const config = JSON.parse(source.config_json) as { base_url?: string; vendor?: string };
        if (config.base_url?.replace(/\/+$/, '') !== first.base_url.replace(/\/+$/, '') || config.vendor !== first.vendor) {
          throw new RpcError('bad_request', 'Select a direct OAuth connection for the same vendor API service.');
        }
      }
      let required = managedOAuthScopeUnion(...candidates.map(c => c.required_scopes), input.scopes ?? []);
      if (managedOAuthScopeUnion(required, input.scopes ?? []).length > 256) throw new RpcError('bad_request', 'The combined scope list is too large.');
      const native = input.auth ?? (source ? await deps.decode(source) : undefined);
      if (native?.type !== 'oauth2_refresh') throw new RpcError('bad_request', 'The selected connection must use Recued direct OAuth.');
      required = managedOAuthScopeUnion(required, source ? native.required_scopes ?? [] : []);
      if (required.length > 256) throw new RpcError('bad_request', 'The combined scope list is too large.');
      const names = [...selected.map(r => r.name), ...(source ? [source.name] : [])];
      const expected = new Map([...selected, ...(source ? [source] : [])].map(r => [r.name, rowHash(r)]));
      const signature = deps.signature(names);
      // Always renew, rather than accepting an owner-supplied cached access token.
      const renewSource = async () => {
      if (signature !== deps.signature(names) || [...expected].some(([n, h]) => rowHash(row(n)) !== h)) throw refused();
      const result = await refresh(native, first.base_url, first.vendor);
      if (signature !== deps.signature(names) || [...expected].some(([n, h]) => rowHash(row(n)) !== h)) throw refused();
      // Renewal can rotate the source token even when its grant cannot serve this migration.
      if (source) {
        result.auth = { ...result.auth, native_credential_id: native.native_credential_id ?? nonce(),
          required_scopes: managedOAuthScopeUnion(native.required_scopes ?? [], required) };
        const changes = await deps.persistRefresh(source, result.auth);
        for (const change of changes) if (expected.get(change.previous.name) === rowHash(change.previous)) {
          expected.set(change.previous.name, rowHash(change.current));
        }
      }
      return result;
      };
      const result = source && deps.withSourceLease ? await deps.withSourceLease(source, renewSource) : await renewSource();
      assertRuntimeBase(result.compatible);
      if (result.granted !== undefined && !oauthScopesCover(first.base_url, result.granted, required)) {
        throw new RpcError('credential_verification_failed', 'The native OAuth app did not grant the permissions these connections need. Authorize with their combined scopes.',
          422, 'collection.connection.managedOAuth', { reason: 'direct_oauth_missing_scopes', existing_credential_preserved: true });
      }
      const flow: Flow = { id: nonce(), expires: deps.now() + 30 * 60_000, ciphertext: await deps.encode(result.auth, selected[0]!.name),
        label: selected[0]!.name, base: first.base_url, ...(first.vendor ? { vendor: first.vendor } : {}), names: selected.map(r => r.name),
        expected, signature, requested: required,
        required: new Map(candidates.map(c => [c.name, managedOAuthScopeUnion(c.required_scopes, input.auth ? input.scopes ?? [] : [])])),
        granted: result.granted, target: '', ...(source ? { source: source.name } : {}), claimed: false, retired: false, busy: false, renewals: [] };
      created = flow;
      const impact = await deps.impact(flow.label, result.auth, names.filter(n => n !== flow.label));
      flow.target = hash(impact.target); assertCurrent(flow); flows.set(flow.id, flow);
      const issuedReview = await issue(flow, flow.label);
      return { auth: issuedReview.auth, expires_at: flow.expires, required_scopes: required, impact: issuedReview.impact,
        warnings: ['Read checks do not prove write access or every permission.',
          ...(result.granted === undefined ? ['The vendor did not report granted scopes. They remain unconfirmed.'] : []),
          'Nango authorizations are kept. Remove an unused broker account separately.'] };
    } catch (error) {
      if (created) { created.retired = true; created.ciphertext = ''; flows.delete(created.id);
        for (const [id, receipt] of issued) if (receipt.flow === created) issued.delete(id); }
      throw error;
    } finally { reviews--; }
  };
  const receipt = (auth: DirectOAuthAuthorization): Issued => {
    if (!auth || auth.type !== 'direct_oauth' || typeof auth.authorization_receipt !== 'string') throw refused();
    const found = issued.get(auth.authorization_receipt);
    if (!found || found.flow.expires <= deps.now() || JSON.stringify(auth.requested_scopes) !== JSON.stringify(found.flow.requested)) throw refused();
    return found;
  };
  const resolve = async (auth: DirectOAuthAuthorization, name: string, revision: number, fingerprint?: string) => {
    const found = receipt(auth);
    if (found.name !== name || typeof fingerprint !== 'string' || fingerprint !== found.impact.fingerprint) throw refused();
    const native = found.consumed ? await deps.decrypt(found.flow.ciphertext, found.flow.label) : await fresh(found.flow);
    const generation = found.flow.ciphertext;
    const assertPinned = (): void => {
      if (found.flow.ciphertext !== generation || native.expires_at !== undefined && native.expires_at <= deps.now()) throw refused();
    };
    return { auth: { ...native, required_scopes: found.flow.required.get(name) ?? [] }, granted_scopes: found.flow.granted,
      verify: async () => {
        if (found.consumed || row(name).updated_at !== revision) throw refused();
        assertPinned();
        const latest = await checkedImpact(found.flow, name, native);
        assertPinned();
        if (latest.fingerprint !== fingerprint) throw refused();
      },
      beforeSwap: () => { if (found.consumed) throw refused(); assertPinned(); assertCurrent(found.flow); },
      consume: () => { found.consumed = true; found.flow.expected.set(name, rowHash(row(name)));
        if (!found.flow.claimed) flows.delete(found.flow.id); } };
  };
  const claim = async (auth: DirectOAuthAuthorization, names: readonly string[], fingerprint: string): Promise<DirectOAuthMigrationAuthority> => {
    const found = receipt(auth); const flow = found.flow;
    if (flow.claimed || found.consumed || fingerprint !== found.impact.fingerprint
      || hash([...names].sort()) !== hash([...flow.names].sort())) throw refused();
    const current = await checkedImpact(flow, found.name);
    if (current.fingerprint !== fingerprint) throw refused();
    flow.claimed = true; issued.delete(auth.authorization_receipt);
    return { names: [...flow.expected.keys()], expires_at: flow.expires, signature: deps.signature([...flow.expected.keys()]),
      issue: name => { if (!flow.names.includes(name)) throw refused(); return issue(flow, name); },
      renewals: () => flow.renewals,
      close: () => { flow.retired = true; flow.ciphertext = ''; for (const [id, r] of issued) if (r.flow === flow) issued.delete(id); } };
  };
  const retire = (auth: DirectOAuthAuthorization): void => {
    const found = issued.get(auth?.authorization_receipt); if (!found || found.flow.claimed) return;
    found.flow.retired = true; found.flow.ciphertext = ''; flows.delete(found.flow.id);
    for (const [id, receipt] of issued) if (receipt.flow === found.flow) issued.delete(id);
  };
  return { review, resolve, claim, retire };
};
