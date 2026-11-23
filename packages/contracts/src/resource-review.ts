import { RpcError } from './rpc/types.js';
import { humanizeAskField } from './ask-detail-label.js';
import { allDayEventDays } from './calendar-days.js';

/** Owner review of a mutation's exact resource versions. These snapshots are
 * host-authored evidence, never an approval supplied in tool arguments. */
export interface ReviewedResource {
  kind: 'calendar' | 'records';
  key: string;
  label: string;
  /** Includes the account/namespace incarnation and dispatch binding. */
  binding: string;
  /** Changes even if an edit is subsequently undone. */
  version: string;
  precondition:
    | { kind: 'etag'; value: string }
    | { kind: 'local_version'; value: string }
    | { kind: 'records_revision'; value: number; incarnation: string }
    | { kind: 'records_absent'; generated_for?: number };
  before: Record<string, unknown>;
  after: Record<string, unknown> | null;
  /** Ordered batch effects, including intermediate edits that a net diff
   * would hide. Indexes refer to the original zero-based ops array. */
  changes?: {
    operation_index: number;
    action: 'create' | 'update' | 'upsert' | 'delete';
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }[];
}

export interface ResourceReview {
  schema_version: 1;
  operation: string;
  input_hash: string;
  captured_at: number;
  resources: ReviewedResource[];
}

/** Content-free proof that a built-in local mutation and its receipt shared
 * one transaction. This is inspection data, never an execution permit. */
export interface LocalMutationReceiptSummary {
  receipt_id: string;
  kind: 'records' | 'local_calendar';
  committed_at: number;
}
export const isLocalMutationReceiptSummary = (value: unknown): value is LocalMutationReceiptSummary => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.receipt_id === 'string' && /^lmr_[a-f0-9-]{36}$/.test(row.receipt_id)
    && (row.kind === 'records' || row.kind === 'local_calendar')
    && Number.isSafeInteger(row.committed_at) && Number(row.committed_at) >= 0;
};

/** Host-injected dispatch participation. Authored recipes and wire requests
 * cannot provide this callback or turn inspection data into authority. */
export interface LocalMutationHooks {
  run<T>(call: { slug: string; operation: string; input: Record<string, unknown>; review: ResourceReview;
    stepMeta?: import('./steps.js').StepMeta; commit?: import('./commits.js').Commit;
    /** Opaque host reservation, checked only at the final write boundary. */
    authority_reservation?: object;
    /** D-348 — the request's rule that let the call through without asking, stamped on the
     *  commit the host writes for it (`Commit.chain_rule`). */
    chain_rule_id?: string },
  dispatch: () => T | Promise<T>): Promise<T>;
}

/** Host callbacks shared by the ingredient and catalog approval boundaries. */
export interface ResourceReviewHooks {
  localAutomation?: import('./local-automation.js').LocalAutomationHooks;
  capture(slug: string, input: Record<string, unknown>, approved?: ResourceReview,
    resuming?: boolean): ResourceReview | undefined;
  run<T>(review: ResourceReview | undefined, effect: () => T): T;
}

/** An optional integration may skip unsupported fresh calls, but it must
 * never discard evidence retained by an earlier approval. */
export const captureResourceReview = (hooks: ResourceReviewHooks | undefined,
  slug: string, input: Record<string, unknown>, approved?: ResourceReview,
  resuming?: boolean): ResourceReview | undefined => {
  const review = hooks?.capture(slug, input, approved, resuming);
  if (approved && !review) throw new RpcError('resource_conflict',
    'The saved resource review cannot be verified on this host. No change was applied. Restore the integration and request a new review.', 409);
  return review;
};

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export const isResourceReview = (value: unknown): value is ResourceReview => {
  if (!object(value) || value.schema_version !== 1
    || typeof value.operation !== 'string' || typeof value.input_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.input_hash)
    || typeof value.captured_at !== 'number' || !Number.isFinite(value.captured_at)
    || !Array.isArray(value.resources) || value.resources.length < 1 || value.resources.length > 100) return false;
  return value.resources.every((r: unknown) => object(r)
    && (r.kind === 'calendar' || r.kind === 'records')
    && ['key', 'label', 'binding', 'version'].every(k => typeof r[k] === 'string' && r[k] !== '')
    && object(r.before) && (r.after === null || object(r.after))
    && (r.changes === undefined || (r.kind === 'records' && Array.isArray(r.changes)
      && r.changes.length > 0 && r.changes.length <= 100 && r.changes.every((change: unknown) =>
        object(change) && Number.isSafeInteger(change.operation_index)
        && Number(change.operation_index) >= 0 && Number(change.operation_index) < 100
        && typeof change.action === 'string' && ['create', 'update', 'upsert', 'delete'].includes(change.action)
        && (change.before === null || object(change.before)) && (change.after === null || object(change.after)))))
    && object(r.precondition)
    && (r.precondition.kind === 'records_absent'
      ? r.kind === 'records' && Object.keys(r.before).length === 0
        && (r.precondition.generated_for === undefined || (Number.isSafeInteger(r.precondition.generated_for)
          && Number(r.precondition.generated_for) >= 0 && Number(r.precondition.generated_for) < 100))
      : r.precondition.kind === 'records_revision'
      ? Number.isSafeInteger(r.precondition.value) && Number(r.precondition.value) >= 0
        && typeof r.precondition.incarnation === 'string' && r.precondition.incarnation !== ''
      : (r.precondition.kind === 'etag' || r.precondition.kind === 'local_version')
        && typeof r.precondition.value === 'string' && r.precondition.value !== ''
        && r.precondition.value !== '*'));
};

