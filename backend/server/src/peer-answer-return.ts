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
  isGatedActionTerminal,
  parsePeerAnswer,
  type GatedActionStatus,
  type PeerAnswer,
} from '@recued/contracts';

import type {
  PeerAskOutboxRow,
  PeerAskOutboxStore,
} from './storage/peer-ask-outbox-store.js';
import type {
  PeerAnswerRecord,
  PeerAnswerStore,
} from './storage/peer-answer-store.js';
import { isPeerHoldAbandonmentClaim } from './peer-hold-abandoner.js';

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

/** Structurally classify a far door's reply to `sendPeerAnswerHome`.
 *
 *  ⛔ TERMINAL IS DERIVED FROM {@link PEER_ANSWER_REFUSALS}, not a second list. A
 *  hand-written copy is how a new refusal ends up retried forever (or, worse, a
 *  removed one silently keeps matching) — and both halves would still look right
 *  in review. One source, read through `isPeerAnswerRefusal`.
 *
 *  ⚠ AN UNRECOGNISED REPLY IS NOT TERMINAL. An unknown shape, a tool error or a
 *  door that has changed may succeed later, and the alternative — counting an
 *  unread answer as sent — loses a decision the owner actually made. This
 *  preserves the behaviour the substring version intended; only the reading
 *  changed. */
export const isPeerAnswerRefusal = (v: unknown): v is PeerAnswerRefusal =>
  typeof v === 'string' && (PEER_ANSWER_REFUSALS as readonly string[]).includes(v);

export type PeerAnswerVerdict =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'refused'; readonly refusal: PeerAnswerRefusal }
  | { readonly kind: 'unrecognised' };

export const readPeerAnswerVerdict = (reply: unknown): PeerAnswerVerdict => {
  if (typeof reply !== 'object' || reply === null) return { kind: 'unrecognised' };
  const r = reply as { accepted?: unknown; refusal?: unknown };
  // ⛔ `accepted === true` EXACTLY. A truthy check would read a `reason` string
  // or a `1` as acceptance, which is the same class of leniency this fix removes.
  if (r.accepted === true) return { kind: 'accepted' };
  if (r.accepted === false && isPeerAnswerRefusal(r.refusal)) {
    return { kind: 'refused', refusal: r.refusal };
  }
  return { kind: 'unrecognised' };
};

export type PeerAnswerInboundResult =
  | { readonly accepted: true; readonly resumed: boolean }
  | { readonly accepted: false; readonly refusal: PeerAnswerRefusal; readonly reason: string };

export interface PeerAnswerInboundDeps {
  readonly outbox: Pick<PeerAskOutboxStore, 'get' | 'close'>;
  readonly answers: Pick<PeerAnswerStore, 'record' | 'get'>;
  /** Resolve which peer contract a connection name is bound to. The answer must
   *  arrive from the contract we ADDRESSED, not merely from a known peer. */
  readonly contractForConnection: (connection: string) => string | undefined;
  /** Re-instantiate the held run past its peer gate. Best-effort: the answer is
   *  durable once recorded, so a failed resume is recoverable by re-resuming,
   *  where a refused answer would strand the conversation. */
  readonly resume: (row: {
    run_id: string;
    gated_step_id: string;
    exchange_ref: string;
  }) => Promise<void>;
  readonly gatedActions?: PeerAnswerContinuationDeps['gatedActions'];
  readonly logActivity?: (row: {
    action: string; target: string; detail: string;
  }) => void;
  readonly now?: () => number;
}

/** The narrow receipt seam used by authenticated-answer reconciliation. The
 * store owns all state/exchange checks; callers can only present the outbox's
 * host-derived subject and exchange reference. */
export interface PeerAnswerContinuationDeps {
  readonly outbox: Pick<PeerAskOutboxStore, 'get' | 'close'>;
  readonly resume: (row: {
    run_id: string;
    gated_step_id: string;
    exchange_ref: string;
  }) => Promise<void>;
  readonly gatedActions?: {
    get(action_ref: string): Promise<{
      action_ref: string;
      run_id: string;
      gated_step_id: string;
      current_checkpoint_id: string;
    } | null>;
    confirmPeerHandoff(action_ref: string, input: {
      run_id: string;
      gated_step_id: string;
      exchange_ref: string;
      status_message?: string;
    }): Promise<{
      status: GatedActionStatus;
      handoff?: { kind: string; ref: string };
    } | null>;
  };
}

/** One process-local flight per durable exchange. This is not authority—the
 * answer row and exact awaiting-peer anchor are—but it prevents the inbound
 * request and periodic recovery tick from concurrently re-instantiating the
 * same checkpoint. */
const peerAnswerContinuationFlights = new Map<string, Promise<boolean>>();

/** Reconcile the owner receipt, resume the exact held step, then close live
 * conversation state. The outbox row remains present until every retryable
 * side effect succeeds, so a crash or thrown resume has an enumerable recovery
 * source on the next tick/boot. */
