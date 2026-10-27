import { assetFactRefKey, assetFieldValue, assetRuleInput, parseAssetFactContextRequest, parseQualifiedWorkEntityId, SITUATION_CONTEXT_MAX_BYTES,
  type AssetEvidence, type AssetFactContext, type AssetFactContextNode, type AssetFactContextRef,
  type AssetFactContextRequest, type AssetFieldRef, type SituationRef, type AssetWriterDelivery, type AssetWriterDeliveryOutcome } from '@recued/contracts';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import type Database from 'better-sqlite3';
import type { SituationReadContext } from './query.js';
import { situationSourceAccess } from './sources.js';
import { assetFieldProjectionValue, assetProjectionReadOf, rememberAssetContextRead, rememberAssetGraphRead } from './asset-projection-provenance.js';
export { parseAssetFactContextRequest } from '@recued/contracts';

export const ASSET_CONTEXT_LIMITS = { nodes: 40, edges: 60, bytes: SITUATION_CONTEXT_MAX_BYTES } as const;
export interface AssetContextWriter { id: string; name: string; fields: string[]; enabled: boolean; delivery?: AssetWriterDelivery }
export type AssetContextWriterReader = ((asset_id: string, fields: readonly string[], limit: number) => AssetContextWriter[]) & {
  disabledCount?(asset_id: string, fields: readonly string[]): number;
};
/** Adapter over existing writer relationships, bounded in SQL before decoding. */
export const assetContextWriters = (db: Database.Database, name: (actor: string) => string = actor => actor): AssetContextWriterReader =>
  Object.assign((asset_id: string, fields: readonly string[], limit: number): AssetContextWriter[] => {
    if (!fields.length) return [];
    const rows = db.prepare(`SELECT b.id,b.actor_ref,b.fields,b.enabled,d.at,d.observation_at,d.outcome,d.accepted_at,d.accepted_observation_at
      FROM (SELECT id,actor_ref,fields,enabled FROM asset_observation_binding WHERE asset_id=? AND enabled=1
        AND EXISTS(SELECT 1 FROM json_each(asset_observation_binding.fields) WHERE value IN (${fields.map(() => '?').join(',')}))
        ORDER BY id LIMIT ?) b
      LEFT JOIN asset_observation_delivery d ON d.binding_id=b.id AND d.path=? ORDER BY b.id`)
      .all(asset_id, ...fields, Math.min(ASSET_CONTEXT_LIMITS.nodes + 1, Math.max(1, limit)), fields.length === 1 ? fields[0] : null) as Array<{ id: string; actor_ref: string; fields: string; enabled: number;
        at: number | null; observation_at: number; outcome: AssetWriterDeliveryOutcome; accepted_at: number | null; accepted_observation_at: number }>;
    return rows.map(row => ({ id: row.id, name: name(row.actor_ref), fields: JSON.parse(row.fields) as string[], enabled: row.enabled === 1,
      ...(fields.length === 1 ? { delivery: row.at === null ? { status: 'no_receipt' as const } : { status: 'recorded' as const,
        last_submission: { at: row.at, observation_at: row.observation_at, outcome: row.outcome },
        ...(row.accepted_at !== null ? { last_accepted: { at: row.accepted_at, observation_at: row.accepted_observation_at } } : {}) } } : {}) }));
  }, { disabledCount(asset_id: string, fields: readonly string[]): number {
    if (!fields.length) return 0;
    return (db.prepare(`SELECT COUNT(*) AS count FROM asset_observation_binding WHERE asset_id=? AND enabled=0
      AND EXISTS(SELECT 1 FROM json_each(asset_observation_binding.fields) WHERE value IN (${fields.map(() => '?').join(',')}))`)
      .get(asset_id, ...fields) as { count: number }).count;
  } });
export interface AssetFactContextDeps {
  work: Pick<WorkEntityStore, 'readAsset' | 'getSource' | 'localIdBySourceIdentity'>;
  now?: () => number;
  referenceSphere?: SituationReadContext['referenceSphere'];
  /** The adapter must enforce the requested row limit before materializing. */
  writers?: AssetContextWriterReader;
  snapshot?<T>(read: () => T): T;
}
const fieldName = (value: string) => value.replaceAll('_', ' ');

/** One root, at most two relationship hops. No snapshot refresh, cache, or writes.
 * Read grants and sphere fences are applied before returning values or links. */
