/** D-232 § 19 — the post-run fire point.
 *
 * The unit-level rules are pinned against `buildExchangeFirePayload`; the WIRING
 * is pinned against the real `executeRecipe`, because the failure this feature
 * keeps producing is a seam that exists and is never reached. (While building
 * this, exactly that happened: the first wiring wrapped one of `executeRecipe`'s
 * two exit paths and left the other — the no-budget path, i.e. every ordinary
 * run — firing nothing. `tsc` was clean and the unit tests all passed.)
 */
import { describe, expect, it } from 'vitest';

import { executeRecipe } from '../execute.js';
import {
  classifyRunFailure,
  acknowledgementFor,
  buildExchangeFirePayload,
  type ExchangeFireOutcome,
  type ExchangeFirePayload,
} from '../fire-exchange-output.js';
import { isRetryableRemoteFailure } from '@recued/contracts';
import type { ExecutionContext, ExecutionResult } from '../types.js';

const recipeWith = (exchange: Record<string, unknown> | undefined, steps: unknown[] = []) => ({
  recipe_id: 'answerer',
  version: 1,
  metadata: { name: 'a', description: '', author: 'x', supported_platforms: [] },
  variables: {},
  steps,
  output: exchange === undefined ? { render: [] } : { exchange },
}) as any;

const harness = (recipe: any, opts: {
  handler?: (p: ExchangeFirePayload) => ExchangeFireOutcome | void;
} = {}) => {
  const fired: ExchangeFirePayload[] = [];
  const ctx: ExecutionContext = {
    recipe,
    stores: { config: {}, step: {}, context: {}, meta: {} } as any,
    ingredientExecutor: async () => ({ ok: true }),
    exchangeFireHandler: (p) => { fired.push(p); return opts.handler?.(p); },
  } as ExecutionContext;
  return { ctx, fired };
};

const resultOf = (over: Partial<ExecutionResult> = {}): ExecutionResult => ({
  recipe_id: 'answerer',
  recipe_hash: 'h',
  success: true,
  output: { render: [{ label: 'x' }] },
  steps: [],
  errors: [],
  duration_ms: 1,
  validation_issues: [],
  ...over,
} as unknown as ExecutionResult);

