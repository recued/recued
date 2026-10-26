import { chatSourceCitationsOf, parseAssetChatQuestion, type ChatDispatchResult, type ChatSourceCitation } from '@recued/contracts';
import { isNonTerminalToolResult } from './chat-tool-call-context.js';

export type CurrentAssetAttachment = (assetId: string, fileRef: string) =>
  boolean | undefined | Promise<boolean | undefined>;
export type AssetSourceRead = (name: 'work.read' | 'document.read', args: Record<string, unknown>) => Promise<ChatDispatchResult>;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = 'I could not read the selected asset’s current saved details. Open the asset to check its availability and access, then try again.';
const changed = 'The selected asset’s linked file list changed. Open the asset and choose its sources again before comparing them.';
const documentUnavailable = 'I read the selected asset, but could not finish reading the requested linked document. Open the file to check access and reader support, then try again.';

type AssetReadRequest = NonNullable<ReturnType<typeof parseAssetChatQuestion>> & { requireDocument?: true };

/** Complete owner envelopes select reads; extra or future fields do not. */
export const assetQuestionForRead = (message: string): AssetReadRequest | null => {
  const request = parseAssetChatQuestion(message);
  return request && request.context.id.length <= 2048 ? request : null;
};

// A deliberately small command vocabulary, not a general intent classifier.
// Unsupported wording remains on ordinary model-led retrieval. Sentence and
// target boundaries avoid treating quoted prose or identifiers as commands.
const rereadCommand = /(?:^|[.!?]\s+|\n)\s*(?:please\s+)?(?:read|re-?read)\s+(?:the|this)\s+(?:(?:current|latest|saved|selected)\s+)?asset(?:\s+(?:again|now))?(\s+and\s+(?:(?:the|its)\s+)?(?:(?:current|attached|linked|older)\s+)?(?:note|document|file))?(?:\s+(?:again|now))?(?=$|[,;:.!?](?:\s|$))/giu;

/** Explicit current-source follow-ups can reuse identities, never old values.
 * Resolve only citations actually linked in the latest assistant answer and
 * retained by this owner's session. Ambiguity does not initiate discovery. */
export const assetRereadForRead = (
  message: string,
  tail: readonly { role: string; content: string }[],
  previous: readonly ChatSourceCitation[],
  canReadLinkedDocument: boolean,
): AssetReadRequest | null => {
  if (message.length > 8192 || /recued\.asset_question|["“”`{}]|(?:^|[^\p{L}\p{N}])['‘’]|['‘’](?:$|[^\p{L}\p{N}])|^\s*>/mu.test(message)
    || /\b(?:do\s+not|don't|never|avoid)\s+(?:re-?read|read|open|fetch|refresh)\b/iu.test(message)
    || /\b(?:as\s+(?:it\s+was|they\s+were|of)|yesterday|last\s+(?:week|month|year|time))\b/iu.test(message)) return null;
  const commands = [...message.matchAll(rereadCommand)];
  if (commands.length !== 1) return null;
  let answer: { content: string } | undefined;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i]!.role === 'assistant') { answer = tail[i]!; break; }
  }
  if (!answer) return null;
  const refs = new Set([...answer.content.matchAll(/\]\(#source\/(src_[a-f0-9]{24})\)/gu)].map(match => match[1]!));
  const sources = chatSourceCitationsOf(previous).filter(source => refs.has(source.id));
  const assets = [...new Set(sources.flatMap(source => source.kind !== 'file' ? [source.asset_id] : []))];
  if (assets.length !== 1 || assets[0]!.startsWith('we1:')) return null;
  const needsDocument = commands[0]![1] !== undefined;
  const files = needsDocument
    ? [...new Set(sources.flatMap(source => source.kind === 'file' ? [source.file_ref] : []))] : [];
  if (needsDocument && (!canReadLinkedDocument || files.length !== 1 || !/^file:[a-f0-9]{32}$/u.test(files[0]!))) return null;
  return { question: message, context: { id: assets[0]!, fileIds: files, omittedFiles: 0 },
    ...(needsDocument ? { requireDocument: true } : {}) };
};

/** At most one current asset and one explicitly requested attached document.
 * No body/value cache, discovery, pagination loop, permission grant or summary
 * shortcut. The callback is the ordinary cancellation/grant/audit boundary. */
export const readCurrentAssetQuestion = async (
  request: AssetReadRequest,
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
    || !/\b(?:attached|attachment|document|file|note|manual)\b/iu.test(question)) return request.requireDocument ? documentUnavailable : undefined;
  const ref = context.fileIds[0]!;
  if (!/^file:[a-f0-9]{32}$/u.test(ref)) return request.requireDocument ? documentUnavailable : undefined;
  const linked = await options.currentAttachment(context.id, ref);
  if (linked === undefined) return request.requireDocument ? documentUnavailable : undefined;
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
