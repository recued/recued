/** D-234 § 234.4 — THE REMOTE HOLD: asking a peer's OWNER a question.
 *
 *  🔑🔑 A PEER ANSWER IS AN APPROVAL HOLD WHOSE ANSWERER IS ELSEWHERE. Not an
 *  analogy — the same substrate feature for feature: the run suspends into a
 *  `Checkpoint`, the process ENDS (nothing is held open), a boot sweep pairs the
 *  orphaned anchor with its checkpoint, resume re-instantiates from `step_state`
 *  with vault re-seeded fresh, and the resumed gated step RE-RUNS. The only
 *  structural difference is where the ask lives: an approval mints a
 *  `PendingAsk` on this server, a peer ask raises one on THEIRS.
 *
 *  ⇒ Which is why the resume path needs no new mechanism. `execute.ts` already
 *  documents that "the gated step itself re-runs … with approval threaded by the
 *  gateway so it does not re-raise". A peer-ask step re-runs the same way and
 *  finds the recorded answer waiting, exactly as § 234.1's ceiling re-runs and
 *  finds the recorded admission decision. Idempotent-with-memory, both of them.
 *
 *  ⛔ THIS IS THE `ask` MODE, NOT THE `run` MODE — the split is load-bearing.
 *  `peer.run` (§ 234.1) says "your SERVER should do something": it dispatches a
 *  recipe on the receiver and needs the full admission ceiling. `peer.ask` says
 *  "YOU should read something and answer": no recipe runs on the receiver at
 *  all, so the receiver can do exactly one thing with the request — answer it.
 *  Anything where the receiver must ACT belongs on `peer.run`.
 *
 *  Spec: internal design notes D-234 § 234.4. */

import type { ForeachCheckpointProgress } from './foreach-checkpoint.js';

/** One answer choice.
 *
 *  ⚠ MIRRORS `AskOption` from `@recued/notification` RATHER THAN IMPORTING IT —
 *  the same thing `events.ts` does for the `notification.ask` bus frame, and for
 *  the same reason: contracts is the root of the dependency graph and the
 *  notification block depends on IT. A structural `{ id, label }` satisfies both
 *  sides with no edge added. */
export interface PeerAskOption {
  readonly id: string;
  readonly label: string;
}

// ════════════════════════════════════════════════════════════════
// What the asking op-step declares
// ════════════════════════════════════════════════════════════════

/** What the asker does when the deadline passes with no answer.
 *
 *  ⛔⛔ NEITHER OF THESE FAILS THE RUN, AND THAT IS THE POINT. A timeout that
 *  killed the run would make "they did not answer in time" an ERROR, when it is
 *  an ordinary outcome a recipe should be able to branch on — send it anyway,
 *  escalate to a second reviewer, hold and notify me. Core supplies ONE FACT
 *  (answered, or not, by when) and the recipe decides what it means. */
export const PEER_ASK_TIMEOUT_ACTIONS = ['stop', 'wait'] as const;
export type PeerAskTimeoutAction = (typeof PEER_ASK_TIMEOUT_ACTIONS)[number];

export const isPeerAskTimeoutAction = (v: unknown): v is PeerAskTimeoutAction =>
  typeof v === 'string' && (PEER_ASK_TIMEOUT_ACTIONS as readonly string[]).includes(v);

/** WHICH ROUTE CARRIES THE QUESTION — § 234.4a, and the SENDER chooses.
 *
 *  ⛔⛔ THIS IS A FIELD RATHER THAN A FIX BECAUSE NEITHER ROUTE SUPERSEDES THE
 *  OTHER. Delivery first went out over the § 232 carrier
 *  (`peer-exchange-out.ask.send` → `run-ingredient`), which is a RECIPE RUN — so
 *  the sender's own preflight fired and the carrier sat waiting on an approval
 *  the owner had ALREADY GIVEN when `core.peer.ask` (write risk) paused the run.
 *  That is the double-prompt § 234.4 exists to remove, rebuilt on the sending
 *  side. It is not the carrier misbehaving: it is the RECIPE variant working
 *  exactly as designed, being used for a job that wants the DIRECT one.
 *
 *  - `direct` — the host calls the peer's native `recued_peerAsk` straight over
 *    the connection adapter. No recipe on either end, no catalog binding, ONE
 *    approval. The receiver installs NOTHING: the door is a native verb-op
 *    (`core.peer.receive-ask`), so any Recued server can answer out of the box.
 *  - `recipe` — the ask travels through the § 232 carrier. Its second approval
 *    is CORRECT there rather than a double-prompt, because a recipe-mediated
 *    send is its own act with its own audit identity.
 *
 *  🔑 The rule that separates them: DOES THE RECEIVER DO ANYTHING OTHER THAN
 *  ANSWER? No ⇒ `direct` (attention only, nothing installed, one approval).
 *  Yes ⇒ `recipe`, and that is `peer.run`'s neighbourhood, where the binding and
 *  the second approval are the point rather than an accident. */
