/** D-149 P6 § A.5.3 — reception form definition + submission store tests. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createReceptionFormDefinitionStore,
  createReceptionFormSubmissionStore,
} from '../storage/reception-form-store.js';

const NOW = 1_700_000_000_000;

const buildDb = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  return db;
};

const goodSchema = (): Record<string, unknown> => ({
  form_definition_id: 'fd_test',
  fields: [
    { name: 'name', type: 'text', label: 'Name', required: true },
  ],
});

describe('D-149 P6 § A.5.3 — FormDefinitionStore', () => {
  it('upsert inserts a new row', () => {
    const db = buildDb();
    const store = createReceptionFormDefinitionStore(db);
    const row = store.upsert({
      form_definition_id: 'fd_test',
      template_ref: 'foundation:intake/client_inquiry',
      schema: goodSchema(),
      now: NOW,
      per_field_visibility: { name: 'visitor' },
      metadata: { source: 'p6-test' },
    });
    expect(row.form_definition_id).toBe('fd_test');
    expect(row.template_ref).toBe('foundation:intake/client_inquiry');
    expect(row.created_at).toBe(NOW);
    expect(row.per_field_visibility).toEqual({ name: 'visitor' });
    expect(row.metadata).toEqual({ source: 'p6-test' });
  });

  it('upsert preserves created_at on update', () => {
    const db = buildDb();
    const store = createReceptionFormDefinitionStore(db);
    store.upsert({
      form_definition_id: 'fd_test',
      schema: goodSchema(),
      now: NOW,
    });
    const updated = store.upsert({
      form_definition_id: 'fd_test',
      schema: { ...goodSchema(), fields: [] },
      now: NOW + 60_000,
    });
    expect(updated.created_at).toBe(NOW);
    expect(updated.updated_at).toBe(NOW + 60_000);
    expect((updated.schema as { fields: unknown[] }).fields).toEqual([]);
  });

  it('findById returns null for unknown id', () => {
    const db = buildDb();
    const store = createReceptionFormDefinitionStore(db);
    expect(store.findById('missing')).toBeNull();
  });

  it('delete removes a row + returns the correct status', () => {
    const db = buildDb();
    const store = createReceptionFormDefinitionStore(db);
    store.upsert({ form_definition_id: 'fd_test', schema: goodSchema(), now: NOW });
    expect(store.delete('fd_test')).toBe('deleted');
    expect(store.findById('fd_test')).toBeNull();
    expect(store.delete('fd_test')).toBe('not_found');
  });
});

describe('D-149 P6 § A.5.3 — FormSubmissionStore', () => {
  it('insert persists a row + listPendingForEndpoint returns it', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    const row = store.insert({
      submission_id: 'sub-1',
      endpoint_id: 'ep-1',
      form_definition_id: 'fd_test',
      submitted_at: NOW,
      source_ip_hash: null,
      visitor_email_encrypted: 'AAAA',
      submission_blob_encrypted: 'AQID', // 3 bytes base64
      schema_version: 1,
      processing_outcome: 'pending',
    });
    expect(row.submission_id).toBe('sub-1');
    expect(row.processing_outcome).toBe('pending');
    const pending = store.listPendingForEndpoint('ep-1');
    expect(pending.length).toBe(1);
    expect(pending[0]!.submission_id).toBe('sub-1');
  });

  it('pages pending rows by stable submitted-at and submission-id cursor', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    for (const [submission_id, submitted_at] of [
      ['sub-b', NOW],
      ['sub-a', NOW],
      ['sub-c', NOW + 1],
    ] as const) {
      store.insert({
        submission_id,
        endpoint_id: 'ep-1',
        form_definition_id: 'fd_test',
        submitted_at,
        source_ip_hash: null,
        visitor_email_encrypted: null,
        submission_blob_encrypted: 'AQID',
        schema_version: 1,
        processing_outcome: 'pending',
      });
    }

    const first = store.listPendingForEndpoint('ep-1', 1);
    expect(first.map((row) => row.submission_id)).toEqual(['sub-a']);
    const second = store.listPendingForEndpoint('ep-1', 1, {
      submitted_at: first[0]!.submitted_at,
      submission_id: first[0]!.submission_id,
    });
    expect(second.map((row) => row.submission_id)).toEqual(['sub-b']);
    const third = store.listPendingForEndpoint('ep-1', 1, {
      submitted_at: second[0]!.submitted_at,
      submission_id: second[0]!.submission_id,
    });
    expect(third.map((row) => row.submission_id)).toEqual(['sub-c']);
  });

  it('insert requires submission_blob_encrypted (non-empty)', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    // The store does NOT accept an empty base64 string. We model that
    // here by passing an unhandled `null` cast through the typed boundary.
    expect(() =>
      store.insert({
        submission_id: 'sub-2',
        endpoint_id: 'ep-1',
        form_definition_id: 'fd_test',
        submitted_at: NOW,
        source_ip_hash: null,
        visitor_email_encrypted: null,
        submission_blob_encrypted: null as unknown as string,
        schema_version: 1,
        processing_outcome: 'pending',
      }),
    ).toThrow();
  });

  it('markProcessed flips terminal state + records resolved refs', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    store.insert({
      submission_id: 'sub-1',
      endpoint_id: 'ep-1',
      form_definition_id: 'fd_test',
      submitted_at: NOW,
      source_ip_hash: null,
      visitor_email_encrypted: null,
      submission_blob_encrypted: 'AQID',
      schema_version: 1,
      processing_outcome: 'pending',
    });
    const r = store.markProcessed({
      submission_id: 'sub-1',
      outcome: 'processed',
      resolved: { kind: 'commitment', id: 'cmt-1' },
    });
    expect(r).toBe('updated');
    const after = store.findById('sub-1');
    expect(after!.processing_outcome).toBe('processed');
    expect(after!.resolved_target_kind).toBe('commitment');
    expect(after!.resolved_target_id).toBe('cmt-1');
  });

  // D-210 A.8 slice 4b — `markProcessed` was a FULL SET, so any later call
  // passing only an outcome nulled the resolved pointer a previous call had
  // written. The booking mint's write-back happened to run last, so nothing
  // broke — but nothing enforced that ordering, and the wipe was silent: the
  // manage page then refused the reschedule with no error anywhere.
  it('markProcessed LEAVES the resolved pointer alone when `resolved` is omitted', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    store.insert({
      submission_id: 'sub-1',
      endpoint_id: 'ep-1',
      form_definition_id: 'fd_test',
      submitted_at: NOW,
      source_ip_hash: null,
      visitor_email_encrypted: null,
      submission_blob_encrypted: 'AQID',
      schema_version: 1,
      processing_outcome: 'pending',
    });
    store.markProcessed({
      submission_id: 'sub-1',
      outcome: 'processed',
      resolved: { kind: 'booking', id: 'bk-1' },
    });

    // The second call — an outcome flip that knows nothing about the pointer.
    store.markProcessed({ submission_id: 'sub-1', outcome: 'failed' });

    const after = store.findById('sub-1');
    expect(after!.processing_outcome).toBe('failed');
    expect(after!.resolved_target_kind).toBe('booking');
    expect(after!.resolved_target_id).toBe('bk-1');
  });

  it('markProcessed CLEARS the resolved pointer when `resolved` is explicitly null', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    store.insert({
      submission_id: 'sub-1',
      endpoint_id: 'ep-1',
      form_definition_id: 'fd_test',
      submitted_at: NOW,
      source_ip_hash: null,
      visitor_email_encrypted: null,
      submission_blob_encrypted: 'AQID',
      schema_version: 1,
      processing_outcome: 'pending',
    });
    store.markProcessed({
      submission_id: 'sub-1',
      outcome: 'processed',
      resolved: { kind: 'booking', id: 'bk-1' },
    });

    // `null` is an INTENTION — "this resolves to nothing" — and must not spell
    // the same as omitting the key.
    store.markProcessed({ submission_id: 'sub-1', outcome: 'failed', resolved: null });

    const after = store.findById('sub-1');
    expect(after!.resolved_target_kind).toBeNull();
    expect(after!.resolved_target_id).toBeNull();
  });

  it('countWithinWindow returns rolling-window count', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    for (let i = 0; i < 3; i++) {
      store.insert({
        submission_id: `sub-${i}`,
        endpoint_id: 'ep-1',
        form_definition_id: 'fd_test',
        submitted_at: NOW + i * 1000,
        source_ip_hash: null,
        visitor_email_encrypted: null,
        submission_blob_encrypted: 'AQID',
        schema_version: 1,
        processing_outcome: 'pending',
      });
    }
    const inWindow = store.countWithinWindow({
      endpoint_id: 'ep-1',
      window_start_at: NOW,
      now: NOW + 60_000,
    });
    expect(inWindow).toBe(3);
    const empty = store.countWithinWindow({
      endpoint_id: 'ep-2',
      window_start_at: NOW,
      now: NOW + 60_000,
    });
    expect(empty).toBe(0);
  });

  it('readSourceWindowUsage isolates visitors on the same form', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    for (const [submission_id, source_ip_hash] of [
      ['sub-a-1', 'hash-a'],
      ['sub-a-2', 'hash-a'],
      ['sub-b-1', 'hash-b'],
    ] as const) {
      store.insert({
        submission_id,
        endpoint_id: 'ep-1',
        form_definition_id: 'fd_test',
        submitted_at: NOW,
        source_ip_hash,
        visitor_email_encrypted: null,
        submission_blob_encrypted: 'AQID',
        schema_version: 1,
        processing_outcome: 'pending',
      });
    }

    expect(store.readSourceWindowUsage({
      endpoint_id: 'ep-1',
      source_ip_hash: 'hash-a',
      window_start_at: NOW - 1,
      now: NOW,
    })).toEqual({ count: 2, oldest_submitted_at: NOW });
    expect(store.readSourceWindowUsage({
      endpoint_id: 'ep-1',
      source_ip_hash: 'hash-b',
      window_start_at: NOW - 1,
      now: NOW,
    })).toEqual({ count: 1, oldest_submitted_at: NOW });
  });

  it('insertIfSourceAvailable atomically refuses a source past its rolling cap', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    const input = (submission_id: string, source_ip_hash: string) => ({
      submission_id,
      endpoint_id: 'ep-1',
      form_definition_id: 'fd_test',
      submitted_at: NOW,
      source_ip_hash,
      visitor_email_encrypted: null,
      submission_blob_encrypted: 'AQID',
      schema_version: 1,
      processing_outcome: 'pending',
      max_submissions_per_window: 1,
      window_start_at: NOW - 60_000,
      now: NOW,
    });

    expect(store.insertIfSourceAvailable(input('sub-a-1', 'hash-a')))
      .toHaveProperty('row');
    expect(store.insertIfSourceAvailable(input('sub-a-2', 'hash-a')))
      .toEqual({
        conflict: 'source_rate_limit',
        retry_after_at: NOW + 60_000,
      });
    expect(store.insertIfSourceAvailable(input('sub-b-1', 'hash-b')))
      .toHaveProperty('row');
  });

  it('spam-tagged submissions are NOT returned by listPendingForEndpoint', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    store.insert({
      submission_id: 'sub-spam',
      endpoint_id: 'ep-1',
      form_definition_id: 'fd_test',
      submitted_at: NOW,
      source_ip_hash: null,
      visitor_email_encrypted: null,
      submission_blob_encrypted: 'AQID',
      schema_version: 1,
      processing_outcome: 'spam',
    });
    expect(store.listPendingForEndpoint('ep-1')).toEqual([]);
    expect(store.findById('sub-spam')!.processing_outcome).toBe('spam');
  });

  it('rejects an unknown durable processing outcome instead of minting pending eligibility', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    store.insert({
      submission_id: 'sub-corrupt-outcome',
      endpoint_id: 'ep-1',
      form_definition_id: 'fd_test',
      submitted_at: NOW,
      source_ip_hash: null,
      visitor_email_encrypted: null,
      submission_blob_encrypted: 'AQID',
      schema_version: 1,
      processing_outcome: 'pending',
    });
    db.prepare(`
      UPDATE reception_form_submission
      SET processing_outcome = 'future_or_corrupt'
      WHERE submission_id = 'sub-corrupt-outcome'
    `).run();

    expect(() => store.findById('sub-corrupt-outcome')).toThrow(
      /invalid processing outcome/,
    );
    expect(store.listPendingForEndpoint('ep-1')).toEqual([]);
  });
});
