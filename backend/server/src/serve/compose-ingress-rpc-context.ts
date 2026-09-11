import {
  composeExposureAndTlsRpcDeps,
  type ExposureAndTlsRpcDepsBundle,
} from '../composition/bin/wire-exposure-tls-rpc-deps.js';
import { createFormDefinitionReader } from '../form-contract-gate.js';
import { parseIntakeFormConfig } from '../ports/reception/transformations/intake-form.js';
import {
  composeMcpHttpTransport,
} from '../composition/bin/wire-mcp-http-transport.js';
import {
  createLlmGatewaySharedChatCompletionProvider,
  listLlmGatewayCallableRecipeNames,
} from '../ports/llm-gateway/handler.js';
import {
  MCP_INGREDIENT_TOOL_PREFIX,
  collectionSourceFreshnessOf,
  isCliIngredient,
  type McpInboundTokenRecord,
} from '@recued/contracts';
import {
  composeReceptionSubstrate,
  type ReceptionSubstrateBundle,
} from '../composition/bin/wire-reception-substrate.js';
import { composeReceptionWorkflowDispatch } from '../composition/bin/wire-reception-workflow-dispatch.js';
import {
  buildLoadFileCollectionRecord,
  createFileViewResolverFromRegistry,
} from '../file-view-resolver.js';
import { handleExecute } from '../execute-handler.js';
import {
  isVerifiedWebclientBundlePresent,
  resolveServedWebclientBundleDir,
} from '../webclient-bundle-loader.js';
import { createWarehouseStatusEntitySourceReader } from '../ports/reception/status-entity-source-reader.js';
// D-207 slice 1c — the reception door's op-id resolver (ingredient step → canonical grant).
import {
  composeRecipeOpResolver,
  composeRecipeOpRiskResolver,
} from '../recipe-capability-wiring.js';
import type { OpResolver } from '../derive-recipe-capability.js';
import type { RuntimeConfigStore } from '@recued/config';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import type { ExposureStateMachine } from '../exposure/index.js';
import type { ServerConfig } from '../server.js';
import type { WsServerHandle } from '../ws-server.js';
import type { AppContext } from './compose-app-context.js';
import type { CollectionContext } from './compose-collection-context.js';
import type { ExecutionContext } from './compose-execution-context.js';
import type { StorageContext } from './compose-storage-context.js';

