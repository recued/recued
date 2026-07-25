/** D-145 PB3 — engine-side per-primitive types.
 *
 *  Per § B.1 + § B.1.3. Each of the 10 typed primitives is a pure
 *  factory `create<Name>Primitive(deps) → EnginePrimitive<In, Out>`.
 *  Primitives don't see the full RecuedPlan — they emit a typed
 *  `PrimitiveCall` row + a per-primitive `Out` payload; the
 *  orchestrator (`packages/engine/src/orchestrator/`) appends both.
 *
 *  Substitutability: every primitive accepts a dep bundle and a
 *  per-call `PrimitiveExecuteContext`. Tests substitute mocks for
 *  the dep bundle without touching primitive code.
 *
 *  Spec: D-145 § B.1 + § B.1.3 + § B.5.1. */

import type {
  PrimitiveCall,
  PrimitiveCallStatus,
  RecuedPrimitive,
} from '@recued/contracts';

// ── PrimitiveExecuteContext — per-call context (ID + clock) ─────────

export interface PrimitiveExecuteContext {
  /** Engine `run_id` (orchestrator generates per `RecuedRequest`). */
  run_id: string;
  /** When the orchestrator dispatches a per-intent walk per § B.1.2
   *  rule 1. Stamped onto `PrimitiveCall.intent_id`. */
  intent_id?: string;
  /** Injectable for tests; defaults to `Date.now()`. */
  now?: () => number;
  /** Injectable for tests; defaults to `crypto.randomUUID()`. */
  mint_call_id?: () => string;
  /** PB13 Dry Run flag. When true, mutating primitives MUST record
   *  `preview_no_op` status without performing side effects. The
   *  orchestrator stamps the same flag onto the persisted plan
   *  (`status: 'preview_no_op'`) per § B.5.4 rule 1. */
  preview?: boolean;
}

// ── EnginePrimitive — typed wrapper around per-primitive execution ──

/** § B.1.3 — primitive isolation discipline. Every primitive emits a
 *  typed result + the typed `PrimitiveCall` row. The orchestrator
 *  appends the row to `RecuedPlan.primitive_calls[]`; primitives
 *  never mutate the plan directly. */
export interface PrimitiveExecuteResult<Out> {
  result: Out;
  call: PrimitiveCall;
}

export interface EnginePrimitive<In, Out> {
  /** Closed-list discriminator from `RECUED_PRIMITIVES`. */
  primitive: RecuedPrimitive;
  /** Per-primitive execution. Returns the typed result + the
   *  PrimitiveCall row (orchestrator appends to plan). The function
   *  MUST resolve — failures land in `call.status` (`'error'` /
   *  `'capacity_gap'` / `'capacity_gap_mid_run'` / `'cancelled'` /
   *  `'timeout'`) per § B.5.1 closed list. Primitives never throw to
   *  the orchestrator. */
  execute(input: In, ctx: PrimitiveExecuteContext): Promise<PrimitiveExecuteResult<Out>>;
}

// ── PrimitiveCallBuilder — convenience for emitting PrimitiveCall ───

/** Per-primitive helper to mint the `PrimitiveCall` row consistently.
 *  Pure — never reads external state. Used by every primitive's
 *  `execute()` to centralize the timestamp + status discipline. */
export interface BuildPrimitiveCallArgs {
  primitive: RecuedPrimitive;
  call_id: string;
  args_summary: string;
  outcome_summary: string;
  status: PrimitiveCallStatus;
  started_at: number;
  duration_ms: number;
  intent_id?: string;
}

export const buildPrimitiveCall = (args: BuildPrimitiveCallArgs): PrimitiveCall => {
  const call: PrimitiveCall = {
    primitive: args.primitive,
    call_id: args.call_id,
    args_summary: args.args_summary,
    outcome_summary: args.outcome_summary,
    status: args.status,
    started_at: args.started_at,
    duration_ms: args.duration_ms,
  };
  if (args.intent_id !== undefined) call.intent_id = args.intent_id;
  return call;
};

// ── Default helpers ─────────────────────────────────────────────────

const defaultNow = (): number => Date.now();

const mintRandomId = (): string => {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof g?.randomUUID === 'function') return g.randomUUID();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Resolve `now()` from a `PrimitiveExecuteContext` with the default
 *  fallback. Pure — primitives use this to keep the clock injection
 *  consistent. */
export const resolveNow = (ctx: PrimitiveExecuteContext): (() => number) =>
  ctx.now ?? defaultNow;

/** Resolve the call-id minter from a `PrimitiveExecuteContext`. */
export const resolveMintCallId = (ctx: PrimitiveExecuteContext): (() => string) =>
  ctx.mint_call_id ?? mintRandomId;

// ── Audit-safe error class projection (Codex P1 fold — privacy) ─────

/** § B.2.3 / § B.5.1 — `args_summary` and `outcome_summary` MUST NOT
 *  carry raw user content. Adapter throws are the leakiest path:
 *  `error.message` can carry user text, raw payload snippets,
 *  selector strings, vendor-API error bodies. Codex's PB3 review
 *  flagged 10 catch paths (one per primitive) that splice
 *  `e.message.slice(0, 200)` directly into `outcome_summary`.
 *
 *  Fix: replace raw messages with the constructor name (closed-list
 *  TypeError / RangeError / etc.) — preserves debug attribution
 *  without leaking content. Production composers route the full
 *  diagnostic to a separate non-plan logging channel. */
export const projectErrorClass = (e: unknown): string => {
  if (e instanceof Error) {
    const ctorName = e.constructor.name;
    return ctorName && ctorName.length > 0 ? ctorName : 'Error';
  }
  return 'unknown_error';
};

/** § B.2.3 / § B.5.1 — adapter-supplied detail strings (success path)
 *  may also carry payload bytes if the adapter wasn't audit-safe.
 *  Conservative cap: bound to 64 chars, drop anything that doesn't
 *  match an audit-friendly closed character set. The substrate cost
 *  of being permissive here is real-user-content leakage; the cost
 *  of being strict is losing a couple characters of debug context.
 *
 *  Audit-safe = `[A-Za-z0-9._\-:= ]` (alnum + dot / underscore /
 *  hyphen / colon / equals / space — covers field=value summaries
 *  + ratio strings + closed-list status codes; rejects newlines,
 *  quotes, brackets, slashes that often appear in DOM selectors /
 *  raw JSON / vendor error bodies). */
export const projectAdapterDetailForAudit = (
  detail: string | undefined,
): string | undefined => {
  if (detail === undefined || detail.length === 0) return undefined;
  const clipped = detail.slice(0, 64);
  if (/^[A-Za-z0-9._\-:= ]*$/.test(clipped)) return clipped;
  return '<detail-redacted>';
};
