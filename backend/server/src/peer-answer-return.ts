/** D-234 § 234.4 — THE RETURN LEG. The half that closes the loop.
 *
 *  Two functions, one per side of the wire:
 *
 *    sendPeerAnswerHome  — b's owner answered; carry it back to a.
 *    receiveAnswer       — a's door: is this ours, and does it resume?
 *
 *  🔑🔑 THE ASYMMETRY IS THE DESIGN. Going out, the gate is EXPOSURE — a standing
 *  "you may put questions to me", decided in advance by the receiver. Coming
 *  back, the gate is CORRELATION — we must have asked THIS ref, through a
 *  connection bound to THIS caller. Neither implies the other, which is why they
 *  are separate ops with separate grants: a peer we never exposed to can still
 *  answer a question we sent them, and a peer we exposed to cannot push an answer
 *  to a question nobody asked.
 *
 *  ⛔ AND THE REPLY IS DATA, NEVER AUTHORITY. § 234.2 settled this: the ref is a
 *  lookup key, not a credential. Holding a ref lets a peer address a conversation
 *  — it does not let them choose its outcome, because `parsePeerAnswer` refuses
 *  any option outside the set WE offered, read back off our own outbox row.
 */
import {
  parsePeerAnswer,
  type PeerAnswer,
} from '@recued/contracts';

import type { PeerAskOutboxStore } from './storage/peer-ask-outbox-store.js';
import type { PeerAnswerStore } from './storage/peer-answer-store.js';

/** The wire shape the answering server presents at the asker's door. */
export interface InboundPeerAnswer {
  /** Host-derived, NEVER from the payload — the contract the caller presented. */
  readonly peer_contract_id: string;
  readonly exchange_ref: string;
  /** The rest is the peer's own words, validated against our offered set. */
  readonly raw: unknown;
}

/** ⛔⛔ FOUR REFUSALS, AND THEY ARE NOT ONE. § 30's lesson applied to the return
 *  leg: a caller that cannot tell "you never asked me this" from "that is not one
 *  of the options" from "someone else's conversation" cannot behave sensibly, and
 *  a single `bad_request` would make all three look like a bug in their code. */
export const PEER_ANSWER_REFUSALS = [
  /** No open conversation under that ref — we never asked, or it already closed. */
  'not_solicited',
  /** The ref is ours, but this caller is not who we asked. */
  'wrong_peer',
  /** Shape refused: not an answer, or an option we never offered. */
  'unreadable',
  /** We asked, they answered, and an answer is already recorded. First wins. */
  'already_answered',
] as const;
export type PeerAnswerRefusal = (typeof PEER_ANSWER_REFUSALS)[number];

export type PeerAnswerInboundResult =
  | { readonly accepted: true; readonly resumed: boolean }
  | { readonly accepted: false; readonly refusal: PeerAnswerRefusal; readonly reason: string };

export interface PeerAnswerInboundDeps {
  readonly outbox: Pick<PeerAskOutboxStore, 'get' | 'close'>;
  readonly answers: Pick<PeerAnswerStore, 'record'>;
  /** Resolve which peer contract a connection name is bound to. The answer must
   *  arrive from the contract we ADDRESSED, not merely from a known peer. */
  readonly contractForConnection: (connection: string) => string | undefined;
  /** Re-instantiate the held run past its peer gate. Best-effort: the answer is
   *  durable once recorded, so a failed resume is recoverable by re-resuming,
   *  where a refused answer would strand the conversation. */
  readonly resume: (row: { run_id: string; gated_step_id: string }) => Promise<void>;
  readonly logActivity?: (row: {
    action: string; target: string; detail: string;
  }) => void;
  readonly now?: () => number;
}

