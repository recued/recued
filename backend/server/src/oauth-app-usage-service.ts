/** Saved-app usage and atomic, same-Client-ID secret replacement. No provider I/O. */
import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, OAUTH_APP_ID, savedOAuthAppIssuerForEndpoints, isOAuthAppSecretExpiryDate,
  type ConnectionAuth, type ConnectionRow, type OAuthAppIssuer, type SavedOAuthApp,
  type OAuthAppUsageRequest, type OAuthAppUsageReview, type OAuthAppSecretRotationOutcome, type OAuthAppsResponse,
  type ManagedOAuthConnectionUse } from '@recued/contracts';
import type { OAuthAppConfigStore } from './oauth-app-config-store.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { CollectionInstanceStore } from './collections/instance-store.js';
import { encodeAuthForStorage, decodeAuthFromStorage } from './connection-auth-storage.js';
import { collectionAuthenticationLocks } from './collection-authentication-locks.js';

const nonce = (): string => randomBytes(32).toString('base64url');
const validNonce = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const changed = (): RpcError => new RpcError('conflict', 'The app, credentials or local usage changed. Refresh the usage review before rotating.');
const material = (rows: readonly ConnectionRow[]): string => hash([...rows].sort((a, b) => a.name.localeCompare(b.name))
  .map(r => [r.pk, r.enrolled_at, r.auth_ciphertext, r.config_json, r.display_name, r.subresource_path, r.granted_scopes_json]));
