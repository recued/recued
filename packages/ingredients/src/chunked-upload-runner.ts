/** D-217 slice 2b-ii-β — the SEQUENCER: one act, N requests, one commit row.
 *
 *  Slice 2a built the plan and the reducer; 2b-i built phase → dispatch input;
 *  2b-ii-α built the chunk wire piece. None of it moved a byte, because nothing
 *  drove it. This is the driver.
 *
 *  ## Where it runs, and why that is the whole design
 *
 *  The § 8a ruling first put this walk in the catalog gateway. That was AMENDED
 *  (2026-07-26): the gateway dispatches through `ctx.ingredientExecutor`, which
 *  IS the commit-wrapped executor, so a walker there is N commit rows and N
 *  admission evaluations for ONE act. This runs in the connection ADAPTER,
 *  below the commit boundary — the Gateway sees one dispatch, the owner
 *  approves one act, and the audit gets one honest row (§ 6.2, § 6.3).
 *
 *  🔑🔑 **Invariant 1 is therefore not carved out — it is not ENGAGED.**
 *  `followPagination` refuses to re-dispatch a write op, and it never sees this
 *  one: the re-dispatch happens below it. `followPagination` is byte-for-byte
 *  unchanged and stays read-gated with no exception written anywhere. What
 *  keeps the carve-out RULE true here is structural rather than a discipline
 *  this module must be trusted to keep — the APPEND count and total request
 *  ceiling arrive as fixed DATA (`count` + `request_bound`) on the input the
 *  owner approved, and there is no syntax by which a response value could
 *  raise either one.
 *
 *  ## The one invariant to preserve when editing
 *
 *  ⛔ **This module PERFORMS and FOLDS. The REDUCER decides.** Every failure —
 *  a thrown handler, a refused substitution, a blown deadline — is folded into
 *  `advanceChunkedWalk` as a `{ ok: false }` result rather than turned into an
 *  outcome here. That is what makes fail-closed one rule in one place: the
 *  reducer is where "no transition reaches FINALIZE from a failed append"
 *  lives, and a second opinion in this file is how that rule would rot.
 *
 *  ⚠ In particular: a failure DURING the status poll is not a failure of the
 *  upload (§ 8.1 — X polls after FINALIZE, so the asset already exists). If you
 *  find yourself writing `outcome: 'failed'` here, you are re-deciding
 *  something `advanceChunkedWalk` already decides correctly.
 *
 *  ## Composition, not extraction
 *
 *  🔑 The sequencer calls **the `connection.api` handler itself**, once per
 *  phase. So every chunk goes through the same auth injection, SSRF
 *  origin-pinning, redirect policy, timeout and response parse as an ordinary
 *  single request — not a second copy of them that can drift. Recursion depth
 *  is exactly 2 and `assertNoNestedWalk` pins it: a phase input can never carry
 *  the walk key, so a walk cannot start a walk.
 *
 *  Spec: D-217 § 8a (+ amendment), § 9, § 9.8.
 */

import {
  CHUNKED_UPLOAD_MAX_WALK_MS,
  CHUNKED_UPLOAD_WIRE_FIELD_KEY,
  CHUNKED_UPLOAD_WIRE_LENGTH_KEY,
  CHUNKED_UPLOAD_WIRE_OFFSET_KEY,
  CHUNKED_UPLOAD_WIRE_TOKEN_KEY,
  CHUNKED_UPLOAD_WIRE_WALK_KEY,
  type ChunkedUploadPhase,
  type ChunkedUploadSpec,
  type ChunkedUploadWalkInput,
} from '@recued/contracts';

import {
  advanceChunkedWalk,
  buildChunkedPhaseInput,
  nextChunkedAction,
  planChunkedUpload,
  startChunkedWalk,
  type ChunkPlan,
  type ChunkedPhaseTokens,
  type ChunkedWalkOutcome,
  type ChunkedWalkResult,
} from './chunked-upload-walk.js';
import type { ConnectionHandlerCtx } from './connection.js';
import { IngredientError } from './types.js';
import { MAX_TIMEOUT_MS } from './timeout.js';

