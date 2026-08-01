/** D-217 slice 2a — the chunked-upload walk: the plan, and the state machine.
 *
 *  `followPagination` is the read-side multi-request walker and it refuses to
 *  re-dispatch a write op (Invariant 1). This is the write-side one, permitted
 *  only under the § 8a carve-out:
 *
 *  > the number of requests is fixed before the first dispatch and is
 *  > independent of every value the target returns.
 *
 *  🔑 **`planChunkedUpload` is where that stops being a sentence.** It computes
 *  `ceil(total_bytes / chunk_bytes)` ONCE, before anything is dispatched, and
 *  the reducer below can only ever walk the plan it was given. There is no
 *  transition that appends to it, and no response value is read for anything
 *  but the session handle and the poll's done-condition.
 *
 *  ⚠ **A NEW responsibility this declaration did not have in D-216.** There,
 *  `bind.upload` is a manifest DISCLOSURE — the runtime egress is driven by the
 *  op's `body_file.*` wire args, and nothing reads the declaration at dispatch.
 *  A multi-request protocol has no single set of wire params, so here the
 *  declaration IS the program. That makes slice 1's predicate load-bearing at
 *  RUN time, not only at authoring time — which is why `planChunkedUpload`
 *  re-runs it rather than trusting that validation happened. An installed pack
 *  may predate the rule or have arrived through a path that skipped it.
 *
 *  Pure by construction: no DOM, no socket, no connection. The gateway supplies
 *  responses and performs dispatches; every ordering, bounding and fail-closed
 *  rule lives here where it can be driven directly.
 */

import {
  CHUNKED_UPLOAD_MAX_POLLS_CEILING,
  HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING,
  chunkedUploadBoundViolations,
  isLockedInputKey,
  type ChunkedUploadOutcome,
  type ChunkedUploadPhase,
  type ChunkedUploadSpec,
} from '@recued/contracts';

/** One APPEND's slice of the file. */
export interface ChunkPlanEntry {
  index: number;
  offset: number;
  length: number;
}

/** The whole walk, sized before the first byte leaves. */
export interface ChunkPlan {
  chunks: readonly ChunkPlanEntry[];
  /** APPEND count; the file-size multiplier inside the total bound. */
  count: number;
  /** INIT + APPEND count + FINALIZE + the maximum declared polls. */
  request_bound: number;
  total_bytes: number;
  chunk_bytes: number;
}

export class ChunkedUploadPlanError extends Error {}

/** Compute the walk. Throws rather than returning a partial plan: a plan that
 *  is wrong is worse than no upload, because the bytes leave either way. */
export const planChunkedUpload = (args: {
  spec: ChunkedUploadSpec;
  total_bytes: number;
}): ChunkPlan => {
  // Re-run the carve-out at RUN time. Cheap (a pure function over the
  // declaration) and the alternative is trusting that every install path
  // validated — which is the assumption a "declared, not backed" seam is
  // always built on.
  const violations = chunkedUploadBoundViolations(args.spec);
  if (violations.length > 0) {
    throw new ChunkedUploadPlanError(
      `chunked upload declaration fails the D-217 § 8a request-count bound: `
      + violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
    );
  }

  const { chunk_bytes } = args.spec;
  const total = args.total_bytes;
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new ChunkedUploadPlanError(
      `chunked upload: total_bytes must be a positive safe integer (got ${total})`,
    );
  }
  // The effective ceiling is the op's own when it lowered it, else the
  // handler's. `chunkedUploadBoundViolations` already refused a raised one, so
  // `min` here is belt-and-braces rather than the enforcement point.
  const cap = Math.min(
    args.spec.max_bytes ?? HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING,
    HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING,
  );
  if (total > cap) {
    throw new ChunkedUploadPlanError(
      `chunked upload: ${total} bytes is over the ${cap}-byte ceiling — refused before any request is sent`,
    );
  }

  const count = Math.ceil(total / chunk_bytes);
  const request_bound = 2 + count + (args.spec.status?.max_polls ?? 0);
  const chunks: ChunkPlanEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * chunk_bytes;
    chunks.push({ index, offset, length: Math.min(chunk_bytes, total - offset) });
  }
  return { chunks, count, request_bound, total_bytes: total, chunk_bytes };
};

// ────────────────────────────────────────────────────────────────
// The walk
// ────────────────────────────────────────────────────────────────

/** How a walk ended.
 *
 *  🔑 An ALIAS, not a second declaration — the union lives in contracts
 *  (`ChunkedUploadOutcome`) because the audit names it too, and a vocabulary
 *  copied into a second place rots without typechecking complaining (a subset
 *  is still assignable). The alias keeps this module's existing export name. */
