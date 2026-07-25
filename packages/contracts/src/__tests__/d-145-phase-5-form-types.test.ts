/** D-145 PA5 — form-renderer types + closed-list discipline.
 *
 *  Pin the type registry as the closed substrate input. PA5 shipped
 *  10 entries; Slice 2a (D-145 § B.11.7 follow-on) widens to 12 by
 *  adding the two composition primitives (`object` +
 *  `discriminated_union`). Adding more widens this test + the
 *  `FORM_FIELD_TYPES` array in lock-step.
 *
 *  Slice 2a — `FormFieldType` is now a SUPERSET of `CanonicalFieldType`
 *  (canonical-schemas/shape.ts stays at 10 entries because storage-
 *  backed entities are flat); the two composition primitives live on
 *  the form-renderer side only.
 */

import { describe, expect, it } from 'vitest';

import {
  FORM_FIELD_TYPES,
  isFormFieldType,
} from '../index.js';
import type {
  CanonicalFieldType,
  FormCompositionFieldType,
  FormFieldType,
} from '../index.js';

describe('D-145 PA5 — FORM_FIELD_TYPES', () => {
  it('exposes the closed PA5 + Slice 2a set in stable order', () => {
    expect(FORM_FIELD_TYPES).toEqual([
      'text',
      'textarea',
      'number',
      'boolean',
      'date',
      'timestamp',
      'enum',
      'ref',
      'array',
      'uuid',
      // Slice 2a composition primitives — trail the canonical set so
      // snapshot / printable-order consumers keep a stable prefix.
      'object',
      'discriminated_union',
    ]);
  });

  it('FormFieldType is a superset of CanonicalFieldType (assignability gate)', () => {
    // Subset → superset is assignable; superset → subset is not.
    const canonical: CanonicalFieldType = 'enum';
    const formType: FormFieldType = canonical;
    expect(formType).toBe('enum');
    // Slice 2a — composition entries are form-only.
    const composition: FormCompositionFieldType = 'object';
    const compositionForm: FormFieldType = composition;
    expect(compositionForm).toBe('object');
  });

  it('has 12 entries (10 canonical + 2 composition)', () => {
    expect(FORM_FIELD_TYPES.length).toBe(12);
  });

  it('contains the two Slice 2a composition primitives', () => {
    expect(FORM_FIELD_TYPES).toContain('object');
    expect(FORM_FIELD_TYPES).toContain('discriminated_union');
  });
});

describe('D-145 PA5 — isFormFieldType', () => {
  it('recognises every closed-list entry', () => {
    for (const t of FORM_FIELD_TYPES) {
      expect(isFormFieldType(t)).toBe(true);
    }
  });

  it('rejects values outside the registry', () => {
    expect(isFormFieldType('select')).toBe(false);
    expect(isFormFieldType('multi')).toBe(false);
    expect(isFormFieldType('secret')).toBe(false);
    expect(isFormFieldType('')).toBe(false);
    expect(isFormFieldType(undefined)).toBe(false);
    expect(isFormFieldType(null)).toBe(false);
    expect(isFormFieldType(0)).toBe(false);
  });
});
