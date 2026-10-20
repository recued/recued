import type {
  AuthenticationAccessChoice, AuthenticationAccessPreview, AuthenticationAccessRequest,
  AuthenticationAccessSelection, AuthenticationAccessTarget, AuthenticationAccessVerification,
  AuthenticationRepairGroup, AuthenticationRepairWorklist, ManagedOAuthRequest,
} from '@recued/contracts';

export const BULK_ACCESS_IDS = {
  google: 'a'.repeat(64), files: 'b'.repeat(64), app: 'c'.repeat(64),
  api: '1'.repeat(64), mail: '2'.repeat(64), file: '3'.repeat(64),
};
type Action = AuthenticationAccessRequest['action'] | 'authentication_worklist';
type ReplyAction = 'authentication_access_run' | 'authentication_access_status';
interface BulkAccessFixture {
  requests: AuthenticationAccessRequest[];
  hold(action: Action): void;
  release(action: Action): void;
  holdReply(action: ReplyAction): void;
  pendingReplies(action: ReplyAction): number;
  releaseReply(action: ReplyAction, index?: number): Promise<void>;
  startNextInBackground(): void;
  complete(id: string): void;
  seedMixedResults(): void;
  completeApiRead(): void;
  loseNextStartReply(): void;
  receipts(): AuthenticationAccessVerification[];
}
declare global { interface Window { __bulkAccessFixture: BulkAccessFixture } }

