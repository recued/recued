/** Owner-started mail triage. A read never changes remote flags. */
import { createHash } from 'node:crypto';
import { RpcError, type CollectionRecord, type MailMessageRef, type MailMessageState, type MailMessageStateChange, type MailMessageStateResult } from '@recued/contracts';
import type { MailCollection } from './mail-collection.js';
import type { MailProvider, CanonicalMessage } from './provider.js';
import { handleMailFlag, handleMailMark, type MailDispatcherDeps } from './mail-dispatcher.js';

type StateCollection = Pick<MailCollection, 'get' | 'accountEmail'>
  & Partial<Pick<MailCollection, 'mutationCapable' | 'applyVerifiedMutation'>>
  & { readonly provider: Pick<MailProvider, 'fetchMessage' | 'markMessage' | 'flagMessage'> };
export interface MailMessageStateDeps {
  getCollection(slug: string): StateCollection | undefined;
  getIncarnation?(slug: string): string | null;
}
const changed = (): never => { throw new RpcError('resource_changed', 'This email or mailbox changed. Refresh Mail before continuing.', 409); };
const capture = (deps: MailMessageStateDeps, input: MailMessageRef) => {
  if (!input || typeof input.slug !== 'string' || !input.slug || input.slug.length > 256
    || typeof input.record_id !== 'string' || !input.record_id || input.record_id.length > 4096) {
    throw new RpcError('invalid_args', 'A mailbox and message identity are required.', 400);
  }
  const collection = deps.getCollection(input.slug), record = collection?.get(input.record_id);
  if (!collection || !record) throw new RpcError('not_found', 'This email is unavailable. Refresh Mail.', 404);
  const incarnation = deps.getIncarnation?.(input.slug);
  const identityOf = (current: CollectionRecord): string => createHash('sha256').update(JSON.stringify([
    input.slug, incarnation, collection.accountEmail, current.record_id, current.source_id,
    current.hot_fields.rfc_message_id ?? null, current.hot_fields.thread_id ?? null,
  ])).digest('hex');
  const identity = identityOf(record);
  const scope = input.conversation;
  if (scope !== undefined && (!scope || typeof scope.incarnation !== 'string' || !scope.incarnation || scope.incarnation.length > 256
    || scope.thread_id !== null && (typeof scope.thread_id !== 'string' || !scope.thread_id || scope.thread_id.length > 4096))) {
    throw new RpcError('invalid_args', 'A valid conversation identity is required.', 400);
  }
  const assertCurrent = () => {
    const current = collection.get(input.record_id);
    if (!current || deps.getCollection(input.slug) !== collection || deps.getIncarnation?.(input.slug) !== incarnation || identityOf(current) !== identity) return changed();
    if (scope && (scope.incarnation !== incarnation || scope.thread_id !==
      (typeof current.hot_fields.thread_id === 'string' && current.hot_fields.thread_id.trim() ? current.hot_fields.thread_id : null))) changed();
    return current;
  };
  assertCurrent();
  const supported = collection.mutationCapable === true && Boolean(incarnation) && Boolean(collection.provider.fetchMessage);
  const stateOf = (message?: Pick<CanonicalMessage, 'is_read' | 'is_flagged'>): MailMessageState => ({
    identity: incarnation ? identity : null,
    is_read: message ? message.is_read : record.hot_fields.is_read === true,
    is_flagged: message ? message.is_flagged === true : record.hot_fields.is_flagged === true,
    verified: Boolean(message),
    can_mark: supported && Boolean(message) && Boolean(collection.provider.markMessage),
    can_flag: supported && Boolean(message) && Boolean(collection.provider.flagMessage),
    ...(!supported ? { unavailable_reason: collection.mutationCapable !== true
      ? 'This mailbox is read-only. Mail editing access can be changed in Connections.'
      : 'This mailbox cannot verify email changes. Reconnect it in Connections.' }
      : !message ? { unavailable_reason: 'Email status could not be checked. Refresh this email before changing it.' } : {}),
  });
  return { collection, record, identity, assertCurrent, supported, stateOf };
};

