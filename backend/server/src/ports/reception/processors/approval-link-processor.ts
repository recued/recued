/** D-149 P8 § A.5.5 + § Must Hold I-12 — approval_link consumption drain.
 *
 *  Closes the "consumed then unreachable" gap for approval_link: a
 *  visitor consumes a scoped approval (approve / reject / confirm / pick
 *  a time / answer), the handler atomically flips `consumed_at` and
 *  returns the success page, but until this processor existed NO consumer
 *  drained the row — the configured downstream effect (`on_approve_action`)
 *  never ran.
 *
 *  Flow per consumed-pending row (`consumed_at IS NOT NULL AND
 *  processing_outcome = 'pending'`):
 *    1. Decrypt the sealed outcome (`consumed_outcome_encrypted`) → the
 *       canonical wire string (`approve` / `reject[:comment]` /
 *       `confirm:<yes|no>` / `pick:<option_id>` / `answer:<text>`).
 *    2. Dispatch `config.on_action.on_approve_action`:
 *         - `create_commitment` → for an affirmative outcome, hand the
 *           projection-shaped commitment payload to the
 *           `fireReceptionWorkflow` seam → the compiled `review-then-approve`
 *           recipe fires, its materialize op is HELD at the D-157 gate → the
 *           Reception Inbox surfaces it (NO ambient materialize — I-1).
 *           D-210 Phase C retired `on_action.auto_accept`, so there is no
 *           pre-grant that skips this. A rejection / "no" confirmation isn't a
 *           commitment (neither materialized nor dispatched); the decline is
 *           recorded by the consume-time signed audit row + the notify seam.
 *         - `mark_resolved` / `fire_recipe` → routed through the
 *           `applyEffect` seam (cross-substrate DI — `mark_resolved`'s
 *           target lives in a substrate the bare `target_id` doesn't name,
 *           a D-157 ask / D-158 / work-entity; `fire_recipe` needs the
 *           recipe-executor — both land with the effects pass). UNLIKE
 *           intake_form's `runRecipe` (an optional extra ATOP a concrete
 *           materialization), this seam IS the whole effect, so an UNWIRED
 *           seam leaves the row PENDING — it retries when the seam lands
 *           rather than draining; marking it `processed` would strand the
 *           consumed approval with its promised engine reaction never
 *           applied. A WIRED seam that throws fails the row (retained for
 *           review), never swallowed. The consume-time
 *           `approval_intent.consumed` signed audit (handler § N.3) still
 *           records the response meanwhile.
 *    3. Fire the optional `notify` seam (also unwired this phase).
 *    4. Flip the intent `processed`.
 *
 *  A corrupt config, an undecryptable outcome, or a materialization
 *  throw flips the row to `failed` (retained for review — never silently
 *  dropped). A locked vault (key getter throws) aborts the tick leaving
 *  rows `pending` to retry after unlock — identical to the intake_form
 *  drain so a boot-time fire-immediate sweep before unlock can't lose
 *  valid consumptions.
 *
 *  PII discipline (mirrors the P6 intake_form processor + its Codex
 *  fold): the visitor's free-text response (a reject comment / an answer)
 *  is projected into the commitment STATEMENT — that's the point, it's
 *  the response the user wants to read, exactly as intake_form projects
 *  form-field values into the materialized entity. The visitor EMAIL is
 *  NEVER copied into the queryable entity blob — it stays sealed in the
 *  reception row (contact-resolution-gated per D-138); only its
 *  provenance id reverse-links the commitment to the sealed intent row.
 *
 *  Spec: D-149 § A.5.5 + § Must Hold I-11 + I-12. */

import {
  type ApprovalLinkConfig,
  type ApprovalLinkOnApproveAction,
} from '@recued/contracts';
import type {
  FireReceptionWorkflow,
  ReceptionDrainResult,
  ReceptionDrainTickInput,
  ReceptionSubmissionProcessor,
} from '../reception-drain.js';
import { openApprovalIntentPiiField } from '../approval-pii.js';
import { parseApprovalLinkConfig } from '../transformations/approval-link.js';
import {
  runReceptionProjection,
  type ReceptionProjectionInput,
} from '../projection/reception-projection.js';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';
import type { ApprovalIntentStore } from '../../../storage/reception-approval-store.js';
import type { WorkEntityStore } from '../../../storage/work-entity-store.js';

/** Narrow store slices — keeps the processor decoupled + unit-fakeable. */
export type ReceptionDrainRegistry = Pick<PublicEndpointRegistryStore, 'list'>;
export type ReceptionApprovalDrainStore = Pick<
  ApprovalIntentStore,
  'listPendingForEndpoint' | 'markProcessed'
