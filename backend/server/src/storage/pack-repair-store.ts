/** Repairs contain synchronous local writes only. The sealed completion receipt
 * commits in the same SQLite transaction as those writes: a crash rolls both
 * back or leaves an exactly recoverable receipt, never an effect replay gap. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, regressionBytes, type PackRepairReview, type PackRepairApply, type PackRepairPlan,
  type PackRepairReceipt, type PackRepairApplyResult } from '@recued/contracts';
import type { PreapprovalCodec } from './preapproval-codec.js';
import type { PackUninstallRpcDeps } from '../pack-uninstall-handler.js';
import { preparePackRepairs } from '../pack-repair-plan.js';
import { recipeReleaseDigest as digest } from './recipe-release-authority.js';

interface Row { review_id: string; actor_hash: string; request_id: string; created_at: number; phase: string; encrypted: string }
interface State {
  schema_version: 1; actor: string; request: PackRepairReview; plan: PackRepairPlan; fingerprint: string;
  phase: 'reviewed' | 'complete'; apply?: PackRepairApply; receipt?: PackRepairReceipt;
}
const LIMIT = { count: 200, bytes: 1_000_000, retained: 8_000_000, ttl: 5 * 60_000 };
const conflict = (message = 'This installation changed. Inspect and review repair again.'): never => { throw new RpcError('pack_repair_conflict', message, 409); };
export const createPackRepairStore = (db: Database.Database, codec: PreapprovalCodec, deps: PackUninstallRpcDeps, now: () => number = Date.now) => {
  db.exec(`CREATE TABLE IF NOT EXISTS pack_repair_reviews (
    review_id TEXT PRIMARY KEY, actor_hash TEXT NOT NULL, request_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    phase TEXT NOT NULL, encrypted TEXT NOT NULL, UNIQUE(actor_hash,request_id))`);
  const row = (id: string) => db.prepare('SELECT * FROM pack_repair_reviews WHERE review_id=?').get(id) as Row | undefined;
  const assert = (saved: Row, check: () => void) => { check();codec.assertUnlocked();if (digest(row(saved.review_id)) !== digest(saved)) conflict(); };
  const bounded = (state: State) => { if (regressionBytes(state) > LIMIT.bytes) throw new RpcError('pack_repair_limit', 'Keep a repair review under 1 MB.', 409);return codec.seal(state); };
  const load = async (id: string, actor: string, check: () => void) => {
    check();codec.assertUnlocked();const saved = row(id);
    if (!saved || saved.actor_hash !== digest(actor)) throw new RpcError('not_found', 'This repair review is unavailable for this paired client.', 404);
    const state = await codec.open(saved.encrypted) as State;assert(saved, check);
    if (state?.schema_version !== 1 || state.actor !== actor || state.plan?.review_id !== id || state.request?.request_id !== saved.request_id
      || state.phase !== 'reviewed' && state.phase !== 'complete'
      || state.phase !== saved.phase || regressionBytes(state) > LIMIT.bytes) conflict('The sealed repair review does not match its identity.');
    if (state.phase === 'complete' && (!state.apply || !state.receipt || state.apply.review_id !== id || state.receipt.review_id !== id
      || state.receipt.request_id !== state.apply.request_id || digest(state.receipt.pack) !== digest(state.plan.entry.pack))) conflict('The sealed repair receipt does not match its attempt.');
    return { saved, state };
  };
  const quota = (id: string, encrypted: string) => {
    const rows = db.prepare('SELECT review_id,length(CAST(encrypted AS BLOB)) AS bytes FROM pack_repair_reviews WHERE review_id<>? ORDER BY created_at,rowid').all(id) as Array<{ review_id: string; bytes: number }>;
    let bytes = Buffer.byteLength(encrypted) + rows.reduce((sum, item) => sum + item.bytes, 0);
    while (rows.length >= LIMIT.count || bytes > LIMIT.retained) {
      const oldest = rows.shift();if (!oldest) throw new RpcError('pack_repair_limit', 'Repair receipt storage is full.', 409);
      db.prepare('DELETE FROM pack_repair_reviews WHERE review_id=?').run(oldest.review_id);bytes -= oldest.bytes;
    }
  };
  const outcome = async (state: State, check: () => void): Promise<PackRepairApplyResult> => {
    check();codec.assertUnlocked();let pending = false;
    // Cache reconciliation is local, idempotent, and retryable on receipt recovery.
    for (const slug of state.plan.manifests_removed) {
      // Historical receipt recovery must not unregister a later installation.
      const present = db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_manifest'").get()
        && db.prepare('SELECT 1 FROM local_manifest WHERE slug=? LIMIT 1').get(slug);
      if (present) continue;
      try { if (!deps.registry) pending = true;deps.registry?.unregister(slug); } catch { pending = true; }
    }
    for (const name of state.plan.connections) {
      try {
        if (!deps.reconcileConnectionProfile) pending = true;
        deps.reconcileConnectionProfile?.(name);deps.reconcileWorkEntitySources?.(name);
      } catch { pending = true; }
    }
    try { deps.recipeRunnabilityBroadcast?.recomputeAndEmit(); } catch { pending = true; }
    let current: PackRepairApplyResult['current'];
    try { current = (await preparePackRepairs(deps, codec, check)).describe(state.request.inventory_key); }
    catch { check();codec.assertUnlocked(); }
    check();codec.assertUnlocked();
    return { receipt: structuredClone(state.receipt!), ...(current ? { current } : {}), reconciliation_pending: pending };
  };
  return {
    async inspect(actor: string, check: () => void) {
      const prepared = await preparePackRepairs(deps, codec, check), result = prepared.inspection(now());
      const recent = db.prepare("SELECT review_id FROM pack_repair_reviews WHERE actor_hash=? AND phase='complete' ORDER BY rowid DESC LIMIT 20").all(digest(actor)) as Array<{ review_id: string }>;
      for (const item of recent) {
        try {
          const { state } = await load(item.review_id, actor, check);
          result.recent_repairs.push({ request: structuredClone(state.apply!), receipt: structuredClone(state.receipt!) });
        } catch { check();codec.assertUnlocked();result.unavailable_receipts++; }
      }
      prepared.assertCurrent();return result;
    },
    async review(request: PackRepairReview, actor: string, check: () => void): Promise<PackRepairPlan> {
      request = structuredClone(request);check();codec.assertUnlocked();
      const prior = () => db.prepare('SELECT review_id FROM pack_repair_reviews WHERE actor_hash=? AND request_id=?').pluck().get(digest(actor), request.request_id) as string | undefined;
      const recover = async (id: string) => { const { state } = await load(id, actor, check);if (digest(state.request) !== digest(request)) conflict('That request ID already names another repair review.');return structuredClone(state.plan); };
      const existing = prior();if (existing) return recover(existing);
      const prepared = await preparePackRepairs(deps, codec, check);
      const plan: PackRepairPlan = { ...prepared.plan(request.inventory_key), review_id: randomUUID(), expires_at: now() + LIMIT.ttl };
      const { review_id: _id, expires_at: _expiry, ...reviewed } = plan;
      const state: State = { schema_version: 1, actor, request, plan, fingerprint: prepared.fingerprint, phase: 'reviewed' }, encrypted = await bounded(state);
      const winner = db.transaction(() => {
        check();codec.assertUnlocked();const raced = prior();if (raced) return raced;
        prepared.assertCurrent();if (digest(prepared.plan(request.inventory_key)) !== digest(reviewed)) conflict();
        quota(plan.review_id, encrypted);
        db.prepare('INSERT INTO pack_repair_reviews VALUES(?,?,?,?,?,?)').run(plan.review_id, digest(actor), request.request_id, now(), 'reviewed', encrypted);
        return plan.review_id;
      }).immediate();
      return winner === plan.review_id ? structuredClone(plan) : recover(winner);
    },
    async apply(request: PackRepairApply, actor: string, check: () => void): Promise<PackRepairApplyResult> {
      request = structuredClone(request);const { saved, state } = await load(request.review_id, actor, check);
      if (state.phase === 'complete') { if (digest(state.apply) !== digest(request)) conflict('That review already names another repair attempt.');return outcome(state, check); }
      const action = state.plan.action;
      if (action === 'none') throw new RpcError('pack_repair_conflict', 'This review has no supported local repair.', 409);
      if (state.plan.blockers.length || state.plan.expires_at <= now()) conflict('Review a current, unblocked repair plan before confirming.');
      if (request.acknowledge_local_cleanup !== true || state.plan.unknown_dependencies.length && request.acknowledge_unknown_dependencies !== true) conflict('Acknowledge the reviewed local cleanup and unknown dependency evidence.');
      const prepared = await preparePackRepairs(deps, codec, check), body = prepared.plan(state.request.inventory_key);
      const { review_id: _review, expires_at: _expires, ...reviewed } = state.plan;
      if (prepared.fingerprint !== state.fingerprint || digest(body) !== digest(reviewed)) conflict();
      const receipt: PackRepairReceipt = { review_id: request.review_id, request_id: request.request_id, completed_at: now(),
        pack: state.plan.entry.pack, action, changes: state.plan.changes };
      const complete: State = { ...state, phase: 'complete', apply: request, receipt }, encrypted = await bounded(complete);
      db.transaction(() => {
        assert(saved, check);prepared.assertCurrent();
        if (now() >= state.plan.expires_at || digest(prepared.plan(state.request.inventory_key)) !== digest(body)) conflict();
        quota(request.review_id, encrypted);prepared.mutate(body);
        check();codec.assertUnlocked();
        db.prepare("UPDATE pack_repair_reviews SET phase='complete',encrypted=? WHERE review_id=?").run(encrypted, request.review_id);
      }).immediate();
      return outcome(complete, check);
    },
  };
};
