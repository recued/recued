/** Encrypted, bounded one-shot removal reviews. Consuming a review precedes
 * uninstall's existing lifecycle. An interrupted attempt never resumes effects. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError,regressionBytes,type PackRemovalPlan,type PackRemovalReview,type PackRemovalApply,
  type PackRemovalApplyResult,type PackRemovalReceipt,type BulkPackUninstallResultLike,type PackRemovalPack } from '@recued/contracts';
import type { PreapprovalCodec } from './preapproval-codec.js';
import type { PackUninstallRpcDeps } from '../pack-uninstall-handler.js';
import { preparePackRemoval } from '../pack-removal-plan.js';
import { recipeReleaseDigest as digest } from './recipe-release-authority.js';

const LIMIT = { reviews: 200,bytes: 1_000_000,retained_bytes: 8_000_000,ttl: 5 * 60_000 };
interface Row { review_id: string; actor_hash: string; request_id: string; pack_slug: string; created_at: number; phase: string; encrypted: string }
interface State {
  schema_version: 1; actor: string; request: PackRemovalReview; plan: PackRemovalPlan; fingerprint: string;
  phase: 'reviewed' | 'applying' | 'complete'; apply?: PackRemovalApply; receipt?: PackRemovalReceipt;
  previous_attempt_id?: string;
  inventory_fingerprint?: string;
}
interface ActiveRemoval { review_id: string; previous_attempt_id?: string }
const active = new WeakMap<Database.Database,Map<string,ActiveRemoval>>();
export const packRemovalActive = (db: Database.Database,key: string): boolean => active.get(db)?.has(key) === true;

/** Owner-only repair reads authenticate the sealed historical identity before
 * treating an interrupted removal as evidence for local cleanup. */