>;
/** D-173 P1 — the approval_link drain's `create_commitment` effect now routes
 *  through the shared `runReceptionProjection` (the generalized
 *  `approval_required` projection op) instead of an inline `writeCommitment`,
 *  producing a byte-identical commitment. The drain only ever projects the
 *  `commitment` kind, so its store slice stays `writeCommitment`-only — the
 *  projection's store type is `Partial`, so this narrow slice is assignable
 *  there without widening the boot wire's `workEntityStore` dep. */
export type ReceptionCommitmentStore = Pick<WorkEntityStore, 'writeCommitment'>;

/** Effect seam payload — `mark_resolved` / `fire_recipe`. Carries the
 *  full decrypted context a wired effect handler needs (resolve the
 *  target ask/approval / fire the recipe with the response). Never
 *  throws into the drain (the processor swallows). */
export interface ReceptionApprovalEffect {
  readonly endpoint_id: string;
  readonly intent_id: string;
  readonly action_kind: ApprovalLinkConfig['action_kind'];
  readonly on_approve_action: Extract<ApprovalLinkOnApproveAction, 'mark_resolved' | 'fire_recipe'>;
  /** The configured action target (resolve / annotate target). */
  readonly target_id: string;
  /** Optional reactive-recipe id when `on_approve_action === 'fire_recipe'`. */
  // D-210 Phase C — `triggered_recipe_id` retired; nothing carries it now.
  /** Canonical outcome wire string (may carry visitor free-text). */
  readonly outcome: string;
  readonly affirmative: boolean;
  readonly visitor_email?: string;
}

/** Notify seam payload — fired after every drained consumption. */
export interface ReceptionApprovalNotice {
  readonly endpoint_id: string;
  readonly intent_id: string;
  readonly kind: 'approval_link';
  readonly action_kind: ApprovalLinkConfig['action_kind'];
  readonly on_approve_action: ApprovalLinkOnApproveAction;
  // D-210 Phase C — `notification_target` retired; the notice names no channel.
  readonly affirmative: boolean;
  /** Human-readable outcome summary (safe — already user-facing copy). */
  readonly outcome_summary: string;
  /** Present when `create_commitment` materialized a commitment. */
  readonly created_commitment_id?: string;
}

export interface ApprovalLinkProcessorDeps {
  readonly registryStore: ReceptionDrainRegistry;
  readonly intentStore: ReceptionApprovalDrainStore;
  readonly workEntityStore: ReceptionCommitmentStore;
  readonly getApprovalIntentPiiKey: () => Uint8Array;
  readonly now: () => number;
  /** Optional — `mark_resolved` / `fire_recipe` effect application.
   *  Unwired this phase (cross-substrate DI lands with the effects
   *  pass). */
  readonly applyEffect?: (effect: ReceptionApprovalEffect) => void | Promise<void>;
  /** Optional — fired after each drained consumption. Unwired this
   *  phase (NotificationBlock is engine-internal). */
  readonly notify?: (notice: ReceptionApprovalNotice) => void | Promise<void>;
  /** D-173 P3 § A.7 — the review-then-approve dispatch seam (the SINGLE
   *  path for a REVIEW-mode `create_commitment` endpoint, the default). Fires
   *  the compiled `review-then-approve` recipe so the materialize op holds at
   *  the D-157 gate → inbox. Absent (boot phase / no reception core-pack) ⇒ a
   *  review-mode affirmative consumption is left `pending` to dispatch once the
   *  recipe lands (NEVER auto-materialized as a fallback — I-1). D-210 Phase C
   *  `create_commitment` endpoints never use this seam (they materialize
   *  directly — A.7); `mark_resolved` / `fire_recipe` always route through
   *  `applyEffect` regardless; there is no pre-grant that skips review. */
  readonly fireReceptionWorkflow?: FireReceptionWorkflow;
}

/** Split a canonical outcome wire string into head + remainder. */
const splitOutcome = (wire: string): { head: string; rest: string } => {
  const idx = wire.indexOf(':');
  return idx === -1
    ? { head: wire, rest: '' }
    : { head: wire.slice(0, idx), rest: wire.slice(idx + 1) };
};

/** An outcome is affirmative unless it's an explicit rejection or a
 *  "no" confirmation. `pick` / `answer` / `approve` are affirmative — a
 *  selection / a response / an approval all carry forward intent. */
const isAffirmativeOutcome = (wire: string): boolean => {
  const { head, rest } = splitOutcome(wire);
  if (head === 'reject') return false;
  if (head === 'confirm') return rest === 'yes';
  return true;
};

/** Render the wire string into the user-facing response line that lands
 *  in the commitment statement + the notify summary. */
const describeOutcome = (wire: string): string => {
  const { head, rest } = splitOutcome(wire);
  switch (head) {
    case 'approve':
      return 'Approved';
    case 'reject':
      return rest.length > 0 ? `Rejected: ${rest}` : 'Rejected';
    case 'confirm':
      return rest === 'yes' ? 'Confirmed attendance' : 'Declined attendance';
    case 'pick':
      return `Selected option: ${rest}`;
    case 'answer':
      return rest.length > 0 ? `Answered: ${rest}` : 'Answered';
    default:
      return wire;
  }
};

