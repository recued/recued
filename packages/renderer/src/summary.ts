/** Summary block — label/value rows with optional numeric thresholds.
 *
 *  Threshold semantics: each field may carry `{ threshold: { warn,
 *  critical } }`. When the value coerces to a finite number, the row's
 *  `<dd>` gets `value-critical` / `value-warn` / `value-ok` based on
 *  which threshold the value crosses. Thresholds with non-numeric
 *  values fall back to no class. */

import { e } from './escape.js';
import { formatValue } from './format.js';
import { renderBlockEmpty, renderBlockError } from './block-error.js';
import { renderBlockLabel } from './label.js';
import type { SummaryData } from './types.js';

export const renderSummaryBlock = (data: unknown, label?: string): string => {
  if (!data || typeof data !== 'object') return renderBlockError('summary', 'invalid data');
  const d = data as Partial<SummaryData>;
  const fields = Array.isArray(d.fields) ? d.fields : [];
  if (fields.length === 0) return renderBlockEmpty('summary');

  return `
    <div class="block summary-block">
      ${renderBlockLabel(label)}
      <dl class="summary-list">
        ${fields
          .map(
            (f) => {
              const val = formatValue(f.value);
              const threshold = (f as { threshold?: { warn?: number; critical?: number } }).threshold;
              const numVal = Number(f.value);
              const thresholdClass = threshold && !isNaN(numVal)
                ? numVal >= (threshold.critical ?? Infinity) ? 'value-critical'
                  : numVal >= (threshold.warn ?? Infinity) ? 'value-warn'
                  : 'value-ok'
                : '';
              return `
          <div class="summary-row">
            <dt>${e(String(f.label ?? ''))}</dt>
            <dd class="${thresholdClass}">${e(val)}</dd>
          </div>
        `;
            },
          )
          .join('')}
      </dl>
    </div>
  `;
};
