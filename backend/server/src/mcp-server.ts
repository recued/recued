/** MCP server — expose recued-server as tools over stdio.
 *
 *  Any AI agent (Claude Desktop, Cursor, OpenClaw, custom agents) can
 *  call Recued recipes as MCP tools. Zero external deps — implements
 *  the minimal JSON-RPC 2.0 + MCP protocol subset needed for tool
 *  serving.
 *
 *  Protocol: JSON-RPC 2.0 over stdin/stdout (one JSON object per line).
 *
 *  Tools exposed (7 after the D-120 Phase 5 timeline addition):
 *  - recued_listRecipes     — discovery
 *  - recued_getRecipe       — detail + input schema
 *  - recued_listIngredients — ingredient catalog (for composing inline recipes)
 *  - recued_runRecipe       — execute (by id or inline)
 *  - recued_getAudit        — recent run history
 *  - recued_saveRecipe      — persist an MCP-authored recipe to the server's
 *                             store (extension picks it up on next pair-sync)
 *  - recued_dataTimeline    — chronological feed across raw collections +
 *                             (D-226) plus per-pack `rollups` for a contact —
 *                             standing aggregates, not feed entries +
 *                             annotations + memory for one entity (D-120)
 *
 *  Removed vs original: addSchedule, listSchedules, removeSchedule,
 *  setVault, checkHealth, validateRecipe. Scheduling is cloud-owned;
 *  vault is pair-synced; validation is implicit in runRecipe/saveRecipe.
 */

import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { handleExecute, type ExecuteHandlerDeps } from './execute-handler.js';
import { buildVersionedContractSnapshot } from './contract-snapshot-version.js';
import {
  HELD_FOR_APPROVAL_MESSAGE,
  projectRunResultForAgent,
} from './run-result-agent-projection.js';
import { dispatchRawOp } from './raw-op-dispatch.js';
import { buildPackOpResolution, type InstalledPackScan } from './pack-inventory.js';
// D-225 § 9.5.1 — the raw-op projection now lives in a shared module so the
// CHAT catalog can consume the same source the door does. Behaviour unchanged.
import {
  OP_TOOL_PREFIX,
  RAW_OP_TOOL_INPUT_SCHEMA,
  buildRawOpToolDescriptors,
  ingredientRiskToGrantClassification,
  rawOpToolEntries,
  type RawOpToolDescriptor,
} from './raw-op-tool-catalog.js';
import { executionSourceContractId } from '@recued/contracts';
import { RUN_INGREDIENT_RECIPE } from './run-ingredient-recipe.js';
import { PEER_RECEIVE_ANSWER_TOOL, PEER_RECEIVE_ASK_TOOL } from './peer-receive-ask-recipe.js';
import { checkFormContract, type FormDefinitionReader } from './form-contract-gate.js';
import {
  executeResponseAuditRunId,
  type ExecuteRequest,
  type ExecuteResponse,
} from './types.js';
import {
  MCP_ACTION_NOTIFICATION_METHOD,
  MCP_ACTION_STATUS_TOOL_NAME,
  isMcpActionTerminal,
  projectMcpActionPublicState,
  type McpActionKind,
  type McpActionRecord,
} from './mcp-action-store.js';
import {
  MCP_RECIPE_CALLBACK_CAPABILITY,
  MCP_RECIPE_CALLBACK_NOTIFICATION_METHOD,
  createMcpRecipeCallbackWatcher,
  type McpRecipeCallbackNotificationParams,
  type McpRecipeCallbackPointer,
} from './mcp-recipe-callback.js';
import type { VaultStore } from '@recued/storage';
import type {
  ContractSnapshot,
  DependencyReadAdmission,
  EnrichmentReadRpcInput,
  ExecutionSource,
  IngredientManifest,
  InternalToolRegistry,
  RiskTier,
  TimelineRequest,
  ToolEntry,
  VectorSimilaritySearchRpcInput,
} from '@recued/contracts';
import {
  admitByOpRisk,
  cliPrincipalFromExecutionSource,
  derivePerOpDependencyReads,
  ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY,
  ENGAGEMENT_VENDOR_VALUES,
  isCliIngredient,
  isExternallyExposableIngredient,
  primitiveGrantEntry,
  readOwnerOperationOverride,
  resolveTrustCeiling,
  STDIO_MCP_TOKEN_ID,
  KERNEL_OP_REGISTRY,
  isGrantableKernelOp,
  kernelOpForMcpTool,
} from '@recued/contracts';
import {
  AUTHOR_DEFAULT_READ_GRANT_CHECKER,
  type ReadGrantChecker,
} from './read-grant-checker.js';
import type { WsServerHandle } from './ws-server.js';
import {
  handleTimelineRequest,
  type TimelineDeps,
  type LoadCollectionRecord,
} from './mcp/timeline.js';
import {
  handleRegistryDescribe,
  collectRegisteredProducerTopics,
  type RegistryDescribeDeps,
} from './mcp/registry-describe.js';
import { listHousekeepingTasks } from './housekeeping/registry.js';
import {
  handleEnrichmentRead,
  type EnrichmentReadDeps,
} from './mcp/enrichment-read.js';
import {
  handleVectorSimilaritySearch,
  type VectorSimilarityDeps,
} from './mcp/vector-similarity.js';
import { handleContactEngagementsList } from './mcp/contact-engagements.js';
import type { ContactEngagementsResolveDeps } from './contact-engagements-rpc-handler.js';
import {
  buildInternalToolMcpAdapter,
  formatMcpDispatchError,
  type McpInternalToolAdapter,
} from './mcp-internal-tools.js';
import type { HousekeepingStateStore } from './housekeeping/state-store.js';
import type { AnnotationStore } from './storage/annotation-store.js';
import type { ManifestRegistry } from './manifest-loader.js';
import type { RecipeStore } from './recipe-store.js';
import { readRootProjections } from './records/root-projection.js';
import {
  DIRECT_MCP_TOOL_CALL_BASE_RESERVATION_KEY,
  type CustomerSurfaceUsageAdmission,
  type CustomerSurfaceUsageInput,
  type CustomerSurfaceUsageSession,
} from './seller/customer-surface-usage.js';
import {
  D201_WEBHOOK_RUNTIME_UNAVAILABLE,
  hasNonEmptyWebhookDeclarations,
} from './webhook-declaration-gate.js';
import {
  assertRecordsNonOwnerRecipeExposure,
  recipeUsesInstalledRecordsOperation,
} from './records/non-owner-exposure.js';

// ────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 types
// ────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

// ────────────────────────────────────────────────────────────────
// MCP protocol constants
// ────────────────────────────────────────────────────────────────

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'recued';
const SERVER_VERSION = '0.1.0';

/** Prefix every dynamically-generated per-ingredient tool with this. Keeps
 *  them visually grouped in MCP clients and prevents collision with the
 *  meta tools (`recued_listRecipes` etc.) or arbitrary recipe ids. */
const INGREDIENT_TOOL_PREFIX = 'recued_ingredient_';
/** D-182 §8 step 7 — wire prefix for a raw catalog op exposed on a door
 *  (`recued_op_<publisher>.<pack>.<operation>`). Parallels
 *  `INGREDIENT_TOOL_PREFIX`; the dotted op id remainder is fine on the wire
 *  (registry Tier-1 names already carry dots; `parseOpId` handles multi-dot
 *  operations). Gate A keys on this full name. */
const CUSTOMER_STATUS_TOOL_NAME = 'recued_customerStatus';
const CUSTOMER_STATUS_OP_ID = 'core.customer.status';
/** ⛔⛔ D-228 slice 2 (2nd attempt) — THE HAND-LIST IS GONE AND SO IS THE
 *  DERIVATION. Kernel MCP exposure is now an AUTHORED per-ingredient field,
 *  `IngredientManifest.mcp_exposed`, read only for `author: 'recued'`.
 *
 *  This was `new Set(['data-file-read'])` — one element, and the entire
 *  visibility policy for 136 kernel ingredients, hidden in this file's private
 *  scope. The first attempt replaced it with `risk_tier === 'read'` and was
 *  REVERTED: that promoted a PRESENTATION HINT to an AUTHORIZATION INPUT, and a
 *  Codex review found four `read`-tier kernel manifests that are not safe reads
 *  (`http-watcher` SSRF; `webhook-watcher`, which DELETES a queue;
 *  `time-relative-watcher`, scoped to `data.time` but scanning the caller's
 *  chosen collection; `connection-mcp-read`, the Tier-3 confused deputy).
 *
 *  ⛔⛔ AND RE-AUTHORING `risk_tier` WOULD NOT HAVE SAVED IT. `data-file-read` —
 *  the one kernel ingredient that MUST be exposed — carries exactly the same
 *  `(kind: 'storage', risk_tier: 'read')` pair as `webhook-watcher`,
 *  `time-relative-watcher`, `file-watcher` and `recipe-watcher`. No authored
 *  field separated them, because the judgement had never been written down. A
 *  derivation cannot recover a decision that was never recorded.
 *
 *  🔑 So it is recorded now, at the definition site. The original complaint is
 *  answered — the policy is no longer a const in one server file, it is on the
 *  manifest, visible in publish review — while the part the hand-list had RIGHT
 *  is kept: this is a judgement, made once per ingredient. And it fails closed in
 *  the direction that matters: a new kernel ingredient ships FENCED by omission,
 *  rather than exposed by a rule nobody re-examined.
 *
 *  ⚠ Only the KERNEL half of `isMcpExposedIngredient`. The KIND fence
 *  (`isExternallyExposableIngredient`) is untouched — see D-228 decision (3) and
 *  the open D-221 §3.3 question about business-role checks living in pack code. */
/** Direct MCP setup, status, and catalog affordances are explicitly free. */
const MCP_FREE_CUSTOMER_TOOL_NAMES: ReadonlySet<string> = new Set([
  MCP_ACTION_STATUS_TOOL_NAME,
  CUSTOMER_STATUS_TOOL_NAME,
  'recued_listRecipes',
  'recued_getRecipe',
  'recued_listIngredients',
  'recued_registryDescribe',
  'tools.search',
  'setup.status',
  'catalog.list',
]);

const isMcpExposedKernelIngredient = (manifest: IngredientManifest): boolean =>
  manifest.author !== 'recued' || manifest.mcp_exposed === true;

/** D-182 §8 fence — a manifest may surface as a `recued_ingredient_<slug>` MCP
 *  tool only when it is BOTH a non-kernel (or explicitly whitelisted) ingredient
 *  AND externally exposable. `cli` / `service` ingredients are local code-exec /
 *  external subprocess and are NEVER raw door tools (`isExternallyExposable
 *  Ingredient` = false): an external actor may *trigger a recipe* that uses one
 *  internally (Gateway-gated via the §7.2 reachability grant) but can never call
 *  it directly. Applied at every per-ingredient surface (tools/list + the grant
 *  catalog here; the tools/call routing has its own dispatch-time backstop). */
const isMcpExposedIngredient = (manifest: IngredientManifest): boolean =>
  isMcpExposedKernelIngredient(manifest) && isExternallyExposableIngredient(manifest);

const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** D-137 Trio #D — stdio MCP transport runs single-user without a
 *  bearer-token concept, but the `InternalToolRegistry`'s channel-
 *  isolation invariant requires every `mcp_wire` dispatch to carry a
 *  non-empty `mcp_token_id`. The stable synthetic value below satisfies
 *  the invariant for the stdio transport (Claude Desktop / local MCP
 *  clients).
 *
 *  Future HTTP / WS MCP transports derive `mcp_token_id` from the bearer
 *  token at the request boundary and override this default via the
 *  `mcpTokenId` slot on `McpDeps`. D-187 slice 4 — moved to `@recued/contracts`
 *  (imported above) so `resolveTrustCeiling` keys the owner-vs-delegated-door trust
 *  split on this sentinel; re-exported below for existing importers. */

/** D-153 P2.C — fallback `agent_id` for stdio MCP transport. Single-
 *  user; no real agent identity at the protocol layer. Future HTTP /
 *  WS transports replace this via `McpDeps.agentId`. */
const STDIO_MCP_AGENT_ID = 'stdio_local';

/** D-153 P2.C — build the channel-shaped `ExecutionSource` for an
 *  MCP tool dispatch. Single-user stdio transport synthesises the
 *  agent id + tool call id; HTTP / WS transports will inject real
 *  values from the request boundary.
 *
 *  `contract_id` is the synthetic 1-contract-per-token mapping today
 *  (each MCP token == one contract scope). The full contracts
 *  substrate (open question #21) replaces this with a proper contract
 *  registry; the field stays the same shape. */
/** D-234 § 234.4 — the owner's own name for the peer holding this contract, so a
 *  question card is never unattributed. Falls back to the raw contract id. */
const peerConnectionNameFor = (
  deps: { connectionStore?: unknown },
  contract_id: string,
): string | undefined => {
  const store = deps.connectionStore as
    | { list(f: { kind: string }): { name: string; config_json?: string | null }[] }
    | undefined;
  if (store === undefined || contract_id === '') return undefined;
  for (const row of store.list({ kind: 'mcp' })) {
    try {
      const cfg = JSON.parse(row.config_json ?? '{}') as Record<string, unknown>;
      if (cfg.peer_contract_id === contract_id) return row.name;
    } catch { /* a malformed row names nobody */ }
  }
  return undefined;
};

