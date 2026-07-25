/** D-119 Phase 12 — Canonical record system fields tests.
 *
 *  Covers the helpers exported from `canonical-record.ts`:
 *  field-name list integrity, system-field type guard, ref extraction
 *  from canonical records, and idempotent stamping. */

import { describe, expect, it } from 'vitest';
import {
  CANONICAL_SYSTEM_FIELDS,
  isCanonicalSystemField,
  extractCanonicalRef,
  stampCanonicalFields,
  type CanonicalRecord,
} from '../canonical-record.js';

describe('CANONICAL_SYSTEM_FIELDS', () => {
  it('lists exactly _id and _collection in stable order', () => {
    // Order matters for transform preservation logic — keep it
    // pinned so an accidental reorder shows up as a test failure.
    expect(CANONICAL_SYSTEM_FIELDS).toEqual(['_id', '_collection']);
  });
});

describe('isCanonicalSystemField', () => {
  it('returns true for the system field names', () => {
    expect(isCanonicalSystemField('_id')).toBe(true);
    expect(isCanonicalSystemField('_collection')).toBe(true);
  });

  it('returns false for any other key, including underscored ones', () => {
    expect(isCanonicalSystemField('id')).toBe(false);
    expect(isCanonicalSystemField('collection')).toBe(false);
    expect(isCanonicalSystemField('_other')).toBe(false);
    expect(isCanonicalSystemField('')).toBe(false);
  });
});

describe('extractCanonicalRef', () => {
  it('returns { collection, id } for a canonical record', () => {
    const rec: CanonicalRecord = { _id: 'abc', _collection: 'mail' };
    expect(extractCanonicalRef(rec)).toEqual({ collection: 'mail', id: 'abc' });
  });

  it('preserves the original keys when the record carries extra fields', () => {
    const rec = { _id: 'evt-1', _collection: 'calendar', summary: 'Meeting' };
    expect(extractCanonicalRef(rec)).toEqual({ collection: 'calendar', id: 'evt-1' });
  });

  it('returns null for non-objects', () => {
    expect(extractCanonicalRef(null)).toBeNull();
    expect(extractCanonicalRef(undefined)).toBeNull();
    expect(extractCanonicalRef('string')).toBeNull();
    expect(extractCanonicalRef(42)).toBeNull();
    expect(extractCanonicalRef(true)).toBeNull();
  });

  it('returns null when _id or _collection is missing or non-string', () => {
    expect(extractCanonicalRef({})).toBeNull();
    expect(extractCanonicalRef({ _id: 'x' })).toBeNull();
    expect(extractCanonicalRef({ _collection: 'mail' })).toBeNull();
    expect(extractCanonicalRef({ _id: 42, _collection: 'mail' })).toBeNull();
    expect(extractCanonicalRef({ _id: 'x', _collection: null })).toBeNull();
  });
});

describe('stampCanonicalFields', () => {
  it('adds _id and _collection to a record that lacks them', () => {
    const rec = { record_id: 'msg-42', subject: 'Hello' };
    const stamped = stampCanonicalFields(rec, 'mail', 'msg-42');
    expect(stamped._id).toBe('msg-42');
    expect(stamped._collection).toBe('mail');
    // Original fields preserved.
    expect(stamped.record_id).toBe('msg-42');
    expect(stamped.subject).toBe('Hello');
  });

  it('is idempotent — re-stamping with different args leaves existing fields untouched', () => {
    // Adapter-side ids are authoritative. If a downstream wrapper
    // re-stamps, the existing values must win so the record stays
    // self-consistent.
    const rec = { _id: 'authoritative', _collection: 'mail' as const, body: 'x' };
    const stamped = stampCanonicalFields(rec, 'calendar', 'wrong-id');
    expect(stamped._id).toBe('authoritative');
    expect(stamped._collection).toBe('mail');
  });

  it('does not mutate the input record', () => {
    const rec = { record_id: 'r1' };
    const stamped = stampCanonicalFields(rec, 'file', 'r1');
    expect(rec).not.toHaveProperty('_id');
    expect(rec).not.toHaveProperty('_collection');
    expect(stamped._id).toBe('r1');
  });

  it('extracts cleanly via extractCanonicalRef after stamping', () => {
    const stamped = stampCanonicalFields({ summary: 'Q3 review' }, 'calendar', 'uid-123');
    expect(extractCanonicalRef(stamped)).toEqual({ collection: 'calendar', id: 'uid-123' });
  });

  it('round-trips every canonical collection name', () => {
    const collections = ['mail', 'calendar', 'file', 'webhook', 'service', 'shared'] as const;
    for (const col of collections) {
      const stamped = stampCanonicalFields({ x: 1 }, col, `id-${col}`);
      expect(stamped._collection).toBe(col);
      expect(stamped._id).toBe(`id-${col}`);
    }
  });
});
