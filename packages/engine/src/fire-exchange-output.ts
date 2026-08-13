/** D-232 § 19 — the post-run fire point.
 *
 *  A recipe RETURNS (`output.render`) or it FIRES (`output.exchange`). This is
 *  the fire: it runs once, after the run terminates, and hands the host a
 *  payload plus the acknowledgement the caller gets back.
 *
 *  Three rules, each of which the obvious implementation gets wrong:
 *
 *  ⛔⛔ 1. THE PAYLOAD COMES FROM THE RUN RESULT, NEVER FROM THE OUTPUT BLOCK.
 *  A failed run returns `output: emptyOutput()` with `errors` populated. A fire
 *  point that read the rendered output would therefore send an EMPTY payload on
 *  every failure and look like it worked. This is the third time the same shape
 *  has bitten this feature — the semi-live stub (§ 17.6), the paused run
 *  (§ 19.1), and here — always an empty-but-well-formed thing flowing onward as
 *  though it were an answer.
 *
 *  ⛔ 2. FAILURE IS NOT SPECIAL; IT STILL FIRES. An earlier draft proposed outbox
 *  discipline to suppress a partial run's half-answer. That was transactional
 *  thinking imported into a MESSAGING model: a reply is always owed, and silence
 *  is the worst outcome for a correspondent. "Undeliverable" beats a swallowed
 *  letter, so `outcome: 'failed'` goes on the wire with the errors as its body.
 *
 *  ⛔ 3. A PAUSED RUN IS NOT TERMINAL, so it does NOT fire. `executeRecipe`
 *  RETURNS on a preflight hold (`awaiting_approval`) rather than throwing, and
 *  that return is indistinguishable from a finished one unless checked. Firing
 *  there would answer a peer before the owner decided — the exact thing every
 *  gate in this feature exists to prevent.
 */
import { resolveDeep, resolveValue } from '@recued/contracts';
import { isRetryableRemoteFailure } from '@recued/contracts';
import type {
  ExchangeAcknowledgement,
  RecipeExchangeOutput,
  RemoteFailureKind,
} from '@recued/contracts';

import type { ExecutionContext, ExecutionResult } from './types.js';

/** What the host puts on the wire. `outcome` is derived from the RUN, never
 *  authored — an author cannot declare their own failure a success. */
export interface ExchangeFirePayload {
  readonly ref: string;
  readonly recipe_id: string;
  readonly outcome: 'succeeded' | 'failed';
  /** ⛔ THERE IS NO `result` HERE, AND THERE CANNOT BE ONE. An earlier shape
   *  carried the finished run's rendered output "on success". But result-XOR-fire
   *  is now STRUCTURAL — the validator refuses `render` beside `exchange` — so a
   *  run that fires has no rendered output by construction, and the field could
   *  only ever carry `{render: [], sidebar: []}` (verified against a real run,
   *  not assumed). That is precisely the empty-but-well-formed thing this file's
   *  three rules exist to keep off the wire, arriving through the front door: a
   *  receiver would declare a variable for it, and read nothing out of it,
   *  forever. What a fire actually says is `outcome` + `data`, and what the
   *  CALLER gets synchronously is the acknowledgement. */
  /** The run's errors, verbatim. Present only on failure, and never empty when
   *  present — an empty body would be the silence this whole file forbids. */
  readonly errors?: readonly unknown[];
  /** D-232 § 21 — WHY it failed, in terms the far side can act on. Present iff
   *  `outcome === 'failed'`, and engine-derived exactly like `outcome`.
   *
   *  ⛔⛔ `outcome` ALONE IS NOT ACTIONABLE, AND THAT IS A REAL DEFECT RATHER
   *  THAN A MISSING NICETY. A correspondent told only "failed" has one move —
   *  retry — and for three of the four causes that is wrong: `config` never
   *  succeeds, `policy` needs the OWNER not another attempt, and only
   *  `unavailable` means "come back later". The synchronous read-through path
   *  has classified its failures this way since D-192; an exchange is the same
   *  question one hop later, and was answering it with a boolean.
   *
   *  ⚠ NOT AUTHORED, for the same reason `outcome` is not: a recipe that could
   *  declare its own refusal `unavailable` would be inviting the peer to keep
   *  knocking. */
  readonly kind?: RemoteFailureKind;
  /** One human-readable line for {@link kind}. Present iff `kind` is. */
  readonly reason?: string;
  /** The tool this message is delivered to; the host resolves it to an
   *  installed operation. */
  readonly deliver_to: string;
  readonly callback_op?: string;
  readonly connection?: string;
  /** D-232 § 28 — the author's declaration that this answer must leave the
   *  server. The HOST enforces it: it is the only party that knows whether a
   *  connection resolved. */
  readonly require_connection?: boolean;
  readonly data?: Record<string, unknown>;
}

