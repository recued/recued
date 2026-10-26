/** Read-only comparison through ordinary admission. No executor/provider capability. */
import type Database from 'better-sqlite3';
import { RpcError, isStandingContractDefinition, isContractActive, isMcpInboundTokenActive, isReadableCollection,
  isEnrichmentTopic, isExternallyExposableIngredient, parseGrantEntry, kernelOpForBackingSlug, parsePreapprovalJson, isGrantableKernelOp, READABLE_COLLECTIONS, ENRICHMENT_REGISTRY, OWNER_CONTRACT_ID, PUBLIC_CONTRACT_ID,
  type ExecutionSource, type PermissionDocument, type PermissionGrantChange, type PermissionDecision,
  type PermissionComparison, type PermissionGrant, type PermissionCatalogEntry, type RecipeDefinition } from '@recued/contracts';
import { mergeManifestStepInput } from '@recued/ingredients';
import type { ContractStore } from './storage/contract-store.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';
import type { ChatInboundTokenStore } from './storage/chat-inbound-token-store.js';
import { createOpAdmissionGate } from './op-admission-gate.js';
import { createContractOverlayResolver } from './policy-contract-overlay.js';
import { buildVersionedContractSnapshot } from './contract-snapshot-version.js';
import { createApprovalResumeAuthorityResolver } from './approval-resume-authority.js';
import { createPreapprovalAdmission, type PreapprovalAdmissionDeps } from './preapproval-admission.js';
import { normalizePreapprovalCall } from './preapproval-dispatch-description.js';
import { preapprovalHash as digest } from './preapproval-invocations.js';
import { collectPreapprovalContractReads, readPreapprovalContractQuery } from './storage/preapproval-contract-reads.js';
import type { PreapprovalOrigin, PreparedRecipeSnapshot, PreapprovalDependency } from './preapproval-model.js';
import { permissionRegressionImpact, type PermissionAutomation } from './permission-regression-impact.js';

