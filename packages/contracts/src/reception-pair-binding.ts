/** D-207 3d·6d — the general reception form/recipe pair binding.
 *
 * Split out of `paid-document-direct-checkout.ts` (D-200), which this shape
 * outgrew: every paired public form — lead capture, triage, booking, selling —
 * binds through it; nothing here is payment-specific. The D-200 payment
 * profile (fulfillment bundle key, submission-id guard) stays behind under the
 * legacy module until its pack dies.
 *
 * Pair-specific field meaning stays inside the authored recipe. This module
 * receives only the exact saved form + recipe snapshots at authoring time. It
 * deliberately has no Seller row, pack, publisher, items array, quantity,
 * subtotal, total, card data, or hosted provider URL.
 */

import { canonicalJSONStringifyStrict } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';
import {
  validateIntakeFormConfig,
  type IntakeFormConfig,
} from './intake-form-config.js';
import type { RecipeDefinition } from './recipe.js';
import {
  isSchedulingLinkVisitorFieldRequirements,
  SCHEDULING_LINK_VISITOR_FIELD_NAMES,
} from './scheduling-link-config.js';
import type { SchedulingLinkVisitorFieldRequirements } from './redacted-packets.js';
import { isSellerOfferId } from './seller.js';

export const RECEPTION_PAIR_VERSION = 1 as const;
export const RECEPTION_SELLER_ASSOCIATION_PAIR_VERSION = 2 as const;
/** D-210 R-2 — the SCHEDULING pair. A `scheduling_link` endpoint has no form:
 * its visitor inputs are a closed substrate-owned set, not an authored schema
 * (`SchedulingLinkConfig` carries `required_visitor_fields`, never a
 * `form_definition`). So this variant carries no `form_definition_id` and
 * digests a different subject — see `receptionSchedulingPairBinding`. */
export const RECEPTION_SCHEDULING_PAIR_VERSION = 3 as const;

/** ⛔ FROZEN STORAGE FORMAT — the constants got general names in the D-207
 * 3d·6d split, but the literals keep the `d200-` spelling on purpose. The
 * prefix is baked into every persisted `pair_revision`: stored pair rows,
 * nonce render stamps, submission-row stamps, and the legacy fulfillment
 * state rows the review-admission check still reads. The resolver proves a
 * stored binding current by re-deriving and comparing bytes, so changing the
 * VALUE stales every bound pair on the server and breaks the historical
 * paid-row admission boundary the 3d·6 eviction deliberately preserved. */
export const RECEPTION_PAIR_REVISION_PREFIX = 'd200-pair-v1-' as const;
export const RECEPTION_SELLER_ASSOCIATION_PAIR_REVISION_PREFIX =
  'd200-pair-v2-' as const;
/** ⚠ The `d200-` spelling here is the FAMILY's storage spelling, not a claim
 * about payment — this variant has nothing to do with D-200. It is spelled this
 * way so all three revisions share one recognisable prefix grammar (and one
 * `isReceptionPairRevision`). Nothing is frozen about v3 yet: no row has ever
 * persisted one. It is frozen from the first `scheduling_link` pair a user
 * binds, exactly as v1/v2 are. */
export const RECEPTION_SCHEDULING_PAIR_REVISION_PREFIX =
  'd200-pair-v3-' as const;

export const RECEPTION_PAIR_FORM_ID_MAX_LENGTH = 256;
export const RECEPTION_PAIR_RECIPE_ID_MAX_LENGTH = 256;

export interface ReceptionPairBindingInput {
  readonly form_config: IntakeFormConfig;
  readonly recipe: RecipeDefinition;
  /** Associates the pair with one local seller offer (a v2 binding); `null`
   * derives a plain v1 pair. The caller derives the association from the same
   * saved recipe it passes here — this module owns the binding SHAPE, not the
   * vocabulary a recipe uses to name an offer. The id itself rides outside the
   * revision digest: the recipe it was derived from IS hashed, and the store
   * re-derives and compares the full binding (association byte included) at
   * every read, so a drifted association reads `stale`, never current. */
  readonly seller_offer_id: string | null;
}

