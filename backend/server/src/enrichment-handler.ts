/** D-122 Phase 4.5 — `enrichment.upsert` + `enrichment.list` rpc
 *  handlers.
 *
 *  Two methods backing the kernel ingredients of the same name. Both
 *  delegate to the `EnrichmentStore` after gating + canonicalization;
 *  the store is the source of truth for shape A vs B demux,
 *  registry-driven validation, and sidecar wiring.
 *
 *  Shape:
 *  - `enrichment.upsert(input)` returns `{ _id, wrote: true }`.
 *  - `enrichment.list(query)` returns `{ entries, next_cursor }`.
 *
 *  Engine pre-stamps `authored_by_recipe_id` + `recipe_hash` +
 *  `source_record_hash` + `ingredient_slug` (D-136 P2 — was
 *  `model_used`) on the dispatch envelope. Recipes don't compute these
 *  directly. */

import {
  ENRICHMENT_UPSERT_MODES,
  ENRICHMENT_VOTE_KINDS,
  ENRICHMENT_VOTE_SOURCES,
  RpcError,
  isEnrichmentScope,
  isEnrichmentTopic,
} from '@recued/contracts';
import {
  AUTHOR_DEFAULT_READ_GRANT_CHECKER,
  type GatedReadGrantResolver,
} from './read-grant-checker.js';
import type {
  Actor,
  HandlerSlice,
  ServerRpcRegistry,
  EnrichmentScope,
  EnrichmentTopic,
  EnrichmentUpsertMode,
  EnrichmentVoteKind,
  EnrichmentVoteSource,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type {
  EnrichmentStore,
  EnrichmentRecord,
} from './storage/enrichment-store.js';
import {
  EnrichmentModeInvalidForPolicyError,
  EnrichmentModeUnauthorizedError,
  EnrichmentScopeUnsupportedError,
  EnrichmentShapeMismatchError,
  EnrichmentTopicUnknownError,
  EnrichmentValueInvalidError,
} from './storage/enrichment-store.js';

export interface EnrichmentRpcDeps {
  store: EnrichmentStore;
  /** D-136 P7.E — origin of the enclosing recipe execution. Set when
   *  the kernel `enrichment-list` adapter forwards `stepMeta.trigger_source`
   *  through bin.ts's dispatcher. The handler rejects reads on
   *  `mcp_exposed: 'private'` topics when this is `'mcp'`. Optional —
   *  WS-rpc paired-client paths and direct callers leave it absent and
   *  the handler stays user-permissive. */
  trigger_source?: string;
  /** D-187 AMENDMENT — the per-(bound contract) read-grant resolver. The `'mcp'`-trigger
   *  reject resolves the topic's `enrichment.<topic>` grant against the enclosing
   *  recipe's bound contract (`origin_contract_id`) — the recipe-channel analog of the
   *  native MCP tool's door contract, gated to standing policy contracts. Optional;
   *  absent → the author-default checker (registry default) applies. */
  readGrantResolver?: GatedReadGrantResolver;
  /** D-161 P1 — origin provenance facet, SERVER-INJECTED (never read
   *  from the RPC `args`). The kernel `enrichment-upsert` dispatcher
   *  lifts the engine-supplied `stepMeta.actor` (= the run's
   *  `ExecutionSource.actor`) off the trusted dispatch input into these
   *  deps so `handleEnrichmentUpsert` stamps the written row's
   *  `origin_actor` from server-derived state. The direct WS-rpc handler
   *  leaves them unset → the store defaults to `'system'`. Keeping origin
   *  off `args` is the security boundary: a client RPC payload cannot
   *  spoof `origin_actor`/`origin_contract_id` (I-6 / A.5). */
  origin_actor?: Actor;
  origin_contract_id?: string;
}

export interface EnrichmentUpsertArgs {
  topic: string;
  scope?: EnrichmentScope;
  /** Caller-supplied id. For Shape A this is `target_id`; for Shape B
   *  this is the derived-entity id (becomes `_id`). The handler routes
   *  per registry shape. */
  id: string;
  value: unknown;
  authored_by_recipe_id: string;
  source_record_hash?: string;
  recipe_hash?: string;
  /** D-136 P2 — renamed from legacy `model_used`. Records the
   *  ingredient slug invoked by the producer (`'ai-classify'`,
   *  `'ai-extract'`, …). */
  ingredient_slug?: string;
  /** D-136 P2 — resolved provider model id, populated by the
   *  ForceLayer resolver at producer call time once P3 lands. */
  model_id?: string;
  event_at?: number;
  /** D-136 §A.9 P5 — kernel `enrichment-upsert` writer mode. The
   *  store auto-defaults per the topic's `lifecycle_policy` when
   *  omitted (`'overwrite'` for non-historical, `'supersede'` for
   *  historical); explicit values are runtime-gated against the
   *  policy and (for `'pinned'`) the `authored_by_recipe_id`
   *  privilege prefix. */
  mode?: EnrichmentUpsertMode;
  // D-161 P1 — NOTE: the origin provenance facet (origin_actor /
  // origin_contract_id) is deliberately NOT an `args` field. It is
  // server-injected via `EnrichmentRpcDeps` from the trusted dispatch
  // input so a client RPC payload cannot spoof it (I-6 / A.5).
}

export interface EnrichmentListArgs {
  topic: string;
  scope?: EnrichmentScope;
  target_id?: string;
  authored_by_recipe_id?: string;
  fresh_only?: boolean;
  limit?: number;
  offset?: number;
}

const isScope = (v: unknown): v is EnrichmentScope =>
  typeof v === 'string' && isEnrichmentScope(v);

export const handleEnrichmentUpsert = async (
  deps: EnrichmentRpcDeps,
  args: EnrichmentUpsertArgs,
): Promise<{ _id: string; wrote: true }> => {
  if (typeof args.topic !== 'string' || args.topic.length === 0) {
    throw new RpcError('bad_request', 'enrichment.upsert: topic is required');
  }
  if (typeof args.id !== 'string' || args.id.length === 0) {
    throw new RpcError('bad_request', 'enrichment.upsert: id is required');
  }
  if (typeof args.authored_by_recipe_id !== 'string' || args.authored_by_recipe_id.length === 0) {
    throw new RpcError('bad_request', 'enrichment.upsert: authored_by_recipe_id is required');
  }
  if (args.scope !== undefined && !isScope(args.scope)) {
    throw new RpcError(
      'bad_request',
      `enrichment.upsert: invalid scope '${String(args.scope)}'`,
    );
  }
  if (args.mode !== undefined && !ENRICHMENT_UPSERT_MODES.includes(args.mode)) {
    throw new RpcError(
      'bad_request',
      `enrichment.upsert: invalid mode '${String(args.mode)}' — ` +
        `expected one of ${ENRICHMENT_UPSERT_MODES.join(' | ')}`,
    );
  }

  try {
    const out = deps.store.upsert({
      topic: args.topic,
      ...(args.scope !== undefined ? { scope: args.scope } : {}),
      ...(args.scope !== undefined ? { target_id: args.id } : { derived_entity_id: args.id }),
      value: args.value,
      authored_by: args.authored_by_recipe_id,
      ...(args.source_record_hash !== undefined ? { source_record_hash: args.source_record_hash } : {}),
      ...(args.recipe_hash !== undefined ? { recipe_hash: args.recipe_hash } : {}),
      ...(args.ingredient_slug !== undefined ? { ingredient_slug: args.ingredient_slug } : {}),
      ...(args.model_id !== undefined ? { model_id: args.model_id } : {}),
      ...(args.event_at !== undefined ? { event_at: args.event_at } : {}),
      ...(args.mode !== undefined ? { mode: args.mode } : {}),
      // D-161 P1 — origin provenance facet, SERVER-INJECTED via `deps`
      // (the kernel dispatcher lifts the engine `stepMeta.actor` off the
      // trusted dispatch input). Read from `deps`, never `args`, so a
      // client RPC payload cannot spoof it; the store defaults to
      // `'system'` when absent (direct WS-rpc path). (I-6 / A.5)
      ...(deps.origin_actor !== undefined ? { origin_actor: deps.origin_actor } : {}),
      ...(deps.origin_contract_id !== undefined
        ? { origin_contract_id: deps.origin_contract_id }
        : {}),
    });
    return { _id: out._id, wrote: true };
  } catch (err) {
    throw mapStoreError('enrichment.upsert', err);
  }
};

export const handleEnrichmentList = async (
  deps: EnrichmentRpcDeps,
  args: EnrichmentListArgs,
): Promise<{ entries: EnrichmentRecord[]; next_cursor: string | null }> => {
  if (typeof args.topic !== 'string' || args.topic.length === 0) {
    throw new RpcError('bad_request', 'enrichment.list: topic is required');
  }
  if (args.scope !== undefined && !isScope(args.scope)) {
    throw new RpcError(
      'bad_request',
      `enrichment.list: invalid scope '${String(args.scope)}'`,
    );
  }
  // D-136 P7.E §A.13.5 — when the enclosing recipe was triggered via
  // MCP (`recued_runRecipe`), reject `enrichment-list` reads on topics
  // not read-granted to the enclosing recipe's bound contract. Recipes invoked through
  // paired clients (`'manual'` / `'auto_run'` / `'reactive'` / `'cron'`) stay
  // user-permissive — the gate is per-trigger, not global. The reject fires before any
  // store read so timing doesn't leak whether matching rows exist. D-187 AMENDMENT
  // resolves the topic's `enrichment.<topic>` grant against the bound contract
  // (`origin_contract_id`) — per-(contract, topic), folding the former scope-fence +
  // `mcp_exposed` visibility.
  const readChecker =
    deps.trigger_source === 'mcp' && isEnrichmentTopic(args.topic)
      ? (deps.readGrantResolver?.resolveForContract(deps.origin_contract_id)
        ?? AUTHOR_DEFAULT_READ_GRANT_CHECKER)
      : undefined;
  if (readChecker && !readChecker.isTopicReadGranted(args.topic as EnrichmentTopic)) {
    throw new RpcError(
      'bad_request',
      `enrichment.list: topic '${args.topic}' is not read-granted to this contract (read rejected)`,
    );
  }
  const entries = deps.store.list({
    topic: args.topic,
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.target_id !== undefined ? { target_id: args.target_id } : {}),
    ...(args.authored_by_recipe_id !== undefined ? { authored_by: args.authored_by_recipe_id } : {}),
    ...(args.fresh_only !== undefined ? { fresh_only: args.fresh_only } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.offset !== undefined ? { offset: args.offset } : {}),
  });
  // Cursor follow-up: the store today is offset-paginated; we surface
  // a cursor placeholder so future migration to keyset pagination is
  // additive. Today the cursor is the next offset as a string when
  // the page is full; null when the caller has reached the tail.
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const next_cursor = entries.length === limit ? String(offset + limit) : null;
  return { entries, next_cursor };
};

