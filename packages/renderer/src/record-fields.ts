/** Schema-bound field list over one Records row.
 *
 *  Draws the host-resolved descriptor and derives nothing further — the same
 *  division as `filter.ts`. Label, format hint, PII class, and "not set" all
 *  arrive already decided by `resolveRecordFields` against the pack's own
 *  entity schema, so this file cannot disagree with the schema no matter what
 *  it is handed.
 *
 *  ⛔ Owner-only, exactly like `filter`. A public reception surface has its own
 *  field projection with a per-projection-kind closed-list ceiling
 *  (`STATUS_PROJECTION_FIELDS_VISIBLE`) and a no-leak test. This block must not
 *  shadow or second-guess that: rendering owner-declared fields to a stranger
 *  because they happen to be in a record is precisely what that ceiling exists
 *  to stop. Returning '' is not a degradation — it is the correct answer.
 */

import type { ResolvedRecordField } from '@recued/contracts';
import { isResolvedRecordFieldsDescriptor } from '@recued/contracts';
import { e } from './escape.js';
import { formatValue } from './format.js';
import { renderBlockError } from './block-error.js';
import { renderBlockLabel } from './label.js';
import type { RenderContext } from './types.js';

export const RECORD_FIELDS_BLOCK_ATTR = 'data-recued-output-record-fields';
export const RECORD_FIELDS_ROW_ATTR = 'data-recued-output-record-field';

/** Map the schema's `kind` onto the existing `formatValue` vocabulary. Kinds
 *  with no format hint (`string`, `id`, `text`, `ref`) fall through to
 *  `formatValue`'s own default rather than being special-cased here. */
const FORMAT_FOR_KIND: Readonly<Record<string, string>> = {
  datetime: 'datetime',
  date: 'date',
  decimal: 'number',
  number: 'number',
};

/** A declared field whose type is `json` has no scalar rendering, and inventing
 *  one is worse than saying so: `formatValue` would print `[object Object]`,
 *  and flattening it would put a nested structure into a label/value row where
 *  a reader cannot tell what was dropped.
 *
 *  An array gets an honest count — "3 items" is true and useful, and tells the
 *  reader there is something here to go and look at. Anything else says only
 *  that it is structured. Either way the pack should surface the real content
 *  through the block that models it: a `json` section, or — when the vendor
 *  declares the nested thing as its own entity, which is exactly what Cal.com
 *  does with `booking.attendees` versus the `booking_attendee` entity — a
 *  `table` over the properly declared rows. */
const renderStructured = (value: unknown): string =>
  Array.isArray(value)
    ? `<span class="record-field-structured">${value.length} item${value.length === 1 ? '' : 's'}</span>`
    : '<span class="record-field-structured">structured value</span>';

const renderValue = (field: ResolvedRecordField): string => {
  // "Not set" is a real state the schema declares (`required: false`), not an
  // empty string. Saying so beats rendering a blank cell the reader has to
  // interpret — and it is what every pack currently hand-writes a `default`
  // step to produce.
  if (!field.present) return '<span class="record-field-unset">Not set</span>';
  if (field.kind === 'json') return renderStructured(field.value);
  if (field.kind === 'boolean') return field.value === true ? 'Yes' : 'No';
  const format = FORMAT_FOR_KIND[field.kind];
  return e(format === undefined
    ? formatValue(field.value)
    : formatValue(field.value, format));
};

export const renderRecordFieldsBlock = (
  descriptor: unknown,
  context: RenderContext = {},
  label?: string,
): string => {
  if (context.audience === 'public') return '';
  if (!isResolvedRecordFieldsDescriptor(descriptor)) {
    return renderBlockError('record_fields', 'invalid resolved record-fields descriptor');
  }
  // An unresolvable block says which half failed. Rendering "no fields" for a
  // pack that is not installed would read as "this record is empty", which is
  // a different and false claim.
  if (descriptor.unresolved === 'no_schema') {
    return renderBlockError(
      'record_fields',
      `no installed pack declares the "${descriptor.entity}" record shape`,
    );
  }
  if (descriptor.unresolved === 'no_record') {
    return renderBlockError('record_fields', 'no record to show');
  }

  // ⚠ `summary-list` / `summary-row` are REUSED deliberately, not copied by
  // accident. This is the same visual pattern as a summary block — a two-column
  // label/value list — and those class names are already styled by every
  // surface that renders recipe output (webclient, reception static assets,
  // dashboard, ui-shared). Block-private class names rendered as an unstyled
  // vertical stack on every one of them, which no structure-and-text test can
  // see: CSS is invisible to `toContain`. The block keeps its own outer class
  // and data attributes for identity and testing.
  const rows = descriptor.fields.map((field) => `
    <div class="summary-row" ${RECORD_FIELDS_ROW_ATTR}="${e(field.key)}"${
      field.privacy === undefined ? '' : ` data-privacy="${e(field.privacy)}"`}>
      <dt>${e(field.label)}</dt>
      <dd>${renderValue(field)}</dd>
    </div>
  `).join('');

  return `
    <div class="block summary-block record-fields-block" ${RECORD_FIELDS_BLOCK_ATTR}="${e(descriptor.entity)}">
      ${renderBlockLabel(label)}
      <dl class="summary-list">${rows}</dl>
    </div>
  `;
};
