/** D-200 Slices 6g.3/6g.10/6g.11/6h.3b2 — owner authoring/readiness wire contract for one local
 * Reception intake-form/recipe pair.
 *
 * Bind names only current local sources plus the observed row token. Configure
 * adds only the closed deployment block plus its optional local Seller offer
 * association beside an exact ready-pair observation. Neither can carry
 * caller-derived binding authority, Seller rows,
 * pack/publisher provenance, field mapping, or commerce values.
 */

import type {
  ReceptionFormPairBinding,
  ReceptionPairBinding,
  ReceptionSchedulingPairBinding,
} from './reception-pair-binding.js';
import type {
  PaidDocumentDirectCheckoutClaimConfiguration,
} from './paid-document-direct-checkout-config.js';

export type ReceptionIntakeRecipePairStatus = 'unpaired' | 'ready' | 'stale';

/** D-200 Slice 6g.10 — closed owner-visible blockers for the deployment
 * sources named by the exact saved recipe. These are deliberately separate
 * from mapper eligibility and from provider-attempt authorization: a pair can
 * remain saved while its local Stripe connection or durable template is not
 * currently usable. */
export const RECEPTION_INTAKE_RECIPE_PAIR_CLAIM_CONFIGURATION_BLOCKER_CODES = [
  'claim_configuration_missing',
  'claim_configuration_invalid',
  'stripe_connection_lookup_unavailable',
  'stripe_connection_missing',
  'stripe_connection_source_mismatch',
  'stripe_connection_not_stripe',
  'template_lookup_unavailable',
  'template_missing',
  'template_not_local',
  'template_mime_unsupported',
  'template_too_large',
  'template_source_mismatch',
  'template_unreadable',
  'seller_offer_lookup_unavailable',
  'seller_offer_missing',
  'seller_offer_source_mismatch',
  'seller_offer_recipe_mismatch',
] as const;

export type ReceptionIntakeRecipePairClaimConfigurationBlockerCode =
  (typeof RECEPTION_INTAKE_RECIPE_PAIR_CLAIM_CONFIGURATION_BLOCKER_CODES)[number];

export type ReceptionIntakeRecipePairClaimConfigurationReadiness =
  | {
      readonly status: 'ready';
      readonly configuration: PaidDocumentDirectCheckoutClaimConfiguration;
      readonly blockers: readonly [];
    }
  | {
      readonly status: 'blocked';
      /** A syntactically valid recipe-pinned snapshot remains visible even if
       * one of its exact local sources is unavailable. Missing/invalid config
       * carries null instead of manufacturing partial authority. */
      readonly configuration: PaidDocumentDirectCheckoutClaimConfiguration | null;
      readonly blockers: readonly [
        ReceptionIntakeRecipePairClaimConfigurationBlockerCode,
        ...ReceptionIntakeRecipePairClaimConfigurationBlockerCode[],
      ];
    };

/** D-200 Slice 6g.11 — whether this exact effective recipe source can accept
 * the narrow configuration write. This is provenance/editability truth, not
 * recipe eligibility or provider readiness. A pack-owned or bundled source
 * must be forked under a new local recipe id; `unavailable` means core cannot
 * prove a persistent effective row that its exact-JSON CAS can mutate. */
export type ReceptionIntakeRecipePairClaimConfigurationAuthoring =
  | { readonly status: 'editable' }
  | { readonly status: 'fork_required' }
  | { readonly status: 'unavailable' };

/** D-210 R-2 slice 4 — which SUBJECT a pair was derived from.
 *
 * A pair's config half is per-kind: a form pair hashes its whole `IntakeFormConfig`, a
 * scheduling pair hashes only the closed `required_visitor_fields` map (owner-ruled — it is
 * the only part that changes what the paired recipe RECEIVES). The two therefore carry
 * different fields, and this is what a reader narrows on.
 *
 * ⛔ DERIVED at the single view constructor from the binding's own `version`, never passed in
 * beside it — the discriminator and the binding cannot be allowed to disagree about what the
 * row is. It exists because TypeScript cannot narrow a union on a NESTED discriminant
 * (`view.binding.version`), not because the binding is an insufficient source of truth. */
export type ReceptionRecipePairSubject = 'form' | 'scheduling';

/** The discriminator also closes the nullable fields: a ready pair always has
 * a binding and clocks, while an absent/corrupt row cannot accidentally look
 * ready to a client. A source-drifted but structurally valid stale row retains
 * its locator so the owner can see which exact snapshot went stale. */
