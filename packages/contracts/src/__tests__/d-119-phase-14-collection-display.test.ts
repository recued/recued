/** D-119 Phase 14 — collection display schema (Warehouse explorer).
 *
 *  Covers:
 *    - Registry shape: every canonical collection has a schema.
 *    - `isCanonicalCollection` narrows known names + rejects unknown.
 *    - `getCollectionDisplaySchema` happy / unknown / falsy paths.
 *    - `readDisplayField` reads top level then falls back to
 *      `hot_fields` (Phase D `CollectionRecord` shape).
 *    - Schema field shapes are usable: every primary / summary
 *      field is a non-empty string. */

import { describe, it, expect } from 'vitest';
import {
  COLLECTION_DISPLAY_SCHEMAS,
  isCanonicalCollection,
  getCollectionDisplaySchema,
  readDisplayField,
  type CanonicalCollectionName,
  type CollectionDisplaySchema,
} from '../index.js';

const ALL_CANONICAL_NAMES: CanonicalCollectionName[] = [
  'mail',
  'calendar',
  'file',
  'webhook',
  'service',
  'shared',
  'annotation',
  'link',
  'contact',
  // D-145 PA3 — work-entity collections.
  'task',
  'note',
  'commitment',
  'project',
  // D-210 — booking.
  'booking',
  'form_response',
];

describe('COLLECTION_DISPLAY_SCHEMAS', () => {
  it('covers every canonical collection name exactly once', () => {
    expect(Object.keys(COLLECTION_DISPLAY_SCHEMAS).sort()).toEqual(
      [...ALL_CANONICAL_NAMES].sort(),
    );
  });

  it('every schema has a non-empty primary_field', () => {
    for (const name of ALL_CANONICAL_NAMES) {
      const schema = COLLECTION_DISPLAY_SCHEMAS[name];
      expect(typeof schema.primary_field).toBe('string');
      expect(schema.primary_field.length).toBeGreaterThan(0);
    }
  });

  it('every schema has a non-empty summary_fields array (≤4 entries)', () => {
    for (const name of ALL_CANONICAL_NAMES) {
      const schema = COLLECTION_DISPLAY_SCHEMAS[name];
      expect(Array.isArray(schema.summary_fields)).toBe(true);
      expect(schema.summary_fields.length).toBeGreaterThan(0);
      // Sidebar column is narrow — keep summary lists short.
      expect(schema.summary_fields.length).toBeLessThanOrEqual(4);
      for (const field of schema.summary_fields) {
        expect(typeof field).toBe('string');
        expect(field.length).toBeGreaterThan(0);
      }
    }
  });

  it('detail_renderer when present is a known kind', () => {
    const known = new Set(['mail', 'calendar', 'file', 'json']);
    for (const name of ALL_CANONICAL_NAMES) {
      const schema = COLLECTION_DISPLAY_SCHEMAS[name];
      if (schema.detail_renderer) {
        expect(known.has(schema.detail_renderer)).toBe(true);
      }
    }
  });

  it('mail / calendar / file pin domain renderers', () => {
    expect(COLLECTION_DISPLAY_SCHEMAS.mail.detail_renderer).toBe('mail');
    expect(COLLECTION_DISPLAY_SCHEMAS.calendar.detail_renderer).toBe('calendar');
    expect(COLLECTION_DISPLAY_SCHEMAS.file.detail_renderer).toBe('file');
  });

  it('mail summary shows from + received_at, primary subject', () => {
    expect(COLLECTION_DISPLAY_SCHEMAS.mail.primary_field).toBe('subject');
    expect(COLLECTION_DISPLAY_SCHEMAS.mail.summary_fields).toContain('from');
    expect(COLLECTION_DISPLAY_SCHEMAS.mail.summary_fields).toContain('received_at');
  });

  it('calendar primary is summary, summary fields cover when + where', () => {
    const cal = COLLECTION_DISPLAY_SCHEMAS.calendar;
    expect(cal.primary_field).toBe('summary');
    expect(cal.summary_fields).toContain('start_at');
    expect(cal.summary_fields).toContain('end_at');
    expect(cal.summary_fields).toContain('location');
  });

  it('annotation primary is the annotation key', () => {
    expect(COLLECTION_DISPLAY_SCHEMAS.annotation.primary_field).toBe('key');
    expect(COLLECTION_DISPLAY_SCHEMAS.annotation.summary_fields).toContain(
      'target_collection',
    );
    expect(COLLECTION_DISPLAY_SCHEMAS.annotation.summary_fields).toContain('target_id');
  });

  it('link primary is the relationship role', () => {
    expect(COLLECTION_DISPLAY_SCHEMAS.link.primary_field).toBe('role');
    expect(COLLECTION_DISPLAY_SCHEMAS.link.summary_fields).toContain(
      'from_collection',
    );
    expect(COLLECTION_DISPLAY_SCHEMAS.link.summary_fields).toContain('to_collection');
  });

  it('form responses browse by definition with acceptance timing', () => {
    const form = COLLECTION_DISPLAY_SCHEMAS.form_response;
    expect(form.primary_field).toBe('form_definition_id');
    expect(form.summary_fields).toContain('submitted_at');
    expect(form.summary_fields).toContain('accepted_at');
  });

  it('registry is frozen — runtime mutations are no-ops', () => {
    expect(Object.isFrozen(COLLECTION_DISPLAY_SCHEMAS)).toBe(true);
    // Best-effort runtime check that the renderer can't accidentally
    // mutate a baseline schema. Type system already disallows this,
    // but the freeze is the runtime backstop.
    const before = COLLECTION_DISPLAY_SCHEMAS.mail.primary_field;
    try {
      (COLLECTION_DISPLAY_SCHEMAS as unknown as Record<string, CollectionDisplaySchema>)[
        'mail'
      ] = {
        primary_field: 'pwned',
        summary_fields: ['x'],
      };
    } catch {
      /* strict mode throws — frozen object */
    }
    expect(COLLECTION_DISPLAY_SCHEMAS.mail.primary_field).toBe(before);
  });
});

