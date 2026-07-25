/** D-145 PB10 - nested hook propagation ratchets.
 *
 *  - Slice 2a composition coverage originally pinned shape recursion, but
 *    left nested substrate-external validation hooks under-covered.
 *  - PB10 widens FieldValidator so composite validators can receive
 *    ValidationHooks without breaking scalar validators.
 *  - validateObject, validateDiscriminatedUnion, and validateArray must pass
 *    hooks through every internal validateField recursion.
 *  - array<ref> must fire via per-item recursion only, avoiding the deleted
 *    top-level array<ref> double-dispatch path.
 *  - Nested ref failures must preserve existing label and item-prefix error
 *    formatting so callers keep stable messages.
 *  - Missing hooks and hooks that return success must remain no-error paths.
 */

import { describe, expect, it } from 'vitest';

import {
  BUILTIN_VALIDATORS,
  validateField,
  validateForm,
} from '../form-renderer/validators.js';
import type {
  DiscriminatedUnionVariant,
  FormDefinition,
  FormField,
  ShowIfCondition,
  ValidationHooks,
} from '../form-renderer/types.js';

type RefCall = {
  target: string;
  id: unknown;
};

type RecordingHooks = {
  hooks: ValidationHooks;
  calls: RefCall[];
};

type ArrayFieldOptions = {
  required?: boolean;
  label?: string;
  showIf?: ShowIfCondition;
  itemEnumValues?: readonly string[];
  itemObjectFields?: readonly FormField[];
  itemVariants?: readonly DiscriminatedUnionVariant[];
  discriminantField?: string;
  refTarget?: string;
};

