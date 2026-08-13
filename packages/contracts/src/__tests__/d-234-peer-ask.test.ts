/** D-234 § 234.4 — the remote-hold vocabulary.
 *
 *  Slice 1 is contracts only: the spec a `core.peer.ask` op-step declares, the
 *  answer that comes back off the wire, the receiver's exposure record, the
 *  pause signal, and the held-status predicate that the 54-site sweep hangs on.
 *  Nothing suspends a run yet. */
import { describe, expect, it } from 'vitest';

import {
  PEER_ASK_OPTIONS_MAX,
  PEER_ASK_QUESTION_MAX,
  PEER_ASK_TIMEOUT_ACTIONS,
  PEER_ASK_UNANSWERED_REASONS,
  PEER_ASK_VIA,
  PeerAnswerRequiredSignal,
  isPeerAnswerRequiredSignal,
  parsePeerAnswer,
  validatePeerAskSpec,
  type PeerAskSpec,
  type PeerAskVia,
} from '../peer-ask.js';
import {
  RUN_ANCHOR_STATUSES,
  isHeldRunAnchorStatus,
} from '../commits.js';

const spec = (over: Partial<PeerAskSpec> = {}): PeerAskSpec => ({
  connection: 'peer-bob',
  label: 'review:contract',
  question: 'Does the Friday deadline read as too firm?',
  options: [
    { id: 'approved', label: 'Approve' },
    { id: 'rejected', label: 'Reject' },
  ],
  on_timeout: 'wait',
  via: 'direct',
  ...over,
});

describe('§ 234.4 — the ask spec', () => {
  it('accepts the shipping shape', () => {
    expect(validatePeerAskSpec(spec())).toEqual([]);
    expect(validatePeerAskSpec(spec({ on_timeout: 'stop', deadline_at: 1 }))).toEqual([]);
  });

  it('refuses `stop` with no deadline — a timeout that can never fire', () => {
    // ⛔ THE SILENT ONE. The author believes they bounded the wait. They did not,
    // and nothing at runtime would ever tell them: the run simply waits forever
    // while the recipe says it has a timeout policy.
    expect(validatePeerAskSpec(spec({ on_timeout: 'stop' })))
      .toContain('stop_without_deadline');
  });

  it('refuses a deadline with `wait` — a deadline shown to the receiver is a promise', () => {
    // Telling them Friday and then waiting forever anyway makes the date on
    // their card a lie, and they are the one who budgeted time around it.
    expect(validatePeerAskSpec(spec({ on_timeout: 'wait', deadline_at: 1 })))
      .toContain('deadline_without_stop');
  });

  it('reports EVERY problem, not the first', () => {
    // An author fixing one error per run is an author who stops reading.
    const issues = validatePeerAskSpec(spec({
      connection: '', label: '', question: '', options: [],
    }));
    expect(issues.sort()).toEqual(
      ['connection_missing', 'label_missing', 'options_missing', 'question_missing'].sort(),
    );
  });

  it('bounds the option set and the question', () => {
    expect(validatePeerAskSpec(spec({
      options: Array.from({ length: PEER_ASK_OPTIONS_MAX + 1 }, (_, i) => ({
        id: `o${i}`, label: `O${i}`,
      })),
    }))).toContain('options_too_many');
    expect(validatePeerAskSpec(spec({ question: 'x'.repeat(PEER_ASK_QUESTION_MAX + 1) })))
      .toContain('question_too_long');
  });

  it('refuses duplicate option ids — the answer would be ambiguous', () => {
    expect(validatePeerAskSpec(spec({
      options: [{ id: 'yes', label: 'Approve' }, { id: 'yes', label: 'Reject' }],
    }))).toContain('option_duplicate');
  });

  it('§ 234.4a — takes both routes and REFUSES a third', () => {
    // ⛔ THE TYPO IS THE CASE WORTH HAVING. The two routes place different
    // obligations on the RECEIVER — `direct` needs the native door granted,
    // `recipe` needs a per-pairing recipe grant — so a coerced `via` fails at
    // the far end, where nothing on this side is watching. Refuse here instead.
    for (const via of PEER_ASK_VIA) {
      expect(validatePeerAskSpec(spec({ via }))).toEqual([]);
    }
    expect(validatePeerAskSpec(spec({ via: 'dircet' as PeerAskVia })))
      .toContain('via_unknown');
    expect(validatePeerAskSpec(spec({ via: undefined as unknown as PeerAskVia })))
      .toContain('via_unknown');
  });

  it('§ 234.4p Step 1 — a destination REQUIRES the carrier route', () => {
    // 🔑 THE RULE, AND WHY IT IS A REFUSAL RATHER THAN A NO-OP. `recipe`
    // resolves `deliver_to` against our OWN installed manifests, so it can only
    // ever name an operation the owner installed. `direct` calls the tool name
    // as a literal with no catalog step — honouring one there would let an
    // author name any tool on someone else's server, checked by nothing.
    expect(validatePeerAskSpec(spec({
      via: 'recipe', deliver_to: 'recued-core/peer-authorize-continuation',
    }))).toEqual([]);
    expect(validatePeerAskSpec(spec({
      via: 'direct', deliver_to: 'recued-core/peer-authorize-continuation',
    }))).toContain('deliver_to_needs_recipe_route');
    // ⛔ AND THE ORDINARY ASK IS UNTOUCHED ON BOTH ROADS — the assertion that
    // fails if the rule is ever written as "direct may not carry a destination"
    // in a way that reads an ABSENT field as present. Every ask that existed
    // before this field has `deliver_to: undefined` on the direct road, so a
    // rule keyed on anything looser than `!== undefined` refuses all of them.
    expect(validatePeerAskSpec(spec({ via: 'direct' }))).toEqual([]);
    expect(validatePeerAskSpec(spec({ via: 'recipe' }))).toEqual([]);
  });
});

