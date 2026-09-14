/** D-173 P6 - Reception Inbox projection tests. */

import { describe, expect, it } from 'vitest';
import type {
  ArgEditField,
  InboxItem,
  SourceRegistration,
} from '@recued/contracts';

import {
  buildReceptionInboxApproveDispatch,
  computeReceptionInboxOverlapLabel,
  buildReceptionInboxDetailModel,
  buildReceptionInboxFieldModel,
  buildReceptionInboxListDispatch,
  buildReceptionInboxModel,
  buildReceptionInboxRejectDispatch,
  isReceptionDestinationPickerField,
  mapSourceRegistrationsToDestinationOptions,
  RECEPTION_DESTINATION_SOURCES_OPTIONS_SOURCE,
  RECEPTION_INBOX_APPROVE_NOT_CONFIGURED_COPY,
  resolveReceptionDestinationEdit,
  resolveReceptionInboxApproveResultCopy,
} from './inbox-model.js';

const NOW = 1_700_000_000_000;

const fields: ArgEditField[] = [
  { key: 'title', type: 'string', label: 'Title', required: true },
  { key: 'amount', type: 'number', label: 'Amount', validation: { min: 1, max: 10 } },
  { key: 'notify', type: 'boolean', label: 'Notify' },
  { key: 'start_at', type: 'datetime', label: 'Start at' },
  { key: 'payload', type: 'json', label: 'Payload' },
  {
    key: 'destination_source_id',
    type: 'string',
    label: 'Destination',
    options_source: 'reception_destination_sources',
    affects_target: true,
  },
  { key: 'email', type: 'string', label: 'Email', privacy: 'email' },
];

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  hold_id: over.hold_id ?? 'hold-1',
  operation_id: over.operation_id ?? 'crm.commitment.create',
  top_tier_kind: over.top_tier_kind ?? 'commitment',
  source: over.source ?? {
    kind: 'intake_form',
    endpoint_id: 'ep-intake',
    record_ref: 'record-1',
  },
  args: over.args ?? {
    title: 'Follow up',
    amount: 3,
    notify: true,
    start_at: NOW + 60_000,
    payload: { source: 'visitor' },
    destination_source_id: 'hubspot.primary.commitment',
    email: 'mary@example.test',
    immutable_arg: 'server-owned',
  },
  arg_schema: over.arg_schema ?? { fields },
  preview: over.preview ?? {
    title: 'Follow up with Sam',
    subtitle: 'Intake form request',
    when: NOW + 2 * 60 * 60 * 1000,
  },
  proposed_action: over.proposed_action ?? 'Make a promise',
  status: over.status ?? 'pending',
  ...(over.attachment !== undefined ? { attachment: over.attachment } : {}),
});

