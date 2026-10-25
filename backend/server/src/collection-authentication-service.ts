/** Same-account, owner-only collection migration. No token copies, writes, or consent. */
import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, type AuthenticationCollectionPlatform, type CollectionAuthenticationOutcome,
  type CollectionAuthenticationRequest, type CollectionAuthenticationResponse, type CollectionAuthenticationReview,
  isCollectionPermissionChoices, type ManagedOAuthAccountIdentity } from '@recued/contracts';
import type { CollectionInstanceRecord, CollectionInstanceStore } from './collections/instance-store.js';
import type { MailEnrollDeps } from './collections/mail/enroll.js';
import type { CalendarEnrollDeps } from './collections/calendar/enroll.js';
import { getAccessToken, getGrantedScopes, keyPrefix, assertNoPermissionCleanup, type HttpFetcher } from './collections/mail/oauth.js';
import { readOAuthAppId } from './collections/mail/oauth.js';
import { collectionAuthenticationLocks } from './collection-authentication-locks.js';
import { makeBoundedOriginHttpFetcher } from './bounded-origin-http-fetcher.js';
import { createAuthenticationRepairActionStore } from './authentication-repair-action-store.js';
import { collectionOAuthBinding, collectionOAuthSourceName, type CollectionOAuthSources, type CollectionOAuthTransport } from './collection-oauth-sources.js';
import { collectionProvider, collectionIdentityUrl, collectionAbilities, collectionSelections, collectionScopesCover,
  readCollectionIdentity, matchingCollectionAccount, verifyCollectionReads, collectionPermissionChoices, requestedCollectionAbilities,
  collectionPermissionCaps, type CollectionAbilities } from './collection-authentication-checks.js';

export interface CollectionAuthenticationLifecycle { stop(slug: string): Promise<void>; restart(slug: string): Promise<void>; running?(slug: string): boolean;
  /** Settles once the running collection's sync has caught up with its source (`caughtUp`).
   *  At once when none is running, or its sync waits for the vault. */
  caughtUp?(slug: string): Promise<void> }
