/** Auto-PII trace — the server-side source classifier (design § 7).
 *
 *  `tracePiiFlow` (@recued/contracts) owns the flow algebra; THIS module owns
 *  what the trace knows about semantic step outputs: which output paths of
 *  ingredient / catalog-op reads and curated model-output shapes carry which
 *  `EntityFieldPrivacy` kind.
 *
 *  Two layers, unioned:
 *
 *  1. **Entity-schema derived** — the shipped `CANONICAL_PII_ENTITY_SCHEMAS`
 *     (mail / contact / calendar / CRM contacts, `MetaField.privacy` tags)
 *     keyed by canonical-op capability (`contact.search` → the contact
 *     schema's tagged fields). Both the canonical `key` and the vendor
 *     `source_path` are emitted, mirroring the dual-shape posture of the
 *     chat-egress resolvers. Callers can union additional schemas (the
 *     `local_manifest` growth path for D-170-authored content).
 *
 *  2. **Curated kernel ingredient table** — first-party legacy (pre-canonical)
 *     ingredients and semantic model-output shapes classified by their REAL
 *     output field names. Legacy wrappers predate entity schemas, while model
 *     output cannot be inferred solely from an opaque input handle; both
 *     classifications therefore live here as explicit kernel curation (same
 *     first-party-constant reasoning as `canonical-pii-schemas.ts`). Field
 *     sets are verified against the ingredient manifests' output maps.
 *
 *  Classification-absent steps return undefined — the trace reads them clean
 *  (the chat-mode untagged posture; curation is the lever, see the contracts
 *  module header).
 */

import type {
  EntitySchemaIngredientInput,
  PiiPathProfile,
  PiiSourceClassifier,
  PiiTaintKind,
} from '@recued/contracts';
import {
  CANONICAL_PII_ENTITY_SCHEMAS,
  withDerivedVendorEntityPrivacy,
} from './canonical-pii-schemas.js';

/** Curated kernel table: first-party legacy ingredient slug → output taint
 *  profile. Paths use the trace's `[]` list-boundary segment
 *  (`PII_LIST_SEGMENT`) wherever the REAL output shape is a list — the
 *  boundary is what keeps tag-coverage and ref-resolution runtime-honest
 *  (a dot-path cannot cross an array except by numeric index). */
const KERNEL_INGREDIENT_PROFILES: Readonly<Record<string, PiiPathProfile>> = {
  // ── mail (canonical_mirror hot_fields shape) ──
  'mail-get': {
    'record.hot_fields.from': ['email'],
    'record.hot_fields.to': ['email'],
    'record.hot_fields.cc': ['email'],
    'record.hot_fields.subject': ['content'],
  },
  'mail-body-read': { body: ['content'] },
  'mail-list': {
    '[].hot_fields.from': ['email'],
    '[].hot_fields.to': ['email'],
    '[].hot_fields.cc': ['email'],
    '[].hot_fields.subject': ['content'],
  },
  'mail-thread-reader': {
    'messages.[].from': ['email'],
    'messages.[].to': ['email'],
    'messages.[].subject': ['content'],
    'messages.[].body': ['content'],
  },
  // ── accepted Reception responses ──
  // The form schema is deliberately free-form, so submitted values and
  // promotion metadata stay content-tainted as whole subtrees. The one typed
  // visitor identity field is classified precisely so auto-PII aliases it
  // before a downstream model call. Ancestor taint on `record.values` also
  // covers refs into arbitrary nested form fields.
  'form-response-list': {
    'records.[].values': ['content'],
    'records.[].visitor.email': ['email'],
    'records.[].metadata': ['content'],
  },
  'form-response-get': {
    'record.values': ['content'],
    'record.visitor.email': ['email'],
    'record.metadata': ['content'],
  },
  // D-210 A.8 slice 2 — the lifecycle write RETURNS the record, so its output
  // carries exactly the same visitor content the read does and must be
  // classified identically. A write whose response body is unclassified is the
  // same leak as an unclassified read; the verb does not change what is in the
  // payload.
  'form-response-set-state': {
    'record.values': ['content'],
    'record.visitor.email': ['email'],
    'record.metadata': ['content'],
  },
  // A trusted profile bounds the envelope shape, not the vendor-authored
  // decoded values. Treat the complete payload subtree as content and the
  // provider's event/resource locators as external identifiers so a recipe
  // cannot accidentally pass either to a model as an unclassified clean value.
  'webhook-event-get': {
    'event.provider_event_id': ['external_id'],
    'event.provider_resource_id': ['external_id'],
    payload: ['content'],
  },
  // D-200 Slice 3 — a rendered Markdown temp ref is an opaque handle at the
  // recipe layer, but an AI file-ref consumer realizes its bytes. Those bytes
  // can contain arbitrary accepted-response content plus visitor.email, so the
  // handle must remain conservatively tainted across that semantic hop.
  'file-render-markdown-template': {
    file_ref: ['content', 'email'],
  },
  // Generated summaries are content even when their input is an opaque file
  // reference whose bytes the static trace cannot inspect. `tracePiiFlow`
  // applies this profile only after judging the summarize call itself, so the
  // profile constrains downstream model consumers without pretending that the
  // originating file-ref egress was locally redacted or statically visible.
  'ai-summarize': {
    summary: ['content'],
    key_points: ['content'],
  },
  // Closed-kind `core.ai.summarize` resolves to this backing slug before the
  // classifier runs. Keep it explicit rather than normalizing every `core-*`
  // slug, because only registered aliases are equivalent to bare ingredients.
  'core-ai-summarize': {
    summary: ['content'],
    key_points: ['content'],
  },
  // ── CRM contacts (full PII rows) ──
  'deal-contacts-hubspot': {
    '[].first_name': ['name'],
    '[].last_name': ['name'],
    '[].email': ['email'],
    '[].phone': ['phone'],
    '[].company': ['org'],
  },
  'contact-reader-hubspot': {
    email: ['email'],
    name: ['name'],
    first_name: ['name'],
    last_name: ['name'],
    phone: ['phone'],
    company: ['org'],
  },
  'contact-list-reader-hubspot': {
    '[].email': ['email'],
    '[].name': ['name'],
    '[].first_name': ['name'],
    '[].last_name': ['name'],
    '[].phone': ['phone'],
    '[].company': ['org'],
  },
  // ── CRM activities / companies ──
  // activity-reader-hubspot retired (D-139 activity-reader fold): every consumer
  // now reaches engagements through the engagement.list tool op, whose nested
  // pass-through output is untraced (no projection model) — no slug to map here.
  'company-reader-hubspot': {
    name: ['org'],
    domain: ['url'],
    description: ['content'],
  },
  // deal / opportunity readers carry only the opaque vendor owner id
  // (`hubspot_owner_id` / `OwnerId`) — external_id kind per the canonical
  // CRM convention's privacy column.
  'deal-reader-hubspot': { owner_id: ['external_id'] },
  'deal-list-reader-hubspot': { '[].owner_id': ['external_id'] },
  'opportunity-reader-salesforce': { owner_id: ['external_id'] },
};

