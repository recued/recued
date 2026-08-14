/** D-149 P9 § A.5.6 — production `StatusEntitySourceReader` over the
 *  D-145 work-entity warehouse.
 *
 *  The status_link visitor GET handler depends on a `StatusEntitySourceReader`
 *  to resolve the projection's source entity. Until this reader was wired
 *  the dispatcher fell back to the kind-registry 503 stub for EVERY enabled
 *  status_link (the companion projection store was wired, but the reader
 *  was intentionally omitted — see `wire-per-pair-stores.ts` P9 note). This
 *  factory closes that gap: it routes by `source_entity_kind` to the
 *  per-pair `WorkEntityStore` (the only warehouse home for the four work
 *  entity kinds — `task` / `note` / `commitment` / `project`) and projects
 *  the row down to the closed visible-field set the matching `projection_kind`
 *  exposes, formatting relative timestamps + redacting counterparty names
 *  at this boundary so the substrate's belt-and-suspenders clip
 *  (`buildStatusLinkSourceView` + the per-field redactor table) never has to
 *  carry a raw field.
 *
 *  Scope note (honest degraded behaviour): three of the seven declared
 *  `status_link` source kinds — `data.event`, `data.itinerary`,
 *  `data.packing_list` — have NO warehouse store in the product yet. A
 *  status_link bound to one of those resolves to `null` here → the handler
 *  renders the fingerprint-free placeholder (same path as a deleted entity),
 *  which is the spec's intended "entity not available" degrade rather than a
 *  hard error. The `event_plan` / `itinerary` / `packing_list` projection
 *  kinds therefore return `null` until those entity substrates land.
 *
 *  Privacy: this reader returns ONLY the projection's ceiling fields, already
 *  in visitor-safe shape. It never returns raw entity columns; the
 *  per-projection `buildRow` switch is the explicit allow-list. */

import {
  redactCounterpartyName,
  relativizeTimestamp,
  WORK_ENTITY_KINDS,
  type StatusLinkProjectionKind,
  type WorkEntity,
  type WorkEntityKind,
} from '@recued/contracts';
import type { StatusEntitySourceReader } from './handlers/status-link.js';
import type { WorkEntityStore } from '../../storage/work-entity-store.js';
import type { ContactStore } from '../../storage/contact-store.js';

/** Narrow read slices the reader needs — keeps the factory decoupled from
 *  the full store surfaces + trivially fakeable in unit tests. */
export type StatusReaderWorkEntitySource = Pick<
  WorkEntityStore,
  'readByKind' | 'listCommitments' | 'getSource'
>;
export type StatusReaderContactNameSource = Pick<ContactStore, 'getByContactId'>;

export interface WarehouseStatusEntitySourceReaderDeps {
  readonly workEntityStore: StatusReaderWorkEntitySource;
  /** Optional — resolves a commitment's counterparty contact to a display
   *  name for the `commitment_summary.counterparty_first_name_initial`
   *  field. Absent ⇒ the field is omitted (best-effort, never throws). */
  readonly contactStore?: StatusReaderContactNameSource;
  readonly now: () => number;
}

/** `data.<kind>` source-ref → `WorkEntityKind`. Source kinds NOT in this
 *  map (`data.event` / `data.itinerary` / `data.packing_list`) have no
 *  warehouse store yet → the reader returns null (placeholder). */
// ⚠ DERIVED. The key type is `Record<string, _>`, so a MISSING entry is
// simply unreachable rather than a type error — a new kind's `data.<kind>`
// source-ref would silently resolve to null forever. Every work entity has a
// warehouse store by construction, so the mapping is mechanical.
const WORK_ENTITY_KIND_BY_SOURCE: Readonly<Record<string, WorkEntityKind>> =
  Object.freeze(
    Object.fromEntries(
      WORK_ENTITY_KINDS.map((kind) => [`data.${kind}`, kind]),
    ) as Record<string, WorkEntityKind>,
  );

/** Upper bound on the commitment scan backing a project's
 *  `open_commitment_count`. A project with more pending commitments than
 *  this is unrealistic at v1; the count saturates rather than paginating. */
const PROJECT_COMMITMENT_SCAN_LIMIT = 1000;

const CUSTOM_SUMMARY_MAX = 280;

/** A commitment with a deadline → a symmetric "due in 3d" / "5d overdue" /
 *  "due today" label. The substrate's `relativizeTimestamp` only renders the
 *  past ("3d ago") + a flat "in the future" for any upcoming time, which
 *  reads poorly on a deadline; this keeps the closed bucket boundaries
 *  aligned with it while covering both directions. Pure over a fixed now. */
const relativizeDeadline = (due_at: number, now: number): string => {
  if (!Number.isFinite(due_at) || !Number.isFinite(now)) return 'unknown';
  const delta = due_at - now;
  const abs = Math.abs(delta);
  const sec = 1000;
  const min = 60 * sec;
  const hour = 60 * min;
  const day = 24 * hour;
  if (abs < min) return 'due now';
  const bucket =
    abs < hour
      ? `${Math.floor(abs / min)}m`
      : abs < day
        ? `${Math.floor(abs / hour)}h`
        : abs < 7 * day
          ? `${Math.floor(abs / day)}d`
          : abs < 30 * day
            ? `${Math.floor(abs / (7 * day))}w`
            : abs < 365 * day
              ? `${Math.floor(abs / (30 * day))}mo`
              : `${Math.floor(abs / (365 * day))}y`;
  return delta < 0 ? `${bucket} overdue` : `due in ${bucket}`;
};

