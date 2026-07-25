/** D-160 P1 — the stream-middleware framework types.
 *
 *  The normative N.2 three-hook middleware interface + the stream /
 *  turn lifecycle contexts the hooks receive. A `Middleware` is
 *  exactly three optional handlers (I-5) — `config` / `prompt` /
 *  `update`; a middleware that needs a fourth hook is a sign the
 *  interface is wrong, not the middleware.
 *
 *  Lifecycle-point names (`before` / `before-turn` / `after-turn`) are
 *  framework concepts; handler names (`config` / `prompt` / `update`)
 *  are middleware concepts — both naming sets are normative (N.2).
 *
 *  Spec: docs/d-160-spec.md § N.2 / A.1 / A.2.
 */

import type { ChannelOutbound, SessionEntry, SurfaceTag } from '@recued/chat';
import type { ExecutionSource } from '@recued/contracts';

import type { Capacity } from './capacity.js';

// ── The transparency out-stream ─────────────────────────────────────

/** The transparency out-stream (§ N.6) — the pipeline's continuous,
 *  user-facing output. A turn is internal (N.2); what reaches the user
 *  is a *selective projection* over turns, and this is the typed gate
 *  that carries it. Each method builds one `ChannelOutbound` and hands
 *  it to the channel. */
export interface OutStream {
  /** Stream a partial token delta for the in-progress turn. */
  token(turn_id: string, delta: string): Promise<void>;
  /** Emit a transparency note — the projection of internal turn
   *  activity (a tool call, a reasoning step) the user should see
   *  without being shown the raw turn. */
  note(turn_id: string, text: string): Promise<void>;
  /** Emit a completed assistant message — a conversation entry. */
  message(turn_id: string, text: string): Promise<void>;
  /** Mark the stream complete. */
  done(turn_id: string): Promise<void>;
  /** Count of `ChannelOutbound` events delivered so far — feeds the
   *  stream summary and the I-6 projection tests. */
  delivered(): number;
}

/** The four `ChannelOutbound` kinds the out-stream emits — re-exported
 *  so framework consumers need not also reach into `@recued/chat`. */
export type { ChannelOutbound };

// ── The assembled prompt ────────────────────────────────────────────

/** A free-text contribution to a turn's prompt — trusted `system`
 *  instructions or `context` prose. `source` is stamped by the
 *  framework with the contributing middleware's id (or `'framework'`
 *  for the framework's own contributions) — a `prompt` hook supplies
 *  only `role` + `text`. */
export interface TextPromptPart {
  readonly source: string;
  readonly role: 'system' | 'context';
  readonly text: string;
}

/** D-167 N.10.3 — user-authored conversation text. Unlike trusted
 *  `system` prose and middleware `context`, these parts are free text
 *  (`user_message` + `chat_tail`) that may mention entities already
 *  seeded by structured entity parts. The chat executor assembles them
 *  back into the stable model-packet fields after the privacy gather. */
export interface ContentPromptPart {
  readonly source: string;
  readonly role: 'content';
  readonly content_kind: 'user_message' | 'chat_tail';
  readonly text: string;
  readonly speaker?: 'user' | 'assistant';
  readonly turn?: number;
}

/** D-167 N.10.1 — an entity contribution: raw PII-bearing record(s) plus
 *  the producer's `render`, contributed as STRUCTURED data rather than
 *  pre-rendered text. A free-text part is opaque to the privacy resolver
 *  (a rendered `"- Alice (contact, ref: a@b.com)"` line carries no entity
 *  label), so a producer that surfaces warehouse records must hand them
 *  over structurally and let the egress gather alias them against the
 *  turn's shared ledger BEFORE they become prompt text — so the model sees
 *  aliases and the same record renders to the same alias everywhere it
 *  appears (tool results, the user message). The gather calls `render` on
 *  the aliased payload; with no privacy plan it renders the raw payload
 *  (behaviour-preserving). See `docs/d-160-n10-part-pii-pending-design.md`. */
