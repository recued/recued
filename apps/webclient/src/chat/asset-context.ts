import { formatAssetChatQuestion, parseAssetChatQuestion, type Link, type ChatAssetQuestionContext } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

/** Composer context, not an asset snapshot or a grant. Facts and document
 * content still go through the ordinary governed Chat readers. */
export interface ChatAssetContext extends ChatAssetQuestionContext {
  readonly name: string;
}

export const assetChatContext = (asset: { id: string; name: string }, links: readonly Link[], filesAvailable = true): ChatAssetContext => {
  const fileIds = [...new Set(links.filter(link => link.from_collection === 'asset' && link.from_id === asset.id
    && link.role === 'attachment' && link.to_collection === 'file').map(link => link.to_id))];
  return { id: asset.id, name: asset.name, fileIds: fileIds.slice(0, 20), omittedFiles: Math.max(0, fileIds.length - 20),
    ...(!filesAvailable ? { filesUnavailable: true } : {}) };
};

export const assetChatHref = (context: { id: string }): string => serializeShellRoute('yours', 'asset', context.id);

/** The shared contract contains references only, never the UI label or facts. */
export const assetChatMessage = (question: string, context: ChatAssetContext): string => formatAssetChatQuestion(question, context);

export const readAssetChatMessage = (message: string): { question: string; href: string; context: ChatAssetContext } | null => {
  const parsed = parseAssetChatQuestion(message);
  return parsed ? { question: parsed.question, href: assetChatHref(parsed.context), context: { ...parsed.context, name: 'Selected asset' } } : null;
};
