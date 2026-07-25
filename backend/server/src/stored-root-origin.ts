/** D-177 N.11 rule 1 — stored-row origin resolution for the
 *  open-projection walk's per-row cleanliness gate.
 *
 *  The walk hands this resolver a CANONICAL `data.*` ref string (post
 *  alias-rewrite, statically known — the walk refuses dynamic nested
 *  keys before ever calling here) and expects back the provenance
 *  facets of exactly ONE stored row — the same row the runtime
 *  resolver would serve for that ref — or `undefined` whenever the ref
 *  does not name one unambiguous gateable row. `undefined` reads as
 *  NOT user-clean at the walk (the root stays `'stored'`, tainted →
 *  pinned), so every refusal here is fail-closed by construction.
 *
 *  The v1 gateable grammar — deliberately the INTERSECTION of "rows a
 *  human can author through their own paired client" and "refs the
 *  runtime actually resolves":
 *
 *  - `data.<col>.<dotted-id>.annotations.<key>` — the latest annotation
 *    row for the key, on any prefetch-annotatable collection. Dotted
 *    record ids (canonical contact emails) are handled by the SAME
 *    right-anchored tag grammar the engine prefetch parses
 *    (`parseAnnotationLinkRef` — one grammar, imported, never
 *    re-implemented): the tag sits at the last or second-to-last
 *    segment, so the id is everything between collection and tag.
 *    Bare `.annotations` group reads (`rest = []`) and `.links.*` /
 *    `.inbound_links.*` (plural rows) return undefined — pinned.
 *  - `data.contact.<dotted-email>[.<field>]` — the contact RECORD.
 *    Where the dotted email id ends and the field path begins is not
 *    statically decidable (`jane.doe@example.com.phone` — the parser
 *    limitation that blocked this gate), so resolution is
 *    STORE-ASSISTED: try progressively shorter segment prefixes as the
 *    record key, LONGEST FIRST, and take the first existing row. The
 *    store is the only authority on which key exists. Longest-first is
 *    the fail-closed direction: a maliciously-registered LONGER key
 *    (`jane.doe@example.com.phone` as a literal contact email,
 *    shadowing `jane.doe@example.com`) can only substitute ITS OWN
 *    facets — an agent-created shadow row is agent-stamped, so the
 *    gate reads tainted and pins; it can never make a tainted row read
 *    clean. (Note: bare contact-record field refs do not resolve at
 *    runtime yet — there is no record prefetch — so this arm is
 *    value-inert today and exists to keep the gate correct the day a
 *    record prefetch lands. The LIVE gate surface is annotations.)
 *
 *  Everything else (`data.mail.<id>.subject`, `data.memory.*`,
 *  `data.enrichment.*`, work entities, vendor aliases, …) returns
 *  undefined: those rows are adapter-/system-/recipe-written and would
 *  fail `isUserCleanStoredRow` anyway — the closed v1 list keeps the
 *  resolver auditable.
 *
 *  SYNCHRONOUS by contract (the walk is sync): both lookups are
 *  better-sqlite3 prepared statements; the annotation read is the
 *  facet-only `latestAnnotationProvenance` (no blob I/O).
 *
 *  Spec: docs/d-177-spec.md § N.11 rule 1; landing order P5 follow-on. */

import type { StoredRowProvenance } from '@recued/contracts';
import { parseAnnotationLinkRef } from '@recued/engine';
import type { AnnotationStore } from './storage/annotation-store.js';
import type { ContactStore } from './storage/contact-store.js';

export interface StoredRowOriginResolverDeps {
  contactStore?: ContactStore;
  annotationStore?: AnnotationStore;
}

/** Segment-count ceiling on the contact-id prefix search. Canonical
 *  emails split into a handful of segments; a path beyond this is not
 *  a contact ref worth probing (each candidate is one indexed PK get,
 *  so this is a tidiness bound, not a performance one). */
const MAX_CONTACT_ID_SEGMENTS = 16;

const PROTOTYPE_SENSITIVE = new Set(['__proto__', 'constructor', 'prototype']);

/** Build the sync resolver the open-projection walk consumes
 *  (`ComputeOpenProjectionArgs.resolveStoredRowOrigin`). Pure closure
 *  over the two stores; reads rows LIVE on every call — the per-fire
 *  re-walk depends on seeing the row's current facets, so nothing here
 *  is cached. */
export const createStoredRowOriginResolver = (
  deps: StoredRowOriginResolverDeps,
): ((canonicalRef: string) => StoredRowProvenance | undefined) => {
  return (canonicalRef: string): StoredRowProvenance | undefined => {
    if (typeof canonicalRef !== 'string') return undefined;
    if (!canonicalRef.startsWith('data.')) return undefined;
    // The walk never passes unresolved templates, but a stray brace
    // means we cannot know which row is named — refuse.
    if (canonicalRef.includes('{{')) return undefined;
    const path = canonicalRef.slice('data.'.length);
    const segments = path.split('.');
    if (segments.some((s) => s.length === 0 || PROTOTYPE_SENSITIVE.has(s))) {
      return undefined;
    }

    // ── Annotation-key refs (the LIVE gate surface) ───────────────
    // Same grammar as the engine prefetch; an exact-key ref is the one
    // shape that resolves to a single latest row.
    const annotationRef = parseAnnotationLinkRef(path);
    if (annotationRef !== null) {
      if (
        annotationRef.kind !== 'annotation'
        || annotationRef.rest.length !== 1
        || deps.annotationStore === undefined
      ) {
        return undefined;
      }
      return deps.annotationStore.latestAnnotationProvenance(
        annotationRef.collection,
        annotationRef.id,
        annotationRef.rest[0],
      );
    }

    // Sidecar-shaped refs that did NOT parse as a gateable exact-key
    // annotation ref must never fall through to the contact arm (codex
    // test-round fold): `data.contact.<email>.annotations.<key>.sub`
    // misses the right-anchored tag grammar above, but the contact
    // prefix search below would then find the CONTACT row and return
    // ITS facets — gating the wrong row entirely. The value such a ref
    // can resolve at runtime (via a sibling ref's prefetch seeding the
    // folded annotations object) is the ANNOTATION's subfield, possibly
    // agent-written — classifying it by the contact row's cleanliness
    // would launder it. Any tag segment after the collection ⇒ sidecar
    // grammar ⇒ refuse (pin).
    if (
      segments.some(
        (s, i) =>
          i >= 1
          && (s === 'annotations' || s === 'links' || s === 'inbound_links'),
      )
    ) {
      return undefined;
    }

    // ── Contact record refs (store-assisted dotted-id resolution) ──
    if (segments[0] !== 'contact' || deps.contactStore === undefined) {
      return undefined;
    }
    const idSegments = segments.slice(1);
    if (idSegments.length === 0 || idSegments.length > MAX_CONTACT_ID_SEGMENTS) {
      return undefined;
    }
    // Longest candidate first — see the module doc for why this is the
    // fail-closed direction. `get` canonicalizes the email and returns
    // null for non-email candidates, so trailing FIELD segments simply
    // miss until the candidate equals the stored key.
    for (let take = idSegments.length; take >= 1; take--) {
      const candidate = idSegments.slice(0, take).join('.');
      const record = deps.contactStore.get(candidate);
      if (record !== null) {
        return {
          origin_actor: record.origin_actor ?? 'system',
          ...(record.origin_contract_id !== undefined
            ? { origin_contract_id: record.origin_contract_id }
            : {}),
          ...(record.origin_surface !== undefined
            ? { origin_surface: record.origin_surface }
            : {}),
        };
      }
    }
    return undefined;
  };
};
