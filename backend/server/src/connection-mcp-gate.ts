/** D-177 P2b — per-tool classification gate for the kernel
 *  `connection-mcp-read` / `connection-mcp-write` dispatch surfaces.
 *
 *  The two kernel manifests let any engine caller (the chat Tier-3
 *  route via run-ingredient, a recipe step binding the slug directly,
 *  an inline `recipe.run` recipe) call an arbitrary tool on an enrolled
 *  MCP connection at a `read` / `write` manifest tier. The manifest
 *  tier is what the policy verdict sees — so the tier must be TRUE: a
 *  read-tier dispatch of a tool the user classified `write` (or never
 *  classified) would be a tier spoof that slips a side-effecting call
 *  past the preflight ask. Parse-time validation cannot carry this
 *  (undeclared-key checks warn by default, and the run-ingredient
 *  step's templated slug skips ingredient validation entirely), so the
 *  gate enforces it at dispatch depth via
 *  `ConnectionAdapterDeps.gateDispatch` — after the connection record
 *  resolves, before the wire is crossed. Every refusal throws
 *  `MCP_TOOL_NOT_CLASSIFIED` (fail closed) and rides the adapter's
 *  standard error path (audited, then re-thrown).
 *
 *  Rule, scoped to exactly the two kernel slugs (every other slug —
 *  vendor wrappers, the admin-tier `connection` escape hatch — passes
 *  through untouched):
 *
 *    1. the resolved `connection_kind` must be `'mcp'` — the manifests
 *       pin it in their input defaults, but step input can override
 *       (the key is not engine-locked), and an `'api'` swap would
 *       reroute to the api handler with no classification concept;
 *    2. the user must have an enabled tool override whose
 *       classification is not `'unknown'` for this `(connection,
 *       tool)` (Settings → Connections → Tools — same predicate the
 *       chat Tier-3 catalog applies at projection time);
 *    3. the classification must fit the dispatched tier:
 *       `connection-mcp-read` carries only `read`-classified tools;
 *       `connection-mcp-write` carries `read` or `write` (over-gating
 *       a read is safe — it only adds the approval hold).
 *
 *  The annotation store is created lazily on first gate invocation:
 *  the executor config composes before the chat substrate ensures the
 *  annotation schema, and an eager `db.prepare` against the missing
 *  table would crash a fresh-db boot (the D-164 trust-store lesson).
 *  `ensureChatConnectionMcpAnnotationSchema` is idempotent
 *  (`IF NOT EXISTS`), so ensuring here is safe regardless of order. */

import type Database from 'better-sqlite3';
import {
  CONNECTION_MCP_READ_SLUG,
  CONNECTION_MCP_WRITE_SLUG,
} from '@recued/contracts';
import { IngredientError } from '@recued/ingredients';
import type { ConnectionAdapterDeps } from '@recued/ingredients';
import {
  createChatConnectionMcpStore,
  ensureChatConnectionMcpAnnotationSchema,
  type ChatConnectionMcpStore,
} from './storage/chat-connection-mcp-store.js';

type GateDispatch = NonNullable<ConnectionAdapterDeps['gateDispatch']>;

const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

/** Build the gate over a live annotation accessor. Pure w.r.t. its
 *  deps — the SQLite-backed production wiring goes through
 *  `createConnectionMcpGateFromDb` below; tests inject a stub. */
export const createConnectionMcpClassificationGate = (deps: {
  getAnnotation: ChatConnectionMcpStore['getAnnotation'];
}): GateDispatch =>
  ({ kind, record, params, call }) => {
    const slug = call.slug;
    if (slug !== CONNECTION_MCP_READ_SLUG && slug !== CONNECTION_MCP_WRITE_SLUG) {
      return;
    }
    if (kind !== 'mcp') {
      throw new IngredientError(
        'MCP_TOOL_NOT_CLASSIFIED',
        `${slug}: connection_kind '${kind}' is not 'mcp' — this kernel surface dispatches classified MCP tools only (use the per-kind wrapper or the admin-tier 'connection' ingredient for other kinds)`,
        { slug, kind, name: record.name },
      );
    }
    const tool = params.tool;
    if (typeof tool !== 'string' || tool.trim() === '') {
      // The mcp handler would IOVF this anyway, but the gate runs first
      // and a nameless tool cannot be classification-checked — refuse
      // with the gate's own code so the failure reads as what it is.
      throw new IngredientError(
        'MCP_TOOL_NOT_CLASSIFIED',
        `${slug}: 'tool' is required to resolve the per-tool classification (got ${typeof tool})`,
        { slug, name: record.name },
      );
    }
    const annotation = deps.getAnnotation(record.name);
    const override = hasOwn(annotation.tool_overrides, tool)
      ? annotation.tool_overrides[tool]
      : undefined;
    if (!override || !override.enabled || override.classification === 'unknown') {
      throw new IngredientError(
        'MCP_TOOL_NOT_CLASSIFIED',
        `${slug}: tool '${tool}' on connection '${record.name}' is not enabled and classified (Settings → Connections → Tools)`,
        { slug, name: record.name, tool },
      );
    }
    if (slug === CONNECTION_MCP_READ_SLUG && override.classification !== 'read') {
      throw new IngredientError(
        'MCP_TOOL_NOT_CLASSIFIED',
        `${slug}: tool '${tool}' on connection '${record.name}' is classified '${override.classification}' — dispatch it via '${CONNECTION_MCP_WRITE_SLUG}' so the write tier gates it`,
        { slug, name: record.name, tool, classification: override.classification },
      );
    }
  };

/** Production wiring — lazy store over the boot db (see module doc for
 *  why lazy). */
export const createConnectionMcpGateFromDb = (
  db: Database.Database,
): GateDispatch => {
  let store: ChatConnectionMcpStore | undefined;
  const getAnnotation: ChatConnectionMcpStore['getAnnotation'] = (name) => {
    if (!store) {
      ensureChatConnectionMcpAnnotationSchema(db);
      store = createChatConnectionMcpStore(db);
    }
    return store.getAnnotation(name);
  };
  return createConnectionMcpClassificationGate({ getAnnotation });
};