export const continueRecordedPeerAnswer = (
  row: PeerAskOutboxRow,
  deps: PeerAnswerContinuationDeps,
): Promise<boolean> => {
  const existing = peerAnswerContinuationFlights.get(row.exchange_ref);
  if (existing !== undefined) return existing;
  const flight = (async (): Promise<boolean> => {
    if (deps.gatedActions !== undefined && row.action_ref !== undefined) {
      const action = await deps.gatedActions.get(row.action_ref);
      // Legacy/expired receipts do not make the recipe checkpoint unusable.
      // When one remains, however, authenticated arrival is the evidence that
      // resolves a delivery-uncertain peer handoff before the recipe moves.
      if (action !== null) {
        // The outbox journal is the authority for WHICH approved operation this
        // answer belongs to. Looking up the latest receipt by run/step can select
        // a later foreach segment, while a legacy row with no action_ref must not
        // borrow any receipt merely because its subject happens to match.
        if (row.checkpoint_id === undefined
          || action.action_ref !== row.action_ref
          || action.run_id !== row.run_id
          || action.gated_step_id !== row.gated_step_id
          || action.current_checkpoint_id !== row.checkpoint_id) {
          throw new Error('peer answer journal no longer owns its gated action receipt');
        }
        const confirmed = await deps.gatedActions.confirmPeerHandoff(row.action_ref, {
          run_id: row.run_id,
          gated_step_id: row.gated_step_id,
          exchange_ref: row.exchange_ref,
          status_message: 'The peer received the question and returned an authenticated answer.',
        });
        // Receipt terminality and peer-answer continuation are separate facts.
        // A still-dispatching receipt is normally confirmed here; if boot
        // already froze it as in_doubt (or another terminal result won), late
        // authenticated substrate evidence must not rewrite it and must not
        // strand the separately durable peer checkpoint.
        if (confirmed !== null && !isGatedActionTerminal(confirmed.status)) {
          throw new Error('authenticated peer answer could not reconcile its operation receipt');
        }
      }
    }

    await deps.resume({
      run_id: row.run_id,
      gated_step_id: row.gated_step_id,
      exchange_ref: row.exchange_ref,
    });

    try {
      const closed = deps.outbox.close(row.exchange_ref);
      if (!closed && deps.outbox.get(row.exchange_ref) !== null) {
        throw new Error('peer answer outbox row remained open after close');
      }
    } catch (error) {
      // An adapter may report failure after its delete committed. Read-back is
      // the postcondition; only a still-live row needs another retry.
      try {
        if (deps.outbox.get(row.exchange_ref) === null) return true;
      } catch {
        /* retain the original close error */
      }
      throw error;
    }
    return true;
  })();
  peerAnswerContinuationFlights.set(row.exchange_ref, flight);
  void flight.finally(() => {
    if (peerAnswerContinuationFlights.get(row.exchange_ref) === flight) {
      peerAnswerContinuationFlights.delete(row.exchange_ref);
    }
  }).catch(() => undefined);
  return flight;
};

const sameRecordedAnswer = (
  existing: PeerAnswerRecord,
  candidate: PeerAnswerRecord,
  requireAt: boolean,
): boolean => existing.peer_contract_id === candidate.peer_contract_id
  && existing.answered === candidate.answered
  && existing.option === candidate.option
  && existing.note === candidate.note
  && existing.unanswered_because === candidate.unanswered_because
  && (!requireAt || existing.at === candidate.at);

const rawCarriesExplicitAnswerTime = (raw: unknown): boolean => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const at = (raw as Record<string, unknown>).at;
  return typeof at === 'number' && Number.isFinite(at);
};

const toPeerAnswerRecord = (
  exchange_ref: string,
  peer_contract_id: string,
  answer: PeerAnswer,
): PeerAnswerRecord => ({
  exchange_ref,
  peer_contract_id,
  answered: answer.answered,
  ...(answer.option !== undefined ? { option: answer.option } : {}),
  ...(answer.note !== undefined ? { note: answer.note } : {}),
  ...(answer.unanswered_because !== undefined
    ? { unanswered_because: answer.unanswered_because }
    : {}),
  at: answer.at,
});