/** Reuse this provider copy for reply/forward, avoiding a second body fetch. */
export const readMailMessageState = async (deps: MailMessageStateDeps, input: MailMessageRef): Promise<{
  state: MailMessageState; message?: CanonicalMessage | null; assertCurrent(): void;
}> => {
  const bound = capture(deps, input);
  if (!bound.supported) return { state: bound.stateOf(), assertCurrent: bound.assertCurrent };
  const readStartedAt = Date.now();
  let message: CanonicalMessage | null = null;
  try { message = await bound.collection.provider.fetchMessage!(bound.record.source_id); } catch { /* Keep the stored status, with actions disabled. */ }
  const current = bound.assertCurrent();
  if (!message || message.source_id !== bound.record.source_id || typeof bound.record.hot_fields.rfc_message_id === 'string'
      && bound.record.hot_fields.rfc_message_id.replace(/^<|>$/g, '') !== message.rfc_message_id?.replace(/^<|>$/g, '')) {
    return { state: bound.stateOf(), message: null, assertCurrent: bound.assertCurrent };
  }
  // Body/reply verification is independent of the optional flag metadata.
  if (typeof message.is_read !== 'boolean' || typeof message.is_flagged !== 'boolean') {
    return { state: bound.stateOf(), message, assertCurrent: bound.assertCurrent };
  }
  const flagsDiffer = current.hot_fields.is_read !== message.is_read || current.hot_fields.is_flagged !== message.is_flagged;
  // A mutation or sync that landed during the read wins. The timestamp fence
  // also covers same-millisecond writes; retrying a read is safer than rolling
  // a confirmed action back. This mirrors the folder-snapshot reconciliation.
  if (current.modified_at !== bound.record.modified_at || current.hot_fields.is_read !== bound.record.hot_fields.is_read
    || current.hot_fields.is_flagged !== bound.record.hot_fields.is_flagged
    || flagsDiffer && (current.modified_at ?? current.received_at) >= readStartedAt) {
    return { state: { ...bound.stateOf(), is_read: current.hot_fields.is_read === true, is_flagged: current.hot_fields.is_flagged === true,
      unavailable_reason: 'Email status changed while it was being checked. Refresh this email before changing it.' },
      message: null, assertCurrent: bound.assertCurrent };
  }
  // A successful check also reconciles a write whose acknowledgement was lost.
  // Do not write a row for an ordinary read whose flags have not changed.
  if (flagsDiffer) {
    bound.collection.applyVerifiedMutation?.(input.record_id, {
      source_id: message.source_id, is_read: message.is_read, is_flagged: message.is_flagged,
      folder_or_label: message.folder_or_label, ...(message.labels ? { labels: message.labels } : {}),
    });
    bound.assertCurrent();
  }
  return { state: bound.stateOf(message), message, assertCurrent: bound.assertCurrent };
};

export const updateMailMessageState = async (
  deps: MailMessageStateDeps & MailDispatcherDeps, input: MailMessageStateChange,
): Promise<MailMessageStateResult> => {
  if (!input || typeof input.expected_identity !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_identity)
    || !input.change || !['read', 'star'].includes(input.change.kind) || typeof input.change.value !== 'boolean') {
    throw new RpcError('invalid_args', 'Choose a read or star action for this email.', 400);
  }
  const bound = capture(deps, input);
  if (!bound.supported) throw new RpcError('forbidden', bound.stateOf().unavailable_reason!, 403);
  if (bound.identity !== input.expected_identity) changed();
  // The existing dispatchers enforce capability and verb checks and reflect only
  // provider-verified state. Recheck the binding before reflection after their await.
  const guarded = { ...deps, assertCurrent: bound.assertCurrent };
  const result = input.change.kind === 'read'
    ? await handleMailMark(guarded, { slug: input.slug, record_id: input.record_id, read: input.change.value })
    : await handleMailFlag(guarded, { slug: input.slug, record_id: input.record_id, flagged: input.change.value });
  bound.assertCurrent();
  const record = bound.collection.get(input.record_id);
  if (!record) return changed();
  return { slug: input.slug, record_id: input.record_id, record, state: bound.stateOf(result) };
};
