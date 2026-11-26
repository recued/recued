import {
  RpcError, SEND_COMPOSED_MAIL_RECIPE_ID, canonicalizeEmail, parseAddress, normalizeMailSend, parseMailDraftContent,
  parseMailFollowUpPreference, mailFollowUpRecipientReason, reminderMailReference, type MailDraft, type MailFollowUpSendIntent, type ServerExecuteResponse,
  mailFollowUpRecipients, mailFollowUpWaitingForMatches,
} from '@recued/contracts';
import { IngredientError } from '@recued/ingredients';
import { mailRecordIdForSource, type MailSendResult } from './collections/mail/mail-collection.js';
import { followUpHash } from './storage/mail-follow-up-store.js';
import type { MailFollowUpSendStore, StoredFollowUpSend } from './storage/mail-follow-up-send-store.js';
import { MailFollowUpTaskContinuationChanged, type MailFollowUpService } from './mail-follow-up-service.js';
import { currentPreapprovalIo } from './preapproval-io-context.js';
import type { Collection } from './collections/types.js';
import type { PreparedFutureExecution } from './preapproval-model.js';

type Input = unknown;
type Mailbox = Pick<Collection, 'get'> & { readonly accountEmail: string };
type ScheduledSend = { plan: PreparedFutureExecution; future_execution_ref: string };
const object = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RpcError('bad_request', 'Choose a valid pending reply watch.', 400);
  return raw as Record<string, unknown>;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const idOf = (raw: unknown): string => { if (typeof raw !== 'string' || !raw.startsWith('mfw_') || !uuid.test(raw.slice(4))) throw new RpcError('bad_request', 'Choose a valid reply watch.', 400); return raw; };
const email = (raw: string) => canonicalizeEmail(parseAddress(raw)?.email ?? '');
const publicCopy = (value: StoredFollowUpSend): MailFollowUpSendIntent => ({ ...value.intent });
/** Full normalized payload, including recipients and attachments. Watch metadata
 * and host-only run/step identity cannot change what was actually sent. */
const contentHash = (raw: Input): string => {
  const value = object(raw);
  return followUpHash(normalizeMailSend(typeof value.instance === 'string' ? { ...value, sender_mail_instance: value.instance,
    body: value.body_html ?? value.body_text, body_format: value.body_html !== undefined ? 'html' : 'text' } : value));
};

