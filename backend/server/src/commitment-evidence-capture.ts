/** D-192 F1 — the commitment-evidence capture producer.
 *
 *  Subscribes to the warehouse bus and watches the CRM fold cascade
 *  (`vendor-reconciler` + `webhook-funnel` both emit fat `updated`
 *  events carrying `record` / `prev` / `changed_fields`) for the
 *  fields the kernel `commitment_evidence` declarations designate
 *  (v1: the canonical `next_step` on every `crm_alias: 'deal'`
 *  entity). One qualifying capture = one immutable evidence snapshot
 *  + ONE held `commitment-create` proposal — fired through
 *  `handleExecute` exactly like the reception drain fires its
 *  review-then-approve recipes: the kernel `commitment-create` op
 *  carries `approval: 'ask'` (write tier), so the D-157 gate
 *  checkpoints the run and raises the `gateway.preflight` ask; the
 *  D-173 inbox surfaces it for approve-with-editable-args. Only the
 *  owner's approval mints (invariant 3) — this module never writes a
 *  commitment itself.
 *
 *  Capture rules (spec § Commitment evidence (F1)):
 *   - `updated` events ONLY. A `created` event is the first fold
 *     Recued sees for a record — on a fresh connection bind that is a
 *     BACKFILL of pre-existing next-steps, and proposing all of them
 *     would flood the inbox (the D-124 backfill-suppression posture:
 *     the spec's capture flow diffs prev/current, which presupposes a
 *     known prior). A pre-existing next-step proposes when it next
 *     CHANGES.
 *   - `value_set`: prev empty/absent → non-empty; `value_changed`:
 *     non-empty → different non-empty. Non-empty → EMPTY never
 *     captures (a cleared field is not a promise; per invariant 2 it
 *     is not fulfillment proof either — v1 does no auto-fulfill).
 *   - Dedup: `(full_target_id, field, value_hash)` claimed in the
 *     durable ledger BEFORE firing — a re-fold of the same value
 *     never re-proposes, a DECLINED proposal's evidence never
 *     re-proposes, a changed value is new evidence.
 *
 *  The proposal recipe is a synthetic KERNEL recipe fired INLINE
 *  (`ExecuteRequest.recipe`) — the preflight checkpoint carries the
 *  `recipe_snapshot`, so resume works without a store registration
 *  (the run-ingredient precedent). Fired under the reception drain's
 *  dispatch posture: `channel: 'reactive', actor: 'system'` with a
 *  `source_recipe` token the D-173 inbox origin filter accepts. */