export const PEER_ASK_VIA = ['direct', 'recipe'] as const;
export type PeerAskVia = (typeof PEER_ASK_VIA)[number];

export const isPeerAskVia = (v: unknown): v is PeerAskVia =>
  typeof v === 'string' && (PEER_ASK_VIA as readonly string[]).includes(v);

/** THE ONE PLACE THAT DECIDES WHICH ROAD AN AUTHORED `via` NAMES. Returns the
 *  resolved road, or `undefined` for a value that is PRESENT-AND-UNKNOWN — which
 *  `validatePeerAskSpec` refuses as `via_unknown` rather than coercing.
 *
 *  ⛔⛔ UNSET HAS THREE SPELLINGS ON THIS BOUNDARY AND ALL THREE MEAN `direct`:
 *  `undefined` (no key), `null` (the kernel manifest spells an unset input
 *  `null` and `mergeManifestStepInput` lays defaults UNDER the step args), and
 *  `''` (an unset `{{config.*}}` picker resolves to the EMPTY STRING, not
 *  undefined). Each of the three cost this arc a live defect; `=== undefined`
 *  alone once refused every un-annotated ask.
 *
 *  ⚠ IT LIVES IN CONTRACTS BESIDE THE TYPE IT COERCES TO, not in the backend
 *  parser that is currently its only caller. D-234 § 234.4o briefly gave it a
 *  SECOND caller — an approval lift that decided per-road whether to prompt —
 *  and that lift was removed once the real defect turned out to be one layer
 *  down (the § 232 carrier ran source-less). The rules stay here because the
 *  three spellings of unset are a property of `PeerAskVia` on this boundary
 *  rather than of any one reader, and the next reader should find them with the
 *  type instead of re-deriving them. */
export const normalizePeerAskVia = (raw: unknown): PeerAskVia | undefined =>
  raw === undefined || raw === null || raw === ''
    ? 'direct'
    : isPeerAskVia(raw)
      ? raw
      : undefined;

/** D-234 § 234.4e — mirrors `AskNotePrompt` from `@recued/notification` rather
 *  than importing it, exactly as {@link PeerAskOption} mirrors `AskOption` and
 *  for the same reason: contracts is the root of the dependency graph. */
export const PEER_ASK_NOTE_PROMPTS = ['optional', 'required'] as const;
export type PeerAskNotePrompt = (typeof PEER_ASK_NOTE_PROMPTS)[number];
export const isPeerAskNotePrompt = (v: unknown): v is PeerAskNotePrompt =>
  typeof v === 'string' && (PEER_ASK_NOTE_PROMPTS as readonly string[]).includes(v);

/** ⚠ CAPS EXIST BECAUSE THE FAR SIDE WROTE THIS. A question and its options are
 *  authored by ANOTHER SERVER and land in a notification that travels through
 *  Slack / Telegram / WhatsApp / email. Same posture as
 *  `EXCHANGE_PEER_REASON_MAX`: a verbose or hostile correspondent is otherwise
 *  unbounded. The `/ask` landing caps a rendered value at 400 and the in-app
 *  card at 320, so a question past ~600 is already being truncated by the
 *  surface — the cap makes that honest instead of silent. */
export const PEER_ASK_QUESTION_MAX = 600;
export const PEER_ASK_OPTION_LABEL_MAX = 80;
export const PEER_ASK_OPTION_ID_MAX = 64;
/** ⚠ An option set is a DECISION, not a menu. Past a handful the card stops
 *  being answerable on a phone, which is where most of these get answered. */
export const PEER_ASK_OPTIONS_MAX = 6;
/** ⚠ The exposure label both sides must name identically. Free-form on purpose
 *  (D-234 § 234.4j — matched exactly against the peer's `peer.label.<label>`
 *  contract grant), so it needs a length bound rather than a vocabulary. */