interface Review { public: OAuthAppUsageReview; inventory: string; usage: string }
export interface OAuthAppUsageService {
  handle(request: OAuthAppUsageRequest): Promise<Omit<OAuthAppsResponse, 'apps'>>;
}
export const createOAuthAppUsageService = (deps: {
  db: Database.Database; apps: OAuthAppConfigStore; connections: ConnectionStoreSqlite; instances: CollectionInstanceStore;
  key?: () => Uint8Array | null; now?(): number;
  connectionUses?(name: string): { uses: readonly ManagedOAuthConnectionUse[]; complete: boolean };
}): OAuthAppUsageService => {
  const now = deps.now ?? Date.now; const reviews = new Map<string, Review>(); const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const activeApps = new Set<string>(); const collectionLocks = collectionAuthenticationLocks(deps.db); let pending = 0;
  const rows = () => deps.connections.list({ kind: 'api' });
  const native = (app: SavedOAuthApp) => deps.instances.list().filter(r => (r.platform === 'mail' || r.platform === 'calendar')
    && ['gmail', 'gcal', 'graph'].includes(r.adapter_type) && r.config.oauth_connection === undefined && r.config.managed_oauth === undefined
    && (r.adapter_type === 'graph' ? 'microsoft' : 'google') === app.issuer && (r.config.oauth_app_id ?? 'default') === app.id)
    .map(r => ({ platform: r.platform as 'mail' | 'calendar', slug: r.slug })).sort((a, b) => (a.platform + a.slug).localeCompare(b.platform + b.slug));
  const references = (name: string) => {
    try {
      const value = deps.connectionUses?.(name);
      return { uses: [...value?.uses ?? []].sort((a, b) => (a.kind + a.id).localeCompare(b.kind + b.id)), complete: value?.complete ?? false };
    } catch { return { uses: [], complete: false }; }
  };
  const usageSignature = (review: OAuthAppUsageReview) => hash([native(review.app), review.connections.map(c => [c.name, references(c.name)])]);
  const retire = (id: string): void => { const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id); reviews.delete(id); };
  const assertReview = (review: Review): void => {
    if (reviews.get(review.public.id) !== review || review.public.expires_at <= now()
      || deps.apps.getApp(review.public.app.issuer, review.public.app.id)?.revision !== review.public.app.revision
      || material(rows()) !== review.inventory || usageSignature(review.public) !== review.usage) throw changed();
    if (review.public.connections.some(c => deps.connections.getPendingCredentialRotationAttempt?.('api', c.name))) throw changed();
  };
  deps.db.exec('CREATE TABLE IF NOT EXISTS oauth_app_secret_rotation_attempts (attempt_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, fingerprint TEXT NOT NULL, outcome_json TEXT NOT NULL)');
  const readAttempt = (id: string) => deps.db.prepare<[string], { review_id: string; fingerprint: string; outcome_json: string }>(
    'SELECT review_id, fingerprint, outcome_json FROM oauth_app_secret_rotation_attempts WHERE attempt_id = ?').get(id);
  const save = (value: OAuthAppSecretRotationOutcome): void => {
    deps.db.prepare('UPDATE oauth_app_secret_rotation_attempts SET outcome_json = ? WHERE attempt_id = ?').run(JSON.stringify(value), value.attempt_id);
  };
  for (const row of deps.db.prepare<[], { outcome_json: string }>('SELECT outcome_json FROM oauth_app_secret_rotation_attempts').all()) {
    const outcome = JSON.parse(row.outcome_json) as OAuthAppSecretRotationOutcome;
    if (outcome.status === 'checking') save({ ...outcome, status: 'failed', reason: 'interrupted' });
  }
  return { async handle(request) {
    if (request.action === 'retire_usage') { if (validNonce(request.id)) retire(request.id); return { action: request.action }; }
    if (request.action === 'rotation_status') {
      if (!validNonce(request.attempt_id)) throw changed();
      const saved = readAttempt(request.attempt_id);
      return { action: request.action, rotation_outcome: saved ? JSON.parse(saved.outcome_json) as OAuthAppSecretRotationOutcome : null };
    }
    if (request.action === 'usage') {
      if (!['google', 'microsoft'].includes(request.issuer) || typeof request.id !== 'string' || !OAUTH_APP_ID.test(request.id)) throw changed();
      for (const review of reviews.values()) if (review.public.expires_at <= now()) retire(review.public.id);
      if (reviews.size + pending >= 32) throw new RpcError('conflict', 'Close an existing app usage review before opening another.');
      const app = deps.apps.getApp(request.issuer, request.id);
      if (!app || app.revision !== request.expected_revision) throw changed();
      pending++;
      try {
        const inventory = rows(); const inventoryHash = material(inventory); const warnings: string[] = [];
        let currentSecret: string | null = null; let readable = true;
        try {
          if (deps.key && !deps.key()) throw new RpcError('locked', 'Unlock Recued before rotating.');
          currentSecret = deps.apps.getClientSecret(app.issuer, app.id);
        }
        catch { readable = false; warnings.push('Unlock Recued or repair the saved app before rotating its secret.'); }
        if (readable && !app.has_secret) warnings.push('This saved app has no secret. Enter its vendor secret to repair the app and selected credential copies.');
        const decoded = await Promise.all(inventory.map(async row => {
          try { return { row, auth: await decodeAuthFromStorage(row.auth_ciphertext, row, deps.key) }; }
          catch { return { row, auth: undefined }; }
        }));
        const copies: OAuthAppUsageReview['connections'][number][] = [];
        const groups = new Map<string, string>();
        for (const { row, auth } of decoded) {
          if (auth?.type !== 'oauth2_refresh') continue;
          const origin = auth.saved_oauth_app;
          const confirmed = origin?.issuer === app.issuer && origin.id === app.id;
          const originApp = origin ? deps.apps.getApp(origin.issuer, origin.id) : null;
          const matches = auth.client_id === app.client_id && savedOAuthAppIssuerForEndpoints(auth) === app.issuer;
          if (!confirmed && (!matches || originApp)) continue;
          const family = auth.native_credential_id ? 'family:' + auth.native_credential_id : 'connection:' + row.name;
          if (!groups.has(family)) groups.set(family, 'group-' + (groups.size + 1));
          const familyMembers = auth.native_credential_id ? decoded.filter(d => d.auth?.type === 'oauth2_refresh'
            && d.auth.native_credential_id === auth.native_credential_id) : [{ row, auth }];
          const groupComplete = matches && familyMembers.every(d => d.auth?.type === 'oauth2_refresh' && d.auth.client_id === app.client_id
            && savedOAuthAppIssuerForEndpoints(d.auth) === app.issuer
            && (!d.auth.saved_oauth_app || d.auth.saved_oauth_app.id === app.id && d.auth.saved_oauth_app.issuer === app.issuer
              || !deps.apps.getApp(d.auth.saved_oauth_app.issuer, d.auth.saved_oauth_app.id)));
          const use = references(row.name);
          copies.push({ name: row.name, display_name: row.display_name, origin: confirmed ? 'confirmed' : 'unknown', client_id_matches: auth.client_id === app.client_id,
            secret_matches: readable && currentSecret !== null && auth.client_secret === currentSecret,
            group_id: groups.get(family)!, group_complete: groupComplete, selected_by_default: confirmed && groupComplete,
            uses: use.uses, usage_available: use.complete });
        }
        copies.sort((a, b) => a.name.localeCompare(b.name));
        // A family containing an unconfirmed copy still needs explicit inclusion.
        for (const copy of copies) if (copies.some(c => c.group_id === copy.group_id && !c.selected_by_default)) {
          for (const member of copies) if (member.group_id === copy.group_id) member.selected_by_default = false;
        }
        const unreadable = decoded.filter(d => d.auth === undefined).map(d => d.row.name).sort();
        if (copies.some(c => c.origin === 'unknown')) warnings.push('Some connections use the same Client ID, but their saved app origin is unknown. Include them only after review.');
        if (copies.some(c => !c.secret_matches)) warnings.push('Some credential copies differ from this app or could not be compared. Review them before replacing their secret.');
        if (copies.some(c => !c.usage_available)) warnings.push('Some downstream usage could not be read. Local usage may be incomplete.');
        if (unreadable.length) warnings.push('Some API credentials could not be read. Unlock Recued or repair them, then refresh this review.');
        if (copies.length > 256 || native(app).length > 256 || unreadable.length > 256) throw new RpcError('bad_request', 'This app has too many local uses for one rotation.');
        const pub: OAuthAppUsageReview = { id: nonce(), fingerprint: '', expires_at: now() + 10 * 60_000, app,
          native_accounts: native(app), connections: copies, unreadable_connections: unreadable,
          can_rotate: readable && unreadable.length === 0 && !!deps.connections.rotateOAuthAppSecrets && !!deps.connections.withCredentialLease, warnings };
        pub.fingerprint = hash(pub);
        const review = { public: pub, inventory: inventoryHash, usage: usageSignature(pub) };
        reviews.set(pub.id, review); const timer = setTimeout(() => retire(pub.id), Math.max(1, pub.expires_at - now())); timer.unref(); timers.set(pub.id, timer);
        try { assertReview(review); } catch (error) { retire(pub.id); throw error; }
        return { action: request.action, usage: structuredClone(pub) };
      } finally { pending--; }
    }
    if (request.action !== 'rotate_secret' || !validNonce(request.attempt_id)) throw changed();
    if (request.secret_expires_on !== undefined && request.secret_expires_on !== null && !isOAuthAppSecretExpiryDate(request.secret_expires_on)) {
      throw new RpcError('bad_request', 'Enter a real expiry date as YYYY-MM-DD, or leave the new date blank.');
    }
    const selected = Array.isArray(request.selected_names) ? [...request.selected_names].sort() : [];
    if (!Array.isArray(request.selected_names) || selected.length > 256 || selected.some(n => typeof n !== 'string')
      || new Set(selected).size !== selected.length) throw new RpcError('bad_request', 'Choose the credential copies to rotate.');
    const saved = readAttempt(request.attempt_id);
    if (saved) {
      const outcome = JSON.parse(saved.outcome_json) as OAuthAppSecretRotationOutcome;
      if (saved.review_id !== request.review_id || saved.fingerprint !== request.fingerprint || JSON.stringify(outcome.selected_names) !== JSON.stringify(selected)
        || outcome.secret_expires_on !== (request.secret_expires_on ?? undefined)) throw changed();
      return { action: request.action, rotation_outcome: outcome };
    }
    const review = reviews.get(request.review_id);
    if (!review || request.fingerprint !== review.public.fingerprint) throw changed();
    assertReview(review);
    if (!review.public.can_rotate) throw new RpcError('locked', 'Unlock Recued and refresh the complete usage review before rotating.');
    if (typeof request.client_secret !== 'string' || !request.client_secret.trim() || request.client_secret.length > 16_384
      || /[\x00-\x1f\x7f]/.test(request.client_secret)) throw new RpcError('bad_request', 'Enter the new client secret from the vendor app.');
    const copies = review.public.connections;
    for (const name of selected) {
      const copy = copies.find(c => c.name === name);
      if (!copy?.group_complete || copies.some(c => c.group_id === copy.group_id && !selected.includes(c.name))) {
        throw new RpcError('bad_request', 'Select every connection sharing this authorization, or exclude the whole group.');
      }
    }
    const appKey = review.public.app.issuer + ':' + review.public.app.id;
    const locks = review.public.native_accounts.map(a => a.platform + ':' + a.slug);
    if (activeApps.has(appKey) || locks.some(key => collectionLocks.has(key))) throw new RpcError('conflict', 'An authentication change is already in progress for this app.');
    let outcome: OAuthAppSecretRotationOutcome = { attempt_id: request.attempt_id, issuer: review.public.app.issuer, app_id: review.public.app.id,
      status: 'checking', selected_names: selected, skipped_names: copies.filter(c => !selected.includes(c.name)).map(c => c.name),
      native_accounts: review.public.native_accounts, verification: 'not_checked',
      ...(request.secret_expires_on ? { secret_expires_on: request.secret_expires_on } : {}) };
    deps.db.prepare('INSERT INTO oauth_app_secret_rotation_attempts VALUES (?, ?, ?, ?)').run(request.attempt_id, request.review_id, request.fingerprint, JSON.stringify(outcome));
    activeApps.add(appKey); locks.forEach(key => collectionLocks.add(key));
    try {
      await deps.connections.withCredentialLease!(selected, async () => {
      assertReview(review);
      const updates = await Promise.all(selected.map(async name => {
        const row = deps.connections.get('api', name); if (!row) throw changed();
        const auth = await decodeAuthFromStorage(row.auth_ciphertext, row, deps.key);
        if (auth.type !== 'oauth2_refresh') throw changed();
        const next: ConnectionAuth = { ...auth, client_secret: request.client_secret.trim(), saved_oauth_app: { issuer: outcome.issuer, id: outcome.app_id } };
        return { previous: row, auth_ciphertext: await encodeAuthForStorage(next, row, deps.key), updated_at: Math.max(now(), row.updated_at + 1) };
      }));
      assertReview(review);
      deps.connections.rotateOAuthAppSecrets!(updates, () => {
        assertReview(review);
        const current = review.public.app;
        const app = deps.apps.saveApp({ issuer: current.issuer, id: current.id, label: current.label, client_id: current.client_id,
          expected_revision: current.revision, client_secret: request.client_secret.trim(), secret_expires_on: request.secret_expires_on ?? null });
        outcome = { ...outcome, status: 'applied', app_revision: app.revision }; save(outcome);
      });
      });
    } catch (error) {
      outcome = { ...outcome, status: 'failed', reason: error instanceof RpcError && error.code === 'locked' ? 'locked'
        : error instanceof RpcError && error.code === 'conflict' || error instanceof Error && error.message === 'oauth_app_rotation_changed' ? 'changed' : 'server_error' };
      delete outcome.app_revision; save(outcome);
    } finally { retire(review.public.id); activeApps.delete(appKey); locks.forEach(key => collectionLocks.delete(key)); }
    return { action: request.action, rotation_outcome: outcome };
  } };
};
