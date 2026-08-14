/** D-234 § 234.4 — THE RECEIVING SIDE OF A REMOTE HOLD.
 *
 *  A peer asks this owner a question. NO RECIPE RUNS HERE — that is the whole
 *  point of the `ask` mode, and what separates it from `peer.run` (§ 234.1). The
 *  receiver can do exactly one thing with the request: answer it. Anything where
 *  the receiver must ACT belongs on `peer.run` with its full admission ceiling.
 *
 *  ⇒ Which is why this file is short. There is no dispatcher seam, no checkpoint,
 *  no recipe resolution: check exposure, raise a durable ask, write the ledger
 *  row, return an acknowledgement. § 234.1 already built the hard part — it is
 *  the proof that a peer can cause a durable, restart-surviving,
 *  answerable-anywhere ask on another server. This generalizes its question and
 *  option set from hardcoded accept/decline to whatever the asker named.
 *
 *  ⛔⛔ EXPOSURE IS THE ONLY DOOR, AND IT IS CLOSED BY DEFAULT. No declaration, no
 *  question — not even one. An earlier draft let a peer's FIRST question carry
 *  its own admission (approve / reject / never-ask-again); that still hands an
 *  un-vetted correspondent one free shot at the owner's attention, so exposure
 *  comes first and the question is only ever the second thing that happens.
 */
import type { AskHandlerRef, AskOption, NotificationMessage } from '@recued/notification';
import {
  PEER_ASK_BODY_MAX,
  PEER_ASK_OPTION_ID_MAX,
  PEER_ASK_OPTION_LABEL_MAX,
  PEER_ASK_OPTIONS_MAX,
  PEER_ASK_QUESTION_MAX,
  isPeerAskNotePrompt,
  isPeerAskTimeoutAction,
  type PeerAskNotePrompt,
  type PeerAskOption,
} from '@recued/contracts';


/** The durable handler kind. Registered once at boot; the ask block persists only
 *  `(kind, payload)`, never a closure, so the ask outlives the process. */
export const PEER_ASK_HANDLER_KIND = 'peer.ask';

/** What arrived from the peer, already parsed off the wire. */
export interface InboundPeerAsk {
  /** Host-derived and unforgeable — the contract the caller actually presented,
   *  NEVER a value they put in the payload. */
  readonly peer_contract_id: string;
  /** The owner's own name for the connection, for the card's copy. */
  readonly connection_name: string;
  /** Caller-supplied conversation id. ⚠ A LOOKUP KEY, NEVER A CREDENTIAL —
   *  § 234.2's rule. It rides in the envelope precisely so it can round-trip. */
  readonly exchange_ref: string;
  readonly label: string;
  readonly question: string;
  readonly options: readonly PeerAskOption[];
  readonly deadline_at?: number;
  readonly on_timeout?: string;
  /** D-234 § 234.4e — the asker wants a written reason. Validated like every
   *  other field off the wire: a value we do not know is REFUSED, not ignored,
   *  because silently dropping it would render no field and leave the asker
   *  waiting for prose that was never invited. */
  readonly note_prompt?: string;
  /** D-234 § 234.4f — the document to read. BOUNDED HERE, on the receiving side,
   *  rather than trusted from the sender's own validation. */
  readonly body?: string;
}

export const PEER_ASK_REFUSALS = [
  'not_exposed',
  'malformed',
] as const;
export type PeerAskRefusal = (typeof PEER_ASK_REFUSALS)[number];

export type PeerAskAdmission =
  | { readonly admitted: true; readonly message: NotificationMessage;
      readonly options: readonly AskOption[]; readonly handler: AskHandlerRef;
      /** D-234 § 234.4e — pass to `notifier.ask` so the surface renders a
       *  written-reason field. Absent ⇒ a plain two-tap decision. */
      readonly note_prompt?: PeerAskNotePrompt;
      /** D-234 § 234.4f — passed to `notifier.ask` as an extra, so it lands on
       *  the ASK RECORD and never on the message. */
      readonly body?: string }
  | { readonly admitted: false; readonly refusal: PeerAskRefusal;
      readonly reason: string };

/** Decide whether to put this question to the owner, and build the ask if so.
 *  Pure apart from the exposure read — the caller owns raising and recording.
 *
 *  ⚠ VALIDATES THE PEER'S PAYLOAD BEFORE THE EXPOSURE READ IS EVEN CONSULTED for
 *  shape, but reports `not_exposed` ahead of nothing: an unexposed peer learns
 *  only that it is unexposed, never whether its payload would have been accepted.
 *  A refusal that leaks validation detail is a probing surface. */