/** The engine-derived acknowledgement: what the CALLER gets synchronously. Not
 *  an answer — a receipt, carrying the one thing that makes the exchange
 *  queryable later.
 *
 *  ⚠ DEFINED IN `@recued/contracts` SINCE § 30 and re-exported here so every
 *  existing import still resolves. It moved because it is no longer only an
 *  engine derivation: it is a wire shape, an audit field, and a § 23 input, and
 *  `packages/storage` cannot import the engine. */
export type { ExchangeAcknowledgement };

/** D-232 § 30 — what the HOST learned by sending, handed back to the fire point.
 *
 *  ⛔⛔ THE SEAM THIS ADDS EXISTED IN ONE DIRECTION ONLY, AND THAT WAS THE WHOLE
 *  DEFECT. The handler returned `void`, so a peer's synchronous answer — the one
 *  place a correspondent can say "I have your letter and I cannot reply" — had
 *  nowhere to go. The host read it (it is the tool result of the carrier's own
 *  call), had no way to report it, and dropped it; the fire point then attached
 *  `accepted: true` because nothing had said otherwise. Every classifier between
 *  those two facts keys on `isError`, which a receiver reporting its own failure
 *  does not set.
 *
 *  🔑 A `void` RETURN IS A DESIGN STATEMENT: it says the caller learns nothing
 *  by doing this. That was true when the fire was a post to a queue; it stopped
 *  being true the moment the carrier became a synchronous `tools/call`. */
export interface ExchangeFireOutcome {
  /** The PEER's receipt, validated off the wire (`parsePeerExchangeAck`), when
   *  their response carried one. ⚠ Theirs, not ours: `exchange_ack` is what we
   *  hand our caller, this is what they handed us. */
  readonly peer_ack?: ExchangeAcknowledgement;
}

export type ExchangeFireHandler = (
  payload: ExchangeFirePayload,
) => Promise<ExchangeFireOutcome | void> | ExchangeFireOutcome | void;

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** D-232 § 21 — map a run's errors onto the shared {@link RemoteFailureKind}.
 *
 *  Deliberately a SMALL explicit map with a safe default rather than clever
 *  inference. Every code not named here lands in `error`, which is the bucket an
 *  unattended caller will not auto-retry — so a code nobody classified yet
 *  degrades to "a human should look", never to "keep knocking".
 *
 *  ⛔⛔ `ACTION_DELIVERY_UNCERTAIN` OVERRIDES EVERYTHING, AND IT IS THE REASON
 *  THIS IS NOT A ONE-LINER. Its own contract doc says the write "may or may not
 *  have succeeded server-side" and to "NEVER silently retry, as that risks
 *  duplicate writes". A run that hit it can easily ALSO carry a `NETWORK_ERROR`
 *  — that is typically how the acknowledgement got lost — and a first-match or
 *  priority scan would then classify the whole thing `unavailable` and invite
 *  the far side to send the payment twice. So it is checked across ALL errors,
 *  first, and wins.
 *
 *  ⚠ Codes are an imperfect signal and this is not pretending otherwise — see
 *  the `NETWORK_ERROR` note on {@link UNAVAILABLE_CODES}, which is the same
 *  lesson: an over-broad code cannot be un-collapsed downstream — the fix is to
 *  stop collapsing it at the emitter, not to guess here.
 *
 *  ⛔⛔ THE KNOWN HOLE, MEASURED ON A REAL PEER: A RECIPE'S OWN AUTHORIZATION
 *  GUARDS ARE INDISTINGUISHABLE FROM A CRASH. The two-server drive's receiver
 *  refuses a non-participant with a `fail_on` — "exactly one active participant
 *  required" — which is a POLICY refusal in every sense that matters to the
 *  asker, and it reaches this function as `RECIPE_FAIL_ON_TRIGGERED`: the same
 *  code a division-by-zero guard would raise. It classifies `error`.
 *
 *  That is the safe direction (nothing auto-retries a refusal) but it is still
 *  wrong, and the fix is NOT to let a recipe declare its own `kind`: `outcome`
 *  is engine-derived precisely so an author cannot call their own failure a
 *  success, and the same reasoning says an author must not be able to call their
 *  own crash a policy refusal. What is needed is a way for a GUARD to carry a
 *  classification — a refusal is a designed outcome, not an error — which is a
 *  step-level contract change and deliberately not smuggled in here. */
