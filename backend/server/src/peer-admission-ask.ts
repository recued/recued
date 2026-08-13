/** D-234 § 234.1 — the ENTRY ASK: "a peer wants this; do you want to answer?"
 *
 *  The receiver's ceiling has three answers. `auto_accept` runs, `refuse` returns
 *  a delivered denial, and `ask` puts the decision to the owner ONCE, BEFORE ANY
 *  STEP RUNS. This is the third.
 *
 *  ⛔⛔ IT DOES NOT RE-DISPATCH THE HELD RUN, AND THAT IS THE WHOLE DESIGN. Two
 *  earlier readings were wrong. The first said an admission hold needs a new
 *  checkpoint discriminant — false: a checkpoint avoids REPEATING WORK and an
 *  entry hold has done none (everything in `handleExecute` before the admission
 *  point is pure). The second said "so just re-dispatch" — also false, for a
 *  deeper reason:
 *
 *  🔑🔑 YOU CAN RE-DISPATCH A REQUEST; YOU CANNOT RE-DISPATCH AN IDENTITY. A
 *  peer's authority is a property of their LIVE TOKEN PRESENTATION —
 *  `buildMcpExecutionSource` reads `boundContractId ?? mcpTokenId` off the
 *  transport, and the snapshot needs the per-token authorizer. A deferred re-run
 *  has no token on the wire, so it has no honest way to BE the peer; running it
 *  as the owner instead is escalation, because the approval said "answer this
 *  peer", not "run this as me".
 *
 *  ⇒ So nothing is re-run here. The DECISION is recorded, and the peer's next
 *  call — a manual retry, carrying its own token — finds it waiting. Authority is
 *  therefore always live and never replayed, which is a stronger property than
 *  the re-dispatch design would have had.
 *
 *  The flow:
 *
 *    a peer calls a receiver whose ceiling says `ask`
 *      → no decision recorded ⇒ raise this ask, fail the run as `policy`
 *        (a human must decide — not a retryable fault), nothing ran, nothing sent
 *      → the owner answers on any channel, durable across a restart
 *      → the answer is recorded against the message's CONTENT identity
 *      → the peer retries manually; the ceiling claims the decision and the run
 *        proceeds (or is declined) without asking again
 *
 *  ⚠ Free of the `handleExecute` import so `execute-handler` can import the raise
 *  side without a cycle — the same split the container-pick and connection-slot
 *  leaves use. Here the leaf needs no dispatcher seam at all: recording a
 *  decision is the entire effect.
 */
import type {
  Answer,
  AskHandlerFn,
  AskHandlerKind,
  AskHandlerRef,
  AskOption,
  NotificationMessage,
} from '@recued/notification';

import type { PeerAdmissionStore } from './storage/peer-admission-store.js';

/** The durable handler kind. Registered once at boot; the block persists only
 *  `(kind, payload)`, never a closure, so an ask outlives the process. */
export const PEER_ADMISSION_HANDLER_KIND: AskHandlerKind = 'peer.admission';

export const PEER_ADMISSION_ACCEPT_OPTION: AskOption = Object.freeze({
  id: 'accept',
  label: 'Accept — answer them',
});

/** ⚠ DECLINE IS A FIRST-CLASS ANSWER, NOT A TIMEOUT. § 19.4 calls silence the
 *  worst outcome for a correspondent, so "no" is recorded and delivered rather
 *  than left to expire into nothing. */
export const PEER_ADMISSION_DECLINE_OPTION: AskOption = Object.freeze({
  id: 'decline',
  label: 'Decline',
});

/** What the host supplies to raise one admission ask.
 *
 *  ⛔ NO `config` VALUES, NO `vault`, NO `context`. Only the IDENTITY HASH of the
 *  message is persisted. This payload sits in an ask row for as long as the owner
 *  takes to answer, and the ask id IS a bearer capability (`/ask/<ask_id>`, no
 *  further auth) that travels through Slack / Telegram / WhatsApp. Putting the
 *  peer's arguments in it would make the notification a read capability for their
 *  content — and nothing here needs them, because nothing is re-dispatched. */
export interface PeerAdmissionAskInput {
  /** Host-computed `peerAdmissionIdentity` — contract + recipe + canonical
   *  payload. The peer's retry reproduces it; a different message does not. */
  admission_identity: string;
  recipe_id: string;
  /** Host-derived and unforgeable; recorded so the decision is auditable. */
  contract_id: string;
  /** The owner's own label for this peer — the only human-meaningful name. */
  connection_name: string;
  /** D-234 § 234.3 — an ABSOLUTE link to where the owner reads what this is
   *  about, resolved by the HOST from the recipe's `metadata.owner_surface`.
   *
   *  ⚠ Absent on a server with no public base URL — the same binary presence
   *  `askAnswerLink` has, and for the same reason: a link that cannot be opened
   *  from where the notification arrived is worse than none. */
  owner_surface_url?: string;
}

