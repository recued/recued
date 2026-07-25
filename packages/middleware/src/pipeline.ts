/** D-160 P1 — the turn pipeline (§ N.2 / A.2).
 *
 *  `runStream` is the framework runner — a thin coordinator. It builds
 *  the registry's enabled set, runs `config` once, then loops
 *  `prompt → TURN → update` until a middleware signals done (or, with
 *  no middleware, after the first turn). The turn — one AI call plus
 *  its tool handling — is the framework-owned wrapped operation,
 *  resolved through the injected `TurnExecutor`; it is never a hook.
 *
 *      stream start
 *        before     : enabled middleware → config(StreamContext)
 *        loop:
 *          before-turn : enabled middleware → prompt(TurnContext)
 *          TURN        : runTurn(TurnContext)  — or a prompt-hook short-circuit
 *          after-turn  : enabled middleware → update(TurnResult)
 *        until done
 *
 *  The pipeline is the third flow controller — a peer of `engine` and
 *  `gateway`. It contains no cognition logic and no middleware
 *  implementation; the middlewares register and do the work (I-3).
 *
 *  Spec: docs/d-160-spec.md § N.2 / A.2.
 */

import type { Channel, ChannelInbound, SessionStateStore } from '@recued/chat';

import {
  capacityBreach,
  createCapacity,
  narrowCapacity,
  type Capacity,
} from './capacity.js';
import { createOutStream, projectTurnToOutStream } from './out-stream.js';
import type { MiddlewareRegistry } from './registry.js';
import type {
  PromptContribution,
  PromptDraft,
  PromptPart,
  StreamContext,
  TurnContext,
  TurnExecutor,
  TurnOutput,
  TurnResult,
} from './types.js';

/** Why a stream ended. */
export type StreamDoneReason = 'completed' | 'capacity_exhausted';

export interface RunStreamInput {
  /** The registry the pipeline iterates at each lifecycle hook. */
  readonly registry: MiddlewareRegistry;
  /** The channel the out-stream is delivered over. */
  readonly channel: Channel;
  /** The shared session-state store — read for conversation history.
   *  The pipeline never *writes* the store directly: an assistant
   *  message reaches the store through `channel.deliver`. */
  readonly sessionStore: SessionStateStore;
  /** The triggering inbound user message. The channel records it in
   *  the store before `runStream` is invoked. */
  readonly inbound: ChannelInbound;
  /** The injected AI call — one turn. `backend/server/` wires this to
   *  `@recued/llm`; tests pass a stub. */
  readonly runTurn: TurnExecutor;
  /** The stream's capacity envelope. Omitted fields take framework
   *  defaults; a `config` hook may narrow it further. */
  readonly capacity?: Partial<Capacity>;
  /** Injectable turn-id minter — defaults to a random uuid. */
  readonly mintId?: () => string;
  /** Caller-provided middleware-scratch map. The framework defaults to a
   *  fresh `Map` per stream; a caller that needs to READ a hook's
   *  decisions back after the stream completes (the N.9 "hooks DECIDE →
   *  write `state`; the orchestrator shell ENACTs → reads `state`"
   *  discipline — e.g. the chat orchestrator surfacing an `update` hook's
   *  result on its finalize) passes its own per-stream map here. The
   *  framework treats it identically to the default map; passing a map
   *  pre-seeded with keys a hook reads is the caller's responsibility. */
  readonly state?: Map<string, unknown>;
}

/** What a completed stream reports. */
export interface StreamSummary {
  readonly session_id: string;
  /** Turns that ran — at least 1 (`Capacity.max_turns` is ≥ 1). */
  readonly turns: number;
  readonly done_reason: StreamDoneReason;
  /** The final assistant text — the last turn's output. */
  readonly final_text: string;
  /** `ChannelOutbound` events delivered over the channel. */
  readonly out_events: number;
}

const defaultMintId = (): string => {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof g?.randomUUID === 'function') return g.randomUUID();
  // Fallback for runtimes without `crypto.randomUUID`.
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

/** A `PromptDraft` plus the framework-internal handle that stamps the
 *  contributing middleware's id onto every part. The pipeline sets the
 *  contributor before each `prompt` hook so a `PromptPart` records who
 *  wrote it without the hook having to pass its own id. */
const createPromptDraft = (): {
  draft: PromptDraft;
  setContributor: (source: string) => void;
} => {
  const parts: PromptPart[] = [];
  let contributor = 'framework';
  return {
    draft: {
      contribute(part: PromptContribution): void {
        // Stamp `source` LAST so a foreign `source` property on the contributed
        // object can never override the framework's contributor stamp — the chat
        // gather selects parts by `source` (correction-learning text, prompt-cache
        // entity parts), so a spoofable stamp would let any caller feed
        // entity payload/render into the model-bound prefetch context.
        parts.push({ ...part, source: contributor });
      },
      parts(): readonly PromptPart[] {
        return parts;
      },
    },
    setContributor(source: string): void {
      contributor = source;
    },
  };
};

/** Run one stream — drive the turn loop to completion and return a
 *  summary. The loop is hard-bounded by the capacity envelope's
 *  `max_turns`; with no middleware enabled it runs exactly one turn
 *  and ends `completed`. */