export type ChunkedWalkOutcome = ChunkedUploadOutcome;

export type ChunkedWalkAction =
  | { readonly kind: 'init' }
  | { readonly kind: 'append'; readonly chunk: ChunkPlanEntry }
  | { readonly kind: 'finalize' }
  | { readonly kind: 'status'; readonly attempt: number; readonly wait_ms: number }
  | {
      readonly kind: 'done';
      readonly outcome: ChunkedWalkOutcome;
      readonly bytes_sent: number;
      readonly chunks_sent: number;
      readonly message?: string;
    };

/** What the gateway hands back after performing an action. */
export type ChunkedWalkResult =
  | { readonly ok: true; readonly response: unknown }
  | { readonly ok: false; readonly message: string };

export interface ChunkedWalkState {
  readonly plan: ChunkPlan;
  readonly spec: ChunkedUploadSpec;
  readonly phase: 'init' | 'append' | 'finalize' | 'status' | 'done';
  /** Index of the NEXT append. */
  readonly next_chunk: number;
  /** Polls already performed. */
  readonly polls: number;
  /** Delay fixed from the preceding response and clamped by the declaration. */
  readonly poll_delay_ms: number;
  /** The INIT handle, once INIT answered. */
  readonly session: string | null;
  readonly bytes_sent: number;
  readonly outcome: ChunkedWalkOutcome | null;
  readonly message?: string;
}

export const startChunkedWalk = (
  spec: ChunkedUploadSpec,
  plan: ChunkPlan,
): ChunkedWalkState => ({
  plan,
  spec,
  phase: 'init',
  next_chunk: 0,
  polls: 0,
  poll_delay_ms: 0,
  session: null,
  bytes_sent: 0,
  outcome: null,
});

/** The action the gateway should perform next. Total over the state space. */
export const nextChunkedAction = (s: ChunkedWalkState): ChunkedWalkAction => {
  switch (s.phase) {
    case 'init':
      return { kind: 'init' };
    case 'append': {
      const chunk = s.plan.chunks[s.next_chunk];
      // Unreachable while `advance` only enters `append` below the count, but
      // a total function beats a `!` here: this decides whether bytes are sent.
      if (chunk === undefined) return { kind: 'finalize' };
      return { kind: 'append', chunk };
    }
    case 'finalize':
      return { kind: 'finalize' };
    case 'status':
      return { kind: 'status', attempt: s.polls + 1, wait_ms: s.poll_delay_ms };
    case 'done':
    default:
      return {
        kind: 'done',
        outcome: s.outcome ?? 'failed',
        bytes_sent: s.bytes_sent,
        chunks_sent: s.next_chunk,
        ...(s.message !== undefined ? { message: s.message } : {}),
      };
  }
};

const fail = (s: ChunkedWalkState, message: string): ChunkedWalkState =>
  ({ ...s, phase: 'done', outcome: 'failed', message });

/** Fold one performed action's result into the walk.
 *
 *  ⛔ **Fail-closed is expressed here and only here (§ 8c):** every non-`ok`
 *  result moves straight to `done`/`failed`, and NO transition reaches
 *  `finalize` from a failed append. The commit request is therefore
 *  unreachable after any chunk error — the asset never comes into existence,
 *  which is what "failed" is defined to mean. */