/** Deterministic commitment id for an approval intent — upsert on
 *  `ON CONFLICT(id)` makes materialization crash-idempotent (a process
 *  that dies after writeCommitment but before markProcessed
 *  re-materializes onto the SAME id on restart, not a duplicate). */
const commitmentIdForIntent = (intent_id: string): string => `reception_${intent_id}`;

export const createApprovalLinkSubmissionProcessor = (
  deps: ApprovalLinkProcessorDeps,
): ReceptionSubmissionProcessor => ({
  label: 'approval_link',
  drainOnce: async ({ now, limit }: ReceptionDrainTickInput): Promise<ReceptionDrainResult> => {
    let processed = 0;
    let failed = 0;
    let budget = limit;

    // Lazy + once-per-tick key resolution. A locked / uninitialised
    // FileVault makes the getter throw — that MUST NOT mark rows failed
    // (it would lose valid consumptions on the boot fire-immediate sweep
    // before unlock). On key-unavailable the whole tick aborts, leaving
    // rows pending to retry after unlock. Per-row decrypt failures below
    // (valid key, tampered ciphertext) are the only permanent failed path.
    let keyResolved = false;
    let piiKey: Uint8Array | null = null;
    const resolveKey = (): Uint8Array | null => {
      if (!keyResolved) {
        keyResolved = true;
        try {
          piiKey = deps.getApprovalIntentPiiKey();
        } catch (e) {
          console.warn(
            '[d-149] approval_link drain: approval-PII key unavailable (vault locked?) — leaving consumptions pending',
            e,
          );
          piiKey = null;
        }
      }
      return piiKey;
    };

    // ALL approval_link endpoints — including disabled AND revoked. A
    // consumption accepted while the endpoint was live is valid received
    // data + must still process even if the user later disabled / revoked
    // the endpoint (revocation stops FUTURE access; it doesn't retroact
    // already-consumed rows, which would strand them pending forever).
    const endpoints = deps.registryStore.list({ kind: 'approval_link', include_revoked: true });

    for (const endpoint of endpoints) {
      if (budget <= 0) break;
      const pending = deps.intentStore.listPendingForEndpoint(endpoint.endpoint_id, budget);
      if (pending.length === 0) continue;

      const config = parseApprovalLinkConfig(endpoint.metadata);

      for (const row of pending) {
        if (budget <= 0) break;
        // A corrupt/unparseable config can never apply an effect — fail
        // the row (retained for review) rather than retry forever.
        if (!config) {
          deps.intentStore.markProcessed({ intent_id: row.intent_id, outcome: 'failed' });
          failed += 1;
          budget -= 1;
          continue;
        }
        // A mark_resolved / fire_recipe row whose effect seam isn't wired
        // this phase can't drain — skip it WITHOUT spending budget or
        // decrypting (it'd never make progress), so a leading run of such
        // endpoints in registry order can't starve the per-tick drain
        // budget that create_commitment rows need. The row stays pending;
        // it drains once applyEffect lands. (Budget is now spent per
        // actually-drained row, not per row listed.)
        if (config.on_action.on_approve_action !== 'create_commitment' && !deps.applyEffect) {
          continue;
        }
        const key = resolveKey();
        if (!key) {
          // Vault locked / key unavailable — abort the tick. Remaining
          // rows stay pending for the next cycle after unlock.
          return { processed, failed };
        }
        try {
          const outcomeWire = await openApprovalIntentPiiField({
            key,
            endpoint_id: endpoint.endpoint_id,
            intent_id: row.intent_id,
            field: 'outcome',
            ciphertext: row.consumed_outcome_encrypted,
          });
          if (!outcomeWire) throw new Error('consumed_outcome decrypt returned null');

          // Visitor email is decrypted ONLY to hand to the (unwired)
          // effect / notify seams — never persisted into a queryable
          // entity blob (stays sealed in the reception row, D-138-gated).
          const visitorEmail = await openApprovalIntentPiiField({
            key,
            endpoint_id: endpoint.endpoint_id,
            intent_id: row.intent_id,
            field: 'visitor_email',
            ciphertext: row.consumed_by_visitor_email_encrypted,
          });

          const affirmative = isAffirmativeOutcome(outcomeWire);
          const outcomeSummary = describeOutcome(outcomeWire);
          const onApprove = config.on_action.on_approve_action;
          let createdCommitmentId: string | undefined;

          if (onApprove === 'create_commitment') {
            // A commitment is a promise — only an affirmative outcome
            // produces one. A rejection / "no" is captured by the
            // consume-time signed audit + the notify seam (no materialize, no
            // workflow — it is simply marked processed below).
            if (affirmative) {
              // The projection-shaped commitment payload — the SAME shape both
              // branches use (deterministic id, lead-with-the-response
              // statement so a long prompt can't clamp the visitor's answer out
              // — the statement caps at COMMITMENT_STATEMENT_MAX, inbound /
              // peer_received / pending via the projection, the local builtin
              // commitment Source by default, and the provenance-only blob; the
              // visitor email is deliberately absent — sealed in the row).
              const commitmentPayload: ReceptionProjectionInput = {
                top_tier_kind: 'commitment',
                id: commitmentIdForIntent(row.intent_id),
                // `title` is the commitment fallback only; `body` is the
                // statement source (projection clamps to the ceiling).
                title: `${outcomeSummary} — re: ${config.prompt}`,
                body: `${outcomeSummary} — re: ${config.prompt}`,
                metadata: {
                  reception_approval_intent_id: row.intent_id,
                  reception_endpoint_id: endpoint.endpoint_id,
                  reception_action_kind: config.action_kind,
                },
              };

              // D-210 Phase C — REVIEW IS THE ONLY PATH. `on_action.auto_accept`
              // was retired (owner ruling, 2026-07-18) with the intake +
              // drop_link flags, so a consumed approval's commitment always
              // holds at the D-157 gate and the inbox owns the decision.
              {
                // Dispatch the compiled
                // `review-then-approve` workflow so the materialize op is HELD
                // at the D-157 gate → inbox. The processor does NOT materialize
                // here (no ambient warehouse write — I-1); the commitment
                // materializes only on the user's explicit approve, through the
                // same projection.
                if (!deps.fireReceptionWorkflow) {
                  // No dispatch seam (boot phase / no reception core-pack).
                  // Leave PENDING (budget unspent) — valid undispatched review
                  // work, not a poison row; it dispatches once the recipe
                  // installs. It MUST NOT materialize as a fallback (I-1).
                  continue;
                }
                const fired = await deps.fireReceptionWorkflow({
                  kind: 'approval_link',
                  // The projection input forwarded verbatim as the trigger
                  // payload — spread to a plain record (the seam's payload is
                  // `Record<string, unknown>`; the closed `ReceptionProjectionInput`
                  // interface has no index signature).
                  payload: { ...commitmentPayload },
                  source_ref: row.intent_id,
                  endpoint_id: endpoint.endpoint_id,
                });
                if (!fired.dispatched) {
                  // Seam couldn't fire (no compiled recipe). Leave PENDING to
                  // retry — never materialize as a fallback (I-1).
                  continue;
                }
                // Handed off to review-then-approve — fall through to
                // markProcessed (the held op + inbox own the lifecycle now);
                // `createdCommitmentId` stays undefined (nothing materialized
                // until the user approves).
              }
            }
          } else if (deps.applyEffect) {
            // mark_resolved / fire_recipe — the seam owns the entire
            // effect. A throw propagates to the outer catch → `failed`
            // (retained for review), NOT swallowed: silently marking
            // `processed` would lose the promised engine reaction.
            await deps.applyEffect({
              endpoint_id: endpoint.endpoint_id,
              intent_id: row.intent_id,
              action_kind: config.action_kind,
              on_approve_action: onApprove,
              target_id: config.on_action.target_id,
              outcome: outcomeWire,
              affirmative,
              ...(visitorEmail ? { visitor_email: visitorEmail } : {}),
            });
          } else {
            // Unreachable — the pre-decrypt skip above leaves an unwired
            // mark_resolved / fire_recipe row pending before it reaches
            // here. Guard defensively: leave it pending (don't spend
            // budget) rather than mark it processed with no effect applied.
            continue;
          }

          deps.intentStore.markProcessed({ intent_id: row.intent_id, outcome: 'processed' });
          processed += 1;
          budget -= 1;

          // Optional notify seam — never let a seam failure undo the
          // already-committed processing.
          if (deps.notify) {
            try {
              await deps.notify({
                endpoint_id: endpoint.endpoint_id,
                intent_id: row.intent_id,
                kind: 'approval_link',
                action_kind: config.action_kind,
                on_approve_action: onApprove,
                affirmative,
                outcome_summary: outcomeSummary,
                ...(createdCommitmentId ? { created_commitment_id: createdCommitmentId } : {}),
              });
            } catch (e) {
              console.warn('[d-149] approval_link notify seam failed', e);
            }
          }
        } catch (e) {
          console.warn(
            `[d-149] approval_link intent ${row.intent_id} processing failed`,
            e,
          );
          deps.intentStore.markProcessed({ intent_id: row.intent_id, outcome: 'failed' });
          failed += 1;
          budget -= 1;
        }
      }
    }

    return { processed, failed };
  },
});
