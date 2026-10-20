/** Host-owned message markers. Public mail input cannot claim this namespace. */
import type { PreapprovalMemberClaim } from './preapproval-model.js';
import { preapprovalHash } from './preapproval-invocations.js';
import { normalizeMailSend } from '@recued/contracts';

export const PREAPPROVAL_MAIL_PREFIX = 'recued-pa-';
export const preapprovalMailAttemptId = (claim: Pick<PreapprovalMemberClaim,
  'future_execution_ref' | 'member_id' | 'attempt_id' | 'action_ref'>): string =>
  PREAPPROVAL_MAIL_PREFIX + preapprovalHash(['reviewed-mail-v1', claim.future_execution_ref,
    claim.member_id, claim.attempt_id, claim.action_ref]).slice('sha256:'.length);

export const supportsPreapprovalMailProof = (input: Record<string, unknown>): boolean => {
  try {
    const payload = normalizeMailSend(input);
    const recipients = [...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])];
    // The existing durable claim has narrower envelope bounds than ordinary
    // sends. Unsupported proof must not turn a valid send into a new failure.
    return payload.reconciliation_id === undefined && payload.instance.length <= 128
      && recipients.length === 1 && recipients[0]!.length > 0 && recipients[0]!.length <= 320
      && payload.subject.length > 0 && payload.subject.length <= 998
      && (payload.attachments?.length ?? 0) <= 1;
  } catch { return false; } // Retained legacy rows cannot advertise new proof support.
};
