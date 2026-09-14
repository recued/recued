/** The shared preparation and live-validation service. The owner RPC and the
 * kernel request must call this same service with their host-derived origin. */
import { randomUUID } from 'node:crypto';
import {
  PREAPPROVAL_PROTOCOL_VERSION, RpcError, parsePreparePreapproval,
  SEND_COMPOSED_MAIL_RECIPE_ID, normalizeMailSend, parsePreapprovalJson, type MailDraft,
  type PreparePreapproval, type PreapprovalCapabilities,
} from '@recued/contracts';
import { deriveCommitKind } from '@recued/gateway';
import { parseRecipe } from '@recued/recipes';
import { preapprovalHash, preapprovalPathKey } from './preapproval-invocations.js';
import { prepareFutureExecution, prepareRecipeSnapshot, type PreapprovalPreparationDeps } from './preapproval-prepare.js';
import { createPreapprovalRecipeSources, type PreapprovalRecipeSourceDeps } from './preapproval-recipe-sources.js';
import { createPreapprovalAdmission, type PreapprovalAdmissionDeps } from './preapproval-admission.js';
import { createPreapprovalBindingIdentities, type PreapprovalBindingIdentityDeps } from './preapproval-binding-identities.js';
import { collectPreapprovalContractReads, readPreapprovalContractQuery, withPreapprovalContractReadPhase,
  withPreapprovalContractProjection, PREAPPROVAL_PACK_RESOLUTION_QUERY } from './storage/preapproval-contract-reads.js';
import { readCurrentConnectionOperationProfile } from './connection-operation-profile-boot.js';
import { buildPackOpResolution } from './pack-inventory.js';
import type { OrdinaryRecipeContinuation, PreparedFutureExecution, PreparedRecipeSnapshot, PreparedInvocation, PreapprovalOrigin, PreapprovalValidationStage } from './preapproval-model.js';
import type { PreapprovalStorage } from './storage/preapproval-storage.js';
import type { createPreapprovalActivations } from './storage/preapproval-activations.js';
import type { createPreapprovalMail } from './preapproval-mail.js';
import type { MailDraftService } from './mail-draft-service.js';
import { createSingleOperationAdmission } from './single-operation-admission.js';
import { createPreapprovalAi } from './preapproval-ai.js';
import { synchronizePreapprovalIdentity } from './storage/preapproval-lifecycle.js';

export interface PreapprovalServiceDeps {
  storage: PreapprovalStorage;
  sources: PreapprovalRecipeSourceDeps;
  activations: ReturnType<typeof createPreapprovalActivations>;
  authority: PreapprovalAdmissionDeps['authority'];
  execution: PreapprovalAdmissionDeps['execution'];
  profiles: PreapprovalAdmissionDeps['profiles'];
  recordsReachable?: PreapprovalAdmissionDeps['recordsReachable'];
  describeDomain?: PreapprovalBindingIdentityDeps['describeDomain'];
  mail?: ReturnType<typeof createPreapprovalMail>;
  drafts?: MailDraftService;
  /** Host composition must report actual runner/gateway/driver readiness.
   * Schema installation or available descriptions alone are insufficient. */
  executionCapabilities(): Pick<PreapprovalCapabilities, 'activation_kinds' | 'bindings' | 'child_calls' | 'decision_channels'>;
  now?: () => number;
}

