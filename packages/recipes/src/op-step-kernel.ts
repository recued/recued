/** D-182 Slice 5 (Increment 1) — runtime resolution of the new two-tier `OpStep`,
 *  closed-kind Tier-K half.
 *
 *  The engine never runs a bare op-step: a recipe op-step is rewritten to a
 *  concrete `IngredientStep` before execution (the connection-agnostic R1/R2
 *  rewrite — `connection-agnostic.ts` / `dispatch-canonical-resolve.ts`), then
 *  the existing D-165 Gateway runs the concrete step. This module is the first
 *  half of extending that rewrite to the D-182 `OpStep`: a CLOSED-KIND Tier-K
 *  kernel op (`core.<domain>.<op>` present in `KERNEL_OP_REGISTRY`, e.g.
 *  `core.ai.prompt`, `core.notification.send`, `core.data.enrichment.upsert`)
 *  resolves to its backing kernel ingredient step.
 *
 *  The Tier-K CANONICAL CONVENTION ops (`core.crm.*` / `core.acct.*`) and the
 *  Tier-P pack ops (`<publisher>.<pack>.<op>`) are NOT handled here — they carry
 *  a connection + vendor/pack resolution and go through the existing
 *  connection-agnostic / pack-catalog paths (Slice 5 Increment 2). This resolver
 *  returns `null` for them so a caller can fall through.
 *
 *  Spec: D-182 §3/§6. Pickup:
 *  internal design notes.
 */
import {
  carryOpStepPassthroughKnobs,
  getKernelOp,
  type IngredientStep,
  type OpStep,
} from '@recued/contracts';

/** Resolve a closed-kind Tier-K kernel op-step to its concrete kernel
 *  ingredient step. PURE.
 *
 *  - The gate is `getKernelOp(step.op)`: the registry holds ONLY the closed-kind
 *    ops (incl. the `core.watch.*` trigger-position family), so a
 *    canonical-convention op (`core.crm.deal.read`) or a
 *    Tier-P op (`recued-core.whisper.audio.transcribe`) misses the registry and
 *    returns `null` here — exactly the fall-through the dispatcher (Increment 2)
 *    wants.
 *  - The `args → input` map is IDENTITY: a kernel op's `args` ARE the backing
 *    ingredient's `input` (verified against the live recipes — `core-ai-prompt`'s
 *    `llm.*`, `enrichment-upsert`'s `{topic,scope,id,value,…}`, `task-create`'s
 *    fields, `shared-write`'s `{key,value}`). `args` absent → `input: {}`.
 *  - NO `connection` is emitted: every closed-kind kernel ingredient is
 *    connection-less (ai/storage/data/memory/work-entity/mail/contact/
 *    notification — the pool resolver / warehouse / config drive them, never a
 *    per-instance account binding). A `connection` on a kernel op-step is
 *    meaningless and is dropped.
 *  - The step-level passthrough knobs the engine honours on a rewritten step
 *    (`skip_when` / `fail_on` / `cache` / `foreach` / `pii_fields`) ride onto the
 *    concrete step, mirroring the tool-op rewrite (`resolveToolOpStep`). */
export const resolveKernelClosedKindOpStep = (step: OpStep): IngredientStep | null => {
  const entry = getKernelOp(step.op);
  if (entry === undefined) return null;
  // D-187 slice 3 — a NATIVE verb-op (an MCP-native read tool, `native: true`, no
  // backing ingredient) is registered but NOT recipe-runnable: it has no lowering
  // target, so fall through to `null` — the same not-a-lowerable-kernel-op path the
  // op-step save check rejects at authoring time. Guards the runtime lowering even if a
  // native op id reached a step, and narrows `backing_slug` to `string` below.
  if (entry.native === true || entry.backing_slug === undefined) return null;
  return {
    id: step.id,
    ingredient: entry.backing_slug,
    input: step.args ?? {},
    // Round-12 audit fix (T2 Q1) — every passthrough knob rides via the ONE
    // shared list (`OP_STEP_PASSTHROUGH_KNOBS`), replacing a hand-kept spread
    // that had already dropped `fail_kind` (D-232 § 21) silently. The engine
    // reads each of these off the CONCRETE step: the `pii_fields` shorthand is
    // the only PII protection the uncontracted `core.ai.prompt` / multi-data
    // `core.ai.compare` ops support, and the D-113 approval knobs
    // (`timeout_ms` / `on_timeout` / `prompt`) otherwise silently fall back to
    // defaults — so a knob missing here is a protection dropped at lowering.
    ...carryOpStepPassthroughKnobs(step),
  };
};