const mapStoreError = (method: string, err: unknown): RpcError => {
  if (err instanceof EnrichmentTopicUnknownError) {
    return new RpcError('bad_request', `${method}: ${err.message}`);
  }
  if (err instanceof EnrichmentScopeUnsupportedError) {
    return new RpcError('bad_request', `${method}: ${err.message}`);
  }
  if (err instanceof EnrichmentValueInvalidError) {
    return new RpcError('bad_request', `${method}: ${err.message}`);
  }
  if (err instanceof EnrichmentShapeMismatchError) {
    return new RpcError('bad_request', `${method}: ${err.message}`);
  }
  if (err instanceof EnrichmentModeUnauthorizedError) {
    return new RpcError('bad_request', `${method}: ${err.message}`);
  }
  if (err instanceof EnrichmentModeInvalidForPolicyError) {
    return new RpcError('bad_request', `${method}: ${err.message}`);
  }
  if (err instanceof Error) {
    // Pre-publishable strings from the store carry typed prefixes
    // (`enrichment_vote_*` / `enrichment_topic_*`) — surface as
    // bad_request so the caller distinguishes input errors from
    // server faults.
    if (err.message.startsWith('enrichment_vote_') ||
        err.message.startsWith('enrichment_topic_')) {
      return new RpcError('bad_request', `${method}: ${err.message}`);
    }
    return new RpcError('internal_error', `${method}: ${err.message}`);
  }
  return new RpcError('internal_error', `${method}: unknown error`);
};

