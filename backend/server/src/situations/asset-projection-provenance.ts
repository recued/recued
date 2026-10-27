import { createHash } from 'node:crypto';
import { assetFactRefKey, type Asset, type AssetFactContext, type AssetFactContextNode, type ChatAssetProjectionScope, type SituationAssetDetails } from '@recued/contracts';

type FieldNode = Extract<AssetFactContextNode, { kind: 'field' }>;
export interface AssetProjectionRead {
  readonly asset_id: string;
  readonly name: string;
  readonly projection: ChatAssetProjectionScope;
  readonly read_at: number;
  readonly read_version: string;
}

// These are receipts for the lifetime of native read objects, not a value cache.
// Serialized results, derived lookalikes and caller-supplied markers cannot mint
// one. Authority is still checked by SituationAccess before a result is returned.
const reads = new WeakMap<object, AssetProjectionRead>();
const version = (read: Pick<AssetProjectionRead, 'asset_id' | 'name' | 'projection'>, value: unknown): string =>
  createHash('sha256').update(JSON.stringify([read.asset_id, read.name, read.projection, value])).digest('hex');
export const assetFieldProjectionValue = (node: FieldNode) => ({
  ref: { asset_id: node.ref.asset_id, group: node.ref.group, field: node.ref.field },
  value: node.value, known: node.known,
});

const remember = (asset: Asset, target: object, projection: ChatAssetProjectionScope, value: unknown, readAt: number, name = asset.name): void => {
  if (asset.source_id !== 'recued.asset' || asset.id.startsWith('we1:')) return;
  const identity = { asset_id: asset.id, name, projection: Object.freeze(projection) };
  reads.set(target, Object.freeze({ ...identity, read_at: readAt, read_version: version(identity, value) }));
};

export const rememberAssetDetailsRead = (asset: Asset, details: SituationAssetDetails, readAt: number): void =>
  remember(asset, details, { kind: 'details' }, details, readAt);

/** Only retained, actually returned field values. Rules, writers, graph edges,
 * evidence snippets and omitted values carry no saved-field attestation. */
export const rememberAssetContextRead = (asset: Asset, context: AssetFactContext): void => {
  for (const node of context.nodes) {
    if (node.kind !== 'field' || node.value_omitted) continue;
    remember(asset, node, { kind: 'field', field: `${node.ref.group}.${node.ref.field}` }, assetFieldProjectionValue(node), context.read_at,
      `${asset.name} · ${node.label}`);
  }
};

const unmarked = (value: unknown): unknown => Array.isArray(value) ? value.map(unmarked)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== '__entity').map(([key, member]) => [key, unmarked(member)])) : value;
const contextValue = (context: AssetFactContext): unknown => {
  const { read_at: _clock, ...value } = context;
  return unmarked(value);
};

/** A graph version covers only this bounded, authorized native view. Read time
 * is separate; writer state, rule definitions, evidence and omissions are not. */
export const rememberAssetGraphRead = (asset: Asset, context: AssetFactContext): void => {
  const { asset_id: _asset, ...root } = context.root;
  remember(asset, context, { kind: 'context', root }, contextValue(context), context.read_at, `${asset.name} · Relationships`);
};

/** The model adapter may drop only a suffix of nodes and its dangling links.
 * Attest that exact exposed subset with the native graph version, never an
 * edited value, injected property, serialized lookalike or borrowed receipt. */
export const assetGraphReadOf = (native: AssetFactContext, rendered: AssetFactContext): AssetProjectionRead | undefined => {
  const read = assetProjectionReadOf(native, contextValue(native));
  if (read?.projection.kind !== 'context' || native.read_at !== read.read_at || rendered.nodes.length > native.nodes.length) return undefined;
  const expected = structuredClone(native);
  const removed = expected.nodes.splice(rendered.nodes.length);
  if (removed.length) {
    const kept = new Set(expected.nodes.map(node => assetFactRefKey(node.ref)));
    expected.edges = expected.edges.filter(edge => kept.has(assetFactRefKey(edge.from)) && kept.has(assetFactRefKey(edge.to)));
    expected.missing = expected.missing.filter(ref => kept.has(assetFactRefKey(ref)));
    expected.completeness = 'partial'; if (!expected.omitted.includes('byte_budget')) expected.omitted.push('byte_budget');
    if (removed.some(node => node.kind === 'writer') && expected.writer_check?.status === 'complete') {
      expected.writer_check.status = 'partial'; delete expected.writer_check.enabled_count;
    }
  }
  return JSON.stringify(unmarked(expected)) === JSON.stringify(unmarked(rendered)) ? read : undefined;
};

/** The rendered view must still equal what the native reader attested. Model
 * markers may be added around it; changed values or fields lose the receipt. */
export const assetProjectionReadOf = (native: object, renderedValue: unknown): AssetProjectionRead | undefined => {
  const read = reads.get(native);
  return read && read.read_version === version(read, renderedValue) ? read : undefined;
};
