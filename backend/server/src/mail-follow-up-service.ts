import type { MailReplacementSource } from './mail-follow-up-replacement-source.js';
import { observeFollowUpDelivery, sameDeliveryFailure } from './mail-follow-up-delivery.js';
import { randomUUID } from 'node:crypto';
import {
  RpcError, addReReplyPrefix, canonicalizeEmail, parseAddress, mailRecipientInvalidReason, parseMailDraftContent, parseMailFollowUpFilters,
  readReminderMailReference, reminderMailReference, sameReminderMailReference, deriveCollectionSourceFreshness,
  readMailFollowUpTaskRef, mailFollowUpTaskRef, sameMailFollowUpTaskRef, TASK_TITLE_MAX, calendarDayMs,
  type MailFollowUpTaskRef, type MailFollowUpTaskSet, type MailFollowUpTaskView, type MailFollowUpTaskLinks, type MailFollowUpTaskCreate,
  readMailFollowUpTaskContinuation, type MailFollowUpTaskContinuation, type MailFollowUpTaskContext, type WorkEntity,
  readMailFollowUpWaitingFor, mailFollowUpWaitingForMatches, parsePreapprovalJson,
  type CollectionRecord, type MailDraft, type MailFollowUp, type MailFollowUpCursor, type MailFollowUpStart, type MailFollowUpReschedule, type MailFollowUpReplyNotification, type MailFollowUpReplyTarget, type PreapprovalMailFollowUpStop, type ReminderMailReference,
} from '@recued/contracts';
import type { Collection } from './collections/types.js';
import { followUpHash, followUpConflict, type MailFollowUpStore, type StoredMailFollowUp } from './storage/mail-follow-up-store.js';
import { requireMailFollowUpTask, type MailFollowUpTaskRead } from './mail-follow-up-task-read.js';
import type { MailFollowUpTaskWriter } from './mail-follow-up-task-create.js';
import { storedReplyAutomation } from './collections/mail/reply-automation.js';

type Mailbox = Pick<Collection, 'get' | 'list' | 'health'> & { readonly accountEmail: string; readonly lastInboundSyncAt?: number | null };
const CONDITIONAL_MAIL_SYNC_MAX_AGE_MS = 5 * 60_000;
export interface ScheduledFollowUpCondition {
  watch_id: string;
  draft_id: string;
  seed_hash: string;
}
export interface ScheduledFollowUpStop {
  outcome: PreapprovalMailFollowUpStop;
  message: string;
}
const reviewSend = (reason: string): ScheduledFollowUpStop => ({
  outcome: { kind: 'review' }, message: `${reason} The follow-up was held for review.`,
});
const unfinished = (watch: MailFollowUp) => ['waiting', 'needs_attention', 'draft_ready'].includes(watch.state);
const object = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RpcError('bad_request', 'Reply watch arguments are required.', 400);
  return raw as Record<string, unknown>;
};
const idOf = (id: unknown): string => {
  if (typeof id !== 'string' || !/^mfw_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new RpcError('bad_request', 'Choose a valid reply watch.', 400);
  return id;
};
const refOf = (raw: unknown): ReminderMailReference => {
  const ref = readReminderMailReference(raw); if (!ref) throw new RpcError('bad_request', 'Choose a valid saved email.', 400); return ref;
};
const address = (raw: unknown): string => typeof raw === 'string' && mailRecipientInvalidReason(raw) === null
  ? canonicalizeEmail(parseAddress(raw)!.email) : '';
const rfcId = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw.length > 998) return '';
  const bare = raw.trim().replace(/^<([^<>]+)>$/, '$1');
  return /^[^\s<>@]+@[^\s<>@]+$/.test(bare) && !/[\u0000-\u001f\u007f]/u.test(bare) && Buffer.byteLength(bare) < 996 ? `<${bare}>` : '';
};
const threadKey = (ref: ReminderMailReference, thread: string) => followUpHash([ref.slug, ref.incarnation, thread]);
export class MailFollowUpTaskContinuationChanged extends RpcError {
  constructor() { super('resource_changed', 'Task tracking changed. Review the task and its current reply watch before trying again.', 409); }
}
const taskFingerprint = (task: Extract<WorkEntity, { _kind: 'task' }>) => followUpHash([
  mailFollowUpTaskRef(task), task.updated_at, task.title, task.body ?? null, task.done, task.due_at ?? null, task.priority ?? null,
  task.state ?? null, task.progress ?? null, task.assigned_contact_id ?? null, task.parent_project_id ?? null,
  task.parent_calendar_event_id ?? null, task.linked_mail_thread_id ?? null, task.blocks_task_ids,
]);