/** What one performed phase reports back.
 *
 *  The runner hands `performPhase` an ACCUMULATING ctx rather than the real
 *  one — see `runChunkedUpload` — so the sizes of every request in the walk sum
 *  instead of the last one overwriting the rest. */
export type PerformChunkedPhase = (
  params: Record<string, unknown>,
  ctx: ConnectionHandlerCtx,
) => Promise<unknown>;

export interface ChunkedUploadRunResult {
  readonly outcome: ChunkedWalkOutcome;
  /** Requests actually performed, every phase included. The APPEND count alone
   *  is `chunks_sent`. */
  readonly requests: number;
  /** Exact partition of performed requests. A phase rejected locally before
   * dispatch increments neither side. */
  readonly requests_succeeded: number;
  readonly requests_failed: number;
  readonly chunks_sent: number;
  /** Chunk bytes in APPENDs that COMPLETED.
   *
   *  ⚠ **Deliberately excludes a chunk that was in flight when the walk
   *  failed.** The adapter cannot know how much of a failed request's body
   *  reached the socket, and the two errors are not symmetric: understating
   *  egress by at most one chunk is a smaller lie than claiming the owner's
   *  bytes left when they may not have. § 6.3 asks the audit to record what
   *  LEFT, and this is the largest number that is certainly true. */
  readonly bytes_sent: number;
  /** Every request body in the walk, summed — chunk bodies plus the INIT /
   *  FINALIZE / STATUS payloads. This is what the audit's `bytes_out` carries. */
  readonly bytes_out: number;
  /** Every response body in the walk, summed. */
  readonly bytes_in: number;
  /** Why a walk ended other than `committed`. */
  readonly message?: string;
  /** Which phase was in flight when the walk failed.
   *
   *  ⛔ **`failed` alone is not enough to act on, and § 8.1's argument is the
   *  reason.** Fail-closed defines `failed` as *the asset was never created* —
   *  true when INIT or an APPEND failed, because FINALIZE is then unreachable.
   *  It is NOT true when FINALIZE ITSELF failed: the commit request went out,
   *  and whether it committed is exactly what could not be confirmed. Reporting
   *  that as a definite failure invites the retry that double-posts — the same
   *  hazard `committed_unconfirmed` exists to prevent on the poll side. The
   *  reducer is right to call both `failed` (neither is a success); the adapter
   *  is the layer that knows which, so it is the layer that decides how to
   *  surface it. */
  readonly failed_phase?: 'init' | 'append' | 'finalize' | 'status';
  /** The error the failing phase produced, so the caller can re-throw with the
   *  code the single-request path would have produced (`API_FORBIDDEN`,
   *  `STEP_TIMEOUT`, …) rather than flattening every protocol failure into one
   *  code that says nothing about what went wrong. */
  readonly failed_error?: IngredientError;
  /** FINALIZE's parsed response, when FINALIZE ran and answered.
   *
   *  ⛔ **The INIT response is deliberately NOT here, and neither is the
   *  session.** The handle INIT returns is state the WALK owns (§ 4.1);
   *  surfacing it would put a credential-adjacent value into `{{step.*}}` and
   *  the audit, and would let a recipe interleave unrelated calls between INIT
   *  and FINALIZE. A target that repeats its own id in the FINALIZE response
   *  (X does) is disclosing it by its own choice, not by ours. */
  readonly result?: unknown;
}

export class ChunkedWalkInputError extends Error {}

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate the walk descriptor that arrived on the wire.
 *
 *  ⚠ **It is engine-built, and it is still checked.** That is the same call
 *  `planChunkedUpload` makes about the declaration (§ 9.2): the alternative is
 *  trusting that whatever produced this input got it right, which is the
 *  assumption every "declared, not backed" seam rests on. The cost is one pass
 *  over five fields before any socket opens. */
