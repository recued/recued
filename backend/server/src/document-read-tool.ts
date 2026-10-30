/** Shared attachment reader. Conversion and byte access always use the ordinary executor. */
import { createHash } from 'node:crypto';
import type { ChatDispatchContext, ChatDispatchResult, CollectionRecord, RecipeDefinition } from '@recued/contracts';
import type { Tier1Handler } from '@recued/middleware/internal-tool-registry/index.js';
import { buildPackOpResolution } from './pack-inventory.js';
import { isCollectionReadGrantedForDispatch, wrapRecipeRunResult, type ChatToolHandlerDeps } from './chat-tool-handlers.js';
import { DOCUMENT_READ_RECIPE_ID, registerResumedRunFinisher } from './resumed-run-finishers.js';
import type { ExecuteResponse } from './types.js';
import { isWatchedFolderCollection, parseWatchedFileRecordId } from './collections/file/watched-folder-collection.js';
import { sourceCitation, sourceCitationHint } from './chat-source-citations.js';
import { watchedFileSelection } from './folder-file-attachments.js';
import { documentIndexAuthority, type DocumentIndexEntry, type DocumentSearchIndex } from './storage/document-search-index.js';

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TEXT_TYPES = ['application/json', 'application/xml', 'application/csv'];
const EXTRACTED_TOO_LARGE = 'The extracted text exceeds the 2 MB reading limit. Use a smaller document; no complete reading is claimed.';

/** Reader pages are 24,000 UTF-16 code units, one fewer where the cut would
 * split a surrogate pair, so no character is divided between two pages. */
export const READER_PAGE_CHARS = 24000;
const splitsPair = (text: string, at: number): boolean => {
  if (at <= 0 || at >= text.length) return false;
  const high = text.charCodeAt(at - 1);
  const low = text.charCodeAt(at);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
};
/** The page at `offset`, or null when `offset` is past the end or inside a character. */
export const readerPage = (text: string, offset: number): { body: string; next_offset: number | null } | null => {
  if (offset > text.length || splitsPair(text, offset)) return null;
  const cut = Math.min(text.length, offset + READER_PAGE_CHARS);
  const end = splitsPair(text, cut) ? cut - 1 : cut;
  return { body: text.slice(offset, end), next_offset: end < text.length ? end : null };
};

/** The stored MIME type's lower-case essence and any declared charset. */
const mediaType = (value: unknown): { essence: string; charset: string | undefined } => {
  const [essence = '', ...params] = String(value ?? '').split(';');
  const charset = params.map(param => {
    const at = param.indexOf('=');
    return at > 0 && param.slice(0, at).trim().toLowerCase() === 'charset'
      ? param.slice(at + 1).trim().replace(/^"|"$/gu, '').trim() : undefined;
  }).find(Boolean);
  return { essence: essence.trim().toLowerCase(), charset };
};

/** Decodes without guessing: a byte-order mark, else the declared charset,
 * else strict UTF-8. Null when that does not yield text. */
