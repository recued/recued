/** D-149 § N.6 "Open submission detail" — `reception.record.open`: the owner opens ONE record
 *  and sees who the visitor was.
 *
 *  Drives the REAL store over an in-memory DB, with rows sealed and opened by the production
 *  crypto (`openReceptionRecordBlob`, the function the server composes). Only the store getter,
 *  the key and the endpoint-name lookup are seams.
 *
 *  The properties, in the order they matter:
 *    - the owner sees the visitor's answers under the form's own labels, as the form was when
 *      they sent it — and their address, to write back to;
 *    - ⛔ only a paired admin, and a refused caller never causes a decrypt;
 *    - ⛔ a record that cannot be opened is an error, never a record with no answers;
 *    - the method exists only when its key is wired.
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createReceptionFormSubmissionStore,
  type FormSubmissionStore,
  type FormSubmissionSummary,
} from '../storage/reception-form-store.js';
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  sealFormSubmissionField,
} from '../ports/reception/form-pii.js';
import { sealBookingSubmissionBlob } from '../ports/reception/booking-blob.js';
import { openReceptionRecordBlob } from '../ports/reception/open-reception-record.js';
import {
  handleReceptionRecordList,
  handleReceptionRecordOpen,
  makeReceptionRecordOpenHandlers,
  type ReceptionRecordOpenDeps,
} from '../reception-record-handler.js';

const NOW = 1_700_000_000_000;
const KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x5a));
const OTHER_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x11));
const ADMIN = { instance_id: 'owner-client' };

/** The form as the visitor saw it — frozen onto the row at submit, as the intake handler does. */
const FORM = {
  form_definition_id: 'fd_buy_the_kit_v1',
  fields: [
    { name: 'name', type: 'text', label: 'Your name', required: true },
    { name: 'company', type: 'text', label: 'Company', required: false },
    { name: 'services', type: 'array<text>', label: 'What do you need?', required: false },
    { name: 'newsletter', type: 'boolean', label: 'Send me news', required: false },
    { name: 'budget', type: 'number', label: 'Budget', required: false },
    { name: 'message', type: 'textarea', label: 'Anything else?', required: false },
  ],
};

let db: Database.Database;
let store: FormSubmissionStore;

beforeEach(() => {
  db = new Database(':memory:');
  ensureReceptionSchema(db);
  store = createReceptionFormSubmissionStore(db);
});

const sealIntake = async (input: {
  submission_id: string;
  endpoint_id?: string;
  email?: string | null;
  fields: Record<string, unknown>;
  definition?: unknown;
  key?: Uint8Array;
}): Promise<void> => {
  const endpoint_id = input.endpoint_id ?? 'ep-kit';
  const key = input.key ?? KEY;
  const email = input.email === undefined ? 'dana@example.com' : input.email;
  const at = { key, endpoint_id, submission_id: input.submission_id };
  store.insert({
    submission_id: input.submission_id,
    endpoint_id,
    form_definition_id: FORM.form_definition_id,
    submitted_at: NOW - 1_000,
    source_ip_hash: 'ip-hash',
    visitor_email_encrypted: await sealFormSubmissionField({ ...at, field: 'visitor_email', plaintext: email }),
    submission_blob_encrypted: (await sealFormSubmissionField({
      ...at,
      field: 'submission_blob',
      plaintext: JSON.stringify({ ...(email ? { visitor_email: email } : {}), fields: input.fields }),
    }))!,
    schema_version: 1,
    processing_outcome: 'pending',
    metadata: input.definition === undefined ? { definition_snapshot: FORM } : { definition_snapshot: input.definition },
  });
};

