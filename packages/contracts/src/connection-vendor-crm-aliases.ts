/** D-130 Phase 7 — Cross-vendor `data.crm.*` read-side resolver.
 *
 *  The novel architectural contribution of D-130. Sister module to
 *  `connection-vendor-aliases.ts` (D-129 P7's vendor-specific alias)
 *  but lifts one level higher — `data.crm.<crm_alias>.<full_target_id>.enrichments[.<rest>]`
 *  dispatches across CRM vendors via the registry's `crm_alias`
 *  annotation + the `<full_target_id>`'s vendor-prefix discriminator.
 *
 *  Three equivalent paths resolve identically for CRM enrichments:
 *
 *      data.enrichment.connection.api.hubspot.deal.hubspot_deal_47291.deal_health_score          ← canonical (D-128)
 *      data.hubspot.deal.hubspot_deal_47291.enrichments.deal_health_score                        ← vendor alias (D-129 P7)
 *      data.crm.deal.hubspot_deal_47291.enrichments.deal_health_score                            ← cross-vendor alias (D-130 P7)
 *
 *  Why prefix-based dispatch on `<full_target_id>`:
 *  the full target_id is *already* vendor-namespaced
 *  (`hubspot_deal_<id>` vs `salesforce_opportunity_<id>`) by D-128
 *  invariant — the cross-vendor layer doesn't need to ask "which
 *  vendor"; the target_id answers it. Path-rewrite at resolve time
 *  keeps the cross-vendor layer purely logical: zero new tables,
 *  zero new persistence, zero cross-vendor pointers — a thin lens
 *  over `connection.api.<vendor>.<entity>.*`.
 *
 *  Static-id only. The recipe validator hard-errors `nested_template`
 *  on dynamic ids inside `data.crm.*`; recipes that need to iterate
 *  use the `enrichment-list` ingredient (vendor-agnostic by
 *  construction — rows carry `connection_scope`) or the canonical
 *  `data.enrichment.*` form.
 *
 *  No bare-entity read. `data.crm.deal.<id>` (without `.enrichments.<topic>`
 *  suffix) is NOT a valid path — the cross-vendor layer is
 *  enrichment-only. Vendor-specific record reads go through the
 *  existing `connection` adapter via per-vendor wrappers
 *  (`deal-reader-hubspot` / `opportunity-reader-salesforce`).
 *
 *  Spec: D-130 §A.7.2 + §Phase 7. */

import {
  CONNECTION_VENDOR_ENTITIES,
  CRM_ALIAS_VALUES,
  type ConnectionVendorEntity,
  type CrmAlias,
} from './connection-vendors.js';

const CRM_NAMESPACE = 'crm';
const ALIAS_MARKER = '.enrichments';
const CRM_ALIAS_SET: ReadonlySet<string> = new Set(CRM_ALIAS_VALUES);

/** Parsed cross-vendor alias components — surfaced for callers that
 *  want the dispatched (vendor, entity) without re-parsing. */
export interface CrmAliasMatch {
  /** The cross-vendor logical entity name from the path's third
   *  segment (`'deal'` / `'contact'` / `'account'`). */
  crmAlias: CrmAlias;
  /** Concrete vendor the target_id dispatches to (`'hubspot'`,
   *  `'salesforce'`, …). */
  vendor: string;
  /** Concrete vendor entity the target_id dispatches to (`'deal'`,
   *  `'opportunity'`, `'company'`, `'account'`). */
  entity: string;
  /** Full platform-reference target_id (e.g. `'hubspot_deal_47291'`
   *  or `'salesforce_opportunity_001A0000005XYZAB'`). */
  targetId: string;
  /** Everything after `.enrichments.`, or empty string for the bag
   *  form `data.crm.<crm_alias>.<full_target_id>.enrichments`. */
  rest: string;
  /** Canonical post-`data.` path:
   *  `enrichment.connection.api.<vendor>.<entity>.<full_target_id>[.<rest>]`. */
  canonicalPostData: string;
}

