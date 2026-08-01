/** D-222 owner-only resolved filter block.
 *
 * The descriptor is host-derived by the engine. Visible controls reuse the
 * canonical variable-widget normalizer/renderer; hidden carrier values are
 * intentionally absent from HTML because typed host state, not DOM strings,
 * is their source of truth. Public audiences receive no block at all.
 */

import type { ResolvedFilterDescriptor, VariableDefault } from '@recued/contracts';
import {
  renderVariableWidget,
  toWidgetShape,
} from '@recued/ui-shared/variable-widgets';
import { isResolvedFilterDescriptor } from '@recued/ui-shared/output-filter';
import { e } from './escape.js';
import { renderBlockError } from './block-error.js';
import { renderBlockLabel } from './label.js';
import type { RenderContext } from './types.js';

export const FILTER_BLOCK_ATTR = 'data-recued-output-filter';
export const FILTER_SUBMIT_ATTR = 'data-recued-output-filter-submit';
export const FILTER_PAGE_ATTR = 'data-recued-output-filter-page';

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export const renderFilterBlock = (
  descriptor: unknown,
  context: RenderContext = {},
  label?: string,
): string => {
  if (context.audience === 'public') return '';
  if (!isResolvedFilterDescriptor(descriptor)) {
    return renderBlockError('filter', 'invalid resolved filter descriptor');
  }

  const rows = descriptor.fields.map((key) => {
    if (!hasOwn(descriptor.definitions, key)) return '';
    const definition = descriptor.definitions[key] as VariableDefault;
    const value = hasOwn(descriptor.values, key)
      ? descriptor.values[key]
      : undefined;
    return renderVariableWidget(toWidgetShape(key, definition, value), {
      idPrefix: `output-filter-${descriptor.section_index}`,
    });
  }).join('');
  const interactive = context.interactive === true;
  const disabled = interactive ? '' : ' disabled aria-disabled="true"';
  const paging = descriptor.paging;
  const previous = paging?.prev_cursor === undefined
    ? ''
    : `<button type="button" ${FILTER_PAGE_ATTR}="previous"${disabled}>Previous</button>`;
  const next = paging?.next_cursor === undefined
    ? ''
    : `<button type="button" ${FILTER_PAGE_ATTR}="next"${disabled}>Next</button>`;

  return `
    <form class="block filter-block" ${FILTER_BLOCK_ATTR}="${descriptor.section_index}"
      data-recipe-hash="${e(descriptor.recipe_hash)}" onsubmit="return false">
      ${renderBlockLabel(label)}
      <div class="filter-block-fields">${rows}</div>
      <div class="filter-block-actions">
        <button type="button" ${FILTER_SUBMIT_ATTR}${disabled}>${e(descriptor.submit)}</button>
        ${previous}${next}
      </div>
    </form>
  `;
};