describe('D-173 P6 reception inbox - projection model', () => {
  it('projects a store-only response body as read-only review content', () => {
    const detail = buildReceptionInboxDetailModel(
      item({
        top_tier_kind: 'form_response',
        args: {
          title: 'Client intake form submission',
          body: 'Project: Launch\nTimeline: Next month',
        },
        arg_schema: { fields: [] },
      }),
      NOW,
    );

    expect(detail.review_body).toBe('Project: Launch\nTimeline: Next month');
    expect(detail.fields).toEqual([]);
  });

  it('groups rows by top_tier_kind and selects the requested detail', () => {
    const model = buildReceptionInboxModel({
      items: [
        item({ hold_id: 'hold-1', top_tier_kind: 'commitment' }),
        item({ hold_id: 'hold-2', top_tier_kind: 'task' }),
        item({ hold_id: 'hold-3', top_tier_kind: 'form_response' }),
      ],
      view: 'open',
      selected_hold_id: 'hold-2',
      now: NOW,
    });

    expect(model.view_label).toBe('Open');
    expect(model.total_items).toBe(3);
    expect(model.groups.map((g) => [g.top_tier_kind, g.label, g.rows.length])).toEqual([
      ['commitment', 'Commitments', 1],
      ['task', 'Tasks', 1],
      ['form_response', 'Form responses', 1],
    ]);
    expect(model.selected?.item.hold_id).toBe('hold-2');
    expect(model.selected?.item.when_label).toBe('2 hours from now');
  });

  it('maps every ArgEditField type to the intended input kind', () => {
    const byKey = new Map(
      fields.map((field) => [
        field.key,
        buildReceptionInboxFieldModel(field, item().args),
      ]),
    );

    expect(byKey.get('title')).toMatchObject({
      input_kind: 'text',
      required: true,
      value_text: 'Follow up',
    });
    expect(byKey.get('amount')).toMatchObject({
      input_kind: 'number',
      value_text: '3',
      validation: { min: 1, max: 10 },
    });
    expect(byKey.get('notify')).toMatchObject({
      input_kind: 'checkbox',
      value_text: 'true',
    });
    expect(byKey.get('start_at')).toMatchObject({
      input_kind: 'datetime-local',
      value_text: '2023-11-14T22:14',
    });
    expect(byKey.get('payload')).toMatchObject({
      input_kind: 'textarea',
      value_text: '{\n  "source": "visitor"\n}',
    });
    expect(byKey.get('destination_source_id')).toMatchObject({
      input_kind: 'select',
      options_source: 'reception_destination_sources',
      picker_stubbed: true,
      affects_target: true,
      options: [],
    });
    expect(byKey.get('email')).toMatchObject({
      input_kind: 'text',
      privacy: 'email',
      masked: true,
    });
  });

  it('uses a multiline control for long or body-like string fields', () => {
    const args = {
      body: 'First line\nSecond line',
      notes: 'A'.repeat(140),
      title: 'Short title',
    };

    expect(buildReceptionInboxFieldModel(
      { key: 'body', type: 'string', label: 'Details' },
      args,
    ).input_kind).toBe('textarea');
    expect(buildReceptionInboxFieldModel(
      { key: 'notes', type: 'string', label: 'Notes' },
      args,
    ).input_kind).toBe('textarea');
    expect(buildReceptionInboxFieldModel(
      { key: 'title', type: 'string', label: 'Title' },
      args,
    ).input_kind).toBe('text');
  });

  it('marks a pending attachment approval-blocking (a self-clearing hold)', () => {
    const detail = buildReceptionInboxDetailModel(
      item({
        attachment: {
          file_id: 'file-1',
          filename: 'brief.pdf',
          mime_type: 'application/pdf',
          size: 2048,
          scan_status: 'pending',
        },
      }),
      NOW,
    );

    expect(detail.attachment).toMatchObject({
      filename: 'brief.pdf',
      size_label: '2.0 KiB',
      scan_status: 'pending',
      approve_blocked: true,
      requires_acknowledgement: false,
      warning: 'Checking the file for viruses…',
    });
    expect(detail.approve_disabled_reason).toBe('Recued is checking the file for viruses.');
    expect(detail.immutable_arg_keys).toEqual(['immutable_arg']);
  });

  it('marks unscanned / flagged attachments advisory (requires acknowledgement, not blocked)', () => {
    for (const scan_status of ['unscanned', 'flagged'] as const) {
      const detail = buildReceptionInboxDetailModel(
        item({
          attachment: {
            file_id: 'file-1',
            filename: 'brief.pdf',
            mime_type: 'application/pdf',
            size: 2048,
            scan_status,
          },
        }),
        NOW,
      );
      expect(detail.attachment).toMatchObject({
        scan_status,
        approve_blocked: false,
        requires_acknowledgement: true,
      });
      expect(detail.attachment?.warning).not.toBeNull();
      // Advisory — not a hard block, so no disabled reason; the UI gates on the
      // acknowledgement checkbox instead.
      expect(detail.approve_disabled_reason).toBeNull();
    }
  });

  it('dispatch builders shape only the rpc payloads', () => {
    expect(buildReceptionInboxListDispatch('subview')).toEqual({
      op: 'reception.inbox.list',
      view: 'subview',
    });
    expect(
      buildReceptionInboxApproveDispatch({
        hold_id: 'hold-1',
        edits: { title: 'Updated' },
      }),
    ).toEqual({
      op: 'reception.inbox.approve',
      hold_id: 'hold-1',
      edits: { title: 'Updated' },
    });
    expect(buildReceptionInboxRejectDispatch({ hold_id: 'hold-1', reason: 'duplicate' })).toEqual({
      op: 'reception.inbox.reject',
      hold_id: 'hold-1',
      reason: 'duplicate',
    });
  });

  it('maps unreleased approve results to a non-success inbox message', () => {
    expect(
      resolveReceptionInboxApproveResultCopy({
        hold_id: 'hold-1',
        released: false,
        reason: 'not_configured',
        edited_keys: [],
      }),
    ).toBe(RECEPTION_INBOX_APPROVE_NOT_CONFIGURED_COPY);
    expect(
      resolveReceptionInboxApproveResultCopy({
        hold_id: 'hold-1',
        released: true,
        edited_keys: [],
      }),
    ).toBeNull();
  });
});

