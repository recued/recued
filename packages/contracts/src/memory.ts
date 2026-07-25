/** D-120 — Memory + provenance substrate constants.
 *
 *  Substrate-only definitions for the memory namespace, retention
 *  defaults, the staged-trust permission slug, and the size caps that
 *  bound the new wire surfaces (`output_string` + `recipe_insight.flattened`).
 *
 *  Phase 1 ships constants only; Phase 2 (recipe-insight population),
 *  Phase 3 (engine link emission), Phase 4 (`data.memory.*` namespace),
 *  Phase 5 (`data.timeline()` MCP primitive), Phase 6 (`agent-watcher`
 *  trigger — retired by D-153 P10), and Phase 7 (UI rename + unified
 *  export) build on top.
 *
 *  Spec: docs/d-120-spec.md.
 */

/** Default retention window for memory entries. Pre-D-120 this was a
 *  30d hardcode; D-120 Phase 1 lifted it to 180d; the post-D-120
 *  amendment (this commit) flips the default to `null` — auto-prune
 *  off out of the box. The user owns their data; Recued doesn't decide
 *  what to forget. Users opt in to a window via settings when they
 *  want one.
 *
 *  Wire format note: the runtime-config schema (`audit.retention_days`
 *  in `@recued/config`) carries `0` as the wire-level "no expiry"
 *  sentinel because TOML has no null type. The bridge in
 *  `backend/server/src/bin.ts` collapses `0 → null` before handing the
 *  value to the audit-retention pruner. The contract constant below is
 *  the semantic source of truth — `null` means "skip age-based prune;
 *  size-based reclaim and cascade GC still run."
 *
 *  Cascade GC for orphaned `links` / `recipe_insights` is integrity
 *  housekeeping, not retention, and runs regardless of this value. */
export const MEMORY_RETENTION_DEFAULT_DAYS: number | null = null;

/** Permission slug requested by recipes that read `data.memory.*`.
 *  Same staged-trust pattern as vault scoping — granted via approval
 *  at install. Default deny. Wired through the validator in Phase 4. */
export const MEMORY_READ_PERMISSION = 'read_memory';

/** D-128 P6 — permission slug requested by recipes that write into
 *  the enrichment substrate via `enrichment-upsert` (or any future
 *  kernel ingredient that lands on `data_enrichment`). Same staged-
 *  trust pattern as `read_memory` — recipes declare it in `requires`,
 *  the install dialog surfaces it for approval, the validator hard-
 *  errors when an `enrichment-upsert` step appears without it. Read-
 *  side enrichment access is unrestricted (the substrate is content-
 *  addressed + CAS-bounded); write access is the trust boundary. */
export const ENRICHMENT_WRITE_PERMISSION = 'write_enrichment';

/** D-128 P6 — permission-slug *prefix* for platform-reference scope
 *  reads. The actual slug is `read_connection_<connection_name>` where
 *  `<connection_name>` is the user-chosen identifier picked at install
 *  (e.g. `read_connection_acme_hubspot`). The validator can't pin the
 *  connection_name at parse time — only the vendor segment is visible
 *  in the scope path — so it accepts any slug starting with this prefix
 *  as known and surfaces a hint when none is declared on a recipe that
 *  references a platform-reference scope.
 *
 *  Runtime resolver gates against the actual binding: when a recipe
 *  reads `data.enrichment.connection.api.hubspot.deal.<id>...` the
 *  resolver looks up which connection the recipe's picker is bound to,
 *  derives the expected slug `read_connection_<that_name>`, and
 *  returns `undefined` when the recipe doesn't carry it.
 *
 *  Vendor Ds (D-129 HubSpot, D-130 Salesforce) populate the runtime
 *  enforcement; D-128 P6 ships only the validator side. */
export const CONNECTION_READ_PERMISSION_PREFIX = 'read_connection_';

/** D-128 P6 — true when a permission slug is a `read_connection_<name>`
 *  variant. Used by the validator's permission whitelist to accept any
 *  slug from this open family without warning, since the connection_name
 *  segment is user-typed and therefore unbounded. The slug must be
 *  longer than the bare prefix to count (`read_connection_` alone is
 *  not a valid slug — there's no bound connection). */
export const isConnectionReadPermission = (slug: string): boolean =>
  slug.startsWith(CONNECTION_READ_PERMISSION_PREFIX)
  && slug.length > CONNECTION_READ_PERMISSION_PREFIX.length;

/** Maximum length of `audit_entry.output_string`. Short summary only —
 *  approval outcome (`approval:allow`/`deny`/`edit`/`dismiss_unseen`),
 *  error code, brief result fragment. Not a full step output (those
 *  stay redacted per the privacy contract). Runtime truncates with a
 *  `…[truncated]` suffix when callers exceed this cap. */
export const AUDIT_OUTPUT_STRING_MAX = 280;

/** Cap on flattened `recipe_insight` payload size. Prevents pathological
 *  recipes from bloating the `recipe_insights` table. Average insight is
 *  ~1-3 KB; 16 KB leaves headroom for big-but-reasonable recipes
 *  (>30 steps with multi-line prompts). Insert paths reject anything
 *  larger so the table stays bounded. */