// ────────────────────────────────────────────────────────────────
// D-136 §A.11 P7 — quality vote ingest + unwind
// ────────────────────────────────────────────────────────────────

export interface EnrichmentVoteWriteArgs {
  topic: string;
  scope?: EnrichmentScope;
  target_id?: string;
  enrichment_row_id: string;
  vote: EnrichmentVoteKind;
  source: EnrichmentVoteSource;
  corrected_value?: unknown;
  context_recipe_id?: string;
  agent_session_id?: string;
  agent_sub_path?: string;
}

export interface EnrichmentVoteDeleteArgs {
  vote_id: string;
}

/** P7.A Codex review #3 — transport-aware identity gate.
 *  WS-rpc surface is exclusively for paired clients (D-121 instance_id
 *  is enforced at the dispatch envelope); MCP-channel agent calls flow
 *  through a separate handler (P7.D). The transport tag lets the handler
 *  reject claims whose source doesn't match the channel: a normal paired
 *  client can't claim `source: 'agent_action'` via WS-rpc + bypass the
 *  source-vs-client matrix to write a pinned correction.
 *
 *  Today only the WS-rpc transport calls this handler. P7.D will add an
 *  MCP transport variant that accepts `'agent_action'` (and rejects the
 *  paired-client sources). */
export type EnrichmentVoteTransport = 'ws-rpc' | 'mcp';