export const admitPeerAsk = (
  input: InboundPeerAsk,
  /** D-234 § 234.4j — THE ONLY GATE. `granted === true` on the peer's contract
   *  for `peer.label.<label>`, and nothing else.
   *
   *  ⛔⛔ THERE USED TO BE A SECOND STORE HERE AND IT WAS REDUNDANT. § 234.4
   *  shipped a `peer_exposure` table written by a `core.peer.expose` op-step;
   *  § 234.4h added the contract grant beside it and took the union; § 234.4j
   *  deleted the older half. Owner's argument, and it is decisive: the contract
   *  already says whether this peer may reach the ask door AT ALL
   *  (`core.peer.receive-ask`) — a second flag saying "and under this label" is
   *  the same question asked twice, in two stores, on two surfaces, one of which
   *  had no UI.
   *
   *  ⚠ DEFAULT CLOSED BY CONSTRUCTION: no row ⇒ `undefined` ⇒ not `true`. This
   *  reads the grant store DIRECTLY rather than through the author-default
   *  resolver, so no default can ever open the door. */
  isLabelGranted: (peer_contract_id: string, label: string) => boolean,
): PeerAskAdmission => {
  // ⛔ THE DOOR FIRST. Everything below this line tells the caller something
  // about how we work; an ungranted peer is entitled to none of it.
  if (isLabelGranted(input.peer_contract_id, input.label) !== true) {
    return {
      admitted: false,
      refusal: 'not_exposed',
      // ⚠ ONE MESSAGE FOR NEVER-EXPOSED AND FOR REVOKED, AND THAT IS A KNOWN
      // LIMITATION, NOT AN OVERSIGHT. § 234.4 wants a revoke to be
      // distinguishable on the wire so the asker's stale catalog can self-heal
      // instead of retrying blindly — but the exposure store DELETES on revoke
      // (a soft-deleted row invites a reader that forgets the predicate, and
      // that failure direction is fail-open), so there is nothing left here to
      // tell the two apart. Distinguishing them needs a tombstone, which is a
      // deliberate storage decision and is deferred rather than smuggled in.
      reason:
        `this server is not offering '${input.label}' to you. If it once was, `
        + 'it has been withdrawn — ask your correspondent to re-offer it.',
    };
  }
  const bad = (reason: string): PeerAskAdmission =>
    ({ admitted: false, refusal: 'malformed', reason });

  if (input.exchange_ref === '') return bad('exchange_ref is required');
  if (typeof input.question !== 'string' || input.question.trim() === '') {
    return bad('question is required');
  }
  if (input.question.length > PEER_ASK_QUESTION_MAX) {
    return bad(`question exceeds ${PEER_ASK_QUESTION_MAX} characters`);
  }
  if (!Array.isArray(input.options) || input.options.length === 0) {
    return bad('at least one option is required');
  }
  if (input.options.length > PEER_ASK_OPTIONS_MAX) {
    return bad(`at most ${PEER_ASK_OPTIONS_MAX} options`);
  }
  const seen = new Set<string>();
  for (const o of input.options) {
    if (typeof o?.id !== 'string' || o.id === '' || o.id.length > PEER_ASK_OPTION_ID_MAX
      || typeof o?.label !== 'string' || o.label === ''
      || o.label.length > PEER_ASK_OPTION_LABEL_MAX) {
      return bad(
        `every option needs an id of at most ${PEER_ASK_OPTION_ID_MAX} characters `
        + `and a label of at most ${PEER_ASK_OPTION_LABEL_MAX} characters`,
      );
    }
    if (seen.has(o.id)) return bad(`duplicate option id '${o.id}'`);
    seen.add(o.id);
  }
  if (input.note_prompt !== undefined && !isPeerAskNotePrompt(input.note_prompt)) {
    return bad(`unknown note_prompt '${input.note_prompt}'`);
  }
  if (input.on_timeout !== undefined && !isPeerAskTimeoutAction(input.on_timeout)) {
    return bad(`unknown on_timeout '${input.on_timeout}'`);
  }

  return {
    admitted: true,
    ...(input.note_prompt !== undefined
      ? { note_prompt: input.note_prompt as PeerAskNotePrompt }
      : {}),
    // ⚠ TRUNCATED, NOT REFUSED. A body past the cap still leaves a readable
    // decision; refusing the whole ask over length would turn a verbose
    // correspondent into an outage. The block re-applies the same bound.
    ...(typeof input.body === 'string' && input.body !== ''
      ? { body: input.body.slice(0, PEER_ASK_BODY_MAX) }
      : {}),
    message: {
      title: 'A peer is asking you something',
      // ⚠ THE PEER'S OWN WORDS, CARRIED VERBATIM AND ATTRIBUTED. The owner has
      // to see who is asking as plainly as what is asked — an unattributed
      // question read on a phone is indistinguishable from one this server
      // generated itself.
      //
      // ⚠⚠ THE DEADLINE IS IN `text`, AND THE FIRST CUT PUT IT IN A FIELD THAT
      // DOES NOT EXIST. `NotificationMessage` is `{ title?, text, link_url? }`;
      // an invented `text_suffix` was accepted only because the object carried a
      // whole-object `as NotificationMessage` cast, which suppresses the
      // excess-property check that would have caught it. The deadline would have
      // been dropped on every card, silently — and it is precisely the field the
      // asker promised to act on, so a receiver who never saw it would budget
      // their time against a date that does not exist (§ 19.4, pointed at the
      // answerer). The cast is gone; this object is now type-checked.
      text: input.deadline_at === undefined
        ? `${input.connection_name} asks: ${input.question}`
        : `${input.connection_name} asks: ${input.question}\n\nNeeded by `
          + new Date(input.deadline_at).toISOString(),
    },
    options: input.options.map((o) => ({ id: o.id, label: o.label })),
    handler: {
      kind: PEER_ASK_HANDLER_KIND,
      // ⛔ THE CORRELATION ONLY. No question text, no options, no peer payload.
      // This sits in an ask row for as long as the owner takes to answer, and the
      // ask id IS a bearer capability (`/ask/<ask_id>`, no further auth) that
      // travels through Slack / Telegram / WhatsApp. Anything in here becomes
      // readable by whoever holds the link; the answer path re-reads what it
      // needs from the ledger.
      payload: {
        peer_contract_id: input.peer_contract_id,
        exchange_ref: input.exchange_ref,
        label: input.label,
      },
    },
  };
};

/** The ledger target for every `peer_ask_*` activity row: `<contract>/<label>`.
 *  Stable across the ask's whole life so one grep answers "what has this peer
 *  asked me, and what did I say". */
export const peerAskLedgerTarget = (peer_contract_id: string, label: string): string =>
  `${peer_contract_id}/${label}`;