const sealBooking = async (submission_id: string): Promise<void> => {
  const endpoint_id = 'ep-book';
  store.insert({
    submission_id,
    endpoint_id,
    form_definition_id: null,
    submitted_at: NOW - 2_000,
    source_ip_hash: 'ip-hash',
    visitor_email_encrypted: await sealFormSubmissionField({
      key: KEY, endpoint_id, submission_id, field: 'visitor_email', plaintext: 'sam@example.com',
    }),
    submission_blob_encrypted: await sealBookingSubmissionBlob({
      key: KEY,
      endpoint_id,
      submission_id,
      fields: { name: 'Sam Example', email: 'sam@example.com', topic: 'Kitchen fit-out', phone: null, notes: 'After 4pm please' },
    }),
    schema_version: 1,
    processing_outcome: 'pending',
    slot: { start_at: NOW + 86_400_000, end_at: NOW + 86_400_000 + 1_800_000, duration_minutes: 30 },
  });
};

const deps = (over: Partial<ReceptionRecordOpenDeps> = {}): ReceptionRecordOpenDeps => ({
  find: (record_id) => store.findById(record_id),
  open: (row) => openReceptionRecordBlob({ key: KEY, row }),
  formName: (endpoint_id) => (endpoint_id === 'ep-kit' ? 'Buy the kit' : endpoint_id === 'ep-book' ? 'Book a call' : null),
  ...over,
});

const refusal = async (promise: Promise<unknown>): Promise<{ code: string; status: number }> => {
  try {
    await promise;
  } catch (error) {
    const { code, status } = error as { code: string; status: number };
    return { code, status };
  }
  throw new Error('expected a refusal');
};