export const createMailFollowUpSendService = (deps: {
  store: MailFollowUpSendStore; watches: MailFollowUpService;
  mailbox(slug: string): Mailbox | undefined; incarnation(slug: string): string | null;
  validateOwner(token: string): void; runStatus?(id: string): Promise<string | undefined>;
  now?: () => number; canRun?: () => boolean;
}) => {
  const now = deps.now ?? Date.now, locks = new Map<string, Promise<unknown>>(), executions = new Map<string, { hash: string; promise: Promise<ServerExecuteResponse> }>();
  const locked = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    const prior = locks.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(action); locks.set(id, next);
    try { return await next; } finally { if (locks.get(id) === next) locks.delete(id); }
  };
  const sourceGuard = (value: StoredFollowUpSend): void => {
    deps.validateOwner(value.owner_token_id);
    if (deps.incarnation(value.intent.mailbox) !== value.incarnation || email(deps.mailbox(value.intent.mailbox)?.accountEmail ?? '') !== value.account)
      throw new RpcError('resource_changed', 'The sending mailbox was removed or replaced. This reply watch has not started.', 409);
  };
  const save = async (value: StoredFollowUpSend, patch: Partial<MailFollowUpSendIntent>, extras: Partial<StoredFollowUpSend> = {}, guard = () => {}): Promise<StoredFollowUpSend> => {
    const next = { ...value, ...extras, intent: { ...value.intent, ...patch, revision: value.intent.revision + 1, updated_at: now() } };
    await deps.store.put(next, value.intent.revision, guard); return next;
  };
  const requireIntent = async (id: string) => { const value = await deps.store.get(id); if (!value) throw new RpcError('not_found', 'This pending reply watch is unavailable.', 404); return value; };
  const scheduledContent = (raw: unknown, token: string) => {
    const content = parseMailDraftContent(raw), preference = parseMailFollowUpPreference(content.follow_up);
    if (preference.waiting_for) throw new RpcError('preapproval_unsupported', 'Waiting for a specific person is available with Send. Choose Anyone on To/Cc before scheduling.', 409);
    deps.validateOwner(token);
    const mailbox = content.sender_mail_instance, box = deps.mailbox(mailbox), incarnation = deps.incarnation(mailbox), account = email(box?.accountEmail ?? '');
    if (!box || !incarnation || !account) throw new RpcError('resource_changed', 'The sending mailbox could not be confirmed.', 409);
    const normalized = normalizeMailSend(content), reason = mailFollowUpRecipientReason(normalized.to, normalized.cc ?? [], account);
    if (reason) throw new RpcError('bad_request', reason, 400);
    return { content, preference, mailbox, incarnation, account };
  };
  const scheduledIntent = async (input: Input, runId: string, scheduled: ScheduledSend): Promise<StoredFollowUpSend> => {
    const { plan, future_execution_ref: futureRef } = scheduled, token = plan.origin.credential_id;
    if (!plan.mail_follow_up || !plan.draft_snapshot || plan.request.subject.kind !== 'mail_draft'
      || plan.request.activation.kind !== 'one_shot' || plan.origin.mode !== 'owner' || plan.origin.entry !== 'owner_ui' || !token
      || typeof futureRef !== 'string' || !futureRef)
      throw new RpcError('bad_request', 'This reply watch has no reviewed scheduled email.', 400);
    const selected = scheduledContent(plan.draft_snapshot.content, token);
    if (selected.preference.continue_task && selected.preference.continue_task.draft_id !== plan.request.subject.draft_id)
      throw new RpcError('resource_changed', 'Task tracking belongs to a different draft. Review the saved draft again.', 409);
    const scheduledFor = plan.request.activation.run_at;
    if (followUpHash(selected.preference) !== followUpHash(plan.mail_follow_up) || contentHash(input) !== contentHash(selected.content))
      throw new RpcError('resource_changed', 'The scheduled reply watch does not match the reviewed email.', 409);
    const hex = followUpHash(['scheduled-reply-watch-v1', futureRef]).slice(0, 32);
    const id = `mfw_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const hash = followUpHash([futureRef, plan]);
    return locked(id, async () => {
      let value = await deps.store.get(id);
      if (value) {
        if (value.request_hash !== hash || value.intent.future_execution_ref !== futureRef) throw new RpcError('conflict', 'The reviewed scheduled email changed.', 409);
        // An unused claim can be handed back during a restart. Only a request
        // with no native dispatch may follow its replacement run; uncertainty
        // and confirmed receipts keep the original dispatch fence forever.
        if (value.intent.run_id !== runId && !value.dispatch_started && !value.receipt) {
          const previousRun = value.intent.run_id;
          value = { ...value, intent: { ...value.intent, run_id: runId, revision: value.intent.revision + 1, updated_at: now() } };
          await deps.store.put(value, value.intent.revision - 1, () => sourceGuard(value!), previousRun);
        }
        return value;
      }
      if (deps.canRun?.() === false) throw new RpcError('unavailable', 'Resume and unlock Recued before sending with a reply watch.', 409);
      const { continue_task, ...publicPreference } = selected.preference;
      value = { content: selected.content, incarnation: selected.incarnation, account: selected.account, owner_token_id: token, request_hash: hash,
        ...(continue_task ? { continue_task } : {}),
        intent: { id, revision: 1, subject: selected.content.subject, mailbox: selected.mailbox, ...publicPreference,
          state: 'awaiting_send', created_at: now(), updated_at: now(), run_id: runId, future_execution_ref: futureRef,
          scheduled_for: scheduledFor, detail: 'Waiting for the reviewed scheduled send. The reply watch has not started yet.' } };
      await deps.store.put(value, null, () => sourceGuard(value!)); return value;
    });
  };
  const bind = (id: string, runId: string, authorized: () => void) => locked(id, async () => {
    const value = await requireIntent(id);
    if (value.intent.run_id && value.intent.run_id !== runId) throw new RpcError('conflict', 'This reply watch already belongs to another send.', 409);
    if (!value.intent.run_id) await save(value, { run_id: runId }, {}, () => { authorized(); sourceGuard(value); });
  });
  const reconcile = (id: string): Promise<MailFollowUpSendIntent | null> => locked(id, async () => {
    let value = await deps.store.get(id); if (!value) return null;
    if (['armed', 'cancelled', 'not_sent'].includes(value.intent.state) || value.task_continuation_blocked || deps.canRun?.() === false) return publicCopy(value);
    try {
      sourceGuard(value);
      if (value.receipt) {
        const receipt = value.receipt, box = deps.mailbox(value.intent.mailbox)!;
        const record = box.get(receipt._id ?? mailRecordIdForSource(receipt.source_id));
        if (!record) {
          if (value.intent.state !== 'awaiting_sync') value = await save(value, { state: 'awaiting_sync', detail: 'Waiting for this email in the synced Sent messages. The reply watch has not started yet.' });
          return publicCopy(value);
        }
        const hot = record.hot_fields, actual = reminderMailReference(value.intent.mailbox, record, value.incarnation);
        const expected = normalizeMailSend(value.content);
        const addresses = (raw: unknown): string[] => Array.isArray(raw) && raw.every(item => typeof item === 'string') ? raw.map(item => email(item as string)).sort() : [];
        if (!actual || record.source_id !== receipt.source_id || record.received_at < value.intent.created_at - 60000
          || Math.abs(record.received_at - receipt.sent_at) > 300000 || hot.direction !== 'outbound' || email(String(hot.from ?? '')) !== value.account
          || hot.subject !== value.content.subject || JSON.stringify(addresses(hot.to)) !== JSON.stringify(addresses(expected.to))
          || JSON.stringify(addresses(hot.cc)) !== JSON.stringify(addresses(expected.cc ?? []))
          || typeof hot.rfc_message_id !== 'string' || !hot.rfc_message_id || typeof hot.thread_id !== 'string' || !hot.thread_id)
          throw new RpcError('resource_changed', 'The exact sent email or its reply headers could not be confirmed. Review it in Mail before starting a watch.', 409);
        const identity = () => {
          const current = box.get(record.record_id), fields = current?.hot_fields;
          return followUpHash([current && reminderMailReference(value!.intent.mailbox, current, value!.incarnation),
            fields?.from, fields?.to, fields?.cc, fields?.subject, fields?.rfc_message_id, fields?.thread_id, fields?.direction]);
        };
        const snapshot = identity(), original = value;
        const proof = () => {
          sourceGuard(original);
          if (!deps.store.isCurrent(original.intent.id, original.intent.revision)) throw new RpcError('conflict', 'This pending reply watch changed while its sent email was being checked.', 409);
          if (identity() !== snapshot) throw new RpcError('resource_changed', 'The sent email changed while starting its reply watch.', 409);
        };
        let armed: StoredFollowUpSend | undefined;
        const watch = await deps.watches.startSent({ creation_id: id.slice(4), mail_ref: actual,
          check_at: receipt.sent_at + value.intent.after_ms, ...(value.intent.notify_on_reply ? { notify_on_reply: true } : {}),
          ...(value.intent.waiting_for ? { waiting_for: value.intent.waiting_for } : {}) }, value.owner_token_id, proof, value.continue_task,
          async target => {
            const next: StoredFollowUpSend = { ...original, intent: { ...original.intent, state: 'armed', watch_id: target.id,
              revision: original.intent.revision + 1, updated_at: now(), detail: 'The exact sent email is verified. Open its reply watch to review the current status.' } };
            const commit = await deps.store.prepare(next, original.intent.revision, proof); armed = next; return commit;
          });
        value = armed!;
        // A reply can arrive before the Sent sync. The ordinary check recognizes
        // it before any due draft can be prepared.
        await deps.watches.check(watch.id);
      } else if (value.intent.run_id && deps.runStatus) {
        const status = await deps.runStatus(value.intent.run_id);
        if (status && ['failed', 'cancelled', 'killed', 'in_doubt'].includes(status)) value = await save(value, {
          state: value.dispatch_started ? 'needs_attention' : 'not_sent', detail: value.dispatch_started
            ? 'The send outcome could not be confirmed. No reply watch has started. Check Mail before trying to send again.'
            : 'The send stopped before dispatch. No reply watch was started.' });
      }
    } catch (cause) {
      if (cause instanceof RpcError && cause.code === 'server_locked') throw cause;
      if (value.intent.state === 'armed') return publicCopy(value);
      if (cause instanceof RpcError && cause.code === 'conflict') {
        const latest = await requireIntent(id); if (latest.intent.revision !== value.intent.revision) return publicCopy(latest);
      }
      value = await save(value, { state: 'needs_attention', detail: cause instanceof MailFollowUpTaskContinuationChanged
        ? 'The email was sent, but its task tracking changed. No new reply watch was started. Review the task and start a watch from Sent.'
        : cause instanceof Error ? cause.message : 'This reply watch needs review.' },
        cause instanceof MailFollowUpTaskContinuationChanged ? { task_continuation_blocked: true } : {});
    }
    return publicCopy(value);
  });
  const responseFor = (value: StoredFollowUpSend): ServerExecuteResponse => ({ ...(value.response ?? {
    recipe_id: SEND_COMPOSED_MAIL_RECIPE_ID, recipe_hash: '', success: false, output: { render: [], sidebar: [] }, steps: [], errors: [], duration_ms: 0,
    ...(value.intent.run_id ? { run_id: value.intent.run_id } : {}), awaiting_approval: value.intent.state === 'awaiting_approval',
  }), mail_follow_up: publicCopy(value) });
  return {
    async prepareScheduledCondition(draft: MailDraft, token: string) {
      deps.validateOwner(token);
      const checked = await deps.watches.prepareScheduledCondition(draft);
      return { ...checked, current() { deps.validateOwner(token); checked.current(); } };
    },
    scheduledConditionAtDispatch: deps.watches.scheduledConditionAtDispatch,
    validateScheduled: (content: unknown, token: string) => scheduledContent(content, token).preference,
    async validateScheduledTask(raw: unknown, token: string, draftId: string): Promise<{ title: string; current(): void } | undefined> {
      const selected = scheduledContent(raw, token), choice = selected.preference.continue_task;
      if (!choice) return undefined;
      if (choice.draft_id !== draftId)
        throw new RpcError('resource_changed', 'Task tracking belongs to a different draft. Reopen the saved draft from its reply watch before scheduling.', 409);
      const guard = await deps.watches.validateContinuation(choice, selected.content);
      const current = () => {
        scheduledContent(raw, token);
        return guard();
      };
      return { title: current(), current };
    },
    async execute(raw: Record<string, unknown>, token: string, authorized: () => void,
      invoke: (before: (runId: string) => Promise<void>) => Promise<ServerExecuteResponse>): Promise<ServerExecuteResponse> {
      const request = object(raw.mail_follow_up), requestId = request.request_id;
      if (typeof requestId !== 'string' || !uuid.test(requestId) || Object.keys(request).some(key => !['request_id', 'after_ms', 'notify_on_reply', 'continue_task', 'waiting_for'].includes(key))
        || raw.recipe_id !== SEND_COMPOSED_MAIL_RECIPE_ID || Object.keys(raw).some(key => !['recipe_id', 'config', 'trigger_source', 'mail_follow_up'].includes(key))
        || raw.trigger_source !== undefined && raw.trigger_source !== 'manual') throw new RpcError('bad_request', 'Reply watches from the composer require a one-off composed email.', 400);
      const preference = parseMailFollowUpPreference({ after_ms: request.after_ms, ...(request.notify_on_reply !== undefined ? { notify_on_reply: request.notify_on_reply } : {}),
        ...(request.continue_task !== undefined ? { continue_task: request.continue_task } : {}), ...(request.waiting_for !== undefined ? { waiting_for: request.waiting_for } : {}) });
      const content = parseMailDraftContent(raw.config), id = 'mfw_' + requestId, hash = followUpHash([contentHash(content), preference]);
      const priorExecution = executions.get(id);
      if (priorExecution) { if (priorExecution.hash !== hash) throw new RpcError('conflict', 'This reply watch request belongs to a different email or check interval.', 409); const result = await priorExecution.promise; authorized(); return result; }
      const work = (async () => {
        const prior = await deps.store.get(id);
        if (prior) {
          if (prior.request_hash !== hash) throw new RpcError('conflict', 'This reply watch request belongs to a different email or check interval.', 409);
          authorized(); return responseFor(prior); // A lost response never authorizes another run.
        }
        if (deps.canRun?.() === false) throw new RpcError('unavailable', 'Resume and unlock Recued before sending with a reply watch.', 409);
        const mailbox = content.sender_mail_instance, box = deps.mailbox(mailbox), incarnation = deps.incarnation(mailbox), account = email(box?.accountEmail ?? '');
        if (!box || !incarnation || !account) throw new RpcError('resource_changed', 'The sending mailbox could not be confirmed.', 409);
        const normalized = normalizeMailSend(content), reason = mailFollowUpRecipientReason(normalized.to, normalized.cc ?? [], account);
        if (reason) throw new RpcError('bad_request', reason, 400);
        if (preference.waiting_for && !mailFollowUpWaitingForMatches(preference.waiting_for, mailFollowUpRecipients(normalized.to, normalized.cc ?? [], account)))
          throw new RpcError('resource_changed', 'The To or Cc recipients changed. Review Waiting for before sending.', 409);
        const taskGuard = preference.continue_task ? await deps.watches.validateContinuation(preference.continue_task, content) : () => {};
        const created: StoredFollowUpSend = { intent: { id, revision: 1, subject: content.subject, mailbox, after_ms: preference.after_ms,
          ...(preference.notify_on_reply ? { notify_on_reply: true } : {}), ...(preference.waiting_for ? { waiting_for: preference.waiting_for } : {}), state: 'awaiting_send', created_at: now(), updated_at: now(), detail: 'Waiting for the governed send. The reply watch has not started yet.' },
          ...(preference.continue_task ? { continue_task: preference.continue_task } : {}), content, request_hash: hash, owner_token_id: token, incarnation, account };
        await deps.store.put(created, null, () => { authorized(); sourceGuard(created); taskGuard(); });
        let response: ServerExecuteResponse;
        try { response = await invoke(runId => bind(id, runId, authorized)); }
        catch (cause) {
          await locked(id, async () => { const value = await requireIntent(id); if (!['armed', 'cancelled', 'awaiting_sync'].includes(value.intent.state)) await save(value, { state: value.dispatch_started ? 'needs_attention' : 'not_sent', detail: value.dispatch_started ? 'The send outcome is uncertain. Check Mail before trying to send again. No reply watch has started.' : 'The send could not be started. No reply watch was started.' }); });
          throw cause;
        }
        await locked(id, async () => {
          let value = await requireIntent(id);
          if (!value.intent.run_id && response.run_id) value = await save(value, { run_id: response.run_id });
          const patch: Partial<MailFollowUpSendIntent> = ['armed', 'cancelled', 'awaiting_sync', 'needs_attention'].includes(value.intent.state) ? {}
            : response.awaiting_approval ? { state: 'awaiting_approval', detail: 'Waiting for your send approval. The reply watch has not started yet.' }
            : { state: value.dispatch_started ? 'needs_attention' : 'not_sent', detail: 'A verified send was not recorded. No reply watch has started. Review the send in History.' };
          await save(value, patch, { response });
        });
        await reconcile(id); authorized(); return responseFor(await requireIntent(id));
      })();
      executions.set(id, { hash, promise: work });
      try { return await work; } finally { if (executions.get(id)?.promise === work) executions.delete(id); }
    },
    async beforeSend(input: Input, scheduled?: ScheduledSend): Promise<{ id: string; cached?: MailSendResult } | undefined> {
      const runId = object(input).run_id;
      if (typeof runId !== 'string' || !runId) return undefined;
      const found = scheduled ? await scheduledIntent(input, runId, scheduled) : await deps.store.byRun(runId); if (!found) return undefined;
      return locked(found.intent.id, async () => {
        const value = await requireIntent(found.intent.id);
        // Cancelling a watch changes only follow-up behavior. Keep the send
        // receipt and dispatch fence intact if the engine replays this run.
        if (value.receipt) return { id: value.intent.id, cached: { ...value.receipt } };
        if (value.dispatch_started) throw new IngredientError('ACTION_DELIVERY_UNCERTAIN', 'This watched send already started. Check its outcome before trying again.');
        if (contentHash(input) !== contentHash(value.content)) {
          if (value.intent.state === 'cancelled') return undefined;
          await save(value, { state: 'needs_attention', detail: 'The email changed during review. This reply watch was not started. You can start one from the sent email.' }); return undefined;
        }
        const guard = () => { if (value.intent.state !== 'cancelled') sourceGuard(value); };
        guard();
        await save(value, value.intent.state === 'cancelled' ? {} : { state: 'awaiting_send', detail: 'Sending through the approved mail path. The reply watch has not started yet.' }, { dispatch_started: true }, guard);
        return { id: value.intent.id };
      });
    },
    async afterSend(id: string, receipt: MailSendResult): Promise<void> {
      await locked(id, async () => {
        const value = await requireIntent(id);
        if (typeof receipt?.source_id !== 'string' || !receipt.source_id || receipt.source_id.length > 4096
          || !Number.isSafeInteger(receipt.sent_at) || receipt.sent_at < value.intent.created_at - 60000 || receipt.sent_at > now() + 60000
          || typeof receipt.message_id !== 'string' || !receipt.message_id || receipt._id !== null && typeof receipt._id !== 'string')
          throw new RpcError('unavailable', 'The send receipt could not be confirmed. Check Mail before trying again.', 409);
        await save(value, value.intent.state === 'cancelled' ? {} : { state: 'awaiting_sync', detail: 'Waiting for the exact email in synced Sent messages. The reply watch has not started yet.' }, { receipt: { ...receipt } });
      });
    },
    async afterConditionalStop(id: string, detail: string): Promise<void> {
      await locked(id, async () => {
        const value = await requireIntent(id);
        if (value.receipt || value.intent.state === 'cancelled' || value.intent.state === 'not_sent') return;
        await save(value, { state: 'not_sent', detail });
      });
    },
    get: (id: unknown) => reconcile(idOf(id)),
    async pending(): Promise<MailFollowUpSendIntent[]> {
      const found: MailFollowUpSendIntent[] = [];
      for (const id of deps.store.activeIds()) { const value = await reconcile(id); if (value && !['armed', 'cancelled'].includes(value.state)) found.push(value); }
      return found;
    },
    async cancel(raw: unknown, authorized: () => void): Promise<MailFollowUpSendIntent> {
      const args = object(raw), id = idOf(args.id);
      return locked(id, async () => {
        const value = await requireIntent(id);
        if (value.intent.state === 'cancelled') return publicCopy(value);
        if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision !== value.intent.revision) throw new RpcError('conflict', 'This pending reply watch changed. Refresh it before cancelling.', 409);
        if (value.intent.state === 'armed') throw new RpcError('conflict', 'This reply watch has started. Open it to cancel the active watch.', 409);
        return publicCopy(await save(value, { state: 'cancelled', detail: 'Reply watch cancelled. This does not cancel or resend the email.' }, {}, authorized));
      });
    },
    async sweep() { if (deps.canRun?.() === false) return; for (const id of deps.store.activeIds()) { if (deps.canRun?.() === false) return; try { await reconcile(id); } catch { /* A locked or concurrently changed request is retried next time. */ } } },
  };
};
export type MailFollowUpSendService = ReturnType<typeof createMailFollowUpSendService>;

/** The native collection rechecks this guard after preparation and immediately
 * before handing the message to the provider. Use the same path in fixtures. */
export const dispatchMailWithReplyWatch = async (
  input: { instance: string },
  followUp: MailFollowUpSendService | undefined,
  dispatch: (guard?: () => void) => Promise<MailSendResult>,
  beforeDispatch?: () => void,
): Promise<MailSendResult> => {
  const io = currentPreapprovalIo();
  const raw = input as Record<string, unknown>;
  const scheduled = io?.scheduledMailFollowUp?.(raw);
  if (scheduled && !followUp) throw new RpcError('not_configured', 'The reviewed scheduled reply watch is unavailable.', 503);
  const watched = await followUp?.beforeSend(input, scheduled);
  if (watched?.cached) return watched.cached;
  const conditional = await io?.prepareMailCondition?.(input.instance, raw);
  const guard = conditional ? () => { beforeDispatch?.(); conditional.assertAllowed(); } : beforeDispatch;
  try {
    const result = await dispatch(guard);
    if (watched) await followUp!.afterSend(watched.id, result);
    return result;
  } catch (error) {
    const detail = conditional?.stoppedMessage();
    if (watched && detail) {
      try { await followUp!.afterConditionalStop(watched.id, detail); }
      catch { /* The approval journal records the refusal independently. */ }
    }
    throw error;
  }
};
