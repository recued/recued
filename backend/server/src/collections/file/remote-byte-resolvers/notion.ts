/** D-192 remote byte-fetch (follow-on B) — the Notion vendor resolver.
 *
 *  Notion file urls are ~1h-signed, so the mirror stores the LOCATOR, never a
 *  url — a byte read must RE-RESOLVE. Notion has two file homes (the list leaf's
 *  two prongs), and only one is re-resolvable:
 *
 *   - PRONG 1 (block-attached files) — `remote_id` is the bare block UUID (no
 *     colon). Re-fetch `GET /v1/blocks/{id}` → the block carries a FRESH signed
 *     `file.url` (Notion-hosted) or a permanent `external.url` → download it.
 *   - PRONG 2 (data-source `files`-property files) — `remote_id` is a synthetic
 *     `rowId:propId:discriminator` key (colon-joined, NOT a Notion API object
 *     id), so there is no block to re-resolve. These are `remote_unresolvable`
 *     (Fork E — a documented, permanent per-row gap, not a transient failure).
 *
 *  The two prongs' `remote_id` namespaces are disjoint — a bare block UUID never
 *  contains `:`, a property key always does — so a single `includes(':')` cleanly
 *  routes the gap.
 *
 *  The signed / external url is downloaded WITHOUT the Notion bearer (it is a
 *  pre-authenticated S3 url or an arbitrary external host). Notion file objects
 *  carry no mime, so the mime comes from the download response `Content-Type`.
 *
 *  Design: D-192 (Fork E). */

import { RpcError } from '@recued/contracts';

import type { RemoteFileByteResolver } from '../remote-file-byte-resolver.js';
import type { FileFetch } from '../../../file-source-adapters/index.js';
import { NOTION_API, NOTION_VERSION } from '../../../file-source-adapters/notion.js';
import { fetchFileSourceApi } from '../../../file-source-adapters/http-json.js';
import { bearerTokenOrThrow, fetchRemoteBytes } from './http-bytes.js';

/** Block types that carry a file payload — mirrors the list leaf's
 *  `FILE_BLOCK_TYPES` (the projector only mirrors these). */
const FILE_BLOCK_TYPES: ReadonlySet<string> = new Set(['file', 'image', 'pdf', 'video', 'audio']);

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Pull the fresh download url out of a re-fetched block: `block[block.type]` →
 *  `{ type:'file', file:{url} }` (Notion-hosted, ~1h-signed) or
 *  `{ type:'external', external:{url} }`. undefined when the block is no longer a
 *  file block or carries no usable url (deleted / type-changed since the mirror). */
const urlFromBlock = (block: Record<string, unknown>): string | undefined => {
  const type = typeof block.type === 'string' ? block.type : undefined;
  if (type === undefined || !FILE_BLOCK_TYPES.has(type)) return undefined;
  const payload = asRecord(block[type]);
  if (payload === undefined) return undefined;
  const hosted = asRecord(payload.file)?.url;
  if (typeof hosted === 'string' && hosted.length > 0) return hosted;
  const external = asRecord(payload.external)?.url;
  if (typeof external === 'string' && external.length > 0) return external;
  return undefined;
};

export interface NotionRemoteByteResolverDeps {
  fetchImpl: FileFetch;
}

/** Build the `notion` `RemoteFileByteResolver`. */
export const buildNotionRemoteByteResolver = (
  deps: NotionRemoteByteResolverDeps,
): RemoteFileByteResolver => async (req) => {
  // A colon ⇒ a prong-2 synthetic key — permanently unresolvable (no block).
  if (req.remote_id.includes(':')) {
    throw new RpcError(
      'remote_unresolvable',
      `notion property file '${req.remote_id}' has no re-resolvable block (data-source prong-2)`,
      422,
    );
  }
  const token = bearerTokenOrThrow(req.cred, 'notion');
  // Re-resolve the block → a fresh signed url (the stored locator is the block
  // id; Notion urls rotate hourly, so a stored url is never trusted).
  let body: unknown;
  try {
    const res = await fetchFileSourceApi(
      deps.fetchImpl,
      `${NOTION_API}/blocks/${encodeURIComponent(req.remote_id)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION },
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RpcError(
        'remote_fetch_failed',
        `notion block '${req.remote_id}' → HTTP ${res.status} ${text.slice(0, 200)}`,
        502,
      );
    }
    body = await res.json();
  } catch (err) {
    if (err instanceof RpcError) throw err;
    throw new RpcError(
      'remote_fetch_failed',
      `notion block resolve failed for '${req.remote_id}': ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
  const block = asRecord(body);
  const url = block !== undefined ? urlFromBlock(block) : undefined;
  if (url === undefined) {
    throw new RpcError(
      'remote_unresolvable',
      `notion block '${req.remote_id}' no longer carries a file url`,
      422,
    );
  }
  // Download the signed / external url WITHOUT the Notion bearer (pre-authorized
  // S3 url / external host).
  return fetchRemoteBytes({
    fetchImpl: deps.fetchImpl,
    url,
    headers: {},
    maxBytes: req.maxBytes,
    vendorLabel: 'notion',
    ref: req.remote_id,
  });
};
