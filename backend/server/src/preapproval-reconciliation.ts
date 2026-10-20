/** Owner-triggered observation of an original attempt. No dispatch or resume path. */
import type Database from 'better-sqlite3';
import { RpcError, normalizeMailSend, mailSentReconciliationQueryFor,
  type PreapprovalReconcileRequest, type PreapprovalReconcileResult,
  type MailSentReconciliationResult } from '@recued/contracts';
import type { PreapprovalRepository } from './storage/preapproval-repository.js';
import type { PreparedFutureExecution, PreparedInvocation, PreapprovalResponder } from './preapproval-model.js';
import type { CollectionRegistry } from './collections/registry.js';
import type { MailCollection } from './collections/mail/mail-collection.js';
import { createMailSendClaimStore } from './storage/mail-send-claim-store.js';
import { preapprovalHash } from './preapproval-invocations.js';
import { preapprovalMailAttemptId, supportsPreapprovalMailProof } from './preapproval-mail-attempt.js';

export const createPreapprovalReconciliation = (deps: {
  db: Database.Database; repository: PreapprovalRepository; registry?: CollectionRegistry;
  validateRead(plan: PreparedFutureExecution, member: PreparedInvocation): void;
  now?: () => number;
}) => {
  const now = deps.now ?? Date.now, active = new Set<string>();
  const claims = createMailSendClaimStore(deps.db);
  return async (request: PreapprovalReconcileRequest, responder: PreapprovalResponder): Promise<PreapprovalReconcileResult> => {
    const target = await deps.repository.reconciliationTarget(request.proposal_id, request.member_id, responder);
    const finish = async (status: PreapprovalReconcileResult['status'], message: string, evidenceId?: string) => {
      target.assertCurrent();
      const inspection = await deps.repository.inspect(request.proposal_id);
      target.assertCurrent();
      return { status, message, checked_at: now(), ...(evidenceId ? { evidence_id: evidenceId } : {}), inspection };
    };
    if (target.evidence) return finish('verified', 'This attempt already has verified outcome evidence.', target.evidence.evidence_id);
    const { member, plan } = target;
    if (member.ingredient_slug !== 'mail-send' || !supportsPreapprovalMailProof(member.input)) {
      return finish('unsupported', 'This operation has no supported provider proof. Its outcome remains uncertain.');
    }
    const marker = preapprovalMailAttemptId(target.claim), payload = normalizeMailSend(member.input);
    const claim = claims.get(marker);
    if (!claim) return finish('unsupported', 'This attempt has no private mail proof. Its outcome remains uncertain.');
    const guard = () => deps.db.transaction(() => {
      target.assertCurrent();deps.validateRead(plan, member);
      if (preapprovalHash(claims.get(marker)) !== preapprovalHash(claim)
        || claim.sender_slug !== payload.instance || claim.recipient !== [...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])][0]
        || claim.subject !== payload.subject) throw new RpcError('preapproval_stale', 'The original mail claim changed while checking.', 409);
    }).immediate();
    guard();
    if (active.size >= 2 || active.has(target.claim.attempt_id)) throw new RpcError('preapproval_limit_exceeded', 'Wait for the current provider check to finish.', 409);
    active.add(target.claim.attempt_id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let providerPending = false, providerRead: Promise<MailSentReconciliationResult> | undefined;
    try {
      let proof: unknown, outcome: 'succeeded' | 'failed';
      if (claim.status === 'not_sent') {
        outcome = 'failed';proof = { kind: 'provider_rejected', revision: claim.revision };
      } else if ((claim.status === 'sent' || claim.status === 'reconciled') && claim.provider_message_id
        && Number.isSafeInteger(claim.sent_at) && claim.sent_at! <= now() && claim.sent_at! >= claim.sent_after) {
        outcome = 'succeeded';proof = { kind: 'provider_acknowledgement', message_id: claim.provider_message_id, sent_at: claim.sent_at };
      } else {
        const collection = deps.registry?.get('mail', payload.instance) as MailCollection | undefined;
        const query = mailSentReconciliationQueryFor(claim, now());
        if (!collection?.lookupSentByReconciliationId || !query) return finish('unavailable', 'Provider evidence is unavailable. The outcome remains uncertain.');
        let result: MailSentReconciliationResult;
        try {
          providerPending = true;
          providerRead = collection.lookupSentByReconciliationId(query).then(value => { providerPending = false;return value; }, error => {
            providerPending = false;throw error;
          });
          result = await Promise.race([providerRead, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Provider check timed out.')), 15_000);timer.unref();
          })]);
        } catch {
          guard();return finish('unavailable', 'The provider check did not finish. The outcome remains uncertain.');
        }
        guard();
        if (result.status !== 'matched') return finish(result.status === 'unavailable' ? 'unavailable' : 'unknown',
          result.status === 'ambiguous' ? 'Provider evidence is ambiguous. The outcome remains uncertain.'
            : 'The provider did not prove that this message was sent. Absence does not prove failure.');
        const match = result.match;
        if (!match || typeof match.provider_message_id !== 'string' || !match.provider_message_id || match.provider_message_id.length > 2048
          || !Number.isSafeInteger(match.sent_at) || match.sent_at < query.sent_after || match.sent_at > query.sent_before
          || match.proof_kind !== query.proof_kind || query.proof_kind === 'attachment' && (match.proof_kind !== 'attachment'
            || match.attachment_sha256 !== query.attachment_sha256 || match.attachment_size_bytes !== query.attachment_size_bytes)) {
          return finish('unavailable', 'Provider evidence does not match the original proof request. The outcome remains uncertain.');
        }
        outcome = 'succeeded';proof = { kind: 'sent_folder_match', match };
      }
      guard();
      const evidence = await deps.repository.recordReconciliation({ ...target.claim, adapter: 'reviewed-mail-v1', outcome,
        evidence_digest: preapprovalHash({ marker, effect_hash: member.effect_hash, account_id: member.account_id,
          connection_id: member.connection_id, proof }), observed_at: now() }, guard);
      return finish('verified', outcome === 'succeeded' ? 'The original mail attempt is verified as sent.'
        : 'The original mail attempt is verified as not sent. Any remaining work needs a fresh review.', evidence.evidence_id);
    } finally {
      if (timer) clearTimeout(timer);
      // The adapter has no cancellation API. A timed-out read keeps its slot
      // until actual IO ends; retries cannot accumulate detached provider work.
      if (providerPending && providerRead) void providerRead.then(() => active.delete(target.claim.attempt_id), () => active.delete(target.claim.attempt_id));
      else active.delete(target.claim.attempt_id);
    }
  };
};