describe('isCanonicalCollection', () => {
  it('accepts every canonical collection name', () => {
    for (const name of ALL_CANONICAL_NAMES) {
      expect(isCanonicalCollection(name)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isCanonicalCollection('unknown')).toBe(false);
    expect(isCanonicalCollection('')).toBe(false);
    expect(isCanonicalCollection('Mail')).toBe(false); // case-sensitive
    expect(isCanonicalCollection('data.mail')).toBe(false); // not the dotted ref
  });
});

describe('getCollectionDisplaySchema', () => {
  it('returns the schema for a known collection', () => {
    const schema = getCollectionDisplaySchema('mail');
    expect(schema).not.toBeNull();
    expect(schema?.primary_field).toBe('subject');
  });

  it('returns null for unknown collections', () => {
    expect(getCollectionDisplaySchema('unknown')).toBeNull();
    expect(getCollectionDisplaySchema('')).toBeNull();
  });
});

describe('readDisplayField', () => {
  it('reads a top-level field directly', () => {
    const record = { _id: 'a', _collection: 'calendar', summary: 'Sync 1:1' };
    expect(readDisplayField(record, 'summary')).toBe('Sync 1:1');
  });

  it('falls back to hot_fields when the top-level key is missing', () => {
    const record = {
      record_id: 'msg-1',
      received_at: 1000,
      hot_fields: { from: 'a@b.com', subject: 'hi' },
    };
    expect(readDisplayField(record, 'subject')).toBe('hi');
    expect(readDisplayField(record, 'from')).toBe('a@b.com');
  });

  it('top-level shadows hot_fields when both have the same key', () => {
    const record = {
      from: 'top@x',
      hot_fields: { from: 'hot@x' },
    };
    expect(readDisplayField(record, 'from')).toBe('top@x');
  });

  it('returns undefined for missing fields on both sides', () => {
    const record = { hot_fields: { from: 'x@y' } };
    expect(readDisplayField(record, 'subject')).toBeUndefined();
  });

  it('handles a record with no hot_fields gracefully', () => {
    const record = { _id: '1', _collection: 'shared', key: 'k', value: 'v' };
    expect(readDisplayField(record, 'value')).toBe('v');
    expect(readDisplayField(record, 'missing')).toBeUndefined();
  });

  it('returns undefined when record is null / undefined', () => {
    expect(readDisplayField(null, 'subject')).toBeUndefined();
    expect(readDisplayField(undefined, 'subject')).toBeUndefined();
  });

  it('ignores non-object hot_fields', () => {
    const record = { hot_fields: 'not-an-object' };
    expect(readDisplayField(record, 'subject')).toBeUndefined();
  });

  it('ignores array hot_fields (defensive)', () => {
    const record = { hot_fields: ['x'] };
    expect(readDisplayField(record, '0')).toBeUndefined();
  });

  it('reads numeric values (received_at, size_bytes)', () => {
    const record = { received_at: 1700000000, hot_fields: { size: 4096 } };
    expect(readDisplayField(record, 'received_at')).toBe(1700000000);
    expect(readDisplayField(record, 'size')).toBe(4096);
  });

  it('reads boolean values (is_read)', () => {
    const record = { hot_fields: { is_read: false } };
    expect(readDisplayField(record, 'is_read')).toBe(false);
  });
});