export interface EntityPromptPart {
  readonly source: string;
  readonly role: 'entity';
  /** The entity kind the payload records describe (`'contact'`). The
   *  egress gather stamps this as each record's inline privacy marker
   *  before resolving — so the producer never has to know the marker. */
  readonly entity: string;
  /** The raw record(s) the producer surfaced — aliased at the gather. */
  readonly payload: readonly Record<string, unknown>[];
  /** Render the (aliased) payload into the prompt text block. */
  readonly render: (payload: readonly Record<string, unknown>[]) => string;
}

/** One contribution to a turn's prompt — free text or a structured
 *  entity (D-167 N.10.1). Discriminated by `role`. */
export type PromptPart = TextPromptPart | ContentPromptPart | EntityPromptPart;

/** The argument a `prompt` hook passes to `contribute` — `source` is
 *  stamped by the framework, so the hook supplies everything else. */
export type PromptContribution =
  | { role: 'system' | 'context'; text: string }
  | {
      role: 'content';
      content_kind: 'user_message' | 'chat_tail';
      text: string;
      speaker?: 'user' | 'assistant';
      turn?: number;
    }
  | {
      role: 'entity';
      entity: string;
      payload: readonly Record<string, unknown>[];
      render: (payload: readonly Record<string, unknown>[]) => string;
    };

/** The prompt being assembled for a turn. `prompt` hooks contribute to
 *  it; the turn executor reads `parts()` to build the actual AI call. */
export interface PromptDraft {
  /** Append a contribution. The framework stamps `source`. */
  contribute(part: PromptContribution): void;
  /** The assembled parts, in contribution order. */
  parts(): readonly PromptPart[];
}

// ── Turn output + executor ──────────────────────────────────────────

/** One tool call handled inside a turn — N.2's "one AI call + its tool
 *  handling". The out-stream projects these as transparency notes, not
 *  as user-visible messages. */
export interface ToolCallRecord {
  readonly name: string;
  readonly ok: boolean;
}

/** What a turn produced. The turn — the AI call plus its tool handling
 *  — is the framework-owned wrapped operation (N.2); the executor
 *  resolves it and returns this. */
export interface TurnOutput {
  /** The assistant text this turn produced. */
  readonly text: string;
  /** Tool calls handled inside this turn. Empty / absent for a plain
   *  answer turn. */
  readonly tool_calls?: readonly ToolCallRecord[];
  /** Tokens this turn spent, when the executor reports them — fed into
   *  the `Capacity.token_ceiling` check. */
  readonly tokens?: number;
}

/** The injected AI call. The framework owns the turn *loop*; the turn
 *  itself — resolving one AI call through `@recued/llm` plus its tool
 *  handling — is supplied by the caller. Keeping it injected is what
 *  lets the pipeline run (and be tested) with a stub turn and zero
 *  middlewares; `backend/server/` wires the production executor, the
 *  same injected-seam pattern P0's channels use for the bus sink. */
export type TurnExecutor = (ctx: TurnContext) => Promise<TurnOutput>;

// ── Lifecycle contexts ──────────────────────────────────────────────

/** Passed once, pre-loop, to every enabled middleware's `config` hook
 *  (the `before` lifecycle point). One-time setup for the stream. */
export interface StreamContext {
  readonly session_id: string;
  readonly surface: SurfaceTag;
  /** The triggering inbound user message. */
  readonly user_message: string;
  /** Conversation history at stream start, append-ordered — includes
   *  the triggering user message (the channel records it before the
   *  stream begins). */
  readonly history: readonly SessionEntry[];
  /** The stream's capacity envelope. A `config` hook MAY reassign this
   *  to a *narrowed* envelope (`narrowCapacity`); the framework reads
   *  the field back after the `before` lifecycle point. */
  capacity: Capacity;
  /** The transparency out-stream the framework projects to the user. */
  readonly out: OutStream;
  /** Mutable, middleware-owned, stream-scoped scratch. Keyed by
   *  middleware id by convention so two middlewares never collide. */
  readonly state: Map<string, unknown>;
}

