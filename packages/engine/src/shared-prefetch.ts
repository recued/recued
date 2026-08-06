/** Pre-fetch resolver for `shared.*` + `data.shared.*` refs and
 *  annotation / link per-record refs.
 *
 *  The synchronous `resolveRef` / `resolveValue` pipeline in contracts
 *  operates on in-memory `NamespaceStores`. Durable shared storage
 *  requires async I/O. Rather than turn the entire resolver async
 *  (invasive — every caller of `resolveRef` would become async), we
 *  keep the resolver sync and pre-populate the stores BEFORE the step
 *  runs. For each step, we static-analyze its inputs for refs under
 *  the two shared namespaces, fetch the matching keys concurrently
 *  via the registered resolvers, and splice the results into
 *  `stores.shared` / `stores.data.shared`.
 *
 *  Best-effort longest-key-match: for a ref `{{data.shared.deal.123.stage}}`,
 *  try the flat key `deal.123.stage` first; if miss, `deal.123`; then
 *  `deal`. The matched value lands at the matched path in the tree, and
 *  `walkPath` in contracts handles the remaining traversal. This
 *  supports both flat-leaf storage (write `deal.123.stage` → string
 *  "closed_won") and blob storage (write `deal.123` → whole record)
 *  transparently.
 *
 *  D-119 Phase 13: per-record annotation + link refs. The grammar is
 *  `{{data.<col>.<id>.annotations.<key>}}` (latest annotation per key)
 *  and `{{data.<col>.<id>.links.<role>}}` (outbound link array, by role).
 *  Inbound links live at `{{data.<col>.<id>.inbound_links.<role>}}`.
 *  When the prefetcher sees one of these, it calls
 *  `annotationsForRecord` / `linksForRecord` and seeds the matched
 *  position so `walkPath` finishes the traversal in the resolver. */

import type {
  Annotation,
  Link,
  RecipeStep,
} from '@recued/contracts';
import {
  collectRefs,
  type NamespaceStores,
} from '@recued/contracts';

/** Caller-provided async lookup: return the stored value for an EXACT
 *  key, or null when no such key exists. Longest-key-match is handled
 *  by the engine — resolvers need only answer exact lookups. */
export interface SharedKeyResolver {
  lookup(key: string): Promise<unknown | null>;
}

/** Per-record annotation + link resolver. The host wires these to
 *  the warehouse's annotation / link lookups for a record.
 *  Both return-shapes are `[]` when the record has no annotations /
 *  links — the prefetcher distinguishes "no data yet" from "no
 *  resolver wired" by seeding an empty group either way. */
export interface AnnotationLinkResolvers {
  annotationsForRecord?(
    collection: string,
    id: string,
  ): Promise<Annotation[]>;
  linksForRecord?(
    collection: string,
    id: string,
    direction: 'outbound' | 'inbound',
  ): Promise<Link[]>;
  /** D-226 — every installed pack's declared projection onto this identity.
   *  Returns `[]` when nothing declares onto it, so a recipe distinguishes
   *  "no pack has anything to say" from "no resolver wired" the same way the
   *  annotation and link groups do. */
  rollupsForRecord?(
    collection: string,
    id: string,
  ): Promise<RootRollup[]>;
}

/** One pack's answer about one identity. Mirrors the server's
 *  `RecordsRootProjectionResult` without importing it — the engine is
 *  portable and must not reach into server storage types. */
export interface RootRollup {
  publisher: string;
  pack_slug: string;
  label?: string;
  value: Record<string, unknown>;
  complete: boolean;
  incomplete_reason?: string;
}

export interface SharedResolvers extends AnnotationLinkResolvers {
  /** Resolves keys in the `shared.*` cache tier. Omit when no cache
   *  is wired. */
  shared?: SharedKeyResolver;
  /** Resolves keys in the `data.shared.*` durable tier. Omit when no
   *  `data.shared` resolver is wired — refs fall through to undefined. */
  dataShared?: SharedKeyResolver;
  /** D-231 — resolves `data.memory.<memory_id>` against the OWNER'S CURATED
   *  KNOWLEDGE (`user_memory`), the store behind the Data → Memory lens.
   *
   *  ⛔ NOT the audit log. `data.audit.*` is the run-provenance trail and is a
   *  separate namespace over a separate store; D-120's alias that collapsed
   *  one onto the other is gone. Omit and `data.memory.*` falls through to
   *  undefined, exactly as `dataShared` does. */
  dataMemory?: SharedKeyResolver;
}