export interface CollectionAuthenticationService {
  handle(request: CollectionAuthenticationRequest): Promise<CollectionAuthenticationResponse>;
  prepareSavedAccess?(platform: 'mail' | 'calendar', slug: string): Promise<import('./authentication-access-verification.js').PreparedAuthenticationAccess>;
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowMaterial = (row: CollectionInstanceRecord): string => hash([row.platform, row.slug, row.created_at, row.adapter_type, row.config, row.caps]);
const bindingMaterial = (row: CollectionInstanceRecord): string => hash([row.adapter_type, row.config.account_slug ?? row.slug, collectionOAuthBinding(row.config) ?? 'original_native']);
const changed = (): RpcError => new RpcError('conflict', 'The collection or saved authentication changed. Review the migration again.');
const nonce = (): string => randomBytes(32).toString('base64url');
const validNonce = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
interface Review { public: CollectionAuthenticationReview; row: CollectionInstanceRecord; transport: CollectionOAuthTransport;
  abilities: CollectionAbilities; selectedAbilities: CollectionAbilities }

export const createCollectionAuthenticationService = (deps: {
  db: Database.Database; instances: CollectionInstanceStore; sources: CollectionOAuthSources;
  mail: MailEnrollDeps; calendar: CalendarEnrollDeps; now?(): number; anonymous?: HttpFetcher;
}): CollectionAuthenticationService => {
  const now = deps.now ?? Date.now;
  const repairs = createAuthenticationRepairActionStore(deps.db);
  const anonymous = deps.anonymous ?? makeBoundedOriginHttpFetcher({ timeoutMs: 15_000, redirectPolicy: 'error' });
  deps.db.exec(`CREATE TABLE IF NOT EXISTS collection_authentication_attempts (
    attempt_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, fingerprint TEXT NOT NULL, outcome_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS collection_authentication_identities (
      platform TEXT NOT NULL, slug TEXT NOT NULL, created_at INTEGER NOT NULL, binding_hash TEXT NOT NULL,
      identity_json TEXT NOT NULL, PRIMARY KEY(platform, slug));`);
  const attempts = deps.db.prepare('SELECT * FROM collection_authentication_attempts WHERE attempt_id = ?');
  const readAttempt = (id: string): { review_id: string; fingerprint: string; outcome: CollectionAuthenticationOutcome } | null => {
    const row = attempts.get(id) as { review_id: string; fingerprint: string; outcome_json: string } | undefined;
    return row ? { review_id: row.review_id, fingerprint: row.fingerprint, outcome: JSON.parse(row.outcome_json) as CollectionAuthenticationOutcome } : null;
  };
  const saveOutcome = (id: string, outcome: CollectionAuthenticationOutcome): void => {
    deps.db.transaction(() => {
      deps.db.prepare('UPDATE collection_authentication_attempts SET outcome_json = ? WHERE attempt_id = ?').run(JSON.stringify(outcome), id);
      if (outcome.status !== 'checking') repairs.finish('collection_authentication', id, outcome.status === 'applied'
        ? { status: 'applied', restart_required: outcome.restart_needed === true }
        : { status: 'failed', reason: outcome.reason === 'unavailable' ? 'unreachable' : outcome.reason ?? 'server_error' }, now());
    })();
  };
  // An interrupted read/check never silently resumes after a server restart.
  for (const row of deps.db.prepare('SELECT attempt_id, outcome_json FROM collection_authentication_attempts').all() as { attempt_id: string; outcome_json: string }[]) {
    const outcome = JSON.parse(row.outcome_json) as CollectionAuthenticationOutcome;
    if (outcome.status === 'checking') saveOutcome(row.attempt_id, { ...outcome, status: 'failed', reason: 'interrupted' });
  }
  const reviews = new Map<string, Review>(); const active = collectionAuthenticationLocks(deps.db);
  const lookup = (platform: unknown, slug: unknown): CollectionInstanceRecord => {
    if (!['mail', 'calendar'].includes(String(platform)) || typeof slug !== 'string' || !slug || slug.length > 200) throw new RpcError('bad_request', 'Choose an existing Mail or Calendar account.');
    const row = deps.instances.get(platform as AuthenticationCollectionPlatform, slug);
    if (!row) throw new RpcError('not_found', 'The collection no longer exists.');
    collectionProvider(row); return row;
  };
  const enroll = (row: CollectionInstanceRecord): MailEnrollDeps | CalendarEnrollDeps => row.platform === 'mail' ? deps.mail : deps.calendar;
  const currentIdentity = async (row: CollectionInstanceRecord): Promise<ManagedOAuthAccountIdentity> => {
    const saved = deps.db.prepare('SELECT * FROM collection_authentication_identities WHERE platform = ? AND slug = ?').get(row.platform, row.slug) as
      { created_at: number; binding_hash: string; identity_json: string } | undefined;
    // A recorded corpus identity remains authoritative even if the remote account is reassigned.
    if (saved && saved.created_at === row.created_at && saved.binding_hash === bindingMaterial(row)) return JSON.parse(saved.identity_json) as ManagedOAuthAccountIdentity;
    try {
      const binding = collectionOAuthBinding(row.config); const provider = collectionProvider(row);
      let fetcher: HttpFetcher;
      if (binding !== undefined) {
        const broker = binding && typeof binding === 'object' && 'broker_profile_id' in binding;
        fetcher = broker ? deps.sources.previousBrokerFetch(provider, binding) : deps.sources.fetch(provider, binding);
      } else {
        const appId = readOAuthAppId(row.config.oauth_app_id);
        const config = row.platform === 'mail' ? deps.mail.oauthConfig?.(provider as 'gmail' | 'graph', appId)
          : deps.calendar.oauthConfig?.(provider as 'gcal' | 'graph', appId);
        if (!config) throw new Error('Native OAuth app is unavailable');
        const access = await getAccessToken({ provider, slug: typeof row.config.account_slug === 'string' ? row.config.account_slug : row.slug,
          providerConfig: config, accountStore: enroll(row).accountStore, ...(enroll(row).fetcher ? { fetcher: enroll(row).fetcher } : {}), now });
        const raw = enroll(row).fetcher ?? anonymous;
        fetcher = (url, init) => raw(url, { ...init, headers: { ...init?.headers, Authorization: 'Bearer ' + access } });
      }
      return await readCollectionIdentity(row, fetcher);
    } catch {
      // Only server-recorded vendor evidence can survive expired credentials.
      // A config patch cannot invent an identity or move evidence to another grant.
      throw new RpcError('bad_request', 'The existing account could not be verified. Repair it before switching authentication; the collection was left unchanged.');
    }
  };
  const assertRow = (review: Review): CollectionInstanceRecord => {
    const row = lookup(review.row.platform, review.row.slug);
    if (rowMaterial(row) !== rowMaterial(review.row)) throw changed();
    return row;
  };
  const verify = async (review: Review): Promise<void> => {
    assertRow(review);
    const abilities = await collectionAbilities(review.row, enroll(review.row));
    if (hash(abilities) !== hash(review.abilities)) throw changed();
    await review.transport.assertCurrent();
    const target = await readCollectionIdentity(review.row, review.transport.fetch);
    const current = await currentIdentity(review.row);
    if (!matchingCollectionAccount(current, target) || !matchingCollectionAccount(review.public.target, target)) {
      throw new RpcError('bad_request', 'The selected authentication belongs to a different or unconfirmed account. The collection was left unchanged.');
    }
    const selected = review.selectedAbilities;
    if (review.transport.grantedScopes && !collectionScopesCover(review.transport.grantedScopes, selected.needs)
      || !review.transport.grantedScopes && (selected.send || selected.mutation || selected.write)) {
      throw new RpcError('bad_request', 'Vendor-reported permissions must cover the selected features. Re-authorize the current connection in Apps & APIs, then review again.');
    }
    await verifyCollectionReads(review.row, review.transport.fetch, review.transport.grantedScopes);
    const control = await anonymous(collectionIdentityUrl(review.row), { method: 'GET' });
    if (control.status !== 401 && control.status !== 403) throw new RpcError('bad_request', 'The account check did not prove protected vendor access.');
    await review.transport.assertCurrent(); assertRow(review);
  };
  const prepareSavedAccess = async (platform: 'mail' | 'calendar', slug: string): Promise<import('./authentication-access-verification.js').PreparedAuthenticationAccess> => {
    const row = lookup(platform, slug); const provider = collectionProvider(row); const native = collectionOAuthBinding(row.config) === undefined;
    const owner = enroll(row); const grantSlug = typeof row.config.account_slug === 'string' ? row.config.account_slug : row.slug;
    const appConfig = () => row.platform === 'mail' ? deps.mail.oauthConfig?.(provider as 'gmail' | 'graph', readOAuthAppId(row.config.oauth_app_id))
      : deps.calendar.oauthConfig?.(provider as 'gcal' | 'graph', readOAuthAppId(row.config.oauth_app_id));
    const prefix = keyPrefix(provider, grantSlug);
    const revision = hash([rowMaterial(row), native ? [appConfig(), await owner.accountStore.get(prefix + '.grant_generation'),
      await owner.accountStore.get(prefix + '.granted_scopes'), await owner.accountStore.get(prefix + '.permission_cleanup_pending')] : 'saved_api_binding']);
    const assertCurrent = async () => {
      if ((await prepareSavedAccess(platform, slug)).descriptor.authentication_revision !== revision) throw changed();
      if (active.has(platform + ':' + slug)) throw changed();
    };
    return { descriptor: { label: (platform === 'mail' ? 'Mail: ' : 'Calendar: ') + slug, authentication_revision: revision, check: 'collection_read' },
      async run(_choice, signal) {
        const assertActive = async () => { if (signal?.aborted) throw new Error('Access check cancelled'); await assertCurrent(); };
        await assertActive(); let fetcher: HttpFetcher; let grants: readonly string[] | null;
        if (native) {
          await assertNoPermissionCleanup({ provider, slug: grantSlug, accountStore: owner.accountStore });
          const config = appConfig(); if (!config) throw new RpcError('not_configured', 'The saved OAuth app is unavailable.');
          const token = await getAccessToken({ provider, slug: grantSlug, providerConfig: config, accountStore: owner.accountStore,
            ...(owner.fetcher ? { fetcher: owner.fetcher } : {}), now });
          const raw = owner.fetcher ?? anonymous;
          fetcher = (url, init) => raw(url, { ...init, headers: { ...init?.headers, Authorization: 'Bearer ' + token } });
          grants = await getGrantedScopes(owner.accountStore, provider, grantSlug);
        } else {
          fetcher = deps.sources.fetch(provider, collectionOAuthBinding(row.config), { requirePersistedOAuth: true });
          // Read evidence is sufficient here. No write permission is inferred from it.
          grants = await deps.sources.savedGrantScopes?.(provider, collectionOAuthBinding(row.config)) ?? null;
        }
        const authenticated: HttpFetcher = async (url, init) => {
          await assertActive(); const response = await fetcher(url, init);
          if (response.status === 401 || response.status === 403) throw new RpcError('credential_verification_failed', 'Saved authentication could not read this collection.',
            422, 'collection.connection.managedOAuth', { verification_status: 'auth_failed' });
          return response;
        };
        const identity = await readCollectionIdentity(row, authenticated);
        const recorded = deps.db.prepare('SELECT created_at, binding_hash, identity_json FROM collection_authentication_identities WHERE platform = ? AND slug = ?')
          .get(platform, slug) as { created_at: number; binding_hash: string; identity_json: string } | undefined;
        if (recorded && recorded.created_at === row.created_at && recorded.binding_hash === bindingMaterial(row)
          && !matchingCollectionAccount(JSON.parse(recorded.identity_json) as ManagedOAuthAccountIdentity, identity)) throw changed();
        await verifyCollectionReads(row, authenticated, grants);
        await assertActive(); const control = await anonymous(collectionIdentityUrl(row), { method: 'GET' });
        if (control.status !== 401 && control.status !== 403) throw new RpcError('credential_verification_failed', 'This check did not prove protected account access.',
          422, 'collection.connection.managedOAuth', { verification_status: 'unknown' });
        await assertActive();
        return [{ kind: 'collection_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }];
      } };
  };
  return { prepareSavedAccess, async handle(request) {
    if (request.action === 'collection_authentication_candidates') {
      const row = lookup(request.platform, request.slug);
      return { action: request.action, sources: await deps.sources.candidates(collectionProvider(row)), provider: collectionProvider(row),
        permissions: collectionPermissionChoices(row, await collectionAbilities(row, enroll(row))),
        ...(collectionOAuthSourceName(row.config) ? { current_connection_name: collectionOAuthSourceName(row.config)! } : {}) };
    }
    if (request.action === 'collection_authentication_status') {
      if (!validNonce(request.attempt_id)) throw new RpcError('bad_request', 'A valid migration attempt is required.');
      const outcome = readAttempt(request.attempt_id)?.outcome ?? null;
      if (outcome?.status === 'applied' && outcome.restart_needed) {
        const row = deps.instances.get(outcome.platform, outcome.slug);
        const binding = row ? collectionOAuthBinding(row.config) as { connection_name?: string; type?: string } | undefined : undefined;
        if (row && binding?.connection_name === outcome.connection_name && (binding.type === 'direct_oauth' ? 'direct_oauth' : 'broker') === outcome.authentication
          && enroll(row).authenticationChange?.running?.(row.slug)) { delete outcome.restart_needed; saveOutcome(request.attempt_id, outcome); }
      }
      return { action: request.action, outcome };
    }
    if (request.action === 'collection_authentication_retire') {
      if (!validNonce(request.review_id)) throw new RpcError('bad_request', 'A valid review is required.');
      reviews.delete(request.review_id); return { action: request.action };
    }
    if (request.action === 'collection_authentication_review') {
      const row = lookup(request.platform, request.slug);
      if (request.intent !== undefined && request.intent !== 'permissions' || request.permissions !== undefined && request.intent !== 'permissions'
        || request.intent === 'permissions' && (!isCollectionPermissionChoices(request.permissions)
          || collectionOAuthSourceName(row.config) !== request.connection_name)) {
        throw new RpcError('bad_request', 'Review permission changes with the current saved API connection.');
      }
      const lifecycle = enroll(row).authenticationChange;
      if (!lifecycle) throw new RpcError('not_configured', 'Collection authentication migration is unavailable on this server.');
      if (typeof request.connection_name !== 'string' || !request.connection_name || request.connection_name.length > 200) throw new RpcError('bad_request', 'Choose a saved API connection.');
      for (const [id, r] of reviews) if (r.public.expires_at <= now()) reviews.delete(id);
      if (reviews.size >= 64) throw new RpcError('conflict', 'Close an existing authentication review before starting another.');
      const abilities = await collectionAbilities(row, enroll(row));
      const selectedAbilities = requestedCollectionAbilities(row, abilities, request.permissions);
      const current = await currentIdentity(row);
      const transport = await deps.sources.prepare(collectionProvider(row), request.connection_name, selectedAbilities.needs);
      const target = await readCollectionIdentity(row, transport.fetch);
      const publicReview: CollectionAuthenticationReview = { id: nonce(), fingerprint: '', expires_at: now() + 30 * 60_000,
        platform: row.platform as AuthenticationCollectionPlatform, slug: row.slug, provider: collectionProvider(row), source: transport.source,
        current, target, required_scopes: selectedAbilities.needs, ...(transport.grantedScopes ? { granted_scopes: transport.grantedScopes } : {}),
        ...(request.intent === 'permissions' ? { intent: request.intent,
          permissions: { current: collectionPermissionChoices(row, abilities), selected: collectionPermissionChoices(row, selectedAbilities) } } : {}),
        selections: collectionSelections(row), uses: [{ kind: row.platform as AuthenticationCollectionPlatform, id: row.slug, label: row.slug }],
        warnings: [request.intent === 'permissions' ? 'Only the reviewed Recued permission choices change. Collection name, selections, sync state and stored data are kept.'
          : 'The collection name, folder/calendar selection, sync cursors, stored data, and existing write choices are preserved.',
          'Read checks do not prove sending or editing. Write abilities require vendor-reported permission evidence.'] };
      publicReview.fingerprint = hash(publicReview);
      const review = { public: publicReview, row, transport, abilities, selectedAbilities };
      await verify(review); reviews.set(publicReview.id, review);
      return { action: request.action, review: publicReview };
    }
    if (request.action !== 'collection_authentication_apply') throw new RpcError('bad_request', 'Unknown collection authentication action.');
    if (!validNonce(request.attempt_id) || !validNonce(request.review_id) || !/^[a-f0-9]{64}$/.test(request.fingerprint)) throw new RpcError('bad_request', 'A valid reviewed migration is required.');
    const existing = readAttempt(request.attempt_id);
    if (existing) {
      if (existing.review_id !== request.review_id || existing.fingerprint !== request.fingerprint) throw changed();
      return { action: request.action, outcome: existing.outcome };
    }
    const review = reviews.get(request.review_id);
    if (!review || review.public.fingerprint !== request.fingerprint || review.public.expires_at <= now()) throw changed();
    const key = review.row.platform + ':' + review.row.slug;
    if (active.has(key)) throw new RpcError('conflict', 'An authentication migration for this collection is already in progress.');
    let outcome: CollectionAuthenticationOutcome = { attempt_id: request.attempt_id, platform: review.public.platform, slug: review.row.slug,
      status: 'checking', connection_name: review.public.source.name, authentication: review.public.source.authentication,
      ...(review.public.intent ? { intent: review.public.intent } : {}) };
    deps.db.transaction(() => {
      deps.db.prepare('INSERT INTO collection_authentication_attempts VALUES (?, ?, ?, ?)').run(request.attempt_id, request.review_id, request.fingerprint, JSON.stringify(outcome));
      const binding = collectionOAuthBinding(review.row.config);
      repairs.begin('collection_authentication', request.attempt_id, {
        action: review.public.intent === 'permissions' ? 'change_permissions' : 'switch_authentication',
        from: { type: binding === undefined || binding && typeof binding === 'object' && 'type' in binding && binding.type === 'direct_oauth' ? 'direct_oauth' : 'broker',
          ...(collectionOAuthSourceName(review.row.config) ? { connection_name: collectionOAuthSourceName(review.row.config) } : {}) },
        to: { type: review.public.source.authentication, connection_name: review.public.source.name, label: review.public.source.display_name },
        targets: [{ kind: 'collection', platform: review.public.platform, slug: review.row.slug }],
      }, now());
    })();
    active.add(key);
    const lifecycle = enroll(review.row).authenticationChange!; let stopped = false; let committed = false;
    try {
      await verify(review);
      stopped = true; await lifecycle.stop(review.row.slug);
      // A stopped adapter cannot advance a cursor while the final proof and swap run.
      await verify(review);
      if (!reviews.has(request.review_id) || review.public.expires_at <= now()) throw changed();
      deps.db.transaction(() => {
        const latest = assertRow(review); review.transport.beforeSwap();
        const config: Record<string, unknown> = { ...latest.config, oauth_connection: review.transport.binding,
          managed_send_enabled: review.selectedAbilities.send, managed_mutation_enabled: review.selectedAbilities.mutation,
          managed_write_enabled: review.selectedAbilities.write,
          ...(review.public.intent === 'permissions' ? { native_send_enabled: review.selectedAbilities.send,
            native_mutation_enabled: review.selectedAbilities.mutation, native_write_enabled: review.selectedAbilities.write } : {}) };
        delete config.managed_oauth;
        const updated = deps.instances.upsert({ platform: latest.platform, slug: latest.slug, adapter_type: latest.adapter_type,
          config, caps: review.public.intent === 'permissions' ? collectionPermissionCaps(latest, review.abilities, review.selectedAbilities) : latest.caps,
          auth_state: 'healthy', last_synced_at: latest.last_synced_at });
        deps.db.prepare('INSERT OR REPLACE INTO collection_authentication_identities VALUES (?, ?, ?, ?, ?)')
          .run(updated.platform, updated.slug, updated.created_at, bindingMaterial(updated), JSON.stringify(review.public.target));
        outcome = { ...outcome, status: 'applied', applied_at: now(), restart_needed: true };
        saveOutcome(request.attempt_id, outcome);
      })();
      committed = true;
      try { await lifecycle.restart(review.row.slug); delete outcome.restart_needed; saveOutcome(request.attempt_id, outcome); }
      catch { deps.instances.updateAuthState(review.row.platform, review.row.slug, { auth_state: 'degraded' }); }
    } catch (error) {
      if (committed) throw error;
      outcome = { ...outcome, status: 'failed', reason: error instanceof RpcError && error.code === 'conflict' ? 'changed' : 'access_failed' };
      delete outcome.restart_needed; delete outcome.applied_at;
      saveOutcome(request.attempt_id, outcome);
      if (stopped) { try { await lifecycle.restart(review.row.slug); } catch { /* The original config remains; health is reported by the adapter. */ } }
    } finally { reviews.delete(request.review_id); active.delete(key); }
    return { action: request.action, outcome };
  } };
};