export const parseChunkedWalkInput = (raw: unknown): ChunkedUploadWalkInput => {
  if (!isPlainRecord(raw)) {
    throw new ChunkedWalkInputError(
      `chunked upload: ${CHUNKED_UPLOAD_WIRE_WALK_KEY} must be an object describing the walk`,
    );
  }
  const spec = raw.spec;
  if (!isPlainRecord(spec)) {
    throw new ChunkedWalkInputError('chunked upload: the walk carries no upload declaration');
  }
  const file_ref = raw.file_ref;
  if (typeof file_ref !== 'string' || file_ref.length === 0) {
    throw new ChunkedWalkInputError(
      'chunked upload: the walk names no file — the bytes are addressed by ref, never carried',
    );
  }
  const expect_sha256 = raw.expect_sha256;
  if (expect_sha256 !== undefined
    && (typeof expect_sha256 !== 'string' || expect_sha256.length === 0)) {
    throw new ChunkedWalkInputError(
      'chunked upload: expect_sha256 must be a non-empty content hash when present',
    );
  }
  const total_bytes = raw.total_bytes;
  if (typeof total_bytes !== 'number') {
    throw new ChunkedWalkInputError('chunked upload: total_bytes must be a number');
  }
  const count = raw.count;
  if (!Number.isSafeInteger(count) || (count as number) <= 0) {
    throw new ChunkedWalkInputError(
      `chunked upload: count must be the positive APPEND count fixed before dispatch (got ${String(count)})`,
    );
  }
  const request_bound = raw.request_bound;
  if (!Number.isSafeInteger(request_bound) || (request_bound as number) <= 0) {
    throw new ChunkedWalkInputError(
      `chunked upload: request_bound must be the positive total request ceiling fixed before dispatch (got ${String(request_bound)})`,
    );
  }
  const args = raw.args;
  if (args !== undefined && !isPlainRecord(args)) {
    throw new ChunkedWalkInputError('chunked upload: args must be an object when present');
  }
  return {
    spec: spec as unknown as ChunkedUploadSpec,
    file_ref,
    ...(expect_sha256 !== undefined ? { expect_sha256 } : {}),
    total_bytes,
    count: count as number,
    request_bound: request_bound as number,
    ...(args !== undefined ? { args } : {}),
  };
};

/** ⛔ Depth 2, asserted rather than reasoned about.
 *
 *  The claim "a phase's params never carry the walk key" is what bounds the
 *  recursion, and an unbounded one would rebuild the amplification primitive
 *  the § 8a carve-out exists to forbid — by a different door, and without
 *  touching any of the rules that guard the front one.
 *
 *  ⚠ **Unreachable today, and the sweep says so in two different ways.** Every
 *  route into a phase input is already closed: `buildChunkedPhaseInput` refuses
 *  a `__`-prefixed declaration key, and the only keys this module adds itself
 *  are the four `__cu_*` chunk keys plus `timeout_ms`. So a mutation that
 *  deletes the guard survives, and so does one that passes it `{}` instead of
 *  the real input — the CALL SITE cannot be driven, because no reachable input
 *  carries the key.
 *
 *  ⇒ The body is therefore tested DIRECTLY (it is exported for that reason)
 *  rather than left to a path that does not exist, which is the honest version
 *  of a backstop: the guard works, it is wired at the one place a phase input
 *  is finalised, and it is redundant until something new can write that key.
 *  ⛔ Whoever adds the next phase-input source is the one this is for — and
 *  should expect the call-site mutant to start dying at that moment. */
export const assertNoNestedWalk = (input: Record<string, unknown>, phaseName: string): void => {
  if (Object.prototype.hasOwnProperty.call(input, CHUNKED_UPLOAD_WIRE_WALK_KEY)) {
    throw new ChunkedWalkInputError(
      `chunked upload ${phaseName}: a phase may not carry ${CHUNKED_UPLOAD_WIRE_WALK_KEY} — a walk cannot start a walk`,
    );
  }
};