export interface PermissionRegressionHostDeps {
  db: Database.Database; contracts: ContractStore; definitions: ContractDefinitionStore; grants: ContractGrantEntryStore;
  inbound: ChatInboundTokenStore; execution: PreapprovalAdmissionDeps['execution']; profiles: PreapprovalAdmissionDeps['profiles'];
  automations(): PermissionAutomation[]; now?: () => number;
}
export const createPermissionRegressionHost = (deps: PermissionRegressionHostDeps) => {
  if (deps.contracts.realmDatabase !== deps.db || deps.grants.realmDatabase !== deps.db) throw new Error('Permission grants must share the workbench realm database.');
  const now = deps.now ?? Date.now, manifests = deps.execution.executorConfig.manifests;
  const catalog = (): PermissionCatalogEntry[] => {
    const entries: PermissionCatalogEntry[] = [];
    for (const slug of manifests.slugs().sort()) {
      const manifest = manifests.get(slug); if (!manifest) continue;
      const kernel = kernelOpForBackingSlug(slug);
      if (kernel && isGrantableKernelOp(kernel)) entries.push({ kind: 'operation', entry_key: kernel, ingredient: slug, label: manifest.name });
      for (const [key, operation] of Object.entries(manifest.operations ?? {})) entries.push({ kind: 'operation', entry_key: operation.operation_id,
        ingredient: slug, operation: key, label: manifest.name + ' · ' + key });
    }
    entries.push(...READABLE_COLLECTIONS.map(collection => ({ kind: 'collection' as const, entry_key: 'data.' + collection, label: collection + ' collection' })),
      ...Object.keys(ENRICHMENT_REGISTRY).map(topic => ({ kind: 'topic' as const, entry_key: 'enrichment.' + topic, label: topic + ' topic' })));
    const rank = (entry: PermissionCatalogEntry) => entry.kind === 'collection' ? 0 : entry.kind === 'topic' ? 1 : entry.entry_key.startsWith('core.') ? 2 : 3;
    return entries.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  };
  const context = (contractId: string) => {
    const definition = deps.definitions.get(contractId), grants = deps.grants.listForContract(contractId);
    const credentials = deps.inbound.listTokens().filter(item => item.contract_id === contractId);
    const targetSupported = contractId !== OWNER_CONTRACT_ID && contractId !== PUBLIC_CONTRACT_ID && !!definition && isStandingContractDefinition(definition) && !definition.door_types?.some(type => type === 'reception' || type === 'webhook')
      && isContractActive(definition, now()) && (definition.door_types?.length ? definition.door_types.includes('mcp') : true);
    const lineage = deps.db.prepare("SELECT 1 FROM sqlite_master WHERE name='preapproval_state' AND type='table'").get()
      ? deps.db.prepare('SELECT lineage FROM preapproval_state WHERE singleton=1').pluck().get() : null;
    const supported = targetSupported && typeof lineage === 'string' && lineage.length > 0;
    const available = catalog();
    return { catalog: available.slice(0, 2000), catalog_truncated: available.length > 2000, supported, ...(supported ? {} : { reason: 'Open an active ordinary contract with an MCP door. Derived doors, customer contracts and owner-wide grants use their own controls.' }),
      grants, credentials: credentials.map(item => ({ id: item.token_id, label: item.label, active: isMcpInboundTokenActive(item, now()) })),
      live_digest: digest({ definition, grants, lineage }) };
  };
  const validateChanges = (changes: PermissionGrantChange[]) => {
    const operations = new Set<string>();
    for (const slug of manifests.slugs()) {
      const manifest = manifests.get(slug); const kernel = kernelOpForBackingSlug(slug); if (kernel && isGrantableKernelOp(kernel)) operations.add(kernel);
      for (const operation of Object.values(manifest?.operations ?? {})) operations.add(operation.operation_id);
    }
    for (const change of changes) {
      const entry = parseGrantEntry(change.entry_key);
      if (!(entry.kind === 'op' && operations.has(entry.value) || entry.kind === 'collection' && isReadableCollection(entry.value)
        || entry.kind === 'topic' && isEnrichmentTopic(entry.value))) {
        throw new RpcError('permission_regression_unsupported', 'Choose a declared operation, readable collection or enrichment topic. Recipe and peer-label grants are outside this workbench.', 409);
      }
    }
  };
  const overlayGrants = (contractId: string, changes: PermissionGrantChange[]): ContractGrantEntryStore => ({ ...deps.grants,
    get(id, entry) {
      const original = deps.grants.get(id, entry); // Track the live query even when projecting a candidate value.
      const change = id === contractId ? changes.find(item => item.entry_key === entry) : undefined;
      return change ? change.granted ?? undefined : original;
    },
  });
  const evaluate = (contractId: string, document: PermissionDocument) => deps.db.transaction(() => {
    const collected = collectPreapprovalContractReads(deps.db, () => {
      const current = context(contractId); if (!current.supported) throw new RpcError('permission_regression_unsupported', current.reason!, 409);
      validateChanges(document.changes);
      const side = (changes: PermissionGrantChange[]): PermissionDecision[] => {
        const grants = overlayGrants(contractId, changes), overlay = createContractOverlayResolver({ definitionStore: deps.definitions, grantEntryStore: grants, now });
        const gate = { ...createOpAdmissionGate({ definitionStore: deps.definitions, grantEntryStore: grants, now }),
          isFrozenByPause: (source: ExecutionSource) => deps.execution.opAdmissionGate?.isFrozenByPause(source) ?? true };
        const authority = createApprovalResumeAuthorityResolver({ manifests, inboundTokenStore: deps.inbound, contractOverlay: overlay, opAdmissionGate: gate, now });
        return document.cases.map(item => {
          const token = deps.inbound.getTokenById(item.credential_id);
          if (!token || token.contract_id !== contractId || !isMcpInboundTokenActive(token, now())) return { verdict: 'deny', detail: 'The selected credential is missing, inactive or bound to another contract.' };
          const source: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'permission-tests', tool_call_id: item.id,
            mcp_token_id: token.token_id, contract_id: contractId };
          if (!overlay.isContractLive(contractId) || overlay.permitsDoorType?.(contractId, 'mcp') !== true || gate.isFrozenByPause(source)) return { verdict: 'deny', detail: 'The contract or MCP door is inactive, or the server is paused.' };
          if (item.target.kind !== 'operation') {
            const checker = overlay.resolveReadGrantChecker?.(source);
            if (!checker) return { verdict: 'unsupported', detail: 'The read-grant checker is unavailable.' };
            if (item.target.kind === 'collection' && !isReadableCollection(item.target.collection)
              || item.target.kind === 'topic' && !isEnrichmentTopic(item.target.topic)) return { verdict: 'unsupported', detail: 'This read grant is not registered.' };
            const allowed = item.target.kind === 'collection' ? checker.isCollectionReadGranted(item.target.collection)
              : isEnrichmentTopic(item.target.topic) && checker.isTopicReadGranted(item.target.topic);
            return { verdict: allowed ? 'allow' : 'deny', detail: 'Read-grant axis only. Operation, bearer, item-sphere and runtime checks still apply.' };
          }
          const target = item.target, manifest = manifests.get(target.ingredient);
          if (!manifest) return { verdict: 'unsupported', detail: 'The ingredient is unavailable.' };
          const op = kernelOpForBackingSlug(target.ingredient), catalogCall = Object.keys(manifest.operations ?? {}).length > 0;
          if (!isExternallyExposableIngredient(manifest)) return { verdict: 'unsupported', detail: 'This operation is not exposed directly through MCP. Its receiving recipe or local-tool path needs separate qualification.' };
          const declaredOp = typeof target.input.operation === 'string' ? manifest.operations?.[target.input.operation]?.operation_id : undefined;
          if (catalogCall && !declaredOp) return { verdict: 'unsupported', detail: 'Choose a declared catalog operation.' };
          const bearer = authority.resolve({ execution_source: source, ...(catalogCall ? { required_raw_op_id: declaredOp }
            : { required_bearer_tool_names: [target.ingredient, 'recued_ingredient_' + target.ingredient, ...(op ? [op] : [])] }) });
          if (!bearer.admitted) return { verdict: 'deny', detail: bearer.detail };
          // Match admitRawOp's backing-slug alias only after normal raw-op
          // authority resolved the declared operation under this live contract.
          const resolved = catalogCall && bearer.contract_snapshot ? { ...bearer, contract_snapshot: buildVersionedContractSnapshot({
            ...bearer.contract_snapshot, allowed_tools: [...bearer.contract_snapshot.allowed_tools, target.ingredient] }) } : bearer;
          const definition: RecipeDefinition = { recipe_id: 'permission-example', version: 1, ttl: 0,
            metadata: { name: 'Permission example', description: 'Admission only.', author: 'core', supported_platforms: [] }, variables: {}, prefetch_steps: [],
            steps: [{ id: 'example', ingredient: target.ingredient, input: target.input }], output: { sidebar: [] } };
          const hash = digest(definition), snapshot: PreparedRecipeSnapshot = { recipe_id: definition.recipe_id, publisher_id: 'core', definition_hash: hash,
            dispatch_hash: hash, definition, effective_config: {}, invocation_path: [{ kind: 'recipe', recipe_id: definition.recipe_id, publisher_id: 'core', definition_hash: hash }] };
          const origin: PreapprovalOrigin = { mode: 'contract', contract_id: contractId, source, entry: 'kernel', credential_id: token.token_id,
            credential_label: token.label, entry_tool_grants: [], recipe_grant_key: null, target_recipe_grant_key: null, display_name: token.label };
          try {
            const admission = createPreapprovalAdmission({ execution: { ...deps.execution, opAdmissionGate: gate, contractOverlay: overlay }, profiles: deps.profiles,
              root_recipe_id: definition.recipe_id, authority: { resolve: () => resolved,
                bindTargetRecipe: value => value, validateActivationPermission() { throw new Error('Tests cannot activate work.'); },
                validateResponder() { throw new Error('Tests cannot answer approvals.'); } } });
            const result = admission(normalizePreapprovalCall({ manifest, slug: target.ingredient,
              input: parsePreapprovalJson(mergeManifestStepInput(manifest.input, target.input, { trustedSurfaceDispatch: false })) as Record<string, import('@recued/contracts').PreapprovalJson>,
              output: {}, connection_name: target.connection ?? '', catalog: Object.keys(manifest.operations ?? {}).length > 0,
              origin, recipe: snapshot, path: [...snapshot.invocation_path, { kind: 'step', phase: 'sequential', step_id: 'example' }] }));
            return { verdict: result.verdict === 'admit' ? 'allow' : result.verdict,
              detail: result.reason ?? (result.verdict === 'ask' ? 'Ordinary operation policy requires approval.' : 'Ordinary admission permits this example before later runtime checks.') };
          } catch (error) { return { verdict: 'unsupported', detail: error instanceof Error ? error.message : 'This concrete call cannot be evaluated.' }; }
        });
      };
      const before = side([]), after = side(document.changes);
      const cases = document.cases.map((item, index) => ({ id: item.id, name: item.name, expected: item.expected,
        current: before[index]!, candidate: after[index]!, passed: after[index]!.verdict === item.expected }));
      const comparison: PermissionComparison = { cases, passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length,
        impact: permissionRegressionImpact(deps.db, contractId, document, deps.execution.recipeStore, manifests, deps.automations()) };
      const environment = digest({ current: current.live_digest, manifests: manifests.slugs().sort().map(slug => manifests.get(slug)),
        connections: deps.profiles.connectionStore.list({}), comparison });
      return { comparison, environment, live_digest: current.live_digest };
    });
    return { ...collected.result, dependencies: collected.dependencies };
  }).immediate();
  return { sharesRealm: (database: Database.Database): boolean => database === deps.db, context, evaluate, validateChanges,
    assertDependencies(dependencies: PreapprovalDependency[]) {
      for (const pin of dependencies) if (digest(readPreapprovalContractQuery(deps.db, pin.key)) !== digest(pin)) {
        throw new RpcError('permission_regression_conflict', 'A policy or credential changed. Test and review the current draft again.', 409);
      }
    },
    apply(contractId: string, changes: PermissionGrantChange[], at: number) {
      if (!deps.db.inTransaction) throw new Error('Grant activation requires the realm transaction.');
      for (const change of changes) { if (change.granted !== null && deps.grants.get(contractId, change.entry_key) === change.granted) continue;
        if (change.granted === null) deps.grants.clear(contractId, change.entry_key);
        else deps.grants.set(contractId, change.entry_key, change.granted, at); }
    },
    projectedGrants(grants: PermissionGrant[], changes: PermissionGrantChange[], at: number): PermissionGrant[] {
      const result = new Map(grants.map(item => [item.entry_key, item]));
      for (const change of changes) { if (change.granted !== null && result.get(change.entry_key)?.granted === change.granted) continue;
        if (change.granted === null) result.delete(change.entry_key);
        else result.set(change.entry_key, { entry_key: change.entry_key, granted: change.granted, set_at: at }); }
      return [...result.values()].sort((a, b) => a.entry_key < b.entry_key ? -1 : a.entry_key > b.entry_key ? 1 : 0);
    },
  };
};
export type PermissionRegressionHost = ReturnType<typeof createPermissionRegressionHost>;
