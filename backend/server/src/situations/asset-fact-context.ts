import { assetFactRefKey, assetFieldValue, assetRuleInput, parseAssetFactContextRequest, SITUATION_CONTEXT_MAX_BYTES,
  type AssetEvidence, type AssetFactContext, type AssetFactContextNode, type AssetFactContextRef,
  type AssetFactContextRequest, type AssetFieldRef, type SituationRef } from '@recued/contracts';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import type Database from 'better-sqlite3';
import type { SituationReadContext } from './query.js';
import { situationSourceAccess } from './sources.js';
export { parseAssetFactContextRequest } from '@recued/contracts';

export const ASSET_CONTEXT_LIMITS = { nodes: 40, edges: 60, bytes: SITUATION_CONTEXT_MAX_BYTES } as const;
export interface AssetContextWriter { id: string; name: string; fields: string[]; enabled: boolean }
/** Adapter over existing writer relationships, bounded in SQL before decoding. */
export const assetContextWriters = (db: Database.Database, name: (actor: string) => string = actor => actor) =>
  (asset_id: string, fields: readonly string[], limit: number): AssetContextWriter[] => {
    if (!fields.length) return [];
    const rows = db.prepare(`SELECT id,actor_ref,fields,enabled FROM asset_observation_binding WHERE asset_id=? AND enabled=1
      AND EXISTS(SELECT 1 FROM json_each(asset_observation_binding.fields) WHERE value IN (${fields.map(() => '?').join(',')}))
      ORDER BY id LIMIT ?`).all(asset_id, ...fields, Math.min(ASSET_CONTEXT_LIMITS.nodes + 1, Math.max(1, limit))) as Array<{ id: string; actor_ref: string; fields: string; enabled: number }>;
    return rows.map(row => ({ id: row.id, name: name(row.actor_ref), fields: JSON.parse(row.fields) as string[], enabled: row.enabled === 1 }));
  };
export interface AssetFactContextDeps {
  work: Pick<WorkEntityStore, 'readAsset'>;
  now?: () => number;
  referenceSphere?: SituationReadContext['referenceSphere'];
  /** The adapter must enforce the requested row limit before materializing. */
  writers?(asset_id: string, fields: readonly string[], limit: number): AssetContextWriter[];
  snapshot?<T>(read: () => T): T;
}
const fieldName = (value: string) => value.replaceAll('_', ' ');

/** One root, at most two relationship hops. No snapshot refresh, cache, or writes.
 * Read grants and sphere fences are applied before returning values or links. */
