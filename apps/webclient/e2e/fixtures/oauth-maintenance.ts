import type { OAuthAppRenewalReview, OAuthAppUsageReview, OAuthPermissionCleanupJob, OAuthPermissionInventory, SavedOAuthApp } from '@recued/contracts';

declare global {
  interface Window {
    __oauthMaintenance: {
      requests: string[];
      holdUsage(): void;
      releaseUsage(): void;
      mode(value: string): void;
    };
  }
}

/** Extend the full-app fixture after boot. No request reaches a real provider. */
export const installOAuthMaintenanceFixture = (): void => {
  const hook = window as Window & { __connectionsFixture: (method: string, args: unknown) => Promise<{
    result?: unknown; error?: { code: string; message: string };
  } | undefined> };
  const previous = hook.__connectionsFixture;
  const requests: string[] = [];
  let mode = '', held = false, release: (() => void) | undefined;
  const app: SavedOAuthApp = { id: 'default', issuer: 'google', label: 'Personal Google app', client_id: 'GOOGLE-CID', has_secret: true, revision: 1 };
  const mail = 'https://www.googleapis.com/auth/gmail.readonly', sheets = 'https://www.googleapis.com/auth/spreadsheets';
  const uses = [{ kind: 'pack' as const, id: 'reporting', label: 'Daily reporting for the operations team' }];
  const usage = (): OAuthAppUsageReview => ({ id: 'u'.repeat(43), fingerprint: 'a'.repeat(64), expires_at: Date.now() + 600_000,
    app, can_rotate: mode !== 'blocked', native_accounts: mode === 'empty' ? [] : [{ platform: 'mail', slug: 'work' }],
    unreadable_connections: mode === 'blocked' ? ['locked-api'] : [], warnings: [],
    connections: mode === 'empty' ? [] : ['reporting-north', 'reporting-south', 'legacy-reports'].map((name, i) => ({
      name, display_name: i === 0 ? 'Customer reporting for North America' : i === 1 ? 'Monthly reporting for the southern region' : 'Archived financial reports',
      origin: i === 2 ? 'unknown' : 'confirmed', secret_matches: i !== 2, client_id_matches: true,
      group_id: i === 2 ? name : 'shared-reporting', group_complete: true, selected_by_default: i !== 2, uses, usage_available: true,
    })) });
  const renewal = (): OAuthAppRenewalReview => ({ id: 'r'.repeat(43), fingerprint: 'b'.repeat(64), expires_at: Date.now() + 600_000, app, incomplete: false,
    grants: mode === 'empty' ? [] : [{ id: 'c'.repeat(64), revision: 'd'.repeat(64), label: 'Shared reporting authorization',
      connections: ['reporting-north', 'reporting-south'], native_accounts: [], eligible: true },
    { id: 'e'.repeat(64), revision: 'f'.repeat(64), label: 'Mail and Calendar', connections: [], native_accounts: [{ platform: 'mail', slug: 'work' }], eligible: true },
    { id: '1'.repeat(64), revision: '2'.repeat(64), label: 'Old reporting authorization', connections: ['legacy-reports'], native_accounts: [], eligible: false, reason: 'secret_mismatch' }] });
  const inventory = (filter?: OAuthPermissionInventory['filter']): OAuthPermissionInventory => ({ fingerprint: 'a'.repeat(64), observed_at: Date.now(),
    ...(filter ? { filter } : {}), unavailable: [], groups: mode === 'empty' ? [] : [{ id: 'b'.repeat(64), app_key: 'c'.repeat(64), app_label: app.label,
      issuer: 'google', authentication: 'direct_oauth', saved_app_id: app.id, client_id: app.client_id, account_label: 'person@example.test',
      connection_names: ['reporting-north'], api_resources: [{ name: 'reporting-north', base_url: 'https://sheets.googleapis.com' }],
      native_accounts: [{ platform: 'mail', slug: 'work' }], uses, requirements_complete: true, grants_known: true,
      required_scopes: [mail], warnings: [], scopes: [
        { scope: mail, status: 'required', evidence: 'recorded_grant', required_by: uses },
        { scope: sheets, status: 'unused_locally', evidence: 'recorded_grant', required_by: [] },
      ] }] });
  const cleanup = (): OAuthPermissionCleanupJob => ({ id: 'j'.repeat(43), revision: 1, issuer: 'google', mode: 'cleanup', app,
    status: mode === 'cleanup-reset' ? 'awaiting_reset' : mode === 'cleanup-ready' ? 'ready_to_apply' : 'prepared',
    targets: [{ platform: 'mail', slug: 'work', provider: 'gmail', account: { status: 'known', account_id: 'fixture-person', email: 'person@example.test' } }],
    selected_scopes: [sheets], requested_scopes: [mail], required_scopes: [mail], updated_at: Date.now(),
    reset_confirmation: mode === 'cleanup-ready' ? 'owner_confirmed' : 'not_confirmed',
    verification: mode === 'cleanup-ready' ? 'fresh_grant_checked' : 'not_checked',
    ...(mode === 'cleanup-ready' ? { granted_scopes: [mail], verified_targets: [{ platform: 'mail' as const, slug: 'work' }], review_expires_at: Date.now() + 600_000 } : {}),
  });
  window.__oauthMaintenance = { requests, holdUsage() { held = true; }, releaseUsage() { held = false; release?.(); release = undefined; }, mode(value) { mode = value; } };
  hook.__connectionsFixture = async (method, input) => {
    if (method !== 'server.oauthApps') return previous(method, input);
    const args = (input ?? {}) as Record<string, unknown>, action = String(args.action);
    requests.push(action);
    if (action === 'usage') {
      if (held) await new Promise<void>(done => { release = done; });
      if (mode === 'error') return { error: { code: 'UNAVAILABLE', message: 'Local app usage could not be read.' } };
      return { result: { action, apps: [app], usage: usage(), secret_expiry_supported: true } };
    }
    if (action === 'retire_usage' || action === 'renewal_retire') return { result: { action, apps: [app] } };
    if (action === 'renewal_preview') return { result: { action, apps: [app], renewal_review: renewal() } };
    if (action === 'permission_inventory') return { result: { action, apps: [app], permission_inventory: inventory(args.issuer ? { issuer: args.issuer as 'google', app_id: String(args.app_id) } : undefined),
      permission_cleanup_available: true, permission_cleanup_jobs: mode === 'empty' ? [] : [cleanup()] } };
    if (action === 'permission_cleanup_status') return { result: { action, apps: [app], permission_cleanup_job: cleanup() } };
    return previous(method, input);
  };
};
