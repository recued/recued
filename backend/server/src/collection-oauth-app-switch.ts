/** Native same-account OAuth-app replacement. Candidate grants never touch the
 * live token store until the reviewed, atomic apply. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL, RpcError,
  type CollectionOAuthAppContext, type CollectionOAuthAppAuthorization, type CollectionOAuthAppReview,
  type CollectionOAuthAppOutcome, type CollectionOAuthAppSwitchRequest, type CollectionOAuthAppSwitchResponse,
  isCollectionPermissionChoices, type ManagedOAuthAccountIdentity, type SavedOAuthApp } from '@recued/contracts';
import type { ServerAccountStore, AccountStoreWrite } from './account-store.js';
import type { OAuthAppConfigStore } from './oauth-app-config-store.js';
import type { CollectionInstanceRecord, CollectionInstanceStore } from './collections/instance-store.js';
import type { MailEnrollDeps } from './collections/mail/enroll.js';
import type { CalendarEnrollDeps } from './collections/calendar/enroll.js';
import { collectionProvider, collectionAbilities, collectionSelections, collectionScopesCover, collectionIdentityUrl,
  matchingCollectionAccount, readCollectionIdentity, verifyCollectionReads, collectionPermissionChoices, requestedCollectionAbilities,
  collectionPermissionCaps, type CollectionAbilities } from './collection-authentication-checks.js';
import { collectionOAuthBinding } from './collection-oauth-sources.js';
import { collectionAuthenticationLocks } from './collection-authentication-locks.js';
import { createAuthenticationRepairActionStore } from './authentication-repair-action-store.js';
import { defaultHttpFetcher, exchangeCodeForTokens, fetchGraphGrantIdentity, getAccessToken, keyPrefix, readOAuthAppId,
  type HttpFetcher, type OAuthProviderConfig } from './collections/mail/oauth.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonce = (): string => randomBytes(32).toString('base64url');
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const changed = (): RpcError => new RpcError('conflict', 'The account, OAuth app or permissions changed. Close this review and start again.');
const grantSlug = (row: CollectionInstanceRecord): string => typeof row.config.account_slug === 'string' ? row.config.account_slug : row.slug;
const rowKey = (row: { platform: string; slug: string }): string => row.platform + ':' + row.slug;
const material = (rows: readonly CollectionInstanceRecord[]): string => hash(rows.map(r => [r.platform, r.slug, r.created_at, r.adapter_type, r.config, r.caps]));
interface Context { public: CollectionOAuthAppContext; rows: CollectionInstanceRecord[]; abilities: CollectionAbilities[];
  selectedAbilities: CollectionAbilities[]; permissionsChanged: boolean;
  sourceGrant: string; sourceGenerations: Map<string, string | null> }
interface Authorization { public: CollectionOAuthAppAuthorization; context: Context; appSignature: string; consuming?: true }
interface Review { public: CollectionOAuthAppReview; authorization: Authorization; ciphertext: Buffer }
export interface CollectionOAuthAppSwitchService {
  handle(request: CollectionOAuthAppSwitchRequest): Promise<CollectionOAuthAppSwitchResponse>;
}

export const createCollectionOAuthAppSwitchService = (deps: {
  db: Database.Database; instances: CollectionInstanceStore; apps: OAuthAppConfigStore; accountStore: ServerAccountStore;
  mail: MailEnrollDeps; calendar: CalendarEnrollDeps; now?(): number; anonymous?: HttpFetcher;
}): CollectionOAuthAppSwitchService => {
  const now = deps.now ?? Date.now; const memoryKey = randomBytes(32);
  const repairs = createAuthenticationRepairActionStore(deps.db);
  const active = collectionAuthenticationLocks(deps.db);
  const contexts = new Map<string, Context>(); const authorizations = new Map<string, Authorization>(); const reviews = new Map<string, Review>();
  const expirationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let pending = 0;
  const seal = (values: Record<string, string | null>): Buffer => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', memoryKey, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  };
  const open = (ciphertext: Buffer): Record<string, string | null> => {
    const decipher = createDecipheriv('aes-256-gcm', memoryKey, ciphertext.subarray(0, 12));
    decipher.setAuthTag(ciphertext.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]).toString('utf8')) as Record<string, string | null>;
  };
  deps.db.exec('CREATE TABLE IF NOT EXISTS collection_oauth_app_switch_attempts (attempt_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, fingerprint TEXT NOT NULL, outcome_json TEXT NOT NULL)');
  // The same corpus identity used by authentication migration can survive an
  // expired grant. A missing or mismatched binding never supplies an identity.
  deps.db.exec(`CREATE TABLE IF NOT EXISTS collection_authentication_identities (
    platform TEXT NOT NULL, slug TEXT NOT NULL, created_at INTEGER NOT NULL, binding_hash TEXT NOT NULL,
    identity_json TEXT NOT NULL, PRIMARY KEY(platform, slug))`);
  const bindingMaterial = (row: CollectionInstanceRecord): string => hash([row.adapter_type, row.config.account_slug ?? row.slug,
    collectionOAuthBinding(row.config) ?? 'original_native']);
  const rememberIdentity = (row: CollectionInstanceRecord, identity: ManagedOAuthAccountIdentity): void => {
    deps.db.prepare('INSERT OR REPLACE INTO collection_authentication_identities VALUES (?, ?, ?, ?, ?)')
      .run(row.platform, row.slug, row.created_at, bindingMaterial(row), JSON.stringify(identity));
  };
  const pinnedIdentity = (row: CollectionInstanceRecord): ManagedOAuthAccountIdentity | undefined => {
    const saved = deps.db.prepare('SELECT * FROM collection_authentication_identities WHERE platform = ? AND slug = ?').get(row.platform, row.slug) as
      { created_at: number; binding_hash: string; identity_json: string } | undefined;
    if (!saved || saved.created_at !== row.created_at || saved.binding_hash !== bindingMaterial(row)) return undefined;
    const identity = JSON.parse(saved.identity_json) as ManagedOAuthAccountIdentity;
    return identity.status === 'known' && identity.account_id ? identity : undefined;
  };
  const sourceGrant = async (rows: readonly CollectionInstanceRecord[]): Promise<string> => hash(await Promise.all(rows.map(async row => {
    const prefix = keyPrefix(collectionProvider(row), grantSlug(row));
    return [prefix, await deps.accountStore.get(prefix + '.grant_generation'), await deps.accountStore.get(prefix + '.granted_scopes')];
  })));
  const readAttempt = (id: string) => deps.db.prepare<[string], { review_id: string; fingerprint: string; outcome_json: string }>(
    'SELECT review_id, fingerprint, outcome_json FROM collection_oauth_app_switch_attempts WHERE attempt_id = ?').get(id);
  const save = (outcome: CollectionOAuthAppOutcome): void => {
    deps.db.transaction(() => {
      deps.db.prepare('UPDATE collection_oauth_app_switch_attempts SET outcome_json = ? WHERE attempt_id = ?').run(JSON.stringify(outcome), outcome.attempt_id);
      if (outcome.status !== 'checking') repairs.finish('collection_oauth_app', outcome.attempt_id, outcome.status === 'applied'
        ? { status: 'applied', restart_required: !!outcome.restart_needed?.length }
        : { status: 'failed', reason: outcome.reason ?? 'server_error' }, now());
    })();
  };
  for (const row of deps.db.prepare<[], { outcome_json: string }>('SELECT outcome_json FROM collection_oauth_app_switch_attempts').all()) {
    const outcome = JSON.parse(row.outcome_json) as CollectionOAuthAppOutcome;
    if (outcome.status === 'checking') save({ ...outcome, status: 'failed', reason: 'interrupted' });
  }
  const lane = (row: CollectionInstanceRecord) => row.platform === 'mail' ? deps.mail : deps.calendar;
  const http = (row: CollectionInstanceRecord): HttpFetcher => lane(row).fetcher ?? defaultHttpFetcher;
  const group = (platform: unknown, slug: unknown): CollectionInstanceRecord[] => {
    if ((platform !== 'mail' && platform !== 'calendar') || typeof slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) throw new RpcError('bad_request', 'Choose an existing Mail or Calendar account.');
    const row = deps.instances.get(platform, slug); if (!row) throw changed();
    collectionProvider(row);
    if (collectionOAuthBinding(row.config) !== undefined) throw new RpcError('bad_request', 'Use Switch authentication for an account connected through Apps & APIs.');
    const rows = deps.instances.list().filter(r => (r.platform === 'mail' || r.platform === 'calendar')
      && r.adapter_type === row.adapter_type && collectionOAuthBinding(r.config) === undefined && grantSlug(r) === grantSlug(row));
    if (rows.length > 16) throw new RpcError('bad_request', 'Too many collections share this grant. Review their setup before switching.');
    rows.sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
    if (rows.some(r => (readOAuthAppId(r.config.oauth_app_id) ?? 'default') !== (readOAuthAppId(row.config.oauth_app_id) ?? 'default'))) throw changed();
    return rows;
  };
  const config = (row: CollectionInstanceRecord, app: SavedOAuthApp): OAuthProviderConfig => {
    const cfg = row.platform === 'mail' ? deps.mail.oauthConfig?.(collectionProvider(row) as 'gmail' | 'graph', app.id)
      : deps.calendar.oauthConfig?.(collectionProvider(row) as 'gcal' | 'graph', app.id);
    if (!cfg?.clientSecret || cfg.clientId !== app.client_id
      || cfg.tokenUrl !== (app.issuer === 'google' ? GOOGLE_TOKEN_URL : MICROSOFT_TOKEN_URL)) throw new RpcError('not_configured', 'The saved OAuth app is unavailable. Check its credentials in Apps & APIs.');
    return cfg;
  };
  const appSignature = (row: CollectionInstanceRecord, app: SavedOAuthApp): string => hash([app, config(row, app)]);
  const assertContext = (ctx: Context): void => {
    if (contexts.get(ctx.public.id) !== ctx || ctx.public.expires_at <= now()
      || material(group(ctx.public.platform, ctx.public.slug)) !== material(ctx.rows)
      || deps.apps.getApp(ctx.public.issuer, ctx.public.current_app.id)?.revision !== ctx.public.current_app.revision) throw changed();
  };
  const assertAuthorization = (auth: Authorization): void => {
    assertContext(auth.context);
    const app = deps.apps.getApp(auth.public.issuer, auth.public.app.id);
    if (auth.public.expires_at <= now() || !app || appSignature(auth.context.rows[0]!, app) !== auth.appSignature) throw changed();
  };
  const bearer = (row: CollectionInstanceRecord, token: string): HttpFetcher => (url, init) => http(row)(url, {
    ...init, headers: { ...init?.headers, Authorization: 'Bearer ' + token },
  });
  const currentIdentity = async (row: CollectionInstanceRecord, repair = false): Promise<ManagedOAuthAccountIdentity> => {
    const issuer = row.adapter_type === 'graph' ? 'microsoft' : 'google';
    const app = deps.apps.getApp(issuer, readOAuthAppId(row.config.oauth_app_id) ?? 'default');
    if (!app) throw changed();
    try {
      const access = await getAccessToken({ provider: collectionProvider(row), slug: grantSlug(row), providerConfig: config(row, app),
        accountStore: lane(row).accountStore, fetcher: http(row), now });
      const identity = await readCollectionIdentity(row, bearer(row, access));
      const pinned = pinnedIdentity(row);
      if (pinned && !matchingCollectionAccount(pinned, identity)) throw changed();
      rememberIdentity(row, identity); return identity;
    } catch (error) {
      const pinned = repair ? pinnedIdentity(row) : undefined;
      if (pinned) return pinned;
      throw error;
    }
  };
  const retire = (id: string): void => {
    const contextId = contexts.has(id) ? id : authorizations.get(id)?.context.public.id ?? reviews.get(id)?.authorization.context.public.id;
    if (!contextId) return;
    const timer = expirationTimers.get(contextId); if (timer) clearTimeout(timer); expirationTimers.delete(contextId);
    contexts.delete(contextId);
    for (const [key, value] of authorizations) if (value.context.public.id === contextId) authorizations.delete(key);
    for (const [key, value] of reviews) if (value.authorization.context.public.id === contextId) { value.ciphertext.fill(0); reviews.delete(key); }
  };
  const reserve = (): void => {
    for (const ctx of contexts.values()) if (ctx.public.expires_at <= now()) retire(ctx.public.id);
    if (contexts.size + pending >= 32) throw new RpcError('conflict', 'Close an existing OAuth app review before opening another.');
    pending++;
  };
  const verify = async (ctx: Context, auth: Authorization, values: Record<string, string | null>) => {
    assertAuthorization(auth);
    const repair = ctx.public.intent === 'reauthorize';
    if (repair && await sourceGrant(ctx.rows) !== ctx.sourceGrant) throw changed();
    const prefix = keyPrefix(collectionProvider(ctx.rows[0]!), grantSlug(ctx.rows[0]!));
    const token = values[prefix + '.access_token']; const expires = Number(values[prefix + '.expires_at']);
    const grants = (values[prefix + '.granted_scopes'] ?? '').split(/\s+/).filter(Boolean);
    if (!token || !Number.isFinite(expires) || expires - now() <= 30_000) throw changed();
    const targets: ManagedOAuthAccountIdentity[] = []; const sourceScopes = new Map<string, string | null>();
    for (const [i, row] of ctx.rows.entries()) {
      // Resolve the current identity first: renewal can update its scope evidence.
      // Current-app consent can invalidate the old remote token immediately.
      // Compare the candidate to the identity verified before consent, while
      // fencing replacement of that local grant. Never require the old token
      // to remain usable after the provider has issued its replacement.
      const current = repair ? ctx.public.collections[i]!.current : await currentIdentity(row);
      const scopeKey = keyPrefix(collectionProvider(row), grantSlug(row)) + '.granted_scopes';
      const sourceScope = await deps.accountStore.get(scopeKey);
      if (sourceScopes.has(scopeKey) && sourceScopes.get(scopeKey) !== sourceScope) throw changed();
      sourceScopes.set(scopeKey, sourceScope);
      const abilities = await collectionAbilities(row, lane(row));
      if (hash(abilities) !== hash(ctx.abilities[i]) || !collectionScopesCover(grants, ctx.selectedAbilities[i]!.needs)) throw new RpcError('bad_request',
        ctx.permissionsChanged ? 'The new sign-in must grant every permission needed by the selected collection features.'
          : 'The new sign-in must grant every permission needed by the existing collection.');
      if (repair && !collectionScopesCover(grants, ctx.public.requested_scopes.filter(scope => !['offline_access', 'openid', 'profile', 'email'].includes(scope)))) {
        throw new RpcError('bad_request', 'The vendor did not grant all reviewed permissions. The saved collection is unchanged.');
      }
      const fetcher = bearer(row, token); const target = await readCollectionIdentity(row, fetcher);
      if (!matchingCollectionAccount(ctx.public.collections[i]!.current, current) || !matchingCollectionAccount(current, target)) throw new RpcError('bad_request', 'The new sign-in belongs to a different or unconfirmed account. The saved collection is unchanged.');
      await verifyCollectionReads(row, fetcher, grants);
      const control = await (deps.anonymous ?? http(row))(collectionIdentityUrl(row), { method: 'GET' });
      if (control.status !== 401 && control.status !== 403) throw new RpcError('bad_request', 'The access check did not prove protected vendor access.');
      targets.push(target);
    }
    for (const [key, expected] of sourceScopes) if (await deps.accountStore.get(key) !== expected) throw changed();
    assertAuthorization(auth); return { targets, sourceScopes };
  };
  return { async handle(request) {
    if (request.action === 'collection_authentication_app_retire') { if (validId(request.id)) retire(request.id); return { action: request.action }; }
    if (request.action === 'collection_authentication_app_status') {
      if (!validId(request.attempt_id)) throw changed();
      const saved = readAttempt(request.attempt_id); const outcome = saved ? JSON.parse(saved.outcome_json) as CollectionOAuthAppOutcome : null;
      if (outcome?.status === 'applied' && outcome.restart_needed) {
        const remaining = outcome.restart_needed.filter(r => {
          const row = deps.instances.get(r.platform, r.slug);
          return !row || row.config.oauth_app_id !== outcome.app_id || !lane(row).authenticationChange?.running?.(r.slug);
        });
        if (!remaining.length) { delete outcome.restart_needed; save(outcome); }
      }
      return { action: request.action, outcome };
    }
    if (request.action === 'collection_authentication_app_context') {
      if (request.intent !== undefined && !['switch_app', 'reauthorize'].includes(request.intent)
        || request.scopes !== undefined && (request.intent !== 'reauthorize' || !Array.isArray(request.scopes) || request.scopes.length > 256
          || request.scopes.some(scope => typeof scope !== 'string' || !scope || scope.length > 4096 || /[\s\x00-\x1f\x7f,]/.test(scope)))) {
        throw new RpcError('bad_request', 'Choose a valid authentication action and permission list.');
      }
      if (request.permissions !== undefined && (request.intent !== 'reauthorize' || !Array.isArray(request.permissions)
        || request.permissions.length > 16 || !request.permissions.every(isCollectionPermissionChoices)
        || new Set(request.permissions.map(p => p.platform + ':' + p.slug)).size !== request.permissions.length)) {
        throw new RpcError('bad_request', 'Choose valid collection permissions before reviewing the current sign-in.');
      }
      if (!deps.accountStore.transactionalWrite) throw new RpcError('not_configured', 'Update the server to switch saved OAuth apps safely.');
      reserve();
      try {
        const rows = group(request.platform, request.slug); const first = rows[0]!;
        if (rows.some(row => !lane(row).authenticationChange)) throw new RpcError('not_configured', 'Account switching is unavailable on this server.');
        const issuer = first.adapter_type === 'graph' ? 'microsoft' : 'google';
        const app = deps.apps.getApp(issuer, readOAuthAppId(first.config.oauth_app_id) ?? 'default'); if (!app) throw changed();
        if (request.permissions?.some(choice => !rows.some(row => row.platform === choice.platform && row.slug === choice.slug))) {
          throw new RpcError('bad_request', 'Permissions can change only for the collections in this shared sign-in.');
        }
        const abilities: CollectionAbilities[] = []; const selectedAbilities: CollectionAbilities[] = [];
        const collections: CollectionOAuthAppContext['collections'][number][] = [];
        for (const row of rows) {
          const current = await currentIdentity(row, request.intent === 'reauthorize');
          const ability = await collectionAbilities(row, lane(row)); abilities.push(ability);
          const selected = requestedCollectionAbilities(row, ability, request.permissions?.find(p => p.platform === row.platform && p.slug === row.slug));
          selectedAbilities.push(selected);
          collections.push({ platform: row.platform as 'mail' | 'calendar', slug: row.slug, provider: collectionProvider(row),
            current, required_scopes: selected.needs, selections: collectionSelections(row), ...(request.intent === 'reauthorize'
              ? { permissions: { current: collectionPermissionChoices(row, ability), selected: collectionPermissionChoices(row, selected) } } : {}) });
        }
        const retainedScopes = request.intent === 'reauthorize' ? (await Promise.all(rows.map(row => deps.accountStore.get(
          keyPrefix(collectionProvider(row), grantSlug(row)) + '.granted_scopes')))).flatMap(value => (value ?? '').split(/\s+/).filter(Boolean)) : [];
        const scopes = [...new Set([...selectedAbilities.flatMap(a => a.needs), ...retainedScopes, ...request.scopes ?? [],
          ...(issuer === 'microsoft' ? ['offline_access', 'User.Read'] : [])])].sort();
        if (scopes.length > 256) throw new RpcError('bad_request', 'The combined permission list is too large.');
        const publicContext: CollectionOAuthAppContext = { id: nonce(), fingerprint: '', expires_at: now() + 10 * 60_000,
          ...(request.intent ? { intent: request.intent } : {}),
          platform: request.platform, slug: request.slug, issuer, current_app: app,
          apps: deps.apps.listApps(issuer).filter(a => a.has_secret), collections, requested_scopes: scopes,
          ...(request.intent === 'reauthorize' ? { retained_scopes: [...new Set(retainedScopes)].sort(),
            added_scopes: scopes.filter(scope => !collectionScopesCover(retainedScopes, [scope])) } : {}) };
        publicContext.fingerprint = hash(publicContext);
        const sourceGenerations = new Map<string, string | null>();
        for (const row of rows) {
          const key = keyPrefix(collectionProvider(row), grantSlug(row)) + '.grant_generation';
          sourceGenerations.set(key, await deps.accountStore.get(key));
        }
        const ctx = { public: publicContext, rows, abilities, selectedAbilities, permissionsChanged: request.permissions !== undefined,
          sourceGrant: await sourceGrant(rows), sourceGenerations }; contexts.set(publicContext.id, ctx);
        const timer = setTimeout(() => retire(publicContext.id), Math.max(1, publicContext.expires_at - now()));
        timer.unref(); expirationTimers.set(publicContext.id, timer);
        try { assertContext(ctx); } catch (error) { retire(publicContext.id); throw error; }
        return { action: request.action, context: structuredClone(publicContext) };
      } finally { pending--; }
    }
    if (request.action === 'collection_authentication_app_authorize') {
      const ctx = contexts.get(request.context_id); if (!ctx || request.fingerprint !== ctx.public.fingerprint) throw changed();
      assertContext(ctx);
      const app = deps.apps.getApp(ctx.public.issuer, request.app_id);
      if (!app?.has_secret || (ctx.public.intent === 'reauthorize' ? app.id !== ctx.public.current_app.id : app.id === ctx.public.current_app.id)
        || app.revision !== request.expected_revision) throw new RpcError('bad_request', 'Choose the reviewed OAuth app and refresh its settings if it changed.');
      for (const auth of authorizations.values()) if (auth.context === ctx) throw new RpcError('conflict', 'Finish or close the current sign-in before starting another.');
      const pub: CollectionOAuthAppAuthorization = { id: nonce(), context_id: ctx.public.id, expires_at: ctx.public.expires_at,
        issuer: ctx.public.issuer, app, requested_scopes: ctx.public.requested_scopes };
      authorizations.set(pub.id, { public: pub, context: ctx, appSignature: appSignature(ctx.rows[0]!, app) });
      return { action: request.action, authorization: structuredClone(pub) };
    }
    if (request.action === 'collection_authentication_app_review') {
      const auth = authorizations.get(request.authorization_id);
      if (!auth || auth.consuming) throw changed();
      assertAuthorization(auth);
      if (typeof request.code !== 'string' || !request.code || request.code.length > 16_384) throw new RpcError('bad_request', 'A fresh authorization code is required.');
      let redirect: URL; try { redirect = new URL(request.redirect_uri); } catch { throw new RpcError('bad_request', 'Choose a valid OAuth callback URL.'); }
      if (redirect.username || redirect.password || redirect.hash || redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname))) throw new RpcError('bad_request', 'Choose a secure OAuth callback URL.');
      auth.consuming = true;
      try {
        const row = auth.context.rows[0]!; const values: Record<string, string | null> = Object.create(null);
        await exchangeCodeForTokens({ provider: collectionProvider(row), slug: grantSlug(row), code: request.code, redirectUri: redirect.toString(),
          providerConfig: config(row, auth.public.app), fetcher: http(row), now,
          beforePersist: () => assertAuthorization(auth), accountStore: { get: async k => values[k] ?? null,
            set: async (k, v) => { values[k] = v; }, delete: async k => { delete values[k]; } } });
        const prefix = keyPrefix(collectionProvider(row), grantSlug(row));
        values[prefix + '.grant_generation'] = nonce();
        if (row.adapter_type === 'graph') {
          const identity = await fetchGraphGrantIdentity(values[prefix + '.access_token']!, http(row));
          values[prefix + '.grant_identity'] = identity ? JSON.stringify(identity) : null;
        }
        const { targets } = await verify(auth.context, auth, values);
        if (!authorizations.has(auth.public.id)) throw changed();
        const pub: CollectionOAuthAppReview = { id: nonce(), fingerprint: '', expires_at: Math.min(auth.public.expires_at, Number(values[prefix + '.expires_at']) - 30_000),
          context: auth.context.public, app: auth.public.app, targets, granted_scopes: (values[prefix + '.granted_scopes'] ?? '').split(/\s+/).filter(Boolean) };
        pub.fingerprint = hash(pub);
        reviews.set(pub.id, { public: pub, authorization: auth, ciphertext: seal(values) });
        return { action: request.action, review: structuredClone(pub) };
      } catch (error) { retire(auth.public.id); throw error; }
    }
    if (request.action !== 'collection_authentication_app_apply') throw new RpcError('bad_request', 'Choose a valid OAuth app switch action.');
    if (!validId(request.attempt_id)) throw changed();
    const saved = readAttempt(request.attempt_id);
    if (saved) {
      if (saved.review_id !== request.review_id || saved.fingerprint !== request.fingerprint) throw changed();
      return { action: request.action, outcome: JSON.parse(saved.outcome_json) as CollectionOAuthAppOutcome };
    }
    const review = reviews.get(request.review_id);
    if (!review || request.fingerprint !== review.public.fingerprint || review.public.expires_at <= now()) throw changed();
    const ctx = review.authorization.context; const keys = ctx.rows.map(rowKey);
    if (keys.some(key => active.has(key))) throw new RpcError('conflict', 'An authentication change is already in progress for this account.');
    let outcome: CollectionOAuthAppOutcome = { attempt_id: request.attempt_id, platform: ctx.public.platform, slug: ctx.public.slug,
      ...(ctx.public.intent ? { intent: ctx.public.intent } : {}),
      status: 'checking', app_id: review.public.app.id, collections: ctx.rows.map(row => ({ platform: row.platform as 'mail' | 'calendar', slug: row.slug })) };
    deps.db.transaction(() => {
      deps.db.prepare('INSERT INTO collection_oauth_app_switch_attempts VALUES (?, ?, ?, ?)').run(request.attempt_id, request.review_id, request.fingerprint, JSON.stringify(outcome));
      repairs.begin('collection_oauth_app', request.attempt_id, {
        action: ctx.public.intent === 'reauthorize' ? ctx.permissionsChanged ? 'change_permissions' : 'reauthorize' : 'switch_oauth_app',
        from: { type: 'direct_oauth', app_id: ctx.public.current_app.id, label: ctx.public.current_app.label },
        to: { type: 'direct_oauth', app_id: review.public.app.id, label: review.public.app.label },
        targets: outcome.collections.map(row => ({ kind: 'collection', platform: row.platform, slug: row.slug })),
      }, now());
    })();
    keys.forEach(key => active.add(key));
    const stopped: CollectionInstanceRecord[] = []; let committed = false;
    try {
      const values = open(review.ciphertext);
      await verify(ctx, review.authorization, values);
      for (const row of ctx.rows) { stopped.push(row); await lane(row).authenticationChange!.stop(row.slug); }
      const { sourceScopes } = await verify(ctx, review.authorization, values);
      if (!reviews.has(request.review_id) || review.public.expires_at <= now()) throw changed();
      const entries: AccountStoreWrite[] = Object.entries(values).map(([key, value]) => ({ key, value,
        ...(sourceScopes.has(key) ? { expected: sourceScopes.get(key) ?? null }
          : ctx.public.intent === 'reauthorize' && ctx.sourceGenerations.has(key) ? { expected: ctx.sourceGenerations.get(key) ?? null } : {}) }));
      deps.accountStore.transactionalWrite!(entries, () => {
        assertAuthorization(review.authorization);
        for (const [index, row] of ctx.rows.entries()) {
          const latest = deps.instances.get(row.platform, row.slug)!;
          const abilities = ctx.selectedAbilities[index]!;
          deps.instances.upsert({ platform: latest.platform, slug: latest.slug, adapter_type: latest.adapter_type,
            config: { ...latest.config, oauth_app_id: review.public.app.id,
              ...(row.platform === 'mail' ? { native_send_enabled: abilities.send, native_mutation_enabled: abilities.mutation }
                : { native_write_enabled: abilities.write }) },
            caps: ctx.permissionsChanged ? collectionPermissionCaps(latest, ctx.abilities[index]!, abilities) : latest.caps, auth_state: 'healthy', last_synced_at: latest.last_synced_at });
          rememberIdentity(latest, review.public.targets[index]!);
        }
        outcome = { ...outcome, status: 'applied', restart_needed: outcome.collections }; save(outcome);
      });
      committed = true;
      const remaining: { platform: 'mail' | 'calendar'; slug: string }[] = [];
      for (const row of stopped) {
        try { await lane(row).authenticationChange!.restart(row.slug); }
        catch { remaining.push({ platform: row.platform as 'mail' | 'calendar', slug: row.slug }); deps.instances.updateAuthState(row.platform, row.slug, { auth_state: 'degraded' }); }
      }
      if (remaining.length) outcome = { ...outcome, restart_needed: remaining }; else delete outcome.restart_needed;
      save(outcome);
    } catch (error) {
      if (committed) throw error;
      outcome = { ...outcome, status: 'failed', reason: error instanceof RpcError && error.code === 'conflict'
        || error instanceof Error && error.message === 'oauth_grant_changed' ? 'changed' : 'access_failed' };
      delete outcome.restart_needed; save(outcome);
      for (const row of stopped) { try { await lane(row).authenticationChange!.restart(row.slug); } catch { /* Original app remains selected. */ } }
    } finally { retire(ctx.public.id); keys.forEach(key => active.delete(key)); }
    return { action: request.action, outcome };
  } };
};