/** D-210 R-2 — the scheduling pair's authoring input.
 *
 * ⛔ `required_visitor_fields` is the WHOLE config subject, deliberately — not
 * the `SchedulingLinkConfig` it came from. The digest exists to catch drift
 * that would silently change what the paired recipe RECEIVES, and only this
 * closed map can: flip `phone` from `optional` to `omit` and a recipe reading
 * the phone gets null. Durations, windows, day caps and copy change what the
 * VISITOR sees, never the recipe's inputs — digesting them would stale every
 * open picker page on a cosmetic edit and buy nothing. (The form path has no
 * such split: there, every config edit IS an input-shape edit.)
 *
 * The owner ruled this subject on 2026-07-17. */
export interface ReceptionSchedulingPairBindingInput {
  readonly required_visitor_fields: SchedulingLinkVisitorFieldRequirements;
  readonly recipe: RecipeDefinition;
}

/** Compact authoring result persisted beside the local form binding. The hash
 * covers the complete validated form config and exact saved recipe snapshot.
 * V2 surfaces one recipe-pinned local offer association; pack/publisher remain
 * absent and the binding proves neither a Seller row nor transaction truth. */
interface ReceptionPairBindingBase {
  readonly recipe_id: string;
  readonly recipe_version: number;
  readonly pair_revision: string;
}

/** The FORM-shaped bindings' extra identity field. Deliberately NOT on the
 * shared base: a scheduling pair has no form, and a base that promised this
 * field would force every scheduling variant to invent one. */
interface ReceptionFormPairBindingBase extends ReceptionPairBindingBase {
  readonly form_definition_id: string;
}

export interface ReceptionPlainPairBinding extends ReceptionFormPairBindingBase {
  readonly version: typeof RECEPTION_PAIR_VERSION;
}

/** Exact recipe/pair-pinned Seller association. The id remains navigation
 * intent only; later runtime code must prove row definition and recipe
 * authority before writing any core Seller projection. */
export interface ReceptionSellerAssociationPairBinding
  extends ReceptionFormPairBindingBase {
  readonly version: typeof RECEPTION_SELLER_ASSOCIATION_PAIR_VERSION;
  readonly seller_offer_id: string;
}

/** D-210 R-2 — a `scheduling_link` endpoint paired to a recipe. Carries no
 * form id: the pair's subject is the endpoint (the pair row's own primary
 * key), and what the recipe RECEIVES is fixed by the substrate — the closed
 * visitor-field set plus the selected slot. */
export interface ReceptionSchedulingPairBinding extends ReceptionPairBindingBase {
  readonly version: typeof RECEPTION_SCHEDULING_PAIR_VERSION;
}

/** The bindings whose subject is an authored FORM (v1 / v2). The intake path
 * is typed on THIS, not on `ReceptionPairBinding`: a scheduling binding can
 * never reach a form submission, a form nonce, or the direct-checkout
 * admission check, and the type says so rather than leaving each site to
 * re-narrow (or forget to). */
export type ReceptionFormPairBinding =
  | ReceptionPlainPairBinding
  | ReceptionSellerAssociationPairBinding;

/** Every binding the per-endpoint pair store may hold. */
export type ReceptionPairBinding =
  | ReceptionFormPairBinding
  | ReceptionSchedulingPairBinding;

/** The keys EVERY binding carries. The other key sets derive from this one so
 * a field added to the base cannot be silently missing from a variant's
 * `hasOnlyKeys` gate (which would then reject every binding the deriver mints). */
const BASE_PAIR_BINDING_KEYS = [
  'version',
  'recipe_id',
  'recipe_version',
  'pair_revision',
] as const;

const SCHEDULING_PAIR_BINDING_KEYS = new Set<string>(BASE_PAIR_BINDING_KEYS);

const PAIR_BINDING_KEYS = new Set<string>([
  ...BASE_PAIR_BINDING_KEYS,
  'form_definition_id',
]);

const SELLER_ASSOCIATION_PAIR_BINDING_KEYS = new Set<string>([
  ...PAIR_BINDING_KEYS,
  'seller_offer_id',
]);

const PAIR_BINDING_INPUT_KEYS = new Set([
  'form_config',
  'recipe',
  'seller_offer_id',
]);

const SCHEDULING_PAIR_BINDING_INPUT_KEYS = new Set([
  'required_visitor_fields',
  'recipe',
]);

/** Derived from the config module's own list — never a second hand-copy of the
 * five field names. */
const SCHEDULING_VISITOR_FIELD_KEYS = new Set<string>(
  SCHEDULING_LINK_VISITOR_FIELD_NAMES,
);

const isObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
};

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
): boolean => {
  try {
    const actualKeys = Object.keys(value);
    return actualKeys.length === keys.size
      && actualKeys.every((key) => keys.has(key));
  } catch {
    return false;
  }
};

const isBoundedNonEmptyString = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= maxLength
  && value.trim() === value;

const isRecipeId = (value: unknown): value is string =>
  isBoundedNonEmptyString(value, RECEPTION_PAIR_RECIPE_ID_MAX_LENGTH)
  && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);

const PAIR_REVISION_RE = new RegExp(
  `^${RECEPTION_PAIR_REVISION_PREFIX}[a-f0-9]{64}$`,
);
const SELLER_ASSOCIATION_PAIR_REVISION_RE = new RegExp(
  `^${RECEPTION_SELLER_ASSOCIATION_PAIR_REVISION_PREFIX}[a-f0-9]{64}$`,
);
const SCHEDULING_PAIR_REVISION_RE = new RegExp(
  `^${RECEPTION_SCHEDULING_PAIR_REVISION_PREFIX}[a-f0-9]{64}$`,
);

/** Hash inputs must be unambiguous JSON data. In particular, reject the
 * undefined/non-finite/class-instance cases that canonical JSON would omit or
 * coerce, and reject cycles before serialization. */
const isCanonicalJsonValue = (
  value: unknown,
  seen: Set<object> = new Set(),
  depth = 0,
): boolean => {
  try {
    if (depth > 64) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      return true;
    }
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;

    const isArray = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if ((!isArray && proto !== Object.prototype && proto !== null)
      || (isArray && proto !== Array.prototype)) {
      return false;
    }

    seen.add(value);
    let valid = true;
    if (isArray) {
      const arrayValue = value as unknown[];
      const names = Object.getOwnPropertyNames(arrayValue);
      if (names.length !== arrayValue.length + 1 || !names.includes('length')) {
        valid = false;
      }
      for (let index = 0; valid && index < arrayValue.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(arrayValue, String(index));
        if (descriptor === undefined
          || !descriptor.enumerable
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || !isCanonicalJsonValue(descriptor.value, seen, depth + 1)) {
          valid = false;
        }
      }
    } else {
      for (const name of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (descriptor === undefined
          || !descriptor.enumerable
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || !isCanonicalJsonValue(descriptor.value, seen, depth + 1)) {
          valid = false;
          break;
        }
      }
    }
    seen.delete(value);
    return valid;
  } catch {
    return false;
  }
};

export const isReceptionPairRevision = (
  value: unknown,
): value is string => typeof value === 'string'
  && (PAIR_REVISION_RE.test(value)
    || SELLER_ASSOCIATION_PAIR_REVISION_RE.test(value)
    || SCHEDULING_PAIR_REVISION_RE.test(value));

const isPairBindingRecipeRef = (value: Record<string, unknown>): boolean =>
  isRecipeId(value.recipe_id)
  && Number.isSafeInteger(value.recipe_version)
  && (value.recipe_version as number) > 0;

/** Closed locator-shape guard for the FORM-shaped bindings (v1 / v2) only.
 * Authority requires re-deriving this value from the saved snapshots at
 * authoring time, or exact comparison with the persisted, nonce-bound pair at
 * submission time. */
export const isReceptionFormPairBinding = (
  value: unknown,
): value is ReceptionFormPairBinding => {
  try {
    if (!isObject(value)
      || !isCanonicalJsonValue(value)) return false;
    const common = isBoundedNonEmptyString(
      value.form_definition_id,
      RECEPTION_PAIR_FORM_ID_MAX_LENGTH,
    )
      && isPairBindingRecipeRef(value);
    if (!common) return false;
    if (value.version === RECEPTION_PAIR_VERSION) {
      return hasOnlyKeys(value, PAIR_BINDING_KEYS)
        && typeof value.pair_revision === 'string'
        && PAIR_REVISION_RE.test(value.pair_revision);
    }
    return value.version === RECEPTION_SELLER_ASSOCIATION_PAIR_VERSION
      && hasOnlyKeys(value, SELLER_ASSOCIATION_PAIR_BINDING_KEYS)
      && isSellerOfferId(value.seller_offer_id)
      && typeof value.pair_revision === 'string'
      && SELLER_ASSOCIATION_PAIR_REVISION_RE.test(value.pair_revision);
  } catch {
    return false;
  }
};