const tokensFor = (
  phaseName: 'init' | 'append' | 'finalize' | 'status',
  plan: ChunkPlan,
  session: string | null,
  chunk: { index: number; offset: number; length: number } | undefined,
): ChunkedPhaseTokens => ({
  ...(session !== null ? { session } : {}),
  ...(chunk !== undefined
    ? { segment_index: chunk.index, chunk_offset: chunk.offset, chunk_length: chunk.length }
    // ⚠ INIT may reference `{chunk_length}` (the predicate allows it) and there
    // is no chunk yet. It can only mean the DECLARED per-chunk size — the
    // uniform length every APPEND but the last will carry — which is what a
    // target asking for a segment size at INIT wants.
    : phaseName === 'init' ? { chunk_length: plan.chunk_bytes } : {}),
  chunk_count: plan.count,
  total_bytes: plan.total_bytes,
});

const phaseFor = (
  spec: ChunkedUploadSpec,
  phaseName: 'init' | 'append' | 'finalize' | 'status',
): ChunkedUploadPhase | undefined =>
  phaseName === 'init' ? spec.init
    : phaseName === 'append' ? spec.append
      : phaseName === 'finalize' ? spec.finalize
        : spec.status;

/** Run one chunked upload: INIT → APPEND×N → FINALIZE → STATUS.
 *
 *  ⚠ **`failed` comes back as a RETURN VALUE, and the caller must not treat it
 *  as a success.** It is returned rather than thrown so the caller can record
 *  the partial egress before failing the step — the bytes left whether or not
 *  the act completed, and § 6.3 says the audit records what LEFT. The
 *  `connection.api` branch calls `ctx.setBytes` and THEN throws; a caller that
 *  forgot the second half would manufacture exactly the silent green this D's
 *  § 3 is an argument against. */
