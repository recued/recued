/** Shared bounded conversion/read recipe; no Chat, cache or indexing runtime. */
import type { RecipeDefinition } from '@recued/contracts';

export const DOCUMENT_READ_RECIPE_ID = 'read-work-document';

/** The reader packs a document converts with, each by the operation that turns a file into text. Each
 *  writes the text to a file of its own, answered as `file_ref`, which the read step takes.
 *
 *  D-335 slice AR (2026-11-07) — PDFToText's `pdf.to_text`, for a PDF only ({@link DOCUMENT_READER_TYPES}).
 *  The owner: "then join other pack for pdf/md/unzip etc". A PDF saved from a page read nothing with only
 *  PDFToText installed: `document.read` asked for MarkItDown or Docling, and the pack's own recipe was
 *  never found. */
export const DOCUMENT_READER_OPS = {
  markitdown: 'document.to_markdown',
  docling: 'document.to_markdown',
  pdftotext: 'pdf.to_text',
} as const;
export type DocumentReader = keyof typeof DOCUMENT_READER_OPS;

/** The kinds of file a reader takes, by MIME essence; a reader not named here takes any. */
export const DOCUMENT_READER_TYPES: Readonly<Partial<Record<DocumentReader, readonly string[]>>> = {
  pdftotext: ['application/pdf'],
};

export const isDocumentReader = (name: string): name is DocumentReader => Object.hasOwn(DOCUMENT_READER_OPS, name);

/** Whether `reader` takes a file of this MIME essence. */
export const documentReaderTakes = (reader: DocumentReader, essence: string): boolean =>
  DOCUMENT_READER_TYPES[reader]?.includes(essence) ?? true;

export const documentReadRecipe = (converter?: string, metadataOnly = false): RecipeDefinition => {
  const reader = converter ? converter : undefined;
  if (reader !== undefined && !isDocumentReader(reader)) throw new Error(`There is no document reader named ${reader}.`);
  return {
    recipe_id: DOCUMENT_READ_RECIPE_ID, version: 1, ttl: 0,
    metadata: { name: 'Read a work document', description: 'Extract readable evidence from one selected file.', author: 'recued',
      supported_platforms: [], tags: ['kernel', 'document'], budget_ms: 110000 },
    variables: { source: { type: 'file_ref', label: 'Document' } }, prefetch_steps: [],
    steps: reader !== undefined ? [
      { id: 'convert', op: `recued-core.${reader}.${DOCUMENT_READER_OPS[reader]}`, args: { source: '{{config.source}}' } },
      { id: 'read', op: 'core.storage.file.read-temp', args: { ref: '{{step.convert.file_ref}}' } },
    ] : [{ id: 'read', op: 'core.storage.data-file-read', args: { record_id: '{{config.source}}', ...(metadataOnly ? { metadata_only: true } : {}) } }],
    output: { render: [{ type: 'summary', source: 'step.read' }] },
  };
};
