/** D-192 P5 — scoped relationship-reference resolution.
 *
 *  One folded Source row × its declaration's `relationships` → the
 *  row's desired `work_entity_edge` set. References are re-derived
 *  from the RAW vendor row through the projector's own
 *  `extractRelationshipRefs` (one extraction seam — the edge set and
 *  the `rel_*` extension hints can never disagree); this module only
 *  runs AFTER a successful projection fold, so malformed references
 *  have already failed the row.
 *
 *  Resolution posture (spec § Identity and relationships):
 *  - `contact` — SPARSE by construction: an edge exists only when the
 *    reference resolves through the D-138 stack to a stable
 *    `contact_id` (platform link → canonical email → `merged_into`
 *    survivor). Unresolved references stay `rel_*` extension hints —
 *    never an edge, never a raw vendor id in a canonical column. The
 *    M6 crm.contact downgrade (CRM-only contact with no `data.contact`
 *    row) is a declared-target concern, not an automatic fallback.
 *  - `crm.deal` / `crm.contact` / `crm.account` — `remote_id` pairing
 *    only; resolved by COMPOSITION to the D-190 platform-reference
 *    `full_target_id` via the `crm_alias` registry (the engagement-
 *    edges precedent: no local existence check). A vendor without the
 *    alias fails closed (no edge — the hint stays).
 *  - `task` / `project` / `note` — `remote_id` pairing resolves through
 *    the SIBLING Source's mirror row (`<stem>.<kind>` — the
 *    `CONNECTION_SOURCE_ID` format guarantees the id stem is shared
 *    per connection); a target that has not synced yet persists as a
 *    scoped UNRESOLVED edge and self-heals via the per-cycle
 *    re-resolution pass. `canonical_id` pairing (the vendor field
 *    already stores a Recued row id) verifies existence before
 *    admitting — a bogus local id must never enter the graph.
 *  - `calendar.event` / `mail_message` — v1 persists the scoped
 *    reference (`remote_id` pairing) only; no local resolver yet.
 *
 *  Pure over its injected lookups — no SQL here. */

import {
  getVendorEntityByCrmAlias,
  composePlatformRecordTargetId,
  workEntityContactEdgeKey,
  workEntityCrmEdgeKey,
  workEntityLocalEdgeKey,
  workEntityRefEdgeKey,
  workEntityWorkEdgeKey,
  WORK_ENTITY_EDGE_RERESOLVE_BATCH,
  CONNECTION_VENDOR_ENTITIES,
  type ConnectionVendorEntity,
  type CrmAlias,
  type WorkEntityEdgeWrite,
  type WorkEntitySourceRelationship,
} from '@recued/contracts';

import { extractRelationshipRefs } from './work-entity-source-projector.js';
import type { WorkEntityProjectionDeclaration } from './work-entity-source-projector.js';
import type {
  WorkEntityEdgeStore,
} from './storage/work-entity-edge-store.js';
import type { WorkEntitySourceMirrorStore } from './storage/work-entity-source-mirror.js';

// ────────────────────────────────────────────────────────────────
// Injected lookup surfaces (structural — the contact store and the
// Source-identity mirror satisfy these directly)
// ────────────────────────────────────────────────────────────────

export interface WorkEntityEdgeContactLookup {
  /** D-138 platform link: `(vendor, platform_id)` → canonical email. */
  lookupPlatformLink(vendor: string, platform_id: string): string | null;
  /** Walk `merged_into` to the survivor's canonical email. Throws on a
   *  corrupted chain (treated here as unresolved). */
  resolveCanonicalEmail(email: string): { canonical_email: string; chain_depth: number };
  /** Canonical-email row read — carries the stable `contact_id`. */
  get(email: string): { contact_id?: string } | null;
  /** D-192 P5 forward-resolver: contact_id → survivor row. */
  getByContactIdResolved(contact_id: string): { contact_id?: string } | null;
}

/** Local-row existence checks for `canonical_id`-paired work targets. */
export interface WorkEntityEdgeLocalRowLookup {
  readTask(id: string): { id: string } | null;
  readProject(id: string): { id: string } | null;
  readNote(id: string): { id: string } | null;
}

export interface WorkEntityEdgeResolutionDeps {
  contacts?: WorkEntityEdgeContactLookup;
  mirror?: Pick<WorkEntitySourceMirrorStore, 'getBySourceIdentity'>;
  workStore?: WorkEntityEdgeLocalRowLookup;
  /** D-192 unit-3 — the LIVE merged vendor registry (built-ins + each
   *  installed pack's lifted entities, i.e. `liveVendorRegistry(store)`), so
   *  a `crm.<alias>` edge on a PACK-declared CRM resolves the alias to its
   *  `(vendor, entity)`. Absent → frozen builtin (built-in CRMs unaffected;
   *  a pack CRM's crm-edge stays a hint until wired). */
  resolveVendorRegistry?: () => ReadonlyArray<ConnectionVendorEntity>;
}

