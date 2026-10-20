import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { PACK_UPDATE_LIMITS as LIMIT, RpcError, regressionBytes,
  type BulkPackManifest, type PackUpdateStage, type PackUpdateView, type PackUpdateQualification,
  type RecipeRegressionResult, type PackUpdateApply, type PackUpdateApplyResult, type PackUpdateApplyReceipt, type PackUpdateRelease, type PackRestoreStage } from '@recued/contracts';
import type { BulkPackInstallRecipe } from '@recued/marketplace';
import type { PreparedPackUpdate } from '../pack-install-handler.js';
import type { RecipeStore } from '../recipe-store.js';
import { getInstalledPack } from '../pack-inventory.js';
import type { ContractStore } from './contract-store.js';
import type { PreapprovalCodec } from './preapproval-codec.js';
import type { RecipeRegressionStore } from './recipe-regression-store.js';
import { recipeReleaseDigest as digest } from './recipe-release-authority.js';
import { initializePackUpdates, retirePackUpdates, withPackUpdateAuthority, withPackUpdateAuthoritySync, packUpdatePlanOwner } from './pack-update-authority.js';
import { packUpdateMembers, packUpdateRecipes, packUpdateIdentity, assertPackUpdateRequirements, assertPackUpdateGroup } from '../pack-update-plan.js';
import { commitLocalTransaction } from '../local-transaction.js';
import { recordsManifestReviewHash } from '../records/review-fence.js';
import { createPackReleaseHistory,packReleaseArtifact,packReleaseDigest,packReleaseEnvironment,
  type PackReleaseHistorySnapshot } from './pack-release-history.js';

// Share the apply slot between store facades over the same live database.
const applying = new WeakMap<Database.Database,Set<string>>();
interface Row { pack_slug: string; revision: number; deleted: number; encrypted: string; attempt_id: string }
interface State {
  schema_version: 1; pack_slug: string; revision: number; request_id: string; request_hash: string;
  baseline: string; manifest_hash: string; target: PreparedPackUpdate; before: Record<string,string | null>;
  qualification: (PackUpdateQualification & { actor: string; attempt_id: string }) | null;
  pack_versions?: Record<string,number>;
  released?: true;
  restore?: { release_id: string; sequence: number; created_at: number; digest: string; history_identity: string; surrounding_inventory: string };
  receipts?: Array<{ actor: string; hash: string; receipt: PackUpdateApplyReceipt }>;
}
const conflict = (message = 'The staged update, installed pack or saved tests changed. Reload and stage the update again.'): never => {
  throw new RpcError('pack_update_conflict',message,409);
};
const identity = (manifest: BulkPackManifest, recipes: BulkPackInstallRecipe[]): string => digest({ manifest,
  recipes: recipes.map(entry => ({ slug: entry.slug,pinned_version: entry.pinned_version,
    publisher: entry.recipe?.publisher_id ?? null,version: entry.recipe?.version ?? null,recipe: entry.recipe?.recipe ?? null,
    resolved_at_run: entry.op_steps_resolved_at_run === true })) });

/** Persistent opt-in is enforced at both the pack entry point and RecipeStore.
 * Crypto completes before writer authority is minted; every write rechecks the
 * exact receipt and live suite heads. Single packs retain install-engine
 * rollback; reviewed groups and their retained artifacts commit together. */
