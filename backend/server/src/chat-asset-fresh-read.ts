import { parseAssetChatQuestion, type ChatDispatchResult } from '@recued/contracts';
import { isNonTerminalToolResult } from './chat-tool-call-context.js';

export type CurrentAssetAttachment = (assetId: string, fileRef: string) =>
  boolean | undefined | Promise<boolean | undefined>;
export type AssetSourceRead = (name: 'work.read' | 'document.read', args: Record<string, unknown>) => Promise<ChatDispatchResult>;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = 'I could not read the selected asset’s current saved details. Open the asset to check its availability and access, then try again.';
const changed = 'The selected asset’s linked file list changed. Open the asset and choose its sources again before comparing them.';
const documentUnavailable = 'I read the selected asset, but could not finish reading the requested linked document. Open the file to check access and reader support, then try again.';

/** Only the explicit owner envelope selects reads. Follow-ups, ordinary prose
 * and noncanonical/future envelopes keep normal model-led retrieval. */
export const assetQuestionForRead = (message: string) => {
  const request = parseAssetChatQuestion(message);
  return request && request.context.id.length <= 2048 ? request : null;
};

/** At most one current asset and one explicitly requested attached document.
 * No body/value cache, discovery, pagination loop, permission grant or summary
 * shortcut. The callback is the ordinary cancellation/grant/audit boundary. */
export const readCurrentAssetQuestion = async (
  request: NonNullable<ReturnType<typeof assetQuestionForRead>>,
  read: AssetSourceRead,
  options: { canReadDocument: boolean; currentAttachment?: CurrentAssetAttachment },
): Promise<string | undefined> => {
  const asset = await read('work.read', { kind: 'asset', id: request.context.id });
  if (!asset.ok || asset.run_failed || isNonTerminalToolResult(asset) || !object(asset.result)
    || asset.result.found !== true || !object(asset.result.entity)) return unavailable;

  const { context, question } = request;
  // A conservative optimization hint, not an intent or authorization rule.
  // Other wording and ambiguous file rosters still use the normal readers.
  if (!options.canReadDocument || !options.currentAttachment || context.filesUnavailable
    || context.omittedFiles > 0 || context.fileIds.length !== 1
    || !/\b(?:attached|attachment|document|file|note|manual)\b/iu.test(question)) return undefined;
  const ref = context.fileIds[0]!;
  if (!/^file:[a-f0-9]{32}$/u.test(ref)) return undefined;
  const linked = await options.currentAttachment(context.id, ref);
  if (linked === undefined) return undefined;
  if (!linked) return changed;
  const document = await read('document.read', { file_ref: ref });
  if (!document.ok || document.run_failed || isNonTerminalToolResult(document) || !object(document.result)
    || document.result.status !== 'read' || document.result.file_ref !== ref
    || typeof document.result.body !== 'string' || typeof document.result.read_version !== 'string'
    || !/^[a-f0-9]{64}$/u.test(document.result.read_version)) return documentUnavailable;
  // Recheck after a potentially slow reader/approval. A detached source must
  // not be presented as a current attachment merely because it was selected.
  const stillLinked = await options.currentAttachment(context.id, ref);
  return stillLinked === true ? undefined : stillLinked === false ? changed : documentUnavailable;
};