/** D-210 R-2 — closed locator-shape guard for the scheduling binding (v3).
 * `hasOnlyKeys` REJECTS a `form_definition_id` here rather than ignoring it: a
 * v3 carrying a form id is not a tolerable near-miss, it is evidence the value
 * was minted by something that thinks scheduling has a form. */
export const isReceptionSchedulingPairBinding = (
  value: unknown,
): value is ReceptionSchedulingPairBinding => {
  try {
    if (!isObject(value)
      || !isCanonicalJsonValue(value)) return false;
    return value.version === RECEPTION_SCHEDULING_PAIR_VERSION
      && isPairBindingRecipeRef(value)
      && hasOnlyKeys(value, SCHEDULING_PAIR_BINDING_KEYS)
      && typeof value.pair_revision === 'string'
      && SCHEDULING_PAIR_REVISION_RE.test(value.pair_revision);
  } catch {
    return false;
  }
};

/** Any binding the per-endpoint pair store may hold. Callers that can only
 * legitimately see a form pair should use `isReceptionFormPairBinding` — this
 * one deliberately admits v3. */
export const isReceptionPairBinding = (
  value: unknown,
): value is ReceptionPairBinding =>
  isReceptionFormPairBinding(value) || isReceptionSchedulingPairBinding(value);

/** Exact identity comparison across every binding variant. Keep this
 * centralized: every source-read/replay boundary must compare the association
 * byte when present, not merely the pair revision shape.
 *
 * Each branch re-tests `right.version` rather than leaning on a single
 * `left.version === right.version` up front — that equality does not narrow
 * `right` for the type checker, and a cast to make it compile would be the one
 * place a v1 could be compared against a v3 on the fields they happen to
 * share. */
export const receptionPairBindingEquals = (
  left: ReceptionPairBinding,
  right: ReceptionPairBinding,
): boolean => {
  if (left.recipe_id !== right.recipe_id
    || left.recipe_version !== right.recipe_version
    || left.pair_revision !== right.pair_revision) {
    return false;
  }
  if (left.version === RECEPTION_SCHEDULING_PAIR_VERSION
    || right.version === RECEPTION_SCHEDULING_PAIR_VERSION) {
    return left.version === right.version;
  }
  if (left.form_definition_id !== right.form_definition_id) return false;
  if (left.version === RECEPTION_PAIR_VERSION) {
    return right.version === RECEPTION_PAIR_VERSION;
  }
  return right.version === RECEPTION_SELLER_ASSOCIATION_PAIR_VERSION
    && left.seller_offer_id === right.seller_offer_id;
};

/** Derive a content-addressed pair binding only from a complete valid form
 * config and one exact JSON-clean saved recipe snapshot. The recipe must have
 * passed the standard recipe parser before this helper; this contract does not
 * duplicate that higher-layer semantic validator. Pairing requires later owner
 * promotion, so the form is LOG-ONLY (D-210 WS2: an absent `target_kind` — the
 * paid submission is the immutable form_response, materialized only after
 * payment; it must not mint a destination entity), and the immutable
 * pre-acceptance email source must exist. */
