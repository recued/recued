/** D-234 § 234.4 slice 5 — the second checkpoint mint point.
 *
 *  The claim this file exists to prove: a peer answer is an approval hold whose
 *  answerer is elsewhere, so the engine can pause on a peer-ask step using the
 *  SAME substrate — and resume needs no new mechanism, because the gated step
 *  re-runs and finds the recorded answer.
 *
 *  ⚠ Two halves, deliberately separate: the DISPATCHER's two branches (unit), and
 *  the ENGINE actually turning the raised signal into `awaiting_peer` (the seam
 *  that would otherwise be built-and-unreachable). */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  isPeerAnswerRequiredSignal,
  type PeerAnswer,
} from '@recued/contracts';

import {
  dispatchPeerAsk,
  parsePeerAskArgs,
  peerAskExchangeRef,
} from '../peer-ask-dispatch.js';
import { createPeerAnswerStore } from '../storage/peer-answer-store.js';

const args = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  connection: 'peer-bob',
  label: 'review:contract',
  question: 'Does the Friday deadline read as too firm?',
  options: [{ id: 'approved', label: 'Approve' }, { id: 'rejected', label: 'Reject' }],
  ...over,
});

const deps = (db = new Database(':memory:')) => ({
  answers: createPeerAnswerStore(db),
  run_id: 'run_1',
  step_id: 'verdict',
});

describe('§ 234.4 — the dispatcher\'s two branches', () => {
  it('SUSPENDS when nothing has answered yet', () => {
    try {
      dispatchPeerAsk(args(), deps());
      expect.unreachable('should have raised the pause signal');
    } catch (e) {
      expect(isPeerAnswerRequiredSignal(e)).toBe(true);
    }
  });

  it('RETURNS the recorded answer instead of pausing again', () => {
    // ⛔ THE WHOLE RESUME DESIGN. The gated step re-runs on resume; this branch is
    // what makes the second run continue rather than suspend forever.
    const d = deps();
    const ref = peerAskExchangeRef('run_1', 'verdict', (() => {
      const p = parsePeerAskArgs(args());
      if ('error' in p) throw new Error(p.error);
      return p.spec;
    })());
    d.answers.record({
      exchange_ref: ref, peer_contract_id: 'ctr_bob',
      answered: true, option: 'rejected', note: 'Friday is too firm', at: 42,
    });

    const out = dispatchPeerAsk(args(), d) as PeerAnswer;
    expect(out).toEqual({
      answered: true, option: 'rejected', note: 'Friday is too firm', at: 42,
    });
  });

  it('⛔ PROJECTS the answer — correlation fields never reach {{step.*}}', () => {
    // `exchange_ref` / `peer_contract_id` are this side's bookkeeping. Spreading
    // the stored row would put them in the step output where they read as fields
    // the peer supplied.
    const d = deps();
    const p = parsePeerAskArgs(args());
    if ('error' in p) throw new Error(p.error);
    d.answers.record({
      exchange_ref: peerAskExchangeRef('run_1', 'verdict', p.spec),
      peer_contract_id: 'ctr_bob', answered: false,
      unanswered_because: 'timed_out', at: 7,
    });

    const out = dispatchPeerAsk(args(), d) as unknown as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['answered', 'at', 'unanswered_because']);
  });

  it('an un-answered outcome is a RESULT, not a throw', () => {
    // `answered: false` is an ordinary branch for the recipe, which is the whole
    // point of resume-on-timeout: the deadline is a branch, not an error path.
    const d = deps();
    const p = parsePeerAskArgs(args());
    if ('error' in p) throw new Error(p.error);
    d.answers.record({
      exchange_ref: peerAskExchangeRef('run_1', 'verdict', p.spec),
      peer_contract_id: 'ctr_bob', answered: false,
      unanswered_because: 'declined', at: 9,
    });
    expect(() => dispatchPeerAsk(args(), d)).not.toThrow();
  });
});