describe('the owner opens a record and sees who the visitor was', () => {
  it('lists the visitor’s answers under the form’s own labels, in its order, with their address first', async () => {
    await sealIntake({
      submission_id: 'sub-dana',
      fields: {
        name: 'Dana Example',
        company: '',
        services: ['Logo', 'Website'],
        newsletter: true,
        budget: 2900,
        message: '  I would like the kit.  ',
      },
    });

    const opened = await handleReceptionRecordOpen(deps(), { record_id: 'sub-dana' }, ADMIN);

    expect(opened.form_name).toBe('Buy the kit');
    expect(opened.visitor_email).toBe('dana@example.com');
    expect(opened.answers).toEqual([
      { label: 'Email', value: 'dana@example.com' },
      { label: 'Your name', value: 'Dana Example' },
      // A question left blank is left out, not shown empty.
      { label: 'What do you need?', value: 'Logo, Website' },
      { label: 'Send me news', value: 'Yes' },
      { label: 'Budget', value: '2900' },
      { label: 'Anything else?', value: 'I would like the kit.' },
    ]);
    // The same redacted summary the list carries, so the panel needs no second read.
    expect(opened.record).toMatchObject({ kind: 'intake_form', record_id: 'sub-dana', endpoint_id: 'ep-kit', outcome: 'pending' });
  });

  it('labels answers as the form was when they were sent, not as it is now', async () => {
    // The frozen definition is the only label source: the handler never reads the endpoint's
    // current form, so an edit made since cannot relabel an old answer.
    await sealIntake({
      submission_id: 'sub-old',
      fields: { name: 'Lee Example', newsletter: false },
      definition: { ...FORM, fields: [
        { name: 'name', type: 'text', label: 'Full name (old label)', required: true },
        { name: 'newsletter', type: 'boolean', label: 'News?', required: false },
      ] },
    });

    const opened = await handleReceptionRecordOpen(deps(), { record_id: 'sub-old' }, ADMIN);

    expect(opened.answers).toEqual([
      { label: 'Email', value: 'dana@example.com' },
      { label: 'Full name (old label)', value: 'Lee Example' },
      { label: 'News?', value: 'No' },
    ]);
  });

  it('shows a choice as the form showed it to the visitor: its label from the frozen form', async () => {
    await sealIntake({
      submission_id: 'sub-choice',
      fields: { name: 'Pat Example', budget_range: '10k_50k', timeline: 'exploring' },
      definition: { ...FORM, fields: [
        { name: 'name', type: 'text', label: 'Your name', required: true },
        {
          name: 'budget_range',
          type: 'enum',
          label: 'Budget range',
          required: false,
          values: ['under_10k', '10k_50k'],
          value_labels: { under_10k: 'Under 10k', '10k_50k': '10k–50k' },
        },
        // A choice the frozen form gave no label shows as its value.
        { name: 'timeline', type: 'enum', label: 'Timeline', required: false, values: ['asap', 'exploring'] },
      ] },
    });

    const opened = await handleReceptionRecordOpen(deps(), { record_id: 'sub-choice' }, ADMIN);

    expect(opened.answers).toEqual([
      { label: 'Email', value: 'dana@example.com' },
      { label: 'Your name', value: 'Pat Example' },
      { label: 'Budget range', value: '10k–50k' },
      { label: 'Timeline', value: 'exploring' },
    ]);
  });

  it('still shows an answer the frozen form does not name, under its field name, rather than hiding it', async () => {
    await sealIntake({ submission_id: 'sub-extra', fields: { name: 'Kim', referral: 'A friend' }, definition: null, email: null });

    const opened = await handleReceptionRecordOpen(deps(), { record_id: 'sub-extra' }, ADMIN);

    expect(opened.visitor_email).toBeNull();
    expect(opened.answers).toEqual([
      { label: 'name', value: 'Kim' },
      { label: 'referral', value: 'A friend' },
    ]);
  });

  it('opens a booking too: who asked for the slot, under the labels their receipt used', async () => {
    await sealBooking('req-sam');

    const opened = await handleReceptionRecordOpen(deps(), { record_id: 'req-sam' }, ADMIN);

    expect(opened.form_name).toBe('Book a call');
    expect(opened.visitor_email).toBe('sam@example.com');
    expect(opened.answers).toEqual([
      { label: 'Name', value: 'Sam Example' },
      { label: 'Email', value: 'sam@example.com' },
      { label: 'Topic', value: 'Kitchen fit-out' },
      { label: 'Notes', value: 'After 4pm please' },
    ]);
    expect(opened.record).toMatchObject({ kind: 'scheduling_link', record_id: 'req-sam' });
  });

  it('names no form when the endpoint is gone or its name cannot be read, and still opens', async () => {
    await sealIntake({ submission_id: 'sub-gone', endpoint_id: 'ep-deleted', fields: { name: 'Pat' } });

    expect((await handleReceptionRecordOpen(deps(), { record_id: 'sub-gone' }, ADMIN)).form_name).toBeNull();
    const throwing = deps({ formName: () => { throw new Error('registry closed'); } });
    const opened = await handleReceptionRecordOpen(throwing, { record_id: 'sub-gone' }, ADMIN);
    expect(opened.form_name).toBeNull();
    expect(opened.answers).toContainEqual({ label: 'Your name', value: 'Pat' });
  });
});

