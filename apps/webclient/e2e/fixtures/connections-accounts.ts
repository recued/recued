import type { CollectionOAuthAppContext, CollectionOAuthAppSwitchRequest, SavedOAuthApp } from '@recued/contracts';

interface AccountsControls {
  requests: Array<{ method: string; action?: unknown; attemptId?: unknown }>;
  appId: string;
  hold(): void;
  fail(): void;
  release(): void;
  popupUrl(): string;
  finishOAuth(): void;
}

declare global {
  interface Window { __connectionsAccounts: AccountsControls }
}

/** Extend the local Connections fixture after boot. All accounts and replies are synthetic. */
export const installConnectionsAccountsFixture = ({ relayKind }: { relayKind: string }): void => {
  const hook = window as Window & {
    __connectionsFixture: (method: string, args: unknown) => Promise<{
      result?: unknown; error?: { code: string; message: string };
    } | undefined>;
  };
  const base = hook.__connectionsFixture;
  const oldApp: SavedOAuthApp = { id: 'default', issuer: 'google', label: 'Personal Google app', client_id: 'GOOGLE-CID', has_secret: true, revision: 1 };
  const app: SavedOAuthApp = { ...oldApp, id: 'app-' + '1'.repeat(32), label: 'Work Google app', client_id: 'WORK-GOOGLE-CID' };
  let row = { kind: 'api', name: 'rotation-key', display_name: 'Reporting API key', auth_type: 'bearer', base_url: 'https://api.example.test', updated_at: 7, health: { status: 'unknown' } };
  let held = false, failed = false, started = 0, switched = false;
  let release: (() => void) | undefined;
  let popup: { closed: boolean; location: { href: string }; focus(): void; close(): void; document: { write(): void; close(): void } } | undefined;
  const contexts = new Map<string, CollectionOAuthAppContext>();
  const authorizations = new Map<string, CollectionOAuthAppContext>();
  const reviews = new Map<string, CollectionOAuthAppContext>();
  const outcomes = new Map<string, object>();
  const wait = async () => { if (held) await new Promise<void>(done => { release = done; }); };
  window.__connectionsAccounts = {
    requests: [], appId: app.id,
    hold: () => { held = true; }, fail: () => { failed = true; },
    release: () => { held = false; release?.(); release = undefined; },
    popupUrl: () => popup?.location.href ?? '',
    finishOAuth: () => {
      if (!popup) throw new Error('No fixture sign-in is open');
      const url = new URL(popup.location.href), callback = new URL(url.searchParams.get('redirect_uri')!);
      window.dispatchEvent(new MessageEvent('message', { origin: callback.origin,
        data: { kind: relayKind, state: url.searchParams.get('state'), code: 'fixture-code' } }));
    },
  };
  // Exercise the real opener relay with its minted state and callback origin.
  window.open = (() => {
    popup = { closed: false, location: { href: '' }, focus() {}, close() { this.closed = true; }, document: { write() {}, close() {} } };
    return popup;
  }) as typeof window.open;
  hook.__connectionsFixture = async (method, input) => {
    const args = (input ?? {}) as Record<string, unknown>;
    window.__connectionsAccounts.requests.push({ method, action: args.action, attemptId: args.attempt_id });
    if (method === 'collection.connection.list') {
      const reply = await base(method, input);
      const result = (reply?.result ?? {}) as { connections?: Array<{ name: string }> };
      return { ...reply, result: { ...result,
        connections: [...(result.connections ?? []).filter(item => item.name !== row.name), { ...row }] } };
    }
    if (method === 'collection.calendar.list') {
      const reply = await base(method, input);
      const result = (reply?.result ?? {}) as { instances?: unknown[] };
      return { ...reply, result: { ...result, instances: [...(result.instances ?? []),
        { platform: 'calendar', slug: 'work', adapter_type: 'gcal', auth_state: 'healthy', account_email: 'person@example.test', last_synced_at: 1_700_000_000_000, caps: {} }] } };
    }
    if (method === 'collection.connection.credentialRotationActivity') return { result: { activity: started && held ? { status: 'pending', started_at: started } : { status: 'idle' } } };
    if (method === 'collection.connection.credentialRotationStatus') return { result: { outcome: !started ? { status: 'not_found' }
      : held ? { status: 'pending', started_at: started }
      : failed ? { status: 'failed', started_at: started, finished_at: Date.now(), reason: 'auth_failed' }
      : { status: 'succeeded', started_at: started, verification: { status: 'verified', verified_at: Date.now(), auth_type: 'bearer' } } } };
    if (method === 'collection.connection.rotateCredentials') {
      started = Date.now(); await wait();
      if (failed) return { error: { code: 'auth_failed', message: 'The new fixture key was refused. Saved credentials were kept.' } };
      row = { ...row, updated_at: row.updated_at + 1 };
      return { result: { connection: { ...row }, verification: { status: 'verified', verified_at: Date.now(), auth_type: 'bearer' } } };
    }
    if (method === 'collection.connection.managedOAuth') {
      const request = input as CollectionOAuthAppSwitchRequest;
      if (request.action === 'collection_authentication_app_context') {
        const context: CollectionOAuthAppContext = { intent: request.intent, id: (request.platform === 'mail' ? 'm' : 'k').repeat(43),
          fingerprint: 'f'.repeat(64), expires_at: Date.now() + 600_000, platform: request.platform, slug: request.slug, issuer: 'google',
          current_app: switched ? app : oldApp, apps: [oldApp, app],
          collections: [
            { platform: 'mail', slug: 'work', provider: 'gmail', current: { status: 'known', account_id: 'fixture-google-account', email: 'person@example.test' }, required_scopes: ['https://www.googleapis.com/auth/gmail.readonly'], selections: ['INBOX'] },
            { platform: 'calendar', slug: 'work', provider: 'gcal', current: { status: 'known', account_id: 'fixture-google-account', email: 'person@example.test' }, required_scopes: ['https://www.googleapis.com/auth/calendar.readonly'], selections: ['Team calendar'] },
          ], requested_scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'], retained_scopes: [], added_scopes: [] };
        contexts.set(context.id, context);
        return { result: { action: request.action, context } };
      }
      if (request.action === 'collection_authentication_app_authorize') {
        const context = contexts.get(request.context_id)!;
        const authorization = { id: (context.platform === 'mail' ? 'i' : 'j').repeat(43), context_id: context.id, issuer: 'google', app,
          requested_scopes: context.requested_scopes, expires_at: context.expires_at };
        authorizations.set(authorization.id, context);
        return { result: { action: request.action, authorization } };
      }
      if (request.action === 'collection_authentication_app_review') {
        const context = authorizations.get(request.authorization_id)!;
        const id = (context.platform === 'mail' ? 'r' : 's').repeat(43);
        reviews.set(id, context);
        return { result: { action: request.action, review: { id, fingerprint: 'e'.repeat(64), expires_at: Date.now() + 600_000,
          context, app, targets: context.collections.map(item => item.current), granted_scopes: context.requested_scopes } } };
      }
      if (request.action === 'collection_authentication_app_apply') {
        const context = reviews.get(request.review_id)!;
        const outcome = { attempt_id: request.attempt_id, platform: context.platform, slug: context.slug, status: 'applied', app_id: app.id,
          collections: context.collections.map(({ platform, slug }) => ({ platform, slug })) };
        await wait(); switched = true; outcomes.set(request.attempt_id, outcome);
        return { result: { action: request.action, outcome } };
      }
      if (request.action === 'collection_authentication_app_status') return { result: { action: request.action, outcome: outcomes.get(request.attempt_id) ?? null } };
      if (request.action === 'collection_authentication_app_retire') return { result: { action: request.action } };
    }
    return base(method, input);
  };
};