describe('§ 234.4 — the derived exchange ref', () => {
  const spec = () => {
    const p = parsePeerAskArgs(args());
    if ('error' in p) throw new Error(p.error);
    return p.spec;
  };

  it('is reproducible for the same run + step + spec — this is what resume needs', () => {
    expect(peerAskExchangeRef('run_1', 'verdict', spec()))
      .toBe(peerAskExchangeRef('run_1', 'verdict', spec()));
  });

  it('⛔⛔ DIFFERS PER RUN — a second run must not read the first run\'s answer', () => {
    // Dropping `run_id` from the hash would make a review recipe answer itself
    // from history the second time it is used: same dish, same question, same
    // ref, and the peer never sees it at all.
    expect(peerAskExchangeRef('run_2', 'verdict', spec()))
      .not.toBe(peerAskExchangeRef('run_1', 'verdict', spec()));
  });

  it('differs per step and per question', () => {
    expect(peerAskExchangeRef('run_1', 'other', spec()))
      .not.toBe(peerAskExchangeRef('run_1', 'verdict', spec()));
    const p = parsePeerAskArgs(args({ question: 'A different question?' }));
    if ('error' in p) throw new Error(p.error);
    expect(peerAskExchangeRef('run_1', 'verdict', p.spec))
      .not.toBe(peerAskExchangeRef('run_1', 'verdict', spec()));
  });

  it('⛔⛔ § 234.4p Step 2 — THE EVIDENCE BINDS: a changed `body` is a different ref', () => {
    // 🔑 THIS HASH *IS* THE EVIDENCE BINDING. An authorization must be void when
    // what it authorized changed, and a content-derived ref delivers exactly
    // that: the resumed step looks under a different key, finds no answer, and
    // asks again with the new evidence.
    // ⛔ `body` WAS THE ONE AUTHORED FIELD MISSING FROM IT. § 234.4f makes it the
    // DOCUMENT THE ANSWERER READS — the evidence by construction — so before
    // this the one-line question bound the decision and the four pages it was
    // actually about did not.
    const withBody = (body: string) => {
      const p = parsePeerAskArgs(args({ body }));
      if ('error' in p) throw new Error(p.error);
      return peerAskExchangeRef('run_1', 'verdict', p.spec);
    };
    expect(withBody('TRANSACTION: £4,000 to ACME'))
      .toBe(withBody('TRANSACTION: £4,000 to ACME'));
    expect(withBody('TRANSACTION: £40,000 to ACME'))
      .not.toBe(withBody('TRANSACTION: £4,000 to ACME'));
  });

  it('⚠ § 234.4p Step 2 — a body-LESS ask keeps the ref it already had', () => {
    // ⛔⛔ A MIGRATION ASSERTION, NOT A STYLE ONE. `JSON.stringify` of a longer
    // tuple is a different string, so an unconditional `spec.body ?? ''` would
    // move the ref of EVERY in-flight ask on upgrade — including the vast
    // majority that carry no body — and each would re-ask once for nothing.
    // Appending only a PRESENT body keeps those conversations byte-identical, so
    // the blast radius is exactly the runs whose semantics actually change.
    // ⚠ The literal is pinned rather than derived: a test that recomputes the
    // hash the same way the implementation does would agree with any change to
    // it, which is the whole failure mode this guards.
    expect(peerAskExchangeRef('run_1', 'verdict', spec()))
      .toBe('593489b31cff11f613b690c87d3c1fa0927f690e3fcd4d7c4ac0c10339d2edb7');
  });

  it('⚠ and an EMPTY body is not a body — the parser collapses it, so the ref holds', () => {
    // The third spelling of unset on this boundary. If `''` reached the hash as
    // a present value it would fork the ref of every ask whose author left a
    // `{{config.body}}` picker blank — silently, and only for them.
    const blank = parsePeerAskArgs(args({ body: '' }));
    if ('error' in blank) throw new Error(blank.error);
    expect(peerAskExchangeRef('run_1', 'verdict', blank.spec))
      .toBe(peerAskExchangeRef('run_1', 'verdict', spec()));
  });
});

