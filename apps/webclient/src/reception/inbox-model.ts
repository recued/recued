/** D-173 P6 - Reception Inbox projection model.
 *
 *  Thin webclient surface: server-supplied `InboxItem[]` in, renderable
 *  grouping/detail/form model out. No engine imports, no target resolution,
 *  no synthetic server state. Mutations are shaped as rpc payloads only.
 */

import {
  isReceptionInboxRpcErrorCode,
  type ArgEditField,
  type InboxItem,
  type ReceptionInboxApproveInput,
  type ReceptionInboxApproveResult,
  type ReceptionInboxTopTierKind,
  type ReceptionInboxRejectInput,
  type ReceptionInboxRpcErrorCode,
  type ReceptionInboxScanStatus,
  type ReceptionInboxStatus,
  type ReceptionInboxView,
  type SourceRegistration,
} from '@recued/contracts';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const RECEPTION_INBOX_VIEW_LABELS: Readonly<Record<ReceptionInboxView, string>> = {
  open: 'Open',
  subview: 'Dismissed / expired',
};

export const SOURCE_TOP_TIER_COPY: Readonly<Record<ReceptionInboxTopTierKind, string>> = {
  form_response: 'Form responses',
  task: 'Tasks',
  note: 'Notes',
  commitment: 'Commitments',
  project: 'Projects',
  booking: 'Bookings',
  mail_message: 'Mail messages',
  'calendar.event': 'Calendar events',
  contact: 'Contacts',
  file: 'Files',
};

export const RECEPTION_INBOX_ERROR_COPY: Readonly<Record<ReceptionInboxRpcErrorCode, string>> = {
  permission_denied:
    'The Reception Inbox is admin-only. Re-pair this client with an admin token, or open Settings from an admin-bound device.',
  hold_not_found:
    'That inbox item is no longer held. It may have been resolved from another paired client.',
  edit_not_allowed:
    'One of those edits is not allowlisted for this held operation. Refresh the inbox and try again.',
  // D-210 step 2c — a bad VALUE, not a missing permission. The server names the field and
  // what it expected, so the copy hands that through rather than restating it generically:
  // "start_at must be a finite number" is the whole message the owner needs.
  edit_invalid:
    'One of those edits is not valid for its field. Check the highlighted value and try again.',
  attachment_scan_pending:
    'The attachment is being scanned. Approval is held for a moment until the scan completes — try again shortly.',
  attachment_unscanned:
    'The attachment has not been virus-scanned. Review it, then confirm to attach it anyway.',
  attachment_flagged:
    'The attachment was flagged by the virus scan. Review it, then confirm to attach it anyway.',
  bad_request: 'The inbox request was malformed. Refresh the page and try again.',
};

export const RECEPTION_INBOX_APPROVE_NOT_CONFIGURED_COPY =
  "Couldn't release this inbox item because notifications are not configured.";

export type ReceptionInboxInputKind =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'datetime-local'
  | 'textarea'
  | 'select';

export interface ReceptionInboxFieldModel {
  key: string;
  label: string;
  type: ArgEditField['type'];
  input_kind: ReceptionInboxInputKind;
  required: boolean;
  privacy: ArgEditField['privacy'] | null;
  masked: boolean;
  affects_target: boolean;
  options_source: string | null;
  /** Empty until a picker-options rpc exists and the mount can hydrate it. */
  options: ReadonlyArray<{ value: string; label: string }>;
  picker_stubbed: boolean;
  value: unknown;
  value_text: string;
  validation: ArgEditField['validation'] | null;
}

export interface ReceptionInboxAttachmentModel {
  file_id: string;
  filename: string;
  mime_type: string;
  size: number;
  size_label: string;
  scan_status: ReceptionInboxScanStatus;
  scan_label: string;
  /** `pending` only — a scan is mid-flight; approve genuinely can't proceed
   *  yet (self-clearing once the verdict lands). */
  approve_blocked: boolean;
  /** `unscanned` / `flagged` — advisory: approve proceeds once the admin
   *  acknowledges the risk (warn-and-confirm, not a hard block). */
  requires_acknowledgement: boolean;
  /** A short card warning for a non-`clean` scan state (null when clean). */
  warning: string | null;
}