const buildMcpExecutionSource = (deps: McpDeps): ExecutionSource => {
  const mcp_token_id = deps.mcpTokenId ?? STDIO_MCP_TOKEN_ID;
  // D-166 P2 token↔contract binding — when the inbound token names a minted
  // contract (`McpInboundTokenRecord.contract_id`, resolved onto `boundContractId`
  // by the HTTP transport), the dispatch carries THAT contract_id so the active
  // contract governs the call live: its `contract_grant` rows gate access + the
  // collection read-fence, and a revoked/expired/exhausted contract denies via the
  // snapshot kill-switch in `buildMcpContractSnapshot`. Carried even when the bound
  // contract is dead, so the audit row records which contract the dispatch was bound
  // to. Unbound (stdio owner / canonical CLI bearer with no `contract_id`) ⇒ the
  // synthetic 1-contract-per-token id, governed by no contract (the owner reads all).
  const contract_id = deps.boundContractId ?? mcp_token_id;
  return {
    channel: 'mcp',
    actor: 'contracted_user',
    agent_id: deps.agentId && deps.agentId.length > 0 ? deps.agentId : STDIO_MCP_AGENT_ID,
    tool_call_id: `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    mcp_token_id,
    contract_id,
  };
};

/** Frozen shared empty `scope_restrictions` — the admit-all baseline
 *  (`evaluateScopeAdmissibility`: empty list fences nothing). */
const EMPTY_SCOPE_RESTRICTIONS: ReadonlyArray<string> = Object.freeze([]);

/** D-177 read-gate / D-187 slice 5 — resolve the door's effective
 *  `scope_restrictions` for THIS dispatch, DERIVED from the bound contract's
 *  `data.<collection>` grant rows. The SINGLE source of truth shared by two
 *  consumers so they can never diverge: {@link buildMcpContractSnapshot} (feeding
 *  the execute-path ingredient scope gate) and the timeline meta-tool's read fence
 *  (the read-grant checker's `isCollectionReadGranted`) — both read the SAME collection
 *  grant rows (the door scope below comes from the same read-grant checker the timeline
 *  fence reads).
 *
 *  Reads the bound door's collection grants via `contractOverlay.resolveContractScopeRestrictions`
 *  (slice 5 re-homed the per-door fence off the retired `policy_matrix` overlay cell onto
 *  the unified `contract_grant` store). Deliberately decoupled from
 *  `deps.executorConfig` — that feeds only `allowed_tools`, and the native read tools
 *  (timeline) are reachable by partial-deps probe paths that carry NO `executorConfig`;
 *  `buildMcpExecutionSource` + the grant read use only the token / bound-contract fields
 *  + the grant store, so the read fence runs on those paths without a crash.
 *
 *  Admit-all (`[]`) whenever no overlay is wired (stdio / unbound — the owner reads all),
 *  the bound contract is absent/inactive, or it grants every readable collection. The
 *  `#contracts` Entities tab authors per-door collection grants via `contract.grant.write`,
 *  and the D-171 HTTP transport binds `recued_*` door bearers to their contract
 *  (`boundContractId`). Stdio + canonical CLI bearers remain the OWNER (unbound ⇒
 *  admit-all, correct). */
const resolveMcpDoorScopeRestrictions = (deps: McpDeps): ReadonlyArray<string> =>
  deps.contractOverlay?.resolveContractScopeRestrictions?.(buildMcpExecutionSource(deps))
  ?? EMPTY_SCOPE_RESTRICTIONS;

/** D-187 AMENDMENT — resolve the door's per-dispatch READ-GRANT checker (topic +
 *  raw-collection reads as unified `contract_grant` entries) for THIS dispatch, off the
 *  bound contract through the overlay. Replaces the retired
 *  `resolveMcpDoorVisibilityOverrides` (the `toggle ?? authorDefault` visibility map):
 *  the native read tools query {@link ReadGrantChecker.isTopicReadGranted} /
 *  `isCollectionReadGranted` instead of AND-ing `isTopicMcpPrivate` + the scope-fence.
 *
 *  Author-default-only (every entry at its registry author default — the scope-fence ∧
 *  the `mcp_exposed` hint) whenever no overlay is wired, the bound contract is absent /
 *  inactive, or it holds no grant rows — incl. the owner's unbound stdio / canonical-CLI
 *  path (synthetic token id, no `contract_definition` row), which reads author defaults
 *  exactly as the pre-D-187 empty `mcp_topic_visibility` table did. */
const resolveMcpDoorReadGrantChecker = (deps: McpDeps): ReadGrantChecker =>
  deps.contractOverlay?.resolveReadGrantChecker?.(buildMcpExecutionSource(deps))
  ?? AUTHOR_DEFAULT_READ_GRANT_CHECKER;

/** D-234 § 234.4 — does this token's per-tool checklist admit `tool_name`?
 *
 *  ⛔⛔ EITHER NAME, BECAUSE THE MINT AND THE GATE SPOKE DIFFERENT LANGUAGES.
 *  `chat.inbound_token.issue` validates every grant key through
 *  `preflightExternalToolGrant`, which ACCEPTS a registered kernel op id and
 *  REFUSES a static `recued_*` tool name (it is in no internal-registry tier).
 *  The checklist then looked up the TOOL name and found nothing. So for a native
 *  verb-op fronted by a static tool, the only name the owner could grant was the
 *  one name never read — a grant that granted nothing, failing closed in silence
 *  with a refusal that reads as "your token is wrong" rather than "this cannot
 *  be granted at all". `kernelOpForMcpTool` is the join.
 *
 *  ⚠ STRICTLY ADDITIVE — it widens what SATISFIES the checklist, never what the
 *  checklist protects. A token granted the literal tool name passes exactly as
 *  before; a tool fronting no native op resolves `undefined` and the second term
 *  never fires. Absent callback still denies (D-228 slice 6): no checklist,
 *  nothing.
 *
 *  ⚠ AND IT IS NOT THE ONLY GATE ON THE DOOR IT OPENS. `recued_peerAsk` still
 *  passes `isVerbOpGranted('core.peer.receive-ask')` (the CONTRACT overlay, a
 *  different axis) and then the receiver's default-closed per-(peer, label)
 *  exposure check. This one answers "may this token call this tool at all". */
const isCheckedListGranted = (deps: McpDeps, tool_name: string): boolean => {
  const gate = deps.inboundTokenAuthorize;
  if (gate === undefined) return false;
  if (gate(tool_name)) return true;
  const opId = kernelOpForMcpTool(tool_name);
  return opId !== undefined && gate(opId);
};

/** D-182 §8 door-cli authorization path — the cli ingredient slugs THIS door's
 *  principal may reach internally (a recipe it triggers shells out to the
 *  binary), to UNION into {@link buildMcpContractSnapshot}'s `allowed_tools`.
 *
 *  A `cli` ingredient is §8-fenced from raw door exposure, so it is ungrantable
 *  as a `recued_ingredient_<slug>` tool and never enters a door's per-token
 *  grants → never lands in `allowed_tools`. The policy gate would then deny a
 *  door-triggered recipe's cli step `tool_not_in_contract` BEFORE the catalog-
 *  gateway's per-risk-tier reachability resolver ever runs. This re-admits a cli
 *  slug to the allowlist IFF the door's principal has a §7.2 reachability grant
 *  for it (any risk tier). It is a COARSE slug-level admit: it only gets the step
 *  TO the gateway resolver, which then enforces the EXACT op risk tier (stricter
 *  — a grant for `read` here can never let a `destructive` op past the resolver).
 *  The raw `recued_ingredient_<cli>` call stays refused by the unconditional
 *  dispatch backstop, so this never re-opens §8.
 *
 *  Principal = `cliPrincipalFromExecutionSource(source)` — the SAME mapping the
 *  catalog-gateway resolver uses, so the snapshot admit and the gateway verdict
 *  key on one principal (a door's `contract_id`). A `null` principal (no definite
 *  principal) ⇒ no admit. Fails CLOSED (no admit) on a throwing lister so a
 *  transient store error never widens the allowlist. Returns only granted slugs
 *  that the loaded manifest registry knows AND that are genuine cli ingredients.
 *
 *  The cli-kind guard (`isCliIngredient`) is load-bearing (Codex F4-HIGH fold):
 *  the `cli.reachability.set` rpc does NOT verify the row's `ingredient_id` is a
 *  cli ingredient, so a (owner-authored) stray row for a non-cli slug — notably a
 *  `service`, which has NO §7.2 reachability auth path and must stay fully fenced
 *  — would otherwise leak into `allowed_tools`. The catalog-gateway is already
 *  safe (it consults reachability only for `isCliInvocationOp` ops); this guard
 *  closes the same hole on the snapshot-admit side so the two stay in lockstep. */
const cliReachableSlugsForSnapshot = (
  source: ExecutionSource,
  deps: McpDeps,
  allSlugs: readonly string[],
): readonly string[] => {
  if (!deps.cliReachableSlugsForPrincipal) return [];
  const principal = cliPrincipalFromExecutionSource(source);
  if (principal === null) return [];
  let granted: ReadonlyArray<string>;
  try {
    granted = deps.cliReachableSlugsForPrincipal(principal);
  } catch {
    return [];
  }
  if (granted.length === 0) return [];
  const present = new Set(allSlugs);
  return granted.filter(
    (slug) =>
      present.has(slug) && isCliIngredient(deps.executorConfig.manifests.get(slug)),
  );
};

/** D-153 P2.C — resolve the per-token `ContractSnapshot` at dispatch
 *  time (spec line 443: "The Gateway populates this at dispatch time
 *  by reading the contract's current state"). The full contracts
 *  substrate is deferred per open question #21; this stub derives
 *  `allowed_tools` from the manifest registry + the existing inbound-
 *  token grants gate. Two cases:
 *
 *  - Stdio transport (single-user owner, no `inboundTokenAuthorize`):
 *    snapshot admits every loaded manifest slug. Matches the pre-
 *    P2.C semantics of "owner has full server-wide access".
 *  - HTTP / WS transports with `inboundTokenAuthorize`: snapshot
 *    admits only slugs the per-token checklist authorises (Settings
 *    → MCP Tokens). Mirrors the substrate-level inbound-token
 *    `isMcpInboundTokenToolAuthorized` predicate — no enforcement
 *    drift between the layered checks. The per-tool gate keys on WIRE
 *    names while `allowed_tools` keys on raw ingredient slugs, so a
 *    `recued_ingredient_<slug>` grant is aliased to its raw slug here
 *    (see the filter below) — otherwise granting a direct-ingredient
 *    tool would pass the wire gate but the run-ingredient recipe step
 *    would still be denied `tool_not_in_contract` at the policy gate.
 *
 *  The stub's `approval_required` array stays empty until the contracts
 *  substrate models it; `scope_restrictions` is resolved by the shared
 *  {@link resolveMcpDoorScopeRestrictions} seam (also a stub today).
 *  `resolved_at` is wall-clock ms (the snapshot is per-call). */
const buildMcpContractSnapshot = (
  source: ExecutionSource,
  deps: McpDeps,
): ContractSnapshot => {
  if (source.actor !== 'contracted_user' || source.channel !== 'mcp') {
    throw new Error(
      `D-153 P2.C buildMcpContractSnapshot: expected (channel: 'mcp', actor: 'contracted_user'); got (${source.channel}, ${source.actor}).`,
    );
  }
  const allSlugs = deps.executorConfig.manifests.slugs();
  const installedSlugs = new Set(allSlugs);
  // D-221 §3.3 — a Records catalog is deliberately absent from every raw
  // MCP tool/grant surface, so its slug can never enter `allowed_tools` through
  // the ordinary `recued_ingredient_*` alias below. A granted recipe remains a
  // legitimate receiving boundary, however. Admit the hidden catalog only when
  // this token can invoke the generic recipe umbrella or an exact Tier-2 recipe
  // whose immutable body uses an installed Records operation. Raw guessed calls
  // remain structurally fenced at list, grant, and dispatch.
  const tokenAdmitsRecordsRecipe = deps.inboundTokenAuthorize !== undefined
    && deps.recordsStore !== undefined
    && (
      deps.inboundTokenAuthorize('recued_runRecipe')
      || deps.inboundTokenAuthorize('recipe.run')
      || (deps.internalRegistry?.listByTier(2).some((entry) => {
        if (!deps.inboundTokenAuthorize!(entry.name)) return false;
        const separator = entry.name.indexOf('/');
        if (separator <= 0 || separator === entry.name.length - 1) return false;
        const recipe = deps.recipeStore.get(entry.name.slice(separator + 1));
        return recipe !== null && recipeUsesInstalledRecordsOperation(recipe, {
          isOperationId: (operationId) =>
            deps.recordsStore!.isInstalledOperationId(operationId),
          isCatalogOperation: (catalogSlug, operationKey) =>
            deps.recordsStore!.isInstalledCatalogOperation(catalogSlug, operationKey),
        });
      }) ?? false)
    );
  const recordsRecipeSlugs = tokenAdmitsRecordsRecipe
    ? allSlugs.filter((slug) =>
        deps.executorConfig.manifests.get(slug)?.surfaces?.records !== undefined)
    : [];
  // D-166 P2 token↔contract binding kill-switch — a token bound to a minted
  // contract that is no longer live (revoked / expired / exhausted / deleted)
  // authorizes NOTHING: the snapshot allowlist collapses to empty so every tool
  // dispatch is denied (`tool_not_in_contract`), regardless of the token's own
  // per-tool grants. This is what makes revoking the bound contract a live
  // kill-switch over a running agent. `boundContractActive !== true` is
  // fail-closed: a bound token whose liveness couldn't be resolved also denies.
  // A live bound token / an unbound token keeps the per-token grant gate.
  // D-171 slice-2c follow-on #1 — `allowed_tools` keys on raw ingredient slugs
  // (the policy gate resolves each step's `tool.slug`), but the per-token gate +
  // `grants` key on WIRE names. A direct-ingredient tool is granted under its
  // wire name `recued_ingredient_<slug>`, so admit the raw `<slug>` when EITHER
  // the raw slug OR its `recued_ingredient_<slug>` wire name is authorized —
  // else a granted direct-ingredient call (and a `recued_runRecipe` recipe step
  // using it) would pass the wire gate but die `tool_not_in_contract` at the
  // engine policy gate. Additive: a slug is admitted only when the user
  // explicitly granted its ingredient tool — no incorrect widening.
  const allowed_tools =
    deps.boundContractId !== undefined && deps.boundContractActive !== true
      ? []
      : deps.inboundTokenAuthorize
        ? Array.from(
            new Set([
              ...allSlugs.filter(
                (slug) =>
                  deps.inboundTokenAuthorize!(slug)
                  || deps.inboundTokenAuthorize!(`${INGREDIENT_TOOL_PREFIX}${slug}`),
              ),
              // D-182 §8 door-cli authorization path — also admit the cli
              // ingredient slugs this door's principal has a §7.2 reachability
              // grant for. cli is §8-ungrantable as a raw tool, so it is never in
              // the per-token grants above; a recipe a door TRIGGERS authorizes
              // its cli step via the per-contract reachability allowlist, not a
              // tool grant. This coarse slug-level admit only clears the
              // `tool_not_in_contract` policy gate — the catalog-gateway resolver
              // still enforces the exact op risk tier, and the raw direct call
              // stays §8-fenced (dispatch backstop). The dead-contract kill-switch
              // (`[]` above) is reached first, so a revoked door admits nothing.
              ...cliReachableSlugsForSnapshot(source, deps, allSlugs),
              // D-232 § 20.20 — the backing slugs of KERNEL OPS this token was
              // explicitly granted. Without this the grant is inert: an owner
              // could name `core.data.calendar.list` and the policy gate would
              // still deny the step, because it looks for the ingredient SLUG
              // and a grant names the OP. Same coarse slug-level admit as the
              // cli union above — it only clears `tool_not_in_contract`; the
              // gateway resolver still enforces the exact op risk tier, so a
              // granted `read` can never carry a `destructive` past it.
              //
              // ⛔ DRIVEN BY THE TOKEN'S EXPLICIT GRANTS, never by author
              // defaults. Kernel `core.*` is documented as "the standard toolset
              // (default-available)", so resolving author defaults here would
              // admit 116 slugs — 53 of them reads, including `email-list` and
              // `mail-get` — for every door that ever connects. `inbound-
              // TokenAuthorize` answers only what the owner actually chose at
              // mint time, which is the whole difference between a grant surface
              // and an open door.
              //
              // ⚠ BOUNDED BY `allSlugs`, like every sibling here. The registry is
              // a STATIC list of 122 ops; iterating it unbounded consults the
              // token authorizer once per op even on a server that has none of
              // those ingredients loaded — which broke the seller-customer
              // invariant that a bound-contract door is gated by its CONTRACT and
              // "not the token checklist" (a test asserts the authorizer is never
              // called there, and it was, 102 times). Admitting a slug for an
              // ingredient this server does not have is meaningless anyway.
              ...KERNEL_OP_REGISTRY.filter((entry) =>
                entry.backing_slug !== undefined
                && installedSlugs.has(entry.backing_slug)
                && isGrantableKernelOp(entry.op)
                && deps.inboundTokenAuthorize!(entry.op),
              ).map((entry) => entry.backing_slug!),
              // ── D-232 § 20.19 — THE GRANTED RECIPE'S OWN NAME ──
              // Without this entry the § 20.19 rule is INERT: the policy gate
              // asks "was this recipe granted", `allowed_tools` held ingredient
              // slugs only, and the answer was structurally always no. Exact
              // Tier-2 grants only — a door holding the GENERIC `recued_runRecipe`
              // umbrella can run recipes, but naming no recipe it grants none,
              // and each step of what it runs stays gated as before.
              //
              // ⚠ SAFE ONLY BECAUSE THE VOCABULARIES ARE DISJOINT: these are
              // `<publisher>/<recipe_id>` wire names and an ingredient slug never
              // contains `/`, so neither can be mistaken for the other by the
              // `admitContractToolAccess` equality or the § 20.19 suffix match.
              // `recipeStepsCoveredByGrant` carries the same warning.
              ...(deps.internalRegistry?.listByTier(2) ?? [])
                .filter((entry) => {
                  const slash = entry.name.indexOf('/');
                  return slash > 0
                    && slash !== entry.name.length - 1
                    && deps.inboundTokenAuthorize!(entry.name);
                })
                .map((entry) => entry.name),
              ...recordsRecipeSlugs,
            ]),
          )
        // ⛔⛔ D-228 slice 1 — NO AUTHORIZER MEANS NO CATALOG, never `allSlugs`.
        //
        // This branch used to hand back every slug clearing the two hardcoded
        // fences, unfiltered. Only `wire-mcp-http-transport` supplies an
        // authorizer, so the branch belonged to `cli-context/mcp.ts` — the
        // stdio / local-client server — and `buildMcpExecutionSource`'s own
        // comment described the result as *"governed by no contract (the owner
        // reads all)"*.
        //
        // 🔑 PROXIMITY IS NOT IDENTITY. Claude Desktop is a third-party
        // application, and so is any local process that can reach a stdio
        // server. A surface does not become the owner by running on the owner's
        // machine, so it derives its catalog from the contract its caller
        // carries like every other surface (D-225: *the door answers whether*)
        // — and a caller carrying nothing gets nothing.
        //
        // ⚠ RECOVERABLE BY DESIGN: `recued mcp --token <bearer>` (or
        // `RECUED_MCP_TOKEN`) resolves an inbound token and supplies the
        // authorizer, so this is a configuration step rather than a dead end.
        // The CLI logs that instruction to stderr when it starts without one.
        : [];
  return buildVersionedContractSnapshot({
    contract_id: source.contract_id,
    allowed_tools,
    approval_required: [],
    scope_restrictions: resolveMcpDoorScopeRestrictions(deps),
    resolved_at: Date.now(),
  });
};

/** D-171 slice-2c follow-on #1 — record ONE contract use for an inbound MCP
 *  tool call that does NOT flow through `handleExecute` (the static `recued_*`
 *  read tools + `recued_saveRecipe`). The execute-backed paths (registry
 *  dispatch, `recued_ingredient_*`, `recued_runRecipe`) already `recordUse` per
 *  ingredient dispatch inside `handleExecute`, so the caller MUST exclude them
 *  to avoid double-counting (they also return before the static switch). Without
 *  this, a bound usage cap (`max_uses`, D-171 slice 3b) would never decrement
 *  for the direct-return native tools the follow-on newly made grantable — a cap
 *  bypass for sensitive reads + the recipe-store write.
 *
 *  No-op for an unbound token (the synthetic per-token `contract_id` names no
 *  `contract_definition`, so `shouldMeterUse` is false) or when no overlay is wired
 *  (for example a db-less harness). Mirrors `handleExecute`'s recordUse condition
 *  (`shouldMeterUse(...)` → `recordUse`) so the two layers count consistently;
 *  out-of-scope likewise falls back to the per-token grant gate, matching the
 *  execute path (which also does NOT fail-closed on out-of-scope — metering only
 *  fires in-scope).
 *
 *  Enforcement boundary: this meters the cap and — together with gate A's
 *  `boundContractDead` short-circuit — honors the grant / usage-cap / expiry /
 *  revoke limits the D-171 mcp door expresses. The op-risk × stage-trust APPROVAL
 *  decision (per-tool) is applied separately by {@link admitMcpDirectDispatch},
 *  called BEFORE this at the dispatch site — so recordUse only fires for an admitted
 *  direct-return call (a denied / approval-required tool refuses before metering). */
const recordMcpDirectDispatchUse = (deps: McpDeps, toolName: string): void => {
  const overlay = deps.contractOverlay;
  if (!overlay) return;
  const source = buildMcpExecutionSource(deps);
  // Grant-foundation slice 2a — no op id threaded: a direct-return NATIVE MCP
  // tool (`recued_*`) is not a catalog op and carries no `operations`-map key,
  // so an op-scoped standing contract fails closed here (`shouldMeterUse` false →
  // the per-token grant gate decides), exactly as before this slice. Mirrors the
  // omission in `admitMcpDirectDispatch` so admit + recordUse stay consistent.
  if (overlay.shouldMeterUse(source, toolName)) {
    overlay.recordUse(source);
  }
};

// ────────────────────────────────────────────────────────────────
// Kernel recipe — inline copy of community/recipes/run-ingredient.json
// ────────────────────────────────────────────────────────────────

// Extracted to `run-ingredient-recipe.ts` (D-177 P2b) so the chat
// Tier-3 dispatch routes through the same kernel recipe; the import
// lives in the header block, and `_testing.RUN_INGREDIENT_RECIPE`
// below keeps the community-JSON sync test's pin working.

// ────────────────────────────────────────────────────────────────
// Dynamic tool generation — one MCP tool per installed ingredient
// ────────────────────────────────────────────────────────────────

/** Heuristic: infer a minimal JSON Schema from a manifest's `input` map.
 *
 *  Rules:
 *  - `null` default → required; type inferred from the key name where we
 *    can (array-looking keys become `array`), else string.
 *  - Non-null default → optional; type inferred from the JS type of the
 *    default value (array/object/number/boolean/string).
 *
 *  This schema is advisory — the ingredient adapter validates at runtime.
 *  Goal is "agent sees useful hints in the tool catalog", not complete
 *  correctness. Agents that need strict validation should call
 *  `recued_getRecipe` / `recued_listIngredients` for the raw manifest. */
const inferInputSchema = (manifest: IngredientManifest): {
  type: 'object';
  properties: Record<string, { type: string; description?: string; items?: unknown }>;
  required: string[];
  additionalProperties: boolean;
} => {
  const properties: Record<string, { type: string; description?: string; items?: unknown }> = {};
  const required: string[] = [];
  for (const [key, defaultValue] of Object.entries(manifest.input ?? {})) {
    if (PROTOTYPE_SENSITIVE_KEYS.has(key)) continue;
    let prop: { type: string; description?: string; items?: unknown };
    if (Array.isArray(defaultValue)) {
      prop = { type: 'array', items: { type: 'string' } };
    } else if (defaultValue !== null && typeof defaultValue === 'object') {
      prop = { type: 'object' };
    } else if (typeof defaultValue === 'number') {
      prop = { type: 'number' };
    } else if (typeof defaultValue === 'boolean') {
      prop = { type: 'boolean' };
    } else if (defaultValue === null && /(?:_|\.)(fields|categories|list|dimensions|criteria|tags)$/.test(key)) {
      // Common array-shaped ingredient inputs: fields, categories, criteria,
      // dimensions, tags, list. Trigger on both underscore- and dot-
      // separated conventions (`pii_fields`, `llm.categories`).
      prop = { type: 'array', items: { type: 'string' } };
    } else {
      prop = { type: 'string' };
    }
    properties[key] = prop;
    if (defaultValue === null) required.push(key);
  }
  return { type: 'object', properties, required, additionalProperties: true };
};

/** Test-only exports. Not part of the public API. */
export const _testing = {
  /** Build the extension-first route map. Test harnesses use this to
   *  assert catalog-merge semantics without spinning up full JSON-RPC. */
  buildRouteMap: (deps: McpDeps) => buildRouteMap(deps),
  /** D-228 slice 2 — the kernel exposure predicate, so a test can pin that the
   *  outcome is DERIVED from `risk_tier` rather than remembered in a list. */
  isMcpExposedKernelIngredient,
  /** Invoke a tool by name. Used by end-to-end tests of the per-ingredient
   *  dispatch paths (server-route via handleExecute vs extension-route via
   *  wsServer.runKernelRecipeOnExtension). */
  handleToolCall: (
    params: { name: string; arguments?: Record<string, unknown> },
    deps: McpDeps,
  ) => handleToolCall(params, deps),
  /** Static tool catalog. Tests assert advertised input-schema shape
   *  (e.g. that `recued_enrichmentRead` advertises `freshness_budget_ms`)
   *  without dispatching `tools/list` end-to-end. Getter so the closure
   *  resolves `TOOLS` after its declaration (the const is below this
   *  block in source order). */
  get STATIC_TOOLS() { return TOOLS; },
  /** D-137 Trio #D — `tools/list` projection. Tests assert the union
   *  catalog (legacy + per-ingredient + Tier 1/2/3) is exposed when an
   *  InternalToolRegistry is wired through `deps.internalRegistry`. */
  handleToolsList: (deps: McpDeps) => handleToolsList(deps),
  /** D-137 Trio #D — stdio synthetic token id. Exported so tests can
   *  assert `mcp_token_id` propagation through the registry dispatch
   *  context without recreating the constant. */
  STDIO_MCP_TOKEN_ID,
  /** D-153 P2.C — mcp execution source builder. Exported for tests to
   *  pin the channel-shaped source threaded into handleExecute. */
  buildMcpExecutionSource,
  /** D-153 P2.C — mcp contract snapshot builder. Exported for tests to
   *  pin allowed_tools / version / rate-limit snapshot shape. */
  buildMcpContractSnapshot,
  /** The run-ingredient kernel recipe inlined into the MCP server. Tests
   *  assert it matches community/recipes/run-ingredient.json. */
  RUN_INGREDIENT_RECIPE,
  /** D-196 R5 host-owned settlement classifier for request-local usage. */
  get isBillableMcpToolResult() { return isBillableMcpToolResult; },
  /** D-196 R5 closed free/setup/catalog/status tool-name set. */
  get MCP_FREE_CUSTOMER_TOOL_NAMES() { return MCP_FREE_CUSTOMER_TOOL_NAMES; },
};

/** Build the MCP tool definition for a single ingredient manifest. */
export const buildIngredientTool = (manifest: IngredientManifest) => ({
  name: `${INGREDIENT_TOOL_PREFIX}${manifest.slug}`,
  description:
    `[${manifest.category}/${manifest.risk_tier}] ${manifest.description}`
    + ` — Dispatched via the run-ingredient kernel recipe; audit + vault + approval flows apply normally.`,
  inputSchema: inferInputSchema(manifest),
});

// ────────────────────────────────────────────────────────────────
// Tool definitions (6 total)
// ────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'recued_listRecipes',
    description: 'List all recipes available on this Recued server. Recipes are either bundled with the server, pair-synced from a Recued extension, or saved here by an earlier MCP session.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'recued_getRecipe',
    description: 'Get full detail of a single recipe — metadata, variables, steps, required ingredients. Use this before runRecipe to inspect what the recipe needs.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'string', description: 'Recipe id to look up' },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: 'recued_listIngredients',
    description: 'List all ingredients available on this server (with their slug, category, and description). Use this to discover what you can reference when authoring an inline recipe for runRecipe or saveRecipe.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'recued_runRecipe',
    description: 'Execute a Recued recipe. Pass recipe_id for a stored recipe, or a full recipe object for inline execution. Optionally pass vault (API credentials), config (recipe variable overrides), and context (page/entity context).',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'string', description: 'Id of a stored recipe to run' },
        recipe: { type: 'object', description: 'Full inline recipe definition (alternative to recipe_id)' },
        vault: { type: 'object', description: 'Vault entries (API keys, tokens) for this execution' },
        config: { type: 'object', description: 'Recipe variable overrides' },
        context: { type: 'object', description: 'Context namespace values (entity_id, page_url, etc.)' },
      },
    },
  },
  {
    name: MCP_ACTION_STATUS_TOOL_NAME,
    description:
      'Query a token-bound async action returned by a Recued tool that paused for out-of-band owner approval. The same action_ref follows the entire original invocation across additional approval gates. Terminal responses include the deferred final result. Do not resend the original tool call while this reports awaiting_approval or running.',
    inputSchema: {
      type: 'object',
      properties: {
        action_ref: {
          type: 'string',
          maxLength: 128,
          description: 'Opaque action_ref returned by the original held tool call.',
        },
      },
      required: ['action_ref'],
      additionalProperties: false,
    },
    _meta: {
      'com.recued/async-action-query': true,
    },
  },
  {
    name: 'recued_peerAsk',
    // D-234 § 234.4 — the inbound door. ⚠ Model-facing copy: this is what a
    // PEER'S agent reads, so it must say plainly what it costs (a person's
    // attention) and what it cannot do (anything else).
    description: 'Put ONE question to this server\'s owner and get their answer back later. Raises a durable notification they can answer from any surface; runs nothing, reads nothing, changes nothing else. Refused unless this owner has already OFFERED to answer questions under the exact `label` you name — there is no way to ask for that offer through this tool. The answer is not returned here: it comes back on the conversation you name with `exchange_ref`.',
    inputSchema: {
      type: 'object',
      properties: {
        withdraw: {
          type: 'boolean',
          // ⚠ MODEL-FACING. Says plainly what it is and is not, because a model
          // that reads this as a recall will retry it, and one that reads it as
          // "cancel the answer" will send it after being answered.
          description: 'Set true, with exchange_ref and nothing else, to say a '
            + 'question you asked is no longer awaited so its owner is not asked '
            + 'to spend time on it. A courtesy, not a recall: an answer already '
            + 'given still stands, and you learn nothing about whether it was seen.',
        },
        exchange_ref: { type: 'string', description: 'The conversation this question belongs to' },
        label: { type: 'string', description: 'The capability the owner offered, matched exactly' },
        question: { type: 'string', description: 'The question, in words the owner will read' },
        options: {
          type: 'array',
          description: 'The answers they may choose from ({ id, label })',
          items: { type: 'object' },
        },
        deadline_at: { type: 'number', description: 'Unix ms you will stop waiting (optional)' },
        on_timeout: { type: 'string', description: 'stop | wait (optional)' },
        note_prompt: {
          type: 'string',
          description: 'optional | required — invite a written reason with the answer',
        },
        body: {
          type: 'string',
          description: 'The document the owner reads before deciding (optional). It is NOT put on the notification — it is readable only on their own signed-in surfaces.',
        },
      },
      required: ['exchange_ref', 'label', 'question', 'options'],
    },
  },
  {
    name: 'recued_peerAnswer',
    // D-234 § 234.4 — the return leg's door. ⚠ Model-facing: this is read by the
    // agent of a peer whose OWNER has answered, so it must say plainly that the
    // only thing it accepts is a reply to something this server already asked.
    description: 'Return this server\'s own question to it, answered. Accepted ONLY for a conversation this server opened with you (`exchange_ref`), only from the peer it addressed, and only carrying one of the options it offered — there is no way to start a conversation, choose an unoffered outcome, or answer on another peer\'s behalf through this tool. The asking run resumes when it lands.',
    inputSchema: {
      type: 'object',
      properties: {
        exchange_ref: { type: 'string', description: 'The conversation being answered' },
        answered: { type: 'boolean', description: 'false when the owner is not answering' },
        option: { type: 'string', description: 'The chosen option id — must be one that was offered' },
        note: { type: 'string', description: 'Free text the answerer added (optional)' },
        at: { type: 'number', description: 'Unix ms the answer was made (optional)' },
        unanswered_because: {
          type: 'string',
          description: 'timed_out | declined | not_exposed | withdrawn — only when answered is false',
        },
      },
      required: ['exchange_ref', 'answered'],
    },
  },
  {
    name: 'recued_getAudit',
    // ⚠ Model-facing — see internal design notes. The
    // `exchange_ref` sentence is what makes D-232's query reachable at all: a
    // sender holds a ref and no other tool turns one into an answer, so a
    // filter the model does not know about is a filter nobody uses.
    description: 'Get recent recipe execution audit entries from this server. Optionally filter by recipe_id, by exchange_ref (every run belonging to one peer exchange — the inbound call, the answer\'s own dispatch, and any approval hold in between: this is how you find out what happened to a message you sent a peer), or by peer_contract_id (everything with one peer). Entries include success, duration, token usage, and step outcomes.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'string', description: 'Filter by recipe (optional)' },
        exchange_ref: {
          type: 'string',
          description: 'Filter to one peer exchange, by the reference the exchange was accepted under (optional)',
        },
        peer_contract_id: {
          type: 'string',
          description: 'Filter to every run governed by one peer\'s contract (optional)',
        },
        limit: { type: 'number', description: 'Max entries (default 20)' },
      },
    },
  },
  {
    name: CUSTOMER_STATUS_TOOL_NAME,
    description: 'Return this seller customer token\'s own access status and usage allowances. This is self-scoped to the bound customer contract and never accepts a customer id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'recued_saveRecipe',
    description: 'Persist a recipe into the server\'s recipe store. Useful for MCP-authored recipes — you generate the recipe JSON, validate it via runRecipe, then save it here so the paired Recued extension can pick it up on its next pair-sync and offer the user a "Keep this recipe?" prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'object', description: 'Full recipe definition' },
        publisher_id: { type: 'string', description: 'Publisher id (default: "mcp")' },
      },
      required: ['recipe'],
    },
  },
  {
    name: 'recued_dataTimeline',
    description: 'Get a chronological feed for one entity, merging raw collection records, annotations (recipe-derived facts), typed cross-collection links, and memory entries (recipe runs that touched the entity). entity_id format is `<collection>:<id>` (e.g. `mail:msg-abc123`). Sorted newest-first; supports since/until window + cursor pagination. Use this to answer "what happened with this entity?" without juggling per-collection tools. For a contact, the response may also carry `rollups`: one standing summary per installed pack that declares onto that person (e.g. unbilled time, open jobs), computed live from the pack\'s own records. Rollups are NOT feed entries and carry no timestamp — they answer "where do things stand?" rather than "what happened?". Each carries `complete`; when it is false the pack\'s walk hit a bound and the numbers are a floor, not a total.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'Entity reference in `<collection>:<id>` format (e.g. `mail:msg-abc123`, `deal:hubspot-42`).',
        },
        since: { type: 'number', description: 'Optional epoch-ms lower bound (inclusive)' },
        until: { type: 'number', description: 'Optional epoch-ms upper bound (exclusive)' },
        limit: { type: 'number', description: 'Max entries (default 100, max 1000)' },
        cursor: { type: 'string', description: 'Opaque pagination token from the previous response\'s `next_cursor`' },
        origin_actors: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['user_self', 'contracted_user', 'system', 'anonymous'],
          },
          description: 'D-161 actor-lane filter (the row\'s write-actor). Omit for the full timeline (every lane). Pass a subset to narrow: ["contracted_user"] = the agents lane, ["anonymous"] = the reception lane, ["user_self","system"] = the default foreground. Outside-actor rows are filtered out of the page, never dropped — re-query the lane to reach them.',
        },
      },
      required: ['entity_id'],
    },
  },
  // ── D-136 §A.13 P7.D — MCP consumer surface ────────────────────
  {
    name: 'recued_registryDescribe',
    description: 'Introspect the warehouse enrichment registry. Returns one entry per topic with its temporal_class / identity_aggregation / lifecycle_policy / valid_scopes / compression_class / prompt_bias_hints + per-topic coverage stats (row_count, latest_event_at, producer_last_run_at, producer_failure_rate_24h). Call once at session-start so subsequent reads can plan against the warehouse shape. Read-cost-zero — never invokes LLMs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'recued_enrichmentRead',
    description: 'Read one enrichment row with the full bistemporal-metadata bundle (event_at / as_of / ingested_at / computed_at / source_record_hash / producer_version_hash / staleness_class + confidence / drift_severity / user_pinned when present). Three time-axis filters: `as_of` walks the supersede chain to find the row whose interval covers the timestamp, `coherent_at` requires `computed_at <= coherent_at`, `include_historical: true` returns the full chain. `include_stale` defaults true (stale + expired surface alongside fresh); set false to narrow to fresh-only. `freshness_budget_ms` opts into graceful degradation per §A.14.5: out-of-budget reads, missing rows, or private-topic reads return `result: null` with a `fall_through_hint { reason, staleness_axis?, suggested_raw_adapter, suggested_filter }` describing where to go raw instead. Read-cost-zero — never invokes LLMs.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Enrichment topic id (`company`, `purpose`, `embedding`, …).' },
        scope: { type: 'string', description: 'Per-record topic scope (`mail` / `contact` / `calendar` / `file` / four-segment `connection.api.<vendor>.<entity>`).' },
        target_id: { type: 'string', description: 'Per-record topic target id.' },
        derived_entity_id: { type: 'string', description: 'Derived-entity topic id (replaces scope/target_id for shape-B topics).' },
        authored_by: { type: 'string', description: 'Optional author narrowing for shape-A multi-author chains.' },
        as_of: { type: 'number', description: 'Point-in-time read — walk supersede chain to find the row whose [event_at, superseded_event_at) covers this epoch-ms timestamp.' },
        coherent_at: { type: 'number', description: 'Single-topic coherent read — returned row\'s computed_at <= coherent_at. Mutually exclusive with as_of + include_historical.' },
        include_historical: { type: 'boolean', description: 'Return the full supersede chain (DESC by effective time, head first).' },
        include_stale: { type: 'boolean', description: 'Default true (stale + expired surface). Set false to narrow to fresh-only.' },
        freshness_budget_ms: { type: 'number', description: 'Maximum acceptable staleness in ms. When set, out-of-budget / no-row / private-topic reads return `result: null` with a `fall_through_hint`. Substrate dispatches the staleness axis by `temporal_class` (stable_truth → computed_at; time_bound → as_of; aggregate_window → as_of OR window_drift when recompute_cadence exceeded).' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'recued_vectorSimilaritySearch',
    description: 'Cohort-enforced cosine similarity search over the warehouse vector index. Topics with `vector_index` sidecar (`embedding`, `semantic_cluster`). Pass `model_id` to constrain to a single embedding-model cohort (cross-model vectors aren\'t comparable); when omitted, defaults to the dominant cohort for the topic + scope_filter. Each result carries the full bistemporal-metadata bundle. Read-cost-zero — never invokes LLMs.',
    inputSchema: {
      type: 'object',
      properties: {
        query_vector: { type: 'array', items: { type: 'number' }, description: 'Query embedding vector (must match cohort dimensions).' },
        topic: { type: 'string', description: 'Vector-indexed topic (`embedding` or `semantic_cluster`).' },
        limit: { type: 'number', description: 'Max results (default 50, capped per server config).' },
        scope_filter: { type: 'string', description: 'Optional scope narrowing (e.g. `mail`).' },
        model_id: { type: 'string', description: 'Optional cohort enforcement — only return vectors from this embedding model.' },
        similarity_threshold: { type: 'number', description: 'Cosine similarity floor (default 0.5; range [-1, 1]).' },
      },
      required: ['query_vector', 'topic', 'limit'],
    },
  },
  // ── D-139 P5 — contact-rooted engagement evidence ──────────────
  {
    name: 'recued_contactEngagementsList',
    description: 'List CRM engagement evidence (emails, meetings, notes, calls, tasks) for one contact across HubSpot + Salesforce, identity-resolved (merged-contact aware) and deduped. `email` is required (any of the contact\'s addresses — merged losers route to the survivor). Defaults to the last 90 days of "real touch" evidence (completed + point-in-time); narrow with since/until (epoch-ms), vendor, connection_id, authorship/direction/lifecycle_state whitelists, or dedupe_acceptance. Sorted newest-first; cursor-paginated. Each row carries authorship/direction/dedupe_confidence/lifecycle_state + a `body_state` machine + a `coverage` bundle telling you which CRM sources were connected (so "no engagement" is distinguishable from "couldn\'t read the CRM"). Message BODY content is stripped by default (privacy gate); `body_truncation_offset` shows how many bytes exist unseen. Read-cost-zero — never invokes LLMs.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Contact email (canonical or a merged-away alias — routed to the survivor).' },
        since: { type: 'number', description: 'Optional epoch-ms event_at lower bound (default: now - 90d).' },
        until: { type: 'number', description: 'Optional epoch-ms event_at upper bound (default: now).' },
        vendor: { type: 'string', enum: [...ENGAGEMENT_VENDOR_VALUES], description: 'Optional vendor filter; omit for the cross-vendor union.' },
        connection_id: { type: 'string', description: 'Optional — scope to a single connection of the chosen vendor (e.g. one of two HubSpot portals).' },
        authorship: { type: 'array', items: { type: 'string' }, description: 'Optional authorship whitelist (e.g. ["user","crm_user"] excludes automation + system_process).' },
        direction: { type: 'array', items: { type: 'string' }, description: 'Optional direction whitelist (e.g. ["inbound","outbound"]).' },
        lifecycle_state: { type: 'array', items: { type: 'string' }, description: 'Optional lifecycle whitelist (default ["point_in_time","completed"]; set ["scheduled"] for upcoming-meeting briefs).' },
        dedupe_acceptance: { type: 'string', enum: ['exact_only', 'probable', 'all'], description: 'Default "exact_only" — probable-confidence twins surface as separate rows with dedupe_candidates rather than collapsing.' },
        page_size: { type: 'number', description: 'Default 50, max 200.' },
        cursor: { type: 'string', description: 'Opaque pagination token from the previous response\'s `next_cursor`.' },
        include_deleted: { type: 'boolean', description: 'Default false; tombstoned rows surface only when true.' },
      },
      required: ['email'],
    },
  },
];

