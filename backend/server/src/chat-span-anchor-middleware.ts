/** D-214 S0 — the before-turn hook that POPULATES the root-request edge.
 *
 *  The store (`storage/execution-span-anchor-store.ts`) holds the edge; this
 *  hook is what puts turns in it. It lives in `backend/` rather than
 *  `packages/middleware-recued/` for the ordinary reason: it performs IO, and
 *  `packages/` may not import `backend/`. `chat-scoped-grant-middleware.ts` is
 *  the structural precedent — a before-turn hook that writes durably and
 *  contributes nothing model-visible.
 *
 *  ⛔ **Contributes NOTHING to the prompt.** It calls neither
 *  `ctx.prompt.contribute` nor `ctx.resolve`. D-214's request-time augmentation
 *  is Slice 4; this hook only observes. A card appearing from here would be
 *  S4's job done in the wrong slice and unguarded by S4's anchoring metric.
 *
 *  ## Two kinds of continuation, deliberately handled differently
 *
 *  A stream is one user message plus its tool-loop turns. A *span* (§4.2) is a
 *  conversation, and can be larger than a stream: an approved plan re-issues on
 *  the user's **next** message, so a span containing an approval crosses
 *  streams by construction.
 *
 *  1. **Within a stream** — turns 1..N of one user message. Resolved from
 *     `ctx.state`, which is stream-scoped scratch: turn 0 records the root it
 *     opened, later turns read it. No query, no inference, exact.
 *  2. **Across streams** — an approval resumed later. This is the genuinely
 *     hard case, and it is behind the injected {@link SpanContinuationResolver}
 *     port rather than guessed here.
 *
 *  ⛔ **Why a port, and why the default is `undefined`.** At before-turn time we
 *  cannot tell whether the user's new message resumes the pending plan or
 *  starts something unrelated. Guessing wrong in the "continue" direction fails
 *  **OPEN** — the span is rooted at the *old* request and manufactures a wrong
 *  case. Guessing wrong in the "new root" direction fails **SAFE** — the resume
 *  loses its link and the case is merely lost. §8.2.2 chose the safe failure
 *  explicitly (re-keying fails open; suppression fails safe), so with no
 *  resolver wired this hook opens a fresh root and a cross-stream span simply
 *  does not compile. That is a known, bounded loss, not a silent one.
 *
 *  The port mirrors A23's `CaseCandidateSource`: the spec already blessed this
 *  shape for D-214's other uncertain dependency — ship the narrow contract, let
 *  the implementation land later, degrade rather than block. A resolver must
 *  answer from **durable plan / run / continuation correlation only**; ⛔ §4.2
 *  forbids deriving a span from timestamp proximity, and "the most recent
 *  pending thing" is exactly that.
 */

import type { Middleware, TurnContext } from '@recued/middleware';
import type { ExecutionSpanAnchorStore } from './storage/execution-span-anchor-store.js';

export const SPAN_ANCHOR_MIDDLEWARE_ID = 'd214-span-anchor';

/** `ctx.state` key — the stream-scoped root this hook opened or joined.
 *  Keyed by middleware id per the D-160 convention so two middlewares never
 *  collide. */
export const SPAN_ANCHOR_STATE_KEY = `${SPAN_ANCHOR_MIDDLEWARE_ID}:stream`;

/** Optional server-validated conversational continuation supplied by the chat
 * RPC shell. Unlike `root_request_id`, this names a prior turn in the same
 * session. The middleware resolves that turn through the durable anchor store;
 * callers can therefore request a continuation without choosing or forging a
 * root id. */
export const SPAN_ANCHOR_EXPLICIT_CONTINUATION_STATE_KEY =
  `${SPAN_ANCHOR_MIDDLEWARE_ID}:explicit-continuation`;

export interface SpanAnchorExplicitContinuation {
  origin_turn_id: string;
}

/** What the hook remembers across the turns of one stream. `last_turn_id` is
 *  what makes `origin_turn_id` exact — "which turn resumed which" is the
 *  lineage §4.2 walks, and it is not recoverable from the root alone once
 *  several turns share it. */
export interface SpanAnchorStreamState {
  root_request_id: string;
  last_turn_id: string;
}

/** ⛔ Must resolve from durable plan / run / continuation correlation ONLY.
 *  Returning a root on timestamp proximity would violate §4.2 and, worse,
 *  fail open. Returning `undefined` is always safe and is the default. */
export type SpanContinuationResolver = (input: {
  session_id: string;
  turn_id: string;
}) => { root_request_id: string; origin_turn_id?: string } | undefined;

export interface SpanAnchorDeps {
  readonly store: ExecutionSpanAnchorStore;
  /** Injected so tests are deterministic; production passes `randomUUID`. */
  readonly mintRootRequestId: () => string;
  /** Absent → cross-stream spans are not linked. See the header: this
   *  degrades, and it degrades in the safe direction. */
  readonly resolveContinuation?: SpanContinuationResolver;
  readonly now?: () => number;
}

const readState = (
  state: TurnContext['state'],
): SpanAnchorStreamState | undefined => {
  const raw = state.get(SPAN_ANCHOR_STATE_KEY);
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const candidate = raw as Partial<SpanAnchorStreamState>;
  return typeof candidate.root_request_id === 'string'
    && typeof candidate.last_turn_id === 'string'
    ? { root_request_id: candidate.root_request_id, last_turn_id: candidate.last_turn_id }
    : undefined;
};

const readExplicitContinuation = (
  state: TurnContext['state'],
): SpanAnchorExplicitContinuation | undefined => {
  const raw = state.get(SPAN_ANCHOR_EXPLICIT_CONTINUATION_STATE_KEY);
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const origin_turn_id =
    (raw as Partial<SpanAnchorExplicitContinuation>).origin_turn_id;
  return typeof origin_turn_id === 'string' && origin_turn_id.length > 0
    ? { origin_turn_id }
    : undefined;
};

