/** An op's digest must cover everything the op's BEHAVIOUR depends on.
 *
 *  D-226 makes a pack "key the query": an aggregate op declares its own
 *  `select`, its own `filter_fields`, its own risk and approval, and a recipe
 *  just reads the result off the step. The declaration IS the contract.
 *
 *  ⛔⛔ So anything in the bind that changes what the op RETURNS has to be in
 *  the digest. `canonicalBind` is an enumerating copier — it lists the keys it
 *  hashes — and `select` was not one of them, so a pack could redefine what a
 *  granted, approved rollup computes and neither `operation_digest` nor
 *  `declaration_hash` would move. That is the same trick D-177 relies on in
 *  reverse ("drift invalidates the grant naturally, no drift detector needed"):
 *  it only works while the hash actually covers the drift.
 *
 *  ⚠ This file is deliberately shaped as "every bind key that alters behaviour
 *  moves the digest", not "select moves the digest" — the next key added to a
 *  bind should fail here if the copier forgets it. */
import { describe, expect, it } from 'vitest';
import { RECORDS_BIND_KEYS, canonicalBind, hashRecordsDeclaration } from '../records.js';
import type { RecordsAction, RecordsAuthorBinding } from '@recued/contracts';
import type { CompositionIngredient } from '../schema.js';

const composition = (bindExtra: Record<string, unknown>): CompositionIngredient => ({
  schema_version: 1,
  slug: 'probe',
  ingredients: [{
    slug: 'probe-records',
    kind: 'storage',
    entities: {
      thing: {
        fields: [
          { maps_to: 'id', field_path: 'pk', type: 'string', source_operation: 'thing.search' },
          { maps_to: 'name', field_path: 's1', type: 'string', source_operation: 'thing.search' },
          { maps_to: 'size', field_path: 'n1', type: 'number', source_operation: 'thing.search' },
          { maps_to: 'big', field_path: 'b1', type: 'boolean', source_operation: 'thing.search' },
        ],
      },
    },
  }],
  operations: [{
    op: 'thing.rollup', ingredient: 'probe-records', risk: 'read', approval: 'never',
    args: [{ key: 'filters', type: 'object' }],
    bind: { kind: 'core.records', action: 'aggregate', entity: 'thing', ...bindExtra },
  }],
} as unknown as CompositionIngredient);

const SUM = { select: { total: { fn: 'sum', field: 'size' } } };

const digests = async (bindExtra: Record<string, unknown>) => {
  const hashes = await hashRecordsDeclaration(composition(bindExtra));
  return { op: hashes.operation_digests['thing.rollup']!, declaration: hashes.declaration_hash };
};

describe('an aggregate op\'s digest covers its declared query', () => {
  it('⛔ a DIFFERENT select is a different op — the rollup definition is the contract', async () => {
    const a = await digests(SUM);
    const b = await digests({ select: { total: { fn: 'count' } } });
    expect(b.op, 'select is not covered by operation_digest').not.toBe(a.op);
    expect(b.declaration, 'select is not covered by declaration_hash').not.toBe(a.declaration);
  });

  it('⛔ changing the FIELD a select aggregates moves the digest', async () => {
    // The nastiest silent variant: same function, same output name, different
    // column. `total` would keep its name and start meaning something else.
    const a = await digests(SUM);
    const b = await digests({ select: { total: { fn: 'sum', field: 'name' } } });
    expect(b.op).not.toBe(a.op);
  });

  it('⛔ renaming an OUTPUT moves the digest — every recipe reading it breaks', async () => {
    const a = await digests(SUM);
    const b = await digests({ select: { grand_total: { fn: 'sum', field: 'size' } } });
    expect(b.op).not.toBe(a.op);
  });

  it('an unchanged select hashes identically — the digest is stable, not merely sensitive', async () => {
    // Without this the previous three would pass under a digest that changed on
    // every call, which would be useless in the other direction.
    expect((await digests(SUM)).op).toBe((await digests(SUM)).op);
    expect((await digests({ select: { total: { fn: 'sum', field: 'size' } } })).op)
      .toBe((await digests(SUM)).op);
  });

  it('filter_fields still move it, and key ORDER still does not', async () => {
    const a = await digests({ ...SUM, filter_fields: ['name', 'big'] });
    const b = await digests({ ...SUM, filter_fields: ['big', 'name'] });
    const c = await digests({ ...SUM, filter_fields: ['name'] });
    expect(b.op, 'a reordered filter list is the same declaration').toBe(a.op);
    expect(c.op, 'a narrower filter list is a different declaration').not.toBe(a.op);
  });
});

describe('⛔ group_by is part of the declaration, not a display choice', () => {
  it('adding one is a DIFFERENT op — it changes what the call returns', async () => {
    // One row -> one row per key. A grant approved for the first must not
    // silently start serving the second.
    const a = await digests(SUM);
    const b = await digests({ ...SUM, group_by: 'name' });
    expect(b.op, 'group_by is not covered by operation_digest').not.toBe(a.op);
    expect(b.declaration, 'group_by is not covered by declaration_hash').not.toBe(a.declaration);
  });

  it('a DIFFERENT key is a different op — same totals, different question', async () => {
    const a = await digests({ ...SUM, group_by: 'name' });
    const b = await digests({ ...SUM, group_by: 'big' });
    expect(b.op).not.toBe(a.op);
  });

  it('and it is stable, so the sensitivity means something', async () => {
    expect((await digests({ ...SUM, group_by: 'name' })).op)
      .toBe((await digests({ ...SUM, group_by: 'name' })).op);
  });
});

describe('⛔⛔ the copier is complete — DERIVED, so the NEXT key fails here', () => {
  /** The case-by-case tests above each caught one forgotten key AFTER it was
   *  forgotten. This compares the admissible-key list against what the copier
   *  actually emits, so a key added to a bind without being added to
   *  `canonicalBind` is a red on the same commit. */
  const SAMPLE: Record<string, unknown> = {
    kind: 'core.records', entity: 'thing',
    natural_key: ['name'], filter_fields: ['name'], sort_fields: ['size'],
    select: { total: { fn: 'sum', field: 'size' } }, group_by: 'name',
    allow: [{ entity: 'thing', action: 'create' }],
  };

  it('the sample covers every admissible key — or this sweep proves nothing', () => {
    // ⚠ Guards the probe. A key with no sample value simply would not appear in
    // the copier's output either, and the assertion below would pass while
    // observing nothing.
    for (const keys of Object.values(RECORDS_BIND_KEYS)) {
      for (const key of keys) {
        if (key === 'action') continue;      // supplied per-action below
        expect(SAMPLE, `no sample value for bind key '${key}'`).toHaveProperty(key);
      }
    }
  });

  it.each(Object.keys(RECORDS_BIND_KEYS))('%s: every admissible key is hashed', (action) => {
    const bind = { ...SAMPLE, action } as unknown as RecordsAuthorBinding;
    const hashed = Object.keys(canonicalBind(bind) as Record<string, unknown>);
    for (const key of RECORDS_BIND_KEYS[action as RecordsAction]) {
      expect(hashed, `bind key '${key}' is admissible on ${action} but never hashed`)
        .toContain(key);
    }
  });
});