const POLICY_CODES: ReadonlySet<string> = new Set([
  'RECIPE_POLICY_DENIED',
  'RECIPE_APPROVAL_DENIED',
  'RECIPE_APPROVAL_TIMEOUT',
  'INGREDIENT_SCOPE_INSUFFICIENT',
  'API_FORBIDDEN',
  'ROLE_RESTRICTION',
]);

const CONFIG_CODES: ReadonlySet<string> = new Set([
  'RECIPE_NOT_FOUND',
  'RECIPE_VALIDATION_FAILED',
  'RECIPE_PREREQUISITE_NOT_MET',
  'INGREDIENT_NOT_FOUND',
  'INGREDIENT_VERSION_MISMATCH',
  'INGREDIENT_ENDPOINT_BLOCKED',
  'API_NOT_FOUND',
]);

/** ⚠ `NETWORK_ERROR` IS BACK IN THIS SET, AND ONLY BECAUSE THE EMITTER WAS FIXED
 *  FIRST. The catalog gateway used to report EVERY remote failure under it —
 *  including a peer that answered and REFUSED — because its tool-error arm threw
 *  a bare `Error` and the step runner defaulted to this code. While that was
 *  true, listing `NETWORK_ERROR` here meant telling an asker to retry a refusal
 *  forever, so it was deliberately excluded, and every genuinely unreachable peer
 *  lost the retry it deserved instead. Wrong in the safe direction, but wrong.
 *
 *  A reached-and-refused peer now carries its own `MCP_TOOL_ERROR` (absent from
 *  every set here, so it falls through to `error`: a human looks, nothing
 *  auto-retries). This code therefore means what it says again — nobody answered
 *  — and `unavailable` can mean "come back later" without lying.
 *
 *  🔑🔑 THE FIX BELONGED AT THE EMITTER. No classifier can recover a distinction
 *  that was collapsed upstream of it; the most a downstream reader can do is
 *  choose which way to be wrong. Two rounds were spent choosing, before the
 *  actual answer turned out to be one field on the throw. */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'NETWORK_ERROR',
  'API_SERVER_ERROR',
  'API_RATE_LIMITED',
  'STEP_TIMEOUT',
  'CHECKPOINT_STORE_UNAVAILABLE',
  'AI_LLM_UNAVAILABLE',
  'AI_TIMEOUT',
]);

const errorCode = (e: unknown): string =>
  typeof (e as { code?: unknown } | null)?.code === 'string'
    ? (e as { code: string }).code
    : '';

const errorMessage = (e: unknown): string =>
  typeof (e as { message?: unknown } | null)?.message === 'string'
    ? (e as { message: string }).message
    : '';

/** D-232 § 21 — an authored `fail_kind`, if the guard that failed declared one.
 *  ⚠ RE-VALIDATED HERE rather than trusted: these errors can arrive off the wire
 *  on a resumed or replayed run, and the authorable vocabulary excludes
 *  `unavailable` precisely so nothing can declare itself retryable. A value
 *  outside the two admitted ones is ignored, not passed through. */
const declaredFailKind = (e: unknown): RemoteFailureKind | undefined => {
  const details = (e as { details?: unknown } | null)?.details;
  const kind = (details as { fail_kind?: unknown } | null | undefined)?.fail_kind;
  return kind === 'policy' || kind === 'config' ? kind : undefined;
};

export const classifyRunFailure = (
  errors: readonly unknown[],
): { kind: RemoteFailureKind; reason: string } => {
  const first = errors[0];
  const reason = errorMessage(first) || 'the run failed without reporting a message';

  // Rule above: uncertain delivery is never advertised as retryable.
  if (errors.some((e) => errorCode(e) === 'ACTION_DELIVERY_UNCERTAIN')) {
    return { kind: 'error', reason };
  }
  // ── AN AUTHORED REFUSAL OUTRANKS EVERY INFERENCE FROM A CODE ──
  // A guard that declared itself a refusal is the ONLY party that actually knows;
  // every rule below this line is guesswork over an error code. It is checked
  // after the delivery-uncertain rule and before the rest, so a recipe can say
  // "I refused you" but still cannot talk its way out of "this may have already
  // committed".
  for (const e of errors) {
    const declared = declaredFailKind(e);
    if (declared !== undefined) return { kind: declared, reason: errorMessage(e) || reason };
  }
  // A refusal anywhere outranks a downstream symptom — it is the one thing the
  // caller can actually act on, and it is never incidental noise.
  if (errors.some((e) => POLICY_CODES.has(errorCode(e)))) return { kind: 'policy', reason };

  for (const e of errors) {
    const code = errorCode(e);
    if (CONFIG_CODES.has(code)) return { kind: 'config', reason };
    if (UNAVAILABLE_CODES.has(code)) return { kind: 'unavailable', reason };
  }
  return { kind: 'error', reason };
};

