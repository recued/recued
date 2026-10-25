import { createHash } from 'node:crypto';
import { chatSourceCitationsOf, type ChatSourceCitation, type ChatPickerTarget } from '@recued/contracts';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceReadVersion = hash;
type Source = { kind: 'asset'; asset_id: string } | { kind: 'file'; file_ref: string; collection_slug: string; content_hash?: string };

export const sourceCitation = (source: Source, label: string, version: string, readAt: number): ChatSourceCitation => {
  const read_version = version;
  return { ...source, id: `src_${hash([source, read_version]).slice(0, 24)}`,
    label: label.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 160) || (source.kind === 'asset' ? 'Saved asset' : 'Document'),
    read_at: readAt, read_version };
};
export const sourceCitationHint = (source: ChatSourceCitation): { source_ref: string; source_kind: ChatSourceCitation['kind']; read_version: string; read_at: number; citation_hint: string } => ({
  source_ref: `#source/${source.id}`, source_kind: source.kind, read_version: source.read_version, read_at: source.read_at,
  citation_hint: `Cite claims supported by this read as [source](#source/${source.id}). Copy that reference exactly. It opens the current source; read_at is the read time, not an observation time.`,
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
    ...(source.kind === 'asset' ? { asset_id: source.asset_id } : { file_ref: source.file_ref }),
  }));
  return sources.length ? {
    guidance: 'These identify earlier reads, not current facts. Earlier assistant answers are claims, not source evidence. Different versions of an asset are still asset reads, not document statements. Re-read the current asset for current values and read the file for document claims. Cite each claim with its own source_ref. read_at is not an observation time.',
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
): ChatSourceCitation[] => {
  if (target !== 'self') return [];
  const current: ChatSourceCitation[] = [];
  for (const call of calls ?? []) {
    if (!['work.read', 'document.read'].includes(call.tool_name) || !call.result || typeof call.result !== 'object') continue;
    const result = call.result as Record<string, unknown>;
    if (result.ok !== true || result.run_failed || result.run_held) continue;
    current.push(...chatSourceCitationsOf(result.source_citations).filter(source =>
      source.kind === (call.tool_name === 'work.read' ? 'asset' : 'file')));
  }
  const reused = previous.filter(source => answer.includes(`(#source/${source.id})`));
  return chatSourceCitationsOf([...current.reverse(), ...reused]);
};