// ────────────────────────────────────────────────────────────────
// D-171 slice-2c follow-on #1 — legacy grant-catalog projection
// ────────────────────────────────────────────────────────────────

/** Per-meta-tool read/write/unknown classification for the grant catalog.
 *  `recued_runRecipe` is `'unknown'` (it runs an arbitrary recipe — mirrors
 *  the Tier 1 `recipe.run` classification); `recued_saveRecipe` mutates the
 *  recipe store (`'write'`); the rest are read-only introspection. Keyed on
 *  the wire name so it stays in lockstep with `TOOLS`. */
const LEGACY_MCP_META_TOOL_CLASSIFICATION: Readonly<
  Record<string, 'read' | 'write' | 'unknown'>
> = {
  recued_listRecipes: 'read',
  recued_getRecipe: 'read',
  recued_listIngredients: 'read',
  recued_runRecipe: 'unknown',
  recued_getAudit: 'read',
  // D-234 § 234.4 — write: it spends the owner's attention and writes a durable
  // ask + ledger row. The real gate is EXPOSURE, checked inside the handler.
  recued_peerAsk: 'write',
  // D-234 § 234.4 return leg — write: it records an answer and RESUMES a
  // suspended run. The real gate is CORRELATION, checked inside the handler.
  recued_peerAnswer: 'write',
  [CUSTOMER_STATUS_TOOL_NAME]: 'read',
  recued_saveRecipe: 'write',
  recued_dataTimeline: 'read',
  recued_registryDescribe: 'read',
  recued_enrichmentRead: 'read',
  recued_vectorSimilaritySearch: 'read',
  recued_contactEngagementsList: 'read',
};

/** Map an ingredient's `risk_tier` onto the grant-row classification. The
 *  `risk_tier` is the authoritative risk signal on the manifest — `category`
 *  is NOT (`category: 'data'` ingredients can carry `risk_tier: 'write'` /
 *  `'admin'`, e.g. local conversion / service tools). Only `read` is read-
 *  only; `write` / `admin` / `destructive` all mutate or are privileged →
 *  surfaced as `'write'` so the grant badge + capability summary never
 *  under-state a direct ingredient call (Codex review P2). */

/** D-171 contract-broadcast follow-on — the `RiskTier` of a direct-return native
 *  `recued_*` tool, for the policy-overlay ceiling check. `recued_saveRecipe`
 *  mutates the recipe store (`'write'`); the rest are read-only introspection
 *  (`'read'`). Keyed off the same `LEGACY_MCP_META_TOOL_CLASSIFICATION` the grant
 *  badge uses so the two stay in lockstep. `recued_runRecipe` (`'unknown'`) never
 *  reaches here (it runs through `handleExecute`, which applies the overlay
 *  itself), but anything un-`read` maps to the stricter `'write'` for safety. */
const mcpNativeToolRiskTier = (toolName: string): RiskTier =>
  LEGACY_MCP_META_TOOL_CLASSIFICATION[toolName] === 'read' ? 'read' : 'write';

const isCustomerStatusGranted = (deps: McpDeps): boolean => {
  if (deps.boundContractId === undefined || deps.boundContractActive !== true) {
    return false;
  }
  const resolveReadGrantChecker = deps.contractOverlay?.resolveReadGrantChecker;
  if (!resolveReadGrantChecker) return false;
  return resolveReadGrantChecker(buildMcpExecutionSource(deps))
    .isVerbOpGranted(CUSTOMER_STATUS_OP_ID);
};

/** For an admitted D-196 customer only, raw pack ops are governed by the
 *  customer instance's self-contained contract grant list. `null` means this is
 *  not the customer-raw-op path and the ordinary inbound-token checklist keeps
 *  authority. Missing liveness/gate dependencies fail closed. */
const customerRawOpGrant = (deps: McpDeps, toolName: string): boolean | null => {
  if (deps.customerContractGrants !== true || !toolName.startsWith(OP_TOOL_PREFIX)) {
    return null;
  }
  if (deps.boundContractId === undefined || deps.boundContractActive !== true) {
    return false;
  }
  const opId = toolName.slice(OP_TOOL_PREFIX.length);
  if (opId.length === 0 || deps.opAdmissionGate === undefined) return false;
  return deps.opAdmissionGate.isOpGranted(buildMcpExecutionSource(deps), opId);
};

/** D-187 policy-matrix retirement (slice 4) — gate a direct-return native MCP tool
 *  (the `recued_*` reads + `recued_saveRecipe`) on its APPROVAL posture.
 *  Returns `{ ok: true }` to PROCEED or `{ ok: false, message }` to REFUSE.
 *
 *  Replaces the matrix `applyPolicyMatrixOverlay`-over-`overlay.resolve` decision with
 *  `admitByOpRisk` (op-risk × stage-trust): the native tool's `risk_tier`
 *  (`mcpNativeToolRiskTier` — reads `read`, `recued_saveRecipe` `write`) under the
 *  caller's trust ceiling. The per-token grant gate (gate A) already decided ACCESS
 *  upstream; this is the APPROVAL half.
 *
 *  The ceiling keys on `deps.boundContractId` — the HONEST "real contract" signal for
 *  mcp (the source always carries a `contract_id`, synthetic = the token id when
 *  unbound, so `executionSourceHasContract` can't tell the owner from a door):
 *    - UNBOUND (no `boundContractId`) — the owner's own stdio / canonical-CLI token →
 *      the contract-LESS owner ceiling `admin`: native reads + `recued_saveRecipe` admit
 *      (the owner saves recipes through their own local client; preserves the prior
 *      no-overlay PROCEED).
 *    - BOUND door (a real `boundContractId`) — a delegated AI → the contracted LOW
 *      default (`read`): native reads admit, but `recued_saveRecipe` (write) SURFACES —
 *      it `ask`s, which this synchronous direct-return path cannot approval-resume, so it
 *      REFUSES (the owner raises the door's trust or saves through an approval-capable
 *      surface). This is the "AI writes surface" posture for a door's direct MCP path.
 *
 *  - `admit` ⇒ PROCEED.  - `deny` ⇒ REFUSE (unreachable for a native tool; defensive).
 *  - `ask`  ⇒ REFUSE (a synchronous direct-return tools/call can't checkpoint + resume).
 *
 *  The outbound-send LIFT does NOT engage here — it is `user_self`-scoped and the MCP
 *  source is `contracted_user`; native tools are introspection + saveRecipe anyway. */
/** D-234 § 234.4 — the native tools that carry their OWN approval gate, and so
 *  must not also take {@link admitMcpDirectDispatch}'s.
 *
 *  ⛔⛔ `recued_peerAsk` IS UNREACHABLE BY ANY PEER WITHOUT THIS, PERMANENTLY.
 *  It is classified `write` (correctly — it spends the owner's attention and
 *  writes a durable ask), and `resolveTrustCeiling` gives every DELEGATED mcp
 *  token the contracted LOW ceiling, which no row may raise (the model-door pin).
 *  A `write` under a `read` ceiling is `ask`, and `ask` on a synchronous
 *  direct-return `tools/call` can only REFUSE — there is no approval-capable
 *  surface for an inbound tool call to resume onto. So the door refused every
 *  peer, always, with a message telling the CALLER to raise a trust setting on
 *  the RECEIVER's server. The live drive is what surfaced it: nothing had ever
 *  reached this gate, because delivery went through the held carrier instead.
 *
 *  🔑 AND THE APPROVAL IT WANTS WAS ALREADY GIVEN. § 234.4's admit-first ruling
 *  is exactly this argument: the owner grants `peer.label.<label>` on that peer's
 *  contract by hand, per (peer, label), default-closed — "the yes-in-principle
 *  was given in advance, deliberately, by the receiver".
 *  Asking again here would be prompting the owner to approve showing the owner a
 *  prompt: the tool's ENTIRE effect is to put a question in front of that same
 *  person. Same shape as the `(webhook, anonymous)` carve-out in
 *  `resolveTrustCeiling` — a two-sided enrollment IS the standing approval.
 *
 *  ⛔ WHAT STILL GATES IT, so this is a substitution and not a hole: the
 *  per-token checklist (`isCheckedListGranted`), the contract's verb-op grant
 *  (`isVerbOpGranted('core.peer.receive-ask')`), and then the receiver's
 *  default-closed per-(peer, label) LABEL GRANT inside the handler — which is
 *  NARROWER than the ceiling removed here, and is the gate § 234.4 designed for
 *  this door. The handler's own comment already claimed that check was the only
 *  gate; this makes that true instead of aspirational.
 *
 *  ⚠ It keeps its `write` CLASSIFICATION. The grant checklist still renders it as
 *  a write the owner is choosing to hand out, and the contract axis still gates
 *  it — only the synchronous-path approval verdict is bypassed. */
const isSelfGatedNativeMcpTool = (toolName: string): boolean =>
  toolName === PEER_RECEIVE_ASK_TOOL
  // D-234 § 234.4 return leg — the SAME argument as the ask door, on the other
  // evidence. `recued_peerAnswer` is `write` under a delegated token's LOW
  // ceiling, so `ask` is the verdict and a synchronous tools/call can only
  // REFUSE — the door would be unreachable by every peer, permanently. What
  // replaces the ceiling is stricter than it: we must have OPENED this exact
  // conversation, the caller must be the contract we addressed it to, and the
  // option must be one we offered. § 234.2 already ruled the principle — the
  // reply you asked for needs no prompt — and prompting here would ask the owner
  // to approve the arrival of an answer they are already waiting on.
  || toolName === PEER_RECEIVE_ANSWER_TOOL;

const admitMcpDirectDispatch = (
  deps: McpDeps,
  toolName: string,
): { ok: true } | { ok: false; message: string } => {
  const source = buildMcpExecutionSource(deps);
  const ownerOverride = readOwnerOperationOverride({
    scan: deps.contractScan,
    ingredient_id: toolName,
    operation_id: toolName,
  });
  const decision = admitByOpRisk({
    slug: toolName,
    risk_tier: mcpNativeToolRiskTier(toolName),
    // `resolveTrustCeiling` reads boundness off the source: a bound door (real
    // `contract_id` ≠ `mcp_token_id`) → contracted LOW (a native `write` like
    // `recued_saveRecipe` surfaces → refuses on this synchronous path); the unbound owner
    // (synthetic `contract_id === mcp_token_id`) → contract-less `admin` (full owner
    // trust). Same signal every other mcp path resolves, so they cannot drift.
    ceiling: resolveTrustCeiling(source),
    source,
    ...(ownerOverride !== undefined ? { owner_override: ownerOverride } : {}),
  });
  if (decision.verdict === 'deny') {
    return {
      ok: false,
      message: `Tool '${toolName}' is denied by the active door's policy: ${decision.detail}`,
    };
  }
  if (decision.verdict === 'ask') {
    return {
      ok: false,
      message:
        `Tool '${toolName}' requires preflight approval under the active door's trust and `
        + `cannot be approved on the direct MCP path — raise the door's trust or call it `
        + `through an approval-capable surface.`,
    };
  }
  return { ok: true };
};

/** D-171 slice-2c follow-on #1 — project the legacy inbound `tools/list`
 *  surface into `ToolEntry[]` so the Permissions → MCP door grant checklist
 *  can render + grant it.
 *
 *  The inbound wire advertises three groups (`handleToolsList`): the static
 *  `recued_*` meta tools, the dynamic `recued_ingredient_<slug>` per-ingredient
 *  tools, and the registry Tier 1/2 entries. The per-token gate
 *  (`inboundTokenAuthorize`) enforces ALL of them. Before this the grant
 *  checklist sourced only the registry surface, so the two legacy groups were
 *  advertised-but-un-grantable → permanently denied to door tokens. This
 *  projection adds the two legacy groups; the catalog provider concatenates it
 *  onto the registry entries (`wire-chat-orchestrator.ts`).
 *
 *  MUST mirror `handleToolsList`'s SERVER branch: same `TOOLS` set, same
 *  per-ingredient manifest walk, same kernel-author exposure predicate. Door
 *  tokens reach the HTTP transport whose `baseMcpDeps` carries no
 *  `wsServer`, so their wire surfaces ONLY server manifests (never the
 *  extension-reported ingredients `buildRouteMap` would merge for the stdio
 *  owner) — this projection matches that exactly. Keep the two in sync.
 *
 *  Synthetic-tier note: `ToolEntry.tier` is the registry taxonomy (`1 | 2 |
 *  3`); these legacy tools aren't registry entries. They're stamped `tier: 2`
 *  so `buildDefaultMcpInboundTokenGrants` defaults them OFF (the door is
 *  default-deny). The grant checklist groups them by NAME PREFIX (the
 *  `recued_native` / `recued_ingredient` buckets in
 *  `inferChatInboundTokenToolKind`), independent of this tier; the tier is
 *  never painted. */
/** D-182 §8 — a permissive arg schema for a raw catalog-op tool. Advertises the
 *  reserved `connection` arg (Model 1) + accepts the op's own args (opaque —
 *  the gateway validates them downstream). A future slice can enrich this from
 *  the op's `request_schema` when the catalog declares a clean object shape. */

/** D-182 §8 — the set of Tier-P op ids any installed recipe already covers. The
 *  recipe-preferred catalog filter uses it to suppress a raw WRITE op a recipe
 *  provides (the recipe is the guardrailed headline tool; the raw primitive would
 *  let the AI sidestep its preview/normalization/confidence gates).
 *
 *  A recipe covers a write via EITHER authored form, and BOTH are detected:
 *    - an `op:` step names the Tier-P / Tier-K op id directly (op-authored,
 *      post-D-182-step-4);
 *    - an `ingredient:` step (legacy / third-party / a lowered op-step persisted
 *      in that form) names a catalog slug + `input.operation`, which
 *      `packResolution` maps back to the op id `<publisher>.<pack>.<operation>` —
 *      the SAME id `buildRawOpToolDescriptors` checks, so the suppression matches.
 *  When `packResolution` is omitted (dbless / pre-wire harness, or no inventory)
 *  the walk is op-step-only: an `ingredient:`-covered write simply stays visible
 *  (the safe direction — over-exposure, never hiding a write; the owner can still
 *  narrow it). Pass the SAME `(scanInstalledPacks, getManifest)`-derived
 *  resolution the descriptor builder uses so the op ids align. Pure; never throws. */
