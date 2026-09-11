/** Provider request identity, shared by review and the last egress check. */
import { createHash } from 'node:crypto';
import { RpcError, parsePreapprovalJson, type PreapprovalJson } from '@recued/contracts';
import type { ContentPart, LLMProviderInvocation, LLMSlot, PinnedSlot } from '@recued/llm';
import { preapprovalHash } from './preapproval-invocations.js';
import type { FileContentSnapshot } from './collections/file/file-snapshot.js';

export const llmSourceMaterial = (slot: LLMSlot | undefined): PreapprovalJson | null => {
  if (!slot) return null;
  const { api_key, ...fields } = slot;
  return parsePreapprovalJson(JSON.parse(JSON.stringify({ ...fields, credential_hash: preapprovalHash(api_key) })));
};

export interface ReviewedAiSnapshot {
  kind: 'ai_request'; version: 1; slot: PinnedSlot; request: PreapprovalJson;
}
export const readReviewedAiSnapshot = (value: unknown): ReviewedAiSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<ReviewedAiSnapshot>;
  return row.kind === 'ai_request' && row.version === 1 && (row.slot === 'slot_1' || row.slot === 'slot_2')
    && row.request !== undefined ? row as ReviewedAiSnapshot : null;
};

// Only the private preparation code supplies this marker, and only to the
// pure prompt builder. It is never sent to a provider or used to read bytes.
export const reviewedAiMediaMarker = (file: FileContentSnapshot): string => `reviewed-file:${file.blob_hash}:${file.size_bytes}`;

export const describeAiProviderRequest = (request: LLMProviderInvocation, file?: FileContentSnapshot): PreapprovalJson => {
  if (request.match.source.kind !== 'slot') throw new RpcError('preapproval_unresolved', 'Choose a configured model slot for this reviewed execution.', 409);
  const part = (content: ContentPart): unknown => {
    if (content.type === 'text') return content;
    if (content.source.kind !== 'base64') throw new RpcError('preapproval_unresolved', 'Save remote AI media before requesting review; its content can change.', 409);
    const { data, media_type } = content.source;
    if (file && data === reviewedAiMediaMarker(file)) {
      return { type: content.type, source: { kind: 'content_hash', media_type, hash: file.blob_hash, size_bytes: file.size_bytes } };
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data.replace(/\s/g, '')) throw new RpcError('preapproval_unresolved', 'AI media must use canonical base64 encoding.', 409);
    return { type: content.type, source: { kind: 'content_hash', media_type,
      hash: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.byteLength } };
  };
  return parsePreapprovalJson(JSON.parse(JSON.stringify({ version: 1,
    adapter: request.match.adapterKey, source: request.match.source, slot: llmSourceMaterial(request.match.slot),
    messages: request.messages.map(message => ({ ...message,
      ...(message.content_parts ? { content_parts: message.content_parts.map(part) } : {}) })), options: request.options,
  })));
};
