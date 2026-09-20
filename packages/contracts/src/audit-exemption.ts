/** Which runs do NOT earn an audit anchor.
 *
 *  ⛔⛔⛔ THIS PREDICATE DELETES EVIDENCE. Every branch fails TOWARD auditing: an
 *  unknown shape, an absent field, a step type nobody has classified, a channel
 *  this file has not heard of — all return `false` and the run keeps its row. An
 *  extra audit row is noise; a missing one is a hole in the control plane, and
 *  nothing reports it. When in doubt, audit.
 *
 *  ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *  Measured 2026-08-20: `webclient → #packs → view recipes → (list → detail)`
 *  writes one anchor per screen, for a recipe with ZERO operations — the gate at
 *  the anchor is only `deps.auditLog && !result.trigger_skipped`. Browsing a pack
 *  is not an action, has nothing to reverse, and the trail's stated job is
 *  *"every action an AI takes … audited"*. The rows also cost more than noise:
 *  they compete in the SAME global window the reception approval queue scans
 *  (`reception-inbox-scan-window-crowding.test.ts`).
 *
 *  ── WHY IT IS NOT KEYED ON `risk` ────────────────────────────────────────────
 *  ⛔ The obvious predicate — "exempt read-tier ops" — was measured and rejected.
 *  `risk` is author-declared with NO cross-check on the 96% of ops carrying a
 *  `bind.method` where one is possible (820 sit below their method's floor), and
 *  the OWNER can replace it downward: `ingredient-catalog.ts` takes
 *  `owner_override.risk` verbatim, unlike its neighbours which clamp through
 *  `stricterRisk` / `stricterApproval`. Keying audit there would let ONE
 *  owner-tunable field silence both the approval gate and the record that it ran.
 *  🔑 The audit log is what makes an unpredictable risk declaration survivable —
 *  so it must not depend on that declaration.
 *
 *  ── WHY IT IS NOT KEYED ON "contract-free" ───────────────────────────────────
 *  ⛔ `(chat, user_self)` and `(messenger, user_self)` carry NO `contract_id` on
 *  the source — their owner-contract association is DERIVED elsewhere
 *  (`grant-governing-contract.ts`: *"No explicit contract_id: an owner-AI surface
 *  IS the owner contract"*). So "contract-free owner-direct" would have silenced
 *  the owner's assistant and their Telegram commands — reads a MODEL chose to
 *  make, which are the ones most worth keeping. ⚠ There are two contract notions
 *  here (`contract_id` vs `governing_contract_id`) and they disagree for exactly
 *  those two channels; any future predicate saying "contract-free" must name
 *  which. The CHANNEL is the discriminator; contract-absence is a conjunct.
 */
import { executionSourceContractId, type ExecutionSource } from './commits.js';

/** Step types that cannot DISPATCH: no network, no connection, no external
 *  effect. Anything else — `ingredient`, `prefetch`, or a type added later —
 *  dispatches, and a dispatch is the thing an audit row is FOR.
 *
 *  ⚠ THE CRITERION IS DISPATCH, NOT "TOUCHES NOTHING", and the distinction is
 *  load-bearing rather than pedantic. This comment used to say a member must
 *  "provably cannot reach a STORE" — which `transform`, the member sitting right
 *  below it, does not satisfy: `{{data.memory.<id>}}` resolves through
 *  `SharedResolvers.dataMemory.lookup` into `userMemoryStore.get`, and
 *  `enrichment-or-fetch` reads the enrichment layer through
 *  `ctx.readEnrichmentRow`. Those are LOCAL reads of the owner's own warehouse,
 *  which is precisely what this exemption is for — "the owner reading their own
 *  data on their own client". A criterion that the set's own member fails is one
 *  a future reader must either ignore or misapply.
 *
 *  ⛔ Adding a member is a decision about evidence, not a classification tidy-up.
 *  A new step kind belongs here only once it provably cannot cause an effect
 *  OUTSIDE this server — and note that a write to a durable local store is also
 *  out (a `transform`'s only writes are per-run RAM, disposed when the run
 *  resolves; a run that checkpoints is never exempt anyway, because
 *  `commit_status` must be `'succeeded'`). */
