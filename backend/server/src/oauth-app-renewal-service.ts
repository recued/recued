/** Durable owner checks of a saved OAuth app's current secret. Boot never replays a refresh. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, isOAuthAppRenewalRequest, isOAuthAppRenewalVerification, type OAuthAppRenewalRequest, type OAuthAppRenewalReview,
  type OAuthAppRenewalVerification, type OAuthAppRenewalResult, type OAuthAppsResponse, type AuthenticationIncidentHistoryPage,
  type AuthenticationRepairTarget, type ManagedOAuthConnectionUse } from '@recued/contracts';
import { createOAuthAppRenewalChecks } from './oauth-app-renewal-checks.js';
import { createOAuthAppRenewalHistory } from './oauth-app-renewal-history.js';
import { createAuthenticationIncidentStore } from './authentication-incident-store.js';
import { authenticationConnectionGroupKey, authenticationCollectionGroupKey } from './authentication-group-identity.js';
import { collectionOAuthBinding } from './collection-oauth-sources.js';

export interface OAuthAppRenewalService {
  handle(request: OAuthAppRenewalRequest): Promise<Omit<OAuthAppsResponse, 'apps'>>;
  history(value: AuthenticationIncidentHistoryPage): Promise<AuthenticationIncidentHistoryPage>;
}
const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const changed = () => new RpcError('conflict', 'The app, authorization or renewal review changed. Review renewal again.');
const failure = (error: unknown): Pick<OAuthAppRenewalResult, 'status' | 'reason'> => {
  if (error instanceof RpcError) {
    if (error.code === 'conflict') return { status: 'unconfirmed', reason: 'changed' };
    if (error.code === 'credential_verification_failed') return { status: 'unconfirmed', reason: 'persistence_failed' };
  }
  const data = error && typeof error === 'object' ? error as { oauth_error?: unknown; details?: { oauth_error?: unknown } } : undefined;
  const code = data?.oauth_error ?? data?.details?.oauth_error;
  if (code === 'invalid_client' || code === 'unauthorized_client') return { status: 'failed', reason: 'client_rejected' };
  if (code === 'invalid_grant') return { status: 'failed', reason: 'grant_rejected' };
  return { status: 'unconfirmed', reason: 'unavailable' };
};

export const createOAuthAppRenewalService = (deps: Parameters<typeof createOAuthAppRenewalChecks>[0] & {
  connectionUses?(name: string): { uses: readonly ManagedOAuthConnectionUse[]; complete: boolean };
}): OAuthAppRenewalService => {
  const db = deps.db; const now = deps.now ?? Date.now; const checks = createOAuthAppRenewalChecks(deps);
  const history = createOAuthAppRenewalHistory(db); const historyStore = createAuthenticationIncidentStore(db);
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_app_renewal_verifications (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, attempt_hash TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL UNIQUE, app_key TEXT NOT NULL, data TEXT NOT NULL, finished_at INTEGER, history_recorded_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS oauth_app_renewal_active ON oauth_app_renewal_verifications(app_key) WHERE finished_at IS NULL;
    CREATE TABLE IF NOT EXISTS oauth_app_renewal_attempts (attempt_hash TEXT PRIMARY KEY, verification_id TEXT NOT NULL);
    INSERT OR IGNORE INTO oauth_app_renewal_attempts SELECT attempt_hash, id FROM oauth_app_renewal_verifications;`);
  const columns = db.prepare('PRAGMA table_info(oauth_app_renewal_verifications)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'history_recorded_at')) db.exec('ALTER TABLE oauth_app_renewal_verifications ADD COLUMN history_recorded_at INTEGER');
  const save = db.transaction((v: OAuthAppRenewalVerification) => {
    if (!isOAuthAppRenewalVerification(v)) throw new Error('Invalid OAuth app renewal receipt');
    db.prepare('UPDATE oauth_app_renewal_verifications SET data = ?, finished_at = ? WHERE id = ?').run(JSON.stringify(v), v.finished_at ?? null, v.id);
    history.update(v);
  });
  const prune = () => {
    db.prepare('DELETE FROM oauth_app_renewal_verifications WHERE finished_at < ?').run(now() - 90 * 86_400_000);
    db.exec('DELETE FROM oauth_app_renewal_verifications WHERE sequence IN (SELECT sequence FROM oauth_app_renewal_verifications WHERE finished_at IS NOT NULL ORDER BY sequence DESC LIMIT -1 OFFSET 10000)');
    db.exec('DELETE FROM oauth_app_renewal_attempts WHERE verification_id NOT IN (SELECT id FROM oauth_app_renewal_verifications)');
    historyStore.prune(now());
  };
  prune();
  // Import retained checks once, in original source order, after existing history.
  // Recorded references are known; earlier account groups and file uses are not.
  db.transaction(() => {
    for (const row of db.prepare<[], { id: string; data: string }>('SELECT id, data FROM oauth_app_renewal_verifications WHERE history_recorded_at IS NULL ORDER BY sequence').all()) {
      const v = JSON.parse(row.data) as OAuthAppRenewalVerification;
      history.begin(v, now(), { references_incomplete: true });
      db.prepare('UPDATE oauth_app_renewal_verifications SET history_recorded_at = ? WHERE id = ?').run(Math.max(now(), v.started_at), row.id);
    }
  })();
  for (const row of db.prepare<[], { data: string }>('SELECT data FROM oauth_app_renewal_verifications WHERE finished_at IS NULL').all()) {
    const v = JSON.parse(row.data) as OAuthAppRenewalVerification; v.status = 'completed'; v.finished_at = Math.max(now(), v.started_at);
    for (const r of v.results) if (r.reason === 'not_checked') { r.status = 'unconfirmed'; r.reason = 'interrupted'; }
    save(v);
  }
  prune();
  const reviews = new Map<string, OAuthAppRenewalReview>(); let pending = 0;
  const project = async <T extends OAuthAppRenewalVerification>(value: T,
    inventories = new Map<string, ReturnType<typeof checks.inventory>>()): Promise<T> => {
    const v = structuredClone(value); const app = deps.apps.getApp(v.issuer, v.app_id);
    if (!app || app.revision !== v.app_revision) { for (const r of v.results) r.current = 'no'; return v; }
    try {
      const key = app.issuer + ':' + app.id + ':' + app.revision;
      let pending = inventories.get(key); if (!pending) { pending = checks.inventory(app); inventories.set(key, pending); }
      const inventory = await pending;
      for (const r of v.results) {
        const g = inventory.groups.find(g => g.public.id === r.id)?.public;
        r.current = g?.reason === 'unavailable' || !g && inventory.incomplete ? 'unknown' : g?.revision === r.revision ? 'yes' : 'no';
      }
    } catch { for (const r of v.results) r.current = 'unknown'; }
    return v;
  };
  const read = (id: string): OAuthAppRenewalVerification => {
    const row = db.prepare<[string, number], { data: string }>('SELECT data FROM oauth_app_renewal_verifications WHERE id = ? AND (finished_at IS NULL OR finished_at >= ?)').get(id, now() - 90 * 86_400_000);
    if (!row) throw new RpcError('not_found', 'This renewal check is no longer retained. Review a new check.');
    return JSON.parse(row.data) as OAuthAppRenewalVerification;
  };
  const execute = async (v: OAuthAppRenewalVerification, review: OAuthAppRenewalReview, selected: string[]): Promise<void> => {
    const deadline = Date.now() + 180_000;
    for (const r of v.results) {
      if (!selected.includes(r.id)) continue;
      try {
        if (Date.now() >= deadline) { r.reason = 'unavailable'; continue; }
        r.revision = await checks.renew(review.app, review.grants.find(g => g.id === r.id)!);
        r.status = 'passed'; delete r.reason;
      } catch (error) { Object.assign(r, failure(error)); }
      save(v);
    }
    v.status = 'completed'; v.finished_at = Math.max(now(), v.started_at); save(v); prune();
  };
  return { async history(value) {
    const result = structuredClone(value); const inventories = new Map<string, ReturnType<typeof checks.inventory>>();
    if (result.renewals) result.renewals = await Promise.all(result.renewals.map(v => project(v, inventories)));
    return result;
  }, async handle(request) {
    if (!isOAuthAppRenewalRequest(request)) throw new RpcError('bad_request', 'Choose a valid saved-app renewal check.');
    if (request.action === 'renewal_retire') { reviews.delete(request.review_id); return { action: request.action }; }
    if (request.action === 'renewal_status') {
      if ('id' in request) return { action: request.action, renewal_verification: await project(read(request.id)) };
      const row = db.prepare<[string, number], { data: string }>(`SELECT v.data FROM oauth_app_renewal_verifications v
        JOIN oauth_app_renewal_attempts a ON a.verification_id = v.id WHERE a.attempt_hash = ? AND (v.finished_at IS NULL OR v.finished_at >= ?)`)
        .get(hash(request.attempt_id), now() - 90 * 86_400_000);
      return { action: request.action, renewal_verification: row ? await project(JSON.parse(row.data) as OAuthAppRenewalVerification) : null };
    }
    if (request.action === 'renewal_preview') {
      for (const r of reviews.values()) if (r.expires_at <= now()) reviews.delete(r.id);
      if (reviews.size + pending >= 32) throw new RpcError('conflict', 'Close an existing renewal review before opening another.');
      const app = deps.apps.getApp(request.issuer, request.id); if (!app || app.revision !== request.expected_revision) throw changed();
      pending++;
      try {
        const inventory = await checks.inventory(app);
        const review: OAuthAppRenewalReview = { id: randomBytes(32).toString('base64url'), fingerprint: '', expires_at: now() + 10 * 60_000,
          app, grants: inventory.groups.map(g => g.public), incomplete: inventory.incomplete };
        review.fingerprint = hash(review);
        const latest = db.prepare<[string, number], { data: string }>('SELECT data FROM oauth_app_renewal_verifications WHERE app_key = ? AND (finished_at IS NULL OR finished_at >= ?) ORDER BY sequence DESC LIMIT 1')
          .get(app.issuer + ':' + app.id, now() - 90 * 86_400_000);
        if (latest) review.latest = await project(JSON.parse(latest.data) as OAuthAppRenewalVerification);
        if (deps.apps.getApp(app.issuer, app.id)?.revision !== app.revision) throw changed();
        reviews.set(review.id, review); return { action: request.action, renewal_review: structuredClone(review) };
      } finally { pending--; }
    }
    const selected = [...request.selected_ids].sort(); const attemptHash = hash(request.attempt_id);
    const requestHash = hash([request.review_id, request.fingerprint, selected]);
    const bindAttempt = db.transaction((id: string) => {
      const linked = db.prepare<[string], { verification_id: string }>('SELECT verification_id FROM oauth_app_renewal_attempts WHERE attempt_hash = ?').get(attemptHash);
      if (linked && linked.verification_id !== id) throw changed();
      db.prepare('INSERT OR IGNORE INTO oauth_app_renewal_attempts VALUES (?, ?)').run(attemptHash, id);
    });
    const existing = () => {
      const row = db.prepare<[string, string], { id: string; request_hash: string; data: string }>(`SELECT v.id, v.request_hash, v.data FROM oauth_app_renewal_verifications v
        LEFT JOIN oauth_app_renewal_attempts a ON a.verification_id = v.id AND a.attempt_hash = ?
        WHERE a.attempt_hash IS NOT NULL OR v.request_hash = ? ORDER BY a.attempt_hash IS NOT NULL DESC LIMIT 1`).get(attemptHash, requestHash);
      if (row && row.request_hash !== requestHash) throw changed();
      if (row) bindAttempt(row.id);
      return row ? JSON.parse(row.data) as OAuthAppRenewalVerification : undefined;
    };
    let prior = existing(); if (prior) return { action: request.action, renewal_verification: await project(prior) };
    const review = reviews.get(request.review_id);
    if (!review || review.fingerprint !== request.fingerprint || review.expires_at <= now()
      || selected.some(id => !review.grants.some(g => g.id === id && g.eligible))) throw changed();
    const fresh = await checks.inventory(review.app);
    if (fresh.incomplete !== review.incomplete || hash(fresh.groups.map(g => g.public)) !== hash(review.grants)) throw changed();
    prior = existing(); if (prior) return { action: request.action, renewal_verification: await project(prior) };
    if (reviews.get(review.id) !== review || review.expires_at <= now()) throw changed();
    const active = db.prepare<[], { n: number }>('SELECT count(*) n FROM oauth_app_renewal_verifications WHERE finished_at IS NULL').get()!.n;
    const appKey = review.app.issuer + ':' + review.app.id;
    if (active >= 4 || db.prepare('SELECT 1 FROM oauth_app_renewal_verifications WHERE app_key = ? AND finished_at IS NULL').get(appKey)) {
      throw new RpcError('conflict', 'A renewal check is already running. Read its saved status before starting another.');
    }
    const v: OAuthAppRenewalVerification = { id: 'renewal-' + randomUUID(), issuer: review.app.issuer, app_id: review.app.id, app_revision: review.app.revision,
      app_label: review.app.label, status: 'checking', started_at: now(), incomplete: review.incomplete,
      results: review.grants.map(g => ({ ...g, current: 'yes', status: 'unconfirmed', reason: g.reason ?? (selected.includes(g.id) ? 'not_checked' : 'not_selected') })) };
    // Same identities as the passive worklist; never infer an account from email or app alone.
    const groups = fresh.groups.flatMap(g => [
      ...g.api?.map(a => hash(authenticationConnectionGroupKey(a.row, a.auth))) ?? [],
      ...g.native?.rows.map(r => hash(authenticationCollectionGroupKey(r))) ?? [],
    ]);
    const targets: AuthenticationRepairTarget[] = []; let referencesIncomplete = false;
    const api = new Map(fresh.groups.flatMap(g => g.api ?? []).map(a => [a.row.name, a.auth]));
    for (const row of deps.instances.list()) if (row.platform === 'mail' || row.platform === 'calendar') {
      const binding = collectionOAuthBinding(row.config);
      if (!binding || typeof binding !== 'object' || !('type' in binding) || binding.type !== 'direct_oauth'
        || !('connection_name' in binding) || typeof binding.connection_name !== 'string' || !('native_credential_id' in binding)) continue;
      const auth = api.get(binding.connection_name);
      if (auth?.native_credential_id && binding.native_credential_id === auth.native_credential_id) targets.push({ kind: 'collection', platform: row.platform, slug: row.slug });
    }
    const files = new Set<string>();
    for (const name of v.results.flatMap(r => r.connections)) {
      try {
        const usage = deps.connectionUses?.(name); referencesIncomplete ||= !usage?.complete;
        for (const use of usage?.uses ?? []) if (use.kind === 'file' && !files.has(use.id)) {
          if (files.size >= 256 || !use.id.trim() || use.id.length > 2048 || /[\x00-\x1f\x7f]/.test(use.id)) { referencesIncomplete = true; continue; }
          files.add(use.id); targets.push({ kind: 'file_source', source_id: use.id });
        }
      } catch { referencesIncomplete = true; }
    }
    db.transaction(() => {
      db.prepare('INSERT INTO oauth_app_renewal_verifications (id, attempt_hash, request_hash, app_key, data, history_recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(v.id, attemptHash, requestHash, appKey, JSON.stringify(v), v.started_at);
      bindAttempt(v.id);
      history.begin(v, v.started_at, { groups, targets, references_incomplete: referencesIncomplete });
    })();
    reviews.delete(review.id);
    setImmediate(() => { void execute(v, review, selected).catch(() => {
      // A failed receipt write must never replay a potentially rotating refresh.
      v.status = 'completed'; v.finished_at = Math.max(now(), v.started_at);
      for (const r of v.results) if (r.reason === 'not_checked') r.reason = 'unavailable';
      try { save(v); } catch { /* Boot closes an unfinished durable receipt. */ }
    }); });
    return { action: request.action, renewal_verification: structuredClone(v) };
  } };
};