describe('D-232 § 19 — payload derivation', () => {
  const declared = { ref: '{{step.ref}}', deliver_to: 'pub/reply', callback_op: 'pub/reply' };
  const ctx = () => ({ stores: { step: { ref: 'exch_1' } } } as unknown as ExecutionContext);

  it('takes the outcome from the RUN, not from the output block', () => {
    expect(buildExchangeFirePayload(declared, ctx(), resultOf()).outcome).toBe('succeeded');
    expect(buildExchangeFirePayload(declared, ctx(), resultOf({ success: false })).outcome)
      .toBe('failed');
  });

  it('⛔⛔ a FAILED run still fires, carrying its errors as the body', () => {
    // Rule 2. Silence is the worst outcome for a correspondent — a peer waiting
    // on an answer that never comes is the failure the exchange prevents.
    const p = buildExchangeFirePayload(declared, ctx(), resultOf({
      success: false,
      errors: [{ message: 'calendar unreachable' }] as any,
    }));
    expect(p.outcome).toBe('failed');
    expect(p.errors).toEqual([{ message: 'calendar unreachable' }]);
  });

  it('⛔ carries NO `result` — a firing run has no rendered output, by construction', () => {
    // Result-XOR-fire is enforced by the validator, so `output.render` cannot
    // exist beside `output.exchange`. The old payload carried `result:
    // result.output` "on success", which for a firing run is always
    // `{render: [], sidebar: []}` — checked against a real run before removing
    // it. A receiver would have declared a variable for it and read nothing out
    // of it forever, and an empty-but-well-formed body on the wire is the exact
    // shape this file's rules exist to prevent.
    const p = buildExchangeFirePayload(declared, ctx(), resultOf()) as unknown as Record<string, unknown>;
    expect(p.outcome).toBe('succeeded');
    expect('result' in p, 'the dead field came back').toBe(false);
  });

  it('⛔⛔ a failed run whose OUTPUT is empty still sends a non-empty body', () => {
    // Rule 1, the trap: `executeRecipe` returns `output: emptyOutput()` on
    // failure. Reading the rendered output would put an empty payload on the
    // wire and look like it worked — the third time this exact shape has bitten
    // this feature.
    const p = buildExchangeFirePayload(declared, ctx(), resultOf({
      success: false, output: {} as any, errors: [] as any,
    }));
    expect(p.errors).toHaveLength(1);
    expect(String((p.errors as any[])[0].message)).toContain('without reporting an error');
  });

  it('resolves the ref through the run\'s stores', () => {
    expect(buildExchangeFirePayload(declared, ctx(), resultOf()).ref).toBe('exch_1');
  });

  it('⛔⛔ resolves `data` DEEPLY — a nested payload is the normal case, not the exotic one', () => {
    // The bug this pins shipped: `resolveValue` returns any NON-REF value
    // unchanged, so on an object it hands back every `{{step.*}}` inside it as a
    // literal string. Every flat fixture passed; the first real payload — two
    // levels deep, which is what an op with a `data` argument needs — put
    // template text on the wire instead of the answer.
    const nested = {
      ref: '{{step.ref}}',
      deliver_to: 'pub/reply',
      data: {
        decision: 'accepted',
        data: { start_at: '{{step.start}}', count: '{{step.count}}' },
      },
    };
    const deepCtx = {
      stores: { step: { ref: 'exch_1', start: 1_700_000_000_000, count: 3 } },
    } as unknown as ExecutionContext;
    const p = buildExchangeFirePayload(nested, deepCtx, resultOf());
    expect(p.data).toEqual({
      decision: 'accepted',
      // ⚠ Types preserved through a pure ref — numbers stay numbers, which the
      // far side's declared variable types depend on.
      data: { start_at: 1_700_000_000_000, count: 3 },
    });
  });

  it('derives the acknowledgement, so no recipe can forget it', () => {
    const ack = acknowledgementFor(buildExchangeFirePayload(declared, ctx(), resultOf()));
    expect(ack).toEqual({ ref: 'exch_1', callback_op: 'pub/reply', accepted: true });
  });
});

describe('D-232 § 19 — wiring through the real executeRecipe', () => {
  it('✅ fires on an ordinary run — the no-budget exit path', async () => {
    // ⛔ THE PATH THE FIRST WIRING MISSED. `executeRecipe` has two exits and the
    // initial change wrapped only the budgeted one, so every ordinary run fired
    // nothing while typecheck and the unit tests stayed green.
    const { ctx, fired } = harness(recipeWith({ ref: 'exch_static', deliver_to: 'pub/reply', callback_op: 'pub/reply' }));
    const r = await executeRecipe(ctx);
    expect(fired, 'the fire point was never reached').toHaveLength(1);
    expect(fired[0]!.ref).toBe('exch_static');
    expect(fired[0]!.outcome).toBe('succeeded');
    expect(r.success).toBe(true);
  });

  it('⛔⛔ a PAUSED run does NOT fire — it is not a terminus', async () => {
    // Rule 3, and the sharpest of the three. `executeRecipe` RETURNS on a
    // preflight hold rather than throwing, and that return is shaped exactly
    // like a finished one. Firing here would answer a peer BEFORE the owner
    // decided — the thing every gate in this feature exists to prevent.
    const { ctx, fired } = harness(recipeWith({ ref: 'exch_static', deliver_to: 'pub/reply' }));
    const paused = { ...resultOf({ success: false, errors: [] as any }),
      awaiting_approval: { gated_step_id: 'send', step_state: {} } } as ExecutionResult;
    const { fireExchangeOutput } = await import('../fire-exchange-output.js');
    const out = await fireExchangeOutput(ctx, paused);
    expect(fired, 'it answered a peer while the owner was still deciding').toEqual([]);
    expect(out, 'a hold must pass through untouched').toBe(paused);
  });

  it('does NOT fire for a recipe that renders', async () => {
    const { ctx, fired } = harness(recipeWith(undefined));
    await executeRecipe(ctx);
    expect(fired).toEqual([]);
  });

  it('⛔ FAILS the run when the host has no fire handler — never silently succeeds', async () => {
    // A recipe whose entire purpose is to answer, on a host that cannot send,
    // must not report success. The peer would wait forever on a green run.
    const { ctx } = harness(recipeWith({ ref: 'exch_static', deliver_to: 'pub/reply' }));
    delete (ctx as any).exchangeFireHandler;
    const r = await executeRecipe(ctx);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.errors)).toContain('exchangeFireHandler');
    expect(r.exchange_ack, 'a receipt for a letter that never went').toBeUndefined();
  });

  it('⛔ FAILS the run when the ref does not resolve', async () => {
    const { ctx } = harness(recipeWith({ ref: '{{step.missing}}', deliver_to: 'pub/reply' }));
    const r = await executeRecipe(ctx);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.errors)).toContain('no resolvable ref');
    expect(r.exchange_ack, 'a receipt whose ref is the thing that failed').toBeUndefined();
  });

  it('⛔ a throwing handler FAILS the run rather than passing silently', async () => {
    const { ctx } = harness(recipeWith({ ref: 'exch_static', deliver_to: 'pub/reply' }), {
      handler: () => { throw new Error('peer unreachable'); },
    });
    const r = await executeRecipe(ctx);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.errors)).toContain('peer unreachable');
    // ⚠ REVERSED in § 25 — see the host-drive sibling for the full reasoning.
    // The run still FAILS (that is what this test is for); what changed is that
    // the caller now gets the HANDLE with `accepted: false` instead of nothing,
    // because the ref addresses a real exchange the retry sweep may act on.
    expect(r.exchange_ack?.accepted).toBe(false);
    expect(r.exchange_ack?.ref).toBe('exch_static');
  });
});

