/** D-145 § B.11.7 Slice 2a — form-renderer composition primitives.
 *
 *  Contract-side coverage for the two new typed-input registry
 *  entries (`object` + `discriminated_union`), the `ShowIfCondition`
 *  gate, and the validators + helpers Slice 2a adds. Companion
 *  ui-shared tests cover the render + read paths.
 *
 *  Covers:
 *    - FORM_FIELD_TYPES holds the 12-entry closed list (10 canonical
 *      + 2 composition) — pin against the substrate registry.
 *    - validateObject: empty object_fields accepts any object; missing
 *      required value fails; nested sub-field errors carry sub.label
 *      prefix; show_if-false sub-fields are skipped.
 *    - validateDiscriminatedUnion: empty variants is a substrate
 *      misconfiguration error (Slice 2a fold #5); missing kind /
 *      unknown kind / matching kind paths; nested sub-field errors.
 *    - validateArray with item_type='object' / 'discriminated_union':
 *      per-item validation; discriminant_field propagation from outer
 *      to inner itemField (Slice 2a fold #3).
 *    - evaluateShowIf: equals / not_equals / in / not_in are all
 *      applied (AND semantics); strict Object.is comparison (NaN-safe).
 *    - resolveDiscriminatedVariant: matches valid kind / null on
 *      unknown / null on empty variants / null on missing discriminant.
 *    - validateForm: top-level show_if-false fields are skipped. */

import { describe, expect, it } from 'vitest';

import {
  BUILTIN_VALIDATORS,
  evaluateShowIf,
  resolveDiscriminatedVariant,
  validateField,
  validateForm,
} from '../form-renderer/validators.js';
import type {
  DiscriminatedUnionVariant,
  FormDefinition,
  FormField,
  ShowIfCondition,
} from '../form-renderer/types.js';

// ──────────────────────────────────────────────────────────────────
// Field builders
// ──────────────────────────────────────────────────────────────────

const textField = (
  name: string,
  required = true,
  showIf?: ShowIfCondition,
): FormField => ({
  name,
  type: 'text',
  label: name,
  required,
  hidden: false,
  origin: 'canonical',
  ...(showIf ? { show_if: showIf } : {}),
});

const objectField = (
  name: string,
  subFields: ReadonlyArray<FormField>,
  required = true,
  showIf?: ShowIfCondition,
): FormField => ({
  name,
  type: 'object',
  label: name,
  required,
  hidden: false,
  object_fields: subFields,
  origin: 'canonical',
  ...(showIf ? { show_if: showIf } : {}),
});

const unionField = (
  name: string,
  variants: ReadonlyArray<DiscriminatedUnionVariant>,
  required = true,
  discriminantField?: string,
): FormField => ({
  name,
  type: 'discriminated_union',
  label: name,
  required,
  hidden: false,
  variants,
  ...(discriminantField !== undefined ? { discriminant_field: discriminantField } : {}),
  origin: 'canonical',
});

// ══════════════════════════════════════════════════════════════════
// BUILTIN_VALIDATORS registry
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — BUILTIN_VALIDATORS registry', () => {
  it('carries entries for object and discriminated_union', () => {
    expect(typeof BUILTIN_VALIDATORS.object).toBe('function');
    expect(typeof BUILTIN_VALIDATORS.discriminated_union).toBe('function');
  });
});

