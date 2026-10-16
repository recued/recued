/** Installed only in the synthetic full-app harness. No external provider calls. */
export const installConnectionsUxFixture = () => {
  const googleApp = { id: 'default', issuer: 'google', label: 'Personal Google app', client_id: 'GOOGLE-CID', has_secret: true, revision: 1 };
  const workApp = { ...googleApp, id: 'app-' + '1'.repeat(32), label: 'Work Google app', client_id: 'WORK-GOOGLE-CID' };
  const microsoftApp = { ...googleApp, issuer: 'microsoft', label: 'Microsoft app', client_id: 'GRAPH-CID' };
  const apps = [googleApp, workApp, microsoftApp];
  const scope = 'https://www.googleapis.com/auth/gmail.readonly';
  const sheetsScope = 'https://www.googleapis.com/auth/spreadsheets';
  const localFiles = [{ platform: 'file', slug: 'documents', adapter_type: 'fs', auth_state: 'healthy', last_synced_at: 1_700_000_000_000, caps: {} }];
  let imapHealthy = false; let caldavHealthy = false;
  const apiRows: Array<Record<string, unknown>> = [
    { kind: 'api', name: 'sheets-work', display_name: 'Work spreadsheets', base_url: 'https://sheets.googleapis.com', vendor: 'google',
      auth_type: 'oauth2_refresh', updated_at: 1, granted_scopes: [sheetsScope], health: { status: 'unknown' } },
    { kind: 'api', name: 'gmail-broker', display_name: 'Gmail via Nango', base_url: 'https://gmail.googleapis.com', vendor: 'google',
      auth_type: 'managed_oauth', updated_at: 1, managed_oauth: { type: 'managed_oauth', broker: 'nango', broker_profile_id: 'nango-work', integration_id: 'google-mail',
        connection_id: 'existing-google-account', target_origin: 'https://gmail.googleapis.com', requested_scopes: [scope] } },
  ];
  Object.assign(window, { __connectionsFixture: async (method: string, input: unknown) => {
    const args = (input ?? {}) as Record<string, unknown>;
    if (method === 'collection.mail.list') return { result: { instances: [
      { platform: 'mail', slug: 'work', adapter_type: 'gmail', auth_state: 'healthy', last_synced_at: 1_700_000_000_000,
        account_email: 'person@example.test', send_capable: false },
      { platform: 'mail', slug: 'work-imap', adapter_type: 'imap', auth_state: imapHealthy ? 'healthy' : 'expired', last_synced_at: 1_700_000_000_000,
        account_email: 'owner@example.test', send_capable: true },
    ] } };
    if (method === 'collection.calendar.list') return { result: { instances: [
      { platform: 'calendar', slug: 'work-caldav', adapter_type: 'caldav', auth_state: caldavHealthy ? 'healthy' : 'expired', last_synced_at: 1_700_000_000_000, caps: {} },
    ] } };
    if (method === 'collection.mail.updateCredentials' || method === 'collection.calendar.updateCredentials') {
      if (args.password === 'invalid' || args.smtp_password === 'invalid') return { error: { code: 'access_failed', message: 'The replacement credentials could not verify account access. Saved credentials were kept.' } };
      if (method.includes('.mail.')) imapHealthy = true; else caldavHealthy = true;
      return { result: { ok: true, restart_needed: false } };
    }
    if (method === 'collection.listInstances') return new URLSearchParams(location.search).get('local_files') === 'failed'
      ? { error: { code: 'UNAVAILABLE', message: 'Local file inventory is unavailable.' } } : { result: { instances: localFiles } };
    if (method === 'data.file.attachments.sources') return { result: { sources: [
      { source_id: 'drive-work', provider: 'google', label: 'Work Drive', authentication_connection: 'drive-work', last_synced_at: 1_700_000_000_000, stale: false },
      { source_id: 'archive', provider: 's3', label: 'Archive bucket', authentication_connection: 's3-archive', last_synced_at: null, stale: true },
    ] } };
    if (method === 'server.getOAuthAppConfig') return { result: {
      google: { client_id: googleApp.client_id, has_secret: true, source: 'stored', apps: [googleApp, workApp] },
      microsoft: { client_id: microsoftApp.client_id, has_secret: true, source: 'stored', apps: [microsoftApp] },
    } };
    if (method === 'server.oauthApps') {
      if (args.action === 'list') return { result: { action: 'list', apps, secret_expiry_supported: true } };
      if (args.action === 'save') return { result: { action: 'save', apps: [...apps, { ...googleApp, id: 'app-' + '3'.repeat(32), label: args.label, client_id: args.client_id, issuer: args.issuer }], saved_id: 'app-' + '3'.repeat(32), secret_expiry_supported: true } };
    }
    if (method === 'collection.connection.list') return { result: { connections: apiRows } };
    if (method === 'collection.connection.enroll') {
      const config = (args.config ?? {}) as Record<string, unknown>; const auth = (args.auth ?? {}) as Record<string, unknown>;
      const row = { kind: args.kind, name: args.name, display_name: args.display_name, base_url: config.base_url,
        auth_type: auth.type, updated_at: 1, health: { status: 'unknown' } };
      apiRows.push(row); return { result: { connection: row } };
    }
    if (method === 'collection.connection.probe') return { result: { health: { status: 'unknown', last_error: 'http_status_500', last_probed_at: Date.now() } } };
    if (method === 'packs.list') return { result: { packs: [] } };
    if (method === 'packs.reconnect_later') return { result: { action: 'list', groups: [], unresolved_packs: [] } };
    if (method === 'collection.connection.managedOAuth') {
      if (args.action === 'authentication_worklist') return { result: { action: args.action, worklist: { observed_at: Date.now(),
        groups: [{ platform: 'mail', slug: 'work-imap', healthy: imapHealthy }, { platform: 'calendar', slug: 'work-caldav', healthy: caldavHealthy }]
          .filter(row => !row.healthy).map(row => ({ id: (row.platform === 'mail' ? '1' : '2').repeat(64), kind: 'account', label: row.slug, authentication: 'other', connection_names: [],
            issues: [{ id: (row.platform === 'mail' ? '3' : '4').repeat(64), code: 'credential_rejected', message: 'The saved login needs attention.' }], uses: [], usage_available: true,
            targets: [{ kind: 'collection', platform: row.platform, slug: row.slug }] })), unavailable: [] } } };
      if (args.action === 'profiles') return { result: { action: args.action, profiles: [{ id: 'nango-work', label: 'Nango work', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1 }] } };
      if (args.action === 'integrations') return { result: { action: args.action, integrations: [{ id: 'google-mail', label: 'Google Mail', provider: 'google-mail', default_scopes: [scope], scope_metadata: 'available' }] } };
      if (args.action === 'remote_connections') return { result: { action: args.action, connections: [{ id: 'existing-google-account', label: 'Existing Google account', auth_error: false }], page: 0, has_more: false } };
      if (args.action === 'preview') return { result: { action: args.action, preview: { fingerprint: 'b'.repeat(64), decision: 'authorize', scope_metadata: 'available',
        required_scopes: args.scopes ?? [], previous_scopes: [], requested_scopes: args.scopes ?? [], added_scopes: args.scopes ?? [], retained_scopes: [], sources: [], warnings: [] } } };
      if (args.action === 'account_usage') return { result: { action: args.action, usage: { connection_id: args.connection_id, auth_error: false, connections: [], warnings: [] } } };
      if (args.action === 'reauthorization_context') return { result: { action: args.action, name: args.name, updated_at: 1, auth_type: 'oauth2_refresh',
        client_id: googleApp.client_id, token_endpoint: 'https://oauth2.googleapis.com/token', required_scopes: [sheetsScope], saved_oauth_app: { issuer: 'google', id: 'default' } } };
      if (args.action === 'collection_authentication_app_context') return { result: { action: args.action, context: { intent: args.intent,
        id: 'c'.repeat(43), fingerprint: 'f'.repeat(64), expires_at: Date.now() + 600_000, platform: args.platform, slug: args.slug, issuer: 'google',
        current_app: googleApp, apps: [googleApp, workApp], collections: [{ platform: args.platform, slug: args.slug, provider: 'gmail', current: { status: 'known', account_id: 'fixture-google-account', email: 'person@example.test' },
          required_scopes: [scope], selections: ['INBOX'] }], requested_scopes: [scope, sheetsScope], retained_scopes: [sheetsScope], added_scopes: [] } } };
      return { error: { code: 'FIXTURE_MISSING_ACTION', message: 'Connections fixture needs action ' + String(args.action) } };
    }
    return undefined;
  } });
};