describe('D-232 § 19.3 — the receipt rides on the RESULT, and only when the letter went', () => {
  // ⛔ THE RECEIPT IS THE EXCHANGE'S ONLY JUSTIFICATION. A sender expects nothing
  // back; what this substrate adds over a real letter is that you can ask what
  // happened to it, and the ref is the handle. `acknowledgementFor` derived it
  // from the day the fire point shipped and NOTHING carried it — every answer
  // went out and every caller was left with nothing to ask about.
  //
  // ⚠ FOUR exits reach "no fire", and the three failing ones each needed their
  // own line: a mutation that attached a receipt on the unresolvable-ref exit
  // passed the whole HOST drive, which covered only the throwing-handler one.
  // "It refuses somewhere" is not "it refuses on every path".

  it('✅ attaches the receipt on a fire that happened', async () => {
    const { ctx, fired } = harness(recipeWith({ ref: 'exch_static', deliver_to: 'pub/reply', callback_op: 'pub/reply' }));
    const r = await executeRecipe(ctx);
    expect(fired).toHaveLength(1);
    expect(r.exchange_ack).toEqual({ ref: 'exch_static', callback_op: 'pub/reply', accepted: true });
  });

  it('keeps the host-derived target contract beside, not inside, the wire receipt', async () => {
    const { ctx } = harness(
      recipeWith({ ref: 'exch_static', deliver_to: 'pub/reply', callback_op: 'pub/reply' }),
      { handler: () => ({ expected_contract_id: 'ct_peer_alice' }) },
    );
    const r = await executeRecipe(ctx);
    expect(r.exchange_expected_contract_id).toBe('ct_peer_alice');
    expect(r.exchange_ack).not.toHaveProperty('expected_contract_id');
  });

  it('✅ omits `callback_op` when the exchange named none — never an empty string', async () => {
    const { ctx } = harness(recipeWith({ ref: 'exch_static', deliver_to: 'pub/reply' }));
    const r = await executeRecipe(ctx);
    expect(r.exchange_ack).toEqual({ ref: 'exch_static', accepted: true });
  });

  it('⛔ a PAUSED run carries no receipt — it has not answered anybody yet', async () => {
    const { ctx } = harness(recipeWith({ ref: 'exch_static', deliver_to: 'pub/reply' }));
    const paused = { ...resultOf({ success: false, errors: [] as any }),
      awaiting_approval: { gated_step_id: 'send', step_state: {} } } as ExecutionResult;
    const { fireExchangeOutput } = await import('../fire-exchange-output.js');
    const out = await fireExchangeOutput(ctx, paused);
    expect(out.exchange_ack).toBeUndefined();
  });

  it('⛔ a recipe that RENDERS carries no receipt', async () => {
    const { ctx } = harness(recipeWith(undefined));
    const r = await executeRecipe(ctx);
    expect(r.exchange_ack).toBeUndefined();
  });
});

