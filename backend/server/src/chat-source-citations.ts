import { createHash } from 'node:crypto';
import { chatSourceCitationsOf, type ChatSourceCitation, type ChatPickerTarget } from '@recued/contracts';
import { isProjectionRefresh } from './chat-projection-refresh.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceReadVersion = hash;
type Source = Omit<Extract<ChatSourceCitation, { kind: 'asset_projection' }>, 'id' | 'label' | 'read_at' | 'read_version'>
  | { kind: 'asset'; asset_id: string } | { kind: 'file'; file_ref: string; collection_slug: string; content_hash?: string };

export const ASSET_PROJECTION_CITATION_GUIDANCE =
  'Copy the returned citation Markdown beside each saved-value claim; a bare source_ref or asset id is not a clickable citation. Cite only its exact result_paths. An asset projection covers only that returned '
  + 'saved-field view, not a complete asset, document, computed situation dimension or graph relationship. '
  + 'Omitted or shortened values and linked evidence are not complete source contents. '
  + 'read_at is the source-read time. readings.*.as_of and observations.*.as_of are observation times; '
  + 'record/provenance times describe saving. Preserve known dates and their precision; if only time-of-day is missing, say that. '
  + 'Copied evidence is saved text from its stated source, a rule definition is declared configuration, a verdict is computed inference, and an edge describes a relationship. Keep these roles distinct. '
  + 'Use work.read for the complete current asset and document.read for document contents.';

export const MISSING_OBSERVATION_TIME_GUIDANCE =
  'If observation time is unavailable, name that missing time specifically. Do not say there are no timestamps: '
  + 'save/provenance or document-written times may still be present.';

// Schema meanings, not extracted dates or assertions that any field exists.
// Keep this beside both current reads and retained source identities so a fold
// cannot silently turn a written/saved date into an observation date.
const sourceTimeGuidance = (kinds: readonly ChatSourceCitation['kind'][]): string => [
  ...(kinds.includes('asset') || kinds.includes('asset_projection') ? [
    'Asset created_at and updated_at are record timestamps; field_sources.*.at records fact provenance. '
    + 'They do not establish when a measurement was observed. For a structured observation use the relevant '
    + 'readings.*.as_of or observations.*.as_of; preserve an explicit observation time and its precision.',
  ] : []),
  ...(kinds.includes('asset_projection') ? [ASSET_PROJECTION_CITATION_GUIDANCE] : []),
  ...(kinds.includes('file') ? [
    'Keep each document date in its stated role. A written, uploaded or modified date does not establish '
    + 'when a measurement was observed. Do not call a measurement a reading from that date unless the text '
    + 'dates the observation itself. Preserve an explicitly stated observation date separately from the written date.',
  ] : []),
  MISSING_OBSERVATION_TIME_GUIDANCE,
].join(' ');

export const sourceCitation = <T extends Source>(source: T, label: string, version: string, readAt: number): T & {
  id: string; label: string; read_version: string; read_at: number;
} => {
  const read_version = version;
  return { ...source, id: `src_${hash([source, read_version]).slice(0, 24)}`,
    label: label.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 160) || (source.kind === 'file' ? 'Document' : 'Saved asset'),
    read_at: readAt, read_version };
};
export const sourceCitationHint = (source: ChatSourceCitation): { source_ref: string; source_kind: ChatSourceCitation['kind']; read_version: string; read_at: number; citation_hint: string } => ({
  source_ref: `#source/${source.id}`, source_kind: source.kind, read_version: source.read_version, read_at: source.read_at,
  citation_hint: `Cite claims supported by this read as [source](#source/${source.id}). Copy that reference exactly. It opens the current source; read_at is the read time, not an observation time. ${sourceTimeGuidance([source.kind])}`,
});

/** Earlier prose contains opaque citation handles. Preserve their source kind
 * and version when that prose survives context fitting. These are identities,
 * never cached fact values or permission to read the target. The caller supplies
 * only the already-loaded provenance from this same owner's conversation. */
export const priorSourceReads = (
  previous: readonly ChatSourceCitation[],
  content: { chat_tail: readonly { content: string }[]; user_message: string },
) => {
  const referenced = new Set([content.user_message, ...content.chat_tail.map(message => message.content)]
    .flatMap(text => text.match(/#source\/src_[a-f0-9]{24}\b/gu) ?? []));
  const sources = chatSourceCitationsOf(previous).filter(source => referenced.has(`#source/${source.id}`)).map(source => ({
    __entity: 'chat_source_reference' as const,
    source_ref: `#source/${source.id}`, kind: source.kind, read_version: source.read_version, read_at: source.read_at,
    ...(source.kind === 'file' ? { file_ref: source.file_ref } : { asset_id: source.asset_id }),
    ...(source.kind === 'asset_projection' ? { projection: source.projection } : {}),
  }));
  return sources.length ? {
    guidance: 'These identify earlier reads, not current facts. Earlier assistant answers are claims, not source evidence. Different versions of an asset are still asset reads, not document statements. Re-read the current asset for current values and read the file for document claims. Cite each claim with its own source_ref. read_at is not an observation time. '
      + sourceTimeGuidance(sources.map(source => source.kind)),
    sources,
  } : undefined;
};

/** Only first-party read outcomes supply new targets. A model/peer result, held
 * run, search hit or lookalike nested in a document body cannot mint one.
 * Reused references must already be server-kept in this same conversation. */
export const answerSourceCitations = (
  target: ChatPickerTarget,
  calls: readonly { tool_name: string; result?: unknown }[] | undefined,
  previous: readonly ChatSourceCitation[],
  answer: string,
  nativePrefetch: readonly ChatSourceCitation[] = [],
): ChatSourceCitation[] => {
  if (target !== 'self') return [];
  const current: ChatSourceCitation[] = [];
  for (const call of calls ?? []) {
    if (!['work.read', 'document.read', 'situation.query'].includes(call.tool_name) || !call.result || typeof call.result !== 'object') continue;
    const result = call.result as Record<string, unknown>;
    if (result.ok !== true || result.run_failed || result.run_held) continue;
    current.push(...chatSourceCitationsOf(result.source_citations).filter(source =>
      source.kind === (call.tool_name === 'work.read' ? 'asset' : call.tool_name === 'document.read' ? 'file' : 'asset_projection')
      && (!isProjectionRefresh(result) || answer.includes(`(#source/${source.id})`))));
  }
  // Only cited, actually exposed native prefetch sources belong to this answer;
  // other matching assets must not appear as sources for unrelated claims.
  const reused = [...nativePrefetch.filter(source => source.kind === 'asset_projection'), ...previous]
    .filter(source => answer.includes(`(#source/${source.id})`));
  return chatSourceCitationsOf([...current.reverse(), ...reused]);
};