/** Match the cross-vendor alias shape against the registry. Returns
 *  the parsed components when the path is a recognised CRM alias,
 *  otherwise null.
 *
 *  Recognises bag form (no topic) as well as topic + drill forms;
 *  bag rewrites to canonical bag (no trailing topic), which the
 *  validator already silently accepts.
 *
 *  Vendor / entity dispatch on `<full_target_id>`:
 *  the target_id starts with `<vendor>_<entity>_<bareId>` per the
 *  D-128 reconciler convention. The matcher walks every registered
 *  vendor entity whose `crm_alias` matches the path's third segment
 *  and picks the entry whose `<vendor>_<entity>_` prefix matches the
 *  target_id. Single-match invariant is enforced by the registry's
 *  within-vendor `crm_alias` uniqueness check (so at most one entry
 *  per vendor matches a given alias) plus the lexically distinct
 *  `<vendor>` segment of the prefix (so cross-vendor matches can't
 *  collide). */
export function matchCrmAlias(
  pathPostData: string,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): CrmAliasMatch | null {
  const firstDot = pathPostData.indexOf('.');
  if (firstDot < 1) return null;
  if (pathPostData.slice(0, firstDot) !== CRM_NAMESPACE) return null;

  const secondDot = pathPostData.indexOf('.', firstDot + 1);
  if (secondDot < firstDot + 2) return null;
  const crmAlias = pathPostData.slice(firstDot + 1, secondDot);
  if (!CRM_ALIAS_SET.has(crmAlias)) return null;

  // After `crm.<crmAlias>.`, the path is `<full_target_id>[.<rest>]`.
  // Find `.enrichments` boundary the same way as the vendor alias
  // (target_ids are dot-free in practice, but the boundary walk keeps
  // the matcher robust against any registry that adds dotted ids
  // later).
  const idAndRest = pathPostData.slice(secondDot + 1);
  let markerIdx = -1;
  let cursor = idAndRest.length;
  while (cursor > 0) {
    const found = idAndRest.lastIndexOf(ALIAS_MARKER, cursor);
    if (found < 1) break;
    const after = found + ALIAS_MARKER.length;
    if (after === idAndRest.length || idAndRest[after] === '.') {
      markerIdx = found;
      break;
    }
    cursor = found - 1;
  }
  if (markerIdx < 1) return null;

  const fullTargetId = idAndRest.slice(0, markerIdx);
  if (fullTargetId.length === 0) return null;
  const afterMarker = markerIdx + ALIAS_MARKER.length;
  const rest = afterMarker < idAndRest.length
    ? idAndRest.slice(afterMarker + 1)
    : '';

  // Dispatch via target_id prefix. Walk every registered entry whose
  // crm_alias matches; pick the first whose `<vendor>_<entity>_`
  // prefix matches the target_id. Within-vendor crm_alias uniqueness
  // is registry-asserted so per-vendor matching is unambiguous; the
  // distinct vendor segments make cross-vendor matching unambiguous.
  let dispatched: ConnectionVendorEntity | null = null;
  for (const entry of registry) {
    if (entry.crm_alias !== crmAlias) continue;
    const prefix = `${entry.vendor}_${entry.entity}_`;
    if (fullTargetId.startsWith(prefix)) {
      dispatched = entry;
      break;
    }
  }
  if (dispatched === null) return null;

  let canonicalPostData =
    `enrichment.connection.api.${dispatched.vendor}.${dispatched.entity}.${fullTargetId}`;
  if (rest !== '') canonicalPostData += `.${rest}`;

  return {
    crmAlias: crmAlias as CrmAlias,
    vendor: dispatched.vendor,
    entity: dispatched.entity,
    targetId: fullTargetId,
    rest,
    canonicalPostData,
  };
}

/** Convenience wrapper — return just the canonical post-`data.` path,
 *  null when no rewrite applies. Used by the resolver and validator
 *  walks where the structural fields of the match aren't needed. */
export function tryRewriteCrmAlias(
  pathPostData: string,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): string | null {
  const m = matchCrmAlias(pathPostData, registry);
  return m === null ? null : m.canonicalPostData;
}
