/** D-234 § 234.4 — THE INBOUND DOOR, composed.
 *
 *  `admitPeerAsk` decides; this does the three things that follow from the
 *  decision — raise the durable ask, write the ledger row, answer the caller —
 *  and nothing else. It runs no recipe, reads no data, and has no other effect.
 *
 *  ⛔⛔ THE CALLER'S IDENTITY COMES FROM THE TRANSPORT, NEVER THE PAYLOAD. A peer
 *  naming its own `peer_contract_id` in the arguments would be naming its own
 *  authorization, and the exposure check would be asking the attacker whether the
 *  attacker is allowed in. The host resolves it from the presented contract and
 *  passes it here; the payload's own value, if any, is ignored.
 *
 *  ⚠ THE LEDGER ROW IS WRITTEN FOR A REFUSAL TOO, and that is the row that
 *  matters most. "Someone tried to reach me and was turned away" is where an
 *  investigation starts, and it is exactly the row an attacker would prefer went
 *  unrecorded.
 */
import type { AskHandlerRef, AskOption, NotificationMessage } from '@recued/notification';

import {
  admitPeerAsk,
  peerAskLedgerTarget,
  type InboundPeerAsk,
} from './peer-ask-receiver.js';

export interface PeerAskInboundDeps {
  /** D-234 § 234.4j — the ONLY gate: `peer.label.<label>` granted on the peer's
   *  contract. See `admitPeerAsk` for why the old `peer_exposure` store went. */
  readonly isLabelGranted: (peer_contract_id: string, label: string) => boolean;
  readonly notifier: {
    ask(
      message: NotificationMessage,
      options: readonly AskOption[],
      handler: AskHandlerRef,
      channels?: unknown,
      extras?: { note_prompt?: 'optional' | 'required'; body?: string },
    ): Promise<{ ask_id: string }>;
  };
  /** Best-effort ledger. ⚠ A failure here must NOT change the answer to the
   *  peer: the ask is already durable, and re-refusing an admitted question
   *  because bookkeeping failed would be worse than an incomplete ledger. */
  readonly logActivity?: (row: {
    action: string; target: string; detail: string;
  }) => void;
}

export type PeerAskInboundResult =
  | { readonly accepted: true; readonly ask_id: string }
  | { readonly accepted: false; readonly refusal: string; readonly reason: string };

export const receivePeerAsk = async (
  input: InboundPeerAsk,
  deps: PeerAskInboundDeps,
): Promise<PeerAskInboundResult> => {
  const target = peerAskLedgerTarget(input.peer_contract_id, input.label);
  const verdict = admitPeerAsk(input, deps.isLabelGranted);

  if (!verdict.admitted) {
    deps.logActivity?.({
      action: 'peer_ask_refused',
      target,
      detail: JSON.stringify({
        exchange_ref: input.exchange_ref,
        refusal: verdict.refusal,
        reason: verdict.reason,
      }),
    });
    return { accepted: false, refusal: verdict.refusal, reason: verdict.reason };
  }

  // ⛔ RAISE FIRST, LEDGER SECOND. If the raise throws, nothing reached the owner
  // and the caller must be told so — writing `peer_ask_received` before the ask
  // exists would record a question nobody was ever shown.
  const { ask_id } = await deps.notifier.ask(
    verdict.message,
    verdict.options,
    verdict.handler,
    // ⚠ `channels` stays default; the extras ride in one object so a future
    // field cannot be lost to positional drift.
    undefined,
    {
      ...(verdict.note_prompt !== undefined
        ? { note_prompt: verdict.note_prompt }
        : {}),
      ...(verdict.body !== undefined ? { body: verdict.body } : {}),
    },
  );

  // ⚠ SWALLOWED, BECAUSE THE ASK IS ALREADY DURABLE. The comment on
  // `logActivity` says a ledger failure must not change the answer to the peer,
  // and the first cut let it throw anyway — so an admitted, RAISED question came
  // back to the asker as an error, and they would have asked again while their
  // owner already had it on screen. A test asserting the throw would have written
  // that bug down as the contract.
  try {
    deps.logActivity?.({
    action: 'peer_ask_received',
    target,
    detail: JSON.stringify({
      exchange_ref: input.exchange_ref,
      ask_id,
      question: input.question,
      options: input.options.map((o) => o.id),
      ...(input.deadline_at !== undefined ? { deadline_at: input.deadline_at } : {}),
    }),
    });
  } catch (e) {
    console.warn(
      `[peer-ask] ledger write failed for ${target}: `
      + (e instanceof Error ? e.message : String(e)),
    );
  }

  return { accepted: true, ask_id };
};
