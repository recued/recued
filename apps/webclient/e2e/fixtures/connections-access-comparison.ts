import type {
  AuthenticationAccessPreview, AuthenticationAccessVerification, AuthenticationRepairWorklist, ManagedOAuthRequest,
} from '@recued/contracts';

export const ACCESS_COMPARISON_IDS = {
  group: 'a'.repeat(64), api: '1'.repeat(64), mail: '2'.repeat(64), file: '3'.repeat(64), omitted: '4'.repeat(64),
  original: 'verify-12345678-1234-4123-8123-123456789abc', recheck: 'verify-22345678-1234-4123-8123-123456789abc',
};
type ReplyAction = 'authentication_access_status' | 'authentication_access_run';
type StatusMode = 'current' | 'original_missing' | 'recheck_changed';
type RpcReply = { result?: unknown; error?: { code: string; message: string } } | undefined;
interface AccessComparisonFixture {
  requests: Array<{ method: string; args: Record<string, unknown> }>;
  latestOriginal(): void;
  status(mode: StatusMode): void;
  current(value: 'yes' | 'no' | 'unknown'): void;
  inconsistentAuthentication(): void;
  holdReply(action: ReplyAction): void;
  pendingReplies(action: ReplyAction): string[];
  releaseReplies(action: ReplyAction, id?: string): Promise<void>;
  receipts(): AuthenticationAccessVerification[];
}
declare global { interface Window { __accessComparisonFixture: AccessComparisonFixture } }

