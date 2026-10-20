import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, RECIPE_RELEASE_LIMITS as LIMIT, regressionBytes,
  type RecipeDefinition, type RecipeReleaseActivate, type RecipeReleaseDraft,
  type RecipeReleaseMutation, type RecipeReleasePrepare, type RecipeReleaseQualification,
  type RecipeReleaseRestore, type RecipeReleaseReview, type RecipeReleaseSave,
  type RecipeReleaseVersion, type RecipeReleaseView, type RecipeRegressionResult } from '@recued/contracts';
import { normalizeRegressionRecipe } from '@recued/engine';
import type { RecipeStore } from '../recipe-store.js';
import { hasNonEmptyWebhookDeclarations } from '../webhook-declaration-gate.js';
import type { PreapprovalCodec } from './preapproval-codec.js';
import type { RecipeRegressionStore } from './recipe-regression-store.js';
import { initializeRecipeReleases, recipeReleaseDigest as digest, withRecipeReleaseAuthority } from './recipe-release-authority.js';

interface Row { recipe_id: string; revision: number; active_digest: string; active_sequence: number; deleted: number; encrypted: string; attempt_id: string }
interface RequestRecord { id: string; hash: string; kind: 'save' | 'restore' | 'activate'; revision: number; target: number }
interface Qualification extends RecipeReleaseQualification { actor: string; attempt_id: string }
interface Review extends RecipeReleaseReview { actor: string; receipt_id: string; revision: number }
interface State {
  schema_version: 1; recipe_id: string; revision: number; active_digest: string; active_sequence: number;
  drafts: RecipeReleaseDraft[]; releases: RecipeReleaseVersion[]; requests: RequestRecord[];
  qualification: Qualification | null; review: Review | null;
}
interface Snapshot { row: Row | undefined; state: State | null; active: RecipeDefinition | null; json: string | null; reason?: string }
const conflict = (message = 'The recipe or its release draft changed. Load the latest draft before continuing.'): never => {
  throw new RpcError('recipe_release_conflict',message,409);
};
const unsupported = (message: string): never => { throw new RpcError('recipe_release_unsupported',message,409); };
export const createRecipeReleaseStore = (db: Database.Database, codec: PreapprovalCodec, recipes: RecipeStore,
  suites: RecipeRegressionStore, validateLive: (recipe: RecipeDefinition) => void, now: () => number = Date.now) => {
  initializeRecipeReleases(db);
  const row = (id: string): Row | undefined => db.prepare('SELECT * FROM recipe_release_tracks WHERE recipe_id=?').get(id) as Row | undefined;
  const inspect = (id: string): { active: RecipeDefinition | null; json: string | null; reason?: string } => {
    const value = recipes.inspectLocalRecipeEdit?.(id);
    if (!value || value.kind === 'unavailable') return { active: null,json: null,reason: 'Open a saved local recipe to use reviewed releases.' };
    if (value.kind === 'fork_required') return { active: null,json: null,reason: 'Fork this pack or bundled recipe to a new local recipe id first.' };
    if (hasNonEmptyWebhookDeclarations(value.recipe)) return { active: null,json: null,reason: 'Reviewed releases currently support local recipes without webhook declarations.' };
    return { active: value.recipe,json: value.recipe_json };
  };
  const assertSnapshot = (snapshot: Snapshot, id: string, check: () => void): void => {
    check(); codec.assertUnlocked();
    if (JSON.stringify(row(id)) !== JSON.stringify(snapshot.row)) conflict();
    const live = inspect(id);
    if (live.json !== snapshot.json || live.reason !== snapshot.reason) conflict();
  };
  const load = async (id: string, check: () => void): Promise<Snapshot> => {
    check(); codec.assertUnlocked();
    const saved = row(id), current = inspect(id);
    const snapshot: Snapshot = { row: saved,state: null,...current };
    if (!saved || saved.deleted) return snapshot;
    const value = await codec.open(saved.encrypted);
    assertSnapshot(snapshot,id,check);
    if (!value || typeof value !== 'object') conflict('The sealed release history is invalid.');
    const state = value as State;
    if (state.schema_version !== 1 || state.recipe_id !== id || state.revision !== saved.revision
      || state.active_digest !== saved.active_digest || state.active_sequence !== saved.active_sequence
      || !Array.isArray(state.drafts) || !Array.isArray(state.releases) || !Array.isArray(state.requests)
      || !state.drafts.length || !state.releases.length || state.drafts.length > LIMIT.history || state.releases.length > LIMIT.history
      || state.requests.length > LIMIT.history || regressionBytes(state) > LIMIT.state_bytes) conflict('The sealed release history does not match its identity.');
    for (const entry of [...state.drafts,...state.releases]) {
      const recipe = normalizeRegressionRecipe(entry.recipe);
      if (recipe.recipe_id !== id || digest(recipe) !== entry.digest) conflict('A sealed recipe version does not match its identity.');
      entry.recipe = recipe;
    }
    if (!current.active || digest(current.active) !== saved.active_digest
      || state.releases.at(-1)!.digest !== saved.active_digest || state.releases.at(-1)!.sequence !== saved.active_sequence) conflict('The active recipe changed outside its reviewed release.');
    snapshot.state = state; return snapshot;
  };
  const suiteMatches = (id: string, qualification: RecipeReleaseQualification): boolean => {
    const latest = suites.history(id);
    return latest.head_revision === qualification.suite_revision && latest.versions[0]?.revision === qualification.suite_revision
      && latest.versions[0]?.digest === qualification.suite_digest;
  };
  const qualificationValid = (state: State, actor: string): boolean => {
    const proof = state.qualification, draft = state.drafts.at(-1)!;
    return proof !== null && proof.actor === actor && proof.attempt_id === row(state.recipe_id)?.attempt_id && proof.expires_at > now()
      && proof.draft_revision === draft.revision && proof.candidate_digest === draft.digest
      && draft.base_digest === state.active_digest && proof.passed > 0 && suiteMatches(state.recipe_id,proof);
  };
  const view = (snapshot: Snapshot, actor: string): RecipeReleaseView => {
    const state = snapshot.state, proof = state && qualificationValid(state,actor) ? state.qualification : null;
    const qualification: RecipeReleaseQualification | null = proof ? {
      receipt_id: proof.receipt_id,draft_revision: proof.draft_revision,candidate_digest: proof.candidate_digest,
      suite_revision: proof.suite_revision,suite_digest: proof.suite_digest,passed: proof.passed,expires_at: proof.expires_at,
    } : null;
    return { recipe_id: snapshot.row?.recipe_id ?? snapshot.active?.recipe_id ?? '',supported: !snapshot.reason,
      ...(snapshot.reason ? { reason: snapshot.reason } : {}),managed: state !== null,revision: snapshot.row?.revision ?? 0,
      active: snapshot.active ? { sequence: state?.active_sequence ?? 0,digest: digest(snapshot.active),created_at: state?.releases.at(-1)?.created_at ?? 0,recipe: structuredClone(snapshot.active) } : null,
      draft: state ? structuredClone(state.drafts.at(-1)!) : null,
      drafts: state?.drafts.map(({ recipe: _recipe,...metadata }) => metadata) ?? [],
      releases: state?.releases.map(({ recipe: _recipe,...metadata }) => metadata) ?? [],qualification };
  };
  const candidate = (raw: RecipeDefinition, id: string): RecipeDefinition => {
    if (regressionBytes(raw) > LIMIT.recipe_bytes) throw new RpcError('bad_request','Keep a release recipe under 1 MB.',400);
    const recipe = normalizeRegressionRecipe(raw);
    if (recipe.recipe_id !== id) throw new RpcError('bad_request','Keep the same recipe id for a release.',400);
    if (hasNonEmptyWebhookDeclarations(recipe)) unsupported('Reviewed release candidates cannot add webhook declarations.');
    validateLive(recipe); return recipe;
  };
  const revisionMatches = (snapshot: Snapshot, expected: number, activeDigest?: string): void => {
    if (snapshot.reason || !snapshot.active || !snapshot.json) unsupported(snapshot.reason ?? 'The local recipe is unavailable.');
    if ((snapshot.row?.revision ?? 0) !== expected || (activeDigest !== undefined && digest(snapshot.active) !== activeDigest)) conflict();
  };
  const prune = (state: State): void => {
    state.drafts = state.drafts.slice(-LIMIT.history); state.releases = state.releases.slice(-LIMIT.history); state.requests = state.requests.slice(-LIMIT.history);
    while (regressionBytes(state) > LIMIT.state_bytes && (state.drafts.length > 1 || state.releases.length > 2)) {
      if (state.drafts.length > 1) state.drafts.shift(); else state.releases.shift();
    }
    if (regressionBytes(state) > LIMIT.state_bytes) throw new RpcError('recipe_release_limit','Release history is too large. Use a smaller recipe.',409);
  };
  const sealed = async (state: State): Promise<string> => { prune(state); return codec.seal(state); };
  const persist = (snapshot: Snapshot, state: State, encrypted: string, check: () => void, afterRecipeWrite = false): void => {
    if (afterRecipeWrite) {
      check(); codec.assertUnlocked();
      const current = inspect(state.recipe_id);
      if (JSON.stringify(row(state.recipe_id)) !== JSON.stringify(snapshot.row) || !current.active
        || current.reason || digest(current.active) !== state.active_digest) conflict();
    } else assertSnapshot(snapshot,state.recipe_id,check);
    const count = db.prepare('SELECT count(*) FROM recipe_release_tracks WHERE deleted=0').pluck().get() as number;
    if (!snapshot.state && count >= LIMIT.tracks) throw new RpcError('recipe_release_limit','Keep at most 100 reviewed local recipes.',409);
    const retained = db.prepare('SELECT coalesce(sum(length(CAST(encrypted AS BLOB))),0) FROM recipe_release_tracks WHERE recipe_id<>?').pluck().get(state.recipe_id) as number;
    if (retained + Buffer.byteLength(encrypted,'utf8') > LIMIT.retained_bytes) throw new RpcError('recipe_release_limit','Saved release history is full. Delete an unused local recipe or use smaller drafts.',409);
    db.prepare(`INSERT INTO recipe_release_tracks VALUES(?,?,?,?,0,?,?) ON CONFLICT(recipe_id) DO UPDATE SET
      revision=excluded.revision,active_digest=excluded.active_digest,active_sequence=excluded.active_sequence,deleted=0,encrypted=excluded.encrypted,attempt_id=excluded.attempt_id`)
      .run(state.recipe_id,state.revision,state.active_digest,state.active_sequence,encrypted,snapshot.row?.attempt_id ?? '');
  };
  const nextSnapshot = (state: State, encrypted: string): Snapshot => ({
    row: { recipe_id: state.recipe_id,revision: state.revision,active_digest: state.active_digest,active_sequence: state.active_sequence,deleted: 0,encrypted,attempt_id: row(state.recipe_id)?.attempt_id ?? '' },
    state,active: state.releases.at(-1)!.recipe,json: JSON.stringify(state.releases.at(-1)!.recipe),
  });
  const replay = (snapshot: Snapshot, id: string, hash: string, actor: string): RecipeReleaseMutation | undefined => {
    const prior = snapshot.state?.requests.find(item => item.id === id); if (!prior) return undefined;
    if (prior.hash !== hash) conflict('This request id already names a different release change.');
    const saved_draft = prior.kind === 'activate' ? undefined : snapshot.state!.drafts.find(item => item.revision === prior.target);
    const activated = prior.kind === 'activate' ? snapshot.state!.releases.find(item => item.sequence === prior.target) : undefined;
    if (!saved_draft && !activated) conflict('The result of that request is no longer retained. Load the latest release state.');
    return { ...view(snapshot,actor),mutation_revision: prior.revision,...(saved_draft ? { saved_draft: structuredClone(saved_draft) } : {}),...(activated ? { activated: structuredClone(activated) } : {}) };
  };
  const save = async (request: RecipeReleaseSave | RecipeReleaseRestore, actor: string, check: () => void): Promise<RecipeReleaseMutation> => {
    request = structuredClone(request);
    const snapshot = await load(request.recipe_id,check), kind = 'candidate' in request ? 'save' : 'restore';
    const hash = digest({ kind,...request }); const prior = replay(snapshot,request.request_id,hash,actor); if (prior) return prior;
    revisionMatches(snapshot,request.expected_revision,request.expected_active_digest);
    const restored = 'sequence' in request ? snapshot.state?.releases.find(item => item.sequence === request.sequence) : undefined;
    if ('sequence' in request && !restored) conflict('That release is no longer retained.');
    const recipe = candidate('candidate' in request ? request.candidate : restored!.recipe,request.recipe_id);
    const state: State = snapshot.state ?? { schema_version: 1,recipe_id: request.recipe_id,revision: snapshot.row?.revision ?? 0,
      active_digest: digest(snapshot.active),active_sequence: 1,drafts: [],releases: [{ sequence: 1,digest: digest(snapshot.active),created_at: now(),recipe: snapshot.active! }],requests: [],qualification: null,review: null };
    state.revision++;
    const draft: RecipeReleaseDraft = { revision: state.revision,digest: digest(recipe),base_digest: state.active_digest,created_at: now(),recipe };
    state.drafts.push(draft); state.qualification = null; state.review = null;
    state.requests.push({ id: request.request_id,hash,kind,revision: state.revision,target: draft.revision });
    const encrypted = await sealed(state);
    db.transaction(() => { persist(snapshot,state,encrypted,check); }).immediate();
    return { ...view(nextSnapshot(state,encrypted),actor),mutation_revision: state.revision,saved_draft: structuredClone(draft) };
  };
  const requireDraft = (snapshot: Snapshot, expected: number, draftRevision: number): State => {
    revisionMatches(snapshot,expected);
    const state = snapshot.state, draft = state?.drafts.at(-1);
    if (!state || !draft || draft.revision !== draftRevision || draft.base_digest !== state.active_digest) conflict();
    return state!;
  };
  return {
    codec,
    async read(id: string, actor: string, check: () => void): Promise<RecipeReleaseView> {
      const result = view(await load(id,check),actor); return { ...result,recipe_id: id };
    },
    save,
    async beginTest(id: string, expected: number, draftRevision: number, check: () => void): Promise<RecipeReleaseDraft & { test_attempt: string }> {
      const attempt = randomUUID();
      // Invalidate older proof before crypto yields, including an early cancel.
      db.transaction(() => {
        check(); codec.assertUnlocked(); const current = row(id);
        if (!current || current.deleted || current.revision !== expected) conflict();
        db.prepare('UPDATE recipe_release_tracks SET attempt_id=? WHERE recipe_id=?').run(attempt,id);
      }).immediate();
      const snapshot = await load(id,check), state = requireDraft(snapshot,expected,draftRevision);
      state.qualification = null; state.review = null;
      const encrypted = await sealed(state); db.transaction(() => { persist(snapshot,state,encrypted,check); }).immediate();
      return { ...structuredClone(state.drafts.at(-1)!),test_attempt: attempt };
    },
    async qualify(id: string, expected: number, draftRevision: number, comparison: RecipeRegressionResult, attempt: string, actor: string, check: () => void): Promise<RecipeReleaseView> {
      const snapshot = await load(id,check), state = requireDraft(snapshot,expected,draftRevision), draft = state.drafts.at(-1)!;
      if (snapshot.row?.attempt_id !== attempt) conflict('A newer release test started. Use its result.');
      const proof: Qualification = { attempt_id: attempt,receipt_id: randomUUID(),draft_revision: draft.revision,candidate_digest: draft.digest,
        suite_revision: comparison.revision,suite_digest: comparison.suite_digest,passed: comparison.passed,expires_at: now() + LIMIT.qualification_ms,actor };
      if (comparison.recipe_id !== id || comparison.candidate_hash !== draft.digest || !suiteMatches(id,proof)) conflict('The tests or recipe changed during qualification. Run the tests again.');
      const passing = comparison.failed === 0 && comparison.passed > 0 && comparison.passed === comparison.cases.length
        && comparison.cases.every(item => item.candidate.passed && item.candidate.assertions.every(check => check.passed));
      state.qualification = passing ? proof : null; state.review = null;
      const encrypted = await sealed(state);
      db.transaction(() => { if (!suiteMatches(id,proof)) conflict('The saved tests changed. Run them again.'); persist(snapshot,state,encrypted,check); }).immediate();
      return view(nextSnapshot(state,encrypted),actor);
    },
    async prepare(request: RecipeReleasePrepare, actor: string, check: () => void): Promise<RecipeReleaseReview> {
      request = structuredClone(request);
      const snapshot = await load(request.recipe_id,check), state = requireDraft(snapshot,request.expected_revision,request.draft_revision);
      if (!qualificationValid(state,actor) || state.qualification!.receipt_id !== request.receipt_id) conflict('Run the latest saved tests on this draft before reviewing activation.');
      const draft = state.drafts.at(-1)!, changes: RecipeReleaseReview['changes'] = []; let truncated = false, retained = 0;
      const walk = (before: unknown, after: unknown, path: string[], beforePresent = true, afterPresent = true): void => {
        if (digest(before ?? null) === digest(after ?? null) && beforePresent === afterPresent) return;
        if (path.length < 16 && before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
          for (const key of new Set([...Object.keys(before),...Object.keys(after)])) walk(Reflect.get(before,key),Reflect.get(after,key),[...path,key],Object.hasOwn(before,key),Object.hasOwn(after,key));
          return;
        }
        const entry = { path,before_present: beforePresent,after_present: afterPresent,before: beforePresent ? before : null,after: afterPresent ? after : null };
        retained += regressionBytes(entry);
        if (changes.length < LIMIT.diff_entries && retained <= 64_000) changes.push(entry); else truncated = true;
      };
      walk(snapshot.active,draft.recipe,[]);
      const review: Review = { review_id: randomUUID(),draft_revision: draft.revision,candidate_digest: draft.digest,active_digest: state.active_digest,
        expires_at: Math.min(now() + LIMIT.review_ms,state.qualification!.expires_at),changes,truncated,actor,receipt_id: request.receipt_id,revision: state.revision };
      state.review = review; const encrypted = await sealed(state);
      db.transaction(() => { if (!qualificationValid(state,actor)) conflict('The test result expired or its suite changed. Run the tests again.'); persist(snapshot,state,encrypted,check); }).immediate();
      const { actor: _actor,receipt_id: _receipt,revision: _revision,...result } = review; return result;
    },
    async activate(request: RecipeReleaseActivate, actor: string, check: () => void): Promise<RecipeReleaseMutation> {
      request = structuredClone(request);
      const snapshot = await load(request.recipe_id,check), hash = digest({ kind: 'activate',...request });
      const prior = replay(snapshot,request.request_id,hash,actor); if (prior) return prior;
      revisionMatches(snapshot,request.expected_revision);
      const state = snapshot.state, review = state?.review, draft = state?.drafts.at(-1);
      const valid = (): void => {
        check(); codec.assertUnlocked();
        if (!state || !review || !draft || review.review_id !== request.review_id || review.actor !== actor || review.expires_at <= now()
          || review.revision !== request.expected_revision || review.draft_revision !== draft.revision || review.candidate_digest !== draft.digest
          || review.active_digest !== snapshot.row!.active_digest || draft.base_digest !== snapshot.row!.active_digest
          || !qualificationValid({ ...state,active_digest: snapshot.row!.active_digest },actor) || review.receipt_id !== state.qualification!.receipt_id) conflict('The activation review is stale. Run tests and review the current draft again.');
        validateLive(draft!.recipe);
      };
      valid();
      const next = structuredClone(state!); next.revision++; next.active_sequence++; next.active_digest = draft!.digest;
      const activated: RecipeReleaseVersion = { sequence: next.active_sequence,digest: draft!.digest,created_at: now(),recipe: draft!.recipe };
      next.releases.push(activated); next.qualification = null; next.review = null;
      next.requests.push({ id: request.request_id,hash,kind: 'activate',revision: next.revision,target: activated.sequence });
      const encrypted = await sealed(next);
      if (!recipes.compareAndSaveLocalRecipe) unsupported('The recipe writer cannot commit reviewed releases.');
      const result = withRecipeReleaseAuthority({ db,recipe_id: request.recipe_id,expected_json: snapshot.json!,candidate_digest: draft!.digest },permit =>
        recipes.compareAndSaveLocalRecipe!({ recipe: draft!.recipe,expected_recipe_json: snapshot.json!,now: now(),release: { permit,commit: () => {
          valid(); persist(snapshot,next,encrypted,check,true);
        } } }));
      if (result.kind !== 'updated' && result.kind !== 'unchanged') conflict();
      return { ...view(nextSnapshot(next,encrypted),actor),mutation_revision: next.revision,activated: structuredClone(activated) };
    },
  };
};
export type RecipeReleaseStore = ReturnType<typeof createRecipeReleaseStore>;