/** Set of `data.<collection>.*` collection names where annotation /
 *  link prefetch applies. Only the closed canonical-collection set is
 *  eligible — this excludes `data.shared.*` (handled by its own
 *  longest-match resolver above).
 *
 *  D-172 P2 — added `contact` + the work-entity collections (`task` /
 *  `note` / `commitment` / `project`). The original D-119 set predates
 *  D-121's `data.contact` and D-145's work-entities, so they were
 *  absent only because they did not exist yet — NOT a deliberate
 *  security exclusion (every member is a first-class
 *  `CanonicalCollectionName`, and the store's link/annotation reads are
 *  collection-agnostic). These are exactly the N.3 attachment targets.
 *
 *  Dotted ids such as canonical contact emails are parsed by anchoring
 *  the grammar at the trailing annotation/link tag, not by assuming the
 *  second path segment is the entire record id. */
const ANNOTATABLE_COLLECTIONS = new Set([
  'mail',
  'calendar',
  'file',
  'webhook',
  'service',
  'contact',
  'task',
  'note',
  'commitment',
  'project',
]);
const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ANNOTATION_LINK_TAGS = new Set([
  'annotations',
  'links',
  'inbound_links',
  // D-226 — declared reverse reads. What every installed pack has to say about
  // this identity, computed from the pack's live rows at read time.
  'rollups',
] as const);
type AnnotationLinkTag = 'annotations' | 'links' | 'inbound_links' | 'rollups';

/** ⚠ `rollups` takes a DEEPER tail than the other tags. An annotation ref names
 *  one key and a link ref one role, so the tag sits at the last or
 *  second-to-last segment. A rollup names a PACK and then an output
 *  (`…rollups.billable-hours.unbilled_minutes`), so it needs one more. The
 *  relaxation is scoped to this tag alone — widening it for the others would
 *  start matching refs the resolver never serves. */
const ROLLUPS_MAX_TAIL = 2;

const hasPrototypeSensitiveSegment = (segments: readonly string[]): boolean =>
  segments.some((seg) => PROTOTYPE_SENSITIVE_KEYS.has(seg));

const isAnnotationLinkTag = (segment: string): segment is AnnotationLinkTag =>
  ANNOTATION_LINK_TAGS.has(segment as AnnotationLinkTag);

/** Result of `parseAnnotationLinkRef` — the per-record annotation /
 *  link request a `data.*` ref path encodes. `rest` carries the
 *  segments AFTER the tag (`['<key>']` for an exact annotation-key ref,
 *  `[]` for a bare `.annotations` / `.links` group read) — the grammar
 *  this prefetch resolves places the tag at the last or second-to-last
 *  segment, so `rest` is at most one segment by construction. */
export interface AnnotationLinkRef {
  kind: 'annotation' | 'outbound-link' | 'inbound-link' | 'rollup';
  collection: string;
  id: string;
  rest: string[];
}

/** Inspect a `data.*` ref's path and extract the per-record
 *  annotation / link request, if any. Returns `null` for refs that
 *  don't fit the per-record shape (e.g. `data.shared.*`,
 *  `data.mail.<id>` without a trailing `annotations` / `links` segment).
 *
 *  Exported (D-177 N.11 rule 1) so the server's stored-row origin
 *  resolver parses the SAME grammar the prefetch resolves — the
 *  cleanliness gate must never classify a ref the resolver wouldn't
 *  actually serve. */
export const parseAnnotationLinkRef = (
  path: string,
): AnnotationLinkRef | null => {
  // path looks like `<col>.<id>.annotations[.<key>]` or
  // `<col>.<id>.links[.<role>]` or `<col>.<id>.inbound_links[.<role>]`.
  // The tag is right-anchored so dotted ids (for example contact
  // emails) stay intact.
  const segments = path.split('.');
  if (hasPrototypeSensitiveSegment(segments)) return null;
  if (segments.length < 3) return null;
  const collection = segments[0];
  if (!ANNOTATABLE_COLLECTIONS.has(collection)) return null;
  const last = segments.length - 1;
  let tag: AnnotationLinkTag | null = null;
  let tagIndex = -1;
  const lastSegment = segments[last];
  const previousSegment = segments[last - 1];
  if (lastSegment && isAnnotationLinkTag(lastSegment)) {
    tag = lastSegment;
    tagIndex = last;
  } else if (previousSegment && isAnnotationLinkTag(previousSegment)) {
    tag = previousSegment;
    tagIndex = last - 1;
  } else {
    // `rollups` only — one segment deeper, for `<pack_slug>.<output>`.
    const rollupIndex = last - ROLLUPS_MAX_TAIL;
    if (rollupIndex > 1 && segments[rollupIndex] === 'rollups') {
      tag = 'rollups';
      tagIndex = rollupIndex;
    }
  }
  if (!tag || tagIndex <= 1) return null;
  const id = segments.slice(1, tagIndex).join('.');
  if (!id) return null;
  const rest = segments.slice(tagIndex + 1);
  if (tag === 'annotations') {
    return { kind: 'annotation', collection, id, rest };
  }
  if (tag === 'links') {
    return { kind: 'outbound-link', collection, id, rest };
  }
  if (tag === 'inbound_links') {
    return { kind: 'inbound-link', collection, id, rest };
  }
  if (tag === 'rollups') {
    return { kind: 'rollup', collection, id, rest };
  }
  return null;
};