export interface ComposeIngressRpcContextOptions {
  readonly dbPath: string;
  readonly storage: Pick<
    StorageContext,
    | 'db'
    | 'auditLog'
    | 'eventBus'
    | 'publicEndpointRegistryStoreRef'
    | 'receptionRegistryCacheRef'
    | 'receptionRateLimiterRef'
    | 'previewHashStoreRef'
    | 'hostnameRegistryStore'
    | 'schedulingFormNonceStoreRef'
    | 'intakeRecipePairStoreRef'
    | 'intakeFormSubmissionStoreRef'
    | 'intakeFormNonceStoreRef'
    | 'dropBlobStoreRef'
    | 'dropLinkNonceStoreRef'
    | 'approvalIntentStoreRef'
    | 'approvalLinkNonceStoreRef'
    | 'statusProjectionStoreRef'
    | 'ipBlockStoreRef'
    | 'workEntityStoreRef'
    | 'vaultStore'
    | 'executeRecuedRequestPersist'
    // D-173 P3 § A.7 — the recipe store backs the review-then-approve dispatch
    // seam's per-kind compiled-recipe resolution (`listForPack` → the
    // `review-then-approve` recipe).
    | 'recipeStore'
    | 'recordsStore'
    // D-139 P6.B — server-scoped body-content grant store for the MCP read.
    | 'mcpBodyVisibilityStore'
  >;
  readonly app: Pick<
    AppContext,
    | 'keys'
    | 'warehouseBus'
    | 'llmManager'
    | 'llmConfig'
    | 'llmQuota'
    | 'llmAdapterRegistry'
    | 'emptyTabProbe'
    | 'housekeepingStateRef'
    | 'internalRegistryRef'
    | 'chatInboundTokenStoreRef'
    | 'chatOrchestratorRef'
    | 'sellerStoreRef'
    | 'sellerOrderStoreRef'
    | 'sellerClaimStoreRef'
    | 'receptionManageCredentialStoreRef'
    | 'connectionStoreRef'
    | 'sharedStoreRef'
    | 'clientTokensRef'
    | 'contactStoreRef'
    // D-220 Slice B — the contract store the pack install writes shipped intake
    // templates into; `reception.template.list` reads them back through it.
    | 'contractStoreRef'
    // D-139 P5 — engagement-evidence resolver bundle for the
    // `recued_contactEngagementsList` MCP read.
    | 'contactEngagementsResolveDepsRef'
    | 'cacheBlobs'
    // D-172 P3 § A.5 — the annotation deps back the drop_link drain's
    // `attachFile` (file → contact / project `attachment` links).
    | 'annotationDeps'
    // D-192 Fork B (B3) — the remote-file meta-store feeds the MCP
    // `data.timeline` file raw-record loader (built at the call site below).
    | 'fileMetaStoreRef'
    | 'fileSourceSyncStateRef'
    // Vault-lock gate for MCP tools/call (refuse execution while sealed).
    | 'isVaultUnlocked'
  >;
  // D-172 P3 § A.5 — the file collection + registry the drop_link drain
  // ingests into + attaches against. Optional so existing callers / the
  // dbless harness (no collection context) keep working — absent ⇒ no drop
  // drain (the substrate gate degrades to a no-op).
  readonly collection?: Pick<
    CollectionContext,
    'inboundFileCollection' | 'collectionRegistry'
  >;
  readonly execution: Pick<
    ExecutionContext,
    // D-207 slice 1c — the two contract stores the reception door is minted into.
    'executeDeps' | 'contractDefinitionStore' | 'grantEntryStore'
  >;
  readonly backgroundServices: BackgroundServiceRegistry;
  readonly getExposureMachine: () => ExposureStateMachine | undefined;
  readonly getWsHandleForLockout: () => WsServerHandle | undefined;
  /** R26.2 Delta 2 — runtime-config store backing the apex (`GET /`)
   *  serving mode. Forwarded to the exposure rpc deps so `exposure.set_apex`
   *  persists `network.apex_mode` (read hot by the root handler). */
  readonly runtimeConfig?: RuntimeConfigStore;
  // `env?: Record<string, string | undefined>` was removed 2026-07-28. It was
  // the injection point for the v1 `RECUED_MCP_HTTP_TOKEN` bearer; that path is
  // retired (`wire-mcp-http-transport.ts` now returns 401 for old env values —
  // only structured `<token_id>.<bearer>` and D-171 `recued_*` door tokens are
  // accepted). Nothing in this composer read the field afterwards, so it was a
  // declared-but-unbacked option threaded in from `startPreListenerRuntime`.
  // NOTE: the env seam itself is still LIVE one layer over — the client-security
  // phase forwards it to the cert stack, which reads
  // `RECUED_PRO_ENTITLEMENT_MINT_URL` / `_PUBLIC_KEY_B64` from it. Only THIS
  // declaration was dead. (Naming that composer literally here would trip the
  // source-boundary test that keeps this file out of later serve phases.)
}

export interface IngressRpcContext
  extends Pick<
    ExposureAndTlsRpcDepsBundle,
    'exposureRpcDeps' | 'tlsDomainStore' | 'tlsDomainRpcDeps'
  > {
  readonly receptionRpcDeps: ReceptionSubstrateBundle['receptionRpcDeps'] | undefined;
  readonly receptionPortDeps: ReceptionSubstrateBundle['receptionPortDeps'] | undefined;
  readonly mcpHttpDeps: ServerConfig['mcpHttpDeps'];
  readonly llmGatewayDeps: ServerConfig['llmGatewayDeps'];
}