export interface DesiredWorkEntityEdgesInput {
  declaration: Pick<WorkEntityProjectionDeclaration, 'kind' | 'relationships'>;
  source_id: string;
  connection_name: string;
  /** The connection's vendor (drives platform-link + crm_alias
   *  resolution). Null when unknown — vendor-dependent references
   *  simply stay hints. */
  vendor: string | null;
  raw: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────
// Reference resolution
// ────────────────────────────────────────────────────────────────

/** Sibling Source id for a work-entity target: the owning Source id
 *  with its trailing `.<kind>` segment swapped. Sound by the
 *  `CONNECTION_SOURCE_ID` format (validator-enforced: the id ends with
 *  its entity kind) — sibling Sources on one connection share the stem. */
const siblingSourceId = (source_id: string, target_kind: string): string | null => {
  const idx = source_id.lastIndexOf('.');
  if (idx <= 0) return null;
  return `${source_id.slice(0, idx)}.${target_kind}`;
};

const remoteFields = (
  rel: WorkEntitySourceRelationship,
  ref: string,
): Pick<WorkEntityEdgeWrite, 'target_remote_entity' | 'target_remote_id'> => ({
  ...(rel.remote_entity !== undefined ? { target_remote_entity: rel.remote_entity } : {}),
  target_remote_id: ref,
});

const resolveContactReferenceEdge = (
  rel: WorkEntitySourceRelationship,
  ref: string,
  input: DesiredWorkEntityEdgesInput,
  deps: WorkEntityEdgeResolutionDeps,
): WorkEntityEdgeWrite | null => {
  const contacts = deps.contacts;
  if (contacts === undefined) return null;

  if (rel.pairing === 'canonical_id') {
    // The vendor field claims a Recued contact_id — forward-resolve to
    // the survivor (a merge loser's id keeps working) and re-key the
    // edge on the SURVIVOR's id so the graph converges post-merge.
    const survivor = contacts.getByContactIdResolved(ref);
    const contact_id = survivor?.contact_id;
    if (contact_id === undefined) return null;
    return {
      local_field: rel.local_field,
      target_kind: 'contact',
      target_scoped_key: workEntityContactEdgeKey(contact_id),
      target_local_id: contact_id,
    };
  }

  let email: string | null = null;
  if (rel.pairing === 'remote_id') {
    if (input.vendor === null) return null;
    email = contacts.lookupPlatformLink(input.vendor, ref);
  } else if (rel.lookup_key === 'email') {
    email = ref;
  } else {
    return null; // url / slug / external_key contact lookups — no v1 resolver
  }
  if (email === null) return null;

  let canonical: string;
  try {
    canonical = contacts.resolveCanonicalEmail(email).canonical_email;
  } catch {
    return null; // corrupted redirect chain — unresolved, the hint stays
  }
  const contact_id = contacts.get(canonical)?.contact_id;
  if (contact_id === undefined) return null;
  return {
    local_field: rel.local_field,
    target_kind: 'contact',
    target_scoped_key: workEntityContactEdgeKey(contact_id),
    target_local_id: contact_id,
    ...(rel.pairing === 'remote_id' ? remoteFields(rel, ref) : {}),
  };
};

const resolveCrmReferenceEdge = (
  rel: WorkEntitySourceRelationship,
  ref: string,
  input: DesiredWorkEntityEdgesInput,
  deps: WorkEntityEdgeResolutionDeps,
): WorkEntityEdgeWrite | null => {
  if (rel.pairing !== 'remote_id' || input.vendor === null) return null;
  const alias = rel.target.slice('crm.'.length) as CrmAlias;
  const entry = getVendorEntityByCrmAlias(
    input.vendor,
    alias,
    deps.resolveVendorRegistry?.() ?? CONNECTION_VENDOR_ENTITIES,
  );
  if (entry === null) return null; // vendor doesn't model the alias — fail closed
  return {
    local_field: rel.local_field,
    target_kind: rel.target,
    target_scoped_key: workEntityCrmEdgeKey(input.vendor, entry.entity, ref),
    target_local_id: composePlatformRecordTargetId(
      input.vendor, entry.entity, input.connection_name, ref,
    ),
    target_remote_entity: rel.remote_entity ?? entry.entity,
    target_remote_id: ref,
  };
};

const resolveWorkReferenceEdge = (
  rel: WorkEntitySourceRelationship,
  ref: string,
  input: DesiredWorkEntityEdgesInput,
  deps: WorkEntityEdgeResolutionDeps,
): WorkEntityEdgeWrite | null => {
  const target = rel.target as 'task' | 'project' | 'note';
  if (rel.pairing === 'remote_id') {
    const target_source_id = siblingSourceId(input.source_id, target);
    if (target_source_id === null) return null;
    const local = deps.mirror !== undefined
      ? deps.mirror.getBySourceIdentity(target, target_source_id, ref)
      : null;
    return {
      local_field: rel.local_field,
      target_kind: target,
      target_scoped_key: workEntityWorkEdgeKey(target, target_source_id, ref),
      target_source_id,
      ...remoteFields(rel, ref),
      ...(local !== null ? { target_local_id: local.id } : {}),
    };
  }
  if (rel.pairing === 'canonical_id') {
    const store = deps.workStore;
    if (store === undefined) return null;
    const row = target === 'task'
      ? store.readTask(ref)
      : target === 'project' ? store.readProject(ref) : store.readNote(ref);
    if (row === null) return null; // vendor claims a local id that doesn't exist
    return {
      local_field: rel.local_field,
      target_kind: target,
      target_scoped_key: workEntityLocalEdgeKey(target, ref),
      target_local_id: ref,
    };
  }
  return null; // lookup-paired work targets — no v1 resolver
};

const resolveReferenceEdge = (
  rel: WorkEntitySourceRelationship,
  ref: string,
  input: DesiredWorkEntityEdgesInput,
  deps: WorkEntityEdgeResolutionDeps,
): WorkEntityEdgeWrite | null => {
  switch (rel.target) {
    case 'contact':
      return resolveContactReferenceEdge(rel, ref, input, deps);
    case 'crm.deal':
    case 'crm.contact':
    case 'crm.account':
      return resolveCrmReferenceEdge(rel, ref, input, deps);
    case 'task':
    case 'project':
    case 'note':
      return resolveWorkReferenceEdge(rel, ref, input, deps);
    case 'calendar.event':
    case 'mail_message':
      // v1: scoped reference only (no local resolver) — `remote_id`
      // pairing carries enough identity to preserve; anything else
      // stays a hint.
      if (rel.pairing !== 'remote_id') return null;
      return {
        local_field: rel.local_field,
        target_kind: rel.target,
        target_scoped_key: workEntityRefEdgeKey(rel.target, rel.remote_entity, ref),
        ...remoteFields(rel, ref),
      };
  }
};

/** The desired edge set for one successfully-folded row. */
export const desiredWorkEntityEdgesForRow = (
  input: DesiredWorkEntityEdgesInput,
  deps: WorkEntityEdgeResolutionDeps,
): WorkEntityEdgeWrite[] => {
  const out: WorkEntityEdgeWrite[] = [];
  for (const rel of input.declaration.relationships ?? []) {
    const extracted = extractRelationshipRefs(rel, input.raw);
    // `!ok` can only mean projector/extractor drift — the projection
    // fold already failed malformed rows before edges are computed.
    if (extracted === undefined || !extracted.ok) continue;
    for (const ref of extracted.refs) {
      const edge = resolveReferenceEdge(rel, ref, input, deps);
      if (edge !== null) out.push(edge);
    }
  }
  return out;
};

// ────────────────────────────────────────────────────────────────
// Late re-resolution (per sync cycle)
// ────────────────────────────────────────────────────────────────

/** Resolve `work:`-scoped edges written before their target synced —
 *  the self-heal for sibling-Source ordering (a task pointing at a
 *  project that lands a cycle later). Only work-entity targets carry a
 *  `target_source_id` to retry against; contact edges are never stored
 *  unresolved and crm/ref edges have no local resolver to retry.
 *  Returns the count resolved this pass. */
export const reResolveWorkEntityEdges = (
  edges: Pick<WorkEntityEdgeStore, 'listUnresolved' | 'markResolved'>,
  deps: WorkEntityEdgeResolutionDeps,
  source_id: string,
  now: () => number,
  batch: number = WORK_ENTITY_EDGE_RERESOLVE_BATCH,
): number => {
  const mirror = deps.mirror;
  if (mirror === undefined) return 0;
  let resolved = 0;
  for (const edge of edges.listUnresolved(source_id, batch)) {
    if (
      (edge.target_kind !== 'task' && edge.target_kind !== 'project'
        && edge.target_kind !== 'note')
      || edge.target_source_id === undefined
      || edge.target_remote_id === undefined
    ) {
      continue;
    }
    const row = mirror.getBySourceIdentity(
      edge.target_kind, edge.target_source_id, edge.target_remote_id,
    );
    if (row === null) continue;
    if (edges.markResolved(edge, row.id, now())) resolved += 1;
  }
  return resolved;
};
