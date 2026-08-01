/** The schema-bound field-list resolver.
 *
 *  The load-bearing cases are the two that distinguish this block from a
 *  hand-written `to_summary`: a field the schema declares but the record omits
 *  renders as an explicit "not set" rather than vanishing, and an entity no
 *  installed pack declares says so rather than resolving to an empty record.
 */
import { describe, expect, it } from 'vitest';
import type { RecordsEntitySnapshot } from '../records.js';
import {
  entityFieldsFromMetaFields,
  entityFieldsFromRecordsSnapshot,
  isResolvedRecordFieldsDescriptor,
  recordFieldLabel,
  recordFieldsSource,
  resolveRecordFields,
  resolveRecordColumns,
  isResolvedRecordColumnsDescriptor,
} from '../record-fields.js';
import { TABLE_COLUMN_CONTROLS, tableColumnInputType } from '../recipe.js';

const JOB: RecordsEntitySnapshot = {
  kind: 'job',
  fields: [
    { key: 'id', slot: 'pk', kind: 'id', required: true, privacy: 'external_id' },
    { key: 'title', slot: 's1', kind: 'string', required: true, privacy: 'content' },
    { key: 'contact_name', slot: 's2', kind: 'string', required: false, privacy: 'name' },
    { key: 'status', slot: 's3', kind: 'string', required: true },
    { key: 'due_at', slot: 'dt1', kind: 'datetime', required: false },
    { key: 'archived', slot: 'b1', kind: 'boolean', required: true },
  ],
};

const ROW = {
  id: 'job_1',
  title: 'Replace the pump',
  status: 'received',
  archived: false,
  _record: { updated_at: 1, revision: 0 },
};

describe('recordFieldLabel', () => {
  it('title-cases a friendly key', () => {
    expect(recordFieldLabel('contact_name')).toBe('Contact name');
    expect(recordFieldLabel('due_at')).toBe('Due at');
    expect(recordFieldLabel('title')).toBe('Title');
    expect(recordFieldLabel('job-code')).toBe('Job code');
  });

  it('is wrong for acronyms — the documented limit of deriving from `key`', () => {
    // Recorded, not asserted-as-desirable: fixing it means a `label` cell on
    // the entity field, which is an entity-schema decision.
    expect(recordFieldLabel('po_number')).toBe('Po number');
  });
});

describe('recordFieldsSource', () => {
  it('unwraps the three shapes the Records ops actually return', () => {
    expect(recordFieldsSource({ record: ROW })).toBe(ROW);          // get
    expect(recordFieldsSource({ records: [ROW] })).toBe(ROW);       // search / get_many, one row
    expect(recordFieldsSource(ROW)).toBe(ROW);                      // a bare row from a transform
  });

  it('refuses a multi-row list rather than silently showing row 1', () => {
    expect(recordFieldsSource({ records: [ROW, { ...ROW, id: 'job_2' }] })).toBeNull();
    expect(recordFieldsSource({ records: [] })).toBeNull();
  });

  it('refuses an object that is not a record', () => {
    expect(recordFieldsSource(null)).toBeNull();
    expect(recordFieldsSource('a string')).toBeNull();
    expect(recordFieldsSource([ROW])).toBeNull();
    // No `_record` envelope and no string `id` — an arbitrary transform result.
    expect(recordFieldsSource({ count: 3, label: 'Jobs' })).toBeNull();
  });
});

