/** D-129 Phase 7 — Read-side alias resolver for platform-reference
 *  enrichment refs.
 *
 *  Cosmetic ergonomics. Two equivalent paths resolve identically:
 *
 *      data.enrichment.connection.api.<vendor>.<entity>.<id>[.<rest>]   ← canonical (D-128)
 *      data.<vendor>.<entity>.<id>.enrichments[.<rest>]                 ← D-129 alias
 *
 *  This module is the single source of truth for the rewrite. The
 *  runtime resolver (`parseRef` in resolve.ts) calls
 *  `tryRewriteVendorEnrichmentAlias` so aliased refs reach the same
 *  backing store; the recipe validator (references.ts) calls it so
 *  topic / scope / permission gates apply uniformly to both forms.
 *
 *  No alias for the bare entity (`data.<vendor>.<entity>.<id>` without
 *  the `.enrichments` suffix). Bare-entity reads still go through the
 *  connection adapter via the existing per-vendor wrappers — the alias
 *  is enrichment-only and explicitly NOT a virtual collection
 *  (spec §A.7 decision §5).
 *
 *  Spec: docs/d-129-spec.md §A.7 + §Phase 7. */

import {
  CONNECTION_VENDOR_ENTITIES,
  type ConnectionVendorEntity,
} from './connection-vendors.js';

const VENDOR_ENTITY_REGEX = /^[a-z][a-z0-9_]*$/;
const ALIAS_MARKER = '.enrichments';

/** Reserved sub-namespaces under `data.*` that vendors must not shadow.
 *  At registry registration time, every entry's `vendor` is checked
 *  against this set — overlap would mean an alias path
 *  `data.<vendor>.<entity>.<id>.enrichments...` could be ambiguous with
 *  the reserved data sub-namespace surface.
 *
 *  Membership tracks current data.* surface:
 *    - `memory` / `audit`     (D-120 Phase 4 read-only memory)
 *    - `enrichment`           (D-122 + D-128 enrichment surface)
 *    - `mail` / `calendar`    (D-106, D-117 warehouse collections)
 *    - `contact`              (D-121 personal contact graph)
 *    - `file`                 (warehouse files collection)
 *    - `shared`               (D-103 user-writable durable records)
 *    - `service`              (D-118 platform)
 *    - `crm`                  (D-130 P7 cross-vendor logical layer —
 *                              `data.crm.<crm_alias>.<full_target_id>.enrichments.<topic>`
 *                              dispatches across CRM vendors via the
 *                              registry's `crm_alias` annotation; no
 *                              vendor may register itself as `'crm'`).
 *    - `task` / `note` /
 *      `commitment` / `project` (D-145 PA1 work-entity substrate — the
 *                              four canonical kinds resolved
 *                              polymorphically per Source. Reserving
 *                              these prevents a vendor from shadowing
 *                              `data.task.*` etc. via the D-129 alias
 *                              path; vendor-supplied tasks reach
 *                              recipes through `data.<kind>.<source_id>.*`
 *                              scoped by the Source primitive (PA2)).
 *
 *  Future warehouse / first-class data.* sub-namespaces should be
 *  added here when they land. The list is small enough that a
 *  declarative literal is clearer than synthesising it from other
 *  constants. */
export const RESERVED_DATA_SUBNAMESPACES: ReadonlySet<string> = new Set([
  'memory',
  'audit',
  'enrichment',
  'mail',
  'calendar',
  'contact',
  'file',
  'shared',
  'service',
  'crm',
  'task',
  'note',
  'commitment',
  'project',
]);

/** Parsed alias components — surfaced for callers that want the
 *  individual parts (e.g. validator error messages can mention the
 *  vendor / entity without re-splitting). */
export interface VendorEnrichmentAliasMatch {
  vendor: string;
  entity: string;
  /** Target id segment after `<vendor>.<entity>.` and before the
   *  `.enrichments` marker. Can contain dots and `@` (canonical-email
   *  contact ids). */
  targetId: string;
  /** Everything after `.enrichments.`, or empty string for the bag
   *  form `data.<vendor>.<entity>.<id>.enrichments`. */
  rest: string;
  /** Canonical post-`data.` path: `enrichment.connection.api.<vendor>.<entity>.<id>[.<rest>]`. */
  canonicalPostData: string;
}