export const advanceChunkedWalk = (
  s: ChunkedWalkState,
  result: ChunkedWalkResult,
): ChunkedWalkState => {
  if (s.phase === 'done') return s;

  if (!result.ok) {
    // ⚠ A failed STATUS poll is NOT a failed upload. FINALIZE already
    // succeeded, so the asset exists; treat a poll error like a poll that did
    // not confirm (§ 8.1) rather than reporting a good upload as failed.
    if (s.phase === 'status') {
      return { ...s, phase: 'done', outcome: 'committed_unconfirmed', message: result.message };
    }
    return fail(s, result.message);
  }

  switch (s.phase) {
    case 'init': {
      const session = readPath(result.response, s.spec.session_from);
      if (typeof session !== 'string' || session.length === 0) {
        // Without a handle the appends cannot address anything. Refuse before
        // sending bytes rather than appending to nowhere.
        return fail(
          s,
          `chunked upload: INIT response has no session at '${s.spec.session_from}'`,
        );
      }
      // An empty plan cannot happen (`planChunkedUpload` refuses total <= 0),
      // but routing on the count rather than assuming ≥1 keeps the machine
      // total.
      return {
        ...s,
        session,
        phase: s.plan.count > 0 ? 'append' : 'finalize',
        next_chunk: 0,
      };
    }
    case 'append': {
      const sent = s.plan.chunks[s.next_chunk]?.length ?? 0;
      const next_chunk = s.next_chunk + 1;
      return {
        ...s,
        next_chunk,
        bytes_sent: s.bytes_sent + sent,
        phase: next_chunk >= s.plan.count ? 'finalize' : 'append',
      };
    }
    case 'finalize': {
      if (s.spec.status === undefined) {
        return { ...s, phase: 'done', outcome: 'committed' };
      }
      return {
        ...s,
        phase: 'status',
        polls: 0,
        poll_delay_ms: readPollDelayMs(result.response, s.spec.status.retry_after),
      };
    }
    case 'status': {
      const status = s.spec.status;
      const polls = s.polls + 1;
      if (status !== undefined) {
        if (status.failed !== undefined) {
          const failed = readPath(result.response, status.failed.path);
          if (failed === status.failed.equals) {
            return {
              ...s,
              polls,
              phase: 'done',
              outcome: 'processing_failed',
              message: `target reported terminal processing state '${status.failed.equals}'`,
            };
          }
        }
        const seen = readPath(result.response, status.done.path);
        if (seen === status.done.equals) {
          return { ...s, polls, phase: 'done', outcome: 'committed' };
        }
        // Bounded twice: the declaration's literal `max_polls`, itself capped.
        const limit = Math.min(status.max_polls, CHUNKED_UPLOAD_MAX_POLLS_CEILING);
        if (polls >= limit) {
          return {
            ...s,
            polls,
            phase: 'done',
            outcome: 'committed_unconfirmed',
            message: `status did not reach '${status.done.equals}' within ${limit} poll(s)`,
          };
        }
      }
      return {
        ...s,
        polls,
        poll_delay_ms: readPollDelayMs(result.response, status?.retry_after),
      };
    }
    default:
      return s;
  }
};

const readPollDelayMs = (
  response: unknown,
  retry: NonNullable<ChunkedUploadSpec['status']>['retry_after'],
): number => {
  if (retry === undefined) return 0;
  const raw = readPath(response, retry.path);
  const requested = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? raw * (retry.unit === 'seconds' ? 1_000 : 1)
    : retry.default_ms;
  return Math.min(Math.trunc(requested), retry.max_ms);
};

// ────────────────────────────────────────────────────────────────
// Phase → dispatch input
// ────────────────────────────────────────────────────────────────

/** The values available for `{token}` substitution in one phase. */
export interface ChunkedPhaseTokens {
  /** The INIT handle. Absent during INIT itself. */
  readonly session?: string;
  readonly segment_index?: number;
  readonly chunk_offset?: number;
  readonly chunk_length?: number;
  readonly chunk_count: number;
  readonly total_bytes: number;
}

export class ChunkedPhaseInputError extends Error {}

const TOKEN_SCAN = /\{([a-zA-Z0-9_]+)\}/g;
/** A value that is EXACTLY one token and nothing else — the "pure reference"
 *  case the recipe value system resolves without stringifying. */
const TOKEN_WHOLE = /^\{([a-zA-Z0-9_]+)\}$/;

/** Turn one declared phase into a `connection.api` dispatch input.
 *
 *  🔑 **This is where slice 1's closed token set stops being a rule and starts
 *  being behaviour.** The predicate says which `{token}`s a phase may name; this
 *  is what substitutes them — and an unresolved one THROWS rather than shipping
 *  the literal text `{session}` to the target, which would otherwise look like a
 *  successful request carrying nonsense.
 *
 *  ⚠ **Two things here are hostile-input paths, and neither is obvious:**
 *
 *   1. **The phase's own keys come from a third-party MANIFEST.** They never
 *      pass through `buildApiDispatchInput`'s locked-key strip, which filters
 *      RECIPE args. `chunkedUploadBoundViolations` rejects a locked header at
 *      authoring time; this re-checks at dispatch, the same belt-and-braces
 *      discipline the REST binding's `static_headers` already uses.
 *   2. **`{session}` is TARGET-CONTROLLED.** It arrives in the INIT response and
 *      flows into paths, queries and headers. A session carrying CR/LF would
 *      inject a header; one carrying nothing at all would silently address the
 *      wrong resource. Both are refused. */