describe('resolveRecordFields', () => {
  it('projects every declared field in schema order when `fields` is omitted', () => {
    const d = resolveRecordFields('job', entityFieldsFromRecordsSnapshot(JOB), { record: ROW });
    expect(d.unresolved).toBeUndefined();
    expect(d.fields.map((f) => f.key)).toEqual(
      ['id', 'title', 'contact_name', 'status', 'due_at', 'archived'],
    );
  });

  it('honours the authored order and selection', () => {
    const d = resolveRecordFields('job', entityFieldsFromRecordsSnapshot(JOB), { record: ROW }, ['status', 'title']);
    expect(d.fields.map((f) => f.key)).toEqual(['status', 'title']);
  });

  it('marks a declared-but-absent field NOT PRESENT rather than dropping it', () => {
    // The difference from a hand-written to_summary: the reader learns the
    // field exists and is unset, instead of the row silently disappearing.
    const d = resolveRecordFields('job', entityFieldsFromRecordsSnapshot(JOB), { record: ROW }, ['contact_name']);
    expect(d.fields).toEqual([{
      key: 'contact_name',
      label: 'Contact name',
      kind: 'string',
      privacy: 'name',
      present: false,
      value: undefined,
    }]);
  });

  it('carries the declared privacy class through, and omits it when undeclared', () => {
    const d = resolveRecordFields('job', entityFieldsFromRecordsSnapshot(JOB), { record: ROW }, ['title', 'status']);
    expect(d.fields[0]?.privacy).toBe('content');
    expect(d.fields[1]).not.toHaveProperty('privacy');
  });

  it('drops a requested key the schema does not declare', () => {
    // The validator cannot catch this (it has no manifest), so the resolver
    // must not invent a blank row for a typo.
    const d = resolveRecordFields('job', entityFieldsFromRecordsSnapshot(JOB), { record: ROW }, ['title', 'nope']);
    expect(d.fields.map((f) => f.key)).toEqual(['title']);
  });

  it('distinguishes "no schema" from "no record" from "empty"', () => {
    expect(resolveRecordFields('job', null, { record: ROW }))
      .toEqual({ entity: 'job', fields: [], unresolved: 'no_schema' });
    expect(resolveRecordFields('job', entityFieldsFromRecordsSnapshot(JOB), { records: [] }))
      .toEqual({ entity: 'job', fields: [], unresolved: 'no_record' });
    // A real record with an empty selection is NOT unresolved.
    expect(resolveRecordFields('job', entityFieldsFromRecordsSnapshot(JOB), { record: ROW }, []))
      .toEqual({ entity: 'job', fields: [] });
  });

  it('treats an explicit undefined value as absent, and false/0/"" as present', () => {
    const schema: RecordsEntitySnapshot = {
      kind: 'x',
      fields: [
        { key: 'a', slot: 's1', kind: 'string', required: false },
        { key: 'b', slot: 'b1', kind: 'boolean', required: false },
        { key: 'c', slot: 'n1', kind: 'number', required: false },
      ],
    };
    const d = resolveRecordFields('x', entityFieldsFromRecordsSnapshot(schema), { id: 'r', a: undefined, b: false, c: 0 });
    expect(d.fields.map((f) => [f.key, f.present])).toEqual([['a', false], ['b', true], ['c', true]]);
  });
});

describe('isResolvedRecordFieldsDescriptor', () => {
  it('accepts what the resolver produces, including the unresolved forms', () => {
    expect(isResolvedRecordFieldsDescriptor(
      resolveRecordFields('job', entityFieldsFromRecordsSnapshot(JOB), { record: ROW }))).toBe(true);
    expect(isResolvedRecordFieldsDescriptor(
      resolveRecordFields('job', null, {}))).toBe(true);
  });

  it('rejects a malformed descriptor rather than letting it reach a renderer', () => {
    expect(isResolvedRecordFieldsDescriptor(null)).toBe(false);
    expect(isResolvedRecordFieldsDescriptor({ entity: '', fields: [] })).toBe(false);
    expect(isResolvedRecordFieldsDescriptor({ entity: 'job' })).toBe(false);
    expect(isResolvedRecordFieldsDescriptor({ entity: 'job', fields: [{ key: 'a' }] })).toBe(false);
    expect(isResolvedRecordFieldsDescriptor(
      { entity: 'job', fields: [], unresolved: 'whatever' })).toBe(false);
  });
});