describe('§ 234.4 — an answer arriving off the wire', () => {
  const offered = ['approved', 'rejected'];

  it('accepts an offered option', () => {
    expect(parsePeerAnswer({ answered: true, option: 'approved', at: 5 }, offered, 9))
      .toEqual({ answered: true, option: 'approved', at: 5 });
  });

  it('⛔ REFUSES AN OPTION WE NEVER OFFERED', () => {
    // The peer wrote this. An option outside the set their owner was actually
    // shown is an outcome nobody chose — the far side selecting a branch of OUR
    // recipe. Same posture `parsePeerExchangeAck` takes on `kind`.
    expect(parsePeerAnswer({ answered: true, option: 'approve_and_send', at: 5 }, offered, 9))
      .toBeUndefined();
    expect(parsePeerAnswer({ answered: true, option: '', at: 5 }, offered, 9))
      .toBeUndefined();
  });

  it('carries a no-answer with its reason, and drops a reason it does not know', () => {
    expect(parsePeerAnswer({ answered: false, unanswered_because: 'declined', at: 2 }, offered, 9))
      .toEqual({ answered: false, unanswered_because: 'declined', at: 2 });
    // An invented reason is DROPPED, not passed through — a peer must not be
    // able to put a value this side branches on into our vocabulary.
    expect(parsePeerAnswer({ answered: false, unanswered_because: 'bored', at: 2 }, offered, 9))
      .toEqual({ answered: false, at: 2 });
  });

  it('keeps the four no-answer reasons distinct', () => {
    // Collapsing them is the § 30 mistake one layer up: ask-again-later,
    // they-said-no, capability-revoked and we-gave-up need different behaviour.
    expect([...PEER_ASK_UNANSWERED_REASONS].sort())
      .toEqual(['declined', 'not_exposed', 'timed_out', 'withdrawn']);
  });

  it('is not a cast — a non-object or a missing `answered` is undefined', () => {
    for (const junk of [null, undefined, 'ok', 42, [], { option: 'approved' }]) {
      expect(parsePeerAnswer(junk, offered, 9)).toBeUndefined();
    }
  });

  it('falls back to `now` for a missing or non-finite timestamp', () => {
    expect(parsePeerAnswer({ answered: true, option: 'approved' }, offered, 9)?.at).toBe(9);
    expect(parsePeerAnswer({ answered: true, option: 'approved', at: NaN }, offered, 9)?.at)
      .toBe(9);
  });
});

