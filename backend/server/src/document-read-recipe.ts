/** Shared bounded conversion/read recipe; no Chat, cache or indexing runtime. */
import type { RecipeDefinition } from '@recued/contracts';

export const DOCUMENT_READ_RECIPE_ID = 'read-work-document';

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