/** The initiating user message of this stream. Read only at the moment a root
 *  is opened, where the latest user entry IS the initiating one — later turns
 *  of the same stream never re-read it, so a mid-span user interjection cannot
 *  silently re-root the span (§8.2.2). */
const latestUserText = (history: TurnContext['history']): string => {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role === 'user') return entry.text;
  }
  return '';
};

/** Build the anchor hook. `getDeps` resolves at turn time (late-bound), and an
 *  absent dep is a faithful no-op — the D-160 removability discipline (§0 R4:
 *  don't register, and D-214's footprint on the turn is nil). */
export const createSpanAnchorSource = (
  getDeps: () => SpanAnchorDeps | undefined,
): Middleware => ({
  id: SPAN_ANCHOR_MIDDLEWARE_ID,
  async prompt(ctx: TurnContext): Promise<void> {
    try {
      // V1 is chat-only (§5.3): `outcome.report` is a chat tool, so every V1
      // span has a planning model. Messenger / reception / scheduled spans
      // form no cases, so anchoring them would only accumulate dead rows.
      if (ctx.surface !== 'chat') return;
      const deps = getDeps();
      if (deps === undefined) return;
      const { store } = deps;
      const now = deps.now?.() ?? Date.now();

      // Idempotent: a replayed or retried turn keeps its first anchor. The
      // store refuses re-rooting anyway; returning here means we also never
      // mint a second root for it.
      const existing = store.getAnchor(ctx.session_id, ctx.turn_id);
      if (existing !== undefined) {
        ctx.state.set(SPAN_ANCHOR_STATE_KEY, {
          root_request_id: existing.root_request_id,
          last_turn_id: ctx.turn_id,
        } satisfies SpanAnchorStreamState);
        return;
      }

      // (1) Within-stream continuation — exact, from stream-scoped scratch.
      const streamState = readState(ctx.state);
      if (streamState !== undefined) {
        store.anchorTurn({
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          root_request_id: streamState.root_request_id,
          origin_turn_id: streamState.last_turn_id,
          now,
        });
        ctx.state.set(SPAN_ANCHOR_STATE_KEY, {
          root_request_id: streamState.root_request_id,
          last_turn_id: ctx.turn_id,
        } satisfies SpanAnchorStreamState);
        return;
      }

      // (2) Explicit cross-stream continuation. The RPC validates this as a
      // same-session prior turn and this hook resolves the opaque turn id to a
      // durable root itself. A caller never supplies `root_request_id`.
      const explicit = readExplicitContinuation(ctx.state);
      const explicitOriginTurnId = explicit?.origin_turn_id;
      const explicitOrigin = explicit
        ? store.getAnchor(ctx.session_id, explicit.origin_turn_id)
        : undefined;
      if (explicitOrigin !== undefined) {
        store.anchorTurn({
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          root_request_id: explicitOrigin.root_request_id,
          origin_turn_id: explicitOriginTurnId!,
          now,
        });
        ctx.state.set(SPAN_ANCHOR_STATE_KEY, {
          root_request_id: explicitOrigin.root_request_id,
          last_turn_id: ctx.turn_id,
        } satisfies SpanAnchorStreamState);
        return;
      }

      // (3) Cross-stream continuation — only when a durable correlation says
      // so. Absent resolver ⇒ falls through to a fresh root (fails safe).
      const continuation = deps.resolveContinuation?.({
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
      });
      // ⛔ Verify the resolved root EXISTS before joining it. The resolver is a
      // port someone else implements, and SQLite enforces foreign keys only
      // when `foreign_keys` is ON — so a resolver that names a root that was
      // evicted, never written, or simply wrong would otherwise insert a
      // dangling anchor. That degrades safely (the span cannot compile without
      // its root request) but it degrades SILENTLY, and a dangling row is
      // indistinguishable from a real one at read time. Falling through to a
      // fresh root keeps the failure both safe and visible.
      if (
        continuation !== undefined
        && store.getRoot(continuation.root_request_id) !== undefined
      ) {
        store.anchorTurn({
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          root_request_id: continuation.root_request_id,
          ...(continuation.origin_turn_id !== undefined
            ? { origin_turn_id: continuation.origin_turn_id }
            : {}),
          now,
        });
        ctx.state.set(SPAN_ANCHOR_STATE_KEY, {
          root_request_id: continuation.root_request_id,
          last_turn_id: ctx.turn_id,
        } satisfies SpanAnchorStreamState);
        return;
      }

      // (4) A new span. No root user request ⇒ no anchor: §8.2 eligibility
      // needs a matchable request shape, so a rootless span would only ever
      // produce a row nothing can key on.
      const root_request = latestUserText(ctx.history);
      if (root_request.length === 0) return;

      const root_request_id = deps.mintRootRequestId();
      await store.openSpan({
        root_request_id,
        session_id: ctx.session_id,
        surface: ctx.surface,
        root_request,
        turn_id: ctx.turn_id,
        now,
      });
      ctx.state.set(SPAN_ANCHOR_STATE_KEY, {
        root_request_id,
        last_turn_id: ctx.turn_id,
      } satisfies SpanAnchorStreamState);
    } catch {
      // Best-effort by design. D-214 is an OBSERVATION substrate and is
      // advisory end to end (#13/#23) — a lost anchor costs one uncompiled
      // span, while a thrown error would cost the user their turn. A locked
      // FileVault lands here too, and losing the span is the correct outcome:
      // the alternative is storing the prompt unsealed.
    }
  },
});