export const PEER_ASK_LABEL_MAX = 64;
/** D-234 § 234.4f — the document the answerer opens to READ.
 *
 *  🔑 SIZED SO IT CAN TRAVEL EVERY PATH UNIFORMLY. 16 KB is ~4 pages — a review
 *  draft, not a repository — and matches the `context.recipe.*` snapshot bound
 *  already in the tree. At this size the body rides the ask record, the
 *  `pending_asks` projection AND the broadcast frame alike, so a live card and a
 *  re-fetched one show the same thing. A larger cap would have forced a second
 *  fetch mechanism for one of those paths, and a field carried on one path and
 *  not another is the silent-drop bug this arc has now paid for twice.
 *
 *  ⚠ AND THE FAR SIDE WROTE IT. Bounded at entry on the RECEIVER, not trusted
 *  from the sender's own validation — same posture as the question. */
export const PEER_ASK_BODY_MAX = 16_384;

/** One `core.peer.ask` op-step, resolved.
 *
 *  ⚠ `body` is DELIBERATELY NOT PART OF THE ASK CARD. The question goes on the
 *  card; the body is what the answerer opens to READ, via the § 234.3
 *  `owner_surface` link. Putting a document in a notification that travels as a
 *  bearer link is the mistake § 234.3 exists to prevent. */
export interface PeerAskSpec {
  /** The asker's own label for the peer connection — the only human-meaningful
   *  name on this side. */
  readonly connection: string;
  /** The capability label. The receiver must have EXPOSED this exact string to
   *  this asker or nothing is raised. */
  readonly label: string;
  /** The question, as the receiver's owner will read it. */
  readonly question: string;
  /** What the receiver may answer. */
  readonly options: readonly PeerAskOption[];
  /** Unix ms. Absent ⇒ no deadline, which is only legitimate together with
   *  `on_timeout: 'wait'`. */
  readonly deadline_at?: number;
  readonly on_timeout: PeerAskTimeoutAction;
  /** D-234 § 234.4e — ask the answerer to say WHY, alongside their choice.
   *  `'optional'` renders the field; `'required'` will not accept a bare option.
   *  Absent ⇒ the card stays a two-tap decision.
   *
   *  🔑 THE ASKER DECIDES, BECAUSE THE ASKER IS WHO NEEDS THE REASON. A review's
   *  value is the reasoning; a "shall I send this now?" needs none, and demanding
   *  prose for it trains people to type "ok". It travels with the question so the
   *  receiving surface can render the field — the receiver installs nothing, so
   *  they have no other way to know one is wanted. */
  readonly note_prompt?: PeerAskNotePrompt;
  /** D-234 § 234.4f — what the answerer READS before deciding. Absent for a
   *  card-sized question.
   *
   *  ⛔⛔ IT IS NOT PART OF THE ASK CARD'S MESSAGE, AND THAT IS THE WHOLE
   *  DESIGN. `NotificationMessage` is what travels to Slack / Telegram / email
   *  and to the bearer `/ask/<ask_id>` landing; a document there would be
   *  readable by whoever holds the notification — the mistake § 234.3 exists to
   *  prevent. The body rides the ASK RECORD instead, which is reachable only
   *  through the pair-authenticated `notification.pending_asks` rpc and the
   *  owner's own broadcast bus. Same ask, two audiences: the question goes
   *  everywhere, the document stays behind the owner's session.
   *
   *  🔑🔑 D-234 § 234.4p Step 2 — IT IS ALSO THE EVIDENCE, AND IT BINDS THE
   *  ANSWER. `peerAskExchangeRef` hashes it, so an answer is only ever readable
   *  against the exact bytes it was given for: edit the document under a held
   *  run and the resumed step looks under a different ref, finds nothing, and
   *  ASKS AGAIN with the new evidence. That is what makes an authorization void
   *  when what it authorized changed — and it is why the field is the evidence
   *  slot rather than a nicety. Driven in the two-server drive (8k6).
   *
   *  ⚠ SO PUT THE DECIDABLE THING IN HERE AND NOTHING ELSE. A body that carries
   *  incidental churn — a rendered timestamp, a counter, anything re-derived per
   *  run — re-asks every time it moves, which is this rule working and is
   *  nonetheless a bad experience. The document, not the page it was printed on. */
  readonly body?: string;
  /** Which route carries it — see {@link PEER_ASK_VIA}. Absent in authored JSON
   *  ⇒ `'direct'`, the universal path and the one that needs nothing installed
   *  on the receiver. Required HERE (not optional) so the delivery branch is a
   *  total switch: an unset field would make "the author chose direct" and "this
   *  spec predates the choice" the same value at the one place that routes on
   *  it. */
  readonly via: PeerAskVia;
  /** D-234 § 234.4p Step 1 — WHERE ON THE RECEIVER THE QUESTION LANDS. Absent ⇒
   *  the host's native ask door, which is every ask that existed before this
   *  field.
   *
   *  🔑🔑 IT NAMES A TOOL, AND THE NARROWING IS THAT IT MUST BE ONE **WE**
   *  INSTALLED. `resolveExchangeFireTarget` resolves this against THIS server's
   *  own manifests and returns the one catalog operation whose `mcp` binding
   *  names it; the BINDING then owns the literal string that goes on the wire. So
   *  the invariant the direct road states — *"the author names a CONNECTION and
   *  never a tool on someone else's server"* — is kept rather than dropped: an
   *  author picks among operations their owner installed, and a name matching
   *  none of them is refused before anything is sent. That is the § 232 posture
   *  already ratified for a peer-supplied name (*"the grant is the gate: a peer
   *  may name any op the owner granted and no other"*), with its three
   *  narrowings — installed, `mcp`-kind, and AMBIGUITY REFUSES.
   *
   *  ⚠ AND IT IS NOT DEAD END 2 RETURNING (§ 234.4p.3). That proposal routed on
   *  `label`, which would shadow the destination recipe's OWN grant with a second
   *  per-(peer, label) store — one capability, two locks. `deliver_to` names the
   *  grantable operation itself, so there is exactly one.
   *
   *  ⛔⛔ WHICH IS ALSO WHY IT IS `recipe`-ROUTE ONLY, and
   *  {@link validatePeerAskSpec} refuses the pairing rather than ignoring it. The
   *  `direct` road calls the tool name as a LITERAL through the connection
   *  adapter with no catalog resolution anywhere — so a `deliver_to` there would
   *  be exactly what the narrowing above prevents: an author naming an arbitrary
   *  tool on another server, checked by nothing. ⇒ Refused, because silently
   *  ignoring it would deliver to the default door while the recipe says
   *  otherwise, and the author would have no way to see which one won.
   *
   *  ⚠ NO LENGTH CAP, unlike `question` / `label` / `body` — and the asymmetry is
   *  the rule those caps encode. They are bounded because THE FAR SIDE WROTE
   *  THEM. This one is written by the local author and must match an installed
   *  binding to resolve at all, so an absurd value fails loudly at resolution
   *  rather than travelling anywhere. */
  readonly deliver_to?: string;
}

