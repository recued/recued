/** One new paired-owner decision over a complete local transaction. Preparation
 * and recovery do no writes to domain data. Claims are never replay permits. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, hasLocalUpdateResources, isRecordsExecutionBinding, isResourceReview, LOCAL_CHANGE_SET_LIMITS,
  type LocalChangeSetPrepare, type LocalChangeSetUndoPrepare, type LocalChangeSetDecision,
  type LocalChangeSetInspection, type ResourceReview } from '@recued/contracts';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import type { PreapprovalOrigin } from './preapproval-model.js';
import type { PreapprovalRepository } from './storage/preapproval-repository.js';
import type { PreapprovalWorkers } from './storage/preapproval-workers.js';
import type { LocalUpdateUndoStore } from './storage/local-update-undo-store.js';
import { LOCAL_UPDATE_UNDO_RETENTION_MS } from './storage/local-update-undo-store.js';
import { createLocalChangeSetStore, type LocalChangeMaterial, type LocalChangeMember, type LocalChangeProof,
  type LocalChangeRow } from './storage/local-change-set-store.js';
import { localMutationHash } from './storage/ordinary-local-mutation-receipts.js';
import { withResourceReview, resourceReviewHash } from './resource-review.js';
import { withLocalMutationScope } from './local-mutation-context.js';
import { commitLocalTransaction, type PreparedLocalWrite } from './local-transaction.js';
import { inverseLocalUpdateCall, localUpdateInput, type LocalUpdateCall } from './local-update-operation.js';
import { withContractDispatchReservation } from './contract-dispatch-reservation.js';

const fail = (message: string, code = 'local_changes_conflict'): never => { throw new RpcError(code, message, 409); };
const uuid = /^[a-f0-9-]{36}$/;
const identifier = (value: unknown, prefix: string): value is string => typeof value === 'string'
  && value.startsWith(prefix) && uuid.test(value.slice(prefix.length));
const payload = (raw: unknown, keys: string): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== keys) {
    throw new RpcError('bad_request', 'Invalid local change set request.', 400);
  }
  return raw as Record<string, unknown>;
};
export const parseLocalChangeSetLocator = (raw: unknown): string => {
  const value = payload(raw, 'change_set_id');
  if (!identifier(value.change_set_id, 'lcs_')) throw new RpcError('bad_request', 'Choose a local change set.', 400);
  return value.change_set_id;
};
export const parseLocalChangeSetPrepare = (raw: unknown): LocalChangeSetPrepare => {
  const value = payload(raw, 'proposal_id,request_id');
  if (!identifier(value.proposal_id, 'pap_') || !identifier(value.request_id, '')) throw new RpcError('bad_request', 'Invalid atomic review request.', 400);
  return { proposal_id: value.proposal_id, request_id: value.request_id };
};
export const parseLocalChangeSetUndo = (raw: unknown): LocalChangeSetUndoPrepare => {
  const value = payload(raw, 'change_set_id,request_id');
  if (!identifier(value.change_set_id, 'lcs_') || !identifier(value.request_id, '')) throw new RpcError('bad_request', 'Invalid grouped undo request.', 400);
  return { change_set_id: value.change_set_id, request_id: value.request_id };
};
export const parseLocalChangeSetDecision = (raw: unknown): LocalChangeSetDecision => {
  const value = payload(raw, 'change_set_id,decision,review_hash');
  if (!identifier(value.change_set_id, 'lcs_') || typeof value.review_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.review_hash)
    || (value.decision !== 'approve' && value.decision !== 'deny')) throw new RpcError('bad_request', 'Invalid atomic decision.', 400);
  return { change_set_id: value.change_set_id, review_hash: value.review_hash, decision: value.decision };
};
export const parseLocalChangeSetList = (raw: unknown): string => {
  const value = payload(raw, 'cursor');
  if (value.cursor !== '' && !identifier(value.cursor, 'lcs_')) throw new RpcError('bad_request', 'Invalid atomic list cursor.', 400);
  return value.cursor as string;
};

const proofsFor = (material: LocalChangeMaterial): LocalChangeProof[] => material.members.map(member => ({ member_id: member.id, binding: {
  owner: material.public.undo_of ? 'local_undo' : 'local_change_set', owner_ref: material.public.change_set_id,
  attempt_id: material.public.change_set_id + ':' + member.id, identity_hash: material.public.review_hash,
  operation: member.review.operation, kind: member.kind, review_hash: localMutationHash(member.review),
} }));
const sameIdentity = (left: LocalChangeRow, right: LocalChangeRow): boolean => (
  ['change_set_id','request_id','request_hash','owner_id','credential_id','source_proposal_id','undo_of','epoch',
    'expires_at','retained_until','review_hash','encrypted','proof_json'] as const).every(key => left[key] === right[key]);

export const createLocalChangeSets = (deps: {
  db: Database.Database; undo: LocalUpdateUndoStore; repository: PreapprovalRepository; workers: PreapprovalWorkers;
  execution: ExecuteHandlerDeps; now?: () => number;
  validateOwner(origin: PreapprovalOrigin): void;
  validate(origin: PreapprovalOrigin, call: LocalUpdateCall): void;
}) => {
  const { db, undo, execution, repository } = deps; const now = deps.now ?? Date.now;
  const store = createLocalChangeSetStore(db, undo, now);
  for (const row of db.prepare("SELECT change_set_id,worker_id FROM local_change_sets WHERE status='dispatching'").all() as {
    change_set_id: string; worker_id: string | null;
  }[]) if (row.worker_id && deps.workers.status(row.worker_id) === 'gone') {
    db.prepare("UPDATE local_change_sets SET status='unknown' WHERE change_set_id=? AND status='dispatching'").run(row.change_set_id);
  }
  store.prune();
  const owner = (origin: PreapprovalOrigin): Extract<PreapprovalOrigin, { mode: 'owner' }> => {
    if (origin.mode !== 'owner' || origin.entry !== 'owner_ui') throw new RpcError('local_changes_owner_required', 'Open local changes in your paired webclient.', 403);
    deps.validateOwner(origin); return origin;
  };
  const owned = (id: string, origin: PreapprovalOrigin): LocalChangeRow => {
    const actor = owner(origin), row = store.row(id);
    if (!row || row.owner_id !== actor.owner_id) return fail('This local change set is unavailable.');
    return row;
  };
  const open = async (row: LocalChangeRow): Promise<LocalChangeMaterial> => {
    undo.codec.assertUnlocked();
    if (!row.encrypted) return fail('The retained private review expired. Its decision and receipts remain available.');
    const material = await undo.codec.open(row.encrypted) as LocalChangeMaterial;
    const live = store.row(row.change_set_id);
    if (!live || !sameIdentity(live,row)
      || material.schema_version !== 1 || material.public.change_set_id !== row.change_set_id
      || material.public.review_hash !== row.review_hash || material.epoch !== row.epoch
      || material.request_id !== row.request_id || material.request_hash !== row.request_hash
      || resourceReviewHash(proofsFor(material)) !== resourceReviewHash(JSON.parse(row.proof_json))
      || (material.source?.proposal_id ?? null) !== row.source_proposal_id
      || material.owner.owner_id !== row.owner_id || material.owner.credential_id !== row.credential_id
      || material.public.expires_at !== row.expires_at || material.retained_until !== row.retained_until
      || material.public.source_proposal_id !== row.source_proposal_id || material.public.undo_of !== row.undo_of
      || material.members.length !== material.public.changes.length
      || resourceReviewHash(material.public.changes) !== resourceReviewHash(material.members.map(member => ({
        member_id: member.id, label: member.label, resource_review: member.review })))) return fail('The sealed local review changed.');
    return material;
  };
  const get = async (id: string, origin: PreapprovalOrigin): Promise<LocalChangeSetInspection> => {
    const row = owned(id, origin), view = store.inspect(row);
    if (view.status !== 'pending') return view;
    const material = await open(row);
    // Decryption yields: a revoked device must not receive private values, and
    // a decision or expiry that won meanwhile must replace the old preview.
    const live = owned(id, origin), current = store.inspect(live);
    if (current.status === 'pending') {
      undo.codec.assertUnlocked();
      if (!sameIdentity(row,live)) return fail('The sealed local review changed.');
      current.review = material.public;
    }
    return current;
  };
  const validateMember = (member: LocalChangeMember, origin: PreapprovalOrigin, resource = true, admission = true): void => {
    const manifest = execution.executorConfig.manifests.get(member.call.slug);
    if (!manifest || localMutationHash(manifest) !== member.call.manifest_hash) return fail('An installed operation changed. Prepare a new review.');
    if (admission) deps.validate(origin, member.call);
    if (member.predecessor) {
      undo.assertAvailable(member.predecessor);
      if (db.prepare('SELECT 1 FROM local_update_undo_links WHERE predecessor_receipt_id=?').get(member.predecessor.receipt_id)) return fail('A member already has an undo receipt.');
    }
    if (!resource) return;
    const review = execution.executorConfig.resourceReview?.capture(member.call.slug, localUpdateInput(member.call, member.inverse), member.review);
    if (!isResourceReview(review) || resourceReviewHash(review) !== resourceReviewHash(member.review)) return fail('A reviewed resource changed.');
  };
  const validateMaterial = (material: LocalChangeMaterial): void => {
    undo.codec.assertUnlocked();
    if (material.epoch !== undo.clock.snapshot().epoch || material.public.expires_at <= now() || material.retained_until <= now()) return fail('This local review expired. Prepare a new review.');
    if (material.public.undo_of) {
      const parent = store.row(material.public.undo_of);
      if (!parent || store.inspect(parent).status !== 'completed' || !store.receipts(parent)
        || db.prepare('SELECT 1 FROM local_change_set_undos WHERE original_set_id=?').get(parent.change_set_id)) return fail('The original set cannot be undone again.');
    }
  };
  const validateResources = (material: LocalChangeMaterial): void => {
    validateMaterial(material);
    if (!material.members.length || material.members.length > LOCAL_CHANGE_SET_LIMITS.members) return fail('Choose between one and 25 local updates.');
    const targets = new Set<string>(); let count = 0;
    for (const member of material.members) {
      if (!hasLocalUpdateResources(member.review)) return fail('Only Records and local Calendar updates can be committed together.', 'local_changes_unsupported');
      for (const resource of member.review.resources) {
        const key = resource.kind + ':' + resource.key;
        if (targets.has(key)) return fail('A target occurs in separate members. Combine repeated Records updates in one batch.', 'local_changes_unsupported');
        targets.add(key); count += resource.changes?.length ?? 1;
      }
      validateMember(member, material.origin, true, !material.source);
    }
    if (count > LOCAL_CHANGE_SET_LIMITS.updates || Buffer.byteLength(JSON.stringify(material), 'utf8') > LOCAL_CHANGE_SET_LIMITS.review_bytes) return fail('The change set is too large. Use at most 100 updates and 256 KiB of reviewed material.', 'local_changes_unsupported');
  };
  const requestHash = (input: unknown): string => localMutationHash(input);
  const replay = async (request: { request_id: string }, origin: PreapprovalOrigin, hash: string): Promise<LocalChangeSetInspection | null> => {
    const actor = owner(origin);
    const row = db.prepare('SELECT * FROM local_change_sets WHERE owner_id=? AND credential_id=? AND request_id=?')
      .get(actor.owner_id, actor.credential_id, request.request_id) as LocalChangeRow | undefined;
    if (!row) return null;
    if (row.request_hash !== hash) return fail('This request ID already names a different local review.');
    return get(row.change_set_id, origin);
  };
  const persist = async (material: LocalChangeMaterial, request: { request_id: string }, hash: string,
    validateSource?: () => void): Promise<LocalChangeSetInspection> => {
    material.request_id = request.request_id; material.request_hash = hash;
    material.public.review_hash = localMutationHash(material);
    const encrypted = await undo.codec.seal(material);
    const proof = proofsFor(material);
    const prior = await replay(request, material.owner, hash); if (prior) return prior;
    const savedId = db.transaction(() => {
      const existing = db.prepare('SELECT change_set_id,request_hash FROM local_change_sets WHERE owner_id=? AND credential_id=? AND request_id=?')
        .get(material.owner.owner_id,material.owner.credential_id,request.request_id) as { change_set_id: string; request_hash: string } | undefined;
      if (existing) {
        if (existing.request_hash !== hash) return fail('This request ID already names a different local review.');
        return existing.change_set_id;
      }
      owner(material.owner); validateSource?.(); validateResources(material); store.prune();
      const usage = db.prepare(`SELECT sum(CASE WHEN status='pending' AND expires_at>? AND epoch=? THEN 1 ELSE 0 END) AS pending,
        coalesce(sum(length(CAST(encrypted AS BLOB))),0) AS bytes FROM local_change_sets WHERE owner_id=?`)
        .get(now(),undo.clock.snapshot().epoch,material.owner.owner_id) as { pending: number | null; bytes: number };
      if ((usage.pending ?? 0) >= LOCAL_CHANGE_SET_LIMITS.pending
        || usage.bytes + Buffer.byteLength(encrypted,'utf8') > LOCAL_CHANGE_SET_LIMITS.retained_review_bytes) {
        return fail('The local review limit is full. Decline unused reviews or wait for retained private reviews to expire.', 'local_changes_limit');
      }
      db.prepare(`INSERT INTO local_change_sets
        (change_set_id,request_id,request_hash,owner_id,credential_id,source_proposal_id,undo_of,epoch,expires_at,
        retained_until,review_hash,encrypted,proof_json,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(material.public.change_set_id,request.request_id,hash,
        material.owner.owner_id,material.owner.credential_id,material.public.source_proposal_id,material.public.undo_of,
        material.epoch,material.public.expires_at,material.retained_until,material.public.review_hash,encrypted,JSON.stringify(proof),now());
      return material.public.change_set_id;
    }).immediate();
    return get(savedId, material.owner);
  };
  const base = (actor: Extract<PreapprovalOrigin, { mode: 'owner' }>, origin: PreapprovalOrigin,
    title: string, retained: number, proposal: string | null, undoOf: string | null): LocalChangeMaterial => ({
    schema_version: 1, request_id: '', request_hash: '', owner: structuredClone(actor), origin: structuredClone(origin), epoch: undo.clock.snapshot().epoch,
    retained_until: retained, public: { change_set_id: 'lcs_' + randomUUID(), source_proposal_id: proposal, undo_of: undoOf,
      title, requested_through: origin.display_name, review_hash: '', expires_at: Math.min(now() + LOCAL_CHANGE_SET_LIMITS.review_ms, retained), changes: [] }, members: [],
  });
  return {
    get, prune: store.prune,
    list(cursor: string, origin: PreapprovalOrigin): { items: LocalChangeSetInspection[]; next_cursor: string | null } {
      const actor = owner(origin);
      const rows = db.prepare('SELECT * FROM local_change_sets WHERE owner_id=? AND change_set_id>? ORDER BY change_set_id LIMIT 51')
        .all(actor.owner_id,cursor) as LocalChangeRow[];
      return { items: rows.slice(0,50).map(store.inspect), next_cursor: rows.length > 50 ? rows[49]!.change_set_id : null };
    },
    async prepare(args: LocalChangeSetPrepare, origin: PreapprovalOrigin): Promise<LocalChangeSetInspection> {
      const actor = owner(origin), hash = requestHash({ ...args, kind: 'forward' });
      const prior = await replay(args, origin, hash); if (prior) return prior;
      const source = await repository.localChangeSetSource(args.proposal_id, { channel: 'webclient', key: actor.credential_id! });
      const material = base(actor, source.plan.origin, source.plan.recipe.display_name, now() + LOCAL_UPDATE_UNDO_RETENTION_MS, args.proposal_id, null);
      material.source = { proposal_id: args.proposal_id, revision: source.revision, snapshot_hash: source.snapshot_hash };
      material.public.expires_at = Math.min(material.public.expires_at, source.plan.request.decision_deadline);
      for (const [index, member] of source.plan.members.entries()) {
        const manifest = execution.executorConfig.manifests.get(member.ingredient_slug);
        if (!manifest || !member.resource_review || member.family !== 'kernel') return fail('An original local operation is unavailable.');
        const call: LocalUpdateCall = { slug: member.ingredient_slug, input: structuredClone(member.input),
          operation: member.op_id, manifest_hash: localMutationHash(manifest) };
        const step = source.plan.recipe_snapshots[0]!.definition.steps[index]!;
        const raw = 'input' in step ? step.input : undefined;
        const key = raw && typeof raw === 'object' && !Array.isArray(raw) && 'operation' in raw && typeof raw.operation === 'string' ? raw.operation : '';
        const binding = manifest.surfaces?.records?.executes?.[key];
        const calendar = call.slug === 'calendar-update' && member.resource_review.resources.every(resource => resource.kind === 'calendar');
        if (calendar && !execution.executorConfig.prepareLocalCalendarUpdate) return fail('This host cannot prepare an atomic local Calendar write.', 'local_changes_unavailable');
        if (!calendar && (!isRecordsExecutionBinding(binding) || !['update','batch'].includes(binding.action)
          || manifest.operations?.[key]?.operation_id !== member.op_id)) {
          return fail('Only installed Records updates, update-only batches and local Calendar updates can form a change set.', 'local_changes_unsupported');
        }
        if (!calendar) call.input = { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? structuredClone(raw) : {}),
          operation: key, args: structuredClone(member.input) };
        material.members.push({ id: member.member_id, label: member.review.label, call, review: structuredClone(member.resource_review),
          kind: calendar ? 'local_calendar' : 'records', ...(!calendar && isRecordsExecutionBinding(binding) ? { binding: structuredClone(binding) } : {}) });
      }
      material.public.changes = material.members.map(member => ({ member_id: member.id, label: member.label, resource_review: member.review }));
      return persist(material, args, hash, source.validate);
    },
    async prepareUndo(args: LocalChangeSetUndoPrepare, origin: PreapprovalOrigin): Promise<LocalChangeSetInspection> {
      const actor = owner(origin), hash = requestHash({ ...args, kind: 'undo' });
      const prior = await replay(args, origin, hash); if (prior) return prior;
      const row = owned(args.change_set_id, origin), proof = store.receipts(row);
      if (row.undo_of || store.inspect(row).status !== 'completed' || !proof) return fail('Choose a confirmed original change set to undo.');
      const members: LocalChangeMember[] = []; let retained = row.retained_until;
      for (const item of [...proof].reverse()) {
        const saved = await undo.load(item.receipt.receipt_id);
        retained = Math.min(retained, saved.retained_until);
        const call = inverseLocalUpdateCall(saved.inverse, execution.executorConfig.manifests);
        const review = execution.executorConfig.resourceReview?.capture(call.slug, localUpdateInput(call, saved.inverse));
        if (!isResourceReview(review)) return fail('Version-bound grouped undo is unavailable.');
        if (saved.inverse.kind === 'records' ? resourceReviewHash(review.resources) !== resourceReviewHash(saved.inverse.resources)
          : review.resources.length !== 1 || review.resources[0]!.key !== saved.inverse.key
            || review.resources[0]!.binding !== saved.inverse.binding || review.resources[0]!.version !== saved.inverse.version) return fail('A member changed after the original set. No undo was applied.');
        members.push({ id: item.member_id, label: 'Undo ' + review.resources[0]!.label, call, review, kind: saved.receipt.kind,
          inverse: saved.inverse, predecessor: saved.receipt,
          ...(saved.inverse.kind === 'records' ? { binding: saved.inverse.binding } : {}) });
      }
      const material = base(actor, actor, 'Undo local change set', retained, null, row.change_set_id);
      material.members = members; material.public.changes = members.map(member => ({ member_id: member.id, label: member.label, resource_review: member.review }));
      return persist(material, args, hash);
    },
    async decide(args: LocalChangeSetDecision, origin: PreapprovalOrigin): Promise<LocalChangeSetInspection> {
      const actor = owner(origin); store.prune(); const initial = owned(args.change_set_id, origin);
      if (initial.review_hash !== args.review_hash) return fail('This decision does not match the reviewed set.');
      if (initial.status !== 'pending') {
        if (initial.decision !== args.decision) return fail('This set already has a different decision.');
        return store.inspect(initial);
      }
      const material = await open(initial);
      let source: Awaited<ReturnType<PreapprovalRepository['localChangeSetSource']>> | undefined;
      try {
        source = material.source && args.decision === 'approve' ? await repository.localChangeSetSource(material.source.proposal_id,
          { channel: 'webclient', key: actor.credential_id! }) : undefined;
      } catch (error) {
        const row = owned(args.change_set_id,origin);
        if (row.status !== 'pending' && row.decision === args.decision) return store.inspect(row);
        throw error;
      }
      if (source && (source.revision !== material.source!.revision || source.snapshot_hash !== material.source!.snapshot_hash)) return fail('The original review changed.');
      const current = (): LocalChangeRow => {
        owner(actor); undo.codec.assertUnlocked(); const row = store.row(args.change_set_id);
        if (!row || !sameIdentity(row,initial) || row.epoch !== undo.clock.snapshot().epoch) return fail('This atomic claim is no longer current.');
        return row;
      };
      const claimed = db.transaction(() => {
        const row = current();
        if (row.status !== 'pending') {
          if (row.decision !== args.decision) return fail('This set already has a different decision.');
          return false;
        }
        validateMaterial(material);
        if (args.decision === 'approve') { source?.validate(); validateResources(material); }
        deps.workers.assertCurrent(deps.workers.worker_id);
        db.prepare('UPDATE local_change_sets SET status=?,decision=?,decision_credential_id=?,worker_id=?,decided_at=? WHERE change_set_id=?')
          .run(args.decision === 'approve' ? 'dispatching' : 'denied', args.decision,actor.credential_id,deps.workers.worker_id,now(),args.change_set_id);
        return args.decision === 'approve';
      }).immediate();
      if (!claimed) return store.inspect(current());
      try {
        const prepared = new Map<string,PreparedLocalWrite>();
        // No network-capable provider can enter here. Every asynchronous local
        // Calendar/body preparation finishes before opening the write lock.
        for (const member of material.members) if (member.kind === 'local_calendar') {
          const prepare = execution.executorConfig.prepareLocalCalendarUpdate;
          if (!prepare) return fail('The local Calendar transaction participant is unavailable.');
          const input = localUpdateInput(member.call, member.inverse);
          const value = await withResourceReview(member.review, () => prepare(input as Parameters<typeof prepare>[0]));
          if (value.db !== db) return fail('Every participant must use the same realm database.');
          prepared.set(member.id,value);
        }
        commitLocalTransaction(db, () => {
          const row = current();
          if (row.status !== 'dispatching' || row.worker_id !== deps.workers.worker_id || row.decision_credential_id !== actor.credential_id) return fail('This worker does not own the atomic decision.');
          deps.workers.assertCurrent(deps.workers.worker_id); source?.validate(); validateResources(material);
          const proof = JSON.parse(initial.proof_json) as LocalChangeProof[];
          let lastReservation: object | undefined;
          for (const member of material.members) {
            source?.validate(); validateMember(member,material.origin,true,!material.source);
            const reserve = execution.contractOverlay?.reserveDispatchUse;
            if (!reserve && material.origin.mode === 'contract') return fail('The original contract cannot reserve this dispatch.');
            const reservation = reserve?.(material.origin.source,member.call.slug) ?? undefined;
            lastReservation = reservation;
            let recorded = false;
            withLocalMutationScope({ record(connection, kind, actual) {
              if (recorded || connection !== db || !db.inTransaction || kind !== member.kind
                || resourceReviewHash(actual) !== resourceReviewHash(member.review)) return fail('A participant did not produce its exact reviewed write.');
              const claim = current();
              if (claim.status !== 'dispatching' || claim.worker_id !== deps.workers.worker_id
                || claim.decision !== 'approve' || claim.decision_credential_id !== actor.credential_id) return fail('The member lost its atomic decision.');
              recorded = true; validateMaterial(material);
              withContractDispatchReservation(reservation, () => { source?.validate(); validateMember(member,material.origin,false,!material.source); });
              const expected = proof.find(item => item.member_id === member.id)!;
              const receipt = undo.journal.record(expected.binding);
              if (!material.public.undo_of) undo.assertAvailable(receipt);
              db.prepare('INSERT INTO local_change_set_members VALUES(?,?,?)').run(args.change_set_id,member.id,receipt.receipt_id);
              if (member.predecessor) db.prepare('INSERT INTO local_update_undo_links VALUES(?,?,?)')
                .run(member.predecessor.receipt_id,receipt.receipt_id,args.change_set_id + ':' + member.id);
            } }, () => withResourceReview(member.review, () => {
              if (member.kind === 'local_calendar') prepared.get(member.id)!.apply();
              else {
                if (!execution.recordsStore || !member.binding) return fail('The Records transaction participant is unavailable.');
                execution.recordsStore.execute({ binding: member.binding,
                  args: localUpdateInput(member.call,member.inverse).args as Record<string,unknown>,
                  principal: material.origin.mode === 'contract' ? material.origin.contract_id : 'owner-local-set:' + material.origin.credential_id });
              }
            }));
            if (!recorded) return fail('An atomic participant produced no durable receipt.');
          }
          current(); validateMaterial(material);
          withContractDispatchReservation(lastReservation, () => source?.consume());
          if (material.public.undo_of) db.prepare('INSERT INTO local_change_set_undos VALUES(?,?)').run(material.public.undo_of,args.change_set_id);
          db.prepare("UPDATE local_change_sets SET status='completed' WHERE change_set_id=?").run(args.change_set_id);
        });
      } catch (error) {
        const row = store.row(args.change_set_id);
        if (row?.status === 'completed') return store.inspect(row);
        db.prepare("UPDATE local_change_sets SET status='failed' WHERE change_set_id=? AND status='dispatching'").run(args.change_set_id);
        throw error;
      }
      return store.inspect(owned(args.change_set_id,origin));
    },
  };
};
export type LocalChangeSets = ReturnType<typeof createLocalChangeSets>;
