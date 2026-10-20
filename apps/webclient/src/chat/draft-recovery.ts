import type { ChatMessageAttachment, ChatModelSourceId } from '@recued/contracts';
import type { ChatReplyDraft } from './quoted-replies.js';
import type { ChatAssetContext } from './asset-context.js';

/** An unfinished upload needs an explicit file pick after pairing repair.
 * Only its label travels with the draft, never browser File objects or bytes. */
export interface ChatInterruptedUpload {
  readonly id: string;
  readonly filename: string;
  readonly media_class: string;
}

/** In-memory composer work only. Conversation history and action authority
 * are read again from the paired server, never restored from this snapshot. */
export interface ChatComposerRecoveryDraft {
  readonly text: string;
  readonly protected: boolean;
  readonly modelSourceId: ChatModelSourceId | null;
  readonly replyTo?: ChatReplyDraft;
  readonly attachments?: ChatMessageAttachment[];
  readonly interruptedUploads?: readonly ChatInterruptedUpload[];
  readonly assetContext?: ChatAssetContext;
}

export interface ChatRouteRecoveryDraft extends ChatComposerRecoveryDraft {
  /** null is the unfinished new-chat composer, which has no server session. */
  readonly parkedDrafts?: ReadonlyArray<{
    readonly sessionId: string | null;
    readonly draft: ChatComposerRecoveryDraft;
  }>;
}

export const hasComposerRecoveryDraft = (draft: ChatComposerRecoveryDraft): boolean =>
  draft.text.trim().length > 0 || draft.replyTo !== undefined || (draft.attachments?.length ?? 0) > 0
  || (draft.interruptedUploads?.length ?? 0) > 0 || draft.assetContext !== undefined;

export const copyComposerRecoveryDraft = (draft: ChatComposerRecoveryDraft): ChatComposerRecoveryDraft => ({
  text: draft.text, protected: draft.protected, modelSourceId: draft.modelSourceId,
  ...(draft.replyTo ? { replyTo: { ...draft.replyTo,
    ...(draft.replyTo.preview ? { preview: { ...draft.replyTo.preview } } : {}) } } : {}),
  ...(draft.attachments?.length ? { attachments: draft.attachments.map(file => ({ ...file })) } : {}),
  ...(draft.interruptedUploads?.length ? { interruptedUploads: draft.interruptedUploads.map(upload => ({ ...upload })) } : {}),
  ...(draft.assetContext ? { assetContext: { ...draft.assetContext, fileIds: [...draft.assetContext.fileIds] } } : {}),
});

/** The recovery form owns the unload guard after Chat has been disposed. */
export const hasProtectedChatRecoveryDraft = (draft: ChatRouteRecoveryDraft | undefined): boolean => {
  const protectedWork = (composer: ChatComposerRecoveryDraft): boolean =>
    composer.replyTo !== undefined || (composer.attachments?.length ?? 0) > 0
    || (composer.interruptedUploads?.length ?? 0) > 0
    || composer.assetContext !== undefined
    || (composer.protected && composer.text.trim().length > 0);
  return draft !== undefined && (protectedWork(draft)
    || draft.parkedDrafts?.some(parked => protectedWork(parked.draft)) === true);
};
