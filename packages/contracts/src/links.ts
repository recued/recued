/** D-120 — Engine-emitted provenance link taxonomy.
 *
 *  Provenance links sit alongside the existing D-119 Phase 13 `link`
 *  warehouse collection but model a different surface: D-119 links are
 *  recipe-authored typed cross-collection relationships
 *  (`attachment`, `scheduled-from`); D-120 links are engine-emitted
 *  causal edges between a memory entry and the entities a step touched
 *  during that run.
 *
 *  Storage lives in the new `links` SQLite table (Phase 1). Engine
 *  emission, the `shouldLink` skip predicate, and the per-step
 *  `classifyKind` classifier all land in Phase 3.
 *
 *  Spec: D-120.
 */

/** Engine-emitted link kind taxonomy. Aggressive default emission;
 *  per-recipe opt-out via `provenance: false` in `recipe.json`
 *  (wired in Phase 3).
 *
 *  - `'execution.action'` — external-side-effect call (MCP, send-email,
 *    slack-post, mcp-tool, …); the warehouse has no other trace, so
 *    the link IS the proof that the action happened.
 *  - `'execution.derived'` — recipe wrote a record into a different
 *    collection than the source step read from (calendar event from
 *    email, deal from contact). Captures cross-collection causality
 *    the warehouse can't show on its own.
 *  - `'execution.write'` — recipe modified an existing entity in the
 *    same or no source collection. Useful for "why did this deal
 *    change stage?" — warehouse already shows the result; the link
 *    answers WHY. */
export type LinkKind =
  | 'execution.action'
  | 'execution.derived'
  | 'execution.write';

/** All defined kinds, materialised for runtime checks (validator,
 *  storage `CHECK` constraint, fixture builders). Keep in sync with
 *  the `LinkKind` union above. */
export const LINK_KINDS: readonly LinkKind[] = [
  'execution.action',
  'execution.derived',
  'execution.write',
] as const;

/** Type guard: true when `value` is one of the defined kinds. */
export const isLinkKind = (value: unknown): value is LinkKind =>
  typeof value === 'string' && (LINK_KINDS as readonly string[]).includes(value);

/** Per-collection emission rule consumed by the Phase 3 `shouldLink`
 *  predicate. An empty `emit_kinds` array means the engine never
 *  emits provenance links for that collection — used to silence
 *  sidecar collections (`annotations`, `links`) whose causality
 *  derives structurally from their parent. */
export interface LinkEmissionRule {
  collection: string;
  emit_kinds: readonly LinkKind[];
}

/** D-120 Phase 3 — how the engine accessed an entity during a step.
 *  Drives the `shouldLink` skip predicate and feeds `classifyKind`.
 *
 *  - `'read'` — the step read a `data.<col>.<id>` ref through its
 *    ingredient input (the typical `mail-list` / `deal-reader` path).
 *    Linkable.
 *  - `'write'` — the step modified an existing entity. Tracked for
 *    completeness; Phase 3 emission focuses on side-effecting
 *    actions, but the type stays present so `classifyKind` can
 *    surface `execution.derived` when a future write-tracking
 *    surface lands.
 *  - `'foreach_item'` — the touch occurred inside a `foreach` loop
 *    iteration body. The parent collection scan carries causality;
 *    per-item links would multiply writes without adding signal.
 *    Skipped by `shouldLink`.
 *  - `'filter_scan'` — the touch resolved inside a transform's
 *    parameters (filter / find / map). Pure structural derivation
 *    from the source; the recipe's interest in the collection is
 *    already captured at the ingredient level. Skipped by
 *    `shouldLink`. */
export type AccessKind = 'read' | 'write' | 'foreach_item' | 'filter_scan';

/** A single (collection, entity_id, access) touch the engine
 *  observed during step execution. Step-runner extracts these from
 *  `data.<col>.<id>` refs at resolution time; `classifyKind` plus
 *  `shouldLink` decide which become persisted link rows. */
export interface EntityTouch {
  collection: string;
  entity_id: string;
  access: AccessKind;
}

/** What the engine hands to the caller-supplied link sink for each
 *  link the engine wants persisted. The sink correlates these with
 *  the audit row's `run_id` (memory_id) — the engine can't write SQL
 *  itself and the caller knows the audit identity at append time.
 *
 *  Phase 3 is server-only — the extension's audit storage is
 *  hash-keyed IDB and doesn't carry an insight surrogate, so the
 *  extension never wires `linkSink`. */