export const NON_DISPATCHING_STEP_TYPES: ReadonlySet<string> = new Set([
  'transform',
  'guard',
]);

/** The one channel whose manual runs are the owner at their own keyboard.
 *
 *  ⛔ NOT a set, and deliberately so. `chat` / `messenger` are the owner too, and
 *  they must keep auditing: a model decided to make that read. `mcp`,
 *  `reception`, `webhook`, `reactive`, `schedule` are not the owner at all.
 *  Widening this is a control-plane decision; a `Set` invites appending to it. */
export const AUDIT_EXEMPT_CHANNEL = 'user';

export interface AuditExemptionInput {
  /** The dispatch source. Absent ⇒ audit (we cannot tell who ran it). */
  readonly source?: ExecutionSource | undefined;
  readonly trigger_source?: string | undefined;
  /** The engine's resolved status. Anything but a clean success keeps its row —
   *  a failure and a hold are exactly what someone comes looking for later. */
  readonly commit_status?: string | undefined;
  readonly errors?: ReadonlyArray<unknown> | undefined;
  /** `StepLog[]`, structurally. Absent or EMPTY ⇒ audit: a run that logged no
   *  steps has told us nothing, and "nothing to inspect" is not "nothing
   *  happened". */
  readonly steps?: ReadonlyArray<{ id?: string; type?: string; skipped?: boolean }> | undefined;
  /** ⏭ THE SEAM FOR THE HALF THAT IS NOT BUILT. A dispatching step can still be
   *  provably read-only — a Records `search`/`get` binds `action` structurally,
   *  and `RISK_FLOOR` (`ingredient-authoring/records.ts`) ENFORCES that action
   *  and risk agree, which is what makes the action trustworthy where the risk is
   *  not. Wiring it needs the op id at the anchor, and `StepLog` does not carry
   *  one (op steps are lowered to `ingredient` before execution).
   *
   *  Until a host supplies this, an ABSENT classifier means every dispatching
   *  step audits — the fail-closed default, and the reason this file is safe to
   *  ship before that plumbing exists. A classifier returning anything other than
   *  `true` for a step ⇒ audit. */
  readonly stepIsProvablyReadOnly?: (
    step: { id?: string; type?: string; skipped?: boolean },
    index: number,
  ) => boolean;
}

/** True when this run provably did nothing and was the owner's own manual read.
 *
 *  ⚠ Read the `false` returns as the specification: they are the safety, and the
 *  single `true` at the end is only reached when every one of them was passed. */
export const runIsAuditExemptRender = (input: AuditExemptionInput): boolean => {
  const { source } = input;
  if (source === undefined || source === null) return false;
  if (source.channel !== AUDIT_EXEMPT_CHANNEL) return false;
  if (source.actor !== 'user_self') return false;
  // ⛔ Self-restricted mode carries a `contract_id` on the `user` channel — the
  // owner deliberately narrowing their own session. Someone who asked to be
  // watched more closely keeps their log.
  if (executionSourceContractId(source) !== undefined) return false;
  if (input.trigger_source !== 'manual') return false;
  if (input.commit_status !== 'succeeded') return false;
  if (input.errors !== undefined && input.errors.length > 0) return false;

  const steps = input.steps;
  if (steps === undefined || !Array.isArray(steps) || steps.length === 0) return false;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    // A malformed entry is not evidence of innocence.
    if (step === undefined || step === null || typeof step !== 'object') return false;
    // A skipped step did nothing — that is what `skipped` means.
    if (step.skipped === true) continue;
    if (typeof step.type !== 'string') return false;
    if (NON_DISPATCHING_STEP_TYPES.has(step.type)) continue;
    // It dispatched. Only an explicit, host-supplied proof of read-only rescues it.
    if (input.stepIsProvablyReadOnly?.(step, i) !== true) return false;
  }
  return true;
};
