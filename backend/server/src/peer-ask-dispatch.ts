/** D-234 § 234.4 — THE ASKING OP: answer the step, or suspend the run.
 *
 *  🔑🔑 THE ENTIRE RESUME DESIGN IS THIS FUNCTION'S TWO BRANCHES. `execute.ts`
 *  already documents that a gated step RE-RUNS on resume, so:
 *
 *    answer recorded  → return it as the step's result, run continues
 *    no answer yet    → throw `PeerAnswerRequiredSignal`, run suspends
 *
 *  The engine therefore needs no answer-injection path, the checkpoint carries no
 *  answer slot, and a run can resume any number of times and always sees the same
 *  answer. It is the same shape § 234.1's admission ceiling uses — re-run, find
 *  the recorded decision — and the reason neither needed new engine machinery.
 *
 *  ⛔ THE REF IS DERIVED, NOT AUTHORED. A recipe naming its own conversation id
 *  could collide two live asks onto one answer, or (worse) name a ref belonging
 *  to someone else's conversation and read their reply. It is a hash of the
 *  run + step + the resolved spec, so re-running the same step in the same run
 *  reproduces it exactly — which is precisely what resume needs — and nothing
 *  else can reproduce it.
 */
import { createHash } from 'node:crypto';

import {
  PeerAnswerRequiredSignal,
  normalizePeerAskVia,
  validatePeerAskSpec,
  type PeerAnswer,
  type PeerAskOption,
  type PeerAskSpec,
  type PeerAskNotePrompt,
  type PeerAskVia,
} from '@recued/contracts';

import type { PeerAnswerStore } from './storage/peer-answer-store.js';

/** Deterministic conversation id for one (run, step, spec).
 *
 *  ⚠ THE RUN ID IS IN THE HASH ON PURPOSE. Two runs of the same dish asking the
 *  same question are two conversations — the second must not read the first's
 *  answer. Dropping `run_id` would make a review recipe answer itself from
 *  history the second time it is used.
 *
 *  ⚠ `via` IS DELIBERATELY NOT IN THE HASH. It names the ROAD, not the
 *  conversation: the same question carried by the other route is still the same
 *  question, and folding it in would mint a fresh ref for a re-delivery — the
 *  answer would land under a key the held run never looks under. `deliver_to`
 *  is out for the same reason: it names the destination, not the question.
 *
 *  🔑🔑 D-234 § 234.4p Step 2 — AND THIS HASH *IS* THE EVIDENCE BINDING. An
 *  authorization must be VOID if the evidence changed after it was given, and
 *  that is what a content-derived ref already does for every field in it: change
 *  one, and the resumed step looks under a DIFFERENT key, finds no answer, and
 *  asks again with the new content. Driven end-to-end in the two-server drive
 *  (8k6) — the record was edited while the run was held, the answer came home,
 *  and the run did not complete: it re-asked, carrying the changed evidence.
 *
 *  ⛔⛔ WHICH IS WHY `body` IS IN HERE NOW, AND ITS ABSENCE WAS THE WHOLE GAP.
 *  § 234.4f made `body` the DOCUMENT THE ANSWERER READS — it is the evidence by
 *  construction — and it was the one authored field this hash did not cover. So
 *  the one-line question bound the authorization and the four pages it was
 *  actually about did not: edit the transaction under a held authorization and
 *  the run resumed on it, green, with a decision made about different bytes.
 *
 *  ⚠ AND THE DESIGN THIS REPLACES DID NOT WORK. § 234.4p.2 specified the binding
 *  as a hash on `peer_ask_outbox`, compared at read time. `receiveAnswer` calls
 *  `outbox.close(ref)` BEFORE `resume(...)`, so there is no row left to compare
 *  against by then — 8k4 asserts exactly that, from the other side (a second
 *  answer comes back `not_solicited`). The property the owner specified is
 *  preserved; the store it was going to ride is not, because it cannot be.
 *
 *  ⚠ APPENDED ONLY WHEN PRESENT, and the conditional is a MIGRATION decision
 *  rather than a style one. `JSON.stringify` of a longer tuple is a different
 *  string, so an unconditional `spec.body ?? ''` would move the ref of EVERY
 *  in-flight ask on upgrade — including the vast majority that carry no body at
 *  all — and each would re-ask once for no reason. Appending only a present body
 *  leaves body-less conversations byte-identical, so the blast radius is exactly
 *  the runs whose semantics actually change. (`''` cannot reach here: the parser
 *  collapses it to absent, like every sibling on this boundary.)
 *
 *  ⚠ THE FOOTGUN, STATED WHERE THE MECHANISM IS. A body that legitimately churns
 *  — a rendered "as of 12:04", a volatile counter — re-asks on every change,
 *  which is correct by this rule and maddening in practice. That is an authoring
 *  concern, not a mechanism one: put the DECIDABLE evidence in `body`, not the
 *  page it was rendered on. */
