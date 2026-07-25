/** D-145 § B.11.7 Slice 2a — form-renderer composition primitives, render.
 *
 *  Covers:
 *    - renderField for type 'object' emits a nested scope wrapper with
 *      data-form-object-scope + walks object_fields.
 *    - renderField for type 'discriminated_union' emits a kind picker
 *      <select> + one variant body per declared variant; only the
 *      active variant carries data-form-variant-active="true".
 *    - Array<object> and array<discriminated_union> items render via
 *      the composite paths.
 *    - show_if: a field whose gate evaluates false renders with
 *      data-form-hidden="true"; renderer uses options.values (full
 *      map) to evaluate the gate at render time.
 *    - Unknown-kind handling (Slice 2a fold #4): the union renders an
 *      unrecognized-kind notice + a disabled placeholder option +
 *      data-form-union-unknown-kind attribute.
 *    - renderFieldGroup drops `errors` when descending (Slice 2a fold #6).
 */

import { describe, expect, it } from 'vitest';

import type {
  DiscriminatedUnionVariant,
  FormDefinition,
  FormField,
} from '@recued/contracts';

import { renderField, renderForm } from '../form-renderer/render.js';

const baseField = (
  over: Partial<FormField> & Pick<FormField, 'type' | 'name'>,
): FormField => ({
  label: over.label ?? over.name,
  required: true,
  hidden: false,
  origin: 'canonical' as const,
  ...over,
});

// ══════════════════════════════════════════════════════════════════
// type: 'object'
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — renderField type=object', () => {
  it('emits the object wrapper + nested scope', () => {
    const html = renderField(
      baseField({
        type: 'object',
        name: 'address',
        object_fields: [baseField({ name: 'city', type: 'text' })],
      }),
    );
    expect(html).toContain('data-form-field="address"');
    expect(html).toContain('data-form-type="object"');
    expect(html).toContain('data-form-object-scope="address"');
    // Nested input rendered.
    expect(html).toContain('data-form-field="city"');
    expect(html).toContain('data-form-type="text"');
  });

  it('passes scoped values + show_if into nested sub-fields', () => {
    const html = renderField(
      baseField({
        type: 'object',
        name: 'settings',
        object_fields: [
          baseField({ name: 'mode', type: 'text' }),
          baseField({
            name: 'detail',
            type: 'text',
            show_if: { field: 'mode', equals: 'advanced' },
          }),
        ],
      }),
      // Top-level values map: settings.detail's gate keys off
      // settings.mode = 'simple' → detail should render hidden.
      { values: { settings: { mode: 'simple' } } },
    );
    // detail's row carries data-form-hidden="true" against the
    // scoped values map ({ mode: 'simple' }).
    const detailIdx = html.indexOf('data-form-row="detail"');
    expect(detailIdx).toBeGreaterThan(-1);
    expect(html.slice(detailIdx, detailIdx + 200)).toContain('data-form-hidden="true"');
  });
});

// ══════════════════════════════════════════════════════════════════
// type: 'discriminated_union'
// ══════════════════════════════════════════════════════════════════

const SAMPLE_VARIANTS: DiscriminatedUnionVariant[] = [
  { kind: 'require_approval', label: 'Require approval', fields: [] },
  {
    kind: 'min_tier',
    label: 'Min tier',
    fields: [baseField({ name: 'tier', type: 'text' })],
  },
];

describe('D-145 Slice 2a — renderField type=discriminated_union', () => {
  it('emits the union wrapper + a <select> kind picker', () => {
    const html = renderField(
      baseField({
        type: 'discriminated_union',
        name: 'action',
        variants: SAMPLE_VARIANTS,
      }),
    );
    expect(html).toContain('data-form-field="action"');
    expect(html).toContain('data-form-type="discriminated_union"');
    expect(html).toContain('data-form-union-select="action"');
    expect(html).toContain('data-form-discriminant-field="kind"');
    expect(html).toContain('<option value="require_approval"');
    expect(html).toContain('<option value="min_tier"');
  });

  it('renders all variant bodies but flags active=true on the matched one', () => {
    const html = renderField(
      baseField({
        type: 'discriminated_union',
        name: 'action',
        variants: SAMPLE_VARIANTS,
      }),
      { values: { action: { kind: 'min_tier', tier: 'fast' } } },
    );
    // Both variants appear; only min_tier is active.
    expect(html).toContain('data-form-union-variant="require_approval"');
    expect(html).toContain('data-form-union-variant="min_tier"');
    const minIdx = html.indexOf('data-form-union-variant="min_tier"');
    expect(html.slice(minIdx, minIdx + 200)).toContain(
      'data-form-variant-active="true"',
    );
    const reqIdx = html.indexOf('data-form-union-variant="require_approval"');
    expect(html.slice(reqIdx, reqIdx + 200)).toContain(
      'data-form-variant-active="false"',
    );
  });

  it('honors discriminant_field override (SI conditions use "op")', () => {
    const html = renderField(
      baseField({
        type: 'discriminated_union',
        name: 'condition',
        discriminant_field: 'op',
        variants: SAMPLE_VARIANTS,
      }),
    );
    expect(html).toContain('data-form-discriminant-field="op"');
  });

  it('surfaces an "unknown kind" notice + disabled placeholder when observed kind does not match any variant (fold #4)', () => {
    const html = renderField(
      baseField({
        type: 'discriminated_union',
        name: 'action',
        variants: SAMPLE_VARIANTS,
      }),
      { values: { action: { kind: 'retired_variant', leftovers: 'x' } } },
    );
    expect(html).toContain('class="form-renderer-union-unknown"');
    expect(html).toContain('data-form-union-unknown-kind="retired_variant"');
    expect(html).toContain('<option value="retired_variant" selected disabled');
    // None of the declared variants carries `selected` — the user must pick.
    expect(html).not.toContain('<option value="require_approval" selected');
    expect(html).not.toContain('<option value="min_tier" selected');
  });

  it('falls back to first variant active when no observed value is present (cold-start form)', () => {
    const html = renderField(
      baseField({
        type: 'discriminated_union',
        name: 'action',
        variants: SAMPLE_VARIANTS,
      }),
    );
    expect(html).toContain('<option value="require_approval" selected');
    const reqIdx = html.indexOf('data-form-union-variant="require_approval"');
    expect(html.slice(reqIdx, reqIdx + 200)).toContain(
      'data-form-variant-active="true"',
    );
  });

  it('emits a "No variants declared" notice when variants is empty', () => {
    const html = renderField(
      baseField({
        type: 'discriminated_union',
        name: 'action',
        variants: [],
      }),
    );
    expect(html).toContain('No variants declared.');
  });
});