/** Why a `PeerAskSpec` is not usable. One code per distinct repair. */
export const PEER_ASK_SPEC_ERRORS = [
  'connection_missing',
  'label_missing',
  'label_too_long',
  'question_missing',
  'question_too_long',
  'options_missing',
  'options_too_many',
  'option_shape',
  'option_duplicate',
  'timeout_action_unknown',
  'deadline_without_stop',
  'stop_without_deadline',
  'via_unknown',
  'note_prompt_unknown',
  'body_too_long',
  'deliver_to_needs_recipe_route',
] as const;
export type PeerAskSpecError = (typeof PEER_ASK_SPEC_ERRORS)[number];

/** Validate an authored spec. Pure; returns every problem, not the first.
 *
 *  ⛔ THE TWO CROSS-FIELD RULES ARE THE ONES WORTH HAVING. `stop` with no
 *  deadline is a timeout that can never fire — the recipe author believes they
 *  bounded the wait and did not, which is exactly the silent kind of wrong. And
 *  a deadline with `wait` says "tell them Friday, then wait forever anyway",
 *  which makes the deadline shown to the receiver a lie. Both are authoring
 *  mistakes that produce a system that looks bounded and is not. */
export const validatePeerAskSpec = (spec: PeerAskSpec): PeerAskSpecError[] => {
  const out: PeerAskSpecError[] = [];
  if (typeof spec.connection !== 'string' || spec.connection.trim() === '') {
    out.push('connection_missing');
  }
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    out.push('label_missing');
  } else if (spec.label.length > PEER_ASK_LABEL_MAX) {
    out.push('label_too_long');
  }
  if (typeof spec.question !== 'string' || spec.question.trim() === '') {
    out.push('question_missing');
  } else if (spec.question.length > PEER_ASK_QUESTION_MAX) {
    out.push('question_too_long');
  }
  if (!Array.isArray(spec.options) || spec.options.length === 0) {
    out.push('options_missing');
  } else {
    if (spec.options.length > PEER_ASK_OPTIONS_MAX) out.push('options_too_many');
    const seen = new Set<string>();
    let shapeBad = false;
    let dup = false;
    for (const o of spec.options) {
      const id = (o as { id?: unknown } | null)?.id;
      const label = (o as { label?: unknown } | null)?.label;
      if (
        typeof id !== 'string' || id === '' || id.length > PEER_ASK_OPTION_ID_MAX
        || typeof label !== 'string' || label === ''
        || label.length > PEER_ASK_OPTION_LABEL_MAX
      ) {
        shapeBad = true;
        continue;
      }
      if (seen.has(id)) dup = true;
      seen.add(id);
    }
    if (shapeBad) out.push('option_shape');
    if (dup) out.push('option_duplicate');
  }
  if (!isPeerAskTimeoutAction(spec.on_timeout)) out.push('timeout_action_unknown');
  // ⛔ AN UNKNOWN ROUTE IS REFUSED, NOT COERCED. The two variants have DIFFERENT
  // obligations on the receiver — `direct` needs the native door granted,
  // `recipe` needs a per-pairing recipe grant — so quietly picking one for an
  // author who typed the other fails at the FAR end, for a reason nothing on
  // this side reports. Same posture `timeout_action_unknown` takes, and the
  // reason `parsePeerAskArgs` defaults only on ABSENCE.
  if (!isPeerAskVia(spec.via)) out.push('via_unknown');
  // ⚠ ABSENT IS VALID — most asks want no prose. Only a PRESENT-and-unknown value
  // is refused, the same posture `via` takes: a typo'd prompt would silently
  // render no field and the asker would wait for a reason that was never invited.
  if (spec.note_prompt !== undefined && !isPeerAskNotePrompt(spec.note_prompt)) {
    out.push('note_prompt_unknown');
  }
  if (typeof spec.body === 'string' && spec.body.length > PEER_ASK_BODY_MAX) {
    out.push('body_too_long');
  }
  // ⛔⛔ D-234 § 234.4p Step 1 — A DESTINATION ONLY MEANS ANYTHING ON THE CARRIER.
  // The `recipe` road resolves `deliver_to` against our OWN installed manifests,
  // so it can only ever name an operation the owner installed. The `direct` road
  // has no catalog step at all — it calls the tool name literally over the
  // connection adapter — so honouring one there would let an author name any
  // tool on someone else's server with nothing checking it, which is the exact
  // property both roads are documented to preserve.
  // ⚠ REFUSED RATHER THAN IGNORED, and that is the whole choice. Ignoring it
  // delivers to the default door while the recipe plainly says otherwise, and
  // nothing anywhere reports which one won — the silent-wrong shape this arc
  // keeps paying for. An author who wants a destination wants the carrier.
  if (spec.deliver_to !== undefined && spec.via !== 'recipe') {
    out.push('deliver_to_needs_recipe_route');
  }
  if (spec.on_timeout === 'wait' && spec.deadline_at !== undefined) {
    out.push('deadline_without_stop');
  }
  if (spec.on_timeout === 'stop' && spec.deadline_at === undefined) {
    out.push('stop_without_deadline');
  }
  return out;
};