/** Count a project's open (pending-lifecycle) commitments. Commitments link
 *  to projects via `blocks_project_ids`; we scan the live commitment set
 *  (capped) + filter client-side since the array membership isn't a column
 *  filter. Best-effort: any store error degrades to 0 rather than failing
 *  the whole render. */
const countOpenProjectCommitments = (
  store: StatusReaderWorkEntitySource,
  project_id: string,
): number => {
  try {
    let count = 0;
    for (const c of store.listCommitments({ limit: PROJECT_COMMITMENT_SCAN_LIMIT })) {
      if (c.lifecycle_state === 'pending' && c.blocks_project_ids.includes(project_id)) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
};

/** Resolve a commitment's counterparty to a redacted "First L." label.
 *  Best-effort — missing store / contact / name → undefined (field omitted). */
const resolveCounterparty = (
  deps: WarehouseStatusEntitySourceReaderDeps,
  contact_id: string | undefined,
): string | undefined => {
  if (!contact_id || !deps.contactStore) return undefined;
  try {
    const name = deps.contactStore.getByContactId(contact_id)?.name;
    if (typeof name !== 'string' || name.trim().length === 0) return undefined;
    const redacted = redactCounterpartyName(name);
    return redacted.length > 0 ? redacted : undefined;
  } catch {
    return undefined;
  }
};

const customTitle = (entity: WorkEntity): string => {
  switch (entity._kind) {
    case 'commitment':
      return entity.statement;
    case 'note':
      return entity.title && entity.title.length > 0 ? entity.title : '(untitled note)';
    default:
      return entity.title;
  }
};

const customSummary = (entity: WorkEntity): string | undefined => {
  const raw =
    entity._kind === 'note'
      ? entity.body
      : entity._kind === 'project'
        ? entity.description
        : entity._kind === 'task'
          ? entity.body
          : undefined; // commitment: statement already surfaces as the title
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > CUSTOM_SUMMARY_MAX
    ? `${trimmed.slice(0, CUSTOM_SUMMARY_MAX - 1)}…`
    : trimmed;
};

/** Map a resolved entity to the closed visible-field row for a projection
 *  kind. Returns null when the entity kind can't satisfy the projection
 *  (e.g. a `project` projection over a non-project row — guarded against
 *  a misconfigured endpoint that slipped past create-time cross-check). */
const buildRow = (
  projection_kind: StatusLinkProjectionKind,
  entity: WorkEntity,
  deps: WarehouseStatusEntitySourceReaderDeps,
): { row: Record<string, unknown>; last_updated_at: number } | null => {
  const now = deps.now();
  switch (projection_kind) {
    case 'project': {
      if (entity._kind !== 'project') return null;
      const last_updated_at = entity.last_activity_at || entity.updated_at;
      return {
        row: {
          title: entity.title,
          state: entity.state,
          open_commitment_count: countOpenProjectCommitments(deps.workEntityStore, entity.id),
          last_activity_at_relative: relativizeTimestamp(last_updated_at, now),
        },
        last_updated_at,
      };
    }
    case 'commitment_summary': {
      if (entity._kind !== 'commitment') return null;
      const row: Record<string, unknown> = {
        title: entity.statement,
        state: entity.lifecycle_state,
      };
      if (typeof entity.promised_for_at === 'number') {
        row.due_at_relative = relativizeDeadline(entity.promised_for_at, now);
      }
      const counterparty = resolveCounterparty(deps, entity.counterparty_contact_id);
      if (counterparty !== undefined) row.counterparty_first_name_initial = counterparty;
      return { row, last_updated_at: entity.updated_at };
    }
    case 'custom': {
      const row: Record<string, unknown> = {
        title: customTitle(entity),
        updated_at_relative: relativizeTimestamp(entity.updated_at, now),
      };
      const summary = customSummary(entity);
      if (summary !== undefined) row.summary = summary;
      return { row, last_updated_at: entity.updated_at };
    }
    // event_plan / itinerary / packing_list — no warehouse store at v1.
    default:
      return null;
  }
};

/** Build the production reader. Returns a `StatusEntitySourceReader` whose
 *  `read` is synchronous (SQLite-backed stores are sync) + null-safe end to
 *  end: a missing/deleted/tombstoned entity, an unsupported source kind, or
 *  a projection the entity can't satisfy all resolve to `null` so the
 *  handler degrades to the placeholder. */
export const createWarehouseStatusEntitySourceReader = (
  deps: WarehouseStatusEntitySourceReaderDeps,
): StatusEntitySourceReader => ({
  read: ({ projection_kind, source_entity_kind, source_entity_id }) => {
    const kind = WORK_ENTITY_KIND_BY_SOURCE[source_entity_kind];
    if (!kind || !source_entity_id) return null;
    const entity = deps.workEntityStore.readByKind(kind, source_entity_id);
    if (!entity) return null;
    // Tombstoned / orphaned / source-deleted rows are not "visible" to a
    // public status page — same degrade as a never-existed entity.
    if (entity.deleted_at != null) return null;
    if (entity.sync_state === 'tombstoned' || entity.sync_state === 'orphaned') return null;
    // Honor the per-Source enable toggle (D-145 PA11). A disabled Source is
    // excluded from `data.<kind>.*` reads by default; a public status_link
    // is anonymous, so it MUST observe the same exclusion or it would keep
    // serving data the user hid by disabling the Source. `readByKind` is a
    // direct id read that does NOT apply the Source filter, so enforce it
    // here. Missing registration → hide (conservative for a public link).
    const source = deps.workEntityStore.getSource(entity.source_id);
    if (!source) return null;
    return buildRow(projection_kind, entity, deps);
  },
});
