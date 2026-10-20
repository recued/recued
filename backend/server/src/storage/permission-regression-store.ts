import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, PERMISSION_REGRESSION_LIMITS as LIMIT, parsePermissionDocument, permissionBytes,
  type PermissionActivate, type PermissionActivation, type PermissionDocument, type PermissionDraft,
  type PermissionMutation, type PermissionPrepare, type PermissionQualification, type PermissionRestore,
  type PermissionReview, type PermissionSave, type PermissionTest, type PermissionWorkbenchView } from '@recued/contracts';
import type { PreapprovalCodec } from './preapproval-codec.js';
import type { PreapprovalDependency } from '../preapproval-model.js';
import type { PermissionRegressionHost } from '../permission-regression-host.js';
import { preapprovalHash as digest } from '../preapproval-invocations.js';

interface Row { contract_id: string; revision: number; encrypted: string; attempt_id: string; deletion: string }
interface Qualification extends PermissionQualification { actor: string; attempt: string; environment: string; dependencies: PreapprovalDependency[] }
interface Review extends PermissionReview { actor: string; receipt_id: string; revision: number }
interface Request { id: string; hash: string; actor: string; kind: 'save' | 'restore' | 'activate'; revision: number; target: number }
interface State { schema_version: 1; contract_id: string; revision: number; drafts: PermissionDraft[]; history: PermissionActivation[];
  requests: Request[]; qualification: Qualification | null; review: Review | null }