// ════════════════════════════════════════════════════════════════
// What comes back
// ════════════════════════════════════════════════════════════════

/** The recorded outcome of one peer ask, as the resumed op-step reads it.
 *
 *  ⚠ `answered: false` IS A NORMAL OUTCOME, not an error — see
 *  {@link PEER_ASK_TIMEOUT_ACTIONS}. A recipe branches on it. */
export interface PeerAnswer {
  readonly answered: boolean;
  /** The chosen `AskOption.id`. Absent iff `answered === false`. */
  readonly option?: string;
  /** Free text the answerer added, when the surface offered it. */
  readonly note?: string;
  /** Unix ms the answer was recorded, or the timeout fired. */
  readonly at: number;
  /** Why there is no answer. Absent iff `answered === true`. */
  readonly unanswered_because?: PeerAskUnansweredReason;
}

/** ⛔⛔ FOUR WAYS TO HAVE NO ANSWER, AND THEY ARE NOT INTERCHANGEABLE. Collapsing
 *  them is the § 30 mistake (`unanswerable` vs `undeliverable`) one layer up:
 *  `timed_out` means ask again later, `declined` means they said no and asking
 *  again is rude, `not_exposed` means the capability was revoked and the asker's
 *  catalog is stale, `withdrawn` means WE gave up. A recipe branching on "no
 *  answer" without being able to see which of these it was cannot behave
 *  sensibly in any of the four cases. */
