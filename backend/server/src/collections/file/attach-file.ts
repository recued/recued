/** D-172 Phase 2 (Attachments-v2) — `attachFile` link writer.
 *
 *  A first-class helper over the live `handleLinkWrite` (annotation
 *  store `link()`): associate a `data.file.received` record to a
 *  warehouse entity (contact / project / work-entity) by writing a
 *  `data.link` with `role: 'attachment'`. This is the canonical
 *  attachment representation D2 picks (`data.link`, SQL-friendly) and
 *  the writer the spec § A.3 / N.3 calls for.
 *
 *  Direction (N.3): `{ from: <entity>, to: <file>, role: 'attachment' }`.
 *  The entity is the link's `from` endpoint (`to_collection` /
 *  `to_id` in the caller's terms — the thing the file belongs *to*);
 *  the file is the `to` endpoint (`'file'` platform, the record's
 *  per-ingest `record_id`). The two index sides of the `link` table
 *  then power inline surfacing in BOTH directions:
 *    - `{{data.<entity_collection>.<entity_id>.links.attachment}}`
 *      → file records (outbound from the entity);
 *    - `{{data.file.<file_id>.inbound_links.attachment}}`
 *      → owning entities (inbound to the file).
 *
 *  This is a PURE exported helper in P2 — the consumers are the P3
 *  reception drop-processor (§ A.5) and the A.7 mail-inbound adapter.
 *  It is NOT a standalone rpc / ingredient and needs no boot
 *  registration.
 *
 *  Two guards, matching the substrate invariants + the existing
 *  internal-writer discipline (`in-doubt-annotation-writer.ts`):
 *
 *   1. File-existence (I-1, no dangling links). The `file_id` must
 *      resolve to a live `data.file.received` record before the link
 *      is written. Mirrors `file-read-handler.ts`'s registry lookup.
 *
 *   2. Idempotency. The `link` table has NO UNIQUE constraint on
 *      `(from, to, role)` — `store.link()` always inserts a fresh row
 *      (`newId()` PK). A naive re-attach of the same (entity, file)
 *      would accrete duplicate edges. So we read the entity's outbound
 *      links first and short-circuit when an `attachment` edge to this
 *      file already exists (returning the existing link). Same
 *      read-modify guard the in-doubt writer uses for the same reason.
 *      Single-process invariant: only the daemon writes here, so the
 *      read-then-write window is race-free in practice.
 *
 *  NOTE: this writer does NOT gate on `scan_status`. The spec puts
 *  scan-gating at the parent / drop-processor level (D-172 Q2 /
 *  D-173 N.2) — the P3 drop-processor holds the attach until `clean`
 *  and warns on `flagged`. The writer is a pure mechanism.
 *
 *  Spec: D-172 § A.3 / N.3 / D2 / I-1.
 */

import { RpcError } from '@recued/contracts';
import type { Link } from '@recued/contracts';

import type { AnnotationRpcDeps } from '../../annotation-handler.js';
import { handleLinkWrite } from '../../annotation-handler.js';
import type { CollectionRegistry } from '../registry.js';
import { DATA_FILE_RECEIVED_SLUG } from './file-read-handler.js';

/** The closed `role` the attachment substrate writes. A `data.file`
 *  is associated to a warehouse entity by exactly this link role; the
 *  inline prefetch surface (`…links.attachment`) keys on it. */
export const ATTACHMENT_LINK_ROLE = 'attachment' as const;

/** Synthetic `authored_by_recipe_id` for an attachment edge written by
 *  the substrate rather than a user recipe. The underlying `LinkInput`
 *  requires a non-empty recipe id; this constant identifies the source
 *  unambiguously so audit consumers can filter attachment edges. The
 *  `recued/` prefix matches the RESERVED_HANDLES kernel namespace
 *  (CLAUDE.md § Publisher Namespaces) — "engine-emitted, not
 *  author-installable". Producers (drop / mail) may pass an explicit
 *  `authored_by` to attribute differently. */
export const ATTACH_FILE_AUTHOR_ID = 'recued/attach-file';