describe('the two declaration paths normalize to one shape', () => {
  // One authored cell — `entities.<kind>.fields[]` — decomposes by ingredient
  // kind into two runtime shapes. 11 storage ingredients declare entities; 221
  // http ones do. A block reading only the first would derive its display from
  // 5% of what packs actually declare.

  it('adapts a Records snapshot, mapping `kind` onto `type`', () => {
    expect(entityFieldsFromRecordsSnapshot(JOB)).toContainEqual({
      key: 'contact_name', type: 'string', required: false, privacy: 'name',
    });
    // No description on this path — the Records snapshot carries none.
    expect(entityFieldsFromRecordsSnapshot(JOB)[0]).not.toHaveProperty('description');
  });

  it('adapts http meta_fields, keeping type, privacy and description', () => {
    // The literal shape `entity_schemas[].meta_fields` carries (Cal.com).
    expect(entityFieldsFromMetaFields([
      { key: 'name', type: 'string', description: 'Attendee name.', required: true,
        source_path: 'name', privacy: 'name' },
      { key: 'phone_number', type: 'string', description: 'Attendee phone.',
        required: false, source_path: 'phoneNumber', privacy: 'phone' },
    ])).toEqual([
      { key: 'name', type: 'string', required: true, privacy: 'name',
        description: 'Attendee name.', source_path: 'name' },
      { key: 'phone_number', type: 'string', required: false, privacy: 'phone',
        description: 'Attendee phone.', source_path: 'phoneNumber' },
    ]);
  });

  it('treats only an explicit `required: false` as optional', () => {
    // The decomposer already inverted `optional`, so an omitted `required` is
    // not the same as optional — defaulting it the other way would render every
    // populated field as "Not set".
    expect(entityFieldsFromMetaFields([{ key: 'a', type: 'string' }])[0]?.required).toBe(true);
    expect(entityFieldsFromMetaFields([{ key: 'b', type: 'string', required: false }])[0]?.required)
      .toBe(false);
  });

  it('drops a malformed meta field rather than inventing a key', () => {
    expect(entityFieldsFromMetaFields([
      null, 'nope', { type: 'string' }, { key: '' }, { key: 'ok' },
    ])).toEqual([{ key: 'ok', type: 'string', required: true }]);
  });

  it('resolves identically whichever path declared the field', () => {
    // The point of normalizing: the block cannot tell, and must not.
    const viaRecords = resolveRecordFields(
      'x', entityFieldsFromRecordsSnapshot({
        kind: 'x', fields: [{ key: 'name', slot: 's1', kind: 'string', required: true, privacy: 'name' }],
      }), { id: 'r', name: 'A. Client' });
    const viaMeta = resolveRecordFields(
      'x', entityFieldsFromMetaFields([
        { key: 'name', type: 'string', required: true, privacy: 'name', source_path: 'name' },
      ]), { id: 'r', name: 'A. Client' });
    expect(viaMeta.fields).toEqual(viaRecords.fields);
  });
});

describe('a field lives at its source_path, not at its name', () => {
  // ⛔ Found live, and only live. An http entity's `key` is the FRIENDLY name
  // while the record is the vendor's untouched payload. Cal.com declares
  // `event_type_slug <- eventType.slug`; reading by key rendered a populated
  // field as "Not set" — the exact failure this block exists to prevent,
  // produced by the block itself. Every fixture agreed with the bug.
  const CALCOM_BOOKING = {
    id: 23191265,
    uid: 'vnLFHSVvnu34xqBefk6JHU',
    title: '15 min meeting',
    eventType: { id: 6512523, slug: '15min' },
  };
  const declared = entityFieldsFromMetaFields([
    { key: 'title', type: 'string', required: true, source_path: 'title' },
    { key: 'event_type_slug', type: 'string', required: false, source_path: 'eventType.slug' },
    { key: 'event_type_id', type: 'number', required: false, source_path: 'eventType.id' },
    { key: 'missing_thing', type: 'string', required: false, source_path: 'eventType.nope' },
  ]);

  it('follows a dotted source_path into the raw record', () => {
    const byKey = new Map(
      resolveRecordFields('booking', declared, CALCOM_BOOKING).fields.map((f) => [f.key, f]),
    );
    expect(byKey.get('event_type_slug')).toMatchObject({ present: true, value: '15min' });
    expect(byKey.get('event_type_id')).toMatchObject({ present: true, value: 6512523 });
    // A path that genuinely is not there is still "not set", not an error.
    expect(byKey.get('missing_thing')).toMatchObject({ present: false });
  });

  it('does NOT apply source_path on the Records path — there it is a SLOT', () => {
    // `RecordsFieldSnapshot.slot` is `s1` / `pk`: a physical column, not a path
    // into the returned record, which the store has already projected to
    // friendly names. Using it would read `record.s1` and find nothing.
    const fields = entityFieldsFromRecordsSnapshot(JOB);
    expect(fields.every((f) => f.source_path === undefined)).toBe(true);
    expect(resolveRecordFields('job', fields, { record: ROW }, ['title']).fields[0])
      .toMatchObject({ present: true, value: 'Replace the pump' });
  });

  it('reads a NON-dotted source_path exactly like a key', () => {
    expect(resolveRecordFields('booking', declared, CALCOM_BOOKING, ['title']).fields[0])
      .toMatchObject({ present: true, value: '15 min meeting' });
  });
});