export const createMailFollowUpService = (deps: {
  store: MailFollowUpStore; mailbox(slug: string): Mailbox | undefined; incarnation(slug: string): string | null;
  createDraft(input: { idempotency_key: string; content: StoredMailFollowUp['draft_content'] }, ownerTokenId: string, current: () => void): Promise<MailDraft>;
  readReplacement?(ref: ReminderMailReference, recipient: string, current: () => void): Promise<MailReplacementSource>;
  now?: () => number; canRun?: () => boolean;
  tasks?: { read(id: string): Promise<MailFollowUpTaskRead>; current(id: string): MailFollowUpTaskRead; create?: MailFollowUpTaskWriter };
}) => {
  const now = deps.now ?? Date.now, locks = new Map<string, Promise<MailFollowUp>>();
  const seed = (ref: ReminderMailReference) => {
    const box = deps.mailbox(ref.slug), record = box?.get(ref.record_id);
    const actual = record && reminderMailReference(ref.slug, record, deps.incarnation(ref.slug));
    if (!box || !record || !actual || !sameReminderMailReference(actual, ref)) throw new RpcError('resource_changed', 'This email or mailbox changed. Reopen it from Mail.', 409);
    const hot = record.hot_fields, account = address(box.accountEmail), from = address(hot.from), thread = hot.thread_id;
    if (!account || from !== account || hot.direction !== 'outbound' || typeof thread !== 'string' || !thread.trim() || thread.length > 4096) throw new RpcError('unavailable', 'Choose a sent email with a confirmed mailbox and conversation.', 409);
    const raw = [...(Array.isArray(hot.to) ? hot.to : []), ...(Array.isArray(hot.cc) ? hot.cc : [])];
    const recipients = [...new Set(raw.map(address).filter(value => value && value !== account))];
    const messageId = rfcId(hot.rfc_message_id);
    if (!messageId || !raw.length || raw.some(value => !address(value)) || !recipients.length || recipients.length > 20) throw new RpcError('unavailable', 'The email’s reply headers or recipients could not be confirmed.', 409);
    const subject = typeof hot.subject === 'string' ? hot.subject : '';
    const fingerprint = followUpHash([ref, thread, account, from, raw, subject, messageId]);
    return { box, record, slug: ref.slug, account, thread, recipients, messageId, subject, fingerprint, key: threadKey(ref, thread) };
  };
  const readThread = (selection: ReturnType<typeof seed>): CollectionRecord[] => {
    const rows = selection.box.list({ platform: 'mail', slug: selection.slug, filters: { thread_id: selection.thread }, limit: 201 });
    if (rows.length > 200) throw new RpcError('unavailable', 'This conversation is too large to check automatically. Review its messages.', 409);
    if (!rows.some(row => row.record_id === selection.record.record_id && row.source_id === selection.record.source_id && row.received_at === selection.record.received_at)
      || new Set(rows.map(row => row.record_id)).size !== rows.length
      || rows.some(row => row.hot_fields.thread_id !== selection.thread || !Number.isSafeInteger(row.received_at))) throw new RpcError('unavailable', 'The conversation index could not be confirmed. Refresh Mail.', 409);
    return rows;
  };
  const requireWatch = async (id: unknown): Promise<StoredMailFollowUp> => {
    const stored = await deps.store.get(idOf(id)); if (!stored) throw new RpcError('not_found', 'This reply watch is unavailable.', 404); return stored;
  };
  const expectedParticipantReply = (value: StoredMailFollowUp, row: CollectionRecord): boolean => row.hot_fields.direction === 'inbound'
    && (value.watch.waiting_for ? address(row.hot_fields.from) === value.watch.waiting_for.address : value.recipients.includes(address(row.hot_fields.from)));
  const knownParticipantReply = (value: StoredMailFollowUp, row: CollectionRecord): boolean => row.hot_fields.direction === 'inbound' && value.recipients.includes(address(row.hot_fields.from));
  const countsAsReply = (value: StoredMailFollowUp, row: CollectionRecord): boolean => expectedParticipantReply(value, row) && storedReplyAutomation(row.hot_fields.reply_automation) === 'unmarked' && row.hot_fields.delivery_report_original_id === undefined;
  const automaticParticipantReply = (value: StoredMailFollowUp, row: CollectionRecord): boolean => knownParticipantReply(value, row) && storedReplyAutomation(row.hot_fields.reply_automation) === 'automatic';
  const otherParticipantReply = (value: StoredMailFollowUp, row: CollectionRecord): boolean => Boolean(value.watch.waiting_for)
    && knownParticipantReply(value, row) && !expectedParticipantReply(value, row) && storedReplyAutomation(row.hot_fields.reply_automation) === 'unmarked';
  const harmlessReply = (value: StoredMailFollowUp, row: CollectionRecord): boolean => otherParticipantReply(value, row) || automaticParticipantReply(value, row);
  const verifyReply = (value: StoredMailFollowUp, ref: ReminderMailReference | undefined): ReminderMailReference => {
    const checked = readReminderMailReference(ref), slug = value.watch.mail_ref.slug;
    const box = deps.mailbox(slug), record = checked && box?.get(checked.record_id);
    const actual = record && reminderMailReference(slug, record, deps.incarnation(slug));
    if (!checked || checked.slug !== slug || checked.incarnation !== value.watch.mail_ref.incarnation || !actual
      || value.watch.state === 'replied' && checked.record_id !== value.watch.reply_record_id
      || !sameReminderMailReference(checked, actual) || record!.hot_fields.thread_id !== value.thread_id
      || !countsAsReply(value, record!)
      || record!.received_at < value.watch.mail_ref.received_at || address(box!.accountEmail) !== value.mailbox_address)
      throw new RpcError('resource_changed', 'This reply or mailbox was removed or replaced. Open Mail to review the conversation.', 409);
    return checked;
  };
  const replyIdentity = (value: StoredMailFollowUp, record: CollectionRecord): ReminderMailReference =>
    verifyReply(value, reminderMailReference(value.watch.mail_ref.slug, record, deps.incarnation(value.watch.mail_ref.slug)) ?? undefined);
  const replyGuard = async (id: unknown): Promise<() => MailFollowUpReplyTarget> => {
    const value = await requireWatch(id);
    if (value.watch.state !== 'replied' || !value.watch.reply_ref) throw new RpcError('unavailable', 'A verified reply link is unavailable for this watch. Open the watched email to review its conversation.', 409);
    const current = () => ({ watch: value.watch, mail_ref: verifyReply(value, value.watch.reply_ref) });
    current(); return current;
  };
  const deliveryObservation = (value: StoredMailFollowUp) => {
    const selected = seed(value.watch.mail_ref);
    if (selected.fingerprint !== value.seed_hash || selected.account !== value.mailbox_address)
      throw new RpcError('resource_changed', 'The watched email changed. Review its delivery report in Mail.', 409);
    return observeFollowUpDelivery(value, selected, deps.incarnation(selected.slug));
  };
  const verifyDeliveryFailure = (value: StoredMailFollowUp): ReminderMailReference => {
    const saved = value.watch.delivery_failure, observed = deliveryObservation(value);
    if (!saved || !observed.failure || !sameDeliveryFailure(saved, observed.failure)
      || readThread(seed(value.watch.mail_ref)).some(row => row.record_id !== value.watch.mail_ref.record_id
        && row.received_at >= value.watch.mail_ref.received_at && countsAsReply(value, row)))
      throw new RpcError('resource_changed', 'The delivery report or conversation changed. Check this watch before opening the report.', 409);
    return saved.report_ref;
  };
  const conditionSource = (value: StoredMailFollowUp, condition: ScheduledFollowUpCondition) => {
    const selected = seed(value.watch.mail_ref);
    if (value.watch.draft_id !== condition.draft_id || value.seed_hash !== condition.seed_hash
      || selected.fingerprint !== condition.seed_hash || selected.account !== value.mailbox_address) {
      throw new RpcError('resource_changed', 'The original follow-up conversation changed. Reopen the saved draft from its reply watch.', 409);
    }
    return selected;
  };
  const locked = (id: string, work: () => Promise<MailFollowUp>): Promise<MailFollowUp> => {
    const prior = locks.get(id) ?? Promise.resolve(undefined);
    const pending = prior.catch(() => undefined).then(work); locks.set(id, pending);
    void pending.finally(() => { if (locks.get(id) === pending) locks.delete(id); }).catch(() => { }); return pending;
  };
  const lockedTogether = (ids: string[], work: () => Promise<MailFollowUp>): Promise<MailFollowUp> => {
    const keys = [...new Set(ids)].sort();
    const run = (index: number): Promise<MailFollowUp> => index === keys.length ? work() : locked(keys[index]!, () => run(index + 1));
    return run(0);
  };
  const replacementHash = (value: StoredMailFollowUp) => followUpHash([value.watch.mail_ref, value.seed_hash, value.watch.delivery_failure]);
  const replacementGuard = (value: StoredMailFollowUp, hash: string): void => {
    if (value.watch.state !== 'delivery_failed' || !value.watch.delivery_failure || replacementHash(value) !== hash) throw new MailFollowUpTaskContinuationChanged();
    verifyDeliveryFailure(value);
  };
  const continuationGuard = async (raw: MailFollowUpTaskContinuation, content?: StoredMailFollowUp['draft_content']) => {
    const selected = readMailFollowUpTaskContinuation(raw);
    if (!selected) throw new RpcError('bad_request', 'Choose the linked task from this saved follow-up draft.', 400);
    const value = await requireWatch(selected.watch_id);
    const replacement = selected.replacement_hash !== undefined;
    const currentReplacement = () => {
      try { replacementGuard(value, selected.replacement_hash!); }
      catch (cause) {
        if (cause instanceof RpcError && cause.code === 'server_locked') throw cause;
        // Once a send's reviewed task consent is stale, later mailbox repair
        // must not silently revive that consent during reconciliation.
        throw new MailFollowUpTaskContinuationChanged();
      }
    };
    if (replacement) {
      if (value.replacement?.draft_id !== selected.draft_id || value.replacement.failure_hash !== selected.replacement_hash) throw new MailFollowUpTaskContinuationChanged();
      currentReplacement();
      if (content && (content.sender_mail_instance !== value.watch.mail_ref.slug || content.in_reply_to !== undefined || content.references !== undefined
        || content.to.length !== 1 || (Array.isArray(content.cc) && content.cc.length) || (Array.isArray(content.bcc) && content.bcc.length)
        || !address(content.to[0]) || address(content.to[0]) === value.mailbox_address || address(content.to[0]) === value.watch.delivery_failure!.recipient))
        throw new RpcError('resource_changed', 'Review one corrected To recipient for this replacement. Remove Cc/Bcc before keeping the task linked.', 409);
    }
    if (!value.watch.task_ref || !sameMailFollowUpTaskRef(value.watch.task_ref, selected.task_ref)
      || (!replacement && value.watch.draft_id !== selected.draft_id) || (value.watch.task_link_version ?? 0) !== selected.link_version
      || value.watch.state === 'cancelled' || !replacement && (value.watch.state === 'delivery_failed' || value.watch.delivery_failure) || !deps.tasks
      || !replacement && content && (content.sender_mail_instance !== value.watch.mail_ref.slug || content.in_reply_to !== value.draft_content.in_reply_to))
      throw new MailFollowUpTaskContinuationChanged();
    try { requireMailFollowUpTask(await deps.tasks.read(selected.task_ref.id), now(), true); }
    catch (cause) { if (cause instanceof RpcError && cause.code === 'server_locked') throw cause; throw new MailFollowUpTaskContinuationChanged(); }
    const current = (): string => {
      if (replacement) currentReplacement();
      else { const delivery = deliveryObservation(value); if (delivery.failure || delivery.review) throw new MailFollowUpTaskContinuationChanged(); }
      if (!deps.store.hasTaskLink(selected.watch_id, selected.task_ref, selected.link_version, replacement)) throw new MailFollowUpTaskContinuationChanged();
      try {
        const task = requireMailFollowUpTask(deps.tasks!.current(selected.task_ref.id), now(), true);
        if (!sameMailFollowUpTaskRef(selected.task_ref, mailFollowUpTaskRef(task)!)
          || taskFingerprint(task) !== selected.task_hash || seed(value.watch.mail_ref).fingerprint !== value.seed_hash)
          throw new MailFollowUpTaskContinuationChanged();
        return task.title;
      } catch (cause) {
        if (cause instanceof RpcError && cause.code === 'server_locked') throw cause;
        throw new MailFollowUpTaskContinuationChanged();
      }
    };
    current(); return { value, current };
  };
  const check = (id: unknown): Promise<MailFollowUp> => {
    const key = idOf(id); return locked(key, async () => {
      let value = await requireWatch(key); if (deps.canRun?.() === false) return value.watch;
      if (value.watch.state === 'replied' && value.watch.reply_ref) {
        try { verifyReply(value, value.watch.reply_ref); return value.watch; } catch { /* Recheck a reply whose evidence changed. */ }
      } else if (value.watch.state === 'delivery_failed') {
        try { verifyDeliveryFailure(value); return value.watch; } catch { /* Recheck changed report evidence. */ }
      } else if (!unfinished(value.watch)) return value.watch;
      let selection: ReturnType<typeof seed> | undefined; let preparedDraftId: string | undefined; let deliveryTransitionStarted = false;
      const current = () => {
        if (deps.canRun?.() === false) throw new RpcError('unavailable', 'Reply checks are paused.', 409);
        const currentSeed = seed(value.watch.mail_ref), currentHealth = currentSeed.box.health();
        const delivery = deliveryObservation(value);
        if (delivery.failure || delivery.review) throw new RpcError('resource_changed', delivery.review ?? 'A delivery failure arrived while preparing the follow-up. Check this watch.', 409);
        if (currentSeed.fingerprint !== value.seed_hash || readThread(currentSeed).some(row => row.record_id !== value.watch.mail_ref.record_id && row.received_at >= value.watch.mail_ref.received_at && !harmlessReply(value, row))
          || deriveCollectionSourceFreshness(currentHealth, now()).stale || currentHealth.last_indexed_at < value.watch.check_at) throw new RpcError('resource_changed', 'The conversation or its sync changed while preparing a draft. Check the watch again.', 409);
      };
      const transition = async (state: MailFollowUp['state'], detail?: string, extra: Partial<MailFollowUp> = {}) => {
        if (value.watch.state === state && value.watch.detail === detail && !Object.keys(extra).length) return value.watch;
        if (state === 'delivery_failed') deliveryTransitionStarted = true;
        const next = { ...value, watch: { ...value.watch, ...extra, state, detail,
          ...(state !== 'replied' ? { reply_record_id: undefined, reply_ref: undefined } : {}),
          ...(state !== 'delivery_failed' && state !== 'needs_attention' ? { delivery_failure: undefined } : {}),
          // Retire captured task-continuation selections even if this report
          // is later removed and the watch is held for review.
          ...(state === 'delivery_failed' && value.watch.state !== 'delivery_failed' && value.watch.task_ref
            ? { task_link_version: (value.watch.task_link_version ?? 0) + 1 } : {}),
          revision: value.watch.revision + 1, checked_at: now(), updated_at: now() } };
        await deps.store.put(next, value.watch.revision, () => {
          if (deps.canRun?.() === false) throw new RpcError('unavailable', 'Reply checks are paused.', 409);
          if (state === 'draft_ready') current();
          if (state === 'delivery_failed') verifyDeliveryFailure(next);
          if (state === 'replied') {
            verifyReply(next, next.watch.reply_ref);
            const delivery = deliveryObservation(next);
            if (delivery.failure || delivery.review) throw new RpcError('resource_changed', 'Reply and delivery-report evidence conflict. Review the conversation.', 409);
          }
        }); value = next; return next.watch;
      };
      try {
        selection = seed(value.watch.mail_ref);
        if (selection.fingerprint !== value.seed_hash || selection.account !== value.mailbox_address) throw new RpcError('resource_changed', 'The watched email changed. Review it before starting another watch.', 409);
        const rows = readThread(selection).filter(row => row.record_id !== value.watch.mail_ref.record_id && row.received_at >= value.watch.mail_ref.received_at);
        const automaticCount = rows.filter(row => automaticParticipantReply(value, row)).length;
        const automatic = automaticCount > 0 || value.watch.automatic_reply_count !== undefined ? { automatic_reply_count: automaticCount } : {};
        const reply = rows.find(row => countsAsReply(value, row));
        const delivery = deliveryObservation(value);
        if (delivery.review || delivery.failure && reply) return transition('needs_attention', delivery.review ?? 'A reply and a permanent delivery failure were both reported. Review the conversation before following up.');
        if (delivery.failure) return await transition('delivery_failed', 'A permanent delivery failure was reported. Follow-up preparation has stopped. Task status is unchanged.', { delivery_failure: delivery.failure });
        if (value.watch.delivery_failure) return transition('needs_attention', 'The delivery report changed or is no longer available. Review Mail before following up.');
        if (reply) return await transition('replied', 'A recipient replied in the synced conversation.', { ...automatic, reply_record_id: reply.record_id, reply_ref: replyIdentity(value, reply) });
        if (rows.some(row => row.hot_fields.direction === 'outbound' && address(row.hot_fields.from) === selection!.account)) return transition('superseded', 'You sent another email in this conversation. Start a new watch from that email.');
        if (rows.some(row => knownParticipantReply(value, row) && storedReplyAutomation(row.hot_fields.reply_automation) === 'unknown'))
          return transition('needs_attention', 'A reply’s automatic-mail status could not be verified. Review the conversation or resync this mailbox before following up.', automaticCount !== value.watch.automatic_reply_count ? automatic : {});
        if (rows.some(row => row.hot_fields.direction !== 'outbound' && !harmlessReply(value, row))) return transition('needs_attention', 'Other or unclassified messages arrived. Review the conversation before following up.');
        const otherCount = rows.filter(row => otherParticipantReply(value, row)).length;
        const other = value.watch.waiting_for ? { other_reply_count: otherCount } : {};
        const waitingDetail = value.watch.waiting_for ? `Waiting for ${value.watch.waiting_for.address}.${otherCount ? ` ${otherCount} other participant ${otherCount === 1 ? 'reply does' : 'replies do'} not satisfy this watch. Review the conversation for context.` : ''}` : undefined;
        const changedCounts = { ...(otherCount !== value.watch.other_reply_count && value.watch.waiting_for ? other : {}),
          ...(automaticCount !== value.watch.automatic_reply_count ? automatic : {}) };
        if (now() < value.watch.check_at) return transition('waiting', waitingDetail, changedCounts);
        const health = selection.box.health(), fresh = deriveCollectionSourceFreshness(health, now());
        if (fresh.stale || health.last_indexed_at < value.watch.check_at) return transition('needs_attention', value.watch.draft_id
          ? 'The mailbox sync needs attention. Check the conversation before using the saved follow-up draft.'
          : 'Waiting for a healthy mailbox sync after your check time. No follow-up draft has been created.');
        if (value.watch.state === 'draft_ready') return Object.keys(changedCounts).length
          ? transition('draft_ready', (waitingDetail ?? 'Waiting for a recipient reply.') + ' A draft is ready for review.', changedCounts) : value.watch;
        if (deps.canRun?.() === false) return value.watch;
        const draft = await deps.createDraft({ idempotency_key: `mail-follow-up:${value.watch.id}`, content: value.draft_content }, value.owner_token_id, current); preparedDraftId = draft.draft_id;
        // Draft creation is idempotent. A reply arriving while encryption or
        // draft authorization yields must still retire the follow-up action.
        const latest = seed(value.watch.mail_ref);
        if (latest.fingerprint !== value.seed_hash) return transition('needs_attention', 'The watched email changed while preparing its draft. Review the saved draft.', { draft_id: draft.draft_id });
        const after = readThread(latest).filter(row => row.record_id !== value.watch.mail_ref.record_id && row.received_at >= value.watch.mail_ref.received_at);
        const finalDelivery = deliveryObservation(value);
        if (finalDelivery.review) return transition('needs_attention', finalDelivery.review, { draft_id: draft.draft_id });
        if (finalDelivery.failure && !after.some(row => countsAsReply(value, row))) return await transition('delivery_failed', 'A permanent delivery failure arrived while preparing the follow-up. The saved draft was kept and task status is unchanged.', { delivery_failure: finalDelivery.failure, draft_id: draft.draft_id });
        const replied = after.find(row => countsAsReply(value, row));
        if (replied) return await transition('replied', 'A reply arrived while the draft was being prepared. The saved draft has been kept for review.', { draft_id: draft.draft_id, reply_record_id: replied.record_id, reply_ref: replyIdentity(value, replied) });
        if (after.some(row => !harmlessReply(value, row))) return transition('needs_attention', 'The conversation changed while preparing its draft. Review the saved draft.', { draft_id: draft.draft_id });
        const finalCount = after.filter(row => otherParticipantReply(value, row)).length;
        return await transition('draft_ready', value.watch.waiting_for
          ? `No reply from ${value.watch.waiting_for.address} was found. ${finalCount} other participant replies are in the conversation. A draft is ready for your review.`
          : 'No recipient reply was found in the synced conversation. A draft is ready for your review.', { draft_id: draft.draft_id, ...(value.watch.waiting_for ? { other_reply_count: finalCount } : {}),
            ...(after.some(row => automaticParticipantReply(value, row)) || value.watch.automatic_reply_count !== undefined
              ? { automatic_reply_count: after.filter(row => automaticParticipantReply(value, row)).length } : {}) });
      } catch (error) {
        if (error instanceof RpcError && error.code === 'conflict') throw error;
        // A report can arrive while draft encryption yields. Re-evaluate it
        // after a failed draft guard, retaining any already-saved owner draft.
        try {
          const delivery = deliveryObservation(value);
          if (!deliveryTransitionStarted && delivery.failure && !readThread(seed(value.watch.mail_ref)).some(row => row.record_id !== value.watch.mail_ref.record_id && row.received_at >= value.watch.mail_ref.received_at && countsAsReply(value, row)))
            return await transition('delivery_failed', 'A permanent delivery failure was reported. Follow-up preparation has stopped. Task status is unchanged.', { delivery_failure: delivery.failure, ...(preparedDraftId ? { draft_id: preparedDraftId } : {}) });
        } catch { /* Changed or unavailable evidence requires review below. */ }
        return transition('needs_attention', error instanceof RpcError && ['resource_changed', 'unavailable'].includes(error.code)
          ? error.message : 'The reply check or draft preparation could not be confirmed. Check again or review this watch.', preparedDraftId ? { draft_id: preparedDraftId } : {});
      }
    });
  };
  const start = async (raw: MailFollowUpStart, token: string, authorized: () => void = () => {}, verifiedSent = false,
    continuation?: MailFollowUpTaskContinuation, finalize?: (watch: MailFollowUp) => Promise<() => void>): Promise<MailFollowUp> => {
      const args = object(raw), ref = refOf(args.mail_ref), creation = args.creation_id, at = args.check_at;
      if (typeof creation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(creation) || !Number.isSafeInteger(at)) throw new RpcError('bad_request', 'Choose a valid check time and save request.', 400);
      if (args.notify_on_reply !== undefined && typeof args.notify_on_reply !== 'boolean') throw new RpcError('bad_request', 'Choose whether to notify you when a reply arrives.', 400);
      const waitingFor = args.waiting_for === undefined ? undefined : readMailFollowUpWaitingFor(args.waiting_for);
      if (waitingFor === null) throw new RpcError('bad_request', 'Choose a To or Cc recipient to wait for.', 400);
      const id = `mfw_${creation}`, originalKey = args.notify_on_reply === true ? [ref, at, true] : [ref, at];
      const key = waitingFor ? [originalKey, waitingFor] : originalKey, hash = followUpHash(continuation ? [key, continuation] : key);
      return lockedTogether(continuation ? [id, continuation.watch_id] : [id], async () => {
        const reuse = async (prior: StoredMailFollowUp): Promise<MailFollowUp> => {
          if (!finalize) return prior.watch;
          const commit = await finalize(prior.watch), next = { ...prior, watch: { ...prior.watch, revision: prior.watch.revision + 1, updated_at: now() } };
          await deps.store.put(next, prior.watch.revision, authorized, commit); return next.watch;
        };
        const prior = await deps.store.get(id); if (prior) { if (prior.creation_hash !== hash) followUpConflict(); return reuse(prior); }
        if (!verifiedSent && (at as number) <= now() || (at as number) > now() + 366 * 86400000) throw new RpcError('bad_request', 'Choose a future check time within the next year.', 400);
        if (deps.canRun?.() === false) throw new RpcError('unavailable', 'Resume and unlock Recued before starting a reply watch.', 409);
        const selected = seed(ref), rows = readThread(selected);
        if (waitingFor && !mailFollowUpWaitingForMatches(waitingFor, selected.recipients)) throw new RpcError('resource_changed', 'The To or Cc recipients changed. Review Waiting for before starting this watch.', 409);
        if (verifiedSent) {
          const existing = await deps.store.thread(selected.key);
          if (existing && sameReminderMailReference(existing.watch.mail_ref, ref)) {
            if (continuation || JSON.stringify(existing.watch.waiting_for) !== JSON.stringify(waitingFor)) followUpConflict(); return reuse(existing);
          }
        }
        if (!verifiedSent && rows.some(row => row.record_id !== ref.record_id && row.received_at >= ref.received_at)) throw new RpcError('resource_changed', 'This conversation has newer messages. Open the latest sent email before starting a watch.', 409);
        const title = addReReplyPrefix(selected.subject).slice(0, 300);
        const content = parseMailDraftContent({
          sender_mail_instance: ref.slug, to: selected.recipients, subject: title,
          body: `Hi,\n\nI’m following up on my earlier email${selected.subject ? ` about “${selected.subject}”` : ''}. When you have a moment, could you send an update?\n\nThanks.`, body_format: 'text', in_reply_to: selected.messageId, references: [selected.messageId]
        });
        if (waitingFor) content.follow_up = parsePreapprovalJson({ after_ms: 172800000, waiting_for: waitingFor });
        const stored: StoredMailFollowUp = {
          watch: { id, revision: 1, mail_ref: ref, subject: selected.subject, check_at: at as number, state: 'waiting', created_at: now(), updated_at: now(), ...(args.notify_on_reply === true ? { notify_on_reply: true } : {}), ...(waitingFor ? { waiting_for: waitingFor } : {}) },
          thread_key: selected.key, thread_id: selected.thread, seed_hash: selected.fingerprint, creation_hash: hash, mailbox_address: selected.account, recipients: selected.recipients, draft_content: content, owner_token_id: token
        };
        const proof = () => { authorized(); if (deps.canRun?.() === false) throw new RpcError('unavailable', 'Reply checks are paused.', 409); if (seed(ref).fingerprint !== selected.fingerprint || !verifiedSent && readThread(seed(ref)).some(row => row.record_id !== ref.record_id && row.received_at >= ref.received_at)) followUpConflict(); };
        if (continuation) {
          const source = await continuationGuard(continuation);
          const latest = await requireWatch(continuation.watch_id);
          stored.watch.task_ref = continuation.task_ref; stored.watch.task_link_version = 1;
          const moved: StoredMailFollowUp = { ...latest, watch: { ...latest.watch, task_ref: undefined,
            task_link_version: (latest.watch.task_link_version ?? 0) + 1, revision: latest.watch.revision + 1, updated_at: now(),
            ...(unfinished(latest.watch) ? { state: 'superseded', detail: 'You sent a follow-up email. Task tracking continued in its new reply watch.' } : {}) } };
          const commit = await finalize?.(stored.watch);
          await deps.store.putTaskContinuation(moved, latest.watch.revision, stored, () => { proof(); source.current(); }, commit);
        } else {
          const commit = await finalize?.(stored.watch); await deps.store.put(stored, null, proof, commit);
        }
        return stored.watch;
      });
  };
  return {
    async prepareScheduledCondition(draft: MailDraft) {
      if (!draft.reply_watch_id || draft.delivery_replacement)
        throw new RpcError('bad_request', 'Open an ordinary saved follow-up from its reply watch to schedule it only if no one replies.', 400);
      const value = await requireWatch(draft.reply_watch_id);
      const condition = { watch_id: value.watch.id, draft_id: draft.draft_id, seed_hash: value.seed_hash };
      const current = () => {
        const selected = conditionSource(value, condition);
        if (!deps.store.isCurrent(value.watch.id, value.watch.revision) || value.watch.state === 'cancelled'
          || value.watch.state === 'delivery_failed' || value.watch.delivery_failure
          || draft.content.sender_mail_instance !== selected.slug || draft.content.in_reply_to !== selected.messageId) {
          throw new RpcError('resource_changed', 'The reply watch, sending mailbox or reply target changed. Reopen the follow-up before scheduling.', 409);
        }
      };
      current();
      return { condition, current, waitedFor: value.watch.waiting_for?.address };
    },
    async scheduledConditionAtDispatch(condition: ScheduledFollowUpCondition): Promise<() => ScheduledFollowUpStop | undefined> {
      let value: StoredMailFollowUp;
      try { value = await requireWatch(condition.watch_id); }
      catch { return () => reviewSend('The original reply watch could not be checked.'); }
      // The collection calls this again at its last synchronous dispatch check.
      return () => {
        try {
          const watch = value.watch;
          if (deps.canRun?.() === false || !deps.store.isCurrent(watch.id, watch.revision) || watch.state === 'cancelled')
            return reviewSend('The original reply watch changed or is unavailable.');
          const selected = conditionSource(value, condition);
          const rows = readThread(selected).filter(row => row.record_id !== watch.mail_ref.record_id && row.received_at >= watch.mail_ref.received_at);
          const delivery = deliveryObservation(value);
          if (watch.delivery_failure || delivery.failure || delivery.review) return reviewSend('The conversation has delivery evidence that needs review.');
          const reply = rows.find(row => countsAsReply(value, row));
          if (reply) return {
            outcome: { kind: 'reply', reply_ref: replyIdentity(value, reply) },
            message: 'Skipped because a recipient replied. No follow-up was sent.',
          };
          if (watch.state === 'replied' || watch.state === 'superseded' || rows.some(row => !harmlessReply(value, row)))
            return reviewSend('New or changed messages need review in the original conversation.');
          const health = selected.box.health();
          const syncedAt = selected.box.lastInboundSyncAt;
          const at = now();
          if (syncedAt == null || !Number.isSafeInteger(syncedAt) || syncedAt < watch.check_at || syncedAt > at
            || health.state === 'disconnected' || health.state === 'syncing'
            || deriveCollectionSourceFreshness({ ...health, last_indexed_at: syncedAt }, at, CONDITIONAL_MAIL_SYNC_MAX_AGE_MS).stale)
            return reviewSend('The mailbox has no recent, complete inbound sync.');
          return undefined;
        } catch {
          return reviewSend('Recued could not confirm the original conversation.');
        }
      };
    },
    async createReplacement(raw: import('@recued/contracts').MailFollowUpReplacementCreate, token: string, authorized: () => void): Promise<MailFollowUp> {
      const args = object(raw), id = idOf(args.id);
      if (Object.keys(args).some(key => !['id', 'expected_revision', 'request_id'].includes(key))
        || !Number.isSafeInteger(args.expected_revision) || (args.expected_revision as number) < 1
        || typeof args.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args.request_id))
        throw new RpcError('bad_request', 'Choose the current failed watch and a valid draft request.', 400);
      return locked(id, async () => {
        let value = await requireWatch(id);
        const hash = replacementHash(value);
        const current = () => { authorized(); if (deps.canRun?.() === false) throw new RpcError('unavailable', 'Resume and unlock Recued before preparing a replacement.', 409); replacementGuard(value, hash); };
        current();
        if (!value.replacement && value.watch.revision !== args.expected_revision) followUpConflict();
        if (value.replacement && value.replacement.failure_hash !== hash) throw new MailFollowUpTaskContinuationChanged();
        if (value.replacement?.draft_id) return value.watch;
        if (!deps.readReplacement) throw new RpcError('unavailable', 'Verified replacement drafts are unavailable on this server.', 503);
        const source = await deps.readReplacement(value.watch.mail_ref, value.watch.delivery_failure!.recipient, current);
        source.current();
        if (value.replacement && followUpHash(source.content) !== followUpHash(value.replacement.content))
          throw new RpcError('resource_changed', 'The original email changed after replacement preparation. Review it in Mail.', 409);
        if (!value.replacement) {
          const next: StoredMailFollowUp = { ...value, replacement: { request_id: args.request_id as string, failure_hash: hash, content: source.content },
            watch: { ...value.watch, revision: value.watch.revision + 1, updated_at: now() } };
          await deps.store.put(next, value.watch.revision, source.current); value = next;
        }
        // Keep the initial seed stable across a lost response, even after the
        // owner edits the saved copy. Draft creation never overwrites edits.
        const draft = await deps.createDraft({ idempotency_key: `mail-follow-up-replacement:${id}:${value.replacement!.request_id}`,
          content: value.replacement!.content }, token, source.current);
        const next: StoredMailFollowUp = { ...value, replacement: { ...value.replacement!, draft_id: draft.draft_id },
          watch: { ...value.watch, replacement_draft_id: draft.draft_id, revision: value.watch.revision + 1, updated_at: now() } };
        await deps.store.put(next, value.watch.revision, source.current); return next.watch;
      });
    },
    async taskContext(raw: { watch_id: string; draft_id: string }): Promise<MailFollowUpTaskContext> {
      const args = object(raw);
      if (Object.keys(args).some(key => !['watch_id', 'draft_id'].includes(key)) || typeof args.draft_id !== 'string')
        throw new RpcError('bad_request', 'Choose a saved follow-up draft.', 400);
      const value = await requireWatch(args.watch_id);
      const replacement = value.replacement?.draft_id === args.draft_id;
      if (replacement) replacementGuard(value, value.replacement!.failure_hash);
      if (!replacement && value.watch.draft_id !== args.draft_id) throw new RpcError('resource_changed', 'This draft no longer belongs to that reply watch.', 409);
      if (!deps.tasks || !value.watch.task_ref || value.watch.state === 'cancelled') return { available: Boolean(deps.tasks), selection: null };
      const task = requireMailFollowUpTask(await deps.tasks.read(value.watch.task_ref.id), now(), true);
      const selection: MailFollowUpTaskContinuation = { watch_id: value.watch.id, draft_id: args.draft_id,
        task_ref: value.watch.task_ref, link_version: value.watch.task_link_version ?? 0, task_hash: taskFingerprint(task),
        ...(replacement ? { replacement_hash: value.replacement!.failure_hash } : {}) };
      const guard = await continuationGuard(selection); guard.current();
      return { available: true, selection, title: task.title };
    },
    validateContinuation: async (selection: MailFollowUpTaskContinuation, content: StoredMailFollowUp['draft_content']) => (await continuationGuard(selection, content)).current,
    async getTask(raw: { id: string }): Promise<MailFollowUpTaskView> {
      const value = await requireWatch(object(raw).id);
      const base = { available: Boolean(deps.tasks), watch: value.watch, task: null,
        can_create: !value.watch.task_ref && (value.task_creations?.length ?? 0) < 32 && Boolean(deps.tasks?.create?.available()) };
      if (!value.watch.task_ref || !deps.tasks) return base;
      try {
        const task = requireMailFollowUpTask(await deps.tasks.read(value.watch.task_ref.id), now());
        if (!sameMailFollowUpTaskRef(value.watch.task_ref, mailFollowUpTaskRef(task)!)) throw new RpcError('resource_changed', 'The linked task was removed or replaced. Choose the task again.', 409);
        if ((await requireWatch(value.watch.id)).watch.revision !== value.watch.revision) followUpConflict();
        return { ...base, task: { ref: value.watch.task_ref, title: task.title, done: task.done } };
      } catch (cause) {
        if (cause instanceof RpcError && ['server_locked', 'conflict'].includes(cause.code)) throw cause;
        return { ...base, reason: cause instanceof RpcError && cause.code === 'resource_changed' ? cause.message : 'The linked task could not be checked. Open Tasks or try again.' };
      }
    },
    async createTask(raw: MailFollowUpTaskCreate, authorized: () => void): Promise<MailFollowUp> {
      const args = object(raw), id = idOf(args.id), request = args.request_id;
      if (Object.keys(args).some(key => !['id', 'expected_revision', 'request_id', 'title', 'due_on', 'client_url'].includes(key))
        || !Number.isSafeInteger(args.expected_revision) || (args.expected_revision as number) < 1
        || typeof request !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request)
        || typeof args.title !== 'string' || !args.title.trim() || args.title.length > TASK_TITLE_MAX
        || args.due_on !== undefined && (typeof args.due_on !== 'string' || calendarDayMs(args.due_on) === null)
        || typeof args.client_url !== 'string' || args.client_url.length > 4096)
        throw new RpcError('bad_request', 'Enter a task title and a valid optional due date.', 400);
      let url: URL;
      try {
        url = new URL(args.client_url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
      } catch { throw new RpcError('bad_request', 'The email link could not be prepared. Reopen the reply watch.', 400); }
      const title = args.title.trim(), due = args.due_on === undefined ? undefined : calendarDayMs(args.due_on as string)!;
      const hash = followUpHash([id, args.expected_revision, title, args.due_on ?? null, url.href]);
      const repeat = (value: StoredMailFollowUp): boolean => {
        const saved = value.task_creations?.find(item => item.request_id === request);
        if (saved && saved.request_hash !== hash) followUpConflict(); return Boolean(saved);
      };
      return locked(id, async () => {
        const value = await requireWatch(id);
        if (repeat(value)) return value.watch;
        if (value.watch.revision !== args.expected_revision || value.watch.task_ref) followUpConflict();
        if ((value.task_creations?.length ?? 0) >= 32) throw new RpcError('limit_exceeded', 'Link an existing task to this watch instead.', 409);
        if (!deps.tasks?.create) throw new RpcError('unavailable', 'Local task creation is unavailable on this server.', 503);
        const current = () => {
          authorized();
          if (deps.canRun?.() === false) throw new RpcError('unavailable', 'Resume and unlock Recued before creating a task.', 409);
          if (seed(value.watch.mail_ref).fingerprint !== value.seed_hash) followUpConflict();
        };
        current();
        url.hash = `#data/mail/record/${encodeURIComponent(value.watch.mail_ref.slug)}/${encodeURIComponent(value.watch.mail_ref.record_id)}`;
        const prepared = deps.tasks.create.prepare({ id: randomUUID(), created_at: now(), title,
          body: `Email reply watch: ${value.watch.subject || '(No subject)'}\nEmail: ${url.href}`, ...(due === undefined ? {} : { due_at: due }) });
        const next: StoredMailFollowUp = { ...value,
          task_creations: [...value.task_creations ?? [], { request_id: request, request_hash: hash, task_ref: prepared.ref }],
          watch: { ...value.watch, task_ref: prepared.ref, task_link_version: (value.watch.task_link_version ?? 0) + 1, revision: value.watch.revision + 1, updated_at: now() } };
        try {
          await deps.store.put(next, value.watch.revision, current, () => {
            prepared.write();
            const task = requireMailFollowUpTask(deps.tasks!.current(prepared.ref.id), now(), true);
            if (!sameMailFollowUpTaskRef(prepared.ref, mailFollowUpTaskRef(task)!)) followUpConflict();
          });
        } catch (cause) {
          // A second service/process can finish this same request while crypto
          // yields. Its durable receipt is authoritative; no second task writes.
          if (cause instanceof RpcError && cause.code === 'conflict') {
            const latest = await requireWatch(id); if (repeat(latest)) return latest.watch;
          }
          throw cause;
        }
        try { prepared.publish(); } catch { /* The canonical transaction is already committed. */ }
        return next.watch;
      });
    },
    async setTask(raw: MailFollowUpTaskSet, authorized: () => void): Promise<MailFollowUp> {
      const args = object(raw), id = idOf(args.id), request = args.request_id;
      if (Object.keys(args).some(key => !['id', 'expected_revision', 'request_id', 'task_id'].includes(key))
        || !Number.isSafeInteger(args.expected_revision) || (args.expected_revision as number) < 1
        || typeof request !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request)
        || args.task_id !== null && (typeof args.task_id !== 'string' || !args.task_id || args.task_id.length > 2048))
        throw new RpcError('bad_request', 'Choose an existing task and the current watch revision.', 400);
      const hash = followUpHash([id, args.expected_revision, args.task_id]);
      return locked(id, async () => {
        const value = await requireWatch(id);
        if (value.task_link_request?.request_id === request) { if (value.task_link_request.request_hash !== hash) followUpConflict(); return value.watch; }
        if (value.watch.revision !== args.expected_revision) followUpConflict();
        let ref: MailFollowUpTaskRef | undefined;
        if (args.task_id !== null) {
          if (!deps.tasks) throw new RpcError('unavailable', 'Task links are unavailable on this server.', 503);
          const task = requireMailFollowUpTask(await deps.tasks.read(args.task_id as string), now(), true);
          if (task.id !== args.task_id) throw new RpcError('resource_changed', 'The selected task could not be confirmed.', 409);
          ref = mailFollowUpTaskRef(task)!;
        }
        const current = () => {
          authorized();
          if (ref) {
            const task = requireMailFollowUpTask(deps.tasks!.current(ref.id), now(), true);
            if (!sameMailFollowUpTaskRef(ref, mailFollowUpTaskRef(task)!)) throw new RpcError('resource_changed', 'The selected task changed while linking it. Choose the task again.', 409);
            if (seed(value.watch.mail_ref).fingerprint !== value.seed_hash) followUpConflict();
          }
        };
        current();
        const next: StoredMailFollowUp = { ...value, task_link_request: { request_id: request, request_hash: hash },
          watch: { ...value.watch, task_ref: ref, task_link_version: (value.watch.task_link_version ?? 0) + 1, revision: value.watch.revision + 1, updated_at: now() } };
        await deps.store.put(next, value.watch.revision, current); return next.watch;
      });
    },
    async taskLinks(raw: { tasks: MailFollowUpTaskRef[] }): Promise<MailFollowUpTaskLinks> {
      const args = object(raw);
      if (Object.keys(args).some(key => key !== 'tasks') || !Array.isArray(args.tasks) || args.tasks.length > 100)
        throw new RpcError('bad_request', 'Choose up to 100 task references.', 400);
      const refs = args.tasks.map(readMailFollowUpTaskRef);
      if (refs.some(ref => !ref)) throw new RpcError('bad_request', 'Choose valid task references.', 400);
      const result: MailFollowUpTaskLinks = { available: Boolean(deps.tasks), links: [], unavailable: [] };
      if (!deps.tasks) return result;
      const seen = new Set<string>();
      for (const ref of refs as MailFollowUpTaskRef[]) {
        const key = followUpHash(ref); if (seen.has(key)) continue; seen.add(key);
        const value = await deps.store.byTask(ref); if (!value) continue;
        try {
          const task = requireMailFollowUpTask(await deps.tasks.read(ref.id), now());
          if (!sameMailFollowUpTaskRef(ref, mailFollowUpTaskRef(task)!)) { result.unavailable.push(ref); continue; }
          if ((await requireWatch(value.watch.id)).watch.revision !== value.watch.revision) followUpConflict();
          result.links.push({ task_ref: ref, watch: value.watch });
        } catch (cause) {
          if (cause instanceof RpcError && ['server_locked', 'conflict'].includes(cause.code)) throw cause;
          result.unavailable.push(ref);
        }
      }
      return result;
    },
    async get(raw: unknown) {
      const ref = refOf(object(raw).mail_ref);
      try { const selected = seed(ref), existing = await deps.store.thread(selected.key); return { eligible: true, watch: existing?.watch ?? null, recipients: selected.recipients.slice().sort() }; }
      catch (error) { if (error instanceof RpcError && ['resource_changed', 'unavailable'].includes(error.code)) return { eligible: false, reason: error.message, watch: null }; throw error; }
    },
    start: (raw: MailFollowUpStart, token: string, authorized?: () => void) => start(raw, token, authorized),
    /** Host-only: the send observer supplies and revalidates the exact Sent proof. */
    startSent: (raw: MailFollowUpStart, token: string, proof: () => void, continuation?: MailFollowUpTaskContinuation,
      finalize?: (watch: MailFollowUp) => Promise<() => void>) => start(raw, token, proof, true, continuation, finalize),
    check,
    replyGuard,
    async getDeliveryReport(raw: { id: string }): Promise<MailFollowUpReplyTarget> {
      const value = await requireWatch(object(raw).id);
      if (value.watch.state !== 'delivery_failed') throw new RpcError('unavailable', 'A verified delivery report is unavailable for this watch.', 409);
      return { watch: value.watch, mail_ref: verifyDeliveryFailure(value) };
    },
    async getReply(raw: { id: string }): Promise<MailFollowUpReplyTarget> {
      return (await replyGuard(object(raw).id))();
    },
    async setReplyNotification(raw: MailFollowUpReplyNotification, authorized: () => void = () => {}, ownerTokenId?: string): Promise<MailFollowUp> {
      const args = object(raw), id = idOf(args.id), revision = args.expected_revision, enabled = args.enabled;
      if (!Number.isSafeInteger(revision) || (revision as number) < 1 || typeof enabled !== 'boolean')
        throw new RpcError('bad_request', 'Choose a reply notification preference for this watch.', 400);
      return locked(id, async () => {
        const value = await requireWatch(id);
        if ((value.watch.notify_on_reply ?? false) === enabled) return value.watch;
        if (value.watch.revision !== revision || enabled && !unfinished(value.watch)) followUpConflict();
        const next: StoredMailFollowUp = { ...value, ...(enabled && ownerTokenId ? { reply_notification_owner_token_id: ownerTokenId } : {}),
          watch: { ...value.watch, notify_on_reply: enabled, revision: value.watch.revision + 1, updated_at: now() } };
        await deps.store.put(next, value.watch.revision, authorized); return next.watch;
      });
    },
    async reschedule(raw: MailFollowUpReschedule, authorized: () => void = () => {}): Promise<MailFollowUp> {
      const args = object(raw), id = idOf(args.id), revision = args.expected_revision, at = args.check_at, request = args.request_id;
      if (!Number.isSafeInteger(revision) || (revision as number) < 1 || !Number.isSafeInteger(at)
        || typeof request !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request))
        throw new RpcError('bad_request', 'Choose a valid check time and save request.', 400);
      const hash = followUpHash([id, revision, at]);
      return locked(id, async () => {
        const value = await requireWatch(id);
        // A lost response retries the same change even after its deadline or a later reply.
        if (value.reschedule?.request_id === request) {
          if (value.reschedule.request_hash !== hash) followUpConflict();
          return value.watch;
        }
        if (value.watch.revision !== revision || !unfinished(value.watch)) followUpConflict();
        const current = () => {
          authorized();
          if (deps.canRun?.() === false) throw new RpcError('unavailable', 'Resume and unlock Recued before changing this reply watch.', 409);
          if ((at as number) <= now() || (at as number) > now() + 366 * 86400000)
            throw new RpcError('bad_request', 'Choose a future check time within the next year.', 400);
          const selected = seed(value.watch.mail_ref);
          const delivery = deliveryObservation(value);
          if (value.watch.delivery_failure || delivery.failure || delivery.review) throw new RpcError('resource_changed', 'A delivery report arrived. Check this watch before changing its time.', 409);
          if (selected.fingerprint !== value.seed_hash || readThread(selected).some(row => row.record_id !== value.watch.mail_ref.record_id && row.received_at >= value.watch.mail_ref.received_at && !harmlessReply(value, row)))
            throw new RpcError('resource_changed', 'The conversation changed. Check this watch before changing its time.', 409);
        };
        current();
        const next: StoredMailFollowUp = { ...value, reschedule: { request_id: request, request_hash: hash },
          watch: { ...value.watch, state: 'waiting', check_at: at as number, schedule_version: (value.watch.schedule_version ?? 0) + 1,
            revision: value.watch.revision + 1, updated_at: now(), detail: undefined } };
        await deps.store.put(next, value.watch.revision, current);
        return next.watch;
      });
    },
    async cancel(raw: unknown) {
      const args = object(raw), id = idOf(args.id), revision = args.expected_revision;
      if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new RpcError('bad_request', 'The current watch revision is required.', 400);
      return locked(id, async () => {
        const value = await requireWatch(id); if (value.watch.state === 'cancelled') return value.watch; if (value.watch.revision !== revision) followUpConflict();
        const next = { ...value, watch: { ...value.watch, state: 'cancelled' as const, detail: value.watch.draft_id ? 'Watch cancelled. Its saved draft has been kept.' : 'Watch cancelled.', revision: value.watch.revision + 1, updated_at: now() } };
        await deps.store.put(next, value.watch.revision); return next.watch;
      });
    },
    async list(raw?: unknown) {
      const args = raw === undefined ? {} : object(raw), cursor = args.cursor as MailFollowUpCursor | undefined;
      if (cursor !== undefined && (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !Number.isSafeInteger(cursor.updated_at) || typeof cursor.id !== 'string' || cursor.id.length > 128 || !/^mfw_[0-9a-f-]{36}$/.test(cursor.id))) throw new RpcError('bad_request', 'Choose a valid watch page.', 400);
      const filters = parseMailFollowUpFilters({ ...(args.state !== undefined ? { state: args.state } : {}), ...(args.mailbox !== undefined ? { mailbox: args.mailbox } : {}) });
      if (!filters || args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 2000)
        || args.limit !== undefined && (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 50)
        || args.attention_at !== undefined && (!Number.isSafeInteger(args.attention_at) || Math.abs(args.attention_at as number) > 8.64e15))
        throw new RpcError('bad_request', 'Choose valid reply watch search filters.', 400);
      const page = await deps.store.list(cursor, { ...filters, query: args.query as string | undefined,
        limit: args.limit as number | undefined, attention_at: args.attention_at as number | undefined });
      return { watches: page.rows.map(row => row.watch), next_cursor: page.next_cursor };
    },
    async sweep() { if (deps.canRun?.() === false) return; for (const id of deps.store.activeIds()) { if (deps.canRun?.() === false) return; try { await check(id); } catch {/* A concurrent owner change is checked on the next pass. */ } } },
  };
};
export type MailFollowUpService = ReturnType<typeof createMailFollowUpService>;