describe('reception destination picker helpers (D-174 ref-picker)', () => {
  const destinationField = (
    value?: unknown,
  ): ReturnType<typeof buildReceptionInboxFieldModel> =>
    buildReceptionInboxFieldModel(
      {
        key: 'destination_source_id',
        type: 'string',
        label: 'Destination',
        options_source: RECEPTION_DESTINATION_SOURCES_OPTIONS_SOURCE,
        affects_target: true,
      },
      value === undefined ? {} : { destination_source_id: value },
    );

  const source = (over: Partial<SourceRegistration> = {}): SourceRegistration => ({
    id: over.id ?? 'builtin.task',
    top_tier_kind: over.top_tier_kind ?? 'task',
    source_kind: over.source_kind ?? 'builtin',
    source_label: over.source_label ?? 'Tasks',
    write_capable: over.write_capable ?? true,
    registered_at: over.registered_at ?? NOW,
  });

  it('recognises the reception destination field, not plain fields', () => {
    expect(isReceptionDestinationPickerField(destinationField())).toBe(true);
    expect(
      isReceptionDestinationPickerField(
        buildReceptionInboxFieldModel({ key: 'title', type: 'string', label: 'Title' }, {}),
      ),
    ).toBe(false);
  });


  it('gives every destination a label that identifies it ON ITS OWN', () => {
    // The ref-picker commits the LABEL alone into its input (correctly — a
    // sublabel is the record id on other consumers). So a label that needs
    // its sublabel to disambiguate reads correctly in the open list and
    // then collapses to something ambiguous the moment it is chosen, which
    // is exactly what "Recued built-in" did four times over.
    const options = mapSourceRegistrationsToDestinationOptions([
      source({ id: 'recued.task', source_label: 'Recued built-in', top_tier_kind: 'task' }),
      source({ id: 'recued.note', source_label: 'Recued built-in', top_tier_kind: 'note' }),
      source({ id: 'recued.project', source_label: 'Recued built-in', top_tier_kind: 'project' }),
      // The mirror case: a second Source serving the SAME kind. A kind-only
      // label would collide here just as badly, so the Source name stays.
      source({ id: 'hubspot.acme.task', source_label: 'HubSpot (acme)', top_tier_kind: 'task' }),
    ]);

    const labels = options.map((o) => o.label);
    expect(labels).toEqual([
      'Task · Recued built-in',
      'Note · Recued built-in',
      'Project · Recued built-in',
      'Task · HubSpot (acme)',
    ]);
    expect(new Set(labels).size).toBe(labels.length);
    // The kind leads: it is the first thing read, and the part a narrow
    // field keeps when it truncates.
    expect(labels.every((l) => /^(Task|Note|Project) ·/.test(l))).toBe(true);
  });


  it('stages a destination pick only when it is non-empty and changed', () => {
    const field = destinationField('hubspot.primary.commitment');
    // Unchanged → no edit.
    expect(resolveReceptionDestinationEdit(field, 'hubspot.primary.commitment')).toEqual({
      include: false,
    });
    // Empty / cleared → never force-clears a destination the op already carries.
    expect(resolveReceptionDestinationEdit(field, '')).toEqual({ include: false });
    expect(resolveReceptionDestinationEdit(field, null)).toEqual({ include: false });
    expect(resolveReceptionDestinationEdit(field, '   ')).toEqual({ include: false });
    // A new, different id → a real edit (trimmed).
    expect(resolveReceptionDestinationEdit(field, ' builtin.task ')).toEqual({
      include: true,
      value: 'builtin.task',
    });
  });

  it('stages the first pick when the op carries no destination yet', () => {
    const field = destinationField(); // value undefined
    expect(resolveReceptionDestinationEdit(field, 'builtin.task')).toEqual({
      include: true,
      value: 'builtin.task',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// D-173 D7 — the overlap label (the count the owner judges on)
// ────────────────────────────────────────────────────────────────

/** Since the substrate stopped refusing overlapping bookings (2026-07-16), this
 *  label IS the safety mechanism — nothing else stands between the owner and an
 *  unnoticed double-book. Per [[substrate_enforces_humans]]: *a check that looks
 *  like assurance but isn't is worse than none.* Every case below is one way the
 *  line could mislead the person acting on it. */
describe('computeReceptionInboxOverlapLabel — D-173 D7', () => {
  const overlap = (over: Partial<NonNullable<InboxItem['calendar_overlap']>> = {}) => ({
    count: 0,
    window_start: NOW,
    window_end: NOW + 3600_000,
    calendars_read: 1,
    unreadable_calendars: 0,
    ...over,
  });

  it('renders NOTHING when there is no count — silence is not zero', () => {
    // The load-bearing case. An absent count means "not a booking" or "couldn't
    // look"; rendering "0 others" would state the opposite of the truth on the
    // surface where the owner acts.
    expect(computeReceptionInboxOverlapLabel(undefined)).toBeNull();
  });

  it('says zero OUT LOUD when the read was complete — "I checked, you are clear"', () => {
    // Materially different from silence: it is the difference between a clean
    // check and no check.
    expect(computeReceptionInboxOverlapLabel(overlap({ count: 0 }))).toBe(
      'Nothing else booked then',
    );
  });

  it('counts, and gets the plural right', () => {
    expect(computeReceptionInboxOverlapLabel(overlap({ count: 1 }))).toBe(
      '1 other booking then',
    );
    expect(computeReceptionInboxOverlapLabel(overlap({ count: 3 }))).toBe(
      '3 other bookings then',
    );
  });

  it('a partial read reports a FLOOR and discloses the gap — never a bare total', () => {
    // An owner reading a confident "1" when the truth is "1 that I could see"
    // was misled by this function.
    expect(
      computeReceptionInboxOverlapLabel(
        overlap({ count: 1, calendars_read: 1, unreadable_calendars: 1 }),
      ),
    ).toBe('At least 1 other booking then — 1 calendar could not be read');
    expect(
      computeReceptionInboxOverlapLabel(
        overlap({ count: 4, calendars_read: 1, unreadable_calendars: 2 }),
      ),
    ).toBe('At least 4 other bookings then — 2 calendars could not be read');
  });

  it('a partial read NEVER claims "nothing else" — the unread calendar is where the clash hides', () => {
    // The most dangerous possible rendering: 0 counted, but a calendar failed.
    // "Nothing else booked then" here is a lie that reads as an all-clear.
    expect(
      computeReceptionInboxOverlapLabel(
        overlap({ count: 0, calendars_read: 0, unreadable_calendars: 1 }),
      ),
    ).toBe('At least 0 other bookings then — 1 calendar could not be read');
  });
});