export const createPackUpdateStore = (db: Database.Database, codec: PreapprovalCodec, recipes: RecipeStore,
  contracts: ContractStore, suites: RecipeRegressionStore, now: () => number = Date.now) => {
  initializePackUpdates(db);
  const history = createPackReleaseHistory(db,codec,recipes,contracts);
  const row = (slug: string): Row | undefined => db.prepare('SELECT * FROM pack_update_tracks WHERE pack_slug=?').get(slug) as Row | undefined;
  const installed = (slug: string) => contracts.get('installed_pack',[slug]);
  const version = (slug: string): number | null => getInstalledPack(contracts,slug)?.version ?? null;
  const baseline = (_slug: string, target: PreparedPackUpdate): { digest: string; before: Record<string,string | null> } => {
    const before: Record<string,string | null> = Object.create(null);
    const packs = packUpdateMembers(target).map(pack => {
      const slug = pack.manifest.slug, owned = db.prepare('SELECT * FROM recipes WHERE pack_slug=? ORDER BY recipe_id').all(slug);
      for (const entry of pack.recipes) {
        const stored = recipes.getStored(entry.slug);
        if (stored && (stored.pack_slug !== slug || digest(recipes.get(entry.slug)) !== digest(JSON.parse(stored.recipe_json)))) conflict('Recipe ownership or its runtime body changed.');
        before[entry.slug] = stored?.recipe_json ?? null;
      }
      return { pack: installed(slug),owned };
    });
    const requirements = (target.requirements ?? []).map(item => installed(item.pack_slug));
    return { digest: target.dependencies?.length ? digest({ packs,before,requirements })
      : digest({ pack: packs[0]!.pack,owned: packs[0]!.owned,before }),before };
  };
  const planOwner = (slug: string): void => {
    const owner = packUpdatePlanOwner(db,slug);
    if (owner && owner !== slug) conflict(`This pack belongs to the staged ${owner} update. Review that complete plan in Packs.`);
  };
  const checkRow = (saved: Row | undefined, slug: string, check: () => void): void => {
    check(); codec.assertUnlocked(); if (JSON.stringify(row(slug)) !== JSON.stringify(saved)) conflict();
  };
  const load = async (slug: string, check: () => void): Promise<{ row: Row | undefined; state: State | null; history: PackReleaseHistorySnapshot }> => {
    check(); planOwner(slug); const saved = row(slug);
    if (!saved || saved.deleted) return { row: saved,state: null,history: history.empty(slug) };
    codec.assertUnlocked();
    const opened = await codec.open(saved.encrypted); checkRow(saved,slug,check);
    const state = opened as State;
    if (!state || state.schema_version !== 1 || state.pack_slug !== slug || state.revision !== saved.revision
      || !state.target || state.target.manifest.slug !== slug || !Array.isArray(state.target.recipes)
      || !state.target.recipes.length || packUpdateMembers(state.target).length > LIMIT.packs
      || packUpdateRecipes(state.target).length > LIMIT.recipes || regressionBytes(state) > LIMIT.bytes) conflict('The sealed update does not match its identity.');
    const releases = await history.load(slug,check); checkRow(saved,slug,check);
    return { row: saved,state,history: releases };
  };
  const suiteMatches = (proof: PackUpdateQualification): boolean => proof.suites.every(suite => {
    const current = suites.history(suite.recipe_id);
    return current.head_revision === suite.revision && current.versions[0]?.revision === suite.revision && current.versions[0]?.digest === suite.digest;
  });
  const restoreCurrent = (state: State): boolean => !state.restore || history.identity(state.pack_slug) === state.restore.history_identity
    && packReleaseEnvironment(contracts,state.target) === state.restore.surrounding_inventory;
  const valid = (state: State, actor: string): boolean => {
    const proof = state.qualification;
    return !state.released && !!proof && proof.actor === actor && proof.attempt_id === row(state.pack_slug)?.attempt_id
      && proof.expires_at > now() && proof.passed > 0 && proof.suites.length === packUpdateRecipes(state.target).length
      && suiteMatches(proof) && restoreCurrent(state) && baseline(state.pack_slug,state.target).digest === state.baseline;
  };
  const applied = (state: State): boolean => packUpdateMembers(state.target).every(pack => version(pack.manifest.slug) === pack.manifest.version
    && pack.recipes.every(entry => digest(recipes.get(entry.slug)) === digest(entry.recipe!.recipe)));
  const view = (slug: string, saved: Row | undefined, state: State | null, actor: string, releases: PackReleaseHistorySnapshot): PackUpdateView => {
    const proof = state && valid(state,actor) ? state.qualification : null;
    const receipt = [...state?.receipts ?? []].reverse().find(item => item.actor === actor)?.receipt;
    return { pack_slug: slug,managed: !!state,revision: saved?.revision ?? 0,installed_version: version(slug),applied: !!state && !state.released && applied(state),
      candidate: state && !state.released ? { version: state.target.manifest.version,name: state.target.manifest.name,
        source: state.target.source,manifest_hash: state.manifest_hash,digest: packUpdateIdentity(state.target),
        recipes: packUpdateMembers(state.target).flatMap(pack => pack.recipes.map(entry => ({ recipe_id: entry.slug,pack_slug: pack.manifest.slug,
          before: state.before[entry.slug] ? JSON.parse(state.before[entry.slug]!) : null,after: structuredClone(entry.recipe!.recipe) }))),
        ...(state.target.dependencies?.length ? { packs: packUpdateMembers(state.target).map(pack => ({ pack_slug: pack.manifest.slug,name: pack.manifest.name,
          installed_version: state.pack_versions?.[pack.manifest.slug] ?? version(pack.manifest.slug) ?? 0,version: pack.manifest.version,
          dependencies: (pack.manifest.dependencies ?? []).filter(dependency => dependency.type === 'pack').map(dependency => dependency.slug) })) } : {}),
        ...(state.restore ? { restore: { release_id: state.restore.release_id,sequence: state.restore.sequence,created_at: state.restore.created_at,digest: state.restore.digest } } : {}) } : null,
      qualification: proof ? { review_id: proof.review_id,expires_at: proof.expires_at,passed: proof.passed,suites: structuredClone(proof.suites) } : null,
      ...(receipt ? { last_apply: structuredClone(receipt) } : {}),
      ...(releases.state.releases.length ? { releases: history.summaries(releases) } : {}) };
  };
  const write = (saved: Row | undefined, state: State, encrypted: string, check: () => void): Row => {
    checkRow(saved,state.pack_slug,check);
    if ((!saved || saved.deleted) && (db.prepare('SELECT count(*) FROM pack_update_tracks WHERE deleted=0').pluck().get() as number) >= LIMIT.tracks) throw new RpcError('pack_update_limit','Keep at most 100 protected packs.',409);
    const retained = db.prepare('SELECT coalesce(sum(length(CAST(encrypted AS BLOB))),0) FROM pack_update_tracks WHERE pack_slug<>?').pluck().get(state.pack_slug) as number;
    if (retained + Buffer.byteLength(encrypted,'utf8') > LIMIT.retained_bytes) throw new RpcError('pack_update_limit','Saved pack update storage is full. Remove an unused protected pack first.',409);
    if (!saved || saved.deleted) db.prepare('DELETE FROM pack_release_history WHERE pack_slug=?').run(state.pack_slug);
    db.prepare(`INSERT INTO pack_update_tracks VALUES(?,?,0,?,?) ON CONFLICT(pack_slug) DO UPDATE SET
      revision=excluded.revision,deleted=0,encrypted=excluded.encrypted,attempt_id=excluded.attempt_id`)
      .run(state.pack_slug,state.revision,encrypted,saved?.attempt_id ?? '');
    planOwner(state.pack_slug);
    db.prepare('DELETE FROM pack_update_members WHERE pack_slug=?').run(state.pack_slug);
    db.prepare('DELETE FROM pack_update_plan_packs WHERE plan_slug=?').run(state.pack_slug);
    for (const pack of state.released ? [state.target] : packUpdateMembers(state.target)) {
      const slug = pack.manifest.slug, existingOwner = packUpdatePlanOwner(db,slug);
      if (existingOwner && existingOwner !== state.pack_slug) conflict('Another staged plan already owns an affected pack.');
      if (state.target.dependencies?.length && !state.released) db.prepare('INSERT INTO pack_update_plan_packs VALUES(?,?)').run(slug,state.pack_slug);
      const members = new Set([...pack.recipes.map(entry => entry.slug),
        ...(db.prepare('SELECT recipe_id FROM recipes WHERE pack_slug=?').pluck().all(slug) as string[])]);
      for (const id of members) {
        const claimed = db.prepare('SELECT pack_slug FROM pack_update_members WHERE recipe_id=?').pluck().get(id) as string | undefined;
        if (claimed && claimed !== state.pack_slug && claimed !== slug) conflict('Another protected pack already owns a candidate recipe.');
        if (!claimed) db.prepare('INSERT INTO pack_update_members VALUES(?,?)').run(id,state.pack_slug);
      }
    }
    return row(state.pack_slug)!;
  };
  const seal = async (state: State): Promise<string> => {
    if (regressionBytes(state) > LIMIT.bytes) throw new RpcError('pack_update_limit','Keep the staged pack and its previous recipes under 4 MB.',409);
    return codec.seal(state);
  };
  const reviewed = async (manifest: BulkPackManifest, reviewId: string | undefined, actor: string, check: () => void) => {
    const slug = manifest.slug, snapshot = await load(slug,check), state = snapshot.state;
    if (!state || state.restore || !reviewId || !valid(state,actor) || state.qualification!.review_id !== reviewId
      || digest(manifest) !== digest(state.target.manifest)) conflict('Stage this exact update and run its latest saved tests before updating.');
    const proof = state!.qualification!;
    const live = (): void => {
      checkRow(snapshot.row,slug,check);
      if (proof.expires_at <= now() || !suiteMatches(proof)) conflict('The passing update review expired or its tests changed. Run the tests again.');
    };
    const baselineCheck = (): void => { live(); if (baseline(slug,state!.target).digest !== state!.baseline) conflict(); };
    baselineCheck(); return { state: state!,live,baselineCheck };
  };
  return {
    codec,
    managed: (slug: string): boolean => !!packUpdatePlanOwner(db,slug) || !!db.prepare('SELECT 1 FROM pack_update_tracks WHERE pack_slug=? AND deleted=0').get(slug),
    retire: (slug: string): void => retirePackUpdates(db,slug),
    async read(slug: string, actor: string, check: () => void): Promise<PackUpdateView> {
      const snapshot = await load(slug,check); return view(slug,snapshot.row,snapshot.state,actor,snapshot.history);
    },
    async stage(request: PackUpdateStage, actor: string, check: () => void, prepare: () => Promise<PreparedPackUpdate>): Promise<PackUpdateView> {
      request = structuredClone(request); const snapshot = await load(request.pack_slug,check), hash = digest(request);
      if (snapshot.state?.receipts?.some(item => item.receipt.request_id === request.request_id)) conflict('That request ID already names a completed apply.');
      if (snapshot.state?.request_id === request.request_id) {
        if (snapshot.state.request_hash !== hash) conflict('That request id already names a different update.');
        return view(request.pack_slug,snapshot.row,snapshot.state,actor,snapshot.history);
      }
      if ((snapshot.row?.revision ?? 0) !== request.expected_revision) conflict();
      const target = structuredClone(await prepare()); checkRow(snapshot.row,request.pack_slug,check);
      if (target.manifest.slug !== request.pack_slug || version(request.pack_slug) === null || version(request.pack_slug)! >= target.manifest.version) conflict();
      if (target.dependencies?.length) {
        if (request.include_dependencies !== true) throw new RpcError('pack_update_unsupported','Opt in to staging required dependency upgrades before reserving the group.',409);
        assertPackUpdateGroup(target,{ recipeStore: recipes,contractStore: contracts });
      }
      assertPackUpdateRequirements(target,contracts);
      const base = baseline(request.pack_slug,target);
      const state: State = { schema_version: 1,pack_slug: request.pack_slug,revision: request.expected_revision + 1,
        request_id: request.request_id,request_hash: hash,manifest_hash: request.expected_manifest_hash,baseline: base.digest,target,before: base.before,qualification: null,
        pack_versions: Object.fromEntries(packUpdateMembers(target).map(pack => [pack.manifest.slug,version(pack.manifest.slug)!])),receipts: snapshot.state?.receipts ?? [] };
      const encrypted = await seal(state);
      const saved = db.transaction(() => { assertPackUpdateRequirements(target,contracts); if (baseline(request.pack_slug,target).digest !== base.digest) conflict(); return write(snapshot.row,state,encrypted,check); }).immediate();
      return view(request.pack_slug,saved,state,actor,snapshot.history);
    },
    async stageRestore(request: PackRestoreStage, actor: string, check: () => void,
      prepare: (target: PreparedPackUpdate) => PreparedPackUpdate | Promise<PreparedPackUpdate>): Promise<PackUpdateView> {
      request = structuredClone(request); const snapshot = await load(request.pack_slug,check), hash = digest({ kind: 'restore',...request });
      const prior = snapshot.state;
      if (!prior || prior.receipts?.some(item => item.receipt.request_id === request.request_id)) conflict('Choose a retained release from this protected pack.');
      if (prior!.request_id === request.request_id) {
        if (prior!.request_hash !== hash) conflict('That request ID already names a different staged update.');
        return view(request.pack_slug,snapshot.row,prior,actor,snapshot.history);
      }
      if (prior!.revision !== request.expected_revision || applying.get(db)?.has(request.pack_slug)) conflict();
      const release = snapshot.history.state.releases.find(item => item.release_id === request.release_id);
      if (!release) throw new RpcError('not_found','This release is no longer retained. Reload release history.',404);
      const target = structuredClone(await prepare(packReleaseArtifact(release.target))); checkRow(snapshot.row,request.pack_slug,check); history.assert(snapshot.history,check);
      if (release.digest !== packReleaseDigest(target,release.surrounding_inventory)) conflict('The runtime mapping changed the retained artifact. Restore requires a separate review.');
      if (packReleaseEnvironment(contracts,target) !== release.surrounding_inventory) conflict('The surrounding pack inventory changed since this release. A separate update review is required.');
      if (applied({ ...prior!,target })) conflict('This complete release is already installed.');
      const dependencies = [...new Set(packUpdateMembers(target).flatMap(pack => (pack.manifest.dependencies ?? [])
        .filter(dependency => dependency.type === 'pack').map(dependency => dependency.slug)))];
      target.requirements = dependencies.map(pack_slug => ({ pack_slug,inventory_digest: digest(installed(pack_slug)) }));
      assertPackUpdateGroup(target,{ recipeStore: recipes,contractStore: contracts });
      const base = baseline(request.pack_slug,target), state: State = { schema_version: 1,pack_slug: request.pack_slug,revision: request.expected_revision + 1,
        request_id: request.request_id,request_hash: hash,manifest_hash: recordsManifestReviewHash(target.manifest),baseline: base.digest,target,before: base.before,qualification: null,
        pack_versions: Object.fromEntries(packUpdateMembers(target).map(pack => [pack.manifest.slug,version(pack.manifest.slug)!])),receipts: prior!.receipts ?? [],
        restore: { release_id: release.release_id,sequence: release.sequence,created_at: release.created_at,digest: release.digest,
          history_identity: history.identity(request.pack_slug),surrounding_inventory: release.surrounding_inventory } };
      const encrypted = await seal(state);
      const saved = db.transaction(() => {
        history.assert(snapshot.history,check);
        if (!restoreCurrent(state) || baseline(request.pack_slug,target).digest !== base.digest) conflict();
        return write(snapshot.row,state,encrypted,check);
      }).immediate();
      return view(request.pack_slug,saved,state,actor,snapshot.history);
    },
    async beginTest(slug: string, expected: number, check: () => void) {
      const attempt = randomUUID();
      db.transaction(() => { check(); codec.assertUnlocked(); const saved = row(slug);
        if (!saved || saved.deleted || saved.revision !== expected) conflict();
        db.prepare('UPDATE pack_update_tracks SET attempt_id=? WHERE pack_slug=?').run(attempt,slug);
      }).immediate();
      const snapshot = await load(slug,check), state = snapshot.state;
      if (!state || state.released || state.revision !== expected || !restoreCurrent(state) || baseline(slug,state.target).digest !== state.baseline) conflict();
      state!.qualification = null; const encrypted = await seal(state!);
      db.transaction(() => { write(snapshot.row,state!,encrypted,check); }).immediate();
      return { target: structuredClone(state!.target),recipes: structuredClone(packUpdateRecipes(state!.target)),attempt };
    },
    async qualify(slug: string, expected: number, attempt: string, results: RecipeRegressionResult[], actor: string, check: () => void): Promise<PackUpdateView> {
      const snapshot = await load(slug,check), state = snapshot.state;
      if (!state || state.revision !== expected || snapshot.row?.attempt_id !== attempt || !restoreCurrent(state) || baseline(slug,state.target).digest !== state.baseline) conflict();
      const target = state!.target;
      if (results.length !== packUpdateRecipes(target).length || new Set(results.map(result => result.recipe_id)).size !== results.length) conflict();
      const passing = results.every(result => {
        const candidate = packUpdateRecipes(target).find(entry => entry.slug === result.recipe_id);
        if (!candidate || result.candidate_hash !== digest(candidate.recipe!.recipe)) conflict();
        return result.failed === 0 && result.passed > 0 && result.passed === result.cases.length
          && result.cases.every(test => test.candidate.passed && test.candidate.assertions.every(assertion => assertion.passed));
      });
      const proof = { actor,attempt_id: attempt,review_id: randomUUID(),expires_at: now() + LIMIT.qualification_ms,
        passed: results.reduce((sum,result) => sum + result.passed,0),
        suites: results.map(result => ({ recipe_id: result.recipe_id,revision: result.revision,digest: result.suite_digest })) };
      if (!suiteMatches(proof)) conflict('Saved tests changed during this update test. Run the latest suites again.');
      state!.qualification = passing ? proof : null; const encrypted = await seal(state!);
      const saved = db.transaction(() => { if (!suiteMatches(proof) || !restoreCurrent(state!) || baseline(slug,target).digest !== state!.baseline) conflict(); return write(snapshot.row,state!,encrypted,check); }).immediate();
      return view(slug,saved,state!,actor,snapshot.history);
    },
    async releaseGroup(request: PackUpdateRelease, actor: string, check: () => void): Promise<PackUpdateView> {
      request = structuredClone(request); const snapshot = await load(request.pack_slug,check), state = snapshot.state;
      const hash = digest({ kind: 'release',...request });
      if (state?.receipts?.some(item => item.receipt.request_id === request.request_id)) conflict('That request ID already names a completed apply.');
      if (state?.request_id === request.request_id) {
        if (state.request_hash !== hash) conflict('That request ID names a different staged update.');
        return view(request.pack_slug,snapshot.row,state,actor,snapshot.history);
      }
      if (!state?.target.dependencies?.length || state.revision !== request.expected_revision || applying.get(db)?.has(request.pack_slug)) {
        conflict('Wait for any apply to finish, then reload this dependency plan before releasing it.');
      }
      const next: State = { ...state!,released: true,qualification: null,revision: request.expected_revision + 1,request_id: request.request_id,request_hash: hash };
      const encrypted = await seal(next);
      const saved = db.transaction(() => {
        if (applying.get(db)?.has(request.pack_slug)) conflict('Wait for the dependency update to finish.');
        return write(snapshot.row,next,encrypted,check);
      }).immediate();
      return view(request.pack_slug,saved,next,actor,snapshot.history);
    },
    async applyGroup(request: PackUpdateApply, actor: string, check: () => void,
      prepare: (target: PreparedPackUpdate, restore?: boolean) => Promise<PreparedPackUpdate>, writeRecipes: (target: PreparedPackUpdate, permit: object, at: number) => void): Promise<PackUpdateApplyResult> {
      request = structuredClone(request); check(); codec.assertUnlocked();
      let active = applying.get(db); if (!active) { active = new Set(); applying.set(db,active); }
      if (active.has(request.pack_slug)) conflict('This plan is already applying. Reload its receipt or retry after it finishes.');
      active.add(request.pack_slug);
      try {
        if (recipes.realmDatabase !== db || contracts.realmDatabase !== db) {
          throw new RpcError('pack_update_unsupported','Grouped updates require the built-in stores on the same realm.',409);
        }
        const snapshot = await load(request.pack_slug,check), state = snapshot.state, hash = digest(request);
        const prior = state?.receipts?.find(item => item.receipt.request_id === request.request_id);
        if (prior) {
          if (prior.actor !== actor || prior.hash !== hash) conflict('That request ID already names another reviewed update.');
          return { ...view(request.pack_slug,snapshot.row,state,actor,snapshot.history),receipt: structuredClone(prior.receipt) };
        }
        if (state?.request_id === request.request_id) conflict('That request ID already names a stage or release.');
        if (!state || state.revision !== request.expected_revision || !state.target.dependencies?.length
          || !valid(state,actor) || state.qualification?.review_id !== request.review_id) conflict('Review and test this exact dependency update before applying it.');
        const selected = state!, fresh = await prepare(structuredClone(selected.target),!!selected.restore); checkRow(snapshot.row,request.pack_slug,check);
        if (packUpdateIdentity(fresh) !== packUpdateIdentity(selected.target)) conflict('A candidate dependency or recipe changed. Restage and test the complete plan again.');
        assertPackUpdateRequirements(selected.target,contracts);
        assertPackUpdateGroup(selected.target,{ recipeStore: recipes,contractStore: contracts });
        const at = now(), capture = await history.prepare(snapshot.history,selected.target,request.request_id,at,check);
        checkRow(snapshot.row,request.pack_slug,check);
        const receipt: PackUpdateApplyReceipt = { request_id: request.request_id,plan_digest: packUpdateIdentity(selected.target),applied_at: at,
          packs: packUpdateMembers(selected.target).map(pack => ({ pack_slug: pack.manifest.slug,version: pack.manifest.version })),release_id: capture.release_id,
          ...(selected.restore ? { restored_release_id: selected.restore.release_id } : {}) };
        const next: State = { ...selected,qualification: null,receipts: [...selected.receipts ?? [],{ actor,hash,receipt }].slice(-LIMIT.receipts) };
        const encrypted = await seal(next); checkRow(snapshot.row,request.pack_slug,check);
        const entries = new Map(packUpdateMembers(selected.target).flatMap(pack => pack.recipes.map(entry => [entry.slug,
          { pack_slug: pack.manifest.slug,before: selected.before[entry.slug] ?? null,after: digest(entry.recipe!.recipe),written: false }] as const)));
        commitLocalTransaction(db,() => {
          checkRow(snapshot.row,request.pack_slug,check);
          if (!valid(selected,actor)) conflict();
          assertPackUpdateRequirements(selected.target,contracts);
          withPackUpdateAuthoritySync({ db,pack_slug: request.pack_slug,recipes: entries,check: () => {
            checkRow(snapshot.row,request.pack_slug,check);
            if (selected.qualification!.expires_at <= now() || !suiteMatches(selected.qualification!)) conflict();
          } },permit => writeRecipes(selected.target,permit,at));
          if (!applied(selected) || [...entries.values()].some(entry => !entry.written)) conflict('The full dependency update did not commit.');
          capture.commit();
          write(snapshot.row,next,encrypted,check);
          db.prepare('DELETE FROM pack_update_plan_packs WHERE plan_slug=?').run(request.pack_slug);
          db.prepare('DELETE FROM pack_update_members WHERE pack_slug=? AND recipe_id IN (SELECT recipe_id FROM recipes WHERE pack_slug<>?)').run(request.pack_slug,request.pack_slug);
        });
        check(); codec.assertUnlocked();
        return { ...view(request.pack_slug,row(request.pack_slug),next,actor,capture.snapshot),receipt: structuredClone(receipt) };
      } finally { active.delete(request.pack_slug); }
    },
    async review(manifest: BulkPackManifest, reviewId: string | undefined, actor: string, check: () => void): Promise<() => void> {
      return (await reviewed(manifest,reviewId,actor,check)).baselineCheck;
    },
    async authorize(manifest: BulkPackManifest, resolved: BulkPackInstallRecipe[], reviewId: string | undefined, actor: string, check: () => void) {
      const slug = manifest.slug, { state,live,baselineCheck } = await reviewed(manifest,reviewId,actor,check);
      if (identity(manifest,resolved) !== identity(state.target.manifest,state.target.recipes)) conflict('Stage this exact update and run its latest saved tests before updating.');
      const entries = new Map(state.target.recipes.map(entry => [entry.slug,{ before: state.before[entry.slug] ?? null,after: digest(entry.recipe!.recipe),written: false }]));
      return async <T>(writeRecipes: (permit: object) => Promise<T>): Promise<T> => {
        let active = applying.get(db); if (!active) { active = new Set(); applying.set(db,active); }
        if (active.has(slug)) conflict('This pack update is already applying. Wait for it to finish, then reload protection.');
        active.add(slug);
        try {
          baselineCheck();
          return await withPackUpdateAuthority({ db,pack_slug: slug,recipes: entries,check: live },writeRecipes);
        } finally { active.delete(slug); }
      };
    },
  };
};
export type PackUpdateStore = ReturnType<typeof createPackUpdateStore>;
