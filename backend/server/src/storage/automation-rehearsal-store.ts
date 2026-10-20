import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, AUTOMATION_REHEARSAL_LIMITS as LIMIT, parseRehearsalDocument, rehearsalBytes,
  type RehearsalTarget, type RehearsalDraft, type RehearsalProof, type RehearsalReview, type RehearsalActivation,
  type RehearsalView, type RehearsalSave, type RehearsalTest, type RehearsalPrepare, type RehearsalActivate,
  type RehearsalMutation, type RehearsalComparison } from '@recued/contracts';
import type { AutomationRehearsalHost } from '../automation-rehearsal-host.js';
import { REHEARSAL_COVERAGE } from '../automation-rehearsal-host.js';
import type { PreapprovalCodec } from './preapproval-codec.js';
import { preapprovalHash as digest } from '../preapproval-invocations.js';
import { commitLocalTransaction } from '../local-transaction.js';

interface Row { key: string; revision: number; encrypted: string; attempt: string; deletion: string }
interface Proof extends RehearsalProof { actor: string; attempt: string; environment: string }
interface Review extends RehearsalReview { actor: string; receipt_id: string; revision: number; live_digest: string }
interface Receipt { id: string; hash: string; actor: string; revision: number; kind: 'save' | 'activate'; target: number }
interface State { schema_version: 1; target: RehearsalTarget; revision: number; drafts: RehearsalDraft[];
  qualification: Proof | null; review: Review | null; history: RehearsalActivation[]; receipts: Receipt[] }
