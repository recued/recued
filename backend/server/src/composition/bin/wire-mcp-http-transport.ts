/** HTTP MCP transport composer.
 *
 *  Builds the `mcpHttpDeps` shape `startServer` consumes when the
 *  operator wires the HTTP MCP transport. Two bearer families are
 *  accepted, discriminated by shape (they cannot collide — one always
 *  contains a `.`, the other never does):
 *
 *  - Canonical structured `<token_id>.<bearer>` (the same shape WS
 *    clients carry), verified against the durable `client_tokens`
 *    table. MCP is an operator/CLI ingress surface, so only
 *    `client_kind: 'cli'` tokens are accepted here; webclient and
 *    bridge tokens remain valid for WS but cannot be replayed against
 *    the MCP port. Owner identity — admit-all, no contract binding.
 *
 *  - D-171 external-door inbound tokens `recued_<base64url>` (no `.`),
 *    verified against the `chat_inbound_tokens` table. These carry the
 *    door's per-tool `grants` checklist (installed as the
 *    `inboundTokenAuthorize` gate) and, when the door has a cap/expiry
 *    envelope, the bound minted contract (`contract_id` → D-166 P2
 *    `boundContractId` + a live `boundContractActive` kill-switch
 *    probe via `contractOverlay.isContractLive`). This is the seam
 *    that makes the D-177 read fence + `.<contract_id>` policy
 *    overlays observable on a real external consumer.
 *
 *  Raw opaque bearers outside both families, old
 *  `RECUED_MCP_HTTP_TOKEN` values, and off-shape probes return 401 at
 *  the port handler. */

import {
  isMcpInboundTokenToolAuthorized,
  isMcpInboundTokenActive,
  MCP_INBOUND_TOKEN_PREFIX,
  type InternalToolRegistry,
  type McpInboundTokenRecord,
} from '@recued/contracts';
import type { ExecuteHandlerDeps } from '../../execute-handler.js';
import type { VaultStore } from '@recued/storage';
import type { HousekeepingStateStore } from '../../housekeeping/index.js';
import type { ClientTokenRecord, ClientTokenStore } from '../../pairing/client-tokens.js';
import type { ChatInboundTokenStore } from '../../storage/chat-inbound-token-store.js';
import type { McpBodyVisibilityStore } from '../../storage/mcp-body-visibility-store.js';
import type {
  McpBearerVerifier,
  McpConcurrencyLimitResolver,
  McpDispatch,
} from '../../ports/mcp/handler.js';
import type { FormDefinitionReader } from '../../form-contract-gate.js';
import { createMcpHttpDispatch, type McpDeps } from '../../mcp-server.js';
import type { LoadCollectionRecord } from '../../mcp/timeline.js';
import type { ContactEngagementsResolveDeps } from '../../contact-engagements-rpc-handler.js';
import {
  evaluateSellerCustomerAccessAdmission,
  type SellerCustomerAccessAdmissionResult,
  type SellerCustomerAccessAdmissionStore,
} from '../../seller/customer-access-admission.js';
import {
  createSellerCustomerUsageGate,
  type SellerCustomerUsageStore,
} from '../../seller/customer-usage-policy.js';
import {
  createCustomerSurfaceUsagePendingCoordinator,
  createCustomerSurfaceUsageSession,
} from '../../seller/customer-surface-usage.js';
import {
  createSellerCustomerStatusResolver,
} from '../../seller/customer-status.js';
import { parseStructuredBearer } from '../../ws-server.js';