import type {
  ArgEditField,
  CommitmentEvidenceDeclaration,
  CommitmentEvidenceEntry,
  ConnectionVendorEntity,
  ExecutionSource,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';
import {
  COMMITMENT_STATEMENT_MAX,
  COMMITMENT_EVIDENCE_TEMPLATE_PLACEHOLDER,
  CONNECTION_VENDOR_ENTITIES,
  scopesForCrmAlias,
} from '@recued/contracts';
import type { WarehouseEvent, WarehouseEventBus } from '@recued/warehouse-events';

import type { CommitmentEvidenceLedger } from './storage/commitment-evidence-ledger.js';

// ────────────────────────────────────────────────────────────────
// Kernel declarations (v1 — the CRM next-step showcase)
// ────────────────────────────────────────────────────────────────

/** The kernel-shipped capture declarations. v1: the CRM next-step
 *  field on every `crm_alias: 'deal'` vendor (HubSpot `hs_next_step`
 *  is in the deal vocabulary + hash since D5; Salesforce `NextStep`
 *  joined both in this slice) — structured, rep-authored, capture is
 *  deterministic. Pack-declared `commitment_evidence` entries
 *  validate (`validateCommitmentEvidence`) but stay inert until the
 *  decomposer pass-through lands. */
export const KERNEL_COMMITMENT_EVIDENCE_DECLARATIONS: readonly CommitmentEvidenceDeclaration[] = [
  {
    kind: 'crm_field',
    source: { crm_alias: 'deal', field: 'next_step' },
    direction: 'outbound',
    counterparty: { resolve: 'record_contact_edges' },
    statement: { template: COMMITMENT_EVIDENCE_TEMPLATE_PLACEHOLDER },
    capture_on: ['value_set', 'value_changed'],
    approval: 'required',
  },
];

// ────────────────────────────────────────────────────────────────
// The proposal recipe (synthetic kernel identity, fired inline)
// ────────────────────────────────────────────────────────────────

export const COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID = 'commitment-evidence-proposal';

/** The reactive `event_kind` every proposal fire carries — with the
 *  recipe id above, the EXACT provenance pair the D-173 inbox origin
 *  filter admits (exact equality, never substring — a user recipe id
 *  merely containing these words must not surface in the inbox). */
export const COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND = 'commitment_evidence.capture';

/** The kernel op the proposal holds on — the dedicated PROPOSAL surface
 *  (`commitment-propose`), whose slug rides the all-actor approval lift
 *  (`COMMITMENT_PROPOSAL_INGREDIENT_SLUGS`, op-risk-admission.ts): the
 *  contract-less reactive/system fire would otherwise RELAX the write
 *  tier's `ask` under the owner/automation `admin` trust ceiling and
 *  mint WITHOUT approval (codex HIGH — invariant 3). The inbox keys its
 *  editable-args allowlist on the held checkpoint's resolved
 *  `approved_target.operation_id`, with a synthetic
 *  `<recipe>.<gated_step>` fallback — both ids below name THIS held
 *  proposal. */
export const COMMITMENT_PROPOSE_OPERATION_ID = 'core.work-entity.commitment.propose';
export const COMMITMENT_EVIDENCE_PROPOSAL_SYNTHETIC_OP_ID =
  `${COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID}.propose_commitment`;

/** The approve-with-editable-args allowlist for a held commitment
 *  proposal (spec § Commitment evidence (F1) step 4): statement /
 *  deadline / direction / counterparty are the owner's to shape at
 *  approval — the evidence snapshot is NOT here (immutable by
 *  invariant 2; `reception.inbox.approve` rejects non-allowlisted
 *  keys before any write). The kernel `commitment-create` manifest is
 *  runtime-bundled (not in the local-manifest catalog the inbox's
 *  operation lookup scans), so the boot wiring serves this allowlist
 *  for the two op identities above. */
export const COMMITMENT_EVIDENCE_EDITABLE_ARGS: readonly ArgEditField[] = [
  { key: 'statement', type: 'string', label: 'Statement', required: true },
  { key: 'promised_for_at', type: 'datetime', label: 'Deadline', required: false },
  { key: 'direction', type: 'string', label: 'Direction', required: true },
  { key: 'counterparty_contact_id', type: 'string', label: 'Counterparty', required: false },
];

/** One op-step: the kernel `commitment-create` (approval: 'ask') with
 *  the capture payload as its args — the SAME shape the reception
 *  drain's compiled review-then-approve recipes use
 *  (`{{context.event.payload}}` forwarded verbatim), so the gate
 *  holds it and approve-with-editable-args edits land on this step's
 *  `arg_overrides`. */
export const COMMITMENT_EVIDENCE_PROPOSAL_RECIPE: Readonly<RecipeDefinition> = Object.freeze({
  recipe_id: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Commitment evidence proposal',
    description:
      'Kernel recipe holding one captured commitment proposal at the approval '
      + 'gate (D-192 F1). Not an installable recipe.',
    author: 'recued',
    supported_platforms: [],
    tags: ['kernel', 'commitment-evidence'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'propose_commitment',
      op: 'core.work-entity.commitment.propose',
      args: '{{context.event.payload}}',
    } as unknown as RecipeStep,
  ],
  output: { render: [{ type: 'summary', source: 'step.propose_commitment' }] },
}) as unknown as RecipeDefinition;

// ────────────────────────────────────────────────────────────────
// The producer
// ────────────────────────────────────────────────────────────────

/** The proposal dispatch — one held run per capture. */
export type FireCommitmentEvidenceProposal = (request: {
  recipe: RecipeDefinition;
  execution_source: ExecutionSource;
  payload: Record<string, unknown>;
  run_id: string;
}) => Promise<void>;

/** The executeDeps-derived half, LATE-POPULATED by the post-listener
 *  runtime (the `workEntityWriteExecutorRef` idiom): the proposal
 *  dispatch + the LIVE merged vendor registry (pack CRMs join their
 *  `crm_alias` on the next fold after install). Null until wired —
 *  captures before that are SKIPPED WITHOUT claiming the ledger (the
 *  next fold of the same value proposes once wiring is up). */
export interface CommitmentEvidenceRuntime {
  fire: FireCommitmentEvidenceProposal;
  resolveVendorRegistry: () => ReadonlyArray<ConnectionVendorEntity>;
  /** Counterparty resolution seam (`resolve: 'record_contact_edges'`):
   *  captured record's contact edges → D-138-resolved `contact_id`.
   *  Optional — unresolvable/absent ⇒ the proposal's counterparty
   *  defaults EMPTY (nullable column; the owner fills or leaves at
   *  approval). */
  resolveCounterpartyContactId?: (full_target_id: string) => string | undefined;
}

