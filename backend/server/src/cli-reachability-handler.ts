/** D-182 §7.2 — rpc handlers for the owner-only `cli.reachability.*` grid family.
 *
 *  A `cli` op (whisper / docling / ffmpeg / magick / codex) is connection-LESS
 *  and pack-only, so it has no `ConnectionOperationProfile` to authorize against
 *  (the `no_connection_profile` gap). Its authorization is a per-(principal ×
 *  cli-ingredient × OPERATION) reachability allowlist (`cli_reachability_state`,
 *  `resolveCliReachabilityPolicy`) — the SAME (contract × pack-op) grant shape
 *  every other pack-op uses — absent ⇒ DENIED (fail-closed). THIS family is the
 *  surface that AUTHORS that allowlist — the "Local tools" surface (a
 *  contract-first list of per-op toggles) writes it, and it supersedes the
 *  deleted `cli.capability.*` tool-toggle family. Without it the fail-closed
 *  default holds (nothing writes the allowlist), so the cli track stays
 *  non-dispatchable on a booted server even after the resolver is wired.
 *
 *    - `cli.reachability.list` — every reachability row (the grid's data read; a
 *      cheap store scan, no manifest walk).
 *    - `cli.reachability.set`  — grant (`allowed: true`) or revoke
 *      (`allowed: false`) ONE op for a principal (default owner `user_self`). A
 *      grant admits a recipe run under that principal to reach the cli
 *      ingredient's op; a revoke drops the row. Risk tier is orthogonal (it
 *      decides owner-notification, never admission) — it is NOT a key here.
 *
 *  Grant / revoke are audited (spec §7 "recorded, revocable, audited at the same
 *  Gateway") — granting reachability authorizes a local binary for invocation, an
 *  access-surface change in the same class as a connection grant.
 *
 *  Owner-only by construction: `cli.reachability.` is in
 *  `MCP_RESERVED_RPC_PREFIXES`, so an MCP-channel agent can never grant itself
 *  reachability, revoke a cell a recipe depends on, nor enumerate the grid.
 *  Absent `deps` (db-less harness) leaves both methods returning `not_configured`.
 *
 *  Spec: `docs/d-182-spec.md` §7.2 (per-contract cli reachability grid). */