export const buildChunkedPhaseInput = (args: {
  phase: ChunkedUploadPhase;
  phaseName: 'init' | 'append' | 'finalize' | 'status';
  tokens: ChunkedPhaseTokens;
  /** The op's own declared args, for `{arg}` references. */
  opArgs: Record<string, unknown>;
  connectionName: string;
}): Record<string, unknown> => {
  const { phase, phaseName, tokens } = args;

  const substitute = (text: string, where: string): string =>
    text.replace(TOKEN_SCAN, (whole, token: string) => {
      const engine = (tokens as unknown as Record<string, unknown>)[token];
      const value = engine !== undefined
        ? engine
        : Object.prototype.hasOwnProperty.call(args.opArgs, token)
          ? args.opArgs[token]
          : undefined;
      if (value === undefined || value === null) {
        // Never leave the literal `{token}` in place: the request would go out
        // looking fine and address nothing.
        throw new ChunkedPhaseInputError(
          `chunked upload ${phaseName}: '${where}' references {${token}}, which is not available in this phase`,
        );
      }
      if (typeof value === 'object') {
        throw new ChunkedPhaseInputError(
          `chunked upload ${phaseName}: '${where}' references {${token}}, which is not a scalar`,
        );
      }
      void whole;
      return String(value);
    });

  /** Resolve ONE declared value, preserving a pure reference's TYPE.
   *
   *  🔑 **The same rule the recipe value system already states:** `"{{ref}}"`
   *  resolves and preserves type, `"text {{ref}}"` interpolates to a string.
   *  A phase's `body` becomes a JSON request body, and without this it could
   *  not express a JSON NUMBER at all — every field would serialize as
   *  `"104857600"` against a schema declaring an integer. That is a hole in
   *  what a declaration can say, not a preference about one vendor.
   *
   *  ⚠ **Body only.** A path, a query param and a header are text on the wire
   *  by construction, so "preserving" a number there would mean nothing and
   *  the CR/LF + traversal checks all assume a string. */
  const resolveBodyValue = (text: string, where: string): string | number | boolean => {
    const whole = text.match(TOKEN_WHOLE);
    if (whole === null) return substitute(text, where);
    const token = whole[1]!;
    const engine = (tokens as unknown as Record<string, unknown>)[token];
    const value = engine !== undefined
      ? engine
      : Object.prototype.hasOwnProperty.call(args.opArgs, token)
        ? args.opArgs[token]
        : undefined;
    // Anything not a bare scalar falls back to the string path, which owns the
    // unresolved-token and non-scalar refusals — one place decides those.
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    return substitute(text, where);
  };

  // Null-proto so a `__proto__` key in a manifest phase lands as an own
  // property, mirroring `buildApiDispatchInput`.
  const input: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  input.method = phase.method;
  input.path = substitute(phase.path, `${phaseName}.path`);
  input.connection = args.connectionName;

  for (const [bag, prefix] of [
    ['query', 'query.'], ['headers', 'header.'], ['body', 'body.'],
  ] as const) {
    const values = phase[bag];
    if (values === undefined) continue;
    for (const [key, raw] of Object.entries(values)) {
      const wireKey = `${prefix}${key}`;
      const lower = wireKey.trim().toLowerCase();
      // Re-check at dispatch. The authoring gate is the predicate; this is the
      // one that runs against whatever actually got installed.
      if (isLockedInputKey(lower)) {
        throw new ChunkedPhaseInputError(
          `chunked upload ${phaseName}: '${wireKey}' is engine-locked and may not be set by a declaration`,
        );
      }
      // ⚠ Test the BAG key, not the prefixed wire key — `query.__rc_capture`
      // does not start with `__`, so checking `wireKey` here silently admitted
      // every engine-owned key. A test caught it.
      if (key.trim().startsWith('__')) {
        throw new ChunkedPhaseInputError(
          `chunked upload ${phaseName}: '${wireKey}' uses the engine-owned '__' prefix`,
        );
      }
      const value = bag === 'body'
        ? resolveBodyValue(raw, `${phaseName}.${bag}.${key}`)
        : substitute(raw, `${phaseName}.${bag}.${key}`);
      if (bag === 'headers' && typeof value === 'string' && /[\r\n]/.test(value)) {
        // The session is target-controlled and lands here; a CR/LF in it would
        // append headers of the target's choosing to our authenticated request.
        throw new ChunkedPhaseInputError(
          `chunked upload ${phaseName}: header '${key}' resolved to a value containing CR/LF`,
        );
      }
      input[wireKey] = value;
    }
  }
  return input;
};

/** Read a dotted path out of a response. Own-property walk only — a path like
 *  `constructor.name` must not resolve, since the path comes from a
 *  third-party manifest. */
const readPath = (value: unknown, path: string): unknown => {
  let cur: unknown = value;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
};