export const readPackRemovalEvidence = async (db: Database.Database,codec: PreapprovalCodec,key: string) => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='pack_removal_reviews'").get()) return undefined;
  const row = db.prepare("SELECT * FROM pack_removal_reviews WHERE pack_slug=? AND phase IN ('applying','complete') ORDER BY rowid DESC LIMIT 1").get(key) as Row | undefined;
  if (!row) return undefined;
  try {
    const state = await codec.open(row.encrypted) as State;
    codec.assertUnlocked();
    if (state?.schema_version !== 1 || state.phase !== row.phase || state.plan?.review_id !== row.review_id
      || state.plan.pack.inventory_key !== key || digest(state.actor) !== row.actor_hash
      || !Array.isArray(state.plan.recipes) || state.plan.recipes.some(id => typeof id !== 'string')
      || state.request?.request_id !== row.request_id || regressionBytes(state) > LIMIT.bytes) return { row,unreadable: true as const };
    return { row,unreadable: false as const,pack: state.plan.pack,inventory_fingerprint: state.inventory_fingerprint,
      recipes: structuredClone(state.plan.recipes) };
  } catch { codec.assertUnlocked();return { row,unreadable: true as const }; }
};
const conflict = (message = 'This removal review changed. Review the current installation again.'): never => { throw new RpcError('pack_removal_conflict',message,409); };
export const createPackRemovalStore = (db: Database.Database,codec: PreapprovalCodec,deps: PackUninstallRpcDeps,now: () => number = Date.now) => {
  db.exec(`CREATE TABLE IF NOT EXISTS pack_removal_reviews (
    review_id TEXT PRIMARY KEY, actor_hash TEXT NOT NULL, request_id TEXT NOT NULL, pack_slug TEXT NOT NULL,
    created_at INTEGER NOT NULL, phase TEXT NOT NULL, encrypted TEXT NOT NULL, UNIQUE(actor_hash,request_id))`);
  const row = (id: string): Row | undefined => db.prepare('SELECT * FROM pack_removal_reviews WHERE review_id=?').get(id) as Row | undefined;
  const assert = (saved: Row | undefined,id: string,check: () => void): void => {
    check();codec.assertUnlocked();if (JSON.stringify(row(id)) !== JSON.stringify(saved)) conflict();
  };
  const load = async (id: string,actor: string,check: () => void) => {
    check();codec.assertUnlocked();const saved = row(id);
    if (!saved || saved.actor_hash !== digest(actor)) throw new RpcError('not_found','This removal review is unavailable for this paired client.',404);
    const state = await codec.open(saved.encrypted) as State;assert(saved,id,check);
    if (!state || state.schema_version !== 1 || state.actor !== actor || state.plan?.review_id !== id || state.plan.pack.inventory_key !== saved.pack_slug
      || state.request.request_id !== saved.request_id || state.phase !== saved.phase || regressionBytes(state) > LIMIT.bytes) conflict('The sealed removal review does not match its identity.');
    return { row: saved,state };
  };
  const seal = (state: State) => {
    if (regressionBytes(state) > LIMIT.bytes) throw new RpcError('pack_removal_limit','Keep a removal review under 1 MB.',409);
    return codec.seal(state);
  };
  const installedNow = (state: State): boolean => !!deps.contractStore?.get('installed_pack',[state.plan.pack.inventory_key])
    || deps.recipeStore.listForPack(state.plan.pack.inventory_key).length > 0
    || !!state.plan.records && deps.recordsStore?.getNamespace(state.plan.records)?.state.state === 'ready';
  const previousAttempt = (pack: string,exclude = ''): { review_id: string; phase: string } | undefined =>
    db.prepare("SELECT review_id,phase FROM pack_removal_reviews WHERE pack_slug=? AND review_id<>? AND phase IN ('applying','complete') ORDER BY rowid DESC LIMIT 1")
      .get(pack,exclude) as { review_id: string; phase: string } | undefined;
  const assertPrevious = (state: State): void => {
    if (previousAttempt(state.plan.pack.inventory_key,state.plan.review_id)?.review_id !== state.previous_attempt_id) {
      conflict('Another removal attempt started after this review. Inspect its outcome and review the current installation again.');
    }
  };
  const quota = (id: string,encrypted: string,previous?: string): void => {
    const pinned = new Set<string>();if (previous) pinned.add(previous);
    for (const item of active.get(db)?.values() ?? []) {
      pinned.add(item.review_id);if (item.previous_attempt_id) pinned.add(item.previous_attempt_id);
    }
    let rows = db.prepare('SELECT review_id,pack_slug,length(CAST(encrypted AS BLOB)) AS bytes FROM pack_removal_reviews WHERE review_id<>? ORDER BY created_at,review_id').all(id) as Array<{ review_id: string; pack_slug: string; bytes: number }>;
    let bytes = rows.reduce((sum,item) => sum + item.bytes,Buffer.byteLength(encrypted));
    while (rows.length >= LIMIT.reviews || bytes > LIMIT.retained_bytes) {
      const first = rows.find(item => !pinned.has(item.review_id));
      if (!first) throw new RpcError('pack_removal_limit','Removal review storage is busy. Try again after active removals finish.',409);
      db.prepare('DELETE FROM pack_removal_reviews WHERE review_id=?').run(first.review_id);bytes -= first.bytes;rows = rows.filter(item => item !== first);
    }
  };
  const save = (saved: Row,state: State,encrypted: string,check: () => void): Row => {
    assert(saved,state.plan.review_id,check);assertPrevious(state);quota(saved.review_id,encrypted,state.previous_attempt_id);
    db.prepare('UPDATE pack_removal_reviews SET phase=?,encrypted=? WHERE review_id=?').run(state.phase,encrypted,saved.review_id);return row(saved.review_id)!;
  };
  return {
    async review(request: PackRemovalReview,actor: string,check: () => void): Promise<PackRemovalPlan> {
      request = structuredClone(request);check();codec.assertUnlocked();
      const prior = db.prepare('SELECT review_id FROM pack_removal_reviews WHERE actor_hash=? AND request_id=?').pluck().get(digest(actor),request.request_id) as string | undefined;
      if (prior) { const saved = await load(prior,actor,check);if (digest(saved.state.request) !== digest(request)) conflict('That request ID already names another removal review.');return structuredClone(saved.state.plan); }
      const prepared = await preparePackRemoval(deps,request);check();codec.assertUnlocked();
      const previous = previousAttempt(prepared.impact.pack.inventory_key);
      const plan: PackRemovalPlan = { ...prepared.impact,review_id: randomUUID(),expires_at: now() + LIMIT.ttl,
        prior_attempt_unconfirmed: previous?.phase === 'applying' };
      if (active.get(db)?.has(plan.pack.inventory_key)) plan.blockers.push({ code: 'in_flight',message: 'A removal is still running. Wait for it to finish, then review again.' });
      const state: State = { schema_version: 1,actor,request,plan,fingerprint: prepared.fingerprint,phase: 'reviewed',
        inventory_fingerprint: digest(deps.contractStore?.get('installed_pack',[plan.pack.inventory_key]) ?? null),
        ...(previous ? { previous_attempt_id: previous.review_id } : {}) },encrypted = await seal(state);
      const inserted = db.transaction(() => {
        const raced = db.prepare('SELECT review_id FROM pack_removal_reviews WHERE actor_hash=? AND request_id=?').pluck().get(digest(actor),request.request_id) as string | undefined;
        if (raced) return raced;
        check();codec.assertUnlocked();prepared.assertCurrent();assertPrevious(state);quota(plan.review_id,encrypted,state.previous_attempt_id);
        db.prepare('INSERT INTO pack_removal_reviews VALUES(?,?,?,?,?,?,?)').run(plan.review_id,digest(actor),request.request_id,plan.pack.inventory_key,now(),'reviewed',encrypted);
        return plan.review_id;
      }).immediate();
      if (inserted !== plan.review_id) {
        const winner = await load(inserted,actor,check);if (digest(winner.state.request) !== digest(request)) conflict('That request ID already names another removal review.');return structuredClone(winner.state.plan);
      }
      return structuredClone(plan);
    },
    async apply(request: PackRemovalApply,actor: string,check: () => void,
      execute: (target: PackRemovalReview,controls: { check(): void; beforeMutation(): void;identity: PackRemovalPack }) => Promise<BulkPackUninstallResultLike>): Promise<PackRemovalApplyResult> {
      request = structuredClone(request);const snapshot = await load(request.review_id,actor,check), state = snapshot.state;
      if (state.phase === 'complete') { if (digest(state.apply) !== digest(request)) conflict('That review already names another removal attempt.');return { receipt: structuredClone(state.receipt!),installed_now: installedNow(state) }; }
      if (state.phase === 'applying') {
        if (digest(state.apply) !== digest(request)) conflict('That review already names another removal attempt.');
        throw new RpcError('pack_removal_in_doubt','This removal attempt has no confirmed completion yet. Inspect the current installation and create a fresh review; effects are not retried.',409);
      }
      if (state.plan.blockers.length || state.plan.expires_at <= now()) conflict('Review an unblocked, current removal plan before confirming.');
      if (state.plan.unknown_dependencies.length && request.acknowledge_unknown_dependencies !== true) conflict('Acknowledge the packs with unknown dependency metadata before removal.');
      if (state.plan.prior_attempt_unconfirmed && request.acknowledge_incomplete_attempt !== true) conflict('Acknowledge the previous unconfirmed attempt after inspecting the current installation.');
      let slots = active.get(db);if (!slots) { slots = new Map();active.set(db,slots); }
      const slot = state.plan.pack.inventory_key;
      if (slots.has(slot)) throw new RpcError('pack_removal_busy','Wait for the active removal, then recover its receipt.',409);
      slots.set(slot,{ review_id: request.review_id,...(state.previous_attempt_id ? { previous_attempt_id: state.previous_attempt_id } : {}) });
      try {
        const prepared = await preparePackRemoval(deps,state.request);assert(snapshot.row,request.review_id,check);assertPrevious(state);
        if (prepared.fingerprint !== state.fingerprint) conflict('The installed state or removal impact changed. Review removal again.');
        const claimed: State = { ...state,phase: 'applying',apply: request },encrypted = await seal(claimed);
        const claimedRow = db.transaction(() => { prepared.assertCurrent();if (state.plan.expires_at <= now()) conflict('The removal review expired.');return save(snapshot.row,claimed,encrypted,check); }).immediate();
        const live = () => { assert(claimedRow,request.review_id,check);assertPrevious(state); };
        const target = { ...structuredClone(state.request),...(state.plan.records ? { pack_slug: state.plan.records.pack_slug,publisher: state.plan.records.publisher } : {}) };
        const result = await execute(target,{ identity: state.plan.pack,check: live,beforeMutation() {
          live();if (state.plan.expires_at <= now()) conflict('The removal review expired before mutation.');prepared.assertCurrent();
        } });
        live();const receipt: PackRemovalReceipt = { review_id: request.review_id,request_id: request.request_id,pack_slug: state.plan.pack.pack_slug,completed_at: now(),result };
        const complete: State = { ...claimed,phase: 'complete',receipt },sealed = await seal(complete);
        db.transaction(() => save(claimedRow,complete,sealed,check)).immediate();return { receipt: structuredClone(receipt),installed_now: installedNow(complete) };
      } finally { slots.delete(slot); }
    },
  };
};
export type PackRemovalStore = ReturnType<typeof createPackRemovalStore>;