import {
  CLI_REACHABILITY_OWNER_PRINCIPAL,
  RpcError,
  type CliReachabilityListResponse,
  type CliReachabilitySetRequest,
  type CliReachabilitySetResponse,
  type CliReachabilityUniverseResponse,
  type HandlerSlice,
  type IngredientManifest,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { ContractStore } from './storage/contract-store.js';
import { createCliReachabilityStore } from './storage/cli-reachability-store.js';
import { enumerateCliToolGrid } from './storage/cli-tool-universe.js';
import type { WsClient } from './ws-server.js';

export interface CliReachabilityRpcDeps {
  /** The local-only `contract.*` store. The SAME instance the gateway's
   *  cli-reachability resolver reads (`app.contractStoreRef`), so a freshly-
   *  granted cell authorizes the next dispatch with no reseed. The handler
   *  builds the `CliReachabilityStore` ad-hoc over this handle (stateless
   *  wrapper). */
  store: ContractStore;
  /** Clock (epoch-ms) for the cell stamp + the audit row. Defaults to
   *  `Date.now`; tests inject a fixed clock. */
  now?: () => number;
  /** D-120 activity log for the reserve-class `cli_reachability_{granted,
   *  revoked}` audit row. Optional (db-less harnesses): absent ⇒ the grid write
   *  still lands, only the audit breadcrumb is skipped — same posture as the
   *  contract handler's `auditLog` dep. */
  auditLog?: AuditLogStore;
  /** D-182 §7.2 (increment 4) — a snapshot of the installed ingredient manifests
   *  the `cli.reachability.universe` read derives the grid's tool rows + risk
   *  columns from (a pure derive, no store scan). Wired in the serve path from
   *  `executorConfig.manifests`; absent (db-less / pre-wire harness) ⇒ `universe`
   *  returns an empty tool list (no cli catalog visible), never throws. */
  getManifests?: () => Iterable<IngredientManifest>;
  /** D-182 — proactive readiness: resolves whether a tool's local binary is
   *  reachable on the server's PATH, enriching each `cli.reachability.universe`
   *  grid row's `reachable` so the Local-tools surface shows "not installed"
   *  before a run. Absent (db-less / pre-wire harness) ⇒ `reachable` is omitted
   *  (unknown) and the binary is never probed. Pure-vocabulary — never gates a
   *  grant. */
  probeCliToolReachable?: (tool: string) => boolean | Promise<boolean>;
}

/** The recognized risk tiers. An op is GRANTABLE iff its declared `risk_tier` is
 *  one of these (an op with a malformed/absent tier short-circuits to
 *  `operation_not_declared` at the gateway, so it can never be reached — and
 *  must not be writable into the allowlist). Used by `isGrantableOp` to gate a
 *  `set`. */
const VALID_RISK_TIERS = new Set(['read', 'write', 'admin', 'destructive']);

/** True iff `operation_id` is a declared, GRANTABLE op of the cli catalog
 *  ingredient `ingredient_id` in the installed manifest snapshot — i.e. the
 *  ingredient is installed and the op carries a recognized `risk_tier`. The
 *  hygiene guard on a `set` grant: a row for an undeclared op is harmless (the
 *  gateway independently denies — `cliRisk` undefined ⇒ `cli_reachability_
 *  disabled`), but the surface should never write a phantom grant. Enforced only
 *  when the manifest snapshot is wired (the serve path always wires it); a
 *  db-less harness skips it and the non-empty check is the floor. */
const isGrantableOp = (
  manifests: Iterable<IngredientManifest>,
  ingredient_id: string,
  operation_id: string,
): boolean => {
  for (const m of manifests) {
    if (m.slug !== ingredient_id) continue;
    const risk = m.operations?.[operation_id]?.risk_tier;
    return typeof risk === 'string' && VALID_RISK_TIERS.has(risk);
  }
  return false; // ingredient not among the installed cli catalogs
};

/** Owner gate — the family is reserved out of MCP, but a raw / pre-register WS
 *  connection must still not write the grid nor enumerate it. The dispatcher
 *  resolves a paired webclient's bearer-derived `token_instance_id` onto
 *  `instance_id` before handing the client here (`resolveGatedClientInstanceId`),
 *  so this accepts any paired client and rejects only an unregistered/raw one
 *  (mirrors `update.*`). */
const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'cli.reachability rpc requires a registered paired client',
      401,
    );
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const ensureNonEmpty = (method: string, field: string, value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError('bad_request', `${method}: ${field} is required`);
  }
  return value;
};

/** Best-effort reserve-class audit of a grant/revoke. Awaited (a human-paced
 *  rpc, so the response only returns once the row landed — a process exit right
 *  after the write can't lose it), but a FAILURE never unwinds the write: the
 *  allowlist row is the durable record and a revoke is the kill switch. Same
 *  discipline as the contract handler's grant-mint audit. */
const auditCell = async (
  auditLog: AuditLogStore | undefined,
  at: number,
  action: 'cli_reachability_granted' | 'cli_reachability_revoked',
  principal: string,
  ingredient_id: string,
  operation_id: string,
): Promise<void> => {
  if (auditLog === undefined) return;
  try {
    await auditLog.logActivity({
      activity_id: '',
      timestamp: at,
      action,
      target: ingredient_id,
      detail: JSON.stringify({ principal, operation_id }),
    });
  } catch (err) {
    console.warn(
      `[cli-reachability-handler] ${action} audit failed for '${principal}:${ingredient_id}:${operation_id}': `
        + (err instanceof Error ? err.message : String(err)),
    );
  }
};

type CliReachabilityMethods =
  | 'cli.reachability.list'
  | 'cli.reachability.universe'
  | 'cli.reachability.set';