const stale = (detail: string): never => { throw new RpcError('preapproval_stale', detail, 409); };
export const createPreapprovalService = (deps: PreapprovalServiceDeps) => {
  const { db } = deps.sources;
  const now = deps.now ?? Date.now;
  const ai = createPreapprovalAi({ db, executor: deps.execution.executorConfig, files: deps.mail });
  const resolveRecipeOrigin = (origin: PreapprovalOrigin, snapshot: PreparedRecipeSnapshot) => deps.authority.resolve(
    snapshot.invocation_path.length > 1 ? deps.authority.bindTargetRecipe(origin, snapshot.publisher_id, snapshot.recipe_id) : origin);
  const memberOrigin = (plan: PreparedFutureExecution, member: PreparedInvocation) => {
    const index = member.invocation_path.map(segment => segment.kind === 'recipe').lastIndexOf(true);
    const key = preapprovalPathKey(member.invocation_path.slice(0, index + 1));
    const snapshot = plan.recipe_snapshots.find(item => preapprovalPathKey(item.invocation_path) === key);
    if (!snapshot) throw new RpcError('preapproval_stale', 'The invocation has no reviewed recipe origin.', 409);
    return resolveRecipeOrigin(plan.origin, snapshot);
  };
  const draftCarrier = () => {
    const row = deps.sources.recipes.getStored(SEND_COMPOSED_MAIL_RECIPE_ID);
    if (!row) throw new RpcError('preapproval_unresolved', 'Install Send a composed email before scheduling a saved draft.', 409);
    return { recipe_id: SEND_COMPOSED_MAIL_RECIPE_ID, publisher_id: row.publisher_id };
  };
  const preparation = (request: PreparePreapproval, target: PreparedFutureExecution['target'],
    plan?: PreparedFutureExecution, stage: PreapprovalValidationStage = 'prepare', draft = plan?.draft_snapshot,
    draftOrigin = plan?.origin): PreapprovalPreparationDeps => {
    const root = request.subject.kind === 'recipe' ? request.subject : draftCarrier();
    const manifest = (slug: string, version?: number) => deps.execution.executorConfig.manifests.get(slug, version);
    const scanPacks = () => deps.execution.contractScan!('installed_pack', []);
    const packs = deps.execution.contractScan ? new Map(withPreapprovalContractProjection('installed_pack', null,
      () => buildPackOpResolution(scanPacks, manifest))) : undefined;
    if (packs) {
      const get = packs.get.bind(packs);
      // The canonical lowerer's pack resolver consumes get(pack_ref). Pin its
      // matching installed rows, including alias collisions and absence, rather
      // than every unrelated pack enumerated to build the lookup map.
      packs.get = ref => withPreapprovalContractProjection('installed_pack', { scope: PREAPPROVAL_PACK_RESOLUTION_QUERY,
        segments: [ref], exact: true }, () => { scanPacks(); return get(ref); });
    }
    const admission = createPreapprovalAdmission({ authority: deps.authority, execution: deps.execution,
      profiles: deps.profiles, root_recipe_id: root.recipe_id,
      ...(deps.recordsReachable ? { recordsReachable: deps.recordsReachable } : {}) });
    const describe = createPreapprovalBindingIdentities({ db, connections: deps.profiles.connectionStore,
      bridgeDispatcher: deps.execution.executorConfig.bridgeDispatcherRef,
      localRecipe: id => {
        const row = deps.sources.recipes.getStored(id);
        return row ? { recipe_id: id, publisher_id: row.publisher_id } : null;
      },
      ...(deps.mail ? { describeFileChild: (call, slot, index, recordId) => deps.mail!.fileChild(call,
        { stage, admit: admission, ...(plan ? { plan } : {}) }, slot, index, recordId) } : {}),
      describeDomain: (call, decision) => deps.mail?.describe(call, decision, { stage, admit: admission, ...(plan ? { plan } : {}) })
        ?? ai(call, { stage, admit: admission, ...(plan ? { plan } : {}) })
        ?? deps.describeDomain?.(call, decision) ?? null });
    const loadRecipe = createPreapprovalRecipeSources(deps.sources, { ...root, target });
    return { loadRecipe, manifest,
      loadDraft: (id, revision) => {
        if (!draft || !deps.drafts || draft.draft_id !== id || draft.revision !== revision) return null;
        const source = loadRecipe(root.recipe_id, root.publisher_id); if (!source) return null;
        if (stage === 'prepare' || stage === 'decide') {
          if (!draftOrigin) throw new Error('Saved draft review requires its original source.');
          const pin = withPreapprovalContractReadPhase('decision', () => deps.storage.drafts.assertRevision(id, revision, deps.drafts!.principal(draftOrigin!, 'get')));
          if (pin.content_hash !== preapprovalHash({ incarnation: draft.incarnation, revision: draft.revision,
            content_hash: preapprovalHash(draft.content), contract_id: draft.origin_contract_id })) stale('The saved draft changed.');
          source.dependencies.push(pin);
        }
        source.bound_dish = { config_overlay: structuredClone(draft.content) };
        return source;
      },
      dispatch: { profiles: { get: name => readCurrentConnectionOperationProfile(deps.profiles, name) },
        manifests: { get: manifest }, ...(packs ? { packs } : {}) },
      describe: call => {
        const result = describe(call, admission);
        if (result.kind === 'resolved') {
          const pin = synchronizePreapprovalIdentity(db, 'installed_manifest', call.slug, call.manifest)!;
          result.call.dependencies.push({ kind: pin.kind, key: pin.key, incarnation: pin.incarnation,
            revision: pin.revision, content_hash: pin.content_hash, until_phase: 'terminal' });
        }
        return result;
      },
    };
  };
  const assertActivationAuthority = (origin: PreapprovalOrigin, request: PreparePreapproval): void => {
    deps.authority.validateActivationPermission(origin, request.activation);
    if (origin.mode === 'contract' && request.activation.kind !== 'one_shot') {
      // Legacy automation rows have no original-contract owner. A schedule op
      // grant cannot let a requester take an arbitrary owner's existing rule.
      throw new RpcError('preapproval_unsupported', 'The existing automation has no provable ownership by this contract. Create a new scheduled execution.', 409);
    }
  };
  const inventory = (request: PreparePreapproval, origin: PreapprovalOrigin, target: PreparedFutureExecution['target'],
    expected?: PreparedFutureExecution, stage: PreapprovalValidationStage = 'prepare', draft = expected?.draft_snapshot) => {
    // The initial draft read is asynchronous; the row is checked again in this
    // transaction before its content is used. Subsequent checks use the sealed copy.
    const collected = collectPreapprovalContractReads(db, () => {
      assertActivationAuthority(origin, request);
      return prepareFutureExecution({ request, origin, target }, preparation(request, target, expected, stage, draft, origin));
    });
    const plan = collected.result;
    plan.dependencies.push(...collected.dependencies);
    if (draft) plan.draft_snapshot = structuredClone(draft);
    for (const snapshot of plan.recipe_snapshots) {
      // Strict execution uses this same parser, which normalizes output aliases
      // in place. Validate a clone so its pre-entry identity remains identical
      // to the program the engine will hash at execution time.
      const parsed = parseRecipe(structuredClone(snapshot.definition));
      if (!parsed.ok) throw new RpcError('preapproval_unresolved',
        `The saved execution is invalid: ${parsed.issues.find(issue => issue.severity === 'error')?.message ?? 'Recipe validation failed.'}`, 409);
    }
    return plan;
  };

  const validateLive = (plan: PreparedFutureExecution, stage: PreapprovalValidationStage, member?: PreparedInvocation): void => {
    if (!db.inTransaction) throw new Error('Pre-approval validation requires the realm transaction.');
    assertActivationAuthority(plan.origin, plan.request);
    deps.activations.validate(plan, stage !== 'prepare' && stage !== 'decide');
    const fresh = inventory(plan.request, plan.origin, plan.target, plan, stage);
    if (preapprovalHash(fresh.recipe_snapshots) !== preapprovalHash(plan.recipe_snapshots)) stale('The saved execution or its effective configuration changed.');
    for (const dependency of plan.dependencies) {
      if (dependency.until_phase === 'decision' && stage !== 'prepare' && stage !== 'decide') continue;
      const current = dependency.kind === 'contract_query' ? readPreapprovalContractQuery(db, dependency.key)
        : fresh.dependencies.find(pin => pin.kind === dependency.kind && pin.key === dependency.key);
      if (!current || current.incarnation !== dependency.incarnation || current.revision !== dependency.revision
        || current.content_hash !== dependency.content_hash) stale('A reviewed dependency changed or disappeared.');
    }
    const paths = new Map(fresh.members.map(call => [preapprovalPathKey(call.invocation_path), call]));
    for (const expected of member ? [member] : plan.members) {
      const current = paths.get(preapprovalPathKey(expected.invocation_path));
      if (!current || current.effect_hash !== expected.effect_hash
        || (expected.review.eligible && !current.review.eligible)) stale('A reviewed operation, binding or permission changed.');
    }
  };

  const ordinaryRecipe = (plan: PreparedFutureExecution, recipeId: string, requested: Record<string, unknown>,
    entryPath: PreparedRecipeSnapshot['invocation_path']): OrdinaryRecipeContinuation => db.transaction(() => {
    const collected = collectPreapprovalContractReads(db, () => {
      const row = deps.sources.recipes.getStored(recipeId);
      if (!row) return stale('The uncovered nested recipe disappeared.');
      const shared = preparation(plan.request, plan.target, plan, 'run');
      const source = shared.loadRecipe(recipeId, row.publisher_id);
      if (!source) return stale('The uncovered nested recipe source is unavailable.');
      const requested_config = parsePreapprovalJson(requested) as OrdinaryRecipeContinuation['requested_config'];
      const snapshot = prepareRecipeSnapshot(source, requested_config, entryPath, shared.dispatch);
      resolveRecipeOrigin(plan.origin, snapshot);
      const parsed = parseRecipe(structuredClone(snapshot.definition));
      if (!parsed.ok) return stale(`The uncovered nested recipe is invalid: ${parsed.issues.find(issue => issue.severity === 'error')?.message ?? 'Recipe validation failed.'}`);
      return { schema_version: 1 as const, snapshot, requested_config, dependencies: source.dependencies };
    });
    return { ...collected.result, dependencies: [...collected.result.dependencies, ...collected.dependencies] };
  }).immediate();
  const validateOrdinaryRecipe = (plan: PreparedFutureExecution, continuation: OrdinaryRecipeContinuation): void => {
    if (!db.inTransaction) throw new Error('Nested continuation validation requires the realm transaction.');
    const fresh = ordinaryRecipe(plan, continuation.snapshot.recipe_id, continuation.requested_config,
      continuation.snapshot.invocation_path.slice(0, -1));
    if (preapprovalHash(fresh) !== preapprovalHash(continuation)) stale('The uncovered nested continuation changed.');
  };

  deps.storage.configureRuntime({ validateLive, validateOrdinaryRecipe, validateResponder: deps.authority.validateResponder,
    activate: (plan, activation) => { deps.mail?.accept(plan, activation); deps.activations.activate(plan, activation); },
    selectOccurrence: (plan, candidate) => deps.activations.selectOccurrence(plan, candidate.future_execution_ref,
      candidate.occurrence_key, candidate.payload_hash),
    // Terminalization is already durable in the repository. Its retirement
    // worker projects parked rules; a denied proposal never parked a rule.
    stop: (_plan, futureRef) => { deps.activations.retire(futureRef); },
    buildPendingCommit: (claim, member, plan) => ({
      commit_id: randomUUID(), kind: deriveCommitKind(deps.execution.executorConfig.manifests.get(member.ingredient_slug)?.category),
      ingredient: member.ingredient_slug, tool: member.op_id, args: member.input,
      source: plan.origin.source, ...memberOrigin(plan, member),
      channel_session_id: claim.future_execution_ref, correlation_id: claim.future_execution_ref,
      request_id: claim.run_id, dispatch_depth: member.invocation_path.filter(segment => segment.kind === 'recipe').length - 1,
      idempotency_key: claim.idempotency_key, dispatched_at: now(),
    }),
  });

  return {
    preparation,
    validateLive,
    resolveOrigin: deps.authority.resolve,
    resolveRecipeOrigin,
    ordinaryRecipe,
    capabilities(): PreapprovalCapabilities {
      const wired = deps.storage.isReady() ? deps.executionCapabilities()
        : { activation_kinds: [], bindings: [], child_calls: [], decision_channels: [] };
      return { protocol_version: PREAPPROVAL_PROTOCOL_VERSION, ...wired, limits: deps.storage.repository.limits() };
    },
    async prepare(raw: PreparePreapproval, origin: PreapprovalOrigin) {
      const request = parsePreparePreapproval(raw);
      if (!deps.storage.isReady() || !deps.executionCapabilities().activation_kinds.includes(request.activation.kind)) {
        throw new RpcError('preapproval_unsupported', 'The reviewed execution runtime is unavailable.', 503);
      }
      assertActivationAuthority(origin, request);
      const prior = await deps.storage.repository.preparedRequest(request, origin);
      if (prior) return prior;
      let draft: MailDraft | undefined;
      if (request.subject.kind === 'mail_draft') {
        if (!deps.drafts || !deps.mail) throw new RpcError('preapproval_unsupported', 'Saved draft scheduling is unavailable.', 503);
        const { contract_snapshot } = deps.authority.resolve(origin);
        const read = createSingleOperationAdmission({ source: origin.source, contract_snapshot,
          manifest: slug => deps.execution.executorConfig.manifests.get(slug),
          contractScan: deps.execution.contractScan, contractOverlay: deps.execution.contractOverlay,
          opAdmissionGate: deps.execution.opAdmissionGate, granted_recipe_steps: false, recipeCoversOp: () => false })
          ('mail-draft-read', { draft_id: request.subject.draft_id });
        if (read?.verdict !== 'admit') throw new RpcError('preapproval_unresolved',
          `The requester needs ordinary permission to read this draft before requesting review.${read?.verdict === 'deny' ? ` ${read.detail}` : ''}`, 403);
        draft = await deps.storage.drafts.get({ draft_id: request.subject.draft_id }, deps.drafts.principal(origin, 'get'));
        if (draft.revision !== request.subject.draft_revision) stale('The saved draft changed.');
      }
      const plan = db.transaction(() => {
        assertActivationAuthority(origin, request);
        const root = request.subject.kind === 'recipe' ? request.subject : draftCarrier();
        const boundOrigin = deps.authority.bindTargetRecipe(origin, root.publisher_id, root.recipe_id);
        const target = deps.activations.prepareTarget(request);
        const result = inventory(request, boundOrigin, target, undefined, 'prepare', draft);
        if (draft) {
          // D-264 — capability BEFORE plan shape. A draft-only mailbox produces
          // a perfectly well-formed plan, so the shape check below would pass it
          // and the owner would review a send that can never happen. And when
          // both are wrong, "this mailbox cannot send" is the one the owner can
          // act on; the carrier message would send them to edit a draft that is
          // fine.
          deps.mail!.assertCanSend(normalizeMailSend(draft.content).instance);
          const send = result.members.find(member => member.op_id === 'core.mail.send');
          if (!send || result.members.filter(member => member.parent_member_id === null).length !== 1
            || result.uncovered.length !== 0
            || preapprovalHash(normalizeMailSend(send.input)) !== preapprovalHash(normalizeMailSend(draft.content))) {
            stale('The installed mail carrier cannot preserve this saved draft. Update it before scheduling.');
          }
          result.interaction_notes.push('Approval keeps an independent copy of this draft. Later edits or deletion of the original will not change the scheduled message.');
        }
        return result;
      }).immediate();
      await deps.mail?.checkReady(plan);
      return deps.storage.repository.prepare(plan, origin.entry === 'kernel');
    },
  };
};