export const buildRecipeOpCoverage = (
  recipeStore: Pick<RecipeStore, 'ids' | 'get'>,
  packResolution?: ReturnType<typeof buildPackOpResolution>,
): Set<string> => {
  const covered = new Set<string>();
  // Reverse the resolution (pack_ref → { catalog_slug, operations }) into
  // catalog_slug → [{ packRef, operations }] so an ingredient-step's catalog slug
  // maps to its covering op id(s). One entry per installed op-declaring pack; a
  // slug shared by >1 pack contributes each match (the descriptor builder emits
  // all of them too).
  const byCatalog = new Map<string, { packRef: string; operations: ReadonlySet<string> }[]>();
  if (packResolution) {
    for (const [packRef, binding] of packResolution) {
      const entry = { packRef, operations: binding.operations };
      const list = byCatalog.get(binding.catalog_slug);
      if (list) list.push(entry);
      else byCatalog.set(binding.catalog_slug, [entry]);
    }
  }
  for (const id of recipeStore.ids()) {
    const recipe = recipeStore.get(id);
    for (const step of recipe?.steps ?? []) {
      const s = step as { op?: unknown; ingredient?: unknown; input?: unknown };
      // op-step — names the op id directly.
      if (typeof s.op === 'string' && s.op.length > 0) {
        covered.add(s.op);
        continue;
      }
      // ingredient-step — `ingredient` is the catalog slug, `input.operation` the
      // op; map the pair back to the op id(s) it covers via the resolution.
      if (typeof s.ingredient === 'string' && s.ingredient.length > 0 && byCatalog.size > 0) {
        const input = s.input;
        const operation =
          input !== null && typeof input === 'object'
            ? (input as { operation?: unknown }).operation
            : undefined;
        if (typeof operation !== 'string' || operation.length === 0) continue;
        for (const { packRef, operations } of byCatalog.get(s.ingredient) ?? []) {
          if (operations.has(operation)) covered.add(`${packRef}.${operation}`);
        }
      }
    }
  }
  return covered;
};

/** D-182 §8 step 7 — enumerate the installed Tier-P pack ops a door MAY expose
 *  raw, as tool descriptors. Walks the installed-pack inventory via the SAME
 *  `buildPackOpResolution` the dispatch + recipe-lowering use, then applies the
 *  §8 filters:
 *    - **Kind** (hard): `isExternallyExposableIngredient` — cli/service catalogs
 *      are NEVER raw-exposable (their ops are skipped entirely).
 *    - **Risk**: READ ops are AI-open (per grant). WRITE ops (incl admin /
 *      destructive, which classify as `'write'`) are emitted too — grantable but
 *      DEFAULT-OFF (`buildDefaultMcpInboundTokenGrants`), so the owner opts in
 *      per op.
 *    - **Recipe-preferred (Inc B-writes)**: a WRITE op an installed recipe
 *      already covers is SUPPRESSED (`recipeOpCoverage`) — the recipe is the
 *      guardrailed path; suppressing the primitive keeps the AI on it AND the
 *      catalog small (helps weaker models). A default, not a lock — reads always
 *      coexist with read-recipes; an owner who wants the raw write grants it
 *      anyway (the door catalog gate is the actual control).
 *  The per-op risk tier is the OPERATION's (`OperationSpec.risk_tier`, Invariant
 *  1), never the wrapper manifest's static tier. Absent inventory ⇒ no raw ops.
 *  Absent `recipeOpCoverage` ⇒ no suppression (every write emitted). Pure;
 *  never throws. */

export const buildMcpGrantCatalogLegacyEntries = (
  manifests: Pick<ManifestRegistry, 'slugs' | 'get'>,
  /** D-182 §8 (Inc D) — the installed-pack inventory scan; when supplied, the
   *  catalog ALSO offers grantable raw catalog ops (`recued_op_<opid>`). Absent
   *  (dbless / pre-wire harness) ⇒ no raw ops (back-compatible). */
  scanInstalledPacks?: InstalledPackScan,
  /** D-182 §8 (Inc B-writes) — the recipe op-coverage set: a raw WRITE op a
   *  recipe already provides is suppressed. Absent ⇒ no suppression. */
  recipeOpCoverage?: ReadonlySet<string>,
): ToolEntry[] => {
  const entries: ToolEntry[] = [];
  // Static `recued_*` meta tools — verbatim name + description + arg schema
  // from `TOOLS` (the exact set `handleToolsList` emits).
  for (const tool of TOOLS) {
    // D-196 S2b — customer.status is governed by the customer's contract op
    // grant (`core.customer.status`), not by the inbound-token business-tool
    // catalog/checklist.
    if (tool.name === CUSTOMER_STATUS_TOOL_NAME) continue;
    entries.push({
      name: tool.name,
      tier: 2,
      description: tool.description,
      arg_schema: tool.inputSchema,
      topic_tags: [],
      classification: LEGACY_MCP_META_TOOL_CLASSIFICATION[tool.name] ?? 'unknown',
      concurrency_safe: false,
    });
  }
  // Dynamic `recued_ingredient_<slug>` tools — mirror `handleToolsList`'s
  // server branch: every loaded manifest that passes the kernel exposure
  // predicate.
  for (const slug of manifests.slugs()) {
    const manifest = manifests.get(slug);
    if (!manifest) continue;
    if (!isMcpExposedIngredient(manifest)) continue;
    const tool = buildIngredientTool(manifest);
    entries.push({
      name: tool.name,
      tier: 2,
      description: tool.description,
      arg_schema: tool.inputSchema,
      topic_tags: [],
      classification: ingredientRiskToGrantClassification(manifest.risk_tier),
      concurrency_safe: false,
    });
  }
  // D-182 §8 — raw catalog ops `recued_op_<opid>`, when the installed-pack
  // inventory is wired. Grantable here (reads default ON, writes default OFF via
  // `buildDefaultMcpInboundTokenGrants`); `tools/list` advertises the granted
  // ones, and the per-token gate enforces. The §8 KIND fence + recipe-preferred
  // write suppression are inside `buildRawOpToolDescriptors`.
  if (scanInstalledPacks) {
    // D-225 § 9.5.1 — the descriptor→entry mapping moved to
    // `rawOpToolEntries` so the CHAT catalog emits byte-identical rows. A raw op
    // describing itself differently to chat than to the door would be one op
    // wearing two faces, while the owner's single grant covers both.
    // (`also_reads` still discloses the container reads a raw write transitively
    // admits — D-192 Slice 7 — it just does so from the shared mapping now.)
    for (const entry of rawOpToolEntries(
      scanInstalledPacks,
      (s) => manifests.get(s),
      recipeOpCoverage,
    )) {
      entries.push(entry as ToolEntry);
    }
  }
  return entries;
};

// ────────────────────────────────────────────────────────────────
// MCP message handlers
// ────────────────────────────────────────────────────────────────

const handleInitialize = (deps: McpDeps): unknown => {
  const recipeCallbacksAvailable =
    deps.mcpRecipeCallbackNotifications === true
    && deps.sharedStore !== undefined
    && deps.mcpRecipeCallbackAuthorize !== undefined
    && deps.mcpTokenId !== undefined;
  const experimental = {
    ...(deps.mcpActionStore
      ? {
          'com.recued/async-actions': {
            version: 1,
            queryTool: MCP_ACTION_STATUS_TOOL_NAME,
            ...(deps.mcpActionNotifications === true
              ? { notificationMethod: MCP_ACTION_NOTIFICATION_METHOD }
              : {}),
            notificationsAreHints: true,
          },
        }
      : {}),
    ...(recipeCallbacksAvailable
      ? {
          [MCP_RECIPE_CALLBACK_CAPABILITY]: {
            version: 1,
            notificationMethod: MCP_RECIPE_CALLBACK_NOTIFICATION_METHOD,
            notificationsAreHints: true,
            delivery: 'at_least_once',
            callbackRefForDedupe: true,
          },
        }
      : {}),
  };
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: {},
      ...(Object.keys(experimental).length > 0 ? { experimental } : {}),
    },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
};

/** Per-call routing decision, also determines tool-description hint.
 *  Populated at `tools/list` time and consulted at `tools/call` time. */
interface IngredientRouteMap {
  routes: Map<string, 'extension' | 'server'>;
  extManifests: Map<string, IngredientManifest>;
}

const buildRouteMap = async (deps: McpDeps): Promise<IngredientRouteMap> => {
  const routes = new Map<string, 'extension' | 'server'>();
  const extManifests = new Map<string, IngredientManifest>();

  // Extension-first: if the paired extension is online and reports
  // installed ingredients, those take priority. Server ingredients only
  // fill gaps the extension doesn't cover.
  if (deps.wsServer) {
    try {
      const extList = await deps.wsServer.listExtensionIngredients();
      if (extList) {
        for (const { slug, manifest } of extList) {
          extManifests.set(slug, manifest as IngredientManifest);
          routes.set(slug, 'extension');
        }
      }
    } catch { /* offline or timed-out — fall through to server catalog */ }
  }

  for (const slug of deps.executorConfig.manifests.slugs()) {
    if (routes.has(slug)) continue; // extension already claimed this
    const m = deps.executorConfig.manifests.get(slug);
    if (!m) continue;
    routes.set(slug, 'server');
  }

  return { routes, extManifests };
};

const handleToolsList = async (deps: McpDeps): Promise<unknown> => {
  // D-187 token-lifecycle — bound-contract liveness kill-switch, the ENUMERATION
  // mirror of the `handleToolCall` dispatch guard. A token bound to a contract
  // that is no longer live (revoked / expired / exhausted) advertises an EMPTY
  // catalog: it can dispatch nothing, so it sees nothing — and the door's
  // configured tool names / descriptions / schemas don't leak to a defunct door.
  // Keyed on the same deps as the dispatch guard; fail-closed (`!== true` also
  // empties on an unresolved-liveness bound token). Unbound owner (stdio / CLI,
  // `boundContractId` undefined) is unaffected → full catalog. With this guard +
  // the dispatch guard owning liveness, the per-token `inboundTokenAuthorize`
  // callback means ONLY the token's checklist on both axes (the transport no
  // longer collapses it to `() => false` for a dead contract).
  if (deps.boundContractId !== undefined && deps.boundContractActive !== true) {
    // Revocation prevents every NEW business operation, but the authenticated
    // token must still be able to observe how an invocation accepted before
    // revocation settled (normally as a fresh-authority denial). This utility
    // is token-row-scoped and cannot dispatch or grant a capability.
    const actionStatus = TOOLS.find((tool) => tool.name === MCP_ACTION_STATUS_TOOL_NAME);
    return {
      tools:
        actionStatus !== undefined
        && deps.mcpActionStore !== undefined
        && deps.mcpPrincipalActive?.() === true
          ? [actionStatus]
          : [],
    };
  }
  const { routes, extManifests } = await buildRouteMap(deps);
  const ingredientTools: Array<ReturnType<typeof buildIngredientTool> & {
    description: string;
  }> = [];

  for (const [slug, target] of routes) {
    // Manifest source: extension's reported manifest wins when target is
    // extension (it might differ from the server's view of the same slug).
    const manifest = target === 'extension'
      ? extManifests.get(slug)!
      : deps.executorConfig.manifests.get(slug)!;
    // Kernel-authored ingredients are implementation detail, except
    // explicitly exposed storage surfaces like D-172 data-file-read. D-182 §8 —
    // cli/service catalogs are never raw door tools either (the combined fence).
    if (!isMcpExposedIngredient(manifest)) continue;
    const tool = buildIngredientTool(manifest);
    const prefix = target === 'extension'
      ? '[extension] '
      : '[server] ';
    ingredientTools.push({ ...tool, description: prefix + tool.description });
  }

  // D-137 Trio #D — append Tier 1 + Tier 2 entries from the
  // InternalToolRegistry when wired. Tier 1 names (`contact.search`,
  // `mail.search`, etc.) are dot-separated and never collide with the
  // legacy `recued_*` / `recued_ingredient_*` prefix space. Tier 2 names
  // are `<publisher>/<recipe_id>`; also collision-free with legacy.
  //
  // Codex P1 fold (Trio #D) — Tier 3 entries (`connection.mcp.*`
  // passthroughs) are filtered OUT of the MCP-wire catalog projection.
  // Tier 3 represents Mary's OUTBOUND MCP credentials (exa / GitHub /
  // peer Recued); surfacing them through Mary's own MCP server to an
  // EXTERNAL agent would let the external agent invoke peer/upstream
  // services under Mary's authorization envelope. The external agent
  // should call exa/GitHub/etc. directly under its own credentials.
  // Tier 3 stays available on the internal-channel chat-orchestrator
  // path (where Mary IS the authorization principal).
  const adapter = buildAdapterForDeps(deps);
  const registryTools = adapter
    ? adapter.listTools()
        .filter((t) => t._meta.tier !== 3)
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          _meta: t._meta,
        }))
    : [];

  // D-182 §8 step 7 — raw catalog ops `recued_op_<opid>` (reads + writes), when
  // the installed-pack inventory is wired. Same descriptor source as the grant
  // catalog (the §8 KIND fence + recipe-preferred write suppression live in the
  // helper). The per-token gate below enforces grants exactly as for the other
  // groups, so an ordinary door sees only its token-granted raw ops; an admitted
  // D-196 customer instead resolves them from its bound customer contract, and
  // the owner (no gate) sees them all. The recipe op-coverage set suppresses a
  // raw WRITE a recipe covers.
  let rawOpTools: { name: string; description: string; inputSchema: unknown }[] = [];
  if (deps.contractScan) {
    const scanPacks: InstalledPackScan = () => deps.contractScan!('installed_pack', []);
    const getManifest = (slug: string) => deps.executorConfig.manifests.get(slug);
    // §8 recipe-preferred suppression — pass the SAME pack resolution the
    // descriptors use so coverage maps lowered `ingredient:`-step writes (not
    // just `op:` steps) back to op ids; the op ids then align for suppression.
    const coverage = deps.recipeStore
      ? buildRecipeOpCoverage(deps.recipeStore, buildPackOpResolution(scanPacks, getManifest))
      : undefined;
    rawOpTools = buildRawOpToolDescriptors(scanPacks, getManifest, coverage).map((d) => ({
      name: d.wireName,
      description: d.description,
      inputSchema: d.inputSchema,
    }));
  }

  // D-171 external-door fold (codex LOW) — an inbound-token-gated
  // transport advertises only the tools its per-token checklist grants.
  // The catalog names here are already wire names (the same keys the
  // grants map and gate A use), so this is the same predicate, applied
  // at enumeration time: an ungranted tool's name/description/schema is
  // not leaked to the external agent.
  //
  // ⛔⛔ D-228 slice 6 — AN ABSENT CHECKLIST DENIES. This read
  // `gate ? gate(t.name) : true` — "owner transports (stdio / canonical CLI
  // bearer) leave the callback undefined ⇒ full catalog" — and that fallback was
  // the ungoverned half of the surface slice 1 only half-closed: slice 1 emptied
  // `buildMcpContractSnapshot`, while THIS path and `handleToolCall` went on
  // treating "no callback" as "the owner, allow everything". A caller with no
  // checklist is not the owner; it is a caller that presented no contract.
  //
  // 🔑 This makes stdio behave EXACTLY as the HTTP door already did, rather than
  // special-casing it: the HTTP transport always supplies a checklist, so its
  // tokens must already be granted `recued_listRecipes` et al. to see the meta
  // tools. Absent ⇒ deny is the same rule an empty checklist already produced.
  // A D-196 customer instance is unaffected — `customerRawOpGrant` answers
  // BEFORE this line, so a customer contract still grants its own tools without
  // a per-token checklist. What loses access is precisely a caller carrying
  // NEITHER, which on stdio means no `--token` / `RECUED_MCP_TOKEN`; the CLI
  // prints that instruction to stderr, so the refusal is recoverable.
  const allTools = [...TOOLS, ...ingredientTools, ...registryTools, ...rawOpTools];
  return {
    tools: allTools.filter((t) => {
      // Continuation status is an authenticated protocol utility, not a new
      // business capability. It can reveal only records bound to this same
      // token identity, so it does not require a second checklist grant; token
      // liveness and row ownership are both enforced at call time too.
      if (t.name === MCP_ACTION_STATUS_TOOL_NAME) {
        return deps.mcpActionStore !== undefined
          && (
            deps.ownerAdmitAll === true
            || deps.mcpPrincipalActive?.() === true
          );
      }
      // D-196 customer.status is not part of the inbound token business-tool
      // checklist. It is self-scoped and governed by the customer's contract
      // op grant (`core.customer.status`) plus the seller-customer context.
      if (t.name === CUSTOMER_STATUS_TOOL_NAME) {
        return deps.customerStatus !== undefined && isCustomerStatusGranted(deps);
      }
      const customerGrant = customerRawOpGrant(deps, t.name);
      if (customerGrant !== null) return customerGrant;
      // The authenticated owner (verified CLI bearer) carries no checklist and
      // is admit-all by design; everyone else needs one and is denied without.
      if (deps.ownerAdmitAll === true) return true;
      // ⚠ THE ENUMERATION MIRROR OF THE DISPATCH GATE, and it has to stay one.
      // A tool the checklist admits but the catalog hides is a door that works
      // only for a caller who already knew the name — which is what a peer's
      // agent does NOT have. Both sides now read `isCheckedListGranted`.
      return isCheckedListGranted(deps, t.name);
    }),
  };
};

export interface McpDeps extends ExecuteHandlerDeps {
  /** D-220 — read a live intake form so `recued_saveRecipe` is gated by the SAME
   *  form-field contract as the `recipe.save` rpc. Absent ⇒ the gate is inert,
   *  which is what shipped: an authenticated MCP caller could arm a
   *  `form_response.accepted` trigger against a form that does not collect the
   *  field the recipe declares, and every submission after it stored nothing. */
  formDefinitionReader?: FormDefinitionReader;
  vaultStore?: VaultStore;
  /** When set, the MCP server uses this to query the paired extension's
   *  ingredient catalog (for the extension-first tool merge) and to
   *  delegate per-ingredient tool calls to the extension when the
   *  ingredient lives there. When absent, all tools dispatch on the
   *  server only. */
  wsServer?: WsServerHandle;
  /** D-120 Phase 5 — annotation + typed-link store. Wired through to
   *  `recued_dataTimeline` so the timeline merge can pull annotations
   *  and D-119 typed links for the requested entity. Absent on test
   *  setups that exercise only the recipe-execution surface; when
   *  absent, the timeline tool returns an empty page for the
   *  annotation + link sources. */
  annotationStore?: AnnotationStore;
  /** D-120 Phase 5 — raw collection record loader. The composition
   *  root (bin.ts) wires this against the `CollectionRegistry` so the
   *  timeline tool can include the entity's own record snapshot
   *  alongside its provenance graph. Absent in tests + ext-routed
   *  setups; absent means raw record entries skip. */
  loadCollectionRecord?: LoadCollectionRecord;
  // D-128 Phase 5 — `enrichmentStore?: EnrichmentStore` inherits from
  // `ExecuteHandlerDeps`. The MCP timeline tool reads it (when
  // present) to fan `data_enrichment` rows into the feed alongside
  // mail / calendar / annotation / link entries; absent ⇒ enrichment
  // entries skip without breaking the rest of the merge.
  /** D-153 P2.C — token-derived agent identity for the MCP transport
   *  in use. Stdio transport (the default) is single-user, so callers
   *  leave it unset and `buildMcpExecutionSource` falls back to
   *  `STDIO_MCP_AGENT_ID`. Future HTTP / WS MCP transports derive this
   *  from the auth token at the request boundary. */
  agentId?: string;
  /** D-136 §A.13.1 P7.D — housekeeping state store. Wired through to
   *  `recued_registryDescribe` so the per-topic coverage stats can
   *  surface `producer_last_run_at` + a failure-rate heuristic from
   *  the persisted state. Absent on test setups that don't run the
   *  housekeeping engine; absent → those two fields surface as null
   *  / 0 without breaking the rest of the response. */
  housekeepingStateStore?: HousekeepingStateStore;
  /** D-136 §A.13.1 P7.D — per-server cap on
   *  `mcp.vector.similarity_search.limit` from
   *  `housekeeping_config.vector_search_max_results`. Optional;
   *  defaults to the contract-side `VECTOR_SEARCH_DEFAULT_LIMIT`
   *  (50). Tests override to assert clamping. */
  vectorSearchMaxResults?: number;
  /** D-139 P6.B — server-scoped MCP body-content visibility grant store.
   *  When wired, `recued_contactEngagementsList` resolves
   *  `body_content_granted` from `isGranted(ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY)`
   *  (granted by the `crm-commitment-tracker` pack on install). Absent ⇒
   *  body content stays stripped (the pre-P6.B default). */
  mcpBodyVisibilityStore?: import('./storage/mcp-body-visibility-store.js').McpBodyVisibilityStore;
  /** D-137 Trio #D — InternalToolRegistry-backed catalog (Tier 1 + 2 +
   *  3). When wired, `tools/list` appends Tier 1 / 2 / 3 entries
   *  alongside the legacy `recued_*` + `recued_ingredient_*` tools, and
   *  `tools/call` routes registry-known names through the
   *  `mcp_wire`-channel adapter (per-token gating + visibility
   *  filters apply through the registry's dispatch path). Absent ⇒
   *  external agents see only the legacy
   *  surface (pre-Trio-D shape). The same registry instance is shared
   *  with the chat orchestrator's internal-channel dispatch; the
   *  channel-isolation invariant (§ A.1.1) keeps the two callers from
   *  conflating contexts. */
  internalRegistry?: InternalToolRegistry;
  /** D-137 Trio #D — per-MCP-connection bearer token id. For stdio
   *  transport (single-user, no bearer), leave undefined — the adapter
   *  falls back to `STDIO_MCP_TOKEN_ID` so the channel-isolation
   *  invariant holds. HTTP / WS transports derive from the auth
   *  header at the request boundary. */
  mcpTokenId?: string;
  /** D-137 P5 follow-on / Codex review P1 fold — per-tool authorization
   *  callback for inbound-token-gated transports. When set,
   *  `handleToolCall` consults this BEFORE invoking ANY tool dispatch
   *  path (registry-routed Tier 1 / 2 tools, `recued_*` legacy tools,
   *  `recued_ingredient_*` per-ingredient tools). Returning `false` →
   *  the tool dispatch returns a "not granted by per-token checklist"
   *  MCP error envelope; the substrate `isMcpInboundTokenToolAuthorized`
   *  predicate is the canonical evaluator (active + grants[name] ===
   *  true; missing keys default-deny per spec § A.9 new-tool default-
   *  off).
   *
   *  ⛔⛔ D-228 slice 6 — ABSENT NO LONGER MEANS "NO GATE". It means NO TOKEN,
   *  and is DENIED at both `handleToolsList` and `handleToolCall`. The
   *  authenticated owner path is now the POSITIVE {@link McpDeps.ownerAdmitAll}
   *  flag below, because absence was conflating two callers that must not share
   *  an answer: a verified canonical CLI bearer, and a local process that
   *  presented nothing at all.
   *
   *  Codex review P1 — without this gate, possession of any active
   *  inbound token grants access to every MCP tool, defeating the
   *  Settings → MCP Tokens checklist entirely. */
  inboundTokenAuthorize?: (tool_name: string) => boolean;
  /** ⛔⛔ D-228 slice 6 — THE AUTHENTICATED OWNER, stated POSITIVELY.
   *
   *  Set ONLY by a caller that presented a canonical `client_tokens` bearer
   *  verified with `client_kind === 'cli'` (see `wire-mcp-http-transport.ts`) —
   *  the owner's own CLI / webclient. Such a caller is admit-all by design and
   *  carries no per-tool checklist, which is why it cannot be expressed as an
   *  absent {@link McpDeps.inboundTokenAuthorize}.
   *
   *  🔑 THE DISCRIMINATOR HAD TO BECOME POSITIVE. Before this, THREE different
   *  callers arrived with no authorizer and all three were admitted:
   *    1. a verified CLI bearer            — legitimately the owner
   *    2. stdio with no `--token`          — presented NOTHING (the D-228 hole)
   *    3. an UNRESOLVED bearer on HTTP     — `if (!resolved) return baseMcpDeps`,
   *                                          the very "one more call after the
   *                                          token was revoked" that D-137 P5's
   *                                          own P2 fold set out to close
   *  Denying on absence alone would have dark-booted (1); admitting on absence
   *  leaves (2) and (3) open. Only a positive claim separates them, and the two
   *  paths that can honestly make it are the two that authenticated. */
  ownerAdmitAll?: boolean;
  /** Positive liveness proof for a non-owner MCP token. Async-action status is
   * not a separately grantable business tool: it can reveal only rows bound to
   * this same token, but it still requires the token itself to be active. */
  mcpPrincipalActive?: () => boolean;
  /** True only on a transport that can actually deliver unsolicited JSON-RPC
   * messages. Recued's current stateless HTTP POST transport is polling-only. */
  mcpActionNotifications?: boolean;
  /** True only on a transport that can deliver unsolicited recipe callback
   * notifications. Set by the stdio transport; stateless HTTP remains polling
   * only and must never advertise this capability. */
  mcpRecipeCallbackNotifications?: boolean;
  /** Fresh authorization resolver for a queued callback pointer. Production
   * re-reads the token, its contract binding/liveness, MCP door scope, and the
   * exact query-tool grant before every delivery. The notification grants no
   * authority; the later tools/call still passes through the normal gates. */
  mcpRecipeCallbackAuthorize?: (pointer: McpRecipeCallbackPointer) => boolean;
  /** Drain token-authority-triggered callback retirement before stdio exits. */
  mcpShutdownDrain?: () => Promise<void> | void;
  /** D-166 P2 token↔contract binding — the minted `contract_id` the inbound
   *  token is bound to (from `McpInboundTokenRecord.contract_id`). When set,
   *  `buildMcpExecutionSource` stamps it as `ExecutionSource.contract_id` so the
   *  active contract's `.<contract_id>` overlay governs the dispatch live.
   *  Resolved + injected per-request by the HTTP transport. Unset (stdio owner /
   *  canonical CLI bearer / unbound token) ⇒ `contract_id` falls back to the token id
   *  (overlay INERT — pre-D-166 behavior). */
  boundContractId?: string;
  /** D-166 P2 token↔contract binding — whether {@link boundContractId}'s contract
   *  is live (minted + `isContractActive`) as resolved at request entry. `false`
   *  (or absent while `boundContractId` is set) ⇒ `buildMcpContractSnapshot`
   *  collapses the allowlist to `[]` so every tool is denied — revoke / expiry /
   *  exhaustion of the bound contract is a live kill-switch. Only meaningful when
   *  `boundContractId` is set. */
  boundContractActive?: boolean;
  /** D-196 customer-contract grant authority. Set only after fresh seller
   *  admission succeeds for a live customer token. Raw `recued_op_*` listing and
   *  calls then resolve from the bound customer contract instead of the ordinary
   *  D-137 per-token checklist; non-customer doors never set this flag. */
  customerContractGrants?: true;
  /** D-139 P5 — engagement-evidence resolver bundle (the same
   *  `{ engagementStore, resolverDeps }` the WS-rpc channel uses). When
   *  wired, `recued_contactEngagementsList` resolves contact-rooted
   *  engagement evidence + projects each row through the §A.9.5 body-
   *  strip rule. Absent ⇒ the tool returns a "not configured" error.
   *  The per-token tool checklist gates access (default-off). */
  engagementsResolveDeps?: ContactEngagementsResolveDeps;
  /** D-196 Seller Economy — request-local per-customer usage session, wired
   *  only for admitted seller-customer door bearers. The closed free/status/
   *  setup/catalog set consumes zero; a completed business `tools/call`
   *  commits one `tool_call`, plus D-162 customer-controlled N-1 units reserved
   *  at the real ingredient-dispatch boundary. */
  customerUsage?: McpCustomerUsageMeter;
  /** D-196 S2b — self-scoped seller customer status provider. Wired only for
   *  admitted seller customer door bearers and never accepts a customer id from
   *  the model. Contract grant `core.customer.status` controls visibility. */
  customerStatus?: McpCustomerStatusProvider;
}