export const RECIPE_INSIGHT_FLATTENED_MAX_BYTES = 16_384;

/** Cap on per-recipe `context.recipe.*` snapshot size (Phase 4.5).
 *  Truncates with a warning if exceeded — prevents recipes that pick up
 *  massive step outputs from bloating the per-pair prefs blob. Same
 *  budget as `recipe_insights.flattened`; both bound run-shape data.
 *
 *  When a snapshot exceeds the cap, the engine drops the largest entry
 *  (by serialized size) iteratively until the remainder fits, and the
 *  retained subset is what gets persisted. The skipped step ids surface
 *  as a `*_truncated` warning entry the next run sees so authors can
 *  notice and trim. */
export const CONTEXT_RECIPE_MAX_BYTES = 16_384;

/** D-120 Phase 4 — sub-namespace under `data.*` that exposes the
 *  audit log to recipes as a read-only warehouse surface. The runtime
 *  appends entries via the existing audit emitter; recipe code cannot
 *  write here. */
export const MEMORY_DATA_SUBNAMESPACE = 'memory';

/** D-120 Phase 4 — deprecation alias resolving to the same store as
 *  `data.memory.*`. Carried for one release cycle so the marketplace
 *  corpus migrates without a hard break; the validator emits a soft
 *  warning whenever a recipe references `data.audit.*`. Hard removal
 *  is queued for a later release once usage drops below the
 *  marketplace-review threshold. */
export const MEMORY_DATA_ALIAS_SUBNAMESPACE = 'audit';

/** Sub-namespaces under `data.*` that resolve to the audit/memory
 *  surface. Membership drives the validator's `read_memory`
 *  permission check and the resolver's namespace alias. */
export const MEMORY_DATA_SUBNAMESPACES: ReadonlySet<string> = new Set([
  MEMORY_DATA_SUBNAMESPACE,
  MEMORY_DATA_ALIAS_SUBNAMESPACE,
]);

/** True when a `data.<sub>.<…>` ref points at the memory surface
 *  (memory or its audit alias). Used by the validator (permission
 *  enforcement + alias deprecation warning) and the resolver
 *  (namespace alias collapse onto a single store). */
export const isMemoryDataSubnamespace = (sub: string): boolean =>
  MEMORY_DATA_SUBNAMESPACES.has(sub);

// ────────────────────────────────────────────────────────────────
// D-120 Phase 7.5 — bistemporal stamping + run_mode
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of run modes — drives `audit_log.run_mode` plus
 *  the `data.timeline()` axis decision. The trio is fixed at the
 *  contract layer so consumers (memory tab UI, L3+ pattern queries,
 *  the retention pruner once D-121 lands per-recipe overrides) can
 *  switch on it exhaustively. */
export const RUN_MODES = ['live', 'backfill', 'manual'] as const;

/** String-literal union derived from `RUN_MODES`. Every audit row
 *  carries one as of Phase 7.5; pre-7.5 rows backfill to `'live'`. */
export type RunMode = (typeof RUN_MODES)[number];

/** Predicate — true when `value` is a known `RunMode`. */
export const isRunMode = (value: unknown): value is RunMode =>
  typeof value === 'string'
  && (RUN_MODES as readonly string[]).includes(value);

/** Default `RunMode` applied when a recipe doesn't declare `run_mode`
 *  AND the engine can't infer one from the trigger (rare — every
 *  declared trigger has an inference rule). `'live'` is the
 *  conservative default: real-world activity now, not historical
 *  backfill, not user-initiated one-shot. */
export const DEFAULT_RUN_MODE: RunMode = 'live';

/** Default `RunMode` for chat / Run-Now / UI-triggered runs. The
 *  engine derives `'manual'` for these triggers when the recipe
 *  doesn't declare `run_mode` — distinguishes ad-hoc user clicks
 *  from automated firings without the recipe author having to think
 *  about it. */
export const MANUAL_TRIGGER_RUN_MODE: RunMode = 'manual';

/** Sources whose timeline view defaults to event-time chronology
 *  ("Recent activity" — what really happened, sorted by the world
 *  event's date). The complement defaults to ingestion-time
 *  ("Recently discovered" — when Recued first saw it). The Memory
 *  tab dual-axis UI lands in D-121; Phase 7.5 ships the substrate
 *  so existing surfaces pick up the right ordering automatically.
 *
 *  Membership rationale: every source whose `event_at` typically
 *  predates `ts` (mail Date: header, calendar event start, file mtime)
 *  goes here; sources where the two coincide (memory entry, runtime-
 *  authored annotation) draw no distinction either way and inherit
 *  ingestion-time naturally. */
export const TIMELINE_AXIS_DEFAULT = 'event' as const;

/** Closed axis set for `data.timeline().axis`. */
export const TIMELINE_AXES = ['event', 'ingestion'] as const;

/** String-literal union derived from `TIMELINE_AXES`. */
export type TimelineAxis = (typeof TIMELINE_AXES)[number];

/** Predicate — true when `value` is a known `TimelineAxis`. */
export const isTimelineAxis = (value: unknown): value is TimelineAxis =>
  typeof value === 'string'
  && (TIMELINE_AXES as readonly string[]).includes(value);
