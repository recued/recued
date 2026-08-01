/** The schema-bound field-list renderer.
 *
 *  The load-bearing case is `withholds the whole block from a public
 *  audience`: this block draws owner-declared record fields, and a public
 *  reception surface already has its own field projection with a closed-list
 *  ceiling. Rendering here would shadow that ceiling with a wider set.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedRecordFieldsDescriptor } from '@recued/contracts';

import { renderRecordFieldsBlock, RECORD_FIELDS_ROW_ATTR } from '../record-fields.js';
import { renderSection } from '../index.js';

const descriptor = (
  fields: ResolvedRecordFieldsDescriptor['fields'],
  extra: Partial<ResolvedRecordFieldsDescriptor> = {},
): ResolvedRecordFieldsDescriptor => ({ entity: 'job', fields, ...extra });

const field = (
  key: string,
  kind: string,
  value: unknown,
  extra: Record<string, unknown> = {},
) => ({ key, label: key, kind, present: true, value, ...extra }) as
  ResolvedRecordFieldsDescriptor['fields'][number];

describe('renderRecordFieldsBlock', () => {
  it('renders a label/value row per field, keyed by the field key', () => {
    const html = renderRecordFieldsBlock(descriptor([
      { key: 'title', label: 'Title', kind: 'string', present: true, value: 'Replace the pump' },
    ]));
    expect(html).toContain(`${RECORD_FIELDS_ROW_ATTR}="title"`);
    expect(html).toContain('Title');
    expect(html).toContain('Replace the pump');
  });

  it('emits the SHARED label/value classes, not block-private ones', () => {
    // The only thing a structure test can say about styling. Block-private
    // class names rendered as an unstyled vertical stack on every surface —
    // reception styles `.summary-row` (`static-assets.ts`) and the webclient
    // route now does too. Renaming these to something block-specific would
    // look identical to every assertion in this file and wrong in a browser.
    const html = renderRecordFieldsBlock(descriptor([field('title', 'string', 'x')]));
    expect(html).toContain('class="summary-list"');
    expect(html).toContain('class="summary-row"');
  });

  it('says "Not set" for a declared-but-absent field', () => {
    const html = renderRecordFieldsBlock(descriptor([
      { key: 'contact_name', label: 'Contact name', kind: 'string', present: false, value: undefined },
    ]));
    expect(html).toContain('Not set');
    // Not the em-dash `formatValue` gives an undefined — that would read as a
    // present-but-empty value.
    expect(html).not.toContain('<dd>—</dd>');
  });

  it('renders a boolean as Yes/No, including false', () => {
    const html = renderRecordFieldsBlock(descriptor([
      field('archived', 'boolean', false),
      field('urgent', 'boolean', true),
    ]));
    expect(html).toContain('No');
    expect(html).toContain('Yes');
  });

  it('refuses to invent a scalar for a json-typed field', () => {
    // `booking.attendees` on Cal.com is declared `type: 'json'`. formatValue
    // would print `[object Object]`; flattening would hide what was dropped.
    const html = renderRecordFieldsBlock(descriptor([
      field('attendees', 'json', [{ name: 'A' }, { name: 'B' }]),
      field('hosts', 'json', { id: 1, name: 'Owner' }),
    ]));
    expect(html).toContain('2 items');
    expect(html).toContain('structured value');
    expect(html).not.toContain('[object Object]');
  });

  it('counts a single json item in the singular', () => {
    expect(renderRecordFieldsBlock(descriptor([field('a', 'json', [{ x: 1 }])])))
      .toContain('1 item<');
  });

  it('keeps the TIME on a datetime, which `date` drops', () => {
    // ⛔ Found live: a booking's start rendered "Aug 3, 2026" — the one fact a
    // person reading an appointment needs most, silently gone. `formatDate` is
    // day-only by design and every shipped table column depends on that, so
    // datetime got its own hint rather than a change to the shared one.
    const html = renderRecordFieldsBlock(descriptor([
      field('start', 'datetime', '2026-08-03T16:00:00.000Z'),
      field('due', 'date', '2026-08-03T16:00:00.000Z'),
    ]));
    expect(html).toMatch(/Aug 3, 2026, \d{2}:\d{2}/);
    // …and the plain `date` kind still renders day-only.
    expect(html).toContain('>Aug 3, 2026<');
  });

  it('exposes the declared privacy class as an attribute, and omits it when undeclared', () => {
    const html = renderRecordFieldsBlock(descriptor([
      field('customer_email', 'string', 'a@b.test', { privacy: 'email' }),
      field('status', 'string', 'received'),
    ]));
    expect(html).toContain('data-privacy="email"');
    expect(html.match(/data-privacy=/g)).toHaveLength(1);
  });

  it('escapes hostile field values and labels', () => {
    const html = renderRecordFieldsBlock(descriptor([
      { key: 'title', label: '<script>x</script>', kind: 'string', present: true,
        value: '<img onerror=alert(1)>' },
    ]));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;');
  });

  it('withholds the whole block from a public audience', () => {
    // Owner-only, like `filter`. A public reception surface projects fields
    // through its own closed-list ceiling; this block must not widen it.
    const d = descriptor([field('customer_email', 'string', 'a@b.test', { privacy: 'email' })]);
    expect(renderRecordFieldsBlock(d, { audience: 'public' })).toBe('');
    expect(renderRecordFieldsBlock(d, { audience: 'owner' })).toContain('a@b.test');
    // …and the value must not survive anywhere in the public output.
    expect(renderRecordFieldsBlock(d, { audience: 'public' })).not.toContain('a@b.test');
  });

  it('names WHICH half failed rather than rendering an empty record', () => {
    const noSchema = renderRecordFieldsBlock(descriptor([], { unresolved: 'no_schema' }));
    expect(noSchema).toContain('job');
    expect(noSchema).toContain('no installed pack');

    const noRecord = renderRecordFieldsBlock(descriptor([], { unresolved: 'no_record' }));
    expect(noRecord).toContain('no record');
  });

  it('reports a malformed descriptor instead of throwing', () => {
    expect(renderRecordFieldsBlock(undefined)).toContain('invalid resolved record-fields descriptor');
    expect(renderRecordFieldsBlock({ entity: 'job' })).toContain('invalid resolved');
  });
});

describe('renderSection dispatch', () => {
  it('routes record_fields to the block and reads the descriptor, not `data`', () => {
    const html = renderSection({
      kind: 'record_fields',
      // `data` is the raw step result; the descriptor is what the host resolved.
      data: { record: { id: 'job_1', title: 'raw' } },
      record_fields: descriptor([field('title', 'string', 'resolved')]),
    });
    expect(html).toContain('resolved');
    expect(html).not.toContain('unsupported section type');
  });
});