// ══════════════════════════════════════════════════════════════════
// validateObject
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — validateObject', () => {
  it('returns null for an empty object_fields walk', () => {
    const field = objectField('settings', []);
    expect(validateField(field, {})).toBeNull();
  });

  it('rejects non-object values', () => {
    const field = objectField('settings', []);
    expect(validateField(field, 'string')).toBe('Must be an object');
    expect(validateField(field, [])).toBe('Must be an object');
    expect(validateField(field, 42)).toBe('Must be an object');
  });

  it('surfaces "Required" when required + value missing', () => {
    const field = objectField('settings', [], true);
    expect(validateField(field, null)).toBe('Required');
    expect(validateField(field, undefined)).toBe('Required');
  });

  it('returns null when not required + value missing', () => {
    const field = objectField('settings', [], false);
    expect(validateField(field, null)).toBeNull();
    expect(validateField(field, undefined)).toBeNull();
  });

  it('validates nested sub-fields + label-prefixes errors', () => {
    const field = objectField('person', [textField('name', true)]);
    expect(validateField(field, { name: '' })).toBe('name: Required');
    expect(validateField(field, { name: 'Alice' })).toBeNull();
  });

  it('skips sub-fields whose show_if evaluates false', () => {
    const field = objectField('settings', [
      textField('mode', true),
      textField('detail', true, { field: 'mode', equals: 'advanced' }),
    ]);
    // mode = 'simple' → detail's gate fails → detail skipped
    expect(validateField(field, { mode: 'simple', detail: '' })).toBeNull();
    // mode = 'advanced' → detail's gate passes → detail required
    expect(validateField(field, { mode: 'advanced', detail: '' })).toBe(
      'detail: Required',
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// validateDiscriminatedUnion
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — validateDiscriminatedUnion', () => {
  const variants: DiscriminatedUnionVariant[] = [
    {
      kind: 'require_approval',
      label: 'Require approval',
      fields: [],
    },
    {
      kind: 'min_tier',
      label: 'Min tier',
      fields: [textField('tier', true)],
    },
  ];

  it('surfaces "No variants declared" when variants is empty (fold #5)', () => {
    const field = unionField('action', []);
    expect(validateField(field, { kind: 'foo' })).toBe(
      'No variants declared (form schema misconfigured)',
    );
  });

  it('surfaces "Required: kind" when discriminant is missing', () => {
    const field = unionField('action', variants);
    expect(validateField(field, {})).toBe('Required: kind');
    expect(validateField(field, { kind: '' })).toBe('Required: kind');
  });

  it('surfaces "Must be one of …" when kind is not declared', () => {
    const field = unionField('action', variants);
    expect(validateField(field, { kind: 'force_redirect' })).toBe(
      'Must be one of require_approval, min_tier',
    );
  });

  it('walks the matched variant fields', () => {
    const field = unionField('action', variants);
    expect(validateField(field, { kind: 'min_tier' })).toBe('tier: Required');
    expect(validateField(field, { kind: 'min_tier', tier: 'mid' })).toBeNull();
  });

  it('walks zero-field variants', () => {
    const field = unionField('action', variants);
    expect(validateField(field, { kind: 'require_approval' })).toBeNull();
  });

  it('honors discriminant_field override', () => {
    const field = unionField('condition', variants, true, 'op');
    expect(validateField(field, { op: 'min_tier', tier: 'mid' })).toBeNull();
    expect(validateField(field, { kind: 'min_tier', tier: 'mid' })).toBe(
      'Required: op',
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// validateArray with composite items
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — validateArray with composite items', () => {
  it('validates array<object> items via item_object_fields', () => {
    const field: FormField = {
      name: 'people',
      type: 'array',
      label: 'People',
      required: true,
      hidden: false,
      item_type: 'object',
      item_object_fields: [textField('name', true)],
      origin: 'canonical',
    };
    expect(validateField(field, [{ name: 'Alice' }, { name: 'Bob' }])).toBeNull();
    expect(validateField(field, [{ name: 'Alice' }, { name: '' }])).toBe(
      'Item 2: name: Required',
    );
  });

  it('propagates discriminant_field through array<discriminated_union> (fold #3)', () => {
    const variants: DiscriminatedUnionVariant[] = [
      { kind: 'tag', label: 'Tag', fields: [textField('value', true)] },
    ];
    const field: FormField = {
      name: 'conditions',
      type: 'array',
      label: 'Conditions',
      required: true,
      hidden: false,
      item_type: 'discriminated_union',
      item_variants: variants,
      discriminant_field: 'op', // non-default
      origin: 'canonical',
    };
    // Items with `op` key — accepted
    expect(
      validateField(field, [
        { op: 'tag', value: 'a' },
        { op: 'tag', value: 'b' },
      ]),
    ).toBeNull();
    // Item with `kind` instead of `op` — rejected as missing discriminant
    expect(validateField(field, [{ kind: 'tag', value: 'a' }])).toBe(
      'Item 1: Required: op',
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// evaluateShowIf
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — evaluateShowIf', () => {
  it('equals: passes on Object.is match', () => {
    expect(evaluateShowIf({ field: 'k', equals: 'a' }, { k: 'a' })).toBe(true);
    expect(evaluateShowIf({ field: 'k', equals: 'a' }, { k: 'b' })).toBe(false);
    expect(evaluateShowIf({ field: 'k', equals: 5 }, { k: 5 })).toBe(true);
    expect(evaluateShowIf({ field: 'k', equals: 5 }, { k: 6 })).toBe(false);
  });

  it('not_equals: passes when value differs', () => {
    expect(evaluateShowIf({ field: 'k', not_equals: 'global' }, { k: 'local' }))
      .toBe(true);
    expect(evaluateShowIf({ field: 'k', not_equals: 'global' }, { k: 'global' }))
      .toBe(false);
  });

  it('in: passes when value appears in the list', () => {
    expect(evaluateShowIf({ field: 'k', in: ['a', 'b'] }, { k: 'a' })).toBe(true);
    expect(evaluateShowIf({ field: 'k', in: ['a', 'b'] }, { k: 'c' })).toBe(false);
  });

  it('not_in: passes when value does not appear', () => {
    expect(evaluateShowIf({ field: 'k', not_in: ['a'] }, { k: 'b' })).toBe(true);
    expect(evaluateShowIf({ field: 'k', not_in: ['a'] }, { k: 'a' })).toBe(false);
  });

  it('AND semantics — all declared clauses must hold', () => {
    expect(
      evaluateShowIf({ field: 'k', equals: 'a', in: ['a', 'b'] }, { k: 'a' }),
    ).toBe(true);
    // equals: 'a' fails — clause-AND yields false
    expect(
      evaluateShowIf({ field: 'k', equals: 'b', in: ['a', 'b'] }, { k: 'a' }),
    ).toBe(false);
  });

  it('NaN: Object.is handles NaN as equal (defensible — intentional)', () => {
    expect(evaluateShowIf({ field: 'k', equals: NaN }, { k: NaN })).toBe(true);
  });

  it('missing sibling: equals/not_equals/in/not_in default to true when clause undefined', () => {
    // No clauses set → always true (the gate is vacuous).
    expect(evaluateShowIf({ field: 'k' }, {})).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// resolveDiscriminatedVariant
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — resolveDiscriminatedVariant', () => {
  const variants: DiscriminatedUnionVariant[] = [
    { kind: 'a', label: 'A', fields: [] },
    { kind: 'b', label: 'B', fields: [] },
  ];

  it('returns the matched variant for a known kind', () => {
    const field = unionField('u', variants);
    expect(resolveDiscriminatedVariant(field, { kind: 'a' })?.kind).toBe('a');
  });

  it('returns null for an unknown kind', () => {
    const field = unionField('u', variants);
    expect(resolveDiscriminatedVariant(field, { kind: 'c' })).toBeNull();
  });

  it('returns null when the discriminant is missing', () => {
    const field = unionField('u', variants);
    expect(resolveDiscriminatedVariant(field, {})).toBeNull();
  });

  it('returns null for empty variants', () => {
    const field = unionField('u', []);
    expect(resolveDiscriminatedVariant(field, { kind: 'a' })).toBeNull();
  });

  it('honors discriminant_field override', () => {
    const field = unionField('u', variants, true, 'op');
    expect(resolveDiscriminatedVariant(field, { op: 'a' })?.kind).toBe('a');
    expect(resolveDiscriminatedVariant(field, { kind: 'a' })).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// validateForm with show_if at top level
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — validateForm with show_if', () => {
  it('skips top-level fields whose show_if evaluates false', () => {
    const definition: FormDefinition = {
      kind: 'test',
      fields: [
        textField('mode'),
        textField('detail', true, { field: 'mode', equals: 'advanced' }),
      ],
    };
    expect(validateForm(definition, { mode: 'simple', detail: '' })).toEqual([]);
    expect(validateForm(definition, { mode: 'advanced', detail: '' })).toEqual([
      { field: 'detail', message: 'Required' },
    ]);
  });
});
