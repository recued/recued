import { attachSourceFacts } from './chat-source-facts.js';
import { assetFactRefKey, chatSourceCitationsOf, CHAT_SOURCE_CITATION_LIMIT, type ChatSourceCitation, type SituationResult } from '@recued/contracts';
import { ASSET_PROJECTION_CITATION_GUIDANCE, ASSET_CONTEXT_CITATION_GUIDANCE, ASSET_COMPARISON_READ_GUIDANCE, sourceCitation } from './chat-source-citations.js';
import { assetFieldProjectionValue, assetProjectionReadOf, assetGraphReadOf, type AssetProjectionRead } from './situations/asset-projection-provenance.js';

/** The Markdown is ready to copy; a raw locator or source_ref is not a link. */
export const projectionCitationHint = (source: Extract<ChatSourceCitation, { kind: 'asset_projection' }>, resultPaths: string[]) => ({
  source_ref: `#source/${source.id}`, citation: `[${source.projection.kind === 'context' ? 'relationships' : 'source'}](#source/${source.id})`, source_kind: source.kind,
  read_version: source.read_version, read_at: source.read_at, result_paths: resultPaths,
  projection: source.projection.kind === 'context' ? { kind: 'context' as const } : source.projection,
  ...(source.projection.kind === 'context' ? { claim_scope: 'Returned declared rules, copied support, relationships, writer_check and writer field-submission receipts.' }
    : source.projection.kind === 'field' ? { claim_scope: 'Only this field value and known state; excludes copied support, rules and writers.' } : {}),
});

/** Native query output only. Result paths distinguish saved fields from the
 * bounded native graph; neither covers computed situation clocks. No
 * lookup, extra asset read, write or serialized attestation is introduced. */
export const situationSourceCitations = (native: SituationResult, rendered: SituationResult) => {
  const citations = new Map<string, ChatSourceCitation>();
  const paths = new Map<string, string[]>();
  const omitted = new Set<string>();
  const add = (read: AssetProjectionRead | undefined, resultPaths: string[]): void => {
    if (!read) return;
    const candidate = sourceCitation({ kind: 'asset_projection', asset_id: read.asset_id, projection: read.projection },
      read.name, read.read_version, read.read_at);
    const citation = chatSourceCitationsOf([candidate])[0];
    if (!citation) return;
    if (!citations.has(citation.id) && citations.size >= CHAT_SOURCE_CITATION_LIMIT) { omitted.add(citation.id); return; }
    citations.set(citation.id, citation);
    paths.set(citation.id, [...(paths.get(citation.id) ?? []), ...resultPaths]);
  };
  rendered.clusters.forEach((cluster, ci) => cluster.items.forEach((item, ii) => {
    if (item.ref.collection !== 'asset' || !item.details) return;
    const original = native.clusters[ci]?.items[ii];
    if (!original?.details) return;
    const read = assetProjectionReadOf(original.details, item.details);
    if (read?.asset_id !== item.ref.id) return;
    add(read, [`/clusters/${ci}/items/${ii}/details`]);
  }));
  const fields = new Map(native.fact_context?.nodes.filter(node => node.kind === 'field').map(node => [assetFactRefKey(node.ref), node]));
  rendered.fact_context?.nodes.forEach((node, index) => {
    if (node.kind !== 'field' || node.value_omitted) return;
    const original = fields.get(assetFactRefKey(node.ref));
    if (!original || original.kind !== 'field') return;
    add(assetProjectionReadOf(original, assetFieldProjectionValue(node)),
      [`/fact_context/nodes/${index}/value`, `/fact_context/nodes/${index}/known`]);
  });
  if (native.fact_context && rendered.fact_context) add(assetGraphReadOf(native.fact_context, rendered.fact_context), ['/fact_context']);
  if (!citations.size) return { result: rendered };
  const sources = [...citations.values()];
  return { source_citations: sources, result: attachSourceFacts({ ...rendered,
    citation_hint: ASSET_PROJECTION_CITATION_GUIDANCE + ' ' + ASSET_COMPARISON_READ_GUIDANCE + (sources.some(source => source.kind === 'asset_projection' && source.projection.kind === 'context') ? ' ' + ASSET_CONTEXT_CITATION_GUIDANCE : ''),
    citation_sources: sources.filter((source): source is Extract<ChatSourceCitation, { kind: 'asset_projection' }> => source.kind === 'asset_projection')
      .map(source => projectionCitationHint(source, paths.get(source.id)!)),
    ...(omitted.size ? { citations_omitted: omitted.size } : {}),
  }, rendered.fact_context, sources) };
};