/** Build the payload from the finished run. Exported for tests: the derivation
 *  is where rule 1 lives, and it is worth pinning apart from the wiring. */
export const buildExchangeFirePayload = (
  declared: RecipeExchangeOutput,
  ctx: ExecutionContext,
  result: ExecutionResult,
): ExchangeFirePayload => {
  const ref = asString(resolveValue(declared.ref, ctx.stores));
  const deliver_to = asString(resolveValue(declared.deliver_to, ctx.stores));
  const callback_op = declared.callback_op === undefined
    ? undefined
    : asString(resolveValue(declared.callback_op, ctx.stores));
  const connection = declared.connection === undefined
    ? undefined
    : asString(resolveValue(declared.connection, ctx.stores));
  // ⛔ `resolveDeep`, NOT `resolveValue`. `resolveValue` returns any non-ref
  // value UNCHANGED — so on an OBJECT it hands back the object with every
  // `{{step.*}}` inside it still a literal string. `data` is an object in every
  // real payload (that is what it is for), so the shallow resolver meant an
  // exchange could only ever carry top-level pure refs and the actual answer
  // went on the wire as template text. Caught by driving the real peer receiver,
  // whose payload is two levels deep; every unit test used a flat fixture.
  const require_connection = declared.require_connection === true;
  const data = declared.data === undefined
    ? undefined
    : (resolveDeep(declared.data, ctx.stores) as Record<string, unknown>);

  // ⛔ Read `success` off the RUN. Deriving the outcome from the presence of a
  // rendered output would call every failure a success, since a failed run
  // still returns a well-formed (empty) output object.
  const succeeded = result.success === true;
  return {
    ref,
    recipe_id: result.recipe_id,
    outcome: succeeded ? 'succeeded' : 'failed',
    deliver_to,
    // A failed run with an empty `errors` array is the silent-failure shape
    // guarded elsewhere in this feature; carry a stand-in rather than an empty
    // body, so the far side never receives "it failed" with nothing in it.
    ...(succeeded
      ? {}
      : (() => {
          const errors = result.errors.length > 0
            ? result.errors
            : [{ message: `Recipe '${result.recipe_id}' failed without reporting an error.` }];
          // § 21 — the classification rides WITH the errors, never instead of
          // them. `kind` is what a machine branches on; `errors` stays verbatim
          // so a human still has the whole story.
          return { errors, ...classifyRunFailure(errors) };
        })()),
    ...(callback_op ? { callback_op } : {}),
    ...(connection ? { connection } : {}),
    ...(require_connection ? { require_connection: true } : {}),
    ...(data !== undefined ? { data } : {}),
  };
};

/** Derive the receipt from the declaration. Engine-owned so no recipe can omit
 *  it — see the class comment on {@link RecipeExchangeOutput}.
 *
 *  ⛔⛔ THE REF IS A HANDLE, NOT A DELIVERY CLAIM, AND CONFLATING THEM COST THE
 *  CALLER EVERYTHING. This used to return `accepted: true` unconditionally and
 *  was therefore attached ONLY on success — so when a peer was down the caller
 *  got no receipt at all. The reasoning was that `accepted: true` on an
 *  undelivered letter would be the substrate lying, which is correct about
 *  `accepted` and wrong about the REF: the carrier run IS filed under it, § 24
 *  IS about to retry it, and § 23 CAN answer questions about it. The one party
 *  with a reason to know all that was the only one told nothing.
 *
 *  ⇒ A failed fire now returns the handle with `accepted: false`, the § 21
 *  `kind`, and whether a retry is coming. ⚠ Deliberately NOT a new vocabulary
 *  (`peer_down` / `peer_down_retrying`): that would be a THIRD set of names for
 *  the question `RemoteFailureKind` already answers, which is the exact mistake
 *  § 21 exists to have fixed. */
export const acknowledgementFor = (
  payload: ExchangeFirePayload,
  failure?: { kind: RemoteFailureKind; reason: string },
): ExchangeAcknowledgement => ({
  ref: payload.ref,
  ...(payload.callback_op !== undefined ? { callback_op: payload.callback_op } : {}),
  ...(failure === undefined
    ? { accepted: true }
    : {
        accepted: false,
        kind: failure.kind,
        reason: failure.reason,
        retrying: isRetryableRemoteFailure(failure.kind),
      }),
});