export const PEER_ASK_UNANSWERED_REASONS = [
  'timed_out',
  'declined',
  'not_exposed',
  'withdrawn',
] as const;
export type PeerAskUnansweredReason = (typeof PEER_ASK_UNANSWERED_REASONS)[number];

export const isPeerAskUnansweredReason = (v: unknown): v is PeerAskUnansweredReason =>
  typeof v === 'string'
  && (PEER_ASK_UNANSWERED_REASONS as readonly string[]).includes(v);

/** Validate an answer that arrived OFF THE WIRE.
 *
 *  ⛔⛔ NOT A CAST AND NOT A SPREAD — the same posture `parsePeerExchangeAck`
 *  takes, and for the same reason: every field here was written by another
 *  server. An `option` outside the set WE OFFERED is refused rather than passed
 *  through, because a peer that could name its own option would be choosing an
 *  outcome we never put in front of their owner. `offered` is therefore
 *  REQUIRED, not optional: an answer validated without it is validated against
 *  nothing. */
export const parsePeerAnswer = (
  raw: unknown,
  offered: readonly string[],
  now: number,
): PeerAnswer | undefined => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.answered !== 'boolean') return undefined;
  const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : now;
  if (r.answered === false) {
    return {
      answered: false,
      at,
      ...(isPeerAskUnansweredReason(r.unanswered_because)
        ? { unanswered_because: r.unanswered_because }
        : {}),
    };
  }
  const option = r.option;
  if (typeof option !== 'string' || !offered.includes(option)) return undefined;
  const note = typeof r.note === 'string' && r.note !== ''
    ? r.note.slice(0, PEER_ASK_QUESTION_MAX)
    : undefined;
  return {
    answered: true,
    option,
    at,
    ...(note !== undefined ? { note } : {}),
  };
};

// ════════════════════════════════════════════════════════════════
// The pause signal
// ════════════════════════════════════════════════════════════════

export const PEER_ANSWER_REQUIRED_SIGNAL_NAME = 'PeerAnswerRequiredSignal';

/** Raised by the `core.peer.ask` op when no answer is recorded yet. The engine's
 *  step loop catches it and ends the run with `awaiting_peer`, exactly as it
 *  does for {@link PreflightRequiredSignal}.
 *
 *  ⚠ MARKER ON THE INSTANCE, not only the prototype — same reason the preflight
 *  signal does it: the guard has to survive a stringify/reconstruct round trip
 *  across a worker boundary. */
export class PeerAnswerRequiredSignal extends Error {
  readonly name: string = PEER_ANSWER_REQUIRED_SIGNAL_NAME;
  /** Engine-authored only: exact progress when this signal crossed a foreach. */
  foreach_progress?: ForeachCheckpointProgress;
  readonly spec: PeerAskSpec;
  /** Deterministic conversation id, minted by the op from the run + step + spec.
   *  The reply is correlated back on this. */
  readonly exchange_ref: string;

  constructor(spec: PeerAskSpec, exchange_ref: string, message?: string) {
    super(message ?? `peer answer required for '${spec.label}' on '${spec.connection}'`);
    this.spec = spec;
    this.exchange_ref = exchange_ref;
  }
}

export const isPeerAnswerRequiredSignal = (
  e: unknown,
): e is PeerAnswerRequiredSignal =>
  e !== null
  && typeof e === 'object'
  && (e as { name?: unknown }).name === PEER_ANSWER_REQUIRED_SIGNAL_NAME
  && typeof (e as { exchange_ref?: unknown }).exchange_ref === 'string'
  && (e as { spec?: unknown }).spec !== null
  && typeof (e as { spec?: unknown }).spec === 'object';
