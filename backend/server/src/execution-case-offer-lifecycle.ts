/** D-219 slice 9c — the offer's LIFECYCLE: raise it on the turn that earned it,
 *  retire it at the owner's NEXT turn.
 *
 *  6b-ii built the DECISION and the payload; this is when they happen and what
 *  becomes of an offer nobody answers.
 *
 *  ## Why the chat boundary rather than a housekeeping salvage
 *
 *  Silence is already SAFE — an unanswered ask creates no evidence and nothing
 *  files, per the contracts' *"approving a proposal is permission to try, not
 *  acceptance of the eventual result, and no later complaint is not evidence"*.
 *  So this is a lifecycle question, not a correctness one, and the two candidate
 *  answers traded differently:
 *
 *  - **Housekeeping salvage** (D-123, idle-driven) has to invent a staleness
 *    policy — how long is an unanswered offer still worth acting on — and then
 *    acts on stale owner context, since by the time an idle cycle runs the owner
 *    may not recall the turn at all.
 *  - **The next chat turn** is deterministic, needs no waiting-period guess, and
 *    puts the question where the owner already is. It is also a hook on a path
 *    that already runs, against a whole new background task kind.
 *
 *  ⛔ **And an offer must EXPIRE rather than accumulate.** An owner holding forty
 *  pending "worth remembering?" asks answers none of them, which trains away the
 *  one signal the whole refactor depends on. The invariant here is therefore: at
 *  most ONE open offer per span, and the owner's next request retires it.
 *
 *  ## What decides "the owner moved on" — and what deliberately does not
 *
 *  The ROOT REQUEST ID, never elapsed time. §4.2 forbids deriving a span from
 *  timestamp proximity, and "the offer is 10 minutes old" is exactly that. A new
 *  user message opens a fresh root (`chat-span-anchor-middleware`, with the
 *  continuation resolver unwired), so *"this turn's root differs from the root
 *  the open offer names"* is a durable correlation that says the owner has moved
 *  past it. When the root cannot be resolved, nothing is retired — a kept ask is
 *  the safe failure, a wrongly-cancelled one loses the answer.
 */

import {
  getPref,
  isExecutionCaseFeedbackKind,
  type InstancePrefs,
} from '@recued/contracts';

import type {
  CaseSourceObservation,
} from './execution-case-core.js';
import type {
  ExecutionCaseCompiler,
} from './execution-case-compiler.js';
import type {
  ExecutionCaseFeedbackRecorder,
} from './execution-case-feedback.js';
import {
  EXECUTION_CASE_OFFER_ASK_KIND,
  decideExecutionCaseOffer,
  offerExecutionCase,
  type RaiseExecutionCaseOfferAsk,
} from './execution-case-offer.js';
import type {
  ExecutionCaseStore,
} from './storage/execution-case-store.js';

/** The narrow notification seam this consumer needs — the same posture as
 *  `PreflightNotifier` / `SagaNotifier` / `PickNotifier`: the block is threaded
 *  as a narrow interface, never as itself. */
export interface ExecutionCaseOfferNotifier {
  ask: RaiseExecutionCaseOfferAsk;
  /** Retire a still-open ask WITHOUT an answer, closing its prompt on every
   *  channel it reached. `'not_open'` when a reply won the race — which is the
   *  good outcome, and why the return value is never treated as a failure. */
  cancelAsk(ask_id: string): Promise<'cancelled' | 'not_open'>;
  listOpenAsks(): Promise<ReadonlyArray<{
    ask_id: string;
    handler_kind: string;
    handler_payload: Record<string, unknown>;
  }>>;
  registerAskHandler(
    kind: string,
    handler: (
      payload: Record<string, unknown>,
      answer: { option: string; answered_at: number },
    ) => void | Promise<void>,
  ): void;
}

/** ⛔ THE OWNER'S SWITCH, resolved OFF-ANYWHERE-WINS.
 *
 *  `chat.execution_case_offer` is a per-INSTANCE pref, but the ask it governs is
 *  raised once by the server and fanned out by the notification block — there is
 *  no "this device's ask" to gate. So the server takes the union of the roster's
 *  answers in the quiet direction: **one paired device with it off silences the
 *  question everywhere.**
 *
 *  That direction is chosen, not arbitrary. Wrongly asking is an interruption
 *  the owner already declined somewhere, and an owner who learns to dismiss this
 *  prompt is exactly how the one signal the arc depends on gets trained away.
 *  Wrongly staying quiet costs a case the owner can recreate by doing the work
 *  again — the same recoverability that justifies excluding `abandoned`.
 *
 *  An empty roster (no paired devices, or no store) is ENABLED: the registry
 *  default is `true`, and absence of an opinion is not an opt-out. */
export const executionCaseOfferEnabled = (
  roster: ReadonlyArray<Partial<InstancePrefs> | undefined>,
): boolean =>
  roster.every((prefs) => getPref(prefs, 'chat.execution_case_offer'));

export interface ExecutionCaseOfferLifecycleDeps {
  notifier: ExecutionCaseOfferNotifier;
  compiler: Pick<ExecutionCaseCompiler, 'resolveRootForClose'>;
  caseStore: Pick<
    ExecutionCaseStore,
    'listObservationsForRoot' | 'getByKey'
  >;
  /** The EXISTING D-214 rpc. Nothing new is recorded by this module — an
   *  answered offer routes here, exactly as a client-typed verdict would. */
  feedback: Pick<ExecutionCaseFeedbackRecorder, 'record'>;
  /** Derives the case key an observation would file under, for the
   *  "already covered" gate. Injected so the lifecycle stays free of the
   *  compiler's hashing internals. */
  caseKeyOf: (observation: CaseSourceObservation) => string;
  /** The owner's switch, read LIVE per candidate turn so a toggle takes effect
   *  on the next turn without a reconnect — the same posture as every other
   *  pref consumer.
   *
   *  ⚠ OPTIONAL, AND ABSENT MEANS ON. The registry default is `true`, so a
   *  composition that forgets to wire this must fail toward asking rather than
   *  silently retiring the feature: a silenced ask is indistinguishable from a
   *  working one until someone notices the corpus never grew. */
  isOfferEnabled?: () => boolean;
}

