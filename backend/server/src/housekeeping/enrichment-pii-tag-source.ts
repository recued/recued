/** D-167 — enrichment-producer PII tag source (the ACTIVATION half of the
 *  non-chat AI-egress aliasing seam).
 *
 *  The seam in `enrichment-pii-egress.ts` (`wrapHousekeepingCtxForRecord`) is
 *  inert until a tag source is wired onto `HousekeepingContext.enrichmentPiiTagSource`
 *  — exactly the chat S4 pattern (the chat resolver was dormant until `93fa73ba`
 *  injected `createMetaFieldPrivacyResolverFromLocalManifestStore`). This module
 *  is the enrichment counterpart: a read-only view over the per-pair
 *  `local_manifest` table that maps a producer's `source_scope` to the installed
 *  entity schema's `MetaField.privacy`-tagged fields.
 *
 *  Why a SEPARATE resolver from the chat one (they share the field→paths helper
 *  but not the index shape):
 *    - The chat resolver is OPERATION-keyed — it walks a chat egress packet's
 *      `prior_tool_calls[].result` envelopes, matches each tool/operation name
 *      against an operation index, and emits packet-relative paths
 *      (`prior_tool_calls.0.result.properties.email`).
 *    - The enrichment resolver is SCOPE-keyed — a producer hands it its fixed
 *      `source_scope` (`'mail'` / `'contact'` / `connection.api.<vendor>.<entity>`)
 *      and it emits paths into the producer's source RECORD (`from`, `email`,
 *      `properties.email`), which the seam reads against `source_record.data`.
 *
 *  Scope mapping (entity-schema `scope` → `EnrichmentScope`):
 *    - `data.<collection>[.<...>]` (canonical_mirror / contributing_source)
 *      → `<collection>` (`data.mail` → `mail`, `data.contact` → `contact`). The
 *      first segment after `data.` is the enrichment collection scope; any
 *      target-id suffix is ignored.
 *    - `connection.api.<vendor>.<entity>` / `connection.{mcp,notification}`
 *      (platform_reference) → the scope string verbatim (it already matches the
 *      `EnrichmentScope` template).
 *    - `data.entity.<publisher>.<slug>.<entity>` (publisher-scoped) → skipped;
 *      no per-record enrichment producer reads a publisher-scoped scope today,
 *      and it isn't a member of the closed `EnrichmentScope` collection set.
 *
 *  No-op invariant: until an installed schema carries a privacy-tagged
 *  `MetaField` for a producer's scope, the resolver returns `[]`, the seam skips
 *  the wrap, and producer LLM calls round-trip byte-identical (the comfort
 *  default). An empty `local_manifest` table → `[]` for every scope.
 *
 *  Spec: docs/d-167-spec.md §Integration/D-165 (enrichment egress is a
 *  comfort-layer surface), §"Runtime flow", §"Scope". */

import type { EnrichmentScope, EntitySchemaIngredientInput, PiiFieldTag } from '@recued/contracts';