export interface AttachFileArgs {
  /** `data.file.received` record id (the file's per-ingest identity). */
  file_id: string;
  /** The warehouse entity the file belongs to — collection name
   *  (`'contact'` / `'project'` / `'task'` / `'commitment'` / `'note'`)
   *  and that record's id. */
  to_collection: string;
  to_id: string;
  /** Optional `authored_by_recipe_id` override. Absent → the
   *  `ATTACH_FILE_AUTHOR_ID` sentinel. */
  authored_by?: string;
}

export interface AttachFileDeps {
  /** Annotation-handler deps carrying the live `AnnotationStore`. The
   *  same shape `handleLinkWrite` consumes; the origin facet (if any)
   *  is read from here (server-injected, never spoofable). */
  annotationDeps: AnnotationRpcDeps;
  /** Collection registry — used to verify the file record exists
   *  before writing the link (no dangling links, I-1). */
  registry: CollectionRegistry;
  /** `data.file` slug to attach against. Defaults to the reserved
   *  inbound slug (`'received'`). */
  fileSlug?: string;
}

export interface AttachFileResult {
  link: Link;
  /** `true` when an attachment edge already existed and was reused
   *  (idempotent re-attach), `false` when a new edge was written. */
  already_attached: boolean;
}

const linkMatchesFile = (
  link: Link,
  fileCollection: string,
  fileId: string,
): boolean =>
  link.role === ATTACHMENT_LINK_ROLE
  && link.to_collection === fileCollection
  && link.to_id === fileId;

/** Associate a `data.file.received` record to a warehouse entity via a
 *  `role: 'attachment'` link. Idempotent on `(entity, file)`. Throws
 *  `bad_request` on malformed args and `file_not_found` (404) when the
 *  file record does not exist. */
export const attachFile = async (
  args: AttachFileArgs,
  deps: AttachFileDeps,
): Promise<AttachFileResult> => {
  const { file_id, to_collection, to_id } = args;
  if (typeof file_id !== 'string' || file_id.length === 0) {
    throw new RpcError('bad_request', 'attachFile: file_id is required', 400);
  }
  if (typeof to_collection !== 'string' || to_collection.length === 0) {
    throw new RpcError('bad_request', 'attachFile: to_collection is required', 400);
  }
  if (typeof to_id !== 'string' || to_id.length === 0) {
    throw new RpcError('bad_request', 'attachFile: to_id is required', 400);
  }

  const fileSlug = deps.fileSlug ?? DATA_FILE_RECEIVED_SLUG;
  const fileCollection = deps.registry.get('file', fileSlug);
  if (!fileCollection) {
    throw new RpcError(
      'collection_not_found',
      `attachFile: data.file.${fileSlug} collection is not registered`,
      503,
    );
  }
  // I-1 — no dangling links. The file record must exist before we
  // write the edge. Mirrors `file-read-handler.ts`'s lookup pattern.
  const fileRecord = fileCollection.get(file_id);
  if (!fileRecord) {
    throw new RpcError(
      'file_not_found',
      `attachFile: data.file.${fileSlug} record '${file_id}' not found`,
      404,
    );
  }

  // Idempotency — the `link` table has no UNIQUE on (from, to, role);
  // a re-attach of the same (entity, file) would otherwise duplicate
  // the edge. Read the entity's outbound links and reuse an existing
  // attachment edge to this file. (The file endpoint's collection is
  // the bare `'file'` platform name — what the inline prefetch resolves
  // through; NOT the slug.)
  const existing = await deps.annotationDeps.store.outboundLinks(
    to_collection,
    to_id,
  );
  const prior = existing.find((link) => linkMatchesFile(link, 'file', file_id));
  if (prior) {
    return { link: prior, already_attached: true };
  }

  // Direction per N.3: from = entity, to = file. `handleLinkWrite`
  // requires `authored_by_recipe_id`; supply the override or the
  // substrate sentinel.
  const { link } = await handleLinkWrite(deps.annotationDeps, {
    from_collection: to_collection,
    from_id: to_id,
    to_collection: 'file',
    to_id: file_id,
    role: ATTACHMENT_LINK_ROLE,
    authored_by_recipe_id: args.authored_by ?? ATTACH_FILE_AUTHOR_ID,
  });
  return { link, already_attached: false };
};