export const runStream = async (
  input: RunStreamInput,
): Promise<StreamSummary> => {
  const mintId = input.mintId ?? defaultMintId;
  const { inbound } = input;
  const { session_id, surface } = inbound;

  const out = createOutStream(input.channel, session_id);
  const state = input.state ?? new Map<string, unknown>();

  // The capacity envelope the request declared. `createCapacity`
  // validates it here, before the stream goes live, so a malformed
  // `Capacity` fails fast without touching the channel.
  const requestedCapacity = createCapacity(input.capacity);

  // The stream context the `config` hooks receive.
  const streamCtx: StreamContext = {
    session_id,
    surface,
    user_message: inbound.text,
    history: input.sessionStore.history(session_id),
    capacity: requestedCapacity,
    out,
    state,
  };

  let turns = 0;
  let tokens = 0;
  let lastText = '';
  let lastTurnId = '';
  let doneReason: StreamDoneReason = 'completed';

  try {
    // ── before — `config` hooks, once, pre-loop. The enabled set is
    //    re-read here, and at every later hook, so a middleware
    //    enabled / disabled mid-stream is honoured (N.3 / A.3). ──
    for (const mw of input.registry.enabled()) {
      await mw.config?.(streamCtx);
    }
    // A `config` hook may only NARROW the envelope. Re-narrow whatever
    // it left against the request's envelope (`narrowCapacity` is the
    // element-wise minimum / set intersection) so a hook that widened —
    // or wholesale replaced — `streamCtx.capacity` can never escape the
    // declared ceiling (N.4).
    const capacity = narrowCapacity(requestedCapacity, streamCtx.capacity);

    for (;;) {
      const turn_id = mintId();
      lastTurnId = turn_id;
      const turn_index = turns;
      const { draft, setContributor } = createPromptDraft();
      let resolvedText: string | undefined;
      let resolveCalled = false;

      const turnCtx: TurnContext = {
        session_id,
        surface,
        // The channel-minted source rides every turn of the stream — a
        // policy-consulting hook reads the REAL `(channel × actor)`
        // identity instead of re-deriving a stand-in from the surface tag.
        source: inbound.source,
        turn_index,
        turn_id,
        history: input.sessionStore.history(session_id),
        prompt: draft,
        // Interjections that arrived since the last turn. P1 carries
        // the field; populating it is the D-160 O-3 interjection-UX
        // work, still pending — no producer populates it yet, so a
        // `prompt` hook reads an empty list.
        interjections: [],
        capacity,
        out,
        state,
        resolve(text: string): void {
          if (resolveCalled) {
            throw new Error(
              'TurnContext.resolve called twice for one turn',
            );
          }
          resolveCalled = true;
          resolvedText = text;
        },
      };

      // ── before-turn — `prompt` hooks ──
      for (const mw of input.registry.enabled()) {
        setContributor(mw.id);
        await mw.prompt?.(turnCtx);
        // A `prompt` hook may resolve the turn deterministically (the
        // stage-0 short-circuit, N.2). First resolver wins — the
        // before-turn phase ends, later `prompt` hooks do not run.
        if (resolveCalled) break;
      }
      setContributor('framework');

      // ── TURN — one AI call, or a prompt-hook deterministic
      //    short-circuit (the stage-0 case). The turn is internal. ──
      let output: TurnOutput;
      let resolvedWithoutAi: boolean;
      if (resolvedText !== undefined) {
        output = { text: resolvedText };
        resolvedWithoutAi = true;
      } else {
        output = await input.runTurn(turnCtx);
        resolvedWithoutAi = false;
      }

      turns += 1;
      tokens += output.tokens ?? 0;
      lastText = output.text;

      // Project the internal turn — tool activity becomes transparency
      // notes (I-6). The turn's text is not surfaced here; the final
      // answer is emitted once, after the loop.
      await projectTurnToOutStream(out, turn_id, output);

      // ── after-turn — `update` hooks ──
      let continueRequested = false;
      let doneSignaled = false;
      const turnResult: TurnResult = {
        session_id,
        surface,
        turn_index,
        turn_id,
        resolved_without_ai: resolvedWithoutAi,
        output,
        history: input.sessionStore.history(session_id),
        capacity,
        out,
        state,
        requestContinue(): void {
          continueRequested = true;
        },
        signalDone(): void {
          doneSignaled = true;
        },
      };
      for (const mw of input.registry.enabled()) {
        await mw.update?.(turnResult);
      }

      // Termination. A `signalDone`, or no middleware requesting
      // another turn, ends the stream `completed` — `done` beats
      // `continue` (N.8 SHOULD). When a middleware does want another
      // turn, the post-turn capacity gate decides: the next turn runs
      // only if the envelope can still afford it, else the stream ends
      // `capacity_exhausted`. The framework enforces the ceiling by
      // refusing to *start* an over-budget turn (N.4) — the gate sits
      // here, after the turn, so it sees this turn's token spend.
      if (doneSignaled || !continueRequested) {
        doneReason = 'completed';
        break;
      }
      if (capacityBreach({ turns, tokens }, capacity) !== null) {
        doneReason = 'capacity_exhausted';
        break;
      }
    }
  } catch (e) {
    // A throw from any hook (`config` / `prompt` / `update`) or the
    // turn executor propagates — failure semantics are a middleware
    // concern, not the framework's. Emit a best-effort `done` first so
    // the channel is not left with a half-open stream, then rethrow.
    // `lastTurnId` is empty only when the throw came from a `config`
    // hook (no turn minted yet) — mint an id for the terminal event.
    try {
      await out.done(lastTurnId || mintId());
    } catch {
      // The channel itself failed — nothing more the framework can do.
    }
    throw e;
  }

  // ── final projection — the assistant answer, emitted once ──
  await out.message(lastTurnId, lastText);
  await out.done(lastTurnId);

  return {
    session_id,
    turns,
    done_reason: doneReason,
    final_text: lastText,
    out_events: out.delivered(),
  };
};
