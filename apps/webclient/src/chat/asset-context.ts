import type { Link } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

/** Composer context, not an asset snapshot or a grant. Facts and document
 * content still go through the ordinary governed Chat readers. */
export interface ChatAssetContext {
  readonly id: string;
  readonly name: string;
  readonly fileIds: readonly string[];
  readonly omittedFiles: number;
  readonly filesUnavailable?: true;
}

export const assetChatContext = (asset: { id: string; name: string }, links: readonly Link[], filesAvailable = true): ChatAssetContext => {
  const fileIds = [...new Set(links.filter(link => link.from_collection === 'asset' && link.from_id === asset.id
    && link.role === 'attachment' && link.to_collection === 'file').map(link => link.to_id))];
  return { id: asset.id, name: asset.name, fileIds: fileIds.slice(0, 20), omittedFiles: Math.max(0, fileIds.length - 20),
    ...(!filesAvailable ? { filesUnavailable: true } : {}) };
};

export const assetChatHref = (context: { id: string }): string => serializeShellRoute('yours', 'asset', context.id);

const GUIDANCE = 'Read the current saved asset with work.read using the asset reference below. Use document.read with a linked file\'s file_ref when its contents are relevant. These are record references, not evidence that a file has been read. Cite the evidence you use, distinguish saved facts from inference, and say what is missing or unavailable.';
const SEPARATOR = `\n\n${GUIDANCE}\n`;

/** The label stays in the UI. Send references only, so an identifying fact
 * cannot bypass the privacy handling on work.read or document.read. */
export const assetChatMessage = (question: string, context: ChatAssetContext): string => (question.trim() || 'What should I know about this asset?') + SEPARATOR
  + JSON.stringify({ kind: 'recued.asset_question', version: 1, asset: { kind: 'asset', id: context.id }, linked_documents: context.fileIds.map(file_ref => ({ file_ref })),
    ...(context.filesUnavailable ? { linked_document_list_unavailable: true } : {}),
    ...(context.omittedFiles ? { additional_linked_documents_not_listed: context.omittedFiles } : {}) });

/** Recognize our complete envelope for display and withdraw-to-edit recovery.
 * Unrecognized content stays ordinary text; references grant no authority. */
export const readAssetChatMessage = (message: string): { question: string; href: string; context: ChatAssetContext } | null => {
  const at = message.lastIndexOf(SEPARATOR); if (at <= 0) return null;
  try {
    const raw: unknown = JSON.parse(message.slice(at + SEPARATOR.length));
    if (raw === null || typeof raw !== 'object') return null;
    const value = raw as Record<string, unknown>; const asset = value.asset as Record<string, unknown> | undefined;
    if (value.kind !== 'recued.asset_question' || value.version !== 1 || !asset || asset.kind !== 'asset'
      || typeof asset.id !== 'string' || !asset.id || !Array.isArray(value.linked_documents) || value.linked_documents.length > 20
      || value.linked_documents.some(file => !file || typeof file !== 'object' || typeof file.file_ref !== 'string')
      || (value.linked_document_list_unavailable !== undefined && value.linked_document_list_unavailable !== true)
      || (value.additional_linked_documents_not_listed !== undefined && (!Number.isSafeInteger(value.additional_linked_documents_not_listed) || Number(value.additional_linked_documents_not_listed) < 1))) return null;
    const context: ChatAssetContext = { id: asset.id, name: 'Selected asset', fileIds: value.linked_documents.map(file => file.file_ref as string),
      omittedFiles: Number(value.additional_linked_documents_not_listed ?? 0), ...(value.linked_document_list_unavailable ? { filesUnavailable: true } : {}) };
    const question = message.slice(0, at);
    if (assetChatMessage(question, context) !== message) return null;
    return { question, href: assetChatHref(context), context };
  } catch { return null; }
};