const decodeText = (bytes: Uint8Array, charset: string | undefined): string | null => {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8'
    : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : undefined;
  try {
    const text = new TextDecoder(bom ?? charset ?? 'utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? null : text;
  } catch { return null; }
};

/** Who a cached conversion was admitted for: the caller's source without its
 * per-call ids, and the contract authority version it ran under. The cache is
 * shared by every Chat, messenger and MCP caller, and a hit runs only the file
 * read, so a caller never receives a conversion its own admission did not produce. */
const callerOf = (ctx: ChatDispatchContext): string => JSON.stringify(
  [ctx.channel, ctx.execution_source ?? null, ctx.contract_snapshot === undefined ? null
    : [ctx.contract_snapshot.contract_id, ctx.contract_snapshot.contract_version]],
  (name: string, value: unknown) => (name === 'tool_call_id' || name === 'turn_id' ? undefined : value),
);

/** One fingerprint for both reading and content search. Changing a converter
 * manifest, MIME type, filename or source version retires the old extraction. */
export const documentReadPlanner = (deps: ChatToolHandlerDeps, requested: string = 'auto') => {
  const config = deps.getExecutorConfig();
  const scan = deps.documentPacks ?? deps.scanInstalledPacks;
  const resolution = scan ? buildPackOpResolution(scan, slug => config.manifests.get(slug)) : new Map();
  const choices = requested === 'auto' ? ['markitdown', 'docling'] : [requested];
  return (record: CollectionRecord, version = record.blob_hash ?? String(record.hot_fields.content_hash ?? '')) => {
    const mime = String(record.hot_fields.mime_type ?? '').toLowerCase();
    const media = mediaType(record.hot_fields.mime_type);
    const plain = media.essence.startsWith('text/') || TEXT_TYPES.includes(media.essence);
    const direct = plain && requested === 'auto';
    const converter = direct ? undefined : choices.find(name => resolution.get(`recued-core.${name}`)?.operations.has('document.to_markdown'));
    const binding = converter ? resolution.get(`recued-core.${converter}`) : undefined;
    const manifest = binding ? config.manifests.get(binding.catalog_slug) : undefined;
    const key = createHash('sha256').update(JSON.stringify([record.record_id, version, record.hot_fields.filename, mime, direct, converter ?? choices, manifest])).digest('hex');
    return { mime, media, direct, converter, choices, key };
  };
};
export const documentReadPlan = (deps: ChatToolHandlerDeps, record: CollectionRecord, requested = 'auto', version?: string) =>
  documentReadPlanner(deps, requested)(record, version);

export const documentReadRecipe = (converter?: string, metadataOnly = false): RecipeDefinition => ({
  recipe_id: DOCUMENT_READ_RECIPE_ID, version: 1, ttl: 0,
  metadata: { name: 'Read a work document', description: 'Extract readable evidence from one selected file.', author: 'recued',
    supported_platforms: [], tags: ['kernel', 'document'], budget_ms: 110000 },
  variables: { source: { type: 'file_ref', label: 'Document' } }, prefetch_steps: [],
  steps: converter ? [
    { id: 'convert', op: `recued-core.${converter}.document.to_markdown`, args: { source: '{{config.source}}' } },
    { id: 'read', op: 'core.storage.file.read-temp', args: { ref: '{{step.convert.file_ref}}' } },
  ] : [{ id: 'read', op: 'core.storage.data-file-read', args: { record_id: '{{config.source}}', ...(metadataOnly ? { metadata_only: true } : {}) } }],
  output: { render: [{ type: 'summary', source: 'step.read' }] },
});

export const createDocumentReadHandler = (deps: ChatToolHandlerDeps): Tier1Handler => {
  // Bounded process cache alongside the optional encrypted durable index. Every
  // hit re-admits the original file read; a former grant never licenses a later read.
  const cache = new Map<string, { text: string; converter: string; at: number }>();
  return async (raw, ctx) => {
    const args = object(raw);
    // A file in a folder Recued watches (`file:local:*`, from `file.search`)
    // reads too: its bytes are on disk, and its version is its revision.
    const watched = typeof args?.file_ref === 'string' ? parseWatchedFileRecordId(args.file_ref) : null;
    if (!args || typeof args.file_ref !== 'string' || (!/^file:[0-9a-f]{32}$/.test(args.file_ref) && watched === null)
      || (args.converter !== undefined && !['auto', 'markitdown', 'docling'].includes(String(args.converter)))
      || (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0))
      || (args.read_version !== undefined && (typeof args.read_version !== 'string' || !/^[0-9a-f]{64}$/.test(args.read_version)))
      || (Number(args.offset ?? 0) > 0 && args.read_version === undefined)) {
      return { ok: true, result: { status: 'invalid_arguments', hint: 'Copy the complete file_ref from the attachment or tool result, including its file: prefix. Uploaded attachments are already stored. Use a supported converter and a nonnegative character offset. Continue with both next_offset and read_version from the previous page.' } };
    }
    const execute = deps.getExecuteRecipe();
    if (!execute || !ctx.execution_source) return { ok: true, result: { status: 'unavailable', hint: 'The governed document reader is unavailable in this context.' } };
    const registry = deps.getCollectionRegistry();
    const folder = watched ? registry?.get('file', watched.slug) : undefined;
    const files = watched ? (folder && isWatchedFolderCollection(folder) ? folder : undefined) : registry?.get('file', 'received');
    const record = files?.get(args.file_ref);
    if (!record) return { ok: true, result: { status: 'unavailable', hint: watched
      ? 'This file is no longer in its folder.' : 'The selected attachment is no longer stored locally.' } };
    // A watched file's record keeps little or none of its bytes: its size is the file's.
    const sourceBytes = watched ? Number(record.hot_fields.size ?? 0) : record.size_bytes;
    /** A watched file's revision: its modified time and size, as the Files tab
     *  previews and imports it. Null once it is gone from its folder. */
    const watchedRevision = (): string | null => {
      try { return registry ? watchedFileSelection(registry, String(args.file_ref)).selection_revision : null; } catch { return null; }
    };
    if (sourceBytes > MAX_SOURCE_BYTES) return { ok: true, result: { status: 'too_large', hint: 'This attachment exceeds the 25 MB reading limit. Its contents have not been read.' } };
    const requested = String(args.converter ?? 'auto');
    const hash = watched ? watchedRevision() ?? '' : record.blob_hash ?? String(record.hot_fields.content_hash ?? '');
    const { media, direct, converter, choices, key } = documentReadPlan(deps, record, requested, hash);
    if (!direct && !converter) return { ok: true, result: { status: 'needs_pack', file_ref: args.file_ref,
      suggested_packs: requested === 'auto' ? ['markitdown', 'docling'] : choices,
      hint: 'Enable an appropriate document reader pack, then resume this investigation. MarkItDown handles ordinary documents; Docling can use OCR for scans. No attachment content has been read.' },
      // D-323 — the same packs as data, as the resolution above names them, so
      // chat can offer them under its answer.
      missing_packs: choices.map((name) => `recued-core.${name}`) };
    // Direct text is the extracted text, so its limit applies before any read.
    if (direct && sourceBytes > MAX_TEXT_BYTES) return { ok: true, result: { status: 'too_large', hint: 'This text file exceeds the 2 MB reading limit. Its contents have not been read.' } };
    if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: true, result: { status: 'unavailable', hint: 'The attachment has no verifiable content version.' } };
    const cacheKey = createHash('sha256').update(key).update(callerOf(ctx)).digest('hex');
    const previous = cache.get(cacheKey);
    const authority = documentIndexAuthority(ctx);
    let index: DocumentSearchIndex | undefined, indexed: DocumentIndexEntry | undefined;
    let searchIndexUnavailable = false;
    try {
      index = !watched ? deps.getDocumentSearchIndex?.() : undefined;
      indexed = index?.get(authority, key);
    } catch {
      // Derived search storage is optional for an ordinary document reading.
      // Its failure must not hide bytes the governed reader can still read.
      index = undefined; searchIndexUnavailable = true;
    }
    const cached = previous && Date.now() - previous.at < 15 * 60 * 1000 ? previous
      : indexed?.status === 'indexed' ? { text: indexed.text, converter: indexed.converter, at: indexed.updated_at } : undefined;
    const fileRef = args.file_ref;
    const unreadable: ChatDispatchResult = { ok: true, result: { status: 'unavailable', file_ref: args.file_ref,
      suggested_packs: converter ? [converter] : [], hint: 'The document could not be read. Check reader availability and access, then resume. The attachment remains an evidence gap.' } };
    // The reader's checks on the governed run's response: applied here, and to
    // the resumed response when an approval holds the run, so an approved
    // reading reaches its caller only through them.
    const finish = (result: ExecuteResponse): ChatDispatchResult => {
      if (!result.success) {
        // The temporary-output read refuses text past its 2 MB ceiling: this
        // reader's limit, not a failed run to persist around.
        if (converter && !cached && result.steps.some(step => step.id === 'read' && object(step.error)?.code === 'VALUE_TOO_LARGE')) {
          return { ok: true, result: { status: 'too_large', hint: EXTRACTED_TOO_LARGE } };
        }
        return wrapRecipeRunResult(result, 'document.read');
      }
      if (!isCollectionReadGrantedForDispatch(deps, ctx, 'file')) return { ok: true, result: { status: 'unavailable', hint: 'File access changed during reading. No document content is returned.' } };
      const payload = object(result.output.render[0]?.data);
      if (!cached && typeof payload?.bytes_b64 !== 'string') return { ok: true, result: { status: 'unavailable', hint: 'The document operation returned no readable bytes. Keep this evidence gap open.' } };
      const current = files!.get(fileRef);
      if (!current || (watched ? watchedRevision() !== hash
        : current.blob_hash !== record.blob_hash || current.hot_fields.content_hash !== record.hot_fields.content_hash)
        || current.hot_fields.filename !== record.hot_fields.filename || current.hot_fields.mime_type !== record.hot_fields.mime_type) {
        return { ok: true, result: { status: 'changed', hint: 'The attachment changed during extraction. Read the current version before using it.' } };
      }
      const bytes = Buffer.from(String(payload?.bytes_b64 ?? ''), 'base64');
      // A cache hit re-admits the source with a metadata-only read: the file
      // read still verifies the blob against its content address and returns
      // that hash, without carrying the bytes through the run.
      // A watched file has no content address to check its bytes against; its
      // revision was checked above.
      if (!watched && (cached ? payload?.blob_hash !== hash : !converter && createHash('sha256').update(bytes).digest('hex') !== hash)) {
        return { ok: true, result: { status: 'changed', hint: 'The bytes read did not match the selected attachment version. Restart this reading.' } };
      }
      if (!cached && bytes.byteLength > MAX_TEXT_BYTES) return { ok: true, result: { status: 'too_large', hint: EXTRACTED_TOO_LARGE } };
      const text = cached?.text ?? decodeText(bytes, direct ? media.charset : undefined);
      // A watched file's content hash is the one its bytes were read with, when
      // this reading read them; a conversion never hands its source back.
      const contentHash = !watched ? hash
        : !converter && typeof payload?.blob_hash === 'string' ? payload.blob_hash : undefined;
      if (text === null) {
        return { ok: true, result: direct ? { status: 'unsupported_encoding', file_ref: args.file_ref, ...(contentHash ? { content_hash: contentHash } : {}),
          hint: "This text file's encoding could not be determined from a byte-order mark, a declared charset or UTF-8, so it was not decoded. Retry document.read with converter set to markitdown, which may detect the encoding. No content has been read." }
          : { status: 'unsupported', hint: 'The returned content is not readable UTF-8 text.' } };
      }
      const read_version = createHash('sha256').update(key).update(text).digest('hex');
      if (args.read_version !== undefined && args.read_version !== read_version) {
        return { ok: true, result: { status: 'changed', hint: 'The source or extracted text changed between pages. Restart at offset 0; do not combine these versions.' } };
      }
      if (index && text.trim()) {
        const current = files?.get(fileRef);
        if (!current || documentReadPlan(deps, current, requested).key !== key) {
          return { ok: true, result: { status: 'changed', hint: 'The source or converter changed during reading. Read the current version before using it.' } };
        }
        if (indexed?.status !== 'indexed') {
          try {
            index.put({ authority, fingerprint: key, file_ref: fileRef, content_hash: hash, text,
              converter: converter ?? 'text', read_version, extraction_complete: direct, status: 'indexed', updated_at: (deps.now ?? Date.now)() });
          } catch { searchIndexUnavailable = true; }
        }
      }
      if (converter && !cached && text.trim()) {
        if (cache.size >= 16) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, { text, converter, at: Date.now() });
      }
      const offset = Number(args.offset ?? 0);
      const page = readerPage(text, offset);
      const citation = page?.body.trim() ? sourceCitation({ kind: 'file', file_ref: fileRef, collection_slug: watched?.slug ?? 'received',
        ...(contentHash ? { content_hash: contentHash } : {}) }, String(record.hot_fields.filename ?? 'Document'), read_version, Date.now()) : undefined;
      return { ok: true, ...(citation ? { source_citations: [citation] } : {}), result: { status: !text.trim() ? 'empty_extraction' : page === null ? 'invalid_offset' : 'read',
        file_ref: args.file_ref, ...(contentHash ? { content_hash: contentHash } : {}), read_version, filename: record.hot_fields.filename,
        converter: converter ?? 'text', cached: cached !== undefined, body: page?.body ?? '', offset,
        next_offset: page?.next_offset ?? null,
        ...(citation ? sourceCitationHint(citation) : {}),
        text_incomplete: page === null || page.next_offset !== null,
        extraction_complete: direct && text.trim().length > 0,
        ...(searchIndexUnavailable ? { search_index_unavailable: true } : {}),
        warnings: [
          ...(direct ? [] : ['Conversion may omit images, tables, annotations or layout. No page or sheet locations are asserted by this reader.']),
          ...(searchIndexUnavailable ? ['The search index is unavailable. This reading is usable, but its text may not be saved for later searches.'] : []),
        ],
        hint: text.trim() ? 'Continue using next_offset and this read_version, keeping the same converter. Cite the returned source_ref as a Markdown link, keeping content_hash as the version reference. Reading all extracted text does not prove complete extraction. Keep conclusions that depend on missing content provisional.'
          : 'No usable text was extracted. Try Docling for OCR, or ask for a readable copy. Do not infer that the attachment contains no requirements.',
      } };
    };
    try {
      const outcome = finish(await execute({ recipe: documentReadRecipe(cached ? undefined : converter, cached !== undefined),
        // A watched file goes to the converter by its id: the CLI reads it from
        // its folder (`input_materialize`); there is no content address to pin.
        config: { source: converter && !cached && !watched ? { backing: 'cas', record_id: args.file_ref, content_sha256: hash } : args.file_ref },
        trigger_source: ctx.channel === 'mcp_wire' ? 'mcp' : 'chat', execution_source: ctx.execution_source,
        ...(ctx.contract_snapshot ? { contract_snapshot: ctx.contract_snapshot } : {}),
        ...(ctx.dispatch_depth === undefined ? {} : { dispatch_depth: ctx.dispatch_depth }),
      }));
      // The caller is told "held" now. The approval resumes the run elsewhere,
      // and the resumer delivers this finish instead of the run's raw bytes.
      if (outcome.ok && outcome.run_held?.kind === 'approval' && outcome.run_id !== undefined) {
        registerResumedRunFinisher(outcome.run_id, { tool_name: 'document.read',
          finish: async resumed => { try { return finish(resumed); } catch { return unreadable; } } });
      }
      return outcome;
    } catch {
      return unreadable;
    }
  };
};