export const runChunkedUpload = async (args: {
  input: ChunkedUploadWalkInput;
  /** The staging handle the CALLER minted for this walk.
   *
   *  ⚠ It is a parameter rather than a wire field on purpose: a per-attempt
   *  token on the dispatch input would land in `canonical_payload_hash` and
   *  stop an honest repeat matching its grant. The wire names the file; the
   *  adapter stages it and owns its disposal. */
  staged: { token: string; size_bytes: number };
  connectionName: string;
  performPhase: PerformChunkedPhase;
  /** Injected so the deadline is drivable in a test rather than a wall clock. */
  now?: () => number;
  /** Injected wait primitive so target-directed polling delays are testable. */
  sleep?: (ms: number) => Promise<void>;
  maxWalkMs?: number;
}): Promise<ChunkedUploadRunResult> => {
  const { input, performPhase } = args;
  const now = args.now ?? (() => Date.now());
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }));
  const maxWalkMs = args.maxWalkMs ?? CHUNKED_UPLOAD_MAX_WALK_MS;

  // ⛔ The plan was computed from the size the ENGINE read out of the file's
  // metadata; the bytes were staged later, by the adapter. Between those two
  // moments the record could have been replaced. `expect_sha256` refuses that
  // at staging time when the engine supplied one — this refuses it either way,
  // and it is the check that actually protects the CHUNK BOUNDARIES: a plan
  // sized for a different file misaligns every offset while each request still
  // comes back 200, producing a corrupt asset the target accepts and stores.
  if (args.staged.size_bytes !== input.total_bytes) {
    throw new ChunkedWalkInputError(
      `chunked upload: the staged file is ${args.staged.size_bytes} bytes but the walk was planned `
      + `for ${input.total_bytes} — refused before any request is sent`,
    );
  }

  // Re-derive the plan from the declaration rather than trusting the chunk list
  // that arrived. `planChunkedUpload` re-runs the § 8a predicate, refuses an
  // over-ceiling file, and is the single place the count is computed.
  const plan = planChunkedUpload({ spec: input.spec, total_bytes: input.total_bytes });

  // 🔑 The approved count and the executable count are now PINNED to each
  // other. Both sides call the same function today, so this is a drift guard
  // rather than a live adversary guard — but it is the one that makes "one
  // approval buys N requests" true rather than merely intended: the adapter
  // cannot send a request the approved input did not account for.
  if (plan.count !== input.count) {
    throw new ChunkedWalkInputError(
      `chunked upload: the approved APPEND count (${input.count}) is not the count this declaration `
      + `produces (${plan.count}) — refused before any request is sent`,
    );
  }
  if (plan.request_bound !== input.request_bound) {
    throw new ChunkedWalkInputError(
      `chunked upload: the approved total request bound (${input.request_bound}) is not the bound this declaration `
      + `produces (${plan.request_bound}) — refused before any request is sent`,
    );
  }

  const deadline = now() + maxWalkMs;
  const opArgs = input.args ?? {};

  let bytesIn = 0;
  let bytesOut = 0;
  // Each inner call ends with `ctx?.setBytes(...)`, and `setBytes` OVERWRITES.
  // Handing the real ctx down would leave the audit reporting the last poll's
  // few hundred bytes as the whole act's egress.
  const accumulating: ConnectionHandlerCtx = {
    setBytes(in_: number, out: number) {
      bytesIn += in_;
      bytesOut += out;
    },
  };

  let state = startChunkedWalk(input.spec, plan);
  let requests = 0;
  let requestsSucceeded = 0;
  let requestsFailed = 0;
  let finalizeResult: unknown;
  let failedPhase: 'init' | 'append' | 'finalize' | 'status' | undefined;
  let failedError: IngredientError | undefined;

  for (;;) {
    const action = nextChunkedAction(state);
    if (action.kind === 'done') {
      return {
        outcome: action.outcome,
        requests,
        requests_succeeded: requestsSucceeded,
        requests_failed: requestsFailed,
        chunks_sent: action.chunks_sent,
        bytes_sent: action.bytes_sent,
        bytes_out: bytesOut,
        bytes_in: bytesIn,
        ...(action.message !== undefined ? { message: action.message } : {}),
        ...(finalizeResult !== undefined ? { result: finalizeResult } : {}),
        // Only meaningful on a failure, and carried only then — a `failed_phase`
        // riding along on a `committed` result would read as "something went
        // wrong here" to every consumer that checks the field before the
        // outcome.
        ...(action.outcome === 'failed' && failedPhase !== undefined
          ? { failed_phase: failedPhase }
          : {}),
        ...(action.outcome === 'failed' && failedError !== undefined
          ? { failed_error: failedError }
          : {}),
      };
    }

    const phaseName = action.kind;
    if (action.kind === 'status' && action.wait_ms > 0) {
      if (now() + action.wait_ms > deadline) {
        const timedOut = new IngredientError(
          'STEP_TIMEOUT',
          `chunked upload: target's ${action.wait_ms}ms poll delay exceeds the remaining walk bound`,
          {},
        );
        failedPhase = phaseName;
        failedError = timedOut;
        state = advanceChunkedWalk(state, { ok: false, message: timedOut.message });
        continue;
      }
      await sleep(action.wait_ms);
    }
    // ⚠ Checked BEFORE the dispatch, never after: a bound that only notices it
    // was exceeded once the request came back has already let the request out.
    if (now() > deadline) {
      const timedOut = new IngredientError(
        'STEP_TIMEOUT',
        `chunked upload: the ${maxWalkMs}ms walk bound elapsed before ${phaseName}`,
        {},
      );
      failedPhase = phaseName;
      failedError = timedOut;
      state = advanceChunkedWalk(state, { ok: false, message: timedOut.message });
      continue;
    }

    const result = await performOne({
      spec: input.spec,
      plan,
      phaseName,
      state,
      chunk: action.kind === 'append' ? action.chunk : undefined,
      staged: args.staged.token,
      opArgs,
      connectionName: args.connectionName,
      performPhase,
      ctx: accumulating,
    });
    if (result.performed) {
      requests += 1;
      if (result.outcome.ok) requestsSucceeded += 1;
      else requestsFailed += 1;
    }
    if (result.outcome.ok) {
      if (phaseName === 'finalize') finalizeResult = result.outcome.response;
    } else {
      failedPhase = phaseName;
      failedError = result.error;
    }
    state = advanceChunkedWalk(state, result.outcome);
  }
};

/** Build one phase's input and perform it. Never throws for a protocol reason —
 *  every failure becomes a `{ ok: false }` the reducer folds. */
