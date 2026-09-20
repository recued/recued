/** The `import` arg envelope after `csv_ref` joined it.
 *
 *  ⛔⛔ THE ENVELOPE CANNOT SAY "ONE OF", AND THAT GAP IS THE POINT OF THIS FILE.
 *  `validateArgEnvelope` compares a declaration against a fixed table: every
 *  table key must be declared, each with a matching type/required/affects_target
 *  triple. There is no way to express "exactly one of `csv` / `csv_ref`", so both
 *  are declared OPTIONAL and the real check lives at dispatch in
 *  `resolveRecordsImportCsvRef`. The declaration is deliberately WIDER than the
 *  runtime.
 *
 *  ⚠ THAT MAKES TWO PROPERTIES EASY TO BREAK SILENTLY, so both are pinned here:
 *  marking either arg `required` again would refuse every call that uses the
 *  OTHER one at authoring time — and it would look like tightening.
 *
 *  ⚠ AND ADDING A TABLE KEY IS A BREAKING AUTHORING CHANGE, which is the other
 *  thing this file records. Any records pack declaring an `import` op must now
 *  declare `csv_ref` too, or it fails `validatePack` with `records_arg_missing`.
 *  Every shipped pack was updated with the table; a pack authored against the
 *  old envelope will not install until it is.
 */
import { describe, expect, it } from 'vitest';

import { validateComposition } from '../validators.js';

/** One `import` operation carrying exactly `args` — nothing else varies. */
const importWith = (args: unknown[]) => ({
  schema_version: 1,
  slug: 'probe',
  ingredients: [{
    slug: 'probe-records',
    kind: 'storage',
    entities: {
      thing: {
        fields: [
          { maps_to: 'id', field_path: 'pk', type: 'string', source_operation: 'thing.get' },
          { maps_to: 'name', field_path: 's1', type: 'string', source_operation: 'thing.get' },
        ],
      },
    },
  }],
  // ⚠ The `get` is here only so the entity's `source_operation` resolves — a
  // field must name a real read. Without it the composition carries
  // `records_source_operation` errors that have nothing to do with this file's
  // subject, and the full-envelope case could only be asserted weakly.
  operations: [{
    op: 'thing.get', ingredient: 'probe-records', risk: 'read', approval: 'never',
    args: [{ key: 'id', type: 'string', required: true, affects_target: true }],
    bind: { kind: 'core.records', action: 'get', entity: 'thing' },
  }, {
    op: 'thing.import', ingredient: 'probe-records', risk: 'write', approval: 'ask',
    args, bind: { kind: 'core.records', action: 'import', entity: 'thing' },
  }],
});

const errorsFor = (body: unknown) =>
  validateComposition(body).issues.filter((i) => i.severity === 'error').map((i) => i.code);

const CSV = { key: 'csv', type: 'string' };
const CSV_REF = { key: 'csv_ref', type: 'object' };
const SPEC = { key: 'spec', type: 'object', required: true };
const DRY_RUN = { key: 'dry_run', type: 'boolean' };

describe('records import — the csv / csv_ref arg envelope', () => {
  it('admits the full envelope with both routes declared optional', () => {
    expect(errorsFor(importWith([CSV, CSV_REF, SPEC, DRY_RUN]))).toEqual([]);
  });

  it('⚠ requires csv_ref to be DECLARED — the old three-arg shape no longer validates', () => {
    // The breaking half. A pack written against the pre-`csv_ref` envelope trips
    // here rather than at install, which is where an author can still act on it.
    expect(errorsFor(importWith([CSV, SPEC, DRY_RUN]))).toContain('records_arg_missing');
  });

  it('⛔ refuses csv marked required — that would refuse every csv_ref call', () => {
    expect(errorsFor(importWith([{ ...CSV, required: true }, CSV_REF, SPEC, DRY_RUN])))
      .toContain('records_arg_mismatch');
  });

  it('⛔ refuses csv_ref marked required — that would refuse every text call', () => {
    expect(errorsFor(importWith([CSV, { ...CSV_REF, required: true }, SPEC, DRY_RUN])))
      .toContain('records_arg_mismatch');
  });

  it("🔑 refuses csv_ref typed 'file_ref' — that type means the DURABLE ref this op rejects", () => {
    // `file_ref` is the `input_materialize` / `upload` arg type and what a Kitchen
    // file picker fills from the owner's inventory. Declaring it here would
    // advertise a picker whose every value fails at dispatch.
    expect(errorsFor(importWith([CSV, { key: 'csv_ref', type: 'file_ref' }, SPEC, DRY_RUN])))
      .toContain('records_arg_mismatch');
  });

  it('still refuses an arg the table does not name — widening did not open the envelope', () => {
    expect(errorsFor(importWith([CSV, CSV_REF, SPEC, DRY_RUN, { key: 'entity', type: 'string' }])))
      .toContain('records_arg_extra');
  });
});
