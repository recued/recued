/** D-177 read-gating analog — the readable-collection vocabulary + the
 *  door-config AUTHORING inverse for the raw-collection read fence.
 *
 *  ## What lives here (slice 6 — the forward derivation retired)
 *  A door's per-collection read fence is now a set of explicit `data.<collection>`
 *  grant rows resolved by the backend read-grant checker (`read-grant-checker.ts`):
 *  the forward "scope_restrictions → readable-collection enum" derivation that this
 *  module used to own (`readableCollectionsFromScopeRestrictions` /
 *  `isCollectionReadAdmissible` / the per-topic `isEnrichmentTopicReadAdmissible`) was
 *  removed once slice 5 re-homed the fence onto grant rows. What survives is:
 *    - the closed {@link READABLE_COLLECTIONS} vocabulary + {@link isReadableCollection}
 *      guard (shared with the webclient grants panel + the read-grant checker), and
 *    - the AUTHORING inverse {@link scopeRestrictionsFromReadableCollections}: it turns
 *      the granted-collection set the read-grant checker resolves back into the
 *      execute-path `scope_restrictions` array `evaluateScopeAdmissibility` consumes, so
 *      the meta-tool read gate and the ingredient-read gate stay one fence.
 *
 *  Jurisdiction: this vocabulary governs the CLOSED `READABLE_COLLECTIONS` set (the
 *  user-data warehouse collections). Collections outside it — `memory` (gated by
 *  `read_memory`), `enrichment` topics (gated by D-136 MCP visibility), sidecar/infra
 *  (`annotation` / `link` / `service` / `shared`) — keep their own gates and are NOT
 *  governed here.
 *
 *  D-187 slice 3b — `webhook` is in the set: it is a ROOT incoming RESOURCE (external
 *  payloads flowing IN — like `mail` / `calendar`), NOT a sidecar (it has no parent
 *  record to derive its grant from) and NOT a `connection` (that is the OUTBOUND endpoint
 *  + credential, gated by pack-op). Its read ops (`core.data.webhook.get/list`) + the
 *  `data.webhook` collection grant are OWNER-default-only (see
 *  `OWNER_DEFAULT_ONLY_GRANT_ENTRIES`). Accepted `form_response` rows follow
 *  the same posture because their free-form contents have no field-level
 *  sensitivity declaration.
 *
 *  Spec: D-177 § N.12 (read-side analog); D-187 AMENDMENT (read-scope
 *  folded into the unified `(contract × grant)` matrix). */

import type { CanonicalCollectionName } from './canonical-record.js';
import { WORK_ENTITY_KINDS } from './work-entities.js';

/** The closed set of warehouse collections the read fence governs — the
 *  user-data collections a door's meta-tool reads (timeline / vector) can
 *  surface. A SUBSET of `CanonicalCollectionName`: the infra/sidecar
 *  collections (`service` / `shared` / `annotation` / `link`) are excluded —
 *  they are not entity surfaces a door reads through these tools, and the
 *  sidecars derive structurally from their parent (an annotation rides its
 *  target record's grant). `memory` + enrichment topics keep their own gates
 *  (see module doc). `webhook` and `form_response` are root incoming resources,
 *  not sidecars. */
export const READABLE_COLLECTIONS = [
  'mail',
  'calendar',
  'file',
  'contact',
  // ⚠ DERIVED. The exclusions above are deliberate curation, but the
  // work-entity members never were — they were a copy of the kind list,
  // and a kind missing here is not "less readable", it is OUTSIDE THE
  // FENCE'S JURISDICTION entirely: `isReadableCollection` answers false,
  // so the door read-grant surface has no opinion about it at all.
  // Every work entity is an entity surface a door reads.
  ...WORK_ENTITY_KINDS,
  'form_response',
  'webhook',
] as const satisfies readonly CanonicalCollectionName[];

export type ReadableCollection = (typeof READABLE_COLLECTIONS)[number];

const READABLE_COLLECTION_SET: ReadonlySet<string> = new Set(READABLE_COLLECTIONS);

/** True when `name` is one of the fence-governed readable collections.
 *  A collection OUTSIDE this set is out of this fence's jurisdiction
 *  (gated elsewhere — see module doc), NOT "denied" here. */
export const isReadableCollection = (name: string): name is ReadableCollection =>
  READABLE_COLLECTION_SET.has(name);

/** Lane A step 2 (door-config authoring) — the NON-governed scope families a
 *  collection fence must keep admitted. `scope_restrictions` is an ALLOW-list
 *  over EVERY gated scope (`deriveDispatchScope`: `connection.*` for
 *  connection-kind dispatches, `data.<family>` for storage-kind), so a fence
 *  authored to restrict only the governed READABLE_COLLECTIONS would — without
 *  these — collaterally deny the door's connection calls, enrichment writes,
 *  shared-store writes, and memory ops. Closed list of the non-governed
 *  families with their own gates (see the module doc's jurisdiction note).
 *  Deliberately ABSENT: `data.timeline` (the `timeline-read` unparseable-
 *  entity / platform-ref fallback scope — admitting it generically would let
 *  those reads bypass the per-collection fence; they fail closed instead) and
 *  any future `data.<family>` this list doesn't know (fail closed — a new
 *  family must be added here deliberately, never admitted by default). */
export const SCOPE_FENCE_KEEP_PATTERNS: readonly string[] = Object.freeze([
  'connection.*',
  'data.enrichment.*',
  'data.shared.*',
  'data.memory.*',
]);

/** Lane A step 2 — derive the `scope_restrictions` value the door-config UI
 *  authors (via `collection.contract.upsertContractPolicy`), and that
 *  `resolveContractScopeRestrictions` derives live from the read-grant checker's
 *  per-collection grants, from the set of governed collections left readable.
 *
 *  ALL governed collections allowed ⇒ `[]` — the read-all baseline; the UI
 *  should DELETE the fence cell rather than store an explicit admit-all
 *  (absent fence = the opt-out posture this module documents). A proper
 *  subset ⇒ the keep-patterns plus one `data.<c>.*` per allowed collection
 *  (the `.* ` form matches both the bare `data.<c>` ingredient scope and any
 *  sub-path, per `matchScopePattern`'s prefix rule).
 *
 *  The produced restrictions are consumed by `evaluateScopeAdmissibility` /
 *  `evaluateScopeRestrictions` at the execute gate — so the meta-tool read fence
 *  (grant rows) and the ingredient-read fence (this array) can never disagree
 *  about what a checkbox means. */
export const scopeRestrictionsFromReadableCollections = (
  allowed: ReadonlySet<ReadableCollection>,
): string[] => {
  if (READABLE_COLLECTIONS.every((c) => allowed.has(c))) return [];
  return [
    ...SCOPE_FENCE_KEEP_PATTERNS,
    ...READABLE_COLLECTIONS.filter((c) => allowed.has(c)).map(
      (c) => `data.${c}.*`,
    ),
  ];
};
