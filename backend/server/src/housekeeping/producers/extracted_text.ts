/** D-172 P6 — `extracted_text` file-enrichment producer.
 *
 *  Document bytes are passed to `ai-extract` as `llm.content_parts` in
 *  single-record mode. Batch media remains intentionally unsupported by the
 *  LLM executor, so this producer only handles one `data.file` record at a
 *  time through the standard per-record harness.
 */

import {
  computeProducerVersionHash,
  type CollectionRecord,
  type ExtractedTextValue,
  type IngredientManifest,
} from '@recued/contracts';
import type { ContentPart } from '@recued/llm';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';

import {
  assertRegistryValue,
  fetchCasFileBytes,
  fileEventAtOf,
  fileMimeTypeOf,
  isFileMediaClass,
} from './_file-media.js';

const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: 'extracted_text:1',
  model_id: '',
  prompt_template_hash: 'file_extracted_text_v1',
  adapter_version: '@recued/llm@1.0.0',
  consumed_ingredients_versions: [{ slug: 'ai-extract', version: '1' }],
});

const TOKEN_ESTIMATE_PER_RECORD = 900;

const aiExtractDocumentManifest: IngredientManifest = {
  slug: 'ai-extract',
  name: 'AI Field Extractor',
  description:
    'Extracts a caller-specified set of fields from unstructured input into a flat object.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['ai', 'extraction', 'multimodal'],
  input: {
    'llm.data': null,
    'llm.fields': null,
    'llm.model_hint': null,
    'llm.content_parts': null,
  },
  output: {
    extracted: 'dynamic_fields_per_llm_fields_input',
  },
};

const parseExtractedTextOutput = (value: unknown): Omit<ExtractedTextValue, 'model'> | null => {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.text !== 'string' || obj.text.trim().length === 0) return null;
  const out: Omit<ExtractedTextValue, 'model'> = { text: obj.text.trim() };
  if (obj.page_count !== null && obj.page_count !== undefined) {
    if (typeof obj.page_count !== 'number' || !Number.isFinite(obj.page_count)) {
      return null;
    }
    out.page_count = obj.page_count;
  }
  return out;
};

export const extractedTextProducer: HousekeepingEnrichmentProducer<CollectionRecord> = {
  producer_version_hash: baseProducerVersionHash,
  topic: 'extracted_text',
  source_scope: 'file',
  ai_surface: 'chat',
  scope_read_declaration: [
    {
      collection: 'data.file',
      sample_field_paths: ['filename', 'mime_type', 'media_class', 'storage_ref'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,

  async produce(
    ctx: HousekeepingContext,
    source_record: SourceRecord<CollectionRecord>,
  ) {
    if (!isFileMediaClass(source_record.data, 'document')) return null;
    if (!ctx.llmWithMeta) {
      throw new Error(
        'extracted_text_producer_misconfigured: ctx.llmWithMeta is required for document file enrichment',
      );
    }

    const bytes = await fetchCasFileBytes(ctx, source_record, 'extracted_text');
    if (bytes === null) return null;

    const part: ContentPart = {
      type: 'document',
      source: {
        kind: 'base64',
        media_type: fileMimeTypeOf(source_record.data),
        data: bytes.toString('base64'),
      },
    };
    const input = {
      'llm.content_parts': [part],
      'llm.data': 'Extract the text content.',
      'llm.fields': ['text', 'page_count'],
      'llm.model_hint': 'fast',
    };

    const { result, model_id } = await ctx.llmWithMeta(aiExtractDocumentManifest, input);
    const extracted = parseExtractedTextOutput(result);
    if (extracted === null) {
      throw new Error(
        `extracted_text_output_invalid: ai-extract returned non-conformant shape for file '${source_record.target_id}'`,
      );
    }

    const value: ExtractedTextValue = {
      ...extracted,
      ...(model_id.length > 0 ? { model: model_id } : {}),
    };
    assertRegistryValue('extracted_text', value, source_record.target_id, 'extracted_text');

    return {
      value,
      event_at: fileEventAtOf(source_record.data),
      model_id,
      ingredient_slug: 'ai-extract',
      producer_version_hash: baseProducerVersionHash,
    };
  },
};
