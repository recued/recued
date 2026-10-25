/** Host-kept sources that a successful asset/document read actually returned.
 * These locate evidence, never grant access or prove a model's interpretation.
 * Links open the current source; read_at/read_version describe the earlier read. */
interface CitationRead {
  readonly id: string;
  readonly label: string;
  readonly read_at: number;
  readonly read_version: string;
}

export type ChatSourceCitation = CitationRead & (
  | { readonly kind: 'asset'; readonly asset_id: string }
  | { readonly kind: 'file'; readonly file_ref: string; readonly collection_slug: string; readonly content_hash?: string }
);

export const CHAT_SOURCE_CITATION_LIMIT = 20;
const text = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** Rebuild the closed shape at every boundary; arbitrary hrefs never survive. */
export const chatSourceCitationsOf = (value: unknown): ChatSourceCitation[] => {
  if (!Array.isArray(value)) return [];
  const result: ChatSourceCitation[] = []; const seen = new Set<string>();
  for (const raw of value) {
    if (result.length >= CHAT_SOURCE_CITATION_LIMIT) break;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== 'string' || !/^src_[a-f0-9]{24}$/u.test(row.id) || seen.has(row.id)
      || !text(row.label, 160) || !Number.isSafeInteger(row.read_at) || (Number(row.read_at) < 0 || Number(row.read_at) > 8_640_000_000_000_000) || !hash(row.read_version)) continue;
    const read = { id: row.id, label: row.label, read_at: Number(row.read_at), read_version: row.read_version };
    let citation: ChatSourceCitation;
    if (row.kind === 'asset' && text(row.asset_id, 1024)) citation = { ...read, kind: 'asset', asset_id: row.asset_id };
    else if (row.kind === 'file' && text(row.file_ref, 2048) && text(row.collection_slug, 128)
      && (/^file:[a-f0-9]{32}$/u.test(row.file_ref) || row.file_ref.startsWith('file:local:'))
      && (row.content_hash === undefined || hash(row.content_hash))) {
      citation = { ...read, kind: 'file', file_ref: row.file_ref, collection_slug: row.collection_slug,
        ...(row.content_hash === undefined ? {} : { content_hash: row.content_hash }) };
    } else continue;
    seen.add(row.id); result.push(citation);
  }
  return result;
};