/** Match the alias shape against the registry. Returns the parsed
 *  components when the path is a recognised alias, otherwise null.
 *
 *  The match recognises the bag form (`<vendor>.<entity>.<id>.enrichments`
 *  with no topic) as well as the topic + drill forms. Bag rewrites to
 *  the canonical bag (no trailing topic), which the validator already
 *  silently accepts.
 *
 *  Target ids carry dots / `@` (canonical-email contact ids), so the
 *  cut between id and the `.enrichments` marker uses `lastIndexOf`
 *  with a boundary check (marker followed by `.` or end-of-string).
 *  When the rightmost `.enrichments` substring fails the boundary
 *  test (e.g. it's part of an id like `xxx.enrichments_v2.…`), the
 *  walker falls back to the next-earlier match. */
export function matchVendorEnrichmentAlias(
  pathPostData: string,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): VendorEnrichmentAliasMatch | null {
  // First two segments — `<vendor>.<entity>.` — must match the
  // identifier regex AND be registered.
  const firstDot = pathPostData.indexOf('.');
  if (firstDot < 1) return null;
  const vendor = pathPostData.slice(0, firstDot);
  if (!VENDOR_ENTITY_REGEX.test(vendor)) return null;

  const secondDot = pathPostData.indexOf('.', firstDot + 1);
  if (secondDot < firstDot + 2) return null;
  const entity = pathPostData.slice(firstDot + 1, secondDot);
  if (!VENDOR_ENTITY_REGEX.test(entity)) return null;

  let registered = false;
  for (const e of registry) {
    if (e.vendor === vendor && e.entity === entity) {
      registered = true;
      break;
    }
  }
  if (!registered) return null;

  // After `<vendor>.<entity>.`, the path is `<id>[.<rest>]`. Find the
  // `.enrichments` marker — must be preceded by at least one char of
  // id (markerIdx >= 1) and followed by either end-of-string (bag form)
  // or `.` (topic + drill).
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

  const targetId = idAndRest.slice(0, markerIdx);
  if (targetId.length === 0) return null;
  const afterMarker = markerIdx + ALIAS_MARKER.length;
  const rest = afterMarker < idAndRest.length
    ? idAndRest.slice(afterMarker + 1)
    : '';

  let canonicalPostData = `enrichment.connection.api.${vendor}.${entity}.${targetId}`;
  if (rest !== '') canonicalPostData += `.${rest}`;

  return { vendor, entity, targetId, rest, canonicalPostData };
}

/** Convenience wrapper — return just the canonical post-`data.` path,
 *  null when no rewrite applies. Used by the resolver and validator
 *  walks where the structural fields of the match aren't needed. */
export function tryRewriteVendorEnrichmentAlias(
  pathPostData: string,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): string | null {
  const m = matchVendorEnrichmentAlias(pathPostData, registry);
  return m === null ? null : m.canonicalPostData;
}

/** Boot-validation hook — verify no registered vendor name shadows a
 *  reserved `data.*` sub-namespace. Wired from
 *  `assertConnectionVendorRegistry` so misconfiguration surfaces at
 *  module load. Returns issue strings; empty when clean. */
export function assertNoVendorPrefixClash(
  registry: ReadonlyArray<ConnectionVendorEntity>,
  reserved: ReadonlySet<string> = RESERVED_DATA_SUBNAMESPACES,
): string[] {
  const issues: string[] = [];
  registry.forEach((entry, idx) => {
    if (reserved.has(entry.vendor)) {
      issues.push(
        `[${idx}] vendor '${entry.vendor}' shadows a reserved data.* sub-namespace ` +
          `(reserved: ${[...reserved].sort().join(', ')}) — ` +
          `alias 'data.${entry.vendor}.<entity>.<id>.enrichments.<topic>' would clash`,
      );
    }
  });
  return issues;
}

// Defensive boot validation. Lives here (not in connection-vendors.ts)
// to avoid a module-init cycle: this module imports
// `CONNECTION_VENDOR_ENTITIES` from connection-vendors.ts; pulling
// `assertNoVendorPrefixClash` back into connection-vendors.ts as a
// boot caller would form a cycle whose call site reads
// `RESERVED_DATA_SUBNAMESPACES` before its `const` initialiser ran.
// Running the check from the tail of this module guarantees both
// `RESERVED_DATA_SUBNAMESPACES` and `CONNECTION_VENDOR_ENTITIES` are
// fully initialised by the time the check fires.
const _aliasClashIssues = assertNoVendorPrefixClash(CONNECTION_VENDOR_ENTITIES);
if (_aliasClashIssues.length > 0) {
  throw new Error(
    `CONNECTION_VENDOR_ENTITIES alias-prefix clash: ${_aliasClashIssues.join('; ')}`,
  );
}