/** Source-vs-client validation matrix per §A.11. The handler stamps
 *  `voted_by_client_id` from the dispatch envelope; the store is
 *  source-agnostic.
 *
 *  Cross-channel rules:
 *    - `'agent_action'` requires `transport === 'mcp'`. Reject on WS-rpc
 *      so paired clients can't fabricate sub-agent identity. (P7.A
 *      Codex review #3.)
 *    - `'user_dismissal' | 'user_action' | 'explicit_correction'`
 *      require `transport === 'ws-rpc'`. The MCP surface (P7.D) rejects
 *      these — paired-client identity can't reach there.
 *    - `vote === 'corrected'` requires `source === 'explicit_correction'`
 *      or `source === 'agent_action'` (write-tier permission). */
const validateSourceVsTransport = (
  vote: EnrichmentVoteKind,
  source: EnrichmentVoteSource,
  transport: EnrichmentVoteTransport,
): void => {
  if (transport === 'ws-rpc' && source === 'agent_action') {
    throw new RpcError(
      'permission_denied',
      `enrichment.vote.write: source='agent_action' is reserved for MCP-channel agents; got transport='ws-rpc'`,
    );
  }
  if (transport === 'mcp' && source !== 'agent_action') {
    throw new RpcError(
      'permission_denied',
      `enrichment.vote.write: MCP transport requires source='agent_action'; got '${source}'`,
    );
  }
  if (vote === 'corrected' && source !== 'explicit_correction' && source !== 'agent_action') {
    throw new RpcError(
      'bad_request',
      `enrichment.vote.write: vote='corrected' requires source='explicit_correction' or 'agent_action' — got '${source}'`,
    );
  }
};