export const composeIngressRpcContext = async (
  options: ComposeIngressRpcContextOptions,
): Promise<IngressRpcContext> => {
  const {
    dbPath,
    storage,
    app,
    collection,
    execution,
    backgroundServices,
    getExposureMachine,
    getWsHandleForLockout,
    runtimeConfig,
  } = options;

  // D-172 P3 § A.5 — assemble the drop_link drain's file-substrate deps.
  // The drain needs the `received` collection (`ingest`) + `attachFile`
  // deps (the annotation store + collection registry). Both must be
  // present for the substrate to register the processor; built here so a
  // partial collection/app context (boot phase / dbless harness) cleanly
  // omits them (conditional spreads below → the matcher treats them as
  // absent, the substrate gate degrades to a no-op).
  const dropAttachFileDeps =
    app.annotationDeps && collection?.collectionRegistry
      ? { annotationDeps: app.annotationDeps, registry: collection.collectionRegistry }
      : undefined;

  // R26.2 Delta 3 — boot-time servability probe for the apex `serve_webclient`
  // consistency gate. The `exposure.set_apex` setter must reject serve_webclient
  // when no verified bundle is deployed — otherwise it reports success but the
  // root handler answers bare `/` with a 404. This is the SAME verified-load
  // predicate the serving path applies (`createServerHandlerSet` builds the
  // `webclient` handler only from a `config.webclientBundle` that passed this
  // load + verify), computed once here at boot so the setter + the live root
  // handler agree on bundle availability. (The serving path reloads the bundle
  // in `compose-listeners`; a second small boot-time read here keeps the two
  // consumers decoupled.)
  const webclientBundleDir = resolveServedWebclientBundleDir(
    app.cacheBlobs?.root,
    process.env.RECUED_WEBCLIENT_DIR,
  );
  const webclientBundlePresent = webclientBundleDir
    ? await isVerifiedWebclientBundlePresent(webclientBundleDir)
    : false;

  const { exposureRpcDeps, tlsDomainStore, tlsDomainRpcDeps } =
    composeExposureAndTlsRpcDeps({
      db: storage.db,
      keys: app.keys,
      getExposureMachine,
      getWsHandleForLockout,
      webclientBundlePresent,
      // R26.2 Delta 2 — wires the `exposure.{get,set_apex}` apex get/set.
      ...(runtimeConfig ? { runtimeConfig } : {}),
    });

  // D-149 P9 § A.5.6 — build the production status_link entity-source
  // reader from the work-entity warehouse (+ optional contact store for
  // counterparty redaction). Wiring it flips `statusLinkReady` true so an
  // enabled status_link serves the live projection instead of the 503
  // stub. Absent work-entity store (boot-phase) ⇒ reader undefined ⇒ the
  // dispatcher keeps the 503 fallback.
  const statusEntitySourceReader = storage.workEntityStoreRef
    ? createWarehouseStatusEntitySourceReader({
        workEntityStore: storage.workEntityStoreRef,
        ...(app.contactStoreRef ? { contactStore: app.contactStoreRef } : {}),
        now: () => Date.now(),
      })
    : undefined;

  // D-173 P3 § A.7 — the review-then-approve dispatch seam (the SINGLE path
  // for REVIEW-mode reception endpoints, the default). Built from the public
  // execute handler + the recipe store; threaded into both drain processors so
  // a pending submission fires its compiled `review-then-approve` recipe (held
  // at the D-157 gate → inbox) instead of auto-materializing. `executeDeps` is
  // always present at this site (used by `composeMcpHttpTransport` below);
  // `recipeStore` is the per-pair store. Gated on both — absent ⇒ no seam ⇒
  // review-mode rows stay pending (never auto-materialized — I-1).
  const fireReceptionWorkflow =
    execution.executeDeps && storage.recipeStore
      ? composeReceptionWorkflowDispatch({
          executeDeps: execution.executeDeps,
          recipeStore: storage.recipeStore,
          handleExecute,
          now: () => Date.now(),
        })
      : undefined;

  // D-207 slice 1c — map an ingredient step's (catalog slug, `input.operation`) back to the
  // canonical op id(s) it dispatches, so the door's derived closure names a GRANT and not
  // just a slug. Without it every ingredient step contributes no op id, the closure
  // under-derives, and the door hard-denies mid-run on an op the owner was never shown —
  // exactly the failure `deriveRecipeCapability` refuses rather than skips.
  //
  // D-209 #1 W2b — construction extracted to `recipe-capability-wiring.ts` so the
  // webhook door's save/install wiring composes the IDENTICAL resolvers (two
  // hand-rolled lambdas would be two derivations that can drift). The inventory
  // scan + manifest registry are still read INSIDE the resolver per call, never
  // captured at boot — a bind must see the inventory as it is at that moment.
  const executeDeps = execution.executeDeps;
  const resolveRecipeOp: OpResolver | undefined = composeRecipeOpResolver(executeDeps);

  // D-207 slice 3c — an op id's RISK TIER, for the responding-door fence.
  // (Falls back to the kernel registry at the fence itself; `undefined` is NOT
  // "safe" — an unclassifiable op refuses on a responding door.)
  const resolveRecipeOpRisk: ((opId: string) => string | undefined) | undefined =
    composeRecipeOpRiskResolver(executeDeps);

  const receptionBundle = await composeReceptionSubstrate({
    // WatchSource reception push source — verified mutation arrivals
    // emit `data.reception.<kind>.request.created` on the one bus.
    warehouseBus: app.warehouseBus,
    publicEndpointRegistryStore: storage.publicEndpointRegistryStoreRef,
    receptionRegistryCache: storage.receptionRegistryCacheRef,
    receptionRateLimiter: storage.receptionRateLimiterRef,
    previewHashStore: storage.previewHashStoreRef,
    auditLog: storage.auditLog,
    keys: app.keys,
    eventBus: storage.eventBus,
    dbPath,
    // D-172 step 5a — the per-pair db handle backs the SHARED `upload_session`
    // store for the reception resumable-upload service.
    db: storage.db,
    backgroundServices,
    executeRecuedRequestPersist: storage.executeRecuedRequestPersist,
    llmConfig: app.llmConfig,
    llmQuota: app.llmQuota,
    // D-250 § D — Compose's propose call is real owner provider spend; count it.
    addOwnerTokenUsage: (tokens) => { app.llmManager?.addUsage(tokens); },
    llmAdapterRegistry: app.llmAdapterRegistry,
    emptyTabProbe: app.emptyTabProbe,
    hostnameRegistryStore: storage.hostnameRegistryStore,
    approvalIntentStore: storage.approvalIntentStoreRef,
    statusProjectionStore: storage.statusProjectionStoreRef,
    statusEntitySourceReader,
    workEntityStore: storage.workEntityStoreRef,
    // D-207 slice 3c — what the reception RUNNER opens an order against when a paired
    // recipe's config names an offer; also the rpc handler's offer read.
    sellerOfferStore: app.sellerStoreRef,
    sellerOrderStore: app.sellerOrderStoreRef,
    sharedStore: app.sharedStoreRef,
    ...(fireReceptionWorkflow ? { fireReceptionWorkflow } : {}),
    ipBlockStore: storage.ipBlockStoreRef,
    schedulingFormNonceStore: storage.schedulingFormNonceStoreRef,
    intakeFormSubmissionStore: storage.intakeFormSubmissionStoreRef,
    intakeRecipePairStore: storage.intakeRecipePairStoreRef,
    recipeStore: storage.recipeStore,
    recordsStore: storage.recordsStore,
    // D-220 Slice B — the SAME contract store the pack install writes its shipped
    // intake templates into, so `reception.template.list` reads what install wrote.
    contractStore: app.contractStoreRef,
    // D-207 slice 1c — the door. `contractDefinitionStore` / `grantEntryStore` are the SAME
    // instances the Gateway reads its verdicts from, so a grant the mint writes is a grant
    // the gate can see. `executeDeps` is what a bound door's recipe actually runs through.
    contractDefinitionStore: execution.contractDefinitionStore,
    grantEntryStore: execution.grantEntryStore,
    executeDeps: execution.executeDeps,
    dishStore: execution.executeDeps.dishStore,
    ...(resolveRecipeOp ? { resolveRecipeOp } : {}),
    ...(resolveRecipeOpRisk ? { resolveRecipeOpRisk } : {}),
    connectionStore: app.connectionStoreRef,
    intakeFormNonceStore: storage.intakeFormNonceStoreRef,
    dropBlobStore: storage.dropBlobStoreRef,
    blobStore: app.cacheBlobs,
    dropLinkNonceStore: storage.dropLinkNonceStoreRef,
    approvalLinkNonceStore: storage.approvalLinkNonceStoreRef,
    sellerClaimStore: app.sellerClaimStoreRef,
    receptionManageCredentialStore: app.receptionManageCredentialStoreRef,
    // D-172 P3 § A.5 — drop_link drain file-substrate deps. Conditional
    // spreads so an absent collection/app context omits them (no drop
    // drain registered). `contactStore` resolves the pre-bound contact_id
    // → email for the contact-attach + `require_contact_email_match`.
    ...(collection?.inboundFileCollection
      ? { inboundFileCollection: collection.inboundFileCollection }
      : {}),
    ...(dropAttachFileDeps ? { attachFileDeps: dropAttachFileDeps } : {}),
    ...(app.contactStoreRef ? { contactStore: app.contactStoreRef } : {}),
  });

  const mcpHttpBundle = composeMcpHttpTransport({
    executeDeps: execution.executeDeps,
    // Vault-lock gate — MCP `tools/call` is refused while the server vault is
    // LOCKED, so no MCP-driven side effect fires on a sealed server (parity
    // with the autonomous executors' pause-while-locked contract).
    isVaultUnlocked: app.isVaultUnlocked,
    vaultStore: storage.vaultStore,
    housekeepingStateStore: app.housekeepingStateRef,
    internalRegistry: app.internalRegistryRef,
    clientTokens: app.clientTokensRef,
    // D-171 external-door transport — door bearers (`recued_*`) resolve
    // against the inbound token store, carrying per-tool grants + the
    // bound contract (D-166 P2) into the per-call MCP deps.
    inboundTokenStore: app.chatInboundTokenStoreRef,
    // D-196 seller-customer admission — valid inbound bearer rows remain
    // authenticated, then seller customer status / grace / tier state can still
    // close the bound customer door at dispatch.
    sellerStore: app.sellerStoreRef,
    // D-220 — gate `recued_saveRecipe` with the SAME form-field contract as the
    // `recipe.save` rpc. Finding 3.2: the MCP tool called the store directly, so
    // an authenticated caller could arm a `form_response.accepted` trigger against
    // a form that does not collect the declared field.
    ...(storage.publicEndpointRegistryStoreRef
      ? {
          formDefinitionReader: createFormDefinitionReader(
            (filter) => storage.publicEndpointRegistryStoreRef!.list(filter),
            parseIntakeFormConfig,
          ),
        }
      : {}),
    // D-139 P5 — `recued_contactEngagementsList` resolves engagement
    // evidence (body-stripped projection). Shared bundle from app-context.
    engagementsResolveDeps: app.contactEngagementsResolveDepsRef,
    // D-139 P6.B — server-scoped body-content grant store (shared instance
    // from storage-context). Flips the engagement read from body-stripped
    // to body-inline once the `crm-commitment-tracker` pack is installed.
    mcpBodyVisibilityStore: storage.mcpBodyVisibilityStore,
    // D-192 Fork B (B3) — the `data.timeline` file raw-record loader (CAS +
    // vendor mirror). Only when a collection registry exists; the timeline's
    // D-187 grant gate still fences it. Absent ⇒ file records stay unwired.
    ...(collection?.collectionRegistry
      ? {
          loadCollectionRecord: buildLoadFileCollectionRecord(
            createFileViewResolverFromRegistry(
              collection.collectionRegistry,
              app.fileMetaStoreRef,
              app.fileSourceSyncStateRef,
            ),
          ),
          // D-236 join — scope→source-freshness for `registryDescribe`'s
          // coverage-band cap: every registered instance whose platform equals
          // the enrichment scope, with its live D-236 verdict. Same call form
          // as the collection dispatchers (`collectionSourceFreshnessOf`
          // tolerates a throwing adapter). Scopes with no registered platform
          // (derived scopes, vendor platform-reference) yield [] ⇒ no cap.
          sourceFreshnessByScope: (scope: string, now: number) =>
            collection.collectionRegistry
              .list()
              .filter((c) => c.platform === scope)
              .map((c) => ({
                instance: c.slug,
                freshness: collectionSourceFreshnessOf(c.health, now),
              })),
        }
      : {}),
  });
  mcpHttpBundle?.logBootBanner();

  const listContractCallableChatToolNames = (
    token: McpInboundTokenRecord,
  ): ReadonlyArray<string> => {
    const principal = token.contract_id;
    const manifests = execution.executeDeps.executorConfig.manifests;
    return listLlmGatewayCallableRecipeNames({
      entries: app.internalRegistryRef?.list() ?? [],
      token,
      getRecipe: (recipeId) => storage.recipeStore.get(recipeId),
      resolveIngredientKind: (slug) => {
        const manifest = manifests.get(slug);
        if (!manifest) return null;
        return isCliIngredient(manifest) ? 'cli' : 'other';
      },
      isCliOperationReachable: (slug, operationId) => {
        if (!principal) return false;
        const manifest = manifests.get(slug);
        // Match the engine's executable CLI floor, not merely a stale grid row:
        // the op must still be declared and carry the per-op cli_invocation
        // binding. An API+CLI hybrid stays hidden here (the engine gives a
        // dispatchable API binding precedence), which is safely narrower.
        if (
          !manifest
          || manifest.operations?.[operationId]?.risk_tier === undefined
          || manifest.surfaces?.connector?.executes?.[operationId]?.kind
            !== 'cli_invocation'
          || manifest.surfaces?.api?.executes?.[operationId] !== undefined
        ) return false;
        try {
          return execution.executeDeps.cliReachabilityResolver?.(
            principal,
            slug,
            operationId,
          ) === true;
        } catch {
          return false;
        }
      },
    });
  };

  const llmGatewayDeps: ServerConfig['llmGatewayDeps'] | undefined =
    app.chatInboundTokenStoreRef && app.chatOrchestratorRef?.runLlmGatewayTurn
      ? {
          inboundTokenStore: app.chatInboundTokenStoreRef,
          contractOverlay: execution.executeDeps.contractOverlay,
          ...(app.sellerStoreRef ? { sellerStore: app.sellerStoreRef } : {}),
          getLlmConfig: () => {
            try {
              return app.llmManager?.getConfig() ?? app.llmConfig;
            } catch {
              return app.llmConfig;
            }
          },
          completionProvider: createLlmGatewaySharedChatCompletionProvider({
            orchestrator: {
              runLlmGatewayTurn:
                app.chatOrchestratorRef.runLlmGatewayTurn.bind(app.chatOrchestratorRef),
            },
            adapters: app.llmAdapterRegistry,
            quota: app.llmQuota,
            tabProbe: app.emptyTabProbe,
          }),
          quota: app.llmQuota,
          systemToolsAllowed: ({ token }) =>
            listContractCallableChatToolNames(token).length > 0,
          listContractCallableChatToolNames,
          listContractAllowedToolSlugs: (token) => {
            const manifests = execution.executeDeps.executorConfig.manifests;
            const allowed = manifests.slugs().filter(
              (slug) =>
                token.grants[slug] === true
                || token.grants[`${MCP_INGREDIENT_TOOL_PREFIX}${slug}`] === true,
            );
            const principal = token.contract_id;
            if (principal) {
              for (
                const slug of
                  execution.executeDeps.cliReachableSlugsForPrincipal?.(principal) ?? []
              ) {
                if (
                  !allowed.includes(slug)
                  && isCliIngredient(manifests.get(slug))
                ) {
                  allowed.push(slug);
                }
              }
            }
            return allowed;
          },
        }
      : undefined;

  return {
    exposureRpcDeps,
    tlsDomainStore,
    tlsDomainRpcDeps,
    receptionRpcDeps: receptionBundle?.receptionRpcDeps,
    receptionPortDeps: receptionBundle?.receptionPortDeps,
    mcpHttpDeps: mcpHttpBundle?.mcpHttpDeps,
    llmGatewayDeps,
  };
};