/** Passed per turn, pre-AI-call, to every enabled middleware's
 *  `prompt` hook (the `before-turn` lifecycle point). The hook
 *  assembles / contributes to the prompt and absorbs anything that
 *  arrived since the last turn. */
export interface TurnContext {
  readonly session_id: string;
  readonly surface: SurfaceTag;
  /** The channel-minted `(channel × actor)` `ExecutionSource` of the
   *  inbound that started this stream (`ChannelInbound.source` — the
   *  channel is the producer, D-160 P0). Every turn of one stream
   *  carries the same source. Optional only for bare test harnesses
   *  that build a `TurnContext` by hand; `runStream` always populates
   *  it. A policy-consulting hook (the D-164 P10 read-permission seam)
   *  prefers this REAL source over any surface-derived stand-in — a
   *  surface tag says where the turn renders, the source says WHO is
   *  acting under WHAT authority. */
  readonly source?: ExecutionSource;
  /** 0-based turn index within the stream. */
  readonly turn_index: number;
  /** Stable id for this turn — stamped on every out-stream event the
   *  turn produces. */
  readonly turn_id: string;
  /** Conversation history as of this turn. */
  readonly history: readonly SessionEntry[];
  /** The prompt being assembled — `prompt` hooks contribute here. */
  readonly prompt: PromptDraft;
  /** Messages that arrived since the previous turn — a user
   *  interjection, fresh data. A `prompt` hook absorbs them (N.2). The
   *  interjection *UX* is D-160 O-3; P1 carries the field. */
  readonly interjections: readonly string[];
  /** The stream's capacity envelope (already narrowed by `config`). */
  readonly capacity: Capacity;
  readonly out: OutStream;
  readonly state: Map<string, unknown>;
  /** Short-circuit: a `prompt` hook MAY resolve the turn
   *  deterministically (the stage-0 case — N.2 SHOULD), and the
   *  framework then skips the AI call for this turn. First call wins;
   *  a second call throws. */
  resolve(text: string): void;
}

/** Passed per turn, post-AI-call, to every enabled middleware's
 *  `update` hook (the `after-turn` lifecycle point). The hook
 *  processes the result and decides loop-again or done. */
export interface TurnResult {
  readonly session_id: string;
  readonly surface: SurfaceTag;
  readonly turn_index: number;
  readonly turn_id: string;
  /** True when a `prompt` hook resolved the turn deterministically and
   *  the framework skipped the AI call (the stage-0 case). */
  readonly resolved_without_ai: boolean;
  /** What the turn produced. */
  readonly output: TurnOutput;
  readonly history: readonly SessionEntry[];
  readonly capacity: Capacity;
  readonly out: OutStream;
  readonly state: Map<string, unknown>;
  /** Force another turn — e.g. the hook injected a tool result the AI
   *  must see. With no middleware requesting continue, the framework
   *  ends the stream after this turn (the zero-middleware default). */
  requestContinue(): void;
  /** Force the stream done now. `done` wins over `continue` — if one
   *  hook requests continue and another signals done, the stream
   *  ends. */
  signalDone(): void;
}

// ── The middleware interface (N.2 / I-5) ────────────────────────────

/** A stream middleware — exactly three optional lifecycle handlers.
 *  The framework brackets each turn with them; the turn itself is the
 *  wrapped operation, never a hook. A middleware that seems to need a
 *  fourth handler is an interface-design bug to resolve, not a hook to
 *  add (I-5 / TR-3). */
export interface Middleware {
  /** Stable identity — the registry key, and the `PromptPart.source`
   *  stamp. */
  readonly id: string;
  /** `before` — once, pre-loop. One-time setup for the stream. */
  config?(ctx: StreamContext): Promise<void> | void;
  /** `before-turn` — per turn, pre-AI-call. Assemble / contribute to
   *  the prompt; absorb anything that arrived since the last turn. */
  prompt?(ctx: TurnContext): Promise<void> | void;
  /** `after-turn` — per turn, post-AI-call. Process the result; decide
   *  loop-again or done. */
  update?(ctx: TurnResult): Promise<void> | void;
}
