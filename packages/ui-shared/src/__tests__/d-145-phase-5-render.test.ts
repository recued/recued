/** D-145 PA5 — form-renderer rendering tests.
 *
 *  Pin per § A.3:
 *    - Each typed input emits the expected element + data-form-* attrs.
 *    - Hidden / auto fields collapse to `data-form-hidden="true"`
 *      unless `showHidden: true` is passed.
 *    - Errors surface inline + flip aria-invalid (renderer doesn't
 *      validate; callers feed the error map).
 *    - Required fields show the asterisk; extension fields show the
 *      origin chip.
 *    - User-controlled strings (labels, descriptions, values) are
 *      escaped before insertion.
 */

import { describe, expect, it } from 'vitest';

import {
  TASK_SCHEMA,
  formFromCanonicalSchema,
  formFromCanonicalSchemaWithExtension,
  type FormDefinition,
  type FormField,
} from '@recued/contracts';

import { formatTimestampForInput, renderField, renderForm } from '../form-renderer/render.js';

const baseField = (
  over: Partial<FormField> & Pick<FormField, 'type'>,
): FormField => ({
  name: 'x',
  label: 'X',
  required: true,
  hidden: false,
  origin: 'canonical' as const,
  ...over,
});

describe('D-145 PA5 — renderForm shell', () => {
  it('emits a form-renderer-form root carrying the kind', () => {
    const def = formFromCanonicalSchema(TASK_SCHEMA);
    const html = renderForm(def);
    expect(html).toContain('class="form-renderer-form"');
    expect(html).toContain('data-form-kind="task"');
  });

  it('renders every visible field as a row', () => {
    const def = formFromCanonicalSchema(TASK_SCHEMA);
    const html = renderForm(def);
    for (const f of def.fields) {
      if (f.hidden) continue;
      expect(html).toContain(`data-form-row="${f.name}"`);
    }
  });

  it('collapses hidden fields with data-form-hidden="true"', () => {
    const def = formFromCanonicalSchema(TASK_SCHEMA);
    const html = renderForm(def);
    // `id` is the auto uuid — should be present but flagged hidden.
    const idIdx = html.indexOf('data-form-row="id"');
    expect(idIdx).toBeGreaterThan(-1);
    expect(html.slice(idIdx, idIdx + 200)).toContain('data-form-hidden="true"');
  });

  it('reveals hidden fields when showHidden=true', () => {
    const def: FormDefinition = {
      kind: 'task',
      fields: [
        baseField({ name: 'id', type: 'uuid', hidden: true, required: false }),
      ],
    };
    const html = renderForm(def, { showHidden: true });
    expect(html).not.toContain('data-form-hidden="true"');
  });
});