export const peerAskExchangeRef = (
  run_id: string,
  step_id: string,
  spec: PeerAskSpec,
): string =>
  createHash('sha256')
    .update(JSON.stringify([
      'peer-ask',
      run_id,
      step_id,
      spec.connection,
      spec.label,
      spec.question,
      spec.options.map((o) => [o.id, o.label]),
      ...(spec.body !== undefined ? [spec.body] : []),
    ]))
    .digest('hex');

export interface PeerAskDispatchDeps {
  readonly answers: Pick<PeerAnswerStore, 'get'>;
  /** The identity of the run doing the asking — ENGINE-SUPPLIED via `StepMeta`,
   *  never authored.
   *
   *  ⛔⛔ A MISSING `run_id` IS A REFUSAL, NOT A DEFAULT. The ref is derived from
   *  it, and resume works only because re-running the same step in the same run
   *  reproduces the same ref. Substituting a placeholder would mint a ref the
   *  resumed run cannot reproduce: the answer lands under one key, the resumed
   *  step looks under another, and the run waits forever for a reply that already
   *  arrived — with nothing anywhere reporting a fault. Fail closed. */
  readonly run_id: string;
  readonly step_id: string;
}

/** Parse the authored args into a spec. Returns the failure text rather than
 *  throwing, so the caller decides whether it is a step error or a refusal. */