describe('resolveRecordColumns — the table half of the same schema', () => {
  const DECLARED = [
    { key: 'label', type: 'string', required: true },
    { key: 'opened_at', type: 'datetime', required: false },
    { key: 'due_on', type: 'date', required: false },
    { key: 'rent', type: 'decimal', required: false },
    { key: 'active', type: 'boolean', required: true },
  ];

  it('derives one column per declared field, labelled from the key', () => {
    const out = resolveRecordColumns('unit', DECLARED);
    expect(out.entity).toBe('unit');
    expect(out.columns.map((c) => [c.field, c.label])).toEqual([
      ['label', 'Label'], ['opened_at', 'Opened at'], ['due_on', 'Due on'],
      ['rent', 'Rent'], ['active', 'Active'],
    ]);
  });

  it('formats ONLY the date family', () => {
    // ⛔ A `decimal` is not necessarily money and a `number` is not necessarily
    // a quantity worth grouping — guessing either restyles a column the author
    // never asked about. Dates are the one kind whose raw form is unreadable.
    const byField = new Map(resolveRecordColumns('unit', DECLARED).columns.map((c) => [c.field, c]));
    expect(byField.get('opened_at')?.format).toBe('date');
    expect(byField.get('due_on')?.format).toBe('date');
    expect(byField.get('rent')?.format).toBeUndefined();
    expect(byField.get('label')?.format).toBeUndefined();
    expect(byField.get('active')?.format).toBeUndefined();
  });

  it('honours the requested order and drops a key the schema does not declare', () => {
    const out = resolveRecordColumns('unit', DECLARED, ['active', 'label', 'not_a_field']);
    expect(out.columns.map((c) => c.field)).toEqual(['active', 'label']);
  });

  it('reads a value through source_path when the raw record nests it', () => {
    const out = resolveRecordColumns('unit', [
      { key: 'tenant', type: 'string', required: false, source_path: 'customer.name' },
    ]);
    expect(out.columns[0]?.field).toBe('customer.name');
    expect(out.columns[0]?.label).toBe('Tenant');
  });

  it('says WHY it resolved empty rather than returning a bare list', () => {
    expect(resolveRecordColumns('unit', null))
      .toEqual({ entity: 'unit', columns: [], unresolved: 'no_schema' });
  });

  it('guards the wire shape', () => {
    expect(isResolvedRecordColumnsDescriptor(resolveRecordColumns('unit', DECLARED))).toBe(true);
    expect(isResolvedRecordColumnsDescriptor({ entity: 'unit' })).toBe(false);
    expect(isResolvedRecordColumnsDescriptor({ entity: 'unit', columns: [{ field: 'x' }] })).toBe(false);
  });
});