export interface ReceptionInboxRowModel {
  hold_id: string;
  operation_id: string;
  top_tier_kind: ReceptionInboxTopTierKind;
  top_tier_label: string;
  source_label: string;
  title: string;
  subtitle: string | null;
  when: number | null;
  when_label: string | null;
  /** D-173 D7 — "what else is on then", the line the owner judges capacity on.
   *  `null` ⇒ render nothing (not a booking, or the calendar couldn't be read).
   *  NEVER render "0 others" for unknown: silence and zero mean opposite things
   *  here, and the owner acts on the difference. */
  overlap_label: string | null;
  /** Owner-only prior completed/no-show history. */
  booking_history: InboxItem['booking_history'] | null;
  proposed_action: string;
  status: ReceptionInboxStatus;
  attachment: ReceptionInboxAttachmentModel | null;
  /** D-177 N.14 — the "allow for this form" offer as projected by the
   *  server off the hold's real ask (null when the ask carries none). */
  allow_offer: { ttl_ms: number; max_uses: number } | null;
}

export interface ReceptionInboxGroupModel {
  top_tier_kind: ReceptionInboxTopTierKind;
  label: string;
  rows: ReadonlyArray<ReceptionInboxRowModel>;
}

export interface ReceptionInboxDetailModel {
  item: ReceptionInboxRowModel;
  fields: ReadonlyArray<ReceptionInboxFieldModel>;
  /** Read-only submitted-answer summary for a store-only FormResponse. The
   *  server supplies it as the held operation's immutable `body`; it is never
   *  sent back as an approval edit. */
  review_body: string | null;
  immutable_arg_keys: ReadonlyArray<string>;
  attachment: ReceptionInboxAttachmentModel | null;
  approve_disabled_reason: string | null;
}

export interface ReceptionInboxModel {
  view: ReceptionInboxView;
  view_label: string;
  total_items: number;
  is_empty: boolean;
  groups: ReadonlyArray<ReceptionInboxGroupModel>;
  selected: ReceptionInboxDetailModel | null;
}

export interface ReceptionInboxListDispatch {
  op: 'reception.inbox.list';
  view: ReceptionInboxView;
}

export interface ReceptionInboxApproveDispatch extends ReceptionInboxApproveInput {
  op: 'reception.inbox.approve';
}

export interface ReceptionInboxRejectDispatch extends ReceptionInboxRejectInput {
  op: 'reception.inbox.reject';
}

export type ReceptionInboxDispatch =
  | ReceptionInboxListDispatch
  | ReceptionInboxApproveDispatch
  | ReceptionInboxRejectDispatch;

export const computeReceptionInboxWhenLabel = (
  ts: number,
  now: number,
): string => {
  const delta = ts - now;
  const abs = Math.abs(delta);
  const suffix = delta >= 0 ? 'from now' : 'ago';
  if (abs < MINUTE_MS) return delta >= 0 ? 'now' : 'just now';
  if (abs < HOUR_MS) {
    const m = Math.max(1, Math.round(abs / MINUTE_MS));
    return `${m} ${m === 1 ? 'minute' : 'minutes'} ${suffix}`;
  }
  if (abs < DAY_MS) {
    const h = Math.max(1, Math.round(abs / HOUR_MS));
    return `${h} ${h === 1 ? 'hour' : 'hours'} ${suffix}`;
  }
  const d = Math.max(1, Math.round(abs / DAY_MS));
  return `${d} ${d === 1 ? 'day' : 'days'} ${suffix}`;
};

/** D-173 D7 — the "what else is on then" line the owner judges capacity on.
 *
 *  Since the substrate stopped refusing overlapping bookings (2026-07-16), THIS
 *  LINE IS THE SAFETY MECHANISM. Nothing else stands between the owner and an
 *  unnoticed double-book; they will approve a third booking on the strength of
 *  it reading "2 others". So it is written to the [[substrate_enforces_humans]]
 *  rule — *a check that looks like assurance but isn't is worse than none* —
 *  which here means three things:
 *
 *    1. `null` when unknown. Absent count ⇒ NO LINE. Rendering "0 others" for
 *       "I couldn't look" states the opposite of the truth on the one surface
 *       where it will be acted on.
 *    2. A partial read SAYS SO. `unreadable_calendars > 0` ⇒ the count is a
 *       FLOOR ("at least N"), never a total. An owner reading a confident "1"
 *       when the truth is "1 that I could see" was misled by this function.
 *    3. Zero is worth saying OUT LOUD. "Nothing else booked then" is a real,
 *       useful answer and materially different from silence — it is the
 *       difference between "I checked, you're clear" and "I didn't check".
 *
 *  Returns null (render nothing) when there is no count. */