export type ReceptionIntakeRecipePairView =
  | {
      readonly endpoint_id: string;
      readonly status: 'unpaired';
      readonly binding: null;
      readonly created_at: null;
      readonly updated_at: null;
    }
  | {
      readonly endpoint_id: string;
      readonly status: 'ready';
      readonly pair_subject: 'form';
      readonly binding: ReceptionFormPairBinding;
      readonly claim_configuration_readiness: ReceptionIntakeRecipePairClaimConfigurationReadiness;
      readonly claim_configuration_authoring: ReceptionIntakeRecipePairClaimConfigurationAuthoring;
      readonly created_at: number;
      readonly updated_at: number;
    }
  /** D-210 R-2 — a ready SCHEDULING pair.
   *
   * ⛔ Carries NO claim configuration, and the absence is structural rather than an omission:
   * a claim is a property of an intake form's FIELDS (D-200 slice 6g.11), and a booking page
   * has no authored fields to claim from. Making the claim optional on one shared `ready` arm
   * would have been smaller and wrong — it would let a FORM pair ship without the readiness a
   * form pair must always have, trading a type guarantee for a runtime throw.
   *
   * ⚠ A reader that tests `status === 'ready'` and then reads `claim_configuration_*` is now
   * a TYPE ERROR. That is deliberate: every such site assumed "ready ⇒ form", and the
   * typechecker naming them is how they get handled rather than silently rendering a booking
   * pair as unpaired. */
  | {
      readonly endpoint_id: string;
      readonly status: 'ready';
      readonly pair_subject: 'scheduling';
      readonly binding: ReceptionSchedulingPairBinding;
      readonly created_at: number;
      readonly updated_at: number;
    }
  | ({
      readonly endpoint_id: string;
      readonly status: 'stale';
    } & (
      | {
          /** ⚠ Either variant can go stale, so this stays the WIDE binding — a stale row is
           *  shown to the owner so they can see which snapshot drifted, and refusing to
           *  describe a drifted scheduling pair would hide exactly the row they need. */
          readonly binding: ReceptionPairBinding;
          readonly created_at: number;
          readonly updated_at: number;
        }
      | {
          readonly binding: null;
          readonly created_at: null;
          readonly updated_at: null;
        }
    ));

export interface ReceptionIntakeRecipePairGetInput {
  readonly endpoint_id: string;
}

export type ReceptionIntakeRecipePairGetResult = ReceptionIntakeRecipePairView;

export interface ReceptionIntakeRecipePairBindInput {
  readonly endpoint_id: string;
  readonly recipe_id: string;
  /** Null means the caller observed `unpaired`; otherwise this is the exact
   * `updated_at` returned by `get`. The server derives every binding byte. */
  readonly expected_updated_at: number | null;
  /** D-207 slice 1c — the owner has SEEN the `needs_consent` diff and accepts it.
   *
   *  Only a WIDENING (an op the door could not previously reach) needs this. Sending it
   *  on a first bind, or on a narrowing, is harmless; it is never a way to grant an op
   *  the recipe does not derive, because the server re-derives the closure from the saved
   *  recipe and this flag only decides whether to PROMPT. */
  readonly confirm_capability?: boolean;
  /** D-207 follow-on — the owner grants this door's CONFIRMED closure standing
   *  approval: the ops they just read may run without asking again, on this
   *  door, bounded by tier (`destructive` / `admin` still ask).
   *
   *  ⛔ REQUIRES `confirm_capability`. The server refuses the pair otherwise:
   *  "I have read this closure" is the precondition for "and it may run without
   *  asking me" — granting standing authority over a list the owner never saw
   *  is precisely what the confirm step exists to prevent.
   *
   *  Absent ⇒ off, which is every door bound before this existed. A re-bind
   *  that WIDENS the closure re-mints the contract, so the opt-in is re-earned
   *  against the new list rather than inherited by it. */
  readonly standing_closure?: boolean;
}

/** D-207 — why a recipe cannot back a public door.
 *
 *  The refusal lands at BIND, where the owner is present — never at fire, where an
 *  anonymous visitor's submission would die mid-run against an op that was never granted.
 *
 *  The first three are STATIC-ANALYZABILITY failures: the recipe's op closure cannot be
 *  derived, so the owner's "this form may: …" consent list could not be honest.
 *
 *  The fourth (slice 3c) is different in kind — the closure derives perfectly well, and
 *  the recipe simply CANNOT DELIVER. An anonymous actor is pinned to the `read` trust
 *  ceiling, so any write-tier op holds the whole run at the D-157 gate, and a held run
 *  returns no output. On a door that owes the visitor something back — a rendered response,
 *  or a way to pay — that means EVERY submission ends in a bare thank-you page and the
 *  visitor never gets the thing they came for. Not an intermittent failure: the form is
 *  broken on every submission. A plain intake door (no offer, no rendered response) is
 *  untouched — there a write holds, the owner approves it in the Inbox, and "we got your
 *  submission" stays true because nothing was owed in return. */
