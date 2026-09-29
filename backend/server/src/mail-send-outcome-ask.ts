/** "Did this email go out?" — the owner's way out of an unresolved send claim.
 *
 *  A send that opted into the no-resend fence (`reconciliation_id`) and never
 *  learned its outcome is refused on every retry: re-sending might duplicate a
 *  message the customer already has. The fence reserves ONE way past that for a
 *  human — "Re-sending is an OWNER decision, made with the claim in front of
 *  them" (`packages/contracts/src/mail.ts`) — and until this, nothing put the
 *  claim in front of anyone. Every retry was refused, with nothing on screen.
 *
 *  So an unresolved claim now raises an ask. It shows in Attention (the bell)
 *  like any approval, and on the owner's other channels:
 *    - "It went out"                    → `confirmed`: a retry returns
 *                                          `already_sent`;
 *    - "It did not — send it next time" → `released`: the next attempt sends.
 *  Neither answer sends anything itself.
 *
 *  ⚠ Raised only for an attempt that has ENDED (`unknown`, `ambiguous`, or a
 *  `claimed` left behind longer than any send can take — a crash). Asking about
 *  a send still in flight would invite "it did not" while the provider is
 *  accepting it.
 */

import type { MailSendClaim } from '@recued/contracts';
import type {
  AskHandlerRef,
  AskOption,
  NotificationMessage,
  PendingAsk,
} from '@recued/notification';
import {
  MailSendClaimConflictError,
  type MailSendClaimStore,
} from './storage/mail-send-claim-store.js';

export const MAIL_SEND_OUTCOME_ASK_KIND = 'mail.send_outcome';

export const MAIL_SEND_OUTCOME_WENT_OUT = 'went_out';
export const MAIL_SEND_OUTCOME_NOT_SENT = 'not_sent';

export const MAIL_SEND_OUTCOME_ASK_OPTIONS: readonly AskOption[] = [
  { id: MAIL_SEND_OUTCOME_WENT_OUT, label: 'It went out' },
  { id: MAIL_SEND_OUTCOME_NOT_SENT, label: 'It did not — send it next time' },
];

/** Longer than any single send can take (nodemailer's socket timeout is ten
 *  minutes). A `claimed` older than this was left behind by an attempt that is
 *  no longer running. */
export const MAIL_SEND_ATTEMPT_MAX_MS = 15 * 60 * 1_000;

/** Is this claim an ended attempt nobody knows the outcome of — the case the
 *  owner is asked about? */
export const mailSendClaimNeedsOwner = (claim: MailSendClaim, now: number): boolean =>
  claim.status === 'unknown'
  || claim.status === 'ambiguous'
  || (claim.status === 'claimed' && now - claim.updated_at > MAIL_SEND_ATTEMPT_MAX_MS);

export const buildMailSendOutcomeAsk = (
  claim: MailSendClaim,
): { message: NotificationMessage; options: readonly AskOption[]; handler: AskHandlerRef } => ({
  message: {
    title: 'Did this email go out?',
    text: claim.status === 'ambiguous'
      ? `Your Sent folder has more than one message that could be “${claim.subject}” to `
        + `${claim.recipient}, so Recued cannot tell which one is it. Recued will not send it `
        + 'again unless you say it did not go out.'
      : `Recued tried to send “${claim.subject}” to ${claim.recipient} and could not tell `
        + 'whether it went out. Check your Sent folder. Recued will not send it again unless '
        + 'you say it did not go out.',
  },
  options: MAIL_SEND_OUTCOME_ASK_OPTIONS,
  handler: {
    kind: MAIL_SEND_OUTCOME_ASK_KIND,
    payload: { reconciliation_id: claim.reconciliation_id, revision: claim.revision },
  },
});

/** The narrow notification-block surface raising needs. */
export interface MailSendOutcomeNotifier {
  ask(
    message: NotificationMessage,
    options: readonly AskOption[],
    handler: AskHandlerRef,
  ): Promise<{ ask_id: string }>;
  listUnresolvedAsks(): Promise<PendingAsk[]>;
}

const isNotifier = (value: unknown): value is MailSendOutcomeNotifier =>
  value !== null
  && typeof value === 'object'
  && typeof (value as { ask?: unknown }).ask === 'function'
  && typeof (value as { listUnresolvedAsks?: unknown }).listUnresolvedAsks === 'function';

/** Ask the owner about this claim, once. Best-effort: the refusal the caller is
 *  about to throw stands whether or not the ask could be raised.
 *
 *  Returns whether an ask for it is open now (raised here or earlier). */
export const raiseMailSendOutcomeAsk = async (input: {
  notifier: unknown;
  claims: MailSendClaimStore;
  reconciliation_id: string;
  now: number;
}): Promise<boolean> => {
  if (!isNotifier(input.notifier)) return false;
  const claim = input.claims.get(input.reconciliation_id);
  if (claim === null || !mailSendClaimNeedsOwner(claim, input.now)) return false;
  const unresolved = await input.notifier.listUnresolvedAsks();
  const already = unresolved.some((ask) =>
    ask.handler_kind === MAIL_SEND_OUTCOME_ASK_KIND
    && ask.handler_payload.reconciliation_id === claim.reconciliation_id);
  if (already) return true;
  const { message, options, handler } = buildMailSendOutcomeAsk(claim);
  await input.notifier.ask(message, options, handler);
  return true;
};

/** The owner's answer, applied to the claim it was asked about. A claim that has
 *  moved since (the provider proved it, another answer landed) is left alone. */
export const registerMailSendOutcomeHandler = (
  block: { registerAskHandler(kind: string, handler: (payload: Record<string, unknown>, answer: { option: string; answered_at: number }) => void | Promise<void>): void },
  claims: () => MailSendClaimStore,
): void => {
  block.registerAskHandler(MAIL_SEND_OUTCOME_ASK_KIND, (payload, answer) => {
    const reconciliation_id = payload.reconciliation_id;
    const revision = payload.revision;
    if (typeof reconciliation_id !== 'string' || typeof revision !== 'number') return;
    if (answer.option !== MAIL_SEND_OUTCOME_WENT_OUT && answer.option !== MAIL_SEND_OUTCOME_NOT_SENT) {
      return;
    }
    try {
      claims().decideByOwner({
        reconciliation_id,
        expected_revision: revision,
        went_out: answer.option === MAIL_SEND_OUTCOME_WENT_OUT,
        now: answer.answered_at,
      });
    } catch (err) {
      // Moved on since the ask: a newer fact already decided it.
      if (err instanceof MailSendClaimConflictError) return;
      throw err;
    }
  });
};