const readAssetFactContext = (deps: AssetFactContextDeps, raw: AssetFactContextRequest, context: SituationReadContext): AssetFactContext => {
  const { root } = parseAssetFactContextRequest(raw);
  if (context.signal?.aborted) throw new Error('Context read cancelled');
  const allowed = (ref: SituationRef): boolean => {
    const access = situationSourceAccess(ref.collection);
    if (!access || !context.grants.isVerbOpGranted(access.verb_op) || !context.grants.isCollectionReadGranted(access.collection)) return false;
    if (context.owner || context.all_spheres) return true;
    const sphere = context.referenceSphere?.(ref) ?? deps.referenceSphere?.(ref);
    return sphere !== undefined && context.spheres?.includes(sphere) === true;
  };
  if (!allowed({ collection: 'asset', id: root.asset_id })) throw new Error('This context is not available with the current read permissions');
  const asset = deps.work.readAsset(root.asset_id);
  if (!asset || asset.deleted_at != null || !['live', 'stale_unreachable'].includes(asset.sync_state)) throw new Error('Asset not available');
  const rootRule = root.kind === 'rule' ? asset.rules.find(rule => rule.id === root.rule_id) : undefined;
  if (root.kind === 'rule' && !rootRule || root.kind === 'field' && !Object.hasOwn(asset[root.group], root.field)) throw new Error('Fact or rule not found. Refresh the asset.');
  const packet: AssetFactContext = { root, asset: { id: asset.id, name: asset.name, status: asset.status, source_state: asset.sync_state }, nodes: [], edges: [], read_at: (deps.now ?? Date.now)(),
    freshness: 'current', completeness: 'complete', omitted: [], missing: [] };
  const keys = new Set<string>();
  const omit = (reason: AssetFactContext['omitted'][number]) => { packet.completeness = 'partial'; if (!packet.omitted.includes(reason)) packet.omitted.push(reason); };
  // Permission limitations are independent of actual hidden relationships;
  // the flag cannot disclose whether a denied source contains any evidence.
  if (!context.owner) omit('restricted_context');
  if (asset.sync_state === 'stale_unreachable') omit('source_unavailable');
  const size = () => Buffer.byteLength(JSON.stringify(packet), 'utf8');
  const addNode = (node: AssetFactContextNode): boolean => {
    const key = assetFactRefKey(node.ref); if (keys.has(key)) return true;
    if (packet.nodes.length >= ASSET_CONTEXT_LIMITS.nodes) { omit('node_budget'); return false; }
    packet.nodes.push(node);
    const missing = node.kind === 'field' && (!node.known || node.future);
    if (missing) packet.missing.push(node.ref);
    if (size() > ASSET_CONTEXT_LIMITS.bytes - 384) {
      packet.nodes.pop(); if (missing) packet.missing.pop(); omit('byte_budget');
      if (node.kind === 'field' && node.known && !node.value_omitted) return addNode({ ...node, value: null, value_omitted: true });
      return false;
    }
    keys.add(key); return true;
  };
  const addEdge = (from: AssetFactContextRef, to: AssetFactContextRef, kind: AssetFactContext['edges'][number]['kind']) => {
    if (!keys.has(assetFactRefKey(from)) || !keys.has(assetFactRefKey(to))) return;
    if (packet.edges.length >= ASSET_CONTEXT_LIMITS.edges) { omit('edge_budget'); return; }
    packet.edges.push({ from, to, kind });
    if (size() > ASSET_CONTEXT_LIMITS.bytes - 384) { packet.edges.pop(); omit('byte_budget'); }
  };
  const fieldNode = (ref: AssetFieldRef): AssetFactContextNode => {
    const original = assetFieldValue(asset, ref); let value: unknown = original; let unsupported = false;
    if (original && ref.group === 'readings') { const reading = asset.readings[ref.field]!; value = { value: reading.value, unit: reading.unit, as_of: reading.as_of }; }
    else if (original && ref.group === 'observations') { const observation = asset.observations[ref.field]!; value = { active: observation.active, certainty: observation.certainty, as_of: observation.as_of }; }
    else if (original !== null && typeof original === 'object') { value = null; unsupported = true; omit('unsupported_value'); }
    return { kind: 'field', ref, label: fieldName(ref.field), value, known: original !== null && original !== undefined,
      source: context.owner ? structuredClone(asset.field_sources[`${ref.group}.${ref.field}`] ?? null) : null,
      ...(value && typeof value === 'object' && 'as_of' in value && typeof value.as_of === 'number' && value.as_of > packet.read_at ? { future: true as const } : {}),
      ...(!context.owner ? { source_restricted: true as const } : {}), ...(unsupported ? { value_omitted: true as const } : {}) };
  };
  const input = root.kind === 'field' ? root : assetRuleInput(asset.id, rootRule!);
  const first: AssetFactContextNode = root.kind === 'rule' && rootRule ? { kind: 'rule', ref: root, title: rootRule.title, rule: structuredClone(rootRule) } : fieldNode(input);
  if (!addNode(first)) throw new Error('This context is too large. Open the asset to review it.');
  addNode(fieldNode(input));
  for (const rule of asset.rules) {
    const field = assetRuleInput(asset.id, rule);
    if (assetFactRefKey(field) !== assetFactRefKey(input)) continue;
    const ref = { kind: 'rule' as const, asset_id: asset.id, rule_id: rule.id };
    if (addNode({ kind: 'rule', ref, title: rule.title, rule: structuredClone(rule) })) addEdge(ref, field, 'uses');
  }
  const original = assetFieldValue(asset, input);
  const evidence: AssetEvidence[] = input.group === 'readings' ? asset.readings[input.field]?.evidence ?? [] : input.group === 'observations' ? asset.observations[input.field]?.evidence ?? [] : [];
  if (original !== null) for (const citation of evidence) {
    if (!allowed(citation)) { omit('restricted_context'); continue; }
    const copy = structuredClone(citation); const ref = { kind: 'evidence' as const, asset_id: asset.id, evidence: copy };
    if (addNode({ kind: 'evidence', ref, evidence: copy })) addEdge(input, ref, 'supported_by');
  }
  if (context.owner && deps.writers && ['readings', 'observations'].includes(input.group)) {
    const limit = Math.max(0, ASSET_CONTEXT_LIMITS.nodes - packet.nodes.length);
    const writers = deps.writers(asset.id, [`${input.group}.${input.field}`], limit + 1);
    if (writers.length > limit) omit('node_budget');
    for (const writer of writers.slice(0, limit)) {
      const ref = { kind: 'writer' as const, asset_id: asset.id, binding_id: writer.id };
      if (addNode({ kind: 'writer', ref, name: writer.name, enabled: writer.enabled })) addEdge(input, ref, 'updated_by');
    }
  }
  if (context.signal?.aborted) throw new Error('Context read cancelled');
  if (!allowed({ collection: 'asset', id: root.asset_id })) throw new Error('Context permissions changed. Refresh before relying on this result.');
  if (size() > ASSET_CONTEXT_LIMITS.bytes) throw new Error('This context is too large. Open the asset to review it.');
  return packet;
};

export const createAssetFactContextReader = (deps: AssetFactContextDeps) => (request: AssetFactContextRequest, context: SituationReadContext): AssetFactContext =>
  deps.snapshot ? deps.snapshot(() => readAssetFactContext(deps, request, context)) : readAssetFactContext(deps, request, context);