/** a's door. Validate, record, reconcile the receipt, resume, then close. */
export const receiveAnswer = async (
  input: InboundPeerAnswer,
  deps: PeerAnswerInboundDeps,
): Promise<PeerAnswerInboundResult> => {
  const now = deps.now ?? Date.now;
  const open = deps.outbox.get(input.exchange_ref);
  if (open === null) {
    // A completed continuation closes the outbox only after the exact held run
    // resumed. The answer fact intentionally outlives that live route, so it can
    // acknowledge an at-least-once retry whose first accepted response was lost.
    // Match both the authenticated peer and the normalized answer; every other
    // missing/mismatched ref keeps the same `not_solicited` response below.
    const existingAnswer = deps.answers.get(input.exchange_ref);
    if (existingAnswer !== null
      && existingAnswer.peer_contract_id === input.peer_contract_id
      && !isPeerHoldAbandonmentClaim(existingAnswer)) {
      const replay = parsePeerAnswer(
        input.raw,
        existingAnswer.option !== undefined ? [existingAnswer.option] : [],
        now(),
      );
      if (replay !== undefined
        && sameRecordedAnswer(
          existingAnswer,
          toPeerAnswerRecord(input.exchange_ref, input.peer_contract_id, replay),
          rawCarriesExplicitAnswerTime(input.raw),
        )) {
        return {
          accepted: false,
          refusal: 'already_answered',
          reason: 'this exact answer was already recorded and its conversation completed',
        };
      }
    }
    // ⚠ THE SAME CODE FOR "NEVER ASKED" AND "ALREADY CLOSED", deliberately. The
    // two are one fact for every caller that cannot prove it authored the exact
    // durable answer above, so an unknown caller still cannot discover whether a
    // guessed ref was ever real.
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
  const candidate = toPeerAnswerRecord(
    input.exchange_ref,
    input.peer_contract_id,
    answer,
  );
  const recorded = deps.answers.record(candidate);
  if (!recorded) {
    const existingAnswer = deps.answers.get(input.exchange_ref);
    // Refusal may have won the cross-process SQLite arbitration after our open
    // read but before the conditional answer insert. No answer row in that case
    // means the live route closed; do not misreport it as `already_answered`.
    if (existingAnswer === null) {
      return {
        accepted: false,
        refusal: 'not_solicited',
        reason: 'no open conversation under that reference on this server',
      };
    }
    // A local orphan-abandon claim owns a terminal transition and explicitly
    // forbids recipe resumption. Leave its outbox row for the abandonment retry;
    // neither an incoming conflict nor an exact-answer recovery may steal it.
    if (isPeerHoldAbandonmentClaim(existingAnswer)) {
      return {
        accepted: false,
        refusal: 'not_solicited',
        reason: 'this server has stopped waiting on that conversation',
      };
    }
    if (sameRecordedAnswer(
      existingAnswer,
      candidate,
      rawCarriesExplicitAnswerTime(input.raw),
    )) {
      try {
        await continueRecordedPeerAnswer(open, deps);
        return { accepted: true, resumed: true };
      } catch (error) {
        console.warn(
          `[peer-answer] existing answer continuation failed for ref '${input.exchange_ref}': `
            + (error instanceof Error ? (error.stack ?? error.message) : String(error)),
        );
        return { accepted: true, resumed: false };
      }
    }
    // Help the first durable answer finish even when the retry conflicts. The
    // caller still receives `already_answered`; first-write-wins is unchanged.
    try {
      await continueRecordedPeerAnswer(open, deps);
    } catch (error) {
      console.warn(
        `[peer-answer] winning answer continuation remains pending for ref '${input.exchange_ref}': `
          + (error instanceof Error ? (error.stack ?? error.message) : String(error)),
      );
    }
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

  let resumed = false;
  try {
    resumed = await continueRecordedPeerAnswer(open, deps);
  } catch (e) {
    // The answer and outbox row both remain durable. An exact wire retry or the
    // periodic/startup sweep re-enters this same continuation.
    console.warn(
      `[peer-answer] recorded but resume failed for ref '${input.exchange_ref}': `
      + (e instanceof Error ? (e.stack ?? e.message) : String(e))
      + ' — answer and retry anchor remain recorded.',
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
  let reply: unknown;
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
    reply = r;
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
  // ⛔⛔ READ THE FIELDS, NEVER THE SERIALISED BLOB. This block used to
  // substring-match `said` — our own `JSON.stringify` of the PEER'S response
  // object — for `"accepted":true` and each refusal code. That search is
  // depth-blind and field-blind, and `reason` is PEER-SUPPLIED TEXT (this file
  // caps it for exactly that reason, § EXCHANGE_PEER_REASON_MAX). So a peer whose
  // reason merely QUOTED a code — an error wrapper echoing it is the likely
  // trigger, not an attack — was classified PERMANENT, and the owner's answered
  // decision was dropped instead of retried. It fails in the losing direction.
  // 🔑 A substring match over a blob you do not control cannot tell a FIELD from
  // a MENTION.
  //
  // ⚠ A2A-ALIGNED CLASSIFICATION (v1.0, § P1.0). A2A splits task states into
  // TERMINAL (`COMPLETED` / `FAILED` / `CANCELED` / `REJECTED` — retrying changes
  // nothing) and INTERRUPTED (`INPUT_REQUIRED` / `AUTH_REQUIRED` — still live).
  // Every declared refusal here is terminal in exactly that sense; an
  // unrecognised response is not, so it stays retryable. Same distinction, same
  // direction — which is what makes a later consolidation with A2A's push path a
  // projection rather than a rewrite.
  const verdict = readPeerAnswerVerdict(reply);
  const accepted = verdict.kind === 'accepted';
  const alreadyHome = verdict.kind === 'refused' && verdict.refusal === 'already_answered';
  const permanent = verdict.kind === 'refused';
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