/** Build the ask. Pure.
 *
 *  ⚠ THE COPY NAMES WHO AND WHAT, NOT THE PAYLOAD. `MAX_VALUE_CHARS = 400` caps
 *  what the `/ask` landing renders, and the landing is a DECISION page reached by
 *  a bearer link — not a review surface. Rendering the peer's content here would
 *  make the link leak it. */
export const buildPeerAdmissionAsk = (
  input: PeerAdmissionAskInput,
): { message: NotificationMessage; options: readonly AskOption[]; handler: AskHandlerRef } => ({
  message: {
    title: 'A peer wants you to run a recipe',
    text:
      `The peer on connection '${input.connection_name}' asked this server to run `
      + `'${input.recipe_id}'. Nothing has run and nothing has been sent. Accept and `
      + 'they can go ahead next time they ask; decline and they are told no.',
    // D-234 § 234.3 — where to READ what this is about. ⛔ Deciding and reading
    // are different acts: this ask is a decision card (the `/ask` landing caps
    // values at 400, and its link IS a bearer capability), so the content lives
    // behind pairing at the other end of this link, never in the card.
    ...(input.owner_surface_url !== undefined
      ? { link_url: input.owner_surface_url }
      : {}),
  },
  options: [PEER_ADMISSION_ACCEPT_OPTION, PEER_ADMISSION_DECLINE_OPTION],
  handler: {
    kind: PEER_ADMISSION_HANDLER_KIND,
    payload: {
      admission_identity: input.admission_identity,
      recipe_id: input.recipe_id,
      contract_id: input.contract_id,
    },
  },
});

/** Build the durable `on_answer` handler. Recording the decision IS the whole
 *  effect — no run is dispatched, because a deferred dispatch cannot carry the
 *  peer's identity (see the module doc).
 *
 *  ⛔ AN ANSWER OUTSIDE THE OFFERED SET MUST NEVER BIND. A stale or forged option
 *  is refused rather than read as an accept; here the cost of getting that wrong
 *  is admitting a message the owner never admitted. */
export const createPeerAdmissionAnswerHandler = (
  store: PeerAdmissionStore,
  now: () => number = Date.now,
): AskHandlerFn => {
  return (payload: Record<string, unknown>, answer: Answer) => {
    const identity = payload.admission_identity;
    const recipeId = payload.recipe_id;
    const contractId = payload.contract_id;
    if (
      typeof identity !== 'string' || identity.length === 0
      || typeof recipeId !== 'string' || recipeId.length === 0
      || typeof contractId !== 'string' || contractId.length === 0
    ) {
      throw new Error(
        'peer admission handler: malformed payload — expected '
          + '{ admission_identity: string, recipe_id: string, contract_id: string }',
      );
    }
    const decision = answer.option === PEER_ADMISSION_ACCEPT_OPTION.id
      ? 'accepted' as const
      : answer.option === PEER_ADMISSION_DECLINE_OPTION.id
        ? 'declined' as const
        : undefined;
    if (decision === undefined) {
      throw new Error(
        `peer admission handler: answer '${answer.option}' is not one of the offered `
          + `options (${PEER_ADMISSION_ACCEPT_OPTION.id}, ${PEER_ADMISSION_DECLINE_OPTION.id})`,
      );
    }
    store.record({
      admission_identity: identity,
      decision,
      contract_id: contractId,
      recipe_id: recipeId,
      decided_at: now(),
      ask_id: '',
    });
  };
};

/** The narrow notification-block seam — same shape the pick / container-pick /
 *  saga leaves use; a `NotificationBlock` satisfies it structurally. */
export interface PeerAdmissionNotifier {
  ask(
    message: NotificationMessage,
    options: readonly AskOption[],
    handler: AskHandlerRef,
  ): Promise<{ ask_id: string }>;
  registerAskHandler(kind: AskHandlerKind, handler: AskHandlerFn): void;
}

/** Register the `peer.admission` answer handler. Call once at boot, before live
 *  traffic. ⚠ No dispatcher seam and therefore no wiring module: this leaf needs
 *  only the store, so there is no `handleExecute` import to keep out. */
export const registerPeerAdmissionHandler = (
  notifier: PeerAdmissionNotifier,
  store: PeerAdmissionStore,
  now?: () => number,
): void => {
  notifier.registerAskHandler(
    PEER_ADMISSION_HANDLER_KIND,
    createPeerAdmissionAnswerHandler(store, now),
  );
};

/** Raise the admission ask. Thin — the host owns the best-effort posture. */
export const raisePeerAdmissionAsk = async (
  notifier: PeerAdmissionNotifier,
  input: PeerAdmissionAskInput,
): Promise<{ ask_id: string }> => {
  const { message, options, handler } = buildPeerAdmissionAsk(input);
  return notifier.ask(message, options, handler);
};