describe('extending the assigned model — authored columns', () => {
  const DECLARED = [
    { key: 'contract_ref', type: 'string', required: true },
    { key: 'amount', type: 'decimal', required: false },
    { key: 'method', type: 'string', required: false },
  ];

  it('APPENDS a column the schema has no slot for', () => {
    // A rent sheet's row is a `receipt` plus the tenant's name and the rent
    // due — joins, not slots. Before this the whole table had to give up its
    // entity to show them, and with it every derived label and alignment.
    const out = resolveRecordColumns('receipt', DECLARED, [
      { field: 'tenant', label: 'Tenant' },
      { field: 'rent_due', label: 'Rent due', kind: 'decimal' },
      'amount',
    ]);
    expect(out.columns.map((c) => [c.field, c.label, c.kind])).toEqual([
      ['tenant', 'Tenant', 'string'],
      ['rent_due', 'Rent due', 'decimal'],
      ['amount', 'Amount', 'decimal'],
    ]);
  });

  it('OVERRIDES a schema column\'s presentation without touching the schema', () => {
    // ⛔ The point of the shape. How a value is SHOWN is the view's business;
    // making every caption change a schema change would put the pack's version
    // in the path of a wording fix — and every install that follows it.
    const out = resolveRecordColumns('receipt', DECLARED, [
      { field: 'method', label: 'Paid how?', control: 'radio', options: ['bank', 'cash'] },
    ]);
    expect(out.columns).toEqual([{
      field: 'method', label: 'Paid how?', kind: 'string',
      control: 'radio', options: ['bank', 'cash'],
    }]);
  });

  it('keeps the SCHEMA kind when an override omits one', () => {
    // ⛔ Retitling a decimal must not silently un-align it. `kind` drives
    // right-alignment and date formatting, so defaulting it to `string` here
    // would make "give this column a better caption" a layout regression.
    const [column] = resolveRecordColumns('receipt', DECLARED,
      [{ field: 'amount', label: 'Received' }]).columns;
    expect(column?.kind).toBe('decimal');
  });

  it('draws an appended date through the same format path as a declared one', () => {
    const [column] = resolveRecordColumns('receipt', DECLARED,
      [{ field: 'cleared_on', label: 'Cleared', kind: 'date' }]).columns;
    expect(column?.format).toBe('date');
  });

  it('leaves a plain string list resolving exactly as before', () => {
    // The extension is additive: every shipped table names its columns as
    // strings, and none of them may move.
    expect(resolveRecordColumns('receipt', DECLARED, ['method', 'amount']).columns)
      .toEqual([
        { field: 'method', label: 'Method', kind: 'string' },
        { field: 'amount', label: 'Amount', kind: 'decimal' },
      ]);
  });

  it('still reports no_schema rather than rendering the authored columns alone', () => {
    // ⛔ A half-drawn table is worse than a degraded one: the pack is not
    // installed, so the joins would appear beside missing record columns and
    // read as data that is absent rather than a table that cannot resolve.
    const out = resolveRecordColumns('receipt', null, [{ field: 'tenant', label: 'Tenant' }]);
    expect(out).toEqual({ entity: 'receipt', columns: [], unresolved: 'no_schema' });
  });
});

describe('the editor a cell gets comes from its declared kind', () => {
  // ⛔ From the DECLARATION, never the runtime value — the same rule as the
  // right-alignment beside it. Money in a Records pack is a `decimal` slot
  // returned as the STRING "1200.0000", so a `typeof` test would hand every
  // amount a plain text box.
  it('derives date, datetime and numeric editors', () => {
    expect(tableColumnInputType({ kind: 'date' })).toBe('date');
    expect(tableColumnInputType({ kind: 'datetime' })).toBe('datetime-local');
    expect(tableColumnInputType({ kind: 'number' })).toBe('number');
    expect(tableColumnInputType({ kind: 'decimal' })).toBe('number');
  });

  it('falls back to text for everything else, including unknown kinds', () => {
    // A kind this does not know must not produce a control nobody can type in.
    expect(tableColumnInputType({ kind: 'string' })).toBe('text');
    expect(tableColumnInputType({ kind: 'reference' })).toBe('text');
  });

  it('lets an authored `text` override a kind that lies about how it is typed', () => {
    // A date kept in a string slot, a reference that happens to be numeric —
    // the escape hatch, and the only reason `text` is in the vocabulary.
    expect(tableColumnInputType({ kind: 'date', control: 'text' })).toBe('text');
    expect(tableColumnInputType({ kind: 'decimal', control: 'text' })).toBe('text');
  });

  it('returns null for the controls that are not an <input> at all', () => {
    for (const control of ['select', 'radio', 'textarea'] as const) {
      expect(tableColumnInputType({ kind: 'string', control }), control).toBeNull();
      // ⛔ Including where the KIND would otherwise have won — an authored
      // select over dates must not silently become a date picker.
      expect(tableColumnInputType({ kind: 'date', control }), control).toBeNull();
    }
  });

  it('has NO checkbox — a boolean slot needs a real boolean at the store', () => {
    // ⛔ The trap this vocabulary declines. A grid cell is a STRING by design,
    // but `records/store.ts` refuses a non-boolean for a `b` slot — and refuses
    // it inside a `foreach`, where a per-item failure never fails the run. A
    // checkbox emitting 'true' would report success having written nothing.
    expect([...TABLE_COLUMN_CONTROLS]).not.toContain('checkbox');
    expect(tableColumnInputType({ kind: 'boolean' })).toBe('text');
  });
});