const annotationLinkSeedSegments = (
  collection: string,
  id: string,
  tag: AnnotationLinkTag,
): string[] => [collection, ...id.split('.'), tag];

/** Iterate progressively-shorter prefixes of `path`, returning the
 *  first exact-hit `{ key, value }` or null on no match. */
const longestMatch = async (
  resolver: SharedKeyResolver,
  path: string,
): Promise<{ key: string; value: unknown } | null> => {
  const parts = path.split('.');
  for (let i = parts.length; i > 0; i--) {
    const key = parts.slice(0, i).join('.');
    const value = await resolver.lookup(key);
    if (value !== null && value !== undefined) return { key, value };
  }
  return null;
};

/** Walk `segments` into `root`, creating intermediate objects as needed,
 *  and assign `value` at the terminal. Used to seed stores.shared /
 *  stores.data.shared with fetched blobs so walkPath can traverse. */
const setPath = (
  root: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void => {
  if (segments.length === 0) return;
  if (hasPrototypeSensitiveSegment(segments)) return;
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const existing = Object.prototype.hasOwnProperty.call(cursor, seg)
      ? cursor[seg]
      : undefined;
    if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
    } else {
      const next: Record<string, unknown> = Object.create(null);
      cursor[seg] = next;
      cursor = next;
    }
  }
  cursor[segments[segments.length - 1]] = value;
};

/** For a step, analyse its templated inputs, issue async lookups for
 *  every `{{shared.*}}` + `{{data.shared.*}}` ref, and populate the
 *  matching positions of `stores.shared` / `stores.data.shared`. */
