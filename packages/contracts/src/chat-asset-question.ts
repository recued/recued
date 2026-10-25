/** Selected-source references from the owner composer. They contain no fact
 * values and grant no authority; every read still uses its governed reader. */
export interface ChatAssetQuestionContext {
  readonly id: string;
  readonly fileIds: readonly string[];
  readonly omittedFiles: number;
  readonly filesUnavailable?: true;
}

const GUIDANCE = 'Read the current saved asset with work.read using the asset reference below. Use document.read with a linked file\'s file_ref when its contents are relevant. These are record references, not evidence that a file has been read. Cite the evidence you use, distinguish saved facts from inference, and say what is missing or unavailable.';
const SEPARATOR = `\n\n${GUIDANCE}\n`;

/** Kept byte-compatible with the original composer envelope. */
export const formatAssetChatQuestion = (question: string, context: ChatAssetQuestionContext): string =>
  (question.trim() || 'What should I know about this asset?') + SEPARATOR
  + JSON.stringify({ kind: 'recued.asset_question', version: 1, asset: { kind: 'asset', id: context.id },
    linked_documents: context.fileIds.map(file_ref => ({ file_ref })),
    ...(context.filesUnavailable ? { linked_document_list_unavailable: true } : {}),
    ...(context.omittedFiles ? { additional_linked_documents_not_listed: context.omittedFiles } : {}) });

/** Recognize only the complete canonical envelope. Extra or future fields
 * remain ordinary text, including when they resemble source instructions. */
export const parseAssetChatQuestion = (message: string): {
  question: string; context: ChatAssetQuestionContext;
} | null => {
  const at = message.lastIndexOf(SEPARATOR);
  if (at <= 0) return null;
  try {
    const raw: unknown = JSON.parse(message.slice(at + SEPARATOR.length));
    if (raw === null || typeof raw !== 'object') return null;
    const value = raw as Record<string, unknown>;
    const asset = value.asset as Record<string, unknown> | undefined;
    if (value.kind !== 'recued.asset_question' || value.version !== 1 || !asset || asset.kind !== 'asset'
      || typeof asset.id !== 'string' || !asset.id || !Array.isArray(value.linked_documents) || value.linked_documents.length > 20
      || value.linked_documents.some(file => !file || typeof file !== 'object' || typeof file.file_ref !== 'string')
      || (value.linked_document_list_unavailable !== undefined && value.linked_document_list_unavailable !== true)
      || (value.additional_linked_documents_not_listed !== undefined
        && (!Number.isSafeInteger(value.additional_linked_documents_not_listed) || Number(value.additional_linked_documents_not_listed) < 1))) return null;
    const context: ChatAssetQuestionContext = { id: asset.id, fileIds: value.linked_documents.map(file => file.file_ref as string),
      omittedFiles: Number(value.additional_linked_documents_not_listed ?? 0),
      ...(value.linked_document_list_unavailable ? { filesUnavailable: true } : {}) };
    const question = message.slice(0, at);
    return formatAssetChatQuestion(question, context) === message ? { question, context } : null;
  } catch { return null; }
};