/** How a reviewed change reads, wherever the owner reads one (an approval card, the Approvals
 *  queue, an approval ahead, a batch of changes, an Undo): only what it changes, field by field, in
 *  the words the app's own forms use. It used to print every field of both versions as JSON, and
 *  the version it was checked against, which no owner reads. The same evidence reads the same on a
 *  first hold and after restart recovery. */
export interface RenderResourceReviewOptions {
  /** The zone a moment is written in; the viewer's when absent. */
  readonly timeZone?: string;
  /** The locale a date is written in; the viewer's when absent. */
  readonly locale?: string;
}

/** A calendar event's fields, as the app's own event form names them. */
const CALENDAR_FIELD_LABELS: Readonly<Record<string, string>> = {
  summary: 'Title', start_at: 'Starts', end_at: 'Ends', is_all_day: 'All day', location: 'Location',
  description: 'Notes', timezone: 'Time zone', status: 'Status', attendees: 'Guests',
};
const CALENDAR_FIELD_ORDER = Object.keys(CALENDAR_FIELD_LABELS);
/** What a step of a batch does. */
const STEP_ACTIONS: Readonly<Record<string, string>> = {
  create: 'Add', update: 'Change', upsert: 'Add or change', delete: 'Delete',
};
const NONE = '(none)';
const DAY_LENGTH_MS = 86_400_000;
/** Recued's own calendar's slug, as `RESERVED_LOCAL_CALENDAR_SLUG` names it (a test holds them
 *  equal; importing it here would close an import cycle). */
export const OWN_CALENDAR_SLUG = 'local';
/** The fields a record is known by, in the order its heading looks for one. */
const RECORD_TITLE_FIELDS = ['title', 'name', 'subject', 'summary'] as const;

/** A record's nested fields on lines of their own: `details: { note }` reads as "Details note". */
const leaves = (value: Record<string, unknown>, prefix = ''): Array<[string, unknown]> =>
  Object.entries(value).flatMap(([key, cell]): Array<[string, unknown]> =>
    object(cell) ? leaves(cell, prefix + key + '.') : [[prefix + key, cell]]);

const plainValue = (value: unknown): string => {
  if (value === null || value === undefined) return NONE;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  // One line per field: a value's own line breaks are read as spaces, never dropped.
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim() || NONE;
  if (Array.isArray(value)) return value.length === 0 ? NONE : value.map(plainValue).join(', ');
  if (object(value)) {
    const shown = leaves(value).map(([key, cell]) => humanizeAskField(key) + ': ' + plainValue(cell));
    return shown.length === 0 ? NONE : shown.join(', ');
  }
  return String(value);
};

/** An event's start or end. ⛔ An all-day event's are DAYS (`calendar-days.ts`): read as moments,
 *  a 24 December holiday was 23 December, 4:00 pm in Los Angeles; its end reads as its last day. */