interface Snapshot { row: Row | undefined; state: State | null; context: ReturnType<PermissionRegressionHost['context']> }
const conflict = (detail = 'The saved tests, live grants or policy changed. Reload, test and review the draft again.'): never => {
  throw new RpcError('permission_regression_conflict', detail, 409);
};
/** Encrypted owner data and a same-realm atomic grant/history commit. */
export const createPermissionRegressionStore = (db: Database.Database, codec: PreapprovalCodec,
  host: PermissionRegressionHost, now: () => number = Date.now) => {
  if (!host.sharesRealm(db)) throw new Error('Permission activation and history require the same realm database.');
  db.exec(`CREATE TABLE IF NOT EXISTS permission_regression_tracks (
    contract_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, encrypted TEXT NOT NULL,
    attempt_id TEXT NOT NULL, deletion TEXT NOT NULL DEFAULT '');`);
  const row = (id: string): Row | undefined => db.prepare('SELECT * FROM permission_regression_tracks WHERE contract_id=?').get(id) as Row | undefined;
  const assertSnapshot = (snapshot: Snapshot, id: string, check: () => void, context = true) => {
    check(); codec.assertUnlocked();
    if (digest(row(id) ?? null) !== digest(snapshot.row ?? null)
      || context && host.context(id).live_digest !== snapshot.context.live_digest) conflict();
  };
  const load = async (id: string, check: () => void): Promise<Snapshot> => {
    check(); codec.assertUnlocked(); const saved = row(id), context = host.context(id);
    const snapshot: Snapshot = { row: saved, context, state: null };
    if (!saved?.encrypted) return snapshot;
    const value = await codec.open(saved.encrypted); assertSnapshot(snapshot, id, check);
    const state = value as State;
    if (!state || state.schema_version !== 1 || state.contract_id !== id || state.revision !== saved.revision
      || !Array.isArray(state.drafts) || !state.drafts.length || state.drafts.length > LIMIT.history
      || !Array.isArray(state.history) || !state.history.length || state.history.length > LIMIT.history
      || !Array.isArray(state.requests) || state.requests.length > LIMIT.history || permissionBytes(state) > LIMIT.state_bytes) conflict('The sealed permission history is invalid.');
    for (const draft of state.drafts) if (digest(parsePermissionDocument(draft.document)) !== draft.digest) conflict('A saved test version does not match its digest.');
    for (const activation of state.history) if (!Array.isArray(activation.grants) || digest(activation.grants) !== activation.digest) conflict('A permission history entry does not match its digest.');
    snapshot.state = state; return snapshot;
  };
  const supported = (snapshot: Snapshot) => { if (!snapshot.context.supported) throw new RpcError('permission_regression_unsupported', snapshot.context.reason!, 409); };
  const revision = (snapshot: Snapshot, expected: number, live?: string) => {
    if ((snapshot.row?.revision ?? 0) !== expected || live !== undefined && live !== snapshot.context.live_digest) conflict();
  };
  const qualificationValid = (snapshot: Snapshot, actor: string): boolean => {
    const state = snapshot.state, proof = state?.qualification, draft = state?.drafts.at(-1);
    if (!snapshot.context.supported || !proof || !draft || proof.actor !== actor || proof.attempt !== snapshot.row?.attempt_id || proof.expires_at <= now()
      || proof.draft_revision !== draft.revision || proof.candidate_digest !== draft.digest || draft.base_digest !== snapshot.context.live_digest
      || proof.comparison.failed !== 0 || proof.comparison.passed < 1) return false;
    try { db.transaction(() => host.assertDependencies(proof.dependencies)).immediate(); return true; } catch { return false; }
  };
  const view = (snapshot: Snapshot, id: string, actor: string): PermissionWorkbenchView => {
    const proof = qualificationValid(snapshot, actor) ? snapshot.state!.qualification : null;
    return { contract_id: id, ...snapshot.context, revision: snapshot.row?.revision ?? 0,
      draft: structuredClone(snapshot.state?.drafts.at(-1) ?? null),
      drafts: snapshot.state?.drafts.map(item => ({ revision: item.revision, title: item.document.title, created_at: item.created_at })) ?? [],
      history: structuredClone(snapshot.state?.history ?? []), qualification: proof ? {
        receipt_id: proof.receipt_id, draft_revision: proof.draft_revision, candidate_digest: proof.candidate_digest,
        expires_at: proof.expires_at, comparison: structuredClone(proof.comparison),
      } : null };
  };
  const seal = async (state: State) => {
    state.drafts = state.drafts.slice(-LIMIT.history); state.history = state.history.slice(-LIMIT.history); state.requests = state.requests.slice(-LIMIT.history);
    while (permissionBytes(state) > LIMIT.state_bytes && (state.drafts.length > 1 || state.history.length > 2 || state.requests.length > 1)) {
      if (state.drafts.length > 1) state.drafts.shift(); else if (state.history.length > 2) state.history.shift(); else state.requests.shift();
    }
    if (permissionBytes(state) > LIMIT.state_bytes) throw new RpcError('permission_regression_limit', 'Permission history is too large. Use smaller cases or delete an unused workbench.', 409);
    return codec.seal(state);
  };
  const persist = (snapshot: Snapshot, state: State, encrypted: string, check: () => void, context = true) => {
    assertSnapshot(snapshot, state.contract_id, check, context);
    if (!snapshot.state && (db.prepare("SELECT count(*) FROM permission_regression_tracks WHERE encrypted<>''").pluck().get() as number) >= LIMIT.tracks) throw new RpcError('permission_regression_limit', 'Keep at most 100 permission workbenches.', 409);
    const retained = db.prepare('SELECT coalesce(sum(length(CAST(encrypted AS BLOB))),0) FROM permission_regression_tracks WHERE contract_id<>?').pluck().get(state.contract_id) as number;
    if (retained + Buffer.byteLength(encrypted, 'utf8') > LIMIT.retained_bytes) throw new RpcError('permission_regression_limit', 'Saved permission history is full. Delete an unused workbench.', 409);
    db.prepare(`INSERT INTO permission_regression_tracks VALUES(?,?,?,?, '') ON CONFLICT(contract_id) DO UPDATE SET
      revision=excluded.revision,encrypted=excluded.encrypted,attempt_id=excluded.attempt_id,deletion=''`)
      .run(state.contract_id, state.revision, encrypted, snapshot.row?.attempt_id ?? '');
  };
  const updatedSnapshot = (state: State, encrypted: string): Snapshot => ({
    row: { contract_id: state.contract_id, revision: state.revision, encrypted, attempt_id: row(state.contract_id)?.attempt_id ?? '', deletion: '' },
    state, context: host.context(state.contract_id),
  });
  const replay = (snapshot: Snapshot, id: string, hash: string, actor: string): PermissionMutation | null => {
    const request = snapshot.state?.requests.find(item => item.id === id); if (!request) return null;
    if (request.hash !== hash || request.actor !== actor) conflict('This request id belongs to a different permission change or paired client.');
    const draft = request.kind === 'activate' ? undefined : snapshot.state!.drafts.find(item => item.revision === request.target);
    const activated = request.kind === 'activate' ? snapshot.state!.history.find(item => item.sequence === request.target) : undefined;
    if (!draft && !activated) conflict('That result is no longer retained. Reload the current workbench.');
    return { ...view(snapshot, snapshot.state!.contract_id, actor), mutation_revision: request.revision,
      ...(draft ? { saved_draft: structuredClone(draft) } : {}), ...(activated ? { activated: structuredClone(activated) } : {}) };
  };
  const requireDraft = (snapshot: Snapshot, input: PermissionTest): State => {
    supported(snapshot); revision(snapshot, input.expected_revision);
    const state = snapshot.state, draft = state?.drafts.at(-1);
    if (!state || !draft || draft.revision !== input.draft_revision || draft.base_digest !== snapshot.context.live_digest) conflict();
    return state!;
  };
  const assertProof = (snapshot: Snapshot, state: State, actor: string) => {
    if (!qualificationValid(snapshot, actor)) conflict('Run the current saved cases before reviewing this grant change.');
    const fresh = host.evaluate(state.contract_id, state.drafts.at(-1)!.document);
    if (fresh.environment !== state.qualification!.environment) conflict('Admission or impact changed after testing. Run the saved cases again.');
    host.assertDependencies(state.qualification!.dependencies);
  };
  return {
    codec,
    async read(id: string, actor: string, check: () => void, draftRevision?: number): Promise<PermissionWorkbenchView> {
      const snapshot = await load(id, check); assertSnapshot(snapshot, id, check);
      const selected = draftRevision === undefined ? undefined : snapshot.state?.drafts.find(item => item.revision === draftRevision);
      if (draftRevision !== undefined && !selected) conflict('That saved test version is no longer retained. Reload the latest tests.');
      return { ...view(snapshot, id, actor), ...(selected ? { selected_draft: structuredClone(selected) } : {}) };
    },
    async save(raw: PermissionSave | PermissionRestore, actor: string, check: () => void): Promise<PermissionMutation> {
      const input = structuredClone(raw), snapshot = await load(input.contract_id, check), kind = 'document' in input ? 'save' : 'restore';
      assertSnapshot(snapshot, input.contract_id, check);
      const hash = digest({ kind, ...input }), prior = replay(snapshot, input.request_id, hash, actor); if (prior) return prior;
      supported(snapshot); revision(snapshot, input.expected_revision, input.expected_live_digest);
      let document: PermissionDocument;
      if ('document' in input) document = parsePermissionDocument(input.document);
      else {
        const historical = snapshot.state?.history.find(item => item.sequence === input.sequence), previous = snapshot.state?.drafts.at(-1);
        if (!historical || !previous) conflict('That permission revision is no longer retained.');
        const before = new Map(snapshot.context.grants.map(item => [item.entry_key, item.granted])), after = new Map(historical!.grants.map(item => [item.entry_key, item.granted]));
        document = parsePermissionDocument({ ...previous!.document, title: 'Restore permission revision ' + input.sequence,
          changes: [...new Set([...before.keys(), ...after.keys()])].sort().filter(key => before.get(key) !== after.get(key))
            .map(key => ({ entry_key: key, granted: after.get(key) ?? null })) });
      }
      host.validateChanges(document.changes);
      if (!document.changes.some(change => (snapshot.context.grants.find(item => item.entry_key === change.entry_key)?.granted ?? null) !== change.granted)) {
        throw new RpcError('bad_request', 'Propose at least one change to the explicit grant rows.', 400);
      }
      const state: State = snapshot.state ?? { schema_version: 1, contract_id: input.contract_id, revision: snapshot.row?.revision ?? 0,
        drafts: [], history: [], requests: [], qualification: null, review: null };
      if (state.history.at(-1)?.digest !== digest(snapshot.context.grants)) state.history.push({ kind: 'observed', sequence: (state.history.at(-1)?.sequence ?? 0) + 1,
        created_at: now(), digest: digest(snapshot.context.grants), grants: structuredClone(snapshot.context.grants) });
      state.revision++; const draft: PermissionDraft = { revision: state.revision, digest: digest(document), base_digest: snapshot.context.live_digest, created_at: now(), document };
      state.drafts.push(draft); state.qualification = null; state.review = null;
      state.requests.push({ id: input.request_id, hash, actor, kind, revision: state.revision, target: draft.revision });
      const encrypted = await seal(state);
      db.transaction(() => { host.validateChanges(document.changes); persist(snapshot, state, encrypted, check); }).immediate();
      return { ...view(updatedSnapshot(state, encrypted), input.contract_id, actor), mutation_revision: state.revision, saved_draft: structuredClone(draft) };
    },
    async test(raw: PermissionTest, actor: string, check: () => void): Promise<PermissionWorkbenchView & { comparison: import('@recued/contracts').PermissionComparison }> {
      const input = structuredClone(raw), attempt = randomUUID();
      db.transaction(() => { check(); codec.assertUnlocked(); if (row(input.contract_id)?.revision !== input.expected_revision) conflict();
        db.prepare('UPDATE permission_regression_tracks SET attempt_id=? WHERE contract_id=?').run(attempt, input.contract_id); }).immediate();
      const snapshot = await load(input.contract_id, check); assertSnapshot(snapshot, input.contract_id, check);
      const state = requireDraft(snapshot, input);
      if (snapshot.row?.attempt_id !== attempt) conflict('A newer permission test started.');
      const observed = host.evaluate(input.contract_id, state.drafts.at(-1)!.document);
      state.review = null; state.qualification = observed.comparison.failed === 0 ? { actor, attempt, environment: observed.environment,
        dependencies: observed.dependencies, receipt_id: randomUUID(), draft_revision: input.draft_revision,
        candidate_digest: state.drafts.at(-1)!.digest, expires_at: now() + LIMIT.qualification_ms, comparison: observed.comparison } : null;
      const encrypted = await seal(state);
      db.transaction(() => { assertSnapshot(snapshot, input.contract_id, check); host.assertDependencies(observed.dependencies);
        if (host.evaluate(input.contract_id, state.drafts.at(-1)!.document).environment !== observed.environment) conflict();
        persist(snapshot, state, encrypted, check); }).immediate();
      return { ...view(updatedSnapshot(state, encrypted), input.contract_id, actor), comparison: structuredClone(observed.comparison) };
    },
    async prepare(raw: PermissionPrepare, actor: string, check: () => void): Promise<PermissionReview> {
      const input = structuredClone(raw), snapshot = await load(input.contract_id, check); assertSnapshot(snapshot, input.contract_id, check);
      const state = requireDraft(snapshot, input);
      db.transaction(() => assertProof(snapshot, state, actor)).immediate();
      if (state.qualification!.receipt_id !== input.receipt_id) conflict('Use the passing result from this paired client.');
      const draft = state.drafts.at(-1)!, review: Review = { review_id: randomUUID(), revision: state.revision, actor, receipt_id: input.receipt_id,
        draft_revision: draft.revision, candidate_digest: draft.digest, live_digest: snapshot.context.live_digest,
        expires_at: Math.min(now() + LIMIT.review_ms, state.qualification!.expires_at),
        changes: draft.document.changes.map(item => ({ entry_key: item.entry_key, before: snapshot.context.grants.find(row => row.entry_key === item.entry_key)?.granted ?? null, after: item.granted })),
        impact: structuredClone(state.qualification!.comparison.impact) };
      state.review = review; const encrypted = await seal(state);
      db.transaction(() => { assertProof(snapshot, state, actor); persist(snapshot, state, encrypted, check); }).immediate();
      const { actor: _actor, revision: _revision, receipt_id: _receipt, ...result } = review; return result;
    },
    async activate(raw: PermissionActivate, actor: string, check: () => void): Promise<PermissionMutation> {
      const input = structuredClone(raw), snapshot = await load(input.contract_id, check), hash = digest({ kind: 'activate', ...input });
      assertSnapshot(snapshot, input.contract_id, check);
      const prior = replay(snapshot, input.request_id, hash, actor); if (prior) return prior;
      supported(snapshot); revision(snapshot, input.expected_revision);
      const state = snapshot.state, review = state?.review, draft = state?.drafts.at(-1);
      const valid = () => { assertSnapshot(snapshot, input.contract_id, check);
        if (!state || !review || !draft || review.review_id !== input.review_id || review.actor !== actor || review.expires_at <= now()
          || review.revision !== input.expected_revision || review.candidate_digest !== draft.digest || review.live_digest !== snapshot.context.live_digest
          || review.receipt_id !== state.qualification?.receipt_id) conflict('The permission activation review is stale. Test and review the draft again.');
        assertProof(snapshot, state!, actor);
      };
      db.transaction(valid).immediate(); const at = now(), next = structuredClone(state!); next.revision++;
      const grants = host.projectedGrants(snapshot.context.grants, draft!.document.changes, at);
      const activated: PermissionActivation = { kind: 'activated', sequence: next.history.at(-1)!.sequence + 1, created_at: at, digest: digest(grants), grants };
      next.history.push(activated); next.qualification = null; next.review = null;
      next.requests.push({ id: input.request_id, hash, actor, kind: 'activate', revision: next.revision, target: activated.sequence });
      const encrypted = await seal(next);
      db.transaction(() => { valid(); host.apply(input.contract_id, draft!.document.changes, at);
        if (digest(host.context(input.contract_id).grants) !== activated.digest) conflict('The grant writer did not apply the reviewed revision.');
        persist(snapshot, next, encrypted, check, false); }).immediate();
      return { ...view(updatedSnapshot(next, encrypted), input.contract_id, actor), mutation_revision: next.revision, activated: structuredClone(activated) };
    },
    async delete(id: string, expected: number, requestId: string, actor: string, check: () => void): Promise<{ revision: number }> {
      const snapshot = await load(id, check), hash = digest({ id, expected, requestId, actor });
      assertSnapshot(snapshot, id, check);
      if (!snapshot.state && snapshot.row?.deletion === hash) return { revision: snapshot.row.revision };
      revision(snapshot, expected); const next = expected + 1;
      db.transaction(() => { assertSnapshot(snapshot, id, check); db.prepare(`INSERT INTO permission_regression_tracks VALUES(?,?,'','',?)
        ON CONFLICT(contract_id) DO UPDATE SET revision=excluded.revision,encrypted='',attempt_id='',deletion=excluded.deletion`).run(id, next, hash); }).immediate();
      return { revision: next };
    },
  };
};
export type PermissionRegressionStore = ReturnType<typeof createPermissionRegressionStore>;
