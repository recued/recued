/** D-119 Phase 12 — Canonical record preservation tests for transforms.
 *
 *  Validates that `pick` / `omit` / `map.expression` keep `_id` +
 *  `_collection` on projected records by default, and that authors
 *  can still strip them via an explicit `omit` list. */

import { describe, it, expect } from 'vitest';
import { pick, omit } from '../object.js';
import { map } from '../collection.js';
import { ctx } from './helpers.js';

const c = ctx();

const mailItem = {
  _id: 'msg-42',
  _collection: 'mail',
  subject: 'Q3 review',
  from: 'a@b.co',
  body_inline: 'Please review.',
};

describe('pick — canonical preservation', () => {
  it('preserves _id and _collection by default when not in fields list', () => {
    const out = pick({ source: mailItem, fields: ['subject'] }, c) as Record<string, unknown>;
    expect(out).toEqual({
      _id: 'msg-42',
      _collection: 'mail',
      subject: 'Q3 review',
    });
  });

  it('does not duplicate when system fields are in the fields list', () => {
    const out = pick({ source: mailItem, fields: ['_id', 'subject'] }, c) as Record<string, unknown>;
    // Both fields-list pickup AND auto-preservation route to the
    // same key; result should still hold the source value once.
    expect(out._id).toBe('msg-42');
    expect(out._collection).toBe('mail');
    expect(out.subject).toBe('Q3 review');
    expect(Object.keys(out).sort()).toEqual(['_collection', '_id', 'subject']);
  });

  it('does not invent _* fields when source lacks them', () => {
    const plain = { subject: 'no-canonical' };
    const out = pick({ source: plain, fields: ['subject'] }, c) as Record<string, unknown>;
    expect(out).toEqual({ subject: 'no-canonical' });
    expect('_id' in out).toBe(false);
    expect('_collection' in out).toBe(false);
  });
});

describe('omit — canonical preservation', () => {
  it('preserves _id and _collection by default when not listed', () => {
    const out = omit({ source: mailItem, fields: ['from'] }, c) as Record<string, unknown>;
    expect(out._id).toBe('msg-42');
    expect(out._collection).toBe('mail');
    expect('from' in out).toBe(false);
  });

  it('strips _id when explicitly listed (escape hatch for authors)', () => {
    // Mongo / CouchDB convention: explicit opt-out always wins.
    const out = omit({ source: mailItem, fields: ['_id'] }, c) as Record<string, unknown>;
    expect('_id' in out).toBe(false);
    // _collection still preserved — only _id was listed.
    expect(out._collection).toBe('mail');
  });

  it('strips both system fields when both are listed', () => {
    const out = omit({ source: mailItem, fields: ['_id', '_collection'] }, c) as Record<string, unknown>;
    expect('_id' in out).toBe(false);
    expect('_collection' in out).toBe(false);
    expect(out.subject).toBe('Q3 review');
  });
});

describe('map.expression — canonical preservation', () => {
  it('object-template projection preserves source _id and _collection', () => {
    const out = map(
      {
        array: [mailItem],
        expression: { headline: '{{item.subject}}', sender: '{{item.from}}' },
      },
      c,
    ) as Record<string, unknown>[];
    expect(out).toHaveLength(1);
    expect(out[0]._id).toBe('msg-42');
    expect(out[0]._collection).toBe('mail');
    expect(out[0].headline).toBe('Q3 review');
    expect(out[0].sender).toBe('a@b.co');
  });

  it('author-supplied _id in template wins over source', () => {
    const out = map(
      {
        array: [mailItem],
        expression: { _id: 'override', _collection: 'shared', summary: '{{item.subject}}' },
      },
      c,
    ) as Record<string, unknown>[];
    // Template values are authoritative. Preservation only fills gaps.
    expect(out[0]._id).toBe('override');
    expect(out[0]._collection).toBe('shared');
    expect(out[0].summary).toBe('Q3 review');
  });

  it('pure-ref projection (returns scalar) deliberately leaves canonical realm', () => {
    // `{{item.subject}}` returns a string. The canonical pair would
    // have nowhere to live; per spec, scalar projections aren't
    // record projections — that's fine.
    const out = map(
      { array: [mailItem], expression: '{{item.subject}}' },
      c,
    );
    expect(out).toEqual(['Q3 review']);
  });

  it('output_field mode (spread on item) preserves canonical via spread', () => {
    const out = map(
      {
        array: [mailItem],
        expression: '{{item.subject}}',
        output_field: 'computed_title',
      },
      c,
    ) as Record<string, unknown>[];
    expect(out[0]._id).toBe('msg-42');
    expect(out[0]._collection).toBe('mail');
    expect(out[0].subject).toBe('Q3 review');
    expect(out[0].computed_title).toBe('Q3 review');
  });

  it('items without canonical fields project cleanly (no invention)', () => {
    const plain = { name: 'no-canonical', amount: 10 };
    const out = map(
      { array: [plain], expression: { label: '{{item.name}}' } },
      c,
    ) as Record<string, unknown>[];
    expect(out[0]).toEqual({ label: 'no-canonical' });
    expect('_id' in out[0]).toBe(false);
  });
});
