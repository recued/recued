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
import { createHash } from 'node:crypto';

import {
  mintAskId,
  type AskHandlerRef,
  type AskOption,
  type NotificationMessage,
} from '@recued/notification';

import {
  admitPeerAsk,
  peerAskLedgerTarget,
  type InboundPeerAsk,
} from './peer-ask-receiver.js';
import type { PeerAskInboxStore } from './storage/peer-ask-inbox-store.js';

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
      extras?: {
        note_prompt?: 'optional' | 'required';
        body?: string;
        reserved_ask_id?: string;
        on_persisted?: (ask_id: string) => void | Promise<void>;
      },
    ): Promise<{ ask_id: string }>;
  };
  /** Durable receiver-side idempotency anchor. Required: without it a lost
   * accepted response can turn a sender retry into a second owner decision. */
  readonly inbox: PeerAskInboxStore;
  readonly mintAskId?: () => string;
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

export const peerAskRequestFingerprint = (input: InboundPeerAsk): string =>
  createHash('sha256').update(JSON.stringify([
    input.peer_contract_id,
    input.exchange_ref,
    input.label,
    input.question,
    input.options.map((option) => [option.id, option.label]),
    input.deadline_at ?? null,
    input.on_timeout ?? null,
    input.note_prompt ?? null,
    input.body ?? null,
  ])).digest('hex');

export const receivePeerAsk = async (
  input: InboundPeerAsk,
  deps: PeerAskInboundDeps,
): Promise<PeerAskInboundResult> => {
  const target = peerAskLedgerTarget(input.peer_contract_id, input.label);
  const fingerprint = peerAskRequestFingerprint(input);
  const prior = deps.inbox.get(input.peer_contract_id, input.exchange_ref);
  if (prior !== null && prior.request_fingerprint !== fingerprint) {
    deps.logActivity?.({
      action: 'peer_ask_refused',
      target,
      detail: JSON.stringify({
        exchange_ref: input.exchange_ref,
        refusal: 'exchange_conflict',
        reason: 'that peer exchange reference is already bound to another question',
      }),
    });
    return {
      accepted: false,
      refusal: 'exchange_conflict',
      reason: 'that peer exchange reference is already bound to another question',
    };
  }
  if (prior?.state === 'raised') {
    return { accepted: true, ask_id: prior.ask_id };
  }

  // A reservation proves this exact request was admitted previously. Finish
  // that attempt under its original decision even if the live label grant was
  // revoked after the peer sent it; re-evaluating would strand a durable ask
  // behind a refusal response. A new exchange still uses the current grant.
  const verdict = prior === null
    ? admitPeerAsk(input, deps.isLabelGranted)
    : admitPeerAsk({ ...input, connection_name: prior.connection_name }, () => true);

  if (!verdict.admitted) {
    // Admission and first-write reservation are intentionally separate: the
    // grant can be revoked between them in one process while another process
    // has already durably admitted this exact request. Join that winner instead
    // of returning a refusal beside an accepted exchange. Inbox rows are never
    // deleted, so the recursive read is bounded to the prior-present branch.
    const raced = deps.inbox.get(input.peer_contract_id, input.exchange_ref);
    if (raced !== null) return receivePeerAsk(input, deps);
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

  const reservation = prior === null
    ? deps.inbox.reserve({
        peer_contract_id: input.peer_contract_id,
        exchange_ref: input.exchange_ref,
        request_fingerprint: fingerprint,
        connection_name: input.connection_name,
        ask_id: (deps.mintAskId ?? mintAskId)(),
        created_at: Date.now(),
      })
    : { kind: 'existing' as const, row: prior };
  if (reservation.kind === 'conflict') {
    return {
      accepted: false,
      refusal: 'exchange_conflict',
      reason: 'that peer exchange reference is already bound to another question',
    };
  }
  if (reservation.row.state === 'raised') {
    return { accepted: true, ask_id: reservation.row.ask_id };
  }

  // Another process may have won the first-write reservation after our `get`
  // observed no row. The fingerprint deliberately excludes this server-local
  // presentation name, so render from the winning reservation rather than the
  // stale name used for our initial admission check. The request shape was
  // already validated above; the always-true grant finishes that exact admitted
  // request under its durable first-write-wins identity.
  const durableVerdict = admitPeerAsk(
    { ...input, connection_name: reservation.row.connection_name },
    () => true,
  );
  if (!durableVerdict.admitted) {
    throw new Error('durably reserved peer ask no longer passes shape validation');
  }

  // ⛔ RAISE FIRST, LEDGER SECOND. If the raise throws, nothing reached the owner
  // and the caller must be told so — writing `peer_ask_received` before the ask
  // exists would record a question nobody was ever shown.
  let markedByPersistenceHook: ReturnType<PeerAskInboxStore['markRaised']> | undefined;
  const { ask_id } = await deps.notifier.ask(
    durableVerdict.message,
    durableVerdict.options,
    durableVerdict.handler,
    // ⚠ `channels` stays default; the extras ride in one object so a future
    // field cannot be lost to positional drift.
    undefined,
    {
      ...(durableVerdict.note_prompt !== undefined
        ? { note_prompt: durableVerdict.note_prompt }
        : {}),
      ...(durableVerdict.body !== undefined ? { body: durableVerdict.body } : {}),
      reserved_ask_id: reservation.row.ask_id,
      on_persisted: async (persistedAskId) => {
        markedByPersistenceHook = deps.inbox.markRaised(
          input.peer_contract_id,
          input.exchange_ref,
          persistedAskId,
        );
        if (markedByPersistenceHook === 'mismatch') {
          throw new Error('peer ask inbox reservation changed before channel delivery');
        }
      },
    },
  );
  if (ask_id !== reservation.row.ask_id) {
    throw new Error('peer ask notifier did not preserve its reserved ask id');
  }
  // Compatibility for notifier test doubles and older embeds that implement
  // the ask surface but do not run the hook. Production's block reaches this
  // state before fan-out.
  const marked = markedByPersistenceHook ?? deps.inbox.markRaised(
      input.peer_contract_id,
      input.exchange_ref,
      ask_id,
    );
  if (marked === 'mismatch') {
    throw new Error('peer ask inbox reservation changed before it was marked raised');
  }

  // ⚠ SWALLOWED, BECAUSE THE ASK IS ALREADY DURABLE. The comment on
  // `logActivity` says a ledger failure must not change the answer to the peer,
  // and the first cut let it throw anyway — so an admitted, RAISED question came
  // back to the asker as an error, and they would have asked again while their
  // owner already had it on screen. A test asserting the throw would have written
  // that bug down as the contract.
  try {
    if (marked !== 'marked') return { accepted: true, ask_id };
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