describe('§ 234.4 — authored args', () => {
  it('defaults on_timeout to `wait`, not `stop`', () => {
    // `stop` with no deadline is a timeout that can never fire — the validator
    // refuses it — so defaulting to `stop` would make every un-annotated ask
    // invalid. `wait` is also honest: with no deadline, nothing was promised.
    const p = parsePeerAskArgs(args());
    expect('error' in p ? p.error : p.spec.on_timeout).toBe('wait');
  });

  it('rejects `stop` without a deadline, and a deadline with `wait`', () => {
    expect(parsePeerAskArgs(args({ on_timeout: 'stop' })))
      .toMatchObject({ error: expect.stringContaining('stop_without_deadline') });
    expect(parsePeerAskArgs(args({ deadline_at: 1 })))
      .toMatchObject({ error: expect.stringContaining('deadline_without_stop') });
  });

  it('reports missing fields rather than raising a pause on nonsense', () => {
    expect(parsePeerAskArgs({})).toMatchObject({ error: expect.stringContaining('connection_missing') });
  });

  it('§ 234.4a — defaults `via` to `direct`, and REFUSES a typo rather than coercing it', () => {
    // ⛔ THE ASYMMETRY WITH `on_timeout` ABOVE IS THE POINT. `wait` is an honest
    // reading of silence about a deadline; there is no honest reading of
    // `via: 'dircet'`. The two routes have different receiver obligations, so a
    // coerced value fails at the FAR end where nothing here is watching.
    const p = parsePeerAskArgs(args());
    expect('error' in p ? p.error : p.spec.via).toBe('direct');
    const r = parsePeerAskArgs(args({ via: 'recipe' }));
    expect('error' in r ? r.error : r.spec.via).toBe('recipe');
    expect(parsePeerAskArgs(args({ via: 'dircet' })))
      .toMatchObject({ error: expect.stringContaining('via_unknown') });
  });

  it('⛔⛔ `null` IS ABSENT — the shape the MANIFEST MERGE actually delivers', () => {
    // THE CASE EVERY OTHER TEST IN THIS FILE IS BLIND TO, and the live drive
    // found it on its first run. A kernel manifest spells an unset input `null`
    // (`peer-ask`'s `"via": null`) and `mergeManifestStepInput` lays those
    // defaults UNDER the step's args — so an author who writes no `via` reaches
    // the parser with `via: null`, never with the key missing. Checking only
    // `=== undefined` refused every un-annotated ask with `via_unknown`.
    //
    // ⚠ Each helper here HAND-BUILDS the input and so never crosses that merge.
    // This case exists to stand in for it; it is not a duplicate of the default
    // above, it is the only one that matches production input.
    const p = parsePeerAskArgs(args({ via: null }));
    expect('error' in p ? p.error : p.spec.via).toBe('direct');
    // …and the same for every sibling the manifest also defaults to `null`.
    const q = parsePeerAskArgs(args({ on_timeout: null, deadline_at: null }));
    expect('error' in q ? q.error : q.spec.on_timeout).toBe('wait');
    expect('error' in q ? q.error : q.spec.deadline_at).toBeUndefined();
  });

  it('§ 234.4p Step 1 — `deliver_to` reaches the spec, and ALL THREE spellings of unset do not', () => {
    // 🔑 THE THREE SPELLINGS ARE NOT A STYLE POINT ON THIS BOUNDARY — each one
    // has cost this arc a live defect, and `deliver_to` is the field most
    // exposed to the third. It is the natural thing to publish as
    // `"deliver_to": "{{config.deliver_to}}"` on a shipped recipe, and an UNSET
    // picker resolves to the EMPTY STRING rather than to undefined (§ 28).
    // ⛔ Read `deliver_to_needs_recipe_route` in the expectations below as the
    // blast radius: a `''` treated as PRESENT pairs a destination nothing
    // installed with the route rule, and every ordinary `direct` ask in the
    // marketplace is refused at authoring time.
    const set = parsePeerAskArgs(args({ via: 'recipe', deliver_to: 'recued-core/land-it' }));
    expect('error' in set ? set.error : set.spec.deliver_to).toBe('recued-core/land-it');
    for (const unset of [undefined, null, '']) {
      const p = parsePeerAskArgs(args({ deliver_to: unset }));
      expect('error' in p ? p.error : p.spec.deliver_to,
             `deliver_to: ${JSON.stringify(unset)} must be ABSENT, not present`).toBeUndefined();
      // …and the ordinary direct ask that carries it still validates.
      expect('error' in p, `deliver_to: ${JSON.stringify(unset)} refused an ordinary ask`)
        .toBe(false);
    }
    // ⚠ A NON-STRING IS UNSET TOO, deliberately: there is no vocabulary here to
    // be wrong about, so unlike `via` there is nothing for the validator to name.
    // A string naming nothing installed is refused later by
    // `resolveExchangeFireTarget`, which can list what DOES exist.
    const n = parsePeerAskArgs(args({ deliver_to: 42 }));
    expect('error' in n ? n.error : n.spec.deliver_to).toBeUndefined();
  });

  it('⛔ § 234.4p Step 1 — a destination on the DIRECT road is refused, not ignored', () => {
    // The parser does not enforce this; `validatePeerAskSpec` does, and this
    // asserts the two are actually joined — a rule in contracts that the
    // backend parser never runs is a rule that does not exist.
    expect(parsePeerAskArgs(args({ via: 'direct', deliver_to: 'recued-core/land-it' })))
      .toMatchObject({ error: expect.stringContaining('deliver_to_needs_recipe_route') });
  });
});