export const computeReceptionInboxOverlapLabel = (
  overlap: InboxItem['calendar_overlap'],
): string | null => {
  if (overlap === undefined) return null;
  const { count, unreadable_calendars } = overlap;
  const partial = unreadable_calendars > 0;
  // A partial read can never claim "nothing else" — the thing it didn't read is
  // exactly where the clash might be.
  if (count === 0 && !partial) return 'Nothing else booked then';
  const noun = count === 1 ? 'booking' : 'bookings';
  const body = partial
    ? `At least ${count} other ${noun} then`
    : `${count} other ${noun} then`;
  if (!partial) return body;
  const cal = unreadable_calendars === 1 ? 'calendar' : 'calendars';
  return `${body} — ${unreadable_calendars} ${cal} couldn’t be read`;
};

export const formatReceptionInboxFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`;
  const gib = mib / 1024;
  return `${gib.toFixed(gib >= 10 ? 0 : 1)} GiB`;
};

const SCAN_STATUS_WARNING: Readonly<Record<ReceptionInboxScanStatus, string | null>> = {
  clean: null,
  pending: 'Attachment is being scanned…',
  unscanned: 'Attachment has not been virus-scanned.',
  flagged: 'Attachment was flagged by the virus scan.',
};

export const buildReceptionInboxAttachmentModel = (
  attachment: InboxItem['attachment'],
): ReceptionInboxAttachmentModel | null => {
  if (attachment === undefined) return null;
  return {
    file_id: attachment.file_id,
    filename: attachment.filename,
    mime_type: attachment.mime_type,
    size: attachment.size,
    size_label: formatReceptionInboxFileSize(attachment.size),
    scan_status: attachment.scan_status,
    scan_label: attachment.scan_status.replace(/_/g, ' '),
    approve_blocked: attachment.scan_status === 'pending',
    requires_acknowledgement:
      attachment.scan_status === 'unscanned' || attachment.scan_status === 'flagged',
    warning: SCAN_STATUS_WARNING[attachment.scan_status],
  };
};

const sourceLabel = (item: InboxItem): string => {
  const base =
    item.source.kind === 'vendor' && item.source.vendor
      ? item.source.vendor
      : item.source.kind.replace(/_/g, ' ');
  return item.source.endpoint_id ? `${base} - ${item.source.endpoint_id}` : base;
};

export const buildReceptionInboxRowModel = (
  item: InboxItem,
  now: number,
): ReceptionInboxRowModel => ({
  hold_id: item.hold_id,
  operation_id: item.operation_id,
  top_tier_kind: item.top_tier_kind,
  top_tier_label: SOURCE_TOP_TIER_COPY[item.top_tier_kind],
  source_label: sourceLabel(item),
  title: item.preview.title,
  subtitle: item.preview.subtitle ?? null,
  when: item.preview.when ?? null,
  when_label:
    item.preview.when !== undefined
      ? computeReceptionInboxWhenLabel(item.preview.when, now)
      : null,
  overlap_label: computeReceptionInboxOverlapLabel(item.calendar_overlap),
  booking_history: item.booking_history ?? null,
  proposed_action: item.proposed_action,
  status: item.status,
  attachment: buildReceptionInboxAttachmentModel(item.attachment),
  allow_offer: item.allow_offer ?? null,
});

const MULTILINE_STRING_FIELD = /(?:^|[._-])(body|content|description|details?|message|notes?|summary)(?:$|[._-])/i;

const inputKindForField = (
  field: ArgEditField,
  value: unknown,
): ReceptionInboxInputKind => {
  if (field.options_source) return 'select';
  switch (field.type) {
    case 'string': {
      const label = field.label ?? '';
      const text = typeof value === 'string' ? value : '';
      return MULTILINE_STRING_FIELD.test(field.key)
        || MULTILINE_STRING_FIELD.test(label)
        || text.includes('\n')
        || text.length > 120
        ? 'textarea'
        : 'text';
    }
    case 'number':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'datetime':
      return 'datetime-local';
    case 'json':
      return 'textarea';
  }
};

const readArgValue = (args: Readonly<Record<string, unknown>>, key: string): unknown => {
  if (Object.prototype.hasOwnProperty.call(args, key)) return args[key];
  return undefined;
};

export const valueToReceptionInboxInputText = (
  value: unknown,
  type: ArgEditField['type'],
): string => {
  if (value === undefined || value === null) return '';
  if (type === 'datetime') {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value).toISOString().slice(0, 16);
    }
    if (typeof value === 'string') return value.slice(0, 16);
  }
  if (type === 'json') {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  if (type === 'boolean') return value === true ? 'true' : 'false';
  return String(value);
};

export const buildReceptionInboxFieldModel = (
  field: ArgEditField,
  args: Readonly<Record<string, unknown>>,
): ReceptionInboxFieldModel => {
  const value = readArgValue(args, field.key);
  const optionsSource = field.options_source ?? null;
  return {
    key: field.key,
    label: field.label ?? field.key,
    type: field.type,
    input_kind: inputKindForField(field, value),
    required: field.required === true,
    privacy: field.privacy ?? null,
    masked: field.privacy !== undefined,
    affects_target: field.affects_target === true,
    options_source: optionsSource,
    options: [],
    picker_stubbed: optionsSource !== null,
    value,
    value_text: valueToReceptionInboxInputText(value, field.type),
    validation: field.validation ?? null,
  };
};

/** The ONE `options_source` key the reception packs declare on the held-op
 *  destination field (`source_id` / `destination_source_id`, label
 *  "Destination" — see `community/packs/recued-core/reception-*.json`). The
 *  inbox resolves it client-side to the work-entity Source registry via
 *  `work_entity.source.list`. Any other `options_source` stays the
 *  "Picker unavailable" stub until it grows its own resolver. */
export const RECEPTION_DESTINATION_SOURCES_OPTIONS_SOURCE =
  'reception_destination_sources';

/** A ref-picker option projected from a Source — the structural subset the
 *  ui-shared `RefPicker.RefPickerOption` needs, kept import-free so this
 *  model module stays a leaf over `@recued/contracts`. */
export interface ReceptionDestinationOption {
  id: string;
  label: string;
  sublabel: string;
}

/** True for a destination field the inbox can hydrate into a live ref-picker
 *  (vs. the stub for an unknown `options_source`). Key-agnostic — matches on
 *  the declared `options_source`, so `source_id` and `destination_source_id`
 *  both resolve. */
export const isReceptionDestinationPickerField = (
  field: ReceptionInboxFieldModel,
): boolean =>
  field.options_source === RECEPTION_DESTINATION_SOURCES_OPTIONS_SOURCE;

/** Project the work-entity Source registry into destination ref-picker
 *  options. Only write-capable + enabled Sources can receive a reception
 *  materialisation (the boot wire registers builtins `write_capable: true`;
 *  unproven external Sources stay `false` until a write succeeds), so
 *  read-only / disabled Sources are excluded rather than offered as a
 *  destination that would fail at approve. Label = the human Source name;
 *  sublabel = its top-tier kind for disambiguation. */
export const mapSourceRegistrationsToDestinationOptions = (
  sources: ReadonlyArray<SourceRegistration>,
): ReceptionDestinationOption[] =>
  sources
    .filter((source) => source.write_capable === true && source.enabled !== false)
    .map((source) => ({
      id: source.id,
      label: source.source_label,
      sublabel: SOURCE_TOP_TIER_COPY[source.top_tier_kind],
    }));

/** Decide whether a staged destination pick is a real edit: a non-empty id
 *  that differs from the held op's current arg value. Empty or unchanged →
 *  no edit (the picker never force-clears a destination the op already
 *  carries). Pure, for unit coverage of the collect path. */
export const resolveReceptionDestinationEdit = (
  field: ReceptionInboxFieldModel,
  pickedId: string | null | undefined,
): { include: boolean; value?: string } => {
  const id = typeof pickedId === 'string' ? pickedId.trim() : '';
  if (id === '') return { include: false };
  if (id === field.value) return { include: false };
  return { include: true, value: id };
};

export const buildReceptionInboxDetailModel = (
  item: InboxItem,
  now: number,
): ReceptionInboxDetailModel => {
  const editable = new Set(item.arg_schema.fields.map((f) => f.key));
  const immutable_arg_keys = Object.keys(item.args).filter((key) => !editable.has(key)).sort();
  const attachment = buildReceptionInboxAttachmentModel(item.attachment);
  const approve_disabled_reason =
    attachment?.approve_blocked === true ? 'Attachment is being scanned.' : null;
  const review_body =
    item.top_tier_kind === 'form_response'
    && typeof item.args.body === 'string'
    && item.args.body.trim().length > 0
      ? item.args.body
      : null;
  return {
    item: buildReceptionInboxRowModel(item, now),
    fields: item.arg_schema.fields.map((field) =>
      buildReceptionInboxFieldModel(field, item.args),
    ),
    review_body,
    immutable_arg_keys,
    attachment,
    approve_disabled_reason,
  };
};

export const buildReceptionInboxModel = (args: {
  items: ReadonlyArray<InboxItem>;
  view: ReceptionInboxView;
  selected_hold_id?: string | null;
  now: number;
}): ReceptionInboxModel => {
  const rows = args.items.map((item) => buildReceptionInboxRowModel(item, args.now));
  const groupsByKind = new Map<ReceptionInboxTopTierKind, ReceptionInboxRowModel[]>();
  for (const row of rows) {
    const bucket = groupsByKind.get(row.top_tier_kind) ?? [];
    bucket.push(row);
    groupsByKind.set(row.top_tier_kind, bucket);
  }
  const groups: ReceptionInboxGroupModel[] = [];
  for (const [kind, groupRows] of groupsByKind.entries()) {
    groups.push({
      top_tier_kind: kind,
      label: SOURCE_TOP_TIER_COPY[kind],
      rows: groupRows,
    });
  }
  const selectedItem =
    args.selected_hold_id === undefined || args.selected_hold_id === null
      ? null
      : args.items.find((item) => item.hold_id === args.selected_hold_id) ?? null;
  return {
    view: args.view,
    view_label: RECEPTION_INBOX_VIEW_LABELS[args.view],
    total_items: args.items.length,
    is_empty: args.items.length === 0,
    groups,
    selected:
      selectedItem !== null
        ? buildReceptionInboxDetailModel(selectedItem, args.now)
        : null,
  };
};

export const buildReceptionInboxListDispatch = (
  view: ReceptionInboxView,
): ReceptionInboxListDispatch => ({
  op: 'reception.inbox.list',
  view,
});

export const buildReceptionInboxApproveDispatch = (args: {
  hold_id: string;
  edits: Readonly<Record<string, unknown>>;
  acknowledge_attachment_risk?: boolean;
  /** D-177 N.14 — "Approve & allow for this form" (never combines with
   *  edits; the server refuses the combination). */
  allow?: boolean;
}): ReceptionInboxApproveDispatch => ({
  op: 'reception.inbox.approve',
  hold_id: args.hold_id,
  edits: { ...args.edits },
  ...(args.acknowledge_attachment_risk !== undefined
    ? { acknowledge_attachment_risk: args.acknowledge_attachment_risk }
    : {}),
  ...(args.allow === true ? { allow: true } : {}),
});

export const buildReceptionInboxRejectDispatch = (args: {
  hold_id: string;
  reason?: string;
}): ReceptionInboxRejectDispatch => ({
  op: 'reception.inbox.reject',
  hold_id: args.hold_id,
  ...(args.reason !== undefined ? { reason: args.reason } : {}),
});

export const resolveReceptionInboxApproveResultCopy = (
  result: ReceptionInboxApproveResult,
): string | null => {
  if (result.released) return null;
  if (result.reason === 'not_configured') return RECEPTION_INBOX_APPROVE_NOT_CONFIGURED_COPY;
  return "Couldn't release this inbox item.";
};

export const resolveReceptionInboxErrorCopy = (err: unknown): string => {
  const code = err !== null && typeof err === 'object'
    ? (err as { code?: unknown }).code
    : undefined;
  if (isReceptionInboxRpcErrorCode(code)) return RECEPTION_INBOX_ERROR_COPY[code];
  // Humanize the connection codes; a real server error keeps its own message.
  const classified = classifyRpcError(err);
  if (classified.connectionCaused) return classified.copy;
  if (err instanceof Error) return err.message;
  return String(err);
};
