import { assetFactRefKey, SITUATION_CONTEXT_MAX_BYTES, type AssetEvidence, type AssetFactContext, type AssetFactContextNode, type AssetFactContextRef } from '@recued/contracts';

const tagged = <T extends object>(value: T, entity: string): T => Object.assign({ ...value }, { __entity: entity });
const evidence = (value: AssetEvidence): AssetEvidence => tagged(structuredClone(value), 'asset_context_evidence');
const ref = <T extends AssetFactContextRef>(value: T): T => {
  const copy = structuredClone(value);
  if (copy.kind === 'evidence') copy.evidence = evidence(copy.evidence);
  return tagged(copy, 'asset_context_ref');
};
const node = (value: AssetFactContextNode): AssetFactContextNode => {
  switch (value.kind) {
    case 'field': return tagged({ ...structuredClone(value), ref: ref(value.ref) }, 'asset_context_node');
    case 'rule': return tagged({ ...structuredClone(value), ref: ref(value.ref) }, 'asset_context_node');
    case 'writer': return tagged({ ...structuredClone(value), ref: ref(value.ref) }, 'asset_context_node');
    case 'evidence': return tagged({ ...structuredClone(value), ref: ref(value.ref), evidence: evidence(value.evidence) }, 'asset_context_node');
  }
};

/** Every identity and content-bearing node enters the normal egress resolver.
 * Marker bytes count against the same context budget as the canonical packet. */
export const assetContextModelProjection = (input: AssetFactContext): AssetFactContext => {
  const result: AssetFactContext = { ...structuredClone(input), root: ref(input.root),
    asset: tagged(input.asset, 'asset_context_asset'),
    nodes: input.nodes.map(node),
    edges: input.edges.map(edge => ({ ...edge, from: ref(edge.from), to: ref(edge.to) })), missing: input.missing.map(ref) };
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > SITUATION_CONTEXT_MAX_BYTES && result.nodes.length > 1) {
    const removedNode = result.nodes.pop()!;
    const removed = assetFactRefKey(removedNode.ref);
    if (removedNode.kind === 'writer' && result.writer_check?.status === 'complete') {
      result.writer_check.status = 'partial'; delete result.writer_check.enabled_count;
    }
    result.edges = result.edges.filter(edge => assetFactRefKey(edge.from) !== removed && assetFactRefKey(edge.to) !== removed);
    result.missing = result.missing.filter(item => assetFactRefKey(item) !== removed);
    result.completeness = 'partial'; if (!result.omitted.includes('byte_budget')) result.omitted.push('byte_budget');
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > SITUATION_CONTEXT_MAX_BYTES) throw new Error('This context is too large for the model packet');
  return result;
};