describe('§ 234.4 — the answer store is NOT single-use', () => {
  it('returns the same answer to every resume', () => {
    // ⛔ THE OPPOSITE OF `peer_admission_decisions`, ON PURPOSE. An admission is
    // consumed because admitting correspondence is a per-message judgment. An
    // ANSWER is a fact: a run may resume more than once (a later step gates, a
    // crash re-instantiates), and each re-run of the peer-ask step must see the
    // same reply. Consuming it would make the second resume wait forever for a
    // reply that already came — a hang with no error anywhere.
    const d = deps();
    const p = parsePeerAskArgs(args());
    if ('error' in p) throw new Error(p.error);
    d.answers.record({
      exchange_ref: peerAskExchangeRef('run_1', 'verdict', p.spec),
      peer_contract_id: 'ctr_bob', answered: true, option: 'approved', at: 1,
    });

    expect(dispatchPeerAsk(args(), d)).toEqual(dispatchPeerAsk(args(), d));
    expect(dispatchPeerAsk(args(), d)).toEqual({ answered: true, option: 'approved', at: 1 });
  });

  it('first write wins — a peer cannot change its mind after the fact', () => {
    const s = createPeerAnswerStore(new Database(':memory:'));
    expect(s.record({ exchange_ref: 'r', peer_contract_id: 'c',
                      answered: true, option: 'approved', at: 1 })).toBe(true);
    expect(s.record({ exchange_ref: 'r', peer_contract_id: 'c',
                      answered: true, option: 'rejected', at: 2 })).toBe(false);
    expect(s.get('r')?.option).toBe('approved');
  });
});

/** ⛔⛔ THE SEAM. Everything above proves the DISPATCHER raises and returns; none
 *  of it proves the ENGINE does anything with the signal. That gap is the exact
 *  shape of the four things D-232 built, typed, tested and left unreachable in
 *  one session, all green — and of D-231's resolver that passed six tests while
 *  nothing wired it. A pause signal nobody catches does not pause a run: it fails
 *  it, with an opaque error, which presents as a crash rather than a hold.
 *
 *  Two links have to hold: `step-runner` must RE-THROW rather than capture the
 *  signal into `StepLog.error`, and the step loop must turn it into
 *  `awaiting_peer`. This drives a real recipe through the real engine. */