// ══════════════════════════════════════════════════════════════════
// array<object> + array<discriminated_union>
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — renderField type=array with composite items', () => {
  it('renders array<object> items via the object scope wrapper', () => {
    const html = renderField(
      baseField({
        type: 'array',
        name: 'people',
        item_type: 'object',
        item_object_fields: [baseField({ name: 'name', type: 'text' })],
      }),
      { values: { people: [{ name: 'Alice' }, { name: 'Bob' }] } },
    );
    expect(html).toContain('data-form-array-item="people"');
    expect(html).toContain('data-form-array-index="0"');
    expect(html).toContain('data-form-array-index="1"');
    expect(html).toContain('data-form-object-scope="people"');
    // Both items get their nested text input.
    const occurrences = html.split('data-form-field="name"').length - 1;
    expect(occurrences).toBe(2);
  });

  it('renders array<discriminated_union> items with the union body', () => {
    const html = renderField(
      baseField({
        type: 'array',
        name: 'actions',
        item_type: 'discriminated_union',
        item_variants: SAMPLE_VARIANTS,
      }),
      {
        values: {
          actions: [
            { kind: 'min_tier', tier: 'mid' },
            { kind: 'require_approval' },
          ],
        },
      },
    );
    expect(html).toContain('data-form-array-item="actions"');
    expect(html).toContain('data-form-union-select="actions"');
    // Two items × 2 variants = 4 variant bodies.
    const bodyCount = html.split('data-form-union-variant=').length - 1;
    expect(bodyCount).toBe(4);
  });
});

// ══════════════════════════════════════════════════════════════════
// show_if at the top level
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — show_if at top level', () => {
  it('hides a field whose show_if evaluates false against options.values', () => {
    const definition: FormDefinition = {
      kind: 'test',
      fields: [
        baseField({ name: 'scope', type: 'text' }),
        baseField({
          name: 'scope_target',
          type: 'text',
          show_if: { field: 'scope', not_equals: 'global' },
        }),
      ],
    };
    const html = renderForm(definition, { values: { scope: 'global' } });
    const targetIdx = html.indexOf('data-form-row="scope_target"');
    expect(targetIdx).toBeGreaterThan(-1);
    expect(html.slice(targetIdx, targetIdx + 200)).toContain('data-form-hidden="true"');
  });

  it('shows the field when the gate passes', () => {
    const definition: FormDefinition = {
      kind: 'test',
      fields: [
        baseField({ name: 'scope', type: 'text' }),
        baseField({
          name: 'scope_target',
          type: 'text',
          show_if: { field: 'scope', not_equals: 'global' },
        }),
      ],
    };
    const html = renderForm(definition, { values: { scope: 'per_contact' } });
    const targetIdx = html.indexOf('data-form-row="scope_target"');
    expect(targetIdx).toBeGreaterThan(-1);
    expect(html.slice(targetIdx, targetIdx + 200)).not.toContain('data-form-hidden="true"');
  });
});

// ══════════════════════════════════════════════════════════════════
// fold #6 — errors don't cross scopes
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — renderFieldGroup drops errors when descending', () => {
  it('a nested field with the same name as a top-level field does NOT pick up the top-level error', () => {
    const definition: FormDefinition = {
      kind: 'test',
      fields: [
        baseField({ name: 'foo', type: 'text' }),
        baseField({
          name: 'wrapper',
          type: 'object',
          object_fields: [baseField({ name: 'foo', type: 'text' })],
        }),
      ],
    };
    const html = renderForm(definition, {
      errors: { foo: 'Top-level error' },
    });
    const errCount = html.split('Top-level error').length - 1;
    expect(errCount).toBe(1);
    // The error appears in the top-level row, not duplicated inside the wrapper.
    const errIdx = html.indexOf('Top-level error');
    const wrapperStart = html.indexOf('data-form-row="wrapper"');
    expect(errIdx).toBeLessThan(wrapperStart);
  });
});
