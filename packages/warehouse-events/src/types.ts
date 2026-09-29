/** Public types for the warehouse event bus (D-103 Phase A scaffolding).
 *
 *  Mail / file / webhook adapters emit WarehouseEvents when their
 *  collections change. In Phase A only the emit side is wired — the
 *  subscriber side that drives recipe triggers lands in a later phase
 *  (D/G). The interface is split into two so Phase A can solidify the
 *  event shape and matcher semantics without the subscriber tail. */

/** D-145 PA4 — Widened with the four work-entity reactive kinds:
 *
 *  - `'completed'` — task `done` flips false → true (mark-done dispatcher).
 *  - `'due_soon'` — clock crosses `promised_for_at - 24h` for a pending
 *    commitment OR `due_at - 24h` for a pending task (due-status sweep).
 *  - `'overdue'` — clock crosses `promised_for_at` for a pending
 *    commitment OR `due_at` for a pending task (due-status sweep).
 *  - `'state_changed'` — commitment lifecycle moves (`commitment-fulfill`
 *    / `commitment-cancel`) OR project `state` field changes
 *    (`project-update` / `project-archive`).
 *
 *  These ride on the same bus as `'created'` / `'updated'` / `'deleted'`
 *  / `'synced'`; the path convention is unchanged
 *  (`data.{platform}.{slug}.{entity_type}.{event_kind}`). Adding a new
 *  kind here is one-line — the matcher + binder are kind-agnostic. */
/** D-179 P4 — `'failed'` joins for the run-outcome family
 *  (`run.<recipe_id>.<dish_id>.failed`); `'completed'` is shared with
 *  the work-entity kinds. Run-outcome events ride the reserved
 *  `platform: 'run'`, whose synthetic path drops the `data.` prefix
 *  (fork (d): outcomes are not warehouse data rows — the `data.*`
 *  trigger grammar stays collections-only). */
export type WarehouseEventKind =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'synced'
  | 'completed'
  | 'due_soon'
  | 'overdue'
  | 'state_changed'
  | 'failed';

/** The common event shape. `platform` + `slug` disambiguate adapter
 *  instances (e.g. platform='mail', slug='work' for a user's work-email
 *  adapter vs. platform='mail', slug='personal'). `entity_type` is the
 *  emitter's own vocabulary for what changed (e.g. 'message', 'file',
 *  'webhook_delivery').
 *
 *  D-124 Phase 1 — `prev` carries a prior-state snapshot for `updated`
 *  and `deleted` events, absent for `created` (no prior by definition)
 *  and `synced` (collection-level tick, no per-record semantics).
 *  Adapter-defined shape — each collection's emit site projects a
 *  per-collection canonical hot-fields slice (mail header fields,
 *  calendar event hot fields, file metadata). The bus stays
 *  collection-agnostic; consumers read fields they expect for the
 *  collection they subscribed to. */
export interface WarehouseEvent {
  platform: string;
  slug: string;
  entity_type: string;
  event_kind: WarehouseEventKind;
  record_id: string;
  at: number;
  prev?: Record<string, unknown>;
  /** The fresh canonical projection of the changed record at detection
   *  time. Populated by the watch poll loop (G6 — the poll already paid
   *  for the full projection) AND by the D-128 reconciler pipeline +
   *  webhook funnel on their `created` / `updated` emits (the vendor's
   *  meta snapshot minus stamping fields — meta keys ARE the canonical
   *  projection vocabulary, so the two sources agree). Adapter emit
   *  sites (mail / calendar / file) leave it absent — their consumers
   *  re-read from the warehouse. The realtime broadcast bridge forwards
   *  only `(collection, op, id)`, so a fat record never reaches paired
   *  clients. */
  record?: Record<string, unknown>;
  /** Canonical field keys (dotted for nested, e.g.
   *  `key_dates.close_date`) whose values differ from the prior
   *  snapshot. Populated on poll- and reconciler-sourced `updated`
   *  events whose prior snapshot carried meta. */
  changed_fields?: string[];
  /** D-315 §6.3 — set on the events a manual BACKFILL of mail that already
   *  arrived emits, when the owner asked it to run the recipes its facts
   *  trigger. A trigger starts those runs with `trigger_source: 'backfill'`,
   *  the one source `deriveRunMode` stamps `run_mode: backfill`, so they stay
   *  out of what is recent and fan out no run-outcome events. */
  origin?: 'backfill';
  /** D-124 — published while ANOTHER collection drained its initial backfill:
   *  a mailbox's first scan storing an old email's attachment as a received
   *  file. The received files never drain, so their own backfill state cannot
   *  say so; this does. The dispatcher suppresses its fan-out as it does the
   *  drain's own events — the bus still carries it. */
  in_drain?: true;
}

/** Path convention: `data.{platform}.{slug}.{entity_type}.{event_kind}` —
 *  subscribers may use glob patterns against this synthetic path. */
export type WarehouseEventPath = string;

export type WarehouseEventListener = (event: WarehouseEvent) => void;

export interface WarehouseEventBus {
  emit(event: WarehouseEvent): void;
  /** Subscribe to events whose synthetic path matches `pattern`. Supports
   *  `*` (single-segment wildcard) and `**` (multi-segment wildcard).
   *  Returns an unsubscribe handle. */
  subscribe(pattern: string, listener: WarehouseEventListener): () => void;
  /** Unsubscribe everything (shutdown). */
  dispose(): void;
}
