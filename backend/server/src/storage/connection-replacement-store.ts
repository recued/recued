/** The sealed completion receipt and every reference edit share one synchronous
 * SQLite commit. No provider request or credential mutation occurs here. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, regressionBytes, type ConnectionReplacementReview as Review,
  type ConnectionReplacementRollback as Rollback, type ConnectionReplacementPlan as Plan,
  type ConnectionReplacementApply as Apply, type ConnectionReplacementReceipt as Receipt,
  type ConnectionReplacementResult as Result, type ConnectionReplacementInspection as Inspection,
  type ConnectionReplacementInspect as Inspect } from '@recued/contracts';
import type { PreapprovalCodec } from './preapproval-codec.js';
import { recipeReleaseDigest as digest } from './recipe-release-authority.js';
import { prepareConnectionReplacement, replacementConflict as conflict,
  type ConnectionReplacementDeps, type ReplacementEdits } from '../connection-replacement-plan.js';
interface Row { review_id: string; actor_hash: string; request_id: string; created_at: number; phase: string; encrypted: string }
interface State {
  schema_version: 1; actor: string; request: { kind: 'replace'; value: Review } | { kind: 'rollback'; value: Rollback };
  plan: Plan; fingerprint: string; edits: ReplacementEdits; phase: 'reviewed' | 'complete'; apply?: Apply; receipt?: Receipt;
}
const LIMIT = { count: 200, bytes: 1_000_000, retained: 8_000_000, ttl: 5 * 60_000 };
export const createConnectionReplacementStore = (db: Database.Database, codec: PreapprovalCodec, deps: ConnectionReplacementDeps, now: () => number = Date.now) => {
  db.exec(`CREATE TABLE IF NOT EXISTS connection_replacement_reviews (
    review_id TEXT PRIMARY KEY, actor_hash TEXT NOT NULL, request_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    phase TEXT NOT NULL, encrypted TEXT NOT NULL, UNIQUE(actor_hash,request_id))`);
  const row = (id: string) => db.prepare('SELECT * FROM connection_replacement_reviews WHERE review_id=?').get(id) as Row | undefined;
  const assert = (saved: Row, check: () => void) => { check();codec.assertUnlocked();if (digest(row(saved.review_id)) !== digest(saved)) conflict(); };
  const bounded = (state: State) => {
    if (regressionBytes(state) > LIMIT.bytes) throw new RpcError('connection_replacement_limit', 'Keep a sealed account-reference review under 1 MB.', 409);
    return codec.seal(state);
  };
  const load = async (id: string, actor: string, check: () => void) => {
    check();codec.assertUnlocked();const saved = row(id);
    if (!saved || saved.actor_hash !== digest(actor)) throw new RpcError('not_found', 'This account-reference review is unavailable for this paired client.', 404);
    const state = await codec.open(saved.encrypted) as State;assert(saved, check);
    if (state?.schema_version !== 1 || state.actor !== actor || state.plan?.review_id !== id || state.request?.value?.request_id !== saved.request_id
      || !['replace', 'rollback'].includes(state.request.kind) || state.request.kind !== state.plan.direction
      || state.phase !== 'reviewed' && state.phase !== 'complete' || state.phase !== saved.phase
      || !state.edits || regressionBytes(state) > LIMIT.bytes) conflict('The sealed account-reference review does not match its identity.');
    if (state.phase === 'complete' && (!state.apply || !state.receipt || state.apply.review_id !== id || state.receipt.review_id !== id
      || state.receipt.request_id !== state.apply.request_id || state.receipt.direction !== state.plan.direction
      || digest(state.receipt.from) !== digest(state.plan.from) || digest(state.receipt.to) !== digest(state.plan.to))) conflict('The sealed account-reference receipt does not match its attempt.');
    return { saved, state };
  };
  const quota = (id: string, encrypted: string) => {
    const rows = db.prepare('SELECT review_id,length(CAST(encrypted AS BLOB)) AS bytes FROM connection_replacement_reviews WHERE review_id<>? ORDER BY created_at,rowid').all(id) as Array<{ review_id: string; bytes: number }>;
    let bytes = Buffer.byteLength(encrypted) + rows.reduce((sum, item) => sum + item.bytes, 0);
    while (rows.length >= LIMIT.count || bytes > LIMIT.retained) {
      const oldest = rows.shift();if (!oldest) throw new RpcError('connection_replacement_limit', 'Account-reference receipt storage is full.', 409);
      db.prepare('DELETE FROM connection_replacement_reviews WHERE review_id=?').run(oldest.review_id);bytes -= oldest.bytes;
    }
  };
  const recent = async (inspection: Inspection, actor: string, check: () => void) => {
    const rows = db.prepare("SELECT review_id FROM connection_replacement_reviews WHERE actor_hash=? AND phase='complete' ORDER BY rowid DESC LIMIT 20").all(digest(actor)) as Array<{ review_id: string }>;
    for (const item of rows) {
      try { const { state } = await load(item.review_id, actor, check);inspection.recent.push({ request: structuredClone(state.apply!), receipt: structuredClone(state.receipt!) }); }
      catch { check();codec.assertUnlocked();inspection.unavailable_receipts++; }
    }
    return inspection;
  };
  const outcome = async (state: State, check: () => void): Promise<Result> => {
    check();codec.assertUnlocked();let pending = false;
    for (const name of [state.plan.from.connection_name, state.plan.to.connection_name]) {
      try { if (!deps.packs.reconcileConnectionProfile) pending = true;deps.packs.reconcileConnectionProfile?.(name); } catch { pending = true; }
    }
    try { deps.packs.onChanged?.(); } catch { pending = true; }
    // Historical recovery derives current profiles; it never installs an old
    // profile, moves a door, reapplies references, or restores an approval.
    let current: Inspection | undefined;
    try {
      const prepared = await prepareConnectionReplacement(db, deps, check);
      current = await recent(prepared.inspect(), state.actor, check);prepared.assertCurrent();
    } catch { check();codec.assertUnlocked(); }
    return { receipt: structuredClone(state.receipt!), ...(current ? { current } : {}), reconciliation_pending: pending };
  };
  const review = async (request: State['request'], actor: string, check: () => void): Promise<Plan> => {
    request = structuredClone(request);check();codec.assertUnlocked();
    const prior = () => db.prepare('SELECT review_id FROM connection_replacement_reviews WHERE actor_hash=? AND request_id=?').pluck().get(digest(actor), request.value.request_id) as string | undefined;
    const recover = async (id: string) => { const { state } = await load(id, actor, check);if (digest(state.request) !== digest(request)) conflict('That request ID already names another account-reference review.');return structuredClone(state.plan); };
    const existing = prior();if (existing) return recover(existing);
    let original: Awaited<ReturnType<typeof load>> | undefined;
    if (request.kind === 'rollback') {
      original = await load(request.value.receipt_id, actor, check);
      if (original.state.phase !== 'complete' || original.state.plan.direction !== 'replace') conflict('Review rollback from a retained completed replacement receipt.');
    }
    const prepared = await prepareConnectionReplacement(db, deps, check);
    const target = request.kind === 'replace' ? prepared.plan(request.value)
      : prepared.rollback(original!.state.plan, original!.state.edits, original!.state.plan.review_id);
    const plan: Plan = { ...target.body, review_id: randomUUID(), expires_at: now() + LIMIT.ttl };
    const state: State = { schema_version: 1, actor, request, plan, fingerprint: prepared.fingerprint, edits: target.edits, phase: 'reviewed' }, encrypted = await bounded(state);
    const winner = db.transaction(() => {
      check();codec.assertUnlocked();const raced = prior();if (raced) return raced;
      prepared.assertCurrent();if (original) assert(original.saved, check);
      quota(plan.review_id, encrypted);db.prepare('INSERT INTO connection_replacement_reviews VALUES(?,?,?,?,?,?)').run(plan.review_id, digest(actor), request.value.request_id, now(), 'reviewed', encrypted);
      return plan.review_id;
    }).immediate();
    return winner === plan.review_id ? structuredClone(plan) : recover(winner);
  };
  return {
    async inspect(request: Inspect, actor: string, check: () => void): Promise<Inspection> {
      check();codec.assertUnlocked();const prepared = await prepareConnectionReplacement(db, deps, check);
      const result = await recent(prepared.inspect(request.from_connection, request.to_connection), actor, check);
      check();codec.assertUnlocked();prepared.assertCurrent();return result;
    },
    review: (value: Review, actor: string, check: () => void) => review({ kind: 'replace', value }, actor, check),
    rollback: (value: Rollback, actor: string, check: () => void) => review({ kind: 'rollback', value }, actor, check),
    async apply(request: Apply, actor: string, check: () => void): Promise<Result> {
      request = structuredClone(request);const { saved, state } = await load(request.review_id, actor, check);
      if (state.phase === 'complete') { if (digest(state.apply) !== digest(request)) conflict('This review already has another account-reference attempt.');return outcome(state, check); }
      if (state.plan.blockers.length || state.plan.expires_at <= now()) conflict('Review a current unblocked account-reference plan before confirming.');
      if (request.acknowledge_account_change !== true) conflict('Acknowledge the account change and affected automation before confirming.');
      const prepared = await prepareConnectionReplacement(db, deps, check);
      const receipt: Receipt = { review_id: request.review_id, request_id: request.request_id, completed_at: now(), direction: state.plan.direction,
        ...(state.plan.parent_receipt_id ? { parent_receipt_id: state.plan.parent_receipt_id } : {}), from: state.plan.from, to: state.plan.to,
        packs: state.plan.packs.map(({ pack_slug, slot }) => ({ pack_slug, slot })), dish_ids: state.plan.dishes.map(dish => dish.dish_id), changes: state.plan.changes };
      // Manifest evidence is checked again by rebuilding the selected plan (or
      // the original receipt's inverse), rather than trusting a name or the UI.
      let original: Awaited<ReturnType<typeof load>> | undefined;
      const target = state.request.kind === 'replace' ? prepared.plan(state.request.value) : await (async () => {
        original = await load(state.request.kind === 'rollback' ? state.request.value.receipt_id : '', actor, check);
        return prepared.rollback(original.state.plan, original.state.edits, original.state.plan.review_id);
      })();
      const { review_id: _id, expires_at: _expires, ...body } = state.plan;
      if (prepared.fingerprint !== state.fingerprint || digest(target.body) !== digest(body) || digest(target.edits) !== digest(state.edits)) conflict();
      const complete: State = { ...state, phase: 'complete', apply: request, receipt }, encrypted = await bounded(complete);
      db.transaction(() => {
        assert(saved, check);if (original) assert(original.saved, check);prepared.assertCurrent();
        if (state.plan.expires_at <= now()) conflict();
        quota(request.review_id, encrypted);prepared.mutate(state.edits);check();codec.assertUnlocked();
        db.prepare("UPDATE connection_replacement_reviews SET phase='complete',encrypted=? WHERE review_id=?").run(encrypted, request.review_id);
      }).immediate();
      return outcome(complete, check);
    },
  };
};