/** Fire, if this run declared an exchange output and actually terminated.
 *  Returns the result unchanged, or — when the fire cannot happen — a FAILED
 *  copy of it, because a recipe whose entire purpose was to answer and did not
 *  has not succeeded, whatever its steps did. */
export const fireExchangeOutput = async (
  ctx: ExecutionContext,
  result: ExecutionResult,
): Promise<ExecutionResult> => {
  const declared = ctx.recipe?.output?.exchange;
  if (declared === undefined) return result;
  // Rule 3 — a hold is not a terminus.
  //
  // ⛔⛔ D-234 § 234.4 — `awaiting_peer` IS A HOLD TOO, AND THIS LINE WAS A HOLE
  // THE MOMENT THAT STATE EXISTED. A recipe that asks a peer mid-run and also
  // declares `output.exchange` would, while SUSPENDED, have fired its terminal
  // exchange — sending a conclusion drawn from an answer nobody has given yet,
  // and then sending it AGAIN on resume. The rule was always "a paused run has
  // not finished"; it just named only one way to be paused.
  if (result.awaiting_approval !== undefined) return result;
  if (result.awaiting_peer !== undefined) return result;

  const payload = buildExchangeFirePayload(declared, ctx, result);

  if (!payload.ref) {
    return failed(result, `Exchange output declared no resolvable ref (got '${declared.ref}').`);
  }
  if (!payload.deliver_to) {
    // Same posture as the ref: the run's whole purpose was to send this, and a
    // target that resolved to nothing means it is not going anywhere.
    return failed(
      result,
      `Exchange output declared no resolvable deliver_to (got '${declared.deliver_to}').`,
    );
  }
  if (ctx.exchangeFireHandler === undefined) {
    // ⛔ LOUD, not silent. A recipe declaring an exchange on a host with no fire
    // handler would otherwise complete "successfully" having answered nobody —
    // and the peer would wait forever on a run that reported success.
    return failed(
      result,
      `Recipe '${result.recipe_id}' declares an exchange output but the host has no `
      + 'exchangeFireHandler; nothing was sent.',
    );
  }
  let outcome: ExchangeFireOutcome | void;
  try {
    outcome = await ctx.exchangeFireHandler(payload);
  } catch (e) {
    // ⇒ THE HANDLE STILL GOES BACK. The letter did not go, and the caller is
    // told exactly that — plus WHY, and whether § 24 will try again. The carrier
    // run is filed under this ref either way, so the ref addresses something
    // real: it is what § 23 answers questions about and what the retry sweep
    // acts on. Returning nothing here left the one party who needed all of that
    // unable to name their own exchange.
    const failure = classifyRunFailure([e]);
    return {
      ...failed(
        result,
        `Exchange fire failed for ref '${payload.ref}': ${(e as Error).message}`,
      ),
      exchange_ack: acknowledgementFor(payload, failure),
    };
  }
  // ⛔ THE RECEIPT IS ATTACHED ONLY HERE — after the handler returned without
  // throwing. Every other exit above is a fire that did NOT happen, and an
  // `accepted: true` on any of them would be the substrate telling a caller its
  // letter was posted when it was not. That is worse than the failure it would
  // be papering over: the caller stops waiting for something that never went.
  //
  // ⚠ D-232 § 30 — AND `accepted: true` IS STILL EXACTLY RIGHT HERE, which is
  // why the peer's verdict rides BESIDE it rather than replacing it. Our letter
  // did go; the handler proved that by returning. What the peer added is a fact
  // about THEIR reply, and collapsing the two into one boolean would lose the
  // distinction the whole § 21 vocabulary exists to keep — the same conflation
  // that made this a delivery claim in the first place.
  return {
    ...result,
    exchange_ack: acknowledgementFor(payload),
    ...(outcome?.peer_ack !== undefined ? { exchange_peer_ack: outcome.peer_ack } : {}),
  };
};

const failed = (result: ExecutionResult, message: string): ExecutionResult => ({
  ...result,
  success: false,
  errors: [
    ...result.errors,
    {
      error_id: `${result.recipe_id}:exchange_fire`,
      code: 'EXCHANGE_FIRE_FAILED',
      message,
      severity: 'error',
      source: { recipe_id: result.recipe_id, step_id: null, ingredient_slug: null },
      details: {},
      timestamp: new Date().toISOString(),
      retryable: false,
    } as unknown as ExecutionResult['errors'][number],
  ],
});