const textField = (
  name: string,
  required = true,
  showIf?: ShowIfCondition,
  label = name,
): FormField => ({
  name,
  type: 'text',
  label,
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
  label = name,
): FormField => ({
  name,
  type: 'object',
  label,
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
  label = name,
): FormField => ({
  name,
  type: 'discriminated_union',
  label,
  required,
  hidden: false,
  variants,
  ...(discriminantField !== undefined
    ? { discriminant_field: discriminantField }
    : {}),
  origin: 'canonical',
});

const refField = (
  name: string,
  target: string,
  required = true,
  showIf?: ShowIfCondition,
  label = name,
): FormField => ({
  name,
  type: 'ref',
  label,
  required,
  hidden: false,
  ref_target: target,
  origin: 'canonical',
  ...(showIf ? { show_if: showIf } : {}),
});

const arrayField = (
  name: string,
  itemType: FormField['type'],
  options: ArrayFieldOptions = {},
): FormField => ({
  name,
  type: 'array',
  label: options.label ?? name,
  required: options.required ?? true,
  hidden: false,
  item_type: itemType,
  origin: 'canonical',
  ...(options.showIf ? { show_if: options.showIf } : {}),
  ...(options.itemEnumValues !== undefined
    ? { item_enum_values: options.itemEnumValues }
    : {}),
  ...(options.itemObjectFields !== undefined
    ? { item_object_fields: options.itemObjectFields }
    : {}),
  ...(options.itemVariants !== undefined
    ? { item_variants: options.itemVariants }
    : {}),
  ...(options.discriminantField !== undefined
    ? { discriminant_field: options.discriminantField }
    : {}),
  ...(options.refTarget !== undefined ? { ref_target: options.refTarget } : {}),
});

const formDefinition = (
  fields: ReadonlyArray<FormField>,
  kind = 'd-145-pb10-hooks',
): FormDefinition => ({
  kind,
  fields,
});

const recordingHooks = (
  exists: boolean | ((target: string, id: unknown) => boolean) = true,
): RecordingHooks => {
  const calls: RefCall[] = [];
  const hooks: ValidationHooks = {
    ref_exists: (target, id) => {
      calls.push({ target, id });
      return typeof exists === 'function' ? exists(target, id) : exists;
    },
  };
  return { hooks, calls };
};

const contactRef = (name = 'owner', label = 'Owner'): FormField =>
  refField(name, 'data.contact', true, undefined, label);

const singleRefVariant = (
  kind = 'contact',
  ref = contactRef(),
): DiscriminatedUnionVariant => ({
  kind,
  label: kind,
  fields: [ref],
});

const recursiveConditionVariants = (): DiscriminatedUnionVariant[] => {
  const variants: DiscriminatedUnionVariant[] = [];
  const conditions = arrayField('conditions', 'discriminated_union', {
    label: 'Conditions',
    itemVariants: variants,
    discriminantField: 'op',
  });
  variants.push(
    {
      kind: 'ref',
      label: 'Reference',
      fields: [contactRef()],
    },
    {
      kind: 'all',
      label: 'All',
      fields: [conditions],
    },
    {
      kind: 'any',
      label: 'Any',
      fields: [conditions],
    },
  );
  return variants;
};

describe('D-145 PB10 hook propagation - top-level regression baseline', () => {
  it('fires ref_exists exactly once for a top-level ref, proving single-dispatch remains intact', () => {
    const { hooks, calls } = recordingHooks();
    const definition = formDefinition([refField('owner', 'data.contact')]);

    expect(validateForm(definition, { owner: 'present' }, hooks)).toEqual([]);
    expect(calls).toEqual([{ target: 'data.contact', id: 'present' }]);
  });

  it('fires array<ref> once per non-empty item, proving the deleted array dispatch does not double-fire', () => {
    const { hooks, calls } = recordingHooks();
    const definition = formDefinition([
      arrayField('owners', 'ref', {
        label: 'Owners',
        refTarget: 'data.contact',
      }),
    ]);

    expect(validateForm(definition, { owners: ['a', 'b', 'c'] }, hooks)).toEqual(
      [],
    );
    expect(calls).toEqual([
      { target: 'data.contact', id: 'a' },
      { target: 'data.contact', id: 'b' },
      { target: 'data.contact', id: 'c' },
    ]);
    expect(new Set(calls.map((call) => call.id)).size).toBe(3);
  });
});

describe('D-145 PB10 hook propagation - nested ref inside composite', () => {
  it('fires ref_exists inside object fields, proving validateObject forwards hooks', () => {
    const field = objectField('payload', [contactRef()]);
    const passing = recordingHooks();

    expect(validateField(field, { owner: 'present' }, passing.hooks)).toBeNull();
    expect(passing.calls).toEqual([
      { target: 'data.contact', id: 'present' },
    ]);

    const failing = recordingHooks(false);
    expect(validateField(field, { owner: 'missing' }, failing.hooks)).toBe(
      'Owner: Entity not found',
    );
    expect(failing.calls).toEqual([
      { target: 'data.contact', id: 'missing' },
    ]);
  });

  it('fires ref_exists inside discriminated_union variants, proving variant recursion forwards hooks', () => {
    const field = unionField('assignee', [singleRefVariant()]);
    const passing = recordingHooks();

    expect(
      validateField(field, { kind: 'contact', owner: 'present' }, passing.hooks),
    ).toBeNull();
    expect(passing.calls).toEqual([
      { target: 'data.contact', id: 'present' },
    ]);

    const failing = recordingHooks(false);
    expect(
      validateField(field, { kind: 'contact', owner: 'missing' }, failing.hooks),
    ).toBe('Owner: Entity not found');
    expect(failing.calls).toEqual([
      { target: 'data.contact', id: 'missing' },
    ]);
  });

  it('fires ref_exists inside array<object> items, proving object item recursion forwards hooks', () => {
    const field = arrayField('people', 'object', {
      label: 'People',
      itemObjectFields: [contactRef()],
    });
    const passing = recordingHooks();

    expect(
      validateField(
        field,
        [{ owner: 'alpha' }, { owner: 'bravo' }],
        passing.hooks,
      ),
    ).toBeNull();
    expect(passing.calls).toEqual([
      { target: 'data.contact', id: 'alpha' },
      { target: 'data.contact', id: 'bravo' },
    ]);

    const failing = recordingHooks(false);
    expect(
      validateField(
        field,
        [{ owner: 'missing-a' }, { owner: 'missing-b' }],
        failing.hooks,
      ),
    ).toBe('Item 1: Owner: Entity not found');
  });

  it('fires ref_exists inside array<discriminated_union> items, proving union item recursion forwards hooks', () => {
    const field = arrayField('choices', 'discriminated_union', {
      label: 'Choices',
      itemVariants: [singleRefVariant()],
    });
    const passing = recordingHooks();

    expect(
      validateField(
        field,
        [
          { kind: 'contact', owner: 'alpha' },
          { kind: 'contact', owner: 'bravo' },
        ],
        passing.hooks,
      ),
    ).toBeNull();
    expect(passing.calls).toEqual([
      { target: 'data.contact', id: 'alpha' },
      { target: 'data.contact', id: 'bravo' },
    ]);

    const failing = recordingHooks(false);
    expect(
      validateField(
        field,
        [
          { kind: 'contact', owner: 'missing-a' },
          { kind: 'contact', owner: 'missing-b' },
        ],
        failing.hooks,
      ),
    ).toBe('Item 1: Owner: Entity not found');
  });
});

describe('D-145 PB10 hook propagation - cross-level and recursive composites', () => {
  it('fires ref_exists inside object inside array<object>, proving multi-level object recursion forwards hooks', () => {
    const field = arrayField('people', 'object', {
      label: 'People',
      itemObjectFields: [
        objectField('profile', [contactRef()], true, undefined, 'Profile'),
      ],
    });
    const passing = recordingHooks();

    expect(
      validateField(
        field,
        [{ profile: { owner: 'alpha' } }, { profile: { owner: 'bravo' } }],
        passing.hooks,
      ),
    ).toBeNull();
    expect(passing.calls).toEqual([
      { target: 'data.contact', id: 'alpha' },
      { target: 'data.contact', id: 'bravo' },
    ]);
  });

  it('fires ref_exists at a recursive discriminated_union leaf, proving SI-condition-style recursion forwards hooks', () => {
    const field = unionField(
      'condition',
      recursiveConditionVariants(),
      true,
      'op',
    );
    const { hooks, calls } = recordingHooks();

    expect(
      validateField(
        field,
        {
          op: 'all',
          conditions: [{ op: 'ref', owner: 'leaf-contact' }],
        },
        hooks,
      ),
    ).toBeNull();
    expect(calls).toEqual([{ target: 'data.contact', id: 'leaf-contact' }]);
  });

  it('counts one hook call per recursive leaf ref, proving recursion does not multiply calls', () => {
    const field = unionField(
      'condition',
      recursiveConditionVariants(),
      true,
      'op',
    );
    const { hooks, calls } = recordingHooks();

    expect(
      validateField(
        field,
        {
          op: 'all',
          conditions: [
            { op: 'ref', owner: 'alpha' },
            {
              op: 'any',
              conditions: [
                { op: 'ref', owner: 'bravo' },
                {
                  op: 'all',
                  conditions: [
                    { op: 'ref', owner: 'charlie' },
                    { op: 'ref', owner: 'delta' },
                  ],
                },
              ],
            },
            { op: 'ref', owner: 'echo' },
          ],
        },
        hooks,
      ),
    ).toBeNull();
    expect(calls).toEqual([
      { target: 'data.contact', id: 'alpha' },
      { target: 'data.contact', id: 'bravo' },
      { target: 'data.contact', id: 'charlie' },
      { target: 'data.contact', id: 'delta' },
      { target: 'data.contact', id: 'echo' },
    ]);
    expect(calls.length).toBe(5);
  });
});

describe('D-145 PB10 hook propagation - hooks absent and hooks present no-fire paths', () => {
  it('validates composites without hooks, proving hook propagation is optional and crash-free', () => {
    const objectWithRef = objectField('payload', [contactRef()]);
    const unionWithRef = unionField('assignee', [singleRefVariant()]);
    const arrayObjectWithRef = arrayField('people', 'object', {
      itemObjectFields: [contactRef()],
    });
    const arrayUnionWithRef = arrayField('choices', 'discriminated_union', {
      itemVariants: [singleRefVariant()],
    });
    const nestedObjectInArray = arrayField('profiles', 'object', {
      itemObjectFields: [
        objectField('profile', [contactRef()], true, undefined, 'Profile'),
      ],
    });

    expect(validateField(objectWithRef, { owner: 'present' })).toBeNull();
    expect(
      validateField(unionWithRef, { kind: 'contact', owner: 'present' }),
    ).toBeNull();
    expect(validateField(arrayObjectWithRef, [{ owner: 'present' }])).toBeNull();
    expect(
      validateField(arrayUnionWithRef, [
        { kind: 'contact', owner: 'present' },
      ]),
    ).toBeNull();
    expect(
      validateField(nestedObjectInArray, [
        { profile: { owner: 'present' } },
      ]),
    ).toBeNull();
  });

  it('returns no errors when ref_exists succeeds, proving hooks fire without changing valid composite results', () => {
    const { hooks, calls } = recordingHooks(true);
    const definition = formDefinition([
      objectField('payload', [contactRef()]),
      unionField('assignee', [singleRefVariant()]),
      arrayField('people', 'object', {
        itemObjectFields: [contactRef()],
      }),
      arrayField('choices', 'discriminated_union', {
        itemVariants: [singleRefVariant()],
      }),
    ]);

    expect(
      validateForm(
        definition,
        {
          payload: { owner: 'one' },
          assignee: { kind: 'contact', owner: 'two' },
          people: [{ owner: 'three' }, { owner: 'four' }],
          choices: [{ kind: 'contact', owner: 'five' }],
        },
        hooks,
      ),
    ).toEqual([]);
    expect(calls).toEqual([
      { target: 'data.contact', id: 'one' },
      { target: 'data.contact', id: 'two' },
      { target: 'data.contact', id: 'three' },
      { target: 'data.contact', id: 'four' },
      { target: 'data.contact', id: 'five' },
    ]);
  });
});

describe('D-145 PB10 hook propagation - scalar-validator-receives-hooks compatibility', () => {
  it('allows text validator calls with or without hooks, proving FieldValidator widening is backward-compatible', () => {
    const { hooks, calls } = recordingHooks();
    const field = textField('title');

    expect(BUILTIN_VALIDATORS.text(field, 'hi')).toBeNull();
    expect(BUILTIN_VALIDATORS.text(field, 'hi', hooks)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('D-145 PB10 hook propagation - empty and null array<ref> edge cases', () => {
  it('returns Item 1 Required for an empty-string array<ref> item, proving required gating is not skipped', () => {
    const definition = formDefinition([
      arrayField('owners', 'ref', {
        label: 'Owners',
        refTarget: 'data.contact',
      }),
    ]);

    expect(validateForm(definition, { owners: ['', 'present'] })).toEqual([
      { field: 'owners', message: 'Item 1: Required' },
    ]);
  });

  it('returns Item 1 Required for a null array<ref> item, proving null items are not silently skipped', () => {
    const definition = formDefinition([
      arrayField('owners', 'ref', {
        label: 'Owners',
        refTarget: 'data.contact',
      }),
    ]);

    expect(validateForm(definition, { owners: [null, 'present'] })).toEqual([
      { field: 'owners', message: 'Item 1: Required' },
    ]);
  });
});