const readAssetFactContext = (deps: AssetFactContextDeps, raw: AssetFactContextRequest, context: SituationReadContext, fieldOnly = false): AssetFactContext => {
  const { root: requested } = parseAssetFactContextRequest(raw);
  if (context.signal?.aborted) throw new Error('Context read cancelled');
  const collectionAllowed = (ref: SituationRef): boolean => {
    const access = situationSourceAccess(ref.collection);
    return Boolean(access && context.grants.isVerbOpGranted(access.verb_op) && context.grants.isCollectionReadGranted(access.collection));
  };
  const sphereAllowed = (ref: SituationRef): boolean => {
    if (context.owner || context.all_spheres) return true;
    const sphere = context.referenceSphere?.(ref) ?? deps.referenceSphere?.(ref);
    return sphere !== undefined && context.spheres?.includes(sphere) === true;
  };
  const allowed = (ref: SituationRef): boolean => collectionAllowed(ref) && sphereAllowed(ref);
  // Check grants before resolving even metadata. A qualified spelling is an
  // identity, never a permission or a sphere placement.
  if (!collectionAllowed({ collection: 'asset', id: requested.asset_id })) throw new Error('This context is not available with the current read permissions');
  const qualified = parseQualifiedWorkEntityId(requested.asset_id);
  let id = requested.asset_id;
  if (qualified) {
    if (qualified.kind !== 'asset') throw new Error('Choose an asset identity for fact context');
    const source = deps.work.getSource(qualified.source_id);
    if (!source || source.top_tier_kind !== 'asset' || source.sync_posture === 'read_through') throw new Error('Asset source is not available for retained fact context');
    const local = qualified.identity === 'local' ? qualified.record_id
      : deps.work.localIdBySourceIdentity('asset', qualified.source_id, qualified.record_id);
    if (local === null) throw new Error('Asset not available');
    id = local;
  }
  if (!sphereAllowed({ collection: 'asset', id })) throw new Error('This context is not available with the current read permissions');
  const asset = deps.work.readAsset(id);
  if (!asset || asset.deleted_at != null || !['live', 'stale_unreachable'].includes(asset.sync_state)) throw new Error('Asset not available');
  if (qualified && (asset.id !== id || asset.source_id !== qualified.source_id || qualified.identity === 'source' && asset.source_record_id !== qualified.record_id))
    throw new Error('Asset source identity does not match. Refresh the asset search.');
  // Every root, node, edge, writer lookup and source receipt uses the same
  // canonical local identity, regardless of the request's valid spelling.
  const root = { ...requested, asset_id: asset.id };
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
  const finish = (): AssetFactContext => {
    if (context.signal?.aborted) throw new Error('Context read cancelled');
    if (!allowed({ collection: 'asset', id: root.asset_id })) throw new Error('Context permissions changed. Refresh before relying on this result.');
    if (size() > ASSET_CONTEXT_LIMITS.bytes) throw new Error('This context is too large. Open the asset to review it.');
    rememberAssetContextRead(asset, packet);
    if (!fieldOnly) rememberAssetGraphRead(asset, packet);
    return packet;
  };
  // A version covers this retained field value and known flag, not its graph.
  // Keep the same root normalization, omission budget and authority fence.
  if (fieldOnly) return finish();
  const path = `${input.group}.${input.field}`;
  const writable = input.group === 'readings' || input.group === 'observations';
  packet.writer_check = { scope: 'enabled_bindings', field: path, execution_status: 'not_checked', status: !writable ? 'not_applicable' : !context.owner ? 'restricted' : 'unavailable',
    ...(writable && context.owner ? { manual_priority: asset.field_sources[path]?.kind === 'owner' && asset.automatic_updates?.[path] === undefined } : {}) };
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
      if (addNode({ kind: 'writer', ref, name: writer.name, enabled: writer.enabled, ...(writer.delivery ? { delivery: writer.delivery } : {}) })) addEdge(input, ref, 'updated_by');
    }
    const complete = writers.length <= limit && writers.every(writer => packet.edges.some(edge => edge.kind === 'updated_by' && edge.to.kind === 'writer' && edge.to.binding_id === writer.id));
    packet.writer_check.status = complete ? 'complete' : 'partial';
    if (complete) packet.writer_check.enabled_count = writers.length;
    const disabled = deps.writers.disabledCount?.(asset.id, [path]);
    if (disabled !== undefined) { packet.writer_check.scope = 'registered_bindings'; packet.writer_check.disabled_count = disabled; }
  }
  return finish();
};

export const createAssetFactContextReader = (deps: AssetFactContextDeps) => {
  const read = (request: AssetFactContextRequest, context: SituationReadContext, fieldOnly = false): AssetFactContext =>
    deps.snapshot ? deps.snapshot(() => readAssetFactContext(deps, request, context, fieldOnly)) : readAssetFactContext(deps, request, context, fieldOnly);
  return Object.assign((request: AssetFactContextRequest, context: SituationReadContext) => read(request, context), {
    /** Native field version only; no relationships, writer page or values leave
     * this seam. Unsupported and byte-omitted fields cannot mint a version. */
    fieldVersion(request: AssetFactContextRequest, context: SituationReadContext): string | undefined {
      if (request.root.kind !== 'field') return undefined;
      const node = read(request, context, true).nodes[0];
      return node?.kind === 'field' && !node.value_omitted
        ? assetProjectionReadOf(node, assetFieldProjectionValue(node))?.read_version : undefined;
    },
  });
};