const performOne = async (a: {
  spec: ChunkedUploadSpec;
  plan: ChunkPlan;
  phaseName: 'init' | 'append' | 'finalize' | 'status';
  state: { session: string | null };
  chunk: { index: number; offset: number; length: number } | undefined;
  staged: string;
  opArgs: Record<string, unknown>;
  connectionName: string;
  performPhase: PerformChunkedPhase;
  ctx: ConnectionHandlerCtx;
}): Promise<{ performed: boolean; outcome: ChunkedWalkResult; error?: IngredientError }> => {
  const phase = phaseFor(a.spec, a.phaseName);
  if (phase === undefined) {
    // `nextChunkedAction` only asks for `status` when the spec declares one, so
    // this is unreachable — and returning a fold rather than throwing keeps the
    // "the reducer decides" invariant true even on the unreachable path.
    const missing = new IngredientError(
      'BAD_INPUT',
      `chunked upload: no ${a.phaseName} phase is declared`,
      {},
    );
    return { performed: false, outcome: { ok: false, message: missing.message }, error: missing };
  }

  let input: Record<string, unknown>;
  try {
    // ⚠ This is the SUBSTITUTION point, and it is where `{session}` — the one
    // value in this protocol the TARGET chooses — turns into request text. The
    // § 9.3 locked-header refusal and the CR/LF refusal live inside
    // `buildChunkedPhaseInput` and therefore run HERE, per dispatch, rather
    // than only at authoring time against a declaration that may predate them.
    input = buildChunkedPhaseInput({
      phase,
      phaseName: a.phaseName,
      tokens: tokensFor(a.phaseName, a.plan, a.state.session, a.chunk),
      opArgs: a.opArgs,
      connectionName: a.connectionName,
    });
    assertNoNestedWalk(input, a.phaseName);
  } catch (e) {
    // A refused substitution means nothing was sent. Fold it: at INIT or APPEND
    // the reducer fails closed (no FINALIZE), at STATUS it reports
    // committed-but-unconfirmed — which is right, since FINALIZE already ran.
    const refused = new IngredientError('BAD_INPUT', (e as Error).message, {});
    return { performed: false, outcome: { ok: false, message: refused.message }, error: refused };
  }

  if (a.chunk !== undefined) {
    input[CHUNKED_UPLOAD_WIRE_TOKEN_KEY] = a.staged;
    input[CHUNKED_UPLOAD_WIRE_OFFSET_KEY] = a.chunk.offset;
    input[CHUNKED_UPLOAD_WIRE_LENGTH_KEY] = a.chunk.length;
    // Presence IS the encoding (§ 9.6): a field name ⇒ a named multipart part,
    // absent ⇒ the chunk is the raw body. The declaration validated the pair.
    if (a.spec.chunk_encoding === 'multipart' && a.spec.chunk_field !== undefined) {
      input[CHUNKED_UPLOAD_WIRE_FIELD_KEY] = a.spec.chunk_field;
    }
    // ⚠ An APPEND carries up to a 25 MB body; the handler's 30s default would
    // time out an ordinary chunk on a modest uplink and fail the whole act
    // closed. `resolveTimeoutMs` clamps to MAX_TIMEOUT_MS anyway — this asks
    // for the ceiling explicitly. The WALK is bounded separately, by the
    // deadline; a per-request timeout alone bounds nothing at 103 requests.
    input.timeout_ms = MAX_TIMEOUT_MS;
  }

  try {
    const response = await a.performPhase(input, a.ctx);
    return { performed: true, outcome: { ok: true, response } };
  } catch (e) {
    const error = e instanceof IngredientError
      ? e
      : new IngredientError('NETWORK_ERROR', (e as Error).message, {});
    // `performed: true` — the request WAS attempted. Whether its body reached
    // the socket is unknowable here, which is why `bytes_sent` counts only
    // completed APPENDs while this counter counts attempts.
    return {
      performed: true,
      outcome: { ok: false, message: `${error.code}: ${error.message}` },
      error,
    };
  }
};