export const parsePeerAskArgs = (
  input: Record<string, unknown>,
): { spec: PeerAskSpec } | { error: string } => {
  const options = Array.isArray(input.options)
    ? (input.options as unknown[]).filter(
        (o): o is PeerAskOption =>
          o !== null && typeof o === 'object'
          && typeof (o as PeerAskOption).id === 'string'
          && typeof (o as PeerAskOption).label === 'string',
      )
    : [];
  const spec: PeerAskSpec = {
    connection: typeof input.connection === 'string' ? input.connection : '',
    label: typeof input.label === 'string' ? input.label : '',
    question: typeof input.question === 'string' ? input.question : '',
    options,
    ...(typeof input.deadline_at === 'number' ? { deadline_at: input.deadline_at } : {}),
    // ⚠ DEFAULTS TO `wait`, NOT `stop`. `stop` without a deadline is an authoring
    // error the validator refuses (a timeout that can never fire), so defaulting
    // to it would make every un-annotated ask invalid. `wait` is also the honest
    // default: with no deadline declared, nothing has been promised to anyone.
    on_timeout: input.on_timeout === 'stop' ? 'stop' : 'wait',
    // ⛔ ABSENT ⇒ `direct`; PRESENT-AND-WRONG ⇒ REFUSED, and the asymmetry with
    // `on_timeout` right above is deliberate. `wait` is an honest reading of
    // silence about a deadline; there is no honest reading of `via: 'dircet'`.
    // The two routes place DIFFERENT obligations on the receiver, so coercing a
    // typo would send the question down a road the author did not choose and
    // fail at the far end — see `validatePeerAskSpec`'s `via_unknown`.
    //
    // ⛔⛔ `null` IS ABSENT, AND `=== undefined` ALONE WAS WRONG. A kernel
    // manifest spells an unset input `null` (`peer-ask`'s `"via": null`), and
    // `mergeManifestStepInput` lays those defaults UNDER the step's args — so an
    // author who says nothing arrives here with `via: null`, not with no key at
    // all. The first cut refused every un-annotated ask with `via_unknown`.
    // ⚠ The unit tests could not see it: each hand-builds the input object and
    // therefore never crosses the manifest merge. The live drive found it on the
    // first run. Every sibling field above already treats `null` as unset —
    // `typeof x === 'string'`, `=== 'stop'`, `typeof x === 'number'`.
    //
    // ⛔⛔ AND `''` IS ABSENT TOO — THE THIRD SPELLING, found the same way. An
    // UNSET `{{config.*}}` picker resolves to the EMPTY STRING, not undefined
    // (§ 28's `!== ''` lesson, which this arc has now paid for twice). So the
    // moment either field is exposed as a recipe variable, a blank one arrives
    // here as `''` — and treating that as present-and-unknown would refuse every
    // ask whose author left the picker alone. Unset has three spellings on this
    // boundary: `undefined` (no key), `null` (manifest default), `''` (blank
    // picker). All three mean the same thing and all three must.
    //
    // ⛔⛔ THE THREE-SPELLINGS RULE NOW LIVES IN CONTRACTS, NOT HERE — beside
    // the type it coerces to, so the next reader finds it with `PeerAskVia`
    // rather than re-deriving it. `?? input.via` preserves a present-and-unknown value
    // VERBATIM so `validatePeerAskSpec` can still name it `via_unknown` —
    // normalizing it to a default here is the coercion the error exists to
    // prevent.
    via: (normalizePeerAskVia(input.via) ?? input.via) as PeerAskVia,
    // D-234 § 234.4e — ABSENT is valid and common (most asks want no prose), so
    // only a PRESENT-and-unknown value is refused. ⚠ `null` is absent here too:
    // the manifest default, the same trap `via` above was built wrong for once.
    ...(input.note_prompt === undefined || input.note_prompt === null
      || input.note_prompt === ''
      ? {}
      : { note_prompt: input.note_prompt as PeerAskNotePrompt }),
    // D-234 § 234.4f — the document. `''` is absent here for the same reason as
    // every sibling: an unset `{{config.*}}` picker resolves to the empty string.
    ...(typeof input.body === 'string' && input.body !== ''
      ? { body: input.body }
      : {}),
    // D-234 § 234.4p Step 1 — the destination. ABSENT ⇒ the native ask door,
    // supplied by the caller that actually knows its name (contracts may not
    // import the server, and `PEER_RECEIVE_ASK_TOOL` lives there).
    //
    // ⛔⛔ ALL THREE SPELLINGS OF UNSET, and this field is the one most likely to
    // arrive as `''`: it is the natural thing to expose as `"deliver_to":
    // "{{config.deliver_to}}"` on a shipped recipe, and an unset picker resolves
    // to the EMPTY STRING. Treating that as PRESENT would pair a destination
    // nothing installed with the validator's route rule and refuse every ordinary
    // ask in the marketplace — § 28's `!== ''` lesson, which the drive's own 8k2
    // comment predicted for exactly this shape of field.
    // ⚠ Unlike `via`, a present-and-unreadable value is NOT preserved for the
    // validator to name: there is no vocabulary to be wrong about. A non-string
    // is unset, and a string naming nothing installed is refused later by
    // `resolveExchangeFireTarget`, which can say WHICH bindings exist — a better
    // message than anything this parser could produce.
    ...(typeof input.deliver_to === 'string' && input.deliver_to !== ''
      ? { deliver_to: input.deliver_to }
      : {}),
  };
  const issues = validatePeerAskSpec(spec);
  if (issues.length > 0) {
    return { error: `core.peer.ask: ${issues.join(', ')}` };
  }
  return { spec };
};

/** The dispatcher behind `core.peer.ask`. Either returns the answer or throws to
 *  pause. */
export const dispatchPeerAsk = (
  input: Record<string, unknown>,
  deps: PeerAskDispatchDeps,
): PeerAnswer => {
  if (deps.run_id === '' || deps.step_id === '') {
    throw new Error(
      'core.peer.ask: no run identity on this call — the conversation ref is '
        + 'derived from it, and one minted without it could never be reproduced '
        + 'on resume. This op runs only on the engine path.',
    );
  }
  const parsed = parsePeerAskArgs(input);
  if ('error' in parsed) throw new Error(parsed.error);
  const { spec } = parsed;

  const ref = peerAskExchangeRef(deps.run_id, deps.step_id, spec);
  const recorded = deps.answers.get(ref);
  if (recorded !== null) {
    // ⚠ PROJECTED, NOT SPREAD. The stored row carries `exchange_ref` and
    // `peer_contract_id` — correlation this side owns, not part of the answer a
    // recipe reads. Spreading would put them in `{{step.<id>}}` and make them
    // look like fields the peer supplied.
    return {
      answered: recorded.answered,
      at: recorded.at,
      ...(recorded.option !== undefined ? { option: recorded.option } : {}),
      ...(recorded.note !== undefined ? { note: recorded.note } : {}),
      ...(recorded.unanswered_because !== undefined
        ? { unanswered_because: recorded.unanswered_because }
        : {}),
    };
  }
  throw new PeerAnswerRequiredSignal(spec, ref);
};