export interface ExecutionCaseOfferLifecycle {
  /** BEFORE a turn — retire an offer whose span the owner has moved past.
   *  Returns how many were retired. */
  retireSupersededOffers(input: {
    session_id: string;
    turn_id: string;
  }): Promise<number>;
  /** AFTER a turn — ask about it, when it is a fresh candidate. */
  offerForTurn(input: {
    session_id: string;
    turn_id: string;
  }): Promise<{ ask_id: string } | null>;
  /** Boot-time, once: wire the answer back to `chat.execution.feedback`. */
  registerAnswerHandler(): void;
}

const readString = (
  payload: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const createExecutionCaseOfferLifecycle = (
  deps: ExecutionCaseOfferLifecycleDeps,
): ExecutionCaseOfferLifecycle => {
  const openOffersForSession = async (
    session_id: string,
  ): Promise<Array<{
    ask_id: string;
    root_request_id: string | undefined;
    observation_id: string | undefined;
  }>> => {
    const asks = await deps.notifier.listOpenAsks();
    return asks
      .filter((ask) =>
        ask.handler_kind === EXECUTION_CASE_OFFER_ASK_KIND
        && readString(ask.handler_payload, 'session_id') === session_id)
      .map((ask) => ({
        ask_id: ask.ask_id,
        root_request_id: readString(ask.handler_payload, 'root_request_id'),
        observation_id: readString(ask.handler_payload, 'observation_id'),
      }));
  };

  return {
    async retireSupersededOffers(input) {
      const currentRoot = deps.compiler.resolveRootForClose(
        input.session_id,
        input.turn_id,
      );
      // ⛔ No root, no retirement. An unresolvable turn tells us nothing about
      // whether the owner moved on, and cancelling on a guess destroys an
      // answer the owner could still give. Keeping the ask is the safe failure.
      if (!currentRoot) return 0;
      let retired = 0;
      for (const offer of await openOffersForSession(input.session_id)) {
        if (offer.root_request_id === currentRoot) continue;
        // `'not_open'` means a reply won the race — the answer is recorded and
        // this is a no-op, not an error. Either way the offer is no longer open.
        await deps.notifier.cancelAsk(offer.ask_id);
        retired += 1;
      }
      return retired;
    },

    async offerForTurn(input) {
      // ⛔ THE GATE SITS ON THE RAISE PATH ONLY. `retireSupersededOffers` must
      // keep running whatever this says: an ask raised while the switch was on
      // is still open after it goes off, and nothing else would ever close it.
      if (deps.isOfferEnabled?.() === false) return null;
      const root = deps.compiler.resolveRootForClose(
        input.session_id,
        input.turn_id,
      );
      if (!root) return null;
      const observations = await deps.caseStore.listObservationsForRoot(root);
      // The LAST observation is the span's final flow. An earlier one is a
      // superseded attempt within the same request, and asking "was that
      // right?" about a flow the model itself abandoned would be asking about
      // work the owner never saw the result of.
      const observation = observations.at(-1);
      if (!observation) return null;
      const existingCase = await deps.caseStore.getByKey(
        deps.caseKeyOf(observation),
      );
      const decision = decideExecutionCaseOffer(
        observation,
        new Set(existingCase ? [deps.caseKeyOf(observation)] : []),
        deps.caseKeyOf,
      );
      if (!decision.ask) return null;
      // ⛔ AT MOST ONE OPEN OFFER PER SPAN. `update` runs per middleware turn,
      // and while today's chat path runs exactly one turn per user message
      // (nothing calls `requestContinue`), a stream that ever ran several would
      // otherwise raise an ask per turn about the same request.
      //
      // When such a turn DOES record a later flow, the open ask is superseded
      // rather than kept: it names an observation that is no longer the span's
      // final one, so its verdicts were computed from a partial flow. Cancelling
      // and re-raising is the same supersession shape the batch-approval JOIN
      // uses, and it costs nothing on the single-turn path — the observation id
      // is identical, so the ask is simply left alone.
      for (const open of await openOffersForSession(input.session_id)) {
        if (open.root_request_id !== root) continue;
        if (open.observation_id === observation.observation_id) return null;
        await deps.notifier.cancelAsk(open.ask_id);
      }
      return offerExecutionCase(
        deps.notifier.ask,
        observation,
        decision,
        input.turn_id,
      );
    },

    registerAnswerHandler() {
      deps.notifier.registerAskHandler(
        EXECUTION_CASE_OFFER_ASK_KIND,
        async (payload, answer) => {
          // The block hands back whatever option id was answered, and its own
          // dedup guarantees an option the ask never offered is a no-op. This
          // still re-checks the vocabulary rather than trusting the string: the
          // recorder writes durable typed evidence, and a payload is persisted
          // JSON that outlives the code that wrote it.
          if (!isExecutionCaseFeedbackKind(answer.option)) return;
          const session_id = readString(payload, 'session_id');
          const turn_id = readString(payload, 'turn_id');
          if (!session_id || !turn_id) return;
          await deps.feedback.record({
            session_id,
            turn_id,
            kind: answer.option,
          });
        },
      );
    },
  };
};