export const makeCliReachabilityHandlers = (
  deps: CliReachabilityRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, CliReachabilityMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  const now = deps.now ?? ((): number => Date.now());
  // One stateless wrapper over the shared store handle — every call forwards to
  // the same `contract.cli_reachability` rows the gateway resolver reads.
  const grid = createCliReachabilityStore(deps.store);

  return {
    methods: ['cli.reachability.list', 'cli.reachability.universe', 'cli.reachability.set'],
    handlers: {
      'cli.reachability.list': async (_args, client): Promise<CliReachabilityListResponse> => {
        requireRegisteredClient(client);
        return {
          rows: grid.list().map((row) => ({
            principal: row.principal,
            ingredient_id: row.ingredient_id,
            operation_id: row.operation_id,
            allowed: row.allowed,
            ...(row.set_at !== undefined ? { set_at: row.set_at } : {}),
          })),
        };
      },

      'cli.reachability.universe': async (
        _args,
        client,
      ): Promise<CliReachabilityUniverseResponse> => {
        requireRegisteredClient(client);
        // Pure derive over the installed manifest snapshot — the grid's tool
        // rows + risk columns + cell→ingredient mapping. Absent source (db-less /
        // pre-wire harness) ⇒ no cli catalog visible (empty), never a throw.
        const manifests = deps.getManifests?.() ?? [];
        const tools = enumerateCliToolGrid(manifests);
        // D-182 — enrich each tool row with proactive readiness (binary-on-PATH).
        // Absent probe (harness) ⇒ leave `reachable` undefined (unknown). The
        // check is spawn-free + bounded (≤ a handful of installed tools), so it
        // runs live on each universe read — reflecting an install/uninstall of
        // the underlying binary with no cache to invalidate.
        const probe = deps.probeCliToolReachable;
        if (probe === undefined) return { tools };
        const enriched = await Promise.all(
          tools.map(async (t) => ({ ...t, reachable: await probe(t.tool) })),
        );
        return { tools: enriched };
      },

      'cli.reachability.set': async (args, client): Promise<CliReachabilitySetResponse> => {
        requireRegisteredClient(client);
        const method = 'cli.reachability.set';
        const a: Record<string, unknown> = isRecord(args) ? args : {};
        const req = args as CliReachabilitySetRequest | undefined;
        const ingredient_id = ensureNonEmpty(method, 'ingredient_id', req?.ingredient_id);
        const operation_id = ensureNonEmpty(method, 'operation_id', req?.operation_id);
        if (typeof a.allowed !== 'boolean') {
          throw new RpcError('bad_request', `${method}: allowed (boolean) is required`);
        }
        const allowed = a.allowed;
        // A GRANT must name a declared, grantable op of the cli ingredient — the
        // op axis replaces the old risk-tier validation. Enforced only when the
        // manifest snapshot is wired (the serve path always wires it); a db-less
        // harness skips it. Revokes skip the check so an op that's no longer
        // declared (ingredient updated/uninstalled) can still be cleared.
        if (allowed) {
          const manifests = deps.getManifests?.();
          if (manifests !== undefined && !isGrantableOp(manifests, ingredient_id, operation_id)) {
            throw new RpcError(
              'bad_request',
              `${method}: operation_id '${operation_id}' is not a declared op of cli ingredient '${ingredient_id}'`,
            );
          }
        }
        // `principal` defaults to the owner (the grid passes a door/agent
        // contract_id for a contract row). Non-empty when supplied.
        const principal =
          a.principal !== undefined && a.principal !== null
            ? ensureNonEmpty(`${method} (principal)`, 'principal', a.principal)
            : CLI_REACHABILITY_OWNER_PRINCIPAL;

        const prior = grid.get(principal, ingredient_id, operation_id);

        if (allowed) {
          // True idempotence — a redundant re-grant is a no-op: preserve the
          // original stamp (`set_at` = when reach was actually granted, not
          // "now") and skip the duplicate audit row.
          if (prior !== null && prior.allowed) {
            return {
              principal,
              ingredient_id,
              operation_id,
              allowed: true,
              ...(prior.set_at !== undefined ? { set_at: prior.set_at } : {}),
            };
          }
          const at = now();
          grid.allow(principal, ingredient_id, operation_id, at);
          await auditCell(deps.auditLog, at, 'cli_reachability_granted', principal, ingredient_id, operation_id);
          return { principal, ingredient_id, operation_id, allowed: true, set_at: at };
        }

        // Revoke — drop the row (absent ⇒ the fail-closed default). Idempotent:
        // revoking an already-absent row is a no-op (and not audited — a revoke
        // row should mark a real access-surface change, not a toggle that
        // granted nothing).
        grid.deny(principal, ingredient_id, operation_id);
        if (prior !== null) {
          await auditCell(deps.auditLog, now(), 'cli_reachability_revoked', principal, ingredient_id, operation_id);
        }
        return { principal, ingredient_id, operation_id, allowed: false };
      },
    },
  };
};
