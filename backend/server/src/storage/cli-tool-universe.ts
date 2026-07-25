/** D-182 §7 — pure manifest derivers for the cli-tool universe: the source the
 *  "Local tools" reachability surface (a contract-first list of per-op toggles;
 *  D-182 §7.2) renders from. Each maps the installed cli catalog manifests,
 *  grouped by the TOOL a catalog invokes (the connector `entry_point`, e.g.
 *  `whisper` / `ffmpeg` / `magick`; a tool maps to ≥1 cli catalog ingredient),
 *  keyed by the SHARED `cliToolFromConnectorRuntime`.
 *
 *  These are vocabulary for the UI, NOT an authorization key — the Gateway
 *  authorizes a dispatched cli op by per-(principal × cli-INGREDIENT × OPERATION)
 *  reachability (`resolveCliReachabilityPolicy`), keyed on the catalog slug + op
 *  id, not the tool (D-182 §7.2). Pure over the manifest snapshot; no I/O, no
 *  store.
 *
 *  Spec: docs/d-182-spec.md §7 / §7.2 (cli first-class + the reachability grid). */

import type {
  CliToolGridEntry,
  CliToolOpEntry,
  IngredientManifest,
} from '@recued/contracts';
import { cliToolFromConnectorRuntime, isRiskTier } from '@recued/contracts';

/** Canonical risk-tier order (mirrors the contract-merge / RISK_RANK ladder) —
 *  now a DISPLAY-badge ordering, not a grid column set. An op declaring any
 *  other (malformed/absent) tier is dropped from the per-op surface: it can
 *  never be granted (the gateway short-circuits an undeclared-risk op to
 *  `operation_not_declared` before the reachability read), so it must not render
 *  a toggle. */
// D-203 — tier validity is the canonical `isRiskTier` (contracts); a malformed/
// absent tier is dropped from the per-op surface (see the guard below).

/** True iff `manifest` is a cli catalog that invokes `tool`. Keys the manifest
 *  by the SHARED `cliToolFromConnectorRuntime` (`entry_point`, else the
 *  `system_binary:` package_ref) — the same derivation the grid groups by. */
const isCliCatalogForTool = (manifest: IngredientManifest, tool: string): boolean =>
  cliToolFromConnectorRuntime(manifest.surfaces?.connector?.runtime) === tool;

/** D-182 §7 — derive the ops a tool unlocks: the UNION of the operation keys
 *  every installed cli catalog that invokes `tool` declares. Pure over the
 *  manifest snapshot. Empty when no installed cli catalog invokes the tool
 *  (uninstalled). The grid uses this to label what a tool's cells cover. */
export const deriveCliToolGrant = (
  manifests: Iterable<IngredientManifest>,
  tool: string,
): { allowed_operations: string[] } => {
  const seen = new Set<string>();
  for (const manifest of manifests) {
    if (!isCliCatalogForTool(manifest, tool)) continue;
    for (const op of Object.keys(manifest.operations ?? {})) seen.add(op);
  }
  return { allowed_operations: [...seen] };
};

/** D-182 §7 — every installed cli catalog slug that invokes `tool`, keyed by
 *  the SHARED `cliToolFromConnectorRuntime` (so this agrees with both
 *  `deriveCliToolGrant` and the grid's tool grouping). Deterministic
 *  (manifest-iteration) order. */
export const cliCatalogSlugsForTool = (
  manifests: Iterable<IngredientManifest>,
  tool: string,
): string[] => {
  const slugs: string[] = [];
  for (const manifest of manifests) {
    if (isCliCatalogForTool(manifest, tool)) slugs.push(manifest.slug);
  }
  return slugs;
};

/** One enable-able cli tool — the universe entry: the tool, the installed cli
 *  catalog(s) that invoke it, and the union of their ops. */
export interface CliToolUniverseEntry {
  tool: string;
  catalog_slugs: string[];
  operations: string[];
}

