import type Database from 'better-sqlite3';
import { PERMISSION_REGRESSION_LIMITS as LIMIT, deriveDispatchScope, kernelOpForBackingSlug,
  type PermissionDocument, type PermissionImpact, type PermissionImpactEntry } from '@recued/contracts';
import type { RecipeStore } from './recipe-store.js';
import type { ServerExecutorConfig } from './server-executor.js';

export interface PermissionAutomation { kind: 'schedule' | 'auto_run' | 'trigger'; id: string; label: string; recipe_id: string; contract_id?: string }
/** Structural references, never a promise about dynamic paths or another caller. */
export const permissionRegressionImpact = (db: Database.Database, contractId: string, document: PermissionDocument,
  recipes: RecipeStore, manifests: ServerExecutorConfig['manifests'], automations: readonly PermissionAutomation[]): PermissionImpact => {
  const changed = new Set(document.changes.map(item => item.entry_key)), entries: PermissionImpactEntry[] = [];
  const matched = new Set<string>(), topics = [...changed].filter(key => key.startsWith('enrichment.')).map(key => key.slice(11));
  let total = 0, nodes = 0, remainingText = 256_000, incomplete = false;
  const add = (entry: PermissionImpactEntry) => { total++; if (entries.length < LIMIT.impact_entries) entries.push(entry); };
  for (const id of recipes.ids().sort().slice(0, 1000)) {
    if (nodes >= 50_000) { incomplete = true; break; }
    const recipe = recipes.get(id); if (!recipe) continue;
    let mentions = false;
    const walk = (value: unknown, depth = 0): void => {
      if (nodes >= 50_000 || depth > 32) { incomplete = true; return; } nodes++;
      if (typeof value === 'string' && topics.length) {
        const text = value.slice(0, remainingText); remainingText -= text.length;
        if (value.length > text.length) incomplete = true;
        if (topics.some(topic => text.includes(topic))) mentions = true;
        return;
      }
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const item of value) { if (nodes >= 50_000) { incomplete = true; break; } walk(item, depth + 1); } return; }
      const item = value as Record<string, unknown>;
      if (typeof item.ingredient === 'string') {
        const manifest = manifests.get(item.ingredient), input = item.input && typeof item.input === 'object' && !Array.isArray(item.input)
          ? item.input as Record<string, unknown> : {};
        const op = typeof input.operation === 'string' ? manifest?.operations?.[input.operation]?.operation_id : kernelOpForBackingSlug(item.ingredient);
        const scope = manifest ? deriveDispatchScope({ kind: manifest.kind, slug: item.ingredient }, input) : null;
        if (op && changed.has(op) || scope && changed.has(scope)) mentions = true;
      }
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (nodes >= 50_000) { incomplete = true; break; }
        walk(item[key], depth + 1);
      }
    };
    // Inspect literal topic references through the same bounded walk, rather
    // than serializing every remaining recipe after the budget is exhausted.
    walk(recipe);
    if (mentions) { matched.add(id); add({ kind: 'recipe', id, label: recipe.metadata.name,
      detail: 'Mentions a changed permission. Its caller, settings and dynamic paths may differ from these cases.' }); }
  }
  if (recipes.ids().length > 1000) incomplete = true;
  for (const item of automations.slice(0, 1000)) {
    if (matched.has(item.recipe_id) || item.contract_id === contractId) add({ kind: item.kind, id: item.id, label: item.label,
      detail: item.contract_id === contractId ? 'Bound to this contract.' : 'Uses a recipe that mentions a changed permission; its caller may differ.' });
  }
  if (automations.length > 1000) incomplete = true;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='preapproval_dependencies' AND type='table'").get()) {
    const rows = db.prepare(`SELECT DISTINCT e.proposal_id,e.state FROM preapproval_dependencies d
      JOIN preapproval_executions e ON e.future_ref=d.future_ref
      JOIN preapproval_contract_queries q ON d.kind='contract_query' AND q.query_key=d.key
      WHERE q.scope IN ('contract_grant','contract_definition') AND json_extract(q.segments_json,'$[0]')=?
        AND e.state IN ('prepared','active','running','held','in_doubt') ORDER BY e.proposal_id LIMIT 1001`).all(contractId) as Array<{ proposal_id: string; state: string }>;
    for (const row of rows.slice(0, 1000)) add({ kind: 'review', id: row.proposal_id, label: 'Reviewed execution',
      detail: `Retains this contract as a dependency (${row.state}). A change can invalidate its saved authority.` });
    if (rows.length > 1000) incomplete = true;
  }
  return { entries, total, truncated: incomplete || total > entries.length, coverage: [
    'Admission examples cover the named credential and concrete call before session grants, reviewed approval lifts, required child calls and runtime data checks.',
    'Impact lists static recipe mentions, related local automation and retained review dependencies. It does not execute a recipe or prove that a dynamic path runs.',
    ...(incomplete ? ['Inventory inspection reached its limit. Some references were not inspected.'] : []),
  ] };
};