const calendarMoment = (key: string, side: Record<string, unknown>, options: RenderResourceReviewOptions): string | undefined => {
  const value = side[key];
  if ((key !== 'start_at' && key !== 'end_at') || typeof value !== 'number'
    || !Number.isFinite(value) || Math.abs(value) > 8.64e15) return undefined;
  if (side.is_all_day === true) {
    const start = typeof side.start_at === 'number' && Number.isFinite(side.start_at) ? side.start_at : value;
    const end = typeof side.end_at === 'number' && Number.isFinite(side.end_at) ? side.end_at : start + DAY_LENGTH_MS;
    const days = allDayEventDays({ start_at: start, end_at: end });
    return new Date((key === 'start_at' ? days.first : days.last) + 'T00:00:00Z').toLocaleDateString(options.locale,
      { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  return new Date(value).toLocaleString(options.locale,
    { dateStyle: 'medium', timeStyle: 'short', ...(options.timeZone !== undefined ? { timeZone: options.timeZone } : {}) });
};

/** One version's fields, by the key a field is compared under. */
const fieldsOf = (resource: ReviewedResource, side: Record<string, unknown> | null): Map<string, unknown> =>
  new Map(side === null ? [] : resource.kind === 'calendar' ? Object.entries(side)
    // A record's id names it in its label; it never changes.
    : leaves(side).filter(([key]) => key !== 'id'));

const fieldLabel = (resource: ReviewedResource, key: string, allDay: boolean): string => {
  if (resource.kind !== 'calendar') return humanizeAskField(key);
  if (allDay && key === 'start_at') return 'First day';
  if (allDay && key === 'end_at') return 'Last day';
  return CALENDAR_FIELD_LABELS[key] ?? humanizeAskField(key);
};

/** What a change does to one version's fields: "Title: Old → New" for each field it changes, or
 *  each field it sets when there was none before. */
const changedFields = (resource: ReviewedResource, before: Record<string, unknown> | null,
  after: Record<string, unknown> | null, options: RenderResourceReviewOptions): string[] => {
  if (after === null) return [];
  const old = fieldsOf(resource, before);
  const now = fieldsOf(resource, after);
  const keys = [...new Set([...now.keys(), ...old.keys()])];
  if (resource.kind === 'calendar') {
    keys.sort((a, b) => (CALENDAR_FIELD_ORDER.indexOf(a) + 1 || 99) - (CALENDAR_FIELD_ORDER.indexOf(b) + 1 || 99));
  }
  const allDay = (after.is_all_day ?? before?.is_all_day) === true;
  const show = (key: string, side: Record<string, unknown> | null, fields: Map<string, unknown>): string =>
    side === null ? NONE : resource.kind === 'calendar' ? calendarMoment(key, side, options) ?? plainValue(fields.get(key))
      : plainValue(fields.get(key));
  const lines: string[] = [];
  for (const key of keys) {
    const was = old.get(key), is = now.get(key);
    if (before !== null && JSON.stringify(was ?? null) === JSON.stringify(is ?? null)) continue;
    if (before === null && (is === null || is === undefined || is === '')) continue;
    lines.push(fieldLabel(resource, key, allDay) + ': '
      + (before === null ? show(key, after, now) : show(key, before, old) + ' → ' + show(key, after, now)));
  }
  return lines;
};

/** The parts a resource's key names it by, when its key is the JSON list the server writes. */
const keyParts = (key: string): string[] | undefined => {
  try {
    const parts: unknown = JSON.parse(key);
    return Array.isArray(parts) && parts.every((part) => typeof part === 'string') ? parts : undefined;
  } catch { return undefined; }
};

/** What a change is headed by: the server's label, in the owner's words where it is the label the
 *  server writes for it. A record reads as its kind and title (`note n-1` → Note “Pay rent”), its
 *  ID only when it has no title; an event reads as where it is ("Team sync (local)" → "Team sync,
 *  on your Recued calendar"). Any other label reads as written. */
const heading = (resource: ReviewedResource): string => {
  const parts = keyParts(resource.key);
  if (resource.kind === 'records' && parts?.length === 4) {
    const [, , entity, id] = parts as [string, string, string, string];
    if (resource.label !== entity + ' ' + id) return resource.label;
    const named = [resource.after, resource.before].flatMap((side) => side === null ? [] : RECORD_TITLE_FIELDS
      .map((field) => side[field]).filter((value): value is string => typeof value === 'string' && value.trim() !== ''));
    return humanizeAskField(entity) + (named.length > 0 ? ' “' + plainValue(named[0]) + '”' : ' ' + id);
  }
  if (resource.kind === 'calendar' && parts?.length === 3) {
    const suffix = ' (' + parts[0] + ')';
    if (!resource.label.endsWith(suffix)) return resource.label;
    const name = resource.label.slice(0, -suffix.length).trim() || 'An event';
    return name + ', on ' + (parts[0] === OWN_CALENDAR_SLUG ? 'your Recued calendar' : 'the calendar ' + parts[0]);
  }
  return resource.label;
};

const renderResource = (resource: ReviewedResource, options: RenderResourceReviewOptions): string => {
  const created = resource.precondition.kind === 'records_absent';
  const label = heading(resource);
  const changed = (before: Record<string, unknown> | null) =>
    changedFields(resource, before, resource.after, options).map(line => '  ' + line);
  const lines = created && resource.after === null ? [label, '  Added, then deleted, in this same change']
    : created ? [label + ' (new)', ...changed(null)]
      : resource.after === null ? [label, '  Deleted']
        : [label, ...changed(resource.before)];
  if (!created && resource.after !== null && lines.length === 1) lines.push('  Nothing changes');
  if (resource.changes) {
    lines.push('  Step by step:');
    for (const change of resource.changes) {
      const fields = change.action === 'delete' ? [] : changedFields(resource, change.before, change.after, options);
      lines.push('  ' + String(change.operation_index + 1) + '. ' + (STEP_ACTIONS[change.action] ?? change.action)
        + (fields.length > 0 ? ': ' + fields.join('; ') : ''));
    }
  }
  return lines.join('\n');
};

export const renderResourceReview = (review: ResourceReview, options: RenderResourceReviewOptions = {}): string =>
  review.resources.map(resource => renderResource(resource, options)).join('\n\n');