/** D-182 §7 — enumerate the cli-tool universe: every tool an installed cli
 *  catalog invokes, grouped by tool (keyed by the SHARED
 *  `cliToolFromConnectorRuntime`), each with its backing catalog slug(s) + the
 *  union of their ops. Pure over the manifest snapshot; the source the
 *  Local-tools grid renders its tool rows from. Tools with no resolvable key (a
 *  non-cli manifest, or a cli runtime with neither `entry_point` nor a
 *  `system_binary:` package_ref) are skipped. */
export const enumerateCliToolUniverse = (
  manifests: Iterable<IngredientManifest>,
): CliToolUniverseEntry[] => {
  const byTool = new Map<string, { catalogs: Set<string>; operations: Set<string> }>();
  for (const manifest of manifests) {
    const tool = cliToolFromConnectorRuntime(manifest.surfaces?.connector?.runtime);
    if (tool === undefined) continue;
    let entry = byTool.get(tool);
    if (!entry) {
      entry = { catalogs: new Set<string>(), operations: new Set<string>() };
      byTool.set(tool, entry);
    }
    entry.catalogs.add(manifest.slug);
    for (const op of Object.keys(manifest.operations ?? {})) entry.operations.add(op);
  }
  return [...byTool.entries()].map(([tool, { catalogs, operations }]) => ({
    tool,
    catalog_slugs: [...catalogs],
    operations: [...operations],
  }));
};

/** D-182 §7.2 — derive the "Local tools" surface rows: the cli-tool universe
 *  enriched with the per-OP toggles the UI renders + writes reachability against.
 *  For each tool (grouped by the SHARED `cliToolFromConnectorRuntime`):
 *
 *    - `operations` — every callable op across the tool's catalog slugs, each a
 *      `{ operation_id, catalog_slug, risk_tier }`. The UI renders one per-op
 *      toggle; toggling writes ONE `cli.reachability.set` for `(principal,
 *      catalog_slug, operation_id)` — one reachability row per op (no fan-out).
 *      An op with a malformed/absent risk tier is dropped (it can never be
 *      granted — the gateway short-circuits it to `operation_not_declared`). Two
 *      ingredients under one tool may each declare a same-named op; both appear
 *      (distinct `catalog_slug`) as distinct toggles + distinct rows. Order is
 *      manifest-iteration (slug, then op-declaration) order — deterministic.
 *
 *  Pure over the manifest snapshot; no I/O, no store. The risk badge is the ONLY
 *  thing this adds over `enumerateCliToolUniverse` — that deriver stays the unit
 *  the grant/slug derivers share. */
export const enumerateCliToolGrid = (
  manifests: Iterable<IngredientManifest>,
): CliToolGridEntry[] => {
  const byTool = new Map<
    string,
    { catalogs: Set<string>; operations: CliToolOpEntry[] }
  >();
  for (const manifest of manifests) {
    const tool = cliToolFromConnectorRuntime(manifest.surfaces?.connector?.runtime);
    if (tool === undefined) continue;
    let entry = byTool.get(tool);
    if (!entry) {
      entry = { catalogs: new Set(), operations: [] };
      byTool.set(tool, entry);
    }
    entry.catalogs.add(manifest.slug);
    for (const [op, spec] of Object.entries(manifest.operations ?? {})) {
      const risk = spec?.risk_tier;
      // A real, recognized tier only — a malformed/absent risk drops the op from
      // the per-op surface: it can never be granted (the gateway keys no
      // reachability row to it; an undeclared-risk op short-circuits to
      // `operation_not_declared`), so it must not render a grantable toggle.
      if (!isRiskTier(risk)) continue;
      entry.operations.push({ operation_id: op, catalog_slug: manifest.slug, risk_tier: risk });
    }
  }
  return [...byTool.entries()].map(([tool, { catalogs, operations }]) => ({
    tool,
    catalog_slugs: [...catalogs],
    operations,
  }));
};