export interface EmittedLink {
  /** Step that produced the link — matches `StepLog.id`. */
  step_id: string;
  collection: string;
  entity_id: string;
  kind: LinkKind;
  access: AccessKind;
  /** Engine clock at emission. Caller persists verbatim onto the
   *  links row so the per-tick timestamp granularity survives. */
  ts: number;
  /** D-120 Phase 7.5 — bistemporal stamping. When the source step
   *  read a record whose underlying date predates the emission,
   *  recipes pass that date through the kernel ingredient and the
   *  engine forwards it here. Null = no underlying event date;
   *  storage falls back to `ts` via `COALESCE(event_at, ts)` in
   *  ordering queries. */
  event_at?: number;
}

/** Sidecar warehouse collections whose contents derive structurally
 *  from a parent record. Skipping them in `shouldLink` keeps the
 *  graph dense — the parent record's link is the causal anchor; the
 *  sidecar row would just duplicate it.
 *
 *  Kept as a literal set (not a union of `CanonicalCollectionName`)
 *  so adding a new sidecar means one edit; consumers of the union
 *  stay narrow. */
export const SIDECAR_COLLECTIONS: ReadonlySet<string> = new Set([
  'annotation',
  'annotations',
  'link',
  'links',
]);

/** True when `collection` is one of the registered sidecar surfaces. */
export const isSidecarCollection = (collection: string): boolean =>
  SIDECAR_COLLECTIONS.has(collection);

/** D-120 Phase 3 — central skip predicate for link emission.
 *
 *  Returns `false` for sidecars, foreach iteration reads, and pure
 *  filter scans. The contract is "link only entities that wouldn't
 *  otherwise be derivable" — these three shapes are derivable
 *  structurally from the source they rest on. Returning `true` for
 *  the remaining cases keeps the default aggressive without flooding
 *  the graph with low-signal edges.
 *
 *  Composed by step-runner after touch collection; pairs with
 *  `classifyKind` (kind decision) + step-level emit-gate (only
 *  side-effecting steps emit at all). */
export const shouldLink = (collection: string, access: AccessKind): boolean => {
  if (isSidecarCollection(collection)) return false;
  if (access === 'foreach_item') return false;
  if (access === 'filter_scan') return false;
  return true;
};

/** Parse a fully-qualified ref into a `(collection, entity_id)` pair
 *  when the ref points at a single warehouse record. Returns null
 *  for collection-root refs (`data.mail`), non-`data` namespaces,
 *  and the user-writable `data.shared.*` scratch tier (D-103) which
 *  is not a warehouse collection.
 *
 *  Used by step-runner to extract `EntityTouch` entries during
 *  ingredient input and transform param resolution.
 *
 *  Examples:
 *    parseDataEntityRef('data', 'mail.msg-abc.subject')
 *      → { collection: 'mail', entity_id: 'msg-abc' }
 *    parseDataEntityRef('data', 'mail')                → null
 *    parseDataEntityRef('data', 'shared.deal.42')      → null
 *    parseDataEntityRef('config', 'threshold')         → null */
export const parseDataEntityRef = (
  ns: string,
  path: string,
): { collection: string; entity_id: string } | null => {
  if (ns !== 'data') return null;
  if (!path) return null;
  const segs = path.split('.');
  if (segs.length < 2) return null;
  const collection = segs[0];
  // `data.shared.*` is the D-103 user-writable tier, not a warehouse
  // collection. `data.audit` / `data.memory` are read-only memory
  // surfaces (D-120 Phase 4) that shouldn't link onto themselves.
  if (collection === 'shared' || collection === 'audit' || collection === 'memory') {
    return null;
  }
  // Dotted entity ids (canonical contact emails) span multiple segments.
  // Right-anchor on a trailing annotations / links / inbound_links tag —
  // the same grammar the engine's `parseAnnotationLinkRef` resolves — so
  // `contact.john.doe@x.com.annotations.note` keys on the full email, not
  // its first segment. Refs without a sidecar tag keep the single-segment
  // read (the field tail is unbounded, so greedy joining would over-key).
  const last = segs.length - 1;
  let tagIndex = -1;
  if (ANNOTATION_LINK_TAGS.has(segs[last])) tagIndex = last;
  else if (segs.length >= 3 && ANNOTATION_LINK_TAGS.has(segs[last - 1])) tagIndex = last - 1;
  const entity_id = tagIndex > 1 ? segs.slice(1, tagIndex).join('.') : segs[1];
  if (!entity_id) return null;
  return { collection, entity_id };
};

/** Trailing per-record sidecar tags — keep in sync with the engine's
 *  `parseAnnotationLinkRef` grammar (`shared-prefetch.ts`). */
const ANNOTATION_LINK_TAGS = new Set(['annotations', 'links', 'inbound_links']);