/** a's door. Validate, record, close, resume. */
export const receiveAnswer = async (
  input: InboundPeerAnswer,
  deps: PeerAnswerInboundDeps,
): Promise<PeerAnswerInboundResult> => {
  const now = deps.now ?? Date.now;
  const open = deps.outbox.get(input.exchange_ref);
  if (open === null) {
    // ⚠ THE SAME CODE FOR "NEVER ASKED" AND "ALREADY CLOSED", deliberately. The
    // two are one fact from the caller's side — there is no open conversation —
    // and distinguishing them would tell an unknown caller whether a ref they
    // guessed was ever real.
    return {
      accepted: false,
      refusal: 'not_solicited',
      reason: 'no open conversation under that reference on this server',
    };
  }

  // ⛔ THE CONNECTION IS THE AUTHENTICATION. We asked THROUGH a named connection;
  // only the contract that connection is bound to may answer. Matching on "is a
  // known peer" instead would let any enrolled peer answer any other peer's
  // question — the ref is a lookup key, and a key anyone may present is not one.
  const expected = deps.contractForConnection(open.connection);
  if (expected === undefined || expected === '' || expected !== input.peer_contract_id) {
    return {
      accepted: false,
      refusal: 'wrong_peer',
      reason: 'that conversation was not addressed to you',
    };
  }

  // ⛔ VALIDATED AGAINST OUR OWN OFFERED SET, read off the row we wrote when the
  // question went out. This is the line that stops a peer choosing an outcome we
  // never put in front of their owner.
  const answer = parsePeerAnswer(input.raw, open.offered, now());
  if (answer === undefined) {
    return {
      accepted: false,
      refusal: 'unreadable',
      reason: 'not a readable answer, or an option that was never offered',
    };
  }

  console.warn(`[peer-answer] parsed note=${JSON.stringify(answer.note ?? null)}`);
  // First write wins — a duplicate delivery is not a second answer.
  const recorded = deps.answers.record({
    exchange_ref: input.exchange_ref,
    peer_contract_id: input.peer_contract_id,
    answered: answer.answered,
    ...(answer.option !== undefined ? { option: answer.option } : {}),
    ...(answer.note !== undefined ? { note: answer.note } : {}),
    ...(answer.unanswered_because !== undefined
      ? { unanswered_because: answer.unanswered_because }
      : {}),
    at: answer.at,
  });
  if (!recorded) {
    return {
      accepted: false,
      refusal: 'already_answered',
      reason: 'this conversation already has an answer',
    };
  }

  deps.logActivity?.({
    action: 'peer_ask_answered',
    target: `${input.peer_contract_id}/${open.label}`,
    detail: JSON.stringify({
      exchange_ref: input.exchange_ref,
      answered: answer.answered,
      ...(answer.option !== undefined ? { option: answer.option } : {}),
      ...(answer.unanswered_because !== undefined
        ? { unanswered_because: answer.unanswered_because }
        : {}),
    }),
  });

  // ⚠ CLOSE BEFORE RESUME. The resumed step re-runs the op, which reads the
  // recorded answer — it does not need the outbox row, and leaving one open
  // across a resume would advertise a conversation that is over.
  deps.outbox.close(input.exchange_ref);

  let resumed = false;
  try {
    await deps.resume({ run_id: open.run_id, gated_step_id: open.gated_step_id });
    resumed = true;
  } catch (e) {
    // ⛔ THE ANSWER STANDS EITHER WAY. It is recorded and durable; the held run
    // finds it whenever it next resumes. Refusing the peer here would tell them
    // their answer was rejected when we have in fact kept it, and they would
    // reasonably send it again.
    console.warn(
      `[peer-answer] recorded but resume failed for ref '${input.exchange_ref}': `
      + (e instanceof Error ? (e.stack ?? e.message) : String(e))
      + ' — the answer IS recorded; the held run finds it on its next resume.',
    );
  }
  return { accepted: true, resumed };
};

// ════════════════════════════════════════════════════════════════
// b's side — carry the owner's answer home
// ════════════════════════════════════════════════════════════════