/** Serialized by addInitScript. All state and replies stay in the local harness. */
export const installBulkAccessFixture = (ids: typeof BULK_ACCESS_IDS): void => {
  const targets: AuthenticationAccessTarget[] = [
    { id: ids.api, target: { kind: 'connection', name: 'sheets-work' }, label: 'Work spreadsheets',
      authentication_revision: ids.google, check: 'api_read', base_url: 'https://sheets.googleapis.com/v4' },
    { id: ids.mail, target: { kind: 'collection', platform: 'mail', slug: 'work' }, label: 'Work mailbox',
      authentication_revision: ids.google, check: 'collection_read' },
    { id: ids.file, target: { kind: 'file_source', source_id: 'work.files' }, label: 'Work Drive',
      authentication_revision: ids.files, check: 'file_metadata', file_connection: { name: 'drive-work', updated_at: 7 } },
  ];
  const groups: AuthenticationRepairGroup[] = [
    { id: ids.google, kind: 'account', label: 'Work Google', authentication: 'direct_oauth', connection_names: ['sheets-work'],
      issues: [], uses: [], usage_available: true, targets: targets.slice(0, 2).map(t => t.target) },
    { id: ids.files, kind: 'account', label: 'Work Files', authentication: 'broker', connection_names: ['drive-work'],
      issues: [], uses: [], usage_available: true, targets: [targets[2]!.target] },
    { id: ids.app, kind: 'app', label: 'Saved OAuth app', authentication: 'direct_oauth', connection_names: [],
      issues: [], uses: [], usage_available: true, targets: [{ kind: 'oauth_apps' }] },
  ];
  const plans = new Map<string, AuthenticationAccessPreview>();
  const jobs = new Map<string, AuthenticationAccessVerification>();
  const attempts = new Map<string, string>();
  const completed = new Map<string, AuthenticationAccessVerification>();
  const held = new Set<Action>();
  const waiters = new Map<Action, Array<() => void>>();
  const heldReplies = new Set<ReplyAction>();
  const replyWaiters = new Map<ReplyAction, Array<() => void>>();
  let serial = 0; let loseReply = false; let background = false;
  const reply = async (action: ReplyAction, verification: AuthenticationAccessVerification) => {
    if (heldReplies.has(action)) await new Promise<void>(resolve => {
      const pending = replyWaiters.get(action) ?? []; pending.push(resolve); replyWaiters.set(action, pending);
    });
    return { result: { action, verification: structuredClone(verification) } };
  };
  const save = (selection: AuthenticationAccessSelection, selected: AuthenticationAccessTarget[], choices: AuthenticationAccessChoice[], apiPassed = selection.kind === 'verification') => {
    const started = 1_700_000_000_000 + ++serial * 1000;
    const job: AuthenticationAccessVerification = {
      id: 'verify-' + serial.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc',
      selection, status: 'completed', started_at: started, finished_at: started + 500,
      targets_truncated: false, uses: [], usage_available: true,
      results: selected.map(t => ({ id: t.id, target: t.target, label: t.label,
        authentication_revision: t.authentication_revision, current: 'yes', checks: [
          t.check === 'api_read'
            ? choices.some(c => c.target_id === t.id && c.url)
              ? apiPassed ? { kind: 'api_read', status: 'passed' } : { kind: 'api_read', status: 'failed', reason: 'access_rejected' }
              : { kind: 'api_read', status: 'unconfirmed', reason: 'resource_required' }
            : { kind: t.check === 'file_metadata' ? 'file_metadata' : 'collection_read', status: 'passed' },
          ...(t.check === 'file_metadata' ? [choices.some(c => c.target_id === t.id && c.file_id)
            ? { kind: 'file_download' as const, status: 'passed' as const }
            : { kind: 'file_download' as const, status: 'unconfirmed' as const, reason: 'resource_required' as const }] : []),
          { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' },
        ] })),
    };
    jobs.set(job.id, job); return structuredClone(job);
  };
  const worklist = (): AuthenticationRepairWorklist => ({ observed_at: Date.now(), unavailable: [], groups: groups.map(group => ({ ...group,
    access_summary: { selection: { kind: 'group', id: group.id }, observed_at: Date.now(), lookup_incomplete: false, targets_truncated: false,
      targets: targets.filter(t => group.targets.some(target => JSON.stringify(target) === JSON.stringify(t.target))).map(t => {
        const source = [...jobs.values()].reverse().find(job => job.results.some(r => r.id === t.id));
        const result = source?.results.find(r => r.id === t.id);
        if (t.target.kind === 'oauth_apps') throw Error('Unexpected OAuth app resource');
        return { id: t.id, target: t.target, label: t.label, state: source && result ? 'checked' : 'not_checked',
          ...(source && result ? { latest: { id: source.id, selection: source.selection, status: source.status,
            started_at: source.started_at, finished_at: source.finished_at, result } } : {}) };
      }) },
  })) });
  const fixture: BulkAccessFixture = {
    requests: [],
    hold: action => { held.add(action); },
    release: action => { held.delete(action); for (const resolve of waiters.get(action) ?? []) resolve(); waiters.delete(action); },
    holdReply: action => { heldReplies.add(action); },
    pendingReplies: action => replyWaiters.get(action)?.length ?? 0,
    releaseReply: async (action, index) => {
      const pending = replyWaiters.get(action) ?? [];
      const released = index === undefined ? pending.splice(0) : pending.splice(index, 1);
      if (index === undefined) heldReplies.delete(action);
      if (!pending.length) replyWaiters.delete(action);
      for (const resolve of released) resolve();
      // Let the transport and client consume the released replies before negative assertions.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    },
    startNextInBackground: () => { background = true; },
    complete: id => {
      const result = completed.get(id); if (!result) throw Error('No running fixture check ' + id);
      jobs.set(id, structuredClone(result)); completed.delete(id);
    },
    seedMixedResults: () => {
      save({ kind: 'group', id: ids.google }, targets.slice(0, 2), [{ target_id: ids.api, url: 'https://sheets.googleapis.com/v4/spreadsheets/earlier' }]);
      save({ kind: 'group', id: ids.files }, [targets[2]!], []);
    },
    completeApiRead: () => { save({ kind: 'group', id: ids.google }, [targets[0]!], [{ target_id: ids.api, url: 'https://sheets.googleapis.com/v4/spreadsheets/newer' }], true); },
    loseNextStartReply: () => { loseReply = true; },
    receipts: () => structuredClone([...jobs.values()]),
  };
  window.__bulkAccessFixture = fixture;
  Object.assign(window, { __connectionsFixture: async (method: string, input: unknown) => {
    if (method === 'packs.reconnect_later') return { result: { action: 'list', groups: [], unresolved_packs: [] } };
    if (method !== 'collection.connection.managedOAuth') return undefined;
    const args = input as ManagedOAuthRequest;
    if (args.action.startsWith('authentication_access_')) fixture.requests.push(structuredClone(args as AuthenticationAccessRequest));
    const action = args.action as Action;
    if (held.has(action)) {
      await new Promise<void>(resolve => { const pending = waiters.get(action) ?? []; pending.push(resolve); waiters.set(action, pending); });
    }
    if (args.action === 'authentication_worklist') return { result: { action: args.action, worklist: worklist() } };
    if (args.action === 'authentication_access_retire') return { result: { action: args.action } };
    if (args.action === 'authentication_access_preview') {
      const source = args.selection.kind === 'verification' ? jobs.get(args.selection.id) : undefined;
      const selected = source ? targets.filter(t => source.results.some(r => r.id === t.id && r.checks.some(c => c.kind !== 'write_permissions' && c.status !== 'passed')))
        : targets.filter(t => args.selection.id === ids.google ? t.id !== ids.file : t.id === ids.file);
      const preview: AuthenticationAccessPreview = { id: 'p'.repeat(40) + (plans.size + 1).toString().padStart(3, '0'),
        fingerprint: ids.google, expires_at: Date.now() + 600_000, selection: args.selection, label: 'Selected saved account',
        targets: selected, targets_truncated: false, uses: [], usage_available: true };
      plans.set(preview.id, preview); return { result: { action: args.action, preview } };
    }
    if (args.action === 'authentication_access_run') {
      const plan = plans.get(args.review_id)!;
      const savedId = attempts.get(args.attempt_id);
      const job = savedId ? structuredClone(jobs.get(savedId)!) : save(plan.selection, plan.targets.filter(t => args.target_ids?.includes(t.id)), args.choices);
      if (!savedId && background) {
        background = false; completed.set(job.id, structuredClone(job)); job.status = 'checking'; delete job.finished_at;
        for (const result of job.results) result.checks = result.checks.map(check => check.kind === 'write_permissions' ? check : { kind: check.kind, status: 'unconfirmed', reason: 'not_checked' });
        jobs.set(job.id, structuredClone(job));
      }
      attempts.set(args.attempt_id, job.id);
      if (loseReply) { loseReply = false; return { error: { code: 'UNAVAILABLE', message: 'The start reply was lost after saving the check.' } }; }
      return reply(args.action, job);
    }
    if (args.action === 'authentication_access_status') return reply(args.action, structuredClone(jobs.get(args.id)!));
    if (args.action === 'file_authentication_files') return { result: { action: args.action, choices: {
      source_id: 'work.files', connection_name: 'drive-work', updated_at: 7, available: true, max_bytes: 10485760,
      files: [{ remote_id: 'chosen-report', filename: 'Report.pdf', output_filename: 'Report.pdf', mode: 'download', mime_type: 'application/pdf' }],
    } } };
    return { error: { code: 'FIXTURE_MISSING_ACTION', message: 'Bulk access fixture needs action ' + args.action } };
  } });
};