export const handleEnrichmentVoteWrite = async (
  deps: EnrichmentRpcDeps,
  args: EnrichmentVoteWriteArgs,
  voted_by_client_id: string,
  transport: EnrichmentVoteTransport = 'ws-rpc',
): Promise<{
  vote_id: string;
  routing: 'recompute' | 'discard' | 'pin_written' | 'failure_count_reset' | 'noop';
  pinned_row_id: string | null;
}> => {
  if (typeof args.topic !== 'string' || args.topic.length === 0) {
    throw new RpcError('bad_request', 'enrichment.vote.write: topic is required');
  }
  if (typeof args.enrichment_row_id !== 'string' || args.enrichment_row_id.length === 0) {
    throw new RpcError(
      'bad_request',
      'enrichment.vote.write: enrichment_row_id is required',
    );
  }
  if (!ENRICHMENT_VOTE_KINDS.includes(args.vote)) {
    throw new RpcError(
      'bad_request',
      `enrichment.vote.write: invalid vote '${String(args.vote)}' — expected one of ${ENRICHMENT_VOTE_KINDS.join(' | ')}`,
    );
  }
  if (!ENRICHMENT_VOTE_SOURCES.includes(args.source)) {
    throw new RpcError(
      'bad_request',
      `enrichment.vote.write: invalid source '${String(args.source)}' — expected one of ${ENRICHMENT_VOTE_SOURCES.join(' | ')}`,
    );
  }
  if (args.scope !== undefined && !isEnrichmentScope(args.scope)) {
    throw new RpcError(
      'bad_request',
      `enrichment.vote.write: invalid scope '${String(args.scope)}'`,
    );
  }
  validateSourceVsTransport(args.vote, args.source, transport);

  try {
    return deps.store.writeQualityVote({
      topic: args.topic,
      ...(args.scope !== undefined ? { scope: args.scope } : {}),
      ...(args.target_id !== undefined ? { target_id: args.target_id } : {}),
      enrichment_row_id: args.enrichment_row_id,
      vote: args.vote,
      source: args.source,
      ...(args.corrected_value !== undefined ? { corrected_value: args.corrected_value } : {}),
      ...(args.context_recipe_id !== undefined ? { context_recipe_id: args.context_recipe_id } : {}),
      ...(args.agent_session_id !== undefined ? { agent_session_id: args.agent_session_id } : {}),
      ...(args.agent_sub_path !== undefined ? { agent_sub_path: args.agent_sub_path } : {}),
      voted_by_client_id,
    });
  } catch (err) {
    throw mapStoreError('enrichment.vote.write', err);
  }
};

export const handleEnrichmentVoteDelete = async (
  deps: EnrichmentRpcDeps,
  args: EnrichmentVoteDeleteArgs,
): Promise<{ ok: true; pin_unwound: boolean }> => {
  if (typeof args.vote_id !== 'string' || args.vote_id.length === 0) {
    throw new RpcError('bad_request', 'enrichment.vote.delete: vote_id is required');
  }
  try {
    return deps.store.deleteQualityVote(args.vote_id);
  } catch (err) {
    throw mapStoreError('enrichment.vote.delete', err);
  }
};

type EnrichmentMethods =
  | 'enrichment.upsert'
  | 'enrichment.list'
  | 'enrichment.vote.write'
  | 'enrichment.vote.delete';

export const makeEnrichmentHandlers = (
  deps: EnrichmentRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, EnrichmentMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'enrichment.upsert',
      'enrichment.list',
      'enrichment.vote.write',
      'enrichment.vote.delete',
    ],
    handlers: {
      'enrichment.upsert': async (args) =>
        handleEnrichmentUpsert(deps, args as Parameters<typeof handleEnrichmentUpsert>[1]),
      'enrichment.list': async (args) =>
        handleEnrichmentList(deps, args as Parameters<typeof handleEnrichmentList>[1]),
      'enrichment.vote.write': async (args, client) => {
        // `voted_by_client_id` derives from the WsClient envelope —
        // `instance_id` is the D-121 paired-client identity. Absent
        // (anonymous / pre-register connection) the handler stamps a
        // deterministic sentinel so the store FK column stays
        // populated for audit + Settings UI surfaces.
        const voted_by_client_id = client?.instance_id ?? 'unknown';
        return handleEnrichmentVoteWrite(
          deps,
          args as EnrichmentVoteWriteArgs,
          voted_by_client_id,
        );
      },
      'enrichment.vote.delete': async (args) =>
        handleEnrichmentVoteDelete(deps, args as EnrichmentVoteDeleteArgs),
    },
  };
};