import type { LocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { piiPathsForMetaField } from '../meta-field-privacy-resolver.js';
import type { EnrichmentPiiTagSource } from './registry.js';
import { withDerivedVendorEntityPrivacy } from '../canonical-pii-schemas.js';

/** Map an entity-schema `scope` onto the `EnrichmentScope` a producer would
 *  declare as its `source_scope`. Returns `null` when the scope doesn't
 *  correspond to a per-record enrichment scope (publisher-scoped `data.entity.*`,
 *  or any unrecognised shape). */
const deriveEnrichmentScopeKey = (schemaScope: string): string | null => {
  // platform_reference / connection-level scopes already match the
  // `EnrichmentScope` template (`connection.api.<vendor>.<entity>` etc.).
  if (schemaScope.startsWith('connection.')) return schemaScope;
  // publisher-scoped — not a canonical collection scope; no per-record producer.
  if (schemaScope.startsWith('data.entity.')) return null;
  // canonical_mirror / contributing_source — `data.<collection>[.<id>]`; the
  // first segment after `data.` is the enrichment collection scope.
  if (schemaScope.startsWith('data.')) {
    const first = schemaScope.slice('data.'.length).split('.')[0];
    return first !== undefined && first.length > 0 ? first : null;
  }
  return null;
};

/** Build the scope → tag-list index from a snapshot of installed entity
 *  schemas. Two schemas that map to the same enrichment scope (e.g. Google
 *  Contacts + Outlook both contributing to `data.contact`) union their tagged
 *  fields; duplicate `(path, kind)` pairs collapse. */
const buildScopeIndex = (
  schemas: readonly EntitySchemaIngredientInput[],
): Map<string, PiiFieldTag[]> => {
  const buckets = new Map<string, { tags: PiiFieldTag[]; seen: Set<string> }>();
  for (const schema of schemas) {
    const key = deriveEnrichmentScopeKey(schema.scope);
    if (key === null) continue;
    const taggedFields = (schema.meta_fields ?? []).filter((field) => field.privacy !== undefined);
    if (taggedFields.length === 0) continue;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { tags: [], seen: new Set<string>() };
      buckets.set(key, bucket);
    }
    for (const field of taggedFields) {
      const kind = field.privacy;
      if (kind === undefined) continue;
      for (const path of piiPathsForMetaField(field)) {
        const dedupKey = `${path}\0${kind}`;
        if (bucket.seen.has(dedupKey)) continue;
        bucket.seen.add(dedupKey);
        bucket.tags.push({ path, kind });
      }
    }
  }
  const index = new Map<string, PiiFieldTag[]>();
  for (const [key, bucket] of buckets) index.set(key, bucket.tags);
  return index;
};

/** Build the enrichment-producer PII tag source from the per-pair local
 *  manifest store. Parity with the chat
 *  `createMetaFieldPrivacyResolverFromLocalManifestStore`; the housekeeping
 *  composer wires the returned function onto `HousekeepingContext.enrichmentPiiTagSource`.
 *
 *  Reads the installed schemas LIVE per call (same as the chat resolver reads
 *  per egress packet) so install / uninstall / in-place re-install all reflect
 *  on the next record — no cache, hence no staleness window where a freshly-
 *  tagged field keeps leaking (a slug-keyed memo would miss a same-slug
 *  overwrite that changed its privacy tags). The cost is bounded: the installed-
 *  composition set is small in practice (a handful of slugs), the per-record
 *  read is a couple of indexed SQLite selects + a JSON parse, and the harness is
 *  background + budget-yielding + idle-driven. If a profile ever shows this hot,
 *  a content-fingerprinted memo is a clean follow-on (version-bump support — N.9
 *  — isn't shipped, so a slug+version key would buy nothing today anyway). */
export const createEnrichmentPiiTagSourceFromLocalManifestStore = (
  store: Pick<LocalManifestStore, 'slugs' | 'getEntitySchemas'>,
  /** D-167 — shipped first-party canonical/CRM privacy-tagged schemas
   *  (`CANONICAL_PII_ENTITY_SCHEMAS`) the housekeeping boot wiring unions in so
   *  enrichment-producer egress is aliased by default with no install. Defaults
   *  to none (byte-identical no-op for existing callers); `buildScopeIndex` dedups
   *  `(path, kind)`, so a shipped + installed tag for the same scope collapses. */
  shippedSchemas: readonly EntitySchemaIngredientInput[] = [],
): EnrichmentPiiTagSource =>
  (scope: EnrichmentScope): readonly PiiFieldTag[] => {
    // Same kernel-derived CRM-contact privacy the chat resolver applies: a
    // `crm_alias: 'contact'` entity is a PERSON record by declaration, so its canonical
    // email / name / phone / company / address keys are tagged even when the pack that
    // declared it tagged nothing (every shipped pack CRM does exactly that). Without
    // this, a producer walking `connection.api.<packvendor>.contact` egresses the raw
    // record to the model. Author tags win; idempotent.
    const schemas = withDerivedVendorEntityPrivacy([
      ...shippedSchemas,
      ...store.slugs().flatMap((slug) => store.getEntitySchemas(slug)),
    ]);
    return buildScopeIndex(schemas).get(scope) ?? [];
  };
