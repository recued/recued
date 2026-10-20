/** Owner-triggered bounded checks. Receipts are separate from repair and sync outcomes. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, authenticationIncidentScope, managedOAuthVerificationUrl, isAuthenticationAccessRequest, isAuthenticationAccessCheck, isOAuthAppRenewalVerification,
  isAuthenticationAccessPreview, isAuthenticationAccessVerification, authenticationAccessRecheckResults,
  type AuthenticationAccessCheck, type AuthenticationAccessChoice, type AuthenticationAccessPreview, type AuthenticationAccessRequest,
  type AuthenticationAccessResponse, type AuthenticationAccessSelection, type AuthenticationAccessTarget, type AuthenticationAccessVerification,
  type AuthenticationRepairTarget, type AuthenticationRepairWorklist, type AuthenticationIncidentHistoryPage, type AuthenticationRepairAction, type AuthenticationRenewalHistory } from '@recued/contracts';
import { ensureAuthenticationHistorySchema } from './authentication-history-schema.js';
import { createAuthenticationIncidentStore } from './authentication-incident-store.js';
import { createAuthenticationAccessSummaries, createAuthenticationAccessComparison, type AuthenticationAccessComparison } from './authentication-access-summary.js';

export interface PreparedAuthenticationAccess {
  descriptor: Omit<AuthenticationAccessTarget, 'id' | 'target'>;
  /** Preparation and revision checks are local only. Network work starts here. */
  run(choice: AuthenticationAccessChoice | undefined, signal?: AbortSignal): Promise<AuthenticationAccessCheck[]>;
}
export interface AuthenticationAccessService {
  handle(request: AuthenticationAccessRequest): Promise<AuthenticationAccessResponse>;
  worklist(value: AuthenticationRepairWorklist): Promise<AuthenticationRepairWorklist>;
  history(value: AuthenticationIncidentHistoryPage): Promise<AuthenticationIncidentHistoryPage>;
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (target: AuthenticationRepairTarget): string => JSON.stringify(authenticationIncidentScope(target));
const selectionKey = (s: AuthenticationAccessSelection): string => JSON.stringify([s.kind, s.id]);
const unconfirmed = (kind: AuthenticationAccessCheck['kind'], reason: NonNullable<AuthenticationAccessCheck['reason']>): AuthenticationAccessCheck => ({ kind, status: 'unconfirmed', reason });
const changed = (): RpcError => new RpcError('conflict', 'The saved authentication or affected uses changed. Review Verify access again.');
const failure = (error: unknown, kind: AuthenticationAccessCheck['kind']): AuthenticationAccessCheck => {
  if (error instanceof RpcError && error.code === 'conflict') return unconfirmed(kind, 'changed');
  if (error instanceof RpcError && error.details?.verification_status === 'auth_failed') return { kind, status: 'failed', reason: 'access_rejected' };
  return unconfirmed(kind, error instanceof RpcError && error.code === 'credential_verification_failed' ? 'inconclusive' : 'unavailable');
};

export const createAuthenticationAccessVerification = (deps: {
  db: Database.Database; inventory(): Promise<AuthenticationRepairWorklist>;
  prepare(target: AuthenticationRepairTarget): Promise<PreparedAuthenticationAccess>;
  now?(): number;
}): AuthenticationAccessService => {
  const db = deps.db; const now = deps.now ?? Date.now;
  ensureAuthenticationHistorySchema(db);
  const historyStore = createAuthenticationIncidentStore(db);
  db.exec(`CREATE TABLE IF NOT EXISTS authentication_access_verifications (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL UNIQUE,
    selection_key TEXT NOT NULL, request_hash TEXT NOT NULL, data TEXT NOT NULL, finished_at INTEGER);
    CREATE INDEX IF NOT EXISTS idx_auth_access_selection ON authentication_access_verifications(selection_key, sequence);`);
  const summaries = createAuthenticationAccessSummaries({ db, prepare: deps.prepare, now });
  const save = db.transaction((v: AuthenticationAccessVerification): void => {
    if (!isAuthenticationAccessVerification(v)) throw new Error('Invalid authentication access receipt');
    db.prepare('UPDATE authentication_access_verifications SET data = ?, finished_at = ? WHERE id = ?').run(JSON.stringify(v), v.finished_at ?? null, v.id);
    db.prepare("UPDATE authentication_incident_history SET data = ?, ended_at = ? WHERE id = ? AND kind = 'verification'")
      .run(JSON.stringify(v), v.finished_at ?? null, v.id);
  });
  // Persist interruption and stop. No remote operation is resumed on boot.
  for (const row of db.prepare('SELECT data FROM authentication_access_verifications WHERE finished_at IS NULL').all() as { data: string }[]) {
    const v = JSON.parse(row.data) as AuthenticationAccessVerification;
    v.status = 'completed'; v.finished_at = Math.max(v.started_at, now());
    for (const result of v.results) result.checks = result.checks.map(c => c.reason === 'not_checked' ? unconfirmed(c.kind, 'interrupted') : c);
    save(v);
  }
  const prune = (): void => {
    db.prepare('DELETE FROM authentication_access_verifications WHERE finished_at < ?').run(now() - 90 * 86_400_000);
    db.exec(`DELETE FROM authentication_access_verifications WHERE sequence IN (SELECT sequence FROM authentication_access_verifications
      WHERE finished_at IS NOT NULL ORDER BY sequence DESC LIMIT -1 OFFSET 10000)`);
    summaries.prune();
    historyStore.prune(now());
  };
  const reviews = new Map<string, { public: AuthenticationAccessPreview; membership: string }>();
  let previewing = 0;
  const running = new Map<string, Promise<void>>();
  const select = async (selection: AuthenticationAccessSelection) => {
    const inventory = await deps.inventory();
    let targets: AuthenticationRepairTarget[]; let label: string; let incomplete = false; let source: string | undefined;
    if (selection.kind === 'group') {
      const group = inventory.groups.find(g => g.id === selection.id); if (!group) throw changed();
      targets = group.targets; label = group.label;
    } else if (selection.kind === 'verification') {
      const row = db.prepare<[string, number], { data: string }>("SELECT data FROM authentication_incident_history WHERE kind = 'verification' AND id = ? AND ended_at >= ?")
        .get(selection.id, now() - 90 * 86_400_000);
      if (!row) throw new RpcError('not_found', 'This access result is no longer available. Open Authentication repairs to review the saved accounts.');
      const verification: unknown = JSON.parse(row.data);
      if (!isAuthenticationAccessVerification(verification) || verification.id !== selection.id || verification.status !== 'completed') {
        throw new RpcError('bad_request', 'Wait for a valid access result before reviewing rechecks.');
      }
      targets = authenticationAccessRecheckResults(verification).map(r => r.target);
      if (!targets.length) throw new RpcError('bad_request', 'This result has no failed or unconfirmed reads to recheck.');
      source = hash(row.data);
      incomplete = verification.targets_truncated;
      label = 'Failed or unconfirmed reads from the saved access result';
    } else if (selection.kind === 'renewal') {
      const row = db.prepare<[string, number], { data: string }>("SELECT data FROM authentication_incident_history WHERE kind = 'renewal' AND id = ? AND (ended_at IS NULL OR ended_at >= ?)")
        .get(selection.id, now() - 90 * 86_400_000);
      if (!row) throw new RpcError('not_found', 'This renewal result is no longer available. Open Authentication repairs to check the saved accounts.');
      const renewal = JSON.parse(row.data) as AuthenticationRenewalHistory;
      if (!isOAuthAppRenewalVerification(renewal) || renewal.status !== 'completed') throw new RpcError('bad_request', 'Wait for the saved renewal check to finish before reviewing access.');
      targets = (db.prepare<[string], { scope_key: string }>('SELECT scope_key FROM authentication_incident_targets WHERE incident_id = ? ORDER BY scope_key').all(selection.id))
        .map(t => JSON.parse(t.scope_key) as AuthenticationRepairTarget);
      // Retained references include connection-backed Mail/Calendar and file sources.
      // Older imported receipts can supply only their explicitly listed accounts.
      if (!targets.some(t => t.kind !== 'oauth_apps')) {
        targets = renewal.results.flatMap(r => [
          ...r.connections.map(name => ({ kind: 'connection' as const, name })),
          ...r.native_accounts.map(a => ({ kind: 'collection' as const, platform: a.platform, slug: a.slug })),
        ]);
        incomplete = true;
      }
      incomplete ||= renewal.incomplete || renewal.references_incomplete === true;
      label = 'Current saved authentication from ' + renewal.app_label + ' renewal review';
    } else {
      const row = db.prepare<[string, number], { data: string }>("SELECT data FROM authentication_incident_history WHERE kind = 'repair' AND id = ? AND ended_at >= ?")
        .get(selection.id, now() - 90 * 86_400_000);
      if (!row) throw new RpcError('not_found', 'This repair is no longer available. Open Authentication repairs to check the saved accounts.');
      const repair = JSON.parse(row.data) as AuthenticationRepairAction;
      if (repair.status !== 'applied') throw new RpcError('bad_request', 'Verify access after an applied authentication change.');
      targets = (db.prepare<[string], { scope_key: string }>('SELECT scope_key FROM authentication_incident_targets WHERE incident_id = ? ORDER BY scope_key').all(selection.id))
        .map(t => JSON.parse(t.scope_key) as AuthenticationRepairTarget);
      if (!targets.length) { targets = repair.targets; incomplete = repair.targets_truncated; }
      label = 'Saved authentication after repair';
    }
    targets = [...new Map(targets.map(t => [key(t), t])).values()];
    // App settings itself is navigation, not a remotely checkable account.
    if (targets.length > 1) targets = targets.filter(t => t.kind !== 'oauth_apps');
    const groups = inventory.groups.filter(g => (g.kind === 'account' || selection.kind === 'group' && g.id === selection.id)
      && g.targets.some(t => targets.some(candidate => key(t) === key(candidate))));
    const uses = [...new Map(groups.flatMap(g => g.uses).map(u => [JSON.stringify([u.kind, u.id]), u])).values()];
    const membership = hash([targets, groups.map(g => [g.id, g.targets, g.uses, g.usage_available]), inventory.unavailable, incomplete, source]);
    return { targets: targets.slice(0, 32), label, targets_truncated: incomplete || targets.length > 32, uses: uses.slice(0, 256),
      usage_available: !inventory.unavailable.length && uses.length <= 256 && groups.length > 0 && groups.every(g => g.usage_available), membership };
  };
  const project = async (value: AuthenticationAccessVerification, compare = createAuthenticationAccessComparison(deps.prepare)): Promise<AuthenticationAccessVerification> => {
    const result = structuredClone(value);
    for (const row of result.results) {
      delete row.file_connection;
      try { const descriptor = await compare(row.target); row.current = !descriptor ? 'unknown' : descriptor.authentication_revision === row.authentication_revision ? 'yes' : 'no';
        if (row.current === 'yes' && row.target.kind === 'file_source' && descriptor?.check === 'file_metadata' && descriptor.file_connection) {
          row.file_connection = { name: descriptor.file_connection.name, updated_at: descriptor.file_connection.updated_at };
        }
      }
      catch { row.current = 'unknown'; }
    }
    return result;
  };
  const decode = (row: { id: string; data: string }): AuthenticationAccessVerification | undefined => {
    try { const value: unknown = JSON.parse(row.data); if (isAuthenticationAccessVerification(value) && value.id === row.id) return value; }
    catch { /* A damaged receipt must not hide the rest of the local worklist. */ }
    return undefined;
  };
  const read = async (id: string): Promise<AuthenticationAccessVerification> => {
    const row = db.prepare<[string, number], { data: string }>('SELECT data FROM authentication_access_verifications WHERE id = ? AND (finished_at IS NULL OR finished_at >= ?)').get(id, now() - 90 * 86_400_000);
    if (!row) throw new RpcError('not_found', 'This access check is no longer retained. Start a new check.');
    const value = decode({ id, data: row.data });
    if (!value) throw new RpcError('not_configured', 'This saved access result could not be read. Refresh connection history.');
    return project(value);
  };
  const latest = async (selection: AuthenticationAccessSelection, compare: AuthenticationAccessComparison): Promise<AuthenticationAccessVerification | undefined> => {
    const row = db.prepare<[string, number], { id: string; data: string }>(`SELECT id, data FROM authentication_access_verifications WHERE selection_key = ?
      AND (finished_at IS NULL OR finished_at >= ?) ORDER BY sequence DESC LIMIT 1`).get(selectionKey(selection), now() - 90 * 86_400_000);
    const value = row && decode(row);
    return value && value.selection.kind === selection.kind && value.selection.id === selection.id ? project(value, compare) : undefined;
  };
  const active = async (selection: AuthenticationAccessSelection): Promise<AuthenticationAccessVerification | undefined> => {
    const row = db.prepare<[string], { data: string }>(`SELECT data FROM authentication_access_verifications WHERE selection_key = ?
      AND finished_at IS NULL ORDER BY sequence DESC LIMIT 1`).get(selectionKey(selection));
    return row ? project(JSON.parse(row.data) as AuthenticationAccessVerification) : undefined;
  };
  const resume = (selection: AuthenticationAccessSelection, running: AuthenticationAccessVerification): AuthenticationAccessPreview => {
    // Read the reserved job even if its source receipt or credentials are now
    // unavailable. No review is registered, so this status response cannot Run.
    const preview: AuthenticationAccessPreview = { id: randomBytes(32).toString('base64url'), fingerprint: '', expires_at: now() + 15 * 60_000,
      selection, label: 'Access checks already running', running, targets_truncated: running.targets_truncated, uses: running.uses,
      usage_available: running.usage_available, targets: running.results.map(r => ({ id: r.id, target: r.target, label: r.label,
        authentication_revision: r.authentication_revision, check: 'unsupported' })) };
    preview.fingerprint = hash(preview);
    if (!isAuthenticationAccessPreview(preview)) throw new RpcError('not_configured', 'This saved access result could not be read. Refresh connection history.');
    return preview;
  };
  const execute = async (v: AuthenticationAccessVerification, plan: AuthenticationAccessPreview, choices: AuthenticationAccessChoice[]): Promise<void> => {
    const deadline = Date.now() + 180_000;
    for (const result of v.results) {
      const kind = result.checks[0]!.kind;
      try {
        const prepared = await deps.prepare(result.target);
        if (prepared.descriptor.authentication_revision !== result.authentication_revision) { result.current = 'no'; result.checks = [unconfirmed(kind, 'changed')]; }
        else if (Date.now() >= deadline) result.checks = [unconfirmed(kind, 'unavailable')];
        else {
          let timeout: ReturnType<typeof setTimeout> | undefined; const controller = new AbortController();
          try {
            const checks = await Promise.race([prepared.run(choices.find(c => c.target_id === result.id), controller.signal), new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => { controller.abort(); reject(new Error('Access check deadline')); }, Math.min(65_000, deadline - Date.now()));
            })]);
            if (!checks.length || checks.length > 5 || !Array.from(checks).every(isAuthenticationAccessCheck)
              || new Set(checks.map(c => c.kind)).size !== checks.length) throw new Error('Invalid check result');
            result.checks = checks.map(c => ({ kind: c.kind, status: c.status, ...(c.reason ? { reason: c.reason } : {}) }));
          } finally { if (timeout !== undefined) clearTimeout(timeout); }
          // The result can only apply to the exact saved authentication checked.
          if ((await deps.prepare(result.target)).descriptor.authentication_revision !== result.authentication_revision) {
            result.current = 'no'; result.checks = result.checks.map(c => unconfirmed(c.kind, 'changed'));
          }
        }
      } catch (error) { result.checks = [failure(error, kind)]; }
      save(v);
    }
    v.status = 'completed'; v.finished_at = Math.max(v.started_at, now()); save(v); reviews.delete(plan.id); prune();
  };
  return {
    async handle(request) {
      if (!isAuthenticationAccessRequest(request)) throw new RpcError('bad_request', 'Choose a valid access check and review.');
      if (request.action === 'authentication_access_retire') { reviews.delete(request.review_id); return { action: request.action }; }
      if (request.action === 'authentication_access_status') return { action: request.action, verification: await read(request.id) };
      if (request.action === 'authentication_access_preview') {
        const selection: AuthenticationAccessSelection = { kind: request.selection.kind, id: request.selection.id };
        if (selection.kind === 'renewal' || selection.kind === 'verification') {
          const running = await active(selection); if (running) return { action: request.action, preview: resume(selection, running) };
        }
        for (const [id, review] of reviews) if (review.public.expires_at <= now()) reviews.delete(id);
        if (reviews.size + previewing >= 64) throw new RpcError('conflict', 'Too many access reviews are open. Close one or wait for it to expire.');
        previewing++;
        try {
          const selected = await select(selection); const targets: AuthenticationAccessTarget[] = [];
          for (const target of selected.targets) {
            const prepared = await deps.prepare(target); targets.push({ id: hash(key(target)), target, ...prepared.descriptor });
          }
          // Confirm membership again after asynchronous credential reads.
          if ((await select(selection)).membership !== selected.membership) throw changed();
          if (selection.kind === 'renewal' || selection.kind === 'verification') {
            const running = await active(selection); if (running) return { action: request.action, preview: resume(selection, running) };
          }
          const preview: AuthenticationAccessPreview = { id: randomBytes(32).toString('base64url'), fingerprint: '', expires_at: now() + 15 * 60_000,
            selection, label: selected.label, targets, targets_truncated: selected.targets_truncated,
            uses: selected.uses, usage_available: selected.usage_available };
          preview.fingerprint = hash(preview);
          if (!isAuthenticationAccessPreview(preview)) throw new RpcError('not_configured', 'This account does not have a verifiable access check.');
          reviews.set(preview.id, { public: preview, membership: selected.membership });
          return { action: request.action, preview };
        } finally { previewing--; }
      }
      const choices = request.choices.map(c => ({ target_id: c.target_id, ...(c.url !== undefined ? { url: c.url } : {}), ...(c.file_id !== undefined ? { file_id: c.file_id } : {}) }));
      const targetIds = request.target_ids?.slice();
      // Keep the original hash format for existing full-review retries.
      const requestHash = hash(targetIds === undefined ? [request.review_id, request.fingerprint, request.choices]
        : [request.review_id, request.fingerprint, choices, targetIds]);
      const attemptKey = hash(request.attempt_id);
      const existing = () => db.prepare<[string], { id: string; request_hash: string }>('SELECT id, request_hash FROM authentication_access_verifications WHERE attempt_id = ?').get(attemptKey)
        ?? db.prepare<[string], { id: string; request_hash: string }>('SELECT id, request_hash FROM authentication_access_verifications WHERE request_hash = ? ORDER BY sequence LIMIT 1').get(requestHash);
      const old = existing();
      if (old) { if (old.request_hash !== requestHash) throw changed(); return { action: request.action, verification: await read(old.id) }; }
      const review = reviews.get(request.review_id);
      if (!review || review.public.expires_at <= now() || review.public.fingerprint !== request.fingerprint) throw changed();
      const plan = review.public;
      if (plan.selection.kind === 'verification' && !targetIds
        || targetIds?.some(id => !plan.targets.some(t => t.id === id))) {
        throw new RpcError('bad_request', 'Select only the reviewed accounts to recheck.');
      }
      const targets = plan.targets.filter(t => targetIds === undefined || targetIds.includes(t.id));
      if (!targets.length) throw new RpcError('bad_request', 'Select at least one reviewed account to check.');
      if (choices.some(c => !targets.some(t => t.id === c.target_id && (!c.url || t.check === 'api_read') && (!c.file_id || t.check === 'file_metadata')))) {
        throw new RpcError('bad_request', 'Choose a resource only for its reviewed account.');
      }
      for (const choice of choices) if (choice.url?.trim()) {
        const target = plan.targets.find(t => t.id === choice.target_id)!;
        if (!target.base_url || !managedOAuthVerificationUrl(target.base_url, choice.url)) throw new RpcError('bad_request', 'Use a read-only resource URL within its saved vendor API.');
      }
      if ((await select(plan.selection)).membership !== review.membership) throw changed();
      for (const t of targets) if ((await deps.prepare(t.target)).descriptor.authentication_revision !== t.authentication_revision) throw changed();
      if ((plan.selection.kind === 'renewal' || plan.selection.kind === 'verification') && (await select(plan.selection)).membership !== review.membership) throw changed();
      // Recheck after awaits: concurrent starts must reserve at most one job.
      const raced = existing();
      if (raced) { if (raced.request_hash !== requestHash) throw changed(); return { action: request.action, verification: await read(raced.id) }; }
      if (reviews.get(request.review_id) !== review || plan.expires_at <= now()) throw changed();
      if (running.size >= 4) throw new RpcError('conflict', 'Access checks are already running. Wait for one to finish.');
      if (db.prepare('SELECT 1 FROM authentication_access_verifications WHERE selection_key = ? AND finished_at IS NULL').get(selectionKey(plan.selection))) {
        throw new RpcError('conflict', 'Access checks for this selection are already running. Refresh their saved status.');
      }
      const v: AuthenticationAccessVerification = { id: 'verify-' + randomUUID(), selection: plan.selection, status: 'checking', started_at: now(),
        results: targets.map(t => ({ id: t.id, target: t.target, label: t.label, authentication_revision: t.authentication_revision, current: 'yes',
          checks: [unconfirmed(t.check === 'unsupported' ? 'api_read' : t.check, 'not_checked')] })),
        targets_truncated: plan.targets_truncated, uses: plan.uses, usage_available: plan.usage_available };
      db.transaction(() => {
        db.prepare('INSERT INTO authentication_access_verifications (id, attempt_id, selection_key, request_hash, data) VALUES (?, ?, ?, ?, ?)')
          .run(v.id, attemptKey, selectionKey(plan.selection), requestHash, JSON.stringify(v));
        summaries.register(v);
        db.prepare("INSERT INTO authentication_incident_history (id, group_id, signature, data, kind) VALUES (?, ?, '', ?, 'verification')")
          .run(v.id, plan.selection.kind === 'group' ? plan.selection.id : 'access', JSON.stringify(v));
        for (const target of targets) db.prepare('INSERT INTO authentication_incident_targets (incident_id, scope_key) VALUES (?, ?)').run(v.id, key(target.target));
        if (plan.selection.kind === 'renewal' || plan.selection.kind === 'verification') {
          // Preserve the exact app/account groups in history after later auth changes.
          db.prepare(`INSERT OR IGNORE INTO authentication_history_groups (entry_id, group_id)
            SELECT ?, group_id FROM authentication_history_groups WHERE entry_id = ?`).run(v.id, plan.selection.id);
          db.prepare(`INSERT OR IGNORE INTO authentication_history_groups (entry_id, group_id)
            SELECT ?, group_id FROM authentication_incident_history WHERE id = ?`).run(v.id, plan.selection.id);
          if (plan.selection.kind === 'renewal' || db.prepare('SELECT 1 FROM authentication_incident_targets WHERE incident_id = ? AND scope_key = ?')
            .get(plan.selection.id, key({ kind: 'oauth_apps' }))) {
            db.prepare('INSERT OR IGNORE INTO authentication_incident_targets (incident_id, scope_key) VALUES (?, ?)')
              .run(v.id, key({ kind: 'oauth_apps' }));
          }
        }
        if (plan.selection.kind === 'repair' || plan.selection.kind === 'verification') db.prepare(`INSERT INTO authentication_repair_incidents (repair_id, incident_id, group_id)
          SELECT ?, incident_id, group_id FROM authentication_repair_incidents WHERE repair_id = ?`).run(v.id, plan.selection.id);
      })();
      reviews.delete(plan.id);
      const task = Promise.resolve().then(() => execute(v, plan, choices)).catch(() => {
        v.status = 'completed'; v.finished_at = Math.max(v.started_at, now());
        for (const row of v.results) row.checks = row.checks.map(c => c.reason === 'not_checked' ? unconfirmed(c.kind, 'unavailable') : c);
        save(v);
      }).finally(() => { running.delete(v.id); });
      // Keep a handled reference until all receipt writes finish.
      running.set(v.id, task); void task.catch(() => {});
      return { action: request.action, verification: structuredClone(v) };
    },
    async worklist(value) {
      const result = structuredClone(value);
      const compare = createAuthenticationAccessComparison(deps.prepare);
      const projected = await summaries.project(result.groups.map(g => ({ selection: { kind: 'group', id: g.id }, targets: g.targets })), compare);
      for (const [index, group] of result.groups.entries()) {
        group.access_summary = projected[index]!;
        delete group.access_verification;
        const v = await latest({ kind: 'group', id: group.id }, compare); if (v) group.access_verification = v;
      }
      return result;
    },
    async history(value) {
      const result = structuredClone(value);
      const repairs = result.repairs ?? [];
      const compare = createAuthenticationAccessComparison(deps.prepare);
      const projected = await summaries.project(repairs.map(r => ({ selection: { kind: 'repair', id: r.id }, targets: r.targets, targets_truncated: r.targets_truncated })), compare);
      for (const [index, repair] of repairs.entries()) {
        repair.access_summary = projected[index]!;
        delete repair.access_verification;
        const v = await latest({ kind: 'repair', id: repair.id }, compare); if (v) repair.access_verification = v;
      }
      if (result.verifications) result.verifications = await Promise.all(result.verifications.map(v => project(v, compare)));
      return result;
    },
  };
};