describe('⛔ the gate', () => {
  it('answers only a paired admin, and a refused caller never causes a decrypt', async () => {
    await sealIntake({ submission_id: 'sub-dana', fields: { name: 'Dana Example' } });
    const open = vi.fn((row: FormSubmissionSummary) => openReceptionRecordBlob({ key: KEY, row }));

    for (const caller of [undefined, {}, { instance_id: null }, { instance_id: '' }]) {
      expect(await refusal(handleReceptionRecordOpen(deps({ open }), { record_id: 'sub-dana' }, caller)))
        .toEqual({ code: 'permission_denied', status: 403 });
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a malformed id and names a missing record as missing', async () => {
    for (const args of [undefined, {}, { record_id: '' }, { record_id: 42 }, { record_id: 'x'.repeat(201) }]) {
      expect(await refusal(handleReceptionRecordOpen(deps(), args as never, ADMIN)))
        .toEqual({ code: 'reception_record_invalid', status: 400 });
    }
    expect(await refusal(handleReceptionRecordOpen(deps(), { record_id: 'sub-nobody' }, ADMIN)))
      .toEqual({ code: 'reception_record_not_found', status: 404 });
  });

  it('⛔ a record that cannot be opened is an error — never a record with no answers', async () => {
    // Sealed under another key: what a rotated key or a moved row looks like to the reader.
    await sealIntake({ submission_id: 'sub-sealed-elsewhere', fields: { name: 'Dana' }, key: OTHER_KEY });

    expect(await refusal(handleReceptionRecordOpen(deps(), { record_id: 'sub-sealed-elsewhere' }, ADMIN)))
      .toEqual({ code: 'reception_record_unreadable', status: 500 });
  });

  it('keeps the LIST redacted: opening one record adds nothing to what the list says', async () => {
    await sealIntake({ submission_id: 'sub-dana', fields: { name: 'Dana Example' } });
    await handleReceptionRecordOpen(deps(), { record_id: 'sub-dana' }, ADMIN);

    const wire = JSON.stringify(await handleReceptionRecordList(
      { getSubmissionStore: () => store, openRecord: deps() },
      {},
      ADMIN,
    ));
    expect(wire).toContain('sub-dana');
    expect(wire).not.toContain('Dana Example');
    expect(wire).not.toContain('dana@example.com');
  });
});

describe('the method exists only with its key', () => {
  it('registers `reception.record.open` only when `openRecord` is wired', async () => {
    expect(makeReceptionRecordOpenHandlers(undefined)).toBeUndefined();
    expect(makeReceptionRecordOpenHandlers({ getSubmissionStore: () => store })).toBeUndefined();

    const slice = makeReceptionRecordOpenHandlers({ getSubmissionStore: () => store, openRecord: deps() });
    expect(slice?.methods).toEqual(['reception.record.open']);
    await sealIntake({ submission_id: 'sub-dana', fields: { name: 'Dana Example' } });
    const opened = await slice!.handlers['reception.record.open']({ record_id: 'sub-dana' }, { instance_id: 'owner-client' });
    expect(opened.answers).toContainEqual({ label: 'Your name', value: 'Dana Example' });
  });
});

describe('the list names each record’s form, so a record can be matched to its notice', () => {
  it('carries the owner’s name for the form, looked up once per form', async () => {
    await sealIntake({ submission_id: 'sub-dana', fields: { name: 'Dana' } });
    await sealIntake({ submission_id: 'sub-sam', fields: { name: 'Sam' } });
    await sealBooking('req-lee');
    const formName = vi.fn((endpoint_id: string) => (endpoint_id === 'ep-kit' ? '  Buy the kit ' : null));

    const listed = await handleReceptionRecordList(
      { getSubmissionStore: () => store, getBookingStore: () => store, formName },
      {},
      ADMIN,
    );

    const byId = new Map(listed.records.map((record) => [record.record_id, record]));
    expect(byId.get('sub-dana')?.form_name).toBe('Buy the kit');
    expect(byId.get('sub-sam')?.form_name).toBe('Buy the kit');
    // No name known ⇒ no `form_name` at all, never a blank or a guess.
    expect(byId.get('req-lee')).not.toHaveProperty('form_name');
    expect(formName).toHaveBeenCalledTimes(2);
  });

  it('lists records without names when the lookup fails, rather than failing the list', async () => {
    await sealIntake({ submission_id: 'sub-dana', fields: { name: 'Dana' } });
    const listed = await handleReceptionRecordList(
      { getSubmissionStore: () => store, formName: () => { throw new Error('registry closed'); } },
      {},
      ADMIN,
    );
    expect(listed.records).toHaveLength(1);
    expect(listed.records[0]).not.toHaveProperty('form_name');
  });

  it('names the form on an opened record’s summary too', async () => {
    await sealIntake({ submission_id: 'sub-dana', fields: { name: 'Dana' } });
    const opened = await handleReceptionRecordOpen(deps(), { record_id: 'sub-dana' }, ADMIN);
    expect(opened.record.form_name).toBe('Buy the kit');
  });
});
