/** D-172 P6 — `caption` file-enrichment producer.
 *
 *  Image bytes are passed as a provider-neutral `ContentPart` through
 *  `ctx.llmWithMeta`. The producer stays single-record: D-172 P5 explicitly
 *  leaves per-element batch media unsupported in the LLM executor.
 */

import {
  computeProducerVersionHash,
  type CaptionValue,
  type CollectionRecord,
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
  mayAiEnrichFile,
} from './_file-media.js';

const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: 'caption:1',
  model_id: '',
  prompt_template_hash: 'file_caption_v1',
  adapter_version: '@recued/llm@1.0.0',
  consumed_ingredients_versions: [{ slug: 'ai-generate', version: '1' }],
});

const TOKEN_ESTIMATE_PER_RECORD = 400;

const aiGenerateCaptionManifest: IngredientManifest = {
  slug: 'ai-generate',
  name: 'AI Generator',
  description: 'Generates concise content from provided input data.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['ai', 'generation', 'multimodal'],
  input: {
    'llm.data': null,
    'llm.template_type': null,
    'llm.tone': null,
    'llm.model_hint': null,
    'llm.content_parts': null,
  },
  output: {
    content: 'content',
  },
};

const parseCaptionOutput = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.content === 'string' && obj.content.trim().length > 0) {
    return obj.content.trim();
  }
  if (typeof obj.caption === 'string' && obj.caption.trim().length > 0) {
    return obj.caption.trim();
  }
  return null;
};

export const captionProducer: HousekeepingEnrichmentProducer<CollectionRecord> = {
  producer_version_hash: baseProducerVersionHash,
  topic: 'caption',
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
    if (!isFileMediaClass(source_record.data, 'image')) return null;
    // D-262 § B12.2 — ⛔ a stranger's reception drop does not spend the owner's
    // tokens on an unattended cycle. See `mayAiEnrichFile` for why this is an
    // allowlist and what is deliberately not in it.
    if (!mayAiEnrichFile(source_record.data)) return null;
    if (!ctx.llmWithMeta) {
      throw new Error(
        'caption_producer_misconfigured: ctx.llmWithMeta is required for image file enrichment',
      );
    }

    const bytes = await fetchCasFileBytes(ctx, source_record, 'caption');
    if (bytes === null) return null;

    const part: ContentPart = {
      type: 'image',
      source: {
        kind: 'base64',
        media_type: fileMimeTypeOf(source_record.data),
        data: bytes.toString('base64'),
      },
    };
    const input = {
      'llm.content_parts': [part],
      'llm.data': 'Describe this image concisely.',
      'llm.template_type': 'image caption',
      'llm.tone': 'neutral',
      'llm.model_hint': 'fast',
    };

    const { result, model_id } = await ctx.llmWithMeta(aiGenerateCaptionManifest, input);
    const caption = parseCaptionOutput(result);
    if (caption === null) {
      throw new Error(
        `caption_output_invalid: ai-generate returned non-conformant shape for file '${source_record.target_id}'`,
      );
    }

    const value: CaptionValue = {
      caption,
      ...(model_id.length > 0 ? { model: model_id } : {}),
    };
    assertRegistryValue('caption', value, source_record.target_id, 'caption');

    return {
      value,
      event_at: fileEventAtOf(source_record.data),
      model_id,
      ingredient_slug: 'ai-generate',
      producer_version_hash: baseProducerVersionHash,
    };
  },
};
