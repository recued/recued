/** D-172 P6 — `transcript` file-enrichment producer.
 *
 *  Voice `data.file` records are transcribed from their CAS bytes via the
 *  distinct `ctx.transcribe` audio capability. This producer deliberately
 *  self-fetches the source record's own bytes through `ctx.blobs`; it does not
 *  route through recipe-side `data-file-read`, which is the explicit tool path.
 */

import {
  computeProducerVersionHash,
  type CollectionRecord,
  type TranscriptValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';

import {
  assertRegistryValue,
  fetchCasFileBytes,
  fileEventAtOf,
  fileMimeTypeOf,
  fileNameOf,
  isFileMediaClass,
  mayAiEnrichFile,
} from './_file-media.js';

const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: 'transcript:1',
  model_id: '',
  prompt_template_hash: 'file_transcript_v1',
  adapter_version: '@recued/llm@1.0.0',
  consumed_ingredients_versions: [{ slug: 'transcribe', version: '1' }],
});

const TOKEN_ESTIMATE_PER_RECORD = 600;

export const transcriptProducer: HousekeepingEnrichmentProducer<CollectionRecord> = {
  producer_version_hash: baseProducerVersionHash,
  topic: 'transcript',
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
    if (!isFileMediaClass(source_record.data, 'voice')) return null;
    // D-262 § B12.2 — ⛔ a stranger's reception drop does not spend the owner's
    // tokens on an unattended cycle. See `mayAiEnrichFile` for why this is an
    // allowlist and what is deliberately not in it.
    if (!mayAiEnrichFile(source_record.data)) return null;
    if (!ctx.transcribe) {
      throw new Error(
        'transcript_producer_misconfigured: ctx.transcribe is required for voice file enrichment',
      );
    }

    const bytes = await fetchCasFileBytes(ctx, source_record, 'transcript');
    if (bytes === null) return null;

    const result = await ctx.transcribe({
      audio: bytes,
      mime_type: fileMimeTypeOf(source_record.data),
      filename: fileNameOf(source_record.data),
    });

    const value: TranscriptValue = {
      text: result.text,
      ...(result.language !== undefined ? { language: result.language } : {}),
      ...(result.model_id !== undefined ? { model: result.model_id } : {}),
    };

    assertRegistryValue('transcript', value, source_record.target_id, 'transcript');

    return {
      value,
      sidecar_text: value.text,
      event_at: fileEventAtOf(source_record.data),
      ...(result.model_id !== undefined ? { model_id: result.model_id } : {}),
      ingredient_slug: 'transcribe',
      producer_version_hash: baseProducerVersionHash,
    };
  },
};