describe('D-145 PA5 — typed-input renderers', () => {
  it('text → input type=text + data-form-type=text', () => {
    const html = renderField(baseField({ type: 'text', name: 'title', label: 'Title' }));
    expect(html).toContain('type="text"');
    expect(html).toContain('data-form-field="title"');
    expect(html).toContain('data-form-type="text"');
  });

  it('text → emits maxlength when max_length set', () => {
    const html = renderField(
      baseField({ type: 'text', name: 'title', max_length: 200 }),
    );
    expect(html).toContain('maxlength="200"');
  });

  it('text → emits pattern attr when pattern set (§ A.3.1)', () => {
    const html = renderField(
      baseField({ type: 'text', name: 'iso', pattern: '^[A-Z]{3}$' }),
    );
    expect(html).toContain('pattern="^[A-Z]{3}$"');
  });

  it('number → emits min / max / step attrs when constrained (§ A.3.1)', () => {
    const html = renderField(
      baseField({
        type: 'number',
        name: 'count',
        min: 0,
        max: 100,
        integer: true,
      }),
    );
    expect(html).toContain('min="0"');
    expect(html).toContain('max="100"');
    expect(html).toContain('step="1"');
  });

  it('number → omits min / max / step when unconstrained', () => {
    const html = renderField(baseField({ type: 'number', name: 'count' }));
    expect(html).not.toContain('min=');
    expect(html).not.toContain('max=');
    expect(html).not.toContain('step=');
  });

  it('textarea → <textarea> + data-form-type=textarea', () => {
    const html = renderField(baseField({ type: 'textarea', name: 'body' }));
    expect(html).toContain('<textarea');
    expect(html).toContain('data-form-type="textarea"');
  });

  it('number → input type=number', () => {
    const html = renderField(baseField({ type: 'number', name: 'count' }));
    expect(html).toContain('type="number"');
    expect(html).toContain('data-form-type="number"');
  });

  it('boolean → checkbox + inline row layout', () => {
    const html = renderField(baseField({ type: 'boolean', name: 'done' }));
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('data-form-type="boolean"');
    expect(html).toContain('data-form-row-inline="true"');
  });

  it('boolean → checked when value is true', () => {
    const html = renderField(
      baseField({ type: 'boolean', name: 'done' }),
      { values: { done: true } },
    );
    expect(html).toContain('checked');
  });

  it('boolean → unchecked when value is false', () => {
    const html = renderField(
      baseField({ type: 'boolean', name: 'done' }),
      { values: { done: false } },
    );
    expect(html).not.toContain('checked');
  });

  it('date → input type=date', () => {
    const html = renderField(baseField({ type: 'date', name: 'when' }));
    expect(html).toContain('type="date"');
    expect(html).toContain('data-form-type="date"');
  });

  it('timestamp → input type=datetime-local, shown in this browser\'s time', () => {
    // ⛔ LOCAL, because `read.ts` reads the input back as local time. This used
    // to show the UTC digits, so a save of an untouched field moved it by the
    // offset (and the Data dialog then dropped the value altogether).
    const instant = Date.parse('2026-05-09T12:00:00Z');
    const d = new Date(instant);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    for (const when of ['2026-05-09T12:00:00Z', instant]) {
      const html = renderField(baseField({ type: 'timestamp', name: 'when' }), { values: { when } });
      expect(html).toContain('type="datetime-local"');
      expect(html).toContain(`value="${local}"`);
    }
    // A zone-less string is shown as written.
    expect(renderField(baseField({ type: 'timestamp', name: 'when' }), { values: { when: '2026-05-09T12:00' } }))
      .toContain('value="2026-05-09T12:00"');
  });

  it('timestamp at UTC midnight is a whole DAY, shown as that day at midnight', () => {
    const html = renderField(
      baseField({ type: 'timestamp', name: 'due' }),
      { values: { due: Date.UTC(2026, 8, 28) } },
    );
    expect(html).toContain('value="2026-09-28T00:00"');
  });

  it('a timestamp shown here reads back as the same instant (the round trip)', () => {
    const instant = Date.parse('2026-05-09T12:34:00Z');
    const shown = formatTimestampForInput(instant);
    const [datePart, timePart] = shown.split('T') as [string, string];
    const [y, m, day] = datePart.split('-').map(Number) as [number, number, number];
    const [h, min] = timePart.split(':').map(Number) as [number, number];
    expect(new Date(y, m - 1, day, h, min).getTime()).toBe(instant);
  });

  it('enum → <select> with options + first option preselected', () => {
    const html = renderField(
      baseField({ type: 'enum', name: 'priority', enum_values: ['low', 'high'] }),
      { values: { priority: 'high' } },
    );
    expect(html).toContain('<select');
    expect(html).toContain('<option value="low"');
    expect(html).toContain('<option value="high" selected');
  });

  it('enum (not required) → adds placeholder option', () => {
    const html = renderField(
      baseField({
        type: 'enum',
        name: 'priority',
        enum_values: ['low', 'high'],
        required: false,
      }),
    );
    expect(html).toContain('<option value=""');
  });

  it('ref → input with data-form-ref-target', () => {
    const html = renderField(
      baseField({
        type: 'ref',
        name: 'assigned_contact',
        ref_target: 'data.contact',
      }),
    );
    expect(html).toContain('data-form-type="ref"');
    expect(html).toContain('data-form-ref-target="data.contact"');
  });

  it('uuid → hidden input', () => {
    const html = renderField(
      baseField({ type: 'uuid', name: 'id', hidden: true, required: false }),
      { showHidden: true },
    );
    expect(html).toContain('type="hidden"');
    expect(html).toContain('data-form-type="uuid"');
  });

  it('array → container + add button + data-form-item-type', () => {
    const html = renderField(
      baseField({
        type: 'array',
        name: 'related_contacts',
        item_type: 'ref',
        ref_target: 'data.contact',
        required: false,
      }),
    );
    expect(html).toContain('class="form-renderer-array"');
    expect(html).toContain('data-form-array-add="related_contacts"');
    expect(html).toContain('data-form-item-type="ref"');
    expect(html).toContain('data-form-ref-target="data.contact"');
  });

  it('ref + refPicker → name→id picker shell with a hidden data-form-field mirror', () => {
    const html = renderField(
      baseField({
        type: 'ref',
        name: 'assigned_contact',
        ref_target: 'data.contact',
        required: false,
      }),
      { refPicker: true, values: { assigned_contact: 'alice@example.com' } },
    );
    // The live combobox shell, not the raw-id input.
    expect(html).toContain('data-ref-picker="form-ref-assigned_contact"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('data-ref-picker-input');
    // The hidden mirror carries the committed id so readFormValues reads
    // it back unchanged.
    expect(html).toContain('data-form-field="assigned_contact"');
    expect(html).toContain('data-form-type="ref"');
    expect(html).toContain('data-ref-picker-value');
    expect(html).toContain('value="alice@example.com"');
    // Default (no flag) stays the raw-id input — proven by the test above.
    expect(
      renderField(
        baseField({ type: 'ref', name: 'assigned_contact', ref_target: 'data.contact', required: false }),
      ),
    ).not.toContain('data-ref-picker');
  });

  it('puts a ref-picker error on its visible combobox, not the hidden id mirror', () => {
    const html = renderField(
      baseField({
        type: 'ref',
        name: 'assigned_contact',
        ref_target: 'data.contact',
        required: false,
      }),
      {
        refPicker: true,
        errors: { assigned_contact: 'Choose a contact' },
      },
    );
    const mirror = html.match(
      /<input type="hidden" data-form-field="assigned_contact"[^>]*>/,
    )?.[0] ?? '';
    const combobox = html.match(
      /<input class="ref-picker-input"[^>]*>/,
    )?.[0] ?? '';
    expect(mirror).not.toContain('aria-invalid');
    expect(combobox).toContain('aria-invalid="true"');
    expect(combobox).toContain(
      'aria-describedby="form-renderer-assigned_contact-error"',
    );
  });

  it('array<ref> + refPicker → per-item picker shells with array-addressed mirrors', () => {
    const html = renderField(
      baseField({
        type: 'array',
        name: 'related_contacts',
        item_type: 'ref',
        ref_target: 'data.contact',
        required: false,
      }),
      { refPicker: true, values: { related_contacts: ['a@x.com', 'b@y.com'] } },
    );
    // One picker shell per item.
    expect(html).toContain('data-ref-picker="form-ref-related_contacts-0"');
    expect(html).toContain('data-ref-picker="form-ref-related_contacts-1"');
    expect(html).toContain('data-ref-picker-input');
    // Each item's hidden mirror is array-addressed (not data-form-field),
    // so the array reader's per-index walk reads each committed id.
    expect(html).toContain('data-form-array-item="related_contacts"');
    expect(html).toContain('data-form-array-index="0"');
    expect(html).toContain('data-form-array-index="1"');
    expect(html).toContain('value="a@x.com"');
    expect(html).toContain('value="b@y.com"');
    // The Add/Remove affordances stay — the host (data route) wires them.
    expect(html).toContain('data-form-array-add="related_contacts"');
    expect(html).toContain('data-form-array-remove="related_contacts"');
  });

  it('array with items → renders each item with index + remove button', () => {
    const html = renderField(
      baseField({
        type: 'array',
        name: 'tags',
        item_type: 'text',
        required: false,
      }),
      { values: { tags: ['alpha', 'beta'] } },
    );
    expect(html).toContain('data-form-array-item="tags"');
    expect(html).toContain('data-form-array-index="0"');
    expect(html).toContain('data-form-array-index="1"');
    expect(html).toContain('value="alpha"');
    expect(html).toContain('value="beta"');
    expect(html).toContain('data-form-array-remove="tags"');
  });

  it('gives repeated array inputs and actions contextual accessible names', () => {
    const html = renderField(
      baseField({
        type: 'array',
        name: 'blocks_task',
        label: 'Blocks task',
        item_type: 'ref',
        ref_target: 'data.task',
        required: false,
      }),
      { values: { blocks_task: ['task-a', 'task-b'] } },
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Blocks task"');
    expect(html).toContain('aria-label="Blocks task 1"');
    expect(html).toContain('aria-label="Blocks task 2"');
    expect(html).toContain('aria-label="Remove Blocks task 1"');
    expect(html).toContain('aria-label="Remove Blocks task 2"');
    expect(html).toContain('aria-label="Add Blocks task"');
  });

  it('array empty + visible → "No entries." placeholder', () => {
    const html = renderField(
      baseField({
        type: 'array',
        name: 'tags',
        item_type: 'text',
        required: false,
      }),
    );
    expect(html).toContain('form-renderer-array-empty');
  });
});

describe('D-145 PA5 — error / required / origin chrome', () => {
  it('required field shows asterisk', () => {
    const html = renderField(baseField({ type: 'text', name: 'title' }));
    expect(html).toContain('form-renderer-required');
  });

  it('not-required field omits asterisk', () => {
    const html = renderField(
      baseField({ type: 'text', name: 'title', required: false }),
    );
    expect(html).not.toContain('form-renderer-required');
  });

  it('extension origin → renders chip', () => {
    const html = renderField(
      baseField({
        type: 'text',
        name: 'hubspot_owner_id',
        origin: 'extension',
      }),
    );
    expect(html).toContain('form-renderer-origin-chip');
  });

  it('canonical origin → no chip', () => {
    const html = renderField(baseField({ type: 'text', name: 'title' }));
    expect(html).not.toContain('form-renderer-origin-chip');
  });

  it('error → renders form-renderer-error block', () => {
    const html = renderField(
      baseField({ type: 'text', name: 'title' }),
      { errors: { title: 'Required' } },
    );
    expect(html).toContain('form-renderer-error');
    expect(html).toContain('Required');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(
      'aria-describedby="form-renderer-title-error"',
    );
    expect(html).toContain(
      'id="form-renderer-title-error" role="alert"',
    );
  });

  it('description → rendered as help text', () => {
    const html = renderField(
      baseField({
        type: 'text',
        name: 'monetary_amount',
        description: 'ISO 4217 decimal-as-string',
      }),
    );
    expect(html).toContain('form-renderer-help');
    expect(html).toContain('ISO 4217 decimal-as-string');
  });
});

describe('D-145 PA5 — XSS escape posture', () => {
  it('escapes user-supplied label', () => {
    const html = renderField(
      baseField({ type: 'text', name: 'x', label: '<script>boom</script>' }),
    );
    expect(html).not.toContain('<script>boom</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes user-supplied value', () => {
    const html = renderField(
      baseField({ type: 'text', name: 'x' }),
      { values: { x: '<img src=x onerror=boom>' } },
    );
    expect(html).not.toContain('<img src=x onerror=boom>');
    expect(html).toContain('&lt;img');
  });

  it('escapes user-supplied error message', () => {
    const html = renderField(
      baseField({ type: 'text', name: 'x' }),
      { errors: { x: '<svg/onload=alert(1)>' } },
    );
    expect(html).not.toContain('<svg/onload=alert(1)>');
    expect(html).toContain('&lt;svg');
  });

  it('escapes user-supplied description', () => {
    const html = renderField(
      baseField({
        type: 'text',
        name: 'x',
        description: '<a href=javascript:void>x</a>',
      }),
    );
    expect(html).not.toContain('<a href=javascript:void>');
  });

  it('escapes user-supplied ref_target', () => {
    const html = renderField(
      baseField({
        type: 'ref',
        name: 'x',
        ref_target: 'data."><script>boom</script>',
      }),
    );
    expect(html).not.toContain('<script>boom</script>');
  });

  it('escapes enum option values', () => {
    const html = renderField(
      baseField({
        type: 'enum',
        name: 'p',
        enum_values: ['<script>', 'safe'],
      }),
    );
    expect(html).not.toContain('<option value="<script>"');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('D-145 PA5 — extension form integration', () => {
  it('rendered extension fields appear after canonical', () => {
    const def = formFromCanonicalSchemaWithExtension(TASK_SCHEMA, {
      fields: [{ name: 'hubspot_owner_id', type: 'text' }],
    });
    const html = renderForm(def);
    const titleIdx = html.indexOf('data-form-row="title"');
    const extIdx = html.indexOf('data-form-row="hubspot_owner_id"');
    expect(titleIdx).toBeGreaterThan(-1);
    expect(extIdx).toBeGreaterThan(titleIdx);
  });
});
