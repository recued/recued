import type {
  AuthenticationAccessPreview, AuthenticationAccessVerification, AuthenticationRepairWorklist,
} from '@recued/contracts';

export const ACCESS_REPAIR_IDS = {
  group: 'a'.repeat(64), api: '1'.repeat(64), mail: '2'.repeat(64), calendar: '3'.repeat(64), file: '4'.repeat(64),
};
type StatusMode = 'current' | 'stale' | 'unavailable';
type RpcReply = { result?: unknown; error?: { code: string; message: string } } | undefined;
interface AccessRepairFixture {
  requests: Array<{ method: string; args: Record<string, unknown> }>;
  status(mode: StatusMode): void;
  holdStatus(): void;
  pendingStatus(): number;
  releaseStatus(): Promise<void>;
  nativeAccounts(): void;
  removeNativeAccount(platform: 'mail' | 'calendar'): void;
  receipt(): AuthenticationAccessVerification;
}
declare global { interface Window { __accessRepairFixture: AccessRepairFixture } }

/** Installed after the ordinary Connections fixture has booted, before routing. */
export const installAccessRepairFixture = (ids: typeof ACCESS_REPAIR_IDS): void => {
  const hook = window as Window & { __connectionsFixture?: (method: string, args: unknown) => Promise<RpcReply> };
  const base = hook.__connectionsFixture;
  if (!base) throw Error('Connections fixture must be installed first');
  let saved: AuthenticationAccessVerification = {
    id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'group', id: ids.group },
    status: 'completed', started_at: 1000, finished_at: 2000, targets_truncated: false, uses: [], usage_available: true,
    results: [
      { id: ids.api, target: { kind: 'connection', name: 'sheets-work' }, label: 'Work spreadsheets', authentication_revision: ids.group, current: 'yes',
        checks: [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }] },
      { id: ids.mail, target: { kind: 'collection', platform: 'mail', slug: 'work' }, label: 'Work Gmail', authentication_revision: ids.group, current: 'yes',
        checks: [{ kind: 'collection_read', status: 'failed', reason: 'access_rejected' }] },
      { id: ids.calendar, target: { kind: 'collection', platform: 'calendar', slug: 'work' }, label: 'Work Calendar', authentication_revision: ids.group, current: 'yes',
        checks: [{ kind: 'collection_read', status: 'failed', reason: 'access_rejected' }] },
      { id: ids.file, target: { kind: 'file_source', source_id: 'opaque-source/kept-separate' }, label: 'Work Drive', authentication_revision: ids.group, current: 'yes',
        file_connection: { name: 'old-drive', updated_at: 1 }, checks: [{ kind: 'file_metadata', status: 'failed', reason: 'access_rejected' }] },
    ],
  };
  let mode: StatusMode = 'current'; let held = false; const pending: Array<() => void> = [];
  let native = false; const removedNativeAccounts = new Set<string>();
  const fixture: AccessRepairFixture = {
    requests: [], status: value => { mode = value; }, holdStatus: () => { held = true; }, pendingStatus: () => pending.length,
    releaseStatus: async () => {
      held = false; for (const resolve of pending.splice(0)) resolve();
      // Drain transport/client continuations before asserting that navigation did not occur.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    },
    nativeAccounts: () => {
      native = true;
      saved.results = saved.results.filter(r => r.target.kind === 'collection').map(result => {
        if (result.target.kind !== 'collection') throw Error('Expected a collection');
        const mail = result.target.platform === 'mail';
        return { ...result, target: { ...result.target, slug: mail ? 'work-imap' : 'work-caldav' }, label: mail ? 'Work IMAP' : 'Work CalDAV',
          checks: [{ kind: 'collection_read', status: 'unconfirmed', reason: 'unsupported' }] };
      });
    },
    removeNativeAccount: platform => { removedNativeAccounts.add(platform); },
    receipt: () => structuredClone(saved),
  };
  window.__accessRepairFixture = fixture;
  const worklist = (): AuthenticationRepairWorklist => ({ observed_at: Date.now(), unavailable: [], groups: [{
    id: ids.group, kind: 'account', label: 'Work accounts', authentication: native ? 'other' : 'direct_oauth', connection_names: native ? [] : ['sheets-work', 'drive-work'],
    issues: [], uses: [], usage_available: true, targets: saved.results.map(r => r.target),
    access_summary: { selection: saved.selection, observed_at: Date.now(), targets_truncated: false, lookup_incomplete: false,
      targets: saved.results.map(result => {
        if (result.target.kind === 'oauth_apps') throw Error('Unexpected app target');
        return { id: result.id, target: result.target, label: result.label, state: 'checked', latest: {
          id: saved.id, selection: saved.selection, status: saved.status, started_at: saved.started_at, finished_at: saved.finished_at, result,
        } };
      }) },
  }] });
  hook.__connectionsFixture = async (method, input) => {
    const args = (input ?? {}) as Record<string, unknown>;
    fixture.requests.push({ method, args: structuredClone(args) });
    if (method === 'collection.mail.list' || method === 'collection.calendar.list') {
      const original = await base(method, input) as { result: { instances: Array<Record<string, unknown>> } };
      const platform = method === 'collection.mail.list' ? 'mail' : 'calendar';
      return { result: { instances: [
        ...original.result.instances.filter(row => !removedNativeAccounts.has(platform) || row.slug !== (platform === 'mail' ? 'work-imap' : 'work-caldav')),
        ...(platform === 'calendar' ? [{ platform: 'calendar', slug: 'work', adapter_type: 'gcal', auth_state: 'healthy', last_synced_at: 1000,
          account_email: 'calendar@example.test', write_enabled: false, caps: {} }] : []),
      ] } };
    }
    if (method === 'collection.connection.list') {
      const original = await base(method, input) as { result: { connections: Array<Record<string, unknown>> } };
      return { result: { connections: [...original.result.connections, {
        kind: 'api', name: 'drive-work', display_name: 'Work Drive', base_url: 'https://www.googleapis.com/drive/v3',
        vendor: 'google', auth_type: 'oauth2_refresh', updated_at: 7, granted_scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      }] } };
    }
    if (method !== 'collection.connection.managedOAuth') return base(method, input);
    if (args.action === 'authentication_worklist') return { result: { action: args.action, worklist: worklist() } };
    if (args.action === 'authentication_history') return { result: { action: args.action, history: {
      scope: args.scope, observed_at: Date.now(), incidents: [], repairs: [], verifications: [structuredClone(saved)],
      order: [saved.id], retention_days: 90,
    } } };
    if (args.action === 'authentication_access_status') {
      const value = structuredClone(saved); const currentMode = mode;
      const file = value.results.find(r => r.id === ids.file);
      if (file) file.file_connection = { name: 'drive-work', updated_at: 7 };
      if (currentMode === 'stale') for (const result of value.results) { result.current = 'no'; delete result.file_connection; }
      if (held) await new Promise<void>(resolve => pending.push(resolve));
      if (currentMode === 'unavailable') return { error: { code: 'UNAVAILABLE', message: 'private-token=fixture-status-error' } };
      return { result: { action: args.action, verification: value } };
    }
    if (args.action === 'authentication_access_preview') {
      const preview: AuthenticationAccessPreview = {
        id: 'p'.repeat(43), fingerprint: ids.group, expires_at: Date.now() + 600_000,
        selection: { kind: 'group', id: ids.group }, label: 'Work accounts', targets_truncated: false, usage_available: true, uses: [],
        targets: saved.results.map(r => ({ id: r.id, target: r.target, label: r.label, authentication_revision: r.authentication_revision,
          check: r.target.kind === 'connection' ? 'api_read' : r.target.kind === 'collection' ? 'collection_read' : 'file_metadata',
          ...(r.target.kind === 'connection' ? { base_url: 'https://sheets.googleapis.com/v4' } : {}),
          ...(r.target.kind === 'file_source' ? { file_connection: { name: 'drive-work', updated_at: 7 } } : {}),
        })),
      };
      return { result: { action: args.action, preview } };
    }
    if (args.action === 'authentication_access_run') {
      saved = { ...structuredClone(saved), id: 'verify-12345678-1234-4123-8123-123456789abd', started_at: 3000, finished_at: 4000 };
      return { result: { action: args.action, verification: structuredClone(saved) } };
    }
    if (args.action === 'authentication_access_retire') return { result: { action: args.action } };
    if (args.action === 'file_authentication_files') return { result: { action: args.action, choices: {
      source_id: 'opaque-source/kept-separate', connection_name: 'drive-work', updated_at: 7, available: true, max_bytes: 10485760,
      files: [{ remote_id: 'report', filename: 'Report.pdf', output_filename: 'Report.pdf', mime_type: 'application/pdf', mode: 'download' }],
    } } };
    if (args.action === 'collection_authentication_app_context' && args.platform === 'calendar') {
      const original = await base(method, input) as { result: { context: Record<string, unknown> } };
      const scope = 'https://www.googleapis.com/auth/calendar.readonly';
      return { result: { action: args.action, context: { ...original.result.context, collections: [{
        platform: 'calendar', slug: 'work', provider: 'gcal', current: { status: 'known', account_id: 'fixture-calendar', email: 'calendar@example.test' },
        required_scopes: [scope], selections: ['primary'],
      }], requested_scopes: [scope], retained_scopes: [], added_scopes: [] } } };
    }
    return base(method, input);
  };
};