describe('D-232 § 21 — unreachable vs refused', () => {
  /** ⛔⛔ THE WHOLE POINT OF THE `MCP_TOOL_ERROR` CODE. These two are the same
   *  event to a naive reader — "the remote call did not work" — and opposite to
   *  a caller deciding what to do next. Before the gateway stamped a code they
   *  were BOTH `NETWORK_ERROR`: a transport failure because it genuinely is one,
   *  a tool error because the throw was bare and the step runner defaulted.
   *
   *  🔑 Asserted as a PAIR in one test on purpose. Each alone passes under a
   *  classifier that returns a constant; only together do they pin that the two
   *  are distinguishable, which is the property that was missing. */
  it('separates a peer that never answered from one that answered and refused', () => {
    const unreachable = classifyRunFailure([
      { code: 'NETWORK_ERROR', message: 'connect ECONNREFUSED 127.0.0.1:7802' },
    ]);
    const refused = classifyRunFailure([
      { code: 'MCP_TOOL_ERROR', message: "invoked tool 'x' — needs a pack that is not installed" },
    ]);

    expect(unreachable.kind, 'nobody answered — coming back later is the right move')
      .toBe('unavailable');
    expect(refused.kind, 'they answered and said no — retrying cannot change that')
      .toBe('error');
    expect(unreachable.kind).not.toBe(refused.kind);
    // The reason survives on both — the classification rides WITH the evidence.
    expect(refused.reason).toContain('needs a pack that is not installed');
  });

  it("⛔⛔ an authored refusal beats the code — a guard is not a crash", () => {
    /** THE HOLE THIS CLOSES. Every triggered guard raises
     *  `RECIPE_FAIL_ON_TRIGGERED`, so a receiver's "exactly one active
     *  participant required" — the authorization WORKING — was indistinguishable
     *  from a division by zero, and both reached the asker as `error`: a human
     *  must look, when in fact they were simply told no.
     *
     *  🔑 The two errors below are byte-identical apart from `details.fail_kind`.
     *  That is the point: nothing in the CODE can tell them apart, which is why
     *  the guard has to say so itself. */
    const undeclared = classifyRunFailure([
      { code: 'RECIPE_FAIL_ON_TRIGGERED', message: 'fail_on triggered on step one_participant' },
    ]);
    const declared = classifyRunFailure([
      {
        code: 'RECIPE_FAIL_ON_TRIGGERED',
        message: 'fail_on triggered on step one_participant',
        details: { fail_kind: 'policy' },
      },
    ]);
    expect(undeclared.kind, 'an unclassified guard stays a failure — no behaviour change')
      .toBe('error');
    expect(declared.kind, 'a guard that says it refused you reads as a refusal')
      .toBe('policy');
  });

  it('⛔ a recipe CANNOT declare itself retryable', () => {
    /** `unavailable` is the one kind meaning "retry later", so a recipe able to
     *  claim it could invite a peer to knock forever. The TYPE excludes it and
     *  the validator refuses it, but this pins the last line of defence: these
     *  errors can arrive off the wire on a resumed or replayed run, so the
     *  classifier re-validates rather than trusting what it is handed. */
    for (const smuggled of ['unavailable', 'succeeded', '', null, 42]) {
      const out = classifyRunFailure([
        {
          code: 'RECIPE_FAIL_ON_TRIGGERED',
          message: 'nice try',
          details: { fail_kind: smuggled },
        },
      ]);
      expect(out.kind, `fail_kind ${JSON.stringify(smuggled)} must not be honoured`)
        .toBe('error');
    }
  });

  it('only the unreachable one is safe for an unattended retry', () => {
    expect(isRetryableRemoteFailure('unavailable')).toBe(true);
    expect(isRetryableRemoteFailure('error')).toBe(false);
  });
});
