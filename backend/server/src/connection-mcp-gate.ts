/** D-177 P2b / D-228 slice 4 — per-tool TIER gate for the kernel
 *  `connection-mcp-read` / `connection-mcp-write` dispatch surfaces.
 *
 *  The two kernel manifests let any engine caller (a recipe step binding the
 *  slug directly, an inline `recipe.run` recipe) call an arbitrary tool on an
 *  enrolled MCP connection at a `read` / `write` manifest tier. The manifest
 *  tier is what the policy verdict sees — so the tier must be TRUE: a read-tier
 *  dispatch of a tool that is actually a write would be a tier spoof that slips
 *  a side-effecting call past the preflight ask. Parse-time validation cannot
 *  carry this (undeclared-key checks warn by default, and the run-ingredient
 *  step's templated slug skips ingredient validation entirely), so the gate
 *  enforces it at dispatch depth via `ConnectionAdapterDeps.gateDispatch` —
 *  after the connection record resolves, before the wire is crossed. Every
 *  refusal throws `MCP_TOOL_NOT_CLASSIFIED` (fail closed) and rides the
 *  adapter's standard error path (audited, then re-thrown).
 *
 *  ── ⛔⛔ WHERE THE TIER COMES FROM, AND WHY IT MOVED ───────────────────────
 *  It used to come from `tool_overrides` — a per-tool `read`/`write` value the
 *  owner typed into Settings → Connections → Tools, in the chat PRESENTATION
 *  store. D-225 named that store as the standing defect and D-228 slice 3 swapped
 *  chat off it; this slice deletes it, which means this gate needed a real source
 *  of truth rather than the last one standing.
 *
 *  🔑 **THE PACK OPERATION IS THAT TRUTH.** An enrolled MCP connection's tools
 *  are minted into a generated pack (auto-mint at enroll, § 234.4p.16f), each as
 *  an operation with a declared `risk_tier` the owner can lower through the
 *  gated `contract.ownerOperation.*` editor. So the gate now asks the SAME
 *  substrate the door asks, resolved the SAME way — instead of a parallel value
 *  that could disagree with it.
 *
 *  Rule, scoped to exactly the two kernel slugs (every other slug — vendor
 *  wrappers, the admin-tier `connection` escape hatch — passes through
 *  untouched):
 *
 *    1. the resolved `connection_kind` must be `'mcp'` — the manifests pin it in
 *       their input defaults, but step input can override (the key is not
 *       engine-locked), and an `'api'` swap would reroute to the api handler
 *       with no tier concept at all;
 *    2. the tool must be COVERED — some catalog bound to this connection must
 *       declare an operation dispatching it. Uncovered ⇒ refuse;
 *    3. the covering operation's RESOLVED tier must fit the dispatched slug:
 *       `connection-mcp-read` carries only `read`; `connection-mcp-write`
 *       carries anything at or below `write` (over-gating a read is safe — it
 *       only adds the approval hold).
 *
 *  ⛔ **RULE 2 IS STRICTLY TIGHTER THAN WHAT IT REPLACES, and the case it closes
 *  is not a loss.** A connection with no pack has none because its server was
 *  unreachable when auto-mint ran and at every `mcp-pack-first-mint` sweep
 *  since — so a dispatch to it would fail at the wire anyway. What changes is
 *  that it now fails HERE, with a message naming the reason, instead of at a
 *  timeout. A server that comes back gets its pack on the next idle cycle and
 *  its tools with it; nothing needs a human.
 *
 *  ⚠ **`admin` and `destructive` reach NEITHER slug.** `connection-mcp-write`
 *  admits at-or-below `write`, so a pack op the owner raised above that is
 *  refused on both — deliberately. These kernel surfaces are the untyped escape
 *  hatch; an operation the owner has marked that dangerous should be reached
 *  through its own op id, where the contract governs it by name.
 */

import type Database from 'better-sqlite3';
import {
  CONNECTION_MCP_READ_SLUG,
  CONNECTION_MCP_WRITE_SLUG,
  isRiskTierAtMost,
  type OperationRiskTier,
} from '@recued/contracts';
import { IngredientError } from '@recued/ingredients';
import type { ConnectionAdapterDeps } from '@recued/ingredients';
import type { ContractStore } from './storage/contract-store.js';
import type { IngredientManifest } from '@recued/contracts';
import { createConnectionCatalogBindingStore } from './storage/connection-catalog-binding-store.js';
import { createContractScanFn } from './storage/contract-store.js';
import { createChatConnectionPackTiers } from './chat-connection-pack-coverage.js';

type GateDispatch = NonNullable<ConnectionAdapterDeps['gateDispatch']>;

/** Build the gate over a live tier lookup. Pure w.r.t. its deps — the
 *  SQLite-backed production wiring goes through `createConnectionMcpGateFromDb`
 *  below; tests inject a stub. */
