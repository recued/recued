/** Shared attachment reader. Conversion and byte access always use the ordinary executor. */
import { createHash } from 'node:crypto';
import type { ChatDispatchContext, ChatDispatchResult, RecipeDefinition } from '@recued/contracts';
import type { Tier1Handler } from '@recued/middleware/internal-tool-registry/index.js';
import { buildPackOpResolution } from './pack-inventory.js';
import { isCollectionReadGrantedForDispatch, wrapRecipeRunResult, type ChatToolHandlerDeps } from './chat-tool-handlers.js';
import { DOCUMENT_READ_RECIPE_ID, registerResumedRunFinisher } from './resumed-run-finishers.js';
import type { ExecuteResponse } from './types.js';

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
  // Bounded process cache only. No plaintext artifact is written to disk. Every
  // hit re-admits the original file read; a former grant never licenses a later read.
  const cache = new Map<string, { text: string; converter: string; at: number }>();
  return async (raw, ctx) => {
    const args = object(raw);
    if (!args || typeof args.file_ref !== 'string' || !/^file:[0-9a-f]{32}$/.test(args.file_ref)
      || (args.converter !== undefined && !['auto', 'markitdown', 'docling'].includes(String(args.converter)))
      || (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0))
      || (args.read_version !== undefined && (typeof args.read_version !== 'string' || !/^[0-9a-f]{64}$/.test(args.read_version)))
      || (Number(args.offset ?? 0) > 0 && args.read_version === undefined)) {
      return { ok: true, result: { status: 'invalid_arguments', hint: 'Use an exact local file_ref, a supported converter and a nonnegative character offset. Continue with both next_offset and read_version from the previous page.' } };
    }
    const execute = deps.getExecuteRecipe();
    if (!execute || !ctx.execution_source) return { ok: true, result: { status: 'unavailable', hint: 'The governed document reader is unavailable in this context.' } };
    const files = deps.getCollectionRegistry()?.get('file', 'received');
    const record = files?.get(args.file_ref);
    if (!record) return { ok: true, result: { status: 'unavailable', hint: 'The selected attachment is no longer stored locally.' } };
    if (record.size_bytes > MAX_SOURCE_BYTES) return { ok: true, result: { status: 'too_large', hint: 'This attachment exceeds the 25 MB reading limit. Its contents have not been read.' } };
    const mime = String(record.hot_fields.mime_type ?? '').toLowerCase();
    const media = mediaType(record.hot_fields.mime_type);
    const plain = media.essence.startsWith('text/') || TEXT_TYPES.includes(media.essence);
    const config = deps.getExecutorConfig();
    const scan = deps.documentPacks ?? deps.scanInstalledPacks;
    const resolution = scan ? buildPackOpResolution(scan, slug => config.manifests.get(slug)) : new Map();
    const requested = args.converter ?? 'auto';
    const choices = requested === 'auto' ? ['markitdown', 'docling'] : [String(requested)];
    // Text is read directly unless a converter is named; a converter may decode
    // text in an encoding this reader does not guess.
    const direct = plain && requested === 'auto';
    const converter = direct ? undefined : choices.find(name => resolution.get(`recued-core.${name}`)?.operations.has('document.to_markdown'));
    if (!direct && !converter) return { ok: true, result: { status: 'needs_pack', file_ref: args.file_ref,
      suggested_packs: requested === 'auto' ? ['markitdown', 'docling'] : choices,
      hint: 'Enable an appropriate document reader pack, then resume this investigation. MarkItDown handles ordinary documents; Docling can use OCR for scans. No attachment content has been read.' } };
    // Direct text is the extracted text, so its limit applies before any read.
    if (direct && record.size_bytes > MAX_TEXT_BYTES) return { ok: true, result: { status: 'too_large', hint: 'This text file exceeds the 2 MB reading limit. Its contents have not been read.' } };
    const binding = converter ? resolution.get(`recued-core.${converter}`) : undefined;
    const manifest = binding ? config.manifests.get(binding.catalog_slug) : undefined;
    const hash = record.blob_hash ?? String(record.hot_fields.content_hash ?? '');
    if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: true, result: { status: 'unavailable', hint: 'The attachment has no verifiable content version.' } };
    const key = createHash('sha256').update(JSON.stringify([args.file_ref, hash, record.hot_fields.filename, mime, converter, manifest])).digest('hex');
    const cacheKey = createHash('sha256').update(key).update(callerOf(ctx)).digest('hex');
    const previous = cache.get(cacheKey);
    const cached = previous && Date.now() - previous.at < 15 * 60 * 1000 ? previous : undefined;
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
      if (!current || current.blob_hash !== record.blob_hash || current.hot_fields.content_hash !== record.hot_fields.content_hash
        || current.hot_fields.filename !== record.hot_fields.filename || current.hot_fields.mime_type !== record.hot_fields.mime_type) {
        return { ok: true, result: { status: 'changed', hint: 'The attachment changed during extraction. Read the current version before using it.' } };
      }
      const bytes = Buffer.from(String(payload?.bytes_b64 ?? ''), 'base64');
      // A cache hit re-admits the source with a metadata-only read: the file
      // read still verifies the blob against its content address and returns
      // that hash, without carrying the bytes through the run.
      if (cached ? payload?.blob_hash !== hash : !converter && createHash('sha256').update(bytes).digest('hex') !== hash) {
        return { ok: true, result: { status: 'changed', hint: 'The bytes read did not match the selected attachment version. Restart this reading.' } };
      }
      if (!cached && bytes.byteLength > MAX_TEXT_BYTES) return { ok: true, result: { status: 'too_large', hint: EXTRACTED_TOO_LARGE } };
      const text = cached?.text ?? decodeText(bytes, direct ? media.charset : undefined);
      if (text === null) {
        return { ok: true, result: direct ? { status: 'unsupported_encoding', file_ref: args.file_ref, content_hash: hash,
          hint: "This text file's encoding could not be determined from a byte-order mark, a declared charset or UTF-8, so it was not decoded. Retry document.read with converter set to markitdown, which may detect the encoding. No content has been read." }
          : { status: 'unsupported', hint: 'The returned content is not readable UTF-8 text.' } };
      }
      const read_version = createHash('sha256').update(key).update(text).digest('hex');
      if (args.read_version !== undefined && args.read_version !== read_version) {
        return { ok: true, result: { status: 'changed', hint: 'The source or extracted text changed between pages. Restart at offset 0; do not combine these versions.' } };
      }
      if (converter && !cached && text.trim()) {
        if (cache.size >= 16) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, { text, converter, at: Date.now() });
      }
      const offset = Number(args.offset ?? 0);
      const page = readerPage(text, offset);
      return { ok: true, result: { status: !text.trim() ? 'empty_extraction' : page === null ? 'invalid_offset' : 'read',
        file_ref: args.file_ref, content_hash: hash, read_version, filename: record.hot_fields.filename,
        converter: converter ?? 'text', cached: cached !== undefined, body: page?.body ?? '', offset,
        next_offset: page?.next_offset ?? null,
        text_incomplete: page === null || page.next_offset !== null,
        extraction_complete: direct && text.trim().length > 0,
        warnings: direct ? [] : ['Conversion may omit images, tables, annotations or layout. No page or sheet locations are asserted by this reader.'],
        hint: text.trim() ? 'Continue using next_offset and this read_version, keeping the same converter. Cite the original file_ref and content_hash. Reading all extracted text does not prove complete extraction. Keep conclusions that depend on missing content provisional.'
          : 'No usable text was extracted. Try Docling for OCR, or ask for a readable copy. Do not infer that the attachment contains no requirements.',
      } };
    };
    try {
      const outcome = finish(await execute({ recipe: documentReadRecipe(cached ? undefined : converter, cached !== undefined),
        config: { source: converter && !cached ? { backing: 'cas', record_id: args.file_ref, content_sha256: hash } : args.file_ref },
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