export interface CommitmentEvidenceCaptureDeps {
  bus: WarehouseEventBus;
  /** Late-bound — the ledger lives on the same SQLite as the
   *  warehouse; undefined (dbless harness) disables capture. */
  getLedger: () => CommitmentEvidenceLedger | undefined;
  /** Late-bound executeDeps-derived runtime (see the type doc). */
  getRuntime: () => CommitmentEvidenceRuntime | undefined;
  declarations?: readonly CommitmentEvidenceDeclaration[];
  now?: () => number;
}

const readField = (
  snapshot: Record<string, unknown> | undefined,
  field: string,
): string | undefined => {
  const value = snapshot?.[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/** Render the declaration's statement template (single-placeholder
 *  convention) + clamp to the canonical statement cap. */
export const renderCommitmentStatement = (template: string, fieldValue: string): string =>
  template
    .split(COMMITMENT_EVIDENCE_TEMPLATE_PLACEHOLDER)
    .join(fieldValue)
    .slice(0, COMMITMENT_STATEMENT_MAX);

/** Cap on distinct raw contact-email candidates a deal's engagement
 *  walk scans before the resolver concludes it cannot prove a single
 *  counterparty. A resolved candidate set with more than one distinct
 *  canonical email defaults the proposal counterparty EMPTY regardless,
 *  so the cap only needs to exceed 1 by enough margin that merge-
 *  collapse (several raw aliases redirecting to one survivor) can still
 *  resolve to a single counterparty — a handful of aliases per contact
 *  is the realistic ceiling, so 25 is generous. The CALLER fetches
 *  `cap + 1` rows so the resolver can DETECT truncation (see below). */
export const COMMITMENT_COUNTERPARTY_CANDIDATE_CAP = 25;

/** The `record_contact_edges` counterparty decision (pure). Given the
 *  raw contact-email candidates a deal's engagements surfaced (the
 *  caller fetches at most `cap + 1`), forward-resolve each through the
 *  D-138 `merged_into` chain, dedup by survivor, and return the
 *  counterparty ONLY when we can PROVE the deal maps to exactly one
 *  distinct canonical contact. Everything else fails CLOSED to
 *  undefined (owner fills at approval — the column is nullable), because
 *  a confidently-wrong default is worse than an empty one:
 *   - `emails.length > cap` → the candidate set was TRUNCATED at the
 *     query LIMIT, so an unseen candidate could be a second distinct
 *     counterparty — cannot prove single (codex MEDIUM).
 *   - any candidate whose forward-resolve THROWS (corrupt-graph cycle /
 *     invalid email) or yields an empty canonical → cannot prove the
 *     deal has exactly one counterparty, so fail closed rather than
 *     decide on the resolvable remainder (codex LOW — the substrate's
 *     fail-closed posture).
 *   - ≥ 2 distinct survivors → the deal spans multiple counterparties.
 *   - exactly 1 distinct survivor (incl. several raw aliases that
 *     merged into it) → that survivor's canonical email.
 *   - 0 candidates → undefined.
 *  `resolveCanonical` is the contact-store `merged_into` walk. */
export const resolveCounterpartyFromContactEmails = (
  emails: readonly string[],
  resolveCanonical: (email: string) => string | undefined,
  cap: number = COMMITMENT_COUNTERPARTY_CANDIDATE_CAP,
): string | undefined => {
  if (emails.length > cap) return undefined; // truncated — cannot prove single
  const survivors = new Set<string>();
  for (const email of emails) {
    let canonical: string | undefined;
    try {
      canonical = resolveCanonical(email);
    } catch {
      return undefined; // corrupt redirect / invalid email — fail closed
    }
    if (canonical === undefined || canonical.length === 0) return undefined;
    survivors.add(canonical);
    if (survivors.size > 1) return undefined; // ambiguous — short-circuit
  }
  if (survivors.size !== 1) return undefined;
  return survivors.values().next().value;
};

/** Wire the capture producer onto the warehouse bus. Returns the
 *  unsubscribe handle (shutdown). */
export const wireCommitmentEvidenceCapture = (
  deps: CommitmentEvidenceCaptureDeps,
): (() => Promise<void>) => {
  const now = deps.now ?? ((): number => Date.now());
  const declarations = deps.declarations ?? KERNEL_COMMITMENT_EVIDENCE_DECLARATIONS;
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  let stopPromise: Promise<void> | undefined;

  const onEvent = (ev: WarehouseEvent): void => {
    if (closed) return;
    // `updated` only — see the module doc (backfill suppression). A
    // prev-LESS `updated` is skipped for the same reason (codex MEDIUM):
    // the reconciler emits record-only `updated` events for rows whose
    // prior fold left no meta snapshot — such an event proves no field
    // CHANGE, so capturing on it would propose from mere (re)discovery.
    // Both capture events compare against a PRESENT prior snapshot:
    // `value_set` = the field was empty/absent IN IT.
    if (ev.event_kind !== 'updated' || ev.prev === undefined) return;
    for (const declaration of declarations) {
      if (declaration.kind !== 'crm_field') continue;
      const { field } = declaration.source;
      const runtime = deps.getRuntime();
      const registry = runtime?.resolveVendorRegistry() ?? CONNECTION_VENDOR_ENTITIES;
      // `crm_alias` → the `connection.api.<vendor>.<entity>` scopes its vendor
      // entities fold under (the reconciler emits the scope as `ev.platform`).
      // Resolved per event from the LIVE registry so a pack CRM installed after
      // boot joins on its next fold.
      if (!scopesForCrmAlias(declaration.source.crm_alias, registry).has(ev.platform)) continue;
      if (ev.changed_fields !== undefined && !ev.changed_fields.includes(field)) continue;
      const current = readField(ev.record, field);
      if (current === undefined) continue; // empty/cleared — never a capture
      const prev = readField(ev.prev, field);
      const event: 'value_set' | 'value_changed' = prev === undefined ? 'value_set' : 'value_changed';
      if (prev !== undefined && prev === current) continue; // no semantic change
      if (!declaration.capture_on.includes(event)) continue;

      const ledger = deps.getLedger();
      // Both halves must be up BEFORE the ledger claim — a claim
      // without a fire would permanently swallow this evidence
      // identity.
      if (ledger === undefined || runtime === undefined) return;
      if (!ledger.tryClaim({ full_target_id: ev.record_id, field, value: current }, now())) {
        continue; // already proposed (pending / approved / declined)
      }

      const captured_at = now();
      const evidence: CommitmentEvidenceEntry = {
        kind: 'crm_field',
        full_target_id: ev.record_id,
        field,
        value: current,
        ...(prev !== undefined ? { prev_value: prev } : {}),
        captured_at,
      };
      const counterparty = runtime.resolveCounterpartyContactId?.(ev.record_id);
      const payload: Record<string, unknown> = {
        direction: declaration.direction,
        statement: renderCommitmentStatement(declaration.statement.template, current),
        derivation: 'evidence_captured',
        // The capture wall-clock IS the promise timestamp; the deadline
        // (`promised_for_at`) deliberately defaults ABSENT — v1 does no
        // text-date parsing, the owner sets it at approval.
        promised_at: captured_at,
        evidence_blob: [evidence],
        ...(counterparty !== undefined ? { counterparty_contact_id: counterparty } : {}),
      };
      const executionSource: ExecutionSource = {
        channel: 'reactive',
        actor: 'system',
        event_kind: COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
        source_recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
      };
      // Fire-and-forget like the reception drain: the run HOLDS at the
      // gate (awaiting_approval) — nothing to await for the capture
      // path, and a dispatch failure must never break the fold emit
      // chain. A REJECTED fire releases the claim (codex MEDIUM —
      // otherwise a transient dispatch failure permanently swallows
      // this evidence identity); the crash window between claim and
      // fire remains the documented fail-safe-toward-fewer-proposals
      // residue.
      const claimed = { full_target_id: ev.record_id, field, value: current };
      let tracked!: Promise<void>;
      tracked = runtime.fire({
        recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE as RecipeDefinition,
        execution_source: executionSource,
        payload,
        run_id: `commitment-evidence-${ev.record_id}-${captured_at}`,
      }).catch(() => {
        // The failure itself is audited by the execute path; never
        // abort the emit chain. Best-effort release — a throwing
        // release leaves the claim (fail-safe toward fewer proposals).
        try {
          deps.getLedger()?.release(claimed);
        } catch {
          /* keep the claim */
        }
      }).finally(() => {
        inFlight.delete(tracked);
      });
      inFlight.add(tracked);
    }
  };

  const unsubscribe = deps.bus.subscribe('**', onEvent);
  return () => {
    if (stopPromise) return stopPromise;
    closed = true;
    unsubscribe();
    stopPromise = Promise.allSettled([...inFlight]).then(() => undefined);
    return stopPromise;
  };
};