export const createConnectionMcpClassificationGate = (deps: {
  /** The resolved tier of each upstream tool a bound catalog dispatches, or
   *  undefined when the connection has no bound catalog at all. */
  resolveToolTiers: (
    connection_name: string,
  ) => ReadonlyMap<string, OperationRiskTier> | undefined;
}): GateDispatch =>
  ({ kind, record, params, call }) => {
    const slug = call.slug;
    if (slug !== CONNECTION_MCP_READ_SLUG && slug !== CONNECTION_MCP_WRITE_SLUG) {
      return;
    }
    if (kind !== 'mcp') {
      throw new IngredientError(
        'MCP_TOOL_NOT_CLASSIFIED',
        `${slug}: connection_kind '${kind}' is not 'mcp' — this kernel surface dispatches tier-resolved MCP tools only (use the per-kind wrapper or the admin-tier 'connection' ingredient for other kinds)`,
        { slug, kind, name: record.name },
      );
    }
    const tool = params.tool;
    if (typeof tool !== 'string' || tool.trim() === '') {
      // The mcp handler would IOVF this anyway, but the gate runs first and a
      // nameless tool cannot have its tier resolved — refuse with the gate's own
      // code so the failure reads as what it is.
      throw new IngredientError(
        'MCP_TOOL_NOT_CLASSIFIED',
        `${slug}: 'tool' is required to resolve the operation tier (got ${typeof tool})`,
        { slug, name: record.name },
      );
    }
    const tiers = deps.resolveToolTiers(record.name);
    const tier = tiers?.get(tool);
    if (tier === undefined) {
      // ⛔ ONE MESSAGE FOR TWO SHAPES ON PURPOSE — "no pack at all" and "a pack
      // that does not declare this tool" are the same fact to the caller (there
      // is no governed operation to take the tier from) and the same remedy.
      // Splitting them would invite reading the first as a wiring fault.
      throw new IngredientError(
        'MCP_TOOL_NOT_CLASSIFIED',
        `${slug}: tool '${tool}' on connection '${record.name}' is not covered by an installed `
        + 'operation, so its risk tier is unknown and this surface will not guess it. Recued '
        + "generates a pack from an MCP connection's tools once it can read them; if this "
        + 'server has been unreachable, the tool is not callable yet either.',
        { slug, name: record.name, tool },
      );
    }
    const ceiling: OperationRiskTier =
      slug === CONNECTION_MCP_READ_SLUG ? 'read' : 'write';
    if (!isRiskTierAtMost(tier, ceiling)) {
      throw new IngredientError(
        'MCP_TOOL_NOT_CLASSIFIED',
        `${slug}: tool '${tool}' on connection '${record.name}' resolves to risk '${tier}', `
        + `which this surface does not carry (its ceiling is '${ceiling}'). `
        + (ceiling === 'read'
          ? `Dispatch it via '${CONNECTION_MCP_WRITE_SLUG}' so the write tier gates it.`
          : 'Reach it through its own operation id, where the contract governs it by name.'),
        { slug, name: record.name, tool, risk_tier: tier },
      );
    }
  };

/** Production wiring.
 *
 *  ⚠ LAZY, and for the reason the D-164 trust-store lesson records: the executor
 *  config composes before the stores this reads are guaranteed present, and an
 *  eager `db.prepare` against a missing table would crash a fresh-db boot. */
export const createConnectionMcpGateFromDb = (
  db: Database.Database,
  deps: {
    contractStore?: ContractStore;
    getManifest?: (slug: string) => IngredientManifest | null;
  } = {},
): GateDispatch => {
  void db;
  let resolve: ((name: string) => ReadonlyMap<string, OperationRiskTier> | undefined) | undefined;
  return createConnectionMcpClassificationGate({
    resolveToolTiers: (connection_name) => {
      if (!resolve) {
        const { contractStore, getManifest } = deps;
        // ⛔ ABSENT STORES ⇒ NO TIERS ⇒ EVERY DISPATCH REFUSES. Fail closed: this
        // gate's entire job is to prevent a tier spoof, and a gate that admits
        // when it cannot resolve is not a gate. A dbless / partial harness gets
        // no `connectionGateDispatch` at all (see `wire-executor-config`), so
        // this branch is reached only when the wiring is genuinely incomplete.
        resolve = contractStore && getManifest
          ? createChatConnectionPackTiers({
              bindingStore: createConnectionCatalogBindingStore(contractStore),
              getManifest,
              // ⚠ The CANONICAL adapter, not a hand-rolled closure — `ScanFn`
              // narrows `value`, and re-deriving that shape by hand is how two
              // readers of one store start disagreeing about it.
              contractScan: createContractScanFn(contractStore),
            })
          : () => undefined;
      }
      return resolve(connection_name);
    },
  });
};