/** Inputs. Backing deps mirror the serve-context refs. */
export interface ComposeMcpHttpTransportDeps {
  readonly executeDeps: ExecuteHandlerDeps;
  readonly vaultStore: VaultStore | undefined;
  readonly housekeepingStateStore: HousekeepingStateStore | undefined;
  /** D-236 join — scope→source-freshness thunk for `registryDescribe`'s
   *  coverage-band cap. Built at the caller from the CollectionRegistry
   *  (same pattern as the timeline's file raw-record loader). */
  readonly sourceFreshnessByScope?: McpDeps['sourceFreshnessByScope'];
  readonly internalRegistry: InternalToolRegistry | undefined;
  readonly clientTokens: Pick<ClientTokenStore, 'verify' | 'touch'> | undefined;
  /** D-171 external-door token store. Absent ⇒ door bearers are
   *  rejected (canonical CLI bearers only — pre-D-171 behavior). */
  readonly inboundTokenStore: Pick<ChatInboundTokenStore, 'verifyBearer'> | undefined;
  /** D-196 seller-customer admission. Present on production DB-backed boots;
   *  absent on legacy / dbless harnesses, where ordinary inbound-token semantics
   *  remain unchanged while an authoritatively classified customer instance
   *  fails closed. */
  readonly sellerStore?: SellerCustomerAccessAdmissionStore & SellerCustomerUsageStore;
  /** D-220 — the live intake-form reader, so `recued_saveRecipe` is gated by the
   *  SAME form-field contract as the `recipe.save` rpc. Absent ⇒ inert gate. */
  readonly formDefinitionReader?: FormDefinitionReader;
  /** D-139 P5 — engagement-evidence resolver bundle for the
   *  `recued_contactEngagementsList` MCP read. Optional/absent ⇒ the tool
   *  returns "not configured" (db-less harness / no engagement+contact
   *  stores). Per-token tool checklist gates access (default-off). */
  readonly engagementsResolveDeps?: ContactEngagementsResolveDeps;
  /** D-139 P6.B — server-scoped body-content visibility grant store.
   *  When wired + a granting pack (`crm-commitment-tracker`) is installed,
   *  `recued_contactEngagementsList` inlines engagement body content
   *  instead of stripping it. Absent ⇒ body stays stripped. */
  readonly mcpBodyVisibilityStore?: McpBodyVisibilityStore;
  /** D-192 Fork B (B3) — the `data.timeline` raw-record loader for the `file`
   *  collection (built at the caller from the registry + remote meta-store), so
   *  MCP `recued_dataTimeline` surfaces a file's metadata for the AI. Absent ⇒
   *  the file raw-record source stays unwired (unchanged). The timeline's own
   *  D-187 read-grant gate still fences it — a caller needs a `file` collection
   *  grant to see the record. */
  readonly loadCollectionRecord?: LoadCollectionRecord;
  /** Vault-lock gate. When the server vault is LOCKED (enrolled but the Master
   *  DEK is not in memory — keyfile auto-unlock failed / awaiting the recovery
   *  key), MCP `tools/call` is refused so no MCP-driven side effect fires while
   *  the server is sealed — matching every autonomous executor's
   *  pause-while-locked contract (`vault-gated-executors.ts`). `initialize` /
   *  `tools/list` stay open so a client can still connect + discover. Absent
   *  (dbless / test harness — no vault to seal) ⇒ no gate; production wires
   *  `app.isVaultUnlocked`. */
  readonly isVaultUnlocked?: () => boolean;
}

/** Bundle. `logBootBanner` is a no-op when transport is disabled (helper
 *  returns undefined in that case); otherwise it logs the variant
 *  banner exactly once. Caller invokes it after the rest of the boot
 *  sequence so the line appears alongside the other "listening on" /
 *  "scheduler started" lines. */
export interface McpHttpTransportBundle {
  readonly mcpHttpDeps: {
    readonly verifier: McpBearerVerifier;
    readonly dispatch: McpDispatch;
    readonly resolveConcurrencyLimit: McpConcurrencyLimitResolver;
  };
  readonly logBootBanner: () => void;
}

/** Extract the JSON-RPC `id` from a request envelope for a server-defined error
 *  response — the envelope's `id` when it is a request-shaped object carrying a
 *  string / number / null id, else `null` (per JSON-RPC, the response to an
 *  unparseable or notification-shaped message carries a null id). Shared by the
 *  dispatch closure's two `-32001` rejections (token-state-changed +
 *  the D-187 §6 door-type gate). */