describe('§ 234.4 — the ENGINE pauses on a peer-ask step', () => {
  const recipe = {
    recipe_id: 'peer-ask-pause-fixture',
    version: 1,
    ttl: 0,
    metadata: { name: 'fixture', description: 'x', author: 'test',
                supported_platforms: [], tags: [] },
    variables: {},
    prefetch_steps: [],
    steps: [
      { id: 'before', transform: 'template', template: 'ran first' },
      { id: 'verdict', op: 'core.peer.ask', args: {
        connection: 'peer-bob',
        label: 'review:contract',
        question: 'Does the Friday deadline read as too firm?',
        options: [{ id: 'approved', label: 'Approve' }, { id: 'rejected', label: 'Reject' }],
      } },
      { id: 'after', transform: 'template', template: 'must not run' },
    ],
    output: { render: [{ type: 'text', source: 'step.after' }] },
  };

  const runEngine = async (answers: ReturnType<typeof createPeerAnswerStore>) => {
    const { executeRecipe } = await import('@recued/engine');
    const { lowerOpStepRecipe } = await import('@recued/recipes');
    const { createKernelAdapter } = await import('@recued/ingredients');
    const adapter = createKernelAdapter({
      // ⚠ `dispatchPeerAsk` THROWS to pause — that is the whole point, and the
      // adapter must let it through rather than turning it into an ingredient
      // error. Awaiting it here is what carries the rejection out.
      peerAsk: async (input) => dispatchPeerAsk(input, {
        answers, run_id: 'run_1', step_id: 'verdict',
      }),
    });
    // ⚠ `op:` STEPS MUST BE LOWERED FIRST. The engine runs ingredient calls, not
    // op ids; `lowerOpStepRecipe` is what turns `core.peer.ask` into its backing
    // slug. Skipping it is why the first cut never reached the dispatcher at all.
    return executeRecipe({
      recipe: lowerOpStepRecipe(recipe as never, [] as never),
      stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
      // ⚠ `IngredientExecutor` IS `(slug, input) => …`, NOT `(call) => …`. The
      // first cut handed the adapter one object and it read `undefined.slug`,
      // which surfaced as a NETWORK_ERROR on the step — a pause signal turning
      // into an unrelated-looking failure, which is exactly the shape this file
      // exists to prevent.
      ingredientExecutor: async (slug: string, input: Record<string, unknown>) =>
        adapter({ slug, input } as never),
    } as never);
  };

  it('ends the run with awaiting_peer, and the LATER step does not run', async () => {
    const result = await runEngine(createPeerAnswerStore(new Database(':memory:')));

    expect(result.awaiting_peer).toBeDefined();
    expect(result.awaiting_peer?.gated_step_id).toBe('verdict');
    expect(result.success).toBe(false);
    // ⚠ A PAUSE IS NOT A FAILURE: empty `errors` is what lets a consumer tell
    // them apart, and it is why `awaiting_peer` must be checked before `success`.
    expect(result.errors).toEqual([]);
    // The step after the gate must not have run — a hold that let the rest of the
    // recipe proceed would be no hold at all.
    expect(result.awaiting_peer?.step_state).not.toHaveProperty('after');
  });

  it('snapshots the work done BEFORE the gate, so resume does not repeat it', async () => {
    const result = await runEngine(createPeerAnswerStore(new Database(':memory:')));
    expect(result.awaiting_peer?.step_state).toHaveProperty('before');
  });

  it('carries the ref and the spec the host needs to deliver', async () => {
    const result = await runEngine(createPeerAnswerStore(new Database(':memory:')));
    expect(result.awaiting_peer?.exchange_ref).toMatch(/^[0-9a-f]{64}$/);
    expect(result.awaiting_peer?.spec.label).toBe('review:contract');
    expect(result.awaiting_peer?.spec.connection).toBe('peer-bob');
  });

  it('⛔ and RUNS TO COMPLETION once the answer is recorded', async () => {
    // The resume path, end to end through the real engine: the gated step re-runs,
    // finds the answer, and the run continues past it. No answer injection, no
    // checkpoint answer slot, no new engine mechanism.
    const answers = createPeerAnswerStore(new Database(':memory:'));
    const paused = await runEngine(answers);
    answers.record({
      exchange_ref: paused.awaiting_peer!.exchange_ref,
      peer_contract_id: 'ctr_bob', answered: true, option: 'approved', at: 5,
    });

    const resumed = await runEngine(answers);
    expect(resumed.awaiting_peer).toBeUndefined();
    expect(resumed.success).toBe(true);
  });
});

describe('§ 234.4 — the run identity is required, not defaulted', () => {
  it('⛔⛔ REFUSES a call with no run identity rather than minting an unreproducible ref', async () => {
    // THE SILENT STRANDING THIS PREVENTS. The ref is derived from `run_id`, and
    // resume works only because re-running the same step in the same run
    // reproduces it. A placeholder would mint a ref the resumed run cannot
    // reproduce: the peer's answer lands under one key, the resumed step looks
    // under another, and the run waits forever for a reply that already arrived —
    // with nothing anywhere reporting a fault.
    const answers = createPeerAnswerStore(new Database(':memory:'));
    expect(() => dispatchPeerAsk(args(), { answers, run_id: '', step_id: 'verdict' }))
      .toThrow(/no run identity/);
    expect(() => dispatchPeerAsk(args(), { answers, run_id: 'run_1', step_id: '' }))
      .toThrow(/no run identity/);
  });

  it('the kernel adapter forwards stepMeta, which is where that identity lives', async () => {
    // ⚠ The seam between the engine and the dispatcher. `ResolvedCall.stepMeta` is
    // populated only on the engine path; if the adapter dropped it, every call
    // would hit the refusal above and the op would look categorically broken.
    const { createKernelAdapter } = await import('@recued/ingredients');
    let saw: { run_id?: string; step_id?: string } | undefined = undefined;
    const adapter = createKernelAdapter({
      peerAsk: async (_input, stepMeta) => { saw = stepMeta; return { answered: false, at: 0 }; },
    });
    await adapter({
      slug: 'peer-ask',
      input: args(),
      stepMeta: { run_id: 'run_9', step_id: 'verdict' },
    } as never);
    expect(saw).toEqual({ run_id: 'run_9', step_id: 'verdict' });
  });
});
