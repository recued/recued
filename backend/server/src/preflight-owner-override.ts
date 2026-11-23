/** Standing policy is an effect of one durable answer, not of every replay. */
import { OWNER_OPERATION_SCOPE, isCatalogForm, operationSpecHash, type OwnerOperationPolicyInput,
  type PreflightOverrideOffer } from '@recued/contracts';
import type { PreflightOverrideWriter } from '@recued/gateway';
import { writeOwnerOperationOverride, type ContractRpcDeps } from './contract-handler.js';
import type { GatedActionStore } from './gated-action-store.js';
import { preapprovalHash } from './preapproval-invocations.js';
import { collectPreapprovalContractReads } from './storage/preapproval-contract-reads.js';

type Deps = Pick<ContractRpcDeps, 'store' | 'getManifest' | 'listManifests' | 'auditLog' | 'now'> & {
  gatedActionStore?: Pick<GatedActionStore, 'getByCheckpoint'>;
};

export const createPreflightOwnerOverride = (deps: Deps): {
  capturePolicy: (offer: PreflightOverrideOffer) => string | undefined;
  apply: PreflightOverrideWriter;
} => {
  const db = deps.store.realmDatabase;
  if (db) db.exec(`CREATE TABLE IF NOT EXISTS preflight_owner_override_decisions (
    decision_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('applied','closed','superseded'))
  )`);

  const revision = (offer: PreflightOverrideOffer): string => {
    if (!db) throw new Error('Standing policy decisions require durable storage.');
    const { dependencies } = collectPreapprovalContractReads(db, () =>
      deps.store.get(OWNER_OPERATION_SCOPE, [offer.ingredient_id, offer.operation_id]));
    return preapprovalHash(dependencies);
  };
  const capturePolicy = (offer: PreflightOverrideOffer): string | undefined =>
    db?.transaction(() => revision(offer)).immediate();

  const apply: PreflightOverrideWriter = async (offer, decision) => {
    if (!db) throw new Error('Standing policy decisions require durable storage.');
    if (!decision || typeof decision.decision_id !== 'string' || !decision.decision_id
      || !Number.isSafeInteger(decision.answered_at) || decision.answered_at < 0
      || !Array.isArray(decision.holds) || decision.holds.length === 0
      || decision.holds.some(hold => !hold || typeof hold.run_id !== 'string' || !hold.run_id
        || typeof hold.checkpoint_id !== 'string' || !hold.checkpoint_id)
      || (decision.policy_revision !== undefined && (typeof decision.policy_revision !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(decision.policy_revision)))) {
      throw new Error('Standing policy requires a valid durable approval decision.');
    }
    const fingerprint = preapprovalHash({ offer, decision });
    const find = db.prepare('SELECT fingerprint FROM preflight_owner_override_decisions WHERE decision_id=?');
    const alreadyRecorded = (): boolean => {
      const saved = find.get(decision.decision_id) as { fingerprint: string } | undefined;
      if (saved && saved.fingerprint !== fingerprint) throw new Error('Standing policy decision identity was reused with different content.');
      return saved !== undefined;
    };
    if (alreadyRecorded()) return;

    // Older answered asks have no receipt. A closed run/claimed operation is
    // cleanup, not fresh authority to restore a standing setting.
    let active = false;
    for (const hold of decision.holds) {
      const action = await deps.gatedActionStore?.getByCheckpoint(hold.checkpoint_id);
      if (action && (action.run_id !== hold.run_id || action.status !== 'awaiting_approval')) continue;
      if (hold.raw_op) { active = true; continue; }
      const anchor = await deps.auditLog?.get(hold.run_id);
      if (anchor?.commit_status === 'awaiting_approval'
        && (anchor.checkpoint_id === undefined || anchor.checkpoint_id === hold.checkpoint_id)) active = true;
    }

    let change: ReturnType<typeof writeOwnerOperationOverride> | undefined;
    deps.store.transaction(() => {
      // Another process may have committed while the lifecycle reads yielded.
      if (alreadyRecorded()) return;
      let outcome: 'applied' | 'closed' | 'superseded' = 'closed';
      if (active) {
        const manifest = deps.getManifest(offer.ingredient_id);
        const operation = manifest == null ? undefined : isCatalogForm(manifest)
          ? Object.values(manifest.operations ?? {}).find(op => op.operation_id === offer.operation_id)
          : manifest.slug === offer.operation_id ? { operation_id: manifest.slug, risk_tier: manifest.risk_tier } : undefined;
        if (!operation || operationSpecHash(operation) !== offer.op_hash) {
          throw new Error(`standing owner action for '${offer.operation_id}' is stale because the operation changed or was removed; review a fresh ask`);
        }
        const priorRow = deps.store.get(OWNER_OPERATION_SCOPE, [offer.ingredient_id, offer.operation_id]);
        const prior = (priorRow?.value ?? {}) as Record<string, unknown>;
        // An unversioned legacy answer cannot prove whether an existing or
        // absent setting is the owner's later choice. It still approves the
        // held action, but changing standing policy requires a fresh offer.
        const unchanged = decision.policy_revision !== undefined
          && revision(offer) === decision.policy_revision;
        if (!unchanged) outcome = 'superseded';
        else {
          const { op_hash: _hash, ...policy } = prior;
          change = writeOwnerOperationOverride(deps, { ingredient_id: offer.ingredient_id,
            operation_id: offer.operation_id, policy: { ...policy, approval: offer.approval } as OwnerOperationPolicyInput });
          outcome = 'applied';
        }
      }
      db.prepare('INSERT INTO preflight_owner_override_decisions VALUES(?,?,?)')
        .run(decision.decision_id, fingerprint, outcome);
    });
    // The row and receipt have committed together before this optional audit
    // yields. Recovery never overwrites policy to repair a projection.
    await change?.audit();
  };
  return { capturePolicy, apply };
};