describe('§ 234.4 — the pause signal', () => {
  it('is recognised by its instance marker', () => {
    const sig = new PeerAnswerRequiredSignal(spec(), 'ref_1');
    expect(isPeerAnswerRequiredSignal(sig)).toBe(true);
    expect(sig.exchange_ref).toBe('ref_1');
  });

  it('survives a structured-clone round trip', () => {
    // ⚠ Same reason `PreflightRequiredSignal` binds its marker on the INSTANCE:
    // the guard has to hold across a worker boundary, where the prototype does
    // not travel.
    const sig = new PeerAnswerRequiredSignal(spec(), 'ref_1');
    const clone = { name: sig.name, spec: sig.spec, exchange_ref: sig.exchange_ref };
    expect(isPeerAnswerRequiredSignal(clone)).toBe(true);
  });

  it('does not recognise a bare Error or a lookalike missing the ref', () => {
    expect(isPeerAnswerRequiredSignal(new Error('nope'))).toBe(false);
    expect(isPeerAnswerRequiredSignal({ name: 'PeerAnswerRequiredSignal' })).toBe(false);
  });
});

describe('§ 234.4 — the held-status predicate', () => {
  it('covers BOTH holds', () => {
    expect(isHeldRunAnchorStatus('awaiting_approval')).toBe(true);
    expect(isHeldRunAnchorStatus('awaiting_peer')).toBe(true);
  });

  it('⛔ is exactly the statuses that leave a live checkpoint', () => {
    const held = RUN_ANCHOR_STATUSES.filter((s) => isHeldRunAnchorStatus(s));
    expect([...held].sort()).toEqual(['awaiting_approval', 'awaiting_peer']);
  });

  it('⛔⛔ REDDENS ON ANY NEW RUN-ANCHOR STATUS, held or not', () => {
    // THE RATCHET, AND THE FIRST VERSION OF IT POINTED THE WRONG WAY. Filtering
    // the status list by the predicate and asserting the result catches someone
    // WIDENING the predicate — the harmless direction. The DANGEROUS direction is
    // a new hold added to the status list and NOT to the predicate: the filter is
    // then unchanged, the assertion passes, and `checkpoint-retention.ts` quietly
    // deletes that hold's checkpoints as crash residue after the grace period.
    //
    // ⇒ A COUNT ratchet catches both, because it does not care which way the
    // change went — it only insists somebody looked. Bump this deliberately and
    // answer the question in `isHeldRunAnchorStatus`: does the new status leave a
    // live checkpoint behind?
    expect(RUN_ANCHOR_STATUSES.length).toBe(9);
    // Belt and braces on the naming convention every hold has followed so far.
    for (const s of RUN_ANCHOR_STATUSES) {
      if (s.startsWith('awaiting')) expect(isHeldRunAnchorStatus(s)).toBe(true);
    }
  });

  it('is false for every terminal status and for junk', () => {
    for (const s of ['succeeded', 'failed', 'cancelled', 'killed', 'in_doubt',
                     'pending', 'running', '', null, undefined, 7]) {
      expect(isHeldRunAnchorStatus(s)).toBe(false);
    }
  });
});

describe('§ 234.4 — the timeout vocabulary', () => {
  it('has exactly two actions, neither of which is a failure', () => {
    // ⛔ NO `fail`. A timeout that killed the run would make "they did not
    // answer" an error, when it is an outcome the recipe should branch on.
    expect([...PEER_ASK_TIMEOUT_ACTIONS]).toEqual(['stop', 'wait']);
  });
});