export const receptionPairBinding = (
  input: ReceptionPairBindingInput,
): ReceptionFormPairBinding | null => {
  if (!isObject(input)
    || !hasOnlyKeys(input, PAIR_BINDING_INPUT_KEYS)) {
    return null;
  }
  try {
    const formConfig = input.form_config as unknown;
    const savedRecipe = input.recipe as unknown;
    const sellerOfferId = input.seller_offer_id;
    if (sellerOfferId !== null && !isSellerOfferId(sellerOfferId)) return null;
    if (!isCanonicalJsonValue(formConfig)
      || !isCanonicalJsonValue(savedRecipe)
      || !isObject(formConfig)
      || !isObject(savedRecipe)
      || validateIntakeFormConfig(formConfig).length > 0
      || !isObject(formConfig.submission_processing_rule)
      // D-210 A.8 slice 2b step 3 — a D-200 direct-checkout pair mints NO
      // destination entity: the response row itself is the paid deliverable.
      // That rule is unchanged; only its spelling is. It used to be written as
      // an ABSENT `target_kind`, and absent is no longer a value — so it is now
      // written as the destination that means the same thing.
      //
      // ⛔ Both halves of this would have broken silently on the same change:
      // the line above runs the FULL config validator, which now emits
      // `target_kind_missing` for a log-only config, and this line refused any
      // present value. A paid pair would have failed to bind twice over.
      || formConfig.submission_processing_rule.target_kind !== 'form_response'
      || !isObject(formConfig.required_visitor_fields)
      || formConfig.required_visitor_fields.email !== 'required'
      || !isObject(formConfig.form_definition)
      || !isRecipeId(savedRecipe.recipe_id)
      || !Number.isSafeInteger(savedRecipe.version)
      || (savedRecipe.version as number) <= 0) {
      return null;
    }
    const formDefinitionId = formConfig.form_definition.form_definition_id;
    if (!isBoundedNonEmptyString(
      formDefinitionId,
      RECEPTION_PAIR_FORM_ID_MAX_LENGTH,
    )) {
      return null;
    }
    const bindingVersion = sellerOfferId === null
      ? RECEPTION_PAIR_VERSION
      : RECEPTION_SELLER_ASSOCIATION_PAIR_VERSION;
    const digest = sha256Hex(canonicalJSONStringifyStrict({
      version: bindingVersion,
      form_config: formConfig,
      recipe: savedRecipe,
    }));
    const common = {
      form_definition_id: formDefinitionId,
      recipe_id: savedRecipe.recipe_id,
      recipe_version: savedRecipe.version as number,
    };
    return sellerOfferId === null
      ? {
          version: RECEPTION_PAIR_VERSION,
          ...common,
          pair_revision: `${RECEPTION_PAIR_REVISION_PREFIX}${digest}`,
        }
      : {
          version: RECEPTION_SELLER_ASSOCIATION_PAIR_VERSION,
          ...common,
          pair_revision:
            `${RECEPTION_SELLER_ASSOCIATION_PAIR_REVISION_PREFIX}${digest}`,
          seller_offer_id: sellerOfferId,
        };
  } catch {
    return null;
  }
};

/** D-210 R-2 — derive a scheduling endpoint's pair binding from the closed
 * visitor-field map it renders with and one exact JSON-clean saved recipe
 * snapshot.
 *
 * Mirrors `receptionPairBinding`'s posture exactly: re-validate the config
 * subject from the endpoint validator's OWN rule (a config that would be
 * refused at `reception.endpoint.create` must never be hashable into a live
 * pair), require a JSON-clean recipe, and refuse rather than coerce.
 *
 * ⚠ The digest deliberately does NOT cover the endpoint id. The pair row is
 * keyed by endpoint, so the binding does not restate it — and hashing it would
 * make an otherwise-identical pair non-comparable across endpoints for no
 * gain. */
export const receptionSchedulingPairBinding = (
  input: ReceptionSchedulingPairBindingInput,
): ReceptionSchedulingPairBinding | null => {
  if (!isObject(input)
    || !hasOnlyKeys(input, SCHEDULING_PAIR_BINDING_INPUT_KEYS)) {
    return null;
  }
  try {
    const requiredVisitorFields = input.required_visitor_fields as unknown;
    const savedRecipe = input.recipe as unknown;
    if (!isCanonicalJsonValue(requiredVisitorFields)
      || !isCanonicalJsonValue(savedRecipe)
      || !isObject(requiredVisitorFields)
      || !isObject(savedRecipe)
      // ⛔ Bound the key set BEFORE the per-field guard. That guard checks the
      // known fields and tolerates unknown extras — correct for validating a
      // config, wrong for a DIGEST SUBJECT: an extra key would be serialized
      // into the revision while the endpoint validator called the config
      // unchanged, so one config would mint two revisions and a pair could read
      // `stale` against itself.
      || !hasOnlyKeys(requiredVisitorFields, SCHEDULING_VISITOR_FIELD_KEYS)
      || !isSchedulingLinkVisitorFieldRequirements(requiredVisitorFields)
      || !isRecipeId(savedRecipe.recipe_id)
      || !Number.isSafeInteger(savedRecipe.version)
      || (savedRecipe.version as number) <= 0) {
      return null;
    }
    const digest = sha256Hex(canonicalJSONStringifyStrict({
      version: RECEPTION_SCHEDULING_PAIR_VERSION,
      required_visitor_fields: requiredVisitorFields,
      recipe: savedRecipe,
    }));
    return {
      version: RECEPTION_SCHEDULING_PAIR_VERSION,
      recipe_id: savedRecipe.recipe_id,
      recipe_version: savedRecipe.version as number,
      pair_revision: `${RECEPTION_SCHEDULING_PAIR_REVISION_PREFIX}${digest}`,
    };
  } catch {
    return null;
  }
};