/** Canonical-op capability profiles derived from the entity schemas: for a
 *  capability (`contact` in `contact.search`), every privacy-tagged
 *  meta_field contributes its canonical `key` AND vendor `source_path`. */
const opProfilesFrom = (
  schemas: readonly EntitySchemaIngredientInput[],
): Map<string, Record<string, PiiTaintKind[]>> => {
  const byCapability = new Map<string, Record<string, PiiTaintKind[]>>();
  for (const schema of schemas) {
    const capabilities = new Set<string>([schema.entity_id]);
    if (schema.crm_alias) capabilities.add(schema.crm_alias);
    for (const cap of capabilities) {
      const profile = byCapability.get(cap) ?? {};
      for (const f of schema.meta_fields ?? []) {
        if (!f.privacy) continue;
        for (const path of new Set([f.key, f.source_path])) {
          if (typeof path !== 'string' || path === '') continue;
          const kinds = new Set(profile[path] ?? []);
          kinds.add(f.privacy);
          profile[path] = [...kinds];
        }
      }
      if (Object.keys(profile).length > 0) byCapability.set(cap, profile);
    }
  }
  // The canonical CRM convention projects `owner` as the vendor user id
  // (external_id; "resolved to email when granted") on deal / opportunity /
  // account rows — no shipped entity schema carries it, so add it here.
  for (const cap of ['deal', 'opportunity', 'account', 'company']) {
    const profile = byCapability.get(cap) ?? {};
    const kinds = new Set(profile['owner'] ?? []);
    kinds.add('external_id');
    profile['owner'] = [...kinds];
    byCapability.set(cap, profile);
  }
  return byCapability;
};

export interface CanonicalPiiClassifierOptions {
  /** Additional tagged schemas to union over the shipped set (the
   *  `local_manifest` / discovered-schema growth path). */
  extraSchemas?: readonly EntitySchemaIngredientInput[];
  /** Additional / overriding ingredient-slug profiles (an override REPLACES
   *  the kernel entry for that slug). */
  extraIngredientProfiles?: Readonly<Record<string, PiiPathProfile>>;
}

/** Build the server's `PiiSourceClassifier` for `tracePiiFlow` /
 *  `validateRecipePii`. Pure lookup — composed once, used per recipe. */
export const createCanonicalPiiSourceClassifier = (
  options?: CanonicalPiiClassifierOptions,
): PiiSourceClassifier => {
  // Kernel-derived CRM-contact privacy (same rule the chat + enrichment egress apply):
  // a `crm_alias: 'contact'` schema's canonical email / name / phone keys are PII even
  // when the pack that declared it tagged nothing — which every shipped pack CRM does.
  // Applying it here keeps the recipe PII TRACE honest about a pack-CRM contact read;
  // without it the trace would report a read as untainted while the egress aliases it.
  const schemas = withDerivedVendorEntityPrivacy([
    ...CANONICAL_PII_ENTITY_SCHEMAS,
    ...(options?.extraSchemas ?? []),
  ]);
  const opProfiles = opProfilesFrom(schemas);
  const ingredientProfiles: Record<string, PiiPathProfile> = {
    ...KERNEL_INGREDIENT_PROFILES,
    ...(options?.extraIngredientProfiles ?? {}),
  };

  return (step) => {
    if (typeof step.ingredient === 'string') {
      return ingredientProfiles[step.ingredient];
    }
    if (typeof step.op === 'string') {
      const [capability, verb] = step.op.split('.');
      const profile = opProfiles.get(capability ?? '');
      if (!profile) return undefined;
      // search / list verbs return a LIST of records — mark the boundary so
      // the trace's tag-coverage and ref-walk stay runtime-honest. Other
      // verbs (read / create / update) return one record.
      if (verb === 'search' || verb === 'list') {
        return Object.fromEntries(
          Object.entries(profile).map(([p, kinds]) => [`[].${p}`, kinds]),
        );
      }
      return profile;
    }
    return undefined;
  };
};