const envelopeId = (envelope: unknown): string | number | null => {
  if (
    envelope
    && typeof envelope === 'object'
    && !Array.isArray(envelope)
    && 'id' in envelope
  ) {
    const id = (envelope as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number' || id === null) return id;
  }
  return null;
};

/** The JSON-RPC `method` of a request envelope, or undefined when the envelope
 *  is not a method-shaped object. The vault-lock gate uses it to fence
 *  `tools/call` (execution) while leaving `initialize` / `tools/list` open. */
const envelopeMethod = (envelope: unknown): string | undefined => {
  if (
    envelope
    && typeof envelope === 'object'
    && !Array.isArray(envelope)
    && 'method' in envelope
  ) {
    const method = (envelope as { method?: unknown }).method;
    if (typeof method === 'string') return method;
  }
  return undefined;
};

/** Compose the HTTP MCP transport's `verifier` + `dispatch` closures.
 *  Returns `undefined` when both bearer sources are inactive — caller
 *  spreads `{}` into the handler-set args and the transport stays off. */
export const composeMcpHttpTransport = (
  deps: ComposeMcpHttpTransportDeps,
): McpHttpTransportBundle | undefined => {
  if (!deps.clientTokens && !deps.inboundTokenStore) {
    return undefined;
  }

  const baseMcpDeps: McpDeps = {
    ...deps.executeDeps,
    ...(deps.vaultStore ? { vaultStore: deps.vaultStore } : {}),
    ...(deps.housekeepingStateStore
      ? { housekeepingStateStore: deps.housekeepingStateStore }
      : {}),
    ...(deps.internalRegistry
      ? { internalRegistry: deps.internalRegistry }
      : {}),
    ...(deps.sourceFreshnessByScope
      ? { sourceFreshnessByScope: deps.sourceFreshnessByScope }
      : {}),
    ...(deps.engagementsResolveDeps
      ? { engagementsResolveDeps: deps.engagementsResolveDeps }
      : {}),
    ...(deps.mcpBodyVisibilityStore
      ? { mcpBodyVisibilityStore: deps.mcpBodyVisibilityStore }
      : {}),
    ...(deps.loadCollectionRecord
      ? { loadCollectionRecord: deps.loadCollectionRecord }
      : {}),
    ...(deps.formDefinitionReader
      ? { formDefinitionReader: deps.formDefinitionReader }
      : {}),
  };
  const sellerUsageGate = deps.sellerStore
    ? createSellerCustomerUsageGate({ sellerStore: deps.sellerStore })
    : null;
  const sellerUsagePending = sellerUsageGate
    ? createCustomerSurfaceUsagePendingCoordinator()
    : null;
  const sellerCustomerStatus = deps.sellerStore
    ? createSellerCustomerStatusResolver({ sellerStore: deps.sellerStore })
    : null;

  // Resolve bearer → token row once per request. Two disjoint shapes:
  // structured `<token_id>.<bearer>` resolves against the canonical cli
  // client_tokens table; everything else is tried as a D-171 inbound
  // door bearer (`recued_<base64url>` — never contains a `.`, so the
  // shapes cannot shadow each other). Returns null on miss (port
  // handler responds 401). Dispatch re-runs resolution after the
  // verifier so revocation between gate + dispatch still fails closed
  // with the JSON-RPC `-32001` envelope below.
  type ResolvedBearer =
    | { kind: 'cli'; mcp_token_id: string; record: ClientTokenRecord }
    | { kind: 'inbound'; mcp_token_id: string; record: McpInboundTokenRecord };
  const resolveBearer = async (bearer: string): Promise<ResolvedBearer | null> => {
    if (typeof bearer !== 'string' || bearer.length === 0) return null;
    const structured = parseStructuredBearer(bearer);
    if (structured) {
      if (!deps.clientTokens) return null;
      const { ok, record } = await deps.clientTokens.verify(
        structured.token_id,
        structured.bearer,
      );
      if (!ok || !record || record.client_kind !== 'cli') return null;
      try {
        deps.clientTokens.touch(record.token_id);
      } catch {
        /* non-fatal */
      }
      return { kind: 'cli', mcp_token_id: record.token_id, record };
    }
    if (!deps.inboundTokenStore) return null;
    // Shape gate before the store probe — only minted-shape door bearers
    // (`recued_<base64url>`) reach the hash lookup, keeping the two
    // token families' boundary structural rather than data-dependent.
    if (!bearer.startsWith(MCP_INBOUND_TOKEN_PREFIX)) return null;
    const record = deps.inboundTokenStore.verifyBearer({ bearer, now: Date.now() });
    if (!record) return null;
    return { kind: 'inbound', mcp_token_id: record.token_id, record };
  };

  const verifier: McpBearerVerifier = async (tok: string): Promise<boolean> =>
    (await resolveBearer(tok)) !== null;

  /** Carry the D-137 per-token 3 / 5 / 10 concurrency tier to HTTP
   *  admission. Canonical owner CLI tokens have no authored tier and retain
   *  the handler's fixed ceiling. The handler invokes this only after bearer
   *  verification; this second read also observes a raced revoke or expiry. */
  const resolveConcurrencyLimit: McpConcurrencyLimitResolver = (bearer) => {
    if (parseStructuredBearer(bearer)) return undefined;
    if (
      !deps.inboundTokenStore
      || !bearer.startsWith(MCP_INBOUND_TOKEN_PREFIX)
    ) return undefined;
    return deps.inboundTokenStore.verifyBearer({
      bearer,
      now: Date.now(),
    })?.concurrency_tier;
  };

  // Vault-lock gate predicate. Absent (dbless / harness — no vault) ⇒ open.
  const isVaultUnlocked = deps.isVaultUnlocked ?? (() => true);

  // Per-call dispatch — re-resolve the bearer so we use the right
  // `mcp_token_id` AND so we install a per-tool grant gate for
  // store-backed tokens. See Codex P1/P2 fold rationale in the file
  // header.
  const dispatch: McpDispatch = async (envelope: unknown, token?: string) => {
    // Vault-lock gate (checked FIRST, before any token work). A sealed (LOCKED)
    // server refuses tool EXECUTION so no MCP-driven side effect (outbound http
    // / ai) fires while locked — the parity fix for the one no-human execution
    // surface that lacked the pause every other autonomous executor has
    // (`vault-gated-executors.ts`). `initialize` / `tools/list` stay open so a
    // client can still connect + discover. Fails CLOSED.
    if (envelopeMethod(envelope) === 'tools/call' && !isVaultUnlocked()) {
      return {
        jsonrpc: '2.0',
        id: envelopeId(envelope),
        error: {
          code: -32002,
          message:
            'Server vault is locked — unlock the server (enter your recovery key) before running tools.',
        },
      };
    }
    const resolved = token ? await resolveBearer(token) : null;
    // P2 fold — refuse when the verifier accepted the bearer but
    // resolution misses now. Returns the standard `JsonRpcResponse`
    // envelope shape so the port handler ships it back as a proper
    // JSON-RPC `-32001` (server-defined: token revoked between verify
    // + dispatch). The id slot pulls from the envelope when it's a
    // request shape; null otherwise.
    if (token && token.length > 0 && !resolved) {
      return {
        jsonrpc: '2.0',
        id: envelopeId(envelope),
        error: {
          code: -32001,
          message:
            'Token state changed between verification and dispatch (revoked / expired / deleted) — re-authenticate.',
        },
      };
    }
    // D-166 P2 token↔contract binding. Resolve the inbound door's bound-contract
    // liveness ONCE here — the D-187 §6 door-type gate (below) AND the per-call
    // deps (the kill-switch closure) both consume it, so one `isContractLive`
    // read serves both. Probed live per dispatch so revoke/expiry/exhaustion acts
    // as an immediate kill-switch; an absent overlay resolver fails CLOSED for a
    // bound token. `undefined` ⇒ not an inbound bound token (cli owner / unbound).
    const dispatchNow = Date.now();
    const boundContractId =
      resolved && resolved.kind === 'inbound' ? resolved.record.contract_id : undefined;
    const contractLive =
      boundContractId !== undefined
        ? deps.executeDeps.contractOverlay?.isContractLive(boundContractId) ?? false
        : undefined;
    const sellerAdmission: SellerCustomerAccessAdmissionResult =
      resolved && resolved.kind === 'inbound'
        ? (() => {
            try {
              const resolveContractKind =
                deps.executeDeps.contractOverlay?.resolveBoundContractKind;
              return evaluateSellerCustomerAccessAdmission({
                ...(deps.sellerStore ? { sellerStore: deps.sellerStore } : {}),
                token: resolved.record,
                now: dispatchNow,
                contractKind:
                  boundContractId !== undefined && resolveContractKind
                    ? resolveContractKind(boundContractId) ?? null
                    : undefined,
              });
            } catch {
              return {
                applies: true,
                admitted: false,
                reason: 'admission_error',
              };
            }
          })()
        : { applies: false };
    const sellerAccessActive =
      sellerAdmission.applies === false ? true : sellerAdmission.admitted === true;
    const boundContractActive =
      boundContractId !== undefined
        ? contractLive === true && sellerAccessActive
        : undefined;
    // D-187 §6 (step 7) — level-1 DOOR-TYPE gate at connection establishment. A
    // LIVE bound contract NOT enabled for the `mcp` (tools) door type is rejected
    // outright with a `-32001` — a CONFIGURATION mismatch (the contract was never
    // opened for this door), distinct from the per-tool grant gate AND from the
    // dead-contract kill-switch (a DEAD contract falls through to the deny-all
    // path below, which preserves audit attribution). Gated on `=== true` so a
    // dead / unresolved-liveness token never takes this branch; the owner cli
    // bearer + stdio carry no `contract_id` (`boundContractId === undefined`) and
    // skip it. An absent `permitsDoorType` (test stub) or absent/empty
    // `door_types` is the wildcard (admit) — behaviour-preserving at zero installs.
    // ⛔⛔ AN INBOUND TOKEN WITH NO CONTRACT IS REFUSED. Codex found the hole:
    // the token's own `expires_at` is retired, `verifyBearer` no longer checks
    // one, and an UNBOUND row skips `isContractLive` entirely — so a legacy
    // bearer the boot backfill failed to contract would authenticate with its
    // lifetime enforced by nothing at all.
    //
    // ⚠ THE ESCALATION HALF OF THAT REPORT WAS WRONG, and the distinction is
    // worth keeping: `resolveTrustCeiling` keys on `isDelegatedMcpToken`
    // (`mcp_token_id !== 'stdio_local'`), so a remote unbound token still takes
    // the contracted `read` ceiling — driven, it returns `'read'`. It does NOT
    // inherit owner trust; the comment in `mcp-server.ts` that says so is about
    // the STDIO client and has been corrected. What was real is the EXPIRY
    // bypass, and this closes it.
    //
    // 🔑 Refused rather than deny-all, because unlike a dead contract there is
    // no contract to attribute the denial to — the operator needs to know the
    // token is un-migrated, not that "everything is denied".
    if (resolved && resolved.kind === 'inbound' && boundContractId === undefined) {
      return {
        jsonrpc: '2.0',
        id: envelopeId(envelope),
        error: {
          code: -32001,
          message:
            'This inbound token carries no contract. Every token is contracted; '
            + 'the boot backfill contracts legacy tokens automatically, so this one '
            + 'failed to migrate — check the [mcp-token-backfill] startup log and '
            + 're-issue the token.',
        },
      };
    }
    if (boundContractId !== undefined && boundContractActive === true) {
      const permitsMcpDoor =
        deps.executeDeps.contractOverlay?.permitsDoorType?.(boundContractId, 'mcp') ?? true;
      if (!permitsMcpDoor) {
        return {
          jsonrpc: '2.0',
          id: envelopeId(envelope),
          error: {
            code: -32001,
            message: `Bound contract '${boundContractId}' is not enabled for the mcp door — open the mcp door on this contract (door_types must include 'mcp') or bind a contract that is.`,
          },
        };
      }
    }
    const perCallDeps: McpDeps = (() => {
      if (!resolved) return baseMcpDeps;
      if (resolved.kind === 'cli') {
        // Owner identity — admit-all, no per-tool gate, no contract
        // binding (the synthetic 1-contract-per-token id keeps the
        // policy overlay INERT — pre-D-166 behavior).
        //
        // ⛔⛔ D-228 slice 6 — `ownerAdmitAll` STATES that positively, and this
        // is the only production caller entitled to say it. It reaches here
        // only after `clientTokens.verify` returned ok with
        // `client_kind === 'cli'`, so the claim rests on a verified credential
        // rather than on the ABSENCE of a checklist — which used to be shared
        // with a token-less stdio caller and with the `!resolved` branch above,
        // and admitted all three alike.
        return {
          ...baseMcpDeps,
          mcpTokenId: resolved.mcp_token_id,
          ownerAdmitAll: true,
        };
      }
      // D-171 external-door dispatch. The record was re-resolved for
      // THIS call, so the grants closure + bound-contract probe always
      // see the latest in-place edits (update_grants / rebind).
      const record = resolved.record;
      const now = dispatchNow;
      // Per-tool checklist gate (wire names) — resolves ONLY the token's own
      // `grants` map. Contract LIVENESS is a SEPARATE axis: a dead bound contract
      // (the store's `isContractLive` contract) is denied + shown an empty
      // catalog by the structural kill-switches in `handleToolCall` (dispatch) and
      // `handleToolsList` (enumeration), both keyed on the `boundContractId` /
      // `boundContractActive` deps set below. So this callback is NO LONGER
      // collapsed to `() => false` for a dead contract — that conflated "contract
      // dead" with "token grants nothing" and mislabeled the denial as a checklist
      // miss. It now stays a pure checklist on every path: `handleToolCall` runs
      // it before each dispatch (after the liveness guard), `handleToolsList`
      // filters the catalog through it, and `buildMcpContractSnapshot` filters
      // `allowed_tools` through it (that builder has its OWN dead-contract
      // allowlist collapse). D-187 token-lifecycle. (Prior `() => false` collapse:
      // codex HIGH fold on `a928bc7c`, superseded by the structural guards.)
      const inboundTokenAuthorize = (tool_name: string): boolean =>
        isMcpInboundTokenToolAuthorized(record, tool_name, now);
      const admittedSellerCustomer =
        sellerAdmission.applies === true && sellerAdmission.admitted === true
          ? sellerAdmission
          : null;
      const customerUsage =
        boundContractActive === true
        && admittedSellerCustomer
        && sellerUsageGate
          ? createCustomerSurfaceUsageSession({
              gate: sellerUsageGate,
              customer: admittedSellerCustomer.customer,
              tier: admittedSellerCustomer.tier,
              pendingCoordinator: sellerUsagePending!,
            })
          : undefined;
      const customerStatus =
        boundContractActive === true
        && admittedSellerCustomer
        && sellerCustomerStatus
          ? {
              getStatus: () =>
                sellerCustomerStatus.getStatus({
                  customer: admittedSellerCustomer.customer,
                  tier: admittedSellerCustomer.tier,
                  now: Date.now(),
                }),
            }
          : undefined;
      return {
        ...baseMcpDeps,
        mcpTokenId: resolved.mcp_token_id,
        mcpPrincipalActive: () => isMcpInboundTokenActive(record, Date.now()),
        // Audit attribution: the door's peer handle when set, else a
        // token-derived id — never the stdio_local fallback.
        agentId:
          record.peer_handle && record.peer_handle.length > 0
            ? record.peer_handle
            : `inbound_${record.token_id}`,
        inboundTokenAuthorize,
        ...(boundContractActive === true && admittedSellerCustomer
          ? { customerContractGrants: true as const }
          : {}),
        ...(customerUsage ? { customerUsage } : {}),
        ...(customerStatus ? { customerStatus } : {}),
        // Carried even when dead so the audit row records which
        // contract the dispatch was bound to.
        ...(record.contract_id !== undefined
          ? {
              boundContractId: record.contract_id,
              boundContractActive: boundContractActive === true,
            }
          : {}),
        // Door standing closure, MCP arm — read off the BOUND CONTRACT, live per
        // dispatch, never off the token record. Lifecycle and limitation are the
        // contract's job; the token authenticates. Gated on the contract being
        // ACTIVE, so revoke / expiry / exhaustion drops the standing authority
        // in the same instant it drops the allowlist.
        ...(record.contract_id !== undefined && boundContractActive === true
          ? (() => {
              const closure = deps.executeDeps.contractOverlay
                ?.standingClosureOperationIds?.(record.contract_id);
              return closure === undefined ? {} : { standingClosureOperationIds: closure };
            })()
          : {}),
      };
    })();
    // Re-use createMcpHttpDispatch's envelope-shape gate by calling its
    // returned dispatcher with the resolved deps; pass undefined for
    // the per-call token so the wrapper doesn't override our
    // `mcpTokenId` overlay.
    return createMcpHttpDispatch(perCallDeps)(envelope, undefined);
  };

  const logBootBanner = (): void => {
    const families = [
      ...(deps.clientTokens ? ['canonical client_tokens (client_kind=cli)'] : []),
      ...(deps.inboundTokenStore ? ['inbound door tokens (chat_inbound_tokens)'] : []),
    ];
    console.log(`[mcp] HTTP transport enabled — ${families.join(' + ')}`);
  };

  return {
    mcpHttpDeps: { verifier, dispatch, resolveConcurrencyLimit },
    logBootBanner,
  };
};
