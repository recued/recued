import { parseAssetFactContextRequest, type AssetFieldRef, type AssetRuleRef } from './asset-fact-context.js';

/** Host-kept sources that a successful native asset/document/field/graph read returned.
 * These locate evidence, never grant access or prove a model's interpretation.
 * Links open the current source; read_at/read_version describe the earlier read. */
interface CitationRead {
  readonly id: string;
  readonly label: string;
  readonly read_at: number;
  readonly read_version: string;
}

export type ChatAssetContextRoot = Omit<AssetFieldRef, 'asset_id'> | Omit<AssetRuleRef, 'asset_id'>;
/** Returned saved fields or a bounded relationship view, never a complete asset. */
export type ChatAssetProjectionScope = { readonly kind: 'details' }
  | { readonly kind: 'field'; readonly field: string }
  | { readonly kind: 'context'; readonly root: ChatAssetContextRoot };

export type ChatSourceCitation = CitationRead & (
  | { readonly kind: 'asset'; readonly asset_id: string }
  | { readonly kind: 'asset_projection'; readonly asset_id: string; readonly projection: ChatAssetProjectionScope }
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
    else if (row.kind === 'asset_projection' && text(row.asset_id, 1024) && !row.asset_id.startsWith('we1:')
      && row.projection && typeof row.projection === 'object' && !Array.isArray(row.projection)) {
      const scope = row.projection as Record<string, unknown>;
      if (scope.kind === 'details' && Object.keys(scope).every(key => key === 'kind')) {
        citation = { ...read, kind: 'asset_projection', asset_id: row.asset_id, projection: { kind: 'details' } };
      } else if (scope.kind === 'field' && Object.keys(scope).every(key => key === 'kind' || key === 'field')
        && typeof scope.field === 'string' && /^(?:attributes|settings|dates|readings|observations)\.[a-z][a-z0-9_]{0,63}$/u.test(scope.field)) {
        citation = { ...read, kind: 'asset_projection', asset_id: row.asset_id, projection: { kind: 'field', field: scope.field } };
      } else if (scope.kind === 'context' && Object.keys(scope).every(key => key === 'kind' || key === 'root')
        && scope.root && typeof scope.root === 'object' && !Array.isArray(scope.root) && !Object.hasOwn(scope.root, 'asset_id')) {
        try {
          const { asset_id: _asset, ...root } = parseAssetFactContextRequest({ root: { ...scope.root, asset_id: row.asset_id } }).root;
          citation = { ...read, kind: 'asset_projection', asset_id: row.asset_id, projection: { kind: 'context', root } };
        } catch { continue; }
      } else continue;
    }
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