/** Preserve the human/LLM text representation while also publishing the MCP
 *  structured-result channel. Declared MCP operations and work-entity Sources
 *  must be able to traverse recipe output without parsing presentation text. */
const text = (data: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  ...(data !== null && typeof data === 'object' && !Array.isArray(data)
    ? { structuredContent: data as Record<string, unknown> }
    : {}),
});
const err = (msg: string) => ({ content: [{ type: 'text', text: msg }], isError: true });
const MCP_ZERO_CUSTOMER_USAGE = Symbol('mcp.zero-customer-usage');

/** Settlement metadata is host-owned and non-enumerable. A business tool's
 * returned JSON is untrusted data and may legitimately contain fields such as
 * `success: false` or `status: cancelled`; it must never self-classify as free. */
const markMcpZeroCustomerUsage = <T>(result: T): T => {
  if (result !== null && typeof result === 'object') {
    Object.defineProperty(result, MCP_ZERO_CUSTOMER_USAGE, { value: true });
  }
  return result;
};

const isFailedExecuteResponse = (value: unknown): boolean =>
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (value as { success?: unknown }).success === false;

const mcpActionPrincipalId = (deps: McpDeps): string =>
  deps.mcpTokenId ?? STDIO_MCP_TOKEN_ID;

const currentCheckpointId = async (
  deps: McpDeps,
  runId: string,
): Promise<string | undefined> => {
  try {
    const anchor = await deps.auditLog?.get(runId);
    if (anchor?.commit_status === 'awaiting_approval' && anchor.checkpoint_id) {
      return anchor.checkpoint_id;
    }
  } catch {
    // Fall through to the checkpoint index; registration remains best-effort.
  }
  try {
    return (await deps.checkpointStore?.listByRun(runId))?.[0]?.checkpoint_id;
  } catch {
    return undefined;
  }
};

const mcpActionKindForRun = async (
  deps: McpDeps,
  runId: string,
): Promise<McpActionKind> => {
  try {
    const checkpoint = (await deps.checkpointStore?.listByRun(runId))?.[0];
    return checkpoint?.raw_op !== undefined ? 'raw_op' : 'recipe';
  } catch {
    // Recipe runs are the dominant registry path; raw-op callers use the
    // explicit route below and pass their kind without inference.
    return 'recipe';
  }
};

/** Attach a durable continuation address to an already-durable hold. Failure
 * never changes approval semantics: the action remains held and must not be
 * retried, while the missing receipt is logged for the operator. */
const attachMcpActionRef = async (
  deps: McpDeps,
  input: {
    run_id: string | undefined;
    tool_name: string;
    kind: McpActionKind;
    projected: unknown;
  },
): Promise<unknown> => {
  if (
    !deps.mcpActionStore
    || input.run_id === undefined
    || input.projected === null
    || typeof input.projected !== 'object'
    || Array.isArray(input.projected)
  ) return input.projected;
  try {
    const action = await deps.mcpActionStore.createHeld({
      run_id: input.run_id,
      principal_id: mcpActionPrincipalId(deps),
      tool_name: input.tool_name,
      kind: input.kind,
      checkpoint_id: await currentCheckpointId(deps, input.run_id),
    });
    return {
      ...(input.projected as Record<string, unknown>),
      action_ref: action.action_ref,
      action_status: action.status,
      action_query_tool: MCP_ACTION_STATUS_TOOL_NAME,
      ...(deps.mcpActionNotifications === true
        ? { action_notification_method: MCP_ACTION_NOTIFICATION_METHOD }
        : {}),
    };
  } catch (error) {
    console.warn(
      `[mcp] failed to persist async action for run_id=${input.run_id}: `
        + (error instanceof Error ? error.message : String(error)),
    );
    return input.projected;
  }
};

const textProjectedExecuteResult = async (
  result: unknown,
  deps: McpDeps,
  toolName: string,
) => {
  const projected = projectRunResultForAgent(result);
  const held =
    result !== null
    && typeof result === 'object'
    && !Array.isArray(result)
    && (result as { awaiting_approval?: unknown }).awaiting_approval === true;
  const projectedWithAction = held
    ? await attachMcpActionRef(deps, {
        run_id: executeResponseAuditRunId(result as ExecuteResponse),
        tool_name: toolName,
        kind: 'recipe',
        projected,
      })
    : projected;
  const response = text(projectedWithAction);
  return isFailedExecuteResponse(result)
    ? markMcpZeroCustomerUsage(response)
    : response;
};

const MCP_ACTION_STALE_RUNNING_MS = 15 * 60 * 1_000;
/** Give the answer writer a short window to retain its exact response after it
 * publishes the terminal audit anchor. Recovery must not race that write and
 * permanently replace a richer result with the audit-only fallback. */
const MCP_ACTION_TERMINAL_SETTLEMENT_GRACE_MS = 30_000;

/** Reconcile crash/restart residue from the existing durable checkpoint + run
 * anchor. Normal answer handling writes the exact result directly; this is the
 * recovery backstop for a process that crossed one durable write but not the
 * next. */
const reconcileMcpAction = async (
  deps: McpDeps,
  record: McpActionRecord,
): Promise<McpActionRecord> => {
  if (!deps.mcpActionStore || isMcpActionTerminal(record.status)) return record;
  let checkpoint = null as Awaited<ReturnType<NonNullable<McpDeps['checkpointStore']>['get']>>;
  try {
    if (record.current_checkpoint_id !== undefined && deps.checkpointStore) {
      checkpoint = await deps.checkpointStore.get(record.current_checkpoint_id);
    }
    if (checkpoint === null && deps.checkpointStore) {
      checkpoint = (await deps.checkpointStore.listByRun(record.run_id))[0] ?? null;
    }
  } catch {
    // A transient storage read must not manufacture a terminal result.
    return record;
  }

  let anchor = null as Awaited<ReturnType<NonNullable<McpDeps['auditLog']>['get']>>;
  try {
    anchor = await deps.auditLog?.get(record.run_id) ?? null;
  } catch {
    return record;
  }

  if (anchor?.commit_status === 'awaiting_approval') {
    if (record.status === 'awaiting_approval') {
      return await deps.mcpActionStore.markAwaiting(
        record.run_id,
        anchor.checkpoint_id ?? checkpoint?.checkpoint_id,
      ) ?? record;
    }
    // A running resume may legitimately leave the old awaiting anchor in place
    // until handleExecute writes the next/terminal anchor. Only return it to a
    // recoverable wait after the recipe's default hard timeout has elapsed.
    if (Date.now() - record.updated_at > MCP_ACTION_STALE_RUNNING_MS && checkpoint !== null) {
      return await deps.mcpActionStore.markAwaiting(
        record.run_id,
        anchor.checkpoint_id ?? checkpoint.checkpoint_id,
        'The interrupted resume remains recoverable from its durable checkpoint and will be retried.',
      ) ?? record;
    }
    return record;
  }

  if (anchor !== null) {
    if (
      typeof anchor.finished_at === 'number'
      && Date.now() - anchor.finished_at <= MCP_ACTION_TERMINAL_SETTLEMENT_GRACE_MS
    ) {
      return record;
    }
    const firstError = (anchor.errors ?? [])[0];
    const failure = {
      status: anchor.commit_status,
      run_id: record.run_id,
      ...(firstError !== undefined ? { error: firstError } : {}),
      message:
        firstError?.message
        ?? 'The exact deferred result was unavailable after recovery; inspect Recued Logs for this run.',
    };
    if (anchor.commit_status === 'succeeded') {
      return await deps.mcpActionStore.finish(record.run_id, {
        status: 'completed',
        status_message: 'The action completed; its exact deferred result was unavailable after recovery.',
        result: failure,
      }) ?? record;
    }
    if (anchor.commit_status === 'cancelled') {
      return await deps.mcpActionStore.finish(record.run_id, {
        status: 'cancelled',
        status_message: 'The action was cancelled.',
        result: failure,
      }) ?? record;
    }
    if (anchor.commit_status === 'in_doubt') {
      return await deps.mcpActionStore.finish(record.run_id, {
        status: 'in_doubt',
        status_message: failure.message,
        result: failure,
      }) ?? record;
    }
    if (anchor.commit_status === 'failed') {
      return await deps.mcpActionStore.finish(record.run_id, {
        status: 'failed',
        status_message: failure.message,
        result: failure,
      }) ?? record;
    }
    return record;
  }

  if (checkpoint !== null) {
    if (record.status === 'awaiting_approval') {
      return await deps.mcpActionStore.markAwaiting(
        record.run_id,
        checkpoint.checkpoint_id,
      ) ?? record;
    }
    if (Date.now() - record.updated_at > MCP_ACTION_STALE_RUNNING_MS) {
      return await deps.mcpActionStore.markAwaiting(
        record.run_id,
        checkpoint.checkpoint_id,
        'The interrupted resume remains recoverable from its durable checkpoint and will be retried.',
      ) ?? record;
    }
    return record;
  }

  if (record.status === 'running' && Date.now() - record.updated_at <= MCP_ACTION_STALE_RUNNING_MS) {
    return record;
  }

  // Raw ops intentionally have no run anchor and claim (delete) their checkpoint
  // before dispatch. Losing both while still non-terminal is therefore not a
  // safe-to-retry failure; a recipe action with neither substrate is corrupt too.
  return await deps.mcpActionStore.finish(record.run_id, {
    status: record.kind === 'raw_op' ? 'in_doubt' : 'failed',
    status_message: record.kind === 'raw_op'
      ? 'The raw operation checkpoint was consumed, but no terminal provider result was retained. Inspect Recued Logs before retrying.'
      : 'The action no longer has a recoverable checkpoint or run anchor.',
    result: {
      status: record.kind === 'raw_op' ? 'in_doubt' : 'failed',
      code: 'continuation_state_missing',
      message: record.kind === 'raw_op'
        ? 'The provider side effect may have occurred; inspect Recued Logs before retrying.'
        : 'The durable continuation state is missing.',
    },
  }) ?? record;
};

export type McpCustomerUsageInput = CustomerSurfaceUsageInput;
export type McpCustomerUsageAdmission = CustomerSurfaceUsageAdmission;
export type McpCustomerUsageMeter = CustomerSurfaceUsageSession;

export interface McpCustomerStatusProvider {
  getStatus(): unknown | Promise<unknown>;
}

const isMcpToolErrorResult = (value: unknown): boolean =>
  Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { isError?: unknown }).isError === true,
  );

const asMcpSchemaRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** Validate the ordinary JSON-Schema subset every live MCP descriptor uses.
 * Dynamic ingredient schemas are advisory and are validated by their adapter;
 * static, registry, and raw-op descriptors are authoritative at this seam. */
const validateMcpSchemaValue = (
  schema: unknown,
  value: unknown,
  path: string,
): string | null => {
  const record = asMcpSchemaRecord(schema);
  if (!record) return `${path} has an invalid tool argument schema`;
  if (Array.isArray(record.enum) && !record.enum.some((candidate) => Object.is(candidate, value))) {
    return `${path} must be one of the declared enum values`;
  }
  switch (record.type) {
    case undefined:
      return null;
    case 'string':
      return typeof value === 'string' ? null : `${path} must be a string`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `${path} must be a finite number`;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? null
        : `${path} must be an integer`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be a boolean`;
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (record.items === undefined) return null;
      for (let i = 0; i < value.length; i += 1) {
        const issue = validateMcpSchemaValue(record.items, value[i], `${path}[${i}]`);
        if (issue) return issue;
      }
      return null;
    }
    case 'object': {
      const object = asMcpSchemaRecord(value);
      if (!object) return `${path} must be an object`;
      const properties = asMcpSchemaRecord(record.properties) ?? {};
      if (Array.isArray(record.required)) {
        for (const key of record.required) {
          if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(object, key)) {
            return `${path}.${key} is required`;
          }
        }
      }
      for (const [key, child] of Object.entries(object)) {
        const childSchema = properties[key];
        if (childSchema === undefined) {
          if (record.additionalProperties === false) {
            return `${path}.${key} is not a declared argument`;
          }
          continue;
        }
        const issue = validateMcpSchemaValue(childSchema, child, `${path}.${key}`);
        if (issue) return issue;
      }
      return null;
    }
    default:
      return `${path} uses an unsupported tool argument schema type`;
  }
};

/** Only a completed business result commits seller usage. Agent-facing third
 * states are successful protocol envelopes but consume zero customer units.
 * The marker is set only from trusted dispatch metadata / ExecuteResponse,
 * never inferred from model- or provider-controlled result JSON. */
const isBillableMcpToolResult = (value: unknown): boolean => {
  if (isMcpToolErrorResult(value)) return false;
  return !(
    value !== null
    && typeof value === 'object'
    && (value as Record<PropertyKey, unknown>)[MCP_ZERO_CUSTOMER_USAGE] === true
  );
};

/** D-137 Trio #D — build an `McpInternalToolAdapter` from the deps, or
 *  null when no `InternalToolRegistry` is wired. Called per-request so
 *  the adapter closes over the current request's `mcpTokenId`; the
 *  stdio default token id satisfies the channel-isolation invariant
 *  without per-call allocation pressure (the adapter is a thin closure
 *  wrapper; the registry holds the catalog).
 *
 *  D-153 P2.C — the dispatch call site (`handleToolCall`) resolves
 *  the per-call `ExecutionSource` + `ContractSnapshot` and threads
 *  them through here so registry-routed Tier 1 `recipe.run` + Tier 2
 *  dispatches reach the execute-handler's policy gate with the right
 *  `(channel × actor)` cell. Catalog-enumeration callers
 *  (`handleToolsList`) leave both undefined — listing the catalog
 *  doesn't reach `handleExecute` and the policy gate has nothing to
 *  evaluate there. */
const buildAdapterForDeps = (
  deps: McpDeps,
  executionSource?: ExecutionSource,
  contractSnapshot?: ContractSnapshot,
): McpInternalToolAdapter | null => {
  if (!deps.internalRegistry) return null;
  return buildInternalToolMcpAdapter({
    registry: deps.internalRegistry,
    mcp_token_id: deps.mcpTokenId ?? STDIO_MCP_TOKEN_ID,
    ...(executionSource ? { execution_source: executionSource } : {}),
    ...(contractSnapshot ? { contract_snapshot: contractSnapshot } : {}),
  });
};

type McpCustomerUsagePreflight =
  | {
      readonly ok: true;
      readonly usage: McpCustomerUsageInput | null;
      /** Execute-backed calls reserve at their post-approval dispatch seam;
       * the outer route is only the fallback for a completed no-dispatch run. */
      readonly deferReservation: boolean;
    }
  | { readonly ok: false; readonly result: ReturnType<typeof err> };

const rawOpDescriptorForCustomerCall = (
  deps: McpDeps,
  toolName: string,
): RawOpToolDescriptor | null => {
  if (!deps.contractScan) return null;
  const scanPacks: InstalledPackScan = () => deps.contractScan!('installed_pack', []);
  const getManifest = (slug: string) => deps.executorConfig.manifests.get(slug);
  const coverage = deps.recipeStore
    ? buildRecipeOpCoverage(
        deps.recipeStore,
        buildPackOpResolution(scanPacks, getManifest),
      )
    : undefined;
  return buildRawOpToolDescriptors(scanPacks, getManifest, coverage)
    .find((descriptor) => descriptor.wireName === toolName) ?? null;
};

/** Seller-metered MCP calls preflight the same live grant and descriptor the
 * dispatch will re-check. This is intentionally request-local duplication: no
 * side effect occurs here, and the real handler remains the final authority
 * after the reservation yield. */
const preflightMcpCustomerUsage = (
  params: { name: string; arguments?: Record<string, unknown> },
  deps: McpDeps,
): McpCustomerUsagePreflight => {
  const args = params.arguments ?? {};
  if (
    params.name !== MCP_ACTION_STATUS_TOOL_NAME
    && deps.boundContractId !== undefined
    && deps.boundContractActive !== true
  ) {
    return {
      ok: false,
      result: err(
        'The contract bound to this token is no longer live (revoked / expired / exhausted).',
      ),
    };
  }

  if (params.name === MCP_ACTION_STATUS_TOOL_NAME) {
    if (!deps.mcpActionStore) {
      return {
        ok: false,
        result: err('Async MCP action tracking is not configured on this server.'),
      };
    }
    if (
      deps.ownerAdmitAll !== true
      && deps.mcpPrincipalActive?.() !== true
    ) {
      return {
        ok: false,
        result: err('The MCP token for this async action is no longer active.'),
      };
    }
  } else if (params.name === CUSTOMER_STATUS_TOOL_NAME) {
    if (!deps.customerStatus) {
      return {
        ok: false,
        result: err('customer.status is available only to an admitted seller customer token.'),
      };
    }
    if (!isCustomerStatusGranted(deps)) {
      return {
        ok: false,
        result: err('customer.status is not granted by this customer contract.'),
      };
    }
    if (Object.keys(args).length > 0) {
      return { ok: false, result: err('customer.status does not accept arguments.') };
    }
  } else {
    const customerGrant = customerRawOpGrant(deps, params.name);
    if (customerGrant === false) {
      return {
        ok: false,
        result: err(`Tool '${params.name}' is not granted by this customer contract.`),
      };
    }
    if (
      customerGrant === null
      && deps.inboundTokenAuthorize
      && !deps.inboundTokenAuthorize(params.name)
    ) {
      return {
        ok: false,
        result: err(
          `Tool '${params.name}' is not granted by this token's per-tool checklist (Settings → MCP Tokens).`,
        ),
      };
    }
  }

  const staticTool = TOOLS.find((tool) => tool.name === params.name);
  const registryEntry = deps.internalRegistry?.getByName(params.name) ?? null;
  let schema: unknown;
  let validateSchema = true;
  if (staticTool) {
    schema = staticTool.inputSchema;
  } else if (registryEntry) {
    if (registryEntry.tier === 3) {
      return {
        ok: false,
        result: err(
          `Tool '${params.name}' is a connection.mcp.* passthrough and is not exposed on the MCP wire (call the upstream MCP server directly).`,
        ),
      };
    }
    schema = registryEntry.arg_schema;
  } else if (params.name.startsWith(INGREDIENT_TOOL_PREFIX)) {
    const slug = params.name.slice(INGREDIENT_TOOL_PREFIX.length);
    const manifest = deps.executorConfig.manifests.get(slug);
    // Extension-only ingredients are intentionally absent from the server
    // manifest registry. When a paired extension exists, defer that dynamic
    // route validation to `handleToolCall` (the reservation is deferred too);
    // without an extension, a miss is conclusively unknown here.
    if ((!manifest && !deps.wsServer) || (manifest && !isMcpExposedIngredient(manifest))) {
      return { ok: false, result: err(`Unknown or non-exposable ingredient: ${slug}`) };
    }
    // `inferInputSchema` is explicitly advisory; the ingredient adapter owns
    // exact validation. The envelope object was validated by the JSON-RPC seam.
    validateSchema = false;
  } else if (params.name.startsWith(OP_TOOL_PREFIX)) {
    const descriptor = rawOpDescriptorForCustomerCall(deps, params.name);
    if (!descriptor) {
      return { ok: false, result: err(`Unknown raw operation tool: ${params.name}`) };
    }
    schema = descriptor.inputSchema;
  } else {
    return { ok: false, result: err(`Unknown tool: ${params.name}`) };
  }

  if (validateSchema) {
    const issue = validateMcpSchemaValue(schema, args, 'arguments');
    if (issue) return { ok: false, result: err(issue) };
  }

  if (
    staticTool
    && params.name !== 'recued_runRecipe'
    && params.name !== CUSTOMER_STATUS_TOOL_NAME
    // D-234 § 234.4 — see {@link isSelfGatedNativeMcpTool}.
    && !isSelfGatedNativeMcpTool(params.name)
  ) {
    const approval = admitMcpDirectDispatch(deps, params.name);
    if (!approval.ok) return { ok: false, result: err(approval.message) };
  }

  const usage = MCP_FREE_CUSTOMER_TOOL_NAMES.has(params.name)
    ? null
    : { tool_name: params.name, usage_kind: 'tool_call' as const, units: 1 };
  const executeBacked =
    params.name === 'recued_runRecipe'
    || params.name === 'recipe.run'
    || params.name.startsWith(INGREDIENT_TOOL_PREFIX)
    || params.name.startsWith(OP_TOOL_PREFIX)
    || registryEntry?.tier === 2;
  return {
    ok: true,
    usage,
    // Every execute-backed route now has a real dispatch hook: the commit
    // Gateway when available, the execute-handler's narrow fallback when it
    // is not, the catalog Gateway for raw ops, and the explicit extension
    // delegation seam. Defer uniformly so validation/approval/failure paths
    // cannot consume capacity early and an empty D-162 batch stays N=0.
    deferReservation: usage !== null && executeBacked,
  };
};