export const prefetchSharedRefs = async (
  step: RecipeStep,
  stores: NamespaceStores,
  resolvers: SharedResolvers,
): Promise<void> => {
  if (
    !resolvers.shared
    && !resolvers.dataShared
    && !resolvers.dataMemory
    && !resolvers.annotationsForRecord
    && !resolvers.linksForRecord
    && !resolvers.rollupsForRecord
  ) {
    return;
  }

  const refs = collectRefs(step);
  const tasks: Promise<void>[] = [];
  // Dedupe per-record annotation/link prefetches across multiple refs
  // pointing at the same record (e.g. `summary` + `risk_score` on
  // `data.mail.m1.annotations.*` should fire one rpc, not two).
  const annotationFetches = new Set<string>();
  const linkFetches = new Set<string>();
  const rollupFetches = new Set<string>();

  for (const ref of refs) {
    if (hasPrototypeSensitiveSegment(ref.path.split('.'))) continue;
    if (ref.ns === 'shared' && resolvers.shared) {
      tasks.push(
        (async () => {
          const match = await longestMatch(resolvers.shared!, ref.path);
          if (!match) return;
          if (!stores.shared) stores.shared = Object.create(null) as Record<string, unknown>;
          setPath(stores.shared as Record<string, unknown>, match.key.split('.'), match.value);
        })(),
      );
      continue;
    }
    // D-231 — `data.memory.<memory_id>[.field]`. Same longest-match shape as
    // `data.shared.*`: the resolver is asked for progressively shorter key
    // prefixes, so a ref into a field of a memory resolves the memory and then
    // walks into it.
    if (
      ref.ns === 'data'
      && ref.path.startsWith('memory.')
      && resolvers.dataMemory
    ) {
      const innerPath = ref.path.slice('memory.'.length);
      tasks.push(
        (async () => {
          const match = await longestMatch(resolvers.dataMemory!, innerPath);
          if (!match) return;
          if (!stores.data) stores.data = Object.create(null) as Record<string, unknown>;
          const dataStore = stores.data as Record<string, unknown>;
          if (!dataStore.memory || typeof dataStore.memory !== 'object') {
            dataStore.memory = Object.create(null);
          }
          setPath(
            dataStore.memory as Record<string, unknown>,
            match.key.split('.'),
            match.value,
          );
        })(),
      );
      continue;
    }
    if (
      ref.ns === 'data' &&
      ref.path.startsWith('shared.') &&
      resolvers.dataShared
    ) {
      const innerPath = ref.path.slice('shared.'.length);
      tasks.push(
        (async () => {
          const match = await longestMatch(resolvers.dataShared!, innerPath);
          if (!match) return;
          if (!stores.data) stores.data = Object.create(null) as Record<string, unknown>;
          const dataStore = stores.data as Record<string, unknown>;
          if (!dataStore.shared || typeof dataStore.shared !== 'object') {
            dataStore.shared = Object.create(null);
          }
          setPath(
            dataStore.shared as Record<string, unknown>,
            match.key.split('.'),
            match.value,
          );
        })(),
      );
      continue;
    }

    // D-119 Phase 13 — per-record annotation / link refs.
    if (ref.ns === 'data') {
      const parsed = parseAnnotationLinkRef(ref.path);
      if (!parsed) continue;
      if (parsed.kind === 'rollup' && resolvers.rollupsForRecord) {
        const dedupe = `${parsed.collection}.${parsed.id}`;
        if (rollupFetches.has(dedupe)) continue;
        rollupFetches.add(dedupe);
        const { collection, id } = parsed;
        tasks.push(
          (async () => {
            const rollups = await resolvers.rollupsForRecord!(collection, id);
            // Keyed on PACK SLUG for readability in a recipe. Two publishers
            // CAN ship the same slug, and silently letting one win would put
            // the wrong numbers under a name that looks right — so a collision
            // becomes an obviously-broken marker instead, and both publishers
            // are named so it can be diagnosed.
            const folded: Record<string, unknown> = Object.create(null);
            const owners: Record<string, string[]> = Object.create(null);
            for (const rollup of rollups) {
              const slug = rollup.pack_slug;
              if (PROTOTYPE_SENSITIVE_KEYS.has(slug)) continue;
              (owners[slug] ??= []).push(rollup.publisher);
              folded[slug] = owners[slug]!.length > 1
                ? { error: 'ambiguous_pack_slug', publishers: [...owners[slug]!] }
                : {
                    ...rollup.value,
                    _complete: rollup.complete,
                    ...(rollup.label === undefined ? {} : { _label: rollup.label }),
                    ...(rollup.incomplete_reason === undefined
                      ? {}
                      : { _incomplete_reason: rollup.incomplete_reason }),
                  };
            }
            seedDataNamespace(
              stores,
              annotationLinkSeedSegments(collection, id, 'rollups'),
              folded,
            );
          })(),
        );
        continue;
      }
      if (parsed.kind === 'annotation' && resolvers.annotationsForRecord) {
        const dedupe = `${parsed.collection}.${parsed.id}`;
        if (annotationFetches.has(dedupe)) continue;
        annotationFetches.add(dedupe);
        const { collection, id } = parsed;
        tasks.push(
          (async () => {
            const annotations = await resolvers.annotationsForRecord!(collection, id);
            // Fold the latest row per key into a flat object so
            // `{{data.<col>.<id>.annotations.<key>}}` resolves to the
            // value directly. Multiple rows for the same key already
            // collapsed to the latest by the store.
            const folded: Record<string, unknown> = Object.create(null);
            for (const a of annotations) {
              if (PROTOTYPE_SENSITIVE_KEYS.has(a.key)) continue;
              folded[a.key] = a.value;
            }
            seedDataNamespace(
              stores,
              annotationLinkSeedSegments(collection, id, 'annotations'),
              folded,
            );
          })(),
        );
        continue;
      }
      if (
        (parsed.kind === 'outbound-link' || parsed.kind === 'inbound-link')
        && resolvers.linksForRecord
      ) {
        const direction =
          parsed.kind === 'outbound-link' ? 'outbound' : 'inbound';
        const dedupe = `${parsed.collection}.${parsed.id}.${direction}`;
        if (linkFetches.has(dedupe)) continue;
        linkFetches.add(dedupe);
        const { collection, id } = parsed;
        const tag = direction === 'outbound' ? 'links' : 'inbound_links';
        tasks.push(
          (async () => {
            const links = await resolvers.linksForRecord!(
              collection,
              id,
              direction,
            );
            // Group by role — `{{data.<col>.<id>.links.<role>}}`
            // resolves to the array of links under that role.
            const grouped: Record<string, Link[]> = Object.create(null);
            for (const l of links) {
              if (PROTOTYPE_SENSITIVE_KEYS.has(l.role)) continue;
              const arr = grouped[l.role] ?? (grouped[l.role] = []);
              arr.push(l);
            }
            seedDataNamespace(
              stores,
              annotationLinkSeedSegments(collection, id, tag),
              grouped,
            );
          })(),
        );
        continue;
      }
    }
  }

  if (tasks.length > 0) await Promise.all(tasks);
};

/** Seed `stores.data.<segments>` with `value`. Creates intermediate
 *  objects as needed; idempotent if a sibling key was already
 *  populated. */
const seedDataNamespace = (
  stores: NamespaceStores,
  segments: readonly string[],
  value: unknown,
): void => {
  if (!stores.data) stores.data = Object.create(null) as Record<string, unknown>;
  setPath(stores.data as Record<string, unknown>, segments, value);
};