interface Snapshot { row: Row | undefined; state: State | null; live: ReturnType<AutomationRehearsalHost['context']> }
const conflict = (message = 'The automation or saved rehearsal changed. Reload, test and review the current configuration again.'): never => {
  throw new RpcError('automation_rehearsal_conflict', message, 409);
};
const key = (target: RehearsalTarget) => JSON.stringify([target.kind, target.id]);
const REFRESH_WARNING = 'Configuration committed. Runtime refresh was not confirmed for this activation; restart Recued before relying on automatic runs.';
export const createAutomationRehearsalStore = (db: Database.Database, codec: PreapprovalCodec, host: AutomationRehearsalHost, now = Date.now) => {
  if (!host.sharesRealm(db)) throw new Error('Automation rehearsal and configuration require the same realm database.');
  db.exec("CREATE TABLE IF NOT EXISTS automation_rehearsals (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, encrypted TEXT NOT NULL, attempt TEXT NOT NULL, deletion TEXT NOT NULL DEFAULT '')");
  const row = (target: RehearsalTarget) => db.prepare('SELECT * FROM automation_rehearsals WHERE key=?').get(key(target)) as Row | undefined;
  const assert = (snapshot: Snapshot, target: RehearsalTarget, check: () => void, live = true) => {
    check(); codec.assertUnlocked();
    if (digest(row(target) ?? null) !== digest(snapshot.row ?? null) || live && host.context(target).live_digest !== snapshot.live.live_digest) conflict();
  };
  const load = async (target: RehearsalTarget, check: () => void): Promise<Snapshot> => {
    check(); codec.assertUnlocked(); const saved = row(target), live = host.context(target), snapshot: Snapshot = { row: saved, live, state: null };
    if (!saved?.encrypted) return snapshot;
    const value = await codec.open(saved.encrypted); assert(snapshot, target, check);
    const state = value as State;
    if (!state || state.schema_version !== 1 || digest(state.target) !== digest(target) || state.revision !== saved.revision
      || !Array.isArray(state.drafts) || !state.drafts.length || state.drafts.length > LIMIT.history
      || !Array.isArray(state.history) || state.history.length > LIMIT.history
      || !Array.isArray(state.receipts) || state.receipts.length > LIMIT.history || rehearsalBytes(state) > LIMIT.state_bytes) conflict('The sealed rehearsal history is invalid.');
    for (const draft of state.drafts) if (digest(parseRehearsalDocument(draft.document)) !== draft.digest) conflict('A retained rehearsal does not match its digest.');
    snapshot.state = state; return snapshot;
  };
  const revision = (snapshot: Snapshot, expected: number, live?: string) => {
    if ((snapshot.row?.revision ?? 0) !== expected || live !== undefined && snapshot.live.live_digest !== live) conflict();
  };
  const supported = (snapshot: Snapshot) => { if (!snapshot.live.supported) throw new RpcError('automation_rehearsal_unsupported', snapshot.live.reason!, 409); };
  const proofValid = (snapshot: Snapshot, actor: string) => {
    const proof = snapshot.state?.qualification, draft = snapshot.state?.drafts.at(-1);
    return !!(snapshot.live.supported && proof && draft && proof.actor === actor && proof.attempt === snapshot.row?.attempt
      && proof.expires_at > now() && proof.draft_revision === draft.revision && draft.base_digest === snapshot.live.live_digest
      && proof.comparison.failed === 0 && proof.comparison.passed > 0);
  };
  const view = (snapshot: Snapshot, actor: string): RehearsalView => {
    const live = snapshot.live, proof = proofValid(snapshot, actor) ? snapshot.state!.qualification : null;
    return { target: live.target, label: live.label, supported: live.supported, ...(live.reason ? { reason: live.reason } : {}),
      recipe_id: live.recipe_id, dish_id: live.dish_id, time_zone: live.time_zone, interval_ms: live.interval_ms,
      revision: snapshot.row?.revision ?? 0, live_digest: live.live_digest, current: structuredClone(live.current),
      draft: structuredClone(snapshot.state?.drafts.at(-1) ?? null), drafts: snapshot.state?.drafts.map(item => ({ revision: item.revision, title: item.document.title, created_at: item.created_at })) ?? [],
      qualification: proof ? { receipt_id: proof.receipt_id, draft_revision: proof.draft_revision, expires_at: proof.expires_at, comparison: structuredClone(proof.comparison) } : null,
      history: structuredClone(snapshot.state?.history ?? []) };
  };
  const seal = async (state: State) => {
    state.drafts = state.drafts.slice(-LIMIT.history); state.history = state.history.slice(-LIMIT.history); state.receipts = state.receipts.slice(-LIMIT.history);
    while (rehearsalBytes(state) > LIMIT.state_bytes && (state.drafts.length > 1 || state.history.length > 1 || state.receipts.length > 1)) {
      if (state.drafts.length > 1) state.drafts.shift(); else if (state.history.length > 1) state.history.shift(); else state.receipts.shift();
    }
    if (rehearsalBytes(state) > LIMIT.state_bytes) throw new RpcError('automation_rehearsal_limit', 'Use smaller scenarios or delete an unused rehearsal.', 409);
    return codec.seal(state);
  };
  const persist = (snapshot: Snapshot, state: State, encrypted: string, check: () => void, live = true) => {
    assert(snapshot, state.target, check, live);
    if (!snapshot.state && (db.prepare("SELECT count(*) FROM automation_rehearsals WHERE encrypted<>''").pluck().get() as number) >= LIMIT.tracks) throw new RpcError('automation_rehearsal_limit', 'Keep at most 100 saved rehearsals.', 409);
    const bytes = db.prepare('SELECT coalesce(sum(length(CAST(encrypted AS BLOB))),0) FROM automation_rehearsals WHERE key<>?').pluck().get(key(state.target)) as number;
    if (bytes + Buffer.byteLength(encrypted, 'utf8') > LIMIT.retained_bytes) throw new RpcError('automation_rehearsal_limit', 'Saved rehearsal storage is full.', 409);
    db.prepare("INSERT INTO automation_rehearsals VALUES(?,?,?,?, '') ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,encrypted=excluded.encrypted,attempt=excluded.attempt,deletion=''")
      .run(key(state.target), state.revision, encrypted, snapshot.row?.attempt ?? '');
  };
  const updated = (state: State, encrypted: string): Snapshot => ({ state, live: host.context(state.target),
    row: { key: key(state.target), revision: state.revision, encrypted, attempt: row(state.target)?.attempt ?? '', deletion: '' } });
  const replay = (snapshot: Snapshot, requestId: string, hash: string, actor: string): RehearsalMutation | null => {
    const receipt = snapshot.state?.receipts.find(item => item.id === requestId); if (!receipt) return null;
    if (receipt.hash !== hash || receipt.actor !== actor) conflict('This request id belongs to a different change or paired client.');
    const saved = receipt.kind === 'save' ? snapshot.state!.drafts.find(item => item.revision === receipt.target) : undefined;
    const activation = receipt.kind === 'activate' ? snapshot.state!.history.find(item => item.sequence === receipt.target) : undefined;
    if (!saved && !activation) conflict('That result is no longer retained. Reload the current rehearsal.');
    return { ...view(snapshot, actor), mutation_revision: receipt.revision, ...(saved ? { saved_draft: structuredClone(saved) } : {}),
      ...(activation ? { activated: structuredClone(activation), ...(activation.refresh_confirmed ? {} : { refresh_warning: REFRESH_WARNING }) } : {}) };
  };
  const draftFor = (snapshot: Snapshot, input: RehearsalTest) => {
    supported(snapshot); revision(snapshot, input.expected_revision); const state = snapshot.state, draft = state?.drafts.at(-1);
    if (!state || !draft || draft.revision !== input.draft_revision || draft.base_digest !== snapshot.live.live_digest) conflict();
    return state!;
  };
  const assertProof = (snapshot: Snapshot, actor: string) => {
    if (!proofValid(snapshot, actor)) conflict('Run the current saved scenarios before reviewing activation.');
    const comparison = host.evaluate(snapshot.live.target, snapshot.state!.drafts.at(-1)!.document);
    if (digest({ basis: host.context(snapshot.live.target).live_digest, comparison }) !== snapshot.state!.qualification!.environment) conflict('Dispatch selection changed after testing. Run the saved scenarios again.');
  };
  return {
    async read(target: RehearsalTarget, actor: string, check: () => void, selected?: number): Promise<RehearsalView> {
      const snapshot = await load(target, check); assert(snapshot, target, check);
      const draft = selected === undefined ? undefined : snapshot.state?.drafts.find(item => item.revision === selected);
      if (selected !== undefined && !draft) conflict('That saved version is no longer retained.');
      return { ...view(snapshot, actor), ...(draft ? { selected_draft: structuredClone(draft) } : {}) };
    },
    async save(raw: RehearsalSave, actor: string, check: () => void): Promise<RehearsalMutation> {
      const input = structuredClone(raw), snapshot = await load(input.target, check); assert(snapshot, input.target, check);
      const hash = digest({ kind: 'save', ...input }), prior = replay(snapshot, input.request_id, hash, actor); if (prior) return prior;
      supported(snapshot); revision(snapshot, input.expected_revision, input.expected_live_digest);
      const document = parseRehearsalDocument(input.document); host.project(input.target, document.candidate);
      if (digest(document.candidate) === digest(snapshot.live.current)) throw new RpcError('bad_request', 'Propose a configuration change or an explicit timer circuit reset.', 400);
      const state: State = snapshot.state ?? { schema_version: 1, target: input.target, revision: snapshot.row?.revision ?? 0,
        drafts: [], qualification: null, review: null, history: [], receipts: [] };
      state.revision++; const draft: RehearsalDraft = { revision: state.revision, digest: digest(document), base_digest: snapshot.live.live_digest, created_at: now(), document };
      state.drafts.push(draft); state.qualification = null; state.review = null;
      state.receipts.push({ id: input.request_id, hash, actor, revision: state.revision, kind: 'save', target: draft.revision });
      const encrypted = await seal(state);
      db.transaction(() => { host.project(input.target, document.candidate); persist(snapshot, state, encrypted, check); }).immediate();
      return { ...view(updated(state, encrypted), actor), mutation_revision: state.revision, saved_draft: structuredClone(draft) };
    },
    async test(raw: RehearsalTest, actor: string, check: () => void): Promise<RehearsalView & { comparison: RehearsalComparison }> {
      const input = structuredClone(raw), attempt = randomUUID();
      db.transaction(() => { check(); codec.assertUnlocked(); if (row(input.target)?.revision !== input.expected_revision) conflict();
        db.prepare('UPDATE automation_rehearsals SET attempt=? WHERE key=?').run(attempt, key(input.target)); }).immediate();
      const snapshot = await load(input.target, check); assert(snapshot, input.target, check); const state = draftFor(snapshot, input);
      if (snapshot.row?.attempt !== attempt) conflict('A newer rehearsal started.');
      const comparison = host.evaluate(input.target, state.drafts.at(-1)!.document);
      state.review = null; state.qualification = comparison.failed ? null : { actor, attempt,
        environment: digest({ basis: host.context(input.target).live_digest, comparison }), receipt_id: randomUUID(), draft_revision: input.draft_revision,
        expires_at: now() + LIMIT.proof_ms, comparison };
      const encrypted = await seal(state);
      db.transaction(() => { assert(snapshot, input.target, check);
        if (digest(host.evaluate(input.target, state.drafts.at(-1)!.document)) !== digest(comparison)) conflict();
        persist(snapshot, state, encrypted, check); }).immediate();
      return { ...view(updated(state, encrypted), actor), comparison };
    },
    async prepare(raw: RehearsalPrepare, actor: string, check: () => void): Promise<RehearsalReview> {
      const input = structuredClone(raw), snapshot = await load(input.target, check); assert(snapshot, input.target, check); const state = draftFor(snapshot, input);
      assertProof(snapshot, actor); if (state.qualification!.receipt_id !== input.receipt_id) conflict('Use this paired client’s passing rehearsal.');
      const review: Review = { actor, receipt_id: input.receipt_id, revision: state.revision, live_digest: snapshot.live.live_digest,
        review_id: randomUUID(), draft_revision: input.draft_revision, expires_at: Math.min(now() + LIMIT.review_ms, state.qualification!.expires_at),
        before: structuredClone(snapshot.live.current!), after: structuredClone(state.drafts.at(-1)!.document.candidate), label: snapshot.live.label, coverage: [...REHEARSAL_COVERAGE] };
      state.review = review; const encrypted = await seal(state);
      db.transaction(() => { assertProof(snapshot, actor); persist(snapshot, state, encrypted, check); }).immediate();
      const { actor: _actor, receipt_id: _receipt, revision: _revision, live_digest: _live, ...result } = review; return result;
    },
    async activate(raw: RehearsalActivate, actor: string, check: () => void): Promise<RehearsalMutation> {
      const input = structuredClone(raw), snapshot = await load(input.target, check); assert(snapshot, input.target, check);
      const hash = digest({ kind: 'activate', ...input }), prior = replay(snapshot, input.request_id, hash, actor); if (prior) return prior;
      supported(snapshot); revision(snapshot, input.expected_revision);
      const state = snapshot.state, review = state?.review, draft = state?.drafts.at(-1);
      const valid = () => {
        assert(snapshot, input.target, check);
        if (!state || !review || !draft || review.actor !== actor || review.review_id !== input.review_id || review.revision !== input.expected_revision
          || review.expires_at <= now() || review.live_digest !== snapshot.live.live_digest || review.receipt_id !== state.qualification?.receipt_id) conflict('The activation review is stale.');
        assertProof(snapshot, actor);
      };
      valid(); const next = structuredClone(state!); next.revision++; next.qualification = null; next.review = null;
      const configuration = structuredClone(draft!.document.candidate); if (configuration.kind === 'timer') configuration.reset_circuit = false;
      const activation: RehearsalActivation = { sequence: (next.history.at(-1)?.sequence ?? 0) + 1, at: now(), configuration,
        ...(draft!.document.candidate.kind === 'timer' && draft!.document.candidate.reset_circuit ? { circuit_reset: true as const } : {}) };
      next.history.push(activation); next.receipts.push({ id: input.request_id, hash, actor, revision: next.revision, kind: 'activate', target: activation.sequence });
      const encrypted = await seal(next);
      commitLocalTransaction(db, () => { valid(); host.apply(input.target, draft!.document.candidate);
        if (digest(host.context(input.target).current) !== digest(configuration)) conflict('The writer did not apply the reviewed configuration.');
        persist(snapshot, next, encrypted, check, false); });
      let refreshed = false;
      try { await host.refresh(input.target, draft!.document.candidate); refreshed = true; } catch { /* The durable receipt remains unconfirmed. */ }
      let current = await load(input.target, check); assert(current, input.target, check);
      const recorded = (snapshot: Snapshot) => snapshot.state?.receipts.some(item => item.id === input.request_id && item.hash === hash && item.actor === actor && item.kind === 'activate')
        ? snapshot.state.history.find(item => item.sequence === activation.sequence) : undefined;
      if (refreshed && recorded(current)) {
        const confirmed = structuredClone(current.state!); confirmed.history.find(item => item.sequence === activation.sequence)!.refresh_confirmed = true;
        try {
          const sealed = await seal(confirmed);
          db.transaction(() => persist(current, confirmed, sealed, check)).immediate(); current = updated(confirmed, sealed);
        } catch {
          // Confirmation may lose a race with a newer save, deletion, lock or
          // owner change. Never overwrite that state or replay the live change.
          current = await load(input.target, check); assert(current, input.target, check);
        }
      }
      const result = recorded(current) ?? activation;
      return { ...view(current, actor), mutation_revision: next.revision, activated: structuredClone(result),
        ...(result.refresh_confirmed ? {} : { refresh_warning: REFRESH_WARNING }) };
    },
    async delete(target: RehearsalTarget, expected: number, requestId: string, actor: string, check: () => void): Promise<{ revision: number }> {
      const snapshot = await load(target, check); assert(snapshot, target, check); const hash = digest({ target, expected, requestId, actor });
      if (!snapshot.state && snapshot.row?.deletion === hash) return { revision: snapshot.row.revision };
      revision(snapshot, expected); const revisionNumber = expected + 1;
      db.transaction(() => { assert(snapshot, target, check); db.prepare("INSERT INTO automation_rehearsals VALUES(?,?,'','',?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,encrypted='',attempt='',deletion=excluded.deletion")
        .run(key(target), revisionNumber, hash); }).immediate();
      return { revision: revisionNumber };
    },
  };
};
export type AutomationRehearsalStore = ReturnType<typeof createAutomationRehearsalStore>;