/** Installed after the ordinary Connections fixture boots. Receipts and reads stay local. */
export const installAccessComparisonFixture = (ids: typeof ACCESS_COMPARISON_IDS): void => {
  const hook = window as Window & { __connectionsFixture?: (method: string, args: unknown) => Promise<RpcReply> };
  const base = hook.__connectionsFixture;
  if (!base) throw Error('Connections fixture must be installed first');
  const original: AuthenticationAccessVerification = {
    id: ids.original, selection: { kind: 'group', id: ids.group }, status: 'completed',
    started_at: 1_700_000_000_000, finished_at: 1_700_000_001_000, targets_truncated: false, uses: [], usage_available: true,
    results: [
      { id: ids.api, target: { kind: 'connection', name: 'sheets-work' }, label: 'Work spreadsheets', authentication_revision: 'c'.repeat(64), current: 'no',
        checks: [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] },
      { id: ids.mail, target: { kind: 'collection', platform: 'mail', slug: 'work' }, label: 'Work mailbox', authentication_revision: 'c'.repeat(64), current: 'no',
        checks: [{ kind: 'collection_read', status: 'failed', reason: 'access_rejected' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] },
      { id: ids.file, target: { kind: 'file_source', source_id: 'work.files' }, label: 'Work Drive archive', authentication_revision: 'c'.repeat(64), current: 'no',
        checks: [{ kind: 'file_metadata', status: 'failed', reason: 'access_rejected' }, { kind: 'file_download', status: 'passed' }] },
      { id: ids.omitted, target: { kind: 'connection', name: 'other-account' }, label: 'Earlier passed account', authentication_revision: 'c'.repeat(64), current: 'no',
        checks: [{ kind: 'api_read', status: 'passed' }] },
    ],
  };
  const recheck: AuthenticationAccessVerification = {
    ...structuredClone(original), id: ids.recheck, selection: { kind: 'verification', id: ids.original },
    started_at: 1_700_000_002_000, finished_at: 1_700_000_003_000,
    results: original.results.slice(0, 3).map(r => ({ ...structuredClone(r), authentication_revision: 'd'.repeat(64), current: 'yes',
      ...(r.target.kind === 'file_source' ? { file_connection: { name: 'drive-work', updated_at: 7 } } : {}),
      checks: r.target.kind === 'file_source' ? [{ kind: 'file_metadata', status: 'unconfirmed', reason: 'unavailable' }]
        : [{ kind: r.target.kind === 'collection' ? 'collection_read' : 'api_read', status: 'passed' },
          { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }],
    })),
  };
  let latest = recheck; let mode: StatusMode = 'current';
  const held = new Set<ReplyAction>(); const pending: Array<{ action: ReplyAction; id: string; resolve(): void }> = [];
  const reply = async (action: ReplyAction, value: AuthenticationAccessVerification, failure?: string): Promise<RpcReply> => {
    const verification = structuredClone(value);
    if (held.has(action)) await new Promise<void>(resolve => { pending.push({ action, id: value.id, resolve }); });
    return failure ? { error: { code: 'NOT_FOUND', message: failure } } : { result: { action, verification } };
  };
  const fixture: AccessComparisonFixture = {
    requests: [], latestOriginal: () => { latest = original; }, status: value => { mode = value; },
    current: value => {
      for (const result of recheck.results) {
        result.current = value;
        if (result.target.kind === 'file_source' && value === 'yes') result.file_connection = { name: 'drive-work', updated_at: 7 };
        else delete result.file_connection;
      }
    },
    inconsistentAuthentication: () => { original.results[0]!.current = 'yes'; },
    holdReply: action => { held.add(action); },
    pendingReplies: action => pending.filter(p => p.action === action).map(p => p.id),
    releaseReplies: async (action, id) => {
      for (let n = pending.length - 1; n >= 0; n--) {
        const p = pending[n]!;
        if (p.action === action && (id === undefined || p.id === id)) { pending.splice(n, 1); p.resolve(); }
      }
      if (!pending.some(p => p.action === action)) held.delete(action);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    },
    receipts: () => structuredClone([original, recheck]),
  };
  window.__accessComparisonFixture = fixture;
  const worklist = (): AuthenticationRepairWorklist => ({ observed_at: Date.now(), unavailable: [], groups: [{
    id: ids.group, kind: 'account', label: 'Work accounts', authentication: 'direct_oauth', connection_names: ['sheets-work', 'drive-work'],
    issues: [], uses: [], usage_available: true, targets: latest.results.map(r => r.target),
    access_summary: { selection: { kind: 'group', id: ids.group }, observed_at: Date.now(), targets_truncated: false, lookup_incomplete: false,
      targets: latest.results.map(result => {
        if (result.target.kind === 'oauth_apps') throw Error('Expected a resource');
        return { id: result.id, target: result.target, label: result.label, state: 'checked', latest: {
          id: latest.id, selection: latest.selection, status: latest.status, started_at: latest.started_at, finished_at: latest.finished_at, result,
        } };
      }),
    },
  }] });
  hook.__connectionsFixture = async (method, input) => {
    fixture.requests.push({ method, args: structuredClone((input ?? {}) as Record<string, unknown>) });
    if (method !== 'collection.connection.managedOAuth') return base(method, input);
    const args = input as ManagedOAuthRequest;
    if (args.action === 'authentication_worklist') return { result: { action: args.action, worklist: worklist() } };
    if (args.action === 'authentication_history') return { result: { action: args.action, history: {
      scope: args.scope, observed_at: Date.now(), incidents: [], repairs: [], verifications: structuredClone([recheck, original]),
      order: [recheck.id, original.id], retention_days: 90,
    } } };
    if (args.action === 'authentication_access_status') {
      if (args.id !== original.id && args.id !== recheck.id) throw Error('Unknown comparison receipt');
      const value = structuredClone(args.id === original.id ? original : recheck);
      if (mode === 'recheck_changed' && args.id === recheck.id) value.results[0]!.authentication_revision = 'e'.repeat(64);
      return reply(args.action, value, mode === 'original_missing' && args.id === original.id ? 'fixture-secret-token: expired original receipt' : undefined);
    }
    if (args.action === 'authentication_access_preview') {
      if (args.selection.kind !== 'verification' || args.selection.id !== original.id) throw Error('Unexpected comparison review');
      const preview: AuthenticationAccessPreview = {
        id: 'p'.repeat(43), fingerprint: 'd'.repeat(64), expires_at: Date.now() + 600_000,
        selection: args.selection, label: 'Work accounts', targets_truncated: false, uses: [], usage_available: true,
        targets: recheck.results.map(r => ({ id: r.id, target: r.target, label: r.label, authentication_revision: r.authentication_revision,
          check: r.target.kind === 'connection' ? 'api_read' : r.target.kind === 'collection' ? 'collection_read' : 'file_metadata',
          ...(r.target.kind === 'connection' ? { base_url: 'https://sheets.googleapis.com/v4' } : {}),
          ...(r.target.kind === 'file_source' ? { file_connection: { name: 'drive-work', updated_at: 7 } } : {}),
        })),
      };
      return { result: { action: args.action, preview } };
    }
    if (args.action === 'authentication_access_run') return reply(args.action, recheck);
    if (args.action === 'authentication_access_retire') return { result: { action: args.action } };
    return base(method, input);
  };
};