const handleToolCall = async (
  params: { name: string; arguments?: Record<string, unknown> },
  deps: McpDeps,
): Promise<unknown> => {
  const args = params.arguments ?? {};

  // D-187 token-lifecycle — bound-contract liveness KILL-SWITCH. The native /
  // static `recued_*` path's structural mirror of `buildMcpContractSnapshot`'s
  // allowlist collapse (the registry + `recued_ingredient_*` paths) and
  // `admitRawOp`'s dead-contract `tool_not_in_contract` deny (the `recued_op_*`
  // path). A token bound to a contract that is no longer live (revoked / expired
  // / exhausted / deleted) authorizes NOTHING — every dispatch path through this
  // one choke point is denied here, BEFORE the per-tool checklist below,
  // `admitMcpDirectDispatch` (which treats an inactive contract as INERT →
  // proceed), and the native read tools' read-grant checker (whose owner-default
  // `''`-admit is therefore never reached for a revoked door). fail-closed:
  // `!== true` also denies a bound token whose liveness couldn't be resolved.
  // Unbound (stdio owner / canonical CLI bearer, `boundContractId` undefined) is
  // unaffected — the guard requires a bound id, so the owner's contract-free MCP
  // keeps full access. This makes the kill-switch TRANSPORT-INDEPENDENT + returns
  // the accurate "contract no longer live" reason (not the misleading "not
  // granted by checklist"). `handleToolsList` carries the matching ENUMERATION
  // guard (empty catalog for a dead contract), so the per-token
  // `inboundTokenAuthorize` callback is now PURELY the token's checklist on both
  // axes — the HTTP transport no longer collapses it to `() => false` for a dead
  // contract (that conflated "contract dead" with "token grants nothing").
  if (
    params.name !== MCP_ACTION_STATUS_TOOL_NAME
    && deps.boundContractId !== undefined
    && deps.boundContractActive !== true
  ) {
    return err(
      'The contract bound to this token is no longer live (revoked / expired / exhausted).',
    );
  }

  // D-137 P5 follow-on / Codex review P1 fold — per-tool grant gate.
  // Runs BEFORE every dispatch path (registry / `recued_*` / `recued_-
  // ingredient_*`). When the inbound-token callback rejects, surface
  // an MCP error envelope so the external agent reads "tool not
  // granted by Mary's per-token checklist" without leaking which other
  // tools the token covers. Spec § A.9 new-tool default-off applies —
  // a tool name absent from the grants map resolves to `false` at the
  // substrate predicate level. D-228 superseded the D-137 interim here:
  // `ownerAdmitAll` is the positive verified-owner bypass; an absent
  // callback by itself means no token/checklist and denies below.
  if (params.name === MCP_ACTION_STATUS_TOOL_NAME) {
    if (!deps.mcpActionStore) {
      return err('Async MCP action tracking is not configured on this server.');
    }
    if (
      deps.ownerAdmitAll !== true
      && deps.mcpPrincipalActive?.() !== true
    ) {
      return err('The MCP token for this async action is no longer active.');
    }
  } else if (params.name === CUSTOMER_STATUS_TOOL_NAME) {
    if (!deps.customerStatus) {
      return err('customer.status is available only to an admitted seller customer token.');
    }
    if (!isCustomerStatusGranted(deps)) {
      return err('customer.status is not granted by this customer contract.');
    }
    if (Object.keys(args).length > 0) {
      return err('customer.status does not accept arguments.');
    }
  } else {
    const customerGrant = customerRawOpGrant(deps, params.name);
    if (customerGrant === false) {
      return err(`Tool '${params.name}' is not granted by this customer contract.`);
    }
    // ⛔⛔ D-228 slice 6 — AN ABSENT CHECKLIST DENIES, and the missing `deps.
    // inboundTokenAuthorize &&` term is the whole change. That term made an
    // ABSENT callback SKIP the deny — so `recued mcp` with no token listed and
    // DISPATCHED the entire registry catalog, while slice 1 had emptied only
    // `buildMcpContractSnapshot`. The enumeration mirror is in `handleToolsList`;
    // both now read "no checklist ⇒ nothing", the same answer an empty checklist
    // already gave. A D-196 customer is unaffected (`customerGrant !== null`
    // returns above), so this denies exactly the caller that presented neither a
    // token checklist nor a customer contract.
    if (
      customerGrant === null
      && deps.ownerAdmitAll !== true
      && !isCheckedListGranted(deps, params.name)
    ) {
      return err(
        deps.inboundTokenAuthorize === undefined
          ? `Tool '${params.name}' is not available: this connection presented no MCP token, `
            + 'so it carries no per-tool checklist. Pass --token <bearer> or set '
            + 'RECUED_MCP_TOKEN; create one in Settings → MCP Tokens.'
          : `Tool '${params.name}' is not granted by this token's per-tool checklist (Settings → MCP Tokens).`,
      );
    }
  }

  // D-137 Trio #D — InternalToolRegistry-routed catalog (Tier 1 + 2 +
  // 3). Dispatch through the `mcp_wire`-channel adapter when the
  // registry knows the name. The adapter sets `channel: 'mcp_wire'` +
  // the synthetic stdio token id (or the real HTTP-transport token
  // when wired); the registry's channel-isolation guard rejects
  // dispatches missing the token discriminator. Audit emission
  // mirrors the per-ingredient `mcp_dispatch` receipt below; the
  // registry's per-tier handler emits its own audit row through
  // `handleExecute` / `chat_tool_call` paths, so this row is the thin
  // channel-boundary receipt.
  //
  // Probe the registry directly for the tool name (cheaper than
  // building an adapter just for `hasTool` — `getByName` is the same
  // O(catalog) walk the adapter would do). Tests that exercise the
  // pre-registry gate path pass `deps` shaped as `{ inboundTokenAuthorize }`
  // (no registry, no executorConfig); short-circuiting on the
  // `internalRegistry` absence keeps the D-153 source / snapshot
  // resolution (next block) gated behind a real dispatch.
  const registryEntry = deps.internalRegistry?.getByName(params.name) ?? null;
  if (registryEntry) {
    // Codex P1 fold (Trio #D) — refuse Tier 3 (`connection.mcp.*`)
    // dispatches on the MCP wire even if a stale client holds onto a
    // cached `tools/list` entry from a pre-filter window. Tier 3 are
    // Mary's outbound credentials; external agents calling them would
    // hop through Mary's authorization envelope. The catalog filter
    // above already hides Tier 3 from `tools/list`; this is the
    // dispatch-side belt-and-braces.
    if (registryEntry.tier === 3) {
      return err(
        `Tool '${params.name}' is a connection.mcp.* passthrough and is not exposed on the MCP wire (call the upstream MCP server directly).`,
      );
    }
    // ⛔⛔ D-228 slice 5 — THE CONTRACT GATE ON TIER-1 PRIMITIVES, wired here and
    // ONLY here. This is the seam where a contract identity exists: the internal
    // chat channel leaves `execution_source` / `contract_snapshot` undefined by
    // design, so there is nothing to gate against there, and gating "the owner
    // against themselves" would be a no-op anyway.
    //
    // 🔑 The per-token checklist above is a DIFFERENT axis and both must pass:
    // the checklist is what THIS TOKEN may use, the contract is what this DOOR
    // may ever be granted. A token cannot widen past its contract, which is the
    // property D-228 exists for — "the contract governs the catalog on every
    // surface". `isOpGranted` resolves explicit row ?? author default, so the
    // owner (no governing contract on an unbound token) and a wildcard door both
    // admit; a scoped door / D-196 customer resolves its own posture.
    //
    // ⚠ SAFE ONLY BECAUSE OF `grandfatherPrimitiveGrants` — a scoped door and a
    // customer instance are FAIL-CLOSED by author default, and no `primitive.*`
    // row could have existed before this slice, so without the one-time
    // grandfather at boot this line would strip the always-on tools from every
    // such contract on upgrade. Do not land one without the other.
    if (registryEntry.tier === 1 && deps.opAdmissionGate !== undefined) {
      const source = buildMcpExecutionSource(deps);
      if (!deps.opAdmissionGate.isOpGranted(source, primitiveGrantEntry(params.name))) {
        return err(
          `Tool '${params.name}' is not granted by this contract (Settings → Contracts → Ops).`,
        );
      }
    }
    // D-153 P2.C — resolve the per-call `ExecutionSource` +
    // `ContractSnapshot` for the registry-routed dispatch so Tier 1
    // `recipe.run` + Tier 2 `<publisher>/<recipe_id>` recipes arrive at
    // the execute-handler's policy gate the same way the legacy
    // `recued_runRecipe` + `recued_ingredient_*` paths do (lines
    // 824-825 + 895-896 below). Both helpers are pure + cheap (a
    // manifest-slug filter + a synthetic id) but read `deps.executor-
    // Config.manifests`, so we resolve them only AFTER the gate +
    // Tier 3 short-circuits filter out call-shape probes that pass
    // partial deps. The full adapter is built here too — the previous
    // `getByName` probe didn't allocate one.
    const registryExecutionSource = buildMcpExecutionSource(deps);
    const registryContractSnapshot = buildMcpContractSnapshot(
      registryExecutionSource,
      deps,
    );
    const registryAdapter = buildAdapterForDeps(
      deps,
      registryExecutionSource,
      registryContractSnapshot,
    )!;
    const startedAt = Date.now();
    let status: 'ok' | 'failed' = 'failed';
    try {
      const result = await registryAdapter.callTool(params.name, args);
      if (result.ok) {
        status = 'ok';
        const projected =
          result.run_held?.kind === 'approval' && result.run_id !== undefined
            ? await attachMcpActionRef(deps, {
                run_id: result.run_id,
                tool_name: params.name,
                kind: await mcpActionKindForRun(deps, result.run_id),
                projected: result.result,
              })
            : result.result;
        const response = text(projected);
        return result.run_failed || result.run_held
          ? markMcpZeroCustomerUsage(response)
          : response;
      }
      return err(formatMcpDispatchError(result));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    } finally {
      if (deps.auditLog) {
        try {
          await deps.auditLog.logActivity({
            activity_id: '',
            timestamp: startedAt,
            action: 'mcp_dispatch',
            target: params.name,
            detail: `via=registry,status=${status},elapsed_ms=${Date.now() - startedAt}`,
          });
        } catch { /* audit is best-effort */ }
      }
    }
  }

  // Dynamic per-ingredient tools: prefix `recued_ingredient_<slug>`. Route
  // every call through the inline `run-ingredient` kernel recipe so audit,
  // adapter dispatch, cache, and approval all run their standard paths.
  //
  // Extension-first: query the route map fresh per call (cheap — the ext
  // list is cached inside the ws-server side). When the slug is held by
  // the paired extension, delegate via pair-WS. Otherwise dispatch on
  // the server. If the extension went offline between tools/list and
  // tools/call, the ext dispatch fails and we surface a clear error;
  // the agent can retry (tools/list will have refreshed by then).
  if (params.name.startsWith(INGREDIENT_TOOL_PREFIX)) {
    const slug = params.name.slice(INGREDIENT_TOOL_PREFIX.length);
    // D-182 §8 dispatch-time backstop — a `cli`/`service` catalog is local
    // code-exec / external subprocess and is NEVER callable directly as a raw
    // MCP tool. It's already hidden from tools/list + the grant catalog (the
    // combined fence) and ungrantable, but the refusal here is STRUCTURAL: it
    // fires on EVERY transport — including the stdio owner, who has no per-token
    // gate — because the invariant is "cli/service stay recipe-internal", not a
    // token scope. A recipe that uses the binary internally (via runRecipe) is
    // gated separately by the §7.2 reachability grant; this only blocks the raw
    // direct call. (cli/service are server-only, so the server registry is the
    // authoritative source; an extension-held DOM slug is never fenced here.)
    const fenceManifest = deps.executorConfig.manifests.get(slug);
    if (fenceManifest && !isExternallyExposableIngredient(fenceManifest)) {
      return err(
        `Tool '${params.name}' is a local-binary (cli) or service ingredient and `
          + `cannot be called directly over MCP — trigger a recipe that uses it `
          + `instead (D-182 §8: cli/service stay recipe-internal).`,
      );
    }
    // D-173 P5 follow-on — the dispatch backstop must match the tools/list
    // advertisement filter (`isMcpExposedKernelIngredient`). A kernel ingredient
    // (author `recued`) NOT in `MCP_EXPOSED_KERNEL_INGREDIENTS` is already hidden
    // from tools/list + ungrantable, but without THIS check a guessed
    // `recued_ingredient_<slug>` would still reach dispatch: the policy gate fails
    // CLOSED for an external token (the slug is never granted), but the owner's
    // no-token stdio path would otherwise dispatch it. Refuse it STRUCTURALLY here
    // — on every transport, mirroring the cli/service backstop above — so the
    // recipe-internal kernel WRITERS (`file-set-scan-status`, `file-persist`,
    // `shared-write`, …) can never be a direct agent tool; only the explicitly
    // whitelisted `data-file-read` stays externally callable. (cli/service are
    // non-`recued`, so this and the fence above are disjoint in practice.)
    if (fenceManifest && !isMcpExposedKernelIngredient(fenceManifest)) {
      return err(
        `Tool '${params.name}' is a recipe-internal kernel ingredient and cannot `
          + `be called directly over MCP — trigger a recipe that uses it instead `
          + `(only whitelisted kernel ingredients are externally callable).`,
      );
    }
    let target: 'extension' | 'server' = 'server';
    if (deps.wsServer) {
      try {
        const extList = await deps.wsServer.listExtensionIngredients();
        if (extList && extList.some((e) => e.slug === slug)) {
          target = 'extension';
        }
      } catch { /* offline — fall through to server */ }
    }
    try {
      if (target === 'extension' && deps.wsServer) {
        // The paired extension owns its own approval engine, so the server's
        // last safe pre-dispatch seam is immediately before delegation. The
        // returned held/failed ExecuteResponse is still host-marked zero-unit
        // and releases this reversible reservation at the outer route.
        if (deps.customerUsage) {
          const usage = deps.customerUsage.reserveOnce(
            DIRECT_MCP_TOOL_CALL_BASE_RESERVATION_KEY,
            {
              tool_name: params.name,
              usage_kind: 'tool_call',
              units: 1,
            },
          );
          if (!usage.admitted) return err(usage.message);
        }
        // Thin server-side audit receipt: just the dispatch envelope,
        // no payload (input/output live in the extension's audit log).
        const startedAt = Date.now();
        let status: 'returned' | 'failed' = 'failed';
        let result: unknown = null;
        try {
          result = await deps.wsServer.runKernelRecipeOnExtension(
            'run-ingredient',
            { ingredient_slug: slug, input: args },
          );
          status = 'returned';
        } finally {
          if (deps.auditLog) {
            try {
              await deps.auditLog.logActivity({
                activity_id: '',
                timestamp: startedAt,
                action: 'mcp_dispatch',
                target: slug,
                detail: `via=extension,status=${status},elapsed_ms=${Date.now() - startedAt}`,
              });
            } catch { /* audit is best-effort */ }
          }
        }
        // Defensive: if the extension ever returns a held ExecuteResponse,
        // project it to the clean agent-facing shape too (no-op otherwise).
        return await textProjectedExecuteResult(result, deps, params.name);
      }
      // Server-side dispatch via inline kernel recipe.
      const manifest = deps.executorConfig.manifests.get(slug);
      if (!manifest) return err(`Unknown ingredient: ${slug}`);
      // D-153 P2.C — construct mcp ExecutionSource + ContractSnapshot
      // so the execute-handler's policy gate evaluates this dispatch
      // against the `(channel: 'mcp', actor: 'contracted_user')` cell
      // with the per-token allow-list. The snapshot is the contract;
      // baseline mcp cell fails closed (spec line 425).
      const executionSource = buildMcpExecutionSource(deps);
      const contractSnapshot = buildMcpContractSnapshot(executionSource, deps);
      const result = await handleExecute(deps, {
        recipe: RUN_INGREDIENT_RECIPE as unknown as Record<string, unknown>,
        config: { ingredient_slug: slug, input: args },
        trigger_source: 'mcp',
        execution_source: executionSource,
        contract_snapshot: contractSnapshot,
      });
      // Project a preflight-HELD ingredient run to its clean agent-facing
      // shape (no bare `success:false` that reads as a silent failure).
      return await textProjectedExecuteResult(result, deps, params.name);
    } catch (e) {
      const { RpcError } = await import('@recued/contracts');
      if (e instanceof RpcError) {
        return err(JSON.stringify({ code: e.code, message: e.message }));
      }
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // D-182 §8 step 7 (GRANT HALF) — recipe-less raw catalog-op dispatch. A door
  // may expose installed Tier-P pack ops (`recued_op_<publisher>.<pack>.<op>`)
  // to an external LLM WITHOUT a recipe (§8). The op resolves to its installed
  // pack's catalog binding, is §8-fenced (cli/service never raw), and routes
  // through the SAME `runCatalogOperation` Gateway every recipe op crosses
  // (audit / policy / connection-profile authorization all standard, under the
  // door's contract). The authorization gate at the top of this function already
  // governed callability: ordinary doors use the per-token checklist, while an
  // admitted D-196 customer uses its bound contract grant. Inc D projects these
  // ops into the door catalog so a door token can reach them. Reads dispatch
  // end-to-end; a write
  // the gateway holds surfaces a clean not-yet-held message (Inc B lands the
  // real recipe-less hold + raw_op grant mint). Returns here (like the
  // `recued_ingredient_` branch) BEFORE the static-tool overlay/meter block.
  // `dispatchRawOp` applies the contract policy_matrix admission + recordUse
  // metering itself (Inc B-admission), using the `contractSnapshot` built here —
  // so reads are owner-policy-gated exactly as a recipe op is. Inc B-writes: a
  // write / ask-tier op the gate holds is durably HELD here (a recipe-less
  // checkpoint + the D-158 ask), and an `allow_session` answer mints a `raw_op`
  // grant so the next identical call auto-admits — the hold substrate
  // (`checkpointStore` / `preflightNotifier` / `sessionGrantResolver`) rides
  // `deps` (McpDeps ⊇ ExecuteHandlerDeps); absent ⇒ the degraded not-wired ask.
  if (params.name.startsWith(OP_TOOL_PREFIX)) {
    const opId = params.name.slice(OP_TOOL_PREFIX.length);
    try {
      const executionSource = buildMcpExecutionSource(deps);
      const contractSnapshot = buildMcpContractSnapshot(executionSource, deps);
      const outcome = await dispatchRawOp(deps, {
        opId,
        args,
        executionSource,
        contractSnapshot,
      });
      switch (outcome.kind) {
        case 'refused':
          return err(outcome.message);
        case 'held':
          // Inc B-writes — the op is durably HELD for the owner's approval (a
          // recipe-less checkpoint + the D-158 ask). A held action is the
          // expected, successful outcome — NOT an error. Same agent-facing
          // message a held recipe run gets (expected-outcome framing +
          // do-NOT-resend + tell-the-user), so a weak/local model never loops.
          return markMcpZeroCustomerUsage(text(await attachMcpActionRef(deps, {
            run_id: outcome.run_id,
            tool_name: params.name,
            kind: 'raw_op',
            projected: {
              status: 'awaiting_approval',
              awaiting_approval: true,
              op: outcome.op_id,
              message: HELD_FOR_APPROVAL_MESSAGE,
            },
          })));
        case 'ask':
          // The DEGRADED stub — an ask-tier op that could not be held durably
          // (hold substrate unwired). Self-describing + anti-loop (the message
          // says do-not-retry). Still not an error envelope.
          return markMcpZeroCustomerUsage(text({
            status: 'requires_approval',
            op: outcome.op_id,
            message: outcome.message,
          }));
        case 'result':
          return text(projectRunResultForAgent(outcome.result));
      }
    } catch (e) {
      const { RpcError } = await import('@recued/contracts');
      if (e instanceof RpcError) {
        return err(JSON.stringify({ code: e.code, message: e.message }));
      }
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // D-171 slice-2c follow-on #1 — every static `recued_*` case below returns
  // directly (no `handleExecute`, so no per-dispatch `recordUse`), EXCEPT
  // `recued_runRecipe` which runs a recipe through `handleExecute` (recording
  // per ingredient dispatch). Record one contract use here for the direct-return
  // tools so a bound usage cap decrements; exclude `recued_runRecipe` to avoid
  // double-counting. The registry + `recued_ingredient_*` paths already returned
  // above (same reason). No-op without a bound active contract.
  if (
    params.name !== 'recued_runRecipe'
    && params.name !== MCP_ACTION_STATUS_TOOL_NAME
    && params.name !== CUSTOMER_STATUS_TOOL_NAME
  ) {
    // D-187 — apply the op-risk × stage-trust APPROVAL decision (+ the per-tool ACCESS
    // allowlist) BEFORE metering or dispatching, so a denied / approval-required tool
    // refuses here and `recordUse` fires only for an admitted direct-return call.
    // (`recued_runRecipe` runs through `handleExecute`, which gates itself — excluded,
    // like the recordUse below.)
    //
    // ⛔ D-234 § 234.4 — THE APPROVAL VERDICT IS SKIPPED FOR A SELF-GATED TOOL,
    // THE METER IS NOT, and the split is the point. A usage cap is an ACCESS
    // limit the owner set on the door, not an approval — dropping it with the
    // verdict would let an exposed peer ask unlimited questions while the token's
    // cap never moved. See {@link isSelfGatedNativeMcpTool} for what replaces the
    // verdict. ⚠ The sibling site above must carry the same exemption or this one
    // never runs: that one refuses first, with the same dead-end message.
    if (!isSelfGatedNativeMcpTool(params.name)) {
      const admission = admitMcpDirectDispatch(deps, params.name);
      if (!admission.ok) return err(admission.message);
    }
    recordMcpDirectDispatchUse(deps, params.name);
  }

  switch (params.name) {
    // ── async action status/result ───────────────────────────
    case MCP_ACTION_STATUS_TOOL_NAME: {
      if (
        Object.keys(args).some((key) => key !== 'action_ref')
        || typeof args.action_ref !== 'string'
        || args.action_ref.length === 0
        || args.action_ref.length > 128
      ) {
        return err('action_ref is required and is the only accepted argument.');
      }
      const record = await deps.mcpActionStore!.getOwned(
        args.action_ref,
        mcpActionPrincipalId(deps),
      );
      if (record === null) {
        // Unknown and wrong-principal intentionally share one response: an
        // opaque ref must not become an action-existence oracle.
        return err('Async action not found for this MCP token.');
      }
      const reconciled = await reconcileMcpAction(deps, record);
      return text(projectMcpActionPublicState(reconciled));
    }

    // ── customerStatus ────────────────────────────────────
    case CUSTOMER_STATUS_TOOL_NAME: {
      try {
        return text(await deps.customerStatus!.getStatus());
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    }

    // ── listRecipes ────────────────────────────────────────
    case 'recued_listRecipes':
      return text(
        deps.recipeStore.ids().map((id) => {
          const r = deps.recipeStore.get(id);
          // Filter out kernel-namespace recipes — they're implementation
          // detail for the per-ingredient tools above, not user content.
          if (!r || r.metadata.author === 'recued') return null;
          return {
            recipe_id: r.recipe_id,
            name: r.metadata.name,
            description: r.metadata.description,
            tags: r.metadata.tags,
            version: r.version,
          };
        }).filter(Boolean),
      );

    // ── getRecipe ──────────────────────────────────────────
    case 'recued_getRecipe': {
      const id = args.recipe_id as string | undefined;
      if (!id) return err('recipe_id is required');
      const r = deps.recipeStore.get(id);
      if (!r) return err(`Recipe not found: ${id}`);
      return text(r);
    }

    // ── listIngredients ────────────────────────────────────
    case 'recued_listIngredients':
      return text(
        deps.executorConfig.manifests.slugs().map((slug) => {
          const m = deps.executorConfig.manifests.get(slug);
          return m
            ? {
                slug: m.slug,
                name: m.name,
                category: m.category,
                description: m.description,
                tags: m.tags,
              }
            : null;
        }).filter(Boolean),
      );

    // ── runRecipe ──────────────────────────────────────────
    case 'recued_runRecipe': {
      // D-153 P2.C — same mcp ExecutionSource + ContractSnapshot
      // construction as the per-ingredient dispatch above; the policy
      // gate evaluates this `recued_runRecipe` call against the
      // `(channel: 'mcp', actor: 'contracted_user')` cell with the
      // per-token allow-list.
      const executionSource = buildMcpExecutionSource(deps);
      const contractSnapshot = buildMcpContractSnapshot(executionSource, deps);
      const req: ExecuteRequest = {
        recipe_id: args.recipe_id as string | undefined,
        recipe: args.recipe,
        vault: args.vault as Record<string, unknown> | undefined,
        config: args.config as Record<string, unknown> | undefined,
        context: args.context as Record<string, unknown> | undefined,
        trigger_source: 'mcp',
        execution_source: executionSource,
        contract_snapshot: contractSnapshot,
      };
      try {
        // D-221 §3.3.3 — the legacy umbrella is an exposure seam too. Tier 2
        // registry tools and `recipe.run` preflight in chat-tool-handlers, but a
        // caller granted only `recued_runRecipe` can supply the same stored or
        // inline recipe here. Re-resolve the body at dispatch time and apply the
        // identical installed-operation inventory before the engine can run its
        // prefetch/trigger phases. Missing recipes keep their established
        // `recipe_not_found` response from handleExecute.
        const exposedRecipe = args.recipe !== undefined
          ? args.recipe as import('@recued/contracts').RecipeDefinition
          : typeof args.recipe_id === 'string'
            ? deps.recipeStore.get(args.recipe_id)
            : null;
        if (exposedRecipe !== null && deps.recordsStore !== undefined) {
          assertRecordsNonOwnerRecipeExposure(exposedRecipe, 'mcp', {
            isOperationId: (operationId) =>
              deps.recordsStore!.isInstalledOperationId(operationId),
            isCatalogOperation: (catalogSlug, operationKey) =>
              deps.recordsStore!.isInstalledCatalogOperation(catalogSlug, operationKey),
          });
        }
        const result = await handleExecute(deps, req);
        // Project a preflight-HELD run to its clean agent-facing shape (no
        // bare `success:false`, which an MCP agent reads as a silent failure).
        return await textProjectedExecuteResult(result, deps, params.name);
      } catch (e) {
        const { RpcError } = await import('@recued/contracts');
        if (e instanceof RpcError) {
          return err(JSON.stringify({ code: e.code, message: e.message }));
        }
        return err(e instanceof Error ? e.message : String(e));
      }
    }

    // ── getAudit ───────────────────────────────────────────
    case 'recued_peerAsk': {
      // ⚠ INSTRUMENTATION — the one fact no amount of reading alice's side can
      // establish: did the call ARRIVE.
      console.warn('[peer-ask:inbound] recued_peerAsk called');
      // D-234 § 234.4 — ⛔⛔ IDENTITY COMES FROM THE TRANSPORT, AND ONLY FROM
      // THERE. `buildMcpExecutionSource` reads the contract the caller actually
      // presented; the payload has no `peer_contract_id` field and must never
      // gain one, or a peer would be naming its own authorization and the
      // exposure check would be asking the attacker whether the attacker is in.
      const peerSource = buildMcpExecutionSource(deps);
      const peerContract = executionSourceContractId(peerSource) ?? '';
      if (peerContract === '') {
        return err(
          JSON.stringify({
            code: 'bad_request',
            message: 'recued_peerAsk: no bound contract on this call — a question must be attributable to a peer',
          }),
        );
      }
      // ⛔ THE CONTRACT GRANT IS THE RECEIVER'S OFF-SWITCH FOR THE DOOR ITSELF,
      // and it is a DIFFERENT question from exposure. Exposure says "this peer,
      // this label"; the grant says "this door, at all" — revoke it and no peer
      // reaches the ask surface regardless of what was offered. Every native
      // verb-op carries one (`core.audit.read` gates `recued_getAudit` the same
      // way), and omitting it here would make this the one native tool with no
      // contract-level control.
      //
      // ⚠ NOT a second PROMPT, so it does not reintroduce the double-ask § 234.4
      // removed: a grant is standing config the owner sets once, not a question
      // put to them per message.
      if (!resolveMcpDoorReadGrantChecker(deps).isVerbOpGranted('core.peer.receive-ask')) {
        return err(
          JSON.stringify({
            code: 'bad_request',
            message: 'recued_peerAsk: this door is not granted to your contract',
          }),
        );
      }
      // ⛔⛔ D-234 § 234.4n — THE WITHDRAWAL IS THE SAME DOOR, DISCRIMINATED ON
      // SHAPE. Owner's ruling, and it dissolved a bug rather than routing around
      // one: a separate `recued_peerWithdraw` tool needed its own per-token
      // checklist entry, no kernel op could name it (the join is op → ONE tool),
      // and the checklist therefore refused it for every peer, silently, BEFORE
      // any handler could log that it had been called. A second tool whose entire
      // authority is "the ask grant" is not a capability — it is the mistake
      // § 234.4j deleted three ops for, rebuilt one tool later.
      //
      // 🔑 EVERY GATE ABOVE ALREADY BRACKETS THIS. Same transport identity, same
      // door grant, same conversation. What it may do is narrower than an ask:
      // close a card THIS server holds, for THIS contract, under a ref THEY
      // opened. It cannot create anything.
      //
      // ⚠ BRANCHED BEFORE ASK VALIDATION, deliberately — a withdrawal carries no
      // question, no options and no label, and every one of those is required of
      // an ask. Validating first would refuse the shape for missing fields it was
      // never supposed to have.
      if (args.withdraw === true) {
        const wRef = typeof args.exchange_ref === 'string' ? args.exchange_ref : '';
        if (wRef === '') {
          return err(JSON.stringify({
            code: 'bad_request',
            message: 'recued_peerAsk: withdraw requires the exchange_ref being withdrawn',
          }));
        }
        const notifier = deps.preflightNotifier as unknown as {
          listOpenAsks?: () => Promise<{
            ask_id: string;
            handler_kind?: string;
            handler_payload?: Record<string, unknown>;
          }[]>;
          cancelAsk?: (ask_id: string) => Promise<'cancelled' | 'not_open'>;
        } | undefined;
        if (notifier?.listOpenAsks === undefined || notifier.cancelAsk === undefined) {
          return err('peer withdraw: no notification block on this host');
        }
        const { PEER_ASK_HANDLER_KIND: wKind } = await import('./peer-ask-receiver.js');
        const openAsks = await notifier.listOpenAsks();
        // ⛔ MATCH ON REF **AND** CONTRACT. A ref is a lookup key and never a
        // credential (§ 234.2), so ref alone would let a peer who learned one
        // close a card belonging to somebody else — invisibly, because a
        // cancelled ask leaves nothing behind to notice was missing.
        // ⚠ `handler_kind` / `handler_payload`, FLAT. The raise-side builds a
        // nested `handler: { kind, payload }` and `PendingAsk` persists it
        // flattened; copying the raise-side's spelling matches NOTHING and
        // answers "nothing to withdraw" for every call, with no error anywhere.
        const mine = openAsks.find((a) =>
          a.handler_kind === wKind
          && a.handler_payload?.exchange_ref === wRef
          && a.handler_payload.peer_contract_id === peerContract);
        console.warn(
          `[peer-withdraw:inbound] ref=${wRef.slice(0, 12)}… match=${String(mine !== undefined)}`
          + ` of ${String(openAsks.length)} open`,
        );
        // ⚠ ONE UNINFORMATIVE ANSWER FOR EVERY MISS — already answered, never
        // existed, someone else's, already withdrawn. Distinguishing them would
        // report on the owner's attention ("have they read it yet?"), which is a
        // surveillance channel dressed as a confirmation.
        const outcome = mine === undefined ? 'not_open' : await notifier.cancelAsk(mine.ask_id);
        if (outcome === 'cancelled' && deps.auditLog !== undefined) {
          void (deps.auditLog as unknown as { logActivity?: (r: unknown) => void })
            .logActivity?.({
              action: 'peer_ask_withdrawn',
              target: peerContract,
              detail: JSON.stringify({ exchange_ref: wRef }),
              timestamp: Date.now(),
            });
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ withdrawn: outcome === 'cancelled' }) }],
        };
      }
      if (!deps.db) return err('peer grant store not configured');
      const [
        { receivePeerAsk },
        { createContractStore },
        { createContractGrantEntryStore },
        { peerLabelGrantEntry },
      ] = await Promise.all([
        import('./peer-ask-inbound.js'),
        import('./storage/contract-store.js'),
        import('./storage/contract-grant-entry-store.js'),
        import('@recued/contracts'),
      ]);
      // D-234 § 234.4h/j — THE gate: the owner grants `peer.label.<label>` on the
      // peer's contract from the surface they already use to manage that peer. No
      // pack, no recipe, no second store to remember — § 234.4j deleted the
      // `peer_exposures` table that used to answer this same question in
      // parallel, because a flag saying "this peer, this label" beside a contract
      // that already says "this peer, this door" is the question asked twice.
      //
      // ⚠ KEYED ON THE CONTRACT THE CALLER PRESENTED, so the admission decision
      // and the identity it is about cannot come apart.
      const peerGrantEntries = createContractGrantEntryStore(createContractStore(deps.db));
      // ⚠ NO ADMISSION CEILING HERE, and that is not an omission. A native verb
      // is not a recipe dispatch, so § 234.1 never applies; the label grant is
      // the ONLY gate — one door rather than two with an exemption bridging them.
      // It is default-closed and per-(peer, label), which is narrower than the
      // ceiling it replaces.
      const received = await receivePeerAsk(
        {
          peer_contract_id: peerContract,
          connection_name: peerConnectionNameFor(deps, peerContract) ?? peerContract,
          exchange_ref: typeof args.exchange_ref === 'string' ? args.exchange_ref : '',
          label: typeof args.label === 'string' ? args.label : '',
          question: typeof args.question === 'string' ? args.question : '',
          options: Array.isArray(args.options)
            ? (args.options as { id: string; label: string }[])
            : [],
          ...(typeof args.deadline_at === 'number' ? { deadline_at: args.deadline_at } : {}),
          ...(typeof args.on_timeout === 'string' ? { on_timeout: args.on_timeout } : {}),
          ...(typeof args.note_prompt === 'string'
            ? { note_prompt: args.note_prompt }
            : {}),
          ...(typeof args.body === 'string' ? { body: args.body } : {}),
        },
        {
          isLabelGranted: (contract_id, label) =>
            peerGrantEntries.get(contract_id, peerLabelGrantEntry(label)) === true,
          notifier: deps.preflightNotifier as never,
          ...(deps.auditLog !== undefined
            ? {
                logActivity: (row: { action: string; target: string; detail: string }) => {
                  void (deps.auditLog as unknown as {
                    logActivity?: (r: unknown) => void;
                  }).logActivity?.({ ...row, timestamp: Date.now() });
                },
              }
            : {}),
        },
      );
      // ⚠ A REFUSAL IS A RESULT, NOT AN ERROR. § 30's lesson: a Recued receiver
      // reporting its own refusal through an error envelope is invisible to every
      // machine classifier on the far side, and the asker then reports `awaiting`
      // forever. The shape is the answer.
      // ⚠ A REFUSAL IS A RESULT, NOT AN ERROR ENVELOPE — see the note above.
      console.warn(`[peer-ask:inbound] ${JSON.stringify(received)}`);
      return { content: [{ type: 'text', text: JSON.stringify(received) }] };
    }
    // ── peerAnswer ─────────────────────────────────────────
    case PEER_RECEIVE_ANSWER_TOOL: {
      console.warn('[peer-answer:inbound] recued_peerAnswer called');
      // ⛔⛔ IDENTITY FROM THE TRANSPORT, AND ONLY THERE — the same rule as the
      // ask door, and load-bearing for the same reason: correlation is checked
      // against the contract the caller PRESENTED, so a payload field would let
      // a peer answer in someone else's name.
      const answerSource = buildMcpExecutionSource(deps);
      const answerContract = executionSourceContractId(answerSource) ?? '';
      if (answerContract === '') {
        return err(JSON.stringify({
          code: 'bad_request',
          message: 'recued_peerAnswer: no bound contract on this call — an answer must be attributable to a peer',
        }));
      }
      if (!resolveMcpDoorReadGrantChecker(deps).isVerbOpGranted('core.peer.receive-answer')) {
        return err(JSON.stringify({
          code: 'bad_request',
          message: 'recued_peerAnswer: this door is not granted to your contract',
        }));
      }
      if (!deps.db) return err('peer answer store not configured');
      if (deps.peerAskOutbox === undefined) {
        return err('peer ask outbox not configured — this server cannot correlate answers');
      }
      const [{ receiveAnswer }, { createPeerAnswerStore }, { resumePeerHold }] = await Promise.all([
        import('./peer-answer-return.js'),
        import('./storage/peer-answer-store.js'),
        import('./peer-hold-resumer.js'),
      ]);
      const outboxStore = deps.peerAskOutbox;
      const received = await receiveAnswer(
        { peer_contract_id: answerContract, exchange_ref: typeof args.exchange_ref === 'string' ? args.exchange_ref : '', raw: args },
        {
          outbox: outboxStore,
          answers: createPeerAnswerStore(deps.db),
          // ⚠ The INVERSE of the ask door's `peerConnectionNameFor`: there we ask
          // "which connection reaches this contract", here "which contract is
          // this connection bound to". Same `config.peer_contract_id` field,
          // read the other way, so the two can never disagree about a pairing.
          contractForConnection: (name) => {
            const store = deps.connectionStore as
              | { get?(kind: string, n: string): { config_json?: string | null } | null }
              | undefined;
            try {
              const row = store?.get?.('mcp', name) ?? null;
              if (row === null) return undefined;
              const cfg = JSON.parse(row.config_json ?? '{}') as Record<string, unknown>;
              return typeof cfg.peer_contract_id === 'string' ? cfg.peer_contract_id : undefined;
            } catch { return undefined; }
          },
          resume: async (row) => {
            await resumePeerHold(row, {
              getExecuteDeps: () => deps,
              auditLog: deps.auditLog!,
              checkpoints: deps.checkpointStore!,
            });
          },
          ...(deps.auditLog !== undefined
            ? {
                logActivity: (row: { action: string; target: string; detail: string }) => {
                  void (deps.auditLog as unknown as {
                    logActivity?: (r: unknown) => void;
                  }).logActivity?.({ ...row, timestamp: Date.now() });
                },
              }
            : {}),
        },
      );
      // ⚠ A REFUSAL IS A RESULT, NOT AN ERROR ENVELOPE — § 30, same as the ask
      // door. A peer whose answer was refused must be able to tell WHY
      // machine-readably; an error envelope makes "not yours" and "the server
      // fell over" the same fact, and they would retry forever on both.
      console.warn(`[peer-answer:inbound] ${JSON.stringify(received)}`);
      return { content: [{ type: 'text', text: JSON.stringify(received) }] };
    }
    case 'recued_getAudit': {
      if (!deps.auditLog) return err('Audit log not configured');
      // D-187 slice 3b — the audit/run-history read gate: the OWNER-default-only verb-op
      // `core.audit.read`. Run history reveals the owner's automation activity, so
      // a live door reads it ONLY if explicitly granted; the owner / owner's unbound MCP /
      // contract-free callers admit by default. No per-record entry term (it's a run list),
      // so the verb-op is the gate.
      if (!resolveMcpDoorReadGrantChecker(deps).isVerbOpGranted('core.audit.read')) {
        return err(
          JSON.stringify({
            code: 'bad_request',
            message: 'recued_getAudit: not read-granted to this contract (read rejected)',
          }),
        );
      }
      const limit = (args.limit as number) ?? 20;
      // D-232 § 20.9 — THE EXCHANGE QUERY. "What happened to it" is the one
      // thing a post office adds over a real letter, and the answer is a
      // filtered view of run history: the peer's inbound call, the answer's own
      // dispatch, and any hold in between are each a run here.
      //
      // ⛔ ON THE EXISTING TOOL AND THE EXISTING GATE, deliberately. A new
      // `exchange.*` read op would need its own grant, and a door granted run
      // history can already see every one of these rows — the filter narrows
      // what it returns, it does not widen what it may reach. A separate op
      // would have been a second name for the same authority.
      const entries = args.exchange_ref
        ? await deps.auditLog.listByExchangeRef(args.exchange_ref as string, limit)
        : args.peer_contract_id
          ? await deps.auditLog.listByPeerContract(args.peer_contract_id as string, limit)
          : args.recipe_id
            ? await deps.auditLog.listByRecipe(args.recipe_id as string, limit)
            : await deps.auditLog.listRecent(limit);
      return text(entries);
    }

    // ── dataTimeline ───────────────────────────────────────
    case 'recued_dataTimeline': {
      const entity_id = args.entity_id;
      if (typeof entity_id !== 'string' || entity_id.length === 0) {
        return err('entity_id is required');
      }
      const req: TimelineRequest = {
        entity_id,
        ...(typeof args.since === 'number' ? { since: args.since } : {}),
        ...(typeof args.until === 'number' ? { until: args.until } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
        // D-161 P3 — actor-lane filter passed through raw; `handleTimelineRequest`
        // sanitizes it (drops non-`Actor` members), so the cast is safe.
        ...(Array.isArray(args.origin_actors)
          ? { origin_actors: args.origin_actors as TimelineRequest['origin_actors'] }
          : {}),
      };
      // D-177 read-gate (N.12 read-side analog) — the timeline meta-tool is a
      // direct-return native tool that BYPASSES `evaluatePreflightAdmission`, so
      // it does not pick up the per-dispatch scope gate that fences ingredient
      // reads (`deriveDispatchScope` → `data.<collection>` → `scope_restrictions`).
      // Derive the readable-collection fence from the SAME effective
      // `scope_restrictions` axis — `resolveMcpDoorScopeRestrictions`, the one
      // seam `buildMcpContractSnapshot` also reads — so the meta-tool fence and
      // the ingredient-read fence can never diverge. EMPTY restrictions ⇒
      // admit-all (the established `evaluateScopeRestrictions` baseline).
      //
      // Posture (LIVE since 2026-06-12): owner consumers (stdio + the canonical
      // `client_tokens` `client_kind=cli` HTTP bearer) stay unbound ⇒ admit-all
      // (correct owner-trust — they read all their own data). EXTERNAL `recued_*`
      // door bearers ARE live (D-171 transport, wire-mcp-http-transport.ts):
      // the per-tool checklist (`inboundTokenAuthorize`, run at the top of
      // `handleToolCall`) is their fail-closed backstop — a door not granted
      // `recued_dataTimeline` can't reach this case — and the bound CONTRACT's
      // `data.<collection>` grant rows (the `#contracts` Entities tab →
      // `contract.grant.write`, slice 5) fence this read here. Vector search is a SEPARATE plane
      // (enrichment topics, gated by D-136 MCP visibility), not this raw-
      // collection fence — see `read-collection-grant.ts` module doc.
      const timelineDeps: TimelineDeps = {
        ...(deps.db ? { db: deps.db } : {}),
        ...(deps.auditLog ? { auditLog: deps.auditLog } : {}),
        ...(deps.annotationStore ? { annotationStore: deps.annotationStore } : {}),
        ...(deps.loadCollectionRecord
          ? { loadCollectionRecord: deps.loadCollectionRecord }
          : {}),
        ...(deps.enrichmentStore
          ? { enrichmentStore: deps.enrichmentStore }
          : {}),
        // D-187 AMENDMENT — the bound door contract's per-dispatch read-grant checker
        // (raw-collection AND enrichment-topic reads as unified contract_grant entries),
        // resolved off the bound contract. Replaces the retired visibility map +
        // `readableCollections` + `enrichmentScopeRestrictions` (all folded into the
        // checker: the scope-fence is the entry author-default, the grant rows overlay).
        readGrantChecker: resolveMcpDoorReadGrantChecker(deps),
        // P7.G — MCP-channel always applies the read-grant gate. Recipe-channel paths
        // set this per call based on `trigger_source`.
        gateMcpPrivate: true,
        // D-226 — what every installed pack declares about this identity,
        // computed from the pack's live rows. Read AFTER the whole-tool grant
        // fence inside `handleTimelineRequest`, so a door refused the feed is
        // refused the aggregate too.
        ...(deps.recordsStore
          ? { rollupsForEntity: (collection: string, id: string) =>
              collection === 'contact'
                ? readRootProjections(deps.recordsStore!, 'contact', id).map((projection) => ({
                    publisher: projection.publisher,
                    pack_slug: projection.pack_slug,
                    ...(projection.label === undefined ? {} : { label: projection.label }),
                    value: projection.value,
                    complete: projection.complete,
                    ...(projection.incomplete_reason === undefined
                      ? {}
                      : { incomplete_reason: projection.incomplete_reason }),
                  }))
                : [] }
          : {}),
      };
      try {
        const result = await handleTimelineRequest(timelineDeps, req);
        return text(result);
      } catch (e) {
        const { RpcError } = await import('@recued/contracts');
        if (e instanceof RpcError) {
          return err(JSON.stringify({ code: e.code, message: e.message }));
        }
        return err(e instanceof Error ? e.message : String(e));
      }
    }

    // ── D-139 P5 — contactEngagementsList ──────────────────
    case 'recued_contactEngagementsList': {
      if (!deps.engagementsResolveDeps) {
        return err('Engagement resolver not configured on this server');
      }
      try {
        // D-139 P6.B — body-content gate. Server-scoped: a pack install
        // (e.g. `crm-commitment-tracker`) grants the registry key into the
        // body-visibility store; without a wired store / granting pack the
        // body stays stripped (the per-tool checklist above already gated
        // whether this door reaches the tool at all).
        const body_content_granted =
          deps.mcpBodyVisibilityStore?.isGranted(
            ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY,
          ) ?? false;
        const result = handleContactEngagementsList(
          deps.engagementsResolveDeps,
          args,
          {
            body_content_granted,
            // D-187 slice 3b — the bound door's read-grant checker gates the
            // `core.contact.engagements.read` verb-op (OWNER-default-only) ∧ the
            // `data.contact` collection, off the bound contract.
            readGrantChecker: resolveMcpDoorReadGrantChecker(deps),
          },
        );
        return text(result);
      } catch (e) {
        const { RpcError } = await import('@recued/contracts');
        if (e instanceof RpcError) {
          return err(JSON.stringify({ code: e.code, message: e.message }));
        }
        return err(e instanceof Error ? e.message : String(e));
      }
    }

    // ── D-136 §A.13.1 P7.D — registryDescribe ──────────────
    case 'recued_registryDescribe': {
      const producerTopics = collectRegisteredProducerTopics(listHousekeepingTasks());
      const rdDeps: RegistryDescribeDeps = {
        ...(deps.enrichmentStore ? { enrichmentStore: deps.enrichmentStore } : {}),
        ...(deps.housekeepingStateStore
          ? { housekeepingStateStore: deps.housekeepingStateStore }
          : {}),
        ...(deps.db ? { db: deps.db } : {}),
        // D-187 AMENDMENT — the bound door contract's per-dispatch read-grant checker.
        // The agent catalog lists exactly the topics the bound contract is read-granted
        // (the checker folds the former `mcp_exposed` visibility AND the per-topic scope
        // fence into one grant lookup); replaces the retired visibility map +
        // `enrichmentScopeRestrictions`.
        readGrantChecker: resolveMcpDoorReadGrantChecker(deps),
        // M-ENRICH (internal planning notes) — exclude enrichment topics
        // that have no registered producer AND no agent-readable rows from
        // the agent-facing catalog, so an external agent is never told it
        // can read / compute an enrichment that nothing produces. Sourced
        // from the live housekeeping registry at call time (the set
        // reflects dynamic register / unregister, e.g. vendor reconcilers).
        //
        // Passed ONLY when non-empty — fail OPEN otherwise. The serve
        // runtime exposes the MCP listener (start-listener-exposure-
        // runtime) BEFORE it registers housekeeping producers (start-post-
        // listener-runtime), and MCP-dispatch unit tests don't populate the
        // registry; an empty roster in those windows would wrongly prune
        // every zero-row LIVE topic. Skipping the dep (no filter) until the
        // roster is populated keeps the pre-M-ENRICH catalog instead. The
        // Settings-UI proxy (`handleHousekeepingRegistryDescribe`)
        // deliberately omits this so the human configuring the warehouse
        // still sees every topic, dead or alive.
        ...(producerTopics.size > 0 ? { registeredProducerTopics: producerTopics } : {}),
      };
      try {
        const result = handleRegistryDescribe(rdDeps);
        return text(result);
      } catch (e) {
        const { RpcError } = await import('@recued/contracts');
        if (e instanceof RpcError) {
          return err(JSON.stringify({ code: e.code, message: e.message }));
        }
        return err(e instanceof Error ? e.message : String(e));
      }
    }

    // ── D-136 §A.13.3 P7.D — enrichmentRead ────────────────
    case 'recued_enrichmentRead': {
      if (!deps.enrichmentStore) return err('Enrichment store not configured on this server');
      const req: EnrichmentReadRpcInput = {
        topic: args.topic as string,
        ...(typeof args.scope === 'string' ? { scope: args.scope } : {}),
        ...(typeof args.target_id === 'string' ? { target_id: args.target_id } : {}),
        ...(typeof args.derived_entity_id === 'string'
          ? { derived_entity_id: args.derived_entity_id }
          : {}),
        ...(typeof args.authored_by === 'string' ? { authored_by: args.authored_by } : {}),
        ...(typeof args.as_of === 'number' ? { as_of: args.as_of } : {}),
        ...(typeof args.coherent_at === 'number' ? { coherent_at: args.coherent_at } : {}),
        ...(typeof args.include_historical === 'boolean'
          ? { include_historical: args.include_historical }
          : {}),
        ...(typeof args.include_stale === 'boolean'
          ? { include_stale: args.include_stale }
          : {}),
        // P7.F §A.14.5 — copy freshness_budget_ms when provided so the
        // tool surfaces the fall-through gate. Only forward finite +
        // non-negative numbers; negative / NaN / Infinity is dropped so
        // a malformed caller doesn't fall through every read.
        ...(typeof args.freshness_budget_ms === 'number'
          && Number.isFinite(args.freshness_budget_ms)
          && args.freshness_budget_ms >= 0
          ? { freshness_budget_ms: args.freshness_budget_ms }
          : {}),
      };
      const erDeps: EnrichmentReadDeps = {
        enrichmentStore: deps.enrichmentStore,
        // D-187 AMENDMENT — the bound door contract's read-grant checker. The handler's
        // `validateInput` rejects a topic the contract isn't read-granted (the checker
        // folds the former per-topic scope-fence — `topic_not_in_door_scope` — AND the
        // `mcp_exposed` visibility into one grant lookup, BEFORE any store read).
        readGrantChecker: resolveMcpDoorReadGrantChecker(deps),
      };
      try {
        const result = handleEnrichmentRead(erDeps, req);
        return text(result);
      } catch (e) {
        const { RpcError } = await import('@recued/contracts');
        if (e instanceof RpcError) {
          return err(JSON.stringify({ code: e.code, message: e.message }));
        }
        return err(e instanceof Error ? e.message : String(e));
      }
    }

    // ── D-136 §A.13.4 P7.D — vectorSimilaritySearch ────────
    case 'recued_vectorSimilaritySearch': {
      if (!deps.enrichmentStore) return err('Enrichment store not configured on this server');
      if (!deps.db) return err('Database handle not configured on this server');
      const req: VectorSimilaritySearchRpcInput = {
        query_vector: Array.isArray(args.query_vector)
          ? (args.query_vector as number[])
          : [],
        topic: args.topic as string,
        limit: args.limit as number,
        ...(typeof args.scope_filter === 'string'
          ? { scope_filter: args.scope_filter }
          : {}),
        ...(typeof args.model_id === 'string' ? { model_id: args.model_id } : {}),
        ...(typeof args.similarity_threshold === 'number'
          ? { similarity_threshold: args.similarity_threshold }
          : {}),
      };
      const vsDeps: VectorSimilarityDeps = {
        enrichmentStore: deps.enrichmentStore,
        db: deps.db,
        ...(typeof deps.vectorSearchMaxResults === 'number'
          ? { vectorSearchMaxResults: deps.vectorSearchMaxResults }
          : {}),
        // D-187 AMENDMENT — the bound door contract's read-grant checker. The handler's
        // `validateInput` rejects a topic the contract isn't read-granted (the checker
        // folds the former per-topic scope-fence — `topic_not_in_door_scope` — AND the
        // `mcp_exposed` visibility into one grant lookup, BEFORE any store read).
        readGrantChecker: resolveMcpDoorReadGrantChecker(deps),
      };
      try {
        const result = handleVectorSimilaritySearch(vsDeps, req);
        return text(result);
      } catch (e) {
        const { RpcError } = await import('@recued/contracts');
        if (e instanceof RpcError) {
          return err(JSON.stringify({ code: e.code, message: e.message }));
        }
        return err(e instanceof Error ? e.message : String(e));
      }
    }

    // ── saveRecipe ─────────────────────────────────────────
    case 'recued_saveRecipe': {
      const recipe = args.recipe as { recipe_id?: string; version?: number; metadata?: { name?: string } } | undefined;
      if (!recipe || typeof recipe !== 'object') return err('recipe is required');
      if (!recipe.recipe_id || typeof recipe.recipe_id !== 'string') {
        return err('recipe.recipe_id is required');
      }

      // Validate against the recipe schema before accepting
      const { parseRecipe } = await import('@recued/recipes');
      const parsed = parseRecipe(recipe as import('@recued/contracts').RecipeDefinition);
      if (!parsed.ok) {
        const errs = parsed.issues
          .filter((i: { severity: string }) => i.severity === 'error')
          .map((i: { path?: string; message: string }) => `${i.path ?? '<root>'}: ${i.message}`);
        if (errs.length) {
          return err(`Recipe validation failed:\n${errs.join('\n')}`);
        }
      }

      const recipeDefinition = recipe as import('@recued/contracts').RecipeDefinition;
      const existingRecipe = deps.recipeStore.get(recipe.recipe_id);
      if (hasNonEmptyWebhookDeclarations(recipeDefinition)
        || (existingRecipe !== null
          && hasNonEmptyWebhookDeclarations(existingRecipe))) {
        return err(D201_WEBHOOK_RUNTIME_UNAVAILABLE);
      }

      // D-182 — op-step recipes ARE accepted inline: the dispatch path
      // (`resolveCanonicalRecipeForDispatch`) lowers + runs an inline, never-
      // installed op-step recipe (kernel ops self-contained, Tier-P against the
      // installed-pack universe, CRM ops once a connection slot binds at run), so
      // persisting one is no longer storing "an unrunnable recipe". The only
      // definitively-unrunnable case is an unregistered closed-kind kernel op —
      // reject exactly that; an uncovered Tier-P `depends_on` surfaces as a
      // non-blocking `op_warnings` advisory. Mirrors the local `recipe.save` seam.
      const { checkInlineOpSteps } = await import('./op-step-save-check.js');
      const opCheck = checkInlineOpSteps(
        recipeDefinition,
      );
      if (opCheck.errors.length > 0) {
        return err(`Recipe op-step validation failed:\n${opCheck.errors.join('\n')}`);
      }

      // D-220 — the form-field contract, via the SAME implementation the
      // `recipe.save` rpc uses. This call site is the one finding 3.2 named: the
      // comment above claimed to mirror the local seam, and did not.
      const formContract = checkFormContract(
        deps.formDefinitionReader,
        recipeDefinition,
        'recued_saveRecipe',
      );
      if (formContract.kind !== 'ok') return err(formContract.message);

      const publisher = (args.publisher_id as string) ?? 'mcp';
      deps.recipeStore.save(
        recipeDefinition,
        publisher,
        'inline',
      );
      // § 7 surfacing — disclose the saved recipe's PII posture in the tool
      // result so the authoring agent learns it at the save boundary: which
      // AI steps Recued auto-protects at run time (do NOT re-author those)
      // and which still leak identifiers (actionable hints name the exact
      // paths + kinds — never values). Omitted when there is nothing to
      // disclose; assessment is fail-safe (never blocks the save result).
      const { assessRecipePiiPosture } = await import('./auto-pii-apply.js');
      const pii = assessRecipePiiPosture(recipe);
      return text({
        saved: true,
        recipe_id: recipe.recipe_id,
        version: recipe.version ?? 1,
        name: recipe.metadata?.name ?? recipe.recipe_id,
        note: 'The paired Recued extension will see this on its next pair-sync and offer to keep it.',
        ...(opCheck.warnings.length > 0 ? { op_warnings: opCheck.warnings } : {}),
        ...(pii !== null
          ? {
              pii: {
                ...(pii.headline !== '' ? { headline: pii.headline } : {}),
                ...(pii.auto_protected.length > 0
                  ? { auto_protected: pii.auto_protected.map((l) => l.message) }
                  : {}),
                ...(pii.warnings.length > 0
                  ? { warnings: pii.warnings.map((l) => l.message) }
                  : {}),
                ...(pii.infos.length > 0
                  ? { infos: pii.infos.map((l) => l.message) }
                  : {}),
              },
            }
          : {}),
      });
    }

    default:
      throw new Error(`Unknown tool: ${params.name}`);
  }
};

// ────────────────────────────────────────────────────────────────
// JSON-RPC dispatch
// ────────────────────────────────────────────────────────────────

const dispatch = async (
  msg: unknown,
  deps: McpDeps,
): Promise<JsonRpcResponse | null> => {
  // Codex P2 #2 fold — JSON-RPC 2.0 § 4.1 "Invalid Request" gate.
  // Valid JSON that parses to non-object shapes (null, primitives,
  // arrays) reached `msg.id` previously and crashed up to the
  // transport as an unhandled exception (HTTP 500 / stdio process
  // exit). Reject with `-32600` here so every transport surfaces the
  // protocol error uniformly. Batch arrays are NOT supported (one
  // envelope ⇒ one response is the implementation invariant).
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    };
  }
  const request = msg as JsonRpcRequest;
  const id = request.id ?? null;

  try {
    switch (request.method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: handleInitialize(deps) };

      case 'notifications/initialized':
        // Client acknowledgement — no response needed
        return null;

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: await handleToolsList(deps) };

      case 'tools/call': {
        const rawParams = request.params;
        if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
          return { jsonrpc: '2.0', id, result: err('tools/call params must be an object.') };
        }
        const params = rawParams as {
          name?: unknown;
          arguments?: unknown;
        };
        if (typeof params.name !== 'string' || params.name.length === 0) {
          return { jsonrpc: '2.0', id, result: err('tools/call params.name is required.') };
        }
        if (
          params.arguments !== undefined
          && (
            params.arguments === null
            || typeof params.arguments !== 'object'
            || Array.isArray(params.arguments)
          )
        ) {
          return {
            jsonrpc: '2.0',
            id,
            result: err('tools/call params.arguments must be an object when present.'),
          };
        }
        const callParams = params as {
          name: string;
          arguments?: Record<string, unknown>;
        };
        const usagePreflight = deps.customerUsage
          ? preflightMcpCustomerUsage(callParams, deps)
          : { ok: true as const, usage: null, deferReservation: false };
        if (!usagePreflight.ok) {
          return { jsonrpc: '2.0', id, result: usagePreflight.result };
        }
        if (
          deps.customerUsage
          && usagePreflight.usage
          && !usagePreflight.deferReservation
        ) {
          const admission = deps.customerUsage.reserveOnce(
            DIRECT_MCP_TOOL_CALL_BASE_RESERVATION_KEY,
            usagePreflight.usage,
          );
          if (!admission.admitted) {
            return {
              jsonrpc: '2.0',
              id,
              result: err(
                admission.message
                  ?? 'This customer has exceeded the seller usage policy for tool calls.',
              ),
            };
          }
        }
        let result: unknown;
        try {
          result = await handleToolCall(callParams, deps);
        } catch (error) {
          deps.customerUsage?.release();
          throw error;
        }
        const usageDenial = deps.customerUsage?.denialMessage();
        if (usageDenial !== undefined) {
          deps.customerUsage!.release();
          return { jsonrpc: '2.0', id, result: err(usageDenial) };
        }
        if (deps.customerUsage && usagePreflight.usage) {
          if (!isBillableMcpToolResult(result)) {
            deps.customerUsage.release();
            return { jsonrpc: '2.0', id, result };
          }
          if (usagePreflight.deferReservation) {
            // A successful execute-backed call with no actual dispatch still
            // consumes the ordinary base unit. An actual dispatch claims the
            // key at its post-approval seam; an empty D-162 batch claims it as
            // an explicit zero-unit N=0 result.
            if (!deps.customerUsage.hasReservationKey(
              DIRECT_MCP_TOOL_CALL_BASE_RESERVATION_KEY,
            )) {
              const admission = deps.customerUsage.reserveOnce(
                DIRECT_MCP_TOOL_CALL_BASE_RESERVATION_KEY,
                usagePreflight.usage,
              );
              if (!admission.admitted) {
                deps.customerUsage.release();
                return { jsonrpc: '2.0', id, result: err(admission.message) };
              }
            }
          }
          try {
            deps.customerUsage.commit();
          } catch (error) {
            console.warn(
              `[mcp] seller customer usage rollup failed for ${usagePreflight.usage.tool_name}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        return { jsonrpc: '2.0', id, result };
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
    }
  } catch (e) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
};

// ────────────────────────────────────────────────────────────────
// HTTP transport dispatch wrapper (D-137 P1 follow-on)
// ────────────────────────────────────────────────────────────────

/** Derive a stable per-token id from a bearer string. SHA-256 → first
 *  16 hex chars, prefixed `http_` so audit + transparency surfaces can
 *  distinguish HTTP transport tokens from the `STDIO_MCP_TOKEN_ID`
 *  synthetic. The hash never round-trips back to the raw token — only
 *  the derived id reaches `InternalToolRegistry`'s channel-isolation
 *  guard and the per-tool audit row. */
const deriveMcpTokenId = (token: string): string =>
  `http_${createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16)}`;

/** D-137 P1 follow-on — HTTP MCP transport dispatch wrapper.
 *
 *  The HTTP port handler at `ports/mcp/handler.ts` validates the
 *  bearer token + rate-limits the call, then hands the validated
 *  token through to this closure. We fold the token into a per-call
 *  `McpDeps` overlay so the registry adapter / audit emission see
 *  a stable `mcp_token_id` derived from the bearer rather than the
 *  stdio synthetic.
 *
 *  The base `deps` are shared across requests (same shape that
 *  `startMCPServer` consumes for stdio); only `mcpTokenId` is
 *  overridden per-call. Token absence falls back to the stdio
 *  synthetic so a misconfigured handler still type-checks instead
 *  of poisoning the registry guard. */
export const createMcpHttpDispatch = (
  deps: McpDeps,
): ((envelope: unknown, token?: string) => Promise<unknown | null>) => {
  return async (envelope: unknown, token?: string) => {
    // `dispatch` validates the envelope shape (Codex P2 #2 fold) so we
    // forward the raw value — non-object envelopes surface as JSON-RPC
    // `-32600 Invalid Request` instead of throwing up the transport.
    const perCallDeps: McpDeps = token && token.length > 0
      ? { ...deps, mcpTokenId: deriveMcpTokenId(token) }
      : deps;
    return dispatch(envelope, perCallDeps);
  };
};

// ────────────────────────────────────────────────────────────────
// Stdio transport
// ────────────────────────────────────────────────────────────────

/** Start the MCP server reading JSON-RPC from stdin, writing to stdout.
 *  Returns a cleanup function. */
export const startMCPServer = (deps: McpDeps): { close: () => void } => {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const stdioDeps: McpDeps = {
    ...deps,
    mcpActionNotifications: true,
    mcpRecipeCallbackNotifications: true,
  };

  const send = (message: JsonRpcResponse | JsonRpcNotification): void => {
    process.stdout.write(JSON.stringify(message) + '\n');
  };

  const sendRecipeCallback = (
    params: McpRecipeCallbackNotificationParams,
  ): Promise<void> => new Promise((resolve, reject) => {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: MCP_RECIPE_CALLBACK_NOTIFICATION_METHOD,
        params,
      }) + '\n',
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });

  // Recipe callbacks are durable coalescing pointers in the shared store. The
  // watcher exists only for a contract-bearing stdio token with a fresh
  // authorization resolver; stateless HTTP never advertises or starts it.
  const recipeCallbackWatcher =
    stdioDeps.sharedStore
    && stdioDeps.mcpTokenId
    && stdioDeps.mcpRecipeCallbackAuthorize
      ? createMcpRecipeCallbackWatcher({
          store: stdioDeps.sharedStore,
          token_id: stdioDeps.mcpTokenId,
          authorize: stdioDeps.mcpRecipeCallbackAuthorize,
          send: sendRecipeCallback,
        })
      : undefined;
  let recipeCallbackPollPromise: Promise<void> | undefined;
  const pollRecipeCallbacks = async (): Promise<void> => {
    if (!recipeCallbackWatcher) return;
    if (recipeCallbackPollPromise) return recipeCallbackPollPromise;
    recipeCallbackPollPromise = recipeCallbackWatcher.poll()
      .catch((error) => {
        console.error(
          '[mcp] recipe-callback notification poll failed: '
            + (error instanceof Error ? error.message : String(error)),
        );
      })
      .finally(() => {
        recipeCallbackPollPromise = undefined;
      });
    return recipeCallbackPollPromise;
  };
  const recipeCallbackPollTimer = recipeCallbackWatcher
    ? setInterval(() => { void pollRecipeCallbacks(); }, 1_000)
    : undefined;
  recipeCallbackPollTimer?.unref();
  if (recipeCallbackWatcher) void pollRecipeCallbacks();

  // The standalone stdio profile and the main server are separate processes
  // sharing WAL-backed SQLite. Subscribe catches same-process transitions;
  // polling catches the main server settling an approval in another process.
  // Revisions dedupe the two paths, and first observation of a newly-created
  // waiting action is silent because the tools/call response already carried it.
  const actionPrincipal = mcpActionPrincipalId(stdioDeps);
  const actionWatcherStartedAt = Date.now();
  const seenActionRevisions = new Map<string, number>();
  const pendingActionNotifications = new Map<string, McpActionRecord>();
  let actionNotificationsReady = false;
  const sendActionStatus = (record: McpActionRecord): void => {
    send({
      jsonrpc: '2.0',
      method: MCP_ACTION_NOTIFICATION_METHOD,
      params: {
        ...projectMcpActionPublicState(record, { includeResult: false }),
        query_tool: MCP_ACTION_STATUS_TOOL_NAME,
      },
    });
  };
  const emitActionStatus = (record: McpActionRecord): void => {
    if (record.principal_id !== actionPrincipal) return;
    const seen = seenActionRevisions.get(record.action_ref) ?? 0;
    if (record.revision <= seen) return;
    seenActionRevisions.set(record.action_ref, record.revision);
    if (!actionNotificationsReady) {
      pendingActionNotifications.set(record.action_ref, record);
      return;
    }
    sendActionStatus(record);
  };
  const unsubscribeAction = stdioDeps.mcpActionStore?.subscribe((event) => {
    const { record } = event;
    if (record.principal_id !== actionPrincipal) return;
    if (event.kind === 'created') {
      seenActionRevisions.set(record.action_ref, record.revision);
      return;
    }
    emitActionStatus(record);
  });
  let actionPollInFlight = false;
  let initialActionScanComplete = false;
  const pollActions = async (): Promise<void> => {
    if (!stdioDeps.mcpActionStore || actionPollInFlight) return;
    actionPollInFlight = true;
    try {
      if (!initialActionScanComplete) {
        // One startup scan adopts continuations from a prior MCP process. New
        // calls in this process are tracked by the store subscription below;
        // subsequent polls use keyed reads instead of scanning the full table.
        for (const observed of await stdioDeps.mcpActionStore.listOwned(actionPrincipal)) {
          const record = await reconcileMcpAction(stdioDeps, observed);
          const seen = seenActionRevisions.get(record.action_ref);
          if (seen === undefined) {
            if (
              record.revision > 1
              && record.updated_at >= actionWatcherStartedAt
            ) {
              emitActionStatus(record);
            } else {
              seenActionRevisions.set(record.action_ref, record.revision);
            }
            continue;
          }
          emitActionStatus(record);
        }
        initialActionScanComplete = true;
        return;
      }
      for (const actionRef of [...seenActionRevisions.keys()]) {
        const observed = await stdioDeps.mcpActionStore.getOwned(
          actionRef,
          actionPrincipal,
        );
        if (observed === null) {
          seenActionRevisions.delete(actionRef);
          pendingActionNotifications.delete(actionRef);
          continue;
        }
        const record = await reconcileMcpAction(stdioDeps, observed);
        emitActionStatus(record);
      }
    } catch (error) {
      console.error(
        '[mcp] async-action notification poll failed: '
          + (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      actionPollInFlight = false;
    }
  };
  const actionPollTimer = stdioDeps.mcpActionStore
    ? setInterval(() => { void pollActions(); }, 1_000)
    : undefined;
  actionPollTimer?.unref();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    const response = await dispatch(msg, stdioDeps);
    if (response) send(response);
    if (
      typeof msg === 'object'
      && msg !== null
      && !Array.isArray(msg)
      && (msg as { method?: unknown }).method === 'notifications/initialized'
    ) {
      actionNotificationsReady = true;
      for (const record of pendingActionNotifications.values()) {
        sendActionStatus(record);
      }
      pendingActionNotifications.clear();
      recipeCallbackWatcher?.setReady();
      if (recipeCallbackWatcher) void pollRecipeCallbacks();
    }
  });

  let closePromise: Promise<void> | undefined;
  const drainAndClose = (): Promise<void> => {
    if (closePromise) return closePromise;
    if (actionPollTimer !== undefined) clearInterval(actionPollTimer);
    if (recipeCallbackPollTimer !== undefined) clearInterval(recipeCallbackPollTimer);
    unsubscribeAction?.();
    closePromise = Promise.allSettled([
      ...(recipeCallbackPollPromise ? [recipeCallbackPollPromise] : []),
      ...(stdioDeps.mcpShutdownDrain
        ? [Promise.resolve().then(() => stdioDeps.mcpShutdownDrain?.())]
        : []),
    ]).then(() => undefined);
    return closePromise;
  };

  rl.on('close', () => {
    void drainAndClose().finally(() => process.exit(0));
  });

  return {
    close: () => {
      void drainAndClose();
      rl.close();
    },
  };
};