export type ReceptionDoorRefusalReason =
  | 'dispatch_unresolvable'
  | 'dynamic_dispatch'
  | 'dynamic_connection'
  | 'literal_connection'
  | 'write_on_responding_door'
  | 'cost_step_limit'
  | 'cost_dynamic_fanout'
  | 'cost_unknown_dispatch_kind';

/** D-207 slice 1c — the door minted (or not) alongside the pair.
 *
 *  The pair says WHICH recipe a public form runs. The door says UNDER WHAT AUTHORITY —
 *  it is the contract whose grant rows are the ONLY thing standing between an anonymous
 *  internet visitor and the owner's warehouse. A pair with no door is not open, it is
 *  SHUT: an anonymous dispatch with no `contract_id` floors to `PUBLIC_CONTRACT_ID`,
 *  which grants nothing, so every op hard-denies. */
export type ReceptionDoorBindView =
  /** Bound and live. `operation_ids` is the complete derived closure — exactly what the
   *  form may do, and exactly what the owner consented to. */
  | {
      readonly status: 'bound';
      readonly contract_id: string;
      readonly operation_ids: readonly string[];
      /** Nothing about the door's authority moved — the owner was not asked and nothing
       *  was re-minted. A reworded email subject or a version bump lands here. */
      readonly unchanged: boolean;
    }
  /** The capability WIDENED. Nothing was minted: the pair is saved but the door stays
   *  SHUT until the owner re-binds with `confirm_capability: true`. `added` is the
   *  consent prompt itself: canonical operation ids remain bare; changed tool/account
   *  axes are rendered as `ingredient:<slug>` / `connection:<name>`. */
  | {
      readonly status: 'needs_consent';
      readonly added: readonly string[];
      readonly removed: readonly string[];
      /** Ops that keep asking per dispatch even with the standing-closure tick
       *  (tier above `write`, or unclassifiable). ⚠ USUALLY EMPTY — a
       *  responding door cannot carry one, the bind refuses it first — and the
       *  consent copy must then say NOTHING about deletes rather than warn
       *  about one this form does not have. */
      readonly asks_anyway?: readonly string[];
      readonly operation_ids: readonly string[];
    }
  /** The recipe cannot back a public door at all. The pair is saved; no door exists. */
  | {
      readonly status: 'refused';
      readonly reason: ReceptionDoorRefusalReason;
      readonly step_id: string;
      readonly detail: string;
    }
  ;

export interface ReceptionIntakeRecipePairBindResult {
  readonly outcome: 'created' | 'updated' | 'unchanged';
  readonly pair: Extract<ReceptionIntakeRecipePairView, { readonly status: 'ready' }>;
  /** D-207 slice 1c — the door minted alongside the pair. A pair without a live `bound`
   *  door runs NOTHING on submit: the gate denies every op. */
  readonly door: ReceptionDoorBindView;
}

/** The observed ready-pair locators are compare-only authority. The server
 * derives the target recipe id from that pair and admits only the closed
 * configuration block below; its optional offer id is syntax-only association
 * intent. No full recipe, Seller row, pack/publisher identity, field mapping,
 * commerce terms, or provider result can ride this mutation. */
export interface ReceptionIntakeRecipePairConfigureInput {
  readonly endpoint_id: string;
  readonly expected_updated_at: number;
  readonly expected_pair_revision: string;
  readonly configuration: PaidDocumentDirectCheckoutClaimConfiguration;
}

export type ReceptionIntakeRecipePairConfigureResult =
  | {
      readonly outcome: 'updated';
      readonly recipe_id: string;
      /** The saved pair still pins the prior recipe snapshot. The owner must
       * explicitly rebind before the changed configuration is public truth. */
      readonly pair_requires_rebind: true;
    }
  | {
      readonly outcome: 'unchanged';
      readonly recipe_id: string;
      readonly pair_requires_rebind: false;
    };

export interface ReceptionIntakeRecipePairClearInput {
  readonly endpoint_id: string;
  /** Exact observation returned by `get`. A valid ready/stale row carries its
   * row clock + pair revision. `unpaired` and corrupt `stale` observations use
   * null locators and remain distinguishable by status, so a stale unpaired
   * client cannot clear a newly corrupt row (or vice versa). These values are
   * compare-only locators; they never become pair authority. */
  readonly expected_status: ReceptionIntakeRecipePairStatus;
  readonly expected_updated_at: number | null;
  readonly expected_pair_revision: string | null;
}

export interface ReceptionIntakeRecipePairClearResult {
  readonly removed: boolean;
}