export interface SendPeerAnswerHomeDeps {
  /** Resolve the connection that reaches the peer who asked. */
  readonly connectionForContract: (peer_contract_id: string) => string | undefined;
  /** Dispatch `recued_peerAnswer` on that connection. */
  readonly call: (connection: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly logActivity?: (row: {
    action: string; target: string; detail: string;
  }) => void;
  readonly now?: () => number;
}

/** b's `peer.ask` answer handler body: the owner chose an option; send it back.
 *
 *  ⚠ THE HANDLER RUNS FROM A DURABLE ASK, so it must be reconstructible from the
 *  persisted payload alone — `{ peer_contract_id, exchange_ref, label }` and
 *  nothing else. The ask id is a bearer capability that travels through Slack;
 *  anything richer in that payload becomes readable by whoever holds the link.
 *  That is why the question text is not here and is not needed: the ANSWER is
 *  the whole outbound content. */
/** Register the `peer.ask` answer handler — the seam that turns b's owner
 *  tapping an option into an answer travelling home.
 *
 *  ⛔⛔ WITHOUT THIS REGISTRATION THE WHOLE RETURN LEG IS UNREACHABLE, and it
 *  fails in the quietest possible way: `receivePeerAsk` attaches
 *  `handler.kind = 'peer.ask'` to a durable ask whether or not anything is
 *  registered under that kind, so the question still arrives, the owner still
 *  answers, and the answer dispatches to nothing. That is exactly the state
 *  D-234 shipped in and nobody noticed for two sessions — the half-loop. Any
 *  future ask kind added here has the same failure mode. */
export const registerPeerAnswerHandler = (
  notifier: {
    registerAskHandler(
      kind: string,
      fn: (
      payload: Record<string, unknown>,
      answer: { option: string; answered_at: number; note?: string },
    ) => unknown,
    ): void;
  },
  handlerKind: string,
  deps: SendPeerAnswerHomeDeps,
): void => {
  notifier.registerAskHandler(handlerKind, async (payload, answer) => {
    const peer_contract_id = payload.peer_contract_id;
    const exchange_ref = payload.exchange_ref;
    const label = payload.label;
    if (
      typeof peer_contract_id !== 'string' || peer_contract_id === ''
      || typeof exchange_ref !== 'string' || exchange_ref === ''
    ) {
      // ⚠ THROW, not swallow. A malformed payload means the ask row and this
      // handler disagree about the correlation — the owner's answer exists and
      // must not be dropped silently; the block leaves the ask `answered` and
      // the boot sweep retries.
      throw new Error(
        'peer answer handler: malformed payload — expected '
        + '{ peer_contract_id: string, exchange_ref: string, label?: string }',
      );
    }
    await sendPeerAnswerHome(
      { peer_contract_id, exchange_ref, label: typeof label === 'string' ? label : '' },
      answer,
      deps,
    );
  });
};

export const sendPeerAnswerHome = async (
  payload: { peer_contract_id: string; exchange_ref: string; label: string },
  answer: { option: string; answered_at: number; note?: string },
  deps: SendPeerAnswerHomeDeps,
): Promise<void> => {
  const now = deps.now ?? Date.now;
  const connection = deps.connectionForContract(payload.peer_contract_id);
  if (connection === undefined) {
    // ⚠ THROW, so the notification block leaves the ask `answered` and the boot
    // sweep re-dispatches. The owner HAS answered; losing it because the
    // connection was momentarily unresolvable would make their decision vanish.
    throw new Error(
      `[peer-answer] no connection reaches peer contract '${payload.peer_contract_id}' — `
      + `cannot return the answer for ref '${payload.exchange_ref}'`,
    );
  }
  // ⚠ KEEP THIS PAIR. The return leg shipped UNREGISTERED and therefore silent
  // for two sessions — the ask carried `handler.kind` whether or not anything
  // listened, so an owner could answer and the answer dispatched into nothing.
  // These two lines separate "never sent" from "sent and refused", which is the
  // distinction that took a probe to recover. Same rule the `[peer-ask]` lines
  // earned: report the ACTOR and the outcome, not just a state.
  console.warn(`[peer-answer] sending home via '${connection}' ref=${payload.exchange_ref}`);
  let said = '';
  try {
    const r = await deps.call(connection, {
      exchange_ref: payload.exchange_ref,
      answered: true,
      option: answer.option,
      at: answer.answered_at,
      // D-234 § 234.4e — the REASON travels with the decision. Without this line
      // the whole note path is a field that gets collected and thrown away one
      // hop before the person who asked for it.
      ...(answer.note !== undefined ? { note: answer.note } : {}),
    });
    said = JSON.stringify(r ?? null);
    console.warn(`[peer-answer] sent ${said.slice(0, 300)}`);
  } catch (e) {
    console.warn(`[peer-answer] SEND FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    throw e;
  }
  // ⛔⛔ A REFUSAL IS A RESULT, NOT AN ERROR ENVELOPE — and until this block the
  // owner's decision could be refused at the far door and filed here as
  // delivered. `receiveAnswer` answers `{accepted:false, refusal}` for four
  // distinct reasons and returns it as ORDINARY CONTENT, deliberately (*"a peer
  // whose answer was refused must be able to tell WHY machine-readably; an
  // error envelope makes 'not yours' and 'the server fell over' the same
  // fact"*). Nothing here read it, so a `try` that did not throw was treated as
  // arrival — the same defect the § 234.4n withdrawal notice already found and
  // fixed one file over, on this same wire, in this same arc.
  //
  // 🔑 ASSERT THE POSITIVE. Enumerating the refusals is how you miss the next
  // one: anything that is not an explicit acceptance is a non-delivery here.
  //
  // ⛔ AND THE TWO OUTCOMES BELOW ARE NOT ONE. Throwing leaves the ask
  // `answered` so the boot sweep re-dispatches — right for something that may
  // succeed later, wrong for a refusal that never will. `not_solicited` (the
  // asker's deadline already closed the conversation) and `wrong_peer` /
  // `unreadable` cannot be fixed by sending again; re-dispatching them forever
  // would replace a lost decision with an unbounded loop. So they are recorded
  // as what they are and the ask completes — the trail is where the owner's
  // decision survives, since the run it was for is already gone.
  const accepted = said.includes('"accepted":true');
  const alreadyHome = said.includes('"already_answered"');
  const permanent = alreadyHome
    || said.includes('"not_solicited"')
    || said.includes('"wrong_peer"')
    || said.includes('"unreadable"');
  if (!accepted && !permanent) {
    // Neither an acceptance nor a refusal we recognise — an unknown shape, a
    // tool error, a door that has changed. Treat it as undelivered so the boot
    // sweep tries again; the alternative is counting an unread answer as sent.
    throw new Error(
      `[peer-answer] the peer did not accept the answer for ref '${payload.exchange_ref}' — ${said.slice(0, 200)}`,
    );
  }
  deps.logActivity?.({
    // ⚠ `already_answered` IS delivery: our answer is home, whether this
    // attempt or an earlier one put it there. Only the genuine refusals get the
    // other action name, so a reader counting `peer_ask_answered` is counting
    // decisions that landed.
    action: accepted || alreadyHome ? 'peer_ask_answered' : 'peer_ask_answer_refused',
    target: `${payload.peer_contract_id}/${payload.label}`,
    detail: JSON.stringify({
      exchange_ref: payload.exchange_ref,
      option: answer.option,
      returned_at: now(),
      ...(accepted || alreadyHome ? {} : { refusal: said.slice(0, 300) }),
    }),
  });
  if (!accepted && !alreadyHome) {
    console.warn(
      `[peer-answer] THE OWNER'S DECISION WAS REFUSED and cannot be re-sent — ref=`
      + `${payload.exchange_ref} ${said.slice(0, 200)}`,
    );
  }
};
